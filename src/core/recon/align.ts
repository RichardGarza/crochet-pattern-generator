// Track T3 — view conventions and alignment of labelled photo masks (DESIGN.md §2.9.2, research 04 §4.2–4.3, §4.6).
//
// Each labelled view constrains two world axes (front/back: X, Y · left/right: Z, Y · top/bottom: X, Z). Without
// camera data the views are aligned through the axes they share, orthographically:
//   - world height 1: a view that shows Y (front, back, left, right) has scale = its mask box height px per unit;
//   - X = front.w / front.h, Z = side.w / side.h (the mean over the views that show it);
//   - top/bottom: sx = top.w / X, sz = top.h / Z, scale √(sx·sz), warn when |sx/sz − 1| > 0.08;
//   - every view is centered on its mask box center (world origin = the object's box center);
//   - opposite views come out mirrored through their axis signs (back: u = −X, right: u = +Z, …);
//   - then the user's per-view adjustment: rotate 90° steps and mirror (applied to the mask first), scale ±10%
//     (1.1 = the view's outline 10% larger in the world), offset;
//   - every mask is cleaned first (fill holes unless keepHoles, close 2 px), whatever produced it.
// Per view, the signed distance of its mask in world units (Step 0 exact EDT, inside positive) is sampled on the
// two grid axes the view constrains; views of the same plane are united (mirrored-pair union: front ∪ mirror(back),
// left ∪ mirror(right)). The consistency check reprojects the separable hull of all planes into each view and
// compares it with that view's own mask: IoU per view, warn < 0.9 — the data behind the IoU badges.
//
// World units here are "object heights" (height 1, centered on the box center); T3.2 shifts to y_min = 0 and scales
// to inches. All functions are deterministic.
import { signedEdt2d } from '../kernel/geom/edt';
import type { PhotoView, Vec3, ViewLabel } from '../../types/geometry';
import type { Issue } from '../../types/issues';
import { fillHoles, maskBox, morphClose, type MaskBox } from './masks';

// ---------------------------------------------------------------------------------------------------------
// View conventions (§2.9.2)
// ---------------------------------------------------------------------------------------------------------

/** A signed world axis: 0 = X, 1 = Y, 2 = Z. */
export interface SignedAxis {
  axis: 0 | 1 | 2;
  sign: 1 | -1;
}

/** The three planes a view can constrain, named by their (first, second) world axes. */
export type ViewPlane = 'XY' | 'ZY' | 'XZ';

export interface ViewConvention {
  /** Image right. */
  u: SignedAxis;
  /** Image up. */
  v: SignedAxis;
  /** Toward the camera (the axis the view cannot see). */
  depth: SignedAxis;
  plane: ViewPlane;
}

/**
 * §2.9.2 table. Camera at: front +Z, back −Z, left (the object's own left) +X, right −X, top +Y (object's front at
 * the photo bottom), bottom −Y.
 */
export const VIEW_CONVENTIONS: Readonly<Record<ViewLabel, Readonly<ViewConvention>>> = Object.freeze({
  front: { u: { axis: 0, sign: 1 }, v: { axis: 1, sign: 1 }, depth: { axis: 2, sign: 1 }, plane: 'XY' },
  back: { u: { axis: 0, sign: -1 }, v: { axis: 1, sign: 1 }, depth: { axis: 2, sign: -1 }, plane: 'XY' },
  left: { u: { axis: 2, sign: -1 }, v: { axis: 1, sign: 1 }, depth: { axis: 0, sign: 1 }, plane: 'ZY' },
  right: { u: { axis: 2, sign: 1 }, v: { axis: 1, sign: 1 }, depth: { axis: 0, sign: -1 }, plane: 'ZY' },
  top: { u: { axis: 0, sign: 1 }, v: { axis: 2, sign: -1 }, depth: { axis: 1, sign: 1 }, plane: 'XZ' },
  bottom: { u: { axis: 0, sign: 1 }, v: { axis: 2, sign: 1 }, depth: { axis: 1, sign: -1 }, plane: 'XZ' },
} satisfies Record<ViewLabel, ViewConvention>);

