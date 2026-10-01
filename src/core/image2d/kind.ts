// Image kind: pixel art, flat art or photo (DESIGN.md §2.3.4; research 06 §4.2). Track T1, sprint T1.1.
// Pure, deterministic, no DOM. Runs on the UN-SCALED crop (§2.3.1 step 3).
//
// One streaming pass over the crop measures everything the rules need:
//   - `ex[x]` = Σ_y [ΔEOKr2(p(x, y), p(x−1, y)) > 0.05] and `ey[y]` the same down the columns (pixel art);
//   - distinct colors and the share of the 16 most frequent (flat art, rule 1);
//   - flatness = share of pixels whose 4-neighbors are all within ΔEOKr2 0.01 (flat art, rule 2).
//
// Pixel art. The block size `s` and phase of each axis come from the comb (lattice) form of the
// autocorrelation of `ex` / `ey`: for every period s ≥ 3 (fractional periods included, for art scaled by a
// non-integer factor) the share of the edge evidence that falls on one lattice `phase + k·s` (within a pixel)
// is measured, and the coarsest lattice that explains (within 2%) as much evidence as the best one wins —
// its divisors explain the same evidence with more lines, its multiples miss the lines in between. A pass over
// the blocks then applies the acceptance test of §2.3.4: ≥ 90% of blocks with a within-block ΔEOKr2 standard
// deviation < 0.03 (measured on the block interior, without a margin of ⌊s/4⌋ px that resampling and JPEG
// ringing smear across a boundary).
//
// Transparent pixels (alpha < 128) are one "color" far from every real color, so a sprite's cut-out edge is
// an edge and its transparent surround is flat.
import type { ImageKind } from '../../types/chart';
import type { RgbaImage } from '../../types/geometry';
import { srgb8ToLinear, toe } from '../kernel/color';
import { createFnv1a64 } from '../kernel/hash';
import { GRID_MAX_CELLS } from '../gauge/grid';
import { checkRgbaImage } from './linear';
import type { ImageStats, PixelLattice } from './types';
import { roundHalfUp } from '../gauge/round';

/** ΔEOKr2 above which two neighbors count as an edge for the lattice search (§2.3.4). */
export const PIXEL_EDGE_DE = 0.05;
/** Smallest block size the pixel-art detector looks for (§2.3.4: period ≥ 3 px). */
export const PIXEL_MIN_PERIOD = 3;
/** Fewest native pixels per side for pixel art (a smaller "sprite" is a logo with big blocks). */
export const PIXEL_MIN_BLOCKS = 8;
/** Largest block size searched, in pixels. */
export const PIXEL_MAX_PERIOD = 256;
/** A block is uniform when its interior ΔEOKr2 standard deviation is below this (§2.3.4). */
export const PIXEL_BLOCK_STD = 0.03;
/** A margin pixel farther than this from every blend of its block and a neighbor is unexplained. */
export const PIXEL_MARGIN_DE = 0.1;
/** Share of uniform blocks needed to accept pixel art (§2.3.4). */
export const PIXEL_UNIFORM_SHARE = 0.9;
/** Share of the edge evidence that must lie on the lattice, per axis. */
export const PIXEL_MIN_COVERAGE = 0.75;
/**
 * Share of the RAW edge counts that must lie at the lattice lines, per axis: the noise floor of
 * `findAxisLattice` would otherwise discard the many weak off-lattice edges of a curve in a logo.
 */
export const PIXEL_MIN_RAW_SHARE = 0.6;
/** Fewest lattice lines per axis that carry an edge. */
export const PIXEL_MIN_LINES = 3;
/**
 * Share of the lattice lines that must carry an edge, between the first and the last that do (per axis). In
 * pixel art nearly every native column boundary changes color somewhere; a flag or a grid-aligned logo puts a
 * few edges on a fine lattice that also fits them, with most of its lines empty.
 */
