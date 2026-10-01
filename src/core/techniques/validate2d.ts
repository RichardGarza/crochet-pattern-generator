// Track T2 — the 2D validators (DESIGN.md §2.13; §2.7.3). They run where the pattern is built and again before
// export; any E_* blocks export, W_* shows as a badge.
//
//   E_SANITY      the chart itself: cols and rows whole numbers from 1 to 1000, one label per cell, a palette of
//                 entries (when this fires nothing else is checked); a chart round without side and arrow
//   E_COLOR       a cell whose label has no palette entry, a palette code used twice, or a color code in a line
//                 (ops, header, join, `join B` / `carry B` cues) that is not in the palette
//   E_RUN_SUM     a flat row whose runs do not sum to the chart width W or are not its chart row read in its
//                 direction (with its side and arrow) for the pattern's hand, or rows that do not cover the
//                 chart's R rows once each, in order (a missing row sums to 0)
//   E_FOUNDATION  Row 1 of a flat chart does not start from `ch W + h_tc − c` in the (h + 1)th ch
//                 (sc: W + 1 from the 2nd ch; hdc: W + 2 from the 3rd), or a later row does not turn with
//                 h_tc chains
//   E_FOLD        a folded range of rows whose rows differ from the line in ops (as read from the chart in each
//                 row's direction) or in strand cues (when the pattern prints them), that does not read the same
//                 in both directions, that keeps a side or an arrow, or that includes Row 1
//                 — and the same for folded tapestry rounds (which keep their side and arrow) and for the rows a
//                 block repeat note stands for (`Rows 13–24: rep Rows 1–12.`: an even block in flat work, the
//                 rows equal to the block's in the chart, read in their own direction, with the same cues)
//   E_C2C_TILES   C2C rows (c2c.ts, validateC2C)
//   E_BORDER      border rounds (border.ts, validateBorder)
//   W_LONG_CARRY  a color carried across more than 8 stitches (bobbin techniques)
//   W_ROW_COLORS  more than 6 strands worked in one row (§2.4.3; tapestry: colors held in the line)
//
// Rounds of `sc_tapestry_round` get the row rules in their own terms: E_RUN_SUM (C sts, every chart row once,
// read in the round's direction, pre-skewed as `roundLean` says, with its side and arrow), E_FOUNDATION (a ring of
// ch C, then joined rounds, or turned with ch 1). Plus every rule of the Step 0 line validator (`validateLines`,
// docKind '2d', with the palette's codes). E_MOSAIC_ADJ comes with the mosaic writer (T2.4).
import type { ChartGrid, ChartSettings, Hand, Issue, Line, Op, PatternDoc, ResolvedGauge, Technique2D } from '../../types';
import { roundHalfUp } from '../gauge/round';
import { type LineIssueCode, validateLines } from '../pattern/validateLine';
import { isOp, lineProduced } from '../pattern/ops';
import { validateBorder } from './border';
import { type Corner, cornerFromArrow, cornerOf } from './c2cCorners';
import { validateC2C } from './c2c';
import { lineRepeat } from './repeats';
import { type RoundLean, roundLabels, roundLeanOf, roundReadsRightToLeft, roundShift, roundSide } from './scRound';
import { type FlatStitch, directionIndependent, flatFoundation, flatRowOps, labelCode, TURN_CHAINS } from './scFlat';
import { CARRY_MAX, ROW_STRANDS_WARN, type StrandPlan, planStrands, readsRightToLeft, rowCueTexts } from './strands';
import { type TapestryPlan, planFlatTapestry, planTapestry, tapestryCueTexts } from './tapestry';

export type Validate2DCode = LineIssueCode | 'E_RUN_SUM' | 'E_FOLD' | 'E_C2C_TILES' | 'E_BORDER' | 'W_LONG_CARRY' | 'W_ROW_COLORS';

/** No chart side may be longer (R15, §2.13). */
export const CHART_SIDE_LIMIT = 1000;

/** The techniques worked in flat rows across the whole chart. */
export const FLAT_ROW_TECHNIQUES: ReadonlySet<Technique2D> = new Set<Technique2D>(['sc_graphgan', 'sc_tapestry', 'hdc_graphgan']);

/** The stitch of a flat-row technique. */
export function flatStitchOf(technique: Technique2D): FlatStitch {
  return technique === 'hdc_graphgan' ? 'hdc' : 'sc';
}

function issue(code: Validate2DCode, message: string, where?: Issue['where']): Issue {
  const severity = code.startsWith('W_') ? 'warn' : 'error';
  return Object.freeze(where === undefined ? { code, severity, message } : { code, severity, message, where: Object.freeze(where) });
}

