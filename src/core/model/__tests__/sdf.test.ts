import { describe, expect, it } from 'vitest';
import { budget, PERF } from '../../../test/timing';
import type { Part, Vec3 } from '../../../types/model';
import { mulberry32, randomRange, type Rng } from '../../kernel/prng';
import { flatBevelSize } from '../builder';
import {
  gapOfVertices,
  gapProbe,
  gapWithEnclosure,
  localSdf,
  meshSdfOf,
  OVERLAP_MAX_SAMPLES,
  overlapVolume,
  overlapVolumeWith,
  partSdf,
  partVolume,
  partWorldVertices,
  sdfNormal,
  surfaceGap,
  surfaceGapWith,
  worldSdf,
} from '../sdf';
import { boundsSize, localBounds, localToWorld, worldBounds } from '../transforms';
import { readEveryType, readEveryTypeMeshes } from './helpers/everyType';
import { distanceToMesh, insideMesh, localMesh, meshVolume, part, samplePrimitives, type TriMesh, worldMesh } from './helpers/geometry';
import { HEAVY } from './helpers/options';
import { buildCanonicalTeddy } from './helpers/teddy';

/** Random points in the part's local bounding box grown by 35% on every side. */
function samplePoints(p: Part, rng: Rng, count: number): Vec3[] {
  const b = localBounds(p);
  const size = boundsSize(b);
  const out: Vec3[] = [];
  for (let i = 0; i < count; i++) {
    out.push([0, 1, 2].map((k) => randomRange(rng, b.min[k] - 0.35 * size[k], b.max[k] + 0.35 * size[k])) as Vec3);
  }
  return out;
}

interface Comparison {
  /** Largest | |sdf| − distance to the builder mesh |. */
  maxError: number;
  /** Points whose sign disagrees with the mesh although they are farther than `tolerance` from its surface. */
  wrongSign: number;
  inside: number;
  outside: number;
}

function compare(p: Part, mesh: TriMesh, points: Vec3[], tolerance: number): Comparison {
  const f = localSdf(p);
  const out: Comparison = { maxError: 0, wrongSign: 0, inside: 0, outside: 0 };
  for (const q of points) {
    const d = distanceToMesh(mesh, q);
    const inside = insideMesh(mesh, q);
    const s = f(q[0], q[1], q[2]);
    out.maxError = Math.max(out.maxError, Math.abs(Math.abs(s) - d));
    if (d > tolerance && s > 0 !== inside) out.wrongSign++;
    if (inside) out.inside++;
    else out.outside++;
  }
  return out;
}

