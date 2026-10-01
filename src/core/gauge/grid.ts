// Grid sizing with independent axes (DESIGN.md §2.3.3, §2.7.10; research 01 §4.1–4.3, §9). Step 0 kernel: pure.
//
// A finished size in inches becomes a chart of `cols × rows` cells. Columns come from the stitch width and rows
// from the row height, each on its own: `rows = cols · aspect` would bake in square cells and make an sc design
// about 15% too short (D2, research 01 §2.3). The size the user asks for includes the border (§2.7.10), so the
// chart is sized inside it.
import type { ChartResult } from '../../types/chart';
import type { Cell } from '../../types/gauge';
import type { Issue } from '../../types/issues';
import type { Inches } from '../../types/units';
import { fmt, isObject, positive, present, show } from './checks';
import { roundHalfUp } from './round';

/** A snapping constraint: counts of the form `m·n + plus`. Mosaic repeat `{ m: 12, plus: 3 }`, even rows `{ m: 2, plus: 0 }`. */
export interface Mult {
  m: number;
  plus: number;
}

export interface GridRequest {
  /** Finished width, border included. Tapestry in the round: the circumference. */
  wIn?: Inches;
  /** Finished height, border included. Give a width, a height or both. */
  hIn?: Inches;
  /** Size of the image after the crop, pixels; only the ratio matters. */
  imgW: number;
  imgH: number;
  /** `widthIn` = `ChartSettings.border.widthIn` (0 = none), `roundH` = `ResolvedGauge.hSc`. Omit for `sc_tapestry_round`. */
  border?: { widthIn: Inches; roundH: Inches };
  colsMult?: Mult;
  rowsMult?: Mult;
}

/** `{ cols, rows, borderRounds, actualW, actualH, aspectErr }` — the shape of `ChartResult.size`. */
export type GridSize = ChartResult['size'];

/** Above this many cells on a side the chart is slow to render and impractical to work: warn (§2.3.3). */
export const GRID_WARN_CELLS = 300;
/** Hard cap on cells per side (§2.3.3, `E_SANITY`). */
export const GRID_MAX_CELLS = 1000;
/** `|aspectErr|` above this ⇒ offer ±1 row or column (§2.3.3). */
export const ASPECT_ERR_OFFER = 0.025;

function checkMult(k: Mult, fn: string): void {
  if (!isObject(k) || !Number.isInteger(k.m) || k.m < 1 || !Number.isInteger(k.plus) || k.plus < 0) {
    throw new RangeError(`${fn}: a multiple needs integers m ≥ 1 and plus ≥ 0, got m = ${show(k?.m)}, plus = ${show(k?.plus)}`);
  }
}

function checkCell(c: Cell, fn: string): void {
  if (!isObject(c) || !positive(c.w) || !positive(c.h)) {
    throw new RangeError(`${fn}: the cell needs a positive width and height in inches, got ${show(c?.w)} × ${show(c?.h)}`);
  }
}

/**
 * The nearest count to `x` (ties up): at least 1 without a constraint, otherwise the nearest `m·n + plus` with
 * n ≥ 0 (§2.3.3). Never returns 0: `{ m: 6, plus: 0 }` gives at least 6.
 */
export function snap(x: number, k?: Mult): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new RangeError(`snap: the count must be a finite number, got ${show(x)}`);
  if (!present(k)) return Math.max(1, roundHalfUp(x));
  checkMult(k, 'snap');
  const n = Math.max(0, roundHalfUp((x - k.plus) / k.m)) * k.m + k.plus;
  return n < 1 ? k.m : n;
}

/** The smallest and the largest count a constraint allows between 1 and the hard cap. */
function feasible(k: Mult | undefined, axis: string): { min: number; max: number } {
  if (!present(k)) return { min: 1, max: GRID_MAX_CELLS };
  checkMult(k, 'grid');
  const min = k.plus >= 1 ? k.plus : k.m;
  const max = k.plus > GRID_MAX_CELLS ? 0 : k.plus + Math.floor((GRID_MAX_CELLS - k.plus) / k.m) * k.m;
  if (max < min) {
    throw new RangeError(`grid: no ${axis} count of the form ${k.m}·n + ${k.plus} lies between 1 and ${GRID_MAX_CELLS}`);
  }
  return { min, max };
}

