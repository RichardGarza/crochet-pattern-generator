// ui/library/persistence — what T8.2 adds to the session: a project in "Recently deleted" does not open; the
// start-up chores (purge after 30 days, then asset GC skipped while another tab edits) run after the journal and
// before any project opens; preferences are stored in the `settings` store; the folder mirror's outcomes reach
// the user; and the shell's "leave, then open" order never takes the next project's lock when the current one
// cannot be left (integration-s1 T8 task 6).
import { describe, expect, it } from 'vitest';
import { blobOf, makeDoc, settle, world } from '../../../core/persist/__tests__/helpers';
import type { FolderApi } from '../../../core/persist/folderClient';
import { lockName } from '../../../core/persist/locks';
import type { PersistRepository } from '../../../core/persist/repo';
import { DEFAULT_PREFS, appStore, createAppStore } from '../../../state/appStore';
import { createLibraryStore } from '../../../state/slices/library';
import { createProjectStore, projectStore } from '../../../state/projectStore';
import { openProject, projectBackend, type ProjectBackend } from '../../shell/projectSession';
import { startPersistence } from '../persistence';

const DAY = 24 * 60 * 60 * 1000;

function quietNotify() {
  const toasts: { kind: string; message: string }[] = [];
  const add = (kind: string) => (message: string) => (toasts.push({ kind, message }), 0);
  return { toasts, notify: { info: add('info'), success: add('success'), warn: add('warn'), error: add('error') } };
}

function start(repo: PersistRepository, o: Partial<Parameters<typeof startPersistence>[0]> = {}) {
  const { toasts, notify } = quietNotify();
  let backend: ProjectBackend | null = null;
  const app = o.app ?? createAppStore();
  const session = startPersistence({
    repo,
    store: createProjectStore(),
    app,
    library: createLibraryStore(),
    page: null,
    journal: null,
    notify,
    setBackend: (b) => (backend = b),
    getBackend: () => ({ kind: 'memory', create: async (d) => d, open: async () => null, leave: async () => {} }),
    banners: { show() {}, dismiss() {} },
    ...o,
  });
  return { session, toasts, app, backend: () => backend! };
}

