// Background and transparency (DESIGN.md §2.3.2; research 06 §5). Track T1, sprint T1.1. Pure, no DOM.
//
// - Alpha present: cells average premultiplied linear RGB with alpha; coverage α < 0.5 ⇒ background label;
//   otherwise the cell is un-premultiplied and composited over the background yarn in linear light.
// - "Remove plain background" (opaque images): a border ring 2% of the width; if one cluster covers ≥ 60% of
//   the ring with ΔEOKr2 std < 0.03, a 4-connected flood fill from the border with tolerance ΔEOKr2 0.05 that
//   never crosses Sobel magnitude ≥ the 90th percentile. The filled pixels become fully transparent, so the
//   alpha rule above decides the background cells for both cases.
// - Background is a label outside the K budget, worked in one yarn (default: the border color for a plain
//   background, white for transparency; T1.2 maps it to the nearest palette yarn / the reference line's white).
//   v1 has no "no stitch" cells.
// - Guard: subject < 15% or > 95% of the image ⇒ warning.
//
// Resolved ambiguities (docs/tracks/t1.md):
//   - the flood tolerance is measured to the ring cluster's mean color (not pixel to pixel, which creeps along
//     gradients into the subject);
//   - a barrier pixel (Sobel ≥ the 90th percentile) that is within the tolerance is filled but never spreads
//     the fill: the background reaches the subject's edge without crossing it;
//   - barriers need a magnitude of at least 0.2 (the Sobel response of a ΔEOKr2 0.05 step): in a mostly flat
//     picture the 90th percentile is 0 and would wall in every pixel.
import type { ChartSettings } from '../../types/chart';
import type { Issue } from '../../types/issues';
import { hexToLinearRgb, isHex, linearRgbToHex } from '../kernel/color';
import { linearToFeature } from './linear';
import type { BackgroundInfo, LinearImage } from './types';

/** Ring width as a share of the image width (§2.3.2). */
export const BG_RING_FRACTION = 0.02;
/** One cluster must cover this share of the ring… */
export const BG_RING_SHARE = 0.6;
/** …with a ΔEOKr2 standard deviation below this (§2.3.2). */
export const BG_RING_STD = 0.03;
/** Flood-fill tolerance, ΔEOKr2 to the ring cluster's mean (§2.3.2). */
export const BG_FLOOD_TOLERANCE = 0.05;
/** Sobel magnitudes at or above this percentile are barriers (§2.3.2)… */
export const BG_SOBEL_PERCENTILE = 0.9;
/** …but never below the response of a ΔEOKr2 0.05 step (4 × 0.05 with the 1-2-1 Sobel kernel). */
export const BG_SOBEL_FLOOR = 0.2;
/** A cell whose coverage α is below this is background (§2.3.2). */
export const BG_COVERAGE = 0.5;
/** Subject share outside [min, max] ⇒ warning (§2.3.2). */
export const SUBJECT_MIN_SHARE = 0.15;
export const SUBJECT_MAX_SHARE = 0.95;
/** Background color of a transparent picture until T1.2 maps it to the reference line's white. */
export const TRANSPARENT_BACKGROUND_HEX = '#ffffff';

export type BackgroundIssueCode = 'W_BG_NOT_FOUND' | 'W_BG_SUBJECT_SMALL' | 'W_BG_SUBJECT_LARGE' | 'I_BG_TRANSPARENT';

/** Share of pixels that must be transparent (α < 0.5) for the picture to have a transparent background. */
export const TRANSPARENT_MIN_SHARE = 0.01;

/**
 * True when the picture has a transparent background: at least 1% of its pixels have alpha < 0.5. A few stray
 * transparent pixels (or translucent ones) do not make one; they are composited over the background color.
 */
export function hasTransparency(img: LinearImage): boolean {
  const d = img.data;
  const need = Math.max(1, Math.ceil(TRANSPARENT_MIN_SHARE * img.w * img.h));
  let n = 0;
  for (let p = 3; p < d.length; p += 4) if (d[p] < BG_COVERAGE && ++n >= need) return true;
  return false;
}

