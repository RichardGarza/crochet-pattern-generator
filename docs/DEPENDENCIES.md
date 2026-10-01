# Dependencies

Resolved versions and licenses of what `package.json` asks for, as installed from the committed
`package-lock.json` (written by npm 11.21.0 on 2026-10-01; `npm ls --depth=0` and each package's `license`
field). The reasons for each choice are in `DESIGN.md` §5.6.

The lockfile changes only at Step 0 or through the S0 amendment lane (`DESIGN.md` §6.1 rules 3 and 7), always
with `npx -y npm@11.21.0 install`, never with `--legacy-peer-deps` or `--force`. Update this file in the same
commit.

## Runtime

| Package | Asked | Installed | License | Use |
|---|---|---|---|---|
| react | ^19.3.0 | 19.3.0 | MIT | UI |
| react-dom | ^19.3.0 | 19.3.0 | MIT | UI |
| three | ^0.186.1 | 0.186.1 | MIT | rendering, loaders (GLTF/OBJ/PLY/STL), marching-cubes tables |
| @react-three/fiber | ^9.8.1 | 9.8.1 | MIT | 3D viewport |
| @react-three/drei | ^10.7.9 | 10.7.9 | MIT | viewport helpers, TransformControls |
| zustand | ^5.0.15 | 5.0.15 | MIT | state |
| immer | ^11.1.18 | 11.1.18 | MIT | patches for undo and redo |
| zod | ^4.6.5 | 4.6.5 | MIT | schemas, JSON Schema export |
| idb | ^8.0.3 | 8.0.3 | ISC | IndexedDB |
| comlink | ^4.4.2 | 4.4.2 | Apache-2.0 | worker RPC |
| fflate | ^0.8.3 | 0.8.3 | MIT | zip, gzip, zlib (PNG codec) |
| json5 | ^2.2.3 | 2.2.3 | MIT | lenient JSON in the importer |
| three-mesh-bvh | ^0.9.15 | 0.9.15 | MIT | raycasts, closest point, sculpt queries, voxelize |
| manifold-3d | ^3.5.4 | 3.5.4 | Apache-2.0 | manifold validation, genus, decompose |
| meshoptimizer | ^1.3.0 | 1.3.0 | MIT | mesh simplification |
| @huggingface/transformers | ^4.3.0 | 4.3.0 | Apache-2.0 | optional depth and click-to-segment models |
| jspdf | ^4.2.1 | 4.2.1 | MIT | PDF |
| svg2pdf.js | ^2.8.1 | 2.8.1 | MIT | PDF (vector charts) |
| acorn | ^8.18.0 | 8.18.0 | MIT | v1.1 static heuristics of the importer |

## Development

| Package | Asked | Installed | License | Use |
|---|---|---|---|---|
| typescript | ~6.0.3 | 6.0.3 | Apache-2.0 | type checking (not 7.x) |
| vite | ^8.3.1 | 8.3.2 | MIT | dev server and build; needs Node >= 22.12 here |
| @vitejs/plugin-react | ^6.1.1 | 6.1.1 | MIT | React fast refresh |
| vitest | ^4.1.11 | 4.1.11 | MIT | unit tests (not 5.x) |
| oxlint | ^1.86.0 | 1.86.0 | MIT | lint |
| tsx | ^4.23.15 | 4.23.15 | MIT | runs `scripts/*.ts` (`npm run schema`) |
| @types/react | ^19.3.0 | 19.3.0 | MIT | types |
| @types/react-dom | ^19.3.0 | 19.3.0 | MIT | types |
| @types/three | ^0.186.0 | 0.186.0 | MIT | types |
| @types/node | ^24 | 24.19.0 | MIT | types |
| fake-indexeddb | ^6.2.5 | 6.2.5 | Apache-2.0 | persistence tests |
| happy-dom | ^20.14.5 | 20.14.5 | MIT | DOM for UI tests |
| @testing-library/react | ^16.3.3 | 16.3.3 | MIT | UI tests |
| @testing-library/dom | ^10.4.2 | 10.4.2 | MIT | peer of @testing-library/react, listed so no install can drop it |
| @playwright/test | 1.63.0 (exact) | 1.63.0 | Apache-2.0 | browser tests; uses Chromium build 1243 |