export const PIXEL_MIN_OCCUPANCY = 0.6;
/** Flat art rule 1: at most this many colors… */
export const FLAT_MAX_COLORS = 256;
/** …with the 16 most frequent covering at least this share (§2.3.4). */
export const FLAT_TOP16_SHARE = 0.9;
/** Flat art rule 2: neighbors within this ΔEOKr2 are "the same"… */
export const FLAT_NEIGHBOR_DE = 0.01;
/** …and at least this share of pixels must have only such neighbors (§2.3.4). */
export const FLAT_MIN_FLATNESS = 0.75;

const TRANSPARENT_KEY = 1 << 24;
/** Feature of a transparent pixel: ΔEOKr2 ≥ 1 from every color (real features have toe(L) in 0..1). */
const TRANSPARENT_FEATURE: readonly [number, number, number] = [-1, 0, 0];
/** Resolution of the phase search: bins per pixel. */
const PHASE_BINS_PER_PX = 4;
/** Width of the phase window in bins (1.25 px): an edge that close to a lattice line is on it. */
const PHASE_WINDOW_BINS = 5;
/** Lattices within this much coverage of the best one tie (the coarsest wins). */
const COVERAGE_TIE = 0.03;
/** Periods within this much of the best score around the winner form its plateau. */
const PLATEAU_TIE = 0.005;

/** sRGB 0..255 → linear, as a table (the hot loop below converts millions of pixels). */
const LIN = Float64Array.from({ length: 256 }, (_, v) => srgb8ToLinear(v));

/**
 * Below this toe lightness the chroma of the detector's features is scaled down linearly to 0 at black.
 * OKLab's cube roots make a and b unstable near black: ±4 code values of noise on #000000 move them by
 * ΔEOKr2 ≈ 0.05 (perceptually ≈ ΔE00 1.5), which made every black block of noisy pixel art "non-uniform".
 */
export const DARK_CHROMA_L = 0.2;

/**
 * The cluster feature (toe(L), 2a, 2b) of an 8-bit sRGB color, written into `f` at `o`: the arithmetic of the
 * kernel's `srgb8ToFeature` (same constants, same order) without its intermediate arrays — with the chroma
 * damped near black (`DARK_CHROMA_L`; the detector's distances only).
 */
function featureInto(r8: number, g8: number, b8: number, f: Float32Array, o: number): void {
  const r = LIN[r8];
  const g = LIN[g8];
  const b = LIN[b8];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const Lr = toe(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s);
  const damp = Lr < DARK_CHROMA_L ? Lr / DARK_CHROMA_L : 1;
  f[o] = Lr;
  f[o + 1] = 2 * damp * (1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s);
  f[o + 2] = 2 * damp * (0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s);
}

function pixelKey(d: Uint8ClampedArray, p: number): number {
  return d[p + 3] < 128 ? TRANSPARENT_KEY : (d[p] << 16) | (d[p + 1] << 8) | d[p + 2];
}

/** Features of row y into `f` (3 per pixel) and the color keys into `k`. */
function rowFeatures(img: RgbaImage, y: number, f: Float32Array, k: Int32Array): void {
  const d = img.data;
  for (let x = 0, p = y * img.w * 4; x < img.w; x++, p += 4) {
    const key = pixelKey(d, p);
    k[x] = key;
    const o = x * 3;
    if (x > 0 && key === k[x - 1]) {
      f[o] = f[o - 3];
      f[o + 1] = f[o - 2];
      f[o + 2] = f[o - 1];
    } else if (key === TRANSPARENT_KEY) {
      f[o] = TRANSPARENT_FEATURE[0];
      f[o + 1] = TRANSPARENT_FEATURE[1];
      f[o + 2] = TRANSPARENT_FEATURE[2];
    } else {
      featureInto(d[p], d[p + 1], d[p + 2], f, o);
    }
  }
}

function dist(f: Float32Array, i: number, g: Float32Array, j: number): number {
  const a = f[i] - g[j];
  const b = f[i + 1] - g[j + 1];
  const c = f[i + 2] - g[j + 2];
  return Math.sqrt(a * a + b * b + c * c);
}

