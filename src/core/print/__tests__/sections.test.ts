import { describe, expect, it } from 'vitest';
import type { MaterialsLine, PatternDoc } from '../../../types';
import { resolveGauge } from '../../gauge';
import { renderFoundation, renderLine, renderLineExtras } from '../../pattern/render';
import { renderPatternText } from '../../pattern/text';
import { isImplemented } from '../../stub';
import { buildPattern2D } from '../../techniques/index';
import { loadChartResult, settingsOf } from '../../techniques/__tests__/fixtures';
import {
  CUE_COLOR,
  SECTION_ORDER,
  borderRounds,
  finishedSizeText,
  formatCm,
  formatInches,
  hookText,
  instructionBlocks,
  lineRendererMarkdown,
  materialRows,
  materialTotals,
  muteCues,
  patternText,
  splitStep,
  techniqueLabel,
} from '../sections';
import { assignSymbols, inkFor, labelCounts, SHAPES } from '../symbols';
import { plainText } from '../text';

function g9Doc(o: { border?: number; hand?: 'right' | 'left'; terms?: 'us' | 'uk' } = {}): PatternDoc {
  const gauge = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
  return buildPattern2D({ chart: loadChartResult('g9').grid, settings: settingsOf({ hand: o.hand ?? 'right', border: { widthIn: o.border ?? 0 } }), gauge, terms: o.terms ?? 'us', dialect: 'compact', title: 'G9' });
}

describe('cover and materials text (§2.8)', () => {
  it('finished size: inches to ¼ with fraction characters, cm to 0.5', () => {
    expect(formatInches(9.888)).toBe('10"');
    expect(formatInches(9.62)).toBe('9½"');
    expect(formatInches(7.13)).toBe('7¼"');
    expect(formatInches(0.74)).toBe('¾"');
    expect(formatInches(0.1)).toBe('0"');
    expect(formatCm(9.888)).toBe('25 cm');
    expect(formatCm(9.65)).toBe('24.5 cm');
    expect(finishedSizeText({ wIn: 9.888, hIn: 7, tolPct: 12 })).toBe('Approx 10" (25 cm) wide × 7" (18 cm) tall');
    expect(finishedSizeText({ wIn: 4, hIn: 6, dIn: 3, tolPct: 20 })).toBe('Approx 4" (10 cm) wide × 6" (15 cm) tall × 3" (7.5 cm) deep');
  });

  it('hook line: mm, US size, "or the size needed to obtain gauge"', () => {
    expect(hookText({ mm: 5, us: 'H-8' })).toBe('5 mm (US H-8), or the size needed to obtain gauge');
    expect(hookText({ mm: 3.75 })).toBe('3.75 mm, or the size needed to obtain gauge');
  });

  it('technique names follow the terms (UK sc = dc)', () => {
    expect(techniqueLabel('sc_graphgan', 'us')).toBe('Single crochet graphgan');
    expect(techniqueLabel('sc_graphgan', 'uk')).toBe('Double crochet graphgan');
    expect(techniqueLabel('hdc_graphgan', 'uk')).toBe('Half treble crochet graphgan');
    expect(techniqueLabel('c2c', 'us')).toBe('Corner to corner (C2C)');
  });

  it('materials rows: whole yards with a range, share, bobbins, skeins and grams only when known', () => {
    const m = (over: Partial<MaterialsLine>): MaterialsLine => ({ code: 'A', hex: '#ffffff', name: 'White', stitches: 1000, strands: 2, yards: 61.9, yardsLow: 46.4, yardsHigh: 77.4, meters: 56.6, ...over });
    const yarn = { id: 'y', lineId: 'l', brand: 'Red Heart', line: 'Super Saver', name: 'Cherry Red', number: '319', hex: '#c8323c', skeinYards: 364 };
    const rows = materialRows({ materials: [m({}), m({ code: 'B', stitches: 2, yards: 0.4, yardsLow: 0.3, yardsHigh: 0.5, meters: 0.4, yarn, deltaE00: 1.84, skeins: 1, grams: 35.2 })] });
    expect(rows[0]).toMatchObject({ code: 'A', yarn: 'White', yarnDetail: null, match: null, stitches: '1,000', share: '100%', strands: '2', yards: '62 yd', yardRange: '46–78', meters: '57 m', skeins: '—', grams: '—' });
    expect(rows[1]).toMatchObject({ yarn: 'Red Heart Super Saver', yarnDetail: 'Cherry Red (319)', match: 'ΔE 1.8', share: '<1%', yards: '1 yd', yardRange: '', skeins: '1', grams: '35 g (to 44)' });
    expect(materialTotals({ materials: [m({}), m({ yards: 0.4, yardsLow: 0.3, yardsHigh: 0.5, meters: 0.4 })] })).toEqual({ stitches: '2,000', yards: '62 yd', yardRange: '46–78', meters: '57 m' });
  });

  it('the sections in F8 order', () => {
    expect(SECTION_ORDER).toEqual(['cover', 'materials', 'gauge', 'notes', 'abbreviations', 'chart', 'instructions']);
  });
});

