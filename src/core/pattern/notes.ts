// Track T2 — the Notes blocks, rendered from templates with only the parts that apply (DESIGN.md §2.7.2,
// §2.7.4, §2.7.5, §2.7.8, §2.7.9, §2.10.11; research 07 §3.6, §4.7, §6.12; §5.2.1). T4's 3D PatternDoc calls it
// with kind 'amigurumi'.
//
// Each note is one sentence (or two that belong together), in the order of the templates, so a view can list
// them and link each to help. Text is written in US terms and converted for UK with the one-pass `toTerms`.
// `notesFor` is the frozen entry point; `notesWith` takes two more facts T2's writers know (the stitch of a
// flat chart and the number of rounds of a tapestry tube).
import type { ChartSettings, Hand, NotesForFn, Terms } from '../../types';
import { toTerms } from './terminology';

export type NotesKind = Parameters<NotesForFn>[0];

export interface NotesContext {
  terms: Terms;
  hand: Hand;
  /** C2C start corner: `'BR' | 'BL' | 'TR' | 'TL'` or the words (`'bottom-right'`). Default BR (RH) / BL (LH). */
  corner?: string;
  /** C2C row arrows `[odd, even]`. Default: from the corner and hand (§2.7.6). */
  arrows?: string[];
  /** Amigurumi: some piece is worked in joined rounds (§2.11.3). */
  joinedRounds?: boolean;
  /** Amigurumi spiral lean in st per round (§2.11.2); 0 or absent leaves the sentence out. */
  leanStPerRnd?: number;
  /** Tapestry in the round (§2.7.5). Default `{ mode: 'note', stPerRnd: 0.5 }`. */
  roundLean?: ChartSettings['roundLean'];
  /** Flat chart stitch (T2): 'sc' (default) or 'hdc' (§2.7.7). */
  stitch?: 'sc' | 'hdc';
  /** Tapestry in the round (T2): the number of rounds R, for the drift sentence of the `note` mode. */
  rounds?: number;
  /** Flat graph (T2): the rows print the strand cues `join B (bobbin 2)` / `carry B` (default true). */
  strandCues?: boolean;
}

const CORNER_WORDS: Readonly<Record<'BR' | 'BL' | 'TR' | 'TL', string>> = Object.freeze({
  BR: 'bottom-right',
  BL: 'bottom-left',
  TR: 'top-right',
  TL: 'top-left',
});

/**
 * The arrows of odd (RS) and even (WS) C2C rows for each hand and start corner: the right-handed bottom-right
 * frame's ↙ / ↗ mapped back through the corner transform of §2.7.6 (RH: rotations; LH: the RH entry of the
 * mirrored corner, mirrored).
 */
export const C2C_ARROWS: Readonly<Record<Hand, Readonly<Record<'BR' | 'BL' | 'TR' | 'TL', readonly [string, string]>>>> = Object.freeze({
  right: Object.freeze({ BR: ['↙', '↗'] as const, BL: ['↖', '↘'] as const, TL: ['↗', '↙'] as const, TR: ['↘', '↖'] as const }),
  left: Object.freeze({ BR: ['↗', '↙'] as const, BL: ['↘', '↖'] as const, TL: ['↙', '↗'] as const, TR: ['↖', '↘'] as const }),
});

