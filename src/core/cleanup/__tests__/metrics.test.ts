import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ChartGrid, PaletteEntry } from '../../../types/chart';
import { ciede2000, hexToLab } from '../../kernel/color';
import {
  changeStats,
  chartMetrics,
  confettiShare,
  fidelityCache,
  fidelityDE00,
  isConfetti,
  lineChanges,
  strandStats,
  workabilityScore,
} from '../metrics';
import { workingPath } from '../params';

/** A label grid from rows of digits. */
function grid(rows: string[]): { labels: Uint8Array; cols: number; rows: number } {
  const cols = rows[0].length;
  return { labels: Uint8Array.from(rows.join('').split('').map(Number)), cols, rows: rows.length };
}

const HEX = ['#ffffff', '#000000', '#c8102e', '#2c3e8f', '#f9d71c'];
const palette = (k: number): PaletteEntry[] => HEX.slice(0, k).map((hex, i) => ({ code: String.fromCharCode(65 + i), hex, name: hex }));

describe('confetti (§2.5 step 1 definition)', () => {
  it('0 same-label 4-neighbors and ≤ 1 same-label 8-neighbor', () => {
    const g = grid(['10000', '01000', '00100', '00000', '00001']);
    expect(isConfetti(g.labels, g.cols, g.rows, 24)).toBe(true); // alone
    // A diagonal line: the middle cell has two diagonal same-label neighbors → not confetti; its ends have one.
    expect(isConfetti(g.labels, g.cols, g.rows, 6)).toBe(false);
    expect(isConfetti(g.labels, g.cols, g.rows, 0)).toBe(true);
    expect(isConfetti(g.labels, g.cols, g.rows, 12)).toBe(true);
    expect(isConfetti(g.labels, g.cols, g.rows, 1)).toBe(false); // background
    const pair = grid(['000', '110', '000']);
    expect(isConfetti(pair.labels, 3, 3, 3)).toBe(false);
    // A single cell has no neighbors at all: not confetti.
    expect(isConfetti(Uint8Array.of(0), 1, 1, 0)).toBe(false);
    expect(confettiShare(g.labels, g.cols, g.rows)).toBeCloseTo(3 / 25, 12);
  });

  it('rounds wrap: a cell at column 0 sees the last column', () => {
    const g = grid(['1000', '1001', '1000']);
    expect(isConfetti(g.labels, 4, 3, 7, false)).toBe(true);
    expect(isConfetti(g.labels, 4, 3, 7, true)).toBe(false);
  });
});

describe('color changes along the working path', () => {
  it('rows, rounds (the seam counts) and C2C diagonals', () => {
    const g = grid(['0110', '1001', '0000']);
    expect([...lineChanges(g.labels, workingPath('sc_graphgan', 4, 3))]).toEqual([0, 2, 2]);
    expect([...lineChanges(g.labels, workingPath('sc_tapestry_round', 4, 3))]).toEqual([0, 2, 2]);
    const seam = grid(['0001']);
    expect([...lineChanges(seam.labels, workingPath('sc_tapestry_round', 4, 1))]).toEqual([2]);
    expect([...lineChanges(seam.labels, workingPath('sc_tapestry', 4, 1))]).toEqual([1]);
    // C2C from TL: diagonals r + c = 0, 1, …
    const d = grid(['00', '01']);
    expect([...lineChanges(d.labels, workingPath('c2c', 2, 2, 'TL'))]).toEqual([0, 0, 0]);
    expect([...lineChanges(d.labels, workingPath('c2c', 2, 2, 'BL'))]).toEqual([0, 1, 0]);
  });

  it('changeStats: mean, max, up to 3 busiest lines (1-based, most first, ties → first)', () => {
    expect(changeStats(Int32Array.from([0, 3, 1, 3, 2, 0]))).toEqual({ mean: 1.5, max: 3, busiest: [2, 4, 5] });
    expect(changeStats(Int32Array.from([0, 0]))).toEqual({ mean: 0, max: 0, busiest: [] });
    expect(changeStats(new Int32Array(0))).toEqual({ mean: 0, max: 0, busiest: [] });
  });
});

