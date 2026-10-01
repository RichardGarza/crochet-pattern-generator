// Property tests (DESIGN.md §2.10.5, §6.3 T4): a symmetric profile gives symmetric counts (and symmetric S_k for
// ovals); random lathe profiles never break a count-level rule of §2.13 and never decrease next to a closed start;
// the fan limits hold; everything is deterministic.
import { describe, expect, it } from 'vitest';
import type { Part } from '../../../types/model';
import { profileOf } from '../profiles';
import { roundsForPart, type PieceCounts, type Style } from '../rounds';
import { part } from './helpers/goldens';
import { countViolations, isPalindrome } from './helpers/invariants';
import { between, randomGauge, randomLathe, randomSymmetricLathe, rng } from './helpers/random';

const HEAVY = { timeout: 60_000 } as const;
const STYLES: Style[] = ['exact', 'classic'];

function run(p: Part, g: { wS: number; hS: number }, style: Style, extra: { trimAt?: number; openFar?: boolean; start?: 'top' | 'bottom' } = {}): PieceCounts {
  const out = roundsForPart(p, { ...g, style, ...extra });
  expect(out).not.toBeNull();
  return out as PieceCounts;
}

describe('symmetric profile ⇒ symmetric counts', HEAVY, () => {
  it('random symmetric lathes, both styles, random gauges (600 profiles)', () => {
    const rand = rng(101);
    let symmetric = 0;
    for (let i = 0; i < 300; i++) {
      const p = randomSymmetricLathe(rand);
      const g = randomGauge(rand, profileOf(p)?.L);
      for (const style of STYLES) {
        const out = run(p, g, style);
        if (!out.symmetric) continue;
        symmetric++;
        expect(isPalindrome(out.counts), JSON.stringify({ dims: p.dims, g, style, counts: out.counts })).toBe(true);
        expect(countViolations(out, { style })).toEqual([]);
      }
    }
    expect(symmetric).toBe(600);
  });

  it('spheres, capsules, closed cylinders and ellipsoids (exact), boxes and oval ellipsoids (S_k too)', () => {
    const rand = rng(202);
    for (let i = 0; i < 300; i++) {
      const g = randomGauge(rand);
      const r = between(rand, 0.1, 3);
      const parts: Part[] = [
        part('sphere', { r }),
        part('capsule', { r, length: 2 * r + between(rand, 0, 4) }),
        part('cylinder', { rTop: r, rBottom: r, h: between(rand, 0.1, 5) }),
        part('ellipsoid', { rx: r, ry: between(rand, 0.1, 3), rz: between(rand, 0.1, 3) }),
        part('box', { w: between(rand, 0.2, 4), h: between(rand, 0.2, 4), d: between(rand, 0.2, 4) }),
      ];
      for (const p of parts) {
        const out = run(p, g, 'exact');
        expect(out.symmetric, p.type).toBe(true);
        expect(isPalindrome(out.counts), JSON.stringify({ type: p.type, dims: p.dims, g, counts: out.counts })).toBe(true);
        if (out.ovalS) expect(isPalindrome(out.ovalS)).toBe(true);
        expect(countViolations(out, { style: 'exact' }), JSON.stringify({ type: p.type, dims: p.dims, g, out: out.counts, S: out.ovalS })).toEqual([]);
      }
      // the textbook path is symmetric by construction
      const tb = run(part('sphere', { r }), g, 'classic');
      expect(isPalindrome(tb.counts)).toBe(true);
    }
  });
});

describe('symmetric flattened pieces', () => {
  it('a flattened symmetric piece closes at its start count (ring of 4 ⇒ closes at 4), palindromic', () => {
    const rand = rng(212);
    let fours = 0;
    for (let i = 0; i < 300; i++) {
      const g = { wS: between(rand, 0.2, 0.5), hS: between(rand, 0.08, 0.3) };
      const p = rand() < 0.5 ? part('sphere', { r: between(rand, 0.2, 1.5) }) : part('ellipsoid', { rx: between(rand, 0.3, 1.5), ry: between(rand, 0.2, 0.4), rz: between(rand, 0.3, 1.5) });
      const out = roundsForPart(p, { ...g, style: 'exact', flattened: true, axis: 'y' }) as PieceCounts;
      expect(isPalindrome(out.counts), JSON.stringify({ dims: p.dims, g, counts: out.counts })).toBe(true);
      expect(countViolations(out, { style: 'exact', flattened: true })).toEqual([]);
      if (out.circ[0] === 4) fours++;
    }
    expect(fours).toBeGreaterThan(0);
  });
});

