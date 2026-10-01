# Integration after Sprint 2 (DESIGN.md v1.5)

Branch `integration/s2`, worktree `.claude/worktrees/int-s2`, from `master` at `8717c1d` (Sprint 2 merged: T1.2–T8.2).
Every "Requests for integration" item added in Sprint 2 to `docs/tracks/t1.md` … `t8.md` is decided below, plus what
was left open in `integration-s1.md`. Same rules as the Sprint 1 pass: only **additive** changes to `src/types` (new
optional fields, new union members, new types, new stubs); spec and types agree (`node scripts/check-spec-types.mjs`,
139 declarations); track-owned code was changed only where the job said so (T2's bridge overloads, removed together
with the guard change; the cross-cutting timing fix in track test files). Everything else a decision needs is a task
in "Tasks handed to tracks for Sprint 3".

Decisions: **Accept** (applied as asked), **Accept*** (accepted with changes; the reason says which), **Reject**.
"Where" names the spec section, type file or S0 file changed, or "—".

Commits: `6ded7af` S0-amend (asset codecs, frozen render helpers, exact `decMethod` checks, additive types, icons,
panel CSS, `ProjectGrid` slot, shared HEIF sniffer), `a5b3fa8` S0-amend (wall-clock budgets: perf tag, `budget()`,
`npm run perf`, load-robust waits), `a8f635a` S0-amend (`validateDoc2D` and `openAttachTool` frozen), `cc4da7e`
Design v1.5, then this file and the review fixes (below).

## Decisions

### Left open by `integration-s1.md`

| # | Item | Decision | Reason | Where |
|---|---|---|---|---|
| s1-a | Restore `SameSignature` for `abbreviationsFor` / `specialStitchesFor` once T2.2 lands | Accept | Done together with t2 request 11 | `__checks__/entryPoints.check.ts`, `core/pattern/terminology.ts` |
| s0-18 | `npm i -g npm@11.21.0` | — | Still the owner's call; nothing needs it (npm 10 runs every script) | — |

### `t1.md` (T1.2)

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 6 | Six T1 issue codes | Accept | Used by `colorize` and the palette code | §2.13 track table |
| 7 | §2.4.3 exact K, pooled points | Accept | The knee drops a real color when D(K) reaches 0; pooling is a measured 5× speed-up | §2.4.2, §2.4.3 |
| 8 | Anti-aliasing blend removal (decision 15) | Accept | G14 cannot pass without it | §2.4.3 |
| 9 | Salience details, color budget (decisions 19–20) | Accept | Review-tested; the 0.3% cap stops a far palette collapsing a photo | §2.4.3 |
| 10 | §2.4.4 decisions 18, 21, 23, 24, 26, 28; `DEFAULT_REFERENCE_LINE_ID` for T2 | Accept | | §2.4.3 (merge scope), §2.4.4; task T2-3 |
| 11 | §5.5.5 hand-edit identity (decision 22) | Accept | | §5.5.5 |
| 12 | §2.3.2 brush and fill (decision 13) | Accept | | §2.3.2 |
| 13 | §5.6 provenance fields | Accept | `YarnLine` unchanged (the JSON is a superset) | §5.6 |

