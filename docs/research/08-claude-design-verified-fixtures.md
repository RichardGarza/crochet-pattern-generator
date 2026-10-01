# 08 — Claude Design: verified facts from a real run

**Status: VERIFIED by doing it** (2026-09-30, claude.ai/design, "3D object" template, model shown as Opus 5.5).
Where this file disagrees with `05-claude-design-roundtrip.md`, this file wins: 05 was desk research,
this is observed output. The captured files are in `fixtures/claude-design/teddy-bear/`.

## The prompt that was used

Typed after choosing the **3D object** template (which prefills `Model a 3D object:`):

> a classic amigurumi-style crocheted teddy bear, about 10 inches tall, sitting upright. Build it ONLY from
> simple primitives (spheres, ellipsoids, capsules, cylinders, cones) so each part maps to a crochet piece:
> head (ellipsoid), muzzle (flattened ellipsoid, cream), two round ears (flattened spheres with cream inner),
> nose (small dark brown ellipsoid), two black safety eyes, body (egg-shaped ellipsoid), two arms (capsules),
> two legs (capsules, angled forward) with cream foot pads, small round tail. Main color warm caramel brown
> #B07A4A, accents cream #F2E3C6, nose dark brown #3B2A20. Use real-world units in inches, +Y up, front
> facing +Z. IMPORTANT: also embed a machine-readable spec of every part in the page head as
> `<script type="application/json" id="crochet-model">` with
> `{"schema":"crochet-model","version":"1.0","units":"in","finishedSize":{"height":10},"parts":[{"id","name","type","dimensions","position","rotationDeg","color","parent"}]}`,
> build the 3D model at runtime from that JSON, and include GLB and OBJ download buttons.

Result: one generation, about 90 seconds, no clarifying questions, a correct-looking bear of 17 parts.
A follow-up message ("print the complete crochet-model JSON spec ... in a single json code block") returned
the spec verbatim in chat. So **paste-the-JSON-from-chat is a working return channel**.

## What Claude Design produced

### The page (`project-archive/Amigurumi Teddy Bear.html`, 8 KB)

- `<script type="importmap">` pinning `three@0.184.0` from `unpkg.com` with SRI `integrity` hashes
  (three.module.js, three.core.js, OrbitControls, OBJExporter, GLTFExporter).
- `<script type="application/json" id="crochet-model">` with the spec, **in plain text**.
- `<three-d-stage name="amigurumi-teddy-bear" background="#f4efe6">` custom element, loaded from
  `three-d-stage.js` (17 KB, a Claude Design starter component; it owns renderer, lights, orbit controls,
  and the two Download buttons).
- A module script that reads the JSON, builds one `THREE.Mesh` per part, and calls `stage.setObject(root)`.
  The stage keeps the object at `stage._object`.

### The spec dialect Claude Design chose

We gave it only field names. It decided the rest, so **the importer must accept this dialect**:

```json
{
  "schema": "crochet-model", "version": "1.0", "units": "in",
  "axes": { "up": "+Y", "front": "+Z" },
  "finishedSize": { "height": 10 },
  "palette": { "#B07A4A": "caramel_yarn", "#F2E3C6": "cream_yarn", "#3B2A20": "dark_brown_yarn", "#111111": "black_safety_eye" },
  "notes": "dimensions are radii (rx, ry, rz) for ellipsoids/spheres; capsule length is the straight section between hemispherical caps. Child positions/rotations are relative to the parent.",
  "parts": [
    { "id": "head", "name": "Head", "type": "ellipsoid", "dimensions": { "rx": 2.4, "ry": 2.15, "rz": 2.2 }, "position": [0, 7.2, 0.1], "rotationDeg": [0, 0, 0], "color": "#B07A4A", "parent": null },
    { "id": "muzzle", "name": "Muzzle", "type": "ellipsoid", "dimensions": { "rx": 1.0, "ry": 0.75, "rz": 0.6 }, "position": [0, -0.6, 1.8], "rotationDeg": [0, 0, 0], "color": "#F2E3C6", "parent": "head" }
  ]
}
```

