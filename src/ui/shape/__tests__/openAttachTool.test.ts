// Track T6.3 — `openAttachTool(partId)` (§5.2.1, design v1.5): T7's attach chips select the part, open the Attach
// tool for it and show the Shape tab of the open project; the Shape tab mounting afterwards keeps that state.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isImplemented } from '../../../core/stub';
import { openTeddy } from '../../../state/slices/__tests__/teddyProject';
import { createProjectStore, type ProjectStore } from '../../../state/projectStore';
import type { Route } from '../../../state/appStore';
import { createEditorStore, type EditorStore } from '../editorStore';
import { openAttachTool, openAttachToolWith } from '../openAttachTool';

let project: ProjectStore;
let editor: EditorStore;

beforeEach(() => {
  project = createProjectStore();
  editor = createEditorStore();
});

afterEach(() => {
  if (project.getState().doc) project.getState().close({ discardUnsaved: true });
});

describe('openAttachTool', () => {
  it('is implemented (no longer the v1.5 stub) with the frozen signature', () => {
    expect(isImplemented(openAttachTool)).toBe(true);
    expect(openAttachTool.length).toBe(1);
  });

  it('selects the part, opens the Attach tool for it and goes to the Shape tab of the open project', () => {
    openTeddy(project);
    const go = vi.fn<(r: Route) => void>();
    expect(openAttachToolWith('ear_l', { project, editor, go })).toBe('opened');
    const s = editor.getState();
    expect(s.selection).toEqual(['ear_l']);
    expect(s.attachFor).toBe('ear_l');
    expect(s.inspectorPage).toBe('part');
    expect(go).toHaveBeenCalledWith({ screen: 'project', projectId: 'p-teddy', tab: 'shape' });
    // Nothing authored changed: the dialog writes only when the user saves it.
    expect(project.getState().history.past).toHaveLength(0);
  });

  it('keeps that state when the Shape tab binds the same project afterwards, and resets for another project', () => {
    openTeddy(project);
    openAttachToolWith('arm_r', { project, editor, go: () => {} });
    editor.getState().bindProject('p-teddy'); // what ShapeTab does when it mounts
    expect(editor.getState().attachFor).toBe('arm_r');
    expect(editor.getState().selection).toEqual(['arm_r']);
    editor.getState().bindProject('another');
    expect(editor.getState().attachFor).toBeNull();
    expect(editor.getState().selection).toEqual([]);
  });

  it('an unknown part still shows the Shape tab and says why nothing is selected', () => {
    openTeddy(project);
    const go = vi.fn();
    const warn = vi.fn();
    expect(openAttachToolWith('wing_l', { project, editor, go, warn })).toBe('no-part');
    expect(go).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('wing_l'));
    expect(editor.getState().attachFor).toBeNull();
  });

  it('does nothing without an open project', () => {
    const go = vi.fn();
    expect(openAttachToolWith('ear_l', { project, editor, go })).toBe('no-project');
    expect(go).not.toHaveBeenCalled();
  });
});
