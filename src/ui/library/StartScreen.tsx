// Track T8 — the start screen's library (DESIGN.md §5.7, F7): the shell's StartLayout (header, the five
// new-project cards — creation is the shell's) with "Your projects": cards with thumbnail, name, mode, last
// change and the "waiting for Claude Design" badge (the shell's ProjectGrid), each with Duplicate, Export and
// Delete (with a confirm; deleted projects stay 30 days in "Recently deleted"); notices from the projects
// folder; and "Restore from folder or backup". The `#/` route entry (app/tabs.ts).
//
// Projects are told apart by id and last change, never by name (§5.5.2): two cards with the same name show a
// short id after it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from '../../app/router';
import { useAppStore } from '../../state/appStore';
import { useLibrary } from '../../state/slices/library';
import type { ProjectSummary } from '../../types/project';
import { Banner } from '../common/Banner';
import { Button, IconButton } from '../common/Button';
import { ConfirmDialog } from '../common/Dialog';
import { EmptyState } from '../common/EmptyState';
import { Spinner } from '../common/Progress';
import { formatRelativeTime } from '../shell/relativeTime';
import { ProjectGrid } from '../shell/start/ProjectGrid';
import { StartLayout } from '../shell/start/StartLayout';
import { getPersistence } from './persistence';
import { RecentlyDeleted } from './RecentlyDeleted';
import { RestoreDialog, type RestoreSource } from './RestoreDialog';
import './library.css';

const open = (id: string): void => navigate({ screen: 'project', projectId: id });

/** Names shown on the cards: a short id after a name that two projects share. */
function withDistinctNames(list: readonly ProjectSummary[]): ProjectSummary[] {
  const count = new Map<string, number>();
  for (const s of list) count.set(s.name, (count.get(s.name) ?? 0) + 1);
  return list.map((s) => ((count.get(s.name) ?? 0) > 1 ? { ...s, name: `${s.name} · #${s.id.slice(0, 4)}` } : s));
}

/** `label`: the name as the card shows it (with " · #abcd" when two projects share it), for distinct accessible names. */
function CardActions({ summary, label, onDelete }: { summary: ProjectSummary; label: string; onDelete(s: ProjectSummary): void }) {
  const busy = useLibrary((s) => s.busy[summary.id]);
  const session = getPersistence();
  if (!session) return null;
  if (busy)
    return (
      <span className="lib-card-busy" data-busy="true">
        <Spinner size={12} />
        {busy}
      </span>
    );
  return (
    <>
      <IconButton icon="copy" size="sm" label={`Duplicate ${label}`} tooltipPlacement="bottom" onClick={() => void session.duplicateProject(summary.id)} />
      <IconButton icon="download" size="sm" label={`Export ${label} as a file`} tooltipPlacement="bottom" onClick={() => void session.exportProject(summary.id)} />
      <IconButton icon="trash" size="sm" label={`Delete ${label}`} tooltipPlacement="bottom" onClick={() => onDelete(summary)} />
    </>
  );
}

/** What the projects folder wants the user to know: projects changed there, restore offers, low disk space. */
function FolderNotices({ onReview }: { onReview(source: RestoreSource): void }) {
  const mirror = useLibrary((s) => s.mirror);
  const library = useAppStore((s) => s.library);
  // A project changed in the folder is named as this browser knows it.
  const localName = (id: string, fallback: string): string => library?.find((p) => p.id === id)?.name ?? fallback;
  const notices = [];
  if (mirror.folder?.message) {
    notices.push(
      <Banner key="disk" tone={mirror.folder.level === 'critical' ? 'danger' : 'warn'} title={mirror.folder.level === 'critical' ? 'Backups are paused' : 'The disk is getting full'}>
        {mirror.folder.message}
      </Banner>,
    );
  }
  if (mirror.changedInFolder.length > 0) {
    const n = mirror.changedInFolder.length;
    notices.push(
      <Banner
        key="changed"
        tone="info"
        icon="folder"
        title={n === 1 ? `“${localName(mirror.changedInFolder[0].id, mirror.changedInFolder[0].name)}” changed in the projects folder` : `${n} projects changed in the projects folder`}
        actions={
          <Button size="sm" onClick={() => onReview('folder')}>
            Review
          </Button>
        }
      >
        The folder has a newer version than this browser. Load it, or keep both.
      </Banner>,
    );
  }
  if (mirror.restorable.length > 0) {
    const n = mirror.restorable.length;
    notices.push(
      <Banner
        key="restore"
        tone="neutral"
        icon="folder"
        title={n === 1 ? `“${mirror.restorable[0].name || 'A project'}” is in the projects folder but not in this browser` : `${n} projects are in the projects folder but not in this browser`}
        actions={
          <Button size="sm" onClick={() => onReview('folder')}>
            Review
          </Button>
        }
      />,
    );
  }
  return notices.length > 0 ? <div className="lib-stack">{notices}</div> : null;
}

