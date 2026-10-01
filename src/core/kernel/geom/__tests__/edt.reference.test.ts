// edt.ts — the generalized squared transforms and the plain mask transforms — against a brute force that
// shares no code with the kernel or with edt.test.ts. From the independent review of Step 0b.
import { describe, expect, it } from 'vitest';
import { mulberry32, type Rng } from '../../prng';
import { edt1d, edt2d, edt3d, edtSquared1d, edtSquared2d, edtSquared3d } from '../edt';
import { note } from './fields';

type Dims = [number, number, number];

interface Brute {
  /** min over q of ‖(p − q)·spacing‖² + seeds[q] */
  d: Float64Array;
  /** The LOWEST index q that attains the minimum (−1 where there is no seed). */
  arg: Int32Array;
  /** Largest sum of absolute terms seen for the winner (the scale of the rounding error). */
  scale: Float64Array;
}

/** All pairs. A seed is any entry that is `< Infinity` (so NaN and +Infinity are "no seed"). */
function brute(seeds: ArrayLike<number>, dims: Dims, sp: Dims): Brute {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const d = new Float64Array(n).fill(Infinity);
  const arg = new Int32Array(n).fill(-1);
  const scale = new Float64Array(n);
  const qs: number[] = [];
  for (let q = 0; q < n; q++) if (seeds[q] < Infinity) qs.push(q);
  for (let pz = 0, p = 0; pz < nz; pz++) {
    for (let py = 0; py < ny; py++) {
      for (let px = 0; px < nx; px++, p++) {
        let best = Infinity;
        let bestQ = -1;
        let bestScale = 0;
        for (const q of qs) {
          const qx = q % nx;
          const qy = ((q - qx) / nx) % ny;
          const qz = (q - qx - nx * qy) / (nx * ny);
          const ax = (px - qx) * sp[0];
          const ay = (py - qy) * sp[1];
          const az = (pz - qz) * sp[2];
          const gap = ax * ax + ay * ay + az * az;
          const c = gap + seeds[q];
          if (c < best || bestQ < 0) {
            best = c;
            bestQ = q;
            bestScale = gap + Math.abs(seeds[q]);
          }
        }
        d[p] = best;
        arg[p] = bestQ;
        scale[p] = bestScale;
      }
    }
  }
  return { d, arg, scale };
}

function cost(p: number, q: number, seeds: ArrayLike<number>, dims: Dims, sp: Dims): number {
  const [nx, ny] = dims;
  const px = p % nx;
  const py = ((p - px) / nx) % ny;
  const pz = (p - px - nx * py) / (nx * ny);
  const qx = q % nx;
  const qy = ((q - qx) / nx) % ny;
  const qz = (q - qx - nx * qy) / (nx * ny);
  const ax = (px - qx) * sp[0];
  const ay = (py - qy) * sp[1];
  const az = (pz - qz) * sp[2];
  return ax * ax + ay * ay + az * az + seeds[q];
}

const SIZES = [1, 1, 2, 3, 4, 5, 7, 9, 13, 17, 33, 64, 150];

/** Random dims with 1-wide axes and long thin grids, at most `cap` samples. */
function randomDims(rng: Rng, cap: number): Dims {
  for (;;) {
    const d: Dims = [SIZES[Math.floor(rng() * SIZES.length)], SIZES[Math.floor(rng() * SIZES.length)], SIZES[Math.floor(rng() * SIZES.length)]];
    if (d[0] * d[1] * d[2] <= cap) return d;
  }
}

/** Which samples are seeds: one seed, one hole, all, none, sparse, dense. */
function randomSeedSet(rng: Rng, n: number): Uint8Array {
  const kind = Math.floor(rng() * 7);
  const set = new Uint8Array(n);
  if (kind === 0) set[Math.floor(rng() * n)] = 1;
  else if (kind === 1) {
    set.fill(1);
    set[Math.floor(rng() * n)] = 0;
  } else if (kind === 2) set.fill(1);
  else if (kind === 3) {
    /* none */
  } else {
    const density = kind === 4 ? 0.02 : kind === 5 ? 0.3 : 0.9;
    for (let i = 0; i < n; i++) set[i] = rng() < density ? 1 : 0;
  }
  return set;
}

function run(values: Float64Array | Float32Array, dims: Dims, sp: Dims | undefined, nearest?: Int32Array): void {
  edtSquared3d(values, dims, { spacing: sp, nearest });
}