/** Cluster features of every pixel (3 floats each), from the straight (un-premultiplied) color. */
export function pixelFeatures(img: LinearImage): Float32Array<ArrayBuffer> {
  const n = img.w * img.h;
  const out = new Float32Array(n * 3);
  const d = img.data;
  let pr = NaN;
  let pg = NaN;
  let pb = NaN;
  let f: [number, number, number] = [0, 0, 0];
  for (let i = 0, p = 0, o = 0; i < n; i++, p += 4, o += 3) {
    const a = d[p + 3];
    const r = a > 0 ? d[p] / a : 0;
    const g = a > 0 ? d[p + 1] / a : 0;
    const b = a > 0 ? d[p + 2] / a : 0;
    if (r !== pr || g !== pg || b !== pb) {
      f = linearToFeature(r, g, b);
      pr = r;
      pg = g;
      pb = b;
    }
    out[o] = f[0];
    out[o + 1] = f[1];
    out[o + 2] = f[2];
  }
  return out;
}

function dist(f: Float32Array, o: number, m: ArrayLike<number>): number {
  const a = f[o] - m[0];
  const b = f[o + 1] - m[1];
  const c = f[o + 2] - m[2];
  return Math.sqrt(a * a + b * b + c * c);
}

/** The dominant color of the border ring (§2.3.2): its share of the ring, ΔEOKr2 std, mean feature and color. */
export interface RingCluster {
  share: number;
  std: number;
  mean: [number, number, number];
  /** Mean linear RGB of the cluster's pixels. */
  linear: [number, number, number];
  hex: string;
}

/** Indices of the ring pixels: the outer `t = max(1, round(2% of the width))` pixels on every side. */
export function ringPixels(w: number, h: number): Int32Array {
  const t = Math.max(1, Math.round(BG_RING_FRACTION * w));
  const out: number[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < t || x >= w - t || y < t || y >= h - t) out.push(y * w + x);
    }
  }
  return Int32Array.from(out);
}

/**
 * The largest color cluster of the border ring: the most populated 0.03-wide feature bin seeds a mean, then
 * three rounds gather the ring pixels within the flood tolerance of the mean and re-average them.
 */
export function ringCluster(img: LinearImage, feat: Float32Array): RingCluster {
  const ring = ringPixels(img.w, img.h);
  const bins = new Map<string, number[]>();
  for (const i of ring) {
    const o = i * 3;
    const key = `${Math.floor(feat[o] / 0.03)},${Math.floor(feat[o + 1] / 0.03)},${Math.floor(feat[o + 2] / 0.03)}`;
    const list = bins.get(key);
    if (list === undefined) bins.set(key, [i]);
    else list.push(i);
  }
  let seed: number[] = [];
  for (const list of bins.values()) if (list.length > seed.length) seed = list; // first-seen bin wins ties
  const meanOf = (members: ArrayLike<number>): [number, number, number] => {
    let a = 0;
    let b = 0;
    let c = 0;
    for (let k = 0; k < members.length; k++) {
      const o = members[k] * 3;
      a += feat[o];
      b += feat[o + 1];
      c += feat[o + 2];
    }
    const n = Math.max(1, members.length);
    return [a / n, b / n, c / n];
  };
  let mean = meanOf(seed);
  let members: number[] = seed;
  for (let round = 0; round < 3; round++) {
    members = [];
    for (const i of ring) if (dist(feat, i * 3, mean) <= BG_FLOOD_TOLERANCE) members.push(i);
    if (members.length === 0) break;
    mean = meanOf(members);
  }
  let ss = 0;
  let lr = 0;
  let lg = 0;
  let lb = 0;
  const d = img.data;
  for (const i of members) {
    const e = dist(feat, i * 3, mean);
    ss += e * e;
    const a = d[i * 4 + 3];
    if (a > 0) {
      lr += d[i * 4] / a;
      lg += d[i * 4 + 1] / a;
      lb += d[i * 4 + 2] / a;
    }
  }
  const n = Math.max(1, members.length);
  const linear: [number, number, number] = [lr / n, lg / n, lb / n];
  return {
    share: members.length / ring.length,
    std: Math.sqrt(ss / n),
    mean,
    linear,
    hex: linearRgbToHex(linear[0], linear[1], linear[2]),
  };
}

