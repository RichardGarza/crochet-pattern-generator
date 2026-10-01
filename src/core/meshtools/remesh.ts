// Track T5 — remesh helpers of the mesh tools (DESIGN.md §2.9.8): a working volume → a closed mesh (Step 0 marching
// cubes + Taubin), and vertex labels carried from an old mesh to a new one by nearest vertex.
//
// §2.9.8 names a BVH for the nearest-vertex query; nearest VERTEX (not nearest triangle) is a point-cloud query, so
// this is a k-d tree of the source vertices: exact, deterministic (ties → lowest vertex index), without three.js.
import { marchingCubes, type IndexedMesh } from '../kernel/geom/marchingCubes';
import { TAUBIN_PAIRS, taubinSmooth } from '../kernel/geom/taubin';
import type { ColoredMesh } from '../../types/geometry';
import type { FieldVolume } from './volume';

/** Taubin pairs while a sculpt stroke is running (§2.9.8: MC + 3 pairs at ≤ 10 Hz). */
export const STROKE_TAUBIN_PAIRS = 3;
/** Taubin pairs at the end of a stroke, a cut, a merge or a conversion (§2.9.8, §2.9.5). */
export const FINAL_TAUBIN_PAIRS = TAUBIN_PAIRS;

/** Marching cubes (closed border) on the volume, then `pairs` Taubin pairs (default 10). Positions in the volume's frame. */
export function remeshVolume(v: FieldVolume, o: { pairs?: number } = {}): IndexedMesh {
  const mesh = marchingCubes(v.field, v.dims, { origin: v.origin, voxel: v.voxel });
  const pairs = o.pairs ?? FINAL_TAUBIN_PAIRS;
  if (pairs > 0 && mesh.indices.length > 0) taubinSmooth(mesh.positions, mesh.indices, { pairs });
  return mesh;
}

/**
 * Nearest-vertex index over a point set: a k-d tree (median splits on the widest axis, buckets of ≤ 8 points).
 * Exact; ties go to the lowest original index, so results do not depend on the tree's shape.
 */
export class NearestVertexIndex {
  private readonly pts: Float64Array;
  private readonly ids: Int32Array;
  private readonly order: Int32Array;
  // Per node: [lo, hi) range in `order`, split axis (−1 = leaf), split value, children.
  private readonly nLo: number[] = [];
  private readonly nHi: number[] = [];
  private readonly nAxis: number[] = [];
  private readonly nSplit: number[] = [];
  private readonly nLeft: number[] = [];
  private readonly nRight: number[] = [];
  readonly size: number;

