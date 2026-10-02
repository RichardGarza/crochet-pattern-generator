// Track T4 — amigurumi yardage per color (DESIGN.md §2.8 "3D (amigurumi) per color", §2.2.4 `L_ami`).
//
//   yards_c = (Σ produced sts · L_ami + 0.2·L_ami per dec + 3 in per magic ring + chain-oval / chain-ring chains ·
//              0.42·L_ami + joined rounds · 0.92·L_ami + tails + embroidery) × make count / 36 × 1.15
//   tails: 6 in where a color starts and 6 in where it is cut; the color that finishes a piece leaves the piece's
//          finishing tail instead of the cut tail (6 in for the Ultimate Finish, the sewing tail of §2.10.6, or both)
//   embroidery: 24 in per pair of embroidered eyes, 12 in per other feature
//   band: ±20% with the default gauge, ±10% measured (test ball), ±5% calibrated (`gauge.lscCalibrated`)
//
// Golden (G11): the 36-st worsted sphere (468 sts, 30 decreases, one magic ring, 2 × 6 in tails, L_ami = 1.474)
// ⇒ (689.7 + 8.8 + 3 + 12)/36 × 1.15 = 22.8 yd, band 18.2–27.4 yd. Floats carried inside mixed rounds
// (absent sts · 1.1 · w) come with the colorwork of T4.4.
import type { ResolvedGauge } from '../../types/gauge';
import type { Line, Op } from '../../types/pattern';
import { produced } from '../pattern/ops';
import { inchesToYards, MAGIC_RING_IN, MULT, TAIL_IN, JOINED_ROUND_YARN_MULT, DEC_EXTRA_YARN_MULT, EMBROIDERY_IN, yardageBand, yardRange } from '../gauge/yarnPerStitch';

/** Amigurumi yardage buffer (§2.8: "Amigurumi is always 0.15"). */
export const AMI_BUFFER = 0.15;

export interface PieceYarnInput {
  lines: readonly Line[];
  /** Color of ops without a tag or header (the piece's main color code). */
  mainCode: string;
  makeCount: number;
  /** The finishing tail, inches (6 for a gathered end, the sewing tail, or 6 + sewing tail). */
  finishTailIn: number;
}

export interface ColorYarn {
  /** Inches before the buffer, for one copy of everything (make counts applied). */
  inches: number;
  stitches: number;
}

const colorOf = (op: Op, line: Line, main: string) => (op.k === 'tile' ? op.color : (op.color ?? line.colorHeader ?? main));

/** The yarn of one piece per color code, inches (make count applied), and its produced stitches per color. */
export function pieceYarn(p: PieceYarnInput, lAmiIn: number): Map<string, ColorYarn> {
  const out = new Map<string, ColorYarn>();
  const get = (c: string) => {
    let v = out.get(c);
    if (!v) out.set(c, (v = { inches: 0, stitches: 0 }));
    return v;
  };
  const order: string[] = [];
  for (const line of p.lines) {
    const reps = line.nEnd !== undefined && line.nEnd > line.n ? line.nEnd - line.n + 1 : 1;
    for (const op of line.ops) {
      const c = colorOf(op, line, p.mainCode);
      if (!order.includes(c)) order.push(c);
      const y = get(c);
      const sts = produced([op]);
      y.stitches += sts * reps;
      y.inches += sts * reps * lAmiIn;
      if (op.k === 'dec') y.inches += reps * DEC_EXTRA_YARN_MULT * lAmiIn;
      if (op.k === 'st' && op.st === 'slst') y.inches += reps * (MULT.slst - 1) * lAmiIn;
    }
    const first = line.ops[0] ? colorOf(line.ops[0], line, p.mainCode) : p.mainCode;
    const s = line.start;
    if (s?.k === 'mr') get(first).inches += MAGIC_RING_IN;
    else if (s?.k === 'chainOval' || s?.k === 'chainRing') get(first).inches += s.chains * MULT.ch * lAmiIn;
    else if (s?.k === 'foundation') get(first).inches += s.chains * MULT.ch * lAmiIn;
    else if (s?.k === 'turn') get(first).inches += reps * s.chains * MULT.ch * lAmiIn;
    if (line.join) get(first).inches += reps * JOINED_ROUND_YARN_MULT * lAmiIn;
  }
  // tails: 6 in where each color starts; 6 in where it is cut, except the last color, which leaves the finishing tail
  const last = order[order.length - 1];
  for (const c of order) get(c).inches += TAIL_IN + (c === last ? p.finishTailIn : TAIL_IN);
  for (const v of out.values()) {
    v.inches *= p.makeCount;
    v.stitches *= p.makeCount;
  }
  return out;
}

/** Embroidery yarn (§2.8): 24 in per pair of embroidered eyes, 12 in per other feature. */
export function embroideryIn(o: { eyePairs?: number; features?: number }): number {
  return (o.eyePairs ?? 0) * EMBROIDERY_IN.eyePair + (o.features ?? 0) * EMBROIDERY_IN.feature;
}

export interface YardsBand {
  yards: number;
  yardsLow: number;
  yardsHigh: number;
  band: number;
}

/** Inches → yards with the amigurumi buffer and the band of the gauge (`calibrated: gauge.lscCalibrated`). */
export function amiYards(inches: number, gauge: Pick<ResolvedGauge, 'source' | 'lscCalibrated'>): YardsBand {
  const yards = inchesToYards(inches, AMI_BUFFER);
  const band = yardageBand({ technique: 'amigurumi_sc', source: gauge.source, calibrated: gauge.lscCalibrated === true });
  const r = yardRange(yards, band);
  return { yards, yardsLow: r.low, yardsHigh: r.high, band };
}
