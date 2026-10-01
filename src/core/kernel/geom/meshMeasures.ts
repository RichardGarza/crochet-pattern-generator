// Measures of an indexed triangle mesh (DESIGN.md §2.9.5, §6.3 T3/T5 acceptance). Step 0 kernel: pure, no DOM.
//
// These are the checks the geometry tests are written with: "watertight (0 boundary / non-manifold edges),
// χ = 2, no zero-area triangles, volume > 0". They read a position buffer (x, y, z per vertex) and a triangle
// index buffer (three vertex indices per triangle) and never modify either. Winding convention (§0.1,
// right-handed): a triangle is counter-clockwise seen from OUTSIDE the solid, so `signedVolume` is positive.
//
// The measures that take only an index buffer allocate by the LARGEST index in it, not by the number of
// triangles: they are meant for meshes whose vertices are numbered 0 … V − 1.
import type { Vec3 } from '../../../types/geometry';

/** A position buffer and a triangle index buffer. `ColoredMesh` and the marching-cubes output both fit. */
export interface MeshLike {
  /** x, y, z per vertex. */
  positions: ArrayLike<number>;
  /** Three vertex indices per triangle. */
  indices: ArrayLike<number>;
}

export interface EdgeStats {
  /** Distinct undirected edges. */
  edges: number;
  /** Triangles with a repeated vertex index: not triangles at all. Their real edge still counts below. */
  degenerateTriangles: number;
  /** Edges used by exactly one triangle: the mesh has a hole there. */
  boundaryEdges: number;
  /** Edges used by three or more triangles. */
  nonManifoldEdges: number;
  /**
   * Edges used by exactly two triangles that run along it in the SAME direction: the two triangles disagree
   * about which side is outside. 0 on a consistently wound mesh.
   */
  misorientedEdges: number;
}

function triangleCount(indices: ArrayLike<number>): number {
  if (indices.length % 3 !== 0) throw new RangeError(`index buffer length ${indices.length} is not a multiple of 3`);
  return indices.length / 3;
}

function checkIndexRange(mesh: MeshLike): void {
  if (mesh.positions.length % 3 !== 0) {
    throw new RangeError(`position buffer length ${mesh.positions.length} is not a multiple of 3`);
  }
  const vertexCount = mesh.positions.length / 3;
  const { indices } = mesh;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!(v >= 0 && v < vertexCount) || !Number.isInteger(v)) {
      throw new RangeError(`index ${v} at ${i} is outside the ${vertexCount} vertices`);
    }
  }
}

/**
 * The enclosed volume of a closed, consistently wound mesh: positive when the triangles are counter-clockwise
 * seen from outside, negative when the mesh is inside out (manifold-3d accepts an inside-out mesh with status
 * `NoError`, so "volume > 0" is a separate check, §2.9.5 step 5).
 *
 * It is the sum of the signed tetrahedra (r, a, b, c) with r the first vertex the index buffer names, so the
 * result does not lose digits when the mesh is far from the origin. For an open mesh the sum depends on r and
 * means nothing.
 */
export function signedVolume(mesh: MeshLike): number {
  triangleCount(mesh.indices);
  checkIndexRange(mesh);
  const p = mesh.positions;
  const idx = mesh.indices;
  if (idx.length === 0) return 0;
  const rx = p[3 * idx[0]];
  const ry = p[3 * idx[0] + 1];
  const rz = p[3 * idx[0] + 2];
  let six = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = 3 * idx[t];
    const b = 3 * idx[t + 1];
    const c = 3 * idx[t + 2];
    const ax = p[a] - rx;
    const ay = p[a + 1] - ry;
    const az = p[a + 2] - rz;
    const bx = p[b] - rx;
    const by = p[b + 1] - ry;
    const bz = p[b + 2] - rz;
    const cx = p[c] - rx;
    const cy = p[c + 1] - ry;
    const cz = p[c + 2] - rz;
    six += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return six / 6;
}

/** Twice the area of triangle `t` (the length of its edge cross product). */
function doubleArea(p: ArrayLike<number>, idx: ArrayLike<number>, t: number): number {
  const a = 3 * idx[t];
  const b = 3 * idx[t + 1];
  const c = 3 * idx[t + 2];
  const ux = p[b] - p[a];
  const uy = p[b + 1] - p[a + 1];
  const uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a];
  const vy = p[c + 1] - p[a + 1];
  const vz = p[c + 2] - p[a + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  return Math.sqrt(nx * nx + ny * ny + nz * nz);
}

