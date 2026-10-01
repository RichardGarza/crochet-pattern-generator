// Resolving the gauge (DESIGN.md §2.2.5; research 01 §4.4, §7). Step 0 kernel: pure.
//
// A `GaugeSpec` is what the user chose (yarn weight, technique, hook) and measured (a swatch, a C2C swatch, an
// amigurumi test ball, the yarn of 10 unravelled stitches). `resolveGauge` turns it into the numbers every
// generator works with: the stitch cell, the sc cell behind yardage and the border, the yarn per stitch, the
// stuffing stretch and the size uncertainty. `checkGauge` says what looks wrong with a spec.
//
// One measurement per technique family, and only that one is read: row techniques read `swatch`, C2C reads
// `c2cSwatch`, amigurumi reads `testBall`. A measurement must have been made in the project's technique (for
// tapestry: carrying the strands the project carries) and yarn. A leftover swatch of another row technique or
// yarn weight cannot always be told apart (`checkGauge` catches what the stitch proportions give away), so the
// UI clears the measurements, or swaps the gauge profile, when the technique or the yarn weight changes — and
// drops the hook override with the yarn weight (see `amiCell`).
import type { Cell, GaugeSpec, ResolvedGauge, TechniqueId } from '../../types/gauge';
import type { Issue } from '../../types/issues';
import type { Cyc, Inches } from '../../types/units';
import { fmt, isCyc, isObject, isTapestry, isTechnique, nonNegative, positive, present, show } from './checks';
import {
  AMI_ASPECT,
  CM_PER_IN,
  CYC_RANGE,
  GAUGE_SPAN_IN,
  HOOK_EXPONENT_RANGE,
  RANGE_SLACK,
  STUFFING_STRETCH,
  SWATCH_TOL,
  TABLE_A,
  TABLE_B,
  amiCell,
  amiHookMm,
  hookFactor,
  scCell,
  techniqueCell,
  type Stuffing,
} from './tables';
import { C2C_TILE_YARN_MULT, CALIBRATION_STITCHES, MULT, lAmi, lSc, yardageBand } from './yarnPerStitch';

// ---- limits

/** A hook outside this range is not a hook: rejected (`E_GAUGE_INPUT`). */
export const HOOK_LIMITS_MM: readonly [number, number] = Object.freeze([0.1, 100] as const);
/**
 * A hook whose ratio to the default hook is outside this range raises `W_GAUGE_HOOK`: the hook rule of §2.2.2
 * rests on hooks within about ±50% of the usual one, so beyond a factor of 2 the stitch size is an extrapolation
 * (and a slipped decimal point, 35 for 3.5, lands there).
 */
export const HOOK_USUAL_RATIO: readonly [number, number] = Object.freeze([0.5, 2] as const);
/** A measured stitch narrower, shorter, wider or taller than this is not a stitch: rejected. */
export const STITCH_LIMITS_IN: readonly [number, number] = Object.freeze([0.001, 100] as const);
/** A calibrated yarn per stitch outside this range is rejected. */
export const LSC_LIMITS_IN: readonly [number, number] = Object.freeze([0.001, 1000] as const);
/** More carried strands than this is rejected; more than `CARRIED_USUAL_MAX` raises `W_GAUGE_CARRIED`. */
export const CARRIED_LIMIT = 100;
/** Tapestry rows hold at most 3 colors (§2.7.4): beyond 3 carried strands the +5% rule is far outside its data. */
export const CARRIED_USUAL_MAX = 3;
/** Flat sc `w/h` outside this range raises `W_GAUGE_ASPECT` (§2.2.5). */
export const SC_ASPECT_RANGE: readonly [number, number] = Object.freeze([0.75, 1.5] as const);
/** A calibrated yarn per stitch more than this far from the model raises `W_GAUGE_LSC`. */
export const LSC_SLACK = 0.35;

/** How close a corrected value must come to be offered as the explanation (±15%, the model's own band). */
const HINT_TOL = Math.log(1.15);

function inside(x: number, [lo, hi]: readonly [number, number]): boolean {
  return x >= lo && x <= hi;
}

// ---- defaults

/** The default hook of a yarn weight and technique: Table A, or Table E for amigurumi (throws for CYC 0). */
export function defaultHookMm(cyc: Cyc, technique: TechniqueId): number {
  if (!isCyc(cyc)) throw new RangeError(`defaultHookMm: CYC yarn weight must be an integer 0–7, got ${show(cyc)}`);
  if (!isTechnique(technique)) throw new RangeError(`defaultHookMm: ${show(technique)} is not a known technique`);
  return technique === 'amigurumi_sc' ? amiHookMm(cyc) : TABLE_A[cyc].hookMm;
}

/**
 * The table cell of a yarn weight and technique, without any measurement (§2.2.5 step 2): Table A × hook factor
 * → Table B, or Table E × hook factor for amigurumi (before stuffing). `hookMm` defaults to the technique's hook;
 * `carried` is read for tapestry only.
 */
