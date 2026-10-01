// ui/library/persistence — the session that wires the repository and the autosave into the app: the
// ProjectBackend seam, the read-only / hand-over / take-over banners, conflict copies, the upgrade banner,
// flushes on page events, and "Export a backup" (DESIGN.md §5.5.2, §6.3 T8 acceptance). Two "tabs" share one
// fake IndexedDB, one fake lock manager and one fake channel hub; each has its own stores.
import { describe, expect, it } from 'vitest';
import { createAppStore, type Route } from '../../../state/appStore';
import { createProjectStore } from '../../../state/projectStore';
import { parseProjectFile } from '../../../core/persist/fileFormat';
import type { PersistRepository } from '../../../core/persist/repo';
import type { ProjectBackend } from '../../shell/projectSession';
import type { ProjectBanner } from '../../shell/banners';
import { makeDoc, manualTimers, settle, waitFor, world, type World } from '../../../core/persist/__tests__/helpers';
import { BANNER, startPersistence } from '../persistence';

interface FakePage {
  document: EventTarget & { visibilityState: DocumentVisibilityState };
  window: EventTarget;
  hide(): void;
}

function fakePage(): FakePage {
  const document = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState });
  const window = new EventTarget();
  return {
    document,
    window,
    hide() {
      document.visibilityState = 'hidden';
      document.dispatchEvent(new Event('visibilitychange'));
    },
  };
}

function sessionTab(
  w: World,
  o: { name?: string; wrap?: (r: PersistRepository) => PersistRepository; channel?: 'deaf'; dbVersion?: number; frozenClock?: boolean } = {},
) {
  // A frozen tab's timers never run (its own clock, never advanced).
  const timers = o.frozenClock ? manualTimers() : w.timers;
  const tab = w.tab({
    timers,
    ...(o.name ? { name: o.name } : {}),
    ...(o.channel === 'deaf' ? { channel: () => ({ postMessage() {}, onmessage: null, close() {} }) } : {}),
    ...(o.dbVersion ? { dbVersion: o.dbVersion } : {}),
  });
  const repo = o.wrap ? o.wrap(tab.repo) : tab.repo;
  const store = createProjectStore({ now: () => new Date(w.clock.now) });
  const app = createAppStore();
  const banners = new Map<string, ProjectBanner>();
  const routes: { route: Route; replace: boolean }[] = [];
  const toasts: { kind: string; message: string }[] = [];
  const downloads: { blob: Blob; name: string }[] = [];
  const opened: string[] = [];
  let backend: ProjectBackend | null = null;
  const page = fakePage();
  const session = startPersistence({
    repo,
    store,
    app,
    timers,
    now: () => new Date(w.clock.now),
    page: page as unknown as NonNullable<Parameters<typeof startPersistence>[0]['page']>,
    banners: { show: (b) => banners.set(b.id, b), dismiss: (id) => banners.delete(id) },
    navigate: (route, nav) => {
      routes.push({ route, replace: !!nav?.replace });
      app.getState().setRoute(route);
    },
    notify: {
      info: (message) => (toasts.push({ kind: 'info', message }), 0),
      success: (message) => (toasts.push({ kind: 'success', message }), 0),
      warn: (message) => (toasts.push({ kind: 'warn', message }), 0),
      error: (message) => (toasts.push({ kind: 'error', message }), 0),
    },
    download: (blob, name) => downloads.push({ blob, name }),
    openTab: (url) => opened.push(url),
    setBackend: (b) => (backend = b),
    getBackend: () => ({ kind: 'memory', create: async (d) => d, open: async () => null, leave: async () => {} }),
  });
  // What the shell's projectSession does with the backend (open → projectStore.open; leave → close).
  const openProject = async (id: string): Promise<boolean> => {
    const found = await backend!.open(id);
    if (!found) return false;
    store.getState().open(found.doc, { readOnly: found.readOnly, discardUnsaved: true });
    app.getState().setRoute({ screen: 'project', projectId: id, tab: 'source' });
    return true;
  };
  const leaveProject = async (): Promise<void> => {
    const s = store.getState();
    if (!s.doc) return;
    await backend!.leave(s.doc, s.assets);
    store.getState().close({ discardUnsaved: true });
  };
  const rename = (name: string) => store.getState().update('Rename project', (d) => void (d.name = name));
  const banner = (id: string) => banners.get(id);
  const action = (id: string, label: string) => {
    const a = banners.get(id)?.actions?.find((x) => x.label === label);
    if (!a) throw new Error(`no action "${label}" on banner ${id}: ${JSON.stringify(banners.get(id))}`);
    return a;
  };
  return { tab, repo, store, app, session, backend: () => backend!, page, routes, toasts, downloads, opened, openProject, leaveProject, rename, banner, action, banners };
}

