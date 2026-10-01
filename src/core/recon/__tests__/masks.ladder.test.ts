// The classical mask ladder end to end (DESIGN.md §2.9.1) on synthetic photos generated in code: plain, two-tone,
// textured and graded backgrounds, background-colored detail inside the object, real holes, floor shadows, dark
// and gray objects, transparency, noise, big photos, guards, brush locks, determinism.
import { describe, expect, it } from 'vitest';
import { linearToSrgb8, parseHex, srgb8ToLinear } from '../../kernel/color';
import { addNoise, fromFn, replaceRandomPixels, solid, type TestColor } from '../../../test/rgba';
import type { RgbaImage } from '../../../types/geometry';
import { classicalMask, maskIoU, maskStats, MASK_ISSUES, paintLocks } from '../masks';
import { sameBytes } from './helpers/views';

const HEAVY = { timeout: 60_000 };

type Inside = (x: number, y: number) => boolean;

/** A scene: background color function, object region and object color function (pixel centers). */
function scene(w: number, h: number, bg: (x: number, y: number) => TestColor, inside: Inside, obj: (x: number, y: number) => TestColor): RgbaImage {
  return fromFn(w, h, (x, y) => (inside(x + 0.5, y + 0.5) ? obj(x, y) : bg(x, y)));
}

/** Ground truth at pixel centers on a w × h grid, the region given in that grid's coordinates. */
function truth(w: number, h: number, inside: Inside): Uint8Array {
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) m[x + w * y] = inside(x + 0.5, y + 0.5) ? 1 : 0;
  return m;
}

