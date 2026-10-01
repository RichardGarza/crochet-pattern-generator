import { describe, expect, it } from 'vitest';
import { checker, fromFn, solid } from '../../../test/rgba';
import { srgb8ToLinear } from '../../kernel/color';
import { ANALYSIS_MAX_SIDE, analysisImage, blankLinear, boxAverage, boxAverageRgba, limitLongSide, toLinearImage, toRgbaImage, uniformSpans } from '../linear';
import type { LinearImage } from '../types';

/** A one-channel ramp image: pixel (x, y) has linear value v(x, y) in R, G and B, alpha 1. */
function linearFrom(w: number, h: number, v: (x: number, y: number) => number, a: (x: number, y: number) => number = () => 1): LinearImage {
  const img = blankLinear(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4;
      const al = a(x, y);
      img.data[p] = v(x, y) * al;
      img.data[p + 1] = v(x, y) * al;
      img.data[p + 2] = v(x, y) * al;
      img.data[p + 3] = al;
    }
  }
  return img;
}

describe('toLinearImage / toRgbaImage', () => {
  it('decodes sRGB to linear light and premultiplies by alpha', () => {
    const img = toLinearImage(fromFn(2, 1, (x) => (x === 0 ? [255, 128, 0, 255] : [255, 255, 255, 51])));
    expect(img.data[0]).toBeCloseTo(1, 6);
    expect(img.data[1]).toBeCloseTo(srgb8ToLinear(128), 6);
    expect(img.data[2]).toBe(0);
    expect(img.data[3]).toBe(1);
    expect(img.data[4]).toBeCloseTo(0.2, 6);
    expect(img.data[7]).toBeCloseTo(0.2, 6);
  });

  it('round-trips every 8-bit value for opaque pixels', () => {
    const src = fromFn(256, 1, (x) => [x, 255 - x, (x * 7) % 256]);
    const back = toRgbaImage(toLinearImage(src));
    expect([...back.data]).toEqual([...src.data]);
  });

  it('rejects malformed images', () => {
    expect(() => toLinearImage({ w: 2, h: 2, data: new Uint8ClampedArray(15) })).toThrow(RangeError);
    expect(() => toLinearImage({ w: 0, h: 2, data: new Uint8ClampedArray(0) })).toThrow(RangeError);
  });
});

describe('uniformSpans', () => {
  it('tiles [0, size) exactly with equal fractional intervals', () => {
    const s = uniformSpans(3, 10);
    expect([...s.start]).toEqual([0, 10 / 3, 20 / 3]);
    expect([...s.end]).toEqual([10 / 3, 20 / 3, 10]);
  });

  it('rejects bad counts and sizes', () => {
    expect(() => uniformSpans(0, 10)).toThrow(RangeError);
    expect(() => uniformSpans(2.5, 10)).toThrow(RangeError);
    expect(() => uniformSpans(2, 0)).toThrow(RangeError);
  });
});

