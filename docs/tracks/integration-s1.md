# Integration after Sprint 1 (DESIGN.md v1.4)

Branch `integration/s1`, worktree `.claude/worktrees/int-s1`, from `master` at `7f338e8` (Sprint 1 merged).
Every "Requests for integration" item of `docs/tracks/{s0,s0b-*,s0c-shell,t1…t8}.md` is decided below. Rules kept:
only **additive** changes to `src/types` (new optional fields, new union members, new types); spec and types agree
(`node scripts/check-spec-types.mjs`); no track-owned code was changed — where a decision needs one, it is a task in
"Tasks handed to tracks for Sprint 2".

Decisions: **Accept** (applied as asked), **Accept*** (accepted with changes; the reason says which), **Reject**.
"Where" names the spec section, the type file or the S0 file changed, or "—" when nothing had to change.

Commits: `4ed3d19` S0-amend (types + spec type blocks + signature guard), `d471c86` S0-amend (S0 code fixes with
tests), `7e5656c` Design v1.4 (spec prose), `1857829` this file, `5944b6f` S0-amend (the client type keeps optional
API methods; `1857829` alone fails `tsc -b` on `client.test.ts`), then the review fixes (below).

## Decisions

### `s0.md` (Step 0a) — decided in v1.3, re-confirmed

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | `threeD.model` optional | Accept | v1.3 | `types/project.ts`, §5.2 |
| 2 | ArrayBuffer-backed typed arrays | Accept | v1.3 (§0.1 convention) | `src/types`, §0.1 |
| 3 | `ChannelLike` vs `BroadcastChannel` | Accept* | v1.3: kept as written, T8 wrote the adapter | — |
| 4 | Node 20 acceptance wording | Accept | v1.3 | §6.2 |
| 5 | §5.1 extra S0 files | Accept | v1.3; v1.4 adds the 0b/0c files too | §5.1 |
| 6 | §6.2 config additions | Accept | v1.3 | §6.2 |
| 7 | Mirror probe 503 → console error | Accept* | v1.3: 204 + `x-cpg-mirror: off` | §5.5.4 |
| 8 | `latestWins` scope | Accept | v1.3: the five `jobId` methods | §5.4 |
| 9 | Stubs across threads | Accept | v1.3 | §5.2.1 |
| 10 | Stub hooks at module scope | Accept | v1.3 | §5.2.1 |
| 11 | npm 11 install scripts | Accept | v1.3: no change, recorded in DEPENDENCIES.md | — |
| 12 | LGPL optional natives | Accept | v1.3: no change, recorded | — |
| 13 | Where `CODE_VERSION` lives | Accept | v1.3; v1.4 bumped it to 0.2.0 (encoder, test ball) | §5.8, `core/kernel/hash.ts` |
| 14 | Playwright inside Vitest | Accept | v1.3 | §6.1 rule 5 |
| 15 | Embedded-image scan | Accept* | v1.3: rule 9 unchanged | — |
| 16 | `ProjectSummary` badge | Accept | v1.3: `awaitingClaudeDesign?` | `types/project.ts` |
| 17 | `LIMB_TEMPLATE` numbers | Accept | v1.3 | §4.2 |
| 18 | `npm i -g npm@11.21.0` | — | Still the owner's call; nothing needs it | — |

### `s0b-gauge.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | `ResolvedGauge` cannot say the yarn was calibrated | Accept | Workers only see `ResolvedGauge`; ±5% must be reachable there | `types/gauge.ts` `lscCalibrated?`, §5.2, §2.8; `core/gauge/resolve.ts` sets it (test) |
| 2 | Gauge and grid issue codes | Accept | Codes are real, used by T1 too | §2.13 track table |
| 3 | §2.3.3 cap, `snap ≥ m`, no-size | Accept | Real behavior, tested | §2.3.3 |
| 4 | `roundHalfUp` for every count | Accept | Binary ties make tracks disagree by one | §0.1 "Rounding", §2.10.5 |
| 5 | Measurement per technique, sanity extensions, UI clears swatch | Accept | Real behavior; the UI rule prevents misread swatches | §2.2.5, §4.5; tasks T2, T6 |
| 6 | Derive `wSc` from technique swatches | Reject | Unverified whether carried strands change the width; kept as an open question | §7.2 Q9 |
| 7 | Weight change with a fixed hook; CYC 0 for amigurumi | Accept | The §4.5 E2E fails otherwise | §2.2.5, §4.5; tasks T6, T7 |
| 8 | Test ball and unstuffed pieces | Accept | Correct crochet: ears and flat pieces were 5% too wide | `core/gauge/resolve.ts` (`w = C/N / 1.05`, stretch 1.05; tests), §2.2.5, §4.5 |
| 9 | Table E tolerance column | Accept | Research 01 §5.4: worsted ±10%, others ±20% | `core/gauge/tables.ts` (tests), §2.2.3 |
| 10 | `k = max(2, …)` vs `max(1, …)` | Accept* | Both kept, reason written: the reference ball needs k ≥ 2, a 6-st nose bobble needs k = 1 | §2.2.6 |
| 11 | Calibration for hdc and C2C | Accept | Unravel the swatch's own stitch; `lscFromUnravel` converts | §2.8 |
| 12 | `0.2267` → `0.2268` | Accept | Rounding typo | §2.2.4 |
| 13 | `resolveGauge`, `grid` in the signature guard | Accept* | `resolveGauge` frozen (its types already live in `src/types`; T2, T4, T6 call it); `grid` not (its request/`Mult` types would have to move into `src/types`) | `types/entryPoints.ts` `ResolveGaugeFn`, §5.2.1, `__checks__/entryPoints.check.ts` |
| 14 | G11 61.9 yd reading | Accept* | Kept 61.9 yd, reworded as one color of a multi-color chart (59.2 yd as a one-color piece) | §2.8, §2.13 G11 |