describe('analytic SDFs match the builder mesh (§3.7.6: positive inside, builder semantics)', HEAVY, () => {
  // The builder tessellates with 48 segments around (32 for a capsule, 24 across a torus tube): a chord of a
  // circle of radius r lies up to r·(1 − cos(π/n)) inside it — 0.21% of r for 48 segments, 0.48% for 32, 0.86%
  // for 24 — and on a doubly curved surface the two directions add up. Stated tolerances, in inches:
  const cases: { name: string; part: Part; tolerance: number }[] = [
    { name: 'sphere', part: part('sphere', { r: 0.9 }), tolerance: 0.9 * 0.004 },
    { name: 'capsule', part: part('capsule', { r: 0.4, length: 2.2 }), tolerance: 0.4 * 0.0075 },
    { name: 'capsule shorter than 2r (the builder sphere)', part: part('capsule', { r: 0.6, length: 0.7 }), tolerance: 0.6 * 0.0075 },
    { name: 'cylinder', part: part('cylinder', { rTop: 0.8, rBottom: 0.8, h: 1.4 }), tolerance: 0.8 * 0.0025 },
    { name: 'tapered cylinder', part: part('cylinder', { rTop: 0.5, rBottom: 0.8, h: 1.4 }), tolerance: 0.8 * 0.0025 },
    { name: 'cone', part: part('cone', { r: 0.7, h: 1.5 }), tolerance: 0.7 * 0.0025 },
    { name: 'torus', part: part('torus', { R: 1.1, r: 0.3 }), tolerance: 0.3 * 0.009 + 1.4 * 0.0013 },
    { name: 'box', part: part('box', { w: 1.4, h: 0.9, d: 0.6 }), tolerance: 1e-6 },
    { name: 'lathe', part: samplePrimitives().find((p) => p.type === 'lathe') as Part, tolerance: 1.2 * 0.0025 },
    {
      name: 'lathe with sharp corners (the cylinder preset)',
      part: part('lathe', { profile: [[0, 0], [1, 0], [1, 2], [0, 2]] }),
      tolerance: 1 * 0.0025,
    },
  ];

  it.each(cases)('$name: |sdf| = distance to the mesh within the tessellation tolerance, and the sign is right', ({ part: p, tolerance }) => {
    const mesh = localMesh(p);
    const result = compare(p, mesh, samplePoints(p, mulberry32(101), 500), tolerance);
    expect(result.maxError).toBeLessThanOrEqual(tolerance);
    expect(result.wrongSign).toBe(0);
    expect(result.inside).toBeGreaterThan(15);
    expect(result.outside).toBeGreaterThan(15);
  });

  it('ellipsoid: exact sign; a lower bound of the distance outside; first-order accurate near the surface', () => {
    const rng = mulberry32(102);
    for (const dims of [
      { rx: 1.2, ry: 0.8, rz: 0.6 },
      { rx: 2.4, ry: 2.15, rz: 2.2 }, // the teddy head
      { rx: 0.85, ry: 0.85, rz: 0.35 }, // its ear
      { rx: 0.5, ry: 0.18, rz: 0.5 }, // its foot pad
    ]) {
      const p = part('ellipsoid', dims);
      const mesh = localMesh(p);
      const f = localSdf(p);
      const smallest = Math.min(dims.rx, dims.ry, dims.rz);
      const tessellation = Math.max(dims.rx, dims.ry, dims.rz) * 0.004;
      for (const q of samplePoints(p, rng, 300)) {
        const d = distanceToMesh(mesh, q);
        const s = f(q[0], q[1], q[2]);
        // the sign is exact: it is the sign of 1 − |q/r|
        const inside = (q[0] / dims.rx) ** 2 + (q[1] / dims.ry) ** 2 + (q[2] / dims.rz) ** 2 < 1;
        expect(s > 0).toBe(inside);
        if (d > tessellation) expect(insideMesh(mesh, q)).toBe(inside);
        // outside, the bound never overestimates the distance (so ray marching cannot step through the surface)
        if (!inside) expect(-s).toBeLessThanOrEqual(d + tessellation);
      }
      // Near the surface it is the distance to first order. A point at ±δ along the true normal of a surface
      // point is exactly δ away while δ is below the smallest radius of curvature (smallest² / largest).
      for (let k = 0; k < 200; k++) {
        const theta = randomRange(rng, 0, Math.PI);
        const phi = randomRange(rng, 0, 2 * Math.PI);
        const on: Vec3 = [dims.rx * Math.sin(theta) * Math.cos(phi), dims.ry * Math.cos(theta), dims.rz * Math.sin(theta) * Math.sin(phi)];
        const n: Vec3 = [on[0] / dims.rx ** 2, on[1] / dims.ry ** 2, on[2] / dims.rz ** 2];
        const len = Math.hypot(n[0], n[1], n[2]);
        const delta = randomRange(rng, -0.1, 0.1) * smallest;
        const s = f(on[0] + (n[0] / len) * delta, on[1] + (n[1] / len) * delta, on[2] + (n[2] / len) * delta);
        expect(Math.abs(s + delta)).toBeLessThanOrEqual(0.08 * Math.abs(delta) + 1e-9); // within 8% of the distance
      }
      expect(f(0, 0, 0)).toBe(smallest); // the center: the exact depth
    }
  });

  it('sphere, capsule, box: closed-form values', () => {
    const sphere = localSdf(part('sphere', { r: 2 }));
    expect(sphere(0, 0, 0)).toBe(2);
    expect(sphere(2, 0, 0)).toBe(0);
    expect(sphere(0, 5, 0)).toBe(-3);
    const capsule = localSdf(part('capsule', { r: 0.5, length: 3 })); // straight section from y = −1 to 1
    expect(capsule(0, 0, 0)).toBe(0.5);
    expect(capsule(0, 1.5, 0)).toBe(0);
    expect(capsule(0, 2, 0)).toBe(-0.5);
    expect(capsule(1.5, 0.7, 0)).toBe(-1);
    expect(capsule(0.3, -1.4, 0)).toBeCloseTo(0.5 - 0.5, 12); // on the bottom cap: hypot(0.3, 0.4) = 0.5
    const box = localSdf(part('box', { w: 2, h: 4, d: 6 }));
    expect(box(0, 0, 0)).toBe(1);
    expect(box(0.5, 0, 0)).toBe(0.5);
    expect(box(4, 0, 0)).toBe(-3);
    expect(box(4, 6, 0)).toBe(-5); // 3 and 4 past the edge
    expect(box(1, 2, 3)).toBe(0);
  });

  it('cylinder and cone: closed-form values; `open` is ignored (an open tube is a solid for contact)', () => {
    const cylinder = localSdf(part('cylinder', { rTop: 1, rBottom: 1, h: 2 }));
    expect(cylinder(0, 0, 0)).toBe(1);
    expect(cylinder(0.5, 0, 0)).toBe(0.5);
    expect(cylinder(0, 0.75, 0)).toBe(0.25);
    expect(cylinder(3, 0, 0)).toBe(-2);
    expect(cylinder(0, 3, 0)).toBe(-2);
    expect(cylinder(4, 5, 0)).toBe(-5); // past the rim: 3 out, 4 up
    for (const open of ['none', 'top', 'bottom', 'both'] as const) {
      const f = localSdf(part('cylinder', { rTop: 1, rBottom: 1, h: 2, open }));
      expect(f(0, 0.75, 0)).toBe(0.25);
      expect(f(0.2, -0.9, 0.3)).toBe(cylinder(0.2, -0.9, 0.3));
    }
    const cone = localSdf(part('cone', { r: 1, h: 2 })); // base at y = −1, apex at y = +1
    expect(cone(0, 1, 0)).toBeCloseTo(0, 12);
    expect(cone(0, 2, 0)).toBeCloseTo(-1, 12);
    expect(cone(0, -1.5, 0)).toBeCloseTo(-0.5, 12);
    expect(cone(0, -0.9, 0)).toBeCloseTo(0.1, 12); // nearest: the base
    expect(cone(0, 0, 0)).toBeCloseTo(0.5 * Math.cos(Math.atan(0.5)), 12); // nearest: the slanted side
    expect(cone(2, -1, 0)).toBeCloseTo(-1, 12);
  });

  it('torus: the ring lies in local XY; a self-intersecting torus (r > R) still has the right sign', () => {
    const torus = localSdf(part('torus', { R: 1, r: 0.25 }));
    expect(torus(1, 0, 0)).toBe(0.25);
    expect(torus(0, 1, 0)).toBe(0.25);
    expect(torus(0, 0, 0)).toBe(-0.75); // the hole
    expect(torus(1, 0, 0.25)).toBeCloseTo(0, 12);
    expect(torus(0, 0, 1)).toBeCloseTo(0.25 - Math.SQRT2, 12);
    const fat = localSdf(part('torus', { R: 0.5, r: 1 }));
    expect(fat(0, 0, 0)).toBe(0.5);
  });

  it('torus arc: a tube along the arc with round ends, measured against the sampled center line', () => {
    const rng = mulberry32(103);
    for (const arcDeg of [45, 180, 200, 330]) {
      const p = part('torus', { R: 1.1, r: 0.3, arcDeg });
      const f = localSdf(p);
      const centerLine: Vec3[] = [];
      for (let i = 0; i <= 4000; i++) {
        const u = (arcDeg * Math.PI * i) / (180 * 4000);
        centerLine.push([1.1 * Math.cos(u), 1.1 * Math.sin(u), 0]);
      }
      for (let k = 0; k < 150; k++) {
        const q: Vec3 = [randomRange(rng, -2, 2), randomRange(rng, -2, 2), randomRange(rng, -0.8, 0.8)];
        let best = Infinity;
        for (const c of centerLine) best = Math.min(best, Math.hypot(q[0] - c[0], q[1] - c[1], q[2] - c[2]));
        expect(f(q[0], q[1], q[2])).toBeCloseTo(0.3 - best, 4);
      }
      // the round end reaches r past the start of the arc (unless the other end comes round to meet it)
      expect(f(1.1, -0.29, 0)).toBeGreaterThan(0);
      if (arcDeg <= 200) expect(f(1.1, -0.31, 0)).toBeLessThan(0);
    }
    // along the swept part it is the full torus; arcDeg 360 is the full torus
    const half = localSdf(part('torus', { R: 1, r: 0.25, arcDeg: 180 }));
    expect(half(0, 1, 0)).toBe(0.25);
    expect(half(0, -1, 0)).toBeCloseTo(0.25 - Math.SQRT2, 12);
    expect(localSdf(part('torus', { R: 1, r: 0.25, arcDeg: 360 }))(0, -1, 0)).toBe(0.25);
  });

  it('torus arc: away from its ends, |sdf| = distance to the builder’s own open tube (it sweeps from +X toward +Y)', () => {
    // TorusGeometry has no end caps, so neither ray parity nor the region past the ends can be compared; between
    // the ends the nearest point of the tube lies in the query point's own meridian, as for the full ring.
    const rng = mulberry32(109);
    const tolerance = 0.3 * 0.009 + 1.4 * 0.0013; // the full torus's: 24 segments across the tube, ≤ 64 along it
    for (const arcDeg of [90, 200, 300]) {
      const p = part('torus', { R: 1.1, r: 0.3, arcDeg });
      const mesh = localMesh(p);
      const f = localSdf(p);
      const margin = (25 * Math.PI) / 180;
      let compared = 0;
      let inside = 0;
      for (const q of samplePoints(p, rng, 400)) {
        let theta = Math.atan2(q[1], q[0]);
        if (theta < 0) theta += 2 * Math.PI;
        if (!(theta > margin && theta < (arcDeg * Math.PI) / 180 - margin)) continue;
        const d = distanceToMesh(mesh, q);
        const s = f(q[0], q[1], q[2]);
        expect(Math.abs(Math.abs(s) - d), `${arcDeg}° at ${q.map((v) => v.toFixed(3)).join(', ')}`).toBeLessThanOrEqual(tolerance);
        if (s > 0) inside++;
        compared++;
      }
      expect(compared).toBeGreaterThan(60);
      expect(inside).toBeGreaterThan(5);
      // the tube really is where the builder put it: on the arc, not on its mirror image
      const middle = ((arcDeg / 2) * Math.PI) / 180;
      expect(distanceToMesh(mesh, [1.1 * Math.cos(middle), 1.1 * Math.sin(middle), 0])).toBeCloseTo(0.3, 2);
      expect(f(1.1 * Math.cos(middle), 1.1 * Math.sin(middle), 0)).toBeCloseTo(0.3, 9);
    }
  });

  it('lathe: closed by a flat disc where the profile does not reach the axis; exact against a dense revolved sampling', () => {
    // a cup: starts on the axis, ends off it → closed at the top by a disc of radius 0.8
    const cup = part('lathe', { profile: [[0, 0], [1, 0.4], [0.8, 1.5]] });
    const f = localSdf(cup);
    expect(f(0, 1.4, 0)).toBeCloseTo(0.1, 12); // 0.1 below the top disc
    expect(f(0, 1.6, 0)).toBeCloseTo(-0.1, 12);
    expect(f(0.5, 1.5, 0)).toBeCloseTo(0, 12);
    expect(f(0, 0.75, 0)).toBeGreaterThan(0);
    expect(f(0, -0.2, 0)).toBeCloseTo(-0.2, 12);
    // a tube section: both ends off the axis
    const tube = localSdf(part('lathe', { profile: [[0.5, 0], [0.5, 1], [0.5, 2]] }));
    expect(tube(0, 1, 0)).toBe(0.5);
    expect(tube(0, 0.1, 0)).toBeCloseTo(0.1, 12);
    expect(tube(2, 1, 0)).toBe(-1.5);
    // brute force in the meridian half-plane
    const profile: [number, number][] = [[0.3, -0.5], [1.2, 0], [0.4, 0.8], [0.9, 1.6], [0, 2]];
    const g = localSdf(part('lathe', { profile }));
    const boundary: [number, number][] = [];
    const closed: [number, number][] = [[0, -0.5], ...profile];
    for (let i = 0; i + 1 < closed.length; i++) {
      for (let k = 0; k <= 2000; k++) {
        const t = k / 2000;
        boundary.push([closed[i][0] + t * (closed[i + 1][0] - closed[i][0]), closed[i][1] + t * (closed[i + 1][1] - closed[i][1])]);
      }
    }
    const rng = mulberry32(104);
    for (let k = 0; k < 200; k++) {
      const q: Vec3 = [randomRange(rng, -1.6, 1.6), randomRange(rng, -1, 2.5), randomRange(rng, -1.6, 1.6)];
      const rho = Math.hypot(q[0], q[2]);
      let best = Infinity;
      for (const b of boundary) best = Math.min(best, Math.hypot(rho - b[0], q[1] - b[1]));
      expect(Math.abs(g(q[0], q[1], q[2]))).toBeCloseTo(best, 3);
    }
    // on the axis, inside: the sign is right where a polygon test is ambiguous
    expect(g(0, 0, 0)).toBeGreaterThan(0);
    expect(g(0, 1.9, 0)).toBeGreaterThan(0);
    expect(g(0, 2.1, 0)).toBeLessThan(0);
    expect(g(0, -0.6, 0)).toBeLessThan(0);
  });

  it.each([
    ['circle', { shape: 'circle', w: 1.6, h: 1.6, thickness: 0.3 }],
    ['oval', { shape: 'oval', w: 1.6, h: 1.1, thickness: 0.3 }],
    ['teardrop', { shape: 'teardrop', w: 0.9, h: 2.2, thickness: 0.3 }],
    ['triangle', { shape: 'triangle', w: 1.2, h: 1.4, thickness: 0.2 }],
    ['rect', { shape: 'rect', w: 1.5, h: 0.8, thickness: 0.25 }],
    ['polygon (concave)', { shape: 'polygon', w: 2, h: 2, thickness: 0.2, points: [[0, 1], [0.3, 0.3], [1, 0], [0.3, -0.3], [0, -1], [-0.3, -0.3], [-1, 0], [-0.3, 0.3]] }],
  ] as [string, Extract<Part, { type: 'flat' }>['dims']][])(
    'flat %s: the outline extruded by the thickness; it differs from the mesh only by the bevel (ignored, §3.7.6)',
    (_name, dims) => {
      const p = part('flat', dims);
      const mesh = localMesh(p);
      // The bevel grows the outline by up to bevelSize at mid-thickness (√2 more at a sharp corner).
      const tolerance = flatBevelSize(dims) * Math.SQRT2 + 0.005;
      const result = compare(p, mesh, samplePoints(p, mulberry32(105), 300), tolerance);
      expect(result.maxError).toBeLessThanOrEqual(tolerance);
      expect(result.wrongSign).toBe(0);
      expect(result.inside).toBeGreaterThan(10);
      const f = localSdf(p);
      // exact on the faces: the front and back faces of the mesh are the outline at z = ±thickness/2
      expect(f(0, 0, dims.thickness / 2)).toBeCloseTo(0, 9);
      expect(f(0, 0, 0)).toBeGreaterThan(0);
      expect(f(0, 0, dims.thickness)).toBeCloseTo(-dims.thickness / 2, 9);
      // the SDF solid lies inside the builder mesh (the bevel only adds material)
      const rng = mulberry32(106);
      for (const q of samplePoints(p, rng, 200)) {
        if (f(q[0], q[1], q[2]) > 0.01) expect(insideMesh(mesh, q)).toBe(true);
      }
    },
  );

  it('rect and circle prisms: closed-form values', () => {
    const rect = localSdf(part('flat', { shape: 'rect', w: 2, h: 1, thickness: 0.4 }));
    expect(rect(0, 0, 0)).toBeCloseTo(0.2, 9);
    expect(rect(0.9, 0, 0)).toBeCloseTo(0.1, 9);
    expect(rect(2, 0, 0)).toBeCloseTo(-1, 9);
    expect(rect(1.3, 0, 0.6)).toBeCloseTo(-0.5, 9); // 0.3 out, 0.4 up
    const disc = localSdf(part('flat', { shape: 'circle', w: 2, h: 2, thickness: 1 }));
    expect(disc(0.5, 0, 0)).toBeCloseTo(0.5, 2); // a 64-gon
    expect(disc(0, -3, 0)).toBeCloseTo(-2, 2);
  });

  it('mesh parts: the caller’s part-local SDF, else the ellipsoid inscribed in bboxIn', () => {
    const blob = part('mesh', { meshRef: 'ref-1', bboxIn: [2, 1, 4] }, { id: 'blob', position: [10, 0, 0], rotationDeg: [0, 0, 90] });
    const fallback = partSdf(blob);
    expect(fallback([10, 0, 0])).toBe(0.5);
    expect(fallback([10, 0, 1.9])).toBeGreaterThan(0);
    expect(fallback([10, 0, 2.1])).toBeLessThan(0);
    expect(fallback([10, 0.9, 0])).toBeGreaterThan(0); // local x (half extent 1) points along world +Y
    expect(fallback([10.6, 0, 0])).toBeLessThan(0); // local y (half extent 0.5) points along world −X
    // a supplied SDF is evaluated in the part's local frame
    const seen: Vec3[] = [];
    const supplied = partSdf(blob, (q) => {
      seen.push(q);
      return 0.25 - Math.hypot(q[0], q[1], q[2]);
    });
    expect(supplied([10, 0.1, 0])).toBeCloseTo(0.15, 12);
    expect(seen[0][0]).toBeCloseTo(0.1, 12);
    expect(seen[0][1]).toBeCloseTo(0, 12);
    expect(meshSdfOf(blob, { 'ref-1': () => 1 })?.([0, 0, 0])).toBe(1);
    expect(meshSdfOf(blob, { blob: () => 2 })?.([0, 0, 0])).toBe(2); // by part id when the meshRef is not a key
    expect(meshSdfOf(blob, { other: () => 3 })).toBeUndefined();
    expect(meshSdfOf(part('sphere', { r: 1 }), { sphere: () => 3 })).toBeUndefined();
    // the mesh function is ignored for primitives
    expect(partSdf(part('sphere', { r: 1 }), () => 99)([0, 0, 0])).toBe(1);
  });

  it('partSdf works in model space: it is the local SDF at the point brought into the part frame', () => {
    const rng = mulberry32(107);
    for (const base of samplePrimitives()) {
      const p = { ...base, position: [1.5, -2, 0.75] as Vec3, rotationDeg: [25, -130, 70] as Vec3 };
      const world = partSdf(p);
      const fast = worldSdf(p);
      const local = localSdf(base);
      for (const q of samplePoints(base, rng, 25)) {
        const w = localToWorld(p, q);
        expect(world(w)).toBeCloseTo(local(q[0], q[1], q[2]), 9);
        expect(fast(w[0], w[1], w[2])).toBe(world(w));
      }
    }
  });

  it('broken dims are read as the builder would draw them: a negative length by its size, a non-finite number as 0', () => {
    expect(partSdf(part('sphere', { r: -1 }))([0, 0, 0])).toBe(1);
    expect(partVolume(part('sphere', { r: -1 }))).toBeCloseTo((4 / 3) * Math.PI, 12);
    expect(partSdf(part('box', { w: -2, h: 2, d: 2 }))([0.5, 0, 0])).toBe(0.5);
    expect(partSdf(part('ellipsoid', { rx: 1, ry: Number.NaN, rz: 1 }))([0, 0.1, 0])).toBeLessThan(0);
    expect(partSdf(part('lathe', { profile: [[-1, 0], [-1, 2]] }))([0.5, 1, 0])).toBe(0.5);
    expect(partVolume(part('cylinder', { rTop: 1, rBottom: 1, h: Number.POSITIVE_INFINITY }))).toBe(0);
    // a part without dims, or with dims of the wrong shape, is a point
    const noDims = { id: 'x', type: 'sphere', position: [0, 0, 0], color: 'c1' } as unknown as Part;
    expect(partSdf(noDims)([0, 0, 0])).toBe(0);
    expect(partVolume(noDims)).toBe(0);
    expect(partSdf({ ...noDims, type: 'lathe', dims: { profile: 'round' } } as unknown as Part)([0, 0, 0])).toBe(Number.NEGATIVE_INFINITY);
    // an unknown type is never inside and has no volume
    const unknown = { ...noDims, type: 'egg', dims: { r: 1 } } as unknown as Part;
    expect(partSdf(unknown)([0, 0, 0])).toBe(Number.NEGATIVE_INFINITY);
    expect(partVolume(unknown)).toBe(0);
    expect(partWorldVertices(unknown)).toHaveLength(0);
  });

  it('a part with broken dims never throws and is never "inside"', () => {
    const cases: Part[] = [
      part('sphere', { r: 0 }),
      part('ellipsoid', { rx: 0, ry: 0, rz: 0 }),
      part('capsule', { r: 0, length: 0 }),
      part('lathe', { profile: [] }),
      part('lathe', { profile: [[1, 0]] }),
      part('flat', { shape: 'rect', w: 0, h: 0, thickness: 0 }),
      part('torus', { R: 0, r: 0, arcDeg: 0 }),
      part('box', { w: 0, h: 0, d: 0 }),
    ];
    for (const p of cases) {
      const v = partSdf(p)([0.3, 0.2, 0.1]);
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeLessThanOrEqual(0);
      expect(Number.isNaN(partVolume(p))).toBe(false);
    }
  });
});

