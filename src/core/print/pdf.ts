// Track T8 — the pattern PDF (DESIGN.md §1.3 F8, §6.3 T8; `buildPdf` §5.2.1). jsPDF 4, standard fonts, vector only.
//
// Pages, in F8's order:
//   1. Cover: title, chart preview, finished size, skill level, technique and an "In this pattern" contents box;
//      then (flowing onto further pages when needed) materials and yardage per color, hook and notions, gauge,
//      notes, abbreviations and special stitches.
//   2. Chart: a page map when the chart needs more than one page, then the chart tiled with 2-cell overlap
//      (chartPages.ts) — every cell in its yarn color with a symbol for black-and-white printing (symbols.ts), row
//      numbers on both sides, stitch numbers above and below, heavy lines every 10, the shared cells inside dashed
//      lines, a key and a mini map on every page.
//   3. Instructions: T2's pattern text (sections.ts) with a checkbox per row, round and foundation, the border
//      rounds and the finishing.
// Every page after the cover has a running header (title, section); every page a footer ("Page 3 of 12").
// Bookmarks name the sections; the contents box and the page map link to their pages.
//
// Exports are blocked while any `E_*` issue exists (F8): `buildPdf` checks `doc.issues` and runs `validateDoc2D`
// (frozen, T2) itself; the export dialog runs `preflightPdf` once with the project's settings and gauge (it takes
// 0.5–1.5 s on a large chart) and hands the result in, so the check is not repeated per build.
//
// Deterministic: the same doc gives the same bytes (fixed creation date unless one is passed, file id from the
// doc's hash). jsPDF is imported on first use, so it stays out of the app's start-up bundle.
import type { jsPDF as JsPdf } from 'jspdf';
import type { ChartGrid, ChartSettings, Issue, PatternDoc, ResolvedGauge } from '../../types';
import type { BuildPdfFn } from '../../types/entryPoints';
import { isImplemented } from '../stub';
import { validateDoc2D } from '../techniques/validate2d';
import {
  CHART_BANDS,
  type ChartLayout,
  PAGE,
  type Paper,
  type Side,
  type Tile,
  keyLayout,
  planChart,
  rowArrows,
  startSide,
  startTile,
  stitchNumber,
  tileRanges,
} from './chartPages';
import {
  ACCENT,
  BODY,
  FAINT,
  GRID_HEAVY,
  GRID_THIN,
  INK,
  MUTED,
  PANEL,
  Pen,
  RULE,
  WHITE,
  checkbox,
  colors,
  drawLine,
  drawSymbol,
  measurerOf,
} from './draw';
import {
  type InstructionBlock,
  SECTION_TITLES,
  type SectionId,
  borderRounds,
  finishedSizeText,
  hookText,
  instructionBlocks,
  materialRows,
  materialTotals,
  patternText,
  strandsHeading,
  techniqueLabel,
  toleranceText,
} from './sections';
import { type SymbolEntry, assignSymbols, hexRgb } from './symbols';
import { type LaidLine, type Measure, type Rgb, type Span, type TextStyle, layoutText, toWinAnsi } from './text';

// ---- pre-export check

/** The result of the pre-export check: any error blocks the PDF. */
export interface PdfPreflight {
  errors: Issue[];
  warnings: Issue[];
}

export interface PreflightOptions {
  /** The project's chart settings (border, start corner, round lean) — `project.twoD.settings`. */
  settings?: Partial<Pick<ChartSettings, 'roundLean' | 'startCorner' | 'border'>>;
  /** The resolved gauge the pattern was built with. */
  gauge?: Pick<ResolvedGauge, 'cell' | 'wSc' | 'hSc'>;
}

const issueKey = (i: Issue): string => `${i.code}\u0000${i.message}\u0000${JSON.stringify(i.where ?? null)}`;

/**
 * Every issue that decides whether the PDF may be made: the doc's own and, for a 2D pattern, T2's
 * `validateDoc2D(doc, { settings, gauge })` (§2.13). Run it once when the export opens; it is slow on large charts.
 * A validator that throws does not block (the doc's own issues still do); it is reported as `W_PDF_UNCHECKED`.
 */
