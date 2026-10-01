import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { marchingCubes } from '../marchingCubes';
import { edgeStats, signedVolume } from '../meshMeasures';
import { TAUBIN_LAMBDA, TAUBIN_MU, TAUBIN_PAIRS, taubinSmooth, vertexAdjacency } from '../taubin';
import { firstByteDifference, HEAVY, sampleField, sphere, sphereVolume, teddy } from './fields';

/** RMS distance of the vertices from the sphere of radius r around the origin. */
function radialRms(p: ArrayLike<number>, r: number): number {
  let sum = 0;
  for (let i = 0; i < p.length; i += 3) sum += (Math.hypot(p[i], p[i + 1], p[i + 2]) - r) ** 2;
  return Math.sqrt(sum / (p.length / 3));
}

/** RMS length of the umbrella Laplacian (mean of the neighbors minus the vertex): high-frequency energy. */
function roughness(p: ArrayLike<number>, indices: ArrayLike<number>): number {
  const { offsets, neighbors } = vertexAdjacency(indices, p.length / 3);
  let sum = 0;
  for (let v = 0; v < p.length / 3; v++) {
    const n = offsets[v + 1] - offsets[v];
    if (n === 0) continue;
    for (let a = 0; a < 3; a++) {
      let mean = 0;
      for (let k = offsets[v]; k < offsets[v + 1]; k++) mean += p[3 * neighbors[k] + a];
      sum += (mean / n - p[3 * v + a]) ** 2;
    }
  }
  return Math.sqrt(sum / (p.length / 3));
}

// A regular tetrahedron centered on the origin: every vertex has the other three as neighbors.
const TET = {
  positions: [1, 1, 1, 1, -1, -1, -1, 1, -1, -1, -1, 1],
  indices: [0, 1, 2, 0, 3, 1, 0, 2, 3, 1, 3, 2],
};