function cornerCode(corner: string | undefined, hand: Hand): 'BR' | 'BL' | 'TR' | 'TL' {
  const text = (corner ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  switch (text) {
    case 'br':
    case 'bottom-right':
      return 'BR';
    case 'bl':
    case 'bottom-left':
      return 'BL';
    case 'tr':
    case 'top-right':
      return 'TR';
    case 'tl':
    case 'top-left':
      return 'TL';
    default:
      return hand === 'left' ? 'BL' : 'BR';
  }
}

/** A number as printed in a note: at most two decimals, no trailing zeros. */
function num(value: number): string {
  return String(Math.round(value * 100) / 100);
}

const COLOR_CHANGE = 'Change color on the last yarn over of the stitch before the new color.';
const ROW_BOUNDARY =
  'When the next row starts in another color, change to it on the last yarn over of the row before, so the ' +
  'turning chain is already in the new color.';

function readingSentence(hand: Hand, what: 'rows' | 'rounds'): string {
  const Odd = what === 'rows' ? 'Odd rows' : 'Odd rounds';
  const even = what === 'rows' ? 'even rows' : 'even rounds';
  return hand === 'left'
    ? `${Odd} are RS and are read left to right; ${even} are WS and are read right to left (right-handed: reverse).`
    : `${Odd} are RS and are read right to left; ${even} are WS and are read left to right (left-handed: reverse).`;
}

function flatGraph(ctx: NotesContext, tapestry: boolean): string[] {
  const stitch = ctx.stitch === 'hdc' ? 'hdc' : 'sc';
  const chains = stitch === 'hdc' ? 2 : 1;
  const notes = [
    `Each square = 1 ${stitch}.`,
    readingSentence(ctx.hand, 'rows'),
    `Ch ${chains} at the beginning of a row does not count as a stitch.`,
    COLOR_CHANGE,
    ROW_BOUNDARY,
  ];
  if (tapestry) {
    notes.push(
      'Work over the colors not in use (tapestry): every color that appears in a row is carried through the whole row, and each line ends with the colors carried (“carry B, C”).',
      'A color is joined at the start of the first row that needs it and cut at the end of a row when the next 2 rows do not use it (leave a 6 in tail).',
      'Carried yarn stays hidden only with firm tension; check the RS.',
    );
  } else {
    notes.push('Work over the color(s) not in use (tapestry), or use a separate bobbin for each area marked in the chart (intarsia).');
    if (ctx.strandCues !== false) {
      notes.push('“carry B” at the end of a line: work over B where it is not used in that row; “join B (bobbin 2)”: start a new bobbin of B there.');
    }
    notes.push('Drop the inactive yarn to the WS.');
  }
  return notes;
}

function tapestryRound(ctx: NotesContext): string[] {
  const lean = ctx.roundLean ?? { mode: 'note' as const, stPerRnd: 0.5 };
  const notes = ['Each square = 1 sc.'];
  if (lean.mode === 'turn') {
    notes.push(
      `The rounds are joined and turned. ${readingSentence(ctx.hand, 'rounds')} Turning every round keeps the stitches from leaning.`,
    );
  } else {
    notes.push(
      ctx.hand === 'left'
        ? 'Every round is worked with the RS facing and is read left to right (right-handed: right to left).'
        : 'Every round is worked with the RS facing and is read right to left (left-handed: left to right).',
    );
  }
  notes.push('Ch 1 at the beginning of a round does not count as a stitch; join every round with a sl st in the first sc.');
  notes.push(COLOR_CHANGE);
  notes.push('Work over the colors not in use: every color that appears in a round is carried through the whole round.');
  notes.push('Carried yarn stays hidden only with firm tension; check the RS.');
  const per = typeof lean.stPerRnd === 'number' && Number.isFinite(lean.stPerRnd) ? lean.stPerRnd : 0;
  if (lean.mode === 'note' && per !== 0) {
    // Positive = the stitches drift against the working direction: to the right for RH seen from the RS.
    const right = (per > 0) === (ctx.hand !== 'left');
    const side = right ? 'right' : 'left';
    const tail = "Choose 'Pre-skew the chart' or 'Turn every round' in the settings to avoid it.";
    const rounds = ctx.rounds;
    if (typeof rounds === 'number' && Number.isInteger(rounds) && rounds >= 2) {
      const shift = Math.round(Math.abs(per) * (rounds - 1));
      notes.push(`Stitches worked in rounds lean: expect the design to shift about ${shift} sts to the ${side} between Rnd 1 and Rnd ${rounds}. ${tail}`);
    } else {
      notes.push(`Stitches worked in rounds lean: expect the design to shift about ${num(Math.abs(per))} st per round to the ${side}. ${tail}`);
    }
  } else if (lean.mode === 'preskew' && per !== 0) {
    notes.push(
      'Each written round is shifted a little against the lean of the stitches (pre-skewed), so the finished design comes out straight; follow the written rounds, not the chart.',
    );
  }
  return notes;
}

function c2c(ctx: NotesContext): string[] {
  const code = cornerCode(ctx.corner, ctx.hand);
  const fallback = C2C_ARROWS[ctx.hand === 'left' ? 'left' : 'right'][code];
  const odd = typeof ctx.arrows?.[0] === 'string' ? ctx.arrows[0] : fallback[0];
  const even = typeof ctx.arrows?.[1] === 'string' ? ctx.arrows[1] : fallback[1];
  return [
    'Each square = 1 tile (ch 3 + 3 dc).',
    `Start at the ${CORNER_WORDS[code]} corner.`,
    `Odd rows (RS) run ${odd}, even rows (WS) run ${even}; turn at the end of every row.`,
    'Increase at beginning: ch 6, dc in 4th ch from hook and next 2 ch.',
    'Decrease at beginning: sl st in next 3 dc and in the ch-3 sp, ch 3, 3 dc in same sp.',
    'Decrease at end: sl st in last ch-3 sp and turn without making a tile.',
    'Change color on the last yo of the last dc of the tile before.',
  ];
}

function mosaic(ctx: NotesContext): string[] {
  return [
    ctx.hand === 'left'
      ? 'Every row is worked with the RS facing, from left to right (right-handed: right to left); do not turn.'
      : 'Every row is worked with the RS facing, from right to left (left-handed: left to right); do not turn.',
    'Each row is worked in one color: join it at the start of the row and fasten off at the end (leave 6 in tails).',
    'Work sc in the back loop only, except where a row says “dc FLO 2 rows below”: there, dc in the front loop of the st 2 rows below, in front of the row between.',
    'The first and last st of every row are sc through both loops.',
  ];
}

function border(): string[] {
  return [
    'The border is worked in joined rounds of sc with the RS facing.',
    'Work 3 sc in each corner stitch; along the row ends (and C2C tile edges) space the stated number of sc evenly so the edge lies flat.',
  ];
}

function amigurumi(ctx: NotesContext): string[] {
  const joined = ctx.joinedRounds === true ? ', except where a piece says it is worked in joined rounds' : '';
  const notes = [
    `Work in continuous rounds (spiral); do not join or turn${joined}.`,
    'Mark the first st of each round and move the marker up every round.',
    'Stitch counts are in parentheses at the end of each round.',
    '“N sc” = sc in each of the next N sts, and likewise for every stitch (“3 inc” = inc in each of the next 3 sts); ' +
      'inc = 2 sc in the same st; dec = invisible decrease (or sc2tog); in BLO/FLO rounds, dec = sc2tog through the stated loops only.',
    'Work through both loops unless BLO/FLO is stated.',
    COLOR_CHANGE,
  ];
  const lean = ctx.leanStPerRnd;
  if (typeof lean === 'number' && Number.isFinite(lean) && lean !== 0) {
    notes.push(
      `Spiral rounds lean a little each round; the stitch numbers already allow for about ${num(Math.abs(lean))} st per round, ` +
        'and every placement also names a landmark, so pin pieces and check the landmarks before sewing.',
    );
  }
  notes.push('Safety eyes are not suitable for children under 3; embroider eyes instead.');
  return notes;
}

/** `notesFor` with T2's two extra facts (`stitch`, `rounds`). Unknown kinds give no notes. Never throws. */
export function notesWith(kind: NotesKind, ctx: NotesContext): string[] {
  const c: NotesContext = typeof ctx === 'object' && ctx !== null ? ctx : { terms: 'us', hand: 'right' };
  let notes: string[];
  switch (kind) {
    case 'flat-graph':
      notes = flatGraph(c, false);
      break;
    case 'tapestry':
      notes = flatGraph(c, true);
      break;
    case 'tapestry-round':
      notes = tapestryRound(c);
      break;
    case 'c2c':
      notes = c2c(c);
      break;
    case 'mosaic':
      notes = mosaic(c);
      break;
    case 'border':
      notes = border();
      break;
    case 'amigurumi':
      notes = amigurumi(c);
      break;
    default:
      notes = [];
  }
  return notes.map((note) => toTerms(note, c.terms));
}

/**
 * The Notes block of one kind of pattern (§2.7.9, §2.10.11), one sentence per entry, in the given terms and for
 * the given hand: flat graph, flat tapestry, tapestry in the round (with its lean note), C2C (corner and arrows),
 * mosaic, border, amigurumi (joined rounds and the spiral lean when they apply).
 */
export const notesFor: NotesForFn = (kind, ctx) => notesWith(kind, ctx);
