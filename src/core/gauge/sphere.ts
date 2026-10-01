// Amigurumi sphere sizing (DESIGN.md §2.2.6; research 01 §5, 03 §4.1). Step 0 kernel: pure.
//
// The textbook ball: k increase rounds 6, 12, …, 6k, then p plain rounds at 6k, then k − 1 decrease rounds
// 6(k − 1), …, 6. Its diameter is the widest round's circumference over π, with the stuffing stretch:
// `D = N_max · w · s / π`. Calibrated on PlanetJune's 42-stitch worsted ball, "approx 2.75 in" (model 2.737 in).
import type { Cell } from '../../types/gauge';
import type { Inches } from '../../types/units';
import { isObject, positive, show } from './checks';
import { roundHalfUp } from './round';

/** The smallest ball the sizing returns: k = 2, 12 stitches around (§2.2.6). */
export const SPHERE_MIN_K = 2;

export interface SphereSizing {
  /** Number of increase rounds: 6, 12, …, 6k. */
  k: number;
  /** Stitches of the widest round, `6k`. */
  nMax: number;
  /**
   * Rounds worked even at `6k` after the increase round that reaches it:
   * `p = max(0, round(3k·w/h) − 2k)`. The two pole gaps count as intervals (research 03 §4.1), which is one
   * round fewer than research 01 §5.1.
   */
  plainRounds: number;
  /** `2k − 1 + p`. */
  rounds: number;
  /** `6k² + 6kp`. */
  stitches: number;
  /** The diameter this ball actually has, `6k · wS / π`. */
  dActualIn: Inches;
}

/**
 * Sphere from a target diameter (§2.2.6): `k = max(2, round(π·D / (6·wS)))`, `N_max = 6k`,
 * `p = max(0, round(3k·w/h) − 2k)`, `rounds = 2k − 1 + p`, `stitches = 6k² + 6kp`, `D_actual = 6k·wS/π`.
 *
 * `cell` is the amigurumi cell BEFORE stuffing (`ResolvedGauge.cell`) and `stretch` the stuffing stretch `s`
 * (`ResolvedGauge.stretch` for a firmly stuffed ball — 1.05 from the tables, 1 with a test ball; never leave it
 * out for a stuffed ball), so `wS = w·s`. Stretch is isotropic, so the number of plain rounds depends only on
 * `w/h`. A larger diameter never gives fewer stitches or rounds.
 */
export function sphereSizing(dIn: Inches, cell: Cell, stretch: number): SphereSizing {
  if (!positive(dIn)) throw new RangeError(`sphereSizing: the diameter must be a positive length in inches, got ${show(dIn)}`);
  if (!isObject(cell) || !positive(cell.w) || !positive(cell.h)) {
    throw new RangeError(`sphereSizing: the cell needs a positive width and height in inches, got ${show(cell?.w)} × ${show(cell?.h)}`);
  }
  if (!positive(stretch)) throw new RangeError(`sphereSizing: the stuffing stretch must be a positive factor, got ${show(stretch)}`);
  const wS = cell.w * stretch;
  const k = Math.max(SPHERE_MIN_K, roundHalfUp((Math.PI * dIn) / (6 * wS)));
  const p = Math.max(0, roundHalfUp(3 * k * (cell.w / cell.h)) - 2 * k);
  const stitches = 6 * k * k + 6 * k * p;
  const dActualIn = (6 * k * wS) / Math.PI;
  if (!Number.isSafeInteger(stitches) || !positive(dActualIn)) {
    throw new RangeError(`sphereSizing: a ${dIn} in ball at ${wS} in per stitch is out of range`);
  }
  return { k, nMax: 6 * k, plainRounds: p, rounds: 2 * k - 1 + p, stitches, dActualIn };
}

/**
 * Diameter of a ball whose widest round has `nMax` stitches: `D = N · wS / π`, where `wS = w·s` is the STUFFED
 * stitch width (`stuffedCell(gauge, 'firm').wS`). §2.2.3: 42 sts of worsted ⇒ 42 · 0.195 · 1.05 / π = 2.737 in.
 * `nMax` need not be a multiple of 6.
 */
export function sphereDiameterIn(nMax: number, wS: Inches): Inches {
  if (!positive(nMax)) throw new RangeError(`sphereDiameterIn: the stitch count must be a positive number, got ${show(nMax)}`);
  if (!positive(wS)) throw new RangeError(`sphereDiameterIn: the stuffed stitch width must be a positive length in inches, got ${show(wS)}`);
  const d = (nMax * wS) / Math.PI;
  if (!positive(d)) throw new RangeError(`sphereDiameterIn: ${nMax} stitches of ${wS} in are out of range`);
  return d;
}
