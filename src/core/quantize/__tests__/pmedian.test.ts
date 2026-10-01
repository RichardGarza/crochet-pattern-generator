import { describe, expect, it } from 'vitest';
import { ciede2000, hexToFeature } from '../../kernel/color';
import { mulberry32 } from '../../kernel/prng';
import { getShippedLine } from '../../yarn/lines';
import { hexesToFeatures, labAt } from '../colors';
import { pMedian, pMedianCost } from '../pmedian';
import type { WeightedPoints } from '../points';
import { nearestCenter, quantize } from '../quantize';

const RHSS = getShippedLine('red-heart-super-saver')!;
const CAND = hexesToFeatures(RHSS.yarns.map((y) => y.hex));
const NC = RHSS.yarns.length;

/** Random weighted points: clusters around random colors plus scatter (seeded). */
function randomPoints(seed: number, clusters: number, per: number): WeightedPoints {
  const rng = mulberry32(seed);
  const f: number[] = [];
  const w: number[] = [];
  for (let c = 0; c < clusters; c++) {
    const hex = `#${Math.floor(rng() * 0xffffff).toString(16).padStart(6, '0')}`;
    const base = hexToFeature(hex);
    const weight = 1 + Math.floor(rng() * 20);
    for (let i = 0; i < per; i++) {
      f.push(base[0] + (rng() - 0.5) * 0.1, base[1] + (rng() - 0.5) * 0.1, base[2] + (rng() - 0.5) * 0.1);
      w.push(weight);
    }
  }
  return { n: w.length, f: Float64Array.from(f), w: Float64Array.from(w) };
}

/** Snap after quantize: free centers → their nearest candidate (ΔEOKr2 or ΔE00), duplicates collapsed. */
function snapAfterQuantize(p: WeightedPoints, k: number, metric: 'ok' | 'de00'): number[] {
  const q = quantize(p, k);
  const set = new Set<number>();
  for (let c = 0; c < q.k; c++) {
    if (metric === 'ok') set.add(nearestCenter(q.centers, c, CAND, NC)[0]);
    else {
      let best = 0;
      let bd = Infinity;
      for (let j = 0; j < NC; j++) {
        const d = ciede2000(labAt(q.centers, c), labAt(CAND, j));
        if (d < bd) {
          bd = d;
          best = j;
        }
      }
      set.add(best);
    }
  }
  return [...set];
}

describe('p-median yarn selection (§2.4.4, D6)', () => {
  it('ACCEPTANCE: never selects the same yarn twice and costs ≤ snap-after-quantize (40 random cases)', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const p = randomPoints(seed, 3 + (seed % 8), 30);
      const k = 2 + (seed % 9);
      const r = pMedian(p, CAND, k);
      expect(new Set(r.chosen).size).toBe(r.chosen.length);
      expect(r.chosen.length).toBe(k);
      expect(r.cost).toBeCloseTo(pMedianCost(p, CAND, r.chosen), 9);
      for (const metric of ['ok', 'de00'] as const) {
        const snap = snapAfterQuantize(p, k, metric);
        expect(r.cost, `seed ${seed} ${metric}`).toBeLessThanOrEqual(pMedianCost(p, CAND, snap) + 1e-9);
      }
    }
  });

  it('matches the brute-force optimum on small cases', () => {
    const cand = hexesToFeatures(['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff', '#ffffff', '#000000']);
    for (let seed = 1; seed <= 12; seed++) {
      const p = randomPoints(100 + seed, 4, 10);
      for (const k of [1, 2, 3]) {
        let best = Infinity;
        const rec = (start: number, set: number[]): void => {
          if (set.length === k) {
            best = Math.min(best, pMedianCost(p, cand, set));
            return;
          }
          for (let j = start; j < 8; j++) rec(j + 1, [...set, j]);
        };
        rec(0, []);
        const r = pMedian(p, cand, k);
        // PAM's SWAP is a local search; on these small sets it reaches the optimum.
        expect(r.cost, `seed ${seed} k ${k}`).toBeCloseTo(best, 9);
      }
    }
  });

  it('fixed candidates are always chosen and never swapped out; excluded ones never chosen', () => {
    const p = randomPoints(5, 6, 20);
    const r = pMedian(p, CAND, 5, { fixed: [0, 43] });
    expect(r.chosen.slice(0, 2)).toEqual([0, 43]);
    expect(new Set(r.chosen).size).toBe(5);
    const free = pMedian(p, CAND, 5);
    const ex = pMedian(p, CAND, 5, { exclude: free.chosen });
    for (const j of free.chosen) expect(ex.chosen).not.toContain(j);
    // More fixed than k: all fixed are kept.
    expect(pMedian(p, CAND, 1, { fixed: [3, 4] }).chosen).toEqual([3, 4]);
  });

  it('fewer candidates than k: all are chosen, once', () => {
    const cand = hexesToFeatures(['#ff0000', '#0000ff']);
    const r = pMedian(randomPoints(2, 4, 5), cand, 6);
    expect([...r.chosen].sort()).toEqual([0, 1]);
  });

  it('is deterministic', () => {
    const p = randomPoints(9, 7, 40);
    const a = pMedian(p, CAND, 6);
    for (let i = 0; i < 10; i++) expect(pMedian(p, CAND, 6)).toEqual(a);
  });

  it('chooses the obvious yarns for points sitting on yarn colors', () => {
    const hexes = ['#e01b2e', '#3a6ea5', '#f7e017'];
    const p: WeightedPoints = { n: 3, f: hexesToFeatures(hexes), w: Float64Array.of(10, 5, 1) };
    const r = pMedian(p, CAND, 3);
    expect(r.cost).toBeCloseTo(0, 9);
    expect(r.chosen.map((j) => RHSS.yarns[j].name).sort()).toEqual(['Blue', 'Bright Yellow', 'Hot Red']);
  });
});
