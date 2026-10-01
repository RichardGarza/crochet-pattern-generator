import { describe, expect, it } from 'vitest';
import { mulberry32, type Rng } from '../../prng';
import {
  edt1d,
  edt2d,
  edt3d,
  edtSquared1d,
  edtSquared2d,
  edtSquared3d,
  extendSignedDistance3d,
  signedEdt1d,
  signedEdt2d,
  signedEdt3d,
} from '../edt';
import { marchingCubes } from '../marchingCubes';
import { countComponents, edgeStats, eulerCharacteristic, signedVolume } from '../meshMeasures';
import { HEAVY } from './fields';

// ---- brute force -----------------------------------------------------------------------------------------

/** Lattice coordinates of index i in a grid with the given dimensions (x fastest); missing axes are 0. */
function coords(i: number, dims: readonly number[]): [number, number, number] {
  const nx = dims[0];
  const ny = dims[1] ?? 1;
  return [i % nx, Math.floor(i / nx) % ny, Math.floor(i / (nx * ny))];
}

function total(dims: readonly number[]): number {
  return dims.reduce((a, b) => a * b, 1);
}

/** ‖(p − q)·spacing‖² */
function gap2(p: number, q: number, dims: readonly number[], spacing: readonly number[]): number {
  const a = coords(p, dims);
  const b = coords(q, dims);
  let sum = 0;
  for (let k = 0; k < dims.length; k++) sum += ((a[k] - b[k]) * spacing[k]) ** 2;
  return sum;
}

/** D(p) = min over q of ‖p − q‖² + seeds[q], by trying every q. */
function bruteSquared(seeds: ArrayLike<number>, dims: readonly number[], spacing: readonly number[]): Float64Array {
  const n = total(dims);
  const out = new Float64Array(n).fill(Infinity);
  for (let p = 0; p < n; p++) {
    for (let q = 0; q < n; q++) {
      if (!(seeds[q] < Infinity)) continue;
      const cost = gap2(p, q, dims, spacing) + seeds[q];
      if (cost < out[p]) out[p] = cost;
    }
  }
  return out;
}

/** Squared distance from every sample to the nearest sample where `feature(i)` holds. */
function bruteMask(n: number, feature: (i: number) => boolean, dims: readonly number[], spacing: readonly number[]): Float64Array {
  const seeds = new Float64Array(n);
  for (let i = 0; i < n; i++) seeds[i] = feature(i) ? 0 : Infinity;
  return bruteSquared(seeds, dims, spacing);
}

function randomDims(rng: Rng, axes: number, max: number): number[] {
  return Array.from({ length: axes }, () => 1 + Math.floor(rng() * max));
}

function randomMask(rng: Rng, n: number): Uint8Array {
  const density = rng() < 0.15 ? rng() * 0.05 : rng();
  return Uint8Array.from({ length: n }, () => (rng() < density ? 1 : 0));
}

function randomSeeds(rng: Rng, n: number, integers: boolean): Float64Array {
  const density = rng() < 0.2 ? rng() * 0.1 : rng();
  return Float64Array.from({ length: n }, () => (rng() < density ? (integers ? Math.floor(rng() * 30) : rng() * 30) : Infinity));
}

/** Largest |a − b| relative to max(1, |b|); Infinity must match exactly. */
function worstError(a: ArrayLike<number>, b: ArrayLike<number>): number {
  expect(a.length).toBe(b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const err = Math.abs(a[i] - b[i]) / Math.max(1, Math.abs(b[i]));
    worst = err > worst || err !== err ? err : worst;
  }
  return worst;
}

type Transform = (v: Float64Array | Float32Array, dims: number[], o: { spacing?: number[]; nearest?: Int32Array }) => unknown;
const squared: Record<number, Transform> = {
  1: (v, _dims, o) => edtSquared1d(v, { spacing: o.spacing?.[0], nearest: o.nearest }),
  2: (v, dims, o) => edtSquared2d(v, dims[0], dims[1], { spacing: o.spacing as [number, number] | undefined, nearest: o.nearest }),
  3: (v, dims, o) =>
    edtSquared3d(v, dims as [number, number, number], { spacing: o.spacing as [number, number, number] | undefined, nearest: o.nearest }),
};

// ---- the generalized (seeded) squared transform ------------------------------------------------------------

