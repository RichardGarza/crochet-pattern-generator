// Yarn per stitch (DESIGN.md §2.2.4 "Table D model", §2.8; research 01 §6). Step 0 kernel: pure.
//
// These are the building blocks of the yardage formulas: the length of yarn in one stitch, the multipliers of
// the other stitches, carried strands, tails, the buffer, the band and the skein rule. The per-color totals of a
// chart or a toy are assembled from them by `core/yardage/twoD.ts` (T2) and `core/yardage/threeD.ts` (T4).
//
// The model is empirical: `L_sc = 6.5 · w_sc`, fitted to measured yarn per stitch (Interweave 6.3, Trock
// 6.0–6.6). Geometric yarn-path models overestimate by about 17% (research 01 §6.1), so none is used.
import type { Technique2D, TechniqueId } from '../../types/gauge';
import type { Cyc, Inches } from '../../types/units';
import { ceilTolerant } from './round';
import { amiCell, amiHookMm, scCell } from './tables';

function freeze<T extends object>(o: T): Readonly<T> {
  return Object.freeze(o);
}

function positive(x: number): boolean {
  return Number.isFinite(x) && x > 0;
}

function nonNegative(x: number): boolean {
  return Number.isFinite(x) && x >= 0;
}

export const IN_PER_YD = 36;
export const M_PER_YD = 0.9144;

// ---- §2.2.4: the per-stitch model

/** Inches of yarn in one sc per inch of sc stitch width: `L_sc = 6.5 · w_sc` (±15%). */
export const K_SC = 6.5;

/** Yarn of one stitch relative to one sc of the same yarn and hook (§2.2.4). */
export const MULT = freeze({ sc: 1, hdc: 1.45, dc: 2.0, ch: 0.42, slst: 0.5 } as const);
export type StitchKind = keyof typeof MULT;

/** A C2C tile is 3 dc + 3 ch + 1 sl st: `L_tile = 7.76 · L_sc` (§2.2.4). */
export const C2C_TILE_YARN_MULT = 3 * MULT.dc + 3 * MULT.ch + MULT.slst;

/**
 * Relative uncertainty of the Table D defaults: ±15% for sc, hdc and dc, ±35% for a C2C tile, ±20% for
 * amigurumi until the 10-stitch calibration of §2.8 is done (§2.2.4).
 */
export const YARN_PER_STITCH_TOL = freeze({ sc: 0.15, hdc: 0.15, dc: 0.15, c2cTile: 0.35, amigurumi: 0.2 } as const);

function calibrated(lscCalibratedIn: number | undefined, fn: string): number | undefined {
  if (lscCalibratedIn === undefined || lscCalibratedIn === null) return undefined;
  if (!positive(lscCalibratedIn)) {
    throw new RangeError(`${fn}: the calibrated yarn per stitch must be a positive length in inches, got ${lscCalibratedIn}`);
  }
  return lscCalibratedIn;
}

function checkedLsc(lscIn: number, fn: string): number {
  if (!positive(lscIn)) throw new RangeError(`${fn}: the yarn per sc must be a positive length in inches, got ${lscIn}`);
  return lscIn;
}

/**
 * `L_sc`: inches of yarn in one flat single crochet. `lscCalibratedIn ?? 6.5 · wScIn`, where `wScIn` is the sc
 * stitch width (`ResolvedGauge.wSc`: Table A after hook scaling, or the width measured on an sc swatch).
 */
export function lSc(wScIn: Inches, lscCalibratedIn?: number): number {
  const cal = calibrated(lscCalibratedIn, 'lSc');
  if (cal !== undefined) return cal;
  if (!positive(wScIn)) throw new RangeError(`lSc: the sc stitch width must be a positive length in inches, got ${wScIn}`);
  return K_SC * wScIn;
}

/**
 * `L_ami`: inches of yarn in one amigurumi sc. `lscCalibratedIn ?? 6.5 · max(w_sc(CYC, hook), w_ami(CYC, hook))`:
 * the flat-sc model at the amigurumi hook (Table A width × (hook / Table A hook)^0.75), or the Table E width ×
 * (hook / Table E hook)^0.75 if that is larger. `hookMm` defaults to the Table E hook. A tight stitch is narrower
 * because its loops are smaller, not because less yarn goes into it, so the hook scales the yarn, not the stitch
 * width (§2.2.4). ±20% until calibrated. Throws for CYC 0, which Table E does not cover.
 */
export function lAmi(cyc: Cyc, hookMm?: number, lscCalibratedIn?: number): number {
  const cal = calibrated(lscCalibratedIn, 'lAmi');
  const hook = hookMm === undefined || hookMm === null ? amiHookMm(cyc) : hookMm;
  const model = K_SC * Math.max(scCell(cyc, hook).w, amiCell(cyc, { hookMm: hook }).w);
  return cal ?? model;
}