/** The streaming measurements of one pass over the image. */
export interface EdgeProfile {
  /** ex[x], x = 1..w−1 (ex[0] = 0): rows in which pixel x differs from pixel x − 1 by more than ΔEOKr2 0.05. */
  ex: Int32Array<ArrayBuffer>;
  /** ey[y], y = 1..h−1 (ey[0] = 0): columns in which pixel y differs from pixel y − 1. */
  ey: Int32Array<ArrayBuffer>;
  uniqueColors: number;
  top16Share: number;
  flatness: number;
  translucentShare: number;
}

/** One pass: edge profiles, color counts, flatness (see the file header). */
export function edgeProfile(img: RgbaImage): EdgeProfile {
  checkRgbaImage(img, 'edgeProfile');
  const { w, h } = img;
  const ex = new Int32Array(w);
  const ey = new Int32Array(h);
  let prevF = new Float32Array(w * 3);
  let curF = new Float32Array(w * 3);
  let prevK = new Int32Array(w);
  let curK = new Int32Array(w);
  let prevFlat = new Uint8Array(w);
  let curFlat = new Uint8Array(w);
  let counts: Map<number, number> | undefined = new Map();
  let flatCount = 0;
  let translucent = 0;
  const d = img.data;
  for (let y = 0; y < h; y++) {
    rowFeatures(img, y, curF, curK);
    curFlat.fill(1);
    for (let x = 0, p = y * w * 4; x < w; x++, p += 4) {
      if (d[p + 3] < 255) translucent++;
      if (counts !== undefined) {
        const key = curK[x];
        counts.set(key, (counts.get(key) ?? 0) + 1);
        if (counts.size > FLAT_MAX_COLORS) counts = undefined;
      }
    }
    for (let x = 1; x < w; x++) {
      if (curK[x] === curK[x - 1]) continue;
      const dd = dist(curF, x * 3, curF, (x - 1) * 3);
      if (dd > PIXEL_EDGE_DE) ex[x]++;
      if (dd > FLAT_NEIGHBOR_DE) {
        curFlat[x] = 0;
        curFlat[x - 1] = 0;
      }
    }
    if (y > 0) {
      let edges = 0;
      for (let x = 0; x < w; x++) {
        if (curK[x] === prevK[x]) continue;
        const dd = dist(curF, x * 3, prevF, x * 3);
        if (dd > PIXEL_EDGE_DE) edges++;
        if (dd > FLAT_NEIGHBOR_DE) {
          curFlat[x] = 0;
          prevFlat[x] = 0;
        }
      }
      ey[y] = edges;
      for (let x = 0; x < w; x++) flatCount += prevFlat[x];
    }
    [prevF, curF] = [curF, prevF];
    [prevK, curK] = [curK, prevK];
    [prevFlat, curFlat] = [curFlat, prevFlat];
  }
  for (let x = 0; x < w; x++) flatCount += prevFlat[x];
  const n = w * h;
  let uniqueColors = FLAT_MAX_COLORS + 1;
  let top16Share = 0;
  if (counts !== undefined) {
    uniqueColors = counts.size;
    const sorted = [...counts.values()].sort((a, b) => b - a);
    let top = 0;
    for (let i = 0; i < Math.min(16, sorted.length); i++) top += sorted[i];
    top16Share = top / n;
  }
  return { ex, ey, uniqueColors, top16Share, flatness: flatCount / n, translucentShare: translucent / n };
}

/** A lattice along one axis. */
export interface AxisLattice {
  /** Block size, pixels. */
  s: number;
  /** Lattice lines (block boundaries) at `round(phase + k·s)`. */
  phase: number;
  /** Share of the (noise-cleaned) edge evidence on the lattice lines. */
  coverage: number;
  /**
   * Share of the raw edge counts (above the profile's median) within a pixel of the lattice lines (exactly on
   * them when s < 5).
   */
  rawShare: number;
  /** Lattice lines that carry an edge. */
  occupied: number;
  /** Share of the lattice lines between the first and the last line with an edge that carry one. */
  occupancy: number;
}

