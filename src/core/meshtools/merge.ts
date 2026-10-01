// Track T5 — merge parts into one mesh part (`MeshApi.merge`, the editor's ⌘J; DESIGN.md §2.9.8, G24).
//
// 1. Every selected part's SDF in model space: the analytic SDF (§3.7.6) for a primitive, the stored `sdf:<meshRef>`
//    volume for an unedited reconstructed part, the narrow-band voxelizer for any other mesh part (its buffer,
//    moved to model space and voxelized directly on the merge lattice: one sampling, no second interpolation).
// 2. One lattice over the union of their world boxes + 2 voxels, N = 96 samples on the longest side; each SDF sampled.
// 3. Touch check: two parts touch when some sample is inside both, else when their surface gap (minimized from the
//    best sample with the continuous SDFs) is ≤ 0.1 in. The parts must form ONE touching group; otherwise
//    `MeshToolError('not-touching', 'these parts do not touch')`.
// 4. Union f = max(f_a, f_b, …). If the union is in several pieces (parts that touch within 0.1 in without
//    overlapping), each such pair gets a BRIDGE: a capsule between the two closest surface points (found by the gap
//    search), reaching one voxel into each part, radius max(1.5 voxels, gap). Only that neighborhood changes.
// 5. Marching cubes → 10 Taubin pairs → manifold-3d validation (status, parts, genus).
// 6. Labels and `partId` (the index of the source part in `parts`) from the nearest vertex of the source parts'
//    colored meshes, leaving out source vertices buried inside another selected part; primitives are tessellated
//    by the builder with their colors evaluated per vertex (`primitiveColoredMesh`).
//
// The result is in MODEL space (the merged part is unrotated; `recenterMesh` gives the bbox-centered form and its
// position). The model recipe — which id, attach and hints survive — is T6's `mergeParts` (§2.9.8).
import { manifoldReport } from '../kernel/geom/manifold';
import { countComponents, signedVolume } from '../kernel/geom/meshMeasures';
import { encodeSdfVolume } from '../kernel/geom/sdfVolume';
import { eulerXYZToMat3, worldBounds, type Bounds } from '../model/transforms';
import { worldSdf, type WorldSdf } from '../model/sdf';
import type { ColoredMesh, SdfVolume, Vec3 } from '../../types/geometry';
import type { Part } from '../../types/model';
import { primitiveColoredMesh } from './convert';
import { NearestVertexIndex, remeshVolume, FINAL_TAUBIN_PAIRS } from './remesh';
import { sampleVolume, volumeFromSdf, MeshToolError, type FieldVolume } from './volume';
import { VOXELIZE_N, voxelGridFor, voxelizeMeshOnGrid, type VoxelGrid } from './voxelize';

/** §2.9.8: parts merge when they touch or overlap, gap ≤ 0.1 in. */
export const MERGE_MAX_GAP_IN = 0.1;

export interface MergeInput {
  part: Part;
  /** The buffer of a mesh part (part-local), required unless `sdf` is given. */
  mesh?: ColoredMesh;
  /** The stored `sdf:<meshRef>` volume of an unedited reconstructed mesh part (part-local). */
  sdf?: SdfVolume;
}

export interface MergeOptions {
  /** Samples on the longest side of the lattice (default 96). */
  N?: number;
  /** The model's palette ids in order; labels index into it. Without it primitives contribute label 255. */
  paletteIds?: readonly string[];
  /** Largest surface gap that still counts as touching (default 0.1 in). */
  maxGapIn?: number;
}

export interface MergeResult {
  /** Model space, watertight; `labels` and `partId` (index into the input list) per vertex. */
  mesh: ColoredMesh;
  /** The merged field, model space (the new part's `sdf:` asset once recentered). */
  sdf: SdfVolume;
  /** Volume of `mesh`, in³. */
  volumeIn3: number;
  /** Volume of the union of the source solids, in³ (sampled at half the lattice spacing). */
  unionVolumeIn3: number;
  /** Genus of the mesh's largest piece (manifold-3d). */
  genus: number;
  /** Radius of the bridges joining parts that touch without overlapping; 0 when none was needed. */
  bridgeIn: number;
  /** Smallest surface gap of each touching pair used to join the group, in (≤ 0 = overlapping). */
  links: { a: number; b: number; gapIn: number }[];
}

