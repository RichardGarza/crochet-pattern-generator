# Crochet Pattern Generator

A local web app that turns pictures, photos and 3D models into crochet patterns:

- **2D:** one image becomes a colorwork chart (graphgan, tapestry, C2C) with written rows, materials and yardage,
  sized to a finished size in inches for a chosen yarn weight and hook.
- **3D:** photos (several, or one) or a model made with Claude Design become an editable 3D parts model, and from
  that an amigurumi pattern: pieces, rounds with increases and decreases, colors, stuffing and assembly.

Everything runs in the browser on your own machine. Patterns are produced by deterministic algorithms and checked
by a stitch-count validator; there are no paid or AI APIs.

## Status

**In development — the app does not do anything useful yet.** The specification and research are complete; the
code so far is the foundation ("Step 0a"):

| Done | Not built yet |
|---|---|
| Toolchain, dependencies and configuration | The app itself: every screen, the 2D and 3D pipelines |
| Shared types for the whole app (`src/types/`) | Gauge tables, the 3D model kernels, the pattern encoder |
| Base kernels with tests: color math (OKLab, CIEDE2000), hashing, seeded random numbers, stable sorting, small vector math, a PNG codec | Saving, export and PDF |
| Typed stubs for every module that is still to be written | |

Opening the dev server shows a placeholder page. The plan and its progress are in [`docs/ROADMAP.md`](docs/ROADMAP.md).

## Requirements

- **Node 22 LTS** (22.12 or newer); the build tools (Vite 8, oxlint) require it. With
  [nvm](https://github.com/nvm-sh/nvm): `nvm install 22`, then `nvm use` in this folder (`.nvmrc` says `22`).
- npm 10.9 or newer for `npm ci` and for running the scripts. The lockfile is written by npm 11.21, so use
  `npx -y npm@11.21.0 install` whenever dependencies change. With npm 10 every command prints a short warning
  about the package manager version; that is expected.
- For the browser tests only: Playwright's Chromium (`npx playwright install chromium`).

In a shell that keeps no state between commands (an automated agent, for example), `nvm use` does not carry over;
start every command with `source ~/.nvm/nvm.sh && nvm use 22 >/dev/null && ` instead.

## Run

```sh
nvm use                # Node 22
npm ci                 # install; also copies the ONNX Runtime files into public/ort/
npm run dev            # http://localhost:5180 (the port is fixed: saved projects belong to this address)
```

`npm run build` makes a production build in `dist/`; `npm run preview` serves it on the same port.

A different port can be chosen with `CPG_PORT`. Under an automated agent or a test run (`CPG_TEST=1`), and in a
track worktree, the dev server never uses 5180, so it cannot touch the projects stored for that address.

## Test

```sh
npm run typecheck      # TypeScript, strict
npm run lint           # oxlint
npm test               # unit tests (Vitest)
npm run e2e            # browser tests (Playwright; starts its own dev server on port 5181; no specs yet)
```

npm refuses to run any of these on a Node older than 22.12 (`devEngines` in `package.json`), and `dev`, `build`,
`test`, `typecheck`, `lint` and `e2e` also check it themselves (`scripts/check-node.mjs`). `npm run lint` fails on
any correctness finding, not only on the rules listed in `.oxlintrc.json`.

## Repository layout

| Path | What |
|---|---|
| `docs/DESIGN.md` | The specification (algorithms, data model, architecture, build plan) |
| `docs/research/` | The fact-checked research behind it |
| `docs/ROADMAP.md` | Sprints and where things stand |
| `docs/CAPTURE.md` | How to photograph an object for the 3D mode |
| `docs/DEPENDENCIES.md` | Dependencies, versions and licenses |
| `docs/tracks/` | Build notes, one file per work stream |
| `src/types/` | Shared types (frozen) |
| `src/core/` | Pure TypeScript: algorithms that run in web workers, with their tests |
| `src/workers/`, `src/ui/` | Web workers and screens (stubs for now) |
| `scripts/` | Tooling: Node check, photo metadata stripping, ONNX Runtime copy |
| `fixtures/` | Test inputs, including real Claude Design exports |

## Privacy

This repository is public. Photos used for testing stay on the machine that took them: the folder for real
photo sets is ignored by git, and a test fails if any tracked image carries Exif, XMP or GPS metadata.
`scripts/strip-exif.mjs` makes metadata-free copies when a photo is meant to be shared.

## License

No license has been chosen yet. The dependencies and their licenses are listed in
[`docs/DEPENDENCIES.md`](docs/DEPENDENCIES.md).
