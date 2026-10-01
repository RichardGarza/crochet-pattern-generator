import { describe, expect, it } from 'vitest';
import { addNoise, checker, fillDisc, fromFn, gradient, solid, stripes, upscale } from '../../../test/rgba';
import type { RgbaImage } from '../../../types/geometry';
import { applyCrop } from '../crop';
import {
  FLAT_MIN_FLATNESS,
  analyzeImage,
  edgeProfile,
  findAxisLattice,
  imageFingerprint,
  isFlatArt,
  latticeEdges,
} from '../kind';
import { blur3, characterSprite, logo, photoLike, randomSprite, resizeNearest } from './images';

/** Lattice summary for compact assertions. */
function lat(img: RgbaImage): { kind: string; cols?: number; rows?: number; sx?: number; sy?: number } {
  const s = analyzeImage(img);
  return s.lattice ? { kind: s.kind, cols: s.lattice.cols, rows: s.lattice.rows, sx: s.lattice.sx, sy: s.lattice.sy } : { kind: s.kind };
}

/** A sprite pasted onto a larger canvas at (ox, oy). */
function paste(canvas: RgbaImage, img: RgbaImage, ox: number, oy: number): RgbaImage {
  for (let y = 0; y < img.h; y++) {
    canvas.data.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), ((y + oy) * canvas.w + ox) * 4);
  }
  return canvas;
}

describe('edgeProfile', () => {
  it('counts color edges per column boundary and per row boundary', () => {
    // Vertical stripes of 3 px on a 9 × 4 image: boundaries at x = 3 and 6, each crossed by all 4 rows.
    const img = fromFn(9, 4, (x) => (Math.floor(x / 3) % 2 ? '#000000' : '#ffffff'));
    const p = edgeProfile(img);
    expect([...p.ex]).toEqual([0, 0, 0, 4, 0, 0, 4, 0, 0]);
    expect([...p.ey]).toEqual([0, 0, 0, 0]);
    expect(p.uniqueColors).toBe(2);
    expect(p.top16Share).toBe(1);
    // Pixels next to a boundary are not flat: 4 rows × 4 boundary pixels of 36.
    expect(p.flatness).toBeCloseTo(20 / 36, 9);
  });

  it('counts colors up to 256 and reports more as 257', () => {
    expect(edgeProfile(gradient(256, 1, '#000000', '#ffffff')).uniqueColors).toBe(256);
    expect(edgeProfile(photoLike(64, 64, 1)).uniqueColors).toBe(257);
  });

  it('treats transparent pixels as one color', () => {
    const img = fromFn(4, 4, (x, y) => (x < 2 ? [10 * y, 0, 0, 0] : '#00ff00'));
    const p = edgeProfile(img);
    expect(p.uniqueColors).toBe(2);
    expect(p.translucentShare).toBe(0.5);
    expect(p.ex[2]).toBe(4);
  });
});

describe('findAxisLattice', () => {
  it('finds period and phase of an impulse train', () => {
    const e = new Int32Array(200);
    for (let x = 5; x < 200; x += 10) e[x] = 20;
    const l = findAxisLattice(e)!;
    expect(l.s).toBe(10);
    expect(l.phase).toBeCloseTo(5, 6);
    expect(l.coverage).toBeCloseTo(1, 6);
    expect(l.occupancy).toBe(1);
  });

  it('prefers the true period over its divisors and multiples', () => {
    const e = new Int32Array(240);
    // Lines every 8 px, all carrying edges, with uneven strength: the multiple 16 misses half of them; the
    // divisor 4 explains them too but is finer.
    for (let x = 8; x < 240; x += 8) e[x] = x % 16 === 0 ? 30 : 6;
    expect(findAxisLattice(e)!.s).toBe(8);
  });

  it('finds fractional periods', () => {
    const e = new Int32Array(250);
    for (let k = 1; k < 32; k++) e[Math.ceil(k * 7.8125)] = 16;
    const l = findAxisLattice(e)!;
    expect(l.s).toBeGreaterThan(7.78);
    expect(l.s).toBeLessThan(7.85);
    expect(l.coverage).toBeGreaterThan(0.95);
  });

  it('merges a blurred boundary into one edge at its center', () => {
    const e = new Int32Array(160);
    for (let x = 10; x < 160; x += 10) {
      e[x - 1] = 9;
      e[x] = 10;
      e[x + 1] = 9;
    }
    const l = findAxisLattice(e)!;
    expect(l.s).toBe(10);
    expect(l.phase).toBeCloseTo(0, 6);
  });

  it('returns undefined without evidence or without room for 8 blocks of 3 px', () => {
    expect(findAxisLattice(new Int32Array(100))).toBeUndefined();
    const short = new Int32Array(20);
    short[3] = 5;
    short[6] = 5;
    short[9] = 5;
    expect(findAxisLattice(short)).toBeUndefined();
  });

  it('latticeEdges keeps partial end blocks only when at least half a block', () => {
    expect([...latticeEdges({ s: 8, phase: 5, coverage: 1, rawShare: 1, occupied: 3, occupancy: 1 }, 32)]).toEqual([0, 5, 13, 21, 29]);
    expect([...latticeEdges({ s: 8, phase: 3, coverage: 1, rawShare: 1, occupied: 3, occupancy: 1 }, 32)]).toEqual([3, 11, 19, 27, 32]);
  });
});

