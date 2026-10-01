// Track T8 — "Restore from folder or backup" (DESIGN.md §5.7, §5.5.4, F7): one dialog with three sources —
// the projects folder (projects this browser does not have, and ones changed in the folder), the dated backups
// next to it, and a `.crochet.json` file. Nothing here overwrites a project: restores import (an id that exists
// becomes a copy), "Load folder version" asks first and snapshots the browser's version.
//
// Results are shown inside the dialog (a toast would sit under the modal backdrop), and focus moves to them, so
// it never falls out of the dialog when a row goes away.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { formatGB, parseBackupFolderName } from '../../core/persist/backups';
import type { BackupSummary, FolderProjectEntry, FolderStatus } from '../../core/persist/folderProtocol';
import type { FolderMirror } from '../../core/persist/folderClient';
import type { ImportOutcome } from '../../core/persist/repo';
import { useAppStore } from '../../state/appStore';
import { useLibrary } from '../../state/slices/library';
import { Badge } from '../common/Badge';
import { Banner } from '../common/Banner';
import { Button } from '../common/Button';
import { Dialog } from '../common/Dialog';
import { DropZone } from '../common/DropZone';
import { EmptyState } from '../common/EmptyState';
import { Icon } from '../common/Icon';
import { Spinner } from '../common/Progress';
import { TabPanel, Tabs } from '../common/Tabs';
import { formatRelativeTime } from '../shell/relativeTime';

export type RestoreSource = 'folder' | 'backups' | 'file';

export interface RestoreDialogProps {
  open: boolean;
  onClose(): void;
  source: RestoreSource;
  onSource(source: RestoreSource): void;
  /** The running mirror, or null (the folder is not connected here). */
  mirror: FolderMirror | null;
  /** Imports a `.crochet.json` (null: saving is not available in this browser). */
  importFile: ((file: File) => Promise<ImportOutcome | null>) | null;
  /** Opens a project after a restore. */
  onOpen(id: string): void;
}

const ID_BASE = 'lib-restore';

/** What the dialog says after an action. */
interface Notice {
  tone: 'success' | 'info' | 'danger';
  text: string;
  /** A project to offer "Open" for. */
  openId?: string;
}
type Report = (n: Notice) => void;

