// Gauge tables (DESIGN.md §2.2.1–2.2.3; research 01 §1.1, §1.4, §3.7, §8). Step 0 kernel: pure data plus the
// three transforms every gauge formula starts from (hook scaling, Table B, Table E).
//
// Conventions (§0.1): lengths are inches; a gauge is stated per 4 in; `w` = width of one stitch, `h` = height of
// one row or round; the aspect is quoted as w/h. Every table carries the uncertainty the spec prints with it,
// because these numbers end up as the size of a blanket or a toy in someone's hands.
import type { Cell, Technique2D, TechniqueId } from '../../types/gauge';
import type { Cyc, Inches } from '../../types/units';
import { freeze, isCyc, isObject, nonNegative, positive, present, show } from './checks';

// ---- units

/** 1 in = 2.54 cm, exactly (§0.1). */
export const CM_PER_IN = 2.54;
/** Gauges are stated over this span: 4 in (= 10.16 cm). */
export const GAUGE_SPAN_IN = 4;

export function inToCm(inches: Inches): number {
  return inches * CM_PER_IN;
}

export function cmToIn(cm: number): Inches {
  return cm / CM_PER_IN;
}

// ---- Table A: base flat sc gauge by CYC weight (§2.2.1)

/** Every CYC weight, 0 Lace … 7 Jumbo. */
export const CYCS: readonly Cyc[] = freeze<Cyc[]>([0, 1, 2, 3, 4, 5, 6, 7]);

export interface TableARow {
  /** CYC category name as §2.2.1 prints it. */
  name: string;
  /** Default hook for flat work, mm. */
  hookMm: number;
  /** Single crochet stitches per 4 in. */
  sts4: number;
  /** Single crochet rows per 4 in. */
  rows4: number;
  /** 1σ-ish relative size uncertainty without a swatch (0.12 = ±12%). */
  tol: number;
  /** Fallback yards per 100 g, used only when the yarn has no ball-band data. */
  ydPer100g: number;
}

/** Table A (§2.2.1): `w = 4 / sts4`, `h = 4 / rows4`. */
export const TABLE_A: Readonly<Record<Cyc, Readonly<TableARow>>> = freeze({
  0: freeze({ name: 'Lace', hookMm: 2.25, sts4: 34, rows4: 40, tol: 0.25, ydPer100g: 700 }),
  1: freeze({ name: 'Super Fine', hookMm: 3.25, sts4: 24, rows4: 28, tol: 0.15, ydPer100g: 400 }),
  2: freeze({ name: 'Fine', hookMm: 4.0, sts4: 18, rows4: 21, tol: 0.2, ydPer100g: 330 }),
  3: freeze({ name: 'Light (DK)', hookMm: 4.0, sts4: 16, rows4: 19, tol: 0.12, ydPer100g: 280 }),
  4: freeze({ name: 'Medium (worsted)', hookMm: 5.0, sts4: 13.5, rows4: 16, tol: 0.12, ydPer100g: 190 }),
  5: freeze({ name: 'Bulky', hookMm: 6.5, sts4: 10.5, rows4: 12, tol: 0.15, ydPer100g: 120 }),
  6: freeze({ name: 'Super Bulky', hookMm: 8.0, sts4: 7.5, rows4: 8.5, tol: 0.15, ydPer100g: 70 }),
  7: freeze({ name: 'Jumbo', hookMm: 15, sts4: 4, rows4: 4.2, tol: 0.35, ydPer100g: 15 }),
});

export interface CycRange {
  /** Lower end of the published range; undefined where CYC gives only an upper limit (Jumbo: "≤ 6"). */
  lo?: number;
  hi: number;
  /** The stitch the range is published in: single crochet, except Lace (double crochet). */
  stitch: 'sc' | 'dc';
}

/**
 * The gauge ranges CYC publishes, stitches per 4 in (§2.2.1, research 01 §1.1). Used only for the sanity
 * warnings of §2.2.5. CYC publishes stitch counts only, never row counts; the Lace range is in double crochet.
 */
export const CYC_RANGE: Readonly<Record<Cyc, Readonly<CycRange>>> = freeze({
  0: freeze({ lo: 32, hi: 42, stitch: 'dc' }),
  1: freeze({ lo: 21, hi: 32, stitch: 'sc' }),
  2: freeze({ lo: 16, hi: 20, stitch: 'sc' }),
  3: freeze({ lo: 12, hi: 17, stitch: 'sc' }),
  4: freeze({ lo: 11, hi: 14, stitch: 'sc' }),
  5: freeze({ lo: 8, hi: 11, stitch: 'sc' }),
  6: freeze({ lo: 7, hi: 9, stitch: 'sc' }),
  7: freeze({ hi: 6, stitch: 'sc' }),
});