describe('strands (§2.7.3 bobbins, §2.7.4 tapestry)', () => {
  const graph = (rows: string[]): ReturnType<typeof strandStats> => {
    const g = grid(rows);
    return strandStats(g.labels, 3, workingPath('sc_graphgan', g.cols, g.rows), 'sc_graphgan');
  };

  it('a color absent for ≤ 8 stitches is carried (one strand); 9 stitches → a second strand', () => {
    expect(graph(['1000000001']).strandsPerColor).toEqual([1, 1, 0]); // gap 8
    expect(graph(['10000000001']).strandsPerColor).toEqual([1, 2, 0]); // gap 9
    expect([...graph(['10000000001']).heldPerLine]).toEqual([3]);
  });

  it('a run continues the strand of the row below when they overlap within 2 stitches', () => {
    // Worked bottom-up: the bottom row is line 1.
    expect(graph(['0001000', '0100000']).strandsPerColor[1]).toBe(1); // 2 apart: continues
    expect(graph(['0000100', '0100000']).strandsPerColor[1]).toBe(2); // 3 apart: new strand
    // One to one: two runs above one run below → one continues, one is new.
    expect(graph(['100000000000001', '111111111111111']).strandsPerColor[1]).toBe(2);
  });

  it('tapestry: joined once, cut after 2 lines without the color', () => {
    const run = (rows: string[]) => {
      const g = grid(rows);
      return strandStats(g.labels, 3, workingPath('sc_tapestry', g.cols, g.rows), 'sc_tapestry');
    };
    // Bottom-up: color 1 in lines 1, 3 (absent 1 line: carried) → 1 strand.
    expect(run(['0100', '0000', '0100']).strandsPerColor[1]).toBe(1);
    // Absent 2 lines → cut, joined again.
    expect(run(['0100', '0000', '0000', '0100']).strandsPerColor[1]).toBe(2);
    const r = run(['0100', '0000', '0000', '0100']);
    expect([...r.heldPerLine]).toEqual([2, 1, 1, 2]);
  });

  it('C2C runs are not carried', () => {
    const g = grid(['010', '000', '010']);
    const s = strandStats(g.labels, 2, workingPath('c2c', 3, 3, 'TL'), 'c2c');
    expect(s.strandsPerColor[1]).toBe(2);
  });
});

describe('fidelity, workability, chartMetrics', () => {
  it('fidelity = mean ΔE00 of each cell to its label color; the cache gives the same numbers', () => {
    const labels = Uint8Array.of(0, 1, 1);
    const pal = palette(2).map((p) => hexToLab(p.hex));
    const cellLab = Float64Array.from([...hexToLab('#ffffff'), ...hexToLab('#000000'), ...hexToLab('#202020')]);
    const want = ciede2000(hexToLab('#202020'), hexToLab('#000000')) / 3;
    expect(fidelityDE00(labels, pal, cellLab)).toBeCloseTo(want, 12);
    const cache = fidelityCache(3);
    expect(fidelityDE00(labels, pal, cellLab, cache)).toBeCloseTo(want, 12);
    labels[2] = 0;
    expect(fidelityDE00(labels, pal, cellLab, cache)).toBeCloseTo(fidelityDE00(labels, pal, cellLab), 12);
  });

  it('workability formula, clamped and rounded', () => {
    expect(workabilityScore({ confetti: 0, changesMean: 2, strands: 10, carriedMax: 2 })).toBe(100);
    // 100 − 300·0.01 − 4·1 − 0.2·40 − 5·1 = 80
    expect(workabilityScore({ confetti: 0.01, changesMean: 3, strands: 50, carriedMax: 3 })).toBe(80);
    expect(workabilityScore({ confetti: 0.5, changesMean: 30, strands: 999, carriedMax: 9 })).toBe(0);
  });

  it('chartMetrics: percent confetti, ends = 2 × strands, pure (same answer twice, input untouched)', () => {
    const g = grid(['00000', '01000', '00000', '00022', '00022']);
    const chart: ChartGrid = { cols: g.cols, rows: g.rows, labels: new Uint8Array(g.labels), palette: palette(3) };
    const before = new Uint8Array(chart.labels);
    const m = chartMetrics(chart, { technique: 'sc_graphgan' });
    expect(m.confettiPct).toBeCloseTo(4, 12);
    expect(m.strandsPerColor).toEqual([1, 1, 1]);
    expect(m.ends).toBe(6);
    expect(m.changesPerRowMean).toBeCloseTo(4 / 5, 12);
    expect(m.changesPerRowMax).toBe(2);
    expect(m.busiestRows).toEqual([4, 1, 2]);
    expect(m.carriedPerRowMax).toBe(2);
    expect(m.fidelityDE00).toBe(0);
    expect(m.workability).toBe(88);
    expect(chartMetrics(chart, { technique: 'sc_graphgan' })).toEqual(m);
    expect(chart.labels).toEqual(before);
  });

  it('nothing in core/cleanup reads Date or Math.random (§5.8)', () => {
    const dir = join(__dirname, '..');
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.ts'))) {
      // Code only (comments may name them).
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/\bDate\b|Math\.random|performance\.now/);
    }
  });
});
