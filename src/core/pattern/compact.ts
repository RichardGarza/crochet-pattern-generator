// The compact renderer: one `Line` → one line of text in the Compact dialect (DESIGN.md §2.7.2, §2.7.3,
// §2.7.5, §2.7.6, §2.10.6, §2.10.11, §2.11.3; research 07 §7.5). Step 0 kernel: pure, no DOM.
//
//   Rnd 3: (sc, inc) x 6 (18)
//   Rnds 7–12 (6 rnds): sc in each st around (36)
//   Rnd 15: BLO (2 sc, sc2tog) x 6 (18)
//   Row 11 (RS) ←: Ch 1, turn. 4 sc A, 3 sc B, 33 sc A (40 sts) · carry B
//   ↗ Row 4 (WS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)
//
// A line is `label: body count`, and every part is exported so the verbose and UK renderers (T2) can reuse
// what they share. The text is built from the `Line` alone: its ops go through `lineItems` (the encoder), its
// count is `Line.stated`. Two things depend on the kind of pattern rather than on the line
// (`CompactOptions.docKind`): a chart pattern ('2d') prints `(40 sts)`, cuts its lines into run tokens and
// writes joined rounds as `Ch 1, {runs}; join …`; an amigurumi pattern ('3d') prints `(18)`, uses one token per
// op and writes joined rounds with the template of §2.11.3. By default rounds are '3d' and rows, C2C rows and
// borders '2d'.
//
// The renderer expects a line that `validateLine` accepts; it does not check one.
import type { Line, Op, PatternDoc } from '../../types';
import { type EncodeMode, encodeOps } from './encode';
import { type CompactNames, type Item, type TokenTextOptions, US_COMPACT_NAMES, displayOps, runText, tokenText } from './ops';

export interface CompactOptions {
  /** See the file header. Default: '3d' for `kind: 'rnd'`, '2d' for rows, C2C rows and borders. */
  docKind?: PatternDoc['kind'];
  /** Stitch names that replace the US compact ones (the UK table of T2). A name left out keeps the US word. */
  names?: Partial<CompactNames>;
}

function docKindOf(line: Pick<Line, 'kind'>, o: CompactOptions): PatternDoc['kind'] {
  return o.docKind ?? (line.kind === 'rnd' ? '3d' : '2d');
}

function namesOf(o: CompactOptions): Readonly<CompactNames> {
  if (o.names === undefined) return US_COMPACT_NAMES;
  const names: CompactNames = { ...US_COMPACT_NAMES };
  for (const key of Object.keys(US_COMPACT_NAMES) as (keyof CompactNames)[]) {
    const word = o.names[key];
    if (typeof word === 'string') names[key] = word;
  }
  return names;
}

/** The token mode a line is encoded with: per run in a '2d' pattern, per op in a '3d' one (§2.6.1). */
export function compactEncodeMode(line: Pick<Line, 'kind'>, o: CompactOptions = {}): EncodeMode {
  return docKindOf(line, o) === '3d' ? 'ops' : 'runs';
}

/**
 * The encoded form of a line, as every renderer prints it: its ops as displayed (`displayOps`: the default loop
 * and the header's color are left out, so ops that print alike fold together), its segments, and the token mode
 * of its pattern kind. The verbose renderers start from the same items, so all dialects show the same repeats.
 */
export function lineItems(line: Pick<Line, 'kind' | 'ops' | 'segments' | 'colorHeader'>, o: CompactOptions = {}): readonly Item[] {
  return encodeOps(displayOps(line), { mode: compactEncodeMode(line, o), segments: line.segments });
}

/**
 * Encoded items as compact text: runs and repeats joined with `, `. This is the plain list, without the
 * whole-line phrases (`sc in each st around`) that `compactBody` applies.
 */
export function compactItems(items: readonly Item[], o: TokenTextOptions = {}): string {
  const parts: string[] = [];
  for (const item of items) {
    parts.push(item.kind === 'run' ? runText(item.op, item.n, o) : `(${compactItems(item.inner, o)}) x ${item.times}`);
  }
  return parts.join(', ');
}

