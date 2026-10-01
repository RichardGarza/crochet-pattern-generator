// The authored crop (DESIGN.md §2.3.1 step 2): crop, rotate in 90° steps, flip. Track T1, sprint T1.1.
//
// Conventions (the frozen `CropRect` does not state them; recorded in docs/tracks/t1.md):
//   - `x, y, w, h` are in pixels of the decoded image (orientation already applied by decode), BEFORE the
//     rotation; edges are rounded to whole pixels and clipped to the image; a negative w or h extends left or
//     up; a crop that overlaps the image keeps at least one pixel per axis;
//   - `rotate` turns the cropped picture clockwise, as CSS `rotate(90deg)` does;
//   - `flipX` mirrors the rotated picture left ↔ right.
import type { CropRect } from '../../types/chart';
import type { RgbaImage } from '../../types/geometry';
import { checkRgbaImage } from './linear';

/** The crop rectangle of `crop` clipped to the image, in whole pixels: `[x0, x1) × [y0, y1)`. Throws when it misses the image. */
export function cropBounds(img: { w: number; h: number }, crop: CropRect): { x0: number; y0: number; x1: number; y1: number } {
  for (const k of ['x', 'y', 'w', 'h'] as const) {
    if (typeof crop[k] !== 'number' || !Number.isFinite(crop[k])) throw new RangeError(`applyCrop: crop.${k} must be a finite number`);
  }
  const axis = (pos: number, len: number, size: number): [number, number] | undefined => {
    // A negative extent (a drag up or to the left) covers [pos + len, pos).
    const a = Math.min(pos, pos + len);
    const b = Math.max(pos, pos + len);
    if (!(b > 0 && a < size)) return undefined;
    let lo = Math.min(size, Math.max(0, Math.round(a)));
    let hi = Math.min(size, Math.max(0, Math.round(b)));
    // A sliver that overlaps the image keeps at least one pixel.
    if (hi <= lo) {
      lo = Math.min(Math.max(0, Math.floor(a)), size - 1);
      hi = lo + 1;
    }
    return [lo, hi];
  };
  const x = axis(crop.x, crop.w, img.w);
  const y = axis(crop.y, crop.h, img.h);
  if (x === undefined || y === undefined || crop.w === 0 || crop.h === 0) {
    throw new RangeError(`applyCrop: the crop ${crop.w} × ${crop.h} at (${crop.x}, ${crop.y}) leaves no pixels of the ${img.w} × ${img.h} image`);
  }
  return { x0: x[0], y0: y[0], x1: x[1], y1: y[1] };
}

/**
 * The image after the authored crop: crop, then rotate clockwise by `rotate`, then mirror left ↔ right when
 * `flipX`. Without a crop the image itself is returned (not a copy). Throws a RangeError for a crop that
 * leaves no pixels or a rotation other than 0, 90, 180, 270.
 */
export function applyCrop(img: RgbaImage, crop?: CropRect): RgbaImage {
  checkRgbaImage(img, 'applyCrop');
  if (crop === undefined) return img;
  const rot = crop.rotate;
  if (rot !== 0 && rot !== 90 && rot !== 180 && rot !== 270) {
    throw new RangeError(`applyCrop: rotate must be 0, 90, 180 or 270, got ${String(rot)}`);
  }
  const { x0, y0, x1, y1 } = cropBounds(img, crop);
  const cw = x1 - x0;
  const ch = y1 - y0;
  if (rot === 0 && !crop.flipX && cw === img.w && ch === img.h) return img;
  const turned = rot === 90 || rot === 270;
  const w = turned ? ch : cw;
  const h = turned ? cw : ch;
  const out = new Uint8ClampedArray(w * h * 4);
  const src = img.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // (x, y) in the output → (u, v) in the cropped picture before the flip and rotation.
      const xf = crop.flipX ? w - 1 - x : x;
      let u: number;
      let v: number;
      if (rot === 0) {
        u = xf;
        v = y;
      } else if (rot === 90) {
        u = y;
        v = ch - 1 - xf;
      } else if (rot === 180) {
        u = cw - 1 - xf;
        v = ch - 1 - y;
      } else {
        u = cw - 1 - y;
        v = xf;
      }
      const s = ((y0 + v) * img.w + (x0 + u)) * 4;
      const o = (y * w + x) * 4;
      out[o] = src[s];
      out[o + 1] = src[s + 1];
      out[o + 2] = src[s + 2];
      out[o + 3] = src[s + 3];
    }
  }
  return { w, h, data: out };
}
