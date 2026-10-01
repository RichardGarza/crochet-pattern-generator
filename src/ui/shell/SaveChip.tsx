// The save chip of the top bar (F7: "Saved ✓ / Saving… / Error"). Before T8's autosave exists, projects live in
// this tab only and the chip says "Not saved yet" (saveStatus.ts).
import { Icon, type IconName } from '../common/Icon';
import { Spinner } from '../common/Progress';
import { Tooltip } from '../common/Tooltip';
import { cx } from '../common/cx';
import { useSaveChipStatus, type SaveChipStatus } from './saveStatus';

const VIEW: Record<SaveChipStatus, { text: string; icon: IconName | 'spinner'; tone: string; tip: string }> = {
  saved: { text: 'Saved', icon: 'check', tone: 'success', tip: 'Every change is saved in this browser.' },
  saving: { text: 'Saving…', icon: 'spinner', tone: 'neutral', tip: 'Saving your latest changes.' },
  error: { text: 'Not saved', icon: 'error', tone: 'danger', tip: 'The last save failed. Your changes are still here — export a backup to be safe.' },
  'read-only': { text: 'Read-only', icon: 'lock', tone: 'neutral', tip: 'This project is open in another tab; edits are off here.' },
  'not-saved': {
    text: 'Not saved yet',
    icon: 'cloud-off',
    tone: 'neutral',
    tip: 'Saving is not switched on yet: this project lasts until you close or reload this tab.',
  },
};

export function SaveChip({ status }: { status: SaveChipStatus }) {
  const v = VIEW[status];
  return (
    <Tooltip content={v.tip}>
      <span className={cx('shell-savechip', `shell-savechip--${v.tone}`)} tabIndex={0} role="status" aria-label={`${v.text}. ${v.tip}`} data-testid="save-chip">
        {v.icon === 'spinner' ? <Spinner size={13} /> : <Icon name={v.icon} size={14} strokeWidth={2} />}
        <span aria-hidden="true">{v.text}</span>
      </span>
    </Tooltip>
  );
}

/** The chip wired to the open project. */
export function ProjectSaveChip() {
  return <SaveChip status={useSaveChipStatus()} />;
}
