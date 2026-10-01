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
//   W_LONG_CARRY  a color carried across more than 8 stitches (bobbin techniques)
//   W_ROW_COLORS  more than 6 strands worked in one row (§2.4.3)
//
// plus every rule of the Step 0 line validator (`validateLines`, docKind '2d', with the palette's codes).
// E_C2C_TILES, E_MOSAIC_ADJ and E_BORDER come with their writers (T2.2, T2.4).
import type { ChartGrid, Hand, Issue, Line, PatternDoc, Technique2D } from '../../types';
import { type LineIssueCode, validateLines } from '../pattern/validateLine';
import { isOp, lineProduced } from '../pattern/ops';
import { type FlatStitch, directionIndependent, flatFoundation, flatRowOps, labelCode, TURN_CHAINS } from './scFlat';
import { CARRY_MAX, ROW_STRANDS_WARN, type StrandPlan, planStrands, readsRightToLeft, rowCueTexts } from './strands';

export type Validate2DCode = LineIssueCode | 'E_RUN_SUM' | 'E_FOLD' | 'W_LONG_CARRY' | 'W_ROW_COLORS';

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

const JOIN_CUE = /^\s*join\s+(\S+)\s+\(bobbin\s+\d+\)\s*$/;
const CARRY_CUE = /^\s*carry\s+(.+?)\s*$/;

/** The color codes a color cue names (`join B (bobbin 2)`, `carry A, C`). */
export function cueColors(text: string): string[] {
  const join = JOIN_CUE.exec(text);
  if (join !== null) return [join[1]];
  const carry = CARRY_CUE.exec(text);
  if (carry !== null) return carry[1].split(',').map((code) => code.trim()).filter((code) => code !== '');
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
  /** The strand plan the lines were written with; computed when left out (flat-row techniques). */
  plan?: StrandPlan;
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
  const codes = grid.palette.map((entry) => entry.code);
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
      for (const code of cueColors(cue.text)) if (!palette.has(code)) issues.push(issue('E_COLOR', `Row ${line.n}: the cue “${cue.text}” names color ${code}, which is not in the palette`, at(line)));
    }
  }

  if (!FLAT_ROW_TECHNIQUES.has(i.technique)) return issues;
  const stitch = flatStitchOf(i.technique);
  const W = grid.cols;
  const R = grid.rows;
  const rows = lines.filter((line) => typeof line === 'object' && line !== null && line.kind === 'row');

  // E_RUN_SUM: every row is W stitches, and the rows cover 1..R once each, in order.
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
  const plan = i.plan ?? planStrands(grid, { hand: i.hand });
  const code = (label: number): string => labelCode(grid, label);
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
      const planRow = plan.rows[k - 1];
      const rowCues = planRow === undefined || !cuesPrinted ? '' : rowCueTexts(planRow, code).join(' · ');
      if (rowCues !== lineCues) {
        problems.push(`Row ${k} has other cues (${rowCues === '' ? 'none' : rowCues})`);
        break;
      }
    }
    for (const problem of problems) issues.push(issue('E_FOLD', `Rows ${line.n}–${line.nEnd}: ${problem}`, at(line)));
  }

  if (i.technique !== 'sc_tapestry') {
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
  for (const row of plan.rows) {
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

/** `validate2D` for every piece of a 2D pattern (`doc.chart` and `doc.hand`); [] for a 3D pattern. */
export function validateDoc2D(doc: PatternDoc): Issue[] {
  if (doc.kind !== '2d' || doc.chart === undefined) return [];
  const out: Issue[] = [];
  for (const p of doc.pieces) out.push(...validate2D({ chart: doc.chart.grid, technique: doc.chart.technique, hand: doc.hand, lines: p.lines, piece: p.id }));
  return out;
}