export function defaultCell(
  cyc: Cyc,
  technique: TechniqueId,
  o: { hookMm?: number; carried?: number; yarnUnder?: boolean } = {},
): Cell {
  if (!isCyc(cyc)) throw new RangeError(`defaultCell: CYC yarn weight must be an integer 0–7, got ${show(cyc)}`);
  if (!isTechnique(technique)) throw new RangeError(`defaultCell: ${show(technique)} is not a known technique`);
  if (technique === 'amigurumi_sc') return amiCell(cyc, { hookMm: o?.hookMm, yarnUnder: o?.yarnUnder });
  return techniqueCell(scCell(cyc, o?.hookMm), technique, isTapestry(technique) && present(o?.carried) ? o.carried : 1);
}

// ---- which measurement applies

export type GaugeMeasurement = 'swatch' | 'c2cSwatch' | 'testBall';

/** The `GaugeSpec` field that holds the measured gauge of a technique. */
export function measurementField(technique: TechniqueId): GaugeMeasurement {
  if (!isTechnique(technique)) throw new RangeError(`measurementField: ${show(technique)} is not a known technique`);
  if (technique === 'amigurumi_sc') return 'testBall';
  if (technique === 'c2c') return 'c2cSwatch';
  return 'swatch';
}

/**
 * The measurement `resolveGauge` will use for this spec, or undefined when it will use the tables (also for a
 * spec without a known technique).
 */
export function measurementOf(g: GaugeSpec): GaugeMeasurement | undefined {
  if (!isObject(g) || !isTechnique(g.technique)) return undefined;
  const field = measurementField(g.technique);
  return present(g[field]) ? field : undefined;
}

// ---- validation

export type GaugeIssueCode =
  | 'E_GAUGE_INPUT'
  | 'W_GAUGE_RANGE'
  | 'W_GAUGE_ASPECT'
  | 'W_GAUGE_ROWS'
  | 'W_GAUGE_HOOK'
  | 'W_GAUGE_CARRIED'
  | 'W_GAUGE_LSC';

/**
 * The single cause that explains a finding, when there is exactly one, so the UI can offer the fix:
 * - `cm-as-inches`: a length in centimetres was read as inches (divide it by 2.54);
 * - `inches-as-cm`: a length in inches was converted as if it were centimetres (multiply it by 2.54);
 * - `diameter-as-circumference`: the width across the test ball was entered (multiply it by π);
 * - `half-circumference`: half the way around the test ball was entered (double it);
 * - `taller-stitch`: a taller stitch than sc — hdc or dc, or a UK pattern whose "dc" is US sc;
 * - `other-technique`: the stitch proportions do not fit the technique chosen;
 * - `tapestry-or-novelty`: fewer rows than stitches — carried strands, a novelty yarn or hdc;
 * - `ten-stitches`: the yarn of all 10 unravelled stitches was entered as the yarn of one (divide it by 10);
 * - `whole-tile`: the yarn of a whole C2C tile was entered as the yarn of one sc.
 */
export type GaugeHint =
  | 'cm-as-inches'
  | 'inches-as-cm'
  | 'diameter-as-circumference'
  | 'half-circumference'
  | 'taller-stitch'
  | 'other-technique'
  | 'tapestry-or-novelty'
  | 'ten-stitches'
  | 'whole-tile';

export interface GaugeIssue extends Issue {
  code: GaugeIssueCode;
  /** The `GaugeSpec` field the finding is about. */
  field: keyof GaugeSpec;
  hint?: GaugeHint;
}

/**
 * Everything that makes a spec unusable. `resolveGauge` throws on the first; `checkGauge` returns them all.
 * The limits also guarantee that every number `resolveGauge` returns is finite and above zero.
 */
