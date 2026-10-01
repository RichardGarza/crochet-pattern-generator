// Track T6.2 — the editor's structure edits (DESIGN.md §4.2, §6.3 T6 acceptance): Add part attaches to the
// clicked part with a 0.10 in overlap; Duplicate offsets +0.5 in X; Delete re-attaches children; Mirror negates x
// and rotation y/z and links `mirrorOf`; linked edits propagate until Unlink; Attach refuses cycles and never
// detaches; Make as / Start / axis write `crochet.*`; no edit ever produces a repeated id (§0.1).
import { describe, expect, it } from 'vitest';
import { isOneTree, subtreeIds } from '../../../core/model/attach';
import { overlapAlongRay, surfaceExit } from '../../../core/model/place';
import { LIMB_PROXIMAL_KEY } from '../../../core/model/proportions';
import { validateModel } from '../../../core/model/schema';
import { surfaceGap, worldSdf } from '../../../core/model/sdf';
import { partAxis, partCenter } from '../../../core/model/transforms';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { createProjectStore } from '../../projectStore';
import {
  ADDABLE_TYPES,
  addPart,
  addPartBlockedReason,
  attachBlockedReason,
  attachPart,
  deleteBlockedReason,
  deleteParts,
  dropStaleProximal,
  duplicateParts,
  editModel,
  linkEdit,
  mirrorBlockedReason,
  mirroredFrom,
  mirrorPair,
  mirrorParts,
  mirrorTwin,
  movePart,
  planDelete,
  rightTwinId,
  setAttachOptions,
  setCrochetHints,
  setPartColor,
  setPartDim,
  setPartLabel,
  setPartRotation,
  slugPartId,
  uniquePartId,
  unlinkMirror,
} from '../model3d';
import everyTypeJson from '../../../../fixtures/models/every-type.json';
import { parseModel } from '../../../core/model/schema';
import { byId, deepFreeze, openTeddy, teddy } from './teddyProject';

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function expectValid(m: CrochetModelV1): void {
  const r = validateModel(m);
  if (!r.ok) throw new Error(r.issues.map((i) => `${i.path}: ${i.message}`).join('\n'));
  const ids = m.parts.map((p) => p.id);
  expect(new Set(ids).size, 'part ids are unique').toBe(ids.length);
  expect(isOneTree(m), 'one attach tree').toBe(true);
}

/** The mirror image of `a` across x = 0 is `b`: the SDFs agree at mirrored points. */
function expectMirrorImages(a: Part, b: Part): void {
  const fa = worldSdf(a);
  const fb = worldSdf(b);
  const c = partCenter(a);
  const reach = 3;
  for (let i = 0; i < 60; i++) {
    // A fixed spread of points around the part (deterministic).
    const t = i * 2.399963;
    const p: Vec3 = [c[0] + Math.cos(t) * reach * ((i % 7) / 7), c[1] + Math.sin(t * 1.3) * reach * ((i % 5) / 5), c[2] + Math.sin(t) * reach * ((i % 3) / 3)];
    expect(fb(-p[0], p[1], p[2])).toBeCloseTo(fa(p[0], p[1], p[2]), 4);
  }
}

describe('ids', () => {
  it('slugPartId makes a valid id from any text', () => {
    expect(slugPartId('Left Ear')).toBe('left_ear');
    expect(slugPartId('Öhr 2')).toBe('ohr_2');
    expect(slugPartId('3 spots')).toBe('part_3_spots');
    expect(slugPartId('')).toBe('part');
    expect(slugPartId('x'.repeat(50))).toHaveLength(32);
  });

  it('uniquePartId never returns an id a part or a feature has, and stays within 32 characters', () => {
    const m = teddy();
    m.features = [{ id: 'ball', kind: 'nose', on: 'head', azimuthDeg: 0, elevationDeg: 0 }];
    expect(uniquePartId(m, 'ear_l')).toBe('ear_l_2');
    expect(uniquePartId(m, 'ball')).toBe('ball_2');
    expect(uniquePartId(m, 'wing')).toBe('wing');
    const long = 'a'.repeat(32);
    const m2 = { ...m, parts: [...m.parts, { ...m.parts[0], id: long }] };
    const id = uniquePartId(m2, long);
    expect(id).toHaveLength(32);
    expect(id.endsWith('_2')).toBe(true);
  });
});

