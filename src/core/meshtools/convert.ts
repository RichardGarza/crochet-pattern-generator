// Track T5 — primitive → mesh ("Convert to sculptable mesh", DESIGN.md §2.9.8, §4.2) and mesh → primitive ("Fit
// primitive", §2.9.7 step 4, through T3's `fitPart`).
//
// Convert: the part's builder geometry (`partGeometry`, the same tessellation `buildModel` draws) → narrow-band
// voxelizer → marching cubes + 10 Taubin pairs, in the part's LOCAL frame, so the converted part keeps its
// `position`, `rotationDeg` and attach. The builder leaves some solids open (an open cylinder, a torus arc, a lathe
// whose profile does not reach the axis): their parity scan would be meaningless, so for those the lattice is
// sampled from the analytic SDF of §3.7.6 instead (which closes them the way every other kernel reads them).
// Labels: the palette index of each builder vertex (`vertexColorIds`: base color, regions, uv64 paint) carried to
// the new vertices by nearest vertex.
import { BufferGeometry } from 'three';
import { edgeStats } from '../kernel/geom/meshMeasures';
import { fitPart, type FitResult } from '../recon/fit';
import { partGeometry, vertexColorIds } from '../model/builder';
import { localSdf } from '../model/sdf';
import { localBounds } from '../model/transforms';
import type { ColoredMesh, Vec3 } from '../../types/geometry';
import type { Part } from '../../types/model';
import { coloredRemesh, FINAL_TAUBIN_PAIRS } from './remesh';
import { MAX_GRID_SIDE, VOXELIZE_N, voxelGridFor, voxelizeMeshOnGrid, type VoxelGrid } from './voxelize';
import { hasInside, MeshToolError, type FieldVolume } from './volume';

const UNKNOWN = 255;

/** Palette index of a palette id (255 when absent or beyond 254). */
export function paletteIndex(paletteIds: readonly string[] | undefined, id: string): number {
  if (!paletteIds) return UNKNOWN;
  const i = paletteIds.indexOf(id);
  return i >= 0 && i < UNKNOWN ? i : UNKNOWN;
}

function geometryBuffers(g: BufferGeometry): { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const src = g.attributes.position;
  const positions = new Float32Array(src.count * 3);
  for (let i = 0; i < src.count; i++) {
    positions[3 * i] = src.getX(i);
    positions[3 * i + 1] = src.getY(i);
    positions[3 * i + 2] = src.getZ(i);
  }
  const index = g.getIndex();
  const indices = new Uint32Array(index ? index.count : src.count);
  if (index) for (let i = 0; i < index.count; i++) indices[i] = index.getX(i);
  else for (let i = 0; i < src.count; i++) indices[i] = i;
  return { positions, indices };
}

/**
 * A primitive's builder geometry as a colored mesh in its LOCAL frame: labels = palette indices of the colors the
 * builder paints (base color, regions, uv64 paint), 255 without `paletteIds`. Mesh parts: their own buffer.
 */
export function primitiveColoredMesh(part: Part, paletteIds?: readonly string[]): ColoredMesh {
  const g = partGeometry(part, 1);
  try {
    const { positions, indices } = geometryBuffers(g);
    const labels = new Uint8Array(positions.length / 3);
    const ids = vertexColorIds(g, part, 1, { paletteIds });
    if (ids) for (let i = 0; i < labels.length; i++) labels[i] = paletteIndex(paletteIds, ids[i]);
    else labels.fill(paletteIndex(paletteIds, part.color));
    return { positions, indices, labels };
  } finally {
    g.dispose();
  }
}

/**
 * Indices with vertices at the same position merged (the builder duplicates seams, poles and caps; a seam's two
 * copies can differ in the last float bits, sin(2π) ≠ 0): positions are compared on a 1e-6 in lattice.
 */
