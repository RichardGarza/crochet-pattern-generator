import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChartGrid, Hand, Line, Op } from '../../../types';
import { mulberry32 } from '../../kernel/prng';
import { parseBody } from '../../pattern/__tests__/helpers';
import { renderFoundation, renderLine, renderLineWith } from '../../pattern/render';
import { renderWordChartLine } from '../../pattern/wordchart';
import { directionIndependent, flatFoundation, flatRowOps, foldRows, writeFlatRows, writeScGraphgan } from '../scFlat';
import { validate2D } from '../validate2d';
import { chartOf, loadChartResult, randomChart } from './fixtures';

const g9 = loadChartResult('g9').grid;
const compact = (line: Line): string => renderLine(line, { dialect: 'compact', terms: 'us', hand: 'right' });

describe('sc_graphgan writer (DESIGN §2.7.3)', () => {
  it('G9 golden, right-handed: the §2.7.3 rows exactly (bare rows, cues off)', () => {
    const { lines } = writeScGraphgan(g9, { hand: 'right', cues: false });
    expect(renderFoundation(lines[0], { terms: 'us' })).toBe('Foundation: With A, ch 6.');
    expect(lines.map(compact)).toEqual([
      'Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts)',
      'Row 2 (WS) →: Ch 1, turn. sc A, 3 sc B, sc A (5 sts)',
      'Row 3 (RS) ←: Ch 1, turn. 4 sc A, sc B (5 sts)',
    ]);
  });

  it('G9 golden, left-handed: LH Row 3 (RS) →: Ch 1, turn. sc B, 4 sc A (5 sts)', () => {
    const { lines } = writeScGraphgan(g9, { hand: 'left', cues: false });
    expect(`LH ${compact(lines[2])}`).toBe('LH Row 3 (RS) →: Ch 1, turn. sc B, 4 sc A (5 sts)');
    // LH mirrors the reading order, never the chart: Row 1 is a palindrome, Row 2 too.
    expect(lines.map(compact)).toEqual([
      'Row 1 (RS) →: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts)',
      'Row 2 (WS) ←: Ch 1, turn. sc A, 3 sc B, sc A (5 sts)',
      'Row 3 (RS) →: Ch 1, turn. sc B, 4 sc A (5 sts)',
    ]);
    expect(renderFoundation(lines[0], { terms: 'us' })).toBe('Foundation: With A, ch 6.');
  });

  it('research 07 §7.6 vector 21: graph W = 5, Row 3 RH `4 sc A, 1 sc B` vs LH `1 sc B, 4 sc A`', () => {
    const rh = writeScGraphgan(g9, { hand: 'right' }).rows[2];
    const lh = writeScGraphgan(g9, { hand: 'left' }).rows[2];
    expect(rh.ops).toEqual(parseBody('4 sc A, sc B'));
    expect(lh.ops).toEqual(parseBody('sc B, 4 sc A'));
    expect([rh.stated, lh.stated]).toEqual([5, 5]);
    expect(renderWordChartLine(rh)).toBe('3 ← | 4A 1B | 5');
    expect(renderWordChartLine(lh)).toBe('3 → | 1B 4A | 5');
  });

  it('G9 with the strand cues (the default): Row 1 joins B, Rows 1–2 carry A across B', () => {
    const { lines, plan } = writeScGraphgan(g9, { hand: 'right' });
    expect(lines.map(compact)).toEqual([
      'Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts) · join B (bobbin 1) · carry A',
      'Row 2 (WS) →: Ch 1, turn. sc A, 3 sc B, sc A (5 sts) · carry A',
      'Row 3 (RS) ←: Ch 1, turn. 4 sc A, sc B (5 sts)',
    ]);
    expect(plan.strandsPerColor).toEqual([1, 1]);
    expect(plan.strands).toBe(2);
  });

  it('G9 in every dialect and both terms (UK: sc → dc)', () => {
    const { lines } = writeScGraphgan(g9, { hand: 'right' });
    const uk = lines.map((line) => renderLine(line, { dialect: 'compact', terms: 'uk', hand: 'right' }));
    expect(uk[0]).toBe('Row 1 (RS) ←: Starting in 2nd ch from hook, 2 dc A, dc B, 2 dc A (5 sts) · join B (bobbin 1) · carry A');
    const verbose = lines.map((line) => renderLine(line, { dialect: 'verbose', terms: 'us', hand: 'right' }));
    expect(verbose).toEqual([
      'Row 1 (RS): With A, sc in 2nd ch from hook and in next ch; change to B, sc in next ch; change to A, sc in last 2 ch. (5 sc) · join B (bobbin 1) · carry A',
      'Row 2 (WS): Ch 1, turn. With A, sc in first st; change to B, sc in next 3 sts; change to A, sc in last st. (5 sc) · carry A',
      'Row 3 (RS): Ch 1, turn. With A, sc in first 4 sts; change to B, sc in last st. (5 sc)',
    ]);
    expect(renderLine(lines[2], { dialect: 'verbose', terms: 'uk', hand: 'right' })).toBe(
      'Row 3 (RS): Ch 1, turn. With A, dc in first 4 sts; change to B, dc in last st. (5 dc)',
    );
  });

  it('the golden file of the whole G9 and heart charts is unchanged (UPDATE_GOLDEN=1 rewrites it)', () => {
    const out: string[] = [];
    for (const [name, grid] of [
      ['g9', g9],
      ['heart', loadChartResult('heart').grid],
    ] as const) {
      for (const hand of ['right', 'left'] as const) {
        const { lines } = writeScGraphgan(grid, { hand });
        out.push(`# ${name} ${hand}`);
        out.push(renderFoundation(lines[0], { terms: 'us' }) ?? '');
        for (const dialect of ['compact', 'verbose'] as const) {
          for (const terms of ['us', 'uk'] as const) {
            if (name === 'heart' && (terms === 'uk' || hand === 'left') && dialect === 'verbose') continue;
            out.push(`## ${dialect} ${terms}`);
            for (const line of lines) out.push(renderLine(line, { dialect, terms, hand }));
          }
        }
        out.push('## word chart');
        for (const line of lines) out.push(renderWordChartLine(line));
      }
    }
    const text = `${out.join('\n')}\n`;
    const path = fileURLToPath(new URL('./golden/flatGraph.txt', import.meta.url));
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(path, text);
    expect(text).toBe(readFileSync(path, 'utf8'));
  });

  it('every line passes the Step 0 line validator and the 2D validators (G9, heart; both hands)', () => {
    for (const grid of [g9, loadChartResult('heart').grid]) {
      for (const hand of ['right', 'left'] as const) {
        const { lines, plan } = writeScGraphgan(grid, { hand });
        const errors = validate2D({ chart: grid, technique: 'sc_graphgan', hand, lines, plan }).filter((x) => x.severity === 'error');
        expect(errors).toEqual([]);
      }
    }
  });

  it('the foundation colour is the colour of Row 1’s first run in working order (§2.7.2)', () => {
    const chart = chartOf(['AAAA', 'BAAC']);
    expect(renderFoundation(writeScGraphgan(chart, { hand: 'right' }).lines[0], { terms: 'us' })).toBe('Foundation: With C, ch 5.');
    expect(renderFoundation(writeScGraphgan(chart, { hand: 'left' }).lines[0], { terms: 'us' })).toBe('Foundation: With B, ch 5.');
  });

  it('a one-colour chart prints `40 sc A` rows and folds them (Rows 2–n)', () => {
    const chart = chartOf(Array.from({ length: 6 }, () => 'A'.repeat(40)));
    const { lines } = writeScGraphgan(chart, { hand: 'right' });
    expect(lines.map(compact)).toEqual([
      'Row 1 (RS) ←: Starting in 2nd ch from hook, 40 sc A (40 sts)',
      'Rows 2–6 (5 rows): Ch 1, turn. 40 sc A (40 sts)',
    ]);
    expect(renderLine(lines[1], { dialect: 'verbose', terms: 'us', hand: 'right' })).toBe('Rows 2–6 (5 rows): Ch 1, turn. With A, sc in each st across. (40 sc)');
    expect(renderLine(lines[0], { dialect: 'verbose', terms: 'us', hand: 'right' })).toBe(
      'Row 1 (RS): With A, sc in 2nd ch from hook and in each ch across. (40 sc)',
    );
    expect(renderWordChartLine(lines[1])).toBe('2–6 | 40A | 40');
  });

  it('folds only rows that read the same both ways and carry the same cues (§2.6.2)', () => {
    // Palindromes fold; identical non-palindromic chart rows read reversed on alternate rows and never fold;
    // mirrored rows read the same ops but are not direction-independent, so they do not fold either.
    const pal = writeScGraphgan(chartOf(['AABAA', 'AABAA', 'AABAA', 'AABAA', 'AABAA']), { hand: 'right' }).lines;
    expect(pal.map(compact)).toEqual([
      'Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts) · join B (bobbin 1) · carry A',
      'Rows 2–5 (4 rows): Ch 1, turn. 2 sc A, sc B, 2 sc A (5 sts) · carry A',
    ]);
    const same = writeScGraphgan(chartOf(['AAB', 'AAB', 'AAB', 'AAB']), { hand: 'right' }).lines;
    expect(same.map((line) => line.nEnd)).toEqual([undefined, undefined, undefined, undefined]);
    const mirrored = writeScGraphgan(chartOf(['BAA', 'AAB', 'BAA', 'AAB']), { hand: 'right' }).lines;
    expect(mirrored).toHaveLength(4);
    expect(mirrored[1].ops).toEqual(mirrored[2].ops);
    expect(directionIndependent(mirrored[1].ops)).toBe(false);
    // Different cues stop a fold: Rows 2 and 3 read the same, but Row 2 joins B (worked rows from the bottom).
    const cues = writeScGraphgan(chartOf(['AAAAA', 'AAAAA', 'AABAA', 'AABAA', 'AAAAA']), { hand: 'right' }).lines;
    expect(cues.map((line) => [line.n, line.nEnd ?? line.n])).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 5],
    ]);
    expect(cues.map(compact).slice(1, 3)).toEqual([
      'Row 2 (WS) →: Ch 1, turn. 2 sc A, sc B, 2 sc A (5 sts) · join B (bobbin 1) · carry A',
      'Row 3 (RS) ←: Ch 1, turn. 2 sc A, sc B, 2 sc A (5 sts) · carry A',
    ]);
    expect(writeScGraphgan(chartOf(['AAAAA', 'AAAAA', 'AAAAA']), { hand: 'right', fold: false }).lines).toHaveLength(3);
  });

  it('foldRows never folds across a loop, a note, a header, a start or a gap in the numbers (§2.6.2)', () => {
    const base = writeScGraphgan(chartOf(['AAA', 'AAA', 'AAA']), { hand: 'right', fold: false }).rows;
    const variants: ((line: Line) => Line)[] = [
      (line) => ({ ...line, ops: line.ops.map((op) => ({ ...op, loop: 'BLO' as const })) }),
      (line) => ({ ...line, notes: ['Place a marker here.'] }),
      (line) => ({ ...line, colorHeader: 'B' }),
      (line) => ({ ...line, start: { k: 'turn', chains: 2 } }),
      (line) => ({ ...line, n: 5 }),
    ];
    for (const change of variants) expect(foldRows([base[0], base[1], change(base[2])])).toHaveLength(3);
    expect(foldRows(base)).toHaveLength(2);
  });

  it('foldRows keeps Row 1 apart and drops side and arrow on a fold', () => {
    const rows = writeScGraphgan(chartOf(['AAA', 'AAA', 'AAA']), { hand: 'right', fold: false }).rows;
    const folded = foldRows(rows);
    expect(folded).toHaveLength(2);
    expect(folded[0]).toBe(rows[0]);
    expect(folded[1]).toMatchObject({ n: 2, nEnd: 3 });
    expect(folded[1].side).toBeUndefined();
    expect(folded[1].arrow).toBeUndefined();
  });

  it('hdc rows (§2.7.7): foundation W + 2 from the 3rd ch, Ch 2 turning chain that does not count', () => {
    expect(flatFoundation(5, 'hdc')).toEqual({ chains: 7, firstInto: 3 });
    expect(flatFoundation(5, 'sc')).toEqual({ chains: 6, firstInto: 2 });
    const { lines } = writeFlatRows(g9, { hand: 'right', stitch: 'hdc', cues: false });
    expect(renderFoundation(lines[0], { terms: 'us' })).toBe('Foundation: With A, ch 7.');
    expect(lines.map(compact)).toEqual([
      'Row 1 (RS) ←: Starting in 3rd ch from hook, 2 hdc A, hdc B, 2 hdc A (5 sts)',
      'Row 2 (WS) →: Ch 2 (does not count as a st), turn. hdc A, 3 hdc B, hdc A (5 sts)',
      'Row 3 (RS) ←: Ch 2 (does not count as a st), turn. 4 hdc A, hdc B (5 sts)',
    ]);
    expect(renderLine(lines[0], { dialect: 'verbose', terms: 'uk', hand: 'right' })).toBe(
      'Row 1 (RS): With A, htr in 3rd ch from hook and in next ch; change to B, htr in next ch; change to A, htr in last 2 ch. (5 htr)',
    );
    expect(validate2D({ chart: g9, technique: 'hdc_graphgan', hand: 'right', lines }).filter((x) => x.severity === 'error')).toEqual([]);
  });

  it('a 1 × 1 chart and a single-row chart', () => {
    const one = writeScGraphgan(chartOf(['B']), { hand: 'right' }).lines;
    expect(one.map(compact)).toEqual(['Row 1 (RS) ←: Starting in 2nd ch from hook, sc B (1 st)']);
    expect(renderFoundation(one[0], { terms: 'us' })).toBe('Foundation: With B, ch 2.');
    expect(renderLine(one[0], { dialect: 'verbose', terms: 'us', hand: 'right' })).toBe('Row 1 (RS): With B, sc in 2nd ch from hook and in each ch across. (1 sc)');
    expect(validate2D({ chart: chartOf(['B']), technique: 'sc_graphgan', hand: 'right', lines: one }).filter((x) => x.severity === 'error')).toEqual([]);
  });
});