/** Sobel gradient magnitude of the feature image, √(Σ_channels Gx² + Gy²), edges clamped. */
export function sobelMagnitude(feat: Float32Array, w: number, h: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const rm = Math.max(0, y - 1) * w * 3;
    const r0 = y * w * 3;
    const rp = Math.min(h - 1, y + 1) * w * 3;
    for (let x = 0; x < w; x++) {
      const cm = Math.max(0, x - 1) * 3;
      const c0 = x * 3;
      const cp = Math.min(w - 1, x + 1) * 3;
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        const tl = feat[rm + cm + c];
        const tc = feat[rm + c0 + c];
        const tr = feat[rm + cp + c];
        const ml = feat[r0 + cm + c];
        const mr = feat[r0 + cp + c];
        const bl = feat[rp + cm + c];
        const bc = feat[rp + c0 + c];
        const br = feat[rp + cp + c];
        const gx = tr + 2 * mr + br - tl - 2 * ml - bl;
        const gy = bl + 2 * bc + br - tl - 2 * tc - tr;
        sum += gx * gx + gy * gy;
      }
      out[y * w + x] = Math.sqrt(sum);
    }
  }
  return out;
}

/** The q-quantile of `values` from a 4096-bin histogram (the lower edge of the bin that holds it). */
export function quantile(values: Float32Array, q: number): number {
  let max = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > max) max = values[i];
  if (!(max > 0)) return 0;
  const bins = 4096;
  const hist = new Uint32Array(bins);
  for (let i = 0; i < values.length; i++) hist[Math.min(bins - 1, Math.floor((values[i] / max) * bins))]++;
  const target = q * values.length;
  let cum = 0;
  for (let b = 0; b < bins; b++) {
    cum += hist[b];
    if (cum >= target) return (b / bins) * max;
  }
  return max;
}

/** The result of "remove plain background" on an opaque image. */
export interface PlainBackground {
  found: boolean;
  ring: RingCluster;
  /** 1 = background; present when found. */
  mask?: Uint8Array<ArrayBuffer>;
  /** Share of the image filled. */
  filled: number;
}

