import { describe, expect, it } from 'vitest';
import { faceGradient, heatGeodesic, remeshForPathB, surfaceMesh } from '../heat';
import { isolineLoops, polylineLength, rowLevels, sampleLoop, startLoopAt, type IsolineLoop } from '../isolines';
import { geodesicRows, pathBTargetEdge } from '../rows';
import { argmaxVertex, dijkstra, dijkstraPath, seamCrossingEdge, seamPath } from '../seam';
import { capsuleF, HEAVY, meshOf, uvSphere, yShapeF } from './helpers';
import type { Implicit } from './helpers';

const W = 0.2;
const H = 0.2;
const torusF =
  (R: number, r: number): Implicit =>
  (x, y, z) =>
    r - Math.hypot(Math.hypot(x, z) - R, y);

describe('isolines by marching triangles (§2.10.7 step 3)', HEAVY, () => {
  it('height levels on a UV sphere: one closed loop of length 2π·r·sinθ, in the working direction', () => {
    const m = uvSphere(1, 96, 48);
    const sm = surfaceMesh(m);
    // φ = height + 1 (seed at the south pole, worked bottom-up)
    const phi = Float64Array.from({ length: sm.nv }, (_, v) => m.positions[3 * v + 1] + 1);
    for (const y of [-0.7, -0.2, 0.01, 0.55]) {
      const loops = isolineLoops(sm, phi, y + 1);
      expect(loops.length).toBe(1);
      const l = loops[0];
      expect(l.closed).toBe(true);
      expect(Math.abs(l.length / (2 * Math.PI * Math.sqrt(1 - y * y)) - 1)).toBeLessThan(0.01);
      expect(l.length).toBeCloseTo(polylineLength(l.points, true), 12);
      // every point on the level, on its edge
      for (let i = 0; i < l.edges.length; i++) expect(Math.abs(l.points[3 * i + 1] - y)).toBeLessThan(1e-6);
      // RH working direction bottom-up lowers the azimuth atan2(x, z) (§2.11.2): total turning −2π
      let turn = 0;
      const n = l.edges.length;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        let d = Math.atan2(l.points[3 * j], l.points[3 * j + 2]) - Math.atan2(l.points[3 * i], l.points[3 * i + 2]);
        if (d > Math.PI) d -= 2 * Math.PI;
        if (d < -Math.PI) d += 2 * Math.PI;
        turn += d;
      }
      expect(turn).toBeCloseTo(-2 * Math.PI, 6);
    }
    expect(isolineLoops(sm, phi, 5)).toEqual([]);
    expect(isolineLoops(sm, phi, -1)).toEqual([]);
    expect(() => isolineLoops(sm, phi, NaN)).toThrow(RangeError);
  });

  it('segments follow t = n × ∇φ on every face of a re-meshed blob', () => {
    const m = remeshForPathB(meshOf(capsuleF(0.5, [0, -0.8, 0], [0.3, 0.8, 0.2]), 40, 1.8, 3), 0.08).mesh;
    const sm = surfaceMesh(m);
    const phi = heatGeodesic(m, [7]).phi;
    const level = phi[argmaxVertex(phi)] * 0.45;
    const [loop] = isolineLoops(sm, phi, level);
    // for each consecutive pair, find the face holding both edges and compare with n × ∇φ there
    let checked = 0;
    const n = loop.edges.length;
    for (let i = 0; i < n; i++) {
      const e1 = loop.edges[i];
      const e2 = loop.edges[(i + 1) % n];
      const f = [sm.edgeFaces[2 * e1], sm.edgeFaces[2 * e1 + 1]].find((x) => x === sm.edgeFaces[2 * e2] || x === sm.edgeFaces[2 * e2 + 1]) as number;
      const P = sm.positions;
      const [a, b, c] = [sm.indices[3 * f], sm.indices[3 * f + 1], sm.indices[3 * f + 2]];
      const u = [P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]];
      const v = [P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]];
      const nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      const g = faceGradient(P, sm.indices, f, phi);
      const t = [nrm[1] * g[2] - nrm[2] * g[1], nrm[2] * g[0] - nrm[0] * g[2], nrm[0] * g[1] - nrm[1] * g[0]];
      const j = (i + 1) % n;
      const d = [loop.points[3 * j] - loop.points[3 * i], loop.points[3 * j + 1] - loop.points[3 * i + 1], loop.points[3 * j + 2] - loop.points[3 * i + 2]];
      const dot = d[0] * t[0] + d[1] * t[1] + d[2] * t[2];
      if (Math.hypot(d[0], d[1], d[2]) > 1e-9) {
        expect(dot).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(20);
  });

  it('a vertex exactly on the level is "above": loops stay closed and finite', () => {
    const m = uvSphere(1, 32, 16);
    const sm = surfaceMesh(m);
    const phi = Float64Array.from({ length: sm.nv }, (_, v) => m.positions[3 * v + 1]);
    const ringY = phi[1]; // a whole ring of vertices exactly on the level
    const loops = isolineLoops(sm, phi, ringY);
    expect(loops.length).toBe(1);
    expect(loops[0].closed).toBe(true);
    expect(loops[0].points.every((x) => Number.isFinite(x))).toBe(true);
    expect(Math.abs(loops[0].length / (2 * Math.PI * Math.sqrt(1 - ringY * ringY)) - 1)).toBeLessThan(0.01);
  });

  it('an open mesh gives open chains from boundary to boundary', () => {
    // the upper half of a UV sphere (an open bowl), φ = x
    const full = uvSphere(1, 32, 16);
    const keep: number[] = [];
    for (let t = 0; t < full.indices.length; t += 3) {
      const ys = [0, 1, 2].map((k) => full.positions[3 * full.indices[t + k] + 1]);
      if (ys.every((y) => y >= -1e-9)) keep.push(full.indices[t], full.indices[t + 1], full.indices[t + 2]);
    }
    const used = [...new Set(keep)].sort((a, b) => a - b);
    const remap = new Map(used.map((v, i) => [v, i]));
    const positions = new Float32Array(used.flatMap((v) => [full.positions[3 * v], full.positions[3 * v + 1], full.positions[3 * v + 2]]));
    const sm = surfaceMesh({ positions, indices: Uint32Array.from(keep.map((v) => remap.get(v) as number)) });
    expect(sm.boundaryEdges).toBeGreaterThan(0);
    const phi = Float64Array.from({ length: sm.nv }, (_, v) => positions[3 * v]);
    const loops = isolineLoops(sm, phi, 0.1);
    expect(loops.length).toBe(1);
    expect(loops[0].closed).toBe(false);
    expect(() => sampleLoop(loops[0], 4)).toThrow(/closed/);
  });

  it('a torus seeded on its outer equator: some level has two loops', () => {
    const m = remeshForPathB(meshOf(torusF(1, 0.4), 50, 1.6, 3), 0.08).mesh;
    const sm = surfaceMesh(m);
    let seed = 0;
    for (let v = 0; v < sm.nv; v++) if (m.positions[3 * v] > m.positions[3 * seed]) seed = v;
    const h = heatGeodesic(m, [seed]);
    expect(h.critical.saddles.length).toBe(2); // χ = 0: min − saddles + max = 0
    const max = h.phi[argmaxVertex(h.phi)];
    const counts = [0.3, 0.5, 0.7].map((f) => isolineLoops(sm, h.phi, f * max).length);
    expect(Math.max(...counts)).toBe(2);
  });
});

