import { describe, expect, it } from 'vitest';
import type { GaugeSpec, ResolvedGauge, Technique2D, TechniqueId } from '../../../types/gauge';
import type { Cyc } from '../../../types/units';
import {
  LSC_SLACK,
  SC_ASPECT_RANGE,
  checkGauge,
  countsPer4In,
  defaultCell,
  defaultHookMm,
  hookSizeRange,
  measurementField,
  measurementOf,
  resolveGauge,
  resolveGaugeChecked,
  sizeBand,
  stuffedCell,
  stuffingStretch,
  swatchFromSize,
  yardageBandFor,
} from '../resolve';
import { cmToIn } from '../tables';

// Expected values are typed from the printed tables (DESIGN.md §2.2.1–2.2.4, research 01 §8 Tables C and D) or
// worked by hand in the comments; none is read back from the implementation's tables.
const HALF_3DP = 0.00051;
const HALF_2DP = 0.0051;

const CYCS: readonly Cyc[] = [0, 1, 2, 3, 4, 5, 6, 7];
const TECHNIQUES_2D: readonly Technique2D[] = ['sc_graphgan', 'sc_tapestry', 'sc_tapestry_round', 'c2c', 'hdc_graphgan', 'mosaic_overlay'];

/** §2.2.1 Table A: hook, stitches × rows per 4 in, w × h (3 decimals), tol. */
const TABLE_A: Record<Cyc, { hook: number; sts4: number; rows4: number; w: number; h: number; tol: number }> = {
  0: { hook: 2.25, sts4: 34, rows4: 40, w: 0.118, h: 0.1, tol: 0.25 },
  1: { hook: 3.25, sts4: 24, rows4: 28, w: 0.167, h: 0.143, tol: 0.15 },
  2: { hook: 4.0, sts4: 18, rows4: 21, w: 0.222, h: 0.19, tol: 0.2 },
  3: { hook: 4.0, sts4: 16, rows4: 19, w: 0.25, h: 0.211, tol: 0.12 },
  4: { hook: 5.0, sts4: 13.5, rows4: 16, w: 0.296, h: 0.25, tol: 0.12 },
  5: { hook: 6.5, sts4: 10.5, rows4: 12, w: 0.381, h: 0.333, tol: 0.15 },
  6: { hook: 8.0, sts4: 7.5, rows4: 8.5, w: 0.533, h: 0.471, tol: 0.15 },
  7: { hook: 15, sts4: 4, rows4: 4.2, w: 1.0, h: 0.952, tol: 0.35 },
};

/** Research 01 Table C: the cell of each 2D technique, w × h in inches. */
const TABLE_C: Record<Cyc, Record<Technique2D, [number, number]>> = {
  0: { sc_graphgan: [0.118, 0.1], hdc_graphgan: [0.124, 0.15], c2c: [0.31, 0.31], sc_tapestry: [0.118, 0.134], sc_tapestry_round: [0.118, 0.134], mosaic_overlay: [0.118, 0.09] },
  1: { sc_graphgan: [0.167, 0.143], hdc_graphgan: [0.175, 0.214], c2c: [0.43, 0.43], sc_tapestry: [0.167, 0.189], sc_tapestry_round: [0.167, 0.189], mosaic_overlay: [0.167, 0.128] },
  2: { sc_graphgan: [0.222, 0.19], hdc_graphgan: [0.233, 0.286], c2c: [0.58, 0.58], sc_tapestry: [0.222, 0.253], sc_tapestry_round: [0.222, 0.253], mosaic_overlay: [0.222, 0.171] },
  3: { sc_graphgan: [0.25, 0.211], hdc_graphgan: [0.263, 0.316], c2c: [0.65, 0.65], sc_tapestry: [0.25, 0.284], sc_tapestry_round: [0.25, 0.284], mosaic_overlay: [0.25, 0.192] },
  4: { sc_graphgan: [0.296, 0.25], hdc_graphgan: [0.311, 0.375], c2c: [0.77, 0.77], sc_tapestry: [0.296, 0.337], sc_tapestry_round: [0.296, 0.337], mosaic_overlay: [0.296, 0.228] },
  5: { sc_graphgan: [0.381, 0.333], hdc_graphgan: [0.4, 0.5], c2c: [0.99, 0.99], sc_tapestry: [0.381, 0.433], sc_tapestry_round: [0.381, 0.433], mosaic_overlay: [0.381, 0.293] },
  6: { sc_graphgan: [0.533, 0.471], hdc_graphgan: [0.56, 0.706], c2c: [1.39, 1.39], sc_tapestry: [0.533, 0.606], sc_tapestry_round: [0.533, 0.606], mosaic_overlay: [0.533, 0.41] },
  7: { sc_graphgan: [1.0, 0.952], hdc_graphgan: [1.05, 1.429], c2c: [2.6, 2.6], sc_tapestry: [1.0, 1.136], sc_tapestry_round: [1.0, 1.136], mosaic_overlay: [1.0, 0.769] },
};

/** §2.2.4 Table D, column sc: `L_sc` at the Table A hook. */
const TABLE_D_SC: Record<Cyc, number> = { 0: 0.76, 1: 1.08, 2: 1.44, 3: 1.62, 4: 1.93, 5: 2.48, 6: 3.47, 7: 6.5 };

/**
 * §2.2.3 Table E and §2.2.4 Table D (amigurumi column): hook, w, `L_ami`; and by hand
 * `wSc = Table A width × (Table E hook / Table A hook)^0.75`:
 *   CYC 1 0.1666667 × 0.7589696 = 0.126495   CYC 2 0.2222222 × 0.7029267 = 0.156206
 *   CYC 3 0.25 × 0.7550132 = 0.188753        CYC 4 0.2962963 × 0.7652856 = 0.226751
 *   CYC 5 0.3809524 × 0.7589696 = 0.289131   CYC 6 0.5333333 × 0.8059274 = 0.429828
 *   CYC 7 1 × 0.6817316 = 0.681732
 */
const AMI: Record<Exclude<Cyc, 0>, { hook: number; w: number; lAmi: number; wSc: number; factor: number }> = {
  1: { hook: 2.25, w: 0.13, lAmi: 0.85, wSc: 0.126495, factor: 0.7589696 },
  2: { hook: 2.5, w: 0.155, lAmi: 1.02, wSc: 0.156206, factor: 0.7029267 },
  3: { hook: 2.75, w: 0.17, lAmi: 1.23, wSc: 0.188753, factor: 0.7550132 },
  4: { hook: 3.5, w: 0.195, lAmi: 1.47, wSc: 0.226751, factor: 0.7652856 },
  5: { hook: 4.5, w: 0.26, lAmi: 1.88, wSc: 0.289131, factor: 0.7589696 },
  6: { hook: 6.0, w: 0.33, lAmi: 2.79, wSc: 0.429828, factor: 0.8059274 },
  7: { hook: 9, w: 0.5, lAmi: 4.43, wSc: 0.681732, factor: 0.6817316 },
};

const KEYS: readonly (keyof ResolvedGauge)[] = ['cell', 'wSc', 'hSc', 'lscIn', 'hookMm', 'stretch', 'tol', 'source'];

function expectFiniteGauge(g: ResolvedGauge): void {
  expect(Object.keys(g).sort()).toEqual([...KEYS].sort());
  for (const v of [g.cell.w, g.cell.h, g.wSc, g.hSc, g.lscIn, g.hookMm, g.stretch, g.tol]) {
    expect(Number.isFinite(v)).toBe(true);
    expect(v).toBeGreaterThan(0);
  }
}