interface Source {
  /** Model-space SDF (continuous). For a mesh part given by its buffer it is set once the lattice is known. */
  sdf: WorldSdf;
  bounds: Bounds;
  colored: ColoredMesh;
  /** A mesh part given by its buffer: its vertices in model space, voxelized on the merge lattice. */
  worldMesh?: { positions: Float64Array; indices: ArrayLike<number> };
  /** Its samples on the merge lattice, when they come from the voxelizer. */
  field?: Float32Array<ArrayBuffer>;
}

function transformMesh(m: ColoredMesh, part: Part): Float64Array {
  const r = eulerXYZToMat3(part.rotationDeg);
  const [px, py, pz] = part.position;
  const out = new Float64Array(m.positions.length);
  for (let i = 0; i < m.positions.length; i += 3) {
    const x = m.positions[i];
    const y = m.positions[i + 1];
    const z = m.positions[i + 2];
    out[i] = r[0] * x + r[1] * y + r[2] * z + px;
    out[i + 1] = r[3] * x + r[4] * y + r[5] * z + py;
    out[i + 2] = r[6] * x + r[7] * y + r[8] * z + pz;
  }
  return out;
}

/** World box of the inside samples (± one voxel) of a part-local volume. */
function volumeWorldBounds(v: FieldVolume, part: Part): Bounds {
  const [nx, ny, nz] = v.dims;
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  let i = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        if (!(v.field[i] >= 0)) continue;
        if (x < lo[0]) lo[0] = x;
        if (x > hi[0]) hi[0] = x;
        if (y < lo[1]) lo[1] = y;
        if (y > hi[1]) hi[1] = y;
        if (z < lo[2]) lo[2] = z;
        if (z > hi[2]) hi[2] = z;
      }
    }
  }
  if (lo[0] === Infinity) throw new MeshToolError('bad-mesh', `${part.id}: its stored volume is empty`);
  const r = eulerXYZToMat3(part.rotationDeg);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const local: Vec3 = [0, 0, 0];
    for (let a = 0; a < 3; a++) {
      const k = (c >> a) & 1 ? hi[a] + 1 : lo[a] - 1;
      local[a] = v.origin[a] + k * v.voxel;
    }
    for (let a = 0; a < 3; a++) {
      const w = r[3 * a] * local[0] + r[3 * a + 1] * local[1] + r[3 * a + 2] * local[2] + part.position[a];
      if (w < min[a]) min[a] = w;
      if (w > max[a]) max[a] = w;
    }
  }
  return { min, max };
}

function buildSource(input: MergeInput, paletteIds: readonly string[] | undefined): Source {
  const { part } = input;
  if (part.type !== 'mesh') {
    const colored = primitiveColoredMesh(part, paletteIds);
    return { sdf: worldSdf(part), bounds: worldBounds(part), colored };
  }
  if (!input.sdf && input.mesh && input.mesh.indices.length >= 3 && input.mesh.positions.length >= 9) {
    const notYet: WorldSdf = () => {
      throw new Error('merge: SDF used before the lattice was built');
    };
    return { sdf: notYet, bounds: worldBounds(part, input.mesh), colored: input.mesh, worldMesh: { positions: transformMesh(input.mesh, part), indices: input.mesh.indices } };
  }
  if (!input.sdf) throw new MeshToolError('bad-mesh', `${part.id}: a mesh part needs its mesh buffer or its stored volume`);
  const local = volumeFromSdf(input.sdf);
  const sdf = worldSdf(part, (p) => sampleVolume(local, p[0], p[1], p[2]));
  const bounds = input.mesh && input.mesh.positions.length >= 3 ? worldBounds(part, input.mesh) : volumeWorldBounds(local, part);
  // A stored volume without its buffer: its own surface stands in for the source vertices (labels unknown).
  const colored: ColoredMesh =
    input.mesh ??
    (() => {
      const m = remeshVolume(local, { pairs: 0 });
      return { positions: m.positions, indices: m.indices, labels: new Uint8Array(m.positions.length / 3).fill(255) };
    })();
  return { sdf, bounds, colored };
}

/** Voxelizes a mesh part's model-space buffer on the merge lattice; refuses an open or empty one. */
function voxelizeSource(src: Source, part: Part, grid: VoxelGrid): void {
  if (!src.worldMesh) return;
  const v = voxelizeMeshOnGrid(src.worldMesh, grid);
  let inside = false;
  for (let i = 0; i < v.field.length && !inside; i++) if (v.field[i] >= 0) inside = true;
  if (v.stats.oddColumns > 0) throw new MeshToolError('bad-mesh', `${part.id}: its mesh is not closed (repair it before merging)`);
  if (!inside) throw new MeshToolError('bad-mesh', `${part.id}: its mesh is too thin to merge at this resolution`);
  const vol: FieldVolume = { field: v.field, dims: v.dims, origin: v.origin, voxel: v.voxel };
  src.field = v.field;
  src.sdf = (x, y, z) => sampleVolume(vol, x, y, z);
}