/**
 * Everything before the colon: `Rnd 3`, `Rnd 9 (B)`, `Rnds 7–12 (6 rnds)`, `Row 11 (RS) ←`,
 * `↗ Row 4 (WS) [inc beg · dec end]`. Tags in the parentheses come in the order color, side, fold size.
 */
export function compactLabel(line: Line): string {
  const folded = line.nEnd !== undefined && line.nEnd > line.n;
  const round = line.kind === 'rnd' || line.kind === 'border';
  const word = round ? 'Rnd' : 'Row';
  let label = folded ? `${word}s ${line.n}–${line.nEnd}` : `${word} ${line.n}`;
  const tags: string[] = [];
  if (line.colorHeader !== undefined) tags.push(line.colorHeader);
  if (line.side !== undefined) tags.push(line.side);
  if (line.nEnd !== undefined && folded) tags.push(`${line.nEnd - line.n + 1} ${round ? 'rnds' : 'rows'}`);
  if (tags.length > 0) label += ` (${tags.join(', ')})`;
  if (line.kind === 'c2c') {
    const start = line.start;
    if (start !== undefined && start.k === 'c2c') {
      label += start.start === 'first' ? ' [first tile]' : ` [${start.start} beg · ${start.end} end]`;
    }
    return line.arrow === undefined ? label : `${line.arrow} ${label}`;
  }
  return line.arrow === undefined ? label : `${label} ${line.arrow}`;
}

