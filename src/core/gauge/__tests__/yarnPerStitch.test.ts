import { describe, expect, it } from 'vitest';
import type { Technique2D, TechniqueId } from '../../../types/gauge';
import type { Cyc } from '../../../types/units';
import { resolveGauge } from '../resolve';
import { sphereSizing } from '../sphere';
import {
  C2C_TILE_YARN_MULT,
  CALIBRATION_STITCHES,
  CARRIED_PER_WIDTH,
  DEC_EXTRA_YARN_MULT,
  EMBROIDERY_IN,
  IN_PER_YD,
  JOINED_ROUND_YARN_MULT,
  K_SC,
  MAGIC_RING_IN,
  MANY_STRANDS,
  MULT,
  M_PER_YD,
  TAIL_IN,
  TAPESTRY_WORKED_MULT,
  YARDAGE_BAND,
  YARDAGE_BUFFER,
  YARN_PER_STITCH_TOL,
  c2cTileYarnIn,
  carriedYarnIn,
  gramsFor,
  inchesToYards,
  lAmi,
  lSc,
  lscFromUnravel,
  skeinsToBuy,
  stitchYarnIn,
  tailsIn,
  yardRange,
  yardageBand,
  yardageBuffer,
  yardsToMeters,
  yarnPerCellIn,
  yarnPerStitchDefaults,
} from '../yarnPerStitch';

const CYCS: readonly Cyc[] = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * §2.2.4 Table D as printed: default yarn per stitch in inches at the table's hooks —
 * cyc, sc, hdc, dc, C2C tile, amigurumi sc (`L_ami`, Table E hook; "—" for CYC 0).
 */
const PRINTED_TABLE_D: readonly [Cyc, number, number, number, number, number | undefined][] = [
  [0, 0.76, 1.11, 1.53, 5.93, undefined],
  [1, 1.08, 1.57, 2.17, 8.41, 0.85],
  [2, 1.44, 2.09, 2.89, 11.21, 1.02],
  [3, 1.62, 2.36, 3.25, 12.61, 1.23],
  [4, 1.93, 2.79, 3.85, 14.95, 1.47],
  [5, 2.48, 3.59, 4.95, 19.22, 1.88],
  [6, 3.47, 5.03, 6.93, 26.9, 2.79],
  [7, 6.5, 9.42, 13.0, 50.44, 4.43],
];

/** Worsted `L_sc = 6.5 · 4 / 13.5 = 1.925926 in`, worked by hand (§2.8: 1.926). */
const L_WORSTED = 1.925926;

