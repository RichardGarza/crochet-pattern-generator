import { describe, expect, it } from 'vitest';
import type { GaugeSpec, Technique2D, TechniqueId } from '../../../types/gauge';
import type { Cyc } from '../../../types/units';
import {
  CARRIED_USUAL_MAX,
  HOOK_USUAL_RATIO,
  LSC_SLACK,
  SC_ASPECT_RANGE,
  aspectWindow,
  checkGauge,
  defaultCell,
  resolveGauge,
  resolveGaugeChecked,
  swatchFromSize,
  type GaugeIssue,
} from '../resolve';
import { cmToIn } from '../tables';
import { LABEL_GAUGES } from './labels';

// Thresholds in the comments are worked by hand from §2.2.1 (worsted: 13.5 sts × 16 rows per 4 in, CYC range
// 11–14 sc) and §2.2.5 (±35%): stitches accepted 7.15–18.9, rows (range carried over at 16 / 13.5) 8.47–22.4.

const CYCS: readonly Cyc[] = [0, 1, 2, 3, 4, 5, 6, 7];
const TECHNIQUES_2D: readonly Technique2D[] = ['sc_graphgan', 'sc_tapestry', 'sc_tapestry_round', 'c2c', 'hdc_graphgan', 'mosaic_overlay'];
const codes = (g: GaugeSpec): string[] => checkGauge(g).map((i) => i.code);
const brief = (g: GaugeSpec): [string, string | undefined][] => checkGauge(g).map((i) => [i.code, i.hint]);
const sc = (sts: number, rows: number, spanIn = 4, more: Partial<GaugeSpec> = {}): GaugeSpec => ({
  cyc: 4,
  technique: 'sc_graphgan',
  swatch: { sts, rows, spanIn },
  ...more,
});

describe('checkGauge — nothing to say', () => {
  it('about the defaults', () => {
    for (const cyc of CYCS) {
      for (const technique of TECHNIQUES_2D) expect(checkGauge({ cyc, technique })).toEqual([]);
      if (cyc !== 0) expect(checkGauge({ cyc, technique: 'amigurumi_sc' })).toEqual([]);
    }
  });

  it('about a plausible measurement', () => {
    expect(checkGauge(sc(14, 17))).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', hookMm: 6, lscCalibratedIn: 2.1 })).toEqual([]);
    // Ventura's tapestry heart, 12.5 sts and 11 rows = 4 in, worked with a 9 mm hook (research 01 §3.4)
    expect(checkGauge({ cyc: 4, technique: 'sc_tapestry', swatch: { sts: 12.5, rows: 11, spanIn: 4 } })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'sc_tapestry', swatch: { sts: 12.5, rows: 11, spanIn: 4 }, hookMm: 9 })).toEqual([]);
    // LillaBjörn's Nya mosaic: 19 sc and 24 rows = 10 × 10 cm in DK
    expect(checkGauge({ cyc: 3, technique: 'mosaic_overlay', swatch: { sts: 19, rows: 24, spanIn: cmToIn(10) } })).toEqual([]);
    // Red Heart C2C throw: 6 blocks = 4 in
    expect(checkGauge({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 6, spanIn: 4 } })).toEqual([]);
    // PlanetJune's 42-st ball, 2.75 in across
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 42, circumferenceIn: 8.64 } })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', lscCalibratedIn: 1.5 })).toEqual([]);
  });

  it('about a table gauge entered as a measurement, for every weight and technique', () => {
    for (const cyc of CYCS) {
      for (const technique of ['sc_graphgan', 'sc_tapestry', 'sc_tapestry_round', 'hdc_graphgan', 'mosaic_overlay'] as const) {
        const c = defaultCell(cyc, technique);
        expect(checkGauge({ cyc, technique, swatch: { sts: 4 / c.w, rows: 4 / c.h, spanIn: 4 } })).toEqual([]);
      }
      expect(checkGauge({ cyc, technique: 'c2c', c2cSwatch: { tiles: 4 / defaultCell(cyc, 'c2c').w, spanIn: 4 } })).toEqual([]);
      if (cyc !== 0) {
        const w = defaultCell(cyc, 'amigurumi_sc').w * 1.05;
        expect(checkGauge({ cyc, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 36 * w } })).toEqual([]);
      }
    }
  });

  it('is deterministic: the same spec gives the same findings, text included', () => {
    const spec: GaugeSpec = { ...sc(12.7, 7.6), lscCalibratedIn: 18 };
    expect(checkGauge(spec)).toEqual(checkGauge(spec));
    expect(codes(spec)).toEqual(['W_GAUGE_RANGE', 'W_GAUGE_ASPECT', 'W_GAUGE_ROWS', 'W_GAUGE_LSC']);
  });
});