describe('random lathe profiles: no count-level E_* rule broken', HEAVY, () => {
  it('2000 random lathes × both styles, closed or with a trimmed / open far end, started at either pole', () => {
    const rand = rng(303);
    for (let i = 0; i < 2000; i++) {
      const p = randomLathe(rand);
      const start: 'top' | 'bottom' = rand() < 0.5 ? 'top' : 'bottom';
      const prof = profileOf(p, { start });
      const g = randomGauge(rand, prof?.L);
      const mode = rand();
      const extra =
        mode < 0.2 && prof
          ? { start, trimAt: between(rand, 0.05, 0.9) * prof.L } // §2.10.3: a trim buries ≥ 10%
          : mode < 0.35
            ? { start, openFar: true }
            : { start };
      for (const style of STYLES) {
        const out = run(p, g, style, extra);
        expect(countViolations(out, { style }), JSON.stringify({ dims: p.dims, g, style, extra, counts: out.counts, ideal: out.ideal })).toEqual([]);
      }
    }
  });

  it('never decreases next to a closed start (every round before the ideal reaches n₁ is ≥ its predecessor)', () => {
    const rand = rng(404);
    let checked = 0;
    let lifted = 0;
    for (let i = 0; i < 1000; i++) {
      const p = randomLathe(rand);
      const g = randomGauge(rand, profileOf(p)?.L);
      for (const style of STYLES) {
        const out = run(p, g, style);
        if (out.start.k !== 'mr' && out.start.k !== 'chainOval') continue;
        const n1 = out.circ[0];
        for (let k = 1; k < out.circ.length && out.ideal[k] < n1; k++) {
          expect(out.circ[k]).toBeGreaterThanOrEqual(out.circ[k - 1]);
          checked++;
          if (out.raw[k] < out.raw[k - 1] || out.raw[k] < n1) lifted++;
        }
      }
    }
    // the rule is genuinely exercised: many rounds lie in the widening region and many were lifted
    expect(checked).toBeGreaterThan(500);
    expect(lifted).toBeGreaterThan(100);
  });

  it('closed profiles from random primitives (cones, frusta, ellipsoids, boxes) too', () => {
    const rand = rng(505);
    for (let i = 0; i < 500; i++) {
      const g = randomGauge(rand);
      const parts: Part[] = [
        part('cone', { r: between(rand, 0.1, 3), h: between(rand, 0.1, 6) }),
        part('cylinder', { rTop: between(rand, 0.05, 3), rBottom: between(rand, 0.05, 3), h: between(rand, 0.1, 6) }),
        part('ellipsoid', { rx: between(rand, 0.1, 3), ry: between(rand, 0.1, 3), rz: between(rand, 0.1, 3) }),
        part('box', { w: between(rand, 0.1, 4), h: between(rand, 0.1, 4), d: between(rand, 0.1, 4) }),
        part('capsule', { r: between(rand, 0.05, 2), length: between(rand, 4, 8) }),
      ];
      for (const p of parts) {
        for (const style of STYLES) {
          for (const start of ['top', 'bottom'] as const) {
            const out = run(p, g, style, { start });
            expect(countViolations(out, { style }), JSON.stringify({ type: p.type, dims: p.dims, g, style, start, counts: out.counts })).toEqual([]);
          }
        }
      }
    }
  });
});

describe('determinism', () => {
  it('the same input gives identical output', () => {
    const rand = rng(606);
    for (let i = 0; i < 100; i++) {
      const p = randomLathe(rand);
      const g = randomGauge(rand);
      expect(JSON.stringify(run(p, g, 'exact'))).toBe(JSON.stringify(run(p, g, 'exact')));
    }
  });
});
