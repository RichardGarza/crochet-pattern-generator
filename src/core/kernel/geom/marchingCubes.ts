// Indexed marching cubes (DESIGN.md §2.9.5 item 2, D11) [04 §6.1]. Step 0 kernel: pure, no DOM.
//
// The one mesher of the app: photo reconstruction (§2.9.3–2.9.5), sculpt / cut / merge (§2.9.8), Path B
// re-meshing (§2.10.7) and import repair all turn a sampled field into a triangle mesh with this function.
//
// Field convention (D11): POSITIVE INSIDE. The surface is the level `iso` (default 0); a sample exactly at the
// level counts as inside.
//
// Grid: `field[x + nx·(y + ny·z)]` is the sample with lattice index (x, y, z) — x runs fastest — and it sits at
// the POINT `origin + voxel·(x, y, z)`. Cells span neighboring samples, so an nx×ny×nz field has
// (nx−1)(ny−1)(nz−1) cells and the lattice covers `origin … origin + voxel·(dims − 1)`.
//
// What the output guarantees:
//   - One vertex per lattice edge that the surface crosses, keyed (axis, lower corner), shared by the up to
//     four cells around that edge: the mesh is indexed and closed without any welding pass.
//   - `t = (iso − f0)/(f1 − f0)` is clamped to [0.01, 0.99] and an exact zero of `f − iso` is replaced by 1e-6,
//     so no vertex sits on a lattice point and no triangle has zero area.
//   - Triangles are counter-clockwise seen from outside (right-handed axes): `signedVolume` is positive.
//   - With the default closed border the mesh is an oriented 2-manifold for EVERY input: each edge lies in
//     exactly two triangles that agree on the outside, and each vertex has one fan. (All sign patterns of the
//     four cells around a lattice edge were enumerated; manifold-3d accepts the result.) With an open border
//     the same holds except on the lattice box, where the surface simply ends.
//   - Every vertex is used by a triangle. Vertex and triangle order depend only on the field (x, then y, then
//     z scan), so the same input gives byte-identical buffers.
//   - Memory beyond the output is O(nx·ny): two z-slices are held at a time.
//
// Topology: `triTable` of three.js (Bourke's corner and edge numbering; bit set = corner below the level =
// outside). Its companion `edgeTable` is not needed: crossed edges are found from the samples themselves, and
// a test checks that both views agree. On a cell face whose corners alternate inside / outside / inside /
// outside the table always cuts off the two OUTSIDE corners, in both cells that share the face. So inside
// samples that are diagonal neighbors on a face (voxels sharing an edge) end up in one piece, while outside
// samples are connected through lattice edges only: flood the outside 6-connected when cleaning a volume
// (§2.9.5 item 1), or the mesh will have pieces the flood did not see.
//
// Positions are float32, and the 0.01-voxel clamp must survive that rounding or vertices fall together and
// triangles lose their area. A lattice whose largest |coordinate| / voxel reaches about 131 000 (2^17: there
// the float32 spacing passes 0.01 voxel) is therefore refused with a RangeError, as is one that does not fit
// float32 at all.
import { triTable } from 'three/addons/objects/MarchingCubes.js';
import type { SdfVolume, Vec3 } from '../../../types/geometry';
import { SDF_UNITS_PER_VOXEL } from './sdfVolume';

/** Lower clamp of the interpolation parameter along a crossed edge (§2.9.5 item 2). */
export const MC_T_MIN = 0.01;
/** Upper clamp of the interpolation parameter along a crossed edge. */
export const MC_T_MAX = 0.99;
/** What an exact zero of `field − iso` is replaced by (in field units): the sample counts as just inside. */
export const MC_ZERO_REPLACEMENT = 1e-6;

/** Values are limited to ±1e30 (so ±Infinity is usable as "deep inside" / "far outside" and never makes a NaN). */
const BIG = 1e30;

/** Number of samples along x, y and z. */
export type GridDims = readonly [number, number, number];

/** An indexed triangle mesh: x, y, z per vertex; three vertex indices per triangle, counter-clockwise from outside. */
export interface IndexedMesh {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
}

