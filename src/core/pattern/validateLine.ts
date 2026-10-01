// The line validator (DESIGN.md §2.13; research 07 §7.3, 03 §6.7). Step 0 kernel: pure, no DOM.
//
// It checks what can be decided from one `Line` (and, when given, the line before it). Every rule has one code,
// and every code here is an error:
//
//   E_SANITY          the line is not well formed: a count that is not a whole number from 1 to 19 999, an op
//                     outside the frozen `Op` type, a start with impossible numbers or on the wrong kind of
//                     line, tiles outside a C2C row, a field of the wrong type. When this fires nothing else is
//                     checked, and nothing ever throws: a malformed line is reported.
//   E_CONSUME   (R1)  Σ consumed(ops) ≠ the previous count. Lines that start a piece are exempt: magic ring,
//                     foundation chain, chain oval, chain ring, the `edge` round of a border, the first C2C tile.
//                     A folded line (`nEnd`) must also leave the count unchanged, or its second round would not
//                     fit on its first.
//   E_START     (R2)  the single-line part of the rule: a round that starts a piece does not fit its start — a
//                     magic ring of n takes n plain stitches, ch N of an oval offers 2N − 3 loops, a chain ring
//                     N. (In `validateLines` also: a piece whose first line starts from nothing, or a second
//                     start in the middle of a piece.) The sizes a start may have (5–8, classic 6, 2S + 6) and
//                     the pole rule need the piece and belong to T4.
//   E_FOUNDATION      the single-line part: row 1 works into more or fewer chains than `chains − firstInto + 1`.
//                     Which chain a technique starts in (W + h_tc − c) belongs to T2.
//   E_PRODUCE   (R1)  Σ produced(ops) ≠ `Line.stated`, the count printed in parentheses.
//   E_INC_INFEASIBLE / E_DEC_INFEASIBLE (R3, R4)
//                     stated > 2 × previous without an inc3 (or > 3 × at all); stated < previous / 2 without a
//                     dec3 (or < previous / 3 at all). Such a round cannot be worked; it needs inc3 / dec3
//                     (T4 then raises W_FAN3) or one more round. It always comes with E_CONSUME or E_PRODUCE
//                     and says why they cannot be repaired by moving stitches.
//   E_COLOR           a color code that is not in the palette (checked only when a palette is given).
//   E_ROUNDTRIP (R10) the encoded form that is printed does not expand back to the line's ops, or adds up to
//                     another count. It guards the encoder and the renderer: it cannot fire unless one of them
//                     has a bug.
//
// Not here: rules that need the chart, the piece or the 3D model (E_RUN_SUM, E_C2C_TILES, E_BORDER, E_FOLD,
// E_SPIRAL_CHAIN, E_CLOSE, the limits per piece of E_SANITY, the W_* rules, …) belong to the 2D and 3D
// validators of T2 and T4.
import type { Issue, Line, PatternDoc } from '../../types';
import { compactCount, lineItems } from './compact';
import { START_LINE_KINDS, type StartKind, displayOps, expand, isConsumeExempt, isOp, itemsProduced, lineConsumed, lineProduced, startCapacity } from './ops';

/** The codes `validateLine` and `validateLines` can return. */
export type LineIssueCode =
  | 'E_SANITY'
  | 'E_CONSUME'
  | 'E_START'
  | 'E_FOUNDATION'
  | 'E_PRODUCE'
  | 'E_INC_INFEASIBLE'
  | 'E_DEC_INFEASIBLE'
  | 'E_COLOR'
  | 'E_ROUNDTRIP';

export interface ValidateLineOptions {
  /**
   * The line worked just before this one, in the same piece. When given, `line.prevCount` must be that line's
   * stated count. Leave it out (or pass null) when there is none or it is not known.
   */
  prev?: Line | null;
  /** The palette's color codes. When given, every color code of the line must be one of them (E_COLOR). */
  palette?: Iterable<string>;
  /** `Piece.id`, copied into `where.piece` of every issue. */
  piece?: string;
  /** The kind of pattern the line is printed in (see compact.ts). Default: by line kind. */
  docKind?: PatternDoc['kind'];
}

/** No line has this many stitches: R15 allows fewer than 20 000 per piece (§2.13). */
const STITCH_LIMIT = 20000;

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A short, safe description of any value for a message (never throws: bigint, cycles, …). */
function show(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = Object.prototype.toString.call(value);
  }
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

