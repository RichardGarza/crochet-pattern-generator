// Track T3 — fits a primitive (type, dims, position, rotation) to a mesh part and reports the residual
// (DESIGN.md §2.9.7 step 4; §5.2.1). Also used by T5 (`MeshApi.fit`) and T7 (the importer's geometry-only path).
//
// The method (§2.9.7 step 4):
//   1. Area-weighted surface samples: every triangle is cut into k² sub-triangles (k from its longest edge, so a
//      sparse builder tessellation is covered as densely as a fine reconstruction) and each sub-triangle's centroid
//      carries its area.
//   2. PCA frame of the samples (area-weighted covariance, `eigenSymmetric3`), and 24 rings along an axis (mean
//      radius, radial variance, outer radius = the area-weighted 90th percentile).
//   3. Candidates: `sphere` (algebraic least squares), `ellipsoid` (axis-aligned algebraic least squares in the PCA
//      frame, centre included), `capsule`, `cylinder` and `cone` (outer ring radii along the longest or the
//      shortest PCA axis), `lathe` (mean ring radii as the profile) and `flat` (only when the smallest extent is
//      < 25% of the largest; outline `circle` / `oval` when an ellipse fits the outline within 12%, else a
//      `polygon` of ≤ 32 points, with the builder's bevel undone).
//   4. Score = RMS of the candidate's signed distance at the samples / mean radius (the area-weighted mean
//      distance of the surface from its centroid). The simplest candidate within `PREFER_SIMPLER` (0.02) of the best
//      wins (order `FIT_ORDER`); accepted when its score ≤ `tolerance` (default 0.12), otherwise the result is a
//      `mesh` part (Path B, §2.10.7) carrying the best score.
//
// Distances: the exact analytic SDFs of `core/model/sdf.ts` (sphere, capsule, cylinder, cone, lathe; the ellipsoid
// bound), and for `flat` a model of the builder's geometry including its bevel (the Step 0 SDF ignores the bevel,
// which a beveled builder disc would count as a 3% error).
//
// Frames: `position` is in the mesh's own frame (the importer passes world inches; the mesh tools part-local
// inches). Rotations are the ones closest to the identity among the equivalent frames, so axis-aligned parts come
// out with `rotationDeg` [0, 0, 0] and dims in the familiar order.
import type { FitPartFn, FitResult } from '../../types/entryPoints';
import type { ColoredMesh } from '../../types/geometry';
import type { Part, Vec3 } from '../../types/model';
import { cross, dot, eigenSymmetric3, mat3FromColumns, normalize, rotationAxisAngle, type Mat3 } from '../kernel/vec';
import { isWatertight, signedVolume } from '../kernel/geom/meshMeasures';
import { localSdf, partVolume, type LocalSdf } from '../model/sdf';
import { mat3ToEulerXYZ, roundCoord } from '../model/transforms';

export type { FitResult } from '../../types/entryPoints';

/** §2.9.7 step 4: a fit is accepted at or below this score. */
export const FIT_ACCEPT = 0.12;
/** §2.9.7 step 4: the simpler type wins when its score is within this of the best. */
export const PREFER_SIMPLER = 0.02;
/** §2.9.7 step 4: `flat` is a candidate when the smallest extent is below this fraction of the largest. */
export const FLAT_RATIO = 0.25;
/** §2.9.7 step 4: a flat outline is an oval when an ellipse matches it within this fraction. */
export const OVAL_FIT = 0.12;
/** §2.9.7 step 4: at most this many points in a polygon outline. */
export const MAX_POLYGON_POINTS = 32;
/** Rings along the axis (§2.9.7 steps 2 and 4). */
export const FIT_RINGS = 24;
/** Candidates from simplest to most complex (ties in score within `PREFER_SIMPLER` go to the earlier one). */
export const FIT_ORDER = ['sphere', 'flat', 'cone', 'ellipsoid', 'capsule', 'cylinder', 'lathe'] as const;
export type FitType = (typeof FIT_ORDER)[number];
/**
 * A candidate whose volume differs from a closed mesh's by more than this fraction is not a fit, whatever its
 * surface score (the score only measures the mesh's surface against the candidate, so a solid disc "fits" a ring).
 */
export const FIT_VOLUME_TOL = 0.25;
/** Samples beyond this count are thinned (deterministic stride) for the scores. */
const MAX_SCORE_SAMPLES = 40_000;
/** Sub-triangles per triangle edge at most (k² sub-triangles). */
const MAX_SPLIT = 12;
/** A circle when w and h agree within this fraction. */
const CIRCLE_TOL = 0.03;

// ---------------------------------------------------------------------------------------------------- samples

/** Area-weighted surface samples: `p` = [x, y, z, …], `w` = area per sample. */
export interface SurfaceSamples {
  p: Float64Array<ArrayBuffer>;
  w: Float64Array<ArrayBuffer>;
  count: number;
  area: number;
  /**
   * The vertices the triangles use, [x, y, z, …]: extents are measured on them (they lie on the surface; the
   * sub-triangle centroids stop short of a cone's apex or a sharp rim).
   */
  v: Float64Array<ArrayBuffer>;
}

/**
 * Area-weighted samples of a triangle mesh: each triangle is cut into k² congruent sub-triangles, k = ⌈longest
 * edge / spacing⌉ (1 … 12), spacing = the largest bounding-box extent / `density` (default 48); each sub-triangle's
 * centroid carries its area. Degenerate triangles are skipped. Index out of range → RangeError.
 */
