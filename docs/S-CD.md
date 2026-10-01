# S-CD: the Claude Design send-side spike

A checklist for four trial runs at claude.ai/design. It can be followed by the project's owner by hand, or by the
integration agent driving the owner's logged-in browser once the owner has approved that. Source: `DESIGN.md`
§3.1 (what must be verified), §3.4 (the prompt), §6.5 (when).

## Why

The app sends work to Claude Design as one pasted text prompt ("prompt-v1": instructions, a seed model as JSON,
and a reference builder, 11–18 KB) and reads the result back from an exported file. The return side is verified:
real exports of a teddy bear are in `fixtures/claude-design/teddy-bear/`. **The send side is not.** The one real
run so far used a 1 KB prompt that only named the fields; prompt-v1 has never been run. This spike runs it,
before the Q&A wizard and the prompt builder are built on top of it.

- **When:** sprint 1. Track T7's third sprint (Q&A engine, templates, seed) starts only after the results are
  committed.
- **Cost:** the runs count toward the owner's Claude usage. They need the owner's OK and their logged-in
  claude.ai session. Nothing here is automated in CI.
- **No photos are used.** Both objects are sent as descriptions with a seed model.

## The four runs

| Run folder | Seed model | Prompt variant |
|---|---|---|
| `bunny-full` | the bunny of `DESIGN.md` §3.6 | full: with the "Reference builder" section |
| `bunny-compact` | the same | compact: the same text without the "Reference builder" section |
| `teddy-full` | `fixtures/models/teddy.canonical.json` | full |
| `teddy-compact` | the same | compact |

## Before the runs

- [ ] Fill the prompt-v1 template of `DESIGN.md` §3.4 by hand for both models, following its "Filling rules":
      no photos (the `NO_PHOTOS` line stays, the `PHOTOS` line goes), no "My own words" line, no rejection line.
- [ ] `SEED_JSON` is the model without the app-only fields `crochet` and `paint`, pretty-printed, with
      `"revision": 0`, `"source": { "stage": "seed" }` and the tag
      `"x-cpg": { "project": "s-cd-<run>", "seedRev": 1 }`. Every part except the root has `attach`.
- [ ] `BUILDER_JS` is the builder of §3.4.1 as plain JavaScript (`unitScale = 0.0254`). The compact variant
      leaves out the whole "# Reference builder" section.
- [ ] Check each text: no `{{` or `[[` left, nothing about attached files, size noted in bytes.
- [ ] Save the four texts as `fixtures/claude-design/s-cd/<run>/prompt.txt` — the exact bytes that get pasted.

## Each run

1. [ ] Open claude.ai/design and start a new **3D object** project.
2. [ ] Paste `prompt.txt` into the composer. Attach nothing. **Before sending, record how the composer took
       the paste:** as inline text, or converted into a text attachment (and whether the text is then still
       complete).
3. [ ] Send. Do not answer follow-up questions with new information; if Claude asks one, record it and reply
       "decide yourself and record it under assumptions".
4. [ ] When the page is generated, save every export **before** asking for any change (next section).
5. [ ] Send one follow-up: `Make the ears bigger.`
6. [ ] Save every export again, into `after-change/`.

## Exports to save (twice per run: before and after the follow-up)

| File | How |
|---|---|
| `chat-reply.json` | the JSON code block in Claude's reply (prompt rule 8), copied exactly |
| `project-archive.zip` | Share → Export → Project HTML → **Project archive** |
| `standalone.html` | Share → Export → Project HTML → **Standalone HTML** |
| `model.glb` | open the exported page locally in headless Chromium and click the page's **Download GLB** |
| `model.obj.gz`, `model.mtl` | the same page, **Download OBJ + MTL**; gzip the OBJ |
| `render.png` | a screenshot of the page rendering locally |

The Download buttons inside the claude.ai preview did not respond to automated clicks in the first run, and the
preview's address cannot be fetched; the buttons work when the exported page is opened locally.

## What to record (`fixtures/claude-design/s-cd/<run>/notes.md`)

Answer each point with what was seen, not with yes or no alone.

**Sending**
- [ ] Size of the prompt in bytes; inline text or text attachment; anything cut off.
- [ ] Did Claude start building at once, or ask questions first? Which ones?

**The page**
- [ ] Is there a `<script type="application/json" id="crochet-model">` block in `<head>`?
- [ ] Is the model built at run time from that JSON, or is geometry hard-coded?
- [ ] Did Claude keep our builder (`buildModel`, `geometryFor`, `shape2D`, `paint`) or write its own? In the
      compact runs there is no builder to keep: what did it write, and does a lathe keep its origin at the base
      of its profile?
- [ ] Units: are the JSON values in inches, and is the scene scaled by `unitScale = 0.0254` (meters)?
- [ ] Buttons present: Download GLB, Download OBJ + MTL, Front / Left / Back / Top, Exploded view, Copy
      crochet spec.

**The spec**
- [ ] Schema: `"schema": "crochet-model"`, `"version": "1.0"`, our field names (`dims`, `palette` as a list,
      `attach`) or the improvised dialect of the first run (`dimensions`, `palette` as an object, `parent`)?
- [ ] Part ids: every seed id kept? Any added, renamed or dropped?
- [ ] `attach`: present on every part except the root? `attach.to` pointing at existing ids?
- [ ] `position`: absolute, with lathes at the base of their profile?
- [ ] `x-cpg`: kept exactly, at the top level?
- [ ] `revision` and `source.stage` in the first result.
- [ ] Are the chat JSON, the page block and the GLB's `extras` the same spec?

**The follow-up change**
- [ ] `revision`: did it go up by exactly 1? In the page block, in the chat JSON, in both?
- [ ] Did the page block change, or only the rendering?
- [ ] Is there a stale copy of the spec anywhere in the project archive (a separate `.json` file, a README,
      a chat file)? Which revision does each copy carry?

**The exports**
- [ ] Project archive: file list; where the spec sits.
- [ ] Standalone HTML: is the spec inside the bundler template string, as in the teddy fixture?
- [ ] GLB: units (meters or inches), node names = part ids, `extras.crochetModel` on the root,
      `extras.crochet` per node.
- [ ] OBJ + MTL: units, one `o <id>` per part, `Kd` colors linear or sRGB.

## After the runs

- [ ] Scan every export for embedded images (`data:image/` in HTML, image entries in zips and in bundler
      manifests). There should be none besides the archive's `.thumbnail`; anything that looks like a photo
      needs the owner's OK before it is committed (`DESIGN.md` §6.1 rule 9).
- [ ] Write `fixtures/claude-design/s-cd/README.md`: one table row per run with the answers that matter
      (paste handling, builder kept, units, ids, attach, x-cpg, block present, revision after the change), and
      a short "what this changes" list.
- [ ] Commit as `S-CD: send-side fixtures and findings` on `master`, before T7.3 starts.
- [ ] If a finding breaks prompt-v1, the builder or the schema: fix `docs/DESIGN.md` first (it is owned by the
      integration agent), as prompt-v2 or a schema MINOR version, with a revision-log entry, in a `Design: …`
      commit. T7 builds from the corrected document.

## Later: the release gate

The same procedure, as a regression check before the `v0.1.0` tag (`DESIGN.md` §6.5 gate 1), on three objects —
a described toy with no photos, a multi-photo toy, a striped or spotted object — plus one run whose page lacks
the JSON, recovered with the fix-up message of §3.4.2. Those exports are saved the same way and must import and
give a pattern with no errors.
