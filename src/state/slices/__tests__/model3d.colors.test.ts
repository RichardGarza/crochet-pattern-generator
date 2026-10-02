// Track T6.3 — the editor's color, detail and proportions recipes (DESIGN.md §4.2 Paint / Palette / Features /
// Proportions, §2.11.1, §6.3 T6): palette edits re-index the paint field and return the label map for mesh labels;
// regions and features stay schema-valid at any input; the Proportions edit is the kernel's (G23) and is ONE
// history step per drag.
import { describe, expect, it } from 'vitest';
import { decodeUv64, encodeUv64 } from '../../../core/model/builder';
import { readProportions } from '../../../core/model/proportions';
import { validateModel } from '../../../core/model/schema';
import { modelHeight, worldBounds } from '../../../core/model/transforms';
import { surfaceGap } from '../../../core/model/sdf';
import type { CrochetModelV1, Feature, Part, Region } from '../../../types/model';
import { createProjectStore } from '../../projectStore';
import {
  addColorBlockedReason,
  addFeature,
  addFeatureBlockedReason,
  addPaletteColor,
  addRegion,
  addRegionBlockedReason,
  angleDirection,
  beginModelGesture,
  defaultFeature,
  defaultRegion,
  directionAngles,
  fillPart,
  mergePaletteColors,
  movePaletteColor,
  moveRegion,
  NO_LABEL,
  normalizeFeature,
  normalizeRegion,
  paintCellsOf,
  paletteUse,
  proportionsBlockedReason,
  proportionsEdit,
  remapMeshLabels,
  remapPalette,
  removeColorBlockedReason,
  removeFeature,
  removePaletteColor,
  removeRegion,
  setPaletteColor,
  setPartPaint,
  slugColorId,
  uniqueColorId,
  updateFeature,
  updateRegion,
  wrapAzimuth,
  REGION_KINDS,
  FEATURE_KINDS,
} from '../model3d';
import { byId, deepFreeze, openTeddy, teddy } from './teddyProject';

const valid = (m: CrochetModelV1) => {
  const r = validateModel(m);
  if (!r.ok) throw new Error(r.issues.map((i) => i.message).join('; '));
  return true;
};

/** Cells painted with palette index `label` on rows `rows` (all columns). */
function cells(label: number, rows: [number, number]): Uint8Array<ArrayBuffer> {
  const c = new Uint8Array(4096).fill(NO_LABEL);
  for (let r = rows[0]; r <= rows[1]; r++) c.fill(label, r * 64, r * 64 + 64);
  return c;
}

