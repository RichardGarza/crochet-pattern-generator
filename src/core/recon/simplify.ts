// Track T3 — moderate decimation (DESIGN.md §2.9.5 step 4, research 04 §6.4): meshoptimizer `simplify` with
// `Regularize`, at most 3× fewer triangles, toward a mean edge of about min(w, h)/3 of the stitch cell (doc 03's
// Path B wants that density). The result must stay a closed oriented 2-manifold without degenerate triangles;
// otherwise the input is returned unchanged (research 04 §6.4 saw non-manifold edges at high ratios).
import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import type { IndexedMesh } from '../kernel/geom/marchingCubes';
import { countNonManifoldVertices, countZeroAreaTriangles, isWatertight } from '../kernel/geom/meshMeasures';

/** §2.9.5 step 4: decimate at most this many times. */
export const MAX_DECIMATION = 3;

/** Mean edge length of a triangle mesh (each triangle's three edges; shared edges count twice, like the mean). */
export function meanEdgeLength(mesh: IndexedMesh): number {
  const { positions: p, indices: t } = mesh;
  let sum = 0;
  for (let k = 0; k < t.length; k += 3) {
    for (let e = 0; e < 3; e++) {
      const a = 3 * t[k + e];
      const b = 3 * t[k + ((e + 1) % 3)];
      sum += Math.hypot(p[a] - p[b], p[a + 1] - p[b + 1], p[a + 2] - p[b + 2]);
    }
  }
  return t.length > 0 ? sum / t.length : 0;
}

/** Drops unused vertices and renumbers the indices in first-use order (deterministic). */
export function compactMesh(positions: ArrayLike<number>, indices: ArrayLike<number>): IndexedMesh {
  const remap = new Int32Array(positions.length / 3).fill(-1);
  let next = 0;
  const out = new Uint32Array(indices.length);
  for (let k = 0; k < indices.length; k++) {
    const v = indices[k];
    if (remap[v] < 0) remap[v] = next++;
    out[k] = remap[v];
  }
  const pos = new Float32Array(next * 3);
  for (let v = 0; v < remap.length; v++) {
    const r = remap[v];
    if (r < 0) continue;
    pos[3 * r] = positions[3 * v];
    pos[3 * r + 1] = positions[3 * v + 1];
    pos[3 * r + 2] = positions[3 * v + 2];
  }
  return { positions: pos, indices: out };
}

export interface DecimateResult {
  mesh: IndexedMesh;
  /** Triangles before / after. */
  before: number;
  after: number;
  /** Why nothing changed: 'dense-enough' (edges already ≥ target), 'rejected' (the result was not watertight). */
  skipped?: 'dense-enough' | 'rejected' | 'empty';
}

/**
 * Decimates toward a mean edge of `targetEdge` (same units as the positions), at most 3×. `maxError` = the largest
 * deviation allowed, absolute (default: half the mesh's mean edge). Returns the input when it is already coarse
 * enough or when meshoptimizer's result is not a watertight mesh without zero-area triangles.
 */
export async function decimate(mesh: IndexedMesh, targetEdge: number, o: { maxError?: number } = {}): Promise<DecimateResult> {
  const before = mesh.indices.length / 3;
  if (before === 0) return { mesh, before, after: before, skipped: 'empty' };
  if (!(targetEdge > 0) || !Number.isFinite(targetEdge)) throw new RangeError(`targetEdge must be a finite number > 0, got ${targetEdge}`);
  const edge = meanEdgeLength(mesh);
  if (!(edge < targetEdge)) return { mesh, before, after: before, skipped: 'dense-enough' };
  const ratio = Math.max(1 / MAX_DECIMATION, (edge / targetEdge) ** 2);
  const targetTriangles = Math.max(4, Math.floor(before * ratio));
  await MeshoptSimplifier.ready;
  const maxError = o.maxError ?? 0.5 * edge;
  const [indices] = MeshoptSimplifier.simplify(mesh.indices, mesh.positions, 3, targetTriangles * 3, maxError, ['Regularize', 'ErrorAbsolute']);
  const out = compactMesh(mesh.positions, indices);
  if (out.indices.length === 0 || !isWatertight(out.indices) || countNonManifoldVertices(out.indices) > 0 || countZeroAreaTriangles(out) > 0) {
    return { mesh, before, after: before, skipped: 'rejected' };
  }
  return { mesh: out, before, after: out.indices.length / 3 };
}
