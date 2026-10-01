// Small vector and matrix math (DESIGN.md §5.1). Step 0 kernel: pure, allocation-light, no three.js.
//
// Conventions (§0.1): right-handed, +Y up, the object's front faces +Z, its own left is +X. Matrices are 3×3,
// row-major (m[3·row + col]) and act on column vectors: `mulMat3Vec(m, v)` is m·v. A rotation by a positive
// angle is counter-clockwise seen from the tip of its axis. Every function returns a new value.
import type { Vec3 } from '../../types/geometry';

/** A 3×3 matrix, row-major: [m00, m01, m02, m10, m11, m12, m20, m21, m22]. */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;

// ---- scalars

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Linear interpolation: a at t = 0, b at t = 1. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Hermite step: 0 for x ≤ e0, 1 for x ≥ e1, smooth in between. */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** Floored modulo: the result has the sign of `m` (`mod(-1, 360)` is 359). */
export function mod(x: number, m: number): number {
  return ((x % m) + m) % m;
}

// ---- Vec3

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return [x, y, z];
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s];
}

/** a + b·s */
export function addScaled(a: Vec3, b: Vec3, s: number): Vec3 {
  return [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
}

export function negate(a: Vec3): Vec3 {
  return [-a[0], -a[1], -a[2]];
}

/** Component-wise product. */
export function multiply(a: Vec3, b: Vec3): Vec3 {
  return [a[0] * b[0], a[1] * b[1], a[2] * b[2]];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Right-handed cross product: cross(+X, +Y) = +Z. */
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function lengthSq(a: Vec3): number {
  return a[0] * a[0] + a[1] * a[1] + a[2] * a[2];
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

export function distance(a: Vec3, b: Vec3): number {
  return length(sub(a, b));
}

/** The unit vector along `a`; `fallback` (default +Y) when `a` is shorter than 1e-12. */
export function normalize(a: Vec3, fallback: Vec3 = [0, 1, 0]): Vec3 {
  const len = length(a);
  return len < 1e-12 ? [fallback[0], fallback[1], fallback[2]] : [a[0] / len, a[1] / len, a[2] / len];
}

export function lerpVec(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

export function minVec(a: Vec3, b: Vec3): Vec3 {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])];
}

export function maxVec(a: Vec3, b: Vec3): Vec3 {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

/** True when every component differs by at most `eps`. */
export function nearlyEqual(a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (!(Math.abs(a[i] - b[i]) <= eps)) return false;
  }
  return true;
}

/** A unit vector perpendicular to `a` (deterministic: built from the axis `a` is least aligned with). */
export function anyPerpendicular(a: Vec3): Vec3 {
  const ax = Math.abs(a[0]);
  const ay = Math.abs(a[1]);
  const az = Math.abs(a[2]);
  const helper: Vec3 = ax <= ay && ax <= az ? [1, 0, 0] : ay <= az ? [0, 1, 0] : [0, 0, 1];
  return normalize(cross(a, helper), [1, 0, 0]);
}

// ---- Mat3

export function identity3(): Mat3 {
  return [1, 0, 0, 0, 1, 0, 0, 0, 1];
}

/** The matrix whose rows are `r0`, `r1`, `r2`. */
export function mat3FromRows(r0: Vec3, r1: Vec3, r2: Vec3): Mat3 {
  return [r0[0], r0[1], r0[2], r1[0], r1[1], r1[2], r2[0], r2[1], r2[2]];
}

/** The matrix whose columns are `c0`, `c1`, `c2` (the images of +X, +Y, +Z). */
export function mat3FromColumns(c0: Vec3, c1: Vec3, c2: Vec3): Mat3 {
  return [c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2]];
}

export function mat3Column(m: Mat3, col: 0 | 1 | 2): Vec3 {
  return [m[col], m[3 + col], m[6 + col]];
}

/** a·b: applies `b` first, then `a`. */
export function mulMat3(a: Mat3, b: Mat3): Mat3 {
  const out = identity3();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[3 * r + c] = a[3 * r] * b[c] + a[3 * r + 1] * b[3 + c] + a[3 * r + 2] * b[6 + c];
    }
  }
  return out;
}

/** m·v */
export function mulMat3Vec(m: Mat3, v: Vec3): Vec3 {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2],
  ];
}

/** The transpose — also the inverse of a rotation matrix. */
export function transpose3(m: Mat3): Mat3 {
  return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
}

export function det3(m: Mat3): number {
  return m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
}

/**
 * The inverse, or null when the matrix is singular. "Singular" is relative to the size of the entries
 * (|det| ≤ 1e-12 · max|m|³), so a well-conditioned matrix of tiny numbers still inverts.
 */
