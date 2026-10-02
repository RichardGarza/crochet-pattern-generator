// Track T2.3 — the background brush of the Source tab (DESIGN.md §2.3.2, integration-s1 T2 task 5).
//
// The brush lives on the analysis grid of the UNCROPPED source picture — `limitedSize(W, H)` of T1's
// `core/image2d/linear.ts` (the long side at most 2048 px) — so it survives crop changes; the worker maps each
// working pixel to the brush cell under its center. One byte per cell: 0 automatic, 1 background, 2 subject.
// It is stored as `twoD.backgroundEdits`, a PNG whose red channel holds those values, and reaches the worker
// decoded as `ChartRequest.backgroundEdits` with `key` = the PNG asset's sha256. Pure; tested in node.
import { limitedSize } from '../../core/image2d/linear';
import { decodePng, encodePng } from '../../core/kernel/png';
import type { RgbaImage } from '../../types';

export const BRUSH_AUTO = 0;
export const BRUSH_BACKGROUND = 1;
export const BRUSH_SUBJECT = 2;
export type BrushValue = 0 | 1 | 2;

export interface BrushGrid {
  w: number;
  h: number;
}

export interface BrushMask extends BrushGrid {
  data: Uint8Array<ArrayBuffer>;
}

/** The brush grid of a source picture of W × H pixels (§2.3.2). */
export function brushGrid(src: { w: number; h: number }): BrushGrid {
  return limitedSize(src.w, src.h);
}

export function emptyBrush(src: { w: number; h: number }): BrushMask {
  const g = brushGrid(src);
  return { ...g, data: new Uint8Array(g.w * g.h) };
}

/** A source pixel position in brush cells. */
export function toBrush(src: { w: number; h: number }, g: BrushGrid, x: number, y: number): [number, number] {
  return [(x * g.w) / src.w, (y * g.h) / src.h];
}

/** Paints a disc of `radius` brush cells around (cx, cy). Returns how many cells changed. */
export function paintDisc(mask: BrushMask, cx: number, cy: number, radius: number, value: BrushValue): number {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(mask.w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(mask.h - 1, Math.ceil(cy + r));
  const r2 = r * r;
  let changed = 0;
  for (let y = y0; y <= y1; y++) {
    const ddy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const ddx = x + 0.5 - cx;
      if (ddx * ddx + ddy * ddy > r2) continue;
      const i = y * mask.w + x;
      if (mask.data[i] !== value) {
        mask.data[i] = value;
        changed++;
      }
    }
  }
  return changed;
}

/** Paints discs along a segment, at most half a radius apart, so a fast drag leaves no gaps. */
export function paintStroke(mask: BrushMask, from: [number, number], to: [number, number], radius: number, value: BrushValue): number {
  const len = Math.hypot(to[0] - from[0], to[1] - from[1]);
  const steps = Math.max(1, Math.ceil(len / Math.max(0.5, radius / 2)));
  let changed = 0;
  for (let k = 0; k <= steps; k++) {
    const t = k / steps;
    changed += paintDisc(mask, from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, radius, value);
  }
  return changed;
}

export function isEmptyBrush(mask: Pick<BrushMask, 'data'>): boolean {
  for (let i = 0; i < mask.data.length; i++) if (mask.data[i] !== 0) return false;
  return true;
}

/** Counts of brushed cells. */
export function brushCounts(mask: Pick<BrushMask, 'data'>): { background: number; subject: number } {
  let background = 0;
  let subject = 0;
  for (let i = 0; i < mask.data.length; i++) {
    if (mask.data[i] === BRUSH_BACKGROUND) background++;
    else if (mask.data[i] === BRUSH_SUBJECT) subject++;
  }
  return { background, subject };
}

/** The PNG of a brush: red channel = the value, opaque. */
export function encodeBrush(mask: BrushMask): Uint8Array<ArrayBuffer> {
  const rgba = new Uint8ClampedArray(mask.w * mask.h * 4);
  for (let i = 0; i < mask.data.length; i++) {
    rgba[4 * i] = mask.data[i];
    rgba[4 * i + 3] = 255;
  }
  const img: RgbaImage = { w: mask.w, h: mask.h, data: rgba };
  return encodePng(img);
}

/** A brush PNG back to its values (anything above 2 reads as automatic). Throws on a PNG it cannot read. */
export function decodeBrush(bytes: Uint8Array): BrushMask {
  const img = decodePng(bytes);
  const data = new Uint8Array(img.w * img.h);
  for (let i = 0; i < data.length; i++) {
    const v = img.data[4 * i];
    data[i] = v === 1 || v === 2 ? v : 0;
  }
  return { w: img.w, h: img.h, data };
}

/** True when a stored brush belongs to this source (its grid is the source's brush grid; §2.3.2 W_BG_EDITS_STALE). */
export function brushFits(mask: BrushGrid, src: { w: number; h: number }): boolean {
  const g = brushGrid(src);
  return mask.w === g.w && mask.h === g.h;
}