export function surfaceSamples(positions: ArrayLike<number>, indices: ArrayLike<number>, o: { density?: number } = {}): SurfaceSamples {
  const nv = Math.floor(positions.length / 3);
  let lo = [Infinity, Infinity, Infinity];
  let hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < nv * 3; i += 3) {
    lo = [Math.min(lo[0], positions[i]), Math.min(lo[1], positions[i + 1]), Math.min(lo[2], positions[i + 2])];
    hi = [Math.max(hi[0], positions[i]), Math.max(hi[1], positions[i + 1]), Math.max(hi[2], positions[i + 2])];
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const spacing = extent / (o.density ?? 48);
  const nt = Math.floor(indices.length / 3);
  // First pass: the split of every triangle (so the arrays are allocated once).
  const split = new Uint8Array(nt);
  let total = 0;
  for (let t = 0; t < nt; t++) {
    const a = indices[3 * t];
    const b = indices[3 * t + 1];
    const c = indices[3 * t + 2];
    if (!(a < nv && b < nv && c < nv && a >= 0 && b >= 0 && c >= 0)) throw new RangeError(`surfaceSamples: triangle ${t} has an index out of range`);
    const e = Math.max(dist(positions, a, b), dist(positions, b, c), dist(positions, c, a));
    const k = spacing > 0 && Number.isFinite(e) ? Math.min(MAX_SPLIT, Math.max(1, Math.ceil(e / spacing))) : 1;
    split[t] = k;
    total += k * k;
  }
  const p = new Float64Array(total * 3);
  const w = new Float64Array(total);
  let n = 0;
  let area = 0;
  for (let t = 0; t < nt; t++) {
    const ia = 3 * indices[3 * t];
    const ib = 3 * indices[3 * t + 1];
    const ic = 3 * indices[3 * t + 2];
    const ax = positions[ia], ay = positions[ia + 1], az = positions[ia + 2];
    const ux = positions[ib] - ax, uy = positions[ib + 1] - ay, uz = positions[ib + 2] - az;
    const vx = positions[ic] - ax, vy = positions[ic + 1] - ay, vz = positions[ic + 2] - az;
    const cx = uy * vz - uz * vy;
    const cy = uz * vx - ux * vz;
    const cz = ux * vy - uy * vx;
    const A = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz);
    if (!(A > 0) || !Number.isFinite(A)) continue;
    area += A;
    const k = split[t];
    const wa = A / (k * k);
    // Sub-triangle centroids in barycentric steps of 1/k: upright (i, j), (i+1, j), (i, j+1) and inverted ones.
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k - i; j++) {
        const s = (i + 1 / 3) / k;
        const r = (j + 1 / 3) / k;
        p[3 * n] = ax + s * ux + r * vx;
        p[3 * n + 1] = ay + s * uy + r * vy;
        p[3 * n + 2] = az + s * uz + r * vz;
        w[n++] = wa;
        if (j < k - i - 1) {
          const s2 = (i + 2 / 3) / k;
          const r2 = (j + 2 / 3) / k;
          p[3 * n] = ax + s2 * ux + r2 * vx;
          p[3 * n + 1] = ay + s2 * uy + r2 * vy;
          p[3 * n + 2] = az + s2 * uz + r2 * vz;
          w[n++] = wa;
        }
      }
    }
  }
  const used = new Uint8Array(nv);
  for (let i = 0; i < nt * 3; i++) used[indices[i]] = 1;
  const v: number[] = [];
  for (let i = 0; i < nv; i++) if (used[i]) v.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
  return { p: p.subarray(0, 3 * n).slice(), w: w.subarray(0, n).slice(), count: n, area, v: Float64Array.from(v) };
}

/** The range of `(x − origin)·axis` over the sample set's vertices (else its samples). */
export function axialRange(s: SurfaceSamples, origin: Vec3, axis: Vec3): [number, number] {
  const src = s.v.length >= 3 ? s.v : s.p;
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i + 2 < src.length; i += 3) {
    const t = (src[i] - origin[0]) * axis[0] + (src[i + 1] - origin[1]) * axis[1] + (src[i + 2] - origin[2]) * axis[2];
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  return [lo, hi];
}

