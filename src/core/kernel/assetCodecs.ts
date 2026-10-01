// Binary asset formats shared by every track (DESIGN.md §5.5.6, design v1.5). Step 0 kernel: pure, no DOM.
//
// Three kinds of derived-but-stored data are kept as project assets (`putAsset(bytes, mime)`, content-addressed):
//
//   mesh   `application/x-cpg-mesh`    `ColoredMesh` of a mesh part, `threeD.meshAssets[<meshRef>]`  (T3, T5, T6, T7)
//   sdf    `application/x-cpg-sdf`     `SdfVolume` of a mesh part, `threeD.meshAssets['sdf:' + meshRef]` (T3, T5)
//   labels `application/x-cpg-labels`  a view's photo-label image, `PhotoView.labelsKey`               (T3)
//
// Each format starts with a 4-byte magic, a u16 LE version and a u16 LE flags/reserved word; every number is
// little-endian. Encoding is deterministic (equal content → equal bytes → equal sha256, so content addressing
// deduplicates), decoding is strict: a wrong magic, a newer version, unknown flags, a length that does not match the
// header exactly, an index past the vertices or a non-finite number throw an `AssetCodecError`, never return a
// half-read value. Decoded arrays own fresh ArrayBuffers (they can be transferred to a worker).
import type { ColoredMesh, SdfVolume, Vec3 } from '../../types/geometry';

export const MESH_ASSET_MIME = 'application/x-cpg-mesh';
export const SDF_ASSET_MIME = 'application/x-cpg-sdf';
export const LABELS_ASSET_MIME = 'application/x-cpg-labels';

/** The versions this build writes and the newest it reads. */
export const MESH_ASSET_VERSION = 1;
export const SDF_ASSET_VERSION = 1;
export const LABELS_ASSET_VERSION = 1;

/** `ColoredMesh` flags (u16 at byte 6). */
export const MESH_FLAG_PART_ID = 1;
export const MESH_FLAG_INDEX16 = 2;
const MESH_KNOWN_FLAGS = MESH_FLAG_PART_ID | MESH_FLAG_INDEX16;

const MESH_HEADER = 16;
const SDF_HEADER = 56;
const LABELS_HEADER = 16;
/** Refuse absurd headers before allocating: 2^26 vertices / samples / pixels (≈ 800 MB of positions). */
const MAX_ELEMENTS = 1 << 26;

/** A stored asset that cannot be read (or a value that cannot be stored). `code` says which rule failed. */
export class AssetCodecError extends Error {
  readonly code: 'magic' | 'version' | 'flags' | 'length' | 'range' | 'value';
  constructor(code: AssetCodecError['code'], message: string) {
    super(message);
    this.name = 'AssetCodecError';
    this.code = code;
  }
}

const LITTLE_ENDIAN = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

type Bytes = ArrayBuffer | ArrayBufferView;

function asBytes(input: Bytes): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input);
}