function inputErrors(g: GaugeSpec): GaugeIssue[] {
  const out: GaugeIssue[] = [];
  const err = (field: keyof GaugeSpec, message: string): void => {
    out.push({ code: 'E_GAUGE_INPUT', severity: 'error', message, field });
  };
  if (!isObject(g)) {
    err('cyc', `The gauge must be an object with a yarn weight and a technique, got ${show(g)}.`);
    return out;
  }
  const cycOk = isCyc(g.cyc);
  if (!cycOk) err('cyc', `The yarn weight must be a CYC number 0–7, got ${show(g.cyc)}.`);
  const techOk = isTechnique(g.technique);
  if (!techOk) err('technique', `${show(g.technique)} is not a known technique.`);
  if (cycOk && techOk && g.technique === 'amigurumi_sc' && g.cyc === 0) {
    err('cyc', 'CYC 0 (Lace) is not offered for amigurumi: Table E has no row for it. Choose CYC 1–7.');
  }
  if (present(g.hookMm) && !(positive(g.hookMm) && inside(g.hookMm, HOOK_LIMITS_MM))) {
    err('hookMm', `The hook must be a size in mm between ${HOOK_LIMITS_MM[0]} and ${HOOK_LIMITS_MM[1]}, got ${show(g.hookMm)}.`);
  }
  if (present(g.yarnUnder) && typeof g.yarnUnder !== 'boolean') {
    err('yarnUnder', `Yarn under must be true or false, got ${show(g.yarnUnder)}.`);
  }
  if (techOk) {
    // A measurement needs positive numbers, and the stitch they give must be a size a stitch can have (a
    // quotient of two representable numbers can still overflow or vanish).
    const stitch = (size: number): boolean => positive(size) && inside(size, STITCH_LIMITS_IN);
    const field = measurementField(g.technique);
    if (field === 'swatch' && present(g.swatch)) {
      const s = g.swatch;
      if (!isObject(s) || !positive(s.sts) || !positive(s.rows) || !positive(s.spanIn)) {
        err('swatch', `The swatch needs positive numbers of stitches and rows and a positive length, got ${show(s?.sts)} sts and ${show(s?.rows)} rows over ${show(s?.spanIn)} in.`);
      } else if (!stitch(s.spanIn / s.sts) || !stitch(s.spanIn / s.rows)) {
        err('swatch', `The swatch gives a stitch of ${s.spanIn / s.sts} × ${s.spanIn / s.rows} in, which is not a size a stitch can have (${STITCH_LIMITS_IN[0]}–${STITCH_LIMITS_IN[1]} in).`);
      }
    } else if (field === 'c2cSwatch' && present(g.c2cSwatch)) {
      const s = g.c2cSwatch;
      if (!isObject(s) || !positive(s.tiles) || !positive(s.spanIn)) {
        err('c2cSwatch', `The C2C swatch needs a positive number of tiles and a positive length, got ${show(s?.tiles)} tiles over ${show(s?.spanIn)} in.`);
      } else if (!stitch(s.spanIn / s.tiles)) {
        err('c2cSwatch', `The C2C swatch gives a tile of ${s.spanIn / s.tiles} in, which is not a size a tile can have (${STITCH_LIMITS_IN[0]}–${STITCH_LIMITS_IN[1]} in).`);
      }
    } else if (field === 'testBall' && present(g.testBall)) {
      const s = g.testBall;
      if (!isObject(s) || !positive(s.maxSts) || !positive(s.circumferenceIn)) {
        err('testBall', `The test ball needs a positive stitch count and a positive circumference, got ${show(s?.maxSts)} sts around ${show(s?.circumferenceIn)} in.`);
      } else if (!stitch(s.circumferenceIn / s.maxSts) || !stitch(s.circumferenceIn / s.maxSts / AMI_ASPECT.yarnUnder)) {
        err('testBall', `The test ball gives a stitch of ${s.circumferenceIn / s.maxSts} in, which is not a size a stitch can have (${STITCH_LIMITS_IN[0]}–${STITCH_LIMITS_IN[1]} in).`);
      }
    }
    // `carried` matters only for tapestry without a swatch (a swatch already includes the carried strands).
    if (isTapestry(g.technique) && !present(g.swatch) && present(g.carried)) {
      if (!(nonNegative(g.carried) && g.carried <= CARRIED_LIMIT)) {
        err('carried', `The number of carried strands must be between 0 and ${CARRIED_LIMIT}, got ${show(g.carried)}.`);
      }
    }
  }
  if (present(g.lscCalibratedIn) && !(positive(g.lscCalibratedIn) && inside(g.lscCalibratedIn, LSC_LIMITS_IN))) {
    err('lscCalibratedIn', `The calibrated yarn per stitch must be a length in inches between ${LSC_LIMITS_IN[0]} and ${LSC_LIMITS_IN[1]}, got ${show(g.lscCalibratedIn)}.`);
  }
  return out;
}

// ---- resolveGauge (§2.2.5)

