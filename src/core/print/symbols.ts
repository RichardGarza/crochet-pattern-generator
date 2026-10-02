// Track T8 — chart symbols for black-and-white printing, paired with the yarn colors (DESIGN.md §1.3 F8, §6.3 T8).
//
// Every chart cell is filled with its yarn color and carries a symbol, so a chart printed in grays still reads.
// The color used most (usually the background) gets no symbol — fewer marks make the motif stand out, as in
// published graphs — and every other color gets a distinct vector shape, in palette order (A, B, C …). After the
// 20 shapes the color's code letter is printed. The symbol is drawn in black or white, whichever contrasts more
// with the fill (WCAG contrast ratio), so it shows on dark yarns too.
//
// Shapes are drawn as vector paths in a unit cell (pdf.ts `drawSymbol`); no font is needed.
import type { ChartGrid, PaletteEntry } from '../../types';

export type ShapeId =
  | 'blank'
  | 'dot'
  | 'circle'
  | 'square'
  | 'square-open'
  | 'triangle'
  | 'triangle-open'
  | 'diamond'
  | 'diamond-open'
  | 'cross'
  | 'plus'
  | 'star'
  | 'triangle-down'
  | 'bar-v'
  | 'bar-h'
  | 'slash'
  | 'backslash'
  | 'circle-dot'
  | 'square-dot'
  | 'half-square'
  | 'heart';

/** The shapes in the order they are given out (most distinct first). */
export const SHAPES: readonly ShapeId[] = [
  'dot',
  'cross',
  'triangle',
  'square-open',
  'diamond',
  'circle',
  'plus',
  'star',
  'square',
  'triangle-open',
  'slash',
  'diamond-open',
  'triangle-down',
  'circle-dot',
  'bar-v',
  'heart',
  'backslash',
  'square-dot',
  'bar-h',
  'half-square',
];

export type ChartSymbol = { kind: 'shape'; shape: ShapeId } | { kind: 'text'; text: string };

export interface SymbolEntry {
  /** Palette index (= chart label). */
  label: number;
  entry: PaletteEntry;
  symbol: ChartSymbol;
  /** Symbol ink: black or white, for contrast with the fill. */
  ink: '#000000' | '#ffffff';
  /** Cells of this color in the chart. */
  count: number;
}

/** Cells per label (labels beyond the palette are counted too, so the caller can see them). */
export function labelCounts(grid: ChartGrid): number[] {
  const counts = new Array<number>(Math.max(grid.palette.length, 1)).fill(0);
  const n = Math.min(grid.labels.length, grid.cols * grid.rows);
  for (let i = 0; i < n; i++) {
    const l = grid.labels[i];
    if (l >= counts.length) counts.length = l + 1;
    counts[l] = (counts[l] ?? 0) + 1;
  }
  for (let i = 0; i < counts.length; i++) counts[i] ??= 0;
  return counts;
}

/** sRGB hex → [r, g, b] in 0…255 (bad input → mid gray, so a damaged palette still prints). */
export function hexRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [128, 128, 128];
  const n = Number.parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** WCAG relative luminance of an sRGB color. */
export function luminance(rgb: readonly [number, number, number]): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

/** Black or white, whichever has the higher contrast ratio against `hex`. */
export function inkFor(hex: string): '#000000' | '#ffffff' {
  const l = luminance(hexRgb(hex));
  const black = (l + 0.05) / 0.05;
  const white = 1.05 / (l + 0.05);
  return black >= white ? '#000000' : '#ffffff';
}

/**
 * The symbol of every palette color. The most-used color is blank (ties: the lowest label); the others get
 * `SHAPES` in palette order, then their code. A chart with one color has it blank.
 */
export function assignSymbols(grid: ChartGrid): SymbolEntry[] {
  const counts = labelCounts(grid);
  let blank = 0;
  for (let l = 1; l < grid.palette.length; l++) if ((counts[l] ?? 0) > (counts[blank] ?? 0)) blank = l;
  let next = 0;
  return grid.palette.map((entry, label) => {
    let symbol: ChartSymbol;
    if (label === blank) symbol = { kind: 'shape', shape: 'blank' };
    else if (next < SHAPES.length) symbol = { kind: 'shape', shape: SHAPES[next++] };
    else symbol = { kind: 'text', text: entry.code || String(label + 1) };
    return { label, entry, symbol, ink: inkFor(entry.hex), count: counts[label] ?? 0 };
  });
}

/** A short name of a symbol for the key ("blank", "dot", …). */
export function symbolName(s: ChartSymbol): string {
  return s.kind === 'text' ? `letter ${s.text}` : s.shape.replace('-', ' ');
}