describe('W_GAUGE_RANGE — a count outside the CYC range ±35% (§2.2.5)', () => {
  it('worsted stitches: accepted from 7.15 to 18.9 per 4 in', () => {
    const at = (sts: number): [string, string | undefined][] => brief(sc(sts, sts * 1.18));
    expect(at(7.5)).toEqual([]);
    expect(at(18.8)).toEqual([]);
    expect(at(19.0)).toEqual([['W_GAUGE_RANGE', undefined]]);
    expect(at(7.1)).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
    expect(checkGauge(sc(19, 19 * 1.18))[0].message).toBe(
      'This swatch has 19 sts (usually 11–14) and 22.4 rows (usually 13–16.6) per 4 in, more than 35% outside the usual range for Medium (worsted) yarn. Check the unit (cm entered as inches?), the stitch names (in UK patterns "dc" means US sc), the hook, and that it was worked in this technique.',
    );
  });

  it('rows have no CYC range of their own: the stitch range is carried over at the table aspect (8.47–22.4)', () => {
    expect(brief(sc(15, 22.3))).toEqual([]);
    expect(brief(sc(15, 22.5))).toEqual([['W_GAUGE_RANGE', undefined]]);
    expect(checkGauge(sc(15, 22.5))[0].message).toContain('This swatch has 22.5 rows (usually 13–16.6) per 4 in,');
  });

  it('Jumbo has no lower limit (CYC says "≤ 6") and Lace uses the published dc range', () => {
    const at = (cyc: Cyc, sts: number, rows: number): [string, string | undefined][] => brief({ ...sc(sts, rows), cyc });
    // Jumbo: ≤ 6 × 1.35 = 8.1
    expect(at(7, 3, 3.2)).toEqual([]);
    expect(at(7, 6, 6.3)).toEqual([]);
    expect(at(7, 8.2, 8.5)).toEqual([['W_GAUGE_RANGE', 'inches-as-cm']]);
    expect(checkGauge({ ...sc(8.2, 8.5), cyc: 7 })[0].message).toContain('8.2 sts (usually up to 6)');
    // Lace: 32–42 ⇒ 20.8–56.7
    expect(at(0, 22, 26)).toEqual([]);
    expect(at(0, 21, 25)).toEqual([]);
    expect(at(0, 20.5, 25)).toEqual([['W_GAUGE_RANGE', undefined]]);
  });

  it('the expected counts follow the technique', () => {
    // hdc worsted: 12.86 sts × 10.67 rows; rows usually 8.7–11.1 ⇒ accepted 5.65–14.9
    expect(codes({ cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 12.9, rows: 13.5, spanIn: 4 } })).toEqual([]);
    const off = checkGauge({ cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 12.9, rows: 15.2, spanIn: 4 } });
    expect(off.map((i) => i.code)).toEqual(['W_GAUGE_RANGE', 'W_GAUGE_ASPECT']);
    expect(off[0].message).toContain('15.2 rows (usually 8.7–11.1)');
    // C2C worsted: 5.19 tiles per 4 in, usually 4.2–5.4 ⇒ accepted 2.75–7.27
    const tiles = (n: number): [string, string | undefined][] => brief({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: n, spanIn: 4 } });
    expect(tiles(3.3)).toEqual([]);
    expect(tiles(7.2)).toEqual([]);
    expect(tiles(7.4)).toEqual([['W_GAUGE_RANGE', undefined]]);
    expect(checkGauge({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 7.4, spanIn: 4 } })[0].message).toBe(
      'This C2C swatch has 7.4 tiles (usually 4.2–5.4) per 4 in, more than 35% outside the usual range for Medium (worsted) yarn. Check the unit (cm entered as inches?), the hook, and that whole tiles were counted.',
    );
  });

  it('a count inside the plain CYC band is never flagged, whatever hook the spec names', () => {
    // 12.5 sts of worsted on a 9 mm hook: the hook rule would expect 8.7, CYC's own range is 11–14
    expect(codes({ cyc: 4, technique: 'sc_tapestry', swatch: { sts: 12.5, rows: 11, spanIn: 4 }, hookMm: 9 })).toEqual([]);
    expect(codes(sc(16, 18, 4, { hookMm: 6.5 }))).toEqual([]);
    for (const hookMm of [2.5, 3.5, 4, 6, 6.5, 8, 10]) {
      for (const sts of [8, 11, 13.5, 14, 18]) expect(codes(sc(sts, sts * 1.18, 4, { hookMm }))).toEqual([]);
    }
  });

  it('a hook the spec names widens what is accepted: tight sc on a 3.5 mm hook', () => {
    expect(brief(sc(20, 22))).toEqual([['W_GAUGE_RANGE', undefined]]); // > 18.9 at the default 5 mm
    expect(brief(sc(20, 22, 4, { hookMm: 3.5 }))).toEqual([]); // 14 × 1.35 / 0.7653 = 24.7
    expect(brief(sc(25, 28, 4, { hookMm: 3.5 }))).toEqual([['W_GAUGE_RANGE', undefined]]);
  });
});