describe('palette', () => {
  it('ids are slugged, unique and at most 16 characters', () => {
    expect(slugColorId('Light Pink!')).toBe('light_pink');
    expect(slugColorId('Crème brûlée')).toBe('creme_brulee');
    expect(slugColorId('***')).toBe('color');
    expect(slugColorId('a very long name for a color')).toBe('a_very_long_name');
    const m = teddy();
    expect(uniqueColorId(m, 'cream_yarn')).toBe('cream_yarn_2');
    const long = { palette: [{ id: 'abcdefghijklmnop', hex: '#000000' }] };
    expect(uniqueColorId(long, 'abcdefghijklmnop')).toBe('abcdefghijklmn_2');
  });

  it('adds a color (uppercased hex), refuses a bad hex and a 17th color', () => {
    const m = deepFreeze(teddy());
    const r = addPaletteColor(m, '#ff8899', { name: 'Blush pink' });
    expect(r.id).toBe('blush_pink');
    expect(r.model.palette.at(-1)).toEqual({ id: 'blush_pink', hex: '#FF8899', name: 'Blush pink' });
    expect(valid(r.model)).toBe(true);
    expect(addPaletteColor(m, 'pink').id).toBeNull();
    let full: CrochetModelV1 = m;
    while (full.palette.length < 16) full = addPaletteColor(full, '#123456').model;
    expect(addColorBlockedReason(full)).toMatch(/16 colors/);
    expect(addPaletteColor(full, '#123456')).toEqual({ model: full, id: null });
  });

  it('changes hex and name but never the id; no-op returns the same model', () => {
    const m = deepFreeze(teddy());
    const n = setPaletteColor(m, 'cream_yarn', { hex: '#fafafa', name: '  Snow  ' });
    expect(n.palette[1]).toEqual({ id: 'cream_yarn', hex: '#FAFAFA', name: 'Snow' });
    expect(setPaletteColor(n, 'cream_yarn', { name: null }).palette[1]).toEqual({ id: 'cream_yarn', hex: '#FAFAFA' });
    expect(setPaletteColor(m, 'cream_yarn', { hex: 'nope' })).toBe(m);
    expect(setPaletteColor(m, 'missing', { hex: '#000000' })).toBe(m);
  });

  it('merging re-points parts, regions and features and re-indexes the paint field; the label map is for mesh labels', () => {
    let m = teddy();
    // Paint the head with dark brown (index 2) and black (index 3); a band of black on the body; a cheek in black.
    const head = byId(m).head;
    const c = cells(2, [10, 12]);
    c.fill(3, 40 * 64, 41 * 64);
    m = setPartPaint(m, 'head', c);
    m = addRegion(m, 'body', { kind: 'band', from: 0.2, to: 0.3, color: 'black_safety_eye' }).model;
    m = addFeature(m, { kind: 'cheek', on: 'head', azimuthDeg: 40, elevationDeg: 0, color: 'black_safety_eye' }).model;
    deepFreeze(m);
    const r = mergePaletteColors(m, 'dark_brown_yarn', 'black_safety_eye');
    expect(r.model.palette.map((p) => p.id)).toEqual(['caramel_yarn', 'cream_yarn', 'black_safety_eye']);
    expect(byId(r.model).nose.color).toBe('black_safety_eye');
    const painted = decodeUv64(byId(r.model).head.paint!.data)!;
    expect(painted[10 * 64]).toBe(2); // dark brown (2) → black, now index 2
    expect(painted[40 * 64]).toBe(2); // black (3) → 2
    expect(painted[0]).toBe(NO_LABEL);
    expect(Array.from(r.labelMap.slice(0, 4))).toEqual([0, 1, 2, 2]);
    expect(r.labelMap[NO_LABEL]).toBe(NO_LABEL);
    expect(r.reindexed).toBe(true);
    expect(valid(r.model)).toBe(true);
    // Untouched parts stay the same objects.
    expect(byId(r.model).arm_l).toBe(byId(m).arm_l);
    expect(head).toBeDefined();
    // A mesh's labels follow the map; unknown labels stay unknown, labels past the palette become unknown.
    const mesh = { positions: new Float32Array(9), indices: new Uint32Array([0, 1, 2]), labels: new Uint8Array([0, 2, 3, NO_LABEL, 7]) };
    expect(Array.from(remapMeshLabels(mesh, r.labelMap).labels)).toEqual([0, 2, 2, NO_LABEL, NO_LABEL]);
    expect(remapMeshLabels(mesh, remapPalette(m, m.palette.map((p) => p.id)).labelMap)).toBe(mesh);
  });

  it('refuses to remove a used color or the last one; removing an unused color shifts the indices after it', () => {
    let m = teddy();
    m = addPaletteColor(m, '#00ff00', { name: 'green' }).model; // index 4
    m = addPaletteColor(m, '#0000ff', { name: 'blue' }).model; // index 5
    m = setPartPaint(m, 'body', cells(5, [0, 3]));
    expect(removeColorBlockedReason(m, 'caramel_yarn')).toMatch(/in use/);
    expect(removeColorBlockedReason(m, 'blue')).toMatch(/in use/);
    expect(removeColorBlockedReason(m, 'green')).toBeNull();
    expect(removeColorBlockedReason(m, 'green', 3)).toMatch(/in use/);
    expect(paletteUse(m, 'blue').paintCells).toBe(256);
    const r = removePaletteColor(m, 'green');
    expect(r.model.palette.map((p) => p.id)).not.toContain('green');
    expect(decodeUv64(byId(r.model).body.paint!.data)![0]).toBe(4);
    expect(r.labelMap[5]).toBe(4);
    expect(removePaletteColor(m, 'caramel_yarn').model).toBe(m);
    const one = { ...m, palette: [m.palette[0]] };
    expect(removeColorBlockedReason(one, 'caramel_yarn')).toMatch(/at least one/);
  });

  it('moving a color re-indexes the paint so every cell keeps its color', () => {
    let m = teddy();
    m = setPartPaint(m, 'head', cells(0, [20, 22]));
    const r = movePaletteColor(m, 'caramel_yarn', 2);
    expect(r.model.palette.map((p) => p.id)).toEqual(['cream_yarn', 'dark_brown_yarn', 'caramel_yarn', 'black_safety_eye']);
    expect(decodeUv64(byId(r.model).head.paint!.data)![20 * 64]).toBe(2);
    expect(movePaletteColor(m, 'caramel_yarn', -1).model).toBe(m);
  });

  it('rejects an invalid remap (missing id, unknown merge target)', () => {
    const m = teddy();
    expect(remapPalette(m, ['caramel_yarn']).model).toBe(m);
    expect(remapPalette(m, ['caramel_yarn', 'caramel_yarn', 'cream_yarn', 'dark_brown_yarn', 'black_safety_eye']).model).toBe(m);
    expect(remapPalette(m, ['caramel_yarn', 'cream_yarn', 'dark_brown_yarn'], { black_safety_eye: 'nope' }).model).toBe(m);
  });
});

