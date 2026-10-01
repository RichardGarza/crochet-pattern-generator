import { describe, expect, it } from 'vitest';
import type { ColoredMesh } from '../../../types/geometry';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { isOneTree, subtreeIds } from '../attach';
import { captureAnchor, overlapAlongRay } from '../place';
import { applyProportions, LIMB_FACTORS, LIMB_TEMPLATE, limbTemplateRow, NO_HEAD_REASON, readProportions, resizeLimbs } from '../proportions';
import { scaleModel } from '../scale';
import { validateModel } from '../schema';
import { partSdf, surfaceGap } from '../sdf';
import { boundsSize, localBounds, modelBounds, modelHeight, partAxis, partCenter, worldBounds } from '../transforms';
import { meshFromJson, uvEllipsoid } from './helpers/everyType';
import { modelOf, part, readSpecExample } from './helpers/geometry';
import { buildCanonicalTeddy } from './helpers/teddy';

const teddy = buildCanonicalTeddy().model;
const H = modelHeight(teddy);
const by = (m: CrochetModelV1): Record<string, Part> => Object.fromEntries(m.parts.map((p) => [p.id, p]));
const heightOf = (p: Part, mesh?: ColoredMesh): number => boundsSize(worldBounds(p, mesh))[1];
const headFraction = (m: CrochetModelV1): number => heightOf(by(m).head) / modelHeight(m);
const limbLength = (p: Part): number => (p.type === 'capsule' ? p.dims.length : p.type === 'cylinder' ? p.dims.h : Number.NaN);

/** The two poles of a capsule or cylinder limb: [+axis end, −axis end]. */
function poles(p: Part): [Vec3, Vec3] {
  const c = partCenter(p);
  const a = partAxis(p, 1);
  const h = limbLength(p) / 2;
  return [
    [c[0] + a[0] * h, c[1] + a[1] * h, c[2] + a[2] * h],
    [c[0] - a[0] * h, c[1] - a[1] * h, c[2] - a[2] * h],
  ];
}
const dist = (a: Vec3, b: Vec3): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('LIMB_TEMPLATE and the chips (§4.2, shared with the seed templates of §3.3)', () => {
  it('has both numbers for every row, as fractions of the model height', () => {
    expect(LIMB_TEMPLATE).toEqual({
      quadruped: { arm: 0.25, leg: 0.2 },
      'quadruped-standing': { arm: 0.3, leg: 0.3 },
      biped: { arm: 0.3, leg: 0.3 },
      creature: { arm: 0.15, leg: 0.15 },
    });
    expect(LIMB_FACTORS).toEqual({ nubs: 0.6, short: 1, medium: 1.5, long: 2.2 });
  });

  it('a model without category uses the quadruped row; a standing quadruped its own', () => {
    expect(limbTemplateRow({})).toBe('quadruped');
    expect(limbTemplateRow({ category: 'quadruped', pose: 'sitting' })).toBe('quadruped');
    expect(limbTemplateRow({ category: 'quadruped', pose: 'standing' })).toBe('quadruped-standing');
    expect(limbTemplateRow({ category: 'biped' })).toBe('biped');
    expect(limbTemplateRow({ category: 'person', pose: 'standing' })).toBe('biped');
    expect(limbTemplateRow({ category: 'creature' })).toBe('creature');
    expect(limbTemplateRow({ category: 'bird' })).toBe('quadruped');
    expect(limbTemplateRow(teddy)).toBe('quadruped');
  });
});