/**
 * Border rounds (§2.7.10): `n = max(1, round(widthIn / roundH))` joined rounds of sc, 0 when `widthIn` is 0 or
 * less. `roundH` is the sc row height, `ResolvedGauge.hSc`. The border actually worked is `n · roundH` per side.
 */
export function borderRounds(widthIn: Inches, roundH: Inches): number {
  if (typeof widthIn !== 'number' || !Number.isFinite(widthIn)) {
    throw new RangeError(`borderRounds: the border width must be a finite number of inches, got ${show(widthIn)}`);
  }
  if (!(widthIn > 0)) return 0;
  if (!positive(roundH)) {
    throw new RangeError(`borderRounds: the round height (ResolvedGauge.hSc) must be a positive length in inches, got ${show(roundH)}`);
  }
  const n = Math.max(1, roundHalfUp(widthIn / roundH));
  if (!Number.isSafeInteger(n)) throw new RangeError(`borderRounds: a border of ${widthIn} in at ${roundH} in per round is out of range`);
  return n;
}

function sizeOf(c: Cell, cols: number, rows: number, a: number, nB: number, B: number): GridSize {
  const size: GridSize = {
    cols,
    rows,
    borderRounds: nB,
    actualW: cols * c.w + 2 * B,
    actualH: rows * c.h + 2 * B,
    aspectErr: (rows * c.h) / (cols * c.w) / a - 1,
  };
  if (!Number.isFinite(size.actualW) || !Number.isFinite(size.actualH) || !Number.isFinite(size.aspectErr)) {
    throw new RangeError('grid: the requested size is out of range for this stitch size');
  }
  return size;
}

/** `imgH / imgW`, the subject aspect after the crop. */
function imageAspect(imgW: number, imgH: number, fn: string): number {
  const a = imgH / imgW;
  if (!positive(imgW) || !positive(imgH) || !positive(a)) {
    throw new RangeError(`${fn}: the image needs a positive width and height, got ${show(imgW)} × ${show(imgH)}`);
  }
  return a;
}

interface Plan {
  /** Subject aspect after the crop, `imgH / imgW`. */
  a: number;
  nB: number;
  /** Actual border width per side. */
  B: number;
  /** Size left for the chart inside the border. */
  Wg: number;
  Hg: number;
  /** What the request asks for when the hard cap is ignored: the plain §2.3.3 result. */
  wantCols: number;
  wantRows: number;
  /** True when `wantCols` or `wantRows` is above the cap and the chart was made smaller to fit. */
  capped: boolean;
  /** True when both a width and a height were given. */
  both: boolean;
  cols: number;
  rows: number;
}

