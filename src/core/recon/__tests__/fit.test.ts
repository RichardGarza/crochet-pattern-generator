// fitPart (DESIGN.md §2.9.7 step 4, §5.2.1): builder tessellations of every candidate type come back as that type
// with their dims; reconstructed (marching-cubes) meshes of a sphere, a capsule and a flat disc fit with residual
// < 0.03 (§6.3 T3); a ring and a teddy-shaped union are meshes; the canonical teddy's 17 parts keep their types.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ColoredMesh } from '../../../types/geometry';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { marchingCubes } from '../../kernel/geom/marchingCubes';
import { taubinSmooth } from '../../kernel/geom/taubin';
import { eulerXYZToMat3 } from '../../model/transforms';
import { tessellatePart } from '../../model/builder';
import { localToWorld } from '../../model/transforms';
import { isImplemented } from '../../stub';
import { FIT_ACCEPT, fitCandidates, fitPart, flatBuilderSdf, nearestFrame, ringProfile, solveLinear, surfaceSamples, turnFreeAxes } from '../fit';

const CANON = JSON.parse(readFileSync(new URL('../../../../fixtures/models/teddy.canonical.json', import.meta.url), 'utf8')) as CrochetModelV1;

/** A part's builder tessellation in model space, as a ColoredMesh. */
function meshOf(p: Part): ColoredMesh {
  const t = tessellatePart(p);
  const positions = new Float32Array(t.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const w = localToWorld(p, [t.positions[i], t.positions[i + 1], t.positions[i + 2]]);
    positions.set(w, i);
  }
  return { positions, indices: t.indices, labels: new Uint8Array(positions.length / 3) };
}

const part = (type: Part['type'], dims: Record<string, unknown>, position: Vec3 = [0, 0, 0], rotationDeg?: Vec3): Part =>
  ({ id: 'p', type, dims, position, ...(rotationDeg ? { rotationDeg } : {}), color: 'main' }) as Part;

/** A marching-cubes mesh (Taubin-smoothed, like a reconstruction) of an SDF on a cube of side `L` at N samples. */
function mcMesh(f: (p: Vec3) => number, L: number, N = 64): ColoredMesh {
  const voxel = L / (N - 1);
  const origin: Vec3 = [-L / 2, -L / 2, -L / 2];
  const field = new Float32Array(N * N * N);
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) field[x + N * (y + N * z)] = f([origin[0] + voxel * x, origin[1] + voxel * y, origin[2] + voxel * z]);
  const m = marchingCubes(field, [N, N, N], { origin, voxel });
  taubinSmooth(m.positions, m.indices);
  return { positions: Float32Array.from(m.positions), indices: Uint32Array.from(m.indices), labels: new Uint8Array(m.positions.length / 3) };
}

/** The local Y axis of a fitted rotation (the axis of revolution types). */
const localY = (rot: Vec3): Vec3 => {
  const R = eulerXYZToMat3(rot);
  return [R[1], R[4], R[7]];
};
const parallel = (a: Vec3, b: Vec3): number => Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(...a) * Math.hypot(...b));

describe('fitPart — §5.2.1 entry point', () => {
  it('is implemented (no longer the Step 0 stub)', () => {
    expect(isImplemented(fitPart)).toBe(true);
  });

  it('refuses meshes without triangles of positive area and a negative tolerance', () => {
    const empty: ColoredMesh = { positions: new Float32Array(0), indices: new Uint32Array(0), labels: new Uint8Array(0) };
    expect(() => fitPart(empty)).toThrow(RangeError);
    const flat: ColoredMesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), indices: new Uint32Array([0, 1, 2]), labels: new Uint8Array(3) };
    expect(() => fitPart(flat)).toThrow(RangeError);
    const bad: ColoredMesh = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 7]), labels: new Uint8Array(3) };
    expect(() => fitPart(bad)).toThrow(RangeError);
    expect(() => fitPart(meshOf(part('sphere', { r: 1 })), { tolerance: -1 })).toThrow(RangeError);
    expect(() => fitPart(meshOf(part('sphere', { r: 1 })), { tolerance: Number.NaN })).toThrow(RangeError);
  });

  it('is deterministic', () => {
    const m = meshOf(part('capsule', { r: 0.5, length: 3 }, [1, 2, 3], [20, 30, 40]));
    expect(fitPart(m)).toEqual(fitPart(m));
  });
});

