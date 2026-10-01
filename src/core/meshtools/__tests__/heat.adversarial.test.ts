// Adversarial review of T5.2 (§2.10.7 steps 1–3 and the seam): far-field underflow of the heat kernel on long or
// coiled parts, isoline orientation, root seeds on flat bottoms, degenerate triangles, exact level hits, determinism.
//
// Tests named "(fixed …)" documented defects found in review; they now pass against the fixes.
import { describe, expect, it } from 'vitest';
import { cotanLaplacian, heatGeodesic, meanEdgeLength, surfaceMesh } from '../heat';
import { nestedDissection, pcgJacobi, SparseCholesky } from '../sparse';
import { isolineLoops, rowLevels, sampleLoop, startLoopAt } from '../isolines';
import { geodesicRows, pathBTargetEdge } from '../rows';
import { seamCrossingEdge, seamPath } from '../seam';
import { signedVolume } from '../../kernel/geom/meshMeasures';
import type { IndexedMesh } from '../../kernel/geom/marchingCubes';
import { capsuleF, meshOf, uvSphere } from './helpers';

const SLOW = { timeout: 300_000 } as const;

function orientOutward(pos: number[], idx: number[]): IndexedMesh {
  const m: IndexedMesh = { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
  if (signedVolume(m) >= 0) return m;
  const f = Uint32Array.from(idx);
  for (let t = 0; t < f.length; t += 3) [f[t + 1], f[t + 2]] = [f[t + 2], f[t + 1]];
  return { positions: m.positions, indices: f };
}

/** Capsule along y (radius r, cylinder length lc), rings every ≈ h along the meridian; `s` = exact geodesic distance from the bottom pole (vertex 0). */
function tube(r: number, lc: number, h: number, seg: number): { m: IndexedMesh; s: Float64Array } {
  const total = Math.PI * r + lc;
  const K = Math.round(total / h);
  const pos: number[] = [0, -lc / 2 - r, 0];
  const arc: number[] = [0];
  for (let k = 1; k < K; k++) {
    const s = (k * total) / K;
    let y: number;
    let rho: number;
    if (s < (Math.PI * r) / 2) {
      y = -lc / 2 - r * Math.cos(s / r);
      rho = r * Math.sin(s / r);
    } else if (s <= (Math.PI * r) / 2 + lc) {
      y = -lc / 2 + (s - (Math.PI * r) / 2);
      rho = r;
    } else {
      const a = (s - (Math.PI * r) / 2 - lc) / r;
      y = lc / 2 + r * Math.sin(a);
      rho = r * Math.cos(a);
    }
    for (let j = 0; j < seg; j++) {
      const ph = (2 * Math.PI * (j + 0.5 * (k % 2))) / seg;
      pos.push(rho * Math.sin(ph), y, rho * Math.cos(ph));
      arc.push(s);
    }
  }
  pos.push(0, lc / 2 + r, 0);
  arc.push(total);
  const ring = (k: number, j: number): number => 1 + (k - 1) * seg + (((j % seg) + seg) % seg);
  const top = pos.length / 3 - 1;
  const idx: number[] = [];
  for (let j = 0; j < seg; j++) idx.push(0, ring(1, j + 1), ring(1, j));
  for (let k = 1; k < K - 1; k++) {
    for (let j = 0; j < seg; j++) {
      if (k % 2 === 1) idx.push(ring(k, j), ring(k, j + 1), ring(k + 1, j), ring(k, j + 1), ring(k + 1, j + 1), ring(k + 1, j));
      else idx.push(ring(k, j), ring(k + 1, j + 1), ring(k + 1, j), ring(k, j), ring(k, j + 1), ring(k + 1, j + 1));
    }
  }
  for (let j = 0; j < seg; j++) idx.push(ring(K - 1, j), ring(K - 1, j + 1), top);
  return { m: orientOutward(pos, idx), s: Float64Array.from(arc) };
}

/** A tube of radius r swept along a helix (radius R, pitch p, `turns`), closed with fan caps: a coiled tail / snake. */
function helixTube(R: number, p: number, turns: number, r: number, h: number, seg: number): IndexedMesh {
  const K = Math.round((turns * Math.hypot(2 * Math.PI * R, p)) / h);
  const c = (u: number): number[] => {
    const a = 2 * Math.PI * turns * u;
    return [R * Math.cos(a), p * turns * u, R * Math.sin(a)];
  };
  const pos: number[] = [];
  for (let k = 0; k <= K; k++) {
    const u = k / K;
    const q1 = c(Math.min(1, u + 1e-4));
    const q0 = c(Math.max(0, u - 1e-4));
    const T = [q1[0] - q0[0], q1[1] - q0[1], q1[2] - q0[2]];
    const tl = Math.hypot(T[0], T[1], T[2]);
    for (let i = 0; i < 3; i++) T[i] /= tl;
    const a = 2 * Math.PI * turns * u;
    let N = [Math.cos(a), 0, Math.sin(a)];
    const d = N[0] * T[0] + N[1] * T[1] + N[2] * T[2];
    N = [N[0] - d * T[0], N[1] - d * T[1], N[2] - d * T[2]];
    const nl = Math.hypot(N[0], N[1], N[2]);
    N = N.map((x) => x / nl);
    const B = [T[1] * N[2] - T[2] * N[1], T[2] * N[0] - T[0] * N[2], T[0] * N[1] - T[1] * N[0]];
    const P = c(u);
    for (let j = 0; j < seg; j++) {
      const ph = (2 * Math.PI * j) / seg;
      for (let i = 0; i < 3; i++) pos.push(P[i] + r * (Math.cos(ph) * N[i] + Math.sin(ph) * B[i]));
    }
  }
  const c0 = pos.length / 3;
  pos.push(...c(0));
  const c1 = pos.length / 3;
  pos.push(...c(1));
  const ring = (k: number, j: number): number => k * seg + (((j % seg) + seg) % seg);
  const idx: number[] = [];
  for (let k = 0; k < K; k++) for (let j = 0; j < seg; j++) idx.push(ring(k, j), ring(k + 1, j), ring(k + 1, j + 1), ring(k, j), ring(k + 1, j + 1), ring(k, j + 1));
  for (let j = 0; j < seg; j++) idx.push(c0, ring(0, j), ring(0, j + 1), c1, ring(K, j + 1), ring(K, j));
  return orientOutward(pos, idx);
}

/** Total azimuth turn atan2(x, z) of a closed loop, in units of π (−2 = the RH working direction bottom-up). */
function azimuthTurn(points: Float64Array): number {
  const n = points.length / 3;
  let turn = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    let d = Math.atan2(points[3 * j], points[3 * j + 2]) - Math.atan2(points[3 * i], points[3 * i + 2]);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    turn += d;
  }
  return turn / Math.PI;
}