function plan(c: Cell, req: GridRequest): Plan {
  checkCell(c, 'grid');
  if (!isObject(req)) throw new RangeError('grid: the request is missing');
  const a = imageAspect(req.imgW, req.imgH, 'grid'); // subject aspect AFTER crop
  const hasW = present(req.wIn);
  const hasH = present(req.hIn);
  if (!hasW && !hasH) throw new RangeError('grid: give a finished width (wIn), a finished height (hIn) or both');
  if (hasW && !(typeof req.wIn === 'number' && Number.isFinite(req.wIn))) {
    throw new RangeError(`grid: the finished width must be a finite number of inches, got ${show(req.wIn)}`);
  }
  if (hasH && !(typeof req.hIn === 'number' && Number.isFinite(req.hIn))) {
    throw new RangeError(`grid: the finished height must be a finite number of inches, got ${show(req.hIn)}`);
  }

  const nB = present(req.border) ? borderRounds(req.border.widthIn, req.border.roundH) : 0;
  const B = nB > 0 && present(req.border) ? nB * req.border.roundH : 0; // ACTUAL border width per side
  let Wg = hasW ? (req.wIn as number) - 2 * B : undefined;
  let Hg = hasH ? (req.hIn as number) - 2 * B : undefined;
  if (Wg !== undefined && Hg === undefined) Hg = Wg * a;
  if (Hg !== undefined && Wg === undefined) Wg = Hg / a;
  const idealCols = (Wg as number) / c.w;
  const idealRows = (Hg as number) / c.h;
  if (!Number.isFinite(idealCols) || !Number.isFinite(idealRows)) {
    throw new RangeError('grid: the requested size is out of range for this stitch size');
  }

  const fc = feasible(req.colsMult, 'column');
  const fr = feasible(req.rowsMult, 'row');
  const wantCols = snap(idealCols, req.colsMult); // never rows = cols · a
  const wantRows = snap(idealRows, req.rowsMult);
  let cols = wantCols;
  let rows = wantRows;
  const capped = wantCols > fc.max || wantRows > fr.max;
  const both = hasW && hasH;
  if (capped && both) {
    // Both sizes were given: each axis follows its own number, so each is cut at its own cap.
    cols = Math.min(wantCols, fc.max);
    rows = Math.min(wantRows, fr.max);
  } else if (capped) {
    // One size was given and the other follows the picture: answer with the largest request of the same
    // proportions that still fits. The axis that binds sits at the edge of its cap (its largest count plus half
    // a step, the last value that still snaps to it) and the other axis is scaled by the same factor, so the
    // capped chart keeps the picture's proportions and a growing request never loses a stitch on the way.
    const sc = wantCols > fc.max ? (fc.max + (req.colsMult?.m ?? 1) / 2) / idealCols : Infinity;
    const sr = wantRows > fr.max ? (fr.max + (req.rowsMult?.m ?? 1) / 2) / idealRows : Infinity;
    const scale = Math.min(sc, sr);
    cols = sc <= sr ? fc.max : Math.min(fc.max, snap(idealCols * scale, req.colsMult));
    rows = sr <= sc ? fr.max : Math.min(fr.max, snap(idealRows * scale, req.rowsMult));
  }
  return { a, nB, B, Wg: Wg as number, Hg: Hg as number, wantCols, wantRows, capped, both, cols, rows };
}

/**
 * Finished size → chart size (§2.3.3). `c` is the stitch cell (`ResolvedGauge.cell`; for C2C the square tile).
 *
 * - With only a width (or only a height) the other side follows the image aspect; with both, each axis is
 *   sized from its own number.
 * - `cols` and `rows` are snapped independently (nearest count, ties up; `colsMult` / `rowsMult` restrict them
 *   to `m·n + plus`).
 * - `border`: `borderRounds` rounds of height `roundH` on every side are taken off the requested size first;
 *   `actualW × actualH` include them.
 * - `aspectErr` = (chart height ÷ chart width) ÷ (image height ÷ image width) − 1, border excluded.
 *
 * The result is the normative code of §2.3.3 with three differences, each reported by `gridIssues` where it
 * changes the size: a tie is decided as on paper (`roundHalfUp`); a count is never 0 (a size too small for one
 * stitch, also 0 or a border as wide as the piece, gives the smallest chart); and no side exceeds 1000 cells —
 * with one size given the largest chart of the picture's proportions that fits, with both sizes given each
 * axis cut at its own cap.
 *
 * A larger size never gives fewer columns or rows.
 *
 * Throws a RangeError when the request cannot be answered: no width and no height, a non-finite size, a cell or
 * image without positive sides, an invalid constraint or one that allows no count from 1 to 1000, or a border
 * with no positive round height.
 */
export function grid(c: Cell, req: GridRequest): GridSize {
  const p = plan(c, req);
  return sizeOf(c, p.cols, p.rows, p.a, p.nB, p.B);
}

/**
 * The finished size of a chart whose counts are already known (after "±1 row", a hand edit, an imported chart):
 * the same `actualW`, `actualH`, `borderRounds` and `aspectErr` as `grid` reports for those counts.
 */
export function chartSize(
  c: Cell,
  cols: number,
  rows: number,
  o: { imgW: number; imgH: number; border?: { widthIn: Inches; roundH: Inches } },
): GridSize {
  checkCell(c, 'chartSize');
  if (!Number.isInteger(cols) || cols < 1 || !Number.isInteger(rows) || rows < 1) {
    throw new RangeError(`chartSize: columns and rows must be integers ≥ 1, got ${show(cols)} × ${show(rows)}`);
  }
  if (!isObject(o)) throw new RangeError('chartSize: the image size is missing');
  const a = imageAspect(o.imgW, o.imgH, 'chartSize');
  const nB = present(o.border) ? borderRounds(o.border.widthIn, o.border.roundH) : 0;
  const B = nB > 0 && present(o.border) ? nB * o.border.roundH : 0;
  return sizeOf(c, cols, rows, a, nB, B);
}

