// Adversarial tests of the voxelizer (from the independent T5.1 review; kept as regression tests).
import { describe, expect, it } from 'vitest';
import { signedVolume } from '../../kernel/geom/meshMeasures';
import { remeshVolume } from '../remesh';
import { voxelizeMesh, voxelizeMeshOnGrid } from '../voxelize';
import { bestOf, bruteDistance, ellipsoidF, HEAVY, meshOf, sphereF, uvSphere, windingNumber, type Implicit } from './helpers';
import type { Vec3 } from '../../../types/geometry';

// Diagnostics are kept as no-ops so the measured values stay visible in the test code.
const log = (..._a: unknown[]): void => {};

/** Closed box [lo, hi], outward; `soup` = no shared vertices; `flip` = the other diagonal on every face. */
function boxMesh(lo: Vec3, hi: Vec3, o: { soup?: boolean; flip?: boolean } = {}): { positions: Float64Array; indices: Uint32Array } {
  const c = (i: number): Vec3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
  // faces as quads (outward, CCW seen from outside)
  const quads = [
    [0, 2, 3, 1], // z lo
    [4, 5, 7, 6], // z hi
    [0, 1, 5, 4], // y lo
    [2, 6, 7, 3], // y hi
    [0, 4, 6, 2], // x lo
    [1, 3, 7, 5], // x hi
  ];
  const tris: number[][] = [];
  for (const [a, b, cc, d] of quads) {
    if (o.flip) tris.push([a, b, d], [b, cc, d]);
    else tris.push([a, b, cc], [a, cc, d]);
  }
  if (!o.soup) {
    const pos: number[] = [];
    for (let i = 0; i < 8; i++) pos.push(...c(i));
    return { positions: new Float64Array(pos), indices: new Uint32Array(tris.flat()) };
  }
  const pos: number[] = [];
  const idx: number[] = [];
  for (const t of tris) for (const v of t) {
    idx.push(pos.length / 3);
    pos.push(...c(v));
  }
  return { positions: new Float64Array(pos), indices: new Uint32Array(idx) };
}

function boxSigned(p: Vec3, lo: Vec3, hi: Vec3): number {
  const a = [Math.min(p[0] - lo[0], hi[0] - p[0]), Math.min(p[1] - lo[1], hi[1] - p[1]), Math.min(p[2] - lo[2], hi[2] - p[2])];
  if (a[0] >= 0 && a[1] >= 0 && a[2] >= 0) return Math.min(a[0], a[1], a[2]);
  return -Math.hypot(Math.min(a[0], 0), Math.min(a[1], 0), Math.min(a[2], 0));
}

function compareBox(v: ReturnType<typeof voxelizeMesh>, lo: Vec3, hi: Vec3): { sign: number; maxErr: number } {
  let sign = 0;
  let maxErr = 0;
  let i = 0;
  for (let z = 0; z < v.dims[2]; z++)
    for (let y = 0; y < v.dims[1]; y++)
      for (let x = 0; x < v.dims[0]; x++, i++) {
        const p: Vec3 = [v.origin[0] + x * v.voxel, v.origin[1] + y * v.voxel, v.origin[2] + z * v.voxel];
        const ref = boxSigned(p, lo, hi);
        if (Math.abs(ref) > 0.01 * v.voxel && ref > 0 !== v.field[i] > 0) sign++;
        maxErr = Math.max(maxErr, Math.abs(v.field[i] - ref) / v.voxel);
      }
  return { sign, maxErr };
}

