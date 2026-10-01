// Track T7 — import.worker: the importer of DESIGN.md §3.7 (importInputs). No DOM: HTML goes through the tokenizer of
// §3.7.4.
//
// Step 0 stub: every method except `supersede` throws NotImplementedError (the caller sees a rejected promise).
// T7 replaces this file with the real worker; the API is frozen in src/types/workers.ts.
import { expose } from 'comlink';
import { stub } from '../core/stub';
import type { ImportApi } from '../types/workers';

const api: ImportApi = {
  // A stub runs no jobs, so there is nothing to cancel.
  supersede: async () => {},
  importInputs: stub<ImportApi['importInputs']>('ImportApi.importInputs'),
};

expose(api);
