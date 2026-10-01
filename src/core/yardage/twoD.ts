// Track T2 — yardage and materials of a 2D piece, per color (DESIGN.md §2.8), from the per-stitch building blocks
// of the gauge kernel (core/gauge/yarnPerStitch.ts; docs/tracks/s0b-gauge.md "How the other tracks use it").
//
//   yards_c = (worked_c + carried_c + tails_c + extra_c) / 36 × (1 + buffer)
//   worked_c   cells · yarnPerCellIn(technique, L_sc) (sc L, tapestry 1.1 L, hdc 1.45 L, C2C tile 7.76 L)
//              + chains · 0.42 L + sl sts · 0.5 L (foundation, turning chains, joins of rounds: the color that makes them)
//   carried_c  carried stitches · 1.1 · w_cell (tapestry: every stitch of a line not worked in c while c is held;
//              graphgan: the gaps a strand is carried across)
//   tails_c    starts · 2 · 6 in (strands started / tapestry joins / C2C regions)
//   extra_c    the border, charged to its color: border sts · L + rounds · 0.92 L + 12 in
//   buffer     yardageBuffer({ technique, colors, strands }); band yardageBand({ technique, source, calibrated })
//   skeins     ceil(yardsHigh / skeinYards) (buy for the high end); grams = yards / ydPer100g × 100
import type { MaterialsLine, PaletteEntry, ResolvedGauge, Technique2D, Yarn } from '../../types';
import {
  JOINED_ROUND_YARN_MULT,
  carriedYarnIn,
  gramsFor,
  inchesToYards,
  skeinsToBuy,
  stitchYarnIn,
  tailsIn,
  yardageBand,
  yardageBuffer,
  yardRange,
  yardsToMeters,
  yarnPerCellIn,
} from '../gauge/yarnPerStitch';

/** What one color does in a piece. */
export interface ColorWork {
  /** Chart cells worked in the color (C2C: tiles). */
  cells: number;
  /** Chains made in the color (foundation, turning chains, ch 1 of joined rounds). */
  chains: number;
  /** Slip stitches made in the color (joins of rounds). */
  slsts: number;
  /** Stitches the color is carried across. */
  carried: number;
  /** Strands started (2 tails each). */
  starts: number;
  /** Bobbins to wind (most strands of the color in use at once); 1 for a carried color. */
  bobbins: number;
  /** Border stitches and rounds in this color (0 when the border is another color). */
  borderSts: number;
  borderRounds: number;
}

export function emptyWork(): ColorWork {
  return { cells: 0, chains: 0, slsts: 0, carried: 0, starts: 0, bobbins: 0, borderSts: 0, borderRounds: 0 };
}

/** The four parts of a color's yarn, in inches (§2.8). */
export interface YarnParts {
  worked: number;
  carried: number;
  tails: number;
  extra: number;
}

/** The yarn parts of one color's work. */
export function yarnParts(work: ColorWork, technique: Technique2D, gauge: Pick<ResolvedGauge, 'lscIn' | 'cell'>): YarnParts {
  const L = gauge.lscIn;
  const worked = (work.cells > 0 ? work.cells * yarnPerCellIn(technique, L) : 0) + work.chains * stitchYarnIn(L, 'ch') + work.slsts * stitchYarnIn(L, 'slst');
  const carried = work.carried > 0 ? carriedYarnIn(work.carried, gauge.cell.w) : 0;
  const tails = tailsIn(work.starts);
  const extra = work.borderSts > 0 ? work.borderSts * L + work.borderRounds * JOINED_ROUND_YARN_MULT * L + tailsIn(1) : 0;
  return { worked, carried, tails, extra };
}

/** `(worked + carried + tails + extra) / 36 × (1 + buffer)` and its band. */
export function colorYards(parts: YarnParts, buffer: number, band: number): { inches: number; yards: number; low: number; high: number } {
  const inches = parts.worked + parts.carried + parts.tails + parts.extra;
  const yards = inchesToYards(inches, buffer);
  const range = yardRange(yards, band);
  return { inches, yards, low: range.low, high: range.high };
}

/** Yards per 100 g of a yarn: its own figure, else from its skein. Undefined when the yarn does not say. */
export function ydPer100gOf(yarn: Yarn | undefined): number | undefined {
  if (yarn === undefined) return undefined;
  if (typeof yarn.ydPer100g === 'number' && yarn.ydPer100g > 0) return yarn.ydPer100g;
  if (typeof yarn.skeinYards === 'number' && yarn.skeinYards > 0 && typeof yarn.skeinGrams === 'number' && yarn.skeinGrams > 0) return (yarn.skeinYards / yarn.skeinGrams) * 100;
  return undefined;
}

export interface Yardage2DInput {
  technique: Technique2D;
  gauge: Pick<ResolvedGauge, 'lscIn' | 'cell' | 'source' | 'lscCalibrated'>;
  /** One entry per color of the piece (palette order; colors without work are left out of the result). */
  colors: { entry: PaletteEntry; work: ColorWork }[];
}

export interface Yardage2D {
  materials: MaterialsLine[];
  /** Per material line, the inches of each part (same order). */
  parts: YarnParts[];
  buffer: number;
  band: number;
  /** Strands started over the whole piece (the buffer's "> 50 strands"). */
  strands: number;
}

/**
 * The materials of a 2D piece (§2.8): per color its stitches, bobbins, yards (nominal, low–high), meters, skeins
 * for the high end and grams. `MaterialsLine.strands` = bobbins to wind (request 10 of T2.1, integration S1).
 */
export function yardage2D(i: Yardage2DInput): Yardage2D {
  const used = i.colors.filter((c) => c.work.cells > 0 || c.work.borderSts > 0);
  const strands = used.reduce((a, c) => a + c.work.starts, 0);
  const buffer = yardageBuffer({ technique: i.technique, colors: used.length, strands });
  const band = yardageBand({ technique: i.technique, source: i.gauge.source, calibrated: i.gauge.lscCalibrated === true });
  const materials: MaterialsLine[] = [];
  const parts: YarnParts[] = [];
  for (const { entry, work } of used) {
    const p = yarnParts(work, i.technique, i.gauge);
    const y = colorYards(p, buffer, band);
    const line: MaterialsLine = {
      code: entry.code,
      hex: entry.hex,
      name: entry.name,
      stitches: work.cells + work.borderSts,
      strands: work.bobbins,
      yards: y.yards,
      yardsLow: y.low,
      yardsHigh: y.high,
      meters: yardsToMeters(y.yards),
    };
    if (entry.yarn !== undefined) line.yarn = entry.yarn;
    if (entry.deltaE00 !== undefined) line.deltaE00 = entry.deltaE00;
    const skein = entry.yarn?.skeinYards;
    if (typeof skein === 'number' && skein > 0) line.skeins = skeinsToBuy(y.high, skein);
    const per100 = ydPer100gOf(entry.yarn);
    if (per100 !== undefined) line.grams = gramsFor(y.yards, per100);
    materials.push(line);
    parts.push(p);
  }
  return { materials, parts, buffer, band, strands };
}