describe('pixel art (§2.3.4)', () => {
  it('ACCEPTANCE: a 32 × 32 sprite upscaled 8× with JPEG-like noise → a 32 × 32 grid', () => {
    for (const [name, img] of [
      ['character', characterSprite()],
      ['random', randomSprite(32, 32, 11)],
    ] as const) {
      const noisy = addNoise(upscale(img, 8), 6, 101);
      expect(lat(noisy), name).toEqual({ kind: 'pixel', cols: 32, rows: 32, sx: 8, sy: 8 });
      // Softened edges (resampling, JPEG) as well.
      expect(lat(addNoise(blur3(upscale(img, 8)), 4, 102)), `${name} blurred`).toEqual({ kind: 'pixel', cols: 32, rows: 32, sx: 8, sy: 8 });
    }
  });

  it('accepts clean art at every whole factor from 3 to 16', () => {
    for (const f of [3, 4, 5, 7, 8, 12, 16]) {
      expect(lat(upscale(characterSprite(), f)), `×${f}`).toEqual({ kind: 'pixel', cols: 32, rows: 32, sx: f, sy: f });
    }
  });

  it('accepts a non-integer scale (32 px → 250 px)', () => {
    const r = lat(addNoise(resizeNearest(characterSprite(), 250, 250), 4, 7));
    expect(r.kind).toBe('pixel');
    expect([r.cols, r.rows]).toEqual([32, 32]);
    expect(r.sx!).toBeCloseTo(7.8125, 1);
  });

  it('accepts a sprite on a larger plain canvas', () => {
    const big = paste(solid(512, 512, '#3a6fd9'), upscale(characterSprite(), 4), 160, 200);
    expect(lat(big)).toEqual({ kind: 'pixel', cols: 128, rows: 128, sx: 4, sy: 4 });
  });

  it('follows the phase of an off-grid crop; partial edge blocks count when at least half a block', () => {
    const art = upscale(characterSprite(), 8);
    // 3 px cut from the left and top: the first block keeps 5 px ≥ 4 → still 32 blocks.
    const c3 = applyCrop(art, { x: 3, y: 3, w: 253, h: 253, rotate: 0, flipX: false });
    const s3 = analyzeImage(c3);
    expect(s3.kind).toBe('pixel');
    expect([s3.lattice!.cols, s3.lattice!.rows]).toEqual([32, 32]);
    expect(s3.lattice!.phaseX).toBeCloseTo(5, 6);
    expect([...s3.lattice!.xEdges.slice(0, 3)]).toEqual([0, 5, 13]);
    // 5 px cut: 3 px remain of the first block (< 4) → it is dropped.
    const c5 = applyCrop(art, { x: 5, y: 0, w: 251, h: 256, rotate: 0, flipX: false });
    const s5 = analyzeImage(c5);
    expect([s5.lattice!.cols, s5.lattice!.rows]).toEqual([31, 32]);
    expect(s5.lattice!.xEdges[0]).toBe(3);
  });

  it('accepts a sprite with a transparent surround', () => {
    const sprite = characterSprite();
    const cut = fromFn(32, 32, (x, y) => {
      const o = (y * 32 + x) * 4;
      const inside = (x - 16) ** 2 + (y - 15) ** 2 <= 121;
      return [sprite.data[o], sprite.data[o + 1], sprite.data[o + 2], inside ? 255 : 0];
    });
    expect(lat(upscale(cut, 6))).toEqual({ kind: 'pixel', cols: 32, rows: 32, sx: 6, sy: 6 });
  });

  it('a checkerboard of 8 px squares is pixel art', () => {
    expect(lat(checker(256, 256, 8, '#000000', '#ffffff'))).toEqual({ kind: 'pixel', cols: 32, rows: 32, sx: 8, sy: 8 });
  });

  it('accepts noisy pixel art with pure black (OKLab chroma is unstable near black)', () => {
    const palette = ['#000000', '#ffffff', '#d93a3a', '#3a8f4b', '#f2c12e', '#3a6fd9'];
    for (const k of [4, 6, 8]) {
      for (const a of [4, 6]) {
        expect(lat(addNoise(upscale(randomSprite(32, 32, 2, palette), k), a, 1)), `×${k} ±${a}`).toEqual({ kind: 'pixel', cols: 32, rows: 32, sx: k, sy: k });
      }
    }
  });

  it('1-px lines on a lattice (graph paper) are not pixel art: the margins would hide them', () => {
    for (const p of [6, 10, 16, 32]) {
      const graph = fromFn(320, 320, (x, y) => (x % p === 0 || y % p === 0 ? '#000000' : '#ffffff'));
      expect(analyzeImage(graph).kind, `every ${p} px`).not.toBe('pixel');
    }
  });

  it('stays fast on a long axis (coarse-to-fine period search)', { timeout: 60_000, retry: 2 }, () => {
    const img = upscale(randomSprite(1500, 5, 1), 8); // 12000 × 40
    const t = performance.now();
    analyzeImage(img);
    expect(performance.now() - t).toBeLessThan(3000);
  });

  it('rejects heavy noise (blocks no longer uniform)', () => {
    const s = analyzeImage(addNoise(upscale(characterSprite(), 8), 14, 3));
    expect(s.kind).not.toBe('pixel');
    expect(s.lattice?.accepted).toBe(false);
  });

  it('does not detect native-resolution art (period 1 < 3): it is flat art', () => {
    expect(lat(characterSprite()).kind).toBe('flat');
  });
});

