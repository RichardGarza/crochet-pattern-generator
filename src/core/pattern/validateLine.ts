// The line validator (DESIGN.md §2.13; research 07 §7.3, 03 §6.7). Step 0 kernel: pure, no DOM.
//
// It checks what can be decided from one `Line` (and, when given, the line before it). Every rule has one code,
// and every code here is an error:
//
//   E_SANITY          the line is not well formed: a count that is not an integer ≥ 1, an op outside the frozen
//                     `Op` type, a start with impossible numbers, a segment index outside the ops. When this
//                     fires nothing else is checked.
//   E_CONSUME   (R1)  Σ consumed(ops) ≠ the previous count. Lines that start a piece are exempt: magic ring,
//                     foundation chain, chain oval, chain ring, the `edge` round of a border, the first C2C tile.
//                     A folded line (`nEnd`) must also leave the count unchanged, or its second round would not
//                     fit on its first.
//   E_PRODUCE   (R1)  Σ produced(ops) ≠ `Line.stated`, the count printed in parentheses.
//   E_INC_INFEASIBLE / E_DEC_INFEASIBLE (R3, R4)
//                     stated > 2 × previous without an inc3 (or > 3 × at all); stated < previous / 2 without a
//                     dec3 (or < previous / 3 at all). Such a round cannot be worked; it needs inc3 / dec3
//                     (T4 then raises W_FAN3) or one more round.
//   E_COLOR           a color code that is not in the palette (checked only when a palette is given).
//   E_ROUNDTRIP (R10) `expand(encodeOps(ops))` does not deep-equal the ops, or the text that would be printed
//                     adds up to another count. It guards the encoder and the renderer: it cannot fire unless
//                     one of them has a bug.
//
// Not here: rules that need the chart, the piece or the 3D model (E_RUN_SUM, E_FOUNDATION, E_C2C_TILES,
// E_BORDER, E_FOLD, E_START, E_SPIRAL_CHAIN, E_CLOSE, the W_* rules, …) belong to the 2D and 3D validators of
// T2 and T4. `startCapacity` (ops.ts) gives them the number a first line should consume.
import type { Issue, Line, LineStart, Op, PatternDoc } from '../../types';
import { compactCount, compactEncodeMode } from './compact';
import { encodeOps } from './encode';
import { expand, isConsumeExempt, isOp, itemsProduced, lineConsumed, lineProduced } from './ops';

/** The codes `validateLine` can return. */
export type LineIssueCode =
  | 'E_SANITY'
  | 'E_CONSUME'
  | 'E_PRODUCE'
  | 'E_INC_INFEASIBLE'
  | 'E_DEC_INFEASIBLE'
  | 'E_COLOR'
  | 'E_ROUNDTRIP';

