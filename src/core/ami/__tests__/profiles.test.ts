// Profiles (DESIGN.md §2.10.4): lengths, r(s), corners, symmetry, open ends, trimming, axes.
import { describe, expect, it } from 'vitest';
import {
  isSymmetricProfile,
  naturalAxis,
  ovalHalfDiff,
  polylineProfile,
  profileOf,
  profilePoint,
  profileR,
  trimProfile,
  type Profile,
} from '../profiles';
import { part } from './helpers/goldens';
import { randomLathe, rng } from './helpers/random';

const must = (p: Profile | null): Profile => {
  expect(p).not.toBeNull();
  return p as Profile;
};

/** Arc length of a parametric curve by a million chords — an independent check of the arc tables. */
function chordLength(f: (t: number) => [number, number], t0: number, t1: number, n = 1_000_000): number {
  let len = 0;
  let [z, r] = f(t0);
  for (let i = 1; i <= n; i++) {
    const [z2, r2] = f(t0 + ((t1 - t0) * i) / n);
    len += Math.hypot(z2 - z, r2 - r);
    z = z2;
    r = r2;
  }
  return len;
}

describe('sphere, capsule, cylinder, cone', () => {
  it('sphere: a semicircle, L = πr, r(s) = r·sin(s/r), closed at both poles', () => {
    const p = must(profileOf(part('sphere', { r: 1.5 })));
    expect(p.L).toBeCloseTo(Math.PI * 1.5, 12);
    for (const s of [0, 0.1, 0.7, 2, 3.3, p.L]) expect(profileR(p, s)).toBeCloseTo(1.5 * Math.sin(s / 1.5), 12);
    expect(p.closedStart && p.closedEnd).toBe(true);
    expect(p.corners).toEqual([]);
    expect(p.rMax).toBeCloseTo(1.5, 12);
    expect(isSymmetricProfile(p)).toBe(true);
  });

  it('sphere with an open far end: the half towards the start (a cup)', () => {
    const p = must(profileOf(part('sphere', { r: 1 }), { openFar: true }));
    expect(p.L).toBeCloseTo(Math.PI / 2, 12);
    expect(p.closedEnd).toBe(false);
    expect(profileR(p, p.L)).toBeCloseTo(1, 12);
    expect(isSymmetricProfile(p)).toBe(false);
  });

  it('capsule: quarter circle, straight wall length − 2r, quarter circle; no corners', () => {
    const p = must(profileOf(part('capsule', { r: 0.32, length: 1.4 })));
    expect(p.L).toBeCloseTo(Math.PI * 0.32 + 0.76, 12);
    expect(profileR(p, 0.5 + 0.32)).toBeCloseTo(0.32, 12);
    expect(p.corners).toEqual([]);
    expect(isSymmetricProfile(p)).toBe(true);
    const open = must(profileOf(part('capsule', { r: 0.32, length: 1.4 }), { openFar: true }));
    expect(open.L).toBeCloseTo((Math.PI * 0.32) / 2 + 0.76, 12);
    expect(open.closedEnd).toBe(false);
  });

  it('closed cylinder: disc, wall, disc; two convex corners at r and r + h', () => {
    const p = must(profileOf(part('cylinder', { rTop: 0.75, rBottom: 0.75, h: 2 })));
    expect(p.L).toBeCloseTo(3.5, 12);
    expect(p.corners.map((c) => [c.s, c.kind, Math.round(c.turnDeg)])).toEqual([
      [0.75, 'convex', 90],
      [2.75, 'convex', 90],
    ]);
    expect(p.closedStart && p.closedEnd).toBe(true);
  });

  it('cylinder open ends: no disc there; started at an open end it has an open start', () => {
    const top = must(profileOf(part('cylinder', { rTop: 0.5, rBottom: 1, h: 2, open: 'top' })));
    expect(top.closedEnd).toBe(false);
    expect(top.L).toBeCloseTo(1 + Math.hypot(2, 0.5), 12);
    expect(profileR(top, top.L)).toBeCloseTo(0.5, 12);
    const both = must(profileOf(part('cylinder', { rTop: 1, rBottom: 1, h: 2, open: 'both' })));
    expect(both.closedStart).toBe(false);
    expect(both.closedEnd).toBe(false);
    expect(both.L).toBeCloseTo(2, 12);
    const fromTop = must(profileOf(part('cylinder', { rTop: 0.5, rBottom: 1, h: 2, open: 'bottom' }), { start: 'top' }));
    expect(fromTop.closedStart).toBe(true);
    expect(profileR(fromTop, 0.25)).toBeCloseTo(0.25, 12);
    expect(profileR(fromTop, fromTop.L)).toBeCloseTo(1, 12);
  });

  it('cone: from the apex (top) slant then base disc; from the base (bottom) disc then slant; one convex corner', () => {
    const top = must(profileOf(part('cone', { r: 1, h: 3 }), { start: 'top' }));
    expect(top.L).toBeCloseTo(Math.hypot(1, 3) + 1, 12);
    expect(profileR(top, Math.hypot(1, 3) / 2)).toBeCloseTo(0.5, 12);
    expect(top.corners).toHaveLength(1);
    expect(top.corners[0].kind).toBe('convex');
    const open = must(profileOf(part('cone', { r: 1, h: 3 }), { start: 'top', openFar: true }));
    expect(open.L).toBeCloseTo(Math.hypot(1, 3), 12);
    expect(open.corners).toEqual([]);
    const horn = must(profileOf(part('cone', { r: 0.6, h: 1.8 }), { start: 'bottom' }));
    expect(horn.corners.map((c) => [c.s, c.kind])).toEqual([[0.6, 'convex']]);
    expect(horn.closedEnd).toBe(true);
  });
});