describe('the per-stitch model (§2.2.4)', () => {
  it('L_sc = 6.5 · w_sc', () => {
    expect(K_SC).toBe(6.5);
    expect(lSc(4 / 13.5)).toBeCloseTo(L_WORSTED, 6);
    expect(lSc(4 / 13.5)).toBeCloseTo(1.926, 3); // §2.8 golden
    expect(lSc(1)).toBe(6.5);
    expect(lSc(0.25)).toBe(1.625);
  });

  it('MULT = { sc: 1, hdc: 1.45, dc: 2.0, ch: 0.42, slst: 0.5 }', () => {
    expect(MULT).toEqual({ sc: 1, hdc: 1.45, dc: 2.0, ch: 0.42, slst: 0.5 });
    expect(Object.isFrozen(MULT)).toBe(true);
    expect(stitchYarnIn(2, 'sc')).toBe(2);
    expect(stitchYarnIn(2, 'hdc')).toBe(2.9);
    expect(stitchYarnIn(2, 'dc')).toBe(4);
    expect(stitchYarnIn(2, 'ch')).toBe(0.84);
    expect(stitchYarnIn(2, 'slst')).toBe(1);
  });

  it('L_tile(C2C) = L_sc · (3·2.0 + 3·0.42 + 0.5) = 7.76 · L_sc', () => {
    expect(C2C_TILE_YARN_MULT).toBeCloseTo(7.76, 12);
    expect(c2cTileYarnIn(1)).toBeCloseTo(7.76, 12);
    expect(c2cTileYarnIn(2)).toBeCloseTo(3 * stitchYarnIn(2, 'dc') + 3 * stitchYarnIn(2, 'ch') + stitchYarnIn(2, 'slst'), 12);
  });

  it('G11: the worsted C2C tile is 7.76 × 1.926 = 14.95 in (§2.8)', () => {
    const tile = c2cTileYarnIn(lSc(4 / 13.5));
    expect(Math.abs(tile - 14.95)).toBeLessThanOrEqual(0.01);
    expect(tile).toBeCloseTo(14.945185, 5); // 7.76 × 1.925926
    expect(tile).toBe(yarnPerStitchDefaults(4).c2cTile);
    expect(tile).toBeCloseTo(c2cTileYarnIn(resolveGauge({ cyc: 4, technique: 'c2c' }).lscIn), 12);
  });

  it('L_ami = 6.5 · max(w_sc(CYC, hook), w_ami(CYC, hook)): worsted at 3.5 mm is 6.5 · 0.2267 = 1.47 in', () => {
    expect(lAmi(4)).toBeCloseTo(1.474, 3); // §2.8: L_ami = 1.474
    expect(lAmi(4)).toBeCloseTo(6.5 * 0.2267513, 6);
    expect(lAmi(4, 3.5)).toBe(lAmi(4));
    // v1.1's 6.5 · w_ami = 1.27 in would claim 14% less yarn than flat sc on the same hook
    expect(6.5 * 0.195).toBeCloseTo(1.27, 2);
    expect(1 - (6.5 * 0.195) / lAmi(4)).toBeCloseTo(0.14, 2);
    // DK on a 3.5 mm hook: 6.5 · 0.25 · 0.875^0.75 = 6.5 · 0.226176 = 1.47014 in (Trock measured 1.5 in)
    expect(lAmi(3, 3.5)).toBeCloseTo(1.47014, 5);
    expect(lAmi(3, 3.5).toFixed(2)).toBe('1.47');
    expect(Math.abs(lAmi(3, 3.5) - 1.5) / 1.5).toBeLessThan(0.03);
  });

  it('L_ami is the flat sc model at the same hook (D9) — for every weight but CYC 1, at every hook', () => {
    // both branches of the max scale by hook^0.75, so which one is larger does not depend on the hook:
    // CYC 2–7 always take the flat-sc branch, CYC 1 always the Table E branch
    for (const cyc of [2, 3, 4, 5, 6, 7] as const) {
      const flat = resolveGauge({ cyc, technique: 'sc_graphgan' });
      expect(lAmi(cyc, flat.hookMm)).toBeCloseTo(flat.lscIn, 12);
      for (const hookMm of [2, 3.5, 6, 12]) {
        expect(lAmi(cyc, hookMm)).toBeCloseTo(resolveGauge({ cyc, technique: 'sc_graphgan', hookMm }).lscIn, 12);
      }
    }
    // worsted with the flat 5 mm hook: w_ami = 0.195 · (5 / 3.5)^0.75 = 0.2548 < w_sc = 0.2963
    expect(lAmi(4, 5)).toBeCloseTo(L_WORSTED, 6);
    // CYC 1 with the flat 3.25 mm hook: w_ami = 0.13 · (3.25 / 2.25)^0.75 = 0.171285 > w_sc = 0.166667
    expect(lAmi(1, 3.25)).toBeCloseTo(6.5 * 0.171285, 5);
    expect(lAmi(1, 3.25)).toBeGreaterThan(resolveGauge({ cyc: 1, technique: 'sc_graphgan' }).lscIn);
  });

  it('L_ami grows with the hook and is never below either branch', () => {
    for (const cyc of [1, 2, 3, 4, 5, 6, 7] as const) {
      let prev = 0;
      for (let mm = 1.5; mm <= 16; mm += 0.25) {
        const l = lAmi(cyc, mm);
        expect(l).toBeGreaterThan(prev);
        prev = l;
      }
    }
  });

  it('the calibrated value replaces both models', () => {
    expect(lSc(4 / 13.5, 1.8)).toBe(1.8);
    expect(lAmi(4, undefined, 1.5)).toBe(1.5);
    expect(lAmi(4, 4.5, 1.5)).toBe(1.5);
    expect(lSc(4 / 13.5, undefined)).toBeCloseTo(L_WORSTED, 6);
    expect(lscFromUnravel(18)).toBe(1.8);
    expect(lscFromUnravel(9, 5)).toBe(1.8);
    expect(CALIBRATION_STITCHES).toBe(10);
  });

  it('rejects input that is not a positive length', () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => lSc(bad)).toThrow(RangeError);
      expect(() => lSc(0.3, bad)).toThrow(RangeError);
      expect(() => lAmi(4, undefined, bad)).toThrow(RangeError);
      expect(() => lAmi(4, bad)).toThrow(RangeError);
      expect(() => stitchYarnIn(bad, 'sc')).toThrow(RangeError);
      expect(() => c2cTileYarnIn(bad)).toThrow(RangeError);
      expect(() => yarnPerCellIn('sc_graphgan', bad)).toThrow(RangeError);
      expect(() => lscFromUnravel(bad)).toThrow(RangeError);
      expect(() => lscFromUnravel(18, bad)).toThrow(RangeError);
    }
    expect(() => lAmi(0)).toThrow(/CYC 0 \(Lace\) is not offered for amigurumi/);
    expect(() => lAmi(0, 2.25, 1.2)).toThrow(RangeError);
    expect(() => lAmi(9 as Cyc)).toThrow(RangeError);
    expect(() => stitchYarnIn(2, 'tr' as 'sc')).toThrow(RangeError);
    expect(() => stitchYarnIn(2, 'constructor' as 'sc')).toThrow(RangeError);
    expect(() => yarnPerCellIn('amigurumi_sc' as Technique2D, 2)).toThrow(RangeError);
  });
});