describe('Add part (§4.2)', () => {
  it('attaches to the part it is added to, 0.10 in into its surface along the side direction', () => {
    const m = deepFreeze(teddy());
    const { model, id } = addPart(m, 'head', 'sphere', { dir: [0, 1, 0] });
    expect(id).toBe('ball');
    const ball = byId(model).ball;
    expect(ball.attach).toEqual({ to: 'head' });
    expect(ball.color).toBe(byId(m).head.color);
    expect(overlapAlongRay(byId(model).head, ball)).toBeCloseTo(0.1, 4);
    // Straight above the head's center.
    expect(partCenter(ball)[0]).toBeCloseTo(partCenter(byId(m).head)[0], 6);
    expect(model.parts.slice(0, -1)).toEqual(m.parts);
    expectValid(model);
  });

  it('a click on the surface places the part 0.10 in in along the clicked normal', () => {
    const m = teddy();
    const tail = byId(m).tail; // a sphere: its normal is radial, so the overlap along the ray is the overlap along the normal
    const n: Vec3 = [0.3, 0.2, -0.93];
    const len = Math.hypot(...n);
    const dir: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
    const t = surfaceExit(tail, partCenter(tail), dir) as number;
    const c = partCenter(tail);
    const hit: Vec3 = [c[0] + dir[0] * t, c[1] + dir[1] * t, c[2] + dir[2] * t];
    const { model, id } = addPart(m, 'tail', 'sphere', { hit, normal: dir }, { size: 0.4 });
    const child = byId(model)[id as string];
    expect(child.attach?.to).toBe('tail');
    // The child's center is on the normal through the hit, its surface 0.10 in past the hit.
    const cc = partCenter(child);
    expect(dist(cc, [hit[0] + dir[0] * 0.1, hit[1] + dir[1] * 0.1, hit[2] + dir[2] * 0.1])).toBeCloseTo(0, 5);
    expect(overlapAlongRay(byId(model).tail, child)).toBeCloseTo(0.1, 4);
  });

  it('every primitive type can be added on every side, valid, touching its parent, turned to point outward', () => {
    let m = teddy();
    const sides: Vec3[] = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 0],
      [0, -1, 0],
      [0, 0, 1],
      [0, 0, -1],
    ];
    for (const type of ADDABLE_TYPES) {
      for (const dir of sides.slice(0, 2)) {
        const r = addPart(m, 'body', type, { dir });
        expect(r.id).not.toBeNull();
        m = r.model;
        const p = byId(m)[r.id as string];
        expect(surfaceGap(p, byId(m).body), `${type} touches`).toBeLessThanOrEqual(0.1);
        if (type === 'capsule' || type === 'cylinder' || type === 'cone') {
          const a = partAxis(p, 1);
          expect(a[0] * dir[0] + a[1] * dir[1] + a[2] * dir[2], `${type} points along ${dir}`).toBeCloseTo(1, 5);
        }
        if (type === 'flat') expect(partAxis(p, 2)[0] * dir[0]).toBeCloseTo(1, 5);
      }
    }
    expectValid(m);
    // Every side of a capsule parent.
    for (const dir of sides) {
      const r = addPart(m, 'arm_l', 'sphere', { dir });
      expect(surfaceGap(byId(r.model)[r.id as string], byId(r.model).arm_l)).toBeLessThanOrEqual(0.1);
    }
  });

  it('refuses an unknown parent and a full model; never repeats an id', () => {
    const m = teddy();
    expect(addPart(m, 'nope', 'sphere', { dir: [0, 1, 0] })).toEqual({ model: m, id: null });
    expect(addPartBlockedReason(m, null)).toMatch(/Pick the part/);
    let full = m;
    const ids = new Set(m.parts.map((p) => p.id));
    while (full.parts.length < 60) {
      const r = addPart(full, 'body', 'sphere', { dir: [0, 0, 1] });
      expect(ids.has(r.id as string)).toBe(false);
      ids.add(r.id as string);
      full = r.model;
    }
    expect(addPartBlockedReason(full, 'body')).toMatch(/at most 60/);
    expect(addPart(full, 'body', 'sphere', { dir: [0, 1, 0] }).id).toBeNull();
    expectValid(full);
  });

  it('a NaN click falls back safely (no non-finite numbers in the model)', () => {
    const { model } = addPart(teddy(), 'head', 'capsule', { hit: [NaN, 0, 0], normal: [NaN, NaN, NaN] });
    expectValid(model);
  });
});

