import { describe, expect, it } from 'vitest';
import type { Cell, Technique2D, TechniqueId } from '../../../types/gauge';
import type { Cyc } from '../../../types/units';
import {
  AMI_ASPECT,
  AMI_CYCS,
  C2C_TILE_WIDTH_MULT,
  CM_PER_IN,
  CYC_RANGE,
  CYCS,
  GAUGE_SPAN_IN,
  HDC_HEIGHT_MULT,
  HDC_WIDTH_MULT,
  HOOK_EXPONENT,
  HOOK_EXPONENT_RANGE,
  HOOK_LABELS,
  HOOK_SIZES_MM,
  MOSAIC_ASPECT,
  RANGE_SLACK,
  STUFFING_STRETCH,
  SWATCH_TOL,
  TABLE_A,
  TABLE_B,
  TABLE_E,
  TAPESTRY_ASPECT,
  TAPESTRY_EXTRA_PER_STRAND,
  amiCell,
  amiHookMm,
  cmToIn,
  hookFactor,
  hookUsLabel,
  inToCm,
  scCell,
  techniqueCell,
} from '../tables';

// The numbers below are typed from the printed tables of DESIGN.md §2.2.1–2.2.3 and research 01 §8, not derived
// from the implementation. A printed value rounded to n decimals may differ from the computed one by half a unit
// of its last digit.
const HALF_3DP = 0.00051;
const HALF_2DP = 0.0051;
const HALF_1DP = 0.051;

/** §2.2.1 Table A as printed: cyc, name, hook mm, hook US, sts4, rows4, w, h, tol, yd/100 g. */
const PRINTED_TABLE_A: readonly [Cyc, string, number, string, number, number, number, number, number, number][] = [
  [0, 'Lace', 2.25, 'B-1', 34, 40, 0.118, 0.1, 0.25, 700],
  [1, 'Super Fine', 3.25, 'D-3', 24, 28, 0.167, 0.143, 0.15, 400],
  [2, 'Fine', 4.0, 'G-6', 18, 21, 0.222, 0.19, 0.2, 330],
  [3, 'Light (DK)', 4.0, 'G-6', 16, 19, 0.25, 0.211, 0.12, 280],
  [4, 'Medium (worsted)', 5.0, 'H-8', 13.5, 16, 0.296, 0.25, 0.12, 190],
  [5, 'Bulky', 6.5, 'K-10½', 10.5, 12, 0.381, 0.333, 0.15, 120],
  [6, 'Super Bulky', 8.0, 'L-11', 7.5, 8.5, 0.533, 0.471, 0.15, 70],
  [7, 'Jumbo', 15, 'P/Q', 4, 4.2, 1.0, 0.952, 0.35, 15],
];

/** §2.2.3 Table E as printed: cyc, hook mm, w, sts/in. */
const PRINTED_TABLE_E: readonly [Cyc, number, number, number][] = [
  [1, 2.25, 0.13, 7.7],
  [2, 2.5, 0.155, 6.5],
  [3, 2.75, 0.17, 5.9],
  [4, 3.5, 0.195, 5.1],
  [5, 4.5, 0.26, 3.8],
  [6, 6.0, 0.33, 3.0],
  [7, 9, 0.5, 2.0],
];

/**
 * Research 01 §8 Table C ("Resulting cell sizes in inches (width × height), computed from A and B"):
 * cyc → sc, hdc, C2C tile, tapestry sc, overlay mosaic, amigurumi.
 */
