// Choosing yarns directly from a line or a stash: p-median BUILD + SWAP (DESIGN.md §2.4.4, D6; research 06
// §7.4). Track T1, sprint T1.2. Pure, no DOM.
//
// Cost of a set S of candidates: Σ_points w · ΔEOKr2(point, nearest member of S). BUILD greedily adds the
// candidate that lowers the cost most; SWAP exchanges a chosen and an unchosen candidate while that lowers the
// cost (the best exchange per pass, ≤ 50 passes). Each pass evaluates every exchange in O(C·n) with the
// nearest/second-nearest bookkeeping of FastPAM1 (Schubert & Rousseeuw 2019). SWAP also runs from the
// "snap after quantize" sets (free centers snapped to their nearest candidates by ΔEOKr2 and by ΔE00), and the
// cheapest result wins, so the result never costs more than snapping. Every candidate is chosen at most once (indices are distinct by
// construction); ties go to the lowest index.
import { ciede2000 } from '../kernel/color';
import { labAt } from './colors';
import { nearestCenter, quantize } from './quantize';
import type { WeightedPoints } from './points';

export const SWAP_MAX_PASSES = 50;

export interface PMedianResult {
  /** Chosen candidate indices, distinct, in the order they were chosen (fixed ones first). */
  chosen: number[];
  /** Σ w · ΔEOKr2 to the nearest chosen candidate. */
  cost: number;
  /** Which start won ('build' or 'snap') and the SWAP passes it took. */
  start: 'build' | 'snap';
  passes: number;
}

const dist = (f: ArrayLike<number>, i: number, c: ArrayLike<number>, j: number): number => {
  const a = f[i * 3] - c[j * 3];
  const b = f[i * 3 + 1] - c[j * 3 + 1];
  const e = f[i * 3 + 2] - c[j * 3 + 2];
  return Math.sqrt(a * a + b * b + e * e);
};

/** Cost of a candidate set: Σ w · ΔEOKr2(point, nearest chosen). */
export function pMedianCost(p: WeightedPoints, cand: ArrayLike<number>, chosen: readonly number[]): number {
  if (chosen.length === 0) return p.n === 0 ? 0 : Infinity;
  let cost = 0;
  for (let i = 0; i < p.n; i++) {
    let best = Infinity;
    for (const j of chosen) best = Math.min(best, dist(p.f, i, cand, j));
    cost += p.w[i] * best;
  }
  return cost;
}

/** Greedy BUILD: add candidates to `start` until it has k members. */
function build(p: WeightedPoints, cand: ArrayLike<number>, nc: number, k: number, start: readonly number[]): number[] {
  const chosen = [...start];
  const inSet = new Uint8Array(nc);
  for (const j of chosen) inSet[j] = 1;
  const near = new Float64Array(p.n).fill(Infinity);
  for (let i = 0; i < p.n; i++) for (const j of chosen) near[i] = Math.min(near[i], dist(p.f, i, cand, j));
  while (chosen.length < k) {
    let best = -1;
    let bestCost = Infinity;
    for (let j = 0; j < nc; j++) {
      if (inSet[j]) continue;
      let cost = 0;
      for (let i = 0; i < p.n; i++) cost += p.w[i] * Math.min(near[i], dist(p.f, i, cand, j));
      if (cost < bestCost - 1e-12 * Math.abs(bestCost) || best < 0) {
        bestCost = cost;
        best = j;
      }
    }
    if (best < 0) break;
    chosen.push(best);
    inSet[best] = 1;
    for (let i = 0; i < p.n; i++) near[i] = Math.min(near[i], dist(p.f, i, cand, best));
  }
  return chosen;
}