describe('taubinSmooth', HEAVY, () => {
  it('uses the constants of §2.9.5: 10 pairs, λ = 0.6307, μ = −0.6732 (pass-band 0.1)', () => {
    expect(TAUBIN_PAIRS).toBe(10);
    expect(TAUBIN_LAMBDA).toBe(0.6307);
    expect(TAUBIN_MU).toBe(-0.6732);
    expect(1 / TAUBIN_LAMBDA + 1 / TAUBIN_MU).toBeCloseTo(0.1, 3);
  });

  it('one pair is p + λ·L, then p + μ·L, with simultaneous updates (closed form on a tetrahedron)', () => {
    // For the centered tetrahedron the mean of the neighbors is −p/3, so L(p) = −4p/3 and each step scales
    // the mesh: by (1 − 4λ/3), then by (1 − 4μ/3). An in-place (Gauss–Seidel) update would break the symmetry.
    const perPair = (1 - (4 * TAUBIN_LAMBDA) / 3) * (1 - (4 * TAUBIN_MU) / 3);
    for (const pairs of [1, 2, 3, 10]) {
      const p = Float64Array.from(TET.positions);
      expect(taubinSmooth(p, TET.indices, { pairs })).toBe(p);
      for (let i = 0; i < 12; i++) expect(p[i]).toBeCloseTo(TET.positions[i] * perPair ** pairs, 12);
    }
    const custom = Float64Array.from(TET.positions);
    taubinSmooth(custom, TET.indices, { pairs: 1, lambda: 0.3, mu: -0.15 });
    for (let i = 0; i < 12; i++) expect(custom[i]).toBeCloseTo(TET.positions[i] * (1 - 0.4) * (1 + 0.2), 12);
  });

  it('keeps the volume of the marching-cubes sphere within 2% (measured: +0.02% at N = 128, +0.09% at N = 64)', () => {
    for (const n of [64, 128]) {
      const s = sampleField(n, sphere(0.8));
      const m = marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel });
      const before = signedVolume(m);
      const indicesBefore = Uint32Array.from(m.indices);
      taubinSmooth(m.positions, m.indices);
      const after = signedVolume(m);
      expect(Math.abs(after / before - 1)).toBeLessThan(0.002);
      expect(Math.abs(after / sphereVolume(0.8) - 1)).toBeLessThan(0.002);
      // The index buffer is untouched, so the mesh is exactly as watertight as before. (A byte comparison:
      // toEqual on the 241 476 indices at N = 128 costs over 200 ms.)
      expect(firstByteDifference(m.indices, indicesBefore)).toBe(-1);
      expect(edgeStats(m.indices)).toMatchObject({ boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
      // The smooth sphere stays a sphere: vertices within 1% of a voxel (RMS).
      expect(radialRms(m.positions, 0.8)).toBeLessThan(0.01 * s.voxel);
    }
  });

  it('keeps the volume of the teddy within 2% (measured: +0.09%)', () => {
    const s = sampleField(128, teddy);
    const m = marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel });
    const before = signedVolume(m);
    taubinSmooth(m.positions, m.indices);
    expect(Math.abs(signedVolume(m) / before - 1)).toBeLessThan(0.003);
  });

  it('removes high-frequency noise: roughness ÷ 10, radial error ÷ 3 (N = 128, noise ±0.3 voxel)', () => {
    const s = sampleField(128, sphere(0.8));
    const m = marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel });
    const rng = mulberry32(42);
    const noisy = Float32Array.from(m.positions, (v) => v + (rng() * 2 - 1) * 0.3 * s.voxel);
    const before = { radial: radialRms(noisy, 0.8) / s.voxel, rough: roughness(noisy, m.indices) / s.voxel };
    // Measured: radial 0.1735 → 0.0781 (3 pairs) → 0.0581 (10 pairs); roughness 0.484 → 0.104 → 0.047.
    expect(before.radial).toBeGreaterThan(0.17);
    expect(before.rough).toBeGreaterThan(0.45);
    const three = taubinSmooth(Float32Array.from(noisy), m.indices, { pairs: 3 });
    expect(radialRms(three, 0.8) / s.voxel).toBeLessThan(0.09);
    expect(roughness(three, m.indices) / s.voxel).toBeLessThan(0.12);
    const ten = taubinSmooth(Float32Array.from(noisy), m.indices);
    expect(radialRms(ten, 0.8) / s.voxel).toBeLessThan(0.065);
    expect(roughness(ten, m.indices) / s.voxel).toBeLessThan(0.055);
    // …and the volume is still the sphere's.
    expect(Math.abs(signedVolume({ positions: ten, indices: m.indices }) / sphereVolume(0.8) - 1)).toBeLessThan(0.002);
  });

  it('does not shrink the way plain Laplacian smoothing does', () => {
    const s = sampleField(64, sphere(0.8));
    const m = marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel });
    const before = signedVolume(m);
    const taubin = taubinSmooth(Float32Array.from(m.positions), m.indices, { pairs: 10 });
    // Twenty shrinking steps: the same number of passes, no un-shrinking.
    const laplace = taubinSmooth(Float32Array.from(m.positions), m.indices, { pairs: 10, mu: TAUBIN_LAMBDA });
    const taubinLoss = 1 - signedVolume({ positions: taubin, indices: m.indices }) / before;
    const laplaceLoss = 1 - signedVolume({ positions: laplace, indices: m.indices }) / before;
    expect(laplaceLoss).toBeGreaterThan(0.025); // measured 3.0%
    expect(Math.abs(taubinLoss)).toBeLessThan(0.002); // measured −0.09% (a slight gain)
  });

  it('0 pairs changes nothing; more pairs smooth more', () => {
    const s = sampleField(32, teddy);
    const m = marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel });
    const original = Float32Array.from(m.positions);
    expect(taubinSmooth(Float32Array.from(original), m.indices, { pairs: 0 })).toEqual(original);
    const r0 = roughness(original, m.indices);
    const r3 = roughness(taubinSmooth(Float32Array.from(original), m.indices, { pairs: 3 }), m.indices);
    const r10 = roughness(taubinSmooth(Float32Array.from(original), m.indices), m.indices);
    expect(r3).toBeLessThan(r0);
    expect(r10).toBeLessThan(r3);
    // The default is 10 pairs.
    expect(taubinSmooth(Float32Array.from(original), m.indices)).toEqual(taubinSmooth(Float32Array.from(original), m.indices, { pairs: 10 }));
  });

  it('is deterministic and independent of the triangle order', () => {
    const s = sampleField(24, teddy);
    const m = marchingCubes(s.field, s.dims, { origin: s.origin, voxel: s.voxel });
    const a = taubinSmooth(Float32Array.from(m.positions), m.indices);
    const b = taubinSmooth(Float32Array.from(m.positions), m.indices);
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    // Reverse the triangle list and rotate each triangle: the same edges, so the same result bit for bit.
    const reordered = new Uint32Array(m.indices.length);
    for (let t = 0; t < m.indices.length; t += 3) {
      const to = m.indices.length - 3 - t;
      reordered[to] = m.indices[t + 1];
      reordered[to + 1] = m.indices[t + 2];
      reordered[to + 2] = m.indices[t];
    }
    const c = taubinSmooth(Float32Array.from(m.positions), reordered);
    expect(Buffer.from(c.buffer).equals(Buffer.from(a.buffer))).toBe(true);
  });

  it('handles open meshes, isolated vertices, duplicate triangles and Float32 / Float64 positions', () => {
    // Vertex 4 is used by no triangle and must not move; the mesh is a single open quad.
    const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 9, 9, 9];
    const quad = [0, 1, 2, 0, 2, 3];
    const p32 = taubinSmooth(Float32Array.from(positions), quad, { pairs: 2 });
    const p64 = taubinSmooth(Float64Array.from(positions), quad, { pairs: 2 });
    expect(p32).toBeInstanceOf(Float32Array);
    expect(p64).toBeInstanceOf(Float64Array);
    expect(Array.from(p32.subarray(12))).toEqual([9, 9, 9]);
    expect(Array.from(p64.subarray(12))).toEqual([9, 9, 9]);
    for (let i = 0; i < 15; i++) expect(p32[i]).toBeCloseTo(p64[i], 5);
    // Planar input stays planar.
    for (let v = 0; v < 4; v++) expect(p64[3 * v + 2]).toBe(0);
    // Listing a triangle twice does not weigh its edges twice.
    const twice = taubinSmooth(Float64Array.from(positions), [...quad, ...quad], { pairs: 2 });
    expect(twice).toEqual(p64);
    // By hand, one shrink step on the quad: vertex 1 has neighbors 0 and 2, vertex 0 has 1, 2, 3.
    const one = taubinSmooth(Float64Array.from(positions), quad, { pairs: 1, lambda: 0.5, mu: 0 });
    expect(one[3]).toBeCloseTo(1 + 0.5 * ((0 + 1) / 2 - 1), 12);
    expect(one[4]).toBeCloseTo(0 + 0.5 * ((0 + 1) / 2 - 0), 12);
    expect(one[0]).toBeCloseTo(0 + 0.5 * ((1 + 1 + 0) / 3 - 0), 12);
    expect(one[1]).toBeCloseTo(0 + 0.5 * ((0 + 1 + 1) / 3 - 0), 12);
    // No triangles at all: nothing moves.
    expect(taubinSmooth(Float32Array.from(positions), [])).toEqual(Float32Array.from(positions));
    expect(taubinSmooth(new Float32Array(0), [])).toEqual(new Float32Array(0));
  });

  it('rejects malformed input', () => {
    const p = Float32Array.from(TET.positions);
    expect(() => taubinSmooth(p, TET.indices, { pairs: -1 })).toThrow(RangeError);
    expect(() => taubinSmooth(p, TET.indices, { pairs: 2.5 })).toThrow(RangeError);
    expect(() => taubinSmooth(p, TET.indices, { lambda: NaN })).toThrow(RangeError);
    expect(() => taubinSmooth(p, TET.indices, { mu: Infinity })).toThrow(RangeError);
    expect(() => taubinSmooth(p, [0, 1, 4])).toThrow(RangeError);
    expect(() => taubinSmooth(p, [0, 1])).toThrow(RangeError);
    expect(() => taubinSmooth(new Float32Array(4), [])).toThrow(RangeError);
    // A rejected call leaves the positions alone.
    expect(p).toEqual(Float32Array.from(TET.positions));
  });
});

