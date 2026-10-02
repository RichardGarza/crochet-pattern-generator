// Weighted feature points for the quantizer (DESIGN.md §2.4.2). Track T1, sprint T1.2. Pure, no DOM.
//
// Points are cluster features (toe(L), 2a, 2b) with weights: photos and pixel art give one point per cell
// (identical cells pooled), flat art a per-pixel histogram on 5-bit-per-channel sRGB bins (≤ 32 768 points)
// whose point is the mean feature of its pixels.
import { linearToSrgb8 } from '../kernel/color';
import { linearToFeature } from '../image2d/linear';
import type { LinearImage } from '../image2d/types';

/** Weighted points in feature space: point p is `(f[3p], f[3p+1], f[3p+2])` with weight `w[p] > 0`. */
export interface WeightedPoints {
  n: number;
  f: Float64Array<ArrayBuffer>;
  w: Float64Array<ArrayBuffer>;
}

/** Total weight. */
export function totalWeight(p: WeightedPoints): number {
  let s = 0;
  for (let i = 0; i < p.n; i++) s += p.w[i];
  return s;
}

/**
 * One point per distinct feature among the included cells (`include[i]` non-zero, or every cell), weighted by
 * how many cells share it. `index[i]` is cell i's point (−1 when excluded). Points keep the order of first
 * appearance, so the result does not depend on hashing order.
 */
export function cellPoints(feat: Float32Array, include?: Uint8Array): { points: WeightedPoints; index: Int32Array<ArrayBuffer> } {
  const n = feat.length / 3;
  const bits = new Uint32Array(feat.buffer, feat.byteOffset, n * 3);
  const index = new Int32Array(n).fill(-1);
  const seen = new Map<string, number>();
  const f: number[] = [];
  const w: number[] = [];
  for (let i = 0; i < n; i++) {
    if (include !== undefined && !include[i]) continue;
    const key = `${bits[i * 3]},${bits[i * 3 + 1]},${bits[i * 3 + 2]}`;
    let p = seen.get(key);
    if (p === undefined) {
      p = w.length;
      seen.set(key, p);
      f.push(feat[i * 3], feat[i * 3 + 1], feat[i * 3 + 2]);
      w.push(0);
    }
    w[p] += 1;
    index[i] = p;
  }
  return { points: { n: w.length, f: Float64Array.from(f), w: Float64Array.from(w) }, index };
}

/** 32 768 bins: 5 bits per sRGB channel. */
export const HISTOGRAM_BINS = 32768;
/** Pixels less than half opaque are background and are not counted (§2.3.2). */
const OPAQUE = 0.5;

let srgbLut: Uint8Array | undefined;
/** linear (0..1) → sRGB8, through a 65 536-entry table (exact to within one code value; exact for bins). */
function srgb8Lut(): Uint8Array {
  if (srgbLut === undefined) {
    srgbLut = new Uint8Array(65536);
    for (let i = 0; i < 65536; i++) srgbLut[i] = linearToSrgb8(i / 65535);
  }
  return srgbLut;
}

/** The pixel histogram of a flat-art working image. */
export interface PixelHistogram {
  /** Non-empty bins as points (mean feature of the bin's pixels, weight = pixel count). */
  points: WeightedPoints;
  /** Bin number (0..32767) of every pixel, −1 for background pixels (α < 0.5). */
  pixelBin: Int32Array<ArrayBuffer>;
  /** Point index of every bin (−1 for an empty bin). */
  binPoint: Int32Array<ArrayBuffer>;
}

/** Histograms of working images already seen (they depend only on the image: a size change reuses it). */
const histogramCache = new WeakMap<LinearImage, PixelHistogram>();

/**
 * The §2.4.2 flat-art histogram: 5-bit sRGB bins of the straight color of every pixel with α ≥ 0.5. Memoized
 * per image object (the cached `PreparedWork` image), so the result is shared and must be treated as
 * read-only.
 */
export function pixelHistogram(img: LinearImage): PixelHistogram {
  const hit = histogramCache.get(img);
  if (hit !== undefined && hit.pixelBin.length === img.w * img.h) return hit;
  const out = computeHistogram(img);
  histogramCache.set(img, out);
  return out;
}

function computeHistogram(img: LinearImage): PixelHistogram {
  const lut = srgb8Lut();
  const n = img.w * img.h;
  const d = img.data;
  const pixelBin = new Int32Array(n).fill(-1);
  const count = new Float64Array(HISTOGRAM_BINS);
  const sumR = new Float64Array(HISTOGRAM_BINS);
  const sumG = new Float64Array(HISTOGRAM_BINS);
  const sumB = new Float64Array(HISTOGRAM_BINS);
  const q = (v: number): number => lut[v <= 0 ? 0 : v >= 1 ? 65535 : Math.round(v * 65535)] >> 3;
  for (let i = 0; i < n; i++) {
    const a = d[i * 4 + 3];
    if (!(a >= OPAQUE)) continue;
    const r = a === 1 ? d[i * 4] : d[i * 4] / a;
    const g = a === 1 ? d[i * 4 + 1] : d[i * 4 + 1] / a;
    const b = a === 1 ? d[i * 4 + 2] : d[i * 4 + 2] / a;
    const bin = (q(r) << 10) | (q(g) << 5) | q(b);
    pixelBin[i] = bin;
    count[bin]++;
    sumR[bin] += r;
    sumG[bin] += g;
    sumB[bin] += b;
  }
  const binPoint = new Int32Array(HISTOGRAM_BINS).fill(-1);
  let m = 0;
  for (let b = 0; b < HISTOGRAM_BINS; b++) if (count[b] > 0) binPoint[b] = m++;
  const f = new Float64Array(m * 3);
  const w = new Float64Array(m);
  for (let b = 0; b < HISTOGRAM_BINS; b++) {
    const p = binPoint[b];
    if (p < 0) continue;
    // The bin's point is the feature of its mean linear color (averaging in linear light, §2.4.1).
    const c = count[b];
    const ft = linearToFeature(sumR[b] / c, sumG[b] / c, sumB[b] / c);
    f[p * 3] = ft[0];
    f[p * 3 + 1] = ft[1];
    f[p * 3 + 2] = ft[2];
    w[p] = c;
  }
  return { points: { n: m, f, w }, pixelBin, binPoint };
}
