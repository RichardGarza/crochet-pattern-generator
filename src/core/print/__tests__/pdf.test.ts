// The pattern PDF (DESIGN.md §1.3 F8, §6.3 T8 acceptance): `%PDF`, the expected page count for the G9 pattern and
// a 120 × 150 chart, section order, blocked exports, determinism, the 200 × 200 budget (§5.8).
import { describe, expect, it } from 'vitest';
import type { PatternDoc, Technique2D } from '../../../types';
import { PERF, budget } from '../../../test/timing';
import { resolveGauge } from '../../gauge';
import { mulberry32 } from '../../kernel/prng';
import { renderLine } from '../../pattern/render';
import { renderPatternText } from '../../pattern/text';
import { isImplemented } from '../../stub';
import { buildPattern2D } from '../../techniques/index';
import { loadChartResult, randomChart, settingsOf } from '../../techniques/__tests__/fixtures';
import { cellsPerPage, printedCell, tileSpans } from '../chartPages';
import { FIXED_CREATION_DATE, PdfBlockedError, buildPatternPdf, buildPdf, isPdfBlocked, preflightPdf } from '../pdf';
import { SECTION_ORDER, SECTION_TITLES, instructionBlocks, patternText } from '../sections';
import { plainText } from '../text';
import { inspectBlob, inspectPdf } from './pdfInspect';

function docOf(chart: ReturnType<typeof loadChartResult>['grid'], o: { technique?: Technique2D; border?: number; title?: string; hand?: 'right' | 'left'; terms?: 'us' | 'uk' } = {}): PatternDoc {
  const technique = o.technique ?? 'sc_graphgan';
  return buildPattern2D({
    chart,
    settings: settingsOf({ technique, hand: o.hand ?? 'right', border: { widthIn: o.border ?? 0 } }),
    gauge: resolveGauge({ cyc: 4, technique }),
    terms: o.terms ?? 'us',
    dialect: 'compact',
    title: o.title ?? 'Pattern',
  });
}

const g9 = (o: Parameters<typeof docOf>[1] = {}): PatternDoc => docOf(loadChartResult('g9').grid, { title: 'G9 sampler', ...o });
/** All text of some pages, without whitespace (lines wrap, styles split runs, arrows are drawn as strokes). */
const squash = (s: string): string => s.replace(/[\s←→↖↗↙↘]/g, '');
const pagesText = (info: Awaited<ReturnType<typeof inspectBlob>>, from: number, to: number): string => squash(info.pages.slice(from - 1, to).flatMap((p) => p.text).join(''));