export type GridIssueCode = 'W_GRID_NO_ROOM' | 'W_GRID_CAPPED' | 'W_GRID_LARGE' | 'W_GRID_PROPORTIONS' | 'W_GRID_ASPECT';

export interface GridIssue extends Issue {
  code: GridIssueCode;
}

/**
 * What to tell the user about a grid request (all warnings; same inputs as `grid`, same errors thrown):
 * - `W_GRID_NO_ROOM`: the size leaves nothing for the chart (0, or a border as wide as the piece);
 * - `W_GRID_CAPPED`: more than 1000 cells on a side were needed; the chart was made smaller;
 * - `W_GRID_LARGE`: more than 300 cells on a side;
 * - `W_GRID_PROPORTIONS`: a width and a height were given and they differ from the picture's proportions by
 *   more than 2.5% (inside the border, after the cap) — "crop must match": offer crop to fit or pad;
 * - `W_GRID_ASPECT`: otherwise `|aspectErr| > 0.025`, from rounding to whole cells — offer ±1 row or column.
 */
export function gridIssues(c: Cell, req: GridRequest): GridIssue[] {
  const p = plan(c, req);
  const size = sizeOf(c, p.cols, p.rows, p.a, p.nB, p.B);
  const out: GridIssue[] = [];
  const noRoom = p.Wg <= 0 || p.Hg <= 0;
  if (noRoom) {
    out.push({
      code: 'W_GRID_NO_ROOM',
      severity: 'warn',
      message:
        p.nB > 0
          ? `A border of ${p.nB} rounds (${fmt(p.B)} in on each side) leaves no room for the chart at this size; the smallest chart, ${size.cols} × ${size.rows}, is used and the piece comes out ${fmt(size.actualW)} × ${fmt(size.actualH)} in.`
          : `The size leaves no room for a stitch; the smallest chart, ${size.cols} × ${size.rows}, is used and the piece comes out ${fmt(size.actualW)} × ${fmt(size.actualH)} in.`,
    });
  }
  if (p.capped) {
    out.push({
      code: 'W_GRID_CAPPED',
      severity: 'warn',
      message: `This size needs ${p.wantCols} × ${p.wantRows} cells; a chart is limited to ${GRID_MAX_CELLS} cells on a side, so it was ${p.both ? 'cut' : 'scaled down'} to ${size.cols} × ${size.rows} and the piece comes out ${fmt(size.actualW)} × ${fmt(size.actualH)} in.`,
    });
  }
  if (size.cols > GRID_WARN_CELLS || size.rows > GRID_WARN_CELLS) {
    out.push({
      code: 'W_GRID_LARGE',
      severity: 'warn',
      message: `The chart is ${size.cols} × ${size.rows} cells; above ${GRID_WARN_CELLS} cells on a side it is slow to draw and a very long project.`,
    });
  }
  // With both sizes given the request itself may not have the picture's shape (before rounding; after a cap,
  // what is left of it).
  const askedErr = p.both && !noRoom ? (p.capped ? size.aspectErr : p.Hg / p.Wg / p.a - 1) : 0;
  if (Math.abs(askedErr) > ASPECT_ERR_OFFER) {
    const pct = fmt(Math.abs(askedErr) * 100);
    out.push({
      code: 'W_GRID_PROPORTIONS',
      severity: 'warn',
      message: `The width and height ${p.capped ? 'of this chart' : 'given'} are ${pct}% ${askedErr > 0 ? 'taller for their width' : 'wider for their height'} than the picture; crop the picture to fit, pad it, or give only one of the two sizes.`,
    });
  } else if (!noRoom && Math.abs(size.aspectErr) > ASPECT_ERR_OFFER) {
    const pct = fmt(Math.abs(size.aspectErr) * 100);
    out.push({
      code: 'W_GRID_ASPECT',
      severity: 'warn',
      message:
        size.aspectErr > 0
          ? `The chart is ${pct}% taller for its width than the picture; one row fewer or one column more may fit better.`
          : `The chart is ${pct}% wider for its height than the picture; one row more or one column fewer may fit better.`,
    });
  }
  return out;
}
