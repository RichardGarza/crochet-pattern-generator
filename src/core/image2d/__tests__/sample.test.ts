import { describe, expect, it } from 'vitest';
import { addNoise, fromFn, solid, upscale } from '../../../test/rgba';
import type { ChartSettings } from '../../../types/chart';
import type { RgbaImage } from '../../../types/geometry';
import { deltaE00Hex, linearRgbToHex, srgb8ToLinear } from '../../kernel/color';
import { decodePng, encodePng } from '../../kernel/png';
import { analyzeImage } from '../kind';
import { NO_LABEL, despeckleLabels, poolLabels } from '../labels';
import { DEFAULT_WIDTH_STITCHES, prepareKey, prepareWork, sampleCells, sampleHash, sampleImage, type SampleRequest } from '../sample';
import { applyCrop } from '../crop';
import { SPRITE_PALETTE, characterSprite, logo, photoLike } from './images';

/** Worsted sc, 13.5 sts × 16 rows per 4 in (Table A). */
const WORSTED = { cell: { w: 4 / 13.5, h: 4 / 16 }, hSc: 4 / 16 };

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
    referenceLineId: 'rhss',
    detail: 'balanced',
    dither: 'off',
    imageKind: 'auto',
    background: 'keep',
    applyRepeats: 'auto',
    roundLean: { mode: 'note', stPerRnd: 0 },
    ...over,
  };
}

function req(image: RgbaImage, over: Partial<ChartSettings> = {}, extra: Partial<SampleRequest> = {}): SampleRequest {
  return { image, settings: settings(over), gauge: WORSTED, ...extra };
}

function cellHex(s: ReturnType<typeof sampleImage>, i: number, j: number): string {
  const o = (i * s.cols + j) * 3;
  return linearRgbToHex(s.colors.lin[o], s.colors.lin[o + 1], s.colors.lin[o + 2]);
}

function spriteHex(img: RgbaImage, x: number, y: number): string {
  const o = (y * img.w + x) * 4;
  return linearRgbToHex(srgb8ToLinear(img.data[o]), srgb8ToLinear(img.data[o + 1]), srgb8ToLinear(img.data[o + 2]));
}

describe('sampleImage — photo sampling with non-square cells (§2.3.3, §2.3.4)', () => {
  it('G2 sizing through the pipeline: 1200 × 1500, 40 × 50 in, worsted sc ⇒ 135 × 200', () => {
    const s = sampleImage(req(photoLike(1200, 1500, 2), { widthIn: 40, heightIn: 50, lockAspect: false }));
    expect(s.kind).toBe('photo');
    expect([s.cols, s.rows]).toEqual([135, 200]);
    expect(s.size).toMatchObject({ cols: 135, rows: 200, borderRounds: 0 });
    expect(s.cells.w * s.cells.h).toBe(135 * 200);
    expect(s.colors.feat.length).toBe(135 * 200 * 3);
  });

  it('each cell averages its own non-square source rectangle (W/cols × H/rows px)', () => {
    // Pixel (x, y) encodes its column in red and its row in green. 12 in wide in worsted sc: 41 columns of
    // 0.296 in; the 6 in height gives 24 rows of 0.25 in — so a cell covers 5.85 × 5 px of the picture.
    const img = fromFn(240, 120, (x, y) => [x, y * 2, 0]);
    const s = sampleImage(req(img, { widthIn: 12 }));
    expect(s.cols).toBe(41); // 12 in / (4/13.5)
    expect(s.rows).toBe(24); // rows from the row height, not cols·aspect (= 20.5)
    // Cells are 240/41 ≈ 5.85 px wide and 120/24 = 5 px tall.
    expect(s.xs.end[0] - s.xs.start[0]).toBeCloseTo(240 / 41, 9);
    expect(s.ys.end[0] - s.ys.start[0]).toBeCloseTo(5, 9);
    // Green (rows) is constant along x and grows with the row: the cell row average of 2y.
    for (const i of [0, 7, 23]) {
      const meanLinG = [0, 1, 2, 3, 4].reduce((a, k) => a + srgb8ToLinear(2 * (i * 5 + k)), 0) / 5;
      expect(s.cells.data[(i * s.cols + 3) * 4 + 1]).toBeCloseTo(meanLinG, 5);
    }
  });

  it('works on the ≤ 2048 px analysis image', () => {
    const s = sampleImage(req(photoLike(3000, 1500, 4), { widthIn: 30 }));
    expect([s.work.w, s.work.h]).toEqual([2048, 1024]);
    expect(s.source).toEqual({ w: 3000, h: 1500 });
    expect(s.cols).toBe(101);
  });

  it('applies the crop first', () => {
    const img = fromFn(100, 100, (x) => (x < 50 ? '#ff0000' : '#0000ff'));
    const s = sampleImage(req(img, { widthIn: 3 }, { crop: { x: 50, y: 0, w: 50, h: 100, rotate: 0, flipX: false } }));
    expect(s.source).toEqual({ w: 50, h: 100 });
    expect(cellHex(s, 0, 0)).toBe('#0000ff');
  });
});