describe('fitPart — builder tessellations come back as their own type', () => {
  const cases: [string, Part, (r: ReturnType<typeof fitPart>) => void][] = [
    ['sphere', part('sphere', { r: 1.3 }, [0.5, 2, -1]), (r) => expect((r.dims as { r: number }).r).toBeCloseTo(1.3, 2)],
    [
      'ellipsoid (axis-aligned: rotation 0, dims in x/y/z order)',
      part('ellipsoid', { rx: 2.1, ry: 2.6, rz: 1.9 }, [0, 2.7, 0]),
      (r) => {
        expect(r.dims).toMatchObject({ rx: expect.closeTo(2.1, 1), ry: expect.closeTo(2.6, 1), rz: expect.closeTo(1.9, 1) });
        expect(r.rotationDeg).toEqual([0, 0, 0]);
      },
    ],
    [
      'capsule (rotated)',
      part('capsule', { r: 0.55, length: 3 }, [2, 3.6, 0.55], [-28, 0, 22]),
      (r) => {
        expect(r.dims).toMatchObject({ r: expect.closeTo(0.55, 2), length: expect.closeTo(3, 2) });
        expect(parallel(localY(r.rotationDeg), localY([-28, 0, 22]))).toBeGreaterThan(0.9999);
      },
    ],
    ['cylinder (tapered, rotated)', part('cylinder', { rTop: 0.6, rBottom: 1, h: 2 }, [0, 0, 0], [30, 0, 10]), (r) => expect(r.dims).toMatchObject({ rTop: expect.closeTo(0.6, 2), rBottom: expect.closeTo(1, 2), h: expect.closeTo(2, 2) })],
    ['cone', part('cone', { r: 1, h: 2 }, [0, 1, 0]), (r) => expect(r.dims).toMatchObject({ r: expect.closeTo(1, 2), h: expect.closeTo(2, 2) })],
    [
      'flat disc (builder bevel undone)',
      part('flat', { shape: 'circle', w: 2, h: 2, thickness: 0.2 }, [1, 2, 3]),
      (r) => {
        expect(r.dims).toMatchObject({ shape: 'circle', w: expect.closeTo(2, 2), thickness: expect.closeTo(0.2, 3) });
        expect(r.rotationDeg).toEqual([0, 0, 0]);
      },
    ],
    ['flat oval (standing, rotated)', part('flat', { shape: 'oval', w: 3, h: 1.6, thickness: 0.25 }, [0, 1, 0], [0, 40, 0]), (r) => expect(r.dims).toMatchObject({ shape: 'oval', w: expect.closeTo(3, 1), h: expect.closeTo(1.6, 1) })],
    ['flat triangle → polygon outline', part('flat', { shape: 'triangle', w: 2, h: 2, thickness: 0.2 }), (r) => expect((r.dims as { shape: string; points?: unknown[] }).shape).toBe('polygon')],
    ['lathe (a vase)', part('lathe', { profile: [[0, 0], [1, 0.2], [0.5, 1], [0.8, 1.6], [0, 2]] }), () => undefined],
  ];
  for (const [name, p, check] of cases) {
    it(name, () => {
      const r = fitPart(meshOf(p));
      expect(r.type).toBe(p.type);
      expect(r.residual).toBeLessThan(0.03);
      check(r);
      if (p.type !== 'lathe') for (let k = 0; k < 3; k++) expect(r.position[k]).toBeCloseTo(p.position[k], 2);
      // (a lathe's profile is the mean ring radius: a sharp bulge comes back up to 4% narrower)
      const tol = p.type === 'lathe' ? 0.04 : 0.02;
      // the fitted part's tessellation occupies the same box (2% of the largest extent)
      const a = meshOf(p).positions;
      const b = meshOf({ ...p, type: r.type, dims: r.dims, position: r.position, rotationDeg: r.rotationDeg } as Part).positions;
      const box = (q: Float32Array): number[] => [0, 1, 2].flatMap((k) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = k; i < q.length; i += 3) {
          lo = Math.min(lo, q[i]);
          hi = Math.max(hi, q[i]);
        }
        return [lo, hi];
      });
      const ba = box(a);
      const bb = box(b);
      const size = Math.max(ba[1] - ba[0], ba[3] - ba[2], ba[5] - ba[4]);
      for (let k = 0; k < 6; k++) expect(Math.abs(ba[k] - bb[k]), `box ${k}`).toBeLessThan(tol * size);
    });
  }

  it('the canonical teddy: all 17 parts keep their type (residual < 0.03)', () => {
    for (const p of CANON.parts) {
      const r = fitPart(meshOf(p));
      expect(r.type, p.id).toBe(p.type);
      expect(r.residual, p.id).toBeLessThan(0.03);
    }
  });
});

