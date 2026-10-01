// Track T5 — the working volume of the mesh tools (DESIGN.md §2.9.8): a float signed-distance field on a regular
// lattice, positive inside, in inches. Voxelize, sculpt, cut and merge all read and write this form; the stored
// asset form is the Step 0 `SdfVolume` (Int16, `core/kernel/geom/sdfVolume.ts`).
//
// Layout and placement are the ones of the Step 0 geometry kernels (docs/tracks/s0b-geom.md): sample (x, y, z)
// is `field[x + nx·(y + ny·z)]` and sits at the POINT `origin + voxel·(x, y, z)`.
import { decodeSdfVolume, encodeSdfVolume } from '../kernel/geom/sdfVolume';
import type { SdfVolume, Vec3 } from '../../types/geometry';

/** A signed-distance field in inches, positive inside, on the lattice `origin + voxel·(x, y, z)`. */
export interface FieldVolume {
  field: Float32Array<ArrayBuffer>;
  dims: [number, number, number];
  origin: Vec3;
  voxel: number;
}

/** Throws a RangeError for a volume whose buffer, dims, origin or voxel size do not fit together. */
export function checkVolume(v: FieldVolume): void {
  const { dims, origin, voxel, field } = v;
  if (!Array.isArray(dims) || dims.length !== 3 || !dims.every((n) => Number.isInteger(n) && n >= 1)) {
    throw new RangeError(`volume dims must be three integers >= 1, got ${String(dims)}`);
  }
  if (field.length !== dims[0] * dims[1] * dims[2]) {
    throw new RangeError(`volume has ${field.length} samples, expected ${dims[0] * dims[1] * dims[2]}`);
  }
  if (!Array.isArray(origin) || origin.length !== 3 || !origin.every((c) => Number.isFinite(c))) {
    throw new RangeError(`volume origin must be three finite numbers, got ${String(origin)}`);
  }
  if (!(voxel > 0) || !Number.isFinite(voxel)) throw new RangeError(`volume voxel must be a positive number, got ${voxel}`);
}

/** A deep copy (new buffer). */
export function cloneVolume(v: FieldVolume): FieldVolume {
  return { field: new Float32Array(v.field), dims: [v.dims[0], v.dims[1], v.dims[2]], origin: [v.origin[0], v.origin[1], v.origin[2]], voxel: v.voxel };
}

/** A stored `sdf:<meshRef>` volume as a working volume (§2.9.7: unedited reconstructed parts are not re-voxelized). */
export function volumeFromSdf(sdf: SdfVolume): FieldVolume {
  const field = decodeSdfVolume(sdf);
  return { field, dims: [sdf.dims[0], sdf.dims[1], sdf.dims[2]], origin: [sdf.origin[0], sdf.origin[1], sdf.origin[2]], voxel: sdf.voxel };
}

/** The asset form (Int16, voxel/256 units, saturating at ±128 voxels; the inside/outside samples are kept exactly). */
export function volumeToSdf(v: FieldVolume): SdfVolume {
  return encodeSdfVolume(v.field, v.dims, v.origin, v.voxel);
}

/**
 * Trilinear value at the point (x, y, z) of the volume's frame. Outside the lattice box: the value at the nearest
 * box point minus the distance to it (the rule of `sampleSdfVolume`), so a volume reads as "outside" beyond its
 * box. NaN in → NaN out.
 */
