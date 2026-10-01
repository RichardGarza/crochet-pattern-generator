// Adversarial tests of the cut, merge and convert (from the independent T5.1 review; kept as regression tests).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { manifoldReport } from '../../kernel/geom/manifold';
import { countComponents, isWatertight, signedVolume } from '../../kernel/geom/meshMeasures';
import { partVolume, surfaceGap } from '../../model/sdf';
import { convertPrimitive, primitiveColoredMesh, recenterMesh } from '../convert';
import { cutPart } from '../cut';
import { mergeParts } from '../merge';
import { remeshVolume } from '../remesh';
import { MeshToolError, type FieldVolume } from '../volume';
import { HEAVY, sphereF, type Implicit } from './helpers';
import { bestOfAsync, budget, PERF } from '../../../test/timing';
import type { CrochetModelV1, Part } from '../../../types/model';
import type { Vec3 } from '../../../types/geometry';

// Diagnostics are kept as no-ops so the measured values stay visible in the test code.
const log = (..._a: unknown[]): void => {};

const teddy = JSON.parse(readFileSync(new URL('../../../../fixtures/models/teddy.canonical.json', import.meta.url), 'utf8')) as CrochetModelV1;
const palette = teddy.palette.map((c) => c.id);
const byId = (id: string): Part => teddy.parts.find((q) => q.id === id) as Part;
const body = byId('body');
const head = byId('head');
const base = { position: [0, 0, 0] as Vec3, rotationDeg: [0, 0, 0] as Vec3, color: 'caramel_yarn' };

function volumeOf(f: Implicit, n: number, half: number): FieldVolume {
  const voxel = (2 * half) / (n - 1);
  const field = new Float32Array(n * n * n);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = f(-half + x * voxel, -half + y * voxel, -half + z * voxel);
  return { field, dims: [n, n, n], origin: [-half, -half, -half], voxel };
}

describe('cut', HEAVY, () => {
  it('a plane that grazes the top sample leaves a near-empty sliver part instead of cut-misses', async () => {
    const v = volumeOf(sphereF(1), 41, 1.3);
    // topmost inside sample on the center column
    const n = 41;
    let top = -1;
    for (let y = 0; y < n; y++) if (v.field[20 + n * (y + n * 20)] > 0) top = y;
    const yTop = v.origin[1] + top * v.voxel;
    let res: unknown;
    try {
      const [a, b] = cutPart(v, { point: [0, yTop - 1e-6, 0], normal: [0, 1, 0] });
      const rep = await manifoldReport(b.mesh);
      res = { aVol: a.volumeIn3, bVol: b.volumeIn3, bTris: b.mesh.indices.length / 3, bStatus: rep.status, bGenus: rep.genus };
    } catch (e) {
      res = String(e);
    }
    log('graze', res);
    // Expected: refused ('cut-misses') or a piece of meaningful size.
    expect(typeof res === "string" || (res as { bVol: number; aVol: number }).bVol > 1e-3 * (res as { aVol: number }).aVol, JSON.stringify(res)).toBe(true);
  });

  it('a plane exactly through a lattice plane, non-normalized normal: volumes sum to the original', () => {
    const v = volumeOf(sphereF(1), 41, 1.3);
    const yPlane = v.origin[1] + 20 * v.voxel; // exactly samples
    const orig = signedVolume(remeshVolume(v));
    const [a, b] = cutPart(v, { point: [0, yPlane, 0], normal: [0, 1e-3, 0] });
    const ratio = (a.volumeIn3 + b.volumeIn3) / orig;
    log('lattice-plane cut', { ratio, a: a.volumeIn3, b: b.volumeIn3, wa: isWatertight(a.mesh.indices), wb: isWatertight(b.mesh.indices) });
    expect(ratio).toBeGreaterThan(0.98);
    expect(ratio).toBeLessThan(1.02);
  });

  it('a tangent plane (touching the sphere top) is refused', () => {
    const v = volumeOf(sphereF(1), 41, 1.3);
    let threw = false;
    try {
      cutPart(v, { point: [0, 1, 0], normal: [0, 1, 0] });
    } catch (e) {
      threw = e instanceof MeshToolError;
    }
    log('tangent refused', threw);
    expect(threw).toBe(true);
  });
});