### `s0b-geom.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | `SdfVolume` comment (sample points, saturation) | Accept | Three tracks decode it | `types/geometry.ts`, §5.2 |
| 2 | §5.4 loader compiles and retries; `manifoldFromMesh` | Accept | The printed form is a type error; `new Manifold` in `try` leaks | §5.4, §2.9.5 |
| 3 | §2.9.8 step 3: `extendSignedDistance3d`, band definition | Accept | The literal reading fails T5's 1-voxel acceptance | §2.9.8 |
| 4 | §2.9.3 `signedEdt2d` conventions; disc ≥ 25 px | Accept | Real conventions; T3's test disc must be large enough | §2.9.3, §6.3 T3; task T3 |
| 5 | 6-connected outside flood | Accept | Matches the mesher | §2.9.5 |
| 6 | Taubin 2% only for features ≥ 4 voxels | Accept | Measured | §2.9.5 |
| 7 | §5.1 `meshMeasures`, `sdfVolume` | Accept | S0 files | §5.1 |
| 8 | `getManifold` in the signature guard | Accept | Has a `…Fn` type | `__checks__/entryPoints.check.ts` |
| 9 | Measured kernel times | Accept | Recorded beside the research estimates | §2.9.8 |
| 10 | Project-wide vitest timeout | Accept | Heavy tests failed at 5 s on the loaded machine | `vite.config.ts` (`testTimeout`/`hookTimeout` 30 s), §6.1 rule 5 |

### `s0b-model.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Model entry points in the signature guard and runtime test | Accept | Annotated with the frozen `…Fn` types; integration also added `SameProps` checks for `ShapeTab`, `Viewport3D`, `YarnSizePanel` and `PatternTab` (frozen props in `types/ui.ts`) | `__checks__/entryPoints.check.ts`, `test/__tests__/entryPoints.test.ts` |
| 2 | Order `inferAttach → nameParts → inferMirrorPairs` | Accept | `inferMirrorPairs` pairs ids | §2.9.7, §3.7.5, §3.7.6; tasks T3, T7 |
| 3 | Name of a normalized dialect model | Accept | `'Imported model'`; `roundModel` + `stringifyModel` | §3.7.3 |
| 4 | "Record the measured height" = `finishedSize.height` | Accept | | §3.7.6 |
| 5 | Ground center `(0, lowest y, 0)` | Accept | Keeps mirror pairs mirrored | §0.1, §4.2 |
| 6 | `scaleModel` scales `sizeMm`; 0.05 in floor | Accept | | §4.2; task T4 (snap eye sizes) |
| 7 | `c_local` of a torus arc | Accept | | §0.1 |
| 8 | uv64 cell layout | Accept | T3 writes, T4/T6 read | §2.11.1 |
| 9 | Normative builder JS: `pal`/`mats` null-prototype, polygon without points | Accept | `constructor`/`__proto__` are valid palette ids | §3.4.1 (the spec block still matches `buildModel` in `claudeDesign.test.ts`); task T7 |
| 10 | Flat-part bevel vs SDF | Accept | Documented; the SDF keeps ignoring the bevel | §3.4.1, §2.9.8 |
| 11 | `W_GAP` from `data.gapIn` | Accept | `inferAttach` returns repairs, not issues | §3.7.6 |
| 12 | `reanchorChildren` is §4.2's re-anchoring | Accept | | §4.2 |
| 13 | `Repair.code` for a removed bad attach link | Reject | The link is always re-made, so `attach-inferred` (with `data`) says what the user needs | — |
| 14 | Feature-id pattern; importer slugifies feature ids | Accept | `Eye-L` must not fail validation (T7.1 already slugifies) | §3.5.2, §3.7.6 |
| 15 | Stored proximal end `x-cpg-proximal`; T4 uses `limbProximalEnd`; T6 deletes the key | Accept | The SDF rule is path-dependent | §3.5.2, §4.2, §2.10.2; tasks T4, T6 |
| 16 | `mirrorOf` without chains; importer drops a broken one | Accept | | §3.5.2, §3.7.6 (`mirror-removed`); task T7 |
| 17 | Unique ids are a precondition | Accept | | §0.1, §3.7.6; tasks T3, T6 |

