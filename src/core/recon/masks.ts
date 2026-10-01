// Track T3 — foreground masks: the always-available classical ladder (DESIGN.md §2.9.1, research 04 §3.2, §12).
//
//   photo → ≤ 512 px (linear-light area filter) → OKLab features → 1–3 background clusters from the border band
//   → background = bg-like pixels connected to the photo border → largest component → shadow heuristic
//   → fill holes (unless keepHoles) → open(1) → close(closeR) → user brush locks.
//
// Masks are Uint8Arrays of w·h bytes, row-major from the top-left, 1 = object (foreground), 0 = background. They
// live on the mask grid (≤ 512 px on the long side); `scale` maps photo pixels to mask pixels. Morphology uses
// the Step 0 exact distance transforms (`core/kernel/geom/edt`), so opening and closing use true discs.
// Everything is deterministic: no randomness, fixed iteration orders, ties to the lowest index.
import { featureToHex, linearToSrgb8, oklabFeatures, srgb8ToLinear } from '../kernel/color';
import { edt2d } from '../kernel/geom/edt';
import type { RgbaImage } from '../../types/geometry';
import type { Issue } from '../../types/issues';

// ---------------------------------------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------------------------------------

export interface MaskOptions {
  /** Width of the border band sampled for the background model, as a fraction of the shorter side. */
  band: number;
  /** A pixel is background-like when its ΔEOKr2 to the nearest background cluster is below tau. */
  tau: number;
  /** Radius (mask px) of the final closing; the opening before it always has radius 1. */
  closeR: number;
  /** Keep enclosed background (a mug handle, an arm loop) instead of filling it. */
  keepHoles: boolean;
  /** Long side of the mask grid, px. */
  maxSide: number;
  /** Apply the floor-shadow heuristic (bottom 25% of the object's box). */
  shadow: boolean;
}

/** §2.9.1 defaults. `maxSide` 512 and `shadow` on are the spec's fixed choices, exposed for tests. */
export const MASK_DEFAULTS: Readonly<MaskOptions> = Object.freeze({
  band: 0.04,
  tau: 0.14,
  closeR: 2,
  keepHoles: false,
  maxSide: 512,
  shadow: true,
});

/** Shadow heuristic (§2.9.1): darker than the local background by more than this (toe'd OKLab L) … */
export const SHADOW_MIN_DARKEN = 0.1;
/** … but not by more than this: a cast shadow keeps some light; a dark object does not look like one. */
export const SHADOW_MAX_DARKEN = 0.5;
/** … and with a chroma (OKLab) within this of the local background. */
export const SHADOW_MAX_DCHROMA = 0.06;
/** … inside this bottom fraction of the object's bounding box. */
export const SHADOW_BOTTOM_FRACTION = 0.25;

/** … and not within this ΔEOKr2 of the object's colors in the strip just above the band … */
export const SHADOW_OBJECT_DISTANCE = 0.07;
/** … a strip this fraction of the object's box high. */
export const SHADOW_OBJECT_STRIP = 0.15;

/** At most this many background clusters (§2.9.1: 1–3: wall, floor, shadow). */
export const MAX_BG_CLUSTERS = 3;
/** A background cluster other than the largest is kept only if it holds at least this share of the border band … */
export const MIN_BG_CLUSTER_SHARE = 0.05;
/** … and at least this share of the band's samples on each of several sides of the photo … */
export const MIN_SIDE_SHARE = 0.03;
/** … on at least this many sides (a wall or a floor reaches three). */
export const MIN_SIDES = 3;

/** Guards (§2.9.1, F2 step 3): coverage outside [MIN, MAX] of the photo warns. */
export const MIN_COVERAGE = 0.15;
export const MAX_COVERAGE = 0.9;

export interface Mask {
  mask: Uint8Array<ArrayBuffer>;
  w: number;
  h: number;
}

export interface BackgroundCluster {
  /** The cluster mean as `#rrggbb`. */
  hex: string;
  /** Its share of the (opaque) border-band samples. */
  share: number;
}

export interface ClassicalMaskResult extends Mask {
  /** Mask pixels per photo pixel (≤ 1): mask = photo · scale. */
  scale: number;
  /**
   * The mask before the cleanup steps (after flood fill and shadow removal): `refineMask(raw, …)` re-runs the last
   * steps after a brush edit without recomputing the background model.
   */
  raw: Uint8Array<ArrayBuffer>;
  background: BackgroundCluster[];
  /** Pixels the shadow heuristic moved to the background. */
  shadowPixels: number;
  /** The guards of §2.9.1 on the final mask (`maskGuards`). */
  issues: Issue[];
}

// ---------------------------------------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------------------------------------

function checkSize(w: number, h: number): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new RangeError(`mask size must be integers ≥ 1, got ${w} × ${h}`);
}