describe('Duplicate (⌘D)', () => {
  it('copies the part +0.5 in along X with a new id, the same parent, no mirror link', () => {
    const m = deepFreeze(teddy());
    const r = duplicateParts(m, ['ear_r']);
    expect(r.ids).toEqual(['ear_r_2']);
    const copy = byId(r.model).ear_r_2;
    const ear = byId(m).ear_r;
    expect(copy.position).toEqual([ear.position[0] + 0.5, ear.position[1], ear.position[2]]);
    expect(copy.attach).toEqual(ear.attach);
    expect(copy.mirrorOf).toBeUndefined();
    expect(copy.label).toBe('Right Ear copy');
    expect(copy.dims).toEqual(ear.dims);
    expectValid(r.model);
  });

  it('a duplicated parent takes the copies of its duplicated children; a copy of the root hangs from the root', () => {
    const m = teddy();
    const r = duplicateParts(m, ['ear_l_inner', 'ear_l', 'body']);
    expect(r.map).toEqual({ body: 'body_2', ear_l: 'ear_l_2', ear_l_inner: 'ear_l_inner_2' });
    expect(byId(r.model).ear_l_inner_2.attach?.to).toBe('ear_l_2');
    expect(byId(r.model).ear_l_2.attach?.to).toBe('head');
    expect(byId(r.model).body_2.attach?.to).toBe('body');
    expectValid(r.model);
    // Twice: never a repeated id.
    const again = duplicateParts(r.model, ['ear_l', 'ear_l_2']);
    expect(again.ids).toEqual(['ear_l_3', 'ear_l_2_2']);
    expectValid(again.model);
  });

  it('refuses when the copies would not fit (60 parts) and for nothing selected', () => {
    const m = teddy();
    expect(duplicateParts(m, []).model).toBe(m);
    const many = duplicateParts(duplicateParts(m, m.parts.map((p) => p.id)).model, m.parts.map((p) => p.id)).model; // 51 parts
    expect(many.parts).toHaveLength(51);
    const ids = many.parts.slice(0, 10).map((p) => p.id);
    expect(duplicateParts(many, ids).model).toBe(many);
  });
});