const whenOf = (at: Date | string): string => {
  const d = typeof at === 'string' ? new Date(at) : at;
  if (!Number.isFinite(d.getTime())) return String(at);
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const modeLabel = (mode: '2d' | '3d'): string => (mode === '2d' ? '2D chart' : '3D toy');
const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

function outcomeNotice(o: ImportOutcome): Notice {
  if (o.status === 'already-present') return { tone: 'info', text: `“${o.name}” is already in your library.`, openId: o.id };
  if (o.status === 'imported-as-copy') return { tone: 'success', text: `Restored as “${o.name}”, next to the project you already have.`, openId: o.id };
  return { tone: 'success', text: `Restored “${o.name}”.`, openId: o.id };
}

function NotConnected() {
  return (
    <EmptyState icon="folder" title="The projects folder isn’t connected here" variant="panel" size="sm">
      This copy of the app doesn’t copy projects to a folder on your computer, so there are no folder copies or backups to restore from here. Your projects are saved in this
      browser, and you can still restore one from a <strong>.crochet.json</strong> project file.
    </EmptyState>
  );
}

interface RowEntry {
  id: string;
  name: string;
  mode: '2d' | '3d';
  updatedAt: string;
}

function ProjectRow({ entry, actions, note }: { entry: RowEntry; actions: ReactNode; note?: ReactNode }) {
  return (
    <li className="lib-row" data-project-id={entry.id}>
      <span className="lib-row__icon" aria-hidden="true">
        <Icon name={entry.mode === '2d' ? 'chart' : 'cube'} size={16} />
      </span>
      <span className="lib-row__text">
        <span className="lib-row__name" title={entry.name}>
          {entry.name || 'Untitled project'}
        </span>
        <span className="lib-row__meta">
          {note ?? (
            <>
              {modeLabel(entry.mode)}
              {entry.updatedAt ? ` · Edited ${formatRelativeTime(entry.updatedAt)}` : ''}
            </>
          )}
        </span>
      </span>
      <span className="lib-row__actions">{actions}</span>
    </li>
  );
}

function lastBackupText(folder: FolderStatus | null): string | null {
  const run = folder?.lastBackup;
  if (!run) return null;
  switch (run.status) {
    case 'created':
      return `Backed up ${formatRelativeTime(run.at)}`;
    case 'unchanged': {
      const at = parseBackupFolderName(run.newest);
      return at ? `Last backup ${whenOf(at)} — nothing changed since` : 'Nothing changed since the last backup';
    }
    case 'skipped-low-space':
      return 'Backups paused: the disk is nearly full';
    case 'failed':
      return 'The last backup failed — see the server’s console';
    case 'empty':
      return null;
  }
}

function FolderPanel({ mirror, report }: { mirror: FolderMirror; report: Report }) {
  const state = useLibrary((s) => s.mirror);
  const library = useAppStore((s) => s.library);
  const [working, setWorking] = useState<string | null>(null);
  const [confirmLoad, setConfirmLoad] = useState<string | null>(null);
  const localName = (p: FolderProjectEntry): string => library?.find((s) => s.id === p.id)?.name ?? p.name;
  const run = async (key: string, action: () => Promise<Notice | null>) => {
    setWorking(key);
    try {
      const n = await action();
      if (n) report(n);
    } catch (error) {
      report({ tone: 'danger', text: messageOf(error) });
    } finally {
      setWorking(null);
    }
  };
  const folder = state.folder;
  const lastText = lastBackupText(folder);
  const rows = (list: FolderProjectEntry[], render: (p: FolderProjectEntry) => { actions: ReactNode; note?: ReactNode }, named?: (p: FolderProjectEntry) => string) => (
    <ul className="lib-box lib-rows">
      {list.map((p) => {
        const r = render(p);
        return <ProjectRow key={p.id} entry={{ ...p, name: named ? named(p) : p.name }} actions={r.actions} note={r.note} />;
      })}
    </ul>
  );
  return (
    <div className="lib-restore__panel">
      <div className="lib-folder">
        <Icon name="folder" size={18} className="lib-folder__icon" />
        <span className="lib-folder__path" title={folder?.folder}>
          {/* An isolated left-to-right run: the right-to-left box only moves the ellipsis to the start. */}
          <bdi dir="ltr">{folder?.folder ?? 'Projects folder'}</bdi>
        </span>
        <Button size="sm" variant="ghost" icon="refresh" loading={state.status === 'syncing'} onClick={() => void run('check', async () => (await mirror.reconcile(), null))}>
          Check again
        </Button>
        <span className="lib-folder__meta">{[folder?.freeBytes != null ? `${formatGB(folder.freeBytes)} free` : null, lastText].filter(Boolean).join(' · ')}</span>
      </div>
      {folder?.message ? (
        <Banner tone={folder.level === 'critical' ? 'danger' : 'warn'} title={folder.level === 'critical' ? 'Backups are paused' : 'The disk is getting full'}>
          {folder.message}
        </Banner>
      ) : null}
      {state.status === 'error' && state.lastError ? (
        <Banner tone="warn" title="Some projects couldn’t be compared with the folder">
          {state.lastError}
        </Banner>
      ) : null}
      {state.changedInFolder.length > 0 ? (
        <section className="lib-stack" aria-label="Changed in the projects folder">
          <h3 className="lib-section-title">Changed in the folder</h3>
          {rows(
            state.changedInFolder,
            (p) =>
              confirmLoad === p.id
                ? {
                    note: 'Replace this browser’s version with the folder’s? This browser’s version is kept as a snapshot.',
                    actions: (
                      <>
                        <Button
                          size="sm"
                          variant="primary"
                          loading={working === `load:${p.id}`}
                          onClick={() =>
                            void run(`load:${p.id}`, async () => {
                              await mirror.loadFolderVersion(p.id);
                              setConfirmLoad(null);
                              return { tone: 'success', text: `Loaded the folder’s version of “${localName(p)}”. This browser’s version is kept as a snapshot.`, openId: p.id };
                            })
                          }
                        >
                          Load it
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmLoad(null)}>
                          Cancel
                        </Button>
                      </>
                    ),
                  }
                : {
                    actions: (
                      <>
                        <Button size="sm" aria-label={`Load the folder version of ${localName(p)}`} onClick={() => setConfirmLoad(p.id)}>
                          Load folder version
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Keep both versions of ${localName(p)}`}
                          loading={working === `both:${p.id}`}
                          onClick={() =>
                            void run(`both:${p.id}`, async () => {
                              const kept = await mirror.keepBoth(p.id);
                              return { tone: 'success', text: `Kept both: the folder’s version is now “${kept.copyName}”.`, openId: kept.copyId };
                            })
                          }
                        >
                          Keep both
                        </Button>
                      </>
                    ),
                  },
            localName,
          )}
        </section>
      ) : null}
      <section className="lib-stack" aria-label="Only in the projects folder">
        <h3 className="lib-section-title">Only in the folder</h3>
        {state.status === 'starting' ? (
          <div className="lib-box lib-box__empty">
            <Spinner size={14} label="Reading the projects folder" />
          </div>
        ) : state.restorable.length === 0 ? (
          <p className="lib-box lib-box__empty">Every project in the folder is also in this browser.</p>
        ) : (
          rows(state.restorable, (p) => ({
            actions: (
              <Button
                size="sm"
                icon="download"
                loading={working === `restore:${p.id}`}
                aria-label={`Restore ${p.name}`}
                onClick={() => void run(`restore:${p.id}`, async () => outcomeNotice(await mirror.restoreFromFolder(p.id)))}
              >
                Restore
              </Button>
            ),
          }))
        )}
      </section>
    </div>
  );
}

function BackupsPanel({ mirror, report }: { mirror: FolderMirror; report: Report }) {
  const [backups, setBackups] = useState<BackupSummary[] | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    mirror.listBackups().then(
      (r) => {
        if (!live) return;
        setBackups(r.backups);
        setExpanded((e) => e ?? r.backups[0]?.name ?? null);
      },
      (error: unknown) => live && setFailed(messageOf(error)),
    );
    return () => {
      live = false;
    };
  }, [mirror]);
  if (failed) return <p className="lib-box lib-box__empty">Couldn’t read the backups: {failed}</p>;
  if (!backups)
    return (
      <div className="lib-box lib-box__empty">
        <Spinner size={14} label="Reading the backups" />
      </div>
    );
  if (backups.length === 0)
    return (
      <EmptyState icon="clock" title="No backups yet" variant="panel" size="sm">
        A backup is made each time the app’s server starts and something changed since the last one.
      </EmptyState>
    );
  return (
    <div className="lib-restore__panel">
      <p className="lib-backup__count">Backups are made when the app’s server starts. Restoring never replaces a project: one you already have comes back as a copy.</p>
      <ul className="lib-box">
        {backups.map((b) => {
          const open = expanded === b.name;
          const listId = `${ID_BASE}-backup-${b.name}`;
          return (
            <li key={b.name}>
              <button type="button" className="lib-backup__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setExpanded(open ? null : b.name)}>
                <Icon name="clock" size={16} />
                <span className="lib-backup__when">{whenOf(b.at)}</span>
                <span className="lib-backup__count">
                  {b.projects.length} project{b.projects.length === 1 ? '' : 's'}
                </span>
                <Icon name="chevron-down" size={16} className="lib-trash__chevron" />
              </button>
              {open ? (
                <ul className="lib-backup__projects" id={listId}>
                  {b.projects.map((p) => (
                    <ProjectRow
                      key={p.id}
                      entry={p}
                      actions={
                        <Button
                          size="sm"
                          icon="download"
                          loading={working === `${b.name}/${p.id}`}
                          aria-label={`Restore ${p.name} from the backup of ${whenOf(b.at)}`}
                          onClick={async () => {
                            setWorking(`${b.name}/${p.id}`);
                            try {
                              report(outcomeNotice(await mirror.restoreFromBackup(b.name, p.id)));
                            } catch (error) {
                              report({ tone: 'danger', text: `Couldn’t restore it: ${messageOf(error)}` });
                            } finally {
                              setWorking(null);
                            }
                          }}
                        >
                          Restore
                        </Button>
                      }
                    />
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FilePanel({ importFile, onOpen, report }: { importFile: RestoreDialogProps['importFile']; onOpen(id: string): void; report: Report }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="lib-restore__panel">
      <DropZone
        accept=".json,application/json"
        title="Drop a .crochet.json project file"
        hint="Made with Export on a project or a card. It is added next to your projects; nothing is replaced."
        icon="file"
        disabled={!importFile || busy}
        onReject={() => report({ tone: 'danger', text: 'That isn’t a project file. Project files end in .crochet.json.' })}
        onFiles={async ([file]) => {
          if (!importFile) return;
          setBusy(true);
          try {
            const outcome = await importFile(file);
            if (outcome) onOpen(outcome.id);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? <Spinner size={14} label="Importing" /> : null}
      </DropZone>
    </div>
  );
}

export function RestoreDialog({ open, onClose, source, onSource, mirror, importFile, onOpen }: RestoreDialogProps) {
  const restorable = useLibrary((s) => s.mirror.restorable.length + s.mirror.changedInFolder.length);
  const [notice, setNotice] = useState<Notice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  // A new result takes the focus (its row may have gone away), so focus never leaves the dialog.
  useEffect(() => {
    if (!notice) return;
    const el = noticeRef.current;
    (el?.querySelector<HTMLElement>('button') ?? el)?.focus();
  }, [notice]);
  // A result belongs to this visit of the dialog.
  const close = (): void => {
    setNotice(null);
    onClose();
  };
  const openProject = (id: string): void => {
    setNotice(null);
    onOpen(id);
  };
  const items = [
    {
      id: 'folder' as const,
      label: 'Projects folder',
      icon: 'folder' as const,
      ...(restorable > 0
        ? {
            badge: (
              <Badge tone="accent" size="sm" icon={null}>
                {restorable}
              </Badge>
            ),
          }
        : {}),
    },
    { id: 'backups' as const, label: 'Backups', icon: 'clock' as const },
    { id: 'file' as const, label: 'Project file', icon: 'file' as const },
  ];
  return (
    <Dialog
      open={open}
      onClose={close}
      size="lg"
      title="Restore a project"
      description="Bring back a project from the projects folder on this computer, from one of its backups, or from a project file."
      footer={
        <Button variant="secondary" onClick={close}>
          Done
        </Button>
      }
    >
      <div className="lib-restore">
        <Tabs
          ariaLabel="Where to restore from"
          items={items}
          value={source}
          onChange={(s) => {
            setNotice(null);
            onSource(s);
          }}
          idBase={ID_BASE}
        />
        {notice ? (
          <div ref={noticeRef} tabIndex={-1} className="lib-restore__notice">
            <Banner
              tone={notice.tone}
              actions={
                notice.openId ? (
                  <Button size="sm" onClick={() => openProject(notice.openId as string)}>
                    Open
                  </Button>
                ) : undefined
              }
              onDismiss={() => setNotice(null)}
            >
              {notice.text}
            </Banner>
          </div>
        ) : null}
        <TabPanel idBase={ID_BASE} id={source} className="lib-restore__panel">
          {source === 'file' ? (
            <FilePanel importFile={importFile} onOpen={openProject} report={setNotice} />
          ) : !mirror ? (
            <NotConnected />
          ) : source === 'folder' ? (
            <FolderPanel mirror={mirror} report={setNotice} />
          ) : (
            <BackupsPanel mirror={mirror} report={setNotice} />
          )}
        </TabPanel>
      </div>
    </Dialog>
  );
}