function dist(p: ArrayLike<number>, a: number, b: number): number {
  const dx = p[3 * a] - p[3 * b];
  const dy = p[3 * a + 1] - p[3 * b + 1];
  const dz = p[3 * a + 2] - p[3 * b + 2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ---------------------------------------------------------------------------------------------------- frames

/** The area-weighted centroid and principal axes of the samples (`axes[0]` = largest variance). */
export interface PcaFrame {
  centroid: Vec3;
  axes: [Vec3, Vec3, Vec3];
  variances: Vec3;
}

export function pcaFrame(s: SurfaceSamples): PcaFrame {
  let W = 0;
  let mx = 0, my = 0, mz = 0;
  for (let i = 0; i < s.count; i++) {
    const w = s.w[i];
    W += w;
    mx += w * s.p[3 * i];
    my += w * s.p[3 * i + 1];
    mz += w * s.p[3 * i + 2];
  }
  if (!(W > 0)) throw new RangeError('pcaFrame: the samples have no area');
  mx /= W;
  my /= W;
  mz /= W;
  let xx = 0, xy = 0, xz = 0, yy = 0, yz = 0, zz = 0;
  for (let i = 0; i < s.count; i++) {
    const w = s.w[i];
    const x = s.p[3 * i] - mx;
    const y = s.p[3 * i + 1] - my;
    const z = s.p[3 * i + 2] - mz;
    xx += w * x * x;
    xy += w * x * y;
    xz += w * x * z;
    yy += w * y * y;
    yz += w * y * z;
    zz += w * z * z;
  }
  const e = eigenSymmetric3([xx / W, xy / W, xz / W, xy / W, yy / W, yz / W, xz / W, yz / W, zz / W]);
  return { centroid: [mx, my, mz], axes: e.vectors, variances: e.values };
}

/** Rings along an axis: per ring the area, the mean and the outer (90th percentile) distance from the axis. */
export interface RingProfile {
  /** Axial coordinate (from `origin` along `axis`) of the start of ring 0 and the ring length. */
  t0: number;
  dt: number;
  n: number;
  /** Area-weighted mean distance from the axis (0 for an empty ring). */
  mean: Float64Array<ArrayBuffer>;
  /** Area-weighted radial variance. */
  variance: Float64Array<ArrayBuffer>;
  /** Area-weighted 90th percentile of the distance from the axis. */
  outer: Float64Array<ArrayBuffer>;
  /** Sample area in the ring. */
  area: Float64Array<ArrayBuffer>;
}

/**
 * The `n` rings (default 24) of the samples along the line `origin + t·axis` (§2.9.7 steps 2 and 4): ring i covers
 * `t ∈ [t0 + i·dt, t0 + (i+1)·dt)` (the last ring is closed), t0..t0 + n·dt = the samples' axial range.
 */
export function ringProfile(s: SurfaceSamples, origin: Vec3, axis: Vec3, n = FIT_RINGS): RingProfile {
  const a = normalize(axis);
  const t = new Float64Array(s.count);
  const rho = new Float64Array(s.count);
  let [tmin, tmax] = axialRange(s, origin, a);
  for (let i = 0; i < s.count; i++) {
    const x = s.p[3 * i] - origin[0];
    const y = s.p[3 * i + 1] - origin[1];
    const z = s.p[3 * i + 2] - origin[2];
    const ti = x * a[0] + y * a[1] + z * a[2];
    t[i] = ti;
    const rx = x - ti * a[0];
    const ry = y - ti * a[1];
    const rz = z - ti * a[2];
    rho[i] = Math.sqrt(rx * rx + ry * ry + rz * rz);
    if (ti < tmin) tmin = ti;
    if (ti > tmax) tmax = ti;
  }
  const dt = tmax > tmin ? (tmax - tmin) / n : 1;
  const ringOf = (ti: number): number => Math.min(n - 1, Math.max(0, Math.floor((ti - tmin) / dt)));
  const mean = new Float64Array(n);
  const sq = new Float64Array(n);
  const area = new Float64Array(n);
  const members: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < s.count; i++) {
    const r = ringOf(t[i]);
    const w = s.w[i];
    area[r] += w;
    mean[r] += w * rho[i];
    sq[r] += w * rho[i] * rho[i];
    members[r].push(i);
  }
  const variance = new Float64Array(n);
  const outer = new Float64Array(n);
  for (let r = 0; r < n; r++) {
    if (!(area[r] > 0)) continue;
    mean[r] /= area[r];
    variance[r] = Math.max(0, sq[r] / area[r] - mean[r] * mean[r]);
    const m = members[r].sort((i, j) => rho[i] - rho[j] || i - j);
    let acc = 0;
    const limit = 0.9 * area[r];
    outer[r] = rho[m[m.length - 1]];
    for (const i of m) {
      acc += s.w[i];
      if (acc >= limit) {
        outer[r] = rho[i];
        break;
      }
    }
  }
  return { t0: tmin, dt, n, mean, variance, outer, area };
}

// ---------------------------------------------------------------------------------------------------- candidates

interface Candidate {
  type: FitType;
  dims: Part['dims'];
  position: Vec3;
  /** Columns = the part's local axes in the mesh frame. */
  R: Mat3;
  sdf: LocalSdf;
}

const IDENTITY: Mat3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const col = (m: Mat3, j: number): Vec3 => [m[j], m[3 + j], m[6 + j]];

/** Solves the symmetric positive system A·x = b (n × n, row-major) by Gaussian elimination; null when singular. */
export function solveLinear(A: number[], b: number[], n: number): number[] | null {
  const M = A.slice();
  const v = b.slice();
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r * n + c]) > Math.abs(M[piv * n + c])) piv = r;
    const scale = Math.max(...M.slice(c * n, c * n + n).map(Math.abs), 1e-300);
    if (!(Math.abs(M[piv * n + c]) > 1e-14 * scale)) return null;
    if (piv !== c) {
      for (let k = 0; k < n; k++) [M[c * n + k], M[piv * n + k]] = [M[piv * n + k], M[c * n + k]];
      [v[c], v[piv]] = [v[piv], v[c]];
    }
    for (let r = c + 1; r < n; r++) {
      const f = M[r * n + c] / M[c * n + c];
      if (f === 0) continue;
      for (let k = c; k < n; k++) M[r * n + k] -= f * M[c * n + k];
      v[r] -= f * v[c];
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let acc = v[r];
    for (let k = r + 1; k < n; k++) acc -= M[r * n + k] * x[k];
    x[r] = acc / M[r * n + r];
  }
  return x.every(Number.isFinite) ? x : null;
}

/** Weighted linear least squares: rows of `features(i)` against `target(i)`. */
function leastSquares(s: SurfaceSamples, m: number, features: (i: number, out: number[]) => void, target: (i: number) => number): number[] | null {
  const A = new Array<number>(m * m).fill(0);
  const b = new Array<number>(m).fill(0);
  const f = new Array<number>(m).fill(0);
  for (let i = 0; i < s.count; i++) {
    features(i, f);
    const w = s.w[i];
    const y = target(i);
    for (let r = 0; r < m; r++) {
      const wr = w * f[r];
      b[r] += wr * y;
      for (let c = r; c < m; c++) A[r * m + c] += wr * f[c];
    }
  }
  for (let r = 0; r < m; r++) for (let c = 0; c < r; c++) A[r * m + c] = A[c * m + r];
  return solveLinear(A, b, m);
}

