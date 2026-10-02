// Synthetic test pictures for the T1 tests (DESIGN.md §6.1 rule 5: generated in code, never downloaded).
// Built on the S0 helpers of src/test/rgba.ts; everything is deterministic (seeded mulberry32).
import { mulberry32 } from '../../kernel/prng';
import { blank, fillDisc, fillRect, fromFn, setPixel, type TestColor } from '../../../test/rgba';
import type { RgbaImage } from '../../../types/geometry';

/** Six sprite colors, far apart (pairwise ΔEOKr2 > 0.15). */
export const SPRITE_PALETTE = ['#1d1d3a', '#f4e9d8', '#d93a3a', '#3a8f4b', '#f2c12e', '#3a6fd9'] as const;

/** A w × h sprite whose every pixel is an independent random palette color (the hardest case for 1:1). */
export function randomSprite(w: number, h: number, seed: number, palette: readonly string[] = SPRITE_PALETTE): RgbaImage {
  const rng = mulberry32(seed);
  return fromFn(w, h, () => palette[Math.floor(rng() * palette.length)]);
}

/**
 * A 32 × 32 "character" sprite: sky background, a body disc with a 1-px dark outline, 1-px eyes, a 2-px mouth,
 * feet and a few random 1-px sparkles in the sky.
 */
export function characterSprite(seed = 7): RgbaImage {
  const [ink, cream, red, green, yellow, blue] = SPRITE_PALETTE;
  const img = fromFn(32, 32, () => blue);
  fillDisc(img, 16, 15, 11, ink);
  fillDisc(img, 16, 15, 10, red);
  fillDisc(img, 16, 18, 6, cream);
  setPixel(img, 12, 11, ink);
  setPixel(img, 19, 11, ink);
  fillRect(img, 14, 20, 4, 1, ink);
  fillRect(img, 9, 26, 4, 3, green);
  fillRect(img, 19, 26, 4, 3, green);
  const rng = mulberry32(seed);
  for (let i = 0; i < 12; i++) {
    const x = Math.floor(rng() * 32);
    const y = Math.floor(rng() * 5);
    setPixel(img, x, y, yellow);
  }
  return img;
}

/** Nearest-neighbor resize to exactly W × H (any factor, also non-integer). */
export function resizeNearest(img: RgbaImage, W: number, H: number): RgbaImage {
  const out = blank(W, H);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(img.h - 1, Math.floor((y * img.h) / H));
    for (let x = 0; x < W; x++) {
      const sx = Math.min(img.w - 1, Math.floor((x * img.w) / W));
      const s = (sy * img.w + sx) * 4;
      const o = (y * W + x) * 4;
      for (let c = 0; c < 4; c++) out.data[o + c] = img.data[s + c];
    }
  }
  return out;
}

/** 3 × 3 box blur in sRGB code values (edges clamp): the softening of a resampler or a JPEG encoder. */
export function blur3(img: RgbaImage): RgbaImage {
  const out = blank(img.w, img.h);
  for (let y = 0; y < img.h; y++) {
    for (let x = 0; x < img.w; x++) {
      for (let c = 0; c < 4; c++) {
        let s = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = Math.min(img.w - 1, Math.max(0, x + dx));
            const yy = Math.min(img.h - 1, Math.max(0, y + dy));
            s += img.data[(yy * img.w + xx) * 4 + c];
          }
        }
        out.data[(y * img.w + x) * 4 + c] = Math.round(s / 9);
      }
    }
  }
  return out;
}

/** A photo-like picture: smooth lighting, soft shapes, fine texture and sensor noise. */
export function photoLike(w: number, h: number, seed: number): RgbaImage {
  const rng = mulberry32(seed);
  const noise = (): number => (rng() - 0.5) * 14;
  return fromFn(w, h, (x, y) => {
    const u = x / w;
    const v = y / h;
    const light = 0.55 + 0.35 * Math.sin(3.1 * u + 1.3) * Math.cos(2.3 * v);
    const blob = Math.exp(-(((u - 0.55) ** 2 + (v - 0.45) ** 2) / 0.03));
    const tex = 0.06 * Math.sin(x * 0.9) * Math.sin(y * 1.3);
    const r = 255 * (light * (0.45 + 0.5 * blob) + tex) + noise();
    const g = 255 * (light * (0.55 - 0.3 * blob) + tex) + noise();
    const b = 255 * (light * (0.35 + 0.1 * u) + tex) + noise();
    const clip = (t: number): number => Math.max(0, Math.min(255, Math.round(t)));
    return [clip(r), clip(g), clip(b)];
  });
}

/**
 * A two-color logo with anti-aliased edges (4 × 4 supersampled): a ring, a filled disc and a bar, in `ink` on
 * `paper`.
 */
