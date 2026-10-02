// Track T8 — text for the PDF: the standard-14 fonts' WinAnsi character set, the few characters drawn as vector
// glyphs (the reading arrows of chart rows, ΔE, ≥), and a small rich-text line breaker.
//
// Why standard fonts: the PDF must not depend on a font file (none ships with the app, and no dependency may be
// added), so text is set in Helvetica and Times, which every PDF viewer and printer has. They cover WinAnsi
// (Latin-1 plus “ ” ‘ ’ – — … • ™ €). Pattern text uses six arrows (`Line.arrow`, §5.2) that WinAnsi lacks; they
// are drawn as strokes in the text's color, as wide as a Helvetica arrow. Anything else outside WinAnsi falls back
// to its base letter (é → e only when é is missing, which it is not; ő → o) or "?".
//
// Pure: the line breaker takes a `Measure` function, so tests run it without jsPDF.

export type Rgb = readonly [number, number, number];
export type FontName = 'helvetica' | 'times';
export type FontStyle = 'normal' | 'bold' | 'italic' | 'bolditalic';

export interface TextStyle {
  font: FontName;
  style: FontStyle;
  /** Points. */
  size: number;
  color: Rgb;
}

/** A piece of text with an optional style override. */
export interface Span {
  text: string;
  style?: Partial<TextStyle>;
}

/** Characters drawn as vector glyphs (`drawGlyph` in pdf.ts) or set in the Symbol font. */
export type GlyphId = 'arrow-left' | 'arrow-right' | 'arrow-up' | 'arrow-down' | 'arrow-up-left' | 'arrow-up-right' | 'arrow-down-left' | 'arrow-down-right' | 'delta' | 'ge' | 'le' | 'approx' | 'check';

export const GLYPHS: Readonly<Record<string, GlyphId>> = {
  '←': 'arrow-left',
  '→': 'arrow-right',
  '↑': 'arrow-up',
  '↓': 'arrow-down',
  '↖': 'arrow-up-left',
  '↗': 'arrow-up-right',
  '↙': 'arrow-down-left',
  '↘': 'arrow-down-right',
  'Δ': 'delta',
  '≥': 'ge',
  '≤': 'le',
  '≈': 'approx',
  '✓': 'check',
};

/** Advance width of each glyph in em. Arrows: Helvetica-like 1 em is too wide beside 0.55 em digits; 0.86 reads well. */
export const GLYPH_WIDTH_EM: Readonly<Record<GlyphId, number>> = {
  'arrow-left': 0.86,
  'arrow-right': 0.86,
  'arrow-up': 0.6,
  'arrow-down': 0.6,
  'arrow-up-left': 0.78,
  'arrow-up-right': 0.78,
  'arrow-down-left': 0.78,
  'arrow-down-right': 0.78,
  delta: 0.612,
  ge: 0.549,
  le: 0.549,
  approx: 0.549,
  check: 0.72,
};

/** The Windows-1252 characters above 0x7F that are not Latin-1 (0x80–0x9F). */
const CP1252_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';

/** True when the standard fonts can set `ch` (WinAnsiEncoding). */
export function isWinAnsi(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  if (ch.length !== 1) return false;
  if (c >= 0x20 && c <= 0x7e) return true;
  if (c >= 0xa0 && c <= 0xff) return true;
  return CP1252_EXTRA.includes(ch);
}

/** Common characters outside WinAnsi with a plain stand-in. */
const SUBSTITUTES: Readonly<Record<string, string>> = {
  '−': '-',
  '‐': '-',
  '‑': '-',
  '‒': '–',
  '′': "'",
  '″': '"',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  ' ': ' ',
  '\t': ' ',
  '​': '',
  '‍': '',
  '️': '',
  '⅓': '1/3',
  '⅔': '2/3',
  '⅛': '1/8',
  '⅜': '3/8',
  '⅝': '5/8',
  '⅞': '7/8',
  '✔': '✓',
  '☐': '[ ]',
  '★': '*',
  '♥': '<3',
};

