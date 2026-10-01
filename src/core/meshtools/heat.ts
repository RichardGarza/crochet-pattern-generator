// Track T5 — Path B steps 1–2 (DESIGN.md §2.10.7; research 03 §2.2, §6.2): the re-mesh before the heat method, the
// surface topology every Path B step shares, the cotan Laplacian and lumped mass, heat-method geodesic distance with
// t doubling while adjacent critical points remain, critical points, and the seed choice.
//
// Heat method (Crane, Weischedel & Wardetzky 2013), with L the PSD cotan Laplacian (L = −Δ) and M the lumped
// (barycentric) mass:
//   1. (M + tL)u = δ_sources                    sparse Cholesky (see sparse.ts for why not CG here)
//   2. X = −∇u/|∇u| per face
//   3. Lφ = −∇·X                                 sparse Cholesky of L pinned at a source (default; factored once,
//                                                so a t doubling costs one heat factorization), or Jacobi-PCG
//                                                (rel. tol 1e-8, ≤ 2000 iterations, ε·M) as §2.10.7 words it
//   4. shift so that min over the sources of φ = 0
// t = (mean edge)², raised to (D/600)² on very long parts (the kernel would underflow), doubled (≤ 6 times) while two
// critical points of φ lie within two edges of each other.
//
// Pure, synchronous, deterministic (no Math.random / Date; ties → lowest index).
import { remeshVolume } from './remesh';
import { MeshToolError } from './volume';
import { VOXELIZE_MARGIN, voxelizeMesh } from './voxelize';
import { nestedDissection, pcgJacobi, SparseCholesky, type PcgResult, type SymmetricPattern } from './sparse';
import { signedVolume, surfaceArea, type MeshLike } from '../kernel/geom/meshMeasures';
import type { IndexedMesh } from '../kernel/geom/marchingCubes';
import type { Vec3 } from '../../types/geometry';

/** Mean MC edge per voxel after 10 Taubin pairs (measured 0.91–0.93 on spheres and ellipsoids, N = 24–64). */
export const MC_EDGE_PER_VOXEL = 0.92;
/** Spec: t is doubled at most 6 times. */
export const MAX_T_DOUBLINGS = 6;
/** Spec: Jacobi-PCG relative tolerance and iteration cap of the Poisson solve. */
export const POISSON_TOL = 1e-8;
export const POISSON_MAX_ITER = 2000;
/** Two critical points at most this many edges apart are "adjacent" (t is doubled while any pair is). */
export const ADJACENT_CRITICAL_HOPS = 2;
/** Re-mesh lattice cap (samples on the longest side); a finer target edge is coarsened to fit, with a note. */
export const MAX_REMESH_N = 256;
/**
 * Vertex cap of the Path B re-mesh (§5.8: Path B < 2 s per part): a finer target edge is coarsened to fit, with
 * `coarsened: true`. 30 k vertices = a 6 in ball at worsted gauge.
 */
export const MAX_REMESH_VERTICES = 30_000;
/** Vertices ≈ area / (0.866·e²) for a closed mesh of near-equilateral triangles with mean edge e. */
const VERTICES_PER_AREA_E2 = Math.sqrt(3) / 2;
/** A re-mesh enclosing less than this many voxels³ is refused (`bad-mesh`). */
export const MIN_INSIDE_VOXELS = 8;

// ---------------------------------------------------------------------------------------------------------------
// Topology

/** A triangle mesh with the vertex graph, undirected edges and edge–face incidence every Path B step uses. */
export interface SurfaceMesh {
  positions: Float64Array;
  indices: Uint32Array;
  nv: number;
  nf: number;
  /** Vertex graph (CSR, both directions, diagonal included). */
  pattern: SymmetricPattern;
  /** CSR position → undirected edge id (−1 on the diagonal). */
  edgeAt: Int32Array;
  /** Edge e = (edges[2e], edges[2e+1]), first < second; ids ascending by (first, second). */
  edges: Int32Array;
  /** The two faces of edge e (−1 for a boundary edge). */
  edgeFaces: Int32Array;
  /** Edge ids of face f: (i0,i1), (i1,i2), (i2,i0). */
  faceEdges: Int32Array;
  /** Number of boundary edges (0 for a closed surface). */
  boundaryEdges: number;
  /** Interior edges whose two faces traverse them in the same direction (0 = consistently oriented). */
  misorientedEdges: number;
}

function checkMeshLike(mesh: MeshLike): void {
  const P = mesh.positions;
  const I = mesh.indices;
  if (P.length % 3 !== 0 || I.length % 3 !== 0) throw new RangeError('positions and indices must be multiples of 3');
  if (I.length === 0) throw new RangeError('empty mesh');
  for (let k = 0; k < P.length; k++) if (!Number.isFinite(P[k])) throw new RangeError('non-finite vertex');
  const nv = P.length / 3;
  for (let k = 0; k < I.length; k++) if (!(I[k] >= 0 && I[k] < nv && Number.isInteger(I[k]))) throw new RangeError(`index ${I[k]} out of range`);
}

/**
 * Builds the topology. Every vertex must be used by a triangle, no triangle may repeat a vertex, and every edge must
 * have at most two faces (RangeError otherwise; `cleanMesh` prepares an arbitrary mesh).
 */