describe('G11 — Table D, default yarn per stitch in inches (§2.2.4, §2.13)', () => {
  it.each(PRINTED_TABLE_D)('CYC %i: sc %f, hdc %f, dc %f, C2C tile %f, amigurumi %s — every cell within ±0.01', (cyc, sc, hdc, dc, tile, ami) => {
    const row = yarnPerStitchDefaults(cyc);
    expect(Math.abs(row.sc - sc)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(row.hdc - hdc)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(row.dc - dc)).toBeLessThanOrEqual(0.01);
    expect(Math.abs(row.c2cTile - tile)).toBeLessThanOrEqual(0.01);
    if (ami === undefined) {
      expect(row.amigurumi).toBeUndefined();
    } else {
      expect(row.amigurumi).toBeDefined();
      expect(Math.abs((row.amigurumi as number) - ami)).toBeLessThanOrEqual(0.01);
    }
    // "the largest rounding residue is 0.005": the table is the formula printed to 2 decimals
    const computed = [row.sc, row.hdc, row.dc, row.c2cTile, ...(row.amigurumi === undefined ? [] : [row.amigurumi])];
    const printed = [sc, hdc, dc, tile, ...(ami === undefined ? [] : [ami])];
    computed.forEach((v, i) => expect(Math.abs(v - printed[i])).toBeLessThanOrEqual(0.005 + 1e-9));
  });

  it('is the formula: sc = 6.5 · 4 / sts4, hdc = 1.45 sc, dc = 2 sc, tile = 7.76 sc', () => {
    const sts4: Record<Cyc, number> = { 0: 34, 1: 24, 2: 18, 3: 16, 4: 13.5, 5: 10.5, 6: 7.5, 7: 4 };
    for (const cyc of CYCS) {
      const row = yarnPerStitchDefaults(cyc);
      expect(row.sc).toBeCloseTo((6.5 * 4) / sts4[cyc], 12);
      expect(row.hdc).toBeCloseTo(1.45 * row.sc, 12);
      expect(row.dc).toBeCloseTo(2 * row.sc, 12);
      expect(row.c2cTile).toBeCloseTo(7.76 * row.sc, 10);
    }
  });

  it('amigurumi column: only CYC 1 takes the Table E branch of the max (0.845 against 0.822)', () => {
    // flat-sc branch by hand: 6.5 · Table A width · (Table E hook / Table A hook)^0.75
    const flatBranch: Record<number, number> = { 1: 0.8222, 2: 1.0153, 3: 1.2269, 4: 1.4739, 5: 1.8794, 6: 2.7939, 7: 4.4313 };
    const tableEBranch: Record<number, number> = { 1: 0.845, 2: 1.0075, 3: 1.105, 4: 1.2675, 5: 1.69, 6: 2.145, 7: 3.25 };
    for (const cyc of [1, 2, 3, 4, 5, 6, 7] as const) {
      const l = yarnPerStitchDefaults(cyc).amigurumi as number;
      expect(l).toBeCloseTo(Math.max(flatBranch[cyc], tableEBranch[cyc]), 3);
      expect(flatBranch[cyc] > tableEBranch[cyc]).toBe(cyc !== 1);
    }
  });

  it('matches resolveGauge: lscIn is the sc column for 2D and the amigurumi column for amigurumi', () => {
    for (const cyc of CYCS) {
      const row = yarnPerStitchDefaults(cyc);
      for (const technique of ['sc_graphgan', 'sc_tapestry', 'c2c', 'hdc_graphgan', 'mosaic_overlay'] as const) {
        expect(resolveGauge({ cyc, technique }).lscIn).toBe(row.sc);
      }
      if (cyc !== 0) expect(resolveGauge({ cyc, technique: 'amigurumi_sc' }).lscIn).toBe(row.amigurumi);
    }
  });

  it('carries the bands of the table: ±15% sc/hdc/dc, ±35% C2C, ±20% amigurumi until calibrated', () => {
    expect(YARN_PER_STITCH_TOL).toEqual({ sc: 0.15, hdc: 0.15, dc: 0.15, c2cTile: 0.35, amigurumi: 0.2 });
  });

  it('agrees with the measurements it was fitted to, inside its band (research 01 §6.1)', () => {
    // Trock: worsted on 5.0 mm, 1.8 in per sc and 3.75 in per dc
    const w = yarnPerStitchDefaults(4);
    expect(Math.abs(w.sc - 1.8) / w.sc).toBeLessThan(0.15);
    expect(Math.abs(w.dc - 3.75) / w.dc).toBeLessThan(0.15);
    // Trock: bulky on 6.0 mm, 2.5 in per sc (Table A hook is 6.5 mm)
    expect(Math.abs(lSc(resolveGauge({ cyc: 5, technique: 'sc_graphgan', hookMm: 6 }).wSc) - 2.5) / 2.5).toBeLessThan(0.15);
    // a blogger's unravelled worsted C2C block: "around 13 in" (research 01 §6.2), inside ±35%
    expect(Math.abs(w.c2cTile - 13) / w.c2cTile).toBeLessThan(0.35);
  });

  it('yards per square inch of sc fabric = 6.5 / (36 · h) (research 01 Table D, last column)', () => {
    const printed: Record<Cyc, number> = { 0: 1.81, 1: 1.26, 2: 0.95, 3: 0.86, 4: 0.72, 5: 0.54, 6: 0.38, 7: 0.19 };
    for (const cyc of CYCS) {
      const g = resolveGauge({ cyc, technique: 'sc_graphgan' });
      const ydPerSqIn = inchesToYards(g.lscIn) / (g.cell.w * g.cell.h);
      expect(Math.abs(ydPerSqIn - printed[cyc])).toBeLessThanOrEqual(0.0051);
    }
  });
});

