// Track T8 — the pattern PDF: cover, materials, gauge, notes, tiled chart, rows, 3D pieces and assembly
// (DESIGN.md §1.3 F8, §6.3 T8; §5.2.1). `placementImages` come from T6's renderPlacementImage; without them
// the assembly falls back to text.
//
// Step 0 stub. T8 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { BuildPdfFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const buildPdf = stub<BuildPdfFn>('buildPdf');