export function logo(w: number, h: number, ink: TestColor = '#c8102e', paper: TestColor = '#ffffff'): RgbaImage {
  const inside = (x: number, y: number): boolean => {
    const u = x / w;
    const v = y / h;
    const r = Math.hypot(u - 0.35, v - 0.5);
    const ring = r > 0.22 && r < 0.3;
    const dot = Math.hypot(u - 0.35, v - 0.5) < 0.1;
    const bar = u > 0.7 && u < 0.85 && v > 0.2 && v < 0.8;
    return ring || dot || bar;
  };
  const toRgb = (c: TestColor): [number, number, number] => {
    if (typeof c === 'string') return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    return [c[0], c[1], c[2]];
  };
  const a = toRgb(ink);
  const b = toRgb(paper);
  return fromFn(w, h, (x, y) => {
    let k = 0;
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) if (inside(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4)) k++;
    const t = k / 16;
    return [Math.round(b[0] + (a[0] - b[0]) * t), Math.round(b[1] + (a[1] - b[1]) * t), Math.round(b[2] + (a[2] - b[2]) * t)];
  });
}

/**
 * "The flat-art image" of the T1.3 cleanup tests (research 06 §12, golden 1: a flat logo with 2 px outlines):
 * sky and ground, a sun and a house with 2 px dark outlines, a door, a window and three bars of "lettering",
 * anti-aliased (4 × 4 supersampled, mixed in sRGB like most renderers). Outline width = `outline` px.
 */
export function flatArt(w: number, h: number, outline = 2): RgbaImage {
  const hex = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
  const SKY = hex('#8fd3f4');
  const GROUND = hex('#5a9e3a');
  const INK = hex('#1e1e28');
  const SUN = hex('#f9d71c');
  const WALL = hex('#c0392b');
  const DOOR = hex('#6b3e26');
  const GLASS = hex('#f4f1e8');
  const TEXT = hex('#2c3e8f');
  const t = outline;
  const at = (x: number, y: number): [number, number, number] => {
    // Sun: disc with an outline ring.
    const sr = Math.hypot(x - 0.75 * w, y - 0.25 * h);
    const R = 0.15 * h;
    if (sr <= R) return sr > R - t ? INK : SUN;
    // House: an outlined rectangle with a door and a window.
    const hx0 = 0.12 * w;
    const hx1 = 0.45 * w;
    const hy0 = 0.35 * h;
    const hy1 = 0.8 * h;
    if (x >= hx0 && x < hx1 && y >= hy0 && y < hy1) {
      if (x < hx0 + t || x >= hx1 - t || y < hy0 + t || y >= hy1 - t) return INK;
      if (x >= 0.25 * w && x < 0.32 * w && y >= 0.58 * h) return DOOR;
      if (x >= 0.16 * w && x < 0.22 * w && y >= 0.42 * h && y < 0.52 * h) return GLASS;
      return WALL;
    }
    // Lettering: three bars.
    for (let k = 0; k < 3; k++) {
      const bx = 0.55 * w + k * 0.12 * w;
      if (x >= bx && x < bx + 0.07 * w && y >= 0.55 * h && y < 0.75 * h) return TEXT;
    }
    return y < 0.82 * h ? SKY : GROUND;
  };
  return fromFn(w, h, (x, y) => {
    let r = 0;
    let g = 0;
    let b = 0;
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const c = at(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
        r += c[0];
        g += c[1];
        b += c[2];
      }
    }
    return [Math.round(r / 16), Math.round(g / 16), Math.round(b / 16)];
  });
}

/**
 * A `width`-px dark ring of radius 0.4·n around `fill` on a cream background, n × n, anti-aliased (4 × 4
 * supersampled): the "2-px outline" of the T1.3 acceptance test.
 */
export function outlinedRing(n: number, width = 2, fill = '#f9d71c'): RgbaImage {
  const bg = [240, 236, 220];
  const ink = [30, 30, 40];
  const fc = [parseInt(fill.slice(1, 3), 16), parseInt(fill.slice(3, 5), 16), parseInt(fill.slice(5, 7), 16)];
  const R = 0.4 * n;
  return fromFn(n, n, (x, y) => {
    let k = 0;
    let f = 0;
    for (let sy = 0; sy < 4; sy++) {
      for (let sx = 0; sx < 4; sx++) {
        const d = Math.hypot(x + (sx + 0.5) / 4 - n / 2, y + (sy + 0.5) / 4 - n / 2);
        if (d <= R && d > R - width) k++;
        else if (d <= R - width) f++;
      }
    }
    return [0, 1, 2].map((c) => Math.round((bg[c] * (16 - k - f) + ink[c] * k + fc[c] * f) / 16)) as [number, number, number];
  });
}
