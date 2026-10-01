import { describe, expect, it } from 'vitest';
import type { ColoredMesh, SdfVolume } from '../../../types/geometry';
import {
  AssetCodecError,
  LABELS_ASSET_MIME,
  MESH_ASSET_MIME,
  MESH_FLAG_INDEX16,
  MESH_FLAG_PART_ID,
  SDF_ASSET_MIME,
  decodeLabelsAsset,
  decodeMeshAsset,
  decodeSdfAsset,
  encodeLabelsAsset,
  encodeMeshAsset,
  encodeSdfAsset,
  labelsAssetCodec,
  meshAssetCodec,
  sdfAssetCodec,
} from '../assetCodecs';
import { mulberry32 } from '../prng';

function randomMesh(V: number, T: number, seed: number, withPartId = false): ColoredMesh {
  const rng = mulberry32(seed);
  const positions = new Float32Array(V * 3);
  for (let i = 0; i < positions.length; i++) positions[i] = (rng() - 0.5) * 20;
  const indices = new Uint32Array(T * 3);
  for (let i = 0; i < indices.length; i++) indices[i] = Math.floor(rng() * V);
  const labels = new Uint8Array(V);
  for (let i = 0; i < V; i++) labels[i] = rng() < 0.1 ? 255 : Math.floor(rng() * 16);
  const mesh: ColoredMesh = { positions, indices, labels };
  if (withPartId) {
    const partId = new Uint8Array(V);
    for (let i = 0; i < V; i++) partId[i] = Math.floor(rng() * 4);
    mesh.partId = partId;
  }
  return mesh;
}

function expectSameMesh(a: ColoredMesh, b: ColoredMesh): void {
  expect(Array.from(b.positions)).toEqual(Array.from(a.positions));
  expect(Array.from(b.indices)).toEqual(Array.from(a.indices));
  expect(Array.from(b.labels)).toEqual(Array.from(a.labels));
  expect(b.partId === undefined).toBe(a.partId === undefined);
  if (a.partId) expect(Array.from(b.partId ?? [])).toEqual(Array.from(a.partId));
}

const u16 = (b: Uint8Array, at: number): number => b[at] | (b[at + 1] << 8);
const u32 = (b: Uint8Array, at: number): number => new DataView(b.buffer, b.byteOffset).getUint32(at, true);

const codeOf = (fn: () => unknown): string => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AssetCodecError);
    return (error as AssetCodecError).code;
  }
  throw new Error('expected an AssetCodecError');
};

