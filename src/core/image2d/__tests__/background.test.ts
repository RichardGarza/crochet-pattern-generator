import { describe, expect, it } from 'vitest';
import { addNoise, fillDisc, fillRect, fromFn, solid } from '../../../test/rgba';
import { deltaE00Hex, hexToLinearRgb, linearRgbToHex } from '../../kernel/color';
import {
  backgroundCells,
  compositeCells,
  hasTransparency,
  pixelFeatures,
  plainBackground,
  resolveBackground,
  ringCluster,
} from '../background';
import { boxAverage, toLinearImage, uniformSpans } from '../linear';
import { photoLike } from './images';

const KEEP = { background: 'keep' as const };
const REMOVE = { background: 'remove' as const };

/** A subject on a plain background: a dark-outlined red disc and a blue square on cream, 200 × 160. */
function subjectOnPlain(noise = 0): ReturnType<typeof solid> {
  const img = solid(200, 160, '#f3ead8');
  fillDisc(img, 80, 80, 44, '#202020');
  fillDisc(img, 80, 80, 40, '#d23a3a');
  // A cream hole inside the disc: same color as the background, but enclosed, so it is subject.
  fillDisc(img, 80, 80, 12, '#f3ead8');
  fillRect(img, 140, 50, 40, 60, '#3a6fd9');
  return noise > 0 ? addNoise(img, noise, 17) : img;
}

describe('transparency (§2.3.2)', () => {
  it('a picture has a transparent background when ≥ 1% of its pixels are less than half opaque', () => {
    expect(hasTransparency(toLinearImage(solid(4, 4, '#ffffff')))).toBe(false);
    expect(hasTransparency(toLinearImage(fromFn(4, 4, (x) => (x === 3 ? [0, 0, 0, 128] : '#ffffff'))))).toBe(false);
    expect(hasTransparency(toLinearImage(fromFn(4, 4, (x) => (x === 3 ? [0, 0, 0, 127] : '#ffffff'))))).toBe(true);
    // One stray transparent pixel in 60 000 is not a background.
    expect(hasTransparency(toLinearImage(fromFn(300, 200, (x, y) => (x === 0 && y === 0 ? [0, 0, 0, 0] : '#ffffff'))))).toBe(false);
  });

  it('a stray transparent pixel neither switches to alpha mode nor stops plain-background removal', () => {
    const photo = photoLike(300, 200, 1);
    photo.data[3] = 0;
    const keep = resolveBackground(toLinearImage(photo), KEEP);
    expect(keep.info.source).toBe('none');
    expect(keep.issues).toEqual([]);
    const plain = subjectOnPlain();
    plain.data[3] = 0;
    const removed = resolveBackground(toLinearImage(plain), REMOVE);
    expect(removed.info.source).toBe('plain');
    expect(removed.issues).toEqual([]);
  });

  it('translucent but never transparent pixels are composited, with no background and no warning', () => {
    const img = toLinearImage(fromFn(10, 10, (x) => (x === 0 ? [255, 0, 0, 200] : '#00aa00')));
    const r = resolveBackground(img, KEEP);
    expect(r.info.source).toBe('none');
    expect(r.issues).toEqual([]);
  });

  it('cells with coverage α < 0.5 are background; others composite over the background in linear light', () => {
    // Columns: opaque red | 50% red | 40% red | transparent.
    const alphas = [255, 128, 102, 0];
    const img = toLinearImage(fromFn(4, 1, (x) => [255, 0, 0, alphas[x]]));
    const cells = boxAverage(img, uniformSpans(4, 4), uniformSpans(1, 1));
    const bgCells = backgroundCells(cells);
    expect([...bgCells]).toEqual([0, 0, 1, 1]);
    const { lin } = compositeCells(cells, bgCells, '#ffffff');
    expect(linearRgbToHex(lin[0], lin[1], lin[2])).toBe('#ff0000');
    // 50% red over white in linear light: R = 1, G = B = 0.5 linear (sRGB 188).
    const a = 128 / 255;
    expect(lin[3]).toBeCloseTo(1, 6);
    expect(lin[4]).toBeCloseTo(1 - a, 6);
    expect(linearRgbToHex(lin[3], lin[4], lin[5])).toBe(linearRgbToHex(1, 1 - a, 1 - a));
    // Background cells are the background color.
    expect(linearRgbToHex(lin[6], lin[7], lin[8])).toBe('#ffffff');
    expect(linearRgbToHex(lin[9], lin[10], lin[11])).toBe('#ffffff');
  });

  it('uses the chosen background color when set, white otherwise', () => {
    const img = toLinearImage(fromFn(10, 10, (x) => (x < 5 ? '#00aa00' : [0, 0, 0, 0])));
    expect(resolveBackground(img, KEEP).info).toMatchObject({ source: 'alpha', hex: '#ffffff', hexFrom: 'white', subjectShare: 0.5 });
    expect(resolveBackground(img, { ...KEEP, backgroundColor: { hex: '#112233' } }).info).toMatchObject({ hex: '#112233', hexFrom: 'setting' });
    expect(() => resolveBackground(img, { ...KEEP, backgroundColor: { hex: 'red' } })).toThrow(RangeError);
  });

  it('"remove" on a transparent picture uses the transparency and says so', () => {
    const img = toLinearImage(fromFn(10, 10, (x) => (x < 5 ? '#00aa00' : [0, 0, 0, 0])));
    const r = resolveBackground(img, REMOVE);
    expect(r.info.source).toBe('alpha');
    expect(r.issues.map((i) => i.code)).toEqual(['I_BG_TRANSPARENT']);
  });
});