export interface ValidateLineOptions {
  /**
   * The line worked just before this one, in the same piece. When given, `line.prevCount` must be that line's
   * stated count. Leave it out (or pass null) for the first line of a piece.
   */
  prev?: Line | null;
  /** The palette's color codes. When given, every color code of the line must be one of them (E_COLOR). */
  palette?: Iterable<string>;
  /** `Piece.id`, copied into `where.piece` of every issue. */
  piece?: string;
  /** The kind of pattern the line is printed in (see compact.ts). Default: by line kind. */
  docKind?: PatternDoc['kind'];
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

/** `Rnd 3`, `Rnds 7–12`, `Row 4`: how messages name a line. */
function nameOf(line: Line): string {
  const word = line.kind === 'rnd' || line.kind === 'border' ? 'Rnd' : 'Row';
  return line.nEnd !== undefined && line.nEnd !== line.n ? `${word}s ${line.n}–${line.nEnd}` : `${word} ${line.n}`;
}

function startProblem(start: LineStart): string | null {
  const s = start as { k: unknown; chains?: unknown; firstInto?: unknown; n?: unknown; start?: unknown; end?: unknown };
  switch (s.k) {
    case 'foundation':
      if (!isCount(s.chains) || !isCount(s.firstInto)) return 'a foundation needs whole numbers of chains ≥ 1';
      return s.firstInto > s.chains ? `the first stitch cannot go in chain ${s.firstInto} of ${s.chains}` : null;
    case 'turn':
    case 'chainRing':
      return isCount(s.chains) ? null : 'the number of chains must be a whole number ≥ 1';
    case 'chainOval':
      return isCount(s.chains) && s.chains >= 3 ? null : 'a chain oval needs a whole number of chains ≥ 3';
    case 'mr':
      return isCount(s.n) ? null : 'a magic ring needs a whole number of stitches ≥ 1';
    case 'join':
    case 'edge':
      return null;
    case 'c2c': {
      const ends = ['first', 'inc', 'dec'];
      return ends.includes(s.start as string) && ends.includes(s.end as string) ? null : 'a C2C row begins and ends with first, inc or dec';
    }
    default:
      return `unknown line start ${JSON.stringify(s.k)}`;
  }
}

/** Everything that makes the line unreadable for the other rules. */
function sanityProblems(line: Line): string[] {
  const problems: string[] = [];
  if (line.kind !== 'row' && line.kind !== 'rnd' && line.kind !== 'c2c' && line.kind !== 'border') {
    problems.push(`unknown line kind ${JSON.stringify(line.kind)}`);
  }
  if (!isCount(line.n)) problems.push(`the line number must be a whole number ≥ 1, got ${String(line.n)}`);
  if (line.nEnd !== undefined && !(isCount(line.nEnd) && line.nEnd > line.n)) {
    problems.push(`a folded range must end after it begins, got ${String(line.n)}–${String(line.nEnd)}`);
  }
  if (!isCount(line.stated)) problems.push(`the stated count must be a whole number ≥ 1, got ${String(line.stated)}`);
  if (line.prevCount !== null && !isCount(line.prevCount)) {
    problems.push(`the previous count must be null or a whole number ≥ 1, got ${String(line.prevCount)}`);
  }
  if (!Array.isArray(line.ops)) {
    problems.push('the ops must be an array');
    return problems;
  }
  const bad = line.ops.findIndex((op) => !isOp(op));
  if (bad >= 0) problems.push(`op ${bad + 1} is not a stitch of the pattern language: ${JSON.stringify(line.ops[bad]) ?? 'undefined'}`);
  if (line.start !== undefined) {
    const problem = startProblem(line.start);
    if (problem !== null) problems.push(problem);
  }
  if (line.segments !== undefined) {
    let last = -1;
    for (const segment of line.segments) {
      const at: unknown = segment.at;
      if (typeof at !== 'number' || !Number.isInteger(at) || at <= last || at >= line.ops.length) {
        problems.push(`segment starts must be increasing op indexes inside the line, got ${String(at)}`);
        break;
      }
      last = at;
    }
  }
  return problems;
}

/** Deep equality of two values, where a field set to `undefined` counts as absent. */
function sameValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const key of Object.keys(ra)) if (ra[key] !== undefined && !sameValue(ra[key], rb[key])) return false;
  for (const key of Object.keys(rb)) if (rb[key] !== undefined && ra[key] === undefined) return false;
  return true;
}

