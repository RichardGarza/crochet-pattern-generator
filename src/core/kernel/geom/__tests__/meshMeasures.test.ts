import { describe, expect, it } from 'vitest';
import type { ColoredMesh } from '../../../../types/geometry';
import { mulberry32 } from '../../prng';
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

// A tetrahedron with the right angle at the origin, counter-clockwise seen from outside.
const TET_POSITIONS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1];
const TET = { positions: Float32Array.from(TET_POSITIONS), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };

/** The unit cube [0, 1]³ as 12 outward triangles. */
function cube(offset: [number, number, number] = [0, 0, 0], size = 1): { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const positions = new Float32Array(24);
  for (let v = 0; v < 8; v++) {
    positions[3 * v] = offset[0] + size * (v & 1);
    positions[3 * v + 1] = offset[1] + size * ((v >> 1) & 1);
    positions[3 * v + 2] = offset[2] + size * ((v >> 2) & 1);
  }
  // Each face as two triangles, counter-clockwise seen from outside.
  const quads = [
    [0, 2, 3, 1], // z = 0, normal −z
    [4, 5, 7, 6], // z = 1, normal +z
    [0, 1, 5, 4], // y = 0, normal −y
    [2, 6, 7, 3], // y = 1, normal +y
    [0, 4, 6, 2], // x = 0, normal −x
    [1, 3, 7, 5], // x = 1, normal +x
  ];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return { positions, indices: Uint32Array.from(indices) };
}

/** A torus around the Y axis as a grid of quads: `u` segments around the ring, `v` around the tube. */
function torusMesh(R: number, r: number, u: number, v: number): { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const positions = new Float32Array(3 * u * v);
  for (let i = 0; i < u; i++) {
    for (let j = 0; j < v; j++) {
      const a = (2 * Math.PI * i) / u;
      const b = (2 * Math.PI * j) / v;
      const ring = R + r * Math.cos(b);
      positions.set([ring * Math.cos(a), r * Math.sin(b), ring * Math.sin(a)], 3 * (i * v + j));
    }
  }
  const indices: number[] = [];
  for (let i = 0; i < u; i++) {
    for (let j = 0; j < v; j++) {
      const a = i * v + j;
      const b = ((i + 1) % u) * v + j;
      const c = ((i + 1) % u) * v + ((j + 1) % v);
      const d = i * v + ((j + 1) % v);
      indices.push(a, d, c, a, c, b);
    }
  }
  return { positions, indices: Uint32Array.from(indices) };
}

describe('signedVolume and surfaceArea', () => {
  it('tetrahedron: 1/6, positive for outward winding and negative inside out', () => {
    expect(signedVolume(TET)).toBeCloseTo(1 / 6, 12);
    const insideOut = { positions: TET.positions, indices: Uint32Array.from([0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3]) };
    expect(signedVolume(insideOut)).toBeCloseTo(-1 / 6, 12);
    expect(surfaceArea(TET)).toBeCloseTo(1.5 + Math.sqrt(3) / 2, 12);
    expect(surfaceArea(insideOut)).toBeCloseTo(1.5 + Math.sqrt(3) / 2, 12);
  });

  it('cube: volume and area, wherever it is', () => {
    expect(signedVolume(cube())).toBeCloseTo(1, 12);
    expect(surfaceArea(cube())).toBeCloseTo(6, 12);
    const far = cube([100, -50, 7], 2);
    expect(signedVolume(far)).toBeCloseTo(8, 6);
    expect(surfaceArea(far)).toBeCloseTo(24, 6);
  });

  it('torus mesh converges to 2π²Rr² and 4π²Rr', () => {
    const m = torusMesh(0.6, 0.25, 160, 80);
    expect(signedVolume(m) / (2 * Math.PI ** 2 * 0.6 * 0.25 ** 2)).toBeCloseTo(1, 2);
    expect(surfaceArea(m) / (4 * Math.PI ** 2 * 0.6 * 0.25)).toBeCloseTo(1, 2);
    expect(signedVolume(m)).toBeGreaterThan(0);
  });

  it('accepts a ColoredMesh and plain arrays', () => {
    const colored: ColoredMesh = { positions: TET.positions, indices: TET.indices, labels: new Uint8Array(4).fill(255) };
    expect(signedVolume(colored)).toBeCloseTo(1 / 6, 12);
    expect(signedVolume({ positions: TET_POSITIONS, indices: [0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2] })).toBeCloseTo(1 / 6, 12);
    expect(signedVolume({ positions: [], indices: [] })).toBe(0);
    expect(surfaceArea({ positions: [], indices: [] })).toBe(0);
  });

  it('rejects malformed buffers', () => {
    expect(() => signedVolume({ positions: TET.positions, indices: [0, 1] })).toThrow(RangeError);
    expect(() => signedVolume({ positions: TET.positions, indices: [0, 1, 4] })).toThrow(RangeError);
    expect(() => signedVolume({ positions: TET.positions, indices: [0, 1, -1] })).toThrow(RangeError);
    expect(() => signedVolume({ positions: TET.positions, indices: [0, 1, 1.5] })).toThrow(RangeError);
    expect(() => signedVolume({ positions: [0, 0, 0, 1], indices: [] })).toThrow(RangeError);
    expect(() => surfaceArea({ positions: TET.positions, indices: [0, 1, 9] })).toThrow(RangeError);
  });
});

