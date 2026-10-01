// Track T5 — Path B step 5, the seam (DESIGN.md §2.10.7; research 03 §2.2 "Cut", §6.2 step 5): the Dijkstra edge
// path from the seed to argmax φ, and where it crosses each row's isoline (round k starts there).
//
// Deterministic: the heap orders by (distance, vertex index); argmax ties → lowest vertex.
import type { SurfaceMesh } from './heat';

/** Binary min-heap of (key, vertex), ties by vertex index. */
class MinHeap {
  private keys: number[] = [];
  private ids: number[] = [];
  get size(): number {
    return this.ids.length;
  }
  private less(i: number, j: number): boolean {
    return this.keys[i] < this.keys[j] || (this.keys[i] === this.keys[j] && this.ids[i] < this.ids[j]);
  }
  private swap(i: number, j: number): void {
    [this.keys[i], this.keys[j]] = [this.keys[j], this.keys[i]];
    [this.ids[i], this.ids[j]] = [this.ids[j], this.ids[i]];
  }
  push(key: number, id: number): void {
    this.keys.push(key);
    this.ids.push(id);
    let i = this.ids.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(i, p)) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.keys[0], this.ids[0]];
    const lk = this.keys.pop() as number;
    const li = this.ids.pop() as number;
    if (this.ids.length > 0) {
      this.keys[0] = lk;
      this.ids[0] = li;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.less(l, m)) m = l;
        if (r < this.ids.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

/** Dijkstra over mesh edges (Euclidean lengths) from `from`; returns distances and predecessors (−1 at the root). */
export function dijkstra(sm: SurfaceMesh, from: number): { dist: Float64Array; prev: Int32Array } {
  if (!(Number.isInteger(from) && from >= 0 && from < sm.nv)) throw new RangeError(`vertex ${from} out of range`);
  const { rowPtr, col } = sm.pattern;
  const P = sm.positions;
  const dist = new Float64Array(sm.nv).fill(Infinity);
  const prev = new Int32Array(sm.nv).fill(-1);
  const done = new Uint8Array(sm.nv);
  dist[from] = 0;
  const heap = new MinHeap();
  heap.push(0, from);
  while (heap.size > 0) {
    const [d, v] = heap.pop();
    if (done[v]) continue;
    done[v] = 1;
    for (let k = rowPtr[v]; k < rowPtr[v + 1]; k++) {
      const w = col[k];
      if (w === v || done[w]) continue;
      const nd = d + Math.hypot(P[3 * w] - P[3 * v], P[3 * w + 1] - P[3 * v + 1], P[3 * w + 2] - P[3 * v + 2]);
      // ties: keep the lower predecessor index, so the tree does not depend on visiting order beyond (d, index)
      if (nd < dist[w] || (nd === dist[w] && v < prev[w])) {
        dist[w] = nd;
        prev[w] = v;
        heap.push(nd, w);
      }
    }
  }
  return { dist, prev };
}

/** The vertex path from → to along the Dijkstra tree (inclusive); [] when `to` is unreachable. */
export function dijkstraPath(sm: SurfaceMesh, from: number, to: number): Int32Array {
  if (!(Number.isInteger(to) && to >= 0 && to < sm.nv)) throw new RangeError(`vertex ${to} out of range`);
  const { dist, prev } = dijkstra(sm, from);
  if (!Number.isFinite(dist[to])) return new Int32Array(0);
  const path: number[] = [];
  for (let v = to; v !== -1; v = prev[v]) path.push(v);
  return Int32Array.from(path.reverse());
}

/** argmax φ (ties → lowest vertex). */
export function argmaxVertex(phi: ArrayLike<number>): number {
  let best = 0;
  for (let v = 1; v < phi.length; v++) if (phi[v] > phi[best]) best = v;
  return best;
}

/** §2.10.7 step 5: the seam, the Dijkstra edge path from the seed to argmax φ. */
export function seamPath(sm: SurfaceMesh, phi: ArrayLike<number>, seed: number): Int32Array {
  return dijkstraPath(sm, seed, argmaxVertex(phi));
}

/**
 * The mesh edge where the seam first crosses the level (walking from the seed: the first path edge whose start is
 * below the level, φ < level, and whose end is on or above it); −1 when it never does.
 */
export function seamCrossingEdge(sm: SurfaceMesh, phi: ArrayLike<number>, path: ArrayLike<number>, level: number): number {
  for (let i = 0; i + 1 < path.length; i++) {
    const a = path[i];
    const b = path[i + 1];
    if (phi[a] < level && phi[b] >= level) {
      for (let k = sm.pattern.rowPtr[a]; k < sm.pattern.rowPtr[a + 1]; k++) if (sm.pattern.col[k] === b) return sm.edgeAt[k];
    }
  }
  return -1;
}