describe('remove plain background (§2.3.2)', () => {
  it('finds the ring cluster of a plain border', () => {
    const img = toLinearImage(subjectOnPlain(3));
    const ring = ringCluster(img, pixelFeatures(img));
    expect(ring.share).toBeGreaterThan(0.95);
    expect(ring.std).toBeLessThan(0.03);
    expect(deltaE00Hex(ring.hex, '#f3ead8')).toBeLessThan(1);
  });

  it('fills the background from the border, stops at the subject, keeps enclosed holes', () => {
    for (const noise of [0, 4]) {
      const src = subjectOnPlain(noise);
      const img = toLinearImage(src);
      const r = plainBackground(img);
      expect(r.found).toBe(true);
      const m = r.mask!;
      const at = (x: number, y: number): number => m[y * img.w + x];
      // Background corners and the gap between the shapes are filled.
      expect([at(0, 0), at(199, 159), at(5, 80), at(130, 80)]).toEqual([1, 1, 1, 1]);
      // The disc, its outline, the enclosed cream hole and the square are not.
      expect([at(80, 80), at(80, 50), at(80, 37), at(160, 80)]).toEqual([0, 0, 0, 0]);
      // The fill reaches the subject's edge: no background pixel more than 2 px from the subject is left.
      let leftover = 0;
      for (let y = 0; y < img.h; y++) {
        for (let x = 0; x < img.w; x++) {
          const outside = (x - 80) ** 2 + (y - 80) ** 2 > 46 ** 2 && !(x >= 138 && x < 182 && y >= 48 && y < 112);
          if (outside && !m[y * img.w + x]) leftover++;
        }
      }
      expect(leftover, `noise ${noise}`).toBe(0);
    }
  });

  it('never crosses a strong edge into a subject region of a similar color', () => {
    // A light region (close to the background) enclosed by a dark outline that is open by nothing.
    const img = solid(120, 120, '#ffffff');
    fillRect(img, 30, 30, 60, 60, '#222222');
    fillRect(img, 33, 33, 54, 54, '#f2f2f2'); // within ΔEOKr2 0.05 of white
    const r = plainBackground(toLinearImage(img));
    expect(r.found).toBe(true);
    expect(r.mask![60 * 120 + 60]).toBe(0);
  });

  it('a busy border has no plain background: the whole picture is charted and a warning says why', () => {
    const r = resolveBackground(toLinearImage(photoLike(200, 150, 3)), REMOVE);
    expect(r.info.source).toBe('none');
    expect(r.info.subjectShare).toBe(1);
    expect(r.issues.map((i) => i.code)).toEqual(['W_BG_NOT_FOUND']);
    // No background color is suggested for a background that was not found.
    expect(r.info).toMatchObject({ hex: '#ffffff', hexFrom: 'white' });
  });

  it('removed pixels become transparent and their cells background', () => {
    const r = resolveBackground(toLinearImage(subjectOnPlain(2)), REMOVE);
    expect(r.info).toMatchObject({ source: 'plain', hexFrom: 'border', maskW: 200, maskH: 160 });
    expect(deltaE00Hex(r.info.hex, '#f3ead8')).toBeLessThan(1);
    expect(r.image.data[3]).toBe(0);
    expect(r.image.data[(80 * 200 + 80) * 4 + 3]).toBe(1);
    const cells = boxAverage(r.image, uniformSpans(20, 200), uniformSpans(16, 160));
    const bg = backgroundCells(cells);
    expect(bg[0]).toBe(1);
    expect(bg[8 * 20 + 8]).toBe(0);
    // Subject ≈ disc (π·46²) + square (40·60) of 200·160.
    expect(r.info.subjectShare).toBeCloseTo((Math.PI * 44.5 ** 2 + 2400) / 32000, 1);
    expect(r.issues).toEqual([]);
  });

  it('warns when the subject is under 15% or over 95% of the picture', () => {
    const small = solid(200, 200, '#ffffff');
    fillRect(small, 90, 90, 20, 20, '#cc0000');
    expect(resolveBackground(toLinearImage(small), REMOVE).issues.map((i) => i.code)).toEqual(['W_BG_SUBJECT_SMALL']);
    const large = fromFn(100, 100, (x, y) => (x >= 1 && x < 99 && y >= 1 && y < 99 ? '#cc0000' : [0, 0, 0, 0]));
    expect(resolveBackground(toLinearImage(large), KEEP).issues.map((i) => i.code)).toEqual(['W_BG_SUBJECT_LARGE']);
  });

  it('keep on an opaque picture: no background at all', () => {
    const r = resolveBackground(toLinearImage(subjectOnPlain()), KEEP);
    expect(r.info.source).toBe('none');
    expect(r.issues).toEqual([]);
    expect(hexToLinearRgb(r.info.hex)).toEqual([1, 1, 1]);
  });
});