describe('row levels, loop sampling', () => {
  it('N = max(2, round(max φ / hS)), levels k·hEff for k = 1 … N − 1', () => {
    expect(rowLevels(4.5, 0.2)).toMatchObject({ N: 23 });
    const r = rowLevels(1, 0.25);
    expect(r.N).toBe(4);
    expect(r.hEff).toBe(0.25);
    expect(r.levels).toEqual([0.25, 0.5, 0.75]);
    expect(rowLevels(0.5, 0.4).N).toBe(2); // round(1.25) = 1 → 2
    expect(rowLevels(0.35, 0.2).N).toBe(2); // 1.75 → 2
    expect(rowLevels(0.7, 0.2).N).toBe(4); // 3.4999999999999996 on paper 3.5 → roundHalfUp 4
    expect(() => rowLevels(0, 0.2)).toThrow(RangeError);
    expect(() => rowLevels(1, -1)).toThrow(RangeError);
  });

  const square: IsolineLoop = {
    points: new Float64Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]),
    edges: new Int32Array([10, 11, 12, 13]),
    closed: true,
    length: 4,
  };

  it('sampleLoop: uniform by arc length from the first point, with phase and offset', () => {
    expect(Array.from(sampleLoop(square, 4, { phase: 0 }))).toEqual([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect(Array.from(sampleLoop(square, 4))).toEqual([0.5, 0, 0, 1, 0.5, 0, 0.5, 1, 0, 0, 0.5, 0]);
    // offset ¼ of the length moves every sample one side along
    expect(Array.from(sampleLoop(square, 4, { phase: 0, offset: 0.25 }))).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0]);
    // a negative offset wraps
    expect(Array.from(sampleLoop(square, 2, { phase: 0, offset: -0.25 }))).toEqual([0, 1, 0, 1, 0, 0]);
    // 8 samples at arc 0.25, 0.75, 1.25, … (stitch centers)
    expect(Array.from(sampleLoop(square, 8))).toEqual([0.25, 0, 0, 0.75, 0, 0, 1, 0.25, 0, 1, 0.75, 0, 0.75, 1, 0, 0.25, 1, 0, 0, 0.75, 0, 0, 0.25, 0]);
    expect(() => sampleLoop(square, 0)).toThrow(RangeError);
    expect(() => sampleLoop(square, 2.5)).toThrow(RangeError);
    expect(() => sampleLoop(square, 2, { offset: NaN })).toThrow(RangeError);
  });

  it('startLoopAt rotates a loop to the given edge', () => {
    const r = startLoopAt(square, 12) as IsolineLoop;
    expect(Array.from(r.edges)).toEqual([12, 13, 10, 11]);
    expect(Array.from(r.points.subarray(0, 3))).toEqual([1, 1, 0]);
    expect(r.length).toBe(4);
    expect(startLoopAt(square, 10)).toBe(square);
    expect(startLoopAt(square, 99)).toBeNull();
  });
});