describe('the repository behind the shell’s ProjectBackend seam', () => {
  it('create stores rev 1 and asks for persistent storage; open finds it; an unknown id is null; the library loads', async () => {
    const w = world();
    const a = sessionTab(w);
    expect(a.backend().kind).toBe('repository');
    const doc = await a.backend().create(makeDoc('p1'));
    expect(doc.rev).toBe(1);
    expect(await a.backend().open('nope')).toBeNull();
    expect(await a.openProject('p1')).toBe(true);
    expect(a.store.getState().readOnly).toBe(false);
    await a.session.refreshLibrary();
    expect(a.app.getState().library?.map((s) => s.id)).toEqual(['p1']);
  });

  it('leave flushes the pending save and lets go of the lock', async () => {
    const w = world();
    const a = sessionTab(w);
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.rename('Saved on leave');
    await a.leaveProject();
    expect((await a.repo.open('p1', 'read')).doc.name).toBe('Saved on leave');
    await w.locks.flush();
    expect(a.repo.holdsLock('p1')).toBe(false);
  });

  it('leave refuses (and keeps the changes) when the save fails', async () => {
    const w = world();
    let fail = false;
    const a = sessionTab(w, {
      wrap: (r) => ({ ...r, save: async (...args) => (fail ? Promise.reject(new Error('disk full')) : r.save(...args)) }),
    });
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    fail = true;
    a.rename('Do not lose me');
    await expect(a.leaveProject()).rejects.toThrow(/aren’t saved yet/);
    expect(a.store.getState().doc?.name).toBe('Do not lose me');
    expect(a.banner(BANNER.save)).toMatchObject({ kind: 'save-failed', tone: 'danger', title: 'Not saved' });
  });

  it('a failed leave gives back the lock of the project the shell was about to open', async () => {
    const w = world();
    let fail = false;
    const a = sessionTab(w, {
      wrap: (r) => ({ ...r, save: async (...args) => (fail ? Promise.reject(new Error('disk full')) : r.save(...args)) }),
    });
    await a.backend().create(makeDoc('p1'));
    await a.repo.create(makeDoc('p2'));
    a.repo.release('p2');
    await a.openProject('p1');
    fail = true;
    a.rename('unsaved');
    // The shell's openProject: backend.open(next) first, then leave(current), then projectStore.open(next).
    expect((await a.backend().open('p2'))?.readOnly).toBe(false);
    expect(a.repo.holdsLock('p2')).toBe(true);
    await expect(a.leaveProject()).rejects.toThrow(/aren’t saved yet/);
    expect(a.repo.holdsLock('p2')).toBe(false);
    expect(a.repo.holdsLock('p1')).toBe(true);
    expect(a.store.getState().doc?.id).toBe('p1');
  });

  it('saves update the library card, in this tab and in the others', async () => {
    const w = world();
    const a = sessionTab(w);
    const b = sessionTab(w);
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.rename('Renamed');
    await a.session.autosave.flush();
    await w.hub.flush();
    expect(a.app.getState().library?.find((s) => s.id === 'p1')?.name).toBe('Renamed');
    expect(b.app.getState().library?.find((s) => s.id === 'p1')?.name).toBe('Renamed');
  });
});

