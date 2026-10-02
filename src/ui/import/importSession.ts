// Track T7.4 — the import in progress, per project (DESIGN.md F4 steps 4–6, §3.7.7): what was dropped or pasted, the
// importer's answer, the user's choices (units, version, "Carry anyway"), and Accept. It lives outside React so a
// pending import survives switching tabs, and so Start → "Import from Claude Design" can hand it to the project
// the prompt came from (`moveImport`).
//
// The import itself runs in import.worker (`workers.importer.importInputs`); tests replace the runner.
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { zipSync } from 'fflate';
import { derivedStore } from '../../state/derivedStore';
import { projectStore, type ProjectStore } from '../../state/projectStore';
import { acceptImport, type AcceptImportOutcome } from '../../state/slices/qa';
import type { ImportContext, ImportInput, ImportResult } from '../../types/importer';
import type { CrochetModelV1 } from '../../types/model';
import type { ProjectDoc } from '../../types/project';

/** The importer's own input limit (§3.7.6): a bigger file is refused before it is read into memory. */
export const MAX_INPUT_BYTES = 100 * 1024 * 1024;

export type ImportPhase = 'reading' | 'report' | 'failed' | 'accepting' | 'accepted';

export interface ImportOriginal {
  /** `ImportRecord.fileName`: the file's name, "a.obj + a.mtl", or "Pasted text". */
  name: string;
  bytes: Blob;
  mime: string;
}

export interface PendingImport {
  projectId: string;
  /** Kept for re-runs (units answer, versions pick, another project's expected height). */
  inputs: ImportInput[];
  original: ImportOriginal;
  ctx: ImportContext;
  phase: ImportPhase;
  /** Bumped by every run; an older run's answer is ignored. */
  run: number;
  result?: ImportResult;
  /** A run that threw (the worker died), or a file refused before reading. */
  error?: string;
  /** The user answered (or kept) the units question. */
  unitsAnswered: boolean;
  /** "Carry anyway" picks of the diff (part ids). */
  carryAnyway: string[];
  outcome?: AcceptImportOutcome;
}

export type ImportRunner = (inputs: ImportInput[], ctx?: ImportContext) => Promise<ImportResult>;

let runner: ImportRunner | null = null;

/** Replaces how imports run (tests: the core importer in-thread); null restores import.worker. */
export function setImportRunner(next: ImportRunner | null): void {
  runner = next;
}

async function runImport(inputs: ImportInput[], ctx: ImportContext): Promise<ImportResult> {
  if (runner) return runner(inputs, ctx);
  const { workers } = await import('../../workers/client');
  return workers.importer.importInputs(inputs, ctx);
}

interface SessionState {
  byProject: Readonly<Record<string, PendingImport>>;
}

export const importSessionStore: StoreApi<SessionState> = createStore<SessionState>()(() => ({ byProject: {} }));

export function usePendingImport(projectId: string | undefined): PendingImport | undefined {
  return useStore(importSessionStore, (s) => (projectId ? s.byProject[projectId] : undefined));
}

export function pendingImport(projectId: string): PendingImport | undefined {
  return importSessionStore.getState().byProject[projectId];
}

function put(p: PendingImport): void {
  importSessionStore.setState((s) => ({ byProject: { ...s.byProject, [p.projectId]: p } }));
}

function patch(projectId: string, run: number | null, change: Partial<PendingImport>): boolean {
  const cur = pendingImport(projectId);
  if (!cur || (run !== null && cur.run !== run)) return false;
  put({ ...cur, ...change });
  return true;
}

/** Forgets the project's pending import. */
export function clearImport(projectId: string): void {
  importSessionStore.setState((s) => {
    if (!Object.hasOwn(s.byProject, projectId)) return s;
    const next = { ...s.byProject };
    delete next[projectId];
    return { byProject: next };
  });
}

/** Test helper: forgets everything. */
export function resetImportSessions(): void {
  importSessionStore.setState({ byProject: {} });
}

/**
 * §3.7.5 / §3.7.7: the size the project expects — its seed's `finishedSize.height`, else its Yarn & size height
 * (the model's height, or the target height before a model exists). Undefined when it has none.
 */