export function surfaceMesh(mesh: MeshLike): SurfaceMesh {
  checkMeshLike(mesh);
  const nv = mesh.positions.length / 3;
  const nf = mesh.indices.length / 3;
  const indices = Uint32Array.from(mesh.indices);
  const positions = Float64Array.from(mesh.positions);
  // Neighbor lists via counting sort of directed half-edges.
  const deg = new Int32Array(nv + 1);
  for (let f = 0; f < nf; f++) {
    const a = indices[3 * f];
    const b = indices[3 * f + 1];
    const c = indices[3 * f + 2];
    if (a === b || b === c || c === a) throw new RangeError(`triangle ${f} repeats a vertex`);
    deg[a + 1] += 2;
    deg[b + 1] += 2;
    deg[c + 1] += 2;
  }
  for (let v = 0; v < nv; v++) if (deg[v + 1] === 0) throw new RangeError(`vertex ${v} is not used by any triangle`);
  for (let v = 0; v < nv; v++) deg[v + 1] += deg[v];
  const fill = Int32Array.from(deg);
  const nb = new Int32Array(deg[nv]);
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[3 * f + e];
      const b = indices[3 * f + ((e + 1) % 3)];
      nb[fill[a]++] = b;
      nb[fill[b]++] = a;
    }
  }
  // Sort + dedupe each row, add the diagonal.
  const rowPtr = new Int32Array(nv + 1);
  const rows: Int32Array[] = new Array(nv);
  for (let v = 0; v < nv; v++) {
    const r = nb.subarray(deg[v], deg[v + 1]).slice().sort();
    const u: number[] = [];
    let inserted = false;
    for (let k = 0; k < r.length; k++) {
      if (k > 0 && r[k] === r[k - 1]) continue;
      if (!inserted && r[k] > v) {
        u.push(v);
        inserted = true;
      }
      u.push(r[k]);
    }
    if (!inserted) u.push(v);
    rows[v] = Int32Array.from(u);
    rowPtr[v + 1] = rowPtr[v] + u.length;
  }
  const col = new Int32Array(rowPtr[nv]);
  const diag = new Int32Array(nv);
  for (let v = 0; v < nv; v++) {
    col.set(rows[v], rowPtr[v]);
    for (let k = rowPtr[v]; k < rowPtr[v + 1]; k++) if (col[k] === v) diag[v] = k;
  }
  const pattern: SymmetricPattern = { n: nv, rowPtr, col, diag };
  // Edge ids in (first, second) order.
  const edgeAt = new Int32Array(col.length).fill(-1);
  const edgeList: number[] = [];
  for (let v = 0; v < nv; v++) {
    for (let k = rowPtr[v]; k < rowPtr[v + 1]; k++) {
      if (col[k] > v) {
        edgeAt[k] = edgeList.length / 2;
        edgeList.push(v, col[k]);
      }
    }
  }
  for (let v = 0; v < nv; v++) {
    for (let k = rowPtr[v]; k < rowPtr[v + 1]; k++) {
      if (col[k] < v) edgeAt[k] = edgeAt[csrFind(pattern, col[k], v)];
    }
  }
  const ne = edgeList.length / 2;
  const edges = Int32Array.from(edgeList);
  const edgeFaces = new Int32Array(2 * ne).fill(-1);
  const faceEdges = new Int32Array(3 * nf);
  for (let f = 0; f < nf; f++) {
    for (let e = 0; e < 3; e++) {
      const a = indices[3 * f + e];
      const b = indices[3 * f + ((e + 1) % 3)];
      const id = edgeAt[csrFind(pattern, a, b)];
      faceEdges[3 * f + e] = id;
      if (edgeFaces[2 * id] === -1) edgeFaces[2 * id] = f;
      else if (edgeFaces[2 * id + 1] === -1) edgeFaces[2 * id + 1] = f;
      else throw new RangeError(`edge ${a}–${b} has more than two faces (non-manifold)`);
    }
  }
  let boundaryEdges = 0;
  let misorientedEdges = 0;
  for (let e = 0; e < ne; e++) {
    const f0 = edgeFaces[2 * e];
    const f1 = edgeFaces[2 * e + 1];
    if (f1 === -1) {
      boundaryEdges++;
      continue;
    }
    // does each face run first → second?
    const forward = (f: number): boolean => {
      for (let k = 0; k < 3; k++) if (faceEdges[3 * f + k] === e) return indices[3 * f + k] === edges[2 * e];
      return false;
    };
    if (forward(f0) === forward(f1)) misorientedEdges++;
  }
  return { positions, indices, nv, nf, pattern, edgeAt, edges, edgeFaces, faceEdges, boundaryEdges, misorientedEdges };
}

/** CSR position of (i, j); −1 when absent. Rows are short (≈ 7), so a linear scan. */
export function csrFind(p: SymmetricPattern, i: number, j: number): number {
  for (let k = p.rowPtr[i]; k < p.rowPtr[i + 1]; k++) if (p.col[k] === j) return k;
  return -1;
}

/** Edge id of (a, b); −1 when they are not adjacent. */
export function edgeId(sm: SurfaceMesh, a: number, b: number): number {
  const k = csrFind(sm.pattern, a, b);
  return k < 0 ? -1 : sm.edgeAt[k];
}

/**
 * Drops triangles that repeat a vertex and vertices no triangle uses, and keeps the connected component (through
 * shared vertices) with the largest area; ties → the component of the lowest vertex. Returns the new mesh and, per
 * new vertex, its old index.
 */
