# Rules for every track agent (Sprints 1–4)

Project: "Crochet Pattern Generator", repo `/Users/garzamacbookair/projects/crochet-pattern-generator` (public on
GitHub, default branch `master`). Step 0 is complete on `master`: shared types, kernels (color, hash, PNG, geometry,
gauge, 3D model, pattern encoder/validator), state stores, worker RPC, and the app shell with its design system.
Eight feature tracks (T1–T8) now run in parallel, each in its own git worktree, one sprint at a time.

## Where and how you work
- Worktree `/Users/garzamacbookair/projects/crochet-pattern-generator/.claude/worktrees/tN-<name>` on branch
  `track/tN-<name>` (your prompt names it). ALL reads, writes and commands happen inside it. Never edit anything
  outside it, never switch branches, never push, never merge.
- `node_modules` and `public/ort` are already there (APFS clones). Do NOT run `npm ci`/`npm install`; do not change
  `package.json` or the lockfile; no new dependencies (if one is truly needed, stop and explain in your report).
- Every node/npm command starts with `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && cd <your worktree> && …`
  (no shell state between calls; default Node 20 is refused). npm 10 prints EBADDEVENGINES / check-node warnings
  about npm 11: harmless.
- Use the npm scripts (`npm test`, `npm run typecheck`, `npm run lint`, `npm run e2e`, `npm run build`).
  Iterate with `npm test -- src/core/<folder>`.
- Seven other agents load this 12-core machine. Any test that asserts a duration MUST use the timing mechanism of
  DESIGN.md §6.1 rule 5 (vitest tag `perf` + `budget(N)` from `src/test/timing.ts`); strict budgets are checked by
  `npm run perf`. Re-run before concluding a failure is real.
- Store meshes, SDF volumes and photo label images only through the shared codecs (`core/kernel/assetCodecs.ts`, §5.5.6).
- Dev/e2e servers: the config derives ports from the worktree name (dev 5190+N, e2e 5290+N); always run servers with
  `CPG_TEST=1` and `CPG_PROJECTS_DIR=$(mktemp -d)`. NEVER bind or open port 5180 and never touch
  `~/Documents/Crochet Pattern Generator` (the owner's real data).

## What to read
- `docs/DESIGN.md` (v1.3): §0 (conventions, decisions), §6.1 (process rules — follow them), §5.1 (folder ownership —
  edit only paths your track owns), **§6.3 your track** (scope, owned paths, interfaces, acceptance, tests, sprint
  split), and every section your track's scope references. Find sections with `grep -n`.
- Research in `docs/research/` for depth (bracketed refs like `[03 §6]`).
- Step 0 notes in `docs/tracks/`: `s0.md` (decisions table at the end), `s0b-geom.md`, `s0b-gauge.md`,
  `s0b-model.md`, `s0b-pattern.md`, `s0b-state.md`, `s0c-shell.md`. These document the APIs you build on: use them,
  do not re-implement them. `s0c-shell.md` documents the design system — all UI must use `src/ui/common` components,
  tokens and layout slots so the app looks consistent, modern and polished.
- Frozen: `src/types/**` (identical to the spec, checked by `scripts/check-spec-types.mjs`) and every S0-owned file.
  Cross-track functions you need from another track are typed stubs (§5.2.1); test against them with
  `it.runIf(isImplemented(fn))`. If a frozen type, S0 file or the spec must change, write it under "Requests for
  integration" in your notes; never change it yourself.

## This sprint
First merge is already done (your worktree is at current master). Then do your track's tasks from the latest
integration record (`docs/tracks/integration-s2.md` → "Tasks handed to tracks for Sprint 3"), then the sprint.
Do ONLY your track's sprint named in your prompt (e.g. "T3.1"), as split in §6.3. Do it completely and well rather
than starting later sprints. Write tests for everything you build (the acceptance items of §6.3 that fall in this
sprint, plus your own edge cases and invariants). Goldens come from the spec; never bend code or tests to pass —
work it out, decide, report.

## Quality bar
- Correct before pretty, but UI must be genuinely modern, clear and friendly for crocheters (the owner asked for
  "robust and highly functional, user friendly, modern looking"). Any UI you build: take Playwright screenshots
  (light and dark, 1280×800), look at them (Read the PNGs), iterate.
- Before finishing, spawn an independent reviewer subagent briefed to check your work against the spec sections and
  your sprint's acceptance items and to try to break it with adversarial inputs (and, for UI, to judge it as a
  demanding product designer, including keyboard and contrast). Fix what it finds.

## Finish
- `npm run typecheck`, `npm run lint`, `npm test` (twice), `npm run build` all green; `npm run e2e` green if you
  touched UI or workers.
- Notes in `docs/tracks/tN.md` (create or extend): sprint log; public API you provide (every export, signature, one
  line); deviations with reasons; ambiguities resolved; "Requests for integration".
- Commit message `TN.k: <summary>`, ending with the trailer line
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Clean tree.
- Final message (to the orchestrator, not the user): commits; check results with numbers; acceptance items with
  pass/fail and evidence; screenshots paths; deviations; requests; anything not done or not verified — be exact.
