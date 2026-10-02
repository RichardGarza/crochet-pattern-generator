import { describe, expect, it } from 'vitest';
import { clampClose, clampFan, clampStart, closeTail, hysteresis, pathBCounts, poleRuleIssues, slopeIssues, slopeLimit } from '../counts';
import { pathAExact, sphereIdeals } from './helpers';

// §2.10.5 goldens (w = h = 0.2 in, s = 1): the building blocks of the pole rule reproduce the spec's lists, so Path B
// (which uses the same blocks, §2.10.7 step 4) follows the normative rule.

describe('Path B counts (§2.10.7 step 4) and the pole rule (§2.10.5)', () => {
  it('hysteresis 0.75: keeps the previous count unless the ideal moves more than the band', () => {
    expect(hysteresis([6.2, 6.9, 7.0, 7.8, 7.4, 5.1])).toEqual([6, 7, 7, 8, 8, 5]);
    expect(hysteresis([6.2, 6.7, 6.74, 6.8])).toEqual([6, 6, 6, 7]);
    expect(hysteresis([1.96, 3.93, 5.89])).toEqual([2, 4, 6]);
    expect(() => hysteresis([1, NaN])).toThrow(RangeError);
  });

  it('golden: lathe semicircle r = 1.5 exact (symmetric → mirrorHalf) reproduces the spec list', () => {
    const ideal = sphereIdeals(1.5, 0.2, 0.2);
    expect(ideal.length).toBe(23);
    expect(pathAExact(ideal, { closed: true, symmetric: true }).join(' ')).toBe('6 12 18 24 29 33 37 41 44 46 46 47 46 46 44 41 37 33 29 24 18 12 6');
  });

  it('golden: cone r = 1, h = 3, open base, exact → 5 5 6 8 … 31 (n₁ = 5 and the widening clause lifts n₂)', () => {
    const L = Math.hypot(1, 3);
    const N = Math.round(L / 0.2);
    const ideal = Array.from({ length: N }, (_, i) => (2 * Math.PI * (((i + 1) * L) / N / L) * 1) / 0.2);
    expect(ideal[0]).toBeCloseTo(1.96, 2);
    const c = pathBCounts(ideal, { closed: false });
    expect(c.counts.join(' ')).toBe('5 5 6 8 10 12 14 16 18 20 22 24 26 27 29 31');
    expect(c.dropped).toBe(false);
    expect(poleRuleIssues(c.counts, ideal, { closed: false })).toEqual([]);
  });

  it('golden: horn (cone r 0.6, h 1.8 from its base disc), exact → 7 13 19 17 14 12 10 8 6 5 (one raised duplicate dropped)', () => {
    const slant = Math.hypot(0.6, 1.8);
    const L = 0.6 + slant;
    const N = Math.round(L / 0.2);
    const hEff = L / N;
    const r = (s: number): number => (s <= 0.6 ? s : 0.6 * (1 - (s - 0.6) / slant));
    const ideal = Array.from({ length: N - 1 }, (_, i) => (2 * Math.PI * r((i + 1) * hEff)) / 0.2);
    const c = pathBCounts(ideal, { closed: true });
    expect(c.counts.join(' ')).toBe('7 13 19 17 14 12 10 8 6 5');
    expect(c.dropped).toBe(true);
    expect(c.rounded.slice(-3)).toEqual([6, 4, 2]);
    expect(poleRuleIssues(c.counts, ideal, { closed: true })).toEqual([]);
  });

  it('closed far end: the walk stops at the first ideal ≥ 5 from the end and never passes the peak', () => {
    // a waist after the peak is not filled (snowman neck)
    const n = [6, 12, 18, 12, 6, 12, 6, 3];
    const ideal = [6, 12, 18, 12, 6, 12, 6, 3];
    const { counts, dropped } = clampClose(n, ideal);
    expect(counts).toEqual([6, 12, 18, 12, 6, 12, 6, 5]);
    expect(dropped).toBe(false);
    // a raised tail equal to its predecessor is dropped once only
    expect(clampClose([12, 6, 5, 4, 2], [12, 6, 4.9, 4, 2])).toEqual({ counts: [12, 6, 5, 5], dropped: true });
    // nothing to walk when the last round is the peak
    expect(clampClose([6], [6.3])).toEqual({ counts: [6], dropped: false });
  });

  it('start rule: n₁ = clamp(round(ideal₁), 5, 8), no decrease while ideal_k < n₁', () => {
    expect(clampStart([2, 4, 3, 6], [2.2, 4.1, 3.2, 6])).toEqual([5, 5, 5, 6]);
    expect(clampStart([11, 14], [10.6, 14])).toEqual([8, 14]);
    expect(poleRuleIssues([5, 4, 6], [2, 3, 6], { closed: false }).map((i) => i.code)).toEqual(['E_START']);
    expect(poleRuleIssues([9, 12], [9, 12], { closed: false }).map((i) => i.code)).toEqual(['E_START']);
    expect(poleRuleIssues([6, 12, 9], [6, 12, 9], { closed: true }).map((i) => i.code)).toEqual(['E_CLOSE']);
  });

  it('fan clamp and closeTail keep every round reachable and close at ≤ 8', () => {
    expect(clampFan([6, 20, 4, 30])).toEqual([6, 12, 6, 12]);
    expect(closeTail([24, 18, 12])).toEqual({ counts: [24, 18, 12, 6], appended: 1 });
    expect(closeTail([30, 17])).toEqual({ counts: [30, 17, 9, 5], appended: 2 });
    expect(closeTail([12, 6])).toEqual({ counts: [12, 6], appended: 0 });
  });

  it('slope limit ⌈2πh/w⌉ and W_RUFFLE beyond it', () => {
    expect(slopeLimit(0.195, 0.195 / 1.05)).toBe(6);
    expect(slopeLimit(0.2, 0.2)).toBe(7);
    const issues = slopeIssues([6, 12, 24, 20], 7, 'p');
    expect(issues.map((i) => [i.code, i.where?.line])).toEqual([['W_RUFFLE', 3]]);
  });

  it('property: random smooth closed profiles always satisfy R2 / R9 and the fan clamp', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 500; trial++) {
      const N = 3 + Math.floor(rnd() * 40);
      const R = 0.3 + rnd() * 3;
      const bulge = 0.5 + rnd();
      const ideal = Array.from({ length: N }, (_, k) => (2 * Math.PI * R * Math.sin((Math.PI * (k + 1)) / (N + 1)) ** bulge) / 0.2);
      const c = pathBCounts(ideal, { closed: true });
      expect(poleRuleIssues(c.counts, ideal, { closed: true })).toEqual([]);
      for (let k = 1; k < c.counts.length; k++) {
        expect(c.counts[k]).toBeGreaterThanOrEqual(Math.ceil(c.counts[k - 1] / 2));
        expect(c.counts[k]).toBeLessThanOrEqual(2 * c.counts[k - 1]);
      }
    }
  });
});