### `s0b-pattern.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Raise the exact limit 120 → 500 | Accept* | Raised to **250**: at 500 the p99 was 9–13 ms in a full parallel test run (budget 5 ms); 250 passes with margin and still covers most rounds and chart rows | `core/pattern/encode.ts` (tests), D8, §2.6.1, §5.8; `CODE_VERSION` 0.2.0 |
| 2 | `docKind` for `renderLine` | Accept | A `rnd` is a chart round or an amigurumi round | `types/entryPoints.ts`, §5.2.1, §2.7.2; tasks T2, T4 |
| 3 | G8 `3 inc` vs `inc in next 3 sts` | Accept* | `N op` (`3 inc`) everywhere; G8 text updated | §2.13 G8 |
| 4 | Notes block defines `N op` | Accept | | §2.10.11 |
| 5 | §2.13: what the kernel checks | Accept | | §2.13 intro |
| 6 | `E_FOLD` owner | Accept | The track that folds checks it | §2.13, §2.7.3 |
| 7 | `Item` readonly, results frozen | Accept | | §2.6.1 |
| 8 | Validation vectors; vector 18 with `E_PRODUCE` | Accept | | §2.6.1, G4 |
| 9 | `IssueCode` union in `src/types` | Reject | The registry still grows each sprint; a frozen union would need an amendment per code. §2.13 is the registry, modules keep their own unions | §2.13 intro |
| 10 | Pattern kernel signatures in the guard | Reject | Same reason as gauge 13 (option types would move into `src/types`) | — |
| 11 | Segments concatenated | Accept | Keeps the 7-st side readable (G8) | §2.6.1 |
| 12 | `Op.loop` `'both'` is the default | Accept | | `types/pattern.ts` comment, §5.2 |
| 13 | `Op` amendments need the kernel change | Accept | `isOp` refuses unknown fields | §6.1 rule 7 |
| 14 | Joined-round fallback printed in full; decrease first | Accept | | §2.11.3 |
| 15 | `flo2below` fixes the front loop | Accept | | `types/pattern.ts` comment, §5.2 |

### `s0b-state.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | State entry points in the signature guard | Accept | | `__checks__/entryPoints.check.ts` |
| 2 | One in-flight slot per worker | Accept | Real behavior; the channel-argument alternative rejected (not needed) | §5.4 |
| 3 | `ModelRevision` semantics | Accept | | §3.7.7 |
| 4 | GC follows revision assets | Accept | T8.1 already does (`expandAssetKeys`) | §5.5.5 |
| 5 | Mesh vertex labels on palette changes | Accept* | Flows that keep mesh parts re-index labels; storing labels by color identity rejected (format change) | §2.11.1; tasks T6, T7 |
| 6 | `Feature` marker for editor features | Accept* | No new field: the import filters carried features by its seed and commits with `carry: 'none'` | §3.7.7, §5.5.5; task T7 |
| 7 | Tab ids from `TAB_IDS` | Accept | Already so | §5.3 |
| 8 | `isProjectId` | Accept | T8 uses `crypto.randomUUID()` | — |
| 9 | Asset loader by key | Accept | T8.1 already registers `repo.getAssetByKey` | §5.3 |
| 10 | Conflict copy and asset keys | Accept | Copies share keys; GC is global by reference (T8.1) | §5.5.2, §5.5.5 |
| 11 | Fifth autosave status | Reject | T8 maps `unsaved` → `saving` ("Saving…" is right during the debounce) | §5.5.2 |
| 12 | Synchronous SHA-256 in `core/kernel/hash.ts` | Reject | No second user (T8 uses async `crypto.subtle`); move it when one appears | — |
| 13 | `ChartRequest.sourceId` | Accept | Exact cache key for T1's prepared image | `types/chart.ts`, §5.2; tasks T1, T2 |
| 14 | Canvas premultiplies alpha | Accept | | §2.3.1 |
| 15 | Slices: tracks create their own | Accept | | §5.1 |
| 16 | `/__convert` 501 logs a console error | Accept | Same reason as the mirror probe | `scripts/project-folder.ts` stub (200 JSON + `x-cpg-convert: off`; tests), `decode.test.ts`, §2.3.1, §5.5.4; task T8 |
| 17 | Undo across a conflict copy restores the old name | Accept* | Documented; banners and library tell projects apart by id/`updatedAt` | §5.5.2; task T8 |

