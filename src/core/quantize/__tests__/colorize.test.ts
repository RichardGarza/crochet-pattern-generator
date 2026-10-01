import { describe, expect, it } from 'vitest';
import { addNoise, fillDisc, fillRect, fromFn, solid, upscale } from '../../../test/rgba';
import type { ChartEdits, ChartSettings, ColorRef } from '../../../types/chart';
import type { RgbaImage } from '../../../types/geometry';
import type { YarnLine } from '../../../types/yarn';
import { ciede2000, deltaE00Hex, hexToLab } from '../../kernel/color';
import { sampleImage } from '../../image2d/sample';
import { SPRITE_PALETTE, blur3, characterSprite, logo, photoLike, randomSprite } from '../../image2d/__tests__/images';
import { getShippedLine } from '../../yarn/lines';
import { nearestYarnIn } from '../../yarn/match';
import { colorize, colorizeHash, paletteCode, remapEdits, toChartGrid, type ColorizeRequest } from '../colorize';

const WORSTED = { cell: { w: 4 / 13.5, h: 4 / 16 }, hSc: 4 / 16 };
/** Square stitches: one cell per pixel for a 60 px picture charted 60 wide. */
const SQUARE = { cell: { w: 0.25, h: 0.25 }, hSc: 0.25 };
const RHSS = getShippedLine('red-heart-super-saver')!;

function settings(over: Partial<ChartSettings> = {}): ChartSettings {
  return {
    technique: 'sc_graphgan',
    hand: 'right',
    startCorner: 'BR',
    lockAspect: true,
    border: { widthIn: 0 },
    maxColors: 'auto',
    paletteMode: 'auto',
    lineIds: [],
    referenceLineId: 'red-heart-super-saver',
    detail: 'balanced',
    dither: 'off',
    imageKind: 'auto',
    background: 'keep',
    applyRepeats: 'auto',
    roundLean: { mode: 'note', stPerRnd: 0 },
    ...over,
  };
}

function chart(img: RgbaImage, over: Partial<ChartSettings> = {}, o: { stitches?: number; gauge?: typeof WORSTED } & Omit<ColorizeRequest, 'settings'> = {}) {
  const gauge = o.gauge ?? WORSTED;
  const st = settings({ widthIn: (o.stitches ?? 60) * gauge.cell.w, ...over });
  const s = sampleImage({ image: img, settings: st, gauge });
  return { s, c: colorize(s, { settings: st, lines: o.lines, stash: o.stash, edits: o.edits }) };
}

/** Every label is a palette index (`E_COLOR`, §2.13). */
function expectEColor(c: ReturnType<typeof colorize>): void {
  for (let i = 0; i < c.labels.length; i++) expect(c.labels[i]).toBeLessThan(c.palette.length);
  expect(c.palette.map((p) => p.code)).toEqual(c.palette.map((_, i) => paletteCode(i)));
  // Every entry is used.
  const used = new Set(c.labels);
  expect(used.size).toBe(c.palette.length);
}

const colorsOf = (c: ReturnType<typeof colorize>): number => c.palette.filter((p) => p.role !== 'background').length;

/** A brown, softly textured 60 × 60 picture (several browns compete for K). */
const brown = (x: number, y: number): [number, number, number] => [
  Math.round(120 + 30 * Math.sin(x / 7) + 10 * Math.cos(y / 5)),
  Math.round(75 + 20 * Math.sin(x / 7)),
  Math.round(40 + 10 * Math.cos(y / 9)),
];
const RED = '#e01b2e';
const eyeImage = (): RgbaImage => fromFn(60, 60, (x, y) => (y === 30 && (x === 20 || x === 21) ? RED : brown(x, y)));