/** Inches of yarn in one stitch of the given kind: `MULT[kind] · lscIn`. */
export function stitchYarnIn(lscIn: number, kind: StitchKind): number {
  if (typeof kind !== 'string' || !Object.hasOwn(MULT, kind)) throw new RangeError(`stitchYarnIn: unknown stitch '${String(kind)}'`);
  return MULT[kind] * checkedLsc(lscIn, 'stitchYarnIn');
}

/** Inches of yarn in one C2C tile: `7.76 · lscIn`. */
export function c2cTileYarnIn(lscIn: number): number {
  return C2C_TILE_YARN_MULT * checkedLsc(lscIn, 'c2cTileYarnIn');
}

/** Worked tapestry stitches are taller, so each uses `1.1 · L_sc` (§2.8). */
export const TAPESTRY_WORKED_MULT = 1.1;

/**
 * Inches of yarn worked into one chart cell of a 2D technique (§2.8 `worked_c`): sc graphgan and mosaic `L_sc`
 * (a mosaic X is a dc: `MULT.dc · L_sc`), tapestry `1.1 · L_sc`, hdc `1.45 · L_sc`, C2C `7.76 · L_sc` per tile.
 */
export function yarnPerCellIn(technique: Technique2D, lscIn: number): number {
  const l = checkedLsc(lscIn, 'yarnPerCellIn');
  switch (technique) {
    case 'sc_graphgan':
    case 'mosaic_overlay':
      return l;
    case 'sc_tapestry':
    case 'sc_tapestry_round':
      return TAPESTRY_WORKED_MULT * l;
    case 'hdc_graphgan':
      return MULT.hdc * l;
    case 'c2c':
      return C2C_TILE_YARN_MULT * l;
    default:
      throw new RangeError(`yarnPerCellIn: '${String(technique)}' is not a 2D technique`);
  }
}

export interface YarnPerStitchRow {
  sc: number;
  hdc: number;
  dc: number;
  c2cTile: number;
  /** `L_ami` at the Table E hook; undefined for CYC 0 (not offered for amigurumi). */
  amigurumi?: number;
}

/**
 * One row of Table D (§2.2.4): default yarn per stitch in inches at the table's hooks, computed from the
 * formulas (the spec prints it to 2 decimals).
 */
export function yarnPerStitchDefaults(cyc: Cyc): YarnPerStitchRow {
  const l = lSc(scCell(cyc).w);
  return {
    sc: l,
    hdc: MULT.hdc * l,
    dc: MULT.dc * l,
    c2cTile: C2C_TILE_YARN_MULT * l,
    amigurumi: cyc === 0 ? undefined : lAmi(cyc),
  };
}

// ---- §2.8: carried strands, tails and the fixed extras

/** A strand carried through (or floated behind) one stitch uses `1.1 ×` that stitch's width (§2.8). */
export const CARRIED_PER_WIDTH = 1.1;

/**
 * Inches of yarn carried through `cells` stitches of width `wCellIn`: tapestry (cells of a row not worked in the
 * carried color), short graphgan carries (gap stitches) and floats inside amigurumi rounds.
 */
export function carriedYarnIn(cells: number, wCellIn: Inches): number {
  if (!nonNegative(cells)) throw new RangeError(`carriedYarnIn: the cell count must be a number ≥ 0, got ${cells}`);
  if (!positive(wCellIn)) throw new RangeError(`carriedYarnIn: the stitch width must be a positive length in inches, got ${wCellIn}`);
  return cells * CARRIED_PER_WIDTH * wCellIn;
}

/** Length of one yarn tail, inches (§2.8). */
export const TAIL_IN = 6;

/** Inches of yarn in the tails of `starts` strands, bobbins, C2C regions or joins: two 6 in tails each. */
export function tailsIn(starts: number): number {
  if (!nonNegative(starts)) throw new RangeError(`tailsIn: the number of starts must be a number ≥ 0, got ${starts}`);
  return starts * 2 * TAIL_IN;
}

/** A joined round costs one ch 1 and one sl st: `0.92 · L` (border rounds §2.7.10, joined rounds §2.11.3). */
export const JOINED_ROUND_YARN_MULT = MULT.ch + MULT.slst;
/** Amigurumi: each decrease costs `0.2 · L_ami` on top of the stitch it produces (§2.8). */
export const DEC_EXTRA_YARN_MULT = 0.2;
/** Amigurumi: inches of yarn in one magic ring (§2.8). */
export const MAGIC_RING_IN = 3;
/** Amigurumi embroidery, inches: 24 per pair of embroidered eyes, 12 per other feature (§2.8). */
export const EMBROIDERY_IN = freeze({ eyePair: 24, feature: 12 } as const);

// ---- §2.8: buffer, band, skeins

/** `buffer`: 0.10 single-color piece; 0.15 default; 0.20 for C2C, tapestry, or more than 50 strands (§2.8). */
export const YARDAGE_BUFFER = freeze({ singleColor: 0.1, standard: 0.15, complex: 0.2 } as const);
/** More strands than this in total raises the buffer to 0.20. */
export const MANY_STRANDS = 50;