describe('edtSquared1d', () => {
  it('plain seeds: squared distance to the nearest seed', () => {
    const v = Float64Array.of(Infinity, 0, Infinity, Infinity, 0, Infinity, Infinity, Infinity);
    expect(edtSquared1d(v)).toBe(v);
    expect(Array.from(v)).toEqual([1, 0, 1, 1, 0, 1, 4, 9]);
    expect(Array.from(edtSquared1d(Float64Array.of(Infinity, 0, Infinity, Infinity), { spacing: 2 }))).toEqual([4, 0, 4, 16]);
    expect(Array.from(edtSquared1d(Float32Array.of(Infinity, Infinity, 0)))).toEqual([4, 1, 0]);
  });

  it('weighted seeds: D(p) = min over q of (p − q)² + s(q), and which q won', () => {
    const nearest = new Int32Array(4);
    const v = Float64Array.of(5, Infinity, 0.5, Infinity);
    edtSquared1d(v, { nearest });
    expect(Array.from(v)).toEqual([4.5, 1.5, 0.5, 1.5]);
    expect(Array.from(nearest)).toEqual([2, 2, 2, 2]);
    // A cheap seed does not always win at its own position… and an expensive one may never win.
    const w = Float64Array.of(0, 100, 3, Infinity, 0);
    const who = new Int32Array(5);
    edtSquared1d(w, { nearest: who });
    expect(Array.from(w)).toEqual([0, 1, 3, 1, 0]);
    expect(Array.from(who)).toEqual([0, 0, 2, 4, 4]);
  });

  it('a tie goes to the lower index', () => {
    const nearest = new Int32Array(5);
    edtSquared1d(Float64Array.of(0, Infinity, 0, Infinity, 0), { nearest });
    expect(Array.from(nearest)).toEqual([0, 0, 2, 2, 4]);
  });

  it('no seed: all +Infinity, nearest −1; NaN means "no seed"; −Infinity is rejected', () => {
    const nearest = new Int32Array(3).fill(7);
    expect(Array.from(edtSquared1d(new Float64Array(3).fill(Infinity), { nearest }))).toEqual([Infinity, Infinity, Infinity]);
    expect(Array.from(nearest)).toEqual([-1, -1, -1]);
    expect(Array.from(edtSquared1d(Float64Array.of(NaN, NaN)))).toEqual([Infinity, Infinity]);
    expect(Array.from(edtSquared1d(Float64Array.of(NaN, 0, NaN)))).toEqual([1, 0, 1]);
    expect(() => edtSquared1d(Float64Array.of(0, -Infinity))).toThrow(RangeError);
    expect(edtSquared1d(new Float64Array(0))).toEqual(new Float64Array(0));
    expect(Array.from(edtSquared1d(Float64Array.of(3)))).toEqual([3]);
    // A huge finite cost works as "practically no seed" too, without NaN.
    expect(Array.from(edtSquared1d(Float64Array.of(1e20, 0, 1e20)))).toEqual([1, 0, 1]);
  });

  it('negative finite costs are allowed', () => {
    expect(Array.from(edtSquared1d(Float64Array.of(-4, Infinity, Infinity, 0)))).toEqual([-4, -3, 0, 0]);
  });

  it('rejects bad options', () => {
    expect(() => edtSquared1d(new Float64Array(3), { spacing: 0 })).toThrow(RangeError);
    expect(() => edtSquared1d(new Float64Array(3), { spacing: -1 })).toThrow(RangeError);
    expect(() => edtSquared1d(new Float64Array(3), { spacing: NaN })).toThrow(RangeError);
    expect(() => edtSquared1d(new Float64Array(3), { nearest: new Int32Array(2) })).toThrow(RangeError);
  });
});

