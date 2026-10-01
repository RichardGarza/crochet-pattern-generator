// Track T2 — the flat graph writers: `sc_graphgan` (DESIGN.md §2.7.3) and the row structure that
// `hdc_graphgan` (§2.7.7) and `sc_tapestry` (§2.7.4) share.
//
//   Foundation: With A, ch {W + h}.                       (h = 1 for sc, 2 for hdc: W + h_tc − c, research 07 §3.2)
//   Row 1 (RS) ←: Starting in 2nd ch from hook, {runs} ({W} sts)
//   Row k (RS|WS) ←|→: Ch 1, turn. {runs} ({W} sts)[ · join B (bobbin 2)][ · carry A]
//
// Every row spans the whole chart width (D3). Worked row k reads chart row `rows − k`, in working order
// (`readsRightToLeft`), one op per cell tagged with the cell's palette code; the foundation colour is then the
// colour of row 1's first op (§2.7.2). Cues come from the strand plan (strands.ts). Identical consecutive rows
// are folded into `Rows a–b (n rows)` only when the row reads the same in both directions (one run, or a
// palindrome) and has the same cues; a fold covers both sides, so it carries no side and no arrow (§2.6.2).
// Row 1 is never folded. Lines are written for one hand: the left-handed lines are generated, not mirrored.
import type { ChartGrid, Cue, Hand, Line, Op } from '../../types';
import { type StrandPlan, planStrands, readsRightToLeft, rowCueTexts } from './strands';

export type FlatStitch = 'sc' | 'hdc';

/** Turning-chain height of a flat chart stitch; the chain does not count as a stitch (c = 0). */
export const TURN_CHAINS: Readonly<Record<FlatStitch, number>> = Object.freeze({ sc: 1, hdc: 2 });

/** The foundation of a flat chart W stitches wide: `ch W + h`, first stitch in the (h + 1)th ch (§2.7.3, §2.7.7). */
export function flatFoundation(width: number, stitch: FlatStitch): { chains: number; firstInto: number } {
  const h = TURN_CHAINS[stitch];
  return { chains: width + h, firstInto: h + 1 };
}

/** The palette code of a label (`?` + the label for a label outside the palette; validators report it). */
export function labelCode(grid: ChartGrid, label: number): string {
  const entry: unknown = label < grid.palette.length ? grid.palette[label] : undefined;
  const code = typeof entry === 'object' && entry !== null ? (entry as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : `?${label}`;
}

/** The ops of worked row k (1-based), one per chart cell in working order. */
export function flatRowOps(grid: ChartGrid, k: number, hand: Hand, stitch: FlatStitch = 'sc'): Op[] {
  const r = grid.rows - k;
  const base = r * grid.cols;
  const ops: Op[] = new Array<Op>(grid.cols);
  const rtl = readsRightToLeft(k, hand);
  for (let i = 0; i < grid.cols; i++) {
    const x = rtl ? grid.cols - 1 - i : i;
    ops[i] = { k: 'st', st: stitch, color: labelCode(grid, grid.labels[base + x]) };
  }
  return ops;
}

export interface FlatWriterOptions {
  hand: Hand;
  /** Default 'sc'. */
  stitch?: FlatStitch;
  /** Fold identical consecutive rows (default true). */
  fold?: boolean;
  /**
   * Print the strand cues (`join B (bobbin 2)`, `carry A`) after the rows (default true). Off gives the bare rows
   * of the §2.7.3 golden, for a reader who follows the chart for yarn management.
   */
  cues?: boolean;
  /** The strand plan, when the caller already has it (it must be for the same chart and hand). */
  plan?: StrandPlan;
}

export interface FlatWriterResult {
  /** The panel's rows in order: Row 1 from the foundation, then one line per row or folded range. */
  lines: Line[];
  /** The rows before folding (one per chart row); the validators compare folds with them. */
  rows: Line[];
  plan: StrandPlan;
}

/** Two ops are the same stitch: every field equal (a field set to undefined counts as absent). */
export function sameOp(a: Op, b: Op): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const key of Object.keys(x)) if (x[key] !== undefined && x[key] !== y[key]) return false;
  for (const key of Object.keys(y)) if (y[key] !== undefined && x[key] === undefined) return false;
  return true;
}

