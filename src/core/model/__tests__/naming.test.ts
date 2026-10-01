import { describe, expect, it } from 'vitest';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { inferAttach, inferMirrorPairs, isOneTree } from '../attach';
import { nameParts } from '../naming';
import { validateModel } from '../schema';
import { modelOf, part } from './helpers/geometry';
import { buildCanonicalTeddy } from './helpers/teddy';

const teddy = buildCanonicalTeddy().model;

/** The teddy as a geometry-only carrier would give it: generic ids, no labels, no links. */
function anonymousTeddy(): CrochetModelV1 {
  return {
    ...teddy,
    parts: teddy.parts.map((p, i) => {
      const copy = { ...p, id: `p${String(i).padStart(2, '0')}` };
      delete copy.attach;
      delete copy.mirrorOf;
      delete copy.label;
      delete copy.crochet;
      return copy;
    }),
  };
}

const ids = (m: CrochetModelV1): string[] => m.parts.map((p) => p.id);
const ball = (id: string, r: number, position: Vec3, rest: Partial<Part> = {}): Part => part('sphere', { r }, { id, position, ...rest });
const child = (id: string, r: number, position: Vec3, to: string, rest: Partial<Part> = {}): Part => ball(id, r, position, { attach: { to }, ...rest });

describe('nameParts (§2.9.7 step 6: template ids by geometry)', () => {
  it('names the anonymous teddy: body, head, leg, arm, ear, muzzle, tail, and part_n by decreasing volume', () => {
    const tree = inferAttach(anonymousTeddy()).model;
    expect(isOneTree(tree)).toBe(true);
    const { model, renames } = nameParts(tree);
    // in the order of the original parts: body head muzzle nose eye_l eye_r ear_l ear_l_inner ear_r ear_r_inner
    // arm_l arm_r leg_l foot_pad_l leg_r foot_pad_r tail
    expect(ids(model)).toEqual([
      'body',
      'head',
      'muzzle',
      'part_5', // nose (0.053 in³)
      'part_6', // eyes (0.034 in³ each)
      'part_7',
      'ear_l',
      'part_3', // inner ears (0.152 in³ each)
      'ear_r',
      'part_4',
      'arm_l',
      'arm_r',
      'leg_l',
      'part_1', // foot pads (0.188 in³ each): the largest unnamed parts
      'leg_r',
      'part_2',
      'tail',
    ]);
    expect(renames).toEqual(Object.fromEntries(tree.parts.map((p, i) => [p.id, model.parts[i].id])));
    // `_l` is the member with x > 0 (the toy's own left)
    for (const p of model.parts) {
      if (p.id.endsWith('_l')) expect(p.position[0]).toBeGreaterThan(0);
      if (p.id.endsWith('_r')) expect(p.position[0]).toBeLessThan(0);
    }
    // the tree is the same tree, under the new names
    expect(Object.fromEntries(model.parts.map((p) => [p.id, p.attach?.to ?? null]))).toEqual({
      body: null,
      head: 'body',
      muzzle: 'head',
      part_5: 'muzzle',
      part_6: 'head',
      part_7: 'head',
      ear_l: 'head',
      part_3: 'ear_l',
      ear_r: 'head',
      part_4: 'ear_r',
      arm_l: 'body',
      arm_r: 'body',
      leg_l: 'body',
      part_1: 'leg_l',
      leg_r: 'body',
      part_2: 'leg_r',
      tail: 'body',
    });
    expect(validateModel(model).ok).toBe(true);
    // the mirror pairs can now be linked by id (§3.7.6)
    expect(inferMirrorPairs(model).repairs.map((r) => r.part)).toEqual(['ear_r', 'arm_r', 'leg_r']);
  });

  it('is idempotent, deterministic and does not modify its input', () => {
    const tree = inferAttach(anonymousTeddy()).model;
    const snapshot = JSON.stringify(tree);
    const once = nameParts(tree);
    expect(JSON.stringify(tree)).toBe(snapshot);
    const twice = nameParts(once.model);
    expect(twice.renames).toEqual({});
    expect(twice.model).toBe(once.model);
    expect(nameParts(tree)).toEqual(once);
  });

  it('the canonical teddy: template names stay; the detail parts become part_n', () => {
    const { model, renames } = nameParts(teddy);
    expect(renames).toEqual({
      nose: 'part_5',
      eye_l: 'part_6',
      eye_r: 'part_7',
      ear_l_inner: 'part_3',
      ear_r_inner: 'part_4',
      foot_pad_l: 'part_1',
      foot_pad_r: 'part_2',
    });
    // mirrorOf follows the rename
    expect(model.parts.find((p) => p.id === 'part_2')?.mirrorOf).toBe('part_1');
    expect(model.parts.find((p) => p.id === 'part_7')?.mirrorOf).toBe('part_6');
    expect(model.parts.find((p) => p.id === 'ear_r')?.mirrorOf).toBe('ear_l');
  });

  it('keepIds: ids the user has renamed are never changed, and no other part takes them', () => {
    const keepIds = new Set(['nose', 'eye_l', 'eye_r', 'foot_pad_l', 'foot_pad_r', 'ear_l_inner', 'ear_r_inner']);
    expect(nameParts(teddy, { keepIds })).toEqual({ model: teddy, renames: {} });
    expect(nameParts(teddy, { keepIds }).model).toBe(teddy);

    // the user called the tail "part_1" and an eye "muzzle": those names are taken
    const custom: CrochetModelV1 = {
      ...teddy,
      parts: teddy.parts.map((p) => {
        if (p.id === 'tail') return { ...p, id: 'part_1' };
        if (p.id === 'eye_l') return { ...p, id: 'muzzle' };
        if (p.id === 'muzzle') return { ...p, id: 'snout', mirrorOf: undefined };
        if (p.id === 'nose') return { ...p, attach: { to: 'snout' } };
        if (p.id === 'eye_r') return { ...p, mirrorOf: 'muzzle' };
        return p;
      }),
    };
    const { model, renames } = nameParts(custom, { keepIds: new Set(['part_1', 'muzzle']) });
    const named = ids(model);
    expect(named.filter((id) => id === 'part_1')).toHaveLength(1);
    expect(model.parts[teddy.parts.findIndex((p) => p.id === 'tail')].id).toBe('part_1'); // kept
    expect(model.parts[teddy.parts.findIndex((p) => p.id === 'eye_l')].id).toBe('muzzle'); // kept
    expect(renames.part_1).toBeUndefined();
    expect(renames.muzzle).toBeUndefined();
    // the real muzzle cannot be called muzzle: it gets a part_n, and part_1 is skipped in the numbering
    expect(renames.snout).toMatch(/^part_\d+$/);
    expect(renames.snout).not.toBe('part_1');
    expect(new Set(named).size).toBe(named.length);
    expect(model.parts.find((p) => p.label === 'Nose')?.attach?.to).toBe(renames.snout);
    expect(validateModel(model).ok).toBe(true);
  });

  it('rewrites every reference: attach.to, mirrorOf, features[].on, assembly[].part and .to', () => {
    const m = modelOf(
      [
        ball('a', 2, [0, 2, 0]),
        child('b', 1.2, [0, 4.8, 0], 'a'),
        child('c', 0.4, [1.9, 2.4, 0], 'a'),
        child('d', 0.4, [-1.9, 2.4, 0], 'a', { mirrorOf: 'c' }),
      ],
      {
        features: [{ id: 'eye', kind: 'safety_eye', on: 'b', azimuthDeg: 20, elevationDeg: 0 }],
        assembly: [
          { order: 1, part: 'b', to: 'a', text: 'Sew b to a.' },
          { order: 2, part: 'c', text: 'Sew the arms.' },
          { order: 3, part: 'ears', to: 'head', text: 'free text ids are left alone' },
        ],
      },
    );
    const { model, renames } = nameParts(m);
    expect(renames).toEqual({ a: 'body', b: 'head', c: 'arm_l', d: 'arm_r' });
    expect(model.parts.map((p) => [p.id, p.attach?.to, p.mirrorOf])).toEqual([
      ['body', undefined, undefined],
      ['head', 'body', undefined],
      ['arm_l', 'body', undefined],
      ['arm_r', 'body', 'arm_l'],
    ]);
    expect(model.features?.[0].on).toBe('head');
    expect(model.assembly).toEqual([
      { order: 1, part: 'head', to: 'body', text: 'Sew b to a.' },
      { order: 2, part: 'arm_l', text: 'Sew the arms.' },
      { order: 3, part: 'ears', to: 'head', text: 'free text ids are left alone' },
    ]);
    expect(validateModel(model).ok).toBe(true);
  });

  it('the pair reaching the lowest 15% of the height is the legs; the next pairs by height are arm, limb2, limb3', () => {
    const m = modelOf([
      ball('root', 2, [0, 3, 0]),
      child('p1', 0.5, [1.2, 0.5, 0], 'root'), // reaches y = 0
      child('p2', 0.5, [-1.2, 0.5, 0], 'root'),
      child('p3', 0.4, [2.1, 2.6, 0], 'root'),
      child('p4', 0.4, [-2.1, 2.6, 0], 'root'),
      child('p5', 0.4, [2.1, 3.8, 0], 'root'),
      child('p6', 0.4, [-2.1, 3.8, 0], 'root'),
      child('p7', 0.3, [1.4, 4.6, 0], 'root'),
      child('p8', 0.3, [-1.4, 4.6, 0], 'root'),
    ]);
    expect(nameParts(m).renames).toEqual({
      root: 'body',
      p1: 'leg_l',
      p2: 'leg_r',
      p3: 'arm_l',
      p4: 'arm_r',
      p5: 'limb2_l',
      p6: 'limb2_r',
      p7: 'limb3_l',
      p8: 'limb3_r',
    });
  });

  it('a standing quadruped: the back pair is the legs, the front pair the arms (§4.2: "arms (its front legs)")', () => {
    const m = modelOf([
      part('capsule', { r: 1, length: 4 }, { id: 'x', position: [0, 2.2, 0], rotationDeg: [90, 0, 0] }),
      child('f1', 0.4, [0.6, 0.4, 1.2], 'x'),
      child('f2', 0.4, [-0.6, 0.4, 1.2], 'x'),
      child('b1', 0.4, [-0.6, 0.4, -1.2], 'x'),
      child('b2', 0.4, [0.6, 0.4, -1.2], 'x'),
    ]);
    expect(nameParts(m).renames).toEqual({ x: 'body', f1: 'arm_l', f2: 'arm_r', b1: 'leg_r', b2: 'leg_l' });
  });

  it('without a pair on the ground the first pair is the arms', () => {
    const m = modelOf([ball('x', 2, [0, 2, 0]), child('u', 0.4, [2.1, 2.5, 0], 'x'), child('v', 0.4, [-2.1, 2.5, 0], 'x')]);
    expect(nameParts(m).renames).toEqual({ x: 'body', u: 'arm_l', v: 'arm_r' });
  });

  it('head: the part already called head (id, else label), else the largest single child above the body’s center with ≥ 15% of its volume', () => {
    const base = (headRest: Partial<Part>, headId = 'h'): CrochetModelV1 =>
      modelOf([
        ball('x', 2, [0, 2, 0]),
        child(headId, 1.2, [0, 4.8, 0], 'x', headRest),
        child('bump', 0.5, [0.3, 4.2, 1.2], 'x'), // above the center, but only 1.6% of the body
        child('low', 1.3, [0, 0.9, 1.5], 'x'), // large, but below the center
      ]);
    expect(nameParts(base({})).renames.h).toBe('head');
    expect(nameParts(base({})).renames.bump).toMatch(/^part_/);
    expect(nameParts(base({})).renames.low).toMatch(/^part_/);
    // an explicit hint wins over geometry
    const hinted = modelOf([ball('x', 2, [0, 2, 0]), child('big', 1.2, [0, 4.8, 0], 'x'), child('small', 0.5, [1.5, 3.5, 0], 'x', { label: ' Head ' })]);
    expect(nameParts(hinted).renames).toEqual({ x: 'body', small: 'head', big: 'part_1' });
    const byId = modelOf([ball('x', 2, [0, 2, 0]), child('big', 1.2, [0, 4.8, 0], 'x'), child('head', 0.5, [1.5, 3.5, 0], 'x')]);
    expect(nameParts(byId).renames).toEqual({ x: 'body', big: 'part_1' });
    // too small to be a neck-split head: no head at all
    const none = modelOf([ball('x', 2, [0, 2, 0]), child('knob', 0.6, [0, 4.4, 0], 'x')]);
    expect(nameParts(none).renames).toEqual({ x: 'body', knob: 'part_1' });
  });

  it('ears: the highest pair on the head above its center; muzzle: a single child in front (beyond ¼ of the head depth)', () => {
    const m = modelOf([
      ball('x', 2, [0, 2, 0]),
      child('h', 1.2, [0, 4.8, 0], 'x'),
      child('e1', 0.3, [0.7, 5.9, 0], 'h'),
      child('e2', 0.3, [-0.7, 5.9, 0], 'h'),
      child('k1', 0.15, [0.5, 5.0, 1.0], 'h'), // eyes: a pair above the center, but lower than the ears
      child('k2', 0.15, [-0.5, 5.0, 1.0], 'h'),
      child('j1', 0.2, [0.9, 4.2, 0.5], 'h'), // cheeks: a pair below the center
      child('j2', 0.2, [-0.9, 4.2, 0.5], 'h'),
      child('m', 0.5, [0, 4.5, 1.1], 'h'), // in front: z − head z = 1.1 > 2.4 / 4
      child('n', 0.4, [0, 5.2, 0.5], 'h'), // not far enough in front: 0.5 < 0.6
    ]);
    const { renames } = nameParts(m);
    expect(renames.e1).toBe('ear_l');
    expect(renames.e2).toBe('ear_r');
    expect(renames.m).toBe('muzzle');
    for (const id of ['k1', 'k2', 'j1', 'j2', 'n']) expect(renames[id]).toMatch(/^part_\d$/);
    // by decreasing volume: n (r 0.4), then the cheeks, then the eyes; ties in parts order
    expect([renames.n, renames.j1, renames.j2, renames.k1, renames.k2]).toEqual(['part_1', 'part_2', 'part_3', 'part_4', 'part_5']);
  });

  it('tail: a single child behind the body (beyond ¼ of the body depth); pairs and front parts are not tails', () => {
    const m = modelOf([
      ball('x', 2, [0, 2, 0]),
      child('t', 0.4, [0, 1.5, -2.1], 'x'),
      child('s', 0.6, [0, 2.5, -0.8], 'x'), // behind, but 0.8 < 4 / 4
      child('w1', 0.3, [1, 2, -1.9], 'x'), // a pair behind: not a tail
      child('w2', 0.3, [-1, 2, -1.9], 'x'),
      child('f', 0.3, [0, 2, 2.1], 'x'),
    ]);
    const { renames } = nameParts(m);
    expect(renames.t).toBe('tail');
    expect(renames.w1).toBe('arm_l');
    expect(renames.w2).toBe('arm_r');
    expect(renames.s).toBe('part_1');
    expect(renames.f).toBe('part_2');
  });

  it('pairs are found by geometry: reconstructed twins are never exact', () => {
    const m = modelOf([
      ball('x', 2, [0, 2, 0]),
      part('capsule', { r: 0.4, length: 1.9 }, { id: 'u', position: [2.1, 2.6, 0.1], rotationDeg: [0, 0, 20], attach: { to: 'x' } }),
      part('ellipsoid', { rx: 0.45, ry: 1.0, rz: 0.4 }, { id: 'v', position: [-2.0, 2.45, 0], rotationDeg: [0, 0, -24], attach: { to: 'x' } }),
      // not a pair: both on the same side
      child('s1', 0.3, [1.5, 0.6, 1.2], 'x'),
      child('s2', 0.3, [1.6, 0.6, -0.6], 'x'),
      // not a pair: mirrored places, very different sizes
      child('q1', 0.7, [1.2, 3.6, 0.9], 'x'),
      child('q2', 0.2, [-1.2, 3.6, 0.9], 'x'),
    ]);
    const { renames } = nameParts(m);
    expect(renames.u).toBe('arm_l');
    expect(renames.v).toBe('arm_r');
    for (const id of ['s1', 's2', 'q1', 'q2']) expect(renames[id]).toMatch(/^part_/);
  });

  it('an existing mirrorOf link makes a pair whatever the geometry says; the plane of symmetry is the root’s x', () => {
    const linked = modelOf([ball('x', 2, [0, 2, 0]), child('u', 0.4, [2.1, 2.6, 0], 'x'), child('v', 0.25, [-1.2, 3.4, 0.8], 'x', { mirrorOf: 'u' })]);
    expect(nameParts(linked).renames).toEqual({ x: 'body', u: 'arm_l', v: 'arm_r' });
    // a model that is not centered on x = 0: the pair mirrors across the body's own center
    const shifted = modelOf([ball('x', 2, [5, 2, 0]), child('u', 0.4, [7.1, 2.6, 0], 'x'), child('v', 0.4, [2.9, 2.6, 0], 'x')]);
    expect(nameParts(shifted).renames).toEqual({ x: 'body', u: 'arm_l', v: 'arm_r' });
  });

  it('works on a model that is not one tree yet: the root rule of inferAttach picks the body', () => {
    const forest = anonymousTeddy();
    const { model, renames } = nameParts(forest);
    expect(renames.p00).toBe('body');
    expect(new Set(ids(model)).size).toBe(17);
    expect(validateModel(model).ok).toBe(true);
    expect(nameParts({ ...forest, parts: [] })).toEqual({ model: { ...forest, parts: [] }, renames: {} });
    const single = modelOf([ball('only', 1, [0, 1, 0])]);
    expect(nameParts(single).renames).toEqual({ only: 'body' });
  });
});
