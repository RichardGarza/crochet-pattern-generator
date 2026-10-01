// The open project (DESIGN.md §5.3, §4.4, §5.5.2, §5.5.5, §5.2.1). Step 0 owned.
//
// Holds `doc: ProjectDoc | null`, the undo history, the save state and the asset cache. It guards the user's
// work, so its rules are strict:
//
//   - `update(label, recipe, { coalesceKey? })` is the ONLY way to change authored data. The document is
//     immutable (deeply frozen); a recipe edits an immer draft and the change becomes one history entry.
//     A recipe (and a commit's `also`) only edits its draft: every action that writes this store throws when
//     it is called from inside one, because the recipe's result would overwrite what it wrote.
//   - `commitModelRevision` is the ONE way to replace the 3D model by a new revision (a rebuild, an import, a
//     destructive edit): one synchronous step that carries the app-owned settings over (`carryOver`), keeps
//     the outgoing and the new model as revision assets, appends the `ModelRevision` entries and is undone by
//     one undo. (Editing the current model — moving a part, Proportions — is an `update`.)
//   - `id`, `rev`, `updatedAt`, `createdAt`, `schema` and `version` belong to persistence. Recipes must not
//     touch them and undo/redo never changes them; the save hooks (`markSaved`, `rebind`) write them.
//   - A read-only project (another tab holds its lock, §5.5.2) rejects every change: `update` returns false and
//     `rejectedEdits` counts up, which the read-only banner shows.
//   - Persistence itself is T8's (core/persist, useAutosave). This store gives it a change counter, the assets
//     added since the last save, and the hooks `beginSave` / `markSaved` / `markSaveFailed` / `rebind`.
//
// No `window` or DOM access: the module loads in the vitest node environment. `createProjectStore()` makes an
// independent store for tests; `projectStore` is the app's.
import { current, freeze, isDraft, type Draft } from 'immer';
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { canonicalJson } from '../core/kernel/hash';
import { carryOverWith, emptyCarryReport } from '../core/model/revisions';
import type { CarryReport, CommitModelRevisionFn } from '../types/entryPoints';
import type { CrochetModelV1 } from '../types/model';
import type { AssetRef, ModelRevision, ProjectDoc } from '../types/project';
import { isProjectId } from './appStore';
import { applyRecipe, diffDocuments, emptyHistory, record, redo as redoStep, seal, undo as undoStep, type Change, type History } from './history';

// ---- errors

/** Rejection of `commitModelRevision` and `putAsset` on a read-only project. (`update` returns false instead.) */
export class ReadOnlyError extends Error {
  constructor(what: string) {
    super(`${what}: this project is open read-only in this tab`);
    this.name = 'ReadOnlyError';
  }
}

/** Thrown by `open` and `close` when the open project has changes that were not saved (§5.5: never lose data). */
export class UnsavedChangesError extends Error {
  constructor(what: string) {
    super(`${what}: the open project has unsaved changes; save them first (useAutosave().flush()) or pass { discardUnsaved: true }`);
    this.name = 'UnsavedChangesError';
  }
}

/** Rejection of `getAsset` when the asset is neither in the cache nor known to the asset loader. */
export class AssetMissingError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(`asset ${key} is not in the cache and could not be loaded`);
    this.name = 'AssetMissingError';
    this.key = key;
  }
}

// ---- types

/** A recipe edits the draft in place; what it returns is ignored. It must be synchronous. */
export type Recipe = (draft: Draft<ProjectDoc>) => unknown;

/**
 * `unsaved`: there are changes and no save is running. `saving`: a save is in flight. `error`: the last save
 * failed and the changes are still unsaved. `read-only` / `saved`: nothing to save.
 * (`useAutosave().status` has no `unsaved`; T8 maps it.)
 */
export type SaveStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'read-only';

/** One save attempt: what `repo.save(ticket.doc, ticket.newAssets, { baseRev: ticket.baseRev })` needs. */
export interface SaveTicket {
  readonly id: number;
  /** The document to store: a frozen snapshot, `updatedAt` set to the time of the ticket. */
  readonly doc: ProjectDoc;
  /** The stored rev this tab loaded or last saved: the compare-and-swap base (§5.5.2). */
  readonly baseRev: number;
  /** Every asset added since the last successful save, by key — also those the document no longer names (undo). */
  readonly newAssets: Map<string, Blob>;
  /** `changeId` of the snapshot. */
  readonly changeId: number;
}

