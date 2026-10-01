// Track T2 — tapestry crochet: which colors are carried, joined and cut on each line (DESIGN.md §2.7.4, §2.7.5),
// and the flat `sc_tapestry` writer (§2.7.4). The round writer (`sc_tapestry_round`, scRound.ts) uses the same
// plan on its rounds.
//
// Rules (§2.7.4): every color that appears in a line is carried through the whole line (worked over where it is
// not used). A color is joined at the start of the first line that needs it; at the end of a line, a color that
// the next 2 lines do not use is cut (6 in tail); otherwise it keeps being carried, through lines that do not use
// it too. The first color of Line 1 is the foundation's, so it is not joined. Cues, in this order:
//
//   join B · join C · carry A, B, C · cut C
//
// `join X` for each color joined at the start of the line (working order), one `carry …` naming every color
// carried in the line (those worked somewhere in it first, in working order, then those carried through it
// without being used), one `cut …` for the colors cut at its end. The last line cuts nothing in the cues (the
// piece is fastened off). A color is "carried" in a line when it is held and at least one stitch of the line is
// another color.
import type { ChartGrid, Hand } from '../../types';
import { type FlatWriterResult, flatRowLines, foldRows, labelCode } from './scFlat';
import { chartRow, readsRightToLeft } from './strands';

/** A color the next `TAPESTRY_CUT_AFTER` lines do not use is cut at the end of the line (§2.7.4). */
export const TAPESTRY_CUT_AFTER = 2;

export interface TapestryLinePlan {
  /** Line number, 1-based. */
  k: number;
  /** Stitches per label in the line. */
  counts: Map<number, number>;
  /** Labels joined at the start of the line, in working order. */
  joins: number[];
  /** Labels carried in the line (held, and not worked on every stitch), in cue order. */
  carried: number[];
  /** Labels held during the line (worked or carried). */
  held: number[];
  /** Labels cut at the end of the line. */
  cuts: number[];
}

export interface TapestryPlan {
  lines: TapestryLinePlan[];
  /** Strands started per label: joins plus the foundation strand (each has 2 tails). */
  startsPerColor: number[];
  /** Carried stitches per label over the whole piece (yardage `carried_c`). */
  carriedPerColor: number[];
  /** The most colors held in one line. */
  maxHeld: number;
}

/**
 * The tapestry plan of a piece from its lines' labels in working order (`seqs[k − 1]` = line k). `colors` = the
 * palette size (labels at or beyond it are still counted). Deterministic.
 */
export function planTapestry(seqs: readonly ArrayLike<number>[], colors: number): TapestryPlan {
  const n = seqs.length;
  const startsPerColor = new Array<number>(Math.max(0, colors)).fill(0);
  const carriedPerColor = new Array<number>(Math.max(0, colors)).fill(0);
  const grow = (label: number): void => {
    while (startsPerColor.length <= label) startsPerColor.push(0);
    while (carriedPerColor.length <= label) carriedPerColor.push(0);
  };
  const present: Set<number>[] = seqs.map((seq) => {
    const set = new Set<number>();
    for (let i = 0; i < seq.length; i++) set.add(seq[i]);
    return set;
  });
  const lines: TapestryLinePlan[] = [];
  const held = new Set<number>();
  let maxHeld = 0;
  for (let k = 1; k <= n; k++) {
    const seq = seqs[k - 1];
    const width = seq.length;
    const counts = new Map<number, number>();
    const order: number[] = [];
    for (let i = 0; i < width; i++) {
      const label = seq[i];
      const c = counts.get(label);
      if (c === undefined) {
        counts.set(label, 1);
        order.push(label);
      } else {
        counts.set(label, c + 1);
      }
    }
    const joins: number[] = [];
    for (const label of order) {
      if (held.has(label)) continue;
      held.add(label);
      grow(label);
      startsPerColor[label]++;
      if (!(k === 1 && label === order[0])) joins.push(label);
    }
    const absent = [...held].filter((label) => !counts.has(label)).sort((a, b) => a - b);
    const heldNow = [...order, ...absent];
    const carried = heldNow.filter((label) => (counts.get(label) ?? 0) < width);
    for (const label of carried) carriedPerColor[label] += width - (counts.get(label) ?? 0);
    maxHeld = Math.max(maxHeld, heldNow.length);
    const cuts: number[] = [];
    if (k < n) {
      for (const label of heldNow) {
        let used = false;
        for (let j = k + 1; j <= Math.min(n, k + TAPESTRY_CUT_AFTER); j++) if (present[j - 1].has(label)) used = true;
        if (!used) cuts.push(label);
      }
      for (const label of cuts) held.delete(label);
    }
    lines.push({ k, counts, joins, carried, held: heldNow, cuts });
  }
  return { lines, startsPerColor, carriedPerColor, maxHeld };
}

/** The color cues of one tapestry line: `join B` per color joined, `carry A, B`, `cut C, D`. */
export function tapestryCueTexts(line: TapestryLinePlan, code: (label: number) => string): string[] {
  const out: string[] = [];
  for (const label of line.joins) out.push(`join ${code(label)}`);
  if (line.carried.length > 0) out.push(`carry ${line.carried.map(code).join(', ')}`);
  if (line.cuts.length > 0) out.push(`cut ${line.cuts.map(code).join(', ')}`);
  return out;
}

/** The labels of worked row k of a flat chart in working order (§2.7.2). */
export function flatRowLabels(grid: ChartGrid, k: number, hand: Hand): Uint8Array {
  const row = chartRow(grid, grid.rows - k);
  const out = new Uint8Array(row.length);
  const rtl = readsRightToLeft(k, hand);
  for (let i = 0; i < row.length; i++) out[i] = row[rtl ? row.length - 1 - i : i];
  return out;
}

/** The tapestry plan of a flat chart worked in rows by `hand`. */
export function planFlatTapestry(grid: ChartGrid, hand: Hand): TapestryPlan {
  const seqs: Uint8Array[] = [];
  for (let k = 1; k <= grid.rows; k++) seqs.push(flatRowLabels(grid, k, hand));
  return planTapestry(seqs, grid.palette.length);
}

export interface TapestryWriterOptions {
  hand: Hand;
  /** Fold identical consecutive rows (default true; §2.6.2). */
  fold?: boolean;
  /** Print the join / carry / cut cues (default true). */
  cues?: boolean;
  plan?: TapestryPlan;
}

export interface TapestryWriterResult extends Omit<FlatWriterResult, 'plan'> {
  plan: TapestryPlan;
}

/** `sc_tapestry` (§2.7.4): the rows of §2.7.3 with every color of a row carried, and its join/carry/cut cues. */
export function writeScTapestry(grid: ChartGrid, o: TapestryWriterOptions): TapestryWriterResult {
  const plan = o.plan ?? planFlatTapestry(grid, o.hand);
  const code = (label: number): string => labelCode(grid, label);
  const rows = flatRowLines(grid, {
    hand: o.hand,
    stitch: 'sc',
    cues: o.cues === false ? undefined : (k) => (plan.lines[k - 1] === undefined ? [] : tapestryCueTexts(plan.lines[k - 1], code)),
  });
  const lines = o.fold === false ? rows.slice() : foldRows(rows);
  return { lines, rows, plan };
}
