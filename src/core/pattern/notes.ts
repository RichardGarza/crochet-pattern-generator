// Track T2 — the Notes blocks, rendered from templates with only the parts that apply (DESIGN.md §2.7.9,
// §2.10.11; §5.2.1). T4's 3D PatternDoc calls it with kind 'amigurumi'.
//
// Step 0 stub. T2 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { NotesForFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const notesFor = stub<NotesForFn>('notesFor');