## Transitive packages worth knowing

| Package | Installed | License | Comes from | Note |
|---|---|---|---|---|
| onnxruntime-web | 1.31.0-dev.20260914-8d85527a0 | MIT | @huggingface/transformers | `scripts/copy-ort.mjs` copies its `ort-wasm-simd-threaded.asyncify.{mjs,wasm}` (25.7 MB) into `public/ort/` |
| onnxruntime-node | 1.30.0 | MIT | @huggingface/transformers | Node only (287 MB on disk); not used by the app and not in the browser bundle |
| sharp | 0.35.5 | Apache-2.0 | @huggingface/transformers, manifold-3d | Node only; not in the browser bundle |
| @img/sharp-libvips-darwin-arm64 | 1.3.4 | LGPL-3.0-or-later | sharp (optional) | native library for sharp on this Mac; Node only, not bundled, not redistributed by the app |
| @img/sharp-wasm32 | 0.35.5 | Apache-2.0 AND LGPL-3.0-or-later AND MIT | sharp (optional) | installed by npm 10 `npm ci` only (npm 11 skips it); same as above |
| lightningcss | 1.33.0 | MPL-2.0 | vite | build tool only |
| dompurify | 3.4.16 | MPL-2.0 OR Apache-2.0 | jspdf (optional) | used under Apache-2.0 |
| esbuild | 0.28.2 | MIT | tsx | build tool only |
| rolldown | 1.2.12 | MIT | vite | build tool only; no `@rolldown/binding-*` is listed by hand |
| playwright-core | 1.63.0 | Apache-2.0 | @playwright/test | |

Licenses across all 251 installed packages: MIT 198, Apache-2.0 21, BSD-3-Clause 13, ISC 8, MPL-2.0 2, and one
each of BSD-2-Clause, 0BSD, LGPL-3.0-or-later, "Apache-2.0 AND LGPL-3.0-or-later AND MIT",
"MPL-2.0 OR Apache-2.0", "MIT AND Zlib", "MIT OR CC0-1.0", "MIT OR SEE LICENSE IN FEEL-FREE.md" (rgbcolor) and
one without a `license` field (webgl-constants 1.1.1, which ships an MIT `LICENSE` file). Nothing is GPL or
AGPL. The two LGPL entries are optional native libraries of sharp that only Node tooling could load; the app's
browser bundle does not include them.

## Install scripts

npm 11.21 blocks dependency install scripts unless `package.json` allows them (`allowScripts`); npm 10 runs
them. This project allows none, and needs none. Four dependencies have one:

| Package | Script | Needed? |
|---|---|---|
| esbuild 0.28.2 | `node install.js` | No: the platform binary comes from the optional `@esbuild/*` package. |
| onnxruntime-node 1.30.0 | `node ./script/install` | No: Node-side ONNX Runtime is not used. |
| protobufjs 7.6.6 | `node scripts/postinstall` | No: it only prints a version notice. |
| core-js 3.50.0 | a funding banner | No. |

The project's own `postinstall` (`node scripts/copy-ort.mjs`) runs under both npm versions.

## Excluded on purpose

`@imgly/background-removal` (AGPL), BRIA RMBG weights and Depth Anything V2 Base/Large/Giant (non-commercial),
libimagequant (GPL), CrochetPARADE / AmiGo / crochet-cad code (GPL / CC BY-NC-SA; their algorithms are
re-implemented from the papers), OpenCV.js and MediaPipe (v1.1 at most), culori and image-q (own kernel),
react-router (hash router), @gltf-transform as a direct dependency (own GLB JSON reader; it is present only as a
dependency of manifold-3d), htmlparser2 and any DOM shim for the importer (own tokenizer). See `DESIGN.md` §5.6.
