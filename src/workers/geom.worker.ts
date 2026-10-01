// Track T3 — geom.worker: masks, alignment, SDF volumes, marching cubes, Taubin, simplification, manifold checks,
// labels, parts, fitting and Apply photo colors (DESIGN.md §2.9, §5.4). Large results go out as transferables.
//
// T3.1: `mask` (the classical ladder of §2.9.1 on the decoded image; also `raw`, `scale` and the guard `issues`) and
// `manifoldSelfTest` (initialises manifold-3d through the Step 0 loader and checks a unit cube; used by
// e2e/tracks/t3-workers.spec.ts). T3.2: `build` (core/recon/build.ts: hull or inflation → mesh → validation → a
// one-part model), cancelled through the worker's gate (`gate.check` between stages; the client's latest-wins
// channel sends `supersede`). The Photos tab asks for N = 64 while sliders move and N = 128 on release
// (`RECON_PREVIEW_N`, `RECON_FINAL_N`). `projectColors` is still a stub (T3.4); it rejects with
// NotImplementedError.
import { getManifold, manifoldReport, type ManifoldReport } from '../core/kernel/geom/manifold';
import { buildRecon } from '../core/recon/build';
import { classicalMask } from '../core/recon/masks';
import { stub } from '../core/stub';
import type { GeomApi } from '../types/workers';
import { decodeImage } from './decode';
import { exposeApi, transferAll } from './rpc';

/** A unit cube, counter-clockwise seen from outside. */
function unitCube(): { positions: Float32Array<ArrayBuffer>; indices: Uint32Array<ArrayBuffer> } {
  const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]);
  const indices = new Uint32Array([
    0, 2, 1, 0, 3, 2, // z = 0 (normal −z)
    4, 5, 6, 4, 6, 7, // z = 1
    0, 1, 5, 0, 5, 4, // y = 0
    3, 7, 6, 3, 6, 2, // y = 1
    0, 4, 7, 0, 7, 3, // x = 0
    1, 2, 6, 1, 6, 5, // x = 1
  ]);
  return { positions, indices };
}

/**
 * Initialises manifold-3d in this worker (the §5.4 loader: `locateFile` → the wasm URL Vite serves) and reports a
 * unit cube: `NoError`, 1 part, genus 0, volume 1. Test support; not part of `GeomApi`.
 */
async function manifoldSelfTest(): Promise<ManifoldReport & { ms: number }> {
  const t0 = performance.now();
  await getManifold();
  const report = await manifoldReport(unitCube());
  return { ...report, ms: performance.now() - t0 };
}

exposeApi<GeomApi>((gate) => {
  const methods: Omit<GeomApi, 'supersede'> & { manifoldSelfTest: typeof manifoldSelfTest } = {
    async mask(image, o) {
      const img = await decodeImage(image);
      const { mask, w, h, raw, scale, issues } = classicalMask(img, { keepHoles: o?.keepHoles ?? false });
      return transferAll({ mask, w, h, raw, scale, issues });
    },
    async build(r) {
      return transferAll(await buildRecon(r, { gate }));
    },
    projectColors: stub<GeomApi['projectColors']>('GeomApi.projectColors'),
    manifoldSelfTest,
  };
  return methods;
});
