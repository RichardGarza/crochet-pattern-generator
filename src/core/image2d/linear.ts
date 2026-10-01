// Linear-light images, exact fractional-area box averages and the 2048 px analysis limit (DESIGN.md §2.3.1
// step 3, §2.3.4 "Photo"; research 06 §1.1, §4.1–4.2). Track T1, sprint T1.1. Pure, deterministic, no DOM.
//
// Every average is taken in linear light on premultiplied alpha: a black/white 1-px checker averages to linear
// 0.5 (sRGB 188), not to sRGB 128, and a transparent pixel adds nothing to a cell's color, only to its
// coverage. Never `drawImage` scaling (its filter is browser-defined [02 §4.1]) and never LANCZOS or bicubic
// (their ringing invents colors [06 §4.2]).
import { linearRgbToOklab, linearToSrgb8, oklabToFeature, srgb8ToLinear } from '../kernel/color';
import type { RgbaImage } from '../../types/geometry';
import type { LinearImage, Spans } from './types';

/** Longest side of the image the photo and flat-art stages analyze (§2.3.1 step 3). */
export const ANALYSIS_MAX_SIDE = 2048;

function checkSize(w: number, h: number, fn: string): void {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new RangeError(`${fn}: the image needs whole positive sides, got ${w} × ${h}`);
  }
}

/** Throws unless `img` is a well-formed RgbaImage (`data.length === w·h·4`). */
export function checkRgbaImage(img: RgbaImage, fn: string): void {
  if (typeof img !== 'object' || img === null) throw new TypeError(`${fn}: no image`);
  checkSize(img.w, img.h, fn);
  if (!(img.data instanceof Uint8ClampedArray) || img.data.length !== img.w * img.h * 4) {
    throw new RangeError(`${fn}: image data must be a Uint8ClampedArray of w·h·4 = ${img.w * img.h * 4} bytes`);
  }
}

/** An all-zero (fully transparent) linear image. */
export function blankLinear(w: number, h: number): LinearImage {
  checkSize(w, h, 'blankLinear');
  return { w, h, data: new Float32Array(w * h * 4) };
}

/** RGBA8 (sRGB, straight alpha) → linear light, premultiplied. */
export function toLinearImage(img: RgbaImage): LinearImage {
  checkRgbaImage(img, 'toLinearImage');
  const n = img.w * img.h;
  const out = new Float32Array(n * 4);
  const d = img.data;
  for (let p = 0; p < n * 4; p += 4) {
    const a = d[p + 3] / 255;
    out[p] = srgb8ToLinear(d[p]) * a;
    out[p + 1] = srgb8ToLinear(d[p + 1]) * a;
    out[p + 2] = srgb8ToLinear(d[p + 2]) * a;
    out[p + 3] = a;
  }
  return { w: img.w, h: img.h, data: out };
}

/** Linear premultiplied → RGBA8 (sRGB, straight alpha); for previews and tests. */
export function toRgbaImage(img: LinearImage): RgbaImage {
  const n = img.w * img.h;
  const out = new Uint8ClampedArray(n * 4);
  const d = img.data;
  for (let p = 0; p < n * 4; p += 4) {
    const a = d[p + 3];
    if (a > 0) {
      out[p] = linearToSrgb8(d[p] / a);
      out[p + 1] = linearToSrgb8(d[p + 1] / a);
      out[p + 2] = linearToSrgb8(d[p + 2] / a);
    }
    out[p + 3] = Math.round(Math.min(1, Math.max(0, a)) * 255);
  }
  return { w: img.w, h: img.h, data: out };
}

/** `n` equal intervals tiling `[0, size)`: cell k covers `[k·size/n, (k+1)·size/n)`. */
export function uniformSpans(n: number, size: number): Spans {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`uniformSpans: need a whole count ≥ 1, got ${n}`);
  if (!(size > 0) || !Number.isFinite(size)) throw new RangeError(`uniformSpans: need a positive size, got ${size}`);
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    start[k] = (k * size) / n;
    end[k] = ((k + 1) * size) / n;
  }
  end[n - 1] = size;
  return { start, end };
}