function median(sorted: Float64Array): number {
  const n = sorted.length;
  return n % 2 === 1 ? sorted[(n - 1) / 2] : 0.5 * (sorted[n / 2 - 1] + sorted[n / 2]);
}

/**
 * The block lattice of one edge profile (`e[x]` = edges between pixel x − 1 and x, `e[0]` unused), or
 * undefined when there is no edge evidence or no room for `PIXEL_MIN_BLOCKS` blocks of ≥ 3 px.
 *
 * 1. Noise: the median and MAD of the profile estimate what a position gets from noise alone; only the excess
 *    over median + 3·1.4826·MAD + 1 is evidence.
 * 2. A soft edge (resampling blur, JPEG) spreads one boundary over neighboring positions: each run of
 *    consecutive positions with evidence, split at its valleys, is one edge at its weighted centroid.
 * 3. For every period s from 3 px (a grid fine enough that the lattice drifts by ≤ 1/8 px across the axis),
 *    the best phase window of 1.25 px collects the evidence of the edges whose residue `x mod s` falls in it.
 * 4. Coverage is chance-corrected (a window of w px on a period s catches w/s of random evidence); the
 *    coarsest period within 0.03 of the best score wins, refined to the middle of the plateau of best scores
 *    within ±5% of it (or a whole number on that plateau); the weighted mean residue in its window is the
 *    phase.
 */
