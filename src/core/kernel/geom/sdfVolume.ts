// The stored signed-distance volume of a mesh part (DESIGN.md §2.9.7 step 3, §2.9.8; type `SdfVolume`, §5.2).
// Step 0 kernel: pure, no DOM.
//
// The frozen type says: Int16 data in voxel/256 units, positive inside, with `dims`, `origin` and `voxel`
// (inches). It does not say where the samples are, so this file fixes that for every track:
//
//   - `data[x + nx·(y + ny·z)]` is the sample with lattice index (x, y, z): x runs fastest.
//   - Sample (x, y, z) is the POINT `origin + voxel·(x, y, z)`: `origin` is the position of sample (0, 0, 0),
//     not the corner of a cell. The lattice covers the box from `origin` to `origin + voxel·(dims − 1)`.
//   - A stored value `v` is the signed distance `v / 256` voxels = `v·voxel / 256` inches; positive inside.
//     Int16 holds ±127.996 voxels; the encoder saturates beyond that (far-field values lose magnitude, never
//     sign).
//
// The same layout and the same "sample = point" rule are used by the marching cubes of ./marchingCubes.ts.
import type { SdfVolume, Vec3 } from '../../../types/geometry';

/** Stored units per voxel: a stored value of 256 is one voxel of distance (§5.2 `SdfVolume`). */
export const SDF_UNITS_PER_VOXEL = 256;

const INT16_MAX = 32767;
const INT16_MIN = -32768;

function checkGrid(length: number, dims: readonly [number, number, number], origin: Readonly<Vec3>, voxel: number): void {
  if (dims.length !== 3 || !dims.every((n) => Number.isInteger(n) && n >= 1)) {
    throw new RangeError(`grid dimensions must be three integers >= 1, got [${dims.join(', ')}]`);
  }
  if (length !== dims[0] * dims[1] * dims[2]) {
    throw new RangeError(`field has ${length} samples, expected ${dims[0]}×${dims[1]}×${dims[2]} = ${dims[0] * dims[1] * dims[2]}`);
  }
  if (origin.length !== 3 || !origin.every((v) => Number.isFinite(v))) {
    throw new RangeError(`origin must be three finite numbers, got [${origin.join(', ')}]`);
  }
  if (!(voxel > 0) || !Number.isFinite(voxel)) throw new RangeError(`voxel size must be a positive number, got ${voxel}`);
}

/**
 * Quantizes a signed-distance field given in world units (inches) to the stored Int16 form.
 *
 * Values are rounded to the nearest unit, halves away from zero. The side of every sample survives: a
 * negative value never becomes 0 (it is −1 at least), and 0 and positive values stay ≥ 0 — so the stored
 * volume has exactly the same inside/outside samples as the field under the marching-cubes rule "a sample at
 * the level is inside". Values beyond ±127.996 voxels saturate; +Infinity and −Infinity saturate too. NaN is
 * not a distance and throws.
 */
export function encodeSdfVolume(
  field: ArrayLike<number>,
  dims: readonly [number, number, number],
  origin: Readonly<Vec3>,
  voxel: number,
): SdfVolume {
  checkGrid(field.length, dims, origin, voxel);
  const data = new Int16Array(field.length);
  const scale = SDF_UNITS_PER_VOXEL / voxel;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (v !== v) throw new RangeError(`encodeSdfVolume: sample ${i} is NaN`);
    if (v < 0) {
      const units = Math.floor(-v * scale + 0.5);
      data[i] = units < 1 ? -1 : units > -INT16_MIN ? INT16_MIN : -units;
    } else {
      const units = Math.floor(v * scale + 0.5);
      data[i] = units > INT16_MAX ? INT16_MAX : units;
    }
  }
  return { data, dims: [dims[0], dims[1], dims[2]], origin: [origin[0], origin[1], origin[2]], voxel };
}

/** The stored volume as signed distances in world units (inches), same layout as `volume.data`. */
export function decodeSdfVolume(volume: SdfVolume): Float32Array<ArrayBuffer> {
  checkGrid(volume.data.length, volume.dims, volume.origin, volume.voxel);
  const out = new Float32Array(volume.data.length);
  const scale = volume.voxel / SDF_UNITS_PER_VOXEL;
  for (let i = 0; i < out.length; i++) out[i] = volume.data[i] * scale;
  return out;
}

/**
 * The signed distance (inches, positive inside) at point `p`, given in the frame of `volume.origin`: trilinear
 * interpolation between the eight samples around `p`.
 *
 * Outside the lattice box the result is the value at the nearest point of the box minus the distance to that
 * point. A distance field cannot fall faster than that, so this is the lowest value consistent with the
 * stored samples: a volume cropped around its part (bbox + 2 voxels, §2.9.7) is outside (negative) everywhere
 * beyond its box, and gets more negative with distance.
 */
export function sampleSdfVolume(volume: SdfVolume, p: Readonly<Vec3>): number {
  const { data, dims, origin, voxel } = volume;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  // Lattice coordinates, clamped to the box; `gap2` collects the squared distance (in voxels) to the box.
  let gap2 = 0;
  let gx = (p[0] - origin[0]) / voxel;
  let gy = (p[1] - origin[1]) / voxel;
  let gz = (p[2] - origin[2]) / voxel;
  if (gx !== gx || gy !== gy || gz !== gz) return NaN;
  if (gx < 0) {
    gap2 += gx * gx;
    gx = 0;
  } else if (gx > nx - 1) {
    gap2 += (gx - (nx - 1)) * (gx - (nx - 1));
    gx = nx - 1;
  }
  if (gy < 0) {
    gap2 += gy * gy;
    gy = 0;
  } else if (gy > ny - 1) {
    gap2 += (gy - (ny - 1)) * (gy - (ny - 1));
    gy = ny - 1;
  }
  if (gz < 0) {
    gap2 += gz * gz;
    gz = 0;
  } else if (gz > nz - 1) {
    gap2 += (gz - (nz - 1)) * (gz - (nz - 1));
    gz = nz - 1;
  }
  // Lower cell corner; on the upper face of the box the cell is the last one and the weight is 1.
  const x0 = nx > 1 ? Math.min(Math.floor(gx), nx - 2) : 0;
  const y0 = ny > 1 ? Math.min(Math.floor(gy), ny - 2) : 0;
  const z0 = nz > 1 ? Math.min(Math.floor(gz), nz - 2) : 0;
  const tx = gx - x0;
  const ty = gy - y0;
  const tz = gz - z0;
  const dx = nx > 1 ? 1 : 0;
  const dy = ny > 1 ? nx : 0;
  const dz = nz > 1 ? nx * ny : 0;
  const i = x0 + nx * (y0 + ny * z0);
  const c00 = data[i] + (data[i + dx] - data[i]) * tx;
  const c10 = data[i + dy] + (data[i + dy + dx] - data[i + dy]) * tx;
  const c01 = data[i + dz] + (data[i + dz + dx] - data[i + dz]) * tx;
  const c11 = data[i + dz + dy] + (data[i + dz + dy + dx] - data[i + dz + dy]) * tx;
  const c0 = c00 + (c10 - c00) * ty;
  const c1 = c01 + (c11 - c01) * ty;
  const voxels = (c0 + (c1 - c0) * tz) / SDF_UNITS_PER_VOXEL - Math.sqrt(gap2);
  return voxels * voxel;
}