/** `(18)` in an amigurumi pattern, `(40 sts)` in a chart pattern, `(3 tiles)` for a C2C row. Prints `Line.stated`. */
export function compactCount(line: Line, o: CompactOptions = {}): string {
  const n = line.stated;
  if (line.kind === 'c2c') return `(${n} ${n === 1 ? 'tile' : 'tiles'})`;
  if (docKindOf(line, o) === '3d') return `(${n})`;
  return `(${n} ${n === 1 ? 'st' : 'sts'})`;
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

function loopOf(op: Op): 'BLO' | 'FLO' | undefined {
  return op.k !== 'tile' && (op.loop === 'BLO' || op.loop === 'FLO') ? op.loop : undefined;
}

/**
 * The loop every op of a line is worked in, when they all share BLO or FLO (and none is a mosaic long stitch,
 * `into: 'flo2below'`): the compact line then prints it once, as a prefix (`BLO (2 sc, sc2tog) x 6`, §2.10.5).
 * Undefined for an empty list or mixed loops.
 */
export function sharedLoop(ops: readonly Op[]): 'BLO' | 'FLO' | undefined {
  let shared: 'BLO' | 'FLO' | undefined;
  for (const op of ops) {
    const loop = loopOf(op);
    if (loop === undefined || (op.k === 'st' && op.into !== undefined)) return undefined;
    if (shared !== undefined && shared !== loop) return undefined;
    shared = loop;
  }
  return shared;
}

/** The stitch a round is joined into: the first op's (`inc` and `dec` are made of sc). */
function firstStitchName(ops: readonly Op[], names: Readonly<CompactNames>): string {
  const first = ops.length > 0 ? ops[0] : undefined;
  if (first === undefined || first.k !== 'st') return names.sc;
  return first.st === 'hdc' ? names.hdc : first.st === 'dc' ? names.dc : names.sc;
}

/**
 * The ops of a line as text. A line that is one run of one op with no color tag to print reads as a phrase
 * (§2.6.1 post-rules): `sc in each st around`, `inc in each st around`, `dec around`, `sc in each st across`.
 */
function opsText(items: readonly Item[], text: TokenTextOptions, phrase: { where: 'around' | 'across'; into: 'st' | 'ch' } | null): string {
  if (phrase !== null && items.length === 1) {
    const only = items[0];
    if (only.kind === 'run' && only.op.k !== 'tile' && only.op.color === undefined) {
      const token = tokenText(only.op, text);
      return only.op.k === 'dec' ? `${token} ${phrase.where}` : `${token} in each ${phrase.into} ${phrase.where}`;
    }
  }
  return compactItems(items, text);
}

/**
 * The canonical first round of a chain oval (§2.10.6): `(S + 1) sc, inc3, S sc, inc`, through both loops and
 * with no color tag to print. Returns S (= chains − 3, the stitches along each side), or null when the ops are
 * anything else; such a round prints as a plain list. Pass the ops as printed (`displayOps`), so that the
 * header's color and `loop: 'both'` do not hide the pattern.
 */
export function chainOvalSide(shown: readonly Op[]): number | null {
  const bare = (op: Op): boolean => loopOf(op) === undefined && op.color === undefined;
  const plain = (op: Op): boolean => op.k === 'st' && op.st === 'sc' && op.into === undefined && bare(op);
  let i = 0;
  while (i < shown.length && plain(shown[i])) i++;
  const side = i - 1;
  if (side < 0 || shown.length !== 2 * side + 3) return null;
  const turn = shown[i];
  const last = shown[shown.length - 1];
  if (turn.k !== 'inc' || turn.n !== 3 || !bare(turn) || last.k !== 'inc' || last.n !== 2 || !bare(last)) return null;
  for (let x = i + 1; x < shown.length - 1; x++) if (!plain(shown[x])) return null;
  return side;
}

/**
 * Everything between the colon and the count: how the line starts, its ops, and how it ends.
 *
 * | `Line.start`            | text                                                                         |
 * |-------------------------|------------------------------------------------------------------------------|
 * | none (spiral round)     | `(sc, inc) x 6`                                                              |
 * | `mr`                    | `6 sc in MR`                                                                 |
 * | `foundation`            | `Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A`                         |
 * | `turn`                  | `Ch 1, turn. 4 sc A, sc B` · `Ch 2 (does not count as a st), turn. …`        |
 * | `chainOval`             | `sc in 2nd ch from hook, sc in next 7 ch, 3 sc in last ch; working along the other side of the chain, sc in next 7 ch, 2 sc in last ch` |
 * | `chainRing`             | '2d': `Ch 1 (does not count as a st), {runs}`; '3d': the ops (`Ch 1 (does not count), ` first when joined) |
 * | `join`                  | '2d': `Ch 1, {runs}`; '3d': `Ch 1 (does not count), sc in same st as join, {rest}` |
 * | `edge`, `c2c`           | the ops (T2 writes the border sentences itself, §2.7.10)                     |
 *
 * `Line.join` adds `; join with sl st in first sc[, changing to B].`; a '3d' line that starts with `join` but
 * has no `Line.join` ends `; do not join — continue in a spiral.` (§2.11.3).
 */
export function compactBody(line: Line, o: CompactOptions = {}): string {
  const docKind = docKindOf(line, o);
  const names = namesOf(o);
  const shown = displayOps(line);
  const loop = sharedLoop(shown);
  const text: TokenTextOptions = { names, hideLoop: loop !== undefined };
  const loopPrefix = loop === undefined ? '' : `${loop} `;
  const mode = compactEncodeMode(line, o);
  const where = line.kind === 'row' ? 'across' : 'around';
  const start = line.start;
  /** The items of the shown ops from index `from` on, with the line's segments moved along. */
  const encode = (from: number): readonly Item[] => {
    if (from === 0) return encodeOps(shown, { mode, segments: line.segments });
    return encodeOps(shown.slice(from), { mode, segments: line.segments?.map((segment) => ({ at: segment.at - from })) });
  };

  let head = '';
  let body: string;
  switch (start?.k) {
    case 'mr': {
      const items = encode(0);
      const only = items.length === 1 ? items[0] : undefined;
      body = only !== undefined && only.kind === 'run' ? `${only.n} ${tokenText(only.op, text)}` : compactItems(items, text);
      body = `${loopPrefix}${body} in MR`;
      break;
    }
    case 'foundation':
      head = `Starting in ${ordinal(start.firstInto)} ch from hook, `;
      body = loopPrefix + opsText(encode(0), text, { where, into: 'ch' });
      break;
    case 'turn':
      head = start.chains === 1 ? 'Ch 1, turn. ' : `Ch ${start.chains} (does not count as a st), turn. `;
      body = loopPrefix + opsText(encode(0), text, { where, into: 'st' });
      break;
    case 'chainOval': {
      const side = chainOvalSide(shown);
      if (side === null) {
        body = loopPrefix + opsText(encode(0), text, { where, into: 'ch' });
      } else {
        const along = side === 0 ? '' : side === 1 ? `${names.sc} in next ch, ` : `${names.sc} in next ${side} ch, `;
        body =
          `${names.sc} in 2nd ch from hook, ${along}3 ${names.sc} in last ch; ` +
          `working along the other side of the chain, ${along}2 ${names.sc} in last ch`;
      }
      break;
    }
    case 'chainRing':
      if (docKind === '2d') head = 'Ch 1 (does not count as a st), ';
      else if (line.join !== undefined) head = 'Ch 1 (does not count), ';
      body = loopPrefix + opsText(encode(0), text, { where, into: 'ch' });
      break;
    case 'join':
      if (docKind === '2d' || shown.length === 0) {
        head = 'Ch 1, ';
        body = loopPrefix + opsText(encode(0), text, { where, into: 'st' });
      } else {
        // §2.11.3: the first stitch of a joined round goes in the same stitch as the join.
        head = 'Ch 1 (does not count), ';
        body = `${loopPrefix}${tokenText(shown[0], text)} in same st as join`;
        if (shown.length > 1) body += `, ${compactItems(encode(1), text)}`;
      }
      break;
    default:
      body = loopPrefix + opsText(encode(0), text, line.kind === 'c2c' ? null : { where, into: 'st' });
  }

  let tail = '';
  if (line.join !== undefined) {
    const change = line.join.changeTo === undefined ? '' : `, changing to ${line.join.changeTo}`;
    tail = `; join with ${names.slst} in first ${firstStitchName(shown, names)}${change}.`;
  } else if (start !== undefined && start.k === 'join' && docKind === '3d') {
    tail = '; do not join — continue in a spiral.';
  }
  return head + body + tail;
}

/**
 * The sentence that comes before a line worked into chains, or null when the line has no such start:
 * '2d' `Foundation: With A, ch 6.` (the color of the first run of row 1, §2.7.2) and, for rounds,
 * `Foundation: With A, ch 40; join with sl st in first ch to form a ring (do not twist).`;
 * '3d' `Ch 10.` (chain oval, §2.10.6). It is a separate string: print it on its own line or in front of the
 * line (`Ch 10. Rnd 1: …`).
 */
export function compactFoundation(line: Line, o: CompactOptions = {}): string | null {
  const start = line.start;
  if (start === undefined || (start.k !== 'foundation' && start.k !== 'chainOval' && start.k !== 'chainRing')) return null;
  const names = namesOf(o);
  const first = line.ops.length > 0 ? line.ops[0] : undefined;
  const color = first?.color ?? line.colorHeader;
  const ring = start.k === 'chainRing' ? `; join with ${names.slst} in first ch to form a ring (do not twist)` : '';
  const chain = color === undefined ? `Ch ${start.chains}` : `With ${color}, ch ${start.chains}`;
  return `${docKindOf(line, o) === '2d' ? 'Foundation: ' : ''}${chain}${ring}.`;
}

/**
 * One line of the Compact dialect: `label: body count`, then the line's color cues (`· carry B`,
 * `· join B (bobbin 2)`) in their order. Cues of other kinds (eyes, stuffing, notes) and `Line.notes` are whole
 * sentences that the caller prints on their own lines after this one (§2.10.6).
 */
export function renderCompactLine(line: Line, o: CompactOptions = {}): string {
  let out = `${compactLabel(line)}: ${compactBody(line, o)} ${compactCount(line, o)}`;
  for (const cue of line.cues ?? []) if (cue.kind === 'color') out += ` · ${cue.text}`;
  return out;
}
