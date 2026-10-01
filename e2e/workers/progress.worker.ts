// TEST ONLY (e2e/smoke.spec.ts, DESIGN.md §5.4 tests) — never imported by the app.
// A stand-in for ml.worker whose `depth` reports progress through the callback the client passes as a
// Comlink.proxy, so the smoke test can check that a progress callback crosses into a real worker and back.
import { expose } from 'comlink';
import type { MlApi } from '../../src/types/workers';

const api: MlApi = {
  supersede: async () => {},
  status: async () => ({ webgpu: false, depthCached: false, samCached: false }),
  async depth(_image, onProgress) {
    for (const p of [0.25, 0.5, 0.75, 1]) await onProgress?.(p);
    return { data: new Float32Array([0.1, 0.2, 0.3, 0.4]), w: 2, h: 2 };
  },
  samEncode: async () => {},
  samMask: async () => ({ mask: new Uint8Array(0), w: 0, h: 0 }),
};

expose(api);