describe('sampleImage — sizes', () => {
  it('defaults to 60 stitches wide with a note when no size is given', () => {
    const s = sampleImage(req(photoLike(300, 200, 1)));
    expect(s.cols).toBe(DEFAULT_WIDTH_STITCHES);
    expect(s.issues.map((i) => i.code)).toContain('I_SIZE_DEFAULT');
  });

  it('aspect lock: the width decides when both are given; unlocked, each axis follows its own size', () => {
    const img = photoLike(300, 300, 1);
    const locked = sampleImage(req(img, { widthIn: 10, heightIn: 30, lockAspect: true }));
    expect([locked.cols, locked.rows]).toEqual([34, 40]);
    const free = sampleImage(req(img, { widthIn: 10, heightIn: 30, lockAspect: false }));
    expect([free.cols, free.rows]).toEqual([34, 120]);
    expect(free.issues.map((i) => i.code)).toContain('W_GRID_PROPORTIONS');
  });

  it('sizes include the border, except for tapestry in the round', () => {
    const img = photoLike(1200, 1500, 3);
    const flat = sampleImage(req(img, { widthIn: 40, heightIn: 50, lockAspect: false, border: { widthIn: 1 } }));
    expect(flat.size).toMatchObject({ cols: 128, rows: 192, borderRounds: 4 });
    const round = sampleImage(req(img, { technique: 'sc_tapestry_round', widthIn: 40, heightIn: 50, lockAspect: false, border: { widthIn: 1 } }));
    expect(round.size.borderRounds).toBe(0);
  });

  it('passes technique count rules to the grid (mosaic 12n + 3)', () => {
    const s = sampleImage(req(photoLike(300, 200, 1), { widthIn: 20 }, { colsMult: { m: 12, plus: 3 } }));
    expect((s.cols - 3) % 12).toBe(0);
  });
});

