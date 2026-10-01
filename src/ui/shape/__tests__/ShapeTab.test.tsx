// @vitest-environment happy-dom
// Track T6.1 — the Shape tab mounted with a stub Viewport (happy-dom has no WebGL; DESIGN.md §6.1 rule 5, §6.3 T6):
// select through the outliner, the stub viewport or the store; the inspector shows the part; editing a dimension
// updates the document; a slider drag is ONE history entry; undo / redo restore.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isImplemented } from '../../../core/stub';
import { surfaceGap } from '../../../core/model/sdf';
import { byId, openTeddy } from '../../../state/slices/__tests__/teddyProject';
import { projectStore } from '../../../state/projectStore';
import type { ViewportProps } from '../../../types/ui';
import { editorStore } from '../editorStore';
import { ShapeTab } from '../ShapeTab';

const seen: ViewportProps[] = [];

function StubViewport(props: ViewportProps) {
  seen.push(props);
  return (
    <div data-testid="stub-viewport" data-selection={props.selection.join(',')} data-parts={props.model.parts.length}>
      {props.model.parts.map((p) => (
        <button key={p.id} type="button" data-testid={`pick-${p.id}`} onClick={() => props.onPick?.(p.id)}>
          pick {p.id}
        </button>
      ))}
      <button type="button" data-testid="pick-nothing" onClick={() => props.onPick?.(null)}>
        empty
      </button>
    </div>
  );
}

const model = () => projectStore.getState().doc!.threeD!.model!;
const history = () => projectStore.getState().history.past.map((e) => e.label);

function mount() {
  return render(<ShapeTab Viewport={StubViewport} />);
}

beforeEach(() => {
  seen.length = 0;
  editorStore.getState().reset();
  openTeddy(projectStore);
});

afterEach(() => {
  projectStore.getState().close({ discardUnsaved: true });
});

