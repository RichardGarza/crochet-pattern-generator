import { describe, expect, it } from 'vitest';
import type { ChartResult } from '../../../types/chart';
import type { Cell } from '../../../types/gauge';
import { mulberry32, randomRange } from '../../kernel/prng';
import {
  ASPECT_ERR_OFFER,
  GRID_MAX_CELLS,
  GRID_WARN_CELLS,
  borderRounds,
  grid,
  gridIssues,
  gridSize,
  snap,
  type GridRequest,
  type Mult,
} from '../grid';
import { resolveGauge } from '../resolve';

// Worsted sc, 13.5 sts × 16 rows per 4 in (§2.2.1 Table A), typed here rather than read from the tables.
const WORSTED: Cell = { w: 4 / 13.5, h: 4 / 16 };
const IMG = { imgW: 1200, imgH: 1500 };
const EVEN: Mult = { m: 2, plus: 0 };
const SIXES: Mult = { m: 6, plus: 0 };
const MOSAIC: Mult = { m: 12, plus: 3 };

describe('G2 — grid sizing, worsted 40 × 50 in (§2.3.3, §2.13)', () => {
  it('40 × 50 in, image 1200 × 1500 ⇒ 135 cols × 200 rows', () => {
    const size = grid(WORSTED, { wIn: 40, hIn: 50, ...IMG });
    expect(size.cols).toBe(135);
    expect(size.rows).toBe(200);
    expect(size.borderRounds).toBe(0);
    expect(size.actualW).toBeCloseTo(40, 12);
    expect(size.actualH).toBe(50);
    expect(size.aspectErr).toBeCloseTo(0, 12);
    expect(Object.keys(size).sort()).toEqual(['actualH', 'actualW', 'aspectErr', 'borderRounds', 'cols', 'rows']);
  });

  it('the same chart from the width alone or the height alone (the image aspect gives the other side)', () => {
    expect(grid(WORSTED, { wIn: 40, ...IMG })).toMatchObject({ cols: 135, rows: 200 });
    expect(grid(WORSTED, { hIn: 50, ...IMG })).toMatchObject({ cols: 135, rows: 200 });
  });

  it('a square-cell tool would give 135 × 169, 15.5% short (research 01 §4.2)', () => {
    const size = grid(WORSTED, { wIn: 40, ...IMG });
    const squareRows = Math.round(size.cols * (IMG.imgH / IMG.imgW));
    expect(squareRows).toBe(169);
    expect(size.rows).not.toBe(squareRows);
    expect(1 - (squareRows * WORSTED.h) / 50).toBeCloseTo(0.155, 3);
  });

  it('with a 1 in border (roundH 0.25) ⇒ 4 border rounds, 128 × 192 chart, finished 39.9 × 50.0 in', () => {
    const size = grid(WORSTED, { wIn: 40, hIn: 50, ...IMG, border: { widthIn: 1, roundH: 0.25 } });
    expect(size.borderRounds).toBe(4);
    expect(size.cols).toBe(128);
    expect(size.rows).toBe(192);
    expect(size.actualW.toFixed(1)).toBe('39.9');
    expect(size.actualH.toFixed(1)).toBe('50.0');
    // 128 · 0.296296 + 2 · 1 = 39.9259; 192 · 0.25 + 2 = 50
    expect(size.actualW).toBeCloseTo(39.925926, 6);
    expect(size.actualH).toBe(50);
    // (48 / 37.9259) / 1.25 − 1 = 0.0125
    expect(size.aspectErr).toBeCloseTo(0.0125, 10);
  });

  it('the same goldens through resolveGauge: the cell and hSc of worsted sc graphgan', () => {
    const g = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    expect(grid(g.cell, { wIn: 40, hIn: 50, ...IMG })).toMatchObject({ cols: 135, rows: 200, borderRounds: 0 });
    const bordered = grid(g.cell, { wIn: 40, hIn: 50, ...IMG, border: { widthIn: 1, roundH: g.hSc } });
    expect(bordered).toMatchObject({ cols: 128, rows: 192, borderRounds: 4 });
    expect(bordered.actualW.toFixed(1)).toBe('39.9');
    expect(bordered.actualH.toFixed(1)).toBe('50.0');
  });

  it('returns exactly the shape of ChartResult.size', () => {
    const size: ChartResult['size'] = grid(WORSTED, { wIn: 40, ...IMG });
    expect(size.cols).toBe(135);
  });
});

