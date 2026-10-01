#!/usr/bin/env node
// `npm run perf` (DESIGN.md §5.8, §6.1 rule 5). Step 0 owned.
//
// Runs only the tests tagged `perf` (the ones that assert a wall-clock duration, src/test/timing.ts), one file at a
// time in one worker, with CPG_PERF=1 so `budget(ms)` is the strict budget. `npm test` runs the same tests in
// parallel against a loose sanity bound only, because other agents may load the machine.
//
// Extra arguments: a path filter (`npm run perf -- src/core/meshtools`) keeps only the timing files whose path
// contains it; options (`--reporter=verbose`) are passed to vitest. A file is a timing file when it imports
// src/test/timing (any spelling: `…/test/timing`, `…/test/timing.ts`) or names the `perf` tag itself.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEST_FILE = /\.test\.tsx?$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude', 'dist', 'test-results', 'playwright-report']);

/** Test files under `dir` that use the timing helper. */
function timingTests(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...timingTests(full));
    else if (TEST_FILE.test(entry.name) && /test\/timing(\.ts)?['"]|tags:\s*\[[^\]]*['"]perf['"]/.test(fs.readFileSync(full, 'utf8'))) out.push(path.relative(root, full));
  }
  return out;
}

const extra = process.argv.slice(2);
const filters = extra.filter((a) => !a.startsWith('-'));
const options = extra.filter((a) => a.startsWith('-'));
const files = ['src', 'scripts']
  .flatMap((d) => timingTests(path.join(root, d)))
  .filter((f) => filters.length === 0 || filters.some((x) => f.includes(path.normalize(x))))
  .sort();
if (files.length === 0) {
  console.error(filters.length ? `perf: no timing test file matches ${filters.join(', ')}` : 'perf: no test file imports src/test/timing');
  process.exit(1);
}

const cores = os.cpus().length;
const [load1, load5] = os.loadavg();
console.log(`perf: ${files.length} files, load average ${load1.toFixed(1)} / ${load5.toFixed(1)} on ${cores} cores`);
if (load1 > 0.75 * cores) {
  console.warn(`perf: WARNING — the machine is loaded (${load1.toFixed(1)} > ${(0.75 * cores).toFixed(1)}); a failed budget may be the load, re-run when it is idle.`);
}

const vitest = path.join(root, 'node_modules', 'vitest', 'vitest.mjs');
const args = [vitest, 'run', ...files, '--tags-filter=perf', '--no-file-parallelism', '--maxWorkers=1', ...options];
const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit', env: { ...process.env, CPG_PERF: '1' } });
if (result.error) {
  console.error(`perf: could not start vitest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