/** The world axes (first, second) of each plane's tables. */
export const PLANE_AXES: Readonly<Record<ViewPlane, readonly [0 | 1 | 2, 0 | 1 | 2]>> = Object.freeze({ XY: [0, 1], ZY: [2, 1], XZ: [0, 2] });

export const VIEW_LABELS: readonly ViewLabel[] = ['front', 'back', 'left', 'right', 'top', 'bottom'];

// ---------------------------------------------------------------------------------------------------------
// The user's per-view adjustment
// ---------------------------------------------------------------------------------------------------------

export type ViewAlign = PhotoView['align'];

export const DEFAULT_ALIGN: Readonly<ViewAlign> = Object.freeze({ scale: 1, dx: 0, dy: 0, rot90: 0, mirror: false });

/** The range of the scale slider (§2.9.2: ±10%). Core accepts any positive scale; the UI clamps to this. */
export const ALIGN_SCALE_RANGE: readonly [number, number] = [0.9, 1.1];

function checkRot90(rot90: number): void {
  if (![0, 1, 2, 3].includes(rot90)) throw new RangeError(`align.rot90 must be 0, 1, 2 or 3, got ${rot90}`);
}

function checkAlign(a: ViewAlign): void {
  if (!(a.scale > 0) || !Number.isFinite(a.scale)) throw new RangeError(`align.scale must be a finite number > 0, got ${a.scale}`);
  if (!Number.isFinite(a.dx) || !Number.isFinite(a.dy)) throw new RangeError(`align offsets must be finite, got ${a.dx}, ${a.dy}`);
  checkRot90(a.rot90);
  if (typeof a.mirror !== 'boolean') throw new RangeError(`align.mirror must be a boolean, got ${String(a.mirror)}`);
}

/**
 * Rotates a mask by `rot90` quarter turns CLOCKWISE (as a photo app's "rotate right"), then mirrors it left ↔ right
 * when `mirror`. Returns a new mask and its size.
 */
export function orientMask(
  mask: ArrayLike<number>,
  w: number,
  h: number,
  rot90: 0 | 1 | 2 | 3,
  mirror: boolean,
): { mask: Uint8Array<ArrayBuffer>; w: number; h: number } {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) throw new RangeError(`mask size must be integers ≥ 1, got ${w} × ${h}`);
  if (mask.length !== w * h) throw new RangeError(`mask has ${mask.length} entries, expected ${w * h}`);
  checkRot90(rot90);
  const W = rot90 % 2 === 0 ? w : h;
  const H = rot90 % 2 === 0 ? h : w;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let X: number;
      let Y: number;
      switch (rot90) {
        case 0:
          X = x;
          Y = y;
          break;
        case 1: // clockwise: the left column becomes the top row
          X = h - 1 - y;
          Y = x;
          break;
        case 2:
          X = w - 1 - x;
          Y = h - 1 - y;
          break;
        default: // 3: counter-clockwise
          X = y;
          Y = w - 1 - x;
      }
      if (mirror) X = W - 1 - X;
      out[X + W * Y] = mask[x + w * y] !== 0 ? 1 : 0;
    }
  }
  return { mask: out, w: W, h: H };
}

// ---------------------------------------------------------------------------------------------------------
// Alignment
// ---------------------------------------------------------------------------------------------------------

/** One labelled view's mask (on its mask grid), as stored: `PhotoView.maskKey` + `PhotoView.align`. */
export interface ViewMask {
  id: string;
  label: ViewLabel;
  mask: ArrayLike<number>;
  w: number;
  h: number;
  align?: ViewAlign;
}

/** A view placed in the world. Pixel coordinates are continuous: pixel (i, j) covers [i, i+1) × [j, j+1), y down. */
export interface AlignedView {
  id: string;
  label: ViewLabel;
  convention: Readonly<ViewConvention>;
  /** The mask after rotation and mirroring and the §2.9.2 clean-up (fill holes unless keepHoles, close(2)). */
  mask: Uint8Array<ArrayBuffer>;
  w: number;
  h: number;
  box: MaskBox;
  /** Pixels per world unit: the automatic scale ÷ `align.scale` (scale 1.1 makes the view's outline 10% larger). */
  pxPerUnit: number;
  /** The automatic scale alone (§2.9.2). */
  autoPxPerUnit: number;
  /** World offset along the view's (u, v) axes (`align.dx`, `align.dy`, in object heights). */
  offset: readonly [number, number];
  align: ViewAlign;
}

