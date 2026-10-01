// Track T6.1 — the editor's pure model edits and their store actions (DESIGN.md §4.2, §4.4, §6.3 T6 acceptance).
import { describe, expect, it } from 'vitest';
import { subtreeIds } from '../../../core/model/attach';
import { captureAnchor } from '../../../core/model/place';
import { validateModel } from '../../../core/model/schema';
import { surfaceGap } from '../../../core/model/sdf';
import { eulerXYZToMat3, partCenter, partTransform, applyRigid } from '../../../core/model/transforms';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { createProjectStore } from '../../projectStore';
import {
  affectedIds,
  ancestorIds,
  beginModelGesture,
  beginResizeGesture,
  setPartDims,
  clampDim,
  editModel,
  gapIssues,
  modelRecipe,
  movePart,
  normalizeDims,
  partName,
  partTree,
  pivotOf,
  rotationAbout,
  scaleBlockedReason,
  scaledDims,
  scalePart,
  setPartColor,
  setPartDim,
  setPartLabel,
  setPartPosition,
  setPartRotation,
  transformByPivot,
  transformPart,
  visibleRows,
  withRevision,
} from '../model3d';
import everyTypeJson from '../../../../fixtures/models/every-type.json';
import { parseModel } from '../../../core/model/schema';
import { byId, deepFreeze, openTeddy, teddy } from './teddyProject';

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function sphere(id: string, r: number, position: Vec3, extra: Partial<Part> = {}): Part {
  return { id, type: 'sphere', dims: { r }, position, color: 'c', ...extra } as Part;
}

function modelOf(parts: Part[]): CrochetModelV1 {
  return {
    schema: 'crochet-model',
    version: '1.0',
    revision: 0,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: 'test',
    finishedSize: { height: 4 },
    palette: [
      { id: 'c', hex: '#aa8866' },
      { id: 'd', hex: '#333333' },
    ],
    parts,
  };
}

/** The (azimuth, elevation) of each child's anchor on its parent. */
function anchorAngles(m: CrochetModelV1, parentId: string, childId: string) {
  const t = byId(m);
  const a = captureAnchor(t[parentId], t[childId]);
  return [a.azimuthDeg, a.elevationDeg];
}