describe('resolveGauge — defaults for each CYC weight × technique (§2.2.5 step 2)', () => {
  for (const cyc of CYCS) {
    for (const technique of TECHNIQUES_2D) {
      it(`CYC ${cyc} ${technique}: Table A × Table B, Table A hook and tolerance`, () => {
        const g = resolveGauge({ cyc, technique });
        expectFiniteGauge(g);
        const [w, h] = TABLE_C[cyc][technique];
        const half = technique === 'c2c' ? HALF_2DP : HALF_3DP;
        expect(Math.abs(g.cell.w - w)).toBeLessThanOrEqual(half);
        expect(Math.abs(g.cell.h - h)).toBeLessThanOrEqual(half);
        // wSc, hSc: the Table A sc cell, whatever the technique (§2.2.5 step 3)
        expect(Math.abs(g.wSc - TABLE_A[cyc].w)).toBeLessThanOrEqual(HALF_3DP);
        expect(Math.abs(g.hSc - TABLE_A[cyc].h)).toBeLessThanOrEqual(HALF_3DP);
        expect(g.hookMm).toBe(TABLE_A[cyc].hook);
        expect(g.stretch).toBe(1);
        expect(g.tol).toBe(TABLE_A[cyc].tol);
        expect(g.source).toBe('default');
        // lscIn = L_sc = 6.5 · wSc: Table D within ±0.01
        expect(Math.abs(g.lscIn - TABLE_D_SC[cyc])).toBeLessThanOrEqual(0.01);
        expect(g.lscIn).toBeCloseTo(6.5 * g.wSc, 12);
      });
    }
  }

  for (const cyc of [1, 2, 3, 4, 5, 6, 7] as const) {
    it(`CYC ${cyc} amigurumi_sc: Table E width, w / 1.05, stretch 1.05, hSc and L_ami at the Table E hook`, () => {
      const g = resolveGauge({ cyc, technique: 'amigurumi_sc' });
      expectFiniteGauge(g);
      const e = AMI[cyc];
      expect(g.cell.w).toBe(e.w);
      expect(g.cell.h).toBeCloseTo(e.w / 1.05, 14);
      expect(g.hookMm).toBe(e.hook);
      expect(g.stretch).toBe(1.05);
      expect(g.tol).toBe(TABLE_A[cyc].tol);
      expect(g.source).toBe('default');
      // wSc, hSc: Table A × (Table E hook / Table A hook)^0.75 — the flat sc cell at the amigurumi hook
      expect(g.wSc).toBeCloseTo(e.wSc, 6);
      expect(g.wSc).toBeCloseTo((4 / TABLE_A[cyc].sts4) * e.factor, 6);
      expect(g.hSc).toBeCloseTo((4 / TABLE_A[cyc].rows4) * e.factor, 6);
      // L_ami = 6.5 · max(w_sc, w_ami): Table D amigurumi column within ±0.01
      expect(Math.abs(g.lscIn - e.lAmi)).toBeLessThanOrEqual(0.01);
      expect(g.lscIn).toBeCloseTo(6.5 * Math.max(e.wSc, e.w), 5);
    });
  }

  it('worsted amigurumi: hSc = 0.25 × 0.7^0.75 = 0.1913 and L_ami = 6.5 × 0.2267 = 1.474 (§2.2.4, §2.8)', () => {
    const g = resolveGauge({ cyc: 4, technique: 'amigurumi_sc' });
    // (4 / 13.5) × 0.7652856 = 0.226751; §2.2.4 prints it cut to 0.2267
    expect(g.wSc).toBeCloseTo(0.226751, 6);
    expect(Math.abs(g.wSc - 0.2267)).toBeLessThan(0.0001);
    expect(g.hSc).toBeCloseTo(0.191321, 6);
    expect(g.lscIn).toBeCloseTo(1.474, 3);
    expect(g.cell).toEqual({ w: 0.195, h: 0.195 / 1.05 });
  });

  it('only CYC 1 takes the Table E branch of the max: 6.5 × 0.13 = 0.845 against 0.822 (§2.2.4)', () => {
    for (const cyc of [1, 2, 3, 4, 5, 6, 7] as const) {
      const g = resolveGauge({ cyc, technique: 'amigurumi_sc' });
      if (cyc === 1) {
        expect(g.wSc).toBeLessThan(g.cell.w);
        expect(g.lscIn).toBeCloseTo(0.845, 12);
        expect(6.5 * g.wSc).toBeCloseTo(0.822, 3);
      } else {
        expect(g.wSc).toBeGreaterThan(g.cell.w);
        expect(g.lscIn).toBeCloseTo(6.5 * g.wSc, 12);
      }
    }
  });

  it('yarn under: h = w / 1.11 (D17); ignored by the 2D techniques', () => {
    const over = resolveGauge({ cyc: 4, technique: 'amigurumi_sc' });
    const under = resolveGauge({ cyc: 4, technique: 'amigurumi_sc', yarnUnder: true });
    expect(under.cell.w).toBe(0.195);
    expect(under.cell.h).toBeCloseTo(0.195 / 1.11, 14);
    expect(under.cell.h).toBeLessThan(over.cell.h);
    expect({ ...under, cell: over.cell }).toEqual(over);
    expect(resolveGauge({ cyc: 4, technique: 'sc_graphgan', yarnUnder: true })).toEqual(resolveGauge({ cyc: 4, technique: 'sc_graphgan' }));
  });

  it('carried strands make tapestry stitches 5% taller each beyond the first; other techniques ignore them', () => {
    const base = resolveGauge({ cyc: 4, technique: 'sc_tapestry' });
    expect(base.cell.h).toBeCloseTo(0.3367, 4);
    expect(resolveGauge({ cyc: 4, technique: 'sc_tapestry', carried: 1 })).toEqual(base);
    expect(resolveGauge({ cyc: 4, technique: 'sc_tapestry', carried: 0 })).toEqual(base);
    expect(resolveGauge({ cyc: 4, technique: 'sc_tapestry', carried: 2 }).cell.h).toBeCloseTo(0.3367 * 1.05, 4);
    expect(resolveGauge({ cyc: 4, technique: 'sc_tapestry_round', carried: 3 }).cell.h).toBeCloseTo(0.3367 * 1.1, 4);
    expect(resolveGauge({ cyc: 4, technique: 'sc_tapestry', carried: 3 }).cell.w).toBe(base.cell.w);
    for (const technique of ['sc_graphgan', 'hdc_graphgan', 'c2c', 'mosaic_overlay', 'amigurumi_sc'] as const) {
      expect(resolveGauge({ cyc: 4, technique, carried: 3 })).toEqual(resolveGauge({ cyc: 4, technique }));
    }
  });

  it('defaultHookMm and defaultCell give the same defaults without resolving', () => {
    for (const cyc of CYCS) {
      for (const technique of TECHNIQUES_2D) {
        expect(defaultHookMm(cyc, technique)).toBe(TABLE_A[cyc].hook);
        expect(defaultCell(cyc, technique)).toEqual(resolveGauge({ cyc, technique }).cell);
      }
    }
    for (const cyc of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(defaultHookMm(cyc, 'amigurumi_sc')).toBe(AMI[cyc].hook);
      expect(defaultCell(cyc, 'amigurumi_sc')).toEqual(resolveGauge({ cyc, technique: 'amigurumi_sc' }).cell);
      expect(defaultCell(cyc, 'amigurumi_sc', { yarnUnder: true })).toEqual(resolveGauge({ cyc, technique: 'amigurumi_sc', yarnUnder: true }).cell);
    }
    expect(defaultCell(4, 'sc_tapestry', { carried: 2, hookMm: 4 })).toEqual(resolveGauge({ cyc: 4, technique: 'sc_tapestry', carried: 2, hookMm: 4 }).cell);
    expect(() => defaultHookMm(0, 'amigurumi_sc')).toThrow(RangeError);
    expect(() => defaultCell(0, 'amigurumi_sc')).toThrow(RangeError);
    expect(() => defaultHookMm(9 as Cyc, 'c2c')).toThrow(RangeError);
    expect(() => defaultCell(4, 'tss' as TechniqueId)).toThrow(RangeError);
  });
});

