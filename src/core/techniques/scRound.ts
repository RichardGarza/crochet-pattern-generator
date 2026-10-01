// Track T2 — `sc_tapestry_round` (DESIGN.md §2.7.5): tapestry sc in joined rounds, with the three answers to the
// lean of stitches worked in rounds (`ChartSettings.roundLean`).
//
//   Foundation: With A, ch {C}; join with sl st in first ch to form a ring (do not twist).
//   Rnd 1 (RS) ←: Ch 1 (does not count as a st), {runs}; join with sl st in first sc. ({C} sts) · carry B
//   Rnd k (RS) ←: Ch 1, {runs}; join with sl st in first sc. ({C} sts)
//   turn:  Rnd k (RS|WS) ←|→: Ch 1, turn. {runs}; join with sl st in first sc. ({C} sts)
//
// Round k reads chart row `rows − k`. `note` and `preskew`: every round is RS and reads right → left (RH) /
// left → right (LH). `preskew`: round k's working sequence is its chart row's, rotated by
// `s_k = round(stPerRnd·(k − 1))` stitches in the working direction (the stitch at working position i takes the
// color the unskewed round has at i − s_k, circularly), so the finished stitches, which drift s_k stitches
// against the working direction, land where the chart shows them. `turn`: from Rnd 2 on every round is turned;
// even rounds are WS and read in the opposite direction, exactly like flat WS rows (§2.7.2), so the lean
// alternates and cancels. Colors are carried as in flat tapestry (tapestry.ts). Identical consecutive rounds fold
// (`Rnds 7–12 (RS, 6 rnds) ←`, §2.6.2) keeping their side and arrow; turned rounds alternate sides and are not
// folded.
import type { ChartGrid, ChartSettings, Hand, Line, Op } from '../../types';
import { roundHalfUp } from '../gauge/round';
import { foldKey, labelCode, sameOps } from './scFlat';
import { chartRow, readsRightToLeft } from './strands';
import { type TapestryPlan, planTapestry, tapestryCueTexts } from './tapestry';

export type RoundLean = ChartSettings['roundLean'];

/** §2.7.5 default: a note, 0.5 st per round. */
export const DEFAULT_ROUND_LEAN: Readonly<RoundLean> = Object.freeze({ mode: 'note', stPerRnd: 0.5 });

/** A lean read leniently: an unknown mode is `note`, a non-finite rate 0.5. */
export function roundLeanOf(value: unknown): RoundLean {
  const v = typeof value === 'object' && value !== null ? (value as Partial<RoundLean>) : {};
  const mode = v.mode === 'preskew' || v.mode === 'turn' || v.mode === 'note' ? v.mode : 'note';
  const stPerRnd = typeof v.stPerRnd === 'number' && Number.isFinite(v.stPerRnd) ? v.stPerRnd : 0.5;
  return { mode, stPerRnd };
}

/** Pre-skew of round k: `round(stPerRnd·(k − 1))` sts (0 unless the mode is `preskew`). */
export function roundShift(k: number, lean: RoundLean): number {
  return lean.mode === 'preskew' ? roundHalfUp(lean.stPerRnd * (k - 1)) : 0;
}

/** True when round k is read right → left: `turn` like flat rows, otherwise RH always (LH never). */
export function roundReadsRightToLeft(k: number, hand: Hand, lean: RoundLean): boolean {
  return lean.mode === 'turn' ? readsRightToLeft(k, hand) : hand !== 'left';
}

/** The side of round k: `turn` alternates (odd RS, even WS); otherwise every round is RS. */
export function roundSide(k: number, lean: RoundLean): 'RS' | 'WS' {
  return lean.mode === 'turn' && k % 2 === 0 ? 'WS' : 'RS';
}

