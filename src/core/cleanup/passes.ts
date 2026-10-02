// The crochet cleanup passes (DESIGN.md §2.5; research 06 §6.3). Track T1, sprint T1.3. Pure and deterministic:
// every pass works on a label grid in place and never changes a protected cell (thin features, salient details,
// hand edits, locked cells).
//
// Resolved ambiguities (docs/tracks/t1.md, T1.3 decisions):
//   - confetti passes are simultaneous (every cell decides from the labels before the pass), so the scan order
//     does not matter; the replacement is the most frequent OTHER 8-neighbor label;
//   - Potts runs over the labels already in the line (cleanup never brings a new color into a row: that would add
//     a strand), with the cell's current label anchored: its unary cost is the smallest of the line's, so the DP
//     only trades fidelity for fewer changes and never re-quantizes (flat-art labels come from pixel modes, and an
//     edge cell's mean color is a blend that may lie nearer another center);
//   - the minimum run is a large finite penalty, not a hard rule, so protected single cells stay feasible; the
//     last run of a line is held to it too; a round's first run is taken as continuing across the seam;
//   - rounds fix the first label to each label of the round in turn (the circular variant of §2.5 step 3);
//   - the per-row cap always keeps the labels of protected cells; the others are ranked by count × importance.
import { ciede2000 } from '../kernel/color';
import { forNeighbors, sameNeighbors } from './metrics';

/** A label grid being cleaned (mutated in place by the passes). */
export interface LabelGrid {
  cols: number;
  rows: number;
  labels: Uint8Array;
  /** 1 = never changed. */
  protect: Uint8Array;
  /** Rounds: columns wrap around. */
  wrap: boolean;
}

/** Penalty for a run shorter than r_min (finite, so a protected single cell stays feasible). */
export const SHORT_RUN_PENALTY = 1e6;
/** The current label's unary is this much below the line's smallest, so ties keep the cell as it is. */
export const ANCHOR_EPS = 1e-9;
/** Small-component merges repeat until nothing changes, at most this often. */
const COMPONENT_ROUNDS = 8;

/**
 * One confetti pass (§2.5 step 1): every unprotected cell with 0 same-label 4-neighbors and ≤ 1 same-label
 * 8-neighbor takes its most frequent other 8-neighbor label; ties → the smallest ΔE00 between the cell's source
 * color (`cellLab`) and the label's color (`paletteLab`), then the lowest label. Returns the cells changed.
 */
export function confettiPass(g: LabelGrid, cellLab: ArrayLike<number>, paletteLab: readonly ArrayLike<number>[]): number {
  const { cols, rows, labels, protect, wrap } = g;
  const n = cols * rows;
  const before = labels.slice();
  const count = new Uint8Array(256);
  const seen: number[] = [];
  let changed = 0;
  for (let i = 0; i < n; i++) {
    if (protect[i]) continue;
    const c = i % cols;
    if ((c > 0 && before[i - 1] === before[i]) || (c < cols - 1 && before[i + 1] === before[i])) continue;
    const { s4, s8, any } = sameNeighbors(before, cols, rows, i, wrap);
    if (!any || s4 > 0 || s8 > 1) continue;
    const own = before[i];
    seen.length = 0;
    forNeighbors(i, cols, rows, wrap, (j) => {
      const l = before[j];
      if (l === own) return;
      if (count[l] === 0) seen.push(l);
      count[l]++;
    });
    if (seen.length > 0) {
      seen.sort((a, b) => a - b);
      let bestN = 0;
      for (const l of seen) bestN = Math.max(bestN, count[l]);
      const tied = seen.filter((l) => count[l] === bestN);
      let best = tied[0];
      if (tied.length > 1) {
        const lab = [cellLab[i * 3], cellLab[i * 3 + 1], cellLab[i * 3 + 2]];
        let bestDe = Infinity;
        for (const l of tied) {
          const de = ciede2000(lab, paletteLab[l]);
          if (de < bestDe) {
            best = l;
            bestDe = de;
          }
        }
      }
      labels[i] = best;
      changed++;
    }
    for (const l of seen) count[l] = 0;
  }
  return changed;
}

/** The 4-connected component of `seed` (same label), stopping once it has `limit` cells. */
function componentOf(g: LabelGrid, seed: number, limit: number, mark: Int32Array, stamp: number): number[] {
  const { cols, rows, labels, wrap } = g;
  const l = labels[seed];
  const out = [seed];
  mark[seed] = stamp;
  for (let q = 0; q < out.length && out.length < limit; q++) {
    const i = out[q];
    forNeighbors(i, cols, rows, wrap, (j, edge) => {
      if (edge && mark[j] !== stamp && labels[j] === l && out.length < limit) {
        mark[j] = stamp;
        out.push(j);
      }
    });
  }
  return out;
}

