// @vitest-environment happy-dom
// Track T6.2 — the Shape tab's structure tools with a stub Viewport (DESIGN.md §4.2, §6.3 T6): Add part (by a side,
// the keyboard path, and by a click on the surface), Duplicate (⌘D), Delete (⌫, asks, re-attaches, stores a
// revision), Mirror (M) with the linked twin and Unlink, Attach (loops refused), Make as / Start, the "?" rows,
// and the inspector's Yarn & size page. Each action is ONE history step.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { overlapAlongRay, surfaceExit } from '../../../core/model/place';
import { partCenter } from '../../../core/model/transforms';
import { byId, openTeddy } from '../../../state/slices/__tests__/teddyProject';
import { projectStore } from '../../../state/projectStore';
import type { Vec3 } from '../../../types/model';
import type { ViewportProps } from '../../../types/ui';
import { shortcutGroups } from '../../shell/shortcuts';
import { IS_MAC } from '../../shell/shortcuts';
import { editorStore } from '../editorStore';
import { ShapeTab } from '../ShapeTab';
import { completeSurfacePick } from '../tools';

function StubViewport(props: ViewportProps) {
  return <div data-testid="stub-viewport" data-selection={props.selection.join(',')} />;
}

const model = () => projectStore.getState().doc!.threeD!.model!;
const history = () => projectStore.getState().history.past.map((e) => e.label);
const mount = () => render(<ShapeTab Viewport={StubViewport} />);
const select = (id: string) => act(() => editorStore.getState().select(id));
const key = (k: string, o: Partial<KeyboardEventInit> = {}) => fireEvent.keyDown(window, { key: k, ...o });

beforeEach(() => {
  editorStore.getState().reset();
  openTeddy(projectStore);
});

afterEach(() => {
  projectStore.getState().close({ discardUnsaved: true });
});

