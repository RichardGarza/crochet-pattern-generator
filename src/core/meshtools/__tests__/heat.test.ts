import { describe, expect, it } from 'vitest';
import { countComponents, isWatertight, surfaceArea } from '../../kernel/geom/meshMeasures';
import {
  adjacentCriticalPairs,
  chooseSeed,
  cleanMesh,
  cotanLaplacian,
  criticalPoints,
  edgeId,
  heatGeodesic,
  HeatSolver,
  MAX_T_DOUBLINGS,
  remeshForPathB,
  surfaceMesh,
} from '../heat';
import { MeshToolError } from '../volume';
import { capsuleF, greatCircle, HEAVY, meshOf, noisySphere, uvSphere, yShapeF } from './helpers';
import type { IndexedMesh } from '../../kernel/geom/marchingCubes';

/** Mean of |φ − d|/d over every vertex but the seed, d = great-circle distance on the sphere of mean vertex radius. */
function sphereError(m: IndexedMesh, phi: Float64Array, seed: number): { meanRel: number; antipodeRel: number } {
  const P = m.positions;
  const n = P.length / 3;
  let R = 0;
  for (let v = 0; v < n; v++) R += Math.hypot(P[3 * v], P[3 * v + 1], P[3 * v + 2]) / n;
  const s = P.subarray(3 * seed, 3 * seed + 3);
  let sum = 0;
  let far = -1;
  let farD = -1;
  for (let v = 0; v < n; v++) {
    if (v === seed) continue;
    const d = greatCircle(R, s, P.subarray(3 * v, 3 * v + 3));
    sum += Math.abs(phi[v] - d) / d;
    if (d > farD) {
      farD = d;
      far = v;
    }
  }
  return { meanRel: sum / (n - 1), antipodeRel: Math.abs(phi[far] - farD) / farD };
}

function lowest(m: IndexedMesh): number {
  let best = 0;
  for (let v = 1; v < m.positions.length / 3; v++) if (m.positions[3 * v + 1] < m.positions[3 * best + 1]) best = v;
  return best;
}

describe('surface topology and operators', () => {
  it('a closed mesh: every edge has two faces, edge ids are consistent', () => {
    const m = uvSphere(1, 16, 8);
    const sm = surfaceMesh(m);
    expect(sm.boundaryEdges).toBe(0);
    expect(sm.edges.length / 2).toBe((3 * sm.nf) / 2);
    for (let f = 0; f < sm.nf; f++) {
      for (let e = 0; e < 3; e++) {
        const a = sm.indices[3 * f + e];
        const b = sm.indices[3 * f + ((e + 1) % 3)];
        const id = sm.faceEdges[3 * f + e];
        expect(edgeId(sm, a, b)).toBe(id);
        expect(edgeId(sm, b, a)).toBe(id);
        expect([sm.edgeFaces[2 * id], sm.edgeFaces[2 * id + 1]]).toContain(f);
      }
    }
    expect(edgeId(sm, 0, sm.nv - 1)).toBe(-1); // the poles are not adjacent
  });

  it('refuses unusable meshes', () => {
    const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]), indices: new Uint32Array([0, 1, 2]) };
    expect(() => surfaceMesh(tri)).toThrow(/not used/);
    expect(() => surfaceMesh({ positions: new Float32Array(9), indices: new Uint32Array([0, 1, 1]) })).toThrow(/repeats/);
    expect(() => surfaceMesh({ positions: new Float32Array(9), indices: new Uint32Array([0, 1, 3]) })).toThrow(/out of range/);
    expect(() => surfaceMesh({ positions: new Float32Array([NaN, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) })).toThrow(/non-finite/);
    expect(() => surfaceMesh({ positions: new Float32Array(0), indices: new Uint32Array(0) })).toThrow(/empty/);
    // three triangles on one edge
    const fan = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 1]), indices: new Uint32Array([0, 1, 2, 1, 0, 3, 0, 1, 4]) };
    expect(() => surfaceMesh(fan)).toThrow(/non-manifold/);
  });

  it('cleanMesh keeps the largest component, drops degenerate triangles and unused vertices', () => {
    const big = uvSphere(1, 12, 6);
    const small = uvSphere(0.2, 6, 4, [3, 0, 0]);
    const nb = big.positions.length / 3;
    const pos = new Float32Array([...small.positions, ...big.positions, 9, 9, 9]);
    const idx = new Uint32Array([...small.indices, ...Array.from(big.indices, (i) => i + small.positions.length / 3), 0, 0, 1]);
    const c = cleanMesh({ positions: pos, indices: idx });
    expect(c.components).toBe(2);
    expect(c.mesh.positions.length / 3).toBe(nb);
    expect(c.mesh.indices.length).toBe(big.indices.length);
    expect(Math.abs(surfaceArea(c.mesh) - surfaceArea(big))).toBeLessThan(1e-5);
    expect(() => surfaceMesh(c.mesh)).not.toThrow();
  });

  it('cotan Laplacian: symmetric, rows sum to 0, PSD on a test vector; mass sums to the area', () => {
    const m = uvSphere(1.3, 24, 12);
    const sm = surfaceMesh(m);
    const { L, mass } = cotanLaplacian(sm);
    const { rowPtr, col } = sm.pattern;
    for (let i = 0; i < sm.nv; i++) {
      let s = 0;
      for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) {
        s += L[k];
        const j = col[k];
        let back = NaN;
        for (let q = rowPtr[j]; q < rowPtr[j + 1]; q++) if (col[q] === i) back = L[q];
        expect(Math.abs(back - L[k])).toBeLessThan(1e-12);
      }
      expect(Math.abs(s)).toBeLessThan(1e-9);
    }
    let area = 0;
    for (const a of mass) area += a;
    expect(Math.abs(area - surfaceArea(m))).toBeLessThan(1e-6);
    // xᵀLx = ½ Σ w_ij (x_i − x_j)² ≥ 0 for x = the height
    let q = 0;
    for (let i = 0; i < sm.nv; i++) for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) q += sm.positions[3 * i + 1] * L[k] * sm.positions[3 * col[k] + 1];
    expect(q).toBeGreaterThan(0);
  });
});