/** Content of a model-revision asset (`ModelRevision.asset`), stored as canonical JSON. */
export interface ModelRevisionSnapshot {
  format: 'crochet-model-revision';
  version: 1;
  model: CrochetModelV1;
  /** `threeD.meshAssets` entries of the model's mesh parts at that time: `<meshRef>` and `sdf:<meshRef>`. */
  meshAssets: Record<string, AssetRef>;
}

export const MODEL_REVISION_MIME = 'application/json';

export type CommitOptions = Parameters<CommitModelRevisionFn>[1] & {
  /**
   * More changes for the same undo step: the import record, `qa.awaiting`, new `meshAssets` entries, the photo
   * palette. It runs after the model was replaced and before the revision is snapshotted (so the snapshot
   * sees `meshAssets` written here, and the model as `also` left it). `info.rev` is the `ModelRevision.rev`
   * the new model gets — with `also` a revision is appended even when the model did not change, so a record
   * that names `info.rev` always finds it. `also` must keep the model and must not change `threeD.revisions`
   * (the commit throws, and nothing is changed).
   */
  also?: (draft: Draft<ProjectDoc>, info: { rev: number; report: CarryReport }) => void;
};

/** Loads an asset that is not in the cache (T8: from IndexedDB). `ref` is given when the caller had one. */
export type AssetLoader = (key: string, ref?: AssetRef) => Promise<Blob | undefined>;

export interface ProjectState {
  /** The open project, deeply frozen; null on the start screen. */
  doc: ProjectDoc | null;
  readOnly: boolean;
  /** +1 on every `open` and `close`: async code compares it to notice that the project changed under it. */
  session: number;
  history: History;
  /** +1 on every authored change (update, undo, redo, a model revision). 0 after `open`. */
  changeId: number;
  /** `changeId` of the last successful save. The project is dirty while the two differ. */
  savedChangeId: number;
  /** The stored rev this tab loaded or last saved (§5.5.2). */
  baseRev: number;
  saveStatus: SaveStatus;
  /** Message of the last failed save; null after a successful one. */
  saveError: string | null;
  /** Id of the save in flight, or null. */
  savingTicket: number | null;
  /** How many changes were refused because the project is read-only (the banner reacts to it). */
  rejectedEdits: number;
  /** The asset cache, by key (`<projectId>/<sha256>`). A new Map on every change. */
  assets: ReadonlyMap<string, Blob>;
  /** Keys of the assets added since the last successful save. */
  unsavedAssetKeys: ReadonlySet<string>;

  /**
   * Opens a project: the document is copied and frozen, history and cache start empty. Throws
   * `UnsavedChangesError` when the project that is open has unsaved changes, unless `discardUnsaved`.
   */
  open(doc: ProjectDoc, o?: { readOnly?: boolean; assets?: Iterable<readonly [string, Blob]>; discardUnsaved?: boolean }): void;
  /** Back to no project. Throws `UnsavedChangesError` like `open`. */
  close(o?: { discardUnsaved?: boolean }): void;
  /** Switches read-only on (the lock was handed over or stolen) or off. Unsaved changes stay and can still be saved. */
  setReadOnly(readOnly: boolean): void;

  /**
   * The only way to change authored data (§5.3, §4.4). Returns true when the change was applied (or changed
   * nothing), false when the project is read-only. Throws when no project is open, when called from inside
   * a recipe, and when the recipe is async, throws, or touches a field that persistence owns — in all of
   * these nothing is changed. Consecutive updates with the same `coalesceKey` are one history entry.
   */
  update(label: string, recipe: Recipe, o?: { coalesceKey?: string }): boolean;
  /** Undoes the last step. False when there is none or the project is read-only. */
  undo(): boolean;
  /** Redoes the step undone last. False when there is none or the project is read-only. */
  redo(): boolean;
  /** Ends a coalesced run (pointer-up, blur): the next update starts a new history entry even with the same key. */
  endCoalescing(): void;