describe('sdfNormal', () => {
  it('is the outward unit normal: minus the gradient', () => {
    const sphere = worldSdf(part('sphere', { r: 1 }, { position: [1, 2, 3] }));
    const n = sdfNormal(sphere, [1 + 0.6, 2, 3 + 0.8]);
    expect(n[0]).toBeCloseTo(0.6, 6);
    expect(n[1]).toBeCloseTo(0, 6);
    expect(n[2]).toBeCloseTo(0.8, 6);
    const box = worldSdf(part('box', { w: 2, h: 2, d: 2 }));
    expect(sdfNormal(box, [0.2, 1, -0.3])[1]).toBeCloseTo(1, 6);
    // an ellipsoid's normal is not radial
    const e = worldSdf(part('ellipsoid', { rx: 2, ry: 1, rz: 1 }));
    const p: Vec3 = [2 * Math.SQRT1_2, Math.SQRT1_2, 0];
    const expected = [p[0] / 4, p[1] / 1, 0];
    const len = Math.hypot(expected[0], expected[1]);
    const ne = sdfNormal(e, p);
    expect(ne[0]).toBeCloseTo(expected[0] / len, 4);
    expect(ne[1]).toBeCloseTo(expected[1] / len, 4);
    expect(sdfNormal(() => 1, [0, 0, 0])).toEqual([0, 1, 0]); // no gradient
  });
});

