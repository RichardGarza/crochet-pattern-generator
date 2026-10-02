// Track T2.3 — renderPatternText (DESIGN.md §5.2.1, F8): the whole pattern as plain text and Markdown. The G9,
// G16 and G22 texts are in the golden file (UPDATE_GOLDEN=1 rewrites it; checked by hand against §2.7.3 and
// §2.7.10), and the exact §2.7.x lines are asserted here too, so a golden rewrite cannot hide a wrong line.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ChartGrid, Hand, PatternDoc, Technique2D } from '../../../types';
import { resolveGauge } from '../../gauge';
import { isImplemented } from '../../stub';
import { buildPattern2D } from '../../techniques';
import { chartOf, loadChartResult, randomChart, settingsOf } from '../../techniques/__tests__/fixtures';
import { mulberry32 } from '../../kernel/prng';
import { materialsText, mdEscape, renderPatternText } from '../text';

const g9 = loadChartResult('g9').grid;
const sc = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
const c2c = resolveGauge({ cyc: 4, technique: 'c2c' });

function build(chart: ChartGrid, o: { technique?: Technique2D; hand?: Hand; border?: { widthIn: number; code?: string }; title?: string; terms?: 'us' | 'uk' } = {}): PatternDoc {
  const technique = o.technique ?? 'sc_graphgan';
  const color = o.border?.code ? { hex: chart.palette.find((p) => p.code === o.border!.code)!.hex } : undefined;
  return buildPattern2D({
    chart,
    settings: settingsOf({ technique, hand: o.hand ?? 'right', border: { widthIn: o.border?.widthIn ?? 0, color } }),
    gauge: technique === 'c2c' ? c2c : resolveGauge({ cyc: 4, technique }),
    terms: o.terms ?? 'us',
    dialect: 'compact',
    title: o.title ?? 'G9',
  });
}

function g16(): PatternDoc {
  const labels = new Uint8Array(135 * 200);
  for (let i = 0; i < labels.length; i++) labels[i] = Math.floor(i / 135) % 20 < 10 ? 0 : 1;
  const grid: ChartGrid = { cols: 135, rows: 200, labels, palette: chartOf(['AB']).palette };
  return buildPattern2D({ chart: grid, settings: settingsOf({ border: { widthIn: 1, color: { hex: grid.palette[0].hex } } }), gauge: sc, terms: 'us', dialect: 'compact', title: 'G16' });
}

const lines = (text: string) => text.split('\n');