function sampleOnGrid(f: WorldSdf, g: VoxelGrid): Float32Array<ArrayBuffer> {
  const [nx, ny, nz] = g.dims;
  const out = new Float32Array(nx * ny * nz);
  let i = 0;
  for (let z = 0; z < nz; z++) {
    const pz = g.origin[2] + z * g.voxel;
    for (let y = 0; y < ny; y++) {
      const py = g.origin[1] + y * g.voxel;
      for (let x = 0; x < nx; x++, i++) out[i] = f(g.origin[0] + x * g.voxel, py, pz);
    }
  }
  return out;
}

/** A pair's gap and, when they do not overlap, the point between their closest surface points. */
export interface PairGap {
  gapIn: number;
  /** The minimizer of the gap search (on the segment between the closest points); null when overlapping on the lattice. */
  point: Vec3 | null;
}

/**
 * Smallest surface gap between two solids, in inches (≤ 0 when they overlap): the minimum of
 * max(−f_a, 0) + max(−f_b, 0), which equals the gap all along the segment between the closest points. Starts at
 * the best lattice sample and refines with a pattern search on the continuous SDFs. With the ellipsoid bound
 * (a lower bound of the distance outside) the gap can only come out smaller than the true one.
 */
export function pairGap(fa: Float32Array, fb: Float32Array, g: VoxelGrid, sa: WorldSdf, sb: WorldSdf): PairGap {
  let best = Infinity;
  let bestI = -1;
  for (let i = 0; i < fa.length; i++) {
    const a = fa[i];
    const b = fb[i];
    if (a >= 0 && b >= 0) return { gapIn: -Math.min(a, b), point: null };
    const s = (a < 0 ? -a : 0) + (b < 0 ? -b : 0);
    if (s < best) {
      best = s;
      bestI = i;
    }
  }
  if (bestI < 0) return { gapIn: Infinity, point: null };
  const [nx, ny] = g.dims;
  const x = bestI % nx;
  const y = Math.floor(bestI / nx) % ny;
  const z = Math.floor(bestI / (nx * ny));
  const p: Vec3 = [g.origin[0] + x * g.voxel, g.origin[1] + y * g.voxel, g.origin[2] + z * g.voxel];
  const cost = (q: Vec3): number => {
    const a = sa(q[0], q[1], q[2]);
    const b = sb(q[0], q[1], q[2]);
    if (a >= 0 && b >= 0) return -Math.min(a, b);
    return (a < 0 ? -a : 0) + (b < 0 ? -b : 0);
  };
  let c = cost(p);
  const dirs: Vec3[] = [];
  for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy || dz) dirs.push([dx, dy, dz]);
  for (let step = g.voxel; step > g.voxel / 256; step /= 2) {
    for (let iter = 0; iter < 64; iter++) {
      let moved = false;
      for (const d of dirs) {
        const q: Vec3 = [p[0] + d[0] * step, p[1] + d[1] * step, p[2] + d[2] * step];
        const cq = cost(q);
        if (cq < c) {
          c = cq;
          p[0] = q[0];
          p[1] = q[1];
          p[2] = q[2];
          moved = true;
        }
      }
      if (!moved || c < 0) break;
    }
    if (c < 0) break;
  }
  return { gapIn: c, point: p };
}

/** Outward unit normal of an SDF (−∇f) by central differences; null without a gradient. */
function outward(f: WorldSdf, p: Vec3, h: number): Vec3 | null {
  const gx = f(p[0] + h, p[1], p[2]) - f(p[0] - h, p[1], p[2]);
  const gy = f(p[0], p[1] + h, p[2]) - f(p[0], p[1] - h, p[2]);
  const gz = f(p[0], p[1], p[2] + h) - f(p[0], p[1], p[2] - h);
  const len = Math.hypot(gx, gy, gz);
  return len > 0 && Number.isFinite(len) ? [-gx / len, -gy / len, -gz / len] : null;
}

/** The point of solid f's surface nearest to p (a few Newton steps along the gradient). */
function toSurface(f: WorldSdf, p: Vec3, h: number): Vec3 {
  const q: Vec3 = [p[0], p[1], p[2]];
  for (let k = 0; k < 8; k++) {
    const v = f(q[0], q[1], q[2]);
    const n = outward(f, q, h);
    if (!n || Math.abs(v) < 1e-6) break;
    // f > 0 inside: move outward by f (inside) or inward by −f (outside)
    q[0] += v * n[0];
    q[1] += v * n[1];
    q[2] += v * n[2];
  }
  return q;
}

