// Track T8 — "Recently deleted" on the start screen (DESIGN.md §5.5.5, §5.7): deleted projects stay 30 days,
// then they are purged at start-up. Each can be restored or deleted for good (with a confirm).
import { useId, useRef, useState } from 'react';
import { TRASH_KEEP_MS, type TrashEntry } from '../../core/persist/repo';
import { daysLeft, useLibrary } from '../../state/slices/library';
import { Button } from '../common/Button';
import { ConfirmDialog } from '../common/Dialog';
import { Icon } from '../common/Icon';
import { formatRelativeTime } from '../shell/relativeTime';

export interface RecentlyDeletedProps {
  /** Resolves true when it worked. */
  onRestore(id: string): Promise<boolean>;
  onDeleteForever(id: string): Promise<boolean>;
  /** The folder mirror is on: deleting for good keeps a copy in the folder's Backups/deleted. */
  mirrorOn: boolean;
  now?: () => Date;
}

export function RecentlyDeleted({ onRestore, onDeleteForever, mirrorOn, now = () => new Date() }: RecentlyDeletedProps) {
  const trash = useLibrary((s) => s.trash);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<TrashEntry | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const listId = useId();
  const toggleRef = useRef<HTMLButtonElement>(null);
  if (!trash || trash.length === 0) return null;
  const at = now();

  const run = async (id: string, action: (id: string) => Promise<boolean>, then: () => void) => {
    setWorking(id);
    try {
      if (await action(id)) requestAnimationFrame(then);
    } finally {
      setWorking(null);
    }
  };
  /** Focus where the user can go on after a row went away: the next row, else the section's toggle. */
  const focusAfterRow = (id: string) => () => {
    const ids = (trash ?? []).map((t) => t.summary.id);
    const next = ids[ids.indexOf(id) + 1] ?? ids[ids.indexOf(id) - 1];
    const row = next ? document.querySelector<HTMLElement>(`.lib-trash [data-project-id="${CSS.escape(next)}"] button`) : null;
    (row ?? toggleRef.current ?? document.querySelector<HTMLElement>('.shell-project__open'))?.focus();
  };
  /** After a restore: the project's card is back. */
  const focusCard = (id: string) => () => {
    (document.querySelector<HTMLElement>(`.shell-project__open[data-project-id="${CSS.escape(id)}"]`) ?? toggleRef.current)?.focus();
  };

  return (
    <section className="lib-trash" aria-label="Recently deleted">
      <button type="button" ref={toggleRef} className="lib-trash__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
        <Icon name="trash" size={16} />
        <span className="lib-trash__title">Recently deleted</span>
        <span className="lib-note-count">({trash.length})</span>
        <span className="lib-trash__hint">Kept for 30 days, then deleted for good</span>
        <Icon name="chevron-down" size={16} className="lib-trash__chevron" />
      </button>
      {open ? (
        <ul className="lib-rows" id={listId}>
          {trash.map((t) => {
            const left = daysLeft(t.deletedAt, at, TRASH_KEEP_MS);
            const busy = working === t.summary.id;
            return (
              <li key={t.summary.id} className="lib-row" data-project-id={t.summary.id}>
                <span className="lib-row__icon" aria-hidden="true">
                  <Icon name={t.summary.mode === '2d' ? 'chart' : 'cube'} size={16} />
                </span>
                <span className="lib-row__text">
                  <span className="lib-row__name" title={t.summary.name}>
                    {t.summary.name}
                  </span>
                  <span className="lib-row__meta">
                    {t.summary.mode === '2d' ? '2D chart' : '3D toy'} · Deleted {formatRelativeTime(t.deletedAt, at)} ·{' '}
                    {left === 0 ? 'goes at the next start' : `${left} day${left === 1 ? '' : 's'} left`}
                  </span>
                </span>
                <span className="lib-row__actions">
                  <Button size="sm" icon="undo" loading={busy} onClick={() => void run(t.summary.id, onRestore, focusCard(t.summary.id))} aria-label={`Restore ${t.summary.name}`}>
                    Restore
                  </Button>
                  <Button size="sm" variant="ghost" icon="trash" disabled={busy} onClick={() => setConfirm(t)} aria-label={`Delete ${t.summary.name} for good`}>
                    Delete for good
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm ? `Delete “${confirm.summary.name}” for good?` : ''}
        confirmLabel="Delete for good"
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          if (target) void run(target.summary.id, onDeleteForever, focusAfterRow(target.summary.id));
        }}
      >
        <p>
          It is removed from this browser with all its snapshots. This can’t be undone here.
          {mirrorOn ? ' The projects folder keeps a copy in Backups/deleted.' : ' If you might want it back, restore it and export it as a file first.'}
        </p>
      </ConfirmDialog>
    </section>
  );
}
