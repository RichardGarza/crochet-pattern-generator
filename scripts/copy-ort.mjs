#!/usr/bin/env node
// Copies the one ONNX Runtime wasm/mjs pair that ml.worker loads into public/ort/ (DESIGN.md §5.4).
//
// Only the asyncify pair is copied (about 27 MB), not the four variants onnxruntime-web ships (about 139 MB).
// public/ort/ is gitignored; `postinstall` runs this script, and `npm run copy-ort` runs it by hand.
//
// As `postinstall` a missing source only warns (an install must not fail because of an optional ML feature);
// run by hand it exits 1 so the problem is visible.

import { createHash } from 'node:crypto';
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ORT_FILES = ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'public', 'ort');
const asPostinstall = process.env.npm_lifecycle_event === 'postinstall';

/** Finds onnxruntime-web/dist the way Node would resolve it for @huggingface/transformers. */
function findOrtDist() {
  const lookups = [];
  try {
    // onnxruntime-web is a dependency of transformers, so it may be nested under it.
    const requireFromRoot = createRequire(path.join(root, 'package.json'));
    const transformers = requireFromRoot.resolve('@huggingface/transformers');
    lookups.push(...(createRequire(transformers).resolve.paths('onnxruntime-web') ?? []));
  } catch {
    // transformers is not installed (yet); fall back to the hoisted location below
  }
  lookups.push(path.join(root, 'node_modules'));
  for (const dir of lookups) {
    const dist = path.join(dir, 'onnxruntime-web', 'dist');
    if (ORT_FILES.every((f) => existsSync(path.join(dist, f)))) return dist;
  }
  return null;
}

const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');

function sameFile(a, b) {
  if (!existsSync(b)) return false;
  if (statSync(a).size !== statSync(b).size) return false;
  return sha256(a) === sha256(b);
}

const dist = findOrtDist();
if (!dist) {
  const message =
    'copy-ort: onnxruntime-web/dist/{' + ORT_FILES.join(', ') + '} not found under node_modules. ' +
    'Depth and click-to-segment will not load until `npm ci` and `npm run copy-ort` have run.';
  if (asPostinstall) {
    console.warn(message);
    process.exit(0);
  }
  console.error(message);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
let copied = 0;
let bytes = 0;
for (const file of ORT_FILES) {
  const from = path.join(dist, file);
  const to = path.join(outDir, file);
  bytes += statSync(from).size;
  if (sameFile(from, to)) continue;
  // COPYFILE_FICLONE: a copy-on-write clone on APFS (no extra disk space), a plain copy elsewhere.
  copyFileSync(from, to, constants.COPYFILE_FICLONE);
  copied++;
}
const mb = (bytes / (1024 * 1024)).toFixed(1);
console.log(
  copied === 0
    ? `copy-ort: public/ort/ is up to date (${ORT_FILES.length} files, ${mb} MB)`
    : `copy-ort: copied ${copied} of ${ORT_FILES.length} files into public/ort/ (${mb} MB)`,
);