/**
 * The yardage buffer of a piece (§2.8). Amigurumi always uses 0.15. For 2D the higher buffer wins: C2C and
 * tapestry use 0.20 even with one color (their per-stitch model is the least certain), as does any piece with
 * more than 50 strands; otherwise a single-color piece uses 0.10 and everything else 0.15.
 */
export function yardageBuffer(o: { technique: TechniqueId; colors: number; strands?: number }): number {
  if (o.technique === 'amigurumi_sc') return YARDAGE_BUFFER.standard;
  if (o.technique === 'c2c' || o.technique === 'sc_tapestry' || o.technique === 'sc_tapestry_round') return YARDAGE_BUFFER.complex;
  if ((o.strands ?? 0) > MANY_STRANDS) return YARDAGE_BUFFER.complex;
  return o.colors <= 1 ? YARDAGE_BUFFER.singleColor : YARDAGE_BUFFER.standard;
}

/**
 * `band` (§2.8): 2D ±25% with the default gauge, 3D ±20% (Table E is calibrated for worsted only); ±10% with a
 * swatch or a test ball; ±5% after the "unravel 10 stitches" calibration.
 */
export const YARDAGE_BAND = freeze({ default2d: 0.25, default3d: 0.2, measured: 0.1, calibrated: 0.05 } as const);

/**
 * The yardage band of a gauge (§2.8). `source` is `ResolvedGauge.source`; `calibrated` says whether
 * `GaugeSpec.lscCalibratedIn` was set (a `ResolvedGauge` does not record that — see `yardageBandFor` in
 * resolve.ts for the form that takes the `GaugeSpec`).
 */
export function yardageBand(o: { technique: TechniqueId; source: 'default' | 'swatch'; calibrated?: boolean }): number {
  if (o.calibrated) return YARDAGE_BAND.calibrated;
  if (o.source === 'swatch') return YARDAGE_BAND.measured;
  return o.technique === 'amigurumi_sc' ? YARDAGE_BAND.default3d : YARDAGE_BAND.default2d;
}

/** `yards = inches / 36 × (1 + buffer)` (§2.8). */
export function inchesToYards(inches: number, buffer: number = 0): number {
  if (!nonNegative(inches)) throw new RangeError(`inchesToYards: the yarn length must be a number ≥ 0, got ${inches}`);
  if (!nonNegative(buffer)) throw new RangeError(`inchesToYards: the buffer must be a number ≥ 0, got ${buffer}`);
  return (inches / IN_PER_YD) * (1 + buffer);
}

/** `yardsLow, yardsHigh = yards × (1 ∓ band)` (§2.8). */
export function yardRange(yards: number, band: number): { low: number; high: number } {
  if (!nonNegative(yards)) throw new RangeError(`yardRange: yards must be a number ≥ 0, got ${yards}`);
  if (!(nonNegative(band) && band < 1)) throw new RangeError(`yardRange: the band must be a fraction in [0, 1), got ${band}`);
  return { low: yards * (1 - band), high: yards * (1 + band) };
}

/**
 * `skeins = ceil(yardsHigh / skeinYards)` (§2.8, D9): buy for the high end of the band, because a second dye
 * lot rarely matches. Pass `yardRange(...).high`.
 */
export function skeinsToBuy(yardsHigh: number, skeinYards: number): number {
  if (!nonNegative(yardsHigh)) throw new RangeError(`skeinsToBuy: yards must be a number ≥ 0, got ${yardsHigh}`);
  if (!positive(skeinYards)) throw new RangeError(`skeinsToBuy: the skein length must be a positive number of yards, got ${skeinYards}`);
  const n = ceilTolerant(yardsHigh / skeinYards);
  if (!Number.isSafeInteger(n)) throw new RangeError(`skeinsToBuy: ${yardsHigh} yd in skeins of ${skeinYards} yd is out of range`);
  return n;
}

/** `grams = yards / ydPer100g × 100` (§2.8). Without ball-band data use `TABLE_A[cyc].ydPer100g`. */
export function gramsFor(yards: number, ydPer100g: number): number {
  if (!nonNegative(yards)) throw new RangeError(`gramsFor: yards must be a number ≥ 0, got ${yards}`);
  if (!positive(ydPer100g)) throw new RangeError(`gramsFor: yards per 100 g must be a positive number, got ${ydPer100g}`);
  return (yards / ydPer100g) * 100;
}

export function yardsToMeters(yards: number): number {
  return yards * M_PER_YD;
}

/** The calibration of §2.8 unravels this many stitches. */
export const CALIBRATION_STITCHES = 10;

/**
 * `GaugeSpec.lscCalibratedIn` from "unravel 10 stitches and measure the yarn: __ in" (§2.8, §4.5): the measured
 * length divided by the number of stitches.
 */
export function lscFromUnravel(lengthIn: Inches, stitches: number = CALIBRATION_STITCHES): number {
  if (!positive(lengthIn)) throw new RangeError(`lscFromUnravel: the yarn length must be a positive length in inches, got ${lengthIn}`);
  if (!positive(stitches)) throw new RangeError(`lscFromUnravel: the stitch count must be a positive number, got ${stitches}`);
  return lengthIn / stitches;
}