/**
 * Small components (§2.5 step 2): 4-connected components smaller than `aMin` cells and without a protected
 * cell merge into the neighbor label with the longest shared border (ties → the closest color by ΔE00, then the
 * lowest label), smallest first (ties → first in scan order); repeated until nothing changes. Returns the cells
 * changed.
 */
export function mergeSmallComponents(g: LabelGrid, aMin: number, paletteLab: readonly ArrayLike<number>[]): number {
  if (aMin <= 1) return 0;
  const { cols, rows, labels, protect, wrap } = g;
  const n = cols * rows;
  const mark = new Int32Array(n).fill(-1);
  let stamp = 0;
  let changed = 0;
  for (let round = 0; round < COMPONENT_ROUNDS; round++) {
    // Small components of the current labels, smallest first.
    const seen = new Int32Array(n).fill(-1);
    const small: { seed: number; size: number }[] = [];
    for (let s = 0; s < n; s++) {
      if (seen[s] >= 0) continue;
      const comp = componentOf(g, s, aMin, mark, ++stamp);
      for (const i of comp) seen[i] = s;
      if (comp.length < aMin) small.push({ seed: s, size: comp.length });
    }
    small.sort((a, b) => a.size - b.size || a.seed - b.seed);
    let any = false;
    for (const { seed } of small) {
      // Earlier merges may have grown it: look again.
      const comp = componentOf(g, seed, aMin, mark, ++stamp);
      if (comp.length >= aMin || comp.some((i) => protect[i])) continue;
      const own = labels[seed];
      const border = new Map<number, number>();
      for (const i of comp) {
        forNeighbors(i, cols, rows, wrap, (j, edge) => {
          if (edge && labels[j] !== own) border.set(labels[j], (border.get(labels[j]) ?? 0) + 1);
        });
      }
      if (border.size === 0) continue;
      let best = -1;
      let bestB = 0;
      let bestDe = Infinity;
      for (const [l, b] of [...border.entries()].sort((p, q) => p[0] - q[0])) {
        if (b < bestB) continue;
        const de = ciede2000(paletteLab[own], paletteLab[l]);
        if (b > bestB || de < bestDe) {
          best = l;
          bestB = b;
          bestDe = de;
        }
      }
      for (const i of comp) labels[i] = best;
      changed += comp.length;
      any = true;
    }
    if (!any) break;
  }
  return changed;
}

/** Inputs of the Potts passes. */
export interface PottsInput {
  /** Cluster feature of every cell's source color (3 per cell). */
  feat: ArrayLike<number>;
  /** Cluster feature of every label's color (3 per label). */
  centers: ArrayLike<number>;
  /** Unary scale: the median distance between centers. */
  sigma: number;
  lambda: number;
  rMin: number;
}

/** Median pairwise distance between the given centers (cluster features); 1 when undefined or 0. */
export function medianCenterDistance(centers: ArrayLike<number>, used: readonly number[]): number {
  const d: number[] = [];
  for (let a = 0; a < used.length; a++) {
    for (let b = a + 1; b < used.length; b++) {
      const p = used[a] * 3;
      const q = used[b] * 3;
      d.push(Math.hypot(centers[p] - centers[q], centers[p + 1] - centers[q + 1], centers[p + 2] - centers[q + 2]));
    }
  }
  if (d.length === 0) return 1;
  d.sort((x, y) => x - y);
  const m = d.length % 2 === 1 ? d[(d.length - 1) / 2] : 0.5 * (d[d.length / 2 - 1] + d[d.length / 2]);
  return m > 0 ? m : 1;
}

/**
 * Potts DP on one line (§2.5 step 3): minimizes Σ u_i(k_i) + λ·[k_i ≠ k_{i−1}] (+ λ·[k_last ≠ k_0] for a round)
 * with minimum run r_min, over the labels present in the line (and `allowed`, when given). u_i(k) =
 * d(f_i, C_k)/σ; the cell's current label costs the smallest of its u (anchored); a protected cell costs
 * +∞ for every other label; a forbidden label costs +∞. Writes the line's labels and returns the cells changed.
 */
