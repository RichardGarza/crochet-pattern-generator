// Track T1 — the ΔE00-closest shade of the given yarn lines (DESIGN.md §2.4.4, §5.2.1). T4 uses it to name
// colors, T6 for "match to a yarn line". Sprint T1.2.
//
// `nearestYarn(hex, lineIds)` searches the SHIPPED lines (src/data/yarns, see lines.ts) named by `lineIds`, in
// the order given; unknown ids are skipped; no known line (or an invalid hex) gives null. Ties keep the first
// shade met (line order, then the line's own order). `nearestYarnIn` does the same over any list of yarns (a
// request's lines, the stash, a CSV palette).
import type { Hex } from '../../types/model';
import type { NearestYarnFn } from '../../types/entryPoints';
import type { Yarn } from '../../types/yarn';
import { ciede2000, hexToLab, isHex, type Color3 } from '../kernel/color';
import { getShippedLine } from './lines';

/** ΔE00 above which a match is "approximate" / "no close yarn in this line" (§2.4.4). */
export const APPROXIMATE_DE00 = 10;

const labCache = new Map<string, Color3>();
/** CIELAB of a hex (memoized: yarn hexes are looked up over and over). */
export function labOfHex(hex: string): Color3 {
  const key = hex.toLowerCase();
  let lab = labCache.get(key);
  if (lab === undefined) {
    lab = hexToLab(key);
    if (labCache.size > 4096) labCache.clear();
    labCache.set(key, lab);
  }
  return lab;
}

/**
 * The ΔE00-closest yarn of `yarns` to a CIELAB color; `skip` filters candidates out (e.g. textured yarns for a
 * protected detail). Null when nothing is left.
 */
export function nearestYarnToLab(lab: ArrayLike<number>, yarns: readonly Yarn[], skip?: (y: Yarn) => boolean): { yarn: Yarn; deltaE00: number; index: number } | null {
  let best: { yarn: Yarn; deltaE00: number; index: number } | null = null;
  for (let i = 0; i < yarns.length; i++) {
    const y = yarns[i];
    if (skip?.(y) || !isHex(y.hex)) continue;
    const d = ciede2000(lab, labOfHex(y.hex));
    if (best === null || d < best.deltaE00) best = { yarn: y, deltaE00: d, index: i };
  }
  return best;
}

/** The ΔE00-closest yarn of `yarns` to `hex`; null for an empty list or an invalid hex. */
export function nearestYarnIn(hex: string, yarns: readonly Yarn[], skip?: (y: Yarn) => boolean): { yarn: Yarn; deltaE00: number; index: number } | null {
  if (!isHex(hex)) return null;
  return nearestYarnToLab(labOfHex(hex), yarns, skip);
}

/** §5.2.1: the ΔE00-closest shade of the given shipped lines. */
export const nearestYarn: NearestYarnFn = (hex: Hex, lineIds: string[]) => {
  if (!isHex(hex) || !Array.isArray(lineIds)) return null;
  const yarns: Yarn[] = [];
  const seen = new Set<string>();
  for (const id of lineIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const line = getShippedLine(id);
    if (line !== undefined) yarns.push(...line.yarns);
  }
  const m = nearestYarnIn(hex, yarns);
  return m === null ? null : { yarn: m.yarn, deltaE00: m.deltaE00 };
};
