import { describe, expect, it } from 'vitest';
import type { Cell } from '../../../types/gauge';
import { mulberry32, randomRange } from '../../kernel/prng';
import { resolveGauge } from '../resolve';
import { SPHERE_MIN_K, sphereDiameterIn, sphereSizing } from '../sphere';

// Worsted amigurumi, typed from §2.2.3: w = 0.195 in, w/h = 1.05, stuffing stretch s = 1.05.
const W = 0.195;
const WORSTED: Cell = { w: W, h: W / 1.05 };
const S = 1.05;

/** The random sweeps below run thousands of balls: a generous timeout, because other runs share the machine. */
const SWEEP_TIMEOUT_MS = 30_000;

/** Table E widths (§2.2.3), CYC 1–6, in the column order of research 01 §5.4. */
const WIDTHS = [0.13, 0.155, 0.17, 0.195, 0.26, 0.33];

/** The round-by-round counts of the textbook ball: 6, 12, …, 6k, p plain rounds, 6(k − 1), …, 6. */
function counts(k: number, p: number): number[] {
  const up = Array.from({ length: k }, (_, i) => 6 * (i + 1));
  const plain = Array.from({ length: p }, () => 6 * k);
  const down = Array.from({ length: k - 1 }, (_, i) => 6 * (k - 1 - i));
  return [...up, ...plain, ...down];
}

describe('G3 — sphere sizing, D = 2.35 in worsted (§2.2.6, §2.13)', () => {
  it('k = 6, N_max = 36, p = 7, 18 rounds, 468 sts, D_actual = 2.346 in', () => {
    const s = sphereSizing(2.35, WORSTED, S);
    expect(s.k).toBe(6);
    expect(s.nMax).toBe(36);
    expect(s.plainRounds).toBe(7);
    expect(s.rounds).toBe(18);
    expect(s.stitches).toBe(468);
    expect(s.dActualIn).toBeCloseTo(2.346, 3);
    // 36 · 0.195 · 1.05 / π = 7.371 / π = 2.34626
    expect(s.dActualIn).toBeCloseTo(2.34626, 5);
    expect(Object.keys(s).sort()).toEqual(['dActualIn', 'k', 'nMax', 'plainRounds', 'rounds', 'stitches']);
  });

  it('42 sts → 2.737 in (PlanetJune beach ball: "approx 2.75 in")', () => {
    const d = sphereDiameterIn(42, W * S);
    expect(d).toBeCloseTo(2.737, 3);
    expect(d).toBeCloseTo(2.73731, 5); // 42 · 0.20475 / π
    expect(Math.abs(d - 2.75) / 2.75).toBeLessThan(0.005);
    // and the other way: a 2.737 in ball is a 42-st ball
    expect(sphereSizing(2.737, WORSTED, S).nMax).toBe(42);
    expect(sphereSizing(2.75, WORSTED, S).nMax).toBe(42);
  });

  it('the same goldens through resolveGauge (cell and stretch of worsted amigurumi)', () => {
    const g = resolveGauge({ cyc: 4, technique: 'amigurumi_sc' });
    expect(sphereSizing(2.35, g.cell, g.stretch)).toEqual(sphereSizing(2.35, WORSTED, S));
    expect(sphereSizing(2.35, g.cell, g.stretch)).toMatchObject({ nMax: 36, plainRounds: 7, rounds: 18, stitches: 468 });
    expect(sphereDiameterIn(42, g.cell.w * g.stretch)).toBeCloseTo(2.737, 3);
  });

  it('the stated totals are the totals of the round-by-round counts', () => {
    const s = sphereSizing(2.35, WORSTED, S);
    const c = counts(s.k, s.plainRounds);
    expect(c).toEqual([6, 12, 18, 24, 30, 36, 36, 36, 36, 36, 36, 36, 36, 30, 24, 18, 12, 6]);
    expect(c).toHaveLength(s.rounds);
    expect(c.reduce((a, b) => a + b, 0)).toBe(s.stitches);
    expect(Math.max(...c)).toBe(s.nMax);
    // 30 decreases on the way down (§2.8)
    expect(6 * (s.k - 1)).toBe(30);
  });
});