describe('heat-method geodesic distance (§2.10.7 step 2; acceptance: sphere within 3% mean)', HEAVY, () => {
  it('re-meshed sphere at worsted size (r = 2 in, edge 0.067 in): mean error < 3%, far field included', () => {
    const rm = remeshForPathB(uvSphere(2, 96, 48), 0.2 / 3);
    const seed = lowest(rm.mesh);
    const h = heatGeodesic(rm.mesh, [seed], { maxDoublings: 0 });
    const e = sphereError(rm.mesh, h.phi, seed);
    expect(e.meanRel).toBeLessThan(0.03); // measured 0.94%
    expect(e.antipodeRel).toBeLessThan(0.03);
    expect(h.phi[seed]).toBe(0);
    expect(h.critical.minima).toEqual([seed]);
    expect(h.critical.maxima.length).toBe(1);
    expect(h.critical.saddles.length).toBe(0);
  });

  it('sphere meshes of other sizes and kinds stay within 3% (coarse re-mesh, UV sphere, seed off the pole)', () => {
    const coarse = remeshForPathB(uvSphere(1, 64, 32), 0.1);
    const s1 = lowest(coarse.mesh);
    expect(sphereError(coarse.mesh, heatGeodesic(coarse.mesh, [s1]).phi, s1).meanRel).toBeLessThan(0.03); // 1.8%
    const uv = uvSphere(1, 64, 32);
    // a seed on the equator (vertex of ring 16)
    const s2 = 1 + 15 * 64 + 5;
    expect(Math.abs(uv.positions[3 * s2 + 1])).toBeLessThan(1e-6);
    expect(sphereError(uv, heatGeodesic(uv, [s2]).phi, s2).meanRel).toBeLessThan(0.03);
  });

  it('several sources: φ is the distance to the nearest one', () => {
    const uv = uvSphere(1, 48, 24);
    const north = 0;
    const south = uv.positions.length / 3 - 1;
    const h = heatGeodesic(uv, [north, south], { maxDoublings: 0 });
    // the equator is π/2 from both poles
    let worst = 0;
    for (let v = 0; v < uv.positions.length / 3; v++) {
      const y = uv.positions[3 * v + 1];
      const d = Math.acos(Math.min(1, Math.abs(y)));
      worst = Math.max(worst, Math.abs(h.phi[v] - d));
    }
    expect(worst).toBeLessThan(0.08);
    expect(Math.min(h.phi[north], h.phi[south])).toBe(0);
  });

  it('deterministic: byte-identical φ on repeated runs', () => {
    const m = meshOf(capsuleF(0.5, [0, -1, 0], [0, 1, 0]), 40, 1.8, 3);
    const a = heatGeodesic(m, [3]);
    const b = heatGeodesic(m, [3]);
    expect(Buffer.compare(Buffer.from(a.phi.buffer), Buffer.from(b.phi.buffer))).toBe(0);
    expect(a.t).toBe(b.t);
  });

  it('refuses bad sources', () => {
    const s = new HeatSolver(surfaceMesh(uvSphere(1, 8, 4)));
    expect(() => s.solveAt([], 1)).toThrow(/no source/);
    expect(() => s.solveAt([999], 1)).toThrow(/out of range/);
    expect(() => s.solveAt([0.5], 1)).toThrow(/out of range/);
  });
});

