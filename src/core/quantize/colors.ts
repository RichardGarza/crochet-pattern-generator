// Small color helpers of the quantizer: features ↔ CIELAB / hex, ΔE00 between features. Track T1, sprint T1.2.
import { ciede2000, featureToHex, featureToOklab, hexToFeature, hexToLab, linearRgbToLab, oklabToLinearRgb, type Color3 } from '../kernel/color';

/** A cluster feature (toe(L), 2a, 2b) → CIELAB (D65), without gamut clipping. */
export function featureToLab(f0: number, f1: number, f2: number): Color3 {
  const [L, a, b] = featureToOklab(f0, f1, f2);
  const [r, g, bb] = oklabToLinearRgb(L, a, b);
  return linearRgbToLab(r, g, bb);
}

/** Feature `k` of a packed array → CIELAB. */
export function labAt(f: ArrayLike<number>, k: number): Color3 {
  return featureToLab(f[k * 3], f[k * 3 + 1], f[k * 3 + 2]);
}

/** Feature `k` of a packed array → `#rrggbb` (clipped to sRGB). */
export function hexAt(f: ArrayLike<number>, k: number): string {
  return featureToHex(f[k * 3], f[k * 3 + 1], f[k * 3 + 2]);
}

/** ΔE00 between two features. */
export function deltaE00Features(p: ArrayLike<number>, i: number, q: ArrayLike<number>, j: number): number {
  return ciede2000(labAt(p, i), labAt(q, j));
}

/** Packed features of a list of hex colors. */
export function hexesToFeatures(hexes: readonly string[]): Float64Array<ArrayBuffer> {
  const out = new Float64Array(hexes.length * 3);
  hexes.forEach((h, k) => out.set(hexToFeature(h), k * 3));
  return out;
}

/** Packed CIELAB of a list of hex colors. */
export function hexesToLab(hexes: readonly string[]): Float64Array<ArrayBuffer> {
  const out = new Float64Array(hexes.length * 3);
  hexes.forEach((h, k) => out.set(hexToLab(h), k * 3));
  return out;
}
