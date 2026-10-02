import { describe, expect, it } from 'vitest';
import { bestOf, bestOfAsync, budget, PERF } from '../../../test/timing';
import type { AmiSettings } from '../../../types/ami';
import type { ResolvedGauge } from '../../../types/gauge';
import { pathB, pathBAsync, type PathBRequest } from '../pathB';
import { colored, ellipsoidF, meshOf, uvSphere } from './helpers';

// §5.8: "Path B < 2 s per part" and "largest synchronous stretch between two gate.check calls in any worker ≈ 50 ms".
// Tagged `perf`: strict only under `npm run perf` (§6.1 rule 5). Best of 3.

const WORSTED: ResolvedGauge = { cell: { w: 0.195, h: 0.195 / 1.05 }, wSc: 0.195, hSc: 0.19, lscIn: 1, hookMm: 3.5, stretch: 1.05, tol: 0.1, source: 'default' };
const SPORT: ResolvedGauge = { ...WORSTED, cell: { w: 0.155, h: 0.155 / 1.05 } };
const SETTINGS: AmiSettings = { style: 'exact', spiral: true, crispStripes: false, decMethod: 'invdec', dialect: 'compact', terms: 'us', hand: 'right', eyes: 'auto', defaultStuffing: 'firm', leanStPerRnd: 0.25 };
const req = (mesh: ReturnType<typeof uvSphere>, gauge = WORSTED): PathBRequest => ({ jobId: 1, mesh: colored(mesh), partId: 'p', frame: {}, gauge, settings: SETTINGS });

describe('Path B performance (§5.8)', { ...PERF, timeout: 180_000, retry: 2 }, () => {
  const ball = uvSphere(3, 128, 64);
  it('6 in ball at worsted (≈ 33 k re-mesh vertices) < 2 s', () => {
    expect(bestOf(3, () => pathB(req(ball)))).toBeLessThan(budget(2000));
  });
  it('6 in ball at sport gauge (the 30 k vertex cap holds the size) < 2 s', () => {
    expect(bestOf(3, () => pathB(req(ball, SPORT)))).toBeLessThan(budget(2000));
  });
  it('4 in ellipsoid body < 2 s', () => {
    const body = meshOf(ellipsoidF([1.5, 2, 1.25]), 80, 2.3, 3);
    expect(bestOf(3, () => pathB(req(body)))).toBeLessThan(budget(2000));
  });
  it('the largest synchronous stretch between two gate checks is ≈ 50 ms (6 in ball)', async () => {
    let worst = Infinity;
    const ms = await bestOfAsync(3, async () => {
      let max = 0;
      await pathBAsync(req(ball), async () => {}, { sliceMs: 0, onStretch: (s) => (max = Math.max(max, s)) });
      worst = Math.min(worst, max);
    });
    expect(ms).toBeLessThan(budget(2500));
    expect(worst).toBeLessThan(budget(50));
  });
});