describe('Add part', () => {
  it('on a side of a part, from the dialog (keyboard path): attached, placed, selected, one step', () => {
    mount();
    select('head');
    fireEvent.click(screen.getByRole('button', { name: 'Add part' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a part' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /Capsule/ }));
    fireEvent.click(within(dialog).getByRole('radio', { name: 'On a side of a part' }));
    expect((within(dialog).getByRole('combobox', { name: 'On' }) as HTMLSelectElement).value).toBe('head');
    fireEvent.change(within(dialog).getByRole('combobox', { name: 'Side' }), { target: { value: 'top' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add the capsule' }));
    const added = byId(model()).capsule;
    expect(added.attach?.to).toBe('head');
    expect(overlapAlongRay(byId(model()).head, added)).toBeCloseTo(0.1, 3);
    expect(editorStore.getState().selection).toEqual(['capsule']);
    expect(screen.getByRole('heading', { level: 2, name: 'Capsule' })).toBeTruthy();
    expect(history()).toEqual(['Add capsule to Head']);
  });

  it('by a click on the surface: the hint shows, the clicked part becomes the parent; Esc cancels', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Add part' }));
    const dialog = screen.getByRole('dialog', { name: 'Add a part' });
    fireEvent.click(within(dialog).getByRole('radio', { name: /^Ball/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Choose the spot' }));
    expect(screen.getByText(/Click on the model where the new ball goes/)).toBeTruthy();
    key('Escape');
    expect(editorStore.getState().surfacePick).toBeNull();
    expect(screen.queryByText(/Click on the model where/)).toBeNull();

    act(() => editorStore.getState().setSurfacePick({ kind: 'add', type: 'sphere' }));
    const tail = byId(model()).tail;
    const dir: Vec3 = [0, 0, -1];
    const c = partCenter(tail);
    const t = surfaceExit(tail, c, dir) as number;
    act(() => completeSurfacePick('tail', [c[0], c[1], c[2] - t], dir));
    expect(byId(model()).ball.attach?.to).toBe('tail');
    expect(editorStore.getState().surfacePick).toBeNull();
    expect(history()).toEqual(['Add ball to Tail']);
  });
});

describe('Duplicate, Delete, Mirror', () => {
  it('⌘D duplicates the selection (offset +0.5 in X) and selects the copies', () => {
    mount();
    select('tail');
    key('d', IS_MAC ? { metaKey: true } : { ctrlKey: true });
    expect(byId(model()).tail_2.position[0]).toBeCloseTo(byId(model()).tail.position[0] + 0.5, 9);
    expect(editorStore.getState().selection).toEqual(['tail_2']);
    expect(history()).toEqual(['Duplicate Tail']);
    // The button does the same (on the selected copy).
    fireEvent.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(byId(model()).tail_2_2).toBeTruthy();
  });

  it('⌫ asks first; the children re-attach to the parent; one undo step that also stores a revision', async () => {
    mount();
    select('head');
    const revisions = projectStore.getState().doc!.threeD!.revisions.length;
    key('Backspace');
    const dialog = screen.getByRole('dialog', { name: 'Delete Head?' });
    expect(within(dialog).getByText(/will be attached to Body instead/)).toBeTruthy();
    // Cancel keeps everything.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(byId(model()).head).toBeTruthy();
    key('Delete');
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Delete Head?' })).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(byId(model()).head).toBeUndefined());
    expect(byId(model()).ear_l.attach?.to).toBe('body');
    expect(projectStore.getState().doc!.threeD!.revisions.length).toBeGreaterThan(revisions);
    expect(history()).toEqual(['Delete Head']);
    expect(editorStore.getState().selection).toEqual([]);
    act(() => void projectStore.getState().undo());
    expect(byId(model()).head).toBeTruthy();
    expect(byId(model()).ear_l.attach?.to).toBe('head');
  });

  it('M mirrors a part to the other side and links it; the inspector shows the link and Unlink', () => {
    mount();
    act(() => editorStore.getState().setSurfacePick({ kind: 'add', type: 'cone' }));
    act(() => completeSurfacePick('head', [2, 8, 0], [1, 0.3, 0]));
    const id = editorStore.getState().selection[0];
    key('m');
    const twinId = `${id}_r`;
    const src = byId(model())[id];
    const twin = byId(model())[twinId];
    expect(twin.mirrorOf).toBe(id);
    expect(twin.position).toEqual([-src.position[0], src.position[1], src.position[2]]);
    expect(screen.getByText(/Mirrored with/)).toBeTruthy();
    // A linked edit: moving the source moves the twin.
    const x = screen.getByRole('spinbutton', { name: /^X left to right/ });
    fireEvent.change(x, { target: { value: '3' } });
    fireEvent.keyDown(x, { key: 'Enter' });
    expect(byId(model())[twinId].position[0]).toBeCloseTo(-3, 6);
    fireEvent.click(screen.getByRole('button', { name: 'Unlink' }));
    expect(byId(model())[twinId].mirrorOf).toBeUndefined();
    expect(screen.queryByText(/Mirrored with/)).toBeNull();
  });

  it('Mirror is refused with its reason on a part on the middle line', () => {
    mount();
    select('muzzle');
    const button = screen.getByRole('button', { name: 'Mirror' });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(screen.getByText(/its mirror image would land on itself/)).toBeTruthy();
  });
});

describe('Attach, Make as, Start', () => {
  it('Change… re-parents; parts that hang from it are offered disabled (no loops); the root is not attached', () => {
    mount();
    select('ear_l');
    fireEvent.click(screen.getByRole('button', { name: 'Change what Left Ear is attached to' }));
    const dialog = screen.getByRole('dialog', { name: 'Attach Left Ear' });
    const to = within(dialog).getByRole('combobox', { name: 'Attached to' }) as HTMLSelectElement;
    const inner = Array.from(to.options).find((o) => o.value === 'ear_l_inner')!;
    expect(inner.disabled).toBe(true);
    fireEvent.change(to, { target: { value: 'body' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Bottom end' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(byId(model()).ear_l.attach).toMatchObject({ to: 'body', openEnd: 'bottom' });
    expect(history()).toEqual(['Attach Left Ear to Body']);
    // The root.
    act(() => editorStore.getState().openAttach('body'));
    expect(within(screen.getByRole('dialog', { name: 'Attach Body' })).getByText(/is the main piece: every other part hangs from it/)).toBeTruthy();
  });

  it('Make as and Start write crochet hints (the mirror twin follows)', () => {
    mount();
    select('ear_l');
    fireEvent.change(screen.getByRole('combobox', { name: 'Make it as' }), { target: { value: 'applique' } });
    expect(byId(model()).ear_l.crochet).toEqual({ make: 'applique' });
    expect(byId(model()).ear_r.crochet).toEqual({ make: 'applique' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Make it as' }), { target: { value: 'piece' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Top' }));
    expect(byId(model()).ear_l.crochet).toEqual({ make: 'piece', start: 'top' });
    fireEvent.click(screen.getByRole('radio', { name: 'Z' }));
    expect(byId(model()).ear_l.crochet?.axis).toBe('z');
    fireEvent.change(screen.getByRole('combobox', { name: 'Make it as' }), { target: { value: 'auto' } });
    expect(byId(model()).ear_l.crochet).toEqual({ start: 'top', axis: 'z' });
  });

  it('a capsule has no axis choice (it is worked along its own length)', () => {
    mount();
    select('arm_l');
    expect(screen.queryByRole('radiogroup', { name: 'Rounds stack along' })).toBeNull();
    expect(screen.getByText('Its rounds stack along its own length.')).toBeTruthy();
  });
});

describe('the tab around the tools', () => {
  it('lists its keys in the "?" dialog while mounted', () => {
    const { unmount } = mount();
    const group = shortcutGroups().find((g) => g.id === 'shape');
    expect(group?.title).toBe('Shape tab');
    expect(group?.rows.map((r) => r.what)).toEqual(expect.arrayContaining(['Select', 'Move', 'Rotate', 'Resize', 'Frame the selection', 'Duplicate the selected parts']));
    unmount();
    expect(shortcutGroups().some((g) => g.id === 'shape')).toBe(false);
  });

  it('the inspector has a Yarn & size page; picking a part goes back to the part', () => {
    mount();
    fireEvent.click(screen.getByRole('tab', { name: 'Yarn & size' }));
    expect(screen.getByRole('combobox', { name: 'Yarn weight' })).toBeTruthy();
    expect(document.querySelector('[data-context="shape"]')).toBeTruthy();
    select('head');
    expect(screen.getByRole('tab', { name: 'Part' }).getAttribute('aria-selected')).toBe('true');
  });

  it('nothing changes on a read-only project (keys and buttons)', () => {
    mount();
    select('tail');
    act(() => projectStore.getState().setReadOnly(true));
    key('d', IS_MAC ? { metaKey: true } : { ctrlKey: true });
    key('m');
    key('Backspace');
    expect(screen.queryByRole('dialog', { name: /Delete/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Add part' }).getAttribute('aria-disabled')).toBe('true');
    expect(history()).toEqual([]);
  });
});
