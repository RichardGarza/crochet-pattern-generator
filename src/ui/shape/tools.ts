// Track T6.2 — the Shape tab's structure tools as store actions (DESIGN.md §4.2): Add part, Duplicate, Delete,
// Mirror / Unlink, Attach, Make as and Start / axis. Each runs one pure recipe of `state/slices/model3d.ts` as ONE
// history step and then updates the editor's selection. Delete is destructive, so it also stores a model revision
// (§4.4, `commitModelRevision`).
import { notify } from '../../app/toasts';
import { worldToLocal } from '../../core/model/transforms';
import {
  addPart,
  addPartBlockedReason,
  attachPart,
  currentModel,
  deleteBlockedReason,
  deleteParts,
  duplicateBlockedReason,
  duplicateParts,
  editModel,
  mirrorBlockedReason,
  mirrorPair,
  mirrorParts,
  partName,
  planDelete,
  setAttachOptions,
  setCrochetHints,
  unlinkMirror,
  withRevision,
  type AddableType,
  type AttachMethod,
  type CrochetHintsPatch,
  type OpenEnd,
} from '../../state/slices/model3d';
import { commitModelRevision, projectStore } from '../../state/projectStore';
import type { CrochetModelV1, Vec3 } from '../../types/model';
import { TYPE_NAMES } from './dimSpecs';
import { editorStore } from './editorStore';

const readOnly = () => projectStore.getState().readOnly;

function names(model: CrochetModelV1, ids: readonly string[]): string {
  const list = ids.map((id) => model.parts.find((p) => p.id === id)).filter((p) => !!p).map((p) => partName(p));
  if (list.length <= 2) return list.join(' and ');
  return `${list.length} parts`;
}

/** The ids of the selection that still exist, in selection order. */
function selected(model: CrochetModelV1): string[] {
  const ids = new Set(model.parts.map((p) => p.id));
  return editorStore.getState().selection.filter((id) => ids.has(id));
}

// ---- Add part

/**
 * Adds a part of `type` on `parentId`: on the clicked point (`{ hit, normal }`) or on a side of it (`{ dir }`),
 * selects it and returns its id (null when it could not be added: the reason is shown).
 */
export function addPartAt(parentId: string, type: AddableType, at: { dir: Vec3 } | { hit: Vec3; normal: Vec3 }): string | null {
  const model = currentModel();
  if (!model || readOnly()) return null;
  const blocked = addPartBlockedReason(model, parentId);
  if (blocked) {
    notify.warn(blocked);
    return null;
  }
  let id: string | null = null;
  const label = TYPE_NAMES[type];
  const parent = model.parts.find((p) => p.id === parentId);
  editModel(`Add ${label.toLowerCase()} to ${parent ? partName(parent) : parentId}`, (m) => {
    const r = addPart(m, parentId, type, at, { label });
    id = r.id;
    return r.model;
  });
  if (id) {
    editorStore.getState().select(id);
    editorStore.getState().setTool('select');
  }
  return id;
}

/** Waits for a click on a part's surface to add a part of `type` there (Escape cancels). */
export function startPlacing(type: AddableType): void {
  editorStore.getState().setSurfacePick({ kind: 'add', type });
}

/** What the viewport calls when a part's surface is clicked while a surface pick is waiting. */
export function completeSurfacePick(partId: string, hit: Vec3, normal: Vec3): void {
  const pick = editorStore.getState().surfacePick;
  if (!pick) return;
  editorStore.getState().setSurfacePick(null);
  if (pick.kind === 'add') {
    addPartAt(partId, pick.type, { hit, normal });
    return;
  }
  // A mesh part's start point: the clicked point in the part's own frame.
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === pick.partId);
  if (!model || !part) return;
  if (partId !== pick.partId) {
    notify.info(`Click on ${partName(part)} itself to choose where its first round starts.`);
    editorStore.getState().setSurfacePick(pick);
    return;
  }
  setHints([part.id], { seed: worldToLocal(part, hit) }, `Start point of ${partName(part)}`);
}

// ---- Duplicate

export function duplicateSelection(): string[] {
  const model = currentModel();
  if (!model || readOnly()) return [];
  const ids = selected(model);
  const blocked = duplicateBlockedReason(model, ids);
  if (blocked) {
    notify.warn(blocked);
    return [];
  }
  let copies: string[] = [];
  editModel(`Duplicate ${names(model, ids)}`, (m) => {
    const r = duplicateParts(m, ids);
    copies = r.ids;
    return r.model;
  });
  if (copies.length > 0) editorStore.getState().setSelection(copies);
  return copies;
}

