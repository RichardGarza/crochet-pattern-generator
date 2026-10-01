// The deterministic quantizer (DESIGN.md §2.4.2, D5; research 06 §2.3). Track T1, sprint T1.2. Pure, no DOM.
//
// - Init: repeatedly split the cluster with the largest weighted SSE along its principal axis (power iteration
//   from [1, 1, 1]) at the SSE-optimal cut (prefix sums over the stable-sorted projection).
// - Refine: weighted Lloyd, ≤ 30 iterations, stop when (SSE_prev − SSE)/SSE < 1e-3; an empty cluster is re-seeded
//   at the point with the largest weighted error; every tie goes to the lowest index.
// - Output sorted by population (descending; ties keep the lower index): center 0 is the main color, code A.
// No randomness anywhere: same points ⇒ same centers, bit for bit.
import type { WeightedPoints } from './points';

export const LLOYD_MAX_ITERATIONS = 30;
export const LLOYD_TOLERANCE = 1e-3;

export interface Quantized {
  /** Number of centers (≤ the K asked for: never more than the distinct points). */
  k: number;
  /** Centers in feature space, 3 per center, sorted by population (descending). */
  centers: Float64Array<ArrayBuffer>;
  /** Weight of the points assigned to each center. */
  weights: Float64Array<ArrayBuffer>;
  /** Center of every point. */
  labels: Int32Array<ArrayBuffer>;
  /** Weighted sum of squared distances to the assigned centers. */
  sse: number;
  /** Lloyd iterations run. */
  iterations: number;
}

const d2 = (f: ArrayLike<number>, i: number, c: ArrayLike<number>, k: number): number => {
  const a = f[i * 3] - c[k * 3];
  const b = f[i * 3 + 1] - c[k * 3 + 1];
  const e = f[i * 3 + 2] - c[k * 3 + 2];
  return a * a + b * b + e * e;
};

/** Index of the nearest center (ties → lowest index) and its squared distance. */
export function nearestCenter(f: ArrayLike<number>, i: number, centers: ArrayLike<number>, k: number): [number, number] {
  let best = 0;
  let bd = Infinity;
  for (let c = 0; c < k; c++) {
    const d = d2(f, i, centers, c);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return [best, bd];
}

interface Cluster {
  members: Int32Array;
  sse: number;
}

function clusterStats(p: WeightedPoints, members: ArrayLike<number>): { w: number; mean: [number, number, number]; sse: number } {
  let w = 0;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  for (let k = 0; k < members.length; k++) {
    const i = members[k];
    const wi = p.w[i];
    w += wi;
    s0 += wi * p.f[i * 3];
    s1 += wi * p.f[i * 3 + 1];
    s2 += wi * p.f[i * 3 + 2];
  }
  const mean: [number, number, number] = w > 0 ? [s0 / w, s1 / w, s2 / w] : [0, 0, 0];
  let sse = 0;
  for (let k = 0; k < members.length; k++) {
    const i = members[k];
    const a = p.f[i * 3] - mean[0];
    const b = p.f[i * 3 + 1] - mean[1];
    const c = p.f[i * 3 + 2] - mean[2];
    sse += p.w[i] * (a * a + b * b + c * c);
  }
  return { w, mean, sse };
}

/** Principal axis of a cluster: power iteration on the weighted covariance, from [1, 1, 1]. */
function principalAxis(p: WeightedPoints, members: Int32Array, mean: readonly number[]): [number, number, number] {
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let k = 0; k < members.length; k++) {
    const i = members[k];
    const wi = p.w[i];
    const v0 = p.f[i * 3] - mean[0];
    const v1 = p.f[i * 3 + 1] - mean[1];
    const v2 = p.f[i * 3 + 2] - mean[2];
    cov[0] += wi * v0 * v0;
    cov[1] += wi * v0 * v1;
    cov[2] += wi * v0 * v2;
    cov[4] += wi * v1 * v1;
    cov[5] += wi * v1 * v2;
    cov[8] += wi * v2 * v2;
  }
  cov[3] = cov[1];
  cov[6] = cov[2];
  cov[7] = cov[5];
  let v: [number, number, number] = [1, 1, 1];
  for (let it = 0; it < 64; it++) {
    const x = cov[0] * v[0] + cov[1] * v[1] + cov[2] * v[2];
    const y = cov[3] * v[0] + cov[4] * v[1] + cov[5] * v[2];
    const z = cov[6] * v[0] + cov[7] * v[1] + cov[8] * v[2];
    const len = Math.hypot(x, y, z);
    if (!(len > 0)) break; // [1,1,1] ⟂ the spread (or no spread): keep the last direction
    const nv: [number, number, number] = [x / len, y / len, z / len];
    const change = Math.abs(nv[0] - v[0]) + Math.abs(nv[1] - v[1]) + Math.abs(nv[2] - v[2]);
    v = nv;
    if (change < 1e-12) break;
  }
  // [1,1,1] can be orthogonal to the only axis with spread (e.g. pure ±a chroma at fixed L): fall back to the
  // coordinate axis with the largest variance.
  const proj = (axis: readonly number[]): number =>
    axis[0] * (cov[0] * axis[0] + cov[1] * axis[1] + cov[2] * axis[2]) +
    axis[1] * (cov[3] * axis[0] + cov[4] * axis[1] + cov[5] * axis[2]) +
    axis[2] * (cov[6] * axis[0] + cov[7] * axis[1] + cov[8] * axis[2]);
  const len = Math.hypot(v[0], v[1], v[2]);
  if (len > 0) v = [v[0] / len, v[1] / len, v[2] / len];
  const best = cov[0] >= cov[4] && cov[0] >= cov[8] ? 0 : cov[4] >= cov[8] ? 1 : 2;
  const e: [number, number, number] = [0, 0, 0];
  e[best] = 1;
  return proj(v) >= proj(e) ? v : e;
}

