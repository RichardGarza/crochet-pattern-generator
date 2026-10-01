// Track T2 — renders one Line as text: compact or verbose, US or UK (DESIGN.md §2.7.2, §2.10.11, §2.11.3;
// research 07 §7.5; §5.2.1). T4's 3D pattern text goes through the same renderer.
//
//   Compact US  Row 11 (RS) ←: Ch 1, turn. 4 sc A, 3 sc B, 33 sc A (40 sts) · carry A
//   Compact UK  Row 11 (RS) ←: Ch 1, turn. 4 dc A, 3 dc B, 33 dc A (40 sts) · carry A
//   Verbose US  Row 11 (RS) ←: Ch 1, turn. With A, sc in first 4 sts; change to B, sc in next 3 sts; change to A,
//               sc in last 33 sts. (40 sc) · carry A
//   Verbose 3D  Rnd 3: [Sc in next st, 2 sc in next st] 6 times. (18 sts)
//
// The compact dialect is the Step 0 kernel (`compact.ts`) with the UK stitch names of `terminology.ts`. The
// verbose dialect starts from the same encoded items (`lineItems`), so both dialects show the same repeats.
// Free text that is not built from the model (cue and note sentences) goes through the one-pass converter
// `toTerms`.
//
// Hand. The lines of a pattern are written for one hand by its writer (`PatternDoc.hand`): a left-handed chart
// pattern differs from the right-handed one in more than the order of each row (the foundation colour, which
// corner a border starts in, C2C bobbins, the pre-skew of tapestry rounds), so it is generated, not mirrored
// here. `renderLine` prints a line as it is written; `o.hand` is part of the frozen signature and changes
// nothing in the text.
//
// 2D or 3D. A round can be a tapestry round of a chart (`(40 sts)`, run tokens, `Ch 1, {runs}; join …`) or an
// amigurumi round (`(18)`, op tokens, the joined-round template of §2.11.3), and the frozen options do not say
// which (request in docs/tracks/t2.md). `inferDocKind` decides: a round that carries a side or an arrow is a
// chart round (chart writers always set them on rounds); any other round is an amigurumi round; rows, C2C rows
// and border rounds are chart lines. T2's own code passes `docKind` explicitly through `renderLineWith`.
import type { Hand, Line, Op, PatternDoc, RenderLineFn, Terms } from '../../types';
import { chainOvalSide, compactFoundation, compactLabel, isJoinedHead, lineItems, renderCompactLine, sharedLoop } from './compact';
import { type Item, displayOps } from './ops';
import { compactNames, toTerms } from './terminology';
import { type BorderTextContext, borderHeader, renderBorderLine } from '../techniques/border';

export type DocKind = PatternDoc['kind'];
export type Dialect = 'compact' | 'verbose';
export type DecMethod = 'invdec' | 'sc2tog';

/** The options of `renderLine`, plus the kind of pattern the line belongs to. */
export interface RenderOptions {
  dialect: Dialect;
  terms: Terms;
  hand: Hand;
  /** How the verbose dialect writes `dec` (default `invdec`); the compact dialect always prints `dec`. */
  decMethod?: DecMethod;
  /** Default: `inferDocKind(line)`. */
  docKind?: DocKind;
  /**
   * Border lines (§2.7.10): what only the pattern knows — the technique (C2C tile edges) and the panel's size
   * (the spacing hints). Without it a border prints with row words and no hints.
   */
  border?: Omit<BorderTextContext, 'terms' | 'hand'>;
}

/**
 * The kind of pattern a line is printed in, when nobody says: a round with a side or an arrow is a chart
 * (tapestry) round, any other round an amigurumi round; rows, C2C rows and borders are chart lines.
 */
export function inferDocKind(line: Pick<Line, 'kind' | 'side' | 'arrow'>): DocKind {
  if (line.kind !== 'rnd') return '2d';
  return line.side !== undefined || line.arrow !== undefined ? '2d' : '3d';
}

function docKindOf(line: Line, o: { docKind?: DocKind }): DocKind {
  return o.docKind === '2d' || o.docKind === '3d' ? o.docKind : inferDocKind(line);
}