describe('ellipsoid', () => {
  it('meridian arc length matches a million-chord integration; r(s) along the ellipse', () => {
    const p = must(profileOf(part('ellipsoid', { rx: 1.2, ry: 0.6, rz: 2.0 })));
    const ref = chordLength((t) => [2 - 2 * Math.cos(t), 0.6 * Math.sin(t)], 0, Math.PI);
    expect(Math.abs(p.L - ref)).toBeLessThan(1e-9);
    for (const s of [0.05, 0.4, 1.3, 2.2, 4]) {
      const q = profilePoint(p, s);
      // the point lies on the ellipse (z − 2)²/4 + r²/0.36 = 1
      expect(((q.z - 2) ** 2) / 4 + q.r ** 2 / 0.36).toBeCloseTo(1, 10);
      // and at arc length s from the pole
      const t = Math.acos(1 - q.z / 2);
      expect(chordLength((u) => [2 - 2 * Math.cos(u), 0.6 * Math.sin(u)], 0, t, 200_000)).toBeCloseTo(s, 7);
    }
  });

  it('axis: longest semi-axis (ties → Y, then X); cross-section a ≥ b; oval when a/b > 1.15', () => {
    expect(naturalAxis(part('ellipsoid', { rx: 1.2, ry: 0.6, rz: 2.0 }))).toBe('z');
    expect(naturalAxis(part('ellipsoid', { rx: 1, ry: 1, rz: 0.5 }))).toBe('y');
    expect(naturalAxis(part('ellipsoid', { rx: 1, ry: 0.5, rz: 1 }))).toBe('x');
    expect(naturalAxis(part('capsule', { r: 1, length: 3 }))).toBe('y');
    const p = must(profileOf(part('ellipsoid', { rx: 1.2, ry: 0.6, rz: 2.0 })));
    expect(p.oval).toEqual({ a: 1.2, b: 0.6, sides: 'scaled' });
    expect(p.rMax).toBeCloseTo(0.6, 12);
    expect(ovalHalfDiff(p, p.L / 2)).toBeCloseTo(0.6, 9);
    expect(ovalHalfDiff(p, 0)).toBeCloseTo(0, 12);
    // 1.15 exactly is not an oval
    expect(must(profileOf(part('ellipsoid', { rx: 1.15, ry: 1, rz: 2 }))).oval).toBeUndefined();
    expect(must(profileOf(part('ellipsoid', { rx: 1.16, ry: 1, rz: 2 }))).oval).toBeDefined();
    // an explicit axis
    const alongY = must(profileOf(part('ellipsoid', { rx: 1.2, ry: 0.6, rz: 2.0 }), { axis: 'y' }));
    expect(alongY.oval).toEqual({ a: 2, b: 1.2, sides: 'scaled' });
  });
});

describe('box', () => {
  it('rounded box: disc of b, wall h, disc; constant sides a − b', () => {
    const p = must(profileOf(part('box', { w: 2, h: 1.5, d: 1 })));
    expect(p.L).toBeCloseTo(2.5, 12);
    expect(p.oval).toEqual({ a: 1, b: 0.5, sides: 'constant' });
    expect(ovalHalfDiff(p, 0.1)).toBe(0.5);
    expect(p.corners.map((c) => c.s)).toEqual([0.5, 2]);
    expect(isSymmetricProfile(p)).toBe(true);
    // a square box is circular
    expect(must(profileOf(part('box', { w: 1, h: 1, d: 1 }))).oval).toBeUndefined();
  });
});

describe('torus', () => {
  it('a full torus has no profile (torusCounts); an arc is the capsule of length R·arc + 2r', () => {
    expect(profileOf(part('torus', { R: 1.5, r: 0.5 }))).toBeNull();
    const arc = must(profileOf(part('torus', { R: 1.5, r: 0.5, arcDeg: 180 })));
    expect(arc.L).toBeCloseTo(Math.PI * 0.5 + 1.5 * Math.PI, 12);
  });

  it('flat and mesh parts have no profile here', () => {
    expect(profileOf(part('flat', { shape: 'circle', w: 1, h: 1, thickness: 0.2 }))).toBeNull();
    expect(profileOf(part('mesh', { meshRef: 'm', bboxIn: [1, 1, 1] }))).toBeNull();
  });
});