export function findAxisLattice(e: ArrayLike<number>): AxisLattice | undefined {
  const n = e.length;
  const sMax = Math.min(PIXEL_MAX_PERIOD, n / PIXEL_MIN_BLOCKS);
  if (n < 2 || sMax < PIXEL_MIN_PERIOD) return undefined;
  const vals = new Float64Array(n - 1);
  for (let x = 1; x < n; x++) vals[x - 1] = e[x];
  vals.sort();
  const med = median(vals);
  for (let i = 0; i < vals.length; i++) vals[i] = Math.abs(vals[i] - med);
  vals.sort();
  const thr = med + 3 * 1.4826 * median(vals) + 1;
  // Edges: runs of positions with evidence, split at valleys → (centroid, weight).
  const pos: number[] = [];
  const wt: number[] = [];
  let total = 0;
  let positions = 0;
  let sw = 0;
  let sx = 0;
  const flush = (): void => {
    if (sw > 0) {
      pos.push(sx / sw);
      wt.push(sw);
      total += sw;
    }
    sw = 0;
    sx = 0;
  };
  for (let x = 1; x < n; x++) {
    const v = e[x] - thr;
    if (!(v > 0)) {
      flush();
      continue;
    }
    // A rise after a fall starts a new edge: x − 1 was a valley between two edges.
    if (x >= 3 && e[x - 1] - thr > 0 && e[x] > e[x - 1] && e[x - 1] < e[x - 2]) flush();
    sw += v;
    sx += v * x;
    positions++;
  }
  flush();
  // At most one boundary in three positions can be a block edge; evidence almost everywhere is not a lattice.
  if (pos.length < PIXEL_MIN_LINES || positions > 0.5 * n) return undefined;

  const evaluate = (s: number): { coverage: number; a: number } => {
    const nb = Math.ceil(s * PHASE_BINS_PER_PX);
    const hist = new Float64Array(nb);
    for (let i = 0; i < pos.length; i++) {
      const r = pos[i] - s * Math.floor(pos[i] / s);
      hist[Math.min(nb - 1, Math.floor(r * PHASE_BINS_PER_PX))] += wt[i];
    }
    // Circular window of PHASE_WINDOW_BINS bins; ties → the lowest start bin.
    let win = 0;
    for (let b = 0; b < PHASE_WINDOW_BINS; b++) win += hist[b % nb];
    let best = win;
    let bestB = 0;
    for (let b = 1; b < nb; b++) {
      win += hist[(b + PHASE_WINDOW_BINS - 1) % nb] - hist[b - 1];
      if (win > best + 1e-9) {
        best = win;
        bestB = b;
      }
    }
    return { coverage: best / total, a: bestB / PHASE_BINS_PER_PX };
  };

  // Chance-corrected coverage: a fine lattice catches evidence by accident (its window covers w/s of all
  // residues), so coverage is scored as the excess over chance, (coverage − c0) / (1 − c0) with c0 = w/s.
  const width = PHASE_WINDOW_BINS / PHASE_BINS_PER_PX;
  const score = (s: number): number => {
    const c0 = Math.min(1, width / s);
    return (evaluate(s).coverage - c0) / (1 - c0);
  };
  // Coarse pass: steps that drift ≤ 1/8 px across min(n, 2048) px (the full axis for usual sizes); a long axis
  // is refined below, so its cost stays bounded.
  const nCoarse = Math.min(n, 2048);
  const ss: number[] = [];
  const cov: number[] = [];
  for (let s = PIXEL_MIN_PERIOD; s <= sMax + 1e-9; s += Math.max(1e-4, s / (8 * nCoarse))) {
    ss.push(s);
    cov.push(score(s));
  }
  let maxCov = 0;
  for (const c of cov) maxCov = Math.max(maxCov, c);
  // The coarsest period that ties with the best one…
  let hi = -1;
  for (let i = ss.length - 1; i >= 0; i--) {
    if (cov[i] >= maxCov - COVERAGE_TIE) {
      hi = i;
      break;
    }
  }
  // …refined on the full-resolution grid to the middle of the plateau of its neighborhood (±5%): the score is
  // noisy between neighboring periods, and every period on the plateau fits equally well.
  const center = ss[hi];
  const fs: number[] = [];
  const fc: number[] = [];
  for (let s = Math.max(PIXEL_MIN_PERIOD, center * 0.95); s <= Math.min(sMax, center * 1.05) + 1e-9; s += Math.max(1e-4, s / (8 * n))) {
    fs.push(s);
    fc.push(score(s));
  }
  let localMax = 0;
  for (const c of fc) localMax = Math.max(localMax, c);
  let sLo = Infinity;
  let sHi = -Infinity;
  for (let i = 0; i < fs.length; i++) {
    if (fc[i] >= localMax - PLATEAU_TIE) {
      sLo = Math.min(sLo, fs[i]);
      sHi = Math.max(sHi, fs[i]);
    }
  }
  let s = 0.5 * (sLo + sHi);
  // A whole-number period on the plateau is the exact answer (integer upscales are the common case).
  const sInt = roundHalfUp(s);
  if (sInt >= sLo - 1e-9 && sInt <= sHi + 1e-9) s = sInt;
  const { a } = evaluate(s);
  let sumW = 0;
  let sumR = 0;
  for (let i = 0; i < pos.length; i++) {
    let r = pos[i] - s * Math.floor(pos[i] / s) - a;
    if (r < 0) r += s;
    if (r < width) {
      sumW += wt[i];
      sumR += wt[i] * r;
    }
  }
  let phase = a + (sumW > 0 ? sumR / sumW : 0.5 * width);
  // Lines sit at round(phase + k·s); keep the phase in [−0.5, s − 0.5) so that line 0 is the first one.
  if (phase >= s - 0.5) phase -= s;
  // Final lattice: evidence on its lines (within half the window); lines that carry an edge.
  const lineK0 = Math.ceil((-phase - 0.5) / s);
  const lineCount = Math.max(0, Math.floor((n - 0.5 - phase) / s) - lineK0 + 1);
  const lineHit = new Uint8Array(lineCount);
  const nearestLine = (x: number): number => Math.round((x - phase) / s);
  const near = (x: number, tol: number): boolean => Math.abs(x - Math.round(phase + nearestLine(x) * s)) <= tol;
  let covered = 0;
  for (let i = 0; i < pos.length; i++) {
    if (near(pos[i], width / 2)) {
      covered += wt[i];
      const k = nearestLine(pos[i]) - lineK0;
      if (k >= 0 && k < lineCount) lineHit[k] = 1;
    }
  }
  let occupied = 0;
  let first = -1;
  let last = -1;
  for (let k = 0; k < lineCount; k++) {
    if (!lineHit[k]) continue;
    occupied++;
    if (first < 0) first = k;
    last = k;
  }
  const occupancy = occupied > 0 ? occupied / (last - first + 1) : 0;
  // Raw share: counts above the median (what a position gets from noise alone) near the lines.
  const tol = s >= 5 ? 1 : 0;
  let rawOn = 0;
  let rawTotal = 0;
  for (let x = 1; x < n; x++) {
    const v = e[x] - med;
    if (v > 0) {
      rawTotal += v;
      if (near(x, tol)) rawOn += v;
    }
  }
  return { s, phase, coverage: covered / total, rawShare: rawTotal > 0 ? rawOn / rawTotal : 0, occupied, occupancy };
}