/** The labels of round k in working order, pre-skewed by `shift` (positive = in the working direction). */
export function roundLabels(grid: ChartGrid, k: number, hand: Hand, lean: RoundLean, shift: number = roundShift(k, lean)): Uint8Array {
  const row = chartRow(grid, grid.rows - k);
  const C = row.length;
  const rtl = roundReadsRightToLeft(k, hand, lean);
  const out = new Uint8Array(C);
  const s = ((shift % C) + C) % C;
  for (let i = 0; i < C; i++) {
    const j = (i - s + C) % C;
    out[i] = row[rtl ? C - 1 - j : j];
  }
  return out;
}

/** The plan of carried colors over the rounds (as flat tapestry, on the rounds' working sequences). */
export function planRoundTapestry(grid: ChartGrid, hand: Hand, lean: RoundLean): TapestryPlan {
  const seqs: Uint8Array[] = [];
  for (let k = 1; k <= grid.rows; k++) seqs.push(roundLabels(grid, k, hand, lean));
  return planTapestry(seqs, grid.palette.length);
}

export interface RoundWriterOptions {
  hand: Hand;
  roundLean?: RoundLean;
  /** Fold identical consecutive rounds (default true). */
  fold?: boolean;
  /** Print the join / carry / cut cues (default true). */
  cues?: boolean;
}

export interface RoundWriterResult {
  lines: Line[];
  /** One line per round, before folding. */
  rounds: Line[];
  plan: TapestryPlan;
  lean: RoundLean;
}

/** Folds consecutive identical rounds (same everything but the number, side and arrow included); never Rnd 1. */
export function foldRounds(rounds: readonly Line[]): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < rounds.length) {
    const first = rounds[i];
    let j = i + 1;
    if (first.start?.k !== 'chainRing' && first.prevCount !== null) {
      const key = foldKey(first) + JSON.stringify([first.side ?? null, first.arrow ?? null]);
      while (j < rounds.length && rounds[j].n === rounds[j - 1].n + 1 && sameOps(rounds[j].ops, first.ops) && foldKey(rounds[j]) + JSON.stringify([rounds[j].side ?? null, rounds[j].arrow ?? null]) === key) j++;
    }
    out.push(j - i >= 2 ? { ...first, nEnd: rounds[j - 1].n } : first);
    i = j;
  }
  return out;
}

/** `sc_tapestry_round` (§2.7.5): one joined round per chart row, bottom up. */
export function writeScTapestryRound(grid: ChartGrid, o: RoundWriterOptions): RoundWriterResult {
  const hand: Hand = o.hand === 'left' ? 'left' : 'right';
  const lean = roundLeanOf(o.roundLean ?? DEFAULT_ROUND_LEAN);
  const C = grid.cols;
  const seqs: Uint8Array[] = [];
  for (let k = 1; k <= grid.rows; k++) seqs.push(roundLabels(grid, k, hand, lean));
  const plan = planTapestry(seqs, grid.palette.length);
  const code = (label: number): string => labelCode(grid, label);
  const rounds: Line[] = [];
  for (let k = 1; k <= grid.rows; k++) {
    const seq = seqs[k - 1];
    const ops: Op[] = Array.from(seq, (label) => ({ k: 'st', st: 'sc', color: code(label) }) as Op);
    const line: Line = {
      kind: 'rnd',
      n: k,
      side: roundSide(k, lean),
      arrow: roundReadsRightToLeft(k, hand, lean) ? '←' : '→',
      start: k === 1 ? { k: 'chainRing', chains: C } : lean.mode === 'turn' ? { k: 'turn', chains: 1 } : { k: 'join' },
      ops,
      prevCount: k === 1 ? null : C,
      stated: C,
      join: {},
    };
    if (o.cues !== false) {
      const texts = tapestryCueTexts(plan.lines[k - 1], code);
      if (texts.length > 0) line.cues = texts.map((text) => ({ kind: 'color', text }));
    }
    rounds.push(line);
  }
  const lines = o.fold === false || lean.mode === 'turn' ? rounds.slice() : foldRounds(rounds);
  return { lines, rounds, plan, lean };
}