### `s0c-shell.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Wire T8 into the shell | Accept | Done by T8.1 (`useAutosave` import starts persistence; `setProjectBackend`, `repo.list`) | — |
| 2 | T8's StartScreen keeps `StartLayout` | Accept | | task T8 |
| 3 | T8 banners through `showProjectBanner` | Accept | Done by T8.1 | — |
| 4 | Wizard offers the copy at once when awaiting | Accept | | task T7 |
| 5 | §5.3 Photos wording | Accept | | §5.3 |
| 6 | Cold-cache check sensitivity | Accept* | Nothing to change; `optimizeDeps.entries` kept | — |
| 7 | Icons belong to the S0 lane | Accept | Tracks use inline SVG in the same style meanwhile | §6.1 rule 7 |

### `t1.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | T1's issue codes | Accept | | §2.13 track table |
| 2 | `CropRect` convention | Accept | | `types/chart.ts` comment, §5.2, §2.3.1 |
| 3 | Brushed background mask | Accept* | Stored as a PNG asset on the brush grid `limitedSize(W, H)` of the uncropped source (`twoD.backgroundEdits: AssetRef`, red 0/1/2) — not pixel lists (a stroke on a 12 MP photo); sent to the worker as `ChartRequest.backgroundEdits` with `key` = the asset's sha256; nearest-neighbour mapping through the inverse crop; a size mismatch is ignored with `W_BG_EDITS_STALE` | `types/project.ts`, `types/chart.ts`, §5.2, §2.3.2, §2.13; tasks T1, T2 |
| 4 | §2.3.4 decisions, relative thin claim, default width | Accept | The absolute 15% loses 1-px lines | §2.3.4 |
| 5 | Noise-free gradients are "flat" | Accept* | Intended (a synthetic gradient is a vector graphic); written down | §2.3.4 |

### `t2.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | `docKind` on `RenderLineFn` | Accept | = s0b-pattern 2 | `types/entryPoints.ts`, §5.2.1; task T2 |
| 2 | What `hand` means for text | Accept | | §2.7.2, `RenderLineFn` comment |
| 3 | G9 bare rows; `· carry A` example | Accept | | §2.7.2, §2.7.3, G9 |
| 4 | `W_ROW_COLORS`; `E_RUN_SUM` covers missing rows | Accept | | §2.7.3, §2.13 |
| 5 | `N op` notes | Accept | = s0b-pattern 4 | §2.10.11 |
| 6 | `E_FOLD` ownership | Accept | = s0b-pattern 6 | §2.13 |
| 7 | `NotesForFn` `rounds?`, `stitch?` | Accept | | `types/entryPoints.ts`, §5.2.1, §2.7.9 |
| 8 | `decMethod` on `abbreviationsFor`/`specialStitchesFor` | Accept | A pattern using sc2tog must not list invdec. The guard checks these two with `PendingSignature` until T2.2 adds the parameter | `types/entryPoints.ts`, §5.2.1, `__checks__/entryPoints.check.ts`; task T2 |
| 9 | Verbose phrases; arrows in verbose | Accept* | Phrases adopted; verbose rows **do** print the reading arrow (research 07 §7.7; direction is the commonest confusion, most of all for left-handers) | §2.7.2; task T2 |
| 10 | Bobbins vs strands | Accept | | §2.7.3, §2.8 |

### `t3.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Recon codes; `Issue.where.view` | Accept | The Photos tab can highlight the photo without parsing | `types/issues.ts`, §5.2, §2.9.1–2.9.2, §2.13; task T3 |
| 2 | §2.9.1 side rule, `keepHoles`, shadow guards, band | Accept | | §2.9.1 |
| 3 | Alignment units | Accept | | `types/geometry.ts` comment, §5.2, §2.9.2 |
| 4 | `GeomApi.mask` `raw?`, `scale?`, `issues?` | Accept | | `types/workers.ts`, §5.2; task T3 |
| 5 | Test-only worker methods | Accept | | §5.4 |
| 6 | "No available adapters." warning | Accept | The start-up probe no longer asks for an adapter; `ensureWebGpuProbed()` on demand; the smoke e2e now fails on that warning | `state/appStore.ts`, `App.tsx` (tests), `e2e/smoke.spec.ts`; task T3 |