function checkMask(mask: ArrayLike<number>, w: number, h: number): void {
  checkSize(w, h);
  if (mask.length !== w * h) throw new RangeError(`mask has ${mask.length} entries, expected ${w} × ${h} = ${w * h}`);
}

function checkImage(img: RgbaImage): void {
  checkSize(img.w, img.h);
  if (img.data.length !== img.w * img.h * 4) throw new RangeError(`image data has ${img.data.length} bytes, expected ${img.w * img.h * 4}`);
}

// ---------------------------------------------------------------------------------------------------------
// Downscale (linear light, premultiplied alpha, exact area weights)
// ---------------------------------------------------------------------------------------------------------

/**
 * The mask grid for a w × h photo: the long side at most `maxSide`, aspect kept, each side ≥ 1. `scale` is the
 * nominal factor (maxSide / long side); after rounding, the short side's own factor can differ slightly (by under
 * half a mask pixel over the whole side; more only for photos a few pixels thick).
 */
export function maskGridSize(w: number, h: number, maxSide = MASK_DEFAULTS.maxSide): { w: number; h: number; scale: number } {
  checkSize(w, h);
  if (!Number.isInteger(maxSide) || maxSide < 1) throw new RangeError(`maxSide must be an integer ≥ 1, got ${maxSide}`);
  const long = Math.max(w, h);
  if (long <= maxSide) return { w, h, scale: 1 };
  const scale = maxSide / long;
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale };
}

/** Per output index: the source indices it covers and their area weights (summing to 1). */
function areaWeights(src: number, dst: number): { start: Int32Array; count: Int32Array; weights: Float64Array } {
  const ratio = src / dst;
  const start = new Int32Array(dst);
  const count = new Int32Array(dst);
  const list: number[] = [];
  for (let o = 0; o < dst; o++) {
    const a = o * ratio;
    const b = Math.min(src, (o + 1) * ratio);
    const i0 = Math.floor(a);
    const i1 = Math.min(src, Math.ceil(b));
    start[o] = list.length;
    for (let i = i0; i < i1; i++) {
      const cover = Math.min(b, i + 1) - Math.max(a, i);
      list.push(i, cover / ratio);
    }
    count[o] = (list.length - start[o]) / 2;
  }
  return { start, count, weights: Float64Array.from(list) };
}

/**
 * The photo on the mask grid: an exact area (box) filter in linear light with premultiplied alpha (never a
 * browser scaler, §2.3.1). An image that already fits is returned as is.
 */
export function downscaleToMaskGrid(img: RgbaImage, maxSide = MASK_DEFAULTS.maxSide): { image: RgbaImage; scale: number } {
  checkImage(img);
  const size = maskGridSize(img.w, img.h, maxSide);
  if (size.w === img.w && size.h === img.h) return { image: img, scale: 1 };
  const { w: W, h: H } = size;
  const xs = areaWeights(img.w, W);
  const ys = areaWeights(img.h, H);
  const acc = new Float64Array(W * H * 4);
  const row = new Float64Array(W * 4);
  const lin = new Float64Array(img.w * 4);
  const d = img.data;
  const toLinear = new Float64Array(256);
  for (let v = 0; v < 256; v++) toLinear[v] = srgb8ToLinear(v);
  // Source row → premultiplied linear → horizontally filtered → added into the output rows it covers.
  const rowTargets: number[][] = Array.from({ length: img.h }, () => []);
  for (let o = 0; o < H; o++) {
    for (let k = 0; k < ys.count[o]; k++) {
      const p = ys.start[o] + 2 * k;
      rowTargets[ys.weights[p]].push(o, ys.weights[p + 1]);
    }
  }
  for (let y = 0; y < img.h; y++) {
    const targets = rowTargets[y];
    if (targets.length === 0) continue;
    for (let x = 0, s = y * img.w * 4; x < img.w; x++, s += 4) {
      const a = d[s + 3] / 255;
      lin[4 * x] = toLinear[d[s]] * a;
      lin[4 * x + 1] = toLinear[d[s + 1]] * a;
      lin[4 * x + 2] = toLinear[d[s + 2]] * a;
      lin[4 * x + 3] = a;
    }
    for (let o = 0; o < W; o++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      const end = xs.start[o] + 2 * xs.count[o];
      for (let p = xs.start[o]; p < end; p += 2) {
        const q = xs.weights[p] * 4;
        const wgt = xs.weights[p + 1];
        r += lin[q] * wgt;
        g += lin[q + 1] * wgt;
        b += lin[q + 2] * wgt;
        a += lin[q + 3] * wgt;
      }
      row[o * 4] = r;
      row[o * 4 + 1] = g;
      row[o * 4 + 2] = b;
      row[o * 4 + 3] = a;
    }
    for (let t = 0; t < targets.length; t += 2) {
      const base = targets[t] * W * 4;
      const wgt = targets[t + 1];
      for (let i = 0; i < W * 4; i++) acc[base + i] += row[i] * wgt;
    }
  }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const a = acc[i * 4 + 3];
    if (a > 0) {
      out[i * 4] = linearToSrgb8(acc[i * 4] / a);
      out[i * 4 + 1] = linearToSrgb8(acc[i * 4 + 1] / a);
      out[i * 4 + 2] = linearToSrgb8(acc[i * 4 + 2] / a);
    }
    out[i * 4 + 3] = Math.round(Math.min(1, a) * 255);
  }
  return { image: { w: W, h: H, data: out }, scale: size.scale };
}