describe('sphereSizing — the formulas of §2.2.6', () => {
  it('p = max(0, round(3k · w/h) − 2k): one round fewer than research 01 §5.1, per research 03 §4.1', () => {
    // w/h = 1.05 ⇒ 3k · 1.05: 6.3, 9.45, 12.6, 15.75, 18.9, 22.05, 25.2, 28.35, 31.5 (tie, up), 34.65, 37.8
    const expected: [number, number, number, number][] = [
      // k, p, rounds, stitches
      [2, 2, 5, 48],
      [3, 3, 8, 108],
      [4, 5, 12, 216],
      [5, 6, 15, 330],
      [6, 7, 18, 468],
      [7, 8, 21, 630],
      [8, 9, 24, 816],
      [9, 10, 27, 1026],
      [10, 12, 31, 1320],
      [11, 13, 34, 1584],
      [12, 14, 37, 1872],
    ];
    for (const [k, p, rounds, stitches] of expected) {
      const s = sphereSizing(sphereDiameterIn(6 * k, W * S), WORSTED, S);
      expect(s).toMatchObject({ k, nMax: 6 * k, plainRounds: p, rounds, stitches });
      const c = counts(k, p);
      expect(c).toHaveLength(rounds);
      expect(c.reduce((a, b) => a + b, 0)).toBe(stitches);
    }
  });

  it('G5 cross-check: the textbook sphere k = 6 with w/h = 1.0 has 6 plain rounds and 17 rounds', () => {
    const s = sphereSizing(2.35, { w: W, h: W }, S);
    expect(s).toMatchObject({ k: 6, plainRounds: 6, rounds: 17, stitches: 432 });
    expect(counts(s.k, s.plainRounds)).toEqual([6, 12, 18, 24, 30, 36, 36, 36, 36, 36, 36, 36, 30, 24, 18, 12, 6]);
  });

  it('yarn under (w/h = 1.11) adds plain rounds, never stitches around', () => {
    const under: Cell = { w: W, h: W / 1.11 };
    const s = sphereSizing(2.35, under, S);
    expect(s.nMax).toBe(36);
    expect(s.plainRounds).toBe(8); // round(19.98) − 12
    expect(s.rounds).toBe(19);
    expect(s.dActualIn).toBeCloseTo(2.34626, 5);
    expect(sphereSizing(sphereDiameterIn(60, W * S), under, S).plainRounds).toBe(13); // round(33.3) − 20
  });

  it('the tie at k = 10 (3 · 10 · 1.05 = 31.5) rounds up for every Table E width: the 60-stitch ball has 12 plain rounds', () => {
    for (const w of [...WIDTHS, 0.5]) {
      for (const stretch of [1, 1.05]) {
        const s = sphereSizing(sphereDiameterIn(60, w * stretch), { w, h: w / 1.05 }, stretch);
        expect(s.k).toBe(10);
        expect(s.plainRounds).toBe(12);
        expect(s.rounds).toBe(31);
        expect(s.stitches).toBe(1320);
      }
    }
  });

  it('decides a tie that binary division leaves short as exact arithmetic would (roundHalfUp)', () => {
    // w/h = 1.15 (the hexagon end of research 01's 1.05–1.15), k = 30: 3 · 30 · 1.15 = 103.5 on paper,
    // 103.49999999999999 in a double — plain Math.round would give 103 and one plain round fewer
    const w = 0.195;
    const h = w / 1.15;
    const x = 3 * 30 * (w / h);
    expect(x).toBeLessThan(103.5);
    expect(Math.round(x)).toBe(103);
    const s = sphereSizing(sphereDiameterIn(180, w * 1.05), { w, h }, 1.05);
    expect(s.k).toBe(30);
    expect(s.plainRounds).toBe(44); // 104 − 60
    expect(s.rounds).toBe(103);
    expect(s.stitches).toBe(6 * 900 + 180 * 44);
  });

  it('a very flat stitch has no plain rounds, never a negative number', () => {
    const s = sphereSizing(3, { w: 0.2, h: 0.4 }, 1); // w/h = 0.5: round(1.5k) − 2k < 0
    expect(s.plainRounds).toBe(0);
    expect(s.rounds).toBe(2 * s.k - 1);
    expect(s.stitches).toBe(6 * s.k * s.k);
  });

  it('the stretch widens the stitch: wS = w · s, and only the diameter depends on it', () => {
    const firm = sphereSizing(2.35, WORSTED, 1.05);
    const loose = sphereSizing(2.35, WORSTED, 1.0);
    // without stretch the same 2.35 in needs π · 2.35 / (6 · 0.195) = 6.31 → k = 6 as well
    expect(loose.k).toBe(6);
    expect(loose.dActualIn).toBeCloseTo((36 * 0.195) / Math.PI, 12);
    expect(firm.dActualIn / loose.dActualIn).toBeCloseTo(1.05, 12);
    expect(loose.plainRounds).toBe(firm.plainRounds);
    // the stretch is not optional: a stuffed ball sized without it would come out 5% larger than asked
    expect(() => sphereSizing(2.35, WORSTED, undefined as unknown as number)).toThrow(/stuffing stretch/);
    // a test ball gauge carries the stretch in w (stretch 1): same ball
    const ball = resolveGauge({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 36 * W * S } });
    expect(sphereSizing(2.35, ball.cell, ball.stretch)).toMatchObject({ nMax: 36, plainRounds: 7, rounds: 18, stitches: 468 });
    expect(sphereSizing(2.35, ball.cell, ball.stretch).dActualIn).toBeCloseTo(firm.dActualIn, 12);
  });

  it('never returns a ball smaller than k = 2 (12 stitches around)', () => {
    expect(SPHERE_MIN_K).toBe(2);
    for (const d of [1e-6, 0.01, 0.2, 0.5]) {
      const s = sphereSizing(d, WORSTED, S);
      expect(s.k).toBe(2);
      expect(s.nMax).toBe(12);
      expect(s.dActualIn).toBeCloseTo((12 * W * S) / Math.PI, 12); // 0.782 in
    }
    expect(sphereSizing(0.5, WORSTED, S).dActualIn).toBeCloseTo(0.78, 2);
  });

  it('rejects input that is not a positive size', () => {
    for (const bad of [0, -2, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => sphereSizing(bad, WORSTED, S)).toThrow(RangeError);
      expect(() => sphereSizing(2, { w: bad, h: 0.2 }, S)).toThrow(RangeError);
      expect(() => sphereSizing(2, { w: 0.2, h: bad }, S)).toThrow(RangeError);
      expect(() => sphereSizing(2, WORSTED, bad)).toThrow(RangeError);
      expect(() => sphereDiameterIn(bad, 0.2)).toThrow(RangeError);
      expect(() => sphereDiameterIn(36, bad)).toThrow(RangeError);
    }
    expect(() => sphereSizing(2, null as unknown as Cell, S)).toThrow(RangeError);
    // results that cannot be expressed are errors, not Infinity
    expect(() => sphereSizing(1, { w: 1e308, h: 1e308 }, 1)).toThrow(/out of range/);
    expect(() => sphereDiameterIn(1e308, 1e308)).toThrow(/out of range/);
    // a ball too large for exact stitch arithmetic
    expect(() => sphereSizing(1e200, WORSTED, S)).toThrow(/out of range/);
    // large but countable is fine
    const big = sphereSizing(60, WORSTED, S);
    expect(big.nMax % 6).toBe(0);
    expect(big.stitches).toBe(6 * big.k * big.k + 6 * big.k * big.plainRounds);
  });
});

