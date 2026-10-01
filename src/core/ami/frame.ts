// Track T4 — piece frames (DESIGN.md §2.10.2). Sprint T4.2 holds the limb start pole (integration task T4-1:
// "Start pole of limbs from `limbProximalEnd`, so it agrees with the Proportions edit"); the full frame (axis
// rules 1–4, the other start-pole rules, the seam) comes with the frames sprint and calls `limbStartPole` for
// limbs.
import type { ColoredMesh } from '../../types/geometry';
import type { Part } from '../../types/model';
import { limbProximalEnd } from '../model/proportions';
import type { Pole } from './profiles';

/**
 * The limbs of §4.2 Proportions: capsule or cylinder parts named `arm_*`, `leg_*` or `limb<n>_*` (§2.9.7 step 6),
 * the same test `core/model/proportions.ts` uses.
 */
export const LIMB_NAME = /^(arm|leg|limb\d+)(_|$)/;

export function isLimb(p: Part): boolean {
  return (p.type === 'capsule' || p.type === 'cylinder') && LIMB_NAME.test(p.id);
}

/**
 * Start pole of a limb attached to `parent` (§2.10.2): `crochet.start` when set, else the distal end — the pole
 * opposite `limbProximalEnd` (which honors `attach.openEnd` and the end stored in `x-cpg-proximal` before its SDF
 * comparison), so the piece starts at the hand or foot and the Proportions edit keeps the same end fixed.
 */
export function limbStartPole(p: Part, parent: Part, meshes?: Record<string, ColoredMesh>): Pole {
  const set = p.crochet?.start;
  if (set === 'bottom' || set === 'top') return set;
  return limbProximalEnd(p, parent, meshes) === 'top' ? 'bottom' : 'top';
}
