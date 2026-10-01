// The building blocks of the classical mask ladder (DESIGN.md §2.9.1): downscale, border band, background
// clusters, flood fill, components, holes, EDT morphology, guards, IoU, brush locks.
import { describe, expect, it } from 'vitest';
import { hexToFeature, oklabFeatures } from '../../kernel/color';
import { mulberry32 } from '../../kernel/prng';
import { addNoise, fillRect, fromFn, solid, stripes } from '../../../test/rgba';
import {
  backgroundClusters,
  bandSides,
  borderBand,
  borderBandWidth,
  connectedComponents,
  dilate,
  downscaleToMaskGrid,
  erode,
  fillHoles,
  floodFillFromBorder,
  keepLargestComponent,
  maskBox,
  maskGridSize,
  maskGuards,
  maskIoU,
  maskStats,
  maskToRgba,
  morphClose,
  morphOpen,
  paintLocks,
  refineMask,
  MASK_ISSUES,
} from '../masks';

/** A 0/1 mask from text rows: '#' = 1, anything else = 0. */
function rows(lines: string[]): { mask: Uint8Array<ArrayBuffer>; w: number; h: number } {
  const h = lines.length;
  const w = lines[0].length;
  const mask = new Uint8Array(w * h);
  lines.forEach((line, y) => [...line].forEach((ch, x) => (mask[x + w * y] = ch === '#' ? 1 : 0)));
  return { mask, w, h };
}

function toRows(mask: ArrayLike<number>, w: number, h: number): string[] {
  const out: string[] = [];
  for (let y = 0; y < h; y++) {
    let s = '';
    for (let x = 0; x < w; x++) s += mask[x + w * y] ? '#' : '.';
    out.push(s);
  }
  return out;
}

function randomMask(w: number, h: number, p: number, seed: number): Uint8Array<ArrayBuffer> {
  const rng = mulberry32(seed);
  return Uint8Array.from({ length: w * h }, () => (rng() < p ? 1 : 0));
}

/** Brute-force disc dilation/erosion with the same conventions (pixel centers, frame not background). */
function bruteMorph(mask: ArrayLike<number>, w: number, h: number, r: number, op: 'dilate' | 'erode'): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let hit = false;
      for (let yy = 0; yy < h && !hit; yy++) {
        for (let xx = 0; xx < w && !hit; xx++) {
          if ((xx - x) ** 2 + (yy - y) ** 2 > r * r) continue;
          const v = mask[xx + w * yy] !== 0;
          if (op === 'dilate' ? v : !v) hit = true;
        }
      }
      out[x + w * y] = op === 'dilate' ? (hit ? 1 : 0) : mask[x + w * y] !== 0 && !hit ? 1 : 0;
    }
  }
  return out;
}

describe('maskGridSize / downscaleToMaskGrid', () => {
  it('keeps at most 512 px on the long side, aspect kept', () => {
    expect(maskGridSize(4032, 3024)).toEqual({ w: 512, h: 384, scale: 512 / 4032 });
    expect(maskGridSize(3024, 4032)).toEqual({ w: 384, h: 512, scale: 512 / 4032 });
    expect(maskGridSize(300, 200)).toEqual({ w: 300, h: 200, scale: 1 });
    expect(maskGridSize(10_000, 1)).toEqual({ w: 512, h: 1, scale: 512 / 10_000 });
    expect(() => maskGridSize(0, 5)).toThrow(RangeError);
    expect(() => maskGridSize(5, 5, 0)).toThrow(RangeError);
  });

  it('returns an image that already fits unchanged', () => {
    const img = solid(40, 30, '#123456');
    expect(downscaleToMaskGrid(img).image).toBe(img);
  });

  it('keeps a solid color exactly', () => {
    const { image, scale } = downscaleToMaskGrid(solid(1024, 700, '#4a7fb3'));
    expect(image.w).toBe(512);
    expect(image.h).toBe(350);
    expect(scale).toBe(0.5);
    for (let i = 0; i < image.w * image.h; i++) {
      expect([image.data[4 * i], image.data[4 * i + 1], image.data[4 * i + 2], image.data[4 * i + 3]]).toEqual([0x4a, 0x7f, 0xb3, 255]);
    }
  });

  it('averages in linear light with exact area weights (non-integer factor)', () => {
    // 1-px black/white columns, downscaled by 3/2… → every output pixel mixes them by area in LINEAR light.
    const img = fromFn(768, 4, (x) => (x % 2 === 0 ? '#000000' : '#ffffff'));
    const { image } = downscaleToMaskGrid(img, 512);
    expect(image.w).toBe(512);
    // Output column o covers [1.5·o, 1.5·o + 1.5): o = 0 → black 1, white 0.5 → linear 1/3 → sRGB ≈ 156.
    expect(image.data[0]).toBe(156);
    // o = 1 covers [1.5, 3): white 0.5, black 1 → also 1/3.
    expect(image.data[4]).toBe(156);
    // A gamma-space average would give 85; the linear one never does.
    expect(image.data[0]).not.toBe(85);
  });

  it('does not bleed the color of transparent pixels (premultiplied alpha)', () => {
    const img = fromFn(1024, 2, (x) => (x % 2 === 0 ? [255, 0, 0, 255] : [0, 0, 255, 0]));
    const { image } = downscaleToMaskGrid(img, 512);
    expect([image.data[0], image.data[1], image.data[2]]).toEqual([255, 0, 0]);
    expect(image.data[3]).toBe(128);
  });

  it('rejects malformed images', () => {
    expect(() => downscaleToMaskGrid({ w: 2, h: 2, data: new Uint8ClampedArray(15) })).toThrow(RangeError);
  });
});