/** `Rnd 3`, `Rnds 7–12`, `Row 4`: how messages name a line. */
function nameOf(line: Line): string {
  const word = line.kind === 'rnd' || line.kind === 'border' ? 'Rnd' : 'Row';
  if (!isCount(line.n)) return word;
  return isCount(line.nEnd) && line.nEnd > line.n ? `${word}s ${line.n}–${line.nEnd}` : `${word} ${line.n}`;
}

const LINE_KINDS: readonly unknown[] = ['row', 'rnd', 'c2c', 'border'];
const ARROWS: readonly unknown[] = ['←', '→', '↙', '↗', '↖', '↘'];
const CUE_KINDS: readonly unknown[] = ['eyes', 'stuff', 'note', 'color'];
const C2C_ENDS: readonly unknown[] = ['first', 'inc', 'dec'];

/** What is wrong with the numbers of a start, or null. */
function startProblem(start: Record<string, unknown>): string | null {
  switch (start.k) {
    case 'foundation':
      if (!isCount(start.chains) || !isCount(start.firstInto)) return 'a foundation needs whole numbers of chains ≥ 1';
      return start.firstInto > start.chains ? `the first stitch cannot go in chain ${start.firstInto} of ${start.chains}` : null;
    case 'turn':
    case 'chainRing':
      return isCount(start.chains) ? null : 'the number of chains must be a whole number ≥ 1';
    case 'chainOval':
      return isCount(start.chains) && start.chains >= 3 ? null : 'a chain oval needs a whole number of chains ≥ 3';
    case 'mr':
      return isCount(start.n) ? null : 'a magic ring needs a whole number of stitches ≥ 1';
    case 'join':
    case 'edge':
      return null;
    case 'c2c':
      if (!C2C_ENDS.includes(start.start) || !C2C_ENDS.includes(start.end)) return 'a C2C row begins and ends with first, inc or dec';
      return (start.start === 'first') === (start.end === 'first') ? null : 'only the first tile of a C2C piece is tagged first, at both ends';
    default:
      return `unknown line start ${show(start.k)}`;
  }
}

