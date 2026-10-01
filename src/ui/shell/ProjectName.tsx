// The project name in the top bar: looks like a title, edits in place. Enter or leaving the field renames
// (one undo step, "Rename project"); Escape restores; an empty name is not accepted.
//
// A name changed from outside (undo, a conflict copy's "… (copy, 14:05)", another project opening) replaces the
// text unless the user has typed something else since the field last showed the name: otherwise the next blur
// would write the stale text back (renaming a conflict copy to the original's name).
import { useEffect, useRef, useState } from 'react';
import { projectStore, useProjectStore } from '../../state/projectStore';
import { Icon } from '../common/Icon';

export const MAX_NAME_LENGTH = 120;

export function ProjectName() {
  const name = useProjectStore((s) => s.doc?.name ?? '');
  const id = useProjectStore((s) => s.doc?.id ?? null);
  const readOnly = useProjectStore((s) => s.readOnly);
  const [text, setText] = useState(name);
  const editing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  // The project and name the field last showed.
  const shown = useRef({ id, name });

  useEffect(() => {
    const before = shown.current;
    shown.current = { id, name };
    setText((typed) => (!editing.current || id !== before.id || typed === before.name ? name : typed));
  }, [id, name]);

  const commit = () => {
    const next = text.trim().slice(0, MAX_NAME_LENGTH);
    if (!next || next === name) {
      setText(name);
      return;
    }
    const changed = projectStore.getState().update('Rename project', (d) => {
      d.name = next;
    });
    if (!changed) setText(name);
  };

  return (
    <label className="shell-name" title={readOnly ? undefined : 'Rename project'}>
      <span className="ui-visually-hidden">Project name</span>
      <input
        ref={input}
        className="shell-name__input"
        value={text}
        readOnly={readOnly}
        maxLength={MAX_NAME_LENGTH}
        spellCheck={false}
        onFocus={(e) => {
          editing.current = true;
          e.currentTarget.select();
        }}
        onBlur={() => {
          editing.current = false;
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter renames and keeps the focus here (blurring would drop it on <body>).
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') {
            // Drop the edit; focus stays.
            setText(name);
            requestAnimationFrame(() => input.current?.select());
          }
        }}
        data-testid="project-name"
      />
      {readOnly ? null : <Icon name="pencil" size={14} className="shell-name__pencil" />}
    </label>
  );
}