describe('fitPart — reconstructed meshes (acceptance: sphere / capsule / flat disc, residual < 0.03)', () => {
  it('a marching-cubes sphere', () => {
    const r = fitPart(mcMesh((p) => 0.8 - Math.hypot(...p), 2));
    expect(r.type).toBe('sphere');
    expect(r.residual).toBeLessThan(0.03);
    expect((r.dims as { r: number }).r).toBeCloseTo(0.8, 1);
  });

  it('a marching-cubes capsule (tilted)', () => {
    const axis: Vec3 = [Math.sin(0.4), Math.cos(0.4), 0];
    const r = fitPart(
      mcMesh((p) => {
        const t = Math.max(-0.6, Math.min(0.6, p[0] * axis[0] + p[1] * axis[1] + p[2] * axis[2]));
        return 0.3 - Math.hypot(p[0] - t * axis[0], p[1] - t * axis[1], p[2] - t * axis[2]);
      }, 2.2, 80),
    );
    expect(r.type).toBe('capsule');
    expect(r.residual).toBeLessThan(0.03);
    expect(r.dims).toMatchObject({ r: expect.closeTo(0.3, 1), length: expect.closeTo(1.8, 1) });
    expect(parallel(localY(r.rotationDeg), axis)).toBeGreaterThan(0.999);
  });

  it('a marching-cubes flat disc', () => {
    const r = fitPart(mcMesh((p) => Math.min(0.9 - Math.hypot(p[0], p[1]), 0.12 - Math.abs(p[2])), 2.2, 96));
    expect(r.type).toBe('flat');
    expect(r.residual).toBeLessThan(0.03);
    expect((r.dims as { shape: string }).shape).toBe('circle');
  });

  it('a ring is not a disc (volume check): it stays a mesh', () => {
    const r = fitPart(meshOf(part('torus', { R: 1, r: 0.3 })));
    expect(r.type).toBe('mesh');
    expect(r.dims).toMatchObject({ meshRef: '', bboxIn: [expect.closeTo(2.6, 3), expect.closeTo(2.6, 3), expect.closeTo(0.6, 3)] });
    expect(r.residual).toBeGreaterThan(FIT_ACCEPT);
  });

  it('a snowman is a lathe; a body with a head and an arm off its axis is a mesh, unless the tolerance is loosened', () => {
    const snowman = mcMesh((p) => Math.max(0.45 - Math.hypot(p[0], p[1] + 0.4, p[2]), 0.32 - Math.hypot(p[0], p[1] - 0.35, p[2])), 2, 64);
    expect(fitPart(snowman).type).toBe('lathe');
    const m = mcMesh(
      (p) => Math.max(0.45 - Math.hypot(p[0], p[1] + 0.3, p[2]), 0.3 - Math.hypot(p[0] - 0.15, p[1] - 0.4, p[2] + 0.1), 0.25 - Math.hypot(p[0] + 0.55, p[1] + 0.1, p[2] - 0.2)),
      2,
      64,
    );
    const r = fitPart(m);
    expect(r.type).toBe('mesh');
    expect(fitPart(m, { tolerance: 10 }).type).not.toBe('mesh');
    expect(fitPart(meshOf(part('sphere', { r: 1 })), { tolerance: 0 }).type).toBe('mesh');
  });

  it('prefers the simpler type within 0.02 of the best', () => {
    // a sphere is fitted as well by an ellipsoid and a lathe: the sphere wins
    const all = fitCandidates(meshOf(part('sphere', { r: 1 })));
    expect(all.find((c) => c.type === 'ellipsoid')?.residual).toBeLessThan(0.01);
    expect(fitPart(meshOf(part('sphere', { r: 1 }))).type).toBe('sphere');
  });
});

describe('fit helpers', () => {
  it('surfaceSamples: total area, sub-triangles cover large triangles', () => {
    const quad = { positions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 1, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) };
    const s = surfaceSamples(quad.positions, quad.indices, { density: 8 });
    expect(s.area).toBeCloseTo(2, 12);
    expect(s.w.reduce((a, b) => a + b, 0)).toBeCloseTo(2, 12);
    expect(s.count).toBeGreaterThan(2 * 16);
    expect(s.v.length).toBe(12);
  });

  it('ringProfile: a cylinder side has the radius in every interior ring', () => {
    const s = surfaceSamples(...(Object.values(meshOf(part('cylinder', { rTop: 1, rBottom: 1, h: 4 }))).slice(0, 2) as [Float32Array, Uint32Array]));
    const rp = ringProfile(s, [0, 0, 0], [0, 1, 0]);
    expect(rp.n).toBe(24);
    expect(rp.dt * rp.n).toBeCloseTo(4, 6);
    for (let i = 1; i < 23; i++) expect(rp.mean[i]).toBeCloseTo(1, 2);
  });

  it('solveLinear: solves, and reports singular systems', () => {
    expect(solveLinear([2, 1, 1, 3], [3, 5], 2)?.map((v) => +v.toFixed(12))).toEqual([0.8, 1.4]);
    expect(solveLinear([1, 2, 2, 4], [1, 2], 2)).toBeNull();
  });

  it('nearestFrame / turnFreeAxes give right-handed rotations closest to the identity', () => {
    const { R } = nearestFrame([[0, 0, 1], [1, 0, 0], [0, 1, 0]]);
    expect(R).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const T = turnFreeAxes([0, -1, 0, 1, 0, 0, 0, 0, 1], 2);
    expect(T.map((v) => Math.round(v * 1e9) / 1e9 + 0)).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('flatBuilderSdf: zero on the faces, the bevel and the rim', () => {
    const outline = [-1, -1, 1, -1, 1, 1, -1, 1];
    const f = flatBuilderSdf(outline, 0.2, 0.06);
    expect(f(0, 0, 0.1)).toBeCloseTo(0, 12);
    expect(f(1.06, 0, 0)).toBeCloseTo(0, 12);
    expect(f(1, 0, 0.1)).toBeCloseTo(0, 6);
    expect(f(0, 0, 0)).toBeGreaterThan(0);
    expect(f(0, 0, 0.3)).toBeLessThan(0);
  });
});