describe('paint field', () => {
  it('setPartPaint stores 4096 cells, drops labels past the palette, removes an empty field', () => {
    const m = deepFreeze(teddy());
    const c = cells(1, [0, 0]);
    c[100] = 99;
    const n = setPartPaint(m, 'head', c);
    const back = paintCellsOf(byId(n).head);
    expect(back[0]).toBe(1);
    expect(back[100]).toBe(NO_LABEL);
    expect(valid(n)).toBe(true);
    expect(byId(setPartPaint(n, 'head', null)).head.paint).toBeUndefined();
    expect(setPartPaint(m, 'head', new Uint8Array(4096).fill(NO_LABEL))).toBe(m);
    expect(setPartPaint(m, 'head', new Uint8Array(10))).toBe(m);
  });

  it('fill sets the base color and clears the strokes, keeping regions', () => {
    let m = teddy();
    m = setPartPaint(m, 'body', cells(1, [0, 5]));
    m = addRegion(m, 'body', { kind: 'band', from: 0.1, to: 0.2, color: 'cream_yarn' }).model;
    const n = fillPart(m, 'body', 'dark_brown_yarn');
    expect(byId(n).body.color).toBe('dark_brown_yarn');
    expect(byId(n).body.paint).toBeUndefined();
    expect(byId(n).body.regions).toHaveLength(1);
    expect(fillPart(n, 'body', 'dark_brown_yarn')).toBe(n);
    expect(fillPart(n, 'body', 'nope')).toBe(n);
  });
});

