// Track T6 — renders a part with its rings and the target stitches highlighted, as a PNG for the PDF's
// assembly steps (DESIGN.md §2.12 step 6; §5.2.1). T8 falls back to text while this is a stub.
//
// Step 0 stub. T6 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import { stub } from '../../core/stub';
import type { RenderPlacementImageFn } from '../../types/entryPoints';

export type { PlacementHighlight } from '../../types/entryPoints';

export const renderPlacementImage = stub<RenderPlacementImageFn>('renderPlacementImage');