describe('Move (§4.2): the subtree follows; ⌥ moves the part alone', () => {
  it('moving the body moves the whole tree by exactly the same vector', () => {
    const m = deepFreeze(teddy());
    const moved = movePart(m, 'body', [0.5, -0.25, 1]);
    expect(affectedIds(m, 'body', 'subtree').sort()).toEqual(m.parts.map((p) => p.id).sort());
    for (const [i, p] of moved.parts.entries()) {
      const before = m.parts[i].position;
      for (let k = 0; k < 3; k++) expect(p.position[k]).toBeCloseTo(before[k] + [0.5, -0.25, 1][k], 9);
      expect(p.rotationDeg).toBe(m.parts[i].rotationDeg); // a move never rewrites an angle
      expect(p.dims).toBe(m.parts[i].dims);
    }
    expect(gapIssues(moved)).toEqual([]);
  });

  it('⌥-moving the body moves the body alone and raises W_GAP on its children', () => {
    const m = deepFreeze(teddy());
    expect(gapIssues(m)).toEqual([]); // the canonical teddy: every part touches its parent
    const moved = movePart(m, 'body', [0, 0, -6], 'alone');
    const a = byId(moved);
    const b = byId(m);
    expect(a.body.position).toEqual([0, b.body.position[1], -6]);
    for (const p of m.parts) if (p.id !== 'body') expect(a[p.id]).toBe(p); // untouched: the same objects
    const issues = gapIssues(moved);
    const flagged = new Set(issues.map((i) => i.where?.part));
    for (const child of m.parts.filter((p) => p.attach?.to === 'body')) expect(flagged.has(child.id), child.id).toBe(true);
    for (const i of issues) {
      expect(i.code).toBe('W_GAP');
      expect(i.severity).toBe('warn');
    }
    expect(issues.find((i) => i.where?.part === 'head')?.message).toMatch(/^Head floats [\d.]+ in from Body/);
  });

  it('moving a mid-tree part (head) carries its subtree and nothing else', () => {
    const m = deepFreeze(teddy());
    const moved = movePart(m, 'head', [1, 0, 0]);
    const inTree = new Set(subtreeIds(m, 'head'));
    expect([...inTree].sort()).toEqual(['ear_l', 'ear_l_inner', 'ear_r', 'ear_r_inner', 'eye_l', 'eye_r', 'head', 'muzzle', 'nose']);
    const a = byId(moved);
    for (const p of m.parts) {
      if (inTree.has(p.id)) expect(a[p.id].position[0]).toBeCloseTo(p.position[0] + 1, 9);
      else expect(a[p.id]).toBe(p);
    }
  });

  it('is pure: frozen input, same object for a no-op, deterministic, rounded to 1e-6', () => {
    const m = deepFreeze(teddy());
    expect(movePart(m, 'body', [0, 0, 0])).toBe(m);
    expect(movePart(m, 'nobody', [1, 0, 0])).toBe(m);
    expect(movePart(m, 'body', [Number.NaN, 0, 0])).toBe(m);
    expect(movePart(m, 'body', [1 / 3, 0, 0])).toEqual(movePart(m, 'body', [1 / 3, 0, 0]));
    for (const p of movePart(m, 'body', [1 / 3, 1 / 7, 0]).parts) for (const v of p.position) expect(Math.abs(v * 1e6 - Math.round(v * 1e6))).toBeLessThan(1e-6);
  });

  it('setPartPosition sets the part’s origin and moves the subtree by the same amount', () => {
    const m = teddy();
    const moved = setPartPosition(m, 'head', [0, 8, 0.1]);
    const a = byId(moved);
    const b = byId(m);
    expect(a.head.position).toEqual([0, 8, 0.1]);
    expect(a.ear_l.position[1]).toBeCloseTo(b.ear_l.position[1] + (8 - b.head.position[1]), 9);
    expect(setPartPosition(m, 'head', [0, 8, 0.1], 'alone').parts.find((p) => p.id === 'ear_l')).toBe(b.ear_l);
  });
});

