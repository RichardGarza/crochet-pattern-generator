import { describe, expect, it } from 'vitest';
import { consumed, produced } from '../../pattern/ops';
import { cornerIssues, coupleRows, DTW_MAX_TABLE } from '../dtw';
import { coupleRoundsSteps, halfRowBetween } from '../pathB';
import { placeRound, radialFit } from '../regularize';
import { drain } from '../steps';
import { opTally, transduce } from '../transduce';
import type { Op } from '../../../types/pattern';

const W = 0.2;

/** n stitch centers on a circle of circumference n·w in the plane z, from angle `start`, counterclockwise. */
function ring(n: number, z: number, o: { r?: number; start?: number; wobble?: number } = {}): Float64Array {
  const r = o.r ?? (n * W) / (2 * Math.PI);
  const out = new Float64Array(3 * n);
  for (let j = 0; j < n; j++) {
    const a = (o.start ?? 0) + (2 * Math.PI * (j + 0.5)) / n;
    const rr = r * (1 + (o.wobble ?? 0) * Math.sin(3 * a));
    out.set([rr * Math.cos(a), rr * Math.sin(a), z], 3 * j);
  }
  return out;
}

/** Plain-stitch runs between specials (cyclic), for spacing checks. */
function gaps(ops: Op[]): number[] {
  const at: number[] = [];
  ops.forEach((op, i) => op.k !== 'st' && at.push(i));
  return at.map((i, k) => {
    const next = at[(k + 1) % at.length] + (k + 1 === at.length ? ops.length : 0);
    return next - i - 1;
  });
}

function couple(P: number, T: number, z = 0.19, o: { maxFan?: number } = {}): Op[] {
  const al = coupleRows(ring(P, 0), ring(T, z), { w: W, ...o });
  expect(al).not.toBeNull();
  if (!al) return [];
  expect(cornerIssues(al)).toEqual([]);
  const ops = transduce(al);
  expect(consumed(ops)).toBe(P);
  expect(produced(ops)).toBe(T);
  return ops;
}