describe('W_GAUGE_RANGE — unit slips (§2.2.5 "cm entered as inches")', () => {
  it('centimetres read as inches: every weight, the hint and the message', () => {
    // 13 sts and 16 rows over 10 cm, typed as 10 in ⇒ 5.2 sts and 6.4 rows per 4 in
    const issues = checkGauge(sc(13, 16, 10));
    expect(issues).toEqual([
      {
        code: 'W_GAUGE_RANGE',
        severity: 'warn',
        field: 'swatch',
        hint: 'cm-as-inches',
        message:
          'This swatch has 5.2 sts (usually 11–14) and 6.4 rows (usually 13–16.6) per 4 in, more than 35% outside the usual range for Medium (worsted) yarn. The numbers fit a measurement in centimetres: was the length entered in cm but read as inches?',
      },
    ]);
    for (const cyc of CYCS) {
      const c = defaultCell(cyc, 'sc_graphgan');
      const sts = 10 / 2.54 / c.w;
      const rows = 10 / 2.54 / c.h;
      expect(brief({ cyc, technique: 'sc_graphgan', swatch: { sts, rows, spanIn: 10 } })).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
      // with the span corrected the warning is gone
      expect(checkGauge({ cyc, technique: 'sc_graphgan', swatch: { sts, rows, spanIn: cmToIn(10) } })).toEqual([]);
    }
  });

  it('inches converted as centimetres: every weight', () => {
    for (const cyc of CYCS) {
      const c = defaultCell(cyc, 'sc_graphgan');
      expect(brief({ cyc, technique: 'sc_graphgan', swatch: { sts: 4 / c.w, rows: 4 / c.h, spanIn: cmToIn(4) } })).toEqual([['W_GAUGE_RANGE', 'inches-as-cm']]);
    }
    const issue = checkGauge(sc(13.5, 16, cmToIn(4)))[0];
    expect(issue.message).toContain('34.3 sts (usually 11–14) and 40.6 rows (usually 13–16.6)');
    expect(issue.message).toContain('was the length entered in inches but read as centimetres?');
  });

  it('a slip that lands inside the accepted range is still caught: the corrected count fits the yarn clearly better', () => {
    // Patons Grace, labelled DK: 21 sc × 24 rows per 4 in. Counted over 10 cm and typed as 10 in it reads
    // 8.4 sts — inside DK's accepted 7.8–22.95, but 21 sts is far closer to the table's 16 than 8.4 is.
    const issues = checkGauge({ cyc: 3, technique: 'sc_graphgan', swatch: { sts: 21, rows: 24, spanIn: 10 } });
    expect(issues).toEqual([
      {
        code: 'W_GAUGE_RANGE',
        severity: 'warn',
        field: 'swatch',
        hint: 'cm-as-inches',
        message:
          'This swatch has 8.4 sts (usually 12–17) per 4 in, far from what Light (DK) yarn usually gives. The numbers fit a measurement in centimetres: was the length entered in cm but read as inches?',
      },
    ]);
    // worsted: 7.15–7.44 sts is accepted by the range, and explained better by a slipped 18.2–18.9
    expect(brief(sc(7.2, 7.2 * 1.18))).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
    expect(brief(sc(7.5, 7.5 * 1.18))).toEqual([]); // × 2.54 = 19.05 would itself be out of range
    // Jumbo, 1 st per 4 in: no lower limit, but 2.5 sts is what the yarn gives
    expect(brief({ ...sc(1, 1.1), cyc: 7 })).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
    expect(brief({ ...sc(8, 8.5), cyc: 7 })).toEqual([['W_GAUGE_RANGE', 'inches-as-cm']]);
    // C2C and the test ball the same way
    expect(brief({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 2.8, spanIn: 4 } })).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
    expect(brief({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 13.5 } })).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
    expect(brief({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 11.5 } })).toEqual([]);
  });

  it('the hint is decided on the stitch count; the rows only have to become acceptable', () => {
    // 12 sts and 17.5 rows per 4 in (rows above the usual 13–16.6), over 10 cm typed as 10 in
    expect(brief(sc(11.81, 17.22, 10))).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
    // stitches fine, rows off: never a unit slip (a slip moves both)
    expect(brief({ ...sc(4, 5.9, 2.6), cyc: 7 })).toEqual([['W_GAUGE_RANGE', undefined]]);
    // a count just above the range is not "inches as centimetres": 19 / 2.54 = 7.5 is no closer to 13.5
    expect(brief(sc(19, 22.6))).toEqual([['W_GAUGE_RANGE', undefined]]);
  });

  it('C2C and the test ball: tiles and circumference in centimetres', () => {
    // 5 tiles over 10 cm typed as 10 in ⇒ 2 tiles per 4 in
    const c2c = checkGauge({ cyc: 4, technique: 'c2c', c2cSwatch: { tiles: 5, spanIn: 10 } });
    expect(c2c.map((i) => [i.code, i.field, i.hint])).toEqual([['W_GAUGE_RANGE', 'c2cSwatch', 'cm-as-inches']]);
    expect(c2c[0].message).toContain('This C2C swatch has 2 tiles (usually 4.2–5.4) per 4 in');
    // a 21.9 cm circumference typed as inches; worsted balls usually give 15.9–20.3 sts per 4 in around
    const ball = checkGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 42, circumferenceIn: 21.9 } });
    expect(ball.map((i) => [i.code, i.field, i.hint])).toEqual([['W_GAUGE_RANGE', 'testBall', 'cm-as-inches']]);
    expect(ball[0].message).toContain('This test ball has 7.7 sts (usually 15.9–20.3) per 4 in');
    expect(brief({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 14.2 } })).toEqual([['W_GAUGE_RANGE', 'cm-as-inches']]);
  });

  it('test ball: the width across, or half the way around, entered as the circumference', () => {
    const ball = (circumferenceIn: number): GaugeIssue[] => checkGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 42, circumferenceIn } });
    // PlanetJune's ball is 2.75 in across and 8.64 in around
    const across = ball(2.75);
    expect(across.map((i) => [i.code, i.hint])).toEqual([['W_GAUGE_RANGE', 'diameter-as-circumference']]);
    expect(across[0].message).toBe(
      'This test ball has 61.1 sts (usually 15.9–20.3) per 4 in, more than 35% outside the usual range for Medium (worsted) yarn. The numbers fit the width across the ball: enter the circumference, measured around the widest round (π times the width).',
    );
    const half = ball(4.32);
    expect(half.map((i) => [i.code, i.hint])).toEqual([['W_GAUGE_RANGE', 'half-circumference']]);
    expect(half[0].message).toContain('The numbers fit half the circumference: measure all the way around the widest round.');
    // when two explanations fit about equally well (a slightly loose ball measured across: the width, or inches
    // read as centimetres) none is offered as the hint
    const unclear = ball(3.042);
    expect(unclear.map((i) => [i.code, i.hint])).toEqual([['W_GAUGE_RANGE', undefined]]);
    expect(unclear[0].message).toContain('Check the unit, the hook, and that the circumference was measured all the way around the widest round.');
    // too small a circumference that no slip explains: no hint
    expect(ball(6.07).map((i) => [i.code, i.hint])).toEqual([['W_GAUGE_RANGE', undefined]]);
  });
});