function isWhole(value: unknown, min: number, max: number): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
}

/** E_SANITY and E_COLOR of the chart alone. Never throws. */
export function validateChart(grid: ChartGrid): Issue[] {
  const issues: Issue[] = [];
  if (typeof grid !== 'object' || grid === null) return [issue('E_SANITY', 'not a chart')];
  if (!isWhole(grid.cols, 1, CHART_SIDE_LIMIT) || !isWhole(grid.rows, 1, CHART_SIDE_LIMIT)) {
    issues.push(issue('E_SANITY', `a chart is 1 to ${CHART_SIDE_LIMIT} cells on each side, got ${String(grid.cols)} × ${String(grid.rows)}`));
    return issues;
  }
  if (!(grid.labels instanceof Uint8Array) || grid.labels.length !== grid.cols * grid.rows) {
    issues.push(issue('E_SANITY', `the chart needs one label per cell (${grid.cols * grid.rows})`));
    return issues;
  }
  if (!Array.isArray(grid.palette) || grid.palette.length === 0) {
    issues.push(issue('E_SANITY', 'the chart has no palette'));
    return issues;
  }
  const notEntry = grid.palette.findIndex((entry: unknown) => typeof entry !== 'object' || entry === null);
  if (notEntry >= 0) {
    issues.push(issue('E_SANITY', `palette entry ${notEntry + 1} is not a palette entry`));
    return issues;
  }
  const codes = new Map<string, number>();
  grid.palette.forEach((entry, i) => {
    const code = typeof entry.code === 'string' ? entry.code : '';
    if (code === '') issues.push(issue('E_COLOR', `palette entry ${i + 1} has no color code`));
    else if (codes.has(code)) issues.push(issue('E_COLOR', `color ${code} is used by two palette entries (${codes.get(code)! + 1} and ${i + 1})`));
    else codes.set(code, i);
  });
  let bad = 0;
  let firstBad = -1;
  for (let i = 0; i < grid.labels.length; i++) {
    if (grid.labels[i] >= grid.palette.length) {
      if (firstBad < 0) firstBad = i;
      bad++;
    }
  }
  if (bad > 0) {
    const row = Math.floor(firstBad / grid.cols);
    const col = firstBad % grid.cols;
    issues.push(
      issue('E_COLOR', `${bad} chart cell${bad === 1 ? ' has' : 's have'} no palette color (first at row ${row + 1}, column ${col + 1}: label ${grid.labels[firstBad]})`, {
        row,
        col,
      }),
    );
  }
  return issues;
}

const JOIN_CUE = /^\s*join\s+(\S+)(?:\s+\(bobbin\s+\d+\))?\s*$/;
const LIST_CUE = /^\s*(?:carry|cut)\s+(.+?)\s*$/;

/** The color codes a color cue names (`join B (bobbin 2)`, `join B`, `carry A, C`, `cut C`). */
export function cueColors(text: string): string[] {
  const join = JOIN_CUE.exec(text);
  if (join !== null) return [join[1]];
  const list = LIST_CUE.exec(text);
  if (list !== null) return list[1].split(',').map((code) => code.trim()).filter((code) => code !== '');
  return [];
}

export interface Validate2DInput {
  chart: ChartGrid;
  technique: Technique2D;
  hand: Hand;
  /** The lines of the piece (the panel's rows, then its border rounds, if any). */
  lines: readonly Line[];
  /** `Piece.id`, copied into `where.piece`. */
  piece?: string;
  /** The strand plan the lines were written with; computed when left out (graphgan techniques). */
  plan?: StrandPlan;
  /** `sc_tapestry_round`: the lean setting the rounds were written with (inferred from the rounds when left out). */
  roundLean?: ChartSettings['roundLean'];
  /** `c2c`: the start corner (inferred from Row 1's arrow when left out). */
  startCorner?: ChartSettings['startCorner'];
  /** With the gauge the border's S_side, S_top (C2C) and round count are checked against §2.7.10. */
  gauge?: Pick<ResolvedGauge, 'cell' | 'wSc' | 'hSc'>;
  /** The border setting (width and color code); checked when given. */
  border?: { widthIn: number; color?: string };
  /** Color codes outside the chart's palette the pattern may use (a border yarn). */
  extraCodes?: readonly string[];
}

function readable(line: unknown): line is Line {
  if (typeof line !== 'object' || line === null) return false;
  const l = line as Line;
  return Number.isInteger(l.n) && l.n >= 1 && (l.nEnd === undefined || (Number.isInteger(l.nEnd) && l.nEnd >= l.n)) && Array.isArray(l.ops) && l.ops.every((op) => isOp(op)) && (l.cues === undefined || (Array.isArray(l.cues) && l.cues.every((cue) => typeof cue === 'object' && cue !== null && typeof cue.text === 'string')));
}