export function preflightPdf(doc: PatternDoc, o: PreflightOptions = {}): PdfPreflight {
  const all: Issue[] = [...doc.issues];
  if (doc.kind === '2d' && isImplemented(validateDoc2D)) {
    try {
      all.push(...validateDoc2D(doc, { ...(o.settings ? { settings: o.settings } : {}), ...(o.gauge ? { gauge: o.gauge } : {}) }));
    } catch (e) {
      all.push({ code: 'W_PDF_UNCHECKED', severity: 'warn', message: `The pattern could not be checked before export (${e instanceof Error ? e.message : String(e)}).` });
    }
  }
  const seen = new Set<string>();
  const unique = all.filter((i) => {
    const k = issueKey(i);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return { errors: unique.filter((i) => i.severity === 'error' || i.code.startsWith('E_')), warnings: unique.filter((i) => !(i.severity === 'error' || i.code.startsWith('E_'))) };
}

/** Thrown by `buildPdf` while the pattern has errors (F8: exports are blocked while any `E_*` exists). */
export class PdfBlockedError extends Error {
  override readonly name = 'PdfBlockedError';
  readonly issues: Issue[];
  constructor(issues: Issue[]) {
    super(
      `This pattern can't be exported yet: ${issues.length === 1 ? 'there is 1 problem' : `there are ${issues.length} problems`} to fix first` +
        (issues[0] ? ` (${issues[0].code}: ${issues[0].message})` : '') +
        '.',
    );
    this.issues = issues;
  }
}

export function isPdfBlocked(e: unknown): e is PdfBlockedError {
  return e instanceof Error && e.name === 'PdfBlockedError';
}

// ---- options and report

export interface PatternPdfOptions {
  paper: Paper;
  /** 3D placement images by piece (T8.4); unused for 2D. */
  placementImages?: Record<string, Blob>;
  /** The pre-export check already run (`preflightPdf`); without it `buildPatternPdf` runs `validateDoc2D` itself. */
  preflight?: PdfPreflight;
  /** The PDF's creation date (default: a fixed date, so a doc always gives the same bytes). */
  createdAt?: Date;
  /** Progress 0…1, between pages. With it, the build yields to the event loop now and then. */
  onProgress?(fraction: number): void;
}

export interface PdfSectionInfo {
  id: SectionId;
  title: string;
  /** First and last page (1-based). */
  first: number;
  last: number;
}

export interface PdfReport {
  blob: Blob;
  pages: number;
  /** The sections in print order with their pages. */
  sections: PdfSectionInfo[];
  /** The chart's tiling (absent without a chart). */
  chart?: { layout: ChartLayout; mapPage: number | null; tilePages: number[] };
  /** Where the instructions came from (`renderPatternText` or, while it is a stub, T2's line renderers). */
  textSource: 'renderPatternText' | 'line-renderers';
  warnings: Issue[];
}

/** Fixed creation date of a PDF built without `createdAt` (determinism, §5.8). */
export const FIXED_CREATION_DATE = "D:20260101000000+00'00'";

function pdfDate(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `D:${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}+00'00'`;
}

// ---- the writer

const H2: TextStyle = { font: 'times', style: 'bold', size: 15, color: INK };
const H3: TextStyle = { font: 'helvetica', style: 'bold', size: 10.5, color: INK };
const SMALL: TextStyle = { font: 'helvetica', style: 'normal', size: 8, color: MUTED };
const LABEL: TextStyle = { font: 'helvetica', style: 'bold', size: 7, color: ACCENT };
const LEADING = 1.42;

interface OutlineEntry {
  title: string;
  page: number;
  children: { title: string; page: number }[];
}

class Writer {
  readonly pen: Pen;
  readonly measure: Measure;
  W = 0;
  H = 0;
  y = 0;
  /** The header label of each page (index = page − 1). */
  readonly labels: string[] = [];
  label = '';
  readonly outline: OutlineEntry[] = [];
  readonly sections = new Map<SectionId, { first: number; last: number }>();
  private section: SectionId | null = null;
  private started = false;

  readonly pdf: JsPdf;
  readonly paper: Paper;

  constructor(pdf: JsPdf, paper: Paper) {
    this.pdf = pdf;
    this.paper = paper;
    this.pen = new Pen(pdf);
    this.measure = measurerOf(pdf);
  }

  get page(): number {
    return this.pdf.getNumberOfPages();
  }
  get x0(): number {
    return PAGE.side;
  }
  get x1(): number {
    return this.W - PAGE.side;
  }
  get width(): number {
    return this.x1 - this.x0;
  }
  get bottom(): number {
    return this.H - PAGE.bottom;
  }

  newPage(orientation: 'portrait' | 'landscape' = 'portrait'): void {
    if (this.started) this.pdf.addPage(this.paper, orientation === 'portrait' ? 'p' : 'l');
    else if (orientation === 'landscape') {
      // The first page exists already (portrait); a document never starts with a chart page.
      this.pdf.addPage(this.paper, 'l');
      this.pdf.deletePage(1);
    }
    this.started = true;
    this.W = this.pdf.internal.pageSize.getWidth();
    this.H = this.pdf.internal.pageSize.getHeight();
    this.y = PAGE.top;
    this.labels[this.page - 1] = this.label;
    this.pen.reset();
    if (this.section) this.touch(this.section);
  }

  /** Starts a section on a new page. */
  sectionPage(id: SectionId, orientation: 'portrait' | 'landscape' = 'portrait'): void {
    this.section = null;
    this.label = SECTION_TITLES[id];
    this.newPage(orientation);
    this.begin(id);
  }

  /** Starts a section here: its bookmark and its page range. */
  begin(id: SectionId, label = SECTION_TITLES[id]): void {
    this.section = id;
    this.label = label;
    if (this.started) this.labels[this.page - 1] = this.labels[this.page - 1] || label;
    this.touch(id);
    this.outline.push({ title: SECTION_TITLES[id], page: this.page, children: [] });
  }

  private touch(id: SectionId): void {
    const s = this.sections.get(id);
    if (s) s.last = this.page;
    else this.sections.set(id, { first: this.page, last: this.page });
  }

  /** Room for `h` points, else a new page. */
  ensure(h: number): void {
    if (this.y + h > this.bottom + 0.01) this.newPage();
  }

  lay(spans: readonly Span[], style: TextStyle, width: number, firstWidth = width): LaidLine[] {
    return layoutText(spans, style, this.measure, width, firstWidth);
  }

  /** A paragraph at x with the given width; splits across pages line by line. Returns its height on the last page. */
  paragraph(spans: readonly Span[], style: TextStyle, o: { x?: number; width?: number; gapAfter?: number; leading?: number } = {}): void {
    const x = o.x ?? this.x0;
    const width = o.width ?? this.x1 - x;
    const lead = (o.leading ?? LEADING) * style.size;
    for (const line of this.lay(spans, style, width)) {
      this.ensure(lead);
      drawLine(this.pen, line, x, this.baseline(lead, style.size));
      this.y += lead;
    }
    this.y += o.gapAfter ?? 0;
  }

  /** The baseline of a line box of height `lead` starting at the cursor. */
  baseline(lead: number, size: number, top = this.y): number {
    return top + lead / 2 + size * 0.34;
  }

  /**
   * A section heading (Times bold) with a hairline; keeps `keep` points of what follows on the same page. With
   * `id`, the section starts here (after any page break), so its bookmark and page range are right.
   */
  heading(text: string, keep = 60, id?: SectionId): void {
    this.ensure(30 + keep);
    if (id) this.begin(id);
    if (this.y > PAGE.top + 1) this.y += 10;
    this.pen.text(toWinAnsi(text), this.x0, this.y + 15, H2);
    this.y += 21;
    colors(this.pdf, null, RULE);
    this.pdf.setLineWidth(0.6);
    this.pdf.line(this.x0, this.y, this.x1, this.y);
    this.y += 9;
  }

  /** The big heading that opens the chart and instructions sections. */
  title1(text: string, caption?: string): void {
    this.pen.text(toWinAnsi(text), this.x0, this.y + 18, { font: 'times', style: 'bold', size: 21, color: INK });
    this.y += 26;
    colors(this.pdf, ACCENT, null);
    this.pdf.rect(this.x0, this.y, 36, 2, 'F');
    this.y += 10;
    if (caption) this.paragraph([{ text: caption }], SMALL, { gapAfter: 6, leading: 1.45 });
  }

  /** A small uppercase label in the accent color. */
  kicker(text: string, x: number, y: number, color: Rgb = ACCENT, size = 7): void {
    this.pen.text(toWinAnsi(text.toUpperCase()), x, y, { ...LABEL, size, color }, { charSpace: 0.7 });
  }
}


/** Shortens `text` with "…" to fit `width`. */
function fit(w: Writer, text: string, style: TextStyle, width: number): string {
  let t = toWinAnsi(text);
  if (w.measure(t, style) <= width) return t;
  while (t.length > 1 && w.measure(`${t}…`, style) > width) t = t.slice(0, -1);
  return `${t.trimEnd()}…`;
}

// ---- chart drawing

interface ChartCtx {
  grid: ChartGrid;
  symbols: SymbolEntry[];
  side: Side;
  arrows: Map<number, '←' | '→'>;
}

/** Fills cells `[c0, c1) × [r0, r1)` at (x, y) with cells cw × ch, merging runs of one color per label. */
function fillCells(pdf: JsPdf, grid: ChartGrid, c0: number, c1: number, r0: number, r1: number, x: number, y: number, cw: number, ch: number): void {
  const runs: number[][] = grid.palette.map(() => []);
  const unknown: number[] = [];
  for (let r = r0; r < r1; r++) {
    const base = r * grid.cols;
    let c = c0;
    while (c < c1) {
      const l = grid.labels[base + c];
      const s = c;
      while (c < c1 && grid.labels[base + c] === l) c++;
      (runs[l] ?? unknown).push(s - c0, r - r0, c - s);
    }
  }
  const draw = (list: number[]): void => {
    for (let i = 0; i < list.length; i += 3) pdf.rect(x + list[i] * cw, y + list[i + 1] * ch, list[i + 2] * cw, ch, 'F');
  };
  runs.forEach((list, label) => {
    if (list.length === 0) return;
    const [r, g, b] = hexRgb(grid.palette[label].hex);
    pdf.setFillColor(r, g, b);
    draw(list);
  });
  if (unknown.length > 0) {
    pdf.setFillColor(200, 200, 200);
    draw(unknown);
  }
}

/** One tile of the chart with its numbers, overlap marks and symbols; (gx, gy) = the grid's top-left. */
function drawTile(w: Writer, ctx: ChartCtx, layout: ChartLayout, tile: Tile, gx: number, gy: number): void {
  const { pdf, pen } = w;
  const { grid, side } = ctx;
  const { w: cw, h: ch } = layout.cell;
  const nCols = tile.col1 - tile.col0;
  const nRows = tile.row1 - tile.row0;
  const gw = nCols * cw;
  const gh = nRows * ch;
  fillCells(pdf, grid, tile.col0, tile.col1, tile.row0, tile.row1, gx, gy, cw, ch);

  // Symbols, one color at a time.
  const cells: number[][] = grid.palette.map(() => []);
  for (let r = tile.row0; r < tile.row1; r++) for (let c = tile.col0; c < tile.col1; c++) cells[grid.labels[r * grid.cols + c]]?.push(c - tile.col0, r - tile.row0);
  const size = Math.min(cw, ch);
  for (const entry of ctx.symbols) {
    if (entry.symbol.kind === 'shape' && entry.symbol.shape === 'blank') continue;
    const list = cells[entry.label];
    if (!list || list.length === 0) continue;
    const ink = hexRgb(entry.ink);
    colors(pdf, ink, ink);
    for (let i = 0; i < list.length; i += 2) drawSymbol(pdf, entry.symbol, gx + (list[i] + 0.5) * cw, gy + (list[i + 1] + 0.5) * ch, size, pen, ink);
  }

  // Grid lines: thin per cell, heavy every 10 stitches / rows counted from the numbering origin.
  const heavyCol = (b: number): boolean => {
    const n = side === 'right' ? grid.cols - b : b;
    return n > 0 && n < grid.cols && n % 10 === 0;
  };
  const heavyRow = (b: number): boolean => {
    const n = grid.rows - b;
    return n > 0 && n < grid.rows && n % 10 === 0;
  };
  colors(pdf, null, GRID_THIN);
  pdf.setLineWidth(0.25);
  for (let i = 1; i < nCols; i++) if (!heavyCol(tile.col0 + i)) pdf.line(gx + i * cw, gy, gx + i * cw, gy + gh);
  for (let j = 1; j < nRows; j++) if (!heavyRow(tile.row0 + j)) pdf.line(gx, gy + j * ch, gx + gw, gy + j * ch);
  colors(pdf, null, GRID_HEAVY);
  pdf.setLineWidth(0.8);
  for (let i = 1; i < nCols; i++) if (heavyCol(tile.col0 + i)) pdf.line(gx + i * cw, gy, gx + i * cw, gy + gh);
  for (let j = 1; j < nRows; j++) if (heavyRow(tile.row0 + j)) pdf.line(gx, gy + j * ch, gx + gw, gy + j * ch);
  pdf.setLineWidth(1.1);
  pdf.rect(gx, gy, gw, gh, 'S');

  // The cells shared with neighboring pages, inside dashed lines.
  const across = layout.across;
  const down = layout.down;
  colors(pdf, null, ACCENT);
  pdf.setLineWidth(1.2);
  pdf.setLineDashPattern([3.2, 2.2], 0);
  if (tile.tx > 0) pdf.line(gx + 2 * cw, gy - 3, gx + 2 * cw, gy + gh + 3);
  if (tile.tx < across - 1) pdf.line(gx + gw - 2 * cw, gy - 3, gx + gw - 2 * cw, gy + gh + 3);
  if (tile.ty > 0) pdf.line(gx - 3, gy + 2 * ch, gx + gw + 3, gy + 2 * ch);
  if (tile.ty < down - 1) pdf.line(gx - 3, gy + gh - 2 * ch, gx + gw + 3, gy + gh - 2 * ch);
  pdf.setLineDashPattern([], 0);

  // Row numbers on both sides; the side a row starts on is bold, with its reading arrow.
  const numSize = Math.min(6.4, ch * 0.62);
  const normal: TextStyle = { font: 'helvetica', style: 'normal', size: numSize, color: FAINT };
  const strong: TextStyle = { font: 'helvetica', style: 'bold', size: numSize, color: INK };
  const first: TextStyle = { font: 'helvetica', style: 'bold', size: numSize, color: ACCENT };
  for (let r = tile.row0; r < tile.row1; r++) {
    const n = grid.rows - r;
    const arrow = ctx.arrows.get(n);
    const starts: Side | null = arrow === '←' ? 'right' : arrow === '→' ? 'left' : null;
    const base = gy + (r - tile.row0 + 0.5) * ch + numSize * 0.35;
    const label = String(n);
    const styleOf = (s: Side): TextStyle => (starts === s ? (n === 1 ? first : strong) : normal);
    pen.text(label, gx - 3, base, styleOf('left'), { align: 'right' });
    pen.text(label, gx + gw + 3, base, styleOf('right'));
    if (starts) {
      const aw = numSize * 0.86;
      const s = styleOf(starts);
      const lw = w.measure(label, s);
      const ax = starts === 'right' ? gx + gw + 3 + lw + 1.5 : gx - 3 - lw - 1.5 - aw;
      drawLine(pen, { pieces: [{ kind: 'glyph', glyph: arrow === '←' ? 'arrow-left' : 'arrow-right', style: s, x: 0, width: aw }], width: aw, size: s.size }, ax, base);
    }
  }

  // Stitch numbers above and below: 1 and every 5th.
  const colStyle: TextStyle = { font: 'helvetica', style: 'normal', size: Math.min(6.2, cw * 0.55), color: MUTED };
  const colBold: TextStyle = { ...colStyle, style: 'bold', color: INK };
  for (let c = tile.col0; c < tile.col1; c++) {
    const n = stitchNumber(c, grid.cols, side);
    if (n !== 1 && n % 5 !== 0) continue;
    const cx = gx + (c - tile.col0 + 0.5) * cw;
    const s = n % 10 === 0 ? colBold : colStyle;
    pen.text(String(n), cx, gy - 3.6, s, { align: 'center' });
    pen.text(String(n), cx, gy + gh + 3.4 + s.size * 0.75, s, { align: 'center' });
  }
}

/** The color key: a sample cell with its symbol, the code and the yarn name, `perRow` entries a row. */
function drawKey(w: Writer, ctx: ChartCtx, layout: ChartLayout, top: number, o: { counts?: boolean; entryWidth?: number } = {}): number {
  const { pdf, pen } = w;
  const { w: cw0, h: ch0 } = layout.cell;
  const scale = Math.min(1, 12 / ch0);
  const cw = cw0 * scale;
  const ch = ch0 * scale;
  const entryW = o.entryWidth ?? CHART_BANDS.keyEntry;
  const perRow = Math.max(1, Math.floor(w.width / entryW));
  w.kicker('Key', w.x0, top + 7, MUTED, 6.8);
  const rowH = CHART_BANDS.keyRow;
  let y = top + 13;
  ctx.symbols.forEach((e, i) => {
    const col = i % perRow;
    if (i > 0 && col === 0) y += rowH;
    const x = w.x0 + col * entryW;
    const fill = hexRgb(e.entry.hex);
    colors(pdf, fill, GRID_HEAVY);
    pdf.setLineWidth(0.5);
    pdf.rect(x, y, cw, ch, 'FD');
    const ink = hexRgb(e.ink);
    colors(pdf, ink, ink);
    drawSymbol(pdf, e.symbol, x + cw / 2, y + ch / 2, Math.min(cw, ch), pen, ink);
    const base = y + ch / 2 + 3;
    const code: TextStyle = { font: 'helvetica', style: 'bold', size: 8.5, color: INK };
    pen.text(toWinAnsi(e.entry.code), x + cw + 5, base, code);
    const nameX = x + cw + 5 + w.measure(toWinAnsi(e.entry.code), code) + 4;
    const yarn = e.entry.yarn ? e.entry.yarn.name : e.entry.name;
    const tail = o.counts ? `  ${e.count.toLocaleString('en-US')} sts` : '';
    const nameStyle: TextStyle = { font: 'helvetica', style: 'normal', size: 7.8, color: MUTED };
    pen.text(fit(w, `${yarn}${e.symbol.kind === 'shape' && e.symbol.shape === 'blank' ? ' (blank)' : ''}${tail}`, nameStyle, entryW - (nameX - x) - 6), nameX, base, nameStyle);
  });
  return y + rowH - top;
}

/** A small map of the tiles with the current one filled; returns its width. Right-aligned at `right`. */
function drawMiniMap(w: Writer, layout: ChartLayout, current: Tile, right: number, top: number, maxH: number): void {
  const { pdf } = w;
  const bw = Math.min(10, 72 / layout.across, (maxH * 1.2) / layout.down);
  const bh = bw * 0.8;
  const left = right - layout.across * bw;
  for (const t of layout.tiles) {
    const x = left + t.tx * bw;
    const y = top + t.ty * bh;
    const isCurrent = t.index === current.index;
    colors(pdf, isCurrent ? ACCENT : PANEL, isCurrent ? ACCENT : RULE);
    pdf.setLineWidth(0.6);
    pdf.rect(x + 0.4, y + 0.4, bw - 0.8, bh - 0.8, 'FD');
  }
}

/** The whole chart small (cover preview and page map), true to the cell aspect, centered in the box. */
function drawThumbnail(w: Writer, grid: ChartGrid, cell: { w: number; h: number }, box: { x: number; y: number; w: number; h: number }, maxCell: number): { x: number; y: number; w: number; h: number; scale: number } {
  const s = Math.min(box.w / (grid.cols * cell.w), box.h / (grid.rows * cell.h), maxCell / Math.max(cell.w, cell.h));
  const cw = cell.w * s;
  const ch = cell.h * s;
  const tw = grid.cols * cw;
  const th = grid.rows * ch;
  const x = box.x + (box.w - tw) / 2;
  const y = box.y + (box.h - th) / 2;
  fillCells(w.pdf, grid, 0, grid.cols, 0, grid.rows, x, y, cw, ch);
  colors(w.pdf, null, GRID_HEAVY);
  w.pdf.setLineWidth(0.6);
  w.pdf.rect(x, y, tw, th, 'S');
  return { x, y, w: tw, h: th, scale: s };
}

// ---- sections

interface BuildCtx {
  doc: PatternDoc;
  w: Writer;
  chart: { ctx: ChartCtx; layout: ChartLayout } | null;
  /** Where the contents box goes on the cover (filled at the end). */
  contents: { x: number; y: number; width: number } | null;
  progress(f: number): Promise<void>;
}

/** Height of the cover's contents box (heading and four rows). */
const CONTENTS_H = 12 + 4 * 14;

function coverPage(b: BuildCtx): void {
  const { doc, w } = b;
  const { pdf, pen } = w;
  w.sectionPage('cover');
  const technique = doc.chart ? techniqueLabel(doc.chart.technique, doc.terms) : doc.kind === '3d' ? 'Amigurumi' : '';
  w.y = 50;
  w.kicker(technique ? `Crochet pattern  ·  ${technique}` : 'Crochet pattern', w.x0, w.y + 6, ACCENT, 7.5);
  w.y += 16;
  const titleStyle: TextStyle = { font: 'times', style: 'bold', size: 30, color: INK };
  for (const line of w.lay([{ text: doc.title.trim() || 'Untitled pattern' }], titleStyle, w.width).slice(0, 3)) {
    drawLine(pen, line, w.x0, w.y + 27);
    w.y += 34;
  }
  const facts: string[] = [];
  if (doc.chart) facts.push(`${doc.chart.grid.cols} × ${doc.chart.grid.rows} ${doc.chart.technique === 'c2c' ? 'tiles' : 'stitches'}`);
  if (doc.materials.length > 0) facts.push(doc.materials.length === 1 ? '1 color' : `${doc.materials.length} colors`);
  facts.push(doc.terms === 'uk' ? 'UK terms' : 'US terms');
  if (doc.hand === 'left') facts.push('left-handed');
  w.paragraph([{ text: facts.join('  ·  ') }], { ...BODY, size: 10.5, color: MUTED }, { gapAfter: 10 });
  colors(pdf, null, RULE);
  pdf.setLineWidth(0.6);
  pdf.line(w.x0, w.y, w.x1, w.y);
  w.y += 16;

  // Preview (left) and facts (right).
  const top = w.y;
  const previewW = Math.round(w.width * 0.56);
  const maxThumbH = 260;
  const maxCell = 26;
  let boxH = 180;
  if (doc.chart && b.chart) {
    const { grid, cell } = doc.chart;
    const s = Math.min((previewW - 32) / (grid.cols * cell.w), maxThumbH / (grid.rows * cell.h), maxCell / Math.max(cell.w, cell.h));
    boxH = Math.max(150, Math.min(maxThumbH + 40, grid.rows * cell.h * s + 46));
  }
  colors(pdf, PANEL, null);
  pdf.roundedRect(w.x0, top, previewW, boxH, 4, 4, 'F');
  if (doc.chart && b.chart) {
    drawThumbnail(w, doc.chart.grid, doc.chart.cell, { x: w.x0 + 16, y: top + 16, w: previewW - 32, h: boxH - 40 }, maxCell);
    const cap = `Chart preview · ${doc.chart.grid.cols} × ${doc.chart.grid.rows}`;
    pen.text(toWinAnsi(cap), w.x0 + previewW / 2, top + boxH - 9, { ...SMALL, size: 7.5 }, { align: 'center' });
  } else {
    pen.text('No chart preview', w.x0 + previewW / 2, top + boxH / 2, SMALL, { align: 'center' });
  }

  const fx = w.x0 + previewW + 22;
  const fw = w.x1 - fx;
  let fy = top + 2;
  const fact = (label: string, value: string, detail?: string | null): void => {
    w.kicker(label, fx, fy + 6);
    fy += 11;
    for (const line of w.lay([{ text: value }], { ...BODY, size: 10 }, fw)) {
      drawLine(pen, line, fx, fy + 9);
      fy += 13.5;
    }
    if (detail) {
      for (const line of w.lay([{ text: detail }], { ...SMALL, size: 7.8 }, fw)) {
        drawLine(pen, line, fx, fy + 7.5);
        fy += 10.5;
      }
    }
    fy += 9;
  };
  const tol = toleranceText(doc.finishedSize);
  fact('Finished size', finishedSizeText(doc.finishedSize), tol ? `Within about ${tol}, depending on your tension.` : null);

  // Skill level: four blocks, filled up to the level (the Craft Yarn Council's way of showing it).
  w.kicker('Skill level', fx, fy + 6);
  fy += 12;
  for (let i = 0; i < 4; i++) {
    colors(pdf, i < doc.skill.level ? ACCENT : WHITE, ACCENT);
    pdf.setLineWidth(0.7);
    pdf.rect(fx + i * 13, fy, 10, 10, 'FD');
  }
  pen.text(toWinAnsi(doc.skill.name), fx + 4 * 13 + 6, fy + 8.4, { ...BODY, size: 10, style: 'bold' });
  fy += 15;
  if (doc.skill.reasons.length > 0) {
    for (const line of w.lay([{ text: doc.skill.reasons.join('; ') }], { ...SMALL, size: 7.8 }, fw)) {
      drawLine(pen, line, fx, fy + 7.5);
      fy += 10.5;
    }
  }
  fy += 9;
  if (technique) fact('Technique', technique, doc.chart?.technique === 'c2c' ? 'Each square of the chart is one tile.' : null);

  // "In this pattern": the contents box, filled once the page numbers are known.
  b.contents = { x: fx, y: fy, width: fw };
  w.y = Math.max(top + boxH, fy + CONTENTS_H) + 8;
}

/** The contents box on the cover, with links (drawn after everything else). */
function drawContents(b: BuildCtx): void {
  const { w } = b;
  if (!b.contents) return;
  w.pdf.setPage(1);
  w.pen.reset();
  const { x, width } = b.contents;
  let y = b.contents.y;
  w.kicker('In this pattern', x, y + 6);
  y += 12;
  const rows: { title: string; first: number; last: number }[] = [];
  for (const id of ['materials', 'notes', 'chart', 'instructions'] as const) {
    const s = w.sections.get(id);
    if (s) rows.push({ title: SECTION_TITLES[id], first: s.first, last: s.last });
  }
  const style: TextStyle = { ...BODY, size: 9 };
  for (const r of rows) {
    const pages = r.first === r.last ? `p. ${r.first}` : `pp. ${r.first}–${r.last}`;
    w.pen.text(toWinAnsi(r.title), x, y + 9, style);
    w.pen.text(pages, x + width, y + 9, { ...style, color: MUTED }, { align: 'right' });
    colors(w.pdf, null, RULE);
    w.pdf.setLineWidth(0.4);
    w.pdf.setLineDashPattern([0.6, 2], 0);
    const tx = x + w.measure(toWinAnsi(r.title), style) + 4;
    const px = x + width - w.measure(pages, style) - 4;
    if (px > tx) w.pdf.line(tx, y + 8.6, px, y + 8.6);
    w.pdf.setLineDashPattern([], 0);
    w.pdf.link(x, y, width, 12, { pageNumber: r.first });
    y += 14;
  }
}

function materialsSection(b: BuildCtx): void {
  const { doc, w } = b;
  const { pdf, pen } = w;
  w.heading(SECTION_TITLES.materials, 90, 'materials');
  const rows = materialRows(doc);
  const showSkeins = rows.some((r) => r.skeins !== '—');
  const showGrams = rows.some((r) => r.grams !== '—');
  type Col = { key: string; head: string; width: number; align: 'left' | 'right' };
  const cols: Col[] = [
    { key: 'color', head: 'Color', width: 46, align: 'left' },
    { key: 'yarn', head: 'Yarn', width: 0, align: 'left' },
    { key: 'stitches', head: 'Stitches', width: 60, align: 'right' },
    { key: 'strands', head: strandsHeading(doc.chart?.technique), width: 48, align: 'right' },
    { key: 'yards', head: 'Yards', width: 62, align: 'right' },
    { key: 'meters', head: 'Meters', width: 46, align: 'right' },
    ...(showSkeins ? [{ key: 'skeins', head: 'Skeins', width: 42, align: 'right' as const }] : []),
    ...(showGrams ? [{ key: 'grams', head: 'Grams', width: 64, align: 'right' as const }] : []),
  ];
  const fixed = cols.reduce((s, c) => s + c.width, 0);
  cols[1].width = w.width - fixed;
  const xs: number[] = [];
  let acc = w.x0;
  for (const c of cols) {
    xs.push(acc);
    acc += c.width;
  }
  const pad = 5;
  const head = (): void => {
    const hs: TextStyle = { font: 'helvetica', style: 'bold', size: 6.8, color: MUTED };
    cols.forEach((c, i) => {
      const t = c.head.toUpperCase();
      if (c.align === 'right') pen.text(t, xs[i] + c.width - pad, w.y + 9, hs, { align: 'right', charSpace: 0.4 });
      else pen.text(t, xs[i] + (i === 0 ? 0 : pad), w.y + 9, hs, { charSpace: 0.4 });
    });
    w.y += 14;
    colors(pdf, null, INK);
    pdf.setLineWidth(0.7);
    pdf.line(w.x0, w.y, w.x1, w.y);
  };
  w.ensure(14 + 26 * Math.min(rows.length, 3));
  head();
  const symbols = b.chart?.ctx.symbols;
  const num: TextStyle = { ...BODY, size: 9 };
  const sub: TextStyle = { ...SMALL, size: 7.4 };
  rows.forEach((r, i) => {
    const rh = 27;
    if (w.y + rh > w.bottom) {
      w.newPage();
      head();
    }
    if (i % 2 === 1) {
      colors(pdf, PANEL, null);
      pdf.rect(w.x0, w.y, w.width, rh, 'F');
    }
    const top = w.y;
    const b1 = top + 11.5;
    const b2 = top + 21.5;
    // Color: a swatch with the chart symbol, then the code.
    const fill = hexRgb(r.hex);
    colors(pdf, fill, GRID_HEAVY);
    pdf.setLineWidth(0.5);
    pdf.rect(xs[0], top + 6, 15, 13, 'FD');
    const sym = symbols?.find((s) => s.entry.code === r.code);
    if (sym) {
      const ink = hexRgb(sym.ink);
      colors(pdf, ink, ink);
      drawSymbol(pdf, sym.symbol, xs[0] + 7.5, top + 12.5, 13, pen, ink);
    }
    pen.text(toWinAnsi(r.code), xs[0] + 21, top + 16, { ...BODY, size: 10, style: 'bold' });
    // Yarn.
    const yw = cols[1].width - 2 * pad;
    pen.text(fit(w, r.yarn, num, yw), xs[1] + pad, b1, num);
    const detail = [r.yarnDetail, r.match].filter(Boolean).join('  ·  ');
    if (detail) {
      const lines = w.lay([{ text: detail }], sub, yw);
      if (lines[0]) drawLine(pen, lines[0], xs[1] + pad, b2);
    }
    const right = (key: string, a: string, bText?: string): void => {
      const i2 = cols.findIndex((c) => c.key === key);
      if (i2 < 0) return;
      const x = xs[i2] + cols[i2].width - pad;
      pen.text(toWinAnsi(a), x, b1, num, { align: 'right' });
      if (bText) pen.text(toWinAnsi(bText), x, b2, sub, { align: 'right' });
    };
    right('stitches', r.stitches, r.share);
    right('strands', r.strands);
    right('yards', r.yards, r.yardRange ? `${r.yardRange} yd` : undefined);
    right('meters', r.meters);
    right('skeins', r.skeins);
    right('grams', r.grams.replace(/ \(to \d+\)$/, ''), /\(to (\d+)\)/.exec(r.grams)?.[1] ? `to ${/\(to (\d+)\)/.exec(r.grams)?.[1]} g` : undefined);
    w.y += rh;
  });
  // Totals.
  if (rows.length > 1) {
    w.ensure(22);
    colors(pdf, null, INK);
    pdf.setLineWidth(0.7);
    pdf.line(w.x0, w.y, w.x1, w.y);
    const t = materialTotals(doc);
    const bold: TextStyle = { ...BODY, size: 9, style: 'bold' };
    pen.text('Total', xs[1] + pad, w.y + 12.5, bold);
    const at = (key: string, text: string): void => {
      const i2 = cols.findIndex((c) => c.key === key);
      if (i2 >= 0) pen.text(toWinAnsi(text), xs[i2] + cols[i2].width - pad, w.y + 12.5, bold, { align: 'right' });
    };
    at('stitches', t.stitches);
    at('yards', t.yards);
    at('meters', t.meters);
    w.y += 18;
  } else {
    colors(pdf, null, INK);
    pdf.setLineWidth(0.7);
    pdf.line(w.x0, w.y, w.x1, w.y);
    w.y += 4;
  }
  w.y += 6;
  w.paragraph(
    [
      {
        text:
          'Yardage is estimated for the stated gauge and includes tails and a safety margin; the small range under each amount covers looser or tighter tension. ' +
          (showSkeins ? 'Skeins are counted for the high end of the range — buy each color from one dye lot.' : 'Buy enough for the high end of the range, each color from one dye lot.'),
      },
    ],
    { ...SMALL, size: 7.6 },
    { gapAfter: 10, leading: 1.4 },
  );

  // Hook and notions.
  const def = (label: string, value: string): void => {
    const lw = 62;
    const lines = w.lay([{ text: value }], BODY, w.width - lw);
    w.ensure(lines.length * 13.5 + 4);
    w.kicker(label, w.x0, w.y + 9);
    for (const line of lines) {
      drawLine(pen, line, w.x0 + lw, w.y + 9.5);
      w.y += 13.5;
    }
    w.y += 3;
  };
  def('Hook', hookText(doc.hook));
  if (doc.notions.length > 0) def('Notions', doc.notions.join(' · '));
}

function gaugeSection(b: BuildCtx): void {
  const { doc, w } = b;
  w.heading(SECTION_TITLES.gauge, 40, 'gauge');
  w.paragraph([{ text: doc.gaugeText || 'Work to the gauge of your swatch.' }], { ...BODY, size: 10.5, style: 'bold' }, { gapAfter: 3 });
  w.paragraph(
    [{ text: 'Make a swatch a little larger than 4" (10 cm) square and measure it before you start. More stitches than stated: try a larger hook; fewer: a smaller one. The finished size and yardage depend on it.' }],
    { ...BODY, size: 8.8, color: MUTED },
    { gapAfter: 4 },
  );
}

function bulletList(w: Writer, items: readonly string[], style: TextStyle = BODY): void {
  const indent = 12;
  for (const item of items) {
    const lead = LEADING * style.size;
    const lines = w.lay([{ text: item }], style, w.width - indent);
    w.ensure(Math.min(lines.length, 2) * lead);
    lines.forEach((line, i) => {
      w.ensure(lead);
      const base = w.baseline(lead, style.size);
      if (i === 0) {
        colors(w.pdf, ACCENT, null);
        w.pdf.circle(w.x0 + 3, base - style.size * 0.32, 1.5, 'F');
      }
      drawLine(w.pen, line, w.x0 + indent, base);
      w.y += lead;
    });
    w.y += 2.5;
  }
}

function notesSection(b: BuildCtx): void {
  const { doc, w } = b;
  if (doc.notes.length === 0) return;
  w.heading(SECTION_TITLES.notes, 40, 'notes');
  bulletList(w, doc.notes);
}

function abbreviationsSection(b: BuildCtx): void {
  const { doc, w } = b;
  const { pen } = w;
  if (doc.abbreviations.length === 0 && doc.specialStitches.length === 0) return;
  w.heading(doc.abbreviations.length > 0 ? SECTION_TITLES.abbreviations : 'Special stitches', 40, 'abbreviations');
  if (doc.abbreviations.length > 0) {
    // Two columns, filled top to bottom.
    const half = Math.ceil(doc.abbreviations.length / 2);
    const colW = (w.width - 24) / 2;
    const abbrW = 52;
    const lead = 13.5;
    const rowsNeeded = (list: readonly { abbr: string; meaning: string }[]): number[] => list.map((a) => w.lay([{ text: a.meaning }], BODY, colW - abbrW).length);
    const left = doc.abbreviations.slice(0, half);
    const right = doc.abbreviations.slice(half);
    const lh = rowsNeeded(left);
    const rh = rowsNeeded(right);
    for (let i = 0; i < half; i++) {
      const h = Math.max(lh[i] ?? 1, rh[i] ?? 0) * lead;
      w.ensure(h);
      const row = (a: { abbr: string; meaning: string } | undefined, x: number): void => {
        if (!a) return;
        pen.text(fit(w, a.abbr, { ...BODY, style: 'bold' }, abbrW - 6), x, w.y + 9.5, { ...BODY, style: 'bold' });
        let y = w.y;
        for (const line of w.lay([{ text: a.meaning }], BODY, colW - abbrW)) {
          drawLine(pen, line, x + abbrW, y + 9.5);
          y += lead;
        }
      };
      row(left[i], w.x0);
      row(right[i], w.x0 + colW + 24);
      w.y += h;
    }
  }
  if (doc.specialStitches.length > 0) {
    if (doc.abbreviations.length > 0) {
      w.y += 8;
      w.ensure(40);
      pen.text('Special stitches', w.x0, w.y + 10, H3);
      w.y += 16;
    }
    for (const s of doc.specialStitches) w.paragraph([{ text: `${s.name}: `, style: { style: 'bold' } }, { text: s.text }], BODY, { gapAfter: 4 });
  }
}

/** Page map (when the chart spans several pages) and the chart's pages. */
async function chartSection(b: BuildCtx): Promise<{ mapPage: number | null; tilePages: number[] }> {
  const { doc, w } = b;
  if (!b.chart || !doc.chart) return { mapPage: null, tilePages: [] };
  const { ctx, layout } = b.chart;
  const { grid } = ctx;
  const { pdf, pen } = w;
  const tiles = layout.tiles;
  const first = tiles.length > 1 ? 1 : 0; // the map takes the first chart page
  const startPage = w.page + 1;
  const tilePages = tiles.map((t) => startPage + first + t.index);
  const unit = doc.chart.technique === 'c2c' ? 'tiles' : 'stitches';
  const border = borderRounds(doc);
  const borderNote = border > 0 ? ` The ${border === 1 ? '1-round' : `${border}-round`} border is not charted: see the instructions.` : '';
  const c2c = doc.chart.technique === 'c2c';
  const rowWord = doc.chart.technique === 'sc_tapestry_round' ? 'Rnd' : 'Row';
  // Where to start, in words: C2C rows are diagonals (the written rows name the start corner).
  const startText = c2c ? 'Work the diagonals from the corner the written rows name.' : `${rowWord} 1 starts at the bottom ${ctx.side}`;
  const start = startTile(layout, grid.cols, grid.rows, ctx.side);

  let mapPage: number | null = null;
  if (tiles.length > 1) {
    w.sectionPage('chart', layout.orientation);
    mapPage = w.page;
    w.outline[w.outline.length - 1].children.push({ title: 'Page map', page: mapPage });
    w.title1(
      'Chart',
      `The chart spans ${tiles.length} pages, ${layout.across} across and ${layout.down} down. Neighboring pages repeat 2 ${unit === 'tiles' ? 'tiles' : 'stitches'} and 2 rows, shown inside dashed lines. ` +
        (c2c ? `${startText} ` : `${startText} (page ${start ? tilePages[start.index] : tilePages[0]}). `) +
        `On screen, click a page on the map to go there.${borderNote}`,
    );
    const key = keyLayout(ctx.symbols.length, w.width);
    const keyH = 16 + key.rows * CHART_BANDS.keyRow;
    const box = { x: w.x0, y: w.y + 4, w: w.width, h: w.bottom - keyH - 14 - (w.y + 4) };
    const thumb = drawThumbnail(w, grid, layout.cell, box, layout.cell.h * 2);
    const cw = layout.cell.w * thumb.scale;
    const ch = layout.cell.h * thumb.scale;
    for (const t of tiles) {
      const x = thumb.x + t.col0 * cw;
      const y = thumb.y + t.row0 * ch;
      const tw = (t.col1 - t.col0) * cw;
      const th = (t.row1 - t.row0) * ch;
      colors(pdf, null, ACCENT);
      pdf.setLineWidth(1.3);
      pdf.rect(x, y, tw, th, 'S');
      const label = `p. ${tilePages[t.index]}`;
      const ls: TextStyle = { font: 'helvetica', style: 'bold', size: 9, color: ACCENT };
      const lw = w.measure(label, ls) + 9;
      colors(pdf, WHITE, ACCENT);
      pdf.setLineWidth(0.8);
      pdf.roundedRect(x + tw / 2 - lw / 2, y + th / 2 - 7.5, lw, 15, 3, 3, 'FD');
      pen.text(label, x + tw / 2, y + th / 2 + 3.2, ls, { align: 'center' });
      pdf.link(x, y, tw, th, { pageNumber: tilePages[t.index] });
    }
    drawKey(w, ctx, layout, w.bottom - keyH, { counts: true });
    await b.progress(0.4);
  }

  for (const tile of tiles) {
    if (tiles.length === 1) w.sectionPage('chart', layout.orientation);
    else w.newPage(layout.orientation);
    w.outline[w.outline.length - 1].children.push({ title: tiles.length > 1 ? `Chart page ${tile.index + 1}` : 'Chart', page: w.page });
    const ranges = tileRanges(tile, grid.cols, grid.rows, ctx.side);
    const rowRange = `${c2c ? 'Chart rows' : rowWord === 'Rnd' ? 'Rounds' : 'Rows'} ${ranges.rows[0]}–${ranges.rows[1]}`;
    const stRange = `${unit} ${ranges.stitches[0]}–${ranges.stitches[1]}`;
    const top = PAGE.top;
    const heading = tiles.length > 1 ? `Chart — page ${tile.index + 1} of ${tiles.length}` : 'Chart';
    pen.text(toWinAnsi(heading), w.x0, top + 12, { font: 'times', style: 'bold', size: 14, color: INK });
    const caption =
      tiles.length > 1
        ? `${rowRange} · ${stRange}. Dashed lines: repeated on the next page.`
        : `${rowRange} · ${stRange}. ${c2c ? startText : `${startText}; bold numbers mark where each row starts.`}${borderNote}`;
    const capLines = w.lay([{ text: caption }], { ...SMALL, size: 7.6 }, w.width - (tiles.length > 1 ? 90 : 0));
    capLines.slice(0, 2).forEach((line, i) => drawLine(pen, line, w.x0, top + 24 + i * 9.5));
    if (tiles.length > 1) drawMiniMap(w, layout, tile, w.x1, top + 2, 26);

    const nCols = tile.col1 - tile.col0;
    const gridW = nCols * layout.cell.w;
    const gx = w.x0 + CHART_BANDS.gutter + (w.width - 2 * CHART_BANDS.gutter - gridW) / 2;
    const gy = top + CHART_BANDS.title + CHART_BANDS.numbers;
    drawTile(w, ctx, layout, tile, gx, gy);
    // The key sits under the grid, or at the foot of the page when the grid is that tall.
    const gridBottom = gy + (tile.row1 - tile.row0) * layout.cell.h + CHART_BANDS.numbers;
    const keyTop = Math.min(w.bottom - (CHART_BANDS.keyHead - 10 + layout.keyRows * CHART_BANDS.keyRow), gridBottom + 14);
    drawKey(w, ctx, layout, keyTop);
    await b.progress(0.4 + (0.45 * (tile.index + 1)) / tiles.length);
  }
  return { mapPage, tilePages };
}

function instructionsSection(b: BuildCtx, blocks: readonly InstructionBlock[]): void {
  const { w } = b;
  const { pen, pdf } = w;
  w.sectionPage('instructions');
  w.title1('Instructions', 'Tick the box beside each row as you finish it. The chart and these rows say the same thing: use whichever you find easier, and the other to check.');
  const style: TextStyle = { ...BODY, size: 9.5 };
  const lead = LEADING * style.size;
  const box = 8.2;
  const indent = 17;
  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (block.level === 2) w.heading(spansText(block.text), 50);
      else {
        w.ensure(24 + 40);
        w.y += 6;
        drawLine(pen, w.lay(block.text, H3, w.width)[0] ?? { pieces: [], width: 0, size: H3.size }, w.x0, w.y + 11);
        w.y += 18;
      }
      continue;
    }
    if (block.kind === 'step') {
      const lines = w.lay([...block.label, { text: ' ' }, ...block.body], style, w.width - indent);
      const h = lines.length * lead;
      // Keep a row on one page unless it is very long.
      if (h <= (w.bottom - PAGE.top) * 0.4) w.ensure(h);
      lines.forEach((line, i) => {
        w.ensure(lead);
        const base = w.baseline(lead, style.size);
        if (i === 0) checkbox(pdf, w.x0, base - box + 0.6, box);
        drawLine(pen, line, w.x0 + indent, base);
        w.y += lead;
      });
      w.y += 4;
      continue;
    }
    if (block.kind === 'text') {
      const depth = block.depth ?? 0;
      const x = w.x0 + (block.bullet ? 12 + depth * 12 : 0);
      const lines = w.lay(block.spans, style, w.x1 - x);
      lines.forEach((line, i) => {
        w.ensure(lead);
        const base = w.baseline(lead, style.size);
        if (i === 0 && block.bullet) {
          if (block.bullet === '•') {
            colors(pdf, ACCENT, null);
            pdf.circle(x - 9, base - style.size * 0.32, 1.5, 'F');
          } else pen.text(toWinAnsi(block.bullet), x - 4, base, { ...style, color: MUTED }, { align: 'right' });
        }
        drawLine(pen, line, x, base);
        w.y += lead;
      });
      w.y += 4;
      continue;
    }
    // A table: equal columns.
    const n = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
    const cw = w.width / n;
    const drawRow = (cells: Span[][], s: TextStyle, shade: boolean): void => {
      const laid = cells.map((c) => w.lay(c, s, cw - 8));
      const h = Math.max(1, ...laid.map((l) => l.length)) * lead + 4;
      w.ensure(h);
      if (shade) {
        colors(pdf, PANEL, null);
        pdf.rect(w.x0, w.y, w.width, h, 'F');
      }
      laid.forEach((ls, i) => ls.forEach((line, j) => drawLine(pen, line, w.x0 + i * cw + 4, w.y + 2 + j * lead + lead / 2 + s.size * 0.34)));
      w.y += h;
    };
    drawRow(block.header, { ...style, style: 'bold' }, false);
    colors(pdf, null, INK);
    pdf.setLineWidth(0.6);
    pdf.line(w.x0, w.y, w.x1, w.y);
    block.rows.forEach((r, i) => drawRow(r, style, i % 2 === 1));
    w.y += 6;
  }
}

