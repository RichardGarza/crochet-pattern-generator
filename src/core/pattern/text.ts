// Track T2 — the whole pattern as plain text or Markdown (DESIGN.md §5.2.1). T8's export dialog calls this; T8
// never formats pattern text itself.
//
// Step 0 stub. T2 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { RenderPatternTextFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const renderPatternText = stub<RenderPatternTextFn>('renderPatternText');