/** Everything that makes the line unreadable for the other rules (and for the renderer). */
function sanityProblems(line: Line): string[] {
  const fields = line as unknown as Record<string, unknown>;
  const problems: string[] = [];
  const kindOk = LINE_KINDS.includes(fields.kind);
  if (!kindOk) problems.push(`unknown line kind ${show(fields.kind)}`);
  if (!isCount(fields.n)) problems.push(`the line number must be a whole number ≥ 1, got ${show(fields.n)}`);
  const folded = isCount(fields.n) && isCount(fields.nEnd) && fields.nEnd > fields.n;
  if (fields.nEnd !== undefined && !(isCount(fields.nEnd) && isCount(fields.n) && fields.nEnd >= fields.n)) {
    problems.push(`a folded range cannot end before it begins, got ${show(fields.n)}–${show(fields.nEnd)}`);
  }
  if (!isCount(fields.stated) || fields.stated >= STITCH_LIMIT) {
    problems.push(`the stated count must be a whole number from 1 to ${STITCH_LIMIT - 1}, got ${show(fields.stated)}`);
  }
  if (fields.prevCount !== null && (!isCount(fields.prevCount) || fields.prevCount >= STITCH_LIMIT)) {
    problems.push(`the previous count must be null or a whole number from 1 to ${STITCH_LIMIT - 1}, got ${show(fields.prevCount)}`);
  }

  const ops: unknown = fields.ops;
  if (!Array.isArray(ops)) {
    problems.push('the ops must be an array');
    return problems;
  }
  let opsOk = true;
  for (let i = 0; i < ops.length; i++) {
    if (!isOp(ops[i])) {
      problems.push(`op ${i + 1} is not a stitch of the pattern language: ${show(ops[i])}`);
      opsOk = false;
      break;
    }
  }
  if (opsOk && kindOk) {
    const tiles = ops.filter((op: { k: string }) => op.k === 'tile').length;
    if (fields.kind === 'c2c' && tiles !== ops.length) problems.push('a C2C row is made of tiles only');
    if (fields.kind !== 'c2c' && tiles > 0) problems.push('tiles belong to C2C rows only');
  }

  const start = fields.start;
  if (start !== undefined) {
    if (!isRecord(start)) {
      problems.push(`the line start must be an object, got ${show(start)}`);
    } else {
      const problem = startProblem(start);
      if (problem !== null) {
        problems.push(problem);
      } else if (kindOk) {
        const kinds: readonly unknown[] = START_LINE_KINDS[start.k as StartKind];
        if (!kinds.includes(fields.kind)) problems.push(`a ${show(start.k)} start cannot stand on a line of kind ${show(fields.kind)}`);
        else if (folded && isConsumeExempt(line)) problems.push('the line that starts a piece cannot be folded with the lines after it');
      }
    }
  } else if (fields.kind === 'c2c') {
    problems.push('a C2C row needs its start tag (first, inc or dec at each end)');
  }

  const segments = fields.segments;
  if (segments !== undefined) {
    if (!Array.isArray(segments)) {
      problems.push('the segments must be an array');
    } else {
      let last = 0;
      for (const segment of segments as unknown[]) {
        const at = isRecord(segment) ? segment.at : undefined;
        const kind = isRecord(segment) ? segment.kind : undefined;
        if (typeof at !== 'number' || !Number.isInteger(at) || at < last || at > ops.length || (kind !== 'side' && kind !== 'end')) {
          problems.push(`segments must be { at, kind: 'side' | 'end' } with op indexes in order and inside the line, got ${show(segment)}`);
          break;
        }
        last = at;
      }
    }
  }

  if (fields.side !== undefined && fields.side !== 'RS' && fields.side !== 'WS') problems.push(`the side must be RS or WS, got ${show(fields.side)}`);
  if (fields.arrow !== undefined && !ARROWS.includes(fields.arrow)) problems.push(`unknown arrow ${show(fields.arrow)}`);
  if (fields.colorHeader !== undefined && typeof fields.colorHeader !== 'string') {
    problems.push(`the color header must be a color code, got ${show(fields.colorHeader)}`);
  }
  const join = fields.join;
  if (join !== undefined) {
    if (!isRecord(join)) problems.push(`the join must be an object, got ${show(join)}`);
    else if (join.changeTo !== undefined && typeof join.changeTo !== 'string') problems.push(`the join's color must be a color code, got ${show(join.changeTo)}`);
    else if (join.drop !== undefined && join.drop !== 'carry' && join.drop !== 'cut') problems.push(`the join's drop must be carry or cut, got ${show(join.drop)}`);
  }
  const cues = fields.cues;
  if (cues !== undefined) {
    const ok = Array.isArray(cues) && cues.every((cue: unknown) => isRecord(cue) && CUE_KINDS.includes(cue.kind) && typeof cue.text === 'string');
    if (!ok) problems.push('the cues must be an array of { kind, text }');
  }
  const notes = fields.notes;
  if (notes !== undefined && !(Array.isArray(notes) && notes.every((note: unknown) => typeof note === 'string'))) {
    problems.push('the notes must be an array of strings');
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

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!sameValue(a[i], b[i])) return false;
  return true;
}

function makeIssue(code: LineIssueCode, message: string, where: Issue['where']): Issue {
  return Object.freeze(where === undefined ? { code, severity: 'error', message } : { code, severity: 'error', message, where });
}

function whereOf(line: Line, piece: string | undefined): Issue['where'] {
  const where: { piece?: string; line?: number } = {};
  if (piece !== undefined) where.piece = piece;
  if (isCount(line.n)) where.line = line.n;
  return Object.freeze(where);
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th'}`;
}

/**
 * Validates one line (§2.13) and returns its issues, each frozen; an empty array means the line is sound.
 * See the file header for the rules. `Issue.where.line` is the line's number `n` (round or row number).
 * A malformed line is reported as E_SANITY; nothing is thrown for any `line`.
 */