describe('constrained DTW and the transducer (§2.10.7 step 6; acceptance)', () => {
  it('concentric rings 18 → 24 = 12 sc + 6 inc, evenly spaced', () => {
    for (const z of [0, 0.19]) {
      const ops = couple(18, 24, z);
      expect(opTally(ops)).toEqual({ sc: 12, inc: 6, inc3: 0, dec: 0, dec3: 0 });
      const g = gaps(ops);
      expect(Math.max(...g) - Math.min(...g)).toBeLessThanOrEqual(1);
    }
  });

  it('concentric rings 36 → 34 = 32 sc + 2 dec, on opposite sides', () => {
    for (const z of [0, 0.19]) {
      const ops = couple(36, 34, z);
      expect(opTally(ops)).toEqual({ sc: 32, inc: 0, inc3: 0, dec: 2, dec3: 0 });
      const g = gaps(ops);
      expect(Math.max(...g) - Math.min(...g)).toBeLessThanOrEqual(1);
    }
  });

  it('concentric rings 6 → 12 = 6 inc', () => {
    for (const z of [0, 0.19]) expect(opTally(couple(6, 12, z))).toEqual({ sc: 0, inc: 6, inc3: 0, dec: 0, dec3: 0 });
  });

  it('more pairs: equal counts are all sc, halving is all dec, every count change uses the fewest specials', () => {
    expect(opTally(couple(24, 24))).toEqual({ sc: 24, inc: 0, inc3: 0, dec: 0, dec3: 0 });
    expect(opTally(couple(12, 6))).toEqual({ sc: 0, inc: 0, inc3: 0, dec: 6, dec3: 0 });
    for (const [P, T] of [
      [5, 9],
      [7, 13],
      [30, 36],
      [47, 46],
      [41, 37],
      [13, 7],
      [20, 39],
    ]) {
      const t = opTally(couple(P, T));
      if (T > P) expect([t.inc, t.dec]).toEqual([T - P, 0]);
      else expect([t.dec, t.inc]).toEqual([P - T, 0]);
    }
  });

  it('R6: no stitch is ever part of an increase and a decrease, on noisy rings with any count pair', () => {
    let seed = 3;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let trial = 0; trial < 300; trial++) {
      const P = 3 + Math.floor(rnd() * 60);
      const T = Math.max(Math.ceil(P / 2), Math.min(2 * P, P + Math.round((rnd() - 0.5) * P)));
      const A = ring(P, 0, { start: rnd(), wobble: rnd() * 0.3 });
      const B = ring(T, rnd() * 0.3, { start: rnd() * 0.3, wobble: rnd() * 0.3, r: (T * W) / (2 * Math.PI) * (0.7 + rnd() * 0.6) });
      const al = coupleRows(A, B, { w: W });
      expect(al).not.toBeNull();
      if (!al) continue;
      expect(cornerIssues(al)).toEqual([]);
      const ops = transduce(al);
      expect(consumed(ops)).toBe(P);
      expect(produced(ops)).toBe(T);
      // endpoints fixed at the seam
      expect([al.cells[0], al.cells[1]]).toEqual([0, 0]);
      expect([al.cells[al.cells.length - 2], al.cells[al.cells.length - 1]]).toEqual([P - 1, T - 1]);
    }
  });

  it('fan limits: beyond 2× needs the retry with fan 3; beyond 3× there is no path', () => {
    expect(coupleRows(ring(6, 0), ring(15, 0.2), { w: W })).toBeNull();
    const three = coupleRows(ring(6, 0), ring(15, 0.2), { w: W, maxFan: 3 });
    expect(three).not.toBeNull();
    const t = opTally(transduce(three!));
    expect(t.inc3 * 3 + t.inc * 2 + t.sc).toBe(15);
    expect(t.inc3).toBeGreaterThan(0);
    expect(coupleRows(ring(6, 0), ring(19, 0.2), { w: W, maxFan: 3 })).toBeNull();
    expect(coupleRows(ring(17, 0), ring(6, 0.2), { w: W, maxFan: 3 })).not.toBeNull();
    expect(coupleRows(ring(19, 0), ring(6, 0.2), { w: W, maxFan: 3 })).toBeNull();
  });

  it('the retry ladder: fan 3 with W_FAN3, then half rows (6 → 24 gets a 12-ish round between)', () => {
    const r = drain(coupleRoundsSteps([ring(6, 0), ring(15, 0.2)], { w: W, part: 'p' }));
    expect(r.issues.map((i) => i.code)).toEqual(['W_FAN3']);
    expect(r.fans).toEqual([0, 3]);
    const h = drain(coupleRoundsSteps([ring(6, 0), ring(24, 0.2)], { w: W }));
    expect(h.inserted).toEqual([1]);
    expect(h.samples.map((s) => s.length / 3)).toEqual([6, 12, 24]);
    expect(h.ops.map((o) => produced(o))).toEqual([6, 12, 24]);
    expect(h.ops.slice(1).map((o, k) => consumed(o) === h.samples[k].length / 3)).toEqual([true, true]);
    const mid = halfRowBetween(ring(6, 0), ring(24, 0.2));
    expect(mid.length / 3).toBe(12);
    for (let i = 2; i < mid.length; i += 3) expect(mid[i]).toBeCloseTo(0.1, 12);
  });

  it('corner checks catch hand-made bad alignments; the transducer refuses them', () => {
    // (0,0) H (0,1) V (1,1): stitch 2 in an inc and a dec
    const bad = { cells: Int32Array.from([0, 0, 0, 1, 1, 1]), P: 2, T: 2 };
    expect(cornerIssues(bad).map((i) => i.code)).toEqual(['E_CORNER']);
    expect(() => transduce(bad)).toThrow(/increase and a decrease/);
    expect(cornerIssues({ cells: Int32Array.from([0, 0, 1, 2]), P: 2, T: 3 }).map((i) => i.code)).toEqual(['E_CORNER']);
  });

  it('deterministic, input-checked, bounded', () => {
    const a = coupleRows(ring(29, 0), ring(33, 0.2), { w: W });
    const b = coupleRows(ring(29, 0), ring(33, 0.2), { w: W });
    expect(a?.cells).toEqual(b?.cells);
    expect(() => coupleRows(new Float64Array(4), ring(3, 0), { w: W })).toThrow(RangeError);
    expect(() => coupleRows(ring(3, 0), ring(3, 0), { w: 0 })).toThrow(RangeError);
    expect(() => coupleRows(ring(3, 0), ring(3, 0), { w: W, maxFan: 4 })).toThrow(RangeError);
    expect(() => coupleRows(Float64Array.from([NaN, 0, 0]), ring(1, 0), { w: W })).toThrow(RangeError);
    const big = Math.ceil(Math.sqrt(DTW_MAX_TABLE / 3)) + 1;
    expect(() => coupleRows(ring(big, 0), ring(big, 0.2), { w: W })).toThrow(/table/);
  });
});