/** Block boundaries of an axis lattice: `[start, …lines…, end]`, partial end blocks kept when ≥ s/2. */
export function latticeEdges(l: AxisLattice, n: number): Int32Array<ArrayBuffer> {
  const lines: number[] = [];
  for (let k = Math.ceil((-l.phase - 0.5) / l.s); ; k++) {
    const L = roundHalfUp(l.phase + k * l.s);
    if (L >= n) break;
    if (L > 0 && (lines.length === 0 || L > lines[lines.length - 1])) lines.push(L);
  }
  const edges: number[] = [];
  if (lines.length === 0) return Int32Array.from([0, n]);
  if (lines[0] >= l.s / 2) edges.push(0);
  edges.push(...lines);
  if (n - lines[lines.length - 1] >= l.s / 2) edges.push(n);
  return Int32Array.from(edges);
}

/** Squared distance from feature p to the segment [a, b] (the blends of two colors, approximately). */
function segDist2(p0: number, p1: number, p2: number, a: Float64Array, ai: number, b: Float64Array, bi: number): number {
  const d0 = b[bi] - a[ai];
  const d1 = b[bi + 1] - a[ai + 1];
  const d2 = b[bi + 2] - a[ai + 2];
  const len = d0 * d0 + d1 * d1 + d2 * d2;
  let t = len > 0 ? ((p0 - a[ai]) * d0 + (p1 - a[ai + 1]) * d1 + (p2 - a[ai + 2]) * d2) / len : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const e0 = p0 - a[ai] - t * d0;
  const e1 = p1 - a[ai + 1] - t * d1;
  const e2 = p2 - a[ai + 2] - t * d2;
  return e0 * e0 + e1 * e1 + e2 * e2;
}

/**
 * Share of lattice blocks that are uniform (§2.3.4):
 *   1. the block interior (without a margin of ⌊s/4⌋ px that resampling blur and JPEG ringing smear across a
 *      boundary) has a ΔEOKr2 standard deviation < 0.03, and
 *   2. its margin holds nothing but blends of the block and its neighbors: fewer than max(2, s/2) margin pixels
 *      lie farther than ΔEOKr2 0.1 from every segment between the block's interior mean and a neighboring
 *      block's. Without this check a 1-px line on every lattice line (graph paper, gingham) hides in the
 *      margins and the "pixel art" chart erases it.
 */
