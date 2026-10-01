// The T1.1 stages of the 2D pipeline (DESIGN.md §2.3): crop → image kind → background → grid size → cell
// sampling. Track T1, sprint T1.1. Pure, deterministic, no DOM.
//
// `sampleImage` runs them all; each stage is also exported so that `runChart` (T1.4) can call
// `gate.check(jobId)` between them and cache the per-source analysis (`analyzeImage` depends only on the
// source and the crop, not on the size or the colors).
//
// Kinds (§2.3.4):
//   - photo: cell (i, j) covers `[j·W/cols, (j+1)·W/cols) × [i·H/rows, (i+1)·H/rows)` of the ≤ 2048 px working
//     image — non-square in pixels when stitches are not square — and is its exact fractional-area box
//     average in linear premultiplied light;
//   - flat: the same box averages (for fidelity metrics and as a fallback), plus the working image and spans
//     for T1.2 to quantize at source resolution and pool with `despeckleLabels` + `poolLabels`;
//   - pixel: one cell = one native pixel (the average of the block interior); the finished size follows from
//     the gauge; a requested size is met only by whole multiples of the native grid, with a warning.
import type { ChartSettings, CropRect, ImageKind } from '../../types/chart';
import type { ResolvedGauge } from '../../types/gauge';
import type { RgbaImage } from '../../types/geometry';
import type { Issue } from '../../types/issues';
import { canonicalJson, createFnv1a64 } from '../kernel/hash';
import { linearToSrgb8 } from '../kernel/color';
import { GRID_MAX_CELLS, GRID_WARN_CELLS, borderRounds, chartSize, grid, gridIssues, snap, type GridRequest, type GridSize, type Mult } from '../gauge/grid';
import { backgroundCells, compositeCells, resolveBackground } from './background';
import { applyCrop } from './crop';
import { PIXEL_MIN_COVERAGE, analyzeImage, imageFingerprint } from './kind';
import { analysisImage, boxAverage, toLinearImage, uniformSpans } from './linear';
import type { BackgroundInfo, ImageStats, LinearImage, PixelLattice, SampledImage, Spans } from './types';

/** Width of the chart, in stitches, when the settings give neither a width nor a height. */
export const DEFAULT_WIDTH_STITCHES = 60;

/** The settings the T1.1 stages read. */
export type SampleSettings = Pick<
  ChartSettings,
  'technique' | 'widthIn' | 'heightIn' | 'lockAspect' | 'border' | 'imageKind' | 'background' | 'backgroundColor'
>;

export interface SampleRequest {
  image: RgbaImage;
  crop?: CropRect;
  settings: SampleSettings;
  gauge: Pick<ResolvedGauge, 'cell' | 'hSc'>;
  /** Count constraints of the technique (e.g. mosaic 12n + 3 columns), passed on to `grid`. */
  colsMult?: Mult;
  rowsMult?: Mult;
  /** `analyzeImage` of this source and crop, when the caller has it cached. */
  stats?: ImageStats;
}

/** The `grid` request of §2.3.3 for these settings (sizes include the border; tapestry in the round has none). */
export function gridRequest(
  settings: SampleSettings,
  gauge: Pick<ResolvedGauge, 'cell' | 'hSc'>,
  imgW: number,
  imgH: number,
  mults: { colsMult?: Mult; rowsMult?: Mult } = {},
): { req: GridRequest; defaulted: boolean } {
  const border = settings.technique === 'sc_tapestry_round' ? undefined : { widthIn: settings.border.widthIn, roundH: gauge.hSc };
  let wIn = settings.widthIn;
  let hIn = settings.heightIn;
  // Aspect lock on: one size decides, the other follows the picture (s0b-gauge notes).
  if (settings.lockAspect && wIn !== undefined && hIn !== undefined) hIn = undefined;
  let defaulted = false;
  if (wIn === undefined && hIn === undefined) {
    const nB = border !== undefined ? borderRounds(border.widthIn, border.roundH) : 0;
    wIn = DEFAULT_WIDTH_STITCHES * gauge.cell.w + 2 * nB * gauge.hSc;
    defaulted = true;
  }
  const req: GridRequest = { imgW, imgH };
  if (wIn !== undefined) req.wIn = wIn;
  if (hIn !== undefined) req.hIn = hIn;
  if (border !== undefined) req.border = border;
  if (mults.colsMult !== undefined) req.colsMult = mults.colsMult;
  if (mults.rowsMult !== undefined) req.rowsMult = mults.rowsMult;
  return { req, defaulted };
}