describe('worked yarn per chart cell (§2.8 worked_c)', () => {
  it('sc L, tapestry 1.1 L, hdc 1.45 L, C2C 7.76 L per tile, mosaic L (an X is a dc: 2.0 L)', () => {
    expect(TAPESTRY_WORKED_MULT).toBe(1.1);
    const expected: Record<Technique2D, number> = {
      sc_graphgan: 2,
      sc_tapestry: 2.2,
      sc_tapestry_round: 2.2,
      hdc_graphgan: 2.9,
      c2c: 15.52,
      mosaic_overlay: 2,
    };
    for (const [technique, inches] of Object.entries(expected)) {
      expect(yarnPerCellIn(technique as Technique2D, 2)).toBeCloseTo(inches, 12);
    }
    expect(stitchYarnIn(2, 'dc')).toBe(4); // mosaic X
  });

  it('carried strands: 1.1 × the stitch width per stitch passed (tapestry, short carries, floats)', () => {
    expect(CARRIED_PER_WIDTH).toBe(1.1);
    expect(carriedYarnIn(100, 0.3)).toBeCloseTo(33, 12);
    expect(carriedYarnIn(0, 0.3)).toBe(0);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => carriedYarnIn(bad, 0.3)).toThrow(RangeError);
    for (const bad of [0, -1, Number.NaN]) expect(() => carriedYarnIn(10, bad)).toThrow(RangeError);
  });

  it('tapestry costs about +27% with 2 colours and +44% with 3 (research 01 §6.3)', () => {
    const g = resolveGauge({ cyc: 4, technique: 'sc_tapestry' });
    const plain = g.lscIn;
    const two = yarnPerCellIn('sc_tapestry', g.lscIn) + carriedYarnIn(1, g.cell.w);
    const three = yarnPerCellIn('sc_tapestry', g.lscIn) + carriedYarnIn(2, g.cell.w);
    expect(two / plain - 1).toBeCloseTo(0.27, 2);
    expect(three / plain - 1).toBeCloseTo(0.44, 2);
  });

  it('tails: two 6 in tails per start', () => {
    expect(TAIL_IN).toBe(6);
    expect(tailsIn(1)).toBe(12);
    expect(tailsIn(7)).toBe(84);
    expect(tailsIn(0)).toBe(0);
    for (const bad of [-1, Number.NaN]) expect(() => tailsIn(bad)).toThrow(RangeError);
  });

  it('fixed extras: joined round 0.92 L, decrease 0.2 L, magic ring 3 in, embroidery 24 / 12 in', () => {
    expect(JOINED_ROUND_YARN_MULT).toBeCloseTo(0.92, 12);
    expect(JOINED_ROUND_YARN_MULT).toBe(MULT.ch + MULT.slst);
    expect(DEC_EXTRA_YARN_MULT).toBe(0.2);
    expect(MAGIC_RING_IN).toBe(3);
    expect(EMBROIDERY_IN).toEqual({ eyePair: 24, feature: 12 });
  });
});