describe('edtSquared*: integer costs at unit spacing', () => {
  it('3D (incl. 1-wide axes): bit-exact values, and `nearest` is the LOWEST index among the minimizers (§5.8 ties → lowest index)', () => {
    const rng = mulberry32(0xb001);
    let samples = 0;
    let notLowest = 0;
    for (let trial = 0; trial < 220; trial++) {
      const dims = randomDims(rng, 1400);
      const n = dims[0] * dims[1] * dims[2];
      const set = randomSeedSet(rng, n);
      // Small ranges make many exact ties; negative integers are allowed costs.
      const range = [1, 2, 5, 40, 100000][Math.floor(rng() * 5)];
      const offset = rng() < 0.3 ? -Math.floor(range / 2) : 0;
      const seeds = Float64Array.from({ length: n }, (_, i) => (set[i] ? offset + Math.floor(rng() * range) : Infinity));
      const expected = brute(seeds, dims, [1, 1, 1]);
      const v64 = Float64Array.from(seeds);
      const nearest = new Int32Array(n).fill(-7);
      run(v64, dims, undefined, nearest);
      expect(v64).toEqual(expected.d);
      for (let p = 0; p < n; p++) if (nearest[p] !== expected.arg[p]) notLowest++;
      // Float32 storage holds the same integers.
      const v32 = Float32Array.from(seeds);
      const nearest32 = new Int32Array(n).fill(-7);
      run(v32, dims, undefined, nearest32);
      expect(v32).toEqual(Float32Array.from(expected.d));
      expect(nearest32).toEqual(nearest);
      samples += n;
    }
    expect(samples).toBeGreaterThan(50000);
    expect(notLowest).toBe(0);
  });

  it('1D and 2D entry points agree with the 3D one on the same data, and with every axis order', () => {
    const rng = mulberry32(0xb002);
    for (let trial = 0; trial < 80; trial++) {
      const w = 1 + Math.floor(rng() * 14);
      const h = 1 + Math.floor(rng() * 14);
      const n = w * h;
      const set = randomSeedSet(rng, n);
      const seeds = Float64Array.from({ length: n }, (_, i) => (set[i] ? Math.floor(rng() * 9) : Infinity));
      const a = Float64Array.from(seeds);
      const na = new Int32Array(n);
      edtSquared2d(a, w, h, { nearest: na });
      // Same grid as [w, h, 1], [w, 1, h] and [1, w, h]: a 1-wide axis must be a no-op wherever it sits.
      for (const dims of [
        [w, h, 1],
        [w, 1, h],
        [1, w, h],
      ] as Dims[]) {
        const b = Float64Array.from(seeds);
        const nb = new Int32Array(n);
        edtSquared3d(b, dims, { nearest: nb });
        expect(b).toEqual(a);
        expect(nb).toEqual(na);
      }
      // Transposed grid: transform the transpose, transpose back. Values are identical (ties may differ).
      const t = new Float64Array(n);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) t[y + h * x] = seeds[x + w * y];
      edtSquared2d(t, h, w);
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) expect(t[y + h * x]).toBe(a[x + w * y]);
      // 1D: every row of a [w, 1] grid.
      const line = Float64Array.from(seeds.subarray(0, w));
      const viaLine = edtSquared1d(Float64Array.from(line));
      const via2d = edtSquared2d(Float64Array.from(line), w, 1);
      expect(viaLine).toEqual(via2d);
    }
  });

  it('`nearest` is −1 exactly where the result is +Infinity, also when only some lines have no seed', () => {
    const rng = mulberry32(0xb003);
    for (let trial = 0; trial < 120; trial++) {
      const dims = randomDims(rng, 900);
      const n = dims[0] * dims[1] * dims[2];
      const seeds = new Float64Array(n).fill(Infinity);
      // NaN is "no seed" too; sprinkle it, and put at most a few seeds.
      for (let i = 0; i < n; i++) if (rng() < 0.2) seeds[i] = NaN;
      const count = Math.floor(rng() * 3);
      for (let k = 0; k < count; k++) seeds[Math.floor(rng() * n)] = Math.floor(rng() * 5);
      const expected = brute(seeds, dims, [1, 1, 1]);
      const v = Float64Array.from(seeds);
      const nearest = new Int32Array(n).fill(12345);
      run(v, dims, undefined, nearest);
      expect(v).toEqual(expected.d);
      expect(nearest).toEqual(expected.arg);
      for (let p = 0; p < n; p++) expect(nearest[p] === -1).toBe(v[p] === Infinity);
    }
  });
});

