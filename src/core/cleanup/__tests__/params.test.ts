import { describe, expect, it } from 'vitest';
import type { Technique2D } from '../../../types/gauge';
import { cleanupFamily, cleanupParams, workingPath } from '../params';

const ALL: Technique2D[] = ['sc_graphgan', 'sc_tapestry', 'sc_tapestry_round', 'c2c', 'hdc_graphgan', 'mosaic_overlay'];

describe('cleanupParams — the §2.5 table', () => {
  it('Balanced (default): graph & C2C vs tapestry', () => {
    expect(cleanupParams('sc_graphgan', 'balanced', 1000)).toEqual({ family: 'graph', confettiPasses: 3, aMin: 2, lambda: 0.4, rMin: 1, rareMin: 10 });
    expect(cleanupParams('c2c', 'balanced', 1000)).toEqual({ family: 'graph', confettiPasses: 3, aMin: 2, lambda: 0.4, rMin: 1, rareMin: 10 });
    expect(cleanupParams('sc_tapestry', 'balanced', 1000)).toEqual({ family: 'tapestry', confettiPasses: 3, aMin: 3, lambda: 0.6, rMin: 2, rowCap: 3, rareMin: 10 });
  });

  it('Max detail: confetti, components and Potts off; tapestry cap 4', () => {
    expect(cleanupParams('hdc_graphgan', 'max', 1000)).toEqual({ family: 'graph', confettiPasses: 0, aMin: 1, lambda: 0, rMin: 1, rareMin: 0 });
    expect(cleanupParams('sc_tapestry_round', 'max', 1000)).toEqual({ family: 'tapestry', confettiPasses: 0, aMin: 1, lambda: 0, rMin: 1, rowCap: 4, rareMin: 0 });
  });

  it('Easy: rare-color minimum is 0.5% of the cells (rounded up)', () => {
    expect(cleanupParams('c2c', 'easy', 3600)).toEqual({ family: 'graph', confettiPasses: 3, aMin: 4, lambda: 0.8, rMin: 2, rareMin: 18 });
    expect(cleanupParams('sc_tapestry', 'easy', 1001)).toEqual({ family: 'tapestry', confettiPasses: 3, aMin: 5, lambda: 1, rMin: 3, rowCap: 2, rareMin: 6 });
  });

  it('families; an unknown preset throws', () => {
    expect(ALL.map(cleanupFamily)).toEqual(['graph', 'tapestry', 'tapestry', 'graph', 'graph', 'graph']);
    expect(() => cleanupParams('sc_graphgan', 'extreme' as never, 10)).toThrow(RangeError);
  });
});

describe('workingPath', () => {
  it('flat rows bottom-up: line k is chart row rows − k (§2.7.2), cells left to right', () => {
    const p = workingPath('sc_graphgan', 3, 4);
    expect(p.lines.map((l) => [...l])).toEqual([[9, 10, 11], [6, 7, 8], [3, 4, 5], [0, 1, 2]]);
    expect(p.circular).toBe(false);
    expect(p.wrap).toBe(false);
    expect([...p.lineOf]).toEqual([3, 3, 3, 2, 2, 2, 1, 1, 1, 0, 0, 0]);
  });

  it('rounds are circular and wrap', () => {
    const p = workingPath('sc_tapestry_round', 5, 2);
    expect(p.circular).toBe(true);
    expect(p.wrap).toBe(true);
    expect(p.lines.length).toBe(2);
  });

  it('C2C diagonals start at the start corner; every cell once; neighbors along a line touch at corners', () => {
    const cols = 5;
    const rows = 3;
    const first: Record<string, number> = { BR: rows * cols - 1, TL: 0, BL: (rows - 1) * cols, TR: cols - 1 };
    for (const corner of ['BR', 'BL', 'TR', 'TL'] as const) {
      const p = workingPath('c2c', cols, rows, corner);
      expect(p.lines.length).toBe(cols + rows - 1);
      expect([...p.lines[0]]).toEqual([first[corner]]);
      const seen = new Uint8Array(cols * rows);
      for (const line of p.lines) {
        for (const i of line) seen[i]++;
        for (let q = 1; q < line.length; q++) {
          const [a, b] = [line[q - 1], line[q]];
          expect(Math.abs(Math.floor(a / cols) - Math.floor(b / cols))).toBe(1);
          expect(Math.abs((a % cols) - (b % cols))).toBe(1);
        }
      }
      expect([...seen].every((s) => s === 1)).toBe(true);
      // The last diagonal is the opposite corner.
      expect(p.lines[p.lines.length - 1].length).toBe(1);
    }
  });

  it('rejects a bad size or corner', () => {
    expect(() => workingPath('sc_graphgan', 0, 3)).toThrow(RangeError);
    expect(() => workingPath('c2c', 2, 2, 'XX' as never)).toThrow(RangeError);
  });
});