export function uniformBlockShare(img: RgbaImage, xEdges: Int32Array, yEdges: Int32Array, sx: number, sy: number): number {
  const cols = xEdges.length - 1;
  const rows = yEdges.length - 1;
  if (cols < 1 || rows < 1) return 0;
  const mx = Math.floor(sx / 4);
  const my = Math.floor(sy / 4);
  // Per column x: its block (−1 outside) and whether it is in the interior.
  const blockOfX = new Int32Array(img.w).fill(-1);
  const innerX = new Uint8Array(img.w);
  for (let j = 0; j < cols; j++) {
    const a = xEdges[j] + mx;
    const b = Math.max(a + 1, xEdges[j + 1] - mx);
    for (let x = xEdges[j]; x < xEdges[j + 1]; x++) {
      blockOfX[x] = j;
      innerX[x] = x >= a && x < b ? 1 : 0;
    }
  }
  const blockOfY = new Int32Array(img.h).fill(-1);
  const innerY = new Uint8Array(img.h);
  for (let i = 0; i < rows; i++) {
    const a = yEdges[i] + my;
    const b = Math.max(a + 1, yEdges[i + 1] - my);
    for (let y = yEdges[i]; y < yEdges[i + 1]; y++) {
      blockOfY[y] = i;
      innerY[y] = y >= a && y < b ? 1 : 0;
    }
  }
  const f = new Float32Array(img.w * 3);
  const k = new Int32Array(img.w);
  // Pass 1: interior mean and spread of every block.
  const n = cols * rows;
  const cnt = new Float64Array(n);
  const mean = new Float64Array(n * 3);
  const sq = new Float64Array(n);
  for (let y = yEdges[0]; y < yEdges[rows]; y++) {
    if (!innerY[y]) continue;
    rowFeatures(img, y, f, k);
    const row = blockOfY[y] * cols;
    for (let x = xEdges[0]; x < xEdges[cols]; x++) {
      if (!innerX[x]) continue;
      const b = row + blockOfX[x];
      const p = x * 3;
      cnt[b]++;
      mean[b * 3] += f[p];
      mean[b * 3 + 1] += f[p + 1];
      mean[b * 3 + 2] += f[p + 2];
      sq[b] += f[p] * f[p] + f[p + 1] * f[p + 1] + f[p + 2] * f[p + 2];
    }
  }
  const ok = new Uint8Array(n);
  for (let b = 0; b < n; b++) {
    if (cnt[b] === 0) continue;
    for (let c = 0; c < 3; c++) mean[b * 3 + c] /= cnt[b];
    const m2 = mean[b * 3] ** 2 + mean[b * 3 + 1] ** 2 + mean[b * 3 + 2] ** 2;
    ok[b] = Math.sqrt(Math.max(0, sq[b] / cnt[b] - m2)) < PIXEL_BLOCK_STD ? 1 : 0;
  }
  // Pass 2: margin pixels that are no blend of the block and a neighbor.
  if (mx > 0 || my > 0) {
    const odd = new Float64Array(n);
    const lim2 = PIXEL_MARGIN_DE * PIXEL_MARGIN_DE;
    for (let y = yEdges[0]; y < yEdges[rows]; y++) {
      const i = blockOfY[y];
      const vy = innerY[y] ? 0 : y < yEdges[i] + my ? -1 : 1;
      rowFeatures(img, y, f, k);
      for (let x = xEdges[0]; x < xEdges[cols]; x++) {
        const vx = innerX[x] ? 0 : x < xEdges[blockOfX[x]] + mx ? -1 : 1;
        if (vx === 0 && vy === 0) continue;
        const j = blockOfX[x];
        const b = i * cols + j;
        if (!ok[b]) continue;
        const p = x * 3;
        let best = segDist2(f[p], f[p + 1], f[p + 2], mean, b * 3, mean, b * 3);
        const tryNeighbor = (ii: number, jj: number): void => {
          if (ii < 0 || ii >= rows || jj < 0 || jj >= cols) return;
          const nb = ii * cols + jj;
          if (cnt[nb] === 0) return;
          best = Math.min(best, segDist2(f[p], f[p + 1], f[p + 2], mean, b * 3, mean, nb * 3));
        };
        if (vx !== 0) tryNeighbor(i, j + vx);
        if (vy !== 0) tryNeighbor(i + vy, j);
        if (vx !== 0 && vy !== 0) tryNeighbor(i + vy, j + vx);
        if (best > lim2) odd[b]++;
      }
    }
    const allowed = Math.max(2, 0.5 * Math.min(sx, sy));
    for (let b = 0; b < n; b++) if (odd[b] >= allowed) ok[b] = 0;
  }
  let uniform = 0;
  for (let b = 0; b < n; b++) uniform += ok[b];
  return uniform / n;
}