describe('sphereSizing — conformance with the formulas of §2.2.6, written out literally', () => {
  function sphereSpec(D: number, w: number, h: number, s: number): { k: number; nMax: number; plainRounds: number; rounds: number; stitches: number; dActualIn: number } {
    const wS = w * s;
    const k = Math.max(2, Math.round((Math.PI * D) / (6 * wS)));
    const p = Math.max(0, Math.round(3 * k * (w / h)) - 2 * k);
    return { k, nMax: 6 * k, plainRounds: p, rounds: 2 * k - 1 + p, stitches: 6 * k * k + 6 * k * p, dActualIn: (6 * k * wS) / Math.PI };
  }

  it('the copy reproduces G3 itself', () => {
    expect(sphereSpec(2.35, 0.195, 0.195 / 1.05, 1.05)).toMatchObject({ k: 6, nMax: 36, plainRounds: 7, rounds: 18, stitches: 468 });
  });

  it('sphereSizing is bit-identical to it on random input', () => {
    const rng = mulberry32(468);
    for (let i = 0; i < 5000; i++) {
      const w = randomRange(rng, 0.04, 0.7);
      const h = w / randomRange(rng, 0.4, 1.4);
      const s = randomRange(rng, 0.85, 1.3);
      const d = randomRange(rng, 0.05, 40);
      expect(sphereSizing(d, { w, h }, s)).toEqual(sphereSpec(d, w, h, s));
    }
  }, SWEEP_TIMEOUT_MS);
});

