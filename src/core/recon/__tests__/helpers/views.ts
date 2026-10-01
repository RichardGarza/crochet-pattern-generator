// Test helpers for core/recon: orthographic silhouettes of analytic solids under the §2.9.2 view conventions, and
// synthetic "photos" (generated in code, never downloaded — DESIGN.md §6.1 rule 5).
import type { Vec3, ViewLabel } from '../../../../types/geometry';

/**
 * §2.9.2, written out independently of `align.ts` (so a sign error there is caught): per label, image u and image
 * v as [world axis, sign].
 */
const TABLE: Record<ViewLabel, { u: { axis: 0 | 1 | 2; sign: 1 | -1 }; v: { axis: 0 | 1 | 2; sign: 1 | -1 } }> = {
  front: { u: { axis: 0, sign: 1 }, v: { axis: 1, sign: 1 } }, // camera +Z: u +X, v +Y
  back: { u: { axis: 0, sign: -1 }, v: { axis: 1, sign: 1 } }, // camera −Z: u −X, v +Y
  left: { u: { axis: 2, sign: -1 }, v: { axis: 1, sign: 1 } }, // camera +X: u −Z, v +Y
  right: { u: { axis: 2, sign: 1 }, v: { axis: 1, sign: 1 } }, // camera −X: u +Z, v +Y
  top: { u: { axis: 0, sign: 1 }, v: { axis: 2, sign: -1 } }, // camera +Y: u +X, v −Z
  bottom: { u: { axis: 0, sign: 1 }, v: { axis: 2, sign: 1 } }, // camera −Y: u +X, v +Z
};

/** An axis-aligned ellipsoid: center and semi-axes (world units). */
export interface Ellipsoid {
  c: Vec3;
  r: Vec3;
}

/** A sphere of radius r at the origin. */
export const sphere = (r: number, c: Vec3 = [0, 0, 0]): Ellipsoid => ({ c, r: [r, r, r] });

/**
 * A small teddy (world units, height ≈ 1, centered on its bounding box): body, head, two ears, a muzzle in front
 * (+Z), arms on ±X, legs. Not symmetric front-to-back (the muzzle), so mirrored views matter.
 */
export const TEDDY: readonly Ellipsoid[] = [
  { c: [0, -0.15, 0], r: [0.24, 0.27, 0.2] }, // body
  { c: [0, 0.22, 0], r: [0.19, 0.18, 0.17] }, // head
  { c: [0.15, 0.4, 0], r: [0.07, 0.07, 0.04] }, // ear (object's left, +X)
  { c: [-0.15, 0.4, 0], r: [0.07, 0.07, 0.04] }, // ear
  { c: [0, 0.18, 0.15], r: [0.08, 0.06, 0.07] }, // muzzle (+Z = front)
  { c: [0.27, -0.08, 0.02], r: [0.06, 0.15, 0.06] }, // arm (+X)
  { c: [-0.27, -0.08, 0.02], r: [0.06, 0.15, 0.06] }, // arm
  { c: [0.12, -0.38, 0.06], r: [0.08, 0.09, 0.1] }, // leg (+X)
  { c: [-0.12, -0.38, 0.06], r: [0.08, 0.09, 0.1] }, // leg
];

/** Axis-aligned bounding box of a union of ellipsoids. */
export function solidBounds(solids: readonly Ellipsoid[]): { min: Vec3; max: Vec3 } {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const e of solids) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], e.c[k] - e.r[k]);
      max[k] = Math.max(max[k], e.c[k] + e.r[k]);
    }
  }
  return { min, max };
}

/** The solids moved so that their bounding box is centered on the origin. */
export function centered(solids: readonly Ellipsoid[]): Ellipsoid[] {
  const { min, max } = solidBounds(solids);
  const m: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  return solids.map((e) => ({ c: [e.c[0] - m[0], e.c[1] - m[1], e.c[2] - m[2]], r: [...e.r] as Vec3 }));
}

export interface Camera {
  /** Image size, px. */
  w: number;
  h: number;
  /** Pixels per world unit. */
  pxPerUnit: number;
  /** Where the world origin lands in the image (continuous px, y down); default the image center. */
  center?: [number, number];
  /** Extra scale along image u only (a deliberately wrong view), default 1. */
  stretchU?: number;
}

/** True when world point p (only the two axes the view sees matter) is inside the union's silhouette. */
function inSilhouette(solids: readonly Ellipsoid[], label: ViewLabel, p: Vec3): boolean {
  const { u, v } = TABLE[label];
  for (const e of solids) {
    const du = (p[u.axis] - e.c[u.axis]) / e.r[u.axis];
    const dv = (p[v.axis] - e.c[v.axis]) / e.r[v.axis];
    if (du * du + dv * dv <= 1) return true;
  }
  return false;
}

/**
 * The orthographic silhouette of the solids seen from `label` (§2.9.2), sampled at pixel centers: 1 = object.
 * Image u → the view's u axis, image up → its v axis.
 */
export function renderSilhouette(solids: readonly Ellipsoid[], label: ViewLabel, cam: Camera): Uint8Array<ArrayBuffer> {
  const { u, v } = TABLE[label];
  const [cx, cy] = cam.center ?? [cam.w / 2, cam.h / 2];
  const su = cam.pxPerUnit * (cam.stretchU ?? 1);
  const out = new Uint8Array(cam.w * cam.h);
  for (let py = 0; py < cam.h; py++) {
    for (let px = 0; px < cam.w; px++) {
      const a = (px + 0.5 - cx) / su;
      const b = (cy - (py + 0.5)) / cam.pxPerUnit;
      const p: Vec3 = [0, 0, 0];
      p[u.axis] = u.sign * a;
      p[v.axis] = v.sign * b;
      if (inSilhouette(solids, label, p)) out[px + cam.w * py] = 1;
    }
  }
  return out;
}

/** Area (pixel count) of a 0/1 mask. */
export function area(mask: ArrayLike<number>): number {
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] !== 0) n++;
  return n;
}

/** True when two byte arrays are equal. */
export function sameBytes(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
