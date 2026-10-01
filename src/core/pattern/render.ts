// Track T2 — renders one Line as text: compact or verbose, US or UK, right- or left-handed (DESIGN.md §2.7.2,
// §2.10.11; §5.2.1). T4's 3D pattern text goes through the same renderer.
//
// Step 0 stub. T2 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { RenderLineFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const renderLine = stub<RenderLineFn>('renderLine');
