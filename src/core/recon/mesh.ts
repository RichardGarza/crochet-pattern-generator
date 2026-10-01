// Track T3 — volume clean-up, meshing, smoothing and validation (DESIGN.md §2.9.5, research 04 §6).
//
// 1. `cleanVolume`: optional closing (`mergeTouching`), keep the largest 6-connected inside component, fill
//    enclosed cavities (the outside flooded 6-connected from the lattice border, matching the mesher, whose inside
//    is 18-connected and whose border is closed). Inside = `f ≥ 0` or +∞ (the marching cubes rule: exact zeros
//    count as inside; NaN is outside). The mesh of a cleaned volume is then one piece: pieces = 18-connected inside
//    components + 6-connected outside components − 1 = 1 + 1 − 1 (Step 0 notes).
// 2. Marching cubes (Step 0 kernel, closed border) on the field itself, not on an occupancy, for sub-voxel
//    silhouettes.
// 3. Taubin λ|μ, 10 pairs (Step 0 kernel).
// 4. Decimation: simplify.ts.
// 5. Validation through the Step 0 `manifoldFromMesh` (never `new Manifold(mesh)` in a try): status NoError, the
//    largest part kept, genus, volume > 0; thin features flagged ("crochet flat").
// 6. Inches: lowest point y = 0, +Y up, front +Z, scaled to the target height.
import { edt3d } from '../kernel/geom/edt';
import { manifoldFromMesh } from '../kernel/geom/manifold';
import { marchingCubes, type IndexedMesh } from '../kernel/geom/marchingCubes';
import { meshBounds, signedVolume } from '../kernel/geom/meshMeasures';
import { taubinSmooth } from '../kernel/geom/taubin';
import type { Vec3 } from '../../types/geometry';
import type { ReconGrid } from './align';

/** A sample is inside when f ≥ 0 or f = +∞ (NaN and −∞ are outside), as in marching cubes. */
const isInside = (v: number): boolean => v >= 0;

/** The smallest |value| written by `cleanVolume` when it flips a sample, in voxels (never an exact zero). */
const FLIP_MIN = 1e-3;

/** "Merge touching parts" (§2.9.5 step 1): closing radius as a fraction of the lattice side (2 voxels at N = 128). */
export const MERGE_TOUCHING_FRACTION = 2 / 127;

export interface CleanReport {
  /** Inside samples after clean-up. */
  inside: number;
  /** Inside samples dropped with the smaller components. */
  removed: number;
  /** Number of inside components before clean-up (6-connected). */
  components: number;
  /** Outside samples filled as enclosed cavities. */
  filled: number;
  /** Samples made inside by the closing (`mergeTouching`). */
  closed: number;
}

/** 6-connected labels of the samples where `member[i]` is 1; returns the sizes (label k − 1 at index k − 1). */
function components6(member: Uint8Array, N: number, labels: Int32Array): number[] {
  const NN = N * N;
  const total = NN * N;
  const sizes: number[] = [];
  const queue = new Int32Array(total);
  labels.fill(0);
  for (let s = 0; s < total; s++) {
    if (!member[s] || labels[s]) continue;
    const label = sizes.length + 1;
    let head = 0;
    let tail = 0;
    queue[tail++] = s;
    labels[s] = label;
    const visit = (j: number): void => {
      if (member[j] && !labels[j]) {
        labels[j] = label;
        queue[tail++] = j;
      }
    };
    while (head < tail) {
      const i = queue[head++];
      const x = i % N;
      const y = ((i - x) / N) % N;
      const z = (i - x - N * y) / NN;
      if (x > 0) visit(i - 1);
      if (x < N - 1) visit(i + 1);
      if (y > 0) visit(i - N);
      if (y < N - 1) visit(i + N);
      if (z > 0) visit(i - NN);
      if (z < N - 1) visit(i + NN);
    }
    sizes.push(tail);
  }
  return sizes;
}