describe('border band', () => {
  it('bandSides marks the sides each band pixel lies on', () => {
    const band = borderBand(4, 3, 1);
    expect(Array.from(bandSides(band, 4, 3, 1))).toEqual([5, 1, 1, 9, 4, 8, 6, 2, 2, 10]);
  });

  it('is 4% of the shorter side, at least 1 px, at most half of it', () => {
    expect(borderBandWidth(512, 384)).toBe(15);
    expect(borderBandWidth(10, 10)).toBe(1);
    expect(borderBandWidth(3, 3, 0.9)).toBe(2);
    expect(() => borderBandWidth(10, 10, -1)).toThrow(RangeError);
  });

  it('lists exactly the pixels within the band, in row-major order', () => {
    const band = borderBand(6, 5, 1);
    expect(Array.from(band)).toEqual([0, 1, 2, 3, 4, 5, 6, 11, 12, 17, 18, 23, 24, 25, 26, 27, 28, 29]);
    expect(borderBand(4, 4, 2).length).toBe(16);
  });
});

describe('backgroundClusters', () => {
  const feats = (hexes: string[]): Float32Array => Float32Array.from(hexes.flatMap((h) => hexToFeature(h)));

  it('one plain background → one cluster at its color', () => {
    const f = feats(Array(50).fill('#e0e0e0'));
    const { centers, shares } = backgroundClusters(f, Int32Array.from({ length: 50 }, (_, i) => i));
    expect(shares).toEqual([1]);
    expect(Array.from(centers)).toEqual(Array.from(hexToFeature('#e0e0e0')).map((v) => Math.fround(v)));
  });

  it('wall + floor → two clusters, most populous first', () => {
    const f = feats([...Array(60).fill('#f2efe6'), ...Array(40).fill('#6b4f3a')]);
    const { centers, shares } = backgroundClusters(f, Int32Array.from({ length: 100 }, (_, i) => i));
    expect(shares).toEqual([0.6, 0.4]);
    expect(centers.length).toBe(6);
  });

  it('noise below tau/2 does not split a cluster', () => {
    const img = addNoise(solid(40, 40, '#9ab0c4'), 6, 7);
    const f = oklabFeatures(img);
    const { shares } = backgroundClusters(f, Int32Array.from({ length: 1600 }, (_, i) => i));
    expect(shares).toEqual([1]);
  });

  it('at most three clusters; a cluster under 5% of the band is dropped (never the largest)', () => {
    const f = feats([...Array(50).fill('#ffffff'), ...Array(30).fill('#202020'), ...Array(20).fill('#3060c0')]);
    const { shares } = backgroundClusters(f, Int32Array.from({ length: 100 }, (_, i) => i));
    expect(shares).toEqual([0.5, 0.3, 0.2]);
    // A fourth color joins the nearest of the three (farthest-point seeding picks the three most distinct).
    const four = feats([...Array(50).fill('#ffffff'), ...Array(30).fill('#202020'), ...Array(15).fill('#3060c0'), ...Array(5).fill('#e02020')]);
    expect(backgroundClusters(four, Int32Array.from({ length: 100 }, (_, i) => i)).shares.length).toBeLessThanOrEqual(3);
    const tiny = feats([...Array(97).fill('#ffffff'), ...Array(3).fill('#000000')]);
    expect(backgroundClusters(tiny, Int32Array.from({ length: 100 }, (_, i) => i)).shares).toEqual([0.97]);
  });

  it('a cluster on one side of the photo only (an object cut by the edge) is not background', () => {
    // 100 samples: 60 wall on all sides, 40 red object on the bottom side only.
    const f = feats([...Array(60).fill('#f2efe6'), ...Array(40).fill('#c0392b')]);
    const s = Int32Array.from({ length: 100 }, (_, i) => i);
    const allSides = Uint8Array.from({ length: 100 }, (_, i) => (i < 60 ? [1, 2, 4, 8][i % 4] : 2));
    expect(backgroundClusters(f, s, { sides: allSides }).shares).toEqual([0.6]);
    // Two sides (a corner) are not enough either …
    const corner = Uint8Array.from({ length: 100 }, (_, i) => (i < 60 ? [1, 2, 4, 8][i % 4] : [2, 4][i % 2]));
    expect(backgroundClusters(f, s, { sides: corner }).shares).toEqual([0.6]);
    // … a floor that also reaches the left and right sides is kept.
    const floor = Uint8Array.from({ length: 100 }, (_, i) => (i < 60 ? [1, 2, 4, 8][i % 4] : [2, 4, 8][i % 3]));
    expect(backgroundClusters(f, s, { sides: floor }).shares).toEqual([0.6, 0.4]);
    expect(() => backgroundClusters(f, s, { sides: new Uint8Array(3) })).toThrow(RangeError);
  });

  it('no samples → no clusters; deterministic', () => {
    expect(backgroundClusters(new Float32Array(0), new Int32Array(0)).shares).toEqual([]);
    const img = addNoise(stripes(30, 30, [['#ffffff', 3], ['#335577', 2], ['#aa3311', 1]]), 10, 3);
    const f = oklabFeatures(img);
    const s = Int32Array.from({ length: 900 }, (_, i) => i);
    const a = backgroundClusters(f, s);
    const b = backgroundClusters(f, s);
    expect(Array.from(a.centers)).toEqual(Array.from(b.centers));
    expect(a.shares).toEqual(b.shares);
  });
});