describe('checkGauge against the 113 published label gauges (research 01 Appendix A)', () => {
  const swatch = (cyc: Cyc, sts: number, rows: number, spanIn: number, hookMm?: number): GaugeSpec => ({
    cyc,
    technique: 'sc_graphgan',
    hookMm,
    swatch: { sts, rows, spanIn },
  });

  it('holds 113 gauges: 3 super fine, 20 DK, 45 worsted, 22 bulky, 18 super bulky, 5 jumbo', () => {
    expect(LABEL_GAUGES).toHaveLength(113);
    const count = (cyc: Cyc): number => LABEL_GAUGES.filter((l) => l[0] === cyc).length;
    expect([1, 3, 4, 5, 6, 7].map((c) => count(c as Cyc))).toEqual([3, 20, 45, 22, 18, 5]);
  });

  it('a real gauge entered with its hook raises no warning, except one novelty yarn with fewer rows than stitches', () => {
    const warned: string[] = [];
    for (const [cyc, sts, rows, hookMm, yarn] of LABEL_GAUGES) {
      for (const issue of checkGauge(swatch(cyc, sts, rows, 4, hookMm))) warned.push(`${yarn}: ${issue.code}`);
    }
    expect(warned).toEqual(['Lion Brand Cover Story 300g: W_GAUGE_ROWS']);
  });

  it('entered without its hook, only the two 2-stitch Jumbo yarns (25 mm hooks) are questioned', () => {
    const warned: string[] = [];
    for (const [cyc, sts, rows, , yarn] of LABEL_GAUGES) {
      for (const issue of checkGauge(swatch(cyc, sts, rows, 4))) warned.push(`${yarn}: ${issue.code} ${issue.hint ?? ''}`);
    }
    expect(warned).toEqual([
      'Lion Brand Cover Story 300g: W_GAUGE_ROWS tapestry-or-novelty',
      'Bernat Blanket Big: W_GAUGE_RANGE cm-as-inches',
      'Bernat Blanket Extra Thick: W_GAUGE_RANGE cm-as-inches',
    ]);
  });

  it('every one of them is caught, with the hint, when measured over 10 cm and entered as 10 in', () => {
    for (const withHook of [true, false]) {
      for (const [cyc, sts, rows, hookMm, yarn] of LABEL_GAUGES) {
        // the label's counts are per 4 in; over 10 cm the crocheter counts (10 / 10.16) of them
        const spec = swatch(cyc, (sts * 10) / 10.16, (rows * 10) / 10.16, 10, withHook ? hookMm : undefined);
        const range = checkGauge(spec).filter((i) => i.code === 'W_GAUGE_RANGE');
        expect(range.map((i) => i.hint), yarn).toEqual(['cm-as-inches']);
      }
    }
  });

  it('measured over 4 in and converted as centimetres, all but the two 2-stitch Jumbo yarns are caught', () => {
    for (const withHook of [true, false]) {
      const missed: string[] = [];
      let hinted = 0;
      for (const [cyc, sts, rows, hookMm, yarn] of LABEL_GAUGES) {
        const range = checkGauge(swatch(cyc, sts, rows, cmToIn(4), withHook ? hookMm : undefined)).filter((i) => i.code === 'W_GAUGE_RANGE');
        if (range.length === 0) missed.push(yarn);
        if (range[0]?.hint === 'inches-as-cm') hinted++;
      }
      // 2 sts × 2.54 = 5.1 sts per 4 in is an ordinary Jumbo gauge
      expect(missed).toEqual(['Bernat Blanket Big', 'Bernat Blanket Extra Thick']);
      expect(hinted).toBeGreaterThanOrEqual(109);
    }
  });
});

