// Track T5 — Path B step 3 (DESIGN.md §2.10.7; research 03 §6.2): isolines of the geodesic distance φ by marching
// triangles, as oriented loops in the RH working direction t = n × ∇φ, and the row levels k·hEff.
//
// A vertex is "above" a level c when φ ≥ c (so a vertex exactly on the level is above: every crossing edge has one
// endpoint strictly below and the crossing parameter is well defined). In a face with one odd vertex o (the one
// whose side differs), the segment joins the edge (prev, o) and the edge (o, next) (CCW order seen from outside):
// prev→o … o→next when o is above, the reverse when o is below. That keeps the larger φ on the right of the walking
// direction seen from outside, i.e. the walk follows t = n × ∇φ (the RH working direction of §2.10.7 step 5: for a
// piece worked bottom-up it lowers the azimuth atan2(x, z), as §2.11.2 requires). On an oriented closed manifold
// each crossing edge starts one segment and ends one, so the segments link into closed loops.
import { roundHalfUp } from '../gauge/round';
import type { SurfaceMesh } from './heat';

export interface IsolineLoop {
  /** Crossing points [x, y, z, …] in the working direction; for a closed loop the last joins the first. */
  points: Float64Array;
  /** The mesh edge each point lies on. */
  edges: Int32Array;
  /** False only for a chain ending on a mesh boundary (never on a Path B re-mesh). */
  closed: boolean;
  /** Polyline length (closed loops include the closing segment). */
  length: number;
}

/** True when vertex v is on the upper side of level c. */
function above(phi: ArrayLike<number>, v: number, c: number): boolean {
  return phi[v] >= c;
}

/** Crossing point of `level` on edge e (requires a crossing edge). */
export function edgeCrossing(sm: SurfaceMesh, phi: ArrayLike<number>, e: number, level: number): [number, number, number] {
  const a = sm.edges[2 * e];
  const b = sm.edges[2 * e + 1];
  const P = sm.positions;
  const s = (level - phi[a]) / (phi[b] - phi[a]);
  return [P[3 * a] + s * (P[3 * b] - P[3 * a]), P[3 * a + 1] + s * (P[3 * b + 1] - P[3 * a + 1]), P[3 * a + 2] + s * (P[3 * b + 2] - P[3 * a + 2])];
}

/**
 * The isoline φ = level as loops (marching triangles). Loops are ordered by their smallest edge id and each starts
 * at that edge (chains on a boundary start at their free end), so the output depends only on the mesh and φ.
 */
export function isolineLoops(sm: SurfaceMesh, phi: ArrayLike<number>, level: number): IsolineLoop[] {
  if (!Number.isFinite(level)) throw new RangeError(`bad level ${level}`);
  if (sm.misorientedEdges > 0) throw new RangeError('isolines need a consistently oriented mesh');
  const I = sm.indices;
  const ne = sm.edges.length / 2;
  const next = new Int32Array(ne).fill(-1); // edge → the edge its segment leads to
  const hasIn = new Uint8Array(ne);
  let any = false;
  for (let f = 0; f < sm.nf; f++) {
    const v0 = I[3 * f];
    const v1 = I[3 * f + 1];
    const v2 = I[3 * f + 2];
    const a0 = above(phi, v0, level);
    const a1 = above(phi, v1, level);
    const a2 = above(phi, v2, level);
    if (a0 === a1 && a1 === a2) continue;
    // odd vertex position k: the one differing from the other two
    const k = a1 === a2 ? 0 : a0 === a2 ? 1 : 2;
    const odd = [a0, a1, a2][k];
    const eIn = sm.faceEdges[3 * f + ((k + 2) % 3)]; // edge (prev, o)
    const eOut = sm.faceEdges[3 * f + k]; // edge (o, next)
    const [from, to] = odd ? [eIn, eOut] : [eOut, eIn];
    next[from] = to;
    hasIn[to] = 1;
    any = true;
  }
  if (!any) return [];
  const visited = new Uint8Array(ne);
  const loops: IsolineLoop[] = [];
  const trace = (start: number): void => {
    const pts: number[] = [];
    const es: number[] = [];
    let e = start;
    let closed = false;
    for (;;) {
      visited[e] = 1;
      es.push(e);
      const p = edgeCrossing(sm, phi, e, level);
      pts.push(p[0], p[1], p[2]);
      const n = next[e];
      if (n < 0) break;
      if (n === start) {
        closed = true;
        break;
      }
      if (visited[n]) break; // cannot happen on a manifold; guards a malformed input
      e = n;
    }
    const points = Float64Array.from(pts);
    loops.push({ points, edges: Int32Array.from(es), closed, length: polylineLength(points, closed) });
  };
  // Open chains first (boundary only), from their free ends; then closed loops from their smallest edge.
  for (let e = 0; e < ne; e++) if (next[e] >= 0 && !hasIn[e] && !visited[e]) trace(e);
  for (let e = 0; e < ne; e++) if (next[e] >= 0 && !visited[e]) trace(e);
  // A chain ending on the boundary has an edge with an incoming segment and no outgoing one; it was appended to its
  // chain already. Order loops by smallest edge id.
  const key = (l: IsolineLoop): number => {
    let m = Infinity;
    for (const e of l.edges) m = Math.min(m, e);
    return m;
  };
  return loops.sort((a, b) => key(a) - key(b));
}