describe('§2.10.8 placement for regularized rounds (step 7)', () => {
  const names = (ops: Op[]): string => ops.map((o) => (o.k === 'inc' || o.k === 'dec' ? `${o.k}${o.n === 3 ? 3 : ''}` : 'sc')).join(',');
  it('reproduces the textbook sphere rounds (golden text of §2.10.8)', () => {
    expect(names(placeRound(6, 12, 0))).toBe(Array(6).fill('inc').join(','));
    expect(names(placeRound(12, 18, 1))).toBe(Array(6).fill('sc,inc').join(','));
    expect(names(placeRound(18, 24, 2))).toBe(Array(6).fill('sc,inc,sc').join(','));
    expect(names(placeRound(24, 30, 3))).toBe(Array(6).fill('sc,sc,sc,inc').join(','));
    expect(names(placeRound(30, 36, 4))).toBe(Array(6).fill('sc,sc,inc,sc,sc').join(','));
    expect(names(placeRound(36, 30, 5))).toBe(Array(6).fill('sc,sc,sc,sc,dec').join(','));
    expect(names(placeRound(30, 24, 6))).toBe(Array(6).fill('sc,dec,sc,sc').join(','));
    expect(names(placeRound(12, 6, 9))).toBe(Array(6).fill('dec').join(','));
  });

  it('counts always match; inc3 / dec3 only beyond 2×, spread evenly', () => {
    for (let P = 1; P < 40; P++) {
      for (let T = Math.ceil(P / 3); T <= 3 * P; T++) {
        for (const idx of [0, 1]) {
          const ops = placeRound(P, T, idx);
          expect(consumed(ops)).toBe(P);
          expect(produced(ops)).toBe(T);
          const t = opTally(ops);
          if (T <= 2 * P && T >= Math.ceil(P / 2)) expect(t.inc3 + t.dec3).toBe(0);
        }
      }
    }
    expect(() => placeRound(5, 16, 0)).toThrow(RangeError);
  });

  it('radial fit: circles about one axis have ~0 residual, an off-axis zigzag does not', () => {
    const rounds = [6, 12, 18, 24, 18].map((n, k) => ({ samples: ring(n, 0.2 * k), center: [0, 0, 0.2 * k] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }));
    const fit = radialFit(rounds);
    expect(fit.residual).toBeLessThan(1e-9);
    expect(Math.abs(fit.axis[2])).toBeCloseTo(1, 9);
    const wob = [12, 12, 12].map((n, k) => ({ samples: ring(n, 0.2 * k, { wobble: 0.4 }), center: [0, 0, 0.2 * k] as [number, number, number], normal: [0, 0, 1] as [number, number, number] }));
    expect(radialFit(wob).residual).toBeGreaterThan(0.1);
  });
});