export function sameOps(a: readonly Op[], b: readonly Op[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameOp(a[i], b[i])) return false;
  return true;
}

/** True when a row's ops read the same in both directions (one run, or a palindrome of stitches). */
export function directionIndependent(ops: readonly Op[]): boolean {
  for (let i = 0, j = ops.length - 1; i < j; i++, j--) if (!sameOp(ops[i], ops[j])) return false;
  return true;
}

/** Everything but the ops and the numbers that must match for two rows to fold (§2.6.2: no color, loop or note differs). */
export function foldKey(line: Line): string {
  const cues: readonly Cue[] = line.cues ?? [];
  return JSON.stringify([line.kind, line.start ?? null, line.colorHeader ?? null, line.join ?? null, line.segments ?? null, line.notes ?? [], cues.map((cue) => [cue.kind, cue.text]), line.stated, line.prevCount]);
}

/**
 * Folds consecutive rows that may be folded (§2.6.2): consecutive numbers, the same ops (every field: loop, color,
 * stitch), the same start, header, join, notes and cues, direction-independent, never the first row of a piece.
 * The folded line is the first row with `nEnd` and without side and arrow.
 */
export function foldRows(rows: readonly Line[]): Line[] {
  const out: Line[] = [];
  let i = 0;
  while (i < rows.length) {
    const first = rows[i];
    let j = i + 1;
    if (first.start?.k !== 'foundation' && first.prevCount !== null && directionIndependent(first.ops)) {
      const key = foldKey(first);
      while (j < rows.length && rows[j].n === rows[j - 1].n + 1 && sameOps(rows[j].ops, first.ops) && foldKey(rows[j]) === key) j++;
    }
    if (j - i >= 2) {
      const { side: _side, arrow: _arrow, ...rest } = first;
      out.push({ ...rest, nEnd: rows[j - 1].n });
    } else {
      out.push(first);
    }
    i = j;
  }
  return out;
}

/**
 * The rows of a flat chart (sc or hdc; §2.7.3, §2.7.7): one `Line` per chart row in working order with its
 * strand cues, then folded. The chart must be valid (validators report it otherwise; see validate2d.ts).
 */
export function writeFlatRows(grid: ChartGrid, o: FlatWriterOptions): FlatWriterResult {
  const plan = o.plan ?? planStrands(grid, { hand: o.hand });
  const code = (label: number): string => labelCode(grid, label);
  const rows = flatRowLines(grid, { hand: o.hand, stitch: o.stitch, cues: o.cues === false ? undefined : (k) => (plan.rows[k - 1] === undefined ? [] : rowCueTexts(plan.rows[k - 1], code)) });
  const lines = o.fold === false ? rows.slice() : foldRows(rows);
  return { lines, rows, plan };
}

/**
 * The unfolded rows of a flat chart (one `Line` per chart row, §2.7.3): side, arrow, foundation or turning
 * chain, the ops in working order and, when `cues` is given, the color cues it returns for row k.
 */
export function flatRowLines(grid: ChartGrid, o: { hand: Hand; stitch?: FlatStitch; cues?: (k: number) => string[] }): Line[] {
  const stitch: FlatStitch = o.stitch ?? 'sc';
  const W = grid.cols;
  const rows: Line[] = [];
  for (let k = 1; k <= grid.rows; k++) {
    const rtl = readsRightToLeft(k, o.hand);
    const line: Line = {
      kind: 'row',
      n: k,
      side: k % 2 === 1 ? 'RS' : 'WS',
      arrow: rtl ? '←' : '→',
      start: k === 1 ? { k: 'foundation', ...flatFoundation(W, stitch) } : { k: 'turn', chains: TURN_CHAINS[stitch] },
      ops: flatRowOps(grid, k, o.hand, stitch),
      prevCount: k === 1 ? null : W,
      stated: W,
    };
    const texts = o.cues === undefined ? [] : o.cues(k);
    if (texts.length > 0) line.cues = texts.map((text) => ({ kind: 'color', text }));
    rows.push(line);
  }
  return rows;
}

/** `sc_graphgan` (§2.7.3): the rows of a flat sc graph worked with bobbins and short carries. */
export function writeScGraphgan(grid: ChartGrid, o: Omit<FlatWriterOptions, 'stitch'>): FlatWriterResult {
  return writeFlatRows(grid, { ...o, stitch: 'sc' });
}
