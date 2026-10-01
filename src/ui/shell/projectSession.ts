// Which project is open, and where projects come from (Step 0c). The shell creates, opens and leaves projects
// only through this module; persistence plugs in behind `ProjectBackend`.
//
// Until T8's repository is wired in, the backend is `memoryBackend`: projects live in this browser tab (the
// open one in projectStore, the others in a Map with their assets), the library shows their summaries, and the
// save chip says "Not saved yet". Nothing is written anywhere, and leaving a project never drops its changes —
// they move into the Map. Integration replaces the backend with one on `createProjectRepository` and
// `useAutosave().flush()` (see "Requests for integration" in docs/tracks/s0c-shell.md).
import { appStore } from '../../state/appStore';
import { projectStore } from '../../state/projectStore';
import type { ProjectDoc, ProjectSummary } from '../../types/project';
import { newProjectDoc, type NewProjectKind } from './newProject';

export interface OpenedProject {
  doc: ProjectDoc;
  readOnly: boolean;
  assets?: Iterable<readonly [string, Blob]>;
}

export interface ProjectBackend {
  /** 'memory': nothing is saved yet (the save chip says so). */
  readonly kind: 'memory' | 'repository';
  /** Stores a new project; returns the document to open. */
  create(doc: ProjectDoc): Promise<ProjectDoc>;
  /** The project with this id, or null when there is none. */
  open(id: string): Promise<OpenedProject | null>;
  /**
   * The open project is about to be closed (library, another project): keep its current state. The memory
   * backend keeps the document and its assets; a repository backend flushes the pending save.
   */
  leave(doc: ProjectDoc, assets: ReadonlyMap<string, Blob>): Promise<void>;
}

export function summaryOf(doc: ProjectDoc, updatedAt = doc.updatedAt): ProjectSummary {
  return {
    id: doc.id,
    name: doc.name,
    mode: doc.mode,
    updatedAt,
    ...(doc.thumbnail ? { thumbnail: doc.thumbnail } : {}),
    ...(doc.qa?.awaiting ? { awaitingClaudeDesign: true } : {}),
  };
}

/** Projects of this tab only (Step 0c). */
export function createMemoryBackend(): ProjectBackend & { has(id: string): boolean } {
  const kept = new Map<string, { doc: ProjectDoc; assets: Map<string, Blob> }>();
  return {
    kind: 'memory',
    has: (id) => kept.has(id),
    async create(doc) {
      kept.set(doc.id, { doc, assets: new Map() });
      return doc;
    },
    async open(id) {
      const entry = kept.get(id);
      return entry ? { doc: entry.doc, readOnly: false, assets: entry.assets } : null;
    },
    async leave(doc, assets) {
      kept.set(doc.id, { doc, assets: new Map(assets) });
    },
  };
}

let backend: ProjectBackend = createMemoryBackend();

/** The backend in use. */
export const projectBackend = (): ProjectBackend => backend;

/** Replaces the backend (integration: the repository one; tests: their own). */
export function setProjectBackend(next: ProjectBackend): void {
  backend = next;
  editedInMemory.clear();
}

const newId = (): string =>
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `p-${Date.now().toString(36)}-${Math.floor(performance.now() * 1000).toString(36)}`;

/** Projects of this tab (memory backend) that were changed: a reload or a closed tab would lose them. */
const editedInMemory = new Set<string>();

/**
 * True when closing or reloading the page would lose work: the memory backend holds a project that was
 * changed, or the open one has changes. (With a repository backend, persistence decides; T8 flushes on hide.)
 */
export function hasUnsavedWork(): boolean {
  if (backend.kind !== 'memory') return false;
  const s = projectStore.getState();
  return editedInMemory.size > 0 || (s.doc !== null && s.changeId !== s.savedChangeId);
}

/** Keeps the open project (its current state) with the backend and closes it. */
export async function leaveProject(): Promise<void> {
  const s = projectStore.getState();
  if (!s.doc) return;
  if (backend.kind === 'memory' && s.changeId !== s.savedChangeId) editedInMemory.add(s.doc.id);
  await backend.leave(s.doc, s.assets);
  if (backend.kind === 'memory') appStore.getState().upsertSummary(summaryOf(s.doc, new Date().toISOString()));
  // The backend holds the changes now (memory) or has flushed them (repository).
  projectStore.getState().close({ discardUnsaved: true });
}

/**
 * Creates a project of `kind`, opens it and returns it. The caller navigates to it. The open project is left
 * first: when leaving fails (unsaved changes a repository backend could not save), nothing is created and no
 * lock is taken.
 */
export async function createProject(kind: NewProjectKind): Promise<ProjectDoc> {
  const { prefs } = appStore.getState();
  await leaveProject();
  const doc = await backend.create(newProjectDoc(kind, { id: newId(), now: new Date(), prefs }));
  await leaveProject(); // only if another project was opened meanwhile
  projectStore.getState().open(doc);
  appStore.getState().upsertSummary(summaryOf(doc));
  return doc;
}

/**
 * Makes `id` the open project (no-op when it already is). False when the backend has no such project. The
 * current project is left BEFORE the next one is opened, so a repository backend never takes the next lock
 * while the current project cannot be left (its rejection reaches the caller; the current project stays open).
 */
export function openProject(id: string): Promise<boolean> {
  if (projectStore.getState().doc?.id === id) return Promise.resolve(true);
  // One open per id at a time: a second call while the first runs joins it.
  const running = opening.get(id);
  if (running) return running;
  const run = (async () => {
    await leaveProject();
    const found = await backend.open(id);
    if (!found) return false;
    if (projectStore.getState().doc?.id === id) return true;
    await leaveProject();
    projectStore.getState().open(found.doc, { readOnly: found.readOnly, assets: found.assets });
    return true;
  })().finally(() => opening.delete(id));
  opening.set(id, run);
  return run;
}

const opening = new Map<string, Promise<boolean>>();

// Memory backend: keep the library card of the open project in step with its name and Claude Design state.
projectStore.subscribe((s, prev) => {
  if (backend.kind !== 'memory' || !s.doc || s.doc === prev.doc) return;
  const before = prev.doc;
  if (before && before.id === s.doc.id && before.name === s.doc.name && !!before.qa?.awaiting === !!s.doc.qa?.awaiting) return;
  appStore.getState().upsertSummary(summaryOf(s.doc, new Date().toISOString()));
});