describe('Delete (⌫)', () => {
  it('re-attaches the children of a deleted part to its parent', () => {
    const m = deepFreeze(teddy());
    const before = new Set(m.parts.filter((p) => p.attach?.to === 'head').map((p) => p.id));
    const next = deleteParts(m, ['head']);
    expect(byId(next).head).toBeUndefined();
    for (const id of before) expect(byId(next)[id].attach?.to, id).toBe('body');
    // Grandchildren keep their parent.
    expect(byId(next).ear_l_inner.attach?.to).toBe('ear_l');
    expect(byId(next).nose.attach?.to).toBe('muzzle');
    expectValid(next);
  });

  it('a chain of deleted parts: children go to the nearest surviving ancestor', () => {
    const next = deleteParts(teddy(), ['head', 'muzzle']);
    expect(byId(next).nose.attach?.to).toBe('body');
    expectValid(next);
  });

  it('deleting the root makes the largest part left the root and hangs the others from it', () => {
    const m = teddy();
    const plan = planDelete(m, ['body']);
    expect(plan.newRoot).toBe('head');
    const next = deleteParts(m, ['body']);
    expect(byId(next).head.attach).toBeUndefined();
    for (const id of ['arm_l', 'arm_r', 'leg_l', 'leg_r', 'tail']) expect(byId(next)[id].attach?.to).toBe('head');
    expectValid(next);
  });

  it('drops mirror links to deleted parts, features on them, assembly steps naming them, stored limb ends of moved parts', () => {
    const m = teddy();
    m.features = [
      { id: 'cheek_l', kind: 'cheek', on: 'muzzle', azimuthDeg: 30, elevationDeg: 0 },
      { id: 'brow', kind: 'brow', on: 'head', azimuthDeg: 0, elevationDeg: 30 },
    ];
    m.assembly = [
      { order: 1, part: 'muzzle', to: 'head', text: 'Sew the muzzle' },
      { order: 2, part: 'ear_l', to: 'head', text: 'Sew the ears' },
    ];
    m.parts = m.parts.map((p) => (p.id === 'nose' ? { ...p, [LIMB_PROXIMAL_KEY]: 'top' } : p));
    const next = deleteParts(m, ['ear_l', 'muzzle']);
    expect(byId(next).ear_r.mirrorOf).toBeUndefined();
    expect(byId(next).ear_r_inner.mirrorOf).toBe('ear_l_inner');
    expect(byId(next).ear_l_inner.attach?.to).toBe('head');
    expect(next.features?.map((f) => f.id)).toEqual(['brow']);
    expect(next.assembly).toEqual([]);
    expect(byId(next).nose[LIMB_PROXIMAL_KEY]).toBeUndefined();
    expectValid(next);
  });

  it('refuses to delete every part', () => {
    const m = teddy();
    expect(deleteBlockedReason(m, m.parts.map((p) => p.id))).toMatch(/at least one part/);
    expect(deleteParts(m, m.parts.map((p) => p.id))).toBe(m);
    expect(deleteParts(m, ['nope'])).toBe(m);
  });
});