describe('overlapVolume (§3.7.6: regular grid over the intersection of the world boxes)', HEAVY, () => {
  const lens = (r1: number, r2: number, d: number): number =>
    (Math.PI * (r1 + r2 - d) ** 2 * (d * d + 2 * d * (r1 + r2) - 3 * (r1 - r2) ** 2)) / (12 * d);

  it('two spheres: the lens volume, within 3% (the grid spacing of §3.7.6)', () => {
    for (const [r1, r2, d] of [
      [1, 0.8, 1.5],
      [1, 1, 1],
      [2, 0.5, 2.2],
      [0.3, 0.25, 0.4],
    ]) {
      const a = part('sphere', { r: r1 }, { id: 'a' });
      const b = part('sphere', { r: r2 }, { id: 'b', position: [d * 0.6, d * 0.8, 0] });
      const v = overlapVolume(a, b);
      expect(Math.abs(v / lens(r1, r2, d) - 1)).toBeLessThan(0.03);
      expect(overlapVolume(b, a)).toBe(v); // the grid is the same either way
    }
  });

  it('boxes: exact up to the grid; containment gives the inner volume; disjoint parts give 0', () => {
    const a = part('box', { w: 2, h: 2, d: 2 }, { id: 'a' });
    const b = part('box', { w: 2, h: 2, d: 2 }, { id: 'b', position: [1.5, 1, 0.5] });
    expect(overlapVolume(a, b)).toBeCloseTo(0.5 * 1 * 1.5, 9);
    const small = part('sphere', { r: 0.2 }, { id: 's', position: [0.3, 0.3, 0.3] });
    expect(Math.abs(overlapVolume(a, small) / partVolume(small) - 1)).toBeLessThan(0.02);
    expect(overlapVolume(a, part('sphere', { r: 0.5 }, { position: [5, 0, 0] }))).toBe(0);
    // the boxes intersect but the solids do not
    expect(overlapVolume(part('sphere', { r: 1 }), part('sphere', { r: 1 }, { position: [1.3, 1.3, 1.3] }))).toBe(0);
    // touching boxes: a zero-thickness intersection
    expect(overlapVolume(a, part('box', { w: 2, h: 2, d: 2 }, { position: [2, 0, 0] }))).toBe(0);
  });

  it('is deterministic and bounded: a large intersection is sampled with at most 2 million cells', { ...PERF, retry: 2 }, () => {
    const a = part('box', { w: 40, h: 40, d: 40 }, { id: 'a' });
    const b = part('box', { w: 40, h: 40, d: 40 }, { id: 'b', position: [10, 0, 0] });
    const t0 = performance.now();
    const v = overlapVolume(a, b);
    expect(performance.now() - t0).toBeLessThan(budget(2000));
    expect(v).toBeCloseTo(30 * 40 * 40, 6);
    expect(overlapVolume(a, b)).toBe(v);
    expect(OVERLAP_MAX_SAMPLES).toBe(2_000_000);
    // a paper-thin intersection does not explode the grid
    const thin = part('box', { w: 40, h: 40, d: 40 }, { id: 'thin', position: [39.999999, 0, 0] });
    const t1 = performance.now();
    expect(overlapVolume(a, thin)).toBeCloseTo(1e-6 * 1600, 3);
    expect(performance.now() - t1).toBeLessThan(budget(2000));
  });

  it('row skipping changes nothing: the count is the one of the full grid, for every pair of part types', () => {
    const rng = mulberry32(108);
    const shapes = samplePrimitives();
    let overlapping = 0;
    for (let trial = 0; trial < 60; trial++) {
      const place = (p: Part, id: string): Part => ({
        ...p,
        id,
        position: [randomRange(rng, -0.8, 0.8), randomRange(rng, -0.8, 0.8), randomRange(rng, -0.8, 0.8)],
        rotationDeg: [randomRange(rng, -180, 180), randomRange(rng, -180, 180), randomRange(rng, -180, 180)],
      });
      const a = place(shapes[trial % shapes.length], 'a');
      const b = place(shapes[Math.floor(rng() * shapes.length)], 'b');
      const fast = overlapVolumeWith(a, b, { maxSamples: 60_000 });
      const full = overlapVolumeWith(a, b, { maxSamples: 60_000, skip: false });
      expect(fast, `${a.type} × ${b.type}`).toBe(full);
      if (full > 0) overlapping++;
    }
    expect(overlapping).toBeGreaterThan(30);
    // the default is the skipping grid with the default cap
    const a = part('ellipsoid', { rx: 2.1, ry: 2.6, rz: 1.9 }, { id: 'a' });
    const b = part('capsule', { r: 0.75, length: 3.1 }, { id: 'b', position: [1.15, -1.8, 1.25], rotationDeg: [82, 0, -12] });
    expect(overlapVolume(a, b)).toBe(overlapVolumeWith(a, b, { skip: false }));
    // fewer samples: a coarser estimate of the same volume
    expect(Math.abs(overlapVolumeWith(a, b, { maxSamples: 4000 }) / overlapVolume(a, b) - 1)).toBeLessThan(0.1);
    // a supplied mesh SDF is never used to skip: a function that lies about distances still gives the full count
    const blob = part('mesh', { meshRef: 'm', bboxIn: [2, 2, 2] }, { id: 'blob', position: [0.5, 0, 0] });
    const liar = (q: Vec3): number => (Math.hypot(q[0], q[1], q[2]) < 0.9 ? 1 : -1000);
    expect(overlapVolumeWith(a, blob, { meshSdf: { m: liar } })).toBe(overlapVolumeWith(a, blob, { meshSdf: { m: liar }, skip: false }));
  });

  it('never returns NaN, whatever the numbers', () => {
    const a = part('sphere', { r: 1 });
    expect(overlapVolume(a, part('sphere', { r: Number.NaN }))).toBe(0);
    expect(overlapVolume(a, part('sphere', { r: 1 }, { position: [Number.NaN, 0, 0] }))).toBe(0);
    // a dimension that is not a finite number counts as 0
    expect(overlapVolume(a, part('sphere', { r: Number.POSITIVE_INFINITY }))).toBe(0);
    expect(overlapVolume(part('sphere', { r: Number.POSITIVE_INFINITY }), part('box', { w: Number.POSITIVE_INFINITY, h: 1, d: 1 }))).toBe(0);
    expect(overlapVolume(a, { ...a, rotationDeg: [Number.NaN, 0, 0] })).toBe(0);
  });

  it('§3.7.3 golden: teddy overlap volumes ≈ head 0.07, legs 1.34, arms 0.64, tail 0.11 in³ (±15%); head–muzzle 1.43', () => {
    const teddy = buildCanonicalTeddy().model;
    const by = Object.fromEntries(teddy.parts.map((p) => [p.id, p]));
    const within = (actual: number, expected: number): void => expect(Math.abs(actual / expected - 1)).toBeLessThan(0.15);
    within(overlapVolume(by.head, by.body), 0.07);
    within(overlapVolume(by.leg_l, by.body), 1.34);
    within(overlapVolume(by.leg_r, by.body), 1.34);
    within(overlapVolume(by.arm_l, by.body), 0.64);
    within(overlapVolume(by.arm_r, by.body), 0.64);
    within(overlapVolume(by.tail, by.body), 0.11);
    expect(overlapVolume(by.muzzle, by.head)).toBeCloseTo(1.43, 2); // §3.7.6: larger than head–body
    expect(overlapVolume(by.leg_l, by.body)).toBe(overlapVolume(by.leg_r, by.body)); // mirror twins
    // §3.7.6: volumes — body 43.5 in³, the larger head 47.6 in³
    expect(partVolume(by.body)).toBeCloseTo(43.5, 1);
    expect(partVolume(by.head)).toBeCloseTo(47.6, 1);
  });

  it('uses the supplied SDF of a mesh part', () => {
    const a = part('sphere', { r: 1 }, { id: 'a' });
    const blob = part('mesh', { meshRef: 'm', bboxIn: [1, 1, 1] }, { id: 'blob', position: [0.9, 0, 0] });
    const asEllipsoid = overlapVolume(a, blob);
    const asBox = overlapVolume(a, blob, { meshSdf: { m: (q) => 0.5 - Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2])) } });
    expect(asBox).toBeGreaterThan(asEllipsoid * 1.3);
  });
});

