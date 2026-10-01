// Regression tests for the T2.2 review findings.
import { describe, expect, it } from 'vitest';
import type { ChartGrid, Line } from '../../../types';
import { resolveGauge } from '../../gauge';
import { notesFor } from '../../pattern/notes';
import { buildPattern2D, buildPattern2DWith } from '../index';
import { roundLeanOf } from '../scRound';
import { validate2D, validateDoc2D } from '../validate2d';
import { chartOf, settingsOf } from './fixtures';

const errors = <T extends { severity: string }>(xs: readonly T[]): T[] => xs.filter((x) => x.severity === 'error');

describe('T2.2 review fixes', () => {
  it('validateDoc2D infers the pre-skew from folded and repeated rounds (vertical stripes, any rate)', () => {
    const gauge = resolveGauge({ cyc: 4, technique: 'sc_tapestry_round' });
    for (const [cols, rows] of [
      [4, 12],
      [6, 9],
      [10, 40],
    ]) {
      const grid = chartOf(Array.from({ length: rows }, () => 'AB'.repeat(cols / 2)));
      for (const stPerRnd of [0.5, 0.3, 1, -0.5, 9]) {
        const doc = buildPattern2D({ chart: grid, settings: settingsOf({ technique: 'sc_tapestry_round', roundLean: { mode: 'preskew', stPerRnd } }), gauge, terms: 'us', dialect: 'compact', title: '' });
        expect(errors(doc.issues)).toEqual([]);
        expect(errors(validateDoc2D(doc))).toEqual([]);
      }
    }
    expect(roundLeanOf({ mode: 'preskew', stPerRnd: 12.5 }).stPerRnd).toBe(8);
  });

  it('a C2C chart with ~160 000 regions builds (no spread of every region into Math.max)', { timeout: 120_000 }, () => {
    const N = 400;
    const labels = new Uint8Array(N * N);
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) labels[r * N + c] = (r + c) % 3;
    const grid: ChartGrid = { cols: N, rows: N, labels, palette: chartOf(['ABC']).palette };
    const doc = buildPattern2D({ chart: grid, settings: settingsOf({ technique: 'c2c', startCorner: 'BL' }), gauge: resolveGauge({ cyc: 4, technique: 'c2c' }), terms: 'us', dialect: 'compact', title: '' });
    expect(errors(doc.issues)).toEqual([]);
  });

  it('never throws: non-finite border width, null border setting, null lines in a tube, unknown technique', () => {
    const g = chartOf(['AB', 'BA']);
    const gauge = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const doc = buildPattern2D({ chart: g, settings: settingsOf({ border: { widthIn: Infinity } }), gauge, terms: 'us', dialect: 'compact', title: '' });
    expect(errors(doc.issues)).toEqual([]);
    expect(doc.pieces[0].lines.some((l) => l.kind === 'border')).toBe(false);
    expect(() => validateDoc2D(doc, { settings: { border: null as never } })).not.toThrow();
    expect(() => validate2D({ chart: g, technique: 'sc_graphgan', hand: 'right', lines: doc.pieces[0].lines, gauge, border: { widthIn: Infinity } })).not.toThrow();
    expect(() => validate2D({ chart: g, technique: 'sc_tapestry_round', hand: 'right', lines: [null, 7] as unknown as Line[] })).not.toThrow();
    expect(buildPattern2D({ chart: g, settings: settingsOf({ technique: 'tunisian' as never }), gauge, terms: 'us', dialect: 'compact', title: '' }).issues[0].code).toBe('E_SANITY');
  });

  it('a continued border after a multi-color panel says to cut the other colors; a border-only color has a bobbin', () => {
    const g9 = chartOf(['BAAAA', 'ABBBA', 'AABAA']);
    const gauge = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const cont = buildPattern2DWith({ chart: g9, settings: settingsOf({ border: { widthIn: 0.25, color: { hex: g9.palette[1].hex } } }), gauge, terms: 'us', dialect: 'compact', title: '' });
    expect(cont.border!.opening).toBe('noturn');
    expect(cont.doc.notes.some((n) => n.startsWith('The border continues from the last stitch: before Rnd 1, cut every other color'))).toBe(true);
    const own = buildPattern2DWith({ chart: g9, settings: settingsOf({ border: { widthIn: 0.25, color: { hex: '#ff0000' } } }), gauge, terms: 'us', dialect: 'compact', title: '' });
    expect(own.doc.materials.find((m) => m.hex === '#ff0000')!.strands).toBe(1);
    expect(own.doc.notes.some((n) => n.startsWith('The border continues'))).toBe(false);
  });

  it('the drift note reads well for small drifts', () => {
    const at = (stPerRnd: number, rounds: number): string => notesFor('tapestry-round', { terms: 'us', hand: 'right', roundLean: { mode: 'note', stPerRnd }, rounds }).join(' ');
    expect(at(0.1, 3)).toContain('shift less than 1 st to the right');
    expect(at(0.5, 3)).toContain('shift about 1 st to the right');
    expect(at(0.5, 5)).toContain('shift about 2 sts to the right');
  });
});