export function validateLine(line: Line, o: ValidateLineOptions | null = {}): Issue[] {
  const options = o ?? {};
  if (!isRecord(line)) return [makeIssue('E_SANITY', `not a pattern line: ${show(line)}`, undefined)];
  const issues: Issue[] = [];
  const name = nameOf(line);
  const where = whereOf(line, typeof options.piece === 'string' ? options.piece : undefined);
  const report = (code: LineIssueCode, message: string): void => {
    issues.push(makeIssue(code, `${name}: ${message}`, where));
  };

  const problems = sanityProblems(line);
  if (problems.length > 0) {
    for (const problem of problems) report('E_SANITY', problem);
    return issues;
  }

  const used = lineConsumed(line);
  const made = lineProduced(line);
  const exempt = isConsumeExempt(line);
  const folded = line.nEnd !== undefined && line.nEnd > line.n;
  const unit = line.kind === 'c2c' ? 'ch-3 sps' : 'sts';

  // E_CONSUME
  if (!exempt) {
    const prev = isRecord(options.prev) && isCount(options.prev.stated) ? options.prev : null;
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
  if (folded && used !== made) {
    report(
      'E_CONSUME',
      `is folded, but each of its rounds works into ${used} and makes ${made}, so the next one cannot follow it (${used} ≠ ${made})`,
    );
  }

  // E_START / E_FOUNDATION: the first line of a piece must fit what it starts from.
  const start = line.start;
  const capacity = startCapacity(start);
  if (start !== undefined && capacity !== null) {
    if (start.k === 'mr' && line.ops.some((op) => op.k !== 'st')) {
      report('E_START', 'only plain stitches can be worked into a magic ring');
    } else if (used !== capacity) {
      if (start.k === 'mr') report('E_START', `a magic ring of ${start.n} takes ${start.n} stitches, not ${used} (${used} ≠ ${capacity})`);
      else if (start.k === 'chainOval') report('E_START', `an oval on ch ${start.chains} offers ${capacity} loops, but the round works into ${used} (${used} ≠ ${capacity})`);
      else if (start.k === 'chainRing') report('E_START', `a ring of ch ${start.chains} offers ${capacity} chains, but the round works into ${used} (${used} ≠ ${capacity})`);
      else if (start.k === 'foundation') {
        report(
          'E_FOUNDATION',
          `ch ${start.chains} worked from the ${ordinal(start.firstInto)} ch offers ${capacity} chains, but the row works into ${used} (${used} ≠ ${capacity})`,
        );
      }
    }
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
  if (options.palette !== undefined && options.palette !== null) {
    const palette = new Set(options.palette);
    const unknown = new Set<string>();
    for (const op of line.ops) if (op.color !== undefined && !palette.has(op.color)) unknown.add(op.color);
    if (line.colorHeader !== undefined && !palette.has(line.colorHeader)) unknown.add(line.colorHeader);
    const changeTo = line.join?.changeTo;
    if (changeTo !== undefined && !palette.has(changeTo)) unknown.add(changeTo);
    for (const color of unknown) report('E_COLOR', `color ${show(color)} is not in the palette`);
  }

  // E_ROUNDTRIP: what is printed must be the line.
  const docKind = options.docKind;
  try {
    const items = lineItems(line, { docKind });
    if (!sameList(expand(items), displayOps(line))) {
      report('E_ROUNDTRIP', 'its encoded form does not expand back to its ops');
    } else if (itemsProduced(items) !== made) {
      report('E_ROUNDTRIP', `its encoded form makes ${itemsProduced(items)}, its ops make ${made}`);
    } else if (made === line.stated) {
      const count = compactCount(line, { docKind });
      const printed = /\d+/.exec(count);
      if (printed === null || Number(printed[0]) !== made) report('E_ROUNDTRIP', `the printed count ${count} is not the ${made} its ops make`);
    }
  } catch (error) {
    report('E_ROUNDTRIP', `its ops could not be encoded: ${error instanceof Error ? error.message : show(error)}`);
  }

  return issues;
}

/**
 * Validates the lines of one whole piece in order, each against the line before it, and returns all issues in
 * line order. On top of `validateLine` it checks the shape of the piece (E_START): the first line must start
 * from a magic ring, a chain, a panel edge or a first C2C tile, and no later line may start a new piece (a
 * border's `edge` round may follow the rows it is worked around). To check a line on its own, or part of a
 * piece, use `validateLine` with `prev`.
 */
export function validateLines(lines: readonly Line[], o: Omit<ValidateLineOptions, 'prev'> | null = {}): Issue[] {
  const options = o ?? {};
  if (!Array.isArray(lines)) return [makeIssue('E_SANITY', `the lines of a piece must be an array, got ${show(lines)}`, undefined)];
  const issues: Issue[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line: Line = lines[i];
    const own = validateLine(line, { ...options, prev: i > 0 ? lines[i - 1] : null });
    for (const issue of own) issues.push(issue);
    if (own.some((issue) => issue.code === 'E_SANITY')) continue;
    const where = whereOf(line, typeof options.piece === 'string' ? options.piece : undefined);
    const startsPiece = isConsumeExempt(line);
    if (i === 0 && !startsPiece) {
      issues.push(makeIssue('E_START', `${nameOf(line)}: is the first line of its piece and needs something to start from (a magic ring, a chain, a panel edge or a first C2C tile)`, where));
    } else if (i > 0 && startsPiece && line.start?.k !== 'edge') {
      issues.push(makeIssue('E_START', `${nameOf(line)}: starts a new piece in the middle of this one`, where));
    }
  }
  return issues;
}