function spansText(spans: readonly Span[]): string {
  return spans.map((s) => s.text).join('');
}

/** Running header (pages 2…) and footer (every page). */
function decorate(w: Writer, doc: PatternDoc): void {
  const { pdf, pen } = w;
  const total = pdf.getNumberOfPages();
  for (let p = 1; p <= total; p++) {
    pdf.setPage(p);
    pen.reset();
    const W = pdf.internal.pageSize.getWidth();
    const H = pdf.internal.pageSize.getHeight();
    const head: TextStyle = { font: 'helvetica', style: 'normal', size: 7.5, color: MUTED };
    if (p > 1) {
      pen.text(fit(w, doc.title.trim() || 'Untitled pattern', head, W / 2 - PAGE.side), PAGE.side, 34, head);
      pen.text(toWinAnsi(w.labels[p - 1] ?? ''), W - PAGE.side, 34, { ...head, style: 'bold', color: ACCENT }, { align: 'right' });
      colors(pdf, null, RULE);
      pdf.setLineWidth(0.5);
      pdf.line(PAGE.side, 40, W - PAGE.side, 40);
    }
    colors(pdf, null, RULE);
    pdf.setLineWidth(0.5);
    pdf.line(PAGE.side, H - 38, W - PAGE.side, H - 38);
    pen.text('Made with Crochet Pattern Generator', PAGE.side, H - 26, { ...head, color: FAINT });
    pen.text(`Page ${p} of ${total}`, W - PAGE.side, H - 26, head, { align: 'right' });
  }
}