describe('buffer, band, skeins (§2.8)', () => {
  it('buffer: 0.10 single-color piece; 0.15 default; 0.20 for C2C, tapestry, or > 50 strands', () => {
    expect(YARDAGE_BUFFER).toEqual({ singleColor: 0.1, standard: 0.15, complex: 0.2 });
    expect(MANY_STRANDS).toBe(50);
    expect(yardageBuffer({ technique: 'sc_graphgan', colors: 1 })).toBe(0.1);
    expect(yardageBuffer({ technique: 'hdc_graphgan', colors: 1, strands: 1 })).toBe(0.1);
    expect(yardageBuffer({ technique: 'sc_graphgan', colors: 4 })).toBe(0.15);
    expect(yardageBuffer({ technique: 'sc_graphgan', colors: 4, strands: 50 })).toBe(0.15);
    expect(yardageBuffer({ technique: 'sc_graphgan', colors: 4, strands: 51 })).toBe(0.2);
    expect(yardageBuffer({ technique: 'mosaic_overlay', colors: 2, strands: 200 })).toBe(0.2);
    expect(yardageBuffer({ technique: 'mosaic_overlay', colors: 2 })).toBe(0.15);
    for (const technique of ['c2c', 'sc_tapestry', 'sc_tapestry_round'] as const) {
      expect(yardageBuffer({ technique, colors: 3 })).toBe(0.2);
      expect(yardageBuffer({ technique, colors: 1 })).toBe(0.2); // the higher buffer wins
    }
    // amigurumi: 0.15, always
    expect(yardageBuffer({ technique: 'amigurumi_sc', colors: 1 })).toBe(0.15);
    expect(yardageBuffer({ technique: 'amigurumi_sc', colors: 5, strands: 80 })).toBe(0.15);
  });

  it('band: 2D ±25% default, 3D ±20% default, ±10% measured, ±5% calibrated', () => {
    expect(YARDAGE_BAND).toEqual({ default2d: 0.25, default3d: 0.2, measured: 0.1, calibrated: 0.05 });
    const techniques2d: TechniqueId[] = ['sc_graphgan', 'sc_tapestry', 'sc_tapestry_round', 'c2c', 'hdc_graphgan', 'mosaic_overlay'];
    for (const technique of techniques2d) {
      expect(yardageBand({ technique, source: 'default' })).toBe(0.25);
      expect(yardageBand({ technique, source: 'swatch' })).toBe(0.1);
      expect(yardageBand({ technique, source: 'default', calibrated: true })).toBe(0.05);
      expect(yardageBand({ technique, source: 'swatch', calibrated: true })).toBe(0.05);
    }
    expect(yardageBand({ technique: 'amigurumi_sc', source: 'default' })).toBe(0.2);
    expect(yardageBand({ technique: 'amigurumi_sc', source: 'swatch' })).toBe(0.1);
    expect(yardageBand({ technique: 'amigurumi_sc', source: 'swatch', calibrated: true })).toBe(0.05);
    expect(yardageBand({ technique: 'amigurumi_sc', source: 'default', calibrated: false })).toBe(0.2);
  });

  it('yards = inches / 36 × (1 + buffer); low and high = yards × (1 ∓ band)', () => {
    expect(IN_PER_YD).toBe(36);
    expect(inchesToYards(36)).toBe(1);
    expect(inchesToYards(360, 0.15)).toBeCloseTo(11.5, 12);
    expect(inchesToYards(0, 0.2)).toBe(0);
    expect(yardRange(100, 0.25)).toEqual({ low: 75, high: 125 });
    expect(yardRange(100, 0)).toEqual({ low: 100, high: 100 });
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => inchesToYards(bad)).toThrow(RangeError);
      expect(() => inchesToYards(10, bad)).toThrow(RangeError);
      expect(() => yardRange(bad, 0.1)).toThrow(RangeError);
    }
    for (const bad of [-0.1, 1, 2, Number.NaN]) expect(() => yardRange(100, bad)).toThrow(RangeError);
  });

  it('skeins = ceil(yardsHigh / skeinYards): bought for the high end (D9)', () => {
    expect(skeinsToBuy(77.4, 364)).toBe(1);
    expect(skeinsToBuy(364, 364)).toBe(1);
    expect(skeinsToBuy(364.5, 364)).toBe(2);
    expect(skeinsToBuy(0, 364)).toBe(0);
    expect(skeinsToBuy(0.01, 364)).toBe(1);
    expect(skeinsToBuy(1000, 236)).toBe(5); // Super Saver prints, 236 yd (research 01 §1.5)
    // two skeins exactly, reached through arithmetic that is a few ulps high, is still two skeins
    expect(0.1 + 0.2).toBeGreaterThan(0.3);
    expect(skeinsToBuy(0.1 + 0.2, 0.15)).toBe(2);
    expect(skeinsToBuy(728 * (1 + 2e-16), 364)).toBe(2);
    expect(skeinsToBuy(728.001, 364)).toBe(3);
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => skeinsToBuy(100, bad)).toThrow(RangeError);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => skeinsToBuy(bad, 364)).toThrow(RangeError);
    expect(() => skeinsToBuy(1e308, 1e-308)).toThrow(/out of range/);
  });

  it('grams = yards / ydPer100g × 100; meters = yards × 0.9144', () => {
    expect(gramsFor(190, 190)).toBe(100);
    expect(gramsFor(61.9, 190)).toBeCloseTo(32.58, 2);
    expect(gramsFor(0, 190)).toBe(0);
    for (const bad of [0, -1, Number.NaN]) expect(() => gramsFor(10, bad)).toThrow(RangeError);
    expect(() => gramsFor(-1, 190)).toThrow(RangeError);
    expect(M_PER_YD).toBe(0.9144);
    expect(yardsToMeters(100)).toBeCloseTo(91.44, 12);
  });
});

