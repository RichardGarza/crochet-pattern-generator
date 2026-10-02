import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../markdown';
import { GLYPH_WIDTH_EM, type Measure, type TextStyle, isWinAnsi, layoutText, plainText, toWinAnsi, tokenize, winAnsiChar } from '../text';

const base: TextStyle = { font: 'helvetica', style: 'normal', size: 10, color: [0, 0, 0] };
/** Every character 0.5 em wide (bold 0.6), so widths are easy to reason about. */
const mono: Measure = (text, s) => text.length * s.size * (s.style === 'bold' ? 0.6 : 0.5);

describe('WinAnsi text for the standard fonts', () => {
  it('keeps Latin-1 and the Windows-1252 extras', () => {
    for (const ch of ['a', 'é', 'ß', '×', '·', '¾', '–', '—', '“', '”', '‘', '’', '…', '•', '€', '™']) expect(isWinAnsi(ch), ch).toBe(true);
    for (const ch of ['←', 'Δ', '≥', 'ő', '😀', '中']) expect(isWinAnsi(ch), ch).toBe(false);
  });

  it('replaces the rest with a stand-in, the base letter or "?"', () => {
    expect(winAnsiChar('−')).toBe('-');
    expect(winAnsiChar('″')).toBe('"');
    expect(winAnsiChar('ő')).toBe('o');
    expect(winAnsiChar('Ł')).toBe('?');
    expect(winAnsiChar('中')).toBe('?');
    expect(toWinAnsi('Kitty 😺 – “Row 1” ←')).toBe('Kitty ? – “Row 1” <-');
    expect(toWinAnsi('ΔE ≥ 2')).toBe('Delta E >= 2');
  });

  it('turns the reading arrows and ΔE into glyph tokens, everything else into WinAnsi words', () => {
    expect(tokenize('Row 1 (RS) ←: 2 sc A')).toEqual([
      { kind: 'text', text: 'Row' },
      { kind: 'space' },
      { kind: 'text', text: '1' },
      { kind: 'space' },
      { kind: 'text', text: '(RS)' },
      { kind: 'space' },
      { kind: 'glyph', glyph: 'arrow-left' },
      { kind: 'text', text: ':' },
      { kind: 'space' },
      { kind: 'text', text: '2' },
      { kind: 'space' },
      { kind: 'text', text: 'sc' },
      { kind: 'space' },
      { kind: 'text', text: 'A' },
    ]);
    const all = tokenize('↖↗↙↘→↑↓ΔE ≥');
    expect(all.filter((t) => t.kind === 'glyph').map((t) => (t.kind === 'glyph' ? t.glyph : ''))).toEqual([
      'arrow-up-left',
      'arrow-up-right',
      'arrow-down-left',
      'arrow-down-right',
      'arrow-right',
      'arrow-up',
      'arrow-down',
      'delta',
      'ge',
    ]);
    // Runs of spaces and line breaks collapse to one space; emoji become "?".
    expect(tokenize('a  \n b 🧶')).toEqual([{ kind: 'text', text: 'a' }, { kind: 'space' }, { kind: 'text', text: 'b' }, { kind: 'space' }, { kind: 'text', text: '?' }]);
  });
});