// ---- Delete

/** Asks to delete the selection (the dialog confirms, §4.2 "delete asks"). */
export function requestDeleteSelection(): void {
  const model = currentModel();
  if (!model || readOnly()) return;
  const ids = selected(model);
  if (ids.length === 0) return;
  const blocked = deleteBlockedReason(model, ids);
  if (blocked) {
    notify.warn(blocked);
    return;
  }
  editorStore.getState().requestDelete(ids);
}

/**
 * Deletes `ids` (children re-attached, §4.2) as one undo step that also stores a model revision (§4.4: destructive
 * actions are undoable and persisted as revisions). Resolves true when the parts were deleted.
 */
export async function deleteNow(ids: readonly string[]): Promise<boolean> {
  const model = currentModel();
  if (!model || readOnly()) return false;
  if (deleteBlockedReason(model, ids)) return false;
  const next = withRevision(model, deleteParts(model, ids));
  if (next === model) return false;
  try {
    await commitModelRevision(next, { source: 'edit', label: `Delete ${names(model, ids)}`, carry: 'none' });
  } catch (e) {
    notify.error(`The parts could not be deleted: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  const kept = new Set(next.parts.map((p) => p.id));
  editorStore.getState().prune(kept);
  return true;
}

/** The sentence the Delete dialog shows about the parts that stay. */
export function deleteSummary(model: CrochetModelV1, ids: readonly string[]): string[] {
  const plan = planDelete(model, ids);
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const name = (id: string) => {
    const p = byId.get(id);
    return p ? partName(p) : id;
  };
  const lines: string[] = [];
  if (plan.newRoot) lines.push(`${name(plan.newRoot)} becomes the main piece.`);
  const groups = new Map<string, string[]>();
  for (const r of plan.reattached) {
    if (!r.to) continue;
    const list = groups.get(r.to) ?? [];
    list.push(name(r.id));
    groups.set(r.to, list);
  }
  for (const [to, list] of groups) {
    const what = list.length <= 3 ? list.join(', ') : `${list.slice(0, 2).join(', ')} and ${list.length - 2} more`;
    lines.push(`${what} will be attached to ${name(to)} instead.`);
  }
  return lines;
}

// ---- Mirror

export function mirrorSelection(): string[] {
  const model = currentModel();
  if (!model || readOnly()) return [];
  const ids = selected(model);
  if (ids.length === 0) return [];
  const reasons = ids.map((id) => mirrorBlockedReason(model, id)).filter((r): r is string => !!r);
  if (reasons.length === ids.length) {
    notify.warn(reasons[0]);
    return [];
  }
  const relink = ids.every((id) => mirrorPair(model, id));
  let twins: string[] = [];
  editModel(
    relink ? `Mirror again ${names(model, ids)}` : `Mirror ${names(model, ids)}`,
    (m) => {
      const r = mirrorParts(m, ids);
      twins = r.twins;
      return r.model;
    },
    { linked: false },
  );
  return twins;
}

export function unlinkPart(partId: string): void {
  const model = currentModel();
  const pair = model ? mirrorPair(model, partId) : null;
  if (!model || !pair || readOnly()) return;
  editModel(`Unlink ${partName(pair.source)} and ${partName(pair.twin)}`, (m) => unlinkMirror(m, partId), { linked: false });
}

// ---- Attach

export function attachTo(partId: string, parentId: string, o: { openEnd?: OpenEnd | null; method?: AttachMethod | null } = {}): boolean {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  const parent = model?.parts.find((p) => p.id === parentId);
  if (!model || !part || !parent || readOnly()) return false;
  const label = part.attach?.to === parentId ? `Attachment of ${partName(part)}` : `Attach ${partName(part)} to ${partName(parent)}`;
  return editModel(label, (m) => attachPart(m, partId, parentId, o), { linked: false });
}

export function setAttach(partId: string, o: { openEnd?: OpenEnd | null; method?: AttachMethod | null }): boolean {
  const model = currentModel();
  const part = model?.parts.find((p) => p.id === partId);
  if (!model || !part || readOnly()) return false;
  return editModel(`Attachment of ${partName(part)}`, (m) => setAttachOptions(m, partId, o), { linked: false });
}

// ---- Make as, Start / axis

export function setHints(ids: readonly string[], patch: CrochetHintsPatch, label: string): boolean {
  if (readOnly()) return false;
  return editModel(label, (m) => setCrochetHints(m, ids, patch));
}