describe('library session', () => {
  it('a project in "Recently deleted" does not open (its link shows "not here"); restored, it does', async () => {
    const w = world();
    const tab = w.tab();
    await tab.repo.create(makeDoc('p1'));
    tab.repo.release('p1');
    const s = start(tab.repo, { timers: w.timers });
    await s.session.ready;
    await s.session.deleteProject('p1');
    expect(await s.backend().open('p1')).toBeNull();
    expect(tab.repo.holdsLock('p1')).toBe(false);
    await s.session.restoreProject('p1');
    expect((await s.backend().open('p1'))?.doc.id).toBe('p1');
    s.session.stop();
  });

  it('start-up chores: purge after 30 days, then GC skipped while another tab edits; projects open after them', async () => {
    const w = world();
    const writer = w.tab();
    await writer.repo.create(makeDoc('old'));
    writer.repo.release('old');
    await writer.repo.trash('old');
    await writer.repo.create(makeDoc('open-elsewhere'));
    await writer.repo.putAsset('open-elsewhere', await blobOf(5, 5), 'image/png'); // unreferenced
    w.clock.now = new Date(w.clock.now.getTime() + 31 * DAY);

    const tab = w.tab({ queryLocks: async () => w.locks.query() });
    const calls: string[] = [];
    const repo: PersistRepository = {
      ...tab.repo,
      purgeTrash: async (o) => (calls.push('purge'), tab.repo.purgeTrash(o)),
      gcAssets: async (o) => {
        calls.push(`gc:${o?.skipWhileEditing ? 'skip-while-editing' : 'direct'}`);
        const r = await tab.repo.gcAssets(o);
        calls.push(`gc-result:${r.skipped ?? r.deleted.length}`);
        return r;
      },
      open: async (id, mode) => (calls.push(`open:${id}`), tab.repo.open(id, mode)),
    };
    const s = start(repo, { timers: w.timers, startup: true });
    const opening = s.backend().open('old');
    await s.session.ready;
    expect(await opening).toBeNull(); // purged before it could open
    expect(calls.slice(0, 3)).toEqual(['purge', 'gc:skip-while-editing', 'gc-result:editing-elsewhere']);
    expect(await tab.repo.peek('old')).toBeUndefined();
    s.session.stop();

    // The other tab closes: the next start collects.
    writer.repo.release('open-elsewhere');
    const again = w.tab({ queryLocks: async () => w.locks.query() });
    const s2 = start(again.repo, { timers: w.timers, startup: true });
    await s2.session.ready;
    await settle();
    expect(await again.repo.gcAssets({ skipWhileEditing: true })).toEqual({ deleted: [] }); // already collected at start
    s2.session.stop();
  });

  it('stores the preferences: the first start keeps the page’s prefs, later starts read them back', async () => {
    const w = world();
    const tab = w.tab();
    const app = createAppStore();
    app.getState().setPrefs({ theme: 'dark' });
    const s = start(tab.repo, { app, prefsKey: 'prefs', timers: w.timers });
    await settle();
    expect(app.getState().prefsHydrated).toBe(true);
    expect(app.getState().prefs.theme).toBe('dark');
    expect(await tab.repo.getSetting('prefs')).toMatchObject({ theme: 'dark' });
    app.getState().setPrefs({ units: 'cm' });
    await settle();
    expect(await tab.repo.getSetting('prefs')).toMatchObject({ units: 'cm', theme: 'dark' });
    s.session.stop();

    const app2 = createAppStore();
    expect(app2.getState().prefs).toEqual(DEFAULT_PREFS);
    const s2 = start(w.tab().repo, { app: app2, prefsKey: 'prefs', timers: w.timers });
    await settle();
    expect(app2.getState().prefs).toMatchObject({ units: 'cm', theme: 'dark' });
    s2.session.stop();
  });

  it('the folder mirror starts once the probe says on, and a failing folder warns once until it works again', async () => {
    const w = world();
    const tab = w.tab();
    await tab.repo.create(makeDoc('p1', 'picture', 'Bear'));
    tab.repo.release('p1');
    let fail = false;
    let lists = 0;
    const api: FolderApi = {
      probe: async () => true,
      list: async () => {
        lists++;
        if (fail) throw new TypeError('Failed to fetch');
        return { projects: [], damaged: [], status: { folder: '/f', backupsFolder: '/b', freeBytes: 50e9, level: 'ok', message: null, lastBackup: null } };
      },
      getDoc: async () => null,
      putDoc: async () => ({ ok: true, sha256: 'a'.repeat(64), written: true }),
      listAssets: async () => [],
      getAsset: async () => null,
      putAsset: async () => ({ ok: true, existed: false }),
      remove: async () => ({ ok: true, movedTo: null }),
      listBackups: async () => ({ backups: [] }),
      getBackupDoc: async () => null,
      getBackupAsset: async () => null,
    };
    const app = createAppStore();
    const s = start(tab.repo, { app, timers: w.timers, mirror: { api, whenCapable: true } });
    await s.session.ready;
    await settle();
    expect(s.session.mirror()).toBeNull(); // the probe has not answered yet
    app.getState().setCapabilities({ folderMirror: true });
    await settle();
    expect(s.session.mirror()).not.toBeNull();
    expect(lists).toBe(1);
    expect(await tab.repo.getMeta('sync:p1')).toMatchObject({ lastSyncedRev: 1 });
    fail = true;
    await s.session.mirror()!.reconcile().catch(() => {});
    await s.session.mirror()!.reconcile().catch(() => {});
    expect(s.toasts.filter((t) => t.message.startsWith('Couldn’t copy to the projects folder'))).toHaveLength(1);
    fail = false;
    await s.session.mirror()!.reconcile();
    fail = true;
    await s.session.mirror()!.reconcile().catch(() => {});
    expect(s.toasts.filter((t) => t.message.startsWith('Couldn’t copy to the projects folder'))).toHaveLength(2);
    s.session.stop();
  });

  it('opening B while A cannot be left (its changes are not saved) takes no lock on B and keeps A open', async () => {
    const w = world();
    const tab = w.tab();
    await tab.repo.create(makeDoc('A', 'picture', 'A'));
    await tab.repo.create(makeDoc('B', 'picture', 'B'));
    tab.repo.release('B');
    // Saving fails, so A can never be left with its changes saved.
    const repo: PersistRepository = { ...tab.repo, save: async () => Promise.reject(new Error('disk full')) };
    const { notify } = quietNotify();
    const before = projectBackend();
    const session = startPersistence({ repo, page: null, journal: null, notify, timers: w.timers, autosave: { retryDelaysMs: [60_000] }, banners: { show() {}, dismiss() {} } });
    try {
      expect(await openProject('A')).toBe(true);
      projectStore.getState().update('Rename project', (d) => void (d.name = 'A, edited'));
      await expect(openProject('B')).rejects.toThrow(/aren’t saved yet/);
      expect(w.locks.isHeld(lockName('B'))).toBe(false);
      expect(projectStore.getState().doc?.id).toBe('A');
      expect(tab.repo.holdsLock('A')).toBe(true);
    } finally {
      projectStore.getState().close({ discardUnsaved: true });
      session.stop();
      expect(projectBackend()).toBe(before);
      void appStore;
    }
  });
});