/**
 * §2.9.5 step 1 on an N³ field (positive inside), in place. `voxel` = the sample spacing (world units).
 * `mergeTouching`: morphological closing of the inside with a ball of radius `MERGE_TOUCHING_FRACTION·(N − 1)`
 * voxels (at least 1) first, so parts that touch in the photos become one (exact EDTs; closed samples get a small
 * positive value). Then the largest 6-connected inside component is kept (ties: the first in scan order); the
 * others become outside (−|f|). Enclosed outside regions become inside (|f|).
 */
export function cleanVolume(field: Float32Array, N: number, voxel: number, o: { mergeTouching?: boolean } = {}): CleanReport {
  const total = N * N * N;
  if (field.length !== total) throw new RangeError(`field has ${field.length} samples, expected ${total}`);
  if (!(voxel > 0) || !Number.isFinite(voxel)) throw new RangeError(`voxel must be a finite number > 0, got ${voxel}`);
  const tiny = FLIP_MIN * voxel;
  const member = new Uint8Array(total);
  for (let i = 0; i < total; i++) member[i] = isInside(field[i]) ? 1 : 0;

  let closed = 0;
  if (o.mergeTouching) {
    const r = Math.max(1, MERGE_TOUCHING_FRACTION * (N - 1));
    const toInside = edt3d(member, [N, N, N]); // voxels to the nearest inside sample
    const dilatedOut = new Uint8Array(total);
    for (let i = 0; i < total; i++) dilatedOut[i] = toInside[i] <= r ? 0 : 1;
    const toOut = edt3d(dilatedOut, [N, N, N]); // voxels to the nearest sample outside the dilation
    for (let i = 0; i < total; i++) {
      if (member[i] || toOut[i] <= r) continue;
      member[i] = 1;
      field[i] = Math.max(tiny, 0.5 * voxel * Math.min(1, toOut[i] - r));
      closed++;
    }
  }

  const labels = new Int32Array(total);
  const sizes = components6(member, N, labels);
  let keep = 0;
  for (let k = 1; k < sizes.length; k++) if (sizes[k] > sizes[keep]) keep = k;
  let removed = 0;
  for (let i = 0; i < total; i++) {
    if (member[i] && labels[i] !== keep + 1) {
      member[i] = 0;
      const v = field[i];
      field[i] = Number.isFinite(v) ? -Math.max(Math.abs(v), tiny) : -voxel;
      removed++;
    }
  }

  // Cavities: outside samples not 6-connected to the lattice border through outside samples.
  const outside = new Uint8Array(total);
  for (let i = 0; i < total; i++) outside[i] = member[i] ? 0 : 1;
  const outLabels = labels; // reuse
  const outSizes = components6(outside, N, outLabels);
  const reaches = new Uint8Array(outSizes.length + 1);
  const NN = N * N;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (x !== 0 && x !== N - 1 && y !== 0 && y !== N - 1 && z !== 0 && z !== N - 1) continue;
        reaches[outLabels[x + N * y + NN * z]] = 1;
      }
    }
  }
  let filled = 0;
  for (let i = 0; i < total; i++) {
    if (outside[i] && !reaches[outLabels[i]]) {
      const v = field[i];
      field[i] = Number.isFinite(v) ? Math.max(Math.abs(v), tiny) : voxel;
      filled++;
    }
  }
  const inside = (sizes.length > 0 ? sizes[keep] : 0) + filled;
  return { inside, removed, components: sizes.length, filled, closed };
}

/**
 * Inside samples (`f ≥ 0`) that an opening with the 6-neighbor cross removes: parts at most 2 samples thick
 * ("crochet flat", §2.9.5 step 5). Returns the count and a 0/1 mask.
 */