describe('readProportions (§4.2)', () => {
  it('G23: the untouched teddy reports head : body 1 : 1.3 and arms closest to "short"', () => {
    const reading = readProportions(teddy);
    expect(reading.disabled).toEqual({});
    expect(reading.headBody).toBeCloseTo(1.3, 1);
    expect(reading.headBody).toBeCloseTo(H / 4.3 - 1, 4); // head height 2 × 2.15 of 9.88
    expect(reading.limbs).toBe('short'); // arms 3.0 / 9.88 = 0.30 of the height: nearer 0.25 (short) than 0.375 (medium)
  });

  it('reads the chip from the arms; from the legs when there are no arms', () => {
    const noArms = { ...teddy, parts: teddy.parts.filter((p) => !p.id.startsWith('arm')) };
    expect(readProportions(noArms).limbs).toBe('medium'); // legs 3.1 / 9.88 = 0.31: nearest 1.5 × 0.20
    const bunny = readSpecExample();
    expect(readProportions(bunny).limbs).toBe('nubs'); // arms 1.4 of 7.6 in = 0.18: nearest 0.6 × 0.25
    expect(readProportions(bunny).headBody).toBeCloseTo(modelHeight(bunny) / 2.4 - 1, 3);
  });

  it('disabled: no head, or the head is the root ("one-piece body: no separate head")', () => {
    expect(NO_HEAD_REASON).toBe('one-piece body: no separate head');
    const noHead = { ...teddy, parts: teddy.parts.filter((p) => !subtreeIds(teddy, 'head').includes(p.id)) };
    // (without its head the teddy is 5.3 in tall, and its 3 in arms are "long")
    expect(readProportions(noHead)).toEqual({ limbs: 'long', disabled: { headBody: NO_HEAD_REASON } });
    const headRoot = modelOf([part('sphere', { r: 1 }, { id: 'head', position: [0, 1, 0] }), part('sphere', { r: 0.3 }, { id: 'nose', position: [0, 1, 1], attach: { to: 'head' } })]);
    expect(readProportions(headRoot).disabled.headBody).toBe(NO_HEAD_REASON);
    expect(readProportions(headRoot).headBody).toBeUndefined();
    // the head is found by id, else by label
    const labelled = { ...teddy, parts: teddy.parts.map((p) => (p.id === 'head' ? { ...p, id: 'noggin' } : p.attach?.to === 'head' ? { ...p, attach: { to: 'noggin' } } : p)) };
    expect(readProportions(labelled).headBody).toBeCloseTo(1.2974, 3);
    expect(readProportions({ ...labelled, parts: labelled.parts.map((p) => (p.id === 'noggin' ? { ...p, label: 'Top' } : p)) }).disabled.headBody).toBe(NO_HEAD_REASON);
  });

  it('disabled: no capsule or cylinder limb, or a limb that is a mesh part ("Fit primitive on arm_l first")', () => {
    const noLimbs = { ...teddy, parts: teddy.parts.filter((p) => !/^(arm|leg|foot)/.test(p.id)) };
    expect(readProportions(noLimbs).limbs).toBeUndefined();
    expect(readProportions(noLimbs).disabled.limbs).toMatch(/^no arms or legs/);
    const meshArm = {
      ...teddy,
      parts: teddy.parts.map((p): Part => (p.id === 'arm_l' ? { ...p, type: 'mesh', dims: { meshRef: 'arm-mesh', bboxIn: [1.1, 3, 1.1] } } : p)),
    };
    expect(readProportions(meshArm).disabled.limbs).toBe('Fit primitive on arm_l first');
    expect(readProportions(meshArm).limbs).toBeUndefined();
    const ellipsoidArms = modelOf([
      part('sphere', { r: 2 }, { id: 'body', position: [0, 2, 0] }),
      part('ellipsoid', { rx: 0.4, ry: 1, rz: 0.4 }, { id: 'arm_l', position: [2, 2, 0], attach: { to: 'body' } }),
    ]);
    expect(readProportions(ellipsoidArms).disabled.limbs).toBe('limbs must be capsules or cylinders (arm_l is a ellipsoid)');
    // limb<n>_* and cylinders count; a part merely containing "arm" in its id does not
    const cylinders = modelOf([
      part('sphere', { r: 2 }, { id: 'body', position: [0, 2, 0] }),
      part('cylinder', { rTop: 0.3, rBottom: 0.3, h: 1 }, { id: 'limb2_l', position: [2, 2, 0], rotationDeg: [0, 0, 90], attach: { to: 'body' } }),
      part('capsule', { r: 0.3, length: 2 }, { id: 'forearm', position: [0, 2, 2], attach: { to: 'body' } }),
    ]);
    expect(readProportions(cylinders).limbs).toBe('short'); // 1 / 4 = 0.25 = 1 × the arm template
    expect(readProportions(cylinders).disabled).toEqual({ headBody: NO_HEAD_REASON });
  });
});

