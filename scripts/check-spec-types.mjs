#!/usr/bin/env node
// Proves that src/types says exactly what docs/DESIGN.md says. Step 0 owned; run on demand:
//
//   node scripts/check-spec-types.mjs
//
// The types of §3.5.1, §3.7.1, §5.2 and §5.2.1 are frozen at Step 0 and change only through the S0 amendment
// lane (§6.1 rule 7), where the spec and src/types are edited together. This script cuts the four TypeScript
// blocks out of the spec, verbatim, and asks the compiler whether every declaration in them is IDENTICAL — not
// merely assignable — to its counterpart in src/types (a missing optional field, a wider union or a changed
// parameter all fail). Run it after any change to src/types or to those sections; `npm test` runs it too.
//
// The only edits made to the spec text are mechanical: `export` is added where §3.7.1 and `PartCommon` omit it,
// function and constant signatures become `declare` statements, and the two classes (which use constructor
// parameter properties, not allowed by `erasableSyntaxOnly`) are left out — plus the entries of
// PENDING_SPEC_AMENDMENTS below.
//
// Exit codes: 0 identical · 1 they differ · 2 the check could not run (TypeScript missing, spec layout changed).

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Places where src/types deliberately differs from the text of docs/DESIGN.md, each waiting for the
 * integration agent to change the spec (or to reject the difference and change src/types back). The
 * replacement is applied to the extracted spec text before the comparison, so everything else must still be
 * identical. An entry whose `find` text is gone from the spec makes the script fail: remove the entry then.
 * The reasons are written up in docs/tracks/s0.md.
 */
const PENDING_SPEC_AMENDMENTS = [];

const root = fileURLToPath(new URL('..', import.meta.url));
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function fail(code, message) {
  console.error(`check-spec-types: ${message}`);
  process.exit(code);
}

if (!existsSync(tsc)) fail(2, 'TypeScript is not installed here (run `npm ci` first); nothing was checked.');

const spec = readFileSync(path.join(root, 'docs', 'DESIGN.md'), 'utf8').split('\n');

/** The first ```ts block after the heading that starts with `heading`. */
function block(heading) {
  const start = spec.findIndex((line) => line.startsWith(heading));
  if (start < 0) fail(2, `heading not found in docs/DESIGN.md: ${heading}`);
  const open = spec.findIndex((line, i) => i > start && line.trim() === '```ts');
  const close = spec.findIndex((line, i) => i > open && line.trim() === '```');
  if (open < 0 || close < 0) fail(2, `no \`\`\`ts block after the heading: ${heading}`);
  return spec.slice(open + 1, close);
}

