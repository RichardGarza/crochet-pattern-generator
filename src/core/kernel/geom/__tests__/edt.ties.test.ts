// edt.ts — `nearest` of the squared transforms on exact ties (§5.8 "ties → lowest index") at spacings other
// than 1. From the second review of Step 0b: the envelope crossing (g(q) − g(p)) / (2·spacing²·(q − p)) rounded
// below the midpoint at spacing 0.1, so seeds 1 and 7 sent sample 4 to seed 7; and in 3D the passes added
// spacing²-scaled terms in different orders, so seeds at the same distance along different axes (3, 4, 0 vs
// 0, 0, 5) came out one rounding apart (45 of 46 575 samples went to a higher index at spacing 0.0229).
import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../../prng';
import { edtSquared1d, edtSquared2d, edtSquared3d } from '../edt';

type Dims = [number, number, number];

describe('edtSquared nearest: exact ties go to the lowest index at any spacing (§5.8)', () => {
  it('1D, spacing 0.1, seeds 1 and 7, sample 4 (both 3 samples away)', () => {
    const spacing = 0.1;
    const values = new Float64Array(9).fill(Infinity);
    values[1] = 0;
    values[7] = 0;
    const nearest = new Int32Array(9);
    edtSquared1d(values, { spacing, nearest });
    expect(values[4]).toBe(spacing * spacing * 9);
    expect(nearest[4]).toBe(1); // was 7
    expect(nearest[3]).toBe(1);
    expect(nearest[5]).toBe(7);
  });

  it('3D, world spacing 0.0229 (a voxel in inches): two seeds along x, 23 samples either side', () => {
    const values = new Float64Array(61).fill(Infinity);
    values[0] = 0;
    values[46] = 0;
    const nearest = new Int32Array(61);
    edtSquared3d(values, [61, 1, 1], { spacing: 0.0229, nearest });
    // spacing² × an exact integer (the transform works in units of spacing²).
    expect(values[23]).toBe(0.0229 * 0.0229 * 529);
    expect(nearest[23]).toBe(0); // was 46
  });

  it('3D, seeds at offsets (3, 4, 0) and (0, 0, 5) from a sample, at spacings that round', () => {
    for (const spacing of [0.1, 0.3, 0.7, 0.0229, 1.1]) {
      const dims: Dims = [8, 8, 8];
      const at = (x: number, y: number, z: number): number => x + 8 * (y + 8 * z);
      // Sample (1, 1, 6); seed A at (4, 5, 6) (index 364), seed B at (1, 1, 1) (index 73): both 5 away.
      const values = new Float64Array(512).fill(Infinity);
      values[at(4, 5, 6)] = 0;
      values[at(1, 1, 1)] = 0;
      const nearest = new Int32Array(512);
      edtSquared3d(values, dims, { spacing, nearest });
      expect(values[at(1, 1, 6)]).toBe(spacing * spacing * 25);
      expect(nearest[at(1, 1, 6)]).toBe(at(1, 1, 1));
    }
  });

  it('random grids, plain seeds at isotropic spacings and whole-number costs at spacing 1, Float64 and Float32: the lowest index of the true minimizers, bit-identical values', () => {
    const rng = mulberry32(0xe17e);
    let ties = 0;
    let samples = 0;
    for (const spacing of [1, 0.1, 0.3, 0.7, 0.0229, 1.1, 0.0625, 3.7]) {
      const w2 = spacing * spacing;
      for (let trial = 0; trial < 60; trial++) {
        const shape = trial % 3;
        const dims: Dims =
          shape === 0
            ? [1 + Math.floor(rng() * 40), 1, 1]
            : shape === 1
              ? [1 + Math.floor(rng() * 14), 1 + Math.floor(rng() * 14), 1]
              : [1 + Math.floor(rng() * 9), 1 + Math.floor(rng() * 9), 1 + Math.floor(rng() * 7)];
        const n = dims[0] * dims[1] * dims[2];
        const density = 0.03 + rng() * 0.3;
        // Plain seeds at every spacing; small whole-number costs at spacing 1. (At other spacings a cost
        // c = u·spacing² is divided back by spacing², which need not give u exactly: true ties of such costs
        // can come out one rounding apart, as documented.)
        const withCosts = spacing === 1 && trial % 2 === 1;
        const units = Float64Array.from({ length: n }, () => (rng() < density ? (withCosts ? Math.floor(rng() * 5) : 0) : Infinity));
        for (const single of [false, true]) {
          const values = single ? Float32Array.from(units, (u) => u * w2) : Float64Array.from(units, (u) => u * w2);
          const nearest = new Int32Array(n);
          if (shape === 0) edtSquared1d(values, { spacing, nearest });
          else if (shape === 1) edtSquared2d(values, dims[0], dims[1], { spacing, nearest });
          else edtSquared3d(values, dims, { spacing, nearest });
          for (let p = 0; p < n; p++) {
            const px = p % dims[0];
            const py = Math.floor(p / dims[0]) % dims[1];
            const pz = Math.floor(p / (dims[0] * dims[1]));
            let best = Infinity;
            let arg = -1;
            let count = 0;
            for (let q = 0; q < n; q++) {
              if (!(units[q] < Infinity)) continue;
              const dx = px - (q % dims[0]);
              const dy = py - (Math.floor(q / dims[0]) % dims[1]);
              const dz = pz - Math.floor(q / (dims[0] * dims[1]));
              const cost = dx * dx + dy * dy + dz * dz + units[q];
              if (cost < best) {
                best = cost;
                arg = q;
                count = 1;
              } else if (cost === best) count++;
            }
            samples++;
            if (count > 1) ties++;
            expect(nearest[p]).toBe(arg);
            const expected = best === Infinity ? Infinity : single ? Math.fround(Math.fround(best) * w2) : best * w2;
            expect(values[p]).toBe(expected);
          }
        }
      }
    }
    expect(samples).toBeGreaterThan(50000);
    expect(ties).toBeGreaterThan(5000);
  });
});
