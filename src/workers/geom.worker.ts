// Track T3 — geom.worker: masks, alignment, SDF volumes, marching cubes, Taubin, simplification, manifold checks,
// labels, parts, fitting and Apply photo colors (DESIGN.md §2.9, §5.4). Large results go out as transferables.
//
// Step 0 stub: every method except `supersede` throws NotImplementedError (the caller sees a rejected promise).
// T3 replaces this file with the real worker; the API is frozen in src/types/workers.ts.
import { expose } from 'comlink';
import { stub } from '../core/stub';
import type { GeomApi } from '../types/workers';

const api: GeomApi = {
  // A stub runs no jobs, so there is nothing to cancel.
  supersede: async () => {},
  mask: stub<GeomApi['mask']>('GeomApi.mask'),
  build: stub<GeomApi['build']>('GeomApi.build'),
  projectColors: stub<GeomApi['projectColors']>('GeomApi.projectColors'),
};

expose(api);
