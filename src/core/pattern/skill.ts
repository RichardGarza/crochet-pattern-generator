// Track T2 — the skill level from the skill points of DESIGN.md §2.8 (research 07 §1.4; §5.2.1). T4's 3D
// PatternDoc calls it too.
//
//   colors 2 / 3–4 / ≥ 5                       → 0 / 1 / 2
//   mean color changes per line ≤ 2 / 3–6 / > 6 → 0 / 1 / 2
//   technique stripes / tapestry / intarsia / C2C / mosaic → 0 / 1 / 2 / 1 / 2
//   amigurumi pieces 1 / 2–4 / ≥ 5             → 0 / 1 / 2
//   irregular shaping, BLO/FLO details         → +1 each
//   total 0–1 Basic, 2–3 Easy, 4–5 Intermediate, ≥ 6 Complex
//
// Technique points by technique id: `sc_graphgan` and `hdc_graphgan` are worked with a bobbin per area
// (intarsia, 2), `sc_tapestry` and `sc_tapestry_round` carry their colors (1), `c2c` 1, `mosaic_overlay` 2.
// A flat or round chart with no color change inside its lines is worked in stripes (0), whatever its technique.
// `amigurumi_sc` has no technique points: its colors, changes and pieces are counted instead; neither has an input
// without a technique.
import type { ComputeSkillFn, PatternDoc, SkillInput, TechniqueId } from '../../types';

export type { SkillInput } from '../../types/entryPoints';

const NAMES: Readonly<Record<1 | 2 | 3 | 4, PatternDoc['skill']['name']>> = Object.freeze({
  1: 'Basic',
  2: 'Easy',
  3: 'Intermediate',
  4: 'Complex',
});

/** A finite number ≥ 0, else 0 (the function never throws). */
function amount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The word for a line of the technique: rows, rounds or diagonal rows. */
function lineWord(technique: TechniqueId | undefined): string {
  if (technique === 'sc_tapestry_round' || technique === 'amigurumi_sc') return 'round';
  if (technique === 'c2c') return 'diagonal row';
  return 'row';
}

function techniquePoints(technique: TechniqueId, changes: number): { points: number; reason: string } {
  if (technique === 'amigurumi_sc') return { points: 0, reason: '' };
  if (changes === 0 && technique !== 'c2c' && technique !== 'mosaic_overlay') return { points: 0, reason: '' };
  switch (technique) {
    case 'sc_graphgan':
    case 'hdc_graphgan':
      return { points: 2, reason: 'intarsia: a separate bobbin for each color area (+2)' };
    case 'sc_tapestry':
    case 'sc_tapestry_round':
      return { points: 1, reason: 'tapestry: the colors not in use are carried inside the stitches (+1)' };
    case 'c2c':
      return { points: 1, reason: 'corner-to-corner tiles with increases and decreases on the diagonal (+1)' };
    case 'mosaic_overlay':
      return { points: 2, reason: 'overlay mosaic: long stitches worked into the rows below (+2)' };
    default:
      return { points: 0, reason: '' };
  }
}

/**
 * The CYC skill level (1 Basic … 4 Complex) and the reasons for it (§2.8, research 07 §1.4). Every feature that
 * adds points gives one reason with its points; a pattern with none says why it is basic. Never throws:
 * missing, negative or non-finite numbers count as 0.
 */
export const computeSkill: ComputeSkillFn = (i: SkillInput) => {
  const input: Partial<SkillInput> = typeof i === 'object' && i !== null ? i : {};
  const technique: TechniqueId | undefined = typeof input.technique === 'string' ? input.technique : undefined;
  const colors = Math.floor(amount(input.colors));
  const changes = amount(input.meanChangesPerLine);
  const reasons: string[] = [];
  let total = 0;

  const colorPoints = colors >= 5 ? 2 : colors >= 3 ? 1 : 0;
  if (colorPoints > 0) reasons.push(`${colors} colors (+${colorPoints})`);
  total += colorPoints;

  const changePoints = changes > 6 ? 2 : changes > 2 ? 1 : 0;
  if (changePoints > 0) {
    // Rounded up, so a mean just above a band edge never reads as the edge (2.01 → 2.1, not 2).
    const shown = Math.ceil(changes * 10 - 1e-9) / 10;
    reasons.push(`about ${shown} color changes per ${lineWord(technique)} (+${changePoints})`);
  }
  total += changePoints;

  const tech = technique === undefined ? { points: 0, reason: '' } : techniquePoints(technique, changes);
  if (tech.points > 0) reasons.push(tech.reason);
  total += tech.points;

  if (input.pieces !== undefined) {
    const pieces = Math.floor(amount(input.pieces));
    const piecePoints = pieces >= 5 ? 2 : pieces >= 2 ? 1 : 0;
    if (piecePoints > 0) reasons.push(`${plural(pieces, 'piece', 'pieces')} to make and assemble (+${piecePoints})`);
    total += piecePoints;
  }
  if (input.irregularShaping === true) {
    reasons.push('irregular shaping (ovals, uneven increases) (+1)');
    total += 1;
  }
  if (input.bloFlo === true) {
    reasons.push('back- or front-loop-only details (+1)');
    total += 1;
  }

  const level: 1 | 2 | 3 | 4 = total >= 6 ? 4 : total >= 4 ? 3 : total >= 2 ? 2 : 1;
  if (reasons.length === 0) reasons.push('basic stitches, at most two colors and few color changes');
  return { level, name: NAMES[level], reasons };
};