describe('surfaceGap (§3.7.6: from the child’s builder vertices)', HEAVY, () => {
  it('is the distance between the surfaces when the parts are apart', () => {
    const body = part('sphere', { r: 1 }, { id: 'body' });
    const far = part('sphere', { r: 0.5 }, { id: 'far', position: [0, 2, 0] });
    expect(surfaceGap(far, body)).toBeCloseTo(0.5, 6); // a vertex sits exactly at the child's bottom pole
    const box = part('box', { w: 1, h: 1, d: 1 }, { id: 'box', position: [2.5, 0, 0] });
    expect(surfaceGap(box, part('box', { w: 2, h: 2, d: 2 }))).toBeCloseTo(1, 9);
  });

  it('is zero or negative when the child touches or enters the parent: minus the deepest vertex depth', () => {
    const body = part('sphere', { r: 1 }, { id: 'body' });
    expect(surfaceGap(part('sphere', { r: 0.5 }, { position: [0, 1.5, 0] }), body)).toBeCloseTo(0, 6);
    expect(surfaceGap(part('sphere', { r: 0.5 }, { position: [0, 1.3, 0] }), body)).toBeCloseTo(-0.2, 6);
    expect(surfaceGap(part('sphere', { r: 0.1 }, { position: [0, 0, 0] }), body)).toBeCloseTo(-1 + 0.1, 2);
  });

  it('a child that encloses its parent is no gap: then the parent’s vertices are probed against the child (no false W_GAP)', () => {
    // every vertex of the shell is outside the core, so the child's vertices alone would read +1.5 in
    const shell = part('sphere', { r: 2 }, { id: 'shell' });
    const core = part('sphere', { r: 0.5 }, { id: 'core' });
    expect(gapOfVertices(partWorldVertices(shell), worldSdf(core))).toBeCloseTo(1.5, 6);
    expect(surfaceGap(shell, core)).toBeCloseTo(-1.5, 6); // minus the deepest core vertex's depth in the shell
    expect(surfaceGap(core, shell)).toBeCloseTo(-1.5, 6);
    // off-center, still enclosed; and the reverse probe never turns a real gap into a contact
    expect(surfaceGap(shell, { ...core, position: [0.8, 0, 0] })).toBeLessThan(0);
    expect(surfaceGap(part('sphere', { r: 0.5 }, { position: [0, 2, 0] }), part('sphere', { r: 1 }))).toBeCloseTo(0.5, 6);
    expect(gapWithEnclosure(-0.2, () => Number.NaN)).toBe(-0.2);
    expect(gapWithEnclosure(0.3, () => 0.1)).toBe(0.3);
    expect(gapWithEnclosure(0.3, () => -0.4)).toBe(-0.4);
  });

  it('teddy: every part touches its parent (no W_GAP), and a part moved away reports its gap', () => {
    const teddy = buildCanonicalTeddy().model;
    const by = Object.fromEntries(teddy.parts.map((p) => [p.id, p]));
    for (const p of teddy.parts) {
      if (p.attach) expect(surfaceGap(p, by[p.attach.to]), p.id).toBeLessThanOrEqual(0);
    }
    const lifted = { ...by.tail, position: [0, by.tail.position[1], -3] as Vec3 };
    expect(surfaceGap(lifted, by.body)).toBeGreaterThan(0.25);
  });

  it('a mesh child is measured from the parent’s vertices against the child’s SDF', () => {
    const body = part('sphere', { r: 1 }, { id: 'body' });
    const blob = part('mesh', { meshRef: 'm', bboxIn: [1, 1, 1] }, { id: 'blob', position: [0, 2, 0] });
    const meshSdf = { m: (q: Vec3) => 0.5 - Math.hypot(q[0], q[1], q[2]) };
    expect(surfaceGapWith(blob, body, meshSdf)).toBeCloseTo(0.5, 6);
    expect(surfaceGapWith(body, blob, meshSdf)).toBeCloseTo(0.5, 6);
    expect(surfaceGap(blob, body)).toBeCloseTo(0.5, 2); // the inscribed ellipsoid of a unit box is the same sphere
  });

  it('gapOfVertices and gapProbe: the pieces inferAttach reuses across many pairs', () => {
    const body = worldSdf(part('sphere', { r: 1 }));
    expect(gapOfVertices([0, 3, 0, 2, 0, 0, 0, 0, -1.5], body)).toBe(0.5);
    expect(gapOfVertices([0, 0.5, 0], body)).toBe(-0.5);
    expect(gapOfVertices([], body)).toBe(Number.POSITIVE_INFINITY);
    const mesh = part('mesh', { meshRef: 'm', bboxIn: [1, 1, 1] });
    expect(gapProbe(part('sphere', { r: 1 }), part('box', { w: 1, h: 1, d: 1 }))).toBe('child');
    expect(gapProbe(mesh, part('sphere', { r: 1 }))).toBe('parent');
    expect(gapProbe(part('sphere', { r: 1 }), mesh)).toBe('child');
    expect(gapProbe(mesh, mesh)).toBe('child');
  });

  it('partWorldVertices are the builder vertices in model space', () => {
    const p = part('capsule', { r: 0.4, length: 2.2 }, { position: [1, 2, 3], rotationDeg: [82, 0, -12] });
    const v = partWorldVertices(p);
    const mesh = worldMesh(p);
    expect(v.length).toBe(mesh.positions.length);
    for (let i = 0; i < v.length; i += 97) expect(v[i]).toBeCloseTo(mesh.positions[i], 9);
    const b = worldBounds(p);
    for (let i = 0; i < v.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        expect(v[i + k]).toBeGreaterThanOrEqual(b.min[k] - 1e-6);
        expect(v[i + k]).toBeLessThanOrEqual(b.max[k] + 1e-6);
      }
    }
  });
});

