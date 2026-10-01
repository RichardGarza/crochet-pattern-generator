import { describe, expect, it } from 'vitest';
import { bestOf, bestOfAsync, budget, budgetFor, LOOSE_FACTOR, LOOSE_FLOOR_MS, PERF, PERF_TAG, strictTiming } from '../timing';

describe('timing budgets (§6.1 rule 5)', () => {
  it('strict runs compare with the budget itself', () => {
    expect(budgetFor(5, true)).toBe(5);
    expect(budgetFor(1200, true)).toBe(1200);
  });

  it('npm test compares with a loose sanity bound: 10 × the budget, at least the budget + 250 ms', () => {
    expect(LOOSE_FACTOR).toBe(10);
    expect(LOOSE_FLOOR_MS).toBe(250);
    expect(budgetFor(5, false)).toBe(255);
    expect(budgetFor(16, false)).toBe(266);
    expect(budgetFor(400, false)).toBe(4000);
    expect(budgetFor(0, false)).toBe(250);
  });

  it('refuses a budget that is not a finite, non-negative number', () => {
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(() => budgetFor(bad, false)).toThrow(RangeError);
  });

  it('budget() follows CPG_PERF', () => {
    expect(strictTiming).toBe(process.env.CPG_PERF === '1');
    expect(budget(100)).toBe(budgetFor(100, strictTiming));
  });

  it('PERF tags a test with the perf tag', () => {
    expect(PERF).toEqual({ tags: [PERF_TAG] });
    expect(PERF_TAG).toBe('perf');
  });

  it('bestOf and bestOfAsync return the fastest run and call the function the given number of times', async () => {
    let calls = 0;
    const ms = bestOf(3, () => calls++);
    expect(calls).toBe(3);
    expect(ms).toBeGreaterThanOrEqual(0);
    let asyncCalls = 0;
    const ams = await bestOfAsync(2, async () => {
      asyncCalls++;
    });
    expect(asyncCalls).toBe(2);
    expect(ams).toBeGreaterThanOrEqual(0);
    expect(bestOf(0, () => calls++)).toBeGreaterThanOrEqual(0); // at least one run
    expect(calls).toBe(4);
  });
});