/** A measured count may leave the CYC range by this much before §2.2.5 warns (±35%). */
export const RANGE_SLACK = 0.35;

// ---- hooks (§2.2.1, research 01 §1.4)

export interface HookLabel {
  mm: number;
  /** US size as CYC prints it ('H-8', 'K-10½', '7', 'P/Q'). */
  us: string;
}

/** Hook sizes mm → US label, ascending (§2.2.1). */
export const HOOK_LABELS: readonly Readonly<HookLabel>[] = freeze(
  (
    [
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
    ] as const
  ).map(([mm, us]) => freeze({ mm, us })),
);

/**
 * The sizes §2.2.1 names, ascending: every labelled size plus 2.0 and 2.5 mm, which have no US letter and print
 * as mm only (Table E uses 2.5 mm). A hook picker starts from these; any other size in mm is valid too.
 */
export const HOOK_SIZES_MM: readonly number[] = freeze(
  [...HOOK_LABELS.map((l) => l.mm), 2.0, 2.5].sort((a, b) => a - b),
);

/** The US label of a hook size ('H-8' for 5), or undefined for a size without one (2.0, 2.5, 7 mm, …). */
export function hookUsLabel(mm: number): string | undefined {
  for (const l of HOOK_LABELS) if (Math.abs(l.mm - mm) < 0.005) return l.us;
  return undefined;
}

/** Hook override without a swatch: both `w` and `h` scale by `(hook / refHook)^p` with p = 0.75 (§2.2.2). */
export const HOOK_EXPONENT = 0.75;
/** The exponent is only known to ±0.25: sizes are shown for p = 0.5 … 1.0 (§2.2.2, research 01 §4.4). */
export const HOOK_EXPONENT_RANGE: readonly [number, number] = freeze([0.5, 1.0] as const);

/**
 * `(hookMm / refHookMm)^p`. For p = 0.75, 0.5 and 1 it is computed with square roots only, which IEEE 754 rounds
 * correctly, so the result is the same on every engine (`Math.pow` is not required to be). Throws when a hook is
 * not a positive size or the factor is not a usable number (a ratio that underflows or overflows).
 */
export function hookFactor(hookMm: number, refHookMm: number, p: number = HOOK_EXPONENT): number {
  if (!positive(hookMm)) throw new RangeError(`hookFactor: hook must be a positive size in mm, got ${show(hookMm)}`);
  if (!positive(refHookMm)) throw new RangeError(`hookFactor: reference hook must be a positive size in mm, got ${show(refHookMm)}`);
  if (typeof p !== 'number' || !Number.isFinite(p)) throw new RangeError(`hookFactor: exponent must be a finite number, got ${show(p)}`);
  const r = hookMm / refHookMm;
  const f = p === 0.75 ? Math.sqrt(r) * Math.sqrt(Math.sqrt(r)) : p === 0.5 ? Math.sqrt(r) : p === 1 ? r : Math.pow(r, p);
  if (!positive(f)) throw new RangeError(`hookFactor: a ${hookMm} mm hook against ${refHookMm} mm is out of range`);
  return f;
}

function tableA(cyc: Cyc): Readonly<TableARow> {
  if (!isCyc(cyc)) throw new RangeError(`CYC yarn weight must be an integer 0–7, got ${show(cyc)}`);
  return TABLE_A[cyc];
}

/**
 * The flat single crochet cell of a yarn weight: Table A, scaled by the hook factor when `hookMm` differs from
 * the Table A hook. This is `w_sc(CYC, hook)` of §2.2.4.
 */
export function scCell(cyc: Cyc, hookMm?: number): Cell {
  const a = tableA(cyc);
  const f = present(hookMm) ? hookFactor(hookMm, a.hookMm) : 1;
  return { w: (GAUGE_SPAN_IN / a.sts4) * f, h: (GAUGE_SPAN_IN / a.rows4) * f };
}

// ---- Table B: technique transforms and stitch aspect (§2.2.2)