describe('salience guard (§2.4.3)', () => {
  for (const kind of ['photo', 'flat', 'auto'] as const) {
    it(`ACCEPTANCE: a 2-cell red "eye" in a 60 × 60 brown image survives at K = 4 (${kind})`, () => {
      const { s, c } = chart(eyeImage(), { maxColors: 4, imageKind: kind }, { gauge: SQUARE });
      expect([s.cols, s.rows]).toEqual([60, 60]);
      expect(colorsOf(c)).toBeLessThanOrEqual(4);
      for (const i of [30 * 60 + 20, 30 * 60 + 21]) {
        const e = c.palette[c.labels[i]];
        expect(deltaE00Hex(e.hex, RED)).toBeLessThan(5);
        expect(e.protected).toBe(true);
        expect(c.salient[i]).toBe(1);
        expect(c.protect[i]).toBe(1);
      }
      // Only the eye is red.
      const red = c.labels[30 * 60 + 20];
      expect(c.labels.filter((l) => l === red).length).toBe(2);
      expectEColor(c);
    });
  }

  it('the eye survives in yarn-line mode as a solid red yarn', () => {
    const { c } = chart(eyeImage(), { maxColors: 4, paletteMode: 'line', lineIds: ['red-heart-super-saver'] }, { gauge: SQUARE });
    const e = c.palette[c.labels[30 * 60 + 20]];
    expect(e.yarn?.lineId).toBe('red-heart-super-saver');
    expect(deltaE00Hex(e.hex, RED)).toBeLessThan(10);
    expect(e.yarn?.textured).toBeUndefined();
    expect(colorsOf(c)).toBeLessThanOrEqual(4);
  });

  it('a single odd cell is not a detail (≥ 2 cells), and without an eye nothing is protected', () => {
    const one = fromFn(60, 60, (x, y) => (y === 30 && x === 20 ? RED : brown(x, y)));
    const a = chart(one, { maxColors: 4 }, { gauge: SQUARE }).c;
    expect(a.palette.some((p) => p.protected)).toBe(false);
    const none = chart(fromFn(60, 60, brown), { maxColors: 4 }, { gauge: SQUARE }).c;
    expect(none.palette.some((p) => p.protected)).toBe(false);
    expect(none.salient.every((v) => v === 0)).toBe(true);
  });

  it('cells straddling an edge are mixes, not details (no protected colors on a clean logo)', () => {
    const { c } = chart(logo(600, 400));
    expect(c.palette.some((p) => p.protected)).toBe(false);
  });
});

describe('G14: a two-color logo → 2 colors', () => {
  it('ACCEPTANCE: anti-aliased two-color logo, auto K → exactly 2 colors', () => {
    const { s, c } = chart(logo(600, 400));
    expect(s.kind).toBe('flat');
    expect(c.palette.length).toBe(2);
    expect(c.palette.map((p) => p.hex).sort()).toEqual(['#c8102e', '#ffffff']);
    expect(c.autoK!.k).toBeGreaterThan(2); // the knee kept anti-aliasing shades; they were removed as blends
    expectEColor(c);
  });

  it('also black on white, at 2000 px, with max colors 8, and with the background removed', () => {
    expect(chart(logo(600, 400, '#000000', '#ffffff')).c.palette.length).toBe(2);
    expect(chart(logo(600, 400), { maxColors: 8 }).c.palette.length).toBe(2);
    expect(chart(logo(1000, 750), {}, { stitches: 150 }).c.palette.length).toBe(2);
    const bg = chart(logo(600, 400), { background: 'remove' }).c;
    expect(bg.palette.length).toBe(2);
    expect(bg.palette.find((p) => p.role === 'background')?.hex).toBe('#ffffff');
  });

  it('a third real color is kept (blends are only removed between other colors, at edges)', () => {
    const img = logo(600, 400);
    for (let y = 0; y < 100; y++) for (let x = 0; x < 600; x++) img.data.set([30, 60, 200, 255], (y * 600 + x) * 4);
    const c = chart(img).c;
    expect(c.palette.length).toBe(3);
  });
});

describe('G13: determinism of the colors', () => {
  const cases: [string, () => RgbaImage, Partial<ChartSettings>][] = [
    ['photo, auto', () => photoLike(300, 360, 2), {}],
    ['photo, yarn line', () => photoLike(300, 360, 2), { paletteMode: 'line', lineIds: ['red-heart-super-saver'] }],
    ['flat logo, background removed', () => logo(500, 300), { background: 'remove' }],
    ['pixel sprite', () => upscale(characterSprite(), 8), {}],
  ];
  for (const [name, make, over] of cases) {
    it(`ACCEPTANCE: 10 runs, same hash (${name})`, () => {
      const first = colorizeHash(chart(make(), over).c);
      for (let r = 0; r < 9; r++) expect(colorizeHash(chart(make(), over).c)).toBe(first);
    });
  }

  it('the hash sees a change of color', () => {
    expect(colorizeHash(chart(photoLike(200, 200, 1)).c)).not.toBe(colorizeHash(chart(photoLike(200, 200, 1), { maxColors: 4 }).c));
  });
});

