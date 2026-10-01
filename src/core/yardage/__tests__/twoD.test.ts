import { describe, expect, it } from 'vitest';
import type { ChartGrid, PaletteEntry, Yarn } from '../../../types';
import { resolveGauge } from '../../gauge';
import { buildPattern2DWith } from '../../techniques/index';
import { chartOf, settingsOf } from '../../techniques/__tests__/fixtures';
import { colorYards, emptyWork, yardage2D, yarnParts, ydPer100gOf } from '../twoD';

const worsted = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
const skein364: Yarn = { id: 'y1', lineId: 'l', brand: 'Brand', line: 'Line', name: 'Navy', hex: '#000080', skeinYards: 364, skeinGrams: 198 };
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** W = 60, a 40 × 25 block of B (1000 sc) in the middle of A: B never starts a row and is never carried. */
function g11Chart(): ChartGrid {
  const W = 60;
  const H = 25;
  const labels = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 10; c < 50; c++) labels[r * W + c] = 1;
  const palette: PaletteEntry[] = [
    { code: 'A', hex: '#eeeeee', name: 'Cream' },
    { code: 'B', hex: '#000080', name: 'Navy', yarn: skein364, deltaE00: 1.2 },
  ];
  return { cols: W, rows: H, labels, palette };
}

describe('2D yardage and materials (DESIGN §2.8, G11)', () => {
  it('G11: one color of a multi-color chart, 1000 sc, one strand ⇒ 61.9 yd, band 46.4–77.4, 1 skein of 364 yd', () => {
    const build = buildPattern2DWith({ chart: g11Chart(), settings: settingsOf(), gauge: worsted, terms: 'us', dialect: 'compact', title: 'G11' });
    const b = build.doc.materials.find((m) => m.code === 'B')!;
    expect(b.stitches).toBe(1000);
    expect(b.strands).toBe(1);
    expect(build.work.get('B')).toMatchObject({ cells: 1000, chains: 0, carried: 0, starts: 1 });
    expect(build.yardage.buffer).toBe(0.15);
    expect(round1(b.yards)).toBe(61.9);
    expect(b.yards).toBeCloseTo(((1000 * 6.5 * (4 / 13.5) + 12) / 36) * 1.15, 9);
    expect([round1(b.yardsLow), round1(b.yardsHigh)]).toEqual([46.4, 77.4]);
    expect(b.skeins).toBe(1);
    expect(b.meters).toBeCloseTo(b.yards * 0.9144, 9);
    expect(b.grams).toBeCloseTo((b.yards / ((364 / 198) * 100)) * 100, 9);
    expect(b).toMatchObject({ hex: '#000080', name: 'Navy', yarn: skein364, deltaE00: 1.2 });
    // A: the rest of the cells, the foundation and turning chains, two strands (left and right of B).
    const a = build.work.get('A')!;
    expect(a.cells).toBe(500);
    expect(a.chains).toBe(61 + 24);
    expect(a.starts).toBe(2);
    expect(build.doc.materials.find((m) => m.code === 'A')!.skeins).toBeUndefined();
  });

  it('the same 1000 sc as a one-color piece: buffer 0.10 ⇒ 59.2 yd (the G11 blocks)', () => {
    const parts = yarnParts({ ...emptyWork(), cells: 1000, starts: 1 }, 'sc_graphgan', worsted);
    expect(parts).toEqual({ worked: expect.closeTo(1925.926, 3), carried: 0, tails: 12, extra: 0 });
    expect(round1(colorYards(parts, 0.1, 0.25).yards)).toBe(59.2);
    expect(round1(colorYards(parts, 0.15, 0.25).yards)).toBe(61.9);
  });

  it('C2C tile = 7.76 L_sc = 14.95 in (worsted); tiles and regions per color', () => {
    const c2c = resolveGauge({ cyc: 4, technique: 'c2c' });
    const parts = yarnParts({ ...emptyWork(), cells: 1 }, 'c2c', c2c);
    expect(Math.round(parts.worked * 100) / 100).toBe(14.95);
    const build = buildPattern2DWith({ chart: chartOf(['BAAAA', 'ABBBA', 'AABAA']), settings: settingsOf({ technique: 'c2c' }), gauge: c2c, terms: 'us', dialect: 'compact', title: '' });
    expect(build.work.get('A')).toMatchObject({ cells: 10, starts: build.c2c!.regions.regionsPerColor[0] });
    expect(build.yardage.buffer).toBe(0.2);
  });

  it('band: ±25% default, ±10% with a swatch, ±5% calibrated; skeins are bought for the high end', () => {
    const chart = g11Chart();
    const swatch = resolveGauge({ cyc: 4, technique: 'sc_graphgan', swatch: { sts: 14, rows: 16, spanIn: 4 } });
    const cal = resolveGauge({ cyc: 4, technique: 'sc_graphgan', lscCalibratedIn: 1.8 });
    expect(buildPattern2DWith({ chart, settings: settingsOf(), gauge: swatch, terms: 'us', dialect: 'compact', title: '' }).yardage.band).toBe(0.1);
    expect(buildPattern2DWith({ chart, settings: settingsOf(), gauge: cal, terms: 'us', dialect: 'compact', title: '' }).yardage.band).toBe(0.05);
    // 300 yd nominal, ±25% ⇒ 375 high ⇒ 2 skeins of 364 although the nominal fits in 1.
    const m = yardage2D({
      technique: 'sc_graphgan',
      gauge: worsted,
      colors: [{ entry: { code: 'A', hex: '#000000', name: 'A', yarn: skein364 }, work: { ...emptyWork(), cells: Math.round((300 * 36) / 1.1 / 1.925926) } }],
    }).materials[0];
    expect(m.yards).toBeLessThan(364);
    expect(m.skeins).toBe(2);
  });

  it('tapestry: worked × 1.1, carried yarn for every held color, buffer 0.20; > 50 strands also 0.20', () => {
    const tap = resolveGauge({ cyc: 4, technique: 'sc_tapestry' });
    const grid = chartOf(['ABAB', 'AAAA', 'BBBB']);
    const build = buildPattern2DWith({ chart: grid, settings: settingsOf({ technique: 'sc_tapestry' }), gauge: tap, terms: 'us', dialect: 'compact', title: '' });
    expect(build.yardage.buffer).toBe(0.2);
    // Bottom row BBBB (B alone, A not yet joined); AAAA (B held: carried across 4); ABAB (both: 2 each).
    expect(build.work.get('A')).toMatchObject({ cells: 6, carried: 2, starts: 1, bobbins: 1 });
    expect(build.work.get('B')).toMatchObject({ cells: 6, carried: 6, starts: 1, bobbins: 1 });
    const parts = build.yardage.parts[1];
    expect(parts.carried).toBeCloseTo(6 * 1.1 * tap.cell.w, 9);
    const many = yardage2D({ technique: 'sc_graphgan', gauge: worsted, colors: [{ entry: { code: 'A', hex: '#000000', name: 'A' }, work: { ...emptyWork(), cells: 10, starts: 30 } }, { entry: { code: 'B', hex: '#111111', name: 'B' }, work: { ...emptyWork(), cells: 10, starts: 21 } }] });
    expect(many.buffer).toBe(0.2);
  });

  it('a border in a yarn that is not in the chart gets its own materials line; grams from the yarn, else none', () => {
    const build = buildPattern2DWith({ chart: chartOf(['AB', 'BA']), settings: settingsOf({ border: { widthIn: 0.5, color: { hex: '#FF0000' } } }), gauge: worsted, terms: 'us', dialect: 'compact', title: '' });
    expect(build.doc.materials.map((m) => m.code)).toEqual(['A', 'B', 'C']);
    const c = build.doc.materials[2];
    expect(c).toMatchObject({ code: 'C', hex: '#ff0000', stitches: build.border!.counts.reduce((x, y) => x + y, 0) });
    expect(c.grams).toBeUndefined();
    expect(build.doc.issues.filter((x) => x.severity === 'error')).toEqual([]);
    expect(ydPer100gOf({ ...skein364, ydPer100g: 200 })).toBe(200);
    expect(ydPer100gOf({ ...skein364, skeinGrams: undefined })).toBeUndefined();
  });
});