/** Tapestry sc: `h = w / 0.88`, taller than wide. */
export const TAPESTRY_ASPECT = 0.88;
/** Each carried strand beyond the first makes a tapestry stitch 5% taller. */
export const TAPESTRY_EXTRA_PER_STRAND = 0.05;
/** hdc: `1.05w × 1.5h`. */
export const HDC_WIDTH_MULT = 1.05;
export const HDC_HEIGHT_MULT = 1.5;
/** C2C: a square tile with side `2.6w`. */
export const C2C_TILE_WIDTH_MULT = 2.6;
/** Overlay mosaic: `h = w / 1.3`. */
export const MOSAIC_ASPECT = 1.3;

export interface TableBRow {
  /** Stitch aspect w/h as §2.2.2 prints it (for `sc_graphgan` the label median; the cell itself is Table A's). */
  aspect: number;
  /**
   * The constant the row's formula uses, with the range observed for it — the row's uncertainty band.
   * `aspect` = w/h; `heightMult` = row height ÷ sc row height; `tileMult` = tile side ÷ sc width.
   */
  constant: { name: 'aspect' | 'heightMult' | 'tileMult'; value: number; lo: number; hi: number };
  note: string;
}

/**
 * Table B (§2.2.2) with the bands of research 01 §8 Table B. `sc_graphgan`'s band is the interquartile range of
 * 91 smooth-yarn labels; the others are the spread of the handful of published gauges each constant rests on.
 */
export const TABLE_B: Readonly<Record<TechniqueId, Readonly<TableBRow>>> = freeze({
  sc_graphgan: freeze({
    aspect: 1.18,
    constant: freeze({ name: 'aspect', value: 1.18, lo: 1.1, hi: 1.25 } as const),
    note: 'nothing carried; wider than tall',
  }),
  sc_tapestry: freeze({
    aspect: TAPESTRY_ASPECT,
    constant: freeze({ name: 'aspect', value: TAPESTRY_ASPECT, lo: 0.84, hi: 1.0 } as const),
    note: 'carried strands make stitches taller than wide',
  }),
  sc_tapestry_round: freeze({
    aspect: TAPESTRY_ASPECT,
    constant: freeze({ name: 'aspect', value: TAPESTRY_ASPECT, lo: 0.84, hi: 1.0 } as const),
    note: 'carried strands make stitches taller than wide',
  }),
  hdc_graphgan: freeze({
    aspect: 0.83,
    constant: freeze({ name: 'heightMult', value: HDC_HEIGHT_MULT, lo: 1.45, hi: 1.65 } as const),
    note: 'P1',
  }),
  c2c: freeze({
    aspect: 1.0,
    constant: freeze({ name: 'tileMult', value: C2C_TILE_WIDTH_MULT, lo: 2.0, hi: 2.9 } as const),
    note: 'square tile; worsted ≈ 0.77 in (observed 0.67–0.86)',
  }),
  mosaic_overlay: freeze({
    aspect: MOSAIC_ASPECT,
    constant: freeze({ name: 'aspect', value: MOSAIC_ASPECT, lo: 1.0, hi: 1.5 } as const),
    note: 'P1',
  }),
  amigurumi_sc: freeze({
    aspect: 1.05,
    constant: freeze({ name: 'aspect', value: 1.05, lo: 0.82, hi: 1.11 } as const),
    note: 'Table E; 1.05 yarn over, 1.11 yarn under',
  }),
});

/**
 * Table B (§2.2.2): the cell of a 2D technique from the flat sc cell of the same yarn and hook.
 * `carried` = strands carried inside the stitches (tapestry only; default 1, each further strand adds 5% height).
 * Throws when the sc cell does not have positive sides or `carried` is not a number ≥ 0.
 */
export function techniqueCell(sc: Cell, technique: Technique2D, carried: number = 1): Cell {
  if (!isObject(sc) || !positive(sc.w) || !positive(sc.h)) {
    throw new RangeError(`techniqueCell: the sc cell needs a positive width and height in inches, got ${show(sc?.w)} × ${show(sc?.h)}`);
  }
  if (!nonNegative(carried)) throw new RangeError(`techniqueCell: the number of carried strands must be 0 or more, got ${show(carried)}`);
  const { w, h } = sc;
  switch (technique) {
    case 'sc_graphgan':
      return { w, h };
    case 'sc_tapestry':
    case 'sc_tapestry_round':
      return { w, h: (w / TAPESTRY_ASPECT) * (1 + TAPESTRY_EXTRA_PER_STRAND * Math.max(0, carried - 1)) };
    case 'hdc_graphgan':
      return { w: HDC_WIDTH_MULT * w, h: HDC_HEIGHT_MULT * h };
    case 'c2c': {
      const tile = C2C_TILE_WIDTH_MULT * w;
      return { w: tile, h: tile };
    }
    case 'mosaic_overlay':
      return { w, h: w / MOSAIC_ASPECT };
    default:
      throw new RangeError(`techniqueCell: ${show(technique)} is not a 2D technique`);
  }
}

