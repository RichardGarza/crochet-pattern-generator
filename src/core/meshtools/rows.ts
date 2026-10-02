// Track T5 — Path B steps 1–3 and the seam of step 5 in one call (DESIGN.md §2.10.7): re-mesh to edge ≈ min(w, h)/3,
// seed, heat-method φ with t doubling, row isolines at k·hEff with the `NeedsSplit` check, the seam and each row's
// loop rotated to start where the seam crosses it. The Path B driver (pathB.ts) adds the counts (step 4), the samples
// (`sampleLoop` with the clamped counts and the spiral-lean offset), DTW and the transducer. `geodesicRowsSteps` is the
// resumable form the worker drives (steps.ts).
import type { IndexedMesh } from '../kernel/geom/marchingCubes';
import { signedVolume, type MeshLike } from '../kernel/geom/meshMeasures';
import { roundHalfUp } from '../gauge/round';
import { MeshToolError } from './volume';
import type { Vec3 } from '../../types/geometry';
import { chooseSeedSteps, HeatSolver, nearestVertex, remeshForPathBSteps, surfaceMesh, type HeatOptions, type HeatResult, type RemeshForPathBResult, type SeedChoice, type SeedOptions, type SurfaceMesh } from './heat';
import { isolineLoops, rowLevels, startLoopAt, type IsolineLoop } from './isolines';
import { argmaxVertex, dijkstraPath, seamCrossingEdge, seamPath } from './seam';
import { drain, type Steps } from './steps';

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
  /**
   * An open far end at this geodesic distance from the seed (the trimmed arc length of §2.10.3, `PieceFrame.trimmedAt`):
   * rows k·hEff for k = 1 … N with N = max(2, round(trimAt / hS)), hEff = trimAt / N, the last row on the cut. Ignored
   * when ≥ max φ (the piece stays closed).
   */
  trimAt?: number;
  /**
   * Center back (`PieceFrame.seamDir`, part-local): the seam runs seed → the point of the reference row (the longest
   * isoline) farthest along this direction → argmax φ, so that row starts at center back (§2.11.2). Without it the
   * seam is the plain Dijkstra path seed → argmax φ (§2.10.7 step 5).
   */
  seamDir?: Vec3;
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
  /** Loops per level (k = 1 … N − 1; … N when open). */
  loopCounts: number[];
  /** True when `trimAt` cut the piece: the last row is the open edge. */
  open: boolean;
  /** Index (0-based) of the reference row: the longest isoline, ties → first (−1 when `needsSplit`). */
  refRow: number;
  /** The seam: vertex path seed → apex. */
  seam: Int32Array;
  /** Rows k = 1 … N − 1 (… N when open; empty when `needsSplit`). */
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
  return drain(geodesicRowsSteps(input, o));
}

/** Unit vector of v without its component along n (null when what is left is shorter than `min`). */
function perpendicular(v: Vec3, n: Vec3, min: number): Vec3 | null {
  const nn = Math.hypot(n[0], n[1], n[2]);
  const u: Vec3 = nn > 0 ? [n[0] / nn, n[1] / nn, n[2] / nn] : [0, 0, 0];
  const d = v[0] * u[0] + v[1] * u[1] + v[2] * u[2];
  const w: Vec3 = [v[0] - d * u[0], v[1] - d * u[1], v[2] - d * u[2]];
  const len = Math.hypot(w[0], w[1], w[2]);
  return len >= min ? [w[0] / len, w[1] / len, w[2] / len] : null;
}

/** Newell normal of a closed polyline (its area vector; length = 2 × area). */
export function loopAreaVector(points: ArrayLike<number>): Vec3 {
  const n = points.length / 3;
  const a: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const [x0, y0, z0] = [points[3 * i], points[3 * i + 1], points[3 * i + 2]];
    const [x1, y1, z1] = [points[3 * j], points[3 * j + 1], points[3 * j + 2]];
    a[0] += (y0 - y1) * (z0 + z1);
    a[1] += (z0 - z1) * (x0 + x1);
    a[2] += (x0 - x1) * (y0 + y1);
  }
  return a;
}