/** Issue codes of the alignment (proposed for §2.13 in docs/tracks/t3.md). */
export const ALIGN_ISSUES = {
  /** The views do not constrain X, Y and Z (or no view shows the height). */
  views: 'E_VIEWS',
  /** A view's mask is empty (the view is left out). */
  emptyView: 'W_VIEW_EMPTY',
  /** The top/bottom view's two scale estimates disagree by more than 8%. */
  scale: 'W_VIEW_SCALE',
  /** Two views have the same label. */
  duplicate: 'W_VIEW_DUPLICATE',
  /** A view disagrees with the hull of the others (consistency IoU < 0.9). */
  iou: 'W_VIEW_IOU',
} as const;

/** §2.9.2: warn when a top/bottom view's |sx/sz − 1| exceeds this. */
export const SCALE_MISMATCH_WARN = 0.08;
/** §2.9.2: warn when a view's consistency IoU is below this. */
export const IOU_WARN = 0.9;

export interface Alignment {
  views: AlignedView[];
  /** The object's size in world units from the automatic scales: [X, 1, Z]; 0 for an axis no view shows. */
  extents: Vec3;
  /** Per top/bottom view id: |sx/sz − 1| (only when both X and Z are known from other views). */
  scaleMismatch: Record<string, number>;
  /** The planes some view constrains. */
  planes: ViewPlane[];
  issues: Issue[];
}

const NAMES: Record<ViewLabel, string> = { front: 'front', back: 'back', left: 'left side', right: 'right side', top: 'top', bottom: 'bottom' };

/** §2.9.2 robustness: the closing radius applied to every view mask (px). */
export const VIEW_CLOSE_R = 2;

/**
 * Aligns labelled view masks (§2.9.2). Every mask is oriented (rot90, mirror) and cleaned (fill holes unless
 * `keepHoles`, then close(2 px)) first. Views with an empty mask are left out (`W_VIEW_EMPTY`). The result has
 * `E_VIEWS` when no view shows the height or the views leave an axis unconstrained (one photo: use the single-image
 * path instead). View ids must be unique; malformed views throw `RangeError`.
 */