export function thinSamples(field: ArrayLike<number>, N: number): { count: number; mask: Uint8Array<ArrayBuffer> } {
  const NN = N * N;
  const total = NN * N;
  const inside = (i: number): boolean => isInside(field[i]);
  const eroded = new Uint8Array(total);
  for (let z = 1; z < N - 1; z++) {
    for (let y = 1; y < N - 1; y++) {
      for (let x = 1; x < N - 1; x++) {
        const i = x + N * y + NN * z;
        if (inside(i) && inside(i - 1) && inside(i + 1) && inside(i - N) && inside(i + N) && inside(i - NN) && inside(i + NN)) eroded[i] = 1;
      }
    }
  }
  const mask = new Uint8Array(total);
  let count = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const i = x + N * y + NN * z;
        if (!inside(i) || eroded[i]) continue;
        const kept =
          (x > 0 && eroded[i - 1]) ||
          (x < N - 1 && eroded[i + 1]) ||
          (y > 0 && eroded[i - N]) ||
          (y < N - 1 && eroded[i + N]) ||
          (z > 0 && eroded[i - NN]) ||
          (z < N - 1 && eroded[i + NN]);
        if (!kept) {
          mask[i] = 1;
          count++;
        }
      }
    }
  }
  return { count, mask };
}

/** Marching cubes (closed border) + Taubin, 10 pairs (§2.9.5 steps 2–3), in grid world units. */
export function meshField(field: ArrayLike<number>, grid: ReconGrid, o: { taubinPairs?: number } = {}): IndexedMesh {
  const { N, origin, voxel } = grid;
  const mesh = marchingCubes(field, [N, N, N], { origin, voxel });
  if (mesh.indices.length > 0 && (o.taubinPairs ?? 10) > 0) taubinSmooth(mesh.positions, mesh.indices, { pairs: o.taubinPairs ?? 10 });
  return mesh;
}

/** A similarity in place: p ← (p − shift)·scale. */
export function transformPositions(positions: Float32Array, shift: Readonly<Vec3>, scale: number): void {
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = (positions[i] - shift[0]) * scale;
    positions[i + 1] = (positions[i + 1] - shift[1]) * scale;
    positions[i + 2] = (positions[i + 2] - shift[2]) * scale;
  }
}

/** The result of `validateMesh`. */
export interface MeshValidation {
  status: string;
  /** Parts manifold-3d found before the largest was kept. */
  parts: number;
  /** Genus of the kept part. */
  genus: number;
  /** Volume of the kept mesh (> 0 for a valid one). */
  volume: number;
  /** The kept mesh: the input itself when it is one part, else the largest part (re-indexed by manifold-3d). */
  mesh: IndexedMesh;
}

/**
 * §2.9.5 step 5 through the Step 0 `manifoldFromMesh`: the status, `decompose()` → the largest part by volume,
 * its genus and volume. Every WASM object is freed.
 */
export async function validateMesh(mesh: IndexedMesh): Promise<MeshValidation> {
  const built = await manifoldFromMesh(mesh);
  if (built.status !== 'NoError') return { status: built.status, parts: 0, genus: 0, volume: 0, mesh };
  const { solid } = built;
  try {
    const pieces = solid.decompose();
    try {
      let best = -1;
      let bestVolume = -Infinity;
      pieces.forEach((p, k) => {
        const v = p.volume();
        if (v > bestVolume) {
          bestVolume = v;
          best = k;
        }
      });
      if (best < 0) return { status: 'NoError', parts: 0, genus: 0, volume: 0, mesh };
      const genus = pieces[best].genus();
      if (pieces.length === 1) return { status: 'NoError', parts: 1, genus, volume: signedVolume(mesh), mesh };
      const out = pieces[best].getMesh();
      const positions = new Float32Array(out.numVert * 3);
      for (let v = 0; v < out.numVert; v++) {
        positions[3 * v] = out.vertProperties[v * out.numProp];
        positions[3 * v + 1] = out.vertProperties[v * out.numProp + 1];
        positions[3 * v + 2] = out.vertProperties[v * out.numProp + 2];
      }
      const kept: IndexedMesh = { positions, indices: Uint32Array.from(out.triVerts) };
      return { status: 'NoError', parts: pieces.length, genus, volume: signedVolume(kept), mesh: kept };
    } finally {
      for (const p of pieces) p.delete();
    }
  } finally {
    solid.delete();
  }
}

/** Bounds of a mesh as [min, max] and its center. */
export function boundsOf(positions: ArrayLike<number>): { min: Vec3; max: Vec3; center: Vec3; size: Vec3 } {
  const { min, max } = meshBounds(positions);
  return {
    min,
    max,
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}
