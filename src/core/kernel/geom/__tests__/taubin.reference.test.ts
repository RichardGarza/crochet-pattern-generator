// taubin.ts against a reference. From the independent review of Step 0b.
//
// The reference below is a brute-force Jacobi iteration over neighbor Sets; it shares no code with the kernel
// (no compressed rows, no sorting).
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { marchingCubes } from '../marchingCubes';
import { TAUBIN_LAMBDA, TAUBIN_MU, taubinSmooth, vertexAdjacency } from '../taubin';
import { HEAVY, note } from './fields';

function referenceTaubin(positions: ArrayLike<number>, indices: ArrayLike<number>, pairs: number, lambda: number, mu: number): Float64Array {
  const n = positions.length / 3;
  const neighbors: Set<number>[] = Array.from({ length: n }, () => new Set<number>());
  for (let t = 0; t < indices.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[t + e];
      const b = indices[t + ((e + 1) % 3)];
      if (a === b) continue;
      neighbors[a].add(b);
      neighbors[b].add(a);
    }
  }
  let p = Float64Array.from(positions);
  for (let pair = 0; pair < pairs; pair++) {
    for (const factor of [lambda, mu]) {
      const q = new Float64Array(p.length);
      for (let v = 0; v < n; v++) {
        for (let a = 0; a < 3; a++) {
          if (neighbors[v].size === 0) {
            q[3 * v + a] = p[3 * v + a];
            continue;
          }
          let mean = 0;
          for (const w of neighbors[v]) mean += p[3 * w + a];
          mean /= neighbors[v].size;
          q[3 * v + a] = p[3 * v + a] + factor * (mean - p[3 * v + a]);
        }
      }
      p = q;
    }
  }
  return p;
}

function signedVolumeOf(positions: ArrayLike<number>, indices: ArrayLike<number>): number {
  let six = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = 3 * indices[t];
    const b = 3 * indices[t + 1];
    const c = 3 * indices[t + 2];
    six +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) +
      positions[a + 1] * (positions[b + 2] * positions[c] - positions[b] * positions[c + 2]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  return six / 6;
}

function soup(seed: number): { positions: Float64Array; indices: number[] } {
  const rng = mulberry32(seed * 31 + 1);
  const vertices = 1 + Math.floor(rng() * 40);
  const triangles = Math.floor(rng() * 80);
  const positions = Float64Array.from({ length: 3 * vertices }, () => (rng() * 2 - 1) * 10);
  const indices: number[] = [];
  // random triangles: repeated indices, duplicate triangles, non-manifold edges and unused vertices all occur
  for (let i = 0; i < 3 * triangles; i++) indices.push(Math.floor(rng() * vertices));
  return { positions, indices };
}

function sphereField(n: number, radiusVoxels: number): { field: Float32Array<ArrayBuffer>; dims: [number, number, number] } {
  const field = new Float32Array(n * n * n);
  const c = (n - 1) / 2;
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) field[i++] = radiusVoxels - Math.hypot(x - c, y - c, z - c);
  return { field, dims: [n, n, n] };
}

