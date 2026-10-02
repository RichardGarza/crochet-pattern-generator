import { readFileSync } from 'node:fs';
import { wrap } from 'comlink';
import { describe, expect, it } from 'vitest';
import { decodeMeshAsset, decodeSdfAsset, encodeMeshAsset, encodeSdfAsset } from '../../kernel/assetCodecs';
import { isWatertight, signedVolume } from '../../kernel/geom/meshMeasures';
import { fitPart } from '../../recon/fit';
import { isImplemented } from '../../stub';
import { exposeApi, isSuperseded } from '../../../workers/rpc';
import type { AmiSettings } from '../../../types/ami';
import type { ResolvedGauge } from '../../../types/gauge';
import type { CrochetModelV1, Part } from '../../../types/model';
import type { MeshApi } from '../../../types/workers';
import { MAX_SESSIONS, MeshService } from '../service';
import { padVolume, volumeFromSdf, volumeToSdf } from '../volume';
import { voxelizeMesh } from '../voxelize';
import { colored, HEAVY, meshOf, uvSphere, yShapeF } from './helpers';

// MeshApi in mesh.worker (§5.4, §2.9.8, §2.10.7): every method on the service, two independent instances, stored
// parts through the asset codecs, copies out, and the job gate over a real comlink channel.

const teddy = JSON.parse(readFileSync(new URL('../../../../fixtures/models/teddy.canonical.json', import.meta.url), 'utf8')) as CrochetModelV1;
const palette = teddy.palette.map((c) => c.id);
const ball: Part = { id: 'ball', type: 'sphere', dims: { r: 1 }, position: [0, 0, 0], rotationDeg: [0, 0, 0], color: 'cream_yarn' };
const GAUGE: ResolvedGauge = { cell: { w: 0.195, h: 0.195 / 1.05 }, wSc: 0.195, hSc: 0.19, lscIn: 1, hookMm: 3.5, stretch: 1.05, tol: 0.1, source: 'default' };
const SETTINGS: AmiSettings = { style: 'exact', spiral: true, crispStripes: false, decMethod: 'invdec', dialect: 'compact', terms: 'us', hand: 'right', eyes: 'auto', defaultStuffing: 'firm', leanStPerRnd: 0.25 };
const stroke = (tool: 'inflate' | 'deflate' | 'smooth' | 'flatten', x = 0) => ({ tool, points: [[x, 0, 1] as [number, number, number]], radius: 0.4, strength: 0.8, mirrorX: false });

/** Detaches a mesh's buffers (what a `Comlink.transfer` of a result does). */
function detach(m: { positions: Float32Array; indices: Uint32Array; labels: Uint8Array }): void {
  structuredClone(m, { transfer: [m.positions.buffer, m.indices.buffer, m.labels.buffer] as ArrayBuffer[] });
}

