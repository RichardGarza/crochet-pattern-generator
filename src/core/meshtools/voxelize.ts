// Track T5 — narrow-band voxelizer (DESIGN.md §2.9.8): a closed triangle mesh → a signed-distance volume,
// positive inside, in the mesh's own units (inches).
//
//   1. Band. For each triangle, the samples of its bounding box grown by `band` voxels keep the minimum exact
//      point–triangle distance (Ericson's closest-point regions). A sample is only evaluated when the distance to
//      the triangle's PLANE is below what it already holds (the prefilter: the plane distance is a lower bound of
//      the triangle distance), so most samples of a box cost one dot product. Every sample whose distance to the
//      surface is below `band` voxels gets its exact distance: its nearest triangle's grown box contains it.
//   2. Sign. One ray along +z per (x, y) column of samples, offset by 1e-4 voxel in x and y so that it misses
//      the lattice-aligned vertices and edges of a marching-cubes mesh; crossings come from the triangles whose
//      projection covers the ray (edge functions evaluated on the canonically ordered edge, with a tie rule, so a
//      ray through a shared edge counts exactly one of its two triangles); sorted; a sample is inside when an odd
//      number of crossings lies below it. A column with an odd count (an open mesh) drops its last crossing and
//      is counted in `stats.oddColumns`.
//   3. Far field. Samples outside the band get ±Infinity by their sign and `extendSignedDistance3d` (Step 0)
//      fills them from the band (see docs/tracks/s0b-geom.md, deviation 4, for why it is not the plain seeded
//      EDT).
//
// The grid: N samples along the longest side of the mesh's box, `margin` (default 2) samples beyond the box on
// every side, the other axes the same spacing, the box centered in the lattice.
import { extendSignedDistance3d } from '../kernel/geom/edt';
import type { MeshLike } from '../kernel/geom/meshMeasures';
import type { Vec3 } from '../../types/geometry';
import { drain, type Steps } from './steps';
import type { FieldVolume } from './volume';

export const VOXELIZE_N = 96;
export const VOXELIZE_MARGIN = 2;
export const VOXELIZE_BAND = 2;
/** Offset of the parity rays from the lattice columns, in voxels (§2.9.8 step 2). */
export const RAY_OFFSET = 1e-4;
/** Largest number of samples along one axis the mesh tools accept. */
export const MAX_GRID_SIDE = 1024;
/** Largest number of samples of one lattice (2²⁵ ≈ 33.6 M: about 270 MB for the voxelizer's two float arrays). */
export const MAX_GRID_SAMPLES = 2 ** 25;

export interface VoxelGrid {
  dims: [number, number, number];
  origin: Vec3;
  voxel: number;
}

export interface VoxelizeOptions {
  /** Samples beyond the mesh's box on every side; default 2. */
  margin?: number;
  /** Half-width of the exact band, in voxels; default 2 (§2.9.8). */
  band?: number;
  /**
   * Samples beyond the band: 'edt' (default) — distances from `extendSignedDistance3d`; 'sign' — ±(band · voxel),
   * signs only, for callers that only mesh the zero level (marching cubes reads nothing else; skips the transform).
   */
  farField?: 'edt' | 'sign';
}

export interface VoxelizeStats {
  /** Triangles used (degenerate ones are skipped: their edges belong to their neighbors). */
  triangles: number;
  /** Samples whose distance came from the band (exact). */
  bandSamples: number;
  /** Columns whose ray met an odd number of crossings (an open or broken mesh). 0 for a closed mesh. */
  oddColumns: number;
}

export interface VoxelizeResult extends FieldVolume {
  stats: VoxelizeStats;
}

/**
 * The lattice of `voxelizeMesh`: `N` samples along the longest side of the box [min, max], `margin` more on each
 * side beyond it, the same spacing on every axis, the box centered.
 */
