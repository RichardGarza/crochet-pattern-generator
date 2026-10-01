// Resolving the gauge (DESIGN.md §2.2.5; research 01 §4.4, §7). Step 0 kernel: pure.
//
// A `GaugeSpec` is what the user chose (yarn weight, technique, hook) and measured (a swatch, a C2C swatch, an
// amigurumi test ball, the yarn of 10 unravelled stitches). `resolveGauge` turns it into the numbers every
// generator works with: the stitch cell, the sc cell behind yardage and the border, the yarn per stitch, the
// stuffing stretch and the size uncertainty.
//
// One measurement per technique family, and only that one is read: row techniques read `swatch`, C2C reads
// `c2cSwatch`, amigurumi reads `testBall`. A measurement must have been made in the project's technique (for
// tapestry: carrying the strands the project carries); a leftover swatch of another row technique cannot be
// told apart, so the UI clears it or swaps the gauge profile when the technique changes.
import type { Cell, GaugeSpec, ResolvedGauge, TechniqueId } from '../../types/gauge';
import type { Issue } from '../../types/issues';
import type { Cyc, Inches } from '../../types/units';
import {
  AMI_ASPECT,
  CM_PER_IN,
  CYC_SC_RANGE,
  GAUGE_SPAN_IN,
  HOOK_EXPONENT_RANGE,
  RANGE_SLACK,
  STUFFING_STRETCH,
  SWATCH_TOL,
  TABLE_A,
  amiCell,
  amiHookMm,
  hookFactor,
  scCell,
  techniqueCell,
  type Stuffing,
} from './tables';
import { CALIBRATION_STITCHES, lAmi, lSc, yardageBand } from './yarnPerStitch';

// ---- small helpers

function present<T>(x: T | undefined | null): x is T {
  return x !== undefined && x !== null;
}

