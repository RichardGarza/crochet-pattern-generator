// Rounding rules shared by the gauge kernels (DESIGN.md §2.2.6, §2.3.3, §2.7.10, §2.8). Step 0 kernel: pure.
//
// Every stitch, row and round count in the app is "the nearest whole number, ties up" (§2.10.5: "Math.round =
// JS half-up rounding everywhere"). Plain `Math.round` keeps that promise only when the number it is given is
// exact. A count is a quotient of decimal inputs, and a quotient that is a tie on paper can come out a few ulps
// short in binary: 35 in of super bulky hdc is 62.5 stitches on paper and 62.49999999999999 in a double, which
// `Math.round` turns into 62. The helpers here decide ties as exact arithmetic would, so the same request always
// gives the count a person would work out by hand.

/** Relative width of the band below a tie (or above a whole number) that is treated as binary noise. */
const TIE_EPS = 1e-12;

/**
 * The nearest integer, ties up — `Math.round`'s rule, decided as in exact arithmetic: a value within 1e-12
 * (relative) below a tie rounds up. It differs from `Math.round(x)` for no other input, except that a result of
 * zero is always +0. NaN and ±Infinity pass through unchanged.
 */
export function roundHalfUp(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.floor(x + 0.5 + TIE_EPS * (1 + Math.abs(x)));
}

/**
 * The smallest integer ≥ x, where a value within 1e-12 (relative) above a whole number counts as that whole
 * number: 2.0000000000000004 skeins is 2 skeins, not 3. A result of zero is always +0; NaN and ±Infinity pass
 * through unchanged.
 */
export function ceilTolerant(x: number): number {
  if (!Number.isFinite(x)) return x;
  const n = Math.ceil(x - TIE_EPS * (1 + Math.abs(x)));
  return n === 0 ? 0 : n;
}
