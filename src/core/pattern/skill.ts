// Track T2 — the skill level from the skill points of DESIGN.md §2.8 (§5.2.1). T4's 3D PatternDoc calls it too.
//
// Step 0 stub. T2 replaces it with the real function and keeps the frozen signature (src/types/entryPoints.ts).
import type { ComputeSkillFn } from '../../types/entryPoints';
import { stub } from '../stub';

export type { SkillInput } from '../../types/entryPoints';

export const computeSkill = stub<ComputeSkillFn>('computeSkill');