describe('edtSquared1d/2d/3d against brute force', () => {
  it.each([1, 2, 3])('%iD: integer seeds at unit spacing are exact, in Float64 and Float32 arrays', (axes) => {
    const rng = mulberry32(100 + axes);
    for (let trial = 0; trial < (axes === 3 ? 60 : 150); trial++) {
      const dims = randomDims(rng, axes, axes === 1 ? 40 : axes === 2 ? 12 : 7);
      const seeds = randomSeeds(rng, total(dims), true);
      const expected = bruteSquared(
        seeds,
        dims,
        dims.map(() => 1),
      );
      const v64 = Float64Array.from(seeds);
      squared[axes](v64, dims, {});
      expect(v64).toEqual(expected);
      const v32 = Float32Array.from(seeds);
      squared[axes](v32, dims, {});
      expect(v32).toEqual(Float32Array.from(expected));
    }
  });

  it.each([1, 2, 3])('%iD: real seeds and per-axis spacing agree to rounding, and `nearest` names a winning seed', (axes) => {
    const rng = mulberry32(200 + axes);
    let worst = 0;
    let badNearest = 0;
    for (let trial = 0; trial < (axes === 3 ? 60 : 150); trial++) {
      const dims = randomDims(rng, axes, axes === 1 ? 40 : axes === 2 ? 12 : 7);
      const spacing = dims.map(() => (trial % 3 === 0 ? 1 : 0.25 + 3 * rng()));
      const seeds = randomSeeds(rng, total(dims), trial % 2 === 0);
      const expected = bruteSquared(seeds, dims, spacing);
      const v = Float64Array.from(seeds);
      const nearest = new Int32Array(v.length).fill(-5);
      squared[axes](v, dims, { spacing, nearest });
      worst = Math.max(worst, worstError(v, expected));
      for (let p = 0; p < v.length; p++) {
        const q = nearest[p];
        if (expected[p] === Infinity) {
          if (q !== -1) badNearest++;
        } else if (!(q >= 0 && q < v.length && seeds[q] < Infinity)) {
          badNearest++;
        } else if (Math.abs(gap2(p, q, dims, spacing) + seeds[q] - expected[p]) > 1e-9 * Math.max(1, expected[p])) {
          badNearest++;
        }
      }
    }
    expect(worst).toBeLessThan(1e-12);
    expect(badNearest).toBe(0);
  });

  it('a single seed gives the squared distance to it (3-4-5 and 2-3-6-7 triangles)', () => {
    const v = new Float64Array(9 * 9).fill(Infinity);
    v[0] = 0;
    edtSquared2d(v, 9, 9);
    expect(v[3 + 9 * 4]).toBe(25);
    expect(v[8 + 9 * 8]).toBe(128);
    const w = new Float32Array(8 * 8 * 8).fill(Infinity);
    w[1 + 8 * (1 + 8 * 1)] = 0;
    edtSquared3d(w, [8, 8, 8]);
    expect(w[3 + 8 * (4 + 8 * 7)]).toBe(49);
    // With spacing the same grid is measured in world units.
    const s = new Float64Array(9 * 9).fill(Infinity);
    s[0] = 0;
    edtSquared2d(s, 9, 9, { spacing: [0.5, 2] });
    expect(s[6 + 9 * 2]).toBe(9 + 16);
    // One spacing number means the same spacing on every axis.
    const a = new Float64Array(27).fill(Infinity);
    const b = new Float64Array(27).fill(Infinity);
    a[5] = 0;
    b[5] = 0;
    expect(edtSquared3d(a, [3, 3, 3], { spacing: 1.5 })).toEqual(edtSquared3d(b, [3, 3, 3], { spacing: [1.5, 1.5, 1.5] }));
  });

  it('rejects malformed grids', () => {
    expect(() => edtSquared2d(new Float64Array(6), 2, 2)).toThrow(RangeError);
    expect(() => edtSquared2d(new Float64Array(6), 0, 6)).toThrow(RangeError);
    expect(() => edtSquared2d(new Float64Array(6), 2, 3, { spacing: [1, 0] })).toThrow(RangeError);
    expect(() => edtSquared2d(new Float64Array(6), 2, 3, { nearest: new Int32Array(5) })).toThrow(RangeError);
    expect(() => edtSquared3d(new Float64Array(8), [2, 2, 3])).toThrow(RangeError);
    expect(() => edtSquared3d(new Float64Array(8), [2, 2.5, 2] as never)).toThrow(RangeError);
    expect(() => edtSquared3d(new Float64Array(8), [2, 2, 2], { spacing: [1, 1, -1] })).toThrow(RangeError);
    expect(() => edtSquared3d(Float64Array.of(0, 0, 0, 0, 0, 0, 0, -Infinity), [2, 2, 2])).toThrow(RangeError);
  });
});

// ---- masks -----------------------------------------------------------------------------------------------

