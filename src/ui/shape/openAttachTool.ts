// Track T6 — opens the Attach tool for one part from outside the Shape tab: the importer's `attach-inferred` chips
// (T7, §3.7.6, §4.2 Attach). Selects the part, opens the Attach tool for it and shows the Shape tab of the open
// project (DESIGN.md §5.2.1, design v1.5; signature frozen in src/types/entryPoints.ts).
//
// It only touches the editor's UI state and the route: nothing authored changes until the user saves the dialog
// (one history step, `tools.attachTo`). The editor state is bound to the project first, so the Shape tab that mounts
// after the navigation keeps the selection and the open dialog instead of resetting them.
import { navigate } from '../../app/router';
import { notify } from '../../app/toasts';
import { projectStore, type ProjectStore } from '../../state/projectStore';
import type { OpenAttachToolFn } from '../../types/entryPoints';
import { editorStore as defaultEditor, type EditorStore } from './editorStore';

/** `openAttachTool` with its stores and navigation injectable (tests). Returns what it did. */
export function openAttachToolWith(
  partId: string,
  deps: { project?: ProjectStore; editor?: EditorStore; go?: typeof navigate; warn?: (message: string) => void } = {},
): 'opened' | 'no-part' | 'no-project' {
  const project = deps.project ?? projectStore;
  const editor = deps.editor ?? defaultEditor;
  const go = deps.go ?? navigate;
  const doc = project.getState().doc;
  if (!doc) return 'no-project';
  editor.getState().bindProject(doc.id);
  const model = doc.threeD?.model;
  const part = model?.parts.find((p) => p.id === partId);
  if (part) editor.getState().openAttach(part.id);
  go({ screen: 'project', projectId: doc.id, tab: 'shape' });
  if (!part) {
    (deps.warn ?? ((m: string) => notify.warn(m)))(`There is no part “${partId}” in this model any more.`);
    return 'no-part';
  }
  return 'opened';
}

/** §5.2.1: selects the part, opens the Attach tool for it and shows the Shape tab of the open project. */
export const openAttachTool: OpenAttachToolFn = (partId) => {
  openAttachToolWith(partId);
};