function sameLineOps(a: Line['ops'], b: Line['ops']): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as Record<string, unknown>;
    const y = b[i] as Record<string, unknown>;
    for (const key of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[key] !== y[key]) return false;
  }
  return true;
}

/**
 * Every 2D rule that applies to the piece (see the file header), the Step 0 line rules first, in line order.
 * Never throws; a malformed chart is reported as E_SANITY alone.
 */
export function validate2D(i: Validate2DInput): Issue[] {
  if (typeof i !== 'object' || i === null) return [issue('E_SANITY', 'nothing to validate')];
  const chartIssues = validateChart(i.chart);
  if (chartIssues.some((x) => x.code === 'E_SANITY')) return chartIssues;
  const grid = i.chart;
  const lines: readonly Line[] = Array.isArray(i.lines) ? i.lines : [];
  const codes = [...grid.palette.map((entry) => entry.code), ...(Array.isArray(i.extraCodes) ? i.extraCodes.filter((c) => typeof c === 'string') : [])];
  const piece = typeof i.piece === 'string' ? i.piece : undefined;
  const at = (line: Line): Issue['where'] => (piece === undefined ? { line: line.n } : { piece, line: line.n });
  const issues: Issue[] = [...chartIssues];

  const lineIssues = validateLines(lines, { palette: codes, piece, docKind: '2d' });
  issues.push(...lineIssues);
  // Lines the other rules cannot read (the line validator reports them as E_SANITY).
  const insane = new Set<Line>();
  for (const line of lines) if (!readable(line)) insane.add(line);

  // A chart round must say so: renderLine tells a chart round from an amigurumi round by its side or arrow
  // (render.ts, inferDocKind), so a round without either would print in the amigurumi style.
  for (const line of lines) {
    if (insane.has(line) || line.kind !== 'rnd' || line.side !== undefined || line.arrow !== undefined) continue;
    issues.push(issue('E_SANITY', `Rnd ${line.n}: a round of a chart needs its side and reading arrow`, at(line)));
  }

  // E_COLOR in cues (the line validator checks ops, headers and joins).
  const palette = new Set(codes);
  for (const line of lines) {
    if (insane.has(line) || !Array.isArray(line.cues)) continue;
    for (const cue of line.cues) {
      if (cue.kind !== 'color') continue;
      for (const code of cueColors(cue.text)) if (!palette.has(code)) issues.push(issue('E_COLOR', `${line.kind === 'rnd' || line.kind === 'border' ? 'Rnd' : 'Row'} ${line.n}: the cue “${cue.text}” names color ${code}, which is not in the palette`, at(line)));
    }
  }

  const hand: Hand = i.hand === 'left' ? 'left' : 'right';
  if (FLAT_ROW_TECHNIQUES.has(i.technique)) issues.push(...flatRules(i, grid, lines, insane, lineIssues, piece, at));
  else if (i.technique === 'sc_tapestry_round') issues.push(...roundRules(i, grid, lines, insane, palette, piece, at));
  else if (i.technique === 'c2c') {
    const first = lines.find((line) => !insane.has(line) && line.kind === 'c2c' && line.n === 1);
    const corner: Corner = i.startCorner !== undefined ? cornerOf(i.startCorner, hand) : (cornerFromArrow(hand, first?.arrow) ?? cornerOf(undefined, hand));
    issues.push(...validateC2C(grid, lines.filter((line) => !insane.has(line)), { hand, corner, piece }));
  }
  if (i.technique !== 'mosaic_overlay') {
    issues.push(
      ...validateBorder({
        chart: grid,
        technique: i.technique,
        hand,
        lines: lines.filter((line) => !insane.has(line)),
        piece,
        lastColor: lastStitchColor(grid, i.technique, hand),
        gauge: i.gauge,
        border: i.border,
      }),
    );
  }
  return issues;
}

/** The color code of the panel's last stitch (flat rows: the end of Row R in its direction), else undefined. */
export function lastStitchColor(grid: ChartGrid, technique: Technique2D, hand: Hand): string | undefined {
  if (!FLAT_ROW_TECHNIQUES.has(technique) || grid.rows < 1) return undefined;
  const ops = flatRowOps(grid, grid.rows, hand, flatStitchOf(technique));
  return ops.length === 0 ? undefined : ops[ops.length - 1].color;
}

type At = (line: Line) => Issue['where'];