const files = {
  spec351: block('#### 3.5.1').map((l) => l.replace(/^interface PartCommon/, 'export interface PartCommon')),
  spec371: block('#### 3.7.1').map((l) => l.replace(/^(type|interface) /, 'export $1 ').replace(/^function /, 'export declare function ')),
  spec52: block('### 5.2 Core types'),
  spec521: block('#### 5.2.1')
    .filter((l) => !/^export class /.test(l))
    .map((l) =>
      l
        .replace(/^export function /, 'export declare function ')
        .replace(/^export const /, 'export declare const ')
        .replace(/^commitModelRevision\(/, 'export declare function commitModelRevision('),
    ),
};

for (const amendment of PENDING_SPEC_AMENDMENTS) {
  const text = files[amendment.block].join('\n');
  const count = text.split(amendment.find).length - 1;
  if (count !== 1) {
    fail(
      2,
      `a pending spec amendment no longer applies (its text occurs ${count} times in the spec): ${amendment.why}.\n` +
        'If docs/DESIGN.md was updated, remove the entry from PENDING_SPEC_AMENDMENTS.',
    );
  }
  files[amendment.block] = text.replace(amendment.find, amendment.replace).split('\n');
}

/** Names declared at the start of a line: [kind, name]. */
function declared(lines) {
  const out = [];
  for (const line of lines) {
    const m = /^export (?:declare )?(type|interface|function|const) ([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
    if (m) out.push([m[1], m[2]]);
    // `export type A = …; export type B = …` on one line (§5.2 units)
    for (const more of line.matchAll(/; export (type|interface) ([A-Za-z_][A-Za-z0-9_]*)/g)) out.push([more[1], more[2]]);
  }
  return out;
}

const pascal = (name) => name[0].toUpperCase() + name.slice(1);
/** The name in src/types of a spec declaration, or null when it is not a type (core/stub.ts helpers). */
function ours(kind, name) {
  if (kind === 'type' || kind === 'interface') return name === 'PartCommon' ? null : name;
  if (kind === 'const') return name === 'LIMB_TEMPLATE' ? 'LimbTemplate' : null;
  if (name === 'stub' || name === 'isImplemented') return null;
  return `${pascal(name)}Fn`;
}

const imports = {
  spec351: '',
  spec371: "import type { CrochetModelV1 } from './spec351';\nimport type { ColoredMesh, Issue } from './spec52';\n",
  spec52:
    "import type { CrochetModelV1, Dims, PaletteColor, Part, PartType } from './spec351';\n" +
    "import type { ImportContext, ImportInput, ImportResult, Repair } from './spec371';\n",
  spec521:
    "import type { ManifoldToplevel } from 'manifold-3d';\nimport type { ComponentType, ReactNode } from 'react';\n" +
    "import type { CrochetModelV1, Dims, Hex, Part, PartType } from './spec351';\nimport type { Repair } from './spec371';\n" +
    'import type { AmiRequest, AmiResult, AssetRef, ChartGrid, ChartRequest, ChartResult, ChartSettings, ColoredMesh, Hand, Line, MeshApi,\n' +
    '  ModelRevision, PatternDoc, ProjectDoc, ProjectSummary, ResolvedGauge, RgbaImage, TechniqueId, Terms, UnitPref, Vec3, ViewLabel, Yarn,\n' +
    "} from './spec52';\n",
};

const checks = [];
for (const [file, lines] of Object.entries(files)) {
  for (const [kind, name] of declared(lines)) {
    const mine = ours(kind, name);
    if (!mine) continue;
    const theirs = kind === 'type' || kind === 'interface' ? `${file}.${name}` : `typeof ${file}.${name}`;
    // One line per declaration, so a compiler error points at the declaration that differs.
    checks.push(`export type Check${checks.length + 1} = Same<Identical<M.${mine}, ${theirs}>>; // ${file}: ${kind} ${name}`);
  }
}
if (checks.length < 100) fail(2, `only ${checks.length} declarations were found in the spec blocks; the extraction no longer fits the document.`);

// A directory of its own per run, inside node_modules so that `react` and `manifold-3d` resolve: two runs at
// once (a manual run during `npm test`, say) must not share files.
const tmpRoot = path.join(root, 'node_modules', '.tmp');
mkdirSync(tmpRoot, { recursive: true });
const outDir = mkdtempSync(path.join(tmpRoot, 'spec-types-'));

for (const [file, lines] of Object.entries(files)) {
  writeFileSync(path.join(outDir, `${file}.ts`), `// Extracted from docs/DESIGN.md by scripts/check-spec-types.mjs\n${imports[file]}${lines.join('\n')}\n`);
}
const typesIndex = path.join(root, 'src', 'types', 'index.ts').replaceAll('\\', '/');
writeFileSync(
  path.join(outDir, 'check.ts'),
  `import type * as M from '${typesIndex}';
import type * as spec351 from './spec351';
import type * as spec371 from './spec371';
import type * as spec52 from './spec52';
import type * as spec521 from './spec521';

type Identical<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Same<T extends true> = T;

${checks.join('\n')}

// The comparison must be able to fail: each line below has to be an error.
// @ts-expect-error optional and required differ
export type Negative1 = Same<Identical<{ a?: number }, { a: number }>>;
// @ts-expect-error a missing optional field differs
export type Negative2 = Same<Identical<{ a: number }, { a: number; b?: string }>>;
`,
);
writeFileSync(
  path.join(outDir, 'tsconfig.json'),
  `${JSON.stringify(
    {
      extends: path.join(root, 'tsconfig.app.json').replaceAll('\\', '/'),
      compilerOptions: { tsBuildInfoFile: './tsconfig.tsbuildinfo', incremental: false, noUnusedLocals: false },
      include: ['./*.ts'],
    },
    null,
    2,
  )}\n`,
);

let output = '';
let compiled = true;
try {
  execFileSync(process.execPath, [tsc, '-p', outDir, '--noEmit'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
} catch (error) {
  compiled = false;
  output = `${error.stdout ?? ''}${error.stderr ?? ''}`.trim() || String(error);
}

if (compiled) {
  rmSync(outDir, { recursive: true, force: true });
  const pending = PENDING_SPEC_AMENDMENTS.length;
  console.log(
    `check-spec-types: ${checks.length} declarations of DESIGN.md §3.5.1, §3.7.1, §5.2 and §5.2.1 are identical in src/types` +
      (pending === 0 ? '.' : `, with ${pending} pending spec amendment${pending === 1 ? '' : 's'}:`),
  );
  for (const amendment of PENDING_SPEC_AMENDMENTS) console.log(`  - ${amendment.replace}\n    (${amendment.why})`);
} else if (!/error TS\d+/.test(output)) {
  fail(2, `the compiler did not run (the extracted files are in ${path.relative(root, outDir)}):\n${output}`);
} else {
  // Name the declarations behind the failing lines of check.ts (the check's own comment says which one it is).
  const checkLines = readFileSync(path.join(outDir, 'check.ts'), 'utf8').split('\n');
  const differing = [];
  for (const m of output.matchAll(/check\.ts\((\d+),\d+\): error TS2344/g)) {
    const comment = /\/\/ (.*)$/.exec(checkLines[Number(m[1]) - 1] ?? '');
    if (comment) differing.push(comment[1]);
  }
  console.error('check-spec-types: src/types and docs/DESIGN.md differ.');
  if (differing.length > 0) {
    console.error(`\nNot identical (a type that contains a differing type differs too):\n  ${differing.join('\n  ')}`);
  }
  console.error(`\nCompiler output (the extracted files are in ${path.relative(root, outDir)}):\n${output}`);
  process.exitCode = 1;
}
