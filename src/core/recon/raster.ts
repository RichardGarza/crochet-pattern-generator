// Track T3 — orthographic triangle rasterization with a depth buffer (DESIGN.md §2.9.6): the silhouettes and the
// first-hit depth maps of Apply photo colors, and the synthetic view fixtures of the tests.
//
// Pixels are sampled at their centers (i + ½, j + ½), y down. Depth grows TOWARD the camera, so the nearest surface
// keeps the largest value; empty pixels hold −∞. Triangles of either winding are drawn (a silhouette must not depend
// on it); a pixel center on a shared edge is drawn by both triangles, the nearer depth wins (ties: the first drawn).
import type { Vec3, ViewLabel } from '../../types/geometry';
import { VIEW_CONVENTIONS } from './align';

/** An orthographic view of world points: pixel = (cx + s·(a − a0), cy − s·(b − b0)), (a, b) = the view's (u, v). */
export interface OrthoCamera {
  label: ViewLabel;
  w: number;
  h: number;
  /** Pixels per world unit. */
  s: number;
  /** Where the world point (a0, b0) of the view's (u, v) lands (continuous px). */
  cx: number;
  cy: number;
  a0?: number;
  b0?: number;
}

export interface DepthRaster {
  w: number;
  h: number;
  /** Per pixel: the nearest depth (toward the camera), −∞ = empty. */
  depth: Float32Array<ArrayBuffer>;
  /** Per pixel: the index of the triangle seen there, −1 = empty. */
  tri: Int32Array<ArrayBuffer>;
  /** Per pixel: the barycentric weights (b1, b2) of the seen triangle's 2nd and 3rd vertex. */
  bary: Float32Array<ArrayBuffer>;
}

/** The view's (u, v) coordinates and depth toward the camera of a world point. */
export function viewCoords(label: ViewLabel, p: Readonly<Vec3>): [number, number, number] {
  const c = VIEW_CONVENTIONS[label];
  return [c.u.sign * p[c.u.axis], c.v.sign * p[c.v.axis], c.depth.sign * p[c.depth.axis]];
}

/** World points [x, y, z, …] → pixel coordinates [px, py, …] and depths. */
export function projectPoints(cam: OrthoCamera, positions: ArrayLike<number>): { xy: Float64Array<ArrayBuffer>; z: Float64Array<ArrayBuffer> } {
  const n = Math.floor(positions.length / 3);
  const xy = new Float64Array(2 * n);
  const z = new Float64Array(n);
  const c = VIEW_CONVENTIONS[cam.label];
  const a0 = cam.a0 ?? 0;
  const b0 = cam.b0 ?? 0;
  for (let i = 0; i < n; i++) {
    const a = c.u.sign * positions[3 * i + c.u.axis];
    const b = c.v.sign * positions[3 * i + c.v.axis];
    xy[2 * i] = cam.cx + cam.s * (a - a0);
    xy[2 * i + 1] = cam.cy - cam.s * (b - b0);
    z[i] = c.depth.sign * positions[3 * i + c.depth.axis];
  }
  return { xy, z };
}

export function emptyRaster(w: number, h: number): DepthRaster {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) throw new RangeError(`raster size must be positive integers, got ${w} × ${h}`);
  return { w, h, depth: new Float32Array(w * h).fill(-Infinity), tri: new Int32Array(w * h).fill(-1), bary: new Float32Array(2 * w * h) };
}

/**
 * Draws triangles (vertex pixel coordinates `xy`, depths `z`) into `r`; triangle t is recorded as `triOffset + t`.
 * Degenerate (zero-area) triangles draw nothing.
 */
export function rasterize(r: DepthRaster, xy: ArrayLike<number>, z: ArrayLike<number>, indices: ArrayLike<number>, triOffset = 0): DepthRaster {
  const { w, h, depth, tri, bary } = r;
  const nt = Math.floor(indices.length / 3);
  for (let t = 0; t < nt; t++) {
    const i0 = indices[3 * t];
    const i1 = indices[3 * t + 1];
    const i2 = indices[3 * t + 2];
    const x0 = xy[2 * i0], y0 = xy[2 * i0 + 1];
    const x1 = xy[2 * i1], y1 = xy[2 * i1 + 1];
    const x2 = xy[2 * i2], y2 = xy[2 * i2 + 1];
    const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
    if (!(Math.abs(area) > 1e-12)) continue;
    const inv = 1 / area;
    const minX = Math.max(0, Math.ceil(Math.min(x0, x1, x2) - 0.5));
    const maxX = Math.min(w - 1, Math.floor(Math.max(x0, x1, x2) - 0.5));
    const minY = Math.max(0, Math.ceil(Math.min(y0, y1, y2) - 0.5));
    const maxY = Math.min(h - 1, Math.floor(Math.max(y0, y1, y2) - 0.5));
    if (minX > maxX || minY > maxY) continue;
    const z0 = z[i0], z1 = z[i1], z2 = z[i2];
    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        // barycentric weights of vertices 1 and 2
        const b1 = ((cx - x0) * (y2 - y0) - (x2 - x0) * (cy - y0)) * inv;
        const b2 = ((x1 - x0) * (cy - y0) - (cx - x0) * (y1 - y0)) * inv;
        const b0 = 1 - b1 - b2;
        if (b0 < -1e-9 || b1 < -1e-9 || b2 < -1e-9) continue;
        const d = b0 * z0 + b1 * z1 + b2 * z2;
        const k = px + w * py;
        if (d > depth[k]) {
          depth[k] = d;
          tri[k] = triOffset + t;
          bary[2 * k] = b1;
          bary[2 * k + 1] = b2;
        }
      }
    }
  }
  return r;
}

/** The mask (1 = covered) of a raster. */
export function rasterMask(r: DepthRaster): Uint8Array<ArrayBuffer> {
  const m = new Uint8Array(r.w * r.h);
  for (let i = 0; i < m.length; i++) if (r.tri[i] >= 0) m[i] = 1;
  return m;
}

/** Bilinear depth at a continuous pixel position, using only covered pixels (−∞ when none of the four is covered). */
export function sampleDepth(r: DepthRaster, px: number, py: number): number {
  const x = px - 0.5;
  const y = py - 0.5;
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  let acc = 0;
  let W = 0;
  let best = -Infinity;
  for (let dy = 0; dy <= 1; dy++) {
    for (let dx = 0; dx <= 1; dx++) {
      const X = ix + dx;
      const Y = iy + dy;
      if (X < 0 || Y < 0 || X >= r.w || Y >= r.h) continue;
      const d = r.depth[X + r.w * Y];
      if (d === -Infinity) continue;
      const wgt = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      acc += wgt * d;
      W += wgt;
      if (d > best) best = d;
    }
  }
  return W > 1e-9 ? acc / W : best;
}
