// Track T7 — the Claude Design round trip's store actions (DESIGN.md §3.7.7, §5.2.1). Sprint 2 brings Accept:
// one undo step that commits the imported model as a new revision (carried by the import itself, then
// `carry: 'none'`, integration S1 task T7.5), stores the original file and the mesh parts' buffers as assets,
// appends the `ImportRecord` and clears `qa.awaiting`. The Q&A actions follow in T7.3/T7.4.
import { keptMeshRefs, labelRemap, planImportAccept, remapMeshLabels } from '../../core/importer/accept';
import type { CarryReport } from '../../types/entryPoints';
import type { ColoredMesh } from '../../types/geometry';
import type { ImportResult } from '../../types/importer';
import type { AssetRef, ImportRecord } from '../../types/project';
import { projectStore, type ProjectStore } from '../projectStore';

/**
 * How mesh parts' buffers are stored as assets. The asset format of a `ColoredMesh` is not frozen yet (integration
 * request in docs/tracks/t7.md), so the caller supplies it; an import with mesh parts cannot be accepted without it.
 */
export interface MeshCodec {
  mime: string;
  encode(mesh: ColoredMesh): Blob;
  decode(blob: Blob): Promise<ColoredMesh>;
}

export interface AcceptImportInput {
  /** A successful `ImportResult` (its `model`, `meshes`, carrier, dialect, confidence and repairs are recorded). */
  result: ImportResult;
  /** The file the user dropped (kept as an asset, §3.7.7), or the pasted text. */
  original: { name: string; bytes: Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>; mime?: string };
  /** "Carry anyway" picks of the diff. */
  carryPaintAnyway?: readonly string[];
  /** The revision label; default "Imported from Claude Design". */
  label?: string;
  meshCodec?: MeshCodec;
  /** Ids and clock (tests pass fixed ones). */
  newId?: () => string;
  now?: () => Date;
}

export interface AcceptImportOutcome {
  /** The revision the import became (`ImportRecord.revision`). */
  revision: number;
  report: CarryReport;
  /** Carried features left out because Claude Design removed them from the seed it saw. */
  droppedFeatures: string[];
  record: ImportRecord;
}

const randomId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** §3.7.7 Accept: everything in one undo step. Rejects on a read-only project, a failed result or a missing codec. */
export async function acceptImport(input: AcceptImportInput, store: ProjectStore = projectStore): Promise<AcceptImportOutcome> {
  const { result } = input;
  if (!result.ok || !result.model) throw new Error('acceptImport: the import failed; there is nothing to accept');
  const state = store.getState();
  const doc = state.doc;
  if (!doc) throw new Error('acceptImport: no project is open');
  if (!doc.threeD) throw new Error('acceptImport: the project has no 3D model section');
  const session = state.session;
  const prev = doc.threeD.model;
  const seedFeatureIds = (doc.qa?.seed?.features ?? []).map((f) => f.id);
  const plan = planImportAccept(prev, result.model, { seedFeatureIds, ...(input.carryPaintAnyway ? { carryPaintAnyway: input.carryPaintAnyway } : {}) });

  // assets first (they are content-addressed: storing one that is not used in the end costs nothing but disk)
  const imported = result.meshes ?? {};
  const kept = keptMeshRefs(prev, plan.model, imported);
  if ((Object.keys(imported).length > 0 || kept.length > 0) && !input.meshCodec) {
    throw new Error('acceptImport: this import has mesh parts, and no mesh asset format was given (meshCodec)');
  }
  const original = await state.putAsset(
    input.original.bytes instanceof Blob ? input.original.bytes : new Blob([input.original.bytes as BlobPart]),
    input.original.mime ?? 'application/octet-stream',
  );
  const meshAssets: Record<string, AssetRef> = {};
  if (input.meshCodec) {
    const codec = input.meshCodec;
    for (const [ref, mesh] of Object.entries(imported)) meshAssets[ref] = await state.putAsset(codec.encode(mesh), codec.mime);
    if (kept.length > 0 && prev) {
      // kept mesh parts' labels index the previous palette: re-point them at the new one
      const table = labelRemap(prev.palette, plan.model.palette);
      for (const ref of kept) {
        const old = doc.threeD.meshAssets[ref];
        if (!old) continue;
        const mesh = await codec.decode(await state.getAsset(old));
        meshAssets[ref] = await state.putAsset(codec.encode(remapMeshLabels(mesh, table)), codec.mime);
      }
    }
  }
  const after = store.getState();
  if (after.session !== session || !after.doc?.threeD) throw new Error('acceptImport: the project changed while the import was being stored');
  // an edit made while the assets were stored: carry from the model as it is now
  let finalPlan = plan;
  if (after.doc.threeD.model !== prev) {
    const current = after.doc.threeD.model;
    finalPlan = planImportAccept(current, result.model, { seedFeatureIds: (after.doc.qa?.seed?.features ?? []).map((f) => f.id), ...(input.carryPaintAnyway ? { carryPaintAnyway: input.carryPaintAnyway } : {}) });
    if (keptMeshRefs(current, finalPlan.model, imported).join('\n') !== kept.join('\n')) throw new Error('acceptImport: the mesh parts changed while the import was being stored; try again');
  }

  const now = (input.now ?? (() => new Date()))();
  let record: ImportRecord | undefined;
  let revision = 0;
  await store.getState().commitModelRevisionWith(finalPlan.model, {
    source: 'import',
    label: input.label ?? 'Imported from Claude Design',
    carry: 'none',
    also: (draft, info) => {
      revision = info.rev;
      record = {
        id: (input.newId ?? randomId)(),
        at: now.toISOString(),
        fileName: input.original.name,
        carrier: result.carrier,
        dialect: result.dialect,
        confidence: result.confidence,
        repairs: result.repairs,
        original,
        revision: info.rev,
      };
      draft.imports.push(record);
      if (draft.threeD) for (const [ref, asset] of Object.entries(meshAssets)) draft.threeD.meshAssets[ref] = asset;
      if (draft.qa) delete draft.qa.awaiting;
    },
  });
  // the commit carried nothing itself (`carry: 'none'`): the plan's report is what was carried
  return { revision, report: finalPlan.report, droppedFeatures: finalPlan.droppedFeatures, record: record as ImportRecord };
}
