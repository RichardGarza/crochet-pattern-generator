import { describe, expect, it } from 'vitest';
import type { ChartGrid, Hand, Line } from '../../../types';
import { resolveGauge } from '../../gauge';
import { mulberry32 } from '../../kernel/prng';
import { C2C_ARROWS, notesFor } from '../../pattern/notes';
import { renderLine } from '../../pattern/render';
import { c2cLabel, c2cRegions, c2cRows, c2cTiles, validateC2C, writeC2C } from '../c2c';
import { CORNERS, type Corner, c2cArrows, c2cFrame, cornerFromArrow } from '../c2cCorners';
import { buildPattern2DWith } from '../index';
import { validate2D } from '../validate2d';
import { chartOf, randomChart, settingsOf } from './fixtures';

const golden = chartOf(['BAAAA', 'ABBBA', 'AABAA']);
const compact = (line: Line): string => renderLine(line, { dialect: 'compact', terms: 'us', hand: 'right' });
const SIZES: [number, number][] = [
  [4, 4],
  [5, 3],
  [3, 5],
  [10, 7],
  [7, 10],
  [1, 5],
  [5, 1],
  [1, 1],
  [100, 60],
];

describe('c2c writer (DESIGN §2.7.6, G10)', () => {
  it('G10 golden 5 × 3, RH, start bottom-right: the §2.7.6 text exactly', () => {
    const { lines } = writeC2C(golden, { hand: 'right', corner: 'BR', cues: false });
    expect(lines.map(compact)).toEqual([
      '↙ Row 1 (RS) [first tile]: 1 A (1 tile)',
      '↗ Row 2 (WS) [inc beg · inc end]: 2 A (2 tiles)',
      '↙ Row 3 (RS) [inc beg · inc end]: 1 A, 2 B (3 tiles)',
      '↗ Row 4 (WS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)',
      '↙ Row 5 (RS) [dec beg · inc end]: 1 A, 1 B, 1 A (3 tiles)',
      '↗ Row 6 (WS) [dec beg · dec end]: 2 A (2 tiles)',
      '↙ Row 7 (RS) [dec beg · dec end]: 1 B (1 tile)',
    ]);
    expect(writeC2C(golden, { hand: 'right', cues: false }).corner).toBe('BR');
  });

  it('G10 golden 5 × 3, RH, start bottom-left (rotated 90° CCW): text and cells exactly', () => {
    const r = writeC2C(golden, { hand: 'right', corner: 'BL', cues: false });
    expect(r.lines.map(compact)).toEqual([
      '↖ Row 1 (RS) [first tile]: 1 A (1 tile)',
      '↘ Row 2 (WS) [inc beg · inc end]: 2 A (2 tiles)',
      '↖ Row 3 (RS) [inc beg · inc end]: 3 B (3 tiles)',
      '↘ Row 4 (WS) [dec beg · inc end]: 1 A, 1 B, 1 A (3 tiles)',
      '↖ Row 5 (RS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)',
      '↘ Row 6 (WS) [dec beg · dec end]: 2 A (2 tiles)',
      '↖ Row 7 (RS) [dec beg · dec end]: 1 A (1 tile)',
    ]);
    expect(r.rows.map((row) => row.cells)).toEqual([
      [[0, 0]],
      [
        [1, 0],
        [0, 1],
      ],
      [
        [0, 2],
        [1, 1],
        [2, 0],
      ],
      [
        [2, 1],
        [1, 2],
        [0, 3],
      ],
      [
        [0, 4],
        [1, 3],
        [2, 2],
      ],
      [
        [2, 3],
        [1, 4],
      ],
      [[2, 4]],
    ]);
  });

  it('G10: LH start bottom-left is the mirror image of RH bottom-right (row 2 visits (0,1), (1,0) ↖)', () => {
    const rh = writeC2C(golden, { hand: 'right', corner: 'BR' });
    const lh = writeC2C(golden, { hand: 'left', cues: false });
    expect(lh.corner).toBe('BL');
    expect(lh.rows[1].cells).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(lh.rows[1].arrow).toBe('↖');
    for (let n = 0; n < rh.rows.length; n++) {
      expect(lh.rows[n].cells).toEqual(rh.rows[n].cells.map(([r, c]) => [r, 4 - c]));
      expect([lh.rows[n].start, lh.rows[n].end]).toEqual([rh.rows[n].start, rh.rows[n].end]);
    }
    expect(lh.lines.map((l) => `${l.arrow} ${l.side}`)).toEqual(['↘ RS', '↖ WS', '↘ RS', '↖ WS', '↘ RS', '↖ WS', '↘ RS']);
  });

  it('G10 100 × 60: 159 rows; rows 61–100 hold 60 tiles; row 101 has 59', () => {
    const rows = c2cRows(100, 60, 'right', 'BR');
    expect(rows).toHaveLength(159);
    for (let n = 61; n <= 100; n++) expect(rows[n - 1].cells).toHaveLength(60);
    expect(rows[100].cells).toHaveLength(59);
    expect(rows[59].cells).toHaveLength(60);
    expect(c2cTiles(101, 100, 60)).toBe(59);
  });

  it('every corner × hand × size: each cell once, tiles(n), phases, start/end tags, and the validator is silent', () => {
    const rng = mulberry32(7);
    for (const [W, H] of SIZES) {
      const grid = randomChart(rng, W, H, 3);
      for (const hand of ['right', 'left'] as Hand[]) {
        for (const corner of CORNERS) {
          const r = writeC2C(grid, { hand, corner });
          expect(r.rows).toHaveLength(W + H - 1);
          const seen = new Set<number>();
          for (const row of r.rows) {
            expect(row.cells).toHaveLength(c2cTiles(row.n, W, H));
            for (const [rr, cc] of row.cells) seen.add(rr * W + cc);
          }
          expect(seen.size).toBe(W * H);
          // The first tile sits in the start corner.
          expect(r.rows[0].cells[0]).toEqual([corner[0] === 'B' ? 0 : H - 1, corner[1] === 'L' ? 0 : W - 1]);
          // Consecutive tiles of a row are diagonal neighbours, along the row's arrow.
          for (const row of r.rows) {
            for (let j = 1; j < row.cells.length; j++) {
              const dr = row.cells[j][0] - row.cells[j - 1][0];
              const dc = row.cells[j][1] - row.cells[j - 1][1];
              expect(Math.abs(dr)).toBe(1);
              expect(Math.abs(dc)).toBe(1);
              const arrow = dr > 0 ? (dc > 0 ? '↗' : '↖') : dc > 0 ? '↘' : '↙';
              expect(arrow).toBe(row.arrow);
            }
          }
          expect(validateC2C(grid, r.lines, { hand, corner })).toEqual([]);
          expect(validate2D({ chart: grid, technique: 'c2c', hand, lines: r.lines, startCorner: corner }).filter((x) => x.severity === 'error')).toEqual([]);
          // Without the setting, the corner is read from Row 1's arrow.
          expect(cornerFromArrow(hand, r.lines[0].arrow)).toBe(corner);
          expect(validate2D({ chart: grid, technique: 'c2c', hand, lines: r.lines }).filter((x) => x.severity === 'error')).toEqual([]);
        }
      }
    }
  });

  it('the arrows of each corner and hand equal the Notes table (C2C_ARROWS); every hand has 4 different odd arrows', () => {
    for (const hand of ['right', 'left'] as Hand[]) {
      for (const corner of CORNERS) expect(c2cArrows(hand, corner)).toEqual([...C2C_ARROWS[hand][corner]]);
      expect(new Set(CORNERS.map((c) => c2cArrows(hand, c)[0])).size).toBe(4);
    }
  });

  it('the frame maps are inverse to each other and put the start corner bottom-right', () => {
    for (const hand of ['right', 'left'] as Hand[]) {
      for (const corner of CORNERS) {
        const f = c2cFrame(5, 3, hand, corner);
        for (let r = 0; r < 3; r++) for (let c = 0; c < 5; c++) expect(f.fromFrame(...f.toFrame(r, c))).toEqual([r, c]);
        const at: Record<Corner, [number, number]> = { BL: [0, 0], BR: [0, 4], TL: [2, 0], TR: [2, 4] };
        expect(f.toFrame(...at[corner])).toEqual([0, f.W - 1]);
      }
    }
  });

  it('C2C notes name the actual start corner and arrows (built pattern, every corner × hand)', () => {
    const gauge = resolveGauge({ cyc: 4, technique: 'c2c' });
    for (const hand of ['right', 'left'] as Hand[]) {
      for (const corner of CORNERS) {
        const { doc } = buildPattern2DWith({ chart: golden, settings: settingsOf({ technique: 'c2c', hand, startCorner: corner }), gauge, terms: 'us', dialect: 'compact', title: 'C2C' });
        const words = { BR: 'bottom-right', BL: 'bottom-left', TR: 'top-right', TL: 'top-left' }[corner];
        const [odd, even] = c2cArrows(hand, corner);
        expect(doc.notes).toContain(`Start at the ${words} corner.`);
        expect(doc.notes).toContain(`Odd rows (RS) run ${odd}, even rows (WS) run ${even}; turn at the end of every row.`);
        expect(doc.pieces[0].lines[0].arrow).toBe(odd);
        expect(doc.issues.filter((x) => x.severity === 'error')).toEqual([]);
      }
    }
    expect(notesFor('c2c', { terms: 'us', hand: 'right', corner: 'TL' })[1]).toBe('Start at the top-left corner.');
  });

  it('bobbins are 6-connected regions on the TRANSFORMED chart: (r ± 1, c ± 1) joins, (r ± 1, c ∓ 1) does not', () => {
    // Two B tiles on a ↗ diagonal (bottom-left to top-right) of the chart.
    const diag = chartOf(['AB', 'BA']);
    // RH from BR: the frame is the chart; (0,0) and (1,1) are B — the (r+1, c+1) diagonal: one region.
    const br = c2cRegions(diag, 'right', 'BR');
    const bLabel = 1;
    expect(br.regionsPerColor[bLabel]).toBe(1);
    // RH from BL the chart is turned a quarter: the same two B tiles become (r+1, c−1) neighbours: two regions.
    const bl = c2cRegions(diag, 'right', 'BL');
    expect(bl.regionsPerColor[bLabel]).toBe(2);
    // LH from BL is the mirror image of RH from BR: there the chart's ↖ diagonal joins, so these two stay apart;
    // LH from BR (the mirror of RH from BL) joins them.
    expect(c2cRegions(diag, 'left', 'BL').regionsPerColor[bLabel]).toBe(2);
    expect(c2cRegions(diag, 'left', 'BR').regionsPerColor[bLabel]).toBe(1);
    expect(c2cRegions(chartOf(['BA', 'AB']), 'left', 'BL').regionsPerColor[bLabel]).toBe(1);
    // Orthogonal neighbours always join.
    expect(c2cRegions(chartOf(['BB', 'AA']), 'right', 'BL').regionsPerColor[bLabel]).toBe(1);
  });

  it('region cues: join B (bobbin n) where a new region starts; the first region is the start; bobbin n ≤ bobbins to wind', () => {
    const grid = chartOf(['ABABA', 'AAAAA', 'ABABA']);
    const r = writeC2C(grid, { hand: 'right' });
    const joins = r.lines.flatMap((l) => (l.cues ?? []).map((c) => c.text));
    expect(joins.filter((t) => t.startsWith('join B'))).toHaveLength(r.regions.regionsPerColor[1]);
    for (const text of joins) {
      const m = /^join (\S+) \(bobbin (\d+)\)$/.exec(text)!;
      expect(Number(m[2])).toBeLessThanOrEqual(r.regions.bobbinsPerColor[m[1] === 'A' ? 0 : 1]);
    }
    expect(r.regions.regions.reduce((a, x) => a + x.tiles, 0)).toBe(15);
    // Every tile of a region has the region's color.
    r.rows.forEach((row) => row.cells.forEach(([rr, cc]) => expect(r.regions.regions[r.regions.regionOf[(2 - rr) * 5 + cc]].label).toBe(c2cLabel(grid, rr, cc))));
  });

  it('the one-time phase note sits on row min(W, H) + 1', () => {
    const r = writeC2C(golden, { hand: 'right', cues: false });
    expect(r.lines.filter((l) => l.notes !== undefined).map((l) => l.n)).toEqual([4]);
    expect(writeC2C(chartOf(['AA', 'AA']), { hand: 'right' }).lines[2].notes?.[0]).toMatch(/decreases at both ends/);
  });
});