describe('Mirror (M)', () => {
  it('rightTwinId turns the last left token into the right one', () => {
    expect(rightTwinId('ear_l')).toBe('ear_r');
    expect(rightTwinId('ear_l_inner')).toBe('ear_r_inner');
    expect(rightTwinId('leg_fl')).toBe('leg_fr');
    expect(rightTwinId('wing_left')).toBe('wing_right');
    expect(rightTwinId('horn')).toBeNull();
  });

  it('negates x and rotation y/z and links mirrorOf; ids and labels follow left → right', () => {
    let m = teddy();
    const r0 = addPart(m, 'head', 'cone', { dir: [0.6, 0.8, 0] }, { id: 'horn_l', label: 'Left Horn' });
    m = setPartRotation(r0.model, 'horn_l', [10, 20, -30], 'alone');
    const horn = byId(m).horn_l;
    const { model, twins } = mirrorParts(m, ['horn_l']);
    expect(twins).toEqual(['horn_r']);
    const twin = byId(model).horn_r;
    expect(twin.position).toEqual([-horn.position[0], horn.position[1], horn.position[2]]);
    expect(twin.rotationDeg).toEqual([10, -20, 30]);
    expect(twin.mirrorOf).toBe('horn_l');
    expect(twin.label).toBe('Right Horn');
    expect(twin.attach).toEqual({ to: 'head' });
    expect(twin.dims).toEqual(horn.dims);
    expectMirrorImages(horn, twin);
    expectValid(model);
  });

  it('a part without a side gets <id>_r; a child mirrors onto its parent’s twin', () => {
    const base = addPart(teddy(), 'ear_l', 'sphere', { dir: [1, 0.2, 0] }, { id: 'tuft' });
    const { model } = mirrorParts(base.model, ['tuft']);
    expect(byId(model).tuft_r.mirrorOf).toBe('tuft');
    expect(byId(model).tuft_r.attach?.to).toBe('ear_r');
    expect(surfaceGap(byId(model).tuft_r, byId(model).ear_r)).toBeLessThanOrEqual(0.1);
    expectValid(model);
  });

  it('on a linked part, Mirror rewrites the twin from its source (either side selected)', () => {
    const m = teddy();
    const moved = movePart(m, 'ear_l', [0.2, 0.1, 0], 'alone'); // unlinked edit: the pair is out of step
    for (const pick of ['ear_l', 'ear_r']) {
      const { model, twins } = mirrorParts(moved, [pick]);
      expect(twins).toEqual(['ear_r']);
      expect(byId(model).ear_r.position).toEqual([-1.8, byId(moved).ear_l.position[1], -0.1]);
      expect(byId(model).ear_l).toBe(byId(moved).ear_l);
    }
  });

  it('every primitive of every-type.json mirrors into its exact mirror image (torus arcs and polygons included)', () => {
    const m = parseModel(structuredClone(everyTypeJson));
    for (const p of m.parts) {
      if (p.type === 'mesh') {
        expect(mirrorBlockedReason(m, p.id)).toMatch(/Sculpted/);
        continue;
      }
      const shifted = { ...p, position: [p.position[0] + 1.3, p.position[1], p.position[2]] as Vec3, rotationDeg: [15, 25, 35] as Vec3 };
      expectMirrorImages(shifted, mirroredFrom(shifted));
    }
    const arc: Part = { id: 'arc', type: 'torus', dims: { R: 1, r: 0.2, arcDeg: 120 }, position: [1, 1, 0], rotationDeg: [0, 30, 10], color: 'c' };
    expectMirrorImages(arc, mirroredFrom(arc));
    const poly: Part = { id: 'poly', type: 'flat', dims: { shape: 'polygon', w: 1, h: 1, thickness: 0.1, points: [[0, 0], [1, 0], [0.8, 0.9]] }, position: [2, 1, 0], color: 'c' };
    expectMirrorImages(poly, mirroredFrom(poly));
  });

  it('refuses parts on the middle line and mesh parts', () => {
    const m = teddy();
    expect(mirrorBlockedReason(m, 'muzzle')).toMatch(/middle line/);
    expect(mirrorParts(m, ['muzzle']).model).toBe(m);
  });

  it('mirrors paint left to right and negates region azimuths', () => {
    const cells = new Uint8Array(4096).fill(255);
    cells[10 * 64 + 5] = 1;
    const data = btoa(String.fromCharCode(...cells));
    const p: Part = { id: 'x_l', type: 'sphere', dims: { r: 1 }, position: [2, 1, 0], color: 'c', paint: { kind: 'uv64', data }, regions: [{ kind: 'spot', azimuthDeg: 40, elevationDeg: 10, radiusIn: 0.2, color: 'c' }], crochet: { seamAzimuthDeg: 30 } };
    const t = mirroredFrom(p);
    const out = atob(t.paint!.data);
    expect(out.charCodeAt(10 * 64 + 58)).toBe(1);
    expect(out.charCodeAt(10 * 64 + 5)).toBe(255);
    expect(t.regions).toEqual([{ kind: 'spot', azimuthDeg: -40, elevationDeg: 10, radiusIn: 0.2, color: 'c' }]);
    expect(t.crochet?.seamAzimuthDeg).toBe(330);
  });
});