describe('applyProportions: head : body (§4.2, G23)', () => {
  it.each([
    [1, 0.5],
    [3, 0.25],
    [2, 1 / 3],
    [1.22, 1 / 2.22],
    [1.5, 0.4],
  ])('G23: head : body 1 : %d ⇒ the head’s bounding-box height is %f of the model height (± 1%%), the finished height unchanged (± 0.1%%)', (b, fraction) => {
    const { model } = applyProportions(teddy, { headBody: b });
    expect(Math.abs(headFraction(model) / fraction - 1)).toBeLessThan(0.01);
    expect(Math.abs(headFraction(model) / fraction - 1)).toBeLessThan(0.001); // in fact within 0.1%, as §4.2 asks of the bisection
    expect(Math.abs(modelHeight(model) / H - 1)).toBeLessThan(0.001);
    expect(Math.abs(modelHeight(model) / H - 1)).toBeLessThan(1e-5);
    expect(readProportions(model).headBody).toBeCloseTo(b, 2);
    // G23: every ear still within 0.1 in of the head — and so is everything else that sat on it
    const m = by(model);
    for (const id of ['ear_l', 'ear_r', 'muzzle', 'eye_l', 'eye_r']) expect(surfaceGap(m[id], m.head), id).toBeLessThanOrEqual(0.1);
    for (const id of ['ear_l', 'ear_r', 'muzzle', 'eye_l', 'eye_r']) expect(surfaceGap(m[id], m.head), id).toBeLessThan(0); // they still enter it
    expect(surfaceGap(m.nose, m.muzzle)).toBeLessThan(0);
    expect(surfaceGap(m.ear_l_inner, m.ear_l)).toBeLessThan(0);
    expect(surfaceGap(m.head, m.body)).toBeLessThan(0);
  });

  it('1 : 1 on the teddy, in detail: the head grows about its center and keeps its penetration; everything else is scaled alike', () => {
    const { model } = applyProportions(teddy, { headBody: 1 });
    const a = by(model);
    const b = by(teddy);
    expect(validateModel(model).ok).toBe(true);
    expect(isOneTree(model)).toBe(true);
    expect(model.parts.map((p) => p.id)).toEqual(teddy.parts.map((p) => p.id));
    expect(Math.abs(modelBounds(model).min[1])).toBeLessThan(2e-6); // still grounded

    // one uniform factor f for the whole model, and k·f for the head
    const f = (a.body.dims as { ry: number }).ry / 2.6;
    expect(f).toBeLessThan(1); // the model was shrunk back to its height
    const k = (a.head.dims as { ry: number }).ry / 2.15 / f;
    expect(k).toBeGreaterThan(1.2);
    expect(k).toBeLessThan(1.4);
    for (const p of model.parts) {
      const before = b[p.id];
      const ratio = boundsSize(localBounds(p))[1] / boundsSize(localBounds(before))[1];
      expect(ratio, p.id).toBeCloseTo(p.id === 'head' ? k * f : f, 4);
      expect(p.rotationDeg).toEqual(before.rotationDeg);
      expect(p.attach).toEqual(before.attach);
    }
    expect((a.head.dims as { rx: number }).rx / 2.4).toBeCloseTo(k * f, 4); // uniformly
    expect((a.head.dims as { rz: number }).rz / 2.2).toBeCloseTo(k * f, 4);
    // the head's penetration into the body along the ray between their centers is the original one (scaled by f)
    expect(overlapAlongRay(a.body, a.head)).toBeCloseTo(overlapAlongRay(b.body, b.head) * f, 3);
    // parts that are not on the head only took part in the final rescale: every coordinate × f
    for (const id of ['body', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'foot_pad_l', 'foot_pad_r', 'tail']) {
      for (let i = 0; i < 3; i++) expect(a[id].position[i], id).toBeCloseTo(b[id].position[i] * f, 4);
    }
    // children of the head keep their direction on it (within 1°) and their size relative to the body
    for (const id of ['ear_l', 'ear_r', 'muzzle', 'eye_l', 'eye_r']) {
      const before = captureAnchor(b.head, b[id]);
      const now = captureAnchor(a.head, a[id]);
      expect(Math.abs(now.azimuthDeg - before.azimuthDeg), id).toBeLessThan(1);
      expect(Math.abs(now.elevationDeg - before.elevationDeg), id).toBeLessThan(1);
    }
    // grandchildren follow their parents rigidly
    for (const [child, grandchild] of [['ear_l', 'ear_l_inner'], ['muzzle', 'nose']]) {
      for (let i = 0; i < 3; i++) expect(a[grandchild].position[i] - a[child].position[i]).toBeCloseTo((b[grandchild].position[i] - b[child].position[i]) * f, 4);
    }
  });

  it('keeps the model symmetric: centered parts stay centered, mirror twins stay exact mirrors', () => {
    for (const headBody of [1, 2.37, 3]) {
      const { model } = applyProportions(teddy, { headBody });
      const m = by(model);
      for (const id of ['body', 'head', 'muzzle', 'nose', 'tail']) expect(m[id].position[0], id).toBe(0);
      for (const p of model.parts) {
        if (!p.mirrorOf) continue;
        expect(p.position).toEqual([-m[p.mirrorOf].position[0], m[p.mirrorOf].position[1], m[p.mirrorOf].position[2]]);
        expect(p.dims).toEqual(m[p.mirrorOf].dims);
      }
    }
  });

  it('the head fraction grows monotonically with the head scale; the range k ∈ [0.2, 5] limits what can be reached', () => {
    let last = 0;
    for (const b of [6, 4, 3, 2, 1.5, 1, 0.7, 0.4]) {
      const fraction = headFraction(applyProportions(teddy, { headBody: b }).model);
      expect(fraction).toBeGreaterThan(last);
      last = fraction;
    }
    // far beyond the slider: the head scale stops at 5× and 0.2×, the height is still restored
    const huge = applyProportions(teddy, { headBody: 0.01 }).model;
    expect(headFraction(huge)).toBeGreaterThan(0.75);
    expect(headFraction(huge)).toBeLessThan(0.99);
    expect(modelHeight(huge)).toBeCloseTo(H, 4);
    const tiny = applyProportions(teddy, { headBody: 500 }).model;
    expect(headFraction(tiny)).toBeGreaterThan(0.002);
    expect(headFraction(tiny)).toBeLessThan(0.15);
    expect(modelHeight(tiny)).toBeCloseTo(H, 4);
  });

  it('works on the §3.6 bunny: a lathe body, flat ears, a head set back by 0.1 in', () => {
    const bunny = readSpecExample();
    const h0 = modelHeight(bunny);
    const { model } = applyProportions(bunny, { headBody: 1 });
    expect(headFraction(model)).toBeCloseTo(0.5, 3);
    expect(modelHeight(model)).toBeCloseTo(h0, 4);
    expect(validateModel(model).ok).toBe(true);
    const m = by(model);
    for (const id of ['ear_l', 'ear_r']) expect(surfaceGap(m[id], m.head), id).toBeLessThanOrEqual(0.1);
    expect(m.ear_r.position).toEqual([-m.ear_l.position[0], m.ear_l.position[1], m.ear_l.position[2]]);
    // the body is a lathe: it was scaled about the ground, so its base is still at y = 0
    expect(m.body.position).toEqual([0, 0, 0]);
    // features (sizes) follow the rescale; directions do not change
    expect(model.features?.[0].azimuthDeg).toBe(30);
    expect(model.features?.[0].sizeMm).toBeLessThan(9);
  });

  it('a lathe head is scaled about its center, not its base', () => {
    const m = modelOf([
      part('sphere', { r: 2 }, { id: 'body', position: [0, 2, 0] }),
      part('lathe', { profile: [[0, 0], [1.2, 0.8], [1, 1.8], [0, 2.4]] }, { id: 'head', position: [0, 3.8, 0], attach: { to: 'body' } }),
      part('sphere', { r: 0.3 }, { id: 'pom', position: [0, 6.4, 0], attach: { to: 'head' } }),
    ]);
    const h0 = modelHeight(m);
    const { model } = applyProportions(m, { headBody: 1 });
    expect(headFraction(model)).toBeCloseTo(0.5, 3);
    expect(modelHeight(model)).toBeCloseTo(h0, 4);
    const a = by(model);
    // the head still starts 0.2 in below the top of the body (scaled), and the pom is still on its tip
    const f = (a.body.dims as { r: number }).r / 2;
    expect(a.body.position[1] + (a.body.dims as { r: number }).r - a.head.position[1]).toBeCloseTo(0.2 * f, 3);
    expect(surfaceGap(a.pom, a.head)).toBeLessThan(0);
    expect(surfaceGap(a.pom, a.head)).toBeGreaterThan(-0.35);
  });

  it('a mesh head is scaled in its buffer; the buffers come back when they are passed', () => {
    const raw = uvEllipsoid(1, 0.8, 0.9, 16, 12);
    const meshes = { 'head-mesh': meshFromJson(raw) };
    const m = modelOf([
      part('sphere', { r: 1.5 }, { id: 'body', position: [0, 1.5, 0] }),
      part('mesh', { meshRef: 'head-mesh', bboxIn: [2, 1.6, 1.8] }, { id: 'head', position: [0, 3.7, 0], attach: { to: 'body' } }),
      part('sphere', { r: 0.25 }, { id: 'ear_l', position: [0.7, 4.4, 0], attach: { to: 'head' } }),
      part('sphere', { r: 0.25 }, { id: 'ear_r', position: [-0.7, 4.4, 0], attach: { to: 'head' }, mirrorOf: 'ear_l' }),
    ]);
    const h0 = modelHeight(m, meshes);
    const snapshot = Array.from(meshes['head-mesh'].positions);
    const result = applyProportions(m, { headBody: 1 }, meshes);
    const out = result.meshes as Record<string, ColoredMesh>;
    expect(Object.keys(out)).toEqual(['head-mesh']);
    expect(Array.from(meshes['head-mesh'].positions)).toEqual(snapshot); // the input buffers are not modified
    const head = by(result.model).head as Extract<Part, { type: 'mesh' }>;
    // the returned buffer is the scaled head, and it still fits the part's bboxIn
    const size = boundsSize(localBounds(head, out['head-mesh']));
    for (let i = 0; i < 3; i++) expect(size[i]).toBeCloseTo(head.dims.bboxIn[i], 4);
    expect(head.dims.bboxIn[1] / 1.6).toBeCloseTo(head.dims.bboxIn[0] / 2, 5); // uniformly
    expect(heightOf(head, out['head-mesh']) / modelHeight(result.model, out)).toBeCloseTo(0.5, 3);
    expect(modelHeight(result.model, out)).toBeCloseTo(h0, 4);
    const a = by(result.model);
    expect(a.ear_r.position).toEqual([-a.ear_l.position[0], a.ear_l.position[1], a.ear_l.position[2]]);
    expect(a.ear_l.position[1]).toBeGreaterThan(a.head.position[1]);
    // without buffers the head is its inscribed ellipsoid: the same edit, and no meshes in the result
    const plain = applyProportions(m, { headBody: 1 });
    expect(plain).not.toHaveProperty('meshes');
    expect(headFraction(plain.model)).toBeCloseTo(0.5, 3);
  });

  it('is ignored when the control is disabled, and for a value that is not a positive number', () => {
    const noHead = { ...teddy, parts: teddy.parts.filter((p) => !subtreeIds(teddy, 'head').includes(p.id)) };
    expect(applyProportions(noHead, { headBody: 1 }).model).toBe(noHead);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(applyProportions(teddy, { headBody: bad }).model).toBe(teddy);
    expect(applyProportions(teddy, {}).model).toBe(teddy);
    expect(applyProportions(teddy, {}, {})).toEqual({ model: teddy, meshes: {} });
  });
});