describe('boxAverage — exact fractional-area averages (§2.3.4 "Photo")', () => {
  it('weights each pixel by the area of its overlap with the cell', () => {
    // 10 × 1 ramp v = x; 3 cells of 10/3 px. Cell 0 covers pixels 0, 1, 2 fully and 1/3 of pixel 3.
    const img = linearFrom(10, 1, (x) => x / 10);
    const out = boxAverage(img, uniformSpans(3, 10), uniformSpans(1, 1));
    const expected0 = (0 + 0.1 + 0.2 + 0.3 / 3) / (10 / 3);
    const expected1 = ((2 / 3) * 0.3 + 0.4 + 0.5 + (2 / 3) * 0.6) / (10 / 3);
    const expected2 = (0.6 / 3 + 0.7 + 0.8 + 0.9) / (10 / 3);
    expect(out.data[0]).toBeCloseTo(expected0, 6);
    expect(out.data[4]).toBeCloseTo(expected1, 6);
    expect(out.data[8]).toBeCloseTo(expected2, 6);
    expect(out.data[3]).toBeCloseTo(1, 6);
  });

  it('works in 2D with non-square cells and independent axes', () => {
    // v = x + 10·y on a 6 × 4 image, 2 cols × 3 rows: each cell is 3 px wide and 4/3 px tall.
    const v = (x: number, y: number): number => (x + 10 * y) / 100;
    const img = linearFrom(6, 4, v);
    const out = boxAverage(img, uniformSpans(2, 6), uniformSpans(3, 4));
    // Reference: Σ pixel value × overlap area / cell area, pixel by pixel.
    const overlap = (p: number, a: number, b: number): number => Math.max(0, Math.min(p + 1, b) - Math.max(p, a));
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 2; j++) {
        const [x0, x1, y0, y1] = [j * 3, j * 3 + 3, (i * 4) / 3, ((i + 1) * 4) / 3];
        let sum = 0;
        for (let y = 0; y < 4; y++) for (let x = 0; x < 6; x++) sum += v(x, y) * overlap(x, x0, x1) * overlap(y, y0, y1);
        expect(out.data[(i * 2 + j) * 4]).toBeCloseTo(sum / ((x1 - x0) * (y1 - y0)), 6);
      }
    }
    // Row 0 covers pixel row 0 fully and a third of row 1: its mean y is (0 + 1/3) / (4/3) = 0.25.
    expect(out.data[0]).toBeCloseTo((1 + 10 * 0.25) / 100, 6);
  });

  it('averages in linear light: a 1-px black/white checker is linear 0.5 (sRGB 188), not sRGB 128', () => {
    const out = boxAverage(toLinearImage(checker(8, 8, 1, '#000000', '#ffffff')), uniformSpans(1, 8), uniformSpans(1, 8));
    expect(out.data[0]).toBeCloseTo(0.5, 6);
    expect(toRgbaImage(out).data[0]).toBe(188);
  });

  it('gives transparent pixels no weight in the color, only in the coverage', () => {
    const img = toLinearImage(fromFn(4, 1, (x) => (x < 2 ? [255, 0, 0, 255] : [0, 0, 255, 0])));
    const out = boxAverage(img, uniformSpans(1, 4), uniformSpans(1, 1));
    expect(out.data[3]).toBeCloseTo(0.5, 6);
    // Un-premultiplied, the cell is pure red.
    expect(out.data[0] / out.data[3]).toBeCloseTo(1, 6);
    expect(out.data[2]).toBe(0);
  });

  it('upsamples too: cells smaller than a pixel take that pixel', () => {
    const img = linearFrom(2, 1, (x) => (x === 0 ? 0.25 : 0.75));
    const out = boxAverage(img, uniformSpans(8, 2), uniformSpans(1, 1));
    expect([0, 1, 2, 3].map((j) => out.data[j * 4])).toEqual([0.25, 0.25, 0.25, 0.25]);
    expect([4, 5, 6, 7].map((j) => out.data[j * 4])).toEqual([0.75, 0.75, 0.75, 0.75]);
  });

  it('rejects spans outside the image', () => {
    const img = linearFrom(4, 4, () => 0.5);
    const bad = { start: Float64Array.from([0]), end: Float64Array.from([5]) };
    expect(() => boxAverage(img, bad, uniformSpans(1, 4))).toThrow(RangeError);
    const empty = { start: Float64Array.from([2]), end: Float64Array.from([2]) };
    expect(() => boxAverage(img, uniformSpans(1, 4), empty)).toThrow(RangeError);
  });
});

describe('analysisImage / boxAverageRgba — straight from RGBA8', () => {
  it('equal the float-image path', () => {
    const img = fromFn(300, 200, (x, y) => [(x * 7) % 256, (y * 5) % 256, (x + y) % 256, (x * y) % 256]);
    const a = analysisImage(img, 128);
    const b = limitLongSide(toLinearImage(img), 128);
    expect([a.w, a.h]).toEqual([b.w, b.h]);
    for (let i = 0; i < a.data.length; i++) expect(a.data[i]).toBeCloseTo(b.data[i], 6);
    const xs = uniformSpans(7, 300);
    const ys = uniformSpans(5, 200);
    const c = boxAverageRgba(img, xs, ys);
    const d = boxAverage(toLinearImage(img), xs, ys);
    for (let i = 0; i < c.data.length; i++) expect(c.data[i]).toBeCloseTo(d.data[i], 6);
    expect(analysisImage(img).w).toBe(300);
  });
});

describe('limitLongSide — the 2048 px analysis limit (§2.3.1 step 3)', () => {
  it('leaves images that fit untouched', () => {
    const img = toLinearImage(solid(2048, 10, '#336699'));
    expect(limitLongSide(img)).toBe(img);
  });

  it('scales the long side to 2048 and keeps the aspect ratio', () => {
    const img = blankLinear(4000, 3000);
    const out = limitLongSide(img);
    expect([out.w, out.h]).toEqual([ANALYSIS_MAX_SIDE, 1536]);
    const tall = limitLongSide(blankLinear(1000, 5000));
    expect([tall.w, tall.h]).toEqual([410, ANALYSIS_MAX_SIDE]);
  });

  it('box-filters in linear light (a fine checker becomes linear 0.5)', () => {
    const out = limitLongSide(toLinearImage(checker(64, 64, 1, '#000000', '#ffffff')), 16);
    expect(out.w).toBe(16);
    for (let p = 0; p < out.data.length; p += 4) expect(out.data[p]).toBeCloseTo(0.5, 5);
  });
});