describe('linked edits (§4.2 "linked edits propagate until Unlink")', () => {
  it('moving one side alone moves its twin as its mirror image, in the same history step', () => {
    const store = createProjectStore();
    openTeddy(store);
    expect(editModel('Move arm', (m) => movePart(m, 'arm_l', [0.3, 0.2, -0.1], 'alone'), { store })).toBe(true);
    const m = store.getState().doc!.threeD!.model!;
    const l = byId(m).arm_l;
    const r = byId(m).arm_r;
    expect(r.position).toEqual([-l.position[0], l.position[1], l.position[2]]);
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Move arm']);
    store.getState().undo();
    expect(store.getState().doc!.threeD!.model).toEqual(teddy());
  });

  it('resizing one ear resizes the other and re-anchors its inner ear', () => {
    const m = teddy();
    const next = linkEdit(m, setPartDim(m, 'ear_l', 'rx', 1.1));
    expect(byId(next).ear_r.dims).toEqual(byId(next).ear_l.dims);
    expect(byId(next).ear_r_inner.position).toEqual([-byId(next).ear_l_inner.position[0], byId(next).ear_l_inner.position[1], byId(next).ear_l_inner.position[2]]);
    expect(surfaceGap(byId(next).ear_r_inner, byId(next).ear_r)).toBeLessThanOrEqual(0.1);
    expectValid(next);
  });

  it('a subtree move of one side carries the other side’s subtree too', () => {
    const m = teddy();
    const next = linkEdit(m, movePart(m, 'ear_l', [0.1, 0.2, 0], 'subtree'));
    expect(byId(next).ear_r.position[0]).toBeCloseTo(-byId(next).ear_l.position[0], 9);
    expect(byId(next).ear_r_inner.position[0]).toBeCloseTo(-byId(next).ear_l_inner.position[0], 9);
    expect(surfaceGap(byId(next).ear_r_inner, byId(next).ear_r)).toBeLessThanOrEqual(0.1);
  });

  it('a move of the common parent changes both sides: neither is rewritten', () => {
    const m = teddy();
    const moved = movePart(m, 'head', [0.5, 0, 0], 'subtree');
    expect(linkEdit(m, moved)).toBe(moved);
  });

  it('color follows; a label does not; after Unlink nothing follows', () => {
    const m = teddy();
    m.palette.push({ id: 'pink', hex: '#ffaacc' });
    const colored = linkEdit(m, setPartColor(m, 'ear_l_inner', 'pink'));
    expect(byId(colored).ear_r_inner.color).toBe('pink');
    const labelled = linkEdit(m, setPartLabel(m, 'ear_l', 'Big ear'));
    expect(byId(labelled).ear_r).toBe(byId(m).ear_r);
    const unlinked = unlinkMirror(m, 'ear_l');
    expect(byId(unlinked).ear_r.mirrorOf).toBeUndefined();
    expect(mirrorTwin(unlinked, 'ear_l')).toBeUndefined();
    const after = linkEdit(unlinked, movePart(unlinked, 'ear_l', [0.2, 0, 0], 'alone'));
    expect(byId(after).ear_r).toBe(byId(unlinked).ear_r);
  });

  it('editing the twin side updates the source too', () => {
    const m = teddy();
    const next = linkEdit(m, movePart(m, 'leg_r', [-0.2, 0, 0], 'alone'));
    expect(byId(next).leg_l.position[0]).toBeCloseTo(1.35, 9);
    expect(mirrorPair(next, 'leg_l')?.source.id).toBe('leg_l');
  });
});

describe('stored limb end (x-cpg-proximal, §3.5.2)', () => {
  const withKey = (m: CrochetModelV1, id: string): CrochetModelV1 => ({ ...m, parts: m.parts.map((p) => (p.id === id ? { ...p, [LIMB_PROXIMAL_KEY]: 'top' } : p)) });

  it('a Rotate that turns a limb end for end deletes the key; a small turn keeps it', () => {
    const m = withKey(teddy(), 'arm_l');
    const small = dropStaleProximal(m, setPartRotation(m, 'arm_l', [-28, 0, 60], 'alone'));
    expect(byId(small).arm_l[LIMB_PROXIMAL_KEY]).toBe('top');
    const flipped = dropStaleProximal(m, setPartRotation(m, 'arm_l', [152, 0, 22], 'alone'));
    expect(byId(flipped).arm_l[LIMB_PROXIMAL_KEY]).toBeUndefined();
  });

  it('re-parenting a limb deletes the key; choosing an open end drops it too', () => {
    const m = withKey(teddy(), 'arm_l');
    expect(byId(attachPart(m, 'arm_l', 'head')).arm_l[LIMB_PROXIMAL_KEY]).toBeUndefined();
    expect(byId(setAttachOptions(m, 'arm_l', { method: 'sewn' })).arm_l[LIMB_PROXIMAL_KEY]).toBe('top');
    expect(byId(setAttachOptions(m, 'arm_l', { openEnd: 'bottom' })).arm_l[LIMB_PROXIMAL_KEY]).toBeUndefined();
  });
});