describe('W_GAUGE_ASPECT and W_GAUGE_ROWS — the shape of the stitch (§2.2.5)', () => {
  it('flat sc w/h outside 0.75–1.5, limits included in the plausible range', () => {
    expect(SC_ASPECT_RANGE).toEqual([0.75, 1.5]);
    expect(aspectWindow('sc_graphgan')).toEqual([0.75, 1.5]);
    // w/h = rows / sts
    expect(codes(sc(12, 18))).toEqual([]); // 1.5
    expect(codes(sc(12, 18.2))).toEqual(['W_GAUGE_ASPECT']);
    const high = checkGauge(sc(13, 21));
    expect(high.map((i) => [i.code, i.hint])).toEqual([['W_GAUGE_ASPECT', undefined]]);
    expect(high[0].message).toBe(
      'Single crochet stitches are usually 0.75 to 1.5 times as wide as tall; this swatch gives 1.62. Check both counts, and that stitches and rows were counted over the same length.',
    );
    expect(codes(sc(16, 12))).toEqual(['W_GAUGE_ROWS']); // 0.75
    expect(codes(sc(16, 11.9))).toEqual(['W_GAUGE_ASPECT', 'W_GAUGE_ROWS']);
  });

  it('a double crochet swatch entered as sc (UK "dc" = US sc) trips all three warnings', () => {
    // worsted dc: about 12.7 sts and 7.6 rows per 4 in (rows 2.1× taller)
    const issues = checkGauge(sc(12.7, 7.6));
    expect(issues.map((i) => i.code)).toEqual(['W_GAUGE_RANGE', 'W_GAUGE_ASPECT', 'W_GAUGE_ROWS']);
    const [range, aspect, rows] = issues;
    expect(range.hint).toBeUndefined();
    expect(range.message).toBe(
      'This swatch has 7.6 rows (usually 13–16.6) per 4 in, more than 35% outside the usual range for Medium (worsted) yarn. Check the unit (cm entered as inches?), the stitch names (in UK patterns "dc" means US sc), the hook, and that it was worked in this technique.',
    );
    expect(aspect.hint).toBe('taller-stitch');
    expect(aspect.message).toBe(
      'Single crochet stitches are usually 0.75 to 1.5 times as wide as tall; this swatch gives 0.60. Rows this tall suggest half double or double crochet (UK half treble or treble): in UK patterns "dc" means US sc.',
    );
    expect(rows.hint).toBe('tapestry-or-novelty');
    for (const i of issues) {
      expect(i.severity).toBe('warn');
      expect(i.field).toBe('swatch');
    }
  });

  it('W_GAUGE_ROWS: fewer rows than stitches for flat sc (novelty yarn, tapestry, or an hdc swatch)', () => {
    // an hdc swatch entered as sc: 12.9 sts × 10.7 rows — in range, aspect 0.83, but rows < sts
    const issues = checkGauge(sc(12.9, 10.7));
    expect(issues).toEqual([
      {
        code: 'W_GAUGE_ROWS',
        severity: 'warn',
        field: 'swatch',
        hint: 'tapestry-or-novelty',
        message:
          'Fewer rows than stitches over the same length (10.7 rows and 12.9 sts per 4 in) is unusual for plain single crochet: it happens with novelty yarns, with tapestry crochet (yarn carried inside the stitches) and when the swatch is half double crochet. Choose the technique the swatch was worked in.',
      },
    ]);
    // equal counts are not "fewer"
    expect(codes(sc(13, 13))).toEqual([]);
    expect(codes(sc(13, 12.9))).toEqual(['W_GAUGE_ROWS']);
    // only plain sc: tapestry is taller than wide by design
    expect(codes({ cyc: 4, technique: 'sc_tapestry', swatch: { sts: 13.5, rows: 11.9, spanIn: 4 } })).toEqual([]);
  });

  it('the message quotes counts per 4 in, also for a swatch restated by swatchFromSize', () => {
    // 20 sts × 14 rows measuring 6 × 5 in: 13.3 sts and 11.2 rows per 4 in
    const issues = checkGauge({ cyc: 4, technique: 'sc_graphgan', swatch: swatchFromSize({ sts: 20, rows: 14, widthIn: 6, heightIn: 5 }) });
    expect(issues.map((i) => i.code)).toEqual(['W_GAUGE_ROWS']);
    expect(issues[0].message).toContain('(11.2 rows and 13.3 sts per 4 in)');
  });

  it('the other row techniques have the same window, moved to their own aspect', () => {
    // 0.75–1.5 × (technique aspect / 1.18)
    const win = (t: TechniqueId): string[] => aspectWindow(t).map((x) => x.toFixed(3));
    expect(win('sc_tapestry')).toEqual(['0.559', '1.119']); // × 0.88 / 1.18
    expect(win('sc_tapestry_round')).toEqual(['0.559', '1.119']);
    expect(win('hdc_graphgan')).toEqual(['0.528', '1.055']); // × 0.83 / 1.18
    expect(win('mosaic_overlay')).toEqual(['0.826', '1.653']); // × 1.3 / 1.18
    expect(() => aspectWindow('c2c')).toThrow(RangeError);
    expect(() => aspectWindow('amigurumi_sc')).toThrow(RangeError);
    expect(() => aspectWindow('tss' as TechniqueId)).toThrow(RangeError);
    // real swatches of each technique sit inside: Ventura's tapestry 0.84–1.0, ten designers' hdc 0.6–0.92,
    // LillaBjörn's mosaic 1.26 and 1.5 (research 01 §3.1, §3.4, §3.6)
    for (const a of [0.84, 0.875, 0.88, 0.9, 1.0]) expect(a > 0.559 && a < 1.119).toBe(true);
    expect(codes({ cyc: 4, technique: 'sc_tapestry_round', swatch: { sts: 13.5, rows: 10, spanIn: 4 } })).toEqual([]);
    expect(codes({ cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 15, rows: 9, spanIn: 4 } })).toEqual([]); // 0.6
    expect(codes({ cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 12, rows: 11, spanIn: 4 } })).toEqual([]); // 0.92
    expect(codes({ cyc: 1, technique: 'mosaic_overlay', swatch: { sts: 20, rows: 30, spanIn: cmToIn(10) } })).toEqual([]); // 1.5
  });

  it('a plain sc swatch left over in a tapestry or hdc project is given away by its shape', () => {
    // 13.5 sts × 16 rows: w/h 1.19, above tapestry's 1.12 and hdc's 1.06
    const tapestry = checkGauge({ cyc: 4, technique: 'sc_tapestry', swatch: { sts: 13.5, rows: 16, spanIn: 4 } });
    expect(tapestry).toEqual([
      {
        code: 'W_GAUGE_ASPECT',
        severity: 'warn',
        field: 'swatch',
        hint: 'other-technique',
        message:
          'Tapestry crochet stitches are usually 0.56 to 1.12 times as wide as tall; this swatch gives 1.19. Check that the swatch was worked in this technique, carrying the yarn inside the stitches: a swatch of another stitch cannot size this project.',
      },
    ]);
    const hdc = checkGauge({ cyc: 4, technique: 'hdc_graphgan', swatch: { sts: 13.5, rows: 16, spanIn: 4 } });
    expect(hdc.map((i) => [i.code, i.hint])).toEqual([
      ['W_GAUGE_RANGE', undefined],
      ['W_GAUGE_ASPECT', 'other-technique'],
    ]);
    expect(hdc[1].message).toBe(
      'Half double crochet stitches are usually 0.53 to 1.06 times as wide as tall; this swatch gives 1.19. Check that the swatch was worked in this technique: a swatch of another stitch cannot size this project.',
    );
    // of the 113 label sc gauges, 72 are caught under tapestry and 101 under hdc; overlay mosaic cannot tell
    const caught = (technique: Technique2D): number =>
      LABEL_GAUGES.filter(([cyc, sts, rows]) => checkGauge({ cyc, technique, swatch: { sts, rows, spanIn: 4 } }).some((i) => i.code === 'W_GAUGE_ASPECT')).length;
    expect(caught('sc_tapestry')).toBe(72);
    expect(caught('hdc_graphgan')).toBe(101);
    expect(caught('mosaic_overlay')).toBe(0);
  });
});

