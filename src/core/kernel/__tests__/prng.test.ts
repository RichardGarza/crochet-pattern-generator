import { describe, expect, it } from 'vitest';
import { mulberry32, randomInt, randomRange, shuffle } from '../prng';

/** The algorithm written with BigInt, 32-bit wraps made explicit. */
function reference(seed: number): () => number {
  const M = 0xffffffffn;
  const imul = (x: bigint, y: bigint) => (x * y) & M;
  let a = BigInt.asUintN(32, BigInt(seed));
  return () => {
    a = (a + 0x6d2b79f5n) & M;
    let t = imul(a ^ (a >> 15n), 1n | a);
    t = ((t + imul(t ^ (t >> 7n), 61n | t)) & M) ^ t;
    return Number((t ^ (t >> 14n)) & M) / 4294967296;
  };
}

describe('mulberry32', () => {
  it('produces the pinned sequences (changing them would change every seeded output)', () => {
    const first4 = (seed: number) => {
      const rng = mulberry32(seed);
      return [rng(), rng(), rng(), rng()].map((x) => x * 4294967296);
    };
    expect(first4(0)).toEqual([1144304738, 1416247, 958946056, 627933444]);
    expect(first4(1)).toEqual([2693262067, 11749833, 2265367787, 4213581821]);
    expect(first4(42)).toEqual([2581720956, 1925393290, 3661312704, 2876485805]);
    expect(first4(0xdeadbeef)).toEqual([4043151706, 1147597007, 3315858022, 1538288752]);
    expect(mulberry32(0)()).toBe(0.26642920868471265);
  });

  it('matches the BigInt reference for 10 000 draws on several seeds', () => {
    for (const seed of [0, 1, 2, 42, 0x7fffffff, 0x80000000, 0xdeadbeef, 0xffffffff, -1, -123456]) {
      const a = mulberry32(seed);
      const b = reference(seed);
      for (let i = 0; i < 10_000; i++) {
        if (a() !== b()) throw new Error(`seed ${seed}: draw ${i} differs from the reference`);
      }
    }
  });

  it('takes the seed modulo 2^32 and truncates fractions', () => {
    expect(mulberry32(2 ** 32 + 5)()).toBe(mulberry32(5)());
    expect(mulberry32(-1)()).toBe(mulberry32(0xffffffff)());
    expect(mulberry32(1.9)()).toBe(mulberry32(1)());
  });

  it('is deterministic per seed and differs between seeds', () => {
    const a = mulberry32(123);
    const b = mulberry32(123);
    const c = mulberry32(124);
    const seqA = Array.from({ length: 50 }, () => a());
    const seqB = Array.from({ length: 50 }, () => b());
    const seqC = Array.from({ length: 50 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('stays in [0, 1) and is roughly uniform', () => {
    const rng = mulberry32(2026);
    const bins = new Array<number>(10).fill(0);
    let sum = 0;
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const x = rng();
      expect(x >= 0 && x < 1).toBe(true);
      sum += x;
      bins[Math.floor(x * 10)]++;
    }
    expect(sum / n).toBeGreaterThan(0.495);
    expect(sum / n).toBeLessThan(0.505);
    for (const count of bins) {
      expect(count).toBeGreaterThan(9_500);
      expect(count).toBeLessThan(10_500);
    }
  });
});

describe('randomInt, randomRange, shuffle', () => {
  it('randomInt is floor(rng() · n): exactly 0..n−1, each value about equally often', () => {
    const rng = mulberry32(9);
    const same = reference(9);
    const counts = new Array<number>(7).fill(0);
    for (let i = 0; i < 7000; i++) {
      const v = randomInt(rng, 7);
      expect(v).toBe(Math.floor(same() * 7));
      counts[v]++;
    }
    expect(counts.length).toBe(7);
    for (const c of counts) {
      expect(c).toBeGreaterThan(850); // 1000 expected; rounding instead of flooring would halve the two ends
      expect(c).toBeLessThan(1150);
    }
    expect(randomInt(rng, 1)).toBe(0);
  });

  it('randomInt rejects a bad n', () => {
    const rng = mulberry32(1);
    expect(() => randomInt(rng, 0)).toThrow(RangeError);
    expect(() => randomInt(rng, -3)).toThrow(RangeError);
    expect(() => randomInt(rng, 2.5)).toThrow(RangeError);
    expect(() => randomInt(rng, Number.NaN)).toThrow(RangeError);
  });

  it('randomRange is lo + (hi − lo) · rng(): it covers [lo, hi) and nothing else', () => {
    const rng = mulberry32(3);
    const same = reference(3);
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 5000; i++) {
      const v = randomRange(rng, -2, 5);
      expect(v).toBe(-2 + 7 * same());
      min = Math.min(min, v);
      max = Math.max(max, v);
    }
    expect(min).toBeGreaterThanOrEqual(-2);
    expect(min).toBeLessThan(-1.95);
    expect(max).toBeLessThan(5);
    expect(max).toBeGreaterThan(4.95);
    expect(randomRange(mulberry32(1), 4, 4)).toBe(4);
  });

  it('shuffle is the Fisher–Yates shuffle, in place', () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = shuffle(mulberry32(77), items);
    expect(out).toBe(items);
    // the same algorithm written out, drawing from the same stream
    const expected = Array.from({ length: 20 }, (_, i) => i);
    const draw = reference(77);
    for (let i = expected.length - 1; i > 0; i--) {
      const j = Math.floor(draw() * (i + 1));
      [expected[i], expected[j]] = [expected[j], expected[i]];
    }
    expect(items).toEqual(expected);
    expect([...items].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(shuffle(mulberry32(1), [])).toEqual([]);
    expect(shuffle(mulberry32(1), ['only'])).toEqual(['only']);
  });

  it('shuffle can put any element at any position', () => {
    const n = 5;
    const seenAt = Array.from({ length: n }, () => new Set<number>());
    for (let seed = 0; seed < 400; seed++) {
      const items = shuffle(mulberry32(seed), [0, 1, 2, 3, 4]);
      items.forEach((value, position) => seenAt[position].add(value));
    }
    // every value shows up in every position, the first and the last included
    for (const values of seenAt) expect(values.size).toBe(n);
  });
});