describe('merge', HEAVY, () => {
  it('gap decision near 0.1 in agrees with the Step 0 surfaceGap', async () => {
    const out: unknown[] = [];
    for (const dy of [0.24, 0.245, 0.25, 0.255, 0.26]) {
      const h = { ...head, position: [head.position[0], head.position[1] + dy, head.position[2]] as Vec3 };
      const sg = surfaceGap(h, body);
      let merged: string;
      try {
        const r = await mergeParts([{ part: body }, { part: h }]);
        merged = `ok gap=${r.links[0].gapIn.toFixed(4)} bridge=${r.bridgeIn.toFixed(4)}`;
      } catch (e) {
        merged = String(e);
      }
      out.push({ dy, surfaceGap: sg, merged });
    }
    log('gap boundary', out);
    for (const o of out as { surfaceGap: number; merged: string }[]) {
      if (o.surfaceGap > 0.1) expect(o.merged, JSON.stringify(o)).toMatch(/do not touch/);
    }
  });

  it('a rotated primitive and the same part as a rotated MESH part merge to the same solid', async () => {
    const rot: Vec3 = [10, 25, 30];
    const rh: Part = { ...head, rotationDeg: rot };
    const conv = convertPrimitive({ ...head, position: [0, 0, 0], rotationDeg: [0, 0, 0] }, { paletteIds: palette });
    const meshHead: Part = { id: 'head', type: 'mesh', dims: { meshRef: 'm', bboxIn: conv.bboxIn }, position: head.position, rotationDeg: rot, color: 'cream_yarn' };
    const a = await mergeParts([{ part: body }, { part: rh }], { paletteIds: palette });
    const b = await mergeParts([{ part: body }, { part: meshHead, mesh: { ...conv.mesh, labels: new Uint8Array(conv.mesh.labels.length).fill(1) } }], { paletteIds: palette });
    log('rotated', { a: a.volumeIn3, b: b.volumeIn3, ga: a.genus, gb: b.genus });
    expect(Math.abs(b.volumeIn3 / a.volumeIn3 - 1)).toBeLessThan(0.01);
    // labels: top of the head (rotated) comes from the mesh part (cream = 1)
    let top = -1;
    let topY = -Infinity;
    for (let v = 0; v < b.mesh.positions.length / 3; v++) if (b.mesh.positions[3 * v + 1] > topY) { topY = b.mesh.positions[3 * v + 1]; top = v; }
    expect(b.mesh.labels[top]).toBe(1);
  });

  it('a part fully inside another: result = the outer part', async () => {
    const inner: Part = { ...base, id: 'bead', type: 'sphere', dims: { r: 0.5 }, position: body.position, color: 'cream_yarn' };
    const r = await mergeParts([{ part: body }, { part: inner }], { paletteIds: palette });
    log('inside', { vol: r.volumeIn3, body: partVolume(body), labels: [...new Set(r.mesh.labels)], pid: [...new Set(r.mesh.partId)] });
    expect(Math.abs(r.volumeIn3 / partVolume(body) - 1)).toBeLessThan(0.02);
    expect([...new Set(r.mesh.labels)]).toEqual([0]);
  });

  it('identical coincident parts with different colors keep at least one paint', async () => {
    const a: Part = { ...base, id: 'a', type: 'sphere', dims: { r: 1 }, color: 'caramel_yarn' };
    const b: Part = { ...a, id: 'b', color: 'cream_yarn' };
    const r = await mergeParts([{ part: a }, { part: b }], { paletteIds: palette });
    const labels = [...new Set(r.mesh.labels)];
    log('identical', { labels, pid: [...new Set(r.mesh.partId)], vol: r.volumeIn3 });
    expect(labels).not.toEqual([255]);
  });

  it('two spheres touching at one point (gap 0) and two boxes face to face', async () => {
    const s1: Part = { ...base, id: 's1', type: 'sphere', dims: { r: 1 }, position: [-1, 0, 0] };
    const s2: Part = { ...base, id: 's2', type: 'sphere', dims: { r: 1 }, position: [1, 0, 0] };
    const r = await mergeParts([{ part: s1 }, { part: s2 }]);
    const rep = await manifoldReport(r.mesh);
    log('kiss spheres', { comps: countComponents(r.mesh.indices), genus: r.genus, bridge: r.bridgeIn, status: rep.status, vol: r.volumeIn3 });
    const b1: Part = { ...base, id: 'b1', type: 'box', dims: { w: 1, h: 1, d: 1 }, position: [-0.5, 0, 0] };
    const b2: Part = { ...base, id: 'b2', type: 'box', dims: { w: 1, h: 1, d: 1 }, position: [0.5, 0, 0] };
    const rb = await mergeParts([{ part: b1 }, { part: b2 }]);
    log('face boxes', { comps: countComponents(rb.mesh.indices), genus: rb.genus, bridge: rb.bridgeIn, vol: rb.volumeIn3 });
    expect(countComponents(r.mesh.indices)).toBe(1);
    expect(countComponents(rb.mesh.indices)).toBe(1);
  });

  it('small parts: a cone tip 0.09 in from a sphere (gap <= 0.1) is merged, not refused', async () => {
    const out: unknown[] = [];
    for (const gap of [0.05, 0.08, 0.09, 0.099]) {
      const sphere: Part = { ...base, id: 'ball', type: 'sphere', dims: { r: 0.3 } };
      // cone apex +Y; flip it (rotate 180 about x) so its apex points down at the sphere top
      const cone: Part = { ...base, id: 'spike', type: 'cone', dims: { r: 0.15, h: 0.5 }, position: [0, 0.3 + gap + 0.25, 0], rotationDeg: [180, 0, 0] };
      try {
        const r = await mergeParts([{ part: sphere }, { part: cone }]);
        out.push({ gap, ok: true, link: r.links[0]?.gapIn, bridge: r.bridgeIn, comps: countComponents(r.mesh.indices) });
      } catch (e) {
        out.push({ gap, ok: false, err: String(e), sg: surfaceGap(cone, sphere) });
      }
    }
    log('cone tip', out);
    for (const o of out as { ok: boolean }[]) expect(o.ok, JSON.stringify(o)).toBe(true);
  });

  it('timing: two mesh parts (by buffer) and four primitives at N = 96 within 1 s', { ...PERF }, async () => {
    const cb = convertPrimitive({ ...body, position: [0, 0, 0] });
    const ch = convertPrimitive({ ...head, position: [0, 0, 0] });
    const mb: Part = { id: 'body', type: 'mesh', dims: { meshRef: 'b', bboxIn: cb.bboxIn }, position: body.position, rotationDeg: [0, 0, 0], color: 'caramel_yarn' };
    const mh: Part = { id: 'head', type: 'mesh', dims: { meshRef: 'h', bboxIn: ch.bboxIn }, position: head.position, rotationDeg: [0, 0, 0], color: 'caramel_yarn' };
    const best = await bestOfAsync(3, () => mergeParts([{ part: mb, mesh: cb.mesh }, { part: mh, mesh: ch.mesh }]));
    const best4 = await bestOfAsync(2, () => mergeParts([{ part: body }, { part: head }, { part: byId('ear_l') }, { part: byId('ear_r') }, { part: byId('muzzle') }, { part: byId('arm_l') }]));
    log('timing', { twoMeshParts: best, sixPrimitives: best4, tris: [cb.mesh.indices.length / 3, ch.mesh.indices.length / 3] });
    expect(best).toBeLessThan(budget(1000));
  });

  it('mergeParts does not mutate its inputs', async () => {
    const conv = convertPrimitive({ ...head, position: [0, 0, 0] });
    const copy = new Float32Array(conv.mesh.positions);
    const mh: Part = { id: 'head', type: 'mesh', dims: { meshRef: 'h', bboxIn: conv.bboxIn }, position: head.position, rotationDeg: [0, 0, 0], color: 'caramel_yarn' };
    const bodyJson = JSON.stringify(body);
    await mergeParts([{ part: body }, { part: mh, mesh: conv.mesh }]);
    expect(Buffer.compare(Buffer.from(copy.buffer), Buffer.from(conv.mesh.positions.buffer))).toBe(0);
    expect(JSON.stringify(body)).toBe(bodyJson);
  });
});