// ---- Verbose words

interface VerboseNames {
  sc: string;
  hdc: string;
  dc: string;
  slst: string;
  sc2tog: string;
  sc3tog: string;
  invdec: string;
  dec3: string;
}

const US_VERBOSE: Readonly<VerboseNames> = Object.freeze({
  sc: 'sc',
  hdc: 'hdc',
  dc: 'dc',
  slst: 'sl st',
  sc2tog: 'sc2tog',
  sc3tog: 'sc3tog',
  invdec: 'invdec',
  dec3: 'dec3',
});

const UK_VERBOSE: Readonly<VerboseNames> = Object.freeze({
  sc: 'dc',
  hdc: 'htr',
  dc: 'tr',
  slst: 'ss',
  sc2tog: 'dc2tog',
  sc3tog: 'dc3tog',
  invdec: 'invdec',
  dec3: 'dec3',
});

function verboseNames(terms: Terms): Readonly<VerboseNames> {
  return terms === 'uk' ? UK_VERBOSE : US_VERBOSE;
}

type Place = 'first' | 'next' | 'last';

interface Ctx {
  names: Readonly<VerboseNames>;
  docKind: DocKind;
  decMethod: DecMethod;
  /** The line prints its shared loop once, as a prefix. */
  hideLoop: boolean;
  /** What the stitches are worked into. */
  into: 'st' | 'ch';
  /** Work every run into the magic ring. */
  inRing: boolean;
  header: string | undefined;
}

function loopOf(op: Op): 'BLO' | 'FLO' | undefined {
  if (op.k === 'tile' || (op.k === 'st' && op.into !== undefined)) return undefined;
  return op.loop === 'BLO' || op.loop === 'FLO' ? op.loop : undefined;
}

function loopWords(loop: 'BLO' | 'FLO'): string {
  return loop === 'BLO' ? 'back loop only' : 'front loop only';
}

function stitchWord(st: 'sc' | 'hdc' | 'dc' | 'slst', names: Readonly<VerboseNames>): string {
  return names[st];
}

function decWord(op: Extract<Op, { k: 'dec' }>, ctx: Ctx): string {
  const throughLoop = ctx.hideLoop || loopOf(op) !== undefined;
  if (throughLoop || ctx.decMethod === 'sc2tog') return op.n === 3 ? ctx.names.sc3tog : ctx.names.sc2tog;
  return op.n === 3 ? ctx.names.dec3 : ctx.names.invdec;
}

/** `next st`, `first 4 sts`, `last 3 ch`. */
function placeWords(place: Place, n: number, into: 'st' | 'ch'): string {
  if (into === 'ch') return n === 1 ? `${place} ch` : `${place} ${n} ch`;
  return n === 1 ? `${place} st` : `${place} ${n} sts`;
}

/** One run of `n` copies of `op` in the verbose dialect, without its colour. */
function runPhrase(op: Op, n: number, place: Place, ctx: Ctx): string {
  if (op.k === 'tile') return n === 1 ? 'tile' : `${n} tiles`;
  const loop = ctx.hideLoop ? undefined : loopOf(op);
  const loopPart = loop === undefined ? '' : `${loopWords(loop)} of `;
  if (ctx.inRing) {
    const word = op.k === 'st' ? stitchWord(op.st, ctx.names) : op.k === 'inc' ? `${op.n} ${ctx.names.sc}` : decWord(op, ctx);
    return n === 1 ? `${word} in MR` : `${n} ${word} in MR`;
  }
  switch (op.k) {
    case 'st': {
      const word = stitchWord(op.st, ctx.names);
      if (op.into === 'flo2below') {
        return n === 1 ? `${word} in front loop of ${place} st 2 rows below` : `${word} in front loop of each of ${place} ${n} sts 2 rows below`;
      }
      return `${word} in ${loopPart}${placeWords(place, n, ctx.into)}`;
    }
    case 'inc': {
      const word = `${op.n} ${ctx.names.sc}`;
      return n === 1 ? `${word} in ${loopPart}${placeWords(place, 1, ctx.into)}` : `${word} in ${loopPart}each of ${placeWords(place, n, ctx.into)}`;
    }
    case 'dec': {
      const word = decWord(op, ctx);
      const where = loop === undefined ? '' : ` in ${loop === 'BLO' ? 'back' : 'front'} loops only`;
      return n === 1 ? `${word}${where}` : `${word}${where} ${n} times`;
    }
    default:
      return '?';
  }
}