export function cleanMesh(mesh: MeshLike): { mesh: IndexedMesh; oldIndex: Int32Array; components: number } {
  checkMeshLike(mesh);
  const P = mesh.positions;
  const I = mesh.indices;
  const nv = P.length / 3;
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const keepTri: number[] = [];
  for (let f = 0; f < I.length / 3; f++) {
    const a = I[3 * f];
    const b = I[3 * f + 1];
    const c = I[3 * f + 2];
    if (a === b || b === c || a === c) continue;
    keepTri.push(f);
    const ra = find(a);
    const rb = find(b);
    const rc = find(c);
    const r = Math.min(ra, rb, rc);
    parent[ra] = r;
    parent[rb] = r;
    parent[rc] = r;
  }
  if (keepTri.length === 0) throw new RangeError('empty mesh');
  const area = new Map<number, number>();
  for (const f of keepTri) {
    const r = find(I[3 * f]);
    area.set(r, (area.get(r) ?? 0) + triArea(P, I[3 * f], I[3 * f + 1], I[3 * f + 2]));
  }
  let best = -1;
  let bestA = -1;
  for (const [r, a] of [...area.entries()].sort((x, y) => x[0] - y[0])) {
    if (a > bestA) {
      bestA = a;
      best = r;
    }
  }
  const newIndex = new Int32Array(nv).fill(-1);
  const old: number[] = [];
  const idx: number[] = [];
  for (const f of keepTri) {
    if (find(I[3 * f]) !== best) continue;
    for (let e = 0; e < 3; e++) {
      const v = I[3 * f + e];
      if (newIndex[v] < 0) {
        newIndex[v] = old.length;
        old.push(v);
      }
      idx.push(newIndex[v]);
    }
  }
  // Renumber in ascending old order (stable, independent of triangle order).
  const order = old.map((_, i) => i).sort((a, b) => old[a] - old[b]);
  const remap = new Int32Array(old.length);
  order.forEach((o, k) => (remap[o] = k));
  const positions = new Float32Array(old.length * 3);
  const oldIndex = new Int32Array(old.length);
  for (let k = 0; k < old.length; k++) {
    const v = old[order[k]];
    oldIndex[k] = v;
    positions[3 * k] = P[3 * v];
    positions[3 * k + 1] = P[3 * v + 1];
    positions[3 * k + 2] = P[3 * v + 2];
  }
  const indices = new Uint32Array(idx.length);
  for (let k = 0; k < idx.length; k++) indices[k] = remap[idx[k]];
  return { mesh: { positions, indices }, oldIndex, components: area.size };
}

/** Faces with area < this × (longest edge)² are left out of the operators (their cotangents are rounding noise). */
export const DEGENERATE_AREA = 1e-10;

/** The face's area, or 0 when it is degenerate (area < DEGENERATE_AREA·(longest edge)²). */
function operatorArea(P: ArrayLike<number>, a: number, b: number, c: number): number {
  const area = triArea(P, a, b, c);
  const d2 = (i: number, j: number): number => (P[3 * i] - P[3 * j]) ** 2 + (P[3 * i + 1] - P[3 * j + 1]) ** 2 + (P[3 * i + 2] - P[3 * j + 2]) ** 2;
  const longest = Math.max(d2(a, b), d2(b, c), d2(c, a));
  return area >= DEGENERATE_AREA * longest && area > 0 ? area : 0;
}