describe('buildPdf (§5.2.1)', () => {
  it('replaces the Step 0 stub', () => {
    expect(isImplemented(buildPdf)).toBe(true);
  });

  it('the G9 pattern: a %PDF of 4 Letter pages — cover and materials, notes and abbreviations, chart, instructions', async () => {
    const report = await buildPatternPdf(g9(), { paper: 'letter' });
    const bytes = new Uint8Array(await report.blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes.subarray(0, 5))).toBe('%PDF-');
    expect(report.blob.type).toBe('application/pdf');
    const info = inspectPdf(bytes);
    expect(info.pages).toHaveLength(4);
    expect(info.count).toBe(4);
    expect(report.pages).toBe(4);
    for (const p of info.pages) expect(p.mediaBox).toEqual([0, 0, 612, 792]);
    expect(report.sections.map((s) => [s.id, s.first, s.last])).toEqual([
      ['cover', 1, 1],
      ['materials', 1, 1],
      ['gauge', 1, 1],
      ['notes', 1, 2],
      ['abbreviations', 2, 2],
      ['chart', 3, 3],
      ['instructions', 4, 4],
    ]);
    expect(report.chart?.tilePages).toEqual([3]);
    expect(report.chart?.mapPage).toBeNull();
    // Footer on every page.
    info.pages.forEach((p, i) => expect(p.text).toContain(`Page ${i + 1} of 4`));
  });

  it('A4 pages have the A4 size', async () => {
    const info = await inspectBlob(await buildPdf(g9(), { paper: 'a4' }));
    expect(info.pages.length).toBeGreaterThanOrEqual(4);
    for (const p of info.pages) expect(p.mediaBox).toEqual([0, 0, 595.28, 841.89]);
  });

  it('section order matches F8: bookmarks, contents and the text read cover → materials → gauge → notes → abbreviations → chart → rows', async () => {
    const doc = g9({ border: 0.25 });
    const report = await buildPatternPdf(doc, { paper: 'letter' });
    const info = await inspectBlob(report.blob);
    expect(info.outline).toEqual(SECTION_ORDER.map((id) => SECTION_TITLES[id]));
    const all = info.pages.flatMap((p) => p.text);
    // Each heading is found after the one before it (the cover's contents box names some of them again later).
    const order = ['Chart preview · 5 × 3', 'FINISHED SIZE', 'SKILL LEVEL', 'Materials and yardage', 'HOOK', 'Gauge', 'Notes', 'Abbreviations', 'Chart', 'KEY', 'Instructions', 'Row 1 (RS) ', 'Border (with A)', 'Rnd 1 (RS):'];
    let pos = -1;
    for (const s of order) {
      const i = all.indexOf(s, pos + 1);
      expect(i, `"${s}" after position ${pos}`).toBeGreaterThan(pos);
      pos = i;
    }
    // The chart heading is on the chart page, the instructions heading on the last page.
    expect(info.pages[2].text).toContain('Chart');
    expect(info.pages[info.pages.length - 1].text).toContain('Instructions');
    // The gauge, the hook and every note and abbreviation of the doc are printed.
    const front = pagesText(info, 1, report.sections.find((s) => s.id === 'chart')!.first - 1);
    for (const t of [doc.gaugeText, ...doc.notes, ...doc.abbreviations.flatMap((a) => [a.abbr, a.meaning]), '5mm(USH-8),orthesizeneededtoobtaingauge']) expect(front).toContain(squash(t));
    // The contents box links to the sections.
    expect(info.pages[0].links).toBe(4);
  });

  it('the instructions: every line of the pattern with its label, the border rounds included', async () => {
    for (const o of [{ border: 0.25 }, { border: 0.25, hand: 'left' as const }, { terms: 'uk' as const }]) {
      const doc = g9(o);
      const report = await buildPatternPdf(doc, { paper: 'letter' });
      const info = await inspectBlob(report.blob);
      const s = report.sections.find((x) => x.id === 'instructions')!;
      const text = pagesText(info, s.first, s.last);
      const blocks = instructionBlocks(patternText(doc).md, doc.title);
      const steps = blocks.filter((b) => b.kind === 'step');
      expect(steps.length).toBeGreaterThanOrEqual(doc.pieces[0].lines.length);
      for (const b of steps) expect(text).toContain(squash(`${plainText(b.kind === 'step' ? b.label : [])}${plainText(b.kind === 'step' ? b.body : [])}`));
      if (report.textSource === 'line-renderers') {
        for (const l of doc.pieces[0].lines) expect(text).toContain(squash(renderLine(l, { dialect: doc.dialect, terms: doc.terms, hand: doc.hand, docKind: '2d' })));
      }
    }
  });

  it.runIf(isImplemented(renderPatternText))('G9: the instructions are renderPatternText’s text (md, the doc’s terms, hand and dialect)', async () => {
    const doc = g9({ border: 0.25 });
    const report = await buildPatternPdf(doc, { paper: 'letter' });
    expect(report.textSource).toBe('renderPatternText');
    const md = renderPatternText(doc, { format: 'md', terms: doc.terms, hand: doc.hand, dialect: doc.dialect });
    const info = await inspectBlob(report.blob);
    const s = report.sections.find((x) => x.id === 'instructions')!;
    const text = pagesText(info, s.first, s.last);
    for (const b of instructionBlocks(md, doc.title)) {
      if (b.kind === 'step') expect(text).toContain(squash(plainText(b.label) + plainText(b.body)));
      if (b.kind === 'text') expect(text).toContain(squash(plainText(b.spans)));
    }
  });

  it('a 120 × 150 chart on Letter: page map + 15 landscape chart pages (3 across × 5 down), every page accounted for', async () => {
    const chart = randomChart(mulberry32(7), 120, 150, 6);
    const doc = docOf(chart, { border: 1, title: 'Big blanket' });
    const report = await buildPatternPdf(doc, { paper: 'letter' });
    const info = await inspectBlob(report.blob);
    // Independently of the layout code under test: cells per landscape page, then 2-cell-overlap spans.
    const per = cellsPerPage({ w: 792, h: 612 }, printedCell(doc.chart!.cell), chart.palette.length);
    const across = tileSpans(120, per.cols).length;
    const down = tileSpans(150, per.rows).length;
    expect([across, down]).toEqual([3, 5]);
    const chartSection = report.sections.find((s) => s.id === 'chart')!;
    expect(chartSection.last - chartSection.first + 1).toBe(1 + across * down);
    const front = chartSection.first - 1;
    const rows = report.sections.find((s) => s.id === 'instructions')!;
    expect(rows.first).toBe(chartSection.last + 1);
    expect(info.pages).toHaveLength(front + 1 + across * down + (rows.last - rows.first + 1));
    expect(report.pages).toBe(info.pages.length);
    // Chart pages are landscape, the others portrait.
    info.pages.forEach((p, i) => expect(p.mediaBox, `page ${i + 1}`).toEqual(i + 1 >= chartSection.first && i + 1 <= chartSection.last ? [0, 0, 792, 612] : [0, 0, 612, 792]));
    // The page map links to every chart page; each chart page names its rows and has its row numbers.
    expect(info.pages[chartSection.first - 1].links).toBe(across * down);
    expect(info.pages[chartSection.first].text).toContain('Chart — page 1 of 15');
    expect(info.pages[chartSection.first].text.join(' ')).toMatch(/Rows 1\d\d–150 · stitches \d+–120/);
    const lastChart = info.pages[chartSection.last - 1].text;
    expect(lastChart).toContain('1');
    expect(lastChart.join(' ')).toMatch(/Rows 1–\d+ · stitches 1–\d+/);
    // Every row number 1…150 appears on some chart page (twice: both sides).
    const numbers = new Set(info.pages.slice(chartSection.first, chartSection.last).flatMap((p) => p.text).filter((t) => /^\d+$/.test(t)).map(Number));
    for (let n = 1; n <= 150; n++) expect(numbers.has(n), `row ${n}`).toBe(true);
  });

  it('is deterministic: the same doc gives the same bytes; a creation date changes only the date', async () => {
    const doc = g9({ border: 0.25 });
    const a = new Uint8Array(await (await buildPdf(doc, { paper: 'letter' })).arrayBuffer());
    const b = new Uint8Array(await (await buildPdf(doc, { paper: 'letter' })).arrayBuffer());
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const text = Buffer.from(a).toString('latin1');
    expect(text).toContain(`/CreationDate (${FIXED_CREATION_DATE})`);
    expect(text).toContain(`/ID [ <${(doc.hash + '0'.repeat(16)).toUpperCase()}>`);
    const dated = Buffer.from(await (await buildPatternPdf(doc, { paper: 'letter', createdAt: new Date(Date.UTC(2026, 9, 1, 14, 5, 9)) })).blob.arrayBuffer()).toString('latin1');
    expect(dated).toContain("/CreationDate (D:20261001140509+00'00')");
  });

  it('titles outside WinAnsi still print (emoji and CJK become "?"); progress runs from 0 to 1', async () => {
    const progress: number[] = [];
    const report = await buildPatternPdf(g9({ title: 'Kitty 🐱 猫 – “cozy”' }), { paper: 'letter', onProgress: (f) => progress.push(f) });
    const info = await inspectBlob(report.blob);
    expect(info.pages[0].text).toContain('Kitty ? ? – “cozy”');
    expect(progress.length).toBeGreaterThan(2);
    for (let i = 1; i < progress.length; i++) expect(progress[i]).toBeGreaterThanOrEqual(progress[i - 1]);
    expect(progress[progress.length - 1]).toBe(1);
  });

  it('every 2D technique prints (C2C diagonals, tapestry in the round, hdc)', async () => {
    const heart = loadChartResult('heart').grid;
    for (const technique of ['sc_tapestry', 'sc_tapestry_round', 'c2c', 'hdc_graphgan'] as const) {
      const doc = docOf(heart, { technique, border: technique === 'sc_tapestry_round' ? 0 : 0.5, title: technique });
      const report = await buildPatternPdf(doc, { paper: 'a4' });
      const info = await inspectBlob(report.blob);
      expect(info.header).toBe('%PDF-1.3');
      expect(info.outline).toEqual(SECTION_ORDER.map((id) => SECTION_TITLES[id]));
      const chart = report.sections.find((s) => s.id === 'chart')!;
      expect(info.pages[chart.first - 1].text.join(' ')).toContain(technique === 'c2c' ? 'Chart rows 1–24 · tiles 1–30' : technique === 'sc_tapestry_round' ? 'Rounds 1–24' : 'Rows 1–24 · stitches 1–30');
    }
  });
});