/** The crop, its analysis and the kind to use (the user's override, or the detected kind). */
export function prepareImage(req: Pick<SampleRequest, 'image' | 'crop' | 'settings' | 'stats'>): {
  cropped: RgbaImage;
  stats: ImageStats;
  kind: ImageKind;
} {
  const cropped = applyCrop(req.image, req.crop);
  const stats = req.stats ?? analyzeImage(cropped);
  if (req.stats !== undefined && (stats.w !== cropped.w || stats.h !== cropped.h || stats.fingerprint !== imageFingerprint(cropped))) {
    throw new RangeError(`sampleImage: the cached stats are of another picture or crop (${stats.w} × ${stats.h}; the crop is ${cropped.w} × ${cropped.h})`);
  }
  const k = req.settings.imageKind;
  if (k !== 'auto' && k !== 'photo' && k !== 'flat' && k !== 'pixel') throw new RangeError(`sampleImage: unknown imageKind ${String(k)}`);
  return { cropped, stats, kind: k === 'auto' ? stats.kind : k };
}

/**
 * The native grid for pixel art: the detected lattice when the edges fit one (also a lattice whose blocks
 * failed the uniformity test, when the user chose "pixel art"), else one cell per pixel. Undefined when even
 * that exceeds the 1000-cell cap.
 */
export function nativeLattice(stats: ImageStats): PixelLattice | undefined {
  const l = stats.lattice;
  const fits = (n: number): boolean => n >= 1 && n <= GRID_MAX_CELLS;
  if (l !== undefined && fits(l.cols) && fits(l.rows) && (l.accepted || (l.coverageX >= PIXEL_MIN_COVERAGE && l.coverageY >= PIXEL_MIN_COVERAGE))) {
    return l;
  }
  if (stats.w > GRID_MAX_CELLS || stats.h > GRID_MAX_CELLS) return undefined;
  const xEdges = Int32Array.from({ length: stats.w + 1 }, (_, k) => k);
  const yEdges = Int32Array.from({ length: stats.h + 1 }, (_, k) => k);
  return {
    sx: 1,
    sy: 1,
    phaseX: 0,
    phaseY: 0,
    cols: stats.w,
    rows: stats.h,
    xEdges,
    yEdges,
    coverageX: 0,
    coverageY: 0,
    rawShareX: 0,
    rawShareY: 0,
    occupancyX: 0,
    occupancyY: 0,
    uniformShare: 0,
    accepted: false,
  };
}

/** Spans of the block interiors of a lattice axis (a margin of ⌊s/4⌋ px, as in the detector). */
export function blockSpans(edges: Int32Array, s: number): Spans {
  const n = edges.length - 1;
  const start = new Float64Array(n);
  const end = new Float64Array(n);
  const m = Math.floor(s / 4);
  for (let k = 0; k < n; k++) {
    const a = edges[k];
    const b = edges[k + 1];
    const mm = b - a - 2 * m >= 1 ? m : 0;
    start[k] = a + mm;
    end[k] = b - mm;
  }
  return { start, end };
}

/** Each span cut into `m` equal parts (pixel art scaled by a whole multiple). */
function splitSpans(s: Spans, edges: Int32Array, m: number): Spans {
  const n = s.start.length;
  const start = new Float64Array(n * m);
  const end = new Float64Array(n * m);
  for (let k = 0; k < n; k++) {
    const a = edges[k];
    const b = edges[k + 1];
    for (let q = 0; q < m; q++) {
      start[k * m + q] = a + ((b - a) * q) / m;
      end[k * m + q] = a + ((b - a) * (q + 1)) / m;
    }
  }
  return { start, end };
}

/** Every cell repeated m × m times. */
function replicate(cells: LinearImage, m: number): LinearImage {
  if (m === 1) return cells;
  const w = cells.w * m;
  const h = cells.h * m;
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = (Math.floor(y / m) * cells.w + Math.floor(x / m)) * 4;
      data.set(cells.data.subarray(s, s + 4), (y * w + x) * 4);
    }
  }
  return { w, h, data };
}

const fmtIn = (x: number): string => String(Math.round(x * 10) / 10);

/**
 * Size of a pixel-art chart (§2.3.4): native cols × rows, scaled by the whole multiple m ≥ 1 nearest to the
 * requested size (by width when given, else height; never above the 1000-cell cap). Warns when m > 1, when the
 * requested size could not be met within 2.5%, and when a technique's count rule is not met; notes when the
 * stitch shape changes the proportions.
 */