describe('W_GAUGE_HOOK and W_GAUGE_CARRIED — plausibility of what the tables are asked to do', () => {
  it('a hook more than twice or less than half the default is an extrapolation', () => {
    expect(HOOK_USUAL_RATIO).toEqual([0.5, 2]);
    const hook = (hookMm: number, technique: TechniqueId = 'sc_graphgan'): string[] => codes({ cyc: 4, technique, hookMm });
    expect(hook(10)).toEqual([]); // 2 × 5 mm
    expect(hook(2.5)).toEqual([]);
    expect(hook(8)).toEqual([]); // a US "8" typed as millimetres cannot be told apart
    expect(hook(10.5)).toEqual(['W_GAUGE_HOOK']);
    expect(hook(2.4)).toEqual(['W_GAUGE_HOOK']);
    // amigurumi counts from the Table E hook, 3.5 mm
    expect(hook(7, 'amigurumi_sc')).toEqual([]);
    expect(hook(7.5, 'amigurumi_sc')).toEqual(['W_GAUGE_HOOK']);
    // a slipped decimal point
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', hookMm: 35 })).toEqual([
      {
        code: 'W_GAUGE_HOOK',
        severity: 'warn',
        field: 'hookMm',
        message:
          'A 35 mm hook is more than twice the 5 mm usual for Medium (worsted) yarn in this technique, so the stitch size is an extrapolation. Check the size (in millimetres, not a US number) or measure a swatch.',
      },
    ]);
    expect(checkGauge({ cyc: 4, technique: 'amigurumi_sc', hookMm: 0.35 })[0].message).toContain('A 0.35 mm hook is less than half the 3.5 mm usual');
    expect(checkGauge({ cyc: 0, technique: 'sc_graphgan', hookMm: 5.25 })[0].message).toContain('A 5.25 mm hook is more than twice the 2.25 mm usual for Lace yarn');
    // every label hook is within the window
    for (const [cyc, , , hookMm] of LABEL_GAUGES) expect(codes({ cyc, technique: 'sc_graphgan', hookMm })).toEqual([]);
  });

  it('more than 3 carried strands is outside what tapestry rows hold', () => {
    expect(CARRIED_USUAL_MAX).toBe(3);
    expect(codes({ cyc: 4, technique: 'sc_tapestry', carried: 3 })).toEqual([]);
    expect(checkGauge({ cyc: 4, technique: 'sc_tapestry_round', carried: 4 })).toEqual([
      {
        code: 'W_GAUGE_CARRIED',
        severity: 'warn',
        field: 'carried',
        message:
          '4 carried strands is more than tapestry rows hold (3 colors per row); the 5% of extra height per strand is not validated there. Measure a swatch that carries the strands.',
      },
    ]);
    // not read with a swatch, nor by other techniques
    expect(codes({ cyc: 4, technique: 'sc_tapestry', carried: 9, swatch: { sts: 13.5, rows: 11.9, spanIn: 4 } })).toEqual([]);
    expect(codes({ cyc: 4, technique: 'sc_graphgan', carried: 9 })).toEqual([]);
  });
});

