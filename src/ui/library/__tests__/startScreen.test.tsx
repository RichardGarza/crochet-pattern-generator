// @vitest-environment happy-dom
// ui/library/StartScreen — the library of §5.7 on a real session (fake IndexedDB, fake locks): cards with
// thumbnail, name, mode, last change and the "waiting for Claude Design" badge; Duplicate, Export, Delete with a
// confirm; "Recently deleted" (restore, delete for good); "Restore from folder or backup" (folder, backups,
// file); folder notices; same-name cards told apart by id.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { blobOf, makeDoc, world, type World } from '../../../core/persist/__tests__/helpers';
import type { FolderApi } from '../../../core/persist/folderClient';
import type { FolderListing, FolderProjectEntry } from '../../../core/persist/folderProtocol';
import { appStore } from '../../../state/appStore';
import { libraryStore } from '../../../state/slices/library';
import type { ProjectDoc } from '../../../types/project';
import { startPersistence, type PersistenceSession } from '../persistence';
import { StartScreen } from '../StartScreen';

let session: PersistenceSession | null = null;
afterEach(() => {
  session?.stop();
  session = null;
  appStore.getState().setLibrary(null);
  appStore.getState().setCapabilities({ folderMirror: null });
  for (const t of appStore.getState().toasts) appStore.getState().dismissToast(t.id);
});

const toastTexts = (): string[] => appStore.getState().toasts.map((t) => t.message);

/** A folder API in memory: projects keyed by id with their doc text. */
function memoryFolder(projects: { doc: ProjectDoc }[] = []) {
  const docs = new Map(projects.map((p) => [p.doc.id, JSON.stringify(p.doc)]));
  const entry = (id: string, text: string): FolderProjectEntry => {
    const d = JSON.parse(text) as ProjectDoc;
    return { id, rev: d.rev, docSha256: `sha-${text.length}-${d.rev}-${d.name}`.padEnd(64, '0').slice(0, 64), updatedAt: d.updatedAt, name: d.name, mode: d.mode, bytes: text.length };
  };
  const api: FolderApi = {
    probe: async () => true,
    list: async (): Promise<FolderListing> => ({
      projects: [...docs].map(([id, text]) => entry(id, text)),
      damaged: [],
      status: { folder: '/tmp/cpg-test/projects', backupsFolder: '/tmp/cpg-test/Backups', freeBytes: 3.2e9, level: 'low', message: 'Only 3.2 GB free on this disk — backups stop below 2 GB.', lastBackup: null },
    }),
    getDoc: async (id) => (docs.has(id) ? { text: docs.get(id)!, sha256: entry(id, docs.get(id)!).docSha256 } : null),
    putDoc: async (id, text) => {
      docs.set(id, text);
      return { ok: true, sha256: entry(id, text).docSha256, written: true };
    },
    listAssets: async () => [],
    getAsset: async () => null,
    putAsset: async () => ({ ok: true, existed: false }),
    remove: async (id) => {
      docs.delete(id);
      return { ok: true, movedTo: null };
    },
    listBackups: async () => ({
      backups: [
        {
          name: '2026-09-30-0900',
          at: '2026-09-30T09:00:00.000Z',
          projects: [{ id: 'old', name: 'Old scarf', mode: '2d', updatedAt: '2026-09-29T09:00:00.000Z', rev: 4, docSha256: 'x'.repeat(64), assets: [] }],
        },
      ],
    }),
    getBackupDoc: async (_b, id) => (id === 'old' ? JSON.stringify({ ...makeDoc('old', 'picture', 'Old scarf'), rev: 4 }) : null),
    getBackupAsset: async () => null,
  };
  return { api, docs };
}

async function setup(o: { mirror?: FolderApi; docs?: ProjectDoc[] } = {}) {
  const w: World = world();
  const tab = w.tab({ queryLocks: async () => w.locks.query() });
  const downloads: { blob: Blob; name: string }[] = [];
  for (const doc of o.docs ?? []) {
    await tab.repo.create(doc);
    tab.repo.release(doc.id);
  }
  if (o.mirror) appStore.getState().setCapabilities({ folderMirror: true });
  session = startPersistence({
    repo: tab.repo,
    install: true,
    page: null,
    journal: null,
    timers: w.timers,
    download: (blob, name) => downloads.push({ blob, name }),
    objectUrls: { create: () => 'blob:test/thumb', revoke: () => {} },
    ...(o.mirror ? { mirror: { api: o.mirror, locks: tab.locks, timers: w.timers, whenCapable: true, newId: () => 'from-folder-1' } } : {}),
  });
  await session.ready;
  await session.refreshLibrary();
  return { w, tab, downloads };
}

const card = (name: string): HTMLElement => {
  const button = screen.getByRole('button', { name: new RegExp(`^${name}`) });
  return button.closest('li') as HTMLElement;
};

