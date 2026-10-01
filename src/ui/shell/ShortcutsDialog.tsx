// The keyboard shortcut list ("?" or the keyboard button in the top bar).
import { Dialog } from '../common/Dialog';
import { Kbd } from '../common/Layout';
import { IS_MAC } from './shortcuts';

const ROWS: { keys: string[][]; what: string }[] = [
  { keys: [[IS_MAC ? '⌘' : 'Ctrl', 'Z']], what: 'Undo' },
  { keys: IS_MAC ? [['⇧', '⌘', 'Z']] : [['Ctrl', 'Y'], ['Ctrl', '⇧', 'Z']], what: 'Redo' },
  { keys: [['←'], ['→']], what: 'Move between tabs (when a tab has focus)' },
  { keys: [['Tab']], what: 'Next control; Shift + Tab goes back' },
  { keys: [['Esc']], what: 'Close a dialog or a tooltip; cancel typing a name' },
  { keys: [['?']], what: 'Show this list' },
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" description="Work without the mouse." size="sm">
      <dl className="shell-shortcuts">
        {ROWS.map((row) => (
          <div key={row.what} className="shell-shortcuts__row">
            <dt>
              {row.keys.map((combo, i) => (
                <span key={combo.join('+')} className="shell-shortcuts__combo">
                  {i > 0 ? <span className="shell-shortcuts__or">or</span> : null}
                  {combo.map((k) => (
                    <Kbd key={k}>{k}</Kbd>
                  ))}
                </span>
              ))}
            </dt>
            <dd>{row.what}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