/** Throws unless every span lies inside `[0, size)` and is non-empty. */
export function checkSpans(s: Spans, size: number, axis: string): void {
  const n = s.start.length;
  if (n < 1 || s.end.length !== n) throw new RangeError(`${axis} spans must be non-empty and of equal length`);
  for (let k = 0; k < n; k++) {
    const a = s.start[k];
    const b = s.end[k];
    if (!(a >= 0) || !(b <= size) || !(b > a)) {
      throw new RangeError(`${axis} span ${k} = [${a}, ${b}) must lie inside [0, ${size}) and be non-empty`);
    }
  }
}

/** Overlap weights of every span with the pixels it touches, as compact lists (CSR). */
interface Weights {
  /** First pixel of span k. */
  first: Int32Array;
  /** Offset of span k's weights in `w`; length n + 1. */
  offset: Int32Array;
  w: Float64Array;
}

function weightsOf(s: Spans): Weights {
  const n = s.start.length;
  const first = new Int32Array(n);
  const offset = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const p0 = Math.floor(s.start[k]);
    const p1 = Math.ceil(s.end[k]);
    first[k] = p0;
    offset[k + 1] = offset[k] + (p1 - p0);
  }
  const w = new Float64Array(offset[n]);
  for (let k = 0; k < n; k++) {
    const a = s.start[k];
    const b = s.end[k];
    for (let p = first[k], o = offset[k]; o < offset[k + 1]; p++, o++) {
      w[o] = Math.min(p + 1, b) - Math.max(p, a);
    }
  }
  return { first, offset, w };
}

/**
 * Exact fractional-area box average of every cell (§2.3.4 "Photo"): cell (i, j) is the area-weighted mean of
 * `img` over `[xs.start[j], xs.end[j]) × [ys.start[i], ys.end[i])`, a pixel counting with the area of its
 * overlap. Works in the image's own space (linear premultiplied for a LinearImage), so the result is a
 * `cols × rows` LinearImage of premultiplied averages whose alpha is the cell's coverage.
 */
export function boxAverage(img: LinearImage, xs: Spans, ys: Spans): LinearImage {
  checkSize(img.w, img.h, 'boxAverage');
  return boxAverageRows(img.w, img.h, (y) => img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), xs, ys);
}

/**
 * `boxAverage` straight from RGBA8: each row is converted to linear premultiplied light as it is read, so a
 * large photo is never held as a full-size float image (16 bytes per pixel).
 */
export function boxAverageRgba(img: RgbaImage, xs: Spans, ys: Spans): LinearImage {
  checkRgbaImage(img, 'boxAverageRgba');
  const row = new Float32Array(img.w * 4);
  const d = img.data;
  return boxAverageRows(
    img.w,
    img.h,
    (y) => {
      for (let x = 0, p = y * img.w * 4, q = 0; x < img.w; x++, p += 4, q += 4) {
        const a = d[p + 3] / 255;
        row[q] = srgb8ToLinear(d[p]) * a;
        row[q + 1] = srgb8ToLinear(d[p + 1]) * a;
        row[q + 2] = srgb8ToLinear(d[p + 2]) * a;
        row[q + 3] = a;
      }
      return row;
    },
    xs,
    ys,
  );
}

