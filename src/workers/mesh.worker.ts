// Track T5 — mesh.worker: Path B, voxelize, sculpt, cut, merge, fit and primitive → mesh (DESIGN.md §2.9.8, §2.10.7,
// §5.4). Two instances run at once — the editor's (it keeps sculpt volumes by volumeId) and ami.worker's (Path B
// only) — so the code must not assume it is the only one.
//
// Step 0 stub: every method except `supersede` throws NotImplementedError (the caller sees a rejected promise).
// T5 replaces this file with the real worker; the API is frozen in src/types/workers.ts.
import { expose } from 'comlink';
import { stub } from '../core/stub';
import type { MeshApi } from '../types/workers';

const api: MeshApi = {
  // A stub runs no jobs, so there is nothing to cancel.
  supersede: async () => {},
  pathB: stub<MeshApi['pathB']>('MeshApi.pathB'),
  merge: stub<MeshApi['merge']>('MeshApi.merge'),
  voxelize: stub<MeshApi['voxelize']>('MeshApi.voxelize'),
  sculpt: stub<MeshApi['sculpt']>('MeshApi.sculpt'),
  undoSculpt: stub<MeshApi['undoSculpt']>('MeshApi.undoSculpt'),
  cut: stub<MeshApi['cut']>('MeshApi.cut'),
  fit: stub<MeshApi['fit']>('MeshApi.fit'),
  fromPart: stub<MeshApi['fromPart']>('MeshApi.fromPart'),
};

expose(api);
