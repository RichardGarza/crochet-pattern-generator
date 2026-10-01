# 05 — Claude Design round-trip (R5 + R6)

Research date: 2026-09-30. Scope: what Anthropic's **Claude Design** is, what it exports, and a concrete design for sending a crochet-friendly 3D brief to Claude Design and importing the result back into our app. The app is client-side only and makes no paid AI API calls.

## Evidence labels

| Label | Meaning |
|---|---|
| **[V-official]** | Stated in an Anthropic source: anthropic.com, support.claude.com, code.claude.com or claude.com. |
| **[V-observed]** | Seen first-hand: in exported files on public GitHub that I downloaded and decoded, in three.js source I fetched, or in the "Design" Artifact-type definition on this account (read-only call). |
| **[Leak+]** | From an unofficial copy of Claude Design's system prompt and skills, and **corroborated** by real files (byte-identical starter files in public repos; SRI hashes I recomputed). |
| **[Reported]** | From third-party coverage or tooling that I could not verify myself. |
| **[Inference]** | My own reasoning or recommendation. |
| **[Uncertain]** | Unknown or conflicting. It needs a manual test in Claude Design before we rely on it. |

---

## 0. TL;DR

1. **What it is.** Claude Design is an Anthropic Labs product, launched **2026-04-17** and powered by **Claude Opus 4.7** at launch. It builds designs, prototypes, slides and one-pagers as **HTML** while you chat with it [V-official: [anthropic.com/news](https://www.anthropic.com/news/claude-design-anthropic-labs)]. Since **2026-09-16** it is also a *template* inside any Claude chat, inside Claude Code (`/design`) and in the Artifacts tab. The standalone app at **claude.ai/design** keeps working [V-official: [get-started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design), [release notes](https://support.claude.com/en/articles/12138966-release-notes)]. *[FC: Claude Code's `/design` research preview actually came earlier, the week of 2026-08-17 (v2.1.234+). The 2026-09-16 note is the "any conversation, including in Claude Code and the Artifacts tab" launch.]*
2. **Export menu** [V-official]: *Download as .zip*, *Export as PDF*, *Export as PPTX*, *Export to Google Slides* (claude.ai/design only), *Export as standalone HTML*, *Send to* 15 partner tools (Canva, Adobe, Gamma, Lovable, Miro, Netlify, Replit, v0, Vercel, Wix and others), and *Handoff to Claude Code* (local or web). Share links require a Claude account, so **our app cannot fetch them** [V-official: [share-artifacts](https://support.claude.com/en/articles/9547008-share-artifacts)]. *[FC: the article's only stated exception is a legacy artifact published from a chat. The Claude Code artifacts doc separately describes public links that need no sign-in. In both cases the page is served inside claude.ai's sandboxed viewer (`*.claudeusercontent.com`). Fetching that viewer cross-origin is untested, so the conclusion stands.]*
3. **3D is supported.** Standalone Claude Design has a built-in **"3D object" skill**: a three.js model you can download as **GLB** or **OBJ + MTL**. It uses a `<three-d-stage>` viewer with three.js **0.184.0** loaded through a pinned unpkg import map, builds models from **named primitives**, and works in **meters, y-up** [Leak+: [3d-object SKILL](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-design/skills/3d-object/SKILL.md). The same 16,612-byte `three-d-stage.js` appears in [a public repo](https://github.com/Amethyst-Deceiver2001/Mariupol_Urbicide_2026/tree/main/docs/exhibits/levoberezhny-3d), and the SRI hashes match unpkg]. *[FC: re-verified 2026-09-30. Both copies are 16,612 bytes, sha256 `072cca1b…649ef5`, byte-identical. The public copy was committed 2026-07-30, three weeks before the leak (2026-08-19), so it corroborates the leak independently. All five SRI hashes recomputed from unpkg match. The launch post itself (V-official) lists 3D among prototype capabilities: "voice, video, shaders, 3D and built-in AI".]*
4. **The "standalone HTML" export is a self-unpacking bundle** [V-observed]. It contains `<script type="__bundler/manifest">` (a JSON map of uuid to `{mime, compressed, data}`, base64-encoded and optionally gzipped), `<script type="__bundler/template">` (the real page as a JSON string) and optionally `__bundler/ext_resources` *[FC: plus, in some exports, `__bundler/page_order` for nested pages (seen in larri)]*. **A naive text search for our JSON in the raw file fails**, because the page is JSON-escaped inside the template. We have to unbundle it first.
5. **Our contract with Claude Design** [Inference/recommendation]: a versioned JSON spec, **`crochet-model` v1.0**, embedded as `<script type="application/json" id="crochet-model">`. The three.js model is **generated from that JSON at runtime**, so the picture and the data cannot drift apart. The same spec is copied into `group.userData.crochetModel` and `mesh.userData.crochet`, so it **survives GLB export as glTF `extras`** (verified in three.js r184 source). There is also a "Copy crochet spec" button, and Claude prints the JSON in its final chat reply. That gives five independent return channels.
6. **Importer** [Inference]: it detects formats by magic bytes and accepts `.html/.htm/.dc.html` (plain, Design Component, or `__bundler`), `.zip`, `.tar.gz/.tgz` (the handoff URL bundle), `.glb`, `.gltf`, `.obj` + `.mtl`, `.ply`, `.stl`, `.json`, pasted text or Markdown, and PNG/JPG as a last resort. When no JSON is present, it runs the page in a `sandbox="allow-scripts"` iframe with an injected `__THREE_DEVTOOLS__` hook plus download interception.
7. **Q&A** [Inference, grounded in amigurumi design guides]: a deterministic, adaptive form of about 8–14 questions. It builds a **seed spec**: the parts list, palette and proportions. Claude Design receives the seed together with the photos and only *refines* it. Part ids stay stable, so diffing and the R7 editor work.

---

## 1. What Claude Design is (facts)

| Fact | Status / source |
|---|---|
| Anthropic Labs product, launched **2026-04-17** as a research preview for Pro, Max, Team and Enterprise plans | [V-official] [anthropic.com/news/claude-design-anthropic-labs](https://www.anthropic.com/news/claude-design-anthropic-labs) |
| "Claude Design is powered by our most capable vision model, Claude Opus 4.7" at launch *[FC: quote corrected; it was given as "Powered by Claude Opus 4.7, our most capable vision model"]* | [V-official] same page. **The current model is not stated** in today's support docs. Opus 5.5 shipped 2026-09-22 ([9to5Mac](https://9to5mac.com/2026/09/22/anthropic-upgrades-claude-with-new-opus-5-5-model-details-here/); also the official [release notes](https://support.claude.com/en/articles/12138966-release-notes)). Opus 4.8 (2026-05-28) and Opus 5 (2026-07-24) shipped before it. Whether Design now uses any of them is **[Uncertain]**. |
| Creates "designs, interactive prototypes, one-pagers, and other visual work"; dashboards, landing pages, app flows, forms, internal tools | [V-official] [get-started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) |
| Inputs: prompts, images and screenshots, DOCX/PPTX/XLSX, codebases and GitHub, a web-capture tool, design systems | [V-official] anthropic.com/news; [claude.com/product/design](https://claude.com/product/design) |
| Refine via chat, inline comments on the canvas, direct canvas editing, and adjustment knobs | [V-official] anthropic.com/news; get-started |
| Surfaces: chat (Output > Design), Artifacts tab, Claude Code (`/design`, `/design-sync`), mobile (you can ask for a design in a chat and view it; no canvas editing, templates or sharing changes) *[FC: was "mobile (view only)"]*, standalone **claude.ai/design** | [V-official] get-started; [code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts) |
| The Design, Slides and Docs templates launched in beta on paid plans on **2026-09-16** ("Create designs, decks, and docs in any conversation") | [V-official] [release notes](https://support.claude.com/en/articles/12138966-release-notes). *[FC: the official sources disagree about plans. The release note says artifacts "including Claude Design, Claude Slides, and Claude Docs, are available on every plan, including Free" and are beta and off by default on Enterprise. "What are artifacts" says templates "are in beta on paid plans only". Get-started says beta on Pro, Max, Team and Enterprise.]* |
| `/design` in Claude Code: research preview shipped the week of **2026-08-17** (v2.1.234+). The artifacts doc says v2.1.265+ for template commands | [V-official] [whats-new 2026-w34](https://code.claude.com/docs/en/whats-new/2026-w34); artifacts doc |
| Previews run "inside a sandboxed iframe on a separate content domain that Anthropic operates" | [V-official] [admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans) |
| Usage counts toward the plan's shared limits. The earlier separate weekly allowance is gone | [V-official] get-started |
| Known limits: no version history; basic multi-person editing; inline comments sometimes vanish; very large repos lag; mobile can't edit; no data residency; unavailable for CMEK, ZDR and HIPAA orgs and on third-party clouds | [V-official] get-started; [artifacts admin guide](https://support.claude.com/en/articles/16994751-artifacts-admin-guide-for-team-and-enterprise-plans) |
| Chat upload limits: 20 files per chat, 500 MB per file, images up to 8000×8000 px (JPEG, PNG, GIF, WebP) | [V-official] [upload files](https://support.claude.com/en/articles/8241126-upload-files-to-claude). Whether standalone Design shares these limits is **[Uncertain]**. |
| Claude Code can reach Design over MCP: `claude mcp add --transport http claude-design https://api.anthropic.com/v1/design/mcp`, then `/design-login` | [Reported] [digitalstrategyai](https://digitalstrategyai.substack.com/p/claude-design-now-works-inside-claude). This needs login, so it can't be used by our browser app. *[FC: the post (2026-09-06) gives the command as `claude mcp add --scope user --transport http claude-design https://api.anthropic.com/v1/design/mcp`.]* |

### 1.1 Two different "Design" runtimes (important for 3D)

| | **Standalone claude.ai/design** | **Design template** (chat, Artifacts tab, Claude Code `/design`) |
|---|---|---|
| Project model | Filesystem project. Since about June 2026 at the latest, the default format is **Design Components** (`Name.dc.html` plus a generated `support.js` runtime) *[FC: it was given as "Since about Aug 2026". Public DC exports containing `<x-dc>` and the dc-runtime were committed on 2026-06-24 (D-LAN) and 2026-06-26 (fitx). The August date is when the DC-default prompt leaked (captured 2026-08-19/21).]*. Plain `.html` is allowed "for an experience that is entirely `<canvas>`/WebGL" [Leak+: [claude-design.md](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-design/claude-design.md)]. Older projects (April) used React 18.3.1 + Babel 7.29 from unpkg with SRI [Leak: [hqman gist](https://gist.github.com/hqman/f46d5479a5b663c282c94faa8be866de); V-observed: `ext_resources` pointing at `unpkg.com/react@18.3.1` in [sovrenix/larri](https://github.com/sovrenix/larri/blob/main/gh-pages/index.html)]. *[FC: larri is itself a DC-era export: it contains the dc-runtime and `<x-dc>` and was committed 2026-08-25 to 09-16. It shows CDN React inside a DC page, so it is not evidence of an April React/Babel project. The gist (created 2026-04-18) does pin react@18.3.1 and @babel/standalone@7.29.0 with SRI.]* | A canvas artifact. `project/canvas.json` (index `{"v":3, boards, order, pages, notes, designSystems}`) plus one `.dc.html` per artboard, with uploads served as `/_blob/<id>` [V-observed: the Design type on this account, release `1790801787-9bdf`, contract `0.2.47`]. |
| 3D | **"3D object" skill**: `three-d-stage.js` plus a pinned import map for three@0.184.0 (OrbitControls, OBJExporter, GLTFExporter only). Toolbar: **Download OBJ + MTL** and **Download GLB** [Leak+]. Real `.dc.html` files also embed three r128 from unpkg inside `<helmet>` [V-observed: [CogniPilot.dc.html](https://github.com/CogniPilot/website/blob/main/CogniPilot.dc.html)]. | The type's rules say *"no network except a Google Fonts css2 `<link>` … and [uploaded] urls"* and *"no `<iframe>`, `<object>` or `<embed>"* [V-observed]. A CDN three.js load may be blocked. **[Uncertain]** until tested. *[FC: the same rules also require classic JS ("no imports") and markup-only UI ("never script-built"), so a three.js scene works against them. Uploaded `.js` files may be loaded through `<script src="/_blob/<id>">`; that route is untested for three.js.]* |
| Downloads from page code | The stage triggers `a[download]` with blob URLs and posts `omelette:notify-3d-export` telemetry to the host, so the host expects downloads to work [Leak+]. | claude.ai artifact viewers **block** page-started downloads, including `blob:` and `data:` links, unless the page declares the *downloads* capability [V-official: [code.claude.com artifacts](https://code.claude.com/docs/en/artifacts)]. The Design type lists `downloads` among its capabilities [V-observed]. Whether artboard code can use that capability is **[Uncertain]**. |
| Export | Full menu (§2) | Same menu per the support doc. Per-artboard **PNG/PDF** export per the Claude Code docs [V-official]. |

**Recommendation:** tell users to run our prompt at **claude.ai/design** and to pick **3D object** from the slash menu. The prompt (§5) still works in the in-chat template, because there the JSON plus SVG fallback views carry the data.

---

## 2. Output and export file types — what each contains

### 2.1 Official menu [V-official]

From [get-started](https://support.claude.com/en/articles/14604416-get-started-with-claude-design) ("Use the Export button in the upper right corner"):

- *Download as .zip*
- *Export as PDF*
- *Export as PPTX*
- *Export to Google Slides* (claude.ai/design only)
- *Export as standalone HTML*
- *Send to the tools you already use*: Adobe Experience Manager, Adobe for Creativity, Adobe Journey Optimizer, Base44, Canva, Gamma, HubSpot, Hyperframes, Lovable, Miro, Netlify, Replit, v0, Vercel, Wix
- *Handoff to Claude Code*: *Send to local coding agent* or *Send to Claude Code Web*

The admin guide summarizes this as "export to HTML bundles, PPTX, and PDF, hand-off to Claude Code, and sending designs to the partner tools". The launch post says "save as a folder, or export to Canva, PDF, PPTX, or standalone HTML files."

### 2.2 Standalone HTML — the `__bundler` format [V-observed]

I decoded five public exports ([openscreen](https://github.com/getopenscreen/openscreen/blob/main/design/openscreen-widget.html), [larri](https://github.com/sovrenix/larri/blob/main/gh-pages/index.html), [polymorphism/fitx](https://github.com/lraihan/polymorphism/blob/main/web/prototypes/fitx.html), [techne](https://github.com/lynxlangya/techne/blob/main/site/index.html), [D-LAN](https://github.com/Ummon/D-LAN/blob/master/doc/D-LAN%20Redesign%20proposition.html)). They match community unbundlers ([datapartnership/unbundle.py](https://github.com/datapartnership/ai-index-workplan/blob/main/unbundle.py), [MovingJu/unbundle.py](https://github.com/MovingJu/co-mmit/blob/main/scripts/unbundle.py)) and the format description in the leaked *Save as standalone HTML* skill (super_inline_html bundler).

```
<!DOCTYPE html><html><head><title>Bundled Page</title><style>#__bundler_thumbnail…#__bundler_loading…</style></head>
<body>
  <div id="__bundler_thumbnail"><svg …/></div>          ← splash, also the no-JS fallback
  <div id="__bundler_loading">Unpacking...</div>
  <script> DOMContentLoaded loader … </script>           ← decodes & swaps the document
  <script type="__bundler/manifest">{"<uuid>":{"mime":"text/javascript","compressed":true,"data":"H4sI…"}, …}</script>
  <script type="__bundler/ext_resources">[{"id":"https://unpkg.com/react@18.3.1/…","uuid":"…"}]</script>   (optional)
  <script type="__bundler/template">"<!DOCTYPE html>\n<html><head>…<script src=\"<uuid>\"><\u002Fscript>…"</script>
</body></html>
```

*[FC: I re-decoded all five files on 2026-09-30. `<title>Bundled Page</title>` appears in three of the five; larri and techne keep their own titles. larri also has a fourth tag, `<script type="__bundler/page_order">`, a JSON array of nested-page uuids. These are iframe targets shipped once in the root manifest and loaded through `about:blank#<uuid>` markers. The unbundler must therefore decode `text/html` manifest entries too, which §7.2's code already does. In the skeleton above, the template's `</script>` was changed to `<\u002Fscript>` to match the escaping below.]*

What the loader does:

1. base64-decodes each asset, then gunzips it with `DecompressionStream('gzip')` if `compressed` is set.
2. Makes a blob URL for each asset.
3. Replaces every uuid in the template with its blob URL.
4. Strips `integrity` and `crossorigin` attributes.
5. Exposes `window.__resources` (from `ext_resources`).
6. Parses the result with `DOMParser`, then calls `document.documentElement.replaceWith(...)`.
7. Re-creates every `<script>` so it executes in order. `text/babel` scripts are fetched and inlined, and `Babel.transformScriptTags()` is called.

Things we saw in the decoded files:

- The **dc-runtime** (`// GENERATED from dc-runtime/src/*.ts`) is a gzipped JS asset.
- Google Fonts are inlined as woff2 assets.
- CDN scripts referenced by `src` (React from unpkg) are inlined and mapped through `ext_resources`.
- The template JSON-escapes the `/` of **every** closing tag. larri uses `<\/` (131 times) and the other four use `<\u002F` (for example `<\u002Fscript>` and `<\u002Fx-dc>`), so no literal `</` appears inside the template *[FC: it was given as "escapes closing tags as `</script>`", which had lost the escape]*. The raw file therefore never contains our JSON block verbatim; you must `JSON.parse` the template first.
- Resources referenced only from JS strings, or loaded by dynamic `import()`, are **not** inlined unless the page declares them with `<meta name="ext-resource-dependency" content="…" data-resource-id="…">`, which the page then reads from `window.__resources[id]` [Leak+, and observed in [levoberezhny-quarter.html](https://github.com/Amethyst-Deceiver2001/Mariupol_Urbicide_2026/blob/main/docs/exhibits/levoberezhny-3d/levoberezhny-quarter.html), which loads a JSON dataset that way].

**Is the standalone HTML self-contained?**

- Mostly yes: scripts, fonts, images and CSS are inlined.
- It **needs JavaScript**. It needs `DecompressionStream` when assets are gzipped; that API has been Baseline since May 2023 and is now "Widely available" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)).
- 3D pages that load three.js through an **import map** probably still fetch it from unpkg at runtime. A Claude Design handoff README for a three.js site says the self-contained files "open directly in any browser … (3D loads from CDN, needs network)" [V-observed: [foundry handoff README](https://github.com/abhijitbansal/foundry/blob/main/docs/design/handoff/README.md)]. Whether the 3D-object import map is inlined is **[Uncertain]**; it is most likely not.

### 2.3 "Download as .zip"

This is the project folder [Inference from the leaked `present_fs_item_for_download` tool: "If the path is a folder, will be turned into a zip file … Omit or use "" to download the entire project"; Leak+]. Observed handoff and project folders contain:

- `*.html` / `*.dc.html`
- `support.js` (the DC runtime)
- starter components (`three-d-stage.js`, `deck-stage.js`, `image-slot.js`)
- `uploads/…`
- optional `screenshots/`
- helper `*.jsx` / `*.js`
- data `*.json`
- a `README.md` when the folder is a handoff

Examples: [paulodev40 handoff](https://github.com/paulodev40/SolucoesInteligentes/tree/main/pagina_home) (`designs/Home Imersiva v2.dc.html`, `designs/support.js`, `designs/uploads/`) and [sthree-boutique](https://github.com/pudgeismylife-hash/sthree-boutique/tree/main/app-handoff). One third party claims the zip holds `artifact.html`, `manifest.json`, `assets/` and `comments.json` ([opendesigner.io](https://opendesigner.io/import-from-claude-design)). That is **[Reported/conflicting]**, so the importer must not depend on fixed file names.

### 2.4 Handoff to Claude Code (two forms)

- **Folder or zip**: `design_handoff_<feature>/README.md` plus copies of the HTML prototypes. The README template calls the files "design references created in HTML" (in its "About the Design Files" section, after Overview) and covers Overview, About the Design Files, Fidelity, Screens, Interactions, State, Design Tokens, Assets and Files *[FC: it was given as "opens with" that phrase]* [Leak+: [handoff skill](https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-design/skills/handoff-to-claude-code/SKILL.md); dozens of public READMEs, for example [foundry](https://github.com/abhijitbansal/foundry/tree/main/docs/design/handoff)].
- **URL bundle**: Claude Design gives a one-line prompt, *"Fetch this design file, read its readme, and implement the relevant aspects of the design. https://api.anthropic.com/v1/design/h/<id>?open_file=<File>.html"* [V-observed in public repos, for example [redthread TODO](https://github.com/hkjeldsberg/redthread/blob/main/TODO.md)]. *[FC: a GitHub code search finds this exact wording in more than a dozen repos. It is usually followed by a line `Implement: <File>.html`, and some URLs carry no `?open_file=`. The redthread copy was edited by its user ("…of the design for the existing app.").]* The URL returns `application/gzip`, a **tar.gz** with `<project>/README.md` ("CODING AGENTS: READ THIS FIRST"), `chats/chat<N>.md` (the transcripts) and `project/…` [Reported: [orchestkit](https://github.com/yonatangross/orchestkit/blob/main/src/agents/claude-design-orchestrator.md), [Deo-ahn](https://github.com/Deo-ahn/Deo-ahn.github.io/blob/main/bin/sync-design.md)]. The URLs are reportedly short-lived ([heyadam](https://github.com/heyadam/claudedesign-to-swiftui)) *[FC: heyadam's exact words are "short-lived / one-shot", which suggests a URL may be single-use, so opening it once could use it up]*. Both public URLs I tested returned **404**, and **no CORS headers** came back [V-observed]. *[FC: re-tested 2026-09-30 with an `Origin` header. All 9 public handoff URLs found on GitHub (redthread plus 8 found by code search) returned 404 `text/plain` with no `Access-Control-Allow-Origin` and `content-security-policy: default-src 'none'; frame-ancestors 'none'`. A 404 shows nothing about CORS on a live 200 response, so that remains (unverified).]* So the app cannot reliably fetch them. The user should open the link in a browser to download the `.tar.gz` and drop it into the app. The `chats/*.md` files will contain the JSON code block that our prompt asks Claude to print.

### 2.5 3D object viewer downloads [Leak+]

- **GLB**: `GLTFExporter.parseAsync(object, {binary:true})` → `<name>.glb`. Node and mesh names are the part names. **`userData` is exported as glTF `extras`**: `serializeUserData()` is applied to nodes (every Object3D, meshes included, so `mesh.userData` lands in `nodes[i].extras`), mesh primitives (from `geometry.userData`), materials, animation clips and scenes [V-observed in [r184 GLTFExporter](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/exporters/GLTFExporter.js)] *[FC: it was given as "nodes, meshes, materials and scenes"; there is no mesh-level call]*. `GLTFLoader` maps `extras` back with `Object.assign(object.userData, extras)` [V-observed in r184 GLTFLoader]. Units are meters, y-up.
- **OBJ + MTL** (two files, `<name>.obj` and `<name>.mtl`): `o <mesh.name>` and `usemtl <material.name>`. The stage writes **`Kd` from `material.color.r/g/b`, which in r152+ are linear-sRGB working-space values**. `MTLLoader` assumes `Kd` is sRGB (`colorSpaceToWorking(…, SRGBColorSpace)`) [V-observed in r184 source]. A naive re-import therefore **darkens colors**. The importer must detect the header `# Exported by three-d-stage` and treat `Kd` as linear. *[FC, checked in the r184 source and the stage file. `OBJExporter` writes vertex colors only for `Points`, never for meshes. Parts painted with vertex colors (§5.3) therefore arrive in OBJ/MTL in the painted material's own color, which is white by default, and lose their regions. The stage's `_nameParts()` also renames duplicate material names (`c1_painted` → `c1_painted_<n>`), so match material names by prefix.]*
- STL is not offered. The skill says those two formats are the ones on offer and forbids other addons.

### 2.6 Other exports — value for us

| Export | Contains | Use in our app |
|---|---|---|
| PDF | Print-based ("the user saves the page as a PDF" [Leak+]); WebGL output may be blank | Last resort. Look for a printed JSON with pdf.js text extraction, otherwise rasterize the page and send it to R3. |
| PPTX | Native shapes (editable mode) or one PNG per slide | Unzip and search `ppt/slides/*.xml` text for JSON; images go to R3. Low priority. |
| PNG (per artboard) | Raster | Send to the R3 single-image pipeline. Silhouettes are easy to segment against the stage's flat background (`#f0eee6` by default). |
| Canva, Google Slides, partner tools | Hosted copies | Not importable. |
| Share link | Requires a Claude account ("People without one can't open a shared artifact, even with the link") | Not importable [V-official]. |

---

## 3. Round-trip architecture

```
 our app ─(3D result rejected)─► Q&A wizard ─► seed spec (crochet-model v1, revision 0)
    │                                              │
    │                     prompt text + crochet-brief.txt + seed.json + photos
    │                                              ▼
    │                        claude.ai/design  ── "3D object" skill
    │                        HTML page: <script type="application/json" id="crochet-model">
    │                        model = buildModel(JSON)  (same builder as our app)
    │                        user iterates (chat/comments) → JSON revision++
    │                                              │
    │  return channels, in order of robustness:    ▼
    │   A. "Copy crochet spec" button → paste box            (text JSON)
    │   B. Export ▸ standalone HTML / .zip                   (__bundler or folder)
    │   C. viewer "Download GLB" (extras carry full spec)    (.glb)
    │   D. Handoff ▸ open URL → .tar.gz                      (chats/*.md + project/)
    │   E. final chat reply ```json block → paste            (text)
    │   F. PNG screenshots → R3 pipeline                     (lossy fallback)
    ▼
 importer ─► validate/repair ─► R7 3D editor (edits the same JSON) ─► pattern generator (R1/R2/R4/R8)
```

**Key decision [Inference]:** make `crochet-model` JSON the app's **canonical internal 3D representation**, used by R2, R3, R5 and R7.

- Multi-view and single-image reconstructions are fitted *into* this primitive-based schema.
- The R7 editor edits it.
- The pattern generator consumes it.
- Claude Design only ever *refines* it.

The JSON → three.js builder in §5.3 should be shared by our app and by the page we ask Claude Design to write. Then both renderers show the same thing.

---

## 4. The `crochet-model` JSON spec, v1.0

### 4.1 Conventions (fixed in v1)

- **Units**: inches. **Axes**: right-handed; **+Y up**; the object's **front faces +Z** (toward a default three.js camera); the **object's own left is +X**, so `ear_l` has x > 0. The **lowest point is at y = 0**. Units and axes are written into the file for self-description.
- `position` is the primitive's **local origin in model space**. This is absolute, not relative to the parent, because LLMs place absolute coordinates more reliably than nested transforms [Inference]. `rotationDeg` is Euler **XYZ in degrees**. three.js uses order `'XYZ'` and applies X, then Y, then Z in the object's local frame.
- Primitive local frames match three.js r184 [V-observed source]:
  - Sphere, Cylinder, Cone, Capsule and Lathe have their axis along **local Y**.
  - Cone has its apex at +Y.
  - Torus lies in the **local XY plane** around Z.
  - `CapsuleGeometry(radius, height)` uses `height` for the **middle section only**. Our `capsule.length` is the **total** tip-to-tip length; the builder converts.
- **Surface directions** for spots, patches and features use **azimuth/elevation in the part's local frame**: az 0° = front (+Z), az +90° = object's left (+X), el +90° = top (+Y). For unrotated parts this equals the model frame.
- **Bands and stripes** use `from`/`to` ∈ [0, 1] along the part's local Y extent, with 0 at the bottom. These map directly to rounds when the part is worked in the round.
- Colors are **sRGB hex** (`#rrggbb`) and are referenced by palette id.

### 4.2 Types (authoritative; validate with zod at runtime)

```ts
type Hex = string;                 // /^#[0-9a-fA-F]{6}$/
type Vec3 = [number, number, number];
type PartType = 'sphere'|'ellipsoid'|'capsule'|'cylinder'|'cone'|'torus'|'lathe'|'flat'|'box';

interface CrochetModelV1 {
  schema: 'crochet-model'; version: '1.0'; revision: number;   // revision++ on every edit; importer prefers highest
  units: 'in'; axes: { up: '+Y'; front: '+Z'; left: '+X' };
  name: string; description?: string;
  category?: 'quadruped'|'biped'|'bird'|'sea'|'insect'|'person'|'creature'|'food'|'plant'|'object'|'other';
  style?: 'chibi'|'realistic'|'minimal';
  audience?: 'adult'|'child'|'under3';                          // under3 ⇒ embroidered features only
  finishedSize: { height: number; width?: number; depth?: number };   // overall bbox, inches
  pose?: 'standing'|'sitting'|'lying'|'hanging'|'free'; flatBase?: boolean;
  yarn?: { weightCYC?: 0|1|2|3|4|5|6|7; hookMm?: number; stsPerIn?: number; fiber?: string };
  palette: { id: string; hex: Hex; name?: string; role?: 'main'|'accent'|'detail' }[];   // 1..16
  parts: Part[];                                                // 1..60
  features?: Feature[];                                         // 0..60
  assembly?: { order: number; part: string; to?: string; text: string }[];
  assumptions?: string[];
  source?: { tool?: string; stage?: 'seed'|'refined'|'edited'; views?: string[]; createdAt?: string };
  [k: `x-${string}`]: unknown;                                  // extensions are ignored, never rejected
}

interface Part {
  id: string;                      // /^[a-z][a-z0-9_]{0,31}$/, unique; mirror pairs end _l / _r
  label?: string; type: PartType; dims: Dims;
  position: Vec3; rotationDeg?: Vec3;                            // inches; degrees
  color: string;                                                 // palette id (base)
  regions?: Region[];                                            // ≤ 24
  attach?: { to: string; method?: 'sewn'|'crochet-in-place'|'worked-from'|'glued'|'none'; openEnd?: 'top'|'bottom'|'none' };
  mirrorOf?: string; stuffing?: 'firm'|'medium'|'light'|'none'; flatten?: number;  // 0..1 pressed flat
  notes?: string;
}
type Dims =
  | { r: number }                                          // sphere
  | { rx: number; ry: number; rz: number }                 // ellipsoid
  | { r: number; length: number }                          // capsule: TOTAL length incl. caps (≥ 2r)
  | { rTop: number; rBottom: number; h: number; open?: 'none'|'top'|'bottom'|'both' }  // cylinder
  | { r: number; h: number }                               // cone (apex +Y)
  | { R: number; r: number; arcDeg?: number }              // torus (ring in local XY)
  | { profile: [number, number][] }                        // lathe: [radius, y] bottom→top, r ≥ 0, y ascending, 3..64 pts
  | { shape: 'circle'|'oval'|'teardrop'|'triangle'|'rect'|'polygon'; w: number; h: number; thickness: number; points?: [number, number][] } // flat, local XY, faces +Z
  | { w: number; h: number; d: number };                   // box

type Region =
  | { kind: 'band'; from: number; to: number; color: string }
  | { kind: 'stripes'; from?: number; to?: number; colors: string[]; widthIn: number }   // horizontal (= rounds)
  | { kind: 'patch'; azimuthDeg: number; spanDeg: number; from: number; to: number; color: string } // belly, face mask
  | { kind: 'spot'; azimuthDeg: number; elevationDeg: number; radiusIn: number; color: string }
  | { kind: 'pattern'; pattern: 'spots'|'leopard'|'checker'|'speckle'|'gradient'|'vertical-stripes'; colors: string[]; scaleIn?: number; coverage?: number; from?: number; to?: number };

interface Feature {
  id: string; kind: 'safety_eye'|'embroidered_eye'|'felt'|'nose'|'mouth'|'cheek'|'brow'|'whiskers'|'line'|'applique';
  on: string; azimuthDeg: number; elevationDeg: number;    // on that part's surface (local frame)
  sizeMm?: number; sizeIn?: number; color?: string;
  path?: [number, number][];                               // [az, el] polyline for embroidery
  mirror?: boolean;                                        // also place at −azimuth
}
```

**JSON Schema skeleton** (the full schema is generated from zod with `z.toJSONSchema`; this is the excerpt Claude Design needs):

```json
{ "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:crochet-pattern-generator:crochet-model:1.0",
  "type": "object",
  "required": ["schema","version","units","name","finishedSize","palette","parts"],
  "properties": {
    "schema": {"const": "crochet-model"}, "version": {"pattern": "^1\\.[0-9]+$"},
    "revision": {"type": "integer", "minimum": 0}, "units": {"const": "in"},
    "finishedSize": {"type":"object","required":["height"],"properties":{"height":{"type":"number","exclusiveMinimum":0,"maximum":60}}},
    "palette": {"type":"array","minItems":1,"maxItems":16,"items":{"type":"object","required":["id","hex"],
       "properties":{"id":{"pattern":"^[a-z0-9_]{1,16}$"},"hex":{"pattern":"^#[0-9a-fA-F]{6}$"}}}},
    "parts": {"type":"array","minItems":1,"maxItems":60,"items":{"type":"object",
       "required":["id","type","dims","position","color"],
       "properties":{"id":{"pattern":"^[a-z][a-z0-9_]{0,31}$"},
         "type":{"enum":["sphere","ellipsoid","capsule","cylinder","cone","torus","lathe","flat","box"]},
         "position":{"type":"array","items":{"type":"number"},"minItems":3,"maxItems":3},
         "rotationDeg":{"type":"array","items":{"type":"number"},"minItems":3,"maxItems":3}}}}
  },
  "patternProperties": {"^x-": {}} }
```

### 4.3 Worked example (abridged)

```json
{ "schema":"crochet-model","version":"1.0","revision":2,"units":"in",
  "axes":{"up":"+Y","front":"+Z","left":"+X"},
  "name":"Clover the bunny","category":"quadruped","style":"chibi","audience":"child",
  "finishedSize":{"height":7.0,"width":3.4,"depth":3.6},"pose":"sitting","flatBase":true,
  "yarn":{"weightCYC":4,"hookMm":3.5,"stsPerIn":5},
  "palette":[{"id":"c1","hex":"#C8A27A","name":"tan","role":"main"},{"id":"c2","hex":"#F4EBDD","name":"cream"},
             {"id":"c3","hex":"#F2A7B5","name":"pink"},{"id":"c4","hex":"#222222","name":"black","role":"detail"}],
  "parts":[
    {"id":"body","type":"lathe","dims":{"profile":[[0,0],[1.1,0.05],[1.55,0.6],[1.6,1.4],[1.35,2.4],[0.9,3.0],[0,3.2]]},
     "position":[0,0,0],"color":"c1","stuffing":"firm",
     "regions":[{"kind":"patch","azimuthDeg":0,"spanDeg":110,"from":0.1,"to":0.75,"color":"c2"}]},
    {"id":"head","type":"ellipsoid","dims":{"rx":1.35,"ry":1.2,"rz":1.25},"position":[0,4.05,0.1],"color":"c1",
     "attach":{"to":"body","method":"sewn","openEnd":"none"}},
    {"id":"ear_l","type":"flat","dims":{"shape":"teardrop","w":0.9,"h":2.2,"thickness":0.3},
     "position":[0.55,5.95,0],"rotationDeg":[0,0,-10],"color":"c1","flatten":1,
     "regions":[{"kind":"band","from":0.15,"to":0.85,"color":"c3"}],"attach":{"to":"head","method":"sewn","openEnd":"bottom"}},
    {"id":"ear_r","mirrorOf":"ear_l","type":"flat","dims":{"shape":"teardrop","w":0.9,"h":2.2,"thickness":0.3},
     "position":[-0.55,5.95,0],"rotationDeg":[0,0,10],"color":"c1","attach":{"to":"head","method":"sewn"}},
    {"id":"tail","type":"sphere","dims":{"r":0.5},"position":[0,0.8,-1.45],"color":"c2","attach":{"to":"body"}}
  ],
  "features":[{"id":"eye_l","kind":"embroidered_eye","on":"head","azimuthDeg":32,"elevationDeg":-10,"sizeIn":0.3,"color":"c4","mirror":true}],
  "assumptions":["Arms omitted: the photos show the paws tucked under the body."] }
```

*[FC: the eye's `elevationDeg` was changed from 10 to −10. At +10° the eye sits above the head's midline (about 41% of the way down), which contradicts the "at least halfway down the head" guidance in §6.1. The example also misses rule 2's 0.05–0.15 in overlap, worked by hand. The head's bottom (y = 4.05 − 1.2 = 2.85) sinks 0.35 in into the body's top (y = 3.2). The tail sphere's centre (z = −1.45) is inside the body surface (z ≈ −1.56 at y = 0.8), so 0.61 in of the tail is buried and only 0.39 in shows. The model's bounding box is about 3.2 in wide against `finishedSize.width` 3.4, which is inside the importer's 15% tolerance.]*

### 4.4 Versioning and compatibility

- `version` is `MAJOR.MINOR`. The importer accepts any `1.x` and **ignores unknown keys**. The `x-*` prefix is for experiments.
- New primitive types or region kinds bump the MINOR version. The importer maps unknown types through an **alias table**. If no alias matches, it falls back to the part's bounding ellipsoid and shows a warning.

  | Alias | Maps to |
  |---|---|
  | `egg`, `oval`, `ovoid` | ellipsoid |
  | `ball` | sphere |
  | `bean`, `pill` | capsule |
  | `tube`, `disc` | cylinder |
  | `ring`, `donut` | torus |
  | `dome`, `hemisphere`, `pear` | lathe |
  | `plate`, `leaf`, `wing` | flat |

- A breaking change (for example new axes or units) becomes `2.0`. Keep a `migrate_1_to_2()` function.
- Store the importer's normalized copy plus the untouched original, so we can re-parse after fixes.

### 4.5 Validation and repair (importer)

```
parse → zod.safeParse (lenient mode) → repairs, each logged as a warning:
  ids: slugify, dedupe (suffix _2), fill missing; mirror pairs: if only *_l exists and mirrorOf/notes say pair → synthesize *_r
  units: bbox = union of part AABBs (analytic per primitive, rotated)
         ratio = bbox.height / finishedSize.height
         ratio≈2.54 → cm; ≈0.0254 → m; ≈25.4 → mm → rescale; else if |ratio−1| > 0.15 → uniform scale to finishedSize.height
  axes: if bbox is tallest along Z and flatBase → offer "rotate −90° about X" (don't auto-apply)
  ground: translate so min y = 0
  rotations: if every |v| ≤ 6.3 and ≥ 1 value is a non-integer near k·π/12 → treat as radians (warn)
  colors: unknown palette id → nearest palette color by CIEDE2000 (or add to palette if a hex was given inline)
          linear-looking values (all channels ≤ 0.5 from an MTL marked three-d-stage) → linear→sRGB
  dims: clamp to [0.05, 48] in; warn below the min feature size (= 6 / (π · stsPerIn) diameter)
  graph: attach.to must exist and be acyclic; flag parts with no contact (gap > 0.1 in) to their parent
  features: drop if `on` is missing; clamp az to [−180, 180] and el to [−90, 90]
  limits: parts ≤ 60, palette ≤ 16, regions/part ≤ 24, profile pts ≤ 64, text ≤ 2 MB, nesting depth ≤ 12
  security: reject the keys "__proto__", "constructor" and "prototype" anywhere (reviver); never Object.assign raw extras
```

---

## 5. The prompt template

### 5.1 Delivery

The app produces three things:

1. A **short message** to paste.
2. **`crochet-brief.txt`**, the full brief. Uploading it avoids paste mangling, and chat accepts TXT and JSON.
3. **`crochet-model.seed.json`**.

The user attaches the photos in the stated order. The app also offers "Copy full prompt" for users who prefer pasting. Prompt size is roughly 11–18 KB with the builder included *[FC: it was given as "about 7–10 KB". Measured from this document: the template is ≈4.3 KB, the builder ≈4.8 KB and the seed 2–8 KB depending on the part count]*, which is still fine for chat.

Claude Design's own question form normally asks 6–10 questions (max 12), always offers "Decide for me", and **appends a design-system question when no design system is attached** [Leak+]. The prompt therefore pre-empts those questions with "no design system; don't ask". The app's instructions tell the user to click **Decide for me** if a form still appears.

### 5.2 Template (`{{…}}` are filled by the app; `[[if …]]` lines are dropped when empty)

````text
Use the "3D object" skill. (If you don't have it, build ONE plain .html page that loads three.js 0.184.0 from unpkg through an import map.)

# Task
Make an amigurumi-style 3D model — a crocheted, stuffed yarn toy — of: {{OBJECT_NAME}} ({{OBJECT_SUMMARY}}).
A separate crochet app will turn your model into a crochet pattern, so the machine-readable spec (rules 3–4) matters more than visual polish. No design system is needed and please don't ask me questions — everything I know is below and in crochet-brief.txt / crochet-model.seed.json. Where something is unclear, decide and record it under "assumptions".

# References
[[if PHOTOS]] I attached {{PHOTO_COUNT}} photos in this order: {{PHOTO_ORDER}}. Use them for shape, proportions and colors. If a photo and my answers disagree, my answers win.
[[if NO_PHOTOS]] There are no photos; work from this description.
My own words: "{{FREE_TEXT}}"
[[if REJECTED]] An automatic 3D reconstruction got this wrong: {{REJECTION_REASONS}}. Avoid repeating that.

# Size, yarn, style
- Finished size: {{HEIGHT_IN}} in tall[[if W]] × {{WIDTH_IN}} in wide[[if D]] × {{DEPTH_IN}} in deep. Pose: {{POSE}}.[[if FLAT_BASE]] It must stand/sit on a flat base.
- Yarn: {{YARN_NAME}} (CYC {{CYC}}), {{HOOK_MM}} mm hook, about {{STS_PER_IN}} stitches per inch. No part may be thinner than {{MIN_FEATURE_IN}} in across. Fewer, bigger parts are better (at most {{MAX_PARTS}} parts).
- Style: {{STYLE_SENTENCE}}. Audience: {{AUDIENCE}}.[[if UNDER3]] Under 3 years: no safety eyes or small separate pieces; all facial features are embroidered.

# Parts I expect (keep these ids; refine sizes and positions from the photos; add parts only if clearly visible)
{{PARTS_LINES}}          e.g. "- head: ball, ~45% of total height, color c1, sewn on top of body"

# Colors (use only these ids; hex values are sRGB)
{{PALETTE_LINES}}        e.g. "- c1 #C8A27A tan (main)"
Color patterns: {{PATTERN_LINES}}   e.g. "- body: cream belly patch on the front, lower 75%"
Face and details: {{FEATURE_LINES}} e.g. "- eyes: embroidered black, ~halfway down the head, 1.2 in apart"

# Seed spec — start from this and refine it
```json
{{SEED_JSON}}
```

# Rules
1. Build ONLY from these primitives, one mesh per part: sphere, ellipsoid, capsule, cylinder, cone, torus, lathe (surface of revolution — best for most crocheted pieces), flat (thick 2-D shape for ears, wings, fins, felt), box. Each part becomes one crocheted piece, so use round, chunky shapes and no tiny details. Mirror pairs exactly across x = 0.
2. Spec units are inches. Axes: +Y up, the object's front faces +Z, the object's own left is +X, the lowest point is at y = 0. Parts that are sewn together overlap by 0.05–0.15 in (no gaps). In three.js, multiply inches by 0.0254 (the stage works in meters).
3. Put the spec in the page <head> as <script type="application/json" id="crochet-model">…</script>, same schema as the seed ("schema":"crochet-model","version":"1.0"). Generate the 3D model at runtime FROM that JSON with the reference builder below; never hard-code geometry outside the JSON. Whenever I ask for a change, edit the JSON and add 1 to "revision". Never put "<" or curly braces inside JSON string values.
4. mesh.name = part id, material.name = color id, mesh.userData.crochet = that part's JSON object, and the model group's userData.crochetModel = the whole spec (so the GLB download carries it).
5. UI: keep the stage's "Download GLB" and "Download OBJ + MTL" buttons. Add buttons Front / Left / Back / Top (move the camera, never the model), "Exploded view", and "Copy crochet spec" (navigator.clipboard.writeText of the pretty-printed JSON; if that fails, show the JSON in a selectable textarea). No Tweaks panel, no other libraries, no external images.
6. If three.js cannot load in this environment, still embed the JSON and draw front, side and top views from it as inline SVG.
7. Name the file "{{SLUG}} crochet model.html" and use <three-d-stage name="{{SLUG}}">. Also save the same JSON as crochet-model.json in the project.
8. When you finish (and after every later change), reply with a short list of assumptions and the full final JSON in ONE ```json code block.

# Reference builder (keep these semantics; you may restyle the page)
```js
{{BUILDER_JS}}
```
````

### 5.3 Reference builder (`BUILDER_JS`, also used in our app)

This builder uses only core three.js classes, as the 3D-object import map requires. Vertex colors are applied only to parts with `regions`, so that OBJ/MTL keeps per-part colors for everything else.

```js
import * as THREE from 'three';
const S = 0.0254;                                   // inches → meters
const D2R = THREE.MathUtils.degToRad;
export function buildModel(spec) {
  const pal = Object.fromEntries(spec.palette.map(c => [c.id, c.hex])), mats = {};
  const solid = id => mats[id] ??= Object.assign(new THREE.MeshStandardMaterial({ color: pal[id] ?? '#cccccc', roughness: 0.85, metalness: 0 }), { name: id });
  const group = new THREE.Group(); group.name = spec.name || 'model'; group.userData.crochetModel = spec;
  for (const p of spec.parts) {
    const g = geometryFor(p); let mat = solid(p.color);
    if (p.regions?.length) { paint(g, p, pal); mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, name: p.color + '_painted' }); }
    const m = new THREE.Mesh(g, mat); m.name = p.id; m.userData.crochet = p;
    m.position.set(...p.position.map(v => v * S));
    const r = (p.rotationDeg ?? [0, 0, 0]).map(D2R); m.rotation.set(r[0], r[1], r[2], 'XYZ');
    group.add(m);
  }
  return group;
}
function geometryFor(p) {
  const d = p.dims;
  switch (p.type) {
    case 'sphere':    return new THREE.SphereGeometry(d.r * S, 48, 32);
    case 'ellipsoid': return new THREE.SphereGeometry(1, 48, 32).scale(d.rx * S, d.ry * S, d.rz * S);
    case 'capsule':   return new THREE.CapsuleGeometry(d.r * S, Math.max(0, d.length - 2 * d.r) * S, 12, 32); // r184: middle-section height
    case 'cylinder':  return new THREE.CylinderGeometry(d.rTop * S, d.rBottom * S, d.h * S, 48);
    case 'cone':      return new THREE.ConeGeometry(d.r * S, d.h * S, 48);
    case 'torus':     return new THREE.TorusGeometry(d.R * S, d.r * S, 24, 64, D2R(d.arcDeg ?? 360));
    case 'lathe':     return new THREE.LatheGeometry(d.profile.map(([r, y]) => new THREE.Vector2(r * S, y * S)), 48);
    case 'box':       return new THREE.BoxGeometry(d.w * S, d.h * S, d.d * S, 4, 4, 4);
    case 'flat': { const t = d.thickness * S;
      return new THREE.ExtrudeGeometry(shape2D(d), { depth: t * 0.4, bevelEnabled: true, bevelThickness: t * 0.3,
        bevelSize: Math.min(t * 0.3, 0.1 * Math.min(d.w, d.h) * S), bevelSegments: 4, curveSegments: 32 }).center(); }
  }
  throw new Error('unknown part type ' + p.type);
}
function shape2D(d) {                               // local XY plane, facing +Z
  const w = d.w * S, h = d.h * S, s = new THREE.Shape();
  if (d.shape === 'circle' || d.shape === 'oval') s.absellipse(0, 0, w / 2, h / 2, 0, Math.PI * 2);
  else if (d.shape === 'teardrop') { s.moveTo(0, h / 2); s.bezierCurveTo(w * .55, 0, w * .5, -h / 2, 0, -h / 2); s.bezierCurveTo(-w * .5, -h / 2, -w * .55, 0, 0, h / 2); }
  else if (d.shape === 'triangle') { s.moveTo(0, h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(-w / 2, -h / 2); s.closePath(); }
  else if (d.shape === 'polygon') { d.points.forEach(([x, y], i) => i ? s.lineTo(x * S, y * S) : s.moveTo(x * S, y * S)); s.closePath(); }
  else { s.moveTo(-w / 2, -h / 2); s.lineTo(w / 2, -h / 2); s.lineTo(w / 2, h / 2); s.lineTo(-w / 2, h / 2); s.closePath(); }
  return s;
}
function paint(g, p, pal) {                          // regions → vertex colors (part-local frame)
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
    c.set(pal[id] ?? '#cccccc'); col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b;  // set() converts sRGB → linear
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
// page glue (3D object skill): const stage = document.querySelector('three-d-stage'); await stage.ready;
// stage.setObject(buildModel(JSON.parse(document.getElementById('crochet-model').textContent)));
```

### 5.4 Filling rules (app side)

- `MIN_FEATURE_IN = 6 / (π · stsPerIn)`. This is the diameter of a 6-stitch magic-ring tube. Worsted at about 5 sts/in gives about 0.38 in; DK at about 6.5 gives 0.29 in; bulky at about 4 gives 0.48 in. The stitches-per-inch values are typical tight-amigurumi gauges [Inference] *[FC: the absolute values are (unverified). Their ratios match PlanetJune's scale data to within about 7%. In her data DK is about 0.8× and bulky on a 4.5 mm hook about 4/3× the size of worsted on 3.5 mm, which implies ≈6.25 and ≈3.75 sts/in if worsted is 5.]*. The CYC label gauges are 11–14 sc per 4 in for worsted with 5.5–6.5 mm hooks [V-official: [CYC](https://www.craftyarncouncil.com/standards/yarn-weight-system)]. Amigurumi uses smaller hooks: DK with 2.75 mm, worsted with 3.5 mm, bulky with 4.5 mm ([PlanetJune](https://www.planetjune.com/blog/amigurumi-help/resizing-amigurumi/)). Take the real gauge from the gauge module (R4) when available.
- `MAX_PARTS` defaults to 25 [Inference].
- `STYLE_SENTENCE` for chibi: "head about 40–50% of total height, eyes about halfway down the head". This follows the "a third or one half" head-to-whole-doll guidance ("ratios of size of head to size of doll") and the eyes "at least halfway down the head" ([Little World of Whimsy](https://littleworldofwhimsy.com/6-easy-tricks-to-make-amigurumi-cuter/)). *[FC: it was described as "head-to-body" guidance. The same source says it usually aims for eyes "two thirds of the way down", so "halfway to two-thirds down the head" is the faithful wording.]*
- Escape `{{`, `</script` and `<` in user free text before inserting it into the JSON seed.

---

## 6. Q&A design (R5)

### 6.1 Principles [Inference, grounded in sources]

- **Every amigurumi breaks down into spheres, cylinders and cones, plus flat pieces and embellishments** ([Garnknuten](https://garnknuten.com/en-us/blogs/how-to-crochet/3-basic-amigurumi-shapes-you-need-to-know), [LWoW shapes](https://littleworldofwhimsy.com/amigurumi-shapes/), [LWoW 7 steps](https://littleworldofwhimsy.com/how-to-design-amigurumi-in-7-steps/)). *[FC: attribution narrowed. Garnknuten names sphere, cylinder and cone as "three basic crocheted shapes". Little World of Whimsy names spheres, cylinders and hemispheres plus flat circles, ovals, squares and chain lines, and says "all amigurumi can be broken down into a collection of basic shapes, on top of which there are some embellishments". Neither LWoW page lists cones.]* The questions therefore ask for a **part list with a shape per part**, not free prose.
- **Shape rate matters**: 6 increases per round gives a round piece; 7–8 gives a flatter one; fewer than 6 gives a pointier one. Increasing every other round makes a cone of about 45° ([LWoW shapes](https://littleworldofwhimsy.com/amigurumi-shapes/), [Shiny Happy World](https://www.shinyhappyworld.com/2010/11/crochet-cone-shapes-amigurumi.html)). *[FC: the 6 / 7–8 / fewer-than-6 rule is LWoW's, quoted accurately. The 45° figure is Shiny Happy World's empirical "cone with about 45 degree-angle sides". Idealized single-crochet geometry gives something different. If 6 increases per round lies flat, then 3 per round grows the circumference half as fast, so the base radius is half the slant height. That is a 30° half-angle, a 60° apex. Calibrate with a swatch before encoding either number in R4.]* Ask *pointy vs rounded vs flat-topped* for tips such as ears and snouts, and map the answer to a cone, an ellipsoid or a lathe profile.
- **Cuteness and proportion**: head at 1/3–1/2 of total height; eyes at least halfway down the head, usually up to two-thirds down *[FC: it was given as "about halfway"]*; bigger eyes read cuter ([LWoW tricks](https://littleworldofwhimsy.com/6-easy-tricks-to-make-amigurumi-cuter/)).
- **Safety**: safety eyes are not recommended for babies and small children; use embroidered or felt eyes. Typical sizes are 4–6 mm for palm-sized toys and 8–10 mm for jumbo ([LWoW safety eyes](https://littleworldofwhimsy.com/how-to-use-safety-eyes-in-crochet-and-my-favorite-sizes/)).
- **Interaction design**: mirror Claude Design's own form guidance. A focused form, typically 6–10 questions for an opening form and at most 12 *[FC: it was given as "about 6–12"; the leak says "typically 6-10 … at most 12"]*, has defaults on every question, a "Decide for me" option, and never asks for something already known [Leak+]. We pre-fill answers from the photo analysis (palette k-means, silhouette aspect ratios, R2/R3 part segmentation) and from the R1/R2 settings (size, yarn, hook).

### 6.2 Question bank (ordered by priority; the engine skips known or irrelevant questions)

| id | Question | Kind | Default / options | Shown when | Writes |
|---|---|---|---|---|---|
| q_reject | What's wrong with the automatic 3D? | multi | wrong silhouette, missing parts, extra parts, proportions, colors, too lumpy/detailed, pose, other | came from a rejected R2/R3 result | `REJECTION_REASONS` |
| q_what | What is it? | text | prefilled from the image label if any | always | `name`, `OBJECT_NAME`, lexicon pre-fill |
| q_cat | Kind of thing | chips | quadruped · biped/doll · bird · sea · insect · creature · food/plant · object | always | `category` → part template |
| q_style | Look | chips + thumbnails | chibi (big head) · true-to-photo · minimal (few parts) | always | `style`, head ratio |
| q_size | Finished size | number + unit | from R1/R2 settings; "Which dimension is fixed?" height, length or width | always | `finishedSize` |
| q_pose | Pose | chips | standing · sitting · lying · hanging ornament | cat ∈ animals, people | `pose`, `flatBase` |
| q_audience | Who is it for? | chips | adult/decor · child 3+ · under 3 | always | `audience` (under 3 forces embroidery) |
| q_headbody | Is the head a separate ball or one piece with the body? | chips + icons | separate · one piece (bird, penguin, blob) | cat ≠ object/food | merges `head`/`body` into one lathe |
| q_bodyshape | Body silhouette | svg-chips | ball · egg · pear · bean · cylinder · cone | always | body type and lathe profile preset |
| q_parts | Parts list (editable table) | parts editor | template by category, plus parts detected in photos | always | `parts[]` (type, count, rel size, parent, where) |
| q_ratio | Head : body | slider + thumbnails | chibi 1:1 … realistic 1:3 | has head and body | dims |
| q_limbs | Limb length / stance | chips | nubs · short · medium · long dangly | has legs or arms | capsule length |
| q_palette | Confirm colors | color list | k-means palette (merge ΔE < 3; see R8 doc), max 8 | always | `palette` |
| q_patterns | Patterns per part | region editor | none · stripes · spots · patch · motif | palette has ≥ 2 colors or the image shows texture | `regions` |
| q_eyes | Eyes | chips + size | safety (mm suggested by head size) · embroidered · felt · none | has head | `features` |
| q_face | Nose, mouth, cheeks, whiskers | multi | from the category | has head | `features` |
| q_join | Construction preference | chips | fewest pieces/seamless · sewn pieces · no preference | always (optional) | `attach.method` defaults |
| q_views | Photo order and labels | per-photo chips | auto-labeled by R2 | photos present | `PHOTO_ORDER`, `source.views` |
| q_notes | Anything else Claude should know? | text | — | always (optional) | `FREE_TEXT` |

**Adaptive follow-ups.** Each is triggered when a part is present in `q_parts`. At most 2 follow-ups per part, and at most 14 questions in total.

| Part | Follow-ups → mapping |
|---|---|
| ears | shape: pointed → `cone` flattened (`flatten: 0.8`); round → `flat circle` or half `ellipsoid`; floppy → `flat teardrop`, rotated outward. Size relative to the head; position (top/side); inner-ear color → `band` region |
| tail | stub/ball → `sphere`; straight → `capsule`; curled → `torus` arc 180–270°; bushy → `lathe` with a bulge |
| legs | count; stubby feet only → `ellipsoid` feet; real legs → `capsule`/`cylinder` holding the body up (`flatBase` false) |
| arms | down, out or up → `rotationDeg` z ±10°, ±60° or ±150°; paw color → `band` near the tip |
| snout/muzzle/beak | protrusion depth; color; beak → `cone` (+Z axis via rotationDeg x 90) |
| wings, fins | folded against the body → `flat` hugging the side; spread → `flat` rotated out |
| hair | cap → `lathe` dome; bangs/strands → `flat` pieces or `features.line`; ponytail → `capsule` |
| horns/antlers | count, curve → `cone` (+torus arc for curved) |
| accessories | hat → `lathe`; scarf → `torus` + `flat`; bag → `box` |

**Engine sketch:**

```ts
interface Q { id: string; kind: string; priority: number; when?(c: Ctx): boolean; known?(c: Ctx): boolean;
              default?(c: Ctx): unknown; apply(ans: unknown, draft: SeedDraft, c: Ctx): void }
function nextQuestions(bank: Q[], c: Ctx, budget = 14) {
  return bank.filter(q => (q.when?.(c) ?? true) && !(q.known?.(c)))
             .sort((a, b) => a.priority - b.priority).slice(0, budget);
}
// Free text: a client-side lexicon pass (part nouns, shape adjectives such as round/pointy/floppy/long/curly,
// CSS and yarn color names) pre-ticks parts and colors. The raw text is still passed verbatim to Claude.
```

### 6.3 Seed construction (from answers to `SEED_JSON`)

1. Pick the category template. For example, quadruped-sitting is `body` (lathe "pear"), `head` (ellipsoid), `ear_l/r`, `foot_l/r`, `tail`, optional `arm_l/r` and `muzzle`.
2. Apply the user's part edits.
3. Size from proportions. With H = finished height and a chibi head ratio k ≈ 0.45:
   - head `ry = k·H/2 × 0.9`
   - body height = `(1−k)·H` + 15% overlap
   - lathe profile presets scale to that body height
4. Place parts by **stacking**: child center = parent center + dir(where) × (parent extent + child extent × (1 − overlap)), with `where` ∈ {top, front, back, left, right, bottom, top-left, …} and overlap 0.1. Then set `min y = 0`.
5. Attach palette ids from `q_palette`, regions from `q_patterns`, and features at default az/el (eyes az ±30°, el 0° to −20° on the head *[FC: it was given as "el +5° to +15°", which puts the eyes above the head's midline and contradicts the cited "at least halfway down the head". On a sphere, −20° is about two-thirds of the way down]*).
6. Set `revision: 0` and `source.stage: "seed"`.

Our app renders the seed with the same builder, so the user sees the blockout before sending.

---

## 7. Importer (R6)

### 7.1 Accepted inputs and detection (magic bytes first, extension second)

| Input | Detection | Strategy (stop at the first valid spec) |
|---|---|---|
| Pasted text / `.txt` / `.md` | text | 1) last ```` ```json ```` fence containing `"crochet-model"`; 2) brace-matched object containing `"schema":"crochet-model"`; normalize smart quotes, BOM and zero-width characters; `JSON.parse`, then JSON5 as fallback |
| `.json` | `{` | `schema == crochet-model` → spec. glTF JSON (`asset.version`) → glTF path. `canvas.json` (`v`, `boards`) → ask for the full zip |
| `.html` / `.htm` / `.dc.html` | `<!doctype`, `<html`, `<script` | §7.2 |
| `.zip` | `PK\x03\x04` | unzip (§7.4), then rank: `crochet-model.json` › HTML › `.glb/.gltf` › `.obj+.mtl` › `.ply/.stl` › `README.md`/`chats/*.md` fences › images |
| `.tar.gz` / `.tgz` (handoff URL bundle) | `1F 8B`, then `ustar` at offset 257 | gunzip, a minimal tar reader, then the same ranking. If there is no `project/` folder, show "Claude was still waiting for your answer — reply in Claude Design and re-export". Prefer the `open_file` hint |
| `.glb` | `glTF` + version 2 | read the **JSON chunk** directly (12-byte header; chunk type `0x4E4F534A`) [V-observed in GLTFLoader], then search `nodes[].extras.crochetModel`, then per-node `extras.crochet` → spec. Otherwise geometry path (§7.5) |
| `.gltf` (+ `.bin`, textures) | JSON with `asset` | same as above; resolve sibling files from the zip or a multi-file drop |
| `.obj` + `.mtl` | `v `/`f `/`o ` lines; `newmtl` | OBJLoader + MTL. If the MTL header is `# Exported by three-d-stage`, **treat Kd as linear** and convert to sRGB. Object names = part ids → geometry path |
| `.ply` | `ply\n` | PLYLoader → vertex colors → color regions (R8) → geometry path |
| `.stl` | binary size `84+50n`, or `solid … facet` | STLLoader (no names or colors) → geometry path; ask colors in the Q&A |
| `.pdf` / `.pptx` | `%PDF-` / zip with `ppt/` | text search for the JSON; otherwise rasterize/extract images → R3 |
| `.png` / `.jpg` / `.webp` | magic | R2/R3 pipeline; the stage background makes silhouettes easy |
| folder drop | `webkitGetAsEntry` | same as zip |

### 7.2 HTML extraction ladder

```ts
async function specFromHtml(raw: string, ctx): Promise<Result> {
  const texts: {name: string; text: string}[] = [{ name: 'page', text: raw }];
  if (raw.includes('__bundler/manifest')) texts.push(...await unbundle(raw));        // E1
  for (const t of texts) {                                                            // E2: DOM (inert)
    const doc = new DOMParser().parseFromString(t.text, 'text/html');               // scripts are non-executable (MDN)
    for (const el of doc.querySelectorAll('script#crochet-model, script[data-crochet-model], script[type="application/vnd.crochet-model+json"]'))
      { const s = tryParse(el.textContent); if (s) return ok(s, 'json-block'); }
    for (const el of doc.querySelectorAll('[data-crochet-model]'))                    // attribute form (entity-decoded)
      { const s = tryParse(el.getAttribute('data-crochet-model')); if (s) return ok(s, 'attr'); }
  }
  for (const t of texts) {                                                            // E3: markers anywhere (DC logic, JS)
    const m = /\/\*CROCHET-MODEL-BEGIN\*\/([\s\S]*?)\/\*CROCHET-MODEL-END\*\//.exec(t.text);
    const s = m && tryParse(m[1]); if (s) return ok(s, 'marker');
  }
  for (const t of texts) { const s = braceScan(t.text, /"schema"\s*:\s*"crochet-model"/); if (s) return ok(s, 'brace-scan'); }   // E4 (+JSON5)
  if (/<three-d-stage|THREE\.|from ['"]three['"]/.test(texts.map(t => t.text).join())) {
    const r = await sandboxExtract(raw, ctx);                                         // E5/E6 (§7.3)
    if (r) return r;
  }
  const h = staticThreeHeuristics(texts);                                            // E7: low confidence
  return h.parts.length ? ok(h.spec, 'heuristic', { confidence: 'low' }) : fail('no-model');   // E8: ask for GLB/PNG
}

async function unbundle(html: string) {   // format observed in real exports (§2.2)
  const grab = (t: string) => new RegExp(`<script type="__bundler/${t}">([\\s\\S]*?)</script>`).exec(html)?.[1];
  const manifest = JSON.parse(grab('manifest') ?? '{}');
  const template: string = JSON.parse(grab('template') ?? '""');   // undoes the <\/ or <\u002F escaping [FC: comment was "decodes </script>"]
  const out = [{ name: 'template.html', text: template }];
  for (const [uuid, e] of Object.entries<any>(manifest)) {
    if (!/json|javascript|html|text/.test(e.mime)) continue;                     // skip fonts/images
    let bytes = b64ToBytes(e.data); if (e.compressed) bytes = fflate.gunzipSync(bytes);   // no DecompressionStream needed
    out.push({ name: `${uuid}.${e.mime.split('/')[1]}`, text: new TextDecoder().decode(bytes) });
  }
  return out;
}
```

Fingerprint the format for diagnostics: `__bundler` → standalone; `<x-dc>`/`data-dc-script` → Design Component; `three-d-stage` → 3D-object skill; `text/babel` → pre-DC React/Babel prototype (April to about June 2026); `importmap` + three → module page. Claude Design's formats are undocumented and changed between April and late June 2026 (React/Babel → DC), so the ladder must stay tolerant [V-observed]. *[FC: it was given as "pre-August" and "between April and August 2026". DC exports were public by 2026-06-24; see §1.1.]*

### 7.3 Sandbox runner (pages without JSON)

- Run the page in `<iframe sandbox="allow-scripts">`. **Do not add** `allow-same-origin`: with both tokens a same-origin document can remove its own sandbox ([MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)). Without it the iframe gets an opaque origin.
- `srcdoc` and `blob:` documents **inherit the parent's CSP** ([CSP3](https://www.w3.org/TR/CSP3/) mentions local-scheme documents "that have inherited their policy"). So serve a dedicated `public/sandbox.html` with its own meta CSP. The parent posts the HTML to it, and it creates a nested `srcdoc` frame. Meta CSP can't carry `frame-ancestors`, `report-uri` or `sandbox`. The sandbox CSP:

  ```
  default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data: https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com;
  style-src 'unsafe-inline' https://fonts.googleapis.com; font-src data: blob: https://fonts.gstatic.com; img-src data: blob:;
  connect-src blob: data: https://unpkg.com https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; worker-src blob:
  ```

  `'unsafe-eval'` is needed for Babel-era pages (unverified). *[FC: @babel/standalone 7.29.0 contains no `eval(` or `new Function(` call. Its `transformScriptTags` injects the transformed code as inline scripts, which `'unsafe-inline'` already allows. Drop `'unsafe-eval'` unless a real fixture needs it.]*
- **Offline**: rewrite the `https://unpkg.com/three@0.184.0/...` import-map URLs to vendored copies with blob URLs. Our recomputed sha384 values match the leaked map, so the `integrity` entries stay valid if we vendor exactly 0.184.0. *[FC caveat, checked in the 0.184.0 files. `build/three.module.js` imports `./three.core.js`, and a relative specifier cannot resolve against a `blob:` base URL. Blob-URL vendoring therefore breaks unless that specifier is rewritten as well. Serving the vendored files from a real same-origin path (for example `/vendor/three@0.184.0/…`) avoids the problem. `integrity` is keyed by URL, so re-key it to the new URLs; the hash values themselves stay correct. The addons import the bare `three` specifier and are unaffected.]*
- **Bootstrap injected as the first `<head>` child:**

```js
(() => {
  const scenes = new Set(), blobs = new Map();
  window.__THREE_DEVTOOLS__ = new EventTarget();                       // three r128…r184 dispatch 'observe' (verified)
  __THREE_DEVTOOLS__.addEventListener('observe', e => { if (e.detail?.isScene) scenes.add(e.detail); });
  const mk = URL.createObjectURL;
  URL.createObjectURL = o => { const u = mk.call(URL, o); if (o instanceof Blob) blobs.set(u, o); return u; };
  const click = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {                  // intercept stage downloads
    const b = blobs.get(this.href); if (!b) return click.call(this);
    b.arrayBuffer().then(buf => parent.postMessage({ t: 'cpg:file', name: this.download, mime: b.type, buf }, '*', [buf]));
  };
  addEventListener('message', async ev => {
    if (ev.data?.t !== 'cpg:extract') return;
    const stage = document.querySelector('three-d-stage');
    const root = stage?._object;                                       // 3D-object skill keeps the model here
    if (root?.userData?.crochetModel) return parent.postMessage({ t: 'cpg:spec', spec: JSON.parse(JSON.stringify(root.userData.crochetModel)) }, '*');
    const btn = stage?.shadowRoot?.querySelectorAll('.toolbar button')?.[1];
    if (btn && !btn.disabled) { btn.click(); return; }                 // GLB arrives via cpg:file
    const meshes = []; for (const s of scenes) s.traverse(o => o.isMesh && meshes.push(ser(o)));
    parent.postMessage({ t: 'cpg:scene', meshes }, '*');
  });
  function ser(m) { m.updateWorldMatrix(true, false); const g = m.geometry, mat = [].concat(m.material)[0];
    const r = { name: m.name, userData: safe(m.userData), type: g.type, params: g.parameters ? safe(g.parameters) : null,
                matrixWorld: Array.from(m.matrixWorld.elements), mat: mat && { name: mat.name, hex: mat.color?.getHexString?.() } };  // getHex defaults to sRGB (r152+)
    if (!r.params && g.attributes.position.count <= 50000) { r.pos = Array.from(g.attributes.position.array); r.index = g.index ? Array.from(g.index.array) : null; }
    return r; }
  function safe(x) { try { return JSON.parse(JSON.stringify(x)); } catch { return null; } }
})();
```

- The parent checks `ev.source === frame.contentWindow`, polls `cpg:extract` every 500 ms for up to **15 s**, then destroys the iframe.
- Cap the work at 500 meshes, 500k vertices and 50 MB of messages.
- Don't depend on `requestAnimationFrame`. Design-tool iframes can suppress it, as one handoff README notes, and cross-origin offscreen frames are throttled. The model exists as soon as `setObject` runs.
- Mapping `params` back to the spec:
  - `SphereGeometry{radius}` → sphere
  - non-uniform scale on a sphere → ellipsoid *[FC: `BufferGeometry.scale()`, which our own builder uses for ellipsoids, and `.center()` change the vertices but leave `geometry.parameters` stale. Compare `computeBoundingBox()` with `params` before trusting them.]*
  - `CapsuleGeometry{radius,height}` → capsule (`length = height + 2r`)
  - `CylinderGeometry` / `ConeGeometry` → cylinder or cone
  - `TorusGeometry` → torus
  - `LatheGeometry{points}` → lathe
  - `ExtrudeGeometry` → flat (bbox)
  - Units: divide by 0.0254 if the bbox is meter-sized relative to `finishedSize`; otherwise normalize to the user's target height.

**E7, static heuristics** (offline, no sandbox): parse inline module and DC-logic scripts with `acorn`. Then:

- Constant-fold literals, `Math.PI` and arithmetic; never eval.
- Find `new THREE.(Sphere|Capsule|Cylinder|Cone|Torus|Lathe|Box)Geometry(args)` and the `new THREE.Mesh(g, m)` bindings.
- Find `.position.set`, `.rotation.set`, `.scale.set` and `.name = '…'`.
- Read material `color: 0xRRGGBB | '#hex'`.

Loops and helper functions defeat this approach, so mark the result **low confidence** and send it to the R7 editor for review [Inference].

### 7.4 Archives and limits

- **Library**: use `fflate`, which inflates in about 3 kB and supports `unzipSync(u8, { filter })` with `originalSize` for cheap pre-checks and `gunzipSync` for bundler assets ([fflate](https://github.com/101arrowz/fflate)). JSZip (`loadAsync`, `file.async`) also works but is about 98 kB minified, or 28 kB gzipped (v3.10.2, measured) *[FC: it was given as "about 45 kB", which is pako's size in the fflate README]*. fflate's own table gives ≈5 kB minified for ZIP decompression and ≈4 kB for GZIP.
- **Tar**: a ~60-line ustar reader (512-byte headers, size in octal at offset 124, name at 0, prefix at 345).
- **Limits**:
  - ≤ 100 MB input
  - ≤ 2,000 entries
  - ≤ 300 MB uncompressed in total
  - per-entry ratio ≤ 100:1
  - path depth ≤ 12
- **Path hygiene**: reject `..` and absolute paths, skip `__MACOSX/` and dotfiles, decode names as UTF-8.

### 7.5 Geometry-only path (GLB/OBJ/STL/PLY without the spec)

Shared with R2/R3:

1. **Segment by node or object**. A three-d-stage export gives one node per part, so this is free. Otherwise split by connected components.
2. **Per segment**: PCA axis → slice into 12–40 rings along the axis → if the radial variance per ring is below 12% of the mean radius, emit a **lathe profile**. Otherwise, if the smallest PCA extent is below 25% of the largest, emit **flat**. Otherwise emit an **ellipsoid** fit [Inference].
3. Colors come from material base color or vertex-color clustering (R8).
4. Proximity gives the attach graph.
5. Result: a `crochet-model` with `source.stage: "refined-from-mesh"` and a warning that semantics are guessed.

### 7.6 Failure modes and edge cases

| Situation | Handling |
|---|---|
| Claude omitted the JSON block | E3–E7. Then the app shows a one-click "fix-up prompt": *"Please add the crochet-model JSON block exactly as specified in rule 3, built from the current model, and print it."* |
| JSON and 3D disagree (Claude hand-edited geometry or added Tweaks) | Trust the JSON. If a GLB is also present, diff the per-mesh `extras` against the JSON and show it. The prompt forbids Tweaks because the leaked prompt says Claude adds them by default [Leak+]. EDITMODE blocks (`/*EDITMODE-BEGIN*/…`) are recorded and flagged |
| Several HTML files or versions (`X.html`, `X v2.html`) | Prefer the highest `revision`, then the newest zip entry time, then the handoff `open_file`; let the user pick |
| The JSON inside a DC `<helmet>` or HTML-escaped (`&quot;`) | Search the DOM everywhere; decode entities and retry |
| Template braces `{{ }}` in DC markup | The prompt forbids `{{` in strings; the parser never evaluates holes |
| Units in cm, m or mm; rotations in radians; Z-up | §4.5 repairs, plus a visible "auto-corrected" chip |
| Colors from MTL (linear) or vertex colors | Linear→sRGB. glTF base colors are linear by spec and three's loader converts, so `getHexString()` returns sRGB |
| Handoff URL expired or CORS-blocked | Tell the user to open it in a browser and drop the `.tar.gz` |
| Gzipped bundler assets on an old browser | `fflate.gunzipSync`, which doesn't depend on `DecompressionStream` |
| Copyrighted characters | Claude may generalize or decline. The Q&A hint says: describe shapes and colors instead of the brand name [Inference] |
| Malicious input | DOMParser is inert, but never insert parsed nodes into our DOM ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString)). Strict zod schema, prototype-key reviver, size caps, opaque-origin sandbox, `connect-src` allowlist |

---

## 8. Recommendations and build order

1. **Define `crochet-model` v1.0 in `src/model/` first** (zod schema, TS types, `buildModel`, validator and repair). It is the app-wide 3D representation for R2, R3, R5, R7 and R8.
2. **Phase 1, minimum viable round trip**: Q&A → seed → prompt or brief export; then paste and drop import for JSON, Markdown, `.html` (DOM ladder E1–E4, including `__bundler`), `.zip`, `.tar.gz` and `.glb` (JSON-chunk extras). This alone covers return channels A–E.
3. **Phase 2**: OBJ+MTL (with the linear-Kd fix), PLY, STL and the mesh-fitting path; then the sandbox runner (E5/E6) with vendored three@0.184.0.
4. **Phase 3**: the static heuristics (E7), PDF/PPTX scraping and the PNG fallback to R3.
5. **A manual verification sprint in claude.ai/design before coding the importer**, because everything Leak+ and Uncertain needs testing. Run the template on 3 objects and save every export type as **test fixtures** (`tests/fixtures/claude-design/…`). Check:
   - the 3D-object skill is still available;
   - the GLB and OBJ downloads work in the preview;
   - whether the standalone HTML inlines the three.js import map;
   - the zip layout;
   - whether clipboard copy works in the preview;
   - whether the in-chat Design template can load three.js.
6. **Keep the prompt and builder versioned** (`prompt-v1`, `builder-v1`) and record which ones produced each import. Add a "format drift" warning when an unknown fingerprint is imported.
7. **Never call any API**. The round trip is copy, paste and files only, which satisfies the "no paid AI API" constraint.

---

## 9. Verified vs uncertain ledger

| Claim | Status |
|---|---|
| Launch 2026-04-17, Opus 4.7 at launch, research preview on paid plans | V-official |
| Export menu (zip, PDF, PPTX, Google Slides, standalone HTML, 15 partners, Claude Code handoff) | V-official |
| Design is a template in chat, Claude Code and the Artifacts tab since 2026-09-16; standalone keeps working | V-official |
| Share links need a Claude account | V-official |
| Artifact viewer blocks page-initiated downloads without the downloads capability; artifacts can load scripts only from cdnjs, unpkg, jsDelivr `/npm/`, Tailwind and jQuery CDNs | V-official (code.claude.com) |
| Standalone HTML = `__bundler/manifest` + `template` (+ `ext_resources`, sometimes `page_order`), gzip+base64, every `</` in the template escaped as `<\/` or `<\u002F` *[FC: it was given as "`</script>` escaping"]* | V-observed (5 real files, re-decoded by the fact-check) |
| Design Components were the default format by late June 2026 (not August) | V-observed (commit dates of DC exports) *[FC: added]* |
| Design-canvas artifacts = `project/canvas.json` v3 + `.dc.html` artboards; network limited to fonts and uploads | V-observed (type definition on this account; re-read by the fact-check: release `1790801787-9bdf`, contract `0.2.47`) |
| "3D object" skill, three@0.184.0 import map, GLB + OBJ/MTL toolbar, meters, y-up | Leak+ (real files and SRI hashes match) |
| GLB keeps `userData` as `extras`; loader restores it; `__THREE_DEVTOOLS__` hook in r128 and r184; Capsule `height` = middle section; three.min.js absent from 0.161.0 | V-observed (three.js source; unpkg 0.160.0 → 200, 0.161.0 → 404) |
| Stage MTL Kd is linear while MTLLoader assumes sRGB | V-observed (code reading) |
| Zip = whole project folder | Inference + Leak+ |
| Handoff URL → tar.gz with README, chats and project; short-lived | Reported; my two test URLs were 404 with no CORS headers. *[FC: on 2026-09-30, 9 of 9 public URLs returned 404; heyadam says "short-lived / one-shot"; CORS on a live response is (unverified).]* |
| Standalone export of a 3D-object page still needs network for three.js | Inference, supported by one observed handoff README |
| Current Design model; in-chat Design template's ability to run CDN three.js; clipboard in preview; downloads inside the claude.ai/design preview | **Uncertain**, test manually |

## 10. Sources

**Anthropic, official**
- [anthropic.com/news/claude-design-anthropic-labs](https://www.anthropic.com/news/claude-design-anthropic-labs)
- [Get started with Claude Design](https://support.claude.com/en/articles/14604416-get-started-with-claude-design)
- [Claude Design admin guide](https://support.claude.com/en/articles/14604406-claude-design-admin-guide-for-team-and-enterprise-plans)
- [What are artifacts](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them)
- [Artifacts admin guide](https://support.claude.com/en/articles/16994751-artifacts-admin-guide-for-team-and-enterprise-plans)
- [Set up your design system](https://support.claude.com/en/articles/14604397-set-up-your-design-system-in-claude-design)
- [Release notes](https://support.claude.com/en/articles/12138966-release-notes)
- [Share artifacts](https://support.claude.com/en/articles/9547008-share-artifacts)
- [Upload files](https://support.claude.com/en/articles/8241126-upload-files-to-claude)
- [Claude Code: artifacts](https://code.claude.com/docs/en/artifacts)
- [Claude Code: whats-new 2026-w34](https://code.claude.com/docs/en/whats-new/2026-w34)
- [claude.com/product/design](https://claude.com/product/design)
- [claude.com blog: stays on brand](https://claude.com/blog/claude-design-stays-on-brand-for-daily-work)

**Leaked or unofficial (corroborated where noted)**
- [asgeirtj/system_prompts_leaks — claude-design](https://github.com/asgeirtj/system_prompts_leaks/tree/main/Anthropic/claude-design)
- [hqman gist (April prompt)](https://gist.github.com/hqman/f46d5479a5b663c282c94faa8be866de)

**Real exports and tooling**
- [openscreen](https://github.com/getopenscreen/openscreen/blob/main/design/openscreen-widget.html)
- [larri](https://github.com/sovrenix/larri/blob/main/gh-pages/index.html)
- [astroview CLAUDE.md](https://github.com/carryons6/astroview-html/blob/main/CLAUDE.md)
- [efcc design README](https://github.com/Noahlw/efcc/blob/main/design/README.md)
- [datapartnership unbundle.py](https://github.com/datapartnership/ai-index-workplan/blob/main/unbundle.py)
- [MovingJu unbundle.py](https://github.com/MovingJu/co-mmit/blob/main/scripts/unbundle.py)
- [levoberezhny 3D (three-d-stage)](https://github.com/Amethyst-Deceiver2001/Mariupol_Urbicide_2026/tree/main/docs/exhibits/levoberezhny-3d)
- [CogniPilot.dc.html](https://github.com/CogniPilot/website/blob/main/CogniPilot.dc.html)
- [foundry handoff](https://github.com/abhijitbansal/foundry/tree/main/docs/design/handoff)
- [paulodev40 handoff](https://github.com/paulodev40/SolucoesInteligentes/tree/main/pagina_home)
- [orchestkit](https://github.com/yonatangross/orchestkit/blob/main/src/agents/claude-design-orchestrator.md)
- [claudedesign-to-swiftui](https://github.com/heyadam/claudedesign-to-swiftui)
- [Deo-ahn sync-design](https://github.com/Deo-ahn/Deo-ahn.github.io/blob/main/bin/sync-design.md)
- [flowpoint.ai](https://flowpoint.ai/blog/claude-design-to-claude-code)
- [digitalstrategyai](https://digitalstrategyai.substack.com/p/claude-design-now-works-inside-claude)

**Web platform and three.js**
- three.js r184: [Scene](https://github.com/mrdoob/three.js/blob/r184/src/scenes/Scene.js), [GLTFExporter](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/exporters/GLTFExporter.js), [GLTFLoader](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/loaders/GLTFLoader.js), [MTLLoader](https://github.com/mrdoob/three.js/blob/r184/examples/jsm/loaders/MTLLoader.js), [CapsuleGeometry](https://github.com/mrdoob/three.js/blob/r184/src/geometries/CapsuleGeometry.js)
- MDN: [DOMParser](https://developer.mozilla.org/en-US/docs/Web/API/DOMParser/parseFromString), [iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe), [DecompressionStream](https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream)
- [CSP3](https://www.w3.org/TR/CSP3/)
- [fflate](https://github.com/101arrowz/fflate), [JSZip](https://stuk.github.io/jszip)

**Crochet**
- [Craft Yarn Council weights](https://www.craftyarncouncil.com/standards/yarn-weight-system)
- [PlanetJune resizing](https://www.planetjune.com/blog/amigurumi-help/resizing-amigurumi/)
- Little World of Whimsy: [7 steps](https://littleworldofwhimsy.com/how-to-design-amigurumi-in-7-steps/), [shapes](https://littleworldofwhimsy.com/amigurumi-shapes/), [cuter](https://littleworldofwhimsy.com/6-easy-tricks-to-make-amigurumi-cuter/), [safety eyes](https://littleworldofwhimsy.com/how-to-use-safety-eyes-in-crochet-and-my-favorite-sizes/)
- [Shiny Happy World cones](https://www.shinyhappyworld.com/2010/11/crochet-cone-shapes-amigurumi.html)
- [Garnknuten basic shapes](https://garnknuten.com/en-us/blogs/how-to-crochet/3-basic-amigurumi-shapes-you-need-to-know)

---

## Verification notes

An adversarial fact-check ran on 2026-09-30. Every edit in the body is marked *[FC: …]* and keeps the old value. Where possible I used sources other than the ones the report cites: raw page text, downloaded files, hashes and source code, rather than summaries.

### Method

- **Official pages**, fetched raw and read in full: the launch post, Get started with Claude Design, the release notes, Share artifacts, the Artifacts admin guide, the Claude Design admin guide, What are artifacts, Upload files, and code.claude.com's artifacts page and its whats-new for week 34. I also read claude.com/product/design.
- **Files downloaded, hashed or decoded**:
  - the leaked `3d-object/SKILL.md`;
  - both copies of `three-d-stage.js`;
  - all five standalone exports cited in §2.2;
  - `CogniPilot.dc.html` and `levoberezhny-quarter.html`;
  - three@0.184.0 (`three.module.js`, `three.core.js`, OrbitControls, OBJExporter, GLTFExporter, GLTFLoader, MTLLoader, `Scene.js`, `WebGLRenderer.js`, `CapsuleGeometry.js`) from unpkg;
  - three@0.128.0 `Scene.js` and `WebGLRenderer.js`;
  - @babel/standalone 7.29.0 and jszip 3.10.2.
- **Read-only call**: one read of this account's "Design" Artifact type.
- **Handoff URLs**: 9 public `api.anthropic.com/v1/design/h/…` URLs (redthread plus 8 found with a GitHub code search), fetched with an `Origin` header.
- **Crochet sources**: Little World of Whimsy (shapes, 7 steps, cuter, safety eyes), Shiny Happy World, Garnknuten, the Craft Yarn Council table, and two PlanetJune articles (resizing and scaling).
- **Formulas**: re-worked by hand (below).

### Load-bearing claims 1–14

| # | Verdict | What I checked |
|---|---|---|
| 1 | **Confirmed**; quote wording fixed | Launch post dated "Apr 17, 2026": "powered by our most capable vision model, Claude Opus 4.7 … research preview for Claude Pro, Max, Team, and Enterprise". The release notes' 2026-04-17 entry agrees. Get-started names no model. |
| 2 | **Confirmed** | Get-started export list, verbatim. I counted 15 "Send to" partners. |
| 3 | **Confirmed**, with nuance | Release note of 2026-09-16; get-started ("standalone … keeps working and has its own separate setting"); Artifacts admin guide ("Standalone Claude Design is a separate product … its own setting"). The CLI `/design` preview shipped earlier, on 2026-08-17. Official pages conflict on which plans get templates. |
| 4 | **Confirmed**, with nuance | Share artifacts: "Everyone needs a Claude account. People without one can't open a shared artifact, even with the link. The only exception is a legacy artifact published from a chat." The Claude Code doc also describes public links that need no sign-in. |
| 5 | **Confirmed** | code.claude.com artifacts: "blocks any download the page starts itself, including links to `data:` or `blob:` URLs". Scripts load only from "cdnjs, unpkg, the Tailwind and jQuery CDNs, and selected paths on jsDelivr such as `/npm/`". Fonts load only from Google Fonts. |
| 6 | **Confirmed**; one detail corrected | Decoded all five exports. Manifest entries have exactly `{mime, compressed, data}`. Fonts are uncompressed `font/woff2`; JS is gzipped. The dc-runtime begins `// GENERATED from dc-runtime/src/*.ts`. larri's `ext_resources` maps unpkg React 18.3.1. The loader uses DecompressionStream, blob URLs and uuid substitution, strips `integrity`/`crossorigin`, sets `window.__resources`, uses DOMParser + `replaceWith`, and handles `text/babel` + `transformScriptTags`. Corrected: the escaping is `<\/` or `<\u002F`, not "`</script>`". Added: the optional `__bundler/page_order` tag. |
| 7 | **Confirmed** | SKILL.md text matches. Both stage files are 16,612 bytes with sha256 `072cca1bb58d363504e415af8b20f694476b206498c07169de31829880649ef5` and are identical (`cmp`). The public copy (2026-07-30) predates the leak commit (2026-08-19). All 5 SRI sha384 values recomputed from unpkg match. Toolbar order is OBJ then GLB. Default background is `#f0eee6`. The stage posts `omelette:notify-3d-export`. |
| 8 | **Confirmed**; target list refined | r184 GLTFExporter calls `serializeUserData` for materials, primitives (geometry), animation clips, nodes, pivot containers and scenes. r184 GLTFLoader `assignExtrasToUserData` uses `Object.assign(object.userData, gltfDef.extras)`. |
| 9 | **Confirmed** | The stage writes `'# Exported by three-d-stage'`, then `Kd c.r c.g c.b` from `m.color`. r184 MTLLoader: `ColorManagement.colorSpaceToWorking(new Color().fromArray(value), SRGBColorSpace)`. |
| 10 | **Confirmed** | `__THREE_DEVTOOLS__.dispatchEvent(new CustomEvent('observe', { detail: this }))` appears in r184 `Scene.js` (L115–117) and `WebGLRenderer.js` (L3565–3567), and in r128 `Scene.js` (L19–21) and `WebGLRenderer.js` (L2105–2107). |
| 11 | **Confirmed as Reported**; re-tested | orchestkit's wire format: `application/gzip`, a tar.gz of 2–20 KB containing `README.md` ("CODING AGENTS: READ THIS FIRST"), `chats/chat<N>.md`, and `project/` once designs exist. heyadam: "short-lived / one-shot". All 9 public URLs returned 404 with no `Access-Control-Allow-Origin`. |
| 12 | **Confirmed** | Type read: release `1790801787-9bdf`, contract `"0.2.47"`. Confirmed: `project/canvas.json` with `"v":3`, `boards`, `order`, `pages`, `notes` and `designSystems` (plus `title`, `launch`, `createdOnFiles`); uploads at `/_blob/<id>`; "no network except a Google Fonts `css2` `<link>` … and step 3's urls"; "no `<iframe>`, `<object>` or `<embed>`". Capabilities include `downloads`. |
| 13 | **Partly confirmed**; three fixes | LWoW: "increasing by six … round. Increasing by seven or eight … flatter … less than six … pointier" ✓. Shiny Happy World: "cone with about 45 degree-angle sides" ✓ as a quote (but see the geometry below). LWoW head:doll "a third or one half" ✓. Eyes "at least halfway down", usually "two thirds" (wording fixed). Safety eyes "not recommended … babies or small children … choking hazard" ✓. Eye sizes "4.0 mm to 6.0 mm" for palm-sized and "8.0mm or 10.0mm" for jumbo ✓. Corrected: the sphere/cylinder/cone triad is Garnknuten's alone; LWoW lists hemispheres, not cones. |
| 14 | **Confirmed** | Craft Yarn Council, single crochet per 4 in: super fine 21–32, fine 16–20, light 12–17, medium 11–14 on 5.5–6.5 mm hooks, bulky 8–11, super bulky 7–9, jumbo 6 and fewer. PlanetJune: DK "C US/2.75mm", worsted "E US/3.5mm", bulky "G7 US/4.5mm". |

### Other numbers, formulas and facts checked

**Gauge and proportion math**
- `MIN_FEATURE_IN = 6/(π·sts/in)`:
  - 5 sts/in → 0.382 in
  - 6.5 sts/in → 0.294 in
  - 4 sts/in → 0.477 in

  The report's 0.38 / 0.29 / 0.48 are correct.
- Eye height on the worked-example head (ellipsoid 1.35 × 1.2 × 1.25 in, az 32°), measured as the fraction of the way down from the top:
  - el +10° → 41% down
  - el −10° → 59% down
  - on a sphere, two-thirds down is el ≈ −19.5°
- Cone from increasing every other round, assuming the 6-per-round circle lies flat:
  - stitch width ≈ (π/3) × round height
  - half the increase rate gives base radius = ½ × slant height
  - so the half-angle is 30° (60° apex)
- Unit-repair ratios 2.54, 0.0254 and 25.4 are correct. The radians bound of 6.3 is correct (2π ≈ 6.283).

**Binary signatures**
- GLB: magic `glTF`, 12-byte header, JSON chunk type `0x4E4F534A` (these are GLTFLoader's own constants).
- tar: ustar magic at offset 257; size in octal at 124; name at 0; prefix at 345.
- gzip `1F 8B`, zip `PK\x03\x04`, binary STL `84 + 50n`.

**three.js r184**
- `CapsuleGeometry(radius, height = "Height of the middle section", capSegments, radialSegments, heightSegments)`.
- `three.min.js` exists for 0.160.0 (HTTP 200) and not for 0.161.0 (404).
- `OBJExporter` writes vertex colors only for `Points` (added as a caveat).
- `three.module.js` imports `./three.core.js` (added as a caveat).

**Libraries and web platform**
- fflate: "3kB for inflate only" and `unzipSync(…, { filter })` with `originalSize` ✓.
- JSZip 3.10.2: 97,781 bytes minified, 28,443 bytes gzipped (corrected).
- DecompressionStream: MDN says "Baseline Widely available … since May 2023" ✓.
- MDN iframe warning about `allow-scripts` + `allow-same-origin` ✓.
- CSP3: meta CSP excludes `report-uri`, `frame-ancestors` and `sandbox`, and has a note on local-scheme documents "that have inherited their policy" ✓.
- MDN DOMParser: scripts are "marked as non-executable" ✓.
- @babel/standalone 7.29.0 has no `eval(` or `new Function(` call, so I marked `'unsafe-eval'` as (unverified).

**Official product facts**
- Upload limits: 500 MB per file, 20 files per chat, 8000×8000 px, and TXT/JSON are accepted ✓.
- Claude Design admin guide quotes ✓: "sandboxed iframe on a separate content domain that Anthropic operates" and "export to HTML bundles, PPTX, and PDF, hand-off to Claude Code, and sending designs to the partner tools".
- Artifacts admin guide ✓:
  - "doesn't currently support data residency requirements";
  - the new artifacts experience is unavailable for CMEK, ZDR and HIPAA-ready organizations;
  - artifacts are unavailable on third-party cloud platforms.
- Claude Code: `/design` research preview in week 34 (Aug 17–21, 2026), "Requires v2.1.234 or later". Template commands require v2.1.265+. "You can export each artboard as PNG or PDF" ✓.

**Leak quotes**
- `present_fs_item_for_download`: "If the path is a folder, will be turned into a zip file", and "Omit or use "" to download the entire project" ✓.
- `show_pdf_export_dialog`: "the user saves the page as a PDF" ✓.
- Question form: "typically 6-10 questions … at most 12", with a built-in decide-for-me button; "the app appends" a design-system question ✓.
- Design Components: "The only exception … entirely `<canvas>`/WebGL" ✓.
- Tweaks: "Add 2-3 of those by default" ✓.
- `save-as-standalone-html` skill: `super_inline_html` and `ext-resource-dependency` → `window.__resources[id]`, and it "CANNOT discover … a dynamically imported script" ✓.
- The April gist (created 2026-04-18) pins react@18.3.1 and @babel/standalone@7.29.0 with SRI, and uses EDITMODE markers ✓.

**Public sample files**
- `CogniPilot.dc.html` loads `three@0.128.0/build/three.min.js` from unpkg inside `<helmet>` ✓.
- The foundry README has the "(3D loads from CDN, needs network)" quote and the note that "design-tool iframes suppress rAF" ✓.
- The levoberezhny page uses an `ext-resource-dependency` meta ✓.
- The paulodev40 and sthree-boutique handoff layouts are as described ✓.
- The opendesigner.io zip claim exists (still Reported and conflicting) ✓.
- Both community unbundlers parse manifest + template and handle base64 + gzip ✓.

### What changed

1. **Launch quote.** The §1 table quote now uses the post's exact wording. I added the official release notes for Opus 5.5 and noted Opus 4.8 and Opus 5 in between.
2. **Surfaces and plans.** Mobile is not "view only". Official pages conflict on which plans get the templates; noted. Added `--scope user` to the reported MCP command.
3. **Design Components timeline.** DC has been the default since late June 2026 at the latest, not August (§1.1, §7.2, §9). The larri export was mischaracterized as evidence of April-era React/Babel.
4. **Bundle format.**
   - The template escapes every `</` as `<\/` or `<\u002F`; fixed in the text, the skeleton, the `unbundle()` comment and the ledger.
   - Added the optional `__bundler/page_order` tag.
   - `<title>Bundled Page</title>` is not universal.
5. **GLB and OBJ export.**
   - GLTFExporter's userData targets refined.
   - New OBJ caveats: vertex-painted parts lose color, and the stage renames duplicate material names.
6. **Prompt size.** Was about 7–10 KB; measured at roughly 11–18 KB.
7. **Eye placement.** The default eye elevation changed from +5…+15° to 0…−20°. The worked example's eye changed from +10° to −10°. Added a note on the example's head and tail overlap and its width.
8. **Crochet sources.**
   - The shape-triad attribution is narrowed to Garnknuten.
   - The 45° cone is flagged against the geometry.
   - "Head-to-body" is now "head-to-doll"; eyes are "halfway to two-thirds down".
   - Form size is "typically 6–10, at most 12".
9. **Sandbox runner.**
   - `'unsafe-eval'` marked (unverified).
   - Offline vendoring with blob URLs breaks the relative `./three.core.js` import; re-key `integrity`.
   - Stale `geometry.parameters` caveat added.
10. **Library size.** JSZip was "about 45 kB"; it is about 98 kB minified (28 kB gzipped).
11. **Handoff prompt.**
    - Canonical wording plus the usual `Implement:` line.
    - "One-shot" wording added.
    - 9/9 URLs returned 404; CORS on a live 200 response is (unverified).
    - README "opens with" wording fixed.
12. **Additions.**
    - The launch post's own mention of 3D ("shaders, 3D and built-in AI").
    - Independent dating of the public `three-d-stage.js` copy.
    - DecompressionStream is now "Widely available".
    - The in-chat template's own no-imports and markup-only rules.

### Remaining doubts

- **Live product state.** Which model Claude Design uses today is still **[Uncertain]**. Whether the "3D object" skill, its toolbar and its import map still exist at claude.ai/design rests on an August 2026 leak; nothing official describes them. The §8 manual test sprint is still required before coding the importer.
- **Official pages conflict:**
  - Template plan availability: "every plan, including Free" (release note) vs "paid plans only" (What are artifacts).
  - Public share links without sign-in: the Share artifacts article vs the Claude Code doc.
- **Handoff tar.gz.**
  - Its contents are **Reported** only: no live URL was available to download.
  - CORS on a successful response and single-use behavior are (unverified).
- **3D runtime questions.**
  - Whether the standalone-HTML export inlines the three.js import map is still Uncertain. The leaked bundler "CANNOT discover … a dynamically imported script" and the stage loads three via `import('three')`, so "probably not" stands.
  - Whether the in-chat Design template can run three.js is Uncertain, and its rules (no imports, no script-built UI) work against it.
- **Crochet numbers.**
  - Absolute amigurumi gauges (5 / 6.5 / 4 sts per in) are (unverified); only their ratios are corroborated.
  - The cone angle needs a swatch: 45° (source) vs about 60° apex (geometry).
  - The Craft Yarn Council page has a banner, "Updated Yarn Weight System now includes Size 8", but its table still ends at 7 (Jumbo). `yarn.weightCYC` may need an 8; the details are unverified because the web-search budget ran out during this run.
- **Internal inconsistency, not fixed.** §4.5's MTL rule "(all channels ≤ 0.5 from an MTL marked three-d-stage)" disagrees with §2.5 and §7.1, which treat every `Kd` in a three-d-stage MTL as linear. The header test alone should decide.
- **Third-party claims.** The opendesigner.io zip layout and the digitalstrategyai MCP endpoint remain **Reported**.