/** The flat-row rules (sc / hdc graphgan, sc tapestry). */
function flatRules(i: Validate2DInput, grid: ChartGrid, lines: readonly Line[], insane: ReadonlySet<Line>, lineIssues: readonly Issue[], piece: string | undefined, at: At): Issue[] {
  const issues: Issue[] = [];
  const palette = new Set([...grid.palette.map((entry) => entry.code), ...(i.extraCodes ?? [])]);
  const stitch = flatStitchOf(i.technique);
  const W = grid.cols;
  const R = grid.rows;
  const rows = lines.filter((line) => typeof line === 'object' && line !== null && line.kind === 'row');

  // E_RUN_SUM: every row is W stitches, and the rows cover 1..R once each, in order (a block repeat note covers
  // the rows it stands for).
  let expected = 1;
  for (const line of rows) {
    if (insane.has(line)) {
      const n = line.n;
      const end = line.nEnd;
      if (typeof n === 'number' && Number.isInteger(n)) expected = Math.max(expected, (typeof end === 'number' && Number.isInteger(end) && end > n ? end : n) + 1);
      continue;
    }
    const made = lineProduced(line);
    if (made !== W) issues.push(issue('E_RUN_SUM', `Row ${line.n}: its runs sum to ${made} sts, but the chart is ${W} wide (${made} ≠ ${W})`, at(line)));
    const end = line.nEnd !== undefined && line.nEnd > line.n ? line.nEnd : line.n;
    if (line.n > expected) {
      const missing = line.n - 1 === expected ? `Row ${expected} is` : `Rows ${expected}–${line.n - 1} are`;
      issues.push(issue('E_RUN_SUM', `${missing} missing: every row of the chart must be worked (0 ≠ ${W})`, at(line)));
    } else if (line.n < expected) {
      issues.push(issue('E_RUN_SUM', `Row ${line.n} comes again after Row ${expected - 1}: the rows must cover the chart once, in order`, at(line)));
    }
    expected = Math.max(expected, end + 1);
    const rep = lineRepeat(line);
    if (rep !== null && rep.from === expected && rep.to >= rep.from) expected = rep.to + 1;
  }
  if (expected <= R) {
    const missing = expected === R ? `Row ${R} is` : `Rows ${expected}–${R} are`;
    issues.push(issue('E_RUN_SUM', `${missing} missing: the chart has ${R} rows (0 ≠ ${W})`));
  } else if (expected > R + 1) {
    issues.push(issue('E_RUN_SUM', `the pattern has ${expected - 1} rows but the chart only ${R}`));
  }

  // E_FOUNDATION: Row 1 starts from ch W + h in the (h + 1)th ch.
  const first = rows[0];
  if (first !== undefined && !insane.has(first)) {
    const want = flatFoundation(W, stitch);
    const start = first.start;
    const kernelSaid = lineIssues.some((x) => x.code === 'E_FOUNDATION' && x.where?.line === first.n);
    if (start?.k !== 'foundation') {
      issues.push(issue('E_FOUNDATION', `Row ${first.n}: a flat chart starts from a foundation chain of ${want.chains} (W + ${TURN_CHAINS[stitch]})`, at(first)));
    } else if (!kernelSaid && (start.chains !== want.chains || start.firstInto !== want.firstInto)) {
      issues.push(
        issue(
          'E_FOUNDATION',
          `Row ${first.n}: a ${W}-st ${stitch} chart needs ch ${want.chains} worked from the ${want.firstInto === 2 ? '2nd' : '3rd'} ch, not ch ${start.chains} from ch ${start.firstInto}`,
          at(first),
        ),
      );
    }
  }

  // E_RUN_SUM (each row is its chart row, in its own direction, with its side and arrow) and the turning chain
  // (E_FOUNDATION: h_tc chains that do not count).
  for (const line of rows) {
    if (insane.has(line) || (line.nEnd !== undefined && line.nEnd > line.n) || line.n > R) continue;
    const k = line.n;
    const want = flatRowOps(grid, k, i.hand, stitch);
    // A stitch outside the palette is E_COLOR already; do not report the same stitch again as a wrong run.
    if (lineProduced(line) === W && line.ops.every((op) => op.color !== undefined && palette.has(op.color)) && !sameLineOps(want, line.ops)) {
      issues.push(issue('E_RUN_SUM', `Row ${k}: its runs are not chart row ${k} read ${readsRightToLeft(k, i.hand) ? 'right to left' : 'left to right'} (${i.hand}-handed)`, at(line)));
    }
    const side = k % 2 === 1 ? 'RS' : 'WS';
    const arrow = readsRightToLeft(k, i.hand) ? '←' : '→';
    if (line.side !== side || line.arrow !== arrow) {
      issues.push(issue('E_RUN_SUM', `Row ${k}: it is a ${side} row read ${arrow} (${i.hand}-handed), not ${line.side ?? 'no side'} ${line.arrow ?? 'no arrow'}`, at(line)));
    }
    if (k > 1 && line.start?.k === 'turn' && line.start.chains !== TURN_CHAINS[stitch]) {
      issues.push(issue('E_FOUNDATION', `Row ${k}: an ${stitch} row turns with ch ${TURN_CHAINS[stitch]} (does not count as a st), not ch ${line.start.chains}`, at(line)));
    }
  }

  // E_FOLD, W_LONG_CARRY, W_ROW_COLORS: against the chart and its strand plan.
  const tapestry = i.technique === 'sc_tapestry';
  const plan = i.plan ?? planStrands(grid, { hand: i.hand });
  const tplan: TapestryPlan | null = tapestry ? planFlatTapestry(grid, i.hand) : null;
  const code = (label: number): string => labelCode(grid, label);
  const cueOf = (k: number): string => {
    if (tplan !== null) return tplan.lines[k - 1] === undefined ? '' : tapestryCueTexts(tplan.lines[k - 1], code).join(' · ');
    return plan.rows[k - 1] === undefined ? '' : rowCueTexts(plan.rows[k - 1], code).join(' · ');
  };
  // A pattern written without strand cues (writer option `cues: false`) folds by ops alone.
  const cuesPrinted = rows.some((line) => !insane.has(line) && (line.cues ?? []).some((cue) => cue.kind === 'color'));
  for (const line of rows) {
    if (insane.has(line) || line.nEnd === undefined || line.nEnd <= line.n) continue;
    const problems: string[] = [];
    if (line.n === 1 || line.start?.k === 'foundation') problems.push('Row 1 cannot be folded');
    if (line.side !== undefined || line.arrow !== undefined) problems.push('a fold covers both sides, so it has no side and no arrow');
    if (!directionIndependent(line.ops)) problems.push('only a row that reads the same in both directions can be folded');
    const lineCues = (line.cues ?? []).filter((cue) => cue.kind === 'color').map((cue) => cue.text).join(' · ');
    for (let k = line.n; k <= Math.min(line.nEnd, R); k++) {
      if (!sameLineOps(flatRowOps(grid, k, i.hand, stitch), line.ops)) {
        problems.push(`Row ${k} of the chart is not this row`);
        break;
      }
      const rowCues = !cuesPrinted ? '' : cueOf(k);
      if (rowCues !== lineCues) {
        problems.push(`Row ${k} has other cues (${rowCues === '' ? 'none' : rowCues})`);
        break;
      }
    }
    for (const problem of problems) issues.push(issue('E_FOLD', `Rows ${line.n}–${line.nEnd}: ${problem}`, at(line)));
  }
  issues.push(
    ...repeatRules(rows, insane, at, {
      word: 'Row',
      even: true,
      count: R,
      ops: (k) => flatRowOps(grid, k, i.hand, stitch),
      cues: (k) => (cuesPrinted ? cueOf(k) : ''),
    }),
  );

  if (!tapestry) {
    for (const row of plan.rows) {
      for (const seg of row.segments) {
        for (const gap of seg.gaps) {
          const width = gap.x1 - gap.x0 + 1;
          if (width > CARRY_MAX) {
            issues.push(
              issue('W_LONG_CARRY', `Row ${row.k}: ${code(seg.label)} is carried across ${width} sts (more than ${CARRY_MAX}); use a separate bobbin`, {
                ...(piece === undefined ? {} : { piece }),
                line: row.k,
                row: row.r,
                col: gap.x0,
              }),
            );
          }
        }
      }
    }
  }
  if (tplan !== null) issues.push(...heldWarnings(tplan, 'Row', piece));
  for (const row of tapestry ? [] : plan.rows) {
    if (row.segments.length > ROW_STRANDS_WARN) {
      issues.push(
        issue('W_ROW_COLORS', `Row ${row.k}: ${row.segments.length} strands are worked in this row (more than ${ROW_STRANDS_WARN}); consider merging small areas`, {
          ...(piece === undefined ? {} : { piece }),
          line: row.k,
          row: row.r,
        }),
      );
    }
  }
  return issues;
}