describe('resolveGauge — hook override without a swatch (§2.2.2)', () => {
  it('multiplies w and h by (hook / Table A hook)^0.75 before the Table B transform', () => {
    // worsted, 6 mm instead of 5 mm: 1.2^0.75 = 1.146531
    const f = 1.146531;
    const sc = resolveGauge({ cyc: 4, technique: 'sc_graphgan', hookMm: 6 });
    expect(sc.hookMm).toBe(6);
    expect(sc.cell.w).toBeCloseTo((4 / 13.5) * f, 6);
    expect(sc.cell.h).toBeCloseTo(0.25 * f, 6);
    expect(sc.wSc).toBe(sc.cell.w);
    expect(sc.hSc).toBe(sc.cell.h);
    expect(sc.lscIn).toBeCloseTo(6.5 * (4 / 13.5) * f, 5);
    expect(sc.tol).toBe(0.12);
    expect(sc.source).toBe('default');

    const hdc = resolveGauge({ cyc: 4, technique: 'hdc_graphgan', hookMm: 6 });
    expect(hdc.cell.w).toBeCloseTo(1.05 * (4 / 13.5) * f, 6);
    expect(hdc.cell.h).toBeCloseTo(1.5 * 0.25 * f, 6);
    expect(hdc.wSc).toBe(sc.wSc);
    expect(hdc.hSc).toBe(sc.hSc);

    const c2c = resolveGauge({ cyc: 4, technique: 'c2c', hookMm: 6 });
    expect(c2c.cell.w).toBeCloseTo(2.6 * (4 / 13.5) * f, 6);
    expect(c2c.cell.h).toBe(c2c.cell.w);

    const tap = resolveGauge({ cyc: 4, technique: 'sc_tapestry', hookMm: 6 });
    expect(tap.cell.h).toBeCloseTo(((4 / 13.5) * f) / 0.88, 6);
    const mos = resolveGauge({ cyc: 4, technique: 'mosaic_overlay', hookMm: 6 });
    expect(mos.cell.h).toBeCloseTo(((4 / 13.5) * f) / 1.3, 6);
  });

  it('the Table A hook given explicitly changes nothing', () => {
    for (const cyc of CYCS) {
      for (const technique of TECHNIQUES_2D) {
        expect(resolveGauge({ cyc, technique, hookMm: TABLE_A[cyc].hook })).toEqual(resolveGauge({ cyc, technique }));
      }
    }
    for (const cyc of [1, 2, 3, 4, 5, 6, 7] as const) {
      expect(resolveGauge({ cyc, technique: 'amigurumi_sc', hookMm: AMI[cyc].hook })).toEqual(resolveGauge({ cyc, technique: 'amigurumi_sc' }));
    }
  });

  it('amigurumi: the cell scales from the Table E hook, wSc and hSc from the Table A hook', () => {
    // worsted amigurumi with a 4 mm hook: (4 / 3.5)^0.75 = 1.105335, (4 / 5)^0.75 = 0.845897
    const g = resolveGauge({ cyc: 4, technique: 'amigurumi_sc', hookMm: 4 });
    expect(g.hookMm).toBe(4);
    expect(g.cell.w).toBeCloseTo(0.195 * 1.105335, 6);
    expect(g.cell.h).toBeCloseTo((0.195 * 1.105335) / 1.05, 6);
    expect(g.wSc).toBeCloseTo((4 / 13.5) * 0.845897, 6);
    expect(g.hSc).toBeCloseTo(0.25 * 0.845897, 6);
    // L_ami = 6.5 · max(0.250636, 0.215540) = 1.629134
    expect(g.lscIn).toBeCloseTo(1.629135, 5);
    expect(g.stretch).toBe(1.05);
  });

  it('a larger hook never makes a smaller stitch', () => {
    for (const technique of [...TECHNIQUES_2D, 'amigurumi_sc'] as const) {
      let prev = resolveGauge({ cyc: 4, technique, hookMm: 2 });
      for (let mm = 2.25; mm <= 12; mm += 0.25) {
        const g = resolveGauge({ cyc: 4, technique, hookMm: mm });
        expect(g.cell.w).toBeGreaterThan(prev.cell.w);
        expect(g.cell.h).toBeGreaterThan(prev.cell.h);
        expect(g.lscIn).toBeGreaterThanOrEqual(prev.lscIn);
        prev = g;
      }
    }
  });
});