describe('autosave on page events (§5.5.2)', () => {
  it('debounce: 800 ms after the last change', async () => {
    const w = world();
    const a = sessionTab(w);
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.rename('x');
    await w.timers.advance(799);
    expect((await a.repo.open('p1', 'read')).doc.rev).toBe(1);
    await w.timers.advance(1);
    await a.session.autosave.flush();
    expect((await a.repo.open('p1', 'read')).doc).toMatchObject({ name: 'x', rev: 2 });
  });

  it('visibilitychange → hidden saves at once (no debounce wait)', async () => {
    const w = world();
    const a = sessionTab(w);
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.rename('hidden');
    a.page.hide();
    await waitFor(() => a.store.getState().saveStatus === 'saved');
    expect(w.timers.now()).toBe(0);
    expect((await a.repo.open('p1', 'read')).doc.name).toBe('hidden');
  });

  it('pagehide and going to the library save at once', async () => {
    const w = world();
    const a = sessionTab(w);
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.rename('pagehide');
    a.page.window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => a.store.getState().saveStatus === 'saved');
    a.rename('library');
    a.app.getState().setRoute({ screen: 'start' });
    await waitFor(() => a.store.getState().saveStatus === 'saved');
    expect((await a.repo.open('p1', 'read')).doc.name).toBe('library');
    expect(w.timers.now()).toBe(0);
  });

  it('beforeunload asks only when the changes cannot be saved', async () => {
    const w = world();
    let fail = false;
    const a = sessionTab(w, { wrap: (r) => ({ ...r, save: async (...args) => (fail ? Promise.reject(new Error('nope')) : r.save(...args)) }) });
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    const unload = () => {
      const e = new Event('beforeunload', { cancelable: true });
      a.page.window.dispatchEvent(e);
      return e.defaultPrevented;
    };
    a.rename('pending');
    expect(unload()).toBe(false); // a pending save: flushed, no prompt
    await waitFor(() => a.store.getState().saveStatus === 'saved');
    fail = true;
    a.rename('failing');
    await a.session.autosave.flush();
    expect(unload()).toBe(true);
  });
});