describe('palettes (§2.4.2–2.4.4)', () => {
  it('auto mode: codes by population, colors named by the reference line, merged below ΔE00 5', () => {
    const { c } = chart(photoLike(400, 480, 3), {}, { stitches: 100 });
    expectEColor(c);
    const pop = c.palette.map((_, k) => c.labels.filter((l) => l === k).length);
    for (let k = 1; k < pop.length; k++) expect(pop[k]).toBeLessThanOrEqual(pop[k - 1]);
    for (const p of c.palette) {
      expect(p.yarn?.lineId).toBe('red-heart-super-saver');
      expect(p.name.startsWith(p.yarn!.name)).toBe(true);
      expect(p.name.endsWith('(approximate)')).toBe(p.deltaE00! > 10);
    }
    for (let a = 0; a < c.palette.length; a++)
      for (let b = a + 1; b < c.palette.length; b++) expect(deltaE00Hex(c.palette[a].hex, c.palette[b].hex)).toBeGreaterThanOrEqual(5);
    expect(c.mode).toBe('auto');
    expect(colorsOf(c)).toBeLessThanOrEqual(16);
  });

  it('max colors caps the palette', () => {
    for (const k of [1, 2, 3, 6]) expect(colorsOf(chart(photoLike(300, 300, 4), { maxColors: k }).c)).toBeLessThanOrEqual(k);
    expect(colorsOf(chart(photoLike(300, 300, 4), { maxColors: 20, technique: 'sc_tapestry' }).c)).toBeLessThanOrEqual(8);
  });

  it('pixel art keeps its exact colors (an exact K wins over the knee)', () => {
    const { s, c } = chart(upscale(randomSprite(32, 32, 3), 8));
    expect(s.kind).toBe('pixel');
    expect(c.palette.map((p) => p.hex).sort()).toEqual([...SPRITE_PALETTE].sort());
  });

  it('yarn-line mode: the entries ARE yarns, distinct, ΔE00 measured from the cluster mean', () => {
    const { c } = chart(photoLike(300, 360, 2), { paletteMode: 'line', lineIds: ['red-heart-super-saver'], maxColors: 6 });
    expect(c.mode).toBe('yarns');
    expect(colorsOf(c)).toBe(6);
    expect(new Set(c.palette.map((p) => p.yarn!.id)).size).toBe(c.palette.length);
    for (const p of c.palette) {
      expect(p.hex).toBe(p.yarn!.hex);
      expect(p.name).toBe(p.yarn!.name);
      expect(p.deltaE00).toBeGreaterThanOrEqual(0);
    }
    expectEColor(c);
  });

  it('custom CSV: a fixed palette (p-median subset when K is smaller)', () => {
    const csv = '#ff0000,Red\n#00aa00,Green\n#0000ff,Blue\n#ffffff,White\n#000000,Black\n#ffff00,Yellow';
    const all = chart(photoLike(300, 300, 5), { paletteMode: 'custom', customCsv: csv }).c;
    const hexes = new Set(['#ff0000', '#00aa00', '#0000ff', '#ffffff', '#000000', '#ffff00']);
    for (const p of all.palette) expect(hexes.has(p.hex)).toBe(true);
    const three = chart(photoLike(300, 300, 5), { paletteMode: 'custom', customCsv: csv, maxColors: 3 }).c;
    expect(colorsOf(three)).toBeLessThanOrEqual(3);
    const bad = chart(photoLike(100, 100, 5), { paletteMode: 'custom', customCsv: '#ff0000,Red\nnope' }).c;
    expect(bad.issues.map((i) => i.code)).toContain('W_CSV_ROW');
  });

  it('stash: p-median over the stash; an empty stash falls back to auto with W_PALETTE_EMPTY', () => {
    const stash = RHSS.yarns.slice(0, 12).map((y) => ({ ...y, owned: 2 }));
    const { c } = chart(photoLike(200, 200, 6), { paletteMode: 'stash', maxColors: 4 }, { stash });
    for (const p of c.palette) expect(stash.map((y) => y.id)).toContain(p.yarn!.id);
    const empty = chart(photoLike(200, 200, 6), { paletteMode: 'stash' }, { stash: [] }).c;
    expect(empty.mode).toBe('auto');
    expect(empty.issues.find((i) => i.code === 'W_PALETTE_EMPTY')?.severity).toBe('warn');
  });

  it('an unknown line id warns (W_YARN_LINE_UNKNOWN); lines sent with the request are used', () => {
    const lineB = testLine();
    const { c } = chart(photoLike(200, 200, 7), { paletteMode: 'line', lineIds: ['test-b', 'gone'] }, { lines: [lineB] });
    expect(c.issues.map((i) => i.code)).toContain('W_YARN_LINE_UNKNOWN');
    for (const p of c.palette) expect(p.yarn!.lineId).toBe('test-b');
  });

  it('textured yarns are never given to a protected detail', () => {
    // A line whose only red is a heather: the eye must take the nearest solid instead.
    const line: YarnLine = {
      id: 'tex',
      brand: 'T',
      line: 'T',
      cyc: 4,
      source: 'https://example.org',
      license: 'CC-BY-4.0',
      yarns: [
        { id: 'tex:1', lineId: 'tex', brand: 'T', line: 'T', name: 'Brown', hex: '#8a5a3a' },
        { id: 'tex:2', lineId: 'tex', brand: 'T', line: 'T', name: 'Dark Brown', hex: '#5d3a2a' },
        { id: 'tex:3', lineId: 'tex', brand: 'T', line: 'T', name: 'Red Heather', hex: '#e01b2e', textured: true },
        { id: 'tex:4', lineId: 'tex', brand: 'T', line: 'T', name: 'Orange', hex: '#e8632a' },
      ],
    };
    const { c } = chart(eyeImage(), { paletteMode: 'line', lineIds: ['tex'], maxColors: 3 }, { gauge: SQUARE, lines: [line] });
    const e = c.palette[c.labels[30 * 60 + 20]];
    expect(e.yarn!.textured).toBeUndefined();
    expect(e.protected).toBe(true);
  });
});

