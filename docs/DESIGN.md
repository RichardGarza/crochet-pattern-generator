# Crochet Pattern Generator — Design Specification

Status: build-ready, v1.2 (2026-10-01), revised after two design reviews (see §8 Revision log). This is the single
specification the implementation agents follow. During the parallel tracks this file is owned by the integration
agent; tracks propose changes under "Requests for integration" in `docs/tracks/tN.md` (§6.1 rule 8).
It condenses `docs/research/01`–`08` (all fact-checked). Where research documents disagree, this document
records the decision and the reason; agents MUST NOT re-open those decisions without updating this file.
`docs/research/08-claude-design-verified-fixtures.md` (observed output) overrides `05` (desk research).

## 0. How to read this document

- **MUST / SHOULD / MAY** have their RFC meanings. "v1" = the first shipped build; "v1.1" = next.
- Every algorithm names its source research section in brackets, e.g. `[01 §5.1]`.
- Section numbers are referenced by the build plan (§6). Tracks own files, never sections.
- Code blocks are normative unless marked "sketch".

### 0.1 Conventions (apply everywhere)

| Topic | Convention |
|---|---|
| Length unit | Inches internally (`number`). UI shows in or cm (1 in = 2.54 cm). Gauge given "per 4 in" (= 10.16 cm). |
| Stitch cell | `w` = width of one stitch, `h` = height of one row/round, both inches. Aspect quoted as `w/h`. |
| 3D axes | Right-handed, **+Y up**, object's **front faces +Z**, object's **own left is +X**, lowest point at y = 0 [05 §4.1, 08]. |
| Part position | `position` is the part's **local origin** in absolute model space: the center for every part type except `lathe`, whose origin is the axis point at profile y = 0 (its base). A part's **center** is its local bbox center mapped to world, `position + R·c_local` (`c_local = 0` except lathe `(0, (y_min + y_max)/2, 0)`). Extents always come from the builder geometry, never from `position` alone (§3.4.1). |
| Rotations | `rotationDeg` = Euler XYZ in degrees, three.js order `'XYZ'` (matrix = Rx·Ry·Rz). |
| Colors | Stored as sRGB hex `#rrggbb`. Math in linear sRGB / OKLab. glTF/MTL colors are linear and MUST be converted. |
| Terms | US crochet terms in the model; UK rendered only through a terminology table [07 §1.3]. |
| Handedness | Right-handed (RH) default; left-handed (LH) mirrors reading order, never the chart [07 §3.3]. |
| Working direction in the round | RH = negative rotation about the crochet axis (start pole → end), i.e. clockwise seen from above the opening; equivalently tangent `t = n × ∇f` on a surface with outward normal `n` and row function `f`. LH = opposite. |
| Round marker | Start of every round at **center back** (azimuth facing −Z; −Y if the axis is horizontal) on the piece's reference round; other rounds' seams follow the measured spiral lean (`leanStPerRnd`, §2.11.2). Stitch numbers count from the marker in the working direction, 1-based; the front center of an n-st round is the gap between st n/2 and st n/2 + 1 (n even) or st ⌊n/2⌋ + 1 (n odd) (§2.12). |
| Determinism | Same input bytes + same settings + same code version ⇒ byte-identical outputs. No `Math.random()` in `src/core`. |
| Network | None at runtime, except user-initiated downloads of permissively licensed ML weights (§2.9.4). No paid or AI APIs, ever. |

### 0.2 Decision summary (one approach per problem)

| # | Problem | Decision | Why (alternatives rejected) |
|---|---|---|---|
| D1 | Stack | Same libraries as `~/projects/room-planner`: Vite 8, React 19, TS 6, three 0.186, R3F 9, drei 10, zustand 5, vitest 4, oxlint, jspdf 4 + svg2pdf.js — on **Node 22 LTS (≥ 22.12)**, lockfile written by **npm 11.21** (`packageManager`, `devEngines`, §6.2 item 0) | Vite 8, rolldown, plugin-react 6 and oxlint 1.86 require Node `^20.19 \|\| >=22.12`; on the default Node 20.18 npm silently skips their native bindings and `oxlint` crashes. Node 22.23.3 is already installed here via nvm, but its npm 10.9.9 crashes on a fresh install of this dependency set (`Cannot read properties of null (reading 'edgesOut')`, reproduced 2026-10-01); npm 11.21.0 installs it, and npm 10.9.9 `npm ci` from that lockfile works. Playwright Chromium 1243 is installed. TS 7 / vitest 5 not adopted. |
| D2 | 2D stitch cells | True non-square cells from gauge tables; rows and columns sized **independently** [01 §4] | Square cells shrink sc designs ~15% [01 §2.3]. |
| D3 | 2D techniques v1 | sc graphgan (flat), sc tapestry (flat), sc tapestry in the round, C2C (dc tiles); hdc graphgan P1; overlay mosaic P1 behind a flag; optional sc border for flat pieces (§2.7.10). Every row spans the full chart width (no "no stitch" shaped pieces in v1) | Coverage of what users make, all writable exactly (§2.7). Shaped pieces need edge-shaping writers that no researched generator specifies (v1.1, §7.3). Tunisian, filet: non-goals. |
| D4 | Color space | OKLab features `(toe(L), 2a, 2b)` (= ΔEOKr2) for clustering/cleanup; CIEDE2000 for yarn matching and user-facing ΔE [06 §1.3] | Best agreement with ΔE00 at clustering speed. |
| D5 | Quantizer | Deterministic Wu-style variance split + weighted Lloyd; auto-K by knee; salience guard [06 §2.3] | Seeded, reproducible; beats random k-means init. |
| D6 | Yarn palette | p-median BUILD/SWAP over the chosen yarn line or stash [06 §7.4] | Avoids frequency-greedy loss of eyes and snap-collisions. |
| D7 | Cleanup | Protect → confetti → small components → Potts DP along the working path → per-row cap [06 §6.3] | Measured −23…−39% color changes per row. Dither off by default. |
| D8 | Repeats | One shortest-encoding DP (`encodeOps`) for 2D rows and 3D rounds up to 120 tokens; a linear run/period fallback above that [07 §7.4] | Subsumes AmiGo loop folding; one renderer for both modes. The exact DP is O(n³)–O(n⁴) (measured 1.15 s at 240 tokens), so long lines use the fallback (§2.6.1). |
| D9 | Yardage | Per-stitch model `L_sc = 6.5·w_sc` with stitch multipliers, carried strands, tails, buffer [01 §6]; amigurumi uses the same sc model at the amigurumi hook; skeins are bought for the high end of the band | Fitted to measured per-stitch data; area rules over-estimate; running short means a dye-lot mismatch. |
| D10 | Canonical 3D | `crochet-model` v1.0 JSON (parts list) is the app-wide 3D model; parts are primitives or `mesh` parts [05 §3] | One model for R2, R3, R5, R6, R7; Claude Design only refines it. |
| D11 | Reconstruction workspace | Signed-distance volume N³ (positive inside); one mesher (MC → Taubin → validate) [04 §2] | One watertight code path for carving, inflation, import repair, sculpting. |
| D12 | Multi-view | Separable visual hull from per-view signed EDT, rounded by **front-view** inflation only [04 §4.5] | IoU 0.84 → 0.92; side/top rounding collapses (0.37). |
| D13 | Single image | Local-thickness inflation (κ = 0.9) + optional Depth Anything V2 Small relief, built in the photo's frame and turned to the view the user names (front / left / right / top); offline fallback = inflation only [04 §5] | Instant, offline; depth adds relief, never required; animals and vehicles are usually photographed from the side. |
| D14 | Background removal | Classical border model + brush (always); optional SlimSAM click-segment via transformers.js. Never AGPL or non-commercial weights [04 §3] | Zero-download baseline; licenses stay clean. |
| D15 | 3D → pattern | Path A (primitive profiles → counts → staggered placement) for primitives and fitted meshes; Path B (heat geodesics + constrained DTW) for non-axisymmetric mesh parts [03 §6] | Path A gives readable, classic patterns; Path B covers the rest. |
| D16 | Shaping layout | Counts from geometry; placement by grouped + alternating-rotation stagger [07 §6.6] | Matches published style; machine-checked examples. |
| D17 | Amigurumi gauge | Table E widths, `w/h = 1.05` (yarn over) or 1.11 (yarn under), stuffing stretch `s = 1.05` applied isotropically [01 §3.7, §5] | Calibrated to PlanetJune sizes. |
| D18 | Claude Design round trip | Send: one pasted text prompt (seed embedded, tagged with `x-cpg`) plus photos as the only attachments; the project then **waits for its result** (banner, Import entry) and a returning file lands in that project. Return: copy-paste and file drop only; importer accepts our canonical spec **and** the observed Claude Design dialect [08]; HTML is parsed by a worker-safe tokenizer (no DOM); a page without our JSON gets a one-click **fix-up message**. The send side is verified by the **S-CD spike** in sprint 1, before T7 builds the Q&A and prompt (§6.5) | Share links cannot be fetched [05 §1, 08]. Images are a documented Design input; `.txt`/`.json` uploads are not verified (§3.1). `DOMParser` does not exist in dedicated workers. A release-time-only check would rework T7 at the end. |
| D19 | Persistence | IndexedDB autosave with a revision check and one writer per project (a conflicting tab continues in its copy; a hung writer can be taken over) + `.crochet.json` export/import + dev/preview folder mirror with change-only backups that share one content-addressed asset store; authored edits never overwritten by regeneration | User standing rule: never lose data; this Mac has 34 GiB free and `~/Documents` syncs to iCloud, so whole-folder copies are not affordable. |
| D20 | Cross-origin isolation | Not enabled in v1 (no COOP/COEP) | Avoids breaking the sandbox runner and image loads; depth runs on WebGPU or 1-thread WASM (≈2.5 s). |
| D21 | Attach tree | Every model, from every source (Claude Design dialect, GLB/OBJ/PLY/STL, photo reconstruction, editor), is normalized to **one attach tree** by one shared kernel (`inferAttach`, §3.7.6) | The only real Claude Design output leaves 7 of 17 parts without a parent; trimming, start poles and assembly all need the tree. |
| D22 | Worker RPC | comlink with a **latest-wins** channel per worker API (one job in flight, one pending; older pending requests rejected as `Superseded`), cooperative cancellation at stage boundaries, `Comlink.proxy` for callbacks and `Comlink.transfer` for request-owned buffers; Path B runs in a private `mesh.worker` owned by `ami.worker` (§5.4) | Without SharedArrayBuffer (D20) a running job cannot see a newer request unless it yields; every slider tick would otherwise queue a full job. Callbacks cannot be structured-cloned. |
| D23 | Image intake | Browser decode in the worker adapter; HEIC/HEIF converted by the dev/preview server (`POST /__convert`, macOS `sips`); `src/core` takes decoded `RgbaImage`s and has its own PNG codec (§2.3.1) | iPhone photos are HEIC and Chrome cannot decode HEIC; node tests have no `createImageBitmap`/`OffscreenCanvas`. |

---

## 1. Product overview and user flows

### 1.1 What the app is

A local web app that turns pictures, photos and 3D models into complete, correct crochet patterns:

- **2D mode (R1):** one image → a colorwork chart (graphgan, tapestry, C2C) with written rows, materials and
  yardage per color, sized to a finished size in inches for a chosen yarn weight and hook.
- **3D mode (R2, R3, R5–R7):** photos (several, or one) or a Claude Design model → an editable 3D parts model →
  an amigurumi pattern: pieces, rounds with increases/decreases, colors, stuffing, assembly.
- **Colors and patterns (R8)** captured from the image carry into both modes: stripes, spots, motifs, eyes.
- Everything runs client-side. Patterns are produced by deterministic algorithms and validated before export.

### 1.2 Principles

1. **Correct before pretty.** Every printed line passes stitch-count validation (§2.13); exports are blocked on errors.
2. **Physical truth.** Sizes come from gauge math with visible uncertainty; a measured swatch overrides defaults.
3. **Authored vs derived.** User edits (chart cells, part shapes, paint, answers) are authored data. Charts, rounds,
   text and yardage are derived and recomputed; regeneration never discards authored data (§5.5.5).
4. **Workers for heavy work;** the main thread renders only.
5. **Explain, don't hide.** Workability metrics, ΔE of yarn matches, validator badges and "why" chips are always visible.

### 1.3 Flows

Each flow lists the steps, the module that does the work, and the requirement it serves.

#### F1 — 2D: image → chart → written pattern (R1, R4, R8)

1. Start screen → **New pattern from a picture** → drop/choose an image (jpg, png, webp, gif first frame; an iPhone
   HEIC/HEIF is converted to JPEG by the dev/preview server, §2.3.1).
2. **Source tab:** auto EXIF orientation; crop (free or locked to the finished aspect), rotate 90°, flip;
   background: keep the image as is (default) or "plain background → one yarn" (§2.3.2). Every row is worked
   across the full chart width; shaped "no stitch" pieces are v1.1 (§7.3).
3. **Settings panel:** technique (§2.7), yarn weight CYC 0–7 (default 4), hook (default from Table A),
   finished width and/or height in inches with aspect lock (sizes include the border), optional border (width,
   0 = none, and color, default A; flat techniques only, §2.7.10), colors (auto or max K),
   palette source (auto / a yarn line / my stash / custom CSV), detail preset (Max detail / Balanced / Easy),
   handedness, C2C start corner, optional "I have a swatch" (§2.2.5).
4. Chart is computed in `chart2d.worker` on every settings change (debounced 250 ms, latest-wins, §5.4): sizing (§2.3.3),
   sampling (§2.3.4), quantization and yarn matching (§2.4), cleanup (§2.5), pattern capture (§2.6).
   The UI shows photo | chart side by side with true-aspect cells and live metrics (confetti %, color changes
   per row, bobbins/strands, fidelity ΔE, workability 0–100).
5. **Chart tab (editor):** paint, flood fill, replace color, eyedropper, lock brush (protects from cleanup),
   merge colors, recolor to a yarn. Edits are authored overrides (§5.5.5).
6. **Pattern tab:** written instructions for the technique (§2.7) in Compact or Verbose, US or UK terms, RH or LH,
   then the border rounds when a border is set (their opening follows the side and corner where the last row ends,
   §2.7.10); repeats compressed (§2.6); stitch-count validator badge.
7. **Materials tab:** per color: yarn name/number, ΔE00 match, stitches, yards (range, border yarn included), skeins
   (enough for the high end of the range, §2.8), grams; hook, gauge, finished size with uncertainty band, notions
   (bobbins count for intarsia/C2C).
8. **Export:** PDF (F8), 1-px-per-stitch PNG, CSV, chart JSON, plain-text/Markdown pattern.

#### F2 — 3D from several photos (R2, R4, R8)

1. Start → **New 3D toy from photos** → add 2–6 photos (HEIC converted as in F1; the capture tips of §2.9.2 are shown).
2. **Label views:** each photo gets front / back / left / right / top / bottom via a turntable icon
   (left = photo of the object's own left side, camera at +X) [04 §4.2]. Minimum for shape: front + one side;
   top recommended; back and the other side improve colors and repair masks.
3. **Masks:** classical mask computed instantly (§2.9.1) with overlay; brush +/−; optional "click the object"
   (SlimSAM, one-time ≈14 MB download). Warnings: object touching the border, mask < 15% or > 90% of the image.
4. **Align:** automatic from shared axes (§2.9.2) with per-view sliders (scale ±10%, offset, rotate 90°, mirror)
   and a consistency IoU badge per view (warn < 0.9).
5. **Yarn & size:** the shared Yarn & size panel (§4.5): target height in inches, yarn weight CYC 1–7, hook
   (default amigurumi hook, Table E), yarn over/under, optional test ball, default stuffing. It stays available on the
   Shape and Pattern tabs afterwards.
6. **Build:** `geom.worker` builds the SDF hull, rounds the depth axis from the front view, meshes, validates,
   splits parts (including the neck), fits primitives, names parts, builds the attach tree and projects colors
   (§2.9). Live preview at N = 64 while sliders move, N = 128 on release. The build panel exposes **Split head at
   the neck** (on), **Merge touching parts** (off) and, under Advanced, **Limb detection** (`openingFrac`).
7. **Review:** the parts model appears in the 3D view. "Looks right" → Shape tab (F5) → Pattern.
   "Not right?" → F4. When the build fails outright (any recon `E_*`), the error panel offers **Describe it for
   Claude Design** (F4 with the photos kept) next to "Edit masks" and "Try one photo".

#### F3 — 3D from one photo with the 3D-ifier (R3)

1. Start → **New 3D toy from one photo** → one photo → mask as in F2 → the required choice **This photo shows the
   object's: front / left side / right side / top** (default front, with pictograms; animals, fish and vehicles are
   usually photographed from the side). The volume is built in the photo's frame and turned so the object's front
   faces +Z (§2.9.3).
2. **Thickness** slider κ (default 0.9; "How deep is it compared to its width?", or "How wide is it compared to its
   length?" for a side photo). Back side, as two separate choices: **back shape** mirror the front depth (default) or
   inflate; **back colors** each part's base color (default for front and top photos), mirror the photo (default for
   side photos, whose unseen side is the object's other side), one solid color, or add a back photo (becomes F2 with
   two views) (§2.9.6). **One-sided detail** (on for front/top photos, off for side photos): when on, eyes, nose and
   other small details are never copied to the unseen side; when off, mirroring copies them too (a side-view animal
   gets both eyes).
3. Optional **Add depth detail** (Depth Anything V2 Small, 27 MB q8 / 50 MB fp16 one-time download, cached).
   If WebGPU is missing it runs in WASM (~2.5 s); offline without the cached model the button is disabled with
   the reason shown; inflation alone always works (§2.9.4).
4. **Yarn & size** panel (§4.5), exactly as F2 step 5.
5. Build, review and continue exactly as F2 steps 6–7.

#### F4 — "Not right?" → Q&A → Claude Design prompt → import (R5, R6)

1. Entry points: "Not right?" after F2/F3, **Describe it for Claude Design** on a failed F2/F3 build (photos kept),
   the Shape tab toolbar, or Start → **Describe a toy for Claude Design**. The **seed source** is the current model
   (reconstructed or edited parts, names, sizes, positions, colors and user edits kept) whenever one exists; the
   category template is used only for "Describe a toy", after a failed build (there is no model), or when the user
   picks "Start over from a template" after rejecting the silhouette or the parts (§3.3). The wizard is
   **resumable**: answers live in `QaState` and re-entry opens at the last step reached; while the project is
   waiting for a Claude Design result it opens at step 4 (Import) with "Edit answers" and "Copy prompt again".
2. **Q&A wizard** (§3.2): "What is it?" and "Anything else?" always shown, plus at most 14 adaptive steps, each
   pre-filled from photos and settings, each with "Decide for me". Yarn weight and hook are asked with the size
   unless already chosen. Answers build a **seed spec** (`crochet-model`, revision 0) rendered live as a blockout
   next to the current model.
3. **Send step:** primary button **Copy prompt** (the full prompt-v1 text with the seed embedded, §3.4) and
   **Save kit to folder** (one folder-picker action: the photos renamed `1-front.jpg`, `2-left.jpg`, … plus
   `crochet-brief.txt` and `crochet-model.seed.json`; a single `.zip` download where the folder picker is missing).
   Step-by-step instructions: open claude.ai/design → choose **3D object** → paste the prompt → attach the photos
   only → when done use **Share → Export → Project HTML → Project archive** (free, instant) or copy the JSON block
   from Claude's final reply [08]. A "Pasting didn't work?" expander offers the kit route (attach
   `crochet-brief.txt`, paste a one-line message) and **Copy compact prompt** (no reference builder).
   Copy prompt (either variant) and Save kit put the project into **waiting for Claude Design**
   (`QaState.awaiting`, saved with the project): until a result is accepted or the user dismisses it, the project
   shows the banner "Waiting for your Claude Design result · **Import Claude Design result** · Copy prompt again ·
   Dismiss" and an **Import** tab (§5.3). The user can close the app for hours; nothing is lost.
4. **Import** (from the banner, the Import tab, this step, or Start → **Import from Claude Design**, which offers
   "Import into <project> (where you made the prompt)" when the result carries that project's `x-cpg` tag or ≥ 60%
   of its seed's part ids, §3.7.7): drop the `.zip`, `.html`, `.glb`, `.gltf`, `.obj`+`.mtl`, `.ply`, `.stl`,
   `.json`, `.tar.gz`, or paste text (§3.7). The importer reports carrier, dialect, confidence and every
   auto-repair, including each inferred attachment ("Head → Body") as a chip that opens the Attach tool, the units it
   read (§3.7.5) and, when an archive holds several versions, which one it used (§3.7.2). When no JSON is found (E8)
   or the result is low-confidence, **Copy fix-up message** (§3.4.2) gives a short message to send to Claude Design
   in the same project; the button is always available on this step.
5. **Diff and accept:** parts added/removed/changed vs the seed or current model; accepting creates a new model
   revision (old revisions kept, revertible). App-owned per-part settings carry over by part id (`paint` only when
   the part's type and dims match within 10%, §3.7.7). When the project has labeled photo views, **Apply photo
   colors** re-projects the photos onto the accepted model (§2.9.6).
6. **Yarn & size** panel (§4.5), pre-filled from the model's `yarn` when Claude Design gave one; then F5.

#### F5 — 3D adjustment editor (R7)

Select a part → move/rotate/scale gizmos (a part's attached children follow it; ⌥ moves the part alone), edit
primitive parameters (children stay attached to the same surface point), re-proportion with the Proportions panel
(head : body, limb length; `applyProportions`, §4.2) or **Scale model to height**, add/remove/duplicate/mirror parts,
sculpt mesh parts (inflate, deflate, smooth, flatten), cut a part in two, **merge** parts into one (⌘J; a one-piece
bird, or a belly bump that became `part_3`), set the crochet start pole/axis or seed,
paint colors, stripes and spots, choose how each part is made (crocheted piece, flat appliqué, embroidery,
safety eye, color of its parent), and set yarn, hook and stitch style in the Yarn & size panel. Rounds are drawn as
rings on the model and the pattern regenerates live (§4).

#### F6 — Colors and patterns in both modes (R8)

- 2D: palette from the image, matched to real yarn (§2.4); stripes, repeats and motifs detected and written as
  repeats (§2.6); eyes and outlines protected (§2.5).
- 3D: per-vertex labels projected from the photos (§2.9.6) — also onto a model that came back from Claude Design,
  via **Apply photo colors** — region specs from Claude Design (§3.5), and editor paint become per-stitch colors
  with round-aware smoothing, stripe snapping, motif repeats and embroidery/appliqué extraction (§2.11).

#### F7 — Save, load, export, import (data safety)

Autosave to IndexedDB 800 ms after any authored change and on tab hide; status chip "Saved ✓ / Saving… / Error".
One browser tab edits a project at a time (others open it read-only; after 5 s without a hand-over they may **Take
over**), and a save never overwrites a newer stored revision (it becomes a copy, and the tab keeps editing that
copy). Library on the start screen. Export/import `.crochet.json` (single file, assets embedded). Import never
overwrites an existing project. In dev/preview the Vite plugin mirrors every project to
`~/Documents/Crochet Pattern Generator/projects/` (or `CPG_PROJECTS_DIR`) and makes dated backups on start when the
folder changed; backups store each asset once and are capped in size (§5.5.4).

#### F8 — Print / PDF

"Print / PDF" builds a PDF with jsPDF (Letter or A4): cover with preview, size, skill level, materials and yardage,
gauge, notes and abbreviations, the chart tiled over pages with 2-cell overlap and a page map (2D), written rows
with a checkbox per row, pieces and assembly with placement images (3D). "Print" opens the same PDF in a new tab
for the system print dialog. Exports are blocked while any `E_*` validation error exists.

### 1.4 Requirement traceability

| Req | Flows | Algorithms | Owning tracks (§6) |
|---|---|---|---|
| R1 2D pattern | F1, F7, F8 | §2.2–2.8 (border §2.7.10), §2.13 | T1, T2, T8 |
| R2 3D multi-view | F2, F5 | §2.9, §2.10–2.12 | T3, T4, T6 |
| R3 3D single image | F3, F5 | §2.9.3 (photo orientation), §2.9.4 (depth, release gate 4), §2.9.6 (back colors) | T3 |
| R4 size math + generator algorithm | F1–F5 | §2.1–2.2, §2.8, §2.10, §4.5 (Yarn & size for every 3D origin) | Step 0, T1, T2, T4, T6 |
| R5 Q&A → Claude Design prompt | F4 | §3.1–3.4 (send side verified by the S-CD spike, §6.5) | T7, I (spike) |
| R6 import Claude Design files | F4 | §3.5–3.7 (versions §3.7.2, units §3.7.5, attach tree §3.7.6, return path §3.7.7) | Step 0 (`inferAttach`, `nameParts`), T7 |
| R7 3D adjustment editor | F5 | §4, §2.10 (live), §2.9.8 (sculpt, cut, merge kernels), `applyProportions` (§4.2) | Step 0, T6, T5 |
| R8 colors and patterns | F1, F4, F6 | §2.4–2.6, §2.9.6 (incl. Apply photo colors), §2.11 | T1, T3, T4, T6, T7 |

---

## 2. Algorithms

### 2.1 One algorithm, two geometries (R4)

Every generator we studied follows the same skeleton: load → crop → resize to a stitch grid → reduce colors →
map pixels → remove stray colors → chart → (sometimes) written rows [02 §1]. The field's gaps are where we differ:
square cells (Stitch Fiddle, KnitPro), frequency-greedy brand palettes, no yardage, mislabeled C2C rectangles,
LLM-written amigurumi that fails stitch arithmetic [02, 03 §3.7]. Our algorithm is one pipeline with two geometries:

```
ResolvedGauge (w, h, yarn per stitch)                         §2.2
   ├─ 2D: finished size → cols × rows (independent axes) → cells sampled from the image
   └─ 3D: part surface → profile arc length / geodesic rows → stitches per round = circumference ÷ (w·s)
Color: OKLab features → quantize → yarn p-median → cleanup along the WORKING PATH       §2.4–2.5, §2.11
        (rows boustrophedon | C2C anti-diagonals | circular rounds)
Pattern language: Line[] of Op[] → validator → encodeOps (repeats) → renderers           §2.6, §2.7, §2.10
Yardage: per-stitch yarn × counts + carried + tails + buffer                             §2.8
```

### 2.2 Gauge model and default tables

#### 2.2.1 Table A — base flat sc gauge by CYC weight [01 §8]

`sts4 × rows4` per 4 in; `w = 4/sts4`, `h = 4/rows4`. `tol` is the 1σ-ish relative size uncertainty without a swatch.

| CYC | Name | Default hook | sts4 × rows4 | w × h (in) | tol | yd/100 g |
|---|---|---|---|---|---|---|
| 0 | Lace | 2.25 mm (B-1) | 34 × 40 | 0.118 × 0.100 | 0.25 | 700 |
| 1 | Super Fine | 3.25 mm (D-3) | 24 × 28 | 0.167 × 0.143 | 0.15 | 400 |
| 2 | Fine | 4.0 mm (G-6) | 18 × 21 | 0.222 × 0.190 | 0.20 | 330 |
| 3 | Light (DK) | 4.0 mm (G-6) | 16 × 19 | 0.250 × 0.211 | 0.12 | 280 |
| 4 | Medium (worsted) | 5.0 mm (H-8) | 13.5 × 16 | 0.296 × 0.250 | 0.12 | 190 |
| 5 | Bulky | 6.5 mm (K-10½) | 10.5 × 12 | 0.381 × 0.333 | 0.15 | 120 |
| 6 | Super Bulky | 8.0 mm (L-11) | 7.5 × 8.5 | 0.533 × 0.471 | 0.15 | 70 |
| 7 | Jumbo | 15 mm (P/Q) | 4 × 4.2 | 1.000 × 0.952 | 0.35 | 15 |

CYC also publishes ranges (sc per 4 in: 1: 21–32, 2: 16–20, 3: 12–17, 4: 11–14, 5: 8–11, 6: 7–9, 7: ≤ 6; lace in dc)
used only for sanity warnings (§2.2.5). Hook labels (mm → US) [01 §1.4]: 2.25 B-1, 2.75 C-2, 3.25 D-3, 3.5 E-4,
3.75 F-5, 4 G-6, 4.5 7, 5 H-8, 5.5 I-9, 6 J-10, 6.5 K-10½, 8 L-11, 9 M/N-13, 10 N/P-15, 11.5 P-16, 15 P/Q,
15.75 Q, 19 S, 25 T/U/X. Sizes without a letter (2.0, 2.5 mm) print as mm only.

#### 2.2.2 Table B — technique transforms and stitch aspect (same yarn and hook as Table A) [01 §8]

| Technique id | Cell `w × h` | Aspect `w/h` | Notes |
|---|---|---|---|
| `sc_graphgan` | `w × h` | ≈ 1.18 (113 labels: smooth-yarn median 1.18, IQR 1.10–1.25) | nothing carried; wider than tall |
| `sc_tapestry`, `sc_tapestry_round` | `w × (w/0.88)·(1 + 0.05·max(0, carried − 1))` | ≈ 0.88 | carried strands make stitches taller than wide |
| `hdc_graphgan` (P1) | `1.05w × 1.5h` | ≈ 0.83 | |
| `c2c` | square tile `2.6w × 2.6w` | 1.0 | worsted ≈ 0.77 in (observed 0.67–0.86) |
| `mosaic_overlay` (P1) | `w × w/1.3` | 1.3 | |
| `amigurumi_sc` | Table E | 1.05 (yarn over), 1.11 (yarn under) | |

Hook override without a swatch: multiply both `w` and `h` by `(hook/refHook)^0.75` (refHook = Table A hook;
amigurumi: Table E hook) [01 §4.4]. Show the size range for p = 0.5…1.0.

#### 2.2.3 Table E — amigurumi (tight sc in rounds) [01 §3.7, Table E]

| CYC | Hook | w (in) | sts/in |
|---|---|---|---|
| 1 | 2.25 mm | 0.130 | 7.7 |
| 2 | 2.5 mm | 0.155 | 6.5 |
| 3 | 2.75 mm | 0.170 | 5.9 |
| 4 | 3.5 mm | **0.195** | 5.1 |
| 5 | 4.5 mm | 0.260 | 3.8 |
| 6 | 6.0 mm | 0.330 | 3.0 |
| 7 | 9 mm | 0.500 | 2.0 |

`h = w / 1.05` (yarn over, default) or `h = w / 1.11` (yarn under toggle). CYC 0 is not offered for amigurumi.
Stuffing stretch `s`: 1.05 for `firm`/`medium` stuffing, 1.00 for `light`/`none` (ears, flat pieces). Stretch is
applied **isotropically**: effective stitch `wS = w·s`, effective round pitch `hS = h·s`.
Calibration check: 42-st sphere in worsted ⇒ `D = 42·0.195·1.05/π = 2.737 in` (PlanetJune: ≈ 2.75 in).

#### 2.2.4 Yarn per stitch (Table D model) [01 §6.2]

```
L_sc  = lscCalibratedIn ?? 6.5 · w_sc            // w_sc = Table A sc width after hook scaling; ±15%
MULT  = { sc: 1, hdc: 1.45, dc: 2.0, ch: 0.42, slst: 0.5 }
L_tile(C2C) = L_sc · (3·2.0 + 3·0.42 + 0.5) = 7.76 · L_sc
L_ami = lscCalibratedIn ?? 6.5 · max(w_sc(CYC, hook), w_ami(CYC, hook))
        // the flat-sc model at the amigurumi hook (Table A width × (hook / Table A hook)^0.75), or the Table E
        // width × (hook / Table E hook)^0.75 if larger; worsted at 3.5 mm: 6.5 · 0.2267 = 1.47 in; ±20% until calibrated
```

`L_ami` was `6.5 · w_ami` in v1.1; that applies the flat-sc constant to the tight amigurumi stitch width and claims
worsted on a 3.5 mm hook uses 14% less yarn than the same model's flat sc on that hook (1.27 vs 1.47 in), although
Trock measured DK on a 3.5 mm hook at 1.5 in [01 §6.1]; our formula gives DK at 3.5 mm 1.47 in. The tight stitch is
narrower because the loops are smaller, not because less yarn goes into them, so the hook, not the stitch width,
scales the yarn.

Table D — default yarn per stitch in inches at the table's hooks (±15% for sc/hdc/dc, ±35% for C2C, ±20% for
amigurumi until the 10-stitch calibration of §2.8 is done) [01 Table D]:

| CYC | sc | hdc | dc | C2C tile | amigurumi sc (`L_ami`, Table E hook) |
|---|---|---|---|---|---|
| 0 | 0.76 | 1.11 | 1.53 | 5.93 | — |
| 1 | 1.08 | 1.57 | 2.17 | 8.41 | 0.85 |
| 2 | 1.44 | 2.09 | 2.89 | 11.21 | 1.02 |
| 3 | 1.62 | 2.36 | 3.25 | 12.61 | 1.23 |
| 4 | 1.93 | 2.79 | 3.85 | 14.95 | 1.47 |
| 5 | 2.48 | 3.59 | 4.95 | 19.22 | 1.88 |
| 6 | 3.47 | 5.03 | 6.93 | 26.90 | 2.79 |
| 7 | 6.50 | 9.42 | 13.00 | 50.44 | 4.43 |

Worsted check: `L_sc = 6.5 · 0.296 = 1.93 in` (Trock measured 1.8 in) [01 §6.1]. The table is derived from the
formula and printed to 2 decimals in every column; code computes from the formula (hook scaling and calibration
apply); tests assert every cell within ±0.01 (the largest rounding residue is 0.005). In the amigurumi column only
CYC 1 takes the Table E branch of the `max` (0.845 vs 0.822).

#### 2.2.5 Resolving the gauge

```ts
// src/core/gauge/resolve.ts (Step 0 kernel)
export function resolveGauge(g: GaugeSpec): ResolvedGauge {
  // 1. swatch wins: cell = { w: span/sts, h: span/rows } for the SAME technique;
  //    C2C swatch "N tiles = X in" → tile = X/N; amigurumi test ball "max N sts, circumference C" → w·s = C/N (s := 1).
  // 2. else Table A base (CYC) × hook factor → Table B transform (or Table E for amigurumi).
  // 3. wSc, hSc (yardage and the sc border, §2.7.10) = Table A sc width and row height × hook factor,
  //    independent of technique (an sc_graphgan swatch sets them directly).
  //    lscIn = L_sc for 2D techniques, L_ami for 'amigurumi_sc' (§2.2.4); lscCalibratedIn overrides both.
  // 4. tol = Table A tol (default) or 0.04 (swatch). source = 'default' | 'swatch'.
}
```

Sanity warnings on a swatch [01 §7]: any count outside the CYC range ±35% (cm entered as inches, UK terms,
wrong technique); flat sc `w/h` outside 0.75–1.5; rows < stitches for flat sc (novelty yarn or tapestry).
UK patterns: "dc" means US sc. Size displays always carry the band `nominal × (1 ± tol)`.

#### 2.2.6 Amigurumi sphere sizing [01 §5, 03 §4.1]

```
k      = max(2, round(π·D / (6·wS)))       N_max = 6k
p      = max(0, round(3k·(w/h)) − 2k)      // plain rounds (counts the two pole gaps as intervals) [03 §4.1]
rounds = 2k − 1 + p ;  stitches = 6k² + 6kp ;  D_actual = 6k·wS/π
```

Example (worsted, w = 0.195, s = 1.05, w/h = 1.05, D = 2.35 in): k = 6, N_max = 36, p = 7, 18 rounds, 468 sts,
D_actual = 2.346 in. (`01 §5.1` counts one more round; we use `03`'s interval-correct form.)

### 2.3 2D: image ingest, sizing and resampling

#### 2.3.1 Decode and normalize (worker)

1. **Decode seam.** `src/core` never decodes files. The worker request types take `Blob | RgbaImage`
   (`ChartRequest.image`, `ReconRequest.views[].image`; `RgbaImage = { w, h, data: Uint8ClampedArray }`, RGBA8,
   orientation applied); the worker adapter `workers/decode.ts` (S0) turns a `Blob` into an `RgbaImage`, and core
   functions only ever receive `RgbaImage`s. Node tests pass `RgbaImage`s
   (generated by `src/test/rgba.ts` or read with the S0 PNG codec `core/kernel/png.ts`), so the same core code runs
   in workers and in the vitest `node` environment, which has neither `createImageBitmap` nor `OffscreenCanvas`.
   `decodeImage(blob)`: `createImageBitmap(blob, { imageOrientation: 'from-image', premultiplyAlpha: 'none' })` →
   `OffscreenCanvas` → RGBA8. Indexed/16-bit/CMYK inputs are normalized by the browser decode [02 §6.7].
   **HEIC/HEIF** (iPhone photos; AirDrop keeps HEIC; no desktop Chrome version decodes it, caniuse checked
   2026-10-01): when the decode fails and the bytes carry an ISO-BMFF `ftyp` box at offset 4 with a HEIF brand
   (`heic`, `heix`, `hevc`, `hevx`, `heim`, `heis`, `mif1`, `msf1`), the adapter posts the bytes to the dev/preview
   server's `POST /__convert` (§5.5.4: macOS `sips -s format jpeg -s formatOptions 92`, ≤ 50 MB, 20 s timeout) and
   decodes the returned JPEG; a chip says "Converted from HEIC". In a static build, or when `/__convert` answers 501
   (not macOS), the message stays "This is a HEIC photo; export it as JPEG (Photos → File → Export) and add it
   again". The original HEIC is not kept; the converted JPEG is the stored source.
2. Apply the authored `CropRect` (crop, rotate 90° steps, flipX).
3. Keep at most 2048 px on the long side for analysis using our own linear-light box filter (never `drawImage`
   scaling: its filter is browser-defined [02 §4.1]). Pixel-art detection runs on the un-scaled crop.

#### 2.3.2 Background and transparency [06 §5]

- Alpha present: average premultiplied linear RGB + alpha per cell; coverage α < 0.5 ⇒ **background** label;
  otherwise un-premultiply and composite over the background yarn in linear light.
- "Remove plain background" (opaque images): border ring 2% of width; if one cluster covers ≥ 60% of the ring with
  ΔEOKr2 std < 0.03, 4-connected flood fill from the border with tolerance ΔEOKr2 0.05 that never crosses Sobel
  magnitude ≥ the 90th percentile. Show the mask; the user confirms or brushes.
- Background is a label outside the K budget, always rendered as one chosen yarn (default: the nearest palette
  yarn to the border color; for transparent images the reference line's white). v1 has no "no stitch" cells: every
  row and round is worked across the full chart width, because the flat writers (§2.7) have no edge shaping and
  `E_RUN_SUM` requires full rows. Shaped pieces (one stitched span per row with moving edges) are v1.1 (§7.3).
- Guard: subject < 15% or > 95% of the image ⇒ warning.

#### 2.3.3 Grid sizing (independent axes) [01 §4.1, §9]

```ts
// src/core/gauge/grid.ts (Step 0 kernel)
export function grid(c: Cell, req: { wIn?: number; hIn?: number; imgW: number; imgH: number;
                                     border?: { widthIn: number; roundH: number };   // roundH = ResolvedGauge.hSc
                                     colsMult?: Mult; rowsMult?: Mult }) {
  const a = req.imgH / req.imgW;                                  // subject aspect AFTER crop
  const nB = req.border && req.border.widthIn > 0
    ? Math.max(1, Math.round(req.border.widthIn / req.border.roundH)) : 0;   // border rounds (§2.7.10)
  const B = nB * (req.border?.roundH ?? 0);                       // ACTUAL border width per side
  let Wg = req.wIn !== undefined ? req.wIn - 2 * B : undefined;
  let Hg = req.hIn !== undefined ? req.hIn - 2 * B : undefined;
  if (Wg !== undefined && Hg === undefined) Hg = Wg * a;
  if (Hg !== undefined && Wg === undefined) Wg = Hg / a;
  const cols = snap(Wg! / c.w, req.colsMult), rows = snap(Hg! / c.h, req.rowsMult);   // never rows = cols·a
  return { cols, rows, borderRounds: nB, actualW: cols * c.w + 2 * B, actualH: rows * c.h + 2 * B,
           aspectErr: ((rows * c.h) / (cols * c.w)) / a - 1 };
}
const snap = (x: number, k?: Mult) => !k ? Math.max(1, Math.round(x))
  : Math.max(0, Math.round((x - k.plus) / k.m)) * k.m + k.plus;   // e.g. mosaic {m:12, plus:3}
```

- Both W and H given with aspect lock off: crop must match; otherwise the UI offers "crop to fit" or "pad".
- `|aspectErr| > 0.025` ⇒ offer ±1 row/column. Show `actualW × actualH` and the tolerance band.
- C2C: `c` is the square tile. Tapestry in the round: `wIn` is the **circumference**, `hIn` the height, and no
  border (the border setting is hidden for `sc_tapestry_round`).
- The border is written by §2.7.10; `actualW × actualH` (shown everywhere, printed on the cover) include it.
- Limits: warn above 300 cells on a side (render time, practicality); hard cap 1000.
- Golden: worsted sc (13.5 × 16), 40 × 50 in, image 1200 × 1500 ⇒ **135 cols × 200 rows**; a square-cell tool
  would give 135 × 169 (15.5% short) [01 §4.2]. Same request with a 1 in border (`roundH` 0.25) ⇒ 4 border rounds,
  **128 × 192** chart, finished 39.9 × 50.0 in.

#### 2.3.4 Image kind and sampling [06 §4]

Auto-detect (user can override):
- **Pixel art:** `ex[x] = Σ_y [ΔEOKr2(p(x,y), p(x−1,y)) > 0.05]` (and `ey`); autocorrelation period ≥ 3 px gives
  block size `s` and phase; accept if ≥ 90% of blocks have within-block ΔEOKr2 std < 0.03.
  Then one cell = one native pixel, no resampling; finished size follows from the gauge; resizing only by integer
  multiples (warn).
- **Flat art:** ≤ 256 unique colors with the top 16 covering ≥ 90% of pixels, or flatness (share of pixels whose
  4-neighbors are within ΔEOKr2 0.01) ≥ 0.75.
- **Photo:** otherwise.

Sampling:
- **Photo:** cell (i, j) covers source rect `[j·W/cols, (j+1)·W/cols) × [i·H/rows, (i+1)·H/rows)` (not square in
  pixels — intended). Exact fractional-area box average in **linear** premultiplied RGB → OKLab features.
- **Flat:** 3×3 median on labels → quantize at source resolution (§2.4) → per cell the area-weighted label mode,
  with thin-feature protection: label components whose max distance transform < half a cell and whose skeleton
  spans ≥ 2 cells win any cell their skeleton crosses with ≥ 15% coverage; diagonal-only links get one bridging
  cell. Thin cells join the protect mask (§2.5).
- **Pixel:** native pixel colors.

### 2.4 Color pipeline and yarn matching

#### 2.4.1 Color math (Step 0 kernel, `src/core/kernel/color.ts`) [06 §1]

- sRGB decode: `c ≤ 0.04045 ? c/12.92 : ((c+0.055)/1.055)^2.4`; encode: `c ≤ 0.0031308 ? 12.92c : 1.055c^(1/2.4) − 0.055`.
- OKLab (Ottosson; CSS Color 4 matrices):
  ```
  l = 0.4122214708r + 0.5363325363g + 0.0514459929b      L = 0.2104542553l' + 0.7936177850m' − 0.0040720468s'
  m = 0.2119034982r + 0.6806995451g + 0.1073969566b      a = 1.9779984951l' − 2.4285922050m' + 0.4505937099s'
  s = 0.0883024619r + 0.2817188376g + 0.6299787005b      b = 0.0259040371l' + 0.7827717662m' − 0.8086757660s'
  (l', m', s') = cbrt(l, m, s); inverse uses Ottosson's published inverse matrices.
  ```
- Toe: `k1 = 0.206, k2 = 0.03, k3 = (1+k1)/(1+k2)`; `toe(x) = ½(k3x − k1 + √((k3x − k1)² + 4k2k3x))`.
- **Cluster feature** `f = (toe(L), 2a, 2b)`; Euclidean distance in `f` = ΔEOKr2 (1 JND ≈ 0.02 ≈ ΔE00 2).
- **Shading-robust feature** (photos of 3D objects only): `f' = (0.35·L, a/max(L,0.25), b/max(L,0.25))`; clip the top
  2% of L first [06 §9.4].
- **CIEDE2000** (Sharma 2005) on CIELAB with D65 white. Tests MUST include Sharma's 34 published pairs
  (tolerance 1e-4); smoke pairs: (50, 2.6772, −79.7751) vs (50, 0, −82.7485) → **2.0425**;
  (50, 2.5, 0) vs (73, 25, −18) → **27.1492**; (50, 2.5, 0) vs (61, −5, 29) → **22.8977**.
- Deterministic helpers in the kernel: `fnv1a64(bytes)`, `mulberry32(seed)`, stable sort.

#### 2.4.2 Quantizer [06 §2.3]

- Points: unique feature vectors with weights (photo: one per cell; flat: per-pixel histogram on 5-bit/channel bins,
  ≤ 32k points).
- Init: repeatedly split the cluster with the largest weighted SSE along its principal axis (power iteration from
  [1,1,1]) at the SSE-optimal cut (prefix sums over the stable-sorted projection).
- Refine: weighted Lloyd, ≤ 30 iterations, stop when `(SSE_prev − SSE)/SSE < 1e-3`; empty cluster re-seeded at the
  point with the largest weighted error; ties → lowest index.
- Output sorted by population (desc) → codes `A, B, C, …` (A = main color). Never "MC" (clashes with magic circle).

#### 2.4.3 Choosing K, salience and merges [06 §2.4]

| Technique | Default K | Max K | Per-line cap |
|---|---|---|---|
| `sc_graphgan`, `hdc_graphgan` | 8 | 16 | warn > 6 strands in a row |
| `c2c` | 8 | 16 | warn > 6 per diagonal |
| `sc_tapestry`, `sc_tapestry_round` | 5 | 8 | 3 colors per row (2 carried) |
| amigurumi (whole toy) | 6 | 8 | 2 per round (3 with warning) |

- **Auto-K:** quantize K = 2…Kmax, `D(K) = √(SSE/W)`; normalize x and y to [0,1]; knee = argmax `(1 − y_n) − x_n`.
- **Salience guard:** cells with ΔE00 ≥ 20 to their assigned center that form a 4-connected component of ≥ 2 cells
  become a protected center (eyes, a red nose, a logo dot). If that exceeds Kmax, drop the lowest-population
  unprotected center and reassign.
- **Merge:** centers closer than ΔE00 5 merge into the more populous one (within one yarn line shades are ΔE00 6–10 apart).

#### 2.4.4 Palette sources and yarn matching [06 §7, 02 §4.3]

| Mode | Candidates | Selection |
|---|---|---|
| Auto (default) | free centers | §2.4.2–2.4.3; each center is *named* by its nearest shade in the reference line (default Red Heart Super Saver), "approximate" if ΔE00 > 10 |
| Yarn line(s) | solid shades of the chosen lines | **p-median**: BUILD greedily adds the shade that most reduces `Σ_bins w·ΔEOKr2(bin, nearest chosen)`; SWAP chosen↔unchosen until no gain (≤ 50 passes). K = max colors or auto-K |
| My stash | user's saved yarns | same p-median |
| Custom CSV | lines `#hex,name[,brand,code,yds_per_skein]` | fixed palette; p-median subset if K < rows |

- Heathers/marls/flecks match on mean color and are flagged "reads textured"; never assigned to protected labels.
- Every match shows ΔE00 (cluster mean vs yarn hex); > 10 shows "no close yarn in this line".
- Yarn hex values are photo-sampled approximations (two sources differ by median ΔE00 3.7) [06 §7.2]; the materials
  page says so.

#### 2.4.5 Assignment and dithering [06 §3]

Nearest center by ΔEOKr2 (32³ LUT cache). Dithering is **off** by default for every technique. v1 also offers
**Row fade** for gradients: inside gradient regions (3×3 ΔEOKr2 < 0.03 and the two nearest centers within ΔE00 20),
each row segment takes one color and the quantization error diffuses to the next row only, so gradients become
stripes of varying width with no extra changes inside a row. Run-constrained Floyd–Steinberg and Bayer
"heathered" are v1.1.

### 2.5 Crochet cleanup (along the working path) [06 §6, 02 §6.3]

Working path: flat rows (boustrophedon order is irrelevant for symmetric passes), rounds (circular), C2C
anti-diagonals in working order. Every pass skips **protected** cells: thin features, salient labels, user locks,
user overrides.

1. **Confetti** (≤ 3 passes): a cell with 0 same-label 4-neighbors and ≤ 1 same-label 8-neighbor takes the most
   frequent 8-neighbor label; ties → smallest ΔE00 to the cell's own source color.
2. **Small components:** 4-connected components smaller than `A_min` merge into the neighbor label with the longest
   shared border (ties → closest color), smallest first.
3. **Potts DP per line:** minimize `Σ d(f_i, C[k_i])/σ + λ·[k_i ≠ k_{i−1}]` with minimum run `r_min`
   (states `(k, r ≤ r_min)`, switch only when `r = r_min`); σ = median center distance; protected cells cost +∞ for
   other labels. Rounds use the circular variant (fix the first label, Viterbi, add `λ·[k_last ≠ k_0]`, keep best).
   `O(W·K²·r_min)` per line.
4. **Per-row cap** (tapestry): rows with more than `C_row` labels keep the top `C_row` by `count × importance`
   (importance 3 for protected labels) and re-run step 3 with the others forbidden.
5. **Rare colors:** labels below the preset minimum remap to the nearest remaining label (skipped if < 2 would remain).

| Parameter | Max detail | **Balanced** (default) | Easy |
|---|---|---|---|
| confetti passes | 0 | 3 | 3 |
| `A_min` graph & C2C / tapestry | 1 / 1 | 2 / 3 | 4 / 5 |
| Potts λ graph & C2C / tapestry | off | 0.4 / 0.6 | 0.8 / 1.0 |
| `r_min` graph & C2C / tapestry | 1 / 1 | 1 / 2 | 2 / 3 |
| tapestry `C_row` | 4 | 3 | 2 |
| rare-color minimum | 0 | 10 cells | 0.5% of cells |

**Metrics** (recomputed after every stage, shown live): confetti % (target < 2% graph/C2C, < 1% tapestry),
color changes per row (mean, max, busiest rows), strands/bobbins per color, ends ≈ 2 × strands, max carried colors
per row, fidelity (mean ΔE00 source vs final), and a display-only **Workability** score
`clamp(100 − 300·confetti − 4·max(0, chg̅ − 2) − 0.2·max(0, strands − 10) − 5·max(0, carriedMax − 2), 0, 100)`.

### 2.6 Pattern capture and the repeat encoder

#### 2.6.1 The encoder (Step 0 kernel, `src/core/pattern/encode.ts`) [07 §7.4]

Input: a token list. **2D rows** use run tokens (`{color, count}` atoms) so long rows stay fast; **3D rounds** use
per-op tokens (`sc`, `inc`, `dec`, …, with loop and color in the key) so periodic shaping is visible.
Tokens are interned to small integers first; results are memoised in an LRU (4 096 entries) keyed by
`fnv1a64(token ints ‖ mode)`, so identical rows of a chart are encoded once.

**Exact DP (n ≤ 120 tokens)** — shortest encoding with at most one bracket level:

```ts
type Item = { kind: 'run'; op: Op; n: number } | { kind: 'rep'; inner: Item[]; times: number };
// encode(i, j, depth) memoized in typed arrays:
//   all tokens i..j identical            → cost 1, [run]
//   best over splits k (i ≤ k < j)       → concat(encode(i,k), encode(k+1,j)), cost = sum
//   depth 0 only: every period p (2 ≤ p ≤ n/2, n % p == 0) where tokens are p-periodic
//                                        → [rep(encode(i, i+p−1, depth 1), n/p)], cost = inner + 1
// better(a, b): lower cost → fewer top-level items → shorter canonical compact string → lexicographic.
```

Implementation (normative for performance; the result is identical to the definition above):
- Scores are numeric triples `(cost, topItems, compactLength)` stored in three `Int32Array`s with back-pointers
  (`kind`, split `k` or period `p`); compact lengths are summed from per-run lengths, so no string is built while
  searching. The final string is built once from the back-pointers. A lexicographic string comparison is made only
  when two candidates tie on all three numbers.
- Periods come from one KMP failure function per start index `i` (O(n²) total): the smallest period of
  `tokens[i..j]` is `len − fail[j]`, and only its multiples that divide `len` are tried.
- Short-circuits: a single token or a uniform line is one run without running the DP.

**Linear fallback (n > 120 tokens, both modes):** convert to runs; if the whole run list is periodic (KMP, period
≤ half the list) emit `(runs) x k`; otherwise scan left to right and, at each position, take the block of
`p ≤ 8` runs with the largest covered length `p · reps` (reps ≥ 2, ties → smaller `p`) as a repeat, else emit the
run and advance. O(n) per position in the worst case; at most one bracket level, same post-rules.

- Segments (`Line.segments`) are encoded separately and joined (oval ends vs sides) [07 §6.9].
- Post-rules: whole line one op → `sc in each st around` / `inc in each st around` / `dec around` /
  `sc in each st across`; never `( ) x 1`; never nested brackets in Compact; `expand(encode(x)) == x` always (R10).
- Budgets (vitest perf tests, §5.8): ≤ 5 ms per line at 120 tokens (exact DP); ≤ 2 s for 200 rows of 240 run tokens
  (fallback + memo); the teddy regeneration stays < 150 ms.
- Vectors from `07 §7.6` are golden tests: `[sc,inc,sc,sc,sc,inc,sc,sc,sc,inc,sc,sc]` → `(sc, inc, 2 sc) x 3`;
  37→30 grouped → `(4 sc, dec) x 2, (3 sc, dec) x 5`; 15→22 grouped → `sc, (sc, inc) x 7`;
  `sc, inc, (2 sc, inc) x 5, sc` → `(sc, inc, sc) x 6`.

#### 2.6.2 Repeats, stripes, symmetry in 2D [06 §8]

- **Lattice motifs:** categorical autocorrelation `match(d) = Σ_c (I_c ⋆ I_c)(d) / overlap`; `p_x` = smallest dx with
  `match(0, dx) ≥ 0.92`, same for `p_y`, confirm with `match(p_y, p_x)`. Consensus regularization (each lattice
  orbit → its mode, protected cells skipped) is applied automatically at ≥ 0.95 and offered at 0.92–0.95.
- **Vertical block repeats:** hash each worked row's token list; the longest consecutively repeated block of length
  L ≥ 2 becomes `Rows 13–24: rep Rows 1–12`. Flat work requires **even L** (RS/WS parity); rounds any L.
- **Identical consecutive lines** fold into `Rows a–b (k rows)` only when the token list is direction-independent
  (single run or palindrome); rounds fold whenever identical (`Rnds 7–12 (6 rnds)`). Never fold across a color
  change, a BLO round, a note or an assembly reference (`E_FOLD`).
- **Stripes mode:** if row dominance ≥ 0.85 for ≥ 70% of rows, snap those rows to their dominant label and write
  the stripe sequence with its period (`Rows 1–4 A, Rows 5–6 B; rep these 6 rows 5 times`).
- **Symmetry:** best mirror axis agreement `A ≥ 0.92` → report "symmetric about column X"; offer symmetrize.
- **Spots:** compact (area/bbox ≥ 0.6) minority components of similar size (CV ≤ 0.3), ≥ 3 of them → "spot motif";
  the 3D stage may emit them as appliqué (§2.11).

### 2.7 2D techniques and written instructions

#### 2.7.1 What we support, and why [02 §6.1, 01 §3, 07 §3–5]

| Priority | Technique id | Worked as | Why |
|---|---|---|---|
| P0 | `sc_graphgan` | flat rows; bobbins per region, short carries | Most picture-like; graphgans and wall hangings; nothing carried ⇒ plain sc gauge |
| P0 | `sc_tapestry` | flat rows; every color in the row carried | Bags, pillows, small pieces; dense, no floats; ≤ 3 colors per row |
| P0 | `sc_tapestry_round` | joined rounds | Hats, bags, cozies; same chart model as flat |
| P0 | `c2c` | dc tiles on diagonals | The most popular blanket technique; users need written diagonals most |
| P1 | `hdc_graphgan` | flat rows | ≈ 62% of the rows for the same height; trivial once aspect is parameterized |
| P1 (flag) | `mosaic_overlay` | 2 colors, RS-only rows | Popular graphic look; needs its own solver (§2.7.8) |
| P0 | border (all flat techniques) | joined sc rounds around the panel (§2.7.10) | Blankets nearly always have an edging; published sizes include it [01 §4.3] |
| — | Tunisian, filet, inset mosaic, granny/motif grids | not supported | Different quantizers and passes; low demand per effort (non-goals §7.3) |

#### 2.7.2 Rules common to every flat or round 2D technique [07 §3]

- Chart row 0 is the **top** as displayed; worked row/round k (1-based) uses chart row `rows − k` (bottom-up).
- Row 1 is RS. RH: odd (RS) rows read the chart right→left, even (WS) rows left→right. LH: mirrored. In rounds every
  round is RS and reads right→left (RH) / left→right (LH). Every line prints a side tag and an arrow; row numbers
  sit on the chart edge where the row starts.
- A line's runs are listed **in working order**, already reversed for WS rows; singles print as `sc B`, never omitted.
- Color change: on the last yarn over of the stitch **before** the new color. Row boundary: if row n+1 starts in X and
  row n ends in another color, change to X on the last yo of row n so the turning chain is already X. Stated once in Notes.
- Foundation chain color = color of the first run of row 1 in working order.
- Every line ends with its stitch count; text is generated from the `Line` model (§5.2) by renderers:
  - Compact (default): `Row 11 (RS) ←: Ch 1, turn. 4 sc A, 3 sc B, 33 sc A (40 sts) · carry B`
  - US verbose: `Row 11 (RS): Ch 1, turn. With A, sc in first 4 sts; change to B, sc in next 3 sts; change to A, sc in last 33 sts. (40 sc)`
  - UK verbose: same through the terminology table (sc→dc, hdc→htr, dc→tr, sc2tog→dc2tog, gauge→tension, yo→yoh).
  - Word chart: `11 ← | 4A 3B 33A | 40`.

#### 2.7.3 `sc_graphgan` (flat)

```
Foundation: With A, ch {W+1}.
Row 1 (RS) ←: Starting in 2nd ch from hook, {runs} ({W} sts)
Row k (RS|WS) ←|→: Ch 1, turn. {runs} ({W} sts)[ · join B (bobbin 2)][ · carry B]
```

- Ch 1 at the start of a row does not count as a stitch. Foundation = `W + h_tc − c` = `W + 1` [07 §3.2].
- **Carry vs bobbin per color per row:** if a color is absent for ≤ 8 stitches and reappears in the same row, carry it
  (work over it) through the gap; otherwise the next run is a separate strand [07 §3.5]. A run continues an existing
  strand when the previous row has a same-color run overlapping `[x0 − 2, x1 + 2]`. New strands print as
  `join B (bobbin n)`; Materials lists bobbins per color.
- Validation: `E_RUN_SUM` (Σ runs = W on every row), `E_FOUNDATION`, `E_COLOR`, `W_LONG_CARRY` (> 8), warn > 6 strands in a row.

Golden (W = 5; chart top-down `B A A A A / A B B B A / A A B A A`) [07 §3.3]:
```
Foundation: With A, ch 6.
Row 1 (RS) ←: Starting in 2nd ch from hook, 2 sc A, sc B, 2 sc A (5 sts)
Row 2 (WS) →: Ch 1, turn. sc A, 3 sc B, sc A (5 sts)
Row 3 (RS) ←: Ch 1, turn. 4 sc A, sc B (5 sts)
LH Row 3 (RS) →: Ch 1, turn. sc B, 4 sc A (5 sts)
```

#### 2.7.4 `sc_tapestry` (flat)

Same line structure as §2.7.3. Every color that appears in a row is carried through the whole row (worked over).
A color is joined at the start of the first row that needs it; a color absent from the next 2 rows is cut at the row
end (6 in tail); otherwise it keeps being carried. Lines end with `· carry B, C`. Cap: 3 colors per row (cleanup
step 4). Gauge uses the tapestry cell (taller than wide, Table B). Notes add: "Carried yarn stays hidden only with
firm tension; check the RS."

#### 2.7.5 `sc_tapestry_round` (joined rounds)

```
Foundation: With A, ch {C}; join with sl st in first ch to form a ring (do not twist).
Rnd 1: Ch 1 (does not count as a st), {runs}; join with sl st in first sc. ({C} sts) · carry B
Rnd k: Ch 1, {runs}; join with sl st in first sc. ({C} sts)
```

All rounds RS; RH reads chart columns C−1 → 0. Joined rounds keep each round's start aligned (no spiral
stair-step), but the stitches still lean: tapestry sc in the round slants about half a stitch per round [01 §3.4,
Ventura], so a 60-round cozy shears its design by ≈ 30 sts. `ChartSettings.roundLean = { mode, stPerRnd }` (default
`{ mode: 'note', stPerRnd: 0.5 }`; positive = the finished stitches drift against the working direction, i.e. to the
right for RH seen from the RS; the user can calibrate it from a swatch tube, §7.2 Q7):
- `note`: Notes print "Stitches worked in rounds lean: expect the design to shift about {round(stPerRnd·(R − 1))}
  sts to the {right | left} between Rnd 1 and Rnd {R}. Choose 'Pre-skew the chart' or 'Turn every round' in the
  settings to avoid it." The number also shows next to the technique setting.
- `preskew`: round k reads its chart row rotated by `round(stPerRnd·(k − 1))` sts in the working direction (a
  circular shift, exact), so the lean straightens the finished design; the Chart tab shows the target chart, the
  Pattern tab the pre-skewed rows; colors, counts and validators are unchanged.
- `turn`: every round is joined and, from Rnd 2 on, **turned**: `Rnd k (RS|WS): Ch 1, turn. {runs}; join with sl st
  in first sc. ({C} sts)`, even rounds WS; WS rounds read the chart in the opposite direction exactly like flat WS
  rows (§2.7.2), so the lean alternates and cancels; carried strands stay inside the stitches as before.
Cleanup and capture use the circular working path; motif periods snap to divisors of C when `match ≥ 0.9`.

#### 2.7.6 `c2c` (dc tiles) [07 §4]

Chart `chart[r][c]` with r = 0 the **bottom** row, viewed from the RS. Default start bottom-right (RH) /
bottom-left (LH); for a right-hander starting bottom-right, odd rows run ↙ (RS) and even rows ↗ (WS).

**Start corner × handedness.** A C2C tile is chiral (the ch-6 of the next tile sits on the dc-tops side of the
previous one), so a right-hander starting at another corner produces a **rotated** layout, not a mirrored one;
only a change of hand mirrors it. The writer therefore maps the chart into the bottom-right frame, runs the
algorithm below, and maps cell order and arrows back through the inverse transform:

| Hand | BR | BL | TL | TR |
|---|---|---|---|---|
| RH | identity | rotate the chart 90° CCW | rotate 180° | rotate 90° CW |
| LH | mirror horizontally, then the RH entry of the mirrored corner (BR ↔ BL, TR ↔ TL) | ← same rule | ← | ← |

So `T(LH, X) = T(RH, mirror(X)) ∘ M` with M the horizontal mirror. Row arrows are the algorithm's arrows (odd ↙,
even ↗) mapped through the inverse transform, so all four diagonals (↙ ↗ ↖ ↘) occur. Increase/decrease tags,
phases and bobbin 6-connectivity are computed on the transformed chart. The Notes block (§2.7.9) is rendered from the
actual corner and arrows.

```ts
// normative (machine-checked for 4×4, 5×3, 3×5, 10×7, 7×10, 1×5, 5×1, 100×60), on the TRANSFORMED chart
for (let n = 1; n <= W + H - 1; n++) {
  const d = n - 1, odd = n % 2 === 1, cells: [number, number][] = [];
  for (let r = Math.max(0, d - (W - 1)); r <= Math.min(d, H - 1); r++) cells.push([r, W - 1 - (d - r)]);
  cells.sort((a, b) => odd ? b[0] - a[0] : a[0] - b[0]);       // ↙ from the top/right end; ↗ from the bottom/left end
  const blInc = n <= W, rtInc = n <= H;                           // bottom/left end vs right/top end
  const [startInc, endInc] = odd ? [rtInc, blInc] : [blInc, rtInc];
  // start/end = n === 1 ? 'first' : (inc ? 'inc' : 'dec'); tiles(n) = min(n−1, W−1) − max(0, n−H) + 1
}
```

| start \ end | end inc: work last tile into last ch-3 sp | end dec: sl st in last ch-3 sp, turn (no tile) |
|---|---|---|
| **start inc:** Ch 6, dc in 4th ch from hook and next 2 ch | increase row (+1) | steady row (0) |
| **start dec:** Sl st in next 3 dc and in ch-3 sp, ch 3, 3 dc in same sp | steady row (0) | decrease row (−1) |

Line format: `↗ Row 4 (WS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)`; runs always print a count (`1 A`).
Phases: increase `min(W,H)` rows, steady `|W−H|`, decrease `min(W,H) − 1`; one-time note at row `min(W,H)+1`.
Bobbins: **6-connected** regions per color on the (transformed) chart — orthogonal neighbors plus the
(r±1, c±1) diagonal, never the (r±1, c∓1) diagonal [07 §4.6]. Color change on the last yo of the last dc of the
tile before. Golden 5×3 (chart top-down `B A A A A / A B B B A / A A B A A`):

```
↙ Row 1 (RS) [first tile]: 1 A (1 tile)
↗ Row 2 (WS) [inc beg · inc end]: 2 A (2 tiles)
↙ Row 3 (RS) [inc beg · inc end]: 1 A, 2 B (3 tiles)
↗ Row 4 (WS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)
↙ Row 5 (RS) [dec beg · inc end]: 1 A, 1 B, 1 A (3 tiles)
↗ Row 6 (WS) [dec beg · dec end]: 2 A (2 tiles)
↙ Row 7 (RS) [dec beg · dec end]: 1 B (1 tile)
```
Golden, same chart, **RH, start bottom-left** (chart rotated 90° CCW; machine-checked):
```
↖ Row 1 (RS) [first tile]: 1 A (1 tile)                    cell (0,0)
↘ Row 2 (WS) [inc beg · inc end]: 2 A (2 tiles)            cells (1,0), (0,1)
↖ Row 3 (RS) [inc beg · inc end]: 3 B (3 tiles)            cells (0,2), (1,1), (2,0)
↘ Row 4 (WS) [dec beg · inc end]: 1 A, 1 B, 1 A (3 tiles)  cells (2,1), (1,2), (0,3)
↖ Row 5 (RS) [inc beg · dec end]: 1 A, 1 B, 1 A (3 tiles)  cells (0,4), (1,3), (2,2)
↘ Row 6 (WS) [dec beg · dec end]: 2 A (2 tiles)            cells (2,3), (1,4)
↖ Row 7 (RS) [dec beg · dec end]: 1 A (1 tile)             cell (2,4)
```
LH, start bottom-left is the mirror image of the RH bottom-right golden (row 2 visits (0,1), (1,0) ↖).
Golden 100 × 60: 159 rows; rows 61–100 hold 60 tiles; row 101 has 59.

#### 2.7.7 `hdc_graphgan` (P1)

`With A, ch {W+2}.` / `Row 1 (RS) ←: Starting in 3rd ch from hook, {runs} (W sts)` / `Row k: Ch 2 (does not count as a st), turn. {runs} (W sts)`
(07 formula `W + h − c` with h = 2, c = 0). Color change on the final pull-through. Bobbin logic as §2.7.3.

#### 2.7.8 `mosaic_overlay` (P1, behind `features.mosaic`) [02 §6.4c, 07 §5]

- Two colors only. Binarize OKLab L at Otsu and at Otsu ± {16, 32, 48, 64} (0–255 scale) × row phase {0, 1};
  keep the combination with the smallest uncorrected weight.
- Row colors alternate from the bottom: `rowColor(r) = P[(r + phase) % 2]`. An **X** (dc in the front loop of the
  stitch 2 rows below) placed in row r+1 shows row r+1's color in cell r. X marks in one column may never be in
  adjacent rows ⇒ per interior column a maximum-weight independent set on a path:
  `best[r] = max(best[r−1], best[r−2] + w[r])`, `w[r] = target ≠ rowColor ? ΔE·salience : 0`. Edge columns always
  take the row color. One start row and two finishing rows are added.
- Text: `Row k (B, RS) ←: Join B; ch 1, sc in first st, {runs of N sc BLO | N dc FLO 2 rows below}, sc in last st. Fasten off. (W sts)`.
  Rows are RS-only, worked right→left (RH), yarn cut every row (2 tails per row).
- Validation `E_MOSAIC_ADJ`: no vertically adjacent X; edges equal the row color; colors alternate.

#### 2.7.9 Notes blocks (rendered from templates, only the parts that apply) [07 §3.6, §4.7, §6.12]

- Flat graph: "Each square = 1 sc. Odd rows are RS and are read right to left; even rows are WS and are read left to
  right (left-handed: reverse). Ch 1 at the beginning of a row does not count as a stitch. Change color on the last
  yarn over of the stitch before the new color. Work over the color(s) not in use (tapestry), or use a separate bobbin
  for each area marked in the chart (intarsia). Drop the inactive yarn to the WS."
- C2C (corner and arrows filled from the actual start corner and hand, §2.7.6): "Each square = 1 tile (ch 3 + 3 dc).
  Start at the {bottom-right} corner. Odd rows (RS) run {↙}, even rows (WS) run {↗}; turn at the end of every row.
  Increase at beginning: ch 6, dc in 4th ch from hook and next 2 ch. Decrease at beginning: sl st in next 3 dc and
  in the ch-3 sp, ch 3, 3 dc in same sp. Decrease at end: sl st in last ch-3 sp and turn without making a tile.
  Change color on the last yo of the last dc of the tile before."
- Border (when set): "The border is worked in joined rounds of sc with the RS facing. Work 3 sc in each corner
  stitch; along the row ends (and C2C tile edges) space the stated number of sc evenly so the edge lies flat."
- Amigurumi: see §2.10.11.

#### 2.7.10 Border (flat techniques; `core/techniques/border.ts`, T2) [01 §4.1, §4.3]

- **Setting:** `ChartSettings.border = { widthIn, color? }` (`widthIn = 0` ⇒ none; `color` undefined ⇒ palette color
  A; any palette color or yarn may be chosen). Hidden for `sc_tapestry_round`. The finished size the user asked for
  includes the border (`grid()`, §2.3.3).
- **Rounds:** `n = max(1, round(widthIn / hSc))` joined rounds of sc (`hSc` = sc row height, `ResolvedGauge.hSc`);
  the actual border is `n·hSc` per side and that is what `actualW × actualH` report.
- **Per-side counts** in Rnd 1, counted between the corner center stitches (each side includes one stitch of each
  adjacent 3-sc corner group, so the four sides plus the four corner centers make the round):
  - row techniques: top = bottom = `S_top = W` (1 sc per stitch of the last row, 1 sc per free loop of the
    foundation chain);
  - sides (row ends): `S_side = round(rows · h_cell / w_sc)` — the side length over the sc width, so the edge lies
    flat (sc graphgan ≈ 5 sc per 6 row ends; tapestry ≈ 7 per 6; hdc ≈ 5 per 4; mosaic ≈ 3 per 4);
  - C2C (all four edges are tile edges): `S_top = round(W · tile / w_sc)`, `S_side = round(H · tile / w_sc)`
    (≈ 2.6 sc per tile edge).
  - The printed spacing hint is the best ratio `a/b` (b ≤ 6) within 4% of `(S − 2)/units`: "about 5 sc per 6 row
    ends"; `b = 1` prints "1 sc in each row end".
- **Where Rnd 1 starts** is generated from the last worked line, never left to an "if" in the text ([07 §7.7]: never
  assume the last row is RS). The writer knows the last line's side, the corner where it ends, and the color of its
  last stitch:
  - **Continue** (row techniques, border color = color of the last stitch; other strands are cut first):
    - last row **WS** (even row count): RH ends at the top right corner seen from the RS, LH at the top left. Opening:
      "Turn so the RS faces you; ch 1 (does not count), 3 sc in the last st made (top {right|left} corner)"; the top
      edge comes first.
    - last row **RS** (odd row count): RH ends at the top **left** corner, LH at the top right, with the RS already
      facing. Opening: "Do not turn; ch 1 (does not count), 3 sc in the last st made (top {left|right} corner)"; the
      side below that corner comes first.
  - **Join** (another color, and always for C2C, whose last tile is at the corner opposite the start corner, e.g.
    top left for a BR start): "Fasten off. With RS facing, join {color} with a sl st in the top {right (RH) | left
    (LH)} corner st (C2C: in the outer corner of that corner tile); ch 1 (does not count), 3 sc in same st
    (corner)"; the top edge comes first.
  - The four edges then follow in working order from the start corner — RH counterclockwise seen from the RS (top
    right → left, left side down, bottom left → right, right side up), LH clockwise — so a round that starts at a
    different corner is the same cycle rotated. Per-side counts and `c1` do not depend on the start.
- **Text** (RH, even row count or join; edge phrases rotate with the start corner, LH mirrors left/right):
  ```
  Border (with {color}):
  Rnd 1 (RS): {opening}; sc in each st across the top to the last st ({W−2} sc); 3 sc in the top left corner st;
    working down the row ends of the left side, {S_side−2} sc evenly spaced ({hint}); 3 sc in the corner loop of
    the foundation ch (bottom left); sc in each free loop across to the last loop ({W−2} sc); 3 sc in the last loop
    (bottom right corner); working up the row ends of the right side, {S_side−2} sc evenly spaced; join with sl st
    in first sc. ({c1} sts)
  Rnds 2–{n}: Ch 1 (does not count), sc in same st as join and in each st around, working 3 sc in each corner
    center st; join with sl st in first sc. ({c2}, {c3}, … sts)
  Fasten off and weave in ends.
  ```
  When the top edge comes last (RS continue), its phrase is "3 sc in the top {right|left} corner st; sc in each st
  across the top to the last st ({W−2} sc)" before the join.
  `c1 = 2·S_top + 2·S_side + 4`; each later round adds 8 (`c_r = c1 + 8(r − 1)`). For C2C every side reads
  "{S − 2} sc evenly spaced along the tile edges ({hint})" and the 3-sc corner groups go in the outer corner of each
  corner tile. In the `Line` model a border round is
  `kind: 'border'`; Rnd 1 starts `{ k: 'edge' }` (exempt from `E_CONSUME`, like a foundation row) and corners are
  `inc3` ops; Rnds 2–n start `{ k: 'join' }` and are validated individually even though they print as one line
  (the single permitted fold of lines with different counts).
- **Validation `E_BORDER`:** `S_top`, `S_side` as above; `c1 = 2·S_top + 2·S_side + 4`; every later round adds
  exactly 8 with one `inc3` in each corner center stitch; the printed per-side counts sum to the stated total.
- **Yardage** (§2.8): border stitches × `L_sc` + per round one ch 1 and one sl st (`0.92·L_sc`) + 2 × 6 in tails,
  charged to the border color.
- **Golden (G16):** sc graphgan, worsted (w_sc 0.2963, h 0.25), chart 135 × 200, `widthIn = 1` ⇒ n = 4;
  `S_top = 135`, `S_side = 169` (167 sc into 200 row ends, "about 5 sc per 6 row ends"); rounds **612, 620, 628,
  636** (2 496 sts); border yarn 4 826 in = **134.1 yd** before buffer; finished **42.0 × 52.0 in**. Row 200 is WS,
  so with the border in the last stitch's color the opening is "Turn so the RS faces you; ch 1 (does not count),
  3 sc in the last st made (top right corner)".
- **Golden (G22, start corner):** the G9 chart (W = 5, 3 rows, worsted sc graphgan, `widthIn = 0.25` ⇒ n = 1;
  `S_top = 5`, `S_side = round(3·0.25/0.2963) = 3`, `c1 = 20`). Row 3 is RS and ends in B at the top left (RH), so
  with border color B (RH) the round continues:
  ```
  Border (with B):
  Rnd 1 (RS): Do not turn; ch 1 (does not count), 3 sc in the last st made (top left corner); working down the row
    ends of the left side, 1 sc evenly spaced (about 1 sc per 3 row ends); 3 sc in the corner loop of the
    foundation ch (bottom left); sc in each free loop across to the last loop (3 sc); 3 sc in the last loop (bottom
    right corner); working up the row ends of the right side, 1 sc evenly spaced; 3 sc in the top right corner st;
    sc in each st across the top to the last st (3 sc); join with sl st in first sc. (20 sts)
  Fasten off and weave in ends.
  ```
  LH, border A (LH Row 3 ends in A at the top right): the mirror image — "3 sc in the last st made (top right
  corner); working down the row ends of the right side …; 3 sc in the corner loop of the foundation ch (bottom
  right) … (bottom left corner); working up the row ends of the left side …; 3 sc in the top left corner st; …"
  (20 sts). RH, border A: the join opening "Fasten off. With RS facing, join A with a sl st in the top right corner
  st; ch 1 (does not count), 3 sc in same st (corner); sc in each st across the top to the last st (3 sc); 3 sc in
  the top left corner st; …" (20 sts). C2C 5 × 3, RH, start BR (last tile top left): `S_top = round(5·2.6) = 13`,
  `S_side = round(3·2.6) = 8`; "Fasten off. With RS facing, join A with a sl st in the outer corner of the top right
  tile; ch 1 (does not count), 3 sc in same sp (corner); working along the tile edges across the top, 11 sc evenly
  spaced (about 11 sc per 5 tile edges); 3 sc in the outer corner of the top left tile; working down the left side,
  6 sc evenly spaced (2 sc in each tile edge); …; join with sl st in first sc. (46 sts)".

### 2.8 Yardage and materials (per color) [01 §6, 02 §6.5]

```
yards_c = (worked_c + carried_c + tails_c + extra_c) / 36 × (1 + buffer)
worked_c   sc techniques: n_c · L_sc (× 1.1 for tapestry);  hdc: n_c · 1.45 L_sc;  C2C: tiles_c · 7.76 L_sc;
           mosaic: sc_c · L_sc + X_c · 2.0 L_sc;  foundation chain + turning chains: 0.42 L_sc each, charged to the
           color that makes them
carried_c  tapestry: Σ_rows where c is carried (cells of the row not worked in c) · 1.1 · w_cell;
           graphgan short carries: gap stitches · 1.1 · w_cell
tails_c    starts_c · 2 · 6 in      (starts = strands / bobbins / C2C regions / joins; mosaic: 2 per row of c)
extra_c    border (§2.7.10), charged to the border color: border sts · L_sc + rounds · 0.92 L_sc + 12 in
buffer     0.10 single-color piece; 0.15 default; 0.20 for C2C, tapestry, or > 50 strands in total
band:      2D ±25% with default gauge, ±10% with a swatch; 3D ±20% with default gauge (Table E is calibrated for
           worsted only, §7.2 Q2), ±10% with a test ball; both ±5% after the "unravel 10 stitches = __ in"
           calibration (2D: 10 sc of the swatch; 3D: 10 sc of the test ball), which sets lscCalibratedIn
yardsLow_c, yardsHigh_c = yards_c × (1 ∓ band)
skeins_c = ceil(yardsHigh_c / skeinYards)   // buy for the high end: a second dye lot rarely matches
grams_c  = yards_c / ydPer100g × 100        (the high end printed beside it)
```

3D (amigurumi) per color: produced stitches · `L_ami` + 0.2 `L_ami` per dec + 3 in per magic ring + chain-oval
chains · 0.42 `L_ami` + floats carried inside (absent stitches inside a round · 1.1 · w) + joined rounds
(§2.11.3: one ch 1 + one sl st = 0.92 `L_ami` per joined round) + tails (6 in per closed piece for the Ultimate
Finish; the **sewing tail** of §2.10.6 per sewn piece — a closed sewn piece gets both; 2 × 6 in per color that is cut)
+ embroidery (24 in per pair of embroidered eyes, 12 in per other feature), all × the piece's make count, buffer 0.15,
band and skeins as above.

Goldens: worsted `L_sc = 1.926 in`; 1000 sc of one color with one strand (2 tails), buffer 0.15 ⇒
`(1926 + 12)/36 × 1.15 = 61.9 yd`, band ±25% ⇒ 46.4–77.4 yd, so a 364-yd skein ⇒ 1 skein; worsted C2C tile
`7.76 × 1.926 = 14.95 in`; border golden §2.7.10. 3D: the 36-st worsted sphere of §2.2.6 (468 sts, 30 decreases,
one magic ring, 2 × 6 in tails, `L_ami = 1.474`) ⇒ `(689.7 + 8.8 + 3 + 12)/36 × 1.15 = 22.8 yd` (band ±20%:
18.2–27.4 yd); v1.1's `L_ami` gave 19.7 yd.

Materials page lists, per color: code, swatch, yarn brand/line/name/number, ΔE00, stitch count and %, strands or
bobbins, yards (nominal and low–high) and meters, skeins to buy (enough for the high end, "buy from one dye lot"),
grams; then hook (US + mm, "or size needed to obtain gauge"), gauge in CYC
style (`N sc and M rows = 4" (10 cm)`, C2C `N tiles = 4"`, amigurumi `Rnds 1–6 = 2" (5 cm) diameter`), finished size
(`Approx W" (cm) wide × H" (cm) tall`, inches to ¼, cm to 0.5) and notions actually used (tapestry needle, bobbins,
stitch markers, fiberfill, safety eyes with size in mm, pins, embroidery thread).

**Skill level** [07 §1.4]: points — colors 2 / 3–4 / ≥ 5 → 0/1/2; mean changes per line ≤ 2 / 3–6 / > 6 → 0/1/2;
technique stripes / tapestry / intarsia / C2C / mosaic → 0/1/2/1/2; amigurumi pieces 1 / 2–4 / ≥ 5 → 0/1/2;
+1 each for irregular shaping and BLO/FLO. Total 0–1 Basic, 2–3 Easy, 4–5 Intermediate, ≥ 6 Complex; reasons shown.

### 2.9 Photos → 3D (R2, R3) [04]

Everything below runs in `geom.worker` (pure TS + meshoptimizer + manifold-3d WASM) and `ml.worker`
(transformers.js), returning transferable buffers. The working representation is a signed-distance volume
`f(x,y,z)` on an N³ grid, **positive inside**, in world units (inches after scaling).

#### 2.9.1 Foreground masks (always-available ladder) [04 §3]

Masks are computed at ≤ 512 px (long side); colors are sampled from the full-resolution photo.

```ts
function classicalMask(img: ImageData, o = { band: 0.04, tau: 0.14, closeR: 2, keepHoles: false }): Uint8Array {
  const f = oklabFeatures(img);
  const bg = quantize(sampleBorderBand(f, o.band), 3);        // 1–3 background clusters, deterministic
  const isBg = floodFillFromBorder(i => minDist(f[i], bg) < o.tau);   // connected background only
  let fg = keepLargestComponent(not(isBg));
  if (!o.keepHoles) fg = fillHoles(fg);
  return morphClose(morphOpen(fg, 1), o.closeR);              // then user brush +/−, re-run the last 3 steps
}
```

- Shadow heuristic: inside the bottom 25% of the mask bbox, pixels darker than the local background
  (ΔL < −0.10) with similar chroma (Δchroma < 0.06) become background.
- Optional **click to segment** (v1): SlimSAM `Xenova/slimsam-77-uniform` q8 (encoder 8.9 MB + decoder 4.9 MB,
  Apache-2.0) via transformers.js; encode once per photo, each positive/negative click runs the decoder; take the
  highest-score mask. GrabCut (OpenCV.js, 13 MB) and BiRefNet/BEN2 (WebGPU, 115–219 MB) are v1.1.
- **Never** ship `@imgly/background-removal` (AGPL-3.0) or BRIA RMBG weights (non-commercial) [04 §3.1].
- Guards: mask touching the photo border (ask for a re-shoot with margin), coverage < 15% or > 90%.

#### 2.9.2 View conventions and alignment [04 §4.2–4.3]

| Label | Camera at | image u | image v | Constrains |
|---|---|---|---|---|
| front | +Z | +X | +Y | X, Y |
| back | −Z | −X (mirror) | +Y | X, Y |
| left (object's own left) | +X | −Z | +Y | Z, Y |
| right | −X | +Z | +Y | Z, Y |
| top (object's front at photo bottom) | +Y | +X | −Z | X, Z |
| bottom | −Y | +X | +Z | X, Z |

- Orthographic assumption. Scale per view from mask bbox heights (front and side share Y); `X = front.w/front.h`,
  `Z = side.w/side.h` (world height 1). Top view: `sx = top.w/X`, `sz = top.h/Z`, scale `√(sx·sz)`; warn when
  `|sx/sz − 1| > 0.08`. Each view centered on its bbox center; opposite views mirrored.
- Per-view manual adjust: scale ±10%, offset, rotate 90°, mirror; live outline of the reprojected hull.
- Robustness: fill holes + close(2 px) on every mask; **mirrored-pair union** (front ∪ mirror(back),
  left ∪ mirror(right)); consistency check = IoU of the reprojected hull vs each mask, warn < 0.9 and highlight
  the photo. Capture tips in the UI: step back 1.5–2 m and zoom 2–3×, rotate the object 90° between shots,
  camera at mid-height, plain contrasting background.

#### 2.9.3 Volume construction [04 §4.4–4.5, §5.1]

- Per view: exact signed EDT (Felzenszwalb–Huttenlocher), inside positive, scaled to world units.
- **Hull (separable):** each axis-aligned view ignores its depth coordinate, so sample `sd_k` once per (u, v) into an
  N×N table and take the broadcast minimum over N³: `f_hull(p) = min_k sd_k(project_k(p))`.
- **Front-view rounding (multi-view only):** inflation height from the front mask
  `T(p) = √(d(p)·(2·R_loc(p) − d(p)))`, where `d` = inside EDT and `R_loc` = largest inscribed disc containing p
  (paint ridge discs in increasing radius order). With `z_c(x,y)` = midpoint of the hull's occupied z-interval:
  `f = min(f_hull, κ·T_front(x,y) − |z − z_c(x,y)|)`, κ = 1.0. Never round from side or top views (IoU 0.37) [04 §4.5].
- **Single image:** built in the **photo frame** (image u → x', v → y', toward the camera → z'):
  `f = min(sd_photo(x',y'), κ·T(x',y') − |z'|)`, κ = 0.9 default (UI slider 0.5–1.3). Then the volume is turned into
  the object frame by the view the user chose in F3 step 1 (`ReconSettings.photoView`, stored also as the photo's
  `PhotoView.label`, so Apply photo colors projects along the right axis; the §2.9.2 conventions):
  `front` identity; `left` (object's own left, camera at +X) R_y(+90°), i.e. (x', y', z') → (z', y', −x'); `right`
  R_y(−90°), (x', y', z') → (−z', y', x'); `top` (object's front at the photo bottom) R_x(−90°),
  (x', y', z') → (x', z', −y'). On the N³ grid these are exact axis permutations with flips (no resampling), applied
  before part decomposition, so naming (muzzle and tail by ±Z, §2.9.7 step 6), the center-back seam, left/right in
  assembly and eye placement all see the object's real front. The photo plane (z' = 0) becomes the object's
  symmetry plane x = 0 for side photos. A top photo shows no height, so for `top` the Yarn & size panel asks for the
  longest extent seen in the photo and the model is scaled so that extent matches (the height follows from κ).
- Resolution presets: 64 while sliders move, 128 default, 192 "High". "High" is pre-selected when
  `H / (0.8 · min(w,h)/3) > 160` (fewer than ~2 voxels per round at 128) [04 §1].

#### 2.9.4 Optional monocular depth (single image relief) [04 §5.2–5.3, §9]

- Model `onnx-community/depth-anything-v2-small` (Apache-2.0; Base/Large/Giant are non-commercial and MUST NOT be
  used) via `pipeline('depth-estimation', id, { device, dtype })` in `ml.worker`.
- Backend: WebGPU adapter present → `device: 'webgpu'`, `dtype: shader-f16 ? 'fp16' : 'fp32'`; else
  `device: 'wasm'`, `dtype: 'q8'`, 1 thread (no cross-origin isolation in v1, D20). Show estimated time.
- Weights download only on the user's click, from Hugging Face, cached by transformers.js (Cache API); call
  `navigator.storage.persist()` after the first download; when offline and not cached, the button is disabled with
  the reason. Inflation alone is the always-available fallback.
- Input: the decoded, oriented and cropped `RgbaImage` the mask was computed from (passed as a transformers.js
  `RawImage`), never the original file, so depth, mask and photo share orientation; `predicted_depth` is resized
  bilinearly to the mask size before fusion. Fusion runs in the photo frame, before the view rotation of §2.9.3.
- Verified only by the manual release gate 4 (§6.5) and `e2e/tracks/t3-depth.spec.ts` (runs when the weights are
  cached, §6.3 T3); unit tests use a tiny Identity ONNX model and synthetic affine depth.
- Output is relative inverse depth (bigger = nearer, unknown scale/shift). Fusion:

```ts
const D1 = robustNormalize(D, M, 0.02, 0.98);                  // percentiles inside the mask
const inner = M && d >= 3;                                      // ignore rim pixels
const [a, b] = leastSquares(D1[inner], kappa * T[inner]);       // scale/shift from the inflation prior
zFront[p] = w(p) * (a * D1[p] + b) + (1 - w(p)) * kappa * T[p]; // w = smoothstep(2, 14, d[p]) px
zBack[p]  = backShape === 'mirror' ? -zFront[p] : -kappa * T[p];
f(x,y,z)  = min(sd(x,y), zFront(x,y) - z, z - zBack(x,y));
```

Back **shape** (`ReconSettings.backShape`): mirror the front depth (default) or inflate. Back **colors** are a separate
choice (`backColors`, §2.9.6). Adding a back photo turns the project into a two-view hull (F2).

#### 2.9.5 Meshing, smoothing, validation [04 §6]

1. `cleanVolume`: keep the largest 6-connected inside component; fill enclosed cavities (flood the outside from
   the border); optional morphological closing (`mergeTouching`, the build panel's "Merge touching parts", off by
   default).
2. **Marching cubes** (our own, indexed): tables from `three/addons/objects/MarchingCubes.js` (`edgeTable`,
   `triTable`); one vertex per edge keyed `(axis, lowerCornerIndex)` so the mesh is watertight without welding;
   clamp `t = (iso − f0)/(f1 − f0)` to `[0.01, 0.99]`; replace exact zeros by 1e-6; process two z-slices at a time.
3. **Taubin** smoothing: 10 pairs, λ = 0.6307, μ = −0.6732 (no plain Laplacian: it shrinks).
4. Decimate at most 3× with meshoptimizer `simplify` + `Regularize`; target edge ≈ `min(w, h)/3`.
5. Validate with manifold-3d: status `NoError`, `decompose()` → keep the largest part, `genus() === 0` (or the user
   accepted a handle via "keep holes"), volume > 0; features thinner than 2 voxels flagged "crochet flat".
6. Output `ColoredMesh` in inches: lowest point y = 0, +Y up, front +Z, scaled to the target height.

#### 2.9.6 Colors from photos onto the mesh (R8) [04 §4.8, 06 §9]

- **Joint palette:** quantize the masked pixels of all views together with the shading-robust feature (§2.4.1),
  auto-K ≤ 8, then label images per view (Int8, −1 outside the mask).
- **Per vertex:** among views where the vertex is visible (its depth within 2.5 voxels of the view's first-hit depth
  map, computed by scanning the SDF along the view axis) and the pixel is inside the mask eroded by 2 px, take the
  view maximizing `(n·c_k)²` and read its label. Unlabeled vertices seen by no view: multi-view — BFS from labeled
  neighbors; single image — filled per part **after** part decomposition (§2.9.7 step 7) by `backColors` (default
  `'part'` for front and top photos, `'mirror'` for left/right side photos, whose unseen side is the object's other
  side):
  - `'part'`: every unseen vertex of a part takes that part's dominant photo label, computed **excluding protected
    components**;
  - `'mirror'`: the label of the mirror point across the photo plane (photo frame z' → −z'; after a side-view turn
    that is x → −x, for a front photo z → 2·z_c − z);
  - `'solid'`: `solidColor`; `'photo'`: a back photo was added (two-view mode, nothing to fill).
  - **Protected components**: connected photo-label components that the salience guard (§2.4.3) marks, that the
    eye/nose/mouth rules of §2.10.1 would classify, or whose area is below 6 stitches (`6·wS·hS`). With
    `ReconSettings.oneSidedDetail` on (default for front and top photos) they are never copied to the unseen side:
    in `'part'` they are excluded from the dominant label, in `'mirror'` their mirrored area takes the surrounding
    label. With it off (default for side photos) `'mirror'` copies them too, so a side-profile animal gets both
    eyes; the toggle is the "One-sided detail" checkbox of F3 (a logo on one side of a car keeps it on).
- **Persisted for later re-projection:** the build stores, per view, the label image as an asset
  (`PhotoView.labelsKey`; mime `application/x-cpg-labels`: bytes 0–3 `CPGL`, u16 LE version 1, u16 reserved, u32 LE
  w, u32 LE h, then w·h Int8 labels row-major, −1 outside the mask), the mask (`maskKey`), the alignment, and once
  per project the joint palette `ProjectDoc.threeD.photoPalette` (label index → `{ hex, name? }`). Labels index this
  photo palette, never `model.palette`, which Claude Design or the user may change. Apply photo colors reads only
  these stored assets, so it works after a reload, a `.crochet.json` round trip, or a Claude Design import days
  later.
- **Apply photo colors** (`GeomApi.projectColors`, T3; offered after a Claude Design import into a project with
  labeled views, and from the Paint tool): (1) tessellate the current model with `buildModel(model, 1)` (mesh parts:
  their mesh assets); (2) per view, render the model's orthographic silhouette along the view axis and fit it to the
  stored mask by a uniform scale and a 2D offset maximizing IoU (start from bbox-height matching and bbox centers;
  coarse-to-fine search scale ±10% in 1% steps, offset ±5% in 0.5% steps; deterministic); (3) run the per-vertex vote
  above with the stored label images, using the union of the analytic part SDFs (§3.7.6) for visibility; (4) map
  each photo label to a model palette id through `photoPalette`: the existing model color with the smallest ΔE00
  when it is < 5, else a new palette entry (`name` from the photo palette); write the result as `paint`
  (primitives: each vertex splats its palette index into the uv64 cell `(u, v)`, majority per cell, empty cells
  filled by BFS; mesh parts: vertex labels); (5) commit as a new authored model revision "Applied photo colors".
  Views whose best IoU is < 0.8 are skipped with a warning; if a view's `labelsKey` asset or the `photoPalette` is
  missing, the joint-palette step above is re-run from the stored photos and masks first (and its result stored).

#### 2.9.7 Parts and fitting into the canonical model [04 §6.6, 03 §6.1, 05 §7.5]

1. **Decompose:** body = morphological opening of the volume with a ball of radius `openingFrac × height`
   (`ReconSettings.openingFrac`, default 0.12; the build panel's Advanced "Limb detection" slider 0.06–0.20); limbs =
   connected components of `volume − body` larger than 0.4% of the volume. The opening keeps the head inside
   "body" (two inscribed balls meet through the neck), hence step 2. Merged adjacent legs remain a known miss, fixed
   with the editor's cut tool (§4); over-segmentation (a belly bump as `part_3`, a bird the user wants in one piece)
   is fixed with the editor's Merge tool (§2.9.8) or by turning off "Split head at the neck" before building.
2. **Neck split** (`ReconSettings.splitNeck`, default on, the build panel's "Split head at the neck"): compute the
   body part's 24 rings along its PCA axis (the
   same rings as the fit, step 4; mean ring radius `r_i`). If an interior ring has
   `r_i < 0.75 × min(max(r_0…r_{i−1}), max(r_{i+1}…r_23))` and both sides hold ≥ 15% of the part's volume, cut the part
   with the plane perpendicular to the axis at ring i (the §2.9.8 plane cut; the deepest qualifying minimum wins):
   the piece with the higher centroid becomes the head, attached to the other.
   Teddy: the neck rings measure ≈ 0.6–1.0 in (depending on where the rings fall) against ≈ 2.0 in (body) and
   ≈ 2.3 in (head), and each side holds about half the volume ⇒ split.
3. Each part becomes its own watertight mesh (SDF restricted to the part's voxel region, re-meshed). The part's SDF
   volume (Int16, voxel/256 units, cropped to its bbox + 2 voxels) is stored as an asset `sdf:<meshRef>` so the mesh
   tools never re-voxelize an unedited reconstructed part (§2.9.8).
4. **Fit** per part: PCA axis (area-weighted covariance), 24 rings along the axis (mean radius, radial variance).
   Candidates: `flat` (smallest extent < 25% of the largest; outline = oval if it fits within 12%, else polygon
   ≤ 32 points), `sphere`, `ellipsoid`, `capsule`, `cylinder`, `cone`, `lathe` (ring radii as profile). Score =
   RMS radial error / mean radius; prefer the simpler type when within 0.02 of the best; accept if ≤ 0.12,
   otherwise keep a `mesh` part (handled by Path B, §2.10.7).
5. **Attach tree and pairs:** `inferAttach` and `inferMirrorPairs` (§3.7.6) — the same Step 0 kernels the importer
   runs, with mesh parts' SDFs taken from their stored volumes; mirror tolerance 10% for reconstructions.
6. **Names** (`nameParts`, Step 0 kernel `core/model/naming.ts`, shared with the importer's geometry-only path,
   §3.7.5; template ids by geometry, so the Q&A, the seed and Claude Design see familiar parts): the root is
   `body` and the neck-split upper piece `head`; among mirror pairs attached to `body`, the pair reaching the lowest
   15% of the model height is `leg_l`/`leg_r` and the next pairs by height `arm_l`/`arm_r`, then `limb2_l`/`limb2_r`, …;
   pairs on `head` above its center are `ear_l`/`ear_r`; a single child in front of the head (center z > head
   center + ¼ head depth) is `muzzle`; a single child behind the body (center z < body center − ¼ body depth) is
   `tail`; everything else `part_1`, `part_2`, … by decreasing volume. `_l` is the member with x > 0. Ids the user
   has renamed are never changed again.
7. **Colors:** part base color = dominant vertex label; vertex labels become the part's paint field (§2.11.1);
   single-image back colors are filled now (§2.9.6); clean whole-round color boundaries become `band`/`stripes`
   regions.
8. Result: a `crochet-model` (§3.5) with `source.stage: 'recon'`, inches, grounded, scaled to the target height,
   with one attach tree.

#### 2.9.8 Mesh tools used by the editor (sculpt, cut, convert, fit)

- `voxelizeMesh(mesh, N = 96)` — **narrow-band** voxelizer (a closest-point query per voxel measured 12 µs, i.e.
  10.8 s at N = 96, 5× over budget): (1) for each triangle, visit the voxels of its bbox grown by 2 voxels and keep
  the minimum exact point–triangle distance (triangle–box overlap prefilter), giving exact distances in a band of
  ±2 voxels; (2) sign by scanline parity: one ray along +z per (x, y) column center (N² rays, column centers offset by
  1e-4 voxel so rays miss edges deterministically), crossings from the triangles covering that column, sorted, and
  voxels between odd and even crossings are inside; (3) fill the far field with the Step 0 3D Felzenszwalb EDT seeded
  from the band, separately inside and outside; `f` = signed distance, positive inside. Budget: N = 96, 40k
  triangles ≤ 400 ms (T5 perf test). Reconstructed mesh parts reuse their stored `sdf:<meshRef>` volume (§2.9.7)
  until they are sculpted or cut.
- Brushes on the part SDF inside a sphere of radius R (inches), falloff `φ = smoothstep(1, 0, dist/R)`, strength k:
  **inflate** `f += k·φ·voxel`; **deflate** `f −= k·φ·voxel`; **smooth** `f ← lerp(f, box3(f), k·φ)`;
  **flatten** `f ← lerp(f, min(f, −dist_P), k·φ)` with plane P through the brush center, normal = mean surface normal
  under the brush.
- During a stroke re-mesh at ≤ 10 Hz (MC + 3 Taubin pairs); on stroke end MC + 10 pairs; vertex labels transferred
  by nearest vertex (BVH). Undo stores sparse voxel diffs per stroke.
- **Plane cut:** `f_a = min(f, −plane)`, `f_b = min(f, plane)` → two parts `<id>_a`, `<id>_b`, b attached to a.
- **Merge** (`MeshApi.merge`, the editor's ⌘J): sample every selected part's SDF on one grid over the union of their
  world bboxes + 2 voxels (N = 96 on the longest side): analytic SDFs (§3.7.6) for primitives, stored `sdf:<meshRef>`
  volumes for unedited reconstructed parts, the narrow-band voxelizer for other mesh parts; union
  `f = max(f_a, f_b, …)` (positive inside); then the usual pipeline (MC → 10 Taubin pairs → validate, §2.9.5) gives
  one watertight `mesh` part, whose SDF is stored as its `sdf:` asset. In the model (T6's pure `mergeParts` recipe;
  the worker only builds geometry and labels) the merged part keeps the id, `attach`, `crochet` hints and name of the
  selected part **nearest the root** (ties → larger volume), so merging the teddy's head (47.6 in³) into its body
  (43.5 in³) keeps the root `body`; every child of a merged part re-attaches to it, so the model stays one tree.
  Vertex labels come from the nearest vertex of the source parts' colored meshes (primitives
  tessellated by `buildModel` with their paint/regions evaluated per vertex), so both paints survive. Requires ≥ 2
  parts that touch or overlap (gap ≤ 0.1 in; otherwise "these parts do not touch"). The UI then offers **Fit
  primitive** (§2.9.7 step 4) for the result.
- **Convert primitive → mesh:** tessellate with `buildModel` geometry → voxelize → MC. **Fit primitive** (mesh →
  primitive/lathe) reuses §2.9.7 step 4.

Budget (M3 Pro, single thread, N = 128): carve 38 ms, rounding 61 ms, cleanup 65 ms, MC 91 ms, Taubin 33 ms,
decimate + validate 40 ms, labels 77 ms ⇒ ≈ 0.55 s geometry; depth 0.8 s (WASM 4 threads, not used in v1) /
2.5 s (1 thread) / < 0.3 s (WebGPU) [04 §9.6].

### 2.10 3D shape → amigurumi pattern [03, 07 §6]

`generateAmigurumi(model, gauge, settings) → AmiResult` runs in `ami.worker` (Path B parts call a private
`mesh.worker` that `ami.worker` spawns itself, passed in as `deps.pathB`; §5.4).

```
model (one attach tree, §3.7.6) ─► frames for every part, root first (axis, start pole, seam, §2.10.2)
      ─► plan (make-as per part, §2.10.1) ─► trim to the visible portion (§2.10.3) ─► profile (§2.10.4)
      ─► counts: Path A (§2.10.5–2.10.6) | Path B (§2.10.7) ─► loops (BLO) ─► ops (§2.10.8)
      ─► stitch colors (§2.11) ─► cues (safety eyes, stuffing; §2.10.6) ─► Line[] ─► encodeOps
      ─► validate (§2.13) ─► assembly (§2.12) ─► yardage (§2.8) ─► rings + pattern ghost (§2.10.10)
```

`generateAmigurumi` refuses (error `E_ASSEMBLY`) a model whose attach graph is not one tree; models from every
source reach it through `inferAttach`, and the editor's Attach tool re-parents but never detaches, so this fires
only for documents edited outside the app (the error offers "Re-infer attachments").

#### 2.10.1 Plan: how each part is made

Planning runs after the attach tree exists (§3.7.6) and after every part's frame (§2.10.2) is known, root first,
because rule 3 looks at the parent's start pole. `part.crochet.make` (user choice in the editor) wins; `'auto'`
applies these rules in order. Extents are the part's local bbox extents sorted `e₁ ≤ e₂ ≤ e₃`; **flatness** =
`e₁ / e₂`, i.e. how flat the cross-section is, independent of length: a long round arm (1.1 × 3.0 × 1.1) has
flatness 1.0, a disc ear (1.7 × 1.7 × 0.7) 0.41. (v1.1 divided by `e₃`, which made every long round part look
flat: the teddy arms (0.37) would have been unstuffed against G17, template standing-quadruped legs (0.12H × 0.3H,
0.40) worked flat so the toy could not stand, slim stubby feet under a bottom-up body turned into a start band, and a
thin tail lying along the body into an appliqué.)

| # | Rule | Result |
|---|---|---|
| 1 | id/label contains `eye`, or a sphere/ellipsoid ≤ 0.6 in across with OKLab L < 0.25 attached to another part | `safety_eye` feature: size = nearest of 6, 8, 9, 10, 12, 15 mm to its diameter; `audience: 'under3'` ⇒ embroidered eye |
| 2 | largest axis-aligned cross-section circumference < 12·wS | `embroidery` (nose, mouth); option "crochet a tiny piece" |
| 3 | **start-cap cover:** flatness < 0.4; its thin axis within 30° of the parent's axis; its center within `e₁` of the parent surface and, projected onto the parent's profile, within the first 25% of that profile measured from the parent's start pole; and its **footprint lies inside the parent's silhouette there**: every builder vertex of the cover, projected onto the plane perpendicular to the parent's axis, is within `1.1·r_max + 0.5·wS` of that axis, `r_max` = the parent profile's largest radius over the cover's axial span | `region` on the parent: a start-color band in the cover's color from s = 0 to the arc where the cover's rim meets the parent (profile rings ≥ 50% inside the cover, sampled as in §2.10.3) |
| 4 | **thin:** flatness < 0.25 and center within 0.15 in of the parent surface | `applique` (flat piece sewn on) |
| 5 | everything else | `piece` (crocheted, stuffed per `stuffing`) |

A non-root parent always starts at its free tip (§2.10.2), so rule 3 catches pads, soles and caps on free ends; a
root starts at its bottom, so a cover on top of a root body falls through to rules 4–5, and feet that stick out past
the body's silhouette never become a band.

**Default stuffing** for parts without `stuffing`: flatness < 0.45 ⇒ `none` (worked and pressed flat), **never for
the root**; a trimmed "cup" (crocheted length < 1.5 × its opening diameter) ⇒ `light`; otherwise
`AmiSettings.defaultStuffing` (default `firm`). `flat` parts and appliqués are never stuffed. Template check:
standing-quadruped legs (r 0.06H, length 0.3H) have flatness 1.0 ⇒ `firm`.

`mirrorOf` pairs with mirrored geometry (dims equal, x mirrored) become one piece "make 2"; otherwise two pieces.

**Teddy fixture plan** (normative T4 golden; after dialect normalization, `inferAttach` and `inferMirrorPairs`;
worsted, Table E; all numbers machine-computed from the fixture with the analytic SDFs):

| Part | Parent | Make as (rule) | Axis / start pole | Buried (§2.10.3) → end | Stuffing |
|---|---|---|---|---|---|
| body | — (root) | piece (5) | Y, longest semi-axis / bottom | — → closed | firm |
| head | body (inferred) | piece (5) | Y, protrusion / top | 7% → closed | firm |
| muzzle | head | piece (5) | Z, protrusion / front tip | 54% → open | light (cup) |
| nose | muzzle | embroidery (2: 1.71 in < 12·wS = 2.46 in) | — | — | — |
| eye_l, eye_r | head | safety_eye 10 mm (1: name; 0.40 in) | — | — | — |
| ear_l, ear_r | head | piece (5), make 2 | Y, protrusion / tip | 40% → open | none (flatness 0.7/1.7 = 0.41) |
| ear_l_inner, ear_r_inner | ear_l / ear_r | applique (4: flatness 0.24/1.1 = 0.22; normal 90° to the ear axis, so not rule 3) | — | — | — |
| arm_l, arm_r | body (inferred) | piece (5), make 2 | Y / hand | 0% (side contact) → closed | firm (flatness 1.1/1.1 = 1.0) |
| leg_l, leg_r | body (inferred) | piece (5), make 2 | Y / foot | 38% → open at the hip | firm (flatness 1.0) |
| foot_pad_l, foot_pad_r | leg_l / leg_r | region (3: flatness 0.36/1.0 = 0.36; on the leg's start cap, axis angle 0°; footprint 0.50 in ≤ 1.1·0.62 + 0.10 = 0.78 in): cream band ≈ Rnds 1–3 of each leg | — | — | — |
| tail | body (inferred) | piece (5) | Z, protrusion / back | 38% → open | light (cup) |

Piece list: Body, Head, Muzzle, Ear (make 2), Inner ear (appliqué, make 2), Arm (make 2), Leg (make 2), Tail =
**8 piece sections**; without "make 2" grouping **12 crocheted items** (10 worked in the round + 2 appliqués);
notions: 2 × 10 mm safety eyes; embroidery: nose.

#### 2.10.2 Piece frame: axis, start pole, seam

- **Axis â**, first match: (1) `crochet.axis` if set; (2) an attached sphere or ellipsoid (a protrusion) uses its
  local axis closest to the direction from the parent's center to its own center (§0.1; a muzzle is worked from
  its tip toward the face; the teddy head, ears and tail resolve to Y, Y and Z); (3) an unattached ellipsoid uses its
  **longest** semi-axis (ties → Y, then X), so an ellipsoid lying along Z (sea, insect templates) is worked along Z
  and its cross-section is the two shorter radii; (4) otherwise the primitive's local Y (torus: the ring).
- **Cross-section:** the two radii perpendicular to â, `a ≥ b`. If `a/b > 1.15` at the widest ring the piece is an
  **oval** piece. Per round k, `S_k = round(2(a_k − b_k)/wS)` from the local cross-section at `s_k` (it shrinks
  toward the poles of an ellipsoid; it is constant for a `box`), clamped so `|S_k − S_{k−1}| ≤ 1`; the round count is
  the circular count of the minor radius plus `2·S_k` (§2.10.5). Side-length changes are placed at the middle of each
  straight side, circular changes at the two oval ends (segment hints, §2.6.1). A piece whose first round has
  `S_1 ≥ 1` starts with a chain oval (§2.10.6), otherwise with a magic ring.
- **Start pole:** `crochet.start` if set (`'bottom'`/`'top'` = the −â/+â pole); else the end opposite an explicit
  open end (`attach.openEnd`: `'top'` = +â pole); else the root part starts at its lowest pole (world y); else the
  pole lying farther outside the parent (the pole point with the lower parent SDF, i.e. tip first; the buried end
  then becomes the trimmed open end, §2.10.3). Frames are computed root first.
- **Seam/marker:** center back = −Z projected perpendicular to â; if â is within 30° of ±Z use −Y.

#### 2.10.3 Trim to the visible portion

Claude Design and our seeds overlap sewn parts (the teddy's muzzle is ~70% inside the head by volume). For every
non-root piece (after `inferAttach` every non-root part has a parent), walk its profile from the start pole in steps
of `hS/4`, sampling 16 azimuths; `s_cut` = the first arc position where ≥ 50% of the samples are inside the parent
(analytic SDF per primitive, §3.7.6; voxel SDF for meshes). If the buried length `L − s_cut` ≥ 10% of the profile,
the profile ends at `s_cut` with an **open end** sewn to the parent; otherwise the piece is closed and sewn by
contact. Teddy results: table in §2.10.1 (legs, ears, muzzle and tail open; head and arms closed).

#### 2.10.4 Profiles (part-local, arc length s from the start pole) [03 §5]

| Type | Profile r(s) |
|---|---|
| `sphere` r | semicircle of radius r |
| `ellipsoid` rx, ry, rz | meridian of the ellipse (polar semi-axis along â, equatorial = minor cross-section radius b) + oval `2·S_k` if a/b > 1.15 (`S_k` shrinks to 0 at the poles) |
| `capsule` r, length (total) | quarter circle, straight wall `length − 2r`, quarter circle |
| `cylinder` rTop, rBottom, h, open | bottom disc (unless open), slanted wall, top disc (unless open) |
| `cone` r, h | apex → slant → base disc |
| `lathe` profile `[r, y]` | the polyline (start end chosen by §2.10.2); `sharp` indices or turn ≥ 45° mark corners |
| `torus` R, r, arcDeg | 360°: chain ring at the hole `n₀ = round(2π(R − r)/wS)`, `K = round(2πr/hS)` rounds, `n_k = round(2π(R − r·cos(2πk/K))/wS)`, seam last round to the first. arcDeg < 360: capsule of length `R·arc + 2r`, note "shape into a curl" |
| `box` w, h, d | rounded box: chain-oval base (constant `S` from w vs d; b = half the shorter side), BLO, straight walls, BLO, decreasing top, closed-oval finish (§2.10.6) |
| `flat` | §2.10.9 |
| `mesh` | lathe fit if residual ≤ 0.12, else Path B (§2.10.7) |

#### 2.10.5 Path A: counts from a profile (normative)

```ts
const wS = w * s, hS = h * s;                    // s = 1.05 firm/medium stuffing, 1.0 light/none
const N = Math.max(2, Math.round(L / hS)), hEff = L / N;          // L = profile length after trimming (§2.10.3)
const ks = closedFarEnd ? range(1, N - 1) : range(1, N);          // gather-close vs open edge
const ideal = ks.map(k => 2 * Math.PI * r(k * hEff) / wS);        // circular part (minor radius b for ovals)
const round1 = (x: number[]) => style === 'exact' ? hysteresis(x, 0.75)
                                                 : batchCounts(x, Math.max(...x) < 18 ? 4 : 6, /* p0 */ 6);
// symmetric profile (r(s) ≈ r(L − s) within 1%): round the first ceil(m/2) values, then n[k] = n[m+1−k]
let n = symmetricProfile ? mirrorHalf(ideal, round1) : round1(ideal);
n = clampPoles(n, ideal, { start, closedFarEnd, style, oval });   // pole rule below (normative, Path A and B)
n = clampFan(n);                                                  // n_k ∈ [ceil(n_{k−1}/2), 2·n_{k−1}]
if (oval) n = n.map((c, i) => c + 2 * S[i]);                      // S_k from §2.10.2; chain oval: c_1 = 6
// hysteresis(x, band): n_1 = Math.round(x_1); then keep the previous count unless |x_k − prev| > band,
//   else Math.round(x_k)                                     (Math.round = JS half-up rounding everywhere)
// batchCounts(x, sym, p0 = 6): p starts at p0, the count "before" round 1; for each x_k choose among
//   {p − sym, p, p + sym} (only values ≥ sym) the nearest to x_k, ties keep p; the choice becomes p
```

**Pole rule** (`clampPoles`, normative for every closed pole in both paths; replaces the unspecified "apex rule"):
- **Magic-ring start:** style `classic`: `n₁ = 6` (the textbook "6 sc in MR", whatever `ideal₁` is); style `exact`
  and Path B: `n₁ = clamp(round(ideal₁), 5, 8)` (`[4, 8]` for flattened pieces); then for k = 2, 3, … while
  `ideal_k < n₁`: `n_k = max(n_k, n_{k−1})` — a widening shape never decreases next to its start.
- **Chain-oval start:** the circular part of round 1 is 6 (`n₁ = 2·S₁ + 6`, §2.10.6). **Chain-ring start** (open
  start, e.g. torus): no clamp.
- **Closed far end:** walking backwards from the last round down to the round with the largest count,
  `n_k = max(n_k, n_{k+1}, 5)` (never past the peak); then drop trailing rounds equal to their predecessor (the piece
  closes one round early; R11 accepts the ≤ 1.5·hS loss at the tip).
- **Oval pieces:** the rules apply to the circular part (the count without `2·S_k`); its closed-end minimum is 6
  and a closed far end ends with the circular part exactly 6, so the last round is `2·S + 6` — closed-oval finish
  when `S ≥ 2`, gather (≤ 8 sts) when `S ≤ 1` (§2.10.6).
- Open far ends (trimmed or `openEnd`) are not clamped.

**Classic sphere and capsule** (style `classic`, the default; circular cross-section) use the textbook generator,
which crocheters expect, **only for an untrimmed piece with both ends closed**:

```
k = max(1, round(2πr / (6·wS)));  r_eff = 6k·wS / (2π)
A = π·r_eff (sphere)  |  (length − 2r) + π·r_eff (capsule)
T = max(2k − 1, round(A / hS) − 1);  wall = T − (2k − 1)
counts = [6, 12, …, 6k] ++ [6k] × wall ++ [6(k−1), …, 12, 6]      // sphere: wall = round(3k·w/h) − 2k
```

For a **trimmed** sphere/capsule or one with `attach.openEnd`: the increase phase `[6, …, 6k]`, then `[6k]` plain
rounds up to round `R_end = round(s_end / hS)`, **no decrease phase**, finish "open" (§2.10.6). `s_end = s_cut` when
trimmed; for an untrimmed open end it is where the far cap begins: `π·r_eff/2` (sphere → a hemisphere cup) or
`π·r_eff/2 + (length − 2r)` (capsule). If `R_end < k` the increase phase stops at `R_end`. Every other primitive and
every oval uses the generic path above.

**BLO / FLO:** for a corner at arc `s_c`, the first round with `s_k ≥ s_c + 0.5·hEff` is worked in back loops only
(FLO for concave corners). In a BLO/FLO round every op carries the loop, and **decreases render as `sc2tog` through
the stated loops** ("BLO sc2tog", defined under Special stitches), never as invdec, which uses the front loops.
**Jogless prep** in spiral pieces [07 §6.8]: the last stitch of the round before a BLO/FLO round is replaced by a sl st
(counts unchanged). It must be a plain sc: if that round's placement ends with a special, rotate it left by the
smallest m ≥ 1 whose new last op is a plain sc and that still satisfies R8 against the round before (R8 as scoped in
§2.13: whole rounds, or the side segments of an oval round); if no rotation qualifies (e.g. `inc in each st
around`), skip the trick and print the jog note instead. An **oval** round rotates only inside its last segment
(segment boundaries stay where the oval geometry puts them, §2.10.2), so the trick is skipped only when that segment
has no plain sc.
**Feasibility:** `T > 2P` needs `inc3` (or an inserted round), `T < P/2` needs `dec3`; both raise `W_FAN3`.

Goldens (w = h = 0.2 in, s = 1 unless stated). Every count list below was reproduced on 2026-10-01 by a reference
implementation of exactly the pseudocode above (`hysteresis`, `batchCounts` with p0 = 6, `mirrorHalf`, `clampPoles`,
`clampFan`, `S_k`). T4 generates its golden files from its own implementation and compares them with these lists; a
mismatch is reported under "Requests for integration" with both outputs and is never resolved by editing a golden
by hand. A property test checks that every symmetric profile gives symmetric counts (and symmetric `S_k` for ovals).
- Textbook sphere k = 6, w/h = 1.0 → `6 12 18 24 30 36 36 36 36 36 36 36 30 24 18 12 6` (17 rounds); with
  worsted defaults (w/h = 1.05) the plain rounds become 7 (18 rounds).
- Lathe semicircle r = 1.5 (N = 24, 23 rounds), exact → `6 12 18 24 29 33 37 41 44 46 46 47 46 46 44 41 37 33 29 24 18 12 6`;
  classic → `6 12 18 24 30 36 36 42 42 48 48 48 48 48 42 42 36 36 30 24 18 12 6`.
- Cone r = 1, h = 3, open base (`openEnd: 'bottom'`; ideals `1.96, 3.93, 5.89, …, 31.42`, N = 16), classic →
  `6 6 6 6 12 12 12 18 18 18 24 24 24 30 30 30` (6 increases every 3rd round; `batchCounts` from p0 = 6 keeps 6 until
  the ideal passes 9, and the classic pole rule keeps the MR at 6 — with v1.1's `clamp(round(1.96), 5, 8)` the first
  round would have been 5); **exact** → `5 5 6 8 10 12 14 16 18 20 22 24 26 27 29 31` (hysteresis gives
  `2 4 6 8 …`; the pole rule sets n₁ = 5 and lifts n₂ to 5).
- Horn: cone r = 0.6, h = 1.8 worked from the base (`crochet.start: 'bottom'`, closed base disc), exact →
  `7 13 19 17 14 12 10 8 6 5`, then close (raw tail `… 6 4 2` → `… 6 5 5` → trailing duplicate dropped);
  BLO on Rnd 4, written `BLO (…, sc2tog) …`.
- Closed cylinder ⌀1.5 × 2 → `6 12 18 24 | 24 ×10 | 18 12 6` (17 rounds), BLO on rounds 5 and 15; exact text:
  ```
  Rnd 4: sc, (inc, 2 sc) x 5, inc, sl st (24)
  Rnd 5: BLO sc in each st around (24)
  Rnds 6–13 (8 rnds): sc in each st around (24)
  Rnd 14: 23 sc, sl st (24)
  Rnd 15: BLO (2 sc, sc2tog) x 6 (18)
  ```
  (Rnd 4's ops are `(sc, inc, sc) × 5, sc, inc, sl st`; the encoder prints their shortest form.)
- Open capsule — the §3.6 `arm_l` (r 0.32, length 1.4, `openEnd: 'top'`, light, worsted: wS 0.195, hS 0.186;
  untrimmed against the body): k = 2, `s_end = 0.585 + 0.76 = 1.345 in` ⇒ R_end = 7 ⇒ `6 12 12 12 12 12 12`
  (`6, 12, 12×5`), open with 12 sts: "Fasten off, leaving a 14" (35 cm) tail for sewing." The closed textbook capsule
  would be `6 12 12×6 6`.
- Closed oval — `box` w 2, d 1, h 1.5, exact: S = 5, ch 8; counts `16 22 26 26 26 26 26 26 26 26 22 16` (N = 13,
  12 rounds); BLO on Rnds 4 and 11 (Rnd 11 is a BLO sc2tog round); finish "Flatten … sc through both layers across
  (8 sc)" (§2.10.6).
- Oval ellipsoid rx 1.2, ry 0.6, rz 2.0 (unattached, exact): â = Z (longest), cross-section a = 1.2, b = 0.6,
  N = 22 (21 rounds); `S_k = 2 3 4 4 5 5 6 6 6 6 6 6 6 6 6 5 5 4 4 3 2` (never above `round(2·0.6/wS) = 6`, |ΔS| ≤ 1);
  the profile is symmetric (circular ideals `5.47 9.09 11.67 13.63 15.16 16.36 17.29 17.99 18.47 18.76 18.85 …`
  mirrored), so `mirrorHalf` applies; ch 5 start; counts
  `10 15 20 22 25 26 29 30 30 31 31 31 30 30 29 26 25 22 20 15 10` (circular part
  `6 9 12 14 15 16 17 18 18 19 19 19 18 18 17 16 15 14 12 9 6`); closed-oval finish across 5 sts. (v1.1 listed
  `… 31 31 31 31 30 30 26 …`, the unmirrored hysteresis output, which the normative `mirrorHalf` cannot produce.
  Before v1.1 the axis was local Y and the piece opened at 2S + 6 with no valid finish.)

#### 2.10.6 Starts and finishes

- Magic ring: `Rnd 1: 6 sc in MR (6)` (n₁ from counts). **Chain oval** with straight side `S = S₁` (§2.10.2): ch
  `N = S + 3`, i.e. `S = N − 3` sts along each side: `Ch N. Rnd 1: sc in 2nd ch from hook, sc in next N−3 ch, 3 sc
  in last ch; working along the other side of the chain, sc in next N−3 ch, 2 sc in last ch (2N)`, so
  `n₁ = 2N = 2S + 6` (3 sts at each end — the circular count 6 plus the two sides). Later rounds add the circular
  growth at the two ends (3 + 3 per +6) and one stitch at the middle of each side when `S` grows [07 §6.9]; segment
  hints keep ends and sides readable. G8: ch 10 ⇒ S = 7 ⇒ 20, 26, 32.
- **Closed end, circular:** last round ≤ 8 (≤ 6 preferred), never < 4, then "Fasten off, leaving a 6" (15 cm) tail;
  close with the Ultimate Finish (thread the tail through the front loops of the last sts and pull tight)".
- **Closed end, oval (`S ≥ 2`):** the circular part decreases at the two ends down to 6, so the last round is
  `2S + 6`; then "Flatten the opening so its two sides ({S+3} sts each) line up; working through both layers, sc
  across ({S+3} sc). Fasten off." (preference: "whipstitch the opening closed"). R9 accepts this finish.
- **Open end:** "Fasten off, leaving a {T}" ({T_cm} cm) tail for sewing."
- **Sewing tail** `T = max(12 in, 3 × seam + 6 in)` (a whipstitch uses 2.5–3× the seam length, plus 6 in to
  handle and weave in): `seam = open-edge sts × wS` for an open piece; for a closed piece with `attach.method:
  'sewn'`, `seam = π·d`, d = the largest distance between two of the piece's §2.10.3 ring samples that lie inside
  the parent (at least 4·wS). Printed rounded up to the next 2 in; cm = that × 2.54 rounded to 5 cm. A closed sewn
  piece prints "Fasten off, leaving a {6 + T}" tail; close with the Ultimate Finish and keep the rest of the tail to
  sew the piece on." Examples (worsted): 12-st arm opening → 14" (35 cm); 36-st opening → 30" (75 cm). Yardage uses
  the same lengths (§2.8).
- **Cues inside a piece**, printed after the named round in this order:
  0. **Front marker** (pieces that host eyes, features, patches or other pieces): after the piece's reference round
     `r_ref` (§2.11.2): "Place a second marker at center front, between sts {n/2} and {n/2 + 1} of Rnd {r_ref}, and
     leave it there; later steps measure from it." Every stitch number in the piece is computed in the frame that
     makes this true (spiral lean, §2.11.2).
  1. **Safety eyes** (and any post-and-washer notion) whose host is this piece: right after round `rA + 1` when the
     eyes go between Rnds `rA` and `rA + 1`: "Insert the 10 mm safety eyes between Rnds 10 and 11: posts in the
     gaps after st 15 and after st 21 (6 sts between, centered between sts 18 and 19). Fix the washers now." If
     that round's circumference `n·wS < 3 in`, raise `W_EYE_OPENING` (the washer may not pass; suggest embroidered
     eyes). Assembly keeps only a cross-reference (§2.12).
  2. **Stuffing** (closed pieces; open pieces are stuffed in their assembly step, §2.12): "Begin stuffing after Rnd
     {s}; stuff firmly as you go" (firm/medium) with `s = max(first decrease round + 1, rA + 1)`, eyes first when
     equal / "Stuff lightly before closing" (light) / nothing (none).
  3. The closing round and its finish.
  `E_EYE_ORDER` checks that every eye cue precedes both the stuffing cue and the closing round of its host piece.

#### 2.10.7 Path B: general mesh parts [03 §2.2, §6.2, §6.6]

1. Re-mesh the part to edge ≈ `min(w, h)/3` (voxelize, MC, Taubin). Seed: `crochet.seed` (nearest vertex) else the
   tip geodesically farthest from the attachment boundary; root part: lowest vertex.
2. **Heat method:** cotan Laplacian `L` (PSD) and lumped mass `M`; `t = (mean edge)²`; solve `(M + tL)u = δ_seed`;
   `X = −∇u/|∇u|` per face; solve `Lφ = ∇·X` (Jacobi-PCG, relative tol 1e-8, ≤ 2000 iterations, ε·M regularization,
   shift so φ(seed) = 0). Double t (≤ 6 times) while adjacent critical points remain (a vertex whose one-ring
   changes sign ≥ 4 times = saddle).
3. **Rows:** `N = round(max φ / hS)`, isolines at `k·hEff` by marching triangles. More than one loop on any level ⇒
   `NeedsSplit` with the level; the editor proposes a cut there.
4. **Counts:** `n_k = round(isolineLength / wS)` with hysteresis 0.75, then the same pole rule as Path A
   (`clampPoles`, §2.10.5: magic-ring start 5–8 and no decrease while widening; closed tip ≥ 5 with trailing
   duplicates dropped) and the fan clamp; slope limit `|Δn| ≤ ⌈2πh/w⌉` (warn beyond). Sample counts in step 5 use
   the clamped `n_k`.
5. **Seam:** Dijkstra edge path seed → argmax φ; round k starts where it crosses isoline k, moved along the isoline
   by the spiral lean of §2.11.2; samples are uniform by arc length in the RH working direction (`t = n × ∇φ`).
6. **Couple** consecutive rounds by constrained DTW: steps D (sc), H (increase, only if the base has fan < maxFan),
   V (decrease); cost `|A_i − B_j|` + `0.15·w` per H/V step; endpoints fixed at the seam; maxFan 2, retry 3 with a
   warning, else insert a half row at `(k − ½)·hEff`. **Transducer:** degree > 1 on the old row ⇒ `inc`/`inc3`,
   on the new row ⇒ `dec`/`dec3`, else `sc`.
7. **Readability:** radial residual < 10% around the PCA axis ⇒ replace positions by §2.10.8 placement with the
   same counts. Mirror-symmetric pairs are generated once ("make 2").

#### 2.10.8 Placing increases and decreases (both paths, normative) [07 §6.6]

```
P → T in one round:  d = |T − P|
  increase: inc3 sites n3 = max(0, d − P), inc sites = d − 2·n3, sites k = d − n3, plain = P − k
  decrease: dec3 sites k3 = max(0, P − 2T), dec sites = d − 2·k3,  sites k = d − k3, plain = T − k
  specials ordered by even interleave (inc3/dec3 spread among inc/dec)
g = floor(plain / k), r = plain mod k
base ops = [(g+1) sc, special] × r  ++  [g sc, special] × (k − r)
changeIdx = 0 for the piece's first round with changes, +1 for each later round with changes
changeIdx even ⇒ rotate base left by ceil(g/2) ops;  odd ⇒ no rotation
```

Oval rounds apply this placement per segment (`Line.segments`, §2.10.2): circular changes inside the two end
segments, side changes at the middle of each side segment; the rotations below then act inside one segment.
Two overrides of the rotation, each choosing the smallest extra left rotation that still satisfies R8 against the
previous change round (else the default rotation stays and the stated fallback applies): the round before a
BLO/FLO round must **end** with a plain sc (jogless prep, §2.10.5); a shaped round in a joined-round section must
**start** with a plain sc (§2.11.3; fallback "ch 1, inc in same st as join, …").

Golden text (textbook sphere, k = 6, w/h = 1.0; Compact dialect) — must match exactly:

```
Rnd 1: 6 sc in MR (6)
Rnd 2: inc in each st around (12)
Rnd 3: (sc, inc) x 6 (18)
Rnd 4: (sc, inc, sc) x 6 (24)
Rnd 5: (3 sc, inc) x 6 (30)
Rnd 6: (2 sc, inc, 2 sc) x 6 (36)
Rnds 7–12 (6 rnds): sc in each st around (36)
Rnd 13: (4 sc, dec) x 6 (30)
Rnd 14: (sc, dec, 2 sc) x 6 (24)
Rnd 15: (2 sc, dec) x 6 (18)
Rnd 16: (dec, sc) x 6 (12)
Rnd 17: dec around (6)
```

#### 2.10.9 Flat pieces

- **Appliqué** (single layer, not stuffed): circle → MR then `n_k = 6k` for `K = max(1, round(D/(2h)))` rounds;
  oval → chain oval (§2.10.6) with `K = round(b/h)` rounds; rectangle → rows of sc (`ch W+1`, H rows);
  other outlines → nearest oval with a warning.
- **Flattened tube** (thick `flat` parts, ears, wings, fins; s = 1): from the tip (end away from the attachment) to
  the base, rounds every `h`, `n_k = 2·round(width(y_k)/w)` (even), n₁ ∈ [4, 8]; finish "Flatten and sc through
  both layers (n/2 sts)" or open for sewing.

#### 2.10.10 Live preview data

For the editor (§4) each piece returns `rings[k] = { center, normal, radius, labels[] }` (Path A: revolved profile
points; Path B: isoline polylines) and a **pattern ghost**, the surface the counts would make, with radii
`r'_k = n_k·wS/(2π)` (ovals: half-axes `r'_k + S_k·wS/2` and `r'_k`). Its axial placement is always finite:
- **Stuffed pieces** (`stuffing` ≠ none): ring k sits at the target profile's axial position `z(s_k)·ρ`, with the
  pitch ratio `ρ = N·hS / L`. Stuffing pushes a crocheted shell onto its meridian length, so the raw rise formula
  below would make every classic sphere a drum about 40% too short (its +6 rounds have `Δr' ≈ 1.003·hS` at worsted
  defaults) [03 §4.1].
- **Unstuffed pieces** (`none`): the inextensible shell, `z_k = z_{k−1} + √(max(0, hS² − Δr'²))`; a step with
  `|Δr'| > 1.05·hS` is drawn flat and flagged `W_RUFFLE`.

Ghost height = the ghost's axial extent; ghost width = 2·max `r'_k`. `W_SIZE` (with the suggested fix: style exact,
more rounds, or adjust the part) when `|ρ − 1| > 0.05` or `|max r'_k / r_max − 1| > 0.05`. The **toy ghost size** is
the bbox of every piece's ghost rings in model space plus the geometry of non-piece parts; the Pattern tab, the PDF
cover and the e2e size checks use it. Unit tests: the textbook sphere (k = 6, worsted) ghost is finite and its height
is within 5% of `D_actual` (ρ = 19·0.195/3.685 = 1.005); an unstuffed flat 6-per-round circle stays flat (< hS) and
finite; no ghost coordinate is ever NaN (three.js logs `computeBoundingSphere … NaN`, which fails the e2e rules).

#### 2.10.11 Amigurumi conventions in the text [07 §6]

Continuous spiral with a marker at center back (no join, no turning chain: `E_SPIRAL_CHAIN`, which exempts the
joined-round sections of §2.11.3); MR; `dec` rendered as invdec (or sc2tog by preference) except in BLO/FLO rounds,
where it is always `sc2tog` through the stated loops (§2.10.5); `N op` = op worked into each of the next N sts;
`inc` = 2 sc in the same st; counts in parentheses on every round; single-color rounds in multi-color pieces print
`Rnd 9 (B): …` with "change to B on the last yo" on the round before; multicolor rounds tag runs
`(4 sc A, 2 sc B) x 6 (36)`.
Notes block: "Work in continuous rounds (spiral); do not join or turn{, except where a piece says it is worked in
joined rounds}. Mark the first st of each round and move the marker up every round. Stitch counts are in
parentheses at the end of each round. `N sc` = sc in each of the next N sts; inc = 2 sc in the same st; dec =
invisible decrease (or sc2tog); in BLO/FLO rounds, dec = sc2tog through the stated loops only. Work through both
loops unless BLO/FLO is stated. Change color on the last yarn over of the stitch before the new color. Spiral rounds
lean a little each round; the stitch numbers already allow for about {leanStPerRnd} st per round, and every placement
also names a landmark, so pin pieces and check the landmarks before sewing. Safety eyes are not suitable for
children under 3; embroider eyes instead." (The lean sentence is omitted when `leanStPerRnd = 0`.) Special stitches
lists "BLO sc2tog" (insert the
hook in the back loop only of each of the next 2 sts, yo and draw up a loop in each, yo and draw through all 3
loops) whenever it is used.

### 2.11 Colors on 3D stitches (R8) [06 §9, 03 §6.3]

#### 2.11.1 The color field of a part

Evaluated at a point in **part-local** coordinates; priority: paint field → regions (in order, later wins) → base color.

- **Regions** use exactly the builder's semantics (§3.4.1, §3.5.2): `t` = height fraction along local Y over the geometry
  bounding box (0 = bottom); azimuth `az = atan2(dx, dz)` (0° = front +Z, +90° = object's left +X) around the bbox
  center. Kinds: `band`, `stripes` (widthIn along Y), `patch` (az span × t range), `spot` (great-circle radius),
  `pattern`:
  - `vertical-stripes` → angular sectors whose boundaries snap to stitch boundaries in every round;
  - `checker` → sectors × bands; `spots` / `leopard` → seeded Poisson-disk centers on the surface
    (`mulberry32(fnv1a(partId))`), radius `scaleIn/2` (leopard: ring color + center color);
  - `speckle` → an embroidery note (never single-stitch confetti); `gradient` → stripes of varying width (row fade).
- **Paint field:** primitives store a 64 × 64 label grid in `(u = az/360 + 0.5, v = t)`; mesh parts store one label
  per vertex. Photo reconstruction and Apply photo colors (§2.9.6) and the editor's paint brush write it.

#### 2.11.2 Stitch colors

- **Spiral lean.** Single crochet worked in a spiral leans [01 §3.4, 03 §6.4.7 "spirals drift"], so a stitch number
  counted from the marker does not stay on one vertical line: at ¼ st per round a 36-st body drifts ≈ 3 sts (30°)
  between Rnd 3 (legs) and Rnd 15 (arms), enough to shear belly patches, spots and vertical stripes (R8) and to
  misplace arms. `AmiSettings.leanStPerRnd` (default **0.25**, an estimate for RH yarn over; 0 disables; positive =
  the finished stitch columns drift **against** the working direction, i.e. to the right seen from the outside for
  a right-hander; calibrated with the test tube of §4.5, §7.2 Q7). Each piece has a **reference round** `r_ref` (its
  first eye, feature, patch or placement round; else its widest round) whose seam is exactly center back, and the
  front-marker cue of §2.10.6 pins that round. Round k's seam azimuth about â is
  `α_seam(k) = α_seam + h·2π·leanStPerRnd·Σ_{i = r_ref+1..k} 1/n_i` (h = +1 RH, −1 LH, i.e. against the working
  direction; for k < r_ref the sum runs over `i = k+1..r_ref` with the opposite sign). Every per-stitch computation
  uses `α_seam(k)`: stitch colors, eye and feature cues, assembly stitches (§2.12) and the ring preview.
- Stitch centers: Path A — the profile point at `s_k`, azimuth `α_j = α_seam(k) − 2π(j + ½)/n_k` (RH; + for LH)
  about â; Path B — the stitch samples on isoline k, starting from the seam point moved along the isoline by the same
  drift.
- Regions-only parts: label at the center. Paint fields: majority of 7 samples (center + 6 at `0.35·wS`).
- Photo-derived fields are then smoothed: per round a **circular Potts DP** (λ = 0.4, r_min = 2), then 2 ICM sweeps
  adding `μ = 0.2·[label ≠ label of the stitch below]`.
- **Stripe snapping:** rounds whose dominant label share ≥ 0.85 become solid; a boundary between labels A and B is
  snapped to round m when, over 24 azimuth bins, ≥ 80% define B's first round with std ≤ 0.5 and max deviation ≤ 1.
- **Details leave the colorwork:** components < 6 stitches, or < 2 rounds tall and < 3 stitches wide, or a third
  color in a round become an instruction ("embroider with C at Rnd 12, sts 9–11"); a spot motif becomes appliqué
  circles ("Spots (make 5): Rnd 1: 6 sc in MR (6); Rnd 2: inc in each st around (12). Sew at …").
- **Motifs:** a round whose colors are p-periodic with p dividing n_k (match ≥ 0.9) is snapped to the period;
  the encoder then prints `(3 sc A, 2 sc B) x 6 (30)`.

#### 2.11.3 Color-change technique policy [06 §9.7, 07 §6.7]

| Situation | Instruction |
|---|---|
| Whole-round change in a spiral piece | change on the last yo of the round before; note "a small jog appears at center back" |
| `crispStripes` on, or ≥ 3 stripe boundaries in a piece | the striped section is worked in **joined rounds** (template below); the piece intro states which rounds are joined |
| Mixed round, inactive color absent < 6 sts | carry it inside the piece (stranded float) |
| Absent ≥ 6 sts | carry and "catch the carried strand every ~5 sts" |
| Inactive color darker than the active run by OKLab ΔL > 0.15 | cut and tie instead of carrying (adds tails) |
| More than 2 colors in a round | `W_ROUND_COLORS`; 3 allowed with warning; tapestry (carrying inside stitches) is never used for amigurumi |

**Joined-round template** (slip-stitch join; no yarn cut per round). The section runs from the first striped round
`a` to the last `b`; rounds outside it stay spiral.
```
Rnds a–b are worked in joined rounds (stripes); the rest of the piece is a continuous spiral.
Rnd a (A): {ops}; join with sl st in first sc{, changing to B}. (n)
Rnd a+1 (B): Ch 1 (does not count), sc in same st as join, {ops of the rest of the round}; join with sl st in
  first sc{, changing to …}. (n)
…
Rnd b+1: Ch 1 (does not count), sc in same st as join, {ops}; do not join — continue in a spiral. (n)
```
- The color change happens on the join: draw the new color through on the sl st. The color put down is carried up
  inside the piece at the join when it is used again within 4 rounds, otherwise cut (2 × 6 in tails).
- The marker stays on the first sc of each round, so the joins stack at center back.
- Shaped joined rounds are rotated to start with a plain sc (§2.10.8 override); a round that cannot (g = 0)
  starts "Ch 1, inc in same st as join, …".
- In the `Line` model a joined round has `start: { k: 'join' }` (from round a + 1) and `join: { changeTo?, drop? }`;
  the sl st and ch 1 are not counted (E_CONSUME/E_PRODUCE see only the ops); `E_SPIRAL_CHAIN` exempts lines with
  `join`. Yardage adds `0.92·L_ami` per joined round and the cut tails (§2.8).
- PlanetJune's invisible join (cut every round) is v1.1.

### 2.12 Assembly [03 §6.4, 07 §6.11]

1. **Anchor:** a trimmed child uses the centroid of its open edge; a closed child the midpoint of the closest points
   between child and parent surfaces; a feature its `(azimuthDeg, elevationDeg)` point on the parent.
2. **Parent coordinates:** Path A — project onto the parent profile: `round = clamp(round(s/hEff), 1, rounds)`;
   `stitch = 1 + floor((((α_seam(round) − α)/2π) mod 1) · n_round + 1e-9)` (RH; mirror for LH; `α_seam(round)`
   includes the spiral lean of §2.11.2; the 1e-9 makes a direction that falls exactly on a stitch boundary belong to
   the stitch starting there, whatever the float rounding), where α is the angle about the
   parent's crochet axis â, right-handed about â. For a piece worked bottom-up (â = +Y) α is the azimuth
   (`az = atan2(x, z)`, +90° = the toy's left), the seam is at 180° and the RH working direction lowers α, so the
   toy's left comes first; for a piece worked top-down the left and right stitch ranges swap. With n even the front
   center is the gap between sts n/2 and n/2 + 1. Path B — round from `φ/hEff`, stitch from the arc position along
   the isoline from the seam.
3. **Opening size:** a child with m open stitches spans about `m·wS/(π·hS)` rounds and `m/π` stitches.
4. **Text** — the **landmark comes first**, then the numbers, because a maker's rounds and stitches drift (kind
   `open-edge`): "In line with the legs, 2 rnds below the eyes: stuff the Arm lightly, pin, then sew its open edge
   (12 sts) to the Body between Rnds 14 and 17, centered on st 10 (counting from the marker at center back)."
   (Example numbers with `leanStPerRnd = 0`; G18 shows the lean shift.) Landmarks come from the attach tree and
   geometry: "in line with" a sibling
   pair whose azimuths match within 15°, "level with" a feature or sibling within ½ round, "N rnds below/above"
   the nearest such landmark, else "on the side seam line" / "centered on the front". Pairs are computed side by
   side ("left arm: st 10, right arm: st 28" on a 36-st bottom-up body at its reference round; left = the toy's own
   left, +X). Kind `closed` (a closed piece sewn by contact, e.g. the teddy's arms): "Level with the top of the
   legs: pin the Arm to the Body, centered on Rnd 15, st 10, and sew around the edge of the contact area with the
   long tail." Kind `feature-ref`: safety eyes are inserted inside their host piece (cue, §2.10.6); Assembly only
   says "Eyes: already fitted in the Head (after Rnd 11)".
5. **Order:** the attach tree from the root; children before grandchildren; "stuff before sewing".
6. **Image:** `renderPlacementImage` (§5.2.1) renders the parent with rings and the target stitches highlighted (PDF).
7. Join-as-you-go (seamless legs) is v1.1; v1 sews every piece.
8. **Validation:** `E_OPEN_EDGE` — every `open-edge` step references a piece whose finish is open (no closing
   round), every open piece is referenced by exactly one `open-edge` step, and no closed piece is told to sew an
   open edge.

Golden (G18): bottom-up 36-st round at its reference round (or with `leanStPerRnd = 0`) — +X (toy's left) ⇒ st 10,
−X ⇒ st 28, front center = the gap between sts 18 and 19; top-down 36-st round — +X ⇒ st 28, −X ⇒ st 10; safety
eyes at azimuth ±30° on a 36-st round, 6 sts apart ⇒ posts in the gaps after st 15 and after st 21. With
`leanStPerRnd = 0.25` (RH), 12 rounds of 36 sts above the reference round the seam has turned 30° toward −X, so
+X ⇒ st 13 and −X ⇒ st 31.

### 2.13 Validation rules and golden tests

Validators run in the generating worker and again before export; any `E_*` (severity *error*) blocks export;
`W_*` (severity *warn*) shows as a badge on the line and in the editor. Every rule has exactly one code and one
severity; the R-numbers are research 03 §6.7's names for the 3D rules. Generators must never produce an `E_*` on
valid input (asserted by every golden and property test); `W_*` rules fire only where this table says.

| Code (R-rule) | Severity | Rule | Applies |
|---|---|---|---|
| `E_CONSUME` (R1) | error | Σ consumed(ops) = previous count (MR, foundation, chain-oval, chain-ring and border `edge` lines exempt) | rows, rounds |
| `E_PRODUCE` (R1) | error | Σ produced(ops) = stated count | rows, rounds |
| `E_RUN_SUM` | error | every flat row's runs sum to W | 2D |
| `E_FOUNDATION` | error | foundation chain = `W + h_tc − c` (sc W+1, hdc W+2) | 2D |
| `E_C2C_TILES` | error | rows = W+H−1, `tiles(n)` formula, Σ tiles = W·H, phases min / \|W−H\| / min−1 | C2C |
| `E_MOSAIC_ADJ` | error | no vertically adjacent X; edge cells = row color; alternating colors | mosaic |
| `E_BORDER` | error | border per-side counts, Rnd 1 = 2·S_top + 2·S_side + 4, +8 per later round with `inc3` at each corner center; Rnd 1 opens at the corner where the last line ends or with a join (§2.7.10) | 2D |
| `E_COLOR` | error | every color code is in the palette | all |
| `E_FOLD` | error | folded line ranges are identical in ops, colors, loops, notes (border Rnds 2–n: identical instruction, counts listed) | all |
| `E_SPIRAL_CHAIN` | error | spiral rounds never begin with a turning chain; lines with `join` (joined-round sections, §2.11.3) are exempt | 3D |
| `E_INC_INFEASIBLE` / `E_DEC_INFEASIBLE` (R3, R4) | error | T > 2P with inc only / T < P/2 with dec only; `inc3`/`dec3` make it feasible and raise `W_FAN3` | 3D |
| `E_START` (R2) | error | MR: 5 ≤ n₁ ≤ 8 (flattened 4–8; classic exactly 6); chain oval n₁ = 2N = 2S + 6; joint = Σ live + 2·chains; no decrease while `ideal_k < n₁` (pole rule) | 3D |
| `E_CORNER` (R6) | error | no stitch is part of both an inc and a dec (Path B) | 3D |
| `E_CLOSE` (R9) | error | closed ends finish at ≤ 8 and never < 4 (7–8 add `W_CLOSE`), or with the closed-oval finish at exactly 2S + 6 (S ≥ 2) | 3D |
| `E_ROUNDTRIP` (R10) | error | `expand(encodeOps(ops))` deep-equals ops; printed count = Σ produced | all |
| `E_COLOR_SEQ` (R12) | error | a change instruction precedes every color boundary; ≤ 3 colors per round (3 adds `W_ROUND_COLORS`) | 3D |
| `E_ASSEMBLY` (R13) | error | every non-root piece attaches once; round/stitch exist; attach graph is one tree | 3D |
| `E_OPEN_EDGE` | error | open-edge assembly steps reference open pieces only; each open piece has exactly one (§2.12) | 3D |
| `E_EYE_ORDER` | error | each safety-eye cue precedes the stuffing cue and the closing round of its host piece (§2.10.6) | 3D |
| `E_SANITY` (R15) | error | integers ≥ 1; < 200 rounds and < 20,000 sts per piece; ≤ 1000 cells per chart side | all |
| `W_RUFFLE` (R5) | warn | \|n_k − n_{k−1}\| ≤ ⌈2πh/w⌉; ghost steps drawn flat (§2.10.10) | 3D |
| `W_SPACING` (R7) | warn | gaps between specials differ by ≤ 1 — over the whole round, or, in an oval round, inside each **side** segment with ≥ 2 specials; oval **end** segments are exempt (the circular changes cluster there by design) (Path A, regularized B) | 3D |
| `W_STAGGER` (R8) | warn | consecutive change rounds with equal k and g ≥ 1 in both (rounds made only of specials are exempt): min circular offset between change-site centers ≥ 1/(4k) − 1e-9 of a round; site center = (stitches consumed before it + CONS/2) / P. Oval rounds: evaluated per side segment with ≥ 2 specials (as a fraction of the segment); end segments and single mid-side changes are exempt | 3D |
| `W_STACKED` | warn | in R8's frame and scope: for ≥ 3 consecutive change rounds that **all have g ≥ 3**, some site center lies within 1/P of a site center of the previous change round (with g ≤ 2 there is no room to stagger: G5's Rnd 4 increases sit on Rnd 3's) | 3D |
| `W_SIZE` (R11) | warn | suggests "style: exact" (or more rounds). Length: \|N·hS − L\| ≤ hS/2 (+1.5·hS per pole shortened by the pole rule; textbook path \|(T + 1)·hS − A\| ≤ hS/2). Widest round against the generator's own target: exact \|max(n_circ)·wS − 2π·r_max\| ≤ wS; classic batched ≤ (sym/2)·wS; textbook sphere/capsule \|6k·wS − 2π·r\| ≤ 3·wS; ovals \|(2S + n_circ)·wS − P_stadium\| ≤ wS with `P_stadium = 4(a − b) + 2π·b` at that round. Ghost within 5% (§2.10.10, e.g. worsted D = 2.6 in → 42 sts, D_actual +5.3%) | 3D |
| `W_SINGLE_ST` (R12) | warn | a color run of 1 st that is not flagged embroidery | 3D |
| `W_MIN_PART` (R14) | warn | circumference < 5 sts and the part was not turned into a chain/embroidery | 3D |
| `W_GAP` | warn | a part's gap to its parent > 0.1 in (from the importer, the editor or inference) | 3D |
| `W_LONG_CARRY`, `W_ROW_COLORS`, `W_ROUND_COLORS`, `W_JOG`, `W_EYE_OPENING`, `W_CLOSE`, `W_FAN3` | warn | as described above | — |

v1.1 left the R-rules without severities and checked R7/R8 over whole rounds, so every correct oval (G8's
`inc, 7 sc, inc in next 3, 7 sc, inc in next 2` has gaps 7,0,0,7,0,0; its end increases move only 0.006 of a round
between Rnds 2 and 3) failed them, and `W_STACKED` fired on the textbook sphere. Tests (T4): G8, G19 and the teddy
muzzle (an oval: rx/ry = 1.0/0.75 = 1.33 > 1.15) pass every `E_*` rule and raise no `W_SPACING`, `W_STAGGER` or
`W_STACKED` from their end segments; G5 raises no `W_STACKED`.

**Golden test list** (each owned by a track in §6):

| # | Golden | Expected |
|---|---|---|
| G1 | CIEDE2000 Sharma pairs | 34 pairs within 1e-4 (smoke values §2.4.1) |
| G2 | Grid sizing worsted 40 × 50 in | 135 × 200; with a 1 in border 4 rounds, 128 × 192, 39.9 × 50.0 in |
| G3 | Sphere sizing D = 2.35 in worsted | N_max 36, D_actual 2.346 in; 42 sts → 2.737 in |
| G4 | Encoder and line validator vectors | 07 §7.6 vectors 1–12 and 15–18 (Step 0); 13–14 belong to G8, 19–21 to G9/G10, 22 (US→UK) to T2; encoder perf budgets §2.6.1 |
| G5 | Textbook sphere k = 6, w/h = 1 | 17-round counts and the exact text of §2.10.8 |
| G6 | Lathe semicircle exact / classic | §2.10.5 lists |
| G7 | Cone (classic and exact), horn, closed cylinder | §2.10.5 lists (classic cone `6 6 6 6 12 …` via the classic MR = 6 and `batchCounts` p0 = 6), pole rule results, and the cylinder's Rnds 4, 5, 14, 15 text (jogless prep, BLO sc2tog) |
| G8 | Oval ch 10 | ch 10 ⇒ S = 7: Rnd 1 (20), Rnd 2 (26), Rnd 3 (32) with segment-preserving text [07 §6.9]; no `E_*`, no `W_SPACING`/`W_STAGGER` from the end segments |
| G9 | Flat graph W = 5 | §2.7.3 text (RH and LH) |
| G10 | C2C 5 × 3 and 100 × 60 | §2.7.6, including RH start bottom-left (row 2 ↘ (1,0),(0,1); row 3 ↖ (0,2),(1,1),(2,0)) and LH bottom-left |
| G11 | Yardage | 61.9 yd example (band 46.4–77.4 yd, 1 skein of 364 yd); C2C tile 14.95 in; Table D within ±0.01 (new amigurumi column); 36-st worsted sphere 22.8 yd (band 18.2–27.4) |
| G12 | Teddy importer | §3.7.3 goldens, the attach tree and mirror pairs of §3.7.6, §3.7.7 acceptance on every carrier, and the imported teddy generates a pattern with **zero `E_*`** |
| G13 | Determinism | same image + settings ⇒ identical chart hash over 10 runs; same model ⇒ identical pattern hash |
| G14 | 2-color logo | exactly 2 colors after cleanup; 1-px PNG export → import round-trips the grid |
| G15 | Aspect | a circle image at sc gauge gives a chart whose physical width and height differ < 3% |
| G16 | Border | §2.7.10: 135 × 200 sc, 1 in ⇒ 612/620/628/636, 134.1 yd, 42.0 × 52.0 in |
| G17 | Teddy plan | the §2.10.1 table exactly (make-as, parent, axis, start pole, open/closed, stuffing with flatness = e₁/e₂; 8 sections, 12 items) |
| G18 | Assembly numbering | §2.12 golden (st 10 / st 28, front gap 18–19, eyes after st 15 and st 21; with lean 0.25, 12 rounds up: st 13 / st 31) |
| G19 | Ovals | the box closed-oval and the (symmetric) oval-ellipsoid goldens of §2.10.5; both pass every `E_*`; property test: symmetric profile ⇒ symmetric counts |
| G20 | Open capsule | §3.6 `arm_l` ⇒ `6 12 12×5`, open, 14" tail; `E_OPEN_EDGE` fires if it were closed |
| G21 | Ghost | §2.10.10 unit tests (finite, sphere height within 5%) |
| G22 | Border start corner | §2.7.10 G22: G9 chart with border B (RH, odd rows: "Do not turn … (top left corner)", 20 sts), LH, the join variant, and C2C 5 × 3 (join at the top right tile, 46 sts) |
| G23 | Proportions | §4.2: teddy head : body 1:1 ⇒ head bbox height = 50% ± 1% of the model height, 1:3 ⇒ 25% ± 1%, finished height unchanged; limbs "long" ⇒ arm length = 0.55·H ± 1%, attach anchors kept |
| G24 | Merge | §2.9.8: teddy head + body ⇒ one `body` mesh part, volume within 2% of the union, one attach tree (ears, muzzle, eyes re-attached); undo restores both parts |
| G25 | Side photo | §2.9.3: `teddy-ortho/left.png` alone as a "left side" photo ⇒ front faces +Z, a part named `muzzle` in front of the head, eye-colored labels on both sides of the head (one side with "one-sided detail" on) |
| G26 | Importer versions and units | §3.7.7: the stale-side-file archive returns the page's rev 1 with a "2 versions found" chip; the builder-v1 teddy GLB (root extras), GLB (per-node `extras.crochet` only) and OBJ + MTL (meters) each give the 17 parts with bbox within 2% of the canonical teddy; the OBJ is read as meters with and without an expected height |

---

## 3. The Claude Design round trip (R5, R6)

### 3.1 What we rely on (verified 2026-09-30 by a real run) [08, 05]

- claude.ai/design → **3D object** template produced, in one generation, a page with a pinned three@0.184.0 import
  map, a `<three-d-stage>` element (renderer, orbit controls, **Download GLB** / **Download OBJ + MTL**), and our
  `<script type="application/json" id="crochet-model">` block when asked; it builds the model from that JSON.
- Export routes that worked: **Share → Export → Project HTML → Project archive** (free, instant `.zip`, flat: the
  page `.html`, `three-d-stage.js`, `.thumbnail`), **Standalone HTML** (self-unpacking `__bundler` file with three.js
  inlined), PDF, PowerPoint; and the JSON printed in the chat reply on request.
- The in-preview Download buttons did not respond to automated clicks; the preview iframe URL cannot be fetched.
  The app therefore never fetches anything: the user exports a file or pastes text.
- Claude Design improvised a **dialect** when given only field names (§3.7.3), and left 7 of 17 parts without a
  `parent` (body, head, arms, legs, tail). With our full seed and builder it is expected to follow our schema, but
  the importer accepts both and always rebuilds one attach tree (§3.7.6). Sample size is one object (risk §7.1).
- **The send side is not verified yet.** The verified run used a ~1 KB prompt that only named the fields;
  prompt-v1 (11–18 KB with seed and builder) has never been run. Design's documented inputs are prompts,
  images/screenshots, documents and decks (DOCX/PPTX/XLSX) and codebases [05 §1; support article re-read
  2026-10-01]; uploading `.txt`/`.json` files is unverified. So the send step pastes the whole prompt as text and
  attaches only images (§3.4), and the send side is verified **before T7 builds on it**:
  - **S-CD spike** (sprint 1, integration agent, §6.5): prompt-v1 filled by hand from the §3.6 bunny and the
    canonical teddy, each in the full and the compact variant (4 runs), run at claude.ai/design → 3D object in the
    user's logged-in browser — driven through claude-in-chrome once the user approves (the runs count toward the
    user's Claude usage), otherwise run by the user from the checklist in `docs/S-CD.md`. Recorded per run: how the
    Design composer takes an 11–18 KB paste (inline text, or turned into a text attachment — the unverified case),
    whether Claude keeps our builder, inch units with `unitScale = 0.0254`, ids, `attach`, `x-cpg` and the
    `#crochet-model` block, what one follow-up change ("make the ears bigger") does to `revision`, and every export:
    project archive, chat JSON, standalone HTML, and GLB / OBJ + MTL from the standalone page opened locally (its
    stage buttons work in a local headless Chromium, as for the teddy fixtures). Results go to
    `fixtures/claude-design/s-cd/<run>/` with a README and are committed **before T7.3 starts**; a finding that
    breaks prompt-v1 or the schema is fixed in this document (integration-owned) first, as prompt-v2 or a schema
    MINOR.
  - **Release gate** (§6.5 gate 1, a regression check): the round trip on three objects — (1) a described toy with
    no photos, (2) a multi-photo toy, (3) a striped or spotted object — plus (4) one deliberate run whose page lacks
    the JSON, recovered with the fix-up message (§3.4.2). Exports are saved like the spike's, scanned for embedded
    photos before committing (§6.1 rule 9), added to G12 ("import → pattern with zero `E_*`"), and §3.7.3 is updated
    from what is observed.
  Neither run is automated in CI.

### 3.2 Q&A wizard (R5) [05 §6]

A deterministic form. `q_what` and `q_notes` are always shown and are outside the budget; at most **14 other steps**
are shown, in numeric priority order (ties → id), skipping steps already known from photos/settings; every step has a
default and **Decide for me**. Free text runs through a client-side lexicon (part nouns, shape adjectives
round/pointy/floppy/long/curly, CSS and yarn color names) that pre-ticks parts and colors; the raw text is still
passed verbatim to Claude.

| Prio | id | Step | Kind | Default / options | Shown when | Writes |
|---|---|---|---|---|---|---|
| 0, exempt | `q_what` | What is it? | text | image file name / previous answer | always | `name`, lexicon |
| 10 | `q_reject` | What's wrong with the automatic 3D? | multi + choice | wrong silhouette, missing parts, extra parts, proportions, colors, too lumpy, pose, other; with "wrong silhouette" or "missing parts": **Keep the current parts** (default) / **Start over from a template** | came from a rejected R2/R3 result, or a failed build (pre-answered "the automatic 3D failed", template seed) | `REJECTION_REASONS`, seed source (§3.3) |
| 20 | `q_cat` | Kind of thing | chips | quadruped · biped/doll · bird · sea · insect · creature · food/plant · object | always | `category` → template |
| 30 | `q_size` | Size and yarn | number + unit; CYC 1–7 chips; hook (mm) | finished size from settings, which dimension is fixed (height default); yarn and hook from the project gauge (Table E hook) | unless both were set in F2/F3 step 5 or the Yarn & size panel | `finishedSize`; project `gauge` (`cyc`, `hookMm`) via `projectStore.update` → prompt `YARN_NAME`, `CYC`, `HOOK_MM`, `STS_PER_IN` |
| 40 | `q_style` | Look | chips + thumbnails | chibi (big head) · true-to-photo · minimal | always | `style`; head fraction 0.45 / 0.33 (a seed from the current model keeps its own) / 0.40, applied with `applyProportions` (head : body 1 : 1.22 / 1 : 2 / 1 : 1.5) |
| 50 | `q_parts` | Parts | parts table; above it a **head : body** slider (chibi 1:1 … realistic 1:3) and a **limb length** chip row (nubs · short · medium · long dangly), both the Step 0 kernel `applyProportions` (§4.2) on the seed, disabled with the kernel's reason when the parts are missing; per row inline follow-up fields (table below) | the seed source's parts (§3.3): id, type, count, size (largest extent, in), parent, where | always | `parts[]`, dims, rotations, `band` regions |
| 60 | `q_palette` | Colors | color list | photo palette (merge ΔE00 < 3), ≤ 8 | always | `palette` |
| 70 | `q_patterns` | Patterns per part | region editor | none · stripes · spots · patch · motif | ≥ 2 colors or texture seen | `regions` |
| 80 | `q_face` | Face | eyes (safety, mm by head size · embroidered · felt · none), nose, mouth, cheeks, whiskers | from category | head exists | `features` |
| 90 | `q_pose` | Pose | chips | sitting · standing · lying · hanging ornament | animals, people | `pose`, `flatBase` |
| 100 | `q_audience` | Who is it for? | chips | adult/decor · child 3+ · under 3 | always | `audience` (under 3 ⇒ embroidered features) |
| 110 | `q_bodyshape` | Body silhouette | SVG chips | ball · egg · pear · bean · cylinder · cone | seed from a template | body type + lathe preset |
| 120 | `q_headbody` | Head separate or one piece with the body? | chips | separate · one piece | seed from a template, category ≠ object/food | merges head+body into one lathe |
| 130 | `q_views` | Photo order and labels | per-photo chips | from F2 labels | photos present | `PHOTO_ORDER`, `source.views` |
| 140 | `q_join` | Construction | chips | fewest pieces · sewn pieces · no preference | always (optional) | `attach.method` defaults |
| 1000, exempt | `q_notes` | Anything else? | text | — | always | `FREE_TEXT` |

The bank has exactly 14 budgeted steps, so every eligible step is reachable today; the budget guards future
additions. Follow-ups are **inline fields of each `q_parts` row** (no separate questions), shown when the row's part
kind matches:

| Part | Row fields → mapping |
|---|---|
| ears | shape: pointed → `cone` with `flatten: 0.8`; round → `flat` circle; floppy → `flat` teardrop rotated outward · size vs head · inner color → `band` region |
| tail | stub → `sphere`; straight → `capsule`; curled → `torus` arc 180–270°; bushy → `lathe` with a bulge |
| legs | count · stubby feet only → `ellipsoid` feet; real legs → `capsule` (`flatBase` false) · sole color → start band |
| arms | pose down / out / up → `rotationDeg` z ±10° / ±60° / ±150° · paw color → `band` near the tip |
| snout/beak | depth · color · beak → `cone` with `rotationDeg` x 90 |
| wings, fins | folded → `flat` hugging the side; spread → `flat` rotated out |
| hair | cap → `lathe` dome; strands → `flat` or `features.line`; ponytail → `capsule` |
| horns | count, curve → `cone` (+ `torus` arc if curved) |
| accessories | hat → `lathe`; scarf → `torus` + `flat`; bag → `box` |

```ts
interface Question { id: string; kind: QuestionKind; priority: number; exempt?: boolean;   // exempt: q_what, q_notes
  when?(c: QaContext): boolean; known?(c: QaContext): boolean; default(c: QaContext): unknown;
  apply(answer: unknown, draft: SeedDraft, c: QaContext): void }
const byPrio = (a: Question, b: Question) => a.priority - b.priority || (a.id < b.id ? -1 : 1);
function nextQuestions(bank: Question[], c: QaContext, budget = 14): Question[] {
  const eligible = bank.filter(q => (q.when?.(c) ?? true) && !q.known?.(c));
  const budgeted = eligible.filter(q => !q.exempt).sort(byPrio).slice(0, budget);
  return [...eligible.filter(q => q.exempt), ...budgeted].sort(byPrio);
}
```

Tests (T7): for every category × {from photos, described}, `q_what` and `q_notes` are shown, every inline follow-up
field of every template part is reachable, and the budgeted count is ≤ 14; priorities are unique.

### 3.3 Seed builder

0. **Seed source.** When the project has a current model (after F2/F3, an import, or editor work), the seed **is that
   model**: parts, ids (named by §2.9.7 step 6), sizes, positions, rotations, regions, palette and every user edit are
   kept; `mesh` parts are converted to their fitted primitive or lathe (`fitPart`, residual ≤ 0.12) or, failing
   that, to their bounding ellipsoid; `paint` and `crochet` stay in the project but are not sent (`SEED_JSON` rule,
   §3.4). Q&A answers then edit this seed (part rows, ratio and limb controls, palette, patterns, face). The
   category **template** below is used only for "Describe a toy", after a failed F2/F3 build (no model exists; the
   photos are still attached), or when `q_reject` includes "wrong silhouette" or "missing parts" **and** the user
   picks "Start over from a template". The Q&A screen shows the seed blockout next to the current model.
1. **Template by category** (sizes as fractions of the finished height H; `where` relative to the parent; the limb
   lengths are the `LIMB_TEMPLATE` table of the Step 0 kernel `core/model/proportions.ts`, which `applyProportions`
   also uses, so the Q&A and the editor agree):

| Category | Template parts |
|---|---|
| quadruped, sitting | `body` lathe *pear* (height 0.6, r 0.3); `head` ellipsoid on top of body (ry 0.21 chibi / 0.16 realistic, rx = 1.08·ry, rz = ry); `ear_l`/`ear_r` flat circle top-left/top-right of head (w 0.14); `arm_l`/`arm_r` capsule front-left/right of body, upper third (r 0.05, length 0.25); `leg_l`/`leg_r` capsule front-left/right at body bottom (r 0.07, length 0.2, rotationDeg x 80); `tail` sphere at back (r 0.05); optional `muzzle` ellipsoid on head front (0.09 × 0.07 × 0.06) |
| quadruped, standing | `body` capsule horizontal (rotationDeg x 90, r 0.2, length 0.6); `head` ellipsoid front-top; `leg_fl/fr/bl/br` capsules (r 0.06, length 0.3); ears; tail |
| biped / doll | `head` sphere (r 0.2); `body` lathe *bean* (height 0.4); arms and legs capsules (length 0.3); optional `hair` lathe dome |
| bird | `body` lathe *egg* (head included, height 0.9); `wing_l/r` flat teardrop at the sides; `beak` cone front (rotationDeg x 90); `foot_l/r` flat at the bottom |
| sea | `body` ellipsoid lying along Z; `fin_l/r`, `fin_top` flat; `tail` flat at the back |
| insect | `body` ellipsoid; `head` sphere in front; `wing_l/r` flat on top; antennae as `features.line` |
| creature | `body` lathe *egg* one piece; optional `horn_l/r` cones and `arm_l/r` capsule nubs |
| food / plant / object | one primitive from `q_bodyshape`; leaves as `flat` |

   Lathe presets `[r, y]` (scaled by max radius and height): *egg* `[0,0] [0.55,0.05] [0.85,0.25] [0.95,0.45]
   [0.85,0.7] [0.55,0.92] [0,1]`; *pear* `[0,0] [0.7,0.03] [0.97,0.22] [1,0.42] [0.82,0.7] [0.55,0.92] [0,1]`;
   *bean* `[0,0] [0.6,0.04] [0.9,0.25] [0.85,0.55] [0.9,0.8] [0.55,0.97] [0,1]`; *cylinder*
   `[0,0] [1,0] [1,1] [0,1]` (corners sharp).
2. Apply the user's part edits and follow-ups; mirror pairs end in `_l` / `_r` (left = +X) with `mirrorOf` on the
   `_r` part; every non-root part gets `attach: { to: <parent>, method: 'sewn' }`.
3. **Stack** (template seeds, and parts the user adds in `q_parts`; parents before children; the Step 0 kernel
   `placeChildOnSurface` of `core/model/place.ts`, which the editor's Add part and `applyProportions` also use):
   extents come from the builder geometry, never from `position` (a lathe's `position` is its base, §0.1). Place the
   child's center
   (§0.1) on the ray from the parent's center along `dir(where)` (top +Y, bottom −Y, front +Z, back −Z, left +X,
   right −X; diagonals normalized), at the distance where the child's surface enters the parent's surface by
   **0.10 in** along that ray (analytic SDFs of §3.7.6, bisection to 1e-4 in); then `position = center − R·c_local`
   (lathe: `c_local = (0, (y_min + y_max)/2, 0)` of its profile). Ground
   (min y = 0), scale uniformly so the bbox height = H, and stack once more so every overlap is again 0.10 in (the
   height changes by < 1%).
4. Palette ids `c1…cN` with roles; regions from `q_patterns`; eyes at azimuth ±30°, elevation −10°; safety-eye size
   from head diameter: < 2 in 6 mm, 2–3 in 8 mm, 3–4.5 in 10 mm, 4.5–6 in 12 mm, > 6 in 15 mm.
5. `revision: 0`, `source.stage: 'seed'`, and the extension key `"x-cpg": { "project": "<project id>", "seedRev":
   <ProjectDoc.rev when the prompt was produced> }`, which prompt rule 3 tells Claude to keep, so a returning result
   finds its project (§3.7.7). The seed renders with the shared builder so the user sees the blockout.

Tests (T7): every category template validates, is grounded, has one attach tree, and every child overlaps its parent
by 0.05–0.15 in along its stacking ray; for every lathe, the `buildModel` mesh's local bbox spans exactly
`[y_min, y_max]` of its profile (not re-centered), so `position` is the profile's y = 0 point; the seed taken from
the normalized teddy keeps all 17 ids, types and positions
exactly and carries `x-cpg` with the project id; the seed from a mesh-part version of the teddy (tessellated by
`buildModel`, gated on `fitPart`) keeps the part count and centers (§0.1) within 0.1 in.

### 3.4 The prompt (versioned `prompt-v1`)

**Send step (primary route).** **Copy prompt** puts the whole filled template below on the clipboard (seed and
reference builder embedded, ≈ 11–18 KB); the user pastes it into claude.ai/design → 3D object and attaches only the
photos (images are a documented Design input, §3.1). **Save kit to folder** is one action:
`window.showDirectoryPicker({ mode: 'readwrite', startIn: 'downloads' })`, then the photos renamed in order
(`1-front.jpg`, `2-left.jpg`, …), `crochet-brief.txt` (the same prompt text) and `crochet-model.seed.json` are
written into the chosen folder; where the picker is unavailable it downloads one `crochet-kit.zip` (fflate) instead
of several files (Chrome blocks repeated downloads behind a permission prompt). Copy prompt (either variant) and
Save kit set `QaState.generatedAt` and `QaState.awaiting = { since, seedRev, via }` through `projectStore.update`
(saved with the project), which drives the F4 banner and the project's Import tab until a result is accepted or
the user dismisses it.
**"Pasting didn't work?"** offers (a) the kit route: attach `crochet-brief.txt` (and the photos) and paste "Please
follow the attached crochet-brief.txt exactly. Use the "3D object" skill.[[if PHOTOS]] Photos are attached in
order.[[/if]]" — `.txt` upload is unverified, so this is the fallback, not the default — and (b) **Copy compact
prompt**, the same template without the "Reference builder" section (≈ 40% smaller). The prompt never refers to
attached files other than photos.

Template (`{{…}}` filled by the app; `[[if X]]…[[/if]]` keeps the text between the markers only when X is true;
a line that starts with `[[if X]]` and has no `[[/if]]` is a whole-line conditional; markers are removed):

````text
Use the "3D object" skill. (If you don't have it, build ONE plain .html page that loads three.js 0.184.0 from unpkg through an import map.)

# Task
Make an amigurumi-style 3D model — a crocheted, stuffed yarn toy — of: {{OBJECT_NAME}} ({{OBJECT_SUMMARY}}).
A separate crochet app will turn your model into a crochet pattern, so the machine-readable spec (rules 3–4) matters more than visual polish. No design system is needed and please don't ask me questions — everything I know is below. Where something is unclear, decide and record it under "assumptions".

# References
[[if PHOTOS]] I attached {{PHOTO_COUNT}} photos in this order: {{PHOTO_ORDER}}. Use them for shape, proportions and colors. If a photo and my answers disagree, my answers win.
[[if NO_PHOTOS]] There are no photos; work from this description.
[[if FREE_TEXT]] My own words: "{{FREE_TEXT}}"
[[if REJECTED]] An automatic 3D reconstruction got this wrong: {{REJECTION_REASONS}}. Avoid repeating that.

# Size, yarn, style
- Finished size: {{HEIGHT_IN}} in tall[[if W]] × {{WIDTH_IN}} in wide[[/if]][[if D]] × {{DEPTH_IN}} in deep[[/if]]. Pose: {{POSE}}.[[if FLAT_BASE]] It must stand/sit on a flat base.[[/if]]
- Yarn: {{YARN_NAME}} (CYC {{CYC}}), {{HOOK_MM}} mm hook, about {{STS_PER_IN}} stitches per inch. No part may be thinner than {{MIN_FEATURE_IN}} in across. Fewer, bigger parts are better (at most {{MAX_PARTS}} parts).
- Style: {{STYLE_SENTENCE}}. Audience: {{AUDIENCE}}.[[if UNDER3]] Under 3 years: no safety eyes or small separate pieces; all facial features are embroidered.[[/if]]

# Parts I expect (keep these ids; refine sizes and positions from the photos; add parts only if clearly visible)
{{PARTS_LINES}}

# Colors (use only these ids; hex values are sRGB)
{{PALETTE_LINES}}
Color patterns: {{PATTERN_LINES}}
Face and details: {{FEATURE_LINES}}

# Seed spec — start from this and refine it
```json
{{SEED_JSON}}
```

# Rules
1. Build ONLY from these primitives, one mesh per part: sphere, ellipsoid, capsule, cylinder, cone, torus, lathe (surface of revolution — best for most crocheted pieces), flat (thick 2-D shape for ears, wings, fins, felt), box. Each part becomes one crocheted piece, so use round, chunky shapes and no tiny details. Mirror pairs exactly across x = 0.
2. Spec units are inches. Axes: +Y up, the object's front faces +Z, the object's own left is +X, the lowest point is at y = 0. Every "position" is ABSOLUTE in model space — do not nest parts or use parent-relative positions — and is the part's local origin: its center for every type except lathe, whose origin is the point on its axis at profile y = 0 (the base of the profile, as in the reference builder). capsule "dims.length" is the TOTAL tip-to-tip length including both rounded ends. Every part except the root (usually "body") has "attach": {"to": "<parent id>", "method": "sewn"}; parts that are sewn together overlap by 0.05–0.15 in (no gaps). In three.js, multiply inches by 0.0254 (the stage works in meters).
3. Put the spec in the page <head> as <script type="application/json" id="crochet-model">…</script>, same schema as the seed ("schema":"crochet-model","version":"1.0"). Generate the 3D model at runtime FROM that JSON with the reference builder below; never hard-code geometry outside the JSON. Whenever I ask for a change, edit the JSON and add 1 to "revision". Keep every key that starts with "x-" (such as "x-cpg") exactly as it is. Never put "<" or curly braces inside JSON string values.
4. mesh.name = part id, material.name = color id, mesh.userData.crochet = that part's JSON object, and the model group's userData.crochetModel = the whole spec (so the GLB download carries it).
5. UI: keep the stage's "Download GLB" and "Download OBJ + MTL" buttons. Add buttons Front / Left / Back / Top (move the camera, never the model), "Exploded view", and "Copy crochet spec" (navigator.clipboard.writeText of the pretty-printed JSON; if that fails, show the JSON in a selectable textarea). No Tweaks panel, no other libraries, no external images.
6. If three.js cannot load in this environment, still embed the JSON and draw front, side and top views from it as inline SVG.
7. Name the file "{{SLUG}} crochet model.html" and use <three-d-stage name="{{SLUG}}">. Keep the spec only in the page (and in your reply, rule 8): do not save separate copies of the JSON in the project.
8. When you finish (and after every later change), reply with a short list of assumptions and the full final JSON in ONE ```json code block.

# Reference builder (keep these semantics; you may restyle the page)
```js
{{BUILDER_JS}}
```
````

Filling rules:
- Flags: `PHOTOS` / `NO_PHOTOS` (photos in the project and attached), `FREE_TEXT` (`q_notes` answer non-empty after
  trimming), `REJECTED` (`q_reject` answered), `W`/`D` (width/depth given), `FLAT_BASE`, `UNDER3`.
- `YARN_NAME`, `CYC`, `HOOK_MM` come from the project gauge as the user set it (`q_size`, F2/F3 step 5 or the Yarn &
  size panel), never from a silent default; `STS_PER_IN = 1/w` from Table E or the test ball.
- `MIN_FEATURE_IN = 6/(π · STS_PER_IN)` (worsted at 5.1 sts/in ⇒ 0.37 in); `MAX_PARTS = 25`.
- `STYLE_SENTENCE`: chibi "head about 40–50% of the total height, eyes halfway to two-thirds down the head";
  true-to-photo "proportions as in the photos"; minimal "as few parts as possible, simple rounded shapes".
- `PARTS_LINES`: one line per seed part, e.g. `- head: ellipsoid, ~45% of total height, color c1, sewn on top of body`.
  `PALETTE_LINES`: `- c1 #C8A27A tan (main)`. `PATTERN_LINES`/`FEATURE_LINES` from regions/features.
- `SEED_JSON`: the seed without app-only fields (`crochet`, `paint`; `mesh` parts are converted to their fitted
  primitive/lathe or bounding ellipsoid first, §3.3), pretty-printed; every non-root part carries `attach`; the
  `x-cpg` key (§3.3 step 5) stays.
- User free text is escaped: `{{` → `{ {`, `<` → `‹`, `</script` removed; quotes kept.
- Record `promptVersion: 'prompt-v1'` and `builderVersion: 'builder-v1'` in the project's Q&A state.

#### 3.4.1 Shared reference builder (`builder-v1`, Step 0 kernel `src/core/model/builder.ts`)

Our app renders every model with the same function (`unitScale = 1`, inches); the prompt embeds the plain-JS form
(`unitScale = 0.0254`). Region painting is limited to band, stripes, patch and spot (pattern regions are rendered
by the app only). Every geometry is centered on the part's local origin except `LatheGeometry`, which is **not**
re-centered: a lathe's origin (its `position`) is the axis point at profile y = 0 (§0.1). `builder-v1` keeps this;
re-centering lathes would be `builder-v2` with a schema MINOR bump.

```js
import * as THREE from 'three';
const D2R = THREE.MathUtils.degToRad;
export function buildModel(spec, unitScale = 0.0254) {
  const S = unitScale, pal = Object.fromEntries(spec.palette.map(c => [c.id, c.hex])), mats = {};
  const solid = id => mats[id] ??= Object.assign(new THREE.MeshStandardMaterial({ color: pal[id] ?? '#cccccc', roughness: 0.85, metalness: 0 }), { name: id });
  const group = new THREE.Group(); group.name = spec.name || 'model'; group.userData.crochetModel = spec;
  for (const p of spec.parts) {
    const g = geometryFor(p, S); let mat = solid(p.color);
    if (p.regions?.length) { paint(g, p, pal, S); mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, name: p.color + '_painted' }); }
    const m = new THREE.Mesh(g, mat); m.name = p.id; m.userData.crochet = p;
    m.position.set(...p.position.map(v => v * S));
    const r = (p.rotationDeg ?? [0, 0, 0]).map(D2R); m.rotation.set(r[0], r[1], r[2], 'XYZ');
    group.add(m);
  }
  return group;
}
function geometryFor(p, S) {
  const d = p.dims;
  switch (p.type) {
    case 'sphere':    return new THREE.SphereGeometry(d.r * S, 48, 32);
    case 'ellipsoid': return new THREE.SphereGeometry(1, 48, 32).scale(d.rx * S, d.ry * S, d.rz * S);
    case 'capsule':   return new THREE.CapsuleGeometry(d.r * S, Math.max(0, d.length - 2 * d.r) * S, 12, 32);
    case 'cylinder':  return new THREE.CylinderGeometry(d.rTop * S, d.rBottom * S, d.h * S, 48, 1, d.open === 'both');
    case 'cone':      return new THREE.ConeGeometry(d.r * S, d.h * S, 48);
    case 'torus':     return new THREE.TorusGeometry(d.R * S, d.r * S, 24, 64, D2R(d.arcDeg ?? 360));
    case 'lathe':     return new THREE.LatheGeometry(d.profile.map(([r, y]) => new THREE.Vector2(r * S, y * S)), 48);
    case 'box':       return new THREE.BoxGeometry(d.w * S, d.h * S, d.d * S, 4, 4, 4);
    case 'flat': { const t = d.thickness * S;
      return new THREE.ExtrudeGeometry(shape2D(d, S), { depth: t * 0.4, bevelEnabled: true, bevelThickness: t * 0.3,
        bevelSize: Math.min(t * 0.3, 0.1 * Math.min(d.w, d.h) * S), bevelSegments: 4, curveSegments: 32 }).center(); }
  }
  throw new Error('unknown part type ' + p.type);
}
function shape2D(d, S) {                                 // local XY plane, facing +Z
  const w = d.w * S, h = d.h * S, s = new THREE.Shape();
  if (d.shape === 'circle' || d.shape === 'oval') s.absellipse(0, 0, w / 2, h / 2, 0, Math.PI * 2);
  else if (d.shape === 'teardrop') { s.moveTo(0, h / 2); s.bezierCurveTo(w * .55, 0, w * .5, -h / 2, 0, -h / 2); s.bezierCurveTo(-w * .5, -h / 2, -w * .55, 0, 0, h / 2); }
  else if (d.shape === 'triangle') { s.moveTo(0, h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(-w / 2, -h / 2); s.closePath(); }
  else if (d.shape === 'polygon') { d.points.forEach(([x, y], i) => i ? s.lineTo(x * S, y * S) : s.moveTo(x * S, y * S)); s.closePath(); }
  else { s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2, h / 2); s.lineTo(-w / 2, h / 2); s.closePath(); }
  return s;
}
function paint(g, p, pal, S) {                           // regions → vertex colors, part-local frame
  g.computeBoundingBox(); const bb = g.boundingBox, ctr = bb.getCenter(new THREE.Vector3());
  const pos = g.attributes.position, col = new Float32Array(pos.count * 3), v = new THREE.Vector3(), c = new THREE.Color();
  const H = Math.max(1e-6, bb.max.y - bb.min.y);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const t = (v.y - bb.min.y) / H, dx = v.x - ctr.x, dy = v.y - ctr.y, dz = v.z - ctr.z, rad = Math.hypot(dx, dy, dz) || 1e-6;
    const az = Math.atan2(dx, dz) * 180 / Math.PI; let id = p.color;
    for (const r of p.regions) {
      const inT = t >= (r.from ?? 0) && t <= (r.to ?? 1);
      if (r.kind === 'band' && inT) id = r.color;
      else if (r.kind === 'stripes' && inT) id = r.colors[Math.floor((v.y - bb.min.y) / (r.widthIn * S)) % r.colors.length];
      else if (r.kind === 'patch' && inT && Math.abs((((az - r.azimuthDeg) % 360) + 540) % 360 - 180) <= r.spanDeg / 2) id = r.color;
      else if (r.kind === 'spot') { const a = D2R(r.azimuthDeg), e = D2R(r.elevationDeg);
        const dot = (dx * Math.cos(e) * Math.sin(a) + dy * Math.sin(e) + dz * Math.cos(e) * Math.cos(a)) / rad;
        if (Math.acos(Math.min(1, dot)) * rad <= r.radiusIn * S) id = r.color; }
    }
    c.set(pal[id] ?? '#cccccc'); col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;   // set() converts sRGB → linear
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
// page glue: const stage = document.querySelector('three-d-stage'); await stage.ready;
// stage.setObject(buildModel(JSON.parse(document.getElementById('crochet-model').textContent)));
```

Units in exports: with `unitScale = 0.0254` Claude's page builds in meters, as `three-d-stage.js` asks ("Model in
real-world meters … exports inherit the scene's units"), so its GLB and OBJ + MTL downloads are in **meters**; only
the JSON (page block, chat reply, GLB `extras`) is in inches. The importer handles both (§3.7.5).

#### 3.4.2 Fix-up message (versioned `fixup-v1`)

For a Claude Design page that hard-codes its geometry or lost the `#crochet-model` block (importer E8), and for any
low-confidence import, the Import step offers **Copy fix-up message**; the button is also always on F4 step 4. The
text is short and self-contained (it works even if Claude no longer has our first message in view):

```text
Please add the crochet-model JSON block to the page exactly as in rule 3 of my first message: in <head>, <script type="application/json" id="crochet-model"> with "schema":"crochet-model","version":"1.0", inches, absolute positions, +Y up, front +Z, every non-root part with "attach":{"to":"<parent id>"}. Build it from the current model, keep every part id and every "x-" key, add 1 to "revision", and print the whole JSON in one ```json code block.
```

The version is recorded in `QaState.fixupVersion` like `prompt-v1`; copying the message sets the project back to
"waiting for Claude Design" (`awaiting.via = 'fixup'`). Test (T7): the text has no unfilled markers and stays under
600 characters; `import.spec` copies it from an E8 result (§6.4).

### 3.5 The `crochet-model` schema, version 1.0

#### 3.5.1 Types (authoritative; mirrored by a zod schema in `src/core/model/schema.ts`)

`Part` is a **discriminated union on `type`**. The zod mirror uses `z.discriminatedUnion('type', …)` with
`z.strictObject` for every object (dims, regions, features, hints): a plain `z.union` of stripping objects returns the
first branch that passes and silently drops fields (verified with zod 4.6.5: capsule `{r, length}` → `{r}`, cone
`{r, h}` → `{r}`, torus `{R, r, arcDeg}` → `{r}`). `x-*` extension keys (model and part level) are lifted out
before parsing and re-attached afterwards by a `withExtensions(schema)` wrapper; any other unknown key is a
validation error, so the importer strips and logs unknown keys during normalization (§3.7.6) before validating.
Step 0 tests assert `schema.parse(x)` deep-equals `x` for the §3.6 example, the canonical teddy
(`fixtures/models/teddy.canonical.json`) and a generated model containing every part type, region kind and feature
kind, with `x-*` keys.

```ts
export type Hex = string;                                   // /^#[0-9a-fA-F]{6}$/
export type Vec3 = [number, number, number];
export type PartType = Part['type'];                        // 'mesh' is app-internal, never sent to Claude Design

export interface CrochetModelV1 {
  schema: 'crochet-model'; version: string;                 // /^1\.\d+$/ — writer emits "1.0"
  revision: number;                                         // +1 on every edit; importer prefers the highest
  units: 'in'; axes: { up: '+Y'; front: '+Z'; left: '+X' };
  name: string; description?: string;
  category?: 'quadruped' | 'biped' | 'bird' | 'sea' | 'insect' | 'person' | 'creature' | 'food' | 'plant' | 'object' | 'other';
  style?: 'chibi' | 'realistic' | 'minimal';
  audience?: 'adult' | 'child' | 'under3';                  // under3 ⇒ embroidered features only
  finishedSize: { height: number; width?: number; depth?: number };       // bounding box, inches, 0 < h ≤ 60
  pose?: 'standing' | 'sitting' | 'lying' | 'hanging' | 'free'; flatBase?: boolean;
  yarn?: { weightCYC?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; hookMm?: number; stsPerIn?: number; fiber?: string };
  palette: PaletteColor[];                                  // 1..16
  parts: Part[];                                            // 1..60
  features?: Feature[];                                     // 0..60
  assembly?: { order: number; part: string; to?: string; text: string }[];
  assumptions?: string[];
  source?: { tool?: string; stage?: 'seed' | 'refined' | 'edited' | 'recon' | 'refined-from-mesh';
             views?: string[]; createdAt?: string; promptVersion?: string; builderVersion?: string };
  [k: `x-${string}`]: unknown;                              // extensions: kept, never rejected; our seeds carry
                                                            // "x-cpg": { project: string; seedRev: number } (§3.3)
}
export interface PaletteColor { id: string /* /^[a-z0-9_]{1,16}$/ */; hex: Hex; name?: string; role?: 'main' | 'accent' | 'detail' }
interface PartCommon {
  id: string;                                               // /^[a-z][a-z0-9_]{0,31}$/, unique; pairs end _l / _r
  label?: string;
  position: Vec3;                                           // ABSOLUTE model-space local origin, inches: the center for
                                                            // every type except lathe (axis point at profile y = 0)
  rotationDeg?: Vec3;                                       // Euler XYZ, degrees
  color: string;                                            // palette id (base color)
  regions?: Region[];                                       // ≤ 24
  attach?: { to: string; method?: 'sewn' | 'crochet-in-place' | 'worked-from' | 'glued' | 'none'; openEnd?: 'top' | 'bottom' | 'none' };
  mirrorOf?: string; stuffing?: 'firm' | 'medium' | 'light' | 'none'; flatten?: number /* 0..1 */;
  notes?: string;
  crochet?: PartCrochetHints;                               // app-owned (editor); stripped from prompts
  paint?: { kind: 'uv64'; data: string };                   // app-owned: base64 of 64×64 Uint8 palette indices, 255 = none
  [k: `x-${string}`]: unknown;
}
export type Part = PartCommon & (
  | { type: 'sphere';    dims: { r: number } }
  | { type: 'ellipsoid'; dims: { rx: number; ry: number; rz: number } }                 // radii
  | { type: 'capsule';   dims: { r: number; length: number } }                          // TOTAL length incl. caps (≥ 2r)
  | { type: 'cylinder';  dims: { rTop: number; rBottom: number; h: number; open?: 'none' | 'top' | 'bottom' | 'both' } }
  | { type: 'cone';      dims: { r: number; h: number } }                               // apex +Y
  | { type: 'torus';     dims: { R: number; r: number; arcDeg?: number } }              // ring in local XY
  | { type: 'lathe';     dims: { profile: [number, number][]; sharp?: number[] } }      // [radius, y] bottom→top, r ≥ 0, y non-decreasing, 3..64 pts
  | { type: 'flat';      dims: { shape: 'circle' | 'oval' | 'teardrop' | 'triangle' | 'rect' | 'polygon';
                                 w: number; h: number; thickness: number; points?: [number, number][] } }  // local XY, faces +Z
  | { type: 'box';       dims: { w: number; h: number; d: number } }
  | { type: 'mesh';      dims: { meshRef: string; bboxIn: Vec3 } });                    // app-internal; vertices part-local, origin = bbox center
export type Dims = Part['dims'];
export interface PartCrochetHints {
  make?: 'auto' | 'piece' | 'applique' | 'embroidery' | 'safety_eye' | 'region' | 'skip';
  start?: 'auto' | 'bottom' | 'top'; axis?: 'auto' | 'x' | 'y' | 'z'; seed?: Vec3 /* part-local, mesh parts */;
  style?: 'classic' | 'exact'; seamAzimuthDeg?: number;
}
export type Region =
  | { kind: 'band'; from: number; to: number; color: string }
  | { kind: 'stripes'; from?: number; to?: number; colors: string[]; widthIn: number }
  | { kind: 'patch'; azimuthDeg: number; spanDeg: number; from: number; to: number; color: string }
  | { kind: 'spot'; azimuthDeg: number; elevationDeg: number; radiusIn: number; color: string }
  | { kind: 'pattern'; pattern: 'spots' | 'leopard' | 'checker' | 'speckle' | 'gradient' | 'vertical-stripes';
      colors: string[]; scaleIn?: number; coverage?: number; from?: number; to?: number };
export interface Feature {
  id: string; kind: 'safety_eye' | 'embroidered_eye' | 'felt' | 'nose' | 'mouth' | 'cheek' | 'brow' | 'whiskers' | 'line' | 'applique';
  on: string; azimuthDeg: number; elevationDeg: number;     // on that part's surface, part-local frame
  sizeMm?: number; sizeIn?: number; color?: string;
  path?: [number, number][];                                // [az, el] polyline (embroidery)
  mirror?: boolean;                                         // also place at −azimuth
}
```

#### 3.5.2 Semantics and limits

- Primitive frames follow three.js r184/r186: sphere, cylinder, cone, capsule, lathe have their axis on local Y; the
  cone apex is +Y; the torus ring lies in local XY; `flat` lies in local XY facing +Z; the builder (§3.4.1) is the
  reference for every dimension.
- Region `from/to` = height fraction along local Y (0 = bottom); azimuth 0° = +Z, +90° = +X; elevation +90° = +Y.
- Limits: parts ≤ 60, palette ≤ 16, regions/part ≤ 24, features ≤ 60, profile points 3–64, polygon points 3–64,
  dims 0.05–48 in, text fields ≤ 2 000 chars, whole document ≤ 2 MB, nesting depth ≤ 12.
- Versioning: the importer accepts `1.x`; during normalization it strips unknown keys (each logged as a warning)
  and keeps `x-*` keys, then validates strictly. New types/kinds bump MINOR and map
  through an alias table (`egg/oval/ovoid → ellipsoid`, `ball → sphere`, `bean/pill → capsule`, `tube/disc → cylinder`,
  `ring/donut → torus`, `dome/hemisphere/pear → lathe`, `plate/leaf/wing → flat`; anything else → bounding ellipsoid
  + warning). Breaking changes become `2.0` with `migrate_1_to_2()`.
- JSON Schema: `npm run schema` (`tsx scripts/gen-schema.ts`) writes `docs/schema/crochet-model-1.0.schema.json` from
  zod (`z.toJSONSchema`, `$id: urn:crochet-pattern-generator:crochet-model:1.0`, draft 2020-12; parts as `oneOf`
  branches keyed by `type` const; model and part objects get `additionalProperties: false` plus
  `patternProperties: {"^x-": {}}`); a test asserts the committed file equals the generated one.

### 3.6 Complete example

```json
{
  "schema": "crochet-model", "version": "1.0", "revision": 3, "units": "in",
  "axes": { "up": "+Y", "front": "+Z", "left": "+X" },
  "name": "Clover the bunny", "description": "Sitting chibi bunny with a cream belly",
  "category": "quadruped", "style": "chibi", "audience": "child",
  "finishedSize": { "height": 7.6, "width": 3.5, "depth": 4.4 }, "pose": "sitting", "flatBase": true,
  "yarn": { "weightCYC": 4, "hookMm": 3.5, "stsPerIn": 5.1, "fiber": "acrylic" },
  "palette": [
    { "id": "c1", "hex": "#C8A27A", "name": "tan", "role": "main" },
    { "id": "c2", "hex": "#F4EBDD", "name": "cream", "role": "accent" },
    { "id": "c3", "hex": "#F2A7B5", "name": "pink", "role": "accent" },
    { "id": "c4", "hex": "#222222", "name": "black", "role": "detail" }
  ],
  "parts": [
    { "id": "body", "label": "Body", "type": "lathe",
      "dims": { "profile": [[0,0],[1.1,0.05],[1.55,0.6],[1.6,1.4],[1.35,2.4],[0.9,3.0],[0,3.2]] },
      "position": [0, 0, 0], "color": "c1", "stuffing": "firm",
      "regions": [{ "kind": "patch", "azimuthDeg": 0, "spanDeg": 110, "from": 0.1, "to": 0.75, "color": "c2" }] },
    { "id": "head", "label": "Head", "type": "ellipsoid", "dims": { "rx": 1.35, "ry": 1.2, "rz": 1.25 },
      "position": [0, 4.3, 0.1], "color": "c1", "stuffing": "firm",
      "attach": { "to": "body", "method": "sewn", "openEnd": "none" } },
    { "id": "ear_l", "label": "Left ear", "type": "flat",
      "dims": { "shape": "teardrop", "w": 0.9, "h": 2.2, "thickness": 0.3 },
      "position": [0.55, 6.5, 0], "rotationDeg": [0, 0, -10], "color": "c1", "flatten": 1, "stuffing": "none",
      "regions": [{ "kind": "band", "from": 0.15, "to": 0.85, "color": "c3" }],
      "attach": { "to": "head", "method": "sewn", "openEnd": "bottom" } },
    { "id": "ear_r", "label": "Right ear", "mirrorOf": "ear_l", "type": "flat",
      "dims": { "shape": "teardrop", "w": 0.9, "h": 2.2, "thickness": 0.3 },
      "position": [-0.55, 6.5, 0], "rotationDeg": [0, 0, 10], "color": "c1", "flatten": 1, "stuffing": "none",
      "regions": [{ "kind": "band", "from": 0.15, "to": 0.85, "color": "c3" }],
      "attach": { "to": "head", "method": "sewn", "openEnd": "bottom" } },
    { "id": "arm_l", "label": "Left arm", "type": "capsule", "dims": { "r": 0.32, "length": 1.4 },
      "position": [1.3, 2.2, 0.75], "rotationDeg": [-20, 0, 25], "color": "c1", "stuffing": "light",
      "attach": { "to": "body", "method": "sewn", "openEnd": "top" } },
    { "id": "arm_r", "label": "Right arm", "mirrorOf": "arm_l", "type": "capsule", "dims": { "r": 0.32, "length": 1.4 },
      "position": [-1.3, 2.2, 0.75], "rotationDeg": [-20, 0, -25], "color": "c1", "stuffing": "light",
      "attach": { "to": "body", "method": "sewn", "openEnd": "top" } },
    { "id": "foot_l", "label": "Left foot", "type": "ellipsoid", "dims": { "rx": 0.45, "ry": 0.35, "rz": 0.7 },
      "position": [0.7, 0.35, 1.3], "color": "c1", "stuffing": "medium",
      "regions": [{ "kind": "spot", "azimuthDeg": 0, "elevationDeg": 0, "radiusIn": 0.3, "color": "c3" }],
      "attach": { "to": "body", "method": "sewn" }, "crochet": { "make": "piece", "style": "classic" } },
    { "id": "foot_r", "label": "Right foot", "mirrorOf": "foot_l", "type": "ellipsoid",
      "dims": { "rx": 0.45, "ry": 0.35, "rz": 0.7 }, "position": [-0.7, 0.35, 1.3], "color": "c1", "stuffing": "medium",
      "regions": [{ "kind": "spot", "azimuthDeg": 0, "elevationDeg": 0, "radiusIn": 0.3, "color": "c3" }],
      "attach": { "to": "body", "method": "sewn" } },
    { "id": "tail", "label": "Tail", "type": "sphere", "dims": { "r": 0.5 },
      "position": [0, 0.8, -1.96], "color": "c2", "stuffing": "medium", "attach": { "to": "body", "method": "sewn" } }
  ],
  "features": [
    { "id": "eye_l", "kind": "safety_eye", "on": "head", "azimuthDeg": 30, "elevationDeg": -10, "sizeMm": 9, "color": "c4", "mirror": true },
    { "id": "nose", "kind": "nose", "on": "head", "azimuthDeg": 0, "elevationDeg": -22, "sizeIn": 0.25, "color": "c3" },
    { "id": "mouth", "kind": "mouth", "on": "head", "azimuthDeg": 0, "elevationDeg": -30, "color": "c4",
      "path": [[-8, -28], [0, -32], [8, -28]] }
  ],
  "assembly": [
    { "order": 1, "part": "head", "to": "body", "text": "Sew the head to the top of the body, centered." },
    { "order": 2, "part": "ear_l", "to": "head", "text": "Sew the ears to the top of the head, 1 in apart." },
    { "order": 3, "part": "arm_l", "to": "body", "text": "Sew the arms to the sides, just below the neck." }
  ],
  "assumptions": ["Arms are short nubs; the photo shows them tucked against the body."],
  "source": { "tool": "claude-design", "stage": "refined", "views": ["front", "left"],
              "createdAt": "2026-10-01T12:00:00Z", "promptVersion": "prompt-v1", "builderVersion": "builder-v1" }
}
```

### 3.7 Importer contract (R6)

#### 3.7.1 API (runs in `import.worker`; no DOM anywhere in `core/importer`)

```ts
type ImportInput = { kind: 'file'; name: string; bytes: ArrayBuffer } | { kind: 'text'; text: string };
type LengthUnit = 'in' | 'cm' | 'm' | 'mm';
interface ImportContext {
  expectedHeightIn?: number;   // the target project's seed finishedSize.height, else its Yarn & size height (§3.7.5)
  pickCandidate?: string;      // SpecCandidate.id chosen in the "versions" picker (§3.7.2)
  units?: LengthUnit;          // the user's answer to the units confirm of a geometry-only carrier (§3.7.5)
}
interface SpecCandidate { id: string; path: string; source: 'html' | 'glb' | 'chat' | 'json';   // archive entry
  revision: number; parts: number; chosen: boolean }
interface UnitsDecision { rawHeight: number; readings: { unit: LengthUnit; heightIn: number }[];
  chosen: LengthUnit | 'normalized'; reason: 'spec' | 'gltf-extras-ratio' | 'expected-height' | 'stage-header'
  | 'small-bbox' | 'user'; confirm: boolean }            // confirm = ask the user, showing both readings
interface Repair { code: 'attach-inferred' | 'mirror-inferred' | 'units' | 'ground' | 'axes' | 'radians' | 'color'
                       | 'dims-clamped' | 'id' | 'unknown-key' | 'feature-dropped' | 'limits' | 'versions';
                   message: string; part?: string; data?: Record<string, unknown> }   // one "auto-corrected" chip each
interface ImportResult {
  ok: boolean; model?: CrochetModelV1; meshes?: Record<string, ColoredMesh>;     // mesh parts, keyed by meshRef
  carrier: 'text' | 'json' | 'html' | 'standalone-html' | 'zip' | 'tar' | 'glb' | 'gltf' | 'obj' | 'ply' | 'stl' | 'image';
  dialect: 'canonical-1' | 'cd-observed-2026-09' | 'geometry-only';
  confidence: 'high' | 'medium' | 'low'; repairs: Repair[]; warnings: Issue[]; fingerprint: string[];
  candidates?: SpecCandidate[];                          // every spec found in an archive (§3.7.2)
  units?: UnitsDecision;                                 // geometry carriers (§3.7.5)
  cpgTag?: { project: string; seedRev: number };         // the model's "x-cpg", for the return path (§3.7.7)
  images?: ArrayBuffer[];                                // when only pictures were found (offer F3)
}
function importInputs(inputs: ImportInput[], ctx?: ImportContext): Promise<ImportResult>;
```

`DOMParser` exists only on `Window`, not in dedicated workers (verified in the installed Chromium 1243) or in the
vitest `node` environment, so HTML is read by the worker-safe tokenizer of §3.7.4. Importer unit tests run in the
`node` environment so DOM globals cannot mask a worker failure; `e2e/tracks/t7-import-worker.spec.ts` runs every G12 carrier
through the real `import.worker`.

#### 3.7.2 Detection and strategy (magic bytes first, extension second; a single file stops at its first valid spec, an archive collects every spec)

| Input | Detection | Strategy |
|---|---|---|
| pasted text, `.txt`, `.md` | text | last ` ```json ` fence containing `"crochet-model"` → brace-matched object matching `/"schema"\s*:\s*"crochet-model"/` (whitespace-tolerant; the fixture writes `"schema": "crochet-model"`); normalize smart quotes, BOM, zero-width chars; `JSON.parse`, then JSON5 |
| `.json` | `{` | `schema == "crochet-model"` → spec; glTF JSON (`asset.version`) → glTF path; `.crochet.json` (§5.5.3) → project import |
| `.html`, `.htm`, `.dc.html` | `<!doctype`, `<html`, `<script` | HTML ladder §3.7.4 |
| `.zip` | `PK\x03\x04` | fflate `unzipSync` (filtered); **collect every spec candidate** (below), and only when there is none fall back to geometry `.glb/.gltf` › `.obj+.mtl` › `.ply/.stl` › images. Teddy archive: flat `Amigurumi Teddy Bear.html` + `three-d-stage.js` + `.thumbnail` |
| `.tar.gz`, `.tgz` (handoff bundle) | `1F 8B` then `ustar` at 257 | `gunzipSync` + 60-line ustar reader; same candidate rule; no `project/` ⇒ "Claude was still waiting for your answer — reply in Claude Design and re-export" |
| `.glb` | `glTF`, version 2 | §3.7.5 |
| `.gltf` (+ `.bin`) | JSON with `asset` | as GLB; sibling files from the same drop or zip |
| `.obj` (+ `.mtl`) | `v `/`f `/`o ` lines; `newmtl` | §3.7.5 |
| `.ply`, `.stl` | `ply\n`; binary `84 + 50n` bytes or `solid … facet` | three's PLYLoader/STLLoader → geometry path |
| `.png`, `.jpg`, `.webp` | magic | offer F3 (the stage background `#f0eee6`/`#f4efe6` segments easily) |
| `.pdf`, `.pptx` | `%PDF-` / zip with `ppt/` | v1.1 (text search for the JSON, else images) |
| folder drop | `webkitGetAsEntry` | as zip |

**Spec candidates in an archive** (zip, tar, folder, or several files dropped together). v1.1 ranked a
`crochet-model.json` above the HTML and stopped at the first valid spec, so a side file that Claude did not rewrite
after "make the ears bigger" won over the page the user had just looked at. Now every candidate is parsed and
normalized: each `*.html` (ladder E1–E4, §3.7.4; one candidate per page), each `*.json` whose `schema` is
`crochet-model` (wherever it sits), each `*.glb`/`*.gltf` carrying `extras.crochetModel` (GLB ladder step 1,
§3.7.5), and the last ` ```json ` fence holding `"crochet-model"` in `README.md` and in each `chats/*.md`. The
importer picks the **highest `revision`**; ties → the HTML page (it is what was rendered) › a GLB spec › a chat
fence › a JSON file, then the newest entry time, then the handoff `open_file` hint. When the candidates differ
(revision, or a normalized-spec hash), a `versions` repair chip says "2 versions found: file rev 1, page rev 2 —
using rev 2" and opens a picker; picking re-runs the import with `ctx.pickCandidate` (`ImportResult.candidates`
lists them all). Identical candidates are silently merged. Prompt rule 7 no longer asks for a side file (§3.4), but
other prompts, older projects and handoff bundles can still contain one.

#### 3.7.3 Dialect normalization (observed Claude Design output) [08]

Detected when parts use `dimensions` (not `dims`), `palette` is an object, or any part has `parent`.

| Observed | Canonical |
|---|---|
| `dimensions` | `dims`; keys `radius → r`, `radiusTop/radiusBottom → rTop/rBottom`, `height → h` |
| capsule `{ radius, length }` (length = straight section) | `{ r, length: length + 2·radius }` (total) |
| `palette: { "#B07A4A": "caramel_yarn", … }` | `[{ id: slug(name) ≤ 16 chars (deduped), hex, name }]` |
| part `color: "#hex"` | palette id by case-insensitive hex; unknown hex → new palette entry |
| `name` | `label` |
| `parent` + parent-relative `position`/`rotationDeg` | absolute: `World = World(parent) · T(position) · R_XYZ(rotationDeg)`; children are not scaled by parents; decompose to absolute position + Euler XYZ; `attach = { to: parent, method: 'sewn' }` |
| `parent: null` on a non-root part | no `attach` yet — the attach tree is completed by `inferAttach` (§3.7.6), which runs for every carrier |
| eye-like parts (§2.10.1) | kept as parts with `crochet.make = 'safety_eye'` |
| missing `axes.left`, `revision` | `'+X'`, 0; `source = { tool: 'claude-design', stage: 'refined' }` |
| top-level `notes` and other unknown keys | stripped with an `unknown-key` repair (text kept in `assumptions`) |

Golden (teddy fixture, before grounding, ±1e-3): muzzle `[0, 6.6, 1.9]`; nose `[0, 6.9, 2.42]`; eye_l
`[0.78, 7.45, 2.02]` (azimuth 22.1°, elevation 6.9° from the head center); ear_l `[1.6, 8.95, −0.1]` rot
`[0, 0, −28]`; ear_l_inner `[1.5765, 8.9059, 0.16]` rot `[0, 0, −28]`; foot_pad_l `[1.4411, 0.9706, 2.6061]` rot
`[82, 0, −12]`; leg_l capsule total length 3.1. Grounding then shifts every part by +0.0789 (leg tips at y = −0.0789).
After the repairs of §3.7.6 (golden, every carrier): **one tree rooted at `body`** — head, arm_l, arm_r, leg_l, leg_r
and tail attached to body by inference (6 `attach-inferred` chips; overlap volumes ≈ head 0.07, legs 1.34, arms
0.64, tail 0.11 in³, ±15%); muzzle, eye_l, eye_r, ear_l, ear_r → head; nose → muzzle; ear_l_inner → ear_l;
ear_r_inner → ear_r; foot_pad_l → leg_l; foot_pad_r → leg_r (from `parent`); `mirrorOf` inferred for ear_r, ear_r_inner,
eye_r, arm_r, leg_r, foot_pad_r → their `_l` twins (6 `mirror-inferred` chips). The canonical result is committed as
`fixtures/models/teddy.canonical.json` (Step 0) and the plan of §2.10.1 is computed from it.

#### 3.7.4 HTML extraction ladder

All HTML is read by **`core/importer/html.ts`, a worker-safe tokenizer** (no DOM, no new dependency):
- Scan left to right: `<!--` skips to `-->`; `<script` (case-insensitive, followed by whitespace, `/` or `>`) starts a
  script element; `<style`, `<textarea`, `<title` are skipped to their own end tags (raw text); any other `<` + letter
  starts a tag whose attributes are read; everything else is text.
- Attributes: names `[^\s"'>/=]+` lowercased, values double-quoted, single-quoted or unquoted (`[^\s>]+`); values are
  entity-decoded (numeric `&#NNN;` / `&#xHH;` and named `amp lt gt quot apos nbsp`, plus a small table of common
  named entities; unknown names are kept verbatim and logged).
- A script's body is the **raw** text up to the next case-insensitive `</script` (never entity-decoded, as in HTML);
  the result is a list of `{ attrs, body }` scripts plus every `data-crochet-model` attribute value (decoded).

1. **E1 unbundle** when `__bundler/template` is present: take the tokenizer's `<script type="__bundler/template">`
   body, `JSON.parse` it (this undoes the `<\/` / `</` escaping) into the page HTML string and tokenize that
   string again; also decode `text/*`, `javascript`, `json`, `html` entries of the `__bundler/manifest` script (base64,
   `fflate.gunzipSync` when `compressed`). The app's module is renamed `<script type="text/x-app" id="app-src">` inside
   the template — search there too.
2. **E2 tokenized scripts:** a script with `id="crochet-model"`, then one with a `data-crochet-model` attribute (its
   body), then `type="application/vnd.crochet-model+json"`, then any element's decoded `data-crochet-model` value.
3. **E3 markers** `/*CROCHET-MODEL-BEGIN*/…/*CROCHET-MODEL-END*/`. **E4 brace scan** for
   `/"schema"\s*:\s*"crochet-model"/` (whitespace-tolerant; then the enclosing brace-matched object; JSON, then JSON5).
4. **E5/E6 sandbox runner (v1.1):** `public/sandbox.html` with its own CSP hosts a `sandbox="allow-scripts"` iframe
   (never `allow-same-origin`), injects the `__THREE_DEVTOOLS__` hook and download interception from 05 §7.3,
   polls for 15 s, caps 500 meshes / 500k vertices / 50 MB.
5. **E7 static heuristics (v1.1):** acorn parse of inline scripts; constant-fold `new THREE.*Geometry(...)`,
   `.position.set`, `.rotation.set`, material colors → low-confidence spec.
6. **E8:** fail with "no model found" and offer, first, **Copy fix-up message** (§3.4.2: send it in the same Claude
   Design project, then export again), then: paste the chat JSON, drop a GLB / OBJ + MTL export (geometry only,
   §3.7.5), or use a screenshot (F3). In v1, pages that hard-code geometry or drop the `#crochet-model` block land
   here because E5–E7 are v1.1, so the fix-up message is the main recovery. Any result with confidence `low` shows
   the same button next to its chips.

Imported markup never reaches our DOM (the tokenizer produces strings only). Fingerprints recorded for
diagnostics: `__bundler`, `<x-dc>`, `three-d-stage`, `text/babel`, `importmap`; an unknown fingerprint shows a
"format drift" warning. Tests (node environment): all three teddy HTML carriers (archive page, standalone
`__bundler` page, and the page inside the project-archive zip) yield the spec through E1/E2; an entity-escaped
`data-crochet-model` attribute and a `</SCRIPT>` closing tag in upper case parse via E2; JSON that appears only
inside a `<textarea>` is found by E4; a `<script id="crochet-model">` inside a comment is ignored.

#### 3.7.5 Geometry carriers

- **GLB:** read the 12-byte header and the JSON chunk (type `0x4E4F534A`) directly. Ladder (first match wins):
  1. any `nodes[].extras.crochetModel` → that spec (high; inches by definition). Our builder puts it on the model
     group (rule 4), which `GLTFExporter` writes as the extras of the stage's exported root node.
  2. nodes with `extras.crochet` (rule 4's per-mesh `userData.crochet`, i.e. the part's own JSON in inches) → the
     parts are taken from these objects as they are (positions and dims already absolute inches, node matrices
     ignored except as a check); palette from the solid materials (`name` = color id, `baseColorFactor` linear →
     sRGB), and for ids used only on painted parts the matching `COLOR_0` vertex color (the builder writes region
     colors per vertex), else gray with a `color` warning; `finishedSize` = the builder bbox; `revision` 0 (high;
     repair "spec rebuilt from per-part extras").
  3. nodes with `extras.{type, dimensions}` (observed dialect): node name = part id; world matrix = product of
     ancestor `matrix` (column-major) or TRS; type/dims via §3.7.3; color = material `baseColorFactor` **linear →
     sRGB** (medium). The scene's units are measured exactly: the ratio of the mesh's `POSITION` accessor extent
     (scene units) to the extent implied by `extras.dimensions` (spec units) gives scene units per spec unit (teddy
     fixture 1.0; a builder-v1 page 0.0254), and node translations are divided by it.
  4. geometry fit (low), with the geometry units rule below.
- **OBJ (+MTL):** parse in the worker (the fixture OBJ is 9.5 MB). One part per `o` (world-space vertices); `usemtl`
  names map to materials by prefix (the stage renames duplicates `_n`; builder-v1 names materials by color id and
  painted ones `<id>_painted`). If the MTL starts with `# Exported by three-d-stage`, **every `Kd` is linear** →
  convert to sRGB (the header alone decides colors; it does **not** decide units, see below). Without an MTL, colors
  come from the Q&A. Units are decided on the raw vertices (below), the vertices are scaled to inches, and only then
  is a primitive fitted per object (§2.9.7 step 4).
- **PLY:** vertex colors → labels; **STL:** no colors or names. Both: connected components → parts → units (below)
  → fit.
- **Units of geometry-only carriers** (OBJ, PLY, STL, GLB steps 3–4; v1.1 had no rule, so a builder-v1 export 0.25
  units tall was read as 0.25 in and the dims clamp then blew a 0.2 in eye up to ten times its size, a distortion
  "Scale model to height" cannot undo). Run **before fitting and before the dims clamp** of §3.7.6, on the raw bbox
  height `h` with readings `{in: h, cm: h/2.54, m: h·39.37, mm: h/25.4}` (in inches):
  1. GLB step 3: the exact accessor/extras ratio above (`reason: 'gltf-extras-ratio'`).
  2. `ctx.expectedHeightIn` = E known (from the target project's seed `finishedSize.height`, else its Yarn & size
     height; §3.7.7 re-runs the import with it once the project is known): pick the reading closest to E in
     `|ln(reading/E)|`; within ×/÷ 1.5 of E ⇒ automatic. At most one reading can qualify (they differ by ≥ 2.54×).
     None qualifies ⇒ uniform-scale to E (`chosen: 'normalized'`, 05 §7.3's "otherwise normalize to the user's
     target height") and confirm.
  3. No E: the three-d-stage MTL header and `h ≤ 1.524` (a meter reading within the schema's 60 in limit) ⇒ meters,
     because the stage documents meters (`reason: 'stage-header'`); otherwise `h < 1.5` ⇒ meters
     (`reason: 'small-bbox'`); both with the confirm pre-set to meters; otherwise inches. The observed teddy OBJ
     (header present, `h = 9.88`) stays inches: 9.88 m is 389 in.
  Every decision adds a `units` chip ("read as meters: 0.251 → 9.88 in"); `units.confirm` opens a dialog showing
  both readings ("0.25 in tall, or 9.9 in tall?"), whose answer re-runs the import with `ctx.units`.
- Mesh results that fail the fit become `mesh` parts (Path B).
- Geometry-only results (OBJ, PLY, STL, GLB without spec or hierarchy) have no attach graph: proximity gives it
  [05 §7.5 step 4] — the same `inferAttach` of §3.7.6, then the Step 0 `nameParts` (§2.9.7 step 6) when ids are
  generic.

#### 3.7.6 Repairs (each logged and shown as an "auto-corrected" chip) [05 §4.5]

Run for **every carrier** after dialect normalization, in this order: security and limits → ids → unknown keys →
units → radians → ground and axes → colors → dims and attach validity → `inferAttach` → `inferMirrorPairs` →
strict schema validation. Geometry-only carriers have already been converted to inches before fitting (§3.7.5),
so the units step below only re-checks them and the dims clamp never sees meter or millimeter values. The attach
and mirror kernels are Step 0 code (`core/model/attach.ts` on top of `core/model/sdf.ts`) shared with photo
reconstruction (§2.9.7 step 5) and the editor.

- **Analytic SDFs** (`core/model/sdf.ts`, positive inside, world space, builder semantics of §3.4.1): exact for
  sphere, capsule, cylinder, cone, box, lathe (2D distance to the profile in the meridian half-plane) and full torus;
  ellipsoid uses the standard bound `k0(k0 − 1)/k1` (exact sign); flat = the 2D outline SDF extruded by its
  thickness (bevel ignored); torus arcs and mesh parts (voxel SDF supplied by the caller) as noted. Helpers:
  `overlapVolume(a, b)` on a regular grid over the intersection of the two world bboxes (spacing min(0.025 in,
  smallest extent / 8), deterministic), `surfaceGap(a, b)` from the child's builder vertices.
- **`inferAttach`** (D21): parts that already have `attach` (from canonical specs or the dialect's `parent`) keep it;
  the existing links form a forest whose component roots are the parts without `attach`.
  *Root:* if exactly one part lacks `attach`, it is the root. Otherwise, among unattached parts whose world bbox
  reaches the lowest 10% of the model's height, the one with id or label `body`, else the largest by volume; if none
  reaches it, the largest unattached part. (Teddy: `body`, 43.5 in³ — the larger head, 47.6 in³, does not reach the
  bottom.) *Links* — grow the tree from the root (Prim's rule on overlap): the tree starts as the root's component;
  repeatedly take, over every component root `c` not yet in the tree and every part `p` in the tree, the pair with
  the **largest overlap volume** (ties within 1% → larger `c`, then id), set `c.attach = { to: p, method: 'sewn' }`
  and add `c`'s component to the tree. When no remaining pair overlaps, use the pair with the smallest surface gap
  (gap > 0.1 in raises `W_GAP`; > 0.25 in also says "this part floats … from …"). Growing outward from the root means
  a part never hangs from its own child — processing parts by size instead would attach the teddy's head to its
  muzzle (their overlap, 1.43 in³, exceeds head–body, 0.07 in³). The result is always **one tree**; on the teddy it is
  the canonical tree both from the dialect (6 links) and from the parentless OBJ (16 links). Each new link has no
  `openEnd` (trimming decides) and one `attach-inferred` chip; clicking a chip selects the part with the Attach tool
  open, where the user can re-parent it.
- **`inferMirrorPairs`:** for ids `X_l` / `X_r` (also `left`/`right` suffixes) with equal type and dims (±1e-6
  relative; ±10% for reconstructions), positions mirrored across x = 0 (±1e-3 in) and rotations `(a, b, c)` vs
  `(a, −b, −c)` (±0.5°), set `mirrorOf: 'X_l'` on `X_r` (one `mirror-inferred` chip). Teddy golden: §3.7.3.
- ids: slugify, dedupe with `_2`, fill missing; `*_l` with `mirrorOf`/notes and no `*_r` → synthesize the mirror.
- unknown keys: stripped (one `unknown-key` warning each), `x-*` keys kept.
- units (spec carriers, whose `finishedSize` is known): `ratio = bboxHeight / finishedSize.height`; ≈ 2.54 → cm,
  ≈ 0.0254 → m, ≈ 25.4 → mm (rescale); otherwise if `|ratio − 1| > 0.15` uniform-scale to `finishedSize.height`;
  else keep geometry and record the measured height (teddy: 9.88 vs 10 → kept). Geometry carriers: §3.7.5.
- ground: translate so min y = 0. axes: tallest along Z with `flatBase` → *offer* "rotate −90° about X".
- radians: every |rotation| ≤ 6.3 with a non-integer near k·π/12 → treat as radians (warn).
- colors: unknown palette id → nearest palette color by ΔE00, or add the inline hex.
- dims clamp to [0.05, 48]; warn below `MIN_FEATURE_IN`; `attach.to` must exist and be acyclic (a dangling or
  cyclic link is removed first and the part re-linked by `inferAttach`); parts with a gap > 0.1 in to their parent
  are flagged (`W_GAP`); features with a missing `on` are dropped; az/el clamped.
- limits §3.5.2; input ≤ 100 MB, ≤ 2 000 archive entries, ≤ 300 MB uncompressed, per-entry ratio ≤ 100:1, path depth
  ≤ 12, reject `..` and absolute paths, skip `__MACOSX/` and dotfiles.
- security: JSON reviver rejects `__proto__`, `constructor`, `prototype` keys anywhere; never `Object.assign` raw extras.

#### 3.7.7 After import

**Which project receives the result.** An import started inside a project (its banner, its Import tab, F4 step 4)
lands in that project. Start → **Import from Claude Design** first parses the input, then looks for the project the
prompt came from: (1) the result's `x-cpg.project` (`ImportResult.cpgTag`) names a project in the library ⇒
"Import into <project> (where you made the prompt)" is offered pre-selected; (2) otherwise, among projects that are
waiting for a result or produced a prompt in the last 30 days (`qa.awaiting` / `qa.generatedAt`), the one whose
stored seed has **≥ 60% of its part ids** present in the result (ties → most recent) is offered pre-selected; (3)
otherwise, if exactly one project is waiting, it is offered but not pre-selected. "New project" is always offered.
Importing into the project keeps its photos (so **Apply photo colors** is offered), diffs against its seed when
`cpgTag.seedRev` matches the stored seed (else against its current model), carries `crochet` and `paint` by id as
below, and re-runs a geometry-only import with that project's `expectedHeightIn` (§3.7.5). Accepting clears
`qa.awaiting`.

The UI shows carrier, dialect, confidence and repair chips, then a diff against the current model (parts
added/removed; dims changed > 2%; moved > 0.1 in; colors). **Accept** goes through `commitModelRevision` (§5.2.1):
a new model revision; the previous revision and the original file (as an asset) are kept. App-owned fields carry
over by part id: `crochet` hints always; **`paint` only when the part's type is unchanged and every dim is within
10%** — otherwise it stays in the previous revision, the diff lists "photo colors not carried: body, head" with a
per-part "Carry anyway", and (when the project has labeled photo views) the dialog offers **Apply photo colors**
(§2.9.6), which re-projects the stored photos onto the new shape. A uv64 field painted on a reconstructed body that
still contained the head would otherwise land on Claude's differently shaped body and color the wrong rounds.
After accepting, the **Yarn & size** panel (§4.5) opens, pre-filled from `model.yarn` when the project was created by
the import, or showing "Claude Design used CYC 4 / 3.5 mm — Use it" otherwise (never overwriting a user-set gauge
silently). Several versions in one archive: §3.7.2 (every candidate collected, highest `revision`, ties to the
page, a `versions` chip with a picker).

**Acceptance (fixtures in `fixtures/claude-design/teddy-bear/`):** the pasted JSON, `teddy-bear.project-archive.zip`,
`project-archive/Amigurumi Teddy Bear.html`, `teddy-bear.standalone.html` and `amigurumi-teddy-bear.glb` all yield
the same 17 parts (ids, types, dims ±1e-6, absolute transforms ±1e-4, palette hex; GLB colors ±1/255 after
linear→sRGB) and the same attach tree and mirror pairs (§3.7.3). `amigurumi-teddy-bear.obj.gz` (gunzipped) + `.mtl`
yields 17 parts with the same ids and colors, a bbox within 2% and the same attach tree (inferred by proximity). A
chat reply with prose around the fence, and HTML with entity-escaped JSON, give the same spec. The imported teddy
generates a pattern with **zero `E_*` errors** and the §2.10.1 plan.

**Derived fixtures** (`fixtures/claude-design/teddy-derived/`, written by T7's `scripts/make-cd-fixtures.mjs`; the
captured `teddy-bear/` folder stays read-only), part of G12/G26:
- `teddy-stale-side-file.zip`: the project archive with `"revision": 1` added to the page's JSON and a
  `crochet-model.json` at revision 0 whose ears are 20% smaller. Import returns revision 1 (ears unchanged), with
  the "2 versions found: file rev 0, page rev 1 — using rev 1" chip and both entries in `candidates`; picking the
  file returns revision 0.
- builder-v1 exports in **meters**: the script serves the archive's `three-d-stage.js` page locally in headless
  Chromium with the canonical teddy as its `#crochet-model` JSON and the §3.4.1 builder at `unitScale = 0.0254`
  (import map pointed at the local `node_modules/three`, no network), and saves what the stage's own Download
  buttons produce: `teddy-builder-v1.glb` (root `extras.crochetModel`), `teddy-builder-v1.noroot.glb` (same page
  with `group.userData.crochetModel` deleted, so only per-node `extras.crochet` remain), and
  `teddy-builder-v1.obj` + `.mtl` (stage header). Each yields the same 17 parts as `teddy.canonical.json` with a
  bbox within 2%; the OBJ is read as meters both with `expectedHeightIn = 10` and with no context (stage header,
  `h ≈ 0.25`), and the observed inch-valued teddy OBJ still reads as inches.
- Return path (T7 unit tests): a canonical spec with `x-cpg` naming an existing project offers that project; with no
  tag, a result holding ≥ 60% of a waiting project's seed ids offers it; 59% does not.
Unit tests run in the vitest `node` environment; `e2e/tracks/t7-import-worker.spec.ts` repeats the carrier checks
through the real `import.worker`.

---

## 4. The 3D adjustment editor (R7)

### 4.1 Layout

Shape tab = R3F viewport (center), **Parts** outliner as an attach tree (left), **Inspector** (right), tool bar
(top of the viewport), status strip (validation badges, ghost mismatch, worker activity). Cameras: perspective
orbit plus Front / Left / Back / Top buttons (move the camera, never the model). Units in the UI follow the
project (in/cm); the model stays in inches.

### 4.2 Tools

| Tool (key) | Behavior | Data written |
|---|---|---|
| Select (Q) | click a part; Shift adds; click empty deselects | UI state |
| Move (W) / Rotate (E) / Scale (R) | drei `TransformControls`; snap 0.05 in / 5° (hold ⇧ to disable). Move and Rotate apply rigidly to the selected part **and its attach subtree** (rotation about the part's center, §0.1); hold ⌥ to transform the part alone. Scaling a primitive edits its `dims` (non-uniform sphere → ellipsoid); scaling a mesh part bakes into vertices on release; children are **re-anchored** (below), not scaled | `position`, `rotationDeg`, `dims`, mesh asset (subtree positions/rotations) |
| Parameters | per-type numeric fields + sliders; lathe profile editor (2D polyline: drag, add, delete, toggle `sharp`); children re-anchored | `dims` |
| Proportions | panel: **head : body** slider (chibi 1:1 … realistic 1:3) and **limb length** chips (nubs · short · medium · long), both the Step 0 kernel `applyProportions` below (the Q&A `q_parts` controls call the same kernel); the slider and chips show the model's current values (`readProportions`) and are disabled with the kernel's reason when the parts are missing; one history step each | `dims`, positions (whole model) |
| Scale model to height | toolbar and Yarn & size panel: uniform scale of every part about the ground center (positions, dims, profiles, mesh vertices) to a typed height; one history step and a new model revision | whole model |
| Add part | choose a primitive, click on a part's surface: placed by the Step 0 kernel `placeChildOnSurface` (0.1 in overlap along the clicked normal), `attach.to` = that part | new `Part` |
| Duplicate (⌘D) / Delete (⌫) | duplicate offset +0.5 in X; delete asks, children re-attach to the deleted part's parent | parts |
| Mirror (M) | create/update `<id>_r` from `<id>_l` across x = 0 (x and rotation y, z negated), `mirrorOf` link; linked edits propagate until "Unlink" | parts |
| Attach | pick a new parent (cycles refused; the root has none; there is no "detach", so the model stays one tree); choose open end (top/bottom/none) and method; opened from an `attach-inferred` chip with that part selected | `attach` |
| Make as | auto · crocheted piece · flat appliqué · embroidery · safety eye · color of parent · skip | `crochet.make` |
| Start / axis | primitives: start pole (bottom/top), axis (auto/x/y/z), style (classic/exact); mesh parts: "pick start point" on the surface and a draggable seam handle | `crochet.*` |
| Sculpt (B) | mesh parts only ("Convert to sculptable mesh" for primitives): Inflate, Deflate, Smooth, Flatten; radius `[`/`]` 0.05–2 in, strength 0.05–1, X-symmetry toggle; kernels §2.9.8 in `mesh.worker` | mesh asset |
| Cut (C) | plane gizmo (position + normal), preview halves, Apply → two parts; "Split here" from a Path B `NeedsSplit` suggestion | parts, mesh assets |
| Merge (⌘J) | select ≥ 2 touching parts → one `mesh` part (`MeshApi.merge`, §2.9.8): keeps the id, attach and hints of the part nearest the root, re-attaches every child, carries both paints as vertex labels; then offers **Fit primitive**; one history step and a new model revision, undo restores both parts | parts, mesh assets |
| Fit primitive | mesh → best primitive with its residual shown; "Convert to mesh" goes the other way | part type/dims |
| Paint (P) | brush (primitives: `paint` uv64 field; meshes: vertex labels), fill part, eyedropper; region tools add band/stripes/patch/spot with on-model handles (from/to, azimuth span, radius); **Apply photo colors** when the project has labeled views (§2.9.6) | `paint`, `regions`, mesh labels |
| Palette | add color, merge two colors, match to a yarn line (ΔE00 shown) | `palette` |
| Features | click on a part to place eyes/nose/mouth/cheeks; size; mirror; embroidery path drawing | `features` |
| View toggles | rounds as rings (colored per stitch), pattern ghost, exploded view, X-ray (buried/trimmed portions), wireframe | UI state |

**Re-anchoring children** (dims edits, Scale, Parameters, Proportions, sculpting a parent): at pointer-down (or
before a panel edit) each direct child stores its attach anchor (§2.12 step 1) in the parent's frame as a direction
`(az, el)` from the parent's center (§0.1) plus a signed offset along the parent's surface normal. During the drag
(≤ 10 Hz) and on release, the anchor is re-projected onto the parent's new surface (ray from the new center
along `(az, el)`, analytic SDF of §3.7.6) and the child's whole subtree is translated by the anchor's displacement;
children keep their rotation. The drag, its re-anchoring and any mirror-linked twin form one history step (one
coalesce key). Tests (T6): scaling the teddy head 1.2× keeps each ear's gap to the head ≤ 0.1 in and its `(az, el)`
on the head within 1°; one undo restores every part exactly; moving the body moves the whole tree, ⌥-moving it moves
the body alone and raises `W_GAP` on its children.

**Proportions kernel** (Step 0, `core/model/proportions.ts`; pure, used by T6's panel and T7's `q_parts`; v1.1
pointed both at mappings that were never defined). `readProportions(model)` reports the current values and the
reasons controls are disabled; `applyProportions(model, { headBody?, limbs? }, meshes?)` returns the new model (and
scaled mesh buffers). Both edits end by uniformly rescaling the whole model about its ground center (`scaleModel`,
the same kernel as Scale model to height) so the model's bbox height — the finished height — is unchanged.
- **head : body = 1 : b** (slider b ∈ [1, 3], continuous; chibi 1:1, realistic 1:3): the head is the part with id
  `head` (else label "Head"); the target is `headHeight / modelHeight = 1/(1 + b)` (1:1 ⇒ 50%, 1:3 ⇒ 25%), with
  `headHeight` = the head part's own bbox height and `modelHeight` = the whole model's bbox height (ears and limbs
  included). The kernel scales the head uniformly about its center by k (primitive dims, lathe profile, or mesh
  vertices), moves it along the ray from its parent's center so its original penetration into the parent is kept
  (`placeChildOnSurface` with that overlap), translates its subtree by the head's displacement and re-anchors its
  direct children (§4.2 re-anchoring), then rescales the model; k is found by bisection on [0.2, 5] (the head
  fraction grows monotonically with k) to within 0.1% of the target. Disabled when there is no head or the head is
  the root ("one-piece body: no separate head").
- **limb length** chips `nubs · short · medium · long` = factors **0.6 · 1 · 1.5 · 2.2** × the template limb length,
  as a fraction of the model height: `LIMB_TEMPLATE` (shared with §3.3) — arms 0.25, legs 0.20 for quadrupeds
  (standing: legs 0.30), arms and legs 0.30 for biped/person, arm nubs 0.15 for creatures; a model without
  `category` uses the quadruped row. Limbs are the parts named `arm_*`, `leg_*`, `limb<n>_*` (§2.9.7 step 6) of type
  `capsule` or `cylinder`; the kernel sets each limb's total length along its own axis so that, after the final
  rescale, `length / modelHeight` = factor × template (bisection, like the head), keeping its **proximal end** fixed
  (the pole with the larger parent SDF, i.e. the end inside or nearest the parent): `position` moves by half the
  length change along the axis, mirror twins get the same change, and the limb's children are re-anchored. Disabled
  with a reason when no such limb exists or a limb is a `mesh` part ("Fit primitive on arm_l first").
- Goldens (G23, teddy): 1:1 ⇒ head 50% ± 1% of the model height, 1:3 ⇒ 25% ± 1%, the finished height unchanged
  (± 0.1%), every ear still within 0.1 in of the head; limbs "long" ⇒ arm length 0.55·H ± 1% with each arm's
  proximal pole moved < 0.01 in before the rescale, `arm_r` the mirror of `arm_l`; `readProportions` on the
  untouched teddy reports head : body 1 : 1.3 and arms closest to "short".

### 4.3 Live pattern loop

Any committed edit (and, during drags, at most every 300 ms) sends the affected parts to `ami.worker`. Results are
cached by `hash(part JSON, parent JSON, gauge, settings)`; only dirty parts regenerate; assembly regenerates when
transforms change. Requests go through the latest-wins channel of §5.4 (one job in flight, one pending; a superseded
job stops at its next stage boundary), so a drag never queues a backlog of full regenerations. The editor
then redraws rings (§2.10.10), the ghost, badges per part (✓ / ⚠ count / ✕), and the Pattern panel. Hovering a ring
highlights its round line and vice versa (shared `LineRef` state through the `PatternView` props of §5.2.1). Path B
parts show a spinner; budget < 150 ms for ≤ 25 primitive parts, < 2 s per Path B part.

### 4.4 Undo, redo and safety

- Every authored change goes through `projectStore.update(label, recipe, { coalesceKey })` (immer patches).
  Gizmo drags coalesce from pointer-down to pointer-up into one step; sculpt strokes store sparse voxel diffs and
  copy-on-write mesh asset keys. ⌘Z / ⇧⌘Z; a History list shows labels; 200 steps per session.
- Destructive actions (delete, cut, convert, re-import) are undoable and also create a persisted model revision.
- The editor never rewrites a part the user did not touch (re-anchoring moves only the children of the part being
  edited, as one step the user can undo); Claude Design re-imports and "Rebuild from photos" create new revisions
  instead of editing in place.

### 4.5 Yarn & size panel (every 3D origin; T6, `ui/shape/YarnSizePanel.tsx`)

Shown in F2/F3 step 5 (`context: 'pre-model'`), after a Claude Design import is accepted (F4 step 6,
`'post-import'`), for "Describe a toy" projects, and as a side panel on the Shape (`'shape'`) and 3D Pattern
(`'pattern'`) tabs: the tab registry passes `<YarnSizePanel context="pattern" />` to T2's generic Pattern tab as its
`settingsSlot` (props frozen in §5.2.1). Every field writes through `projectStore.update` (typing coalesces into one
history step):

| Field | Writes | Notes |
|---|---|---|
| Yarn weight CYC 1–7 (CYC 0 not offered) | `ProjectDoc.gauge.cyc` | `technique` stays `'amigurumi_sc'`; Table E row |
| Hook (mm, US label) | `gauge.hookMm` | default Table E hook; hook factor §2.2.2 |
| Yarn over / yarn under | `gauge.yarnUnder` | w/h 1.05 / 1.11 (D17) |
| Test ball (max sts N, circumference C) | `gauge.testBall` | swatch rule of `resolveGauge` (§2.2.5): w·s = C/N |
| Finished height | before a model exists (F2/F3 step 5): `threeD.recon.targetHeightIn`; afterwards the model itself | with a model: shows the toy ghost height (§2.10.10) with its band and offers **Scale model to height…** (uniform, one history step, new model revision; §4.2) |
| Default stuffing | `threeD.ami.defaultStuffing` | parts without `stuffing` (§2.10.1) |
| Yarn per stitch ("Unravel 10 sc of your test ball and measure the yarn: __ in") | `gauge.lscCalibratedIn` (= length / 10) | replaces `L_ami` and narrows the yardage band to ±5% (§2.8) |
| Spiral lean (sts per round) | `threeD.ami.leanStPerRnd` | default 0.25, 0 = off (§2.11.2). **Calibrate…** opens the test tube: "6 sc in MR, increase to 24 sts, then work 12 plain rounds, moving your marker up every round as usual. Hold a ruler upright through the marked stitch of the first plain round; on the last round count the stitches between the ruler and the marker" ⇒ lean = count / 12 (signed: positive when the marker moved against your working direction) |
| Stitch style, crisp stripes, decrease method, eyes, terms, hand, dialect | `threeD.ami.*` (`AmiSettings`) | |

On import, `model.yarn` pre-fills CYC and hook (§3.7.7). The R4 3D size conversion is therefore user-controlled on
every path (R2, R3, R5, R6). E2E: on the imported teddy, changing CYC 4 → 3 increases the round counts of the body
while the toy ghost height stays within 5% of the model height.

---

## 5. Architecture

### 5.1 Folder layout and ownership

`S0` = Step 0 scaffold (frozen afterwards; changed only through the S0 amendment lane, §6.1), `T1…T8` = build tracks
(§6.3), `I` = integration. A path owned by a track may start life as an S0 stub; ownership passes to the track at
the Step 0 commit. Tracks never add files under S0-owned directories.

```
index.html, package.json (all scripts final at S0; packageManager + devEngines), package-lock.json (npm 11.21),
vite.config.ts, tsconfig*.json, .oxlintrc.json, .nvmrc (22), .npmrc (engine-strict=true), .gitignore,
playwright.config.ts, docs/DEPENDENCIES.md, docs/CAPTURE.md (photo capture spec), docs/S-CD.md (spike checklist)  S0
docs/DESIGN.md, docs/research/**                       I (tracks propose changes in docs/tracks/tN.md, rule 8)
docs/schema/crochet-model-1.0.schema.json                                          T7 (generated)
scripts/check-node.mjs      (pre-hook of test/lint/typecheck/dev/build/e2e; §6.2 item 1)  S0
scripts/strip-exif.mjs      (re-encodes user photos without metadata; §6.1 rule 9)  S0
scripts/project-folder.ts   (Vite plugin: /__projects mirror + backups, /__convert; S0 stub)   T8
scripts/copy-ort.mjs        (copies the one ORT wasm/mjs pair into public/ort/; postinstall)  S0
scripts/import-yarns.mjs                                                            T1
scripts/make-fixtures.mjs   (synthetic view fixtures of §6.3 T3; writes only its four folders, refuses real/)  T3
scripts/make-cd-fixtures.mjs (derived Claude Design fixtures of §3.7.7)             T7
scripts/gen-schema.ts       (run with tsx)                                          T7
fixtures/claude-design/teddy-bear/** (read-only) · teddy-derived/** T7 · s-cd/** and gate objects (§3.1) I
fixtures/models/** S0 · fixtures/images/2d/** T1 · fixtures/images/3d/** T3 (except real/**)
fixtures/images/3d/real/<object>/  (photos gitignored by default; expected.json + README.md committed;
                            supplied by the user, checked in by I only with the user's OK, §6.1 rule 9)
public/sandbox.html         (v1.1)                                                  T7
e2e/**                      (flow specs)                                            I
e2e/tracks/tN-*.spec.ts     (a track's own browser smoke tests)                     each track
docs/tracks/tN.md           (sprint notes, requests for integration)                each track
public/ort/**               (generated by copy-ort, gitignored)                     —
src/
  main.tsx, App.tsx, app/{router.ts, tabs.ts, ErrorBoundary.tsx, toasts.ts}         S0 (tabs.ts lazy-imports the
                            track entry components below, so nobody edits it after Step 0)
  types/*.ts                (§5.2, frozen)                                           S0
  core/stub.ts              (NotImplementedError, stub(), isImplemented())          S0
  core/kernel/{color,hash,prng,stable,vec,png}.ts  (png = RGBA8 PNG encode/decode on fflate, §2.3.1)   S0
  core/kernel/geom/{marchingCubes,taubin,edt,manifold}.ts  (shared by T3 and T5; manifold = the loader of §5.4)  S0
  core/gauge/{tables,resolve,grid,sphere,yarnPerStitch}.ts                          S0
  core/model/{schema,builder,transforms,sdf,attach,revisions,naming,place,proportions,scale}.ts  S0
                    (naming = nameParts §2.9.7, place = placeChildOnSurface, proportions = §4.2, scale = scaleModel)
  core/pattern/{ops,encode,validateLine,compact}.ts  (compact = §2.7.2/§2.10.11 format) S0
  core/pattern/{render,terminology,notes,skill,doc,wordchart,text}.ts  (text = renderPatternText)   T2
  core/image2d/, core/quantize/, core/yarn/ (incl. match.ts: nearestYarn), core/cleanup/, core/capture/   T1
  core/techniques/  (scFlat, scRound, c2c, c2cCorners, hdcFlat, mosaic, border, strands, validate2d, export, index)  T2
  core/yardage/twoD.ts                                                              T2
  core/yardage/threeD.ts                                                            T4
  core/recon/       (masks, align, hull, inflate, viewTurn, depthFuse, mesh, simplify, labels, backColors,
                     parts, neck, fit, projectColors)                               T3
  core/ami/         (plan, frame, trim, profiles, rounds, poles, classic, oval, place, lean, colors3d, cues,
                     assembly, landmarks, validate3d, rings, ghost, generate)       T4
  core/meshtools/   (heat, isolines, dtw, transduce, pathB, voxelize, sculpt, cut, merge, remesh)  T5
  core/importer/    (detect, text, html (tokenizer), unbundle, archive, glb, obj, plyStl, dialect, repair, diff, index)  T7
  core/qa/          (bank, engine, lexicon, seed, stack, templates, prompt, kit, builderSource)  T7
  core/persist/     (idb, repo, autosave, locks, fileFormat, migrations, folderClient, backups, assets)  T8
  core/print/       (pdf, chartPages, sections, symbols)                            T8
  workers/{rpc,client,decode}.ts   (latest-wins RPC, §5.4; decode = Blob → RgbaImage incl. HEIC, §2.3.1)  S0
  workers/chart2d.worker.ts T1 · geom.worker.ts T3 · ml.worker.ts T3 · ami.worker.ts T4 · mesh.worker.ts T5 · import.worker.ts T7
  state/{appStore,projectStore,derivedStore,history}.ts                             S0
  state/slices/twoD.ts T2 · recon.ts T3 · model3d.ts T6 · qa.ts T7 · library.ts T8
  ui/shell/**, ui/common/**                                                         S0
  ui/twoD/** T2 (SourceTab, ChartTab) · ui/pattern/** T2 (PatternTab, MaterialsTab, PatternView, MaterialsView)
  ui/photos/** T3 (PhotosTab) · ui/shape/** T6 (ShapeTab, YarnSizePanel, placement) · ui/qa/** T7 (QaWizard)
  ui/import/** T7 (ImportTab) · ui/library/** T8 (StartScreen, useAutosave) · ui/export/** T8 (ExportTab)
  data/yarns/*.json + data/yarns/ATTRIBUTION.md T1 · data/templates/*.json T7
  test/{setup.ts, rgba.ts (synthetic RgbaImage helpers), fakes.ts (LockManager, BroadcastChannel)}   S0
  test/__tests__/fixturePrivacy.test.ts  (no EXIF/GPS in committed images, §6.1 rule 9)              S0
```

Rules: `src/core/**` is pure TypeScript with no DOM and no React (it runs in workers and in the vitest `node`
environment); it takes images as `RgbaImage` and never decodes files (§2.3.1). three.js is allowed only for math,
geometry, MC tables and loaders (`core/model/builder.ts`, `core/model/sdf.ts`, `core/kernel/geom`, `core/recon`,
`core/meshtools`, `core/importer`), never a renderer. Every `src/core` module ships its own `__tests__/` folder.

### 5.2 Core types (`src/types/`, frozen at Step 0)

The crochet-model types are §3.5.1 (`types/model.ts`); the importer API is §3.7.1 (`types/importer.ts`).

```ts
// ---- types/units.ts, types/issues.ts
export type Inches = number; export type Cyc = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Hand = 'right' | 'left'; export type Terms = 'us' | 'uk'; export type UnitPref = 'in' | 'cm';
export interface Issue { code: string; severity: 'error' | 'warn' | 'info'; message: string;
  where?: { piece?: string; line?: number; row?: number; col?: number; part?: string } }

// ---- types/gauge.ts
export type Technique2D = 'sc_graphgan' | 'sc_tapestry' | 'sc_tapestry_round' | 'c2c' | 'hdc_graphgan' | 'mosaic_overlay';
export type TechniqueId = Technique2D | 'amigurumi_sc';
export interface Cell { w: Inches; h: Inches }
export interface GaugeSpec {
  cyc: Cyc; technique: TechniqueId; hookMm?: number;                 // undefined ⇒ Table A / Table E hook
  swatch?: { sts: number; rows: number; spanIn: Inches };
  c2cSwatch?: { tiles: number; spanIn: Inches }; testBall?: { maxSts: number; circumferenceIn: Inches };
  carried?: number; yarnUnder?: boolean; lscCalibratedIn?: number;
}
export interface ResolvedGauge { cell: Cell; wSc: Inches; hSc: Inches; lscIn: number; hookMm: number; stretch: number;
  tol: number; source: 'default' | 'swatch' }                          // hSc = sc row height (border rounds, §2.7.10)

// ---- types/yarn.ts
export interface Yarn { id: string; lineId: string; brand: string; line: string; name: string; number?: string; hex: string;
  cyc?: Cyc; skeinYards?: number; skeinGrams?: number; ydPer100g?: number; textured?: boolean; owned?: number }
export interface YarnLine { id: string; brand: string; line: string; cyc: Cyc; source: string; license: string; yarns: Yarn[] }

// ---- types/chart.ts
export type ImageKind = 'photo' | 'flat' | 'pixel';
export interface CropRect { x: number; y: number; w: number; h: number; rotate: 0 | 90 | 180 | 270; flipX: boolean }
export interface PaletteEntry { code: string; hex: string; name: string; yarn?: Yarn; deltaE00?: number; protected?: boolean;
  role?: 'color' | 'background' | 'override' }          // 'override' = re-inserted from a hand edit (§5.5.5)
export interface ChartGrid { cols: number; rows: number; labels: Uint8Array /* row-major, row 0 = top */; palette: PaletteEntry[] }
export interface ColorRef { hex: string; yarnId?: string }  // stable color identity (never a palette index)
export interface ChartEdits { baseCols: number; baseRows: number;
  overrides: { cell: number; color: ColorRef }[];      // cell = row-major index at baseCols × baseRows
  locked: number[] }                                   // cells protected from cleanup
export interface ChartSettings {
  technique: Technique2D; hand: Hand; startCorner: 'BR' | 'BL' | 'TR' | 'TL';
  widthIn?: Inches; heightIn?: Inches; lockAspect: boolean;       // finished size, border included
  border: { widthIn: Inches; color?: ColorRef };                  // widthIn 0 = none; color undefined = palette A
  maxColors: number | 'auto'; paletteMode: 'auto' | 'line' | 'stash' | 'custom'; lineIds: string[]; customCsv?: string;
  referenceLineId: string; detail: 'max' | 'balanced' | 'easy'; dither: 'off' | 'rowFade';
  imageKind: ImageKind | 'auto'; background: 'keep' | 'remove'; backgroundColor?: ColorRef;  // no 'noStitch' in v1
  applyRepeats: 'auto' | 'ask' | 'off';
  roundLean: { mode: 'note' | 'preskew' | 'turn'; stPerRnd: number };   // sc_tapestry_round only (§2.7.5)
}
export interface ChartMetrics { confettiPct: number; changesPerRowMean: number; changesPerRowMax: number; busiestRows: number[];
  strandsPerColor: number[]; ends: number; carriedPerRowMax: number; fidelityDE00: number; workability: number }
export interface RepeatInfo { lattice?: { px: number; py: number; match: number; applied: boolean };
  verticalBlocks: { from: number; to: number; repeatOf: [number, number] }[]; stripePeriod?: number;
  symmetryCol?: number; spotMotif?: { count: number; label: number } }
export interface ChartRequest { jobId: number; image: Blob | RgbaImage;   // Blob decoded by workers/decode.ts (§2.3.1)
  crop?: CropRect; settings: ChartSettings; gauge: ResolvedGauge; edits?: ChartEdits; lines: YarnLine[]; stash: Yarn[] }
export interface ChartResult { jobId: number; grid: ChartGrid; kind: ImageKind; source: { w: number; h: number };
  size: { cols: number; rows: number; borderRounds: number; actualW: Inches; actualH: Inches; aspectErr: number };
  metrics: ChartMetrics; repeats: RepeatInfo; issues: Issue[]; hash: string }

// ---- types/pattern.ts
export type Loop = 'both' | 'BLO' | 'FLO';
export type Op =
  | { k: 'st'; st: 'sc' | 'hdc' | 'dc' | 'slst'; loop?: Loop; color?: string; into?: 'flo2below' }
  | { k: 'inc'; n: 2 | 3; color?: string; loop?: Loop }
  | { k: 'dec'; n: 2 | 3; color?: string; loop?: Loop }
  | { k: 'tile'; color: string };
export type LineStart =
  | { k: 'foundation'; chains: number; firstInto: number } | { k: 'turn'; chains: number }
  | { k: 'mr'; n: number } | { k: 'chainOval'; chains: number } | { k: 'chainRing'; chains: number }
  | { k: 'join' }                                       // joined round: "ch 1, sc in same st as join"
  | { k: 'edge' }                                       // border Rnd 1, worked into the panel edges (E_CONSUME-exempt)
  | { k: 'c2c'; start: 'first' | 'inc' | 'dec'; end: 'first' | 'inc' | 'dec' };
export interface Cue { kind: 'eyes' | 'stuff' | 'note' | 'color'; text: string }   // printed after the line
export interface Line { kind: 'row' | 'rnd' | 'c2c' | 'border'; n: number; nEnd?: number; side?: 'RS' | 'WS';
  arrow?: '←' | '→' | '↙' | '↗' | '↖' | '↘';
  start?: LineStart; ops: Op[]; prevCount: number | null; stated: number;
  segments?: { at: number; kind: 'side' | 'end' }[];    // op index where each oval segment starts (§2.10.8, §2.13)
  join?: { changeTo?: string; drop?: 'carry' | 'cut' };  // round ends "join with sl st in first sc" (§2.11.3)
  colorHeader?: string; cues?: Cue[]; notes?: string[] }
export interface PieceFinish { kind: 'gather' | 'open' | 'flattenSc' | 'whipstitch' | 'seamToStart';
  tailIn: number; sewTailIn?: number; text: string }   // tails per §2.10.6
export interface Piece { id: string; title: string; makeCount: number; partIds: string[]; intro: string[]; lines: Line[];
  finish: PieceFinish; stuffing?: 'firm' | 'medium' | 'light' | 'none' }
export interface AssemblyStep { order: number; kind: 'open-edge' | 'closed' | 'feature-ref'; child: string; parent: string;
  rounds: [number, number]; centerStitch: number; ofStitches: number; openSts?: number; apart?: number; text: string;
  landmark?: string }
export interface MaterialsLine { code: string; hex: string; name: string; yarn?: Yarn; deltaE00?: number; stitches: number;
  strands: number; yards: number; yardsLow: number; yardsHigh: number; meters: number; skeins?: number; grams?: number }
export interface PatternDoc {
  kind: '2d' | '3d'; title: string; terms: Terms; hand: Hand; dialect: 'compact' | 'verbose';
  skill: { level: 1 | 2 | 3 | 4; name: 'Basic' | 'Easy' | 'Intermediate' | 'Complex'; reasons: string[] };
  finishedSize: { wIn: number; hIn: number; dIn?: number; tolPct: number }; gaugeText: string; hook: { mm: number; us?: string };
  materials: MaterialsLine[]; notions: string[]; notes: string[]; abbreviations: { abbr: string; meaning: string }[];
  specialStitches: { name: string; text: string }[]; pieces: Piece[]; assembly: AssemblyStep[]; finishing: string[];
  chart?: { grid: ChartGrid; cell: Cell; technique: Technique2D }; issues: Issue[]; hash: string;
}

// ---- types/geometry.ts
export type Vec3 = [number, number, number];
export interface RgbaImage { w: number; h: number; data: Uint8ClampedArray }   // RGBA8, orientation applied (§2.3.1)
export interface ColoredMesh { positions: Float32Array; indices: Uint32Array; labels: Uint8Array /* 255 unknown */; partId?: Uint8Array }
export interface SdfVolume { data: Int16Array /* voxel/256 units, positive inside */; dims: [number, number, number];
  origin: Vec3; voxel: Inches }                         // stored per recon mesh part as asset `sdf:<meshRef>` (§2.9.7)
export type ViewLabel = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';
export interface PhotoView { id: string; imageKey: string; label: ViewLabel; maskKey?: string;
  labelsKey?: string;                                   // asset: CPGL header + Int8 labels into photoPalette (§2.9.6)
  align: { scale: number; dx: number; dy: number; rot90: 0 | 1 | 2 | 3; mirror: boolean } }
export interface ReconSettings { N: 64 | 128 | 192; kappa: number;
  photoView: 'front' | 'left' | 'right' | 'top';        // single image: what the photo shows (F3 step 1, §2.9.3)
  backShape: 'mirror' | 'inflate';                      // single image: back depth (§2.9.4)
  backColors: 'part' | 'mirror' | 'solid' | 'photo'; solidColor?: string;   // single image: back labels (§2.9.6);
                                                        // default 'part' (front/top), 'mirror' (left/right)
  oneSidedDetail: boolean;                              // default true (front/top), false (left/right)
  useDepth: boolean; keepHoles: boolean; mergeTouching: boolean; splitNeck: boolean; openingFrac: number;
  fitTolerance: number; targetHeightIn: Inches }        // photoView 'top': the longest extent in the photo plane
export interface ReconRequest { jobId: number;
  views: { view: PhotoView; image: Blob | RgbaImage; mask: Uint8Array; maskW: number; maskH: number }[];
  settings: ReconSettings; gauge: ResolvedGauge; depth?: { data: Float32Array; w: number; h: number } }
export interface ReconResult { jobId: number; model: CrochetModelV1; meshes: Record<string, ColoredMesh>;
  sdfs: Record<string, SdfVolume>;                      // per mesh part, stored as assets (§2.9.7 step 3)
  labelImages: Record<string, { labels: Int8Array; w: number; h: number }>;   // per view id → PhotoView.labelsKey
  photoPalette: { hex: string; name?: string }[];       // label index → color → ProjectDoc.threeD.photoPalette
  report: { iouPerView: Record<string, number>; parts: number; genus: number }; issues: Issue[] }

// ---- types/ami.ts
export type MakeAs = 'piece' | 'applique' | 'embroidery' | 'safety_eye' | 'region' | 'skip';
export interface AmiSettings { style: 'classic' | 'exact'; spiral: boolean; crispStripes: boolean; decMethod: 'invdec' | 'sc2tog';
  dialect: 'compact' | 'verbose'; terms: Terms; hand: Hand; eyes: 'auto' | 'safety' | 'embroidered';
  defaultStuffing: 'firm' | 'medium' | 'light';         // size changes go through "Scale model to height" (§4.2)
  leanStPerRnd: number }                                // spiral lean, default 0.25, 0 = off (§2.11.2)
export interface PieceFrame { axis: Vec3; startPole: 'bottom' | 'top'; seamDir: Vec3; oval?: { S1: number }; trimmedAt?: number }
export interface RingGeom { center: Vec3; normal: Vec3; radius: number; polyline?: Float32Array }
export interface RoundsResult { partId: string; path: 'A' | 'B'; counts: number[]; loops: Loop[]; hEff: Inches; closedEnd: boolean;
  start: LineStart; finish: PieceFinish['kind']; ovalS?: number[]; rings: RingGeom[]; stitchLabels: Uint8Array[] }
export interface AmiRequest { jobId: number; model: CrochetModelV1; meshes: Record<string, ColoredMesh>; gauge: ResolvedGauge;
  settings: AmiSettings; dirtyParts?: string[] }
export interface AmiResult { jobId: number; plan: Record<string, MakeAs>; frames: Record<string, PieceFrame>;
  rounds: Record<string, RoundsResult>; ghosts: Record<string, Float32Array>; pattern: PatternDoc; issues: Issue[]; hash: string }

// ---- types/qa.ts
export interface QaState { answers: Record<string, unknown>; decided: Record<string, 'user' | 'auto'>; seed?: CrochetModelV1;
  seedSource: 'current-model' | 'template'; promptVersion: 'prompt-v1'; builderVersion: 'builder-v1';
  step: 'questions' | 'send' | 'import';                // where the wizard resumes (F4 step 1)
  generatedAt?: string;                                 // last Copy prompt / Save kit / fix-up copy
  awaiting?: { since: string; seedRev: number; via: 'copy' | 'compact' | 'kit' | 'fixup' };  // banner + Import tab;
                                                        // cleared by an accepted import or Dismiss (§3.7.7)
  fixupVersion?: 'fixup-v1' }

// ---- types/project.ts
export interface AssetRef { key: string; mime: string; bytes: number; sha256: string }
export interface SourceImage { id: string; asset: AssetRef; name: string; w: number; h: number; addedAt: string }
export interface ModelRevision { rev: number; at: string; source: 'seed' | 'recon' | 'import' | 'edit'; label: string; asset: AssetRef }
export interface ImportRecord { id: string; at: string; fileName: string; carrier: string; dialect: string; confidence: string;
  repairs: Repair[]; original: AssetRef; revision: number }      // Repair: §3.7.1
export interface ProjectDoc {
  schema: 'crochet-project'; version: 1; id: string; name: string; createdAt: string; updatedAt: string; rev: number;
  mode: '2d' | '3d'; units: UnitPref; terms: Terms; hand: Hand; gauge: GaugeSpec; sources: SourceImage[];
  twoD?: { sourceId: string; crop?: CropRect; settings: ChartSettings; edits: ChartEdits };
  threeD?: { origin: 'multiview' | 'single' | 'claude-design' | 'describe'; model: CrochetModelV1;
             meshAssets: Record<string, AssetRef>; revisions: ModelRevision[]; views: PhotoView[];
             photoPalette?: { hex: string; name?: string }[];   // the photos' joint palette (§2.9.6)
             recon?: ReconSettings; ami: AmiSettings };
  qa?: QaState; imports: ImportRecord[]; thumbnail?: AssetRef;
}
export interface ProjectSummary { id: string; name: string; mode: '2d' | '3d'; updatedAt: string; thumbnail?: AssetRef }

// ---- types/workers.ts (comlink APIs; latest-wins channels and cooperative cancellation, §5.4)
export interface Cancellable { supersede(jobId: number): Promise<void> }   // every worker API below extends it
export interface Chart2dApi extends Cancellable { run(r: ChartRequest): Promise<ChartResult>;
  buildPattern(r: { chart: ChartGrid; settings: ChartSettings; gauge: ResolvedGauge; terms: Terms; dialect: 'compact' | 'verbose';
                    title: string }): Promise<PatternDoc> }
export interface GeomApi extends Cancellable {
  mask(image: Blob | RgbaImage, o?: { keepHoles?: boolean }): Promise<{ mask: Uint8Array; w: number; h: number }>;
  build(r: ReconRequest): Promise<ReconResult>;
  projectColors(r: { jobId: number; model: CrochetModelV1; meshes: Record<string, ColoredMesh>;
    views: { view: PhotoView; labels: Int8Array; mask: Uint8Array; w: number; h: number }[];   // read from labelsKey/maskKey
    photoPalette: { hex: string; name?: string }[]; palette: PaletteColor[] }):            // labels → palette, ΔE00 < 5 merge
    Promise<{ paint: Record<string, Part['paint'] | Uint8Array /* mesh vertex labels */>; palette: PaletteColor[];
              viewIoU: Record<string, number>; issues: Issue[] }> }        // "Apply photo colors", §2.9.6
export interface MlApi extends Cancellable { status(): Promise<{ webgpu: boolean; depthCached: boolean; samCached: boolean }>;
  depth(image: Blob | RgbaImage, onProgress?: (p: number) => void):      // client passes Comlink.proxy(onProgress)
    Promise<{ data: Float32Array; w: number; h: number }>;
  samEncode(image: Blob | RgbaImage): Promise<void>;
  samMask(points: { x: number; y: number; positive: boolean }[]): Promise<{ mask: Uint8Array; w: number; h: number }> }
export interface MeshApi extends Cancellable { pathB(r: { jobId: number; mesh: ColoredMesh; partId: string; frame: Partial<PieceFrame>; gauge: ResolvedGauge;
  settings: AmiSettings }): Promise<RoundsResult | { needsSplit: { level: number; loops: number[] } }>;
  merge(parts: { part: Part; mesh?: ColoredMesh; sdf?: SdfVolume }[], o?: { N?: number }):   // §2.9.8, editor ⌘J;
    Promise<{ mesh: ColoredMesh; sdf: SdfVolume; volumeIn3: number; unionVolumeIn3: number; genus: number }>;
                                                        // geometry + labels only; T6's recipe picks the kept id/attach
  voxelize(mesh: ColoredMesh, N: number, o?: { storedSdf?: SdfVolume }): Promise<{ volumeId: string }>;  // narrow band, §2.9.8
  sculpt(volumeId: string, stroke: { tool: 'inflate' | 'deflate' | 'smooth' | 'flatten'; points: Vec3[]; radius: number;
    strength: number; mirrorX: boolean }): Promise<{ mesh: ColoredMesh; undoId: string }>;
  undoSculpt(undoId: string): Promise<{ mesh: ColoredMesh }>;
  cut(volumeId: string, plane: { point: Vec3; normal: Vec3 }): Promise<[ColoredMesh, ColoredMesh]>;
  fit(mesh: ColoredMesh): Promise<{ type: PartType; dims: Dims; position: Vec3; rotationDeg: Vec3; residual: number }>;
  fromPart(part: Part): Promise<ColoredMesh> }
export interface AmiApi extends Cancellable { generate(r: AmiRequest): Promise<AmiResult> }
export interface ImportApi extends Cancellable { importInputs(inputs: ImportInput[], ctx?: ImportContext): Promise<ImportResult> }
```

#### 5.2.1 Cross-track entry points (frozen at Step 0, stubbed by Step 0)

Every function and component one track calls in another track's code is listed here with its module path and exact
signature. Step 0 creates each as a typed stub carrying `__stub: true` that throws `NotImplementedError` (components
render a labelled placeholder); `isImplemented(fn)` is `!fn.__stub`. Tests that need a stub's real behavior use
`it.runIf(isImplemented(fn))`; integration removes the gates.

```ts
// core/stub.ts (S0)
export class NotImplementedError extends Error { constructor(readonly fn: string) { super(`${fn} not implemented`) } }
export function stub<F extends (...a: never[]) => unknown>(name: string): F & { __stub: true };
export function isImplemented(fn: unknown): boolean;

// core/model/sdf.ts, attach.ts, revisions.ts (S0, implemented in Step 0)
export function partSdf(part: Part, mesh?: (p: Vec3) => number): (pWorld: Vec3) => number;   // positive inside
export function overlapVolume(a: Part, b: Part, o?: { meshSdf?: Record<string, (p: Vec3) => number> }): number;
export function surfaceGap(child: Part, parent: Part): number;
export function inferAttach(m: CrochetModelV1, o?: { meshSdf?: Record<string, (p: Vec3) => number> }):
  { model: CrochetModelV1; repairs: Repair[] };
export function inferMirrorPairs(m: CrochetModelV1, o?: { tolerance?: number }): { model: CrochetModelV1; repairs: Repair[] };
export interface CarryReport { crochet: string[]; paint: string[]; paintDropped: string[]; features: string[] }
export function carryOver(prev: CrochetModelV1 | undefined, next: CrochetModelV1): { model: CrochetModelV1; report: CarryReport };
// state/projectStore.ts (S0): the ONE way to replace the 3D model (T3 rebuild, T6 convert/cut/merge/scale, T7 import/apply colors)
commitModelRevision(next: CrochetModelV1, o: { source: ModelRevision['source']; label: string;
  carry: 'by-id' | 'none'; carryPaintAnyway?: string[] }): Promise<CarryReport>;

// core/model/naming.ts, place.ts, proportions.ts, scale.ts (S0, implemented in Step 0; used by T3, T6 and T7)
export function nameParts(m: CrochetModelV1, o?: { keepIds?: ReadonlySet<string> }):   // §2.9.7 step 6
  { model: CrochetModelV1; renames: Record<string, string> };
export function placeChildOnSurface(parent: Part, child: Part, at: { dir: Vec3 } | { hit: Vec3; normal: Vec3 },
  overlapIn?: number /* default 0.10 */, o?: { meshSdf?: (p: Vec3) => number }): Part;   // §3.3 step 3, Add part
export type LimbLength = 'nubs' | 'short' | 'medium' | 'long';                             // × 0.6 / 1 / 1.5 / 2.2
export const LIMB_TEMPLATE: Record<'quadruped' | 'quadruped-standing' | 'biped' | 'creature', { arm: number; leg: number }>;
export interface ProportionsReading { headBody?: number; limbs?: LimbLength; disabled: { headBody?: string; limbs?: string } }
export function readProportions(m: CrochetModelV1): ProportionsReading;
export function applyProportions(m: CrochetModelV1, o: { headBody?: number; limbs?: LimbLength },
  meshes?: Record<string, ColoredMesh>): { model: CrochetModelV1; meshes?: Record<string, ColoredMesh> };  // §4.2
export function scaleModel(m: CrochetModelV1, factor: number, meshes?: Record<string, ColoredMesh>):
  { model: CrochetModelV1; meshes?: Record<string, ColoredMesh> };                      // about the ground center
// core/kernel/png.ts, core/kernel/geom/manifold.ts (S0, implemented)
export function encodePng(img: RgbaImage): Uint8Array;        // RGBA8, filter 0, fflate zlib (1-px export, tests)
export function decodePng(bytes: Uint8Array): RgbaImage;      // 8-bit gray/RGB/palette/gray-alpha/RGBA, non-interlaced
export function getManifold(): Promise<ManifoldToplevel>;     // §5.4: one tested init for node tests and workers
// workers/decode.ts, rpc.ts, client.ts (S0, implemented; §2.3.1, §5.4)
export function decodeImage(input: Blob | RgbaImage): Promise<RgbaImage>;   // workers only; HEIC via /__convert
export class Superseded extends Error { constructor(readonly jobId: number) }
export function yieldMacrotask(): Promise<void>;              // MessageChannel ping
export function createJobGate(): { supersede(jobId: number): void; check(jobId: number): Promise<void> };
export function latestWins<Q extends { jobId: number }, R>(send: (q: Q) => Promise<R>,
  supersede: (jobId: number) => Promise<void>): (q: Omit<Q, 'jobId'>) => Promise<R>;

// T1 — core/image2d/run.ts, core/yarn/match.ts
export function runChart(req: ChartRequest, gate?: { check(jobId: number): Promise<void> }): Promise<ChartResult>;
export function nearestYarn(hex: Hex, lineIds: string[]): { yarn: Yarn; deltaE00: number } | null;  // T4 names, T6 palette
// T2 — core/techniques/index.ts, core/pattern/render.ts
export function buildPattern2D(i: { chart: ChartGrid; settings: ChartSettings; gauge: ResolvedGauge; terms: Terms;
  dialect: 'compact' | 'verbose'; title: string }): PatternDoc;   // border rounds from settings.border + gauge.hSc (§2.7.10)
export function renderLine(line: Line, o: { dialect: 'compact' | 'verbose'; terms: Terms; hand: Hand;
  decMethod?: 'invdec' | 'sc2tog' }): string;
// T2 — core/techniques/export.ts, core/pattern/{text,skill,notes,terminology}.ts: T8's export dialog and T4's 3D
// PatternDoc call these; T8 never formats pattern text or chart files itself
export function exportChart(grid: ChartGrid, kind: 'png1px' | 'csv' | 'json'): Blob;     // png via core/kernel/png.ts
export function renderPatternText(doc: PatternDoc, o: { format: 'txt' | 'md'; terms: Terms; hand: Hand;
  dialect: 'compact' | 'verbose' }): string;
export interface SkillInput { colors: number; meanChangesPerLine: number; technique: TechniqueId; pieces?: number;
  irregularShaping?: boolean; bloFlo?: boolean }
export function computeSkill(i: SkillInput): PatternDoc['skill'];                        // §2.8 skill points
export function notesFor(kind: 'flat-graph' | 'tapestry' | 'tapestry-round' | 'c2c' | 'mosaic' | 'border' | 'amigurumi',
  ctx: { terms: Terms; hand: Hand; corner?: string; arrows?: string[]; joinedRounds?: boolean; leanStPerRnd?: number;
         roundLean?: ChartSettings['roundLean'] }): string[];
export function abbreviationsFor(lines: Line[], terms: Terms): PatternDoc['abbreviations'];
export function specialStitchesFor(lines: Line[], terms: Terms): PatternDoc['specialStitches'];
// T3 — core/recon/fit.ts
export interface FitResult { type: PartType; dims: Dims; position: Vec3; rotationDeg: Vec3; residual: number }
export function fitPart(mesh: ColoredMesh, o?: { tolerance?: number }): FitResult;
// T4 — core/ami/generate.ts (deps.pathB = the private mesh.worker's pathB, §5.4)
export function generateAmigurumi(req: AmiRequest, deps: { pathB?: MeshApi['pathB'];
  gate?: { check(jobId: number): Promise<void> } }): Promise<AmiResult>;
// T6 — ui/shape/placement.ts
export interface PlacementHighlight { partId: string; rounds: [number, number]; stitches: number[]; color?: Hex; label?: string }
export function renderPlacementImage(model: CrochetModelV1, partId: string, highlights: PlacementHighlight[],
  o?: { widthPx?: number; view?: 'auto' | ViewLabel }): Promise<Blob>;           // PNG; T8 falls back to text
// T6 — ui/shape/YarnSizePanel.tsx, ShapeTab.tsx
export interface YarnSizePanelProps { context: 'pre-model' | 'post-import' | 'shape' | 'pattern'; onDone?(): void }
export interface ViewportProps { model: CrochetModelV1; meshes: Record<string, ColoredMesh>; selection: string[];
  layers: Record<string, boolean>; onPick?(partId: string | null): void }
export interface ShapeTabProps { Viewport?: ComponentType<ViewportProps> }   // default: the R3F viewport; tests pass a stub
// T2 — ui/pattern/PatternView.tsx, MaterialsView.tsx, PatternTab.tsx (used by both modes)
export type LineRef = { piece?: string; line: number };        // piece = Piece.id (3D); undefined in 2D
export interface PatternViewProps { doc: PatternDoc; dialect: 'compact' | 'verbose'; terms: Terms; hand: Hand;
  highlight?: LineRef | null; onHoverLine?(ref: LineRef | null): void; onSelectLine?(ref: LineRef): void;
  checked?: ReadonlySet<string>; onToggleChecked?(key: string): void }   // ring ↔ line hover link (§4.3)
export interface MaterialsViewProps { doc: PatternDoc; units: UnitPref }
export interface PatternTabProps { settingsSlot?: ReactNode }   // 3D: <YarnSizePanel context="pattern" /> (§4.5)
// T8 — core/persist/repo.ts, ui/library/useAutosave.ts, core/print/pdf.ts
export interface ProjectRepository {
  list(): Promise<ProjectSummary[]>;
  open(id: string, mode: 'edit' | 'read'): Promise<{ doc: ProjectDoc; readOnly: boolean }>;   // single writer, §5.5.2
  takeOver(id: string): Promise<{ doc: ProjectDoc; readOnly: false }>;   // locks.request(…, { steal: true }), §5.5.2
  save(doc: ProjectDoc, newAssets: Map<string, Blob>, o: { baseRev: number }):
    Promise<{ ok: true; rev: number } | { ok: false; conflict: { storedRev: number } }>;
  saveAsCopy(doc: ProjectDoc, newAssets: Map<string, Blob>): Promise<{ id: string; rev: 1 }>;   // takes the copy's lock
  putAsset(projectId: string, bytes: Blob, mime: string): Promise<AssetRef>;
  getAsset(ref: AssetRef): Promise<Blob>;
  exportFile(id: string): Promise<Blob>; importFile(f: Blob): Promise<{ id: string; renamed: boolean }>;
  remove(id: string): Promise<void>;
}
export interface LockManagerLike { request(name: string, o: { ifAvailable?: boolean; steal?: boolean },
  cb: (lock: unknown | null) => Promise<unknown>): Promise<unknown> }       // navigator.locks in the app
export interface ChannelLike { postMessage(m: unknown): void; onmessage: ((e: { data: unknown }) => void) | null; close(): void }
export function createProjectRepository(o?: { idb?: IDBFactory; locks?: LockManagerLike;
  channel?: (name: string) => ChannelLike; now?: () => Date }): ProjectRepository;     // fakes in unit tests (§6.3 T8)
export function useAutosave(): { status: 'saved' | 'saving' | 'error' | 'read-only'; flush(): Promise<void> };
export function buildPdf(doc: PatternDoc, o: { paper: 'letter' | 'a4'; placementImages?: Record<string, Blob> }): Promise<Blob>;
// Tab entry components (S0 stubs at these track-owned paths; app/tabs.ts lazy-imports them)
// ui/library/StartScreen (T8) · ui/twoD/SourceTab, ChartTab (T2) · ui/pattern/PatternTab, MaterialsTab (T2)
// ui/photos/PhotosTab (T3) · ui/import/ImportTab (T7) · ui/qa/QaWizard (T7) · ui/shape/ShapeTab, YarnSizePanel (T6)
// ui/export/ExportTab (T8)
```

### 5.3 State management (zustand 5 + immer 11)

| Store (S0) | Holds | Persisted |
|---|---|---|
| `appStore` | route `{ screen: 'start' \| 'project', projectId?, tab? }` (hash routes `#/`, `#/p/<id>/<tab>`), prefs (units, terms, hand, dialect), capabilities (WebGPU, storage persisted, folder mirror), library summaries, toasts | prefs → `settings` store |
| `projectStore` | `doc: ProjectDoc \| null`, save status, history (immer patches + inverse patches, labels, coalesce keys, ≤ 200), asset cache `Map<key, Blob>` | doc + assets (autosave §5.5) |
| `derivedStore` | latest `ChartResult`, 2D `PatternDoc`, `ReconResult` preview, `AmiResult`, job states; keyed by input hash | never |

`projectStore.update(label, recipe, { coalesceKey? })` is the **only** way to change authored data
(`commitModelRevision`, §5.2.1, is a named update that also stores the revision asset); slices
(`state/slices/*.ts`, one per track) export pure recipes and async actions that call workers and write results into
`derivedStore`. `putAsset(bytes, mime) → AssetRef` stores content-addressed assets (`<projectId>/<sha256>`), so
copy-on-write and dedupe are free. A project opened read-only (another tab holds its lock, §5.5.2) rejects `update`
with a banner. Tabs are registered once, in Step 0's `app/tabs.ts`, by lazy-importing the entry components of
§5.2.1: 2D = Source · Chart · Pattern · Materials · Export; 3D = **Photos** (when the project has photo views) ·
**Import** (when the project came from Claude Design or "Describe a toy", is waiting for a Claude Design result, or
has imports — so a photo project gets it as soon as a prompt is copied) · Shape · Pattern (with
`<YarnSizePanel context="pattern" />` as its `settingsSlot`) · Materials · Export. The visibility predicates are
part of the Step 0 registry. The Q&A wizard is a project route (`#/p/<id>/qa`), not a tab, and resumes at
`QaState.step`; the "Waiting for your Claude Design result" banner (F4 step 3) sits above the tab bar of that project.
Each track can therefore run its own tab in its own worktree.

### 5.4 Web Workers

| Worker | Owner | Contents | Notes |
|---|---|---|---|
| `chart2d.worker` | T1 | §2.3–2.6 pipeline + `buildPattern` (calls T2's `core/techniques`) | decode via `workers/decode.ts`; < 300 ms at 200² |
| `geom.worker` | T3 | masks, alignment, SDF, MC, Taubin, meshoptimizer, manifold-3d, labels, parts, fit | transferables out |
| `ml.worker` | T3 | transformers.js depth + SlimSAM; lazy; progress through a `Comlink.proxy` callback | ORT paths as an **object of absolute URLs** (below); `env.useWasmCache = true` (honoured only in the object form); terminate + respawn on cancel |
| `ami.worker` | T4 | §2.10–2.12 | owns a **private** `mesh.worker` for Path B (below) |
| `mesh.worker` | T5 | Path B, voxelize, sculpt, cut, merge, fit, convert | two instances: the editor's (keeps sculpt volumes by `volumeId`) and `ami.worker`'s (Path B only) |
| `import.worker` | T7 | §3.7 | no DOM (tokenizer, §3.7.4); 10 MB OBJ < 3 s |

**ONNX Runtime under Vite 8** (verified: with `wasmPaths = '/ort/'` the ORT bundle pinned by transformers 4.3.0 does a
non-literal `import('/ort/ort-wasm-simd-threaded.asyncify.mjs')`, Vite 8 dev rewrites it to `…?import`, and the dev
server answers HTTP 500 for public files imported from source — so depth and SlimSAM failed under `npm run dev`):
```ts
env.backends.onnx.wasm.wasmPaths = {   // absolute http(s) URLs are not rewritten by Vite
  mjs:  new URL('/ort/ort-wasm-simd-threaded.asyncify.mjs',  self.location.origin).href,
  wasm: new URL('/ort/ort-wasm-simd-threaded.asyncify.wasm', self.location.origin).href };
```
`scripts/copy-ort.mjs` (S0, run by `postinstall`) copies **only that pair** (≈ 27 MB, not the 139 MB of four variants)
from `node_modules/onnxruntime-web/dist/` into `public/ort/` (gitignored).

**manifold-3d** is loaded by one Step 0 kernel, `core/kernel/geom/manifold.ts`, shared by T3 and T5:
```ts
import Module from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
const isNode = typeof process !== 'undefined' && !!process.versions?.node;
let ready: Promise<ManifoldToplevel> | undefined;
export const getManifold = () => ready ??= Module(isNode ? {} : { locateFile: () => wasmUrl })
  .then(m => { m.setup(); return m; });
```
The v1.1 form, `Module({ locateFile: () => wasmUrl })` everywhere, fails in the vitest `node` environment that §6.1
mandates for `src/core`: Vitest turns `?url` into `/node_modules/manifold-3d/manifold.wasm`, which Emscripten opens
as a file path (`RuntimeError: Aborted(Error: ENOENT …)`, reproduced in review); without `locateFile` Emscripten finds
the wasm next to its own module in node. Verified in review: the node test passes, and a Vite dev worker and the
preview build both return status `NoError`, genus 0, 1 part. Step 0 ships the node unit test (a unit cube: status
`NoError`, genus 0, 1 part); the Step 0 Vite config excludes manifold from dependency pre-bundling
(`optimizeDeps.exclude: ['manifold-3d']`), because its default `new URL('manifold.wasm', import.meta.url)` breaks
under pre-bundling. T3.1 still ships `e2e/tracks/t3-workers.spec.ts`: under `npm run dev`, `ml.worker` creates an
ORT session from a tiny committed Identity model and `geom.worker` initialises manifold, with no console errors.

**Worker RPC** (D22; `workers/rpc.ts` inside workers and `workers/client.ts` on the main thread, both Step 0 code
with tests). All workers: `new Worker(new URL('./x.worker.ts', import.meta.url), { type: 'module' })`, comlink
`expose`, typed proxies in `client.ts`. There is no SharedArrayBuffer (no cross-origin isolation, D20; checked in
review in Chromium 1243: `crossOriginIsolated` false, `SharedArrayBuffer` undefined), and a comlink message is a
macrotask, so a running job sees a newer request only when it yields. Therefore:
1. **Latest-wins channel** per API method (`latestWins`): at most one request in flight and one pending; a newer
   request replaces the pending one (whose promise rejects with `Superseded`, which callers ignore) and immediately
   sends `supersede(newJobId)` to the worker. With the 250 ms chart debounce, five rapid slider ticks run at most two
   jobs (the one in flight, cut short, and the last).
2. **Cooperative cancellation:** each worker keeps `latestJobId` (set by `supersede`) in a `createJobGate()`; between
   stages, and at least every ~50 ms inside long loops, the job calls `await gate.check(jobId)`, which is
   `await yieldMacrotask()` (a MessageChannel ping that lets queued messages, including `supersede`, run) followed by
   `if (latestJobId > jobId) throw new Superseded(jobId)`. Core functions take the gate as an optional argument
   (`runChart`, `generateAmigurumi`, §5.2.1), so they stay pure and testable.
3. **Callbacks and buffers:** client wrappers pass callbacks as `Comlink.proxy(fn)` (e.g. `MlApi.depth`'s
   `onProgress`; a plain function throws `DataCloneError`) and wrap request-owned typed arrays (decoded images,
   masks, depth maps) in `Comlink.transfer`; buffers that a store still holds are cloned, never transferred. Workers
   return large results with `Comlink.transfer`.
4. **Path B:** `ami.worker` spawns its **own** `mesh.worker` with `new Worker(new URL('./mesh.worker.ts',
   import.meta.url), { type: 'module' })` (nested module workers checked in review under Vite 8 dev and build) and
   passes its `pathB` as `deps.pathB`; the editor keeps a separate `mesh.worker` for sculpting, so a 2 s Path B part
   never blocks a sculpt stroke and neither instance needs a MessagePort hand-off.
Tests (S0): five rapid requests on a fake slow worker run at most two jobs and resolve only the last; a `supersede`
sent during a long job stops it at its next `check`; a progress callback passed through the client fires in a real
worker (Playwright smoke, `e2e/smoke.spec.ts`); a nested worker answers from inside another worker.

### 5.5 Persistence (never lose user data)

#### 5.5.1 IndexedDB (`idb`), database `crochet-pattern-generator`, version 1

| Store | Key | Value |
|---|---|---|
| `projects` | `id` | `ProjectDoc` |
| `assets` | `<projectId>/<sha256>` | `{ blob, mime, bytes, createdAt }` (images ≤ 4096 px working copies, masks, mesh buffers, model revisions, import originals, thumbnails) |
| `revisions` | `[projectId, rev]` | `{ at, label, doc }` snapshots |
| `settings` | string | prefs, yarn stash, gauge profiles (per yarn + hook + technique), yarn color calibrations |
| `meta` | string | db schema version, last backup time, `sync:<projectId>` = `{ lastSyncedRev, lastSyncedHash }` for the folder mirror (per installation, never exported) |

#### 5.5.2 Autosave and snapshots

Save 800 ms after the last `update`, and immediately on `visibilitychange → hidden`, `pagehide` and before
navigation to the library; doc and new assets in one transaction; `rev++`. Snapshot every 20 revs or 5 minutes, and
always before migrations, imports, rebuilds, cuts and deletes; keep the last 30 plus one per day for 30 days.
Request `navigator.storage.persist()` when the first project is created; show quota in Settings. Save failure ⇒
red chip + banner "Not saved — Export a backup" with one-click `.crochet.json` download; retries with backoff.

**One writer per project, no lost updates:**
- **Compare-and-swap:** `save(doc, assets, { baseRev })` reads the stored `rev` inside the same readwrite
  transaction; if it is newer than the rev the tab loaded, nothing is overwritten and `save` returns the conflict.
  `useAutosave` then calls `saveAsCopy` once: the tab's doc becomes a new project "<name> (copy, <time>)" (new id,
  rev 1, assets shared by hash), the tab **rebinds** to it (projectStore id, rev and baseRev, the lock on the copy,
  the URL), and the original is reopened read-only beside it with the banner "Another tab saved a newer version of
  <name>. Your changes are safe in '<name> (copy, …)', which you are editing now." Later autosaves go to the copy, so
  a conflict produces exactly one copy (v1.1 kept the old id and stale baseRev, so every 800 ms autosave made
  another copy).
- **Single writer:** opening a project for editing takes `locks.request('project:' + id, { ifAvailable: true })`
  and holds it while the project is open. If the lock is held, the project opens **read-only** with a banner and an
  "Edit here instead" button, which posts `release` on a `BroadcastChannel('cpg')`; the other tab flushes its save,
  switches to read-only and releases the lock. If no release arrives within 5 s (a hung or frozen tab), the banner
  offers **Take over** (`ProjectRepository.takeOver` → `locks.request(name, { steal: true }, …)`); the old holder's
  lock callback rejects, it switches to read-only, and any save it still attempts is caught by compare-and-swap, so
  stealing can never lose data. A stale tab (for example after a dev-server restart) can therefore never write an
  older doc over a newer one.
- **Schema upgrades:** the repository opens IndexedDB with `idb`'s `blocking` callback (this tab blocks a newer
  version elsewhere: flush the save, `db.close()`, show "This tab was closed for an update — Reload") and `blocked`
  callback (the upgrade waits for other tabs: "Close the other Crochet Pattern Generator tabs to finish updating"),
  so a stale tab cannot hold an upgrade back forever.
- **Testability:** the repository takes a `LockManagerLike` (default `navigator.locks`) and a `ChannelLike` factory
  (default `BroadcastChannel`); unit tests use in-memory fakes (`src/test/fakes.ts`), because happy-dom has no lock
  manager (`navigator.locks` is null; undefined in the node environment; checked in review with happy-dom 20.14.5). The real
  two-tab hand-over runs under Playwright (`persist.spec`, §6.4).

#### 5.5.3 `.crochet.json` (export/import of a whole project)

```json
{ "format": "crochet-project-file", "version": 1, "exportedAt": "2026-10-01T12:00:00Z",
  "app": { "name": "crochet-pattern-generator", "version": "0.1.0" },
  "project": { "...": "ProjectDoc" },
  "assets": { "<key>": { "mime": "image/jpeg", "sha256": "…", "base64": "…" } },
  "revisions": [ { "rev": 12, "at": "…", "label": "Before import", "doc": { "...": "ProjectDoc" } } ] }
```

Validated with zod; asset hashes verified. Import **never overwrites**: same id and identical content ⇒ "already in
your library"; same id otherwise ⇒ imported as a new project named "<name> (imported 2026-10-01)". Migrations are
pure `migrate_vN_to_vN+1(doc)` functions with tests that keep every field; the pre-migration doc is snapshotted.

#### 5.5.4 Folder mirror and backups (dev/preview servers)

IndexedDB is per origin, so a new port looks like data loss. Therefore the user's dev **and** preview servers run on
the same fixed port, `CPG_PORT` (default **5180**, `strictPort`), and the Vite plugin `scripts/project-folder.ts`
(T8) serves `/__projects` backed by `CPG_PROJECTS_DIR` (default `~/Documents/Crochet Pattern Generator/projects/`).
A static build hosted alone uses IndexedDB + file export only.

- **Test and agent isolation:** the plugin refuses to use the default folder (mirror disabled, `HEAD /__projects`
  answers 503, a console warning names the variable to set, the app shows "Folder mirror off") whenever any of these
  holds: `PLAYWRIGHT`, `VITEST`, `CI` or `CPG_TEST` is set; `CLAUDE_CODE_CHILD_SESSION` is set (present in every
  workflow and sub-agent shell, checked 2026-10-01; the user's own interactive session sets only `CLAUDECODE` and
  is not refused for that alone); the server root lies under `/.claude/worktrees/`; or the checkout is not on branch
  `master` (read from `.git/HEAD`, or from the worktree's gitdir; a detached HEAD counts as not master). So no
  worktree server and no agent can run in-development migration code against the user's real folder, even when an
  agent forgets `CPG_TEST`. The default port also follows the checkout: `vite.config.ts` uses 5190 + N for a
  worktree named `.claude/worktrees/t<N>-…` and 5180 only for the main checkout, and it never binds 5180 when
  `CLAUDE_CODE_CHILD_SESSION` or `CPG_TEST` is set (it uses 5199 instead, even if `CPG_PORT=5180` is passed), so an
  agent's server can never answer on the user's origin — where an open tab of the user's would load in-development
  code against the user's IndexedDB. `playwright.config.ts` starts `npm run dev` with
  `CPG_PORT = CPG_E2E_PORT ?? (5290 + N in a track worktree, else 5181)` derived from the directory name (an
  exported variable does not survive between agent shell calls), a fresh `fs.mkdtempSync(os.tmpdir() + '/cpg-e2e-')`
  as `CPG_PROJECTS_DIR`, `CPG_TEST = 1` and `reuseExistingServer: false`, so e2e never touches the user's projects or
  reuses the user's server. Agents follow §6.1 rule 6.
- **HEIC conversion** (`POST /__convert`, same plugin, dev/preview only; §2.3.1): accepts ≤ 50 MB whose ISO-BMFF
  `ftyp` brand is a HEIF brand (else 415); on macOS writes it into an `fs.mkdtemp` folder, runs
  `execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', input, '--out', output],
  { timeout: 20000 })` (no shell), answers `image/jpeg` and deletes the folder; on other platforms it answers 501.
- **Layout:** one folder per project, `projects/<id>/project.json` (the `ProjectDoc` with asset references) plus
  `projects/<id>/assets/<sha256>` (content-addressed, write-once).
- **Protocol:** `GET /__projects` (list: id, rev, doc sha256, updatedAt); `GET`/`PUT /__projects/<id>/doc`; `HEAD`/
  `PUT /__projects/<id>/assets/<sha256>` (the client uploads only assets the folder lacks; the server verifies the
  hash and never rewrites an existing asset); `DELETE /__projects/<id>` moves the folder to
  `Backups/deleted/<id>-<YYYYMMDD-HHMMSS>/` (a deleted project never comes back as a restore offer). Every write goes
  to a temp file in the same directory, then `fs.rename` (atomic), so a crash never leaves a truncated doc.
- **Sync:** the app mirrors every save (debounced 5 s) when `HEAD /__projects` answers. Per project it keeps
  `{ lastSyncedRev, lastSyncedHash }` (`meta`, §5.5.1). On start: folder hash = last synced and local rev newer ⇒
  push; local unchanged since the last sync and folder changed ⇒ offer to load the folder version; both changed
  (a two-sided edit, detectable only with this sync base) ⇒ keep both (the folder's copy imported as "<name> (from
  folder)"); a project in the folder but not in IndexedDB ⇒ offer to restore.
- **Backups** (sized for this Mac: 34 GiB free, 93% used, and the default folder lies in iCloud Drive's Documents —
  `~/Documents` → `~/Library/Mobile Documents/com~apple~CloudDocs/Documents` — so every byte written is also
  uploaded; a 3D project holds tens of MB of write-once photos, mesh buffers, SDF volumes and import originals, the
  teddy OBJ alone 9.5 MB, so v1.1's whole-folder copies could reach tens of GB, and a full disk makes IndexedDB and
  mirror writes fail — the data loss backups exist to prevent):
  - **Layout:** one shared, content-addressed `Backups/assets/<sha256>` store, written once per asset with
    `fs.copyFile(src, dst, fs.constants.COPYFILE_FICLONE)` (an APFS clone: no extra local space while the original
    exists; a plain copy elsewhere); each backup is `Backups/YYYY-MM-DD-HHMM/projects/<id>/project.json` plus
    `manifest.json` (`{ hash, projects: [{ id, docSha256, assets: [sha256, …] }] }`). Restore reads the docs and
    the shared assets.
  - **When:** on server start, only if the change hash differs from the newest backup's manifest. The change hash is
    sha256 over the sorted (project id, doc sha256, sorted asset file names); docs are small, asset bytes are never
    read (their names are their hashes), so the check stays fast with large projects.
  - **Retention:** the newest 20, plus the newest backup of each day for 30 days; never delete the newest backup or
    one younger than 24 h (routine agent restarts can no longer rotate out the user's real backups); then a **size
    cap** (`CPG_BACKUP_CAP_GB`, default 2) on the logical size of `Backups/` (docs + shared assets), pruned oldest
    first within those guards; finally assets referenced by no kept backup are deleted from `Backups/assets/`.
  - **Free space:** `fs.statfs` on the folder at start and before each backup: below 5 GB free the console and
    Settings warn ("Only 3.2 GB free on this disk — backups stop below 2 GB"); below 2 GB the backup is skipped (the
    mirror keeps working) with a red Settings warning. Settings shows the folder path; `CPG_PROJECTS_DIR` may point
    outside iCloud.
- Plugin tests (temp dirs): refusal of the default folder under each test variable, under
  `CLAUDE_CODE_CHILD_SESSION`, for a root under `/.claude/worktrees/` and for a non-master branch; PUT/GET/list;
  write-once assets and hash check; atomic writes (a killed write leaves the previous doc); DELETE →
  `Backups/deleted/`; backup skipped when unchanged; retention rules including the 24 h guard and the size cap;
  asset GC; **two backups of an unchanged 100 MB asset set (only a doc changed) add < 1 MB of new files**; the
  free-space thresholds with a stubbed `statfs`; two-sided edit keeps both; on macOS `/__convert` turns a HEIC made at
  test time with `sips -s format heic` into a decodable JPEG (skipped elsewhere).

#### 5.5.5 Authored vs derived

| Data | Kind | On regeneration |
|---|---|---|
| chart overrides and locks | authored | kept by **color identity** (`ColorRef` hex + optional yarn id, never a palette index): on every regeneration the override colors are re-inserted into the palette as protected centers that count against Kmax (an override within ΔE00 < 2 of an existing center, or with the same yarn id, maps to that center; if Kmax is exceeded the lowest-population unprotected center is dropped); in yarn-line mode an override maps to its own yarn when the line has it, else to the nearest shade. If cols/rows change, overrides are remapped by relative position after a confirm dialog ("37 hand edits will move to the new size: Keep / Discard / Cancel"); the old edits stay in a snapshot. Test (T1): paint cells, change max colors 8 → 6 and switch the yarn line — overridden cells keep their color identity and pass `E_COLOR` |
| chart grid, metrics, pattern text, yardage, rings | derived | recomputed |
| model parts | authored | rebuilds and re-imports create a new revision; nothing edited in place |
| `crochet` hints, features added in the editor | authored | carried over by part id into new revisions (`carryOver`, §5.2.1) |
| `paint` | authored | carried over by part id only when type and dims match within 10% (§3.7.7); otherwise kept in the previous revision, listed in the diff with "Carry anyway", and re-derivable with Apply photo colors |
| Q&A answers, imports (original files) | authored | kept |

Asset garbage collection deletes only assets referenced by neither the current doc nor any stored revision, and
only when older than 7 days.

### 5.6 Dependencies (versions checked against the npm registry on 2026-09-30)

| Package | Version | License | Use |
|---|---|---|---|
| react, react-dom | ^19.3.0 | MIT | UI |
| three | ^0.186.1 | MIT | rendering, loaders (GLTF/OBJ/PLY/STL), MC tables |
| @react-three/fiber / @react-three/drei | ^9.8.1 / ^10.7.9 | MIT | viewport, TransformControls |
| zustand / immer | ^5.0.15 / ^11.1.18 | MIT | state, patches for undo |
| zod | ^4.6.5 | MIT | schemas, JSON Schema export |
| idb | ^8.0.3 | ISC | IndexedDB |
| comlink | ^4.4.2 | Apache-2.0 | worker RPC |
| fflate | ^0.8.3 | MIT | zip, gzip, bundler assets |
| json5 | ^2.2.3 | MIT | lenient JSON in the importer |
| three-mesh-bvh | ^0.9.15 | MIT | raycasts, closest point, sculpt queries, voxelize |
| manifold-3d | ^3.5.4 | Apache-2.0 | manifold validation, genus, decompose |
| meshoptimizer | ^1.3.0 | MIT | simplification |
| @huggingface/transformers | ^4.3.0 | Apache-2.0 | depth + SlimSAM (brings onnxruntime-web, MIT) |
| jspdf / svg2pdf.js | ^4.2.1 / ^2.8.1 | MIT | PDF |
| acorn | ^8.18.0 | MIT | v1.1 static heuristics |
| typescript | ~6.0.3 | Apache-2.0 | dev (same as room-planner; not 7.x) |
| vite / @vitejs/plugin-react | ^8.3.1 / ^6.1.1 | MIT | dev; needs Node ≥ 22.12 here (no rolldown-binding workaround) |
| vitest | ^4.1.11 | MIT | unit tests (not 5.x) |
| oxlint | ^1.86.0 | MIT | lint (its `@oxlint/binding-*` packages need Node ≥ 22.12) |
| tsx | ^4.23.15 | MIT | dev: runs `scripts/*.ts` (`npm run schema`) on Node 22 (checked 2026-10-01) |
| @types/react, @types/react-dom, @types/three, @types/node | ^19.3.0, ^19.3.0, ^0.186.0, ^24 | MIT | types |
| fake-indexeddb / happy-dom / @testing-library/react | ^6.2.5 / ^20.14.5 / ^16.3.3 | Apache-2.0 / MIT / MIT | tests |
| @testing-library/dom | ^10.4.2 | MIT | tests; the peer of @testing-library/react, listed explicitly so no install can drop it |
| @playwright/test | **1.63.0 exact** | Apache-2.0 | e2e; uses the installed Chromium 1243 |

Excluded (license or scope): `@imgly/background-removal` (AGPL), BRIA RMBG weights and Depth Anything V2
Base/Large/Giant (non-commercial), libimagequant (GPL), CrochetPARADE/AmiGo/crochet-cad code (GPL / CC BY-NC-SA —
algorithms are re-implemented from the papers), OpenCV.js and MediaPipe (v1.1 at most), culori/image-q (own kernel),
react-router (hash router), @gltf-transform (own GLB JSON reader), htmlparser2 and any DOM shim for the importer
(own tokenizer, §3.7.4).

Runtime: **Node 22 LTS ≥ 22.12** (`.nvmrc` = `22`, `"engines": { "node": ">=22.12" }`, `.npmrc` `engine-strict=true`).
Package manager: the lockfile is written by **npm 11.21.0** (`"packageManager": "npm@11.21.0"`; `devEngines`
`runtime` node `>=22.12` with `onFail: "error"` and `packageManager` npm `>=11` with `onFail: "warn"`). Checked on
this machine on 2026-10-01: Node 22.23.3's npm 10.9.9 crashes on a fresh install of vitest 4
(`Cannot read properties of null (reading 'edgesOut')`); `npx -y npm@11.21.0 install` succeeds; npm 10.9.9 `npm ci`
from that lockfile succeeds; npm ≥ 10.9 enforces `devEngines` before `install`, `ci` and `run` (an `error`
requirement of npm ≥ 11 would stop every npm 10 command, hence `warn`), and npm 11.2.0 under Node 20.18 refuses
`npm run` with `EBADDEVENGINES`. `--legacy-peer-deps` and `--force` are forbidden: the former installs but silently
drops `@testing-library/dom`.

**Yarn data (licence gate, T1).** Research 06 scraped the temperature-blanket.com core shades from `colorways.ts` in
the jdvlpr/Temperature-Blanket-Web-App repository, which is **GPL-3.0**; the CC BY 4.0 licence covers the data served
through the site's API (RapidAPI key, free plan 500 calls/month), and 06 §7.3 says to confirm with the maintainer or
pull through the API before shipping. So:
- Until a CC BY provenance is recorded, ship only CC BY sources — `makebead/craft-color-codes` (Red Heart Super
  Saver, 44 shades, data CC BY 4.0; also the default naming line) — plus the user's stash and custom CSV.
- Other lines are added only by (a) written confirmation from the maintainer that the snapshot may be used under
  CC BY 4.0, linked in `data/yarns/ATTRIBUTION.md`, or (b) one fetch through the CC BY API with the user's own key,
  with source URL, date and licence recorded.
- `scripts/import-yarns.mjs` refuses to write a line whose `YarnLine.source` / `license` provenance record is
  missing; a T1 test checks every shipped line has one.

### 5.7 Screens

- **Start:** cards "New pattern from a picture", "New 3D toy from photos", "New 3D toy from one photo",
  "Describe a toy for Claude Design", "Import from Claude Design" (which offers "Import into <project> (where you made
  the prompt)" when it recognizes the result, §3.7.7); "Your projects" grid (thumbnail, name, mode, updated, a
  "waiting for Claude Design" badge, duplicate, export, delete with confirm); "Restore from folder or backup".
- **Workspace:** top bar (library, editable name, save chip, undo/redo, Print / PDF, Export), project banners
  (waiting for Claude Design; read-only with "Edit here instead" / "Take over"; conflict copy; reload for update),
  tab bar, settings sidebar (left), main view, inspector (right), status bar (validation badges, metrics, worker
  progress).
- Desktop first (≥ 1280 × 800); patterns readable on tablets; phones: viewing/printing only.
- Accessibility: keyboard shortcuts, visible focus, colors always paired with letter codes and print symbols.

### 5.8 Performance budgets and determinism

| Operation | Budget (Apple M-class, in worker) |
|---|---|
| 2D chart 200 × 200, K ≤ 16 (sample → cleanup) | < 300 ms; 1000 × 1000 < 5 s |
| `encodeOps` per line, exact DP (≤ 120 tokens) | ≤ 5 ms (perf test at 120 tokens) |
| `encodeOps`, 200 rows × 240 run tokens (fallback + memo) | ≤ 2 s total |
| 3D build N = 128 (geometry) | < 0.8 s; depth 2.5 s (WASM 1 thread) / < 0.3 s (WebGPU) |
| amigurumi regeneration, ≤ 25 primitive parts | < 150 ms; Path B < 2 s per part |
| `voxelizeMesh` N = 96, 40k triangles (narrow band) | ≤ 400 ms |
| `MeshApi.merge`, two parts, N = 96 (sampling, MC, Taubin, validate) | ≤ 1 s |
| `applyProportions` on the teddy (bisection with re-anchoring) | ≤ 200 ms |
| largest synchronous stretch between two `gate.check` calls in any worker | ≈ 50 ms |
| `inferAttach` on the teddy (17 parts, grid overlaps; a naive prototype took 0.2 s) | ≤ 500 ms |
| import of a 10 MB OBJ | < 3 s |
| autosave of the doc | < 50 ms |
| PDF of a 200 × 200 chart pattern | < 5 s |

Determinism: no `Math.random()`/`Date` in `src/core`; seeds = `fnv1a64(input bytes ‖ canonical JSON of settings ‖
CODE_VERSION)`; stable sorts; ties → lowest index; output hashes cover integer labels, counts and rendered text,
never raw floats.

---

## 6. Build plan

### 6.1 Process rules (all agents)

1. **Small sprints:** each sprint ends with `npm run typecheck`, `npm run lint` and `npm test` all green, the
   track's notes updated in `docs/tracks/tN.md`, a commit (`TN.k: <summary>`) and a push. Never batch sprints.
   **Node 22 in every command:** agent Bash calls keep no shell state and reset the working directory, so a bare
   `nvm use` finds no `.nvmrc` and leaves Node 20.18, where the tools still run with only a Vite warning. Every agent
   command that runs node or npm therefore starts with `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null &&`
   (explicit version) or puts `~/.nvm/versions/node/v22.23.3/bin` first on `PATH`; and agents run the npm scripts
   (`npm test`, never `npx vitest run`), whose `pre*` hooks run `scripts/check-node.mjs` and whose `devEngines`
   check fails loudly on a wrong Node.
2. **Worktrees and branch:** each track works in `.claude/worktrees/tN-<name>` (gitignored) on branch
   `track/tN-<name>`, created from the Step 0 commit, and runs `npm ci` there first (each worktree has its own
   `node_modules`; `postinstall` copies the ORT files). The repository's default branch is **`master`** (as on the
   remote); the integration agent merges into `master`. The Step 0 Vitest/Vite config excludes `.claude/**`, so a run
   in the main checkout never collects other branches' tests.
3. **Ownership:** a track edits only the paths it owns (§5.1) and never adds files under S0-owned directories
   (`ui/common`, `src/test`, `core/kernel`, …); shared UI it needs lives in its own folder. No new npm dependencies in
   tracks; nobody installs with `--legacy-peer-deps` or `--force`; the lockfile changes only at Step 0 or in the S0
   amendment lane, written by npm 11 (`npx -y npm@11.21.0 install`), while `npm ci` works on npm 10 or 11.
   package.json scripts and `.gitignore` entries are final at Step 0, so no two tracks edit adjacent lines.
4. **Stubs:** Step 0 creates every cross-track entry point of §5.2.1 as a typed stub marked `__stub`. Tests that need
   another track's implementation use `it.runIf(isImplemented(fn))`; integration removes the gate.
5. **Tests:** colocated `__tests__/`, goldens in `__tests__/golden/` (generated by the implementation and compared
   with this document's lists, §2.10.5); synthetic images are generated in code (`src/test/rgba.ts`), never
   downloaded. Timing tests retry twice and use generous bounds. `src/core` tests run in the `node` environment,
   which has no `createImageBitmap`/`OffscreenCanvas`: core code takes `RgbaImage`s (§2.3.1) and PNG fixtures are read
   with `core/kernel/png.ts`. UI tests opt into happy-dom, which has no 2D or WebGL canvas context and no lock manager
   (checked in review with 20.14.5), so they use the seams of §6.3 (T2 pure chart tools, T6 injectable `Viewport`, T8
   lock/channel fakes) and leave canvas, WebGL and multi-tab behavior to Playwright. A track may add browser smoke
   specs at `e2e/tracks/tN-*.spec.ts`.
6. **Data safety:** tests touching persistence use `fake-indexeddb` and temp folders (`CPG_PROJECTS_DIR`), never
   `~/Documents`. Agents start every dev/preview server as `CPG_PROJECTS_DIR=$(mktemp -d) CPG_TEST=1 npm run dev`
   (inside a worktree the port defaults to 5190 + track number; integration passes `CPG_PORT=5199`) — never on port
   5180 and never on the user's folder (the plugin refuses it anyway, §5.5.4). Agents never open
   `http://localhost:5180` — the user's origin, whose IndexedDB holds the user's projects — in Playwright or in the
   user's browser (claude-in-chrome). Playwright runs use their own temp folder and a port derived from the worktree
   name (5290 + track number; 5181 in the main checkout). Nothing in the build plan deletes user projects or backups.
7. **S0 amendment lane:** a frozen-type or Step 0 fix found mid-sprint is written up under "Requests for
   integration" in the track's `docs/tracks/tN.md`.
   Between sprints the integration agent alone applies **additive** amendments (new optional fields, new union
   members, new stubs, new S0 files) on `master` as `S0-amend: <summary>` commits with tests; every track merges
   `master` at the start of its next sprint. Breaking changes to frozen types are not allowed after Step 0.
8. **This document is integration-owned during the tracks.** Tracks never edit `docs/DESIGN.md` or
   `docs/research/**`; they propose changes under "Requests for integration" in `docs/tracks/tN.md`. The integration
   agent applies accepted changes between sprints (with any S0 amendment), adds a §8 revision-log entry and commits
   them as `Design: <summary>`, so every worktree that merges `master` gets the same spec.
9. **Fixture privacy** (github.com/RichardGarza/crochet-pattern-generator is **public**): the user's photos under
   `fixtures/images/3d/real/**` are gitignored by default (`.gitignore` tracks only each object's `expected.json`
   and `README.md`) and are committed only with the user's explicit OK, after `scripts/strip-exif.mjs` re-encodes
   them through headless Chromium with the orientation applied and no metadata (HEIC converted with `sips` first);
   phone JPEGs normally carry GPS position, device and time. `src/test/__tests__/fixturePrivacy.test.ts` fails if any
   tracked JPEG has an APP1 Exif or XMP segment or any tracked PNG an `eXIf` chunk. Claude Design exports (zips,
   standalone HTML, GLB) are scanned for embedded images (`data:image/` URIs, image entries in zips and bundler
   manifests) before committing, and any photo found needs the user's OK. `scripts/make-fixtures.mjs` writes only
   its four generated folders and refuses any path under `real/`, which holds irreplaceable user data.

### 6.2 Step 0 — scaffold (one agent, sequential, before any track)

Deliverables (every command under the Node 22 prefix of §6.1 rule 1):
−1. **Commit the spec before anything else:** `git add docs/ fixtures/claude-design/ && git commit -m "Design v1.2
   and research" && git push`. At review time `docs/DESIGN.md` was untracked and research 04/05 had uncommitted
   edits; worktrees are created from the Step 0 commit, so an uncommitted spec would be missing from every track
   worktree, and a `git stash -u`, `git clean` or checkout during scaffolding could destroy it.
0. **Toolchain:** Node 22.23.3 is installed via nvm (Node 20.18 lacks the native bindings of Vite 8, rolldown and
   oxlint). Its npm 10.9.9 cannot create this lockfile (D1), so ask the user once for OK to run
   `npm i -g npm@11.21.0` inside that Node install (user-owned, undone with `npm i -g npm@10.9.9`); without the OK,
   create and refresh the lockfile with `npx -y npm@11.21.0 install` and use `npm ci` (which works on npm 10 from that
   lockfile) everywhere else. Commit `.nvmrc` (`22`), `"engines": { "node": ">=22.12" }`, `"packageManager":
   "npm@11.21.0"`, `devEngines` (§5.6) and `.npmrc` (`engine-strict=true`). No `@rolldown/binding-*`
   optionalDependency; never `--legacy-peer-deps`.
1. `package.json` with every dependency in §5.6 installed (lockfile committed; `@testing-library/dom` listed
   explicitly) and the **final** scripts: `dev` / `preview` (port from `CPG_PORT`, else 5180 in the main checkout and
   5190 + N in `.claude/worktrees/t<N>-…`; never 5180 under `CLAUDE_CODE_CHILD_SESSION` or `CPG_TEST`, §5.5.4;
   `strictPort`), `build` (`tsc -b && vite build`), `test` (`vitest run`),
   `typecheck`, `lint` (oxlint), `e2e` (`playwright test`), `schema` (`tsx scripts/gen-schema.ts`), `fixtures`
   (`node scripts/make-fixtures.mjs`), `cd-fixtures` (`node scripts/make-cd-fixtures.mjs`), `copy-ort` and
   `postinstall` (`node scripts/copy-ort.mjs`), and `pretest`, `prelint`, `pretypecheck`, `predev`, `prebuild`,
   `pree2e` = `node scripts/check-node.mjs` (exits 1 with the nvm one-liner when Node < 22.12; warns when npm < 11).
   Track-owned script files exist as stubs that print "not implemented yet" and exit 0; `copy-ort.mjs`,
   `check-node.mjs` and `strip-exif.mjs` are real.
2. `vite.config.ts`: React plugin, ES workers, `assetsInclude: ['**/*.wasm']`, `server`/`preview` port as above with
   `strictPort: true`; `server.watch.ignored` **anchored to the project root**:
   ```ts
   const root = fileURLToPath(new URL('.', import.meta.url));
   const skip = ['.claude', 'fixtures', 'test-results'].map(d => path.join(root, d) + path.sep);
   // server: { watch: { ignored: (p: string) => skip.some(d => p.startsWith(d)) } }
   ```
   (v1.1's `'**/.claude/**'` globs are matched against absolute paths, and every track worktree lives under
   `<repo>/.claude/worktrees/`, so a track's own dev server ignored every source edit — verified in review: the page
   stayed on v1, while the run without that pattern updated by HMR); `optimizeDeps: { entries: ['index.html',
   'src/workers/*.worker.ts'], exclude: ['manifold-3d'] }` (the scanner does not follow `new Worker(new URL(…))`
   from `index.html`; with `index.html` alone a cold cache re-optimized on the first worker spin-up and reloaded the
   page — two navigations, reproduced in review with Vite 8.3.1 — and the scanner must still not crawl fixture HTML or
   worktrees); the `projectFolder()` plugin from the T8 stub; vitest `{ environment: 'node', exclude:
   [...configDefaults.exclude, '.claude/**', 'e2e/**'] }` (Vitest 4's default exclude is only `node_modules` and
   `.git`; its excludes are root-relative, so worktrees are unaffected); UI tests opt in with
   `// @vitest-environment happy-dom`. `tsconfig*.json` (room-planner settings **plus `"strict": true`**;
   `erasableSyntaxOnly` ⇒ no enums/namespaces), `.oxlintrc.json`, `playwright.config.ts` (Chromium only;
   `webServer: { command: 'npm run dev', env: { CPG_PORT, CPG_PROJECTS_DIR: <fresh mkdtemp>, CPG_TEST: '1' },
   reuseExistingServer: false }` on `CPG_E2E_PORT ?? (5290 + N in a track worktree, else 5181)`; screenshots on).
3. App shell: `main.tsx`, `App.tsx`, hash router, the **final** tab registry with its visibility predicates (§5.3)
   lazy-importing the entry components of §5.2.1 (stub components created at their track-owned paths), theme tokens
   (light/dark), `ui/shell/**`, `ui/common/**`, error boundary, toasts.
4. `src/types/**` exactly as §3.5.1, §3.7.1, §5.2 and §5.2.1 (compile-checked, then frozen).
5. Kernel implementations **with tests**: `core/kernel` (sRGB/OKLab/toe/features/CIEDE2000 with all 34 Sharma pairs,
   fnv1a64, mulberry32, stable sort, small vec math, the PNG codec `png.ts`), `core/kernel/geom` (indexed clamped
   marching cubes, Taubin, Felzenszwalb EDT 1D/2D/3D, the manifold loader of §5.4 with its node test), `core/gauge`
   (Tables A/B/E, `resolveGauge` incl. `hSc` and `L_ami`, `grid` with border rounds, sphere sizing, yarn per stitch),
   `core/model` (zod schema = §3.5.1 as a discriminated union with round-trip tests, `buildModel` = §3.4.1, Euler XYZ
   ↔ matrix, compose/decompose, analytic SDFs, `inferAttach`, `inferMirrorPairs`, `carryOver`, `nameParts`,
   `placeChildOnSurface`, `readProportions`/`applyProportions` with G23, `scaleModel`), `core/pattern`
   (`CONS`/`PROD`, `validateLine`, `encodeOps` exact DP + fallback + memo + `expand`, compact renderer per §2.7.2 and
   §2.10.11), `core/stub.ts`, and `workers/{rpc,client,decode}.ts` with the §5.4 RPC tests.
6. `fixtures/models/`: `teddy.canonical.json` (the teddy normalized with the Step 0 transform kernels, grounded,
   `inferAttach` + `inferMirrorPairs` applied; T7's normalizer must reproduce it, G12) and `every-type.json` (one part
   of every type, every region and feature kind, `x-*` keys).
7. Stubs for every other module and worker in §5.1 with the frozen signatures of §5.2/§5.2.1; `workers/client.ts`
   with lazy typed `latestWins` proxies; `state/*` stores with tests for update/undo/redo/coalesce and
   `commitModelRevision`; `src/test/fakes.ts` (in-memory `LockManagerLike` and `ChannelLike`).
8. `README.md` (what, run with Node 22, test, status), `docs/DEPENDENCIES.md` (resolved versions + licenses,
   generated by `npm ls`), `.gitignore` (+ `.claude/worktrees`, `test-results`, `playwright-report`, `public/ort/`,
   `dist`, `.cache/`, and `fixtures/images/3d/real/**` with `!fixtures/images/3d/real/**/`,
   `!fixtures/images/3d/real/**/expected.json`, `!fixtures/images/3d/real/**/README.md`), `docs/CAPTURE.md` (below),
   `docs/S-CD.md` (the spike checklist of §3.1), `src/test/__tests__/fixturePrivacy.test.ts`, `e2e/smoke.spec.ts`.
9. Commit "Step 0: scaffold, shared types and kernels" on `master`; push (the GitHub repo exists: public, default
   branch `master`, checked 2026-10-01).
10. Tell the user, in the final Step 0 message: the **capture spec** for the three real photo sets (so they can be
   shot during sprints 1–4), the npm-upgrade question if still open, and that the S-CD spike (sprint 1) needs their
   logged-in claude.ai session or their own run of `docs/S-CD.md`.

**Capture spec** (`docs/CAPTURE.md`, for release gates 2 and 4): three objects — a plush toy, a striped or spotted
object, a simple round object; per object 3–5 photos named by view (`1-front.jpg`, `2-left.jpg`, `3-top.jpg`,
optionally `4-right.jpg`, `5-back.jpg`; "left" = the object's own left side); JPEG or HEIC straight from the phone;
the whole object in frame with at least 10% margin on every side; a plain background that contrasts with the object
(paper or a wall), soft even light, no hard shadow; camera at the object's mid-height, 1.5–2 m away, zoomed 2–3×;
turn the object 90° between shots, not the camera; nothing else touching it. Put the folder in
`fixtures/images/3d/real/<object>/` with a short `README.md` (what it is, height in inches, its colors). The photos
stay on this machine (gitignored) unless the user approves committing EXIF-stripped copies (§6.1 rule 9).

Acceptance: `node -v` ≥ 22.12; `npx oxlint --version` exits 0 and `npx vite --version` prints no Node warning;
`npm test` under Node 20.18 exits non-zero with the check-node message (a wrong runtime fails loudly);
`npm ci` succeeds from the committed lockfile under Node 22's npm 10.9.9 (and under npm 11.21.0) and `npm ls
@testing-library/dom` resolves; typecheck, lint, unit tests and `npm run build` pass; `git ls-files docs/DESIGN.md`
lists the spec and a throw-away worktree created from the Step 0 commit contains it; the dev server shows the start
screen with no console errors (smoke e2e, on the temp folder and port 5181); **cold-cache dev smoke**: after
`rm -rf node_modules/.vite`, opening a 3D tab that spins up `geom.worker` causes exactly one navigation and no
"optimized dependencies changed" reload; **worktree HMR check**: a dev server started in a throw-away worktree under
`.claude/worktrees/` picks up an edit to its own `src/main.tsx` by HMR; the manifold node test returns `NoError`,
genus 0, 1 part; the RPC tests of §5.4 pass; the PNG codec round-trips RGBA8 images; `git check-ignore` ignores
`fixtures/images/3d/real/x/1-front.jpg` but not `fixtures/images/3d/real/x/expected.json`; the fixture-privacy test
passes; with `CLAUDE_CODE_CHILD_SESSION` set, `npm run dev` in the main checkout binds 5199, never 5180; goldens G1,
G2, G3, G4 and G11's Table D part (incl. the amigurumi column) pass; encoder perf tests pass; `schema.parse(x)`
deep-equals `x` for the §3.6 example, `teddy.canonical.json` and `every-type.json`; `inferAttach` on the teddy gives
one tree rooted at `body` with head, arms, legs and tail attached to body (§3.7.3 golden); G23 passes; `buildModel`
returns one named mesh per part with finite geometry (no NaN) — this catches dims lost by a schema that strips
fields — and every lathe mesh's local bbox spans exactly `[y_min, y_max]` of its profile (origin = its `position`,
§0.1); a `vitest run` in the main checkout with a dummy failing test under `.claude/worktrees/` stays green.

### 6.3 Parallel tracks

Each track lists scope, owned paths (§5.1), interfaces, acceptance, required tests and sprints (commit points).

#### T1 — 2D image and color pipeline
- **Scope:** §2.3 ingest (images arrive as `RgbaImage`; the worker decodes `Blob`s with the S0 `decodeImage`,
  which converts HEIC through `/__convert`), background (no "no stitch" in v1), image kind, sampling; §2.4
  quantizer, auto-K, salience, merges, palette sources, p-median, CSV, override colors re-inserted as protected
  centers (§5.5.5), `nearestYarn` (§5.2.1, also used by T4 and T6); yarn data under the licence gate of §5.6; §2.5
  cleanup and metrics; §2.6.2 capture; `chart2d.worker` (`run` behind a latest-wins channel with `gate.check`
  between stages, and `buildPattern` delegating to T2's `buildPattern2D`).
- **Owns:** `core/image2d`, `core/quantize`, `core/yarn`, `core/cleanup`, `core/capture`, `workers/chart2d.worker.ts`,
  `data/yarns`, `scripts/import-yarns.mjs`, `fixtures/images/2d`, `docs/tracks/t1.md`.
- **Consumes:** kernel color/hash/prng/png, `grid`, `resolveGauge`, `workers/{rpc,decode}.ts`. **Provides:**
  `runChart`, `nearestYarn` (§5.2.1), `Chart2dApi`.
- **Gate:** before T1.2 is signed off, every shipped yarn line has a recorded CC BY provenance (§5.6); until then
  only `makebead/craft-color-codes` RHSS (44 shades), stash and CSV ship.
- **Acceptance/tests** (node environment, `RgbaImage` inputs from `src/test/rgba.ts` or PNG fixtures decoded with
  `core/kernel/png.ts`): G13 determinism (10 runs, same hash); G14 two-color logo → 2 colors; `nearestYarn` returns the
  ΔE00-closest shade of the given lines; 32×32 sprite upscaled 8×
  with JPEG-like noise → 32×32 grid 1:1; a 2-px outline stays ≥ 95% connected; confetti ≤ 2% (graph/C2C) and ≤ 1%
  (tapestry) on the flat-art image; Potts lowers changes per row; a 2-cell red "eye" in a 60×60 brown image survives
  at K = 4; p-median never selects the same yarn twice and costs ≤ snap-after-quantize; 6×8 motif tiled to 40×45
  with 3% noise → period (6, 8) and 0 residual errors after regularization; stripes mode detects a 4/2 stripe
  sequence; yarn JSON valid (hex, unique ids, attribution, provenance record); `import-yarns.mjs` refuses a line
  without provenance; overrides survive max colors 8 → 6 and a yarn-line switch with their color identity and pass
  `E_COLOR` (§5.5.5); 200×200 < 300 ms (soft); a superseded run stops at its next `gate.check` and never posts a
  result.
- **Sprints:** T1.1 sampling, kinds, background · T1.2 quantizer, palettes, yarn data (gate) · T1.3 cleanup, metrics,
  overrides · T1.4 capture, worker, performance.

#### T2 — Pattern language, 2D writers, 2D yardage, 2D workspace UI
- **Scope:** verbose US/UK renderers, terminology table, word chart, notes/abbreviations, skill level — exposed as the
  §5.2.1 functions `computeSkill`, `notesFor`, `abbreviationsFor`, `specialStitchesFor`, which T4's 3D `PatternDoc`
  also calls; §2.7 writers (`sc_graphgan`, `sc_tapestry`, `sc_tapestry_round` with the `roundLean` note / pre-skew /
  turn-every-round options, `c2c` with all start corners × hands, `hdc_graphgan`, `mosaic_overlay` behind a flag) and
  the **border** (§2.7.10, Rnd 1 opening from the last line's side and corner); strands/bobbins, 2D validators (incl.
  `E_BORDER`), §2.8 2D yardage (border yarn, skeins from the high end) and materials, `buildPattern2D`; chart and
  text exports (`exportChart`: 1-px PNG via `core/kernel/png.ts`, CSV, chart JSON; `renderPatternText`: plain text /
  Markdown), which T8's export dialog calls; UI: Source tab, settings sidebar (border width/color, C2C start corner,
  round lean), chart view/editor (true-aspect canvas, 5/10 lines, paint/fill/replace/eyedropper/lock/merge/recolor,
  overrides as `ColorRef`; every tool is a pure function `applyChartTool(grid, edits, cell, tool) → recipe`, and
  drawing is skipped when the canvas has no 2D context), palette and stash panel, the generic
  `PatternView`/`MaterialsView` and Pattern/Materials tabs used by both modes (props of §5.2.1, including the ring ↔
  line hover link and `PatternTabProps.settingsSlot`).
- **Owns:** `core/pattern/{render,terminology,notes,skill,doc,wordchart,text}.ts`, `core/techniques` (incl.
  `export.ts`), `core/yardage/twoD.ts`, `ui/twoD`, `ui/pattern`, `state/slices/twoD.ts`, `docs/tracks/t2.md`.
- **Consumes:** kernel encoder/compact renderer/validators/png, gauge, `ChartResult` (a committed fixture JSON until T1
  lands). **Provides:** `buildPattern2D`, `renderLine`, `exportChart`, `renderPatternText`, `computeSkill`,
  `notesFor`, `abbreviationsFor`, `specialStitchesFor` (§5.2.1), the two views and two tabs.
- **Acceptance/tests:** G9, G10 (incl. RH bottom-left and LH bottom-left), G11 (61.9 yd, 14.95 in tile, skeins for the
  high end), G14 PNG round trip (node, `core/kernel/png.ts`), G16 and **G22** borders (odd row count, LH, join, C2C);
  `E_RUN_SUM`, `E_FOUNDATION`, `E_C2C_TILES`, `E_MOSAIC_ADJ`, `E_BORDER`, `E_COLOR` fire on crafted bad input; C2C
  notes name the actual start corner and arrows; `sc2tog` → UK `dc2tog` (never `tr2tog`); C2C bobbins use
  6-connectivity on the transformed chart; vertical repeats only with even block length in flat work; tapestry cues
  list carried colors; hdc foundation `W + 2`; `roundLean: preskew` shifts round k by `round(0.5·(k − 1))` sts and
  keeps every `E_*` green, `turn` alternates RS/WS rounds with WS read in the opposite direction, `note` prints the
  expected drift; editor tools are unit-tested as pure functions in node and write `ColorRef` overrides through
  `projectStore.update`; a happy-dom test mounts the Chart tab (null canvas context) without errors.
- **Sprints:** T2.1 renderers, sc_graphgan, validators · T2.2 tapestry flat/round, C2C (corners), border, yardage,
  materials · T2.3 Source/Settings/Chart editor UI · T2.4 Pattern and Materials views, hdc, mosaic flag, exports.

#### T3 — Photos → 3D (reconstruction, ML, photos UI)
- **Scope:** §2.9.1–2.9.7 including the neck split, part naming through the Step 0 `nameParts`, the attach tree via
  the Step 0 kernels, the single-photo view choice and turn (§2.9.3), single-image back shape/back colors with
  protected components and "one-sided detail", stored part SDF volumes, stored label images and photo palette
  (`labelsKey`, `photoPalette`), and **Apply photo colors** (`GeomApi.projectColors`, reading only stored assets);
  `geom.worker`, `ml.worker` (depth fed with the decoded `RgbaImage`, SlimSAM; ORT config of §5.4; progress through
  `Comlink.proxy`); `scripts/make-fixtures.mjs` (headless Chromium renders into exactly four folders of
  `fixtures/images/3d/`; it refuses any path under `real/`):
  - `teddy-ortho/`: flat-colored orthographic front/left/top/back views of the teddy fixture (as before);
  - `teddy-persp/`: perspective renders (≈ 50 mm-equivalent lens at 1.5 m, key light with a cast shadow, a textured
    background, each view tilted by a deterministic ±5°);
  - `striped-cylinder/` (3 horizontal stripes) and `spotted-ball/` (6 contrasting spots), perspective, 4 views each,
    plus their plain-geometry specs (`*.spec.json`) for the Apply-photo-colors e2e;
  - `real/<object>/` is **not** T3's: three real phone-photo sets supplied by the user to the capture spec of §6.2
    (a plush toy, a striped or spotted object, a simple round object), photos gitignored (§6.1 rule 9). For each
    object T3 writes, and the user confirms, a committed `expected.json`:
    `{ "views": { "1-front.jpg": "front", … }, "heightIn": 9, "parts": { "count": [6, 10], "mustInclude": ["body",
    "head"], "mayInclude": ["ear_l", "ear_r", "arm_l", "arm_r", "leg_l", "leg_r", "tail", "muzzle"] },
    "minIoUPerView": 0.85, "colors": { "count": [3, 4], "stripes": { "part": "body", "minBoundaries": 2 } | null,
    "spots": { "part": "body", "minCount": 4 } | null }, "signedOff": { "by": null, "at": null } }`. Agents never
    download photos of objects from the web; until the sets exist, the specs that use them are skipped with a
    visible "manual gate pending" note, and the gate must close before the v0.1.0 tag (§6.5).
  Photos tab UI (upload with HEIC conversion, turntable labels, mask overlay + brush + click-to-segment, alignment
  sliders with IoU badges, the single-photo view choice, thickness/back shape/back colors/one-sided detail/depth
  button, the build panel's "Split head at the neck", "Merge touching parts" and Advanced "Limb detection", the Yarn &
  size panel step from T6, build with N = 64 preview and N = 128 final, and **Describe it for Claude Design** on a
  failed build); `state/slices/recon.ts`.
- **Owns:** `core/recon`, `workers/geom.worker.ts`, `workers/ml.worker.ts`, `scripts/make-fixtures.mjs`,
  `fixtures/images/3d` (except `real/**`), `ui/photos`, `state/slices/recon.ts`, `e2e/tracks/t3-*.spec.ts`,
  `docs/tracks/t3.md`.
- **Consumes:** kernel (color, EDT, MC, Taubin, png, manifold loader), model schema/transforms/sdf/attach/naming,
  `workers/{rpc,decode}.ts`. **Provides:** `GeomApi`, `MlApi`, `fitPart` (§5.2.1; also used by T5 and T7),
  `ReconResult`.
- **Acceptance/tests** (node environment; the PNG view fixtures are decoded with `core/kernel/png.ts`): three-view
  hull of a sphere r = 0.8 at N = 128 has volume ratio 1.119 ± 0.01; local thickness gives a hemisphere for a disc
  (±2%) and a semicircle for a strip; MC output watertight (0 boundary/non-manifold edges, χ = 2) at N = 64 and 128
  with no zero-area triangles; Taubin keeps volume within 2%; manifold check 1 part, genus 0 (through the S0 loader);
  ellipsoid-union teddy decomposes into ≥ 4 limb parts; `fitPart` recovers sphere/capsule/flat disc (residual
  < 0.03); **teddy view fixtures (ortho and perspective) → a model with `body` and `head` split at the neck, one
  attach tree, `leg_l/leg_r` named**; with "Split head at the neck" off the same views give one body part; masks on
  the perspective renders reach IoU ≥ 0.9 against the rendered ground-truth masks; striped-cylinder views → ≥ 90%
  correct vertex labels; a front-only render of the teddy with eyes yields **no eye-colored vertex on the back
  hemisphere of the head** under the default `backColors: 'part'`; **G25**: `teddy-ortho/left.png` alone labeled
  "left side" → front faces +Z, a part named `muzzle` with center z > head center z, and eye-colored vertices on both
  the +X and −X halves of the head (only +X with "one-sided detail" on); the view turns of §2.9.3 map the photo axes as
  the §2.9.2 table says (front/left/right/top, exact permutations); `projectColors` on the striped-cylinder views and
  a plain cylinder spec paints ≥ 2 whole-round color bands; **persistence**: build from the striped-cylinder views,
  serialize the doc and its assets (`labelsKey`, `maskKey`, `photoPalette`), reload into a fresh store, then
  `projectColors` from the stored assets alone paints the same bands; affine synthetic depth beats inflation-only IoU;
  a wrongly scaled top view triggers the mismatch warning; `e2e/tracks/t3-workers.spec.ts` (T3.1) loads ORT (tiny
  Identity model) and manifold in their workers under `npm run dev` with no console errors;
  `e2e/tracks/t3-depth.spec.ts` (T3.4) runs **only when the Depth Anything V2 Small weights are cached**: it launches a
  persistent Chromium profile (`.cache/cpg-depth-profile/`, gitignored, filled once by release gate 4's
  user-approved download) on the integration e2e port, checks that "Add depth detail" completes with no console
  errors and that the fused volume's IoU against the two-view hull of the same real set is ≥ the inflation-only IoU;
  without cached weights it is skipped with the note "depth weights not cached — release gate 4".
- **Sprints:** T3.1 masks, EDT use, alignment, worker smoke test (ORT + manifold) · T3.2 hull, inflation, view turns,
  meshing, validation · T3.3 labels, back colors, parts, neck split, fit, naming, label persistence · T3.4 ML worker,
  Photos UI, fixtures, `projectColors`, depth spec.

#### T4 — Amigurumi engine (Path A, plan, colors, assembly)
- **Scope:** §2.10.1–2.10.6, §2.10.8–2.10.11, §2.11, §2.12, 3D validators of §2.13 (one code and severity per
  rule; R7/R8/`W_STACKED` per oval side segment), `core/yardage/threeD.ts` (`L_ami` of §2.2.4, skeins for the high
  end), `ami.worker` (owning its private `mesh.worker` for Path B, §5.4), 3D `PatternDoc` assembly with T2's
  `computeSkill`, `notesFor`, `abbreviationsFor`, `specialStitchesFor` and T1's `nearestYarn` (gated): frames
  root-first, the plan rules with flatness = e₁/e₂, start-cap covers with the footprint test and default stuffing
  (never pressed flat at the root), trimming, the pole rule (classic MR = 6; `batchCounts` p0 = 6), textbook truncation
  for open pieces, ovals with per-round `S_k` and the closed-oval finish, BLO sc2tog and jogless prep (per segment on
  ovals), the spiral lean (reference round, front-marker cue, `α_seam(k)`), eye and stuffing cues, joined-round
  stripes, sewing tails, the finite ghost, assembly numbering, kinds and landmark-first text.
- **Owns:** `core/ami`, `workers/ami.worker.ts`, `core/yardage/threeD.ts`, `docs/tracks/t4.md`.
- **Consumes:** kernel encoder/compact renderer/validators, gauge, model transforms and SDFs, `MeshApi` (stub until T5),
  T2 `renderLine` and the T2 doc helpers above, T1 `nearestYarn` (gated), `workers/rpc.ts`. **Provides:**
  `generateAmigurumi` (§5.2.1), rings, ghosts.
- **Acceptance/tests:** goldens generated by the implementation and compared with §2.10.5 (never typed by hand):
  G5 (counts and exact text; no `W_STACKED`), G6, G7 (classic cone `6 6 6 6 12 …`), G8, G17 (the §2.10.1 teddy table
  exactly, from `fixtures/models/teddy.canonical.json`), G18 (incl. the lean case), G19 (symmetric ellipsoid list),
  G20, G21; G8, G19 and the teddy muzzle pass every `E_*` with no `W_SPACING`/`W_STAGGER`/`W_STACKED` from oval end
  segments; property tests: a symmetric profile gives symmetric counts, and random lathe profiles never produce an
  `E_*` and never decrease next to a closed start; muzzle trimmed with an open end and axis Z; leg bands ≈ Rnds 1–3 in
  the pad color; standing-quadruped template legs are stuffed `firm`; the teddy pattern has zero `E_*` (incl.
  `E_ASSEMBLY`, `E_OPEN_EDGE`, `E_EYE_ORDER`); the head's eye cue precedes its stuffing cue and closing round; eyes on
  a 36-st head mirror about the front center ±1 st; every piece with placements prints the front-marker cue and
  every assembly step starts with a landmark; joined-round stripes print the §2.11.3 template and pass
  `E_SPIRAL_CHAIN`; band region → solid rounds, stripes region → alternating rounds, spot → embroidery or appliqué by
  size; a vertical stripe region stays within ±1 st of its azimuth over 12 rounds with the default lean; circular
  Potts reduces errors on noisy synthetic votes; 36-st worsted sphere yardage ≈ 22.8 yd (band 18.2–27.4, G11);
  sewing-tail lengths per §2.10.6 (14" for the 12-st arm opening, 30" for a 36-st opening); deterministic hash; teddy
  < 150 ms.
- **Sprints:** T4.1 profiles, counts, pole rule, textbook (closed and open), goldens · T4.2 placement, BLO/jogless,
  text, validators · T4.3 frames, plan, trimming, ovals, cues, lean, assembly · T4.4 colors (incl. joined rounds),
  yardage, rings/ghosts, worker.

#### T5 — General mesh path and mesh tools
- **Scope:** §2.10.7 Path B (heat method, isolines, seam, constrained DTW, transducer, regularization, pole rule);
  §2.9.8 kernels (narrow-band voxelize with stored-SDF reuse, sculpt brushes with sparse undo, plane cut, **merge**,
  primitive → mesh, fit via T3's `fitPart`); `mesh.worker` (instantiated twice, by the editor and inside
  `ami.worker`; it must not assume a single instance).
- **Owns:** `core/meshtools`, `workers/mesh.worker.ts`, `docs/tracks/t5.md`.
- **Consumes:** kernel geometry (MC, Taubin, EDT, manifold loader), `buildModel`, analytic SDFs, three-mesh-bvh,
  `workers/rpc.ts`. **Provides:** `MeshApi`.
- **Acceptance/tests:** narrow-band `voxelizeMesh` matches a brute-force closest-point SDF within 1 voxel on a 2k
  triangle mesh and runs N = 96 / 40k triangles in ≤ 400 ms; heat-method distance on a sphere mesh within 3% (mean)
  of great-circle distance; capsule isolines are single loops; a Y-shaped mesh returns `needsSplit`; DTW on concentric
  rings gives 18→24 = 12 sc + 6 inc, 36→34 = 32 sc + 2 dec, 6→12 = 6 inc; R1, R2 (pole rule on a pointed mesh tip) and
  R6 hold; Path B on a sphere mesh matches Path A exact counts ±1; inflate/deflate change volume in the right
  direction, smooth lowers curvature variance, flatten lowers the height above the plane; a cut yields two watertight
  meshes whose volumes sum to the original ±2%; **G24 (kernel half)**: merging the teddy's head and body gives one
  watertight genus-0 mesh whose volume is within 2% of the union volume measured on the analytic SDFs, with vertex
  labels from both parts; merging two parts with a gap > 0.1 in is refused.
- **Sprints:** T5.1 voxelize, sculpt, cut, merge, convert · T5.2 heat method, isolines, seam · T5.3 DTW, transducer,
  Path B, worker.

#### T6 — 3D editor UI (Shape tab) and the Yarn & size panel
- **Scope:** all of §4: R3F viewport (builder at `unitScale = 1`, mesh parts with vertex colors) rendered through the
  injectable `Viewport` of `ShapeTabProps`, outliner (attach tree), inspector, gizmos with subtree transforms and
  re-anchoring, the Proportions panel on the Step 0 `readProportions`/`applyProportions`, Scale model to height
  (`scaleModel`), every tool including Add part (`placeChildOnSurface`) and **Merge** (⌘J, `MeshApi.merge`, then the
  Fit primitive offer), rings/ghost/X-ray layers, live pattern loop (latest-wins `AmiApi`), history panel; palette
  "match to a yarn line" through T1's `nearestYarn` (gated); the **Yarn & size panel** (§4.5, `YarnSizePanelProps`)
  used in F2/F3/F4 and on the Shape and 3D Pattern tabs, with the spiral-lean field and its test-tube calibration and
  the 10-stitch yarn calibration; `renderPlacementImage` (§5.2.1) for the PDF; `state/slices/model3d.ts`.
- **Owns:** `ui/shape`, `state/slices/model3d.ts`, `docs/tracks/t6.md`.
- **Consumes:** builder, transforms, SDFs, model kernels (place, proportions, scale), `commitModelRevision`,
  `AmiApi`, `MeshApi` (editor instance), `GeomApi.projectColors`, `projectStore`. **Provides:** `ShapeTab`,
  `YarnSizePanel`, placement renderer.
- **Acceptance/tests:** model3d recipes are pure and unit-tested (mirror negates x and rotation y/z and links
  `mirrorOf`; delete re-attaches children; add-part attaches to the clicked part with a 0.10 in overlap; Attach
  refuses cycles and never detaches); the re-anchoring tests of §4.2 (head 1.2× keeps ear gaps ≤ 0.1 in and `(az, el)`
  within 1°, one undo restores everything; ⌥-move moves the part alone); Scale model to height is one history step
  and one revision; the Proportions panel shows the kernel's readings and disabled reasons, and one slider drag is
  one history step; **G24 (UI half)**: the pure `mergeParts` recipe keeps the id, attach and hints of the selected
  part nearest the root (`body`, although the head is larger), so Merge on the teddy's head + body leaves one attach
  tree (ears, muzzle and eyes re-attached to `body`) and one undo restores both parts exactly; Yarn & size writes `gauge` and `threeD.ami`
  through `projectStore.update` and pre-fills from `model.yarn`; happy-dom tests mount `ShapeTab` with a stub
  `Viewport` (happy-dom has no WebGL context) and select through the outliner or the store: selecting a part shows its
  inspector, editing a dimension updates the doc, a coalesced drag is one history entry, undo/redo restore; the real
  R3F viewport is covered by `editor.spec` (§6.4).
- **Sprints:** T6.1 viewport, selection, outliner, inspector, gizmos (subtree, re-anchoring) · T6.2 add/duplicate/
  delete/mirror/attach/make-as/start, Yarn & size panel · T6.3 paint (incl. Apply photo colors), regions, features,
  rings/ghost, live loop, Proportions, Scale to height · T6.4 sculpt/cut/merge/fit UI, placement renderer.

#### T7 — Claude Design round trip
- **Scope:** §3: Q&A bank with numeric priorities and inline follow-ups (head : body and limb controls through the
  Step 0 `applyProportions`), resumable engine (`QaState.step`), lexicon, category templates and lathe presets, seed
  builder (seed from the current model or a template, stacking through `placeChildOnSurface`, the `x-cpg` tag), prompt
  builder with the builder source and conditional markers, the send step (Copy prompt, Save kit to folder, compact
  prompt) and the **waiting-for-Claude-Design** state (banner, Import tab content, Copy prompt again, Dismiss), the
  `fixup-v1` message (§3.4.2); importer (worker-safe HTML tokenizer, all carriers, ladder E1–E4, **archive spec
  candidates** with the versions chip and picker, the 4-step GLB ladder incl. `extras.crochet`, **units of geometry
  carriers** before fitting with `ImportContext`, dialect normalization, repairs incl. the Step 0 attach/mirror kernels
  and `nameParts`, strict validation, limits, diff, paint carry rule), the **return path** (Start → Import matches
  `x-cpg` or ≥ 60% of a waiting project's seed ids, §3.7.7), JSON Schema generation, `import.worker`,
  `scripts/make-cd-fixtures.mjs` and `fixtures/claude-design/teddy-derived/`; UI: Q&A wizard, seed preview beside the
  current model, send step with instructions, import dialog with repair, units and versions chips, the units confirm,
  "Import into <project>" choice, diff view, Apply photo colors button, the Yarn & size step after accepting;
  `state/slices/qa.ts`. v1.1: sandbox runner, static heuristics.
- **Owns:** `core/importer`, `core/qa`, `workers/import.worker.ts`, `data/templates`, `scripts/gen-schema.ts`,
  `scripts/make-cd-fixtures.mjs`, `fixtures/claude-design/teddy-derived/`, `docs/schema`, `public/sandbox.html`,
  `ui/qa`, `ui/import`, `state/slices/qa.ts`, `e2e/tracks/t7-*.spec.ts`, `docs/tracks/t7.md`.
- **Consumes:** model schema/builder/transforms/sdf/attach/revisions/naming/place/proportions, kernel color, three's
  OBJ/PLY/STL loaders, `fitPart` and `GeomApi.projectColors` (T3, gated), `YarnSizePanel` (T6, gated), the S-CD
  fixtures (I). **Provides:** `ImportApi`, Q&A engine, prompt and fix-up text,
  `docs/schema/crochet-model-1.0.schema.json`.
- **Acceptance/tests:** G12 on every teddy carrier (node environment) and `e2e/tracks/t7-import-worker.spec.ts`
  through the real worker; **G26** (stale side file ⇒ rev 1 with the versions chip; builder-v1 GLB with root extras,
  GLB with per-node extras only, and OBJ + MTL in meters ⇒ 17 parts, bbox within 2%; the observed teddy OBJ stays
  inches); the units rule with and without `expectedHeightIn`, incl. the normalize-to-target fallback and the confirm
  flag; §3.7.3 dialect goldens and the attach tree / mirror pairs; the normalizer reproduces
  `fixtures/models/teddy.canonical.json`; repairs (cm/m/mm ratios, radians, unknown palette ids, cycles, unknown keys);
  security (prototype keys, `..` paths, size and ratio limits); chat replies with prose and smart quotes; tokenizer
  cases of §3.7.4; return-path matching (tag, ≥ 60% ids, 59% rejected, single waiting project offered unselected);
  Q&A tests of §3.2 (per category × origin: `q_what` and `q_notes` shown, every inline follow-up reachable, budgeted
  ≤ 14, unique priorities; re-entry resumes at the saved step); seed tests of §3.3 (templates overlap 0.05–0.15 in,
  lathe base semantics, teddy seed keeps ids and positions and carries `x-cpg`); the prompt has no unfilled `{{` or
  `[[`, no "My own words" line when `FREE_TEXT` is empty, no mention of attached files other than photos, rule 3 keeps
  `x-` keys, rule 7 asks for no side file, escapes free text and embeds the builder (the compact variant omits it);
  the fix-up text has no markers and stays under 600 characters; the committed schema file equals the generated one;
  paint carry rule (§3.7.7).
- **Depends on the S-CD spike:** T7.3 starts only after `fixtures/claude-design/s-cd/` and its README are committed
  (§6.5); findings that change prompt-v1, the builder or the schema reach T7 through this document (rule 8).
- **Manual gate (release gate 1, before the v0.1.0 tag):** the claude.ai/design regression run of §3.1 on three
  objects plus one page without the JSON recovered by the fix-up message, with every export saved as fixtures and
  passing G12 with zero `E_*`; §3.7.3 updated from what was observed.
- **Sprints:** T7.1 tokenizer, text/json/html/standalone/zip, archive candidates, dialect, repairs · T7.2
  glb (4-step ladder)/obj+mtl/ply/stl with units, tar, diff, paint carry, derived fixtures · T7.3 Q&A engine,
  templates, seed source and stacking (after S-CD) · T7.4 prompt, fix-up message, send step, waiting state and return
  path, wizard and import UI (then the manual gate).

#### T8 — Persistence, library, export, PDF and print
- **Scope:** §5.5 (IndexedDB repository with compare-and-swap saves that rebind the tab to its copy, single-writer
  locks with read-only mode, "Edit here instead" and **Take over** after 5 s, `blocking`/`blocked` upgrade handling,
  the `LockManagerLike`/`ChannelLike` seams, autosave, snapshots, `.crochet.json`, migrations, folder-mirror Vite
  plugin and client with the §5.5.4 protocol, isolation rules (test variables, `CLAUDE_CODE_CHILD_SESSION`, worktree
  root, non-master branch), `POST /__convert`, backups on the shared asset store with retention, size cap and
  free-space checks, asset GC, `storage.persist`), start screen and library UI (the "waiting for Claude Design"
  badge), export dialog (project file, plus pattern text/Markdown and chart files through T2's `renderPatternText`
  and `exportChart` — T8 never formats them itself), PDF (cover with the toy ghost or chart size, materials, gauge,
  notes, abbreviations, tiled chart with 2-cell overlap, page map, symbols for B/W, rows with checkboxes, border
  rounds, 3D pieces and assembly with placement images or a text fallback), print; `state/slices/library.ts`.
- **Owns:** `core/persist`, `core/print`, `scripts/project-folder.ts`, `ui/library`, `ui/export`,
  `state/slices/library.ts`, `docs/tracks/t8.md`.
- **Consumes:** `projectStore`, types, `PatternDoc`, T2 `exportChart`/`renderPatternText`, T6 placement renderer
  (optional), `src/test/fakes.ts`. **Provides:** `ProjectRepository` (`createProjectRepository`), `useAutosave`,
  `buildPdf` (§5.2.1), `/__convert`, library screens.
- **Acceptance/tests:** fake-indexeddb save/load round trip; debounce and flush on `visibilitychange`; a save with a
  stale `baseRev` becomes a copy, never overwrites, and **10 further edits after the conflict create exactly one
  copy** (the tab is rebound to it, the original reopens read-only); with the fake lock manager a second tab opens
  read-only, "Edit here instead" hands the lock over after a flush, and with an unresponsive holder **Take over**
  appears after 5 s and steals the lock, after which the old holder's save becomes a copy; a `blocking` event
  flushes, closes and shows the reload banner; snapshot retention; import never overwrites (same id ⇒ copy);
  migrations keep every field (property test); GC keeps referenced assets; `.crochet.json` round trip yields an
  identical doc; the folder-plugin tests of §5.5.4 (isolation rules, shared-asset backups adding < 1 MB for an
  unchanged 100 MB asset set, cap and free-space thresholds, `/__convert` on macOS); PDFs for the G9 pattern and a
  3D pattern start with `%PDF` and have the expected page count for a 120 × 150 chart; section order matches §1.3 F8.
  The real two-tab hand-over and take-over run in `persist.spec` (§6.4).
- **Sprints:** T8.1 IndexedDB, CAS saves, locks, autosave, snapshots, file format · T8.2 folder mirror protocol,
  isolation, backups, migrations, library UI · T8.3 PDF for 2D · T8.4 PDF for 3D, export dialog, print.

### 6.4 Integration (one agent, after the tracks)

1. Merge into `master` in order T8, T1, T2, T4, T5, T3, T7, T6 (ownership and Step 0's final tab registry and
   scripts make merges conflict-free; `App.tsx` flow wiring belongs to integration). Remove `runIf` gates; full unit
   suite green. Between sprints the integration agent also runs the S0 amendment lane (§6.1 rule 7).
2. Wire flows F1–F8: slices ↔ workers (latest-wins channels), autosave and locks, "Not right?" and "Describe it for
   Claude Design" entry points, the waiting-for-Claude-Design banner and the return path, the Yarn & size steps,
   Export/Print.
3. Playwright e2e (`npm run e2e`, Chromium 1243, WebGL headless, on a fresh temp `CPG_PROJECTS_DIR` and the port
   derived in `playwright.config.ts` (5181 in the main checkout) with `reuseExistingServer: false`; every spec fails on
   `pageerror` or console errors; screenshots to `e2e/screenshots/<spec>-NN.png`, a small committed set):
   - `2d.spec`: New 2D → `fixtures/images/2d/logo.png` → worsted, 20 in wide, 1 in border → chart rendered → Pattern
     shows `Row 1 (RS)` and the Border rounds with no ✕ badge → Materials yards include the border → PDF download
     starts with `%PDF`; switching to C2C with start corner bottom-left shows `↘ Row 2`; an odd-row chart whose border
     matches the last stitch opens with "Do not turn"; on macOS a HEIC made at test time with `sips -s format heic`
     from the logo converts through `/__convert` and gives the same chart hash (skipped elsewhere).
   - `import.spec`: Import → teddy `project-archive.zip` → 17 parts and 6 attach chips → accept → Yarn & size panel
     → Shape renders one tree → Pattern lists the §2.10.1 pieces (Leg "make 2" with its cream start band) with
     `Rnd 1: 6 sc in MR (6)`, the eye cue inside the Head and an assembly section; **zero `E_*`**, PDF enabled; then
     CYC 4 → 3: the Body's round counts increase and the toy ghost height stays within 5%. Also: the
     stale-side-file archive shows the "2 versions found" chip and imports rev 1; the builder-v1 OBJ + MTL shows a
     `units` chip ("read as meters"); a copy of the archive page with its `#crochet-model` block removed ends in E8,
     and **Copy fix-up message** puts the `fixup-v1` text on the clipboard.
   - `qa-return.spec`: `teddy-persp/` → build → Not right? → Decide for me → **Copy prompt** → reload → the project
     shows the waiting banner and an Import tab → Start → Import from Claude Design → teddy `project-archive.zip` →
     "Import into <project> (where you made the prompt)" is offered → accept → the result lands **in the same
     project** (its photos still listed) and **Apply photo colors** is offered. A blank-photo build that fails offers
     "Describe it for Claude Design".
   - `multiview.spec` and `single.spec`: `teddy-persp/` (and `teddy-ortho/`) → model → Pattern tab with **zero
     `E_*`**, PDF enabled and the toy ghost height within 10% of the target height; `striped-cylinder/` → ≥ 2
     whole-round color changes in the pattern; `spotted-ball/` → appliqué or embroidery spot lines; `teddy-ortho/left.png`
     as one "left side" photo → the Head piece has eye-color details on both sides of its front center (mirrored
     within ±1 st) and a Muzzle piece; the `real/**` sets when present (release gate 2: each set must meet its
     `expected.json` — part count and names within tolerance, reprojected-hull IoU ≥ `minIoUPerView` per view, color
     count and the stripe/spot findings — with zero `E_*`, and the spec saves `test-results/real/<object>/review.png`
     (photo | rebuilt model | pattern ghost) for the user's sign-off).
   - `photo-colors.spec`: striped-cylinder views → import its plain cylinder spec → Apply photo colors → ≥ 2
     whole-round color changes; repeated after a reload, from stored assets only.
   - `qa.spec`: Not right? → Decide for me through the wizard (`q_notes` is shown) → the copied prompt contains
     `"schema": "crochet-model"` and the project's `x-cpg` tag, every non-root seed part has `attach`, and the text has
     no "My own words" line and no mention of attached files other than photos; leaving and re-entering the wizard
     resumes at the same step.
   - `persist.spec`: edit a chart cell → reload → still there; export `.crochet.json` → delete → import → restored;
     re-run generation keeps the override; a second tab on the same project opens read-only and "Edit here instead"
     hands it over; a frozen holder tab (its event loop paused) is taken over after 5 s; a forced conflict produces
     exactly one copy that the tab keeps editing.
   - `editor.spec`: select head → change rx → round counts change and the ears stay attached (gap ≤ 0.1 in) → undo
     restores; head : body slider 1:1 → the head is 50% ± 1% of the model height; Merge head + body → one part,
     undo → two.
4. Close the manual gates of §6.5. README (features, Node 22, run, data safety, Claude Design how-to),
   `docs/USER_GUIDE.md`; commit, push, tag `v0.1.0`.

### 6.5 Sprint calendar, commit points and gates

| Sprint | Work | Commit points |
|---|---|---|
| 0 | Step 0 (first: commit the spec, item −1) | "Design v1.2 and research", then "Step 0: scaffold, shared types and kernels" on `master` → push |
| 1 (parallel) | **S-CD spike** (integration agent with the user's logged-in browser, or the user from `docs/S-CD.md`; §3.1) | "S-CD: send-side fixtures and findings" on `master` (fixtures + README; DESIGN.md updated if prompt-v1, the builder or the schema must change) — **before T7.3 starts** |
| 1–4 | T1–T8 in parallel, one track sprint each | `TN.k: …` per sprint, pushed to `track/tN-*` |
| after 2 | integration checkpoint: merge T8.1, T1.2, T2.2, T4.2 to `master`, full tests, S0 amendments, tracks merge `master` | "Checkpoint: …" |
| 5 | integration, e2e, docs, gates | "Merge TN" per track, "Integration: flows F1–F8", "E2E smoke tests", tag `v0.1.0` after the gates |
| 6+ | v1.1 backlog (§7.3) | one sprint per item |

**Release gates (manual, before the v0.1.0 tag):**
1. **Claude Design regression** (§3.1): the round trip on three objects plus one page without the JSON recovered with
   the fix-up message; exports saved (after the embedded-image scan of §6.1 rule 9) and passing G12 with zero `E_*`.
2. **Real photos** (T3, the user's sets shot to `docs/CAPTURE.md`): each set reaches the Pattern tab with zero `E_*`
   **and** meets its committed `expected.json` (part count and names within tolerance, reprojected-hull IoU ≥ 0.85
   per view, and for the striped or spotted set the color count and stripe/spot findings); the user signs off each
   `review.png` (photo | rebuilt model | pattern ghost) in the set's README. Ghost height alone proves nothing: the
   model is scaled to the target height.
3. **Yarn data:** every shipped yarn line has a recorded CC BY provenance (§5.6).
4. **Depth 3D-ifier** (R3, §2.9.4; the one-time download of Depth Anything V2 Small happens only on the user's click):
   on one real set, "Add depth detail" completes on WebGPU (`fp16`/`fp32`) and on WASM `q8` (forced by a dev toggle);
   after a reload with the network off it still works from the Cache API; and the fused volume's IoU against the
   set's two-view hull is ≥ the inflation-only IoU. `e2e/tracks/t3-depth.spec.ts` then runs from the cached profile.

---

## 7. Risks, open questions and non-goals

### 7.1 Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Claude Design changes its formats, drops the 3D object skill, or ignores our schema (observed sample: one object) | imports fail | tolerant ladder (§3.7.4), dialect normalizer, attach inference for every carrier, fingerprint drift warning, five return channels (paste JSON, archive, standalone, GLB, OBJ) plus screenshots → F3; the fix-up message for pages without the JSON (§3.4.2); the S-CD spike and the release gate add five more objects; refresh fixtures each release |
| The send side fails (prompt-v1 never run; `.txt` upload unverified; very long pastes may become text attachments) | Claude builds without our seed; import falls back to dialect or E8; a late surprise reworks T7 or the schema | the **S-CD spike in sprint 1**, before T7.3 builds the Q&A and prompt (§6.5); full prompt pasted as text with photos only (§3.4); kit route and compact prompt as fallbacks; the release gate repeats it as a regression check |
| An archive holds a stale copy of the spec (side file, older page) | the pattern is made for a rejected model | every candidate collected, highest revision wins, ties to the rendered page, a visible "versions" chip with a picker (§3.7.2); prompt rule 7 asks for no side file |
| Exports in meters (builder-v1 at 0.0254, the stage's documented units) | parts read 39× too small, clamped and distorted | units decided on raw geometry before fitting and clamping, from the expected height or the stage header, with a confirm (§3.7.5); G26 fixtures in meters |
| The user leaves for Claude Design and cannot find the way back | the result lands in a new project without photos, seed or carried colors | waiting state with banner and Import tab, the `x-cpg` tag and id matching on Start → Import (§3.7.7), `qa-return.spec` |
| In-preview Download buttons do not work | users stuck | instructions point to Share → Export → Project HTML → Project archive and to the chat JSON |
| Gauge variance (±11% between crocheters, ±12–35% between yarns) | wrong sizes | size bands everywhere, swatch/test-ball calibration, "your size will vary" note |
| Amigurumi `w/h` and stuffing stretch only calibrated for worsted | 3D sizes off ±10–20% | the Yarn & size panel for every 3D origin (§4.5): yarn-over/yarn-under toggle, test ball; pattern ghost; tolerance shown |
| Reconstruction quality on real photos (benchmarks are synthetic) | lumpy or wrong shapes | perspective/shadow/background fixtures; three real photo sets with committed `expected.json` (parts, per-view IoU ≥ 0.85, colors) and user-signed review screenshots as release gate 2; mask UX and IoU badges, part decomposition + neck split + Merge + editor, primitive fitting, Claude Design route |
| Single photos taken from the side (animals, fish, vehicles) | front on ±X: wrong part names, seam, left/right, one eye | the required "This photo shows the object's" choice, the exact view turn, mirrored back colors with "one-sided detail" (§2.9.3, §2.9.6, G25) |
| iPhone photos are HEIC; Chrome cannot decode HEIC | the first real photo attempt stops at step 1 | `/__convert` with macOS `sips` in dev/preview (§2.3.1); export-as-JPEG message in static builds |
| The depth model is never run before release | "Add depth detail" ships broken | release gate 4 (WebGPU and WASM, offline after caching, IoU ≥ inflation) and `t3-depth.spec` from the cached profile |
| Spiral lean | patches, stripes and sewn parts drift several stitches | `leanStPerRnd` with a test-tube calibration, a front marker per piece, landmark-first assembly (§2.11.2, §2.12) |
| Plan/trim heuristics misclassify a part | odd pieces | rules pinned by the teddy table (G17); per-part "Make as", start/axis overrides, badges, ghost |
| Path B numerics on poor meshes | failures, odd rounds | re-mesh first, t doubling, `needsSplit` → cut tool, lathe-fit fallback, pole rule |
| Low-end devices | slow | workers, N = 64 previews, budgets (encoder fallback, narrow-band voxelizer), progress and cancel |
| IndexedDB eviction, origin change, two tabs, a hung tab, crash mid-write | apparent or real data loss | `storage.persist()`, fixed port, single-writer locks with take-over and compare-and-swap saves that continue in one copy, upgrade `blocking`/`blocked` handling, folder mirror with atomic writes + change-only backups, export reminders, snapshots |
| Backups fill the disk (34 GiB free; `~/Documents` syncs to iCloud) | a full disk makes saves fail | one shared content-addressed asset store with APFS clones, hash-only change detection, a 2 GB cap, free-space warnings and a 2 GB floor (§5.5.4) |
| Test or agent servers touching the user's projects | overwritten or rotated-out data, migrations run on real data | `CPG_PORT`/`CPG_PROJECTS_DIR` isolation, plugin refuses the default folder under tests, agent shells (`CLAUDE_CODE_CHILD_SESSION`), worktrees and non-master branches; worktree-derived ports; agents never open the user's origin; backups never deleted within 24 h (§5.5.4, §6.1) |
| Toolchain: default Node 20.18, npm 10.9.9 crash, no shell state between agent calls | lint and builds fail or run on the wrong runtime unnoticed | npm 11 lockfile, `packageManager` + `devEngines`, `check-node` pre-hooks, the explicit `nvm use 22` prefix (§6.1 rule 1, §6.2 item 0) |
| Private photos in the public repo (EXIF GPS, faces, homes) | privacy leak | real photo sets gitignored by default, committed only with the user's OK after `strip-exif`, a test that fails on Exif/GPS segments, embedded-image scan of Claude Design exports (§6.1 rule 9) |
| License contamination | public repo at risk | exclusion list (§5.6), license check of `npm ls` at Step 0, own implementations of GPL/NC algorithms, the yarn-data provenance gate |
| Yarn hex values are approximate | color mismatch | ΔE00 shown, "approximate" badges, recolor-to-my-yarn, calibration in v1.1 |
| No WebGPU | slow depth | 1-thread WASM (≈ 2.5 s) or inflation only; clear status |
| Float differences across engines | flaky hashes | hashes over integers and text; geometry tests use tolerances |

### 7.2 Open questions (validate with swatches or manual runs)

Question 4 is answered by the S-CD spike before T7.3 and re-checked by release gate 1 (§6.5); the others do not
block v1.

1. Tapestry aspect in worsted (0.88 comes mostly from thread) and +5% height per extra carried strand.
2. Amigurumi stretch `s` and widths for CYC 1, 2, 5, 6, 7; yarn-under `w/h`; the amigurumi yarn per stitch
   (`L_ami`, ±20% until calibrated).
3. C2C yarn per tile (observed 13–21 in for worsted); calibration prompt after the first project. Border spacing on
   C2C edges (2.6 sc per tile edge from the tile model vs the common "3 sc per block").
4. Whether Claude Design follows `crochet-model` 1.0, our builder and inch units when given the full prompt and
   seed, keeps `x-cpg`, bumps `revision` on changes, and whether long pastes and photo attachments behave as assumed
   (S-CD spike: bunny and teddy, full and compact; release gate 1: three more objects and a fix-up run).
5. Behavior of the in-chat Design template and of the Claude Code handoff `.tar.gz` (unverified layout).
6. Best automatic segmentation of reconstructed meshes (opening + neck split vs shape-diameter function).
7. Spiral lean: the default `leanStPerRnd = 0.25` for RH yarn over and its sign (against the working direction)
   are estimates from "half-stitch slant per round" in tapestry rounds [01 §3.4] and "spirals drift" [03 §6.4.7];
   measure test tubes (RH/LH, yarn over/under, worsted and DK) and update the default; join-as-you-go construction.
8. Cone angle per "increase every other round" (45° reported vs ≈ 60° apex from geometry) — affects seed presets only.

### 7.3 Explicit non-goals for v1 (backlog for v1.1+)

- Techniques: Tunisian, filet, inset mosaic, granny/motif charts, cross-stitch, knitting.
- **Shaped 2D pieces ("no stitch" cells).** v1.1 sketch: per-row stitched span `[a, b]` with consecutive spans
  overlapping by ≥ 1 st (`E_SPAN_OVERLAP`); edge shaping in working order — start extend k: "ch k+1, turn, sc in 2nd ch
  from hook and next k−1 ch"; start retract k: "turn, sl st in next k sts, ch 1"; end retract k: "leave the last k sts
  unworked"; end extend k = 1: "2 sc in last st", k > 1: foundation sc off the last st (or k chains added at the start
  of the previous row); `E_RUN_SUM` becomes "runs sum to the row's span"; foundation = row-1 span + 1; extra ch and
  sl st charged to yardage; golden: a 9-row diamond.
- Generative image-to-3D models (TripoSR, TRELLIS, Hunyuan3D, …), any server, any paid or AI API call.
- Cross-origin isolation / multi-threaded WASM; OpenCV GrabCut, BiRefNet/BEN2, MediaPipe segmentation.
- Sandbox runner and static heuristics (importer E5–E7); PDF/PPTX import; live handoff-URL fetching.
- PlanetJune's invisible join / Ultimate Stripes (cut every round) as a stripe option.
- Physics stuffing simulation (the pattern ghost replaces it); join-as-you-go and seamless (AmiGo B1) segmentation.
- Per-stitch multi-view re-voting with camera estimation (v1 re-projects per vertex with "Apply photo colors"),
  skein-photo yarn calibration, full brand catalogs beyond the licensed core-shade data.
- Row/stitch progress tracker with audio; cloud sync or sharing; editing on phones; HEIC decoding in a static build
  (dev/preview convert it with `sips`, §2.3.1) or on non-macOS servers; a desktop (Tauri) wrapper.
- Patterns written or "improved" by a language model: every stitch count comes from geometry and a validator.

---

## 8. Revision log

### v1.2 — 2026-10-01 (second design review: 32 issues)

Numbers are the review's issue numbers. Checked for this revision: the Path A count goldens (G6, G7, G19, box,
horn) with a reference implementation of the §2.10.5 pseudocode; `L_ami` and the sphere yardage; npm 10.9.9's crash,
npm 11.21.0's install and npm 10's `npm ci` from that lockfile, `devEngines` enforcement on npm 10.9.9 and 11.2.0;
`npm@11.21.0` and `@testing-library/dom@10.4.2` on the registry; HEIC support on caniuse (no desktop Chrome);
`sips` on this Mac; the GitHub repo's visibility (public, `master`); `CLAUDE_CODE_CHILD_SESSION` in agent shells;
the three-d-stage export code (it exports the object passed to `setObject`, so root `userData` becomes root extras).

- **Importer (1, 2, 5):** archives collect every spec candidate; highest revision wins, ties to the rendered page,
  with a versions chip and picker; prompt rule 7 no longer asks for a side file (§3.7.2). `importInputs` takes an
  `ImportContext` (expected height, picked candidate, units answer); geometry carriers decide units before fitting
  and clamping (expected height, stage header for meter-sized boxes, normalize-to-target fallback, confirm); the GLB
  ladder gains per-node `extras.crochet` and an exact accessor/extras unit ratio (§3.7.5). The review's "stage header
  ⇒ meters" alone would have read the captured inch-valued teddy OBJ as meters, so the header applies only when the
  meter reading fits the 60 in limit. E8 and low-confidence imports offer the versioned `fixup-v1` message (§3.4.2).
  New derived fixtures and G26.
- **Single photo orientation (3):** required front/left/right/top choice, exact view turns, mirrored back colors
  for side photos with a "one-sided detail" toggle (§2.9.3, §2.9.6, G25).
- **Return path (4):** waiting-for-Claude-Design state with banner and Import tab, `x-cpg` tag kept by rule 3,
  Start → Import matches the tag or ≥ 60% of the seed's ids, "Describe it for Claude Design" on failed builds,
  resumable wizard, `qa-return.spec` (§1.3 F4, §3.7.7, §5.3).
- **Send side (6):** the S-CD spike in sprint 1, before T7.3, in the user's browser; the release gate stays as a
  regression check plus one fix-up run (§3.1, §6.5).
- **Editor (7, 8):** Merge tool and `MeshApi.merge`; the merged part keeps the id and attach of the part nearest the
  root (the review said "larger", but the teddy's head is larger than its body, which would have left a dangling
  attach); build-panel exposure of neck split, merge touching and limb detection. `applyProportions` is a Step 0
  kernel with defined ratio, scaling, re-anchoring, limb factors 0.6/1/1.5/2.2 of a shared `LIMB_TEMPLATE`, height
  preservation and G23 (§4.2). The ratio is head height to the rest of the total height (1:1 ⇒ 50%, 1:3 ⇒ 25%),
  which is what the review's own goldens measure; its example "head bbox ÷ body bbox" cannot produce them (ears and
  legs add height). Mesh heads scale uniformly; the limb chips need capsule or cylinder limbs.
- **HEIC (9):** `POST /__convert` with `sips` in dev/preview; capture spec given to the user at Step 0 (§2.3.1, §6.2).
- **Real-photo and depth acceptance (10, 11):** `expected.json` per real set (parts, per-view IoU ≥ 0.85, colors),
  signed review screenshots; release gate 4 for Depth Anything V2 Small and `t3-depth.spec` (§6.3 T3, §6.5).
- **Amigurumi math (12–15, 17–19):** flatness = e₁/e₂, never pressed flat at the root, start-cap footprint test
  (G17 unchanged in its results, arms now consistent). R-rules get codes and severities; R7/R8/`W_STACKED` per oval
  side segment, `W_STACKED` only with g ≥ 3. Classic MR = 6 and `batchCounts` p0 = 6 (G7 holds); G19 corrected to the
  symmetric `mirrorHalf` list (the review's sequence, reproduced). R11 becomes `W_SIZE` against each generator's own
  target. Spiral lean with a reference round, front marker, landmark-first assembly, and pre-skew / turn options for
  tapestry rounds. `L_ami = 6.5·max(w_sc, w_ami)` at the amigurumi hook (worsted 1.47 in), ±20% band, skeins from
  the high end; the 36-st sphere is 22.8 yd.
- **Border (16):** Rnd 1 opens where the last line ends (WS: turn; RS: do not turn, from the top left for RH) or with
  a join (always for C2C); G22.
- **Toolchain and Vite (20–23):** npm 11.21 lockfile, `packageManager`, `devEngines` (npm requirement as `warn`:
  an `error` would stop every npm 10 command, contrary to the review's "tracks keep `npm ci`"), explicit
  `@testing-library/dom`, `check-node` pre-hooks, the explicit `nvm use 22` prefix; the manifold loader branches on
  node; `optimizeDeps.entries` includes the workers; `server.watch.ignored` anchored to the project root; Step 0
  acceptance adds cold-cache and worktree HMR checks.
- **Workers and interfaces (24, 25, 27, 28):** latest-wins RPC with cooperative cancellation, `Comlink.proxy`/
  `transfer`, a private `mesh.worker` inside `ami.worker` (D22, §5.4); new frozen entry points for T1/T2/S0 helpers
  and the YarnSize/Pattern/Shape tab props; `nameParts`, `placeChildOnSurface`, `applyProportions`, `scaleModel`
  moved to S0; `RgbaImage` decode seam and an S0 PNG codec (D23); happy-dom seams (pure chart tools, injectable
  Viewport, lock/channel fakes).
- **Persistence and safety (26, 29–32):** stored label images and photo palette for Apply photo colors; Step 0
  commits the spec first and DESIGN.md is integration-owned during tracks; backups on a shared clone-based asset
  store with a size cap and free-space checks; real photos gitignored, EXIF-stripped only with the user's OK, and a
  privacy test; conflicts rebind the tab to one copy, Take over after 5 s, upgrade `blocking`/`blocked` handling,
  stricter plugin refusal rules, worktree-derived ports, and "never open localhost:5180" for agents.

### v1.1 — 2026-10-01 (design review: 42 issues)

Numbers are the review's issue numbers. Goldens marked "computed" were produced by scratch scripts against the
fixtures, not copied from the review.

- **Attach tree (1, 30):** new Step 0 kernels `inferAttach` + `inferMirrorPairs` on analytic SDFs (§3.7.6, D21),
  run for every carrier and by photo reconstruction. Links grow outward from the root by largest overlap, because
  processing parts by size would hang the teddy's head from its muzzle. Prompt rule 2 now requires `attach`. G12
  covers the teddy tree (computed: 6 inferred links from the dialect, 16 from the parentless OBJ).
- **Teddy plan (7, 31):** the "11 pieces" claim is replaced by a computed per-part table (§2.10.1): 8 sections, or
  12 crocheted items without "make 2". Foot pads become leg start bands through an explicit start-cap-cover rule
  (thickness ratio < 0.4). Default stuffing for parts without `stuffing` is now defined.
- **HTML without DOM (2, 33):** a worker-safe tokenizer replaces `DOMParser` (§3.7.4); E4 tolerates whitespace;
  tests run in the node environment, plus a Playwright check through the real worker.
- **2D border (3, 28):** new §2.7.10 (rounds, per-side counts, corners, text, `E_BORDER`, yardage). `grid()` reports
  the actual border. Golden G16: 612/620/628/636 sts, 134.1 yd.
- **Shaped "no stitch" pieces (13, 19):** removed from v1. A v1.1 sketch is in §7.3.
- **Yarn & size for every 3D origin (4):** new §4.5 panel (T6), `q_size` also asks yarn and hook, and an e2e checks
  CYC 4 → 3 on the imported teddy.
- **Claude Design send side (5):** the primary action is now one pasted prompt with the seed embedded, and photos
  are the only attachments. The kit goes to a folder (or one zip). A manual three-object gate runs before release
  (§3.1, §6.5).
- **Lathe position (6):** position means local origin (lathe = base) in §0.1, §3.5.1 and prompt rule 2. Stacking
  uses geometry and SDFs with a fixed 0.10 in overlap (§3.3). Builder unchanged (`builder-v1`).
- **Q&A (8):** numeric priorities. `q_what` and `q_notes` are exempt from the budget. Follow-ups are inline in
  `q_parts`. Ratio, limbs and face steps are merged. The "My own words" line is dropped when empty.
- **Seed source (9):** the current model seeds Claude Design, with recon parts named by geometry (§2.9.7 step 6). The
  category template is used only on request.
- **Editor re-proportioning (10):** transforms move the attach subtree (⌥ moves the part alone). Children are
  re-anchored to the same surface point. Added Proportions and Scale model to height (§4.2).
- **Single-image back colors (11):** `backMode` is split into `backShape` and `backColors`; protected details are
  never mirrored (§2.9.6).
- **Photo colors after Claude Design (12):** "Apply photo colors" (`GeomApi.projectColors`) is v1. `paint` carries
  over only when type and dims match within 10% (§3.7.7, §5.5.5).
- **R2/R3 acceptance (14):** added perspective, shadow and background renders, a striped cylinder, a spotted ball and
  three user-supplied real photo sets (release gate). The e2e tests now reach a zero-error pattern with ghost height
  within 10%. Added a neck split (§2.9.7 step 2).
- **Classic generator vs open ends (15):** the textbook path is used only for closed, untrimmed pieces. Open and
  trimmed pieces are truncated with no decrease phase; `E_OPEN_EDGE` added. Computed golden: §3.6 `arm_l` →
  `6 12 12×5`. The review suggested `12×6`, but that keeps the far cap's share of plain rounds.
- **Safety-eye order (16):** eye cues sit inside the host piece, before stuffing and closing (`E_EYE_ORDER`,
  `W_EYE_OPENING`).
- **Ovals (17, 21):** ellipsoid axis = longest semi-axis unless it is a protrusion. `S_k` is set per round with
  |ΔS| ≤ 1. Added a closed-oval finish accepted by R9. Chain is `N = S + 3`. Computed goldens: box and oval ellipsoid.
- **C2C corners (18):** corner × hand transform table (rotations; only a change of hand mirrors), four arrows, and
  Notes rendered from the actual corner. Computed RH bottom-left golden.
- **Table D (20):** C2C column printed to 2 decimals; G11 = 14.95 in.
- **BLO decreases and jogless prep (22):** BLO/FLO decreases are written `sc2tog` through the stated loops. The
  jogless prep rotates the previous round to end in a plain sc. The cylinder text golden is computed with the
  encoder.
- **Pole rule (23):** `clampPoles` is normative in both paths. Computed goldens: exact cone `5 5 6 8 …`, horn
  `… 6 5`.
- **Ghost (24):** always finite. Stuffed pieces use the meridian-mapped ghost and unstuffed pieces the clamped rise.
  The review's rise-only fix would still leave classic spheres about 40% short.
- **Assembly numbering (25):** left/right corrected (st 10 / st 28), the front-center gap is defined, and the
  top-down swap is documented (G18).
- **Joined stripes (26):** slip-stitch joined-round template, `E_SPIRAL_CHAIN` exemption, rotation override and
  yardage (§2.11.3).
- **Sewing tails (27):** `T = max(12, 3·seam + 6)` in, with closed sewn pieces getting both tails, and yardage to
  match.
- **Toolchain (29, 39):** Node 22 via `.nvmrc`/engines. Vitest excludes `.claude/**` and `e2e/**`. tsx runs TS
  scripts. `npm ci` per worktree. Branch is `master`.
- **Schema (32):** `Part` is a discriminated union; zod uses strict objects; `x-*` keys are preserved; round-trip
  tests.
- **Data safety (34, 42):** `CPG_PORT`/`CPG_PROJECTS_DIR` isolation, the plugin refuses the default folder under
  tests, change-only backups with 24 h protection, a content-addressed atomic mirror protocol with DELETE and a sync
  base, compare-and-swap saves and single-writer locks.
- **ORT/manifold under Vite 8 (35):** object-form absolute `wasmPaths` and one wasm pair (≈ 27 MB) copied on
  postinstall; manifold `locateFile`; worker smoke test moved to T3.1.
- **Performance (36, 37):** encoder DP capped at 120 tokens with a linear fallback and memo; narrow-band voxelizer
  (≤ 400 ms) that reuses stored recon SDFs.
- **Frozen interfaces (38):** new §5.2.1 lists every cross-track entry point with `__stub`. Step 0 owns the final
  scripts, `.gitignore` and tab registry. Added `e2e/tracks/` specs and the S0 amendment lane.
- **Yarn data licence (40):** a T1 gate; only CC BY sources ship until provenance is recorded.
- **Chart overrides (41):** stored by color identity (`ColorRef`) and re-inserted as protected centers.