describe('grid — independent axes (D2, §2.3.3)', () => {
  it('sizes columns from the stitch width and rows from the row height: never rows = cols · aspect', () => {
    // worsted tapestry: w = 0.2963, h = 0.2963 / 0.88 = 0.3367 — taller than wide
    const tapestry: Cell = { w: 4 / 13.5, h: 4 / 13.5 / 0.88 };
    const size = grid(tapestry, { wIn: 20, hIn: 20, imgW: 500, imgH: 500 });
    expect(size.cols).toBe(68); // 20 · 13.5 / 4 = 67.5, ties up
    expect(size.rows).toBe(59); // 20 / 0.3367 = 59.4
    expect(size.cols).not.toBe(size.rows);
    // and sc the other way round: 68 × 80
    expect(grid(WORSTED, { wIn: 20, hIn: 20, imgW: 500, imgH: 500 })).toMatchObject({ cols: 68, rows: 80 });
  });

  it('C2C: the cell is the square tile, so a square image gives a square chart', () => {
    const tile = 2.6 * (4 / 13.5); // 0.7704 in
    const size = grid({ w: tile, h: tile }, { wIn: 40, hIn: 50, ...IMG });
    expect(size.cols).toBe(52); // 40 / 0.7704 = 51.9
    expect(size.rows).toBe(65); // 50 / 0.7704 = 64.9
    expect(grid({ w: tile, h: tile }, { wIn: 40, imgW: 800, imgH: 800 })).toMatchObject({ cols: 52, rows: 52 });
  });

  it('tapestry in the round: wIn is the circumference, hIn the height, no border', () => {
    const g = resolveGauge({ cyc: 4, technique: 'sc_tapestry_round' });
    const size = grid(g.cell, { wIn: 22, hIn: 8, imgW: 880, imgH: 320 });
    expect(size.cols).toBe(74); // 22 · 13.5 / 4 = 74.25
    expect(size.rows).toBe(24); // 8 / 0.3367 = 23.76
    expect(size.borderRounds).toBe(0);
  });

  it('reports the actual finished size: exactly cols × w and rows × h', () => {
    const rng = mulberry32(20261001);
    for (let i = 0; i < 300; i++) {
      const c: Cell = { w: randomRange(rng, 0.1, 1.1), h: randomRange(rng, 0.09, 1.2) };
      const req: GridRequest = { wIn: randomRange(rng, 1, 90), hIn: randomRange(rng, 1, 90), imgW: 640, imgH: 480 };
      const size = grid(c, req);
      expect(size.actualW).toBe(size.cols * c.w);
      expect(size.actualH).toBe(size.rows * c.h);
      // each axis is within half a cell of what was asked
      expect(Math.abs(size.actualW - (req.wIn as number))).toBeLessThanOrEqual(c.w / 2 + 1e-9);
      expect(Math.abs(size.actualH - (req.hIn as number))).toBeLessThanOrEqual(c.h / 2 + 1e-9);
      expect(Number.isInteger(size.cols) && size.cols >= 1).toBe(true);
      expect(Number.isInteger(size.rows) && size.rows >= 1).toBe(true);
    }
  });

  it('with a border the actual size is cols × w + 2B and rows × h + 2B, B = rounds × roundH', () => {
    const rng = mulberry32(7);
    for (let i = 0; i < 200; i++) {
      const c: Cell = { w: randomRange(rng, 0.1, 1.1), h: randomRange(rng, 0.09, 1.2) };
      const roundH = randomRange(rng, 0.09, 1);
      const widthIn = randomRange(rng, 0.05, 3);
      const size = grid(c, { wIn: randomRange(rng, 20, 90), imgW: 640, imgH: 480, border: { widthIn, roundH } });
      const n = Math.max(1, Math.round(widthIn / roundH));
      expect(size.borderRounds).toBe(n);
      expect(size.actualW).toBe(size.cols * c.w + 2 * (n * roundH));
      expect(size.actualH).toBe(size.rows * c.h + 2 * (n * roundH));
    }
  });
});

