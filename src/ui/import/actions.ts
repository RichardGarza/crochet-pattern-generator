// Track T7.4a — small helpers of the import screens, kept out of the component files (React Fast Refresh needs
// component-only modules).
import { navigate } from '../../app/router';
import { isImplemented } from '../../core/stub';
import type { ProjectDoc } from '../../types/project';
import { openAttachTool } from '../shape/openAttachTool';

/** What the drop zone takes: Claude Design exports, 3D files, text, and pictures (so they get a helpful answer). */
export const IMPORT_ACCEPT = '.zip,.html,.htm,.json,.txt,.md,.glb,.gltf,.bin,.obj,.mtl,.ply,.stl,.gz,.tgz,.tar,.png,.jpg,.jpeg,.webp';

/** Opens the Attach tool for a part (T6), or the Shape tab while T6's entry point is still a stub. */
export function openJoin(projectId: string, partId: string): void {
  if (isImplemented(openAttachTool)) {
    openAttachTool(partId);
    return;
  }
  navigate({ screen: 'project', projectId, tab: 'shape' });
}

/** A project the Start card just made: nothing in it yet (§3.7.7: the result may belong elsewhere). */
export function isFreshImportProject(doc: ProjectDoc): boolean {
  return doc.threeD?.origin === 'claude-design' && !doc.threeD.model && doc.imports.length === 0 && !doc.qa;
}