// ---------------------------------------------------------------------------------------------------------
// Border band and background clusters
// ---------------------------------------------------------------------------------------------------------

/** Width (px) of the border band for a w × h grid: `band` × the shorter side, at least 1. */
export function borderBandWidth(w: number, h: number, band = MASK_DEFAULTS.band): number {
  checkSize(w, h);
  if (!(band >= 0) || !Number.isFinite(band)) throw new RangeError(`band must be a finite number ≥ 0, got ${band}`);
  return Math.max(1, Math.min(Math.ceil(Math.min(w, h) / 2), Math.round(band * Math.min(w, h))));
}

/** Indices of the pixels within `width` px of the image frame, in row-major order. */
export function borderBand(w: number, h: number, width: number): Int32Array<ArrayBuffer> {
  checkSize(w, h);
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < width || y < width || x >= w - width || y >= h - width) out.push(x + w * y);
    }
  }
  return Int32Array.from(out);
}

/** Per band pixel, the sides of the image it lies within `width` px of: 1 top, 2 bottom, 4 left, 8 right. */
export function bandSides(band: ArrayLike<number>, w: number, h: number, width: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(band.length);
  for (let s = 0; s < band.length; s++) {
    const x = band[s] % w;
    const y = (band[s] - x) / w;
    out[s] = (y < width ? 1 : 0) | (y >= h - width ? 2 : 0) | (x < width ? 4 : 0) | (x >= w - width ? 8 : 0);
  }
  return out;
}