describe('seam: Dijkstra edge path seed → argmax φ (§2.10.7 step 5)', HEAVY, () => {
  it('a shortest edge path; it crosses every level and the crossing edge is on that isoline', () => {
    const m = remeshForPathB(meshOf(capsuleF(0.5, [0, -1.5, 0], [0, 1.5, 0]), 60, 2.2, 3), pathBTargetEdge(W, H)).mesh;
    const sm = surfaceMesh(m);
    let seed = 0;
    for (let v = 0; v < sm.nv; v++) if (m.positions[3 * v + 1] < m.positions[3 * seed + 1]) seed = v;
    const phi = heatGeodesic(m, [seed]).phi;
    const path = seamPath(sm, phi, seed);
    expect(path[0]).toBe(seed);
    expect(path[path.length - 1]).toBe(argmaxVertex(phi));
    // consecutive vertices are adjacent; the length equals the Dijkstra distance
    const { dist } = dijkstra(sm, seed);
    let len = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i];
      const b = path[i + 1];
      expect(sm.pattern.col.subarray(sm.pattern.rowPtr[a], sm.pattern.rowPtr[a + 1])).toContain(b);
      len += Math.hypot(m.positions[3 * a] - m.positions[3 * b], m.positions[3 * a + 1] - m.positions[3 * b + 1], m.positions[3 * a + 2] - m.positions[3 * b + 2]);
    }
    expect(len).toBeCloseTo(dist[path[path.length - 1]], 9);
    // the graph distance is an upper bound of the geodesic one (within the heat method's error)
    expect(dist[path[path.length - 1]]).toBeGreaterThan(phi[path[path.length - 1]] * 0.98);
    for (const level of rowLevels(phi[argmaxVertex(phi)], H).levels) {
      const e = seamCrossingEdge(sm, phi, path, level);
      expect(e).toBeGreaterThanOrEqual(0);
      const [loop] = isolineLoops(sm, phi, level);
      expect(Array.from(loop.edges)).toContain(e);
    }
    expect(seamCrossingEdge(sm, phi, path, 1e9)).toBe(-1);
    expect(dijkstraPath(sm, seed, seed)).toEqual(Int32Array.from([seed]));
    expect(() => dijkstra(sm, -1)).toThrow(RangeError);
  });
});