describe('regions', () => {
  it('every kind has a schema-valid default and survives add / update / reorder / remove', () => {
    let m = teddy();
    const body = byId(m).body;
    for (const kind of REGION_KINDS) {
      const r = addRegion(m, 'body', defaultRegion(kind, body, ['cream_yarn', 'caramel_yarn']));
      expect(r.index).toBe((m.parts.find((p) => p.id === 'body')!.regions?.length ?? 0));
      m = r.model;
      expect(valid(m)).toBe(true);
    }
    expect(byId(m).body.regions!.map((r) => r.kind)).toEqual(['band', 'stripes', 'patch', 'spot']);
    m = moveRegion(m, 'body', 3, -3);
    expect(byId(m).body.regions!.map((r) => r.kind)).toEqual(['spot', 'band', 'stripes', 'patch']);
    expect(moveRegion(m, 'body', 0, -1)).toBe(m);
    m = removeRegion(m, 'body', 0);
    expect(byId(m).body.regions!.map((r) => r.kind)).toEqual(['band', 'stripes', 'patch']);
    for (let i = 0; i < 3; i++) m = removeRegion(m, 'body', 0);
    expect(byId(m).body.regions).toBeUndefined();
    expect(removeRegion(m, 'body', 0)).toBe(m);
  });

  it('normalizes adversarial numbers to the schema ranges', () => {
    const bad: Region[] = [
      { kind: 'band', from: 0.9, to: 0.1, color: 'cream_yarn' },
      { kind: 'band', from: NaN, to: Infinity, color: 'cream_yarn' },
      { kind: 'patch', azimuthDeg: 1000, spanDeg: -5, from: -1, to: 3, color: 'cream_yarn' },
      { kind: 'spot', azimuthDeg: -721, elevationDeg: 200, radiusIn: 0, color: 'cream_yarn' },
      { kind: 'spot', azimuthDeg: NaN, elevationDeg: NaN, radiusIn: NaN, color: 'cream_yarn' },
      { kind: 'stripes', colors: ['cream_yarn'], widthIn: -1, from: 2 },
    ];
    let m = teddy();
    for (const r of bad) m = addRegion(m, 'head', r).model;
    expect(valid(m)).toBe(true);
    const [band] = byId(m).head.regions!;
    expect(band).toEqual({ kind: 'band', from: 0.1, to: 0.9, color: 'cream_yarn' });
    expect(normalizeRegion({ kind: 'patch', azimuthDeg: 190, spanDeg: 900, from: 0, to: 1, color: 'x' })).toMatchObject({ azimuthDeg: -170, spanDeg: 360 });
    expect(wrapAzimuth(180)).toBe(-180);
    expect(wrapAzimuth(-180)).toBe(-180);
    expect(wrapAzimuth(359)).toBe(-1);
  });

  it('a part holds at most 24 regions; update replaces one; unknown parts and indices change nothing', () => {
    let m = teddy();
    for (let i = 0; i < 24; i++) m = addRegion(m, 'tail', { kind: 'band', from: 0, to: 0.1, color: 'cream_yarn' }).model;
    expect(addRegionBlockedReason(m, 'tail')).toMatch(/24/);
    expect(addRegion(m, 'tail', { kind: 'band', from: 0, to: 0.1, color: 'cream_yarn' }).index).toBe(-1);
    const n = updateRegion(m, 'tail', 3, { kind: 'spot', azimuthDeg: 0, elevationDeg: 0, radiusIn: 0.2, color: 'dark_brown_yarn' });
    expect(byId(n).tail.regions![3].kind).toBe('spot');
    expect(updateRegion(m, 'tail', 99, { kind: 'band', from: 0, to: 1, color: 'cream_yarn' })).toBe(m);
    expect(updateRegion(m, 'nope', 0, { kind: 'band', from: 0, to: 1, color: 'cream_yarn' })).toBe(m);
    expect(addRegionBlockedReason(m, 'nope')).toMatch(/Select/);
  });

  it('a region edit on a mirror-linked part is a linked edit (the twin gets the mirrored region)', async () => {
    const { editModel } = await import('../model3d');
    const store = createProjectStore();
    openTeddy(store);
    // ear_r is the twin of ear_l in the teddy? Link them first through the Mirror tool's recipe.
    const { mirrorParts } = await import('../model3d');
    editModel('Mirror', (m) => mirrorParts(m, ['ear_l']).model, { store, linked: false });
    const before = store.getState().doc!.threeD!.model!;
    expect(byId(before).ear_r.mirrorOf).toBe('ear_l');
    editModel('Spot', (m) => addRegion(m, 'ear_l', { kind: 'spot', azimuthDeg: 30, elevationDeg: 10, radiusIn: 0.2, color: 'cream_yarn' }).model, { store });
    const after = store.getState().doc!.threeD!.model!;
    expect(byId(after).ear_r.regions?.[0]).toMatchObject({ kind: 'spot', azimuthDeg: -30, elevationDeg: 10 });
    store.getState().close({ discardUnsaved: true });
  });
});