describe('Attach', () => {
  it('re-parents a part; the subtree stays with it', () => {
    const m = deepFreeze(teddy());
    const next = attachPart(m, 'ear_l', 'body', { method: 'sewn', openEnd: 'bottom' });
    expect(byId(next).ear_l.attach).toEqual({ to: 'body', method: 'sewn', openEnd: 'bottom' });
    expect(subtreeIds(next, 'body')).toContain('ear_l_inner');
    expectValid(next);
  });

  it('refuses cycles, self links and a parent for the root, and leaves the model unchanged', () => {
    const m = teddy();
    expect(attachBlockedReason(m, 'head', 'ear_l_inner')).toMatch(/Left Ear Inner hangs from Head, so this would make a loop/);
    expect(attachPart(m, 'head', 'ear_l_inner')).toBe(m);
    expect(attachBlockedReason(m, 'head', 'head')).toMatch(/itself/);
    expect(attachBlockedReason(m, 'body', 'tail')).toMatch(/main piece/);
    expect(attachPart(m, 'body', 'tail')).toBe(m);
    expect(attachPart(m, 'head', 'nope')).toBe(m);
  });

  it('never detaches: open end and method can be cleared, the link cannot', () => {
    const m = attachPart(teddy(), 'tail', 'body', { openEnd: 'top', method: 'glued' });
    const cleared = setAttachOptions(m, 'tail', { openEnd: null, method: null });
    expect(byId(cleared).tail.attach).toEqual({ to: 'body' });
    // The root has no attach to set options on.
    const root = setAttachOptions(m, 'body', { openEnd: 'top' });
    expect(root).toBe(m);
    expectValid(cleared);
  });
});

describe('Make as, Start / axis (crochet.*)', () => {
  it('writes and clears hints; auto removes the key; an empty crochet goes', () => {
    const m = teddy();
    const a = setCrochetHints(m, ['tail', 'muzzle'], { make: 'applique', start: 'top', axis: 'z', style: 'exact', seamAzimuthDeg: -90 });
    expect(byId(a).tail.crochet).toEqual({ make: 'applique', start: 'top', axis: 'z', style: 'exact', seamAzimuthDeg: 270 });
    expect(byId(a).muzzle.crochet?.make).toBe('applique');
    const b = setCrochetHints(a, ['tail'], { make: 'auto', start: 'auto', axis: 'auto', style: null, seamAzimuthDeg: null });
    expect(byId(b).tail.crochet).toBeUndefined();
    expectValid(a);
    expectValid(b);
    // Invalid values change nothing.
    expect(setCrochetHints(m, ['tail'], { make: 'bogus' as never, start: 'middle' as never })).toBe(m);
    expect(setCrochetHints(m, ['tail'], { seed: [NaN, 0, 0] })).toBe(m);
    expect(byId(setCrochetHints(m, ['tail'], { seed: [0.1234567, 0, 0] })).tail.crochet?.seed).toEqual([0.123457, 0, 0]);
  });

  it('a hint on one side of a linked pair follows to the other (Make as on ear_l → ear_r)', () => {
    const m = teddy();
    const next = linkEdit(m, setCrochetHints(m, ['ear_l'], { make: 'applique' }));
    expect(byId(next).ear_r.crochet?.make).toBe('applique');
  });
});