describe('sampleImage — pixel art (§2.3.4)', () => {
  const sprite = characterSprite();
  const art = addNoise(upscale(sprite, 8), 6, 21);

  it('ACCEPTANCE: 32 × 32 sprite upscaled 8× with JPEG-like noise → 32 × 32 grid, 1:1', () => {
    const s = sampleImage(req(art));
    expect(s.kind).toBe('pixel');
    expect([s.cols, s.rows]).toEqual([32, 32]);
    let worst = 0;
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        const got = cellHex(s, y, x);
        const want = spriteHex(sprite, x, y);
        worst = Math.max(worst, deltaE00Hex(got, want));
        // 1:1 — the nearest sprite color of every cell is its own native pixel's color.
        const nearest = [...SPRITE_PALETTE].sort((a, b) => deltaE00Hex(got, a) - deltaE00Hex(got, b))[0];
        expect(nearest, `cell (${x}, ${y})`).toBe(want);
      }
    }
    // The noise averages out over the block interior: no cell is visibly off (ΔE00 < 5).
    expect(worst).toBeLessThan(5);
  });

  it('the finished size follows from the gauge; a requested size is met by whole multiples, with a warning', () => {
    const native = sampleImage(req(art));
    expect([native.cols, native.rows, native.pixelScale]).toEqual([32, 32, 1]);
    expect(native.size.actualW).toBeCloseTo((32 * 4) / 13.5, 9);
    expect(native.size.actualH).toBeCloseTo(8, 9);
    // Non-square stitches: the piece is wider than the picture, said once.
    expect(native.issues.map((i) => i.code)).toEqual(['I_PIXEL_ASPECT']);
    // 20 in wide wants 67.5 → 68 cols ⇒ ×2 (64 cols).
    const doubled = sampleImage(req(art, { widthIn: 20 }));
    expect([doubled.cols, doubled.rows, doubled.pixelScale]).toEqual([64, 64, 2]);
    expect(doubled.issues.map((i) => i.code)).toContain('W_PIXEL_SIZE');
    // Each native pixel became 2 × 2 identical cells.
    expect(cellHex(doubled, 0, 0)).toBe(cellHex(doubled, 1, 1));
    expect(doubled.xs.end[0] - doubled.xs.start[0]).toBeCloseTo(4, 9);
    // A size close to the native one: ×1 without a size warning.
    const close = sampleImage(req(art, { widthIn: 9.5 }));
    expect(close.pixelScale).toBe(1);
    expect(close.issues.map((i) => i.code)).not.toContain('W_PIXEL_SIZE');
  });

  it('a technique count rule that the native grid breaks is reported', () => {
    const s = sampleImage(req(art, {}, { colsMult: { m: 12, plus: 3 } }));
    expect(s.cols).toBe(32);
    expect(s.issues.map((i) => i.code)).toContain('W_PIXEL_MULTIPLE');
  });

  it('a transparent surround becomes background cells, 1:1', () => {
    const cut = fromFn(32, 32, (x, y) => {
      const o = (y * 32 + x) * 4;
      return [sprite.data[o], sprite.data[o + 1], sprite.data[o + 2], x >= 8 && x < 24 ? 255 : 0];
    });
    const s = sampleImage(req(upscale(cut, 6)));
    expect(s.kind).toBe('pixel');
    expect(s.bg.source).toBe('alpha');
    for (let x = 0; x < 32; x++) expect(s.background[5 * 32 + x], `col ${x}`).toBe(x >= 8 && x < 24 ? 0 : 1);
  });

  it('"pixel art" chosen for a picture without a grid: one stitch per pixel', () => {
    const s = sampleImage(req(sprite, { imageKind: 'pixel' }));
    expect(s.autoKind).toBe('flat');
    expect(s.kind).toBe('pixel');
    expect([s.cols, s.rows]).toEqual([32, 32]);
    expect(cellHex(s, 15, 16)).toBe(spriteHex(sprite, 16, 15));
  });

  it('"pixel art" chosen for a large picture without a grid falls back to flat art with a warning', () => {
    const s = sampleImage(req(photoLike(1100, 200, 1), { imageKind: 'pixel', widthIn: 10 }));
    expect(s.kind).toBe('flat');
    expect(s.issues.map((i) => i.code)).toContain('W_PIXEL_UNAVAILABLE');
  });

  it('large pixel charts and impossible sizes get the grid warnings', () => {
    const big = sampleImage(req(photoLike(900, 700, 1), { imageKind: 'pixel' }));
    expect([big.cols, big.rows]).toEqual([900, 700]);
    expect(big.issues.map((i) => i.code)).toContain('W_GRID_LARGE');
    const zero = sampleImage(req(art, { widthIn: 0 }));
    expect(zero.cols).toBe(32);
    expect(zero.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['W_GRID_NO_ROOM', 'W_PIXEL_SIZE']));
  });

  it('an override to "photo" samples pixel art at the requested size', () => {
    const s = sampleImage(req(art, { imageKind: 'photo', widthIn: 10 }));
    expect(s.autoKind).toBe('pixel');
    expect(s.kind).toBe('photo');
    expect(s.cols).toBe(34);
  });
});

describe('sampleImage — flat art hands T1.2 what it needs', () => {
  it('the working image and spans pool into cell labels with the thin outline kept', () => {
    // A black 2-px circle outline on white, 300 × 300, charted 30 stitches wide.
    const img = fromFn(300, 300, (x, y) => {
      const d = Math.hypot(x + 0.5 - 150, y + 0.5 - 150);
      return d <= 110 && d > 108 ? '#000000' : '#ffffff';
    });
    const s = sampleImage(req(img, { widthIn: 30 * (4 / 13.5) }));
    expect(s.kind).toBe('flat');
    // Exact colors as labels (what a quantizer gives on clean two-color art).
    const labels = new Uint8Array(s.work.w * s.work.h);
    for (let i = 0; i < labels.length; i++) labels[i] = s.work.data[i * 4] < 0.5 ? 1 : 0;
    const pooled = poolLabels(despeckleLabels(labels, s.work.w, s.work.h), s.work.w, s.work.h, s.xs, s.ys);
    expect(pooled.cols * pooled.rows).toBe(s.cols * s.rows);
    expect(pooled.labels.filter((l) => l === 1).length).toBeGreaterThan(40);
    expect(pooled.labels.includes(NO_LABEL)).toBe(false);
    // The box average alone would lose the outline in most cells (it is ~20% of a cell).
    let darkCells = 0;
    for (let i = 0; i < s.cols * s.rows; i++) if (s.colors.feat[i * 3] < 0.5) darkCells++;
    expect(darkCells).toBe(0);
  });
});