describe('E_C2C_TILES fires on crafted bad input', () => {
  const fresh = (): Line[] => structuredClone(writeC2C(golden, { hand: 'right', cues: false }).lines);
  const run = (lines: Line[], grid: ChartGrid = golden): string[] => validateC2C(grid, lines, { hand: 'right', corner: 'BR' }).map((x) => x.message);

  it('a missing row: rows ≠ W + H − 1 and Σ tiles ≠ W·H', () => {
    const lines = fresh();
    lines.splice(3, 1);
    const msgs = run(lines);
    expect(msgs).toContain('a 5 × 3 C2C chart has 7 diagonal rows, not 6');
    expect(msgs.some((m) => m.includes('W·H = 15'))).toBe(true);
  });

  it('a row with the wrong tile count, a wrong tag, swapped colors, a wrong arrow', () => {
    const lines = fresh();
    lines[2].ops.push({ k: 'tile', color: 'A' });
    expect(run(lines).some((m) => m.startsWith('Row 3: tiles(3) = 3'))).toBe(true);
    const tag = fresh();
    tag[3].start = { k: 'c2c', start: 'inc', end: 'inc' };
    expect(run(tag)).toContain('Row 4: from the bottom-right corner this row is [inc beg · dec end], not [inc beg · inc end]');
    expect(run(tag).some((m) => m.startsWith('the phases are'))).toBe(true);
    const colors = fresh();
    colors[2].ops = [{ k: 'tile', color: 'B' }, { k: 'tile', color: 'B' }, { k: 'tile', color: 'A' }];
    expect(run(colors)).toEqual(['Row 3: its tiles are not chart diagonal 3 read ↙ (A B B expected)']);
    const arrow = fresh();
    arrow[1].arrow = '↖';
    expect(run(arrow)).toEqual(['Row 2: from the bottom-right corner (right-handed) this is a WS row running ↗, not WS ↖']);
  });

  it('a pattern written from another corner is caught when validated for the set corner', () => {
    const bl = writeC2C(golden, { hand: 'right', corner: 'BL' }).lines;
    expect(validate2D({ chart: golden, technique: 'c2c', hand: 'right', lines: bl, startCorner: 'BR' }).map((x) => x.code)).toContain('E_C2C_TILES');
  });
});
