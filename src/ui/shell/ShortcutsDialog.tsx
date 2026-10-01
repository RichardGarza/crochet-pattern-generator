// The keyboard shortcut list ("?" or the keyboard button in the top bar).
import { Dialog } from '../common/Dialog';
import { Kbd } from '../common/Layout';
import { IS_MAC, useShortcutGroups, type ShortcutRow } from './shortcuts';

const ROWS: ShortcutRow[] = [
  { keys: [[IS_MAC ? '⌘' : 'Ctrl', 'Z']], what: 'Undo' },
  { keys: IS_MAC ? [['⇧', '⌘', 'Z']] : [['Ctrl', 'Y'], ['Ctrl', '⇧', 'Z']], what: 'Redo' },
  { keys: [['←'], ['→']], what: 'Move between tabs (when a tab has focus)' },
  { keys: [['Tab']], what: 'Next control; Shift + Tab goes back' },
  { keys: [['Esc']], what: 'Close a dialog or a tooltip; cancel typing a name' },
  { keys: [['?']], what: 'Show this list' },
];

function Rows({ rows }: { rows: readonly ShortcutRow[] }) {
  return (
    <dl className="shell-shortcuts">
      {rows.map((row) => (
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
  );
}

/** The workspace shortcuts, then one section per group a tab registered (`useShortcutGroup`). */
export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }) {
  const groups = useShortcutGroups();
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts" description="Work without the mouse." size="sm">
      {groups.length === 0 ? (
        <Rows rows={ROWS} />
      ) : (
        <>
          <section aria-labelledby="shortcuts-everywhere">
            <h3 id="shortcuts-everywhere" className="shell-shortcuts__title">
              Everywhere
            </h3>
            <Rows rows={ROWS} />
          </section>
          {groups.map((g) => (
            <section key={g.id} aria-labelledby={`shortcuts-${g.id}`}>
              <h3 id={`shortcuts-${g.id}`} className="shell-shortcuts__title">
                {g.title}
              </h3>
              <Rows rows={g.rows} />
            </section>
          ))}
        </>
      )}
    </Dialog>
  );
}