function magicOf(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

function checkMagic(b: Uint8Array, magic: string, what: string): void {
  const want = magicOf(magic);
  if (b.length < 4 || want.some((c, i) => b[i] !== c)) throw new AssetCodecError('magic', `not a ${what} asset (expected the ${magic} header)`);
}

function checkVersion(view: DataView, newest: number, what: string): number {
  const version = view.getUint16(4, true);
  if (version === 0) throw new AssetCodecError('version', `${what} asset version 0 is not valid`);
  if (version > newest) throw new AssetCodecError('version', `${what} asset version ${version} is newer than this app reads (${newest}); update the app`);
  return version;
}

function writeHeader(view: DataView, magic: string, version: number, flags: number): void {
  magicOf(magic).forEach((c, i) => view.setUint8(i, c));
  view.setUint16(4, version, true);
  view.setUint16(6, flags, true);
}

/** Copies `count` little-endian elements at `offset` into a fresh typed array. */
function readFloat32(b: Uint8Array, offset: number, count: number): Float32Array<ArrayBuffer> {
  if (LITTLE_ENDIAN) return new Float32Array(b.slice(offset, offset + count * 4).buffer);
  const out = new Float32Array(count);
  const view = new DataView(b.buffer, b.byteOffset + offset, count * 4);
  for (let i = 0; i < count; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

function readUint32(b: Uint8Array, offset: number, count: number): Uint32Array<ArrayBuffer> {
  if (LITTLE_ENDIAN) return new Uint32Array(b.slice(offset, offset + count * 4).buffer);
  const out = new Uint32Array(count);
  const view = new DataView(b.buffer, b.byteOffset + offset, count * 4);
  for (let i = 0; i < count; i++) out[i] = view.getUint32(i * 4, true);
  return out;
}

function readUint16AsUint32(b: Uint8Array, offset: number, count: number): Uint32Array<ArrayBuffer> {
  const out = new Uint32Array(count);
  for (let i = 0, p = offset; i < count; i++, p += 2) out[i] = b[p] | (b[p + 1] << 8);
  return out;
}

function readInt16(b: Uint8Array, offset: number, count: number): Int16Array<ArrayBuffer> {
  if (LITTLE_ENDIAN) return new Int16Array(b.slice(offset, offset + count * 2).buffer);
  const out = new Int16Array(count);
  const view = new DataView(b.buffer, b.byteOffset + offset, count * 2);
  for (let i = 0; i < count; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

function writeTyped(out: Uint8Array, offset: number, src: Float32Array | Uint32Array | Int16Array): void {
  if (LITTLE_ENDIAN) {
    out.set(new Uint8Array(src.buffer, src.byteOffset, src.byteLength), offset);
    return;
  }
  const view = new DataView(out.buffer, out.byteOffset + offset, src.byteLength);
  const size = src.BYTES_PER_ELEMENT;
  for (let i = 0; i < src.length; i++) {
    if (src instanceof Float32Array) view.setFloat32(i * size, src[i], true);
    else if (src instanceof Uint32Array) view.setUint32(i * size, src[i], true);
    else view.setInt16(i * size, src[i], true);
  }
}

function allFinite(a: ArrayLike<number>): boolean {
  for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

function checkIndices(indices: ArrayLike<number>, vertices: number, what: string): void {
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] >= vertices) throw new AssetCodecError('range', `${what}: index ${indices[i]} at ${i} is past the ${vertices} vertices`);
  }
}

// ---- ColoredMesh (CPGM) -----------------------------------------------------------------------------------------
//
//  0  'CPGM'   4  u16 version (1)   6  u16 flags (bit 0: partId present; bit 1: 16-bit indices)
//  8  u32 V (vertices)   12  u32 I (indices, a multiple of 3)
// 16  V·3 float32 positions (x, y, z per vertex)
//     I indices: u16 when bit 1 is set (written whenever V ≤ 65 536), else u32
//     V u8 labels (255 = unknown), then V u8 partId when bit 0 is set. Nothing after.

/** Encodes a mesh part's buffers (§5.5.6). Throws `AssetCodecError` for an inconsistent or non-finite mesh. */
export function encodeMeshAsset(mesh: ColoredMesh): Uint8Array<ArrayBuffer> {
  const { positions, indices, labels, partId } = mesh;
  if (positions.length % 3 !== 0) throw new AssetCodecError('length', `encodeMeshAsset: ${positions.length} position values are not whole vertices`);
  const V = positions.length / 3;
  if (V > MAX_ELEMENTS) throw new AssetCodecError('range', `encodeMeshAsset: ${V} vertices exceed the limit`);
  if (indices.length % 3 !== 0) throw new AssetCodecError('length', `encodeMeshAsset: ${indices.length} indices are not whole triangles`);
  if (labels.length !== V) throw new AssetCodecError('length', `encodeMeshAsset: ${labels.length} labels for ${V} vertices`);
  if (partId !== undefined && partId.length !== V) throw new AssetCodecError('length', `encodeMeshAsset: ${partId.length} part ids for ${V} vertices`);
  if (!allFinite(positions)) throw new AssetCodecError('value', 'encodeMeshAsset: a position is not a finite number');
  checkIndices(indices, V, 'encodeMeshAsset');
  const I = indices.length;
  const index16 = V <= 65_536;
  const flags = (partId ? MESH_FLAG_PART_ID : 0) | (index16 ? MESH_FLAG_INDEX16 : 0);
  const indexBytes = I * (index16 ? 2 : 4);
  const total = MESH_HEADER + V * 12 + indexBytes + V + (partId ? V : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  writeHeader(view, 'CPGM', MESH_ASSET_VERSION, flags);
  view.setUint32(8, V, true);
  view.setUint32(12, I, true);
  let at = MESH_HEADER;
  writeTyped(out, at, positions);
  at += V * 12;
  if (index16) {
    for (let i = 0; i < I; i++, at += 2) {
      out[at] = indices[i] & 255;
      out[at + 1] = (indices[i] >>> 8) & 255;
    }
  } else {
    writeTyped(out, at, indices);
    at += indexBytes;
  }
  out.set(labels, at);
  at += V;
  if (partId) out.set(partId, at);
  return out;
}

/** Decodes a `CPGM` asset (§5.5.6). Strict: see the header comment. */
export function decodeMeshAsset(input: Bytes): ColoredMesh {
  const b = asBytes(input);
  checkMagic(b, 'CPGM', 'mesh');
  if (b.length < MESH_HEADER) throw new AssetCodecError('length', 'mesh asset: the header is cut short');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  checkVersion(view, MESH_ASSET_VERSION, 'mesh');
  const flags = view.getUint16(6, true);
  if ((flags & ~MESH_KNOWN_FLAGS) !== 0) throw new AssetCodecError('flags', `mesh asset: unknown flags 0x${flags.toString(16)}`);
  const V = view.getUint32(8, true);
  const I = view.getUint32(12, true);
  if (V > MAX_ELEMENTS || I > 3 * 2 * MAX_ELEMENTS) throw new AssetCodecError('range', `mesh asset: ${V} vertices / ${I} indices exceed the limit`);
  if (I % 3 !== 0) throw new AssetCodecError('length', `mesh asset: ${I} indices are not whole triangles`);
  const index16 = (flags & MESH_FLAG_INDEX16) !== 0;
  const hasPartId = (flags & MESH_FLAG_PART_ID) !== 0;
  if (index16 && V > 65_536) throw new AssetCodecError('flags', `mesh asset: 16-bit indices cannot address ${V} vertices`);
  const indexBytes = I * (index16 ? 2 : 4);
  const total = MESH_HEADER + V * 12 + indexBytes + V + (hasPartId ? V : 0);
  if (b.length !== total) throw new AssetCodecError('length', `mesh asset: ${b.length} bytes, the header describes ${total}`);
  let at = MESH_HEADER;
  const positions = readFloat32(b, at, V * 3);
  at += V * 12;
  const indices = index16 ? readUint16AsUint32(b, at, I) : readUint32(b, at, I);
  at += indexBytes;
  const labels = b.slice(at, at + V);
  at += V;
  if (!allFinite(positions)) throw new AssetCodecError('value', 'mesh asset: a position is not a finite number');
  checkIndices(indices, V, 'mesh asset');
  const mesh: ColoredMesh = { positions, indices, labels };
  if (hasPartId) mesh.partId = b.slice(at, at + V);
  return mesh;
}

// ---- SdfVolume (CPGS) -------------------------------------------------------------------------------------------
//
//  0  'CPGS'   4  u16 version (1)   6  u16 reserved (0)
//  8  u32 nx   12  u32 ny   16  u32 nz   20  u32 reserved (0)
// 24  f64 origin x, y, z   48  f64 voxel (inches, > 0)
// 56  nx·ny·nz int16 samples (x fastest; the `SdfVolume` layout of core/kernel/geom/sdfVolume.ts). Nothing after.

/** Encodes a stored signed-distance volume (§5.5.6). */
export function encodeSdfAsset(v: SdfVolume): Uint8Array<ArrayBuffer> {
  const [nx, ny, nz] = v.dims;
  if (![nx, ny, nz].every((n) => Number.isInteger(n) && n >= 1)) throw new AssetCodecError('range', `encodeSdfAsset: bad dims [${v.dims.join(', ')}]`);
  const count = nx * ny * nz;
  if (count > MAX_ELEMENTS) throw new AssetCodecError('range', `encodeSdfAsset: ${count} samples exceed the limit`);
  if (v.data.length !== count) throw new AssetCodecError('length', `encodeSdfAsset: ${v.data.length} samples for dims ${nx}×${ny}×${nz}`);
  if (!allFinite(v.origin) || v.origin.length !== 3) throw new AssetCodecError('value', 'encodeSdfAsset: origin is not three finite numbers');
  if (!(Number.isFinite(v.voxel) && v.voxel > 0)) throw new AssetCodecError('value', `encodeSdfAsset: voxel ${v.voxel} is not a positive number`);
  const out = new Uint8Array(SDF_HEADER + count * 2);
  const view = new DataView(out.buffer);
  writeHeader(view, 'CPGS', SDF_ASSET_VERSION, 0);
  view.setUint32(8, nx, true);
  view.setUint32(12, ny, true);
  view.setUint32(16, nz, true);
  for (let k = 0; k < 3; k++) view.setFloat64(24 + 8 * k, v.origin[k], true);
  view.setFloat64(48, v.voxel, true);
  writeTyped(out, SDF_HEADER, v.data);
  return out;
}

/** Decodes a `CPGS` asset (§5.5.6). */
export function decodeSdfAsset(input: Bytes): SdfVolume {
  const b = asBytes(input);
  checkMagic(b, 'CPGS', 'sdf');
  if (b.length < SDF_HEADER) throw new AssetCodecError('length', 'sdf asset: the header is cut short');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  checkVersion(view, SDF_ASSET_VERSION, 'sdf');
  if (view.getUint16(6, true) !== 0 || view.getUint32(20, true) !== 0) throw new AssetCodecError('flags', 'sdf asset: reserved fields are not 0');
  const dims: [number, number, number] = [view.getUint32(8, true), view.getUint32(12, true), view.getUint32(16, true)];
  if (dims.some((n) => n < 1)) throw new AssetCodecError('range', `sdf asset: bad dims [${dims.join(', ')}]`);
  const count = dims[0] * dims[1] * dims[2];
  if (count > MAX_ELEMENTS) throw new AssetCodecError('range', `sdf asset: ${count} samples exceed the limit`);
  if (b.length !== SDF_HEADER + count * 2) throw new AssetCodecError('length', `sdf asset: ${b.length} bytes, the header describes ${SDF_HEADER + count * 2}`);
  const origin: Vec3 = [view.getFloat64(24, true), view.getFloat64(32, true), view.getFloat64(40, true)];
  const voxel = view.getFloat64(48, true);
  if (!allFinite(origin)) throw new AssetCodecError('value', 'sdf asset: origin is not finite');
  if (!(Number.isFinite(voxel) && voxel > 0)) throw new AssetCodecError('value', `sdf asset: voxel ${voxel} is not a positive number`);
  return { data: readInt16(b, SDF_HEADER, count), dims, origin, voxel };
}

// ---- Photo-label image (CPGL, §2.9.6) ---------------------------------------------------------------------------
//
//  0  'CPGL'   4  u16 version (1)   6  u16 reserved (0)   8  u32 w   12  u32 h
// 16  w·h int8 labels, row-major from the top-left; −1 outside the mask, else an index into
//     `ProjectDoc.threeD.photoPalette`. Nothing after.

export interface LabelImage {
  labels: Int8Array<ArrayBuffer>;
  w: number;
  h: number;
}

/** Encodes a view's photo-label image (§2.9.6, §5.5.6). */
export function encodeLabelsAsset(img: LabelImage): Uint8Array<ArrayBuffer> {
  const { w, h, labels } = img;
  if (!(Number.isInteger(w) && Number.isInteger(h) && w >= 1 && h >= 1)) throw new AssetCodecError('range', `encodeLabelsAsset: bad size ${w} × ${h}`);
  if (w * h > MAX_ELEMENTS) throw new AssetCodecError('range', `encodeLabelsAsset: ${w * h} pixels exceed the limit`);
  if (labels.length !== w * h) throw new AssetCodecError('length', `encodeLabelsAsset: ${labels.length} labels for ${w} × ${h}`);
  const out = new Uint8Array(LABELS_HEADER + w * h);
  const view = new DataView(out.buffer);
  writeHeader(view, 'CPGL', LABELS_ASSET_VERSION, 0);
  view.setUint32(8, w, true);
  view.setUint32(12, h, true);
  out.set(new Uint8Array(labels.buffer, labels.byteOffset, labels.byteLength), LABELS_HEADER);
  return out;
}

/** Decodes a `CPGL` asset (§2.9.6, §5.5.6). */
export function decodeLabelsAsset(input: Bytes): LabelImage {
  const b = asBytes(input);
  checkMagic(b, 'CPGL', 'labels');
  if (b.length < LABELS_HEADER) throw new AssetCodecError('length', 'labels asset: the header is cut short');
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  checkVersion(view, LABELS_ASSET_VERSION, 'labels');
  if (view.getUint16(6, true) !== 0) throw new AssetCodecError('flags', 'labels asset: reserved field is not 0');
  const w = view.getUint32(8, true);
  const h = view.getUint32(12, true);
  if (w < 1 || h < 1 || w * h > MAX_ELEMENTS) throw new AssetCodecError('range', `labels asset: bad size ${w} × ${h}`);
  if (b.length !== LABELS_HEADER + w * h) throw new AssetCodecError('length', `labels asset: ${b.length} bytes, the header describes ${LABELS_HEADER + w * h}`);
  const bytes = b.slice(LABELS_HEADER);
  return { labels: new Int8Array(bytes.buffer), w, h };
}

// ---- Blob adapters (what `putAsset` / the asset loader exchange) -------------------------------------------------

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** An asset codec as the stores use it: `putAsset(codec.encode(value), codec.mime)` and back. */
export interface AssetCodec<T> {
  mime: string;
  encode(value: T): Blob;
  decode(blob: Blob): Promise<T>;
}

/** `ColoredMesh` ↔ `application/x-cpg-mesh` Blob (T7's `MeshCodec` shape). */
export const meshAssetCodec: AssetCodec<ColoredMesh> = {
  mime: MESH_ASSET_MIME,
  encode: (mesh) => new Blob([encodeMeshAsset(mesh)], { type: MESH_ASSET_MIME }),
  decode: async (blob) => decodeMeshAsset(await blobBytes(blob)),
};

/** `SdfVolume` ↔ `application/x-cpg-sdf` Blob. */
export const sdfAssetCodec: AssetCodec<SdfVolume> = {
  mime: SDF_ASSET_MIME,
  encode: (v) => new Blob([encodeSdfAsset(v)], { type: SDF_ASSET_MIME }),
  decode: async (blob) => decodeSdfAsset(await blobBytes(blob)),
};

/** Photo-label image ↔ `application/x-cpg-labels` Blob. */
export const labelsAssetCodec: AssetCodec<LabelImage> = {
  mime: LABELS_ASSET_MIME,
  encode: (img) => new Blob([encodeLabelsAsset(img)], { type: LABELS_ASSET_MIME }),
  decode: async (blob) => decodeLabelsAsset(await blobBytes(blob)),
};