describe('Rotate (§4.2): about the part’s center, the subtree rigidly', () => {
  it('turning the head 30° about Y turns its ears with it and keeps every distance', () => {
    const m = deepFreeze(teddy());
    const head = byId(m).head;
    const from = pivotOf(head);
    const to = { center: from.center, rotationDeg: [0, 30, 0] as Vec3 };
    const turned = transformByPivot(m, 'head', from, to);
    const a = byId(turned);
    const b = byId(m);
    expect(partCenter(a.head)).toEqual(partCenter(b.head).map((v) => Number(v.toFixed(6))));
    expect(a.head.rotationDeg).toEqual([0, 30, 0]);
    // A point fixed on the ear stays fixed on the ear, wherever it went: the subtree moved rigidly.
    const probe: Vec3 = [0.3, 0.2, 0.1];
    const R = eulerXYZToMat3([0, 30, 0]);
    for (const id of ['ear_l', 'ear_r', 'muzzle', 'nose', 'eye_l', 'ear_l_inner']) {
      const before = applyRigid(partTransform(b[id]), probe);
      const expected = applyRigid({ rotation: R, position: sub(partCenter(b.head), applyRigid({ rotation: R, position: [0, 0, 0] }, partCenter(b.head))) }, before);
      const after = applyRigid(partTransform(a[id]), probe);
      expect(dist(after, expected), id).toBeLessThan(1e-5);
      expect(dist(partCenter(a[id]), partCenter(a.head))).toBeCloseTo(dist(partCenter(b[id]), partCenter(b.head)), 5);
    }
    // The ears keep touching the head.
    expect(surfaceGap(a.ear_l, a.head)).toBeCloseTo(surfaceGap(b.ear_l, b.head), 4);
    // Everything outside the head's subtree is untouched.
    for (const id of ['body', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'tail', 'foot_pad_l']) expect(a[id]).toBe(b[id]);
  });

  it('⌥-rotating turns the part alone', () => {
    const m = teddy();
    const head = byId(m).head;
    const turned = transformByPivot(m, 'head', pivotOf(head), { center: partCenter(head), rotationDeg: [0, 0, 20] }, 'alone');
    const a = byId(turned);
    expect(a.head.rotationDeg).toEqual([0, 0, 20]);
    expect(a.ear_l).toBe(byId(m).ear_l);
  });

  it('rotationAbout keeps its center fixed; setPartRotation writes exactly the typed angles', () => {
    const m = rotationAbout([1, 2, 3], [10, 20, 30]);
    const c = applyRigid(m, [1, 2, 3]);
    expect(dist(c, [1, 2, 3])).toBeLessThan(1e-12);
    const t = teddy();
    const r = setPartRotation(t, 'arm_l', [70, 10, 5]);
    const a = byId(r);
    expect(a.arm_l.rotationDeg).toEqual([70, 10, 5]);
    expect(dist(partCenter(a.arm_l), partCenter(byId(t).arm_l))).toBeLessThan(1e-5); // about its center
    expect(setPartRotation(t, 'arm_l', byId(t).arm_l.rotationDeg ?? [0, 0, 0])).toBe(t);
  });

  it('a lathe turns about its center, not its base', () => {
    const lathe: Part = { id: 'vase', type: 'lathe', dims: { profile: [[0, 0], [1, 0.5], [0.8, 2], [0, 2.4]] }, position: [0, 0, 0], color: 'c' };
    const m = modelOf([lathe]);
    const c0 = partCenter(lathe);
    const r = setPartRotation(m, 'vase', [90, 0, 0]);
    expect(dist(partCenter(r.parts[0]), c0)).toBeLessThan(1e-5);
    expect(r.parts[0].position).not.toEqual([0, 0, 0]);
  });
});