/** Length of a polyline [x, y, z, …] (closed adds the last → first segment). */
export function polylineLength(points: ArrayLike<number>, closed: boolean): number {
  const n = points.length / 3;
  let s = 0;
  for (let i = 0; i + 1 < n; i++) s += Math.hypot(points[3 * i + 3] - points[3 * i], points[3 * i + 4] - points[3 * i + 1], points[3 * i + 5] - points[3 * i + 2]);
  if (closed && n > 1) s += Math.hypot(points[0] - points[3 * n - 3], points[1] - points[3 * n - 2], points[2] - points[3 * n - 1]);
  return s;
}

export interface RowLevels {
  /** Row pitches over the length: N = max(2, round(max φ / hS)) (§2.10.7 step 3, roundHalfUp). */
  N: number;
  hEff: number;
  /** k·hEff for k = 1 … N − 1 (a closed piece: the last pitch ends in the gather at max φ). */
  levels: number[];
}

/** The row levels of §2.10.7 step 3. */
export function rowLevels(maxPhi: number, hS: number): RowLevels {
  if (!(maxPhi > 0) || !Number.isFinite(maxPhi)) throw new RangeError(`max φ must be > 0, got ${maxPhi}`);
  if (!(hS > 0) || !Number.isFinite(hS)) throw new RangeError(`hS must be > 0, got ${hS}`);
  const N = Math.max(2, roundHalfUp(maxPhi / hS));
  const hEff = maxPhi / N;
  const levels: number[] = [];
  for (let k = 1; k < N; k++) levels.push(k * hEff);
  return { N, hEff, levels };
}

/** Rotates a closed loop so that it starts at the point on edge `e`; null when the loop does not cross e. */
export function startLoopAt(loop: IsolineLoop, e: number): IsolineLoop | null {
  const i = loop.edges.indexOf(e);
  if (i < 0) return null;
  if (i === 0 || !loop.closed) return i === 0 ? loop : null;
  const n = loop.edges.length;
  const edges = new Int32Array(n);
  const points = new Float64Array(3 * n);
  for (let k = 0; k < n; k++) {
    const j = (i + k) % n;
    edges[k] = loop.edges[j];
    points[3 * k] = loop.points[3 * j];
    points[3 * k + 1] = loop.points[3 * j + 1];
    points[3 * k + 2] = loop.points[3 * j + 2];
  }
  return { points, edges, closed: true, length: loop.length };
}

export interface LoopSampleOptions {
  /** Shift of the first sample along the loop, as a fraction of its length in the working direction (spiral lean). */
  offset?: number;
  /** Sample j sits at (j + phase)/n of the length after the start (default ½: stitch centers, as §2.11.2). */
  phase?: number;
}

/**
 * n points uniform by arc length along a closed loop, starting at its first point (the seam) moved by `offset`, in
 * the loop's (working) direction. Returns [x, y, z, …].
 */
export function sampleLoop(loop: IsolineLoop, n: number, o: LoopSampleOptions = {}): Float64Array {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`sample count must be an integer >= 1, got ${n}`);
  if (!loop.closed) throw new RangeError('sampleLoop needs a closed loop');
  const offset = o.offset ?? 0;
  const phase = o.phase ?? 0.5;
  if (!Number.isFinite(offset) || !Number.isFinite(phase)) throw new RangeError('bad offset or phase');
  const m = loop.edges.length;
  const P = loop.points;
  const L = loop.length;
  const out = new Float64Array(3 * n);
  if (m === 1 || !(L > 0)) {
    for (let j = 0; j < n; j++) out.set(P.subarray(0, 3), 3 * j);
    return out;
  }
  // cumulative arc at each point; segment i runs from point i to point i+1 (mod m)
  const cum = new Float64Array(m + 1);
  for (let i = 0; i < m; i++) {
    const k = (i + 1) % m;
    cum[i + 1] = cum[i] + Math.hypot(P[3 * k] - P[3 * i], P[3 * k + 1] - P[3 * i + 1], P[3 * k + 2] - P[3 * i + 2]);
  }
  const total = cum[m];
  let seg = 0;
  // targets ascend after wrapping into [0, total); visit them in ascending order, write in sample order
  const targets: { s: number; j: number }[] = [];
  for (let j = 0; j < n; j++) {
    let s = ((offset + (j + phase) / n) % 1) * total;
    if (s < 0) s += total;
    if (s >= total) s -= total;
    targets.push({ s, j });
  }
  targets.sort((a, b) => a.s - b.s || a.j - b.j);
  for (const { s, j } of targets) {
    while (seg < m - 1 && cum[seg + 1] <= s) seg++;
    const len = cum[seg + 1] - cum[seg];
    const u = len > 0 ? (s - cum[seg]) / len : 0;
    const k = (seg + 1) % m;
    out[3 * j] = P[3 * seg] + u * (P[3 * k] - P[3 * seg]);
    out[3 * j + 1] = P[3 * seg + 1] + u * (P[3 * k + 1] - P[3 * seg + 1]);
    out[3 * j + 2] = P[3 * seg + 2] + u * (P[3 * k + 2] - P[3 * seg + 2]);
  }
  return out;
}