const PRINTED_TABLE_C: Record<Cyc, { sc: [number, number]; hdc: [number, number]; c2c: number; tapestry: [number, number]; mosaic: [number, number]; ami?: [number, number] }> = {
  0: { sc: [0.118, 0.1], hdc: [0.124, 0.15], c2c: 0.31, tapestry: [0.118, 0.134], mosaic: [0.118, 0.09] },
  1: { sc: [0.167, 0.143], hdc: [0.175, 0.214], c2c: 0.43, tapestry: [0.167, 0.189], mosaic: [0.167, 0.128], ami: [0.13, 0.124] },
  2: { sc: [0.222, 0.19], hdc: [0.233, 0.286], c2c: 0.58, tapestry: [0.222, 0.253], mosaic: [0.222, 0.171], ami: [0.155, 0.148] },
  3: { sc: [0.25, 0.211], hdc: [0.263, 0.316], c2c: 0.65, tapestry: [0.25, 0.284], mosaic: [0.25, 0.192], ami: [0.17, 0.162] },
  4: { sc: [0.296, 0.25], hdc: [0.311, 0.375], c2c: 0.77, tapestry: [0.296, 0.337], mosaic: [0.296, 0.228], ami: [0.195, 0.186] },
  5: { sc: [0.381, 0.333], hdc: [0.4, 0.5], c2c: 0.99, tapestry: [0.381, 0.433], mosaic: [0.381, 0.293], ami: [0.26, 0.248] },
  6: { sc: [0.533, 0.471], hdc: [0.56, 0.706], c2c: 1.39, tapestry: [0.533, 0.606], mosaic: [0.533, 0.41], ami: [0.33, 0.314] },
  7: { sc: [1.0, 0.952], hdc: [1.05, 1.429], c2c: 2.6, tapestry: [1.0, 1.136], mosaic: [1.0, 0.769], ami: [0.5, 0.476] },
};

function expectCell(cell: Cell, [w, h]: [number, number], tol: number): void {
  expect(Math.abs(cell.w - w)).toBeLessThanOrEqual(tol);
  expect(Math.abs(cell.h - h)).toBeLessThanOrEqual(tol);
}

describe('units (§0.1)', () => {
  it('1 in = 2.54 cm and a gauge is stated per 4 in = 10.16 cm', () => {
    expect(CM_PER_IN).toBe(2.54);
    expect(GAUGE_SPAN_IN).toBe(4);
    expect(inToCm(GAUGE_SPAN_IN)).toBeCloseTo(10.16, 12);
    expect(inToCm(1)).toBe(2.54);
    expect(cmToIn(2.54)).toBe(1);
    expect(cmToIn(10)).toBeCloseTo(3.937007874, 9);
    expect(cmToIn(inToCm(7.3))).toBeCloseTo(7.3, 12);
  });
});