export function voxelGridFor(min: Readonly<Vec3>, max: Readonly<Vec3>, N: number, margin = VOXELIZE_MARGIN): VoxelGrid {
  if (!Number.isInteger(margin) || margin < 0) throw new RangeError(`margin must be an integer >= 0, got ${margin}`);
  if (!Number.isInteger(N) || N < 2 * margin + 3 || N > MAX_GRID_SIDE) {
    throw new RangeError(`N must be an integer in ${2 * margin + 3}…${MAX_GRID_SIDE}, got ${N}`);
  }
  const ext: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  if (!ext.every((e) => Number.isFinite(e) && e >= 0)) throw new RangeError('the box must be finite with max >= min');
  const longest = Math.max(ext[0], ext[1], ext[2]);
  if (!(longest > 0)) throw new RangeError('the box has no extent');
  const voxel = longest / (N - 1 - 2 * margin);
  const dims = [0, 0, 0] as [number, number, number];
  const origin = [0, 0, 0] as Vec3;
  for (let a = 0; a < 3; a++) {
    const inner = Math.max(0, Math.ceil(ext[a] / voxel - 1e-9));
    dims[a] = Math.min(MAX_GRID_SIDE, inner + 1 + 2 * margin);
    const center = (min[a] + max[a]) / 2;
    origin[a] = center - ((dims[a] - 1) * voxel) / 2;
  }
  if (dims[0] * dims[1] * dims[2] > MAX_GRID_SAMPLES) throw new RangeError(`a ${dims.join('×')} lattice exceeds ${MAX_GRID_SAMPLES} samples`);
  return { dims, origin, voxel };
}

/** Bounds of the vertices that triangles use (unused vertices do not grow the grid). */
export function usedBounds(mesh: MeshLike): { min: Vec3; max: Vec3 } {
  const p = mesh.positions;
  const idx = mesh.indices;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let t = 0; t < idx.length; t++) {
    const v = idx[t] * 3;
    for (let a = 0; a < 3; a++) {
      const c = p[v + a];
      if (c < min[a]) min[a] = c;
      if (c > max[a]) max[a] = c;
    }
  }
  return { min, max };
}

function checkMesh(mesh: MeshLike): void {
  const n = mesh.positions.length;
  if (n % 3 !== 0) throw new RangeError(`positions length ${n} is not a multiple of 3`);
  if (mesh.indices.length % 3 !== 0) throw new RangeError(`indices length ${mesh.indices.length} is not a multiple of 3`);
  if (mesh.indices.length === 0) throw new RangeError('the mesh has no triangles');
  const count = n / 3;
  for (let i = 0; i < mesh.indices.length; i++) {
    const v = mesh.indices[i];
    if (!Number.isInteger(v) || v < 0 || v >= count) throw new RangeError(`index ${i} (${v}) is not a vertex`);
  }
  for (let i = 0; i < n; i++) if (!Number.isFinite(mesh.positions[i])) throw new RangeError(`position ${i} is not finite`);
}

/**
 * Narrow-band voxelizer of §2.9.8 on the grid of `voxelGridFor(box of the mesh, N, margin)`. The mesh should be
 * closed (watertight); positions in inches. Throws RangeError for a malformed or empty mesh.
 */
export function voxelizeMesh(mesh: MeshLike, N = VOXELIZE_N, o: VoxelizeOptions = {}): VoxelizeResult {
  return drain(voxelizeMeshSteps(mesh, N, o));
}

/** `voxelizeMesh` as a resumable computation (steps.ts): yields every few thousand triangles and before the far field. */
export function voxelizeMeshSteps(mesh: MeshLike, N = VOXELIZE_N, o: VoxelizeOptions = {}): Steps<VoxelizeResult> {
  checkMesh(mesh);
  const { min, max } = usedBounds(mesh);
  const grid = voxelGridFor(min, max, N, o.margin ?? VOXELIZE_MARGIN);
  return voxelizeOnGrid(mesh, grid, o);
}

