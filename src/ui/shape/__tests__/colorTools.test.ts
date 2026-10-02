// Track T6.3 — the Colors tools as store actions (DESIGN.md §4.2, §2.11.1, §5.5.6; integration-s2 task T6-6): a brush
// stroke is ONE history step; mesh parts are read through the shared codec and painted as vertex labels (a new mesh
// asset, copy-on-write); a palette edit re-indexes mesh labels in the same step; Apply photo colors commits one new
// revision through `GeomApi.projectColors` (gated: a stub worker answers "not available").
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { meshAssetCodec, labelsAssetCodec } from '../../../core/kernel/assetCodecs';
import { decodeUv64, encodeUv64 } from '../../../core/model/builder';
import { NotImplementedError } from '../../../core/stub';
import { projectStore } from '../../../state/projectStore';
import { NO_LABEL, paletteIndex } from '../../../state/slices/model3d';
import { byId, openTeddy, teddy } from '../../../state/slices/__tests__/teddyProject';
import type { ColoredMesh } from '../../../types/geometry';
import type { CrochetModelV1, Part } from '../../../types/model';
import {
  addColor,
  addRegionTo,
  beginPaintStroke,
  changeColor,
  clearPaint,
  deleteColor,
  deleteRegion,
  endColorEdit,
  fillPartWithBrush,
  mergeColors,
  moveColor,
  pickColorAt,
  placeFeatureAt,
  placeRegionAt,
  reorderRegion,
} from '../colorTools';
import { editorStore } from '../editorStore';
import { loadModelMeshes, meshPreview, resetMeshCache } from '../meshAssets';
import { partSurface, pointAtAngles, toWorld } from '../paintField';
import { applyPhotoColors, photoColorsBlockedReason, photoColorsModel } from '../photoColors';

const model = () => projectStore.getState().doc!.threeD!.model!;
const past = () => projectStore.getState().history.past.map((e) => e.label);

/** An octahedron-ish blob of radius 0.5 (part-local, centered). */
function blob(): ColoredMesh {
  const positions = new Float32Array([0.5, 0, 0, -0.5, 0, 0, 0, 0.5, 0, 0, -0.5, 0, 0, 0, 0.5, 0, 0, -0.5]);
  const indices = new Uint32Array([0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5]);
  return { positions, indices, labels: new Uint8Array(6).fill(NO_LABEL) };
}

/** The teddy with its tail as a mesh part whose buffer is stored as an asset. */
async function openMeshTeddy(labels?: number[]): Promise<void> {
  const m = teddy();
  const tail = byId(m).tail;
  const meshTail = { ...tail, type: 'mesh', dims: { meshRef: 'tail_mesh', bboxIn: [1, 1, 1] } } as Part;
  openTeddy(projectStore, { model: { ...m, parts: m.parts.map((p) => (p.id === 'tail' ? meshTail : p)) } });
  const mesh = blob();
  if (labels) mesh.labels.set(labels);
  const ref = await projectStore.getState().putAsset(meshAssetCodec.encode(mesh), meshAssetCodec.mime);
  projectStore.getState().update('setup', (d) => {
    d.threeD!.meshAssets.tail_mesh = ref;
  });
  projectStore.setState({ history: { past: [], future: [] } as never });
}

beforeEach(() => {
  resetMeshCache();
  editorStore.getState().reset();
  openTeddy(projectStore);
});

afterEach(() => {
  projectStore.getState().close({ discardUnsaved: true });
});

