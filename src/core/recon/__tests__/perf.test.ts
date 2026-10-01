// Timing tests for T3.1 (DESIGN.md §6.1 rule 5: generous bounds, best of three, retried twice). Measured on an
// Apple M3 Pro, quiet: a 512 × 384 mask ≈ 40 ms, a 12-megapixel photo → mask ≈ 170 ms, the three-view consistency
// check at N = 128 ≈ 40 ms (plus ≈ 60 ms of plane tables).
import { describe, expect, it } from 'vitest';
import { addNoise, fromFn } from '../../../test/rgba';
import { alignViews, viewConsistency } from '../align';
import { buildRecon } from '../build';
import { localThickness } from '../inflate';
import { classicalMask } from '../masks';
import { request } from './helpers/requests';
import { centered, renderSilhouette, sphere, TEDDY } from './helpers/views';

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

async function bestAsync(n: number, fn: () => Promise<unknown>): Promise<number> {
  let min = Infinity;
  for (let k = 0; k < n; k++) {
    const t0 = performance.now();
    await fn();
    min = Math.min(min, performance.now() - t0);
  }
  return min;
}

// §5.8: 3D build N = 128 (geometry) < 0.8 s. Measured (Apple M3 Pro, Node 22, seven other agents' suites running):
// teddy, four 512² views, ≈ 0.5 s; the single-photo build ≈ 0.25 s; N = 64 ≈ 0.35 s / 0.13 s.
describe('T3.2 timings', TIMING, () => {
  it('3D build N = 128 from four 512² views in < 0.8 s (§5.8)', async () => {
    const req = request(centered(TEDDY), ['front', 'left', 'top', 'back'], { N: 128 });
    expect(await bestAsync(3, () => buildRecon(req))).toBeLessThan(800);
  });

  it('single-photo build N = 128 in < 0.8 s', async () => {
    const req = request(centered(TEDDY), ['left'], { N: 128, photoView: 'left' });
    expect(await bestAsync(3, () => buildRecon(req))).toBeLessThan(800);
  });

  it('3D build N = 128 from three full-frame 512² masks in < 0.8 s (T at grid resolution)', async () => {
    const full = new Uint8Array(512 * 512).fill(1);
    const req = request([], (['front', 'left', 'top'] as const).map((label) => ({ label, mask: full })), { N: 128 });
    expect(await bestAsync(3, () => buildRecon(req))).toBeLessThan(800);
  });

  it('the longest stretch between two gate checks at N = 128 stays under 150 ms (§5.8 ≈ 50 ms on a quiet machine)', async () => {
    const req = request(centered(TEDDY), ['front', 'left', 'top', 'back'], { N: 128 });
    let worst = Infinity;
    for (let k = 0; k < 2; k++) {
      let last = performance.now();
      let gap = 0;
      const gate = {
        check: async () => {
          const now = performance.now();
          gap = Math.max(gap, now - last);
          last = now;
        },
      };
      await buildRecon(req, { gate });
      gap = Math.max(gap, performance.now() - last);
      worst = Math.min(worst, gap);
    }
    expect(worst).toBeLessThan(150);
  });

  it('local thickness of a large 512² silhouette in < 400 ms', () => {
    const m = new Uint8Array(512 * 512);
    for (let y = 0; y < 512; y++) for (let x = 0; x < 512; x++) if (((x - 256) / 220) ** 2 + ((y - 256) / 160) ** 2 <= 1) m[x + 512 * y] = 1;
    expect(best(3, () => localThickness(m, 512, 512))).toBeLessThan(400);
  });
});