describe('grid — aspect error (§2.3.3)', () => {
  it('aspectErr = (rows·h / cols·w) / (imgH / imgW) − 1, border excluded', () => {
    // 3 in wide, square image: 10 cols (10.125) × 12 rows; 3.0 / 2.963 − 1 = 0.0125
    const size = grid(WORSTED, { wIn: 3, imgW: 100, imgH: 100 });
    expect(size).toMatchObject({ cols: 10, rows: 12 });
    expect(size.aspectErr).toBeCloseTo(0.0125, 10);
    expect(gridIssues(WORSTED, { wIn: 3, imgW: 100, imgH: 100 })).toEqual([]);
    // a positive error means the chart is taller for its width than the picture
    const tall = grid(WORSTED, { wIn: 40, hIn: 60, ...IMG });
    expect(tall.aspectErr).toBeCloseTo(60 / 40 / 1.25 - 1, 10);
    const wide = grid(WORSTED, { wIn: 50, hIn: 50, ...IMG });
    expect(wide.aspectErr).toBeLessThan(0);
  });

  it('|aspectErr| > 0.025 ⇒ W_GRID_ASPECT, which offers ±1 row or column', () => {
    expect(ASPECT_ERR_OFFER).toBe(0.025);
    // 1.2 in wide: 4 cols (4.05) × 5 rows (4.8): 1.25 / 1.1852 − 1 = 0.0547
    const req = { wIn: 1.2, imgW: 100, imgH: 100 };
    const size = grid(WORSTED, req);
    expect(size).toMatchObject({ cols: 4, rows: 5 });
    expect(size.aspectErr).toBeCloseTo(0.0547, 4);
    expect(gridIssues(WORSTED, req)).toEqual([
      { code: 'W_GRID_ASPECT', severity: 'warn', message: 'The chart is 5.5% taller for its width than the picture; one row fewer or one column more may fit better.' },
    ]);
    // one row fewer: 4 × 4 ⇒ 1.0 / 1.1852 − 1 = −0.156 — the offer is the user's to judge
    expect(gridSize(WORSTED, 4, 4, req).aspectErr).toBeCloseTo(-0.15625, 10);
    expect(gridSize(WORSTED, 4, 5, req)).toEqual(size);
  });

  it('both sizes given and a crop that does not match ⇒ a large aspect error (the UI offers crop to fit or pad)', () => {
    const req = { wIn: 40, hIn: 50, imgW: 1000, imgH: 1000 };
    const size = grid(WORSTED, req);
    expect(size).toMatchObject({ cols: 135, rows: 200 });
    expect(size.aspectErr).toBeCloseTo(0.25, 10);
    const issues = gridIssues(WORSTED, req);
    expect(issues.map((i) => i.code)).toEqual(['W_GRID_ASPECT']);
    expect(issues[0].message).toContain('25% taller');
    const wide = gridIssues(WORSTED, { wIn: 50, hIn: 40, imgW: 1000, imgH: 1000 });
    // 169 cols (168.75) × 160 rows: 40 / 50.074 − 1 = −0.2012
    expect(wide[0].message).toBe('The chart is 20.1% wider for its height than the picture; one row more or one column fewer may fit better.');
  });

  it('is the rounding of the two axes: a chart of 50 or more cells a side never needs the offer', () => {
    const rng = mulberry32(99);
    let checked = 0;
    for (let i = 0; i < 600; i++) {
      const c: Cell = { w: randomRange(rng, 0.1, 1.1), h: randomRange(rng, 0.09, 1.2) };
      const imgW = 200 + Math.floor(rng() * 2000);
      const imgH = 200 + Math.floor(rng() * 2000);
      const size = grid(c, { wIn: randomRange(rng, 30, 80), imgW, imgH });
      expect(size.aspectErr).toBeCloseTo(size.actualH / size.actualW / (imgH / imgW) - 1, 12);
      if (size.cols < 50 || size.rows < 50 || size.cols >= 1000 || size.rows >= 1000) continue;
      // each side is off by at most half a cell: (1/100 + 1/100) / (1 − 1/100) < 0.025
      expect(Math.abs(size.aspectErr)).toBeLessThanOrEqual(ASPECT_ERR_OFFER);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });
});

describe('snap — nearest count, ties up, snapping constraints (§2.3.3, research 01 §4.3)', () => {
  it('without a constraint: Math.round, at least 1', () => {
    expect(snap(134.6)).toBe(135);
    expect(snap(134.4)).toBe(134);
    expect(snap(2.5)).toBe(3);
    expect(snap(0.2)).toBe(1);
    expect(snap(0)).toBe(1);
    expect(snap(-5)).toBe(1);
  });

  it('decides ties as exact arithmetic would', () => {
    // 35 in of super bulky hdc: 35 / (1.05 · 4 / 7.5) is 62.5 on paper and 62.49999999999999 in binary
    const x = 35 / (1.05 * (4 / 7.5));
    expect(x).toBeLessThan(62.5);
    expect(Math.round(x)).toBe(62);
    expect(snap(x)).toBe(63);
    // 39 in of lace C2C: 127.5 tiles on paper
    expect(snap(39 / (2.6 * (4 / 34)))).toBe(128);
    // genuinely below a tie stays below
    expect(snap(62.4999)).toBe(62);
  });

  it('repeat multiples: mosaic "multiple of 12 + 3"', () => {
    expect(snap(130, MOSAIC)).toBe(135); // (130 − 3) / 12 = 10.58 → 11
    expect(snap(128, MOSAIC)).toBe(123); // 10.42 → 10
    expect(snap(129, MOSAIC)).toBe(135); // 10.5, ties up
    expect(snap(0, MOSAIC)).toBe(3);
    expect(snap(-40, MOSAIC)).toBe(3);
    expect(snap(8.9, MOSAIC)).toBe(3);
    expect(snap(9, MOSAIC)).toBe(15);
    for (let x = 0; x < 400; x += 0.37) expect((snap(x, MOSAIC) - 3) % 12).toBe(0);
  });

  it('even rows (overlay mosaic colour pairs)', () => {
    expect(snap(199.3, EVEN)).toBe(200);
    expect(snap(200.9, EVEN)).toBe(200);
    expect(snap(201, EVEN)).toBe(202); // 100.5 pairs, ties up
    expect(snap(0.4, EVEN)).toBe(2); // never 0 rows
    for (let x = 0; x < 300; x += 0.61) expect(snap(x, EVEN) % 2).toBe(0);
  });

  it('multiples of 6', () => {
    expect(snap(33, SIXES)).toBe(36); // 5.5, ties up
    expect(snap(32.9, SIXES)).toBe(30);
    expect(snap(2, SIXES)).toBe(6); // never 0
    expect(snap(0, SIXES)).toBe(6);
    for (let x = 0; x < 300; x += 0.53) {
      const n = snap(x, SIXES);
      expect(n % 6).toBe(0);
      expect(n).toBeGreaterThanOrEqual(6);
      expect(Math.abs(n - x)).toBeLessThanOrEqual(Math.max(3, 6 - x) + 1e-9);
    }
  });

  it('rejects a broken constraint or a count that is not a number', () => {
    for (const bad of [{ m: 0, plus: 0 }, { m: -2, plus: 0 }, { m: 1.5, plus: 0 }, { m: 2, plus: -1 }, { m: 2, plus: 0.5 }, { m: Number.NaN, plus: 0 }]) {
      expect(() => snap(10, bad)).toThrow(RangeError);
      expect(() => grid(WORSTED, { wIn: 40, ...IMG, colsMult: bad })).toThrow(RangeError);
      expect(() => grid(WORSTED, { wIn: 40, ...IMG, rowsMult: bad })).toThrow(RangeError);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(() => snap(bad)).toThrow(RangeError);
  });

  it('grid applies the constraints to each axis on its own', () => {
    const size = grid(WORSTED, { wIn: 40, hIn: 50, ...IMG, colsMult: MOSAIC, rowsMult: EVEN });
    expect(size.cols).toBe(135); // 135 = 12 · 11 + 3
    expect(size.rows).toBe(200);
    const other = grid(WORSTED, { wIn: 38, hIn: 50.2, ...IMG, colsMult: MOSAIC, rowsMult: EVEN });
    expect(other.cols).toBe(123); // 128.25 → 12 · 10 + 3
    expect(other.rows).toBe(200); // 200.8 → 200
    expect(other.actualW).toBe(123 * WORSTED.w);
    // half a repeat is about 1.8 in in worsted (research 01 §10.5): the actual size says so
    expect(Math.abs(other.actualW - 38)).toBeLessThanOrEqual((12 * WORSTED.w) / 2);
    const rng = mulberry32(3);
    for (let i = 0; i < 200; i++) {
      const s = grid(WORSTED, { wIn: randomRange(rng, 0, 120), ...IMG, colsMult: SIXES, rowsMult: EVEN });
      expect(s.cols % 6).toBe(0);
      expect(s.rows % 2).toBe(0);
      expect(s.cols).toBeGreaterThanOrEqual(6);
      expect(s.rows).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('border rounds (§2.7.10)', () => {
  it('n = max(1, round(widthIn / hSc)); 0 when the width is 0', () => {
    expect(borderRounds(1, 0.25)).toBe(4); // G2, G16
    expect(borderRounds(0.25, 0.25)).toBe(1); // G22
    expect(borderRounds(0.1, 0.25)).toBe(1); // any border at all is at least one round
    expect(borderRounds(0.625, 0.25)).toBe(3); // 2.5, ties up
    expect(borderRounds(0.6, 0.25)).toBe(2);
    expect(borderRounds(0, 0.25)).toBe(0);
    expect(borderRounds(-1, 0.25)).toBe(0);
    // DK, hSc = 4 / 19: a 2 in border is 9.5 rounds on paper
    expect(borderRounds(2, 4 / 19)).toBe(10);
  });

  it('no border means no round height is needed', () => {
    expect(borderRounds(0, 0)).toBe(0);
    expect(borderRounds(0, Number.NaN)).toBe(0);
    expect(grid(WORSTED, { wIn: 40, ...IMG, border: { widthIn: 0, roundH: 0 } })).toEqual(grid(WORSTED, { wIn: 40, ...IMG }));
  });

  it('rejects a border without a positive round height, or a width that is not a number', () => {
    for (const bad of [0, -0.25, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => borderRounds(1, bad)).toThrow(RangeError);
      expect(() => grid(WORSTED, { wIn: 40, ...IMG, border: { widthIn: 1, roundH: bad } })).toThrow(RangeError);
    }
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) expect(() => borderRounds(bad, 0.25)).toThrow(RangeError);
    expect(() => borderRounds(1e300, 1e-300)).toThrow(RangeError);
  });

  it('the grid is sized inside the ACTUAL border, and the finished size includes it', () => {
    // 0.9 in asked, 4 rounds of 0.25 worked: B = 1.0, not 0.9
    const size = grid(WORSTED, { wIn: 40, hIn: 50, ...IMG, border: { widthIn: 0.9, roundH: 0.25 } });
    expect(size.borderRounds).toBe(4);
    expect(size.cols).toBe(128);
    expect(size.rows).toBe(192);
    expect(size.actualH).toBe(50);
    // a wider border leaves a smaller chart
    const wider = grid(WORSTED, { wIn: 40, hIn: 50, ...IMG, border: { widthIn: 2, roundH: 0.25 } });
    expect(wider).toMatchObject({ borderRounds: 8, cols: 122, rows: 184 }); // 36 in → 121.5 ties up; 46 in
    expect(wider.actualH).toBe(50);
  });

  it('G16: a 135 × 200 chart with a 1 in border finishes at 42.0 × 52.0 in', () => {
    const size = gridSize(WORSTED, 135, 200, { ...IMG, border: { widthIn: 1, roundH: 0.25 } });
    expect(size.borderRounds).toBe(4);
    expect(size.actualW.toFixed(1)).toBe('42.0');
    expect(size.actualH.toFixed(1)).toBe('52.0');
    expect(size.aspectErr).toBeCloseTo(0, 12);
  });
});

describe('gridSize — the finished size of known counts', () => {
  it('agrees with grid for the counts grid returns', () => {
    const rng = mulberry32(11);
    for (let i = 0; i < 100; i++) {
      const c: Cell = { w: randomRange(rng, 0.1, 1.1), h: randomRange(rng, 0.09, 1.2) };
      const border = rng() < 0.5 ? { widthIn: randomRange(rng, 0, 2), roundH: randomRange(rng, 0.1, 0.6) } : undefined;
      const req: GridRequest = { wIn: randomRange(rng, 10, 80), imgW: 300, imgH: 400, border };
      const size = grid(c, req);
      expect(gridSize(c, size.cols, size.rows, { imgW: 300, imgH: 400, border })).toEqual(size);
    }
  });

  it('rejects counts that are not integers ≥ 1 and a missing image or cell', () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => gridSize(WORSTED, bad, 10, IMG)).toThrow(RangeError);
      expect(() => gridSize(WORSTED, 10, bad, IMG)).toThrow(RangeError);
    }
    expect(() => gridSize(WORSTED, 10, 10, { imgW: 0, imgH: 10 })).toThrow(RangeError);
    expect(() => gridSize({ w: 0, h: 1 }, 10, 10, IMG)).toThrow(RangeError);
  });
});

describe('grid — degenerate input (§2.3.3 limits)', () => {
  it('a size of 0, or smaller than one stitch, gives the smallest chart and says so', () => {
    const zero = grid(WORSTED, { wIn: 0, ...IMG });
    expect(zero).toMatchObject({ cols: 1, rows: 1, borderRounds: 0 });
    expect(zero.actualW).toBe(WORSTED.w);
    expect(zero.actualH).toBe(WORSTED.h);
    expect(gridIssues(WORSTED, { wIn: 0, ...IMG })).toEqual([
      { code: 'W_GRID_NO_ROOM', severity: 'warn', message: 'The size leaves no room for a stitch; the smallest chart, 1 × 1, is used and the piece comes out 0.3 × 0.3 in.' },
    ]);
    expect(grid(WORSTED, { wIn: -10, hIn: -10, ...IMG })).toMatchObject({ cols: 1, rows: 1 });
    expect(grid(WORSTED, { hIn: 0, ...IMG })).toMatchObject({ cols: 1, rows: 1 });
    // tiny but positive: the nearest count, at least 1
    expect(grid(WORSTED, { wIn: 0.1, hIn: 0.1, ...IMG })).toMatchObject({ cols: 1, rows: 1 });
    expect(gridIssues(WORSTED, { wIn: 0.1, hIn: 0.1, ...IMG }).map((i) => i.code)).not.toContain('W_GRID_NO_ROOM');
    // with constraints the smallest chart is the smallest count they allow
    expect(grid(WORSTED, { wIn: 0, ...IMG, colsMult: MOSAIC, rowsMult: EVEN })).toMatchObject({ cols: 3, rows: 2 });
    expect(grid(WORSTED, { wIn: 0, ...IMG, colsMult: SIXES, rowsMult: SIXES })).toMatchObject({ cols: 6, rows: 6 });
  });

  it('a border as wide as the piece leaves no room: smallest chart, W_GRID_NO_ROOM', () => {
    const req = { wIn: 2, hIn: 2, imgW: 100, imgH: 100, border: { widthIn: 1, roundH: 0.25 } };
    const size = grid(WORSTED, req);
    expect(size).toMatchObject({ cols: 1, rows: 1, borderRounds: 4 });
    expect(size.actualW).toBeCloseTo(2.2963, 4);
    expect(size.actualH).toBe(2.25);
    const issues = gridIssues(WORSTED, req);
    expect(issues.map((i) => i.code)).toEqual(['W_GRID_NO_ROOM']);
    expect(issues[0].message).toBe(
      'A border of 4 rounds (1 in on each side) leaves no room for the chart at this size; the smallest chart, 1 × 1, is used and the piece comes out 2.3 × 2.3 in.',
    );
  });

  it('warns above 300 cells on a side', () => {
    expect(GRID_WARN_CELLS).toBe(300);
    // worsted rows are 0.25 in: 75 in = 300 rows, 75.25 in = 301 rows
    expect(grid(WORSTED, { wIn: 10, hIn: 75, imgW: 100, imgH: 750 }).rows).toBe(300);
    expect(gridIssues(WORSTED, { wIn: 10, hIn: 75, imgW: 100, imgH: 750 })).toEqual([]);
    const issues = gridIssues(WORSTED, { wIn: 10, hIn: 75.25, imgW: 100, imgH: 750 });
    expect(issues).toEqual([
      { code: 'W_GRID_LARGE', severity: 'warn', message: 'The chart is 34 × 301 cells; above 300 cells on a side it is slow to draw and a very long project.' },
    ]);
    expect(gridIssues(WORSTED, { wIn: 89.2, hIn: 20, imgW: 892, imgH: 200 }).map((i) => i.code)).toEqual(['W_GRID_LARGE']); // 301 cols
  });

  it('hard cap 1000: an exact fit is kept, anything larger is scaled down in proportion', () => {
    expect(GRID_MAX_CELLS).toBe(1000);
    // 250 in tall = 1000 rows: allowed (and large)
    const fit = { wIn: 100, hIn: 250, imgW: 400, imgH: 1000 };
    expect(grid(WORSTED, fit)).toMatchObject({ cols: 338, rows: 1000 }); // 337.5 ties up
    expect(gridIssues(WORSTED, fit).map((i) => i.code)).toEqual(['W_GRID_LARGE']);

    // 400 in wide at 4:5 needs 1350 × 2000 cells ⇒ the largest 4:5 chart that fits
    const huge = { wIn: 400, ...IMG };
    const size = grid(WORSTED, huge);
    expect(size.cols).toBe(675);
    expect(size.rows).toBe(1000);
    expect(size.actualW).toBeCloseTo(200, 9);
    expect(size.actualH).toBe(250);
    expect(Math.abs(size.aspectErr)).toBeLessThan(0.001);
    const issues = gridIssues(WORSTED, huge);
    expect(issues.map((i) => i.code)).toEqual(['W_GRID_CAPPED', 'W_GRID_LARGE']);
    expect(issues[0].message).toBe(
      'This size needs 1350 × 2000 cells; a chart is limited to 1000 cells on a side, so it was scaled down to 675 × 1000 and the piece comes out 200 × 250 in.',
    );

    // any larger request gives the same chart
    for (const wIn of [201, 1000, 1e6, 1e12, 1e100]) {
      expect(grid(WORSTED, { wIn, ...IMG })).toEqual(size);
      expect(grid(WORSTED, { hIn: wIn * 1.25, ...IMG })).toEqual(size);
    }
    // the wide way round: columns bind
    const landscape = grid(WORSTED, { hIn: 400, imgW: 1500, imgH: 1200 });
    expect(landscape.cols).toBe(1000); // 1687.5 wanted
    expect(landscape.rows).toBe(949); // 1600 wanted, scaled with the columns: 1600 · 1000.5 / 1687.5 = 948.6
    expect(Math.abs(landscape.aspectErr)).toBeLessThan(0.001);
  });

  it('the cap respects the constraints', () => {
    // 12n + 3 ≤ 1000 ⇒ 999; even ≤ 1000 ⇒ 1000
    const size = grid(WORSTED, { wIn: 1e5, hIn: 1e5, imgW: 100, imgH: 100, colsMult: MOSAIC, rowsMult: EVEN });
    expect(size.cols).toBeLessThanOrEqual(999);
    expect((size.cols - 3) % 12).toBe(0);
    expect(size.rows).toBe(1000);
    const cols = grid(WORSTED, { wIn: 1e5, hIn: 10, imgW: 100, imgH: 100, colsMult: MOSAIC });
    expect(cols.cols).toBe(999);
    expect(cols.rows).toBe(1); // 40 rows scaled by the same factor
    // a constraint with no count between 1 and 1000 cannot be answered
    expect(() => grid(WORSTED, { wIn: 40, ...IMG, colsMult: { m: 2000, plus: 0 } })).toThrow(/no column count of the form 2000·n \+ 0 lies between 1 and 1000/);
    expect(() => grid(WORSTED, { wIn: 40, ...IMG, rowsMult: { m: 5, plus: 1001 } })).toThrow(RangeError);
    // one feasible count is enough
    expect(grid(WORSTED, { wIn: 40, ...IMG, colsMult: { m: 2000, plus: 5 } }).cols).toBe(5);
  });

  it('never returns more than 1000 or fewer than 1 cells on a side, whatever the finite request', () => {
    const rng = mulberry32(424242);
    const mults: (Mult | undefined)[] = [undefined, EVEN, SIXES, MOSAIC, { m: 7, plus: 2 }, { m: 250, plus: 0 }];
    for (let i = 0; i < 2000; i++) {
      const c: Cell = { w: Math.exp(randomRange(rng, -6, 3)), h: Math.exp(randomRange(rng, -6, 3)) };
      const big = Math.exp(randomRange(rng, -8, 12));
      const req: GridRequest = {
        wIn: rng() < 0.7 ? big * (rng() < 0.1 ? -1 : 1) : undefined,
        hIn: rng() < 0.7 ? Math.exp(randomRange(rng, -8, 12)) : undefined,
        imgW: 1 + Math.floor(rng() * 4000),
        imgH: 1 + Math.floor(rng() * 4000),
        border: rng() < 0.3 ? { widthIn: randomRange(rng, 0, 5), roundH: randomRange(rng, 0.05, 1) } : undefined,
        colsMult: mults[Math.floor(rng() * mults.length)],
        rowsMult: mults[Math.floor(rng() * mults.length)],
      };
      if (req.wIn === undefined && req.hIn === undefined) req.wIn = big;
      const size = grid(c, req);
      for (const n of [size.cols, size.rows]) {
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(GRID_MAX_CELLS);
      }
      for (const v of [size.actualW, size.actualH, size.aspectErr]) expect(Number.isFinite(v)).toBe(true);
      if (req.colsMult) expect((size.cols - req.colsMult.plus) % req.colsMult.m).toBe(0);
      if (req.rowsMult) expect((size.rows - req.rowsMult.plus) % req.rowsMult.m).toBe(0);
      // gridIssues never throws where grid does not
      const codes = gridIssues(c, req).map((issue) => issue.code);
      expect(new Set(codes).size).toBe(codes.length);
    }
  });

  it('rejects what it cannot answer, with a clear error', () => {
    expect(() => grid(WORSTED, { ...IMG })).toThrow('grid: give a finished width (wIn), a finished height (hIn) or both');
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => grid(WORSTED, { wIn: bad, ...IMG })).toThrow(/finished width must be a finite number/);
      expect(() => grid(WORSTED, { hIn: bad, ...IMG })).toThrow(/finished height must be a finite number/);
      expect(() => grid(WORSTED, { wIn: 40, hIn: bad, ...IMG })).toThrow(RangeError);
    }
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => grid({ w: bad, h: 0.25 }, { wIn: 40, ...IMG })).toThrow(/cell needs a positive width and height/);
      expect(() => grid({ w: 0.3, h: bad }, { wIn: 40, ...IMG })).toThrow(RangeError);
      expect(() => grid(WORSTED, { wIn: 40, imgW: bad, imgH: 100 })).toThrow(/image needs a positive width and height/);
      expect(() => grid(WORSTED, { wIn: 40, imgW: 100, imgH: bad })).toThrow(RangeError);
    }
    expect(() => grid(null as unknown as Cell, { wIn: 40, ...IMG })).toThrow(RangeError);
    expect(() => grid(WORSTED, null as unknown as GridRequest)).toThrow(RangeError);
    // a finite size that overflows the arithmetic
    expect(() => grid({ w: 1e-300, h: 1e-300 }, { wIn: 1e300, ...IMG })).toThrow('grid: the requested size is out of range for this stitch size');
    // an image aspect that overflows or vanishes, and a cell whose aspect error cannot be expressed
    expect(() => grid(WORSTED, { wIn: 40, imgW: 1e-308, imgH: 1e308 })).toThrow(/image needs a positive width and height/);
    expect(() => grid(WORSTED, { wIn: 40, imgW: 1e308, imgH: 1e-308 })).toThrow(/image needs a positive width and height/);
    expect(() => grid({ w: 1e-300, h: 1e300 }, { wIn: 1e-298, imgW: 100, imgH: 100 })).toThrow(/out of range/);
    expect(() => gridSize({ w: 1e-300, h: 1e300 }, 1, 1, { imgW: 100, imgH: 100 })).toThrow(/out of range/);
    expect(() => gridIssues(WORSTED, { ...IMG })).toThrow(RangeError);
  });

  it('treats null sizes like missing ones (settings read back from JSON)', () => {
    const req = { wIn: 40, hIn: null, ...IMG, border: null, colsMult: undefined } as unknown as GridRequest;
    expect(grid(WORSTED, req)).toEqual(grid(WORSTED, { wIn: 40, ...IMG }));
  });
});