describe('StartScreen library', () => {
  it('shows cards with name, mode, last change, thumbnail and the "waiting for Claude Design" badge', async () => {
    const heart = makeDoc('p1', 'picture', 'Heart blanket');
    const bear = { ...makeDoc('p2', 'describe', 'Teddy'), qa: { awaiting: { since: '2026-10-01T10:00:00.000Z' } } } as unknown as ProjectDoc;
    const { tab } = await setup({ docs: [heart, bear] });
    const ref = await tab.repo.putAsset('p1', await blobOf(1, 2, 3, 4), 'image/png');
    await tab.repo.open('p1', 'edit');
    await tab.repo.save({ ...heart, thumbnail: ref }, new Map(), { baseRev: 1 });
    tab.repo.release('p1');
    render(<StartScreen />);
    await waitFor(() => expect(screen.getByText('2 projects')).toBeTruthy());
    const h = card('Heart blanket');
    expect(within(h).getByText('2D chart')).toBeTruthy();
    expect(within(h).getByText(/^Edited /)).toBeTruthy();
    await waitFor(() => expect(h.querySelector('img')?.getAttribute('src')).toBe('blob:test/thumb'));
    const t = card('Teddy');
    expect(within(t).getByText('3D toy')).toBeTruthy();
    expect(within(t).getByText('Waiting for Claude Design')).toBeTruthy();
    // Every card has its three actions, named after the project.
    for (const label of ['Duplicate Heart blanket', 'Export Heart blanket as a file', 'Delete Heart blanket']) expect(within(h).getByRole('button', { name: label })).toBeTruthy();
  });

  it('delete asks first, moves the project to Recently deleted (with Undo), and restore brings it back', async () => {
    await setup({ docs: [makeDoc('p1', 'picture', 'Heart'), makeDoc('p2', 'photos', 'Bear')] });
    render(<StartScreen />);
    await waitFor(() => expect(screen.getByText('2 projects')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Heart' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete “Heart”?')).toBeTruthy();
    expect(within(dialog).getByText(/Recently deleted/)).toBeTruthy();
    // Cancel keeps it.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: /^Heart/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Heart' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Heart/ })).toBeNull());
    expect(toastTexts()).toContain('Moved “Heart” to Recently deleted. It stays there for 30 days.');
    expect(appStore.getState().toasts.at(-1)?.action?.label).toBe('Undo');

    const toggle = await screen.findByRole('button', { name: /Recently deleted/ });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/30 days left/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Restore Heart' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Heart/ })).toBeTruthy());
    await waitFor(() => expect(screen.queryByRole('button', { name: /Recently deleted/ })).toBeNull());
  });

  it('Undo in the toast restores; delete for good asks first and removes it', async () => {
    const { tab } = await setup({ docs: [makeDoc('p1', 'picture', 'Heart'), makeDoc('p2', 'picture', 'Star')] });
    render(<StartScreen />);
    await waitFor(() => expect(screen.getByText('2 projects')).toBeTruthy());
    await act(async () => void (await session!.deleteProject('p1')));
    await act(async () => appStore.getState().toasts.at(-1)?.action?.run());
    await waitFor(() => expect(screen.getByRole('button', { name: /^Heart/ })).toBeTruthy());

    await act(async () => void (await session!.deleteProject('p2')));
    fireEvent.click(await screen.findByRole('button', { name: /Recently deleted/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Star for good' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete “Star” for good?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete for good' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Recently deleted/ })).toBeNull());
    expect(await tab.repo.peek('p2')).toBeUndefined();
  });

  it('refuses to delete a project another tab is editing, with a clear message', async () => {
    const { w } = await setup({ docs: [makeDoc('p1', 'picture', 'Heart')] });
    const other = w.tab();
    await other.repo.open('p1', 'edit');
    render(<StartScreen />);
    await waitFor(() => expect(screen.getByText('1 project')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Delete Heart' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(toastTexts()).toContain('“Heart” is open in another tab. Close it there, then delete it.'));
    expect(screen.getByRole('button', { name: /^Heart/ })).toBeTruthy();
  });

  it('duplicate adds a "(copy)" card; export downloads a .crochet.json', async () => {
    const { downloads } = await setup({ docs: [makeDoc('p1', 'picture', 'Heart')] });
    render(<StartScreen />);
    await waitFor(() => expect(screen.getByText('1 project')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate Heart' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /^Heart \(copy\)/ })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Export Heart as a file' }));
    await waitFor(() => expect(downloads).toHaveLength(1));
    expect(downloads[0].name).toBe('Heart.crochet.json');
    expect(JSON.parse(await downloads[0].blob.text())).toMatchObject({ format: 'crochet-project-file', project: { id: 'p1', name: 'Heart' } });
  });

  it('tells two projects with the same name apart by a short id', async () => {
    await setup({ docs: [makeDoc('aaaa1111', 'picture', 'Bear'), makeDoc('bbbb2222', 'picture', 'Bear'), makeDoc('c', 'picture', 'Fox')] });
    render(<StartScreen />);
    await waitFor(() => expect(screen.getByText('3 projects')).toBeTruthy());
    expect(screen.getByText('Bear · #aaaa')).toBeTruthy();
    expect(screen.getByText('Bear · #bbbb')).toBeTruthy();
    expect(screen.getByText('Fox')).toBeTruthy();
    // The actions name the project by its real name.
    expect(screen.getAllByRole('button', { name: 'Delete Bear' })).toHaveLength(2);
  });

  it('Restore without the folder: the file tab imports a .crochet.json; the folder tab explains', async () => {
    const { tab } = await setup({ docs: [makeDoc('p1', 'picture', 'Heart')] });
    const file = new File([await (await tab.repo.exportFile('p1')).text()], 'Heart.crochet.json', { type: 'application/json' });
    await tab.repo.remove('p1');
    await session!.refreshLibrary();
    render(<StartScreen />);
    fireEvent.click(screen.getByRole('button', { name: 'Restore from folder or backup' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /Project file/ }).getAttribute('aria-selected')).toBe('true');
    fireEvent.click(within(dialog).getByRole('tab', { name: /Projects folder/ }));
    expect(within(dialog).getByText('The projects folder isn’t connected here')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('tab', { name: /Project file/ }));
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    await waitFor(() => expect(toastTexts()).toContain('Imported “Heart”.'));
    expect((await tab.repo.list()).map((s) => s.id)).toEqual(['p1']);
    // The imported project opens.
    await waitFor(() => expect(window.location.hash).toBe('#/p/p1'));
    window.location.hash = '';
  });

  it('with the folder mirror: notices, restore from the folder, and from a backup', async () => {
    const elsewhere = { ...makeDoc('elsewhere', 'photos', 'Bunny'), rev: 3 };
    const folder = memoryFolder([{ doc: elsewhere }]);
    const { tab } = await setup({ mirror: folder.api, docs: [makeDoc('p1', 'picture', 'Heart')] });
    render(<StartScreen />);
    // The disk warning and the restore offer.
    await waitFor(() => expect(screen.getByText('The disk is getting full')).toBeTruthy());
    expect(screen.getByText('“Bunny” is in the projects folder but not in this browser')).toBeTruthy();
    expect(libraryStore.getState().mirror.status).toBe('idle');
    // This browser's project was mirrored.
    expect(folder.docs.has('p1')).toBe(true);

    fireEvent.click(screen.getAllByRole('button', { name: 'Review' })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('tab', { name: /Projects folder/ }).getAttribute('aria-selected')).toBe('true');
    expect(within(dialog).getByText('/tmp/cpg-test/projects')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Bunny' }));
    await waitFor(() => expect(toastTexts()).toContain('Restored “Bunny”.'));
    expect((await tab.repo.peek('elsewhere'))?.name).toBe('Bunny');
    await waitFor(() => expect(within(dialog).getByText('Every project in the folder is also in this browser.')).toBeTruthy());

    fireEvent.click(within(dialog).getByRole('tab', { name: /Backups/ }));
    await waitFor(() => expect(within(dialog).getByText('1 project')).toBeTruthy());
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore Old scarf from this backup' }));
    await waitFor(() => expect(toastTexts()).toContain('Restored “Old scarf”.'));
    expect((await tab.repo.peek('old'))?.name).toBe('Old scarf');
  });

  it('a project changed in the folder: "Load folder version" replaces this browser’s copy after a snapshot', async () => {
    const doc = makeDoc('p1', 'picture', 'Heart');
    const folder = memoryFolder();
    const { tab } = await setup({ mirror: folder.api, docs: [doc] });
    render(<StartScreen />);
    await waitFor(() => expect(folder.docs.has('p1')).toBe(true));
    await waitFor(() => expect(libraryStore.getState().mirror.status).toBe('idle'));
    // Edited in the folder (another browser), then the next start.
    folder.docs.set('p1', JSON.stringify({ ...JSON.parse(folder.docs.get('p1')!), name: 'Heart (edited elsewhere)', rev: 9 }));
    await act(async () => session!.mirror()!.reconcile());
    await waitFor(() => expect(screen.getByText('“Heart” changed in the projects folder')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Load folder version' }));
    await waitFor(async () => expect((await tab.repo.peek('p1'))?.name).toBe('Heart (edited elsewhere)'));
    expect((await tab.repo.getRevision('p1', 1))?.doc.name).toBe('Heart');
    await waitFor(() => expect(screen.queryByText('“Heart” changed in the projects folder')).toBeNull());
  });

  it('without a session (no IndexedDB) the restore button says why it is off and cards have no actions', async () => {
    appStore.getState().setLibrary([{ id: 'm1', name: 'In memory', mode: '2d', updatedAt: '2026-10-01T10:00:00.000Z' }]);
    render(<StartScreen />);
    const restore = screen.getByRole('button', { name: 'Restore from folder or backup' });
    expect(restore.getAttribute('aria-disabled')).toBe('true');
    expect(screen.queryByRole('button', { name: 'Delete In memory' })).toBeNull();
  });
});