describe('resolveGauge — a measured swatch wins (§2.2.5 step 1; research 01 §7 input modes)', () => {
  it('mode a, "S stitches and R rows in 4 in": cell = { span / sts, span / rows }, tol 0.04, source swatch', () => {
    const g = resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 14, rows: 17, spanIn: 4 } });
    expect(g.cell.w).toBeCloseTo(4 / 14, 14);
    expect(g.cell.h).toBeCloseTo(4 / 17, 14);
    expect(g.tol).toBe(0.04);
    expect(g.source).toBe('swatch');
    expect(g.stretch).toBe(1);
    expect(g.hookMm).toBe(5);
    // an sc_graphgan swatch sets wSc and hSc directly, and L_sc follows the measured width
    expect(g.wSc).toBe(g.cell.w);
    expect(g.hSc).toBe(g.cell.h);
    expect(g.lscIn).toBeCloseTo((6.5 * 4) / 14, 12);
  });

  it('any span: "9 sc and 10 rows = 2 in", and a 10 cm swatch (19 sc and 24 rows = 10 × 10 cm)', () => {
    const two = resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 9, rows: 10, spanIn: 2 } });
    expect(two.cell.w).toBeCloseTo(2 / 9, 14);
    expect(two.cell.h).toBeCloseTo(0.2, 14);
    const cm = resolveGauge({ cyc: 3, technique: 'mosaic_overlay', swatch: { sts: 19, rows: 24, spanIn: cmToIn(10) } });
    expect(cm.cell.w).toBeCloseTo(0.207211, 6); // 3.937008 / 19
    expect(cm.cell.h).toBeCloseTo(0.164042, 6); // 3.937008 / 24
    expect(cm.cell.w / cm.cell.h).toBeCloseTo(24 / 19, 12);
  });

  it('mode b, "S × R stitches measure W × H": swatchFromSize restates the rows over the width', () => {
    // Interweave's sc swatch: 20 sts × 20 rows = 6.25 × 5.75 in (research 01 §2.2)
    const swatch = swatchFromSize({ sts: 20, rows: 20, widthIn: 6.25, heightIn: 5.75 });
    expect(swatch.spanIn).toBe(6.25);
    expect(swatch.sts).toBe(20);
    expect(swatch.rows).toBeCloseTo(21.73913, 5);
    const g = resolveGauge({ cyc: 5, technique: 'sc_graphgan', swatch });
    expect(g.cell.w).toBeCloseTo(0.3125, 12);
    expect(g.cell.h).toBeCloseTo(0.2875, 12);
    expect(() => swatchFromSize({ sts: 20, rows: 20, widthIn: 0, heightIn: 5 })).toThrow(RangeError);
    expect(() => swatchFromSize({ sts: Number.NaN, rows: 20, widthIn: 6, heightIn: 5 })).toThrow(RangeError);
  });

  it('a tapestry, hdc or mosaic swatch sets the cell; wSc, hSc and L_sc stay at Table A × hook factor', () => {
    // Ventura's tapestry heart: 12.5 sts and 11 rows = 4 in (research 01 §3.4)
    for (const technique of ['sc_tapestry', 'sc_tapestry_round', 'hdc_graphgan', 'mosaic_overlay'] as const) {
      const g = resolveGauge({ cyc: 4, technique, swatch: { sts: 12.5, rows: 11, spanIn: 4 } });
      expect(g.cell.w).toBeCloseTo(0.32, 14);
      expect(g.cell.h).toBeCloseTo(4 / 11, 14);
      expect(g.wSc).toBe(4 / 13.5);
      expect(g.hSc).toBe(0.25);
      expect(g.lscIn).toBeCloseTo(1.925926, 6);
      expect(g.tol).toBe(0.04);
      expect(g.source).toBe('swatch');
    }
    // with a hook override the sc cell still scales
    const g = resolveGauge({ cyc: 4, technique: 'sc_tapestry', hookMm: 3.5, swatch: { sts: 17, rows: 15, spanIn: 4 } });
    expect(g.cell.w).toBeCloseTo(4 / 17, 14);
    expect(g.wSc).toBeCloseTo(0.226751, 6);
    expect(g.hSc).toBeCloseTo(0.191321, 6);
  });

  it('a swatch is not hook-scaled and ignores `carried`: it already includes both', () => {
    const swatch = { sts: 14, rows: 12, spanIn: 4 };
    const a = resolveGauge({ cyc: 4, technique: 'sc_tapestry', swatch });
    const b = resolveGauge({ cyc: 4, technique: 'sc_tapestry', swatch, carried: 3, hookMm: 3.5 });
    expect(b.cell).toEqual(a.cell);
    expect(b.hookMm).toBe(3.5);
  });

  it('mode c, C2C "N tiles = X in": a square tile X / N', () => {
    // Red Heart C2C throw: 6 blocks = 4 in (research 01 §3.3)
    const g = resolveGauge({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 6, spanIn: 4 } });
    expect(g.cell.w).toBeCloseTo(4 / 6, 14);
    expect(g.cell.h).toBe(g.cell.w);
    expect(g.tol).toBe(0.04);
    expect(g.source).toBe('swatch');
    expect(g.wSc).toBe(4 / 13.5);
    expect(g.hSc).toBe(0.25);
    expect(g.lscIn).toBeCloseTo(1.925926, 6);
    expect(g.stretch).toBe(1);
  });

  it('mode d, amigurumi test ball "max N sts, circumference C": w·s = C / N with s := 1', () => {
    // PlanetJune's 42-st ball, 2.75 in across: C = 2.75π = 8.639 in
    const C = 2.75 * Math.PI;
    const g = resolveGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 42, circumferenceIn: C } });
    expect(g.cell.w).toBeCloseTo(C / 42, 14);
    expect(g.cell.w).toBeCloseTo(0.2057, 4); // 8.6394 / 42
    expect(g.cell.h).toBeCloseTo(C / 42 / 1.05, 14);
    expect(g.stretch).toBe(1);
    expect(g.tol).toBe(0.04);
    expect(g.source).toBe('swatch');
    expect(g.hookMm).toBe(3.5);
    // the test ball does not change the yarn per stitch: the hook scales the yarn, not the stitch width (§2.2.4)
    const def = resolveGauge({ cyc: 4, technique: 'amigurumi_sc' });
    expect(g.lscIn).toBe(def.lscIn);
    expect(g.wSc).toBe(def.wSc);
    expect(g.hSc).toBe(def.hSc);
    // the stuffed stitch w·s is what was measured: a 42-st ball comes out 2.75 in again
    expect((42 * g.cell.w * g.stretch) / Math.PI).toBeCloseTo(2.75, 12);
    // yarn under changes only the round height
    const under = resolveGauge({ cyc: 4, technique: 'amigurumi_sc', yarnUnder: true, testBall: { maxSts: 42, circumferenceIn: C } });
    expect(under.cell.w).toBe(g.cell.w);
    expect(under.cell.h).toBeCloseTo(C / 42 / 1.11, 14);
  });

  it('a test ball that measures exactly the table gauge gives the same stuffed stitch as the default', () => {
    const def = resolveGauge({ cyc: 4, technique: 'amigurumi_sc' });
    const ball = resolveGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 36 * 0.195 * 1.05 } });
    expect(ball.cell.w * ball.stretch).toBeCloseTo(def.cell.w * def.stretch, 14);
    expect(ball.cell.w / ball.cell.h).toBeCloseTo(def.cell.w / def.cell.h, 12);
  });

  it('mode e, "unravel 10 stitches": lscCalibratedIn overrides L_sc and L_ami and nothing else', () => {
    for (const technique of [...TECHNIQUES_2D, 'amigurumi_sc'] as const) {
      const plain = resolveGauge({ cyc: 4, technique });
      const cal = resolveGauge({ cyc: 4, technique, lscCalibratedIn: 1.8 });
      expect(cal.lscIn).toBe(1.8);
      expect({ ...cal, lscIn: plain.lscIn }).toEqual(plain);
    }
    const both = resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 14, rows: 17, spanIn: 4 }, lscCalibratedIn: 2.1 });
    expect(both.lscIn).toBe(2.1);
    expect(both.source).toBe('swatch');
  });

  it('each technique reads only its own measurement', () => {
    const swatch = { sts: 20, rows: 20, spanIn: 4 };
    const c2cSwatch = { tiles: 9, spanIn: 4 };
    const testBall = { maxSts: 36, circumferenceIn: 9 };
    expect(measurementField('sc_graphgan')).toBe('swatch');
    expect(measurementField('sc_tapestry')).toBe('swatch');
    expect(measurementField('sc_tapestry_round')).toBe('swatch');
    expect(measurementField('hdc_graphgan')).toBe('swatch');
    expect(measurementField('mosaic_overlay')).toBe('swatch');
    expect(measurementField('c2c')).toBe('c2cSwatch');
    expect(measurementField('amigurumi_sc')).toBe('testBall');

    // a leftover measurement of another family is ignored: the tables answer
    expect(resolveGauge({ cyc: 4, technique: 'c2c', swatch, testBall })).toEqual(resolveGauge({ cyc: 4, technique: 'c2c' }));
    expect(resolveGauge({ cyc: 4, technique: 'sc_graphgan', c2cSwatch, testBall })).toEqual(resolveGauge({ cyc: 4, technique: 'sc_graphgan' }));
    expect(resolveGauge({ cyc: 4, technique: 'amigurumi_sc', swatch, c2cSwatch })).toEqual(resolveGauge({ cyc: 4, technique: 'amigurumi_sc' }));
    expect(measurementOf({ cyc: 4, technique: 'c2c', swatch, testBall })).toBeUndefined();
    expect(measurementOf({ cyc: 4, technique: 'c2c', swatch, c2cSwatch })).toBe('c2cSwatch');
    expect(measurementOf({ cyc: 4, technique: 'sc_tapestry', swatch })).toBe('swatch');
    expect(measurementOf({ cyc: 4, technique: 'amigurumi_sc', testBall })).toBe('testBall');
    expect(measurementOf({ cyc: 4, technique: 'amigurumi_sc' })).toBeUndefined();

    // with all three present, each family still takes its own
    const all = { swatch, c2cSwatch, testBall };
    expect(resolveGauge({ cyc: 4, technique: 'sc_graphgan', ...all }).cell).toEqual({ w: 0.2, h: 0.2 });
    expect(resolveGauge({ cyc: 4, technique: 'c2c', ...all }).cell).toEqual({ w: 4 / 9, h: 4 / 9 });
    expect(resolveGauge({ cyc: 4, technique: 'amigurumi_sc', ...all }).cell.w).toBe(0.25);
  });

  it('uncertainty: the Table A tolerance by default, ±4% once measured', () => {
    for (const cyc of CYCS) {
      expect(resolveGauge({ cyc, technique: 'sc_graphgan' }).tol).toBe(TABLE_A[cyc].tol);
      expect(resolveGauge({ cyc, technique: 'sc_graphgan', swatch: { sts: 13, rows: 15, spanIn: 4 } }).tol).toBe(0.04);
      expect(resolveGauge({ cyc, technique: 'c2c', c2cSwatch: { tiles: 5, spanIn: 4 } }).tol).toBe(0.04);
      expect(TABLE_A[cyc].tol).toBeGreaterThan(0.04);
    }
    expect(resolveGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 7.4 } }).tol).toBe(0.04);
    // a hook override alone is not a measurement
    expect(resolveGauge({ cyc: 4, technique: 'sc_graphgan', hookMm: 6 }).tol).toBe(0.12);
  });

  it('treats null like undefined (a GaugeSpec read back from JSON)', () => {
    const fromJson = { cyc: 4, technique: 'sc_graphgan', hookMm: null, swatch: null, c2cSwatch: null, testBall: null, carried: null, yarnUnder: null, lscCalibratedIn: null } as unknown as GaugeSpec;
    expect(resolveGauge(fromJson)).toEqual(resolveGauge({ cyc: 4, technique: 'sc_graphgan' }));
    expect(checkGauge(fromJson)).toEqual([]);
    expect(measurementOf(fromJson)).toBeUndefined();
  });

  it('does not change its argument and returns a fresh object each time', () => {
    const spec: GaugeSpec = Object.freeze({ cyc: 4, technique: 'sc_tapestry', carried: 2, swatch: Object.freeze({ sts: 14, rows: 12, spanIn: 4 }) });
    const a = resolveGauge(spec);
    const b = resolveGauge(spec);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(a.cell).not.toBe(b.cell);
  });
});

