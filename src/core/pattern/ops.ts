// The stitch vocabulary of the pattern language (DESIGN.md §2.13, §2.6.1; research 07 §7.2). Step 0 kernel:
// pure, no DOM. US crochet terms; UK is a rendering concern (T2).
//
// A `Line` is a list of `Op`s plus a `LineStart`. Only the ops are stitches:
//
//   | What                                             | consumes        | produces |
//   |--------------------------------------------------|-----------------|----------|
//   | sc, hdc, dc, sl st (any loop, any color)         | 1               | 1        |
//   | inc (2 sc in one st) / inc3 (3 sc in one st)     | 1               | 2 / 3    |
//   | dec (invdec or sc2tog) / dec3 (sc3tog)           | 2 / 3           | 1        |
//   | C2C tile                                         | 1 ch-3 sp       | 1 tile   |
//   | BLO / FLO, `into: 'flo2below'`, a color change   | change nothing: they are fields of an op   |
//   | turning chain, ch 1 and sl st of a joined round, | 0               | 0        |
//   |   the magic ring's ch 1, the foundation chain    | (they are a `LineStart` or `Line.join`,    |
//   |                                                  |  never an op: §2.11.3)                     |
//
// A magic-ring round is written `start: { k: 'mr', n }` with its n stitches as ops, so `Rnd 1: 6 sc in MR (6)`
// has six `sc` ops: Σ produced(ops) is the stated count on every line, with no special case. The first line of a
// piece has nothing before it, so E_CONSUME does not apply to it (START_EXEMPT); `startCapacity` says how many
// places its start offers instead (ring, chain loops).
import type { Line, LineStart, Op } from '../../types';

/** One name per distinct stitch operation: the key of CONS and PROD. */
export type OpName = 'sc' | 'hdc' | 'dc' | 'slst' | 'inc' | 'inc3' | 'dec' | 'dec3' | 'tile';

export const OP_NAMES: readonly OpName[] = Object.freeze(['sc', 'hdc', 'dc', 'slst', 'inc', 'inc3', 'dec', 'dec3', 'tile']);

/** Stitches of the previous row or round that one op is worked into (research 03 §6.0, 07 §7.2). */
export const CONS: Readonly<Record<OpName, number>> = Object.freeze({
  sc: 1,
  hdc: 1,
  dc: 1,
  slst: 1,
  inc: 1,
  inc3: 1,
  dec: 2,
  dec3: 3,
  tile: 1,
});

/** Stitches one op adds to the row or round being worked. */
export const PROD: Readonly<Record<OpName, number>> = Object.freeze({
  sc: 1,
  hdc: 1,
  dc: 1,
  slst: 1,
  inc: 2,
  inc3: 3,
  dec: 1,
  dec3: 1,
  tile: 1,
});

const STITCHES: ReadonlySet<string> = new Set(['sc', 'hdc', 'dc', 'slst']);
const LOOPS: ReadonlySet<string> = new Set(['both', 'BLO', 'FLO']);

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** True when `value` is a well-formed `Op` of the frozen type (every field present and in range). */
export function isOp(value: unknown): value is Op {
  if (typeof value !== 'object' || value === null) return false;
  const op = value as { k?: unknown; st?: unknown; n?: unknown; loop?: unknown; color?: unknown; into?: unknown };
  const loopOk = op.loop === undefined || (typeof op.loop === 'string' && LOOPS.has(op.loop));
  switch (op.k) {
    case 'st':
      return (
        typeof op.st === 'string' &&
        STITCHES.has(op.st) &&
        loopOk &&
        isOptionalString(op.color) &&
        (op.into === undefined || op.into === 'flo2below')
      );
    case 'inc':
    case 'dec':
      return (op.n === 2 || op.n === 3) && loopOk && isOptionalString(op.color);
    case 'tile':
      return typeof op.color === 'string';
    default:
      return false;
  }
}