describe('edt1d/2d/3d of a mask against brute force', () => {
  it('1D, 2D and 3D at unit spacing equal the exact distance, bit for bit', () => {
    const rng = mulberry32(31);
    for (let trial = 0; trial < 240; trial++) {
      const axes = 1 + (trial % 3);
      const dims = randomDims(rng, axes, axes === 1 ? 50 : axes === 2 ? 14 : 7);
      const mask = randomMask(rng, total(dims));
      const brute = bruteMask(
        mask.length,
        (i) => mask[i] !== 0,
        dims,
        dims.map(() => 1),
      );
      const expected = Float32Array.from(brute, Math.sqrt);
      const got = axes === 1 ? edt1d(mask) : axes === 2 ? edt2d(mask, dims[0], dims[1]) : edt3d(mask, dims as [number, number, number]);
      expect(got).toEqual(expected);
    }
  });

  it('with spacing: one number scales the distances, per-axis spacing stretches the grid', () => {
    const rng = mulberry32(32);
    let worst = 0;
    for (let trial = 0; trial < 120; trial++) {
      const axes = 2 + (trial % 2);
      const dims = randomDims(rng, axes, axes === 2 ? 12 : 6);
      const mask = randomMask(rng, total(dims));
      const spacing = dims.map(() => 0.2 + 2 * rng());
      const brute = Float64Array.from(
        bruteMask(mask.length, (i) => mask[i] !== 0, dims, spacing),
        Math.sqrt,
      );
      const got =
        axes === 2
          ? edt2d(mask, dims[0], dims[1], { spacing: spacing as [number, number] })
          : edt3d(mask, dims as [number, number, number], { spacing: spacing as [number, number, number] });
      worst = Math.max(worst, worstError(got, brute));
      // Isotropic: exactly spacing × the exact distance in samples, rounded to float32 once.
      const inSamples = bruteMask(
        mask.length,
        (i) => mask[i] !== 0,
        dims,
        dims.map(() => 1),
      );
      const scaled =
        axes === 2 ? edt2d(mask, dims[0], dims[1], { spacing: 0.37 }) : edt3d(mask, dims as [number, number, number], { spacing: 0.37 });
      expect(scaled).toEqual(Float32Array.from(inSamples, (d2) => 0.37 * Math.sqrt(d2)));
    }
    expect(worst).toBeLessThan(1e-6);
    expect(Array.from(edt1d([0, 0, 1, 0], { spacing: 2.5 }))).toEqual([5, 2.5, 0, 2.5]);
  });

  it('empty mask: +Infinity everywhere; full mask: 0 everywhere; any non-zero value is a feature', () => {
    expect(Array.from(edt1d(new Uint8Array(3)))).toEqual([Infinity, Infinity, Infinity]);
    expect(Array.from(edt2d(new Uint8Array(6), 3, 2))).toEqual(Array(6).fill(Infinity));
    expect(Array.from(edt3d(new Uint8Array(8), [2, 2, 2]))).toEqual(Array(8).fill(Infinity));
    expect(Array.from(edt2d(new Uint8Array(6).fill(1), 3, 2))).toEqual(Array(6).fill(0));
    expect(Array.from(edt3d(new Uint8Array(8).fill(9), [2, 2, 2]))).toEqual(Array(8).fill(0));
    expect(Array.from(edt1d([0, 255, 0, -1, 0, 0]))).toEqual([1, 0, 1, 0, 1, 2]);
    expect(Array.from(edt1d([]))).toEqual([]);
    expect(edt2d(new Uint8Array(6), 3, 2)).toBeInstanceOf(Float32Array);
  });

  it('known distances: a single feature pixel in a 512² image', () => {
    const mask = new Uint8Array(512 * 512);
    mask[100 + 512 * 200] = 1;
    const d = edt2d(mask, 512, 512);
    expect(d[100 + 512 * 200]).toBe(0);
    expect(d[103 + 512 * 204]).toBe(5);
    expect(d[0]).toBe(Math.fround(Math.hypot(100, 200)));
    expect(d[511 + 512 * 511]).toBe(Math.fround(Math.hypot(411, 311)));
  });

  it('rejects malformed input', () => {
    expect(() => edt2d(new Uint8Array(5), 2, 3)).toThrow(RangeError);
    expect(() => edt2d(new Uint8Array(6), 2, 3, { spacing: 0 })).toThrow(RangeError);
    expect(() => edt2d(new Uint8Array(6), 2, 3, { spacing: [1, NaN] })).toThrow(RangeError);
    expect(() => edt2d(new Uint8Array(6), 6, 0)).toThrow(RangeError);
    expect(() => edt3d(new Uint8Array(9), [2, 2, 2])).toThrow(RangeError);
    expect(() => edt3d(new Uint8Array(8), [2, 2, 2], { spacing: [1, 1, 0] })).toThrow(RangeError);
    expect(() => edt1d([1, 0], { spacing: -1 })).toThrow(RangeError);
    expect(() => edt1d([], { spacing: 0 })).toThrow(RangeError);
  });
});

// ---- signed ----------------------------------------------------------------------------------------------

/** The definition of the signed transform, by brute force. */
function bruteSigned(mask: ArrayLike<number>, dims: readonly number[], spacing: number, half: number): Float32Array {
  const unit = dims.map(() => 1);
  const toOutside = bruteMask(mask.length, (i) => mask[i] === 0, dims, unit);
  const toInside = bruteMask(mask.length, (i) => mask[i] !== 0, dims, unit);
  return Float32Array.from({ length: mask.length }, (_, i) =>
    mask[i] !== 0 ? spacing * (Math.sqrt(toOutside[i]) - half) : -spacing * (Math.sqrt(toInside[i]) - half),
  );
}