describe('Scale and Parameters (§4.2): dims change, children are re-anchored', () => {
  it('T6 acceptance: head 1.2× keeps each ear’s gap ≤ 0.1 in and (az, el) within 1°; one undo restores everything', () => {
    const store = createProjectStore();
    openTeddy(store);
    const before = store.getState().doc!;
    const m0 = before.threeD!.model!;
    expect(editModel('Resize Head', (m) => scalePart(m, 'head', [1.2, 1.2, 1.2]), { store })).toBe(true);
    const m1 = store.getState().doc!.threeD!.model!;
    const a = byId(m1);
    const b = byId(m0);
    expect(a.head.dims).toEqual({ rx: 2.88, ry: 2.58, rz: 2.64 });
    expect(a.head.position).toEqual(b.head.position); // scaled about its center (an ellipsoid's center is its origin)
    for (const id of ['ear_l', 'ear_r', 'muzzle', 'eye_l', 'eye_r']) {
      expect(surfaceGap(a[id], a.head), id).toBeLessThanOrEqual(0.1);
      const [az0, el0] = anchorAngles(m0, 'head', id);
      const [az1, el1] = anchorAngles(m1, 'head', id);
      expect(Math.abs(az1 - az0), `${id} azimuth`).toBeLessThan(1);
      expect(Math.abs(el1 - el0), `${id} elevation`).toBeLessThan(1);
      expect(a[id].rotationDeg).toEqual(b[id].rotationDeg);
      expect(a[id].dims).toEqual(b[id].dims);
    }
    // The ear's own child moved with it (subtree translation).
    expect(sub(a.ear_l_inner.position, b.ear_l_inner.position)).toEqual(sub(a.ear_l.position, b.ear_l.position).map((v) => expect.closeTo(v, 6)));
    // Parts outside the head's subtree are untouched.
    for (const id of ['body', 'arm_l', 'leg_r', 'tail']) expect(a[id]).toBe(b[id]);
    expect(m1.revision).toBe(m0.revision + 1);
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().undo()).toBe(true);
    expect(store.getState().doc).toEqual(before);
    expect(store.getState().doc!.threeD!.model).toEqual(m0);
    expect(store.getState().redo()).toBe(true);
    expect(store.getState().doc!.threeD!.model).toEqual(m1);
  });

  it('scaledDims per type: an uneven sphere becomes an ellipsoid; radial dims take the axis that moved most', () => {
    const s = sphere('s', 1, [0, 1, 0]);
    expect(scaledDims(s, [2, 2, 2])).toMatchObject({ type: 'sphere', dims: { r: 2 } });
    expect(scaledDims(s, [1.5, 1, 1])).toMatchObject({ type: 'ellipsoid', dims: { rx: 1.5, ry: 1, rz: 1 } });
    expect(scaledDims(s, [1.5, 1, 1])).not.toHaveProperty('dims.r');
    const cap: Part = { id: 'a', type: 'capsule', dims: { r: 0.5, length: 3 }, position: [0, 0, 0], color: 'c' };
    expect(scaledDims(cap, [2, 1, 1]).dims).toEqual({ r: 1, length: 3 });
    expect(scaledDims(cap, [1, 1, 0.5]).dims).toEqual({ r: 0.25, length: 3 });
    expect(scaledDims(cap, [1, 0.2, 1]).dims).toEqual({ r: 0.3, length: 0.6 }); // shortened below its caps: r gives way
    const cyl: Part = { id: 'c', type: 'cylinder', dims: { rTop: 1, rBottom: 0.5, h: 2, open: 'top' }, position: [0, 0, 0], color: 'c' };
    expect(scaledDims(cyl, [1, 2, 1]).dims).toEqual({ rTop: 1, rBottom: 0.5, h: 4, open: 'top' });
    const torus: Part = { id: 't', type: 'torus', dims: { R: 1, r: 0.2, arcDeg: 180 }, position: [0, 0, 0], color: 'c' };
    expect(scaledDims(torus, [1, 1.5, 1]).dims).toEqual({ R: 1.5, r: 0.2, arcDeg: 180 });
    const flat: Part = { id: 'f', type: 'flat', dims: { shape: 'oval', w: 1, h: 2, thickness: 0.1 }, position: [0, 0, 0], color: 'c' };
    expect(scaledDims(flat, [2, 1, 0.1]).dims).toEqual({ shape: 'oval', w: 2, h: 2, thickness: 0.05 }); // floor 0.05 in
    const lathe: Part = { id: 'l', type: 'lathe', dims: { profile: [[0, 0], [1, 1], [0, 2]], sharp: [1] }, position: [0, 0, 0], color: 'c' };
    expect(scaledDims(lathe, [2, 0.5, 1]).dims).toEqual({ profile: [[0, 0], [2, 0.5], [0, 1]], sharp: [1] });
    const mesh: Part = { id: 'm', type: 'mesh', dims: { meshRef: 'x', bboxIn: [1, 1, 1] }, position: [0, 0, 0], color: 'c' };
    expect(scaledDims(mesh, [2, 2, 2])).toBe(mesh);
    expect(scaleBlockedReason(mesh)).toMatch(/later/);
    expect(scaledDims(s, [0, 1, 1])).toBe(s);
    expect(scaledDims(s, [Number.NaN, 1, 1])).toBe(s);
  });

  it('snapping rounds only the dims that changed to the 0.05 in grid', () => {
    const e: Part = { id: 'e', type: 'ellipsoid', dims: { rx: 1.03, ry: 0.77, rz: 0.5 }, position: [0, 0, 0], color: 'c' };
    expect(scaledDims(e, [1.111, 1, 1], { snap: true }).dims).toEqual({ rx: 1.15, ry: 0.77, rz: 0.5 });
  });

  it('every scaled model stays valid for the schema (limits, capsule caps)', () => {
    const m = teddy();
    for (const f of [0.01, 0.3, 1.7, 40] as const) {
      for (const id of ['head', 'arm_l', 'ear_l_inner', 'tail']) {
        const r = validateModel(scalePart(m, id, [f, f * 1.3, f]));
        expect(r.ok, `${id} × ${f}: ${r.ok ? '' : r.issues.map((i) => i.message).join('; ')}`).toBe(true);
      }
    }
  });

  it('scalePart keeps a lathe’s center fixed (the gizmo’s pivot)', () => {
    const lathe: Part = { id: 'vase', type: 'lathe', dims: { profile: [[0, 0], [1, 0.5], [0.8, 2], [0, 2.4]] }, position: [0, 0, 0], color: 'c' };
    const m = modelOf([lathe]);
    const r = scalePart(m, 'vase', [1, 2, 1]);
    expect(dist(partCenter(r.parts[0]), partCenter(lathe))).toBeLessThan(1e-5);
    expect(r.parts[0].position[1]).toBeCloseTo(-1.2, 6);
  });

  it('setPartDims / setPartDim: normalized, children re-anchored, no-ops return the input', () => {
    const m = deepFreeze(teddy());
    const r = setPartDim(m, 'head', 'rx', 3);
    const a = byId(r);
    expect(a.head.dims).toEqual({ rx: 3, ry: 2.15, rz: 2.2 });
    expect(a.head.position).toEqual(byId(m).head.position); // Parameters keep the origin
    expect(a.ear_l.position[0]).toBeGreaterThan(byId(m).ear_l.position[0]); // pushed outward with the wider head
    expect(surfaceGap(a.ear_l, a.head)).toBeLessThanOrEqual(0.1);
    expect(setPartDim(m, 'head', 'rx', 2.4)).toBe(m);
    expect(setPartDim(m, 'head', 'nope', 3)).toBe(m);
    expect(setPartDim(m, 'head', 'rx', Number.NaN)).toBe(m);
    expect(setPartDim(m, 'head', 'rx', 1000).parts.find((p) => p.id === 'head')?.dims).toMatchObject({ rx: 48 });
    expect(setPartDim(m, 'head', 'rx', -2).parts.find((p) => p.id === 'head')?.dims).toMatchObject({ rx: 0.05 });
    // A capsule never gets shorter than its caps: a smaller length lowers r; a larger r raises the length.
    const arm = byId(m).arm_l as Extract<Part, { type: 'capsule' }>;
    const shorter = byId(setPartDim(m, 'arm_l', 'length', 0.4)).arm_l;
    expect(shorter.dims).toEqual({ r: 0.2, length: 0.4 });
    const fatter = byId(setPartDim(m, 'arm_l', 'r', arm.dims.length)).arm_l;
    expect(fatter.dims).toEqual({ r: arm.dims.length, length: 2 * arm.dims.length });
    // A torus gets an arc even when it had none.
    const ring = modelOf([{ id: 't', type: 'torus', dims: { R: 1, r: 0.2 }, position: [0, 0.2, 0], color: 'c' }]);
    expect(setPartDim(ring, 't', 'arcDeg', 180).parts[0].dims).toEqual({ R: 1, r: 0.2, arcDeg: 180 });
    expect(setPartDim(ring, 't', 'arcDeg', 900).parts[0].dims).toEqual({ R: 1, r: 0.2, arcDeg: 360 });
  });

  it('normalizeDims repairs a lathe profile (negative radius, decreasing height) and clamps lengths', () => {
    const lathe: Part = { id: 'l', type: 'lathe', dims: { profile: [[-1, 0], [1, 2], [0.5, 1]] }, position: [0, 0, 0], color: 'c' };
    expect(normalizeDims(lathe).dims).toEqual({ profile: [[0, 0], [1, 2], [0.5, 2]] });
    expect(clampDim(Number.POSITIVE_INFINITY)).toBe(0.05);
    expect(clampDim(0.0123456789)).toBe(0.05);
    expect(clampDim(2.0000004)).toBe(2);
  });
});

