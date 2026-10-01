// Track T1 — chart2d.worker: the 2D pipeline of DESIGN.md §2.3–§2.6 (`run`, behind a latest-wins channel) and
// `buildPattern`, which delegates to T2's buildPattern2D (§5.4). Blobs are decoded with workers/decode.ts.
//
// Step 0 stub: every method except `supersede` throws NotImplementedError (the caller sees a rejected promise).
// T1 replaces this file with the real worker; the API is frozen in src/types/workers.ts.
import { expose } from 'comlink';
import { stub } from '../core/stub';
import type { Chart2dApi } from '../types/workers';

const api: Chart2dApi = {
  // A stub runs no jobs, so there is nothing to cancel.
  supersede: async () => {},
  run: stub<Chart2dApi['run']>('Chart2dApi.run'),
  buildPattern: stub<Chart2dApi['buildPattern']>('Chart2dApi.buildPattern'),
};

expose(api);