### `t4.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Closed-end walk bounded by the ideals | Accept | The literal rule fills waists (snowman) | §2.10.5 |
| 2 | Pole rule on the first half, then mirror | Accept | Symmetry property | §2.10.5 |
| 3 | `closeTail` | Accept | Batched counts closed at 12 on 11% of random lathes | §2.10.5 |
| 4 | Oval MR start 6; widening after a chain oval | Accept | | §2.10.5 |
| 5 | Gauge of the 36-st tail example | Accept | Firm 30", light 28" | §2.10.6 |
| 6 | At most one dropped round | Accept | The literal loop deleted straight tips | §2.10.5 |
| 7 | `batchCounts` p0 = chain count | Accept | | §2.10.5 |
| 8 | No BLO on round 1 | Accept | | §2.10.5 |
| 9 | `crochet.axis` on revolved types | Accept* | Documented (ignored); no warning | §2.10.2, §3.5.2 |

### `t5.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | `paletteIds` on `merge`/`fromPart` | Accept | Labels are palette indices | `types/workers.ts`, §5.2, §2.9.8; client forwards `fromPart` options; tasks T5, T6 |
| 2 | `merge` result `position?` | Accept* | A sentence instead of a field (model space; `recenterMesh` gives the form) | `MeshApi.merge` comment, §2.9.8 |
| 3 | `redoSculpt?` | Accept | ⇧⌘Z | `types/workers.ts`, §5.2, `workers/client.ts` (test); tasks T5, T6 |
| 4 | §2.9.8 text (flatten plane, k-d tree, bridges, linear undo, convert fallback) | Accept | | §2.9.8 |
| 5 | `mirrorPlane` on the stroke | Accept | | `types/workers.ts`, §5.2, §2.9.8; tasks T5, T6 |
| 6 | Flat bevel vs `partVolume` | Accept* | Documented; the SDF keeps ignoring the bevel | §2.9.8, §3.4.1 |

### `t6.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Tabs add rows to the "?" dialog | Accept | | `ui/shell/shortcuts.ts` (`registerShortcutGroup`, `useShortcutGroup`), `ShortcutsDialog.tsx` (tests), §5.1; task T6 |
| 2 | Screenshots in `e2e/screenshots/t6-*` | Accept | Fine where they are | — |
| 3 | `THREE.Clock` deprecation warning | Accept* | Upstream (R3F 9.8.1); a warning, nothing to change | — |
| 4 | Shape chunks over 500 kB | Accept* | Lazy chunks; the warning stays visible on purpose | — |
| 5 | §4.2: resize pivot, Scale snap, follow toggle | Accept | | §4.2 |

### `t7.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | `Repair.code` `type-aliased`, `mirror-removed`, `part-added` | Accept | The fourth case (an unknown region kind removed) stays `unknown-key`, as T7 does | `types/importer.ts`, §3.7.1, §3.7.6; task T7 |
| 2 | Importer codes in §2.13 | Accept* | Listed; the prefix must be the severity, so T7 renames three info `W_` codes and the warn/info uses of `E_IMPORT_PARSE` | §2.13; task T7 |
| 3 | `dialect` on failures | Accept* | A `'none'` member (making the field optional would break readers) | `types/importer.ts`, §3.7.1; task T7 |
| 4 | §3.7.3 readings | Accept | | §3.7.3 |
| 5 | §3.7.2 zip reader | Accept | | §3.7.2 |
| 6 | §3.7.6 additions, capsule rule | Accept | | §3.7.3, §3.7.6 |

### `t8.md`

