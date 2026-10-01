// Track T2 — the US/UK terminology table and what follows from it: the stitch names each dialect prints, a
// one-pass converter for free text, and the abbreviations and special stitches a pattern's lines actually use
// (DESIGN.md §0.1 "Terms", §2.7.2, §2.10.11; research 07 §1.1–§1.3; §5.2.1). T4's 3D PatternDoc calls
// `abbreviationsFor` and `specialStitchesFor` too.
//
// The pattern model is written in US terms. UK text is rendered from the model through the tables below, never
// by find-and-replace on rendered text: a naive `sc → dc` then `dc → tr` turns every sc into a tr (research 07
// §1.3). The only text that is converted after the fact is free text that is not in the model (cue and note
// sentences, notes blocks); `toTerms` does that in one left-to-right pass with the longest match at each place,
// so nothing is converted twice.
import type { Line, Op, PatternDoc, Terms } from '../../types';
import { type CompactNames, US_COMPACT_NAMES } from './ops';

// ---- Stitch names

/** The UK words of the compact dialect: sc → dc, hdc → htr, dc → tr, sl st → ss, sc2tog → dc2tog (§2.7.2). */
export const UK_COMPACT_NAMES: Readonly<CompactNames> = Object.freeze({
  sc: 'dc',
  hdc: 'htr',
  dc: 'tr',
  slst: 'ss',
  inc: 'inc',
  inc3: 'inc3',
  dec: 'dec',
  dec3: 'dec3',
  sc2tog: 'dc2tog',
  sc3tog: 'dc3tog',
});

/** The compact stitch names of a terminology. */
export function compactNames(terms: Terms): Readonly<CompactNames> {
  return terms === 'uk' ? UK_COMPACT_NAMES : US_COMPACT_NAMES;
}

// ---- One-pass converter for free text (research 07 §1.3)

/**
 * US → UK, CYC's table of term differences plus the decrease names that follow its ladder. Longer entries win
 * at the same place (`sc2tog` before `sc`, `half double crochet` before `double crochet`). Matching ignores
 * case and keeps the capital of the first letter (`Gauge` → `Tension`, `Sc` → `Dc`).
 */
const US_TO_UK: ReadonlyArray<readonly [string, string]> = [
  ['half double crochet', 'half treble'],
  ['double treble crochet', 'triple treble crochet'],
  ['triple treble', 'quadruple treble'],
  ['double treble', 'triple treble'],
  ['treble crochet', 'double treble crochet'],
  ['double crochet', 'treble'],
  ['single crochet', 'double crochet'],
  ['treble', 'double treble'],
  ['yarn over', 'yarn over hook'],
  ['gauge', 'tension'],
  ['sl sts', 'ss'],
  ['sl st', 'ss'],
  ['hdc2tog', 'htr2tog'],
  ['hdc3tog', 'htr3tog'],
  ['sc2tog', 'dc2tog'],
  ['sc3tog', 'dc3tog'],
  ['dc2tog', 'tr2tog'],
  ['dc3tog', 'tr3tog'],
  ['FPsc', 'FPdc'],
  ['BPsc', 'BPdc'],
  ['FPdc', 'FPtr'],
  ['BPdc', 'BPtr'],
  ['hdc', 'htr'],
  ['dtr', 'trtr'],
  ['sc', 'dc'],
  ['dc', 'tr'],
  ['tr', 'dtr'],
  ['yo', 'yoh'],
];

const UK_BY_KEY = new Map(US_TO_UK.map(([us, uk]) => [us.toLowerCase(), uk]));

/** The lookup key of a matched term: lower case, one space between words. */
function keyOf(match: string): string {
  return match.toLowerCase().replace(/\s+/g, ' ');
}
const PATTERN = new RegExp(
  // Longest first, so the alternation tries `sc2tog` before `sc`. A term is a whole word: no letter before it
  // (a digit is fine: `2sc`), and no letter or digit after it.
  `(?<![A-Za-z])(${[...US_TO_UK]
    .map(([us]) => us)
    .sort((a, b) => b.length - a.length)
    .map((us) => us.replace(/ /g, '\\s+'))
    .join('|')})(?![A-Za-z0-9])`,
  'gi',
);

function keepCase(source: string, target: string): string {
  // An abbreviation in capitals stays in capitals (`SC` → `DC`); a word keeps its first capital (`Gauge`).
  if (source.length > 1 && !source.includes(' ') && source === source.toUpperCase() && source !== source.toLowerCase()) return target.toUpperCase();
  const first = source.charAt(0);
  if (first !== first.toUpperCase() || first === first.toLowerCase()) return target;
  return target.charAt(0).toUpperCase() + target.slice(1);
}

