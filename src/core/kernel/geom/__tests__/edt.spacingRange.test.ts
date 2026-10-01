// edt.ts — the ends of the accepted spacing range, 1e-15 … 1e15, for the transforms whose results or work
// arrays are float32. From the second review of Step 0b, which found the range then accepted (1e-100 … 1e100)
// too wide for them: signedEdt1d at 1e-50 came out all 0 (sign lost), edt1d at 1e50 +Infinity ("no feature"),
// and extendSignedDistance3d left 11 296 samples ±0 at 1e-30 and 7 506 samples ±Infinity or a voxel off at 1e20.
import { describe, expect, it } from 'vitest';
import { edt1d, edtSquared1d, extendSignedDistance3d, signedEdt1d, signedEdt3d } from '../edt';

/** A sphere of radius 7 voxels on a 24³ grid, known within ±2 voxels, unknown (±Infinity) elsewhere. */
function band(h: number): { sdf: Float64Array; exact: Float64Array } {
  const n = 24;
  const sdf = new Float64Array(n * n * n);
  const exact = new Float64Array(n * n * n);
  let i = 0;
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++, i++) {
        const d = (7 - Math.hypot(x - 11.5, y - 11.3, z - 11.7)) * h;
        exact[i] = d;
        sdf[i] = Math.abs(d) <= 2 * h ? d : d > 0 ? Infinity : -Infinity;
      }
    }
  }
  return { sdf, exact };
}

describe('the float32 transforms at the ends of the spacing range', () => {
  it.each([1e-15, 0.0229, 1e15])('extendSignedDistance3d at spacing %s: every unknown sample finite, non-zero, with its sign, within 0.2 voxel', (h) => {
    const { sdf, exact } = band(h);
    const before = sdf.slice();
    extendSignedDistance3d(sdf, [24, 24, 24], { spacing: h });
    let bad = 0;
    let worst = 0;
    for (let i = 0; i < sdf.length; i++) {
      if (Number.isFinite(before[i])) continue;
      if (!(Number.isFinite(sdf[i]) && sdf[i] !== 0 && sdf[i] > 0 === before[i] > 0)) bad++;
      worst = Math.max(worst, Math.abs(sdf[i] - exact[i]) / h);
    }
    expect(bad).toBe(0);
    // The same numbers at every spacing (the method is scale-free).
    expect(worst).toBeLessThan(0.2);
  });

  it('signedEdt at 1e-15 is never 0 and keeps every sign; edt at 1e15 stays finite', () => {
    const sd = signedEdt1d([0, 0, 1, 1, 0], { spacing: 1e-15 });
    expect(Array.from(sd)).toEqual([-2e-15, -1e-15, 1e-15, 1e-15, -1e-15].map(Math.fround));
    const sd3 = signedEdt3d(Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0), [2, 2, 2], { spacing: 1e-15, measureTo: 'boundary' });
    expect(Array.from(sd3).every((v) => v !== 0 && Number.isFinite(v))).toBe(true);
    expect(sd3[0]).toBeGreaterThan(0);
    expect(Array.from(edt1d([1, 0, 0], { spacing: 1e15 }))).toEqual([0, 1e15, 2e15].map(Math.fround));
  });

  it('beyond the range every transform refuses the spacing', () => {
    for (const spacing of [1e-50, 1e-30, 9e-16, 2e15, 1e20, 1e50]) {
      expect(() => signedEdt1d([0, 1], { spacing })).toThrow(RangeError);
      expect(() => edt1d([0, 1], { spacing })).toThrow(RangeError);
      expect(() => extendSignedDistance3d(Float64Array.of(1, -Infinity), [2, 1, 1], { spacing })).toThrow(RangeError);
      expect(() => extendSignedDistance3d(Float64Array.of(1, -Infinity), [2, 1, 1], { spacing: [1, 1, spacing] })).toThrow(RangeError);
    }
  });

  it('edtSquared at 1e-15 with costs whose difference over spacing² leaves the double range', () => {
    // The envelope crossing is −Infinity: the new parabola hides every earlier one. (Before the guard the
    // envelope stepped below its first entry, read v[−1] and stored a NaN crossing that happened never to be
    // read; the result was right by luck.)
    const nearest = new Int32Array(3);
    const v = edtSquared1d(Float64Array.of(1e300, Infinity, -1e300), { spacing: 1e-15, nearest });
    expect(Array.from(v)).toEqual([-1e300, -1e300, -1e300]);
    expect(Array.from(nearest)).toEqual([2, 2, 2]);
  });
});
