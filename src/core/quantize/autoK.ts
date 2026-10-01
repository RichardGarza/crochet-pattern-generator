// Choosing K (DESIGN.md §2.4.3; research 06 §2.4). Track T1, sprint T1.2. Pure, no DOM.
//
// Technique limits (default K, max K, per-line cap) and auto-K: quantize K = 2…Kmax, D(K) = √(SSE/W), normalize
// K and D to [0, 1], knee = argmax (1 − y_n) − x_n (Kneedle on a decreasing curve; ties → the smaller K).
import type { TechniqueId } from '../../types/gauge';
import { totalWeight, type WeightedPoints } from './points';
import { lloyd, quantize, varianceSplitSequence, type Quantized } from './quantize';

export interface TechniqueColorLimits {
  defaultK: number;
  maxK: number;
  /** Colors per row / diagonal / round before a warning (§2.4.3 "per-line cap"). */
  perLine: number;
}

/** §2.4.3 table. */
export const TECHNIQUE_COLOR_LIMITS: Readonly<Record<TechniqueId, TechniqueColorLimits>> = {
  sc_graphgan: { defaultK: 8, maxK: 16, perLine: 6 },
  hdc_graphgan: { defaultK: 8, maxK: 16, perLine: 6 },
  c2c: { defaultK: 8, maxK: 16, perLine: 6 },
  sc_tapestry: { defaultK: 5, maxK: 8, perLine: 3 },
  sc_tapestry_round: { defaultK: 5, maxK: 8, perLine: 3 },
  // Overlay mosaic works two colors a row; its K follows the graph techniques until T2's writer says otherwise.
  mosaic_overlay: { defaultK: 8, maxK: 16, perLine: 2 },
  amigurumi_sc: { defaultK: 6, maxK: 8, perLine: 2 },
};

export function colorLimits(technique: TechniqueId): TechniqueColorLimits {
  const l = TECHNIQUE_COLOR_LIMITS[technique];
  if (l === undefined) throw new RangeError(`colorLimits: unknown technique ${String(technique)}`);
  return l;
}

/**
 * The color budget of a chart: `maxColors` (clamped to 1…maxK) or, for 'auto', the technique's maxK as the cap
 * of auto-K. Protected centers (salient details, hand-edit colors) count against it (§2.4.3, §5.5.5).
 */
export function colorBudget(technique: TechniqueId, maxColors: number | 'auto'): { cap: number; auto: boolean } {
  const { maxK } = colorLimits(technique);
  if (maxColors === 'auto') return { cap: maxK, auto: true };
  if (typeof maxColors !== 'number' || !Number.isFinite(maxColors)) throw new RangeError(`colorBudget: maxColors must be a number or 'auto', got ${String(maxColors)}`);
  return { cap: Math.min(maxK, Math.max(1, Math.floor(maxColors))), auto: false };
}

/** Distortion D(K) = √(SSE / W) in ΔEOKr2 units. */
export function distortion(p: WeightedPoints, q: Quantized): number {
  const W = totalWeight(p);
  return W > 0 ? Math.sqrt(q.sse / W) : 0;
}

/** The knee of a decreasing curve D(K), K = kMin…: argmax (1 − y_n) − x_n, ties → smallest K. */
export function kneeIndex(d: readonly number[]): number {
  const n = d.length;
  if (n <= 1) return 0;
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of d) {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  if (!(hi - lo > 1e-12)) return 0; // flat curve: the smallest K already explains everything
  let best = 0;
  let bv = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = i / (n - 1);
    const y = (d[i] - lo) / (hi - lo);
    const v = 1 - y - x;
    if (v > bv + 1e-12) {
      bv = v;
      best = i;
    }
  }
  return best;
}

export interface AutoK {
  k: number;
  /** D(K) for K = 2…kMax (index 0 is K = 2). */
  curve: number[];
  /** The quantization at the chosen K. */
  result: Quantized;
}

/**
 * Auto-K (§2.4.3): the knee of D(K) over K = 2…kMax. With a single distinct color K = 1; when some K ≤ kMax
 * represents the points exactly (D = 0: at most kMax distinct colors) that K; with fewer distinct colors than
 * kMax the range stops there.
 */
export function chooseK(p: WeightedPoints, kMax: number): AutoK {
  if (!Number.isInteger(kMax) || kMax < 1) throw new RangeError(`chooseK: kMax must be a whole number ≥ 1, got ${kMax}`);
  if (p.n <= 1 || kMax === 1) {
    const result = quantize(p, 1);
    return { k: result.k, curve: [], result };
  }
  // The curve is measured on the points pooled to ΔEOKr2 0.02 cubes (1 JND) when there are many of them; the
  // chosen K is then quantized on the points themselves.
  const c = p.n > CURVE_MAX_POINTS ? coarsePoints(p, CURVE_BIN) : p;
  const seq = varianceSplitSequence(c, Math.min(kMax, c.n));
  const results: Quantized[] = [];
  const curve: number[] = [];
  for (let k = 2; k <= seq.length; k++) {
    const q = lloyd(c, seq[k - 1]);
    results.push(q);
    curve.push(distortion(c, q));
  }
  if (results.length === 0) {
    const result = quantize(p, 1);
    return { k: result.k, curve, result };
  }
  // When some K represents the points exactly (few distinct colors: pixel art, clean graphics) that K is used:
  // every color fits the budget, so none is dropped. Otherwise the knee.
  const exact = curve.findIndex((d) => d <= EXACT_D);
  const i = exact >= 0 ? exact : kneeIndex(curve);
  const k = results[i].k;
  return { k, curve, result: c === p ? results[i] : quantize(p, k) };
}

/** D(K) at or below this is an exact representation (feature units). */
export const EXACT_D = 1e-9;
/** Above this many points the D(K) curve is measured on pooled points. */
export const CURVE_MAX_POINTS = 4096;
/** Pooling cube side for the curve, ΔEOKr2 (≈ 1 JND). */
export const CURVE_BIN = 0.02;

/** Points pooled into cubes of side `step` in feature space (weighted mean per cube, first-seen order). */
export function coarsePoints(p: WeightedPoints, step: number): WeightedPoints {
  const index = new Map<string, number>();
  const f: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < p.n; i++) {
    const key = `${Math.floor(p.f[i * 3] / step)},${Math.floor(p.f[i * 3 + 1] / step)},${Math.floor(p.f[i * 3 + 2] / step)}`;
    let q = index.get(key);
    if (q === undefined) {
      q = w.length;
      index.set(key, q);
      f.push(0, 0, 0);
      w.push(0);
    }
    const wi = p.w[i];
    w[q] += wi;
    f[q * 3] += wi * p.f[i * 3];
    f[q * 3 + 1] += wi * p.f[i * 3 + 1];
    f[q * 3 + 2] += wi * p.f[i * 3 + 2];
  }
  for (let q = 0; q < w.length; q++) {
    f[q * 3] /= w[q];
    f[q * 3 + 1] /= w[q];
    f[q * 3 + 2] /= w[q];
  }
  return { n: w.length, f: Float64Array.from(f), w: Float64Array.from(w) };
}
