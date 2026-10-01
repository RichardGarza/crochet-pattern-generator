import { describe, expect, it } from 'vitest';
import type { GaugeSpec, ResolvedGauge, Technique2D, TechniqueId } from '../../../types/gauge';
import type { Cyc } from '../../../types/units';
import {
  CARRIED_LIMIT,
  HOOK_LIMITS_MM,
  LSC_LIMITS_IN,
  STITCH_LIMITS_IN,
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

/** A sweep over thousands of specs (about 0.5 s alone): a generous timeout, because other runs share the machine. */
const SWEEP_TIMEOUT_MS = 30_000;

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

  it('consistency: defaultHookMm and defaultCell agree with what resolveGauge returns', () => {
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
    expect(() => swatchFromSize(null as unknown as { sts: number; rows: number; widthIn: number; heightIn: number })).toThrow(RangeError);
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

  it('an sc_graphgan swatch with a hook override: the swatch sets cell, wSc, hSc and L_sc; the hook is only reported', () => {
    const swatch = { sts: 15, rows: 18, spanIn: 4 };
    const plain = resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch });
    const hooked = resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch, hookMm: 4 });
    expect(hooked).toEqual({ ...plain, hookMm: 4 });
    expect(hooked.wSc).toBeCloseTo(4 / 15, 14);
    expect(hooked.hSc).toBeCloseTo(4 / 18, 14);
    expect(hooked.lscIn).toBeCloseTo((6.5 * 4) / 15, 12);
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
    ['a hook thinner than 0.1 mm', { cyc: 4, technique: 'sc_graphgan', hookMm: 0.05 }],
    ['a hook thicker than 100 mm', { cyc: 4, technique: 'amigurumi_sc', hookMm: 150 }],
    ['a denormal hook', { cyc: 4, technique: 'amigurumi_sc', hookMm: 5e-324 }],
    ['a hook given as text', { cyc: 4, technique: 'sc_graphgan', hookMm: '5' as unknown as number }],
    ['yarn under given as text', { cyc: 4, technique: 'amigurumi_sc', yarnUnder: 'false' as unknown as boolean }],
    ['a swatch that is not an object', { cyc: 4, technique: 'sc_graphgan', swatch: 13 as unknown as NonNullable<GaugeSpec['swatch']> }],
    ['a swatch whose stitch is 500 in wide', { cyc: 4, technique: 'sc_graphgan', swatch: { sts: 0.001, rows: 1, spanIn: 0.5 } }],
    ['a swatch over 1e308 in', { cyc: 4, technique: 'sc_graphgan', swatch: { sts: 1, rows: 1, spanIn: 1e308 } }],
    ['more than 100 carried strands', { cyc: 4, technique: 'sc_tapestry', carried: 101 }],
    ['a calibrated yarn per stitch of 2000 in', { cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 2000 }],
    ['a calibrated yarn per stitch of 0.00001 in', { cyc: 4, technique: 'amigurumi_sc', lscCalibratedIn: 1e-5 }],
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
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', yarnUnder: 1 as unknown as boolean }).map((i) => i.field)).toEqual(['yarnUnder']);
  });

  it('does not check a field the technique does not read: a leftover yarnUnder in a 2D spec', () => {
    // only amigurumi reads yarnUnder (like `carried`, read only by tapestry without a swatch)
    for (const technique of TECHNIQUES_2D) {
      const spec = { cyc: 4, technique, yarnUnder: 'x' as unknown as boolean } as GaugeSpec;
      expect(resolveGauge(spec)).toEqual(resolveGauge({ cyc: 4, technique }));
      expect(checkGauge(spec)).toEqual([]);
    }
  });

  it('CYC 0 is fine for every 2D technique', () => {
    for (const technique of TECHNIQUES_2D) expect(() => resolveGauge({ cyc: 0, technique })).not.toThrow();
  });

  it('pins the limits of what it accepts', () => {
    expect(HOOK_LIMITS_MM).toEqual([0.1, 100]);
    expect(STITCH_LIMITS_IN).toEqual([0.001, 100]);
    expect(LSC_LIMITS_IN).toEqual([0.001, 1000]);
    expect(CARRIED_LIMIT).toBe(100);
    for (const hookMm of [0.1, 100]) expect(() => resolveGauge({ cyc: 4, technique: 'sc_graphgan', hookMm })).not.toThrow();
    for (const hookMm of [0.0999, 100.01]) expect(() => resolveGauge({ cyc: 4, technique: 'sc_graphgan', hookMm })).toThrow(RangeError);
    // a stitch exactly 100 in wide and one exactly 0.001 in tall
    expect(() => resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 1, rows: 100000, spanIn: 100 } })).not.toThrow();
    expect(() => resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 1, rows: 100000, spanIn: 100.1 } })).toThrow(/not a size a stitch can have/);
    expect(() => resolveGauge({ cyc: 4, technique: 'sc_tapestry', carried: 100 })).not.toThrow();
  });

  it('never returns a NaN, zero or infinite number for a spec it accepts, and never accepts one it cannot size', () => {
    const hooks = [undefined, 0.1, 0.6, 2, 3.5, 9, 25, 100, 5e-324, 1e-9, 1e9, Number.MAX_VALUE];
    const extras: Partial<GaugeSpec>[] = [
      {},
      { swatch: { sts: 0.1, rows: 400, spanIn: 0.5 } },
      { swatch: { sts: 1, rows: 1, spanIn: 1e308 } },
      { swatch: { sts: 1e-320, rows: 1, spanIn: 1 } },
      { swatch: { sts: 1e300, rows: 1e300, spanIn: 1e-300 } },
      { c2cSwatch: { tiles: 1, spanIn: 30 } },
      { c2cSwatch: { tiles: 1e-320, spanIn: 1 } },
      { testBall: { maxSts: 6, circumferenceIn: 0.4 } },
      { testBall: { maxSts: 1e300, circumferenceIn: 1e-300 } },
      { carried: 12 },
      { carried: 1e308 },
      { yarnUnder: true },
      { lscCalibratedIn: 0.01 },
      { lscCalibratedIn: 1e308 },
      { lscCalibratedIn: 5e-324 },
    ];
    let accepted = 0;
    let rejected = 0;
    for (const cyc of CYCS) {
      for (const technique of [...TECHNIQUES_2D, 'amigurumi_sc'] as const) {
        for (const hookMm of hooks) {
          for (const extra of extras) {
            const spec: GaugeSpec = { cyc, technique, hookMm, ...extra };
            // the three entry points agree on what is valid
            const errors = checkGauge(spec).filter((i) => i.severity === 'error');
            const checked = resolveGaugeChecked(spec);
            if (errors.length > 0) {
              expect(() => resolveGauge(spec)).toThrow(RangeError);
              expect(() => yardageBandFor(spec)).toThrow(RangeError);
              expect(checked.gauge).toBeUndefined();
              rejected++;
            } else {
              const g = resolveGauge(spec);
              expectFiniteGauge(g);
              expect(checked.gauge).toEqual(g);
              expect(yardageBandFor(spec)).toBeGreaterThan(0);
              accepted++;
            }
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(1000);
  }, SWEEP_TIMEOUT_MS);

  it('answers a broken value with a RangeError that says what it got, never a TypeError', () => {
    expect(() => resolveGauge({ cyc: '4' as unknown as Cyc, technique: 'sc_graphgan' })).toThrow(
      'resolveGauge: The yarn weight must be a CYC number 0–7, got "4" (text).',
    );
    expect(() => resolveGauge({ cyc: 4, technique: 'sc_graphgan', hookMm: '5' as unknown as number })).toThrow(
      'resolveGauge: The hook must be a size in mm between 0.1 and 100, got "5" (text).',
    );
    expect(() => resolveGauge({ cyc: 4, technique: 'amigurumi_sc', yarnUnder: 'false' as unknown as boolean })).toThrow(
      'resolveGauge: Yarn under must be true or false, got "false" (text).',
    );
    // values without a string form do not break the message
    const bare = Object.create(null) as unknown;
    expect(checkGauge({ cyc: bare as Cyc, technique: bare as TechniqueId }).map((i) => i.field)).toEqual(['cyc', 'technique']);
    expect(checkGauge({ cyc: Symbol('x') as unknown as Cyc, technique: 'c2c' }).map((i) => i.code)).toEqual(['E_GAUGE_INPUT']);
    for (const junk of [null, undefined, 4, 'worsted', [], () => 1]) {
      expect(() => resolveGauge(junk as unknown as GaugeSpec)).toThrow(RangeError);
      expect(checkGauge(junk as unknown as GaugeSpec).every((i) => i.code === 'E_GAUGE_INPUT')).toBe(true);
      expect(resolveGaugeChecked(junk as unknown as GaugeSpec).gauge).toBeUndefined();
      expect(() => yardageBandFor(junk as unknown as GaugeSpec)).toThrow(RangeError);
      expect(measurementOf(junk as unknown as GaugeSpec)).toBeUndefined();
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
    expect(() => resolveGauge({ cyc: 4, technique: 'c2c', carried: -5 })).not.toThrow();
    // defaultCell reads `carried` for tapestry only, and options may be null
    expect(defaultCell(4, 'c2c', { carried: Number.NaN })).toEqual(defaultCell(4, 'c2c'));
    expect(() => defaultCell(4, 'sc_tapestry', { carried: Number.NaN })).toThrow(RangeError);
    expect(() => defaultCell(4, 'sc_tapestry', { carried: -1 })).toThrow(RangeError);
    expect(defaultCell(4, 'sc_graphgan', null as unknown as undefined)).toEqual(defaultCell(4, 'sc_graphgan'));
    expect(defaultCell(4, 'amigurumi_sc', null as unknown as undefined)).toEqual(defaultCell(4, 'amigurumi_sc'));
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
    // a missing or unknown stuffing is an error, never a silent "unstuffed"
    for (const bad of [undefined, null, 'stuffed', 'FIRM', 'constructor', 1]) {
      expect(() => stuffingStretch(g, bad as unknown as 'firm')).toThrow(RangeError);
      expect(() => stuffedCell(g, bad as unknown as 'firm')).toThrow(RangeError);
    }
    expect(() => stuffingStretch(null as unknown as ResolvedGauge, 'firm')).toThrow(RangeError);
    expect(() => stuffingStretch({ stretch: Number.NaN }, 'firm')).toThrow(RangeError);
    expect(() => stuffedCell({ stretch: 1.05, cell: { w: 0, h: 1 } }, 'firm')).toThrow(RangeError);
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
    expect(() => countsPer4In(null as unknown as { w: number; h: number })).toThrow(RangeError);
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
    // a spec resolveGauge rejects has no band: a NaN calibration is not a calibration, a swatch of zeros is not a swatch
    expect(() => yardageBandFor({ cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: Number.NaN })).toThrow(RangeError);
    expect(() => yardageBandFor({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 0, rows: 0, spanIn: 0 } })).toThrow(RangeError);
    expect(() => yardageBandFor({ cyc: 4, technique: 'tss' as TechniqueId })).toThrow(RangeError);
  });

  it('the calibrated band cannot be read off a ResolvedGauge: it does not record the calibration', () => {
    // the gap behind request 1 of docs/tracks/s0b-gauge.md
    const spec: GaugeSpec = { cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 1.8 };
    const resolved = resolveGauge(spec);
    expect(resolved.source).toBe('default');
    expect(yardageBandFor(spec)).toBe(0.05);
    expect(Object.keys(resolved)).not.toContain('lscCalibrated');
  });
});
