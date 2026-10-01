import { describe, expect, it } from 'vitest';
import { hexToFeature } from '../../kernel/color';
import { mulberry32 } from '../../kernel/prng';
import { CURVE_MAX_POINTS, chooseK, coarsePoints, colorBudget, colorLimits, kneeIndex, distortion } from '../autoK';
import { cellPoints, pixelHistogram, totalWeight, type WeightedPoints } from '../points';
import { lloyd, nearestCenter, quantize, varianceSplitInit, varianceSplitSequence } from '../quantize';
import { toLinearImage } from '../../image2d/linear';
import { fromFn } from '../../../test/rgba';

/** Points around the given colors: `per` points each, spread ± `spread` in feature units (seeded). */
function blobs(hexes: readonly string[], per: number, spread: number, seed = 1, weights?: readonly number[]): WeightedPoints {
  const rng = mulberry32(seed);
  const f: number[] = [];
  const w: number[] = [];
  hexes.forEach((h, k) => {
    const c = hexToFeature(h);
    for (let i = 0; i < per; i++) {
      f.push(c[0] + (rng() - 0.5) * spread, c[1] + (rng() - 0.5) * spread, c[2] + (rng() - 0.5) * spread);
      w.push(weights?.[k] ?? 1);
    }
  });
  return { n: w.length, f: Float64Array.from(f), w: Float64Array.from(w) };
}

const PRIMARY = ['#d93a3a', '#3a8f4b', '#3a6fd9', '#f2c12e', '#1d1d3a'];

describe('quantize (§2.4.2)', () => {
  it('finds well-separated clusters exactly, sorted by population (A = main color)', () => {
    const p = blobs(PRIMARY.slice(0, 3), 50, 0.01, 1, [1, 3, 2]);
    const q = quantize(p, 3);
    expect(q.k).toBe(3);
    expect(Array.from(q.weights)).toEqual([150, 100, 50]);
    // Center 0 is the green blob (weight 3), 1 the blue, 2 the red.
    const near = (hex: string): number => nearestCenter(hexToFeature(hex), 0, q.centers, q.k)[0];
    expect([near('#3a8f4b'), near('#3a6fd9'), near('#d93a3a')]).toEqual([0, 1, 2]);
    for (let i = 0; i < p.n; i++) expect(q.labels[i]).toBe(Math.floor(i / 50) === 1 ? 0 : Math.floor(i / 50) === 2 ? 1 : 2);
  });

  it('is deterministic bit for bit (G13 for the quantizer)', () => {
    const p = blobs(PRIMARY, 200, 0.2, 7);
    const ref = quantize(p, 6);
    for (let r = 0; r < 10; r++) {
      const q = quantize(p, 6);
      expect(Array.from(q.centers)).toEqual(Array.from(ref.centers));
      expect(Array.from(q.labels)).toEqual(Array.from(ref.labels));
      expect(q.sse).toBe(ref.sse);
    }
  });

  it('never returns more centers than distinct points; one color gives one center with SSE 0', () => {
    const one: WeightedPoints = { n: 1, f: Float64Array.from(hexToFeature('#808080')), w: Float64Array.of(5) };
    const q = quantize(one, 8);
    expect(q.k).toBe(1);
    expect(q.sse).toBe(0);
    const two = blobs(['#000000', '#ffffff'], 3, 0, 1);
    expect(quantize(two, 8).k).toBe(2);
    expect(quantize({ n: 0, f: new Float64Array(0), w: new Float64Array(0) }, 3).k).toBe(0);
    expect(() => quantize(two, 0)).toThrow(RangeError);
  });

  it('Lloyd never makes the variance-split start worse, and stops within 30 iterations', () => {
    const p = blobs(PRIMARY, 100, 0.4, 3);
    for (const k of [2, 4, 7, 12]) {
      const init = varianceSplitInit(p, k);
      const start = lloyd(p, init, { maxIterations: 1 });
      const q = lloyd(p, init);
      expect(q.sse).toBeLessThanOrEqual(start.sse + 1e-9);
      expect(q.iterations).toBeLessThanOrEqual(30);
      // Labels belong to the returned centers.
      for (let i = 0; i < p.n; i += 17) expect(q.labels[i]).toBe(nearestCenter(p.f, i, q.centers, q.k)[0]);
    }
  });

  it('the split sequence is nested: K + 1 splits one cluster of K', () => {
    const p = blobs(PRIMARY, 60, 0.3, 4);
    const seq = varianceSplitSequence(p, 8);
    expect(seq.length).toBe(8);
    for (let k = 1; k < seq.length; k++) {
      expect(seq[k].length).toBe((k + 1) * 3);
      // Exactly one center of K is gone in K + 1 (replaced by the two halves).
      const kept = [];
      for (let c = 0; c < k; c++) {
        const same = [...Array(k + 1).keys()].some((d) => seq[k][d * 3] === seq[k - 1][c * 3] && seq[k][d * 3 + 1] === seq[k - 1][c * 3 + 1]);
        if (same) kept.push(c);
      }
      expect(kept.length).toBe(k - 1);
    }
    expect(Array.from(varianceSplitInit(p, 5))).toEqual(Array.from(seq[4]));
  });

  it('splits along a chroma-only axis ([1,1,1] ⟂ the spread)', () => {
    // Two colors with the same toe-L and opposite a: the power iteration from [1,1,1] must still find the axis.
    const f = Float64Array.of(0.6, 0.2, 0, 0.6, -0.2, 0);
    const q = quantize({ n: 2, f, w: Float64Array.of(1, 1) }, 2);
    expect(q.k).toBe(2);
    expect(q.sse).toBe(0);
  });
});