describe('grid — monotonicity', () => {
  it('a larger finished size never gives fewer stitches or rows', () => {
    const rng = mulberry32(5150);
    const mults: (Mult | undefined)[] = [undefined, EVEN, SIXES, MOSAIC];
    for (let i = 0; i < 400; i++) {
      const c: Cell = { w: randomRange(rng, 0.1, 1.1), h: randomRange(rng, 0.09, 1.2) };
      const img = { imgW: 100 + Math.floor(rng() * 900), imgH: 100 + Math.floor(rng() * 900) };
      const colsMult = mults[Math.floor(rng() * mults.length)];
      const rowsMult = mults[Math.floor(rng() * mults.length)];
      const border = rng() < 0.3 ? { widthIn: 1, roundH: 0.25 } : undefined;
      const a = randomRange(rng, 0, 150);
      const b = a + randomRange(rng, 0, 60);
      // one size given: both axes grow together
      const s1 = grid(c, { wIn: a, ...img, colsMult, rowsMult, border });
      const s2 = grid(c, { wIn: b, ...img, colsMult, rowsMult, border });
      expect(s2.cols).toBeGreaterThanOrEqual(s1.cols);
      expect(s2.rows).toBeGreaterThanOrEqual(s1.rows);
      const t1 = grid(c, { hIn: a, ...img, colsMult, rowsMult, border });
      const t2 = grid(c, { hIn: b, ...img, colsMult, rowsMult, border });
      expect(t2.cols).toBeGreaterThanOrEqual(t1.cols);
      expect(t2.rows).toBeGreaterThanOrEqual(t1.rows);
    }
  });

  it('holds across the hard cap: a growing request climbs to the capped chart and stays there', () => {
    // worsted at 4:5 — rows reach the cap near 200.1 in wide
    let prev = grid(WORSTED, { wIn: 195, ...IMG });
    for (let wIn = 195; wIn <= 215; wIn += 0.003) {
      const s = grid(WORSTED, { wIn, ...IMG });
      expect(s.cols).toBeGreaterThanOrEqual(prev.cols);
      expect(s.rows).toBeGreaterThanOrEqual(prev.rows);
      prev = s;
    }
    expect(prev).toMatchObject({ cols: 675, rows: 1000 });
    // and with a constraint on the binding axis
    let last = grid(WORSTED, { wIn: 290, imgW: 1000, imgH: 800, colsMult: MOSAIC });
    for (let wIn = 290; wIn <= 300; wIn += 0.002) {
      const s = grid(WORSTED, { wIn, imgW: 1000, imgH: 800, colsMult: MOSAIC });
      expect(s.cols).toBeGreaterThanOrEqual(last.cols);
      expect(s.rows).toBeGreaterThanOrEqual(last.rows);
      last = s;
    }
    expect(last.cols).toBe(999);
  });

  it('with both sizes given, each axis follows its own size below the cap', () => {
    const rng = mulberry32(8086);
    for (let i = 0; i < 300; i++) {
      const c: Cell = { w: randomRange(rng, 0.2, 1.1), h: randomRange(rng, 0.2, 1.2) }; // at most 500 cells a side
      const w1 = randomRange(rng, 0, 80);
      const w2 = w1 + randomRange(rng, 0, 20);
      const h1 = randomRange(rng, 0, 80);
      const h2 = h1 + randomRange(rng, 0, 20);
      const a = grid(c, { wIn: w1, hIn: h1, ...IMG });
      const b = grid(c, { wIn: w2, hIn: h1, ...IMG });
      const d = grid(c, { wIn: w1, hIn: h2, ...IMG });
      expect(b.cols).toBeGreaterThanOrEqual(a.cols);
      expect(b.rows).toBe(a.rows); // the height did not change
      expect(d.rows).toBeGreaterThanOrEqual(a.rows);
      expect(d.cols).toBe(a.cols);
    }
  });
});