export function alignViews(input: readonly ViewMask[], o: { keepHoles?: boolean } = {}): Alignment {
  const issues: Issue[] = [];
  const oriented: { v: ViewMask; align: ViewAlign; mask: Uint8Array<ArrayBuffer>; w: number; h: number; box: MaskBox }[] = [];
  const seen = new Set<ViewLabel>();
  const ids = new Set<string>();
  for (const v of input) {
    if (typeof v.label !== 'string' || !Object.hasOwn(VIEW_CONVENTIONS, v.label)) throw new RangeError(`unknown view label ${JSON.stringify(v.label)}`);
    if (ids.has(v.id)) throw new RangeError(`two views have the id ${JSON.stringify(v.id)}`);
    ids.add(v.id);
    const align = { ...DEFAULT_ALIGN, ...v.align };
    checkAlign(align);
    const turned = orientMask(v.mask, v.w, v.h, align.rot90, align.mirror);
    const filled = o.keepHoles ? turned.mask : fillHoles(turned.mask, turned.w, turned.h);
    const o2 = { mask: morphClose(filled, turned.w, turned.h, VIEW_CLOSE_R), w: turned.w, h: turned.h };
    const box = maskBox(o2.mask, o2.w, o2.h);
    if (!box) {
      issues.push({
        code: ALIGN_ISSUES.emptyView,
        severity: 'warn',
        message: `The ${NAMES[v.label]} photo has no object mask yet, so it is left out.`,
        where: { view: v.id },
      });
      continue;
    }
    if (seen.has(v.label)) {
      issues.push({
        code: ALIGN_ISSUES.duplicate,
        severity: 'warn',
        message: `Two photos are labelled "${NAMES[v.label]}". If one shows another side, change its label; otherwise their outlines are combined.`,
        where: { view: v.id },
      });
    }
    seen.add(v.label);
    oriented.push({ v, align, ...o2, box });
  }

  const showsY = oriented.filter((o) => VIEW_CONVENTIONS[o.v.label].plane !== 'XZ');
  const ratio = (plane: ViewPlane): number | undefined => {
    const list = showsY.filter((o) => VIEW_CONVENTIONS[o.v.label].plane === plane);
    if (list.length === 0) return undefined;
    return list.reduce((s, o) => s + o.box.w / o.box.h, 0) / list.length;
  };
  let X = ratio('XY');
  let Z = ratio('ZY');
  const scaleMismatch: Record<string, number> = {};
  const auto = new Map<ViewMask, number>();
  for (const o of showsY) auto.set(o.v, o.box.h);
  const horizontals = oriented.filter((o) => VIEW_CONVENTIONS[o.v.label].plane === 'XZ');
  if (showsY.length > 0) {
    // Top/bottom views: two estimates when X and Z are both known, else the one available (which then sets the
    // other axis). Estimates from the first horizontal view fill a missing axis for the others.
    const knownX = X;
    const knownZ = Z;
    for (const o of horizontals) {
      let s: number;
      if (knownX !== undefined && knownZ !== undefined) {
        const sx = o.box.w / knownX;
        const sz = o.box.h / knownZ;
        s = Math.sqrt(sx * sz);
        const mismatch = Math.abs(sx / sz - 1);
        scaleMismatch[o.v.id] = mismatch;
        if (mismatch > SCALE_MISMATCH_WARN) {
          issues.push({
            code: ALIGN_ISSUES.scale,
            severity: 'warn',
            message: `The ${NAMES[o.v.label]} photo does not match the others (its width and depth disagree by ${Math.round(mismatch * 100)}%). Check its label and rotation, or re-take it from farther away.`,
            where: { view: o.v.id },
          });
        }
      } else if (knownX !== undefined) {
        s = o.box.w / knownX;
      } else {
        s = o.box.h / (knownZ as number);
      }
      auto.set(o.v, s);
    }
    if (horizontals.length > 0) {
      if (X === undefined) X = mean(horizontals.map((o) => o.box.w / (auto.get(o.v) as number)));
      if (Z === undefined) Z = mean(horizontals.map((o) => o.box.h / (auto.get(o.v) as number)));
    }
  }

  const planes = [...new Set(oriented.map((o) => VIEW_CONVENTIONS[o.v.label].plane))].sort() as ViewPlane[];
  const covered = new Set<number>(planes.flatMap((p) => PLANE_AXES[p]));
  if (showsY.length === 0 || covered.size < 3) {
    issues.push({
      code: ALIGN_ISSUES.views,
      severity: 'error',
      message:
        showsY.length === 0
          ? 'Add a front, back or side photo: top and bottom photos alone do not show the height.'
          : 'Add a photo that shows the depth: a side photo (or a top photo) together with the front.',
    });
  }

  const views: AlignedView[] = [];
  for (const o of oriented) {
    const a = auto.get(o.v);
    if (a === undefined) continue; // only top/bottom views and nothing to scale them by
    views.push({
      id: o.v.id,
      label: o.v.label,
      convention: VIEW_CONVENTIONS[o.v.label],
      mask: o.mask,
      w: o.w,
      h: o.h,
      box: o.box,
      autoPxPerUnit: a,
      pxPerUnit: a / o.align.scale,
      offset: [o.align.dx, o.align.dy],
      align: o.align,
    });
  }
  return { views, extents: [X ?? 0, showsY.length > 0 ? 1 : 0, Z ?? 0], scaleMismatch, planes, issues };
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

/** View pixel (continuous, y down) → world coordinates along the view's (u, v) axes. */
export function pixelToViewUV(view: AlignedView, px: number, py: number): [number, number] {
  return [(px - view.box.cx) / view.pxPerUnit + view.offset[0], (view.box.cy - py) / view.pxPerUnit + view.offset[1]];
}

/** World coordinates along the view's (u, v) axes → view pixel (continuous, y down). */
export function viewUVToPixel(view: AlignedView, a: number, b: number): [number, number] {
  return [view.box.cx + (a - view.offset[0]) * view.pxPerUnit, view.box.cy - (b - view.offset[1]) * view.pxPerUnit];
}

/** A world point → the view's continuous pixel coordinates (orthographic projection along the view's depth). */
export function worldToPixel(view: AlignedView, p: Readonly<Vec3>): [number, number] {
  const { u, v } = view.convention;
  return viewUVToPixel(view, u.sign * p[u.axis], v.sign * p[v.axis]);
}

/** The view's pixel → the world point on its picture plane (depth coordinate 0). */
export function pixelToWorld(view: AlignedView, px: number, py: number): Vec3 {
  const [a, b] = pixelToViewUV(view, px, py);
  const out: Vec3 = [0, 0, 0];
  out[view.convention.u.axis] = view.convention.u.sign * a;
  out[view.convention.v.axis] = view.convention.v.sign * b;
  return out;
}

/** The world box covered by every view's mask box (depth axes from the other views), as [min, max]. */
export function alignedBounds(alignment: Alignment): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const view of alignment.views) {
    for (const [px, py] of [
      [view.box.x0, view.box.y0],
      [view.box.x1, view.box.y1],
    ]) {
      const p = pixelToWorld(view, px, py);
      for (const axis of [view.convention.u.axis, view.convention.v.axis]) {
        min[axis] = Math.min(min[axis], p[axis]);
        max[axis] = Math.max(max[axis], p[axis]);
      }
    }
  }
  for (let k = 0; k < 3; k++) {
    if (!Number.isFinite(min[k])) {
      min[k] = 0;
      max[k] = 0;
    }
  }
  return { min, max };
}