| Aspect | What it did |
| --- | --- |
| `sphere` dimensions | `{ r }` |
| `ellipsoid` dimensions | `{ rx, ry, rz }` (radii, not diameters) |
| `capsule` dimensions | `{ radius, length }`, `length` = straight section only (three.js `CapsuleGeometry(radius, length)`); total height = `length + 2*radius`; axis = local +Y |
| `cylinder` (in its builder, unused here) | `{ radius | radiusTop/radiusBottom, height }` |
| `cone` (in its builder, unused here) | `{ radius, height }` |
| `position` | array `[x, y, z]`, **relative to the parent part** when `parent` is set, else world |
| `rotationDeg` | array `[x, y, z]` degrees, Euler order `XYZ`, relative to the parent |
| `color` | sRGB hex string; also keys of `palette` |
| `parent` | part id or `null`; nesting went 3 deep (head → muzzle → nose) |
| Extra top-level keys it added | `axes`, `palette` (hex → material name), `notes` |
| Non-crochet parts | Eyes are parts with palette name `black_safety_eye`. The importer should treat names containing `eye` / tiny dark spheres as safety eyes (notions), not crocheted pieces |
| Child scale | Children are **not** scaled by the parent: ellipsoid scale is baked into geometry (`SphereGeometry(1).scale(rx,ry,rz)`), so parent transforms are rotation + translation only |
| Ground | The model is not grounded at y=0 by the spec (body center y=2.6, ry=2.6 puts its base at 0; legs dip slightly below). The stage shifts the rendered object to rest on the ground "without moving its origin" |

Total height of this bear from the spec: head top = 7.2 + 2.15 = 9.35 in, ears reach about 10 in. `finishedSize.height` = 10.

### Export options actually present (Share menu)

- **Publish as artifact** (public artifact).
- **PDF**.
- **Project HTML** → dialog with two choices:
  - **Project archive** ("Instant", free): a `.zip` named after the project (`Amigurumi teddy bear model.zip`, 12 KB)
    containing `.thumbnail` (WebP image, no extension), `Amigurumi Teddy Bear.html`, `three-d-stage.js`. Flat, no folders.
  - **Standalone HTML** ("Uses Claude", counts toward usage): Claude Design runs a chat task (~1 minute) and offers
    `Amigurumi Teddy Bear (standalone).html` (625 KB) for download.
- **PowerPoint**, plus more formats below the fold (not captured).
- In-page **Download GLB** / **Download OBJ + MTL** buttons (from `three-d-stage.js`). File base name = the
  stage's `name` attribute: `amigurumi-teddy-bear.glb`, `.obj`, `.mtl` (the OBJ and MTL download as two files).

The preview iframe is served from `https://<project-id>.claudeusercontent.com/...?t=<token>`; opening that URL
directly returns an empty shell. **The app cannot fetch a design by URL; the user must export a file.**

### Standalone HTML format (`teddy-bear.standalone.html`)

A self-unpacking bundle. Structure, in order:

1. Loader `<script>` (inline JS; uses `atob` + `DecompressionStream('gzip')`).
2. `<script type="__bundler/manifest">` — JSON object `{ "<uuid>": { "mime", "compressed": true|false, "data": "<base64>" } }`.
   Here 6 entries: `three-d-stage.js`, OrbitControls, OBJExporter, GLTFExporter, three.module.js, three.core.js
   (three.js is inlined, so the file works offline and there is no `unpkg` reference).
3. `<script type="__bundler/ext_resources">` — JSON array `[{ "id": "stageJs", "uuid": "..." }, ...]`.
4. `<script type="__bundler/page_order">` — JSON array (empty here).
5. `<script type="__bundler/template">` — **a JSON string literal** holding the whole page HTML, with `</`
   written as `</` and quotes escaped.

Consequences for the importer:

- A naive regex for `<script type="application/json" id="crochet-model">` on the raw file **does not match**
  (the raw text is `<script type=\"application/json\" id=\"crochet-model\">`).
