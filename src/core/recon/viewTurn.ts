// Track T3 — the single-photo view turn (DESIGN.md §2.9.3).
//
// A single image is built in the PHOTO frame: image right → x', image up → y', toward the camera → z'. The volume is
// then turned into the object frame (+Y up, front +Z, the object's own left +X) by the view the user chose in F3
// step 1 (`ReconSettings.photoView`), following the §2.9.2 conventions:
//
//   front  identity                                   (x', y', z') → ( x',  y',  z')
//   left   R_y(+90°), camera at +X                    (x', y', z') → ( z',  y', −x')
//   right  R_y(−90°), camera at −X                    (x', y', z') → (−z',  y',  x')
//   top    R_x(−90°), camera at +Y, front at bottom   (x', y', z') → ( x',  z', −y')
//
// On a lattice these are exact axis permutations with flips: sample values move, nothing is resampled. A flipped
// axis keeps the lattice exact by moving its origin (the sample at index m along a flipped axis of n samples goes to
// index n − 1 − m, and the new origin is −(origin + voxel·(n − 1))).
import type { ReconSettings, Vec3 } from '../../types/geometry';
import type { SignedAxis } from './align';

export type PhotoViewChoice = ReconSettings['photoView'];

/** Per object axis (X, Y, Z): which photo axis it takes, with which sign — object[i] = sign·photo[axis]. */
export type ViewTurn = readonly [SignedAxis, SignedAxis, SignedAxis];

const ax = (axis: 0 | 1 | 2, sign: 1 | -1): SignedAxis => ({ axis, sign });

/** §2.9.3: the turn of each single-photo view choice. */
export const VIEW_TURNS: Readonly<Record<PhotoViewChoice, ViewTurn>> = Object.freeze({
  front: [ax(0, 1), ax(1, 1), ax(2, 1)],
  left: [ax(2, 1), ax(1, 1), ax(0, -1)],
  right: [ax(2, -1), ax(1, 1), ax(0, 1)],
  top: [ax(0, 1), ax(2, 1), ax(1, -1)],
});

function turnOf(view: PhotoViewChoice): ViewTurn {
  if (typeof view !== 'string' || !Object.hasOwn(VIEW_TURNS, view)) throw new RangeError(`unknown photo view ${JSON.stringify(view)}`);
  return VIEW_TURNS[view];
}

/** A photo-frame point → the object frame. */
export function turnPoint(p: Readonly<Vec3>, view: PhotoViewChoice): Vec3 {
  const t = turnOf(view);
  return [t[0].sign * p[t[0].axis], t[1].sign * p[t[1].axis], t[2].sign * p[t[2].axis]];
}

/** An object-frame point → the photo frame (the inverse turn). */
export function unturnPoint(p: Readonly<Vec3>, view: PhotoViewChoice): Vec3 {
  const t = turnOf(view);
  const out: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) out[t[i].axis] = t[i].sign * p[i];
  return out;
}

/** A sampled volume: sample (x, y, z) at `origin + voxel·(x, y, z)`, x fastest (Step 0 convention). */
export interface LatticeVolume<T extends ArrayLike<number> = Float32Array<ArrayBuffer>> {
  data: T;
  dims: readonly [number, number, number];
  origin: Vec3;
  voxel: number;
}

/**
 * Turns a photo-frame volume into the object frame (§2.9.3): an exact permutation of the samples with flips; the
 * returned lattice (dims, origin) is the turned one. The input is not modified.
 */
export function turnVolume(vol: LatticeVolume, view: PhotoViewChoice): LatticeVolume {
  const t = turnOf(view);
  const [nx, ny, nz] = vol.dims;
  if (vol.data.length !== nx * ny * nz) throw new RangeError(`volume has ${vol.data.length} samples, expected ${nx * ny * nz}`);
  const n = [nx, ny, nz];
  const dims = [n[t[0].axis], n[t[1].axis], n[t[2].axis]] as [number, number, number];
  const origin: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const a = t[i].axis;
    origin[i] = t[i].sign > 0 ? vol.origin[a] : -(vol.origin[a] + vol.voxel * (n[a] - 1));
  }
  // Output index along object axis i from the photo index m along axis t[i].axis.
  const strideOut = [1, dims[0], dims[0] * dims[1]];
  // For each photo axis a: (output stride, flip) of the object axis that takes it.
  const map: { stride: number; flip: boolean; n: number }[] = [];
  for (let i = 0; i < 3; i++) map[t[i].axis] = { stride: strideOut[i], flip: t[i].sign < 0, n: n[t[i].axis] };
  const out = new Float32Array(vol.data.length);
  const off = (a: number, m: number): number => map[a].stride * (map[a].flip ? map[a].n - 1 - m : m);
  for (let z = 0; z < nz; z++) {
    const oz = off(2, z);
    for (let y = 0; y < ny; y++) {
      const oyz = oz + off(1, y);
      const row = nx * (y + ny * z);
      for (let x = 0; x < nx; x++) out[oyz + off(0, x)] = vol.data[row + x];
    }
  }
  return { data: out, dims, origin, voxel: vol.voxel };
}