/** One character (code point) as WinAnsi text: itself, a stand-in, its base letter, or "?". Glyph characters are not handled here. */
export function winAnsiChar(ch: string): string {
  if (isWinAnsi(ch)) return ch;
  const sub = SUBSTITUTES[ch];
  if (sub !== undefined) return sub;
  const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (base.length > 0 && base !== ch && [...base].every(isWinAnsi)) return base;
  if (/\p{M}/u.test(ch)) return '';
  if (/[\u0000-\u001f\u007f-\u009f]/.test(ch)) return '';
  return '?';
}

/** A whole string as WinAnsi text (no glyphs: arrows become "<-"/"->" — used for metadata and bookmarks). */
export function toWinAnsi(text: string): string {
  const ascii: Readonly<Record<string, string>> = { '←': '<-', '→': '->', '↑': '^', '↓': 'v', '↖': '\\', '↗': '/', '↙': '/', '↘': '\\', 'Δ': 'Delta ', '≥': '>=', '≤': '<=', '≈': '~', '✓': 'v' };
  let out = '';
  for (const ch of text.normalize('NFC')) out += ascii[ch] ?? winAnsiChar(ch);
  return out;
}

export type Token = { kind: 'text'; text: string } | { kind: 'glyph'; glyph: GlyphId } | { kind: 'space' };

/** Splits a string into words, spaces and glyphs; every text token is WinAnsi. Line breaks become spaces. */
export function tokenize(text: string): Token[] {
  const out: Token[] = [];
  let word = '';
  const flush = (): void => {
    if (word) out.push({ kind: 'text', text: word });
    word = '';
  };
  for (const raw of text.normalize('NFC')) {
    const glyph = GLYPHS[raw];
    if (glyph) {
      flush();
      out.push({ kind: 'glyph', glyph });
      continue;
    }
    const ch = raw === '\n' || raw === '\r' ? ' ' : winAnsiChar(raw);
    for (const c of ch) {
      if (c === ' ') {
        flush();
        if (out.length === 0 || out[out.length - 1].kind !== 'space') out.push({ kind: 'space' });
      } else word += c;
    }
  }
  flush();
  return out;
}

/** Width of WinAnsi text in points for a style. */
export type Measure = (text: string, style: TextStyle) => number;

/** A positioned piece of a laid-out line. Text pieces with one style are merged (spaces included). */
export type LinePiece =
  | { kind: 'text'; text: string; style: TextStyle; x: number; width: number }
  | { kind: 'glyph'; glyph: GlyphId; style: TextStyle; x: number; width: number };

export interface LaidLine {
  pieces: LinePiece[];
  width: number;
  /** The largest font size on the line (for its height). */
  size: number;
}

interface Atom {
  /** A word: glyphs and text that must stay together (e.g. "(RS)", "←:"), possibly in several styles. */
  parts: { token: Exclude<Token, { kind: 'space' }>; style: TextStyle; width: number }[];
  width: number;
  /** The width of the space before it (in the style of what follows the space). */
  spaceBefore: number;
  spaceStyle: TextStyle | null;
}

function merge(base: TextStyle, over?: Partial<TextStyle>): TextStyle {
  return over ? { ...base, ...over } : base;
}

function sameStyle(a: TextStyle, b: TextStyle): boolean {
  return a.font === b.font && a.style === b.style && a.size === b.size && a.color[0] === b.color[0] && a.color[1] === b.color[1] && a.color[2] === b.color[2];
}

/** Atoms (words with their leading space) of spans. A glyph glued to text (no space) stays in the same word. */
function atomsOf(spans: readonly Span[], base: TextStyle, measure: Measure): Atom[] {
  const atoms: Atom[] = [];
  let current: Atom | null = null;
  let pendingSpace: TextStyle | null = null;
  for (const span of spans) {
    const style = merge(base, span.style);
    for (const token of tokenize(span.text)) {
      if (token.kind === 'space') {
        if (current) atoms.push(current);
        current = null;
        pendingSpace = style;
        continue;
      }
      const width = token.kind === 'text' ? measure(token.text, style) : GLYPH_WIDTH_EM[token.glyph] * style.size;
      if (!current) {
        current = { parts: [], width: 0, spaceBefore: pendingSpace ? measure(' ', pendingSpace) : 0, spaceStyle: pendingSpace };
        pendingSpace = null;
      }
      current.parts.push({ token, style, width });
      current.width += width;
    }
  }
  if (current) atoms.push(current);
  return atoms;
}