describe('features (face details)', () => {
  it('every kind gets a schema-valid default; ids follow the part-id pattern and never repeat', () => {
    let m = teddy();
    const head = byId(m).head;
    const ids: string[] = [];
    for (const kind of FEATURE_KINDS) {
      const r = addFeature(m, defaultFeature(kind, head, 30, 10));
      expect(r.id).toMatch(/^[a-z][a-z0-9_]{0,31}$/);
      ids.push(r.id!);
      m = r.model;
    }
    const again = addFeature(m, defaultFeature('safety_eye', head, -30, 10));
    expect(again.id).toBe('safety_eye_2');
    expect(new Set([...ids, again.id]).size).toBe(ids.length + 1);
    expect(valid(again.model)).toBe(true);
    // Placed off the middle, eyes come in pairs; a safety eye is sized in mm for the head.
    const eye = again.model.features!.find((f) => f.id === 'safety_eye_2')!;
    expect(eye.mirror).toBe(true);
    expect(eye.sizeMm).toBeGreaterThanOrEqual(6);
    expect(eye.sizeMm).toBeLessThanOrEqual(24);
    expect(defaultFeature('nose', head, 0, 0).mirror).toBeUndefined();
  });

  it('refuses a 61st detail, an unknown part or color; update and remove', () => {
    let m = teddy();
    const head = byId(m).head;
    expect(addFeature(m, { ...defaultFeature('nose', head, 0, 0), on: 'nope' }).id).toBeNull();
    expect(addFeature(m, { ...defaultFeature('nose', head, 0, 0), color: 'nope' }).id).toBeNull();
    for (let i = 0; i < 60; i++) m = addFeature(m, defaultFeature('nose', head, i, 0)).model;
    expect(addFeatureBlockedReason(m)).toMatch(/60/);
    expect(addFeature(m, defaultFeature('nose', head, 0, 0)).id).toBeNull();
    // The teddy has a part called "nose": the first nose detail is nose_2.
    const first = m.features![0].id;
    expect(first).toBe('nose_2');
    let n = updateFeature(m, first, { sizeIn: 0.5, color: 'cream_yarn', azimuthDeg: 400 });
    expect(n.features![0]).toMatchObject({ sizeIn: 0.5, color: 'cream_yarn', azimuthDeg: 40 });
    n = updateFeature(n, first, { color: null });
    expect(n.features![0].color).toBeUndefined();
    expect(updateFeature(n, first, { on: 'nope' })).toBe(n);
    expect(updateFeature(n, 'missing', { sizeIn: 1 })).toBe(n);
    const removed = removeFeature(n, first);
    expect(removed.features).toHaveLength(59);
    expect(removeFeature(teddy(), 'x')).toEqual(teddy());
    const single = addFeature(teddy(), defaultFeature('nose', head, 0, 0)).model;
    expect(removeFeature(single, 'nose_2').features).toBeUndefined();
  });

  it('normalizes sizes and paths', () => {
    const f: Feature = { id: 'a', kind: 'mouth', on: 'head', azimuthDeg: 0, elevationDeg: 0, sizeMm: 1000, sizeIn: -1, path: [[400, 100], [NaN, 0], [10, -10]], mirror: false };
    const n = normalizeFeature(f);
    expect(n.sizeMm).toBe(40);
    expect(n.sizeIn).toBeUndefined();
    expect(n.path).toEqual([[40, 90], [10, -10]]);
    expect(n.mirror).toBeUndefined();
  });

  it('azimuth / elevation round trip (§3.5.2: 0° = front +Z, +90° = +X, elevation +90° = +Y)', () => {
    expect(directionAngles([0, 0, 1])).toEqual({ azimuthDeg: 0, elevationDeg: 0 });
    expect(directionAngles([1, 0, 0])).toEqual({ azimuthDeg: 90, elevationDeg: 0 });
    expect(directionAngles([0, 1, 0]).elevationDeg).toBe(90);
    for (const [a, e] of [[30, 20], [-120, -45], [179, 5]]) {
      const back = directionAngles(angleDirection(a, e));
      expect(back.azimuthDeg).toBeCloseTo(a, 6);
      expect(back.elevationDeg).toBeCloseTo(e, 6);
    }
  });
});

