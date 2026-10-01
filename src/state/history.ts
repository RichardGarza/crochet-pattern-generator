// Undo and redo on patches (DESIGN.md §5.3, §4.4). Step 0 owned.
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
//
// Where the patches come from. A recipe runs in immer (`produce`), but the patches are NOT immer's: they are
// computed here, from the two documents, by a structural diff (`diffDocuments`), and applied here
// (`applyPatches`). immer 11.1 derives its patches from what a recipe did to its drafts, and gets them wrong
// in recipes that real tools write — a point inserted twice into a lathe profile and then dragged and sorted,
// a draft modified and then replaced by its `original()` — so that REDO produced a document the user never
// had. A diff of the two states cannot be wrong about how the second one came about: applying `patches` to the
// document before the step gives the document after it, and `inverse` the way back, whatever the recipe did.
// The patch format is immer's (`{ op, path, value }`).
//
// The documents are JSON-like data: plain objects, arrays and primitives (what a ProjectDoc is). Anything else
// (a Date, a typed array, a class instance) is treated as one value, replaced as a whole when it is another
// object. Symbol keys and non-enumerable properties are not seen.
import { produce, type Draft, type Objectish, type Patch } from 'immer';

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

// ---- structural diff

type Path = (string | number)[];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Collects the patches that turn `base` into `next` (`forward`, in the order they apply) and, for each of
 * them, the patch that takes it back (`backward`, same order: the inverse list is `backward` reversed).
 */
function diffValue(base: unknown, next: unknown, path: Path, forward: Patch[], backward: Patch[]): void {
  if (Object.is(base, next)) return;
  if (Array.isArray(base) && Array.isArray(next)) {
    diffArray(base, next, path, forward, backward);
  } else if (isPlainObject(base) && isPlainObject(next)) {
    diffObject(base, next, path, forward, backward);
  } else {
    forward.push({ op: 'replace', path, value: next });
    backward.push({ op: 'replace', path, value: base });
  }
}

function diffObject(base: Record<string, unknown>, next: Record<string, unknown>, path: Path, forward: Patch[], backward: Patch[]): void {
  for (const key of Object.keys(base)) {
    if (Object.hasOwn(next, key)) {
      diffValue(base[key], next[key], [...path, key], forward, backward);
    } else {
      forward.push({ op: 'remove', path: [...path, key] });
      backward.push({ op: 'add', path: [...path, key], value: base[key] });
    }
  }
  for (const key of Object.keys(next)) {
    if (Object.hasOwn(base, key)) continue;
    forward.push({ op: 'add', path: [...path, key], value: next[key] });
    backward.push({ op: 'remove', path: [...path, key] });
  }
}

/**
 * Arrays of one length are compared index by index. When the length changed, the elements that both arrays
 * share at the start and at the end (the same value or the same object) are left alone and only the stretch
 * between them is patched — one `remove` for a splice, one `add` per pushed element — whatever the size of
 * the array.
 */
function diffArray(base: readonly unknown[], next: readonly unknown[], path: Path, forward: Patch[], backward: Patch[]): void {
  if (base.length === next.length) {
    for (let i = 0; i < base.length; i++) diffValue(base[i], next[i], [...path, i], forward, backward);
    return;
  }
  const shorter = Math.min(base.length, next.length);
  let prefix = 0;
  while (prefix < shorter && Object.is(base[prefix], next[prefix])) prefix++;
  let suffix = 0;
  while (suffix < shorter - prefix && Object.is(base[base.length - 1 - suffix], next[next.length - 1 - suffix])) suffix++;
  const baseEnd = base.length - suffix; // the stretch that differs is [prefix, baseEnd) in base …
  const nextEnd = next.length - suffix; // … and [prefix, nextEnd) in next
  const common = Math.min(baseEnd, nextEnd);
  for (let i = prefix; i < common; i++) diffValue(base[i], next[i], [...path, i], forward, backward);
  // The rest of the longer stretch is removed (from the end, so no index moves under a later patch) or added.
  for (let i = baseEnd - 1; i >= common; i--) {
    forward.push({ op: 'remove', path: [...path, i] });
    backward.push({ op: 'add', path: [...path, i], value: base[i] });
  }
  for (let i = common; i < nextEnd; i++) {
    forward.push({ op: 'add', path: [...path, i], value: next[i] });
    backward.push({ op: 'remove', path: [...path, i] });
  }
}

/**
 * The patches between two documents: `applyPatches(base, patches)` is deeply equal to `next`, and
 * `applyPatches(next, inverse)` to `base`. Both lists are empty when the documents are deeply equal. Branches
 * that are the same object in both documents are not looked into, so the cost follows the size of the change.
 */
export function diffDocuments(base: unknown, next: unknown): { patches: Patch[]; inverse: Patch[] } {
  const patches: Patch[] = [];
  const backward: Patch[] = [];
  diffValue(base, next, [], patches, backward);
  return { patches, inverse: backward.reverse() };
}

// ---- applying patches

function unresolved(patch: Patch): Error {
  return new Error(`history: the patch ${patch.op} /${patch.path.join('/')} does not fit the document`);
}

