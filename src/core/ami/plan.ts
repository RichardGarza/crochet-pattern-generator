// Track T4 — the plan (DESIGN.md §2.10.1). Sprint T4.2 holds the safety-eye sizes (integration task T4-6: "Snap
// safety-eye `sizeMm` to sizes that exist (after `scaleModel` an 18 mm eye can become 36 mm)"); the plan rules
// come with the plan sprint.

/** Safety-eye sizes the plan offers (§2.10.1 rule 1), mm. */
export const SAFETY_EYE_MM: readonly number[] = Object.freeze([6, 8, 9, 10, 12, 15]);

/**
 * The nearest safety-eye size that exists, mm (ties go to the larger size, as `roundHalfUp` would). A size that
 * is missing, not finite or ≤ 0 has no nearest size: `undefined` (the caller falls back to the part's diameter).
 */
export function snapSafetyEyeMm(mm: number | undefined): number | undefined {
  if (mm === undefined || !Number.isFinite(mm) || mm <= 0) return undefined;
  let best = SAFETY_EYE_MM[0];
  for (const s of SAFETY_EYE_MM) if (Math.abs(s - mm) <= Math.abs(best - mm) + 1e-9) best = s;
  return best;
}