describe('critical points and t doubling (poor meshes)', HEAVY, () => {
  it('a Y has one minimum, one saddle and two maxima (min − saddle + max = 2)', () => {
    const m = remeshForPathB(meshOf(yShapeF(), 60, 2.3, 3), 0.2 / 3).mesh;
    const h = heatGeodesic(m, [lowest(m)]);
    const c = h.critical;
    expect(c.minima.length).toBe(1);
    expect(c.saddles.length).toBe(1);
    expect(c.maxima.length).toBe(2);
    expect(h.doublings).toBe(0);
    // the saddle sits at the junction
    const s = c.saddles[0];
    expect(Math.hypot(m.positions[3 * s], m.positions[3 * s + 1] - 0.3, m.positions[3 * s + 2])).toBeLessThan(0.5);
  });

  it('a noisy sphere with adjacent critical points at the base t: t doubles until they are gone', () => {
    // radial noise ±7.5% on a 40×20 UV sphere (no re-mesh): spurious saddle–maximum pairs near the far pole
    let found = 0;
    for (let seed = 1; seed <= 12 && found < 2; seed++) {
      const m = noisySphere(0.15, seed);
      const sm = surfaceMesh(m);
      const solver = new HeatSolver(sm);
      const src = [lowest(m)];
      const base = solver.geodesic(src, { maxDoublings: 0 });
      if (base.adjacent.length === 0) continue;
      const r = solver.geodesic(src);
      if (r.adjacent.length > 0) continue; // the cap ran out (covered below)
      found++;
      expect(r.doublings).toBeGreaterThan(0);
      expect(r.doublings).toBeLessThanOrEqual(MAX_T_DOUBLINGS);
      expect(r.t).toBeCloseTo(base.t * 2 ** r.doublings, 12);
      expect(r.critical.saddles.length).toBe(0);
      expect(r.critical.maxima.length).toBe(1);
      // one fewer doubling still had adjacent points (the loop stops at the first clean t)
      const before = solver.geodesic(src, { maxDoublings: r.doublings - 1 });
      expect(before.adjacent.length).toBeGreaterThan(0);
    }
    expect(found).toBe(2);
  });

  it('when 6 doublings do not suffice the last φ is returned with the pairs that remain', () => {
    let capped = 0;
    for (let seed = 1; seed <= 8 && capped === 0; seed++) {
      const m = noisySphere(0.3, seed);
      const r = heatGeodesic(m, [lowest(m)]);
      if (r.adjacent.length === 0) continue;
      capped++;
      expect(r.doublings).toBe(MAX_T_DOUBLINGS);
      for (const [a, b] of r.adjacent) {
        expect(r.critical.kind[a]).not.toBe(0);
        expect(r.critical.kind[b]).not.toBe(0);
      }
    }
    expect(capped).toBe(1);
  });

  it('the re-mesh step removes the noise: the same poor mesh needs no doubling once re-meshed', () => {
    const m = noisySphere(0.15, 2, 60, 30);
    const rm = remeshForPathB(m, 0.06);
    const r = heatGeodesic(rm.mesh, [lowest(rm.mesh)]);
    expect(r.doublings).toBe(0);
    expect(r.critical.saddles.length).toBe(0);
  });

  it('adjacency: two critical points two edges apart are a pair, three edges apart are not', () => {
    const m = uvSphere(1, 24, 12);
    const sm = surfaceMesh(m);
    const kind = new Int8Array(sm.nv);
    // vertices on one ring: ring k, segment s → 1 + (k − 1)·24 + s
    const v = (k: number, s: number): number => 1 + (k - 1) * 24 + s;
    kind[v(6, 0)] = 1;
    kind[v(6, 2)] = 2;
    kind[v(6, 10)] = 1;
    kind[v(6, 13)] = -1;
    const crit = { kind, minima: [v(6, 13)], maxima: [v(6, 0), v(6, 10)], saddles: [v(6, 2)] };
    expect(adjacentCriticalPairs(sm, crit)).toEqual([[v(6, 0), v(6, 2)]]);
    expect(criticalPoints(sm, Float64Array.from({ length: sm.nv }, (_, i) => m.positions[3 * i + 1])).minima).toEqual([sm.nv - 1]);
  });
});