describe('background (§2.3.2)', () => {
  it('a transparent background is worked in the reference line\'s white, outside the color budget', () => {
    const img = fromFn(120, 120, () => [0, 0, 0, 0]);
    fillDisc(img, 60, 60, 40, '#3a6fd9');
    fillDisc(img, 60, 60, 15, '#f2c12e');
    const { c } = chart(img, { maxColors: 2 });
    const bg = c.palette.find((p) => p.role === 'background')!;
    expect(bg.hex).toBe('#ffffff');
    expect(bg.yarn?.id).toBe('red-heart-super-saver:0311');
    expect(colorsOf(c)).toBe(2);
    expect(c.labels[0]).toBe(c.palette.indexOf(bg));
    expectEColor(c);
  });

  it('a removed plain background keeps the border color in auto mode, and the nearest candidate yarn in line mode', () => {
    const img = solid(200, 160, '#c9e3f0');
    fillDisc(img, 100, 80, 50, '#d23a3a');
    const auto = chart(img, { background: 'remove' }).c;
    expect(auto.palette.find((p) => p.role === 'background')!.hex).toBe('#c9e3f0');
    const line = chart(img, { background: 'remove', paletteMode: 'line', lineIds: ['red-heart-super-saver'] }).c;
    const bg = line.palette.find((p) => p.role === 'background')!;
    expect(bg.yarn!.id).toBe(nearestYarnIn('#c9e3f0', RHSS.yarns)!.yarn.id);
    expect(bg.hex).toBe(bg.yarn!.hex);
  });

  it('the chosen background color wins; a translucent edge is composited over the background yarn', () => {
    const img = fromFn(100, 100, (x) => (x < 30 ? [0, 0, 0, 0] : x < 32 ? [210, 58, 58, 160] : '#d23a3a'));
    const chosen: ColorRef = { hex: '#000000', yarnId: 'red-heart-super-saver:0312' };
    const { c } = chart(img, { backgroundColor: chosen, paletteMode: 'line', lineIds: ['red-heart-super-saver'] });
    const bg = c.palette.find((p) => p.role === 'background')!;
    expect(bg.yarn!.id).toBe('red-heart-super-saver:0312');
  });
});