describe('edgeStats, isWatertight, eulerCharacteristic, countComponents', () => {
  it('closed meshes', () => {
    expect(edgeStats(TET.indices)).toEqual({ edges: 6, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    expect(isWatertight(TET.indices)).toBe(true);
    expect(eulerCharacteristic(TET.indices)).toBe(2);
    expect(countComponents(TET.indices)).toBe(1);
    const c = cube();
    expect(edgeStats(c.indices)).toEqual({ edges: 18, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    expect(eulerCharacteristic(c.indices)).toBe(2);
    const t = torusMesh(0.6, 0.25, 12, 8);
    expect(edgeStats(t.indices)).toEqual({ edges: 3 * 96, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    expect(eulerCharacteristic(t.indices)).toBe(0);
    expect(countComponents(t.indices)).toBe(1);
  });

  it('a hole: boundary edges, χ drops by one', () => {
    const open = TET.indices.slice(0, 9);
    expect(edgeStats(open)).toEqual({ edges: 6, boundaryEdges: 3, nonManifoldEdges: 0, misorientedEdges: 0 });
    expect(isWatertight(open)).toBe(false);
    expect(eulerCharacteristic(open)).toBe(1);
    // A single triangle is a disc.
    expect(edgeStats([0, 1, 2])).toEqual({ edges: 3, boundaryEdges: 3, nonManifoldEdges: 0, misorientedEdges: 0 });
    expect(eulerCharacteristic([0, 1, 2])).toBe(1);
  });

  it('one flipped triangle: its three edges are misoriented', () => {
    const flipped = Uint32Array.from(TET.indices);
    flipped[1] = TET.indices[2];
    flipped[2] = TET.indices[1];
    expect(edgeStats(flipped)).toEqual({ edges: 6, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 3 });
    expect(isWatertight(flipped)).toBe(false);
    // A mesh that is inside out as a whole is consistently wound.
    expect(isWatertight([0, 1, 2, 0, 3, 1, 1, 3, 2, 0, 2, 3])).toBe(true);
  });

  it('three triangles on one edge: non-manifold', () => {
    const fins = [0, 1, 2, 0, 1, 3, 0, 1, 4];
    expect(edgeStats(fins)).toEqual({ edges: 7, boundaryEdges: 6, nonManifoldEdges: 1, misorientedEdges: 0 });
    // Two cubes that share an edge: that edge carries four triangles.
    const a = cube();
    const merged = [...a.indices];
    // Second cube with vertices 8…15, then weld its edge (8, 10) onto the first cube's edge (5, 7).
    for (const i of a.indices) merged.push(i === 0 ? 5 : i === 2 ? 7 : i + 8);
    expect(edgeStats(merged).nonManifoldEdges).toBe(1);
    expect(edgeStats(merged).boundaryEdges).toBe(0);
    expect(isWatertight(merged)).toBe(false);
  });

  it('several pieces', () => {
    const two = [...TET.indices, ...Array.from(TET.indices, (i) => i + 4)];
    expect(countComponents(two)).toBe(2);
    expect(eulerCharacteristic(two)).toBe(4);
    expect(isWatertight(two)).toBe(true);
    expect(countComponents([])).toBe(0);
    expect(eulerCharacteristic([])).toBe(0);
    // Order of the triangles does not matter.
    const shuffled = [9, 10, 11, 0, 1, 2, 3, 4, 5, 2, 3, 20, 6, 7, 8, 30, 31, 32, 8, 9, 40];
    expect(countComponents(shuffled)).toBe(3);
  });

  it('ignores vertices no triangle uses, and edges of a repeated index', () => {
    // Vertex numbers 10…13 instead of 0…3: the ten unused vertices do not change χ.
    const shifted = Array.from(TET.indices, (i) => i + 10);
    expect(countUsedVertices(shifted)).toBe(4);
    expect(eulerCharacteristic(shifted)).toBe(2);
    // A triangle with a repeated index has one real edge.
    expect(edgeStats([0, 0, 1])).toEqual({ edges: 1, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
  });

  it('matches a hash-map census on random triangle soups', () => {
    const rng = mulberry32(7);
    for (let trial = 0; trial < 50; trial++) {
      const vertices = 3 + Math.floor(rng() * 12);
      const triangles = 1 + Math.floor(rng() * 30);
      const indices: number[] = [];
      for (let i = 0; i < 3 * triangles; i++) indices.push(Math.floor(rng() * vertices));
      const uses = new Map<string, { forward: number; backward: number }>();
      for (let t = 0; t < indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = indices[t + e];
          const b = indices[t + ((e + 1) % 3)];
          if (a === b) continue;
          const key = `${Math.min(a, b)}-${Math.max(a, b)}`;
          const entry = uses.get(key) ?? { forward: 0, backward: 0 };
          if (a < b) entry.forward++;
          else entry.backward++;
          uses.set(key, entry);
        }
      }
      const expected = { edges: uses.size, boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 };
      for (const { forward, backward } of uses.values()) {
        if (forward + backward === 1) expected.boundaryEdges++;
        else if (forward + backward > 2) expected.nonManifoldEdges++;
        else if (forward !== backward) expected.misorientedEdges++;
      }
      expect(edgeStats(indices)).toEqual(expected);
      expect(eulerCharacteristic(indices)).toBe(new Set(indices).size - uses.size + triangles);
    }
  });

  it('rejects malformed index buffers', () => {
    expect(() => edgeStats([0, 1])).toThrow(RangeError);
    expect(() => edgeStats([0, 1, -2])).toThrow(RangeError);
    expect(() => edgeStats([0, 1, 2.5])).toThrow(RangeError);
    expect(() => edgeStats([0, 1, NaN])).toThrow(RangeError);
    expect(() => eulerCharacteristic([0, 1])).toThrow(RangeError);
    expect(() => countComponents([0, 1, -1])).toThrow(RangeError);
    expect(() => countUsedVertices([0, 1, 1.5])).toThrow(RangeError);
    expect(() => countNonManifoldVertices([0, 1])).toThrow(RangeError);
  });
});

describe('countNonManifoldVertices', () => {
  it('is 0 on manifold surfaces, closed or open', () => {
    expect(countNonManifoldVertices(TET.indices)).toBe(0);
    expect(countNonManifoldVertices(cube().indices)).toBe(0);
    expect(countNonManifoldVertices(torusMesh(1, 0.3, 9, 7).indices)).toBe(0);
    expect(countNonManifoldVertices(TET.indices.slice(0, 9))).toBe(0);
    expect(countNonManifoldVertices([0, 1, 2])).toBe(0);
    expect(countNonManifoldVertices([])).toBe(0);
    // A fan of three triangles around vertex 0 with an open rim.
    expect(countNonManifoldVertices([0, 1, 2, 0, 2, 3, 0, 3, 4])).toBe(0);
  });

  it('counts a vertex shared by two separate fans', () => {
    // Two triangles that touch in one vertex (a bow tie).
    expect(countNonManifoldVertices([0, 1, 2, 0, 3, 4])).toBe(1);
    // Two tetrahedra that touch in one vertex: every edge is fine, the vertex is not.
    const second = Array.from(TET.indices, (i) => (i === 0 ? 0 : i + 3));
    const pinched = [...TET.indices, ...second];
    expect(isWatertight(pinched)).toBe(true);
    expect(countNonManifoldVertices(pinched)).toBe(1);
    expect(countComponents(pinched)).toBe(1);
  });
});

describe('countZeroAreaTriangles, minTriangleArea', () => {
  it('finds coincident corners, collinear corners, repeated indices and NaN', () => {
    const positions = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 0, NaN, 0, 0];
    expect(countZeroAreaTriangles({ positions, indices: [0, 1, 3] })).toBe(0);
    expect(countZeroAreaTriangles({ positions, indices: [0, 1, 2] })).toBe(1); // on one line
    expect(countZeroAreaTriangles({ positions, indices: [0, 4, 3] })).toBe(1); // two corners at one point
    expect(countZeroAreaTriangles({ positions, indices: [0, 0, 3] })).toBe(1); // repeated index
    expect(countZeroAreaTriangles({ positions, indices: [5, 1, 3] })).toBe(1); // NaN
    expect(countZeroAreaTriangles({ positions, indices: [0, 1, 3, 0, 1, 2, 0, 4, 3] })).toBe(2);
    expect(countZeroAreaTriangles(TET)).toBe(0);
  });

  it('takes a threshold', () => {
    expect(countZeroAreaTriangles(TET, 0.5)).toBe(3);
    expect(countZeroAreaTriangles(TET, 0.49)).toBe(0);
    expect(countZeroAreaTriangles(TET, 1)).toBe(4);
    expect(minTriangleArea(TET)).toBeCloseTo(0.5, 12);
    expect(minTriangleArea({ positions: [], indices: [] })).toBe(Infinity);
    expect(minTriangleArea({ positions: [0, 0, 0, 1, 0, 0, 2, 0, 0], indices: [0, 1, 2] })).toBe(0);
  });
});

describe('meshBounds', () => {
  it('returns the box of the positions', () => {
    expect(meshBounds(TET.positions)).toEqual({ min: [0, 0, 0], max: [1, 1, 1] });
    expect(meshBounds([3, -1, 2, -4, 5, 2])).toEqual({ min: [-4, -1, 2], max: [3, 5, 2] });
    expect(meshBounds([])).toEqual({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
    expect(() => meshBounds([1, 2])).toThrow(RangeError);
  });
});
