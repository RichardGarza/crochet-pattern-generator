// Track T4 — landmarks for assembly steps (DESIGN.md §2.12 item 4): the landmark comes first, then the numbers,
// because a maker's rounds and stitches drift. "In line with" a sibling pair whose azimuths match within 15°,
// "level with" a feature or sibling within ½ round, "N rnds below/above" the nearest such landmark; else "on the
// seam line" / "centered on the front" (and, for a child at a pole of its host, "centered on the top of …").
import type { Vec3 } from '../../types/model';

/** Something already on the host that a maker can see: a fitted feature or a sibling sewn on earlier. */
export interface Mark {
  /** "the eyes", "the legs", "the tail". */
  name: string;
  /** Continuous round on the host (s / hEff). */
  c: number;
  /** World height of its anchor (for "above" / "below"). */
  y: number;
  /** Azimuth on the host (radians, about the working direction, from the seam) of its left / only anchor. */
  alpha: number;
  /** A pair (eyes, legs, …): "in line with" applies to pairs. */
  pair: boolean;
}

export interface LandmarkInput {
  /** Continuous round of the child's anchor on the host. */
  c: number;
  y: number;
  alpha: number;
  marks: readonly Mark[];
  /** The child sits at a pole of the host: "centered on the top of the Body". */
  pole?: { where: 'top' | 'bottom' | 'front' | 'back' | 'tip' | 'end'; host: string };
  /** Where the host's seam lies. */
  seamAt: 'back' | 'bottom';
  /** For a pair: the azimuth of the right anchor (the side words then speak of both). */
  alphaRight?: number;
}

const DEG = Math.PI / 180;

/** Smallest absolute difference of two angles, radians. */
export function angleDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The landmark phrase (lower case; the caller capitalizes the first letter). */
export function landmark(i: LandmarkInput): string {
  if (i.pole) return `centered on the ${i.pole.where} of the ${i.pole.host}`;
  const parts: string[] = [];
  let inline: Mark | undefined;
  for (const m of i.marks) {
    if (!m.pair) continue;
    const d = angleDiff(m.alpha, i.alpha);
    if (d <= 15 * DEG + 1e-9 && (!inline || d < angleDiff(inline.alpha, i.alpha))) inline = m;
  }
  if (inline) parts.push(`in line with ${inline.name}`);
  let near: Mark | undefined;
  for (const m of i.marks) if (!near || Math.abs(m.c - i.c) < Math.abs(near.c - i.c)) near = m;
  if (near) {
    const dc = i.c - near.c;
    if (Math.abs(dc) <= 0.5 + 1e-9) parts.push(`level with ${near.name}`);
    else {
      const n = Math.max(1, Math.round(Math.abs(dc)));
      const ref = near === inline ? 'them' : near.name;
      const dy = i.y - near.y;
      // above / below by height; along a level piece by the round order
      const dir = Math.abs(dy) > 0.05 ? (dy > 0 ? 'above' : 'below') : dc > 0 ? 'past' : 'before';
      parts.push(`${plural(n, 'rnd', 'rnds')} ${dir} ${ref}`);
    }
  }
  if (parts.length > 0) return parts.join(', ');
  return sideWords(i.alpha, i.seamAt, i.alphaRight);
}

/** Where on the host by azimuth alone (α = 0 at the seam). */
export function sideWords(alpha: number, seamAt: 'back' | 'bottom', alphaRight?: number): string {
  const back = seamAt === 'back' ? 'center back' : 'the underside';
  const front = seamAt === 'back' ? 'the front' : 'the top';
  const fromSeam = angleDiff(alpha, 0);
  if (alphaRight !== undefined) {
    if (fromSeam >= 150 * DEG) return `either side of ${front}, close together`;
    if (fromSeam >= 105 * DEG) return `either side of ${front}`;
    if (fromSeam >= 75 * DEG) return 'on the two sides';
    if (fromSeam >= 30 * DEG) return `either side of ${back}`;
    return `either side of the seam line`;
  }
  if (fromSeam <= 15 * DEG) return `on the seam line (${back})`;
  if (fromSeam >= 165 * DEG) return `centered on ${front}`;
  return `on the side, ${Math.round(fromSeam / DEG)}° from the seam line`;
}

/** First letter upper case. */
export function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}

/** World height of a point. */
export const heightOf = (p: Vec3): number => p[1];