describe('sphere size table (research 01 §5.4: D = N · w · 1.05 / π)', () => {
  // N_max → diameter in inches for CYC 1…6, as printed (2 decimals)
  const TABLE: [number, number[]][] = [
    [12, [0.52, 0.62, 0.68, 0.78, 1.04, 1.32]],
    [18, [0.78, 0.93, 1.02, 1.17, 1.56, 1.99]],
    [24, [1.04, 1.24, 1.36, 1.56, 2.09, 2.65]],
    [30, [1.3, 1.55, 1.7, 1.96, 2.61, 3.31]],
    [36, [1.56, 1.86, 2.05, 2.35, 3.13, 3.97]],
    [42, [1.82, 2.18, 2.39, 2.74, 3.65, 4.63]],
    [48, [2.09, 2.49, 2.73, 3.13, 4.17, 5.29]],
    [54, [2.35, 2.8, 3.07, 3.52, 4.69, 5.96]],
    [60, [2.61, 3.11, 3.41, 3.91, 5.21, 6.62]],
    [72, [3.13, 3.73, 4.09, 4.69, 6.26, 7.94]],
  ];

  it.each(TABLE)('N_max = %i: the printed diameters for CYC 1–6', (n, printed) => {
    printed.forEach((d, i) => {
      expect(Math.abs(sphereDiameterIn(n, WIDTHS[i] * 1.05) - d)).toBeLessThanOrEqual(0.0051);
    });
  });

  it.each(TABLE)('N_max = %i: the diameter sizes back to the same ball', (n) => {
    for (const w of WIDTHS) {
      const s = sphereSizing(sphereDiameterIn(n, w * 1.05), { w, h: w / 1.05 }, 1.05);
      expect(s.nMax).toBe(n);
      expect(s.k).toBe(n / 6);
      expect(s.dActualIn).toBeCloseTo(sphereDiameterIn(n, w * 1.05), 12);
    }
  });

  it('PlanetJune citrus: 27 to 54 sts ⇒ 1.76 to 3.52 in (research 01 §5.2)', () => {
    expect(sphereDiameterIn(27, W * S)).toBeCloseTo(1.76, 2);
    expect(sphereDiameterIn(54, W * S)).toBeCloseTo(3.52, 2);
  });
});

