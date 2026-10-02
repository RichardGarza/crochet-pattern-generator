// Track T4 — trimming a piece to its visible portion (DESIGN.md §2.10.3).
//
// "For every non-root piece walk its profile from the start pole in steps of hS/4, sampling 16 azimuths; s_cut =
// the first arc position where ≥ 50% of the samples are inside the parent. If the buried length L − s_cut ≥ 10% of
// the profile, the profile ends at s_cut with an open end sewn to the parent; otherwise the piece is closed and
// sewn by contact." The same ring samples give the contact width of a closed sewn piece (§2.10.6 sewing tail:
// d = the largest distance between two samples inside the parent) and, against a start-cap cover, the extent of
// a region band (§2.10.1 rule 3).
import type { Vec3 } from '../../types/model';
import type { WorldSdf } from '../model/sdf';
import { dist, surfacePoint, type PieceGeom } from './frame';
import type { Profile } from './profiles';

/** Azimuths sampled per ring (§2.10.3). */
export const TRIM_AZIMUTHS = 16;
/** A piece is cut open when at least this share of its profile is buried (§2.10.3). */
export const TRIM_MIN_BURIED = 0.1;
/** Share of a ring's samples that must be inside the parent. */
export const TRIM_INSIDE_SHARE = 0.5;

export interface TrimResult {
  /** Profile length. */
  L: number;
  /** First arc position with ≥ 50% of the ring inside the parent (L when none is). */
  sFirst: number;
  /** `(L − sFirst) / L`. */
  buried: number;
  /** The cut, when the piece is trimmed (buried ≥ 10%). */
  sCut?: number;
  /** Every ring sample that lies inside the parent (model space). */
  inside: Vec3[];
  /** The largest distance between two samples inside the parent (closed pieces; 0 when trimmed or fewer than two are). */
  contactWidth: number;
}

/** Arc positions of the walk: 0, hS/4, 2·hS/4, … and L itself. */
export function walkPositions(L: number, hS: number): number[] {
  const step = hS / 4;
  if (!(step > 0) || !Number.isFinite(step) || !(L > 0)) return [0];
  const out: number[] = [];
  const n = Math.floor(L / step + 1e-9);
  for (let i = 0; i <= n; i++) out.push(i * step);
  if (out[out.length - 1] < L - 1e-9) out.push(L);
  return out;
}

/** The ring samples of a piece at arc position s. */
export function ringSamples(g: PieceGeom, s: number, p: Profile = g.profile, n = TRIM_AZIMUTHS): Vec3[] {
  const out: Vec3[] = [];
  for (let j = 0; j < n; j++) out.push(surfacePoint(g, s, (2 * Math.PI * j) / n, p));
  return out;
}

/** §2.10.3 against the parent's signed distance (positive inside). */
export function trimWalk(g: PieceGeom, parent: WorldSdf, hS: number): TrimResult {
  const p = g.profile;
  const L = p.L;
  let sFirst = L;
  const inside: Vec3[] = [];
  for (const s of walkPositions(L, hS)) {
    let count = 0;
    for (const q of ringSamples(g, s, p)) {
      if (parent(q[0], q[1], q[2]) > 0) {
        count++;
        inside.push(q);
      }
    }
    if (sFirst === L && count >= TRIM_INSIDE_SHARE * TRIM_AZIMUTHS && s < L) sFirst = s;
  }
  const buried = L > 0 ? (L - sFirst) / L : 0;
  // a cut that would leave less than about a round visible is no cut: the piece is (nearly) all inside its parent
  const trimmed = buried >= TRIM_MIN_BURIED - 1e-12 && sFirst >= Math.min(L, hS) - 1e-9;
  return { L, sFirst, buried, ...(trimmed ? { sCut: sFirst } : {}), inside, contactWidth: trimmed ? 0 : widest(inside) };
}

/** The largest pairwise distance of a point set (exact; the sets here are a few hundred points). */
export function widest(pts: readonly Vec3[]): number {
  let best = 0;
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) best = Math.max(best, dist(pts[i], pts[j]));
  return best;
}

/**
 * The band of a start-cap cover (§2.10.1 rule 3): from s = 0 to the arc where the cover's rim meets the parent —
 * the walk goes on while at least half of each ring's samples are inside the cover. Returns the arc position
 * where the band ends (0 when the first ring is not covered).
 */
export function coverBandEnd(host: PieceGeom, cover: WorldSdf, hS: number, p: Profile = host.profile): number {
  let end = 0;
  for (const s of walkPositions(p.L, hS)) {
    const pts = ringSamples(host, s, p);
    let count = 0;
    for (const q of pts) if (cover(q[0], q[1], q[2]) > 0) count++;
    if (count < TRIM_INSIDE_SHARE * TRIM_AZIMUTHS) break;
    end = s;
  }
  return end;
}