/** W_ROW_COLORS for tapestry lines that hold more than 6 colors. */
function heldWarnings(plan: TapestryPlan, word: 'Row' | 'Rnd', piece: string | undefined): Issue[] {
  const out: Issue[] = [];
  for (const line of plan.lines) {
    if (line.held.length > ROW_STRANDS_WARN) {
      out.push(
        issue('W_ROW_COLORS', `${word} ${line.k}: ${line.held.length} colors are carried in this ${word === 'Row' ? 'row' : 'round'} (more than ${ROW_STRANDS_WARN}); consider merging colors`, {
          ...(piece === undefined ? {} : { piece }),
          line: line.k,
        }),
      );
    }
  }
  return out;
}

/** How the repeat rules see the lines of a piece: chart-derived ops and cues of line k. */
interface RepeatFamily {
  word: 'Row' | 'Rnd';
  /** Flat work (and turned rounds): the block must have an even number of lines. */
  even: boolean;
  count: number;
  ops: (k: number) => Op[];
  cues: (k: number) => string;
}

/** E_FOLD for block repeat notes (repeats.ts): the block, its place, and the lines it stands for. */
function repeatRules(lines: readonly Line[], insane: ReadonlySet<Line>, at: At, f: RepeatFamily): Issue[] {
  const issues: Issue[] = [];
  for (const line of lines) {
    if (insane.has(line)) continue;
    const rep = lineRepeat(line);
    if (rep === null) continue;
    const [c, d] = rep.source;
    const L = d - c + 1;
    const name = `${f.word}s ${rep.from}–${rep.to}`;
    const problems: string[] = [];
    const end = line.nEnd !== undefined && line.nEnd > line.n ? line.nEnd : line.n;
    if (end !== d) problems.push(`the repeat note belongs on ${f.word} ${d}, the last ${f.word.toLowerCase()} of the block`);
    if (c < 2 || L < 2 || c > d) problems.push(`a repeated block is 2 or more ${f.word.toLowerCase()}s and never includes ${f.word} 1`);
    else if (f.even && L % 2 === 1) problems.push(`a block of ${L} ${f.word.toLowerCase()}s would change sides (RS/WS): repeat an even number of ${f.word.toLowerCase()}s`);
    if (rep.from !== d + 1 || rep.to - rep.from + 1 !== L * rep.times || rep.to > f.count) problems.push(`it must follow the block and cover ${rep.times} × ${L} ${f.word.toLowerCase()}s of the chart`);
    if (problems.length === 0) {
      for (let k = rep.from; k <= rep.to; k++) {
        const src = c + ((k - rep.from) % L);
        if (!sameLineOps(f.ops(k), f.ops(src)) || f.cues(k) !== f.cues(src)) {
          problems.push(`${f.word} ${k} of the chart is not ${f.word} ${src}`);
          break;
        }
      }
    }
    for (const problem of problems) issues.push(issue('E_FOLD', `${name}: ${problem}`, at(line)));
  }
  return issues;
}