describe('brush strokes', () => {
  it('a stroke over many points is ONE history step that paints the cells around each point', async () => {
    editorStore.getState().setPaint({ color: 'dark_brown_yarn', radiusIn: 0.4 });
    const stroke = beginPaintStroke('head', 'brush', {})!;
    const s = partSurface(byId(model()).head);
    for (let a = -30; a <= 30; a += 5) stroke.at(pointAtAngles(s, a, 0));
    await stroke.end();
    expect(past()).toEqual(['Paint Head']);
    const cells = decodeUv64(byId(model()).head.paint!.data)!;
    const brown = paletteIndex(model(), 'dark_brown_yarn');
    expect(cells.filter((c) => c === brown).length).toBeGreaterThan(40);
    expect(model().revision).toBe(teddy().revision + 1);
    // The eraser takes it back off, again as one step.
    const erase = beginPaintStroke('head', 'erase', {})!;
    for (let a = -30; a <= 30; a += 5) erase.at(pointAtAngles(s, a, 0));
    await erase.end();
    expect(past()).toEqual(['Paint Head', 'Erase paint on Head']);
    expect(byId(model()).head.paint).toBeUndefined();
  });

  it('cancel leaves no step; a read-only project cannot be painted', async () => {
    const stroke = beginPaintStroke('head', 'brush', {})!;
    stroke.at(pointAtAngles(partSurface(byId(model()).head), 0, 0));
    stroke.cancel();
    expect(byId(model()).head.paint).toBeUndefined();
    projectStore.getState().setReadOnly(true);
    expect(beginPaintStroke('head', 'brush', {})).toBeNull();
    expect(fillPartWithBrush('head')).toBe(false);
  });

  it('fill, eyedropper and clear', async () => {
    editorStore.getState().setPaint({ color: 'cream_yarn' });
    expect(fillPartWithBrush('tail')).toBe(true);
    expect(byId(model()).tail.color).toBe('cream_yarn');
    const head = byId(model()).head;
    const hit = toWorld(head, pointAtAngles(partSurface(head), 0, 0));
    expect(pickColorAt('head', hit, {})).toBe('caramel_yarn');
    expect(editorStore.getState().paint).toMatchObject({ color: 'caramel_yarn', mode: 'brush' });
    const stroke = beginPaintStroke('head', 'brush', {})!;
    stroke.at(pointAtAngles(partSurface(head), 0, 0));
    await stroke.end();
    expect(await clearPaint('head')).toBe(true);
    expect(byId(model()).head.paint).toBeUndefined();
  });
});

describe('mesh parts (decoded through the codec)', () => {
  it('loads the stored buffer, paints vertex labels into a NEW asset in one step; undo points back to the old one', async () => {
    await openMeshTeddy();
    const oldRef = projectStore.getState().doc!.threeD!.meshAssets.tail_mesh;
    const meshes = await loadModelMeshes();
    expect(meshes.tail_mesh.positions).toHaveLength(18);
    editorStore.getState().setPaint({ color: 'cream_yarn', radiusIn: 0.2 });
    const stroke = beginPaintStroke('tail', 'brush', meshes)!;
    stroke.at([0, 0, 0.5]);
    expect(meshPreview.getState().meshes.tail_mesh.labels[4]).toBe(1); // the preview shows at once
    await stroke.end();
    expect(meshPreview.getState().meshes.tail_mesh).toBeUndefined();
    const newRef = projectStore.getState().doc!.threeD!.meshAssets.tail_mesh;
    expect(newRef.key).not.toBe(oldRef.key);
    const stored = await meshAssetCodec.decode(await projectStore.getState().getAsset(newRef));
    expect(Array.from(stored.labels)).toEqual([NO_LABEL, NO_LABEL, NO_LABEL, NO_LABEL, 1, NO_LABEL]);
    expect(past()).toEqual(['Paint Tail']);
    projectStore.getState().undo();
    expect(projectStore.getState().doc!.threeD!.meshAssets.tail_mesh.key).toBe(oldRef.key);
  });

  it('merging colors re-indexes the mesh labels in the same step (s1 task 4)', async () => {
    // Labels: caramel (0), cream (1), dark brown (2), black (3).
    await openMeshTeddy([0, 1, 2, 3, NO_LABEL, 2]);
    expect(await mergeColors('dark_brown_yarn', 'cream_yarn')).toBe(true);
    expect(past()).toEqual(['Merge color dark_brown_yarn into cream_yarn']);
    const mesh = (await loadModelMeshes()).tail_mesh;
    // dark brown → cream (1); black moves from 3 to 2.
    expect(Array.from(mesh.labels)).toEqual([0, 1, 1, 2, NO_LABEL, 1]);
    expect(model().palette.map((c) => c.id)).toEqual(['caramel_yarn', 'cream_yarn', 'black_safety_eye']);
    projectStore.getState().undo();
    expect(Array.from((await loadModelMeshes()).tail_mesh.labels)).toEqual([0, 1, 2, 3, NO_LABEL, 2]);
  });

  it('a palette move re-indexes the mesh labels; deleting an unused color shifts them', async () => {
    await openMeshTeddy([3, 3, 0, 0, 0, 0]);
    expect(await moveColor('black_safety_eye', -3)).toBe(true);
    expect(Array.from((await loadModelMeshes()).tail_mesh.labels)).toEqual([0, 0, 1, 1, 1, 1]);
    addColor('#00ff00', 'green');
    expect(await deleteColor('green')).toBe(true);
    expect(await deleteColor('caramel_yarn')).toBe(false); // in use
  });
});