// ---------------------------------------------------------------------------------------------------------
// The sampling grid
// ---------------------------------------------------------------------------------------------------------

/** An N³ lattice of sample points: sample (i, j, k) at origin + voxel·(i, j, k) (Step 0 convention). */
export interface ReconGrid {
  N: number;
  origin: Vec3;
  voxel: number;
}

/** Fraction of each side left empty around the object (research 04 §1: the object fills about 80% of the grid). */
export const GRID_PADDING = 0.1;

/**
 * A cubic N³ grid around a world box: the longest side of the box spans (1 − 2·padding) of the grid, the box is
 * centered. N ≥ 2.
 */
export function makeGrid(bounds: { min: Readonly<Vec3>; max: Readonly<Vec3> }, N: number, padding = GRID_PADDING): ReconGrid {
  if (!Number.isInteger(N) || N < 2) throw new RangeError(`N must be an integer ≥ 2, got ${N}`);
  if (!(padding >= 0 && padding < 0.5)) throw new RangeError(`padding must be in [0, 0.5), got ${padding}`);
  const size = Math.max(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]);
  if (!(size > 0) || !Number.isFinite(size)) throw new RangeError('the bounds are empty');
  const side = size / (1 - 2 * padding);
  const voxel = side / (N - 1);
  const origin: Vec3 = [0, 0, 0];
  for (let k = 0; k < 3; k++) origin[k] = (bounds.min[k] + bounds.max[k]) / 2 - side / 2;
  return { N, origin, voxel };
}

// ---------------------------------------------------------------------------------------------------------
// Signed distance per view, plane tables
// ---------------------------------------------------------------------------------------------------------

/**
 * The view's signed distance in world units on its pixel grid (Step 0 `signedEdt2d`, positive inside, zero level on
 * the pixel faces), at pixel centers. The photo frame counts as outside (the mask is padded with one background
 * pixel), so a mask cut by the frame — or filling it — still gets a finite field whose zero level stays inside the
 * photo. Empty mask → −Infinity everywhere.
 */
