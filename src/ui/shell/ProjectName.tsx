// The project name in the top bar: looks like a title, edits in place. Enter or leaving the field renames
// (one undo step, "Rename project"); Escape restores; an empty name is not accepted.
import { useEffect, useRef, useState } from 'react';
import { projectStore, useProjectStore } from '../../state/projectStore';
import { Icon } from '../common/Icon';

export const MAX_NAME_LENGTH = 120;

export function ProjectName() {
  const name = useProjectStore((s) => s.doc?.name ?? '');
  const readOnly = useProjectStore((s) => s.readOnly);
  const [text, setText] = useState(name);
  const editing = useRef(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing.current) setText(name);
  }, [name]);

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
          if (e.key === 'Enter') input.current?.blur();
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