// ---- Read-back: the printed text is the chart

/** Parses a verbose 2D row body (between the label and the count) back into its colours, in order. */
function parseVerboseRow(body: string): string[] {
  const out: string[] = [];
  const state = { color: '' };
  const pieces = splitTop(body);
  for (const piece of pieces) parsePiece(piece, state, out);
  return out;
}

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '[') depth++;
    if (ch === ']') depth--;
    if (depth === 0 && (text.startsWith(', ', i) || text.startsWith('; ', i))) {
      parts.push(current);
      current = '';
      i++;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.filter((part) => part !== '');
}

function parsePiece(piece: string, state: { color: string }, out: string[]): void {
  let m: RegExpExecArray | null;
  if ((m = /^\[(.*)\] (\d+) times$/.exec(piece)) !== null) {
    const inner: string[] = [];
    for (const part of splitTop(m[1])) parsePiece(part, state, inner);
    for (let t = 0; t < Number(m[2]); t++) out.push(...inner);
    return;
  }
  if ((m = /^(?:with|change to) (\S+)$/i.exec(piece)) !== null) {
    state.color = m[1];
    return;
  }
  if (/^starting in 2nd ch from hook$/i.test(piece)) return;
  if ((m = /^sc in 2nd ch from hook(?: and in next (?:(\d+) )?ch)?$/i.exec(piece)) !== null) {
    const n = piece.includes(' and in next ') ? 1 + (m[1] === undefined ? 1 : Number(m[1])) : 1;
    for (let i = 0; i < n; i++) out.push(state.color);
    return;
  }
  if ((m = /^sc in (?:first|next|last) (?:(\d+) )?(?:sts?|ch)$/i.exec(piece)) !== null) {
    const n = m[1] === undefined ? 1 : Number(m[1]);
    for (let i = 0; i < n; i++) out.push(state.color);
    return;
  }
  throw new Error(`cannot read “${piece}”`);
}