function setKey(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty, not assignment: a key named "__proto__" is data like any other.
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** The index a patch names in `array`, checked: `0 … length - 1`, or up to `length` for an insertion. */
function indexIn(array: readonly unknown[], key: string | number, patch: Patch, inserting: boolean): number {
  const index = typeof key === 'number' ? key : Number(key);
  if (!Number.isInteger(index) || index < 0 || index > (inserting ? array.length : array.length - 1)) throw unresolved(patch);
  return index;
}

/**
 * Applies patches in order and returns the new document. `doc` is not changed: every object or array on the
 * way to a patched place is copied once (and frozen at the end), however many patches pass through it; every
 * other branch is shared, and patch values go in as they are — so an undo puts back the very objects a step
 * removed. A patch that does not fit the document (a missing key, an index out of range) throws, and nothing
 * is applied.
 */
export function applyPatches<T>(doc: T, patches: readonly Patch[]): T {
  if (patches.length === 0) return doc;
  /** The copies made by this call: the only objects it may write to. */
  const copies = new Set<object>();
  const writable = (node: unknown, patch: Patch): unknown[] | Record<string, unknown> => {
    if (typeof node === 'object' && node !== null && copies.has(node)) return node as unknown[] | Record<string, unknown>;
    let copy: unknown[] | Record<string, unknown>;
    if (Array.isArray(node)) copy = node.slice() as unknown[];
    else if (isPlainObject(node)) copy = { ...node };
    else throw unresolved(patch);
    copies.add(copy);
    return copy;
  };

  let root: unknown = doc;
  for (const patch of patches) {
    const { path, op } = patch;
    if (path.length === 0) {
      if (op !== 'replace') throw unresolved(patch);
      root = patch.value as unknown;
      continue;
    }
    root = writable(root, patch);
    let node = root as unknown[] | Record<string, unknown>;
    for (let depth = 0; depth < path.length - 1; depth++) {
      if (Array.isArray(node)) {
        const index = indexIn(node, path[depth], patch, false);
        const child = writable(node[index], patch);
        node[index] = child;
        node = child;
      } else {
        const name = String(path[depth]);
        if (!Object.hasOwn(node, name)) throw unresolved(patch);
        const child = writable(node[name], patch);
        setKey(node, name, child);
        node = child;
      }
    }
    const key = path[path.length - 1];
    if (Array.isArray(node)) {
      const index = indexIn(node, key, patch, op === 'add');
      if (op === 'replace') node[index] = patch.value as unknown;
      else if (op === 'add') node.splice(index, 0, patch.value as unknown);
      else node.splice(index, 1);
    } else {
      const name = String(key);
      if ((op === 'add') === Object.hasOwn(node, name)) throw unresolved(patch);
      if (op === 'remove') delete node[name];
      else setKey(node, name, patch.value as unknown);
    }
  }
  for (const copy of copies) Object.freeze(copy);
  return root as T;
}

// ---- recipes

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function';
}

/**
 * Runs an immer recipe on `doc` and returns the new document with the patches between the two. `doc` itself
 * is never changed; the result shares every untouched branch with it and is deeply frozen.
 *
 * The recipe mutates the draft; what it returns is ignored, so `(d) => d.items.push(x)` and
 * `(d) => (d.name = 'x')` are fine (plain immer would refuse both). It must be synchronous: a recipe that
 * returns a promise throws, and nothing is changed. A recipe that throws changes nothing either.
 *
 * A recipe that leaves the document deeply equal to what it was (it wrote the values that were there, or
 * replaced a branch by an equal copy) is no change: `patches` is empty and `doc` is the document passed in.
 */
export function applyRecipe<T extends Objectish>(doc: T, recipe: (draft: Draft<T>) => unknown): Change<T> {
  const next = produce(doc, (draft: Draft<T>) => {
    const returned = recipe(draft);
    if (isThenable(returned)) {
      // The async body will fail on the revoked draft later; that failure is already reported here.
      Promise.resolve(returned).catch(() => {});
      throw new TypeError('A recipe must be synchronous: do the async work first, then change the document in one step.');
    }
  });
  if (next === doc) return { doc, patches: [], inverse: [] };
  const { patches, inverse } = diffDocuments(doc, next);
  return { doc: patches.length === 0 ? doc : next, patches, inverse };
}

// ---- the history

/**
 * One entry for a coalesced run: the patches from the document before the run to `docAfter`, and their
 * inverse. Returns null when the run ended where it started.
 */
function mergeIntoEntry<T>(docAfter: T, entry: HistoryEntry, change: ChangeRecord): HistoryEntry | null {
  const before = applyPatches(docAfter, [...change.inverse, ...entry.inverse]);
  const { patches, inverse } = diffDocuments(before, docAfter);
  if (patches.length === 0) return null;
  return { id: entry.id, label: change.label, coalesceKey: entry.coalesceKey, patches, inverse };
}

/**
 * Records a change that was just applied; `docAfter` is the document after it. Returns the same history when
 * the change has no patches.
 */
export function record<T>(history: History, docAfter: T, change: ChangeRecord, limit: number = HISTORY_LIMIT): History {
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
export function undo<T>(history: History, doc: T): Step<T> | null {
  const entry = history.past[history.past.length - 1];
  if (!entry) return null;
  return {
    doc: applyPatches(doc, entry.inverse),
    entry,
    history: { past: history.past.slice(0, -1), future: [...history.future, entry], open: false, nextId: history.nextId },
  };
}

/** Redoes the step that was undone last; null when there is none. */
export function redo<T>(history: History, doc: T): Step<T> | null {
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
