// The brushed background (DESIGN.md §2.3.2): `ChartRequest.backgroundEdits` mapped onto the working image.
// Track T1, sprint T1.2 (integration task 2 of Sprint 1). Pure, no DOM.
//
// The brush is stored on the "brush grid": the UNCROPPED decoded source of W × H pixels scaled by
// `limitedSize(W, H)` (≤ 2048 px on the long side), one byte per cell — 0 automatic, 1 background, 2 subject — so
// it survives crop changes. Every working pixel reads the brush cell under its center through the inverse flip,
// rotation and crop (nearest neighbour). A brush whose size is not that grid (the source was replaced) is
// ignored with `W_BG_EDITS_STALE`.
import type { ChartRequest, CropRect } from '../../types/chart';
import type { Issue } from '../../types/issues';
import { fnv1a64Hex } from '../kernel/hash';
import { cropBounds } from './crop';
import { limitedSize } from './linear';

/** A brush cell value: 0 = automatic, 1 = background, 2 = subject. */
export const BRUSH_AUTO = 0;
export const BRUSH_BACKGROUND = 1;
export const BRUSH_SUBJECT = 2;

export type BackgroundEdits = NonNullable<ChartRequest['backgroundEdits']>;

/** The cache identity of a brush: its asset key, or the hash of its size and bytes when it has none. */
export function brushKey(edits: BackgroundEdits): string {
  if (edits.key !== undefined && edits.key !== '') return edits.key;
  return `fnv:${edits.w}x${edits.h}:${fnv1a64Hex(edits.data)}`;
}

/** The brush grid of a decoded source of `w × h` pixels (§2.3.2). */
export function brushGridSize(w: number, h: number): { w: number; h: number } {
  return limitedSize(w, h);
}

/**
 * The brush under every pixel of the working image (`work`, the crop after rotation and flip, possibly scaled
 * down): 0/1/2 per pixel, or undefined (with `W_BG_EDITS_STALE`) when the brush does not fit the source's
 * brush grid. A brush with no background or subject cell under the crop maps to undefined without an issue.
 */
export function mapBrush(
  edits: BackgroundEdits,
  source: { w: number; h: number },
  crop: CropRect | undefined,
  work: { w: number; h: number },
): { map?: Uint8Array<ArrayBuffer>; issues: Issue[] } {
  const grid = brushGridSize(source.w, source.h);
  if (edits.w !== grid.w || edits.h !== grid.h || !(edits.data instanceof Uint8Array) || edits.data.length !== edits.w * edits.h) {
    return {
      issues: [
        {
          code: 'W_BG_EDITS_STALE',
          severity: 'warn',
          message: `The background brush was painted on another picture (${edits.w} × ${edits.h}; this one needs ${grid.w} × ${grid.h}), so it was ignored. Brush the background again.`,
        },
      ],
    };
  }
  const { x0, y0, x1, y1 } = crop !== undefined ? cropBounds(source, crop) : { x0: 0, y0: 0, x1: source.w, y1: source.h };
  const rot = crop?.rotate ?? 0;
  const flip = crop?.flipX ?? false;
  const cropW = x1 - x0;
  const cropH = y1 - y0;
  const turned = rot === 90 || rot === 270;
  const cw = turned ? cropH : cropW; // the cropped picture after rotation
  const ch = turned ? cropW : cropH;
  const sx = edits.w / source.w;
  const sy = edits.h / source.h;
  const map = new Uint8Array(work.w * work.h);
  const d = edits.data;
  let any = false;
  for (let y = 0; y < work.h; y++) {
    const cy = ((y + 0.5) * ch) / work.h;
    for (let x = 0; x < work.w; x++) {
      let cx = ((x + 0.5) * cw) / work.w;
      if (flip) cx = cw - cx;
      // (cx, cy) in the rotated crop → (u, v) in the crop rectangle before the rotation (the inverse of applyCrop).
      let u: number;
      let v: number;
      if (rot === 90) {
        u = cy;
        v = cropH - cx;
      } else if (rot === 180) {
        u = cropW - cx;
        v = cropH - cy;
      } else if (rot === 270) {
        u = cropW - cy;
        v = cx;
      } else {
        u = cx;
        v = cy;
      }
      const bx = Math.min(edits.w - 1, Math.max(0, Math.floor((x0 + u) * sx)));
      const by = Math.min(edits.h - 1, Math.max(0, Math.floor((y0 + v) * sy)));
      const b = d[by * edits.w + bx];
      if (b === BRUSH_BACKGROUND || b === BRUSH_SUBJECT) {
        map[y * work.w + x] = b;
        any = true;
      }
    }
  }
  return any ? { map, issues: [] } : { issues: [] };
}