/** "Remove plain background" (§2.3.2): ring test, then the barrier-bounded flood fill from the border. */
export function plainBackground(img: LinearImage, feat: Float32Array = pixelFeatures(img)): PlainBackground {
  const { w, h } = img;
  const ring = ringCluster(img, feat);
  if (!(ring.share >= BG_RING_SHARE && ring.std < BG_RING_STD)) return { found: false, ring, filled: 0 };
  const sobel = sobelMagnitude(feat, w, h);
  const barrier = Math.max(quantile(sobel, BG_SOBEL_PERCENTILE), BG_SOBEL_FLOOR);
  const mask = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  const visit = (i: number): void => {
    if (mask[i] || dist(feat, i * 3, ring.mean) > BG_FLOOD_TOLERANCE) return;
    mask[i] = 1;
    if (sobel[i] < barrier) queue[tail++] = i; // a barrier pixel is filled but does not spread the fill
  };
  for (let x = 0; x < w; x++) {
    visit(x);
    visit((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    visit(y * w);
    visit(y * w + w - 1);
  }
  while (head < tail) {
    const i = queue[head++];
    const x = i % w;
    if (x > 0) visit(i - 1);
    if (x < w - 1) visit(i + 1);
    if (i >= w) visit(i - w);
    if (i < w * (h - 1)) visit(i + w);
  }
  let filled = 0;
  for (let i = 0; i < mask.length; i++) filled += mask[i];
  return { found: true, ring, mask, filled: filled / (w * h) };
}

/** A copy of `img` in which every masked pixel is fully transparent. */
export function clearMasked(img: LinearImage, mask: Uint8Array): LinearImage {
  const data = new Float32Array(img.data);
  for (let i = 0; i < mask.length; i++) {
    if (mask[i]) data.fill(0, i * 4, i * 4 + 4);
  }
  return { w: img.w, h: img.h, data };
}

/** Share of pixels with alpha ≥ 0.5. */
export function opaqueShare(img: LinearImage): number {
  let n = 0;
  const d = img.data;
  for (let p = 3; p < d.length; p += 4) if (d[p] >= BG_COVERAGE) n++;
  return n / (img.w * img.h);
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/**
 * Decides the background of the working image (§2.3.2) and returns the image the cells are sampled from (with
 * removed background pixels made transparent), what was decided, and the warnings.
 */
export function resolveBackground(
  work: LinearImage,
  settings: Pick<ChartSettings, 'background' | 'backgroundColor'>,
): { image: LinearImage; info: BackgroundInfo; issues: Issue[] } {
  const issues: Issue[] = [];
  const chosen = settings.backgroundColor?.hex;
  if (chosen !== undefined && !isHex(chosen)) throw new RangeError(`resolveBackground: backgroundColor.hex must be #rrggbb, got ${String(chosen)}`);
  let image = work;
  let info: BackgroundInfo;
  if (hasTransparency(work)) {
    if (settings.background === 'remove') {
      issues.push({
        code: 'I_BG_TRANSPARENT',
        severity: 'info',
        message: 'The picture already has a transparent background, so that is the background; nothing else was removed.',
      });
    }
    info = {
      source: 'alpha',
      hex: chosen ?? TRANSPARENT_BACKGROUND_HEX,
      hexFrom: chosen !== undefined ? 'setting' : 'white',
      subjectShare: opaqueShare(work),
    };
  } else if (settings.background === 'remove') {
    const plain = plainBackground(work);
    const ring = { share: plain.ring.share, std: plain.ring.std, hex: plain.ring.hex };
    if (plain.found && plain.mask !== undefined) {
      image = clearMasked(work, plain.mask);
      info = {
        source: 'plain',
        hex: chosen ?? plain.ring.hex,
        hexFrom: chosen !== undefined ? 'setting' : 'border',
        subjectShare: 1 - plain.filled,
        mask: plain.mask,
        maskW: work.w,
        maskH: work.h,
        ring,
      };
    } else {
      issues.push({
        code: 'W_BG_NOT_FOUND',
        severity: 'warn',
        message: `No plain background found: the most common color covers ${pct(plain.ring.share)} of the picture's edge${
          plain.ring.share >= BG_RING_SHARE ? ' but varies too much' : ' (it needs 60%)'
        }. The whole picture is charted; crop closer to the subject or keep the background.`,
      });
      info = { source: 'none', hex: chosen ?? TRANSPARENT_BACKGROUND_HEX, hexFrom: chosen !== undefined ? 'setting' : 'white', subjectShare: 1, ring };
    }
  } else {
    info = { source: 'none', hex: chosen ?? TRANSPARENT_BACKGROUND_HEX, hexFrom: chosen !== undefined ? 'setting' : 'white', subjectShare: 1 };
  }
  if (info.source !== 'none') {
    if (info.subjectShare < SUBJECT_MIN_SHARE) {
      issues.push({
        code: 'W_BG_SUBJECT_SMALL',
        severity: 'warn',
        message: `The subject covers only ${pct(info.subjectShare)} of the picture (under 15%): most of the chart is background. Crop closer to the subject.`,
      });
    } else if (info.subjectShare > SUBJECT_MAX_SHARE) {
      issues.push({
        code: 'W_BG_SUBJECT_LARGE',
        severity: 'warn',
        message: `The background covers only ${pct(1 - info.subjectShare)} of the picture (under 5%): check that the right part was removed.`,
      });
    }
  }
  return { image, info, issues };
}

/** Background cells: coverage α < 0.5 (§2.3.2). Use only when the picture has a background (`BackgroundInfo.source`). */
export function backgroundCells(cells: LinearImage): Uint8Array<ArrayBuffer> {
  const n = cells.w * cells.h;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = cells.data[i * 4 + 3] < BG_COVERAGE ? 1 : 0;
  return out;
}

/**
 * Cell colors composited over the background color in linear light (§2.3.2): a background cell is the
 * background color; any other cell is its un-premultiplied average over the background, i.e. P + bg·(1 − α).
 */
export function compositeCells(cells: LinearImage, background: Uint8Array, bgHex: string): { lin: Float32Array<ArrayBuffer>; feat: Float32Array<ArrayBuffer> } {
  const bg = hexToLinearRgb(bgHex);
  const n = cells.w * cells.h;
  const lin = new Float32Array(n * 3);
  const feat = new Float32Array(n * 3);
  const d = cells.data;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const o = i * 3;
    let r: number;
    let g: number;
    let b: number;
    if (background[i]) {
      [r, g, b] = bg;
    } else {
      const k = 1 - Math.min(1, Math.max(0, d[p + 3]));
      r = d[p] + bg[0] * k;
      g = d[p + 1] + bg[1] * k;
      b = d[p + 2] + bg[2] * k;
    }
    lin[o] = r;
    lin[o + 1] = g;
    lin[o + 2] = b;
    const f = linearToFeature(r, g, b);
    feat[o] = f[0];
    feat[o + 1] = f[1];
    feat[o + 2] = f[2];
  }
  return { lin, feat };
}
