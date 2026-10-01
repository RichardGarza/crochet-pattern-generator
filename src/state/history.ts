// Undo and redo on immer patches (DESIGN.md §5.3, §4.4). Step 0 owned.
//
// Pure functions over immutable values — no store, no DOM. projectStore.ts keeps a `History` next to the
// document and calls these; every authored change of a project goes through `applyRecipe` + `record`.
//
//   - an entry holds the patches of one step (redo) and their inverse (undo), a label for the History list and
//     an optional coalesce key;
//   - consecutive changes with the same coalesce key are ONE entry (a gizmo drag from pointer-down to
//     pointer-up, typing in a field): the entry is re-derived from the document before the run and the
//     document after it, so it stays as small as one change however long the drag was;
//   - a run ends with any other change, with undo or redo, and with `seal` (pointer-up);
//   - at most HISTORY_LIMIT entries are kept: the oldest steps can no longer be undone;
//   - a new change clears the redo stack; a change that changes nothing is not recorded and clears nothing.
import { applyPatches, enablePatches, produceWithPatches, type Draft, type Objectish, type Patch } from 'immer';

enablePatches();

/** "200 steps per session" (§4.4). */
export const HISTORY_LIMIT = 200;

export interface HistoryEntry {
  /** Increasing within one history; stable while the entry moves between `past` and `future`. */
  readonly id: number;
  /** Shown in the History list and in the undo / redo tooltips. */
  readonly label: string;
  readonly coalesceKey?: string;
  /** Redo: the document before the step → the document after it. */
  readonly patches: readonly Patch[];
  /** Undo: the document after the step → the document before it. */
  readonly inverse: readonly Patch[];
}

export interface History {
  /** Oldest first; the last entry is the next one to undo. At most HISTORY_LIMIT entries. */
  readonly past: readonly HistoryEntry[];
  /** The undone entries; the last one is the next to redo. */
  readonly future: readonly HistoryEntry[];
  /** True while the last entry of `past` still absorbs changes that carry its coalesce key. */
  readonly open: boolean;
  /** The id the next new entry gets. */
  readonly nextId: number;
}

export function emptyHistory(): History {
  return { past: [], future: [], open: false, nextId: 1 };
}

/** One change of a document: the new document and the patches between the two. */
export interface Change<T> {
  doc: T;
  patches: Patch[];
  inverse: Patch[];
}

/** What `record` needs to know about a change. */
export interface ChangeRecord {
  label: string;
  coalesceKey?: string;
  patches: readonly Patch[];
  inverse: readonly Patch[];
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Runs an immer recipe on `doc` and returns the new document with its patches. `doc` itself is never
 * changed; the result shares every untouched branch with it and is deeply frozen.
 *
 * The recipe mutates the draft; what it returns is ignored, so `(d) => d.items.push(x)` and
 * `(d) => (d.name = 'x')` are fine (plain immer would refuse both). It must be synchronous: a recipe that
 * returns a promise throws, and nothing is changed. A recipe that throws changes nothing either.
 */
export function applyRecipe<T extends Objectish>(doc: T, recipe: (draft: Draft<T>) => unknown): Change<T> {
  const [next, patches, inverse] = produceWithPatches(doc, (draft: Draft<T>) => {
    const returned = recipe(draft);
    if (isThenable(returned)) {
      // The async body will fail on the revoked draft later; that failure is already reported here.
      Promise.resolve(returned).catch(() => {});
      throw new TypeError('A recipe must be synchronous: do the async work first, then change the document in one step.');
    }
  });
  return { doc: next, patches, inverse };
}

/**
 * One entry for a coalesced run: the patches from the document before the run to `docAfter`, and their
 * inverse. Returns null when the run ended where it started.
 */
function mergeIntoEntry<T extends Objectish>(docAfter: T, entry: HistoryEntry, change: ChangeRecord): HistoryEntry | null {
  const before = applyPatches(docAfter, [...change.inverse, ...entry.inverse]);
  const [, patches, inverse] = produceWithPatches(before, (draft) => {
    applyPatches(draft as Objectish, [...entry.patches, ...change.patches]);
  });
  if (patches.length === 0) return null;
  return { id: entry.id, label: change.label, coalesceKey: entry.coalesceKey, patches, inverse };
}

/**
 * Records a change that was just applied; `docAfter` is the document after it. Returns the same history when
 * the change has no patches.
 */
export function record<T extends Objectish>(history: History, docAfter: T, change: ChangeRecord, limit: number = HISTORY_LIMIT): History {
  if (change.patches.length === 0) return history;
  const last = history.past[history.past.length - 1];
  if (history.open && last && change.coalesceKey !== undefined && last.coalesceKey === change.coalesceKey) {
    const merged = mergeIntoEntry(docAfter, last, change);
    const past = history.past.slice(0, -1);
    if (merged) past.push(merged);
    return { past, future: [], open: merged !== null, nextId: history.nextId };
  }
  const entry: HistoryEntry = {
    id: history.nextId,
    label: change.label,
    ...(change.coalesceKey === undefined ? {} : { coalesceKey: change.coalesceKey }),
    patches: change.patches,
    inverse: change.inverse,
  };
  const past = [...history.past, entry];
  if (past.length > limit) past.splice(0, past.length - limit);
  return { past, future: [], open: change.coalesceKey !== undefined, nextId: history.nextId + 1 };
}

/** Ends a coalesced run: the next change starts a new entry even with the same key (pointer-up, blur). */
export function seal(history: History): History {
  return history.open ? { ...history, open: false } : history;
}

export interface Step<T> {
  history: History;
  doc: T;
  /** The entry that was undone or redone. */
  entry: HistoryEntry;
}

/** Undoes the last step; null when there is none. */
export function undo<T extends Objectish>(history: History, doc: T): Step<T> | null {
  const entry = history.past[history.past.length - 1];
  if (!entry) return null;
  return {
    doc: applyPatches(doc, entry.inverse),
    entry,
    history: { past: history.past.slice(0, -1), future: [...history.future, entry], open: false, nextId: history.nextId },
  };
}

/** Redoes the step that was undone last; null when there is none. */
export function redo<T extends Objectish>(history: History, doc: T): Step<T> | null {
  const entry = history.future[history.future.length - 1];
  if (!entry) return null;
  return {
    doc: applyPatches(doc, entry.patches),
    entry,
    history: { past: [...history.past, entry], future: history.future.slice(0, -1), open: false, nextId: history.nextId },
  };
}

export const canUndo = (history: History): boolean => history.past.length > 0;
export const canRedo = (history: History): boolean => history.future.length > 0;
/** The label of the step `undo` would undo. */
export const undoLabel = (history: History): string | undefined => history.past[history.past.length - 1]?.label;
/** The label of the step `redo` would redo. */
export const redoLabel = (history: History): string | undefined => history.future[history.future.length - 1]?.label;
