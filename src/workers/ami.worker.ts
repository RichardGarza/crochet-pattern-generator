// Track T4 — ami.worker: the amigurumi engine of DESIGN.md §2.10–§2.12 (generateAmigurumi). It owns a private
// mesh.worker for Path B and passes that worker's pathB as deps.pathB (§5.4).
//
// Step 0 stub: every method except `supersede` throws NotImplementedError (the caller sees a rejected promise).
// T4 replaces this file with the real worker; the API is frozen in src/types/workers.ts.
import { expose } from 'comlink';
import { stub } from '../core/stub';
import type { AmiApi } from '../types/workers';

const api: AmiApi = {
  // A stub runs no jobs, so there is nothing to cancel.
  supersede: async () => {},
  generate: stub<AmiApi['generate']>('AmiApi.generate'),
};

expose(api);