/**
 * Every shift s (0 ≤ s < C) with `got[x] = base[(x − s) mod C]` for all x: the occurrences of `got` in `base`
 * written twice (KMP, O(C)).
 */
export function rotationsOf(base: ArrayLike<number>, got: readonly number[]): number[] {
  const C = base.length;
  if (got.length !== C || C === 0) return [];
  const fail = new Int32Array(C);
  for (let i = 1, k = 0; i < C; i++) {
    while (k > 0 && got[i] !== got[k]) k = fail[k - 1];
    if (got[i] === got[k]) k++;
    fail[i] = k;
  }
  const out: number[] = [];
  for (let i = 0, k = 0; i < 2 * C - 1; i++) {
    const v = base[i % C];
    while (k > 0 && v !== got[k]) k = fail[k - 1];
    if (v === got[k]) k++;
    if (k === C) {
      const t = i - C + 1;
      out.push((C - t) % C);
      k = fail[k - 1];
    }
  }
  return out.sort((a, b) => a - b);
}

/**
 * The lean the rounds were written with, read from the rounds when not given: `turn` when a round turns or is
 * WS; otherwise `preskew` with the smallest rate whose shifts make every round its chart row, or `note`.
 */
export function inferRoundLean(grid: ChartGrid, hand: Hand, lines: readonly Line[]): RoundLean {
  const rounds = lines.filter((line) => line.kind === 'rnd' && Array.isArray(line.ops));
  if (rounds.some((line) => line.start?.k === 'turn' || line.side === 'WS')) return { mode: 'turn', stPerRnd: 0.5 };
  const C = grid.cols;
  const codes = grid.palette.map((entry) => entry.code);
  // The rotations s with which each round equals its chart row (unskewed sequence rotated by s).
  const sets: { k: number; s: number[] }[] = [];
  for (const line of rounds) {
    if (line.nEnd !== undefined && line.nEnd > line.n) continue;
    if (line.n < 2 || line.n > grid.rows || line.ops.length !== C) continue;
    const got = line.ops.map((op) => codes.indexOf(op.color ?? ''));
    const base = roundLabels(grid, line.n, hand, { mode: 'note', stPerRnd: 0 }, 0);
    sets.push({ k: line.n, s: rotationsOf(base, got) });
  }
  if (sets.every((x) => x.s.length === 0 || x.s.includes(0))) return { mode: 'note', stPerRnd: 0.5 };
  const fits = (p: number): boolean => sets.every((x) => x.s.length === 0 || x.s.includes(((roundHalfUp(p * (x.k - 1)) % C) + C) % C));
  const last = [...sets].reverse().find((x) => x.s.length > 0 && !x.s.includes(0));
  if (last !== undefined && last.k >= 2) {
    const candidates: number[] = [];
    for (const s of last.s.slice(0, 4)) {
      for (let m = -2; m <= 2; m++) {
        const t = s + m * C;
        for (let j = 0; j <= 10; j++) candidates.push((t - 0.5 + j / 10.0001) / (last.k - 1));
      }
    }
    candidates.sort((a, b) => Math.abs(a) - Math.abs(b) || a - b);
    for (const p of candidates) if (fits(p)) return { mode: 'preskew', stPerRnd: p };
  }
  return { mode: 'note', stPerRnd: 0.5 };
}

