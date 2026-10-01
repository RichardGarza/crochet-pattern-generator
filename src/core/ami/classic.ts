// Track T4 — the textbook generator for classic spheres and capsules (DESIGN.md §2.10.5 "Classic sphere and
// capsule", research 03 §4.1).
//
// Style `classic` (the default) uses it for a sphere or capsule; closed when the piece is untrimmed with both
// ends closed, otherwise the open form: the increase phase, plain rounds up to `R_end = round(s_end / hS)` and
// no decrease phase. Every other primitive and every oval uses the generic Path A (`rounds.ts`).
import { roundHalfUp } from '../gauge/round';

export interface TextbookInput {
  kind: 'sphere' | 'capsule';
  /** Radius, inches. */
  r: number;
  /** Capsule: total length including the caps (≥ 2r). */
  length?: number;
  wS: number;
  hS: number;
  /**
   * Open far end: `sCut` for a trimmed piece (the arc position where it is cut, §2.10.3), or `{}` for an
   * untrimmed piece with `attach.openEnd` (it then ends where the far cap begins).
   */
  open?: { sCut?: number };
}

export interface TextbookCounts {
  counts: number[];
  /** Increase rounds: the widest round has 6k sts. */
  k: number;
  /** `6k·wS / 2π`: the radius the counts actually make. */
  rEff: number;
  closedEnd: boolean;
  /** Closed: `T = max(2k − 1, round(A / hS) − 1)` and `A`; open: `R_end` and `s_end`. */
  T?: number;
  A?: number;
  rEnd?: number;
  sEnd?: number;
  /** Plain rounds at 6k. */
  wall: number;
}

/** `k = max(1, round(2πr / (6·wS)))`. */
export function textbookK(r: number, wS: number): number {
  return Math.max(1, roundHalfUp((2 * Math.PI * r) / (6 * wS)));
}

const range6 = (from: number, to: number, step: number): number[] => {
  const out: number[] = [];
  for (let j = from; step > 0 ? j <= to : j >= to; j += step) out.push(6 * j);
  return out;
};

/**
 * The textbook counts:
 * ```
 * k = max(1, round(2πr / (6·wS)));  r_eff = 6k·wS / (2π)
 * A = π·r_eff (sphere)  |  (length − 2r) + π·r_eff (capsule)
 * T = max(2k − 1, round(A / hS) − 1);  wall = T − (2k − 1)
 * counts = [6, 12, …, 6k] ++ [6k] × wall ++ [6(k−1), …, 12, 6]      // sphere: wall = round(3k·w/h) − 2k
 * ```
 * Open: `[6, …, 6k]`, then `[6k]` plain rounds up to round `R_end = round(s_end / hS)`; `s_end = sCut` when
 * trimmed, else `π·r_eff/2` (+ `length − 2r` for a capsule); if `R_end < k` the increase phase stops at `R_end`.
 */
export function textbookCounts(i: TextbookInput): TextbookCounts {
  const { r, wS, hS } = i;
  if (!(r > 0 && wS > 0 && hS > 0) || ![r, wS, hS].every(Number.isFinite)) {
    throw new RangeError(`textbookCounts: r, wS and hS must be finite and > 0, got ${r}, ${wS}, ${hS}`);
  }
  if (i.length !== undefined && !(Number.isFinite(i.length) && i.length >= 0)) throw new RangeError(`textbookCounts: length must be finite, got ${i.length}`);
  if (i.open?.sCut !== undefined && !(Number.isFinite(i.open.sCut) && i.open.sCut > 0)) throw new RangeError(`textbookCounts: sCut must be > 0, got ${i.open.sCut}`);
  const straight = i.kind === 'capsule' ? Math.max(0, (i.length ?? 2 * r) - 2 * r) : 0;
  const k = textbookK(r, wS);
  const rEff = (6 * k * wS) / (2 * Math.PI);
  const rise = range6(1, k, 1);
  if (i.open) {
    const sEnd = i.open.sCut ?? (Math.PI * rEff) / 2 + straight;
    const rEnd = Math.max(1, roundHalfUp(sEnd / hS));
    const counts = rEnd < k ? range6(1, rEnd, 1) : [...rise, ...Array<number>(rEnd - k).fill(6 * k)];
    return { counts, k, rEff, closedEnd: false, rEnd, sEnd, wall: Math.max(0, rEnd - k) };
  }
  // The sphere's A/hS is 3k·w/h exactly; computing it that way keeps binary noise out of the tie test.
  const AoverH = i.kind === 'sphere' ? (3 * k * wS) / hS : (straight + Math.PI * rEff) / hS;
  const T = Math.max(2 * k - 1, roundHalfUp(AoverH) - 1);
  const wall = T - (2 * k - 1);
  const counts = [...rise, ...Array<number>(wall).fill(6 * k), ...range6(k - 1, 1, -1)];
  return { counts, k, rEff, closedEnd: true, T, A: AoverH * hS, wall };
}
