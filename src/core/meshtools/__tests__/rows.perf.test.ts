import { describe, expect, it } from 'vitest';
import { bestOf, budget, PERF } from '../../../test/timing';
import { HeatSolver } from '../heat';
import { geodesicRows, pathBTargetEdge } from '../rows';
import { ellipsoidF, meshOf, uvSphere } from './helpers';

// §5.8: Path B < 2 s per part overall. T5.2's share (re-mesh, heat with t doubling, isolines, seam) is budgeted at
// ≤ 1.2 s for a 6 in ball at worsted or fingering gauge (the re-mesh vertex cap, 30 k) and ≤ 0.6 s for a 4 in body;
// the doubling path (7 heat solves) ≤ 2 s. Best of 3; tagged `perf` (strict only under `npm run perf`, §6.1 rule 5).
const bestMs = (f: () => void): number => bestOf(3, f);

describe('Path B rows performance (§5.8 share)', { ...PERF, timeout: 180_000, retry: 2 }, () => {
  const o = { hS: 0.2, targetEdge: pathBTargetEdge(0.2, 0.2) };
  it('6 in ball ≤ 1.2 s', () => {
    const m = uvSphere(3, 128, 64);
    expect(bestMs(() => geodesicRows(m, o))).toBeLessThan(budget(1200));
  });
  it('6 in ball at fingering gauge (w = h = 0.12: the vertex cap holds the size) ≤ 1.2 s', () => {
    const m = uvSphere(3, 128, 64);
    expect(bestMs(() => geodesicRows(m, { hS: 0.12, targetEdge: pathBTargetEdge(0.12, 0.12) }))).toBeLessThan(budget(1200));
  });
  it('the worst doubling path (7 heat solves, as 6 doublings cost) on a 30 k-vertex part ≤ 2 s (heat share)', () => {
    const r = geodesicRows(uvSphere(3, 128, 64), o);
    const ms = bestMs(() => {
      const h = new HeatSolver(r.sm);
      for (let d = 0; d <= 6; d++) h.solveAt([r.seed.vertex], r.heat.t0 * 2 ** d);
    });
    expect(ms).toBeLessThan(budget(2000));
  });
  it('4 in ellipsoid body ≤ 0.6 s', () => {
    const m = meshOf(ellipsoidF([1.5, 2, 1.25]), 80, 2.3, 3);
    expect(bestMs(() => geodesicRows(m, o))).toBeLessThan(budget(600));
  });
});
