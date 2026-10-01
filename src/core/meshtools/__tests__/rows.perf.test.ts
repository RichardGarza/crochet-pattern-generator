import { describe, expect, it } from 'vitest';
import { geodesicRows, pathBTargetEdge } from '../rows';
import { ellipsoidF, meshOf, uvSphere } from './helpers';

// §5.8: Path B < 2 s per part overall. T5.2's share (re-mesh, heat with t doubling, isolines, seam) is budgeted at
// ≤ 1.2 s for a 6 in ball at worsted gauge (32 k vertices after the re-mesh; measured ≈ 0.65 s under load) and
// ≤ 0.6 s for a 4 in body (measured ≈ 0.27 s). Best of 3, retried twice: eight agents share the machine.
function bestMs(f: () => void): number {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    f();
    best = Math.min(best, performance.now() - t);
  }
  return best;
}

describe('Path B rows performance (§5.8 share)', { timeout: 180_000, retry: 2 }, () => {
  const o = { hS: 0.2, targetEdge: pathBTargetEdge(0.2, 0.2) };
  it('6 in ball ≤ 1.2 s', () => {
    const m = uvSphere(3, 128, 64);
    expect(bestMs(() => geodesicRows(m, o))).toBeLessThan(1200);
  });
  it('4 in ellipsoid body ≤ 0.6 s', () => {
    const m = meshOf(ellipsoidF([1.5, 2, 1.25]), 80, 2.3, 3);
    expect(bestMs(() => geodesicRows(m, o))).toBeLessThan(600);
  });
});
