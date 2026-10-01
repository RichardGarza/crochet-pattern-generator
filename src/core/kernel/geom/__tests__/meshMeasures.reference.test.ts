// meshMeasures.ts against references written differently (string- or BigInt-keyed Maps, Sets, flood fills,
// other formulas). From the independent review of Step 0b; it shares no code with the kernel or with
// meshMeasures.test.ts.
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { marchingCubes } from '../marchingCubes';
import {
  countComponents,
  countNonManifoldVertices,
  countUsedVertices,
  countZeroAreaTriangles,
  edgeStats,
  eulerCharacteristic,
  isWatertight,
  meshBounds,
  minTriangleArea,
  signedVolume,
  surfaceArea,
} from '../meshMeasures';
import { HEAVY, note } from './fields';

// ---- references ------------------------------------------------------------------------------------------------

/** The documented rule: a triangle that names a vertex twice is counted, and is otherwise not there. */
function surface(indices: ArrayLike<number>): number[] {
  const kept: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    if (new Set([indices[t], indices[t + 1], indices[t + 2]]).size === 3) kept.push(indices[t], indices[t + 1], indices[t + 2]);
  }
  return kept;
}

function referenceEdgeStats(all: ArrayLike<number>): {
  edges: number;
  degenerateTriangles: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  misorientedEdges: number;
} {
  const indices = surface(all);
  const uses = new Map<string, { up: number; down: number }>();
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = BigInt(indices[t + e]);
      const b = BigInt(indices[t + ((e + 1) % 3)]);
      const key = a < b ? `${a}_${b}` : `${b}_${a}`;
      const entry = uses.get(key) ?? { up: 0, down: 0 };
      if (a < b) entry.up++;
      else entry.down++;
      uses.set(key, entry);
    }
  }
  const out = { edges: uses.size, degenerateTriangles: (all.length - indices.length) / 3, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 };
  for (const { up, down } of uses.values()) {
    if (up + down === 1) out.boundaryEdges++;
    else if (up + down >= 3) out.nonManifoldEdges++;
    else if (up !== 1) out.misorientedEdges++;
  }
  return out;
}