describe('points (§2.4.2)', () => {
  it('cellPoints pools identical cells and skips excluded ones', () => {
    const feat = Float32Array.of(0.1, 0, 0, 0.1, 0, 0, 0.5, 0.1, 0.1, 0.9, 0, 0);
    const { points, index } = cellPoints(feat, Uint8Array.of(1, 1, 1, 0));
    expect(points.n).toBe(2);
    expect(Array.from(points.w)).toEqual([2, 1]);
    expect(Array.from(index)).toEqual([0, 0, 1, -1]);
  });

  it('pixelHistogram bins straight colors on 5 bits per channel, background pixels excluded', () => {
    const img = fromFn(10, 10, (x) => (x < 2 ? [0, 0, 0, 0] : x < 6 ? '#ff0000' : '#ff0303'));
    const h = pixelHistogram(toLinearImage(img));
    // #ff0000 and #ff0303 share a bin (3 >> 3 = 0).
    expect(h.points.n).toBe(1);
    expect(totalWeight(h.points)).toBe(80);
    expect(h.pixelBin[0]).toBe(-1);
    expect(h.binPoint[h.pixelBin[5]]).toBe(0);
  });

  it('coarsePoints pools to cubes and keeps the total weight', () => {
    const p = blobs(PRIMARY, 2000, 0.05, 9);
    const c = coarsePoints(p, 0.02);
    expect(c.n).toBeLessThan(p.n);
    expect(totalWeight(c)).toBeCloseTo(totalWeight(p), 9);
  });
});

describe('choosing K (§2.4.3)', () => {
  it('technique limits and the color budget', () => {
    expect(colorLimits('sc_graphgan')).toEqual({ defaultK: 8, maxK: 16, perLine: 6 });
    expect(colorLimits('sc_tapestry')).toEqual({ defaultK: 5, maxK: 8, perLine: 3 });
    expect(colorLimits('amigurumi_sc').maxK).toBe(8);
    expect(colorBudget('sc_tapestry', 12)).toEqual({ cap: 8, auto: false });
    expect(colorBudget('c2c', 'auto')).toEqual({ cap: 16, auto: true });
    expect(colorBudget('c2c', 0)).toEqual({ cap: 1, auto: false });
    expect(() => colorBudget('c2c', Number.NaN)).toThrow(RangeError);
  });

  it('kneeIndex: argmax (1 − y_n) − x_n, ties → the smaller K, flat curve → K = 2', () => {
    expect(kneeIndex([1, 0.2, 0.15, 0.1, 0.05])).toBe(1);
    expect(kneeIndex([1, 0.9, 0.2, 0.1, 0])).toBe(2);
    expect(kneeIndex([0.3, 0.3, 0.3])).toBe(0);
    expect(kneeIndex([])).toBe(0);
  });

  it('auto-K finds the number of well-separated color groups', () => {
    for (const k of [3, 4, 5]) {
      const a = chooseK(blobs(PRIMARY.slice(0, k), 80, 0.02, k), 16);
      expect(a.k).toBe(k);
      expect(a.result.k).toBe(k);
    }
  });

  it('a single color gives K = 1; the curve stops when the points cannot be split', () => {
    const one: WeightedPoints = { n: 1, f: Float64Array.from(hexToFeature('#336699')), w: Float64Array.of(10) };
    expect(chooseK(one, 16).k).toBe(1);
    const three = blobs(PRIMARY.slice(0, 3), 1, 0, 1);
    const a = chooseK(three, 16);
    expect(a.curve.length).toBe(2);
    expect(a.k).toBe(3);
  });

  it('measures the curve on pooled points when there are many, and quantizes the real points', () => {
    const p = blobs(PRIMARY.slice(0, 4), 2000, 0.03, 11);
    expect(p.n).toBeGreaterThan(CURVE_MAX_POINTS);
    const a = chooseK(p, 16);
    expect(a.k).toBe(4);
    expect(a.result.labels.length).toBe(p.n);
    expect(distortion(p, a.result)).toBeLessThan(0.02);
  });
});