/** The sum of the triangle areas. */
export function surfaceArea(mesh: MeshLike): number {
  triangleCount(mesh.indices);
  checkIndexRange(mesh);
  let twice = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) twice += doubleArea(mesh.positions, mesh.indices, t);
  return twice / 2;
}

/**
 * The number of triangles whose area is at most `maxArea` (default 0: exactly degenerate — two corners at the
 * same position, three corners on one line, or a repeated vertex index). A NaN position counts as degenerate.
 */
export function countZeroAreaTriangles(mesh: MeshLike, maxArea = 0): number {
  triangleCount(mesh.indices);
  checkIndexRange(mesh);
  let count = 0;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    if (!(doubleArea(mesh.positions, mesh.indices, t) / 2 > maxArea)) count++;
  }
  return count;
}

/** The smallest triangle area: Infinity for a mesh without triangles, NaN as soon as one triangle has a NaN corner. */
export function minTriangleArea(mesh: MeshLike): number {
  triangleCount(mesh.indices);
  checkIndexRange(mesh);
  let min = Infinity;
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const area = doubleArea(mesh.positions, mesh.indices, t) / 2;
    if (area !== area) return NaN;
    if (area < min) min = area;
  }
  return min;
}

/** Validates an index buffer and returns the largest index in it (−1 for an empty buffer). */
function largestIndex(indices: ArrayLike<number>): number {
  triangleCount(indices);
  let max = -1;
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!(v >= 0) || !Number.isInteger(v)) throw new RangeError(`index ${v} at ${i} is not a vertex index`);
    if (v > max) max = v;
  }
  return max;
}

/** True when the triangle that starts at `t` names a vertex twice: it has no area and is not part of the surface. */
function isDegenerate(indices: ArrayLike<number>, t: number): boolean {
  return indices[t] === indices[t + 1] || indices[t + 1] === indices[t + 2] || indices[t + 2] === indices[t];
}

/**
 * Edge census of a triangle index buffer. A triangle that names a vertex twice is counted in
 * `degenerateTriangles` and otherwise ignored — here and in `eulerCharacteristic`, `countComponents` and
 * `countNonManifoldVertices`. O(T log T): the half-edges are sorted, not hashed, so the result never depends
 * on a hash order.
 */
export function edgeStats(indices: ArrayLike<number>): EdgeStats {
  const m = largestIndex(indices) + 1;
  // key = (lo·m + hi)·2 + direction must stay an exact integer in a double.
  if (2 * m * m >= Number.MAX_SAFE_INTEGER) throw new RangeError(`edgeStats: ${m} vertices are too many`);
  const keys = new Float64Array(indices.length);
  let n = 0;
  let degenerate = 0;
  for (let t = 0; t < indices.length; t += 3) {
    if (isDegenerate(indices, t)) {
      degenerate++;
      continue;
    }
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e];
      const b = indices[t + ((e + 1) % 3)];
      keys[n++] = a < b ? (a * m + b) * 2 : (b * m + a) * 2 + 1;
    }
  }
  const sorted = keys.subarray(0, n).sort();
  const stats: EdgeStats = { edges: 0, degenerateTriangles: degenerate, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 };
  let i = 0;
  while (i < n) {
    const edge = Math.floor(sorted[i] / 2);
    let j = i + 1;
    while (j < n && Math.floor(sorted[j] / 2) === edge) j++;
    const uses = j - i;
    stats.edges++;
    if (uses === 1) stats.boundaryEdges++;
    else if (uses > 2) stats.nonManifoldEdges++;
    else if (sorted[i] === sorted[i + 1]) stats.misorientedEdges++;
    i = j;
  }
  return stats;
}

/**
 * True when every edge is shared by exactly two triangles that agree on the outside, and no triangle names a
 * vertex twice: a closed, oriented surface. (A buffer without triangles is watertight too.)
 */
export function isWatertight(indices: ArrayLike<number>): boolean {
  const s = edgeStats(indices);
  return s.boundaryEdges === 0 && s.nonManifoldEdges === 0 && s.misorientedEdges === 0 && s.degenerateTriangles === 0;
}

/** The number of distinct vertices the index buffer names (vertices no triangle uses are not counted). */
export function countUsedVertices(indices: ArrayLike<number>): number {
  const seen = new Uint8Array(largestIndex(indices) + 1);
  let used = 0;
  for (let i = 0; i < indices.length; i++) {
    if (seen[indices[i]] === 0) {
      seen[indices[i]] = 1;
      used++;
    }
  }
  return used;
}

/**
 * Euler characteristic χ = V − E + F of the surface: F its triangles, E their edges, V their vertices
 * (degenerate triangles and vertices that only they use are left out). For a closed orientable surface
 * χ = 2·(components) − 2·(total genus): 2 for a sphere, 0 for a torus, 4 for two separate spheres.
 */