describe('G11 — the yardage goldens are reachable from the building blocks (§2.8, §2.13)', () => {
  it('2D: 1000 sc of one color, one strand, buffer 0.15 ⇒ (1926 + 12) / 36 × 1.15 = 61.9 yd; band 46.4–77.4 yd; 1 skein of 364 yd', () => {
    const g = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    // the per-stitch inputs of the example
    expect(g.lscIn).toBeCloseTo(1.926, 3);
    const worked = 1000 * yarnPerCellIn('sc_graphgan', g.lscIn);
    expect(worked).toBeCloseTo(1926, 0);
    const tails = tailsIn(1);
    expect(tails).toBe(12);
    // by hand: (1925.926 + 12) / 36 = 53.8313; × 1.15 = 61.906
    const yards = inchesToYards(worked + tails, 0.15);
    expect(yards).toBeCloseTo(61.906, 3);
    expect(yards.toFixed(1)).toBe('61.9');
    const band = yardageBand({ technique: 'sc_graphgan', source: g.source });
    expect(band).toBe(0.25);
    const { low, high } = yardRange(yards, band);
    expect(low.toFixed(1)).toBe('46.4');
    expect(high.toFixed(1)).toBe('77.4');
    expect(skeinsToBuy(high, 364)).toBe(1);
    // 0.15 is the default buffer of a piece with several colors; the piece's own rule gives the same
    expect(yardageBuffer({ technique: 'sc_graphgan', colors: 3, strands: 12 })).toBe(0.15);
  });

  it('2D with a swatch or the calibration the band narrows: 55.7–68.1 yd, then 58.8–65.0 yd', () => {
    const yards = 61.906;
    const measured = yardRange(yards, yardageBand({ technique: 'sc_graphgan', source: 'swatch' }));
    expect(measured.low.toFixed(1)).toBe('55.7'); // 61.906 × 0.9 = 55.7154
    expect(measured.high.toFixed(1)).toBe('68.1'); // 61.906 × 1.1 = 68.0966
    const calibrated = yardRange(yards, yardageBand({ technique: 'sc_graphgan', source: 'swatch', calibrated: true }));
    expect(calibrated.low.toFixed(1)).toBe('58.8'); // 58.8107
    expect(calibrated.high.toFixed(1)).toBe('65.0'); // 65.0013
  });

  it('3D: the 36-st worsted sphere ⇒ (689.7 + 8.8 + 3 + 12) / 36 × 1.15 = 22.8 yd; band 18.2–27.4 yd', () => {
    const g = resolveGauge({ cyc: 4, technique: 'amigurumi_sc' });
    const ball = sphereSizing(2.35, g.cell, g.stretch);
    expect(ball.stitches).toBe(468);
    const decreases = 6 * (ball.k - 1); // 36 → 30 → 24 → 18 → 12 → 6
    expect(decreases).toBe(30);
    expect(g.lscIn).toBeCloseTo(1.474, 3);
    const stitches = ball.stitches * g.lscIn;
    const decs = decreases * DEC_EXTRA_YARN_MULT * g.lscIn;
    expect(stitches).toBeCloseTo(689.78, 2); // the spec prints 689.7
    expect(decs).toBeCloseTo(8.84, 2); // 8.8
    const inches = stitches + decs + MAGIC_RING_IN + tailsIn(1);
    const yards = inchesToYards(inches, yardageBuffer({ technique: 'amigurumi_sc', colors: 1 }));
    expect(yards.toFixed(1)).toBe('22.8');
    const { low, high } = yardRange(yards, yardageBand({ technique: 'amigurumi_sc', source: g.source }));
    expect(low.toFixed(1)).toBe('18.2');
    expect(high.toFixed(1)).toBe('27.4');
    // v1.1's L_ami = 6.5 · 0.195 gave 19.7 yd
    const old = 6.5 * 0.195;
    expect(inchesToYards(468 * old + 30 * 0.2 * old + 3 + 12, 0.15).toFixed(1)).toBe('19.7');
  });

  it('G16 border: 2 496 sc in 4 joined rounds ⇒ 4 826 in = 134.1 yd before the buffer (§2.7.10)', () => {
    const g = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const rounds = [612, 620, 628, 636];
    const sts = rounds.reduce((a, b) => a + b, 0);
    expect(sts).toBe(2496);
    const inches = sts * g.lscIn + rounds.length * JOINED_ROUND_YARN_MULT * g.lscIn + tailsIn(1);
    expect(Math.round(inches)).toBe(4826);
    expect(inchesToYards(inches).toFixed(1)).toBe('134.1');
  });

  it('a C2C blanket of 6 000 tiles in one color: 6000 × 14.945 in, buffer 0.20', () => {
    const g = resolveGauge({ cyc: 4, technique: 'c2c' });
    const inches = 6000 * yarnPerCellIn('c2c', g.lscIn) + tailsIn(1);
    // by hand: 6000 × 14.945185 = 89671.1 + 12 = 89683.1 in = 2491.2 yd; × 1.2 = 2989.4 yd
    const yards = inchesToYards(inches, yardageBuffer({ technique: 'c2c', colors: 1 }));
    expect(yards).toBeCloseTo(2989.4, 1);
    const { high } = yardRange(yards, yardageBand({ technique: 'c2c', source: g.source }));
    expect(skeinsToBuy(high, 364)).toBe(11); // 3736.8 yd / 364 = 10.27
  });
});
