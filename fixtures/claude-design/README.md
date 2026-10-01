# Claude Design fixtures

Real output captured from claude.ai/design on 2026-09-30 ("3D object" template, Opus 5.5).
Use these to test the importer against what Claude Design actually produces.

## teddy-bear/

| File | What it is | How it was obtained |
| --- | --- | --- |
| `teddy-bear.crochet-model.json` | The 17-part spec Claude Design embedded in its page | Printed by Claude Design in chat, copied verbatim |
| `teddy-bear.project-archive.zip` | Share → Export → Project HTML → **Project archive** | Downloaded from Claude Design |
| `project-archive/` | The same archive, unzipped (minus `.thumbnail`, a WebP preview) | `unzip` |
| `teddy-bear.standalone.html` | Share → Export → Project HTML → **Standalone HTML** (625 KB, works offline) | Downloaded from Claude Design |
| `amigurumi-teddy-bear.glb` | The page's own **Download GLB** output | Ran `project-archive/` on a local server in headless Chromium and clicked the page's button |
| `amigurumi-teddy-bear.obj.gz` + `.mtl` | The page's own **Download OBJ + MTL** output (OBJ gzipped: 9.5 MB → 1.7 MB) | Same as above |
| `teddy-bear.local-render.png` | Screenshot of the page rendering locally | Same run |

The GLB/OBJ were produced by Claude Design's own `three-d-stage.js` exporter code, run locally, because
the Download buttons inside the claude.ai preview did not respond to automated clicks. The bytes are what
the buttons produce.

## What these files show

See `docs/research/08-claude-design-verified-fixtures.md` for the full findings. In short:

- The spec is in plain text in the project archive's HTML, but **inside a JSON-escaped string** in the
  standalone HTML (`<script type="__bundler/template">`), so that file must be unbundled first.
- All three carriers (chat, archive HTML, standalone HTML) hold the identical spec.
- GLB nodes keep part ids, hierarchy, and `extras` with type + dimensions; colors are linear, not sRGB.
- OBJ has one `o <id>` per part with world-space vertices; MTL `Kd` values are linear.