export interface MarchingCubesOptions {
  /** The level of the surface, in the units of the field. Inside is `field ≥ iso`. Default 0. */
  iso?: number;
  /** World position of sample (0, 0, 0). Default [0, 0, 0]. */
  origin?: Readonly<Vec3>;
  /** World distance between neighboring samples: one number, or one per axis. Must be positive. Default 1. */
  voxel?: number | Readonly<Vec3>;
  /**
   * What happens where the inside reaches the edge of the lattice.
   *
   * `'closed'` (default): the field is treated as if one more layer of far-outside samples surrounded it, so
   * the solid is cut flat at the lattice box and the mesh is always closed. The cap lies 0.01 voxel beyond the
   * outermost samples (the same clamp as every other vertex), so positions can exceed the lattice box by that
   * much — by half a voxel where a border sample is +Infinity.
   *
   * `'open'`: only real cells are meshed. Where the inside touches the edge of the lattice the mesh has a
   * hole (boundary edges on the lattice box). Use it only when every border sample is outside, or when an
   * open surface is wanted.
   */
  border?: 'closed' | 'open';
}

function checkDims(length: number, dims: GridDims): void {
  if (dims.length !== 3 || !dims.every((n) => Number.isInteger(n) && n >= 1)) {
    throw new RangeError(`grid dimensions must be three integers >= 1, got [${dims.join(', ')}]`);
  }
  const expected = dims[0] * dims[1] * dims[2];
  if (length !== expected) {
    throw new RangeError(`field has ${length} samples, expected ${dims[0]}×${dims[1]}×${dims[2]} = ${expected}`);
  }
}

/**
 * Meshes the level set `field = iso` of a sampled scalar field (positive inside).
 *
 * `field` may be any numeric array (Float32Array, Float64Array, Int16Array, …) and is not modified. Values:
 * +Infinity is "deep inside", −Infinity "far outside", and NaN is treated as far outside (a hole in the data
 * becomes a hole in the solid, never a NaN position).
 *
 * Returns exact-length, ArrayBuffer-backed buffers. An all-outside field gives an empty mesh; with
 * `border: 'open'` so do an all-inside field and a lattice that is a single sample thick (it has no cells).
 */