export function StartScreen() {
  const summaries = useAppStore((s) => s.library);
  const thumbs = useLibrary((s) => s.thumbs);
  const mirrorState = useLibrary((s) => s.mirror);
  const folderMirror = useAppStore((s) => s.capabilities.folderMirror);
  const session = getPersistence();
  const [deleting, setDeleting] = useState<ProjectSummary | null>(null);
  const [restore, setRestore] = useState<{ open: boolean; source: RestoreSource }>({ open: false, source: 'folder' });
  const restoreButton = useRef<HTMLButtonElement>(null);

  // Thumbnails: loaded once per asset key (content-addressed, so a cached URL never goes stale).
  useEffect(() => {
    if (!session || !summaries) return;
    for (const s of summaries) if (s.thumbnail) void session.loadThumbnail(s.thumbnail.key);
  }, [session, summaries]);

  const shown = useMemo(() => (summaries ? withDistinctNames(summaries) : null), [summaries]);
  const original = useMemo(() => new Map((summaries ?? []).map((s) => [s.id, s])), [summaries]);
  const mirrorOn = folderMirror === true && mirrorState.status !== 'off';
  const openRestore = (source: RestoreSource) => setRestore({ open: true, source });
  const count = summaries?.length ?? 0;

  return (
    <StartLayout
      libraryNote={summaries && count > 0 ? <span className="lib-note-count">{count === 1 ? '1 project' : `${count} projects`}</span> : null}
      libraryActions={
        <Button
          ref={restoreButton}
          variant="ghost"
          icon="refresh"
          size="sm"
          onClick={() => openRestore(mirrorOn ? 'folder' : 'file')}
          {...(session ? {} : { disabledReason: 'Saving isn’t available in this browser, so there is nothing to restore into.' })}
        >
          Restore from folder or backup
        </Button>
      }
      library={
        <div className="lib-stack">
          <FolderNotices onReview={openRestore} />
          <div className="lib-projects">
            <ProjectGrid
              summaries={shown}
              onOpen={open}
              thumbnailUrl={(s) => (s.thumbnail ? thumbs[s.thumbnail.key] : undefined)}
              renderActions={session ? (s) => <CardActions summary={original.get(s.id) ?? s} label={s.name} onDelete={setDeleting} /> : undefined}
              empty={
                <EmptyState
                  icon="yarn"
                  title="No projects yet"
                  variant="panel"
                  actions={
                    session ? (
                      <Button size="sm" variant="ghost" icon="refresh" onClick={() => openRestore(mirrorOn ? 'folder' : 'file')}>
                        Restore a project
                      </Button>
                    ) : undefined
                  }
                >
                  Pick one of the cards above to start. Your projects are saved in this browser as you work.
                </EmptyState>
              }
            />
          </div>
          {session ? (
            <RecentlyDeleted onRestore={(id) => session.restoreProject(id)} onDeleteForever={(id) => session.deleteForever(id)} mirrorOn={mirrorOn} />
          ) : null}
          <ConfirmDialog
            open={deleting !== null}
            title={deleting ? `Delete “${deleting.name}”?` : ''}
            confirmLabel="Delete"
            onCancel={() => setDeleting(null)}
            onConfirm={() => {
              const target = deleting;
              setDeleting(null);
              if (!target || !session) return;
              // The card (and its Delete button, where focus would return) goes away: focus the next card.
              const order = [...(summaries ?? [])].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((s) => s.id);
              const at = order.indexOf(target.id);
              const next = order[at + 1] ?? order[at - 1];
              void session.deleteProject(target.id).then((done) => {
                if (!done) return;
                requestAnimationFrame(() => {
                  const el = next ? document.querySelector<HTMLElement>(`.shell-project__open[data-project-id="${CSS.escape(next)}"]`) : null;
                  (el ?? document.getElementById('library-title')?.closest('section')?.querySelector<HTMLElement>('button'))?.focus();
                });
              });
            }}
          >
            {deleting ? (
              <p>
                {deleting.mode === '2d' ? '2D chart' : '3D toy'}, edited {formatRelativeTime(deleting.updatedAt)}. It moves to <strong>Recently deleted</strong> for 30 days, where you
                can restore it.
              </p>
            ) : null}
          </ConfirmDialog>
          <RestoreDialog
            open={restore.open}
            source={restore.source}
            onSource={(source) => setRestore({ open: true, source })}
            onClose={() => {
              setRestore((r) => ({ ...r, open: false }));
              // The dialog gives focus back to what opened it; when that is gone (a "Review" notice that went
              // away with the last offer), focus the restore button instead of the page.
              requestAnimationFrame(() => {
                if (document.activeElement === document.body || document.activeElement === null) restoreButton.current?.focus();
              });
            }}
            mirror={mirrorOn ? (session?.mirror() ?? null) : null}
            importFile={session ? (file) => session.importFile(file) : null}
            onOpen={(id) => {
              setRestore((r) => ({ ...r, open: false }));
              open(id);
            }}
          />
        </div>
      }
    />
  );
}