/** The pixel lattice of an image, accepted or not (undefined when either axis shows no lattice). */
export function detectPixelLattice(img: RgbaImage, profile: EdgeProfile = edgeProfile(img)): PixelLattice | undefined {
  const lx = findAxisLattice(profile.ex);
  const ly = findAxisLattice(profile.ey);
  if (lx === undefined || ly === undefined) return undefined;
  const xEdges = latticeEdges(lx, img.w);
  const yEdges = latticeEdges(ly, img.h);
  const cols = xEdges.length - 1;
  const rows = yEdges.length - 1;
  const shaped =
    lx.coverage >= PIXEL_MIN_COVERAGE &&
    ly.coverage >= PIXEL_MIN_COVERAGE &&
    lx.rawShare >= PIXEL_MIN_RAW_SHARE &&
    ly.rawShare >= PIXEL_MIN_RAW_SHARE &&
    lx.occupied >= PIXEL_MIN_LINES &&
    ly.occupied >= PIXEL_MIN_LINES &&
    lx.occupancy >= PIXEL_MIN_OCCUPANCY &&
    ly.occupancy >= PIXEL_MIN_OCCUPANCY &&
    cols >= PIXEL_MIN_BLOCKS &&
    rows >= PIXEL_MIN_BLOCKS &&
    cols <= GRID_MAX_CELLS &&
    rows <= GRID_MAX_CELLS;
  const uniformShare = shaped ? uniformBlockShare(img, xEdges, yEdges, lx.s, ly.s) : 0;
  return {
    sx: lx.s,
    sy: ly.s,
    phaseX: lx.phase,
    phaseY: ly.phase,
    cols,
    rows,
    xEdges,
    yEdges,
    coverageX: lx.coverage,
    coverageY: ly.coverage,
    rawShareX: lx.rawShare,
    rawShareY: ly.rawShare,
    occupancyX: lx.occupancy,
    occupancyY: ly.occupancy,
    uniformShare,
    accepted: shaped && uniformShare >= PIXEL_UNIFORM_SHARE,
  };
}

/**
 * A cheap identity of an image: its size and the bytes of up to 4096 rows × 64 pixels sampled on a regular
 * grid (every row and column for small images), hashed with FNV-1a. Telling a crop from its rotation, flip or a
 * moved crop of the same size is what it is for (`SampleRequest.stats`); it is not a content hash.
 */
export function imageFingerprint(img: RgbaImage): string {
  const h = createFnv1a64().update(`${img.w}x${img.h}`);
  const ny = Math.min(img.h, 4096);
  const nx = Math.min(img.w, 64);
  const buf = new Uint8Array(nx * 4);
  for (let a = 0; a < ny; a++) {
    const y = Math.floor((a * img.h) / ny);
    for (let b = 0; b < nx; b++) {
      const x = Math.floor(((b + 0.5 * (a % 2)) * img.w) / nx) % img.w;
      buf.set(img.data.subarray((y * img.w + x) * 4, (y * img.w + x) * 4 + 4), b * 4);
    }
    h.update(buf);
  }
  return h.hex();
}

/** The flat-art rules of §2.3.4 on measured statistics. */
export function isFlatArt(s: Pick<ImageStats, 'uniqueColors' | 'top16Share' | 'flatness'>): boolean {
  return (s.uniqueColors <= FLAT_MAX_COLORS && s.top16Share >= FLAT_TOP16_SHARE) || s.flatness >= FLAT_MIN_FLATNESS;
}

/**
 * Measures the crop and picks its kind (§2.3.4): pixel art when the lattice test accepts, else flat art when
 * either flat rule holds, else photo.
 */
export function analyzeImage(img: RgbaImage): ImageStats {
  const profile = edgeProfile(img);
  const lattice = detectPixelLattice(img, profile);
  const base = {
    w: img.w,
    h: img.h,
    uniqueColors: profile.uniqueColors,
    top16Share: profile.top16Share,
    flatness: profile.flatness,
    translucentShare: profile.translucentShare,
    fingerprint: imageFingerprint(img),
  };
  const kind: ImageKind = lattice?.accepted ? 'pixel' : isFlatArt(base) ? 'flat' : 'photo';
  return lattice === undefined ? { ...base, kind } : { ...base, lattice, kind };
}