/** Components of the graph "two vertices are joined when a triangle uses both", over the vertices of the surface. */
function referenceComponents(all: ArrayLike<number>): number {
  const indices = surface(all);
  const adjacent = new Map<number, Set<number>>();
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    for (const a of tri) {
      const set = adjacent.get(a) ?? new Set<number>();
      for (const b of tri) set.add(b);
      adjacent.set(a, set);
    }
  }
  const seen = new Set<number>();
  let components = 0;
  for (const start of adjacent.keys()) {
    if (seen.has(start)) continue;
    components++;
    const queue = [start];
    seen.add(start);
    while (queue.length > 0) {
      for (const next of adjacent.get(queue.pop() as number) as Set<number>) {
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  }
  return components;
}

/** The documented definition: triangles around v are in one fan when they share an edge that ends at v. */
function referencePinched(all: ArrayLike<number>): number {
  const indices = surface(all);
  const around = new Map<number, number[]>();
  for (let t = 0; t < indices.length; t += 3) {
    for (const v of new Set([indices[t], indices[t + 1], indices[t + 2]])) {
      const list = around.get(v) ?? [];
      list.push(t);
      around.set(v, list);
    }
  }
  let pinched = 0;
  for (const [v, triangles] of around) {
    // flood the triangles around v through shared second vertices
    const others = (t: number): number[] => [indices[t], indices[t + 1], indices[t + 2]].filter((w) => w !== v);
    const seen = new Set<number>([triangles[0]]);
    const queue = [triangles[0]];
    while (queue.length > 0) {
      const t = queue.pop() as number;
      for (const u of triangles) {
        if (seen.has(u)) continue;
        if (others(u).some((w) => others(t).includes(w))) {
          seen.add(u);
          queue.push(u);
        }
      }
    }
    if (seen.size < triangles.length) pinched++;
  }
  return pinched;
}

function soup(seed: number, allowAllEqual: boolean): number[] {
  const rng = mulberry32(seed * 977 + 5);
  const vertices = 3 + Math.floor(rng() * 14);
  const triangles = 1 + Math.floor(rng() * 40);
  const indices: number[] = [];
  while (indices.length < 3 * triangles) {
    const tri = [Math.floor(rng() * vertices), Math.floor(rng() * vertices), Math.floor(rng() * vertices)];
    if (!allowAllEqual && tri[0] === tri[1] && tri[1] === tri[2]) continue;
    indices.push(...tri);
  }
  return indices;
}

function randomClosedMesh(seed: number): ReturnType<typeof marchingCubes> {
  const rng = mulberry32(seed);
  const dims: [number, number, number] = [3 + Math.floor(rng() * 6), 3 + Math.floor(rng() * 6), 3 + Math.floor(rng() * 6)];
  const field = Float32Array.from({ length: dims[0] * dims[1] * dims[2] }, () => rng() * 2 - 1);
  return marchingCubes(field, dims, { origin: [rng() * 6 - 3, rng() * 6 - 3, rng() * 6 - 3], voxel: [0.3 + rng(), 0.3 + rng(), 0.3 + rng()] });
}

// ---- edge census, Euler characteristic, components, pinched vertices ---------------------------------------------

describe('index-buffer measures against references', HEAVY, () => {
  it('edgeStats, eulerCharacteristic, countUsedVertices, countComponents on 600 random soups (repeated indices included)', () => {
    for (let seed = 1; seed <= 600; seed++) {
      const indices = soup(seed, true);
      const typed = seed % 2 ? Uint32Array.from(indices) : indices;
      const expected = referenceEdgeStats(indices);
      expect(edgeStats(typed)).toEqual(expected);
      expect(isWatertight(typed)).toBe(
        expected.boundaryEdges + expected.nonManifoldEdges + expected.misorientedEdges + expected.degenerateTriangles === 0,
      );
      expect(countUsedVertices(typed)).toBe(new Set(indices).size);
      const kept = surface(indices);
      expect(eulerCharacteristic(typed)).toBe(new Set(kept).size - expected.edges + kept.length / 3);
      expect(countComponents(typed)).toBe(referenceComponents(indices));
    }
  });

  it('countNonManifoldVertices on 600 random soups (repeated indices included)', () => {
    let pinchedSeen = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const indices = soup(seed, seed % 3 === 0);
      const expected = referencePinched(indices);
      pinchedSeen += expected;
      expect(countNonManifoldVertices(seed % 2 ? Uint32Array.from(indices) : indices)).toBe(expected);
    }
    expect(pinchedSeen).toBeGreaterThan(500);
  });

  it('on marching-cubes meshes: closed, χ = 2·pieces − 2·handles, and the same after any relabeling of the vertices', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const m = randomClosedMesh(seed);
      if (m.indices.length === 0) continue;
      expect(edgeStats(m.indices)).toEqual(referenceEdgeStats(m.indices));
      expect(countComponents(m.indices)).toBe(referenceComponents(m.indices));
      expect(countNonManifoldVertices(m.indices)).toBe(0);
      // relabel: v → a permutation of sparse, larger numbers
      const rng = mulberry32(seed + 1000);
      const V = m.positions.length / 3;
      const label = Array.from({ length: V }, (_, i) => i * 3 + 1);
      for (let i = V - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [label[i], label[j]] = [label[j], label[i]];
      }
      const relabeled = Uint32Array.from(m.indices, (v) => label[v]);
      expect(edgeStats(relabeled)).toEqual(edgeStats(m.indices));
      expect(eulerCharacteristic(relabeled)).toBe(eulerCharacteristic(m.indices));
      expect(countComponents(relabeled)).toBe(countComponents(m.indices));
      expect(countNonManifoldVertices(relabeled)).toBe(0);
      const chi = eulerCharacteristic(m.indices);
      expect(Math.abs(chi % 2)).toBe(0);
      expect(chi).toBeLessThanOrEqual(2 * countComponents(m.indices));
    }
  });

  it('edgeStats is exact up to the largest vertex index it accepts (2^26 − 2) and rejects larger ones', () => {
    const top = 2 ** 26 - 2; // m = 2^26 − 1 vertices: 2·m² < 2^53
    // A tetrahedron on four of the largest indices, one face flipped, plus a fin: every kind of edge.
    const a = top;
    const b = top - 1;
    const c = top - 2;
    const d = 0;
    const indices = [a, c, b, a, b, d, b, c, d, a, c, d /* flipped */, a, b, 7];
    expect(edgeStats(indices)).toEqual(referenceEdgeStats(indices));
    // Neighboring keys must not collide: (lo, hi) pairs that differ by one in either entry.
    const near = [top, top - 1, top - 2, top, top - 2, top - 3, top - 1, top - 3, top - 4, 1, top, 2, 0, top, 1];
    expect(edgeStats(near)).toEqual(referenceEdgeStats(near));
    expect(() => edgeStats([0, 1, top + 1])).toThrow(RangeError);
    expect(() => edgeStats([0, 1, 2 ** 32 - 1])).toThrow(RangeError);
  });

  it('a triangle with a repeated index is no surface: not watertight, no edge, no piece, no pinched vertex', () => {
    // (The review found that (0, 0, 1) passed for a closed surface — its one real edge is run "up" and "down" by
    // the same triangle — and that (5, 5, 5) counted as a pinched vertex.)
    for (const indices of [
      [0, 0, 1],
      [5, 5, 5],
      [0, 0, 1, 5, 5, 5, 2, 3, 2],
    ]) {
      expect(isWatertight(indices)).toBe(false);
      expect(edgeStats(indices)).toEqual({ edges: 0, degenerateTriangles: indices.length / 3, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      expect(eulerCharacteristic(indices)).toBe(0);
      expect(countComponents(indices)).toBe(0);
      expect(countNonManifoldVertices(indices)).toBe(0);
    }
  });

  it('the index-only measures allocate by the LARGEST index (documented): one stray index costs time and memory, not correctness', () => {
    // 1 triangle; the stray index is 10 million (a Uint32 underflow would be 4 294 967 295: ≥ 16 GB of tables).
    const stray = [0, 1, 10_000_000];
    const time = (fn: () => unknown): number => {
      const start = performance.now();
      fn();
      return performance.now() - start;
    };
    const ms = {
      countUsedVertices: time(() => countUsedVertices(stray)),
      countComponents: time(() => countComponents(stray)),
      countNonManifoldVertices: time(() => countNonManifoldVertices(stray)),
      edgeStats: time(() => edgeStats(stray)),
    };
    note(`one triangle with a stray index of 1e7, ms: ${JSON.stringify(ms)}`);
    expect(countUsedVertices(stray)).toBe(3);
    expect(countComponents(stray)).toBe(1);
    expect(countNonManifoldVertices(stray)).toBe(0);
  });
});