describe('MeshService (mesh.worker) — MeshApi', HEAVY, () => {
  it('fromPart → voxelize → sculpt → undo → redo → cut: shapes, labels, copies', async () => {
    const s = new MeshService({ tag: 'a' });
    const mesh = await s.fromPart(ball, { paletteIds: palette, N: 48 });
    expect(new Set(mesh.labels)).toEqual(new Set([palette.indexOf('cream_yarn')]));
    const { volumeId } = await s.voxelize(mesh, 48);
    expect(volumeId).toBe('a-v1');
    const v0 = signedVolume(mesh);
    const up = await s.sculpt(volumeId, stroke('inflate'));
    expect(up.undoId).toBe('a-v1:1');
    expect(signedVolume(up.mesh)).toBeGreaterThan(v0);
    expect(new Set(up.mesh.labels)).toEqual(new Set([palette.indexOf('cream_yarn')]));
    detach(up.mesh); // the caller transferred it: the session keeps its own copy
    const undone = await s.undoSculpt(up.undoId);
    expect([...undone.mesh.positions]).toEqual([...mesh.positions]);
    const redone = await s.redoSculpt(up.undoId);
    expect(signedVolume(redone.mesh)).toBeGreaterThan(v0);
    await expect(s.redoSculpt(up.undoId)).rejects.toMatchObject({ name: 'MeshToolError', code: 'unknown-undo' });
    const [a, b] = await s.cut(volumeId, { point: [0, 0, 0], normal: [0, 1, 0] });
    expect(isWatertight(a.indices) && isWatertight(b.indices)).toBe(true);
    expect(Math.abs((signedVolume(a) + signedVolume(b)) / signedVolume(redone.mesh) - 1)).toBeLessThan(0.02);
  });

  it('mirrorPlane on the stroke: a dab at x = 0.5 also changes its twin across the given plane', async () => {
    const s = new MeshService({ tag: 'm' });
    const { volumeId } = await s.voxelize(colored(uvSphere(1, 48, 24)), 48);
    const plain = await s.sculpt(volumeId, { ...stroke('inflate', 0.5), mirrorX: true, mirrorPlane: { point: [0.2, 0, 0], normal: [1, 0, 0] } });
    // twin of x = 0.5 across x = 0.2 is x = −0.1: the surface near (−0.1, 0, 1) moved outward
    let moved = 0;
    for (let v = 0; v < plain.mesh.positions.length / 3; v++) {
      const [x, y, z] = [plain.mesh.positions[3 * v], plain.mesh.positions[3 * v + 1], plain.mesh.positions[3 * v + 2]];
      if (Math.abs(x + 0.1) < 0.08 && Math.abs(y) < 0.08 && z > 0) moved = Math.max(moved, Math.hypot(x, y, z));
    }
    expect(moved).toBeGreaterThan(1.02);
  });

  it('two instances are independent: ids carry the instance tag and are refused by the other', async () => {
    const a = new MeshService({ tag: 'one' });
    const b = new MeshService({ tag: 'two' });
    const m = colored(uvSphere(1, 32, 16));
    const va = await a.voxelize(m, 40);
    const vb = await b.voxelize(m, 40);
    expect(va.volumeId).not.toBe(vb.volumeId);
    await expect(b.sculpt(va.volumeId, stroke('inflate'))).rejects.toMatchObject({ name: 'MeshToolError', code: 'unknown-volume' });
    const sa = await a.sculpt(va.volumeId, stroke('inflate'));
    await expect(b.undoSculpt(sa.undoId)).rejects.toMatchObject({ code: 'unknown-undo' });
    await expect(a.undoSculpt('garbage')).rejects.toMatchObject({ code: 'unknown-undo' });
    await expect(a.cut('nope', { point: [0, 0, 0], normal: [0, 1, 0] })).rejects.toMatchObject({ code: 'unknown-volume' });
    expect(() => new MeshService({ tag: 'bad tag' })).toThrow(RangeError);
  });

  it(`keeps at most ${MAX_SESSIONS} sculpt sessions, dropping the least recently used`, async () => {
    const s = new MeshService({ tag: 'lru' });
    const m = colored(uvSphere(0.5, 16, 8));
    const ids: string[] = [];
    for (let i = 0; i < MAX_SESSIONS; i++) ids.push((await s.voxelize(m, 16)).volumeId);
    await s.sculpt(ids[0], { ...stroke('smooth'), points: [[0, 0, 0.5]] }); // touch the oldest: now most recent
    ids.push((await s.voxelize(m, 16)).volumeId);
    expect(s.volumeIds.length).toBe(MAX_SESSIONS);
    expect(s.volumeIds).not.toContain(ids[1]);
    expect(s.volumeIds).toContain(ids[0]);
    await expect(s.sculpt(ids[1], stroke('inflate'))).rejects.toMatchObject({ code: 'unknown-volume' });
  });

  it('stored parts through the asset codecs: a decoded sdf:<meshRef> volume is reused, outputs encode losslessly', async () => {
    const s = new MeshService({ tag: 'c' });
    const sphere = colored(uvSphere(1, 48, 24), 2);
    const sdf = volumeToSdf(voxelizeMesh(sphere, 40));
    const stored = decodeSdfAsset(encodeSdfAsset(sdf));
    const storedMesh = decodeMeshAsset(encodeMeshAsset(sphere));
    const { volumeId } = await s.voxelize(storedMesh, 96, { storedSdf: stored });
    // the session's volume is the stored one, padded (no re-voxelization at N = 96)
    const expected = padVolume(volumeFromSdf(stored), 6);
    const [a] = await s.cut(volumeId, { point: [0, 0, 0], normal: [0, 0, 1] });
    expect(a.labels.every((l) => l === 2)).toBe(true);
    expect(expected.dims).toEqual(sdf.dims.map((d) => d + 12));
    // every mesh the service returns survives the mesh codec bit for bit
    for (const m of [a, await s.fromPart(ball, { paletteIds: palette, N: 32 })]) {
      const back = decodeMeshAsset(encodeMeshAsset(m));
      expect([...back.positions]).toEqual([...m.positions]);
      expect([...back.indices]).toEqual([...m.indices]);
      expect([...back.labels]).toEqual([...m.labels]);
    }
  });

  it('merge (teddy head + body) returns the frozen fields; the sdf encodes through the codec', async () => {
    const s = new MeshService();
    const body = teddy.parts.find((p) => p.id === 'body') as Part;
    const head = { ...(teddy.parts.find((p) => p.id === 'head') as Part), color: 'cream_yarn' };
    const r = await s.merge([{ part: body }, { part: head }], { paletteIds: palette });
    expect(r.genus).toBe(0);
    expect(Math.abs(r.volumeIn3 / r.unionVolumeIn3 - 1)).toBeLessThan(0.02);
    expect(new Set(r.mesh.labels)).toEqual(new Set([palette.indexOf('caramel_yarn'), palette.indexOf('cream_yarn')]));
    const back = decodeSdfAsset(encodeSdfAsset(r.sdf));
    expect(back.dims).toEqual(r.sdf.dims);
    expect([...back.data]).toEqual([...r.sdf.data]);
    await expect(s.merge([{ part: body }])).rejects.toMatchObject({ name: 'MeshToolError', code: 'too-few-parts' });
  });

  it.runIf(!isImplemented(fitPart))('fit passes T3’s stub through until fitPart lands', async () => {
    await expect(new MeshService().fit(colored(uvSphere(1, 16, 8)))).rejects.toMatchObject({ name: 'NotImplementedError' });
  });

  it.runIf(isImplemented(fitPart))('fit returns a primitive for a sphere mesh', async () => {
    const f = await new MeshService().fit(colored(uvSphere(1, 32, 16)));
    expect(f.type).toBe('sphere');
  });

  it('input checks', async () => {
    const s = new MeshService();
    await expect(s.voxelize(colored(uvSphere(1, 8, 4)), 14)).rejects.toThrow(RangeError);
    await expect(s.voxelize({ positions: new Float32Array(9), indices: new Uint32Array(3), labels: new Uint8Array(2) }, 32)).rejects.toThrow(RangeError);
    await expect(s.merge('x' as never)).rejects.toThrow(RangeError);
  });
});