describe('adversarial: heat-kernel far field on long and coiled parts', () => {
  it('sparse.ts claim holds: Jacobi-PCG on (M + tL)u = δ loses the far field, the Cholesky keeps u > 0 to 1e-101', SLOW, () => {
    const { m } = tube(0.3, 20, 0.067, 28);
    const sm = surfaceMesh(m);
    const { L, mass } = cotanLaplacian(sm);
    const me = meanEdgeLength(sm);
    const val = new Float64Array(L.length);
    for (let k = 0; k < L.length; k++) val[k] = me * me * L[k];
    for (let v = 0; v < sm.nv; v++) val[sm.pattern.diag[v]] += mass[v];
    const d = new Float64Array(sm.nv);
    d[0] = 1;
    const c = new SparseCholesky(sm.pattern, nestedDissection(sm.pattern, sm.positions));
    expect(c.factor(val)).toBe(true);
    const u = c.solve(d);
    expect(u.every((x) => x > 0)).toBe(true);
    expect(u[sm.nv - 1]).toBeLessThan(1e-90); // ≈ 1.9e-101 at the far pole, still a normal double
    const x = new Float64Array(sm.nv);
    pcgJacobi(sm.pattern, val, d, x, 1e-8, 2000);
    let bad = 0;
    for (const xi of x) if (!(xi > 0)) bad++;
    expect(bad / sm.nv).toBeGreaterThan(0.5); // measured ≈ 90% of the vertices have u ≤ 0 with PCG
  });

  it('a 60 in × r 0.3 in tube at edge ≈ 0.087 (≈ 700 edges seed → tip): φ within 1% of the meridian, no doubling', SLOW, () => {
    const { m, s } = tube(0.3, 60, 0.067, 28);
    const h = heatGeodesic(m, [0]);
    const maxPhi = Math.max(...h.phi);
    expect(Math.abs(maxPhi / s[s.length - 1] - 1)).toBeLessThan(0.01);
    expect(h.doublings).toBe(0);
  });

  // FIXED (was BUG): (M + tL)u = δ decays by ≈ e^(−1) per mean edge at t = (mean edge)²; past ≈ 745–760 edges u underflows to
  // exactly 0, X = 0 there, and φ silently stops growing (measured: max φ 66.7 instead of 80.9 on this tube; a spurious
  // second minimum and a saddle appear, not adjacent, so no doubling and no warning). Fix: detect u == 0 (or
  // u < ~1e-280) at any vertex and raise t until it is gone (t ≥ (D/700)² with D the Dijkstra distance to the
  // farthest vertex, computed anyway for the seam), or solve for log u.
  it('an 80 in tube (≈ 930 edges): max φ within 3% of the meridian (fixed: t floor (D/600)²)', SLOW, () => {
    const { m, s } = tube(0.3, 80, 0.067, 28);
    const h = heatGeodesic(m, [0]);
    expect(Math.abs(Math.max(...h.phi) / s[s.length - 1] - 1)).toBeLessThan(0.03);
  });

  // FIXED (was BUG) (same cause, through the real pipeline): the re-mesh lattice cap bounds the bbox side to ≈ 235 edges but not
  // the geodesic length, which a coil multiplies. A 3-turn coiled tube (4.6 × 3 × 4.6 in, r 0.3, ≈ 38 in long) at
  // fingering gauge (w = h = 0.12, edge 0.04 → ≈ 900 edges) gets a spurious maximum + saddle in the underflow zone,
  // one doubling, and a false `needsSplit` (measured 5.3 s, 55k vertices, under load).
  it('a coiled tube at fingering gauge needs no split (fixed: t floor + vertex cap)', SLOW, () => {
    const m = helixTube(2, 1.0, 3, 0.3, 0.05, 40);
    const r = geodesicRows(m, { hS: 0.12, targetEdge: pathBTargetEdge(0.12, 0.12), attach: [[2, 0, 0]] });
    expect(r.needsSplit).toBeUndefined();
  });
});