function boxAverageRows(W: number, H: number, rowAt: (y: number) => Float32Array, xs: Spans, ys: Spans): LinearImage {
  checkSpans(xs, W, 'column');
  checkSpans(ys, H, 'row');
  const cols = xs.start.length;
  const rows = ys.start.length;
  const wx = weightsOf(xs);
  const wy = weightsOf(ys);
  const out = new Float32Array(cols * rows * 4);
  const acc = new Float64Array(W * 4);
  // Pixels of the image that any column touches: only those need the row accumulation.
  let xLo = W;
  let xHi = 0;
  for (let j = 0; j < cols; j++) {
    xLo = Math.min(xLo, wx.first[j]);
    xHi = Math.max(xHi, wx.first[j] + wx.offset[j + 1] - wx.offset[j]);
  }
  // Source rows are fetched once each when cells are taller than a pixel (consecutive cell rows share at most
  // one source row; the last one fetched is kept).
  let cachedY = -1;
  let cached: Float32Array = new Float32Array(0);
  const fetch = (y: number): Float32Array => {
    if (y !== cachedY) {
      cached = rowAt(y);
      cachedY = y;
    }
    return cached;
  };
  for (let i = 0; i < rows; i++) {
    acc.fill(0, xLo * 4, xHi * 4);
    for (let y = wy.first[i], o = wy.offset[i]; o < wy.offset[i + 1]; y++, o++) {
      const f = wy.w[o];
      const src = fetch(y);
      for (let x = xLo, q = xLo * 4; x < xHi; x++, q += 4) {
        acc[q] += f * src[q];
        acc[q + 1] += f * src[q + 1];
        acc[q + 2] += f * src[q + 2];
        acc[q + 3] += f * src[q + 3];
      }
    }
    const hRow = ys.end[i] - ys.start[i];
    for (let j = 0; j < cols; j++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let x = wx.first[j], o = wx.offset[j]; o < wx.offset[j + 1]; x++, o++) {
        const f = wx.w[o];
        const q = x * 4;
        r += f * acc[q];
        g += f * acc[q + 1];
        b += f * acc[q + 2];
        a += f * acc[q + 3];
      }
      const area = hRow * (xs.end[j] - xs.start[j]);
      const c = (i * cols + j) * 4;
      out[c] = r / area;
      out[c + 1] = g / area;
      out[c + 2] = b / area;
      out[c + 3] = a / area;
    }
  }
  return { w: cols, h: rows, data: out };
}

/** The size an image of w × h gets under the analysis limit (unchanged when it fits). */
export function limitedSize(w: number, h: number, maxSide: number = ANALYSIS_MAX_SIDE): { w: number; h: number } {
  if (!Number.isInteger(maxSide) || maxSide < 1) throw new RangeError(`limitLongSide: maxSide must be a whole number ≥ 1, got ${maxSide}`);
  const long = Math.max(w, h);
  if (long <= maxSide) return { w, h };
  const scale = maxSide / long;
  return {
    w: w >= h ? maxSide : Math.max(1, Math.round(w * scale)),
    h: h >= w ? maxSide : Math.max(1, Math.round(h * scale)),
  };
}

/**
 * The analysis image of §2.3.1 step 3 straight from RGBA8: linear premultiplied, at most `maxSide` px on the
 * long side (linear-light box filter), without a full-size float copy of a large photo.
 */
export function analysisImage(img: RgbaImage, maxSide: number = ANALYSIS_MAX_SIDE): LinearImage {
  checkRgbaImage(img, 'analysisImage');
  const { w, h } = limitedSize(img.w, img.h, maxSide);
  if (w === img.w && h === img.h) return toLinearImage(img);
  return boxAverageRgba(img, uniformSpans(w, img.w), uniformSpans(h, img.h));
}

/**
 * The image scaled down so its long side is at most `maxSide` (default 2048, §2.3.1 step 3) with the
 * linear-light box filter; returned unchanged when it already fits. The new size keeps the aspect ratio to the
 * nearest pixel.
 */
export function limitLongSide(img: LinearImage, maxSide: number = ANALYSIS_MAX_SIDE): LinearImage {
  const { w, h } = limitedSize(img.w, img.h, maxSide);
  if (w === img.w && h === img.h) return img;
  return boxAverage(img, uniformSpans(w, img.w), uniformSpans(h, img.h));
}

/** Straight (un-premultiplied) linear RGB of pixel `i` of a LinearImage; black where alpha is 0. */
export function straightRgb(img: LinearImage, i: number): [number, number, number] {
  const p = i * 4;
  const a = img.data[p + 3];
  if (!(a > 0)) return [0, 0, 0];
  return [img.data[p] / a, img.data[p + 1] / a, img.data[p + 2] / a];
}

/** Cluster feature (toe(L), 2a, 2b) of a linear RGB color (§2.4.1). */
export function linearToFeature(r: number, g: number, b: number): [number, number, number] {
  const [L, A, B] = linearRgbToOklab(r, g, b);
  return oklabToFeature(L, A, B);
}