function outline(w: Writer): void {
  const o = (w.pdf as unknown as { outline?: { add(parent: unknown, title: string, opts: { pageNumber: number }): unknown } }).outline;
  if (!o) return;
  for (const e of w.outline) {
    const node = o.add(null, e.title, { pageNumber: e.page });
    if (e.children.length > 1) for (const c of e.children) o.add(node, c.title, { pageNumber: c.page });
  }
}

/** A 32-hex file id from the doc's hash (jsPDF's default is random). */
function fileId(doc: PatternDoc): string {
  const hex = (doc.hash || '').toLowerCase().replace(/[^0-9a-f]/g, '');
  return (hex + '0'.repeat(32)).slice(0, 32);
}

/** The PDF of a pattern with its report (pages per section, chart tiling). See the module comment. */
export async function buildPatternPdf(doc: PatternDoc, o: PatternPdfOptions): Promise<PdfReport> {
  const check = o.preflight ?? preflightPdf(doc);
  if (check.errors.length > 0) throw new PdfBlockedError(check.errors);
  const paper: Paper = o.paper === 'a4' ? 'a4' : 'letter';
  const { jsPDF } = await import('jspdf');
  const pdf = new jsPDF({ unit: 'pt', format: paper, orientation: 'portrait', compress: true, putOnlyUsedFonts: true });
  pdf.setCreationDate(o.createdAt ? pdfDate(o.createdAt) : FIXED_CREATION_DATE);
  pdf.setFileId(fileId(doc));
  pdf.setDocumentProperties({ title: toWinAnsi(doc.title || 'Crochet pattern'), subject: 'Crochet pattern', creator: 'Crochet Pattern Generator', keywords: 'crochet, pattern' });
  const w = new Writer(pdf, paper);

  let lastYield = 0;
  const progress = async (f: number): Promise<void> => {
    if (!o.onProgress) return;
    o.onProgress(Math.min(1, Math.max(0, f)));
    const now = performance.now();
    if (now - lastYield > 40) {
      lastYield = now;
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  };

  const grid = doc.chart?.grid;
  const chartOk = !!grid && grid.cols > 0 && grid.rows > 0 && grid.labels.length >= grid.cols * grid.rows && grid.palette.length > 0;
  const b: BuildCtx = {
    doc,
    w,
    chart:
      chartOk && doc.chart
        ? {
            ctx: { grid: doc.chart.grid, symbols: assignSymbols(doc.chart.grid), side: startSide(doc), arrows: doc.chart.technique === 'c2c' ? new Map() : rowArrows(doc) },
            layout: planChart(paper, doc.chart.grid.cols, doc.chart.grid.rows, doc.chart.cell, doc.chart.grid.palette.length),
          }
        : null,
    contents: null,
    progress,
  };
  const text = patternText(doc);
  const blocks = instructionBlocks(text.md, doc.title);

  coverPage(b);
  materialsSection(b);
  gaugeSection(b);
  notesSection(b);
  abbreviationsSection(b);
  await progress(0.2);
  const chart = await chartSection(b);
  instructionsSection(b, blocks);
  await progress(0.92);
  drawContents(b);
  decorate(w, doc);
  outline(w);

  const bytes = pdf.output('arraybuffer');
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const sections: PdfSectionInfo[] = [];
  for (const [id, s] of w.sections) sections.push({ id, title: SECTION_TITLES[id], first: s.first, last: s.last });
  await progress(1);
  return {
    blob,
    pages: pdf.getNumberOfPages(),
    sections,
    ...(b.chart ? { chart: { layout: b.chart.layout, mapPage: chart.mapPage, tilePages: chart.tilePages } } : {}),
    textSource: text.source,
    warnings: check.warnings,
  };
}

/** §5.2.1: the pattern PDF (Letter or A4). Throws `PdfBlockedError` while the pattern has errors. */
export const buildPdf: BuildPdfFn = async (doc, o) => (await buildPatternPdf(doc, o)).blob;

export type { Paper } from './chartPages';
