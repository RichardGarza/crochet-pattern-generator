// Track T8 — persistence wired into the app (DESIGN.md §5.5.2, F7): the repository behind the shell's
// `ProjectBackend` seam, the autosave controller on `projectStore`, the page events that flush it, and the
// project banners of §5.5.2 (read-only with "Edit here instead" / "Take over", conflict copy, reload for an
// update, save failed with "Export a backup").
//
// In a browser the app starts it once, when `useAutosave.ts` is first imported (`autoStartPersistence`; the
// shell imports that module at start-up). Tests call `startPersistence({ repo, … })` with fakes and `stop()`.
//
// T8.2 adds the library (delete into "Recently deleted", restore, delete for good, duplicate, export, import),
// the start-up chores (after the unload journal: purge "Recently deleted" past 30 days, then asset GC — both
// before this tab opens a project, GC skipped while another tab edits), the folder mirror (started when the
// server's probe says it is on) and the preferences (the `settings` store).
import { hrefFor, navigate as routerNavigate } from '../../app/router';
import { notify as appNotify } from '../../app/toasts';
import { createAutosave, type Autosave, type ConflictInfo } from '../../core/persist/autosave';
import { collectAssetKeys, expandAssetKeys } from '../../core/persist/assets';
import { buildProjectFile, projectFileBlob, projectFileName } from '../../core/persist/fileFormat';
import { createFolderApi, createFolderMirror, type FolderApi, type FolderMirror, type MirrorState } from '../../core/persist/folderClient';
import { createLocalLocks } from '../../core/persist/locks';
import {
  TRASH_PREFIX,
  createPersistRepository,
  isProjectNotFound,
  realTimers,
  type ImportOutcome,
  type PersistRepository,
  type RepositoryEvent,
  type Timers,
} from '../../core/persist/repo';
import { appStore, type AppStore, type Route } from '../../state/appStore';
import { libraryStore, type LibraryStore } from '../../state/slices/library';
import { projectStore, type ProjectStore } from '../../state/projectStore';
import type { ChannelLike, LockManagerLike } from '../../types/entryPoints';
import type { ProjectDoc } from '../../types/project';
import { dismissProjectBanner, showProjectBanner, type ProjectBanner } from '../shell/banners';
import { browserJournalStorage, clearJournal, recoverJournal, writeJournal, type JournalStorage, type Recovery } from './journal';
import { projectBackend, setProjectBackend, type ProjectBackend } from '../shell/projectSession';

export const BANNER = {
  readOnly: 'persist-read-only',
  conflict: 'persist-conflict',
  save: 'persist-save',
  reload: 'persist-reload',
  blocked: 'persist-blocked',
  removed: 'persist-removed',
} as const;

/** Where "Edit here instead" stands for the open project. */
export type HandOverState = 'idle' | 'asking' | 'no-answer';

export interface PersistenceDeps {
  repo: PersistRepository;
  store?: ProjectStore;
  app?: AppStore;
  banners?: { show(b: ProjectBanner): void; dismiss(id: string): void };
  navigate?: (route: Route, o?: { replace?: boolean }) => void;
  notify?: Pick<typeof appNotify, 'info' | 'success' | 'warn' | 'error'>;
  timers?: Timers;
  /** The clock of conflict-copy names. */
  now?: () => Date;
  /** The page whose `visibilitychange` / `pagehide` / `beforeunload` flush the save (null: none). */
  page?: { document: Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>; window: Pick<Window, 'addEventListener' | 'removeEventListener'> } | null;
  /** Saves a file for the user (default: a download link). */
  download?: (blob: Blob, name: string) => void;
  /** Opens a URL in a new tab ("Open the original"). */
  openTab?: (url: string) => void;
  setBackend?: (backend: ProjectBackend) => void;
  getBackend?: () => ProjectBackend;
  autosave?: { debounceMs?: number; retryDelaysMs?: readonly number[] };
  /** Makes it the app's session (`getPersistence`, `useAutosave().flush`), stopping the one before. */
  install?: boolean;
  /** Where the unload journal goes (default `localStorage`; null: none). */
  journal?: JournalStorage | null;
  /** The library's state (default: the app's `libraryStore`). */
  library?: LibraryStore;
  /**
   * Start-up chores before any project opens: purge "Recently deleted" past 30 days, then asset GC (skipped
   * while another tab edits). The app turns it on; tests opt in.
   */
  startup?: boolean;
  /**
   * The folder mirror (§5.5.4). Absent: none. `whenCapable`: start once the server's probe says the mirror is
   * on (`capabilities.folderMirror`); otherwise it starts at once.
   */
  mirror?: { api?: FolderApi; locks?: LockManagerLike; timers?: Timers; debounceMs?: number; whenCapable?: boolean; newId?: () => string };
  /** The key of the stored preferences in the `settings` store (null: preferences are not persisted). */
  prefsKey?: string | null;
  /** Object URLs for thumbnails (default `URL.createObjectURL` / `revokeObjectURL`). */
  objectUrls?: { create(blob: Blob): string; revoke(url: string): void } | null;
}

