# Roadmap

The living plan for Crochet Pattern Generator. The full specification is [`DESIGN.md`](DESIGN.md); the research
behind it is in [`research/`](research/). This file says what gets built in what order, and where things stand.

**Last updated:** 2026-10-01 · **Now:** Sprint 1 (eight tracks in parallel)

## What "done" means

A local web app where you can:

| # | You asked for | Where it lands |
|---|---|---|
| R1 | Upload an image, pick yarn size and finished size in inches, get a pattern | 2D mode: chart, written rows, materials, yardage |
| R2 | Several photos of an object become a 3D crochet pattern | Photos → 3D model → amigurumi pattern |
| R3 | One photo plus a "3D-ifier" becomes a 3D crochet pattern | Single-photo inflation, optional depth model |
| R4 | Real size math, based on how the major generators work | Gauge tables, non-square stitch cells, swatch calibration |
| R5 | When the 3D result is wrong: answer questions, get a prompt for Claude Design | Q&A wizard → prompt |
| R6 | Bring Claude Design's file back in | Importer for zip, HTML, GLB, OBJ, STL, PLY, JSON, pasted text |
| R7 | A 3D adjustment editor | Shape tab: move, resize, add, merge, sculpt, paint |
| R8 | Colors and patterns in the picture carry into the pattern | Color capture in 2D and on the 3D model |

Quality bar for every sprint: robust, highly functional, user friendly, modern looking.

## How each sprint runs

Every sprint goes through the same loop, and nothing moves on until its step is green:

1. **Document** the sprint's scope here and in the track notes (`docs/tracks/`).
2. **Build** in parallel where the work is independent (each track owns its own folders).
3. **Test**: type check, lint, unit tests; browser tests where there is UI.
4. **Review**: an independent pass over the changes against the spec's acceptance list.
5. **Confirm**: run the real app and look at it (screenshots kept in `e2e/screenshots/`).
6. **Document** what changed (README, track notes, this file).
7. **Commit and push.**

## Sprints

| Sprint | What | Status |
|---|---|---|
| Research | 7 fact-checked research reports, real Claude Design exports captured, design spec v1.2 after two reviews | ✅ done |
| 0a | Toolchain (Node 22), dependencies, config, shared types, base kernels (color, hashing, PNG), stubs for every module | ✅ done (290 tests) |
| 0b | Shared kernels in parallel: geometry (marching cubes, smoothing, distance transforms) · gauge tables and sizing · 3D model schema, builder and attach tree · pattern encoder and validator · app state and worker plumbing | ✅ done (1,758 tests) |
| 0c | Merge, app shell and design system, review, the full Step 0 acceptance list, push | ✅ done (1,834 unit + 15 browser tests) |
| 1 | Eight tracks, first sprint each (see below) | ⏳ in progress |
| 2 | Tracks, second sprint each · then the Claude Design send-side trial (`docs/S-CD.md`), run by you or guided, before Sprint 3 | ◻ |
| Checkpoint | Merge the finished halves to `master`, full test run, shared-type amendments | ◻ |
| 3 | Tracks, third sprint each | ◻ |
| 4 | Tracks, fourth sprint each | ◻ |
| 5 | Integration: wire every flow end to end, browser tests with screenshots, user guide | ◻ |
| Gates | The four release checks below, then tag `v0.1.0` | ◻ |
| 6+ | Backlog (shaped 2D pieces, more techniques, desktop app wrapper, …) | ◻ |

## The eight tracks