describe('Table A — base flat sc gauge by CYC weight (§2.2.1)', () => {
  it('has the eight CYC weights 0–7', () => {
    expect(CYCS).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(Object.keys(TABLE_A).map(Number)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(PRINTED_TABLE_A).toHaveLength(8);
  });

  it.each(PRINTED_TABLE_A)(
    'CYC %i %s: hook %f mm (%s), %f × %f per 4 in, w × h %f × %f in, tol %f, %i yd/100 g',
    (cyc, name, hookMm, hookUs, sts4, rows4, w, h, tol, yd) => {
      expect(TABLE_A[cyc]).toEqual({ name, hookMm, sts4, rows4, tol, ydPer100g: yd });
      // w = 4 / sts4, h = 4 / rows4, printed to 3 decimals
      const cell = scCell(cyc);
      expect(cell.w).toBe(4 / sts4);
      expect(cell.h).toBe(4 / rows4);
      expectCell(cell, [w, h], HALF_3DP);
      // the hook label printed beside the default hook comes from the hook table
      expect(hookUsLabel(hookMm)).toBe(hookUs);
    },
  );

  it('prints an sc aspect w/h between 1.05 and 1.19 for every weight (research 01 §8 Table A)', () => {
    const printedAspect: Record<Cyc, number> = { 0: 1.18, 1: 1.17, 2: 1.17, 3: 1.19, 4: 1.19, 5: 1.14, 6: 1.13, 7: 1.05 };
    for (const cyc of CYCS) {
      const c = scCell(cyc);
      expect(Math.abs(c.w / c.h - printedAspect[cyc])).toBeLessThanOrEqual(HALF_2DP);
    }
  });

  it('is frozen: a consumer cannot change a default by accident', () => {
    expect(Object.isFrozen(TABLE_A)).toBe(true);
    expect(Object.isFrozen(TABLE_A[4])).toBe(true);
    expect(() => {
      (TABLE_A[4] as { sts4: number }).sts4 = 99;
    }).toThrow(TypeError);
    expect(TABLE_A[4].sts4).toBe(13.5);
  });

  it('rejects a weight that is not 0–7', () => {
    for (const bad of [8, -1, 1.5, Number.NaN, '4', undefined, null]) {
      expect(() => scCell(bad as Cyc)).toThrow(RangeError);
    }
  });
});

describe('CYC ranges, sc per 4 in (§2.2.1, research 01 §1.1)', () => {
  it('pins the published ranges: 1: 21–32, 2: 16–20, 3: 12–17, 4: 11–14, 5: 8–11, 6: 7–9, 7: ≤ 6; lace 32–42 in dc', () => {
    expect(CYC_RANGE).toEqual({
      0: { lo: 32, hi: 42, stitch: 'dc' },
      1: { lo: 21, hi: 32, stitch: 'sc' },
      2: { lo: 16, hi: 20, stitch: 'sc' },
      3: { lo: 12, hi: 17, stitch: 'sc' },
      4: { lo: 11, hi: 14, stitch: 'sc' },
      5: { lo: 8, hi: 11, stitch: 'sc' },
      6: { lo: 7, hi: 9, stitch: 'sc' },
      7: { hi: 6, stitch: 'sc' },
    });
    expect(CYC_RANGE[7].lo).toBeUndefined();
    expect(Object.isFrozen(CYC_RANGE) && Object.isFrozen(CYC_RANGE[4])).toBe(true);
  });

  it('holds the Table A stitch count of every weight', () => {
    for (const cyc of CYCS) {
      const r = CYC_RANGE[cyc];
      expect(TABLE_A[cyc].sts4).toBeLessThanOrEqual(r.hi);
      if (r.lo !== undefined) expect(TABLE_A[cyc].sts4).toBeGreaterThanOrEqual(r.lo);
    }
  });

  it('allows ±35% beyond the range before warning (§2.2.5)', () => {
    expect(RANGE_SLACK).toBe(0.35);
  });
});

describe('hook sizes mm → US (§2.2.1, research 01 §1.4)', () => {
  it('pins the 19 labelled sizes', () => {
    expect(HOOK_LABELS.map((l) => [l.mm, l.us])).toEqual([
      [2.25, 'B-1'],
      [2.75, 'C-2'],
      [3.25, 'D-3'],
      [3.5, 'E-4'],
      [3.75, 'F-5'],
      [4, 'G-6'],
      [4.5, '7'],
      [5, 'H-8'],
      [5.5, 'I-9'],
      [6, 'J-10'],
      [6.5, 'K-10½'],
      [8, 'L-11'],
      [9, 'M/N-13'],
      [10, 'N/P-15'],
      [11.5, 'P-16'],
      [15, 'P/Q'],
      [15.75, 'Q'],
      [19, 'S'],
      [25, 'T/U/X'],
    ]);
  });

  it('labels a size and prints sizes without a letter (2.0, 2.5 mm) as mm only', () => {
    expect(hookUsLabel(5)).toBe('H-8');
    expect(hookUsLabel(5.0)).toBe('H-8');
    expect(hookUsLabel(4.5)).toBe('7');
    expect(hookUsLabel(6.5)).toBe('K-10½');
    expect(hookUsLabel(2.0)).toBeUndefined();
    expect(hookUsLabel(2.5)).toBeUndefined();
    expect(hookUsLabel(7)).toBeUndefined();
    expect(hookUsLabel(3.4)).toBeUndefined();
    expect(hookUsLabel(Number.NaN)).toBeUndefined();
  });

  it('offers every labelled size plus 2.0 and 2.5 mm, ascending', () => {
    expect(HOOK_SIZES_MM).toEqual([2.0, 2.25, 2.5, 2.75, 3.25, 3.5, 3.75, 4, 4.5, 5, 5.5, 6, 6.5, 8, 9, 10, 11.5, 15, 15.75, 19, 25]);
    for (const row of PRINTED_TABLE_A) expect(HOOK_SIZES_MM).toContain(row[2]);
    for (const row of PRINTED_TABLE_E) expect(HOOK_SIZES_MM).toContain(row[1]);
  });
});

describe('hook override: (hook / refHook)^0.75 (§2.2.2, research 01 §4.4)', () => {
  it('uses p = 0.75 and shows sizes for p = 0.5 … 1.0', () => {
    expect(HOOK_EXPONENT).toBe(0.75);
    expect(HOOK_EXPONENT_RANGE).toEqual([0.5, 1.0]);
  });

  it('is exactly 1 at the reference hook, so defaults are the table values bit for bit', () => {
    for (const mm of HOOK_SIZES_MM) expect(hookFactor(mm, mm)).toBe(1);
  });

  it('matches hand-computed values', () => {
    // 0.7^0.75 = exp(0.75 · ln 0.7) = exp(−0.2675062) = 0.765286
    expect(hookFactor(3.5, 5)).toBeCloseTo(0.765286, 6);
    // 1.2^0.75 = exp(0.75 · 0.1823216) = 1.146531
    expect(hookFactor(6, 5)).toBeCloseTo(1.146531, 6);
    // 0.875^0.75 = 0.904703 (DK at 3.5 mm, §2.2.4)
    expect(hookFactor(3.5, 4)).toBeCloseTo(0.904703, 6);
    expect(hookFactor(6, 5, 1)).toBeCloseTo(1.2, 15);
    expect(hookFactor(6, 5, 0.5)).toBeCloseTo(Math.sqrt(1.2), 15);
    expect(hookFactor(6, 5, 0.6)).toBeCloseTo(Math.pow(1.2, 0.6), 15);
    expect(hookFactor(6, 5, 0)).toBe(1);
  });

  it('agrees with Math.pow to the last bits and is symmetric and monotone', () => {
    let prev = 0;
    for (let mm = 1; mm <= 30; mm += 0.25) {
      const f = hookFactor(mm, 5);
      expect(Math.abs(f - Math.pow(mm / 5, 0.75))).toBeLessThan(1e-15 * Math.max(1, f));
      expect(f * hookFactor(5, mm)).toBeCloseTo(1, 14);
      expect(f).toBeGreaterThan(prev);
      prev = f;
    }
  });

  it('scales both w and h of the Table A cell', () => {
    // worsted at 3.5 mm: w_sc = 0.296296 × 0.765286 = 0.226751 (§2.2.4 prints it cut to 0.2267)
    const c = scCell(4, 3.5);
    expect(c.w).toBeCloseTo(0.226751, 6);
    expect(Math.abs(c.w - 0.2267)).toBeLessThan(0.0001);
    expect(c.w).toBeCloseTo((4 / 13.5) * 0.765286, 6);
    expect(c.h).toBeCloseTo(0.25 * 0.765286, 6);
    expect(c.w / c.h).toBeCloseTo(16 / 13.5, 12);
    expect(scCell(4, 5)).toEqual(scCell(4));
  });

  it('rejects hooks that are not positive sizes', () => {
    for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => hookFactor(bad, 5)).toThrow(RangeError);
      expect(() => hookFactor(5, bad)).toThrow(RangeError);
      expect(() => scCell(4, bad)).toThrow(RangeError);
    }
    expect(() => hookFactor(5, 5, Number.NaN)).toThrow(RangeError);
    expect(() => hookFactor('5' as unknown as number, 5)).toThrow(/got "5" \(text\)/);
    // a ratio that underflows to 0 or overflows is an error, never a factor of 0 or Infinity
    expect(() => hookFactor(5e-324, 5)).toThrow(/out of range/);
    expect(() => hookFactor(Number.MAX_VALUE, 1e-300)).toThrow(/out of range/);
    expect(() => scCell(4, 5e-324)).toThrow(RangeError);
    expect(() => amiCell(4, { hookMm: 5e-324 })).toThrow(RangeError);
  });
});