export function sampleVolume(v: FieldVolume, x: number, y: number, z: number): number {
  const { field, dims, origin, voxel } = v;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  let gx = (x - origin[0]) / voxel;
  let gy = (y - origin[1]) / voxel;
  let gz = (z - origin[2]) / voxel;
  if (gx !== gx || gy !== gy || gz !== gz) return NaN;
  let gap2 = 0;
  if (gx < 0) {
    gap2 += gx * gx;
    gx = 0;
  } else if (gx > nx - 1) {
    gap2 += (gx - nx + 1) * (gx - nx + 1);
    gx = nx - 1;
  }
  if (gy < 0) {
    gap2 += gy * gy;
    gy = 0;
  } else if (gy > ny - 1) {
    gap2 += (gy - ny + 1) * (gy - ny + 1);
    gy = ny - 1;
  }
  if (gz < 0) {
    gap2 += gz * gz;
    gz = 0;
  } else if (gz > nz - 1) {
    gap2 += (gz - nz + 1) * (gz - nz + 1);
    gz = nz - 1;
  }
  const x0 = Math.min(Math.floor(gx), Math.max(0, nx - 2));
  const y0 = Math.min(Math.floor(gy), Math.max(0, ny - 2));
  const z0 = Math.min(Math.floor(gz), Math.max(0, nz - 2));
  const x1 = Math.min(x0 + 1, nx - 1);
  const y1 = Math.min(y0 + 1, ny - 1);
  const z1 = Math.min(z0 + 1, nz - 1);
  const tx = gx - x0;
  const ty = gy - y0;
  const tz = gz - z0;
  const sxy = nx * ny;
  const a = (xi: number, yi: number, zi: number): number => field[xi + nx * yi + sxy * zi];
  const c00 = a(x0, y0, z0) + (a(x1, y0, z0) - a(x0, y0, z0)) * tx;
  const c10 = a(x0, y1, z0) + (a(x1, y1, z0) - a(x0, y1, z0)) * tx;
  const c01 = a(x0, y0, z1) + (a(x1, y0, z1) - a(x0, y0, z1)) * tx;
  const c11 = a(x0, y1, z1) + (a(x1, y1, z1) - a(x0, y1, z1)) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  const value = c0 + (c1 - c0) * tz;
  return gap2 > 0 ? value - Math.sqrt(gap2) * voxel : value;
}

/**
 * The volume grown by `pad` samples on every side (room to inflate a stored volume that was cropped to its bbox +
 * 2 voxels). New samples get the value of the nearest old box point minus the distance to it (`sampleVolume`'s
 * rule), so the surface and every old sample are unchanged.
 */
export function padVolume(v: FieldVolume, pad: number): FieldVolume {
  checkVolume(v);
  if (!Number.isInteger(pad) || pad < 0) throw new RangeError(`pad must be an integer >= 0, got ${pad}`);
  if (pad === 0) return cloneVolume(v);
  const [nx, ny, nz] = v.dims;
  const mx = nx + 2 * pad;
  const my = ny + 2 * pad;
  const mz = nz + 2 * pad;
  const field = new Float32Array(mx * my * mz);
  const origin: Vec3 = [v.origin[0] - pad * v.voxel, v.origin[1] - pad * v.voxel, v.origin[2] - pad * v.voxel];
  let i = 0;
  for (let z = 0; z < mz; z++) {
    const oz = Math.min(nz - 1, Math.max(0, z - pad));
    const dz = z - pad - oz;
    for (let y = 0; y < my; y++) {
      const oy = Math.min(ny - 1, Math.max(0, y - pad));
      const dy = y - pad - oy;
      for (let x = 0; x < mx; x++, i++) {
        const ox = Math.min(nx - 1, Math.max(0, x - pad));
        const dx = x - pad - ox;
        const base = v.field[ox + nx * (oy + ny * oz)];
        field[i] = dx === 0 && dy === 0 && dz === 0 ? base : base - Math.sqrt(dx * dx + dy * dy + dz * dz) * v.voxel;
      }
    }
  }
  return { field, dims: [mx, my, mz], origin, voxel: v.voxel };
}

/** Volume of the inside, in³, by counting samples ≥ 0 (a quick, coarse measure; meshes use `signedVolume`). */
export function insideSampleVolume(v: FieldVolume): number {
  let n = 0;
  for (let i = 0; i < v.field.length; i++) if (v.field[i] >= 0) n++;
  return n * v.voxel * v.voxel * v.voxel;
}

/** True when at least one sample is inside (≥ 0, the marching-cubes rule). */
export function hasInside(v: FieldVolume): boolean {
  for (let i = 0; i < v.field.length; i++) if (v.field[i] >= 0) return true;
  return false;
}

/** Errors the mesh tools raise for a request they refuse (comlink keeps `name` and `message` across the worker). */
export class MeshToolError extends Error {
  readonly code: MeshToolErrorCode;
  constructor(code: MeshToolErrorCode, message: string) {
    super(message);
    this.name = 'MeshToolError';
    this.code = code;
  }
}

export type MeshToolErrorCode =
  | 'too-few-parts'
  | 'not-touching'
  | 'bridge-failed'
  | 'empty-result'
  | 'cut-misses'
  | 'not-a-primitive'
  | 'bad-mesh'
  | 'undo-order'
  | 'unknown-undo';