function positive(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

const TECHNIQUES: readonly TechniqueId[] = [
  'sc_graphgan',
  'sc_tapestry',
  'sc_tapestry_round',
  'c2c',
  'hdc_graphgan',
  'mosaic_overlay',
  'amigurumi_sc',
];

function isTechnique(t: unknown): t is TechniqueId {
  return typeof t === 'string' && (TECHNIQUES as readonly string[]).includes(t);
}

function isCyc(c: unknown): c is Cyc {
  return typeof c === 'number' && Number.isInteger(c) && c >= 0 && c <= 7;
}

function isTapestry(t: TechniqueId): boolean {
  return t === 'sc_tapestry' || t === 'sc_tapestry_round';
}

/** One decimal, without a trailing ".0". */
function fmt(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// ---- defaults

/** The default hook of a yarn weight and technique: Table A, or Table E for amigurumi (throws for CYC 0). */
export function defaultHookMm(cyc: Cyc, technique: TechniqueId): number {
  if (!isCyc(cyc)) throw new RangeError(`defaultHookMm: CYC yarn weight must be an integer 0–7, got ${String(cyc)}`);
  if (!isTechnique(technique)) throw new RangeError(`defaultHookMm: '${String(technique)}' is not a known technique`);
  return technique === 'amigurumi_sc' ? amiHookMm(cyc) : TABLE_A[cyc].hookMm;
}

/**
 * The table cell of a yarn weight and technique, without any measurement (§2.2.5 step 2): Table A × hook factor
 * → Table B, or Table E × hook factor for amigurumi (before stuffing). `hookMm` defaults to the technique's hook.
 */
export function defaultCell(
  cyc: Cyc,
  technique: TechniqueId,
  o: { hookMm?: number; carried?: number; yarnUnder?: boolean } = {},
): Cell {
  if (!isCyc(cyc)) throw new RangeError(`defaultCell: CYC yarn weight must be an integer 0–7, got ${String(cyc)}`);
  if (!isTechnique(technique)) throw new RangeError(`defaultCell: '${String(technique)}' is not a known technique`);
  if (technique === 'amigurumi_sc') return amiCell(cyc, { hookMm: o.hookMm, yarnUnder: o.yarnUnder });
  return techniqueCell(scCell(cyc, o.hookMm), technique, o.carried ?? 1);
}

// ---- which measurement applies

export type GaugeMeasurement = 'swatch' | 'c2cSwatch' | 'testBall';

/** The `GaugeSpec` field that holds the measured gauge of a technique. */
export function measurementField(technique: TechniqueId): GaugeMeasurement {
  if (technique === 'amigurumi_sc') return 'testBall';
  if (technique === 'c2c') return 'c2cSwatch';
  return 'swatch';
}

/** The measurement `resolveGauge` will use for this spec, or undefined when it will use the tables. */
export function measurementOf(g: GaugeSpec): GaugeMeasurement | undefined {
  if (!isTechnique(g.technique)) return undefined;
  const field = measurementField(g.technique);
  return present(g[field]) ? field : undefined;
}

// ---- validation

export type GaugeIssueCode = 'E_GAUGE_INPUT' | 'W_GAUGE_RANGE' | 'W_GAUGE_ASPECT' | 'W_GAUGE_ROWS' | 'W_GAUGE_LSC';

/**
 * A likely cause the UI can offer to fix in one step:
 * - `cm-as-inches`: a length in centimetres was read as inches (divide it by 2.54);
 * - `inches-as-cm`: a length in inches was converted as if it were centimetres (multiply it by 2.54);
 * - `taller-stitch`: the rows are too tall for sc — hdc or dc, or a UK pattern whose "dc" is US sc;
 * - `tapestry-or-novelty`: fewer rows than stitches — carried strands or a novelty yarn;
 * - `ten-stitches`: the length of all 10 unravelled stitches was entered as the length of one.
 */
export type GaugeHint = 'cm-as-inches' | 'inches-as-cm' | 'taller-stitch' | 'tapestry-or-novelty' | 'ten-stitches';

export interface GaugeIssue extends Issue {
  code: GaugeIssueCode;
  /** The `GaugeSpec` field the finding is about. */
  field: keyof GaugeSpec;
  hint?: GaugeHint;
}

function inputErrors(g: GaugeSpec): GaugeIssue[] {
  const out: GaugeIssue[] = [];
  const err = (field: keyof GaugeSpec, message: string): void => {
    out.push({ code: 'E_GAUGE_INPUT', severity: 'error', message, field });
  };
  if (g === null || typeof g !== 'object') {
    err('cyc', `The gauge must be an object with a yarn weight and a technique, got ${String(g)}.`);
    return out;
  }
  const cycOk = isCyc(g.cyc);
  if (!cycOk) err('cyc', `The yarn weight must be a CYC number 0–7, got ${String(g.cyc)}.`);
  const techOk = isTechnique(g.technique);
  if (!techOk) err('technique', `'${String(g.technique)}' is not a known technique.`);
  if (cycOk && techOk && g.technique === 'amigurumi_sc' && g.cyc === 0) {
    err('cyc', 'CYC 0 (Lace) is not offered for amigurumi: Table E has no row for it. Choose CYC 1–7.');
  }
  if (present(g.hookMm) && !positive(g.hookMm)) {
    err('hookMm', `The hook must be a positive size in mm, got ${String(g.hookMm)}.`);
  }
  if (techOk) {
    const field = measurementField(g.technique);
    // A measurement needs positive numbers, and the stitch size they give must itself be a usable number
    // (a quotient of two representable numbers can still overflow or vanish).
    if (field === 'swatch' && present(g.swatch)) {
      const s = g.swatch;
      if (!positive(s.sts) || !positive(s.rows) || !positive(s.spanIn) || !positive(s.spanIn / s.sts) || !positive(s.spanIn / s.rows)) {
        err('swatch', `The swatch needs positive numbers of stitches and rows and a positive length, got ${String(s.sts)} sts and ${String(s.rows)} rows over ${String(s.spanIn)} in.`);
      }
    } else if (field === 'c2cSwatch' && present(g.c2cSwatch)) {
      const s = g.c2cSwatch;
      if (!positive(s.tiles) || !positive(s.spanIn) || !positive(s.spanIn / s.tiles)) {
        err('c2cSwatch', `The C2C swatch needs a positive number of tiles and a positive length, got ${String(s.tiles)} tiles over ${String(s.spanIn)} in.`);
      }
    } else if (field === 'testBall' && present(g.testBall)) {
      const s = g.testBall;
      if (!positive(s.maxSts) || !positive(s.circumferenceIn) || !positive(s.circumferenceIn / s.maxSts / AMI_ASPECT.yarnUnder)) {
        err('testBall', `The test ball needs a positive stitch count and a positive circumference, got ${String(s.maxSts)} sts around ${String(s.circumferenceIn)} in.`);
      }
    }
    // `carried` matters only for tapestry without a swatch (a swatch already includes the carried strands).
    if (isTapestry(g.technique) && !present(g.swatch) && present(g.carried)) {
      if (!(typeof g.carried === 'number' && Number.isFinite(g.carried) && g.carried >= 0)) {
        err('carried', `The number of carried strands must be 0 or more, got ${String(g.carried)}.`);
      }
    }
  }
  if (present(g.lscCalibratedIn) && !positive(g.lscCalibratedIn)) {
    err('lscCalibratedIn', `The calibrated yarn per stitch must be a positive length in inches, got ${String(g.lscCalibratedIn)}.`);
  }
  return out;
}

// ---- resolveGauge (§2.2.5)

/**
 * The gauge every generator works with (§2.2.5):
 *
 * 1. A measurement wins: `swatch` → `cell = { w: span/sts, h: span/rows }` (row techniques); `c2cSwatch` →
 *    a square tile `span/tiles`; `testBall` → `w = circumference/maxSts`, which already includes the stuffing,
 *    so `stretch` becomes 1 (`h = w / 1.05`, or `/ 1.11` with yarn under).
 * 2. Otherwise Table A × hook factor → Table B, or Table E × hook factor for amigurumi (`stretch` 1.05).
 * 3. `wSc`, `hSc` = Table A sc width and row height × hook factor (relative to the Table A hook), whatever the
 *    technique; an `sc_graphgan` swatch sets them directly. `lscIn` = `L_sc` (2D) or `L_ami` (amigurumi);
 *    `lscCalibratedIn` overrides both.
 * 4. `tol` = the Table A tolerance, or 0.04 with a measurement; `source` = 'default' | 'swatch'.
 *
 * `stretch` is the stretch of a firmly or medium stuffed piece; lightly stuffed and unstuffed pieces use 1
 * (`stuffingStretch`). Throws a RangeError on invalid input (`checkGauge` lists the same findings without
 * throwing): a weight outside 0–7, an unknown technique, CYC 0 for amigurumi, a non-positive hook, measurement
 * or calibration.
 */
export function resolveGauge(g: GaugeSpec): ResolvedGauge {
  const errors = inputErrors(g);
  if (errors.length > 0) throw new RangeError(`resolveGauge: ${errors[0].message}`);

  const hookMm = present(g.hookMm) ? g.hookMm : defaultHookMm(g.cyc, g.technique);
  let { w: wSc, h: hSc } = scCell(g.cyc, hookMm);
  let cell: Cell;
  let source: ResolvedGauge['source'] = 'default';
  let stretch = 1;

  if (g.technique === 'amigurumi_sc') {
    if (present(g.testBall)) {
      const w = g.testBall.circumferenceIn / g.testBall.maxSts; // = w·s, so s := 1
      cell = { w, h: w / (g.yarnUnder ? AMI_ASPECT.yarnUnder : AMI_ASPECT.yarnOver) };
      source = 'swatch';
    } else {
      cell = amiCell(g.cyc, { hookMm, yarnUnder: g.yarnUnder });
      stretch = STUFFING_STRETCH.firm;
    }
  } else if (g.technique === 'c2c') {
    if (present(g.c2cSwatch)) {
      const tile = g.c2cSwatch.spanIn / g.c2cSwatch.tiles;
      cell = { w: tile, h: tile };
      source = 'swatch';
    } else {
      cell = techniqueCell({ w: wSc, h: hSc }, 'c2c');
    }
  } else if (present(g.swatch)) {
    cell = { w: g.swatch.spanIn / g.swatch.sts, h: g.swatch.spanIn / g.swatch.rows };
    source = 'swatch';
    if (g.technique === 'sc_graphgan') {
      wSc = cell.w;
      hSc = cell.h;
    }
  } else {
    cell = techniqueCell({ w: wSc, h: hSc }, g.technique, present(g.carried) ? g.carried : 1);
  }

  const cal = present(g.lscCalibratedIn) ? g.lscCalibratedIn : undefined;
  const lscIn = g.technique === 'amigurumi_sc' ? lAmi(g.cyc, hookMm, cal) : lSc(wSc, cal);
  const tol = source === 'swatch' ? SWATCH_TOL : TABLE_A[g.cyc].tol;
  return { cell, wSc, hSc, lscIn, hookMm, stretch, tol, source };
}

// ---- checkGauge: the sanity warnings of §2.2.5

/** Flat sc `w/h` outside this range raises `W_GAUGE_ASPECT` (§2.2.5). */
export const SC_ASPECT_RANGE: readonly [number, number] = Object.freeze([0.75, 1.5] as const);
/** A calibrated yarn per stitch more than this far from the model raises `W_GAUGE_LSC`. */
export const LSC_SLACK = 0.35;

interface Count {
  label: string;
  /** Measured count per 4 in. */
  value: number;
  /** The table's count per 4 in for this yarn, technique and hook. */
  expected: number;
}

interface Tolerance {
  usualLo: number | undefined;
  usualHi: number;
  lo: number;
  hi: number;
}

/**
 * The CYC range, moved to where this count sits: CYC publishes sc stitch counts for its own hooks, so the range
 * is scaled by `expected / Table A sts4` (1 for flat sc stitches at the default hook) and widened by ±35%.
 */
function tolerance(cyc: Cyc, expected: number): Tolerance {
  const r = CYC_SC_RANGE[cyc];
  const scale = expected / TABLE_A[cyc].sts4;
  const usualLo = r.lo === undefined ? undefined : r.lo * scale;
  const usualHi = r.hi * scale;
  return { usualLo, usualHi, lo: usualLo === undefined ? 0 : usualLo * (1 - RANGE_SLACK), hi: usualHi * (1 + RANGE_SLACK) };
}

function within(value: number, t: Tolerance): boolean {
  return value >= t.lo && value <= t.hi;
}

/**
 * Inside the plain CYC range, without the ±35%. A unit slip is suggested only when undoing it lands here: the
 * accepted range is wider than the factor 2.54, so a count just outside one end would otherwise "fit" at the
 * other end.
 */
function usual(value: number, t: Tolerance): boolean {
  return value >= (t.usualLo ?? 0) && value <= t.usualHi;
}

function usualText(t: Tolerance): string {
  return t.usualLo === undefined ? `usually up to ${fmt(t.usualHi)}` : `usually ${fmt(t.usualLo)}–${fmt(t.usualHi)}`;
}

function rangeIssue(g: GaugeSpec, field: GaugeMeasurement, subject: string, counts: Count[]): GaugeIssue | undefined {
  const tol = counts.map((c) => tolerance(g.cyc, c.expected));
  const off = counts.map((c, i) => ({ c, t: tol[i] })).filter(({ c, t }) => !within(c.value, t));
  if (off.length === 0) return undefined;

  let hint: GaugeHint | undefined;
  if (counts.every((c, i) => usual(c.value * CM_PER_IN, tol[i]))) hint = 'cm-as-inches';
  else if (counts.every((c, i) => usual(c.value / CM_PER_IN, tol[i]))) hint = 'inches-as-cm';

  const list = off.map(({ c, t }) => `${fmt(c.value)} ${c.label} (${usualText(t)})`).join(' and ');
  const advice =
    hint === 'cm-as-inches'
      ? 'The numbers fit a measurement in centimetres: was the length entered in cm but read as inches?'
      : hint === 'inches-as-cm'
        ? 'The numbers fit a measurement in inches: was the length entered in inches but read as centimetres?'
        : 'Check the unit (cm entered as inches?), the stitch names (in UK patterns "dc" means US sc), the hook, and that it was worked in this technique.';
  const issue: GaugeIssue = {
    code: 'W_GAUGE_RANGE',
    severity: 'warn',
    field,
    message: `${subject} has ${list} per 4 in, more than 35% outside the usual range for ${TABLE_A[g.cyc].name} yarn. ${advice}`,
  };
  if (hint) issue.hint = hint;
  return issue;
}

/**
 * Everything worth telling the user about a `GaugeSpec`, without throwing.
 *
 * Errors (`E_GAUGE_INPUT`): exactly the inputs `resolveGauge` rejects. When there is one, only errors are
 * returned.
 *
 * Warnings on the measurement in use (§2.2.5, research 01 §7):
 * - `W_GAUGE_RANGE`: a count per 4 in more than 35% outside the CYC range (stitches, rows, tiles, test-ball
 *   stitches); `hint` says when a cm/inch mix-up explains it exactly.
 * - `W_GAUGE_ASPECT`: flat sc (`sc_graphgan`) `w/h` outside 0.75–1.5.
 * - `W_GAUGE_ROWS`: fewer rows than stitches for flat sc (novelty yarn or tapestry).
 * - `W_GAUGE_LSC`: a calibrated yarn per stitch more than 35% from the model (not in §2.2.5; added because a
 *   unit slip there multiplies every yardage).
 */
export function checkGauge(g: GaugeSpec): GaugeIssue[] {
  const errors = inputErrors(g);
  if (errors.length > 0) return errors;

  const out: GaugeIssue[] = [];
  const carried = typeof g.carried === 'number' && Number.isFinite(g.carried) && g.carried >= 0 ? g.carried : 1;
  const def = defaultCell(g.cyc, g.technique, { hookMm: present(g.hookMm) ? g.hookMm : undefined, carried, yarnUnder: g.yarnUnder });
  const per4 = (count: number, spanIn: Inches): number => (count * GAUGE_SPAN_IN) / spanIn;
  const measurement = measurementOf(g);

  if (measurement === 'swatch' && present(g.swatch)) {
    const s = g.swatch;
    const range = rangeIssue(g, 'swatch', 'This swatch', [
      { label: 'sts', value: per4(s.sts, s.spanIn), expected: GAUGE_SPAN_IN / def.w },
      { label: 'rows', value: per4(s.rows, s.spanIn), expected: GAUGE_SPAN_IN / def.h },
    ]);
    if (range) out.push(range);
    if (g.technique === 'sc_graphgan') {
      const aspect = s.rows / s.sts; // w/h = (span/sts) / (span/rows)
      if (aspect < SC_ASPECT_RANGE[0]) {
        out.push({
          code: 'W_GAUGE_ASPECT',
          severity: 'warn',
          field: 'swatch',
          hint: 'taller-stitch',
          message: `Single crochet stitches are usually 0.75 to 1.5 times as wide as tall; this swatch gives ${aspect.toFixed(2)}. Rows this tall suggest half double or double crochet (UK half treble or treble): in UK patterns "dc" means US sc.`,
        });
      } else if (aspect > SC_ASPECT_RANGE[1]) {
        out.push({
          code: 'W_GAUGE_ASPECT',
          severity: 'warn',
          field: 'swatch',
          message: `Single crochet stitches are usually 0.75 to 1.5 times as wide as tall; this swatch gives ${aspect.toFixed(2)}. Check both counts, and that stitches and rows were counted over the same length.`,
        });
      }
      if (s.rows < s.sts) {
        out.push({
          code: 'W_GAUGE_ROWS',
          severity: 'warn',
          field: 'swatch',
          hint: 'tapestry-or-novelty',
          message: `Fewer rows than stitches over the same length (${fmt(s.rows)} rows, ${fmt(s.sts)} sts) is unusual for plain single crochet: it happens with novelty yarns and with tapestry crochet. Choose a tapestry technique if you carry yarn inside the stitches.`,
        });
      }
    }
  } else if (measurement === 'c2cSwatch' && present(g.c2cSwatch)) {
    const s = g.c2cSwatch;
    const range = rangeIssue(g, 'c2cSwatch', 'This C2C swatch', [
      { label: 'tiles', value: per4(s.tiles, s.spanIn), expected: GAUGE_SPAN_IN / def.w },
    ]);
    if (range) out.push(range);
  } else if (measurement === 'testBall' && present(g.testBall)) {
    const s = g.testBall;
    // A test ball is measured stuffed, so it is compared with the stuffed table width.
    const range = rangeIssue(g, 'testBall', 'This test ball', [
      { label: 'sts', value: per4(s.maxSts, s.circumferenceIn), expected: GAUGE_SPAN_IN / (def.w * STUFFING_STRETCH.firm) },
    ]);
    if (range) out.push(range);
  }

  if (present(g.lscCalibratedIn)) {
    const model = resolveGauge({ ...g, lscCalibratedIn: undefined }).lscIn;
    const ratio = g.lscCalibratedIn / model;
    const ok = (r: number): boolean => r >= 1 - LSC_SLACK && r <= 1 + LSC_SLACK;
    if (!ok(ratio)) {
      let hint: GaugeHint | undefined;
      if (ok(ratio / CM_PER_IN)) hint = 'cm-as-inches';
      else if (ok(ratio * CM_PER_IN)) hint = 'inches-as-cm';
      else if (ok(ratio / CALIBRATION_STITCHES)) hint = 'ten-stitches';
      const advice =
        hint === 'cm-as-inches'
          ? 'It fits a length measured in centimetres: was it entered in cm but read as inches?'
          : hint === 'inches-as-cm'
            ? 'It fits a length measured in inches: was it entered in inches but read as centimetres?'
            : hint === 'ten-stitches'
              ? `It fits the yarn of all ${CALIBRATION_STITCHES} stitches: divide the measured length by the number of stitches unravelled.`
              : `Unravel ${CALIBRATION_STITCHES} stitches again and measure the yarn they used.`;
      const issue: GaugeIssue = {
        code: 'W_GAUGE_LSC',
        severity: 'warn',
        field: 'lscCalibratedIn',
        message: `The calibrated yarn per stitch, ${g.lscCalibratedIn.toFixed(2)} in, is more than 35% away from the ${model.toFixed(2)} in expected for this yarn and hook. ${advice}`,
      };
      if (hint) issue.hint = hint;
      out.push(issue);
    }
  }
  return out;
}

/**
 * `checkGauge` and `resolveGauge` in one call, for forms: the findings, and the gauge when none of them is an
 * error. Never throws.
 */
export function resolveGaugeChecked(g: GaugeSpec): { gauge: ResolvedGauge | undefined; issues: GaugeIssue[] } {
  const issues = checkGauge(g);
  const invalid = issues.some((i) => i.severity === 'error');
  return { gauge: invalid ? undefined : resolveGauge(g), issues };
}

// ---- reading a resolved gauge

/** The band every size display carries: `nominal × (1 ± tol)` (§2.2.5). */
export function sizeBand(nominalIn: Inches, tol: number): { low: Inches; high: Inches } {
  if (!(Number.isFinite(nominalIn) && nominalIn >= 0)) throw new RangeError(`sizeBand: the size must be a number ≥ 0, got ${nominalIn}`);
  if (!(Number.isFinite(tol) && tol >= 0 && tol < 1)) throw new RangeError(`sizeBand: the tolerance must be a fraction in [0, 1), got ${tol}`);
  return { low: nominalIn * (1 - tol), high: nominalIn * (1 + tol) };
}

/**
 * The size range of a hook override without a swatch (§2.2.2): the hook exponent is 0.75 ± 0.25, so a size that
 * is `nominalIn` at p = 0.75 lies between its values at p = 0.5 and p = 1.0. `refHookMm` is the technique's
 * default hook (`defaultHookMm`). With the default hook the range collapses to the nominal size.
 */
export function hookSizeRange(nominalIn: Inches, hookMm: number, refHookMm: number): { low: Inches; high: Inches } {
  if (!(Number.isFinite(nominalIn) && nominalIn >= 0)) throw new RangeError(`hookSizeRange: the size must be a number ≥ 0, got ${nominalIn}`);
  const nominal = hookFactor(hookMm, refHookMm);
  const a = hookFactor(hookMm, refHookMm, HOOK_EXPONENT_RANGE[0]) / nominal;
  const b = hookFactor(hookMm, refHookMm, HOOK_EXPONENT_RANGE[1]) / nominal;
  return { low: nominalIn * Math.min(a, b), high: nominalIn * Math.max(a, b) };
}

/**
 * The stuffing stretch `s` of a piece (§2.2.3, §2.10.5): the gauge's own stretch for firm or medium stuffing
 * (1.05 from the tables, 1 when a test ball measured the stuffed fabric), 1 for light or no stuffing.
 */
export function stuffingStretch(g: Pick<ResolvedGauge, 'stretch'>, stuffing: Stuffing): number {
  return stuffing === 'firm' || stuffing === 'medium' ? g.stretch : 1;
}

/** The effective stitch of a stuffed piece: `wS = w·s`, `hS = h·s` — stretch is isotropic (§2.2.3). */
export function stuffedCell(g: Pick<ResolvedGauge, 'cell' | 'stretch'>, stuffing: Stuffing): { wS: Inches; hS: Inches } {
  const s = stuffingStretch(g, stuffing);
  return { wS: g.cell.w * s, hS: g.cell.h * s };
}

/** Stitches and rows (or tiles) per 4 in of a cell — the form a gauge is stated in. */
export function countsPer4In(cell: Cell): { sts4: number; rows4: number } {
  const sts4 = GAUGE_SPAN_IN / cell.w;
  const rows4 = GAUGE_SPAN_IN / cell.h;
  if (!positive(cell.w) || !positive(cell.h) || !positive(sts4) || !positive(rows4)) {
    throw new RangeError(`countsPer4In: the cell must have positive sides, got ${String(cell.w)} × ${String(cell.h)}`);
  }
  return { sts4, rows4 };
}

/**
 * `GaugeSpec.swatch` from a swatch stated as "S stitches × R rows measure W × H" (research 01 §7, input mode b):
 * the frozen swatch type has one span, so the rows are restated over the width.
 */
export function swatchFromSize(o: { sts: number; rows: number; widthIn: Inches; heightIn: Inches }): NonNullable<GaugeSpec['swatch']> {
  if (!positive(o.sts) || !positive(o.rows) || !positive(o.widthIn) || !positive(o.heightIn)) {
    throw new RangeError(`swatchFromSize: stitches, rows, width and height must all be positive, got ${String(o.sts)} × ${String(o.rows)} over ${String(o.widthIn)} × ${String(o.heightIn)} in`);
  }
  return { sts: o.sts, rows: (o.rows * o.widthIn) / o.heightIn, spanIn: o.widthIn };
}

/**
 * The yardage band of a gauge spec (§2.8): ±5% once `lscCalibratedIn` is set, ±10% with the technique's
 * measurement, otherwise ±25% (2D) or ±20% (amigurumi).
 */
export function yardageBandFor(g: GaugeSpec): number {
  return yardageBand({
    technique: g.technique,
    source: measurementOf(g) ? 'swatch' : 'default',
    calibrated: present(g.lscCalibratedIn),
  });
}
