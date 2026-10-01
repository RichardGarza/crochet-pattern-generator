// Track T8 — "Restore from folder or backup" (DESIGN.md §5.7, §5.5.4, F7): one dialog with three sources —
// the projects folder (projects this browser does not have, and ones changed in the folder), the dated backups
// next to it, and a `.crochet.json` file. Nothing here overwrites a project: restores import (an id that exists
// becomes a copy), "Load the folder version" snapshots the browser's version first.
import { useEffect, useState, type ReactNode } from 'react';
import { formatGB } from '../../core/persist/backups';
import type { BackupSummary, FolderProjectEntry } from '../../core/persist/folderProtocol';
import type { FolderMirror } from '../../core/persist/folderClient';
import type { ImportOutcome } from '../../core/persist/repo';
import { useLibrary } from '../../state/slices/library';
import { notify } from '../../app/toasts';
import { Badge } from '../common/Badge';
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

const whenOf = (iso: string): string => {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

const modeLabel = (mode: '2d' | '3d'): string => (mode === '2d' ? '2D chart' : '3D toy');

function outcomeToast(o: ImportOutcome, open: (id: string) => void): void {
  const action = { label: 'Open', run: () => open(o.id) };
  if (o.status === 'already-present') notify.info(`“${o.name}” is already in your library.`, { key: 'library-restore', action });
  else if (o.status === 'imported-as-copy') notify.success(`Restored as “${o.name}”, next to the project you already have.`, { key: 'library-restore', action });
  else notify.success(`Restored “${o.name}”.`, { key: 'library-restore', action });
}

function NotConnected() {
  return (
    <EmptyState icon="folder" title="The projects folder isn’t connected here" variant="panel" size="sm">
      Projects are copied to a folder on this computer — with dated backups — only when the app runs from its own project folder. Here they are saved in this browser.
      You can still restore a project from a <strong>.crochet.json</strong> file.
    </EmptyState>
  );
}

function ProjectRow({ entry, actions }: { entry: { id: string; name: string; mode: '2d' | '3d'; updatedAt: string }; actions: ReactNode }) {
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
          {modeLabel(entry.mode)}
          {entry.updatedAt ? ` · Edited ${formatRelativeTime(entry.updatedAt)}` : ''}
        </span>
      </span>
      <span className="lib-row__actions">{actions}</span>
    </li>
  );
}