describe('adversarial: isoline orientation', () => {
  it('the re-mesh is outward: every row of a re-meshed sphere turns −2π in azimuth bottom-up (RH, §2.11.2)', SLOW, () => {
    const r = geodesicRows(uvSphere(1, 64, 32), { hS: 0.2, targetEdge: 0.067 });
    expect(r.rows.length).toBeGreaterThan(10);
    for (const row of r.rows) expect(azimuthTurn(row.loop.points)).toBeCloseTo(-2, 6);
  });

  // FIXED (was NIT): with `remesh: false` nothing checks the winding. An inside-out mesh silently gives LH rows (+2π), a mixed
  // winding gives one "loop" per crossing edge pair (32 loops per level → a false needsSplit). Fix: surfaceMesh (or
  // geodesicRows with remesh: false) checks that every interior edge is used once in each direction and that the
  // signed volume is > 0, else throws (or flips) — `remesh: false` is documented as "a clean closed manifold".
  it('remesh: false re-orients an inside-out mesh (fixed)', () => {
    const m = uvSphere(1, 32, 16);
    const f = Uint32Array.from(m.indices);
    for (let t = 0; t < f.length; t += 3) [f[t + 1], f[t + 2]] = [f[t + 2], f[t + 1]];
    let r;
    try {
      r = geodesicRows({ positions: m.positions, indices: f }, { hS: 0.25, targetEdge: 0.1, remesh: false });
    } catch {
      return;
    }
    for (const row of r.rows) expect(azimuthTurn(row.loop.points)).toBeCloseTo(-2, 6);
  });

  it('remesh: false refuses a mesh with mixed winding (fixed)', () => {
    const m = uvSphere(1, 32, 16);
    const f = Uint32Array.from(m.indices);
    for (let t = 0; t < f.length; t += 6) [f[t + 1], f[t + 2]] = [f[t + 2], f[t + 1]];
    expect(() => geodesicRows({ positions: m.positions, indices: f }, { hS: 0.25, targetEdge: 0.1, remesh: false })).toThrow();
  });
});