function dist2(f: ArrayLike<number>, i: number, c: ArrayLike<number>, k: number): number {
  const d0 = f[3 * i] - c[3 * k];
  const d1 = f[3 * i + 1] - c[3 * k + 1];
  const d2 = f[3 * i + 2] - c[3 * k + 2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

/** Nearest center of sample i (ties → the lower center) and its squared distance. */
function nearest(f: ArrayLike<number>, i: number, centers: ArrayLike<number>, k: number): [number, number] {
  let best = 0;
  let bestD = Infinity;
  for (let c = 0; c < k; c++) {
    const d = dist2(f, i, centers, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return [best, bestD];
}

function lloyd(f: ArrayLike<number>, samples: ArrayLike<number>, centers: Float64Array, k: number, assign: Int32Array): void {
  for (let iter = 0; iter < 25; iter++) {
    let changed = false;
    for (let s = 0; s < samples.length; s++) {
      const [c] = nearest(f, samples[s], centers, k);
      if (assign[s] !== c) {
        assign[s] = c;
        changed = true;
      }
    }
    const sum = new Float64Array(k * 3);
    const n = new Float64Array(k);
    for (let s = 0; s < samples.length; s++) {
      const c = assign[s];
      const i = samples[s];
      sum[3 * c] += f[3 * i];
      sum[3 * c + 1] += f[3 * i + 1];
      sum[3 * c + 2] += f[3 * i + 2];
      n[c]++;
    }
    for (let c = 0; c < k; c++) {
      if (n[c] === 0) continue; // keeps its old center
      centers[3 * c] = sum[3 * c] / n[c];
      centers[3 * c + 1] = sum[3 * c + 1] / n[c];
      centers[3 * c + 2] = sum[3 * c + 2] / n[c];
    }
    if (!changed && iter > 0) break;
  }
}

/**
 * 1–`maxK` background clusters of the given feature samples (§2.9.1 `quantize(sampleBorderBand(f), 3)`),
 * deterministic: start from the mean; while the sample farthest from every center is more than tau/2 away and
 * fewer than maxK centers exist, that sample (lowest index on ties) becomes a new center; Lloyd iterations after
 * each step. Every cluster but the largest must hold at least `minShare` of the samples and, when `sides` is given
 * (per sample, a bit mask of the image sides it lies on: 1 top, 2 bottom, 4 left, 8 right), appear on at least
 * MIN_SIDES sides with at least MIN_SIDE_SHARE of each side's samples: a wall (top, left, right) or a floor (bottom,
 * left, right) reaches three sides; an object cut by one or two edges of the photo (a corner, top and bottom) does
 * not, so it is not taken for background. Kept clusters come most populous
 * first. Returns the centers as features (Float64Array of k·3) and their shares; k = 0 when there are no samples.
 */
export function backgroundClusters(
  features: ArrayLike<number>,
  samples: ArrayLike<number>,
  o: { tau?: number; maxK?: number; minShare?: number; sides?: ArrayLike<number> } = {},
): { centers: Float64Array; shares: number[] } {
  const tau = o.tau ?? MASK_DEFAULTS.tau;
  const maxK = o.maxK ?? MAX_BG_CLUSTERS;
  const minShare = o.minShare ?? MIN_BG_CLUSTER_SHARE;
  if (o.sides && o.sides.length !== samples.length) throw new RangeError('sides must have one entry per sample');
  const n = samples.length;
  if (n === 0) return { centers: new Float64Array(0), shares: [] };
  const centers = new Float64Array(maxK * 3);
  for (let s = 0; s < n; s++) {
    const i = samples[s];
    centers[0] += features[3 * i];
    centers[1] += features[3 * i + 1];
    centers[2] += features[3 * i + 2];
  }
  centers[0] /= n;
  centers[1] /= n;
  centers[2] /= n;
  const assign = new Int32Array(n);
  let k = 1;
  lloyd(features, samples, centers, k, assign);
  const split2 = (tau / 2) * (tau / 2);
  while (k < maxK) {
    let far = -1;
    let farD = split2;
    for (let s = 0; s < n; s++) {
      const [, d] = nearest(features, samples[s], centers, k);
      if (d > farD) {
        farD = d;
        far = s;
      }
    }
    if (far < 0) break;
    const i = samples[far];
    centers[3 * k] = features[3 * i];
    centers[3 * k + 1] = features[3 * i + 1];
    centers[3 * k + 2] = features[3 * i + 2];
    k++;
    lloyd(features, samples, centers, k, assign);
  }
  const counts = new Array<number>(k).fill(0);
  for (let s = 0; s < n; s++) counts[assign[s]]++;
  const order = counts.map((_c, i) => i).sort((a, b) => counts[b] - counts[a] || a - b);
  const onSides = (c: number): number => {
    const sides = o.sides;
    if (!sides) return 4;
    const per = [0, 0, 0, 0];
    const total = [0, 0, 0, 0];
    for (let s = 0; s < n; s++) {
      for (let b = 0; b < 4; b++) {
        if ((sides[s] & (1 << b)) === 0) continue;
        total[b]++;
        if (assign[s] === c) per[b]++;
      }
    }
    return per.filter((v, b) => total[b] > 0 && v / total[b] >= MIN_SIDE_SHARE).length;
  };
  const kept = order.filter((c, rank) => rank === 0 || (counts[c] / n >= minShare && onSides(c) >= MIN_SIDES));
  const out = new Float64Array(kept.length * 3);
  kept.forEach((c, j) => out.set(centers.subarray(3 * c, 3 * c + 3), 3 * j));
  return { centers: out, shares: kept.map((c) => counts[c] / n) };
}

// ---------------------------------------------------------------------------------------------------------
// Flood fill and connected components
// ---------------------------------------------------------------------------------------------------------

/**
 * Background = candidate pixels 4-connected to the image frame through candidates (§2.9.1: "connected background
 * only", so the object's own background-colored areas stay). Returns 1 for background, 0 otherwise.
 */
export function floodFillFromBorder(w: number, h: number, isCandidate: (i: number) => boolean): Uint8Array<ArrayBuffer> {
  checkSize(w, h);
  const out = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const seed = (i: number): void => {
    if (out[i] === 0 && isCandidate(i)) {
      out[i] = 1;
      queue[tail++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed(x + w * (h - 1));
  }
  for (let y = 0; y < h; y++) {
    seed(w * y);
    seed(w - 1 + w * y);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  return out;
}

/**
 * Connected components of the pixels equal to `value` (4- or 8-connected). `labels` is −1 elsewhere; components
 * are numbered in scan order of their first pixel.
 */
export function connectedComponents(
  mask: ArrayLike<number>,
  w: number,
  h: number,
  o: { value?: 0 | 1; connectivity?: 4 | 8 } = {},
): { labels: Int32Array<ArrayBuffer>; sizes: number[]; touchesBorder: boolean[] } {
  checkMask(mask, w, h);
  const want = o.value ?? 1;
  const eight = (o.connectivity ?? 8) === 8;
  const is = (i: number): boolean => (mask[i] !== 0 ? 1 : 0) === want;
  const labels = new Int32Array(w * h).fill(-1);
  const sizes: number[] = [];
  const touchesBorder: boolean[] = [];
  const queue = new Int32Array(w * h);
  for (let start = 0; start < w * h; start++) {
    if (labels[start] !== -1 || !is(start)) continue;
    const id = sizes.length;
    let size = 0;
    let border = false;
    let head = 0;
    let tail = 0;
    labels[start] = id;
    queue[tail++] = start;
    while (head < tail) {
      const i = queue[head++];
      size++;
      const x = i % w;
      const y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) border = true;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          if (!eight && dx !== 0 && dy !== 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const j = nx + w * ny;
          if (labels[j] === -1 && is(j)) {
            labels[j] = id;
            queue[tail++] = j;
          }
        }
      }
    }
    sizes.push(size);
    touchesBorder.push(border);
  }
  return { labels, sizes, touchesBorder };
}

/** The largest 8-connected foreground component (ties → the one found first in scan order). */
export function keepLargestComponent(mask: ArrayLike<number>, w: number, h: number): Uint8Array<ArrayBuffer> {
  const { labels, sizes } = connectedComponents(mask, w, h, { value: 1, connectivity: 8 });
  const out = new Uint8Array(w * h);
  if (sizes.length === 0) return out;
  let best = 0;
  for (let c = 1; c < sizes.length; c++) if (sizes[c] > sizes[best]) best = c;
  for (let i = 0; i < w * h; i++) if (labels[i] === best) out[i] = 1;
  return out;
}

/** Fills enclosed background: 4-connected background components that do not touch the image frame. */
export function fillHoles(mask: ArrayLike<number>, w: number, h: number): Uint8Array<ArrayBuffer> {
  const { labels, touchesBorder } = connectedComponents(mask, w, h, { value: 0, connectivity: 4 });
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] !== 0 || (labels[i] >= 0 && !touchesBorder[labels[i]]) ? 1 : 0;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Morphology with disc structuring elements (exact EDT, Step 0 kernel)
// ---------------------------------------------------------------------------------------------------------

function checkRadius(r: number): void {
  if (!(r >= 0) || !Number.isFinite(r)) throw new RangeError(`radius must be a finite number ≥ 0, got ${r}`);
}

/** Pixels within distance r (px, centers) of the mask: dilation by a disc. r = 0 copies. */
export function dilate(mask: ArrayLike<number>, w: number, h: number, r: number): Uint8Array<ArrayBuffer> {
  checkMask(mask, w, h);
  checkRadius(r);
  const d = edt2d(mask, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = d[i] <= r ? 1 : 0;
  return out;
}

/**
 * Pixels whose distance to the nearest background pixel exceeds r: erosion by a disc. The image frame is not
 * background (a mask touching the frame is not eaten from it).
 */
export function erode(mask: ArrayLike<number>, w: number, h: number, r: number): Uint8Array<ArrayBuffer> {
  checkMask(mask, w, h);
  checkRadius(r);
  const inv = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) inv[i] = mask[i] !== 0 ? 0 : 1;
  const d = edt2d(inv, w, h);
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = mask[i] !== 0 && d[i] > r ? 1 : 0;
  return out;
}

/** Opening (erode, then dilate): removes specks and bridges thinner than 2r. */
export function morphOpen(mask: ArrayLike<number>, w: number, h: number, r: number): Uint8Array<ArrayBuffer> {
  return dilate(erode(mask, w, h, r), w, h, r);
}

/** Closing (dilate, then erode): fills notches and pinholes narrower than 2r. */
export function morphClose(mask: ArrayLike<number>, w: number, h: number, r: number): Uint8Array<ArrayBuffer> {
  return erode(dilate(mask, w, h, r), w, h, r);
}

// ---------------------------------------------------------------------------------------------------------
// Statistics, guards, IoU
// ---------------------------------------------------------------------------------------------------------

/** Pixel box [x0, x1) × [y0, y1); center and size in pixel units (pixel i covers [i, i + 1)). */
export interface MaskBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  w: number;
  h: number;
  cx: number;
  cy: number;
}

/** Bounding box of the foreground, or null for an empty mask. */
export function maskBox(mask: ArrayLike<number>, w: number, h: number): MaskBox | null {
  checkMask(mask, w, h);
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[x + w * y] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  x1++;
  y1++;
  return { x0, y0, x1, y1, w: x1 - x0, h: y1 - y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2 };
}

export interface MaskStats {
  area: number;
  /** area / (w·h). */
  coverage: number;
  box: MaskBox | null;
  /** Some foreground pixel lies on the image frame. */
  touchesBorder: boolean;
}

export function maskStats(mask: ArrayLike<number>, w: number, h: number): MaskStats {
  checkMask(mask, w, h);
  let area = 0;
  let touchesBorder = false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[x + w * y] === 0) continue;
      area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
    }
  }
  return { area, coverage: area / (w * h), box: maskBox(mask, w, h), touchesBorder };
}

/** Issue codes of the mask guards (proposed for §2.13 in docs/tracks/t3.md). */
export const MASK_ISSUES = {
  /** The object touches the photo border: its silhouette is cut. */
  border: 'W_MASK_BORDER',
  /** The mask covers less than 15% or more than 90% of the photo. */
  coverage: 'W_MASK_COVERAGE',
  /** Nothing was found. */
  empty: 'E_MASK_EMPTY',
} as const;

/**
 * Tags issues with the photo they are about (`where.view = PhotoView.id`, §2.9.1–2.9.2), in place; other `where`
 * fields are kept. `view` undefined leaves the issues as they are.
 */
export function withView<T extends Issue[]>(issues: T, view: string | undefined): T {
  if (view === undefined) return issues;
  for (const issue of issues) issue.where = { ...issue.where, view };
  return issues;
}

/**
 * §2.9.1 guards: the mask touches the photo border (ask for a re-shoot with margin); coverage < 15% or > 90%;
 * an empty mask is an error. `label` (e.g. "front") is used in the messages; `view` (the `PhotoView.id`) goes to
 * every issue's `where.view` (the worker's `mask()` does not know the id: its caller tags the issues with
 * `withView`).
 */
export function maskGuards(mask: ArrayLike<number>, w: number, h: number, label?: string, view?: string): Issue[] {
  return withView(guards(mask, w, h, label), view);
}

function guards(mask: ArrayLike<number>, w: number, h: number, label?: string): Issue[] {
  const s = maskStats(mask, w, h);
  const photo = label ? `the ${label} photo` : 'this photo';
  if (s.area === 0) {
    return [{ code: MASK_ISSUES.empty, severity: 'error', message: `No object was found in ${photo}. Paint it with the brush or try a plainer background.` }];
  }
  const issues: Issue[] = [];
  if (s.touchesBorder) {
    issues.push({
      code: MASK_ISSUES.border,
      severity: 'warn',
      message: `The object touches the edge of ${photo}, so part of it may be cut off. Re-take it with some space around the object.`,
    });
  }
  if (s.coverage < MIN_COVERAGE || s.coverage > MAX_COVERAGE) {
    const pct = Math.round(s.coverage * 100);
    issues.push({
      code: MASK_ISSUES.coverage,
      severity: 'warn',
      message:
        s.coverage < MIN_COVERAGE
          ? `The object fills only ${pct}% of ${photo}. Move closer or zoom in so it fills more of the frame.`
          : `The object fills ${pct}% of ${photo}. Step back so there is background all around it.`,
    });
  }
  return issues;
}

/** Intersection over union of two masks of the same size (1 when both are empty). */
export function maskIoU(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length) throw new RangeError(`masks differ in size: ${a.length} vs ${b.length}`);
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] !== 0;
    const q = b[i] !== 0;
    if (p && q) inter++;
    if (p || q) union++;
  }
  return union === 0 ? 1 : inter / union;
}