const disc = (cx: number, cy: number, r: number): Inside => (x, y) => (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
const ellipse = (cx: number, cy: number, rx: number, ry: number): Inside => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
const union = (...fs: Inside[]): Inside => (x, y) => fs.some((f) => f(x, y));

/** A color darkened in linear light (a cast shadow). */
function darken(hex: string, k: number): [number, number, number] {
  const [r, g, b] = parseHex(hex);
  return [linearToSrgb8(srgb8ToLinear(r) * k), linearToSrgb8(srgb8ToLinear(g) * k), linearToSrgb8(srgb8ToLinear(b) * k)];
}

describe('classicalMask on synthetic photos', HEAVY, () => {
  it('a red ball on a plain gray background, with sensor noise', () => {
    const inside = disc(200, 150, 90);
    const img = addNoise(scene(400, 300, () => '#d6d6d2', inside, () => '#b52a24'), 8, 1);
    const r = classicalMask(img);
    expect([r.w, r.h, r.scale]).toEqual([400, 300, 1]);
    expect(maskIoU(r.mask, truth(400, 300, inside))).toBeGreaterThan(0.98);
    expect(r.issues).toEqual([]);
    expect(r.background.length).toBe(1);
    expect(r.background[0].share).toBe(1);
  });

  it('keeps background-colored detail inside the object (connected background only)', () => {
    // A navy toy with a light-gray belly patch exactly the color of the background.
    const body = ellipse(200, 160, 100, 120);
    const patch = ellipse(200, 180, 40, 50);
    const img = scene(400, 320, () => '#d6d6d2', body, (x, y) => (patch(x + 0.5, y + 0.5) ? '#d6d6d2' : '#1f2a5a'));
    const r = classicalMask(img);
    expect(maskIoU(r.mask, truth(400, 320, body))).toBeGreaterThan(0.98);
    // keepHoles keeps the enclosed patch out of the mask.
    const holes = classicalMask(img, { keepHoles: true });
    expect(holes.mask[200 + 400 * 180]).toBe(0);
    expect(maskIoU(holes.mask, truth(400, 320, (x, y) => body(x, y) && !patch(x, y)))).toBeGreaterThan(0.97);
  });

  it('a ring (mug handle): filled by default, a through-hole with keepHoles', () => {
    const outer = disc(160, 120, 90);
    const hole = disc(160, 120, 40);
    const ring: Inside = (x, y) => outer(x, y) && !hole(x, y);
    const img = scene(320, 240, () => '#efe9dc', ring, () => '#2f7d5b');
    expect(maskIoU(classicalMask(img).mask, truth(320, 240, outer))).toBeGreaterThan(0.98);
    expect(maskIoU(classicalMask(img, { keepHoles: true }).mask, truth(320, 240, ring))).toBeGreaterThan(0.97);
  });

  it('a wall and a floor (two background clusters), the object across the horizon', () => {
    const inside = union(ellipse(240, 200, 80, 110), disc(240, 90, 50));
    const bg = (_x: number, y: number): TestColor => (y < 190 ? '#f1ece0' : '#7a5a3f');
    const img = addNoise(scene(480, 360, bg, inside, () => '#2a9d8f'), 6, 2);
    const r = classicalMask(img);
    expect(r.background.length).toBe(2);
    expect(maskIoU(r.mask, truth(480, 360, inside))).toBeGreaterThan(0.98);
  });

  it('a textured background (a fine two-tone weave within tau)', () => {
    const inside = ellipse(200, 150, 110, 90);
    const weave = (x: number, y: number): TestColor => ((Math.floor(x / 3) + Math.floor(y / 3)) % 2 === 0 ? '#cfcac0' : '#c2bcb1');
    const img = scene(400, 300, weave, inside, () => '#6a3d9a');
    expect(maskIoU(classicalMask(img).mask, truth(400, 300, inside))).toBeGreaterThan(0.98);
  });

  it('a vignetted, graded background', () => {
    const inside = ellipse(200, 150, 90, 100);
    const graded = (x: number, y: number): TestColor => {
      const d = Math.hypot((x - 200) / 200, (y - 150) / 150);
      const v = Math.round(235 - 28 * d * d); // corners 56 levels darker than the center
      return [v, v - 3, v - 8];
    };
    const img = addNoise(scene(400, 300, graded, inside, () => '#c0392b'), 5, 3);
    expect(maskIoU(classicalMask(img).mask, truth(400, 300, inside))).toBeGreaterThan(0.98);
  });

  it('removes a cast floor shadow beside the object, and only with the heuristic on', () => {
    const floor = '#e8dcc8';
    const object = union(ellipse(200, 190, 70, 90), disc(200, 85, 45));
    const shadow = ellipse(280, 265, 90, 18);
    const img = addNoise(scene(400, 320, (x, y) => (shadow(x + 0.5, y + 0.5) ? darken(floor, 0.4) : floor), object, () => '#e07b39'), 4, 4);
    const gt = truth(400, 320, object);
    const on = classicalMask(img);
    expect(on.shadowPixels).toBeGreaterThan(500);
    expect(maskIoU(on.mask, gt)).toBeGreaterThan(0.97);
    const off = classicalMask(img, { shadow: false });
    expect(off.shadowPixels).toBe(0);
    expect(maskIoU(off.mask, gt)).toBeLessThan(0.93);
  });

  it('does not eat the bottom of a dark or a gray object as "shadow"', () => {
    for (const color of ['#141414', '#7f7f7f', '#9a8f80']) {
      const object = ellipse(200, 160, 90, 120);
      const img = addNoise(scene(400, 320, () => '#f4f1ea', object, () => color), 4, 5);
      const r = classicalMask(img);
      expect(maskIoU(r.mask, truth(400, 320, object)), color).toBeGreaterThan(0.98);
    }
  });

  it('removes speckle noise in the background (largest component, opening)', () => {
    const inside = disc(150, 150, 80);
    const img = replaceRandomPixels(scene(300, 300, () => '#dddddd', inside, () => '#3366cc'), 0.004, ['#000000', '#ff00ff'], 9);
    expect(maskIoU(classicalMask(img).mask, truth(300, 300, inside))).toBeGreaterThan(0.98);
  });

  it('a 12-megapixel photo becomes a 512 × 384 mask that matches the downscaled truth', () => {
    const W = 4032;
    const H = 3024;
    const inside = ellipse(2016, 1600, 900, 1100);
    const img = scene(W, H, () => '#d9d4c7', inside, () => '#8e44ad');
    const r = classicalMask(img);
    expect([r.w, r.h]).toEqual([512, 384]);
    expect(r.scale).toBeCloseTo(512 / 4032, 12);
    const s = r.scale;
    expect(maskIoU(r.mask, truth(512, 384, (x, y) => inside(x / s, y / s)))).toBeGreaterThan(0.985);
  });

  it('a transparent background is background whatever its color', () => {
    const inside = disc(100, 100, 60);
    const img = fromFn(200, 200, (x, y) => (inside(x + 0.5, y + 0.5) ? '#123456' : [(x * 37) % 256, (y * 91) % 256, 7, 0]));
    const r = classicalMask(img);
    expect(maskIoU(r.mask, truth(200, 200, inside))).toBeGreaterThan(0.98);
    expect(r.background).toEqual([]);
  });

  it('guards: touching the border, too small, nothing found', () => {
    const touching = classicalMask(scene(300, 200, () => '#eeeeee', ellipse(150, 170, 80, 60), () => '#aa2222'));
    expect(touching.issues.map((i) => i.code)).toContain(MASK_ISSUES.border);
    const tiny = classicalMask(scene(300, 200, () => '#eeeeee', disc(150, 100, 20), () => '#aa2222'));
    expect(tiny.issues.map((i) => i.code)).toEqual([MASK_ISSUES.coverage]);
    const none = classicalMask(solid(100, 80, '#eeeeee'));
    expect(maskStats(none.mask, none.w, none.h).area).toBe(0);
    expect(none.issues.map((i) => i.code)).toEqual([MASK_ISSUES.empty]);
  });

  it('an object cut by one, two or three edges of the photo is not taken for background', () => {
    const bg = (): TestColor => '#e0e0dc';
    const cases: [string, Inside][] = [
      ['a corner', union(disc(0, 300, 150), disc(20, 280, 5))],
      ['top and bottom', (x) => x >= 150 && x < 250],
      ['left, right and bottom', ellipse(200, 300, 260, 120)],
      ['the bottom', ellipse(200, 290, 120, 90)],
    ];
    for (const [name, inside] of cases) {
      const r = classicalMask(scene(400, 300, bg, inside, () => '#c02020'));
      expect(maskIoU(r.mask, truth(400, 300, inside)), name).toBeGreaterThan(0.97);
      expect(r.issues.map((i) => i.code), name).toContain(MASK_ISSUES.border);
    }
  });

  it('applies brush locks after the cleanup', () => {
    const inside = disc(100, 100, 50);
    const img = scene(200, 200, () => '#eeeeee', inside, () => '#336699');
    const locks = new Int8Array(200 * 200);
    paintLocks(locks, 200, 200, [
      { x: 100, y: 100, r: 10, mode: 'erase' },
      { x: 180, y: 20, r: 8, mode: 'add' },
    ]);
    const r = classicalMask(img, {}, locks);
    expect(r.mask[100 + 200 * 100]).toBe(0);
    expect(r.mask[180 + 200 * 20]).toBe(1);
    expect(() => classicalMask(img, {}, new Int8Array(10))).toThrow(RangeError);
  });

  it('tiny and degenerate images do not throw', () => {
    expect(classicalMask(solid(1, 1, '#ff0000')).w).toBe(1);
    expect(classicalMask({ w: 1, h: 1, data: new Uint8ClampedArray(4) }).mask.length).toBe(1);
    expect(classicalMask(solid(2, 3, '#00ff00')).mask.length).toBe(6);
    expect(() => classicalMask(solid(4, 4, '#000000'), { tau: 0 })).toThrow(RangeError);
  });

  it('is deterministic: the same photo gives the same bytes', () => {
    const img = addNoise(scene(300, 240, (_x, y) => (y < 120 ? '#f0ebe0' : '#806040'), union(disc(150, 120, 70), disc(150, 40, 30)), () => '#2e86ab'), 9, 11);
    const a = classicalMask(img);
    const b = classicalMask(img);
    expect(sameBytes(a.mask, b.mask)).toBe(true);
    expect(sameBytes(a.raw, b.raw)).toBe(true);
    expect(a.background).toEqual(b.background);
  });
});