describe('flood fill, components, holes', () => {
  it('floods only background-like pixels connected to the frame (4-connected)', () => {
    const m = rows(['.....', '.###.', '.#.#.', '.###.', '.....']);
    // Candidates: every 0 pixel. The enclosed center is not reached.
    const bg = floodFillFromBorder(m.w, m.h, (i) => m.mask[i] === 0);
    expect(toRows(bg, m.w, m.h)).toEqual(['#####', '#...#', '#...#', '#...#', '#####']);
    // A diagonal gap does not leak (4-connected flood).
    const d = rows(['#....', '.#...', '..#..', '...#.', '....#']);
    const bg2 = floodFillFromBorder(5, 5, (i) => d.mask[i] === 0);
    expect(toRows(bg2, 5, 5)).toEqual(['.####', '#.###', '##.##', '###.#', '####.']);
  });

  it('labels 8- and 4-connected components in scan order', () => {
    const m = rows(['#..#', '.#..', '....', '##.#']);
    const c8 = connectedComponents(m.mask, m.w, m.h, { connectivity: 8 });
    expect(c8.sizes).toEqual([2, 1, 2, 1]);
    const c4 = connectedComponents(m.mask, m.w, m.h, { connectivity: 4 });
    expect(c4.sizes).toEqual([1, 1, 1, 2, 1]);
    expect(c8.touchesBorder).toEqual([true, true, true, true]);
    const bg = connectedComponents(m.mask, m.w, m.h, { value: 0, connectivity: 4 });
    expect(bg.sizes.reduce((s, v) => s + v, 0)).toBe(10);
  });

  it('keeps the largest 8-connected component; ties keep the first in scan order', () => {
    const m = rows(['##...', '#....', '...##', '...##', '#....']);
    expect(toRows(keepLargestComponent(m.mask, m.w, m.h), m.w, m.h)).toEqual(['.....', '.....', '...##', '...##', '.....']);
    const t = rows(['##.##', '.....', '.....']);
    expect(toRows(keepLargestComponent(t.mask, t.w, t.h), t.w, t.h)).toEqual(['##...', '.....', '.....']);
    expect(Array.from(keepLargestComponent(new Uint8Array(4), 2, 2))).toEqual([0, 0, 0, 0]);
  });

  it('fills enclosed background (4-connected) but not background open to the frame', () => {
    const m = rows(['.......', '.#####.', '.#...#.', '.#.#.#.', '.#####.', '.......']);
    expect(toRows(fillHoles(m.mask, m.w, m.h), m.w, m.h)).toEqual(['.......', '.#####.', '.#####.', '.#####.', '.#####.', '.......']);
    // A notch that reaches the frame stays open.
    const n = rows(['###.###', '#.....#', '#######']);
    expect(toRows(fillHoles(n.mask, n.w, n.h), n.w, n.h)).toEqual(['###.###', '#.....#', '#######']);
    // A diagonal "wall" encloses for a 4-connected background.
    const d = rows(['.#.', '#.#', '.#.']);
    expect(toRows(fillHoles(d.mask, 3, 3), 3, 3)).toEqual(['.#.', '###', '.#.']);
  });
});