export interface PersistenceSession {
  readonly repo: PersistRepository;
  readonly autosave: Autosave;
  readonly backend: ProjectBackend;
  handOverState(): HandOverState;
  /** "Edit here instead". */
  editHereInstead(): Promise<void>;
  /** "Take over" (offered after 5 s without an answer). */
  takeOver(): Promise<void>;
  /** Downloads a `.crochet.json` of the open project from memory (works while saving fails). */
  exportBackup(): Promise<void>;
  refreshLibrary(): Promise<void>;
  /** Flushes, then snapshots the stored project (before rebuilds, cuts and deletes). */
  snapshot(label: string): Promise<void>;
  /** Resolves when the unload journal of the last page was replayed (projects open only after it). */
  readonly recovered: Promise<Recovery[]>;
  /** Resolves when the start-up chores are done (or gave up waiting): projects open after it. */
  readonly ready: Promise<void>;
  /** The folder mirror, once it runs. */
  mirror(): FolderMirror | null;
  /** Library delete: into "Recently deleted" (with an Undo toast). False when it was refused. */
  deleteProject(id: string): Promise<boolean>;
  /** Back from "Recently deleted". */
  restoreProject(id: string): Promise<boolean>;
  /** Deletes a project of "Recently deleted" for good (the folder keeps a copy in Backups/deleted). */
  deleteForever(id: string): Promise<boolean>;
  duplicateProject(id: string): Promise<string | null>;
  /** Downloads a stored project as `.crochet.json` (with its snapshots). */
  exportProject(id: string): Promise<boolean>;
  /** Imports a `.crochet.json` file (never overwrites). */
  importFile(file: Blob): Promise<ImportOutcome | null>;
  refreshTrash(): Promise<void>;
  /** Loads a thumbnail into the library's cache (`library.thumbs[key]`). */
  loadThumbnail(key: string): Promise<void>;
  stop(): void;
}

// The app's session lives on globalThis, so a dev-server hot update that re-runs this module (or
// useAutosave.ts) finds the running session instead of starting a second one on the same store.
const SESSION_KEY = '__cpgPersistenceSession';
const holder = globalThis as { [SESSION_KEY]?: PersistenceSession | null };
let current: PersistenceSession | null = holder[SESSION_KEY] ?? null;
const setCurrent = (session: PersistenceSession | null): void => {
  current = session;
  holder[SESSION_KEY] = session;
};

/** The running session, if persistence was started. */
export const getPersistence = (): PersistenceSession | null => current;

function browserDownload(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function browserOpenTab(url: string): void {
  window.open(url, '_blank', 'noopener');
}

const reasonOf = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (/quota/i.test(message) || (error as { name?: unknown })?.name === 'QuotaExceededError') return ' because this browser is out of storage space';
  return '';
};

