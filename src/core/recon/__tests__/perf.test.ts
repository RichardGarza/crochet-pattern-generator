// Timing tests for T3.1 (DESIGN.md §6.1 rule 5: generous bounds, best of three, retried twice). Measured on an
// Apple M3 Pro, quiet: a 512 × 384 mask ≈ 40 ms, a 12-megapixel photo → mask ≈ 170 ms, the three-view consistency
// check at N = 128 ≈ 40 ms (plus ≈ 60 ms of plane tables).
import { describe, expect, it } from 'vitest';
import { addNoise, fromFn } from '../../../test/rgba';
import { alignViews, viewConsistency } from '../align';
import { classicalMask } from '../masks';
import { renderSilhouette, sphere } from './helpers/views';

const TIMING = { timeout: 120_000, retry: 2 };

function best(n: number, fn: () => void): number {
  let min = Infinity;
  for (let k = 0; k < n; k++) {
    const t0 = performance.now();
    fn();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

describe('T3.1 timings', TIMING, () => {
  it('a 512 × 384 classical mask in < 400 ms', () => {
    const img = addNoise(fromFn(512, 384, (x, y) => (((x - 256) / 120) ** 2 + ((y - 200) / 150) ** 2 <= 1 ? '#8e44ad' : '#d9d4c7')), 6, 1);
    expect(best(3, () => classicalMask(img))).toBeLessThan(400);
  });

  it('a 12-megapixel photo to a mask in < 2 s', () => {
    const img = fromFn(4032, 3024, (x, y) => (((x - 2016) / 900) ** 2 + ((y - 1600) / 1100) ** 2 <= 1 ? '#8e44ad' : '#d9d4c7'));
    expect(best(2, () => classicalMask(img))).toBeLessThan(2000);
  });

  it('alignment + consistency of three 512² views at N = 128 in < 1 s', () => {
    const s = [sphere(0.5)];
    const views = (['front', 'left', 'top'] as const).map((label, k) => ({
      id: label,
      label,
      mask: renderSilhouette(s, label, { w: 512, h: 512, pxPerUnit: 380 + 20 * k }),
      w: 512,
      h: 512,
    }));
    expect(best(3, () => viewConsistency(alignViews(views), 128))).toBeLessThan(1000);
  });
});
