// Track T2 — the US/UK terminology table and what follows from it: the abbreviations and special stitches a
// pattern's lines actually use (DESIGN.md §2.7.2, §2.10.11; §5.2.1). T4's 3D PatternDoc calls both.
//
// Step 0 stubs. T2 replaces them with the real functions and keeps the frozen signatures
// (src/types/entryPoints.ts).
import type { AbbreviationsForFn, SpecialStitchesForFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const abbreviationsFor = stub<AbbreviationsForFn>('abbreviationsFor');
export const specialStitchesFor = stub<SpecialStitchesForFn>('specialStitchesFor');