describe('applyProportions: limb length (§4.2, G23)', () => {
  it('G23: limbs "long" ⇒ arm length = 0.55·H (± 1%), legs 0.44·H; the finished height unchanged', () => {
    const { model } = applyProportions(teddy, { limbs: 'long' });
    const m = by(model);
    const height = modelHeight(model);
    expect(Math.abs(height / H - 1)).toBeLessThan(0.001);
    for (const id of ['arm_l', 'arm_r']) expect(Math.abs(limbLength(m[id]) / (0.55 * height) - 1), id).toBeLessThan(0.01);
    for (const id of ['leg_l', 'leg_r']) expect(Math.abs(limbLength(m[id]) / (0.44 * height) - 1), id).toBeLessThan(0.01);
    expect(readProportions(model).limbs).toBe('long');
    expect(validateModel(model).ok).toBe(true);
    expect(isOneTree(model)).toBe(true);
  });

  it('G23: each arm’s proximal pole moved < 0.01 in before the rescale', () => {
    // On the teddy the limbs do not change the height, so the lengths before the rescale are the final ones.
    const lengths = { arm_l: 0.55 * H, arm_r: 0.55 * H, leg_l: 0.44 * H, leg_r: 0.44 * H };
    const before = by(teddy);
    const resized = by(resizeLimbs(teddy, lengths));
    for (const [id, parent] of [['arm_l', 'body'], ['arm_r', 'body'], ['leg_l', 'body'], ['leg_r', 'body']]) {
      // the proximal end: the pole with the larger parent SDF (inside or nearest the parent)
      const f = partSdf(before[parent]);
      const [plus, minus] = poles(before[id]);
      const proximalIsPlus = f(plus) > f(minus);
      const was = proximalIsPlus ? plus : minus;
      const now = poles(resized[id])[proximalIsPlus ? 0 : 1];
      expect(dist(was, now), `${id} proximal pole`).toBeLessThan(0.01);
      expect(dist(was, now), `${id} proximal pole`).toBeLessThan(1e-5);
      // the distal end moved by the whole length change, along the limb's axis
      const distalWas = proximalIsPlus ? minus : plus;
      const distalNow = poles(resized[id])[proximalIsPlus ? 1 : 0];
      expect(dist(distalWas, distalNow)).toBeCloseTo(lengths[id as keyof typeof lengths] - limbLength(before[id]), 4);
      expect(limbLength(resized[id])).toBeCloseTo(lengths[id as keyof typeof lengths], 5);
      expect(resized[id].rotationDeg).toEqual(before[id].rotationDeg);
    }
    // the arms hang from the shoulder: their upper pole is the proximal one; the legs grow from the hip, forward
    expect(partSdf(before.body)(poles(before.arm_l)[0])).toBeGreaterThan(partSdf(before.body)(poles(before.arm_l)[1]));
    expect(resized.arm_l.position[1]).toBeLessThan(before.arm_l.position[1]);
    expect(resized.leg_l.position[2]).toBeGreaterThan(before.leg_l.position[2]);
    // … and the final model is that edit, rescaled (here by 1) — the same lengths, the same places
    const final = by(applyProportions(teddy, { limbs: 'long' }).model);
    for (const id of ['arm_l', 'leg_l']) {
      expect(limbLength(final[id])).toBeCloseTo(limbLength(resized[id]), 2);
      for (let i = 0; i < 3; i++) expect(final[id].position[i]).toBeCloseTo(resized[id].position[i], 2);
    }
  });

  it('G23: arm_r is the mirror of arm_l; the attach anchors are kept (the foot pads stay on the leg ends)', () => {
    for (const limbs of ['nubs', 'short', 'medium', 'long'] as const) {
      const { model } = applyProportions(teddy, { limbs });
      const m = by(model);
      const b = by(teddy);
      for (const [l, r] of [['arm_l', 'arm_r'], ['leg_l', 'leg_r'], ['foot_pad_l', 'foot_pad_r']]) {
        expect(m[r].position, `${limbs} ${r}`).toEqual([-m[l].position[0], m[l].position[1], m[l].position[2]]);
        expect(m[r].dims).toEqual(m[l].dims);
        expect(m[r].rotationDeg).toEqual(b[r].rotationDeg);
      }
      // the pad is still on the foot end of its leg, as deep as before
      for (const side of ['l', 'r']) {
        const gap = surfaceGap(m[`foot_pad_${side}`], m[`leg_${side}`]);
        expect(gap).toBeCloseTo(surfaceGap(b[`foot_pad_${side}`], b[`leg_${side}`]), 3);
        const before = captureAnchor(b[`leg_${side}`], b[`foot_pad_${side}`]);
        const now = captureAnchor(m[`leg_${side}`], m[`foot_pad_${side}`]);
        expect(Math.abs(now.elevationDeg - before.elevationDeg)).toBeLessThan(1);
        expect(now.offsetIn).toBeCloseTo(before.offsetIn, 2);
      }
      // nothing else moved: body, head and everything on the head
      for (const id of ['body', 'tail', ...subtreeIds(teddy, 'head')]) expect(m[id]).toEqual(b[id]);
    }
  });

  it('every chip: limb length / model height = factor × template (quadruped: arms 0.25, legs 0.20)', () => {
    for (const [chip, factor] of Object.entries(LIMB_FACTORS) as ['nubs' | 'short' | 'medium' | 'long', number][]) {
      const { model } = applyProportions(teddy, { limbs: chip });
      const m = by(model);
      const height = modelHeight(model);
      expect(height).toBeCloseTo(H, 4);
      expect(limbLength(m.arm_l) / height).toBeCloseTo(factor * 0.25, 3);
      // a capsule cannot be shorter than its two caps: "nubs" legs (0.12·H = 1.19 in) stop at 2·r = 1.5 in
      const leg = Math.max(factor * 0.2, (2 * 0.75) / H);
      expect(limbLength(m.leg_l) / height).toBeCloseTo(leg, 3);
      expect(readProportions(model).limbs).toBe(chip);
      expect(validateModel(model).ok).toBe(true);
    }
  });

  it('uses the model’s template row, and resizes cylinders and limb<n>_* too', () => {
    const doll = modelOf(
      [
        part('sphere', { r: 1.5 }, { id: 'body', position: [0, 4.5, 0] }),
        part('capsule', { r: 0.3, length: 2 }, { id: 'arm_l', position: [1.9, 4.6, 0], rotationDeg: [0, 0, 60], attach: { to: 'body' } }),
        part('capsule', { r: 0.3, length: 2 }, { id: 'arm_r', position: [-1.9, 4.6, 0], rotationDeg: [0, 0, -60], attach: { to: 'body' }, mirrorOf: 'arm_l' }),
        part('cylinder', { rTop: 0.4, rBottom: 0.4, h: 3.2 }, { id: 'leg_l', position: [0.6, 1.6, 0], attach: { to: 'body' } }),
        part('cylinder', { rTop: 0.4, rBottom: 0.4, h: 3.2 }, { id: 'leg_r', position: [-0.6, 1.6, 0], attach: { to: 'body' }, mirrorOf: 'leg_l' }),
        part('sphere', { r: 0.45 }, { id: 'shoe_l', position: [0.6, 0.3, 0.2], attach: { to: 'leg_l' } }),
        part('capsule', { r: 0.15, length: 1 }, { id: 'limb2_l', position: [0, 6.3, 0], attach: { to: 'body' } }),
      ],
      { category: 'biped', pose: 'standing' },
    );
    const h0 = modelHeight(doll);
    const { model } = applyProportions(doll, { limbs: 'short' });
    const m = by(model);
    const height = modelHeight(model);
    expect(height).toBeCloseTo(h0, 4); // the legs carry the model: shortening them changed the height, the rescale restored it
    expect(limbLength(m.arm_l) / height).toBeCloseTo(0.3, 3);
    expect(limbLength(m.leg_l) / height).toBeCloseTo(0.3, 3);
    expect(limbLength(m.limb2_l) / height).toBeCloseTo(0.3, 3); // limb<n> uses the arm template
    expect(modelBounds(model).min[1]).toBeCloseTo(modelBounds(doll).min[1], 5); // the lowest point (the shoe) is where it was
    // the legs kept their hip end: their top is still inside the body, and the shoe is still on the foot end
    expect(partSdf(m.body)(poles(m.leg_l)[0])).toBeGreaterThan(0);
    expect(surfaceGap(m.shoe_l, m.leg_l)).toBeLessThan(0);
    expect(m.leg_r.position).toEqual([-m.leg_l.position[0], m.leg_l.position[1], m.leg_l.position[2]]);
    expect(validateModel(model).ok).toBe(true);
    // a standing quadruped: arms (its front legs) and legs both 0.30
    const quad = applyProportions({ ...doll, category: 'quadruped' }, { limbs: 'short' }).model;
    expect(limbLength(by(quad).leg_l) / modelHeight(quad)).toBeCloseTo(0.3, 3);
    const sitting = applyProportions({ ...doll, category: 'quadruped', pose: 'sitting' }, { limbs: 'short' }).model;
    expect(limbLength(by(sitting).leg_l) / modelHeight(sitting)).toBeCloseTo(0.2, 3);
    expect(limbLength(by(sitting).arm_l) / modelHeight(sitting)).toBeCloseTo(0.25, 3);
  });

  it('is ignored when the control is disabled', () => {
    const meshArm = {
      ...teddy,
      parts: teddy.parts.map((p): Part => (p.id === 'arm_l' ? { ...p, type: 'mesh', dims: { meshRef: 'arm-mesh', bboxIn: [1.1, 3, 1.1] } } : p)),
    };
    expect(applyProportions(meshArm, { limbs: 'long' }).model).toBe(meshArm);
    const noLimbs = { ...teddy, parts: teddy.parts.filter((p) => !/^(arm|leg|foot)/.test(p.id)) };
    expect(applyProportions(noLimbs, { limbs: 'long' }).model).toBe(noLimbs);
    expect(applyProportions(teddy, { limbs: 'huge' as 'long' }).model).toBe(teddy);
  });
});