export function expectedHeightFor(doc: ProjectDoc | null | undefined): number | undefined {
  const h = doc?.qa?.seed?.finishedSize.height ?? doc?.threeD?.model?.finishedSize.height ?? doc?.threeD?.recon?.targetHeightIn;
  return typeof h === 'number' && Number.isFinite(h) && h > 0 ? h : undefined;
}

/**
 * §3.7.7: what the diff compares with — the seed the project sent when the result carries this project's tag for
 * that seed, else the current model (undefined: nothing yet, so everything is new).
 */
export function diffBaseFor(doc: ProjectDoc | null | undefined, result: Pick<ImportResult, 'cpgTag'> | undefined): { model: CrochetModelV1; what: 'seed' | 'current' } | undefined {
  const seed = doc?.qa?.seed;
  const tag = result?.cpgTag;
  if (seed && tag && doc && tag.project === doc.id && doc.qa?.awaiting?.seedRev === tag.seedRev) return { model: seed, what: 'seed' };
  const current = doc?.threeD?.model;
  return current ? { model: current, what: 'current' } : undefined;
}

const MIME_BY_EXT: Readonly<Record<string, string>> = {
  zip: 'application/zip',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  tar: 'application/x-tar',
  html: 'text/html',
  htm: 'text/html',
  json: 'application/json',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  obj: 'model/obj',
  mtl: 'model/mtl',
  stl: 'model/stl',
  ply: 'application/ply',
  txt: 'text/plain',
  md: 'text/markdown',
};

function mimeOf(name: string, given: string): string {
  if (given) return given;
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase() ?? '';
  return Object.hasOwn(MIME_BY_EXT, ext) ? MIME_BY_EXT[ext] : 'application/octet-stream';
}

/** What a dropped set of files is kept as (the original, §3.7.7): the file itself, or a zip of several. */
export function originalOf(files: readonly { name: string; bytes: Uint8Array<ArrayBuffer>; type: string }[]): ImportOriginal {
  if (files.length === 1) {
    const f = files[0];
    return { name: f.name, bytes: new Blob([f.bytes]), mime: mimeOf(f.name, f.type) };
  }
  const entries: Record<string, Uint8Array> = {};
  files.forEach((f, i) => {
    let name = f.name.replace(/[\\/]/g, '_') || `file-${i + 1}`;
    while (Object.hasOwn(entries, name)) name = `${i + 1}-${name}`;
    entries[name] = f.bytes;
  });
  const zipped = zipSync(entries, { level: 6 });
  return { name: files.map((f) => f.name).join(' + '), bytes: new Blob([zipped as Uint8Array<ArrayBuffer>]), mime: 'application/zip' };
}

async function execute(projectId: string, run: number): Promise<void> {
  const cur = pendingImport(projectId);
  if (!cur || cur.run !== run) return;
  const job = `${projectId}:${run}`;
  derivedStore.getState().beginJob('import', job);
  try {
    const result = await runImport(cur.inputs, cur.ctx);
    derivedStore.getState().finishJob('import', job);
    patch(projectId, run, {
      phase: result.ok ? 'report' : 'failed',
      result,
      error: undefined,
      // a user's own answer needs no question; nothing to answer without a confirm
      unitsAnswered: cur.unitsAnswered || !result.units?.confirm || cur.ctx.units !== undefined,
    });
  } catch (error) {
    derivedStore.getState().finishJob('import', job);
    const message = error instanceof Error ? error.message : String(error);
    patch(projectId, run, { phase: 'failed', result: undefined, error: message });
  }
}

export interface StartImportOptions {
  /** The project's expected height (`expectedHeightFor`). */
  expectedHeightIn?: number;
}

/** Imports dropped files into `projectId` (replacing any pending import of it). */
export async function importFiles(projectId: string, files: readonly File[], o: StartImportOptions = {}): Promise<void> {
  const tooBig = files.find((f) => f.size > MAX_INPUT_BYTES);
  const run = (pendingImport(projectId)?.run ?? 0) + 1;
  const ctx: ImportContext = o.expectedHeightIn !== undefined ? { expectedHeightIn: o.expectedHeightIn } : {};
  const label = files.map((f) => f.name).join(' + ');
  if (tooBig) {
    put({ projectId, inputs: [], original: { name: label, bytes: new Blob(), mime: 'application/octet-stream' }, ctx, phase: 'failed', run, error: `too-large:${tooBig.name}`, unitsAnswered: true, carryAnyway: [] });
    return;
  }
  // the placeholder shows "Reading…" at once; the bytes follow
  put({ projectId, inputs: [], original: { name: label, bytes: new Blob(), mime: '' }, ctx, phase: 'reading', run, unitsAnswered: false, carryAnyway: [] });
  let read: { name: string; bytes: Uint8Array<ArrayBuffer>; type: string }[];
  try {
    read = await Promise.all(files.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()), type: f.type })));
  } catch (error) {
    patch(projectId, run, { phase: 'failed', error: error instanceof Error ? error.message : String(error) });
    return;
  }
  if (!patch(projectId, run, { inputs: read.map((f) => ({ kind: 'file', name: f.name, bytes: f.bytes.buffer })), original: originalOf(read) })) return;
  await execute(projectId, run);
}