export function pixelSize(
  lattice: PixelLattice,
  req: { settings: SampleSettings; gauge: Pick<ResolvedGauge, 'cell' | 'hSc'>; imgW: number; imgH: number; colsMult?: Mult; rowsMult?: Mult },
): { size: GridSize; m: number; issues: Issue[] } {
  const { settings, gauge } = req;
  const { req: g, defaulted } = gridRequest(settings, gauge, req.imgW, req.imgH, {});
  const nx = lattice.cols;
  const ny = lattice.rows;
  const mMax = Math.max(1, Math.floor(GRID_MAX_CELLS / Math.max(nx, ny)));
  let m = 1;
  if (!defaulted) {
    const want = grid(gauge.cell, g);
    m = g.wIn !== undefined ? Math.round(want.cols / nx) : Math.round(want.rows / ny);
    m = Math.min(mMax, Math.max(1, m));
  }
  const size = chartSize(gauge.cell, nx * m, ny * m, { imgW: req.imgW, imgH: req.imgH, ...(g.border ? { border: g.border } : {}) });
  const issues: Issue[] = [];
  if (!defaulted) {
    issues.push(...gridIssues(gauge.cell, g).filter((i) => i.code === 'W_GRID_NO_ROOM'));
    const off = (actual: number, asked: number | undefined): boolean => asked !== undefined && (!(asked > 0) || Math.abs(actual / asked - 1) > 0.025);
    const askedW = settings.widthIn;
    const askedH = settings.lockAspect && settings.widthIn !== undefined ? undefined : settings.heightIn;
    if (m > 1 || off(size.actualW, askedW) || off(size.actualH, askedH)) {
      issues.push({
        code: 'W_PIXEL_SIZE',
        severity: 'warn',
        message: `Pixel art is charted one stitch per pixel${m > 1 ? `, here ${m} × ${m} stitches per pixel` : ''}: it can only grow by whole multiples of its ${nx} × ${ny} pixels, so the piece comes out ${fmtIn(size.actualW)} × ${fmtIn(size.actualH)} in. Choose "flat art" to size it freely.`,
      });
    }
  }
  if (size.cols > GRID_WARN_CELLS || size.rows > GRID_WARN_CELLS) {
    issues.push({
      code: 'W_GRID_LARGE',
      severity: 'warn',
      message: `The chart is ${size.cols} × ${size.rows} cells (one per pixel); above ${GRID_WARN_CELLS} cells on a side it is slow to draw and a very long project. Choose "flat art" to make it smaller.`,
    });
  }
  const breaks = (n: number, k?: Mult): boolean => k !== undefined && snap(n, k) !== n;
  if (breaks(nx * m, req.colsMult) || breaks(ny * m, req.rowsMult)) {
    issues.push({
      code: 'W_PIXEL_MULTIPLE',
      severity: 'warn',
      message: `This technique needs ${req.colsMult ? `${req.colsMult.m}·n + ${req.colsMult.plus} columns` : ''}${req.colsMult && req.rowsMult ? ' and ' : ''}${req.rowsMult ? `${req.rowsMult.m}·n + ${req.rowsMult.plus} rows` : ''}; pixel art keeps its ${nx * m} × ${ny * m} grid. Choose "flat art" to resize it.`,
    });
  }
  if (Math.abs(size.aspectErr) > 0.025) {
    issues.push({
      code: 'I_PIXEL_ASPECT',
      severity: 'info',
      message: `Stitches are not square, so the piece is ${Math.round(Math.abs(size.aspectErr) * 100)}% ${size.aspectErr > 0 ? 'taller' : 'wider'} for its size than the picture; every pixel still gets exactly one stitch.`,
    });
  }
  return { size, m, issues };
}

/**
 * Everything that depends only on the source, the crop and the kind/background settings (`imageKind`,
 * `background`, `backgroundColor`) — not on the size or the technique. `runChart` caches it under
 * `prepareKey` and recomputes only `sampleCells` when the size changes.
 */
export interface PreparedWork {
  kind: ImageKind;
  autoKind: ImageKind;
  stats: ImageStats;
  source: { w: number; h: number };
  /** The image the cells are sampled from (see `SampledImage.work`). */
  work: LinearImage;
  bg: BackgroundInfo;
  /** Pixel art: the native grid. */
  lattice?: PixelLattice;
  issues: Issue[];
}

/** The cache key of `prepareWork` for a source identified by `sourceId` (e.g. its asset hash). */
export function prepareKey(sourceId: string, req: Pick<SampleRequest, 'crop' | 'settings'>): string {
  const { imageKind, background, backgroundColor } = req.settings;
  return `${sourceId}|${canonicalJson({ crop: req.crop ?? null, imageKind, background, backgroundColor: backgroundColor ?? null })}`;
}