describe('sphere — round trip and monotonicity', () => {
  it('count → diameter → count is exact for every multiple of 6 from 12', () => {
    for (const w of [...WIDTHS, 0.5, 0.2037, 0.0613]) {
      for (const stretch of [1, 1.05, 1.28]) {
        for (let k = 2; k <= 80; k++) {
          const d = sphereDiameterIn(6 * k, w * stretch);
          expect(sphereSizing(d, { w, h: w / 1.05 }, stretch).nMax).toBe(6 * k);
        }
      }
    }
  });

  it('diameter → count → diameter comes back within one step of 6 (half a step from the request)', () => {
    const rng = mulberry32(36);
    for (let i = 0; i < 2000; i++) {
      const w = randomRange(rng, 0.05, 0.6);
      const stretch = randomRange(rng, 0.9, 1.3);
      const cell: Cell = { w, h: w / randomRange(rng, 0.8, 1.2) };
      const wS = w * stretch;
      const d = randomRange(rng, 0.1, 30);
      const s = sphereSizing(d, cell, stretch);
      expect(s.nMax % 6).toBe(0);
      expect(s.nMax).toBeGreaterThanOrEqual(12);
      expect(sphereDiameterIn(s.nMax, wS)).toBeCloseTo(s.dActualIn, 12);
      const step = (6 * wS) / Math.PI; // diameter of one step of 6 stitches
      if (d >= (9 * wS) / Math.PI) {
        // from 1.5 steps up the nearest ball is used: at most half a step away
        expect(Math.abs(s.dActualIn - d)).toBeLessThanOrEqual(step / 2 + 1e-9);
        // and the count is within 3 stitches of the exact circumference in stitches
        expect(Math.abs(s.nMax - (Math.PI * d) / wS)).toBeLessThanOrEqual(3 + 1e-9);
      } else {
        expect(s.nMax).toBe(12);
      }
      // sizing the ball it returned gives the same ball
      expect(sphereSizing(s.dActualIn, cell, stretch)).toEqual(s);
    }
  }, SWEEP_TIMEOUT_MS);

  it('a larger diameter never gives fewer stitches, rounds or plain rounds', () => {
    const rng = mulberry32(2737);
    for (let i = 0; i < 300; i++) {
      const w = randomRange(rng, 0.05, 0.6);
      const cell: Cell = { w, h: w / randomRange(rng, 0.5, 1.3) };
      const stretch = randomRange(rng, 0.9, 1.3);
      let prev = sphereSizing(0.05, cell, stretch);
      for (let d = 0.05; d < 25; d += randomRange(rng, 0.01, 0.9)) {
        const s = sphereSizing(d, cell, stretch);
        expect(s.nMax).toBeGreaterThanOrEqual(prev.nMax);
        expect(s.plainRounds).toBeGreaterThanOrEqual(prev.plainRounds);
        expect(s.rounds).toBeGreaterThanOrEqual(prev.rounds);
        expect(s.stitches).toBeGreaterThanOrEqual(prev.stitches);
        expect(s.dActualIn).toBeGreaterThanOrEqual(prev.dActualIn);
        prev = s;
      }
    }
  }, SWEEP_TIMEOUT_MS);

  it('a thinner yarn needs more stitches for the same ball', () => {
    let prev = Number.POSITIVE_INFINITY;
    for (const w of WIDTHS) {
      const n = sphereSizing(4, { w, h: w / 1.05 }, 1.05).nMax;
      expect(n).toBeLessThanOrEqual(prev);
      prev = n;
    }
    expect(sphereSizing(4, { w: 0.13, h: 0.13 / 1.05 }, 1.05).nMax).toBe(90); // π · 4 / (6 · 0.1365) = 15.3
    expect(sphereSizing(4, { w: 0.33, h: 0.33 / 1.05 }, 1.05).nMax).toBe(36); // 6.04
  });
});