describe('review cases: validity under any edit, no angle noise', () => {
  const everyType = () => parseModel(structuredClone(everyTypeJson));

  it('a gizmo move with radian noise in the angles never rewrites a rotation', () => {
    const m = modelOf([sphere('body', 1, [0, 1, 0], { rotationDeg: [0, 12, 0] }), { ...sphere('tail', 0.3, [0, 1, -1], { attach: { to: 'body' } }), rotationDeg: [0, 180, 0] } as Part, { ...sphere('x', 0.3, [0, 2, 0], { attach: { to: 'body' } }), rotationDeg: [0, 120, 37] } as Part]);
    const noisy = (v: Vec3): Vec3 => v.map((d) => d * (Math.PI / 180) * (180 / Math.PI)) as Vec3; // three's degToRad / radToDeg
    const from = pivotOf(m.parts[0]);
    const to = { center: [from.center[0] + 0.5, from.center[1], from.center[2]] as Vec3, rotationDeg: noisy(from.rotationDeg) };
    expect(to.rotationDeg[1]).not.toBe(12); // 12.000000000000002
    const moved = transformByPivot(m, 'body', from, to);
    expect(moved.parts.map((p) => p.rotationDeg)).toEqual(m.parts.map((p) => p.rotationDeg));
    expect(moved.parts[1].position[0]).toBeCloseTo(0.5, 9);
  });

  it('every edit of every part type keeps the model valid (scale to extremes, dims to the limits)', () => {
    const m = everyType();
    for (const p of m.parts) {
      for (const f of [[1e-6, 1e-6, 1e-6], [1e6, 1e6, 1e6], [1, 1e-4, 1], [3, 0.5, 1.7], [1.0000001, 1, 1]] as Vec3[]) {
        for (const snap of [false, true]) {
          const r = validateModel(scalePart(m, p.id, f, { snap }));
          expect(r.ok, `${p.id} (${p.type}) × ${f} snap ${snap}: ${r.ok ? '' : r.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`).toBe(true);
        }
      }
      for (const key of Object.keys(p.dims)) {
        for (const v of [0, 0.01, 0.07, 1000, -3]) {
          const r = validateModel(setPartDim(m, p.id, key, v));
          expect(r.ok, `${p.id}.${key} = ${v}: ${r.ok ? '' : r.issues.map((i) => i.message).join('; ')}`).toBe(true);
        }
      }
    }
    // The teddy's capsule arm at a 0.01 in length: two caps of the smallest radius.
    expect(byId(setPartDim(teddy(), 'arm_l', 'length', 0.01)).arm_l.dims).toEqual({ r: 0.05, length: 0.1 });
  });

  it('a sphere stays a sphere when snapping makes the radii equal; a polygon’s points follow its size; other shapes drop them', () => {
    const s0 = sphere('s', 0.2, [0, 0.2, 0]);
    expect(scaledDims(s0, [1.0000001, 1, 1], { snap: true })).toMatchObject({ type: 'sphere', dims: { r: 0.2 } });
    const poly: Part = { id: 'p', type: 'flat', dims: { shape: 'polygon', w: 2, h: 1, thickness: 0.1, points: [[-1, -0.5], [1, -0.5], [0, 0.5]] }, position: [0, 0.5, 0], color: 'c' };
    expect(scaledDims(poly, [2, 3, 1]).dims).toEqual({ shape: 'polygon', w: 4, h: 3, thickness: 0.1, points: [[-2, -1.5], [2, -1.5], [0, 1.5]] });
    const m = modelOf([poly]);
    expect(setPartDim(m, 'p', 'w', 1).parts[0].dims).toMatchObject({ w: 1, points: [[-0.5, -0.5], [0.5, -0.5], [0, 0.5]] });
    expect(setPartDims(m, 'p', { ...poly.dims, shape: 'circle' } as Part['dims']).parts[0].dims).toEqual({ shape: 'circle', w: 2, h: 1, thickness: 0.1 });
  });
});