export function invert3(m: Mat3): Mat3 | null {
  const det = det3(m);
  let size = 0;
  for (const v of m) size = Math.max(size, Math.abs(v));
  if (!Number.isFinite(det) || !(Math.abs(det) > 1e-12 * size * size * size)) return null;
  const s = 1 / det;
  return [
    (m[4] * m[8] - m[5] * m[7]) * s,
    (m[2] * m[7] - m[1] * m[8]) * s,
    (m[1] * m[5] - m[2] * m[4]) * s,
    (m[5] * m[6] - m[3] * m[8]) * s,
    (m[0] * m[8] - m[2] * m[6]) * s,
    (m[2] * m[3] - m[0] * m[5]) * s,
    (m[3] * m[7] - m[4] * m[6]) * s,
    (m[1] * m[6] - m[0] * m[7]) * s,
    (m[0] * m[4] - m[1] * m[3]) * s,
  ];
}

/** Rotation about +X by `rad`: +Y turns toward +Z. */
export function rotationX(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [1, 0, 0, 0, c, -s, 0, s, c];
}

/** Rotation about +Y by `rad`: +Z turns toward +X. */
export function rotationY(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, 0, s, 0, 1, 0, -s, 0, c];
}

/** Rotation about +Z by `rad`: +X turns toward +Y. */
export function rotationZ(rad: number): Mat3 {
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

/** Rotation by `rad` about `axis` (normalized here; Rodrigues' formula). */
export function rotationAxisAngle(axis: Vec3, rad: number): Mat3 {
  const [x, y, z] = normalize(axis);
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const t = 1 - c;
  return [
    t * x * x + c,
    t * x * y - s * z,
    t * x * z + s * y,
    t * x * y + s * z,
    t * y * y + c,
    t * y * z - s * x,
    t * x * z - s * y,
    t * y * z + s * x,
    t * z * z + c,
  ];
}

/**
 * Eigen-decomposition of a symmetric 3×3 matrix (cyclic Jacobi). `values` are sorted from largest to smallest;
 * `vectors[i]` is the unit eigenvector of `values[i]`. The signs are fixed so the result is deterministic and
 * the three vectors form a RIGHT-HANDED frame (a rotation, never a reflection): the first two have their
 * largest component positive, and the third is their cross product. Only the upper triangle of `m` is read.
 * Use: principal axes of a covariance matrix.
 */
export function eigenSymmetric3(m: Mat3): { values: Vec3; vectors: [Vec3, Vec3, Vec3] } {
  const a = [m[0], m[1], m[2], m[1], m[4], m[5], m[2], m[5], m[8]];
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 32; sweep++) {
    const off = a[1] * a[1] + a[2] * a[2] + a[5] * a[5];
    const diag = a[0] * a[0] + a[4] * a[4] + a[8] * a[8];
    if (off <= 1e-30 * diag || off === 0) break;
    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[3 * p + q];
        if (apq === 0) continue;
        const theta = (a[3 * q + q] - a[3 * p + p]) / (2 * apq);
        const t = (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        // a ← Jᵀ·a·J and v ← v·J, with J the rotation in the (p, q) plane.
        for (let k = 0; k < 3; k++) {
          const akp = a[3 * k + p];
          const akq = a[3 * k + q];
          a[3 * k + p] = c * akp - s * akq;
          a[3 * k + q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[3 * p + k];
          const aqk = a[3 * q + k];
          a[3 * p + k] = c * apk - s * aqk;
          a[3 * q + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[3 * k + p];
          const vkq = v[3 * k + q];
          v[3 * k + p] = c * vkp - s * vkq;
          v[3 * k + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[4 * j] - a[4 * i] || i - j);
  const column = (i: number): Vec3 => {
    let e: Vec3 = normalize([v[i], v[3 + i], v[6 + i]], [1, 0, 0]);
    // Sign: the component with the largest magnitude (lowest index on ties) is positive.
    let big = 0;
    if (Math.abs(e[1]) > Math.abs(e[big])) big = 1;
    if (Math.abs(e[2]) > Math.abs(e[big])) big = 2;
    if (e[big] < 0) e = negate(e);
    return e;
  };
  const e0 = column(order[0]);
  const e1 = column(order[1]);
  // The third axis completes a right-handed frame; it is the remaining eigenvector up to its sign.
  const e2 = normalize(cross(e0, e1), column(order[2]));
  return { values: [a[4 * order[0]], a[4 * order[1]], a[4 * order[2]]], vectors: [e0, e1, e2] };
}