/** The rules of `sc_tapestry_round` rounds (see the file header). */
function roundRules(i: Validate2DInput, grid: ChartGrid, lines: readonly Line[], insane: ReadonlySet<Line>, palette: ReadonlySet<string>, piece: string | undefined, at: At): Issue[] {
  const issues: Issue[] = [];
  const hand: Hand = i.hand === 'left' ? 'left' : 'right';
  const lean = i.roundLean !== undefined ? roundLeanOf(i.roundLean) : inferRoundLean(grid, hand, lines);
  const C = grid.cols;
  const R = grid.rows;
  const code = (label: number): string => labelCode(grid, label);
  const seqs: Uint8Array[] = [];
  for (let k = 1; k <= R; k++) seqs.push(roundLabels(grid, k, hand, lean));
  const plan = planTapestry(seqs, grid.palette.length);
  const opsOf = (k: number): Op[] => Array.from(seqs[k - 1], (label) => ({ k: 'st', st: 'sc', color: code(label) }) as Op);
  const rounds = lines.filter((line) => typeof line === 'object' && line !== null && line.kind === 'rnd');
  const cuesPrinted = rounds.some((line) => !insane.has(line) && (line.cues ?? []).some((cue) => cue.kind === 'color'));
  const cueOf = (k: number): string => (!cuesPrinted || plan.lines[k - 1] === undefined ? '' : tapestryCueTexts(plan.lines[k - 1], code).join(' · '));
  const arrowOf = (k: number): '←' | '→' => (roundReadsRightToLeft(k, hand, lean) ? '←' : '→');
  const how = lean.mode === 'preskew' ? `, shifted ${'{s}'} sts` : '';

  let expected = 1;
  for (const line of rounds) {
    if (insane.has(line)) continue;
    const made = lineProduced(line);
    if (made !== C) issues.push(issue('E_RUN_SUM', `Rnd ${line.n}: its runs sum to ${made} sts, but the round is ${C} sts (${made} ≠ ${C})`, at(line)));
    const end = line.nEnd !== undefined && line.nEnd > line.n ? line.nEnd : line.n;
    if (line.n > expected) {
      const missing = line.n - 1 === expected ? `Rnd ${expected} is` : `Rnds ${expected}–${line.n - 1} are`;
      issues.push(issue('E_RUN_SUM', `${missing} missing: every row of the chart must be worked (0 ≠ ${C})`, at(line)));
    } else if (line.n < expected) {
      issues.push(issue('E_RUN_SUM', `Rnd ${line.n} comes again after Rnd ${expected - 1}: the rounds must cover the chart once, in order`, at(line)));
    }
    expected = Math.max(expected, end + 1);
    const rep = lineRepeat(line);
    if (rep !== null && rep.from === expected && rep.to >= rep.from) expected = rep.to + 1;
  }
  if (expected <= R) {
    const missing = expected === R ? `Rnd ${R} is` : `Rnds ${expected}–${R} are`;
    issues.push(issue('E_RUN_SUM', `${missing} missing: the chart has ${R} rows (0 ≠ ${C})`));
  } else if (expected > R + 1) {
    issues.push(issue('E_RUN_SUM', `the pattern has ${expected - 1} rounds but the chart only ${R} rows`));
  }

  for (const line of rounds) {
    if (insane.has(line) || line.n > R) continue;
    const k = line.n;
    const folded = line.nEnd !== undefined && line.nEnd > line.n;
    // E_FOUNDATION: a ring of ch C, then joined (or turned) rounds.
    if (k === 1 && (line.start?.k !== 'chainRing' || line.start.chains !== C)) {
      issues.push(issue('E_FOUNDATION', `Rnd 1: a ${C}-st tube starts from a ring of ch ${C} (ch ${C}; join with sl st in first ch)`, at(line)));
    } else if (k > 1) {
      const turn = lean.mode === 'turn';
      const ok = turn ? line.start?.k === 'turn' && line.start.chains === 1 : line.start?.k === 'join';
      if (!ok) issues.push(issue('E_FOUNDATION', `Rnd ${k}: ${turn ? 'a turned round starts “Ch 1, turn.”' : 'a joined round starts “Ch 1,” in the join'}`, at(line)));
    }
    if (line.join === undefined) issues.push(issue('E_FOUNDATION', `Rnd ${k}: every round ends “join with sl st in first sc”`, at(line)));
    const want = opsOf(k);
    const side = roundSide(k, lean);
    const arrow = arrowOf(k);
    const inPalette = line.ops.every((op) => op.color !== undefined && palette.has(op.color));
    if (lineProduced(line) === C && inPalette && !sameLineOps(want, line.ops)) {
      const s = roundShift(k, lean);
      issues.push(issue('E_RUN_SUM', `Rnd ${k}: its runs are not chart row ${k} read ${arrow === '←' ? 'right to left' : 'left to right'} (${hand}-handed${how.replace('{s}', String(s))})`, at(line)));
    }
    if (line.side !== side || line.arrow !== arrow) {
      issues.push(issue('E_RUN_SUM', `Rnd ${k}: it is a ${side} round read ${arrow} (${hand}-handed), not ${line.side ?? 'no side'} ${line.arrow ?? 'no arrow'}`, at(line)));
    }
    if (folded) {
      const problems: string[] = [];
      const lineCues = (line.cues ?? []).filter((cue) => cue.kind === 'color').map((cue) => cue.text).join(' · ');
      for (let j = k + 1; j <= Math.min(line.nEnd!, R); j++) {
        if (!sameLineOps(opsOf(j), line.ops)) {
          problems.push(`Rnd ${j} of the chart is not this round`);
          break;
        }
        if (roundSide(j, lean) !== line.side || arrowOf(j) !== line.arrow) {
          problems.push(`Rnd ${j} is worked from the other side`);
          break;
        }
        if (cueOf(j) !== lineCues) {
          problems.push(`Rnd ${j} has other cues (${cueOf(j) === '' ? 'none' : cueOf(j)})`);
          break;
        }
      }
      if (cuesPrinted && cueOf(k) !== lineCues) problems.push(`Rnd ${k} has other cues (${cueOf(k) === '' ? 'none' : cueOf(k)})`);
      for (const problem of problems) issues.push(issue('E_FOLD', `Rnds ${line.n}–${line.nEnd}: ${problem}`, at(line)));
    }
  }
  issues.push(...repeatRules(rounds, insane, at, { word: 'Rnd', even: lean.mode === 'turn', count: R, ops: opsOf, cues: cueOf }));
  issues.push(...heldWarnings(plan, 'Rnd', piece));
  return issues;
}

