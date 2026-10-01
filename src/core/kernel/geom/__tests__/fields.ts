// Synthetic fields for the geometry kernel tests (not a test file). Everything is analytic and deterministic.
//
// All fields are POSITIVE INSIDE (D11) and are sampled on an n³ lattice whose samples span the cube
// [−HALF, HALF]³: sample (x, y, z) is at −HALF + voxel·(x, y, z) with voxel = 2·HALF/(n − 1). The scene is the
// one of research 04 §11: a sphere of radius 0.8 and a "teddy" of nine axis-aligned ellipsoids in
// [−1.1, 1.1]³.
//
// The fields use only +, −, ×, ÷ and Math.sqrt (no `**`, no Math.hypot, whose results an engine may round as it
// likes), so the vertex counts and index hashes that the tests pin are the same on every conforming engine.
import type { Vec3 } from '../../../../types/geometry';
import type { MeshLike } from '../meshMeasures';

export const HALF = 1.1;

export type Implicit = (x: number, y: number, z: number) => number;

export interface SampledField {
  field: Float32Array<ArrayBuffer>;
  dims: [number, number, number];
  origin: Vec3;
  voxel: number;
}

/** Samples `f` on the n³ lattice over [−HALF, HALF]³ (x fastest). */
export function sampleField(n: number, f: Implicit, half = HALF): SampledField {
  const field = new Float32Array(n * n * n);
  const voxel = (2 * half) / (n - 1);
  let i = 0;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) field[i++] = f(-half + voxel * x, -half + voxel * y, -half + voxel * z);
    }
  }
  return { field, dims: [n, n, n], origin: [-half, -half, -half], voxel };
}

/** Exact signed distance of a sphere. */
export function sphere(r: number, c: Vec3 = [0, 0, 0]): Implicit {
  return (x, y, z) => {
    const dx = x - c[0];
    const dy = y - c[1];
    const dz = z - c[2];
    return r - Math.sqrt(dx * dx + dy * dy + dz * dz);
  };
}

export const sphereVolume = (r: number): number => (4 / 3) * Math.PI * r * r * r;

/** An axis-aligned ellipsoid: positive inside, close to a distance near the surface (not an exact distance). */
export function ellipsoid(c: Vec3, r: Vec3): Implicit {
  const scale = Math.min(r[0], r[1], r[2]);
  return (x, y, z) => {
    const u = (x - c[0]) / r[0];
    const v = (y - c[1]) / r[1];
    const w = (z - c[2]) / r[2];
    return scale * (1 - Math.sqrt(u * u + v * v + w * w));
  };
}

/** Union of implicit solids (positive inside ⇒ maximum). */
export function union(...parts: Implicit[]): Implicit {
  return (x, y, z) => {
    let best = -Infinity;
    for (const p of parts) best = Math.max(best, p(x, y, z));
    return best;
  };
}

/** Body, head, two ears, snout, two arms, two legs: one piece, genus 0, +Y up, front +Z. */
export const TEDDY_PARTS: { c: Vec3; r: Vec3 }[] = [
  { c: [0, -0.35, 0], r: [0.45, 0.5, 0.4] },
  { c: [0, 0.45, 0], r: [0.4, 0.38, 0.38] },
  { c: [0.3, 0.82, 0], r: [0.14, 0.14, 0.08] },
  { c: [-0.3, 0.82, 0], r: [0.14, 0.14, 0.08] },
  { c: [0, 0.38, 0.36], r: [0.16, 0.13, 0.14] },
  { c: [0.5, -0.2, 0], r: [0.3, 0.13, 0.13] },
  { c: [-0.5, -0.2, 0], r: [0.3, 0.13, 0.13] },
  { c: [0.22, -0.85, 0.05], r: [0.16, 0.22, 0.18] },
  { c: [-0.22, -0.85, 0.05], r: [0.16, 0.22, 0.18] },
];

export const teddy: Implicit = union(...TEDDY_PARTS.map((p) => ellipsoid(p.c, p.r)));

/** Exact signed distance of a torus around the Y axis: ring radius R, tube radius r. */
export function torus(R: number, r: number): Implicit {
  return (x, y, z) => {
    const ring = Math.sqrt(x * x + z * z) - R;
    return r - Math.sqrt(ring * ring + y * y);
  };
}

export const torusVolume = (R: number, r: number): number => 2 * Math.PI * Math.PI * R * r * r;

/** Two spheres that do not touch. */
export const twoSpheres: Implicit = union(sphere(0.35, [-0.5, 0, 0]), sphere(0.3, [0.5, 0.1, 0]));

/**
 * The triangles of a mesh as sorted strings, for comparing two meshes whatever their vertex numbering and
 * triangle order: each triangle is rotated so its smallest corner comes first (winding kept).
 */
export function triangleKeys(mesh: MeshLike): string[] {
  const p = mesh.positions;
  const corner = (v: number): string => `${p[3 * v]},${p[3 * v + 1]},${p[3 * v + 2]}`;
  const keys: string[] = [];
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const c = [corner(mesh.indices[t]), corner(mesh.indices[t + 1]), corner(mesh.indices[t + 2])];
    let first = 0;
    if (c[1] < c[first]) first = 1;
    if (c[2] < c[first]) first = 2;
    keys.push(`${c[first]} | ${c[(first + 1) % 3]} | ${c[(first + 2) % 3]}`);
  }
  return keys.sort();
}

/** Prints a measurement when the suite runs with GEOM_VERBOSE=1 (`GEOM_VERBOSE=1 npm test -- …`); silent otherwise. */
export function note(text: string): void {
  if (process.env.GEOM_VERBOSE === '1') console.log(text);
}