  /**
   * `positions` = [x, y, z, …]; `keep(i)` (optional) leaves vertex i out of the index. Queries return the ORIGINAL
   * vertex index, or −1 when the index is empty. Non-finite vertices are left out.
   */
  constructor(positions: ArrayLike<number>, keep?: (i: number) => boolean) {
    const count = Math.floor(positions.length / 3);
    const sel: number[] = [];
    for (let i = 0; i < count; i++) {
      const x = positions[3 * i];
      const y = positions[3 * i + 1];
      const z = positions[3 * i + 2];
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) && (!keep || keep(i))) sel.push(i);
    }
    this.size = sel.length;
    this.ids = Int32Array.from(sel);
    this.pts = new Float64Array(sel.length * 3);
    for (let k = 0; k < sel.length; k++) for (let a = 0; a < 3; a++) this.pts[3 * k + a] = positions[3 * sel[k] + a];
    this.order = new Int32Array(sel.length);
    for (let k = 0; k < sel.length; k++) this.order[k] = k;
    if (sel.length > 0) this.build(0, sel.length);
  }

  private build(lo: number, hi: number): number {
    const node = this.nLo.length;
    this.nLo.push(lo);
    this.nHi.push(hi);
    this.nAxis.push(-1);
    this.nSplit.push(0);
    this.nLeft.push(-1);
    this.nRight.push(-1);
    if (hi - lo <= 8) return node;
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let k = lo; k < hi; k++) {
      const q = this.order[k];
      for (let a = 0; a < 3; a++) {
        const c = this.pts[3 * q + a];
        if (c < mn[a]) mn[a] = c;
        if (c > mx[a]) mx[a] = c;
      }
    }
    const ext = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
    const axis = ext[0] >= ext[1] && ext[0] >= ext[2] ? 0 : ext[1] >= ext[2] ? 1 : 2;
    if (!(ext[axis] > 0)) return node; // all points coincide: one leaf
    const pts = this.pts;
    const sub = Array.from(this.order.subarray(lo, hi)).sort((a, b) => pts[3 * a + axis] - pts[3 * b + axis] || a - b);
    this.order.set(sub, lo);
    const mid = (lo + hi) >> 1;
    this.nAxis[node] = axis;
    this.nSplit[node] = pts[3 * this.order[mid] + axis];
    const left = this.build(lo, mid);
    const right = this.build(mid, hi);
    this.nLeft[node] = left;
    this.nRight[node] = right;
    return node;
  }

  /** The original index of the vertex nearest to (x, y, z); ties → the lowest index; −1 when empty or not finite. */
  nearest(x: number, y: number, z: number): number {
    if (this.size === 0 || !(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z))) return -1;
    let bestD = Infinity;
    let bestK = -1;
    const q = [x, y, z];
    const stack: number[] = [0];
    const bound: number[] = [0];
    while (stack.length > 0) {
      const node = stack.pop() as number;
      const lb = bound.pop() as number;
      if (lb > bestD) continue;
      const axis = this.nAxis[node];
      if (axis < 0) {
        for (let k = this.nLo[node]; k < this.nHi[node]; k++) {
          const p = this.order[k];
          const dx = this.pts[3 * p] - x;
          const dy = this.pts[3 * p + 1] - y;
          const dz = this.pts[3 * p + 2] - z;
          const d = dx * dx + dy * dy + dz * dz;
          if (d < bestD || (d === bestD && this.ids[p] < this.ids[bestK])) {
            bestD = d;
            bestK = p;
          }
        }
        continue;
      }
      const diff = q[axis] - this.nSplit[node];
      const near = diff < 0 ? this.nLeft[node] : this.nRight[node];
      const far = diff < 0 ? this.nRight[node] : this.nLeft[node];
      // Far side first on the stack, so the near side is searched first.
      stack.push(far);
      bound.push(Math.max(lb, diff * diff));
      stack.push(near);
      bound.push(lb);
    }
    return bestK < 0 ? -1 : this.ids[bestK];
  }
}

/**
 * Labels (and `partId`, when the source has it) of each target vertex, from the nearest source vertex
 * (§2.9.8: "vertex labels transferred by nearest vertex"). Both meshes in the same frame.
 */
export function transferLabels(targetPositions: ArrayLike<number>, source: ColoredMesh): { labels: Uint8Array<ArrayBuffer>; partId?: Uint8Array<ArrayBuffer> } {
  const count = Math.floor(targetPositions.length / 3);
  const labels = new Uint8Array(count).fill(255);
  const partId = source.partId ? new Uint8Array(count) : undefined;
  if (source.positions.length === 0) return { labels, partId };
  const grid = new NearestVertexIndex(source.positions);
  for (let v = 0; v < count; v++) {
    const s = grid.nearest(targetPositions[3 * v], targetPositions[3 * v + 1], targetPositions[3 * v + 2]);
    if (s < 0) continue;
    labels[v] = source.labels[s] ?? 255;
    if (partId && source.partId) partId[v] = source.partId[s] ?? 0;
  }
  return partId ? { labels, partId } : { labels };
}

/** A remeshed volume with labels carried over from `previous` (when given; else every label 255 = unknown). */
export function coloredRemesh(v: FieldVolume, previous: ColoredMesh | undefined, o: { pairs?: number } = {}): ColoredMesh {
  const mesh = remeshVolume(v, o);
  if (!previous) return { positions: mesh.positions, indices: mesh.indices, labels: new Uint8Array(mesh.positions.length / 3).fill(255) };
  const t = transferLabels(mesh.positions, previous);
  return t.partId ? { positions: mesh.positions, indices: mesh.indices, labels: t.labels, partId: t.partId } : { positions: mesh.positions, indices: mesh.indices, labels: t.labels };
}
