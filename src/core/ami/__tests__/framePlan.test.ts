// Integration tasks for Sprint 2 (docs/tracks/integration-s1.md, T4-1 and T4-6): limb start poles from
// `limbProximalEnd`, safety-eye sizes snapped to sizes that exist.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { limbProximalEnd, LIMB_PROXIMAL_KEY } from '../../model/proportions';
import { partAxis, partCenter } from '../../model/transforms';
import { isLimb, limbStartPole } from '../frame';
import { SAFETY_EYE_MM, snapSafetyEyeMm } from '../plan';

const teddy = JSON.parse(readFileSync(new URL('../../../../fixtures/models/teddy.canonical.json', import.meta.url), 'utf8')) as CrochetModelV1;
const byId = (id: string) => teddy.parts.find((p) => p.id === id) as Part;
const body = byId('body');

/** World point of a limb's pole. */
function pole(p: Part, which: 'top' | 'bottom'): Vec3 {
  const len = p.type === 'capsule' ? Math.max(p.dims.length, 2 * p.dims.r) : p.type === 'cylinder' ? p.dims.h : 0;
  const c = partCenter(p);
  const a = partAxis(p, 1);
  const s = which === 'top' ? len / 2 : -len / 2;
  return [c[0] + a[0] * s, c[1] + a[1] * s, c[2] + a[2] * s];
}
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('limb start pole (§2.10.2, task T4-1)', () => {
  it('teddy arms start at the hand and legs at the foot: the pole away from the body', () => {
    for (const id of ['arm_l', 'arm_r', 'leg_l', 'leg_r']) {
      const p = byId(id);
      expect(isLimb(p), id).toBe(true);
      const start = limbStartPole(p, body);
      const other = start === 'top' ? 'bottom' : 'top';
      expect(start).toBe(limbProximalEnd(p, body) === 'top' ? 'bottom' : 'top');
      expect(dist(pole(p, start), partCenter(body)), id).toBeGreaterThan(dist(pole(p, other), partCenter(body)));
    }
    // the legs' start pole is where the foot pads sit
    const leg = byId('leg_l');
    const pad = partCenter(byId('foot_pad_l'));
    const s = limbStartPole(leg, body);
    expect(dist(pole(leg, s), pad)).toBeLessThan(dist(pole(leg, s === 'top' ? 'bottom' : 'top'), pad));
  });

  it('crochet.start wins; attach.openEnd and the stored proximal end are honored (the Proportions edit agrees)', () => {
    const arm = byId('arm_l');
    expect(limbStartPole({ ...arm, crochet: { start: 'top' } } as Part, body)).toBe('top');
    expect(limbStartPole({ ...arm, attach: { to: 'body', method: 'sewn', openEnd: 'top' } } as Part, body)).toBe('bottom');
    expect(limbStartPole({ ...arm, attach: { to: 'body', method: 'sewn', openEnd: 'bottom' } } as Part, body)).toBe('top');
    const stored = { ...arm, [LIMB_PROXIMAL_KEY]: 'bottom' } as unknown as Part;
    expect(limbStartPole(stored, body)).toBe('top');
    const storedTop = { ...arm, [LIMB_PROXIMAL_KEY]: 'top' } as unknown as Part;
    expect(limbStartPole(storedTop, body)).toBe('bottom');
    expect(limbStartPole({ ...arm, crochet: { start: 'auto' } } as Part, body)).toBe(limbStartPole(arm, body));
  });

  it('isLimb: capsule or cylinder named arm_*, leg_*, limb<n>_*', () => {
    expect(isLimb(byId('head'))).toBe(false);
    expect(isLimb({ ...byId('arm_l'), id: 'armchair' } as Part)).toBe(false);
    expect(isLimb({ ...byId('arm_l'), id: 'limb3_l' } as Part)).toBe(true);
    expect(isLimb({ id: 'leg', type: 'cylinder', dims: { rTop: 0.3, rBottom: 0.3, h: 2 }, position: [0, 0, 0], color: 'c' } as Part)).toBe(true);
    expect(isLimb({ ...byId('tail'), id: 'arm_x' } as Part)).toBe(false); // a sphere
  });
});

describe('safety-eye sizes (§2.10.1 rule 1, task T4-6)', () => {
  it('snaps to the nearest size that exists', () => {
    expect(SAFETY_EYE_MM).toEqual([6, 8, 9, 10, 12, 15]);
    expect(snapSafetyEyeMm(10)).toBe(10);
    expect(snapSafetyEyeMm(10.4)).toBe(10);
    expect(snapSafetyEyeMm(11)).toBe(12); // tie 10 / 12 → the larger
    expect(snapSafetyEyeMm(7)).toBe(8); // tie 6 / 8 → the larger
    expect(snapSafetyEyeMm(18)).toBe(15);
    expect(snapSafetyEyeMm(36)).toBe(15); // an 18 mm eye after scaleModel × 2
    expect(snapSafetyEyeMm(3)).toBe(6);
  });

  it('no size for missing or nonsense input', () => {
    for (const x of [undefined, 0, -4, Number.NaN, Number.POSITIVE_INFINITY]) expect(snapSafetyEyeMm(x)).toBeUndefined();
  });
});