- Correct recipe (verified in Python against the fixture, result identical to the chat-printed spec):
  1. find `<script type="__bundler/template">…</script>`, `JSON.parse` its text → page HTML string;
  2. parse that HTML (DOMParser) and read `#crochet-model`.
- Detect the format by the presence of `__bundler/template`.
- The original inline module is renamed to `<script type="text/x-app" id="app-src">` in the template and
  re-injected at runtime, so "find the module script" heuristics must also look there.

### GLB (`amigurumi-teddy-bear.glb`, 1.67 MB)

- glTF 2.0, `asset.generator` = `THREE.GLTFExporter r184`. JSON chunk 20 KB.
- 18 nodes: root `amigurumi_teddy_bear` + one node per part. **Node `name` = part `id`.** Hierarchy preserved via `children`.
- Each part node has `matrix` (16 numbers, column-major, **not** TRS) and
  `extras: { "name": "Head", "type": "ellipsoid", "dimensions": { ... } }` (from `mesh.userData`).
  So type and dimensions can be read back exactly, with no mesh fitting. `extras` does **not** include color,
  position or rotation: position/rotation come from decomposing `matrix`, color from the material.
- The full spec is **not** in the GLB (no root `extras`), because the page only set per-mesh `userData`.
  Our prompt should ask for `root.userData.crochetModel = spec` so the GLB carries everything.
- 4 materials named from the palette (`caramel_yarn`, ...). `baseColorFactor` is **linear**:
  `[0.4342, 0.1946, 0.0685]` is `#B07A4A`. Convert linear → sRGB before comparing to hex
  (`srgb = c <= 0.0031308 ? 12.92*c : 1.055*c^(1/2.4) - 0.055`).
- Units are whatever the spec used (inches here), although glTF nominally means meters. Do not assume meters;
  use `extras.dimensions` / spec `units`, or fall back to a bounding-box-vs-finished-size check.
- Mesh density: ellipsoids 2665 vertices each, with POSITION, NORMAL, TEXCOORD_0. No textures, no vertex colors.

### OBJ + MTL (`amigurumi-teddy-bear.obj`, 9.46 MB; `.mtl`, 370 bytes)

- First line `mtllib amigurumi-teddy-bear.mtl`. One `o <part id>` + one `usemtl <palette name>` per part, 17 objects,
  38,165 `v` lines and 71,520 faces.
- Vertices are in **world space** (parent transforms baked in). No hierarchy, no dimensions, no part type:
  importing an OBJ needs primitive fitting per object.
- **Quirk: the model is shifted up.** The first vertex is `v 0 5.2 0` (top of the body, whose spec top is y = 5.2),
  so here it matches, but the stage may move the object to rest on the ground; do not trust absolute Y, re-ground on import.
- MTL: `newmtl <name>`, `Kd r g b` in **linear** values (same numbers as the GLB), `Ks 0.2 0.2 0.2`, `Ns`, `d`.
  Convert `Kd` linear → sRGB to recover the hex colors.
- The file is large because every primitive is exported at 48–64 segments. The importer must handle ~10 MB of text
  without freezing (parse in a worker).

## Recommended importer priority (most reliable first)

1. Pasted JSON / `.json` file (chat copy).
2. `.zip` project archive → find the `.html` → `#crochet-model`.
3. Plain `.html` (archive page) → `#crochet-model`.
4. Standalone `.html` → unbundle `__bundler/template` → `#crochet-model`.
5. `.glb` → node names + `extras` + matrices + linear material colors (exact primitives recovered).
6. `.obj` (+ optional `.mtl`) → per-object primitive fitting (lossy).

Importer tests should assert that sources 1–5 all yield the same 17 parts as `teddy-bear.crochet-model.json`.

## Still unverified

- The in-preview Download buttons did not produce a file when clicked by browser automation; whether they work
  for a human click was not tested. The app's instructions should mention Share → Export → Project HTML as the
  dependable route.
- The remaining export formats below PowerPoint in the Share menu were not opened.
- Behaviour of the Claude Design template inside regular Claude chat / Claude Code (as opposed to claude.ai/design).
- Whether Claude Design follows the same dialect on other objects or prompts (sample size: one).
