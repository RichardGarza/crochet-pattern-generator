// Track T4 — the amigurumi engine: model → plan, frames, rounds, colors, assembly and the 3D PatternDoc
// (DESIGN.md §2.10–§2.12; §5.2.1). `deps.pathB` is the private mesh.worker's pathB (§5.4); `deps.gate` lets a
// superseded run stop between stages.
//
// Step 0 stub. T4 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { GenerateAmigurumiFn } from '../../types/entryPoints';
import { stub } from '../stub';

export const generateAmigurumi = stub<GenerateAmigurumiFn>('generateAmigurumi');
