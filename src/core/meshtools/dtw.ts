// Track T5 — Path B step 6: couple consecutive rounds by constrained dynamic time warping (DESIGN.md §2.10.7 step 6;
// research 03 §6.2).
//
// The previous round's stitch centers A (P of them) and the new round's B (T), both starting at the seam, are aligned
// by a monotone path of cells (i, j) from (0, 0) to (P − 1, T − 1) — endpoints fixed at the seam. Moves:
//   D (i+1, j+1)  a new stitch into the next old stitch (sc);
//   H (i,   j+1)  one more new stitch into the same old stitch (increase), only while that old stitch has < maxFan;
//   V (i+1, j  )  the same new stitch also takes the next old stitch (decrease), only while it has < maxFan.
// Cost = Σ over the path's cells of |A_i − B_j| + 0.15·w per H or V move. An H never directly follows a V and a V
// never directly follows an H: that would make one stitch part of an increase and a decrease at once (R6,
// `E_CORNER`), so every connected group of the alignment is a star (sc, inc / inc3, dec / dec3) and the transducer
// (transduce.ts) reads ops off it. The dynamic program tracks the current H or V run per cell (2·maxFan − 1 states),
// exact and deterministic (ties: D before H before V, then the lower state).
import type { Issue } from '../../types/issues';

/** Cost of one H or V move, in stitch widths (§2.10.7 step 6). */
export const DTW_FAN_PENALTY = 0.15;
/** Largest fan of the first try, and of the retry (with `W_FAN3`). */
export const DTW_MAX_FAN = 2;
export const DTW_RETRY_FAN = 3;
/** Largest DP table (cells × states) the coupler accepts. */
export const DTW_MAX_TABLE = 2 ** 24;

export interface Alignment {
  /** Path cells [i₀, j₀, i₁, j₁, …] from (0, 0) to (P − 1, T − 1). */
  cells: Int32Array;
  /** Path cost (inches). */
  cost: number;
  /** The fan limit the path was found with. */
  maxFan: number;
  P: number;
  T: number;
}

export interface CoupleOptions {
  /** Stitch width (inches), for the 0.15·w move penalty. */
  w: number;
  /** Most new stitches in one old stitch and old stitches under one new stitch (2 or 3; default 2). */
  maxFan?: number;
}

/**
 * Constrained DTW between two rounds of stitch centers ([x, y, z, …], seam first). Returns null when no path exists
 * within the fan limit (T > maxFan·P or P > maxFan·T).
 */