// ---------------------------------------------------------------------------------------------------------
// Brush locks and the cleanup steps
// ---------------------------------------------------------------------------------------------------------

/** One brush dab in mask pixels: a disc of radius r around (x, y) (pixel centers at i + ½). */
export interface BrushDab {
  x: number;
  y: number;
  r: number;
  mode: 'add' | 'erase';
}

/**
 * Paints brush dabs into a lock layer in place (+1 = forced object, −1 = forced background, 0 = free); later dabs
 * win. Returns the layer.
 */
export function paintLocks(locks: Int8Array<ArrayBuffer>, w: number, h: number, dabs: readonly BrushDab[]): Int8Array<ArrayBuffer> {
  checkMask(locks, w, h);
  for (const dab of dabs) {
    if (![dab.x, dab.y, dab.r].every(Number.isFinite) || dab.r < 0) throw new RangeError(`bad brush dab ${JSON.stringify(dab)}`);
    const v = dab.mode === 'add' ? 1 : -1;
    const r2 = dab.r * dab.r;
    for (let y = Math.max(0, Math.floor(dab.y - dab.r)); y < Math.min(h, Math.ceil(dab.y + dab.r)); y++) {
      for (let x = Math.max(0, Math.floor(dab.x - dab.r)); x < Math.min(w, Math.ceil(dab.x + dab.r)); x++) {
        const dx = x + 0.5 - dab.x;
        const dy = y + 0.5 - dab.y;
        if (dx * dx + dy * dy <= r2) locks[x + w * y] = v;
      }
    }
  }
  return locks;
}

