// Track T2 — builds the 2D PatternDoc from a chart: the technique writers of DESIGN.md §2.7 plus the border
// (§2.7.10, rounds from settings.border and gauge.hSc), materials and yardage (§2.8). Called by
// Chart2dApi.buildPattern (§5.2.1).
//
// Step 0 stub. T2 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { BuildPattern2DFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const buildPattern2D = stub<BuildPattern2DFn>('buildPattern2D');