describe('re-mesh (§2.10.7 step 1) and seed', HEAVY, () => {
  it('edge ≈ the target, closed, one component', () => {
    for (const [r, target] of [
      [1, 0.1],
      [2, 0.2 / 3],
      [1.5, 0.05],
    ] as const) {
      const rm = remeshForPathB(uvSphere(r, 64, 32), target);
      expect(rm.meanEdge / target).toBeGreaterThan(0.85);
      expect(rm.meanEdge / target).toBeLessThan(1.15);
      expect(isWatertight(rm.mesh.indices)).toBe(true);
      expect(countComponents(rm.mesh.indices)).toBe(1);
      expect(rm.coarsened).toBe(false);
    }
  });

  it('coarsens to the lattice cap; refuses a target ≤ 0 and an empty inside', () => {
    const long = uvSphere(1, 32, 16);
    for (let v = 0; v < long.positions.length / 3; v++) long.positions[3 * v + 1] *= 20; // 2 × 40 × 2 in
    const rm = remeshForPathB(long, 0.1);
    expect(rm.coarsened).toBe(true);
    expect(rm.N).toBe(256);
    expect(rm.meanEdge).toBeGreaterThan(0.12);
    expect(() => remeshForPathB(uvSphere(1, 8, 4), 0)).toThrow(RangeError);
    const flat = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    expect(() => remeshForPathB(flat, 0.1)).toThrow(MeshToolError);
  });

  it('seed: crochet.seed → nearest vertex; attach → the farthest tip; root → the lowest vertex', () => {
    const m = remeshForPathB(meshOf(capsuleF(0.4, [0, -1, 0], [0, 1, 0]), 40, 1.7, 3), 0.08).mesh;
    const solver = new HeatSolver(surfaceMesh(m));
    const P = m.positions;
    const byUser = chooseSeed(solver, { seed: [0.4, 0.2, 0] });
    expect(byUser.rule).toBe('seed');
    expect(Math.hypot(P[3 * byUser.vertex] - 0.4, P[3 * byUser.vertex + 1] - 0.2, P[3 * byUser.vertex + 2])).toBeLessThan(0.1);
    const far = chooseSeed(solver, { attach: [[0, -1.4, 0]] });
    expect(far.rule).toBe('farthest-from-attach');
    expect(P[3 * far.vertex + 1]).toBeGreaterThan(1.3); // the top tip
    const root = chooseSeed(solver, {});
    expect(root.rule).toBe('lowest');
    expect(P[3 * root.vertex + 1]).toBeLessThan(-1.35);
    const sideways = chooseSeed(solver, { up: [1, 0, 0] });
    expect(P[3 * sideways.vertex]).toBeLessThan(-0.35);
    expect(() => chooseSeed(solver, { up: [0, 0, 0] })).toThrow(RangeError);
  });
});