/** Options of `validateDoc2D`: the settings and gauge the pattern was built with, when known. */
export interface ValidateDoc2DOptions {
  settings?: Partial<Pick<ChartSettings, 'roundLean' | 'startCorner'>> & { border?: { widthIn: number; color?: string } };
  gauge?: Pick<ResolvedGauge, 'cell' | 'wSc' | 'hSc'>;
}

/**
 * `validate2D` for every piece of a 2D pattern (`doc.chart` and `doc.hand`); [] for a 3D pattern. The codes of
 * `doc.materials` are valid colors (a border yarn). Without settings, a tapestry round's lean and a C2C start
 * corner are read from the lines.
 */
export function validateDoc2D(doc: PatternDoc, o: ValidateDoc2DOptions = {}): Issue[] {
  if (doc.kind !== '2d' || doc.chart === undefined) return [];
  const out: Issue[] = [];
  const extraCodes = Array.isArray(doc.materials) ? doc.materials.map((m) => m.code) : [];
  for (const p of doc.pieces) {
    out.push(
      ...validate2D({
        chart: doc.chart.grid,
        technique: doc.chart.technique,
        hand: doc.hand,
        lines: p.lines,
        piece: p.id,
        extraCodes,
        roundLean: o.settings?.roundLean,
        startCorner: o.settings?.startCorner,
        gauge: o.gauge,
        border: o.settings?.border,
      }),
    );
  }
  return out;
}
