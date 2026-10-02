import { describe, expect, it } from 'vitest';
import type { Line, PatternDoc } from '../../../types';
import { mulberry32 } from '../../kernel/prng';
import {
  CELL_MIN_PT,
  CELL_SINGLE_MAX_PT,
  OVERLAP,
  PAPER_PT,
  cellsPerPage,
  planChart,
  printedCell,
  rowArrows,
  startSide,
  startTile,
  stitchNumber,
  tileRanges,
  tileSpans,
} from '../chartPages';

describe('tileSpans: balanced spans with a 2-item overlap', () => {
  it('covers every item, shares exactly 2 with each neighbor, and never exceeds a page (property, 3000 cases)', () => {
    const rng = mulberry32(17);
    for (let k = 0; k < 3000; k++) {
      const n = 1 + Math.floor(rng() * 400);
      const per = 3 + Math.floor(rng() * 60);
      const spans = tileSpans(n, per);
      expect(spans[0][0]).toBe(0);
      expect(spans[spans.length - 1][1]).toBe(n);
      for (const [a, b] of spans) {
        if (spans.length > 1) expect(b - a).toBeGreaterThan(OVERLAP);
        expect(b - a).toBeLessThanOrEqual(Math.max(per, n <= per ? n : per));
      }
      for (let i = 1; i < spans.length; i++) expect(spans[i - 1][1] - spans[i][0]).toBe(OVERLAP);
      // Minimal: one span fewer would not fit.
      if (spans.length > 1) expect((spans.length - 1) * (per - OVERLAP) + OVERLAP).toBeLessThan(n);
      // Balanced: all but the last span have one size; the last is not larger.
      const sizes = spans.map(([a, b]) => b - a);
      for (const s of sizes.slice(0, -1)) expect(s).toBe(sizes[0]);
      expect(sizes[sizes.length - 1]).toBeLessThanOrEqual(sizes[0]);
    }
  });

  it('one span when it fits; none for nothing', () => {
    expect(tileSpans(30, 33)).toEqual([[0, 30]]);
    expect(tileSpans(33, 33)).toEqual([[0, 33]]);
    expect(tileSpans(0, 33)).toEqual([]);
    expect(tileSpans(34, 33)).toEqual([
      [0, 18],
      [16, 34],
    ]);
  });
});

describe('printed cells keep the stitch aspect (D2)', () => {
  it('the shorter side is 11 pt; sc is wider than tall, hdc taller than wide; the long side is capped', () => {
    expect(printedCell({ w: 0.296, h: 0.25 })).toEqual({ w: CELL_MIN_PT * (0.296 / 0.25), h: CELL_MIN_PT });
    const hdc = printedCell({ w: 0.31, h: 0.375 });
    expect(hdc.w).toBe(CELL_MIN_PT);
    expect(hdc.h).toBeCloseTo((CELL_MIN_PT * 0.375) / 0.31, 9);
    expect(printedCell({ w: 10, h: 1 }).w).toBe(22);
    expect(printedCell({ w: Number.NaN, h: 0 })).toEqual({ w: CELL_MIN_PT, h: CELL_MIN_PT });
  });
});