/**
 * Free text in the given terms: unchanged for `'us'`; for `'uk'` every US stitch term is replaced in one pass
 * (research 07 §1.3: `Ch 3 (counts as dc), dc in next st, sc2tog, …` → `Ch 3 (counts as tr), tr in next st,
 * dc2tog, …`). Use it only on text that is not built from the model (cues, notes, notes blocks).
 */
export function toTerms(text: string, terms: Terms): string {
  if (terms !== 'uk') return text;
  return text.replace(PATTERN, (match: string) => keepCase(match, UK_BY_KEY.get(keyOf(match)) ?? match));
}

// ---- Abbreviations (research 07 §1.1: only those used)

/** The decrease a pattern uses (`AmiSettings.decMethod`); undefined = not said (both are listed). */
type DecMethodOption = 'invdec' | 'sc2tog' | undefined;

function decMethodOf(value: unknown): DecMethodOption {
  return value === 'invdec' || value === 'sc2tog' ? value : undefined;
}

interface AbbreviationDef {
  /** US and UK spelling of the abbreviation. */
  us: string;
  uk: string;
  /** US and UK meaning. */
  usMeaning: string;
  ukMeaning: string;
}

function same(abbr: string, meaning: string): AbbreviationDef {
  return { us: abbr, uk: abbr, usMeaning: meaning, ukMeaning: meaning };
}

/** Every abbreviation a pattern of ours can print, keyed by its US spelling. */
const ABBREVIATIONS: Readonly<Record<string, AbbreviationDef>> = Object.freeze({
  BLO: same('BLO', 'back loop only'),
  FLO: same('FLO', 'front loop only'),
  beg: same('beg', 'beginning'),
  ch: same('ch', 'chain'),
  'ch-sp': same('ch-sp', 'chain space (ch-3 sp: the space under a tile’s ch 3)'),
  dc: { us: 'dc', uk: 'tr', usMeaning: 'double crochet', ukMeaning: 'treble' },
  dec: same('dec', 'decrease (see Special stitches)'),
  dec3: same('dec3', 'decrease over 3 stitches (see Special stitches)'),
  hdc: { us: 'hdc', uk: 'htr', usMeaning: 'half double crochet', ukMeaning: 'half treble' },
  inc: { us: 'inc', uk: 'inc', usMeaning: 'increase: 2 sc in the same stitch', ukMeaning: 'increase: 2 dc in the same stitch' },
  'inc (C2C)': same('inc', 'increase: a row that gains a tile at that end (see Notes)'),
  'dec (C2C)': same('dec', 'decrease: a row that loses a tile at that end (see Notes)'),
  inc3: { us: 'inc3', uk: 'inc3', usMeaning: '3 sc in the same stitch', ukMeaning: '3 dc in the same stitch' },
  invdec: same('invdec', 'invisible decrease (see Special stitches)'),
  MR: same('MR', 'magic ring (see Special stitches)'),
  rep: same('rep', 'repeat'),
  'rnd(s)': same('rnd(s)', 'round(s)'),
  RS: same('RS', 'right side'),
  sc: { us: 'sc', uk: 'dc', usMeaning: 'single crochet', ukMeaning: 'double crochet' },
  sc2tog: { us: 'sc2tog', uk: 'dc2tog', usMeaning: 'single crochet 2 stitches together', ukMeaning: 'double crochet 2 stitches together' },
  sc3tog: { us: 'sc3tog', uk: 'dc3tog', usMeaning: 'single crochet 3 stitches together', ukMeaning: 'double crochet 3 stitches together' },
  'sl st': { us: 'sl st', uk: 'ss', usMeaning: 'slip stitch', ukMeaning: 'slip stitch' },
  sp: same('sp', 'space'),
  'st(s)': same('st(s)', 'stitch(es)'),
  tog: same('tog', 'together'),
  WS: same('WS', 'wrong side'),
  yo: { us: 'yo', uk: 'yoh', usMeaning: 'yarn over', ukMeaning: 'yarn over hook' },
});

