# Derived Claude Design fixtures (teddy)

Written by `npm run cd-fixtures` (`scripts/make-cd-fixtures.mjs`, track T7, DESIGN.md §3.7.7) from the captured,
read-only `../teddy-bear/` folder and `fixtures/models/teddy.canonical.json`. Do not edit by hand: run the script
again (its output is byte-for-byte deterministic). Used by G12/G26 (`src/core/importer/__tests__/g26.test.ts`) and by
`e2e/tracks/t7-import-worker.spec.ts`.

| File | What it is |
| --- | --- |
| `teddy-stale-side-file.zip` | The project archive with `"revision": 1` added to the page's JSON and a `crochet-model.json` at revision 0 whose ears (and ear linings) are 20% smaller, one hour older than the page |
| `teddy-builder-v1.glb` | What the archive's own `three-d-stage.js` "Download GLB" button saves for a builder-v1 page (the §3.4.1 builder at `unitScale = 0.0254`, so meters) showing the canonical teddy: root `extras.crochetModel` |
| `teddy-builder-v1.noroot.glb` | The same page with `group.userData.crochetModel` deleted: only the per-node `extras.crochet` remain (GLB ladder step 2) |
| `teddy-builder-v1.painted.noroot.glb` | Per-node extras only, with a band on the body in `blush_pink`, a color no solid part uses (step 2 reads it back from `COLOR_0`) |
| `teddy-builder-v1.obj.gz` + `teddy-builder-v1.mtl` | "Download OBJ + MTL" of the same page (meters, `# Exported by three-d-stage`); the OBJ gzipped like the captured one |
| `teddy-builder-v1.mm.stl.gz` | Binary STL of the builder at 25.4 units per inch (millimeters), gzipped |
| `teddy-builder-v1.ply.gz` | Binary PLY with 8-bit vertex colors, in meters, gzipped |
| `teddy-handoff.tar.gz` | A Claude Code handoff bundle: `README.md`, `chats/chat1.md` (the spec in a json fence) and `project/` with the archive page and `three-d-stage.js` |
| `teddy-handoff-waiting.tar.gz` | A handoff bundle exported while Claude was still asking a question (no `project/` folder) |

The browser exports ran in headless Chromium against a local server: the archive page with the canonical teddy as its
`#crochet-model` JSON, its module script replaced by the §3.4.1 builder (taken from `docs/DESIGN.md`), and the import
map pointed at the local `node_modules/three` (0.186.1; the captured page pinned 0.184.0) — no network.