/** SWAP until no exchange lowers the cost (≤ maxPasses); members of `fixed` never leave. */
function swap(p: WeightedPoints, cand: ArrayLike<number>, nc: number, chosenIn: readonly number[], fixed: ReadonlySet<number>, maxPasses: number): { chosen: number[]; cost: number; passes: number } {
  const chosen = [...chosenIn];
  const k = chosen.length;
  const inSet = new Uint8Array(nc);
  for (const j of chosen) inSet[j] = 1;
  const nearIdx = new Int32Array(p.n); // position in `chosen`
  const nearD = new Float64Array(p.n);
  const secD = new Float64Array(p.n);
  const refresh = (): number => {
    let cost = 0;
    for (let i = 0; i < p.n; i++) {
      let b1 = Infinity;
      let b2 = Infinity;
      let bi = 0;
      for (let m = 0; m < k; m++) {
        const d = dist(p.f, i, cand, chosen[m]);
        if (d < b1) {
          b2 = b1;
          b1 = d;
          bi = m;
        } else if (d < b2) b2 = d;
      }
      nearIdx[i] = bi;
      nearD[i] = b1;
      secD[i] = b2;
      cost += p.w[i] * b1;
    }
    return cost;
  };
  let cost = refresh();
  let passes = 0;
  const removable = chosen.map((j) => !fixed.has(j));
  if (k === 0 || !removable.some(Boolean)) return { chosen, cost, passes };
  const acc = new Float64Array(k);
  for (; passes < maxPasses; passes++) {
    let bestDelta = -1e-12 * Math.max(1, cost);
    let bestOut = -1;
    let bestIn = -1;
    for (let j = 0; j < nc; j++) {
      if (inSet[j]) continue;
      // Removing member m and adding j: points nearest to m go to min(dj, second); the rest to min(dj, nearest).
      let shared = 0;
      acc.fill(0);
      for (let i = 0; i < p.n; i++) {
        const dj = dist(p.f, i, cand, j);
        const wi = p.w[i];
        const gain = dj < nearD[i] ? wi * (dj - nearD[i]) : 0;
        shared += gain;
        acc[nearIdx[i]] += wi * (Math.min(dj, secD[i]) - nearD[i]) - gain;
      }
      for (let m = 0; m < k; m++) {
        if (!removable[m]) continue;
        const delta = shared + acc[m];
        if (delta < bestDelta) {
          bestDelta = delta;
          bestOut = m;
          bestIn = j;
        }
      }
    }
    if (bestOut < 0) break;
    inSet[chosen[bestOut]] = 0;
    chosen[bestOut] = bestIn;
    inSet[bestIn] = 1;
    cost = refresh();
  }
  return { chosen, cost, passes };
}

/**
 * Chooses k distinct candidates (features packed in `cand`, 3 per candidate) for the weighted points.
 * `fixed` candidates are always chosen (protected colors); `exclude` candidates never are (e.g. textured yarns
 * for a protected detail are excluded by the caller instead). With fewer candidates than k, all are chosen.
 */
export function pMedian(
  p: WeightedPoints,
  cand: ArrayLike<number>,
  k: number,
  o: { fixed?: readonly number[]; exclude?: readonly number[]; maxPasses?: number; snapInit?: boolean } = {},
): PMedianResult {
  const nc = cand.length / 3;
  if (!Number.isInteger(k) || k < 1) throw new RangeError(`pMedian: k must be a whole number ≥ 1, got ${k}`);
  const fixed = [...new Set(o.fixed ?? [])];
  for (const j of fixed) if (!(Number.isInteger(j) && j >= 0 && j < nc)) throw new RangeError(`pMedian: fixed candidate ${j} out of range`);
  const excluded = new Set(o.exclude ?? []);
  // Excluded candidates are taken out of the pool by giving SWAP/BUILD a reduced index space.
  const pool: number[] = [];
  for (let j = 0; j < nc; j++) if (!excluded.has(j) || fixed.includes(j)) pool.push(j);
  const sub = new Float64Array(pool.length * 3);
  pool.forEach((j, q) => {
    sub[q * 3] = cand[j * 3];
    sub[q * 3 + 1] = cand[j * 3 + 1];
    sub[q * 3 + 2] = cand[j * 3 + 2];
  });
  const toSub = new Map(pool.map((j, q) => [j, q]));
  const fixedSub = fixed.map((j) => toSub.get(j)!);
  const want = Math.min(Math.max(k, fixedSub.length), pool.length);
  const maxPasses = o.maxPasses ?? SWAP_MAX_PASSES;
  const fixedSet = new Set(fixedSub);
  const built = build(p, sub, pool.length, want, fixedSub);
  let best = { ...swap(p, sub, pool.length, built, fixedSet, maxPasses), start: 'build' as 'build' | 'snap' };
  if (o.snapInit !== false && p.n > 0 && want > fixedSub.length) {
    // Snap after quantize: free centers → nearest candidate (by ΔEOKr2, and again by ΔE00, the matching metric
    // of §2.4.4), distinct, completed greedily, then SWAP.
    const q = quantize(p, want);
    const subLab = Array.from({ length: pool.length }, (_, j) => labAt(sub, j));
    for (const metric of ['ok', 'de00'] as const) {
      const snapped: number[] = [...fixedSub];
      for (let c = 0; c < q.k && snapped.length < want; c++) {
        let j = 0;
        if (metric === 'ok') j = nearestCenter(q.centers, c, sub, pool.length)[0];
        else {
          const lab = labAt(q.centers, c);
          let bd = Infinity;
          subLab.forEach((l, m) => {
            const d = ciede2000(lab, l);
            if (d < bd) {
              bd = d;
              j = m;
            }
          });
        }
        if (!snapped.includes(j)) snapped.push(j);
      }
      const completed = build(p, sub, pool.length, want, snapped);
      const s = swap(p, sub, pool.length, completed, fixedSet, maxPasses);
      if (s.cost < best.cost - 1e-12 * Math.max(1, best.cost)) best = { ...s, start: 'snap' };
    }
  }
  return { chosen: best.chosen.map((q) => pool[q]), cost: best.cost, start: best.start, passes: best.passes };
}