/** Words of free text (cues, notes) that are abbreviations, keyed by the form they take in US text. */
const TEXT_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?<![A-Za-z])sc(?![A-Za-z0-9])/i, 'sc'],
  [/(?<![A-Za-z])hdc(?![A-Za-z0-9])/i, 'hdc'],
  [/(?<![A-Za-z])dc(?![A-Za-z0-9])/i, 'dc'],
  [/(?<![A-Za-z])sl sts?(?![A-Za-z0-9])/i, 'sl st'],
  [/(?<![A-Za-z])ch(?![A-Za-z0-9])/i, 'ch'],
  [/(?<![A-Za-z])ch-\d* ?sps?(?![A-Za-z0-9])/i, 'ch-sp'],
  [/(?<![A-Za-z])sts?(?![A-Za-z0-9])/i, 'st(s)'],
  [/(?<![A-Za-z])rnds?(?![A-Za-z0-9])/i, 'rnd(s)'],
  [/(?<![A-Za-z])yo(?![A-Za-z0-9])/i, 'yo'],
  [/(?<![A-Za-z])rep(?![A-Za-z0-9])/i, 'rep'],
  [/(?<![A-Za-z])beg(?![A-Za-z0-9])/i, 'beg'],
  [/(?<![A-Za-z])(BLO)(?![A-Za-z0-9])/, 'BLO'],
  [/(?<![A-Za-z])(FLO)(?![A-Za-z0-9])/, 'FLO'],
  [/(?<![A-Za-z])(RS)(?![A-Za-z0-9])/, 'RS'],
  [/(?<![A-Za-z])(WS)(?![A-Za-z0-9])/, 'WS'],
  [/(?<![A-Za-z])(MR)(?![A-Za-z0-9])/, 'MR'],
  [/(?<![A-Za-z])inc(?![A-Za-z0-9])/i, 'inc'],
  [/(?<![A-Za-z])dec(?![A-Za-z0-9])/i, 'dec'],
  [/(?<![A-Za-z])invdec(?![A-Za-z0-9])/i, 'invdec'],
  [/(?<![A-Za-z])sc2tog(?![A-Za-z0-9])/i, 'sc2tog'],
];

function loopOf(op: Op): 'BLO' | 'FLO' | undefined {
  if (op.k === 'tile') return undefined;
  if (op.k === 'st' && op.into === 'flo2below') return 'FLO';
  return op.loop === 'BLO' || op.loop === 'FLO' ? op.loop : undefined;
}

/** The US abbreviations the lines use: their stitches, starts, joins, sides, labels and cue / note words. */
function usedAbbreviations(lines: readonly Line[], decMethod: DecMethodOption): Set<string> {
  // The decrease the verbose dialect writes: both when the pattern does not say (`dec` = invdec or sc2tog).
  const decWords = decMethod === 'sc2tog' ? ['sc2tog'] : decMethod === 'invdec' ? ['invdec'] : ['invdec', 'sc2tog'];
  const used = new Set<string>();
  const add = (key: string): void => {
    used.add(key);
  };
  const hasC2C = lines.some((line) => typeof line === 'object' && line !== null && line.kind === 'c2c');
  for (const line of lines) {
    if (typeof line !== 'object' || line === null) continue;
    if (line.kind === 'border') {
      // The border sentences (§2.7.10): sc (corners are "3 sc", not inc3), ch, sl st, RS, st(s), rnd(s); "sp" around C2C tiles.
      for (const key of ['sc', 'ch', 'sl st', 'st(s)', 'rnd(s)', 'RS']) add(key);
      if (hasC2C) add('sp');
      continue;
    }
    if (line.kind !== 'c2c') add('st(s)');
    if (line.kind === 'rnd') add('rnd(s)');
    if (line.kind === 'rnd' && line.side === undefined && line.arrow === undefined) {
      // An amigurumi round: its Notes block (§2.10.11) defines inc, dec (invdec or sc2tog) and BLO/FLO rounds.
      for (const key of ['inc', 'dec', ...decWords, 'BLO', 'FLO']) add(key);
    }
    if (line.side === 'RS' || line.side === 'WS') {
      add('RS');
      add('WS');
    }
    const start = line.start;
    switch (start?.k) {
      case 'mr':
        add('MR');
        add('ch');
        break;
      case 'foundation':
      case 'turn':
      case 'chainOval':
        add('ch');
        break;
      case 'chainRing':
        add('ch');
        add('sl st');
        break;
      case 'join':
        add('ch');
        break;
      case 'edge':
        add('ch');
        break;
      case 'c2c':
        // The C2C Notes block (§2.7.9) prints yo, dc, sl st and ch-3 sp; the tags print inc / dec, beg.
        add('ch');
        add('dc');
        add('ch-sp');
        add('sl st');
        add('yo');
        if (start.start !== 'first') {
          add('beg');
          add('inc (C2C)');
          add('dec (C2C)');
        }
        break;
      default:
        break;
    }
    if (line.join !== undefined) add('sl st');
    for (const op of Array.isArray(line.ops) ? line.ops : []) {
      if (typeof op !== 'object' || op === null) continue;
      const loop = loopOf(op);
      if (loop !== undefined) add(loop);
      switch (op.k) {
        case 'st':
          add(op.st === 'slst' ? 'sl st' : op.st);
          break;
        case 'inc':
          add(op.n === 3 ? 'inc3' : 'inc');
          break;
        case 'dec':
          if (loop !== undefined) {
            add(op.n === 3 ? 'sc3tog' : 'sc2tog');
          } else {
            // The verbose dialect writes invdec or sc2tog (decMethod); without one, both are listed.
            add(op.n === 3 ? 'dec3' : 'dec');
            for (const word of decWords) add(op.n === 3 && decMethod === 'sc2tog' ? 'sc3tog' : word);
          }
          break;
        case 'tile':
          add('ch');
          add('dc');
          add('ch-sp');
          add('yo');
          break;
        default:
          break;
      }
    }
    const texts: string[] = [];
    for (const cue of Array.isArray(line.cues) ? line.cues : []) if (typeof cue?.text === 'string') texts.push(cue.text);
    for (const note of Array.isArray(line.notes) ? line.notes : []) if (typeof note === 'string') texts.push(note);
    for (const text of texts) for (const [word, key] of TEXT_WORDS) if (word.test(text)) add(key);
  }
  return used;
}