describe('ShapeTab (stub Viewport)', () => {
  it('is implemented (no longer the Step 0 stub) and renders the viewport with the model', () => {
    expect(isImplemented(ShapeTab)).toBe(true);
    mount();
    const vp = screen.getByTestId('stub-viewport');
    expect(vp.dataset.parts).toBe(String(model().parts.length));
    expect(seen.at(-1)?.meshes).toEqual({});
    expect(seen.at(-1)?.layers).toMatchObject({ shadow: true });
  });

  it('the outliner is the attach tree; selecting a row shows that part in the inspector and the viewport', () => {
    mount();
    const tree = screen.getByRole('tree', { name: 'Parts' });
    const body = within(tree).getByRole('treeitem', { name: 'Body' });
    expect(body.getAttribute('aria-level')).toBe('1');
    const head = within(tree).getByRole('treeitem', { name: 'Head' });
    expect(head.getAttribute('aria-level')).toBe('2');
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(within(head).getByRole('treeitem', { name: 'Left Ear' }).getAttribute('aria-level')).toBe('3');
    // Nothing selected yet.
    expect(screen.getByRole('heading', { name: 'Nothing selected' })).toBeTruthy();

    fireEvent.click(head.querySelector('.shape-tree__row')!);
    expect(head.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('heading', { level: 2, name: 'Head' })).toBeTruthy();
    expect(screen.getByTestId('stub-viewport').dataset.selection).toBe('head');
    // The size fields show diameters (2 × the radii) in the project's units.
    expect((screen.getByRole('spinbutton', { name: 'Width (inches)' }) as HTMLInputElement).value).toBe('4.8');
    expect((screen.getByRole('spinbutton', { name: 'Height (inches)' }) as HTMLInputElement).value).toBe('4.3');
    // ⇧-click adds a part; the last one picked is the one the inspector edits.
    fireEvent.click(within(tree).getByRole('treeitem', { name: 'Body' }).querySelector('.shape-tree__row')!, { shiftKey: true });
    expect(editorStore.getState().selection).toEqual(['head', 'body']);
    expect(screen.getByRole('heading', { level: 2, name: 'Body' })).toBeTruthy();
    expect(screen.getByText('2 selected')).toBeTruthy();
  });

  it('selects through the viewport (onPick) and through the store; empty space clears', () => {
    mount();
    fireEvent.click(screen.getByTestId('pick-ear_l'));
    expect(screen.getByRole('heading', { level: 2, name: 'Left Ear' })).toBeTruthy();
    expect(screen.getByRole('treeitem', { name: 'Left Ear' }).getAttribute('aria-selected')).toBe('true');
    act(() => editorStore.getState().select('tail'));
    expect(screen.getByRole('heading', { level: 2, name: 'Tail' })).toBeTruthy();
    fireEvent.click(screen.getByTestId('pick-nothing'));
    expect(editorStore.getState().selection).toEqual([]);
    expect(screen.getByRole('heading', { name: 'Nothing selected' })).toBeTruthy();
  });

  it('editing a dimension updates the document as one undo step, re-anchoring the attached parts', () => {
    mount();
    act(() => editorStore.getState().select('head'));
    const before = model();
    const width = screen.getByRole('spinbutton', { name: 'Width (inches)' });
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: '6' } });
    fireEvent.keyDown(width, { key: 'Enter' });
    const after = model();
    expect(byId(after).head.dims).toEqual({ rx: 3, ry: 2.15, rz: 2.2 });
    expect(byId(after).ear_l.position[0]).toBeGreaterThan(byId(before).ear_l.position[0]);
    expect(surfaceGap(byId(after).ear_l, byId(after).head)).toBeLessThanOrEqual(0.1);
    expect(history()).toEqual(['Resize Head']);
    fireEvent.blur(width);
    act(() => {
      projectStore.getState().undo();
    });
    expect(model()).toEqual(before);
    expect((width as HTMLInputElement).value).toBe('4.8');
    act(() => {
      projectStore.getState().redo();
    });
    expect(byId(model()).head.dims).toMatchObject({ rx: 3 });
  });

  it('a slider drag is ONE history entry; undo restores, redo brings it back', () => {
    mount();
    act(() => editorStore.getState().select('body'));
    const before = model();
    const slider = screen.getByRole('slider', { name: 'Height' });
    for (const v of [5.4, 5.6, 5.8, 6.0, 6.2]) fireEvent.change(slider, { target: { value: String(v) } });
    fireEvent.pointerUp(slider);
    expect(history()).toEqual(['Resize Body']);
    const after = model();
    expect(byId(after).body.dims).toMatchObject({ ry: 3.1 });
    expect(after.revision).toBe(before.revision + 1);
    // The head (attached to the body) was re-anchored on the taller body; the body's other edits are untouched.
    expect(byId(after).head.position[1]).toBeGreaterThan(byId(before).head.position[1]);
    // A second drag is a second entry.
    fireEvent.change(slider, { target: { value: '5' } });
    fireEvent.pointerUp(slider);
    expect(history()).toEqual(['Resize Body', 'Resize Body']);
    act(() => {
      projectStore.getState().undo();
      projectStore.getState().undo();
    });
    expect(model()).toEqual(before);
    act(() => {
      projectStore.getState().redo();
    });
    expect(model()).toEqual(after);
  });

  it('position fields move the subtree; with "Attached parts follow" off the part moves alone (W_GAP shows)', () => {
    mount();
    act(() => editorStore.getState().select('head'));
    const b = byId(model());
    const y = screen.getByRole('spinbutton', { name: 'Y down to up (inches)' });
    fireEvent.focus(y);
    fireEvent.change(y, { target: { value: '7.5' } });
    fireEvent.blur(y);
    const a = byId(model());
    expect(a.head.position[1]).toBeCloseTo(7.5, 9);
    expect(a.ear_l.position[1]).toBeCloseTo(b.ear_l.position[1] + (7.5 - b.head.position[1]), 6);
    expect(history()).toEqual(['Move Head']);

    fireEvent.click(screen.getByRole('switch', { name: 'Attached parts follow' }));
    expect(editorStore.getState().followAttached).toBe(false);
    act(() => editorStore.getState().select('body'));
    const z = screen.getByRole('spinbutton', { name: 'Z back to front (inches)' });
    fireEvent.focus(z);
    fireEvent.change(z, { target: { value: '-6' } });
    fireEvent.keyDown(z, { key: 'Enter' });
    const c = byId(model());
    expect(c.body.position[2]).toBe(-6);
    expect(c.head).toBe(a.head);
    // W_GAP for the body's children: in the outliner and in the inspector of a child.
    expect(screen.getByRole('treeitem', { name: 'Head, has a gap to its parent' })).toBeTruthy();
    act(() => editorStore.getState().select('head'));
    expect(screen.getByText(/Head floats .* from Body/)).toBeTruthy();
  });

  it('rotation fields turn the part about its center', () => {
    mount();
    act(() => editorStore.getState().select('tail'));
    const x = screen.getByRole('spinbutton', { name: 'X turn (°)' });
    fireEvent.focus(x);
    fireEvent.change(x, { target: { value: '30' } });
    fireEvent.keyDown(x, { key: 'Enter' });
    expect(byId(model()).tail.rotationDeg).toEqual([30, 0, 0]);
    expect(history()).toEqual(['Rotate Tail']);
  });

  it('the base color select writes a palette id', () => {
    mount();
    act(() => editorStore.getState().select('muzzle'));
    const select = screen.getByRole('combobox', { name: /Base color/ });
    fireEvent.change(select, { target: { value: 'dark_brown_yarn' } });
    expect(byId(model()).muzzle.color).toBe('dark_brown_yarn');
    expect(history()).toEqual(['Color Muzzle']);
  });

  it('keyboard: the tree has one tab stop; arrows move and select; ← / → close and open a branch', () => {
    mount();
    const tree = screen.getByRole('tree', { name: 'Parts' });
    const items = within(tree).getAllByRole('treeitem');
    expect(items.filter((i) => i.tabIndex === 0)).toHaveLength(1);
    const body = within(tree).getByRole('treeitem', { name: 'Body' });
    body.focus();
    fireEvent.keyDown(body, { key: 'ArrowDown' });
    expect(editorStore.getState().selection).toEqual(['head']);
    const head = within(tree).getByRole('treeitem', { name: 'Head' });
    expect(document.activeElement).toBe(head);
    fireEvent.keyDown(head, { key: 'ArrowLeft' });
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(within(tree).queryByRole('treeitem', { name: 'Left Ear' })).toBeNull();
    fireEvent.keyDown(head, { key: 'ArrowRight' });
    expect(head.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(head, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(within(tree).getByRole('treeitem', { name: 'Muzzle' }));
    const muzzle = document.activeElement!;
    fireEvent.keyDown(muzzle, { key: 'ArrowLeft' }); // the muzzle carries the nose: first ← closes it
    expect(muzzle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(muzzle, { key: 'ArrowLeft' }); // then ← goes to the parent
    expect(document.activeElement).toBe(head);
    fireEvent.keyDown(head, { key: 'End' });
    expect(editorStore.getState().selection).toEqual(['tail']);
    fireEvent.keyDown(document.activeElement!, { key: ' ', shiftKey: true });
    expect(editorStore.getState().selection).toEqual([]); // ⇧+Space toggles the part out again
  });

  it('a part picked in the viewport opens its collapsed branch in the outliner', () => {
    mount();
    act(() => editorStore.getState().toggleCollapsed('head', true));
    expect(screen.queryByRole('treeitem', { name: 'Left Ear' })).toBeNull();
    fireEvent.click(screen.getByTestId('pick-ear_l_inner'));
    expect(screen.getByRole('treeitem', { name: 'Left Ear Inner' }).getAttribute('aria-selected')).toBe('true');
  });

  it('Q / W / E / R pick the tool, Escape clears the selection; keys typed in a field are left alone', () => {
    mount();
    act(() => editorStore.getState().select('head'));
    fireEvent.keyDown(window, { key: 'w' });
    expect(editorStore.getState().tool).toBe('move');
    expect(screen.getByRole('radio', { name: 'Move' }).getAttribute('aria-checked')).toBe('true');
    fireEvent.keyDown(window, { key: 'e' });
    expect(editorStore.getState().tool).toBe('rotate');
    fireEvent.keyDown(window, { key: 'r' });
    expect(editorStore.getState().tool).toBe('scale');
    const width = screen.getByRole('spinbutton', { name: 'Width (inches)' });
    fireEvent.keyDown(width, { key: 'q' });
    expect(editorStore.getState().tool).toBe('scale');
    fireEvent.keyDown(window, { key: 'q' });
    expect(editorStore.getState().tool).toBe('select');
    fireEvent.keyDown(window, { key: 'f' });
    expect(editorStore.getState().camera.view).toBe('fit');
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(editorStore.getState().selection).toEqual([]);
  });

  it('Escape during a gizmo drag cancels the drag and keeps the selection; tool keys do nothing on a read-only project', () => {
    mount();
    act(() => editorStore.getState().select('head'));
    let cancelled = 0;
    act(() => editorStore.getState().setDragging(true, () => cancelled++));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(cancelled).toBe(1);
    expect(editorStore.getState().selection).toEqual(['head']);
    act(() => editorStore.getState().setDragging(false));
    act(() => projectStore.getState().setReadOnly(true));
    fireEvent.keyDown(window, { key: 'w' });
    expect(editorStore.getState().tool).toBe('select');
  });

  it('the view says what the tool needs: a part to act on, or why it cannot resize it', () => {
    mount();
    fireEvent.keyDown(window, { key: 'w' });
    expect(screen.getByRole('status').textContent).toBe('Select a part to move it');
    act(() => editorStore.getState().select('head'));
    expect(screen.queryByText('Select a part to move it')).toBeNull();
  });

  it('the camera buttons ask the viewport for a view (they never move the model)', () => {
    mount();
    const before = model();
    for (const [name, view] of [
      ['Front', 'front'],
      ['Left', 'left'],
      ['Back', 'back'],
      ['Top', 'top'],
      ['Reset', 'home'],
    ] as const) {
      const n = editorStore.getState().camera.nonce;
      fireEvent.click(within(screen.getByRole('group', { name: 'Camera' })).getByRole('button', { name }));
      expect(editorStore.getState().camera).toEqual({ view, nonce: n + 1 });
    }
    expect(model()).toBe(before);
    expect(history()).toEqual([]);
  });

  it('an undo that removes the selected part drops it from the selection', async () => {
    mount();
    act(() => editorStore.getState().select('ear_l'));
    // Replace the model by one without the ear (as a revision), then check the selection follows.
    const next = { ...model(), parts: model().parts.filter((p) => !p.id.startsWith('ear_l')) };
    await act(async () => {
      await projectStore.getState().commitModelRevision(next, { source: 'edit', label: 'Drop the ear', carry: 'none' });
    });
    await waitFor(() => expect(editorStore.getState().selection).toEqual([]));
    expect(screen.getByRole('heading', { name: 'Nothing selected' })).toBeTruthy();
  });

  it('a read-only project shows the model but disables editing', () => {
    projectStore.getState().setReadOnly(true);
    mount();
    act(() => editorStore.getState().select('head'));
    expect((screen.getByRole('spinbutton', { name: 'Width (inches)' }) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('slider', { name: 'Width' }) as HTMLInputElement).disabled).toBe(true);
  });

  it('centimeters: the fields follow the project’s units, the model stays in inches', () => {
    openTeddy(projectStore, { units: 'cm' });
    mount();
    act(() => editorStore.getState().select('head'));
    const width = screen.getByRole('spinbutton', { name: 'Width (centimeters)' }) as HTMLInputElement;
    expect(width.value).toBe('12.2'); // 4.8 in
    fireEvent.focus(width);
    fireEvent.change(width, { target: { value: '15.24' } });
    fireEvent.keyDown(width, { key: 'Enter' });
    expect(byId(model()).head.dims).toMatchObject({ rx: 3 });
  });
});

describe('ShapeTab without a model', () => {
  it('offers the sample teddy; opening it is one undo step and a new model revision', async () => {
    openTeddy(projectStore, { model: null });
    mount();
    expect(screen.getByRole('heading', { name: 'No 3D model yet' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Go to Photos' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try the sample teddy' }));
    await waitFor(() => expect(screen.getByRole('tree', { name: 'Parts' })).toBeTruthy());
    expect(model().name).toBe('Sample teddy');
    expect(projectStore.getState().doc!.threeD!.revisions).toHaveLength(1);
    expect(history()).toEqual(['Open the sample teddy']);
    act(() => {
      projectStore.getState().undo();
    });
    expect(screen.getByRole('heading', { name: 'No 3D model yet' })).toBeTruthy();
  });

  it('a 2D project says the tab is for 3D projects', () => {
    const doc = { ...projectStore.getState().doc!, mode: '2d' as const, threeD: undefined };
    projectStore.getState().open(doc, { discardUnsaved: true });
    mount();
    expect(screen.getByRole('heading', { name: 'The Shape tab is for 3D projects' })).toBeTruthy();
  });
});