export function viewSignedDistance(view: AlignedView): Float32Array<ArrayBuffer> {
  const { w, h } = view;
  const W = w + 2;
  const padded = new Uint8Array(W * (h + 2));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) padded[x + 1 + W * (y + 1)] = view.mask[x + w * y];
  const sd = signedEdt2d(padded, W, h + 2, { spacing: 1 / view.pxPerUnit, measureTo: 'boundary' });
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[x + w * y] = sd[x + 1 + W * (y + 1)];
  return out;
}

/**
 * Bilinear sample of a pixel-center field at continuous pixel coordinates (px, py). Outside the image the field is
 * clamped to the edge and lowered by the distance to the image, `outsideSlope` per pixel (world units per px), so
 * the zero level does not run off to infinity beyond the photo.
 */
export function sampleField(field: ArrayLike<number>, w: number, h: number, px: number, py: number, outsideSlope: number): number {
  const fx = px - 0.5;
  const fy = py - 0.5;
  const cx = Math.min(Math.max(fx, 0), w - 1);
  const cy = Math.min(Math.max(fy, 0), h - 1);
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const f00 = field[x0 + w * y0];
  const f10 = field[x1 + w * y0];
  const f01 = field[x0 + w * y1];
  const f11 = field[x1 + w * y1];
  // Avoid ∞·0 = NaN for full or empty masks.
  const lerp = (a: number, b: number, t: number): number => (t === 0 ? a : t === 1 ? b : a === b ? a : a + (b - a) * t);
  const value = lerp(lerp(f00, f10, tx), lerp(f01, f11, tx), ty);
  const out = Math.hypot(fx - cx, fy - cy);
  return out === 0 ? value : value - out * outsideSlope;
}

/**
 * Per plane, an N × N table of the united signed distance of the plane's views at the grid's sample positions:
 * `table[i + N·j]` at world coordinate i along the plane's first axis and j along its second (PLANE_AXES).
 * Union = max (mirrored-pair union, §2.9.2). Also each view's own table (for the consistency check).
 */
export function planeTables(
  alignment: Alignment,
  grid: ReconGrid,
): { planes: Partial<Record<ViewPlane, Float32Array<ArrayBuffer>>>; perView: Record<string, Float32Array<ArrayBuffer>> } {
  const { N, origin, voxel } = grid;
  const planes: Partial<Record<ViewPlane, Float32Array<ArrayBuffer>>> = {};
  const perView: Record<string, Float32Array<ArrayBuffer>> = {};
  for (const view of alignment.views) {
    const sd = viewSignedDistance(view);
    const { plane, u, v } = view.convention;
    const [p, q] = PLANE_AXES[plane];
    const table = new Float32Array(N * N);
    const slope = 1 / view.pxPerUnit;
    for (let j = 0; j < N; j++) {
      const wq = origin[q] + voxel * j;
      for (let i = 0; i < N; i++) {
        const wp = origin[p] + voxel * i;
        // World (p, q) → the view's (u, v): each of u and v is ± one of p, q.
        const a = u.sign * (u.axis === p ? wp : wq);
        const b = v.sign * (v.axis === p ? wp : wq);
        const [px, py] = viewUVToPixel(view, a, b);
        table[i + N * j] = sampleField(sd, view.w, view.h, px, py, slope);
      }
    }
    perView[view.id] = table;
    const united = planes[plane];
    if (!united) planes[plane] = Float32Array.from(table);
    else for (let k = 0; k < N * N; k++) if (table[k] > united[k]) united[k] = table[k];
  }
  return { planes, perView };
}

// ---------------------------------------------------------------------------------------------------------
// Consistency: the separable hull reprojected into each plane
// ---------------------------------------------------------------------------------------------------------

/**
 * Silhouettes (N × N, 1 = covered) of the separable hull `inside(x, y, z) = ∧ over planes table > 0` projected onto
 * each constrained plane, in that plane's table layout. A missing plane constrains nothing.
 */