describe('mesh assets (CPGM)', () => {
  it('round-trips meshes exactly, with and without part ids, 16- and 32-bit indices', () => {
    for (const [V, T, partId] of [
      [3, 1, false],
      [100, 150, true],
      [65_536, 2000, false], // the largest mesh with 16-bit indices
      [65_537, 2000, true], // the first with 32-bit indices
    ] as const) {
      const mesh = randomMesh(V, T, V + T, partId);
      const bytes = encodeMeshAsset(mesh);
      const flags = u16(bytes, 6);
      expect((flags & MESH_FLAG_INDEX16) !== 0).toBe(V <= 65_536);
      expect((flags & MESH_FLAG_PART_ID) !== 0).toBe(partId);
      expectSameMesh(mesh, decodeMeshAsset(bytes));
    }
  });

  it('writes the documented layout: magic, version 1, counts, then positions, indices, labels', () => {
    const mesh: ColoredMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      labels: new Uint8Array([7, 8, 255]),
    };
    const b = encodeMeshAsset(mesh);
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe('CPGM');
    expect(u16(b, 4)).toBe(1);
    expect(u16(b, 6)).toBe(MESH_FLAG_INDEX16);
    expect(u32(b, 8)).toBe(3);
    expect(u32(b, 12)).toBe(3);
    expect(new DataView(b.buffer).getFloat32(16 + 12, true)).toBe(1); // vertex 1, x
    expect([u16(b, 52), u16(b, 54), u16(b, 56)]).toEqual([0, 1, 2]);
    expect(Array.from(b.subarray(58))).toEqual([7, 8, 255]);
    expect(b.length).toBe(16 + 36 + 6 + 3);
  });

  it('is deterministic (equal meshes give equal bytes, so content addressing deduplicates)', () => {
    const a = encodeMeshAsset(randomMesh(500, 900, 3, true));
    const b = encodeMeshAsset(randomMesh(500, 900, 3, true));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it('keeps −0 and extreme finite floats bit for bit', () => {
    const mesh: ColoredMesh = {
      positions: new Float32Array([-0, 3.4e38, -3.4e38, 1e-45, 0.1, -0.1, 48, 60, 1 / 3]),
      indices: new Uint32Array([2, 1, 0]),
      labels: new Uint8Array([0, 1, 2]),
    };
    const back = decodeMeshAsset(encodeMeshAsset(mesh));
    expect(Buffer.from(back.positions.buffer).equals(Buffer.from(mesh.positions.buffer))).toBe(true);
    expect(Object.is(back.positions[0], -0)).toBe(true);
  });

  it('decodes from an unaligned view inside a larger buffer and returns fresh, transferable buffers', () => {
    const bytes = encodeMeshAsset(randomMesh(40, 60, 9, true));
    const big = new Uint8Array(bytes.length + 7);
    big.set(bytes, 3);
    const view = big.subarray(3, 3 + bytes.length);
    const mesh = decodeMeshAsset(view);
    expectSameMesh(decodeMeshAsset(bytes), mesh);
    for (const a of [mesh.positions, mesh.indices, mesh.labels, mesh.partId!]) {
      expect(a.buffer).not.toBe(big.buffer);
      expect(a.byteOffset).toBe(0);
      expect(a.byteLength).toBe(a.buffer.byteLength);
    }
    // also from a plain ArrayBuffer
    expectSameMesh(mesh, decodeMeshAsset(bytes.slice().buffer));
  });

  it('an empty mesh (no triangles, no vertices) round-trips', () => {
    const empty: ColoredMesh = { positions: new Float32Array(0), indices: new Uint32Array(0), labels: new Uint8Array(0) };
    const back = decodeMeshAsset(encodeMeshAsset(empty));
    expect(back.positions.length + back.indices.length + back.labels.length).toBe(0);
  });

  it('refuses to store an inconsistent or non-finite mesh', () => {
    const ok = randomMesh(10, 5, 1);
    expect(codeOf(() => encodeMeshAsset({ ...ok, positions: new Float32Array(10) }))).toBe('length');
    expect(codeOf(() => encodeMeshAsset({ ...ok, indices: new Uint32Array([0, 1]) }))).toBe('length');
    expect(codeOf(() => encodeMeshAsset({ ...ok, labels: new Uint8Array(9) }))).toBe('length');
    expect(codeOf(() => encodeMeshAsset({ ...ok, partId: new Uint8Array(11) }))).toBe('length');
    expect(codeOf(() => encodeMeshAsset({ ...ok, indices: new Uint32Array([0, 1, 10]) }))).toBe('range');
    const nan = ok.positions.slice();
    nan[4] = Number.NaN;
    expect(codeOf(() => encodeMeshAsset({ ...ok, positions: nan }))).toBe('value');
    const inf = ok.positions.slice();
    inf[0] = Number.POSITIVE_INFINITY;
    expect(codeOf(() => encodeMeshAsset({ ...ok, positions: inf }))).toBe('value');
  });

  it('refuses damaged, foreign, newer or truncated assets (never a half-read mesh)', () => {
    const good = encodeMeshAsset(randomMesh(20, 30, 5, true));
    const patched = (at: number, value: number, size: 1 | 2 | 4 = 1): Uint8Array => {
      const b = good.slice();
      const view = new DataView(b.buffer);
      if (size === 1) view.setUint8(at, value);
      else if (size === 2) view.setUint16(at, value, true);
      else view.setUint32(at, value, true);
      return b;
    };
    expect(codeOf(() => decodeMeshAsset(new Uint8Array(0)))).toBe('magic');
    expect(codeOf(() => decodeMeshAsset(patched(0, 0x58)))).toBe('magic');
    expect(codeOf(() => decodeMeshAsset(encodeSdfAsset({ data: new Int16Array(1), dims: [1, 1, 1], origin: [0, 0, 0], voxel: 1 })))).toBe('magic');
    expect(codeOf(() => decodeMeshAsset(patched(4, 2, 2)))).toBe('version');
    expect(codeOf(() => decodeMeshAsset(patched(4, 0, 2)))).toBe('version');
    expect(codeOf(() => decodeMeshAsset(patched(6, 0x10, 2)))).toBe('flags');
    expect(codeOf(() => decodeMeshAsset(patched(6, MESH_FLAG_INDEX16, 2)))).toBe('length'); // part ids announced away
    expect(codeOf(() => decodeMeshAsset(good.subarray(0, good.length - 1)))).toBe('length');
    expect(codeOf(() => decodeMeshAsset(new Uint8Array([...good, 0])))).toBe('length');
    expect(codeOf(() => decodeMeshAsset(good.subarray(0, 10)))).toBe('length');
    expect(codeOf(() => decodeMeshAsset(patched(12, 31, 4)))).toBe('length'); // not whole triangles
    expect(codeOf(() => decodeMeshAsset(patched(8, 0xffffffff, 4)))).toBe('range'); // absurd count before allocating
    // an index past the vertices (u16 index 0 → 20)
    expect(codeOf(() => decodeMeshAsset(patched(16 + 20 * 12, 20, 2)))).toBe('range');
    // a NaN position
    const nan = good.slice();
    new DataView(nan.buffer).setFloat32(16, Number.NaN, true);
    expect(codeOf(() => decodeMeshAsset(nan))).toBe('value');
    // 16-bit indices claimed for too many vertices
    const many = encodeMeshAsset(randomMesh(65_537, 1, 2));
    const lie = many.slice();
    new DataView(lie.buffer).setUint16(6, MESH_FLAG_INDEX16, true);
    expect(codeOf(() => decodeMeshAsset(lie))).toBe('flags');
  });

  it('the Blob codec stores and reads back through putAsset-style Blobs', async () => {
    const mesh = randomMesh(64, 100, 11, true);
    const blob = meshAssetCodec.encode(mesh);
    expect(blob.type).toBe(MESH_ASSET_MIME);
    expect(meshAssetCodec.mime).toBe('application/x-cpg-mesh');
    expectSameMesh(mesh, await meshAssetCodec.decode(blob));
    await expect(meshAssetCodec.decode(new Blob(['not a mesh']))).rejects.toBeInstanceOf(AssetCodecError);
  });

  it('is compact: 12 bytes per vertex + 1 label (+ 1 part id), 2 bytes per index up to 65 536 vertices', () => {
    const b = encodeMeshAsset(randomMesh(30_000, 60_000, 4));
    expect(b.length).toBe(16 + 30_000 * 13 + 180_000 * 2);
  });
});

describe('sdf assets (CPGS)', () => {
  it('round-trips a volume exactly (dims, origin, voxel, every sample incl. the Int16 extremes)', () => {
    const rng = mulberry32(7);
    const dims: [number, number, number] = [5, 7, 3];
    const data = new Int16Array(dims[0] * dims[1] * dims[2]);
    for (let i = 0; i < data.length; i++) data[i] = Math.floor((rng() - 0.5) * 65535);
    data[0] = -32768;
    data[1] = 32767;
    const v: SdfVolume = { data, dims, origin: [-1.25, 0.1, 1 / 3], voxel: 0.0791 };
    const b = encodeSdfAsset(v);
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe('CPGS');
    expect(b.length).toBe(56 + data.length * 2);
    const back = decodeSdfAsset(b);
    expect(back.dims).toEqual(dims);
    expect(back.origin).toEqual(v.origin);
    expect(back.voxel).toBe(v.voxel);
    expect(Array.from(back.data)).toEqual(Array.from(data));
    expect(back.data.byteOffset).toBe(0);
  });

  it('refuses bad volumes and damaged assets', () => {
    const v: SdfVolume = { data: new Int16Array(8), dims: [2, 2, 2], origin: [0, 0, 0], voxel: 0.1 };
    expect(codeOf(() => encodeSdfAsset({ ...v, dims: [2, 2, 3] }))).toBe('length');
    expect(codeOf(() => encodeSdfAsset({ ...v, dims: [2, 0, 4] }))).toBe('range');
    expect(codeOf(() => encodeSdfAsset({ ...v, voxel: 0 }))).toBe('value');
    expect(codeOf(() => encodeSdfAsset({ ...v, origin: [0, Number.NaN, 0] }))).toBe('value');
    const good = encodeSdfAsset(v);
    expect(codeOf(() => decodeSdfAsset(good.subarray(0, good.length - 2)))).toBe('length');
    const newer = good.slice();
    new DataView(newer.buffer).setUint16(4, 9, true);
    expect(codeOf(() => decodeSdfAsset(newer))).toBe('version');
    const reserved = good.slice();
    new DataView(reserved.buffer).setUint32(20, 1, true);
    expect(codeOf(() => decodeSdfAsset(reserved))).toBe('flags');
    const voxel = good.slice();
    new DataView(voxel.buffer).setFloat64(48, -1, true);
    expect(codeOf(() => decodeSdfAsset(voxel))).toBe('value');
    expect(codeOf(() => decodeSdfAsset(encodeMeshAsset(randomMesh(3, 1, 1))))).toBe('magic');
  });

  it('the Blob codec', async () => {
    const v: SdfVolume = { data: new Int16Array([1, -2, 3, -4, 5, -6]), dims: [3, 2, 1], origin: [1, 2, 3], voxel: 0.5 };
    const blob = sdfAssetCodec.encode(v);
    expect(blob.type).toBe(SDF_ASSET_MIME);
    expect(await sdfAssetCodec.decode(blob)).toEqual(v);
  });
});

describe('photo-label assets (CPGL, §2.9.6)', () => {
  it('round-trips the §2.9.6 layout: CPGL, version 1, reserved 0, w, h, Int8 labels with −1 outside', async () => {
    const labels = new Int8Array([-1, 0, 1, 2, 127, -128]);
    const b = encodeLabelsAsset({ labels, w: 3, h: 2 });
    expect(String.fromCharCode(...b.subarray(0, 4))).toBe('CPGL');
    expect([u16(b, 4), u16(b, 6), u32(b, 8), u32(b, 12)]).toEqual([1, 0, 3, 2]);
    expect(b.length).toBe(16 + 6);
    const back = decodeLabelsAsset(b);
    expect(back.w).toBe(3);
    expect(back.h).toBe(2);
    expect(Array.from(back.labels)).toEqual([-1, 0, 1, 2, 127, -128]);
    const blob = labelsAssetCodec.encode({ labels, w: 3, h: 2 });
    expect(blob.type).toBe(LABELS_ASSET_MIME);
    expect(Array.from((await labelsAssetCodec.decode(blob)).labels)).toEqual(Array.from(labels));
  });

  it('refuses a wrong size or a damaged header', () => {
    expect(codeOf(() => encodeLabelsAsset({ labels: new Int8Array(5), w: 3, h: 2 }))).toBe('length');
    expect(codeOf(() => encodeLabelsAsset({ labels: new Int8Array(0), w: 0, h: 0 }))).toBe('range');
    const good = encodeLabelsAsset({ labels: new Int8Array(4), w: 2, h: 2 });
    expect(codeOf(() => decodeLabelsAsset(good.subarray(0, 19)))).toBe('length');
    const flags = good.slice();
    flags[6] = 1;
    expect(codeOf(() => decodeLabelsAsset(flags))).toBe('flags');
    expect(codeOf(() => decodeLabelsAsset(new TextEncoder().encode('CPGXxxxxxxxxxxxxxxxx')))).toBe('magic');
  });
});