function FolderPanel({ mirror, onOpen }: { mirror: FolderMirror; onOpen(id: string): void }) {
  const state = useLibrary((s) => s.mirror);
  const [working, setWorking] = useState<string | null>(null);
  const run = async (key: string, action: () => Promise<void>) => {
    setWorking(key);
    try {
      await action();
    } catch (error) {
      notify.error(error instanceof Error ? error.message : String(error));
    } finally {
      setWorking(null);
    }
  };
  const folder = state.folder;
  const last = folder?.lastBackup;
  const lastText =
    !last || last.status === 'empty'
      ? 'No backups yet'
      : last.status === 'created'
        ? `Backed up ${formatRelativeTime(last.at)}`
        : last.status === 'unchanged'
          ? 'Backed up — nothing changed since the last backup'
          : last.status === 'skipped-low-space'
            ? 'Backups paused: the disk is nearly full'
            : 'The last backup failed';
  const rows = (list: FolderProjectEntry[], render: (p: FolderProjectEntry) => ReactNode) => (
    <ul className="lib-box lib-rows">
      {list.map((p) => (
        <ProjectRow key={p.id} entry={p} actions={render(p)} />
      ))}
    </ul>
  );
  return (
    <div className="lib-restore__panel">
      <div className="lib-folder">
        <Icon name="folder" size={18} className="lib-folder__icon" />
        <span className="lib-folder__path" title={folder?.folder}>
          {folder?.folder ?? 'Projects folder'}
        </span>
        <Button size="sm" variant="ghost" icon="refresh" loading={state.status === 'syncing'} onClick={() => void run('check', () => mirror.reconcile())}>
          Check again
        </Button>
        <span className="lib-folder__meta">
          {folder?.freeBytes != null ? `${formatGB(folder.freeBytes)} free · ` : ''}
          {lastText}
        </span>
      </div>
      {folder?.message ? (
        <Badge tone={folder.level === 'critical' ? 'danger' : 'warn'} size="md">
          {folder.message}
        </Badge>
      ) : null}
      {state.changedInFolder.length > 0 ? (
        <section className="lib-stack" aria-label="Changed in the projects folder">
          <h3 className="lib-section-title">Changed in the folder</h3>
          {rows(state.changedInFolder, (p) => (
            <>
              <Button size="sm" loading={working === `load:${p.id}`} onClick={() => void run(`load:${p.id}`, () => mirror.loadFolderVersion(p.id))}>
                Load folder version
              </Button>
              <Button size="sm" variant="ghost" loading={working === `both:${p.id}`} onClick={() => void run(`both:${p.id}`, async () => void (await mirror.keepBoth(p.id)))}>
                Keep both
              </Button>
            </>
          ))}
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
          rows(state.restorable, (p) => (
            <Button
              size="sm"
              icon="download"
              loading={working === `restore:${p.id}`}
              aria-label={`Restore ${p.name}`}
              onClick={() =>
                void run(`restore:${p.id}`, async () => {
                  outcomeToast(await mirror.restoreFromFolder(p.id), onOpen);
                })
              }
            >
              Restore
            </Button>
          ))
        )}
      </section>
    </div>
  );
}

function BackupsPanel({ mirror, onOpen }: { mirror: FolderMirror; onOpen(id: string): void }) {
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
      (error: unknown) => live && setFailed(error instanceof Error ? error.message : String(error)),
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
                          aria-label={`Restore ${p.name} from this backup`}
                          onClick={async () => {
                            setWorking(`${b.name}/${p.id}`);
                            try {
                              outcomeToast(await mirror.restoreFromBackup(b.name, p.id), onOpen);
                            } catch (error) {
                              notify.error(`Couldn’t restore it: ${error instanceof Error ? error.message : String(error)}`);
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

function FilePanel({ importFile, onOpen }: { importFile: RestoreDialogProps['importFile']; onOpen(id: string): void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="lib-restore__panel">
      <DropZone
        accept=".json,application/json"
        title="Drop a .crochet.json project file"
        hint="Made with Export on a project or a card. It is added next to your projects; nothing is replaced."
        icon="file"
        disabled={!importFile || busy}
        onReject={() => notify.error('That isn’t a project file. Project files end in .crochet.json.')}
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
  const items = [
    { id: 'folder' as const, label: 'Projects folder', icon: 'folder' as const, ...(restorable > 0 ? { badge: <Badge tone="accent" size="sm" icon={null}>{restorable}</Badge> } : {}) },
    { id: 'backups' as const, label: 'Backups', icon: 'clock' as const },
    { id: 'file' as const, label: 'Project file', icon: 'file' as const },
  ];
  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="Restore a project"
      description="Bring back a project from the projects folder on this computer, from one of its backups, or from a project file."
      footer={
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="lib-restore">
        <Tabs ariaLabel="Where to restore from" items={items} value={source} onChange={onSource} idBase={ID_BASE} />
        <TabPanel idBase={ID_BASE} id={source} className="lib-restore__panel">
          {source === 'file' ? (
            <FilePanel importFile={importFile} onOpen={onOpen} />
          ) : !mirror ? (
            <NotConnected />
          ) : source === 'folder' ? (
            <FolderPanel mirror={mirror} onOpen={onOpen} />
          ) : (
            <BackupsPanel mirror={mirror} onOpen={onOpen} />
          )}
        </TabPanel>
      </div>
    </Dialog>
  );
}
