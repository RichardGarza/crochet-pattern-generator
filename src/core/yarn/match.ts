// Track T1 — the ΔE00-closest shade of the given yarn lines (DESIGN.md §2.4.4, §5.2.1). T4 uses it to name
// colors, T6 for "match to a yarn line"; both are gated with isImplemented(nearestYarn) until T1 lands.
//
// Step 0 stub. T1 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { NearestYarnFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const nearestYarn = stub<NearestYarnFn>('nearestYarn');