/** Splits an atom wider than `max` into pieces that fit (character by character). */
function splitAtom(atom: Atom, max: number, measure: Measure): Atom[] {
  const out: Atom[] = [];
  let cur: Atom = { parts: [], width: 0, spaceBefore: atom.spaceBefore, spaceStyle: atom.spaceStyle };
  const push = (part: Atom['parts'][number]): void => {
    if (cur.width + part.width > max && cur.parts.length > 0) {
      out.push(cur);
      cur = { parts: [], width: 0, spaceBefore: 0, spaceStyle: null };
    }
    cur.parts.push(part);
    cur.width += part.width;
  };
  for (const part of atom.parts) {
    if (part.token.kind === 'text' && part.width > max) {
      for (const ch of part.token.text) push({ token: { kind: 'text', text: ch }, style: part.style, width: measure(ch, part.style) });
    } else push(part);
  }
  if (cur.parts.length > 0) out.push(cur);
  return out;
}

/**
 * Greedy line breaking of rich text. `firstWidth` is the room on the first line (a hanging label, a bullet),
 * `width` on the others. Returns lines whose pieces are positioned from x = 0.
 */
export function layoutText(spans: readonly Span[], base: TextStyle, measure: Measure, width: number, firstWidth = width): LaidLine[] {
  const atoms = atomsOf(spans, base, measure).flatMap((a) => (a.width > Math.min(width, firstWidth) ? splitAtom(a, Math.min(width, firstWidth), measure) : [a]));
  const lines: LaidLine[] = [];
  let line: { atoms: Atom[]; width: number } = { atoms: [], width: 0 };
  const room = (): number => (lines.length === 0 ? firstWidth : width);
  for (const atom of atoms) {
    const add = (line.atoms.length > 0 ? atom.spaceBefore : 0) + atom.width;
    if (line.atoms.length > 0 && line.width + add > room() + 1e-6) {
      lines.push(finish(line.atoms, base));
      line = { atoms: [atom], width: atom.width };
    } else {
      line.atoms.push(atom);
      line.width += add;
    }
  }
  if (line.atoms.length > 0) lines.push(finish(line.atoms, base));
  return lines;
}

function finish(atoms: Atom[], base: TextStyle): LaidLine {
  const pieces: LinePiece[] = [];
  let x = 0;
  let size = base.size;
  atoms.forEach((atom, i) => {
    if (i > 0 && atom.spaceBefore > 0) {
      const last = pieces[pieces.length - 1];
      if (last && last.kind === 'text' && atom.spaceStyle && sameStyle(last.style, atom.spaceStyle)) {
        last.text += ' ';
        last.width += atom.spaceBefore;
      }
      x += atom.spaceBefore;
    }
    for (const part of atom.parts) {
      size = Math.max(size, part.style.size);
      const last = pieces[pieces.length - 1];
      if (part.token.kind === 'text') {
        if (last && last.kind === 'text' && sameStyle(last.style, part.style) && Math.abs(last.x + last.width - x) < 1e-6) {
          last.text += part.token.text;
          last.width += part.width;
        } else pieces.push({ kind: 'text', text: part.token.text, style: part.style, x, width: part.width });
      } else pieces.push({ kind: 'glyph', glyph: part.token.glyph, style: part.style, x, width: part.width });
      x += part.width;
    }
  });
  return { pieces, width: x, size };
}

/** Plain text of spans (tests, bookmarks). */
export function plainText(spans: readonly Span[]): string {
  return spans.map((s) => s.text).join('');
}