function byAbbreviation(a: { abbr: string }, b: { abbr: string }): number {
  const x = a.abbr.toLowerCase();
  const y = b.abbr.toLowerCase();
  if (x !== y) return x < y ? -1 : 1;
  return a.abbr < b.abbr ? -1 : a.abbr > b.abbr ? 1 : 0;
}

/**
 * The abbreviations the lines use, in the given terms, sorted alphabetically (§5.2.1; research 07 §1.1, §2
 * section 7: only those used). Read from the lines' data, not from rendered text, so the list is the same for
 * both dialects; a decrease brings `dec`, `invdec` and `sc2tog` (the verbose dialect prints one of them), an
 * amigurumi round also brings what its Notes block defines (inc, dec, invdec, sc2tog, BLO, FLO), a C2C row what
 * the C2C Notes block uses (yo, sl st, the inc/dec tags). `decMethod` (`AmiSettings.decMethod`) names the
 * decrease the pattern uses, so the other one is not listed; without it both are. Never throws: malformed lines
 * contribute what can be read from them.
 */
export function abbreviationsFor(lines: Line[], terms: Terms, decMethod?: 'invdec' | 'sc2tog'): PatternDoc['abbreviations'];
/**
 * Bridge overload (remove it when integration restores `SameSignature` for this function): the signature guard
 * still pins the v1.3 parameter list through `PendingSignature`, which reads the LAST overload; callers resolve
 * to the first one and can pass `decMethod`.
 */
export function abbreviationsFor(lines: Line[], terms: Terms): PatternDoc['abbreviations'];
export function abbreviationsFor(lines: Line[], terms: Terms, decMethod?: DecMethodOption): PatternDoc['abbreviations'] {
  const list = Array.isArray(lines) ? lines : [];
  const out: PatternDoc['abbreviations'] = [];
  const seen = new Set<string>();
  for (const key of usedAbbreviations(list, decMethodOf(decMethod))) {
    const def = ABBREVIATIONS[key];
    if (def === undefined) continue;
    const abbr = terms === 'uk' ? def.uk : def.us;
    if (seen.has(abbr)) continue;
    seen.add(abbr);
    out.push({ abbr, meaning: terms === 'uk' ? def.ukMeaning : def.usMeaning });
  }
  return out.sort(byAbbreviation);
}

// ---- Special stitches (research 07 §1.1: MR, invdec, C2C tile, BLO sc2tog, …)