// ---- Table E: amigurumi, tight sc in rounds (§2.2.3)

/** The weights amigurumi is offered in: CYC 1–7 (Table E has no Lace row). */
export type AmiCyc = Exclude<Cyc, 0>;
export const AMI_CYCS: readonly AmiCyc[] = freeze<AmiCyc[]>([1, 2, 3, 4, 5, 6, 7]);

export interface TableERow {
  /** Default amigurumi hook, mm (about 2 mm under the CYC minimum hook). */
  hookMm: number;
  /** Stitch width before stuffing, inches. */
  wIn: Inches;
  /** Size tolerance of the defaults (research 01 §5.4: worsted is calibrated; the other weights are not). */
  tol: number;
}

/** Table E (§2.2.3). Calibrated against published sizes for worsted only (§7.2 Q2). */
export const TABLE_E: Readonly<Record<AmiCyc, Readonly<TableERow>>> = freeze({
  1: freeze({ hookMm: 2.25, wIn: 0.13, tol: 0.2 }),
  2: freeze({ hookMm: 2.5, wIn: 0.155, tol: 0.2 }),
  3: freeze({ hookMm: 2.75, wIn: 0.17, tol: 0.2 }),
  4: freeze({ hookMm: 3.5, wIn: 0.195, tol: 0.1 }),
  5: freeze({ hookMm: 4.5, wIn: 0.26, tol: 0.2 }),
  6: freeze({ hookMm: 6.0, wIn: 0.33, tol: 0.2 }),
  7: freeze({ hookMm: 9, wIn: 0.5, tol: 0.2 }),
});

/** Amigurumi stitch aspect w/h: `h = w / 1.05` (yarn over, default) or `w / 1.11` (yarn under) (§2.2.3, D17). */
export const AMI_ASPECT = freeze({ yarnOver: 1.05, yarnUnder: 1.11 } as const);

export type Stuffing = 'firm' | 'medium' | 'light' | 'none';

/**
 * Stuffing stretch `s` (§2.2.3): 1.05 for firm or medium stuffing, 1.00 for light or none (ears, flat pieces).
 * Applied isotropically: `wS = w·s`, `hS = h·s`.
 */
export const STUFFING_STRETCH: Readonly<Record<Stuffing, number>> = freeze({ firm: 1.05, medium: 1.05, light: 1, none: 1 });

function tableE(cyc: Cyc): Readonly<TableERow> {
  if (!isCyc(cyc, 1)) {
    throw new RangeError(
      cyc === 0
        ? 'CYC 0 (Lace) is not offered for amigurumi: Table E has no row for it. Choose CYC 1–7.'
        : `CYC yarn weight must be an integer 1–7 for amigurumi, got ${show(cyc)}`,
    );
  }
  return TABLE_E[cyc as AmiCyc];
}

/** The Table E hook of a yarn weight. Throws for CYC 0. */
export function amiHookMm(cyc: Cyc): number {
  return tableE(cyc).hookMm;
}

/**
 * The amigurumi cell before stuffing: Table E width, scaled by the hook factor when `hookMm` differs from the
 * Table E hook; `h = w / 1.05` (or `/ 1.11` with yarn under). This is `w_ami(CYC, hook)` of §2.2.4. Throws for
 * CYC 0.
 *
 * Each weight scales from its own Table E hook, so at one fixed hook a finer yarn does not always give a
 * narrower stitch (3.5 mm: worsted 0.195 in, DK 0.204 in). A caller that changes the yarn weight should drop the
 * hook override with it.
 */
export function amiCell(cyc: Cyc, o: { hookMm?: number; yarnUnder?: boolean } = {}): Cell {
  const e = tableE(cyc);
  const hookMm = o?.hookMm;
  const f = present(hookMm) ? hookFactor(hookMm, e.hookMm) : 1;
  const w = e.wIn * f;
  return { w, h: w / (o?.yarnUnder === true ? AMI_ASPECT.yarnUnder : AMI_ASPECT.yarnOver) };
}

// ---- measured gauges

/** Relative size uncertainty once the gauge is measured: ±4% (§2.2.5; ±0.5 stitch over 4 in at 13 sts is ±3.8%). */
export const SWATCH_TOL = 0.04;
