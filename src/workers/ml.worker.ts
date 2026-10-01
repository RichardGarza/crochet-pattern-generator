// Track T3 — ml.worker: optional depth (Depth Anything V2 Small) and click-to-segment (SlimSAM) through transformers.js,
// loaded lazily; progress goes through a Comlink.proxy callback; ORT paths as absolute URLs to /ort/ (DESIGN.md
// §2.9.1, §2.9.4, §5.4).
//
// Step 0 stub: every method except `supersede` throws NotImplementedError (the caller sees a rejected promise).
// T3 replaces this file with the real worker; the API is frozen in src/types/workers.ts.
import { expose } from 'comlink';
import { stub } from '../core/stub';
import type { MlApi } from '../types/workers';

const api: MlApi = {
  // A stub runs no jobs, so there is nothing to cancel.
  supersede: async () => {},
  status: stub<MlApi['status']>('MlApi.status'),
  depth: stub<MlApi['depth']>('MlApi.depth'),
  samEncode: stub<MlApi['samEncode']>('MlApi.samEncode'),
  samMask: stub<MlApi['samMask']>('MlApi.samMask'),
};

expose(api);