/**
 * The frame closest to the identity (largest trace, det +1) whose axes are the given ones up to order and sign.
 * `fixedZ`: local Z must be ±axes[2] (flat parts face ±Z). Returns the matrix and, per local axis, which input
 * axis it took.
 */
export function nearestFrame(axes: readonly [Vec3, Vec3, Vec3], fixedZ = false): { R: Mat3; perm: [number, number, number] } {
  const perms: [number, number, number][] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  let best: { R: Mat3; perm: [number, number, number]; trace: number } | null = null;
  for (const perm of perms) {
    if (fixedZ && perm[2] !== 2) continue;
    for (let signs = 0; signs < 8; signs++) {
      const c = perm.map((k, j) => {
        const sgn = (signs >> j) & 1 ? -1 : 1;
        return [axes[k][0] * sgn, axes[k][1] * sgn, axes[k][2] * sgn] as Vec3;
      }) as [Vec3, Vec3, Vec3];
      if (dot(cross(c[0], c[1]), c[2]) <= 0) continue;
      const trace = c[0][0] + c[1][1] + c[2][2];
      if (!best || trace > best.trace + 1e-12) best = { R: mat3FromColumns(c[0], c[1], c[2]), perm, trace };
    }
  }
  return best as { R: Mat3; perm: [number, number, number] };
}

/** Radii (or extents) within this fraction are "equal": the frame may turn freely about the remaining axis. */
const DEGENERATE = 0.01;

/**
 * The frame closest to the identity that keeps local axis `k` of `R` (its other two axes are free: equal radii, a
 * circle): the other axes become the world axes projected onto the plane perpendicular to it.
 */
export function turnFreeAxes(R: Mat3, k: 0 | 1 | 2): Mat3 {
  const fixed = col(R, k);
  const a = ((k + 1) % 3) as 0 | 1 | 2;
  const b = ((k + 2) % 3) as 0 | 1 | 2;
  const unit = (i: number): Vec3 => [i === 0 ? 1 : 0, i === 1 ? 1 : 0, i === 2 ? 1 : 0];
  const project = (v: Vec3): Vec3 => {
    const d = dot(v, fixed);
    return [v[0] - d * fixed[0], v[1] - d * fixed[1], v[2] - d * fixed[2]];
  };
  let first = project(unit(a));
  if (Math.hypot(...first) < 1e-6) first = project(unit(b));
  const ea = normalize(first);
  // right-handed: axis b = fixed × a when (a, b, k) is cyclic
  const eb = normalize(cross(fixed, ea));
  const cols: Vec3[] = [];
  cols[k] = fixed;
  cols[a] = ea;
  cols[b] = eb;
  return mat3FromColumns(cols[0], cols[1], cols[2]);
}

/** An axis direction with a deterministic sign: up when it is more vertical than not, else its largest component positive. */
function orientAxis(a: Vec3): Vec3 {
  const n = normalize(a);
  if (Math.abs(n[1]) >= 0.5) return n[1] < 0 ? [-n[0], -n[1], -n[2]] : n;
  let big = 0;
  if (Math.abs(n[1]) > Math.abs(n[big])) big = 1;
  if (Math.abs(n[2]) > Math.abs(n[big])) big = 2;
  return n[big] < 0 ? [-n[0], -n[1], -n[2]] : n;
}

/** The rotation closest to the identity that takes local +Y to `axis` (shortest arc). */
function frameForAxis(axis: Vec3): Mat3 {
  const a = normalize(axis);
  const c = a[1];
  if (c > 1 - 1e-12) return IDENTITY;
  if (c < -1 + 1e-12) return rotationAxisAngle([1, 0, 0], Math.PI);
  return rotationAxisAngle(cross([0, 1, 0], a), Math.acos(Math.max(-1, Math.min(1, c))));
}

const add3 = (a: Vec3, b: Vec3, s: number): Vec3 => [a[0] + s * b[0], a[1] + s * b[1], a[2] + s * b[2]];

function sphereCandidate(s: SurfaceSamples, c0: Vec3): Candidate | null {
  // |p|² = 2c·p + k, centered on c0 for conditioning.
  const x = (i: number, k: number): number => s.p[3 * i + k] - c0[k];
  const sol = leastSquares(
    s,
    4,
    (i, f) => {
      f[0] = 2 * x(i, 0);
      f[1] = 2 * x(i, 1);
      f[2] = 2 * x(i, 2);
      f[3] = 1;
    },
    (i) => x(i, 0) ** 2 + x(i, 1) ** 2 + x(i, 2) ** 2,
  );
  if (!sol) return null;
  const r2 = sol[3] + sol[0] ** 2 + sol[1] ** 2 + sol[2] ** 2;
  if (!(r2 > 0)) return null;
  const r = Math.sqrt(r2);
  const dims = { r };
  return { type: 'sphere', dims, position: [c0[0] + sol[0], c0[1] + sol[1], c0[2] + sol[2]], R: IDENTITY, sdf: localSdf({ id: 'x', type: 'sphere', dims, position: [0, 0, 0], color: 'x' }) };
}