/** A small second line for yarn-line switches. */
function testLine(): YarnLine {
  const hexes: [string, string][] = [
    ['Snow', '#f4f4f0'],
    ['Ink', '#15151c'],
    ['Brick', '#a8322a'],
    ['Moss', '#5c7a3a'],
    ['Lake', '#2f6fa8'],
    ['Sun', '#f0c030'],
    ['Clay', '#a0704a'],
    ['Slate', '#5a6470'],
    ['Plum', '#6a3a6a'],
    ['Teal', '#2a8a8a'],
  ];
  return {
    id: 'test-b',
    brand: 'Test',
    line: 'B',
    cyc: 4,
    source: 'https://example.org/b',
    license: 'CC-BY-4.0',
    yarns: hexes.map(([name, hex], i) => ({ id: `test-b:${i}`, lineId: 'test-b', brand: 'Test', line: 'B', name, hex })),
  };
}

describe('hand edits as protected centers (§5.5.5)', () => {
  const img = (): RgbaImage => photoLike(300, 360, 2);
  const hotRed: ColorRef = { hex: '#e01b2e', yarnId: 'red-heart-super-saver:0390' };
  const sky: ColorRef = { hex: '#00a0ff' };
  const editsFor = (cols: number, rows: number): ChartEdits => ({
    baseCols: cols,
    baseRows: rows,
    overrides: [
      ...Array.from({ length: 10 }, (_, k) => ({ cell: 5 * cols + 5 + k, color: hotRed })),
      ...Array.from({ length: 6 }, (_, k) => ({ cell: 20 * cols + 30 + k, color: sky })),
    ],
    locked: [0, 1, 2],
  });
  const base = chart(img()).s;
  const edits = editsFor(base.cols, base.rows);
  const redCells = edits.overrides.filter((o) => o.color === hotRed).map((o) => o.cell);
  const skyCells = edits.overrides.filter((o) => o.color === sky).map((o) => o.cell);

  it('ACCEPTANCE: overridden cells keep their color identity at max colors 8 and 6, and pass E_COLOR', () => {
    for (const maxColors of [8, 6]) {
      const { c } = chart(img(), { maxColors }, { edits });
      expectEColor(c);
      expect(colorsOf(c)).toBeLessThanOrEqual(maxColors);
      const red = c.palette[c.labels[redCells[0]]];
      const blue = c.palette[c.labels[skyCells[0]]];
      for (const i of redCells) expect(c.labels[i]).toBe(c.labels[redCells[0]]);
      for (const i of skyCells) expect(c.labels[i]).toBe(c.labels[skyCells[0]]);
      // The photo has no color within ΔE00 2 of either, so both are inserted exactly.
      expect(red).toMatchObject({ hex: '#e01b2e', role: 'override', protected: true });
      expect(red.yarn?.id).toBe('red-heart-super-saver:0390');
      expect(blue).toMatchObject({ hex: '#00a0ff', role: 'override', protected: true });
      for (const i of [...redCells, ...skyCells, 0, 1, 2]) expect(c.protect[i]).toBe(1);
    }
  });

  it('ACCEPTANCE: … and through a yarn-line switch (own yarn when the line has it, else the nearest shade)', () => {
    const inRhss = chart(img(), { maxColors: 6, paletteMode: 'line', lineIds: ['red-heart-super-saver'] }, { edits }).c;
    expectEColor(inRhss);
    expect(colorsOf(inRhss)).toBeLessThanOrEqual(6);
    expect(inRhss.palette[inRhss.labels[redCells[0]]].yarn!.id).toBe('red-heart-super-saver:0390');
    expect(inRhss.palette[inRhss.labels[skyCells[0]]].yarn!.id).toBe(nearestYarnIn('#00a0ff', RHSS.yarns)!.yarn.id);
    const lineB = testLine();
    const inB = chart(img(), { maxColors: 6, paletteMode: 'line', lineIds: ['test-b'] }, { edits, lines: [lineB] }).c;
    expectEColor(inB);
    expect(colorsOf(inB)).toBeLessThanOrEqual(6);
    expect(inB.palette[inB.labels[redCells[0]]].yarn!.id).toBe(nearestYarnIn('#e01b2e', lineB.yarns)!.yarn.id);
    expect(inB.palette[inB.labels[skyCells[0]]].yarn!.id).toBe(nearestYarnIn('#00a0ff', lineB.yarns)!.yarn.id);
    for (const i of redCells) expect(inB.labels[i]).toBe(inB.labels[redCells[0]]);
    // The authored identity is untouched: the overrides as applied still carry the original ColorRefs.
    expect(inB.overrides.find((o) => o.cell === redCells[0])!.color).toEqual(hotRed);
    // Back to auto: the exact colors return.
    const back = chart(img(), { maxColors: 6 }, { edits }).c;
    expect(back.palette[back.labels[redCells[0]]].hex).toBe('#e01b2e');
  });

  it('an override within ΔE00 2 of a center maps to that center', () => {
    const plain = chart(img(), { maxColors: 6 }).c;
    const a = plain.palette[0].hex;
    const near: ColorRef = { hex: a };
    const { c } = chart(img(), { maxColors: 6 }, { edits: { baseCols: base.cols, baseRows: base.rows, overrides: [{ cell: 7, color: near }], locked: [] } });
    const e = c.palette[c.labels[7]];
    expect(ciede2000(hexToLab(e.hex), hexToLab(a))).toBeLessThan(2);
    expect(e.protected).toBe(true);
    expect(c.palette.filter((p) => p.role === 'override')).toEqual([]);
  });

  it('more override colors than max colors: all kept, with W_OVERRIDE_COLORS', () => {
    const many: ChartEdits = {
      baseCols: base.cols,
      baseRows: base.rows,
      overrides: ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].map((hex, k) => ({ cell: k * 3, color: { hex } })),
      locked: [],
    };
    const { c } = chart(img(), { maxColors: 2 }, { edits: many });
    expect(c.issues.map((i) => i.code)).toContain('W_OVERRIDE_COLORS');
    for (const [k, hex] of ['#ff0000', '#00ff00', '#0000ff', '#ffff00'].entries()) expect(c.palette[c.labels[k * 3]].hex).toBe(hex);
    expectEColor(c);
  });

  it('edits made at another size are remapped by position (I_EDITS_REMAPPED); invalid ones are dropped', () => {
    const half = remapEdits({ baseCols: 4, baseRows: 2, overrides: [{ cell: 5, color: sky }], locked: [7] }, 8, 4);
    expect(half.overrides).toEqual([{ cell: 3 * 8 + 3, color: sky }]);
    expect(half.locked).toEqual([3 * 8 + 7]);
    const { c } = chart(img(), {}, { edits: { baseCols: 10, baseRows: 10, overrides: [{ cell: 0, color: sky }], locked: [] } });
    expect(c.issues.map((i) => i.code)).toContain('I_EDITS_REMAPPED');
    const moved = c.overrides[0].cell;
    expect(moved).toBe(Math.floor((0.5 * c.rows) / 10) * c.cols + Math.floor((0.5 * c.cols) / 10));
    expect(c.palette[c.labels[moved]].hex).toBe('#00a0ff');
    const bad = chart(img(), {}, { edits: { baseCols: base.cols, baseRows: base.rows, overrides: [{ cell: -1, color: sky }, { cell: 3, color: { hex: 'blue' } }], locked: [] } }).c;
    expect(bad.issues.find((i) => i.code === 'W_EDITS_INVALID')?.message).toContain('2 hand edits');
  });
});