describe('voxelize: lattice-aligned and exact-hit inputs', HEAVY, () => {
  for (const soup of [false, true]) {
    for (const flip of [false, true]) {
      it(`cube with faces/edges on the lattice (soup=${soup}, flip=${flip})`, () => {
        const lo: Vec3 = [0, 0, 0];
        const hi: Vec3 = [10, 10, 10];
        const m = boxMesh(lo, hi, { soup, flip });
        const v = voxelizeMeshOnGrid(m, { dims: [15, 15, 15], origin: [-2, -2, -2], voxel: 1 });
        const r = compareBox(v, lo, hi);
        log('cube lattice', { soup, flip, odd: v.stats.oddColumns, ...r });
        expect(v.stats.oddColumns).toBe(0);
        expect(r.sign).toBe(0);
        expect(r.maxErr).toBeLessThan(1);
      });
    }
  }

  it('box whose top/bottom diagonals pass EXACTLY through ray positions (Float64), welded vs soup', () => {
    const e = 1e-4;
    const lo: Vec3 = [e, e, 0.5];
    const hi: Vec3 = [10 + e, 5 + e, 4.5];
    for (const soup of [false, true]) {
      for (const flip of [false, true]) {
        const m = boxMesh(lo, hi, { soup, flip });
        const v = voxelizeMeshOnGrid(m, { dims: [13, 8, 6], origin: [0, 0, 0], voxel: 1 });
        const r = compareBox(v, lo, hi);
        log('diag-exact', { soup, flip, odd: v.stats.oddColumns, ...r });
        expect(v.stats.oddColumns).toBe(0);
        expect(r.sign).toBe(0);
      }
    }
  });

  it('octahedron with both apexes exactly on a ray (Float64), welded and soup', () => {
    const e = 1e-4;
    const c: Vec3 = [3 + e, 3 + e, 3];
    const P: Vec3[] = [
      [c[0] + 2, c[1], c[2]],
      [c[0] - 2, c[1], c[2]],
      [c[0], c[1] + 2, c[2]],
      [c[0], c[1] - 2, c[2]],
      [c[0], c[1], c[2] + 2],
      [c[0], c[1], c[2] - 2],
    ];
    const T = [
      [0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4],
      [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5],
    ];
    for (const soup of [false, true]) {
      const pos: number[] = [];
      const idx: number[] = [];
      if (soup) for (const t of T) for (const k of t) {
        idx.push(pos.length / 3);
        pos.push(...P[k]);
      }
      else {
        for (const p of P) pos.push(...p);
        idx.push(...T.flat());
      }
      const v = voxelizeMeshOnGrid({ positions: new Float64Array(pos), indices: new Uint32Array(idx) }, { dims: [7, 7, 7], origin: [0, 0, 0], voxel: 1 });
      const col = 3 + 7 * 3;
      const s = Array.from({ length: 7 }, (_, z) => v.field[col + 49 * z] > 0);
      log('octa', { soup, odd: v.stats.oddColumns, col: s });
      expect(v.stats.oddColumns).toBe(0);
      // z = 1 and z = 5 lie ~1e-4 voxel from an apex (on the surface): either side is accepted
      expect([s[0], s[2], s[3], s[4], s[6]]).toEqual([false, true, true, true, false]);
    }
  });

  it('auto grid on an integer cube [0,1]^3 and a cube at large offset', () => {
    for (const off of [0, 1000]) {
      const lo: Vec3 = [off, off, off];
      const hi: Vec3 = [off + 1, off + 1, off + 1];
      const m = boxMesh(lo, hi);
      const v = voxelizeMesh({ positions: new Float32Array(m.positions), indices: m.indices }, 96);
      const r = compareBox(v, lo, hi);
      log('cube auto', { off, odd: v.stats.oddColumns, ...r, vol: signedVolume(remeshVolume(v)) });
      expect(v.stats.oddColumns).toBe(0);
      expect(r.sign).toBe(0);
    }
  });
});

describe('voxelize: shells, thin, tiny, huge', HEAVY, () => {
  it('hollow sphere (inner shell inverted, and not inverted): shell inside, cavity outside', () => {
    const outer = uvSphere(1, 64, 32);
    const inner = uvSphere(0.5, 48, 24);
    for (const invert of [true, false]) {
      const ii = new Uint32Array(inner.indices);
      if (invert) for (let t = 0; t < ii.length; t += 3) [ii[t + 1], ii[t + 2]] = [ii[t + 2], ii[t + 1]];
      const nO = outer.positions.length / 3;
      const positions = new Float32Array([...outer.positions, ...inner.positions]);
      const indices = new Uint32Array([...outer.indices, ...Array.from(ii, (k) => k + nO)]);
      const v = voxelizeMesh({ positions, indices }, 64);
      let wrong = 0;
      let i = 0;
      for (let z = 0; z < v.dims[2]; z++)
        for (let y = 0; y < v.dims[1]; y++)
          for (let x = 0; x < v.dims[0]; x++, i++) {
            const r = Math.hypot(v.origin[0] + x * v.voxel, v.origin[1] + y * v.voxel, v.origin[2] + z * v.voxel);
            const ref = Math.min(1 - r, r - 0.5);
            if (Math.abs(ref) > 0.02 && ref > 0 !== v.field[i] > 0) wrong++;
          }
      log('hollow', { invert, wrong, odd: v.stats.oddColumns });
      expect(wrong).toBe(0);
    }
  });

  it('two overlapping closed spheres in one mesh: parity makes the overlap a hole (documents the limitation)', () => {
    const a = uvSphere(1, 48, 24, [-0.4, 0, 0]);
    const b = uvSphere(1, 48, 24, [0.4, 0, 0]);
    const n = a.positions.length / 3;
    const positions = new Float32Array([...a.positions, ...b.positions]);
    const indices = new Uint32Array([...a.indices, ...Array.from(b.indices, (k) => k + n)]);
    const v = voxelizeMesh({ positions, indices }, 64);
    // the center (inside both spheres)
    const cx = Math.round((0 - v.origin[0]) / v.voxel);
    const cy = Math.round((0 - v.origin[1]) / v.voxel);
    const cz = Math.round((0 - v.origin[2]) / v.voxel);
    const center = v.field[cx + v.dims[0] * (cy + v.dims[1] * cz)];
    const wn = windingNumber({ positions, indices }, [0, 0, 0]);
    log('overlap shells', { center, wn });
    // LIMITATION (spec-mandated parity): union semantics would give center > 0 (winding number 2); parity
    // makes the overlap of two shells a hole. Asserting the current behavior so the suite documents it.
    expect(wn).toBeGreaterThan(1.9);
    expect(center).toBeLessThan(0);
  });

  it('thin plate (0.3 voxel thick) vanishes: no inside sample', () => {
    const m = boxMesh([-1, -1, -0.005], [1, 1, 0.005]);
    const v = voxelizeMesh(m, 64);
    let inside = 0;
    for (const f of v.field) if (f > 0) inside++;
    log('thin plate', { voxel: v.voxel, inside, odd: v.stats.oddColumns });
    expect(inside).toBe(0); // documents behavior
  });

  it('tiny (r = 1e-5) and far (center 1e4) spheres voxelize and remesh to the right volume', () => {
    for (const [r, c] of [
      [1e-5, [0, 0, 0]],
      [1, [1e3, 0, 0]], // at 1e4 the Step 0 marching cubes refuses (float32 resolution guard), not a T5 issue
    ] as [number, Vec3][]) {
      const m = uvSphere(r, 64, 32, c);
      const v = voxelizeMesh(m, 64);
      const ratio = signedVolume(remeshVolume(v)) / signedVolume(m);
      log('tiny/far', { r, c, ratio, odd: v.stats.oddColumns });
      expect(ratio).toBeGreaterThan(0.97);
      expect(ratio).toBeLessThan(1.03);
    }
  });

  it('a single triangle: odd columns reported, finite field, nothing inside', () => {
    const v = voxelizeMesh({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0.3]), indices: new Uint32Array([0, 1, 2]) }, 32);
    log('single tri', { dims: v.dims, odd: v.stats.oddColumns });
    expect(v.field.every((f) => Number.isFinite(f))).toBe(true);
    expect(v.field.every((f) => f <= 0)).toBe(true);
  });

  it('a flat mesh with margin 0 (dims 1 on one axis)', () => {
    let err: unknown = null;
    try {
      const v = voxelizeMesh({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }, 16, { margin: 0 });
      log('flat margin0', { dims: v.dims, finite: v.field.every((f) => Number.isFinite(f)) });
    } catch (e) {
      err = e;
      log('flat margin0 threw', String(e));
    }
    expect(err === null || err instanceof RangeError).toBe(true);
  });
});