describe('palette, regions and details as store actions', () => {
  it('add / rename / recolor (a picker drag coalesces into one step)', () => {
    const id = addColor('#ff88aa', 'Pink')!;
    expect(id).toBe('pink');
    expect(editorStore.getState().paint.color).toBe('pink');
    for (const hex of ['#ff0000', '#ee0000', '#dd0000']) changeColor('pink', { hex });
    endColorEdit();
    changeColor('pink', { name: 'Ruby' });
    expect(past()).toEqual(['Add color Pink', 'Change color pink', 'Rename color pink']);
    expect(model().palette.at(-1)).toEqual({ id: 'pink', hex: '#DD0000', name: 'Ruby' });
  });

  it('regions: add (becomes the active one), place on the model, reorder, delete', () => {
    const i = addRegionTo('body', 'spot');
    expect(i).toBe(0);
    expect(editorStore.getState().activeRegion).toEqual({ partId: 'body', index: 0 });
    const body = byId(model()).body;
    const hit = toWorld(body, pointAtAngles(partSurface(body), 60, 20));
    expect(placeRegionAt('body', 0, hit)).toBe(true);
    expect(byId(model()).body.regions![0]).toMatchObject({ kind: 'spot' });
    const spot = byId(model()).body.regions![0] as Extract<NonNullable<Part['regions']>[number], { kind: 'spot' }>;
    expect(spot.azimuthDeg).toBeCloseTo(60, 0);
    expect(spot.elevationDeg).toBeCloseTo(20, 0);
    addRegionTo('body', 'band');
    expect(reorderRegion('body', 1, -1)).toBe(true);
    expect(byId(model()).body.regions!.map((r) => r.kind)).toEqual(['band', 'spot']);
    expect(editorStore.getState().activeRegion).toEqual({ partId: 'body', index: 0 });
    expect(deleteRegion('body', 0)).toBe(true);
    expect(editorStore.getState().activeRegion).toBeNull();
  });

  it('details: an eye placed by a click on the head, a mouth from clicked points', () => {
    const head = byId(model()).head;
    const s = partSurface(head);
    const id = placeFeatureAt('safety_eye', 'head', toWorld(head, pointAtAngles(s, 25, 15)))!;
    const eye = model().features!.find((f) => f.id === id)!;
    expect(eye).toMatchObject({ kind: 'safety_eye', on: 'head', mirror: true });
    expect(eye.azimuthDeg).toBeCloseTo(25, 0);
    const pts = [-20, -10, 0, 10, 20].map((a) => toWorld(head, pointAtAngles(s, a, -20 + Math.abs(a) / 4)));
    const mouth = placeFeatureAt('mouth', 'head', pts[0], pts)!;
    expect(model().features!.find((f) => f.id === mouth)!.path).toHaveLength(5);
  });
});

