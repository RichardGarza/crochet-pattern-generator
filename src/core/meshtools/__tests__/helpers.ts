// Test helpers for the mesh tools (not a test file). Independent of the kernels under test: the brute-force SDF
// here walks every triangle for every sample and signs by the generalized winding number.
import { marchingCubes, type IndexedMesh } from '../../kernel/geom/marchingCubes';
import { taubinSmooth } from '../../kernel/geom/taubin';
import { mulberry32 } from '../../kernel/prng';
import type { MeshLike } from '../../kernel/geom/meshMeasures';
import type { ColoredMesh, Vec3 } from '../../../types/geometry';

/** Suites that do real geometry work: a generous timeout (a timeout under load is a flake, not a pass). */
export const HEAVY = { timeout: 120_000 } as const;

export type Implicit = (x: number, y: number, z: number) => number;

export const sphereF =
  (r: number, c: Vec3 = [0, 0, 0]): Implicit =>
  (x, y, z) =>
    r - Math.hypot(x - c[0], y - c[1], z - c[2]);

/** Approximate ellipsoid field (exact sign). */
export const ellipsoidF =
  (r: Vec3, c: Vec3 = [0, 0, 0]): Implicit =>
  (x, y, z) =>
    Math.min(r[0], r[1], r[2]) * (1 - Math.hypot((x - c[0]) / r[0], (y - c[1]) / r[1], (z - c[2]) / r[2]));

/** A closed mesh of the zero level of `f` over the cube [−half, half]³ sampled at n³ (MC + optional Taubin). */
export function meshOf(f: Implicit, n: number, half: number, pairs = 0): IndexedMesh {
  const field = new Float32Array(n * n * n);
  const voxel = (2 * half) / (n - 1);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = f(-half + voxel * x, -half + voxel * y, -half + voxel * z);
  const m = marchingCubes(field, [n, n, n], { origin: [-half, -half, -half], voxel });
  if (pairs > 0) taubinSmooth(m.positions, m.indices, { pairs });
  return m;
}

/** A UV sphere (closed, outward winding) with `seg` segments and `rings` rings: 2·seg·(rings − 1) triangles. */
export function uvSphere(r: number, seg: number, rings: number, c: Vec3 = [0, 0, 0]): IndexedMesh {
  const pos: number[] = [c[0], c[1] + r, c[2]];
  for (let k = 1; k < rings; k++) {
    const th = (Math.PI * k) / rings;
    for (let s = 0; s < seg; s++) {
      const ph = (2 * Math.PI * s) / seg;
      pos.push(c[0] + r * Math.sin(th) * Math.sin(ph), c[1] + r * Math.cos(th), c[2] + r * Math.sin(th) * Math.cos(ph));
    }
  }
  pos.push(c[0], c[1] - r, c[2]);
  const idx: number[] = [];
  const ring = (k: number, s: number): number => 1 + (k - 1) * seg + (((s % seg) + seg) % seg);
  const south = pos.length / 3 - 1;
  for (let s = 0; s < seg; s++) idx.push(0, ring(1, s), ring(1, s + 1));
  for (let k = 1; k < rings - 1; k++) {
    for (let s = 0; s < seg; s++) {
      idx.push(ring(k, s), ring(k + 1, s), ring(k + 1, s + 1));
      idx.push(ring(k, s), ring(k + 1, s + 1), ring(k, s + 1));
    }
  }
  for (let s = 0; s < seg; s++) idx.push(ring(rings - 1, s), south, ring(rings - 1, s + 1));
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

export function colored(m: IndexedMesh, label = 0): ColoredMesh {
  return { positions: m.positions, indices: m.indices, labels: new Uint8Array(m.positions.length / 3).fill(label) };
}

/** Exact distance from p to triangle abc (textbook projection + edge clamps, independent of the kernel's form). */
export function pointTriangleDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  const sub = (u: Vec3, v: Vec3): Vec3 => [u[0] - v[0], u[1] - v[1], u[2] - v[2]];
  const dot = (u: Vec3, v: Vec3): number => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const cross = (u: Vec3, v: Vec3): Vec3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const segDist = (q: Vec3, u: Vec3, v: Vec3): number => {
    const d = sub(v, u);
    const L = dot(d, d);
    const t = L > 0 ? Math.min(1, Math.max(0, dot(sub(q, u), d) / L)) : 0;
    const w = sub(q, [u[0] + d[0] * t, u[1] + d[1] * t, u[2] + d[2] * t]);
    return Math.sqrt(dot(w, w));
  };
  const n = cross(sub(b, a), sub(c, a));
  const nn = Math.sqrt(dot(n, n));
  if (nn > 0) {
    const nh: Vec3 = [n[0] / nn, n[1] / nn, n[2] / nn];
    const s = dot(sub(p, a), nh);
    const q: Vec3 = [p[0] - nh[0] * s, p[1] - nh[1] * s, p[2] - nh[2] * s];
    const e0 = dot(cross(sub(b, a), sub(q, a)), nh);
    const e1 = dot(cross(sub(c, b), sub(q, b)), nh);
    const e2 = dot(cross(sub(a, c), sub(q, c)), nh);
    if (e0 >= 0 && e1 >= 0 && e2 >= 0) return Math.abs(s);
  }
  return Math.min(segDist(p, a, b), segDist(p, b, c), segDist(p, c, a));
}