describe('chart symbols for black-and-white printing', () => {
  it('the most-used color is blank; the others get distinct shapes in palette order; then their codes', () => {
    const palette = Array.from({ length: 24 }, (_, i) => ({ code: String.fromCharCode(65 + i), hex: `#${(i * 10).toString(16).padStart(2, '0')}8040`, name: `C${i}` }));
    const labels = new Uint8Array(100);
    labels.fill(3);
    for (let i = 0; i < 24; i++) labels[i] = i;
    const symbols = assignSymbols({ cols: 10, rows: 10, labels, palette });
    expect(symbols[3].symbol).toEqual({ kind: 'shape', shape: 'blank' });
    const shapes = symbols.filter((s) => s.symbol.kind === 'shape' && s.symbol.shape !== 'blank').map((s) => (s.symbol.kind === 'shape' ? s.symbol.shape : ''));
    expect(shapes).toEqual(SHAPES.slice(0, 20));
    expect(new Set(shapes).size).toBe(20);
    expect(symbols.slice(21).map((s) => s.symbol)).toEqual([
      { kind: 'text', text: 'V' },
      { kind: 'text', text: 'W' },
      { kind: 'text', text: 'X' },
    ]);
    expect(labelCounts({ cols: 10, rows: 10, labels, palette })[3]).toBe(77);
  });

  it('a one-color chart is all blank; ties go to the lowest label', () => {
    expect(assignSymbols({ cols: 2, rows: 1, labels: new Uint8Array([0, 0]), palette: [{ code: 'A', hex: '#ffffff', name: 'A' }] })[0].symbol).toEqual({ kind: 'shape', shape: 'blank' });
    const tie = assignSymbols({ cols: 2, rows: 1, labels: new Uint8Array([0, 1]), palette: [{ code: 'A', hex: '#ffffff', name: 'A' }, { code: 'B', hex: '#000000', name: 'B' }] });
    expect(tie.map((s) => s.symbol)).toEqual([{ kind: 'shape', shape: 'blank' }, { kind: 'shape', shape: 'dot' }]);
  });

  it('symbol ink contrasts with the yarn color', () => {
    expect(inkFor('#ffffff')).toBe('#000000');
    expect(inkFor('#f4efe6')).toBe('#000000');
    expect(inkFor('#000000')).toBe('#ffffff');
    expect(inkFor('#3a2a2a')).toBe('#ffffff');
    expect(inkFor('#c8323c')).toBe('#ffffff');
    expect(inkFor('#ffd400')).toBe('#000000');
    expect(inkFor('not a color')).toBe('#000000');
  });
});

