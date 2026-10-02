// Track T6.3 — the Colors tools as store actions (DESIGN.md §4.2 Paint, Palette, Features; §2.11.1): each one runs
// pure recipes of `state/slices/model3d.ts` as ONE history step through `projectStore.update`. A brush stroke is one
// step from pointer-down to pointer-up; a palette edit that re-indexes colors also re-indexes the mesh parts' vertex
// labels (new mesh assets) in the same step.
import { notify } from '../../app/toasts';
import { worldToLocal } from '../../core/model/transforms';
import {
  addFeature,
  addPaletteColor,
  addRegion,
  beginModelGesture,
  currentModel,
  defaultFeature,
  defaultRegion,
  directionAngles,
  editModel,
  fillPart,
  mergePaletteColors,
  movePaletteColor,
  moveRegion,
  NO_LABEL,
  paintCellsOf,
  paletteIndex,
  partName,
  remapMeshLabels,
  removeFeature,
  removePaletteColor,
  removeRegion,
  setPaletteColor,
  setPartPaint,
  updateFeature,
  updateRegion,
  type FeatureKind,
  type PaletteRemap,
  type RegionKind,
} from '../../state/slices/model3d';
import { projectStore } from '../../state/projectStore';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, Feature, Part, Region, Vec3 } from '../../types/model';
import { editorStore, type PaintMode } from './editorStore';
import { cachedMesh, editModelWithMeshes, meshRefsOf, rememberMesh, setMeshPreview, storeMeshes } from './meshAssets';
import { brushCells, brushVertices, colorIdAt, nearestVertex, paintInto, paintVertices, partSurface } from './paintField';

const readOnly = () => projectStore.getState().readOnly;

/** The palette id the brush uses: the chosen one if it still exists, else the first color. */
export function brushColor(model: Pick<CrochetModelV1, 'palette'>, chosen: string | null): string {
  return chosen && paletteIndex(model, chosen) >= 0 ? chosen : model.palette[0]?.id ?? '';
}

// ---- brush strokes

/** One brush (or eraser) stroke: `at` paints around a part-local point; `end` seals ONE history step. */
export interface PaintStroke {
  readonly partId: string;
  at(local: Vec3): void;
  end(): Promise<void>;
  cancel(): void;
}

/** Starts a stroke on a part (null when nothing can be painted: read-only, no model, unknown part). */
export function beginPaintStroke(partId: string, mode: Extract<PaintMode, 'brush' | 'erase'>, meshes: Readonly<Record<string, ColoredMesh>>): PaintStroke | null {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return null;
  const { paint } = editorStore.getState();
  const label = mode === 'erase' ? NO_LABEL : paletteIndex(model, brushColor(model, paint.color));
  if (label < 0) return null;
  const radius = paint.radiusIn;
  const name = partName(part);
  if (part.type === 'mesh') return meshStroke(part, label, radius, meshes, mode === 'erase' ? `Erase paint on ${name}` : `Paint ${name}`);
  const gesture = beginModelGesture(mode === 'erase' ? `Erase paint on ${name}` : `Paint ${name}`);
  if (!gesture) return null;
  const surface = partSurface(part);
  let cells = paintCellsOf(part);
  return {
    partId,
    at(local) {
      const next = paintInto(cells, brushCells(surface, local, radius), label);
      if (next === cells) return;
      cells = next;
      gesture.update((m) => setPartPaint(m, partId, cells));
    },
    async end() {
      gesture.end();
    },
    cancel() {
      gesture.cancel();
    },
  };
}