export function pottsLine(g: LabelGrid, line: Int32Array, p: PottsInput, circular: boolean, allowed?: ArrayLike<number>): number {
  const W = line.length;
  if (W === 0) return 0;
  const { labels, protect } = g;
  // Candidate labels: those in the line (and allowed), ascending.
  const present = new Uint8Array(256);
  for (const i of line) present[labels[i]] = 1;
  const L: number[] = [];
  for (let l = 0; l < 256; l++) if (present[l] && (allowed === undefined || allowed[l])) L.push(l);
  if (L.length === 0) return 0;
  const m = L.length;
  const allOk = L.length === [...present].reduce((a, b) => a + b, 0);
  if (m === 1 && allOk) return 0;
  const R = Math.max(1, Math.floor(p.rMin));
  const lambda = p.lambda;

  // Unary costs, W × m.
  const u = new Float64Array(W * m);
  for (let t = 0; t < W; t++) {
    const i = line[t];
    const cur = labels[i];
    if (protect[i]) {
      for (let a = 0; a < m; a++) u[t * m + a] = L[a] === cur ? 0 : Infinity;
      continue;
    }
    let min = Infinity;
    let curA = -1;
    for (let a = 0; a < m; a++) {
      const c = L[a] * 3;
      const d = Math.hypot(p.feat[i * 3] - p.centers[c], p.feat[i * 3 + 1] - p.centers[c + 1], p.feat[i * 3 + 2] - p.centers[c + 2]) / p.sigma;
      u[t * m + a] = d;
      if (d < min) min = d;
      if (L[a] === cur) curA = a;
    }
    if (curA >= 0) u[t * m + curA] = min - ANCHOR_EPS;
  }

  const S = m * R;
  const back = new Int32Array(W * S);
  let cost = new Float64Array(S);
  let next = new Float64Array(S);

  const run = (k0: number): { total: number; last: number } => {
    // Init: line start (r = 1) or, for a round with fixed first label k0, a run taken to continue from the seam.
    cost.fill(Infinity);
    if (k0 < 0) for (let a = 0; a < m; a++) cost[a * R + (protect[line[0]] ? R - 1 : 0)] = u[a];
    else cost[k0 * R + (R - 1)] = u[k0];
    for (let t = 1; t < W; t++) {
      // Best state to switch from, per label: a full run, or a short one with the penalty.
      let b1 = Infinity;
      let b1a = -1;
      let b1s = -1;
      let b2 = Infinity;
      let b2a = -1;
      let b2s = -1;
      for (let a = 0; a < m; a++) {
        let best = cost[a * R + R - 1];
        let bs = a * R + R - 1;
        for (let r = 0; r < R - 1; r++) {
          const c = cost[a * R + r] + SHORT_RUN_PENALTY;
          if (c < best) {
            best = c;
            bs = a * R + r;
          }
        }
        if (best < b1) {
          b2 = b1;
          b2a = b1a;
          b2s = b1s;
          b1 = best;
          b1a = a;
          b1s = bs;
        } else if (best < b2) {
          b2 = best;
          b2a = a;
          b2s = bs;
        }
      }
      void b2a;
      for (let a = 0; a < m; a++) {
        const ua = u[t * m + a];
        const sw = b1a !== a ? b1 : b2;
        const sws = b1a !== a ? b1s : b2s;
        for (let r = 0; r < R; r++) {
          const s = a * R + r;
          let best = Infinity;
          let from = -1;
          // Stay: (a, r − 1) → (a, r); the capped state also stays in itself.
          if (r > 0 && cost[s - 1] < best) {
            best = cost[s - 1];
            from = s - 1;
          }
          if (r === R - 1 && cost[s] < best) {
            best = cost[s];
            from = s;
          }
          // Switch into a new run (r = 1), only when strictly better than staying.
          if (r === 0 && sw + lambda < best) {
            best = sw + lambda;
            from = sws;
          }
          next[s] = best + ua;
          back[t * S + s] = from;
        }
        // A run through a protected cell counts as full: a detail is never widened to reach r_min.
        if (R > 1 && protect[line[t]] && Number.isFinite(ua)) {
          let best = Infinity;
          let from = -1;
          for (let r = R - 1; r >= 0; r--) {
            const s = a * R + r;
            if (next[s] < best) {
              best = next[s];
              from = back[t * S + s];
            }
            next[s] = Infinity;
          }
          next[a * R + R - 1] = best;
          back[t * S + a * R + R - 1] = from;
        }
      }
      const tmp = cost;
      cost = next;
      next = tmp;
    }
    let total = Infinity;
    let last = -1;
    for (let a = 0; a < m; a++) {
      for (let r = 0; r < R; r++) {
        const s = a * R + r;
        let c = cost[s];
        if (k0 >= 0 && a !== k0) c += lambda + (r < R - 1 ? SHORT_RUN_PENALTY : 0);
        else if (k0 < 0 && r < R - 1 && W >= R) c += SHORT_RUN_PENALTY;
        if (c < total) {
          total = c;
          last = s;
        }
      }
    }
    return { total, last };
  };

  const trace = (last: number, out: Uint8Array): void => {
    let s = last;
    for (let t = W - 1; t >= 0; t--) {
      out[t] = L[Math.floor(s / R)];
      if (t > 0) s = back[t * S + s];
    }
  };

  const result = new Uint8Array(W);
  if (!circular) {
    const { last } = run(-1);
    if (last < 0) return 0;
    trace(last, result);
  } else {
    // Fix the first label to each candidate (the current first label first, so ties keep it).
    const firstCur = L.indexOf(labels[line[0]]);
    const order = firstCur >= 0 ? [firstCur, ...L.keys()].filter((a, q, arr) => arr.indexOf(a) === q) : [...L.keys()];
    let bestTotal = Infinity;
    const tmp = new Uint8Array(W);
    for (const k0 of order) {
      const { total, last } = run(k0);
      if (last < 0 || !(total < bestTotal)) continue;
      bestTotal = total;
      trace(last, tmp);
      result.set(tmp);
    }
    if (bestTotal === Infinity) return 0;
  }
  let changed = 0;
  for (let t = 0; t < W; t++) {
    const i = line[t];
    if (labels[i] !== result[t] && !protect[i]) {
      labels[i] = result[t];
      changed++;
    }
  }
  return changed;
}

