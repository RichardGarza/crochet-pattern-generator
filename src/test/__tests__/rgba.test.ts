import { describe, expect, it } from 'vitest';
import {
  addNoise,
  blank,
  checker,
  clone,
  colorCounts,
  fillDisc,
  fillRect,
  fromFn,
  fromRows,
  gradient,
  hexAt,
  pixelAt,
  replaceRandomPixels,
  sameImage,
  setPixel,
  solid,
  stripes,
  tile,
  upscale,
} from '../rgba';

describe('synthetic RgbaImage helpers', () => {
  it('blank and solid make images of the right size', () => {
    const b = blank(3, 2);
    expect(b.w).toBe(3);
    expect(b.h).toBe(2);
    expect(b.data).toBeInstanceOf(Uint8ClampedArray);
    expect(Array.from(b.data)).toEqual(new Array(24).fill(0));
    const s = solid(2, 2, '#c8a27a');
    expect(Array.from(s.data)).toEqual([200, 162, 122, 255, 200, 162, 122, 255, 200, 162, 122, 255, 200, 162, 122, 255]);
    expect(pixelAt(solid(1, 1, [1, 2, 3]), 0, 0)).toEqual([1, 2, 3, 255]);
    expect(pixelAt(solid(1, 1, [1, 2, 3, 4]), 0, 0)).toEqual([1, 2, 3, 4]);
    expect(() => blank(0, 3)).toThrow();
    expect(() => blank(2.5, 3)).toThrow();
  });

  it('fromFn is row-major from the top-left', () => {
    const img = fromFn(3, 2, (x, y) => [x, y, 0]);
    expect(pixelAt(img, 2, 0)).toEqual([2, 0, 0, 255]);
    expect(pixelAt(img, 0, 1)).toEqual([0, 1, 0, 255]);
    expect(Array.from(img.data.subarray(8, 12))).toEqual([2, 0, 0, 255]);
    expect(() => pixelAt(img, 3, 0)).toThrow(RangeError);
  });

  it('fromRows reads text charts top-down (the §2.7.3 golden chart)', () => {
    const img = fromRows(['BAAAA', 'ABBBA', 'AABAA'], { A: '#ffffff', B: '#cc0000' });
    expect(img.w).toBe(5);
    expect(img.h).toBe(3);
    expect(hexAt(img, 0, 0)).toBe('#cc0000');
    expect(hexAt(img, 4, 0)).toBe('#ffffff');
    expect(hexAt(img, 2, 2)).toBe('#cc0000');
    expect(colorCounts(img)).toEqual([
      { hex: '#ffffff', count: 10 },
      { hex: '#cc0000', count: 5 },
    ]);
    expect(() => fromRows(['AB', 'A'], { A: '#ffffff', B: '#000000' })).toThrow(/same length/);
    expect(() => fromRows(['AZ'], { A: '#ffffff' })).toThrow(/no color/);
  });

  it('setPixel, fillRect and fillDisc draw in place and clip', () => {
    const img = solid(8, 8, '#000000');
    setPixel(img, 1, 1, '#ff0000');
    setPixel(img, -1, 99, '#ff0000');
    expect(hexAt(img, 1, 1)).toBe('#ff0000');
    expect(fillRect(img, 6, 6, 10, 10, '#00ff00')).toBe(img);
    expect(colorCounts(img).find((c) => c.hex === '#00ff00')?.count).toBe(4);
    const disc = fillDisc(solid(20, 20, '#000000'), 10, 10, 6, '#ffffff');
    const area = colorCounts(disc).find((c) => c.hex === '#ffffff')?.count ?? 0;
    expect(Math.abs(area - Math.PI * 36)).toBeLessThan(8);
    expect(hexAt(disc, 10, 10)).toBe('#ffffff');
    expect(hexAt(disc, 0, 0)).toBe('#000000');
    // symmetric about the center
    for (let y = 0; y < 20; y++) {
      for (let x = 0; x < 20; x++) expect(hexAt(disc, x, y)).toBe(hexAt(disc, 19 - x, 19 - y));
    }
  });

  it('checker, stripes and gradient follow their definitions', () => {
    const c = checker(4, 4, 2, '#ffffff', '#000000');
    expect(hexAt(c, 0, 0)).toBe('#ffffff');
    expect(hexAt(c, 2, 0)).toBe('#000000');
    expect(hexAt(c, 2, 2)).toBe('#ffffff');
    const s = stripes(2, 12, [
      ['#ffffff', 4],
      ['#000000', 2],
    ]);
    const column = Array.from({ length: 12 }, (_, y) => (hexAt(s, 0, y) === '#ffffff' ? 'A' : 'B')).join('');
    expect(column).toBe('AAAABBAAAABB');
    expect(() => stripes(2, 2, [])).toThrow();
    const g = gradient(5, 1, '#000000', '#ffffff');
    expect([0, 1, 2, 3, 4].map((x) => pixelAt(g, x, 0)[0])).toEqual([0, 64, 128, 191, 255]);
    // every channel is interpolated on its own, alpha included, and every row is the same
    const mixed = gradient(3, 2, [0, 100, 255, 0], [200, 0, 55, 255]);
    expect(pixelAt(mixed, 0, 0)).toEqual([0, 100, 255, 0]);
    expect(pixelAt(mixed, 1, 0)).toEqual([100, 50, 155, 128]);
    expect(pixelAt(mixed, 2, 1)).toEqual([200, 0, 55, 255]);
    expect(pixelAt(mixed, 1, 1)).toEqual(pixelAt(mixed, 1, 0));
    expect(pixelAt(gradient(1, 1, '#102030', '#ffffff'), 0, 0)).toEqual([16, 32, 48, 255]);
  });

  it('upscale repeats pixels and tile repeats images', () => {
    const src = fromRows(['AB', 'BA'], { A: '#ffffff', B: '#000000' });
    const up = upscale(src, 3);
    expect(up.w).toBe(6);
    expect(up.h).toBe(6);
    for (let y = 0; y < 6; y++) {
      for (let x = 0; x < 6; x++) expect(hexAt(up, x, y)).toBe(hexAt(src, Math.floor(x / 3), Math.floor(y / 3)));
    }
    expect(sameImage(upscale(src, 1), src)).toBe(true);
    expect(() => upscale(src, 0)).toThrow();
    // all four channels travel together, unswapped (a non-square image with four different channel values)
    const colorful = fromFn(3, 2, (x, y) => [10 + x, 100 + y, 200 + x * y, 50 + 7 * x + y]);
    const big = upscale(colorful, 2);
    expect([big.w, big.h]).toEqual([6, 4]);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 6; x++) expect(pixelAt(big, x, y)).toEqual(pixelAt(colorful, Math.floor(x / 2), Math.floor(y / 2)));
    }
    const tiled = tile(colorful, 7, 5);
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 7; x++) expect(pixelAt(tiled, x, y)).toEqual(pixelAt(colorful, x % 3, y % 2));
    }
    const t = tile(src, 5, 3);
    expect(t.w).toBe(5);
    expect(t.h).toBe(3);
    for (let y = 0; y < 3; y++) {
      for (let x = 0; x < 5; x++) expect(hexAt(t, x, y)).toBe(hexAt(src, x % 2, y % 2));
    }
  });

  it('addNoise is seeded, bounded and leaves the input and alpha alone', () => {
    const base = solid(16, 16, [100, 150, 200, 77]);
    const a = addNoise(base, 6, 1);
    const b = addNoise(base, 6, 1);
    const c = addNoise(base, 6, 2);
    expect(sameImage(a, b)).toBe(true);
    expect(sameImage(a, c)).toBe(false);
    expect(sameImage(base, solid(16, 16, [100, 150, 200, 77]))).toBe(true);
    for (let o = 0; o < a.data.length; o += 4) {
      expect(Math.abs(a.data[o] - 100)).toBeLessThanOrEqual(6);
      expect(Math.abs(a.data[o + 1] - 150)).toBeLessThanOrEqual(6);
      expect(Math.abs(a.data[o + 2] - 200)).toBeLessThanOrEqual(6);
      expect(a.data[o + 3]).toBe(77);
    }
    expect(colorCounts(a).length).toBeGreaterThan(20);
  });

  it('replaceRandomPixels changes about the requested fraction', () => {
    const base = solid(100, 100, '#ffffff');
    const noisy = replaceRandomPixels(base, 0.03, ['#000000'], 5);
    const black = colorCounts(noisy).find((c) => c.hex === '#000000')?.count ?? 0;
    expect(black).toBeGreaterThan(200);
    expect(black).toBeLessThan(400);
    expect(sameImage(noisy, replaceRandomPixels(base, 0.03, ['#000000'], 5))).toBe(true);
    expect(sameImage(replaceRandomPixels(base, 0, ['#000000'], 5), base)).toBe(true);
    expect(() => replaceRandomPixels(base, 0.5, [], 1)).toThrow();
  });

  it('clone and sameImage compare by content', () => {
    const a = fromFn(4, 3, (x, y) => [x * 10, y * 10, 5]);
    const b = clone(a);
    expect(b).not.toBe(a);
    expect(b.data).not.toBe(a.data);
    expect(sameImage(a, b)).toBe(true);
    setPixel(b, 0, 0, '#123456');
    expect(sameImage(a, b)).toBe(false);
    expect(sameImage(blank(2, 3), blank(3, 2))).toBe(false);
  });
});