const SPECIAL: ReadonlyArray<{ key: string; name: string; text: string }> = [
  {
    key: 'MR',
    name: 'Magic ring (MR)',
    text:
      'Wrap the yarn around two fingers to form a ring, insert the hook into the ring, yo and draw up a loop, ch 1 ' +
      '(does not count as a st). Work the stitches of the first round into the ring over both strands, then pull ' +
      'the tail to close the ring.',
  },
  {
    key: 'invdec',
    name: 'Invisible decrease (dec, invdec)',
    text:
      'Insert the hook in the front loop only of each of the next 2 sts, yo and draw through both front loops, yo ' +
      'and draw through the 2 loops on the hook. (Sc2tog works too: insert the hook in the next st, yo, draw up a ' +
      'loop; insert the hook in the following st, yo, draw up a loop; yo and draw through all 3 loops.)',
  },
  {
    key: 'invdec only',
    name: 'Invisible decrease (dec, invdec)',
    text:
      'Insert the hook in the front loop only of each of the next 2 sts, yo and draw through both front loops, yo ' +
      'and draw through the 2 loops on the hook.',
  },
  {
    key: 'sc2tog',
    name: 'Decrease (dec, sc2tog)',
    text: 'Insert the hook in the next st, yo and draw up a loop; insert the hook in the following st, yo and draw up a loop; yo and draw through all 3 loops.',
  },
  {
    key: 'invdec3',
    name: 'Decrease over 3 stitches (dec3)',
    text:
      'Insert the hook in the front loop only of each of the next 3 sts, yo and draw through all 3 front loops, yo ' +
      'and draw through the 2 loops on the hook.',
  },
  {
    key: 'sc3tog',
    name: 'Decrease over 3 stitches (dec3, sc3tog)',
    text: 'Insert the hook in each of the next 3 sts, yo and draw up a loop in each, yo and draw through all 4 loops.',
  },
  {
    key: 'BLO sc2tog',
    name: 'BLO sc2tog',
    text: 'Insert the hook in the back loop only of each of the next 2 sts, yo and draw up a loop in each, yo and draw through all 3 loops.',
  },
  {
    key: 'FLO sc2tog',
    name: 'FLO sc2tog',
    text: 'Insert the hook in the front loop only of each of the next 2 sts, yo and draw up a loop in each, yo and draw through all 3 loops.',
  },
  {
    key: 'BLO sc3tog',
    name: 'BLO sc3tog',
    text: 'Insert the hook in the back loop only of each of the next 3 sts, yo and draw up a loop in each, yo and draw through all 4 loops.',
  },
  {
    key: 'FLO sc3tog',
    name: 'FLO sc3tog',
    text: 'Insert the hook in the front loop only of each of the next 3 sts, yo and draw up a loop in each, yo and draw through all 4 loops.',
  },
  {
    key: 'tile',
    name: 'C2C tile',
    text:
      'Ch 3 and 3 dc. The first tile of a row that grows is ch 6, dc in 4th ch from hook and in next 2 ch; each ' +
      'remaining tile is (sl st, ch 3, 3 dc) in the next ch-3 sp of the row below.',
  },
  {
    key: 'long',
    name: 'Mosaic long stitch (dc FLO 2 rows below)',
    text:
      'Dc in the front loop of the st 2 rows below (the X of the chart), working in front of the row between; skip ' +
      'the st behind it in the current row.',
  },
];

/**
 * The special stitches the lines use, with how to work them, in the given terms (§5.2.1; research 07 §1.1,
 * §2.10.11): the magic ring, the invisible decrease (dec) and its 3-stitch form, BLO/FLO sc2tog and sc3tog, the
 * C2C tile and the mosaic long stitch. In UK terms the texts go through `toTerms` (names: `BLO dc2tog`).
 * `decMethod` names the decrease of the pattern: `sc2tog` lists the sc2tog (and sc3tog) instead of the invisible
 * decrease, `invdec` the invisible decrease without the sc2tog alternative; without it the invisible decrease is
 * listed with sc2tog as the alternative. Never throws.
 */
export function specialStitchesFor(lines: Line[], terms: Terms, decMethod?: 'invdec' | 'sc2tog'): PatternDoc['specialStitches'];
/** Bridge overload, as for `abbreviationsFor`: remove it when integration restores `SameSignature`. */
export function specialStitchesFor(lines: Line[], terms: Terms): PatternDoc['specialStitches'];
export function specialStitchesFor(lines: Line[], terms: Terms, decMethod?: DecMethodOption): PatternDoc['specialStitches'] {
  const method = decMethodOf(decMethod);
  const used = new Set<string>();
  for (const line of Array.isArray(lines) ? lines : []) {
    if (typeof line !== 'object' || line === null) continue;
    if (line.start?.k === 'mr') used.add('MR');
    for (const op of Array.isArray(line.ops) ? line.ops : []) {
      if (typeof op !== 'object' || op === null) continue;
      if (op.k === 'tile') used.add('tile');
      else if (op.k === 'st' && op.into === 'flo2below') used.add('long');
      else if (op.k === 'dec') {
        const loop = loopOf(op);
        if (loop === undefined) {
          if (method === 'sc2tog') used.add(op.n === 3 ? 'sc3tog' : 'sc2tog');
          else if (op.n === 3) used.add('invdec3');
          else used.add(method === 'invdec' ? 'invdec only' : 'invdec');
        }
        else used.add(`${loop} ${op.n === 3 ? 'sc3tog' : 'sc2tog'}`);
      }
    }
  }
  return SPECIAL.filter((s) => used.has(s.key)).map((s) => ({ name: toTerms(s.name, terms), text: toTerms(s.text, terms) }));
}