describe('exports are blocked while any E_* exists (F8)', () => {
  it('an error in the doc blocks; warnings do not', async () => {
    const doc = g9();
    const bad: PatternDoc = { ...doc, issues: [{ code: 'E_RUN_SUM', severity: 'error', message: 'Row 2 has 4 sts, not 5.', where: { row: 2 } }] };
    await expect(buildPdf(bad, { paper: 'letter' })).rejects.toBeInstanceOf(PdfBlockedError);
    const err = await buildPdf(bad, { paper: 'letter' }).catch((e: unknown) => e);
    expect(isPdfBlocked(err)).toBe(true);
    expect((err as PdfBlockedError).issues.map((i) => i.code)).toEqual(['E_RUN_SUM']);
    expect((err as Error).message).toMatch(/can't be exported yet: there is 1 problem to fix first \(E_RUN_SUM: Row 2 has 4 sts, not 5\.\)/);
    const warned: PatternDoc = { ...doc, issues: [{ code: 'W_LONG_CARRY', severity: 'warn', message: 'B carried across 9 sts.' }] };
    const report = await buildPatternPdf(warned, { paper: 'letter' });
    expect(report.warnings.map((w) => w.code)).toEqual(['W_LONG_CARRY']);
  });

  it('buildPdf runs validateDoc2D itself: a row that no longer matches the chart blocks the PDF', async () => {
    const doc = g9();
    const lines = doc.pieces[0].lines.map((l, i) => (i === 1 ? { ...l, ops: l.ops.slice(0, -1) } : l));
    const broken: PatternDoc = { ...doc, pieces: [{ ...doc.pieces[0], lines }], issues: [] };
    const check = preflightPdf(broken);
    expect(check.errors.length).toBeGreaterThan(0);
    expect(check.errors.every((e) => e.severity === 'error' && e.code.startsWith('E_'))).toBe(true);
    await expect(buildPdf(broken, { paper: 'letter' })).rejects.toThrow(PdfBlockedError);
    // A preflight passed in is trusted (the export dialog ran it once, with the project's settings and gauge).
    await expect(buildPatternPdf(broken, { paper: 'letter', preflight: { errors: [], warnings: [] } })).resolves.toBeTruthy();
  });

  it('preflightPdf checks the border against the project’s settings and gauge', () => {
    const technique = 'sc_graphgan';
    const gauge = resolveGauge({ cyc: 4, technique });
    const settings = settingsOf({ technique, border: { widthIn: 0.5 } });
    const doc = buildPattern2D({ chart: loadChartResult('heart').grid, settings, gauge, terms: 'us', dialect: 'compact', title: 'Heart' });
    expect(preflightPdf(doc, { settings, gauge }).errors).toEqual([]);
    // The project now asks for a wider border than the pattern was built with: the PDF must wait for a rebuild.
    const stale = preflightPdf(doc, { settings: { ...settings, border: { widthIn: 2 } }, gauge });
    expect(stale.errors.map((e) => e.code)).toContain('E_BORDER');
    // Issues are not repeated.
    const dup = preflightPdf({ ...doc, issues: [stale.errors[0], stale.errors[0]] });
    expect(dup.errors).toHaveLength(1);
  });
});

describe('performance (§5.8)', () => {
  it('a 200 × 200 chart pattern PDF (with its validation) in < 5 s', { ...PERF, timeout: 180_000 }, async () => {
    const chart = randomChart(mulberry32(42), 200, 200, 8);
    const doc = docOf(chart, { border: 1, title: 'Two hundred' });
    expect(doc.issues.filter((i) => i.severity === 'error')).toEqual([]);
    const t0 = performance.now();
    const blob = await buildPdf(doc, { paper: 'letter' });
    const ms = performance.now() - t0;
    expect(blob.size).toBeGreaterThan(10_000);
    expect(ms).toBeLessThan(budget(5000));
  });
});
