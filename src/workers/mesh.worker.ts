// Track T5 — mesh.worker: Path B, voxelize, sculpt, cut, merge, fit and primitive → mesh (DESIGN.md §2.9.8, §2.10.7,
// §5.4). Two instances run at once — the editor's (it keeps sculpt volumes by volumeId) and ami.worker's private one
// (Path B only) — so the code assumes nothing about other instances: the implementation (`MeshService`,
// core/meshtools/service.ts) is per instance, and every id it hands out carries this instance's random tag.
//
// `pathB` is the job method (latest-wins on the client, `jobId` + `supersede`): it checks the job gate every few ms
// (core/meshtools/steps.ts). Results go out with `transferAll`: every mesh the service returns is a fresh copy, so no
// session state is detached.
import { MeshService } from '../core/meshtools/service';
import type { MeshApi } from '../types/workers';
import { exposeApi, transferAll } from './rpc';

/** A random instance tag (ids from one mesh.worker are refused by another). */
function instanceTag(): string {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return `m${[...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

exposeApi<MeshApi>((gate) => {
  const service = new MeshService({ gate, tag: instanceTag() });
  const methods: Omit<MeshApi, 'supersede'> = {
    pathB: async (r) => transferAll(await service.pathB(r)),
    merge: async (parts, o) => transferAll(await service.merge(parts, o)),
    voxelize: (mesh, N, o) => service.voxelize(mesh, N, o),
    sculpt: async (volumeId, stroke) => transferAll(await service.sculpt(volumeId, stroke)),
    undoSculpt: async (undoId) => transferAll(await service.undoSculpt(undoId)),
    redoSculpt: async (undoId) => transferAll(await service.redoSculpt(undoId)),
    cut: async (volumeId, plane) => transferAll(await service.cut(volumeId, plane)),
    fit: (mesh) => service.fit(mesh),
    fromPart: async (part, o) => transferAll(await service.fromPart(part, o)),
  };
  return methods;
});