describe('two tabs: read-only, "Edit here instead", Take over (§5.5.2)', () => {
  it('the second tab opens read-only with the banner; "Edit here instead" hands over after the first tab flushes', async () => {
    const w = world();
    const a = sessionTab(w, { name: 'A' });
    const b = sessionTab(w, { name: 'B' });
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.rename('A’s last edit'); // not saved yet: the hand-over must flush it

    await b.openProject('p1');
    expect(b.store.getState().readOnly).toBe(true);
    expect(b.banner(BANNER.readOnly)).toMatchObject({ kind: 'read-only', title: 'Open in another tab' });

    await b.session.editHereInstead();
    expect(b.store.getState().readOnly).toBe(false);
    expect(b.store.getState().doc).toMatchObject({ name: 'A’s last edit', rev: 2 });
    expect(b.banner(BANNER.readOnly)).toBeUndefined();
    expect(b.repo.holdsLock('p1')).toBe(true);

    expect(a.store.getState().readOnly).toBe(true);
    expect(a.store.getState().saveStatus).toBe('read-only');
    expect(a.banner(BANNER.readOnly)).toMatchObject({ title: 'Editing moved to another tab' });
    // Edits in A are refused now; B saves normally.
    expect(a.store.getState().update('x', (d) => void (d.name = 'refused'))).toBe(false);
    b.rename('B edits');
    await b.session.autosave.flush();
    expect((await b.repo.open('p1', 'read')).doc).toMatchObject({ name: 'B edits', rev: 3 });

    // And back: A asks, B hands over.
    await a.session.editHereInstead();
    expect(a.store.getState()).toMatchObject({ readOnly: false, doc: { name: 'B edits', rev: 3 } });
    expect(b.store.getState().readOnly).toBe(true);
  });

  it('an unresponsive holder: after 5 s the banner offers Take over; taking over makes the old holder’s save a copy', async () => {
    const w = world();
    // A is frozen: it never hears "release", and its timers (the 800 ms autosave) never run.
    const a = sessionTab(w, { name: 'A', channel: 'deaf', frozenClock: true });
    const b = sessionTab(w, { name: 'B' });
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.rename('A’s unsaved edit');
    await b.openProject('p1');
    const asking = b.session.editHereInstead();
    await waitFor(() => b.banner(BANNER.readOnly)?.title === 'Asking the other tab to hand over…');
    expect(b.session.handOverState()).toBe('asking');
    await waitFor(() => w.timers.pending() === 1);
    await w.timers.advance(4999);
    expect(b.banner(BANNER.readOnly)?.actions ?? []).toEqual([]);
    await w.timers.advance(1);
    await asking;
    expect(b.session.handOverState()).toBe('no-answer');
    expect(b.banner(BANNER.readOnly)).toMatchObject({ title: 'The other tab isn’t answering' });
    expect(b.banner(BANNER.readOnly)?.actions?.map((x) => x.label)).toEqual(['Take over', 'Ask again']);

    b.action(BANNER.readOnly, 'Take over').run();
    await waitFor(() => b.store.getState().readOnly === false);
    expect(b.store.getState().doc?.rev).toBe(2);

    // A wakes up: its lock was stolen; it goes read-only and its pending edit lands in a copy.
    await waitFor(() => a.store.getState().readOnly === true || a.store.getState().doc?.id !== 'p1');
    await a.session.autosave.flush();
    expect(a.store.getState().doc).toMatchObject({ id: 'copy-1', name: 'A’s unsaved edit (copy, 12:00)' });
    expect(a.store.getState().readOnly).toBe(false);
    expect(a.routes.at(-1)).toEqual({ route: { screen: 'project', projectId: 'copy-1', tab: 'source' }, replace: true });
    expect(a.banner(BANNER.conflict)).toMatchObject({ kind: 'conflict-copy', title: 'Another tab saved a newer version of “A’s unsaved edit”' });
    expect(a.banner(BANNER.conflict)?.message).toBe('Your changes are safe in “A’s unsaved edit (copy, 12:00)”, which you are editing now.');
    expect(a.banner(BANNER.readOnly)).toBeUndefined();
    a.action(BANNER.conflict, 'Open the original').run();
    expect(a.opened).toEqual(['#/p/p1']);
    // The original is B's, untouched by A.
    expect((await b.repo.open('p1', 'read')).doc).toMatchObject({ name: 'Untitled chart', rev: 2 });
    expect((await b.repo.list()).map((s) => s.id).sort()).toEqual(['copy-1', 'p1']);
  });

  it('a stale tab: 10 edits after the conflict create exactly one copy, and the original reopens read-only', async () => {
    const w = world();
    const a = sessionTab(w, { name: 'A' });
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    // Another tab saves a newer version while A still believes it has rev 1 (e.g. after a dev-server restart).
    const other = w.tab({ name: 'other' });
    await other.repo.save({ ...makeDoc('p1'), name: 'Newer elsewhere' }, new Map(), { baseRev: 1 });
    for (let i = 0; i <= 10; i++) {
      a.rename(`edit ${i}`);
      await w.timers.advance(800);
      await a.session.autosave.flush();
    }
    const ids = (await a.repo.list()).map((s) => s.id).sort();
    expect(ids).toEqual(['copy-1', 'p1']);
    expect(a.store.getState().doc).toMatchObject({ id: 'copy-1', name: 'edit 10', rev: 11 });
    expect((await a.repo.open('p1', 'read')).doc.name).toBe('Newer elsewhere');
    // "Open the original": another tab holds it, so it opens read-only there.
    await other.repo.open('p1', 'edit');
    const c = sessionTab(w, { name: 'C' });
    await c.openProject('p1');
    expect(c.store.getState().readOnly).toBe(true);
    expect(c.banner(BANNER.readOnly)?.title).toBe('Open in another tab');
  });
});

