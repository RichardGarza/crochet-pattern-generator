# Step 0b — state and worker plumbing

Branch `s0b/state`, made from the Step 0a commit. This part of Step 0b (`DESIGN.md` §6.2) delivers the
application state and the worker plumbing: the three zustand stores with the undo history, the worker RPC and
client, the image decoder, the model-revision carry-over and the in-memory fakes for tests. The app shell (0c)
and all eight tracks code against the API below.

## What was delivered

| File | What it is | Tests |
|---|---|---|
| `src/workers/rpc.ts` | `Superseded`, `yieldMacrotask`, `createJobGate`, `latestWins`, latest-wins groups, transfer helpers, `exposeApi` — no DOM, runs in workers and in node | `workers/__tests__/rpc.test.ts` (27) |
| `src/workers/client.ts` | `workers`: lazy typed proxies to the six workers, latest-wins job methods, callbacks as comlink proxies, terminate / crash → respawn | `workers/__tests__/client.test.ts` (18) |
| `src/workers/decode.ts` | `decodeImage`, `decodeBlob`, HEIF brand sniffing, size limits, `/__convert` error mapping | `workers/__tests__/decode.test.ts` (24) |
| `src/state/history.ts` | undo / redo on patches (a structural diff of the two documents), labels, coalesce keys, cap 200 — pure functions | `state/__tests__/history.test.ts` (34), `historyRecipes.test.ts` (6) |
| `src/state/projectStore.ts` | the open project: `update`, undo / redo, read-only, asset cache, `commitModelRevision`, save hooks | `state/__tests__/projectStore.test.ts` (48) |
| `src/state/appStore.ts` | route + hash functions, preferences, capabilities, library summaries, toasts | `state/__tests__/appStore.test.ts` (20) |
| `src/state/derivedStore.ts` | derived results and job states keyed by input hash | `state/__tests__/derivedStore.test.ts` (16) |
| `src/core/model/revisions.ts` | `carryOver`, `carryOverWith`, `sameShapeWithin` | `core/model/__tests__/revisions.test.ts` (62) |
| `src/test/fakes.ts` | `createFakeLocks`, `createFakeChannels`, `createFakeWorker` | `test/__tests__/fakes.test.ts` (24) |
| — | the three React hooks and the worker yield under happy-dom | `state/__tests__/hooks.test.tsx` (2) |

