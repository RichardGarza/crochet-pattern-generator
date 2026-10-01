// Track T5 — Path B steps 1–3 and the seam of step 5 in one call (DESIGN.md §2.10.7): re-mesh to edge ≈ min(w, h)/3,
// seed, heat-method φ with t doubling, row isolines at k·hEff with the `NeedsSplit` check, the seam and each row's
// loop rotated to start where the seam crosses it. T5.3's Path B driver adds the counts (step 4), the samples
// (`sampleLoop` with the clamped counts and the spiral-lean offset), DTW and the transducer.
import type { IndexedMesh } from '../kernel/geom/marchingCubes';
import { signedVolume, type MeshLike } from '../kernel/geom/meshMeasures';
import { MeshToolError } from './volume';
import type { Vec3 } from '../../types/geometry';
import { chooseSeed, HeatSolver, remeshForPathB, surfaceMesh, type HeatOptions, type HeatResult, type RemeshForPathBResult, type SeedChoice, type SeedOptions, type SurfaceMesh } from './heat';
import { isolineLoops, rowLevels, startLoopAt, type IsolineLoop } from './isolines';
import { argmaxVertex, seamCrossingEdge, seamPath } from './seam';

/** §2.10.7 step 1: the re-mesh edge, min(w, h)/3. */
export function pathBTargetEdge(w: number, h: number): number {
  if (!(w > 0) || !(h > 0) || !Number.isFinite(w) || !Number.isFinite(h)) throw new RangeError('w and h must be > 0');
  return Math.min(w, h) / 3;
}

export interface GeodesicRowsOptions extends SeedOptions, HeatOptions {
  /** Effective round pitch (inches). */
  hS: number;
  /** Re-mesh edge (inches), normally `pathBTargetEdge(w, h)`. */
  targetEdge: number;
  /** Re-mesh vertex cap (default MAX_REMESH_VERTICES). */
  maxVertices?: number;
  /**
   * false: use the mesh as given (a clean closed manifold, consistently wound — `bad-mesh` otherwise; an inside-out
   * mesh is flipped); default true (§2.10.7 step 1).
   */
  remesh?: boolean;
}

export interface GeodesicRow {
  /** Round index k (1-based) and its level k·hEff. */
  k: number;
  level: number;
  /** The isoline, starting at the seam crossing, in the RH working direction. */
  loop: IsolineLoop;
  /** The mesh edge where the seam crosses this isoline (the loop's first point lies on it). */
  seamEdge: number;
}

export interface NeedsSplit {
  /** Round index k (1-based) of the first level with more than one loop, and its φ value. */
  level: number;
  value: number;
  /** Lengths (inches) of the loops at that level, in loop order (count = loops.length). */
  loops: number[];
  /** Centroid of each loop's points (for the editor's "Split here" proposal). */
  centroids: Vec3[];
}

export interface GeodesicRowsResult {
  /** The surface everything refers to (the re-mesh, or the input when `remesh: false`). */
  mesh: IndexedMesh;
  sm: SurfaceMesh;
  remesh?: RemeshForPathBResult;
  seed: SeedChoice;
  heat: HeatResult;
  maxPhi: number;
  /** The vertex of max φ (the far pole / closing point). */
  apex: number;
  N: number;
  hEff: number;
  /** Loops per level, k = 1 … N − 1. */
  loopCounts: number[];
  /** The seam: vertex path seed → apex. */
  seam: Int32Array;
  /** Rows k = 1 … N − 1 (empty when `needsSplit`). */
  rows: GeodesicRow[];
  needsSplit?: NeedsSplit;
}

function centroid(points: Float64Array): Vec3 {
  const n = points.length / 3;
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) c[a] += points[3 * i + a] / n;
  return c;
}

/** §2.10.7 steps 1–3 and the seam (step 5). */
export function geodesicRows(input: MeshLike, o: GeodesicRowsOptions): GeodesicRowsResult {
  if (!(o.hS > 0) || !Number.isFinite(o.hS)) throw new RangeError(`hS must be > 0, got ${o.hS}`);
  let mesh: IndexedMesh;
  let remesh: RemeshForPathBResult | undefined;
  if (o.remesh === false) {
    mesh = { positions: Float32Array.from(input.positions), indices: Uint32Array.from(input.indices) };
    // Isolines run in the working direction only on a consistently oriented, outward mesh.
    if (surfaceMesh(mesh).misorientedEdges > 0) throw new MeshToolError('bad-mesh', 'the mesh winding is inconsistent (re-mesh it)');
    if (signedVolume(mesh) < 0) {
      const f = mesh.indices;
      for (let t = 0; t < f.length; t += 3) [f[t + 1], f[t + 2]] = [f[t + 2], f[t + 1]];
    }
  } else {
    remesh = remeshForPathB(input, o.targetEdge, { maxVertices: o.maxVertices });
    mesh = remesh.mesh;
  }
  const sm = surfaceMesh(mesh);
  const solver = new HeatSolver(sm);
  const seed = chooseSeed(solver, o);
  const heat = solver.geodesic([seed.vertex], o);
  const phi = heat.phi;
  const apex = argmaxVertex(phi);
  const maxPhi = phi[apex];
  const { N, hEff, levels } = rowLevels(maxPhi, o.hS);
  const seam = seamPath(sm, phi, seed.vertex);
  const perLevel = levels.map((c) => isolineLoops(sm, phi, c));
  const loopCounts = perLevel.map((l) => l.length);
  const base = { mesh, sm, remesh, seed, heat, maxPhi, apex, N, hEff, loopCounts, seam };
  const split = loopCounts.findIndex((c) => c > 1);
  if (split >= 0) {
    const loops = perLevel[split];
    return {
      ...base,
      rows: [],
      needsSplit: { level: split + 1, value: levels[split], loops: loops.map((l) => l.length), centroids: loops.map((l) => centroid(l.points)) },
    };
  }
  const rows: GeodesicRow[] = levels.map((level, i) => {
    const loop = perLevel[i][0];
    const seamEdge = seamCrossingEdge(sm, phi, seam, level);
    const rotated = seamEdge >= 0 ? startLoopAt(loop, seamEdge) : null;
    if (!rotated) throw new Error(`the seam does not cross row ${i + 1} (internal error)`);
    return { k: i + 1, level, loop: rotated, seamEdge };
  });
  return { ...base, rows };
}