describe('resolveGauge — invalid input is rejected (§2.2.5)', () => {
  const bad: [string, GaugeSpec][] = [
    ['a weight above 7', { cyc: 8 as Cyc, technique: 'sc_graphgan' }],
    ['a negative weight', { cyc: -1 as Cyc, technique: 'sc_graphgan' }],
    ['a fractional weight', { cyc: 3.5 as Cyc, technique: 'sc_graphgan' }],
    ['a NaN weight', { cyc: Number.NaN as Cyc, technique: 'sc_graphgan' }],
    ['a weight given as text', { cyc: '4' as unknown as Cyc, technique: 'sc_graphgan' }],
    ['an unknown technique', { cyc: 4, technique: 'tss' as TechniqueId }],
    ['a prototype key as technique', { cyc: 4, technique: 'constructor' as TechniqueId }],
    ['CYC 0 for amigurumi', { cyc: 0, technique: 'amigurumi_sc' }],
    ['a zero hook', { cyc: 4, technique: 'sc_graphgan', hookMm: 0 }],
    ['a negative hook', { cyc: 4, technique: 'amigurumi_sc', hookMm: -3.5 }],
    ['a NaN hook', { cyc: 4, technique: 'c2c', hookMm: Number.NaN }],
    ['an infinite hook', { cyc: 4, technique: 'c2c', hookMm: Number.POSITIVE_INFINITY }],
    ['a swatch with no stitches', { cyc: 4, technique: 'sc_graphgan', swatch: { sts: 0, rows: 16, spanIn: 4 } }],
    ['a swatch with negative rows', { cyc: 4, technique: 'sc_tapestry', swatch: { sts: 13, rows: -16, spanIn: 4 } }],
    ['a swatch with a NaN span', { cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 13, rows: 16, spanIn: Number.NaN } }],
    ['a swatch with an infinite count', { cyc: 4, technique: 'mosaic_overlay', swatch: { sts: Number.POSITIVE_INFINITY, rows: 16, spanIn: 4 } }],
    ['a swatch with a missing field', { cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13, spanIn: 4 } as NonNullable<GaugeSpec['swatch']> }],
    ['a swatch whose stitch width overflows', { cyc: 4, technique: 'sc_graphgan', swatch: { sts: 1e-320, rows: 1, spanIn: 1 } }],
    ['a swatch whose row height underflows to 0', { cyc: 4, technique: 'sc_tapestry', swatch: { sts: 1, rows: 1e300, spanIn: 1e-300 } }],
    ['a C2C swatch whose tile overflows', { cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 1e-320, spanIn: 1e10 } }],
    ['a test ball whose stitch underflows to 0', { cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 1e300, circumferenceIn: 1e-300 } }],
    ['a C2C swatch with no tiles', { cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 0, spanIn: 4 } }],
    ['a C2C swatch with a zero span', { cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 6, spanIn: 0 } }],
    ['a test ball with no stitches', { cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 0, circumferenceIn: 8 } }],
    ['a test ball with a negative circumference', { cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: -8 } }],
    ['a negative number of carried strands', { cyc: 4, technique: 'sc_tapestry', carried: -1 }],
    ['a NaN number of carried strands', { cyc: 4, technique: 'sc_tapestry_round', carried: Number.NaN }],
    ['a zero calibrated yarn per stitch', { cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 0 }],
    ['a negative calibrated yarn per stitch', { cyc: 4, technique: 'amigurumi_sc', lscCalibratedIn: -1.5 }],
    ['a NaN calibrated yarn per stitch', { cyc: 4, technique: 'c2c', lscCalibratedIn: Number.NaN }],
  ];

  it.each(bad)('throws a RangeError for %s, and checkGauge reports E_GAUGE_INPUT instead of throwing', (_name, spec) => {
    expect(() => resolveGauge(spec)).toThrow(RangeError);
    expect(() => resolveGauge(spec)).toThrow(/^resolveGauge: /);
    const issues = checkGauge(spec);
    expect(issues.length).toBeGreaterThan(0);
    for (const issue of issues) {
      expect(issue.code).toBe('E_GAUGE_INPUT');
      expect(issue.severity).toBe('error');
      expect(issue.message.length).toBeGreaterThan(10);
    }
  });

  it('names the field and says why', () => {
    expect(checkGauge({ cyc: 0, technique: 'amigurumi_sc' })).toEqual([
      { code: 'E_GAUGE_INPUT', severity: 'error', field: 'cyc', message: 'CYC 0 (Lace) is not offered for amigurumi: Table E has no row for it. Choose CYC 1–7.' },
    ]);
    expect(() => resolveGauge({ cyc: 0, technique: 'amigurumi_sc' })).toThrow('resolveGauge: CYC 0 (Lace) is not offered for amigurumi');
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', hookMm: -1 }).map((i) => i.field)).toEqual(['hookMm']);
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 0, rows: 1, spanIn: 4 } }).map((i) => i.field)).toEqual(['swatch']);
    expect(checkGauge({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 0, spanIn: 4 } }).map((i) => i.field)).toEqual(['c2cSwatch']);
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 0, circumferenceIn: 4 } }).map((i) => i.field)).toEqual(['testBall']);
    expect(checkGauge({ cyc: 4, technique: 'sc_tapestry', carried: -2 }).map((i) => i.field)).toEqual(['carried']);
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 0 }).map((i) => i.field)).toEqual(['lscCalibratedIn']);
    // every problem is listed, not only the first
    expect(checkGauge({ cyc: 9 as Cyc, technique: 'x' as TechniqueId, hookMm: 0, lscCalibratedIn: -1 }).map((i) => i.field)).toEqual(['cyc', 'technique', 'hookMm', 'lscCalibratedIn']);
    expect(() => resolveGauge(null as unknown as GaugeSpec)).toThrow(RangeError);
    expect(() => resolveGauge(undefined as unknown as GaugeSpec)).toThrow(RangeError);
    expect(checkGauge(null as unknown as GaugeSpec)).toHaveLength(1);
  });

  it('CYC 0 is fine for every 2D technique', () => {
    for (const technique of TECHNIQUES_2D) expect(() => resolveGauge({ cyc: 0, technique })).not.toThrow();
  });

  it('never returns a NaN, zero or infinite number for input it accepts', () => {
    const hooks = [undefined, 0.6, 2, 3.5, 9, 25];
    const extras: Partial<GaugeSpec>[] = [
      {},
      { swatch: { sts: 0.001, rows: 9999, spanIn: 0.5 } },
      { c2cSwatch: { tiles: 1, spanIn: 30 } },
      { testBall: { maxSts: 6, circumferenceIn: 0.4 } },
      { carried: 12 },
      { yarnUnder: true },
      { lscCalibratedIn: 0.01 },
    ];
    for (const cyc of CYCS) {
      for (const technique of [...TECHNIQUES_2D, 'amigurumi_sc'] as const) {
        if (cyc === 0 && technique === 'amigurumi_sc') continue;
        for (const hookMm of hooks) {
          for (const extra of extras) expectFiniteGauge(resolveGauge({ cyc, technique, hookMm, ...extra }));
        }
      }
    }
  });

  it('ignores an invalid field it does not use', () => {
    // a broken C2C swatch left over in an sc project, a broken swatch in a C2C project
    expect(() => resolveGauge({ cyc: 4, technique: 'sc_graphgan', c2cSwatch: { tiles: 0, spanIn: Number.NaN } })).not.toThrow();
    expect(() => resolveGauge({ cyc: 4, technique: 'c2c', swatch: { sts: 0, rows: 0, spanIn: 0 } })).not.toThrow();
    expect(() => resolveGauge({ cyc: 4, technique: 'amigurumi_sc', swatch: { sts: -1, rows: 0, spanIn: 0 } })).not.toThrow();
    // carried strands matter only for tapestry without a swatch
    expect(() => resolveGauge({ cyc: 4, technique: 'sc_graphgan', carried: Number.NaN })).not.toThrow();
    expect(() => resolveGauge({ cyc: 4, technique: 'sc_tapestry', carried: Number.NaN, swatch: { sts: 14, rows: 12, spanIn: 4 } })).not.toThrow();
    expect(checkGauge({ cyc: 4, technique: 'sc_tapestry', carried: Number.NaN, swatch: { sts: 14, rows: 12, spanIn: 4 } })).toEqual([]);
  });
});