interface Piece {
  text: string;
  /** The piece starts with a colour (`with A, …`, `change to B, …`): it is joined to the one before with `; `. */
  change: boolean;
}

function colorOf(op: Op): string | undefined {
  return op.color;
}

/**
 * Items as verbose pieces. `top` marks the top level of a line, where colour changes read `change to B` after
 * the first one and the outer runs take `first` / `last` (2D); inside brackets every colour reads `with B`.
 */
function itemPieces(items: readonly Item[], ctx: Ctx, top: boolean, state: { color: string | undefined; started: boolean }): Piece[] {
  const out: Piece[] = [];
  const twoD = ctx.docKind === '2d' && top;
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'rep') {
      // Every iteration but the first starts in the colour the group ends in; when that is not the colour before
      // the group, the group's first run names its colour (`[with A, …; with B, …] 6 times`).
      const end = lastColor(item.inner, ctx.header);
      const inner = { color: end === state.color ? state.color : NO_COLOR, started: false };
      const pieces = itemPieces(item.inner, ctx, false, inner);
      const text = `[${joinPieces(pieces)}] ${item.times} times`;
      out.push({ text, change: pieces.length > 0 && pieces[0].change });
      if (inner.color !== undefined && inner.color !== NO_COLOR) state.color = inner.color;
      state.started = true;
      continue;
    }
    const place: Place = !twoD || items.length === 1 ? 'next' : i === 0 ? 'first' : i === items.length - 1 ? 'last' : 'next';
    const own = colorOf(item.op) ?? ctx.header;
    let prefix = '';
    if (own !== undefined && own !== state.color) {
      if (!top || !state.started || state.color === undefined) prefix = `with ${own}, `;
      else prefix = `change to ${own}, `;
      state.color = own;
    }
    out.push({ text: prefix + runPhrase(item.op, item.n, place, ctx), change: prefix !== '' });
    state.started = true;
  }
  return out;
}

/** A colour no run has: forces the next coloured run to name its colour. */
const NO_COLOR = '\u0000';

/** The colour the items end in (a run's own colour, else the header), or undefined. */
function lastColor(items: readonly Item[], header: string | undefined): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const color = item.kind === 'run' ? (item.op.color ?? header) : lastColor(item.inner, header);
    if (color !== undefined) return color;
  }
  return undefined;
}

function joinPieces(pieces: readonly Piece[]): string {
  let text = '';
  for (let i = 0; i < pieces.length; i++) {
    if (i > 0) text += pieces[i].change ? '; ' : ', ';
    text += pieces[i].text;
  }
  return text;
}

