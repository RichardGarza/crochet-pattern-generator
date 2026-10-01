// Taubin λ|μ smoothing (DESIGN.md §2.9.5 item 3, §2.9.8) [04 §6.3]. Step 0 kernel: pure, no DOM.
//
// One "pair" is a shrinking step p ← p + λ·L(p) followed by an un-shrinking step p ← p + μ·L(p), where L(p) at
// a vertex is the mean of its neighbors minus the vertex (the uniform "umbrella" Laplacian; neighbors are the
// vertices it shares an edge with, each counted once). With μ < −λ < 0 the pair is a low-pass filter that does
// not shrink the shape the way plain Laplacian smoothing does. The defaults are Taubin's (SIGGRAPH 95):
// pass-band k = 1/λ + 1/μ = 0.1 with λ = 0.6307, hence μ = −0.6732.
//
// Only positions move: the index buffer is read, never written, so the topology (and watertightness) of the
// mesh is exactly what it was.
//
// What it does to the volume: ten pairs change a marching-cubes sphere of radius 23 voxels or more by less
// than 0.1%. The filter cannot tell a small feature from noise, though: below a radius of about 4 voxels the
// change passes 2% (thin ears and tails are what §2.9.5 item 5 flags as "crochet flat").

/** Default number of λ|μ pairs (§2.9.5 item 3). Sculpting uses 3 while a stroke is in progress (§2.9.8). */
export const TAUBIN_PAIRS = 10;
/** Shrinking factor λ. */
export const TAUBIN_LAMBDA = 0.6307;
/** Un-shrinking factor μ (negative, |μ| > λ). */
export const TAUBIN_MU = -0.6732;

export interface TaubinOptions {
  /** Number of λ|μ pairs; an integer ≥ 0. Default 10. */
  pairs?: number;
  /** Default 0.6307. */
  lambda?: number;
  /** Default −0.6732. */
  mu?: number;
}

/** Vertex neighbors in compressed rows: the neighbors of vertex v are `neighbors[offsets[v] … offsets[v + 1])`. */
export interface VertexAdjacency {
  /** Length vertexCount + 1. */
  offsets: Uint32Array<ArrayBuffer>;
  /** Each neighbor once, ascending within a vertex. */
  neighbors: Uint32Array<ArrayBuffer>;
}

/**
 * The vertices each vertex shares an edge with, each once, sorted ascending — for any triangle soup: open,
 * non-manifold or inconsistently wound meshes included. A triangle with a repeated index contributes its real
 * edges only. O(T).
 */
export function vertexAdjacency(indices: ArrayLike<number>, vertexCount: number): VertexAdjacency {
  if (indices.length % 3 !== 0) throw new RangeError(`index buffer length ${indices.length} is not a multiple of 3`);
  if (!Number.isInteger(vertexCount) || vertexCount < 0) throw new RangeError(`vertexCount must be an integer >= 0, got ${vertexCount}`);
  // Pass 1: count the half-edges leaving every vertex (both directions of every triangle edge).
  const offsets = new Uint32Array(vertexCount + 1);
  for (let i = 0; i < indices.length; i++) {
    const v = indices[i];
    if (!(v >= 0 && v < vertexCount) || !Number.isInteger(v)) {
      throw new RangeError(`index ${v} at ${i} is outside the ${vertexCount} vertices`);
    }
    offsets[v + 1] += 2;
  }
  for (let v = 0; v < vertexCount; v++) offsets[v + 1] += offsets[v];
  // Pass 2: fill the rows (with duplicates: an interior edge is seen from both of its triangles).
  const raw = new Uint32Array(offsets[vertexCount]);
  const fill = offsets.slice(0, vertexCount);
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    raw[fill[a]++] = b;
    raw[fill[a]++] = c;
    raw[fill[b]++] = c;
    raw[fill[b]++] = a;
    raw[fill[c]++] = a;
    raw[fill[c]++] = b;
  }
  // Pass 3: sort every row, drop duplicates and the vertex itself. Rows are a dozen entries on a regular
  // mesh (insertion sort); the hub of a large fan gets the library sort instead of a quadratic one.
  const neighbors = new Uint32Array(raw.length);
  const compact = new Uint32Array(vertexCount + 1);
  let write = 0;
  for (let v = 0; v < vertexCount; v++) {
    const start = offsets[v];
    const end = offsets[v + 1];
    if (end - start > 64) {
      raw.subarray(start, end).sort();
    } else {
      for (let i = start + 1; i < end; i++) {
        const x = raw[i];
        let j = i - 1;
        while (j >= start && raw[j] > x) {
          raw[j + 1] = raw[j];
          j--;
        }
        raw[j + 1] = x;
      }
    }
    compact[v] = write;
    let last = -1;
    for (let i = start; i < end; i++) {
      const x = raw[i];
      if (x === last || x === v) continue;
      neighbors[write++] = x;
      last = x;
    }
  }
  compact[vertexCount] = write;
  return { offsets: compact, neighbors: neighbors.slice(0, write) };
}

/**
 * Smooths `positions` IN PLACE with `pairs` Taubin λ|μ pairs and returns the same array. `indices` is only
 * read.
 *
 * Every step uses the positions of the previous step for all vertices (simultaneous update), and the work is
 * done in double precision and rounded to the array's precision once at the end. A vertex without neighbors
 * stays where it is. Boundary vertices of an open mesh are smoothed like any other vertex (they are not
 * pinned); the meshes of this app are closed. Positions are not validated: a NaN spreads to the neighbors of
 * its vertex, one ring per step.
 */
export function taubinSmooth<P extends Float32Array | Float64Array>(positions: P, indices: ArrayLike<number>, options: TaubinOptions = {}): P {
  const pairs = options.pairs ?? TAUBIN_PAIRS;
  const lambda = options.lambda ?? TAUBIN_LAMBDA;
  const mu = options.mu ?? TAUBIN_MU;
  if (!Number.isInteger(pairs) || pairs < 0) throw new RangeError(`pairs must be an integer >= 0, got ${pairs}`);
  if (!Number.isFinite(lambda) || !Number.isFinite(mu)) throw new RangeError(`lambda and mu must be finite, got ${lambda}, ${mu}`);
  if (positions.length % 3 !== 0) throw new RangeError(`position buffer length ${positions.length} is not a multiple of 3`);
  const vertexCount = positions.length / 3;
  const { offsets, neighbors } = vertexAdjacency(indices, vertexCount);
  if (pairs === 0 || vertexCount === 0) return positions;

  let current = Float64Array.from(positions);
  let next = new Float64Array(current.length);
  const step = (factor: number): void => {
    for (let v = 0; v < vertexCount; v++) {
      const start = offsets[v];
      const end = offsets[v + 1];
      const at = 3 * v;
      const x = current[at];
      const y = current[at + 1];
      const z = current[at + 2];
      if (end === start) {
        next[at] = x;
        next[at + 1] = y;
        next[at + 2] = z;
        continue;
      }
      let sx = 0;
      let sy = 0;
      let sz = 0;
      for (let i = start; i < end; i++) {
        const n = 3 * neighbors[i];
        sx += current[n];
        sy += current[n + 1];
        sz += current[n + 2];
      }
      const scale = factor / (end - start);
      next[at] = x + (sx * scale - x * factor);
      next[at + 1] = y + (sy * scale - y * factor);
      next[at + 2] = z + (sz * scale - z * factor);
    }
    const swap = current;
    current = next;
    next = swap;
  };
  for (let pair = 0; pair < pairs; pair++) {
    step(lambda);
    step(mu);
  }
  positions.set(current);
  return positions;
}