describe('Table B — technique transforms and stitch aspect (§2.2.2)', () => {
  const w = 4 / 13.5;
  const h = 4 / 16;
  const worsted: Cell = { w, h };

  it('pins the constants of every row', () => {
    expect(TAPESTRY_ASPECT).toBe(0.88);
    expect(TAPESTRY_EXTRA_PER_STRAND).toBe(0.05);
    expect(HDC_WIDTH_MULT).toBe(1.05);
    expect(HDC_HEIGHT_MULT).toBe(1.5);
    expect(C2C_TILE_WIDTH_MULT).toBe(2.6);
    expect(MOSAIC_ASPECT).toBe(1.3);
  });

  it('pins the printed aspects: sc 1.18, tapestry 0.88, hdc 0.83, C2C 1.0, mosaic 1.3, amigurumi 1.05', () => {
    const aspects: Record<TechniqueId, number> = {
      sc_graphgan: 1.18,
      sc_tapestry: 0.88,
      sc_tapestry_round: 0.88,
      hdc_graphgan: 0.83,
      c2c: 1.0,
      mosaic_overlay: 1.3,
      amigurumi_sc: 1.05,
    };
    for (const [t, aspect] of Object.entries(aspects)) expect(TABLE_B[t as TechniqueId].aspect).toBe(aspect);
    expect(Object.keys(TABLE_B).sort()).toEqual(Object.keys(aspects).sort());
  });

  it('pins the uncertainty band of every row (§2.2.2 for sc and C2C; research 01 §8 Table B for the rest)', () => {
    // sc: 113 labels, smooth-yarn median 1.18, IQR 1.10–1.25
    expect(TABLE_B.sc_graphgan.constant).toEqual({ name: 'aspect', value: 1.18, lo: 1.1, hi: 1.25 });
    expect(TABLE_B.sc_tapestry.constant).toEqual({ name: 'aspect', value: 0.88, lo: 0.84, hi: 1.0 });
    expect(TABLE_B.sc_tapestry_round.constant).toEqual(TABLE_B.sc_tapestry.constant);
    expect(TABLE_B.hdc_graphgan.constant).toEqual({ name: 'heightMult', value: 1.5, lo: 1.45, hi: 1.65 });
    expect(TABLE_B.c2c.constant).toEqual({ name: 'tileMult', value: 2.6, lo: 2.0, hi: 2.9 });
    expect(TABLE_B.mosaic_overlay.constant).toEqual({ name: 'aspect', value: 1.3, lo: 1.0, hi: 1.5 });
    expect(TABLE_B.amigurumi_sc.constant).toEqual({ name: 'aspect', value: 1.05, lo: 0.82, hi: 1.11 });
    for (const row of Object.values(TABLE_B)) {
      expect(row.constant.lo).toBeLessThanOrEqual(row.constant.value);
      expect(row.constant.hi).toBeGreaterThanOrEqual(row.constant.value);
    }
  });

  it('sc_graphgan: w × h, nothing carried', () => {
    expect(techniqueCell(worsted, 'sc_graphgan')).toEqual({ w, h });
    // the Table A aspects sit inside the label IQR 1.10–1.25 for the weights with label data (CYC 1–6)
    for (const cyc of [1, 2, 3, 4, 5, 6] as const) {
      const c = scCell(cyc);
      expect(c.w / c.h).toBeGreaterThanOrEqual(1.1);
      expect(c.w / c.h).toBeLessThanOrEqual(1.25);
    }
  });

  it('sc_tapestry and sc_tapestry_round: w × (w / 0.88)·(1 + 0.05·max(0, carried − 1))', () => {
    for (const t of ['sc_tapestry', 'sc_tapestry_round'] as const) {
      const one = techniqueCell(worsted, t);
      expect(one.w).toBe(w);
      expect(one.h).toBeCloseTo(0.336700337, 9); // 0.2962963 / 0.88
      expect(one.w / one.h).toBeCloseTo(0.88, 12);
      expect(techniqueCell(worsted, t, 1)).toEqual(one);
      expect(techniqueCell(worsted, t, 0)).toEqual(one); // max(0, carried − 1)
      expect(techniqueCell(worsted, t, 2).h).toBeCloseTo(0.336700337 * 1.05, 9);
      expect(techniqueCell(worsted, t, 3).h).toBeCloseTo(0.336700337 * 1.1, 9);
      expect(techniqueCell(worsted, t, 3).w).toBe(w);
    }
  });

  it('hdc_graphgan: 1.05w × 1.5h, aspect ≈ 0.83', () => {
    const c = techniqueCell(worsted, 'hdc_graphgan');
    expect(c.w).toBeCloseTo(0.311111111, 9);
    expect(c.h).toBeCloseTo(0.375, 12);
    expect(c.w / c.h).toBeCloseTo(0.83, 2);
  });

  it('c2c: a square tile 2.6w; worsted ≈ 0.77 in, observed 0.67–0.86 in', () => {
    const c = techniqueCell(worsted, 'c2c');
    expect(c.w).toBeCloseTo(0.77037037, 8);
    expect(c.h).toBe(c.w);
    expect(Math.abs(c.w - 0.77)).toBeLessThanOrEqual(HALF_2DP);
    expect(c.w).toBeGreaterThan(0.67);
    expect(c.w).toBeLessThan(0.86);
    // the top of the observed range is the top of the tile band: 2.9 × 0.2963 = 0.86
    expect(Math.abs(TABLE_B.c2c.constant.hi * w - 0.86)).toBeLessThanOrEqual(HALF_2DP);
  });

  it('mosaic_overlay: w × w / 1.3', () => {
    const c = techniqueCell(worsted, 'mosaic_overlay');
    expect(c.w).toBe(w);
    expect(c.h).toBeCloseTo(0.227920228, 9);
    expect(c.w / c.h).toBeCloseTo(1.3, 12);
  });

  it('ignores `carried` outside tapestry and rejects an unknown technique', () => {
    for (const t of ['sc_graphgan', 'hdc_graphgan', 'c2c', 'mosaic_overlay'] as const) {
      expect(techniqueCell(worsted, t, 3)).toEqual(techniqueCell(worsted, t));
    }
    expect(() => techniqueCell(worsted, 'amigurumi_sc' as Technique2D)).toThrow(RangeError);
    expect(() => techniqueCell(worsted, 'tss' as Technique2D)).toThrow(RangeError);
    // a broken sc cell or strand count never becomes a NaN cell
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => techniqueCell(worsted, 'sc_tapestry', bad)).toThrow(RangeError);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => techniqueCell({ w: bad, h: 0.25 }, 'sc_graphgan')).toThrow(RangeError);
      expect(() => techniqueCell({ w: 0.3, h: bad }, 'c2c')).toThrow(RangeError);
    }
    expect(() => techniqueCell(null as unknown as Cell, 'c2c')).toThrow(RangeError);
  });

  it.each(CYCS.map((cyc) => [cyc]))('reproduces research 01 Table C for CYC %i (sc, hdc, C2C, tapestry, mosaic)', (cyc) => {
    const printed = PRINTED_TABLE_C[cyc];
    const sc = scCell(cyc);
    expectCell(techniqueCell(sc, 'sc_graphgan'), printed.sc, HALF_3DP);
    expectCell(techniqueCell(sc, 'hdc_graphgan'), printed.hdc, HALF_3DP);
    expectCell(techniqueCell(sc, 'sc_tapestry'), printed.tapestry, HALF_3DP);
    expectCell(techniqueCell(sc, 'sc_tapestry_round'), printed.tapestry, HALF_3DP);
    expectCell(techniqueCell(sc, 'mosaic_overlay'), printed.mosaic, HALF_3DP);
    expectCell(techniqueCell(sc, 'c2c'), [printed.c2c, printed.c2c], HALF_2DP);
  });
});