describe('EDT morphology (disc structuring elements)', () => {
  it('matches brute-force disc dilation and erosion on random masks', () => {
    for (let seed = 1; seed <= 12; seed++) {
      const w = 9 + (seed % 5);
      const h = 7 + (seed % 4);
      const m = randomMask(w, h, 0.25 + 0.04 * seed, seed);
      for (const r of [0, 1, 1.5, 2, 3]) {
        expect(Array.from(dilate(m, w, h, r))).toEqual(Array.from(bruteMorph(m, w, h, r, 'dilate')));
        expect(Array.from(erode(m, w, h, r))).toEqual(Array.from(bruteMorph(m, w, h, r, 'erode')));
      }
    }
  });

  it('radius 1 is the 4-neighborhood; the frame is not background', () => {
    const one = rows(['.....', '.....', '..#..', '.....', '.....']);
    expect(toRows(dilate(one.mask, 5, 5, 1), 5, 5)).toEqual(['.....', '..#..', '.###.', '..#..', '.....']);
    const full = new Uint8Array(25).fill(1);
    expect(Array.from(erode(full, 5, 5, 2))).toEqual(Array.from(full));
  });

  it('opening removes specks and thin bridges; closing fills pinholes; both are idempotent', () => {
    const m = rows(['#........', '..####...', '..####...', '..####.#.', '..####...', '.........']);
    expect(toRows(morphOpen(m.mask, m.w, m.h, 1), m.w, m.h)).toEqual(['.........', '...##....', '..####...', '..####...', '...##....', '.........']);
    const hole = rows(['#####', '#####', '##.##', '#####', '#####']);
    expect(toRows(morphClose(hole.mask, 5, 5, 1), 5, 5)).toEqual(['#####', '#####', '#####', '#####', '#####']);
    for (let seed = 20; seed < 26; seed++) {
      const r = randomMask(24, 18, 0.55, seed);
      const o = morphOpen(r, 24, 18, 1);
      expect(Array.from(morphOpen(o, 24, 18, 1))).toEqual(Array.from(o));
      const c = morphClose(r, 24, 18, 2);
      expect(Array.from(morphClose(c, 24, 18, 2))).toEqual(Array.from(c));
    }
  });

  it('rejects bad radii and sizes', () => {
    expect(() => dilate(new Uint8Array(4), 2, 2, -1)).toThrow(RangeError);
    expect(() => erode(new Uint8Array(4), 2, 2, Number.NaN)).toThrow(RangeError);
    expect(() => dilate(new Uint8Array(5), 2, 2, 1)).toThrow(RangeError);
  });
});