function ellipsoidCandidate(s: SurfaceSamples, f: PcaFrame): Candidate | null {
  const E = f.axes;
  const c = f.centroid;
  const q = (i: number, k: number): number =>
    (s.p[3 * i] - c[0]) * E[k][0] + (s.p[3 * i + 1] - c[1]) * E[k][1] + (s.p[3 * i + 2] - c[2]) * E[k][2];
  const sol = leastSquares(
    s,
    6,
    (i, out) => {
      const q0 = q(i, 0);
      const q1 = q(i, 1);
      const q2 = q(i, 2);
      out[0] = q0 * q0;
      out[1] = q1 * q1;
      out[2] = q2 * q2;
      out[3] = q0;
      out[4] = q1;
      out[5] = q2;
    },
    () => 1,
  );
  if (!sol || !(sol[0] > 0 && sol[1] > 0 && sol[2] > 0)) return null;
  const d = [0, 1, 2].map((k) => -sol[3 + k] / (2 * sol[k]));
  const g = 1 + sol[0] * d[0] ** 2 + sol[1] * d[1] ** 2 + sol[2] * d[2] ** 2;
  if (!(g > 0)) return null;
  const radii = [0, 1, 2].map((k) => Math.sqrt(g / sol[k]));
  const center: Vec3 = [0, 1, 2].map((j) => c[j] + d[0] * E[0][j] + d[1] * E[1][j] + d[2] * E[2][j]) as Vec3;
  const near = nearestFrame(E);
  const perm = near.perm;
  let R = near.R;
  const dims = { rx: radii[perm[0]], ry: radii[perm[1]], rz: radii[perm[2]] };
  const r3 = [dims.rx, dims.ry, dims.rz];
  const same = (i: number, j: number): boolean => Math.abs(r3[i] - r3[j]) <= DEGENERATE * Math.max(r3[i], r3[j]);
  if (same(0, 1) && same(1, 2)) R = IDENTITY;
  else if (same(0, 1)) R = turnFreeAxes(R, 2);
  else if (same(1, 2)) R = turnFreeAxes(R, 0);
  else if (same(0, 2)) R = turnFreeAxes(R, 1);
  return { type: 'ellipsoid', dims, position: center, R, sdf: localSdf({ id: 'x', type: 'ellipsoid', dims, position: [0, 0, 0], color: 'x' }) };
}

/** Weighted line fit y = α + β·x over (x_i, y_i, w_i). */
function lineFit(xs: number[], ys: number[], ws: number[]): [number, number] | null {
  let W = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < xs.length; i++) {
    W += ws[i];
    sx += ws[i] * xs[i];
    sy += ws[i] * ys[i];
    sxx += ws[i] * xs[i] * xs[i];
    sxy += ws[i] * xs[i] * ys[i];
  }
  if (!(W > 0)) return null;
  const den = W * sxx - sx * sx;
  if (!(Math.abs(den) > 1e-18 * Math.max(1, W * sxx))) return [sy / W, 0];
  const beta = (W * sxy - sx * sy) / den;
  return [(sy - beta * sx) / W, beta];
}

/** The interior rings (the end rings hold the caps) with samples: axial centers, outer radii, areas. */
function interiorRings(rp: RingProfile): { t: number[]; r: number[]; w: number[] } {
  const t: number[] = [];
  const r: number[] = [];
  const w: number[] = [];
  for (let i = 1; i < rp.n - 1; i++) {
    if (!(rp.area[i] > 0)) continue;
    t.push(rp.t0 + (i + 0.5) * rp.dt);
    r.push(rp.outer[i]);
    w.push(rp.area[i]);
  }
  return { t, r, w };
}

function revolutionCandidates(s: SurfaceSamples, f: PcaFrame, axisIn: Vec3, capsuleToo: boolean): Candidate[] {
  const out: Candidate[] = [];
  const axis = orientAxis(axisIn);
  const c = f.centroid;
  const rp = ringProfile(s, c, axis);
  const L = rp.n * rp.dt;
  const tmin = rp.t0;
  const tmax = rp.t0 + L;
  const mid = (tmin + tmax) / 2;
  if (!(L > 0)) return out;
  const R = frameForAxis(axis);
  const ring = interiorRings(rp);
  if (ring.t.length >= 2) {
    // cylinder: outer radius linear along the axis
    const line = lineFit(ring.t, ring.r, ring.w);
    if (line) {
      const rBottom = Math.max(0, line[0] + line[1] * tmin);
      const rTop = Math.max(0, line[0] + line[1] * tmax);
      if (rBottom + rTop > 0) {
        const dims = { rTop, rBottom, h: L };
        out.push({ type: 'cylinder', dims, position: add3(c, axis, mid), R, sdf: localSdf({ id: 'x', type: 'cylinder', dims, position: [0, 0, 0], color: 'x' }) });
      }
    }
    // cone: radius 0 at the apex, the end where the cylinder's line is narrower
    if (line) {
      const apexTop = line[1] <= 0;
      const apexT = apexTop ? tmax : tmin;
      let num = 0;
      let den = 0;
      for (let i = 0; i < ring.t.length; i++) {
        const x = Math.abs(apexT - ring.t[i]);
        num += ring.w[i] * x * ring.r[i];
        den += ring.w[i] * x * x;
      }
      const beta = den > 0 ? num / den : 0;
      const r = beta * L;
      if (r > 0) {
        const coneAxis: Vec3 = apexTop ? axis : [-axis[0], -axis[1], -axis[2]];
        const dims = { r, h: L };
        out.push({ type: 'cone', dims, position: add3(c, axis, mid), R: frameForAxis(coneAxis), sdf: localSdf({ id: 'x', type: 'cone', dims, position: [0, 0, 0], color: 'x' }) });
      }
    }
  }
  if (capsuleToo) {
    // capsule: the radius of the middle half of the length
    let acc = 0;
    let W = 0;
    for (let i = 0; i < rp.n; i++) {
      const tc = rp.t0 + (i + 0.5) * rp.dt;
      if (Math.abs(tc - mid) > L / 4 || !(rp.area[i] > 0)) continue;
      acc += rp.area[i] * rp.outer[i];
      W += rp.area[i];
    }
    const r = W > 0 ? acc / W : 0;
    if (r > 0) {
      const dims = { r, length: Math.max(L, 2 * r) };
      out.push({ type: 'capsule', dims, position: add3(c, axis, mid), R, sdf: localSdf({ id: 'x', type: 'capsule', dims, position: [0, 0, 0], color: 'x' }) });
    }
  }
  // lathe: the mean ring radii as the profile, closed on the axis at both ends
  const profile: [number, number][] = [[0, 0]];
  for (let i = 0; i < rp.n; i++) {
    if (!(rp.area[i] > 0)) continue;
    profile.push([rp.mean[i], (i + 0.5) * rp.dt]);
  }
  profile.push([0, L]);
  if (profile.length >= 3) {
    const dims = { profile };
    out.push({ type: 'lathe', dims, position: add3(c, axis, tmin), R, sdf: localSdf({ id: 'x', type: 'lathe', dims, position: [0, 0, 0], color: 'x' }) });
  }
  return out;
}