/** Generalized winding number of a closed mesh at p (≈1 inside, ≈0 outside); allocation-free. */
export function windingNumber(m: MeshLike, p: Vec3): number {
  let total = 0;
  const P = m.positions;
  const I = m.indices;
  for (let t = 0; t < I.length; t += 3) {
    const ia = 3 * I[t];
    const ib = 3 * I[t + 1];
    const ic = 3 * I[t + 2];
    const a0 = P[ia] - p[0], a1 = P[ia + 1] - p[1], a2 = P[ia + 2] - p[2];
    const b0 = P[ib] - p[0], b1 = P[ib + 1] - p[1], b2 = P[ib + 2] - p[2];
    const c0 = P[ic] - p[0], c1 = P[ic + 1] - p[1], c2 = P[ic + 2] - p[2];
    const la = Math.sqrt(a0 * a0 + a1 * a1 + a2 * a2);
    const lb = Math.sqrt(b0 * b0 + b1 * b1 + b2 * b2);
    const lc = Math.sqrt(c0 * c0 + c1 * c1 + c2 * c2);
    const det = a0 * (b1 * c2 - b2 * c1) - a1 * (b0 * c2 - b2 * c0) + a2 * (b0 * c1 - b1 * c0);
    const div = la * lb * lc + (a0 * b0 + a1 * b1 + a2 * b2) * lc + (b0 * c0 + b1 * c1 + b2 * c2) * la + (c0 * a0 + c1 * a1 + c2 * a2) * lb;
    total += 2 * Math.atan2(det, div);
  }
  return total / (4 * Math.PI);
}

function segDist2(px: number, py: number, pz: number, ux: number, uy: number, uz: number, vx: number, vy: number, vz: number): number {
  const dx = vx - ux, dy = vy - uy, dz = vz - uz;
  const L = dx * dx + dy * dy + dz * dz;
  let t = L > 0 ? ((px - ux) * dx + (py - uy) * dy + (pz - uz) * dz) / L : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const wx = px - ux - dx * t, wy = py - uy - dy * t, wz = pz - uz - dz * t;
  return wx * wx + wy * wy + wz * wz;
}

