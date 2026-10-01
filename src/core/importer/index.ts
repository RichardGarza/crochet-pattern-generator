// Track T7 — the importer: files or pasted text → a normalized, repaired, validated crochet-model
// (DESIGN.md §3.7.1). It runs in import.worker and in the vitest node environment, so there is no DOM anywhere
// in core/importer (HTML goes through the tokenizer of §3.7.4).
//
// Step 0 stub. T7 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { ImportInputsFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const importInputs = stub<ImportInputsFn>('importInputs');
