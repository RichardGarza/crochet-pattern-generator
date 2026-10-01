// Track T1 — entry of the 2D pipeline: ingest, sampling, quantizing, palette, cleanup, capture (DESIGN.md
// §2.3–§2.6; §5.2.1). Core code: it receives an RgbaImage (chart2d.worker decodes Blobs first) and calls
// `gate.check(jobId)` between stages so a superseded run stops (§5.4).
//
// Step 0 stub. T1 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { RunChartFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const runChart = stub<RunChartFn>('runChart');