/**
 * Per-row cap (§2.5 step 4, tapestry): a line with more than `cap` labels keeps the labels of its protected
 * cells and then the most important others (count × importance, importance 3 for a protected palette entry;
 * ties → the lower label) up to `cap`, and re-runs the Potts DP with the rest forbidden. Returns the cells
 * changed.
 */
export function capLine(g: LabelGrid, line: Int32Array, cap: number, p: PottsInput, circular: boolean, protectedLabel: (l: number) => boolean): number {
  const count = new Map<number, number>();
  const must = new Set<number>();
  for (const i of line) {
    count.set(g.labels[i], (count.get(g.labels[i]) ?? 0) + 1);
    if (g.protect[i]) must.add(g.labels[i]);
  }
  if (count.size <= cap) return 0;
  const ranked = [...count.entries()].map(([l, c]) => ({ l, score: c * (protectedLabel(l) ? 3 : 1) })).sort((a, b) => b.score - a.score || a.l - b.l);
  const keep = new Set(must);
  for (const { l } of ranked) {
    if (keep.size >= cap) break;
    keep.add(l);
  }
  const allowed = new Uint8Array(256);
  for (const l of keep) allowed[l] = 1;
  return pottsLine(g, line, p, circular, allowed);
}

/**
 * Rare colors (§2.5 step 5): labels with fewer than `min` cells — none of them protected, and not a protected
 * palette entry — remap to the nearest remaining label (ΔE00 between label colors), rarest first (ties → the
 * higher label), as long as at least 2 labels remain. Returns the cells changed.
 */
export function remapRareColors(g: LabelGrid, min: number, paletteLab: readonly ArrayLike<number>[], protectedLabel: (l: number) => boolean): number {
  if (min <= 0) return 0;
  const { labels, protect } = g;
  const n = labels.length;
  const count = new Int32Array(256);
  const locked = new Uint8Array(256);
  for (let i = 0; i < n; i++) {
    count[labels[i]]++;
    if (protect[i]) locked[labels[i]] = 1;
  }
  let changed = 0;
  for (;;) {
    let used = 0;
    for (let l = 0; l < 256; l++) if (count[l] > 0) used++;
    if (used <= 2) break;
    let pick = -1;
    for (let l = 255; l >= 0; l--) {
      if (count[l] === 0 || count[l] >= min || locked[l] || protectedLabel(l)) continue;
      if (pick < 0 || count[l] < count[pick]) pick = l;
    }
    if (pick < 0) break;
    let to = -1;
    let bd = Infinity;
    for (let l = 0; l < 256; l++) {
      if (l === pick || count[l] === 0) continue;
      const d = ciede2000(paletteLab[pick], paletteLab[l]);
      if (d < bd) {
        bd = d;
        to = l;
      }
    }
    for (let i = 0; i < n; i++) if (labels[i] === pick) labels[i] = to;
    changed += count[pick];
    count[to] += count[pick];
    count[pick] = 0;
  }
  return changed;
}
