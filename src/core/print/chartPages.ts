// Track T8 — how the chart is tiled over pages (DESIGN.md §1.3 F8: "the chart tiled over pages with 2-cell overlap
// and a page map"). Pure geometry, in PDF points (1/72 in); pdf.ts draws what this plans.
//
// - Printed cells keep the stitch's true aspect (D2): the shorter side is `CELL_MIN_PT`, the longer one follows
//   `cell.w / cell.h` (at most `CELL_MAX_PT`). A single crochet cell prints 13 × 11 pt (4.6 × 3.9 mm): room for
//   a symbol and a row number beside it.
// - Tiles share 2 stitches / rows with each neighbor. Their sizes are balanced (a 120-wide chart on 33-wide pages
//   is 4 tiles of 32, not 3 full ones and a sliver).
// - Row numbers count from the bottom (Row 1 is the bottom row); stitch numbers from the side Row 1 starts on.
// - Pages run in reading order (top left first); the page map shows where each one lies.
// - Each chart is laid out portrait or landscape, whichever needs fewer pages (portrait on a tie).
import type { Cell, Hand, Line, PatternDoc } from '../../types';

export type Paper = 'letter' | 'a4';
export type Orientation = 'portrait' | 'landscape';

/** Page sizes in points (portrait). */
export const PAPER_PT: Readonly<Record<Paper, { w: number; h: number }>> = {
  letter: { w: 612, h: 792 },
  a4: { w: 595.28, h: 841.89 },
};

/** Margins and bands shared by every page (points). */
export const PAGE = {
  /** Left and right margin. */
  side: 46,
  /** Where content starts on pages with the running header. */
  top: 62,
  /** Space kept free at the bottom for the footer. */
  bottom: 56,
} as const;

/** Stitches / rows repeated on neighboring pages. */
export const OVERLAP = 2;
/** The shorter side of a printed cell, and the cap on the longer side (points). */
export const CELL_MIN_PT = 11;
export const CELL_MAX_PT = 22;
/** A chart that fits on one page is printed larger, up to this shorter side (points). */
export const CELL_SINGLE_MAX_PT = 18;

/** Bands around the grid on a chart page (points). */
export const CHART_BANDS = {
  /** The tile's heading and caption above the grid. */
  title: 40,
  /** Stitch numbers above and below the grid. */
  numbers: 12,
  /** Row numbers left and right of the grid. */
  gutter: 22,
  /** One row of the color key. */
  keyRow: 16,
  /** The key's heading and the gap above it. */
  keyHead: 24,
  /** Width of one key entry. */
  keyEntry: 124,
} as const;

/** The printed size of one chart cell (points), true to the stitch's aspect. */
export function printedCell(cell: Cell): { w: number; h: number } {
  const w = Number.isFinite(cell.w) && cell.w > 0 ? cell.w : 1;
  const h = Number.isFinite(cell.h) && cell.h > 0 ? cell.h : 1;
  const ratio = w / h;
  return ratio >= 1 ? { w: Math.min(CELL_MIN_PT * ratio, CELL_MAX_PT), h: CELL_MIN_PT } : { w: CELL_MIN_PT, h: Math.min(CELL_MIN_PT / ratio, CELL_MAX_PT) };
}

/**
 * Balanced spans of `n` items over pages of at most `per` items sharing `overlap` items: `[start, end)` pairs from
 * 0. One span when everything fits.
 */
export function tileSpans(n: number, per: number, overlap = OVERLAP): [number, number][] {
  if (n <= 0) return [];
  const room = Math.max(per, overlap + 1);
  if (n <= room) return [[0, n]];
  const count = Math.ceil((n - overlap) / (room - overlap));
  const size = Math.ceil((n + overlap * (count - 1)) / count);
  const spans: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const start = k * (size - overlap);
    spans.push([start, Math.min(start + size, n)]);
  }
  spans[spans.length - 1][1] = n;
  return spans;
}

export interface Tile {
  /** 0-based in reading order (top left first). */
  index: number;
  /** Tile position in the grid of tiles: column from the left, row from the top. */
  tx: number;
  ty: number;
  /** Chart columns `[col0, col1)` from the left and chart rows `[row0, row1)` from the top (label order). */
  col0: number;
  col1: number;
  row0: number;
  row1: number;
}

export interface ChartLayout {
  orientation: Orientation;
  /** Page size (points) in that orientation. */
  page: { w: number; h: number };
  cell: { w: number; h: number };
  /** Cells that fit on a page. */
  perPage: { cols: number; rows: number };
  /** Tiles across and down. */
  across: number;
  down: number;
  tiles: Tile[];
  /** Rows of the color key at the foot of each chart page. */
  keyRows: number;
  keyPerRow: number;
}

/** Rows of key entries for `colors` colors across a content width. */
export function keyLayout(colors: number, contentW: number): { perRow: number; rows: number } {
  const perRow = Math.max(1, Math.floor(contentW / CHART_BANDS.keyEntry));
  return { perRow, rows: Math.max(1, Math.ceil(Math.max(colors, 1) / perRow)) };
}

/** How many cells fit on a page of `page` size. */
export function cellsPerPage(page: { w: number; h: number }, cell: { w: number; h: number }, colors: number): { cols: number; rows: number; keyRows: number; keyPerRow: number } {
  const contentW = page.w - 2 * PAGE.side;
  const contentH = page.h - PAGE.top - PAGE.bottom;
  const key = keyLayout(colors, contentW);
  const gridW = contentW - 2 * CHART_BANDS.gutter;
  const gridH = contentH - CHART_BANDS.title - 2 * CHART_BANDS.numbers - CHART_BANDS.keyHead - key.rows * CHART_BANDS.keyRow;
  return {
    cols: Math.max(OVERLAP + 1, Math.floor(gridW / cell.w + 1e-9)),
    rows: Math.max(OVERLAP + 1, Math.floor(gridH / cell.h + 1e-9)),
    keyRows: key.rows,
    keyPerRow: key.perRow,
  };
}

