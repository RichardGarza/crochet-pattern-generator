// Synthetic RgbaImage helpers for tests (DESIGN.md §6.1 rule 5). Step 0 owned.
//
// Test images are generated in code, never downloaded. Everything here is deterministic: the helpers that add
// noise take a seed and draw from the kernel's mulberry32.
import { parseHex, toHex } from '../core/kernel/color';
import { mulberry32 } from '../core/kernel/prng';
import type { RgbaImage } from '../types/geometry';

/** A color for the helpers: `#rrggbb` (opaque) or `[r, g, b]` / `[r, g, b, a]` with 8-bit channels. */
export type TestColor = string | readonly [number, number, number] | readonly [number, number, number, number];

function rgba(color: TestColor): [number, number, number, number] {
  if (typeof color === 'string') {
    const [r, g, b] = parseHex(color);
    return [r, g, b, 255];
  }
  return [color[0], color[1], color[2], color.length === 4 ? color[3] : 255];
}

/** A blank (transparent black) image. */
export function blank(w: number, h: number): RgbaImage {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
    throw new Error(`test image size must be integers >= 1, got ${w} × ${h}`);
  }
  return { w, h, data: new Uint8ClampedArray(w * h * 4) };
}

/** An image filled with one color. */
export function solid(w: number, h: number, color: TestColor): RgbaImage {
  return fromFn(w, h, () => color);
}

/** An image whose pixel (x, y) is `fn(x, y)`; x runs left→right, y top→bottom. */
export function fromFn(w: number, h: number, fn: (x: number, y: number) => TestColor): RgbaImage {
  const img = blank(w, h);
  for (let y = 0, o = 0; y < h; y++) {
    for (let x = 0; x < w; x++, o += 4) {
      const [r, g, b, a] = rgba(fn(x, y));
      img.data[o] = r;
      img.data[o + 1] = g;
      img.data[o + 2] = b;
      img.data[o + 3] = a;
    }
  }
  return img;
}

/**
 * An image from text rows: each character is looked up in `colors`. Rows are top→bottom, e.g.
 * `fromRows(['BAAAA', 'ABBBA', 'AABAA'], { A: '#ffffff', B: '#cc0000' })` is the 5 × 3 chart of §2.7.3.
 */
export function fromRows(rows: readonly string[], colors: Readonly<Record<string, TestColor>>): RgbaImage {
  const h = rows.length;
  const w = h > 0 ? rows[0].length : 0;
  for (const row of rows) {
    if (row.length !== w) throw new Error('fromRows: every row must have the same length');
  }
  return fromFn(w, h, (x, y) => {
    const key = rows[y][x];
    const color = colors[key];
    if (color === undefined) throw new Error(`fromRows: no color for ${JSON.stringify(key)}`);
    return color;
  });
}

/** A copy that shares nothing with the original. */
export function clone(img: RgbaImage): RgbaImage {
  return { w: img.w, h: img.h, data: new Uint8ClampedArray(img.data) };
}

/** The pixel at (x, y) as [r, g, b, a]. */
export function pixelAt(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) throw new RangeError(`pixel (${x}, ${y}) is outside ${img.w} × ${img.h}`);
  const o = (y * img.w + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

/** The pixel at (x, y) as `#rrggbb` (alpha ignored). */
export function hexAt(img: RgbaImage, x: number, y: number): string {
  const [r, g, b] = pixelAt(img, x, y);
  return toHex(r, g, b);
}

/** Sets the pixel at (x, y) in place; pixels outside the image are ignored. */
export function setPixel(img: RgbaImage, x: number, y: number, color: TestColor): void {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const [r, g, b, a] = rgba(color);
  const o = (y * img.w + x) * 4;
  img.data[o] = r;
  img.data[o + 1] = g;
  img.data[o + 2] = b;
  img.data[o + 3] = a;
}

/** Fills the rectangle [x0, x0 + w) × [y0, y0 + h) in place (clipped to the image); returns the image. */
export function fillRect(img: RgbaImage, x0: number, y0: number, w: number, h: number, color: TestColor): RgbaImage {
  for (let y = Math.max(0, y0); y < Math.min(img.h, y0 + h); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.w, x0 + w); x++) setPixel(img, x, y, color);
  }
  return img;
}

/**
 * Fills the disc of radius `r` around (cx, cy) in place: a pixel is inside when its center (x + ½, y + ½) is
 * within `r` of the center. Returns the image.
 */
export function fillDisc(img: RgbaImage, cx: number, cy: number, r: number, color: TestColor): RgbaImage {
  for (let y = Math.max(0, Math.floor(cy - r)); y < Math.min(img.h, Math.ceil(cy + r)); y++) {
    for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(img.w, Math.ceil(cx + r)); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r * r) setPixel(img, x, y, color);
    }
  }
  return img;
}