describe('layoutText: greedy rich-text line breaking', () => {
  it('fills lines up to the width and never splits a word that fits', () => {
    const text = 'Ch 1, turn. 6 sc A, 18 sc B, 6 sc A (30 sts) · carry A, B';
    for (const width of [40, 60, 90, 150, 400]) {
      const lines = layoutText([{ text }], base, mono, width);
      for (const l of lines) expect(l.width).toBeLessThanOrEqual(width + 1e-9);
      expect(lines.map((l) => l.pieces.map((p) => (p.kind === 'text' ? p.text : '←')).join('')).join(' ')).toBe(text);
    }
  });

  it('honors a narrower first line (hanging labels) and splits a word longer than a line', () => {
    const lines = layoutText([{ text: 'aaaa bbbb cccc' }], base, mono, 50, 25);
    expect(lines.map((l) => l.width)).toEqual([20, 45]);
    const long = layoutText([{ text: 'x'.repeat(23) }], base, mono, 50);
    expect(long.map((l) => l.width)).toEqual([50, 50, 15]);
  });

  it('keeps a glyph glued to its text and measures it in em', () => {
    const [line] = layoutText([{ text: 'Row 1 (RS) ←:' }], base, mono, 1000);
    const glyph = line.pieces.find((p) => p.kind === 'glyph');
    expect(glyph?.width).toBeCloseTo(GLYPH_WIDTH_EM['arrow-left'] * 10, 9);
    // "Row 1 (RS) " is one merged piece; the arrow follows at its end; ":" right after the arrow.
    expect(line.pieces.map((p) => (p.kind === 'text' ? p.text : p.glyph))).toEqual(['Row 1 (RS) ', 'arrow-left', ':']);
    expect(line.pieces[2].x).toBeCloseTo(line.pieces[1].x + line.pieces[1].width, 9);
    // A width that cannot hold "←:" plus the label wraps before the glyph's word, not inside it.
    const narrow = layoutText([{ text: 'Row 1 (RS) ←:' }], base, mono, 50);
    expect(narrow).toHaveLength(2);
    expect(narrow[1].pieces.map((p) => p.kind)).toEqual(['glyph', 'text']);
  });

  it('merges runs of one style and keeps style changes apart', () => {
    const [line] = layoutText([{ text: 'Row 1:', style: { style: 'bold' } }, { text: ' 5 sc A' }, { text: ' · carry B', style: { color: [9, 9, 9] } }], base, mono, 1000);
    expect(line.pieces.map((p) => (p.kind === 'text' ? p.text : ''))).toEqual(['Row 1:', '5 sc A', '· carry B']);
    expect(line.pieces[1].x).toBeCloseTo(6 * 6 + 5, 9);
    expect(line.width).toBeCloseTo(36 + 5 + 30 + 5 + 45, 9);
  });

  it('is empty for empty text', () => {
    expect(layoutText([{ text: '' }], base, mono, 100)).toEqual([]);
    expect(layoutText([{ text: '   ' }], base, mono, 100)).toEqual([]);
  });
});

describe('Markdown of renderPatternText (the subset a pattern uses)', () => {
  it('reads headings, one block per line, list items, rules and tables', () => {
    const md = ['# Heart', '', '## Instructions', 'Foundation: With A, ch 6.', 'Row 1 (RS) ←: 2 sc A (5 sts)', '- Row 2: sc A', '1. Weave in ends', '---', '| a | b |', '|---|---|', '| 1 | 2 \\| 3 |', 'Setext', '======'].join('\n');
    const blocks = parseMarkdown(md);
    expect(blocks.map((b) => b.kind)).toEqual(['heading', 'heading', 'paragraph', 'paragraph', 'item', 'item', 'rule', 'table', 'heading']);
    expect(blocks[0]).toMatchObject({ kind: 'heading', level: 1 });
    expect(blocks[4]).toMatchObject({ kind: 'item', ordered: false, depth: 0 });
    expect(blocks[5]).toMatchObject({ kind: 'item', ordered: true, marker: '1.' });
    const table = blocks[7];
    expect(table.kind === 'table' && table.rows[0].map(plainText)).toEqual(['1', '2 | 3']);
    expect(blocks[8]).toMatchObject({ kind: 'heading', level: 1 });
  });

  it('inline: bold, italic, code, links and escapes; a lone asterisk stays text', () => {
    expect(parseInline('**Row 1 (RS) ←:** 2 sc A')).toEqual([{ text: 'Row 1 (RS) ←:', style: { style: 'bold' } }, { text: ' 2 sc A' }]);
    expect(parseInline('*note* and `code` [link](http://x)')).toEqual([{ text: 'note', style: { style: 'italic' } }, { text: ' and code link' }]);
    expect(plainText(parseInline('*sc in next st, inc; rep from * 5 more times'))).toBe('*sc in next st, inc; rep from * 5 more times');
    expect(plainText(parseInline('2 \\* 3 and snake_case_name'))).toBe('2 * 3 and snake_case_name');
    expect(plainText(parseInline('a ** b'))).toBe('a ** b');
  });
});