/** The CONS / PROD key of an op. Loops and colors never change it. Throws on a malformed op. */
export function opName(op: Op): OpName {
  switch (op.k) {
    case 'st':
      if (STITCHES.has(op.st)) return op.st;
      break;
    case 'inc':
      if (op.n === 2) return 'inc';
      if (op.n === 3) return 'inc3';
      break;
    case 'dec':
      if (op.n === 2) return 'dec';
      if (op.n === 3) return 'dec3';
      break;
    case 'tile':
      return 'tile';
    default:
      break;
  }
  throw new TypeError(`opName: not a stitch op: ${show(op)}`);
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Σ consumed over a list of ops: the stitches of the previous row or round they are worked into. */
export function consumed(ops: readonly Op[]): number {
  let total = 0;
  for (const op of ops) total += CONS[opName(op)];
  return total;
}

/** Σ produced over a list of ops: the stitch count they leave behind (the number printed in parentheses). */
export function produced(ops: readonly Op[]): number {
  let total = 0;
  for (const op of ops) total += PROD[opName(op)];
  return total;
}

// ---- Encoded form (§2.6.1)

/**
 * One element of an encoded line (§2.6.1): `n` copies of one op (`4 sc`), or a bracketed group worked `times`
 * times (`(sc, inc) x 6`). The encoder returns these frozen, with at most one bracket level.
 */
export type Item =
  | { readonly kind: 'run'; readonly op: Op; readonly n: number }
  | { readonly kind: 'rep'; readonly inner: readonly Item[]; readonly times: number };

function checkCount(value: number, what: string): void {
  if (!Number.isInteger(value) || value < 0) throw new RangeError(`${what} must be a non-negative integer, got ${value}`);
}

function pushExpanded(items: readonly Item[], out: Op[]): void {
  for (const item of items) {
    if (item.kind === 'run') {
      checkCount(item.n, 'expand: run count');
      for (let i = 0; i < item.n; i++) out.push({ ...item.op });
    } else {
      checkCount(item.times, 'expand: repeat count');
      for (let t = 0; t < item.times; t++) pushExpanded(item.inner, out);
    }
  }
}

/**
 * The inverse of `encodeOps`: writes every repeat and run out as single ops. Each op of the result is a fresh
 * object, so the caller may change it. `expand(encodeOps(ops))` deep-equals `ops` for every input (R10).
 */
export function expand(items: readonly Item[]): Op[] {
  const out: Op[] = [];
  pushExpanded(items, out);
  return out;
}

function sumItems(items: readonly Item[], table: Readonly<Record<OpName, number>> | null): number {
  let total = 0;
  for (const item of items) {
    if (item.kind === 'run') total += item.n * (table === null ? 1 : table[opName(item.op)]);
    else total += item.times * sumItems(item.inner, table);
  }
  return total;
}

/** Σ consumed of an encoded line, without expanding it. */
export function itemsConsumed(items: readonly Item[]): number {
  return sumItems(items, CONS);
}

/** Σ produced of an encoded line, without expanding it: the count its printed text adds up to. */
export function itemsProduced(items: readonly Item[]): number {
  return sumItems(items, PROD);
}

/** The number of ops an encoded line expands to. */
export function itemsOpCount(items: readonly Item[]): number {
  return sumItems(items, null);
}

// ---- Line starts (§2.13: "MR, foundation, chain-oval, chain-ring and border `edge` lines exempt")

export type StartKind = LineStart['k'];

/**
 * True for the starts whose line is the first of its piece: there is no previous count, so E_CONSUME does not
 * apply. (A C2C row tagged `first` is exempt too: see `isConsumeExempt`.)
 */
export const START_EXEMPT: Readonly<Record<StartKind, boolean>> = Object.freeze({
  mr: true,
  foundation: true,
  chainOval: true,
  chainRing: true,
  edge: true,
  turn: false,
  join: false,
  c2c: false,
});

/** True when E_CONSUME does not apply to the line: it starts a piece (magic ring, chains, panel edge, first tile). */
export function isConsumeExempt(line: Pick<Line, 'start'>): boolean {
  const start = line.start;
  if (start === undefined) return false;
  if (start.k === 'c2c') return start.start === 'first';
  return START_EXEMPT[start.k] === true;
}

/**
 * How many places a first-line start offers its ops, i.e. what Σ consumed(ops) should be on that line:
 * magic ring `n` (its n stitches); foundation `chains − firstInto + 1` (sc on `ch W+1` from the 2nd ch: W);
 * chain oval `2·chains − 3` loops (research 07 §6.9: ch 10 → 17 loops → 20 sts); chain ring `chains`.
 * `null` when the start has no such number: the panel edge of a border, and the starts of lines that follow
 * another line (turn, join, C2C). The kernel does not enforce it (the lines are E_CONSUME-exempt); T2's
 * E_FOUNDATION and T4's E_START use it.
 */
export function startCapacity(start: LineStart | undefined): number | null {
  if (start === undefined) return null;
  switch (start.k) {
    case 'mr':
      return start.n;
    case 'foundation':
      return start.chains - start.firstInto + 1;
    case 'chainOval':
      return 2 * start.chains - 3;
    case 'chainRing':
      return start.chains;
    default:
      return null;
  }
}

/**
 * Σ consumed of a whole line. For every kind but C2C it is `consumed(line.ops)`. A C2C row is worked into the
 * ch-3 spaces of the previous row (research 07 §4.3, §7.2): every tile uses one, except the ch-6 increase tile
 * at the beginning, which uses none; a decrease at the end slip-stitches into one more space without making a
 * tile. So it is `tiles − [inc beg] + [dec end]`, which equals the previous row's tile count on every valid row.
 */
export function lineConsumed(line: Pick<Line, 'ops' | 'start'>): number {
  let total = consumed(line.ops);
  const start = line.start;
  if (start !== undefined && start.k === 'c2c') {
    if (start.start === 'inc') total -= 1;
    if (start.end === 'dec') total += 1;
  }
  return total;
}

/** Σ produced of a whole line: what `Line.stated` must equal (E_PRODUCE). */
export function lineProduced(line: Pick<Line, 'ops'>): number {
  return produced(line.ops);
}

// ---- Compact names of the ops (§2.10.11, research 07 §7.5). The encoder measures candidate encodings with
//      these, and the compact renderer prints them.

/** The words of the compact dialect. T2 passes its UK table (sc → dc, hdc → htr, dc → tr, sl st → ss, …). */
export interface CompactNames {
  sc: string;
  hdc: string;
  dc: string;
  slst: string;
  inc: string;
  inc3: string;
  dec: string;
  dec3: string;
  /** A decrease worked through the stated loops only: in a BLO/FLO round `dec` is always written out (§2.10.5). */
  sc2tog: string;
  sc3tog: string;
}

export const US_COMPACT_NAMES: Readonly<CompactNames> = Object.freeze({
  sc: 'sc',
  hdc: 'hdc',
  dc: 'dc',
  slst: 'sl st',
  inc: 'inc',
  inc3: 'inc3',
  dec: 'dec',
  dec3: 'dec3',
  sc2tog: 'sc2tog',
  sc3tog: 'sc3tog',
});

export interface TokenTextOptions {
  names?: Readonly<CompactNames>;
  /** Leave out ` BLO` / ` FLO`: the whole line carries the loop as a prefix (`BLO (2 sc, sc2tog) x 6`). */
  hideLoop?: boolean;
  /** Leave out the color tag of ops in this color: the line carries it in its header (`Rnd 9 (B): …`). */
  hideColor?: string;
}

function loopOf(op: Op): 'BLO' | 'FLO' | undefined {
  if (op.k === 'tile') return undefined;
  return op.loop === 'BLO' || op.loop === 'FLO' ? op.loop : undefined;
}

/**
 * The compact name of one op without its count: `sc`, `sl st`, `inc`, `sc A`, `sc BLO`, `sc2tog BLO`,
 * `dc FLO 2 rows below`, and for a C2C tile its color (`A`). Order: stitch, loop, color.
 */
export function tokenText(op: Op, o: TokenTextOptions = {}): string {
  const names = o.names ?? US_COMPACT_NAMES;
  if (op.k === 'tile') return String(op.color);
  const loop = loopOf(op);
  let text: string;
  switch (op.k) {
    case 'st':
      text = names[op.st] ?? '?';
      break;
    case 'inc':
      text = op.n === 3 ? names.inc3 : names.inc;
      break;
    case 'dec':
      // In a BLO/FLO round a decrease is an sc2tog through the stated loops, never an invisible decrease.
      if (loop !== undefined) text = op.n === 3 ? names.sc3tog : names.sc2tog;
      else text = op.n === 3 ? names.dec3 : names.dec;
      break;
    default:
      text = '?';
  }
  if (op.k === 'st' && op.into === 'flo2below') text += ' FLO 2 rows below';
  else if (loop !== undefined && o.hideLoop !== true) text += ` ${loop}`;
  if (op.color !== undefined && op.color !== o.hideColor) text += ` ${op.color}`;
  return text;
}

/**
 * `n` copies of one op in the compact dialect: `sc`, `4 sc`, `3 sc B`, `2 inc`. `N op` = op worked into each of
 * the next N sts (§2.10.11); a single op prints without a number, except C2C tiles, which always print their
 * count (`1 A`, §2.7.6).
 */
export function runText(op: Op, n: number, o: TokenTextOptions = {}): string {
  const text = tokenText(op, o);
  return n === 1 && op.k !== 'tile' ? text : `${n} ${text}`;
}