describe('helpers', () => {
  it('paletteCode: A…Z, AA, AB (never MC by construction of the sequence start)', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(paletteCode)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });

  it('toChartGrid', () => {
    const { c } = chart(addNoise(logo(300, 200), 2, 1), { imageKind: 'flat' });
    const g = toChartGrid(c);
    expect(g.cols * g.rows).toBe(g.labels.length);
    expect(g.palette).toBe(c.palette);
  });
});

describe('review regressions (T1.2)', () => {
  /** The logo on a transparent background. */
  const transparentLogo = (): RgbaImage => {
    const img = logo(600, 400);
    for (let o = 0; o < img.data.length; o += 4) {
      // Paper → transparent; ink coverage → alpha (straight ink color).
      const k = (255 - img.data[o + 1]) / (255 - 0x10);
      img.data.set([0xc8, 0x10, 0x2e, Math.round(255 * Math.min(1, k))], o);
    }
    return img;
  };

  it('G14 on a transparent background: the background + 1 color, auto and line mode', () => {
    for (const over of [{}, { paletteMode: 'line' as const, lineIds: ['red-heart-super-saver'] }, { maxColors: 4 }]) {
      const { c } = chart(transparentLogo(), over);
      expect(c.palette.length).toBe(2);
      expect(c.palette.filter((p) => p.role === 'background').length).toBe(1);
      expect(c.palette.some((p) => p.protected)).toBe(false);
    }
  });

  it('a blurred logo (2–4 px ramps) still gives 2 colors; a designed 2 px outline is kept', () => {
    expect(chart(blur3(blur3(logo(600, 400))), { imageKind: 'flat' }).c.palette.length).toBe(2);
    expect(chart(blur3(blur3(blur3(logo(600, 400)))), { imageKind: 'flat' }).c.palette.length).toBe(2);
    // Red disc with a 2 px pink outline on white, one pixel per stitch.
    const img = solid(160, 160, '#ffffff');
    fillDisc(img, 80, 80, 52, '#ff9fae');
    fillDisc(img, 80, 80, 50, '#e00020');
    const { c } = chart(img, { imageKind: 'flat' }, { gauge: SQUARE, stitches: 160 });
    expect(c.palette.map((p) => p.hex).sort()).toEqual(['#e00020', '#ff9fae', '#ffffff']);
  });

  it('yarn-line mode with auto K: a one-color subject on transparency keeps its own nearest yarn', () => {
    const img = fromFn(120, 120, () => [0, 0, 0, 0]);
    fillDisc(img, 60, 60, 40, '#3a6fd9');
    const { c } = chart(img, { paletteMode: 'line', lineIds: ['red-heart-super-saver'] });
    expect(c.palette.map((p) => p.yarn!.id).sort()).toEqual(['red-heart-super-saver:0311', nearestYarnIn('#3a6fd9', RHSS.yarns)!.yarn.id].sort());
  });

  it('a palette far from the picture does not collapse it into "details"', () => {
    const csv = '#ff0000,Red\n#00aa00,Green\n#0000ff,Blue\n#ffffff,White\n#000000,Black\n#ffff00,Yellow';
    for (const maxColors of [3, 6, 'auto'] as const) {
      const { c } = chart(photoLike(300, 300, 6), { paletteMode: 'custom', customCsv: csv, maxColors });
      expect(c.salient.reduce((x, y) => x + y, 0)).toBeLessThan(0.01 * c.labels.length);
      expect(c.palette.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('hand edits over every background cell leave no empty background entry; codes stay in population order', () => {
    const img = fromFn(120, 120, () => [0, 0, 0, 0]);
    fillDisc(img, 60, 60, 30, '#3a6fd9');
    const { s } = chart(img);
    const green: ColorRef = { hex: '#00ff00' };
    const overrides = [];
    for (let i = 0; i < s.cols * s.rows; i++) if (s.background[i]) overrides.push({ cell: i, color: green });
    const { c } = chart(img, {}, { edits: { baseCols: s.cols, baseRows: s.rows, overrides, locked: [] } });
    expect(c.palette.some((p) => p.role === 'background')).toBe(false);
    expectEColor(c);
    const pop = c.palette.map((_, k) => c.labels.filter((l) => l === k).length);
    for (let k = 1; k < pop.length; k++) expect(pop[k]).toBeLessThanOrEqual(pop[k - 1]);
  });

  it('at most 200 hand-edit colors (labels are bytes): the rest take the nearest kept one, with a warning', () => {
    const { s } = chart(photoLike(300, 360, 2));
    const overrides = Array.from({ length: 300 }, (_, k) => ({ cell: k * 7, color: { hex: `#${(k * 55871).toString(16).padStart(6, '0').slice(-6)}` } }));
    const { c } = chart(photoLike(300, 360, 2), {}, { edits: { baseCols: s.cols, baseRows: s.rows, overrides, locked: [] } });
    expectEColor(c);
    expect(c.palette.length).toBeLessThan(255);
    expect(c.issues.map((i) => i.code)).toContain('W_OVERRIDE_COLORS');
  });

  it('the paint order of hand edits does not change the result', () => {
    const { s } = chart(photoLike(300, 360, 2));
    const o = ['#e01b2e', '#00a0ff', '#f7e017', '#6b3fa0'].flatMap((hex, k) => Array.from({ length: 5 }, (_, q) => ({ cell: 40 * k + q, color: { hex } })));
    const e1: ChartEdits = { baseCols: s.cols, baseRows: s.rows, overrides: o, locked: [] };
    const e2: ChartEdits = { ...e1, overrides: [...o].reverse() };
    for (const over of [{ maxColors: 6 }, { maxColors: 6, paletteMode: 'line' as const, lineIds: ['red-heart-super-saver'] }]) {
      expect(colorizeHash(chart(photoLike(300, 360, 2), over, { edits: e2 }).c)).toBe(colorizeHash(chart(photoLike(300, 360, 2), over, { edits: e1 }).c));
    }
  });

  it('a hand edit never maps to a textured shade unless it names that yarn', () => {
    const { s } = chart(photoLike(200, 200, 3));
    const grey: ColorRef = { hex: '#9e9e93' };
    const line = { paletteMode: 'line' as const, lineIds: ['red-heart-super-saver'], maxColors: 6 };
    const a = chart(photoLike(200, 200, 3), line, { edits: { baseCols: s.cols, baseRows: s.rows, overrides: [{ cell: 0, color: grey }], locked: [] } }).c;
    expect(a.palette[a.labels[0]].yarn!.textured).toBeUndefined();
    const named: ColorRef = { hex: '#9e9e93', yarnId: 'red-heart-super-saver:0400' };
    const b = chart(photoLike(200, 200, 3), line, { edits: { baseCols: s.cols, baseRows: s.rows, overrides: [{ cell: 0, color: named }], locked: [] } }).c;
    expect(b.palette[b.labels[0]].yarn!.id).toBe('red-heart-super-saver:0400');
  });

  it('a hand edit with the yarn id a center is named after maps to that center (§5.5.5)', () => {
    const plain = chart(photoLike(300, 360, 2), { maxColors: 6 }).c;
    const a = plain.palette[0];
    const { s } = chart(photoLike(300, 360, 2));
    const ref: ColorRef = { hex: a.yarn!.hex, yarnId: a.yarn!.id };
    const { c } = chart(photoLike(300, 360, 2), { maxColors: 6 }, { edits: { baseCols: s.cols, baseRows: s.rows, overrides: [{ cell: 3, color: ref }], locked: [] } });
    expect(c.palette.filter((p) => p.yarn?.id === a.yarn!.id).length).toBe(1);
    expect(c.palette[c.labels[3]].yarn!.id).toBe(a.yarn!.id);
    // Two hand edits of one color but different yarn ids share one entry too.
    const two = chart(photoLike(300, 360, 2), { maxColors: 6 }, {
      edits: { baseCols: s.cols, baseRows: s.rows, overrides: [{ cell: 1, color: { hex: '#FF00FF' } }, { cell: 2, color: { hex: '#ff00ff', yarnId: 'red-heart-super-saver:0390' } }], locked: [] },
    }).c;
    expect(two.labels[1]).toBe(two.labels[2]);
  });

  it('edits with an invalid size are dropped with W_EDITS_INVALID; remapEdits tolerates missing arrays', () => {
    const { c } = chart(photoLike(100, 100, 1), {}, { edits: { baseCols: 0, baseRows: 5, overrides: [{ cell: 0, color: { hex: '#00ff00' } }], locked: [] } });
    expect(c.issues.map((i) => i.code)).toContain('W_EDITS_INVALID');
    expect(remapEdits({ baseCols: 2, baseRows: 2 } as ChartEdits, 4, 4)).toEqual({ baseCols: 4, baseRows: 4, overrides: [], locked: [] });
  });

  it('a custom CSV with max colors auto is a fixed palette: every row that is nearest to some cell is used', () => {
    const img = solid(120, 120, '#ff0000');
    fillRect(img, 0, 0, 60, 60, '#0000ff');
    fillRect(img, 60, 60, 60, 60, '#00aa00');
    fillRect(img, 0, 60, 60, 60, '#ffff00');
    const csv = '#ff0000,Red\n#00aa00,Green\n#0000ff,Blue\n#ffff00,Yellow\n#000000,Black';
    const { c } = chart(img, { paletteMode: 'custom', customCsv: csv });
    expect(c.palette.map((p) => p.name).sort()).toEqual(['Blue', 'Green', 'Red', 'Yellow']);
  });
});
