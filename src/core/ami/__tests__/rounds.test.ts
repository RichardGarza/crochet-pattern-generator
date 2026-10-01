// Path A counts (DESIGN.md §2.10.5), the torus formula (§2.10.4), BLO/FLO rounds and roundsForPart.
import { describe, expect, it } from 'vitest';
import { profileOf, type Profile } from '../profiles';
import { batchCounts, cornerRound, hysteresis, mirrorHalf, pathACounts, roundForStyle, roundsForPart, torusCounts } from '../rounds';
import { goldenCases, part, UNIT } from './helpers/goldens';
import { countViolations } from './helpers/invariants';
import { literalCounts, literalDrops } from './helpers/literal';
import { randomBulge, randomGauge, rng } from './helpers/random';
import { researchTorus } from './helpers/spec';

const must = (p: Profile | null): Profile => {
  expect(p).not.toBeNull();
  return p as Profile;
};

describe('rounding helpers', () => {
  it('hysteresis keeps the previous count inside the band (stops 23/24/23 flicker)', () => {
    expect(hysteresis([23.4, 23.6, 23.3, 24.2, 23.6, 22.9], 0.75)).toEqual([23, 23, 23, 24, 24, 23]);
    expect(hysteresis([2.5, 3.24, 3.26])).toEqual([3, 3, 3]);
    expect(hysteresis([])).toEqual([]);
  });

  it('batchCounts: from p0 = 6 choose p − sym, p, p + sym (≥ sym), ties keep p', () => {
    // the G7 cone ideals: 6 is kept until the ideal passes 9
    expect(batchCounts([1.96, 3.93, 5.89, 7.85, 9.82], 6, 6)).toEqual([6, 6, 6, 6, 12]);
    // tie at 9: keep 6
    expect(batchCounts([9], 6, 6)).toEqual([6]);
    // sym 4: 2 is never a candidate
    expect(batchCounts([1, 1, 1], 4, 6)).toEqual([6, 6, 6]);
    expect(batchCounts([8.1, 11, 14.2], 4, 6)).toEqual([10, 10, 14]);
  });

  it('mirrorHalf rounds the first ceil(m/2) values and mirrors', () => {
    expect(mirrorHalf([1, 2, 3, 2.4, 0.6], (x) => x.map(Math.round))).toEqual([1, 2, 3, 2, 1]);
    expect(mirrorHalf([1, 2, 2.2, 1.3], (x) => x.map(Math.round))).toEqual([1, 2, 2, 1]);
  });

  it('classic batches by 4 below 18 sts, else by 6', () => {
    expect(roundForStyle('classic')([5, 9, 13, 17])).toEqual([6, 10, 14, 18]);
    expect(roundForStyle('classic')([5, 9, 13, 18])).toEqual([6, 6, 12, 18]);
  });

  it('cornerRound: the first k with s_k ≥ s_c + 0.5·hEff', () => {
    expect(cornerRound(0.75, 3.5 / 18)).toBe(5);
    expect(cornerRound(0.6, 2.497 / 12)).toBe(4);
    expect(cornerRound(0.5, 0.5)).toBe(2);
    expect(cornerRound(0, 0.2)).toBe(1);
  });
});

describe('agreement with the literal §2.10.5 pseudocode', () => {
  it('every Path A golden', () => {
    for (const c of goldenCases()) {
      const out = roundsForPart(c.part, c.opts);
      if (!out || out.generator !== 'pathA') continue;
      const p = must(profileOf(c.part, { axis: c.opts.axis, start: c.opts.start, openFar: c.opts.openFar }));
      expect(out.counts, c.id).toEqual(literalCounts(p, c.opts.wS, c.opts.hS, c.opts.style).counts);
    }
  });

  it('500 random single-bulge (non-symmetric) lathes, exact style', () => {
    const rand = rng(21);
    let compared = 0;
    let skipped = 0;
    for (let i = 0; i < 500; i++) {
      const g = randomGauge(rand);
      const p = must(profileOf(randomBulge(rand)));
      const out = pathACounts(p, { ...g, style: 'exact' });
      if (out.symmetric) continue;
      const lit = literalCounts(p, g.wS, g.hS, 'exact');
      // deviation 6: the literal loop also deletes trailing rounds the rule never raised (a straight tip)
      if (literalDrops.dropped > 1 || literalDrops.unraised > 0) {
        skipped++;
        expect(out.dropped).toBeLessThanOrEqual(1);
        expect(out.counts.length).toBeGreaterThan(lit.counts.length);
        continue;
      }
      expect(out.counts).toEqual(lit.counts);
      compared++;
    }
    expect(compared).toBeGreaterThan(400);
    expect(skipped).toBeLessThan(50);
  });
});