/** Signed distance to a closed 2D polygon [x0, y0, …], positive inside. */
function polygonSdf(outline: ArrayLike<number>): (x: number, y: number) => number {
  const n = outline.length >> 1;
  return (x, y) => {
    let best = Infinity;
    let inside = false;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const xi = outline[2 * i];
      const yi = outline[2 * i + 1];
      const xj = outline[2 * j];
      const yj = outline[2 * j + 1];
      const ex = xj - xi;
      const ey = yj - yi;
      const wx = x - xi;
      const wy = y - yi;
      const len2 = ex * ex + ey * ey;
      let t = len2 > 0 ? (wx * ex + wy * ey) / len2 : 0;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const bx = wx - ex * t;
      const by = wy - ey * t;
      const d2 = bx * bx + by * by;
      if (d2 < best) best = d2;
      if (yi > y !== yj > y && x < xi + ((y - yi) / (yj - yi)) * (xj - xi)) inside = !inside;
    }
    const d = Math.sqrt(best);
    return inside ? d : -d;
  };
}

/** The builder's bevel growth of a flat part (`flatBevelSize`, core/model/builder.ts). */
const bevelOf = (w: number, h: number, t: number): number => Math.min(t * 0.3, 0.1 * Math.min(w, h));

/**
 * Signed distance (positive inside) to the builder's flat geometry, bevel included: faces at |z| = t/2 bounded by
 * the outline O; in the middle 0.4·t the outline grown by b; quarter-ellipse bevels (semi-axes b, 0.3·t) between.
 * Distances in the (outside-the-outline, |z|) half-plane; the bevel corner uses the ellipse bound.
 */
export function flatBuilderSdf(outline: ArrayLike<number>, t: number, b: number): LocalSdf {
  const poly = polygonSdf(outline);
  const half = t / 2;
  const band = 0.2 * t;
  const bz = 0.3 * t;
  return (x, y, z) => {
    const s = -poly(x, y); // > 0 outside the outline
    const az = Math.abs(z);
    if (s <= 0) {
      const face = half - az;
      return face >= 0 ? Math.min(face, b - s) : face;
    }
    if (az <= band) return b - s;
    if (b <= 0) return -Math.hypot(s, Math.max(0, az - half));
    // ellipse (semi-axes b, bz) centered at (0, band)
    const ex = s / b;
    const ey = (az - band) / bz;
    const k0 = Math.sqrt(ex * ex + ey * ey);
    const k1 = Math.sqrt((ex / b) ** 2 + (ey / bz) ** 2);
    return k1 > 0 ? (k0 * (1 - k0)) / k1 : Math.min(b, bz);
  };
}

function ellipseOutline(w: number, h: number, n = 64): Float64Array<ArrayBuffer> {
  const o = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    o[2 * i] = (w / 2) * Math.cos(a);
    o[2 * i + 1] = (h / 2) * Math.sin(a);
  }
  return o;
}