/** Splits a cluster at the SSE-optimal cut along its principal axis; undefined when it cannot be split. */
function splitCluster(p: WeightedPoints, c: Cluster): [Cluster, Cluster] | undefined {
  const m = c.members.length;
  if (m < 2 || !(c.sse > 0)) return undefined;
  const { mean } = clusterStats(p, c.members);
  const axis = principalAxis(p, c.members, mean);
  const proj = new Float64Array(m);
  for (let k = 0; k < m; k++) {
    const i = c.members[k];
    proj[k] = axis[0] * p.f[i * 3] + axis[1] * p.f[i * 3 + 1] + axis[2] * p.f[i * 3 + 2];
  }
  // Stable sort by projection (ties keep member order, which is ascending point index).
  const order = new Uint32Array(m);
  for (let k = 0; k < m; k++) order[k] = k;
  order.sort((a, b) => proj[a] - proj[b] || a - b);
  // Prefix sums of w, w·f and w·|f|²: SSE of a prefix = Σw|f|² − |Σwf|²/Σw.
  let W = 0;
  let S0 = 0;
  let S1 = 0;
  let S2 = 0;
  let Q = 0;
  for (let k = 0; k < m; k++) {
    const i = c.members[order[k]];
    const wi = p.w[i];
    W += wi;
    S0 += wi * p.f[i * 3];
    S1 += wi * p.f[i * 3 + 1];
    S2 += wi * p.f[i * 3 + 2];
    Q += wi * (p.f[i * 3] ** 2 + p.f[i * 3 + 1] ** 2 + p.f[i * 3 + 2] ** 2);
  }
  let w = 0;
  let s0 = 0;
  let s1 = 0;
  let s2 = 0;
  let q = 0;
  let bestT = -1;
  let bestSse = Infinity;
  for (let t = 1; t < m; t++) {
    const i = c.members[order[t - 1]];
    const wi = p.w[i];
    w += wi;
    s0 += wi * p.f[i * 3];
    s1 += wi * p.f[i * 3 + 1];
    s2 += wi * p.f[i * 3 + 2];
    q += wi * (p.f[i * 3] ** 2 + p.f[i * 3 + 1] ** 2 + p.f[i * 3 + 2] ** 2);
    // Never cut between two points with the same projection (they would be split arbitrarily).
    if (proj[order[t]] === proj[order[t - 1]]) continue;
    const wr = W - w;
    const left = q - (s0 * s0 + s1 * s1 + s2 * s2) / w;
    const right = Q - q - ((S0 - s0) ** 2 + (S1 - s1) ** 2 + (S2 - s2) ** 2) / wr;
    const sse = left + right;
    if (sse < bestSse) {
      bestSse = sse;
      bestT = t;
    }
  }
  if (bestT < 0) return undefined;
  const a = new Int32Array(bestT);
  for (let k = 0; k < bestT; k++) a[k] = c.members[order[k]];
  const b = new Int32Array(m - bestT);
  for (let k = bestT; k < m; k++) b[k - bestT] = c.members[order[k]];
  a.sort();
  b.sort();
  return [
    { members: a, sse: clusterStats(p, a).sse },
    { members: b, sse: clusterStats(p, b).sse },
  ];
}

/** The Wu-style variance-split initial centers (≤ k of them; fewer when the points cannot be split further). */
export function varianceSplitInit(p: WeightedPoints, k: number): Float64Array<ArrayBuffer> {
  const seq = varianceSplitSequence(p, k);
  return seq.length > 0 ? seq[seq.length - 1] : new Float64Array(0);
}

/**
 * The variance-split initial centers for every K = 1…kMax in one run (the splits are nested: K + 1 is K with
 * its worst cluster split): element K − 1 holds the K initial centers. Shorter when the points cannot be split
 * further.
 */