/** `geodesicRows` as a resumable computation (steps.ts): yields between stages, inside the re-mesh and the solves, per level. */
export function* geodesicRowsSteps(input: MeshLike, o: GeodesicRowsOptions): Steps<GeodesicRowsResult> {
  if (!(o.hS > 0) || !Number.isFinite(o.hS)) throw new RangeError(`hS must be > 0, got ${o.hS}`);
  if (o.trimAt !== undefined && !(o.trimAt > 0 && Number.isFinite(o.trimAt))) throw new RangeError(`trimAt must be > 0, got ${o.trimAt}`);
  if (o.seamDir !== undefined && !(o.seamDir.length === 3 && o.seamDir.every((c) => Number.isFinite(c)))) throw new RangeError('bad seamDir');
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
    remesh = yield* remeshForPathBSteps(input, o.targetEdge, { maxVertices: o.maxVertices });
    mesh = remesh.mesh;
  }
  yield;
  const sm = remesh ? remesh.sm : surfaceMesh(mesh);
  yield;
  const solver = yield* HeatSolver.build(sm);
  const seed = yield* chooseSeedSteps(solver, o);
  const heat = yield* solver.geodesicSteps([seed.vertex], o);
  const phi = heat.phi;
  const apex = argmaxVertex(phi);
  const maxPhi = phi[apex];
  const open = o.trimAt !== undefined && o.trimAt < maxPhi;
  let N: number;
  let hEff: number;
  let levels: number[];
  if (open) {
    const L = o.trimAt as number;
    N = Math.max(2, roundHalfUp(L / o.hS));
    hEff = L / N;
    levels = [];
    for (let k = 1; k <= N; k++) levels.push(k === N ? L : k * hEff);
  } else {
    ({ N, hEff, levels } = rowLevels(maxPhi, o.hS));
  }
  const perLevel: IsolineLoop[][] = [];
  for (const c of levels) {
    perLevel.push(isolineLoops(sm, phi, c));
    yield;
  }
  const loopCounts = perLevel.map((l) => l.length);
  const split = loopCounts.findIndex((c) => c > 1);
  if (split >= 0) {
    const loops = perLevel[split];
    return {
      mesh, sm, remesh, seed, heat, maxPhi, apex, N, hEff, loopCounts, open, refRow: -1,
      seam: new Int32Array(0),
      rows: [],
      needsSplit: { level: split + 1, value: levels[split], loops: loops.map((l) => l.length), centroids: loops.map((l) => centroid(l.points)) },
    };
  }
  if (loopCounts.some((c) => c === 0)) throw new MeshToolError('bad-mesh', 'a row level has no isoline (internal error)');
  let refRow = 0;
  for (let i = 1; i < perLevel.length; i++) if (perLevel[i][0].length > perLevel[refRow][0].length) refRow = i;
  let seam: Int32Array = seamPath(sm, phi, seed.vertex);
  if (o.seamDir) {
    // Center back on the reference row: the loop point farthest along seamDir, with the row's normal removed.
    const ref = perLevel[refRow][0];
    const dir = perpendicular(o.seamDir, loopAreaVector(ref.points), 0.1);
    if (dir) {
      const c = centroid(ref.points);
      let best = 0;
      let bd = -Infinity;
      for (let i = 0; i < ref.points.length / 3; i++) {
        const d = (ref.points[3 * i] - c[0]) * dir[0] + (ref.points[3 * i + 1] - c[1]) * dir[1] + (ref.points[3 * i + 2] - c[2]) * dir[2];
        if (d > bd) {
          bd = d;
          best = i;
        }
      }
      const back = nearestVertex(sm, [ref.points[3 * best], ref.points[3 * best + 1], ref.points[3 * best + 2]]);
      const a = dijkstraPath(sm, seed.vertex, back);
      const b = dijkstraPath(sm, back, apex);
      if (a.length > 0 && b.length > 0) {
        const joined = new Int32Array(a.length + b.length - 1);
        joined.set(a);
        joined.set(b.subarray(1), a.length);
        seam = joined;
      }
    }
  }
  yield;
  const base = { mesh, sm, remesh, seed, heat, maxPhi, apex, N, hEff, loopCounts, open, refRow, seam };
  const rows: GeodesicRow[] = levels.map((level, i) => {
    const loop = perLevel[i][0];
    let seamEdge = seamCrossingEdge(sm, phi, seam, level);
    // The open edge lies at the cut level; a seam vertex exactly on it has no edge "below → on/above" beyond it.
    if (seamEdge < 0 && open) seamEdge = loop.edges[0];
    const rotated = seamEdge >= 0 ? startLoopAt(loop, seamEdge) : null;
    if (!rotated) throw new Error(`the seam does not cross row ${i + 1} (internal error)`);
    return { k: i + 1, level, loop: rotated, seamEdge };
  });
  return { ...base, rows };
}