/**
 * Adds a bridge between two solids that do not overlap: a capsule from solid a's nearest surface point to solid b's,
 * each end pushed one voxel into its solid, of radius max(1.5 voxels, gap). Writes max(field, capsule) in place and
 * returns the radius.
 */
export function addBridge(field: Float32Array<ArrayBuffer>, g: VoxelGrid, sa: WorldSdf, sb: WorldSdf, mid: Vec3, gap: number): number {
  const h = g.voxel / 8;
  let pa = toSurface(sa, mid, h);
  let pb = toSurface(sb, mid, h);
  let u: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  let len = Math.hypot(u[0], u[1], u[2]);
  if (!(len > 1e-9)) {
    const n = outward(sa, pa, h) ?? [0, 1, 0];
    u = n;
    len = 1;
  } else u = [u[0] / len, u[1] / len, u[2] / len];
  pa = [pa[0] - u[0] * g.voxel, pa[1] - u[1] * g.voxel, pa[2] - u[2] * g.voxel];
  pb = [pb[0] + u[0] * g.voxel, pb[1] + u[1] * g.voxel, pb[2] + u[2] * g.voxel];
  const r = Math.max(1.5 * g.voxel, gap);
  const d: Vec3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
  const dd = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
  const [nx, ny, nz] = g.dims;
  const lo = [0, 1, 2].map((a) => Math.max(0, Math.floor((Math.min(pa[a], pb[a]) - r - g.origin[a]) / g.voxel)));
  const hi = [0, 1, 2].map((a) => Math.min(g.dims[a] - 1, Math.ceil((Math.max(pa[a], pb[a]) + r - g.origin[a]) / g.voxel)));
  for (let z = lo[2]; z <= hi[2] && z < nz; z++) {
    for (let y = lo[1]; y <= hi[1] && y < ny; y++) {
      for (let x = lo[0]; x <= hi[0]; x++) {
        const px = g.origin[0] + x * g.voxel - pa[0];
        const py = g.origin[1] + y * g.voxel - pa[1];
        const pz = g.origin[2] + z * g.voxel - pa[2];
        const t = dd > 0 ? Math.min(1, Math.max(0, (px * d[0] + py * d[1] + pz * d[2]) / dd)) : 0;
        const v = r - Math.hypot(px - d[0] * t, py - d[1] * t, pz - d[2] * t);
        const i = x + nx * (y + ny * z);
        if (v > field[i]) field[i] = v;
      }
    }
  }
  return r;
}

/** Union volume of the sources at half the lattice spacing (cell centers), in³. */
function unionVolume(sources: Source[], g: VoxelGrid): number {
  const h = g.voxel / 2;
  const n = [2 * (g.dims[0] - 1), 2 * (g.dims[1] - 1), 2 * (g.dims[2] - 1)];
  let count = 0;
  for (let z = 0; z < n[2]; z++) {
    const pz = g.origin[2] + (z + 0.5) * h;
    for (let y = 0; y < n[1]; y++) {
      const py = g.origin[1] + (y + 0.5) * h;
      for (let x = 0; x < n[0]; x++) {
        const px = g.origin[0] + (x + 0.5) * h;
        for (const s of sources) {
          if (s.sdf(px, py, pz) > 0) {
            count++;
            break;
          }
        }
      }
    }
  }
  return count * h * h * h;
}

/** Union-find over n items. */
function groups(n: number, edges: { a: number; b: number }[]): number {
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const e of edges) parent[find(e.a)] = find(e.b);
  return new Set(parent.map((_, i) => find(i))).size;
}

/**
 * `MeshApi.merge` (§2.9.8). Rejects with `MeshToolError`: 'too-few-parts', 'not-touching' ("these parts do not
 * touch"), 'bridge-failed' (they touch but could not be joined at this resolution), 'bad-mesh', 'empty-result'.
 */
