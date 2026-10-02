// Track T2.3 — crop, rotate and flip of the source picture (DESIGN.md §1.3 F1 step 2, §2.3.1 step 2).
//
// The stored `CropRect` is in decoded-image pixels before the rotation; the picture is then turned clockwise by
// `rotate` and mirrored (`flipX`) after turning. The Source tab shows the picture as the chart will see it
// ("display space": turned and mirrored), so the crop handles are dragged there and converted back to source
// pixels when stored. Rotations are multiples of 90°, so a rectangle stays a rectangle both ways. Pure.
import type { CSSProperties } from 'react';
import type { CropRect } from '../../types';

export type Rotation = CropRect['rotate'];

export interface Size {
  w: number;
  h: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Orientation {
  rotate: Rotation;
  flipX: boolean;
}

/** The picture's size as shown (after turning). */
export function displaySize(src: Size, rotate: Rotation): Size {
  return rotate === 90 || rotate === 270 ? { w: src.h, h: src.w } : { w: src.w, h: src.h };
}

/** A source point as shown: turned clockwise, then mirrored. */
export function toDisplayPoint(src: Size, o: Orientation, x: number, y: number): [number, number] {
  let dx: number;
  let dy: number;
  switch (o.rotate) {
    case 90:
      [dx, dy] = [src.h - y, x];
      break;
    case 180:
      [dx, dy] = [src.w - x, src.h - y];
      break;
    case 270:
      [dx, dy] = [y, src.w - x];
      break;
    default:
      [dx, dy] = [x, y];
  }
  if (o.flipX) dx = displaySize(src, o.rotate).w - dx;
  return [dx, dy];
}

/** A shown point back in source pixels. */
export function toSourcePoint(src: Size, o: Orientation, dx: number, dy: number): [number, number] {
  const x1 = o.flipX ? displaySize(src, o.rotate).w - dx : dx;
  switch (o.rotate) {
    case 90:
      return [dy, src.h - x1];
    case 180:
      return [src.w - x1, src.h - dy];
    case 270:
      return [src.w - dy, x1];
    default:
      return [x1, dy];
  }
}

function rectOf(a: [number, number], b: [number, number]): Rect {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return { x, y, w: Math.abs(a[0] - b[0]), h: Math.abs(a[1] - b[1]) };
}

export function toDisplayRect(src: Size, o: Orientation, r: Rect): Rect {
  return rectOf(toDisplayPoint(src, o, r.x, r.y), toDisplayPoint(src, o, r.x + r.w, r.y + r.h));
}

export function toSourceRect(src: Size, o: Orientation, r: Rect): Rect {
  return rectOf(toSourcePoint(src, o, r.x, r.y), toSourcePoint(src, o, r.x + r.w, r.y + r.h));
}

/** The whole picture, upright. */
export function fullCrop(src: Size): CropRect {
  return { x: 0, y: 0, w: src.w, h: src.h, rotate: 0, flipX: false };
}

/** The stored crop as a normalized source rectangle inside the picture (whole pixels, at least 1 × 1). */
export function cropRectOf(src: Size, crop: CropRect | undefined): Rect {
  if (!crop) return { x: 0, y: 0, w: src.w, h: src.h };
  const x0 = clamp(Math.round(Math.min(crop.x, crop.x + crop.w)), 0, src.w - 1);
  const y0 = clamp(Math.round(Math.min(crop.y, crop.y + crop.h)), 0, src.h - 1);
  const x1 = clamp(Math.round(Math.max(crop.x, crop.x + crop.w)), x0 + 1, src.w);
  const y1 = clamp(Math.round(Math.max(crop.y, crop.y + crop.h)), y0 + 1, src.h);
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

export function orientationOf(crop: CropRect | undefined): Orientation {
  return { rotate: crop?.rotate ?? 0, flipX: crop?.flipX ?? false };
}

/** True when the crop keeps the whole picture (only the orientation may differ). */
export function isFullCrop(src: Size, crop: CropRect | undefined): boolean {
  const r = cropRectOf(src, crop);
  return r.x === 0 && r.y === 0 && r.w === src.w && r.h === src.h;
}

/** The stored crop for a shown rectangle and orientation (whole pixels, clipped to the picture). */
export function cropFromDisplay(src: Size, o: Orientation, shown: Rect): CropRect {
  const r = cropRectOf(src, { ...toSourceRect(src, o, shown), ...o });
  return { ...r, rotate: o.rotate, flipX: o.flipX };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Turns the picture a quarter clockwise (+1) or counter-clockwise (−1); the crop stays on the same pixels. */
export function rotateCrop(src: Size, crop: CropRect | undefined, dir: 1 | -1): CropRect {
  const base = crop ?? fullCrop(src);
  const rotate = ((((base.rotate + dir * 90) % 360) + 360) % 360) as Rotation;
  // Turning a mirrored picture clockwise is the plain picture turned the other way: keep the mirror after it.
  return { ...cropRectOf(src, base), rotate, flipX: base.flipX };
}

/** Mirrors the picture left ↔ right (as shown). */
export function flipCrop(src: Size, crop: CropRect | undefined): CropRect {
  const base = crop ?? fullCrop(src);
  return { ...cropRectOf(src, base), rotate: base.rotate, flipX: !base.flipX };
}

/** The largest rectangle of this aspect (w / h) inside `around`, on its center (and inside the bounds). */
export function fitAspect(around: Rect, aspect: number, bounds: Size): Rect {
  if (!(aspect > 0)) return around;
  const w = Math.min(around.w, around.h * aspect, bounds.w, bounds.h * aspect);
  const h = w / aspect;
  const x = clamp(around.x + (around.w - w) / 2, 0, bounds.w - w);
  const y = clamp(around.y + (around.h - h) / 2, 0, bounds.h - h);
  return { x, y, w, h };
}

/** The largest rectangle of this aspect inside the bounds, centered. */
export function largestOfAspect(aspect: number, bounds: Size): Rect {
  const w = Math.min(bounds.w, bounds.h * aspect);
  const h = w / aspect;
  return { x: (bounds.w - w) / 2, y: (bounds.h - h) / 2, w, h };
}

export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/**
 * A crop rectangle dragged by a handle by (dx, dy), in shown pixels: clipped to the picture, at least `min` on a
 * side, and of the given aspect when one is locked (the dragged edge leads; a corner keeps the opposite corner).
 */
export function dragRect(r: Rect, handle: Handle, dx: number, dy: number, bounds: Size, o: { aspect?: number | null; min?: number } = {}): Rect {
  const min = Math.max(1, o.min ?? 8);
  if (handle === 'move') {
    return { x: clamp(r.x + dx, 0, bounds.w - r.w), y: clamp(r.y + dy, 0, bounds.h - r.h), w: r.w, h: r.h };
  }
  let x0 = r.x;
  let y0 = r.y;
  let x1 = r.x + r.w;
  let y1 = r.y + r.h;
  if (handle.includes('w')) x0 = clamp(x0 + dx, 0, x1 - min);
  if (handle.includes('e')) x1 = clamp(x1 + dx, x0 + min, bounds.w);
  if (handle.includes('n')) y0 = clamp(y0 + dy, 0, y1 - min);
  if (handle.includes('s')) y1 = clamp(y1 + dy, y0 + min, bounds.h);
  const aspect = o.aspect;
  if (!(aspect && aspect > 0)) return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  // Aspect locked: the width leads for e/w and corners, the height for n/s; the anchor is the opposite side.
  let w = x1 - x0;
  let h = y1 - y0;
  if (handle === 'n' || handle === 's') w = h * aspect;
  else h = w / aspect;
  const anchorX = handle.includes('w') ? x1 : handle.includes('e') ? x0 : r.x + r.w / 2;
  const anchorY = handle.includes('n') ? y1 : handle.includes('s') ? y0 : r.y + r.h / 2;
  // Room on each side of the anchor.
  const roomW = handle.includes('w') ? anchorX : handle.includes('e') ? bounds.w - anchorX : 2 * Math.min(anchorX, bounds.w - anchorX);
  const roomH = handle.includes('n') ? anchorY : handle.includes('s') ? bounds.h - anchorY : 2 * Math.min(anchorY, bounds.h - anchorY);
  const scale = Math.min(1, roomW / w, roomH / h);
  w *= scale;
  h *= scale;
  const nx = handle.includes('w') ? anchorX - w : handle.includes('e') ? anchorX : anchorX - w / 2;
  const ny = handle.includes('n') ? anchorY - h : handle.includes('s') ? anchorY : anchorY - h / 2;
  return { x: nx, y: ny, w, h };
}

/** The aspect (w / h) of a shown rectangle. */
export function aspectOf(r: Size): number {
  return r.h > 0 ? r.w / r.h : 1;
}

/** The CSS of an element that covers the whole turned picture with the source-oriented content inside it. */
export function sourceLayerStyle(src: Size, o: Orientation, scale: number): CSSProperties {
  return {
    position: 'absolute',
    left: '50%',
    top: '50%',
    width: src.w * scale,
    height: src.h * scale,
    transform: `translate(-50%, -50%)${o.flipX ? ' scaleX(-1)' : ''}${o.rotate ? ` rotate(${o.rotate}deg)` : ''}`,
    transformOrigin: 'center',
  };
}

/** The largest scale at which a box of `size` fits in `room` (never above `max`). */
export function fitScale(size: Size, room: Size, max = Infinity): number {
  if (!(size.w > 0 && size.h > 0 && room.w > 0 && room.h > 0)) return 0;
  return Math.min(max, room.w / size.w, room.h / size.h);
}