describe('W_GAUGE_LSC — a calibrated yarn per stitch far from the model', () => {
  const at = (lscCalibratedIn: number, technique: TechniqueId = 'sc_graphgan'): [string, string | undefined][] =>
    brief({ cyc: 4, technique, lscCalibratedIn });

  it('warns beyond ±35% of the model (worsted sc: 1.926 in ⇒ accepted 1.25–2.60)', () => {
    expect(LSC_SLACK).toBe(0.35);
    expect(at(1.8)).toEqual([]);
    expect(at(1.26)).toEqual([]);
    expect(at(2.59)).toEqual([]);
    expect(at(1.2)).toEqual([['W_GAUGE_LSC', undefined]]);
    expect(at(3.0)).toEqual([['W_GAUGE_LSC', undefined]]);
    expect(checkGauge({ cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 3 })[0].message).toBe(
      'The calibrated yarn per stitch, 3.00 in, is more than 35% away from the 1.93 in expected for this yarn and hook. Unravel 10 single crochet again and measure the yarn they used, in the unit shown.',
    );
    // amigurumi compares with L_ami (1.474 in for worsted), an sc swatch with 6.5 × its measured width
    expect(at(1.0, 'amigurumi_sc')).toEqual([]);
    expect(at(0.9, 'amigurumi_sc')).toEqual([['W_GAUGE_LSC', undefined]]);
    expect(checkGauge({ ...sc(10, 12), lscCalibratedIn: 2.6 })).toEqual([]);
  });

  it('names the slip when exactly one fits within 15%', () => {
    expect(at(1.8 * 2.54)).toEqual([['W_GAUGE_LSC', 'cm-as-inches']]); // 4.57 cm read as inches
    expect(at(1.8 / 2.54)).toEqual([['W_GAUGE_LSC', 'inches-as-cm']]);
    expect(at(18)).toEqual([['W_GAUGE_LSC', 'ten-stitches']]); // the yarn of all 10 stitches
    const issue = checkGauge({ cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 18 })[0];
    expect(issue.field).toBe('lscCalibratedIn');
    expect(issue.severity).toBe('warn');
    expect(issue.message).toBe(
      'The calibrated yarn per stitch, 18.00 in, is more than 35% away from the 1.93 in expected for this yarn and hook. It fits the yarn of all 10 stitches: divide the measured length by the number of stitches unravelled.',
    );
    // twice the model is not "centimetres" (2.54×) for an sc technique
    expect(at(3.85)).toEqual([['W_GAUGE_LSC', undefined]]);
    expect(at(14.95)).toEqual([['W_GAUGE_LSC', undefined]]);
  });

  it('knows what a C2C or hdc swatch can be unravelled into', () => {
    // a C2C swatch has no sc: a dc is 2× the model, a whole tile 7.76×
    expect(at(3.85, 'c2c')).toEqual([['W_GAUGE_LSC', 'taller-stitch']]);
    expect(at(14.95, 'c2c')).toEqual([['W_GAUGE_LSC', 'whole-tile']]);
    expect(at(1.8 * 2.54, 'c2c')).toEqual([['W_GAUGE_LSC', 'cm-as-inches']]);
    // halfway between a dc (2×) and centimetres (2.54×): no single explanation
    expect(at(1.926 * 2.25, 'c2c')).toEqual([['W_GAUGE_LSC', undefined]]);
    // an hdc is 1.45× the model
    expect(at(2.79, 'hdc_graphgan')).toEqual([['W_GAUGE_LSC', 'taller-stitch']]);
    expect(checkGauge({ cyc: 4, technique: 'c2c', lscCalibratedIn: 14.95 })[0].message).toContain('It fits the yarn of a whole C2C tile (about 7.76× a single crochet)');
  });
});