describe('Path A behaviour', () => {
  it('N = max(2, round(L/hS)); closed far end: N − 1 rounds; open: N', () => {
    const tiny = pathACounts(must(profileOf(part('sphere', { r: 0.05 }))), { ...UNIT, style: 'exact' });
    expect(tiny.N).toBe(2);
    expect(tiny.counts).toEqual([5]);
    expect(tiny.finish).toBe('gather');
    const cup = pathACounts(must(profileOf(part('sphere', { r: 1 }), { openFar: true })), { ...UNIT, style: 'exact' });
    expect(cup.counts.length).toBe(cup.N);
    expect(cup.finish).toBe('open');
  });

  it('a snowman lathe keeps its neck (the bounded closed-end walk)', () => {
    const profile: [number, number][] = [];
    // big ball r 1.5 (y 0–3), neck, small ball r 1 (y 2.8–4.8)
    for (let i = 0; i <= 30; i++) {
      const t = (Math.PI * i) / 30;
      const y = 1.5 - 1.5 * Math.cos(t);
      if (y <= 2.85) profile.push([1.5 * Math.sin(t), y]);
    }
    for (let i = 0; i <= 30; i++) {
      const t = (Math.PI * i) / 30;
      const y = 3.8 - Math.cos(t);
      if (y > 2.9) profile.push([i === 30 ? 0 : Math.sin(t), y]);
    }
    const out = roundsForPart(part('lathe', { profile }), { ...UNIT, style: 'exact' });
    expect(out).not.toBeNull();
    const c = (out as NonNullable<typeof out>).counts;
    // after the widest round the counts fall to the neck and rise again by more than 10 sts
    const peak = c.indexOf(Math.max(...c));
    const regrowth = Math.max(...c.map((x, j) => (j > peak ? Math.max(...c.slice(j)) - x : 0)));
    expect(regrowth).toBeGreaterThan(10);
    expect(countViolations(out as NonNullable<typeof out>, { style: 'exact' })).toEqual([]);
  });

  it('an open start (tube open at its start) is a chain ring with no clamp', () => {
    const out = roundsForPart(part('cylinder', { rTop: 1, rBottom: 1, h: 2, open: 'both' }), { ...UNIT, style: 'exact' });
    expect(out?.start).toEqual({ k: 'chainRing', chains: 31 });
    expect(out?.counts.every((c) => c === 31)).toBe(true);
    expect(out?.finish).toBe('open');
  });

  it('trimAt cuts the profile: open end, no decrease phase', () => {
    const out = roundsForPart(part('ellipsoid', { rx: 1, ry: 1.2, rz: 1 }), { ...UNIT, style: 'exact', trimAt: 2 });
    expect(out?.finish).toBe('open');
    expect(out?.closedEnd).toBe(false);
    expect(out?.counts.length).toBe(10);
    const tb = roundsForPart(part('sphere', { r: 1.146 }), { ...UNIT, style: 'classic', trimAt: 1.2 });
    expect(tb?.generator).toBe('textbook');
    expect(tb?.counts).toEqual([6, 12, 18, 24, 30, 36]);
  });

  it('the classic style uses the textbook only for spheres and capsules', () => {
    expect(roundsForPart(part('sphere', { r: 1 }), { ...UNIT, style: 'classic' })?.generator).toBe('textbook');
    expect(roundsForPart(part('capsule', { r: 1, length: 3 }), { ...UNIT, style: 'classic' })?.generator).toBe('textbook');
    expect(roundsForPart(part('sphere', { r: 1 }), { ...UNIT, style: 'exact' })?.generator).toBe('pathA');
    expect(roundsForPart(part('ellipsoid', { rx: 1, ry: 1, rz: 1 }), { ...UNIT, style: 'classic' })?.generator).toBe('pathA');
    expect(roundsForPart(part('flat', { shape: 'circle', w: 1, h: 1, thickness: 0.1 }), { ...UNIT, style: 'classic' })).toBeNull();
  });

  it('a concave corner is worked in front loops', () => {
    const out = roundsForPart(part('lathe', { profile: [[0, 0], [1, 0], [1, 1], [1.5, 1], [1.5, 2], [0, 2]] }), { ...UNIT, style: 'exact' });
    expect(out?.loops.filter((l) => l === 'FLO')).toHaveLength(1);
    expect(out?.loops.filter((l) => l === 'BLO')).toHaveLength(3);
  });
});

