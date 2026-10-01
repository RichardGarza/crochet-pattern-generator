// Seeded pseudo-random numbers (DESIGN.md §2.4.1, §0.1 "Determinism"). Step 0 kernel: pure, no DOM.
//
// There is no `Math.random()` in src/core: every random choice comes from a mulberry32 stream whose seed is
// derived from the input (hash.ts), so the same input always gives the same output.

/** A stream of uniform numbers in [0, 1). */
export type Rng = () => number;

/**
 * mulberry32: a 32-bit generator with one 32-bit word of state. `seed` is taken modulo 2^32 (any integer, for
 * example `fnv1a32(partId)` or `createFnv1a64().update(…).seed32()`).
 */
export function mulberry32(seed: number): Rng {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A uniform integer in [0, n). `n` must be an integer ≥ 1. */
export function randomInt(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n < 1) throw new RangeError(`randomInt: n must be an integer >= 1, got ${n}`);
  return Math.floor(rng() * n);
}

/** A uniform number in [lo, hi). */
export function randomRange(rng: Rng, lo: number, hi: number): number {
  return lo + (hi - lo) * rng();
}

/** Fisher–Yates shuffle in place; returns the same array. */
export function shuffle<T>(rng: Rng, items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
  return items;
}