describe('checkGauge — sanity warnings on a measured gauge (§2.2.5, research 01 §7)', () => {
  const codes = (g: GaugeSpec): string[] => checkGauge(g).map((i) => i.code);

  it('says nothing about the defaults or about a plausible measurement', () => {
    for (const cyc of CYCS) {
      for (const technique of TECHNIQUES_2D) expect(checkGauge({ cyc, technique })).toEqual([]);
      if (cyc !== 0) expect(checkGauge({ cyc, technique: 'amigurumi_sc' })).toEqual([]);
    }
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 14, rows: 17, spanIn: 4 } })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', hookMm: 6, lscCalibratedIn: 2.1 })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'sc_tapestry', swatch: { sts: 12.5, rows: 11, spanIn: 4 } })).toEqual([]);
    expect(checkGauge({ cyc: 3, technique: 'mosaic_overlay', swatch: { sts: 19, rows: 24, spanIn: cmToIn(10) } })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 6, spanIn: 4 } })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 42, circumferenceIn: 8.64 } })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', lscCalibratedIn: 1.5 })).toEqual([]);
  });

  it('a table gauge entered as a measurement raises nothing, for every weight and technique', () => {
    for (const cyc of CYCS) {
      for (const technique of ['sc_graphgan', 'sc_tapestry', 'sc_tapestry_round', 'hdc_graphgan', 'mosaic_overlay'] as const) {
        const c = defaultCell(cyc, technique);
        const issues = checkGauge({ cyc, technique, swatch: { sts: 4 / c.w, rows: 4 / c.h, spanIn: 4 } });
        // Jumbo's Table A gauge is 4 sts × 4.2 rows: w/h = 1.05, inside 0.75–1.5 and rows > sts
        expect(issues).toEqual([]);
      }
      expect(checkGauge({ cyc, technique: 'c2c', c2cSwatch: { tiles: 4 / defaultCell(cyc, 'c2c').w, spanIn: 4 } })).toEqual([]);
      if (cyc !== 0) {
        const w = defaultCell(cyc, 'amigurumi_sc').w * 1.05;
        expect(checkGauge({ cyc, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 36 * w } })).toEqual([]);
      }
    }
  });

  it('W_GAUGE_RANGE: a count more than 35% outside the CYC range (worsted 11–14 sc ⇒ 7.15–18.9)', () => {
    const at = (sts: number): string[] => codes({ cyc: 4, technique: 'sc_graphgan', swatch: { sts, rows: sts * 1.18, spanIn: 4 } });
    expect(at(7.2)).toEqual([]);
    expect(at(7.1)).toEqual(['W_GAUGE_RANGE']);
    expect(at(18.8)).toEqual([]);
    expect(at(19.0)).toEqual(['W_GAUGE_RANGE']);
    // rows have no CYC range of their own: the stitch range is carried over at the table aspect (16 / 13.5),
    // 13.04–16.59 rows ⇒ 8.47–22.4 with the ±35%
    const rowsAt = (rows: number): string[] => codes({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 15, rows, spanIn: 4 } });
    expect(rowsAt(22.3)).toEqual([]);
    expect(rowsAt(22.5)).toEqual(['W_GAUGE_RANGE']);
  });

  it('W_GAUGE_RANGE has no lower limit for Jumbo (CYC says "≤ 6") and uses the dc range for Lace', () => {
    expect(codes({ cyc: 7, technique: 'sc_graphgan', swatch: { sts: 1, rows: 1.1, spanIn: 4 } })).toEqual([]);
    expect(codes({ cyc: 7, technique: 'sc_graphgan', swatch: { sts: 8, rows: 8.5, spanIn: 4 } })).toEqual([]); // ≤ 6 × 1.35 = 8.1
    expect(codes({ cyc: 7, technique: 'sc_graphgan', swatch: { sts: 8.2, rows: 8.5, spanIn: 4 } })).toEqual(['W_GAUGE_RANGE']);
    // Lace: 32–42 ⇒ 20.8–56.7
    expect(codes({ cyc: 0, technique: 'sc_graphgan', swatch: { sts: 21, rows: 25, spanIn: 4 } })).toEqual([]);
    expect(codes({ cyc: 0, technique: 'sc_graphgan', swatch: { sts: 20.5, rows: 25, spanIn: 4 } })).toEqual(['W_GAUGE_RANGE']);
  });

  it('W_GAUGE_RANGE recognises centimetres entered as inches', () => {
    // 13 sts and 16 rows over 10 cm, typed as 10 in ⇒ 5.2 sts and 6.4 rows per 4 in
    const issues = checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13, rows: 16, spanIn: 10 } });
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('W_GAUGE_RANGE');
    expect(issues[0].severity).toBe('warn');
    expect(issues[0].field).toBe('swatch');
    expect(issues[0].hint).toBe('cm-as-inches');
    expect(issues[0].message).toBe(
      'This swatch has 5.2 sts (usually 11–14) and 6.4 rows (usually 13–16.6) per 4 in, more than 35% outside the usual range for Medium (worsted) yarn. The numbers fit a measurement in centimetres: was the length entered in cm but read as inches?',
    );
    // the same slip in every weight that has a lower limit, and with the span corrected the warning is gone
    for (const cyc of [0, 1, 2, 3, 4, 5, 6] as const) {
      const c = defaultCell(cyc, 'sc_graphgan');
      const sts = 10 / 2.54 / c.w;
      const rows = 10 / 2.54 / c.h;
      const wrong = checkGauge({ cyc, technique: 'sc_graphgan', swatch: { sts, rows, spanIn: 10 } });
      expect(wrong.map((i) => [i.code, i.hint])).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
      expect(checkGauge({ cyc, technique: 'sc_graphgan', swatch: { sts, rows, spanIn: cmToIn(10) } })).toEqual([]);
    }
  });

  it('W_GAUGE_RANGE recognises inches converted as centimetres', () => {
    for (const cyc of CYCS) {
      const c = defaultCell(cyc, 'sc_graphgan');
      const issues = checkGauge({ cyc, technique: 'sc_graphgan', swatch: { sts: 4 / c.w, rows: 4 / c.h, spanIn: cmToIn(4) } });
      expect(issues.map((i) => [i.code, i.hint])).toEqual([['W_GAUGE_RANGE', 'inches-as-cm']]);
    }
    const issues = checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13.5, rows: 16, spanIn: cmToIn(4) } });
    expect(issues[0].message).toContain('34.3 sts (usually 11–14) and 40.6 rows (usually 13–16.6)');
    expect(issues[0].message).toContain('was the length entered in inches but read as centimetres?');
  });

  it('a double crochet swatch entered as sc (UK "dc" = US sc) trips all three warnings', () => {
    // worsted dc: about 12.7 sts and 7.6 rows per 4 in (rows 2.1× taller)
    const issues = checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 12.7, rows: 7.6, spanIn: 4 } });
    expect(issues.map((i) => i.code)).toEqual(['W_GAUGE_RANGE', 'W_GAUGE_ASPECT', 'W_GAUGE_ROWS']);
    const [range, aspect, rows] = issues;
    expect(range.hint).toBeUndefined();
    expect(range.message).toBe(
      'This swatch has 7.6 rows (usually 13–16.6) per 4 in, more than 35% outside the usual range for Medium (worsted) yarn. Check the unit (cm entered as inches?), the stitch names (in UK patterns "dc" means US sc), the hook, and that it was worked in this technique.',
    );
    expect(aspect.hint).toBe('taller-stitch');
    expect(aspect.message).toContain('this swatch gives 0.60');
    expect(aspect.message).toContain('in UK patterns "dc" means US sc');
    expect(rows.hint).toBe('tapestry-or-novelty');
    for (const i of issues) {
      expect(i.severity).toBe('warn');
      expect(i.field).toBe('swatch');
    }
  });

  it('W_GAUGE_ASPECT: flat sc w/h outside 0.75–1.5, limits included in the plausible range', () => {
    expect(SC_ASPECT_RANGE).toEqual([0.75, 1.5]);
    // w/h = rows / sts
    expect(codes({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 12, rows: 18, spanIn: 4 } })).toEqual([]); // 1.5
    expect(codes({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 12, rows: 18.2, spanIn: 4 } })).toEqual(['W_GAUGE_ASPECT']);
    const high = checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13, rows: 21, spanIn: 4 } });
    expect(high.map((i) => i.code)).toEqual(['W_GAUGE_ASPECT']);
    expect(high[0].hint).toBeUndefined();
    expect(high[0].message).toBe(
      'Single crochet stitches are usually 0.75 to 1.5 times as wide as tall; this swatch gives 1.62. Check both counts, and that stitches and rows were counted over the same length.',
    );
    expect(codes({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 16, rows: 12, spanIn: 4 } })).toEqual(['W_GAUGE_ROWS']); // 0.75
    expect(codes({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 16, rows: 11.9, spanIn: 4 } })).toEqual(['W_GAUGE_ASPECT', 'W_GAUGE_ROWS']);
  });

  it('W_GAUGE_ROWS: fewer rows than stitches for flat sc (novelty yarn or tapestry)', () => {
    // an hdc swatch entered as sc: 12.9 sts × 10.7 rows — in range, aspect 0.83, but rows < sts
    const issues = checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 12.9, rows: 10.7, spanIn: 4 } });
    expect(issues.map((i) => i.code)).toEqual(['W_GAUGE_ROWS']);
    expect(issues[0].hint).toBe('tapestry-or-novelty');
    expect(issues[0].message).toContain('10.7 rows, 12.9 sts');
    // equal counts are not "fewer"
    expect(codes({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13, rows: 13, spanIn: 4 } })).toEqual([]);
    expect(codes({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13, rows: 12.9, spanIn: 4 } })).toEqual(['W_GAUGE_ROWS']);
  });

  it('the flat-sc rules do not apply to techniques whose stitches are meant to be taller or flatter', () => {
    // tapestry is taller than wide by design (w/h 0.88, and 0.74 here)
    expect(codes({ cyc: 4, technique: 'sc_tapestry', swatch: { sts: 13.5, rows: 11.9, spanIn: 4 } })).toEqual([]);
    expect(codes({ cyc: 4, technique: 'sc_tapestry_round', swatch: { sts: 13.5, rows: 10, spanIn: 4 } })).toEqual([]);
    // overlay mosaic reaches w/h 1.5: LillaBjörn's Nya Infinity, 20 sts and 30 rows = 10 × 10 cm in fingering cotton
    expect(codes({ cyc: 1, technique: 'mosaic_overlay', swatch: { sts: 20, rows: 30, spanIn: cmToIn(10) } })).toEqual([]);
    expect(codes({ cyc: 1, technique: 'mosaic_overlay', swatch: { sts: 20, rows: 33, spanIn: cmToIn(10) } })).toEqual([]);
    // hdc: w/h 0.73
    expect(codes({ cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 13, rows: 9.5, spanIn: 4 } })).toEqual([]);
  });

  it('the expected counts follow the technique: an sc gauge entered for hdc has too many rows only at the extreme', () => {
    // hdc worsted: 12.86 sts × 10.67 rows; rows usual 8.7–11.1 ⇒ accepted 5.65–14.9
    expect(codes({ cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 12.9, rows: 14.8, spanIn: 4 } })).toEqual([]);
    expect(codes({ cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 12.9, rows: 15.2, spanIn: 4 } })).toEqual(['W_GAUGE_RANGE']);
  });

  it('the expected counts follow the hook: tight sc on a 3.5 mm hook is plausible only when the hook says so', () => {
    const swatch = { sts: 20, rows: 22, spanIn: 4 };
    expect(codes({ cyc: 4, technique: 'sc_graphgan', swatch })).toEqual(['W_GAUGE_RANGE']); // > 18.9 at 5 mm
    expect(codes({ cyc: 4, technique: 'sc_graphgan', swatch, hookMm: 3.5 })).toEqual([]); // 14 × 1.35 / 0.7653 = 24.7
  });

  it('C2C swatch: tiles per 4 in against the range scaled by the tile (worsted 4.2–5.4 ⇒ 2.75–7.27)', () => {
    const at = (tiles: number): { code: string; hint?: string }[] =>
      checkGauge({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles, spanIn: 4 } }).map((i) => ({ code: i.code, hint: i.hint }));
    expect(at(2.8)).toEqual([]);
    expect(at(7.2)).toEqual([]);
    expect(at(7.4)).toEqual([{ code: 'W_GAUGE_RANGE', hint: undefined }]);
    // 5 tiles over 10 cm typed as 10 in ⇒ 2 tiles per 4 in
    const cm = checkGauge({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 5, spanIn: 10 } });
    expect(cm.map((i) => [i.code, i.field, i.hint])).toEqual([['W_GAUGE_RANGE', 'c2cSwatch', 'cm-as-inches']]);
    expect(cm[0].message).toContain('This C2C swatch has 2 tiles (usually 4.2–5.4) per 4 in');
  });

  it('test ball: stitches per 4 in of circumference against the stuffed Table E width', () => {
    // worsted: 4 / (0.195 × 1.05) = 19.5 per 4 in; usual 15.9–20.3 ⇒ accepted 10.3–27.4
    expect(codes({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 7.371 } })).toEqual([]);
    expect(codes({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 13.5 } })).toEqual([]); // 10.7
    expect(codes({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 14.2 } })).toEqual(['W_GAUGE_RANGE']); // 10.1
    expect(codes({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 5.2 } })).toEqual(['W_GAUGE_RANGE']); // 27.7
    // a 21.9 cm circumference typed as inches
    const cm = checkGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 42, circumferenceIn: 21.9 } });
    expect(cm.map((i) => [i.code, i.field, i.hint])).toEqual([['W_GAUGE_RANGE', 'testBall', 'cm-as-inches']]);
    expect(cm[0].message).toContain('This test ball has 7.7 sts (usually 15.9–20.3) per 4 in');
  });

  it('W_GAUGE_LSC: a calibrated yarn per stitch more than 35% from the model, with the likely slip', () => {
    expect(LSC_SLACK).toBe(0.35);
    const at = (lscCalibratedIn: number): { code: string; hint?: string }[] =>
      checkGauge({ cyc: 4, technique: 'sc_graphgan', lscCalibratedIn }).map((i) => ({ code: i.code, hint: i.hint }));
    // model 1.926 in ⇒ accepted 1.25–2.60
    expect(at(1.8)).toEqual([]);
    expect(at(1.26)).toEqual([]);
    expect(at(2.59)).toEqual([]);
    expect(at(1.2)).toEqual([{ code: 'W_GAUGE_LSC', hint: undefined }]);
    expect(at(3.0)).toEqual([{ code: 'W_GAUGE_LSC', hint: undefined }]);
    expect(at(1.8 * 2.54)).toEqual([{ code: 'W_GAUGE_LSC', hint: 'cm-as-inches' }]); // 4.57 cm read as inches
    expect(at(1.8 / 2.54)).toEqual([{ code: 'W_GAUGE_LSC', hint: 'inches-as-cm' }]);
    expect(at(18)).toEqual([{ code: 'W_GAUGE_LSC', hint: 'ten-stitches' }]); // the yarn of all 10 stitches
    const issue = checkGauge({ cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 18 })[0];
    expect(issue.field).toBe('lscCalibratedIn');
    expect(issue.severity).toBe('warn');
    expect(issue.message).toBe(
      'The calibrated yarn per stitch, 18.00 in, is more than 35% away from the 1.93 in expected for this yarn and hook. It fits the yarn of all 10 stitches: divide the measured length by the number of stitches unravelled.',
    );
    // amigurumi compares with L_ami (1.474 in for worsted), an sc swatch with 6.5 × its measured width
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', lscCalibratedIn: 1.0 })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', lscCalibratedIn: 0.9 }).map((i) => i.code)).toEqual(['W_GAUGE_LSC']);
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 10, rows: 12, spanIn: 4 }, lscCalibratedIn: 2.6 })).toEqual([]);
  });

  it('returns only errors when the input is invalid', () => {
    const issues = checkGauge({ cyc: 4, technique: 'sc_graphgan', hookMm: -1, swatch: { sts: 13, rows: 16, spanIn: 10 } });
    expect(issues.map((i) => i.code)).toEqual(['E_GAUGE_INPUT']);
  });

  it('resolveGaugeChecked: the findings and, unless one is an error, the gauge — without throwing', () => {
    const ok = resolveGaugeChecked({ cyc: 4, technique: 'sc_graphgan' });
    expect(ok.issues).toEqual([]);
    expect(ok.gauge).toEqual(resolveGauge({ cyc: 4, technique: 'sc_graphgan' }));
    // a warning does not stop the gauge: the measurement still wins
    const warned = resolveGaugeChecked({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13, rows: 16, spanIn: 10 } });
    expect(warned.issues.map((i) => i.code)).toEqual(['W_GAUGE_RANGE']);
    expect(warned.gauge?.source).toBe('swatch');
    expect(warned.gauge?.cell.w).toBeCloseTo(10 / 13, 14);
    // an error does
    const bad = resolveGaugeChecked({ cyc: 0, technique: 'amigurumi_sc' });
    expect(bad.gauge).toBeUndefined();
    expect(bad.issues.map((i) => i.code)).toEqual(['E_GAUGE_INPUT']);
    expect(resolveGaugeChecked(null as unknown as GaugeSpec).gauge).toBeUndefined();
  });

  it('is deterministic: the same spec gives the same findings, text included', () => {
    const spec: GaugeSpec = { cyc: 4, technique: 'sc_graphgan', swatch: { sts: 12.7, rows: 7.6, spanIn: 4 }, lscCalibratedIn: 18 };
    expect(checkGauge(spec)).toEqual(checkGauge(spec));
    expect(checkGauge(spec).map((i) => i.code)).toEqual(['W_GAUGE_RANGE', 'W_GAUGE_ASPECT', 'W_GAUGE_ROWS', 'W_GAUGE_LSC']);
  });
});