function sameOps(a: readonly Op[], b: readonly Op[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
  return true;
}

/**
 * Validates one line (§2.13) and returns its issues, each frozen; an empty array means the line is sound.
 * See the file header for the rules. `Issue.where.line` is the line's number `n` (round or row number).
 */
export function validateLine(line: Line, o: ValidateLineOptions = {}): Issue[] {
  const issues: Issue[] = [];
  const name = nameOf(line);
  const where: Issue['where'] = Object.freeze(o.piece === undefined ? { line: line.n } : { piece: o.piece, line: line.n });
  const report = (code: LineIssueCode, message: string): void => {
    issues.push(Object.freeze({ code, severity: 'error', message: `${name}: ${message}`, where }));
  };

  const problems = sanityProblems(line);
  if (problems.length > 0) {
    for (const problem of problems) report('E_SANITY', problem);
    return issues;
  }

  const used = lineConsumed(line);
  const made = lineProduced(line);
  const exempt = isConsumeExempt(line);
  const unit = line.kind === 'c2c' ? 'ch-3 sps' : 'sts';

  // E_CONSUME
  if (!exempt) {
    const prev = o.prev ?? null;
    if (line.prevCount === null) {
      report('E_CONSUME', `works into ${used} ${unit} but has no previous count (only the first line of a piece may leave it out)`);
    } else {
      if (prev !== null && prev.stated !== line.prevCount) {
        report('E_CONSUME', `expects ${line.prevCount} ${unit} before it, but ${nameOf(prev)} ends with ${prev.stated}`);
      }
      if (used !== line.prevCount) {
        report('E_CONSUME', `works into ${used} ${unit} but the previous count is ${line.prevCount} (${used} ≠ ${line.prevCount})`);
      }
    }
  }
  if (line.nEnd !== undefined && used !== made) {
    report(
      'E_CONSUME',
      `is folded, but each of its rounds works into ${used} and makes ${made}, so the next one cannot follow it (${used} ≠ ${made})`,
    );
  }

  // E_PRODUCE
  if (made !== line.stated) report('E_PRODUCE', `makes ${made} but states ${line.stated} (${made} ≠ ${line.stated})`);

  // E_INC_INFEASIBLE / E_DEC_INFEASIBLE: against the previous count, for stitches (not C2C tiles).
  if (!exempt && line.prevCount !== null && line.kind !== 'c2c') {
    const before = line.prevCount;
    const after = line.stated;
    const has = (k: 'inc' | 'dec'): boolean => line.ops.some((op) => op.k === k && op.n === 3);
    if (after > 3 * before || (after > 2 * before && !has('inc'))) {
      report('E_INC_INFEASIBLE', `${before} sts cannot grow to ${after} in one round${after > 3 * before ? '' : ' without inc3'}; add a round`);
    }
    if (3 * after < before || (2 * after < before && !has('dec'))) {
      report('E_DEC_INFEASIBLE', `${before} sts cannot shrink to ${after} in one round${3 * after < before ? '' : ' without dec3'}; add a round`);
    }
  }

  // E_COLOR
  if (o.palette !== undefined) {
    const palette = new Set(o.palette);
    const unknown = new Set<string>();
    for (const op of line.ops) if (op.color !== undefined && !palette.has(op.color)) unknown.add(op.color);
    if (line.colorHeader !== undefined && !palette.has(line.colorHeader)) unknown.add(line.colorHeader);
    const changeTo = line.join?.changeTo;
    if (changeTo !== undefined && !palette.has(changeTo)) unknown.add(changeTo);
    for (const color of unknown) report('E_COLOR', `color ${JSON.stringify(color)} is not in the palette`);
  }

  // E_ROUNDTRIP
  const docKind = o.docKind;
  const items = encodeOps(line.ops, { mode: compactEncodeMode(line, { docKind }), segments: line.segments });
  if (!sameOps(expand(items), line.ops)) {
    report('E_ROUNDTRIP', 'its encoded form does not expand back to its ops');
  } else if (itemsProduced(items) !== made) {
    report('E_ROUNDTRIP', `its encoded form makes ${itemsProduced(items)}, its ops make ${made}`);
  } else if (made === line.stated) {
    const printed = /\d+/.exec(compactCount(line, { docKind }));
    if (printed === null || Number(printed[0]) !== made) {
      report('E_ROUNDTRIP', `the printed count ${compactCount(line, { docKind })} is not the ${made} its ops make`);
    }
  }

  return issues;
}

/**
 * Validates the lines of one piece in order, each against the line before it. Returns all issues, in line order.
 */
export function validateLines(lines: readonly Line[], o: Omit<ValidateLineOptions, 'prev'> = {}): Issue[] {
  const issues: Issue[] = [];
  for (let i = 0; i < lines.length; i++) {
    for (const issue of validateLine(lines[i], { ...o, prev: i > 0 ? lines[i - 1] : null })) issues.push(issue);
  }
  return issues;
}