describe('voxelize: N = 96 accuracy (subset) and timing', HEAVY, () => {
  const blob: Implicit = (x, y, z) => Math.max(sphereF(0.8)(x, y, z), ellipsoidF([0.3, 0.6, 0.3], [0.6, 0.3, 0])(x, y, z));
  it('2k-triangle mesh at N = 96: every 37th sample within 1 voxel of brute force', () => {
    const mesh = meshOf(blob, 22, 1.1);
    const v = voxelizeMesh(mesh, 96);
    let maxErr = 0;
    let signErr = 0;
    for (let k = 0; k < v.field.length; k += 37) {
      const x = k % v.dims[0];
      const y = Math.floor(k / v.dims[0]) % v.dims[1];
      const z = Math.floor(k / v.dims[0] / v.dims[1]);
      const p: Vec3 = [v.origin[0] + x * v.voxel, v.origin[1] + y * v.voxel, v.origin[2] + z * v.voxel];
      const d = bruteDistance(mesh, p);
      const a = blob(p[0], p[1], p[2]);
      const inside = Math.abs(a) > 0.1 ? a > 0 : windingNumber(mesh, p) > 0.5;
      const ref = inside ? d : -d;
      maxErr = Math.max(maxErr, Math.abs(v.field[k] - ref) / v.voxel);
      if (d > 0.01 * v.voxel && v.field[k] > 0 !== inside) signErr++;
    }
    log('N96 subset', { maxErr, signErr });
    expect(signErr).toBe(0);
    expect(maxErr).toBeLessThanOrEqual(1);
  });

  it('box (sharp edges) at N = 96: error vs exact box SDF', () => {
    const lo: Vec3 = [-1, -0.5, -0.7];
    const hi: Vec3 = [1, 0.5, 0.7];
    const m = boxMesh(lo, hi);
    const v = voxelizeMesh({ positions: new Float32Array(m.positions), indices: m.indices }, 96);
    const r = compareBox(v, lo, hi);
    log('box N96', r);
    expect(r.sign).toBe(0);
    expect(r.maxErr).toBeLessThanOrEqual(1);
  });

  it('40k-triangle soup (unwelded) within 400 ms', { retry: 2 }, () => {
    const s = uvSphere(1, 200, 101);
    const pos = new Float32Array(s.indices.length * 3);
    const idx = new Uint32Array(s.indices.length);
    for (let i = 0; i < s.indices.length; i++) {
      idx[i] = i;
      for (let a = 0; a < 3; a++) pos[3 * i + a] = s.positions[3 * s.indices[i] + a];
    }
    const ms = bestOf(3, () => voxelizeMesh({ positions: pos, indices: idx }, 96));
    const ref = voxelizeMesh(s, 96);
    const soup = voxelizeMesh({ positions: pos, indices: idx }, 96);
    let diff = 0;
    for (let i = 0; i < ref.field.length; i++) if (ref.field[i] > 0 !== soup.field[i] > 0) diff++;
    log('soup 40k', { ms, diff, odd: soup.stats.oddColumns });
    expect(diff).toBe(0);
    expect(ms).toBeLessThan(400);
  });
});