function applyLocks(mask: Uint8Array<ArrayBuffer>, locks: ArrayLike<number> | undefined): Uint8Array<ArrayBuffer> {
  if (!locks) return mask;
  for (let i = 0; i < mask.length; i++) {
    if (locks[i] > 0) mask[i] = 1;
    else if (locks[i] < 0) mask[i] = 0;
  }
  return mask;
}

/**
 * The last steps of the ladder, re-run after every brush edit (§2.9.1): locks applied → largest component → fill
 * holes (unless keepHoles) → open(1) → close(closeR) → locks applied again, so painted pixels always win (an erased
 * gap between an arm and the body stays open; a painted ear stays even if it is not connected).
 */
export function refineMask(
  raw: ArrayLike<number>,
  w: number,
  h: number,
  o: { keepHoles?: boolean; closeR?: number } = {},
  locks?: ArrayLike<number>,
): Uint8Array<ArrayBuffer> {
  checkMask(raw, w, h);
  if (locks) checkMask(locks, w, h);
  const closeR = o.closeR ?? MASK_DEFAULTS.closeR;
  let m = applyLocks(Uint8Array.from(raw, (v) => (v !== 0 ? 1 : 0)), locks);
  m = keepLargestComponent(m, w, h);
  if (!(o.keepHoles ?? MASK_DEFAULTS.keepHoles)) m = fillHoles(m, w, h);
  m = morphClose(morphOpen(m, w, h, 1), w, h, closeR);
  return applyLocks(m, locks);
}