describe('review findings (T4.1)', () => {
  it('a long thin closed tip is not deleted: at most one round is dropped', () => {
    const tail = roundsForPart(part('lathe', { profile: [[0, 0], [1, 0.2], [0.15, 1], [0.15, 5], [0, 5.05]] }), { ...UNIT, style: 'exact' });
    const horn = roundsForPart(part('cone', { r: 0.4, h: 4 }), { ...UNIT, style: 'classic', start: 'bottom' });
    for (const out of [tail, horn]) {
      expect(out?.dropped).toBeLessThanOrEqual(1);
      expect(out?.counts.length).toBeGreaterThanOrEqual((out?.N ?? 0) - 2);
    }
  });

  it('classic with a chain-ring start batches from the chain count: a straight open tube stays straight', () => {
    for (const open of ['both', 'bottom'] as const) {
      const out = roundsForPart(part('cylinder', { rTop: 1, rBottom: 1, h: 2, open }), { ...UNIT, style: 'classic' });
      expect(out?.start).toEqual({ k: 'chainRing', chains: 31 });
      expect(out?.counts.slice(0, 8).every((c) => c === 31), JSON.stringify(out?.counts)).toBe(true);
    }
  });

  it('round 1 of a magic ring is never BLO/FLO (a corner within half a round moves to round 2)', () => {
    for (const p of [
      part('cylinder', { rTop: 0.1, rBottom: 0.1, h: 1 }),
      part('cylinder', { rTop: 1, rBottom: 0.05, h: 1 }),
      part('box', { w: 0.2, h: 1, d: 0.2 }),
      part('lathe', { profile: [[1e-4, 0], [1, 1], [1, 2], [0, 3]] }),
    ]) {
      const out = roundsForPart(p, { ...UNIT, style: 'exact' });
      expect(out?.loops[0]).toBe('both');
      expect(countViolations(out as NonNullable<typeof out>, { style: 'exact' })).toEqual([]);
    }
  });

  it('openFar on a lathe that already ends on the axis keeps it closed; mirroring needs two closed poles', () => {
    const cone = roundsForPart(part('lathe', { profile: [[0, 0], [1, 0], [0, 3]] }), { ...UNIT, style: 'exact', openFar: true });
    expect(cone?.closedEnd).toBe(true);
    expect(cone?.finish).toBe('gather');
    const tube = roundsForPart(part('cylinder', { rTop: 1, rBottom: 1, h: 2, open: 'both' }), { ...UNIT, style: 'exact' });
    expect(tube?.symmetric).toBe(false);
  });

  it('bad trims and dims throw RangeError on both paths; a cut at or past the far pole is no cut', () => {
    const sphere = part('sphere', { r: 1 });
    for (const style of ['exact', 'classic'] as const) {
      for (const trimAt of [1e-12, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => roundsForPart(sphere, { ...UNIT, style, trimAt }), `${style} ${trimAt}`).toThrow(RangeError);
      }
      const whole = roundsForPart(sphere, { ...UNIT, style, trimAt: 10 });
      expect(whole?.closedEnd).toBe(true);
      expect(whole?.counts).toEqual(roundsForPart(sphere, { ...UNIT, style })?.counts);
    }
    expect(() => roundsForPart(part('capsule', { r: 1, length: Number.NaN }), { ...UNIT, style: 'classic' })).toThrow(RangeError);
    expect(() => roundsForPart(part('lathe', { profile: [[0, 0], [0, 1], [0, 2]] }), { ...UNIT, style: 'exact' })).toThrow(RangeError);
    expect(() => roundsForPart(part('lathe', { profile: [] }), { ...UNIT, style: 'exact' })).toThrow(RangeError);
    expect(() => roundsForPart(part('ellipsoid', { rx: 1, ry: Number.POSITIVE_INFINITY, rz: 1 }), { ...UNIT, style: 'exact' })).toThrow(RangeError);
  });

  it('a zero-height fold is a convex rim', () => {
    const p = must(profileOf(part('lathe', { profile: [[0, 0], [1, 0], [0, 0]] })));
    expect(p.corners.map((c) => c.kind)).toEqual(['convex']);
  });
});

describe('torus (§2.10.4)', () => {
  it('R = 1.5, r = 0.5 at w = h = 0.2 reproduces research 03 §5’s computed example', () => {
    const t = torusCounts(1.5, 0.5, 0.2, 0.2);
    expect(t.counts).toEqual(researchTorus());
    expect(t.start).toEqual({ k: 'chainRing', chains: 31 });
    expect(t.finish).toBe('seamToStart');
    expect(roundsForPart(part('torus', { R: 1.5, r: 0.5 }), { ...UNIT, style: 'classic' })?.counts).toEqual(t.counts);
  });

  it('a thin ring with a tiny hole stays within the fan limits', () => {
    const t = torusCounts(0.3, 0.29, 0.2, 0.2);
    for (let k = 1; k < t.counts.length; k++) expect(t.counts[k]).toBeLessThanOrEqual(2 * t.counts[k - 1]);
    expect(t.counts.every((c) => c >= 1)).toBe(true);
  });
});