  /**
   * Stores bytes as a content-addressed asset: key `<projectId>/<sha256>`. Identical bytes give the same
   * key and are stored once: the ref's `mime` is then the type of the blob already in the cache (the first
   * one stored), not this call's `mime`. `mime` is normalized as `Blob` does (lowercase). The asset is saved
   * with the next save. Rejects with `ReadOnlyError` on a read-only project.
   */
  putAsset(bytes: Blob | ArrayBuffer | ArrayBufferView<ArrayBuffer>, mime: string): Promise<AssetRef>;
  /** Adds an asset that is already stored (loaded from the repository) to the cache. */
  cacheAsset(key: string, blob: Blob): void;
  /** The asset from the cache, else from the asset loader (and then cached). Rejects with `AssetMissingError`. */
  getAsset(ref: AssetRef | string): Promise<Blob>;
  /** T8 registers how assets that are not in the cache are loaded. */
  setAssetLoader(loader: AssetLoader | null): void;
  /**
   * Drops assets from the cache to free memory; they stay in the repository and come back through the asset
   * loader. Assets that are not saved yet are kept, whatever is asked.
   */
  uncacheAssets(keys: Iterable<string>): void;

  /** §5.2.1: the one way to replace the 3D model. See `CommitOptions` and the notes at `commit` below. */
  commitModelRevision: CommitModelRevisionFn;
  /** `commitModelRevision` with more changes in the same undo step (`also`). */
  commitModelRevisionWith(next: CrochetModelV1, o: CommitOptions): Promise<CarryReport>;
  /** Reads a stored model revision back. */
  readModelRevision(rev: number): Promise<ModelRevisionSnapshot & { revision: ModelRevision }>;
  /**
   * Makes a stored revision the current model again, with the mesh assets it had: a new revision
   * ("Revert to revision N: …", source 'edit'), nothing is carried over, one undo step.
   */
  revertToModelRevision(rev: number): Promise<void>;

  /**
   * Starts a save: returns the snapshot to store, or null when there is nothing to do right now (no project,
   * no unsaved change, or a save already in flight). Every ticket must end with `markSaved`,
   * `markSaveFailed` or `rebind`.
   */
  beginSave(): SaveTicket | null;
  /** The save succeeded: the document gets `rev` and the ticket's `updatedAt`. False for a stale ticket. */
  markSaved(ticket: SaveTicket, o: { rev: number }): boolean;
  /** The save failed: the changes stay unsaved and `saveStatus` becomes 'error'. False for a stale ticket. */
  markSaveFailed(ticket: SaveTicket, error: unknown): boolean;
  /**
   * The save hit a newer stored rev and the ticket's document was stored as a copy (`saveAsCopy`, §5.5.2):
   * this tab continues in the copy — new `id`, `rev`, `baseRev` and (optionally) `name` — with its history.
   * Asset refs in the document keep their keys. False for a stale ticket.
   */
  rebind(ticket: SaveTicket, o: { id: string; rev: number; name?: string }): boolean;
}

export type ProjectStore = StoreApi<ProjectState>;

// ---- SHA-256

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74,
  0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d,
  0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e,
  0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/**
 * SHA-256 as 64 lowercase hex digits, synchronously. `crypto.subtle.digest` is async, and a model revision
 * must be committed in one synchronous step (nothing may change the model between reading the previous one
 * and writing the next); model JSON is at most a few hundred kB. `putAsset` uses `crypto.subtle` when it is
 * there and this otherwise (a page served over plain http has no `crypto.subtle`).
 */
export function sha256Hex(bytes: Uint8Array): string {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const length = bytes.length;
  const padded = new Uint8Array(((length + 9 + 63) >>> 6) << 6);
  padded.set(bytes);
  padded[length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(length / 0x20000000)); // the bit length, high word
  view.setUint32(padded.length - 4, (length * 8) >>> 0); // low word
  const w = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + SHA256_K[i] + w[i]) | 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += b;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }
  let hex = '';
  for (let i = 0; i < 8; i++) hex += h[i].toString(16).padStart(8, '0');
  return hex;
}