export function varianceSplitSequence(p: WeightedPoints, kMax: number): Float64Array<ArrayBuffer>[] {
  if (p.n === 0 || kMax < 1) return [];
  const all = Int32Array.from({ length: p.n }, (_, i) => i);
  const clusters: Cluster[] = [{ members: all, sse: clusterStats(p, all).sse }];
  const means: [number, number, number][] = [clusterStats(p, all).mean];
  const snapshot = (): Float64Array<ArrayBuffer> => {
    const out = new Float64Array(clusters.length * 3);
    means.forEach((m, j) => out.set(m, j * 3));
    return out;
  };
  const seq = [snapshot()];
  const stuck = new Set<Cluster>();
  while (clusters.length < kMax) {
    let worst = -1;
    for (let c = 0; c < clusters.length; c++) {
      if (stuck.has(clusters[c])) continue;
      if (worst < 0 || clusters[c].sse > clusters[worst].sse) worst = c;
    }
    if (worst < 0) break;
    const parts = splitCluster(p, clusters[worst]);
    if (parts === undefined) {
      stuck.add(clusters[worst]);
      continue;
    }
    clusters.splice(worst, 1, parts[0], parts[1]);
    means.splice(worst, 1, clusterStats(p, parts[0].members).mean, clusterStats(p, parts[1].members).mean);
    seq.push(snapshot());
  }
  return seq;
}

/** Weighted Lloyd from the given centers (k = centers.length / 3). */
export function lloyd(p: WeightedPoints, init: Float64Array, o: { maxIterations?: number; tolerance?: number } = {}): Quantized {
  const k = init.length / 3;
  const maxIt = o.maxIterations ?? LLOYD_MAX_ITERATIONS;
  const tol = o.tolerance ?? LLOYD_TOLERANCE;
  let centers = Float64Array.from(init);
  const labels = new Int32Array(p.n);
  const dist = new Float64Array(p.n);
  let prev = Infinity;
  let sse = 0;
  let iterations = 0;
  const assign = (): void => {
    sse = 0;
    for (let i = 0; i < p.n; i++) {
      const [c, d] = nearestCenter(p.f, i, centers, k);
      labels[i] = c;
      dist[i] = d;
      sse += p.w[i] * d;
    }
  };
  let converged = false;
  for (let it = 0; it < maxIt; it++) {
    iterations = it + 1;
    assign();
    // Converged on the assignment just made: keep these centers (they are the means of the previous step).
    if (prev !== Infinity && (sse === 0 || (prev - sse) / sse < tol)) {
      converged = true;
      break;
    }
    prev = sse;
    const sums = new Float64Array(k * 4);
    for (let i = 0; i < p.n; i++) {
      const c = labels[i];
      const wi = p.w[i];
      sums[c * 4] += wi;
      sums[c * 4 + 1] += wi * p.f[i * 3];
      sums[c * 4 + 2] += wi * p.f[i * 3 + 1];
      sums[c * 4 + 3] += wi * p.f[i * 3 + 2];
    }
    const next = new Float64Array(k * 3);
    const taken = new Set<number>();
    for (let c = 0; c < k; c++) {
      const w = sums[c * 4];
      if (w > 0) {
        next[c * 3] = sums[c * 4 + 1] / w;
        next[c * 3 + 1] = sums[c * 4 + 2] / w;
        next[c * 3 + 2] = sums[c * 4 + 3] / w;
      } else {
        // Re-seed an empty cluster at the point with the largest weighted error (ties → lowest index).
        let best = -1;
        let be = -1;
        for (let i = 0; i < p.n; i++) {
          if (taken.has(i)) continue;
          const e = p.w[i] * dist[i];
          if (e > be) {
            be = e;
            best = i;
          }
        }
        if (best >= 0) {
          taken.add(best);
          next[c * 3] = p.f[best * 3];
          next[c * 3 + 1] = p.f[best * 3 + 1];
          next[c * 3 + 2] = p.f[best * 3 + 2];
          dist[best] = 0;
        } else next.set(centers.subarray(c * 3, c * 3 + 3), c * 3);
      }
    }
    centers = next;
  }
  // Out of iterations: the labels must belong to the final centers.
  if (!converged) assign();
  return sortByPopulation(p, centers, labels, sse, iterations);
}

function sortByPopulation(p: WeightedPoints, centers: Float64Array, labels: Int32Array, sse: number, iterations: number): Quantized {
  const k = centers.length / 3;
  const pop = new Float64Array(k);
  for (let i = 0; i < p.n; i++) pop[labels[i]] += p.w[i];
  const order = Array.from({ length: k }, (_, c) => c).sort((a, b) => pop[b] - pop[a] || a - b);
  const rank = new Int32Array(k);
  order.forEach((c, r) => (rank[c] = r));
  const sorted = new Float64Array(k * 3);
  const weights = new Float64Array(k);
  order.forEach((c, r) => {
    sorted.set(centers.subarray(c * 3, c * 3 + 3), r * 3);
    weights[r] = pop[c];
  });
  const out = new Int32Array(p.n);
  for (let i = 0; i < p.n; i++) out[i] = rank[labels[i]];
  return { k, centers: sorted, weights, labels: out, sse, iterations };
}

/** Quantizes the points to at most k centers (§2.4.2). */
export function quantize(p: WeightedPoints, k: number): Quantized {
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`quantize: k must be a whole number ≥ 1, got ${k}`);
  if (p.n === 0) return { k: 0, centers: new Float64Array(0), weights: new Float64Array(0), labels: new Int32Array(0), sse: 0, iterations: 0 };
  return lloyd(p, varianceSplitInit(p, k));
}
