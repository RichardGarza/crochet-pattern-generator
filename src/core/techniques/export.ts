// Track T2 — chart file exports: 1-px-per-stitch PNG (through core/kernel/png.ts), CSV and chart JSON
// (DESIGN.md §5.2.1). T8's export dialog calls this; T8 never formats chart files itself.
//
// Step 0 stub. T2 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { ExportChartFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const exportChart = stub<ExportChartFn>('exportChart');