describe('review fixes: Poisson solvers, option checks, vertex cap, far-field floor', HEAVY, () => {
  it('the direct (pinned) and PCG Poisson solves agree; PCG is the §2.10.7 wording', () => {
    const rm = remeshForPathB(uvSphere(1.5, 64, 32), 0.08);
    const seed = lowest(rm.mesh);
    const s = new HeatSolver(surfaceMesh(rm.mesh));
    const d = s.geodesic([seed], { maxDoublings: 0 });
    const p = s.geodesic([seed], { maxDoublings: 0, poisson: 'pcg' });
    expect(d.poisson.direct).toBe(true);
    expect(d.pcgIterations).toBe(0);
    expect(d.poisson.relResidual).toBeLessThan(1e-10);
    expect(p.pcgIterations).toBeGreaterThan(0);
    let worst = 0;
    for (let v = 0; v < d.phi.length; v++) worst = Math.max(worst, Math.abs(d.phi[v] - p.phi[v]));
    expect(worst).toBeLessThan(1e-5);
  });

  it('refuses bad heat options', () => {
    const s = new HeatSolver(surfaceMesh(uvSphere(1, 12, 6)));
    expect(() => s.geodesic([0], { maxDoublings: NaN })).toThrow(RangeError);
    expect(() => s.geodesic([0], { maxDoublings: -1 })).toThrow(RangeError);
    expect(() => s.geodesic([0], { maxDoublings: 2.5 })).toThrow(RangeError);
    expect(() => s.geodesic([0], { tScale: 0 })).toThrow(RangeError);
    expect(() => s.geodesic([0], { tScale: NaN })).toThrow(RangeError);
    expect(() => s.geodesic([0], { poisson: 'lu' as 'pcg' })).toThrow(RangeError);
    expect(() => s.solveAt([0], 0)).toThrow(RangeError);
  });

  it('a disconnected surface is refused (no geodesic between components)', () => {
    const a = uvSphere(1, 12, 6);
    const b = uvSphere(1, 12, 6, [5, 0, 0]);
    const n = a.positions.length / 3;
    const m = { positions: new Float32Array([...a.positions, ...b.positions]), indices: new Uint32Array([...a.indices, ...Array.from(b.indices, (i) => i + n)]) };
    expect(() => heatGeodesic(m, [0])).toThrow(MeshToolError);
  });

  it('the far-field floor raises t only on parts longer than 600·√t', () => {
    const short = heatGeodesic(uvSphere(1, 32, 16), [0]);
    expect(short.tFloored).toBe(false);
    expect(short.t0).toBeCloseTo(short.meanEdge ** 2, 12);
    // a 1 × 40 × 1 ellipsoid with ≈ 0.02 edges along its length: ≈ 3000 edges pole to pole
    const long = uvSphere(1, 24, 2000);
    for (let v = 0; v < long.positions.length / 3; v++) {
      long.positions[3 * v] *= 0.5;
      long.positions[3 * v + 2] *= 0.5;
      long.positions[3 * v + 1] *= 20;
    }
    const h = heatGeodesic(long, [0], { maxDoublings: 0 });
    expect(h.tFloored).toBe(true);
    let max = 0;
    for (const p of h.phi) max = Math.max(max, p);
    expect(Math.abs(max / 40 - 1)).toBeLessThan(0.03); // pole to pole ≈ 40 in (the ellipse meridian is a hair longer)
  });

  it('the re-mesh keeps the vertex count under the cap by coarsening the edge', () => {
    const rm = remeshForPathB(uvSphere(3, 96, 48), 0.04, { maxVertices: 20_000 });
    expect(rm.coarsened).toBe(true);
    expect(rm.mesh.positions.length / 3).toBeLessThan(25_000);
    expect(rm.meanEdge).toBeGreaterThan(0.04);
    expect(() => remeshForPathB(uvSphere(1, 8, 4), 0.1, { maxVertices: 5 })).toThrow(RangeError);
  });

  it('a flat-bottomed root part seeds at the center of its base; a round bottom at its lowest point', () => {
    const cyl = (x: number, y: number, z: number): number => Math.min(1 - Math.hypot(x, z), 1 - Math.abs(y));
    const m = remeshForPathB(meshOf(cyl, 40, 1.3, 0), 0.067).mesh;
    const s = chooseSeed(new HeatSolver(surfaceMesh(m)));
    expect(Math.hypot(m.positions[3 * s.vertex], m.positions[3 * s.vertex + 2])).toBeLessThan(0.1);
    const ball = remeshForPathB(uvSphere(1, 64, 32), 0.067).mesh;
    const b = chooseSeed(new HeatSolver(surfaceMesh(ball)));
    expect(ball.positions[3 * b.vertex + 1]).toBeLessThan(-0.99);
  });
});