describe('Apply photo colors (§2.9.6, gated on T3)', () => {
  async function withViews(): Promise<void> {
    const labels = new Int8Array(16).fill(-1);
    labels.fill(0, 4, 12);
    const ref = await projectStore.getState().putAsset(labelsAssetCodec.encode({ w: 4, h: 4, labels }), labelsAssetCodec.mime);
    projectStore.getState().update('views', (d) => {
      d.threeD!.views = [{ id: 'front', imageKey: 'img', label: 'front', labelsKey: ref.key, align: { scale: 1, dx: 0, dy: 0, rot90: 0, mirror: false } }];
      d.threeD!.photoPalette = [{ hex: '#B07A4A' }, { hex: '#FF00FF', name: 'magenta' }];
    });
  }

  it('is offered only with labelled views and a photo palette', async () => {
    expect(photoColorsBlockedReason(projectStore.getState().doc)).toMatch(/No photo/);
    await withViews();
    expect(photoColorsBlockedReason(projectStore.getState().doc)).toBeNull();
    expect(photoColorsBlockedReason(projectStore.getState().doc, true)).toMatch(/read-only/);
  });

  it('commits the worker’s paint and palette as ONE new revision "Applied photo colors"', async () => {
    await withViews();
    const revs = projectStore.getState().doc!.threeD!.revisions.length;
    const cells = new Uint8Array(4096).fill(0);
    cells.fill(4, 0, 64);
    let request: unknown;
    const out = await applyPhotoColors({
      projectColors: async (r) => {
        request = r;
        return { paint: { body: { kind: 'uv64', data: encodeUv64(cells) } }, palette: [...r.palette, { id: 'magenta', hex: '#FF00FF', name: 'magenta' }], viewIoU: { front: 0.93 }, issues: [] };
      },
    });
    expect(out.kind).toBe('applied');
    const r = request as { views: { mask: Uint8Array; labels: Int8Array }[] };
    expect(Array.from(r.views[0].mask)).toEqual(Array.from(r.views[0].labels).map((l) => (l >= 0 ? 1 : 0)));
    // One new revision (the store also keeps the model as it was, "Before: …", when it had no snapshot yet).
    const added = projectStore.getState().doc!.threeD!.revisions.slice(revs);
    expect(added.filter((r) => !r.label.startsWith('Before:'))).toHaveLength(1);
    expect(projectStore.getState().doc!.threeD!.revisions.at(-1)!.label).toBe('Applied photo colors');
    expect(model().palette.at(-1)!.id).toBe('magenta');
    expect(decodeUv64(byId(model()).body.paint!.data)![0]).toBe(4);
    expect(past().at(-1)).toBe('Applied photo colors');
  });

  it('says "not available" while the worker is a stub, and changes nothing', async () => {
    await withViews();
    const before = model();
    const out = await applyPhotoColors({ projectColors: async () => Promise.reject(new NotImplementedError('GeomApi.projectColors')) });
    expect(out).toEqual({ kind: 'unavailable' });
    expect(model()).toBe(before);
  });

  it('maps mesh labels and drops labels past the palette', () => {
    const m: CrochetModelV1 = { ...teddy(), parts: teddy().parts.map((p) => (p.id === 'tail' ? ({ ...p, type: 'mesh', dims: { meshRef: 't', bboxIn: [1, 1, 1] } } as Part) : p)) };
    const mesh = blob();
    const { next, meshes } = photoColorsModel(m, { paint: { tail: new Uint8Array([0, 1, 9, 3, 2, 255]) }, palette: m.palette }, { t: mesh });
    expect(next).toBe(m);
    expect(Array.from(meshes.t.labels)).toEqual([0, 1, NO_LABEL, 3, 2, NO_LABEL]);
  });
});
