// Track T7 — the units rule of geometry-only carriers (DESIGN.md §3.7.5): OBJ, PLY, STL and GLB ladder steps 3–4
// carry no unit, so the raw bounding-box height `h` is read four ways ({in: h, cm: h/2.54, m: h·39.37, mm: h/25.4},
// in inches) and one reading is chosen BEFORE fitting and before the dims clamp of §3.7.6 (v1.1 read a builder-v1
// export 0.25 units tall as 0.25 in, and the clamp then blew a 0.2 in eye up tenfold).
//
// Order: the user's answer (`ctx.units`) → the exact glTF accessor/extras ratio → the project's expected height
// (closest reading within ×/÷ 1.5, else normalize to it and confirm) → no expected height: the three-d-stage MTL
// header with h ≤ 1.524 ⇒ meters, h < 1.5 ⇒ meters (both confirmed, pre-set to meters), otherwise inches — and,
// beyond §3.7.5, an inches reading above the 60 in limit tries millimeters, then centimeters (confirmed).
import type { ImportContext, LengthUnit, UnitsDecision } from '../../types/importer';
import { MODEL_LIMITS } from '../model/limits';
import { roundCoord } from '../model/transforms';

/** Inches per one raw unit. `m` is 39.37 as §3.7.5 writes it (1/0.0254 = 39.3701: the same to 3e-6). */
export const INCHES_PER_UNIT: Readonly<Record<LengthUnit, number>> = { in: 1, cm: 1 / 2.54, m: 1 / 0.0254, mm: 1 / 25.4 };

/** "within ×/÷ 1.5 of E ⇒ automatic" (§3.7.5). */
export const EXPECTED_HEIGHT_FACTOR = 1.5;
/** "the three-d-stage MTL header and h ≤ 1.524" (a meter reading within the 60 in limit). */
export const STAGE_HEADER_MAX_M = 1.524;
/** `ctx.expectedHeightIn` below this is ignored. */
export const MIN_EXPECTED_IN = 0.1;
/** "otherwise h < 1.5 ⇒ meters". */
export const SMALL_BBOX_MAX = 1.5;

const UNIT_ORDER: readonly LengthUnit[] = ['in', 'cm', 'm', 'mm'];

const UNIT_WORD: Readonly<Record<LengthUnit, string>> = { in: 'inches', cm: 'centimeters', m: 'meters', mm: 'millimeters' };

/** The four readings of a raw height, in inches, in the order in, cm, m, mm. */
export function unitReadings(rawHeight: number): UnitsDecision['readings'] {
  return UNIT_ORDER.map((unit) => ({ unit, heightIn: rawHeight * INCHES_PER_UNIT[unit] }));
}

export interface UnitsChoice {
  decision: UnitsDecision;
  /** Inches per raw unit: multiply every raw coordinate by it. */
  factor: number;
  /** The `units` chip text ("read as meters: 0.251 → 9.88 in"). */
  message: string;
}

export interface UnitsHints {
  /** The OBJ's MTL starts with `# Exported by three-d-stage` (the stage documents meters). */
  stageHeader?: boolean;
  /**
   * GLB ladder step 3: scene units per spec unit, measured exactly from the POSITION accessors and
   * `extras.dimensions` (the spec unit is the inch, §3.4 rule 2).
   */
  sceneUnitsPerInch?: number;
}

const fmt = (x: number, digits = 3): string => String(roundCoord(x, digits));

function nearestUnit(inchesPerRaw: number): { unit: LengthUnit; off: number } {
  let best: { unit: LengthUnit; off: number } = { unit: 'in', off: Infinity };
  for (const unit of UNIT_ORDER) {
    const off = Math.abs(Math.log(inchesPerRaw / INCHES_PER_UNIT[unit]));
    if (off < best.off) best = { unit, off };
  }
  return best;
}

/**
 * §3.7.5: which unit the raw coordinates are in. `rawHeight` is the bounding-box height in raw units (> 0).
 * `confirm` asks the user, showing the readings; the answer comes back as `ctx.units`.
 */