All checks pass in the worktree (final state of this branch, two consecutive `npm test` runs): `npm run typecheck`
and `npm run lint` exit 0; `npm test` passes 571 tests in 31 files, 281 of them in the 11 files of this part.
Every seeded walk and fuzz of this part has an explicit 60 s timeout (under load from other agents the longest,
6 × 1 500 history steps, took 5.3 s against vitest's 5 s default).

Not touched: the six `*.worker.ts` stubs, `src/types/**`, every config file, `docs/DESIGN.md`.
`src/state/slices/*.ts` does not exist in the 0a commit (the 0a notes list no such placeholders); this part did
not create them — each track creates its own slice file.

## Public API

Import paths are relative to `src/`. "Frozen" = the signature is the `…Fn` type of `types/entryPoints.ts`
(checked at compile time in the tests with `expectTypeOf`).

### `workers/rpc.ts` — for worker authors (T1, T3, T4, T5, T7) and for `client.ts`

| Export | Signature | What it does |
|---|---|---|
| `Superseded` | `class Superseded extends Error { readonly jobId: number; constructor(jobId: number) }` | Thrown by `gate.check` and used to reject replaced requests. `name` is `'Superseded'`. |
| `isSuperseded` | `(error: unknown) => boolean` | True for a `Superseded`, also after comlink rebuilt it as a plain `Error` (goes by `name`). Callers ignore these rejections. |
| `yieldMacrotask` | frozen `YieldMacrotaskFn`: `() => Promise<void>` | Resolves in a later macrotask (MessageChannel ping); messages already queued for the thread run first. |
| `JobGate` | `type JobGate = { supersede(jobId: number): void; check(jobId: number): Promise<void> }` | The gate type. |
| `createJobGate` | frozen `CreateJobGateFn`: `() => JobGate` | `supersede(n)` raises the newest job id (never lowers it); `check(id)` yields one macrotask, then throws `Superseded(id)` when a newer id is known. |
| `latestWins` | frozen `LatestWinsFn`: `<Q extends { jobId: number }, R>(send: (q: Q) => Promise<R>, supersede: (jobId: number) => Promise<void>) => (q: Omit<Q, 'jobId'>) => Promise<R>` | One latest-wins channel: one request in flight, one pending; a newer request rejects the pending one with `Superseded` and sends `supersede(newJobId)` at once; a replaced job in flight rejects with `Superseded` even if the worker finished it. Assigns job ids 1, 2, 3, … |
| `LatestWinsGroup` | `interface { channel<Q extends { jobId: number }, R>(send: (q: Q) => Promise<R>): (q: Omit<Q, 'jobId'>) => Promise<R> }` | The channels of one worker. |
| `createLatestWinsGroup` | `(supersede: (jobId: number) => Promise<void>) => LatestWinsGroup` | Latest-wins channels that share one worker gate: one job in flight per worker, one pending request per channel, one job-id counter (see "Deviations" 3). |
| `transfer` | `<T extends object>(value: T, transferables: Transferable[]) => T` | Marks an argument or a result so the listed buffers are moved, not copied (comlink's `transfer`); the mark survives `latestWins` adding the job id. |
| `collectTransferables` | `(value: unknown) => ArrayBuffer[]` | Every ArrayBuffer reachable through plain objects, arrays, Maps and Sets, each once. |
| `transferAll` | `<T extends object>(value: T) => T` | `transfer(value, collectTransferables(value))` — for a worker result: `return transferAll(result)`. |
| `exposeApi` | `<T extends Cancellable>(methods: (gate: JobGate) => Omit<T, 'supersede'> & { supersede?: Cancellable['supersede'] }, endpoint?: Endpoint) => { api: T; gate: JobGate }` | Exposes a worker API with comlink and wires `supersede` to a fresh gate; an own `supersede` in the factory runs after the gate was raised (ami.worker forwards it to its private mesh.worker). `endpoint` defaults to the worker global. |

A worker file then looks like this (the stubs of 0a keep working unchanged until their track replaces them):

```ts
exposeApi<Chart2dApi>((gate) => ({
  run: async (r) => transferAll(await runChart({ ...r, image: await decodeImage(r.image) }, gate)),
  buildPattern: async (r) => buildPattern2D(r),
}));
```

### `workers/client.ts` — for the main thread (slices, UI)

| Export | Signature | What it does |
|---|---|---|
| `workers` | `const workers: WorkerClient` | The app's client. Creating it starts nothing; a worker is spawned by its first call. |
| `WorkerClient` | `{ chart2d: Chart2dClient; geom: GeomClient; ml: MlClient; mesh: MeshClient; ami: AmiClient; importer: ImportClient; terminate(name?: WorkerName): void; isRunning(name: WorkerName): boolean }` | `mesh` is the editor's mesh.worker; `importer` is import.worker. `terminate` rejects calls in flight with `WorkerTerminated`; the next call spawns a fresh worker. |
| `ClientOf<Api>` | mapped type | The API without `supersede`; a method whose only parameter is a request with `jobId` takes `Omit<Request, 'jobId'>`; every other method is unchanged. |
| `Chart2dClient`, `GeomClient`, `MeshClient`, `AmiClient`, `ImportClient` | `ClientOf<…Api>` | Latest-wins: `chart2d.run`, `geom.build`, `geom.projectColors`, `mesh.pathB`, `ami.generate`. Direct: everything else. |
| `MlClient` | `ClientOf<MlApi> & { cancel(): void }` | `depth(image, onProgress?)` passes the callback as `Comlink.proxy`. `cancel()` terminates the ml worker (§5.4 "terminate + respawn on cancel"). |
| `createWorkerClient` | `(o?: { spawn?: SpawnWorker }) => WorkerClient` | A client of its own (tests pass fakes). |
| `setWorkerSpawner` | `(spawn: SpawnWorker \| null) => void` | Replaces how `workers` spawns (tests of slices and tabs); `null` restores the real workers. Terminates running workers. |
| `WorkerName` | `'chart2d' \| 'geom' \| 'ml' \| 'ami' \| 'mesh' \| 'import'` | The file stems of `src/workers/<name>.worker.ts`. |
| `WORKER_NAMES` | `readonly WorkerName[]` | All six. |
| `WorkerLike` | `interface WorkerLike extends Endpoint { terminate(): void }` | What the client needs from a worker; a `Worker` is one. |
| `SpawnWorker` | `(name: WorkerName) => WorkerLike` | |
| `WorkerTerminated` | `class WorkerTerminated extends Error { readonly worker: WorkerName; readonly crashed: boolean; constructor(worker: WorkerName, crashed: boolean, detail?: string) }` | Rejection of calls in flight when their worker was terminated (`crashed: false`) or fired an `error` / `messageerror` event (`crashed: true`: an uncaught error, a script that failed to load; `detail` = the event's message). `name` is `'WorkerTerminated'`. |
| `isWorkerTerminated` | `(error: unknown) => error is WorkerTerminated` | |
| re-exports | `Superseded`, `isSuperseded`, `transfer`, `transferAll`, `collectTransferables` | From `rpc.ts`, so UI code imports one module. |

Rules for callers: a job method's rejection with `isSuperseded(e)` is ignored (a newer request is on its
way); a Step 0 stub rejects with `isNotImplementedError(e)` (`core/stub.ts`); buffers are cloned unless the
caller marks the argument, `workers.geom.build(transfer(request, [depth.data.buffer]))` — transfer only buffers
nothing else holds (never a mesh the viewport renders).

### `workers/decode.ts`

| Export | Signature | What it does |
|---|---|---|
| `decodeImage` | frozen `DecodeImageFn`: `(input: Blob \| RgbaImage) => Promise<RgbaImage>` | Blob → RGBA8 with the EXIF orientation applied; an `RgbaImage` is returned as the same object (after a check that `data.length === w·h·4`). Workers and browsers only. |
| `decodeBlob` | `(blob: Blob, env?: DecodeEnv) => Promise<DecodedImage>` | The same, and reports what was decoded. Every failure is an `ImageDecodeError`. |
| `DecodedImage` | `{ image: RgbaImage; source: Blob; convertedFromHeic: boolean }` | `source` is the input, or the JPEG that `/__convert` made of a HEIC photo: the blob to store as the project's source ("Converted from HEIC" chip when `convertedFromHeic`). |
| `ImageDecodeError` | `class ImageDecodeError extends Error { readonly code: ImageDecodeErrorCode; constructor(code: ImageDecodeErrorCode, message: string, options?: { cause?: unknown }) }` | `message` is written for the user; `name` is `'ImageDecodeError'`. |
| `ImageDecodeErrorCode` | `'heic-unavailable' \| 'heic-too-large' \| 'heic-failed' \| 'unsupported' \| 'too-large' \| 'invalid-image' \| 'no-decoder'` | |
| `isImageDecodeError` | `(error: unknown) => error is Error & { code?: ImageDecodeErrorCode }` | By name, so it also works after a worker boundary (where `code` is gone and `message` remains). |
| `sniffHeifBrand` | `(bytes: Uint8Array) => HeifBrand \| null` | The HEIF brand in an ISO-BMFF `ftyp` box at offset 4 (major brand, else a compatible brand inside the box); null for AVIF and everything else. T8's `/__convert` can use it for its 415 check. |
| `HEIF_BRANDS`, `HeifBrand` | `readonly ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']` | §2.3.1. |
| `checkDecodeSize` | `(w: number, h: number) => void` | Throws `too-large` above `MAX_DECODE_PIXELS` / `MAX_DECODE_SIDE`, `unsupported` for a size that is not a positive integer. |
| `convertFailure` | `(status: number) => ImageDecodeError` | Maps an answer of `/__convert`: 501/404/405/503 → `heic-unavailable` (the §2.3.1 message), 413 → `heic-too-large`, else `heic-failed`. |
| `HEIC_EXPORT_MESSAGE` | `'This is a HEIC photo; export it as JPEG (Photos → File → Export) and add it again'` | §2.3.1. |
| `HEIC_CONVERT_URL`, `MAX_CONVERT_BYTES`, `CONVERT_TIMEOUT_MS`, `SNIFF_BYTES`, `MAX_DECODE_PIXELS`, `MAX_DECODE_SIDE` | `'/__convert'`, `52 428 800` (50 MB), `30 000` (ms; the server gives `sips` 20 s), `64`, `64 000 000`, `16 384` | |
| `DecodeEnv`, `BitmapLike`, `ConvertResponse` | interfaces | The browser seam: `decodeBitmap(blob)`, `readPixels(bitmap)`, `convert(heic, timeoutMs)`. Tests pass their own. |
| `browserDecodeEnv` | `() => DecodeEnv` | `createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' })` → `OffscreenCanvas` → `getImageData`; `fetch(POST /__convert)`. Throws `no-decoder` in node. |

### `state/history.ts` — pure; used by `projectStore`

A recipe runs in immer (`produce`); the patches are derived from the two documents by a structural diff and
applied by path copying (see "Deviations" 1). The patch format is immer's `Patch` (`{ op, path, value? }`).
The documents are JSON-like: values compare with `Object.is` (-0 is not 0, NaN is NaN), a key holding
`undefined` is not a missing key, an object whose prototype changed (ordinary ↔ null-prototype) is replaced
whole and a copied object keeps its prototype, so every round trip is exact by node's `isDeepStrictEqual`. Not
seen: symbol keys, non-enumerable properties, extra properties on arrays, a hole versus an `undefined` element;
a Date, typed array or class instance is one value. A recipe on a document nested more than about a thousand
levels throws a RangeError and changes nothing (immer's own recursion stops at 1 500, the diff at 2 500).

| Export | Signature | What it does |
|---|---|---|
| `HISTORY_LIMIT` | `200` | |
| `HistoryEntry` | `{ id: number; label: string; coalesceKey?: string; patches: readonly Patch[]; inverse: readonly Patch[] }` | One undo step. |
| `History` | `{ past: readonly HistoryEntry[]; future: readonly HistoryEntry[]; open: boolean; nextId: number }` | `past` oldest first; `open` = the last entry still absorbs changes with its coalesce key. |
| `emptyHistory` | `() => History` | |
| `Change<T>`, `ChangeRecord` | `{ doc: T; patches: Patch[]; inverse: Patch[] }`, `{ label: string; coalesceKey?: string; patches; inverse }` | |
| `applyRecipe` | `<T extends Objectish>(doc: T, recipe: (draft: Draft<T>) => unknown) => Change<T>` | Runs an immer recipe; what the recipe returns is ignored; an async recipe throws and changes nothing; a recipe that leaves the document deeply equal gives no patches and the same document. |
| `diffDocuments` | `(base: unknown, next: unknown) => { patches: Patch[]; inverse: Patch[] }` | The patches between two JSON-like documents; branches that are the same object are not looked into. For JSON-like data both lists are empty exactly when the two are deeply (strictly) equal; a Date or typed array that is another object counts as a change. |
| `applyPatches` | `<T>(doc: T, patches: readonly Patch[]) => T` | Applies patches by path copying (frozen copies that keep their prototype; untouched branches and patch values are shared). Throws when a patch does not fit, and then applies nothing. |
| `record` | `<T>(history: History, docAfter: T, change: ChangeRecord, limit?: number) => History` | Adds the change: a new entry, or merged into the open entry with the same key (re-derived from the documents before and after the run, so it stays compact); clears the redo stack; drops the oldest beyond the limit; a change without patches is ignored. |
| `seal` | `(history: History) => History` | Ends a coalesced run. |
| `undo`, `redo` | `<T>(history: History, doc: T) => Step<T> \| null` | `Step<T> = { history: History; doc: T; entry: HistoryEntry }`; null when there is nothing to undo / redo. Both end a coalesced run. |
| `canUndo`, `canRedo` | `(history: History) => boolean` | |
| `undoLabel`, `redoLabel` | `(history: History) => string \| undefined` | The label of the step `undo` / `redo` would take. |

### `state/projectStore.ts`

| Export | Signature | What it does |
|---|---|---|
| `projectStore` | `const projectStore: ProjectStore` | The app's store: `projectStore.getState()`, `.subscribe((state, prev) => …)`. |
| `ProjectStore` | `type ProjectStore = StoreApi<ProjectState>` (zustand vanilla) | |
| `useProjectStore` | `<T>(selector: (state: ProjectState) => T) => T` | React hook. Selectors must return stable values (zustand 5): select primitives or existing objects, or use `useShallow`. |
| `createProjectStore` | `(deps?: { now?: () => Date }) => ProjectStore` | A store of its own (tests); `now` stamps `ModelRevision.at` and a ticket's `updatedAt`. |
| `commitModelRevision` | frozen `CommitModelRevisionFn`: `(next: CrochetModelV1, o: { source: ModelRevision['source']; label: string; carry: 'by-id' \| 'none'; carryPaintAnyway?: string[] }) => Promise<CarryReport>` | §5.2.1: acts on `projectStore`. |
| `ProjectState` | interface | State and actions, below. |
| `Recipe` | `(draft: Draft<ProjectDoc>) => unknown` | Edits the draft; synchronous. |
| `SaveStatus` | `'saved' \| 'unsaved' \| 'saving' \| 'error' \| 'read-only'` | |
| `SaveTicket` | `{ id: number; doc: ProjectDoc; baseRev: number; newAssets: Map<string, Blob>; changeId: number }` | One save attempt. |
| `CommitOptions` | `Parameters<CommitModelRevisionFn>[1] & { also?: (draft: Draft<ProjectDoc>, info: { rev: number; report: CarryReport }) => void }` | `also` runs inside the commit's recipe, after the model was replaced: more changes in the same undo step (import record, `qa.awaiting`, `meshAssets`, photo palette). It may edit the model or replace `threeD` as a whole, but must leave a model and must not change `threeD.revisions`, else the commit throws and nothing changes. `info.rev` = the `ModelRevision.rev` the new model gets. |
| `ModelRevisionSnapshot` | `{ format: 'crochet-model-revision'; version: 1; model: CrochetModelV1; meshAssets: Record<string, AssetRef> }` | What a `ModelRevision.asset` holds, as canonical JSON (`MODEL_REVISION_MIME = 'application/json'`). |
| `AssetLoader` | `(key: string, ref?: AssetRef) => Promise<Blob \| undefined>` | |
| `ReadOnlyError`, `UnsavedChangesError`, `AssetMissingError` | error classes (`name` = class name; `AssetMissingError.key`) | |
| `sha256Hex` | `(bytes: Uint8Array) => string` | Synchronous SHA-256 (64 hex digits). |
| `assetKey` | `(projectId: string, sha256: string) => string` | `<projectId>/<sha256>`. |
| `selectIsDirty`, `selectCanUndo`, `selectCanRedo`, `selectUndoLabel`, `selectRedoLabel`, `selectModel` | `(s: ProjectState) => …` | Selectors for the hook. |

`ProjectState` — data:

| Field | Type | Meaning |
|---|---|---|
| `doc` | `ProjectDoc \| null` | The open project, deeply frozen. |
| `readOnly` | `boolean` | §5.5.2. |
| `session` | `number` | +1 on every `open` and `close`. |
| `history` | `History` | `history.past.map((e) => e.label)` is the History list. |
| `changeId`, `savedChangeId` | `number` | `changeId` +1 on every authored change (update, undo, redo, model revision); dirty while they differ. **T8's autosave subscribes to `changeId`.** |
| `baseRev` | `number` | The stored rev this tab loaded or last saved. |
| `saveStatus`, `saveError`, `savingTicket` | `SaveStatus`, `string \| null`, `number \| null` | |
| `rejectedEdits` | `number` | Counts changes refused because the project is read-only (the banner reacts). |
| `assets` | `ReadonlyMap<string, Blob>` | The asset cache; a new Map whenever its content changes (the same Map otherwise). |
| `unsavedAssetKeys` | `ReadonlySet<string>` | Assets added since the last successful save. |

`ProjectState` — actions. A recipe (and a commit's `also`) only edits its draft: every action below that writes
the store throws when it is called from inside one (the recipe's result would overwrite what it wrote — found in
review: a `markSaved` there left `doc.rev` and `baseRev` apart, an `endCoalescing` was lost).

| Action | Signature | What it does |
|---|---|---|
| `open` | `(doc: ProjectDoc, o?: { readOnly?: boolean; assets?: Iterable<readonly [string, Blob]>; discardUnsaved?: boolean }) => void` | Opens a project (copied and frozen), empty history. Throws `UnsavedChangesError` when the open project is dirty, unless `discardUnsaved`. |
| `close` | `(o?: { discardUnsaved?: boolean }) => void` | Same guard. |
| `setReadOnly` | `(readOnly: boolean) => void` | The lock was handed over or stolen. Unsaved changes stay and can still be saved. |
| `update` | `(label: string, recipe: Recipe, o?: { coalesceKey?: string }) => boolean` | **The only way to change authored data.** `false` = read-only (nothing changed). Throws: no project, called inside a recipe, async or throwing recipe, a recipe that changes `schema`/`version`/`id`/`createdAt`/`updatedAt`/`rev` or `threeD.revisions`. A recipe that leaves the document deeply equal is no change (no history entry, not dirty). Values a recipe assigns from outside become part of the frozen document: do not mutate them afterwards. |
| `undo`, `redo` | `() => boolean` | False when there is nothing to do or the project is read-only. |
| `endCoalescing` | `() => void` | Pointer-up / blur: the next update starts a new history entry even with the same key. |
| `putAsset` | `(bytes: Blob \| ArrayBuffer \| ArrayBufferView<ArrayBuffer>, mime: string) => Promise<AssetRef>` | Content-addressed: `{ key: '<projectId>/<sha256>', mime, bytes, sha256 }`; identical bytes are stored once. Rejects with `ReadOnlyError` on a read-only project. |
| `cacheAsset` | `(key: string, blob: Blob) => void` | Adds an already-stored asset to the cache. |
| `getAsset` | `(ref: AssetRef \| string) => Promise<Blob>` | Cache, else the asset loader; rejects with `AssetMissingError`. |
| `setAssetLoader` | `(loader: AssetLoader \| null) => void` | T8 registers its repository lookup. |
| `uncacheAssets` | `(keys: Iterable<string>) => void` | Drops saved assets from the cache to free memory (they load again through the asset loader); unsaved ones are kept. |
| `commitModelRevision` | frozen `CommitModelRevisionFn` | See below. |
| `commitModelRevisionWith` | `(next: CrochetModelV1, o: CommitOptions) => Promise<CarryReport>` | The same, with `also`: more document changes in the same undo step. |
| `readModelRevision` | `(rev: number) => Promise<ModelRevisionSnapshot & { revision: ModelRevision }>` | Reads a stored revision back. |
| `revertToModelRevision` | `(rev: number) => Promise<void>` | Makes a stored revision current again (a new revision, source `'edit'`, with its mesh assets). |
| `beginSave` | `() => SaveTicket \| null` | Null: nothing to save now (no project, not dirty, or a save in flight). |
| `markSaved` | `(ticket: SaveTicket, o: { rev: number }) => boolean` | Writes `rev` and the ticket's `updatedAt`; false for a stale ticket. |
| `markSaveFailed` | `(ticket: SaveTicket, error: unknown) => boolean` | The changes stay unsaved, `saveStatus` becomes `'error'`, `saveError` the message; false for a stale ticket (a failed ticket cannot be marked saved later). |
| `rebind` | `(ticket: SaveTicket, o: { id: string; rev: number; name?: string }) => boolean` | The conflict copy of §5.5.2. |

**`commitModelRevision`** — what it guarantees:
1. With `carry: 'by-id'` the app-owned settings of the current model are carried into `next`
   (`carryOverWith`, including `carryPaintAnyway`); with `'none'` the model is taken as it is.
2. If the current model is not yet held by a revision (the user edited it since), it is first snapshotted as a
   revision of its own: `source: 'edit'`, `label: 'Before: <label>'`. So paint that was not carried, and every
   other edit, "stays in the previous revision" (§3.7.7).
3. The model is replaced (the document gets its own copy; the caller's object is neither kept nor frozen),
   `also` runs, and a `ModelRevision { rev, at, source, label, asset }` is appended; the asset is the canonical
   JSON of a `ModelRevisionSnapshot` of the NEW model (as `also` left it). `rev` continues after the highest
   integer `rev` of the list (a malformed stored entry — NaN, 1.5 — is skipped). With `also`, a revision is
   appended even when the model did not change, so a record that names `info.rev` always finds it.
4. All of it is ONE history entry (label = `o.label`): one undo restores the previous model and revision list
   exactly; redo brings both back. The revision assets stay in the asset store either way.
5. It is synchronous inside (the promise is already settled in effect when it returns), so no edit can slip
   between reading the previous model and writing the next.
6. A commit that would change nothing (same model, no `also`) does nothing and resolves with the report.
7. Rejects: `ReadOnlyError`; no project; no `doc.threeD`; `next` is not a crochet-model; called inside a recipe;
   `also` throws, removes `threeD` or the model, or changes `threeD.revisions` (nothing is changed).

**What T8's autosave gets** (persistence itself is T8's):

```ts
projectStore.subscribe((s, prev) => { if (s.changeId !== prev.changeId) schedule(800) }); // prev.doc = the doc before
const ticket = projectStore.getState().beginSave();
if (ticket) {
  try {
    const r = await repo.save(ticket.doc, ticket.newAssets, { baseRev: ticket.baseRev });
    if (r.ok) projectStore.getState().markSaved(ticket, { rev: r.rev });
    else {
      const name = `${ticket.doc.name} (copy, ${time})`;
      const copy = await repo.saveAsCopy({ ...ticket.doc, name }, ticket.newAssets);
      projectStore.getState().rebind(ticket, { id: copy.id, rev: copy.rev, name });   // then: new URL, banner
    }
  } catch (e) { projectStore.getState().markSaveFailed(ticket, e) }
}
```

`ticket.newAssets` holds every asset added since the last successful save, also those the document no longer
names after an undo (a redo may name them again). `open(doc, { readOnly })` after `repo.open`;
`setReadOnly(true)` when the lock is handed over or stolen (a dirty tab can still `beginSave`, and the
compare-and-swap decides); `setAssetLoader((key, ref) => …)` for assets that are not cached.

### `state/appStore.ts`

| Export | Signature | What it does |
|---|---|---|
| `appStore`, `useAppStore`, `createAppStore` | `AppStore`, `<T>(selector: (s: AppState) => T) => T`, `() => AppStore` | The app's store, its hook, a store for tests. |
| `Route` | `StartRoute \| ProjectRoute` = `{ screen: 'start' } \| { screen: 'project'; projectId: string; tab?: RouteTab }` | §5.3's `{ screen, projectId?, tab? }`. |
| `TAB_IDS`, `TabId` | `['source', 'chart', 'photos', 'import', 'shape', 'pattern', 'materials', 'export']` | The tab segment of a hash. **The tab registry (`app/tabs.ts`) must use these ids.** |
| `QA_ROUTE`, `RouteTab` | `'qa'`, `TabId \| 'qa'` | The wizard route `#/p/<id>/qa` is `tab: 'qa'`. |
| `START_ROUTE` | `{ screen: 'start' }` | |
| `parseHash` | `(hash: string) => Route` | Total. `#/` → start; `#/p/<id>` → the project without a tab; `#/p/<id>/<tab>`; unknown hashes → start; an unknown last segment of a well-formed project hash → that project without a tab. |
| `formatHash` | `(route: Route) => string` | `#/`, `#/p/<id>`, `#/p/<id>/<tab>` (id percent-encoded). `parseHash(formatHash(r))` equals `r`. |
| `sameRoute`, `isRouteTab`, `isProjectId` | `(a: Route, b: Route) => boolean`, type guards | `isProjectId`: non-empty, ≤ 200 chars, no `/`, no whitespace or control characters — what `projectStore.open` and the routes accept. **T8's id generator must produce such ids.** |
| `Prefs`, `FeatureFlags`, `PrefsPatch`, `DEFAULT_PREFS` | `{ units: UnitPref; terms: Terms; hand: Hand; dialect: 'compact' \| 'verbose'; features: { mosaic: boolean } }` | Defaults: `in`, `us`, `right`, `compact`, mosaic off. |
| `sanitizePrefs` | `(stored: unknown, base?: Prefs) => Prefs` | Whatever was stored → valid preferences. |
| `Capabilities`, `UNKNOWN_CAPABILITIES` | `{ webgpu: boolean \| null; storagePersisted: boolean \| null; folderMirror: boolean \| null }` | null = not probed yet. |
| `probeCapabilities` | `(env?: CapabilityEnv) => Promise<{ webgpu: boolean; storagePersisted: boolean; folderMirror: boolean }>` | `navigator.gpu.requestAdapter()`, `navigator.storage.persisted()`, `HEAD /__projects` → `x-cpg-mirror: on`. Never rejects. The shell calls it once and stores the result with `setCapabilities`. |
| `CapabilityEnv`, `MIRROR_PROBE_URL`, `MIRROR_HEADER` | interface, `'/__projects'`, `'x-cpg-mirror'` | |
| `Toast`, `ToastInput`, `ToastKind`, `TOAST_TIMEOUT_MS`, `MAX_TOASTS` | `{ id: number; kind: 'info' \| 'success' \| 'warn' \| 'error'; message: string; key?: string; action?: { label: string; run(): void }; timeoutMs: number }` | Default timeouts 4000 / 4000 / 8000 / 0 (errors stay); at most 5. |
| `AppState` | interface | `route`, `prefs`, `prefsHydrated`, `capabilities`, `library: ProjectSummary[] \| null`, `toasts`, and the actions below. |

Actions: `setRoute(route)` (an equal route changes nothing) · `setPrefs(patch)` (invalid values are ignored) ·
`hydratePrefs(stored: unknown)` (sets `prefsHydrated`) · `setCapabilities(patch)` · `setLibrary(list | null)` ·
`upsertSummary(summary)` · `removeSummary(projectId)` · `toast(input): number` (a toast with the `key` of a
showing one replaces it) · `dismissToast(id)` · `clearToasts()`.

Division of work with the shell: `app/router.ts` listens to `hashchange` and calls
`appStore.getState().setRoute(parseHash(location.hash))`; navigation writes `location.hash = formatHash(route)`.
`app/toasts.ts` renders `toasts` and runs the `timeoutMs` timers (the store starts no timer). T8 persists
`prefs` (`hydratePrefs` at start; save on change once `prefsHydrated`).

### `state/derivedStore.ts`

| Export | Signature | What it does |
|---|---|---|
| `derivedStore`, `useDerivedStore`, `createDerivedStore` | `DerivedStore`, hook, factory | The app's store empties itself when `projectStore.session` changes (open / close), not on `rebind`. |
| `DerivedValues`, `DerivedKind`, `DERIVED_KINDS` | `{ chart: ChartResult; pattern2d: PatternDoc; recon: ReconResult; ami: AmiResult }` | |
| `DerivedEntry<T>` | `{ inputHash: string; value: T }` | |
| `JobState`, `IDLE_JOB`, `JobName` | `{ status: 'idle' \| 'running' \| 'done' \| 'error'; inputHash: string \| null; progress: number \| null; error: { name: string; message: string } \| null }` | Jobs may have any name (`'depth'`, `'import'`, …); the four kinds are jobs too. |
| `DerivedState` | interface | `chart`, `pattern2d`, `recon`, `ami`: `DerivedEntry \| null`; `jobs: Record<string, JobState>`; actions below. |
| `jobOf` | `(state: DerivedState, name: JobName) => JobState` | `IDLE_JOB` for a job that never ran. |
| `isFresh` | `(state: DerivedState, kind: DerivedKind, inputHash: string) => boolean` | The stored result belongs to exactly these inputs. |

Actions: `run(kind, inputHash, compute): Promise<value | undefined>` — the usual shape of a slice action:
returns the stored value for the same inputs, joins a running job for the same inputs, otherwise computes and
stores; resolves `undefined` when superseded, failed (the error is in `jobs[kind]`) or overtaken; never
rejects · `beginJob(name, inputHash): void` · `setJobProgress(name, inputHash, progress: number): void` (clamped
to 0..1; ignored for a job that is not the latest) · `finishJob(name, inputHash): boolean` · `failJob(name,
inputHash, error): boolean` (false, and nothing recorded, for `Superseded` and for a job that is not the latest) ·
`setResult(kind, inputHash, value): boolean` (false when a job for other inputs of that kind is running) ·
`clear(name): void` · `reset(): void`.

```ts
const hash = fnv1a64Hex(canonicalJson({ settings, gauge, edits, sourceKey }) + CODE_VERSION);
void derivedStore.getState().run('chart', hash, () => workers.chart2d.run({ image, settings, gauge, edits, lines, stash }));
```

### `core/model/revisions.ts`

| Export | Signature | What it does |
|---|---|---|
| `carryOver` | frozen `CarryOverFn`: `(prev: CrochetModelV1 \| undefined, next: CrochetModelV1) => { model: CrochetModelV1; report: CarryReport }` | Carries `crochet` hints (always), `paint` (same type and every dim within 10%) and the features `next` lacks, by part id. Pure; `next` itself is returned when nothing was carried. |
| `carryOverWith` | `(prev, next, o?: CarryOptions) => { model; report }` | The same with `carryPaintAnyway`. |
| `CarryOptions` | `{ carryPaintAnyway?: readonly string[] }` | |
| `CarryReport` | re-export of the frozen type | `crochet`, `paint`, `paintDropped` (part ids, in the order of `next.parts`), `features` (feature ids). |
| `emptyCarryReport` | `() => CarryReport` | |
| `sameShapeWithin` | `(prev: Part, next: Part, tolerance?: number) => boolean` | "The same type and every dim within 10%", per part type (T7's diff can use it). |
| `PAINT_TOLERANCE`, `MAX_PALETTE`, `MAX_FEATURES` | `0.1`, `16`, `60` | |

### `test/fakes.ts`

| Export | Signature | What it does |
|---|---|---|
| `createFakeLocks` | `() => FakeLockManager` | A `LockManagerLike` with the semantics of `navigator.locks` (exclusive locks, FIFO, `ifAvailable`, `steal`). |
| `FakeLockManager` | `LockManagerLike & { client(clientId?: string): FakeLockClient; query(): { held: FakeLockInfo[]; pending: FakeLockInfo[] }; isHeld(name: string): boolean; flush(): Promise<void> }` | `client()` = another fake tab sharing the same locks. |
| `FakeLockClient` | `LockManagerLike & { clientId: string; close(): void }` | `close()` = the tab was closed: its locks are released, its queued requests dropped. |
| `FakeLock`, `FakeLockInfo` | `{ name: string; mode: 'exclusive' }`, `{ name; mode; clientId }` | |
| `createFakeChannels` | `() => FakeChannelHub` | BroadcastChannel semantics. |
| `FakeChannelHub` | `{ channel(name: string): ChannelLike; flush(): Promise<void>; openCount(name?: string): number }` | `channel` is the factory for `createProjectRepository({ channel })`. |
| `createFakeWorker` | `(api: object) => FakeWorker` | A comlink worker without a thread (real comlink messages over a MessageChannel). |
| `FakeWorker` | `Endpoint & { terminate(): void; readonly terminated: boolean; crash(message?: string): void }` | |

Timing of the fakes: nothing calls back synchronously. Lock callbacks and channel messages arrive in a later
macrotask (a MessageChannel ping that vitest's fake timers do not hold back); wait for the promise you care
about, or `await locks.flush()` / `await hub.flush()`. As in Chromium, a released lock goes to the next waiter
in the same step (it is never free while someone waits), and a granted callback runs in a task of its own: on
`steal`, the old holder's request rejects (AbortError) before the stealer's callback starts, so a two-tab test
sees the old tab go read-only first. The same scenario scripts gave identical logs on these fakes and on
`navigator.locks` / `BroadcastChannel` in headless Chromium ("How it was verified").

## Deviations from the spec, with reasons

1. **The history's patches are not immer's.** §5.3 says "immer patches + inverse patches". The recipes still
   run in immer (`produce`), and the patch format is immer's, but the patches are derived in `history.ts` from
   the two documents (a structural diff, `diffDocuments`) and applied there (`applyPatches`). The independent
   review showed that the patches immer 11.1.18 generates are wrong for recipes that tools will write: a point
   inserted twice into a lathe profile (`points.splice(2, 0, points[1])`) and then dragged and sorted, and a
   draft modified and then replaced by its `original()`. Undo was right, but REDO produced a document the user
   never had, and a no-op recipe recorded a history entry. A diff of two states cannot be wrong about how the
   second came about. Side effects: one patch per pushed or spliced array element (immer rewrites every
   following index); a recipe that leaves the document deeply equal records nothing; a document that holds one
   object in two places behaves as if it held two equal objects (checked against plain JavaScript on 24 000
   random steps).
2. **`Superseded` declares `jobId` as a field.** A constructor parameter property is not erasable syntax
   (as for `NotImplementedError` in 0a). The public shape is the one of §5.2.1.
3. **Latest-wins channels are grouped per worker.** D22 says "a latest-wins channel per worker API", §5.4 item 1
   "per API method". A worker has ONE gate, and `supersede(n)` stops every job below n whichever method started
   it, so two independent channels on one worker let a second `projectColors` request cancel a `build` that
   nobody replaced (its caller would wait for a newer request that never comes). `createLatestWinsGroup`
   therefore keeps one job in flight per worker and one pending request per job method; a request of another
   method waits for the job in flight instead of cutting it short, and job ids only grow in the order the
   worker sees them. Only `GeomApi` has two job methods; for the other workers this is exactly §5.4.
   `latestWins(send, supersede)` (the frozen signature) is a group with one channel.
4. **A replaced job in flight always rejects with `Superseded`**, also when the worker finished it before it
   reached a check: "resolve only the last" (§5.4 tests).
5. **`yieldMacrotask` adds a `setImmediate` hop in Node.** Node polls message ports in handle order, not in
   posting order: a single ping resolved before a message queued earlier on another port in 200 of 200 runs
   when the ping channel was the older one. In the browser (no `setImmediate`) it is the single ping of §5.4.
   `setImmediate` is captured at module load, so vitest's fake timers do not freeze the gate.
6. **Buffers are transferred only when the caller says so.** §5.4 item 3 has the client wrappers wrap
   request-owned arrays in `Comlink.transfer`; a wrapper cannot know which buffers a store or the viewport
   still holds, and transferring one detaches it. Callers mark the argument: `transfer(request, [buffers])`
   (it works through the latest-wins wrappers too). Callbacks are proxied by the client (`ml.depth`).
7. **`update` returns a boolean and does not throw on a read-only project.** "Rejects `update` with a banner"
   (§5.3): nothing is changed, `update` returns `false` and `rejectedEdits` counts up for the banner. A stray
   edit in a read-only tab is an expected state, not a crash. `commitModelRevision` and `putAsset` have a
   result to deliver, so they reject with `ReadOnlyError`.
8. **`commitModelRevision` is synchronous inside** (the frozen async signature is kept). `crypto.subtle.digest`
   is async, and an edit that slipped in between reading the previous model and writing the next would be
   lost. The revision assets are hashed with a small synchronous SHA-256 (`sha256Hex`, checked against
   node:crypto on 149 lengths from 0 to 1 048 631 bytes and on a subarray); `putAsset` uses `crypto.subtle`
   when it exists.
9. **Persistence-owned fields.** Recipes must not change `schema`, `version`, `id`, `createdAt`, `updatedAt`
   or `rev` (the update throws), and undo/redo never changes them. `updatedAt` is stamped when a save starts
   (`SaveTicket.doc.updatedAt`) and written to the open document by `markSaved`; `rev` comes from
   `repo.save`. So an undo after a save cannot move `rev` back under the compare-and-swap.
10. **`open` and `close` refuse to drop unsaved changes** unless `{ discardUnsaved: true }` is passed
    (`UnsavedChangesError`). Not in the spec; it is the "never lose user data" rule at the last place where a
    navigation could lose an edit that the debounced autosave has not written yet.
11. **`threeD.revisions` cannot be written through `update`** (it throws): only `commitModelRevision` appends
    revisions. Replacing or editing `threeD.model` in an `update` stays allowed — Proportions and gizmo edits
    are "one history step" without a revision (§4.2).
12. **`SaveStatus` has `'unsaved'`** next to the four states of `useAutosave`: T8 maps it to its chip.
13. **Extras not named in the spec:** `commitModelRevisionWith` (`also`), `readModelRevision`,
    `revertToModelRevision`, `endCoalescing`, `getAsset` / `cacheAsset` / `uncacheAssets` / `setAssetLoader`, `session`,
    `rejectedEdits`, the selectors; `decodeBlob` and the decode constants; `createLatestWinsGroup`, `transfer`,
    `transferAll`, `collectTransferables`, `exposeApi`, `isSuperseded`; `WorkerTerminated`, `setWorkerSpawner`;
    `probeCapabilities`, `prefsHydrated`, `sanitizePrefs`, `isProjectId`, toast keys and the cap of 5;
    `derivedStore.run` and open-ended job names; `sameShapeWithin`, `carryOverWith`; `diffDocuments`,
    `applyPatches`; `createFakeWorker`, lock clients (`client()`, `close()`), `flush()`.
14. **`workers.importer`**, not `workers.import` (a reserved word is awkward to destructure); the worker name
    stays `'import'`.
15. **Decode limits.** An image above 64 megapixels or 16 384 px on a side is refused with a message
    (`too-large`); the spec gives no limit, and a 100 MP decode needs 400 MB in the worker. AVIF is never sent
    to `/__convert` although it lists the `mif1` brand (Chrome decodes AVIF; `sips` is the HEIC converter).
16. **`parseHash`: an unknown tab segment of a well-formed project hash opens the project** at its default tab
    instead of the start screen; every other unknown hash gives the start screen.

## Ambiguities resolved

| Where | Reading |
|---|---|
| §5.2 `ModelRevision.asset` — the spec does not say what the asset holds | The canonical JSON of `{ format: 'crochet-model-revision', version: 1, model, meshAssets }`: the model that revision introduced, plus the `threeD.meshAssets` entries of its mesh parts (`<meshRef>`, `sdf:<meshRef>`) at that time, so a revert restores the meshes that belong to it even when a mesh ref was re-pointed later (sculpting). |
| §3.7.7 "the previous revision … kept", "[paint] stays in the previous revision" — but the user edits the model in place after a revision was made | Before replacing a model that no revision holds yet, the commit snapshots it as a revision of its own (`source: 'edit'`, `label: 'Before: <label>'`). A model that is already held by a revision (same content hash) is not snapshotted again. |
| §5.2 `ModelRevision.rev` | A per-project sequence: highest existing integer `rev` + 1 (malformed stored entries are skipped). It is what `ImportRecord.revision` refers to. After an undone commit the next commit reuses the number: the undone entry (and any record that named it) left the document with the undo; its asset stays under its own content key. (`CrochetModelV1.revision` is the model's own counter and is not touched.) |
| §3.7.7 "Accept … a new model revision" for an import whose model equals the current one | With `also` (T7's import path) a revision is appended anyway, so the `ImportRecord.revision` that `also` writes names an existing revision; its asset is the existing one (same content key, nothing new to store). Without `also`, an unchanged model is no change at all (no entry, no history step). |
| §4.4 "undoable and also create a persisted model revision" vs §5.3 "a named update" | The `ModelRevision` entries are part of the update, so one undo removes them again and restores the document exactly; the revision ASSETS stay in the asset store (and go out with the next save). The alternative — a revision list that undo never shrinks — would make undo restore a document that differs from the one before the step. |
| §5.2.1 `carryOver(prev, next)` has no `carryPaintAnyway`, `commitModelRevision` has | `carryOverWith(prev, next, { carryPaintAnyway })` in the same kernel; `carryOver` is that without options. |
| §3.7.7 "paint only when … every dim is within 10%" | Each numeric dim against its previous value (`|next − prev| ≤ 0.1·|prev|`); a previous dim of 0 must stay 0. `open` (cylinder) and `sharp` (lathe) are not dims; a torus without `arcDeg` is 360°; a `flat` must keep its `shape`, a polygon its point count (points within 10% of the larger of w, h); a `mesh` part is compared by `bboxIn`; a lathe is compared as a curve — height and largest radius within 10%, and the radius at 33 heights within 10% of the largest radius — because a re-imported body rarely keeps its number of profile points. |
| §3.5.1 `paint.data` holds palette INDICES, and an import may reorder or rename the palette | Carried paint is re-indexed by color identity: the same palette id, else the same hex, else the color is appended to the new palette (≤ 16), else the nearest color by ΔE00. A carried feature's `color` (a palette id) is mapped the same way. A field that cannot be decoded (not 64 × 64) is carried only when the palette indices did not move. |
| §5.5.5 "`crochet` hints … carried over" when the new model has hints too | The previous value wins, key by key (the user's setting), and keys only the new model has are kept. The same for paint: the previous paint replaces paint the new model brought, when the shape matches. A caller that wants the new model's own paint (Apply photo colors) commits with `carry: 'none'`. |
| §5.5.5 "features added in the editor" — nothing marks a feature as editor-made | Every feature of the previous model whose id the new model lacks is carried when its part still exists (to at most 60 features), and reported in `report.features`. See request 6. |
| `CarryReport` for things that needed no change | A part is listed only when something was written onto it; a part whose new version already has the same hints or paint is in no list, and `paintDropped` lists only parts that still exist. |
| §5.3 "keyed by input hash" | One slot per kind holding `{ inputHash, value }` (the latest), not a cache of many hashes. The caller computes the hash. |
| §5.3 route `{ screen, projectId?, tab? }` and the wizard route `#/p/<id>/qa` | A discriminated union with the same fields; the wizard is `tab: 'qa'`. `#/p/<id>` (no tab) is a valid route: the shell redirects to the project's default tab. |
| §5.3 "toasts" | Data only; the shell's `app/toasts.ts` shows them and runs the timers. |
| §2.3.1 "the converted JPEG is the stored source", but `decodeImage` returns only pixels | `decodeBlob` returns `{ image, source, convertedFromHeic }`; the intake flow stores `source`. |
| §2.3.1 decode order | As written: the browser decode first, HEIF sniffing only when it fails. (A browser that decodes HEIC itself keeps the HEIC as the source.) |
| §6.3 T8 "fake lock manager" timing | The fakes call back in a later macrotask, like the real APIs; a released lock goes to the next waiter in the same step, and a granted lock callback runs in a task of its own (checked against Chromium, below). |

## Requests for integration

1. **`src/types/__checks__/entryPoints.check.ts`** (S0, frozen for this part): add `carryOver`, `commitModelRevision`,
   `decodeImage`, `yieldMacrotask`, `createJobGate`, `latestWins`. Until then the tests of this part assert the
   identical signatures with `expectTypeOf`.
2. **§5.4 item 1 vs D22:** say that the job methods of one worker share one in-flight slot (deviation 3), or
   give `Cancellable.supersede` a channel argument in a later amendment.
3. **§5.2 `ModelRevision`:** say what the asset holds, how `rev` counts and when an unchanged model still gets
   a revision (the first four rows of "Ambiguities resolved"), and that undo removes the entries again.
4. **T8, asset GC (§5.5.5):** `AssetRef`s inside a model-revision asset (`ModelRevisionSnapshot.meshAssets`)
   are references too; a GC that looks only at documents would delete the meshes of old revisions and break
   "old revisions kept, revertible" for mesh parts. Revision assets left behind by an undo are unreferenced
   and may go after the 7 days.
5. **T3 / T6 / T7, mesh vertex labels:** like `paint`, `ColoredMesh.labels` are palette indices; `carryOver`
   re-indexes `paint` but cannot touch mesh assets. A flow that keeps a mesh part while the palette changes
   has to re-index its labels (or the spec should store labels by color identity, as the 2D side does).
6. **`Feature` has no marker for "added in the editor"** (§5.5.5): `carryOver` brings back a feature that
   Claude Design removed on purpose. Either T7 filters with the seed (`qa.seed.features`) before committing
   (commit with `carry: 'none'` after its own `carryOverWith`), or `Feature` gets an optional additive field
   (`origin?: 'editor'`) that `carryOver` can test.
7. **Tab ids:** the Step 0c tab registry must use `TAB_IDS` of `state/appStore.ts`; a new tab is added there.
8. **Project ids (T8):** `isProjectId` — no `/`, no whitespace, ≤ 200 characters; `crypto.randomUUID()` fits.
9. **Assets by key (T8):** `PhotoView.imageKey` / `maskKey` / `labelsKey` are bare keys, while
   `ProjectRepository.getAsset` takes an `AssetRef`. `projectStore.getAsset(key)` calls the registered loader
   with the key (and the ref when the caller had one), so T8's loader needs a lookup by key.
10. **Conflict copy and asset keys (T8, §5.5.2):** after `rebind` the document's asset refs keep their
    `<originalId>/<sha256>` keys and new assets get `<copyId>/…`. If `saveAsCopy` re-keys the copy's assets,
    the store needs the re-keyed refs (a hook that takes the stored document); if not, GC of the original
    project must respect references from its copies.
11. **`useAutosave().status`** has no "unsaved changes, save pending" value; T8 maps `'unsaved'` to `'saving'`
    (or the union gets a fifth member).
12. **SHA-256:** a synchronous implementation now lives in `state/projectStore.ts`; if another track needs
    one, it belongs in `core/kernel/hash.ts`.
13. **T1, decoding per request:** `Chart2dApi.run` gets the image as a `Blob` on every slider tick, and a
    structured-cloned Blob has no identity to cache on. T1 can cache the decoded `RgbaImage` in its worker by
    blob size + type + a hash of the bytes; an optional `sourceId` in `ChartRequest` would make that exact.
14. **§2.3.1, alpha:** drawing a non-premultiplied bitmap on a 2D canvas premultiplies it; reading back gave
    `[199, 100, 50, 128]` for a pixel stored as `[200, 100, 50, 128]`, and the RGB of fully transparent pixels
    is lost. Harmless for §2.3.2 (coverage < 0.5 ⇒ background), but worth one sentence in the spec.
15. **`src/state/slices/*.ts`:** §5.1 assigns them to T2, T3, T6, T7, T8, but 0a created no placeholders
    there; each track creates its own.
16. **0c / T8, console errors from `/__convert`:** Chromium logs "Failed to load resource: the server
    responded with a status of 501 (Not Implemented)" for the HEIC conversion attempt against the Step 0 stub
    (and against T8's plugin off macOS) — the same reason §5.5.4 gave the mirror probe a 204. A smoke spec that
    adds a HEIC photo must allow that line, or the plugin can answer "no converter" with 200 and a non-image
    body (e.g. `application/json`): `decodeBlob` already maps every non-image 200 to the same `heic-unavailable`
    message, so only §5.5.4's wording would change.
17. **T8, undo across a conflict copy:** `rebind(ticket, { name })` writes the copy's name outside the history,
    so undoing a rename made BEFORE the conflict restores the old name in the copy too ("Teddy (copy, 12:34)" →
    "Bunny", the original's name). Nothing is lost, but the banner and the library should tell the two apart by
    id/updatedAt, not by name.

## How it was verified

The sessions that built this part were cut off twice by usage limits. The session that finished it treated the
earlier notes as claims and re-ran every check below itself; a line says so where a result is only the earlier
session's.

- **Unit tests** (vitest, node; one file under happy-dom): 281 tests in 11 files; the whole suite 571 tests in
  31 files, green in two consecutive runs, with `npm run typecheck` and `npm run lint` at exit 0.
- **Property tests with a seeded PRNG:** undo / redo against a reference that keeps whole documents — 6 walks
  of 1 500 steps in `history.test.ts`, 3 walks of 700 steps through the store with model commits, drags and
  the cap, and 700 walks of 150 steps over 49 hostile recipes (aliasing, `original()`, `current()`, sorts,
  moves) in `historyRecipes.test.ts`; `diffDocuments` / `applyPatches` on 4 000 random pairs of JSON values and
  on 4 000 pairs of hostile values (-0, NaN, ±Infinity, `undefined`, keys such as `__proto__`, `length` and `''`,
  null-prototype objects; half of the pairs small edits of each other); the latest-wins group on 12 random
  request sequences over three channels; `carryOver` on 150 random model pairs (purity, idempotence, color
  identity of every carried paint cell); route round trips on 602 routes (300 random ids).
- **Mutation checks** (not committed): 104 deliberate one-line breaks of the rules above — the 90 of the earlier
  session's harness (its notes reported only the first 41, 39 caught) and 14 for the fixes of the finishing session
  — each applied alone to the final code and followed by `npm test` on its folder; 99 were caught. The 5 survivors
  are equivalent: `sameShapeWithin` without the type check (no other part type has those dims, so the comparison
  fails anyway); a suffix match in the array diff that may overlap the prefix (the overlapping elements are
  identical, so removing either index gives the same document and inverse); the client's "only the current instance
  may crash the handle" guard (a stopped instance's listeners are removed first); `supersede` spawning a worker
  that has none (the pending request spawns it a tick later anyway); and `ifAvailable`'s "others are waiting" test
  (the fake never leaves a lock free while someone waits — before the hand-over fix this one was NOT equivalent:
  the earlier notes called it so, and the window was real). The first run also found one gap, closed with a test: a
  job from before `derivedStore.reset()` could complete a new job for the same inputs.
- **In a real browser** (headless Chromium 153.0.8010.12, Playwright's build 1243; a throw-away page and three
  throw-away workers under `zz-verify/`, served by this worktree's dev server with `CPG_TEST=1`, a temporary
  `CPG_PROJECTS_DIR` and port 5257, deleted afterwards — nothing of it is committed; the committed Playwright
  smoke test is Step 0c's):
  - **fakes against the real APIs:** the same scenario script ran on `navigator.locks` and on
    `createFakeLocks()` (FIFO queue, nothing granted synchronously, `ifAvailable` on a held lock / behind a
    waiter / on a free lock, `steal` with the old holder's request rejecting with `AbortError` while its
    callback keeps running and the stealer going ahead of the waiter, steal on a free lock, the two
    `NotSupportedError`s, callbacks that throw or reject), and on `BroadcastChannel` and `createFakeChannels()`
    (nothing synchronously or in a microtask, no delivery to the sender, a second channel of the same name in
    the same tab receives, posting order, a clone taken at posting time, closed and late channels,
    `InvalidStateError`, `DataCloneError`, a reply from inside a handler), plus two hand-over scenarios
    (`ifAvailable` asked while the holder lets go with a waiter queued, and right after the holder's request
    resolved). Channels: identical logs (10 lines). Locks: two differences, each fixed in `fakes.ts` and then
    identical (38 lines): on `steal`, Chromium rejects the old holder's request BEFORE the stealer's callback
    starts (the fake started the callback first: a granted callback now runs in a task of its own); and
    Chromium hands a released lock to the next waiter in the same step, so that waiter's callback runs before
    a later `ifAvailable` answer (the fake handed over a task later: release and grant are now one step);
  - **the six real worker stubs:** none running before the first call; `chart2d.run`, `geom.mask`,
    `ml.status`, `ami.generate`, `mesh.fit`, `importer.importInputs` each spawned its worker and rejected with
    `isNotImplementedError(e)` true and `isSuperseded(e)` false (`Chart2dApi.run not implemented`, …);
    `crossOriginIsolated` false, `SharedArrayBuffer` undefined (D20);
  - **latest-wins on a real slow worker** (`exposeApi` + gate, jobs of 40 stages × 25 ms of busy work): five
    rapid `chart2d.run` requests took 1 032 ms; four rejected with `Superseded`, the last resolved; the worker
    saw jobs `[1, 5]` started, `[5]` finished, `supersede` `[2, 3, 4, 5]`, and job 1 stopped at its first
    check (0 of 40 stages). A newer request sent 60 ms into such a job stopped it after 2 stages; the newer
    one resolved 15 ms after it was made;
  - **yield:** `yieldMacrotask` let a message queued on another (younger) port run first in 50 of 50 tries;
    no `setImmediate` in the browser, so the single ping of §5.4 is what runs there;
  - **callbacks, transfer, cancel, crash:** a progress callback arrived through `Comlink.proxy` (`[0.5]`);
    `ml.cancel()` then rejected the call in flight with `WorkerTerminated` (`crashed: false`) and the next call
    spawned a fresh worker that answered; a buffer marked with `transfer()` was moved (0 bytes left, the worker
    received 16) and an unmarked one cloned (16 left); a worker script that throws while loading rejected its
    first call with `WorkerTerminated` (`crashed: true`, "the ml worker crashed: Uncaught Error: …") and the
    next call spawned it again;
  - **decode** (on the page and in a real worker behind comlink): a PNG from `encodePng` came back pixel-exact
    for its opaque pixels; a half-transparent `[200, 100, 50, 128]` came back `[199, 100, 50, 128]` and a fully
    transparent `[1, 2, 3, 0]` as `[0, 0, 0, 0]` (request 14); an 8 × 4 JPEG (left half red, right half blue)
    with an EXIF orientation 6 segment inserted came back 4 × 8 with red on top; HEIC bytes (`ftyp heic`,
    compatible `mif1 heic`) went to the Step 0 `/__convert` stub, got 501 and gave `heic-unavailable` with the
    exact §2.3.1 message, recognizable by name also from the worker; an `RgbaImage` passed through as the same
    object. The only console error of the whole run was that 501 (request 16).
  - Reported by the earlier session and not re-run here: a production build under `vite preview` emits the six
    workers as separate chunks from the `new Worker(new URL(…))` expressions of `client.ts`.
- **Not verified here:** a real HEIC conversion (`sips` behind T8's `/__convert`), Safari and Firefox, the
  committed e2e smoke test (0c: real-browser decode, the progress callback and "a nested worker answers from
  inside another worker" of §5.4's test list are verified there), and `src/types/__checks__/entryPoints.check.ts`
  for the 0b modules (request 1).

## Independent review

Two review passes by separate agents, with the brief to read the code against §5.3, §5.4, §5.5.5 and §3.7.7
and to break it with adversarial sequences, and a third check by the session that finished this part.

**First pass** (cut off by a usage limit; its scratch tests and logs were recovered and its fuzz is now
`state/__tests__/historyRecipes.test.ts`). It found one defect, and it was a serious one:

| Finding | Severity | Fix |
|---|---|---|
| The history trusted immer's generated patches. immer 11.1.18 gets them wrong when a recipe replaces a modified draft by its `original()`, and for move / swap / sort / splice recipes on a document that holds one object twice (e.g. after "duplicate point", `points.splice(2, 0, points[1])`). Undo was exact in every run; REDO produced a document that never existed in 214 of 1 200 random walks; a recipe that changed nothing recorded an entry. | critical (wrong redo) | `history.ts` derives the patches from the two documents and applies them itself (deviation 1). The reviewer's recipes, its two store scenarios and direct tests of the diff are in the suite; all of its walks pass (0 undo, 0 redo failures). |

The suite now also checks, on 24 000 random steps, that the document immer PRODUCES is right in all these
recipes (it equals what plain JavaScript gives on a copy without shared objects): only the patches were wrong.

**Second pass** (also cut off by a usage limit, before it wrote any finding down; its two probe files,
`zz-review2-history.test.ts` and `zz-review2-store.test.ts`, logged results instead of asserting them and broke
typecheck and lint). The finishing session re-ran the probes, judged each result, turned the sound ones into
assertions in `history.test.ts` and `projectStore.test.ts`, and deleted the files:

| Probe | Result | Outcome |
|---|---|---|
| diff + apply on 4 000 random pairs of hostile values (-0, NaN, Infinity, `undefined`, keys like `__proto__`, null-prototype objects) | 64 of 4 000 pairs (72 directions) not exact. Every one was a prototype: `applyPatches` copied a null-prototype object as an ordinary one, and the diff saw no change when an ordinary object became a null-prototype one | fixed: copies keep their prototype, and an object whose prototype changed is replaced whole; 0 of 4 000 now (seeded test, also checks "no patches exactly when equal") |
| store actions called from inside a recipe | `markSaved` there left `doc.rev` 3 next to `baseRev` 4 (the recipe's result overwrote the saved doc); an `endCoalescing` there was lost | fixed: every action that writes the store throws inside a recipe or `also`; test covers 13 actions and `also` |
| hostile `also` in a commit (checked again on the code before the fix) | `delete d.threeD` went through and removed all 3D data, revisions included; wiping `threeD.revisions` removed revision 1; replacing `threeD` with a fresh copy lost the new `ModelRevision` entry (it was pushed into the detached draft) | fixed: `threeD` is read again after `also`; removing it or the model, or changing the revision list, rejects and changes nothing; tests |
| stored revisions with `rev` NaN / 1.5 | the next rev became NaN / 2.5 | fixed: only integer revs count; test |
| the same model committed again with an `also` that changes nothing | a new revision each time, with the same asset | kept on purpose (`info.rev` must name a revision); documented, test |
| a commit whose revision asset is already cached | a new (equal) asset Map in the state anyway | fixed: the maps are replaced only when an asset was added |
| SHA-256 at the padding boundaries, at 1 MiB and on a subarray | equal to node:crypto | added to the SHA test |
| save hooks in hostile orders: undo during a save, stale tickets after a failure or a reopen, read-only during a save, `rebind` while `putAsset` hashes, `putAsset` across close + reopen, the same bytes under two mime types | consistent; the asset of a `putAsset` that was hashing during a `rebind` gets the copy's key | the sound ones kept as assertions; two mime types share one key and the first blob (content-addressed) |
| `rebind` (with a name), then undo of a rename made before it | the copy's name goes back to the original's | documented (request 17) |
| sparse arrays, extra properties on arrays, Dates, nesting of 3 000 levels, a 60 000-element array rewritten in one recipe | a hole reads as `undefined`; array extras unseen; an equal Date is replaced; 3 000 levels throw RangeError (1 000 work; immer itself stops at 1 500); 60 000 elements: 274 ms, undo 9 ms, exact | not project data, or fine; documented in `history.ts` |

Each fix was checked against its test: with that fix reverted alone, the suite failed (8 of 8 in a first run;
also part of the mutation run above).

**Third check** (the finishing session): the browser comparison of the fakes with `navigator.locks` and
`BroadcastChannel` described under "How it was verified". It found the two lock differences above (the order of
the old holder's `AbortError` and the stealer's callback on `steal`; the hand-over of a released lock a task
late), both fixed with tests that pin Chromium's order. The mutation run found the `derivedStore.reset` gap.
It also found the heavy property tests of this part running out of vitest's default 5 s under load (5.3 s);
they now have explicit 60 s timeouts, and the per-update cost test uses the one-frame bound its comment names
(16 ms; measured 2.0 ms idle, 6.5 ms with all cores loaded).