describe('applyProportions: both controls, and housekeeping', () => {
  it('head and limbs together: both ratios hold after one call, the height is unchanged and the model stays grounded', () => {
    const { model } = applyProportions(teddy, { headBody: 1, limbs: 'long' });
    const m = by(model);
    const height = modelHeight(model);
    expect(height).toBeCloseTo(H, 4);
    expect(headFraction(model)).toBeCloseTo(0.5, 3);
    expect(limbLength(m.arm_l) / height).toBeCloseTo(0.55, 3);
    expect(limbLength(m.leg_l) / height).toBeCloseTo(0.44, 3);
    expect(readProportions(model)).toEqual({ headBody: expect.closeTo(1, 2), limbs: 'long', disabled: {} });
    // with this big a head the long arms reach below the feet: the model is put back on the ground
    expect(Math.abs(modelBounds(model).min[1])).toBeLessThan(2e-6);
    expect(worldBounds(m.arm_l).min[1]).toBeLessThan(worldBounds(m.leg_l).min[1]);
    expect(validateModel(model).ok).toBe(true);
    expect(m.arm_r.position).toEqual([-m.arm_l.position[0], m.arm_l.position[1], m.arm_l.position[2]]);
  });

  it('does not modify its input, is deterministic, and rounds coordinates to 1e-6', () => {
    const snapshot = JSON.stringify(teddy);
    const a = applyProportions(teddy, { headBody: 1.7, limbs: 'medium' });
    expect(JSON.stringify(teddy)).toBe(snapshot);
    expect(applyProportions(teddy, { headBody: 1.7, limbs: 'medium' })).toEqual(a);
    for (const p of a.model.parts) {
      for (const v of p.position) expect(Math.abs(v * 1e6 - Math.round(v * 1e6))).toBeLessThan(1e-6);
    }
    expect(JSON.stringify(a.model)).not.toMatch(/-0[,\]]/);
    // applying the same proportions again changes (almost) nothing
    const again = applyProportions(a.model, { headBody: 1.7, limbs: 'medium' }).model;
    again.parts.forEach((p, i) => {
      for (let k = 0; k < 3; k++) expect(p.position[k]).toBeCloseTo(a.model.parts[i].position[k], 2);
    });
  });

  it('an ungrounded model keeps its lowest point where it is', () => {
    const lifted = { ...teddy, parts: teddy.parts.map((p) => ({ ...p, position: [p.position[0], p.position[1] + 5, p.position[2]] as Vec3 })) };
    const { model } = applyProportions(lifted, { headBody: 1, limbs: 'long' });
    expect(modelBounds(model).min[1]).toBeCloseTo(5, 5);
    expect(modelHeight(model)).toBeCloseTo(H, 4);
  });

  it('equals the edit followed by scaleModel: nothing else happens to the model', () => {
    // limbs on the teddy do not change the height, so the result is resizeLimbs alone
    const lengths = { arm_l: 0.375 * H, arm_r: 0.375 * H, leg_l: 0.3 * H, leg_r: 0.3 * H };
    const manual = scaleModel(resizeLimbs(teddy, lengths), 1).model;
    const kernel = applyProportions(teddy, { limbs: 'medium' }).model;
    kernel.parts.forEach((p, i) => {
      for (let k = 0; k < 3; k++) expect(p.position[k]).toBeCloseTo(manual.parts[i].position[k], 2);
    });
    expect(kernel.finishedSize).toEqual(teddy.finishedSize);
    expect(kernel.palette).toBe(teddy.palette);
    expect(kernel.revision).toBe(teddy.revision); // revisions are the caller's (commitModelRevision)
  });

  it('runs within the §5.8 budget: ≤ 200 ms on the teddy (bisection with re-anchoring)', { retry: 2 }, () => {
    applyProportions(teddy, { headBody: 1 }); // warm up
    applyProportions(teddy, { limbs: 'long' });
    for (const o of [{ headBody: 1 }, { headBody: 3 }, { limbs: 'long' as const }, { headBody: 1, limbs: 'long' as const }]) {
      const t0 = performance.now();
      applyProportions(teddy, o);
      expect(performance.now() - t0, JSON.stringify(o)).toBeLessThan(200);
    }
  });
});
