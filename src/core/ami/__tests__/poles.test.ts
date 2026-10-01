// The pole rule, the fan clamp, starts, finishes and sewing tails (DESIGN.md §2.10.5, §2.10.6).
import { describe, expect, it } from 'vitest';
import {
  chainOvalStart,
  clampFan,
  clampPoles,
  closedEndRule,
  closedSeamIn,
  closeTail,
  mrRange,
  pieceFinish,
  sewingTail,
  startRule,
  tailCm,
} from '../poles';
import { rng } from './helpers/random';

describe('start rule', () => {
  it('classic: the MR is 6 whatever ideal₁ is; exact and Path B: clamp(round(ideal₁), 5, 8); flattened 4–8', () => {
    expect(mrRange({ style: 'classic' })).toEqual([6, 6]);
    expect(mrRange({ style: 'classic', path: 'B' })).toEqual([5, 8]);
    expect(mrRange({ style: 'exact' })).toEqual([5, 8]);
    expect(mrRange({ style: 'exact', flattened: true })).toEqual([4, 8]);
    const o = { start: 'mr', closedFarEnd: false } as const;
    expect(startRule([12, 18], [10.4, 17], { ...o, style: 'classic' })[0]).toBe(6);
    expect(startRule([2, 4], [1.96, 3.93], { ...o, style: 'exact' })[0]).toBe(5);
    expect(startRule([10, 12], [10.4, 12], { ...o, style: 'exact' })[0]).toBe(8);
    expect(startRule([7, 13], [6.54, 13.08], { ...o, style: 'exact' })[0]).toBe(7);
    expect(startRule([3, 6], [3.4, 6], { ...o, style: 'exact', flattened: true })[0]).toBe(4);
  });

  it('a widening shape never decreases next to its start: n_k = max(n_k, n_{k−1}) while ideal_k < n₁', () => {
    const o = { start: 'mr', closedFarEnd: false, style: 'exact' } as const;
    // the G7 exact cone: 2 4 6 8 → 5 5 6 8
    expect(startRule([2, 4, 6, 8], [1.96, 3.93, 5.89, 7.85], o)).toEqual([5, 5, 6, 8]);
    // the clamp stops at the first ideal ≥ n₁, even if a later round is smaller
    expect(startRule([2, 4, 6, 4], [1.96, 3.93, 5.89, 4.2], o)).toEqual([5, 5, 6, 4]);
  });

  it('chain oval: circular part 6; chain ring: no clamp', () => {
    expect(startRule([5, 9], [5.47, 9.09], { start: 'chainOval', closedFarEnd: true, style: 'exact' })).toEqual([6, 9]);
    expect(startRule([3, 2, 9], [3, 2, 9], { start: 'chainOval', closedFarEnd: true, style: 'exact' })).toEqual([6, 6, 9]);
    expect(startRule([31, 33], [31.4, 33], { start: 'chainRing', closedFarEnd: false, style: 'classic' })).toEqual([31, 33]);
  });
});

describe('closed-end rule', () => {
  it('the horn: raw tail … 6 4 2 → … 6 5 5 → trailing duplicate dropped', () => {
    const r = closedEndRule([7, 13, 19, 17, 14, 12, 10, 8, 6, 4, 2], {});
    expect(r.n).toEqual([7, 13, 19, 17, 14, 12, 10, 8, 6, 5]);
    expect(r.dropped).toBe(1);
  });

  it('oval minimum 6 (flattened 4); never past the peak', () => {
    expect(closedEndRule([6, 12, 9, 4], { oval: true }).n).toEqual([6, 12, 9, 6]);
    expect(closedEndRule([6, 12, 9, 2], {}).n).toEqual([6, 12, 9, 5]);
    expect(closedEndRule([6, 12, 9, 2], { flattened: true }).n).toEqual([6, 12, 9, 4]);
  });

  it('drops at most one trailing round, and only one the rule raised (a straight tip is kept)', () => {
    expect(closedEndRule([6, 12, 12], {}).n).toEqual([6, 12, 12]);
    expect(closedEndRule([6, 9, 5, 5, 5], {}).n).toEqual([6, 9, 5, 5, 5]);
    expect(closedEndRule([6, 9, 4, 3, 2], {})).toEqual({ n: [6, 9, 5, 5], dropped: 1 });
    expect(closedEndRule([6, 9, 4, 3, 2], {}, false).n).toEqual([6, 9, 5, 5, 5]);
    expect(closedEndRule([6, 9, 6, 6, 6, 6, 6, 3], {}).n).toEqual([6, 9, 6, 6, 6, 6, 6, 5]);
  });

  it('bounded by the ideals: a waist after the peak is kept (a snowman neck), unlike the unbounded walk', () => {
    const n = [6, 12, 18, 24, 18, 12, 18, 12, 6];
    const ideal = [6, 12, 18, 24, 18, 12, 18, 12, 6];
    expect(closedEndRule(n, {}).n).toEqual([6, 12, 18, 24, 18, 18, 18, 12, 6]);
    expect(closedEndRule(n, {}, true, ideal).n).toEqual(n);
    expect(clampPoles(n, ideal, { start: 'mr', closedFarEnd: true, style: 'exact' })).toEqual(n);
  });
});