function flatCandidate(s: SurfaceSamples, f: PcaFrame): Candidate | null {
  let { R } = nearestFrame(f.axes, true);
  // a round outline has no in-plane direction of its own (its in-plane PCA axes are arbitrary)
  if (Math.abs(f.variances[0] - f.variances[1]) <= 2 * DEGENERATE * f.variances[0]) R = turnFreeAxes(R, 2);
  const X = col(R, 0);
  const Y = col(R, 1);
  const Z = col(R, 2);
  const c = f.centroid;
  const n = s.count;
  const lx = new Float64Array(n);
  const ly = new Float64Array(n);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) {
    const d: Vec3 = [s.p[3 * i] - c[0], s.p[3 * i + 1] - c[1], s.p[3 * i + 2] - c[2]];
    const q = [dot(d, X), dot(d, Y), dot(d, Z)];
    lx[i] = q[0];
    ly[i] = q[1];
  }
  [X, Y, Z].forEach((axis, k) => {
    [lo[k], hi[k]] = axialRange(s, c, axis);
  });
  const Ew = hi[0] - lo[0];
  const Eh = hi[1] - lo[1];
  const t = hi[2] - lo[2];
  if (!(Ew > 0 && Eh > 0 && t > 0)) return null;
  // undo the bevel: the measured extents are w + 2b, h + 2b
  let w = Ew;
  let h = Eh;
  for (let k = 0; k < 8; k++) {
    const b = bevelOf(w, h, t);
    w = Math.max(1e-6, Ew - 2 * b);
    h = Math.max(1e-6, Eh - 2 * b);
  }
  const b = bevelOf(w, h, t);
  const ctr: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const position: Vec3 = [0, 1, 2].map((j) => c[j] + ctr[0] * X[j] + ctr[1] * Y[j] + ctr[2] * Z[j]) as Vec3;
  // outline: the farthest sample per angular bin, minus the bevel
  const bins = 2 * MAX_POLYGON_POINTS;
  const far = new Float64Array(bins).fill(-1);
  const farAngle = new Float64Array(bins);
  for (let i = 0; i < n; i++) {
    const x = lx[i] - ctr[0];
    const y = ly[i] - ctr[1];
    const a = Math.atan2(y, x);
    const k = Math.min(bins - 1, Math.floor(((a + Math.PI) / (2 * Math.PI)) * bins));
    const r = Math.hypot(x, y);
    if (r > far[k]) {
      far[k] = r;
      farAngle[k] = a;
    }
  }
  // empty bins: the mean of the nearest filled neighbours
  for (let k = 0; k < bins; k++) {
    if (far[k] >= 0) continue;
    let a = -1;
    let bb = -1;
    for (let d = 1; d < bins && (a < 0 || bb < 0); d++) {
      if (a < 0 && far[(k - d + bins) % bins] >= 0) a = far[(k - d + bins) % bins];
      if (bb < 0 && far[(k + d) % bins] >= 0) bb = far[(k + d) % bins];
    }
    far[k] = Math.max(0, ((a >= 0 ? a : bb) + (bb >= 0 ? bb : a)) / 2);
    farAngle[k] = -Math.PI + ((k + 0.5) * 2 * Math.PI) / bins;
  }
  // the ellipse test, on the bevel-free outline
  let worst = 0;
  for (let k = 0; k < bins; k++) {
    const ang = -Math.PI + ((k + 0.5) * 2 * Math.PI) / bins;
    const ea = w / 2;
    const eb = h / 2;
    const re = (ea * eb) / Math.hypot(eb * Math.cos(ang), ea * Math.sin(ang));
    worst = Math.max(worst, Math.abs(far[k] - b - re) / re);
  }
  let dims: Extract<Part, { type: 'flat' }>['dims'];
  let outline: ArrayLike<number>;
  if (worst <= OVAL_FIT) {
    if (Math.abs(w - h) <= CIRCLE_TOL * Math.max(w, h)) {
      const d = (w + h) / 2;
      dims = { shape: 'circle', w: d, h: d, thickness: t };
    } else {
      dims = { shape: 'oval', w, h, thickness: t };
    }
    outline = ellipseOutline(dims.w, dims.h);
  } else {
    const points: [number, number][] = [];
    // the farther sample of each pair of bins, at its own angle (keeps corners), pulled in by the bevel
    for (let k = 0; k < MAX_POLYGON_POINTS; k++) {
      const j = far[2 * k] >= far[2 * k + 1] ? 2 * k : 2 * k + 1;
      const r = Math.max(0, far[j] - b);
      points.push([r * Math.cos(farAngle[j]), r * Math.sin(farAngle[j])]);
    }
    // the builder centers the extrusion on its bounding box: re-center the points the same way
    const px = points.map((p) => p[0]);
    const py = points.map((p) => p[1]);
    const ox = (Math.min(...px) + Math.max(...px)) / 2;
    const oy = (Math.min(...py) + Math.max(...py)) / 2;
    const pts = points.map(([x, y]) => [x - ox, y - oy] as [number, number]);
    dims = { shape: 'polygon', w, h, thickness: t, points: pts };
    outline = pts.flat();
  }
  return { type: 'flat', dims, position, R, sdf: flatBuilderSdf(outline, t, b) };
}

// ---------------------------------------------------------------------------------------------------- scoring

/** RMS of the candidate's signed distance at the samples (every `stride`-th), in the mesh's units. */
function rmsDistance(s: SurfaceSamples, c: Candidate, stride: number): number {
  const R = c.R;
  const [px, py, pz] = c.position;
  let acc = 0;
  let W = 0;
  for (let i = 0; i < s.count; i += stride) {
    const dx = s.p[3 * i] - px;
    const dy = s.p[3 * i + 1] - py;
    const dz = s.p[3 * i + 2] - pz;
    // Rᵀ·d (R's columns are the local axes)
    const x = R[0] * dx + R[3] * dy + R[6] * dz;
    const y = R[1] * dx + R[4] * dy + R[7] * dz;
    const z = R[2] * dx + R[5] * dy + R[8] * dz;
    const d = c.sdf(x, y, z);
    if (!Number.isFinite(d)) return Infinity;
    acc += s.w[i] * d * d;
    W += s.w[i];
  }
  return W > 0 ? Math.sqrt(acc / W) : Infinity;
}

/** The area-weighted mean distance of the surface from its centroid ("mean radius" of the score). */
function meanRadius(s: SurfaceSamples, c: Vec3): number {
  let acc = 0;
  let W = 0;
  for (let i = 0; i < s.count; i++) {
    acc += s.w[i] * Math.hypot(s.p[3 * i] - c[0], s.p[3 * i + 1] - c[1], s.p[3 * i + 2] - c[2]);
    W += s.w[i];
  }
  return W > 0 ? acc / W : 0;
}

