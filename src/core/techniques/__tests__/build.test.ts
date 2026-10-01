import { describe, expect, it } from 'vitest';
import type { ChartSettings, Hand, Technique2D } from '../../../types';
import { resolveGauge } from '../../gauge';
import { mulberry32 } from '../../kernel/prng';
import { renderFoundation, renderLineExtras, renderLineWith } from '../../pattern/render';
import { isImplemented } from '../../stub';
import { CORNERS } from '../c2cCorners';
import { buildPattern2D, buildPattern2DWith } from '../index';
import { validateDoc2D } from '../validate2d';
import { chartOf, loadChartResult, randomChart, settingsOf } from './fixtures';

const TECHNIQUES: Technique2D[] = ['sc_graphgan', 'sc_tapestry', 'sc_tapestry_round', 'c2c', 'hdc_graphgan'];
const errors = <T extends { severity: string }>(xs: readonly T[]): T[] => xs.filter((x) => x.severity === 'error');

describe('buildPattern2D (§5.2.1): a full 2D PatternDoc', () => {
  it('replaces the Step 0 stub', () => {
    expect(isImplemented(buildPattern2D)).toBe(true);
  });

  it('the G9 chart in every technique: no E_*, materials, gauge, hook, notes, abbreviations, skill, hash', () => {
    const g9 = loadChartResult('g9').grid;
    for (const technique of TECHNIQUES) {
      const gauge = resolveGauge({ cyc: 4, technique });
      const doc = buildPattern2D({ chart: g9, settings: settingsOf({ technique, border: { widthIn: technique === 'sc_tapestry_round' ? 1 : 0.5 } }), gauge, terms: 'us', dialect: 'compact', title: 'Heart' });
      expect(errors(doc.issues)).toEqual([]);
      expect(doc).toMatchObject({ kind: '2d', title: 'Heart', terms: 'us', hand: 'right', dialect: 'compact', assembly: [] });
      expect(doc.chart).toEqual({ grid: g9, cell: gauge.cell, technique });
      expect(doc.hook).toEqual({ mm: 5, us: 'H-8' });
      expect(doc.materials.map((m) => m.code)).toEqual(['A', 'B']);
      for (const m of doc.materials) {
        expect(m.yards).toBeGreaterThan(0);
        expect(m.yardsLow).toBeLessThan(m.yards);
        expect(m.yardsHigh).toBeGreaterThan(m.yards);
      }
      expect(doc.pieces).toHaveLength(1);
      expect(doc.pieces[0].finish.text).toBe('Fasten off and weave in ends.');
      expect(doc.notes.length).toBeGreaterThan(3);
      expect(doc.abbreviations.map((a) => a.abbr)).toContain('ch');
      expect(doc.hash).toMatch(/^[0-9a-f]{16}$/);
      expect(doc.finishedSize.tolPct).toBeCloseTo(12, 9);
      // Tapestry in the round takes no border; the others have 2 rounds at 0.5 in.
      expect(doc.pieces[0].lines.filter((l) => l.kind === 'border')).toHaveLength(technique === 'sc_tapestry_round' ? 0 : 2);
      expect(validateDoc2D(doc)).toEqual([]);
    }
  });

  it('gauge lines in CYC style (US and UK)', () => {
    const g9 = loadChartResult('g9').grid;
    const text = (technique: Technique2D, terms: 'us' | 'uk' = 'us'): string =>
      buildPattern2D({ chart: g9, settings: settingsOf({ technique }), gauge: resolveGauge({ cyc: 4, technique }), terms, dialect: 'compact', title: '' }).gaugeText;
    expect(text('sc_graphgan')).toBe('13.5 sc and 16 rows = 4" (10 cm)');
    expect(text('sc_graphgan', 'uk')).toBe('13.5 dc and 16 rows = 4" (10 cm)');
    expect(text('c2c')).toBe('5.2 tiles = 4" (10 cm)');
    expect(text('hdc_graphgan')).toMatch(/^12\.9 hdc and 10\.7 rows = 4" \(10 cm\)$/);
    expect(text('sc_tapestry_round')).toMatch(/sc and .* rnds = 4" \(10 cm\) in tapestry crochet$/);
  });

  it('is deterministic; the hash changes with the settings', () => {
    const heart = loadChartResult('heart').grid;
    const gauge = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const i = { chart: heart, settings: settingsOf({ border: { widthIn: 1 } }), gauge, terms: 'us' as const, dialect: 'compact' as const, title: 'Heart' };
    const a = buildPattern2D(i);
    expect(buildPattern2D(i).hash).toBe(a.hash);
    expect(JSON.stringify(buildPattern2D(i))).toBe(JSON.stringify(a));
    expect(buildPattern2D({ ...i, settings: settingsOf({ hand: 'left', border: { widthIn: 1 } }) }).hash).not.toBe(a.hash);
  });

  it('the heart: skill, notions (bobbins), finished size with the border', () => {
    const heart = loadChartResult('heart').grid;
    const gauge = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const doc = buildPattern2D({ chart: heart, settings: settingsOf({ border: { widthIn: 0.5 } }), gauge, terms: 'us', dialect: 'compact', title: 'Heart' });
    expect(doc.skill.level).toBeGreaterThanOrEqual(2);
    expect(doc.notions[0]).toBe('Tapestry needle');
    expect(doc.notions.some((n) => n.startsWith('Yarn bobbins'))).toBe(true);
    expect(doc.finishedSize.wIn).toBeCloseTo(30 * gauge.cell.w + 2 * 2 * gauge.hSc, 9);
    expect(doc.finishedSize.hIn).toBeCloseTo(24 * gauge.cell.h + 2 * 2 * gauge.hSc, 9);
  });

  it('a bad chart gives a doc that says why (E_SANITY), and mosaic waits for its writer; nothing throws', () => {
    const gauge = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const bad = buildPattern2D({ chart: { cols: 0, rows: 0, labels: new Uint8Array(0), palette: [] }, settings: settingsOf(), gauge, terms: 'us', dialect: 'compact', title: 'x' });
    expect(bad.issues.map((x) => x.code)).toEqual(['E_SANITY']);
    expect(bad.pieces).toEqual([]);
    const mosaic = buildPattern2D({ chart: chartOf(['AB']), settings: settingsOf({ technique: 'mosaic_overlay' }), gauge, terms: 'us', dialect: 'compact', title: 'x' });
    expect(mosaic.issues[0].code).toBe('E_SANITY');
  });
});

describe('property: generated 2D patterns never carry an E_* (random charts × techniques × hands × options)', () => {
  it('every technique, hand, corner, lean, border, terms and dialect; every line renders', { timeout: 120_000 }, () => {
    const rng = mulberry32(2026);
    let docs = 0;
    for (let t = 0; t < 36; t++) {
      const grid = randomChart(rng, 1 + Math.floor(rng() * 24), 1 + Math.floor(rng() * 18), 1 + Math.floor(rng() * 5));
      for (const technique of TECHNIQUES) {
        const gauge = resolveGauge({ cyc: (2 + Math.floor(rng() * 4)) as 2 | 3 | 4 | 5, technique });
        for (const hand of ['right', 'left'] as Hand[]) {
          const corner = CORNERS[Math.floor(rng() * 4)];
          const mode = (['note', 'preskew', 'turn'] as const)[Math.floor(rng() * 3)];
          const settings: ChartSettings = settingsOf({
            technique,
            hand,
            startCorner: corner,
            roundLean: { mode, stPerRnd: [0.5, 0.3, -0.5][Math.floor(rng() * 3)] },
            border: { widthIn: [0, 0.25, 0.75][Math.floor(rng() * 3)], color: rng() < 0.3 ? { hex: '#abcdef' } : undefined },
            applyRepeats: rng() < 0.2 ? 'off' : 'auto',
          });
          const terms = rng() < 0.5 ? 'us' : 'uk';
          const build = buildPattern2DWith({ chart: grid, settings, gauge, terms, dialect: 'compact', title: 'p' }, { cues: rng() < 0.8 });
          const doc = build.doc;
          docs++;
          const found = errors(doc.issues);
          if (found.length > 0) throw new Error(`${technique} ${hand} ${corner} ${mode} ${grid.cols}×${grid.rows}: ${JSON.stringify(found.slice(0, 2))}`);
          expect(errors(validateDoc2D(doc))).toEqual([]);
          expect(errors(validateDoc2D(doc, { settings, gauge }))).toEqual([]);
          // Σ materials stitches = the chart's cells + the border's stitches.
          const border = build.border === null ? 0 : build.border.counts.reduce((a, b) => a + b, 0);
          expect(doc.materials.reduce((a, m) => a + m.stitches, 0)).toBe(grid.cols * grid.rows + border);
          for (const line of doc.pieces[0].lines) {
            for (const dialect of ['compact', 'verbose'] as const) {
              const text = renderLineWith(line, { dialect, terms, hand, docKind: '2d', border: { technique, rows: grid.rows, cols: grid.cols } });
              expect(text.length).toBeGreaterThan(0);
              if (terms === 'uk') expect(text).not.toMatch(/\bsc\b|\bsl st\b/);
            }
            renderFoundation(line, { terms, docKind: '2d' });
            renderLineExtras(line, { terms });
          }
        }
      }
    }
    expect(docs).toBe(36 * 5 * 2);
  });
});