// ---------------------------------------------------------------------------------------------------------
// Shadow heuristic
// ---------------------------------------------------------------------------------------------------------

/**
 * §2.9.1 shadow heuristic, in place on `fg`: inside the bottom 25% of the object's box, foreground pixels that are
 * darker than the local background by 0.10…0.50 (toe'd OKLab L) with a chroma within 0.06 become background — but
 * only those 4-connected to the background through such pixels (a cast shadow lies on the floor next to the
 * background; a dark patch inside the object does not), and none within ΔEOKr2 0.07 of the object's own colors in
 * the strip just above the band (the object continuing downward is not a shadow). The local background is the mean
 * of the background pixels in the rows of that band (else `fallback`, the main background cluster). Returns how
 * many pixels moved.
 */
export function removeShadow(
  fg: Uint8Array<ArrayBuffer>,
  w: number,
  h: number,
  features: ArrayLike<number>,
  fallback: ArrayLike<number> | null,
): number {
  checkMask(fg, w, h);
  const box = maskBox(fg, w, h);
  if (!box) return 0;
  const yTop = box.y1 - Math.max(1, Math.round(SHADOW_BOTTOM_FRACTION * box.h));
  // Local background: the background pixels in the band's rows.
  let n = 0;
  let L = 0;
  let C = 0;
  for (let y = yTop; y < box.y1; y++) {
    for (let x = 0; x < w; x++) {
      const i = x + w * y;
      if (fg[i] !== 0) continue;
      L += features[3 * i];
      C += Math.hypot(features[3 * i + 1], features[3 * i + 2]) / 2;
      n++;
    }
  }
  if (n > 0) {
    L /= n;
    C /= n;
  } else if (fallback) {
    L = fallback[0];
    C = Math.hypot(fallback[1], fallback[2]) / 2;
  } else {
    return 0;
  }
  // The object's own colors, from a strip just above the band: a pixel that looks like them is object, not shadow
  // (a gray toy on a white floor is as dark as a shadow, but it continues the toy above it).
  const stripTop = Math.max(box.y0, yTop - Math.max(1, Math.round(SHADOW_OBJECT_STRIP * box.h)));
  const objectSamples: number[] = [];
  for (let y = stripTop; y < yTop; y++) for (let x = box.x0; x < box.x1; x++) if (fg[x + w * y] !== 0) objectSamples.push(x + w * y);
  const object = backgroundClusters(features, objectSamples, { tau: 2 * SHADOW_OBJECT_DISTANCE });
  const objectK = object.shares.length;
  const minObject2 = SHADOW_OBJECT_DISTANCE * SHADOW_OBJECT_DISTANCE;
  const isShadow = (i: number): boolean => {
    if (fg[i] === 0) return false;
    const y = Math.floor(i / w);
    if (y < yTop || y >= box.y1) return false;
    const dL = features[3 * i] - L;
    const dC = Math.abs(Math.hypot(features[3 * i + 1], features[3 * i + 2]) / 2 - C);
    if (!(dL < -SHADOW_MIN_DARKEN && dL > -SHADOW_MAX_DARKEN && dC < SHADOW_MAX_DCHROMA)) return false;
    for (let c = 0; c < objectK; c++) if (dist2(features, i, object.centers, c) < minObject2) return false;
    return true;
  };
  // Grow from shadow-like pixels that touch the background.
  const moved = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let tail = 0;
  for (let i = 0; i < w * h; i++) {
    if (!isShadow(i)) continue;
    const x = i % w;
    const touches = (x > 0 && fg[i - 1] === 0) || (x < w - 1 && fg[i + 1] === 0) || (i >= w && fg[i - w] === 0) || (i < w * (h - 1) && fg[i + w] === 0);
    if (touches) {
      moved[i] = 1;
      queue[tail++] = i;
    }
  }
  let head = 0;
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    const visit = (j: number): void => {
      if (moved[j] === 0 && isShadow(j)) {
        moved[j] = 1;
        queue[tail++] = j;
      }
    };
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < w * (h - 1)) visit(i + w);
  }
  for (let k = 0; k < tail; k++) fg[queue[k]] = 0;
  return tail;
}