export function weldIndices(positions: ArrayLike<number>, indices: ArrayLike<number>, tolerance = 1e-6): Uint32Array<ArrayBuffer> {
  const map = new Map<string, number>();
  const rep = new Uint32Array(positions.length / 3);
  const q = (c: number): number => Math.round(c / tolerance) + 0;
  for (let v = 0; v < rep.length; v++) {
    const key = `${q(positions[3 * v])},${q(positions[3 * v + 1])},${q(positions[3 * v + 2])}`;
    const prev = map.get(key);
    if (prev === undefined) {
      map.set(key, v);
      rep[v] = v;
    } else rep[v] = prev;
  }
  const out = new Uint32Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = rep[indices[i]];
  return out;
}

/** True when the welded mesh has no boundary or non-manifold edge (degenerate triangles are ignored). */
export function isClosedSurface(positions: ArrayLike<number>, indices: ArrayLike<number>): boolean {
  const s = edgeStats(weldIndices(positions, indices));
  return s.boundaryEdges === 0 && s.nonManifoldEdges === 0;
}

/** Samples the part's analytic local SDF on a lattice. */
function sampleLocalSdf(part: Part, grid: VoxelGrid): FieldVolume {
  const f = localSdf(part);
  const [nx, ny, nz] = grid.dims;
  const field = new Float32Array(nx * ny * nz);
  let i = 0;
  for (let z = 0; z < nz; z++) {
    const pz = grid.origin[2] + z * grid.voxel;
    for (let y = 0; y < ny; y++) {
      const py = grid.origin[1] + y * grid.voxel;
      for (let x = 0; x < nx; x++, i++) field[i] = f(grid.origin[0] + x * grid.voxel, py, pz);
    }
  }
  return { field, dims: [nx, ny, nz], origin: [grid.origin[0], grid.origin[1], grid.origin[2]], voxel: grid.voxel };
}

/** For each face of the lattice (−x, +x, −y, +y, −z, +z): whether an inside sample lies on it. */
function borderTouch(v: FieldVolume): boolean[] {
  const [nx, ny, nz] = v.dims;
  const out = [false, false, false, false, false, false];
  let i = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++, i++) {
        if (!(v.field[i] >= 0)) continue;
        if (x === 0) out[0] = true;
        if (x === nx - 1) out[1] = true;
        if (y === 0) out[2] = true;
        if (y === ny - 1) out[3] = true;
        if (z === 0) out[4] = true;
        if (z === nz - 1) out[5] = true;
      }
    }
  }
  return out;
}

export interface ConvertOptions {
  /** Samples along the longest side (default 96). */
  N?: number;
  /** The model's palette ids in order: labels are indices into it (§2.11.1). Without it every label is 255. */
  paletteIds?: readonly string[];
  /** Taubin pairs (default 10). */
  pairs?: number;
}

export interface ConvertResult {
  /** Part-local inches (the part keeps position and rotation). */
  mesh: ColoredMesh;
  /** The working volume (part-local): the sculpt session starts from it, no second voxelization. */
  volume: FieldVolume;
  /** How the volume was made. */
  source: 'voxelized' | 'analytic';
  /** Size of the new mesh's local bounding box (`dims.bboxIn` of the mesh part). */
  bboxIn: Vec3;
}