// ---- volume, area ------------------------------------------------------------------------------------------------

describe('signedVolume and surfaceArea against other formulas', () => {
  it('volume = ∮ z·n_z dA and area by Heron, on 60 closed marching-cubes meshes and their mirror images', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const m = randomClosedMesh(seed);
      if (m.indices.length === 0) continue;
      const p = m.positions;
      let volume = 0;
      let area = 0;
      for (let t = 0; t < m.indices.length; t += 3) {
        const [a, b, c] = [3 * m.indices[t], 3 * m.indices[t + 1], 3 * m.indices[t + 2]];
        const projected = 0.5 * ((p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[c] - p[a]) * (p[b + 1] - p[a + 1]));
        volume += (projected * (p[a + 2] + p[b + 2] + p[c + 2])) / 3;
        const ab = Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
        const bc = Math.hypot(p[c] - p[b], p[c + 1] - p[b + 1], p[c + 2] - p[b + 2]);
        const ca = Math.hypot(p[a] - p[c], p[a + 1] - p[c + 1], p[a + 2] - p[c + 2]);
        const s = (ab + bc + ca) / 2;
        area += Math.sqrt(Math.max(0, s * (s - ab) * (s - bc) * (s - ca)));
      }
      expect(volume).toBeGreaterThan(0);
      expect(Math.abs(signedVolume(m) / volume - 1)).toBeLessThan(1e-9);
      expect(Math.abs(surfaceArea(m) / area - 1)).toBeLessThan(1e-6);
      // inside out: swap two corners of every triangle
      const flipped = Uint32Array.from(m.indices);
      for (let t = 0; t < flipped.length; t += 3) [flipped[t + 1], flipped[t + 2]] = [flipped[t + 2], flipped[t + 1]];
      expect(signedVolume({ positions: p, indices: flipped })).toBeCloseTo(-signedVolume(m), 9);
      expect(surfaceArea({ positions: p, indices: flipped })).toBeCloseTo(surfaceArea(m), 9);
    }
  });

  it('signedVolume keeps its digits far from the origin (it sums around a vertex of the mesh)', () => {
    // A marching-cubes ball of radius 6 voxels, moved away in double precision (the mesh itself stays exact).
    // Summed around the origin, as the review found it, the relative error was 2.6e-6 at 1e4 and 2.8 at 1e6.
    const n = 16;
    const field = new Float32Array(n * n * n);
    let i = 0;
    for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = 6 - Math.hypot(x - 7.5, y - 7.5, z - 7.5);
    const m = marchingCubes(field, [n, n, n]);
    const near = signedVolume(m);
    const errors: Record<string, string> = {};
    let worst = 0;
    for (const offset of [1e2, 1e3, 1e4, 1e5, 1e6, 1e7]) {
      const moved = Float64Array.from(m.positions, (v, k) => v + offset * (1 + (k % 3)));
      const relative = Math.abs(signedVolume({ positions: moved, indices: m.indices }) / near - 1);
      errors[offset] = relative.toExponential(1);
      worst = Math.max(worst, relative);
    }
    note(`relative error of signedVolume by distance from the origin (ball of radius 6): ${JSON.stringify(errors)}`);
    // What is left is the rounding of the moved coordinates themselves (1e-9 of a voxel at 1e7).
    expect(worst).toBeLessThan(1e-7);
  });

  it('validates indices against the position buffer', () => {
    const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    for (const fn of [signedVolume, surfaceArea, countZeroAreaTriangles, minTriangleArea]) {
      expect(() => fn({ positions, indices: [0, 1, 3] })).toThrow(RangeError);
      expect(() => fn({ positions, indices: [0, 1, -1] })).toThrow(RangeError);
      expect(() => fn({ positions, indices: [0, 1, 1.5] })).toThrow(RangeError);
      expect(() => fn({ positions, indices: [0, 1, NaN] })).toThrow(RangeError);
      expect(() => fn({ positions, indices: [0, 1] })).toThrow(RangeError);
      expect(() => fn({ positions: [0, 0], indices: [] })).toThrow(RangeError);
    }
  });
});

