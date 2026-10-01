import { describe, expect, it } from 'vitest';
import { fromRows, hexAt, sameImage } from '../../../test/rgba';
import type { CropRect } from '../../../types/chart';
import { applyCrop } from '../crop';

const COLORS = { A: '#ff0000', B: '#00ff00', C: '#0000ff', D: '#ffff00', E: '#000000', F: '#ffffff' } as const;
// 3 × 2:   A B C
//          D E F
const IMG = fromRows(['ABC', 'DEF'], COLORS);
const FULL: CropRect = { x: 0, y: 0, w: 3, h: 2, rotate: 0, flipX: false };

function letters(img: ReturnType<typeof applyCrop>): string[] {
  const byHex = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [v, k]));
  const rows: string[] = [];
  for (let y = 0; y < img.h; y++) {
    let r = '';
    for (let x = 0; x < img.w; x++) r += byHex[hexAt(img, x, y)];
    rows.push(r);
  }
  return rows;
}

describe('applyCrop (§2.3.1 step 2)', () => {
  it('returns the image itself without a crop or with a no-op crop', () => {
    expect(applyCrop(IMG)).toBe(IMG);
    expect(applyCrop(IMG, FULL)).toBe(IMG);
  });

  it('crops in source pixels', () => {
    expect(letters(applyCrop(IMG, { ...FULL, x: 1, w: 2 }))).toEqual(['BC', 'EF']);
    expect(letters(applyCrop(IMG, { ...FULL, y: 1, h: 1 }))).toEqual(['DEF']);
  });

  it('rotates clockwise in 90° steps', () => {
    expect(letters(applyCrop(IMG, { ...FULL, rotate: 90 }))).toEqual(['DA', 'EB', 'FC']);
    expect(letters(applyCrop(IMG, { ...FULL, rotate: 180 }))).toEqual(['FED', 'CBA']);
    expect(letters(applyCrop(IMG, { ...FULL, rotate: 270 }))).toEqual(['CF', 'BE', 'AD']);
  });

  it('mirrors left ↔ right after rotating', () => {
    expect(letters(applyCrop(IMG, { ...FULL, flipX: true }))).toEqual(['CBA', 'FED']);
    expect(letters(applyCrop(IMG, { ...FULL, rotate: 90, flipX: true }))).toEqual(['AD', 'BE', 'CF']);
  });

  it('crops before rotating', () => {
    expect(letters(applyCrop(IMG, { x: 1, y: 0, w: 2, h: 2, rotate: 90, flipX: false }))).toEqual(['EB', 'FC']);
  });

  it('rounds fractional edges and clips to the image', () => {
    expect(letters(applyCrop(IMG, { x: 0.6, y: -5, w: 10, h: 10, rotate: 0, flipX: false }))).toEqual(['BC', 'EF']);
  });

  it('four quarter turns give the original back', () => {
    let img = IMG;
    for (let k = 0; k < 4; k++) img = applyCrop(img, { x: 0, y: 0, w: img.w, h: img.h, rotate: 90, flipX: false });
    expect(sameImage(img, IMG)).toBe(true);
  });

  it('normalizes negative extents and keeps at least one pixel of a sliver', () => {
    expect(letters(applyCrop(IMG, { x: 3, y: 2, w: -2, h: -2, rotate: 0, flipX: false }))).toEqual(['BC', 'EF']);
    expect(letters(applyCrop(IMG, { ...FULL, x: 1.1, w: 0.2 }))).toEqual(['B', 'E']);
    expect(letters(applyCrop(IMG, { ...FULL, x: 2.9, w: 0.3 }))).toEqual(['C', 'F']);
  });

  it('rejects empty crops, crops off the image, odd rotations and non-finite numbers', () => {
    expect(() => applyCrop(IMG, { ...FULL, x: 3 })).toThrow(RangeError);
    expect(() => applyCrop(IMG, { ...FULL, x: -5, w: 4 })).toThrow(RangeError);
    expect(() => applyCrop(IMG, { ...FULL, w: 0 })).toThrow(RangeError);
    expect(() => applyCrop(IMG, { ...FULL, rotate: 45 as CropRect['rotate'] })).toThrow(RangeError);
    expect(() => applyCrop(IMG, { ...FULL, w: Number.NaN })).toThrow(RangeError);
  });
});
