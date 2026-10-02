// Track T4 — the spiral lean and stitch numbering (DESIGN.md §2.11.2, §2.12 item 2).
//
// Single crochet worked in a spiral leans: a stitch number counted from the marker does not stay on one vertical
// line. Each piece has a reference round r_ref whose seam is exactly center back (the front-marker cue pins it).
// Round k's seam azimuth (about the working direction d, from center back — see frame.ts) is
//
//   α_seam(k) = h·2π·leanStPerRnd·Σ_{i = r_ref+1..k} 1/n_i      (k > r_ref; h = +1 RH, −1 LH)
//   α_seam(k) = −h·2π·leanStPerRnd·Σ_{i = k+1..r_ref} 1/n_i     (k < r_ref)
//
// so a positive lean moves the seam against the working direction (a right-hander works towards lower α).
// Stitch j (0-based) of round k sits at α_j = α_seam(k) − 2π(j + ½)/n_k (RH; + for LH), and a direction α falls on
// stitch `1 + floor((((α_seam − α)/2π) mod 1)·n + 1e-9)` (RH; mirrored for LH).
import type { Hand } from '../../types/units';

const TAU = 2 * Math.PI;

/** `x mod 1` in [0, 1). */
export function frac(x: number): number {
  const f = x - Math.floor(x);
  return f >= 1 ? 0 : f;
}

/**
 * α_seam(k) for every round k = 1 … counts.length (index k − 1), radians; 0 at `rRef` (1-based). Folded rounds
 * count once each (pass the unfolded counts).
 */
export function seamAngles(counts: readonly number[], rRef: number, lean: number, hand: Hand): number[] {
  const n = counts.length;
  const out = Array<number>(n).fill(0);
  if (n === 0 || !(lean !== 0 && Number.isFinite(lean))) return out;
  const h = hand === 'left' ? -1 : 1;
  const ref = Math.min(Math.max(1, Math.round(rRef)), n);
  for (let k = ref + 1; k <= n; k++) out[k - 1] = out[k - 2] + (h * TAU * lean) / counts[k - 1];
  for (let k = ref - 1; k >= 1; k--) out[k - 1] = out[k] - (h * TAU * lean) / counts[k];
  return out;
}

/** Position of direction α along a round, in stitches from the marker (0 … n), counting in the working direction. */
export function stitchPosition(alpha: number, alphaSeam: number, n: number, hand: Hand): number {
  const u = hand === 'left' ? frac((alpha - alphaSeam) / TAU) : frac((alphaSeam - alpha) / TAU);
  return u * n;
}

/** The 1-based stitch a direction α falls on (§2.12 item 2). */
export function stitchAt(alpha: number, alphaSeam: number, n: number, hand: Hand): number {
  return Math.min(n, 1 + Math.floor(stitchPosition(alpha, alphaSeam, n, hand) + 1e-9));
}

/**
 * The gap between two stitches nearest to direction α: `g` means "the gap after st g" (between sts g and g + 1;
 * g = n is the gap at the marker, after the last st). Safety-eye posts go in gaps (§2.10.6).
 */
export function gapAt(alpha: number, alphaSeam: number, n: number, hand: Hand): number {
  const g = Math.round(stitchPosition(alpha, alphaSeam, n, hand) + 1e-9);
  return g === 0 ? n : g;
}

/** The azimuth of the center of stitch j (0-based) of a round. */
export function stitchAngle(j: number, n: number, alphaSeam: number, hand: Hand): number {
  const step = (TAU * (j + 0.5)) / n;
  return hand === 'left' ? alphaSeam + step : alphaSeam - step;
}