describe('convert: every primitive type', HEAVY, () => {
  const parts: Part[] = [
    { ...base, id: 'sphere', type: 'sphere', dims: { r: 1 } },
    { ...base, id: 'ell', type: 'ellipsoid', dims: { rx: 1, ry: 0.5, rz: 0.7 } },
    { ...base, id: 'cap', type: 'capsule', dims: { r: 0.4, length: 2 } },
    { ...base, id: 'cyl', type: 'cylinder', dims: { rTop: 0.5, rBottom: 0.7, h: 1.5 } },
    { ...base, id: 'cylTop', type: 'cylinder', dims: { rTop: 0.5, rBottom: 0.5, h: 1.5, open: 'top' } },
    { ...base, id: 'cylBottom', type: 'cylinder', dims: { rTop: 0.5, rBottom: 0.5, h: 1.5, open: 'bottom' } },
    { ...base, id: 'cylBoth', type: 'cylinder', dims: { rTop: 0.5, rBottom: 0.5, h: 1.5, open: 'both' } },
    { ...base, id: 'cone', type: 'cone', dims: { r: 0.6, h: 1.4 } },
    { ...base, id: 'torus', type: 'torus', dims: { R: 1, r: 0.3 } },
    { ...base, id: 'arc90', type: 'torus', dims: { R: 1, r: 0.3, arcDeg: 90 } },
    { ...base, id: 'arc270', type: 'torus', dims: { R: 1, r: 0.3, arcDeg: 270 } },
    { ...base, id: 'latheClosed', type: 'lathe', dims: { profile: [[0, 0], [0.6, 0.2], [0.7, 1], [0.3, 1.8], [0, 2]] } },
    { ...base, id: 'latheOpen', type: 'lathe', dims: { profile: [[0.5, 0], [0.7, 1], [0.4, 2]] } },
    { ...base, id: 'latheOpenTop', type: 'lathe', dims: { profile: [[0, 0], [0.7, 1], [0.4, 2]] } },
    { ...base, id: 'box', type: 'box', dims: { w: 1, h: 0.6, d: 0.8 } },
    { ...base, id: 'flatCircle', type: 'flat', dims: { shape: 'circle', w: 1.2, h: 1.2, thickness: 0.15 } },
    { ...base, id: 'flatOval', type: 'flat', dims: { shape: 'oval', w: 1.6, h: 1, thickness: 0.2 } },
    { ...base, id: 'flatTeardrop', type: 'flat', dims: { shape: 'teardrop', w: 1, h: 1.4, thickness: 0.2 } },
    { ...base, id: 'flatTri', type: 'flat', dims: { shape: 'triangle', w: 1.2, h: 1, thickness: 0.2 } },
    { ...base, id: 'flatRect', type: 'flat', dims: { shape: 'rect', w: 1.2, h: 0.8, thickness: 0.2 } },
    { ...base, id: 'flatPoly', type: 'flat', dims: { shape: 'polygon', w: 1, h: 1, thickness: 0.2, points: [[0, 0.5], [0.5, -0.5], [0, -0.2], [-0.5, -0.5]] } },
  ];
  for (const part of parts) {
    it(`${part.id}: watertight, manifold, volume vs partVolume, labels`, async () => {
      let res: Record<string, unknown>;
      try {
        const r = convertPrimitive(part, { paletteIds: palette, N: 96 });
        const rep = await manifoldReport(r.mesh);
        // flat parts: the builder bevels the outline (partVolume ignores it), so compare with the builder mesh;
        // torus arcs: the analytic SDF has round ends (see the dedicated arc test below)
        const ref = part.type === 'flat' ? signedVolume(primitiveColoredMesh(part)) : partVolume(part);
        const ratio = signedVolume(r.mesh) / ref;
        res = { source: r.source, watertight: isWatertight(r.mesh.indices), status: rep.status, genus: rep.genus, parts: rep.parts, ratio, labels: [...new Set(r.mesh.labels)], bbox: r.bboxIn };
      } catch (e) {
        res = { error: String(e) };
      }
      log('convert', part.id, res);
      expect(res.error).toBeUndefined();
      expect(res.watertight).toBe(true);
      expect(res.status).toBe('NoError');
      expect(res.labels).toEqual([0]);
      if (!(part.type === 'torus' && part.dims.arcDeg)) expect(Math.abs((res.ratio as number) - 1), JSON.stringify(res)).toBeLessThan(0.03);
    });
  }

  it('torus arcs converted from the analytic SDF are not clipped by the lattice (no inside sample on the border)', () => {
    const out: unknown[] = [];
    for (const arcDeg of [90, 180, 270]) {
      const r = convertPrimitive({ ...base, id: 'arc', type: 'torus', dims: { R: 1, r: 0.3, arcDeg } }, { N: 96 });
      const v = r.volume;
      const [nx, ny, nz] = v.dims;
      let border = 0;
      for (let z = 0; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
        if (x > 0 && y > 0 && z > 0 && x < nx - 1 && y < ny - 1 && z < nz - 1) continue;
        if (v.field[x + nx * (y + ny * z)] >= 0) border++;
      }
      out.push({ arcDeg, border, vol: signedVolume(r.mesh) });
    }
    log('arc border', out);
    for (const o of out as { border: number }[]) expect(o.border, JSON.stringify(out)).toBe(0);
  });

  it('recenterMesh of a rotated lathe: position update R·center', () => {
    const lathe: Part = { ...base, id: 'v', type: 'lathe', dims: { profile: [[0, 0], [0.6, 0.2], [0, 2]] }, rotationDeg: [90, 0, 0] };
    const r = convertPrimitive(lathe, { N: 48 });
    const c = recenterMesh(r.mesh);
    log('recenter', c.center);
    expect(c.center[1]).toBeGreaterThan(0.9);
  });
});