/** §2.2.5 for a spec that has passed `inputErrors`. */
function compute(g: GaugeSpec): ResolvedGauge {
  const hookMm = present(g.hookMm) ? g.hookMm : defaultHookMm(g.cyc, g.technique);
  let { w: wSc, h: hSc } = scCell(g.cyc, hookMm);
  let cell: Cell;
  let source: ResolvedGauge['source'] = 'default';
  let stretch = 1;

  if (g.technique === 'amigurumi_sc') {
    if (present(g.testBall)) {
      const w = g.testBall.circumferenceIn / g.testBall.maxSts; // = w·s, so s := 1
      cell = { w, h: w / (g.yarnUnder === true ? AMI_ASPECT.yarnUnder : AMI_ASPECT.yarnOver) };
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
    cell = techniqueCell({ w: wSc, h: hSc }, g.technique, isTapestry(g.technique) && present(g.carried) ? g.carried : 1);
  }

  const cal = present(g.lscCalibratedIn) ? g.lscCalibratedIn : undefined;
  const lscIn = g.technique === 'amigurumi_sc' ? lAmi(g.cyc, hookMm, cal) : lSc(wSc, cal);
  const tol = source === 'swatch' ? SWATCH_TOL : TABLE_A[g.cyc].tol;
  const resolved: ResolvedGauge = { cell, wSc, hSc, lscIn, hookMm, stretch, tol, source };
  for (const v of [cell.w, cell.h, wSc, hSc, lscIn, hookMm, stretch, tol]) {
    if (!positive(v)) throw new RangeError('resolveGauge: the gauge is out of range'); // unreachable within the input limits
  }
  return resolved;
}

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
 * (`stuffingStretch`). Every number returned is finite and above zero.
 *
 * Throws a RangeError on a spec that `checkGauge` reports as `E_GAUGE_INPUT` (and on no other): a weight
 * outside 0–7, an unknown technique, CYC 0 for amigurumi, a hook outside 0.1–100 mm, a `yarnUnder` that is not a
 * boolean, a measurement without positive numbers or giving a stitch outside 0.001–100 in, more than 100
 * carried strands, a calibrated yarn outside 0.001–1000 in. Fields the technique does not read are not checked.
 */
export function resolveGauge(g: GaugeSpec): ResolvedGauge {
  const errors = inputErrors(g);
  if (errors.length > 0) throw new RangeError(`resolveGauge: ${errors[0].message}`);
  return compute(g);
}

// ---- checkGauge: the sanity warnings of §2.2.5

interface Band {
  usualLo: number | undefined;
  usualHi: number;
  lo: number;
  hi: number;
}

/**
 * The CYC range carried to a count whose table value is `expected`: CYC publishes sc stitch counts only, so the
 * range is scaled by `expected / Table A sts4` (1 for flat sc stitches at the Table A hook) and widened by ±35%.
 */
function band(cyc: Cyc, expected: number): Band {
  const r = CYC_RANGE[cyc];
  const scale = expected / TABLE_A[cyc].sts4;
  const usualLo = r.lo === undefined ? undefined : r.lo * scale;
  const usualHi = r.hi * scale;
  return { usualLo, usualHi, lo: usualLo === undefined ? 0 : usualLo * (1 - RANGE_SLACK), hi: usualHi * (1 + RANGE_SLACK) };
}

interface Count {
  label: string;
  /** Measured count per 4 in. */
  value: number;
  /**
   * What the tables give for this count: at the technique's default hook, and, when the spec names another
   * hook, at that hook too. A count is accepted when it fits either: CYC's ranges belong to its own hooks, and
   * the hook rule is too rough to overrule them.
   */
  expected: number[];
  /** True for the count CYC publishes a range for (stitches, tiles); rows follow it at the table aspect. */
  primary: boolean;
}

interface Slip {
  hint: GaugeHint;
  /** Multiply the counts by this to undo the slip. */
  factor: number;
  /**
   * True for a slip that is worth a warning by itself, when every count is still acceptable (a unit slip).
   * The others only explain a count that is already off.
   */
  alone: boolean;
}

const UNIT_SLIPS: readonly Slip[] = [
  { hint: 'cm-as-inches', factor: CM_PER_IN, alone: true },
  { hint: 'inches-as-cm', factor: 1 / CM_PER_IN, alone: true },
];
const BALL_SLIPS: readonly Slip[] = [
  ...UNIT_SLIPS,
  { hint: 'diameter-as-circumference', factor: 1 / Math.PI, alone: false },
  { hint: 'half-circumference', factor: 1 / 2, alone: false },
];

function accepted(cyc: Cyc, c: Count, value: number): boolean {
  return c.expected.some((e) => {
    const b = band(cyc, e);
    return value >= b.lo && value <= b.hi;
  });
}

/** Distance (in log scale) from the nearest table value. */
function distance(c: Count, value: number): number {
  return Math.min(...c.expected.map((e) => Math.abs(Math.log(value / e))));
}

function usualText(cyc: Cyc, c: Count): string {
  const b = band(cyc, c.expected[0]);
  return b.usualLo === undefined ? `usually up to ${fmt(b.usualHi)}` : `usually ${fmt(b.usualLo)}–${fmt(b.usualHi)}`;
}

const SLIP_ADVICE: Partial<Record<GaugeHint, string>> = {
  'cm-as-inches': 'The numbers fit a measurement in centimetres: was the length entered in cm but read as inches?',
  'inches-as-cm': 'The numbers fit a measurement in inches: was the length entered in inches but read as centimetres?',
  'diameter-as-circumference': 'The numbers fit the width across the ball: enter the circumference, measured around the widest round (π times the width).',
  'half-circumference': 'The numbers fit half the circumference: measure all the way around the widest round.',
};

const GENERIC_ADVICE: Record<GaugeMeasurement, string> = {
  swatch: 'Check the unit (cm entered as inches?), the stitch names (in UK patterns "dc" means US sc), the hook, and that it was worked in this technique.',
  c2cSwatch: 'Check the unit (cm entered as inches?), the hook, and that whole tiles were counted.',
  testBall: 'Check the unit, the hook, and that the circumference was measured all the way around the widest round.',
};

/**
 * `W_GAUGE_RANGE` for one measurement, or nothing.
 *
 * A count is off when it is more than 35% outside the CYC range (§2.2.5). That accepted range is wider than the
 * factor 2.54, so a unit slip can land inside it. A slip "fits" when undoing it leaves every count acceptable
 * and brings the stitch count clearly closer (by more than 15%) to every table value than it is now; a unit
 * slip that fits is flagged even when no count is off. Checked against the 113 published label gauges of
 * research 01 Appendix A: none is flagged as measured when its hook is given (two 2-stitch Jumbo yarns worked on
 * 25 mm hooks are, at the default 15 mm hook), and every one is flagged, with the hint, after a cm-as-inches
 * slip.
 */
function rangeIssue(g: GaugeSpec, field: GaugeMeasurement, subject: string, counts: Count[], slips: readonly Slip[]): GaugeIssue | undefined {
  const primary = counts.filter((c) => c.primary);
  const fits = slips
    .filter((s) => counts.every((c) => accepted(g.cyc, c, c.value * s.factor)))
    .filter((s) => primary.every((c) => c.expected.every((e) => Math.abs(Math.log((c.value * s.factor) / e)) + HINT_TOL < Math.abs(Math.log(c.value / e)))))
    .map((s) => ({ slip: s, d: Math.max(...primary.map((c) => distance(c, c.value * s.factor))) }))
    .sort((a, b) => a.d - b.d);
  const off = counts.filter((c) => !accepted(g.cyc, c, c.value));
  if (off.length === 0 && !fits.some((f) => f.slip.alone)) return undefined;

  // One explanation, or none: two that fit about equally well are not a hint.
  const hint = fits.length > 0 && (fits.length === 1 || fits[1].d - fits[0].d > HINT_TOL) ? fits[0].slip.hint : undefined;
  const advice = hint ? (SLIP_ADVICE[hint] as string) : GENERIC_ADVICE[field];
  const name = TABLE_A[g.cyc].name;
  const list = (cs: Count[]): string => cs.map((c) => `${fmt(c.value)} ${c.label} (${usualText(g.cyc, c)})`).join(' and ');
  const message =
    off.length > 0
      ? `${subject} has ${list(off)} per 4 in, more than 35% outside the usual range for ${name} yarn. ${advice}`
      : `${subject} has ${list(primary)} per 4 in, far from what ${name} yarn usually gives. ${advice}`;
  const issue: GaugeIssue = { code: 'W_GAUGE_RANGE', severity: 'warn', field, message };
  if (hint) issue.hint = hint;
  return issue;
}

const TECHNIQUE_NAME: Record<TechniqueId, string> = {
  sc_graphgan: 'Single crochet',
  sc_tapestry: 'Tapestry crochet',
  sc_tapestry_round: 'Tapestry crochet',
  hdc_graphgan: 'Half double crochet',
  c2c: 'C2C',
  mosaic_overlay: 'Overlay mosaic',
  amigurumi_sc: 'Amigurumi',
};

/**
 * The stitch aspect `w/h` a swatch of a row technique may have before `W_GAUGE_ASPECT`: 0.75–1.5 for flat sc
 * (§2.2.5), and the same window moved to the technique's own aspect for the others (tapestry 0.56–1.12, hdc
 * 0.53–1.06, overlay mosaic 0.83–1.65). The moved windows are not in §2.2.5; they are what gives away a swatch
 * of another stitch (a plain sc swatch left over in a tapestry project).
 */
export function aspectWindow(technique: TechniqueId): [number, number] {
  if (!isTechnique(technique) || technique === 'c2c' || technique === 'amigurumi_sc') {
    throw new RangeError(`aspectWindow: ${show(technique)} is not a row technique`);
  }
  const r = TABLE_B[technique].aspect / TABLE_B.sc_graphgan.aspect;
  return [SC_ASPECT_RANGE[0] * r, SC_ASPECT_RANGE[1] * r];
}

interface LscSlip {
  hint: GaugeHint;
  /** calibrated ÷ model when this slip was made. */
  factor: number;
  advice: string;
}

function lscSlips(technique: TechniqueId): LscSlip[] {
  const out: LscSlip[] = [
    { hint: 'cm-as-inches', factor: CM_PER_IN, advice: 'It fits a length measured in centimetres: was it entered in cm but read as inches?' },
    { hint: 'inches-as-cm', factor: 1 / CM_PER_IN, advice: 'It fits a length measured in inches: was it entered in inches but read as centimetres?' },
    {
      hint: 'ten-stitches',
      factor: CALIBRATION_STITCHES,
      advice: `It fits the yarn of all ${CALIBRATION_STITCHES} stitches: divide the measured length by the number of stitches unravelled.`,
    },
  ];
  const taller = 'It fits the yarn of a taller stitch (a double crochet uses about 2×, a half double about 1.45× the yarn of a single crochet): enter the yarn of one single crochet.';
  if (technique === 'c2c') {
    out.push({ hint: 'taller-stitch', factor: MULT.dc, advice: taller });
    out.push({
      hint: 'whole-tile',
      factor: C2C_TILE_YARN_MULT,
      advice: 'It fits the yarn of a whole C2C tile (about 7.76× a single crochet): enter the yarn of one single crochet.',
    });
  }
  if (technique === 'hdc_graphgan') out.push({ hint: 'taller-stitch', factor: MULT.hdc, advice: taller });
  return out;
}

/**
 * Everything worth telling the user about a `GaugeSpec`. Never throws.
 *
 * Errors (`E_GAUGE_INPUT`): exactly the specs `resolveGauge` rejects. When there is one, only errors are
 * returned.
 *
 * Warnings (§2.2.5, research 01 §7):
 * - `W_GAUGE_RANGE` (the measurement in use): a count per 4 in — stitches, rows, tiles, test-ball stitches —
 *   more than 35% outside the CYC range carried to that count, or a count that a unit slip explains better
 *   than the yarn does (see `rangeIssue`). `hint` names the slip when exactly one fits.
 * - `W_GAUGE_ASPECT` (a swatch): `w/h` outside 0.75–1.5 for flat sc, or outside the technique's own window
 *   (`aspectWindow`) for tapestry, hdc and mosaic.
 * - `W_GAUGE_ROWS` (an `sc_graphgan` swatch): fewer rows than stitches (novelty yarn, tapestry or hdc).
 * - `W_GAUGE_HOOK`: a hook more than 2× away from the default hook (not in §2.2.5).
 * - `W_GAUGE_CARRIED`: more than 3 carried strands in tapestry without a swatch (not in §2.2.5).
 * - `W_GAUGE_LSC`: a calibrated yarn per stitch more than 35% from the model (not in §2.2.5: a unit slip there
 *   multiplies every yardage while narrowing its band to ±5%).
 */
export function checkGauge(g: GaugeSpec): GaugeIssue[] {
  const errors = inputErrors(g);
  if (errors.length > 0) return errors;

  const out: GaugeIssue[] = [];
  const name = TABLE_A[g.cyc].name;
  const refHook = defaultHookMm(g.cyc, g.technique);
  const yarnUnder = g.yarnUnder === true;
  // The table cell a measurement is compared with: at the default hook and, when the spec names another hook,
  // at that hook. (`carried` plays no part: it is not read when there is a swatch.)
  const cells = [defaultCell(g.cyc, g.technique, { yarnUnder })];
  if (present(g.hookMm) && g.hookMm !== refHook) cells.push(defaultCell(g.cyc, g.technique, { hookMm: g.hookMm, yarnUnder }));
  const per4 = (count: number, spanIn: Inches): number => (count * GAUGE_SPAN_IN) / spanIn;
  const measurement = measurementOf(g);

  if (measurement === 'swatch' && present(g.swatch)) {
    const s = g.swatch;
    const sts4 = per4(s.sts, s.spanIn);
    const rows4 = per4(s.rows, s.spanIn);
    const range = rangeIssue(
      g,
      'swatch',
      'This swatch',
      [
        { label: 'sts', value: sts4, expected: cells.map((c) => GAUGE_SPAN_IN / c.w), primary: true },
        { label: 'rows', value: rows4, expected: cells.map((c) => GAUGE_SPAN_IN / c.h), primary: false },
      ],
      UNIT_SLIPS,
    );
    if (range) out.push(range);

    const aspect = s.rows / s.sts; // w/h = (span/sts) / (span/rows)
    const [lo, hi] = aspectWindow(g.technique);
    if (aspect < lo || aspect > hi) {
      const lead = `${TECHNIQUE_NAME[g.technique]} stitches are usually ${g.technique === 'sc_graphgan' ? '0.75 to 1.5' : `${lo.toFixed(2)} to ${hi.toFixed(2)}`} times as wide as tall; this swatch gives ${aspect.toFixed(2)}.`;
      if (g.technique !== 'sc_graphgan') {
        out.push({
          code: 'W_GAUGE_ASPECT',
          severity: 'warn',
          field: 'swatch',
          hint: 'other-technique',
          message: `${lead} Check that the swatch was worked in this technique${isTapestry(g.technique) ? ', carrying the yarn inside the stitches' : ''}: a swatch of another stitch cannot size this project.`,
        });
      } else if (aspect < lo) {
        out.push({
          code: 'W_GAUGE_ASPECT',
          severity: 'warn',
          field: 'swatch',
          hint: 'taller-stitch',
          message: `${lead} Rows this tall suggest half double or double crochet (UK half treble or treble): in UK patterns "dc" means US sc.`,
        });
      } else {
        out.push({
          code: 'W_GAUGE_ASPECT',
          severity: 'warn',
          field: 'swatch',
          message: `${lead} Check both counts, and that stitches and rows were counted over the same length.`,
        });
      }
    }
    if (g.technique === 'sc_graphgan' && s.rows < s.sts) {
      out.push({
        code: 'W_GAUGE_ROWS',
        severity: 'warn',
        field: 'swatch',
        hint: 'tapestry-or-novelty',
        message: `Fewer rows than stitches over the same length (${fmt(rows4)} rows and ${fmt(sts4)} sts per 4 in) is unusual for plain single crochet: it happens with novelty yarns, with tapestry crochet (yarn carried inside the stitches) and when the swatch is half double crochet. Choose the technique the swatch was worked in.`,
      });
    }
  } else if (measurement === 'c2cSwatch' && present(g.c2cSwatch)) {
    const s = g.c2cSwatch;
    const range = rangeIssue(
      g,
      'c2cSwatch',
      'This C2C swatch',
      [{ label: 'tiles', value: per4(s.tiles, s.spanIn), expected: cells.map((c) => GAUGE_SPAN_IN / c.w), primary: true }],
      UNIT_SLIPS,
    );
    if (range) out.push(range);
  } else if (measurement === 'testBall' && present(g.testBall)) {
    const s = g.testBall;
    // A test ball is measured stuffed, so it is compared with the stuffed table width.
    const range = rangeIssue(
      g,
      'testBall',
      'This test ball',
      [{ label: 'sts', value: per4(s.maxSts, s.circumferenceIn), expected: cells.map((c) => GAUGE_SPAN_IN / (c.w * STUFFING_STRETCH.firm)), primary: true }],
      BALL_SLIPS,
    );
    if (range) out.push(range);
  }

  if (present(g.hookMm) && !inside(g.hookMm / refHook, HOOK_USUAL_RATIO)) {
    out.push({
      code: 'W_GAUGE_HOOK',
      severity: 'warn',
      field: 'hookMm',
      message: `A ${g.hookMm} mm hook is ${g.hookMm < refHook ? 'less than half' : 'more than twice'} the ${refHook} mm usual for ${name} yarn in this technique, so the stitch size is an extrapolation. Check the size (in millimetres, not a US number) or measure a swatch.`,
    });
  }

  if (isTapestry(g.technique) && !present(g.swatch) && present(g.carried) && g.carried > CARRIED_USUAL_MAX) {
    out.push({
      code: 'W_GAUGE_CARRIED',
      severity: 'warn',
      field: 'carried',
      message: `${fmt(g.carried)} carried strands is more than tapestry rows hold (3 colors per row); the 5% of extra height per strand is not validated there. Measure a swatch that carries the strands.`,
    });
  }

  if (present(g.lscCalibratedIn)) {
    const model = compute({ ...g, lscCalibratedIn: undefined }).lscIn;
    const ratio = g.lscCalibratedIn / model;
    if (!inside(ratio, [1 - LSC_SLACK, 1 + LSC_SLACK])) {
      const fits = lscSlips(g.technique).filter((s) => Math.abs(Math.log(ratio / s.factor)) <= HINT_TOL);
      const one = fits.length === 1 ? fits[0] : undefined;
      const issue: GaugeIssue = {
        code: 'W_GAUGE_LSC',
        severity: 'warn',
        field: 'lscCalibratedIn',
        message: `The calibrated yarn per stitch, ${g.lscCalibratedIn.toFixed(2)} in, is more than 35% away from the ${model.toFixed(2)} in expected for this yarn and hook. ${one ? one.advice : `Unravel ${CALIBRATION_STITCHES} single crochet again and measure the yarn they used, in the unit shown.`}`,
      };
      if (one) issue.hint = one.hint;
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
  if (issues.some((i) => i.severity === 'error')) return { gauge: undefined, issues };
  return { gauge: compute(g), issues };
}

// ---- reading a resolved gauge

/** The band every size display carries: `nominal × (1 ± tol)` (§2.2.5). */
export function sizeBand(nominalIn: Inches, tol: number): { low: Inches; high: Inches } {
  if (!nonNegative(nominalIn)) throw new RangeError(`sizeBand: the size must be a number ≥ 0, got ${show(nominalIn)}`);
  if (!(nonNegative(tol) && tol < 1)) throw new RangeError(`sizeBand: the tolerance must be a fraction in [0, 1), got ${show(tol)}`);
  return { low: nominalIn * (1 - tol), high: nominalIn * (1 + tol) };
}

/**
 * The size range of a hook override without a swatch (§2.2.2): the hook exponent is 0.75 ± 0.25, so a size that
 * is `nominalIn` at p = 0.75 lies between its values at p = 0.5 and p = 1.0. `refHookMm` is the technique's
 * default hook (`defaultHookMm`). With the default hook the range collapses to the nominal size.
 */
export function hookSizeRange(nominalIn: Inches, hookMm: number, refHookMm: number): { low: Inches; high: Inches } {
  if (!nonNegative(nominalIn)) throw new RangeError(`hookSizeRange: the size must be a number ≥ 0, got ${show(nominalIn)}`);
  const nominal = hookFactor(hookMm, refHookMm);
  const a = hookFactor(hookMm, refHookMm, HOOK_EXPONENT_RANGE[0]) / nominal;
  const b = hookFactor(hookMm, refHookMm, HOOK_EXPONENT_RANGE[1]) / nominal;
  if (!positive(a) || !positive(b)) throw new RangeError(`hookSizeRange: a ${hookMm} mm hook against ${refHookMm} mm is out of range`);
  return { low: nominalIn * Math.min(a, b), high: nominalIn * Math.max(a, b) };
}

/**
 * The stuffing stretch `s` of a piece (§2.2.3, §2.10.5): the gauge's own stretch for firm or medium stuffing
 * (1.05 from the tables, 1 when a test ball measured the stuffed fabric), 1 for light or no stuffing. Throws for
 * a stuffing that is not one of the four: a missing value must not size a piece as unstuffed.
 */
export function stuffingStretch(g: Pick<ResolvedGauge, 'stretch'>, stuffing: Stuffing): number {
  if (typeof stuffing !== 'string' || !Object.hasOwn(STUFFING_STRETCH, stuffing)) {
    throw new RangeError(`stuffingStretch: stuffing must be 'firm', 'medium', 'light' or 'none', got ${show(stuffing)}`);
  }
  if (!isObject(g) || !positive(g.stretch)) throw new RangeError(`stuffingStretch: the gauge needs a positive stretch, got ${show(g?.stretch)}`);
  return stuffing === 'firm' || stuffing === 'medium' ? g.stretch : 1;
}

/** The effective stitch of a stuffed piece: `wS = w·s`, `hS = h·s` — stretch is isotropic (§2.2.3). */
export function stuffedCell(g: Pick<ResolvedGauge, 'cell' | 'stretch'>, stuffing: Stuffing): { wS: Inches; hS: Inches } {
  const s = stuffingStretch(g, stuffing);
  if (!isObject(g.cell) || !positive(g.cell.w) || !positive(g.cell.h)) {
    throw new RangeError(`stuffedCell: the gauge needs a cell with a positive width and height, got ${show(g.cell?.w)} × ${show(g.cell?.h)}`);
  }
  return { wS: g.cell.w * s, hS: g.cell.h * s };
}

/** Stitches and rows (or tiles) per 4 in of a cell — the form a gauge is stated in. */
export function countsPer4In(cell: Cell): { sts4: number; rows4: number } {
  if (!isObject(cell) || !positive(cell.w) || !positive(cell.h)) {
    throw new RangeError(`countsPer4In: the cell must have positive sides, got ${show(cell?.w)} × ${show(cell?.h)}`);
  }
  const sts4 = GAUGE_SPAN_IN / cell.w;
  const rows4 = GAUGE_SPAN_IN / cell.h;
  if (!positive(sts4) || !positive(rows4)) throw new RangeError(`countsPer4In: the cell is out of range, got ${cell.w} × ${cell.h}`);
  return { sts4, rows4 };
}

/**
 * `GaugeSpec.swatch` from a swatch stated as "S stitches × R rows measure W × H" (research 01 §7, input mode b):
 * the frozen swatch type has one span, so the rows are restated over the width.
 */
export function swatchFromSize(o: { sts: number; rows: number; widthIn: Inches; heightIn: Inches }): NonNullable<GaugeSpec['swatch']> {
  if (!isObject(o) || !positive(o.sts) || !positive(o.rows) || !positive(o.widthIn) || !positive(o.heightIn)) {
    throw new RangeError(`swatchFromSize: stitches, rows, width and height must all be positive, got ${show(o?.sts)} × ${show(o?.rows)} over ${show(o?.widthIn)} × ${show(o?.heightIn)} in`);
  }
  const rows = (o.rows * o.widthIn) / o.heightIn;
  if (!positive(rows)) throw new RangeError('swatchFromSize: the swatch is out of range');
  return { sts: o.sts, rows, spanIn: o.widthIn };
}

/**
 * The yardage band of a gauge spec (§2.8): ±5% once `lscCalibratedIn` is set, ±10% with the technique's
 * measurement, otherwise ±25% (2D) or ±20% (amigurumi). Throws on a spec `resolveGauge` rejects.
 */
export function yardageBandFor(g: GaugeSpec): number {
  const errors = inputErrors(g);
  if (errors.length > 0) throw new RangeError(`yardageBandFor: ${errors[0].message}`);
  return yardageBand({
    technique: g.technique,
    source: measurementOf(g) ? 'swatch' : 'default',
    calibrated: present(g.lscCalibratedIn),
  });
}