// ---- degenerate triangles ------------------------------------------------------------------------------------------

describe('minTriangleArea and NaN', () => {
  // Three triangles of area 0.5, 2 and 8; vertex 9 is NaN.
  const positions = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 2, 0, 0, 0, 2, 0, 0, 0, 0, 4, 0, 0, 0, 4, 0, NaN, 0, 0];
  const small = [0, 1, 2];
  const medium = [3, 4, 5];
  const large = [6, 7, 8];
  const broken = [9, 1, 2];

  it('without NaN: the smallest area, whatever the order', () => {
    expect(minTriangleArea({ positions, indices: [...small, ...medium, ...large] })).toBe(0.5);
    expect(minTriangleArea({ positions, indices: [...large, ...medium, ...small] })).toBe(0.5);
    expect(minTriangleArea({ positions, indices: [...medium, ...small, ...large] })).toBe(0.5);
  });

  it('a NaN triangle gives NaN wherever it stands in the buffer', () => {
    // (The review found the NaN forgotten unless it came last: [broken, small] gave 0.5, and
    // [small, broken, large] gave 8 — neither NaN nor the minimum.)
    expect(minTriangleArea({ positions, indices: [...small, ...medium, ...broken] })).toBeNaN();
    expect(minTriangleArea({ positions, indices: [...broken, ...small] })).toBeNaN();
    expect(minTriangleArea({ positions, indices: [...small, ...broken, ...large] })).toBeNaN();
  });

  it('countZeroAreaTriangles counts the NaN triangle wherever it is', () => {
    expect(countZeroAreaTriangles({ positions, indices: [...broken, ...small, ...large] })).toBe(1);
    expect(countZeroAreaTriangles({ positions, indices: [...small, ...broken, ...large] })).toBe(1);
    expect(countZeroAreaTriangles({ positions, indices: [...small, ...large, ...broken] })).toBe(1);
  });

  it('meshBounds skips NaN coordinates (documented)', () => {
    expect(meshBounds([NaN, 1, 2, 3, NaN, 5])).toEqual({ min: [3, 1, 2], max: [3, 1, 5] });
    expect(meshBounds([NaN, NaN, NaN])).toEqual({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
  });
});
