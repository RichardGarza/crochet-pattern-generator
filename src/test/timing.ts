// Wall-clock budgets in tests (DESIGN.md §5.8, §6.1 rule 5). Step 0 owned; no vitest import, so Playwright
// specs can use it too.
//
// A test that asserts a duration is tagged `perf` and compares against `budget(ms)`:
//
//   it('voxelizes 60 k triangles within 400 ms', { ...PERF }, () => {
//     expect(bestOf(3, () => voxelizeMesh(mesh, 96))).toBeLessThan(budget(400));
//   });
//
// - `npm test` runs every test in parallel files on a machine other agents may load (load 25–40 on 12 cores was
//   seen). There `budget(ms)` is a loose SANITY bound, `max(10 × ms, ms + 250 ms)`: it still catches an
//   accidental blow-up (a quadratic step, a missing cache, a hang) but not a 2× slowdown.
// - `npm run perf` (scripts/perf.mjs) runs only the `perf`-tagged tests, one file at a time in one worker, with
//   `CPG_PERF=1`. There `budget(ms)` is `ms` itself: the strict budget is checked where it can be deterministic.
//
// The tag (vite.config.ts) gives every such test `retry: 2` and a 180 s timeout; a test's own options win.

/** The vitest tag of every test that asserts a wall-clock duration. */
export const PERF_TAG = 'perf';

/** Spread into a test's or a describe's options: `{ ...PERF, timeout: 60_000 }`. */
export const PERF: { tags: string[] } = { tags: [PERF_TAG] };

/** Loose bound = max(budget × LOOSE_FACTOR, budget + LOOSE_FLOOR_MS). */
export const LOOSE_FACTOR = 10;
export const LOOSE_FLOOR_MS = 250;

const env: Record<string, string | undefined> = typeof process !== 'undefined' && process.env ? process.env : {};

/** True under `npm run perf` (`CPG_PERF=1`): budgets are checked as written. */
export const strictTiming: boolean = env.CPG_PERF === '1';

/** The bound a duration is compared with: `ms` when strict, else the loose sanity bound. Pure. */
export function budgetFor(ms: number, strict: boolean): number {
  if (!Number.isFinite(ms) || ms < 0) throw new RangeError(`a budget must be a finite number of ms ≥ 0, got ${ms}`);
  return strict ? ms : Math.max(ms * LOOSE_FACTOR, ms + LOOSE_FLOOR_MS);
}

/** The bound for this run (strict only under `npm run perf`). */
export function budget(ms: number): number {
  return budgetFor(ms, strictTiming);
}

/** The fastest of `runs` timed calls, in ms (the minimum is the least load-sensitive statistic). */
export function bestOf(runs: number, fn: () => unknown): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < Math.max(1, runs); i++) {
    const t0 = performance.now();
    fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}

/** `bestOf` for async work. */
export async function bestOfAsync(runs: number, fn: () => Promise<unknown>): Promise<number> {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < Math.max(1, runs); i++) {
    const t0 = performance.now();
    await fn();
    best = Math.min(best, performance.now() - t0);
  }
  return best;
}