| # | Request (short) | Decision | Reason | Where |
|---|---|---|---|---|
| 1 | Smoke e2e expects "Saved" | Accept | Done in `a978da6` | `e2e/smoke.spec.ts` |
| 2 | `ProjectName` keeps stale text while focused | Accept | A conflict copy was renamed back on blur | `ui/shell/ProjectName.tsx`, `__tests__/projectName.test.tsx` |
| 3 | Leave before open; toast on failure | Accept | Never take the next lock while the current project cannot be left. Consequence: a stale link to a missing project now closes the open one (its changes kept by the backend) before showing "This project isn't here" | `ui/shell/projectSession.ts`, `Workspace.tsx` (tests in `projectSession.test.ts`, `app.test.tsx`) |
| 4 | §5.5.2 take over, hand-over, reopening | Accept | | §5.5.2 |
| 5 | `sync:<id>` meta entries | Accept | | §5.5.4; task T8 |
| 6 | Read-only tabs do not follow saves | Accept* | Kept for v1, documented | §5.5.2 |
| 7 | GC vs long-lived tabs | Accept* | No grace list: GC runs at start-up before this tab opens a project and skips the round while another tab holds a `project:` lock (deferral only costs disk) | §5.5.5; task T8 |
| 8 | Orphan / forged release requests | Accept* | Acceptable for one user's tabs; documented | §5.5.2 |
| 9 | Delete removes snapshots | Accept* | Confirm + "Recently deleted" (30 days) in T8.2, stored as a `meta` entry `trash:<id>` (no type change) | §5.5.5; task T8 |

### Counts

| | Accept | Accept* | Reject | Owner's call |
|---|---|---|---|---|
| Step 0b/0c and T1–T8 (136 requests) | 107 | 23 | 6 | — |
| `s0.md` (18, decided in v1.3, re-confirmed) | 14 | 3 | 0 | 1 |

Rejected: gauge 6, model 13, pattern 9 and 10, state 11 and 12, and the alternatives named in the reasons
(state 2's channel argument, state 5's color-identity labels, state 6's `Feature` field, t5 2's `position` field).

## Issue codes invented in Sprint 1 (now in §2.13)

`E_GAUGE_INPUT`, `W_GAUGE_{RANGE,ASPECT,ROWS,HOOK,CARRIED,LSC}`, `W_GRID_{NO_ROOM,CAPPED,LARGE,PROPORTIONS,ASPECT}`
(S0 gauge); `W_BG_{NOT_FOUND,SUBJECT_SMALL,SUBJECT_LARGE}`, `I_BG_TRANSPARENT` (and `W_BG_EDITS_STALE`, new for T1 Sprint 2), `W_PIXEL_{SIZE,MULTIPLE,UNAVAILABLE}`,
`I_PIXEL_ASPECT`, `I_SIZE_DEFAULT` (T1); `E_MASK_EMPTY`, `W_MASK_{BORDER,COVERAGE}`, `E_VIEWS`,
`W_VIEW_{EMPTY,SCALE,DUPLICATE,IOU}` (T3); `E_IMPORT_{NO_MODEL,PARSE,INVALID,UNSAFE,TOO_LARGE,ARCHIVE,UNSUPPORTED,
PROJECT_FILE}`, `W_IMPORT_{TYPE,DEFAULTED,CANDIDATE,PARSE}`, `W_ARCHIVE_ENTRY`, `I_{MIN_FEATURE,FORMAT_DRIFT,
HTML_ENTITY,IMPORT_PARSE}` (T7; the `I_` names and `W_IMPORT_PARSE` are Sprint 2 renames).

## Tasks handed to tracks for Sprint 2

Merge `master` first: the types above changed (additively), `CODE_VERSION` is 0.2.0, the encoder's exact limit is
250 tokens, the test-ball gauge now has stretch 1.05, Table E tolerances are 0.10 / 0.20, and vitest's default
timeout is 30 s.

### T1
1. Cache the prepared image (`prepareWork`) by `ChartRequest.sourceId` when it is set (`prepareKey(sourceId, req)`),
   falling back to the content fingerprint; the chart2d worker caches the decoded `RgbaImage` by it too.
2. Apply `ChartRequest.backgroundEdits` in `resolveBackground` (§2.3.2): values 0/1/2 on the brush grid
   `limitedSize(W, H)` of the **uncropped** decoded source; each working pixel reads the brush cell under its center
   through the inverse flip, rotation and crop (nearest neighbour); a brush of another size is ignored with
   `W_BG_EDITS_STALE` (warn); brushed pixels win over the flood fill and are applied before the subject guard; only
   with `background: 'remove'`. Cache identity = `backgroundEdits.key` (hash `data` when absent). Tests: a brushed
   hole stays, a brushed subject pixel next to the border stays subject, a rotated crop maps the brush correctly, the
   cache key changes with the edits, a stale brush warns.
3. Keep the §2.13 codes exactly as listed (`I_` for info).
4. Counts with `roundHalfUp` (§0.1): `core/image2d/sample.ts` (`m = Math.round(want.cols / nx)`, the pixel
   multiple) and any other count.