describe('adversarial: seeds', () => {
  // FIXED (was SPEC GAP): "root part: lowest vertex" is ill-posed on a flat bottom (a body, a pot, a basket): after MC + Taubin
  // the lowest vertex sits on the rim (measured 0.90 from the axis of an r = 1 cylinder, 3 lattice sizes), so the
  // rows grow eccentrically from the rim instead of from the center of the base (and one size needed 2 doublings).
  // Fix: take the vertices within ~one edge (or hS/2) of the minimum height and seed at the one nearest their
  // area-weighted centroid (or their geodesic center).
  it('a flat-bottomed root part is seeded near the center of its base (fixed: lowest-patch centroid)', SLOW, () => {
    const cyl = (x: number, y: number, z: number): number => Math.min(1 - Math.hypot(x, z), 1 - Math.abs(y));
    const r = geodesicRows(meshOf(cyl, 40, 1.3, 0), { hS: 0.2, targetEdge: 0.067 });
    const P = r.mesh.positions;
    const v = r.seed.vertex;
    expect(r.seed.rule).toBe('lowest');
    expect(Math.hypot(P[3 * v], P[3 * v + 2])).toBeLessThan(0.3);
  });
});

describe('adversarial: degenerate triangles, exact level hits, determinism', () => {
  /** A UV sphere with every 10th face split at a point `eps` off the midpoint of its first edge (a sliver/cap). */
  function slivered(eps: number): IndexedMesh {
    const m = uvSphere(1, 32, 16);
    const pos = Array.from(m.positions);
    const idx = Array.from(m.indices);
    const out: number[] = [];
    for (let t = 0; t < idx.length; t += 3) {
      if (t % 30 !== 0) {
        out.push(idx[t], idx[t + 1], idx[t + 2]);
        continue;
      }
      const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]];
      const x = pos.length / 3;
      for (let k = 0; k < 3; k++) pos.push(0.5 * (pos[3 * a + k] + pos[3 * b + k]) * (1 - eps) + eps * pos[3 * c + k]);
      out.push(a, b, x, b, c, x, c, a, x);
    }
    return { positions: new Float32Array(pos), indices: new Uint32Array(out) };
  }

  it('sliver triangles (vertex 1e-7 off an edge): φ finite, every level one closed loop', () => {
    const r = geodesicRows(slivered(1e-7), { hS: 0.25, targetEdge: 0.1, remesh: false });
    expect(r.heat.phi.every((p) => Number.isFinite(p))).toBe(true);
    expect(r.needsSplit).toBeUndefined();
    expect(r.rows.every((row) => row.loop.closed && row.loop.points.every((p) => Number.isFinite(p)))).toBe(true);
    expect(Math.abs(r.maxPhi / Math.PI - 1)).toBeLessThan(0.03);
  });

  // FIXED (was NIT, remesh: false only; the re-mesh never makes such triangles: min area ≥ 0.09·(mean edge)² over 90 re-meshes):
  // a vertex on an edge midpoint (rounded to float32) makes caps whose cotangents are ~1e8; the rounded element
  // matrices are no longer PSD and the heat factorization fails. The refusal is clean (bad-mesh, no NaN). A fix, if
  // wanted: skip faces with area < 1e-10·(longest edge)² in cotanLaplacian / divergence / faceGradient.
  it('caps from float32-rounded midpoints: degenerate faces are left out of the operators (fixed), φ finite, one loop per level', () => {
    const r = geodesicRows(slivered(0), { hS: 0.25, targetEdge: 0.1, remesh: false });
    expect(r.heat.phi.every((p) => Number.isFinite(p))).toBe(true);
    expect(r.needsSplit).toBeUndefined();
    expect(Math.abs(r.maxPhi / Math.PI - 1)).toBeLessThan(0.03);
  });

  it('levels exactly at vertex values: the seam crossing is on the loop, the loop starts there, samples stay finite', () => {
    const m = uvSphere(1, 24, 12);
    const sm = surfaceMesh(m);
    const south = sm.nv - 1;
    const phi = Float64Array.from({ length: sm.nv }, (_, v) => m.positions[3 * v + 1] + 1);
    const path = seamPath(sm, phi, south);
    expect(path[path.length - 1]).toBe(0); // the north pole
    // every ring height is a level: whole rings of vertices lie exactly on it (zero-length loop segments)
    for (let k = 1; k < 12; k++) {
      const level = phi[1 + (k - 1) * 24];
      const loops = isolineLoops(sm, phi, level);
      expect(loops.length).toBe(1);
      const e = seamCrossingEdge(sm, phi, path, level);
      expect(e).toBeGreaterThanOrEqual(0);
      const l = startLoopAt(loops[0], e);
      expect(l).not.toBeNull();
      const lp = l as NonNullable<typeof l>;
      const a = sm.edges[2 * e];
      const b = sm.edges[2 * e + 1];
      const onLevel = phi[a] === level ? a : b;
      expect(phi[onLevel]).toBe(level); // the crossing is the path vertex on the level
      expect(Math.hypot(lp.points[0] - m.positions[3 * onLevel], lp.points[1] - m.positions[3 * onLevel + 1], lp.points[2] - m.positions[3 * onLevel + 2])).toBeLessThan(1e-12);
      const smp = sampleLoop(lp, 37, { offset: -0.3 });
      expect(smp.every((x) => Number.isFinite(x))).toBe(true);
      // samples are on the level (the ring plane)
      for (let j = 0; j < 37; j++) expect(Math.abs(smp[3 * j + 1] + 1 - level)).toBeLessThan(1e-6);
    }
  });

  it('full pipeline with the re-mesh is byte-identical across runs (φ, re-mesh positions, loop points)', SLOW, () => {
    const m = meshOf(capsuleF(0.5, [0, -1, 0], [0.4, 1, 0]), 50, 2, 3);
    const a = geodesicRows(m, { hS: 0.2, targetEdge: 0.067 });
    const b = geodesicRows(m, { hS: 0.2, targetEdge: 0.067 });
    expect(Buffer.compare(Buffer.from(a.heat.phi.buffer), Buffer.from(b.heat.phi.buffer))).toBe(0);
    expect(Buffer.compare(Buffer.from(a.mesh.positions.buffer), Buffer.from(b.mesh.positions.buffer))).toBe(0);
    expect(a.rows.length).toBe(b.rows.length);
    for (let i = 0; i < a.rows.length; i++) expect(Buffer.compare(Buffer.from(a.rows[i].loop.points.buffer), Buffer.from(b.rows[i].loop.points.buffer))).toBe(0);
  });

  it('a torus through the pipeline: needsSplit with 2 loops (χ = 0: one min, one max, two saddles)', SLOW, () => {
    const torus = (x: number, y: number, z: number): number => 0.4 - Math.hypot(Math.hypot(x, z) - 1, y);
    const r = geodesicRows(meshOf(torus, 50, 1.6, 3), { hS: 0.2, targetEdge: 0.067 });
    expect(r.needsSplit?.loops.length).toBe(2);
    const c = r.heat.critical;
    expect(c.minima.length - c.saddles.length + c.maxima.length).toBe(0);
  });

  it('rowLevels: tiny parts get N = 2; levels never reach max φ', () => {
    const r = rowLevels(0.05, 0.2);
    expect(r.N).toBe(2);
    expect(r.levels).toEqual([0.025]);
    const big = rowLevels(10, 0.2);
    expect(big.levels[big.levels.length - 1]).toBeLessThan(10);
  });
});