describe('signedEdt1d/2d/3d', () => {
  it('equals its definition by brute force, for both boundary conventions', () => {
    const rng = mulberry32(41);
    for (let trial = 0; trial < 240; trial++) {
      const axes = 1 + (trial % 3);
      const dims = randomDims(rng, axes, axes === 1 ? 40 : axes === 2 ? 12 : 6);
      const mask = randomMask(rng, total(dims));
      for (const measureTo of ['boundary', 'samples'] as const) {
        const spacing = trial % 4 === 0 ? 1 : 0.25;
        const expected = bruteSigned(mask, dims, spacing, measureTo === 'boundary' ? 0.5 : 0);
        const o = { spacing, measureTo };
        const got =
          axes === 1 ? signedEdt1d(mask, o) : axes === 2 ? signedEdt2d(mask, dims[0], dims[1], o) : signedEdt3d(mask, dims as [number, number, number], o);
        expect(got).toEqual(expected);
      }
    }
  });

  it('is positive exactly on the mask and never 0: at least 1 spacing away from 0, or half with `boundary`', () => {
    const rng = mulberry32(42);
    for (let trial = 0; trial < 50; trial++) {
      const dims = randomDims(rng, 2, 16);
      const mask = randomMask(rng, total(dims));
      const samples = signedEdt2d(mask, dims[0], dims[1]);
      const boundary = signedEdt2d(mask, dims[0], dims[1], { measureTo: 'boundary' });
      let wrong = 0;
      for (let i = 0; i < mask.length; i++) {
        if (mask[i] !== 0 ? !(samples[i] >= 1 && boundary[i] >= 0.5) : !(samples[i] <= -1 && boundary[i] <= -0.5)) wrong++;
      }
      expect(wrong).toBe(0);
    }
  });

  it("the default is 'samples', the exact transform of §2.9.3: max(sd, 0) is the plain inside transform", () => {
    const rng = mulberry32(43);
    for (let trial = 0; trial < 30; trial++) {
      const dims = randomDims(rng, 2, 14);
      const mask = randomMask(rng, total(dims));
      const sd = signedEdt2d(mask, dims[0], dims[1]);
      expect(sd).toEqual(signedEdt2d(mask, dims[0], dims[1], { measureTo: 'samples' }));
      // The distance from every pixel to the nearest OUTSIDE pixel is the plain transform of the inverted mask.
      const inside = edt2d(
        mask.map((v) => (v ? 0 : 1)),
        dims[0],
        dims[1],
      );
      const outside = edt2d(mask, dims[0], dims[1]);
      expect(sd.map((v) => Math.max(v, 0))).toEqual(inside);
      expect(sd.map((v) => Math.max(-v, 0))).toEqual(outside);
    }
  });

  it("'boundary' is the exact distance to a straight boundary between the pixels; 'samples' is half a pixel more", () => {
    // Inside: x ≥ 4 on a 10×3 image. The boundary is the line x = 3.5 (in pixel-center coordinates).
    const mask = Uint8Array.from({ length: 30 }, (_, i) => (i % 10 >= 4 ? 1 : 0));
    const toBoundary = signedEdt2d(mask, 10, 3, { measureTo: 'boundary' });
    const toSamples = signedEdt2d(mask, 10, 3);
    for (let i = 0; i < 30; i++) {
      const x = i % 10;
      expect(toBoundary[i]).toBe(x - 3.5);
      expect(toSamples[i]).toBe(x >= 4 ? x - 3 : x - 4);
    }
    expect(Array.from(signedEdt1d([0, 0, 1, 1, 1, 0]))).toEqual([-2, -1, 1, 2, 1, -1]);
    expect(Array.from(signedEdt1d([0, 0, 1, 1, 1, 0], { measureTo: 'boundary' }))).toEqual([-1.5, -0.5, 0.5, 1.5, 0.5, -0.5]);
    expect(Array.from(signedEdt1d([0, 1, 1], { spacing: 0.5 }))).toEqual([-0.5, 0.5, 1]);
    expect(Array.from(signedEdt1d([0, 1, 1], { spacing: 0.5, measureTo: 'boundary' }))).toEqual([-0.25, 0.25, 0.75]);
  });

  it("on a disc, 'boundary' is within half a pixel of the true distance and unbiased at the outline; 'samples' is up to a pixel long", () => {
    const n = 96;
    const R = 30.3;
    const c = [47.2, 48.6];
    const mask = new Uint8Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) mask[x + n * y] = Math.hypot(x - c[0], y - c[1]) < R ? 1 : 0;
    const stats = (measureTo: 'boundary' | 'samples'): { nearBias: number; low: number; high: number } => {
      const sd = signedEdt2d(mask, n, n, { measureTo });
      let nearSum = 0;
      let near = 0;
      let low = Infinity;
      let high = -Infinity;
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          const truth = R - Math.hypot(x - c[0], y - c[1]);
          // Error of the magnitude: positive = the transform says "farther from the boundary" than the truth.
          const err = Math.abs(sd[x + n * y]) - Math.abs(truth);
          low = Math.min(low, err);
          high = Math.max(high, err);
          if (Math.abs(truth) < 1) {
            nearSum += err;
            near++;
          }
        }
      }
      return { nearBias: nearSum / near, low, high };
    };
    const toBoundary = stats('boundary');
    const toSamples = stats('samples');
    // A pixel-center distance is never shorter than the true distance to the outline and less than a pixel
    // longer: 'samples' errs in [0, 1), 'boundary' in [−0.5, 0.5). Measured: boundary −0.495 … +0.495, samples
    // +0.005 … +0.995; within one pixel of the outline the mean error is +0.04 (boundary) and +0.54 (samples).
    expect(toBoundary.low).toBeGreaterThan(-0.5);
    expect(toBoundary.high).toBeLessThan(0.5);
    expect(toSamples.low).toBeGreaterThan(0);
    expect(toSamples.high).toBeGreaterThan(0.9);
    expect(Math.abs(toBoundary.nearBias)).toBeLessThan(0.1);
    expect(toSamples.nearBias).toBeGreaterThan(0.45);
  });

  it('a mask that is all inside gives +Infinity, an empty mask −Infinity; the image frame is not a boundary', () => {
    expect(Array.from(signedEdt2d(new Uint8Array(6).fill(1), 3, 2))).toEqual(Array(6).fill(Infinity));
    expect(Array.from(signedEdt2d(new Uint8Array(6), 3, 2))).toEqual(Array(6).fill(-Infinity));
    expect(Array.from(signedEdt3d(new Uint8Array(8).fill(1), [2, 2, 2], { measureTo: 'samples' }))).toEqual(Array(8).fill(Infinity));
    expect(Array.from(signedEdt1d([]))).toEqual([]);
    // Inside touches the left edge of the image: distances are measured to the outside pixels on the right only.
    expect(Array.from(signedEdt1d([1, 1, 1, 0]))).toEqual([3, 2, 1, -1]);
    // One inside pixel in the middle of 3×3.
    const d = Math.fround(-Math.SQRT2);
    expect(Array.from(signedEdt2d([0, 0, 0, 0, 1, 0, 0, 0, 0], 3, 3))).toEqual([d, -1, d, -1, 1, -1, d, -1, d]);
    const h = Math.fround(-(Math.SQRT2 - 0.5));
    expect(Array.from(signedEdt2d([0, 0, 0, 0, 1, 0, 0, 0, 0], 3, 3, { measureTo: 'boundary' }))).toEqual([h, -0.5, h, -0.5, 0.5, -0.5, h, -0.5, h]);
  });

  it('feeds marching cubes: a voxel ball becomes one closed surface of the right volume', () => {
    const n = 40;
    const mask = new Uint8Array(n * n * n);
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
      const [x, y, z] = coords(i, [n, n, n]);
      if (Math.hypot(x - 19.3, y - 20.1, z - 19.6) < 14.2) {
        mask[i] = 1;
        count++;
      }
    }
    const sd = signedEdt3d(mask, [n, n, n]);
    const m = marchingCubes(sd, [n, n, n]);
    expect(edgeStats(m.indices)).toMatchObject({ boundaryEdges: 0, nonManifoldEdges: 0, misorientedEdges: 0 });
    expect(eulerCharacteristic(m.indices)).toBe(2);
    expect(countComponents(m.indices)).toBe(1);
    // The surface runs halfway between inside and outside voxel centers: the volume is the voxel count
    // minus the corners cut off the staircase (measured: −0.24%; −0.27% against the analytic ball).
    expect(signedVolume(m) / count).toBeGreaterThan(0.995);
    expect(signedVolume(m) / count).toBeLessThan(1);
    expect(Math.abs(signedVolume(m) / ((4 / 3) * Math.PI * 14.2 ** 3) - 1)).toBeLessThan(0.005);
  });

  it('rejects malformed input', () => {
    expect(() => signedEdt2d(new Uint8Array(5), 2, 3)).toThrow(RangeError);
    expect(() => signedEdt2d(new Uint8Array(6), 2, 3, { spacing: 0 })).toThrow(RangeError);
    expect(() => signedEdt2d(new Uint8Array(6), 2, 3, { measureTo: 'middle' as never })).toThrow(RangeError);
    expect(() => signedEdt3d(new Uint8Array(8), [2, 2, 0] as never)).toThrow(RangeError);
    expect(() => signedEdt1d([1, 0], { spacing: Infinity })).toThrow(RangeError);
    expect(() => signedEdt1d([], { spacing: -2 })).toThrow(RangeError);
  });
});