export async function mergeParts(inputs: MergeInput[], o: MergeOptions = {}): Promise<MergeResult> {
  if (!Array.isArray(inputs) || inputs.length < 2) throw new MeshToolError('too-few-parts', 'select at least two parts to merge');
  const N = o.N ?? VOXELIZE_N;
  const maxGap = o.maxGapIn ?? MERGE_MAX_GAP_IN;
  const sources = inputs.map((inp) => buildSource(inp, o.paletteIds));

  // 2. lattice over the union of the world boxes + 2 voxels
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const s of sources) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], s.bounds.min[a]);
      max[a] = Math.max(max[a], s.bounds.max[a]);
    }
  }
  const grid = voxelGridFor(min, max, N);
  sources.forEach((s, i) => voxelizeSource(s, inputs[i].part, grid));
  const fields = sources.map((s) => s.field ?? sampleOnGrid(s.sdf, grid));

  // 3. touch graph: all pairs, then one group required
  const links: { a: number; b: number; gapIn: number }[] = [];
  const mids: (Vec3 | null)[] = [];
  for (let a = 0; a < sources.length; a++) {
    for (let b = a + 1; b < sources.length; b++) {
      const gap = pairGap(fields[a], fields[b], grid, sources[a].sdf, sources[b].sdf);
      if (gap.gapIn <= maxGap) {
        links.push({ a, b, gapIn: gap.gapIn });
        mids.push(gap.point);
      }
    }
  }
  if (groups(sources.length, links) !== 1) throw new MeshToolError('not-touching', 'these parts do not touch');

  // 4. union (+ bridges when the union falls apart)
  const field: Float32Array<ArrayBuffer> = new Float32Array(fields[0]);
  for (let k = 1; k < fields.length; k++) {
    const f = fields[k];
    for (let i = 0; i < field.length; i++) if (f[i] > field[i]) field[i] = f[i];
  }
  const vol: FieldVolume = { field, dims: grid.dims, origin: grid.origin, voxel: grid.voxel };
  let mesh = remeshVolume(vol, { pairs: 0 });
  if (mesh.indices.length === 0) throw new MeshToolError('empty-result', 'the merged parts have no volume at this resolution');
  let bridgeIn = 0;
  if (countComponents(mesh.indices) > 1) {
    // Every linked pair that does not share a lattice sample gets a bridge at its closest points.
    links.forEach((l, k) => {
      const m = mids[k];
      if (m) bridgeIn = Math.max(bridgeIn, addBridge(field, grid, sources[l.a].sdf, sources[l.b].sdf, m, Math.max(0, l.gapIn)));
    });
    mesh = remeshVolume(vol, { pairs: 0 });
    if (countComponents(mesh.indices) > 1) throw new MeshToolError('bridge-failed', 'these parts touch but could not be joined at this resolution');
  }

  // 5. smooth and validate
  mesh = remeshVolume(vol, { pairs: FINAL_TAUBIN_PAIRS });
  const report = await manifoldReport(mesh);
  if (report.status !== 'NoError') throw new MeshToolError('bad-mesh', `the merged mesh is not a valid solid (${report.status})`);

  // 6. labels and source part per vertex; a source vertex more than ¼ voxel inside another part is buried
  const buriedAt = 0.25 * grid.voxel;
  const pts: number[] = [];
  const lab: number[] = [];
  const pid: number[] = [];
  for (let s = 0; s < sources.length; s++) {
    const src = sources[s];
    const world = src.worldMesh?.positions ?? transformMesh(src.colored, inputs[s].part);
    for (let v = 0; v < world.length / 3; v++) {
      const x = world[3 * v];
      const y = world[3 * v + 1];
      const z = world[3 * v + 2];
      let buried = false;
      for (let t = 0; t < sources.length && !buried; t++) if (t !== s && sources[t].sdf(x, y, z) > buriedAt) buried = true;
      if (buried) continue;
      pts.push(x, y, z);
      lab.push(src.colored.labels[v] ?? 255);
      pid.push(s);
    }
  }
  const nv = mesh.positions.length / 3;
  const labels = new Uint8Array(nv).fill(255);
  const partId = new Uint8Array(nv);
  if (pts.length > 0) {
    const index = new NearestVertexIndex(pts);
    for (let v = 0; v < nv; v++) {
      const k = index.nearest(mesh.positions[3 * v], mesh.positions[3 * v + 1], mesh.positions[3 * v + 2]);
      if (k < 0) continue;
      labels[v] = lab[k];
      partId[v] = Math.min(255, pid[k]);
    }
  }

  return {
    mesh: { positions: mesh.positions, indices: mesh.indices, labels, partId },
    sdf: encodeSdfVolume(field, grid.dims, grid.origin, grid.voxel),
    volumeIn3: signedVolume(mesh),
    unionVolumeIn3: unionVolume(sources, grid),
    genus: report.genus,
    bridgeIn,
    links,
  };
}
