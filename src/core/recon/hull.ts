// Track T3 — volume construction from aligned views (DESIGN.md §2.9.3, research 04 §4.4–4.5, §5.1).
//
// - Separable visual hull (D12): each axis-aligned view ignores its depth coordinate, so its signed distance is
//   sampled once per (u, v) into an N × N plane table (align.ts `planeTables`, `measureTo: 'boundary'`) and the
//   hull is the broadcast minimum over N³:  f_hull(p) = min_k sd_k(project_k(p)).
// - Front-view rounding (multi-view only, D13): f = min(f_hull, κ·T_front(x, y) − |z − z_c(x, y)|), κ = 1, with
//   z_c = the midpoint of the hull's occupied z-interval along the ray (x, y) and T the inflation height of the front
//   view (front ∪ mirror(back), united by max) from local thickness (inflate.ts). Never from side or top views.
// - One plane only (a single photo in its own frame, or front + back / left + right): f = min(sd(p, q),
//   κ·T(p, q) − |depth|), the photo plane at depth 0.
//
// Fields are Float32Array N³, `field[x + N·(y + N·z)]`, positive inside, world units; sample (x, y, z) at
// `grid.origin + grid.voxel·(x, y, z)` (Step 0 convention).
import type { Vec3 } from '../../types/geometry';
import { PLANE_AXES, sampleField, viewUVToPixel, type AlignedView, type ReconGrid, type ViewPlane } from './align';
import { inflationHeight } from './inflate';

/** §2.9.3: κ of the multi-view front rounding. */
export const MULTI_VIEW_KAPPA = 1.0;

function checkTable(t: ArrayLike<number> | undefined, N: number, name: string): void {
  if (t !== undefined && t.length !== N * N) throw new RangeError(`${name} table has ${t.length} entries, expected ${N * N}`);
}

/**
 * The separable hull: `f(x, y, z) = min(XY[x + N·y], ZY[z + N·y], XZ[x + N·z])` over the planes present (a missing
 * plane constrains nothing; with no plane at all the field is +Infinity).
 */
export function separableHull(planes: Partial<Record<ViewPlane, ArrayLike<number>>>, N: number): Float32Array<ArrayBuffer> {
  if (!Number.isInteger(N) || N < 2) throw new RangeError(`N must be an integer ≥ 2, got ${N}`);
  const { XY: xy, ZY: zy, XZ: xz } = planes;
  checkTable(xy, N, 'XY');
  checkTable(zy, N, 'ZY');
  checkTable(xz, N, 'XZ');
  const f = new Float32Array(N * N * N);
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      const zyv = zy ? zy[z + N * y] : Infinity;
      const row = N * (y + N * z);
      for (let x = 0; x < N; x++) {
        let v = zyv;
        if (xy) {
          const a = xy[x + N * y];
          if (a < v) v = a;
        }
        if (xz) {
          const b = xz[x + N * z];
          if (b < v) v = b;
        }
        f[row + x] = v;
      }
    }
  }
  return f;
}

/** The inflation height T of an aligned view on its pixel grid (world units). */
export function viewInflation(view: AlignedView): Float32Array<ArrayBuffer> {
  return inflationHeight(view.mask, view.w, view.h, { spacing: 1 / view.pxPerUnit });
}

/**
 * The inflation height T of the views of one plane sampled on that plane's N × N table grid (same layout as
 * `planeTables`), united by max (front ∪ mirror(back)). `null` when no view lies in the plane. World units.
 * `pixelT` may hold each view's `viewInflation`, by view id (computed when missing).
 */
export function inflationTable(
  views: readonly AlignedView[],
  grid: ReconGrid,
  plane: ViewPlane,
  pixelT: Readonly<Record<string, Float32Array>> = {},
): Float32Array<ArrayBuffer> | null {
  const { N, origin, voxel } = grid;
  const [p, q] = PLANE_AXES[plane];
  let out: Float32Array<ArrayBuffer> | null = null;
  for (const view of views) {
    if (view.convention.plane !== plane) continue;
    const T = Object.hasOwn(pixelT, view.id) ? pixelT[view.id] : viewInflation(view);
    const { u, v } = view.convention;
    const table = new Float32Array(N * N);
    for (let j = 0; j < N; j++) {
      const wq = origin[q] + voxel * j;
      for (let i = 0; i < N; i++) {
        const wp = origin[p] + voxel * i;
        const a = u.sign * (u.axis === p ? wp : wq);
        const b = v.sign * (v.axis === p ? wp : wq);
        const [px, py] = viewUVToPixel(view, a, b);
        table[i + N * j] = Math.max(0, sampleField(T, view.w, view.h, px, py, 0));
      }
    }
    if (!out) out = table;
    else for (let k = 0; k < N * N; k++) if (table[k] > out[k]) out[k] = table[k];
  }
  return out;
}

/** The largest value of an inflation height (0 for an empty one). */
export function maxOf(values: ArrayLike<number>): number {
  let m = 0;
  for (let i = 0; i < values.length; i++) if (values[i] > m) m = values[i];
  return m;
}