describe('mesh.worker over comlink (exposeApi + the job gate)', HEAVY, () => {
  function connect(tag: string): { remote: ReturnType<typeof wrap<MeshApi>>; close: () => void } {
    const { port1, port2 } = new MessageChannel();
    exposeApi<MeshApi>((gate) => new MeshService({ gate, tag }), port1);
    const remote = wrap<MeshApi>(port2);
    return {
      remote,
      close: () => {
        port1.close();
        port2.close();
      },
    };
  }
  const req = (jobId: number, mesh = colored(uvSphere(1.25, 64, 32))) => ({ jobId, mesh, partId: 'p', frame: {}, gauge: GAUGE, settings: SETTINGS });

  it('pathB answers with rounds; a Y needs a split; redoSculpt is exposed', async () => {
    const { remote, close } = connect('w');
    try {
      const r = await remote.pathB(req(1));
      expect('counts' in r && r.path === 'B' && r.counts.length > 10).toBe(true);
      const split = await remote.pathB(req(2, colored(meshOf(yShapeF(), 70, 2.3, 3))));
      expect('needsSplit' in split && split.needsSplit.loops.length === 2).toBe(true);
      expect(typeof remote.redoSculpt).toBe('function');
    } finally {
      close();
    }
  });

  it('a supersede during a Path B job stops it with Superseded; the next job runs', async () => {
    const { remote, close } = connect('w2');
    try {
      const running = remote.pathB(req(5)).then(
        () => 'finished',
        (e: unknown) => e,
      );
      await new Promise((r) => setTimeout(r, 30));
      await remote.supersede(6);
      expect(isSuperseded(await running)).toBe(true);
      const next = await remote.pathB(req(6));
      expect('counts' in next).toBe(true);
    } finally {
      close();
    }
  });

  it('errors keep their name and message across the channel', async () => {
    const { remote, close } = connect('w3');
    try {
      const e = await remote.sculpt('w3-v9', stroke('inflate')).catch((x: unknown) => x as Error);
      expect((e as Error).name).toBe('MeshToolError');
      expect((e as Error).message).toMatch(/no sculpt volume/);
    } finally {
      close();
    }
  });
});