describe('lathe', () => {
  it('a polyline from the bottom (or reversed from the top), z measured from the start pole', () => {
    const p = must(profileOf(part('lathe', { profile: [[0, 0], [1, 0.5], [1, 2], [0, 3]] })));
    expect(p.L).toBeCloseTo(Math.hypot(1, 0.5) + 1.5 + Math.SQRT2, 12);
    const top = must(profileOf(part('lathe', { profile: [[0, 0], [1, 0.5], [0.5, 2], [0, 3]] }), { start: 'top' }));
    expect(profilePoint(top, 0).z).toBe(0);
    expect(profileR(top, Math.hypot(0.5, 1))).toBeCloseTo(0.5, 12);
  });

  it('ends off the axis are closed by flat discs (as the SDF closes them), with a corner when the turn ≥ 45°', () => {
    const p = must(profileOf(part('lathe', { profile: [[1, 0], [1, 1], [0.6, 2]] })));
    expect(p.closedStart && p.closedEnd).toBe(true);
    expect(p.L).toBeCloseTo(1 + 1 + Math.hypot(0.4, 1) + 0.6, 12);
    expect(p.corners.map((c) => c.s)).toEqual([1, p.L - 0.6]);
    // with an open far end the closing disc is left off
    const open = must(profileOf(part('lathe', { profile: [[1, 0], [1, 1], [0.6, 2]] }), { openFar: true }));
    expect(open.closedEnd).toBe(false);
    expect(open.L).toBeCloseTo(2 + Math.hypot(0.4, 1), 12);
  });

  it('a step outwards is a concave corner (FLO); `sharp` marks a gentle turn as a corner', () => {
    const p = must(profileOf(part('lathe', { profile: [[0, 0], [1, 0], [1, 1], [1.5, 1], [1.5, 2], [0, 2]] })));
    expect(p.corners.map((c) => c.kind)).toEqual(['convex', 'concave', 'convex', 'convex']);
    // rims at the bottom (turn 79°) and top (turn 96°); vertex 2 turns only 5.6°
    const gentle = must(profileOf(part('lathe', { profile: [[0, 0], [1, 0], [1.2, 1], [1.3, 2], [0, 2]] })));
    expect(gentle.corners).toHaveLength(2);
    const marked = must(profileOf(part('lathe', { profile: [[0, 0], [1, 0], [1.2, 1], [1.3, 2], [0, 2]], sharp: [2] })));
    expect(marked.corners).toHaveLength(3);
    expect(marked.corners[1].s).toBeCloseTo(1 + Math.hypot(1, 0.2), 12);
    expect(marked.corners[1].turnDeg).toBeLessThan(10);
  });

  it('repeated points are skipped', () => {
    const p = must(profileOf(part('lathe', { profile: [[0, 0], [1, 1], [1, 1], [0, 2]] })));
    expect(p.segs).toHaveLength(2);
  });
});

describe('symmetry and trimming', () => {
  it('symmetric within 1% of the largest radius', () => {
    expect(isSymmetricProfile(polylineProfile([[0, 0], [0.5, 1], [1, 1], [1.5, 0]]))).toBe(true);
    expect(isSymmetricProfile(polylineProfile([[0, 0], [0.5, 1], [1, 1.005], [1.5, 0]]))).toBe(true);
    expect(isSymmetricProfile(polylineProfile([[0, 0], [0.5, 1], [1, 1.03], [1.5, 0]]))).toBe(false);
  });

  it('trimProfile cuts at s, opens the far end and drops later corners; never lengthens', () => {
    const p = must(profileOf(part('cylinder', { rTop: 0.75, rBottom: 0.75, h: 2 })));
    const t = trimProfile(p, 1.5);
    expect(t.L).toBe(1.5);
    expect(t.closedEnd).toBe(false);
    expect(t.trimmedAt).toBe(1.5);
    expect(t.corners.map((c) => c.s)).toEqual([0.75]);
    expect(profileR(t, 1.5)).toBeCloseTo(0.75, 12);
    expect(trimProfile(p, 10)).toBe(p);
    expect(() => trimProfile(p, 0)).toThrow(RangeError);
    const e = must(profileOf(part('ellipsoid', { rx: 1, ry: 2, rz: 1 })));
    const te = trimProfile(e, 2);
    expect(profileR(te, 2)).toBeCloseTo(profileR(e, 2), 9);
    expect(te.L).toBe(2);
  });

  it('r(s) is finite and ≥ 0 on random lathes, and 1-Lipschitz in s', () => {
    const rand = rng(7);
    for (let i = 0; i < 200; i++) {
      const p = must(profileOf(randomLathe(rand), { start: rand() < 0.5 ? 'top' : 'bottom' }));
      let prev = profileR(p, 0);
      for (let j = 1; j <= 100; j++) {
        const r = profileR(p, (p.L * j) / 100);
        expect(Number.isFinite(r) && r >= 0).toBe(true);
        expect(Math.abs(r - prev)).toBeLessThanOrEqual(p.L / 100 + 1e-9);
        prev = r;
      }
    }
  });
});