export function hullSilhouettes(
  tables: Partial<Record<ViewPlane, ArrayLike<number>>>,
  N: number,
): Partial<Record<ViewPlane, Uint8Array<ArrayBuffer>>> {
  const xy = tables.XY;
  const zy = tables.ZY;
  const xz = tables.XZ;
  const inXY = (x: number, y: number): boolean => !xy || xy[x + N * y] > 0;
  const inZY = (z: number, y: number): boolean => !zy || zy[z + N * y] > 0;
  const inXZ = (x: number, z: number): boolean => !xz || xz[x + N * z] > 0;
  const sXY = new Uint8Array(N * N);
  const sZY = new Uint8Array(N * N);
  const sXZ = new Uint8Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!inXY(x, y)) continue;
      for (let z = 0; z < N; z++) {
        if (inZY(z, y) && inXZ(x, z)) {
          sXY[x + N * y] = 1;
          sZY[z + N * y] = 1;
          sXZ[x + N * z] = 1;
        }
      }
    }
  }
  const out: Partial<Record<ViewPlane, Uint8Array<ArrayBuffer>>> = {};
  if (xy) out.XY = sXY;
  if (zy) out.ZY = sZY;
  if (xz) out.XZ = sXZ;
  return out;
}

/** One view's consistency badge data. */
export interface ViewConsistency {
  id: string;
  label: ViewLabel;
  /** IoU of the reprojected hull with this view's own mask, on the grid. */
  iou: number;
  /** iou < 0.9: highlight the photo. */
  warn: boolean;
}

export interface ConsistencyReport {
  /** null when no view could be aligned. */
  grid: ReconGrid | null;
  views: ViewConsistency[];
  /** Per constrained plane, the hull's silhouette (N × N, the plane's table layout): the live outline. */
  silhouettes: Partial<Record<ViewPlane, Uint8Array<ArrayBuffer>>>;
  issues: Issue[];
}

/** Grid resolution of the consistency check (the IoU badges): the default build resolution. */
export const CONSISTENCY_N = 128;

/**
 * §2.9.2 consistency check: per view, IoU of the hull of ALL views (mirrored pairs united), reprojected into the
 * view's plane, against the view's own mask, both sampled on the N × N plane grid. IoU < 0.9 → `W_VIEW_IOU`.
 */
export function viewConsistency(alignment: Alignment, N = CONSISTENCY_N): ConsistencyReport {
  if (alignment.views.length === 0) return { grid: null, views: [], silhouettes: {}, issues: [] };
  const grid = makeGrid(alignedBounds(alignment), N);
  return consistencyFromTables(alignment, grid, planeTables(alignment, grid));
}

/** `viewConsistency` from plane tables already computed on `grid` (the build reuses its own). */
export function consistencyFromTables(
  alignment: Alignment,
  grid: ReconGrid,
  tables: ReturnType<typeof planeTables>,
): ConsistencyReport {
  const { N } = grid;
  const { planes, perView } = tables;
  const silhouettes = hullSilhouettes(planes, N);
  const issues: Issue[] = [];
  const views: ViewConsistency[] = alignment.views.map((view) => {
    const own = perView[view.id];
    const sil = silhouettes[view.convention.plane] as Uint8Array;
    const iou = tableIoU(own, sil, N);
    const warn = iou < IOU_WARN;
    if (warn) {
      issues.push({
        code: ALIGN_ISSUES.iou,
        severity: 'warn',
        message: `The ${NAMES[view.label]} photo does not line up with the others (match ${Math.round(iou * 100)}%). Check its label, its mask and its alignment.`,
        where: { view: view.id },
      });
    }
    return { id: view.id, label: view.label, iou, warn };
  });
  return { grid, views, silhouettes, issues };
}

/** IoU of `table > 0` and `silhouette ≠ 0` on an N × N plane grid (1 when both are empty). */
export function tableIoU(table: ArrayLike<number>, silhouette: ArrayLike<number>, N: number): number {
  let inter = 0;
  let union = 0;
  for (let k = 0; k < N * N; k++) {
    const a = table[k] > 0;
    const b = silhouette[k] !== 0;
    if (a && b) inter++;
    if (a || b) union++;
  }
  return union === 0 ? 1 : inter / union;
}