describe('taubinSmooth against a brute-force Jacobi reference', () => {
  it('agrees on random triangle soups (open, non-manifold, duplicated, degenerate), any pairs / λ / μ', () => {
    let worst = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const s = soup(seed);
      const rng = mulberry32(seed);
      const pairs = Math.floor(rng() * 6);
      const lambda = seed % 3 === 0 ? TAUBIN_LAMBDA : rng();
      const mu = seed % 3 === 0 ? TAUBIN_MU : -rng();
      const expected = referenceTaubin(s.positions, s.indices, pairs, lambda, mu);
      const indicesBefore = [...s.indices];
      const got = taubinSmooth(Float64Array.from(s.positions), s.indices, { pairs, lambda, mu });
      expect(s.indices).toEqual(indicesBefore);
      for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(got[i] - expected[i]));
    }
    // coordinates are within ±10 and grow by at most a few times: 1e-11 is rounding only
    expect(worst).toBeLessThan(1e-11);
  });

  it('agrees on marching-cubes meshes (10 default pairs), in Float64 and — after one rounding — in Float32', () => {
    const rng = mulberry32(3);
    const noise = Float32Array.from({ length: 12 * 11 * 10 }, () => rng() * 2 - 1);
    const cases = [marchingCubes(noise, [12, 11, 10]), marchingCubes(sphereField(20, 7.3).field, [20, 20, 20])];
    for (const m of cases) {
      const expected = referenceTaubin(m.positions, m.indices, 10, TAUBIN_LAMBDA, TAUBIN_MU);
      const p64 = taubinSmooth(Float64Array.from(m.positions), m.indices);
      let worst = 0;
      for (let i = 0; i < expected.length; i++) worst = Math.max(worst, Math.abs(p64[i] - expected[i]));
      expect(worst).toBeLessThan(1e-11);
      // The Float32 path is the Float64 path rounded once at the end, bit for bit.
      const p32 = taubinSmooth(Float32Array.from(m.positions), m.indices);
      for (let i = 0; i < p32.length; i++) if (p32[i] !== Math.fround(p64[i])) throw new Error(`float32 result differs at ${i}`);
    }
  });

  it('does not depend on triangle order, rotation or winding, and never writes the index buffer', () => {
    const m = marchingCubes(sphereField(18, 6.1).field, [18, 18, 18]);
    const base = taubinSmooth(Float32Array.from(m.positions), m.indices);
    const rng = mulberry32(77);
    for (let trial = 0; trial < 12; trial++) {
      const triangles = m.indices.length / 3;
      const order = Array.from({ length: triangles }, (_, i) => i);
      for (let i = triangles - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      const shuffled: number[] = [];
      for (const t of order) {
        const tri = [m.indices[3 * t], m.indices[3 * t + 1], m.indices[3 * t + 2]];
        const rotate = Math.floor(rng() * 3);
        const flip = rng() < 0.5;
        const r = [tri[rotate], tri[(rotate + 1) % 3], tri[(rotate + 2) % 3]];
        shuffled.push(r[0], flip ? r[2] : r[1], flip ? r[1] : r[2]);
      }
      // a frozen array: a write to the index buffer would throw
      const frozen = Object.freeze(shuffled);
      const again = taubinSmooth(Float32Array.from(m.positions), frozen);
      expect(Buffer.from(again.buffer).equals(Buffer.from(base.buffer))).toBe(true);
    }
    const indicesCopy = Uint32Array.from(m.indices);
    taubinSmooth(Float32Array.from(m.positions), m.indices, { pairs: 3 });
    expect(Buffer.from(m.indices.buffer).equals(Buffer.from(indicesCopy.buffer))).toBe(true);
  });

  it('vertexAdjacency: a hub with 200 000 neighbors is handled in well under a second', { ...HEAVY, retry: 2 }, () => {
    const rim = 200_000;
    const indices = new Uint32Array(3 * rim);
    for (let k = 0; k < rim; k++) {
      // descending rim order: the worst case for an insertion sort
      indices[3 * k] = 0;
      indices[3 * k + 1] = rim - k;
      indices[3 * k + 2] = ((rim - k) % rim) + 1;
    }
    const start = performance.now();
    const { offsets, neighbors } = vertexAdjacency(indices, rim + 1);
    const ms = performance.now() - start;
    expect(offsets[1] - offsets[0]).toBe(rim);
    expect(neighbors[0]).toBe(1);
    expect(neighbors[rim - 1]).toBe(rim);
    note(`vertexAdjacency, hub with ${rim} neighbors: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(1000);
  });

  it('a row of exactly 64 or 65 raw entries (the switch between the two sorts) is still sorted and unique', () => {
    for (const fan of [31, 32, 33, 64, 65]) {
      // `fan` triangles around vertex 0 ⇒ 2·fan raw entries in its row
      const indices: number[] = [];
      for (let k = 0; k < fan; k++) indices.push(0, 1 + ((k * 7) % fan), 1 + ((k * 7 + 1) % fan));
      const { offsets, neighbors } = vertexAdjacency(indices, fan + 1);
      const row = Array.from(neighbors.subarray(offsets[0], offsets[1]));
      expect(row).toEqual(Array.from({ length: fan }, (_, i) => i + 1));
    }
  });
});

describe('what Taubin does to volume (measured; the acceptance item is "within 2%" on the sphere)', HEAVY, () => {
  it('sphere r = 0.8 in [−1.1, 1.1]³ at N = 64 and 128: well within 2%', () => {
    const report: Record<string, string> = {};
    for (const n of [64, 128]) {
      const voxel = 2.2 / (n - 1);
      const { field, dims } = sphereField(n, 0.8 / voxel);
      const m = marchingCubes(field, dims);
      const before = signedVolumeOf(m.positions, m.indices);
      taubinSmooth(m.positions, m.indices);
      const after = signedVolumeOf(m.positions, m.indices);
      report[`N=${n}`] = `${((after / before - 1) * 100).toFixed(3)}%`;
      expect(Math.abs(after / before - 1)).toBeLessThan(0.02);
      const analytic = (4 / 3) * Math.PI * (0.8 / voxel) ** 3;
      expect(Math.abs(after / analytic - 1)).toBeLessThan(0.02);
    }
    note(`Taubin ×10 volume change, sphere r = 0.8: ${JSON.stringify(report)}`);
  });

  it('small features change by more than 2% (information for T3/T5: the 2% holds for radii of about 4 voxels and more)', () => {
    // Measured, 10 default pairs: sphere r = 1.2 voxels −45.7%, r = 2 −4.7%, r = 3 +2.4%, r = 5 +1.5%, r = 8 +0.6%,
    // r = 16 +0.2%; rod r = 1.5 voxels +1.4%; disc 2 voxels thick +0.3%; a single-sample speck −100%.
    const report: Record<string, string> = {};
    const ratios: Record<string, number> = {};
    const change = (label: string, field: ArrayLike<number>, dims: [number, number, number], pairs = 10): number => {
      const m = marchingCubes(field, dims);
      const before = signedVolumeOf(m.positions, m.indices);
      taubinSmooth(m.positions, m.indices, { pairs });
      const ratio = signedVolumeOf(m.positions, m.indices) / before;
      report[label] = `${((ratio - 1) * 100).toFixed(2)}%`;
      ratios[label] = ratio;
      return ratio;
    };
    for (const r of [1.2, 2, 3, 5, 8, 16]) {
      const { field, dims } = sphereField(Math.ceil(2 * r) + 6, r);
      change(`sphere r=${r} voxels`, field, dims);
    }
    // a rod of radius 1.5 voxels, 40 voxels long (a thin limb)
    const rodDims: [number, number, number] = [9, 9, 48];
    const rod = new Float32Array(9 * 9 * 48);
    for (let z = 0; z < 48; z++) for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) rod[x + 9 * (y + 9 * z)] = Math.min(1.5 - Math.hypot(x - 4, y - 4), Math.min(z - 3.5, 43.5 - z));
    change('rod r=1.5 voxels', rod, rodDims);
    // a plate 2 voxels thick (an ear): the "features thinner than 2 voxels" of §2.9.5 step 5
    const plateDims: [number, number, number] = [30, 30, 8];
    const plate = new Float32Array(30 * 30 * 8);
    for (let z = 0; z < 8; z++) for (let y = 0; y < 30; y++) for (let x = 0; x < 30; x++) plate[x + 30 * (y + 30 * z)] = Math.min(1 - Math.abs(z - 3.5), 12 - Math.hypot(x - 14.5, y - 14.5));
    change('disc 2 voxels thick, r=12', plate, plateDims);
    // one isolated inside sample: the octahedron of the clamp
    const speck = change('single inside sample (speck)', Float32Array.of(1), [1, 1, 1]);
    note(`Taubin ×10 volume change by feature size: ${JSON.stringify(report, null, 1)}`);
    // A speck is a regular octahedron: L(p) = −p, so each pair scales it by (1 − λ)(1 − μ) = 0.618 and ten pairs
    // by 0.0081: its volume falls by a factor of 1.9 million.
    expect(speck).toBeCloseTo(((1 - TAUBIN_LAMBDA) * (1 - TAUBIN_MU)) ** 30, 9);
    // Outside the 2% of the acceptance item:
    expect(Math.abs(ratios['sphere r=1.2 voxels'] - 1)).toBeGreaterThan(0.4);
    expect(Math.abs(ratios['sphere r=2 voxels'] - 1)).toBeGreaterThan(0.04);
    expect(Math.abs(ratios['sphere r=3 voxels'] - 1)).toBeGreaterThan(0.02);
    // Inside it:
    for (const label of ['sphere r=5 voxels', 'sphere r=8 voxels', 'sphere r=16 voxels', 'rod r=1.5 voxels', 'disc 2 voxels thick, r=12']) {
      expect(Math.abs(ratios[label] - 1)).toBeLessThan(0.02);
    }
  });
});

describe('taubinSmooth edge cases', () => {
  it('a NaN position spreads to its neighborhood without an error (documented: positions are not validated)', () => {
    const m = marchingCubes(sphereField(10, 3).field, [10, 10, 10]);
    const p = Float32Array.from(m.positions);
    p[0] = NaN;
    taubinSmooth(p, m.indices, { pairs: 2 });
    let nan = 0;
    for (let i = 0; i < p.length; i++) if (Number.isNaN(p[i])) nan++;
    expect(nan).toBeGreaterThan(1);
  });

  it('validates before it writes: a bad index, a bad option or a bad length leaves the positions untouched', () => {
    const p = Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0);
    const copy = Float32Array.from(p);
    expect(() => taubinSmooth(p, [0, 1, 3])).toThrow(RangeError);
    expect(() => taubinSmooth(p, [0, 1, 2], { pairs: 1.5 })).toThrow(RangeError);
    expect(() => taubinSmooth(p, [0, 1, 2], { pairs: Infinity })).toThrow(RangeError);
    expect(() => taubinSmooth(p, [0, 1, 2], { lambda: NaN })).toThrow(RangeError);
    expect(() => taubinSmooth(p, [0, 1, 2, 0])).toThrow(RangeError);
    expect(p).toEqual(copy);
  });

  it('a subarray view and a mesh much larger than its index buffer work', () => {
    const backing = new Float32Array(30).fill(7);
    const view = backing.subarray(9, 21); // 4 vertices
    view.set([0, 0, 0, 3, 0, 0, 0, 3, 0, 0, 0, 3]);
    const out = taubinSmooth(view, [0, 1, 2, 0, 2, 3], { pairs: 1, lambda: 0.5, mu: 0 });
    expect(out).toBe(view);
    // vertex 0 has neighbors 1, 2, 3: mean (1, 1, 1), half way there
    expect(Array.from(view.subarray(0, 3))).toEqual([0.5, 0.5, 0.5]);
    // nothing outside the view moved
    expect(Array.from(backing.subarray(0, 9))).toEqual(new Array(9).fill(7));
    expect(Array.from(backing.subarray(21))).toEqual(new Array(9).fill(7));
  });
});