export function eulerCharacteristic(indices: ArrayLike<number>): number {
  const stats = edgeStats(indices);
  const seen = new Uint8Array(largestIndex(indices) + 1);
  let vertices = 0;
  for (let t = 0; t < indices.length; t += 3) {
    if (isDegenerate(indices, t)) continue;
    for (let c = 0; c < 3; c++) {
      if (seen[indices[t + c]] === 0) {
        seen[indices[t + c]] = 1;
        vertices++;
      }
    }
  }
  return vertices - stats.edges + (indices.length / 3 - stats.degenerateTriangles);
}

/** The number of connected pieces of the surface (triangles connected through shared vertices). */
export function countComponents(indices: ArrayLike<number>): number {
  // Union-find; the smaller root index wins, so the result does not depend on triangle order.
  const parent = new Int32Array(largestIndex(indices) + 1).fill(-1);
  const find = (v: number): number => {
    let root = v;
    while (parent[root] !== root) root = parent[root];
    while (parent[v] !== root) {
      const next = parent[v];
      parent[v] = root;
      v = next;
    }
    return root;
  };
  let components = 0;
  const touch = (v: number): number => {
    if (parent[v] === -1) {
      parent[v] = v;
      components++;
    }
    return find(v);
  };
  const union = (a: number, b: number): void => {
    if (a === b) return;
    if (a < b) parent[b] = a;
    else parent[a] = b;
    components--;
  };
  for (let t = 0; t < indices.length; t += 3) {
    if (isDegenerate(indices, t)) continue;
    const a = touch(indices[t]);
    union(a, touch(indices[t + 1]));
    union(find(indices[t]), touch(indices[t + 2]));
  }
  return components;
}

/**
 * The number of vertices where the surface is pinched: the triangles around the vertex form two or more
 * separate fans (two cones touching at their tips, for example) instead of one. Triangles belong to the same
 * fan when they share an edge that ends at the vertex. 0 on a manifold surface, with or without boundary.
 */
export function countNonManifoldVertices(indices: ArrayLike<number>): number {
  const vertexCount = largestIndex(indices) + 1;
  // Triangles around every vertex, in compressed rows.
  const offsets = new Uint32Array(vertexCount + 1);
  for (let t = 0; t < indices.length; t += 3) {
    if (isDegenerate(indices, t)) continue;
    for (let c = 0; c < 3; c++) offsets[indices[t + c] + 1]++;
  }
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  const around = new Uint32Array(offsets[vertexCount]);
  const fill = offsets.slice(0, vertexCount);
  for (let t = 0; t < indices.length; t += 3) {
    if (isDegenerate(indices, t)) continue;
    for (let c = 0; c < 3; c++) around[fill[indices[t + c]]++] = t;
  }
  // Per vertex: union the triangles that share a second vertex. `owner[w]` is the first local triangle seen
  // with neighbor w; `stamp[w] === v + 1` says the entry belongs to the current vertex.
  const owner = new Int32Array(vertexCount);
  const stamp = new Uint32Array(vertexCount);
  let parent = new Int32Array(16);
  let pinched = 0;
  for (let v = 0; v < vertexCount; v++) {
    const start = offsets[v];
    const count = offsets[v + 1] - start;
    if (count < 2) continue;
    if (count > parent.length) parent = new Int32Array(2 * count);
    for (let k = 0; k < count; k++) parent[k] = k;
    const find = (k: number): number => {
      while (parent[k] !== k) {
        parent[k] = parent[parent[k]];
        k = parent[k];
      }
      return k;
    };
    let fans = count;
    for (let k = 0; k < count; k++) {
      const t = around[start + k];
      for (let c = 0; c < 3; c++) {
        const w = indices[t + c];
        if (w === v) continue;
        if (stamp[w] !== v + 1) {
          stamp[w] = v + 1;
          owner[w] = k;
        } else {
          const a = find(owner[w]);
          const b = find(k);
          if (a !== b) {
            parent[b] = a;
            fans--;
          }
        }
      }
    }
    if (fans > 1) pinched++;
  }
  return pinched;
}

/**
 * The axis-aligned bounding box of a position buffer; `min` > `max` (±Infinity) when there are no vertices. A
 * NaN coordinate is skipped.
 */
export function meshBounds(positions: ArrayLike<number>): { min: Vec3; max: Vec3 } {
  if (positions.length % 3 !== 0) throw new RangeError(`position buffer length ${positions.length} is not a multiple of 3`);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = positions[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return { min, max };
}
