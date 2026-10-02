// Track T6.3 — "Apply photo colors" (DESIGN.md §2.9.6, §4.2 Paint): re-projects the photos' stored labels onto the
// CURRENT model through `GeomApi.projectColors` (T3, geom.worker) and commits the result as a new authored model
// revision "Applied photo colors" — primitives get a uv64 paint field, mesh parts new vertex labels (stored as new
// mesh assets through the shared codec), the palette gains the photo colors that no model color is close to.
//
// It reads only stored assets: each labelled view's label image (`PhotoView.labelsKey`, `labelsAssetCodec`) and the
// project's photo palette, so it works after a reload or a Claude Design import days later. The mask sent with a
// view is the label image's own footprint (labels are −1 outside the mask, §2.9.6), so no second asset format is
// needed. T3 implements `projectColors` in T3.4: until then the worker rejects with NotImplementedError and the
// button says the feature is not available yet (`isImplemented` cannot see into a worker, `core/stub.ts`).
import { labelsAssetCodec } from '../../core/kernel/assetCodecs';
import { isNotImplementedError } from '../../core/stub';
import { currentModel, setPartPaint, withRevision } from '../../state/slices/model3d';
import { projectStore, type ProjectStore } from '../../state/projectStore';
import type { ColoredMesh, PhotoView } from '../../types/geometry';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, Part } from '../../types/model';
import type { AssetRef, ProjectDoc } from '../../types/project';
import type { GeomApi } from '../../types/workers';
import { workers } from '../../workers/client';
import { decodeUv64 } from '../../core/model/builder';
import { loadModelMeshes, storeMeshes } from './meshAssets';

type ProjectColors = (r: Omit<Parameters<GeomApi['projectColors']>[0], 'jobId'>) => ReturnType<GeomApi['projectColors']>;

/** The views Apply photo colors can use: those with a stored label image. */
export function labelledViews(doc: Pick<ProjectDoc, 'threeD'> | null | undefined): PhotoView[] {
  return (doc?.threeD?.views ?? []).filter((v) => typeof v.labelsKey === 'string' && v.labelsKey.length > 0);
}

/** Why Apply photo colors cannot run, or null. */
export function photoColorsBlockedReason(doc: Pick<ProjectDoc, 'threeD'> | null | undefined, readOnly = false): string | null {
  if (!doc?.threeD?.model) return 'There is no model to color yet';
  if (readOnly) return 'This project is read-only';
  if (labelledViews(doc).length === 0) return 'No photo of this project has colors to apply';
  if (!doc.threeD.photoPalette || doc.threeD.photoPalette.length === 0) return 'The photos’ colors are missing; rebuild from the photos first';
  return null;
}

export type PhotoColorsOutcome =
  | { kind: 'applied'; rev: number; viewIoU: Record<string, number>; issues: Issue[]; skipped: string[] }
  | { kind: 'unavailable' }
  | { kind: 'blocked'; reason: string }
  | { kind: 'failed'; message: string }
  | { kind: 'stale' };

/** IoU below which a view is skipped with a warning (§2.9.6). */
export const MIN_VIEW_IOU = 0.8;

/**
 * Applies the photos' colors to the current model (§2.9.6). One undo step and a new model revision; nothing
 * changes when the worker is not available, fails, or the project changed meanwhile.
 */
export async function applyPhotoColors(o: { store?: ProjectStore; projectColors?: ProjectColors } = {}): Promise<PhotoColorsOutcome> {
  const store = o.store ?? projectStore;
  const run = o.projectColors ?? ((r) => workers.geom.projectColors(r));
  const state = store.getState();
  const doc = state.doc;
  const blocked = photoColorsBlockedReason(doc, state.readOnly);
  if (blocked || !doc?.threeD?.model) return { kind: 'blocked', reason: blocked ?? 'There is no model to color yet' };
  const model = doc.threeD.model;
  const session = state.session;
  let result: Awaited<ReturnType<GeomApi['projectColors']>>;
  try {
    const views = await Promise.all(
      labelledViews(doc).map(async (view) => {
        const img = await labelsAssetCodec.decode(await store.getState().getAsset(view.labelsKey as string));
        const mask = new Uint8Array(img.labels.length);
        for (let i = 0; i < mask.length; i++) mask[i] = img.labels[i] >= 0 ? 1 : 0;
        return { view, labels: img.labels, mask, w: img.w, h: img.h };
      }),
    );
    const meshes = await loadModelMeshes(store);
    result = await run({ model, meshes, views, photoPalette: doc.threeD.photoPalette ?? [], palette: model.palette });
  } catch (e) {
    if (isNotImplementedError(e)) return { kind: 'unavailable' };
    return { kind: 'failed', message: e instanceof Error ? e.message : String(e) };
  }
  if (store.getState().session !== session || currentModel(store) !== model) return { kind: 'stale' };

  const { next, meshes } = photoColorsModel(model, result, await loadModelMeshes(store));
  let refs: Record<string, AssetRef> = {};
  if (Object.keys(meshes).length > 0) refs = await storeMeshes(meshes, store);
  if (store.getState().session !== session || currentModel(store) !== model) return { kind: 'stale' };
  const report = await store.getState().commitModelRevisionWith(withRevision(model, next), {
    source: 'edit',
    label: 'Applied photo colors',
    carry: 'none',
    also: (draft) => {
      if (!draft.threeD) return;
      for (const [meshRef, ref] of Object.entries(refs)) draft.threeD.meshAssets[meshRef] = ref;
    },
  });
  void report;
  const skipped = Object.entries(result.viewIoU)
    .filter(([, iou]) => !(iou >= MIN_VIEW_IOU))
    .map(([id]) => id);
  const rev = store.getState().doc?.threeD?.revisions.at(-1)?.rev ?? 0;
  return { kind: 'applied', rev, viewIoU: result.viewIoU, issues: result.issues, skipped };
}

/**
 * The model with the worker's colors: its palette, each primitive's uv64 paint (a `paint` object or base64 data),
 * and new vertex labels for mesh parts (returned by meshRef; labels outside the palette become "unknown").
 */
export function photoColorsModel(
  model: CrochetModelV1,
  result: Pick<Awaited<ReturnType<GeomApi['projectColors']>>, 'paint' | 'palette'>,
  meshes: Readonly<Record<string, ColoredMesh>>,
): { next: CrochetModelV1; meshes: Record<string, ColoredMesh> } {
  const palette = result.palette.length > 0 && result.palette.length <= 16 ? result.palette : model.palette;
  let next: CrochetModelV1 = palette === model.palette ? model : { ...model, palette };
  const changedMeshes: Record<string, ColoredMesh> = {};
  for (const part of model.parts) {
    if (!Object.hasOwn(result.paint, part.id)) continue;
    const value = result.paint[part.id];
    if (part.type === 'mesh') {
      const mesh = meshes[part.dims.meshRef];
      if (!(value instanceof Uint8Array) || !mesh || value.length !== mesh.labels.length) continue;
      const labels = new Uint8Array(value.length);
      for (let i = 0; i < labels.length; i++) labels[i] = value[i] < palette.length ? value[i] : 255;
      changedMeshes[part.dims.meshRef] = { ...mesh, labels };
    } else if (value && !(value instanceof Uint8Array) && (value as Part['paint'])?.kind === 'uv64') {
      const cells = decodeUv64((value as NonNullable<Part['paint']>).data);
      if (cells) next = setPartPaint(next, part.id, cells);
    }
  }
  return { next, meshes: changedMeshes };
}
