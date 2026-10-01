// Track T8 — document migrations (DESIGN.md §5.5.3): pure `migrate_vN_to_vN+1(doc)` functions, run in order
// on every document read from IndexedDB or a project file. The pre-migration document is snapshotted by the
// repository before a migrated document is written back.
//
// Version 1 is the first version, so the table is empty today. The runner and its guard are what a later
// version plugs into:
//
//   export const MIGRATIONS = { 1: migrate_v1_to_v2 } satisfies MigrationTable;
//   function migrate_v1_to_v2(doc) { return { ...doc, version: 2, newField: default } }   // keep every field
//
// Rules for a migration: pure (no I/O, no clock, no randomness), takes a deep copy it may change, returns the
// document of the next version, and keeps every field it does not explicitly rename or remove — the runner
// checks that with `missingFields` and refuses a step that loses data it did not declare.
import type { ProjectDoc } from '../../types/project';

/** The `ProjectDoc.version` this code writes. */
export const CURRENT_DOC_VERSION = 1;

export type JsonObject = Record<string, unknown>;

export interface Migration {
  /** `vN → vN+1`. Gets a deep copy; returns the next version's document. */
  up(doc: JsonObject): JsonObject;
  /**
   * Field paths (`a.b.c`; `*` matches any key or index) this step renames or removes on purpose. Every other
   * path of the input must still exist in the output.
   */
  drops?: readonly string[];
}

/** Key `N` = the step from version `N` to `N + 1`. */
export type MigrationTable = Readonly<Record<number, Migration>>;

export const MIGRATIONS: MigrationTable = {};

/**
 * What is wrong with a migration table for `current` (empty when nothing): a missing step between 1 and
 * `current`, or a step beyond it. A unit test runs it on `MIGRATIONS`, so raising `CURRENT_DOC_VERSION` without
 * its migration fails the build instead of every old project at open.
 *
 * How to add version N + 1 (T8.2 scaffold):
 *   1. write `migrate_vN_to_vN1(doc)` here (pure; keep every field; list deliberate renames in `drops`);
 *   2. add it as `MIGRATIONS[N]` and raise `CURRENT_DOC_VERSION`;
 *   3. add a fixture of a version-N document to the migration tests and check the fields it adds.
 * Everything that reads a document — `open`, `.crochet.json` import, the folder mirror's restore and "load the
 * folder version", backups — runs `migrateDoc`; the repository snapshots the original before writing back.
 */
export function checkMigrationTable(table: MigrationTable, current: number = CURRENT_DOC_VERSION): string[] {
  const problems: string[] = [];
  for (let v = 1; v < current; v++) if (!table[v]) problems.push(`no migration from version ${v} to ${v + 1}`);
  for (const key of Object.keys(table)) {
    const v = Number(key);
    if (!Number.isInteger(v) || v < 1 || v >= current) problems.push(`a migration from version ${key}, outside 1…${current - 1}`);
  }
  return problems;
}

export class MigrationError extends Error {
  readonly code: 'not-a-project' | 'bad-version' | 'newer-version' | 'missing-step' | 'lost-fields';
  constructor(code: MigrationError['code'], message: string) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
  }
}

/** True for a document of a version newer than this app (refuse to open or overwrite it). */
export const isNewerVersion = (version: unknown): boolean => typeof version === 'number' && version > CURRENT_DOC_VERSION;

/** Every leaf path of a JSON-like value, as key lists; an empty object or array is a leaf of its own. */
export function leafPaths(value: unknown, prefix: readonly string[] = [], out: string[][] = []): string[][] {
  if (typeof value === 'object' && value !== null) {
    const entries = Array.isArray(value) ? value.map((v, i) => [String(i), v] as const) : Object.entries(value);
    if (entries.length === 0) out.push([...prefix]);
    for (const [k, v] of entries) leafPaths(v, [...prefix, k], out);
  } else {
    out.push([...prefix]);
  }
  return out;
}

/** Every leaf path as `a.b.0.c` (for messages; a key may itself contain dots). */
export const fieldPaths = (value: unknown): string[] => leafPaths(value).map((p) => p.join('.'));

function hasPath(value: unknown, path: readonly string[]): boolean {
  let cur: unknown = value;
  for (const part of path) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, part)) return false;
    cur = (cur as Record<string, unknown>)[part];
  }
  return true;
}

/** A `drops` pattern (`a.b`, `*` = any one key) covers its own path and everything under it. */
function matches(pattern: string, path: readonly string[]): boolean {
  const p = pattern.split('.');
  return p.length <= path.length && p.every((part, i) => part === '*' || part === path[i]);
}

/** The leaf paths of `before` that `after` lacks, except those covered by `drops`. */
export function missingFields(before: unknown, after: unknown, drops: readonly string[] = []): string[] {
  return leafPaths(before)
    .filter((path) => !hasPath(after, path) && !drops.some((d) => matches(d, path)))
    .map((path) => path.join('.'));
}

export interface MigrationResult {
  doc: ProjectDoc;
  /** The version the document had. */
  from: number;
  /** True when at least one step ran (the caller snapshots the original before writing the result). */
  migrated: boolean;
}

/**
 * Brings a stored or imported document to `CURRENT_DOC_VERSION` (or `o.target`). Never changes `raw`.
 * Throws `MigrationError`: not a project document, a version that is not a positive integer, a version newer
 * than this app (`newer-version`), a missing step, or a step that dropped a field it did not declare.
 */
export function migrateDoc(raw: unknown, o: { table?: MigrationTable; target?: number } = {}): MigrationResult {
  const table = o.table ?? MIGRATIONS;
  const target = o.target ?? CURRENT_DOC_VERSION;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw) || (raw as JsonObject).schema !== 'crochet-project') {
    throw new MigrationError('not-a-project', 'This is not a Crochet Pattern Generator project.');
  }
  const version = (raw as JsonObject).version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    throw new MigrationError('bad-version', `The project has an invalid version (${JSON.stringify(version)}).`);
  }
  if (version > target) {
    throw new MigrationError('newer-version', `This project was saved by a newer version of the app (format ${version}); update the app to open it.`);
  }
  if (version === target) return { doc: raw as ProjectDoc, from: version, migrated: false };
  let doc = structuredClone(raw) as JsonObject;
  for (let v = version; v < target; v++) {
    const step = table[v];
    if (!step) throw new MigrationError('missing-step', `No migration from version ${v} to ${v + 1}.`);
    const next = step.up(structuredClone(doc));
    if (next.version !== v + 1) throw new MigrationError('bad-version', `The migration from version ${v} returned version ${JSON.stringify(next.version)}.`);
    const lost = missingFields(doc, next, step.drops);
    if (lost.length > 0) throw new MigrationError('lost-fields', `The migration from version ${v} lost ${lost.slice(0, 5).join(', ')}.`);
    doc = next;
  }
  return { doc: doc as unknown as ProjectDoc, from: version, migrated: true };
}