/**
 * Silhouette of the inside samples (`f ≥ 0`) of an N³ field projected onto a plane (the plane's table layout), and
 * its IoU with `table > 0`.
 */
export function projectionIoU(field: ArrayLike<number>, N: number, plane: ViewPlane, table: ArrayLike<number>): number {
  const [p, q] = PLANE_AXES[plane];
  const sil = new Uint8Array(N * N);
  const idx = [0, 0, 0];
  for (let z = 0; z < N; z++) {
    idx[2] = z;
    for (let y = 0; y < N; y++) {
      idx[1] = y;
      const row = N * (y + N * z);
      for (let x = 0; x < N; x++) {
        if (!(field[row + x] >= 0)) continue;
        idx[0] = x;
        sil[idx[p] + N * idx[q]] = 1;
      }
    }
  }
  let inter = 0;
  let union = 0;
  for (let k = 0; k < N * N; k++) {
    const a = table[k] > 0;
    const b = sil[k] !== 0;
    if (a && b) inter++;
    if (a || b) union++;
  }
  return union === 0 ? 1 : inter / union;
}

/**
 * Front-view rounding (§2.9.3), in place: per ray (x, y) the hull's occupied z-interval [z₀, z₁] (sub-voxel: the
 * zero crossings next to the first and last inside samples), z_c = (z₀ + z₁)/2, then
 * `f = min(f, κ·T(x, y) − |z − z_c|)` along the ray. Rays without an inside sample are left alone. Returns z_c per
 * ray (NaN where empty), `zc[x + N·y]`.
 */
export function frontRounding(field: Float32Array, grid: ReconGrid, T: ArrayLike<number>, kappa = MULTI_VIEW_KAPPA): Float32Array<ArrayBuffer> {
  const { N, origin, voxel } = grid;
  if (field.length !== N * N * N) throw new RangeError(`field has ${field.length} samples, expected ${N * N * N}`);
  checkTable(T, N, 'T');
  if (!(kappa > 0) || !Number.isFinite(kappa)) throw new RangeError(`kappa must be a finite number > 0, got ${kappa}`);
  const NN = N * N;
  const first = new Int32Array(NN).fill(-1);
  const last = new Int32Array(NN).fill(-1);
  for (let z = 0; z < N; z++) {
    const base = NN * z;
    for (let i = 0; i < NN; i++) {
      if (field[base + i] >= 0) {
        if (first[i] < 0) first[i] = z;
        last[i] = z;
      }
    }
  }
  const zc = new Float32Array(NN).fill(Number.NaN);
  const crossing = (i: number, k: number, k2: number): number => {
    // The zero between samples k (inside) and k2 (outside, or off the lattice), as a z index.
    if (k2 < 0 || k2 >= N) return k;
    const a = field[i + NN * k];
    const b = field[i + NN * k2];
    const t = Number.isFinite(a) && Number.isFinite(b) && a - b > 0 ? a / (a - b) : 0.5;
    return k + (k2 - k) * t;
  };
  for (let i = 0; i < NN; i++) {
    if (first[i] < 0) continue;
    const z0 = crossing(i, first[i], first[i] - 1);
    const z1 = crossing(i, last[i], last[i] + 1);
    zc[i] = origin[2] + voxel * 0.5 * (z0 + z1);
  }
  for (let z = 0; z < N; z++) {
    const wz = origin[2] + voxel * z;
    const base = NN * z;
    for (let i = 0; i < NN; i++) {
      const c = zc[i];
      if (c !== c) continue; // NaN: an empty ray
      const bound = kappa * T[i] - Math.abs(wz - c);
      if (bound < field[base + i]) field[base + i] = bound;
    }
  }
  return zc;
}

/**
 * One plane only (§2.9.3 single image; also front + back or left + right): f = min(sd(p, q), κ·T(p, q) − |depth|),
 * where (p, q) are the plane's axes (PLANE_AXES), `depth` the remaining world axis and the photo plane is
 * depth = 0. `sd` and `T` are N × N tables in the plane's layout.
 */
export function inflatedVolume(sd: ArrayLike<number>, T: ArrayLike<number>, grid: ReconGrid, plane: ViewPlane, kappa: number): Float32Array<ArrayBuffer> {
  const { N, origin, voxel } = grid;
  checkTable(sd, N, 'sd');
  checkTable(T, N, 'T');
  if (!(kappa > 0) || !Number.isFinite(kappa)) throw new RangeError(`kappa must be a finite number > 0, got ${kappa}`);
  const [p, q] = PLANE_AXES[plane];
  const d = 3 - p - q;
  const f = new Float32Array(N * N * N);
  const idx: Vec3 = [0, 0, 0];
  for (let z = 0; z < N; z++) {
    idx[2] = z;
    for (let y = 0; y < N; y++) {
      idx[1] = y;
      const row = N * (y + N * z);
      for (let x = 0; x < N; x++) {
        idx[0] = x;
        const k = idx[p] + N * idx[q];
        const depth = Math.abs(origin[d] + voxel * idx[d]);
        const s = sd[k];
        const b = kappa * T[k] - depth;
        f[row + x] = s < b ? s : b;
      }
    }
  }
  return f;
}