describe('planChart: orientation and tiles', () => {
  const sc = { w: 4 / 13.5, h: 4 / 16 };

  it('a 120 × 150 sc chart on Letter: landscape, 3 × 5 = 15 pages (portrait would need 4 × 4 = 16)', () => {
    const layout = planChart('letter', 120, 150, sc, 6);
    expect(layout.orientation).toBe('landscape');
    expect([layout.across, layout.down, layout.tiles.length]).toEqual([3, 5, 15]);
    // Independently: cells per page from the page and band sizes, then the tile counts.
    const per = cellsPerPage({ w: 792, h: 612 }, printedCell(sc), 6);
    expect(layout.perPage).toEqual({ cols: per.cols, rows: per.rows });
    expect(layout.across).toBe(Math.ceil((120 - 2) / (per.cols - 2)));
    expect(layout.down).toBe(Math.ceil((150 - 2) / (per.rows - 2)));
    const portrait = cellsPerPage({ w: 612, h: 792 }, printedCell(sc), 6);
    expect(Math.ceil((120 - 2) / (portrait.cols - 2)) * Math.ceil((150 - 2) / (portrait.rows - 2))).toBe(16);
  });

  it('tiles are in reading order, cover every cell, and fit their page', () => {
    for (const [cols, rows, paper] of [
      [120, 150, 'letter'],
      [200, 200, 'a4'],
      [37, 300, 'letter'],
      [500, 20, 'a4'],
    ] as const) {
      const layout = planChart(paper, cols, rows, sc, 8);
      const seen = new Uint8Array(cols * rows);
      layout.tiles.forEach((t, i) => {
        expect(t.index).toBe(i);
        expect(t.col1 - t.col0).toBeLessThanOrEqual(layout.perPage.cols);
        expect(t.row1 - t.row0).toBeLessThanOrEqual(layout.perPage.rows);
        if (i > 0) {
          const p = layout.tiles[i - 1];
          expect(t.ty > p.ty || (t.ty === p.ty && t.tx === p.tx + 1)).toBe(true);
        }
        for (let r = t.row0; r < t.row1; r++) for (let c = t.col0; c < t.col1; c++) seen[r * cols + c] = 1;
      });
      expect(seen.every((v) => v === 1)).toBe(true);
      // Row 1 (the bottom row) is in the last band of tiles.
      expect(layout.tiles[layout.tiles.length - 1].row1).toBe(rows);
    }
  });

  it('a chart that fits on one page is printed larger, within the page and the cap', () => {
    const small = planChart('letter', 5, 3, sc, 2);
    expect(small.tiles).toHaveLength(1);
    expect(Math.min(small.cell.w, small.cell.h)).toBeCloseTo(CELL_SINGLE_MAX_PT, 6);
    const heart = planChart('letter', 30, 24, sc, 5);
    expect(heart.tiles).toHaveLength(1);
    expect(30 * heart.cell.w).toBeLessThanOrEqual(PAPER_PT.letter.w - 2 * 46 - 2 * 22 + 1e-6);
    expect(heart.cell.w / heart.cell.h).toBeCloseTo(sc.w / sc.h, 9);
  });
});

describe('row and stitch numbering', () => {
  const line = (n: number, arrow?: Line['arrow'], nEnd?: number, kind: Line['kind'] = 'row'): Line => ({ kind, n, ...(nEnd ? { nEnd } : {}), ...(arrow ? { arrow } : {}), ops: [], prevCount: null, stated: 5 });
  const doc = (lines: Line[], hand: PatternDoc['hand'] = 'right'): Pick<PatternDoc, 'pieces' | 'hand'> => ({
    hand,
    pieces: [{ id: 'p', title: '', makeCount: 1, partIds: [], intro: [], lines, finish: { kind: 'open', tailIn: 6, text: '' } }],
  });

  it('Row 1 starts on the side its arrow comes from; without an arrow, the hand decides', () => {
    expect(startSide(doc([line(1, '←')]))).toBe('right');
    expect(startSide(doc([line(1, '→')]))).toBe('left');
    expect(startSide(doc([line(1, '↖', undefined, 'c2c')]))).toBe('right');
    expect(startSide(doc([line(1)], 'left'))).toBe('left');
    expect(startSide(doc([line(1, '←', undefined, 'border')], 'left'))).toBe('left');
  });

  it('rowArrows: each row with its own line; folded ranges have none', () => {
    const arrows = rowArrows(doc([line(1, '←'), line(2, undefined, 3), line(4, '→'), line(1, undefined, undefined, 'border')]));
    expect([...arrows]).toEqual([
      [1, '←'],
      [4, '→'],
    ]);
  });

  it('stitch numbers count from the start side; tile ranges read low to high', () => {
    expect(stitchNumber(0, 30, 'right')).toBe(30);
    expect(stitchNumber(29, 30, 'right')).toBe(1);
    expect(stitchNumber(0, 30, 'left')).toBe(1);
    const layout = planChart('letter', 120, 150, { w: 4 / 13.5, h: 0.25 }, 6);
    const first = layout.tiles[0];
    expect(tileRanges(first, 120, 150, 'right')).toEqual({ rows: [150 - (first.row1 - 1), 150], stitches: [120 - (first.col1 - 1), 120] });
    const start = startTile(layout, 120, 150, 'right');
    expect(start?.tx).toBe(layout.across - 1);
    expect(start?.ty).toBe(layout.down - 1);
  });
});