// ---- narrow band → whole grid ----------------------------------------------------------------------------

describe('extendSignedDistance3d', HEAVY, () => {
  it('gives every unknown sample the smaller of: the distance to the nearest crossing, and ‖p − q‖ + |sdf[q]| for the known sample that wins the squared transform', () => {
    const rng = mulberry32(51);
    let checked = 0;
    let viaCrossing = 0;
    for (let trial = 0; trial < 80; trial++) {
      const dims = randomDims(rng, 3, 6) as [number, number, number];
      const n = total(dims);
      const spacing: [number, number, number] = trial % 2 === 0 ? [1, 1, 1] : [0.5 + rng(), 0.5 + rng(), 0.5 + rng()];
      const sdf = new Float64Array(n);
      const knownShare = 0.15 + 0.6 * rng();
      for (let i = 0; i < n; i++) {
        const side = rng() < 0.5 ? 1 : -1;
        sdf[i] = rng() < knownShare ? side * rng() * 2 : side * Infinity;
      }
      const before = Float64Array.from(sdf);
      expect(extendSignedDistance3d(sdf, dims, { spacing })).toBe(sdf);
      // Brute force. The crossings: on every lattice edge between two known samples of different sides, the
      // zero of the line through the two values.
      const crossings: [number, number, number][] = [];
      for (let p = 0; p < n; p++) {
        const a = before[p];
        if (!Number.isFinite(a)) continue;
        const at = coords(p, dims);
        for (let axis = 0; axis < 3; axis++) {
          if (at[axis] + 1 >= dims[axis]) continue;
          const b = before[p + (axis === 0 ? 1 : axis === 1 ? dims[0] : dims[0] * dims[1])];
          if (!Number.isFinite(b) || a >= 0 === b >= 0) continue;
          const point: [number, number, number] = [at[0] * spacing[0], at[1] * spacing[1], at[2] * spacing[2]];
          point[axis] += (a / (a - b)) * spacing[axis];
          crossings.push(point);
        }
      }
      let anyKnown = false;
      for (let q = 0; q < n; q++) if (Number.isFinite(before[q])) anyKnown = true;
      for (let p = 0; p < n; p++) {
        if (Number.isFinite(before[p])) {
          expect(sdf[p]).toBe(before[p]);
          continue;
        }
        const side = before[p] > 0 ? 1 : -1;
        if (!anyKnown) {
          expect(sdf[p]).toBe(before[p]);
          continue;
        }
        const at = coords(p, dims);
        let toCrossing = Infinity;
        for (const c of crossings) {
          toCrossing = Math.min(toCrossing, Math.hypot(at[0] * spacing[0] - c[0], at[1] * spacing[1] - c[1], at[2] * spacing[2] - c[2]));
        }
        // The smallest squared cost over ALL known samples, of either side…
        let best = Infinity;
        for (let q = 0; q < n; q++) {
          if (Number.isFinite(before[q])) best = Math.min(best, gap2(p, q, dims, spacing) + before[q] ** 2);
        }
        // …and the result for a sample that attains it (the kernel works in float32, so allow near-ties).
        let matches = false;
        for (let q = 0; q < n && !matches; q++) {
          if (!Number.isFinite(before[q])) continue;
          const cost = gap2(p, q, dims, spacing) + before[q] ** 2;
          if (cost > best * (1 + 1e-5) + 1e-9) continue;
          const value = side * Math.min(toCrossing, Math.sqrt(gap2(p, q, dims, spacing)) + Math.abs(before[q]));
          if (Math.abs(sdf[p] - value) <= 1e-6 * Math.max(1, Math.abs(value))) matches = true;
        }
        expect(matches).toBe(true);
        if (Math.abs(Math.abs(sdf[p]) - toCrossing) <= 1e-6 * Math.max(1, toCrossing)) viaCrossing++;
        checked++;
      }
    }
    // 1769 unknown samples; the crossing bound decides 1258 of them, the known-sample bound the other 511.
    expect(checked).toBe(1769);
    expect(viaCrossing).toBe(1258);
  });

  it('on a sphere with a ±2 voxel band the far field is within 0.13 voxel; the square root of the seeded transform is 1.9 voxels short', () => {
    const n = 64;
    const dims: [number, number, number] = [n, n, n];
    const exact = new Float32Array(n * n * n);
    for (let i = 0; i < exact.length; i++) {
      const [x, y, z] = coords(i, dims);
      exact[i] = 22.4 - Math.hypot(x - 31.3, y - 30.9, z - 31.6);
    }
    const band = Float32Array.from(exact, (d) => (Math.abs(d) <= 2 ? d : d > 0 ? Infinity : -Infinity));
    const sdf = extendSignedDistance3d(Float32Array.from(band), dims);
    // What a literal reading of §2.9.8 gives: the square root of the transform seeded with d², per side.
    const literal = new Float32Array(exact.length);
    for (const side of [1, -1]) {
      const seeds = Float32Array.from(band, (d) => (Number.isFinite(d) && side * d >= 0 ? d * d : Infinity));
      edtSquared3d(seeds, dims);
      for (let i = 0; i < seeds.length; i++) if (side * band[i] === Infinity) literal[i] = side * Math.sqrt(seeds[i]);
    }
    let low = 0;
    let high = 0;
    let sum = 0;
    let far = 0;
    let literalLow = 0;
    let wrong = 0;
    for (let i = 0; i < exact.length; i++) {
      if (Number.isFinite(band[i])) {
        if (sdf[i] !== band[i]) wrong++;
        continue;
      }
      if (sdf[i] > 0 !== exact[i] > 0) wrong++;
      // Error of the magnitude, in voxels.
      const err = Math.abs(sdf[i]) - Math.abs(exact[i]);
      low = Math.min(low, err);
      high = Math.max(high, err);
      sum += Math.abs(err);
      far++;
      literalLow = Math.min(literalLow, Math.abs(literal[i]) - Math.abs(exact[i]));
    }
    expect(wrong).toBe(0);
    expect(far).toBeGreaterThan(200000);
    // Measured: −0.006 … +0.127 voxel, mean 0.012; the literal form reaches −1.92 (mean 1.50). The small
    // negative error is the straight-line zero between two samples of a curved surface.
    expect(low).toBeGreaterThan(-0.02);
    expect(high).toBeLessThan(0.2);
    expect(sum / far).toBeLessThan(0.025);
    expect(literalLow).toBeLessThan(-1.5);
  });

  it('is within a tenth of a voxel on a plane, whatever its tilt, and within a voxel next to the sharp edges of a box', () => {
    const n = 48;
    const dims: [number, number, number] = [n, n, n];
    const worst = (f: (x: number, y: number, z: number) => number, counted: (i: number, d: number) => boolean): number => {
      const exact = new Float32Array(n * n * n);
      for (let i = 0; i < exact.length; i++) {
        const [x, y, z] = coords(i, dims);
        exact[i] = f(x, y, z);
      }
      const sdf = extendSignedDistance3d(
        Float32Array.from(exact, (d) => (Math.abs(d) <= 2 ? d : d > 0 ? Infinity : -Infinity)),
        dims,
      );
      let high = 0;
      for (let i = 0; i < exact.length; i++) {
        if (Math.abs(exact[i]) > 2 && counted(i, exact[i])) high = Math.max(high, Math.abs(Math.abs(sdf[i]) - Math.abs(exact[i])));
      }
      return high;
    };
    // Planes through the middle of the grid: only samples whose nearest plane point is inside the grid count
    // (beyond the grid the plane is not known).
    for (const tilt of [0, 0.013, 0.1, 0.4, 1]) {
      const length = Math.hypot(tilt, 1, 0.7 * tilt);
      const u = [tilt / length, 1 / length, (0.7 * tilt) / length];
      const plane = (x: number, y: number, z: number): number => -((x - 23.5) * u[0] + (y - 23.2) * u[1] + (z - 23.5) * u[2]);
      const footInside = (i: number, d: number): boolean => {
        const [x, y, z] = coords(i, dims);
        return [x + d * u[0], y + d * u[1], z + d * u[2]].every((c) => c >= 0 && c <= n - 1);
      };
      // Measured: 0 (tilt 0), 0.003, 0.036, 0.073, 0.096 voxel.
      expect(worst(plane, footInside)).toBeLessThan(0.15);
    }
    // A box: its convex edges and corners are not crossed by any lattice edge; the second bound covers them.
    const box = (x: number, y: number, z: number): number => {
      const q = [Math.abs(x - 23.3) - 13.2, Math.abs(y - 23.6) - 9.7, Math.abs(z - 23.1) - 16.4];
      return -(Math.hypot(Math.max(q[0], 0), Math.max(q[1], 0), Math.max(q[2], 0)) + Math.min(Math.max(q[0], q[1], q[2]), 0));
    };
    // Measured: 0.49 voxel.
    expect(worst(box, () => true)).toBeLessThan(0.75);
  });

  it('keeps known samples, uses a known sample of either side, and changes nothing without any', () => {
    // Nothing unknown: nothing changes.
    const known = Float32Array.of(1, 0.5, -0.5, -1, 1, 0.5, -0.5, -1);
    expect(extendSignedDistance3d(Float32Array.from(known), [4, 2, 1])).toEqual(known);
    // Nothing known: nothing changes.
    const blank = Float64Array.of(Infinity, Infinity, -Infinity, -Infinity);
    expect(Array.from(extendSignedDistance3d(Float64Array.from(blank), [4, 1, 1]))).toEqual(Array.from(blank));
    // Only an outside sample is known: no crossing, so every sample is bounded through it — also the inside
    // ones (the surface is 0.5 beyond it; 1 + 0.5 and 2 + 0.5 are upper bounds, not the distance).
    const lonely = extendSignedDistance3d(Float64Array.of(Infinity, Infinity, -0.5, -Infinity), [4, 1, 1]);
    expect(Array.from(lonely)).toEqual([2.5, 1.5, -0.5, -1.5]);
    // A known 0 lies on the surface: both sides measure from it.
    const zero = extendSignedDistance3d(Float64Array.of(Infinity, Infinity, 0, -Infinity, -Infinity), [5, 1, 1], { spacing: 0.5 });
    expect(Array.from(zero)).toEqual([1, 0.5, 0, -0.5, -1]);
    // A crossing between +0.25 and −0.75, a quarter of the way: both bounds agree along the line.
    const line = extendSignedDistance3d(Float64Array.of(Infinity, Infinity, 0.25, -0.75, -Infinity, -Infinity), [1, 6, 1]);
    expect(Array.from(line)).toEqual([2.25, 1.25, 0.25, -0.75, -1.75, -2.75]);
    // Off the line the crossing is nearer than any known sample plus its distance: 2×3, crossing at (0.5, 1).
    const grid = extendSignedDistance3d(Float64Array.of(Infinity, Infinity, 0.5, -0.5, -Infinity, -Infinity), [2, 3, 1]);
    expect(grid[0]).toBeCloseTo(Math.hypot(0.5, 1), 6);
    expect(grid[1]).toBeCloseTo(Math.hypot(0.5, 1), 6);
    expect(grid[4]).toBeCloseTo(-Math.hypot(0.5, 1), 6);
    expect(grid[5]).toBeCloseTo(-Math.hypot(0.5, 1), 6);
    // An absurdly large known value neither overflows the work array nor makes a NaN.
    const huge = extendSignedDistance3d(Float64Array.of(1e25, Infinity, -1, -Infinity), [4, 1, 1]);
    expect(Array.from(huge)).toEqual([1e25, 2, -1, -2]);
  });

  it('rejects NaN and malformed grids', () => {
    expect(() => extendSignedDistance3d(Float32Array.of(1, NaN), [2, 1, 1])).toThrow(RangeError);
    expect(() => extendSignedDistance3d(new Float32Array(7), [2, 2, 2])).toThrow(RangeError);
    expect(() => extendSignedDistance3d(new Float32Array(8), [2, 2, 2], { spacing: 0 })).toThrow(RangeError);
    expect(() => extendSignedDistance3d(new Float32Array(8), [2, 2, 2], { spacing: [1, -1, 1] })).toThrow(RangeError);
    expect(() => extendSignedDistance3d(new Float32Array(8), [2, 0, 4] as never)).toThrow(RangeError);
  });
});
