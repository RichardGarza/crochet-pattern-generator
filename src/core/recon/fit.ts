// Track T3 — fits a primitive (type, dims, position, rotation) to a mesh part and reports the residual
// (DESIGN.md §2.9.7; §5.2.1). Also used by T5 (MeshApi.fit) and T7 (seed from a mesh part), gated with
// isImplemented(fitPart) until T3 lands.
//
// Step 0 stub. T3 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { FitPartFn } from '../../types/entryPoints';
import { stub } from '../stub';

export type { FitResult } from '../../types/entryPoints';

export const fitPart = stub<FitPartFn>('fitPart');