describe('partVolume', HEAVY, () => {
  it('matches the volume of the builder mesh for every primitive (within the tessellation, the bevel for flat parts)', () => {
    for (const p of samplePrimitives()) {
      const mesh = Math.abs(meshVolume(localMesh(p)));
      // A polygon with n sides has (n/2π)·sin(2π/n) of its circle's area: 1.1% less for the 24 sides of a torus
      // tube. A flat part's volume is its outline × thickness; the builder's bevel adds up to a third more.
      const tolerance = p.type === 'flat' ? 0.35 : p.type === 'box' ? 1e-6 : 0.015;
      expect(Math.abs(partVolume(p) / mesh - 1), p.type).toBeLessThanOrEqual(tolerance);
    }
  });

  it('closed forms', () => {
    expect(partVolume(part('sphere', { r: 1 }))).toBeCloseTo((4 / 3) * Math.PI, 12);
    expect(partVolume(part('capsule', { r: 1, length: 4 }))).toBeCloseTo(Math.PI * 2 + (4 / 3) * Math.PI, 12);
    expect(partVolume(part('capsule', { r: 1, length: 1 }))).toBeCloseTo((4 / 3) * Math.PI, 12); // never less than its sphere
    expect(partVolume(part('cylinder', { rTop: 1, rBottom: 1, h: 2 }))).toBeCloseTo(2 * Math.PI, 12);
    expect(partVolume(part('cone', { r: 1, h: 3 }))).toBeCloseTo(Math.PI, 12);
    expect(partVolume(part('torus', { R: 2, r: 0.5 }))).toBeCloseTo(2 * Math.PI * Math.PI * 2 * 0.25, 12);
    expect(partVolume(part('torus', { R: 2, r: 0.5, arcDeg: 180 }))).toBeCloseTo(Math.PI * Math.PI * 2 * 0.25, 12);
    expect(partVolume(part('lathe', { profile: [[0, 0], [1, 0], [1, 2], [0, 2]] }))).toBeCloseTo(2 * Math.PI, 12);
    expect(partVolume(part('box', { w: 1, h: 2, d: 3 }))).toBe(6);
    expect(partVolume(part('flat', { shape: 'rect', w: 2, h: 1, thickness: 0.5 }))).toBeCloseTo(1, 9);
    expect(partVolume(part('mesh', { meshRef: 'm', bboxIn: [2, 2, 2] }))).toBeCloseTo((4 / 3) * Math.PI, 12);
  });

  it('every-type.json: every part has a positive, finite volume and a finite SDF at its center', () => {
    const model = readEveryType();
    const meshes = readEveryTypeMeshes();
    expect(Object.keys(meshes)).toHaveLength(1);
    for (const p of model.parts) {
      expect(partVolume(p), p.id).toBeGreaterThan(0);
      expect(Number.isFinite(partSdf(p)(p.position)), p.id).toBe(true);
    }
  });
});