/** Starts persistence: backend, autosave, banners, page events. With `install`, replaces the app's session. */
export function startPersistence(deps: PersistenceDeps): PersistenceSession {
  if (deps.install) current?.stop();
  const repo = deps.repo;
  const store = deps.store ?? projectStore;
  const app = deps.app ?? appStore;
  const banners = deps.banners ?? { show: showProjectBanner, dismiss: dismissProjectBanner };
  const navigate = deps.navigate ?? routerNavigate;
  const notify = deps.notify ?? appNotify;
  const download = deps.download ?? browserDownload;
  const openTab = deps.openTab ?? browserOpenTab;
  const setBackend = deps.setBackend ?? setProjectBackend;
  const previousBackend = (deps.getBackend ?? projectBackend)();
  const journal = deps.journal === undefined ? browserJournalStorage() : deps.journal;
  const now = deps.now ?? (() => new Date());
  const library = deps.library ?? libraryStore;
  const objectUrls =
    deps.objectUrls === undefined
      ? typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? { create: (blob: Blob) => URL.createObjectURL(blob), revoke: (url: string) => URL.revokeObjectURL(url) }
        : null
      : deps.objectUrls;
  const page = deps.page === undefined ? (typeof window !== 'undefined' && typeof document !== 'undefined' ? { document, window } : null) : deps.page;

  let handOver: HandOverState = 'idle';
  let stopped = false;
  const cleanups: (() => void)[] = [];

  const dirty = (): boolean => {
    const s = store.getState();
    return s.doc !== null && s.changeId !== s.savedChangeId;
  };
  const openId = (): string | null => store.getState().doc?.id ?? null;
  const nameOf = (id: string): string => app.getState().library?.find((p) => p.id === id)?.name ?? 'this project';

  // ---- banners

  const showReadOnly = (title: string, message: string): void => {
    handOver = 'idle';
    banners.show({
      id: BANNER.readOnly,
      kind: 'read-only',
      tone: 'warn',
      title,
      message,
      actions: [{ label: 'Edit here instead', run: () => void session.editHereInstead(), variant: 'primary' }],
    });
  };

  const showOpenElsewhere = (): void =>
    showReadOnly('Open in another tab', 'You can look around, but editing is off here so the two tabs can’t overwrite each other.');

  const onConflict = (info: ConflictInfo): void => {
    const route = app.getState().route;
    if (route.screen !== 'project' || route.projectId !== info.originalId) {
      // Found while leaving for another project or the library: stay where the user is going.
      notify.info(`Another tab saved a newer version of “${info.originalName}”. Your changes are safe in “${info.copyName}”.`, { key: 'persist-conflict' });
      return;
    }
    navigate({ screen: 'project', projectId: info.copyId, ...(route.tab ? { tab: route.tab } : {}) }, { replace: true });
    handOver = 'idle';
    banners.dismiss(BANNER.readOnly);
    banners.show({
      id: BANNER.conflict,
      kind: 'conflict-copy',
      tone: 'info',
      title: `Another tab saved a newer version of “${info.originalName}”`,
      message: `Your changes are safe in “${info.copyName}”, which you are editing now.`,
      actions: [{ label: 'Open the original', run: () => openTab(hrefFor({ screen: 'project', projectId: info.originalId })) }],
      dismissible: true,
    });
  };

  const onSaveError = (error: unknown, attempt: number): void => {
    banners.show({
      id: BANNER.save,
      kind: 'save-failed',
      tone: 'danger',
      title: 'Not saved',
      message: `Your latest changes couldn’t be saved in this browser${reasonOf(error)}. They’re still here — export a backup to be safe. ${attempt > 1 ? `Tried ${attempt} times; trying again…` : 'Trying again…'}`,
      actions: [{ label: 'Export a backup', run: () => void session.exportBackup(), variant: 'primary' }],
    });
  };

  const autosave = createAutosave({
    store,
    repo,
    timers: deps.timers,
    now: deps.now,
    debounceMs: deps.autosave?.debounceMs,
    retryDelaysMs: deps.autosave?.retryDelaysMs,
    onConflict,
    onError: onSaveError,
    onRecovered: () => {
      banners.dismiss(BANNER.save);
      notify.success('Saved again — your changes are safe.', { key: 'persist-save' });
    },
    onMissingAssets: (keys) => {
      notify.warn(`${keys.length} file${keys.length === 1 ? '' : 's'} of this project ${keys.length === 1 ? 'is' : 'are'} missing from this browser’s storage. Export a backup and check the project.`, {
        key: 'persist-missing',
      });
    },
  });

  /** Makes this tab the editor of `doc` (after a hand-over or a take-over). */
  const becomeEditor = async (doc: ProjectDoc): Promise<void> => {
    await autosave.flush();
    if (openId() !== doc.id) {
      // The tab moved on (another project, or its unsaved changes became a copy): do not keep the lock.
      repo.release(doc.id);
      return;
    }
    handOver = 'idle';
    banners.dismiss(BANNER.readOnly);
    if (dirty()) {
      // Unsaved changes on an older base: the next save becomes a copy, never an overwrite.
      store.getState().setReadOnly(false);
    } else {
      store.getState().open(doc, { readOnly: false, discardUnsaved: true });
    }
    notify.success('You can edit this project here now.', { key: 'persist-lock' });
  };

  // ---- the backend behind the shell's seam

  // Edits the last page could not save before it went away (unload journal): replayed before anything opens.
  const recovered = recoverJournal(journal, repo, now)
    .catch(() => [] as Recovery[])
    .then((list) => {
      for (const r of list) {
        if (r.outcome === 'restored') notify.success(`Recovered your last changes to “${r.name}”.`, { key: `persist-recovered-${r.id}` });
        if (r.outcome === 'copied') notify.info(`Recovered your last changes as “${r.name}” — the project had changed meanwhile.`, { key: `persist-recovered-${r.id}` });
      }
      return list;
    });

  // Start-up chores (§5.5.5): after the journal, before any project opens. A slow GC (a large library) never
  // holds the first open back for more than 2 s: at start-up this tab names nothing GC could take.
  const chores = recovered.then(async () => {
    if (!deps.startup) return;
    try {
      await repo.purgeTrash();
    } catch {
      // retried at the next start
    }
    try {
      await repo.gcAssets({ skipWhileEditing: true });
    } catch {
      // retried at the next start
    }
  });
  const ready: Promise<void> = Promise.race([
    chores,
    deps.startup ? new Promise<void>((resolve) => (deps.timers ?? realTimers).setTimeout(resolve, 2000)) : chores,
  ]).then(() => undefined);

  const backend: ProjectBackend = {
    kind: 'repository',
    async create(doc) {
      await ready;
      const stored = await repo.create(doc);
      // §5.5.2: ask for persistent storage when a project is created (idempotent).
      void repo.requestPersistence().then((persisted) => {
        if (persisted !== null) app.getState().setCapabilities({ storagePersisted: persisted });
      });
      return stored;
    },
    async open(id) {
      await ready;
      try {
        // A project in "Recently deleted" opens only after it is restored (the library offers that).
        if ((await repo.getMeta(TRASH_PREFIX + id).catch(() => undefined)) !== undefined) return null;
        const opened = await repo.open(id, 'edit');
        return { doc: opened.doc, readOnly: opened.readOnly };
      } catch (error) {
        if (isProjectNotFound(error)) return null;
        throw error;
      }
    },
    async leave(doc) {
      await autosave.flush();
      const id = openId() ?? doc.id;
      if (dirty()) {
        // The shell opened (or created) the next project's lock before leaving this one: give it back, since
        // that project will not open now.
        for (const other of repo.heldIds()) if (other !== id) repo.release(other);
        throw new Error('Your latest changes aren’t saved yet. Export a backup, or try again in a moment.');
      }
      repo.release(id);
      if (id !== doc.id) repo.release(doc.id);
      handOver = 'idle';
    },
  };

  // ---- repository events

  const onEvent = (e: RepositoryEvent): void => {
    switch (e.type) {
      case 'lock-lost':
        if (openId() !== e.id) return;
        store.getState().setReadOnly(true);
        if (e.reason === 'handed-over') {
          showReadOnly('Editing moved to another tab', 'Your changes were saved first. Editing is off here.');
        } else {
          showReadOnly('Another tab took over this project', 'Editing is off here. Anything this tab hadn’t saved yet is kept in a copy.');
        }
        return;
      case 'lock-acquired':
        if (openId() === e.id) void becomeEditor(e.doc);
        else repo.release(e.id);
        return;
      case 'saved':
        app.getState().upsertSummary(e.summary);
        return;
      case 'trashed':
        app.getState().removeSummary(e.id);
        void session.refreshTrash();
        return;
      case 'restored':
        app.getState().upsertSummary(e.summary);
        void session.refreshTrash();
        return;
      case 'removed':
        app.getState().removeSummary(e.id);
        void session.refreshTrash();
        if (e.remote && openId() === e.id) {
          banners.show({
            id: BANNER.removed,
            kind: 'info',
            tone: 'warn',
            title: 'This project was deleted in another tab',
            message: 'It is still open here; any change you make is saved again as this project.',
            dismissible: true,
          });
        }
        return;
      case 'closed-for-upgrade':
        autosave.dispose();
        if (store.getState().doc) store.getState().setReadOnly(true);
        banners.show({
          id: BANNER.reload,
          kind: 'reload-for-update',
          tone: 'warn',
          title: 'This tab was closed for an update',
          message: dirty()
            ? 'The app was updated in another tab, and your latest changes couldn’t be saved first. Export a backup, then reload.'
            : 'The app was updated in another tab. Reload to keep working — your changes are saved.',
          actions: [
            { label: 'Reload', run: () => window.location.reload(), variant: 'primary' },
            ...(dirty() ? [{ label: 'Export a backup', run: () => void session.exportBackup() }] : []),
          ],
        });
        notify.warn('This tab was closed for an update. Reload to keep working.', { key: 'persist-reload', timeoutMs: 0 });
        return;
      case 'blocked':
        banners.show({
          id: BANNER.blocked,
          kind: 'info',
          tone: 'info',
          title: 'Finishing an update',
          message: 'Close the other Crochet Pattern Generator tabs to finish updating.',
        });
        notify.info('Close the other Crochet Pattern Generator tabs to finish updating.', { key: 'persist-blocked', timeoutMs: 0 });
        return;
      case 'unblocked':
        banners.dismiss(BANNER.blocked);
        return;
      case 'terminated':
        banners.show({
          id: BANNER.save,
          kind: 'save-failed',
          tone: 'danger',
          title: 'Storage closed unexpectedly',
          message: 'The browser closed this app’s storage. Export a backup of this project, then reload.',
          actions: [{ label: 'Export a backup', run: () => void session.exportBackup(), variant: 'primary' }],
        });
        return;
      default:
        return;
    }
  };
  cleanups.push(repo.subscribe(onEvent));
  repo.setFlushHandler(async () => {
    await autosave.flush();
    return !dirty();
  });
  cleanups.push(() => repo.setFlushHandler(null));

  // A successful save makes a journal entry of this project stale.
  cleanups.push(
    store.subscribe((s, prev) => {
      if (s.savedChangeId === prev.savedChangeId || !s.doc || dirty()) return;
      clearJournal(journal, s.doc.id);
      if (prev.doc && prev.doc.id !== s.doc.id) clearJournal(journal, prev.doc.id);
    }),
  );

  // A project that opens read-only (another tab holds it) gets the banner with "Edit here instead". The
  // shell clears banners on every open, before this subscriber runs.
  cleanups.push(
    store.subscribe((s, prev) => {
      if (s.session === prev.session) return;
      handOver = 'idle';
      if (s.doc && s.readOnly && !repo.holdsLock(s.doc.id)) showOpenElsewhere();
    }),
  );

  // Leaving for the library flushes (§5.5.2 "before navigation to the library").
  cleanups.push(
    app.subscribe((s, prev) => {
      if (s.route.screen === 'start' && prev.route.screen !== 'start') void autosave.flush();
    }),
  );

  store.getState().setAssetLoader(async (key) => repo.getAssetByKey(key));
  cleanups.push(() => store.getState().setAssetLoader(null));

  if (page) {
    const onVisibility = (): void => {
      if (page.document.visibilityState === 'hidden') void autosave.flush();
    };
    /** Unsaved changes go to the synchronous journal first: the page may be gone before an IndexedDB save lands. */
    const journalUnsaved = (): boolean => {
      const s = store.getState();
      if (!s.doc || !dirty()) return true;
      return writeJournal(journal, s.doc, s.baseRev, now());
    };
    const onPageHide = (): void => {
      journalUnsaved();
      void autosave.flush();
    };
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      if (!dirty()) return;
      const journaled = journalUnsaved();
      void autosave.flush();
      // Ask when the changes are not safe anywhere yet: no journal, or saving fails.
      if (!journaled || autosave.failures() > 0 || repo.isClosed()) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    page.document.addEventListener('visibilitychange', onVisibility);
    page.window.addEventListener('pagehide', onPageHide);
    page.window.addEventListener('beforeunload', onBeforeUnload as EventListener);
    cleanups.push(() => {
      page.document.removeEventListener('visibilitychange', onVisibility);
      page.window.removeEventListener('pagehide', onPageHide);
      page.window.removeEventListener('beforeunload', onBeforeUnload as EventListener);
    });
  }

  const session: PersistenceSession = {
    repo,
    autosave,
    backend,
    handOverState: () => handOver,

    async editHereInstead() {
      const id = openId();
      if (!id || handOver === 'asking') return;
      handOver = 'asking';
      banners.show({
        id: BANNER.readOnly,
        kind: 'read-only',
        tone: 'warn',
        title: 'Asking the other tab to hand over…',
        message: 'It saves its changes first. This takes a moment.',
      });
      let result: Awaited<ReturnType<PersistRepository['requestHandOver']>>;
      try {
        result = await repo.requestHandOver(id);
      } catch (error) {
        showOpenElsewhere();
        notify.error(error instanceof Error ? error.message : String(error));
        return;
      }
      if (openId() !== id) return;
      if (result.ok) {
        await becomeEditor(result.doc);
        return;
      }
      if (result.reason === 'timeout') {
        handOver = 'no-answer';
        banners.show({
          id: BANNER.readOnly,
          kind: 'read-only',
          tone: 'warn',
          title: 'The other tab isn’t answering',
          message: 'It may be frozen or asleep. Take over to edit here — anything the other tab still saves goes into a copy, so nothing is lost.',
          actions: [
            { label: 'Take over', run: () => void session.takeOver(), variant: 'primary' },
            { label: 'Ask again', run: () => void session.editHereInstead() },
          ],
        });
        return;
      }
      showReadOnly('Open in another tab', result.reason === 'busy' ? 'Another tab started editing it first.' : 'Editing is off here.');
    },

    async takeOver() {
      const id = openId();
      if (!id) return;
      try {
        const { doc } = await repo.takeOver(id);
        await becomeEditor(doc);
      } catch (error) {
        notify.error(`Couldn’t take over: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    async exportBackup() {
      const s = store.getState();
      if (!s.doc) return;
      const doc = s.doc;
      try {
        const assets = new Map<string, Blob>();
        const load = async (key: string): Promise<Blob | undefined> => {
          if (!assets.has(key)) {
            const blob = s.assets.get(key) ?? (await repo.getAssetByKey(key).catch(() => undefined));
            if (blob) assets.set(key, blob);
          }
          return assets.get(key);
        };
        // Also the assets named inside JSON assets (the meshes of model revisions).
        const keys = await expandAssetKeys(collectAssetKeys(doc), load);
        let missing = 0;
        for (const key of keys) if (!(await load(key))) missing++;
        const file = await buildProjectFile({ doc, assets });
        download(projectFileBlob(file), projectFileName(doc.name));
        if (missing > 0) notify.warn(`${missing} file${missing === 1 ? '' : 's'} of this project could not be read and ${missing === 1 ? 'is' : 'are'} missing from the backup.`);
        else notify.success('Backup downloaded.', { key: 'persist-backup' });
      } catch (error) {
        notify.error(`Couldn’t make the backup: ${error instanceof Error ? error.message : String(error)}`);
      }
    },

    recovered,
    ready,

    mirror: () => mirror,

    async deleteProject(id) {
      const name = nameOf(id);
      try {
        await repo.trash(id);
      } catch (error) {
        notify.error(
          (error as { name?: unknown })?.name === 'ProjectLockedError'
            ? `“${name}” is open in another tab. Close it there, then delete it.`
            : `Couldn’t delete “${name}”: ${messageOf(error)}`,
        );
        return false;
      }
      notify.info(`Moved “${name}” to Recently deleted. It stays there for 30 days.`, {
        key: `library-deleted-${id}`,
        action: { label: 'Undo', run: () => void session.restoreProject(id) },
        timeoutMs: 8000,
      });
      return true;
    },

    async restoreProject(id) {
      try {
        const summary = await repo.restoreFromTrash(id);
        notify.success(`Restored “${summary.name}”.`, { key: `library-restored-${id}` });
        return true;
      } catch (error) {
        notify.error(`Couldn’t restore it: ${messageOf(error)}`);
        return false;
      }
    },

    async deleteForever(id) {
      const name = library.getState().trash?.find((t) => t.summary.id === id)?.summary.name ?? nameOf(id);
      try {
        await repo.remove(id);
      } catch (error) {
        notify.error(
          (error as { name?: unknown })?.name === 'ProjectLockedError'
            ? `“${name}” is open in another tab. Close it there first.`
            : `Couldn’t delete “${name}”: ${messageOf(error)}`,
        );
        return false;
      }
      notify.info(`Deleted “${name}” for good.`, { key: `library-purged-${id}` });
      return true;
    },

    async duplicateProject(id) {
      library.getState().setBusy(id, 'Duplicating…');
      try {
        const copy = await repo.duplicate(id);
        notify.success(`Made a copy: “${copy.name}”.`, { key: `library-copy-${id}` });
        return copy.id;
      } catch (error) {
        notify.error(`Couldn’t duplicate it: ${messageOf(error)}`);
        return null;
      } finally {
        library.getState().setBusy(id, null);
      }
    },

    async exportProject(id) {
      library.getState().setBusy(id, 'Exporting…');
      try {
        const doc = await repo.peek(id);
        if (!doc) throw new Error('It is no longer in this browser.');
        download(await repo.exportFile(id), projectFileName(doc.name));
        notify.success(`Exported “${doc.name}”.`, { key: `library-export-${id}` });
        return true;
      } catch (error) {
        notify.error(`Couldn’t export it: ${messageOf(error)}`);
        return false;
      } finally {
        library.getState().setBusy(id, null);
      }
    },

    async importFile(file) {
      try {
        const outcome = await repo.importFile(file);
        if (outcome.status === 'already-present') notify.info(`“${outcome.name}” is already in your library.`, { key: 'library-import' });
        else if (outcome.status === 'imported-as-copy') notify.success(`Imported as “${outcome.name}” — a project with the same id is already here, so it was kept as a copy.`, { key: 'library-import' });
        else notify.success(`Imported “${outcome.name}”.`, { key: 'library-import' });
        return outcome;
      } catch (error) {
        notify.error(`Couldn’t import that file: ${messageOf(error)}`);
        return null;
      }
    },

    async refreshTrash() {
      try {
        library.getState().setTrash(await repo.listTrash());
      } catch {
        library.getState().setTrash([]);
      }
    },

    async loadThumbnail(key) {
      if (!objectUrls || library.getState().thumbs[key]) return;
      const blob = await repo.getAssetByKey(key).catch(() => undefined);
      if (!blob || library.getState().thumbs[key]) return;
      library.getState().setThumb(key, objectUrls.create(blob));
    },

    async refreshLibrary() {
      await recovered;
      app.getState().setLibrary(await repo.list());
    },

    async snapshot(label) {
      await autosave.flush();
      const id = openId();
      if (id) await repo.snapshot(id, label);
    },

    stop() {
      if (stopped) return;
      stopped = true;
      for (const c of cleanups.splice(0).reverse()) c();
      mirror?.dispose();
      mirror = null;
      library.getState().reset(objectUrls?.revoke);
      autosave.dispose();
      repo.close();
      setBackend(previousBackend);
      if (current === session) setCurrent(null);
    },
  };

  // ---- the folder mirror (§5.5.4)

  let mirror: FolderMirror | null = null;
  const startMirror = (): void => {
    if (mirror || stopped || !deps.mirror) return;
    const m = createFolderMirror({
      repo,
      api: deps.mirror.api ?? createFolderApi(),
      locks: deps.mirror.locks,
      timers: deps.mirror.timers ?? deps.timers,
      debounceMs: deps.mirror.debounceMs,
      newId: deps.mirror.newId,
    });
    mirror = m;
    let seen: MirrorState = m.state();
    let errorShown = false;
    library.getState().setMirror(seen);
    cleanups.push(
      m.subscribe((state) => {
        library.getState().setMirror(state);
        for (const kept of state.keptBoth.slice(seen.keptBoth.length)) {
          notify.info(`“${kept.name}” was changed both here and in the projects folder. Both are kept: the folder’s version is now “${kept.copyName}”.`, {
            key: `mirror-kept-${kept.id}`,
            timeoutMs: 0,
          });
        }
        if (state.status === 'idle') errorShown = false;
        if (state.status === 'error' && !errorShown) {
          errorShown = true;
          notify.warn(`Couldn’t copy to the projects folder: ${state.lastError ?? 'no answer'}. Your projects are still saved in this browser.`, { key: 'mirror-error' });
        }
        seen = state;
      }),
    );
    void ready.then(() => m.reconcile()).catch(() => {});
  };
  if (deps.mirror) {
    if (deps.mirror.whenCapable) {
      if (app.getState().capabilities.folderMirror === true) startMirror();
      else
        cleanups.push(
          app.subscribe((s) => {
            if (s.capabilities.folderMirror === true) startMirror();
          }),
        );
    } else {
      startMirror();
    }
  }

  // ---- preferences (the `settings` store; appStore.hydratePrefs)

  // Every change is written synchronously to `localStorage` first (a journal, like the unload journal of
  // documents: an IndexedDB write started just before a reload may never land), then to the `settings` store.
  // At start the journal, when there is one, is the newest copy; otherwise the stored one; otherwise what the
  // page started with (main.tsx read the theme back).
  const prefsKey = deps.prefsKey === undefined ? null : deps.prefsKey;
  if (prefsKey !== null) {
    const journalKey = `${PREFS_JOURNAL_PREFIX}${prefsKey}`;
    const readJournal = (): unknown => {
      try {
        const text = journal?.getItem(journalKey);
        return text ? (JSON.parse(text) as unknown) : undefined;
      } catch {
        return undefined;
      }
    };
    const writeJournal = (prefs: unknown): void => {
      try {
        journal?.setItem(journalKey, JSON.stringify(prefs));
      } catch {
        // storage refused: the settings store still gets it
      }
    };
    void (async () => {
      const stored = await repo.getSetting(prefsKey).catch(() => undefined);
      if (stopped) return;
      const latest = readJournal() ?? stored;
      app.getState().hydratePrefs(latest === undefined ? app.getState().prefs : latest);
      const hydrated = app.getState().prefs;
      writeJournal(hydrated);
      void repo.putSetting(prefsKey, hydrated).catch(() => {});
      cleanups.push(
        app.subscribe((s, prev) => {
          if (!s.prefsHydrated || s.prefs === prev.prefs) return;
          writeJournal(s.prefs);
          void repo.putSetting(prefsKey, s.prefs).catch(() => {});
        }),
      );
    })();
  }

  setBackend(backend);
  if (deps.install) setCurrent(session);
  void session.refreshLibrary().catch((error: unknown) => {
    app.getState().setLibrary([]);
    notify.error(`Couldn’t read your saved projects: ${error instanceof Error ? error.message : String(error)}`);
  });
  void session.refreshTrash();
  return session;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The `settings` key of the preferences. */
export const PREFS_KEY = 'prefs';
/** `localStorage` key prefix of the preferences' synchronous copy. */
export const PREFS_JOURNAL_PREFIX = 'cpg.prefs.';

/** A channel for browsers without BroadcastChannel: talks to nobody. */
function silentChannel(): ChannelLike {
  return { postMessage() {}, onmessage: null, close() {} };
}

/**
 * Starts persistence with the browser's IndexedDB, Web Locks and BroadcastChannel, once per page. Does nothing
 * where there is no IndexedDB (node, happy-dom tests) — the shell's memory backend stays then.
 */
export function autoStartPersistence(): PersistenceSession | null {
  if (current) return current;
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const idb = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return null;
  const locks = (navigator as { locks?: LockManagerLike | null }).locks ?? createLocalLocks();
  const channel = typeof BroadcastChannel === 'function' ? (name: string) => new BroadcastChannel(name) as unknown as ChannelLike : silentChannel;
  return startPersistence({
    repo: createPersistRepository({ idb, locks, channel }),
    install: true,
    startup: true,
    mirror: { locks, whenCapable: true },
    prefsKey: PREFS_KEY,
  });
}