describe('vertexAdjacency', () => {
  it('lists every neighbor once, ascending', () => {
    const { offsets, neighbors } = vertexAdjacency(TET.indices, 4);
    expect(Array.from(offsets)).toEqual([0, 3, 6, 9, 12]);
    expect(Array.from(neighbors)).toEqual([1, 2, 3, 0, 2, 3, 0, 1, 3, 0, 1, 2]);
  });

  it('works for open, duplicated and degenerate triangles and for unused vertices', () => {
    // Quad 0-1-2-3 split along 0-2, listed twice, plus a degenerate triangle (4, 4, 0); vertex 5 is unused.
    const { offsets, neighbors } = vertexAdjacency([0, 1, 2, 0, 2, 3, 0, 1, 2, 2, 0, 3, 4, 4, 0], 6);
    const row = (v: number): number[] => Array.from(neighbors.subarray(offsets[v], offsets[v + 1]));
    expect(row(0)).toEqual([1, 2, 3, 4]);
    expect(row(1)).toEqual([0, 2]);
    expect(row(2)).toEqual([0, 1, 3]);
    expect(row(3)).toEqual([0, 2]);
    expect(row(4)).toEqual([0]);
    expect(row(5)).toEqual([]);
    expect(offsets.length).toBe(7);
  });

  it('is symmetric on random triangle soups and matches a set-based construction', () => {
    const rng = mulberry32(11);
    for (let trial = 0; trial < 40; trial++) {
      const vertexCount = 3 + Math.floor(rng() * 20);
      const indices: number[] = [];
      const triangles = 1 + Math.floor(rng() * 40);
      for (let i = 0; i < 3 * triangles; i++) indices.push(Math.floor(rng() * vertexCount));
      const sets = Array.from({ length: vertexCount }, () => new Set<number>());
      for (let t = 0; t < indices.length; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = indices[t + e];
          const b = indices[t + ((e + 1) % 3)];
          if (a !== b) {
            sets[a].add(b);
            sets[b].add(a);
          }
        }
      }
      const { offsets, neighbors } = vertexAdjacency(indices, vertexCount);
      for (let v = 0; v < vertexCount; v++) {
        expect(Array.from(neighbors.subarray(offsets[v], offsets[v + 1]))).toEqual([...sets[v]].sort((x, y) => x - y));
      }
    }
  });

  it('handles a vertex with hundreds of neighbors (the hub of a fan)', () => {
    // 300 triangles around vertex 0, listed in a scrambled order, each twice.
    const rim = 300;
    const indices: number[] = [];
    for (let k = 0; k < rim; k++) {
      const a = 1 + ((k * 77) % rim);
      const b = 1 + ((((k * 77) % rim) + 1) % rim);
      indices.push(0, a, b, b, 0, a);
    }
    const { offsets, neighbors } = vertexAdjacency(indices, rim + 1);
    expect(Array.from(neighbors.subarray(offsets[0], offsets[1]))).toEqual(Array.from({ length: rim }, (_, i) => i + 1));
    expect(Array.from(neighbors.subarray(offsets[1], offsets[2]))).toEqual([0, 2, rim]);
    expect(Array.from(neighbors.subarray(offsets[rim], offsets[rim + 1]))).toEqual([0, 1, rim - 1]);
  });

  it('rejects malformed input', () => {
    expect(() => vertexAdjacency([0, 1], 3)).toThrow(RangeError);
    expect(() => vertexAdjacency([0, 1, 3], 3)).toThrow(RangeError);
    expect(() => vertexAdjacency([0, 1, -1], 3)).toThrow(RangeError);
    expect(() => vertexAdjacency([0, 1, 1.5], 3)).toThrow(RangeError);
    expect(() => vertexAdjacency([], -1)).toThrow(RangeError);
    expect(vertexAdjacency([], 0)).toEqual({ offsets: new Uint32Array(1), neighbors: new Uint32Array(0) });
  });
});
