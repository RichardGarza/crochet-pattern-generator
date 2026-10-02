// Track T5 — Path B step 4: stitch counts from the isoline lengths (DESIGN.md §2.10.7 step 4) with the pole rule of
// §2.10.5 (normative for every closed pole in both paths), the fan clamp, the `closeTail` safety net and the slope
// limit. Path B always uses the "exact" rules: hysteresis 0.75, a magic ring of clamp(round(ideal₁), 5, 8).
//
// T4 owns Path A's implementation of the same pseudocode in core/ami; this module is T5's own (no cross-track import of
// unfrozen code), written from the spec text and checked against the §2.10.5 goldens in its tests.
import { roundHalfUp } from '../gauge/round';
import type { Issue } from '../../types/issues';

/** §2.10.7 step 4: n_k = round(ideal_k) with hysteresis 0.75. */
export const PATHB_HYSTERESIS = 0.75;
/** Magic-ring start of an exact / Path B piece: n₁ = clamp(round(ideal₁), 5, 8). */
export const MR_MIN = 5;
export const MR_MAX = 8;
/** Closed far end: n_k ≥ 5 while the ideal is below it; E_CLOSE accepts a last round of 4 … 8. */
export const CLOSE_MIN = 5;
export const CLOSE_MAX = 8;
export const CLOSE_FLOOR = 4;

/** hysteresis(x, band): n₁ = round(x₁); then keep the previous count unless |x_k − prev| > band, else round(x_k). */
export function hysteresis(x: readonly number[], band = PATHB_HYSTERESIS): number[] {
  const out: number[] = [];
  for (let k = 0; k < x.length; k++) {
    if (!Number.isFinite(x[k]) || x[k] < 0) throw new RangeError(`ideal ${k + 1} must be a finite number ≥ 0, got ${x[k]}`);
    if (k === 0 || Math.abs(x[k] - out[k - 1]) > band) out.push(roundHalfUp(x[k]));
    else out.push(out[k - 1]);
  }
  return out;
}

/**
 * The start half of the pole rule (magic ring, exact / Path B): n₁ = clamp(round(ideal₁), 5, 8); then for k = 2, 3, …
 * while ideal_k < n₁: n_k = max(n_k, n_{k−1}) — a widening shape never decreases next to its start.
 */
export function clampStart(n: readonly number[], ideal: readonly number[], min = MR_MIN, max = MR_MAX): number[] {
  const out = [...n];
  if (out.length === 0) return out;
  out[0] = Math.min(max, Math.max(min, roundHalfUp(ideal[0])));
  for (let k = 1; k < out.length && ideal[k] < out[0]; k++) out[k] = Math.max(out[k], out[k - 1]);
  return out;
}

/**
 * The closed-far-end half of the pole rule: walking backwards from the last round down to the round with the largest
 * count (never past the peak — the last of equal maxima), n_k = max(n_k, n_{k+1}, 5), and only while ideal_k < 5 (the
 * walk stops at the first round from the end whose ideal reaches the closing count). Then the last round is dropped
 * when this rule raised it to equal its predecessor (at most one round).
 */
export function clampClose(n: readonly number[], ideal: readonly number[], min = CLOSE_MIN): { counts: number[]; dropped: boolean } {
  const out = [...n];
  const last = out.length - 1;
  if (last < 0) return { counts: out, dropped: false };
  let peak = 0;
  for (let k = 1; k <= last; k++) if (out[k] >= out[peak]) peak = k;
  let raisedLast = false;
  for (let k = last; k > peak; k--) {
    if (ideal[k] >= min) break;
    const v = Math.max(out[k], k < last ? out[k + 1] : 0, min);
    if (k === last && v !== out[k]) raisedLast = true;
    out[k] = v;
  }
  if (raisedLast && last >= 1 && out[last] === out[last - 1]) {
    out.pop();
    return { counts: out, dropped: true };
  }
  return { counts: out, dropped: false };
}

/** n_k ∈ [ceil(n_{k−1}/2), 2·n_{k−1}] (forward pass). */
export function clampFan(n: readonly number[]): number[] {
  const out = [...n];
  for (let k = 1; k < out.length; k++) out[k] = Math.min(2 * out[k - 1], Math.max(out[k], Math.ceil(out[k - 1] / 2)));
  return out;
}