describe('renderPatternText (§5.2.1)', () => {
  it('is implemented', () => {
    expect(isImplemented(renderPatternText)).toBe(true);
  });

  it('G9 (RH, compact US): the §2.7.3 foundation and rows, in order, after the header and the lists', () => {
    const doc = build(g9);
    const text = renderPatternText(doc, { format: 'txt', terms: 'us', hand: 'right', dialect: 'compact' });
    const l = lines(text);
    expect(l[0]).toBe('G9');
    expect(l).toContain('Hook: 5 mm (H-8)');
    expect(l).toContain('Written for right-handed crocheters, in US terms.');
    const f = l.indexOf('Foundation: With A, ch 6.');
    expect(f).toBeGreaterThan(l.indexOf('PANEL'));
    expect(l[f + 1]).toBe('Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts) · join B (bobbin 1) · carry A');
    expect(l[f + 2]).toBe('Row 2 (WS) →: Ch 1, turn. sc A, 3 sc B, sc A (5 sts) · carry A');
    expect(l[f + 3]).toBe('Row 3 (RS) ←: Ch 1, turn. 4 sc A, sc B (5 sts)');
    expect(l[f + 5]).toBe('Fasten off and weave in ends.');
    // Section order (F8): materials, notes, abbreviations, the piece, finishing.
    const order = ['MATERIALS', 'NOTES', 'ABBREVIATIONS', 'PANEL', 'FINISHING'].map((h) => l.indexOf(h));
    expect(order.every((x) => x > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/\n{3}/);
  });

  it('G9 LH: the doc is written for the left hand and prints so; o.hand never mirrors the lines', () => {
    const doc = build(g9, { hand: 'left' });
    for (const hand of ['left', 'right'] as const) {
      const l = lines(renderPatternText(doc, { format: 'txt', terms: 'us', hand, dialect: 'compact' }));
      expect(l).toContain('Row 3 (RS) →: Ch 1, turn. sc B, 4 sc A (5 sts)');
      expect(l).toContain('Written for left-handed crocheters, in US terms.');
    }
  });

  it('UK and verbose: lines through the terminology table, free text converted, abbreviations listed again in UK terms', () => {
    const doc = build(g9);
    const text = renderPatternText(doc, { format: 'txt', terms: 'uk', hand: 'right', dialect: 'verbose' });
    expect(text).toContain('Row 1 (RS) ←: With A, dc in 2nd ch from hook and in next ch; change to B, dc in next ch; change to A, dc in last 2 ch. (5 dc) · join B (bobbin 1) · carry A');
    expect(text).toContain('Tension: 13.5 dc and 16 rows = 4" (10 cm)');
    expect(text).toContain('dc = double crochet');
    expect(text).not.toMatch(/\bsc\b/);
    expect(text).toContain('in UK terms');
  });

  it('G22: the four §2.7.10 border texts, each after its panel, with the hints and the finish', () => {
    const cases: [Hand, string, Technique2D, string][] = [
      ['right', 'B', 'sc_graphgan', 'Rnd 1 (RS): Do not turn; ch 1 (does not count), 3 sc in the last st made (top left corner); working down the row ends of the left side, 1 sc evenly spaced (about 1 sc per 3 row ends);'],
      ['left', 'A', 'sc_graphgan', 'Rnd 1 (RS): Do not turn; ch 1 (does not count), 3 sc in the last st made (top right corner); working down the row ends of the right side, 1 sc evenly spaced (about 1 sc per 3 row ends);'],
      ['right', 'A', 'sc_graphgan', 'Rnd 1 (RS): Fasten off. With RS facing, join A with a sl st in the top right corner st; ch 1 (does not count), 3 sc in same st (corner);'],
      ['right', 'A', 'c2c', 'Rnd 1 (RS): Fasten off. With RS facing, join A with a sl st in the outer corner of the top right tile; ch 1 (does not count), 3 sc in same sp (corner); working along the tile edges across the top, 11 sc evenly spaced (about 11 sc per 5 tile edges);'],
    ];
    for (const [hand, code, technique, start] of cases) {
      const doc = build(g9, { hand, technique, border: { widthIn: 0.25, code } });
      expect(doc.issues.filter((x) => x.severity === 'error')).toEqual([]);
      const l = lines(renderPatternText(doc, { format: 'txt', terms: 'us', hand, dialect: 'compact' }));
      const k = l.indexOf(`Border (with ${code}):`);
      expect(k, `${hand} ${code} ${technique}`).toBeGreaterThan(0);
      expect(l[k + 1].startsWith(start)).toBe(true);
      expect(l[k + 1].endsWith(technique === 'c2c' ? '(46 sts)' : '(20 sts)')).toBe(true);
      expect(l[k + 3]).toBe('Fasten off and weave in ends.');
    }
  });

  it('G16: Rnd 1 with the spacing hint, Rnds 2–4 folded into one line with every count', () => {
    const doc = g16();
    const l = lines(renderPatternText(doc, { format: 'txt', terms: 'us', hand: 'right', dialect: 'compact' }));
    const k = l.indexOf('Border (with A):');
    expect(l[k + 1]).toMatch(/^Rnd 1 \(RS\): Turn so the RS faces you; ch 1 \(does not count\), 3 sc in the last st made \(top right corner\); sc in each st across the top to the last st \(133 sc\);/);
    expect(l[k + 1]).toContain('working down the row ends of the left side, 167 sc evenly spaced (about 5 sc per 6 row ends)');
    expect(l[k + 2]).toBe('Rnds 2–4: Ch 1 (does not count), sc in same st as join and in each st around, working 3 sc in each corner center st; join with sl st in first sc. (620, 628, 636 sts)');
    expect(l).toContain('Finished size: 42 × 52 in (106.7 × 132.1 cm, ±12%)');
    // The vertical block repeat of the striped chart prints as a note under its last row.
    expect(l.some((x) => /^ {4}Rows \d+–\d+: rep Rows \d+–\d+/.test(x))).toBe(true);
  });

  it('Markdown: headings, list items, nested extras, escaped specials; same content as the text', () => {
    const doc = g16();
    const md = renderPatternText(doc, { format: 'md', terms: 'us', hand: 'right', dialect: 'compact' });
    const l = lines(md);
    expect(l[0]).toBe('# G16');
    expect(l).toContain('## Materials');
    expect(l).toContain('## Panel');
    expect(l).toContain('- Border (with A):');
    expect(l.some((x) => /^ {2}- Rows \d+–\d+: rep Rows/.test(x))).toBe(true);
    expect(mdEscape('a *b* [c] <d> _e_ `f` \\')).toBe('a \\*b\\* \\[c\\] \\<d\\> \\_e\\_ \\`f\\` \\\\');
    // Every line of the text version is in the Markdown version (unescaped).
    const txt = renderPatternText(doc, { format: 'txt', terms: 'us', hand: 'right', dialect: 'compact' });
    const unescape = (s: string) => s.replace(/\\([\\`*_[\]<>])/g, '$1');
    const mdLines = new Set(l.map((x) => unescape(x.replace(/^\s*(?:- |#+ |\d+\. )/, ''))));
    for (const line of lines(txt)) {
      if (line === '' || /^=+$/.test(line) || /^[A-Z ]+$/.test(line)) continue;
      expect(mdLines.has(line.trim().replace(/^- /, '')), line).toBe(true);
    }
  });

  it('the golden file of G9 (both hands, every dialect and terms, txt and md), G16 and G22 is unchanged', () => {
    const out: string[] = [];
    for (const hand of ['right', 'left'] as const) {
      const doc = build(g9, { hand });
      for (const terms of ['us', 'uk'] as const) {
        for (const dialect of ['compact', 'verbose'] as const) {
          out.push(`#### g9 ${hand} ${terms} ${dialect} txt`, renderPatternText(doc, { format: 'txt', terms, hand, dialect }));
        }
      }
      out.push(`#### g9 ${hand} us compact md`, renderPatternText(doc, { format: 'md', terms: 'us', hand, dialect: 'compact' }));
    }
    out.push('#### g16 txt', renderPatternText(g16(), { format: 'txt', terms: 'us', hand: 'right', dialect: 'compact' }));
    for (const [hand, code, technique] of [
      ['right', 'B', 'sc_graphgan'],
      ['left', 'A', 'sc_graphgan'],
      ['right', 'A', 'sc_graphgan'],
      ['right', 'A', 'c2c'],
    ] as const) {
      const doc = build(g9, { hand, technique, border: { widthIn: 0.25, code }, title: 'G22' });
      out.push(`#### g22 ${hand} ${code} ${technique} txt`, renderPatternText(doc, { format: 'txt', terms: 'us', hand, dialect: 'compact' }));
    }
    const text = out.join('\n');
    const path = fileURLToPath(new URL('./golden/patternText.txt', import.meta.url));
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(path, text);
    expect(text).toBe(readFileSync(path, 'utf8'));
  });

  it('materials lines: yarn source, yards with the range, meters, skeins, grams, bobbins', () => {
    const yarn = { id: 'rhss:319', lineId: 'red-heart-super-saver', brand: 'Red Heart', line: 'Super Saver', name: 'Cherry Red', number: '319', hex: '#a01e2c' };
    expect(materialsText({ code: 'A', hex: '#a01e2c', name: 'Cherry Red', yarn, stitches: 900, strands: 3, yards: 245.4, yardsLow: 196.2, yardsHigh: 294.6, meters: 224.4, skeins: 1, grams: 128.7 })).toBe(
      'A  Cherry Red (Red Heart Super Saver 319): 245 yd (196–295 yd), 224 m · 1 skein · 129 g · 3 bobbins',
    );
    expect(materialsText({ code: 'B', hex: '#ffffff', name: 'White', stitches: 10, strands: 1, yards: 2, yardsLow: 1.5, yardsHigh: 2.5, meters: 1.8 })).toBe('B  White: 2 yd (1.5–2.5 yd), 1.8 m');
  });

  it('never throws on built docs: random charts × techniques × hands × borders, both formats; an empty doc prints its header', () => {
    const rng = mulberry32(2303);
    for (let k = 0; k < 24; k++) {
      const chart = randomChart(rng, 1 + Math.floor(rng() * 20), 1 + Math.floor(rng() * 12), 1 + Math.floor(rng() * 4));
      const technique = (['sc_graphgan', 'sc_tapestry', 'sc_tapestry_round', 'c2c', 'hdc_graphgan'] as const)[k % 5];
      const hand = k % 2 === 0 ? 'right' : 'left';
      const doc = build(chart, { technique, hand, border: { widthIn: k % 3 === 0 ? 0.5 : 0 }, terms: k % 4 === 0 ? 'uk' : 'us' });
      for (const format of ['txt', 'md'] as const) {
        for (const terms of ['us', 'uk'] as const) {
          const text = renderPatternText(doc, { format, terms, hand, dialect: k % 2 === 0 ? 'compact' : 'verbose' });
          expect(text.length).toBeGreaterThan(50);
          // Every worked line of the piece is printed (rows / rounds / C2C rows / border rounds).
          const printed = text.split('\n').filter((x) => /^(?:- )?(?:[↙↗↖↘] )?(?:Row|Rows|Rnd|Rnds) \d/.test(x)).length;
          expect(printed).toBeGreaterThan(0);
        }
      }
    }
    const empty = buildPattern2D({ chart: { cols: 0, rows: 0, labels: new Uint8Array(0), palette: [] }, settings: settingsOf(), gauge: sc, terms: 'us', dialect: 'compact', title: 'Empty' });
    expect(renderPatternText(empty, { format: 'txt', terms: 'us', hand: 'right', dialect: 'compact' })).toMatch(/^Empty\n=====\n/);
  });
});