describe('geodesicRows: re-mesh, heat, rows, seam (acceptance: capsule single loops, Y needsSplit)', HEAVY, () => {
  it('capsule (r 0.5, 4 in): every level is a single loop; cylinder rows ≈ 2πr; each row starts at the seam', () => {
    const cap = meshOf(capsuleF(0.5, [0, -1.5, 0], [0, 1.5, 0]), 60, 2.2, 3);
    const r = geodesicRows(cap, { hS: H, targetEdge: pathBTargetEdge(W, H) });
    expect(r.needsSplit).toBeUndefined();
    expect(r.loopCounts.every((c) => c === 1)).toBe(true);
    expect(r.seed.rule).toBe('lowest');
    expect(r.heat.doublings).toBe(0);
    // the capsule's meridian is π·r + 3 = 4.571; the re-mesh shrinks it slightly
    expect(Math.abs(r.maxPhi - (Math.PI * 0.5 + 3))).toBeLessThan(0.1);
    expect(r.N).toBe(Math.round(r.maxPhi / H));
    expect(r.rows.length).toBe(r.N - 1);
    for (const row of r.rows) {
      expect(row.loop.closed).toBe(true);
      expect(row.loop.edges[0]).toBe(row.seamEdge);
      expect(row.level).toBeCloseTo(row.k * r.hEff, 12);
      const y = row.loop.points[1];
      if (Math.abs(y) < 1.2) expect(Math.abs(row.loop.length / (2 * Math.PI * 0.5) - 1)).toBeLessThan(0.03);
    }
    // the seam points of consecutive rows are close (one seam line up the side)
    for (let i = 1; i < r.rows.length; i++) {
      const a = r.rows[i - 1].loop.points;
      const b = r.rows[i].loop.points;
      expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(2.5 * r.hEff);
    }
  });

  it('Y-shaped mesh: needsSplit with the level and the loop count', () => {
    const r = geodesicRows(meshOf(yShapeF(), 70, 2.3, 3), { hS: H, targetEdge: pathBTargetEdge(W, H) });
    expect(r.needsSplit).toBeDefined();
    const s = r.needsSplit as NonNullable<typeof r.needsSplit>;
    expect(s.loops.length).toBe(2);
    expect(r.rows).toEqual([]);
    expect(r.loopCounts[s.level - 1]).toBe(2);
    expect(r.loopCounts.slice(0, s.level - 1).every((c) => c === 1)).toBe(true);
    expect(s.value).toBeCloseTo(s.level * r.hEff, 12);
    // the two arms (r 0.35): loops ≈ 2π·0.35 each, centroids left and right of the stem
    for (const len of s.loops) expect(Math.abs(len / (2 * Math.PI * 0.35) - 1)).toBeLessThan(0.15);
    expect(s.centroids[0][0] * s.centroids[1][0]).toBeLessThan(0);
    // the split level lies just past the junction: stem length 1.6 + the bottom cap π·0.4/2
    expect(s.value).toBeGreaterThan(1.6);
    expect(s.value).toBeLessThan(1.6 + 0.63 + 0.9);
  });

  it('seeded from an arm tip, the Y still needs a split (the junction is a saddle)', () => {
    const r = geodesicRows(meshOf(yShapeF(), 70, 2.3, 3), { hS: H, targetEdge: pathBTargetEdge(W, H), seed: [-0.98, 1.4, 0] });
    expect(r.seed.rule).toBe('seed');
    expect(r.needsSplit?.loops.length).toBe(2);
  });

  it('remesh: false uses the mesh as given; deterministic output', () => {
    const m = uvSphere(1, 48, 24);
    const a = geodesicRows(m, { hS: 0.25, targetEdge: 0.1, remesh: false });
    const b = geodesicRows(m, { hS: 0.25, targetEdge: 0.1, remesh: false });
    expect(a.remesh).toBeUndefined();
    expect(a.sm.nv).toBe(m.positions.length / 3);
    expect(a.seed.vertex).toBe(m.positions.length / 3 - 1); // the south pole
    expect(a.N).toBe(Math.round(Math.PI / 0.25));
    expect(a.rows.map((r) => Array.from(r.loop.edges))).toEqual(b.rows.map((r) => Array.from(r.loop.edges)));
    expect(Buffer.compare(Buffer.from(a.heat.phi.buffer), Buffer.from(b.heat.phi.buffer))).toBe(0);
    expect(() => geodesicRows(m, { hS: 0, targetEdge: 0.1 })).toThrow(RangeError);
    expect(() => pathBTargetEdge(0, 1)).toThrow(RangeError);
    expect(pathBTargetEdge(0.21, 0.18)).toBeCloseTo(0.06, 12);
  });
});
