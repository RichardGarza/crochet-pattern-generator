// @vitest-environment happy-dom
// Tabs add their shortcuts to the "?" list (integration S1, docs/tracks/t6.md request 1).
import { act, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { registerShortcutGroup, shortcutGroups, useShortcutGroup, type ShortcutGroup } from '../shortcuts';
import { ShortcutsDialog } from '../ShortcutsDialog';

const shape: ShortcutGroup = {
  id: 'shape',
  title: 'Shape tab',
  rows: [
    { keys: [['W']], what: 'Move tool' },
    { keys: [['E']], what: 'Rotate tool' },
  ],
};

function ShapeTabLike({ group }: { group: ShortcutGroup | null }) {
  useShortcutGroup(group);
  return null;
}

describe('shortcut groups', () => {
  afterEach(() => {
    for (const g of shortcutGroups()) registerShortcutGroup(g)(); // remove leftovers
  });

  it('register, replace by id, and remove only what was registered', () => {
    const off = registerShortcutGroup(shape);
    expect(shortcutGroups().map((g) => g.id)).toEqual(['shape']);
    const offNewer = registerShortcutGroup({ ...shape, rows: [{ keys: [['R']], what: 'Resize tool' }] });
    off(); // the replaced registration no longer removes the newer one
    expect(shortcutGroups()[0].rows.map((r) => r.what)).toEqual(['Resize tool']);
    offNewer();
    expect(shortcutGroups()).toEqual([]);
  });

  it('a mounted tab lists its rows in the dialog under its title; unmounting removes them', () => {
    const tab = render(<ShapeTabLike group={shape} />);
    render(<ShortcutsDialog open onClose={() => {}} />);
    const section = screen.getByRole('region', { name: 'Shape tab' });
    expect(within(section).getByText('Move tool')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Everywhere' })).toBeTruthy();
    expect(screen.getByText('Undo')).toBeTruthy();
    act(() => tab.unmount());
    expect(screen.queryByText('Move tool')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Everywhere' })).toBeNull(); // the plain list again
    expect(screen.getByText('Undo')).toBeTruthy();
  });

  it('re-rendering with an equal group does not re-register; a changed one updates the list', () => {
    const tab = render(<ShapeTabLike group={shape} />);
    const first = shortcutGroups()[0];
    tab.rerender(<ShapeTabLike group={{ ...shape, rows: [...shape.rows] }} />);
    expect(shortcutGroups()[0]).toBe(first);
    tab.rerender(<ShapeTabLike group={{ ...shape, title: 'Shape' }} />);
    expect(shortcutGroups().map((g) => g.title)).toEqual(['Shape']);
    tab.rerender(<ShapeTabLike group={null} />);
    expect(shortcutGroups()).toEqual([]);
  });
});