/** Primitive → mesh (`MeshApi.fromPart`). Throws `MeshToolError('not-a-primitive')` for a mesh or unknown part. */
export function convertPrimitive(part: Part, o: ConvertOptions = {}): ConvertResult {
  if (part.type === 'mesh') throw new MeshToolError('not-a-primitive', `${part.id} is already a mesh`);
  let builder: ColoredMesh;
  try {
    builder = primitiveColoredMesh(part, o.paletteIds);
  } catch {
    throw new MeshToolError('not-a-primitive', `cannot tessellate part ${String((part as { id?: unknown }).id)} of type ${String((part as { type?: unknown }).type)}`);
  }
  const b = localBounds(part);
  const N = o.N ?? VOXELIZE_N;
  if (!Number.isInteger(N) || N < 8 || N > MAX_GRID_SIDE) throw new RangeError(`N must be an integer in 8…${MAX_GRID_SIDE}, got ${N}`);
  // The builder box and the analytic box can differ (bevels): take both.
  const min: Vec3 = [b.min[0], b.min[1], b.min[2]];
  const max: Vec3 = [b.max[0], b.max[1], b.max[2]];
  for (let i = 0; i < builder.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], builder.positions[i + a]);
      max[a] = Math.max(max[a], builder.positions[i + a]);
    }
  }
  const closed = builder.indices.length > 0 && isClosedSurface(builder.positions, builder.indices);
  let grid = voxelGridFor(min, max, N);
  let volume: FieldVolume = closed ? voxelizeMeshOnGrid(builder, grid) : sampleLocalSdf(part, grid);
  // The analytic solid can reach beyond both boxes (a torus arc's round ends): grow the box on every side where an
  // inside sample touches the lattice border, and sample again.
  for (let attempt = 0; !closed && attempt < 6; attempt++) {
    const touch = borderTouch(volume);
    if (!touch.some((t) => t)) break;
    const grow = 0.25 * Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
    for (let a = 0; a < 3; a++) {
      if (touch[2 * a]) min[a] -= grow;
      if (touch[2 * a + 1]) max[a] += grow;
    }
    grid = voxelGridFor(min, max, N);
    volume = sampleLocalSdf(part, grid);
  }
  // Strip the voxelizer's stats so the volume is a plain FieldVolume.
  const plain: FieldVolume = { field: volume.field, dims: volume.dims, origin: volume.origin, voxel: volume.voxel };
  if (!hasInside(plain)) throw new MeshToolError('empty-result', `${part.id} is too thin to convert at N = ${N}`);
  const mesh = coloredRemesh(plain, builder, { pairs: o.pairs ?? FINAL_TAUBIN_PAIRS });
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < mesh.positions.length; i += 3) {
    lo = [Math.min(lo[0], mesh.positions[i]), Math.min(lo[1], mesh.positions[i + 1]), Math.min(lo[2], mesh.positions[i + 2])];
    hi = [Math.max(hi[0], mesh.positions[i]), Math.max(hi[1], mesh.positions[i + 1]), Math.max(hi[2], mesh.positions[i + 2])];
  }
  return { mesh, volume: plain, source: closed ? 'voxelized' : 'analytic', bboxIn: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}

/** `MeshApi.fromPart`: the converted mesh alone (part-local). */
export function meshFromPart(part: Part, o: ConvertOptions = {}): ColoredMesh {
  return convertPrimitive(part, o).mesh;
}

/**
 * Mesh → best primitive (`MeshApi.fit`): T3's `fitPart` (§2.9.7 step 4). Until T3 lands, `fitPart` is a Step 0 stub
 * and this throws its NotImplementedError.
 */
export function fitMeshPart(mesh: ColoredMesh, o?: { tolerance?: number }): FitResult {
  if (mesh.positions.length < 9 || mesh.indices.length < 3) throw new MeshToolError('bad-mesh', 'the mesh has no triangles to fit');
  return fitPart(mesh, o);
}

/**
 * Recenters a mesh part on its bounding-box center (§3.5.1: a mesh part's vertices are part-local with the origin
 * at the bbox center): returns the shifted mesh, the shift, and `bboxIn`. A part whose rotation is R gets
 * `position = oldPosition + R·center`.
 */
export function recenterMesh(mesh: ColoredMesh): { mesh: ColoredMesh; center: Vec3; bboxIn: Vec3 } {
  let lo: Vec3 = [Infinity, Infinity, Infinity];
  let hi: Vec3 = [-Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    lo = [Math.min(lo[0], p[i]), Math.min(lo[1], p[i + 1]), Math.min(lo[2], p[i + 2])];
    hi = [Math.max(hi[0], p[i]), Math.max(hi[1], p[i + 1]), Math.max(hi[2], p[i + 2])];
  }
  if (p.length === 0) return { mesh, center: [0, 0, 0], bboxIn: [0, 0, 0] };
  const c: Vec3 = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const positions = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    positions[i] = p[i] - c[0];
    positions[i + 1] = p[i + 1] - c[1];
    positions[i + 2] = p[i + 2] - c[2];
  }
  const out: ColoredMesh = { positions, indices: mesh.indices, labels: mesh.labels };
  if (mesh.partId) out.partId = mesh.partId;
  return { mesh: out, center: c, bboxIn: [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]] };
}