function colorsOf(ops: readonly Op[]): string[] {
  return ops.map((op) => op.color ?? '');
}

function chartRowColors(grid: ChartGrid, k: number, hand: Hand): string[] {
  return colorsOf(flatRowOps(grid, k, hand));
}

describe('read-back: the printed rows are the chart (random charts, both hands)', () => {
  it('compact and verbose text read back to the chart cell by cell; no E_* anywhere', { timeout: 60_000 }, () => {
    const rng = mulberry32(2101);
    let rowsChecked = 0;
    for (let trial = 0; trial < 120; trial++) {
      const cols = 1 + Math.floor(rng() * 40);
      const rowsN = 1 + Math.floor(rng() * 14);
      const colors = 1 + Math.floor(rng() * 6);
      const grid = randomChart(rng, cols, rowsN, colors);
      for (const hand of ['right', 'left'] as const) {
        const { lines, plan } = writeScGraphgan(grid, { hand });
        expect(validate2D({ chart: grid, technique: 'sc_graphgan', hand, lines, plan }).filter((x) => x.severity === 'error')).toEqual([]);
        for (const line of lines) {
          const text = renderLineWith(line, { dialect: 'compact', terms: 'us', hand, docKind: '2d' });
          const body = text.slice(text.indexOf(': ') + 2).replace(/ \(\d+ sts?\)( · .*)?$/, '');
          const opsText = body.replace(/^Starting in 2nd ch from hook, /, '').replace(/^Ch 1, turn\. /, '');
          const parsed = colorsOf(parseBody(opsText));
          const verbose = renderLineWith(line, { dialect: 'verbose', terms: 'us', hand, docKind: '2d' });
          const vBody = verbose
            .slice(verbose.indexOf(': ') + 2)
            .replace(/\. \(\d+ sc\)( · .*)?$/, '')
            .replace(/^Ch 1, turn\. /, '');
          const vParsed = parseVerboseRow(vBody.replace(/in each (st|ch) across$/, (_m, what: string) => `in first ${grid.cols} ${what === 'st' ? 'sts' : 'ch'}`).replace(/ and in first (\d+) ch$/, (_m, n: string) => ` and in next ${Number(n) - 1} ch`));
          for (let k = line.n; k <= (line.nEnd ?? line.n); k++) {
            const want = chartRowColors(grid, k, hand);
            expect(parsed).toEqual(want);
            expect(vParsed).toEqual(want);
            rowsChecked++;
          }
        }
      }
    }
    expect(rowsChecked).toBeGreaterThan(1000);
  });
});