| Track | Builds | Sprint 1 | Sprint 2 | Sprint 3 | Sprint 4 |
|---|---|---|---|---|---|
| T1 | 2D image and color pipeline | sampling, image kinds, background | color reduction, palettes, yarn data | cleanup, metrics, overrides | repeat capture, worker, speed |
| T2 | Pattern writing and the 2D workspace | renderers, single-crochet charts, validators | tapestry, C2C, border, yardage | Source / Settings / Chart editor screens | Pattern and Materials views, exports |
| T3 | Photos → 3D | masks, alignment, worker smoke test | hull, inflation, meshing | colors, parts, neck split, naming | depth model, Photos screen |
| T4 | Amigurumi engine | profiles, stitch counts, goldens | increase/decrease placement, text, validators | plan, trimming, ovals, assembly | colors, yardage, round rings |
| T5 | General mesh path and mesh tools | voxelize, sculpt, cut, merge | geodesic rows, seam | stitch matching, worker | (done in 3 sprints) |
| T6 | 3D editor (Shape tab) | viewport, selection, gizmos | add / mirror / attach, Yarn & size panel | paint, regions, live pattern, proportions | sculpt / cut / merge screens |
| T7 | Claude Design round trip | importer: text, JSON, HTML, zip | importer: GLB, OBJ, PLY, STL, units | Q&A engine, templates, seed | prompt, send step, wizard and import screens |
| T8 | Saving, library, PDF | autosave, locks, file format | folder mirror, backups, library screen | PDF for 2D | PDF for 3D, export dialog, print |

## Release gates (need you)

These four checks close before the `v0.1.0` tag. Each needs something only you can supply or approve.

| Gate | What I need | When |
|---|---|---|
| 1. Claude Design regression | Your logged-in claude.ai session (I drive it), for three more objects | Sprint 5 |
| 2. Real photos | Three photo sets shot to [`CAPTURE.md`](CAPTURE.md): a plush toy, a striped or spotted object, a simple round object | Any time before Sprint 5 |
| 3. Yarn data | Nothing from you unless a yarn line's license is unclear; then I ask | Sprint 2 |
| 4. Depth model | Your OK for a one-time 27–50 MB model download | Sprint 4 |

## Decisions already made

See `DESIGN.md` §0.2 for all 23. The ones you would notice:

- Runs entirely in the browser on this Mac. No server, no paid AI calls.
- Stitches are not square. Charts use the real width and height of a stitch for your yarn and hook.
- Every printed line is checked by a stitch-count validator; export is blocked while any line fails.
- Your edits are never overwritten by regeneration. Projects autosave and are mirrored to
  `~/Documents/Crochet Pattern Generator/` with backups.
- Not in v1: Tunisian and filet crochet, shaped (non-rectangular) 2D pieces, generative image-to-3D models.

## Log

- **2026-09-30** Project started. Research workflow launched. Teddy bear made in Claude Design; every export captured as a fixture.
- **2026-10-01** Research verified (7 reports, 718 claims checked, 85 corrections). Design spec v1.2 after two review rounds (74 issues fixed). Roadmap written. Sprint 0 started.
- **2026-10-01** Sprint 0a done: Node 22 toolchain, 251 packages, shared types proven identical to the spec by a script (134 declarations), base kernels, stubs for every module; 290 tests. Spec amended to v1.3 with the type decisions made at the freeze.
- **2026-10-01** Sprint 0b: five kernels built in parallel worktrees (geometry, gauge, 3D model, pattern encoder, state and workers), each independently reviewed from two angles, fixed and confirmed. Two interruptions from usage limits; nothing lost. Four merged to `master` (1,454 tests green); the 3D model kernel has one last limb-resizing fix in progress.
- **2026-10-01** Sprint 0b done: all five kernels merged (1,758 tests green, shared types still identical to the spec). Sprint 0c (app shell and design system) started.
- **2026-10-01** Sprint 0c done: design system (light/dark, 30+ accessible components, 60 icons), start screen, workspace frame with every tab, browser smoke tests with screenshots in `e2e/screenshots/`. Step 0 complete. Sprint 1 started.
- **2026-10-01** Decision: the Claude Design send-side trial waits until just before Sprint 3 (T7's Q&A and prompt). The owner may run it by hand from `docs/S-CD.md`; the app's own instructions will guide users through the same steps.