async function digest(buffer: ArrayBuffer): Promise<string> {
  const subtle = typeof crypto === 'undefined' ? undefined : crypto.subtle;
  if (!subtle) return sha256Hex(new Uint8Array(buffer));
  const hash = new Uint8Array(await subtle.digest('SHA-256', buffer));
  let hex = '';
  for (const byte of hash) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

// ---- helpers

/** Fields that persistence owns: recipes must not change them, and undo/redo never does. */
const MANAGED_FIELDS = ['schema', 'version', 'id', 'createdAt', 'updatedAt', 'rev'] as const;

const utf8 = new TextEncoder();

/** The key of a content-addressed asset (§5.3, §5.5.1). */
export const assetKey = (projectId: string, sha256: string): string => `${projectId}/${sha256}`;

function plain<T>(value: T): T {
  return isDraft(value) ? (current(value as Draft<T>) as T) : value;
}

/** The `meshAssets` entries a model needs: `<meshRef>` and `sdf:<meshRef>` of every mesh part (§2.9.7). */
function meshAssetsOf(model: CrochetModelV1, meshAssets: Record<string, AssetRef>): Record<string, AssetRef> {
  const out: Record<string, AssetRef> = {};
  for (const part of model.parts) {
    if (part.type !== 'mesh') continue;
    for (const key of [part.dims.meshRef, `sdf:${part.dims.meshRef}`]) {
      if (Object.hasOwn(meshAssets, key)) out[key] = meshAssets[key];
    }
  }
  return out;
}

function statusOf(s: Pick<ProjectState, 'doc' | 'readOnly' | 'savingTicket' | 'saveError' | 'changeId' | 'savedChangeId'>): SaveStatus {
  if (s.savingTicket !== null) return 'saving';
  if (s.doc && s.changeId !== s.savedChangeId) return s.saveError !== null ? 'error' : 'unsaved';
  return s.readOnly ? 'read-only' : 'saved';
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// ---- the store

/** A project store of its own (tests). `now` stamps `ModelRevision.at` and a ticket's `updatedAt`. */
export function createProjectStore(deps: { now?: () => Date } = {}): ProjectStore {
  const now = deps.now ?? (() => new Date());
  let recipeRunning = false;
  let nextTicketId = 1;
  let assetLoader: AssetLoader | null = null;
  const loading = new Map<string, Promise<Blob>>();

  return createStore<ProjectState>()((set, get) => {
    /** Writes state and keeps `saveStatus` in step with it. */
    const commitState = (partial: Partial<ProjectState>): void => {
      const merged = { ...get(), ...partial };
      set({ ...partial, saveStatus: statusOf(merged) });
    };

    const guardRecipe = (what: string): void => {
      if (recipeRunning) throw new Error(`projectStore.${what}: called from inside a recipe; a recipe only edits its draft`);
    };

    const guardUnsaved = (what: string, discardUnsaved: boolean | undefined): void => {
      const s = get();
      if (s.doc && s.changeId !== s.savedChangeId && !discardUnsaved) throw new UnsavedChangesError(`projectStore.${what}`);
    };

    const rejectReadOnly = (): void => {
      set({ rejectedEdits: get().rejectedEdits + 1 });
    };

    /**
     * Applies a recipe as one history step. `assets` are added to the cache (and to the unsaved set) in the
     * same state change. Returns false when the recipe changed nothing.
     */
    const change = (
      what: string,
      label: string,
      recipe: Recipe,
      o: { coalesceKey?: string; assets?: (readonly [string, Blob])[]; allowRevisions?: boolean } = {},
    ): boolean => {
      const s = get();
      const doc = s.doc;
      if (!doc) throw new Error(`projectStore.${what}: no project is open`);
      let result: Change<ProjectDoc>;
      recipeRunning = true;
      try {
        result = applyRecipe(doc, recipe);
      } finally {
        recipeRunning = false;
      }
      if (result.patches.length === 0) return false;
      for (const field of MANAGED_FIELDS) {
        if (result.doc[field] !== doc[field]) {
          throw new Error(`projectStore.${what} ("${label}"): a recipe must not change "${field}"; persistence owns it (markSaved, rebind)`);
        }
      }
      // Creating `threeD` with an empty revision list, or removing one that holds none, writes no revision.
      if (!o.allowRevisions && diffDocuments(doc.threeD?.revisions ?? [], result.doc.threeD?.revisions ?? []).patches.length > 0) {
        if (doc.threeD && !result.doc.threeD) {
          throw new Error(`projectStore.${what} ("${label}"): a recipe must not remove doc.threeD while it holds model revisions (§3.7.7: old revisions are kept)`);
        }
        throw new Error(`projectStore.${what} ("${label}"): the model revisions are written by commitModelRevision only`);
      }
      const partial: Partial<ProjectState> = {
        doc: result.doc,
        history: record(s.history, result.doc, { label, coalesceKey: o.coalesceKey, patches: result.patches, inverse: result.inverse }),
        changeId: s.changeId + 1,
      };
      const added = (o.assets ?? []).filter(([key]) => !s.assets.has(key));
      if (added.length > 0) {
        const assets = new Map(s.assets);
        const unsaved = new Set(s.unsavedAssetKeys);
        for (const [key, blob] of added) {
          assets.set(key, blob);
          unsaved.add(key);
        }
        partial.assets = assets;
        partial.unsavedAssetKeys = unsaved;
      }
      commitState(partial);
      return true;
    };

    /**
     * Replaces the 3D model, synchronously (the async signature is the frozen one):
     *   1. carry-over from the current model (`carry: 'by-id'`), with `carryPaintAnyway`;
     *   2. if the current model is not yet held by any revision — it was edited since the last one — it is
     *      snapshotted as its own revision first (source 'edit', "Before: <label>"), so paint that was not
     *      carried, and every other edit, stays in the previous revision (§3.7.7, §5.5.5);
     *   3. the model is replaced, `also` runs, and the new model is snapshotted as revision `rev`
     *      (`ModelRevision.asset` = canonical JSON of a `ModelRevisionSnapshot`);
     *   4. all of it is one history entry: one undo restores the previous model and revision list. The
     *      revision assets stay in the asset store either way.
     * A commit that would change nothing (same model, no `also`) does nothing. `rev` continues after the
     * highest integer rev of the list.
     */
    const commit = (what: string, next: CrochetModelV1, o: CommitOptions): CarryReport => {
      guardRecipe(what);
      const s = get();
      const doc = s.doc;
      if (!doc) throw new Error(`projectStore.${what}: no project is open`);
      if (s.readOnly) {
        rejectReadOnly();
        throw new ReadOnlyError(`projectStore.${what}`);
      }
      const threeD = doc.threeD;
      if (!threeD) throw new Error(`projectStore.${what}: this project has no 3D part (doc.threeD is missing)`);
      if (typeof next !== 'object' || next === null || next.schema !== 'crochet-model' || !Array.isArray(next.parts)) {
        throw new TypeError(`projectStore.${what}: the new model is not a crochet-model`);
      }

      const prev = threeD.model;
      const carried = o.carry === 'by-id' ? carryOverWith(prev, next, { carryPaintAnyway: o.carryPaintAnyway }) : { model: next, report: emptyCarryReport() };
      const { report } = carried;
      // The document gets its own copy: the caller's object is neither kept nor frozen.
      const model = structuredClone(carried.model);

      const snapshot = (m: CrochetModelV1, meshAssets: Record<string, AssetRef>): { ref: AssetRef; blob: Blob } => {
        const content: ModelRevisionSnapshot = { format: 'crochet-model-revision', version: 1, model: m, meshAssets: meshAssetsOf(m, meshAssets) };
        const bytes = utf8.encode(canonicalJson(content));
        const sha256 = sha256Hex(bytes);
        return {
          ref: { key: assetKey(doc.id, sha256), mime: MODEL_REVISION_MIME, bytes: bytes.length, sha256 },
          blob: new Blob([bytes], { type: MODEL_REVISION_MIME }),
        };
      };

      const outgoing = prev ? snapshot(prev, threeD.meshAssets) : null;
      // Without `also` the new revision is known before the recipe runs, and so is a commit that changes nothing.
      const known = o.also ? null : snapshot(model, threeD.meshAssets);
      if (known && outgoing && known.ref.sha256 === outgoing.ref.sha256) return report;

      const assets: (readonly [string, Blob])[] = [];
      const at = now().toISOString();
      // A per-project sequence: one more than the highest rev. Only integer revs count, so a stored document
      // with a malformed entry (NaN, 1.5) cannot derail the numbering.
      let rev = threeD.revisions.reduce((max, r) => (Number.isSafeInteger(r.rev) && r.rev > max ? r.rev : max), 0);
      const revisions: ModelRevision[] = [];
      if (outgoing && !threeD.revisions.some((r) => r.asset.sha256 === outgoing.ref.sha256)) {
        revisions.push({ rev: ++rev, at, source: 'edit', label: `Before: ${o.label}`, asset: outgoing.ref });
        assets.push([outgoing.ref.key, outgoing.blob]);
      }
      const newRev = rev + 1;

      change(
        what,
        o.label,
        (draft) => {
          let d3 = draft.threeD;
          if (!d3) return; // cannot happen: doc.threeD was checked above
          d3.model = model as Draft<CrochetModelV1>;
          let committed = known;
          if (o.also) {
            o.also(draft, { rev: newRev, report });
            // `also` may have replaced whole branches, `threeD` itself included: read them again.
            d3 = draft.threeD;
            if (!d3) throw new Error(`projectStore.${what}: "also" removed doc.threeD`);
            const final = d3.model as CrochetModelV1 | undefined;
            if (!final) throw new Error(`projectStore.${what}: "also" removed the model`);
            if (diffDocuments(threeD.revisions, plain(d3.revisions)).patches.length > 0) {
              throw new Error(`projectStore.${what}: "also" must not change threeD.revisions; old revisions are kept (§3.7.7)`);
            }
            committed = snapshot(plain(final), plain(d3.meshAssets) as Record<string, AssetRef>);
          }
          if (!committed) return;
          assets.push([committed.ref.key, committed.blob]);
          d3.revisions.push(...revisions, { rev: newRev, at, source: o.source, label: o.label, asset: committed.ref });
        },
        { assets, allowRevisions: true },
      );
      return report;
    };

    const endTicket = (ticket: SaveTicket): { unsaved: Set<string> } | null => {
      const s = get();
      if (s.savingTicket !== ticket.id || !s.doc) return null;
      const unsaved = new Set(s.unsavedAssetKeys);
      for (const key of ticket.newAssets.keys()) unsaved.delete(key);
      return { unsaved };
    };

    const closedState = (session: number): Partial<ProjectState> => ({
      doc: null,
      readOnly: false,
      session,
      history: emptyHistory(),
      changeId: 0,
      savedChangeId: 0,
      baseRev: 0,
      saveError: null,
      savingTicket: null,
      rejectedEdits: 0,
      assets: new Map(),
      unsavedAssetKeys: new Set(),
    });

    return {
      doc: null,
      readOnly: false,
      session: 0,
      history: emptyHistory(),
      changeId: 0,
      savedChangeId: 0,
      baseRev: 0,
      saveStatus: 'saved',
      saveError: null,
      savingTicket: null,
      rejectedEdits: 0,
      assets: new Map(),
      unsavedAssetKeys: new Set(),

      open(doc, o = {}) {
        guardRecipe('open');
        guardUnsaved('open', o.discardUnsaved);
        if (typeof doc !== 'object' || doc === null || doc.schema !== 'crochet-project') throw new TypeError('projectStore.open: not a crochet-project document');
        if (!isProjectId(doc.id)) throw new TypeError(`projectStore.open: invalid project id ${JSON.stringify(doc.id)} (a non-empty string without "/" or whitespace)`);
        const frozen = freeze(structuredClone(doc), true);
        loading.clear();
        commitState({
          ...closedState(get().session + 1),
          doc: frozen,
          readOnly: o.readOnly === true,
          baseRev: frozen.rev,
          assets: new Map(o.assets ?? []),
        });
      },

      close(o = {}) {
        guardRecipe('close');
        guardUnsaved('close', o.discardUnsaved);
        loading.clear();
        commitState(closedState(get().session + 1));
      },

      setReadOnly(readOnly) {
        guardRecipe('setReadOnly');
        const s = get();
        if (!s.doc || s.readOnly === readOnly) return;
        commitState({ readOnly, history: seal(s.history) });
      },

      update(label, recipe, o = {}) {
        guardRecipe('update');
        const s = get();
        if (!s.doc) throw new Error('projectStore.update: no project is open');
        if (s.readOnly) {
          rejectReadOnly();
          return false;
        }
        change('update', label, recipe, { coalesceKey: o.coalesceKey });
        return true;
      },

      undo() {
        guardRecipe('undo');
        const s = get();
        if (!s.doc) return false;
        if (s.readOnly) {
          rejectReadOnly();
          return false;
        }
        const step = undoStep(s.history, s.doc);
        if (!step) return false;
        commitState({ doc: step.doc, history: step.history, changeId: s.changeId + 1 });
        return true;
      },

      redo() {
        guardRecipe('redo');
        const s = get();
        if (!s.doc) return false;
        if (s.readOnly) {
          rejectReadOnly();
          return false;
        }
        const step = redoStep(s.history, s.doc);
        if (!step) return false;
        commitState({ doc: step.doc, history: step.history, changeId: s.changeId + 1 });
        return true;
      },

      endCoalescing() {
        guardRecipe('endCoalescing');
        const s = get();
        const sealed = seal(s.history);
        if (sealed !== s.history) set({ history: sealed });
      },

      async putAsset(bytes, mime) {
        guardRecipe('putAsset');
        const before = get();
        if (!before.doc) throw new Error('projectStore.putAsset: no project is open');
        if (before.readOnly) {
          rejectReadOnly();
          throw new ReadOnlyError('projectStore.putAsset');
        }
        // A Blob is a snapshot: what is hashed is what is stored, whatever the caller does to its array next.
        const blob = bytes instanceof Blob && bytes.type === mime ? bytes : new Blob([bytes], { type: mime });
        const sha256 = await digest(await blob.arrayBuffer());
        const s = get();
        if (!s.doc || s.session !== before.session) throw new Error('projectStore.putAsset: the project was closed while the asset was being stored');
        const key = assetKey(s.doc.id, sha256);
        const cached = s.assets.get(key);
        if (!cached) {
          const assets = new Map(s.assets);
          assets.set(key, blob);
          const unsaved = new Set(s.unsavedAssetKeys);
          unsaved.add(key);
          set({ assets, unsavedAssetKeys: unsaved });
        }
        // The ref describes the blob stored under its key: on a dedupe hit that is the first blob, whose type
        // wins over this call's label. Blob types are normalized (lowercase); the raw label only when the
        // Blob refused it (non-ASCII) and nothing better is known.
        return { key, mime: cached?.type || blob.type || mime, bytes: blob.size, sha256 };
      },

      cacheAsset(key, blob) {
        guardRecipe('cacheAsset');
        const s = get();
        if (!s.doc || s.assets.has(key)) return;
        const assets = new Map(s.assets);
        assets.set(key, blob);
        set({ assets });
      },

      getAsset(ref) {
        const key = typeof ref === 'string' ? ref : ref.key;
        const cached = get().assets.get(key);
        if (cached) return Promise.resolve(cached);
        const running = loading.get(key);
        if (running) return running;
        const loader = assetLoader;
        if (!loader) return Promise.reject(new AssetMissingError(key));
        const session = get().session;
        const load = (async (): Promise<Blob> => {
          const blob = await loader(key, typeof ref === 'string' ? undefined : ref);
          if (!blob) throw new AssetMissingError(key);
          if (get().session === session) get().cacheAsset(key, blob);
          return blob;
        })();
        loading.set(key, load);
        const forget = (): void => {
          if (loading.get(key) === load) loading.delete(key);
        };
        load.then(forget, forget);
        return load;
      },

      setAssetLoader(loader) {
        assetLoader = loader;
      },

      uncacheAssets(keys) {
        guardRecipe('uncacheAssets');
        const s = get();
        let assets: Map<string, Blob> | null = null;
        for (const key of keys) {
          if (!s.assets.has(key) || s.unsavedAssetKeys.has(key)) continue;
          assets ??= new Map(s.assets);
          assets.delete(key);
        }
        if (assets) set({ assets });
      },

      commitModelRevision: async (next, o) => commit('commitModelRevision', next, o),
      commitModelRevisionWith: async (next, o) => commit('commitModelRevisionWith', next, o),

      async readModelRevision(rev) {
        const revision = get().doc?.threeD?.revisions.find((r) => r.rev === rev);
        if (!revision) throw new Error(`projectStore.readModelRevision: the project has no model revision ${rev}`);
        const blob = await get().getAsset(revision.asset);
        const parsed = JSON.parse(await blob.text()) as Partial<ModelRevisionSnapshot>;
        if (parsed.format !== 'crochet-model-revision' || parsed.version !== 1 || parsed.model?.schema !== 'crochet-model') {
          throw new Error(`projectStore.readModelRevision: asset ${revision.asset.key} is not a model revision`);
        }
        return { format: parsed.format, version: parsed.version, model: parsed.model, meshAssets: parsed.meshAssets ?? {}, revision };
      },

      async revertToModelRevision(rev) {
        const session = get().session;
        const snapshot = await get().readModelRevision(rev);
        if (get().session !== session) throw new Error('projectStore.revertToModelRevision: the project was closed meanwhile');
        const now3d = get().doc?.threeD;
        const sameMeshes = Object.entries(snapshot.meshAssets).every(([key, ref]) => now3d?.meshAssets[key]?.key === ref.key);
        if (now3d?.model && sameMeshes && canonicalJson(now3d.model) === canonicalJson(snapshot.model)) return; // already the current model
        commit('revertToModelRevision', snapshot.model, {
          source: 'edit',
          label: `Revert to revision ${rev}: ${snapshot.revision.label}`,
          carry: 'none',
          also: (draft) => {
            if (draft.threeD) Object.assign(draft.threeD.meshAssets, snapshot.meshAssets);
          },
        });
      },

      beginSave() {
        guardRecipe('beginSave');
        const s = get();
        if (!s.doc || s.savingTicket !== null || s.changeId === s.savedChangeId) return null;
        const newAssets = new Map<string, Blob>();
        for (const key of s.unsavedAssetKeys) {
          const blob = s.assets.get(key);
          if (blob) newAssets.set(key, blob);
        }
        const ticket: SaveTicket = {
          id: nextTicketId++,
          doc: freeze({ ...s.doc, updatedAt: now().toISOString() }),
          baseRev: s.baseRev,
          newAssets,
          changeId: s.changeId,
        };
        commitState({ savingTicket: ticket.id });
        return ticket;
      },

      markSaved(ticket, o) {
        guardRecipe('markSaved');
        const ended = endTicket(ticket);
        const s = get();
        if (!ended || !s.doc) return false;
        commitState({
          doc: freeze({ ...s.doc, rev: o.rev, updatedAt: ticket.doc.updatedAt }),
          baseRev: o.rev,
          savedChangeId: ticket.changeId,
          savingTicket: null,
          saveError: null,
          unsavedAssetKeys: ended.unsaved,
        });
        return true;
      },

      markSaveFailed(ticket, error) {
        guardRecipe('markSaveFailed');
        const s = get();
        if (s.savingTicket !== ticket.id) return false;
        commitState({ savingTicket: null, saveError: errorMessage(error) });
        return true;
      },

      rebind(ticket, o) {
        guardRecipe('rebind');
        if (!isProjectId(o.id)) throw new TypeError(`projectStore.rebind: invalid project id ${JSON.stringify(o.id)}`);
        const ended = endTicket(ticket);
        const s = get();
        if (!ended || !s.doc) return false;
        commitState({
          doc: freeze({ ...s.doc, id: o.id, rev: o.rev, updatedAt: ticket.doc.updatedAt, ...(o.name === undefined ? {} : { name: o.name }) }),
          baseRev: o.rev,
          savedChangeId: ticket.changeId,
          savingTicket: null,
          saveError: null,
          unsavedAssetKeys: ended.unsaved,
        });
        return true;
      },
    };
  });
}

/** The app's project store. */
export const projectStore: ProjectStore = createProjectStore();

/** React hook on the app's project store. The selector must return a stable value (zustand 5). */
export function useProjectStore<T>(selector: (state: ProjectState) => T): T {
  return useStore(projectStore, selector);
}

/**
 * §5.2.1 — the ONE way to replace the 3D model of the open project (T3 rebuild, T6 convert / cut / merge /
 * scale, T7 import and apply colors). Resolves with what was carried over and what was dropped.
 */
export const commitModelRevision: CommitModelRevisionFn = (next, o) => projectStore.getState().commitModelRevision(next, o);

// ---- selectors

export const selectIsDirty = (s: ProjectState): boolean => s.doc !== null && s.changeId !== s.savedChangeId;
export const selectCanUndo = (s: ProjectState): boolean => !s.readOnly && s.history.past.length > 0;
export const selectCanRedo = (s: ProjectState): boolean => !s.readOnly && s.history.future.length > 0;
export const selectUndoLabel = (s: ProjectState): string | undefined => s.history.past[s.history.past.length - 1]?.label;
export const selectRedoLabel = (s: ProjectState): string | undefined => s.history.future[s.history.future.length - 1]?.label;
export const selectModel = (s: ProjectState): CrochetModelV1 | undefined => s.doc?.threeD?.model;