describe('schema upgrades (§5.5.2)', () => {
  it('a blocking upgrade flushes, closes the database and shows the reload banner', async () => {
    const w = world();
    const a = sessionTab(w);
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.rename('saved before the update');
    const newer = w.tab({ dbVersion: 2 });
    expect((await newer.repo.open('p1', 'read')).doc.name).toBe('saved before the update');
    await waitFor(() => a.banner(BANNER.reload) !== undefined);
    expect(a.banner(BANNER.reload)).toMatchObject({ kind: 'reload-for-update', title: 'This tab was closed for an update' });
    expect(a.banner(BANNER.reload)?.actions?.map((x) => x.label)).toEqual(['Reload']);
    expect(a.store.getState().readOnly).toBe(true);
    expect(a.repo.isClosed()).toBe(true);
  });

  it('a blocked upgrade asks to close the other tabs, and the banner goes when it proceeds', async () => {
    const w = world();
    const old = sessionTab(w);
    await old.backend().create(makeDoc('p1'));
    // An old tab that ignores versionchange (a build without the handler).
    const stubborn = await new Promise<IDBDatabase>((resolve) => {
      const r = w.idb.open('crochet-pattern-generator');
      r.onsuccess = () => resolve(r.result);
    });
    old.session.stop();
    const b = sessionTab(w, { dbVersion: 2 });
    await waitFor(() => b.banner(BANNER.blocked) !== undefined);
    expect(b.banner(BANNER.blocked)?.message).toBe('Close the other Crochet Pattern Generator tabs to finish updating.');
    stubborn.close();
    await waitFor(() => b.banner(BANNER.blocked) === undefined);
  });
});

describe('save failures (§5.5.2: red chip, banner, Export a backup, retries)', () => {
  it('shows the banner, downloads a valid backup from memory, and clears it when a retry succeeds', async () => {
    const w = world();
    let fail = true;
    const a = sessionTab(w, { wrap: (r) => ({ ...r, save: async (...args) => (fail ? Promise.reject(new DOMException('full', 'QuotaExceededError')) : r.save(...args)) }) });
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    const ref = await a.store.getState().putAsset(new Uint8Array([1, 2, 3, 4]), 'image/png');
    a.store.getState().update('Thumbnail', (d) => void (d.thumbnail = ref));
    a.rename('Precious');
    await a.session.autosave.flush();
    expect(a.store.getState().saveStatus).toBe('error');
    expect(a.banner(BANNER.save)?.message).toMatch(/out of storage space/);

    a.action(BANNER.save, 'Export a backup').run();
    await waitFor(() => a.downloads.length === 1);
    expect(a.downloads[0].name).toBe('Precious.crochet.json');
    const parsed = await parseProjectFile(a.downloads[0].blob);
    expect(parsed.doc).toEqual(a.store.getState().doc);
    expect([...parsed.assets.keys()]).toEqual([ref.key]);

    fail = false;
    await w.timers.advance(1000);
    await a.session.autosave.flush();
    expect(a.store.getState().saveStatus).toBe('saved');
    expect(a.banner(BANNER.save)).toBeUndefined();
    expect(a.toasts.at(-1)).toEqual({ kind: 'success', message: 'Saved again — your changes are safe.' });
  });
});

describe('stop', () => {
  it('restores the previous backend, closes the repository and stops listening', async () => {
    const w = world();
    const a = sessionTab(w);
    await a.backend().create(makeDoc('p1'));
    await a.openProject('p1');
    a.session.stop();
    expect(a.repo.isClosed()).toBe(true);
    a.rename('after stop');
    a.page.hide();
    await settle();
    expect(w.timers.pending()).toBe(0);
  });
});