describe('flat art vs photo (§2.3.4)', () => {
  it('a two-color logo with anti-aliased edges is flat, not pixel art', () => {
    const s = analyzeImage(logo(400, 300));
    expect(s.kind).toBe('flat');
    expect(s.uniqueColors).toBeLessThanOrEqual(256);
    expect(s.top16Share).toBeGreaterThanOrEqual(0.9);
  });

  it('a logo with mild JPEG-like noise is flat by flatness', () => {
    const s = analyzeImage(addNoise(logo(400, 300), 1, 5));
    expect(s.uniqueColors).toBe(257);
    expect(s.flatness).toBeGreaterThanOrEqual(FLAT_MIN_FLATNESS);
    expect(s.kind).toBe('flat');
  });

  it('a photo-like picture is a photo', () => {
    const s = analyzeImage(photoLike(400, 300, 1));
    expect(s.kind).toBe('photo');
    expect(s.flatness).toBeLessThan(0.1);
  });

  it('a flag (axis-aligned bands, few edges) is flat, not pixel art', () => {
    const flag = fromFn(500, 300, (x, y) => ((x >= 150 && x < 210) || (y >= 120 && y < 180) ? '#fecc00' : '#006aa7'));
    expect(lat(flag).kind).toBe('flat');
    expect(lat(stripes(300, 300, [['#ffffff', 40], ['#cc0000', 20]])).kind).toBe('flat');
  });

  it('a grid-aligned logo with a curve is flat, not pixel art', () => {
    const g = fromFn(320, 320, (x, y) => ((Math.floor(x / 32) * 7 + Math.floor(y / 32) * 3) % 5 === 0 ? '#c8102e' : '#ffffff'));
    fillDisc(g, 160, 160, 70, '#123456');
    expect(lat(g).kind).toBe('flat');
    expect(lat(blur3(g)).kind).toBe('flat');
  });

  it('isFlatArt applies both rules', () => {
    expect(isFlatArt({ uniqueColors: 256, top16Share: 0.9, flatness: 0 })).toBe(true);
    expect(isFlatArt({ uniqueColors: 257, top16Share: 0, flatness: 0.75 })).toBe(true);
    expect(isFlatArt({ uniqueColors: 256, top16Share: 0.89, flatness: 0.74 })).toBe(false);
    expect(isFlatArt({ uniqueColors: 257, top16Share: 1, flatness: 0.5 })).toBe(false);
  });

  it('is deterministic (10 runs give identical statistics)', () => {
    const img = addNoise(upscale(randomSprite(32, 32, 5), 8), 6, 9);
    const first = JSON.stringify(analyzeImage(img), (_k, v: unknown) => (ArrayBuffer.isView(v) ? [...(v as Int32Array)] : v));
    for (let i = 0; i < 9; i++) {
      expect(JSON.stringify(analyzeImage(img), (_k, v: unknown) => (ArrayBuffer.isView(v) ? [...(v as Int32Array)] : v))).toBe(first);
    }
  });

  it('the fingerprint tells a crop from its rotation or flip', () => {
    const img = upscale(randomSprite(32, 32, 3), 8);
    const base = { x: 1, y: 1, w: 250, h: 250, flipX: false };
    const a = imageFingerprint(applyCrop(img, { ...base, rotate: 0 }));
    expect(imageFingerprint(applyCrop(img, { ...base, rotate: 0 }))).toBe(a);
    expect(imageFingerprint(applyCrop(img, { ...base, rotate: 180 }))).not.toBe(a);
    expect(imageFingerprint(applyCrop(img, { ...base, rotate: 0, flipX: true }))).not.toBe(a);
    expect(imageFingerprint(applyCrop(img, { ...base, x: 2, rotate: 0 }))).not.toBe(a);
  });

  it('handles tiny images', () => {
    expect(analyzeImage(solid(1, 1, '#123456')).kind).toBe('flat');
    expect(analyzeImage(solid(3, 1, '#123456')).kind).toBe('flat');
  });
});