export function coupleRows(A: ArrayLike<number>, B: ArrayLike<number>, o: CoupleOptions): Alignment | null {
  if (A.length % 3 !== 0 || B.length % 3 !== 0) throw new RangeError('point arrays must hold x, y, z triples');
  const P = A.length / 3;
  const T = B.length / 3;
  if (P < 1 || T < 1) throw new RangeError('both rounds need at least one stitch');
  const maxFan = o.maxFan ?? DTW_MAX_FAN;
  if (!Number.isInteger(maxFan) || maxFan < 1 || maxFan > 3) throw new RangeError(`maxFan must be 1, 2 or 3, got ${maxFan}`);
  if (!(o.w > 0) || !Number.isFinite(o.w)) throw new RangeError(`w must be > 0, got ${o.w}`);
  for (let k = 0; k < A.length; k++) if (!Number.isFinite(A[k])) throw new RangeError('non-finite point in A');
  for (let k = 0; k < B.length; k++) if (!Number.isFinite(B[k])) throw new RangeError('non-finite point in B');
  if (T > maxFan * P || P > maxFan * T) return null;
  const R = maxFan - 1; // largest run of H (or V) moves in a row
  const S = 2 * R + 1; // states −R … R, stored at s + R
  if (P * T * S > DTW_MAX_TABLE) throw new RangeError(`rounds of ${P} and ${T} stitches exceed the coupler's table`);
  const pen = DTW_FAN_PENALTY * o.w;
  const cost = new Float64Array(P * T * S).fill(Infinity);
  const back = new Int8Array(P * T); // for state 0: the state of the D predecessor (+R)
  const at = (i: number, j: number, s: number): number => (i * T + j) * S + s + R;
  const dist = (i: number, j: number): number =>
    Math.hypot(A[3 * i] - B[3 * j], A[3 * i + 1] - B[3 * j + 1], A[3 * i + 2] - B[3 * j + 2]);
  // Predecessor preference for a D move: state 0, then +1, −1, +2, −2 (a fixed order: deterministic ties).
  const order: number[] = [0];
  for (let r = 1; r <= R; r++) order.push(r, -r);
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < T; j++) {
      const d = dist(i, j);
      // state 0: start, or a D move from (i − 1, j − 1)
      if (i === 0 && j === 0) {
        cost[at(0, 0, 0)] = d;
      } else if (i > 0 && j > 0) {
        let best = Infinity;
        let bs = 0;
        for (const s of order) {
          const c = cost[at(i - 1, j - 1, s)];
          if (c < best) {
            best = c;
            bs = s;
          }
        }
        if (best < Infinity) {
          cost[at(i, j, 0)] = best + d;
          back[i * T + j] = bs + R;
        }
      }
      // states +1 … +R: an H move from (i, j − 1) in state s − 1 ≥ 0
      if (j > 0) for (let s = 1; s <= R; s++) {
        const c = cost[at(i, j - 1, s - 1)];
        if (c < Infinity) cost[at(i, j, s)] = c + d + pen;
      }
      // states −1 … −R: a V move from (i − 1, j) in state s + 1 ≤ 0
      if (i > 0) for (let s = -1; s >= -R; s--) {
        const c = cost[at(i - 1, j, s + 1)];
        if (c < Infinity) cost[at(i, j, s)] = c + d + pen;
      }
    }
  }
  let end = Infinity;
  let es = 0;
  for (const s of order) {
    const c = cost[at(P - 1, T - 1, s)];
    if (c < end) {
      end = c;
      es = s;
    }
  }
  if (!(end < Infinity)) return null;
  const path: number[] = [];
  let i = P - 1;
  let j = T - 1;
  let s = es;
  for (;;) {
    path.push(i, j);
    if (i === 0 && j === 0) break;
    if (s > 0) {
      j--;
      s--;
    } else if (s < 0) {
      i--;
      s++;
    } else {
      s = back[i * T + j] - R;
      i--;
      j--;
    }
  }
  const cells = new Int32Array(path.length);
  for (let k = 0; k < path.length; k += 2) {
    cells[k] = path[path.length - 2 - k];
    cells[k + 1] = path[path.length - 1 - k];
  }
  return { cells, cost: end, maxFan, P, T };
}

/**
 * R6 before ops exist (§2.10.7, `E_CORNER`): no stitch is part of both an increase and a decrease — no cell joins an
 * old stitch with several partners to a new stitch with several partners. Also checks that the path is a valid
 * monotone alignment covering both rounds (an internal invariant, reported as `E_CORNER` too).
 */
export function cornerIssues(al: Pick<Alignment, 'cells' | 'P' | 'T'>, where?: Issue['where']): Issue[] {
  const { cells, P, T } = al;
  const issues: Issue[] = [];
  const at = where ? { where } : {};
  const degA = new Int32Array(P);
  const degB = new Int32Array(T);
  const m = cells.length / 2;
  let valid = m > 0 && cells[0] === 0 && cells[1] === 0 && cells[2 * m - 2] === P - 1 && cells[2 * m - 1] === T - 1;
  for (let k = 0; k < m; k++) {
    const i = cells[2 * k];
    const j = cells[2 * k + 1];
    if (!(i >= 0 && i < P && j >= 0 && j < T)) {
      valid = false;
      continue;
    }
    degA[i]++;
    degB[j]++;
    if (k > 0) {
      const di = i - cells[2 * k - 2];
      const dj = j - cells[2 * k - 1];
      if (!((di === 1 && dj === 1) || (di === 0 && dj === 1) || (di === 1 && dj === 0))) valid = false;
    }
  }
  if (!valid) {
    issues.push({ code: 'E_CORNER', severity: 'error', message: 'the coupling of two rounds is not a monotone path from seam to seam', ...at });
    return issues;
  }
  for (let k = 0; k < m; k++) {
    const i = cells[2 * k];
    const j = cells[2 * k + 1];
    if (degA[i] > 1 && degB[j] > 1) {
      issues.push({
        code: 'E_CORNER',
        severity: 'error',
        message: `stitch ${j + 1} would be part of an increase and a decrease at once (old stitch ${i + 1})`,
        ...at,
      });
    }
  }
  return issues;
}