export function decideUnits(rawHeight: number, ctx: ImportContext = {}, hints: UnitsHints = {}): UnitsChoice {
  const h = rawHeight;
  const readings = unitReadings(h);
  const make = (chosen: UnitsDecision['chosen'], reason: UnitsDecision['reason'], factor: number, confirm: boolean, message: string): UnitsChoice => ({
    decision: { rawHeight: h, readings, chosen, reason, confirm },
    factor,
    message,
  });
  const result = (heightIn: number): string => `${fmt(h)} → ${fmt(heightIn, 2)} in tall`;

  if (ctx.units !== undefined && Object.hasOwn(INCHES_PER_UNIT, ctx.units)) {
    const f = INCHES_PER_UNIT[ctx.units];
    return make(ctx.units, 'user', f, false, `read as ${UNIT_WORD[ctx.units]}, as you chose: ${result(h * f)}`);
  }
  const k = hints.sceneUnitsPerInch;
  if (k !== undefined && Number.isFinite(k) && k > 0) {
    const f = 1 / k;
    const near = nearestUnit(f);
    // the ratio is exact: it is applied as measured; the unit is named only when it is one (within 2%)
    const chosen = near.off <= Math.log(1.02) ? near.unit : 'normalized';
    const what = chosen === 'normalized' ? `${fmt(k, 4)} scene units per inch` : UNIT_WORD[chosen];
    return make(chosen, 'gltf-extras-ratio', f, false, `read as ${what} (measured from the parts' own sizes): ${result(h * f)}`);
  }
  const E = ctx.expectedHeightIn;
  // a project height outside the schema's range is not a height to go by (0.1 in: a bead; 60 in: §3.5.2)
  if (E !== undefined && Number.isFinite(E) && E >= MIN_EXPECTED_IN && E <= MODEL_LIMITS.maxHeightIn) {
    let best = readings[0];
    for (const r of readings) if (Math.abs(Math.log(r.heightIn / E)) < Math.abs(Math.log(best.heightIn / E))) best = r;
    if (Math.abs(Math.log(best.heightIn / E)) <= Math.log(EXPECTED_HEIGHT_FACTOR)) {
      const f = INCHES_PER_UNIT[best.unit];
      return make(best.unit, 'expected-height', f, false, `read as ${UNIT_WORD[best.unit]} (the project is about ${fmt(E, 2)} in tall): ${result(best.heightIn)}`);
    }
    // 05 §7.3: "otherwise normalize to the user's target height" — and ask
    return make('normalized', 'expected-height', E / h, true, `no unit gives a size near the project's ${fmt(E, 2)} in: scaled to ${fmt(E, 2)} in tall (it was ${fmt(h)} units)`);
  }
  if (hints.stageHeader === true && h <= STAGE_HEADER_MAX_M) {
    const f = INCHES_PER_UNIT.m;
    return make('m', 'stage-header', f, true, `read as meters (the three-d-stage export works in meters): ${result(h * f)}`);
  }
  if (h < SMALL_BBOX_MAX) {
    const f = INCHES_PER_UNIT.m;
    return make('m', 'small-bbox', f, true, `read as meters (${fmt(h)} would be too small a toy in inches): ${result(h * f)}`);
  }
  if (h > MODEL_LIMITS.maxHeightIn) {
    // beyond the 60 in limit as inches (an STL in millimeters, a scan in centimeters): the first of mm, cm that
    // gives a toy within the limits, and ask
    for (const unit of ['mm', 'cm'] as const) {
      const f = INCHES_PER_UNIT[unit];
      const heightIn = h * f;
      if (heightIn >= 1 && heightIn <= MODEL_LIMITS.maxHeightIn) {
        return make(unit, 'default', f, true, `read as ${UNIT_WORD[unit]} (${fmt(h, 1)} in would be beyond the ${MODEL_LIMITS.maxHeightIn} in limit): ${result(heightIn)}`);
      }
    }
    return make('in', 'default', 1, true, `read as inches: ${fmt(h, 2)} in tall (beyond the ${MODEL_LIMITS.maxHeightIn} in limit: it will be scaled down)`);
  }
  // inches, the schema's unit
  return make('in', 'default', 1, false, `read as inches: ${fmt(h, 2)} in tall`);
}