### `t2.md` (T2.2)

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 11 | `SameSignature` for the two terminology functions, bridge overloads deleted in the same change | Accept | Typecheck green with both | `entryPoints.check.ts`, `terminology.ts` |
| 12 | Border in the `Line` model; spacing hints through `renderLine` | Accept* | Deviation 10's convention adopted (Rnd 1's arrow = start corner, `join B` cue = join), no `Line.border` field (rejected: a type change for something the lines already say). `renderLine` prints border rounds singly without hints; whole patterns (Pattern view, export, **T8's PDF**) print through `renderPatternText` / `PatternView`, which give the exact §2.7.10 text. `renderPatternText` moves from T2.4 to T2.3 so T8.3 can use it | §2.7.10, §6.3 T2; tasks T2-1, T8-3 |
| 13 | §2.6.2 block repeats | Accept | | §2.6.2 |
| 14 | §2.7.10 per-side minimum 2, hint fallback, hint placement, mosaic joins | Accept | | §2.7.10 |
| 15 | §2.7.4 cue words, last line cuts nothing | Accept | | §2.7.4 |
| 16 | §2.7.6 C2C region cues printed by default, G10 bare text, phase note | Accept | Same rule as G9 | §2.7.6 |
| 17 | §2.8 tube ring and joins, grams/skeins need yarn data | Accept | | §2.8 |
| 18 | T8's pre-export `validateDoc2D(doc, { settings, gauge })` | Accept* | Also **frozen** (`ValidateDoc2DFn`, §5.2.1): T8 calling T2's unfrozen code was a cross-track break waiting to happen | `types/entryPoints.ts`, §5.2.1, guard; task T8-4 |

### `t3.md` (T3.2)

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Seven recon codes | Accept | | §2.13 track table |
| 2 | Build failures as a rejected `ReconError` (message starts with the code) | Accept | A rejection, not an `error?: Issue` channel: a failed build has no `ReconResult`; comlink keeps name and message | `GeomApi.build` comment (types + §5.2), §2.9.3 |
| 3 | §2.9.3: one-plane builds, κ = 1 multi-view, depth stretch (4a), T at ~2 px/voxel, single photo uses rot90/mirror only, exact R_loc | Accept | 4a confirmed: exact for ellipsoids, s ≈ 1 on sphere and teddy (unchanged results), fixes deep objects | §2.9.3 |
| 4 | `targetHeightIn` comment | Accept | | `types/geometry.ts`, §5.2 |
| 5 | Thresholds 0.2% (thin) and IoU 0.9 | Accept | | §2.9.3, §2.9.5, §2.13 |

### `t4.md` (T4.2)

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 10 | `W_RUFFLE` on ovals: circular part only | Accept | The side growth 2ΔS lengthens the sides, it does not flare the end; the teddy muzzle warned falsely | §2.13; task T4-2 |
| 11 | Define `W_JOG`; whole-round color changes in spirals | Accept | Yes, both: a jog shows either way | §2.13; task T4-4 |
| 12 | §2.10.8 oval arc placement, end split, round-start cut | Accept | | §2.10.8 |
| 13 | R8 / `W_STACKED` readings | Accept | | §2.13 |
| 14 | `E_SPIRAL_CHAIN` exempts `start: join` | Accept | | §2.13 |
| 15 | `W_SINGLE_ST` "flagged embroidery" | Accept* | No field: embroidered details are `Feature`s printed as notes, never `Op`s, so every worked run is checked | §2.13 |
| 16 | 1197 `W_STAGGER` on 2000 random lathes | Accept* | Not accepted as noise (a warning on 60% of shapes teaches users to ignore warnings): a third rotation override — the smallest extra left rotation that satisfies R8 — for change rounds in R8's scope; goldens unchanged | §2.10.8; task T4-3 |
| — | (integration) T4's 3D text imports T2's unfrozen `renderFoundation` / `renderLineExtras` | Accept | Frozen in §5.2.1 (`RenderFoundationFn`, `RenderLineExtrasFn`), checked by the guard and the runtime test | `types/entryPoints.ts`, §5.2.1 |

### `t5.md` (T5.2)

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 7 | `MeshApi.pathB` seed and attachment | Accept* | The first option: optional `seed?: Vec3` and `attach?: Vec3[]` (part-local) on the request; the caller (T4's `generateAmigurumi` / ami.worker) fills them from the model; no `attach` = root | `types/workers.ts`, §5.2, §2.10.7; tasks T4-5, T5-1 |
| 8 | §2.10.7 text, sign `Lφ = −∇·X`, "adjacent" = 2 edges | Accept | | §2.10.7 |
| 9 | Warn on `remesh.components > 1` / `oddColumns > 0` | Accept* | Codes named by integration: `W_MESH_PIECES`, `W_MESH_OPEN` | §2.10.7, §2.13; task T5-2 |

### `t6.md` (T6.2)

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 6 | `mirror` and `link` icons in the S0 set | Accept | T6's glyphs moved into `Icon.tsx` | `ui/common/Icon.tsx` (test); task T6-2 |
| 7 | T3 creates `threeD.recon` before the pre-model panel | Accept | The panel must not invent T3's defaults | §4.5; task T3-6 |
| 8 | T7: attach chips open the Attach tool; post-import panel | Accept* | Not through T6's unfrozen `editorStore`: a frozen `openAttachTool(partId)` (`OpenAttachToolFn`, stub at `ui/shape/openAttachTool.ts`, T6 implements it in T6.3). The post-import panel pre-fills itself (T6 deviation 21), so T7 does not import T6's `yarnSize` helpers | `types/entryPoints.ts`, §5.2.1, §4.2, stub + test; tasks T6-4, T7-4 |
| 9 | §4.2 / §4.5 wording (deviations 14–22) | Accept | | §4.2, §4.5 |
| 10 | `.ui-panel__body[hidden] { display: none }` in `components.css` | Accept | | `ui/common/components.css` (test); task T6-1 |
| 11 | Re-decide `LACE_NOTE` | Accept* | The reviewer is right: lace worked to CYC 1 counts makes smaller stitches, so the toy comes out **smaller**. New text in §4.5 | §4.5; tasks T6-3, T7-5 |

### `t7.md` (T7.2)

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Shared `ColoredMesh` asset codec | Accept* | All three binary assets at once (mesh `CPGM`, SDF volume `CPGS`, photo labels `CPGL`), versioned and strict, with Blob codecs in T7's `MeshCodec` shape | `core/kernel/assetCodecs.ts` (15 tests), §5.5.6; tasks T3-2, T5-3, T6-6, T7-2 |
| 2 | §3.7.5 mm → cm fallback above 60 in; the reason of a plain-inches reading | Accept* | Fallback adopted; a new `UnitsDecision.reason` member `'default'` for both (no evidence), instead of `'spec'` | `types/importer.ts`, §3.7.1, §3.7.5; task T7-3 |
| 3 | §3.7.2 plain `.tar`, single `.gz`; own PLY reader | Accept | Plus streamed, capped inflation (`E_IMPORT_TOO_LARGE`) | §3.7.2 |

### `t8.md` (T8.2)

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 10 | Smoke spec expects "Folder mirror on" | Accept | Done at the T8.2 merge (`abbc381`) | `e2e/smoke.spec.ts` |
| 11 | §5.5.4 wording (deviations 16–23, 34) | Accept | | §5.5.4 |
| 12 | §5.5.5 wording (trash link, start-up ≤ 2 s; also 30) | Accept | | §5.5.5 |
| 13 | A Settings screen for quota, folder, free space | Accept* | v1 has no separate Settings screen: the library's storage panel is the place (as T8 built it); §5.5.2/§5.5.4 reworded | §5.5.2, §5.5.4 |
| 14 | Collect the folder's write-once `assets/` | Reject | Deleting from the user's folder is the riskiest operation the app could do; growth is bounded by what the user added. Backlog | §7.3 |
| 15 | `ProjectGrid` second-line slot | Accept | `meta?(summary)` (null/undefined/false render nothing) | `ui/shell/start/ProjectGrid.tsx`, `shell.css` (3 tests); task T8-1 |
| 16 | Shared HEIF sniffer | Accept* | In `core/kernel/heif.ts` (no imports at all, so Vite's config loader takes it), re-exported by `workers/decode.ts` | `core/kernel/heif.ts` (3 tests); task T8-2 |
| 17 | `scripts/__tests__/` ownership | Accept | | §5.1 |

### Counts

| | Accept | Accept* | Reject | Owner's call |
|---|---|---|---|---|
| Sprint 2 requests of T1–T8 (48) | 35 | 12 | 1 | — |
| Left open by integration-s1 (2) | 1 | 0 | 0 | 1 |
| Integration's own findings (3: T4 → T2 render helpers, T8 → T2 `validateDoc2D`, T7 → T6 `openAttachTool`) | 3 frozen | | | |

Rejected: t8 14 (folder asset GC, to §7.3), and the alternatives named in the reasons (t2 12's `Line.border` field,
t3 2's `error?: Issue` channel, t5 7's "ami.worker fills `frame`", t6 8's direct `editorStore` import).

## Issue codes added in Sprint 2 (now in §2.13)

T1: `W_YARN_LINE_UNKNOWN`, `W_PALETTE_EMPTY`, `W_CSV_ROW`, `W_OVERRIDE_COLORS`, `W_EDITS_INVALID`, `I_EDITS_REMAPPED`.
T3: `E_RECON_EMPTY`, `E_RECON_INVALID`, `E_RECON_SIZE`, `W_RECON_DETACHED`, `W_RECON_GENUS`, `W_RECON_IOU`,
`I_RECON_THIN`. T5 (for T5.3): `W_MESH_PIECES`, `W_MESH_OPEN`. Defined: `W_JOG` (T4). A sweep of every code string in
`src` (outside tests) against §2.13 finds no other unregistered code.

## The shared asset codec (`core/kernel/assetCodecs.ts`, §5.5.6)

| Asset | Mime | Stored at | API |
|---|---|---|---|
| `ColoredMesh` | `application/x-cpg-mesh` (`CPGM` v1) | `threeD.meshAssets[meshRef]` | `encodeMeshAsset`, `decodeMeshAsset`, `meshAssetCodec` |
| `SdfVolume` | `application/x-cpg-sdf` (`CPGS` v1) | `threeD.meshAssets['sdf:' + meshRef]` | `encodeSdfAsset`, `decodeSdfAsset`, `sdfAssetCodec` |
| photo labels | `application/x-cpg-labels` (`CPGL` v1, §2.9.6) | `PhotoView.labelsKey` | `encodeLabelsAsset`, `decodeLabelsAsset`, `labelsAssetCodec` |

Little-endian, deterministic (one asset per content), 16-bit indices up to 65 536 vertices (a 30 k-vertex mesh is
≈ 0.75 MB), strict decoding (`AssetCodecError` with `code` = magic / version / flags / length / range / value — a
newer version asks to update the app), fresh transferable buffers. The `*AssetCodec` objects are
`{ mime, encode(value): Blob, decode(blob): Promise<value> }`, i.e. T7's `MeshCodec`.

## Timing tests: the mechanism (§6.1 rule 5, §5.8)

Problem: wall-clock assertions passed alone and failed in full parallel runs at load 25–40 (`encode.perf`,
`rows.perf`, `voxelize`, `voxelize.adversarial`, `tools.adversarial`, …), plus non-timing waits that counted
macrotasks or used 1 s / 5 s defaults.

- **`src/test/timing.ts` (S0, no vitest import):** `PERF = { tags: ['perf'] }`, `budget(ms)`, `budgetFor(ms, strict)`,
  `bestOf`, `bestOfAsync`, `strictTiming`, `LOOSE_FACTOR` 10, `LOOSE_FLOOR_MS` 250.
- **The tag `perf`** (`vite.config.ts` `test.tags`): retry 2, timeout 180 s; a test's own options win.
- **Every duration assertion** (41 tests in 19 files: encode.perf 3, rows.perf 4, voxelize 2, voxelize.adversarial 1,
  tools.adversarial 1, merge 1, recon/perf 8, kernel/geom/perf 4, taubin.reference 1, model attach 2, proportions 1,
  sdf 1, state history 1, ami review42 1, image2d kind 1, importer carriers 1, g26 1, geometry 3, review 4) is tagged
  and compares with `budget(N)`, N = its previous bound.
- **`npm test`:** `budget(N) = max(10·N, N + 250 ms)` — a sanity bound that still catches a blow-up.
- **`npm run perf`** (`scripts/perf.mjs`): the perf-tagged tests of the files that use `test/timing`, serial
  (`--no-file-parallelism --maxWorkers=1`), `CPG_PERF=1` so `budget(N) = N`; prints the load average and warns above
  0.75 × cores. This is where the §5.8 budgets are checked strictly.
- **Load-robust waits:** T8's `waitFor` fails only after its rounds and 10 s (the `persistence.test.ts` "shows the
  banner…" flake: crypto/Blob work waits on the busy thread pool); Testing Library `asyncUtilTimeout` 10 s
  (`src/test/setup.ts`); Playwright 90 s per test, 15 s per `expect`; `t3-workers` 180 s (the ORT compile);
  `t8-persist` and `t8-library` waits doubled; the t7 OBJ e2e bound through `budget(3000)`. A cross-suite race found
  under load (the `/__convert` test looked at the shared `os.tmpdir()` for leftovers) now uses a private `TMPDIR`.
- **Proof under load:** four `npm test` at once (1-minute load up to 305 on 12 cores): the measured run green; a second
  round (load 91–169): all four green. `npm run perf` on this machine: see Checks.

## Integration checkpoint (§6.5 "after 2")

Cross-track imports of another track's code, after this pass, all go through frozen §5.2.1 entry points: T4 → T2
(`renderLine`, `renderFoundation`, `renderLineExtras`), T5 → T3 and T7 → T3 (`fitPart`). The Sprint 3 calls that would
have crossed unfrozen code are frozen now: T8 → T2 `validateDoc2D`, T7 → T6 `openAttachTool`. T8.3 needs
`renderPatternText` (a stub until now, planned for T2.4): moved to T2.3. T6 → T3: T3 creates `threeD.recon` before the
pre-model panel (§4.5).

## Tasks handed to tracks for Sprint 3

**Every track:** merge `master` first (types changed additively; v1.5). Any new wall-clock assertion uses
`src/test/timing.ts` — `it('…', { ...PERF }, …)` and `expect(ms).toBeLessThan(budget(N))` — never a bare bound; finish
with `npm run perf` once on a quiet machine and report its load line. Binary mesh / SDF / label assets go only through
`core/kernel/assetCodecs.ts`. Never call another track's unfrozen code; ask through "Requests for integration".

### T1 — T1.3 cleanup, metrics, overrides
1. Keep the §2.13 codes as now registered (the six T1.2 codes unchanged).
2. Cleanup (§2.5) runs after `colorize` and keeps protected (salient, override, locked) cells; overrides follow §5.5.5
   as written in v1.5 (identity hex + yarn id, ΔE00 < 2 mapping, `remapEdits`, `I_EDITS_REMAPPED`, `W_EDITS_INVALID`).
3. Performance: flat-art `colorize` on a 2000 × 1500 logo measured 474–551 ms against the 300 ms chart budget (§5.8);
   profile `protectThin` / `poolLabels` and get the 200 × 200 chart (sample → cleanup) under budget; add a perf-tagged
   test with `budget(300)`.
4. Metrics (§2.5): every metric a pure function with a test; nothing reads `Date` or `Math.random`.

### T2 — T2.3 Source / Settings / Chart editor UI, and `renderPatternText` (moved up from T2.4)
1. Implement `renderPatternText(doc, { format: 'txt' | 'md', terms, hand, dialect })` (frozen): every piece's lines as
   written for `doc.hand`, border rounds through `renderBorderLines` with the §2.7.10 hints, block-repeat notes, notes,
   abbreviations, special stitches, materials; G9/G16/G22 texts as goldens. T8.3 prints PDFs through it.
2. Do not re-add the terminology bridge overloads; `abbreviationsFor` / `specialStitchesFor` are `SameSignature` again.
   `validateDoc2D`, `renderFoundation`, `renderLineExtras` are frozen now — keep their signatures.
3. Settings: `referenceLineId` and the default `lineIds` = T1's `DEFAULT_REFERENCE_LINE_ID` (`'red-heart-super-saver'`).
4. Chart editor: hand edits stored as `twoD.edits` by color identity; a size change asks "N hand edits will move to the
   new size: Keep / Discard / Cancel" (§5.5.5) and remaps with T1's `remapEdits` (old edits kept in a snapshot);
   `applyRepeats: 'ask'` offers the block repeat.
5. Carried from integration-s1 (UI parts): the background brush stored as `twoD.backgroundEdits` (s1 T2 task 5), the
   gauge clears on technique / weight change (task 6), the Chart tab's shortcuts through `useShortcutGroup` (task 9).
6. UI per §6.1 quality bar: `src/ui/common` components, screenshots light/dark 1280 × 800, keyboard and contrast.

### T3 — T3.3 labels, back colors, parts, neck split, fit, naming
1. Keep `RECON_ISSUES` as registered; failures stay `ReconError` with the code first in the message.
2. Store every mesh part with `meshAssetCodec` under `threeD.meshAssets[meshRef]`, its SDF volume with
   `sdfAssetCodec` under `'sdf:' + meshRef`, and each view's label image with `labelsAssetCodec` as
   `PhotoView.labelsKey` (§5.5.6); no private formats.
3. Implement the frozen `fitPart` (§2.9.7 step 4) — T5's `fitMeshPart` and T7's geometry path are gated on it.
4. Parts: `inferAttach` → `nameParts` → `inferMirrorPairs`, unique ids; per-part "crochet flat" flags with the parts
   (`I_RECON_THIN` stays one note per build); vertex labels in the target palette's indices (s1 task 6).
5. Back colors (§2.9.6) honor `oneSidedDetail` and `backColors`; neck split per §2.9.7 step 2 with the teddy test.
6. When the Photos tab arrives (T3.4): create `threeD.recon` (with its defaults and `targetHeightIn`) before showing
   `<YarnSizePanel context="pre-model" />` — the panel never creates `ReconSettings`.

### T4 — T4.3 frames, plan, trimming, ovals, cues, lean, assembly
1. `renderFoundation` / `renderLineExtras` are frozen (§5.2.1); keep importing them from `core/pattern/render` only.
2. `W_RUFFLE` on oval rounds: the bound applies to the circular part only; the teddy muzzle's Rnd 3 no longer warns
   (test).
3. §2.10.8 third override: a change round in R8's scope whose default rotation violates R8 takes the smallest extra
   left rotation that satisfies it (fallback: default + `W_STAGGER`); goldens G5–G8 unchanged (test); report the
   `W_STAGGER` count on the 2000 random lathes before and after.
4. `W_JOG` per §2.13 v1.5, also for whole-round color changes in spirals that cannot be jogless (colors are T4.4; add the
   rule where the color cues are placed).
5. Mesh parts: pass `MeshApi.pathB` the part's `crochet.seed` as `seed` and the attachment boundary as `attach`
   (part-local points where the part meets its parent, e.g. the parent's surface samples inside the child); the root
   sends neither.
6. Plan / frames / trimming / cues / lean / assembly per §2.10.1–2.10.6, §2.12 with `E_EYE_ORDER`, `E_ASSEMBLY`,
   `E_OPEN_EDGE`, `W_GAP`, G17, G18, G20; snap safety-eye sizes with `snapSafetyEyeMm` in the plan.
7. Still open from integration-s1 for T4.4: yardage band with `calibrated: gauge.lscCalibrated`, size bands from
   `gauge.tol`.

### T5 — T5.3 DTW, transducer, Path B driver, worker
1. `mesh.worker` `pathB`: use the request's `seed` (nearest vertex) and `attach` (farthest tip from it); neither = the
   root rule (lowest-patch centroid) — §2.10.7 step 1.
2. Results carry `W_MESH_PIECES` (re-mesh kept the largest of several pieces) and `W_MESH_OPEN` (odd parity columns).
3. Read stored parts through `meshAssetCodec` / `sdfAssetCodec` (a reconstructed part's `sdf:<meshRef>` volume is
   reused by merge/voxelize, §2.9.8); every returned mesh stays a copy.
4. Cancellation: `gate.check` between the stages (re-mesh, each t of the heat step, each row) — the 0.4 s factorization
   on a 32 k-vertex part is the longest stretch; measure it with a perf-tagged test against §5.8's ≈ 50 ms where it can
   be split, and document what cannot.
5. From integration-s1: `redoSculpt(undoId)`, `paletteIds` through `merge` and `fromPart`, `stroke.mirrorPlane`.
6. DTW and transducer per §2.10.7 steps 4–7 with `E_CORNER` checked before ops exist.

### T6 — T6.3 paint, regions, rings, ghost, live loop, proportions
1. Delete the local `.ui-panel__body[hidden]` rule in `yarnSize.css` (now in `components.css`).
2. Use `<Icon name="mirror" />` / `<Icon name="link" />` (S0) and delete `MirrorGlyph` / `LinkGlyph`.
3. `LACE_NOTE` = "Lace yarn is sized as CYC 1 (super fine) for toys. Worked in lace yarn, the toy comes out a little
   smaller than shown; measure a test ball for an exact size." (§4.5).
4. Implement `openAttachTool(partId)` in `ui/shape/openAttachTool.ts` (frozen, §5.2.1): select the part, open the Attach
   tool for it (`openAttach`), and show the Shape tab of the open project (`navigate` from `app/router`); replace the
   stub test with real tests.
5. Live loop and ghost (§4.3, §2.10.10): the Yarn & size panel shows the toy ghost height with its band once the loop
   exists (T6.2 shows the model height).
6. Mesh parts: decode `threeD.meshAssets` with `meshAssetCodec` for the viewport and for paint on vertex labels;
   palette edits (merge, delete, reorder) re-index mesh vertex labels (s1 task 4).
7. Proportions panel per §4.2 (kernel `applyProportions`, G23).

### T7 — Sprint 3 = the trial-independent part of T7.4 (owner's decision: the S-CD send-side trial is postponed)
1. **Gated, not this sprint:** T7.3 (Q&A engine, templates, seed source and stacking) and T7.4's prompt, fix-up
   message, send step and Q&A wizard wait for the S-CD trial (`fixtures/claude-design/s-cd/`, §6.5).
2. `acceptImport`: default `meshCodec` to `meshAssetCodec` (`core/kernel/assetCodecs.ts`); keep the parameter for tests;
   accepting an import with mesh parts no longer needs a caller-supplied codec.
3. Units: report `reason: 'default'` for a plain-inches reading and for the mm/cm fallback above 60 in (§3.7.5).
4. **Import tab and import dialog UI:** drop / paste; carrier, dialect and confidence; repair chips — `attach-inferred`
   chips open the Attach tool through `openAttachTool(partId)` (frozen; while it is a stub, check `isImplemented` and
   fall back to opening the Shape tab); the units confirm ("0.25 in tall, or 9.9 in tall?"), re-running with
   `ctx.units`; the versions chip and picker (`ctx.pickCandidate`); the diff view (`diffModels`) with "Carry anyway";
   Accept (`acceptImport`, one undo step), then `<YarnSizePanel context="post-import" onDone>` — the panel pre-fills
   from `model.yarn` itself (T6 deviation 21), so T7 does not import T6's `yarnSize` helpers.
5. The pre-fill's lace note is T6's (`LACE_NOTE`, §4.5 wording); T7 shows nothing of its own for CYC 0.
6. Start → "Import from Claude Design"; with `qa.awaiting` set the import opens at once with "Copy prompt again"
   offered (s1 task 7) — the copy itself waits for prompt-v1, so offer it only when the stored prompt text exists.
7. Return-path matching (§3.7.7): `x-cpg` tag, else ≥ 60% of seed ids → "Import into <project> (where you made the
   prompt)", as far as it needs no prompt-v1 text.
8. e2e for the import UI on the teddy fixtures (archive → chips → accept → panel), screenshots light/dark.

### T8 — T8.3 PDF for 2D
1. Library: pass `ProjectGrid` the new `meta` slot for the " · #abcd" disambiguator instead of appending it to the name
   (keep the accessible names of the card buttons).
2. Folder plugin: import `sniffHeifBrand` from `src/core/kernel/heif.ts` (no imports of its own) and delete the copy and
   its equality test.
3. PDF text through `renderPatternText(doc, { format: 'md', terms, hand, dialect })` (T2.3 implements it this sprint;
   gate the text tests with `it.runIf(isImplemented(renderPatternText))` until merge); chart pages from `doc.chart`;
   materials, gauge and notions from the doc (§2.8); section order §1.3 F8; never format pattern text yourself.
4. Pre-export check: `validateDoc2D(doc, { settings: project.twoD.settings, gauge })` (frozen); any `E_*` disables
   PDF export with the issue shown. It takes 0.5–1.5 s on a large chart (T2 notes): run it once when the export opens,
   with progress, never per render.
5. PDF budget: a 200 × 200 chart pattern < 5 s (§5.8) as a perf-tagged test with `budget(5000)`.
6. No Settings screen in v1: storage, folder path and free-space warnings stay in the library (§5.5.2, §5.5.4).
7. The folder's write-once `assets/` is never collected in v1 (§7.3).

## Checks

(Filled in below after the runs.)

## Not done here

- `npm i -g npm@11.21.0` (s0 request 18) stays the owner's decision.
- The S-CD send-side trial (postponed by the owner); T7.3 and the prompt/send parts of T7.4 wait for it.