/** A checkerboard of `cell` × `cell` px squares; the top-left square has color `a`. */
export function checker(w: number, h: number, cell: number, a: TestColor, b: TestColor): RgbaImage {
  return fromFn(w, h, (x, y) => ((Math.floor(x / cell) + Math.floor(y / cell)) % 2 === 0 ? a : b));
}

/**
 * Horizontal stripes from the top: `bands` lists [color, height in px]; the list repeats down the image, e.g.
 * `stripes(8, 12, [['#ffffff', 4], ['#000000', 2]])` is a 4/2 stripe sequence.
 */
export function stripes(w: number, h: number, bands: readonly (readonly [TestColor, number])[]): RgbaImage {
  const period = bands.reduce((sum, [, height]) => sum + height, 0);
  if (bands.length === 0 || !(period > 0)) throw new Error('stripes: bands must have a positive total height');
  return fromFn(w, h, (_x, y) => {
    let t = y % period;
    for (const [color, height] of bands) {
      if (t < height) return color;
      t -= height;
    }
    return bands[0][0];
  });
}

/** A left→right linear gradient between two colors, interpolated in sRGB code values. */
export function gradient(w: number, h: number, from: TestColor, to: TestColor): RgbaImage {
  const a = rgba(from);
  const b = rgba(to);
  return fromFn(w, h, (x) => {
    const t = w > 1 ? x / (w - 1) : 0;
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
      Math.round(a[3] + (b[3] - a[3]) * t),
    ];
  });
}

/** Nearest-neighbor upscale by an integer factor (pixel art: one source pixel → factor × factor block). */
export function upscale(img: RgbaImage, factor: number): RgbaImage {
  if (!Number.isInteger(factor) || factor < 1) throw new Error(`upscale: factor must be an integer >= 1, got ${factor}`);
  const out = blank(img.w * factor, img.h * factor);
  for (let y = 0; y < out.h; y++) {
    const sy = Math.floor(y / factor);
    for (let x = 0; x < out.w; x++) {
      const s = (sy * img.w + Math.floor(x / factor)) * 4;
      const o = (y * out.w + x) * 4;
      out.data[o] = img.data[s];
      out.data[o + 1] = img.data[s + 1];
      out.data[o + 2] = img.data[s + 2];
      out.data[o + 3] = img.data[s + 3];
    }
  }
  return out;
}

/** Tiles `img` to exactly w × h pixels, starting at the top-left (the last column and row may be cut). */
export function tile(img: RgbaImage, w: number, h: number): RgbaImage {
  const out = blank(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y % img.h) * img.w + (x % img.w)) * 4;
      const o = (y * w + x) * 4;
      out.data[o] = img.data[s];
      out.data[o + 1] = img.data[s + 1];
      out.data[o + 2] = img.data[s + 2];
      out.data[o + 3] = img.data[s + 3];
    }
  }
  return out;
}

/**
 * A copy with uniform noise of ±`amplitude` (in 8-bit code values) added to R, G and B of every pixel
 * independently — "JPEG-like" noise. Alpha is kept.
 */
export function addNoise(img: RgbaImage, amplitude: number, seed: number): RgbaImage {
  const rng = mulberry32(seed);
  const out = clone(img);
  for (let o = 0; o < out.data.length; o += 4) {
    for (let c = 0; c < 3; c++) {
      out.data[o + c] = out.data[o + c] + Math.round((rng() * 2 - 1) * amplitude);
    }
  }
  return out;
}

/**
 * A copy in which a `fraction` of the pixels (each chosen independently) is replaced by one of `colors` — label
 * noise, e.g. "a 6 × 8 motif tiled to 40 × 45 with 3% noise".
 */
export function replaceRandomPixels(img: RgbaImage, fraction: number, colors: readonly TestColor[], seed: number): RgbaImage {
  if (colors.length === 0) throw new Error('replaceRandomPixels: colors must not be empty');
  const rng = mulberry32(seed);
  const out = clone(img);
  for (let y = 0; y < out.h; y++) {
    for (let x = 0; x < out.w; x++) {
      if (rng() < fraction) setPixel(out, x, y, colors[Math.floor(rng() * colors.length)]);
    }
  }
  return out;
}

/** The distinct `#rrggbb` colors of an image with their pixel counts, most frequent first (ties: by hex). */
export function colorCounts(img: RgbaImage): { hex: string; count: number }[] {
  const counts = new Map<string, number>();
  for (let o = 0; o < img.data.length; o += 4) {
    const hex = toHex(img.data[o], img.data[o + 1], img.data[o + 2]);
    counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([hex, count]) => ({ hex, count }))
    .sort((p, q) => q.count - p.count || (p.hex < q.hex ? -1 : 1));
}

/** True when both images have the same size and identical bytes. */
export function sameImage(a: RgbaImage, b: RgbaImage): boolean {
  if (a.w !== b.w || a.h !== b.h || a.data.length !== b.data.length) return false;
  for (let i = 0; i < a.data.length; i++) {
    if (a.data[i] !== b.data[i]) return false;
  }
  return true;
}