describe('sampleImage — background', () => {
  it('"remove plain background" makes the border-connected background one label outside the colors', () => {
    const img = logo(300, 200, '#c8102e', '#ffffff');
    const s = sampleImage(req(img, { widthIn: 15, background: 'remove' }));
    expect(s.bg.source).toBe('plain');
    expect(s.background[0]).toBe(1);
    const bgShare = s.background.reduce((a, b) => a + b, 0) / s.background.length;
    expect(bgShare).toBeGreaterThan(0.5);
    // Background cells carry the background color.
    expect(cellHex(s, 0, 0)).toBe(s.bg.hex);
  });
});

describe('sampleImage — determinism (G13 for the sampling stages) and PNG fixtures', () => {
  it('10 runs give the same hash', () => {
    for (const image of [art(), logo(320, 240), photoLike(400, 300, 8)]) {
      const r = req(image, { widthIn: 12, background: 'remove' });
      const first = sampleHash(sampleImage(r));
      for (let k = 0; k < 9; k++) expect(sampleHash(sampleImage(r))).toBe(first);
    }
    function art(): RgbaImage {
      return addNoise(upscale(characterSprite(), 8), 6, 4);
    }
  });

  it('a PNG round trip through core/kernel/png gives the same result', () => {
    const img = addNoise(upscale(characterSprite(), 5), 5, 8);
    const back = decodePng(encodePng(img));
    expect(sampleHash(sampleImage(req(back, { widthIn: 12 })))).toBe(sampleHash(sampleImage(req(img, { widthIn: 12 }))));
  });

  it('different settings give different hashes', () => {
    const img = photoLike(200, 200, 1);
    expect(sampleHash(sampleImage(req(img, { widthIn: 12 })))).not.toBe(sampleHash(sampleImage(req(img, { widthIn: 13 }))));
  });

  it('cached stats are reused, and stats of another crop are refused (also a same-size rotation)', () => {
    const img = solid(40, 40, '#123456');
    const stats = analyzeImage(img);
    expect(sampleImage(req(img, { widthIn: 5 }, { stats })).stats).toBe(stats);
    expect(() => sampleImage(req(img, { widthIn: 5 }, { stats, crop: { x: 0, y: 0, w: 20, h: 20, rotate: 0, flipX: false } }))).toThrow(RangeError);
    const sprite = upscale(characterSprite(), 8);
    const crop = { x: 1, y: 1, w: 250, h: 250, rotate: 0 as const, flipX: false };
    const cached = analyzeImage(applyCrop(sprite, crop));
    expect(() => sampleImage(req(sprite, {}, { stats: cached, crop: { ...crop, rotate: 180 } }))).toThrow(RangeError);
  });

  it('prepareWork + sampleCells equals sampleImage; the prepared work is reusable across sizes', () => {
    const r = req(logo(400, 300), { widthIn: 10, background: 'remove' });
    const prepared = prepareWork(r);
    expect(sampleHash(sampleCells(prepared, r))).toBe(sampleHash(sampleImage(r)));
    const r2 = { ...r, settings: { ...r.settings, widthIn: 14 } };
    expect(sampleHash(sampleCells(prepared, r2))).toBe(sampleHash(sampleImage(r2)));
    // The key changes with what prepareWork reads, not with the size.
    expect(prepareKey('src', r)).toBe(prepareKey('src', r2));
    expect(prepareKey('src', r)).not.toBe(prepareKey('src', { ...r, settings: { ...r.settings, background: 'keep' } }));
    expect(prepareKey('src', r)).not.toBe(prepareKey('other', r));
  });

  it('rejects an unknown image kind', () => {
    expect(() => sampleImage(req(solid(10, 10, '#000000'), { imageKind: 'sketch' as ChartSettings['imageKind'] }))).toThrow(RangeError);
  });
});