describe('stats, guards and IoU', () => {
  it('box, coverage, border contact', () => {
    const m = rows(['......', '..##..', '..###.', '......']);
    expect(maskBox(m.mask, m.w, m.h)).toEqual({ x0: 2, y0: 1, x1: 5, y1: 3, w: 3, h: 2, cx: 3.5, cy: 2 });
    expect(maskStats(m.mask, m.w, m.h)).toMatchObject({ area: 5, coverage: 5 / 24, touchesBorder: false });
    expect(maskBox(new Uint8Array(6), 3, 2)).toBeNull();
  });

  it('warns when the object touches the border or covers < 15% / > 90%; errors when empty', () => {
    const w = 20;
    const h = 20;
    const centered = new Uint8Array(w * h);
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) centered[x + w * y] = 1;
    expect(maskGuards(centered, w, h)).toEqual([]);
    const touching = Uint8Array.from(centered);
    for (let x = 5; x < 15; x++) touching[x + w * 19] = 1;
    expect(maskGuards(touching, w, h, 'front').map((i) => i.code)).toEqual([MASK_ISSUES.border]);
    expect(maskGuards(touching, w, h, 'front')[0].message).toContain('the front photo');
    const small = new Uint8Array(w * h);
    small[210] = 1;
    expect(maskGuards(small, w, h).map((i) => [i.code, i.severity])).toEqual([[MASK_ISSUES.coverage, 'warn']]);
    const big = new Uint8Array(w * h).fill(1);
    expect(maskGuards(big, w, h).map((i) => i.code)).toEqual([MASK_ISSUES.border, MASK_ISSUES.coverage]);
    expect(maskGuards(new Uint8Array(w * h), w, h).map((i) => [i.code, i.severity])).toEqual([[MASK_ISSUES.empty, 'error']]);
  });

  it('IoU', () => {
    expect(maskIoU([1, 1, 0, 0], [1, 0, 1, 0])).toBeCloseTo(1 / 3, 12);
    expect(maskIoU([0, 0], [0, 0])).toBe(1);
    expect(() => maskIoU([1], [1, 0])).toThrow(RangeError);
  });

  it('maskToRgba paints the object only', () => {
    const img = maskToRgba([1, 0], 2, 1, [10, 20, 30], 128);
    expect(Array.from(img.data)).toEqual([10, 20, 30, 128, 0, 0, 0, 0]);
  });
});

describe('brush locks and refineMask', () => {
  it('re-runs largest component, fill holes, open(1), close(closeR)', () => {
    const img = fillRect(fillRect(solid(30, 30, '#000000'), 5, 5, 20, 20, '#ffffff'), 11, 11, 8, 8, '#000000');
    const raw = Uint8Array.from({ length: 900 }, (_, i) => (img.data[4 * i] > 0 ? 1 : 0));
    raw[0] = 1; // a speck far away
    const out = refineMask(raw, 30, 30);
    expect(out[0]).toBe(0);
    expect(out[14 + 30 * 14]).toBe(1); // the hole is filled
    // Opening with a radius-1 disc rounds the four convex corners of the 20 × 20 square.
    expect(maskStats(out, 30, 30).area).toBe(396);
    const kept = refineMask(raw, 30, 30, { keepHoles: true });
    // keepHoles: the 8 × 8 hole stays (closing with r = 2 only fills holes narrower than about 4 px).
    expect(kept[14 + 30 * 14]).toBe(0);
  });

  it('painted pixels win: an erased gap stays open, an added island stays', () => {
    const w = 40;
    const h = 30;
    const raw = new Uint8Array(w * h);
    for (let y = 5; y < 25; y++) for (let x = 5; x < 25; x++) raw[x + w * y] = 1;
    const locks = new Int8Array(w * h);
    paintLocks(locks, w, h, [
      { x: 15, y: 15, r: 3, mode: 'erase' }, // a hole the fill step would close again
      { x: 33, y: 15, r: 3, mode: 'add' }, // an island the largest-component step would drop
    ]);
    const out = refineMask(raw, w, h, {}, locks);
    expect(out[15 + w * 15]).toBe(0);
    expect(out[33 + w * 15]).toBe(1);
    expect(out[6 + w * 6]).toBe(1);
    // Later dabs win.
    paintLocks(locks, w, h, [{ x: 15, y: 15, r: 3, mode: 'add' }]);
    expect(refineMask(raw, w, h, {}, locks)[15 + w * 15]).toBe(1);
  });

  it('rejects malformed dabs and lock layers', () => {
    expect(() => paintLocks(new Int8Array(4), 2, 2, [{ x: Number.NaN, y: 0, r: 1, mode: 'add' }])).toThrow(RangeError);
    expect(() => refineMask(new Uint8Array(4), 2, 2, {}, new Int8Array(3))).toThrow(RangeError);
  });

  it('a 1 × 1 and an empty mask pass through', () => {
    expect(Array.from(refineMask([1], 1, 1))).toEqual([1]);
    expect(Array.from(refineMask(new Uint8Array(9), 3, 3))).toEqual(Array(9).fill(0));
  });
});