/** Imports pasted text into `projectId`. */
export async function importText(projectId: string, text: string, o: StartImportOptions = {}): Promise<void> {
  const run = (pendingImport(projectId)?.run ?? 0) + 1;
  const ctx: ImportContext = o.expectedHeightIn !== undefined ? { expectedHeightIn: o.expectedHeightIn } : {};
  put({
    projectId,
    inputs: [{ kind: 'text', text }],
    original: { name: 'Pasted text', bytes: new Blob([text], { type: 'text/plain' }), mime: 'text/plain' },
    ctx,
    phase: 'reading',
    run,
    unitsAnswered: false,
    carryAnyway: [],
  });
  await execute(projectId, run);
}

/** Runs the project's import again with a changed context (the units answer, a version pick). */
export async function rerunImport(projectId: string, change: Partial<ImportContext>): Promise<void> {
  const cur = pendingImport(projectId);
  if (!cur || cur.inputs.length === 0) return;
  const ctx: ImportContext = { ...cur.ctx };
  for (const [k, v] of Object.entries(change) as [keyof ImportContext, ImportContext[keyof ImportContext]][]) {
    if (v === undefined) delete ctx[k];
    else (ctx as Record<string, unknown>)[k] = v;
  }
  const run = cur.run + 1;
  put({ ...cur, ctx, run, phase: 'reading', unitsAnswered: cur.unitsAnswered || change.units !== undefined, carryAnyway: [], outcome: undefined });
  await execute(projectId, run);
}

/** The user kept the size the import chose. */
export function keepUnits(projectId: string): void {
  patch(projectId, null, { unitsAnswered: true });
}

export function setCarryAnyway(projectId: string, partIds: readonly string[]): void {
  patch(projectId, null, { carryAnyway: [...new Set(partIds)] });
}

/**
 * Start → "Import from Claude Design" found the project the prompt came from: the pending import moves there and
 * runs again with that project's expected height (§3.7.7). The caller then opens that project.
 */
export async function moveImport(fromId: string, toId: string, o: StartImportOptions = {}): Promise<void> {
  const cur = pendingImport(fromId);
  if (!cur || fromId === toId) return;
  clearImport(fromId);
  const ctx: ImportContext = { ...cur.ctx };
  if (o.expectedHeightIn !== undefined) ctx.expectedHeightIn = o.expectedHeightIn;
  else delete ctx.expectedHeightIn;
  const run = (pendingImport(toId)?.run ?? 0) + 1;
  put({ ...cur, projectId: toId, ctx, run, phase: 'reading', result: undefined, error: undefined, carryAnyway: [], outcome: undefined });
  await execute(toId, run);
}

/** Accept (§3.7.7): one undo step in the open project, which must be `projectId`. */
export async function acceptPending(projectId: string, store: ProjectStore = projectStore): Promise<AcceptImportOutcome> {
  const cur = pendingImport(projectId);
  if (!cur?.result?.ok) throw new Error('There is nothing to accept.');
  if (store.getState().doc?.id !== projectId) throw new Error('Open the project to accept its import.');
  const run = cur.run;
  patch(projectId, run, { phase: 'accepting' });
  try {
    const outcome = await acceptImport({ result: cur.result, original: cur.original, ...(cur.carryAnyway.length > 0 ? { carryPaintAnyway: cur.carryAnyway } : {}) }, store);
    patch(projectId, run, { phase: 'accepted', outcome });
    return outcome;
  } catch (error) {
    patch(projectId, run, { phase: 'report' });
    throw error;
  }
}
