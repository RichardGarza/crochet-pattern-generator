// Chart fixtures for T2's tests. Not a test file.
//
// Until T1 lands, the writers are tested on committed `ChartResult` JSON (labels stored as a plain array) and on
// charts built in code. `fixtures/g9.chartResult.json` is the chart of DESIGN.md §2.7.3 (G9);
// `fixtures/heart.chartResult.json` is a 30 × 24 heart in five colors with a striped band at the bottom (long
// gaps for bobbins, short ones for carries), generated once by a small script and committed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { ChartGrid, ChartResult, ChartSettings, PaletteEntry } from '../../../types';
import type { Rng } from '../../kernel/prng';

/** Reads a committed ChartResult fixture and turns its labels back into a Uint8Array. */
export function loadChartResult(name: 'g9' | 'heart'): ChartResult {
  const path = fileURLToPath(new URL(`./fixtures/${name}.chartResult.json`, import.meta.url));
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Omit<ChartResult, 'grid'> & { grid: Omit<ChartGrid, 'labels'> & { labels: number[] } };
  return { ...raw, grid: { ...raw.grid, labels: Uint8Array.from(raw.grid.labels) } };
}

const CODES = 'ABCDEFGHIJKLMNOP';

export function palette(n: number): PaletteEntry[] {
  return Array.from({ length: n }, (_, i) => ({ code: CODES[i], hex: `#${(0x101010 * (i + 1)).toString(16).padStart(6, '0').slice(-6)}`, name: `Color ${CODES[i]}` }));
}

/** A chart from rows of letters, top row first (`'BAAAA'`): A = label 0, B = 1, … */
export function chartOf(rows: readonly string[]): ChartGrid {
  const cols = rows[0].length;
  const labels = new Uint8Array(cols * rows.length);
  let colors = 1;
  rows.forEach((row, r) => {
    if (row.length !== cols) throw new Error('ragged chart');
    for (let x = 0; x < cols; x++) {
      const label = CODES.indexOf(row[x]);
      labels[r * cols + x] = label;
      colors = Math.max(colors, label + 1);
    }
  });
  return { cols, rows: rows.length, labels, palette: palette(colors) };
}

/** A random chart: `colors` labels, runs of random length (so rows have structure). */
export function randomChart(rng: Rng, cols: number, rows: number, colors: number): ChartGrid {
  const labels = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    let x = 0;
    while (x < cols) {
      const label = Math.floor(rng() * colors);
      const len = 1 + Math.floor(rng() * Math.min(12, cols));
      for (let i = 0; i < len && x < cols; i++, x++) labels[r * cols + x] = label;
    }
  }
  return { cols, rows, labels, palette: palette(colors) };
}

/** Chart settings with the defaults of a new project; `over` replaces fields. */
export function settingsOf(over: Partial<ChartSettings> = {}): ChartSettings {
  return {
    technique: 'sc_graphgan',
    hand: 'right',
    startCorner: 'BR',
    lockAspect: true,
    border: { widthIn: 0 },
    maxColors: 'auto',
    paletteMode: 'auto',
    lineIds: [],
    referenceLineId: '',
    detail: 'balanced',
    dither: 'off',
    imageKind: 'auto',
    background: 'keep',
    applyRepeats: 'auto',
    roundLean: { mode: 'note', stPerRnd: 0.5 },
    ...over,
  };
}