### T2
1. `abbreviationsFor(lines, terms, decMethod?)` and `specialStitchesFor(lines, terms, decMethod?)`: list only the
   decrease the pattern uses (`decMethod` = `AmiSettings.decMethod`; absent = today's behavior). Integration then
   turns their two `PendingSignature` checks back into `SameSignature`.
2. `renderLine`: when `o.docKind` is given use it instead of `inferDocKind`; `renderPatternText` and `PatternView`
   pass `doc.kind`. Test: a tapestry round and an amigurumi round with the same ops print differently by `docKind`.
3. `notesFor`: test that `ctx.rounds` and `ctx.stitch` (now in the frozen ctx) reach the text (drift sentence, "1 hdc /
   Ch 2").
4. Verbose rows print the reading arrow after the side tag, like compact (`Row 11 (RS) ←: …`); regenerate and
   re-check `golden/flatGraph.txt` by hand against §2.7.2.
5. Source tab: the background brush stores `twoD.backgroundEdits` (an `encodePng` PNG, red 0/1/2, on the brush grid
   `limitedSize(W, H)` of the uncropped source — import it from T1's `core/image2d/linear.ts`, do not re-derive it)
   through `putAsset`, and `Chart2dApi.run` gets the decoded red channel as `ChartRequest.backgroundEdits` with
   `key` = the asset's sha256; pass `sourceId` = the source's `asset.sha256`.
6. 2D gauge settings: clear or swap the measurement when the technique changes (each family reads its own field),
   and clear `hookMm` and the measurements when the yarn weight changes (§2.2.5).
6a. Counts with `roundHalfUp` (§0.1): `core/pattern/notes.ts` (the drift `shift` in stitches) and any other count.
7. 2D yardage: band from `yardageBand({ technique, source: gauge.source, calibrated: gauge.lscCalibrated })`;
   Materials lists bobbins from `bobbinsPerColor`, tails from `strandsPerColor`; G11 test reads 61.9 yd as one color
   of a multi-color chart.
8. Check `E_FOLD` when tapestry rounds are folded (T2.3).
9. If a 2D tab has keyboard shortcuts, list them with `useShortcutGroup` (shell barrel).

### T3
1. `geom.worker` `mask()` returns the new optional `raw`, `scale` and `issues`; every mask and alignment issue carries
   `where.view = PhotoView.id` (the message may still name the photo).
2. Parts (T3.2): `inferAttach` → `nameParts` → `inferMirrorPairs` (§2.9.7 step 5); never produce a repeated id.
3. Hull tables with `signedEdt2d(…, { measureTo: 'boundary' })`, inflation with `'samples'`; the "hemisphere for a
   disc" test uses a radius ≥ 25 px.
4. Build solids with `manifoldFromMesh` / `manifoldReport`, never `new Manifold(mesh)` in a `try`.
5. Depth option: call `ensureWebGpuProbed()` (`state/appStore.ts`) — or `ml.status()` — where the answer is needed;
   nothing probes WebGPU at start-up any more.
6. Apply photo colors: return mesh vertex labels in the target palette's indices.

### T4
1. Start pole of limbs from `limbProximalEnd` (`core/model/proportions.ts`), so it agrees with the Proportions edit
   (§2.10.2).
2. Render rounds and flat pieces with `renderLine(line, { …, docKind: '3d' })`.
3. Check `E_FOLD` on folded amigurumi rounds; do not repeat the kernel's single-line `E_START`/`E_FOUNDATION`
   findings.
4. 3D yardage band with `calibrated: gauge.lscCalibrated`; size bands from `gauge.tol` (now Table E's 0.10 / 0.20).
5. Do not assume a test-ball gauge has stretch 1: always `stuffedCell(gauge, stuffing)` (light/none pieces now get
   the narrower `C/N / 1.05`).
6. Snap safety-eye `sizeMm` to sizes that exist (after `scaleModel` an 18 mm eye can become 36 mm).

### T5
1. `mesh.worker` (T5.3): expose `redoSculpt(undoId)`; pass `o.paletteIds` through `merge` and `fromPart`
   (`fromPart(part, o?)`); honor `stroke.mirrorPlane`.
2. Keep returning copies (callers may transfer them).

### T6
1. List Q / W / E / R / F / Esc / ⌥ / ⇧ with `useShortcutGroup({ id: 'shape', title: 'Shape tab', rows })` (shell
   barrel) so the "?" dialog shows them; the inspector list may stay.
2. Delete `x-cpg-proximal` when a limb is re-parented or a Rotate turns it end for end; the Attach tool's open-end
   choice wins over the key.
3. Merge / convert: pass `paletteIds` (the model palette's ids) to `merge` and `fromPart`; place the merged part with
   `recenterMesh`; ⇧⌘Z on a sculpt step calls `redoSculpt`; off-center or rotated mesh parts send `mirrorPlane`.
4. Palette edits (merge, delete, reorder) re-index mesh vertex labels of mesh parts.
5. Yarn & size panel (T6.2/T6.4): changing CYC clears `hookMm` and the measurements; a model `weightCYC: 0` is offered
   as CYC 1 with a visible note ("Lace weight is sized as CYC 1 for toys; the toy may come out larger than the label
   suggests"); the test-ball field explains "stuffed firmly".
6. Duplicate / Add part / Mirror never create a repeated id.

### T7
1. Repairs: `type-aliased` for an unknown type replaced (keep `W_IMPORT_TYPE`), `mirror-removed` for a broken
   `mirrorOf` (instead of `mirror-inferred` with `data.removedMirrorOf`), `part-added` for a synthesized `*_r` twin.
2. Failures report `dialect: 'none'`.
3. Rename `W_MIN_FEATURE` → `I_MIN_FEATURE`, `W_FORMAT_DRIFT` → `I_FORMAT_DRIFT`, `W_HTML_ENTITY` → `I_HTML_ENTITY`;
   `E_IMPORT_PARSE` used at warn → `W_IMPORT_PARSE`, at info → `I_IMPORT_PARSE` (one code, one severity).
4. `builderSource` (T7.3) embeds the v1.4 §3.4.1 builder (null-prototype `pal`/`mats`; a polygon without points draws
   as a rectangle).
5. Accept an import: `carryOverWith(prev, next)` yourself, drop carried features whose ids were in the seed sent
   (`qa.seed.features`), then `commitModelRevision(…, { carry: 'none' })`; re-index mesh vertex labels when mesh parts
   are kept and the palette changed.
6. Pre-fill from `model.yarn`: `weightCYC: 0` → CYC 1, with the note of T6 task 5 (not silent).
7. Wizard: when `qa.awaiting` is set, open at the import step with "Copy prompt again" offered at once (s0c request 4).
8. Geometry-only path: `inferAttach` → `nameParts` → `inferMirrorPairs`.

### T8
1. T8.2 StartScreen keeps `StartLayout` (the five cards create projects through the shell) and passes `ProjectGrid`
   with `renderActions`/`thumbnailUrl` and the restore button.
2. Library delete: confirm, then a "Recently deleted" list kept 30 days (restore / delete forever), since
   `remove(id)` takes the snapshots with it: keep the document in `projects` with a `meta` entry `trash:<id>`
   (`{ deletedAt }`), leave it out of `list()`, purge with `remove` after 30 days (§5.5.5).
3. Asset GC: run at start-up after the journal replay and before this tab opens a project; skip the round when
   another tab holds a `project:` lock (`navigator.locks.query()` filtered to that prefix; the in-tab lock manager
   answers for itself).
4. Folder-mirror plugin: off macOS, `POST /__convert` answers 200 + `x-cpg-convert: off` + JSON
   `{ "converted": false, "reason": "no-converter" }` (as the stub now does), other methods 405; write `sync:<id>`
   meta entries.
5. Banners and the library tell projects apart by id and `updatedAt`, never by name (conflict-copy undo).
6. The shell now leaves the current project before opening the next: the backend's "release the other held ids"
   path in `leave` should no longer trigger; keep it as a guard, and add a test that opening B while A cannot be left
   takes no lock on B.

## Review fixes

An independent reviewer checked completeness (every request has a row), spec/type/code agreement and that every
`src/types` change is additive; all three held. Fixed from its findings: the brush grid and its mapping are now
defined (`limitedSize`, nearest neighbour, `W_BG_EDITS_STALE`, `backgroundEdits.key`); `resolveGauge` frozen
(gauge 13 now Accept*); `PendingSignature` pins the old parameter list (it accepted a dropped or widened
parameter); roundHalfUp tasks for T1/T2; weight change in T2's gauge task; trash storage and the GC schedule decided;
the §2.3.3 code block uses `round`; stale comments in `encode.ts` and `round.ts`; §5.3 says WebGPU stays `null`
until probed; `ProjectName` shows the trimmed name after a commit; shortcut rows keyed by index; the CYC 0 → 1
mapping shows a note. Kept: the smoke spec's adapter-warning check (it covers only `smoke.spec.ts`, which never opens
the depth option).

## Not done here

- `npm i -g npm@11.21.0` (s0 request 18) stays the owner's decision.
- At the Sprint 2 integration: restore `SameSignature` for `abbreviationsFor` / `specialStitchesFor` once T2.2 lands.
