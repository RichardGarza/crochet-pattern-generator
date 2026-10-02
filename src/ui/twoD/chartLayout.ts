// Track T2.3 — the geometry of the chart view (DESIGN.md F1 step 4: true-aspect cells, 5/10 grid lines, row
// numbers on the edge where each row starts, §2.7.2). Pure; the canvas component draws from it.
import type { ChartSettings, Hand, Technique2D } from '../../types';

export interface ChartLayout {
  cols: number;
  rows: number;
  /** One stitch, CSS pixels (true aspect: cellH = cellW · h / w). */
  cellW: number;
  cellH: number;
  /** Room for the row numbers (both sides) and the stitch numbers (top and bottom). */
  gutterX: number;
  gutterY: number;
  /** The whole drawing. */
  width: number;
  height: number;
}

export const MIN_CELL_PX = 1;
export const MAX_CELL_PX = 64;

function gutterXFor(rows: number): number {
  return 12 + 7 * String(Math.max(1, rows)).length;
}

const GUTTER_Y = 18;

/** The layout at `cellW` pixels per stitch width; `aspect` = stitch width / height (Table B). */
export function chartLayout(cols: number, rows: number, aspect: number, cellW: number): ChartLayout {
  const a = aspect > 0 ? aspect : 1;
  const w = Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX / 4, cellW));
  const cellH = w / a;
  const gutterX = gutterXFor(rows);
  return { cols, rows, cellW: w, cellH, gutterX, gutterY: GUTTER_Y, width: cols * w + 2 * gutterX, height: rows * cellH + 2 * GUTTER_Y };
}

/** The stitch width that fits the whole chart in a box (never above MAX_CELL_PX). */
export function fitCellWidth(cols: number, rows: number, aspect: number, box: { w: number; h: number }): number {
  const a = aspect > 0 ? aspect : 1;
  const gx = gutterXFor(rows);
  const byW = (box.w - 2 * gx - 2) / Math.max(1, cols);
  const byH = ((box.h - 2 * GUTTER_Y - 2) / Math.max(1, rows)) * a;
  const w = Math.min(byW, byH, MAX_CELL_PX);
  return Math.max(MIN_CELL_PX / 4, w);
}

/** The cell under a point of the drawing (CSS pixels from its top left), or -1. */
export function cellAt(l: ChartLayout, x: number, y: number): number {
  const c = Math.floor((x - l.gutterX) / l.cellW);
  const r = Math.floor((y - l.gutterY) / l.cellH);
  if (c < 0 || r < 0 || c >= l.cols || r >= l.rows) return -1;
  return r * l.cols + c;
}

export function cellRect(l: ChartLayout, cell: number): { x: number; y: number; w: number; h: number } {
  const c = cell % l.cols;
  const r = Math.floor(cell / l.cols);
  return { x: l.gutterX + c * l.cellW, y: l.gutterY + r * l.cellH, w: l.cellW, h: l.cellH };
}

/** The worked line (1-based) of chart row r (row 0 = top; §2.7.2: worked line k uses chart row rows − k). */
export function lineOfRow(rows: number, r: number): number {
  return rows - r;
}

/**
 * Which edge a chart row's number sits on (where the row starts, §2.7.2): RH odd rows (RS) read right → left and
 * start at the right; LH mirrored; joined rounds are all RS (turned rounds alternate like rows). C2C rows run
 * diagonally: no row numbers on the edges.
 */
export function rowStartSide(o: { technique: Technique2D; hand: Hand; roundLean?: ChartSettings['roundLean'] }, line: number): 'left' | 'right' | null {
  if (o.technique === 'c2c') return null;
  const rs = o.technique === 'sc_tapestry_round' && o.roundLean?.mode !== 'turn' ? true : line % 2 === 1;
  const rightFirst = o.hand === 'left' ? !rs : rs;
  return rightFirst ? 'right' : 'left';
}

/** The stitch number (1-based, counted from where Row 1 starts) of column c. */
export function stitchOfColumn(cols: number, c: number, hand: Hand): number {
  return hand === 'left' ? c + 1 : cols - c;
}

/** Every how many lines a number is printed, for a cell size in pixels. */
export function labelEvery(px: number): number {
  if (px >= 11) return 1;
  if (px >= 5) return 5;
  if (px >= 2) return 10;
  return 50;
}

/** The weight of the grid line before line k (counted from the start: rows from the bottom, stitches from Row 1's start). */
export function gridWeight(k: number): 0 | 1 | 2 {
  if (k % 10 === 0) return 2;
  if (k % 5 === 0) return 1;
  return 0;
}

/** Black or white text on a hex color (WCAG relative luminance). */
export function textOn(hex: string): '#000000' | '#ffffff' {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#000000';
  const v = parseInt(m[1], 16);
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const L = 0.2126 * lin((v >> 16) & 255) + 0.7152 * lin((v >> 8) & 255) + 0.0722 * lin(v & 255);
  return (L + 0.05) / 0.05 >= 1.05 / (L + 0.05) ? '#000000' : '#ffffff';
}

/** The next zoom step (×1.25 / ÷1.25, snapped to whole pixels above 4). */
export function zoomStep(cellW: number, dir: 1 | -1): number {
  const next = dir > 0 ? cellW * 1.25 : cellW / 1.25;
  const snapped = next >= 4 ? Math.round(next) : Math.round(next * 4) / 4;
  const moved = snapped === cellW ? cellW + dir * (cellW >= 4 ? 1 : 0.25) : snapped;
  return Math.min(MAX_CELL_PX, Math.max(MIN_CELL_PX / 4, moved));
}