describe('proportions (§4.2, G23 through the kernel)', () => {
  it('head : body 1 : 1 and 1 : 3 hit their targets, the height stays, ears stay on the head', () => {
    const m = teddy();
    const H = modelHeight(m);
    for (const [b, frac] of [[1, 0.5], [3, 0.25]] as const) {
      const n = proportionsEdit({ headBody: b })(m);
      const head = byId(n).head as Part;
      const hb = worldBounds(head);
      expect((hb.max[1] - hb.min[1]) / modelHeight(n)).toBeCloseTo(frac, 2);
      expect(Math.abs(modelHeight(n) - H) / H).toBeLessThan(0.001);
      for (const ear of ['ear_l', 'ear_r']) expect(surfaceGap(byId(n)[ear], head)).toBeLessThanOrEqual(0.1);
      expect(valid(n)).toBe(true);
    }
    expect(readProportions(m)).toMatchObject({ headBody: 1.3, limbs: 'short' });
  });

  it('limbs "long" makes the arms 0.55·H; an unchanged reading is a no-op (the same model)', () => {
    const m = teddy();
    const n = proportionsEdit({ limbs: 'long' })(m);
    const arm = byId(n).arm_l as Extract<Part, { type: 'capsule' }>;
    expect(arm.dims.length / modelHeight(n)).toBeCloseTo(0.55, 2);
    expect(proportionsEdit({})(m)).toBe(m);
  });

  it('is off for models with sculpted (mesh) parts', () => {
    const m = teddy();
    const mesh: CrochetModelV1 = { ...m, parts: m.parts.map((p) => (p.id === 'tail' ? ({ ...p, type: 'mesh', dims: { meshRef: 'm1', bboxIn: [1, 1, 1] } } as Part) : p)) };
    expect(proportionsBlockedReason(mesh)).toMatch(/Sculpted/);
    expect(proportionsEdit({ headBody: 1 })(mesh)).toBe(mesh);
    expect(proportionsBlockedReason(m)).toBeNull();
  });

  it('a slider drag through many values is ONE history step and one revision; undo restores the model exactly', () => {
    const store = createProjectStore();
    openTeddy(store);
    const start = store.getState().doc!.threeD!.model!;
    const g = beginModelGesture('Head size', { store, linked: false })!;
    for (const b of [1.2, 1.6, 2.1, 2.6, 1.8]) g.update(proportionsEdit({ headBody: b }));
    g.end();
    const past = store.getState().history.past;
    expect(past).toHaveLength(1);
    expect(past[0].label).toBe('Head size');
    const after = store.getState().doc!.threeD!.model!;
    expect(after.revision).toBe(start.revision + 1);
    expect(readProportions(after).headBody).toBeCloseTo(1.8, 1);
    store.getState().undo();
    expect(store.getState().doc!.threeD!.model).toEqual(start);
    store.getState().close({ discardUnsaved: true });
  });
});

describe('encodeUv64 round trip used by the paint recipes', () => {
  it('is lossless', () => {
    const c = cells(3, [5, 9]);
    expect(decodeUv64(encodeUv64(c))).toEqual(c);
  });
});