// ---------------------------------------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------------------------------------

/**
 * The classical foreground mask of §2.9.1 on the mask grid (≤ 512 px long side). `locks` (mask grid, from
 * `paintLocks`) are the user's brush strokes. Deterministic.
 *
 * Transparent pixels (alpha < ½) are background wherever they are connected to the border, whatever their color,
 * and are not sampled for the background model.
 */
export function classicalMask(img: RgbaImage, options: Partial<MaskOptions> = {}, locks?: ArrayLike<number>): ClassicalMaskResult {
  const o: MaskOptions = { ...MASK_DEFAULTS, ...options };
  if (!(o.tau > 0) || !Number.isFinite(o.tau)) throw new RangeError(`tau must be a finite number > 0, got ${o.tau}`);
  checkRadius(o.closeR);
  const { image, scale } = downscaleToMaskGrid(img, o.maxSide);
  const { w, h } = image;
  if (locks) checkMask(locks, w, h);
  const f = oklabFeatures(image);
  const opaque = (i: number): boolean => image.data[4 * i + 3] >= 128;

  const width = borderBandWidth(w, h, o.band);
  const samples = borderBand(w, h, width).filter((i) => opaque(i));
  const { centers, shares } = backgroundClusters(f, samples, { tau: o.tau, sides: bandSides(samples, w, h, width) });
  const run = (k: number): { raw: Uint8Array<ArrayBuffer>; mask: Uint8Array<ArrayBuffer>; shadowPixels: number } => {
    const tau2 = o.tau * o.tau;
    const bgLike = (i: number): boolean => {
      if (!opaque(i)) return true;
      for (let c = 0; c < k; c++) if (dist2(f, i, centers, c) < tau2) return true;
      return false;
    };
    // Background: bg-like pixels connected to the frame. With keepHoles, also the enclosed bg-like regions (the
    // photo's background seen through a handle or an arm loop) — the price is that background-colored detail inside
    // the object becomes a hole too, which is why it is off by default (research 04 §12).
    const isBg = o.keepHoles ? Uint8Array.from({ length: w * h }, (_, i) => (bgLike(i) ? 1 : 0)) : floodFillFromBorder(w, h, bgLike);
    let fg = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) fg[i] = isBg[i] ? 0 : 1;
    fg = keepLargestComponent(fg, w, h);
    const shadowPixels = o.shadow ? removeShadow(fg, w, h, f, k > 0 ? centers.subarray(0, 3) : null) : 0;
    return { raw: fg, mask: refineMask(fg, w, h, { keepHoles: o.keepHoles, closeR: o.closeR }, locks), shadowPixels };
  };
  let used = shares.length;
  let result = run(used);
  // A secondary cluster that swallowed everything was the object itself (cut by three edges of the photo): fall back
  // to the main background cluster, so the object comes back and the border guard can say why.
  if (used > 1 && maskStats(result.mask, w, h).area === 0) {
    const retry = run(1);
    if (maskStats(retry.mask, w, h).area > 0) {
      used = 1;
      result = retry;
    }
  }
  const { raw, mask, shadowPixels } = result;
  const background = shares.slice(0, used).map((share, c) => ({ hex: featureToHex(centers[3 * c], centers[3 * c + 1], centers[3 * c + 2]), share }));
  return { mask, w, h, scale, raw, background, shadowPixels, issues: maskGuards(mask, w, h) };
}

/** A mask as an RGBA overlay (object = `color` at `alpha`, background transparent), e.g. for previews and tests. */
export function maskToRgba(mask: ArrayLike<number>, w: number, h: number, color: readonly [number, number, number] = [255, 255, 255], alpha = 255): RgbaImage {
  checkMask(mask, w, h);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    if (mask[i] === 0) continue;
    data[4 * i] = color[0];
    data[4 * i + 1] = color[1];
    data[4 * i + 2] = color[2];
    data[4 * i + 3] = alpha;
  }
  return { w, h, data };
}