function meshStroke(part: Extract<Part, { type: 'mesh' }>, label: number, radius: number, meshes: Readonly<Record<string, ColoredMesh>>, historyLabel: string): PaintStroke | null {
  const meshRef = part.dims.meshRef;
  const start = meshes[meshRef];
  if (!start) {
    notify.warn(`${partName(part)} is still loading; try again in a moment.`);
    return null;
  }
  let mesh = start;
  let done = false;
  return {
    partId: part.id,
    at(local) {
      if (done) return;
      const next = paintVertices(mesh, brushVertices(mesh, local, radius), label);
      if (next === mesh) return;
      mesh = next;
      setMeshPreview(meshRef, mesh);
    },
    async end() {
      if (done) return;
      done = true;
      try {
        if (mesh === start) return;
        const store = projectStore;
        const before = store.getState().doc;
        const [ref] = Object.values(await storeMeshes({ [meshRef]: mesh }));
        if (store.getState().doc?.threeD?.model !== before?.threeD?.model) return;
        rememberMesh(ref.key, mesh);
        store.getState().update(historyLabel, (draft) => {
          if (!draft.threeD?.model) return;
          draft.threeD.meshAssets[meshRef] = ref;
          draft.threeD.model.revision += 1;
        });
      } catch (e) {
        notify.error(`The paint could not be saved: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setMeshPreview(meshRef, null);
      }
    },
    cancel() {
      done = true;
      setMeshPreview(meshRef, null);
    },
  };
}

/** Fill: the part takes the brush color as its base color; its brush strokes are cleared. */
export function fillPartWithBrush(partId: string): boolean {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return false;
  const color = brushColor(model, editorStore.getState().paint.color);
  return editModel(`Fill ${partName(part)}`, (m) => fillPart(m, partId, color));
}

/** Clears a part's brush strokes (primitives: the paint field; mesh parts: every vertex label). */
export async function clearPaint(partId: string): Promise<boolean> {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return false;
  if (part.type !== 'mesh') return editModel(`Clear paint on ${partName(part)}`, (m) => setPartPaint(m, partId, null));
  return editModelWithMeshes(`Clear paint on ${partName(part)}`, (m, meshes) => {
    const mesh = meshes[part.dims.meshRef];
    if (!mesh) return { model: m };
    return { model: m, meshes: { [part.dims.meshRef]: { ...mesh, labels: new Uint8Array(mesh.labels.length).fill(NO_LABEL) } } };
  });
}

/** The eyedropper: the color shown at a model-space point of a part becomes the brush color. Returns its id. */
export function pickColorAt(partId: string, hitWorld: Vec3, meshes: Readonly<Record<string, ColoredMesh>>): string | null {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part) return null;
  const local = worldToLocal(part, hitWorld);
  const mesh = part.type === 'mesh' ? meshes[part.dims.meshRef] : undefined;
  const surface = partSurface(part, meshes);
  const label = mesh ? mesh.labels[nearestVertex(mesh, local)] : undefined;
  const id = colorIdAt(
    part,
    surface.frame,
    local,
    model.palette.map((c) => c.id),
    part.type === 'mesh' ? null : paintCellsOf(part),
    label,
  );
  editorStore.getState().setPaint({ color: id, mode: 'brush' });
  return id;
}

// ---- palette

export function addColor(hex: string, name?: string): string | null {
  if (readOnly()) return null;
  let id: string | null = null;
  editModel(`Add color ${name ?? hex}`, (m) => {
    const r = addPaletteColor(m, hex, { name });
    id = r.id;
    return r.model;
  });
  if (id) editorStore.getState().setPaint({ color: id });
  return id;
}

/** Changes a color's hex (typing or dragging a color picker coalesces into one step per color) or name. */
export function changeColor(id: string, patch: { hex?: string; name?: string | null }): boolean {
  if (readOnly()) return false;
  return editModel(patch.hex !== undefined ? `Change color ${id}` : `Rename color ${id}`, (m) => setPaletteColor(m, id, patch), {
    coalesceKey: `t6-color-${patch.hex !== undefined ? 'hex' : 'name'}-${id}`,
    linked: false,
  });
}

/** Ends a coalesced color edit (the picker closed, the field lost focus). */
export function endColorEdit(): void {
  projectStore.getState().endCoalescing();
}

/** A palette edit that may re-index colors: the paint and the mesh labels follow in the same step. */
function paletteEdit(label: string, edit: (m: CrochetModelV1) => PaletteRemap): Promise<boolean> {
  if (readOnly()) return Promise.resolve(false);
  return editModelWithMeshes(label, (m, meshes) => {
    const r = edit(m);
    if (!r.reindexed) return { model: r.model };
    const changed: Record<string, ColoredMesh> = {};
    for (const [meshRef, mesh] of Object.entries(meshes)) {
      const next = remapMeshLabels(mesh, r.labelMap);
      if (next !== mesh) changed[meshRef] = next;
    }
    return { model: r.model, meshes: changed };
  });
}

export async function mergeColors(fromId: string, intoId: string): Promise<boolean> {
  const ok = await paletteEdit(`Merge color ${fromId} into ${intoId}`, (m) => mergePaletteColors(m, fromId, intoId));
  if (ok && editorStore.getState().paint.color === fromId) editorStore.getState().setPaint({ color: intoId });
  return ok;
}

export function deleteColor(id: string, meshLabels = 0): Promise<boolean> {
  return paletteEdit(`Delete color ${id}`, (m) => removePaletteColor(m, id, meshLabels));
}

export function moveColor(id: string, delta: number): Promise<boolean> {
  return paletteEdit(delta < 0 ? `Move color ${id} up` : `Move color ${id} down`, (m) => movePaletteColor(m, id, delta));
}

/** How many vertex labels of the loaded mesh parts use a palette index (Delete is refused while any do). */
export function meshLabelUse(index: number, meshes: Readonly<Record<string, ColoredMesh>>): number {
  let n = 0;
  for (const mesh of Object.values(meshes)) for (const v of mesh.labels) if (v === index) n++;
  return n;
}

/** The open model's mesh buffers that are already decoded (for counts in the UI). */
export function loadedMeshes(): Record<string, ColoredMesh> {
  const out: Record<string, ColoredMesh> = {};
  for (const [meshRef, ref] of Object.entries(meshRefsOf(projectStore.getState().doc))) {
    const m = cachedMesh(ref);
    if (m) out[meshRef] = m;
  }
  return out;
}

// ---- regions

export function addRegionTo(partId: string, kind: RegionKind): number {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return -1;
  const brush = brushColor(model, editorStore.getState().paint.color);
  const colors = [brush === part.color ? (model.palette.find((c) => c.id !== part.color)?.id ?? brush) : brush, part.color];
  let index = -1;
  const names: Record<RegionKind, string> = { band: 'band', stripes: 'stripes', patch: 'patch', spot: 'spot' };
  editModel(`Add ${names[kind]} to ${partName(part)}`, (m) => {
    const r = addRegion(m, partId, defaultRegion(kind, part, colors));
    index = r.index;
    return r.model;
  });
  if (index >= 0) editorStore.getState().setActiveRegion({ partId, index });
  return index;
}

/** Changes a region; `coalesceKey` makes a slider drag one step. */
export function changeRegion(partId: string, index: number, region: Region, o: { coalesceKey?: string } = {}): boolean {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return false;
  return editModel(`Change ${region.kind} on ${partName(part)}`, (m) => updateRegion(m, partId, index, region), o);
}

export function deleteRegion(partId: string, index: number): boolean {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return false;
  const kind = part.regions?.[index]?.kind ?? 'region';
  const ok = editModel(`Remove ${kind} from ${partName(part)}`, (m) => removeRegion(m, partId, index));
  const active = editorStore.getState().activeRegion;
  if (ok && active?.partId === partId) editorStore.getState().setActiveRegion(active.index === index ? null : { partId, index: active.index > index ? active.index - 1 : active.index });
  return ok;
}

export function reorderRegion(partId: string, index: number, delta: number): boolean {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return false;
  const ok = editModel(`Reorder colors on ${partName(part)}`, (m) => moveRegion(m, partId, index, delta));
  if (ok) {
    const n = part.regions?.length ?? 0;
    editorStore.getState().setActiveRegion({ partId, index: Math.min(n - 1, Math.max(0, index + delta)) });
  }
  return ok;
}

/** A patch or spot moved to a clicked point (the "Place on the model" pick). */
export function placeRegionAt(partId: string, index: number, hitWorld: Vec3): boolean {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  const r = part?.regions?.[index];
  if (!model || !part || !r || readOnly()) return false;
  const surface = partSurface(part);
  const local = worldToLocal(part, hitWorld);
  if (r.kind === 'spot') {
    const a = directionAngles(local, surface.frame.ctr);
    return changeRegion(partId, index, { ...r, azimuthDeg: a.azimuthDeg, elevationDeg: a.elevationDeg });
  }
  if (r.kind === 'patch') {
    const dx = local[0] - surface.frame.ctr[0];
    const dz = local[2] - surface.frame.ctr[2];
    const t = (local[1] - surface.frame.min[1]) / surface.frame.H;
    const half = (r.to - r.from) / 2;
    const mid = Math.min(1 - half, Math.max(half, t));
    return changeRegion(partId, index, { ...r, azimuthDeg: (Math.atan2(dx, dz) * 180) / Math.PI, from: mid - half, to: mid + half });
  }
  return false;
}

// ---- features (face details)

/** Places a detail of `kind` where a part was clicked (model space). Returns its id. */
export function placeFeatureAt(kind: FeatureKind, partId: string, hitWorld: Vec3, path?: Vec3[]): string | null {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return null;
  const surface = partSurface(part);
  const pts = (path && path.length > 0 ? path : [hitWorld]).map((w) => directionAngles(worldToLocal(part, w), surface.frame.ctr));
  const first = pts[0];
  const color = editorStore.getState().paint.color;
  const f = defaultFeature(kind, part, first.azimuthDeg, first.elevationDeg, color && paletteIndex(model, color) >= 0 && kind !== 'safety_eye' ? color : undefined);
  if (path && path.length > 1) f.path = pts.map((p): [number, number] => [p.azimuthDeg, p.elevationDeg]);
  let id: string | null = null;
  editModel(`Add ${FEATURE_NAMES[kind].toLowerCase()} on ${partName(part)}`, (m) => {
    const r = addFeature(m, f);
    id = r.id;
    return r.model;
  });
  return id;
}

export function changeFeature(id: string, patch: Partial<Omit<Feature, 'id' | 'color'>> & { color?: string | null }, o: { coalesceKey?: string } = {}): boolean {
  if (readOnly()) return false;
  const f = currentModel()?.features?.find((x) => x.id === id);
  if (!f) return false;
  return editModel(`Change ${FEATURE_NAMES[f.kind].toLowerCase()}`, (m) => updateFeature(m, id, patch), o);
}

export function deleteFeature(id: string): boolean {
  if (readOnly()) return false;
  const f = currentModel()?.features?.find((x) => x.id === id);
  if (!f) return false;
  return editModel(`Remove ${FEATURE_NAMES[f.kind].toLowerCase()}`, (m) => removeFeature(m, id));
}

/** Friendly names of the detail kinds. */
export const FEATURE_NAMES: Readonly<Record<FeatureKind, string>> = {
  safety_eye: 'Safety eye',
  embroidered_eye: 'Embroidered eye',
  nose: 'Nose',
  mouth: 'Mouth',
  cheek: 'Cheek',
  brow: 'Eyebrow',
  whiskers: 'Whiskers',
  line: 'Embroidered line',
  felt: 'Felt piece',
  applique: 'Appliqué',
};

/** What each detail is, in crocheters' words. */
export const FEATURE_HINTS: Readonly<Record<FeatureKind, string>> = {
  safety_eye: 'A plastic eye pushed through the fabric (not for children under 3).',
  embroidered_eye: 'An eye stitched on with yarn: safe for babies.',
  nose: 'A small stitched or crocheted nose.',
  mouth: 'Embroidered: click the points of the smile on the model.',
  cheek: 'A soft round blush patch.',
  brow: 'Embroidered: click along the brow.',
  whiskers: 'Embroidered lines: click along a whisker.',
  line: 'Any embroidered line: click its points.',
  felt: 'A felt shape glued or sewn on.',
  applique: 'A small flat crocheted shape sewn on.',
};