export function marchingCubes(field: ArrayLike<number>, dims: GridDims, options: MarchingCubesOptions = {}): IndexedMesh {
  checkDims(field.length, dims);
  const iso = options.iso ?? 0;
  if (!Number.isFinite(iso)) throw new RangeError(`iso must be a finite number, got ${iso}`);
  const origin = options.origin ?? [0, 0, 0];
  const voxel = options.voxel ?? 1;
  const vx = typeof voxel === 'number' ? voxel : voxel[0];
  const vy = typeof voxel === 'number' ? voxel : voxel[1];
  const vz = typeof voxel === 'number' ? voxel : voxel[2];
  for (const v of [vx, vy, vz]) {
    if (!(v > 0) || !Number.isFinite(v)) throw new RangeError(`voxel size must be a positive number, got ${String(voxel)}`);
  }
  if (origin.length !== 3 || !origin.every((v) => Number.isFinite(v))) {
    throw new RangeError(`origin must be three finite numbers, got [${origin.join(', ')}]`);
  }
  const border = options.border ?? 'closed';
  if (border !== 'closed' && border !== 'open') throw new RangeError(`border must be 'closed' or 'open', got ${String(border)}`);

  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];
  // Padded lattice: with a closed border, one virtual layer of far-outside samples on every side.
  const pad = border === 'closed' ? 1 : 0;
  const px = nx + 2 * pad;
  const py = ny + 2 * pad;
  const pz = nz + 2 * pad;
  const sliceSize = px * py;
  // A lattice with a single sample along some axis has no cells (only possible with an open border).
  if (px < 2 || py < 2 || pz < 2) return { positions: new Float32Array(0), indices: new Uint32Array(0) };
  // World position of padded index 0 along each axis.
  const ox = origin[0] - pad * vx;
  const oy = origin[1] - pad * vy;
  const oz = origin[2] - pad * vz;
  // Float32 positions: at the far corner of the box, neighboring floats must be less than the clamp apart.
  for (const [o, v, p] of [
    [ox, vx, px],
    [oy, vy, py],
    [oz, vz, pz],
  ]) {
    const far = Math.fround(Math.max(Math.abs(o), Math.abs(o + v * (p - 1))));
    if (!(Math.fround(far + 0.5 * MC_T_MIN * v) > far)) {
      throw new RangeError(
        `float32 positions cannot resolve 0.01 voxel on this lattice (origin [${origin.join(', ')}], voxel ${String(voxel)}): keep |coordinate| / voxel below 131 072`,
      );
    }
  }

  // Output buffers grow by doubling; the first guess is one slice worth of vertices.
  const guess = Math.min(16384, Math.max(64, sliceSize));
  let positions = new Float32Array(3 * guess);
  let vertexCount = 0;
  let indices = new Uint32Array(6 * guess);
  let indexCount = 0;

  const addVertex = (x: number, y: number, z: number): number => {
    const at = 3 * vertexCount;
    if (at + 3 > positions.length) {
      const grown = new Float32Array(2 * positions.length);
      grown.set(positions);
      positions = grown;
    }
    positions[at] = x;
    positions[at + 1] = y;
    positions[at + 2] = z;
    return vertexCount++;
  };

  /** Where the surface crosses the edge from a sample with value `a` to one with value `b` (opposite signs). */
  const crossing = (a: number, b: number): number => {
    const t = a / (a - b);
    return t < MC_T_MIN ? MC_T_MIN : t > MC_T_MAX ? MC_T_MAX : t;
  };

  // Two z-slices of: value − iso (sanitized), outside flag, and the vertex on the x- and y-edge that starts
  // at each sample. `zEdge` is the vertex on the z-edge between the two slices; `code` packs both flags.
  let d0 = new Float64Array(sliceSize);
  let d1 = new Float64Array(sliceSize);
  let out0 = new Uint8Array(sliceSize);
  let out1 = new Uint8Array(sliceSize);
  let xEdge0 = new Int32Array(sliceSize);
  let xEdge1 = new Int32Array(sliceSize);
  let yEdge0 = new Int32Array(sliceSize);
  let yEdge1 = new Int32Array(sliceSize);
  const zEdge = new Int32Array(sliceSize);
  const code = new Uint8Array(sliceSize);

  /** Loads padded slice `zi` and creates the vertices on its x- and y-edges. Returns false for an all-outside slice. */
  const loadSlice = (zi: number, d: Float64Array, out: Uint8Array, xEdge: Int32Array, yEdge: Int32Array): boolean => {
    const z = zi - pad;
    if (z < 0 || z >= nz) {
      d.fill(-BIG);
      out.fill(1);
      return false;
    }
    let anyInside = false;
    let src = z * nx * ny;
    let i = 0;
    for (let yi = 0; yi < py; yi++) {
      const y = yi - pad;
      if (y < 0 || y >= ny) {
        for (let xi = 0; xi < px; xi++, i++) {
          d[i] = -BIG;
          out[i] = 1;
        }
        continue;
      }
      if (pad === 1) {
        d[i] = -BIG;
        out[i] = 1;
        i++;
      }
      for (let x = 0; x < nx; x++, i++) {
        let v = field[src++] - iso;
        if (!(v > -BIG)) v = -BIG;
        else if (v > BIG) v = BIG;
        else if (v === 0) v = MC_ZERO_REPLACEMENT;
        d[i] = v;
        if (v < 0) {
          out[i] = 1;
        } else {
          out[i] = 0;
          anyInside = true;
        }
      }
      if (pad === 1) {
        d[i] = -BIG;
        out[i] = 1;
        i++;
      }
    }
    if (!anyInside) return false;
    const wz = oz + vz * zi;
    for (let yi = 0; yi < py; yi++) {
      const row = yi * px;
      const wy = oy + vy * yi;
      const hasUp = yi + 1 < py;
      for (let xi = 0; xi < px; xi++) {
        const at = row + xi;
        const a = out[at];
        if (xi + 1 < px && a !== out[at + 1]) {
          xEdge[at] = addVertex(ox + vx * (xi + crossing(d[at], d[at + 1])), wy, wz);
        }
        if (hasUp && a !== out[at + px]) {
          yEdge[at] = addVertex(ox + vx * xi, oy + vy * (yi + crossing(d[at], d[at + px])), wz);
        }
      }
    }
    return true;
  };

  let inside0 = loadSlice(0, d0, out0, xEdge0, yEdge0);
  for (let zi = 0; zi + 1 < pz; zi++) {
    const inside1 = loadSlice(zi + 1, d1, out1, xEdge1, yEdge1);
    if (inside0 || inside1) {
      // Vertices on the z-edges between the two slices, and the two outside flags of every column.
      for (let yi = 0; yi < py; yi++) {
        const row = yi * px;
        const wy = oy + vy * yi;
        for (let xi = 0; xi < px; xi++) {
          const at = row + xi;
          const a = out0[at];
          const b = out1[at];
          code[at] = a | (b << 4);
          if (a !== b) zEdge[at] = addVertex(ox + vx * xi, wy, oz + vz * (zi + crossing(d0[at], d1[at])));
        }
      }
      for (let yi = 0; yi + 1 < py; yi++) {
        let at = yi * px;
        // Bourke corners: 0 (0,0,0) 1 (1,0,0) 2 (1,1,0) 3 (0,1,0) 4 (0,0,1) 5 (1,0,1) 6 (1,1,1) 7 (0,1,1); bit k
        // of the cube index is set when corner k is outside. `left` holds the column at (x, y) in bits 0/4
        // (corners 0/4) and the column at (x, y+1) in bits 3/7 (corners 3/7); `right` holds the two columns
        // at x+1 the same way, and moves to bits 1/5 and 2/6 (corners 1/5 and 2/6).
        let left = code[at] | (code[at + px] << 3);
        for (let xi = 0; xi + 1 < px; xi++, at++) {
          const right = code[at + 1] | (code[at + px + 1] << 3);
          const cube = left | ((right & 0x11) << 1) | ((right & 0x88) >> 1);
          left = right;
          if (cube === 0 || cube === 255) continue;
          // The table lists each triangle counter-clockwise seen from the outside (the side of the set bits).
          for (let k = cube << 4; triTable[k] !== -1; k++) {
            if (indexCount === indices.length) {
              const grown = new Uint32Array(2 * indices.length);
              grown.set(indices);
              indices = grown;
            }
            let vertex: number;
            switch (triTable[k]) {
              // Edges 0–3: the lower slice; 4–7: the upper slice; 8–11: the z-edges between them.
              case 0:
                vertex = xEdge0[at];
                break;
              case 1:
                vertex = yEdge0[at + 1];
                break;
              case 2:
                vertex = xEdge0[at + px];
                break;
              case 3:
                vertex = yEdge0[at];
                break;
              case 4:
                vertex = xEdge1[at];
                break;
              case 5:
                vertex = yEdge1[at + 1];
                break;
              case 6:
                vertex = xEdge1[at + px];
                break;
              case 7:
                vertex = yEdge1[at];
                break;
              case 8:
                vertex = zEdge[at];
                break;
              case 9:
                vertex = zEdge[at + 1];
                break;
              case 10:
                vertex = zEdge[at + px + 1];
                break;
              default:
                vertex = zEdge[at + px];
                break;
            }
            indices[indexCount++] = vertex;
          }
        }
      }
    }
    // The upper slice becomes the lower slice of the next slab.
    const d = d0;
    d0 = d1;
    d1 = d;
    const out = out0;
    out0 = out1;
    out1 = out;
    const xe = xEdge0;
    xEdge0 = xEdge1;
    xEdge1 = xe;
    const ye = yEdge0;
    yEdge0 = yEdge1;
    yEdge1 = ye;
    inside0 = inside1;
  }

  return { positions: positions.slice(0, 3 * vertexCount), indices: indices.slice(0, indexCount) };
}

/**
 * Meshes a stored part volume (`SdfVolume`: Int16, voxel/256 units, positive inside; layout and placement in
 * ./sdfVolume.ts). Positions are in the volume's frame and units (inches): sample (x, y, z) is at
 * `volume.origin + volume.voxel·(x, y, z)`.
 *
 * `iso` is a signed distance in inches: 0 (default) is the stored surface, a positive value the surface moved
 * inward by that much, a negative value outward.
 */
export function marchingCubesSdf(volume: SdfVolume, options: Pick<MarchingCubesOptions, 'iso' | 'border'> = {}): IndexedMesh {
  if (!(volume.voxel > 0) || !Number.isFinite(volume.voxel)) {
    throw new RangeError(`voxel size must be a positive number, got ${volume.voxel}`);
  }
  return marchingCubes(volume.data, volume.dims, {
    iso: ((options.iso ?? 0) / volume.voxel) * SDF_UNITS_PER_VOXEL,
    origin: volume.origin,
    voxel: volume.voxel,
    border: options.border,
  });
}