/** Every candidate with its score (diagnostics and tests): type, dims, position, rotation and residual. */
export function fitCandidates(mesh: Pick<ColoredMesh, 'positions' | 'indices'>): FitResult[] {
  const s = surfaceSamples(mesh.positions, mesh.indices);
  if (s.count === 0 || !(s.area > 0)) throw new RangeError('fitPart: the mesh has no triangles with area');
  const f = pcaFrame(s);
  const scale = meanRadius(s, f.centroid);
  if (!(scale > 0)) throw new RangeError('fitPart: the mesh has no extent');
  const stride = Math.max(1, Math.ceil(s.count / MAX_SCORE_SAMPLES));
  const cands: Candidate[] = [];
  const sphere = sphereCandidate(s, f.centroid);
  if (sphere) cands.push(sphere);
  const ell = ellipsoidCandidate(s, f);
  if (ell) cands.push(ell);
  cands.push(...revolutionCandidates(s, f, f.axes[0], true));
  cands.push(...revolutionCandidates(s, f, f.axes[2], false));
  // extents along the principal axes decide whether `flat` is a candidate
  const ext = [0, 1, 2].map((k) => {
    const [lo, hi] = axialRange(s, f.centroid, f.axes[k]);
    return hi - lo;
  });
  if (ext[2] < FLAT_RATIO * ext[0]) {
    const flat = flatCandidate(s, f);
    if (flat) cands.push(flat);
  }
  // A closed mesh has a volume: a candidate whose volume is far from it (a disc for a ring) does not count.
  const closed = isWatertight(weldedIndices(mesh.positions, mesh.indices));
  const volume = closed ? Math.abs(signedVolume(mesh)) : NaN;
  const fits = (c: Candidate): boolean => {
    if (!(volume > 0)) return true;
    const v = partVolume({ id: 'x', type: c.type, dims: c.dims, position: [0, 0, 0], color: 'x' } as Part);
    return Math.abs(v / volume - 1) <= FIT_VOLUME_TOL;
  };
  return cands.filter(fits).map((c) => ({
    type: c.type,
    dims: roundDims(c.dims),
    position: c.position.map((v) => roundCoord(v)) as Vec3,
    rotationDeg: c.type === 'sphere' ? [0, 0, 0] : (mat3ToEulerXYZ(c.R).map((v) => roundCoord(v)) as Vec3),
    residual: rmsDistance(s, c, stride) / scale,
  }));
}

/**
 * Indices with coincident vertices merged (the UV seams of the builder's tessellations, where sin 2π ≠ 0 leaves
 * 1e-16 differences), first occurrence wins: positions are compared on a lattice of 1e-9 × the largest extent.
 */
export function weldedIndices(positions: ArrayLike<number>, indices: ArrayLike<number>): Uint32Array<ArrayBuffer> {
  const first = new Map<string, number>();
  const nv = Math.floor(positions.length / 3);
  let extent = 0;
  for (let i = 0; i < nv * 3; i++) extent = Math.max(extent, Math.abs(positions[i]));
  const q = extent > 0 ? extent * 1e-9 : 1;
  const map = new Uint32Array(nv);
  for (let i = 0; i < nv; i++) {
    const key = `${Math.round(positions[3 * i] / q)},${Math.round(positions[3 * i + 1] / q)},${Math.round(positions[3 * i + 2] / q)}`;
    const j = first.get(key);
    if (j === undefined) {
      first.set(key, i);
      map[i] = i;
    } else {
      map[i] = j;
    }
  }
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = map[indices[i]];
  return out;
}

function roundDims(d: Part['dims']): Part['dims'] {
  const r = (v: unknown): unknown =>
    typeof v === 'number' ? roundCoord(v) : Array.isArray(v) ? v.map(r) : v;
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, r(v)])) as Part['dims'];
}

/** The bounding box of the vertices: center and size. */
function meshBox(positions: ArrayLike<number>): { center: Vec3; size: Vec3 } {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      const v = positions[i + k];
      if (v < lo[k]) lo[k] = v;
      if (v > hi[k]) hi[k] = v;
    }
  }
  return { center: [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as Vec3, size: [0, 1, 2].map((k) => hi[k] - lo[k]) as Vec3 };
}

/**
 * Chooses among the scored candidates (§2.9.7 step 4): the simplest within `PREFER_SIMPLER` of the best; when
 * its score exceeds `tolerance`, a `mesh` result (dims `{ meshRef: '', bboxIn }`, position = the bbox center; the
 * caller names the mesh) carrying that score.
 */
export function chooseFit(candidates: readonly FitResult[], mesh: Pick<ColoredMesh, 'positions'>, tolerance = FIT_ACCEPT): FitResult {
  const scored = candidates.filter((c) => Number.isFinite(c.residual));
  const best = scored.reduce((m, c) => Math.min(m, c.residual), Infinity);
  let chosen: FitResult | undefined;
  for (const type of FIT_ORDER) {
    const c = scored.filter((x) => x.type === type).sort((a, b) => a.residual - b.residual)[0];
    if (c && c.residual <= best + PREFER_SIMPLER) {
      chosen = c;
      break;
    }
  }
  if (chosen && chosen.residual <= tolerance) return chosen;
  const box = meshBox(mesh.positions);
  return {
    type: 'mesh',
    dims: { meshRef: '', bboxIn: box.size.map((v) => roundCoord(v)) as Vec3 },
    position: box.center.map((v) => roundCoord(v)) as Vec3,
    rotationDeg: [0, 0, 0],
    residual: chosen ? chosen.residual : Infinity,
  };
}

/**
 * §5.2.1 `fitPart`: the best primitive for a mesh (`o.tolerance` = the acceptance score, default 0.12; `mesh` when
 * nothing fits). RangeError for a mesh without triangles of positive area.
 */
export const fitPart: FitPartFn = (mesh, o) => {
  if (!mesh || !(mesh.positions?.length >= 9) || !(mesh.indices?.length >= 3)) throw new RangeError('fitPart: the mesh has no triangles');
  const tol = o?.tolerance ?? FIT_ACCEPT;
  if (!(tol >= 0)) throw new RangeError(`fitPart: tolerance must be ≥ 0, got ${String(o?.tolerance)}`);
  return chooseFit(fitCandidates(mesh), mesh, tol);
};