/** The safety net: append halving rounds until a closed end is ≤ 8 (never fires on exact counts of a round end). */
export function closeTail(n: readonly number[], max = CLOSE_MAX): { counts: number[]; appended: number } {
  const out = [...n];
  let appended = 0;
  while (out.length > 0 && out[out.length - 1] > max) {
    out.push(Math.ceil(out[out.length - 1] / 2));
    appended++;
  }
  return { counts: out, appended };
}

export interface PathBCounts {
  counts: number[];
  /** hysteresis(ideal) before the clamps. */
  rounded: number[];
  /** The closed-end rule dropped the last round (its row is not worked). */
  dropped: boolean;
  /** Rounds `closeTail` appended after the last row. */
  appended: number;
}

/** §2.10.7 step 4: hysteresis 0.75 → pole rule (start; closed far end) → fan clamp → closeTail (closed only). */
export function pathBCounts(ideal: readonly number[], o: { closed: boolean }): PathBCounts {
  if (ideal.length === 0) throw new RangeError('no rows');
  const rounded = hysteresis(ideal);
  let n = clampStart(rounded, ideal);
  let dropped = false;
  if (o.closed) ({ counts: n, dropped } = clampClose(n, ideal));
  n = clampFan(n);
  let appended = 0;
  if (o.closed) ({ counts: n, appended } = closeTail(n));
  return { counts: n, rounded, dropped, appended };
}

/** §2.10.7 step 4 slope limit (R5): |Δn| ≤ ⌈2πh/w⌉. */
export function slopeLimit(w: number, h: number): number {
  if (!(w > 0) || !(h > 0)) throw new RangeError('w and h must be > 0');
  return Math.ceil((2 * Math.PI * h) / w);
}

/** `W_RUFFLE` for every round whose count changes by more than the slope limit (R5). */
export function slopeIssues(counts: readonly number[], limit: number, part?: string): Issue[] {
  const issues: Issue[] = [];
  for (let k = 1; k < counts.length; k++) {
    const d = counts[k] - counts[k - 1];
    if (Math.abs(d) > limit) {
      issues.push({
        code: 'W_RUFFLE',
        severity: 'warn',
        message: `Rnd ${k + 1}: ${counts[k - 1]} → ${counts[k]} sts changes by ${Math.abs(d)}, more than ${limit} in one round; the fabric will ${d > 0 ? 'ruffle' : 'pucker'} there`,
        where: { ...(part !== undefined ? { part } : {}), line: k + 1 },
      });
    }
  }
  return issues;
}

/**
 * The pole rule as a check (R2 `E_START`, R9 `E_CLOSE`): a magic ring of 5–8, no decrease while ideal_k < n₁, and a
 * closed end of 4–8. Path B's own output never fails it (asserted by the tests); the driver runs it as a self-check.
 */
export function poleRuleIssues(counts: readonly number[], ideal: readonly number[], o: { closed: boolean; part?: string }): Issue[] {
  const issues: Issue[] = [];
  const where = (line: number): Issue['where'] => ({ ...(o.part !== undefined ? { part: o.part } : {}), line });
  if (counts.length === 0) return [{ code: 'E_START', severity: 'error', message: 'the piece has no rounds', where: where(1) }];
  const n1 = counts[0];
  if (!(n1 >= MR_MIN && n1 <= MR_MAX)) {
    issues.push({ code: 'E_START', severity: 'error', message: `Rnd 1: a magic ring of ${n1} sts (5–8 expected)`, where: where(1) });
  }
  for (let k = 1; k < counts.length && k < ideal.length && ideal[k] < n1; k++) {
    if (counts[k] < counts[k - 1]) {
      issues.push({ code: 'E_START', severity: 'error', message: `Rnd ${k + 1}: decreases next to the start while the shape still widens`, where: where(k + 1) });
    }
  }
  const last = counts[counts.length - 1];
  if (o.closed && !(last >= CLOSE_FLOOR && last <= CLOSE_MAX)) {
    issues.push({ code: 'E_CLOSE', severity: 'error', message: `the closing round has ${last} sts (4–8 expected)`, where: where(counts.length) });
  }
  return issues;
}