describe('fan clamp and close tail', () => {
  it('n_k ∈ [ceil(n_{k−1}/2), 2·n_{k−1}]', () => {
    expect(clampFan([6, 20, 4, 3])).toEqual([6, 12, 6, 3]);
    const rand = rng(3);
    for (let i = 0; i < 500; i++) {
      const n = Array.from({ length: 30 }, () => 1 + Math.floor(rand() * 60));
      const c = clampFan(n);
      for (let k = 1; k < c.length; k++) {
        expect(c[k]).toBeLessThanOrEqual(2 * c[k - 1]);
        expect(c[k]).toBeGreaterThanOrEqual(Math.ceil(c[k - 1] / 2));
      }
      expect(clampFan(c)).toEqual(c);
    }
  });

  it('a closed circular end above 8 gets halving rounds; an oval ends at circular 6', () => {
    expect(closeTail([6, 18, 12], {})).toEqual({ n: [6, 18, 12, 6], appended: 1 });
    expect(closeTail([6, 12, 8], {})).toEqual({ n: [6, 12, 8], appended: 0 });
    expect(closeTail([6, 12, 7], { oval: true })).toEqual({ n: [6, 12, 6], appended: 0 });
    expect(closeTail([6, 18, 14], { oval: true })).toEqual({ n: [6, 18, 14, 7, 6], appended: 2 });
  });
});

describe('starts and finishes (§2.10.6)', () => {
  it('chain oval: ch S + 3', () => {
    expect(chainOvalStart(7)).toEqual({ k: 'chainOval', chains: 10 });
  });

  it('sewing tail T = max(12, 3·seam + 6), printed up to the next 2 in, cm rounded to 5', () => {
    expect(sewingTail(0)).toEqual({ exactIn: 12, in: 12, cm: 30 });
    expect(sewingTail(2)).toEqual({ exactIn: 12, in: 12, cm: 30 });
    expect(sewingTail(3)).toMatchObject({ in: 16, cm: 40 });
    expect(sewingTail(12 * 0.195)).toMatchObject({ in: 14, cm: 35 });
    expect(sewingTail(4 / 3).in).toBe(12);
    expect(() => sewingTail(-1)).toThrow(RangeError);
    expect(() => sewingTail(Number.NaN)).toThrow(RangeError);
    expect(tailCm(6)).toBe(15);
    expect(closedSeamIn(0, 0.2)).toBeCloseTo(Math.PI * 0.8, 12);
    expect(closedSeamIn(1, 0.2)).toBeCloseTo(Math.PI, 12);
  });

  it('finish texts', () => {
    expect(pieceFinish({ kind: 'open', openSts: 12, wS: 0.195 })).toEqual({
      kind: 'open',
      tailIn: 14,
      sewTailIn: 14,
      text: 'Fasten off, leaving a 14" (35 cm) tail for sewing.',
    });
    expect(pieceFinish({ kind: 'gather', wS: 0.2 }).text).toBe(
      'Fasten off, leaving a 6" (15 cm) tail; close with the Ultimate Finish (thread the tail through the front loops of the last sts and pull tight).',
    );
    const sewn = pieceFinish({ kind: 'gather', wS: 0.2, sewnSeamIn: closedSeamIn(1, 0.2) });
    expect(sewn).toMatchObject({ tailIn: 6 + 16, sewTailIn: 16 });
    expect(sewn.text).toBe('Fasten off, leaving a 22" tail; close with the Ultimate Finish and keep the rest of the tail to sew the piece on.');
    expect(pieceFinish({ kind: 'flattenSc', wS: 0.2, S: 5 }).text).toBe(
      'Flatten the opening so its two sides (8 sts each) line up; working through both layers, sc across (8 sc). Fasten off.',
    );
    expect(() => pieceFinish({ kind: 'flattenSc', wS: 0.2, S: 1 })).toThrow(RangeError);
    expect(() => pieceFinish({ kind: 'open', wS: 0.2 })).toThrow(RangeError);
  });
});
