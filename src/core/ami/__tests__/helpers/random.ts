// Test helper: a seeded PRNG (src/core uses no Math.random, §0.1) and random profile generators.
import type { Part } from '../../../../types/model';
import { part } from './goldens';

/** mulberry32: a small, fast, seeded generator in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const between = (rand: () => number, lo: number, hi: number) => lo + (hi - lo) * rand();

/**
 * A random amigurumi gauge: wS 0.1–0.4 in, w/h 0.9–1.15. With `maxLength`, the stitch is enlarged when needed so
 * the profile holds at most 150 rounds (E_SANITY allows < 200 per piece: a size limit of the input, not a rule
 * the counts can satisfy for a 20 in zigzag profile at lace gauge).
 */
export function randomGauge(rand: () => number, maxLength?: number): { wS: number; hS: number } {
  let wS = between(rand, 0.1, 0.4);
  const aspect = between(rand, 0.9, 1.15);
  if (maxLength !== undefined) wS = Math.max(wS, (maxLength / 150) * aspect);
  return { wS, hS: wS / aspect };
}

/**
 * A random lathe (3–24 points, y non-decreasing from 0, radii 0.05–3 in, height 0.3–8 in). The first point is
 * on the axis (a closed start) unless `offAxisStart`; the last is on the axis with probability ½ (else the far
 * end is a flat disc). Some vertices are marked sharp.
 */
export function randomLathe(rand: () => number, o: { offAxisStart?: boolean } = {}): Part {
  const n = 3 + Math.floor(rand() * 22);
  const H = between(rand, 0.3, 8);
  const R = between(rand, 0.05, 3);
  const ys = Array.from({ length: n }, () => rand() * H).sort((a, b) => a - b);
  ys[0] = 0;
  ys[n - 1] = H;
  const profile: [number, number][] = ys.map((y) => [between(rand, 0.05, R), y]);
  if (!o.offAxisStart) profile[0][0] = 0;
  if (rand() < 0.5) profile[n - 1][0] = 0;
  const sharp = profile.map((_, i) => i).filter(() => rand() < 0.15);
  return part('lathe', { profile, ...(sharp.length ? { sharp } : {}) });
}

/** A random lathe that is mirror-symmetric about its middle height (r(s) = r(L − s)). */
export function randomSymmetricLathe(rand: () => number): Part {
  const half = 2 + Math.floor(rand() * 11);
  const H = between(rand, 0.3, 8);
  const R = between(rand, 0.05, 3);
  const ys = Array.from({ length: half }, () => (rand() * H) / 2).sort((a, b) => a - b);
  ys[0] = 0;
  const lower: [number, number][] = ys.map((y, i) => [i === 0 ? 0 : between(rand, 0.05, R), y]);
  const mid: [number, number] = [between(rand, 0.05, R), H / 2];
  const upper: [number, number][] = lower
    .slice()
    .reverse()
    .map(([r, y]) => [r, H - y]);
  return part('lathe', { profile: [...lower, mid, ...upper] });
}

/** A single-bulge, non-symmetric lathe: r(y) = R·sin(π·u)^p with a skewed u (widens, then narrows, closed). */
export function randomBulge(rand: () => number): Part {
  const n = 24 + Math.floor(rand() * 40);
  const H = between(rand, 0.6, 6);
  const R = between(rand, 0.3, 2.5);
  const skew = between(rand, 0.5, 2);
  const p = between(rand, 0.5, 1.5);
  const profile: [number, number][] = Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1);
    const u = t ** skew;
    return [i === 0 || i === n - 1 ? 0 : R * Math.sin(Math.PI * u) ** p, t * H];
  });
  return part('lathe', { profile });
}