function triArea(P: ArrayLike<number>, a: number, b: number, c: number): number {
  const ux = P[3 * b] - P[3 * a];
  const uy = P[3 * b + 1] - P[3 * a + 1];
  const uz = P[3 * b + 2] - P[3 * a + 2];
  const vx = P[3 * c] - P[3 * a];
  const vy = P[3 * c + 1] - P[3 * a + 1];
  const vz = P[3 * c + 2] - P[3 * a + 2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/** Mean edge length (each undirected edge once). */
export function meanEdgeLength(sm: SurfaceMesh): number {
  const P = sm.positions;
  const ne = sm.edges.length / 2;
  let s = 0;
  for (let e = 0; e < ne; e++) {
    const a = sm.edges[2 * e];
    const b = sm.edges[2 * e + 1];
    s += Math.hypot(P[3 * a] - P[3 * b], P[3 * a + 1] - P[3 * b + 1], P[3 * a + 2] - P[3 * b + 2]);
  }
  return ne > 0 ? s / ne : 0;
}

// ---------------------------------------------------------------------------------------------------------------
// Re-mesh (§2.10.7 step 1)

export interface RemeshForPathBResult {
  mesh: IndexedMesh;
  /** The voxel the lattice used (inches). */
  voxel: number;
  /** Samples on the longest side. */
  N: number;
  /** The edge asked for and the mean edge obtained. */
  targetEdge: number;
  meanEdge: number;
  /** True when the lattice cap or the vertex cap coarsened the target edge. */
  coarsened: boolean;
  /** Components of the remeshed surface before keeping the largest. */
  components: number;
  /** Lattice columns with an odd number of crossings (> 0: the input was open; worth a warning). */
  oddColumns: number;
}

/**
 * §2.10.7 step 1: voxelize the part (narrow-band SDF), marching cubes, 10 Taubin pairs, at a voxel chosen so the
 * mean edge ≈ `targetEdge` (= min(w, h)/3 by the spec), then keep the largest component. Watertight, oriented,
 * manifold by construction (Step 0 MC guarantee). `MeshToolError('bad-mesh')` when nothing is inside.
 */
export function remeshForPathB(mesh: MeshLike, targetEdge: number, o: { maxVertices?: number } = {}): RemeshForPathBResult {
  if (!(targetEdge > 0) || !Number.isFinite(targetEdge)) throw new RangeError(`target edge must be > 0, got ${targetEdge}`);
  const maxVertices = o.maxVertices ?? MAX_REMESH_VERTICES;
  if (!(maxVertices >= 100) || !Number.isFinite(maxVertices)) throw new RangeError(`maxVertices must be >= 100, got ${maxVertices}`);
  checkMeshLike(mesh);
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < mesh.indices.length; k++) {
    const v = mesh.indices[k];
    for (let a = 0; a < 3; a++) {
      const c = mesh.positions[3 * v + a];
      if (c < lo[a]) lo[a] = c;
      if (c > hi[a]) hi[a] = c;
    }
  }
  const side = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  if (!(side > 0)) throw new MeshToolError('bad-mesh', 'the mesh has no extent');
  // A closed mesh of mean edge e has ≈ A/(0.866·e²) vertices: coarsen the edge so the count stays ≤ maxVertices
  // (the §5.8 budget; the input's area bounds the re-mesh's, noise only makes it coarser).
  let edge = Math.max(targetEdge, Math.sqrt(surfaceArea(mesh) / (VERTICES_PER_AREA_E2 * maxVertices)));
  let coarsened = edge > targetEdge;
  for (let attempt = 0; ; attempt++) {
    const wantVoxel = edge / MC_EDGE_PER_VOXEL;
    // voxelGridFor spaces the samples side/(N − 1 − 2·margin) apart (N counts the margin samples too).
    let N = Math.max(8 + 2 * VOXELIZE_MARGIN, Math.ceil(side / wantVoxel - 1e-9) + 1 + 2 * VOXELIZE_MARGIN);
    if (N > MAX_REMESH_N) {
      N = MAX_REMESH_N;
      coarsened = true;
    }
    const vol = voxelizeMesh(mesh, N);
    const raw = remeshVolume(vol, { pairs: 10 });
    const noInside = 'the part has no inside (open, flat or too thin for the re-mesh)';
    if (raw.indices.length === 0) throw new MeshToolError('bad-mesh', noInside);
    const cleaned = cleanMesh(raw);
    // A zero-volume input (a flat sheet) leaves only slivers around lattice samples that lie on it.
    if (signedVolume(cleaned.mesh) < MIN_INSIDE_VOXELS * vol.voxel ** 3) throw new MeshToolError('bad-mesh', noInside);
    const nv = cleaned.mesh.positions.length / 3;
    if (nv > 1.25 * maxVertices && attempt === 0 && N > 8 + 2 * VOXELIZE_MARGIN) {
      edge *= Math.sqrt(nv / maxVertices);
      coarsened = true;
      continue;
    }
    const sm = surfaceMesh(cleaned.mesh);
    return {
      mesh: cleaned.mesh,
      voxel: vol.voxel,
      N,
      targetEdge,
      meanEdge: meanEdgeLength(sm),
      coarsened,
      components: cleaned.components,
      oddColumns: vol.stats.oddColumns,
    };
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Operators

/**
 * Cotan Laplacian L (PSD, CSR values on `sm.pattern`) and lumped barycentric mass (area/3 per incident face).
 * Degenerate faces (`DEGENERATE_AREA`) count for the mass only.
 */
export function cotanLaplacian(sm: SurfaceMesh): { L: Float64Array; mass: Float64Array } {
  const P = sm.positions;
  const I = sm.indices;
  const L = new Float64Array(sm.pattern.col.length);
  const mass = new Float64Array(sm.nv);
  for (let f = 0; f < sm.nf; f++) {
    const v = [I[3 * f], I[3 * f + 1], I[3 * f + 2]];
    const full = triArea(P, v[0], v[1], v[2]);
    for (const x of v) mass[x] += full / 3;
    const area = operatorArea(P, v[0], v[1], v[2]);
    if (!(area > 0)) continue;
    for (let e = 0; e < 3; e++) {
      // angle at v[e], opposite edge (v[e+1], v[e+2])
      const o = v[e];
      const a = v[(e + 1) % 3];
      const b = v[(e + 2) % 3];
      const ux = P[3 * a] - P[3 * o];
      const uy = P[3 * a + 1] - P[3 * o + 1];
      const uz = P[3 * a + 2] - P[3 * o + 2];
      const wx = P[3 * b] - P[3 * o];
      const wy = P[3 * b + 1] - P[3 * o + 1];
      const wz = P[3 * b + 2] - P[3 * o + 2];
      const cot = (ux * wx + uy * wy + uz * wz) / (2 * area);
      const w = 0.5 * cot;
      const kab = csrFind(sm.pattern, a, b);
      const kba = csrFind(sm.pattern, b, a);
      L[kab] -= w;
      L[kba] -= w;
      L[sm.pattern.diag[a]] += w;
      L[sm.pattern.diag[b]] += w;
    }
  }
  return { L, mass };
}

/** Per-face unit gradient direction X = −∇u/|∇u| (0 where ∇u vanishes or the face is degenerate). */
export function normalizedNegGradient(sm: SurfaceMesh, u: Float64Array): Float64Array {
  const P = sm.positions;
  const I = sm.indices;
  const X = new Float64Array(3 * sm.nf);
  for (let f = 0; f < sm.nf; f++) {
    const g = faceGradient(P, I, f, u);
    const len = Math.hypot(g[0], g[1], g[2]);
    if (!(len > 0) || !Number.isFinite(len)) continue;
    X[3 * f] = -g[0] / len;
    X[3 * f + 1] = -g[1] / len;
    X[3 * f + 2] = -g[2] / len;
  }
  return X;
}

/** ∇u on face f: (1/2A) Σ_i u_i (N × e_i), e_i the edge opposite vertex i (CCW). Zero for a degenerate face. */
export function faceGradient(P: ArrayLike<number>, I: ArrayLike<number>, f: number, u: ArrayLike<number>): Vec3 {
  const i0 = I[3 * f];
  const i1 = I[3 * f + 1];
  const i2 = I[3 * f + 2];
  const ax = P[3 * i1] - P[3 * i0];
  const ay = P[3 * i1 + 1] - P[3 * i0 + 1];
  const az = P[3 * i1 + 2] - P[3 * i0 + 2];
  const bx = P[3 * i2] - P[3 * i0];
  const by = P[3 * i2 + 1] - P[3 * i0 + 1];
  const bz = P[3 * i2 + 2] - P[3 * i0 + 2];
  let nx = ay * bz - az * by;
  let ny = az * bx - ax * bz;
  let nz = ax * by - ay * bx;
  const n2 = Math.hypot(nx, ny, nz); // = 2A
  if (!(n2 > 0) || operatorArea(P, i0, i1, i2) === 0) return [0, 0, 0];
  nx /= n2;
  ny /= n2;
  nz /= n2;
  let gx = 0;
  let gy = 0;
  let gz = 0;
  const vs = [i0, i1, i2];
  for (let k = 0; k < 3; k++) {
    const p = vs[(k + 1) % 3];
    const q = vs[(k + 2) % 3];
    const ex = P[3 * q] - P[3 * p];
    const ey = P[3 * q + 1] - P[3 * p + 1];
    const ez = P[3 * q + 2] - P[3 * p + 2];
    const uk = u[vs[k]];
    gx += uk * (ny * ez - nz * ey);
    gy += uk * (nz * ex - nx * ez);
    gz += uk * (nx * ey - ny * ex);
  }
  return [gx / n2, gy / n2, gz / n2];
}

/** Integrated divergence of a per-face field: ½ Σ_faces [cot θ₁ (e₁·X) + cot θ₂ (e₂·X)] at each vertex (Crane). */
export function divergence(sm: SurfaceMesh, X: Float64Array): Float64Array {
  const P = sm.positions;
  const I = sm.indices;
  const div = new Float64Array(sm.nv);
  for (let f = 0; f < sm.nf; f++) {
    const xf = X[3 * f];
    const yf = X[3 * f + 1];
    const zf = X[3 * f + 2];
    if (xf === 0 && yf === 0 && zf === 0) continue;
    const v = [I[3 * f], I[3 * f + 1], I[3 * f + 2]];
    const area = operatorArea(P, v[0], v[1], v[2]);
    if (!(area > 0)) continue;
    for (let e = 0; e < 3; e++) {
      const i = v[e];
      const j = v[(e + 1) % 3];
      const k = v[(e + 2) % 3];
      // e1 = j − i (opposite angle at k), e2 = k − i (opposite angle at j)
      const e1x = P[3 * j] - P[3 * i];
      const e1y = P[3 * j + 1] - P[3 * i + 1];
      const e1z = P[3 * j + 2] - P[3 * i + 2];
      const e2x = P[3 * k] - P[3 * i];
      const e2y = P[3 * k + 1] - P[3 * i + 1];
      const e2z = P[3 * k + 2] - P[3 * i + 2];
      const cotK = cotAt(P, k, i, j, area);
      const cotJ = cotAt(P, j, k, i, area);
      div[i] += 0.5 * (cotK * (e1x * xf + e1y * yf + e1z * zf) + cotJ * (e2x * xf + e2y * yf + e2z * zf));
    }
  }
  return div;
}

/** cot of the angle at vertex o of the triangle (o, a, b) with area `area`. */
function cotAt(P: ArrayLike<number>, o: number, a: number, b: number, area: number): number {
  const ux = P[3 * a] - P[3 * o];
  const uy = P[3 * a + 1] - P[3 * o + 1];
  const uz = P[3 * a + 2] - P[3 * o + 2];
  const wx = P[3 * b] - P[3 * o];
  const wy = P[3 * b + 1] - P[3 * o + 1];
  const wz = P[3 * b + 2] - P[3 * o + 2];
  return (ux * wx + uy * wy + uz * wz) / (2 * area);
}

// ---------------------------------------------------------------------------------------------------------------
// Critical points

export interface CriticalPoints {
  /** Per vertex: 0 regular, −1 minimum, +1 maximum, k ≥ 2 a saddle of multiplicity k − 1 (2k sign changes). */
  kind: Int8Array;
  minima: number[];
  maxima: number[];
  saddles: number[];
}

/**
 * Critical vertices of a per-vertex function: count the sign changes of φ(neighbor) − φ(v) around the vertex's link
 * (each link edge of each incident face; ties broken by vertex index, a symbolic perturbation). 0 changes = an
 * extremum, 2 = regular, ≥ 4 = a saddle (§2.10.7). Boundary vertices are not classified.
 */
export function criticalPoints(sm: SurfaceMesh, phi: ArrayLike<number>): CriticalPoints {
  const I = sm.indices;
  const changes = new Int32Array(sm.nv);
  const above = (a: number, v: number): boolean => phi[a] > phi[v] || (phi[a] === phi[v] && a > v);
  const anyAbove = new Uint8Array(sm.nv);
  const anyBelow = new Uint8Array(sm.nv);
  const onBoundary = new Uint8Array(sm.nv);
  const ne = sm.edges.length / 2;
  for (let e = 0; e < ne; e++) {
    if (sm.edgeFaces[2 * e + 1] === -1) {
      onBoundary[sm.edges[2 * e]] = 1;
      onBoundary[sm.edges[2 * e + 1]] = 1;
    }
  }
  for (let f = 0; f < sm.nf; f++) {
    for (let e = 0; e < 3; e++) {
      const v = I[3 * f + e];
      const a = I[3 * f + ((e + 1) % 3)];
      const b = I[3 * f + ((e + 2) % 3)];
      const sa = above(a, v);
      const sb = above(b, v);
      if (sa !== sb) changes[v]++;
      if (sa || sb) anyAbove[v] = 1;
      if (!sa || !sb) anyBelow[v] = 1;
    }
  }
  const kind = new Int8Array(sm.nv);
  const minima: number[] = [];
  const maxima: number[] = [];
  const saddles: number[] = [];
  for (let v = 0; v < sm.nv; v++) {
    if (onBoundary[v]) continue;
    if (changes[v] === 0) {
      if (!anyBelow[v]) {
        kind[v] = -1;
        minima.push(v);
      } else if (!anyAbove[v]) {
        kind[v] = 1;
        maxima.push(v);
      }
    } else if (changes[v] >= 4) {
      kind[v] = Math.min(127, changes[v] / 2);
      saddles.push(v);
    }
  }
  return { kind, minima, maxima, saddles };
}

/** Pairs of critical vertices at most `hops` edges apart (each pair once, lower vertex first, ascending). */
export function adjacentCriticalPairs(sm: SurfaceMesh, crit: CriticalPoints, hops = ADJACENT_CRITICAL_HOPS): [number, number][] {
  const { rowPtr, col } = sm.pattern;
  const all = [...crit.minima, ...crit.maxima, ...crit.saddles].sort((a, b) => a - b);
  const pairs: [number, number][] = [];
  const seen = new Int32Array(sm.nv).fill(-1);
  for (const c of all) {
    let frontier = [c];
    seen[c] = c;
    for (let h = 0; h < hops; h++) {
      const next: number[] = [];
      for (const v of frontier) {
        for (let k = rowPtr[v]; k < rowPtr[v + 1]; k++) {
          const w = col[k];
          if (seen[w] === c) continue;
          seen[w] = c;
          next.push(w);
          if (crit.kind[w] !== 0 && w > c) pairs.push([c, w]);
        }
      }
      frontier = next;
    }
  }
  return pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

// ---------------------------------------------------------------------------------------------------------------
// Heat method

export interface HeatOptions {
  /** t of the first solve = tScale·(mean edge)² (spec: 1). */
  tScale?: number;
  /** Doublings allowed while adjacent critical points remain (spec: 6; 0 = a single solve). */
  maxDoublings?: number;
  /**
   * The Poisson solve: 'direct' (default; sparse Cholesky of L pinned at the first source, factored once per solver
   * and source, so each t doubling costs one heat factorization) or 'pcg' (Jacobi-PCG, rel. tol 1e-8, ≤ 2000
   * iterations, ε·M regularization, as §2.10.7 words it; falls back to the direct solve when it does not converge).
   */
  poisson?: 'direct' | 'pcg';
}

/**
 * The heat kernel decays like e^(−d/√t); at most this many √t from the sources keep u above the double range's
 * floor (e^(−600) ≈ 1e-261). t is raised to (D/600)², D = the farthest graph distance from the sources.
 */
export const FAR_FIELD_SQRT_T = 600;

export interface HeatResult {
  /** Geodesic distance per vertex, min over the sources = 0. */
  phi: Float64Array;
  /** The t of the returned φ, and how many times it was doubled. */
  t: number;
  doublings: number;
  /** The first t: max(tScale·(mean edge)², (D/600)²); `tFloored` when the far-field floor raised it. */
  t0: number;
  tFloored: boolean;
  meanEdge: number;
  critical: CriticalPoints;
  /** Adjacent critical pairs left in the returned φ (empty unless the doublings ran out). */
  adjacent: [number, number][];
  poisson: PcgResult;
  /** Total PCG iterations over every solve (0 with the direct Poisson solve). */
  pcgIterations: number;
}

/** Farthest edge-path distance from a set of vertices (multi-source Dijkstra; Infinity when some vertex is unreachable). */
export function graphEccentricity(sm: SurfaceMesh, sources: readonly number[]): number {
  const { rowPtr, col } = sm.pattern;
  const P = sm.positions;
  const dist = new Float64Array(sm.nv).fill(Infinity);
  const done = new Uint8Array(sm.nv);
  // binary heap of (d, v)
  const hk: number[] = [];
  const hv: number[] = [];
  const push = (d: number, v: number): void => {
    hk.push(d);
    hv.push(v);
    let i = hk.length - 1;
    while (i > 0) {
      const q = (i - 1) >> 1;
      if (hk[q] < hk[i] || (hk[q] === hk[i] && hv[q] <= hv[i])) break;
      [hk[q], hk[i]] = [hk[i], hk[q]];
      [hv[q], hv[i]] = [hv[i], hv[q]];
      i = q;
    }
  };
  const pop = (): [number, number] => {
    const top: [number, number] = [hk[0], hv[0]];
    const lk = hk.pop() as number;
    const lv = hv.pop() as number;
    if (hk.length > 0) {
      hk[0] = lk;
      hv[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < hk.length && (hk[l] < hk[m] || (hk[l] === hk[m] && hv[l] < hv[m]))) m = l;
        if (r < hk.length && (hk[r] < hk[m] || (hk[r] === hk[m] && hv[r] < hv[m]))) m = r;
        if (m === i) break;
        [hk[m], hk[i]] = [hk[i], hk[m]];
        [hv[m], hv[i]] = [hv[i], hv[m]];
        i = m;
      }
    }
    return top;
  };
  for (const s of sources) {
    dist[s] = 0;
    push(0, s);
  }
  let far = 0;
  while (hk.length > 0) {
    const [d, v] = pop();
    if (done[v]) continue;
    done[v] = 1;
    far = d;
    for (let k = rowPtr[v]; k < rowPtr[v + 1]; k++) {
      const w = col[k];
      if (done[w]) continue;
      const nd = d + Math.hypot(P[3 * w] - P[3 * v], P[3 * w + 1] - P[3 * v + 1], P[3 * w + 2] - P[3 * v + 2]);
      if (nd < dist[w]) {
        dist[w] = nd;
        push(nd, w);
      }
    }
  }
  for (let v = 0; v < sm.nv; v++) if (!done[v]) return Infinity;
  return far;
}

/**
 * The reusable heat-method machinery of one surface: operators, nested-dissection ordering and the Cholesky symbolic
 * analysis are built once; each t refactors numerically; the pinned Poisson factor is kept per pinned vertex.
 */
export class HeatSolver {
  readonly sm: SurfaceMesh;
  readonly meanEdge: number;
  private readonly L: Float64Array;
  private readonly mass: Float64Array;
  private readonly chol: SparseCholesky;
  private factoredT = NaN;
  private readonly poissonVal: Float64Array;
  private poissonChol: SparseCholesky | null = null;
  private pinned: SparseCholesky | null = null;
  private pinnedAt = -1;

  constructor(sm: SurfaceMesh) {
    this.sm = sm;
    this.meanEdge = meanEdgeLength(sm);
    const { L, mass } = cotanLaplacian(sm);
    this.L = L;
    this.mass = mass;
    for (let v = 0; v < sm.nv; v++) if (!(mass[v] > 0)) throw new RangeError(`vertex ${v} has no area (degenerate faces only)`);
    this.chol = new SparseCholesky(sm.pattern, nestedDissection(sm.pattern, sm.positions));
    // ε·M regularization of the PCG Poisson system: ε·M_ii ≈ 1e-10·L_ii on average.
    let trL = 0;
    let trM = 0;
    for (let v = 0; v < sm.nv; v++) {
      trL += L[sm.pattern.diag[v]];
      trM += mass[v];
    }
    const eps = (1e-10 * trL) / trM;
    this.poissonVal = Float64Array.from(L);
    for (let v = 0; v < sm.nv; v++) this.poissonVal[sm.pattern.diag[v]] += eps * mass[v];
  }

  /** Lumped vertex areas (a copy). */
  get vertexMass(): Float64Array {
    return Float64Array.from(this.mass);
  }

  /** Nonzeros of the Cholesky factor (diagnostics). */
  get factorNnz(): number {
    return this.chol.nnzL;
  }

  private factorAt(t: number): void {
    if (this.factoredT === t) return;
    const val = new Float64Array(this.L.length);
    for (let k = 0; k < val.length; k++) val[k] = t * this.L[k];
    for (let v = 0; v < this.sm.nv; v++) val[this.sm.pattern.diag[v]] += this.mass[v];
    if (!this.chol.factor(val)) {
      this.factoredT = NaN;
      throw new MeshToolError('bad-mesh', 'the heat system is not positive definite (degenerate mesh)');
    }
    this.factoredT = t;
  }

  /**
   * L pinned at vertex s: L + L_ss·e_s·e_sᵀ is positive definite on a connected surface, and for a right-hand side
   * summing to 0 its solution is exactly the solution of Lφ = b with φ_s = 0 (sum the rows: L_ss·φ_s = Σb = 0).
   */
  private pinnedFactor(s: number): SparseCholesky {
    if (this.pinned && this.pinnedAt === s) return this.pinned;
    const val = Float64Array.from(this.L);
    const d = this.sm.pattern.diag[s];
    val[d] += Math.max(val[d], 1e-300);
    const c = this.pinned ?? new SparseCholesky(this.sm.pattern, this.chol.perm);
    if (!c.factor(val)) throw new MeshToolError('bad-mesh', 'the Poisson system is not positive definite (disconnected or degenerate mesh)');
    this.pinned = c;
    this.pinnedAt = s;
    return c;
  }

  private residual(val: Float64Array, x: Float64Array, b: Float64Array): number {
    const { rowPtr, col } = this.sm.pattern;
    let r = 0;
    let bn = 0;
    for (let i = 0; i < this.sm.nv; i++) {
      let q = 0;
      for (let k = rowPtr[i]; k < rowPtr[i + 1]; k++) q += val[k] * x[col[k]];
      r += (q - b[i]) ** 2;
      bn += b[i] ** 2;
    }
    return bn > 0 ? Math.sqrt(r / bn) : 0;
  }

  /**
   * One heat-method solve at a given t from the source vertices. `warm` (optional) is an initial guess for the PCG
   * Poisson solve (the unshifted φ of a previous t). Returns φ shifted so min over the sources = 0, the unshifted
   * solution, and the Poisson report.
   */
  solveAt(
    sources: readonly number[],
    t: number,
    warm?: Float64Array,
    poissonMode: 'direct' | 'pcg' = 'direct',
  ): { phi: Float64Array; raw: Float64Array; poisson: PcgResult; underflow: number } {
    const sm = this.sm;
    if (sources.length === 0) throw new RangeError('no source vertex');
    for (const s of sources) if (!(Number.isInteger(s) && s >= 0 && s < sm.nv)) throw new RangeError(`source ${s} out of range`);
    if (!(t > 0) || !Number.isFinite(t)) throw new RangeError(`t must be > 0, got ${t}`);
    this.factorAt(t);
    const delta = new Float64Array(sm.nv);
    for (const s of sources) delta[s] = 1;
    const u = this.chol.solve(delta);
    let underflow = 0;
    for (let v = 0; v < sm.nv; v++) if (!(Math.abs(u[v]) > 0)) underflow++;
    const X = normalizedNegGradient(sm, u);
    const div = divergence(sm, X);
    // L φ = −div, with Σ rhs = 0 (the exact divergence sums to 0; remove the rounding).
    const b = new Float64Array(sm.nv);
    let mean = 0;
    for (let v = 0; v < sm.nv; v++) mean += div[v];
    mean /= sm.nv;
    for (let v = 0; v < sm.nv; v++) b[v] = -(div[v] - mean);
    let raw: Float64Array;
    let poisson: PcgResult;
    if (poissonMode === 'pcg') {
      raw = warm ? Float64Array.from(warm) : new Float64Array(sm.nv);
      poisson = pcgJacobi(sm.pattern, this.poissonVal, b, raw, POISSON_TOL, POISSON_MAX_ITER);
      if (!poisson.converged) {
        // Not converged in 2000 iterations (very large or badly shaped meshes): the direct solve on the same ordering.
        if (!this.poissonChol) {
          const c = new SparseCholesky(sm.pattern, this.chol.perm);
          if (!c.factor(this.poissonVal)) throw new MeshToolError('bad-mesh', 'the Poisson system is not positive definite (degenerate mesh)');
          this.poissonChol = c;
        }
        raw = this.poissonChol.solve(b);
        poisson = { ...poisson, direct: true };
      }
    } else {
      raw = this.pinnedFactor(sources[0]).solve(b);
      poisson = { iterations: 0, relResidual: this.residual(this.L, raw, b), converged: true, direct: true };
    }
    let shift = Infinity;
    for (const s of sources) shift = Math.min(shift, raw[s]);
    const phi = new Float64Array(sm.nv);
    for (let v = 0; v < sm.nv; v++) phi[v] = raw[v] - shift;
    return { phi, raw, poisson, underflow };
  }

  /**
   * §2.10.7 step 2: φ at t = (mean edge)² — raised to (D/600)² on parts longer than 600·√t so the heat kernel cannot
   * underflow —, doubled while adjacent critical points remain (≤ 6 times).
   */
  geodesic(sources: readonly number[], o: HeatOptions = {}): HeatResult {
    const tScale = o.tScale ?? 1;
    const maxD = o.maxDoublings ?? MAX_T_DOUBLINGS;
    if (!(tScale > 0) || !Number.isFinite(tScale)) throw new RangeError(`tScale must be > 0, got ${tScale}`);
    if (!Number.isInteger(maxD) || maxD < 0 || maxD > 30) throw new RangeError(`maxDoublings must be an integer in 0…30, got ${maxD}`);
    const mode = o.poisson ?? 'direct';
    if (mode !== 'direct' && mode !== 'pcg') throw new RangeError(`unknown Poisson solver ${String(mode)}`);
    const base = tScale * this.meanEdge * this.meanEdge;
    const D = graphEccentricity(this.sm, sources);
    if (!Number.isFinite(D)) throw new MeshToolError('bad-mesh', 'the surface is not connected');
    const floor = (D / FAR_FIELD_SQRT_T) ** 2;
    const t0 = Math.max(base, floor);
    let warm: Float64Array | undefined;
    let pcgIterations = 0;
    for (let d = 0; ; d++) {
      const t = t0 * 2 ** d;
      const r = this.solveAt(sources, t, warm, mode);
      pcgIterations += r.poisson.iterations;
      const critical = criticalPoints(this.sm, r.phi);
      const adjacent = adjacentCriticalPairs(this.sm, critical);
      // (an underflowed u — not expected above the far-field floor — is treated like an adjacent pair: double t)
      if ((adjacent.length === 0 && r.underflow === 0) || d >= maxD) {
        return { phi: r.phi, t, doublings: d, t0, tFloored: floor > base, meanEdge: this.meanEdge, critical, adjacent, poisson: r.poisson, pcgIterations };
      }
      warm = r.raw;
    }
  }
}

/** Convenience: geodesic distance from `sources` on `mesh` (builds the topology and a solver). */
export function heatGeodesic(mesh: MeshLike, sources: readonly number[], o: HeatOptions = {}): HeatResult {
  return new HeatSolver(surfaceMesh(mesh)).geodesic(sources, o);
}

// ---------------------------------------------------------------------------------------------------------------
// Seed (§2.10.7 step 1)

export interface SeedOptions {
  /** `crochet.seed` (part-local): the nearest vertex. */
  seed?: Vec3;
  /** Points of the attachment boundary (part-local): the seed is the vertex geodesically farthest from them. */
  attach?: readonly Vec3[];
  /** Up direction for a root part (lowest vertex = min along `up`); default +Y. */
  up?: Vec3;
}

export interface SeedChoice {
  vertex: number;
  rule: 'seed' | 'farthest-from-attach' | 'lowest';
}

/** Nearest vertex to p (ties → lowest index). */
export function nearestVertex(sm: SurfaceMesh, p: Vec3): number {
  if (!p.every((c) => Number.isFinite(c))) throw new RangeError('non-finite point');
  let best = -1;
  let bd = Infinity;
  const P = sm.positions;
  for (let v = 0; v < sm.nv; v++) {
    const d = (P[3 * v] - p[0]) ** 2 + (P[3 * v + 1] - p[1]) ** 2 + (P[3 * v + 2] - p[2]) ** 2;
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return best;
}

/**
 * The seed vertex: `seed` (nearest vertex) else the vertex geodesically farthest from the attachment points (heat
 * distance from their nearest vertices, one solve at the base t) else the lowest vertex along `up` (root part) —
 * for a flat bottom, the vertex nearest the center of the lowest patch (within one mean edge of the lowest height).
 * Ties → lowest index.
 */
export function chooseSeed(solver: HeatSolver, o: SeedOptions = {}): SeedChoice {
  const sm = solver.sm;
  if (o.seed) return { vertex: nearestVertex(sm, o.seed), rule: 'seed' };
  if (o.attach && o.attach.length > 0) {
    const src = [...new Set(o.attach.map((p) => nearestVertex(sm, p)))].sort((a, b) => a - b);
    const { phi } = solver.geodesic(src, { maxDoublings: 0 });
    let best = 0;
    for (let v = 1; v < sm.nv; v++) if (phi[v] > phi[best]) best = v;
    return { vertex: best, rule: 'farthest-from-attach' };
  }
  const up = o.up ?? [0, 1, 0];
  const len = Math.hypot(up[0], up[1], up[2]);
  if (!(len > 0) || !Number.isFinite(len)) throw new RangeError('bad up vector');
  const P = sm.positions;
  const height = new Float64Array(sm.nv);
  let low = 0;
  for (let v = 0; v < sm.nv; v++) {
    height[v] = (P[3 * v] * up[0] + P[3 * v + 1] * up[1] + P[3 * v + 2] * up[2]) / len;
    if (height[v] < height[low]) low = v;
  }
  // A flat bottom (a body standing on its base) has its lowest vertex anywhere on the base, typically on the rim:
  // take the connected patch within one mean edge of the lowest height and seed at its vertex nearest the patch's
  // area-weighted centroid (on a rounded bottom the patch is a small cap around the lowest vertex).
  const band = height[low] + solver.meanEdge;
  const { rowPtr, col } = sm.pattern;
  const inPatch = new Uint8Array(sm.nv);
  const patch = [low];
  inPatch[low] = 1;
  for (let q = 0; q < patch.length; q++) {
    const v = patch[q];
    for (let k = rowPtr[v]; k < rowPtr[v + 1]; k++) {
      const w = col[k];
      if (!inPatch[w] && height[w] <= band) {
        inPatch[w] = 1;
        patch.push(w);
      }
    }
  }
  const mass = solver.vertexMass;
  const c = [0, 0, 0];
  let m = 0;
  for (const v of patch) {
    for (let a = 0; a < 3; a++) c[a] += mass[v] * P[3 * v + a];
    m += mass[v];
  }
  let best = low;
  let bd = Infinity;
  for (const v of patch.sort((a, b) => a - b)) {
    const d = (P[3 * v] - c[0] / m) ** 2 + (P[3 * v + 1] - c[1] / m) ** 2 + (P[3 * v + 2] - c[2] / m) ** 2;
    if (d < bd) {
      bd = d;
      best = v;
    }
  }
  return { vertex: best, rule: 'lowest' };
}