describe('Table E — amigurumi, tight sc in rounds (§2.2.3)', () => {
  it('covers CYC 1–7; CYC 0 is not offered', () => {
    expect(AMI_CYCS).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(Object.keys(TABLE_E).map(Number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(() => amiCell(0)).toThrow(/CYC 0 \(Lace\) is not offered for amigurumi/);
    expect(() => amiHookMm(0)).toThrow(RangeError);
    for (const bad of [8, -1, 2.5, Number.NaN]) expect(() => amiCell(bad as Cyc)).toThrow(RangeError);
  });

  it.each(PRINTED_TABLE_E)('CYC %i: hook %f mm, w %f in, %f sts/in', (cyc, hookMm, w, stsPerIn) => {
    expect(TABLE_E[cyc as Exclude<Cyc, 0>]).toEqual({ hookMm, wIn: w });
    expect(amiHookMm(cyc)).toBe(hookMm);
    const cell = amiCell(cyc);
    expect(cell.w).toBe(w);
    expect(Math.abs(1 / cell.w - stsPerIn)).toBeLessThanOrEqual(HALF_1DP);
  });

  it('h = w / 1.05 (yarn over, default) or w / 1.11 (yarn under)', () => {
    expect(AMI_ASPECT).toEqual({ yarnOver: 1.05, yarnUnder: 1.11 });
    for (const cyc of AMI_CYCS) {
      const w = TABLE_E[cyc].wIn;
      expect(amiCell(cyc).h).toBeCloseTo(w / 1.05, 14);
      expect(amiCell(cyc, { yarnUnder: false }).h).toBeCloseTo(w / 1.05, 14);
      expect(amiCell(cyc, { yarnUnder: true }).h).toBeCloseTo(w / 1.11, 14);
      expect(amiCell(cyc, { yarnUnder: true }).w).toBe(w);
      // research 01 Table C / Table E print h = w / 1.05 to 3 decimals
      expectCell(amiCell(cyc), PRINTED_TABLE_C[cyc].ami as [number, number], HALF_3DP);
    }
    expect(amiCell(4, { yarnUnder: true }).h).toBeCloseTo(0.175676, 6);
  });

  it('every amigurumi hook is smaller than the flat hook of the same yarn', () => {
    for (const cyc of AMI_CYCS) expect(TABLE_E[cyc].hookMm).toBeLessThan(TABLE_A[cyc].hookMm);
  });

  it('scales with the hook relative to the Table E hook', () => {
    // (4 / 3.5)^0.75 = exp(0.75 · 0.1335314) = 1.105335
    const c = amiCell(4, { hookMm: 4 });
    expect(c.w).toBeCloseTo(0.195 * 1.105335, 6);
    expect(c.h).toBeCloseTo((0.195 * 1.105335) / 1.05, 6);
    expect(amiCell(4, { hookMm: 3.5 })).toEqual(amiCell(4));
    expect(() => amiCell(4, { hookMm: 0 })).toThrow(RangeError);
    // options may be null (JSON), and only a real `true` is yarn under
    expect(amiCell(4, null as unknown as undefined)).toEqual(amiCell(4));
    expect(amiCell(4, { yarnUnder: 'false' as unknown as boolean })).toEqual(amiCell(4));
  });

  it('each weight scales from its own hook, so at one fixed hook a finer yarn is not always narrower', () => {
    // 3.5 mm: worsted 0.195 in; DK 0.17 × (3.5 / 2.75)^0.75 = 0.2037 in; sport 0.155 × (3.5 / 2.5)^0.75 = 0.1995 in.
    // The model is the spec's (§2.2.2); a caller that changes the yarn weight drops the hook override with it.
    expect(amiCell(4, { hookMm: 3.5 }).w).toBeCloseTo(0.195, 12);
    expect(amiCell(3, { hookMm: 3.5 }).w).toBeCloseTo(0.2037, 4);
    expect(amiCell(2, { hookMm: 3.5 }).w).toBeCloseTo(0.1995, 4);
    // with each weight's own hook the widths are ordered
    let prev = 0;
    for (const cyc of AMI_CYCS) {
      expect(amiCell(cyc).w).toBeGreaterThan(prev);
      prev = amiCell(cyc).w;
    }
  });

  it('stuffing stretch s: 1.05 for firm or medium, 1.00 for light or none', () => {
    expect(STUFFING_STRETCH).toEqual({ firm: 1.05, medium: 1.05, light: 1, none: 1 });
  });

  it('calibration check: a 42-st sphere in worsted is 42 · 0.195 · 1.05 / π = 2.737 in (PlanetJune ≈ 2.75 in)', () => {
    const d = (42 * amiCell(4).w * STUFFING_STRETCH.firm) / Math.PI;
    expect(d).toBeCloseTo(2.737, 3);
    expect(Math.abs(d - 2.75) / 2.75).toBeLessThan(0.01);
  });
});

describe('measured gauge', () => {
  it('narrows the size tolerance to ±4% (§2.2.5)', () => {
    expect(SWATCH_TOL).toBe(0.04);
    for (const cyc of CYCS) expect(SWATCH_TOL).toBeLessThan(TABLE_A[cyc].tol);
  });
});