describe('reading a resolved gauge', () => {
  it('sizeBand: nominal × (1 ± tol) (§2.2.5; research 01 §7 "40 in → 36 to 45 in")', () => {
    const band = sizeBand(40, 0.12);
    expect(band.low).toBeCloseTo(35.2, 12);
    expect(band.high).toBeCloseTo(44.8, 12);
    expect(sizeBand(40, 0.04)).toEqual({ low: 40 * 0.96, high: 40 * 1.04 });
    expect(sizeBand(0, 0.12)).toEqual({ low: 0, high: 0 });
    expect(sizeBand(40, 0)).toEqual({ low: 40, high: 40 });
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => sizeBand(bad, 0.1)).toThrow(RangeError);
    for (const bad of [-0.1, 1, 1.5, Number.NaN]) expect(() => sizeBand(40, bad)).toThrow(RangeError);
  });

  it('a measured gauge has the narrower band', () => {
    const def = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const measured = resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13.5, rows: 16, spanIn: 4 } });
    const a = sizeBand(40, def.tol);
    const b = sizeBand(40, measured.tol);
    expect(b.high - b.low).toBeLessThan(a.high - a.low);
    expect(b.high - b.low).toBeCloseTo(3.2, 12);
    expect(a.high - a.low).toBeCloseTo(9.6, 12);
  });

  it('hookSizeRange: the size for p = 0.5 … 1.0 around the p = 0.75 nominal (§2.2.2)', () => {
    // 6 mm instead of 5 mm: 1.2^0.5 = 1.095445, 1.2^0.75 = 1.146531, 1.2^1 = 1.2
    const up = hookSizeRange(40, 6, 5);
    expect(up.low).toBeCloseTo((40 * 1.095445) / 1.146531, 4);
    expect(up.high).toBeCloseTo((40 * 1.2) / 1.146531, 4);
    // 3.5 mm instead of 5 mm: 0.7, 0.765286, 0.836660 — the order flips below the reference hook
    const down = hookSizeRange(40, 3.5, 5);
    expect(down.low).toBeCloseTo((40 * 0.7) / 0.765286, 4);
    expect(down.high).toBeCloseTo((40 * 0.83666) / 0.765286, 4);
    for (const r of [up, down]) {
      expect(r.low).toBeLessThan(40);
      expect(r.high).toBeGreaterThan(40);
    }
    // no override, no extra uncertainty
    expect(hookSizeRange(40, 5, 5)).toEqual({ low: 40, high: 40 });
    expect(() => hookSizeRange(40, 0, 5)).toThrow(RangeError);
    expect(() => hookSizeRange(-1, 5, 5)).toThrow(RangeError);
  });

  it('stuffingStretch and stuffedCell: s = gauge.stretch for firm or medium, 1 for light or none (§2.2.3, §2.10.5)', () => {
    const g = resolveGauge({ cyc: 4, technique: 'amigurumi_sc' });
    expect(stuffingStretch(g, 'firm')).toBe(1.05);
    expect(stuffingStretch(g, 'medium')).toBe(1.05);
    expect(stuffingStretch(g, 'light')).toBe(1);
    expect(stuffingStretch(g, 'none')).toBe(1);
    // wS = 0.195 × 1.05 = 0.20475; 12 · wS = 2.46 in (§2.10.1); light: wS 0.195, hS 0.186 (§2.10.5)
    const firm = stuffedCell(g, 'firm');
    expect(firm.wS).toBeCloseTo(0.20475, 12);
    expect(firm.hS).toBeCloseTo(0.195, 12);
    expect(12 * firm.wS).toBeCloseTo(2.46, 2);
    const light = stuffedCell(g, 'light');
    expect(light.wS).toBe(0.195);
    expect(light.hS).toBeCloseTo(0.186, 3);
    // stretch is isotropic: the aspect does not change
    expect(firm.wS / firm.hS).toBeCloseTo(light.wS / light.hS, 12);
    // a test ball measured the stuffed fabric: no second stretch
    const ball = resolveGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 7.371 } });
    for (const s of ['firm', 'medium', 'light', 'none'] as const) expect(stuffingStretch(ball, s)).toBe(1);
    expect(stuffedCell(ball, 'firm').wS).toBeCloseTo(0.20475, 12);
  });

  it('countsPer4In: the gauge as it is stated', () => {
    const g = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const c = countsPer4In(g.cell);
    expect(c.sts4).toBeCloseTo(13.5, 12);
    expect(c.rows4).toBeCloseTo(16, 12);
    expect(countsPer4In(resolveGauge({ cyc: 4, technique: 'c2c' }).cell).sts4).toBeCloseTo(13.5 / 2.6, 12);
    // amigurumi worsted: 20.5 sts × 21.5 rnds per 4 in (research 01 §3.7)
    const ami = countsPer4In(resolveGauge({ cyc: 4, technique: 'amigurumi_sc' }).cell);
    expect(ami.sts4).toBeCloseTo(20.5, 1);
    expect(ami.rows4).toBeCloseTo(21.5, 1);
    expect(() => countsPer4In({ w: 0, h: 1 })).toThrow(RangeError);
    expect(() => countsPer4In({ w: 1e-320, h: 1 })).toThrow(RangeError);
  });

  it('yardageBandFor: ±25% (2D) or ±20% (3D) by default, ±10% measured, ±5% calibrated (§2.8)', () => {
    expect(yardageBandFor({ cyc: 4, technique: 'sc_graphgan' })).toBe(0.25);
    expect(yardageBandFor({ cyc: 4, technique: 'c2c' })).toBe(0.25);
    expect(yardageBandFor({ cyc: 4, technique: 'amigurumi_sc' })).toBe(0.2);
    expect(yardageBandFor({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 13, rows: 16, spanIn: 4 } })).toBe(0.1);
    expect(yardageBandFor({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 6, spanIn: 4 } })).toBe(0.1);
    expect(yardageBandFor({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 7.4 } })).toBe(0.1);
    // a measurement of another technique family does not count
    expect(yardageBandFor({ cyc: 4, technique: 'c2c', swatch: { sts: 13, rows: 16, spanIn: 4 } })).toBe(0.25);
    expect(yardageBandFor({ cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 1.8 })).toBe(0.05);
    expect(yardageBandFor({ cyc: 4, technique: 'amigurumi_sc', lscCalibratedIn: 1.5 })).toBe(0.05);
    expect(yardageBandFor({ cyc: 4, technique: 'amigurumi_sc', lscCalibratedIn: 1.5, testBall: { maxSts: 36, circumferenceIn: 7.4 } })).toBe(0.05);
  });
});