/** Stages 1–3: crop, image kind, working image and background (§2.3.1, §2.3.2, §2.3.4). */
export function prepareWork(req: Pick<SampleRequest, 'image' | 'crop' | 'settings' | 'stats'>): PreparedWork {
  const prepared = prepareImage(req);
  const { cropped, stats } = prepared;
  let kind = prepared.kind;
  const issues: Issue[] = [];
  const lattice = kind === 'pixel' ? nativeLattice(stats) : undefined;
  if (kind === 'pixel' && lattice === undefined) {
    issues.push({
      code: 'W_PIXEL_UNAVAILABLE',
      severity: 'warn',
      message: `This picture has no pixel grid and is too large (${cropped.w} × ${cropped.h}) for one stitch per pixel; it is charted as flat art.`,
    });
    kind = 'flat';
  }
  // Pixel art keeps every pixel (its blocks are averaged); photos and flat art are analyzed at ≤ 2048 px,
  // converted row by row so a large photo never exists as a full-size float image.
  const work0 = lattice !== undefined ? toLinearImage(cropped) : analysisImage(cropped);
  const bg = resolveBackground(work0, req.settings);
  issues.push(...bg.issues);
  const out: PreparedWork = { kind, autoKind: stats.kind, stats, source: { w: cropped.w, h: cropped.h }, work: bg.image, bg: bg.info, issues };
  if (lattice !== undefined) out.lattice = lattice;
  return out;
}

/** Stages 4–5: grid size and cell sampling (§2.3.3, §2.3.4). `req.settings` must match `prepared`'s. */
export function sampleCells(prepared: PreparedWork, req: Pick<SampleRequest, 'settings' | 'gauge' | 'colsMult' | 'rowsMult'>): SampledImage {
  const { settings, gauge } = req;
  const { work, lattice, source } = prepared;
  const issues: Issue[] = [];
  let size: GridSize;
  let xs: Spans;
  let ys: Spans;
  let cells: LinearImage;
  let pixelScale: number | undefined;
  if (lattice !== undefined) {
    const px = pixelSize(lattice, { settings, gauge, imgW: source.w, imgH: source.h, colsMult: req.colsMult, rowsMult: req.rowsMult });
    size = px.size;
    pixelScale = px.m;
    issues.push(...px.issues);
    const native = boxAverage(work, blockSpans(lattice.xEdges, lattice.sx), blockSpans(lattice.yEdges, lattice.sy));
    cells = replicate(native, px.m);
    xs = splitSpans(blockSpans(lattice.xEdges, 0), lattice.xEdges, px.m);
    ys = splitSpans(blockSpans(lattice.yEdges, 0), lattice.yEdges, px.m);
  } else {
    const { req: g, defaulted } = gridRequest(settings, gauge, source.w, source.h, { colsMult: req.colsMult, rowsMult: req.rowsMult });
    size = grid(gauge.cell, g);
    issues.push(...gridIssues(gauge.cell, g));
    if (defaulted) {
      issues.push({
        code: 'I_SIZE_DEFAULT',
        severity: 'info',
        message: `No finished size was given, so the chart is ${size.cols} stitches wide (${fmtIn(size.actualW)} × ${fmtIn(size.actualH)} in). Set a width or a height.`,
      });
    }
    xs = uniformSpans(size.cols, work.w);
    ys = uniformSpans(size.rows, work.h);
    cells = boxAverage(work, xs, ys);
  }
  issues.push(...prepared.issues);
  // Without a background (opaque picture, or only stray transparent pixels) no cell is background.
  const background = prepared.bg.source === 'none' ? new Uint8Array(cells.w * cells.h) : backgroundCells(cells);
  const colors = compositeCells(cells, background, prepared.bg.hex);
  const out: SampledImage = {
    kind: prepared.kind,
    autoKind: prepared.autoKind,
    stats: prepared.stats,
    source,
    size,
    cols: size.cols,
    rows: size.rows,
    work,
    xs,
    ys,
    cells,
    background,
    colors,
    bg: prepared.bg,
    issues,
  };
  if (lattice !== undefined) {
    out.lattice = lattice;
    out.pixelScale = pixelScale;
  }
  return out;
}

/** Runs every T1.1 stage: `sampleCells(prepareWork(req), req)` (see the file header). */
export function sampleImage(req: SampleRequest): SampledImage {
  return sampleCells(prepareWork(req), req);
}

/**
 * A hash of what sampling decided, over integers only (§5.8): kind, counts, border rounds, background color
 * and cells, and every cell's 8-bit sRGB color.
 */
export function sampleHash(s: SampledImage): string {
  const h = createFnv1a64();
  h.update(canonicalJson({ kind: s.kind, cols: s.cols, rows: s.rows, borderRounds: s.size.borderRounds, bg: s.bg.hex, bgSource: s.bg.source, scale: s.pixelScale ?? 0 }));
  h.update(s.background);
  const n = s.cols * s.rows;
  const rgb = new Uint8Array(n * 3);
  for (let i = 0; i < n * 3; i++) rgb[i] = linearToSrgb8(s.colors.lin[i]);
  h.update(rgb);
  return h.hex();
}
