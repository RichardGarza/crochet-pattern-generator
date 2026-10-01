// @vitest-environment happy-dom
// The top bar's name field follows outside renames (undo, a conflict copy) while it has the focus, unless the user
// typed something else (integration S1, docs/tracks/t8.md request 2).
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS } from '../../../state/appStore';
import { projectStore } from '../../../state/projectStore';
import { newProjectDoc } from '../newProject';
import { ProjectName } from '../ProjectName';

const open = (id: string, name: string) => {
  const doc = newProjectDoc('picture', { id, now: new Date('2026-10-01T12:00:00Z'), prefs: DEFAULT_PREFS, name });
  projectStore.getState().open(doc);
};
const field = () => screen.getByTestId('project-name') as HTMLInputElement;
const renameFromOutside = (name: string) =>
  act(() => {
    projectStore.getState().update('Rename project', (d) => {
      d.name = name;
    });
  });

describe('ProjectName', () => {
  beforeEach(() => open('p1', 'Teddy'));
  afterEach(() => projectStore.getState().close({ discardUnsaved: true }));

  it('a conflict copy renamed while the field has the focus is not renamed back on blur', () => {
    render(<ProjectName />);
    fireEvent.focus(field());
    renameFromOutside('Teddy (copy, 14:05)');
    expect(field().value).toBe('Teddy (copy, 14:05)');
    fireEvent.blur(field());
    expect(projectStore.getState().doc?.name).toBe('Teddy (copy, 14:05)');
  });

  it('keeps what the user typed when the name changes underneath, and commits it on blur', () => {
    render(<ProjectName />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'Bunny' } });
    renameFromOutside('Teddy (copy, 14:05)');
    expect(field().value).toBe('Bunny');
    fireEvent.blur(field());
    expect(projectStore.getState().doc?.name).toBe('Bunny');
  });

  it('shows the next project name when another project opens, even while focused and edited', () => {
    render(<ProjectName />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'half-typed' } });
    act(() => {
      projectStore.getState().close({ discardUnsaved: true });
      open('p2', 'Sunflower');
    });
    expect(field().value).toBe('Sunflower');
  });

  it('Enter renames and an undo shows the old name again while focused', () => {
    render(<ProjectName />);
    fireEvent.focus(field());
    fireEvent.change(field(), { target: { value: 'Bear' } });
    fireEvent.keyDown(field(), { key: 'Enter' });
    expect(projectStore.getState().doc?.name).toBe('Bear');
    act(() => projectStore.getState().undo());
    expect(field().value).toBe('Teddy');
    fireEvent.blur(field());
    expect(projectStore.getState().doc?.name).toBe('Teddy');
  });
});
