// Track T7 — import.worker: the importer of DESIGN.md §3.7 (importInputs). No DOM: HTML goes through the tokenizer of
// §3.7.4. One import is a single synchronous pass (a few hundred ms for the largest T7.1 carrier), so there is no
// stage boundary to cancel at; `supersede` only raises the gate.
import { importInputs } from '../core/importer';
import type { ImportApi } from '../types/workers';
import { exposeApi, transferAll } from './rpc';

exposeApi<ImportApi>(() => ({
  // the result's picture buffers (an archive of images only) are moved, not copied
  importInputs: async (inputs, ctx) => transferAll(await importInputs(inputs, ctx)),
}));