describe('other part edits', () => {
  it('setPartColor takes palette ids only; setPartLabel trims and removes', () => {
    const m = teddy();
    expect(byId(setPartColor(m, 'head', 'cream_yarn')).head.color).toBe('cream_yarn');
    expect(setPartColor(m, 'head', 'no_such')).toBe(m);
    expect(setPartColor(m, 'head', 'caramel_yarn')).toBe(m);
    expect(byId(setPartLabel(m, 'head', '  Big head ')).head.label).toBe('Big head');
    expect(byId(setPartLabel(m, 'head', '')).head).not.toHaveProperty('label');
    expect(partName(byId(setPartLabel(m, 'head', '')).head)).toBe('head');
  });

  it('transformPart with an unknown id or an identity motion changes nothing', () => {
    const m = teddy();
    expect(transformPart(m, 'x', { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], position: [1, 0, 0] })).toBe(m);
    expect(transformPart(m, 'body', { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], position: [0, 0, 0] })).toBe(m);
    const head = byId(m).head;
    expect(transformByPivot(m, 'head', pivotOf(head), pivotOf(head))).toBe(m);
  });
});

describe('outliner tree', () => {
  it('the teddy’s attach tree: body at the root, the head’s parts under the head', () => {
    const m = teddy();
    const tree = partTree(m);
    expect(tree.map((n) => n.id)).toEqual(['body']);
    const body = tree[0];
    expect(body.children.map((n) => n.id)).toEqual(['head', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'tail']);
    const head = body.children[0];
    expect(head.depth).toBe(1);
    expect(head.children.map((n) => n.id)).toEqual(['muzzle', 'eye_l', 'eye_r', 'ear_l', 'ear_r']);
    expect(visibleRows(tree, new Set()).map((n) => n.id)).toHaveLength(m.parts.length);
    expect(visibleRows(tree, new Set(['head'])).map((n) => n.id)).toEqual(['body', 'head', 'arm_l', 'arm_r', 'leg_l', 'foot_pad_l', 'leg_r', 'foot_pad_r', 'tail']);
    expect(ancestorIds(m, 'ear_l_inner')).toEqual(['ear_l', 'head', 'body']);
    expect(ancestorIds(m, 'body')).toEqual([]);
  });

  it('parts on a cycle (an unvalidated model) are still listed, once each', () => {
    const m = modelOf([sphere('a', 1, [0, 1, 0], { attach: { to: 'b' } }), sphere('b', 1, [0, 2, 0], { attach: { to: 'a' } }), sphere('c', 1, [0, 3, 0])]);
    const rows = visibleRows(partTree(m), new Set());
    expect(rows.map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
    expect(ancestorIds(m, 'a')).toEqual(['b']);
  });
});

describe('store actions (§4.4)', () => {
  it('a gesture of many updates is ONE history step; it recomputes from its start each time', () => {
    const store = createProjectStore();
    openTeddy(store);
    const m0 = store.getState().doc!.threeD!.model!;
    const g = beginModelGesture('Move Body', { store })!;
    for (let i = 1; i <= 20; i++) g.update((m) => movePart(m, 'body', [i * 0.05, 0, 0]));
    g.update((m) => movePart(m, 'body', [0.25, 0, 0], 'alone')); // ⌥ pressed late: from the start, alone
    g.end();
    const m1 = store.getState().doc!.threeD!.model!;
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Move Body']);
    expect(byId(m1).body.position[0]).toBeCloseTo(0.25, 9);
    expect(byId(m1).head).toBe(byId(m0).head);
    expect(m1.revision).toBe(m0.revision + 1);
    // The next gesture is a new step.
    const g2 = beginModelGesture('Move Head', { store })!;
    g2.update((m) => movePart(m, 'head', [0, 0.1, 0]));
    g2.end();
    g2.update((m) => movePart(m, 'head', [0, 5, 0])); // after end: ignored
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Move Body', 'Move Head']);
    store.getState().undo();
    store.getState().undo();
    expect(store.getState().doc!.threeD!.model).toEqual(m0);
  });

  it('a cancelled gesture leaves no step and the model as it was', () => {
    const store = createProjectStore();
    openTeddy(store);
    const before = store.getState().doc;
    const g = beginModelGesture('Move Body', { store })!;
    g.update((m) => movePart(m, 'body', [1, 0, 0]));
    g.cancel();
    expect(store.getState().history.past).toHaveLength(0);
    expect(store.getState().doc!.threeD!.model).toEqual(before!.threeD!.model);
  });

  it('nothing is written without a model, on a read-only project, or for a no-op edit', () => {
    const store = createProjectStore();
    expect(editModel('x', (m) => m, { store })).toBe(false);
    expect(beginModelGesture('x', { store })).toBeNull();
    openTeddy(store, { model: null });
    expect(editModel('x', (m) => movePart(m, 'body', [1, 0, 0]), { store })).toBe(false);
    openTeddy(store);
    expect(editModel('Nothing', (m) => m, { store })).toBe(false);
    expect(store.getState().history.past).toHaveLength(0);
    store.getState().setReadOnly(true);
    expect(editModel('Move', (m) => movePart(m, 'body', [1, 0, 0]), { store })).toBe(false);
    expect(store.getState().history.past).toHaveLength(0);
  });

  it('modelRecipe and withRevision: one revision bump per change, none for a no-op', () => {
    const m = teddy();
    expect(withRevision(m, m)).toBe(m);
    expect(withRevision(m, movePart(m, 'body', [1, 0, 0])).revision).toBe(m.revision + 1);
    const recipe = modelRecipe((x) => x);
    expect(() => recipe({ threeD: undefined } as never)).toThrow(/no 3D model/);
  });

  it('a resize gesture re-anchors at most every 100 ms (and after a pause, and on release); the step equals one unthrottled edit', () => {
    const store = createProjectStore();
    openTeddy(store);
    const m0 = store.getState().doc!.threeD!.model!;
    let t = 1000;
    const timers: { fn: () => void; at: number }[] = [];
    const g = beginResizeGesture('Resize Head', {
      store,
      now: () => t,
      schedule: (fn, ms) => {
        const timer = { fn, at: t + ms };
        timers.push(timer);
        return () => timers.splice(timers.indexOf(timer), 1);
      },
    })!;
    const resize = (f: number) => g.update('head', (m, o) => scalePart(m, 'head', [f, f, f], o));
    const ear = () => byId(store.getState().doc!.threeD!.model!).ear_l;
    resize(1.1); // the first update re-anchors at once
    const ear1 = ear();
    expect(ear1.position).not.toEqual(byId(m0).ear_l.position);
    t += 30;
    resize(1.2); // within 100 ms: the head grows, the ear waits
    expect(byId(store.getState().doc!.threeD!.model!).head.dims).toMatchObject({ rx: 2.88 });
    expect(ear()).toBe(ear1);
    expect(timers).toHaveLength(1);
    expect(timers[0].at).toBe(1100);
    t = 1100;
    timers.shift()!.fn(); // the pause timer: re-anchored for 1.2
    expect(ear().position).toEqual(byId(scalePart(m0, 'head', [1.2, 1.2, 1.2])).ear_l.position);
    t += 10;
    resize(1.3);
    g.end(); // release: always re-anchored
    expect(timers).toHaveLength(0);
    expect(store.getState().doc!.threeD!.model).toEqual({ ...scalePart(m0, 'head', [1.3, 1.3, 1.3]), revision: m0.revision + 1 });
    expect(store.getState().history.past.map((e) => e.label)).toEqual(['Resize Head']);
    expect(g.update('head', (m) => m)).toBe(false); // ended
    store.getState().undo();
    expect(store.getState().doc!.threeD!.model).toEqual(m0);
  });

  it('a cancelled resize gesture leaves nothing behind', () => {
    const store = createProjectStore();
    openTeddy(store);
    const m0 = store.getState().doc!.threeD!.model!;
    const g = beginResizeGesture('Resize Head', { store })!;
    g.update('head', (m, o) => scalePart(m, 'head', [2, 2, 2], o));
    g.update('head', (m, o) => scalePart(m, 'head', [2.5, 2, 2], o));
    g.cancel();
    expect(store.getState().doc!.threeD!.model).toEqual(m0);
    expect(store.getState().history.past).toHaveLength(0);
  });
});