/** Upper-cases the first letter of a sentence (after an opening bracket: `[Sc in next st, …`). */
function capitalize(text: string): string {
  const i = text.startsWith('[') ? 1 : 0;
  const ch = text.charAt(i);
  if (!/[a-z]/.test(ch)) return text;
  return text.slice(0, i) + ch.toUpperCase() + text.slice(i + 1);
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

/** The words of a line that is one run of one op: `sc in each st across`, `2 sc in each st around`, `invdec around`. */
function wholeLinePhrase(op: Op, where: 'across' | 'around', ctx: Ctx): string | null {
  if (op.k === 'tile' || (op.k === 'st' && op.into !== undefined)) return null;
  const loop = ctx.hideLoop ? undefined : loopOf(op);
  const loopPart = loop === undefined ? '' : `${loopWords(loop)} of `;
  const each = `${loopPart}each ${ctx.into} ${where}`;
  switch (op.k) {
    case 'st':
      return `${stitchWord(op.st, ctx.names)} in ${each}`;
    case 'inc':
      return `${op.n} ${ctx.names.sc} in ${each}`;
    case 'dec':
      return `${decWord(op, ctx)} ${where}`;
    default:
      return null;
  }
}

/** The ops of a line (no head, no tail) in the verbose dialect. */
function verboseOps(items: readonly Item[], ctx: Ctx, where: 'across' | 'around', foundation: { firstInto: number } | null): string {
  const state = { color: ctx.header, started: false };
  if (items.length === 1 && items[0].kind === 'run' && !ctx.inRing) {
    const only = items[0];
    const phrase = wholeLinePhrase(only.op, where, ctx);
    if (phrase !== null) {
      const own = only.op.color;
      const prefix = own !== undefined ? `with ${own}, ` : '';
      if (foundation !== null) {
        const stitch = phrase.slice(0, phrase.indexOf(' in '));
        return `${prefix}${stitch} in ${ordinal(foundation.firstInto)} ch from hook and in each ch ${where}`;
      }
      return prefix + phrase;
    }
  }
  if (foundation === null) return joinPieces(itemPieces(items, ctx, true, state));
  // Row 1 of a flat piece: the first run starts in the chain the start names (`sc in 2nd ch from hook and in next
  // 2 ch`); a line that opens with a repeat says where it starts first.
  const first = items[0];
  if (first === undefined) return '';
  if (first.kind === 'rep') return `starting in ${ordinal(foundation.firstInto)} ch from hook, ${joinPieces(itemPieces(items, ctx, true, state))}`;
  const pieces = itemPieces(items, ctx, true, state);
  const firstText = pieces[0].text;
  const at = firstText.indexOf(' in first ');
  const plain = first.op.k === 'st' && first.op.into === undefined && at >= 0 && !ctx.hideLoop && loopOf(first.op) === undefined;
  if (plain) {
    const head = firstText.slice(0, at);
    const rest = first.n === 1 ? '' : first.n === 2 ? ' and in next ch' : ` and in next ${first.n - 1} ch`;
    pieces[0] = { text: `${head} in ${ordinal(foundation.firstInto)} ch from hook${rest}`, change: pieces[0].change };
    return joinPieces(pieces);
  }
  return `starting in ${ordinal(foundation.firstInto)} ch from hook, ${joinPieces(pieces)}`;
}

/** A C2C row in the verbose dialect: the first tile from the row's start, the rest tile by tile, the end. */
function verboseC2C(line: Line, ctx: Ctx): string {
  const tiles = line.ops.filter((op): op is Extract<Op, { k: 'tile' }> => op.k === 'tile');
  const start = line.start?.k === 'c2c' ? line.start : undefined;
  const dc = ctx.names.dc;
  const sl = ctx.names.slst;
  const opening =
    start?.start === 'dec' ? `${sl} in next 3 ${dc} and in ch-3 sp, ch 3, 3 ${dc} in same sp` : `ch 6, ${dc} in 4th ch from hook and in next 2 ch`;
  const pieces: Piece[] = [];
  let color: string | undefined;
  let i = 0;
  while (i < tiles.length) {
    let j = i;
    while (j < tiles.length && tiles[j].color === tiles[i].color) j++;
    const own = tiles[i].color;
    const prefix = color === undefined ? `with ${own}, ` : `change to ${own}, `;
    const change = color !== undefined;
    color = own;
    let n = j - i;
    let text = prefix;
    if (i === 0) {
      text += opening;
      n -= 1;
      if (n > 0) text += ', ';
    }
    if (n === 1) text += `(${sl}, ch 3, 3 ${dc}) in next ch-3 sp`;
    else if (n > 1) text += `(${sl}, ch 3, 3 ${dc}) in each of next ${n} ch-3 sps`;
    pieces.push({ text, change });
    i = j;
  }
  let body = joinPieces(pieces);
  if (start?.end === 'dec') body += `; ${sl} in last ch-3 sp, turn`;
  return body;
}

/** `(40 sc)` for a chart line of one plain stitch, `(3 tiles)` for C2C, else `(18 sts)`. */
function verboseCount(line: Line, docKind: DocKind, names: Readonly<VerboseNames>): string {
  const n = line.stated;
  if (line.kind === 'c2c') return `(${n} ${n === 1 ? 'tile' : 'tiles'})`;
  if (docKind === '2d' && line.ops.length > 0) {
    const first = line.ops[0];
    if (first.k === 'st' && first.st !== 'slst' && first.into === undefined) {
      const uniform = line.ops.every((op) => op.k === 'st' && op.st === first.st && op.into === undefined && loopOf(op) === undefined);
      if (uniform) return `(${n} ${stitchWord(first.st, names)})`;
    }
  }
  return `(${n} ${n === 1 ? 'st' : 'sts'})`;
}

/** The label of a verbose line: the compact label, reading arrow included (§2.7.2; research 07 §7.7). */
function verboseLabel(line: Line): string {
  return compactLabel(line);
}

/** Everything between the colon and the count, in the verbose dialect. */
export function verboseBody(line: Line, o: Omit<RenderOptions, 'dialect' | 'hand'> & { hand?: Hand }): string {
  const docKind = docKindOf(line, o);
  const names = verboseNames(o.terms);
  const shown = displayOps(line);
  const loop = sharedLoop(shown);
  const ctx: Ctx = {
    names,
    docKind,
    decMethod: o.decMethod === 'sc2tog' ? 'sc2tog' : 'invdec',
    hideLoop: loop !== undefined,
    into: 'st',
    inRing: false,
    header: line.colorHeader,
  };
  const loopPrefix = loop === undefined ? '' : `working in ${loop === 'BLO' ? 'back' : 'front'} loops only, `;
  const where = line.kind === 'row' ? 'across' : 'around';
  const start = line.start;
  const items = lineItems(line, { docKind });

  let head = '';
  let body: string;
  if (line.kind === 'c2c') {
    body = verboseC2C(line, ctx);
  } else {
    switch (start?.k) {
      case 'mr':
        body = loopPrefix + joinPieces(itemPieces(items, { ...ctx, inRing: true }, true, { color: ctx.header, started: false }));
        break;
      case 'foundation':
        body = loopPrefix + verboseOps(items, { ...ctx, into: 'ch' }, where, { firstInto: start.firstInto });
        break;
      case 'turn':
        head = start.chains === 1 ? 'Ch 1, turn. ' : `Ch ${start.chains} (does not count as a st), turn. `;
        body = loopPrefix + verboseOps(items, ctx, where, null);
        break;
      case 'chainOval': {
        const side = chainOvalSide(shown);
        if (side === null) {
          body = loopPrefix + verboseOps(items, { ...ctx, into: 'ch' }, where, null);
        } else {
          const sc = names.sc;
          const along = side === 0 ? '' : side === 1 ? `${sc} in next ch, ` : `${sc} in next ${side} ch, `;
          body = `${sc} in 2nd ch from hook, ${along}3 ${sc} in last ch; working along the other side of the chain, ${along}2 ${sc} in last ch`;
        }
        break;
      }
      case 'chainRing':
        if (docKind === '2d') head = 'Ch 1 (does not count as a st), ';
        else if (line.join !== undefined) head = 'Ch 1 (does not count), ';
        body = loopPrefix + verboseOps(items, { ...ctx, into: 'ch' }, where, null);
        break;
      case 'join':
        if (!isJoinedHead(line, { docKind })) {
          head = 'Ch 1, ';
          body = loopPrefix + verboseOps(items, ctx, where, null);
        } else {
          head = 'Ch 1 (does not count), ';
          const first = shown[0];
          const state = { color: ctx.header, started: false };
          let phrase: string;
          const own = first.color ?? ctx.header;
          const prefix = first.color !== undefined && first.color !== ctx.header ? `with ${own}, ` : '';
          if (first.k === 'dec') phrase = `${decWord(first, ctx)} over same st as join and next ${first.n === 3 ? '2 sts' : 'st'}`;
          else if (first.k === 'inc') phrase = `${first.n} ${names.sc} in same st as join`;
          else if (first.k === 'st') phrase = `${stitchWord(first.st, names)} in same st as join`;
          else phrase = 'tile';
          state.color = own;
          state.started = true;
          body = `${loopPrefix}${prefix}${phrase}`;
          if (items.length > 1) {
            const rest = itemPieces(items.slice(1), ctx, true, state);
            body += (rest[0].change ? '; ' : ', ') + joinPieces(rest);
          }
        }
        break;
      default:
        body = loopPrefix + verboseOps(items, ctx, where, null);
    }
  }

  let tail = '';
  if (line.join !== undefined) {
    const change = line.join.changeTo === undefined ? '' : `, changing to ${line.join.changeTo}`;
    const firstSt = shown.length > 0 && shown[0].k === 'st' && (shown[0].st === 'hdc' || shown[0].st === 'dc') ? names[shown[0].st] : names.sc;
    tail = `; join with ${names.slst} in first ${firstSt}${change}`;
  } else if (start !== undefined && start.k === 'join' && docKind === '3d') {
    tail = '; do not join — continue in a spiral';
  }
  const sentence = head === '' || head.endsWith('. ');
  return head + (sentence ? capitalize(body) : body) + tail;
}

/** One line in the verbose dialect: `label: body. (count)` and the colour cues. */
export function renderVerboseLine(line: Line, o: Omit<RenderOptions, 'dialect' | 'hand'> & { hand?: Hand }): string {
  const docKind = docKindOf(line, o);
  let body = verboseBody(line, o);
  if (!body.endsWith('.')) body += '.';
  let out = `${verboseLabel(line)}: ${body} ${verboseCount(line, docKind, verboseNames(o.terms))}`;
  for (const cue of line.cues ?? []) if (cue.kind === 'color') out += ` · ${toTerms(cue.text, o.terms)}`;
  return out;
}

/** `renderLine` with an explicit pattern kind (T2's own writers pass it). */
export function renderLineWith(line: Line, o: RenderOptions): string {
  if (line.kind === 'border' && (line.start?.k === 'edge' || line.start?.k === 'join')) {
    // The border sentences of §2.7.10 (the same in both dialects); its start corner and join are in the line.
    return renderBorderLine(line, { ...o.border, terms: o.terms, hand: o.hand });
  }
  const docKind = docKindOf(line, o);
  if (o.dialect === 'verbose') return renderVerboseLine(line, { terms: o.terms, decMethod: o.decMethod, docKind });
  if (o.terms !== 'uk') return renderCompactLine(line, { docKind });
  // The kernel prints the stitch names from the table; the colour cues are free text.
  const cues = line.cues?.map((cue) => (cue.kind === 'color' ? { ...cue, text: toTerms(cue.text, 'uk') } : cue));
  return renderCompactLine(cues === undefined ? line : { ...line, cues }, { docKind, names: compactNames('uk') });
}

/**
 * One `Line` as one line of text (§5.2.1): compact or verbose, US or UK. See the file header for `hand` and for
 * how a round is told to be a chart round or an amigurumi round. Cue sentences of other kinds and `Line.notes`
 * are not part of it: `renderLineExtras` returns them, to print on their own lines after it. Expects a line
 * that `validateLine` accepts.
 */
export const renderLine: RenderLineFn = (line, o) => renderLineWith(line, o);

/**
 * The sentence printed before a line worked into chains (`Foundation: With A, ch 6.`, `Ch 10.`) or before a
 * border's Rnd 1 (`Border (with B):`), in the given terms; null when the line has no such start. The same in
 * both dialects.
 */
export function renderFoundation(line: Line, o: { terms: Terms; docKind?: DocKind }): string | null {
  if (line.kind === 'border' && line.start?.k === 'edge') return borderHeader(line, o.terms);
  return compactFoundation(line, { docKind: docKindOf(line, o), names: compactNames(o.terms) });
}

/** The sentences printed on their own lines after a line: cues that are not colour cues, then `Line.notes`. */
export function renderLineExtras(line: Line, o: { terms: Terms }): string[] {
  const out: string[] = [];
  for (const cue of line.cues ?? []) if (cue.kind !== 'color') out.push(toTerms(cue.text, o.terms));
  for (const note of line.notes ?? []) out.push(toTerms(note, o.terms));
  return out;
}