/** Brute-force unsigned distance from p to a mesh: projection onto each triangle's plane, else the nearest edge. */
export function bruteDistance(m: MeshLike, p: Vec3): number {
  const P = m.positions;
  const I = m.indices;
  const [px, py, pz] = p;
  let best = Infinity;
  for (let t = 0; t < I.length; t += 3) {
    const ia = 3 * I[t], ib = 3 * I[t + 1], ic = 3 * I[t + 2];
    const ax = P[ia], ay = P[ia + 1], az = P[ia + 2];
    const bx = P[ib], by = P[ib + 1], bz = P[ib + 2];
    const cx = P[ic], cy = P[ic + 1], cz = P[ic + 2];
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az;
    const e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const nn = Math.sqrt(nx * nx + ny * ny + nz * nz);
    let d2 = Infinity;
    if (nn > 0) {
      nx /= nn; ny /= nn; nz /= nn;
      const s = (px - ax) * nx + (py - ay) * ny + (pz - az) * nz;
      if (s * s < best) {
        const qx = px - nx * s, qy = py - ny * s, qz = pz - nz * s;
        const side = (ux: number, uy: number, uz: number, vx: number, vy: number, vz: number): number => {
          const ex = vx - ux, ey = vy - uy, ez = vz - uz;
          const wx = qx - ux, wy = qy - uy, wz = qz - uz;
          return (ey * wz - ez * wy) * nx + (ez * wx - ex * wz) * ny + (ex * wy - ey * wx) * nz;
        };
        if (side(ax, ay, az, bx, by, bz) >= 0 && side(bx, by, bz, cx, cy, cz) >= 0 && side(cx, cy, cz, ax, ay, az) >= 0) d2 = s * s;
      } else continue;
    }
    if (d2 === Infinity) {
      d2 = Math.min(segDist2(px, py, pz, ax, ay, az, bx, by, bz), segDist2(px, py, pz, bx, by, bz, cx, cy, cz), segDist2(px, py, pz, cx, cy, cz, ax, ay, az));
    }
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

/** Brute-force signed distance of a closed mesh at p: min over all triangles, sign by winding number. */
export function bruteSdf(m: MeshLike, p: Vec3): number {
  const d = bruteDistance(m, p);
  return windingNumber(m, p) > 0.5 ? d : -d;
}

/** Best of `runs` wall-clock timings of fn, in ms. */
export function bestOf(runs: number, fn: () => void): number {
  let best = Infinity;
  for (let r = 0; r < runs; r++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** Distance from p to the segment ab. */
export function segmentDistance(p: Vec3, a: Vec3, b: Vec3): number {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const t = L > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * d[0] + (p[1] - a[1]) * d[1] + (p[2] - a[2]) * d[2]) / L)) : 0;
  return Math.hypot(p[0] - a[0] - t * d[0], p[1] - a[1] - t * d[1], p[2] - a[2] - t * d[2]);
}

/** Capsule field: radius r around the segment ab. */
export const capsuleF =
  (r: number, a: Vec3, b: Vec3): Implicit =>
  (x, y, z) =>
    r - segmentDistance([x, y, z], a, b);

/** A Y: a stem of radius 0.4 from (0, −1.6, 0) to the origin, two arms of radius 0.35 and length 1.4 at ±35° from +Y. */
export function yShapeF(): Implicit {
  const ang = (35 * Math.PI) / 180;
  const stem = capsuleF(0.4, [0, -1.6, 0], [0, 0, 0]);
  const armL = capsuleF(0.35, [0, 0, 0], [-1.4 * Math.sin(ang), 1.4 * Math.cos(ang), 0]);
  const armR = capsuleF(0.35, [0, 0, 0], [1.4 * Math.sin(ang), 1.4 * Math.cos(ang), 0]);
  return (x, y, z) => Math.max(stem(x, y, z), armL(x, y, z), armR(x, y, z));
}

/** A UV sphere whose vertices are scaled radially by 1 + (u − ½)·amp, u from mulberry32(seed) (a poor mesh). */
export function noisySphere(amp: number, seed: number, seg = 40, rings = 20): IndexedMesh {
  const m = uvSphere(1, seg, rings);
  const rng = mulberry32(seed);
  for (let v = 0; v < m.positions.length / 3; v++) {
    const s = 1 + (rng() - 0.5) * amp;
    for (let a = 0; a < 3; a++) m.positions[3 * v + a] *= s;
  }
  return m;
}

/** Great-circle distance on the sphere of radius r about the origin between the directions of p and q. */
export function greatCircle(r: number, p: ArrayLike<number>, q: ArrayLike<number>): number {
  const c = (p[0] * q[0] + p[1] * q[1] + p[2] * q[2]) / (Math.hypot(p[0], p[1], p[2]) * Math.hypot(q[0], q[1], q[2]));
  return r * Math.acos(Math.max(-1, Math.min(1, c)));
}