function layoutFor(paper: Paper, orientation: Orientation, cols: number, rows: number, cell: { w: number; h: number }, colors: number): ChartLayout {
  const p = PAPER_PT[paper];
  const page = orientation === 'portrait' ? { w: p.w, h: p.h } : { w: p.h, h: p.w };
  const per = cellsPerPage(page, cell, colors);
  const colSpans = tileSpans(cols, per.cols);
  // Row spans are counted from the bottom (Row 1), then turned into chart rows from the top.
  const rowSpansFromBottom = tileSpans(rows, per.rows);
  const rowSpans = rowSpansFromBottom.map(([a, b]) => [rows - b, rows - a] as [number, number]).reverse();
  const tiles: Tile[] = [];
  rowSpans.forEach(([row0, row1], ty) =>
    colSpans.forEach(([col0, col1], tx) => tiles.push({ index: tiles.length, tx, ty, col0, col1, row0, row1 })),
  );
  return { orientation, page, cell, perPage: { cols: per.cols, rows: per.rows }, across: colSpans.length, down: rowSpans.length, tiles, keyRows: per.keyRows, keyPerRow: per.keyPerRow };
}

/**
 * The chart's tiling: portrait or landscape, whichever needs fewer pages (portrait on a tie). A chart that fits
 * on one page gets larger cells, as large as the page allows up to `CELL_SINGLE_MAX_PT` on the shorter side.
 */
export function planChart(paper: Paper, cols: number, rows: number, cell: Cell, colors: number): ChartLayout {
  const printed = printedCell(cell);
  const portrait = layoutFor(paper, 'portrait', cols, rows, printed, colors);
  const landscape = layoutFor(paper, 'landscape', cols, rows, printed, colors);
  const best = landscape.tiles.length < portrait.tiles.length ? landscape : portrait;
  if (best.tiles.length !== 1) return best;
  const room = cellsPerPage(best.page, { w: 1, h: 1 }, colors);
  const scale = Math.min(room.cols / (cols * printed.w), room.rows / (rows * printed.h), CELL_SINGLE_MAX_PT / Math.min(printed.w, printed.h));
  if (scale <= 1) return best;
  const big = layoutFor(paper, best.orientation, cols, rows, { w: printed.w * scale, h: printed.h * scale }, colors);
  return big.tiles.length === 1 ? big : best;
}

export type Side = 'left' | 'right';

const LEFTWARD = new Set(['←', '↖', '↙']);
const RIGHTWARD = new Set(['→', '↗', '↘']);

/** The side Row 1 (or Rnd 1) starts on, from its reading arrow; without one, the hand's side (RH right). */
export function startSide(doc: Pick<PatternDoc, 'pieces' | 'hand'>): Side {
  for (const piece of doc.pieces) {
    for (const line of piece.lines) {
      if (line.kind === 'border') continue;
      if (line.arrow && LEFTWARD.has(line.arrow)) return 'right';
      if (line.arrow && RIGHTWARD.has(line.arrow)) return 'left';
      if (line.kind === 'row' || line.kind === 'rnd' || line.kind === 'c2c') return defaultSide(doc.hand);
    }
  }
  return defaultSide(doc.hand);
}

function defaultSide(hand: Hand): Side {
  return hand === 'left' ? 'left' : 'right';
}

/**
 * The reading arrow (← or →) of each chart row that has its own line (row number from the bottom → arrow), for
 * techniques worked in rows or rounds along the chart rows. Folded lines ("Rows 2–3") have none; C2C lines are
 * diagonals and give nothing.
 */
export function rowArrows(doc: Pick<PatternDoc, 'pieces'>): Map<number, '←' | '→'> {
  const out = new Map<number, '←' | '→'>();
  for (const piece of doc.pieces) {
    for (const line of piece.lines as Line[]) {
      if ((line.kind !== 'row' && line.kind !== 'rnd') || (line.arrow !== '←' && line.arrow !== '→')) continue;
      const end = line.nEnd ?? line.n;
      for (let n = line.n; n <= end; n++) out.set(n, line.arrow);
    }
  }
  return out;
}

/** Stitch number (1-based, counted from `side`) of chart column `col` (from the left). */
export function stitchNumber(col: number, cols: number, side: Side): number {
  return side === 'right' ? cols - col : col + 1;
}

/** Row number (1-based from the bottom) of chart row `row` (from the top). */
export function rowNumber(row: number, rows: number): number {
  return rows - row;
}

/** A tile's ranges as people read them: rows and stitches, low to high. */
export function tileRanges(tile: Tile, cols: number, rows: number, side: Side): { rows: [number, number]; stitches: [number, number] } {
  const r = [rowNumber(tile.row1 - 1, rows), rowNumber(tile.row0, rows)] as [number, number];
  const a = stitchNumber(tile.col0, cols, side);
  const b = stitchNumber(tile.col1 - 1, cols, side);
  return { rows: r, stitches: [Math.min(a, b), Math.max(a, b)] };
}

/** The tile holding Row 1's first stitch. */
export function startTile(layout: ChartLayout, cols: number, rows: number, side: Side): Tile | undefined {
  const col = side === 'right' ? cols - 1 : 0;
  const row = rows - 1;
  return layout.tiles.find((t) => col >= t.col0 && col < t.col1 && row >= t.row0 && row < t.row1);
}