describe('edtSquared*: real costs, extreme costs, extreme spacings', () => {
  it('real, negative, huge and tiny costs with per-axis spacing 1e-3 … 1e3: values agree to rounding and `nearest` attains them (Float64)', () => {
    const rng = mulberry32(0xb004);
    let worst = 0;
    let worstNearest = 0;
    let samples = 0;
    for (let trial = 0; trial < 260; trial++) {
      const dims = randomDims(rng, 1200);
      const n = dims[0] * dims[1] * dims[2];
      const set = randomSeedSet(rng, n);
      const sp: Dims =
        trial % 4 === 0 ? [1, 1, 1] : [10 ** (-3 + 6 * rng()), 10 ** (-3 + 6 * rng()), 10 ** (-3 + 6 * rng())];
      const kind = trial % 6;
      const seeds = Float64Array.from({ length: n }, (_, i) => {
        if (!set[i]) return rng() < 0.1 ? NaN : Infinity;
        const r = rng();
        if (kind === 0) return r * 30;
        if (kind === 1) return (r - 0.5) * 2e6; // negative and positive
        if (kind === 2) return rng() < 0.5 ? 1e20 * (1 + r) : r; // "practically no seed" next to real seeds
        if (kind === 3) return rng() < 0.5 ? 1e300 * r : -1e300 * r;
        if (kind === 4) return rng() < 0.5 ? 5e-324 * Math.floor(r * 10) : r * 1e-300; // denormals and tiny
        return Math.floor(r * 4) * 0.25; // many exact ties
      });
      const expected = brute(seeds, dims, sp);
      const v = Float64Array.from(seeds);
      const nearest = new Int32Array(n).fill(-7);
      run(v, dims, sp, nearest);
      for (let p = 0; p < n; p++) {
        samples++;
        if (expected.arg[p] < 0) {
          expect(v[p]).toBe(Infinity);
          expect(nearest[p]).toBe(-1);
          continue;
        }
        expect(Number.isNaN(v[p])).toBe(false);
        const tol = Math.max(expected.scale[p], Number.MIN_VALUE);
        if (expected.d[p] === Infinity) {
          // The exact answer overflowed in the brute force; the kernel may only give a huge value or +Infinity.
          expect(v[p]).toBeGreaterThan(1e307);
          continue;
        }
        worst = Math.max(worst, Math.abs(v[p] - expected.d[p]) / tol);
        const q = nearest[p];
        expect(q >= 0 && q < n && seeds[q] < Infinity).toBe(true);
        worstNearest = Math.max(worstNearest, Math.abs(cost(p, q, seeds, dims, sp) - expected.d[p]) / tol);
      }
    }
    expect(samples).toBeGreaterThan(50000);
    // Relative to the size of the terms that were added (a sum of a huge positive and a huge negative term
    // cannot be better than that).
    note(`edtSquared real/extreme: worst value error ${worst.toExponential(2)}, worst nearest error ${worstNearest.toExponential(2)} (relative to the terms)`);
    expect(worst).toBeLessThan(1e-12);
    expect(worstNearest).toBeLessThan(1e-12);
  });

  it('Float32 storage with real costs and per-axis spacing agrees to float32 rounding', () => {
    const rng = mulberry32(0xb005);
    let worst = 0;
    for (let trial = 0; trial < 150; trial++) {
      const dims = randomDims(rng, 1200);
      const n = dims[0] * dims[1] * dims[2];
      const set = randomSeedSet(rng, n);
      const sp: Dims = [0.05 + 3 * rng(), 0.05 + 3 * rng(), 0.05 + 3 * rng()];
      const seeds = Float32Array.from({ length: n }, (_, i) => (set[i] ? rng() * 30 : Infinity));
      const expected = brute(seeds, dims, sp);
      const v = Float32Array.from(seeds);
      const nearest = new Int32Array(n);
      run(v, dims, sp, nearest);
      for (let p = 0; p < n; p++) {
        if (expected.arg[p] < 0) {
          expect(v[p]).toBe(Infinity);
          expect(nearest[p]).toBe(-1);
          continue;
        }
        worst = Math.max(worst, Math.abs(v[p] - expected.d[p]) / Math.max(1e-30, expected.d[p]));
        // `nearest` attains the minimum up to the float32 rounding of the intermediate passes.
        expect(Math.abs(cost(p, nearest[p], seeds, dims, sp) - expected.d[p])).toBeLessThanOrEqual(4e-7 * expected.d[p] + 1e-30);
      }
    }
    note(`edtSquared Float32 real: worst relative error ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(4e-7);
  });

  it('long lines: a single seed at either end, equal costs everywhere, costs that hide all neighbors', () => {
    const n = 4096;
    for (const at of [0, n - 1]) {
      const v = new Float64Array(n).fill(Infinity);
      v[at] = 3;
      const nearest = new Int32Array(n);
      edtSquared1d(v, { nearest });
      for (let i = 0; i < n; i++) {
        expect(v[i]).toBe((i - at) ** 2 + 3);
        expect(nearest[i]).toBe(at);
      }
    }
    // Equal costs: every sample is its own winner.
    const flat = new Float64Array(n).fill(2.5);
    const who = new Int32Array(n);
    edtSquared1d(flat, { nearest: who });
    for (let i = 0; i < n; i++) {
      expect(flat[i]).toBe(2.5);
      expect(who[i]).toBe(i);
    }
    // A steep ramp f[i] = −i²: D(p) = min_q (p − q)² − q² = p² − 2pq, so the last sample wins everywhere
    // except at p = 0, where every q ties at 0 and the lowest index must win.
    const ramp = Float64Array.from({ length: 300 }, (_, i) => -(i * i));
    const rampWho = new Int32Array(300);
    edtSquared1d(ramp, { nearest: rampWho });
    for (let p = 0; p < 300; p++) {
      expect(ramp[p]).toBe((p - 299) ** 2 - 299 * 299);
      expect(rampWho[p]).toBe(p === 0 ? 0 : 299);
    }
    // A convex bowl f[i] = (i − c)²·4: three parabolas meet in single points; the result is exact.
    const bowl = Float64Array.from({ length: 200 }, (_, i) => 4 * (i - 77) ** 2);
    const expected = brute(bowl, [200, 1, 1], [1, 1, 1]);
    const bowlWho = new Int32Array(200);
    edtSquared1d(bowl, { nearest: bowlWho });
    expect(bowl).toEqual(expected.d);
    expect(bowlWho).toEqual(expected.arg);
  });

  it('writes only inside the given view, and the result does not depend on where the view sits in its buffer', () => {
    const rng = mulberry32(0xb006);
    const dims: Dims = [7, 5, 4];
    const n = 140;
    const seeds = Float32Array.from({ length: n }, () => (rng() < 0.2 ? rng() * 9 : Infinity));
    const plain = edtSquared3d(Float32Array.from(seeds), dims);
    const big = new Float32Array(n + 20).fill(-123);
    big.set(seeds, 9);
    const view = big.subarray(9, 9 + n);
    const nearestBig = new Int32Array(n + 6).fill(-99);
    const nearestView = nearestBig.subarray(3, 3 + n);
    expect(edtSquared3d(view, dims, { nearest: nearestView })).toBe(view);
    expect(Array.from(view)).toEqual(Array.from(plain));
    for (let i = 0; i < 9; i++) expect(big[i]).toBe(-123);
    for (let i = 9 + n; i < big.length; i++) expect(big[i]).toBe(-123);
    for (const i of [0, 1, 2, n + 3, n + 4, n + 5]) expect(nearestBig[i]).toBe(-99);
  });

  it('a −Infinity cost throws before anything is written', () => {
    // (The review found the first row already rewritten when the second row was found to be invalid.)
    const v = Float64Array.of(Infinity, 0, Infinity, Infinity, -Infinity, Infinity);
    const nearest = new Int32Array(6).fill(-7);
    expect(() => edtSquared2d(v, 3, 2, { nearest })).toThrow(RangeError);
    expect(Array.from(v)).toEqual([Infinity, 0, Infinity, Infinity, -Infinity, Infinity]);
    expect(Array.from(nearest)).toEqual(Array(6).fill(-7));
    const w = Float32Array.of(0, 1, 2, 3, 4, 5, 6, -Infinity);
    expect(() => edtSquared3d(w, [2, 2, 2])).toThrow(RangeError);
    expect(Array.from(w)).toEqual([0, 1, 2, 3, 4, 5, 6, -Infinity]);
  });
});

describe('edtSquared*: spacing whose square leaves the float64 range', () => {
  it('is refused: a spacing must lie in 1e-100 … 1e100', () => {
    // (The review found 1e160 accepted and answered with NaN — spacing² overflows, and Infinity·0·0 is NaN at
    // the seed itself — and 1e-170 accepted and answered with wrong values: spacing² underflows to 0, the
    // crossing of two equal costs is 0/0, and [1, 1, 0] came back unchanged instead of [0, 0, 0].)
    for (const spacing of [1e160, 1e101, 1e-170, 1e-101, 5e-324, Number.MAX_VALUE]) {
      expect(() => edtSquared1d(Float64Array.of(0, Infinity, Infinity), { spacing })).toThrow(RangeError);
      expect(() => edtSquared2d(new Float64Array(4), 2, 2, { spacing: [1, spacing] })).toThrow(RangeError);
      expect(() => edtSquared3d(new Float64Array(8), [2, 2, 2], { spacing: [spacing, 1, 1] })).toThrow(RangeError);
      expect(() => edt1d([1, 0], { spacing })).toThrow(RangeError);
      expect(() => edt3d(new Uint8Array(8), [2, 2, 2], { spacing: [1, 1, spacing] })).toThrow(RangeError);
    }
  });

  it('at the ends of that range the transform is still right', () => {
    const rng = mulberry32(0xb007);
    for (const spacing of [1e-100, 1e100, 3e-37, 7e41]) {
      for (let trial = 0; trial < 100; trial++) {
        const n = 1 + Math.floor(rng() * 12);
        // Costs in units of spacing², so that distance and cost terms compete.
        const units = Float64Array.from({ length: n }, () => (rng() < 0.6 ? Math.floor(rng() * 9) : Infinity));
        const v = edtSquared1d(
          Float64Array.from(units, (u) => u * spacing * spacing),
          { spacing },
        );
        for (let p = 0; p < n; p++) {
          let best = Infinity;
          for (let q = 0; q < n; q++) best = Math.min(best, (p - q) ** 2 + units[q]);
          if (best === Infinity) expect(v[p]).toBe(Infinity);
          else expect(Math.abs(v[p] / (spacing * spacing) - best)).toBeLessThan(1e-9 * Math.max(1, best));
        }
      }
    }
  });
});
describe('edt1d/2d/3d of a mask', () => {
  it('unit and isotropic spacing: fround(spacing·√integer), for every density and for 1-wide and long thin grids', () => {
    const rng = mulberry32(0xb008);
    let samples = 0;
    for (let trial = 0; trial < 220; trial++) {
      const dims = randomDims(rng, 1400);
      const n = dims[0] * dims[1] * dims[2];
      const set = randomSeedSet(rng, n);
      // Any non-zero value is a feature.
      const mask = Float64Array.from(set, (s) => (s ? [1, 255, -1, 0.001, NaN][Math.floor(rng() * 5)] : 0));
      const before = Float64Array.from(mask);
      const seeds = Float64Array.from(set, (s) => (s ? 0 : Infinity));
      const exact = brute(seeds, dims, [1, 1, 1]).d;
      const spacing = [1, 0.37, 1 / 3, 1e-3, 1e3, 0.0173][trial % 6];
      const want = Float32Array.from(exact, (d2) => spacing * Math.sqrt(d2));
      expect(edt3d(mask, dims, { spacing })).toEqual(want);
      expect(edt3d(mask, dims, { spacing: [spacing, spacing, spacing] })).toEqual(want);
      if (dims[2] === 1) expect(edt2d(mask, dims[0], dims[1], { spacing })).toEqual(want);
      if (dims[2] === 1 && dims[1] === 1) expect(edt1d(mask, { spacing })).toEqual(want);
      // The mask is never modified (NaN stays NaN: compare bit patterns through Object.is).
      for (let i = 0; i < n; i++) expect(Object.is(mask[i], before[i])).toBe(true);
      samples += n;
    }
    expect(samples).toBeGreaterThan(50000);
  });

  it('per-axis spacing 1e-3 … 1e3: within float32 rounding of the exact distance', () => {
    const rng = mulberry32(0xb009);
    let worst = 0;
    for (let trial = 0; trial < 160; trial++) {
      const dims = randomDims(rng, 1200);
      const n = dims[0] * dims[1] * dims[2];
      const set = randomSeedSet(rng, n);
      const sp: Dims = [10 ** (-3 + 6 * rng()), 10 ** (-3 + 6 * rng()), 10 ** (-3 + 6 * rng())];
      const seeds = Float64Array.from(set, (s) => (s ? 0 : Infinity));
      const exact = brute(seeds, dims, sp).d;
      const got = edt3d(set, dims, { spacing: sp });
      for (let i = 0; i < n; i++) {
        const want = Math.sqrt(exact[i]);
        if (want === Infinity || want === 0) expect(got[i]).toBe(want);
        else worst = Math.max(worst, Math.abs(got[i] - want) / want);
      }
    }
    note(`edt3d anisotropic: worst relative error ${worst.toExponential(2)}`);
    expect(worst).toBeLessThan(1e-7);
  });
});