describe('checkGauge and resolveGaugeChecked — errors and warnings together', () => {
  it('returns only errors when the input is invalid', () => {
    const issues = checkGauge({ ...sc(13, 16, 10), hookMm: -1 });
    expect(issues.map((i) => i.code)).toEqual(['E_GAUGE_INPUT']);
  });

  it('resolveGaugeChecked: the findings and, unless one is an error, the gauge — without throwing', () => {
    const ok = resolveGaugeChecked({ cyc: 4, technique: 'sc_graphgan' });
    expect(ok.issues).toEqual([]);
    expect(ok.gauge).toEqual(resolveGauge({ cyc: 4, technique: 'sc_graphgan' }));
    // a warning does not stop the gauge: the measurement still wins
    const warned = resolveGaugeChecked(sc(13, 16, 10));
    expect(warned.issues.map((i) => i.code)).toEqual(['W_GAUGE_RANGE']);
    expect(warned.gauge?.source).toBe('swatch');
    expect(warned.gauge?.cell.w).toBeCloseTo(10 / 13, 14);
    // an error does
    const bad = resolveGaugeChecked({ cyc: 0, technique: 'amigurumi_sc' });
    expect(bad.gauge).toBeUndefined();
    expect(bad.issues.map((i) => i.code)).toEqual(['E_GAUGE_INPUT']);
    expect(resolveGaugeChecked(null as unknown as GaugeSpec).gauge).toBeUndefined();
  });

  it('several findings come in a fixed order: range, aspect, rows, hook, carried, calibration', () => {
    // 30 sts × 12 rows on a 12 mm hook with 40 in of yarn per stitch: everything is off at once
    const issues = checkGauge({ ...sc(30, 12), hookMm: 12, lscCalibratedIn: 40 });
    expect(issues.map((i) => i.code)).toEqual(['W_GAUGE_RANGE', 'W_GAUGE_ASPECT', 'W_GAUGE_ROWS', 'W_GAUGE_HOOK', 'W_GAUGE_LSC']);
    expect(codes({ cyc: 4, technique: 'sc_tapestry', carried: 5, hookMm: 12 })).toEqual(['W_GAUGE_HOOK', 'W_GAUGE_CARRIED']);
  });
});