/** The voxelizer on a lattice the caller chooses (parts of the mesh beyond the lattice are simply not sampled). */
export function voxelizeMeshOnGrid(mesh: MeshLike, grid: VoxelGrid, o: Pick<VoxelizeOptions, 'band' | 'farField'> = {}): VoxelizeResult {
  checkMesh(mesh);
  const { dims, origin, voxel } = grid;
  if (!dims.every((n) => Number.isInteger(n) && n >= 2 && n <= MAX_GRID_SIDE)) throw new RangeError(`bad grid dims ${String(dims)}`);
  if (dims[0] * dims[1] * dims[2] > MAX_GRID_SAMPLES) throw new RangeError(`a ${dims.join('×')} lattice exceeds ${MAX_GRID_SAMPLES} samples`);
  if (!origin.every((c) => Number.isFinite(c)) || !(voxel > 0) || !Number.isFinite(voxel)) throw new RangeError('bad grid origin or voxel');
  return drain(voxelizeOnGrid(mesh, grid, o));
}

/** Triangles between two yields of the resumable voxelizer. */
const TRIANGLES_PER_YIELD = 2048;

function* voxelizeOnGrid(mesh: MeshLike, grid: VoxelGrid, o: Pick<VoxelizeOptions, 'band' | 'farField'>): Steps<VoxelizeResult> {
  const band = o.band ?? VOXELIZE_BAND;
  if (!(band >= 1) || !Number.isFinite(band)) throw new RangeError(`band must be a number >= 1 voxel, got ${band}`);
  if (o.farField !== undefined && o.farField !== 'edt' && o.farField !== 'sign') throw new RangeError(`unknown farField ${String(o.farField)}`);
  const [nx, ny, nz] = grid.dims;
  const { origin, voxel } = grid;
  const sxy = nx * ny;
  const total = sxy * nz;

  // Vertices in lattice units (double precision).
  const vc = mesh.positions.length / 3;
  const g = new Float64Array(vc * 3);
  for (let v = 0; v < vc; v++) {
    g[3 * v] = (mesh.positions[3 * v] - origin[0]) / voxel;
    g[3 * v + 1] = (mesh.positions[3 * v + 1] - origin[1]) / voxel;
    g[3 * v + 2] = (mesh.positions[3 * v + 2] - origin[2]) / voxel;
  }
  const idx = mesh.indices;
  const triCount = idx.length / 3;

  // ---- 1. exact band
  const band2 = band * band;
  const best = new Float32Array(total).fill(band2);
  let used = 0;
  for (let t = 0; t < triCount; t++) {
    if (t % TRIANGLES_PER_YIELD === TRIANGLES_PER_YIELD - 1) yield;
    const ia = idx[3 * t] * 3;
    const ib = idx[3 * t + 1] * 3;
    const ic = idx[3 * t + 2] * 3;
    const ax = g[ia];
    const ay = g[ia + 1];
    const az = g[ia + 2];
    const bx = g[ib];
    const by = g[ib + 1];
    const bz = g[ib + 2];
    const cx = g[ic];
    const cy = g[ic + 1];
    const cz = g[ic + 2];
    const abx = bx - ax;
    const aby = by - ay;
    const abz = bz - az;
    const acx = cx - ax;
    const acy = cy - ay;
    const acz = cz - az;
    let nxv = aby * acz - abz * acy;
    let nyv = abz * acx - abx * acz;
    let nzv = abx * acy - aby * acx;
    const nlen = Math.sqrt(nxv * nxv + nyv * nyv + nzv * nzv);
    if (!(nlen > 1e-12)) continue;
    used++;
    nxv /= nlen;
    nyv /= nlen;
    nzv /= nlen;
    const abab = abx * abx + aby * aby + abz * abz;
    const abac = abx * acx + aby * acy + abz * acz;
    const acac = acx * acx + acy * acy + acz * acz;
    const bcbc = acac - 2 * abac + abab;
    const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - band));
    const x1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) + band));
    const y0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - band));
    const y1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) + band));
    const z0 = Math.max(0, Math.ceil(Math.min(az, bz, cz) - band));
    const z1 = Math.min(nz - 1, Math.floor(Math.max(az, bz, cz) + band));
    for (let z = z0; z <= z1; z++) {
      const pz = z - az;
      for (let y = y0; y <= y1; y++) {
        const py = y - ay;
        const rowBase = y * nx + z * sxy;
        const sYZ = nyv * py + nzv * pz;
        const d1YZ = aby * py + abz * pz;
        const d2YZ = acy * py + acz * pz;
        const ppYZ = py * py + pz * pz;
        for (let x = x0; x <= x1; x++) {
          const px = x - ax;
          const s = nxv * px + sYZ;
          const s2 = s * s;
          const k = rowBase + x;
          const cur = best[k];
          if (s2 >= cur) continue;
          const d1 = abx * px + d1YZ;
          const d2 = acx * px + d2YZ;
          const pp = px * px + ppYZ;
          let dist2: number;
          if (d1 <= 0 && d2 <= 0) {
            dist2 = pp;
          } else {
            const d3 = d1 - abab;
            const d4 = d2 - abac;
            if (d3 >= 0 && d4 <= d3) {
              dist2 = pp - 2 * d1 + abab;
            } else {
              const vcc = d1 * d4 - d3 * d2;
              if (vcc <= 0 && d1 >= 0 && d3 <= 0) {
                dist2 = pp - (d1 * d1) / abab;
              } else {
                const d5 = d1 - abac;
                const d6 = d2 - acac;
                if (d6 >= 0 && d5 <= d6) {
                  dist2 = pp - 2 * d2 + acac;
                } else {
                  const vb = d5 * d2 - d1 * d6;
                  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
                    dist2 = pp - (d2 * d2) / acac;
                  } else {
                    const va = d3 * d6 - d5 * d4;
                    const e = d4 - d3;
                    if (va <= 0 && e >= 0 && d5 - d6 >= 0) {
                      dist2 = pp - 2 * d1 + abab - (e * e) / bcbc;
                    } else {
                      dist2 = s2;
                    }
                  }
                }
              }
            }
          }
          if (dist2 < 0) dist2 = 0;
          if (dist2 < cur) best[k] = dist2;
        }
      }
    }
  }

  // ---- 2. sign by scanline parity along +z
  const colCount = new Int32Array(sxy + 1);
  const scan = function* (write: Float64Array | null, offsets: Int32Array | null): Steps<void> {
    for (let t = 0; t < triCount; t++) {
      if (t % TRIANGLES_PER_YIELD === TRIANGLES_PER_YIELD - 1) yield;
      const va = idx[3 * t];
      const vb = idx[3 * t + 1];
      const vcI = idx[3 * t + 2];
      const ax = g[3 * va];
      const ay = g[3 * va + 1];
      const bx = g[3 * vb];
      const by = g[3 * vb + 1];
      const cx = g[3 * vcI];
      const cy = g[3 * vcI + 1];
      const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      if (area === 0 || area !== area) continue;
      const sigma = area > 0 ? 1 : -1;
      const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - RAY_OFFSET));
      const i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) - RAY_OFFSET));
      if (i0 > i1) continue;
      const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - RAY_OFFSET));
      const j1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) - RAY_OFFSET));
      if (j0 > j1) continue;
      for (let j = j0; j <= j1; j++) {
        const qy = j + RAY_OFFSET;
        for (let i = i0; i <= i1; i++) {
          const qx = i + RAY_OFFSET;
          // Oriented edge values in triangle order: w_ab (opposite c), w_bc (opposite a), w_ca (opposite b).
          const wab = edgeValue(g, va, vb, qx, qy, sigma);
          if (wab < 0) continue;
          const wbc = edgeValue(g, vb, vcI, qx, qy, sigma);
          if (wbc < 0) continue;
          const wca = edgeValue(g, vcI, va, qx, qy, sigma);
          if (wca < 0) continue;
          const col = i + nx * j;
          if (write && offsets) {
            const sum = Math.abs(wab) + Math.abs(wbc) + Math.abs(wca);
            // Barycentric weights from the edge values; tie-rule zeros (−0 / +0) are both fine here.
            const la = Math.abs(wbc) / sum;
            const lb = Math.abs(wca) / sum;
            const lc = Math.abs(wab) / sum;
            write[offsets[col]++] = la * g[3 * va + 2] + lb * g[3 * vb + 2] + lc * g[3 * vcI + 2];
          } else {
            colCount[col]++;
          }
        }
      }
    }
  };
  yield* scan(null, null);
  const start = new Int32Array(sxy + 1);
  for (let c = 0; c < sxy; c++) start[c + 1] = start[c] + colCount[c];
  const crossings = new Float64Array(start[sxy]);
  const cursor = start.slice(0, sxy);
  yield* scan(crossings, cursor);
  yield;

  // ---- combine band and sign
  const field = new Float32Array(total);
  let bandSamples = 0;
  let oddColumns = 0;
  for (let c = 0; c < sxy; c++) {
    const s = start[c];
    let e = start[c + 1];
    // insertion sort of this column's crossings
    for (let a = s + 1; a < e; a++) {
      const v = crossings[a];
      let b = a - 1;
      while (b >= s && crossings[b] > v) {
        crossings[b + 1] = crossings[b];
        b--;
      }
      crossings[b + 1] = v;
    }
    if ((e - s) % 2 === 1) {
      oddColumns++;
      e--;
    }
    let ptr = s;
    for (let z = 0; z < nz; z++) {
      while (ptr < e && crossings[ptr] < z) ptr++;
      const inside = (ptr - s) % 2 === 1;
      const k = c + z * sxy;
      const b2 = best[k];
      if (b2 < band2) {
        bandSamples++;
        const d = Math.sqrt(b2) * voxel;
        field[k] = inside ? d : -d;
      } else {
        field[k] = inside ? Infinity : -Infinity;
      }
    }
  }

  // ---- 3. far field
  yield;
  if (o.farField === 'sign') {
    const far = band * voxel;
    for (let k = 0; k < total; k++) if (!Number.isFinite(field[k])) field[k] = field[k] > 0 ? far : -far;
  } else if (bandSamples > 0) extendSignedDistance3d(field, grid.dims, { spacing: voxel });
  else for (let k = 0; k < total; k++) if (!Number.isFinite(field[k])) field[k] = field[k] > 0 ? (nx + ny + nz) * voxel : -(nx + ny + nz) * voxel;

  return {
    field,
    dims: [nx, ny, nz],
    origin: [origin[0], origin[1], origin[2]],
    voxel,
    stats: { triangles: used, bandSamples, oddColumns },
  };
}

/**
 * The value of the 2D edge function of the directed edge u→v at q, multiplied by the triangle's orientation σ:
 * positive on the triangle's inner side. It is computed on the canonically ordered edge (lower vertex index
 * first) so that the two triangles of a shared edge get bit-identical magnitudes; an exact zero is resolved by a
 * tie rule (returns +0 for the winning triangle, −1 for the other), so a ray through a shared edge is counted
 * once.
 */
function edgeValue(g: Float64Array, u: number, v: number, qx: number, qy: number, sigma: number): number {
  const lo = u < v ? u : v;
  const hi = u < v ? v : u;
  const s = u < v ? 1 : -1;
  const lx = g[3 * lo];
  const ly = g[3 * lo + 1];
  const dx = g[3 * hi] - lx;
  const dy = g[3 * hi + 1] - ly;
  const e = dx * (qy - ly) - dy * (qx - lx);
  if (e !== 0) return s * sigma * e;
  const dir = dy > 0 || (dy === 0 && dx > 0) ? 1 : -1;
  return s * sigma * dir > 0 ? 0 : -1;
}