describe('the written instructions', () => {
  it('splitStep: the label through the first colon is bold; muteCues: everything from " · " is muted', () => {
    const { label, body } = splitStep([{ text: 'Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A (5 sts) · join B (bobbin 1) · carry A' }]);
    expect(plainText(label)).toBe('Row 1 (RS) ←:');
    expect(label.every((s) => s.style?.style === 'bold')).toBe(true);
    const muted = muteCues(body);
    expect(plainText(muted)).toBe('Starting in 2nd ch from hook, 2 sc A (5 sts) · join B (bobbin 1) · carry A');
    expect(muted.map((s) => [s.text, s.style?.color ?? null])).toEqual([
      ['Starting in 2nd ch from hook, 2 sc A (5 sts)', null],
      [' · join B (bobbin 1) · carry A', CUE_COLOR],
    ]);
  });

  it('instructionBlocks: front matter left out (the cover prints it), rows and rounds become checkbox steps', () => {
    // A pattern as renderPatternText might write it (its exact layout is T2's; T8 only needs headings and lines).
    const md = [
      '# Heart',
      '',
      'Skill level: Easy',
      '',
      '## Materials',
      '- Cream, 38 yd',
      '### Hook',
      '5 mm',
      '## Gauge',
      '13.5 sc and 16 rows = 4" (10 cm)',
      '## Abbreviations',
      '- **ch** chain',
      '## Notes',
      '- Each square = 1 sc.',
      '## Instructions',
      '',
      'Foundation: With A, ch 6.',
      '',
      '**Row 1 (RS) ←:** Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts) · join B (bobbin 1) · carry A',
      '- Rows 2–3 (2 rows): Ch 1, turn. sc A, 3 sc B, sc A (5 sts)',
      '### Border',
      'Rnd 1 (RS): Turn; ch 1 … (20 sts)',
      'Fasten off and weave in ends.',
      '## Finishing',
      '- Block to the finished size.',
    ].join('\n');
    const blocks = instructionBlocks(md, 'Heart');
    expect(blocks.map((b) => (b.kind === 'heading' ? `h${b.level}:${plainText(b.text)}` : b.kind === 'step' ? `step:${plainText(b.label)}` : b.kind === 'text' ? `text:${plainText(b.spans)}` : b.kind))).toEqual([
      'h2:Instructions',
      'step:Foundation:',
      'step:Row 1 (RS) ←:',
      'step:Rows 2–3 (2 rows):',
      'h3:Border',
      'step:Rnd 1 (RS):',
      'text:Fasten off and weave in ends.',
      'h2:Finishing',
      'text:Block to the finished size.',
    ]);
  });

  it('a pattern without headings keeps its rows; a title-only preamble is dropped', () => {
    expect(instructionBlocks('Row 1: 5 sc A\nRow 2: 5 sc B', 'X').map((b) => b.kind)).toEqual(['step', 'step']);
    expect(instructionBlocks('# X\nby me\n## Pattern\nRow 1: 5 sc A', 'X').map((b) => b.kind)).toEqual(['heading', 'step']);
  });

  it('the line-renderer text is T2’s own lines, in order (G9 with a border, RH and LH)', () => {
    for (const hand of ['right', 'left'] as const) {
      const doc = g9Doc({ border: 0.25, hand });
      const md = lineRendererMarkdown(doc);
      const steps = instructionBlocks(md, doc.title).filter((b) => b.kind === 'step');
      const lines = doc.pieces[0].lines;
      // Foundation, three rows, the border rounds — one checkbox each.
      const foundations = lines.map((l) => renderFoundation(l, { terms: doc.terms, docKind: '2d' })).filter((f): f is string => !!f && !/border/i.test(f));
      expect(steps).toHaveLength(foundations.length + lines.length + lines.flatMap((l) => renderLineExtras(l, { terms: doc.terms })).filter((e) => /^(rows?|rnds?)\s/i.test(e)).length);
      const text = steps.map((s) => `${plainText(s.kind === 'step' ? s.label : [])} ${plainText(s.kind === 'step' ? s.body : [])}`);
      for (const l of lines) expect(text).toContain(renderLine(l, { dialect: doc.dialect, terms: doc.terms, hand: doc.hand, docKind: '2d' }));
      expect(borderRounds(doc)).toBe(lines.filter((l) => l.kind === 'border').length);
    }
    // The §2.7.3 golden rows (with their default cues) are in the RH text.
    const md = lineRendererMarkdown(g9Doc());
    expect(md).toContain('Foundation: With A, ch 6.');
    expect(md).toContain('Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts) · join B (bobbin 1) · carry A');
    expect(md).toContain('Row 3 (RS) ←: Ch 1, turn. 4 sc A, sc B (5 sts)');
  });

  it.runIf(!isImplemented(renderPatternText))('while renderPatternText is a stub, the PDF text comes from T2’s line renderers', () => {
    const t = patternText(g9Doc());
    expect(t.source).toBe('line-renderers');
    expect(t.reason).toMatch(/not implemented/);
  });

  it.runIf(isImplemented(renderPatternText))('the PDF text is renderPatternText’s Markdown (doc terms, hand, dialect)', () => {
    for (const o of [{}, { hand: 'left' as const, border: 0.25 }, { terms: 'uk' as const }]) {
      const doc = g9Doc(o);
      const t = patternText(doc);
      expect(t.source).toBe('renderPatternText');
      expect(t.md).toBe(renderPatternText(doc, { format: 'md', terms: doc.terms, hand: doc.hand, dialect: doc.dialect }));
      // Every row of the pattern is a checkbox step.
      const steps = instructionBlocks(t.md, doc.title).filter((b) => b.kind === 'step');
      expect(steps.length).toBeGreaterThanOrEqual(doc.pieces[0].lines.length);
    }
  });
});
