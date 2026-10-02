# Resume here

**Paused:** 2026-10-01, in the middle of Sprint 3, at the owner's request (out of usage).
**`master` is green:** every merged sprint passes typecheck, lint, 3,418 unit tests, build and 31 browser tests.
Status overview: [`ROADMAP.md`](ROADMAP.md). Spec: [`DESIGN.md`](DESIGN.md) v1.5.

## What is done (on `master`)

Research, spec, Step 0 (toolchain, shared types, kernels, app shell and design system), Sprint 1, Sprint 2, and the
checkpoint after Sprint 2 (`docs/tracks/integration-s2.md`). Run the app: `nvm use 22 && npm run dev` (port 5180).

## What was in progress (Sprint 3, NOT merged)

Each track has a branch on GitHub, `track/<name>`, with its committed sprint work plus one final commit named
**"WIP (Sprint 3, stopped mid-sprint)"** holding the unfinished files exactly as the agent left them. WIP commits
are untested: never merge them as they are.

| Track | Sprint 3 goal | Where it stopped |
|---|---|---|
| T1 `track/t1-image2d` | T1.3 cleanup, metrics, overrides | writing the acceptance tests (only WIP commit) |
| T2 `track/t2-pattern` | T2.3 Source / Settings / Chart editor UI, `renderPatternText` | building the size-change dialog and chart thumbnail (only WIP commit) |
| T3 `track/t3-recon` | T3.3 colors, parts, neck split, fit, naming | `fitPart` committed; part decomposition in progress |
| T4 `track/t4-ami` | T4.3 plan, frames, assembly, `generateAmigurumi` | main sprint committed; was running the teddy end to end; review not done |
| T5 `track/t5-mesh` | T5.3 DTW, Path B, `mesh.worker` | Path B committed; writing the browser e2e |
| T6 `track/t6-editor` | T6.3 paint, rings, live loop, proportions | integration tasks committed; Scale dialog in progress |
| T7 `track/t7-claude-design` | Import screens (T7.4 part a) | sprint committed (`T7.4a`), was running the final tests; review status unknown |
| T8 `track/t8-persist` | T8.3 PDF for 2D | integration tasks committed; PDF tests in progress |

## How to resume

1. Make sure every track worktree exists (`git worktree list`). If not, recreate them:
   `git worktree add .claude/worktrees/<track> track/<track>` and give each `node_modules` with
   `cp -c -R node_modules .claude/worktrees/<track>/node_modules` (and `public/ort` the same way; an APFS clone uses
   no extra disk). Never `npm ci` in eight worktrees at once.
2. For each track, start one agent with: "Resume Sprint 3 for track TN. Read `docs/agent-briefs/track-common.md` and
   follow it. Your branch ends with a WIP commit made when the session was paused: undo it with
   `git reset --soft HEAD~1`, check what is finished against `docs/tracks/integration-s2.md` (Sprint 3 tasks) and
   DESIGN.md §6.3 TN, finish the sprint, get the independent review, and commit."
   T7's sprint looks complete: have it check its own work and run its review instead.
3. Merge each finished track with `docs/agent-briefs/merge-check.sh track/<track> "<message>" [e2e]`. It merges,
   runs every check, re-runs failing test files alone, and pushes only when green.
4. After all eight: an integration pass like `docs/tracks/integration-s2.md`, then Sprint 4.

## Decisions still with the owner

- **Claude Design send-side trial** (`docs/S-CD.md`): postponed. T7's question-and-answer wizard, prompt and send step
  wait for it. The owner may run it by hand.
- **Real photos** for release gate 2: three objects shot to `docs/CAPTURE.md`.
- **npm 11** (`npm i -g npm@11.21.0` in Node 22): optional; only silences a warning.
- **Depth model download** (27–50 MB) for release gate 4: ask before downloading.

## Rules that must survive the pause

- Never touch `~/Documents/Crochet Pattern Generator` from agents or tests; never bind port 5180 from an agent.
- Commit and push after every finished piece; `master` only receives green merges.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
