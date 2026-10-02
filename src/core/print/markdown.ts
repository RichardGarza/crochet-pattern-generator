// Track T8 — reads the Markdown that T2's `renderPatternText(doc, { format: 'md', … })` writes, into blocks the
// PDF lays out (DESIGN.md §5.2.1; integration-s2 task T8-3: the PDF prints pattern text through
// `renderPatternText`, never formatting it itself).
//
// Deliberately small and forgiving — only what a generated pattern uses: ATX headings, paragraphs, bullet and
// numbered list items, GFM tables, rules, **bold** / *italic* / `code`, links (their text) and backslash escapes.
// Every non-empty source line is its own block (a generated pattern puts one row per line; joining soft-wrapped
// lines into a paragraph, as CommonMark would, could merge two rows into one checkbox).
import type { Span, TextStyle } from './text';

export type MdBlock =
  | { kind: 'heading'; level: number; spans: Span[] }
  | { kind: 'paragraph'; spans: Span[] }
  | { kind: 'item'; ordered: boolean; marker: string; depth: number; spans: Span[]; task?: boolean }
  | { kind: 'table'; header: Span[][]; rows: Span[][][] }
  | { kind: 'rule' };

/** True when `mark` closes later in `src` (from `from`): preceded by a non-space, not part of a longer run. */
function hasCloser(src: string, from: number, mark: string): boolean {
  for (let j = src.indexOf(mark, from + 1); j >= 0; j = src.indexOf(mark, j + 1)) {
    if (src[j - 1] === '\\') continue;
    const before = src[j - 1];
    const after = src[j + mark.length];
    if (before === ' ' || before === '\t') continue;
    if (mark.length === 1 && after === mark) {
      j += 1;
      continue;
    }
    return true;
  }
  return false;
}

/** Inline Markdown → spans (bold, italic, code; links keep their text; escapes resolved). */
export function parseInline(src: string): Span[] {
  const spans: Span[] = [];
  let bold = false;
  let italic = false;
  let buf = '';
  const style = (): Partial<TextStyle> | undefined => (bold && italic ? { style: 'bolditalic' } : bold ? { style: 'bold' } : italic ? { style: 'italic' } : undefined);
  const flush = (): void => {
    if (!buf) return;
    const s = style();
    spans.push(s ? { text: buf, style: s } : { text: buf });
    buf = '';
  };
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!|>~<]/.test(src[i + 1])) {
      buf += src[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      if (end > i) {
        buf += src.slice(i + 1, end);
        i = end + 1;
        continue;
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]*)\]\([^)]*\)/.exec(src.slice(i));
      if (m) {
        buf += m[1];
        i += m[0].length;
        continue;
      }
    }
    if (c === '*' || c === '_') {
      const n = src[i + 1] === c ? 2 : 1;
      const mark = c.repeat(n);
      const prev = src[i - 1] ?? ' ';
      const next = src[i + n] ?? ' ';
      const intraword = c === '_' && /\w/.test(prev) && /\w/.test(next);
      const open = n === 2 ? bold : italic;
      // Emphasis needs a partner: an opener followed by a non-space with a closer (preceded by a non-space)
      // later; a closer preceded by a non-space. Anything else — "rep from * 5 more times" — is text.
      const closes = open && prev !== ' ' && prev !== '\t';
      const opens = !open && next !== ' ' && next !== '\t' && hasCloser(src, i + n, mark);
      if (!intraword && (opens || closes)) {
        flush();
        if (n === 2) bold = !bold;
        else italic = !italic;
        i += n;
        continue;
      }
      buf += mark;
      i += n;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return spans;
}

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function tableCells(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (s[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

/** Markdown → blocks. */
export function parseMarkdown(md: string): MdBlock[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: MdBlock[] = [];
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (/^\s*(```|~~~)/.test(line)) {
      fence = !fence;
      continue;
    }
    if (fence) {
      if (line.trim()) blocks.push({ kind: 'paragraph', spans: [{ text: line.trim() }] });
      continue;
    }
    if (!line.trim()) continue;
    const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      blocks.push({ kind: 'heading', level: heading[1].length, spans: parseInline(heading[2]) });
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ kind: 'rule' });
      continue;
    }
    // A line underlined with "===" is a heading. ("---" under a line is read as a rule, not CommonMark's level-2
    // heading: a row followed by a rule must stay a row.)
    const next = lines[i + 1]?.trim() ?? '';
    if (/^=+$/.test(next) && !/^\s*([-*+]|\d{1,3}[.)])\s/.test(line)) {
      blocks.push({ kind: 'heading', level: 1, spans: parseInline(line.trim()) });
      i++;
      continue;
    }
    if (line.includes('|') && TABLE_SEPARATOR.test(lines[i + 1] ?? '') && (lines[i + 1] ?? '').includes('-')) {
      const header = tableCells(line).map(parseInline);
      const rows: Span[][][] = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(tableCells(lines[i]).map(parseInline));
        i++;
      }
      i--;
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const item = /^(\s*)([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (item) {
      const depth = Math.floor(item[1].replace(/\t/g, '    ').length / 2);
      let body = item[3];
      let task: boolean | undefined;
      const box = /^\[( |x|X)\]\s+(.*)$/.exec(body);
      if (box) {
        task = true;
        body = box[2];
      }
      const ordered = /\d/.test(item[2]);
      blocks.push({ kind: 'item', ordered, marker: ordered ? item[2].replace(')', '.') : '•', depth, spans: parseInline(body), ...(task ? { task } : {}) });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    blocks.push({ kind: 'paragraph', spans: parseInline((quote ? quote[1] : line).trim()) });
  }
  return blocks;
}
