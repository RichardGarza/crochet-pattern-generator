// Rounding rules shared by the gauge kernels (DESIGN.md §2.2.6, §2.3.3, §2.7.10, §2.8). Step 0 kernel: pure.
//
// Every stitch, row and round count in the app is "the nearest whole number, ties up" (§0.1 "Rounding":
// `round` = `roundHalfUp` everywhere). Plain `Math.round` keeps that promise only when the number it is given is
// exact. A count is a quotient of decimal inputs, and a quotient that is a tie on paper can come out a few ulps
// short in binary: 35 in of super bulky hdc is 62.5 stitches on paper and 62.49999999999999 in a double, which
// `Math.round` turns into 62. The helpers here decide ties as exact arithmetic would, so the same request always
// gives the count a person would work out by hand.

/** Relative width of the band below a tie (or above a whole number) that is treated as binary noise. */
const TIE_EPS = 1e-12;
/** The band never grows beyond this, so large values still round as `Math.round` does. */
const TIE_EPS_MAX = 1e-6;

function noise(x: number): number {
  return Math.min(TIE_EPS * (1 + Math.abs(x)), TIE_EPS_MAX);
}

/**
 * The nearest integer, ties up — `Math.round`'s rule, decided as in exact arithmetic: a value within 1e-12
 * relative (and never more than 1e-6) below a tie rounds up. For every other value the result is
 * `Math.round(x)`, except that a result of zero is always +0. NaN and ±Infinity pass through unchanged.
 */
export function roundHalfUp(x: number): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 2 ** 52) return x; // from 2^52 every double is a whole number
  const n = Math.floor(x + 0.5 + noise(x));
  return n === 0 ? 0 : n;
}

/**
 * The smallest integer ≥ x, where a value within 1e-12 relative (and never more than 1e-6) above a whole number
 * counts as that whole number: 2.0000000000000004 skeins is 2 skeins, not 3. A result of zero is always +0; NaN
 * and ±Infinity pass through unchanged.
 */
export function ceilTolerant(x: number): number {
  if (!Number.isFinite(x)) return x;
  const n = Math.ceil(x - noise(x));
  return n === 0 ? 0 : n;
}
