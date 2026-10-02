// Track T4 — assembly (DESIGN.md §2.12): parent coordinates of every placement, the opening size, the step texts
// (landmark first, then the numbers) and the assembly validators E_ASSEMBLY and E_OPEN_EDGE (§2.13).
//
// Parent coordinates (Path A): `round = clamp(round(s/hEff), 1, rounds)` from the anchor projected onto the
// parent's profile; `stitch = 1 + floor((((α_seam(round) − α)/2π) mod 1)·n_round + 1e-9)` (RH; mirrored for LH),
// α_seam with the spiral lean of §2.11.2 (lean.ts). Opening size: a child with m open stitches spans about
// `m·wS/(π·hS)` rounds and `m/π` stitches.
import type { Issue } from '../../types/issues';
import type { AssemblyStep, Piece } from '../../types/pattern';
import type { Hand } from '../../types/units';
import { markerWords, type SeamAt } from './cues';
import { capitalize, landmark, type LandmarkInput, type Mark } from './landmarks';
import { stitchAt } from './lean';

/** A piece that other parts are placed on. */
export interface Host {
  /** Primary part id of the host piece. */
  id: string;
  title: string;
  seamAt: SeamAt;
  /** Stated count of every round (unfolded), index = round − 1. */
  counts: readonly number[];
  hEff: number;
  hS: number;
  /** α_seam of every round (lean.ts), index = round − 1. */
  alphaSeam: readonly number[];
}

/** One child at one place on its host (a pair has two). */
export interface Spot {
  partId: string;
  /** Continuous round on the host: s / hEff. */
  c: number;
  /** Azimuth on the host (radians, about its working direction, from the seam). */
  alpha: number;
  /** World height of the anchor. */
  y: number;
  /** World x of the anchor: > 0 on the toy's left. */
  x: number;
  hostId: string;
}

export type StepKind = AssemblyStep['kind'];

/** What is placed: a piece (or a pair made as one "make 2" piece), or the safety eyes of a host. */
export interface Placement {
  kind: StepKind;
  /** Piece title, singular ("Leg") and plural ("Legs"). */
  title: string;
  titles: string;
  /** One spot, or two for a pair (any order; the left one is found by x). */
  spots: Spot[];
  /** Open-edge sts (open pieces and appliqués). */
  openSts?: number;
  /** The child's stitch width (opening size). */
  wS: number;
  stuffing?: 'firm' | 'medium' | 'light' | 'none';
  /** Sewn flat around its edge (an appliqué). */
  flatSewn?: boolean;
  /** The child sits on a pole of its host. */
  pole?: LandmarkInput['pole'];
  /** Feature-ref: the round after which the eyes went in. */
  afterRnd?: number;
  /** The mark this placement leaves for later landmarks: "the legs". */
  markName: string;
}

/** `clamp(round(c), 1, rounds)`. */
export function roundOf(c: number, rounds: number): number {
  return Math.min(Math.max(1, Math.round(c)), Math.max(1, rounds));
}

/** Rounds an opening of `m` sts (child stitch `wSChild`) spans on a host of round height `hS`, centered on c. */
export function openingRounds(c: number, m: number, wSChild: number, hS: number, rounds: number): [number, number] {
  const span = Math.max(1, Math.round((m * wSChild) / (Math.PI * hS)));
  let r0 = Math.round(c - (span - 1) / 2);
  r0 = Math.min(Math.max(1, r0), Math.max(1, rounds - span + 1));
  const r1 = Math.min(rounds, r0 + span - 1);
  return [Math.max(1, r0), Math.max(1, r1)];
}

/** Stitch of a spot at a given round of its host. */
export function spotStitch(host: Host, spot: Spot, round: number, hand: Hand): number {
  const n = host.counts[round - 1];
  return stitchAt(spot.alpha, host.alphaSeam[round - 1] ?? 0, n, hand);
}

function stuffWords(stuffing: Placement['stuffing'], what: string, pair: boolean): string {
  if (stuffing === 'firm' || stuffing === 'medium') return `stuff the ${what} firmly, pin`;
  if (stuffing === 'light') return `stuff the ${what} lightly, pin`;
  return `pin the ${what} (do not stuff; press ${pair ? 'them' : 'it'} flat)`;
}

const lc = (s: string) => s.toLowerCase();

/**
 * The assembly steps of every placement, in the given order (the caller orders them: the attach tree from the
 * root, children before grandchildren, eyes first on each host, then by round). Each step's landmark refers only
 * to things already on the host: eyes fitted inside it and siblings sewn on in earlier steps.
 */
export function assemblySteps(placements: readonly Placement[], hosts: ReadonlyMap<string, Host>, hand: Hand): AssemblyStep[] {
  const marks = new Map<string, Mark[]>();
  const steps: AssemblyStep[] = [];
  for (const pl of placements) {
    const spots = [...pl.spots].sort((a, b) => b.x - a.x); // toy's left (+X) first
    const left = spots[0];
    const host = hosts.get(left.hostId);
    if (!host) continue;
    const R = host.counts.length;
    const hostMarks = marks.get(host.id) ?? [];
    const pair = spots.length >= 2;
    const marker = markerWords(host.seamAt);
    let text: string;
    let land: string;
    let rounds: [number, number];
    let center: number;
    let apart: number | undefined;
    if (pl.kind === 'feature-ref') {
      const r = Math.min(R, Math.max(1, pl.afterRnd ?? roundOf(left.c, R)));
      land = pair || pl.title.toLowerCase().endsWith('s') ? 'Eyes' : 'Eye';
      rounds = [Math.max(1, r - 1), r];
      center = spotStitch(host, left, r, hand);
      text = `${land}: already fitted in the ${host.title} (after Rnd ${r}).`;
    } else {
      const round = roundOf(left.c, R);
      rounds = pl.kind === 'open-edge' && !pl.flatSewn && pl.openSts ? openingRounds(left.c, pl.openSts, pl.wS, host.hS, R) : [round, round];
      const at = pl.kind === 'open-edge' && !pl.flatSewn ? Math.min(rounds[1], Math.max(rounds[0], round)) : round;
      center = spotStitch(host, left, at, hand);
      const others = spots.slice(1).map((s) => spotStitch(host, s, roundOf(s.c, R), hand));
      const sameHost = spots.every((s) => s.hostId === host.id);
      // a pair on twin hosts (inner ears on the two ears) sits at the same place on each: one landmark for both
      land = capitalize(
        landmark({ c: left.c, y: left.y, alpha: left.alpha, marks: hostMarks, seamAt: host.seamAt, ...(pl.pole ? { pole: pl.pole } : {}), ...(pair && sameHost ? { alphaRight: spots[1].alpha } : {}) }),
      );
      const where = rounds[0] === rounds[1] ? `on Rnd ${rounds[0]}` : `between Rnds ${rounds[0]} and ${rounds[1]}`;
      const sts = pair ? `st ${center} for the left ${lc(pl.title)} and st ${others[0]} for the right ${lc(pl.title)}` : `st ${center}`;
      const onto = sameHost ? `the ${host.title}` : `each ${host.title}`;
      if (pair) apart = others[0];
      if (pl.kind === 'open-edge' && pl.flatSewn) {
        text = `${land}: pin ${pair ? (sameHost ? `each ${pl.title}` : `an ${pl.title}`.replace(/^an ([^aeiouAEIOU])/, 'a $1')) : `the ${pl.title}`} flat on ${onto}, centered on Rnd ${round}, ${sts}, and sew around ${pair ? 'its' : 'its'} edge (${pl.openSts} sts) with the long tail (counting from ${marker}).`;
      } else if (pl.kind === 'open-edge') {
        const what = pair ? pl.titles : pl.title;
        text = `${land}: ${stuffWords(pl.stuffing, what, pair)}, then sew ${pair ? 'the open edge of each' : 'its open edge'} (${pl.openSts} sts) to ${onto} ${where}, centered on ${sts} (counting from ${marker}).`;
      } else if (pl.pole) {
        text = `${land}: pin the ${pl.title} over the ${pl.pole.where === 'top' || pl.pole.where === 'bottom' ? 'closed end' : 'end'} of ${onto} (Rnd ${round}) and sew around the edge of the contact area with the long tail.`;
      } else {
        text = `${land}: pin ${pair ? `the ${pl.titles}` : `the ${pl.title}`} to ${onto}, centered on Rnd ${round}, ${sts}, and sew around the edge of ${pair ? 'each' : 'the'} contact area with the long tail (counting from ${marker}).`;
      }
    }
    steps.push({
      order: steps.length + 1,
      kind: pl.kind,
      child: left.partId,
      parent: host.id,
      rounds,
      centerStitch: center,
      ofStitches: host.counts[(pl.kind === 'feature-ref' ? rounds[1] : roundOf(left.c, R)) - 1],
      ...(pl.openSts !== undefined && pl.kind === 'open-edge' ? { openSts: pl.openSts } : {}),
      ...(apart !== undefined ? { apart } : {}),
      text,
      landmark: land,
    });
    hostMarks.push({ name: pl.markName, c: left.c, y: left.y, alpha: left.alpha, pair });
    marks.set(host.id, hostMarks);
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------------------------
// Validators (§2.13 R13 E_ASSEMBLY, §2.12 item 8 E_OPEN_EDGE)

export interface AssemblyCheckInput {
  pieces: readonly Piece[];
  steps: readonly AssemblyStep[];
  /** The root piece's id (never attached). */
  rootId: string;
  /** Stated count of every round of a piece, by piece id (unfolded). */
  rounds: (pieceId: string) => readonly number[] | undefined;
  /** The attach graph is one tree. */
  oneTree: boolean;
}

/** E_ASSEMBLY and E_OPEN_EDGE over a whole pattern. */
export function validateAssembly(i: AssemblyCheckInput): Issue[] {
  const out: Issue[] = [];
  const err = (code: 'E_ASSEMBLY' | 'E_OPEN_EDGE', message: string, piece?: string) =>
    out.push(Object.freeze({ code, severity: 'error' as const, message, ...(piece ? { where: { piece } } : {}) }));
  if (!i.oneTree) err('E_ASSEMBLY', 'the parts are not attached as one tree; re-infer the attachments');
  const pieceOf = (partId: string) => i.pieces.find((p) => p.partIds.includes(partId));
  // every non-root piece attaches once
  for (const p of i.pieces) {
    if (p.id === i.rootId) continue;
    const n = i.steps.filter((s) => s.kind !== 'feature-ref' && p.partIds.includes(s.child)).length;
    if (n !== 1) err('E_ASSEMBLY', `${p.title} is ${n === 0 ? 'never sewn on' : `sewn on in ${n} steps`}; every piece attaches once`, p.id);
  }
  for (const s of i.steps) {
    const parent = pieceOf(s.parent);
    if (!parent) {
      err('E_ASSEMBLY', `step ${s.order} sews onto ${s.parent}, which is not a crocheted piece`);
      continue;
    }
    if (s.kind !== 'feature-ref' && pieceOf(s.child) === undefined) err('E_ASSEMBLY', `step ${s.order} sews ${s.child}, which is not a crocheted piece`);
    const counts = i.rounds(parent.id) ?? [];
    const [r0, r1] = s.rounds;
    const okRounds = Number.isInteger(r0) && Number.isInteger(r1) && r0 >= 1 && r1 >= r0 && r1 <= counts.length;
    if (!okRounds) {
      err('E_ASSEMBLY', `step ${s.order} names Rnds ${r0}–${r1} of the ${parent.title}, which has ${counts.length} rounds`, parent.id);
      continue;
    }
    const inRange = counts.slice(r0 - 1, r1).includes(s.ofStitches);
    if (!inRange) err('E_ASSEMBLY', `step ${s.order} counts ${s.ofStitches} sts around, but the ${parent.title} has no such round in Rnds ${r0}–${r1}`, parent.id);
    if (!(Number.isInteger(s.centerStitch) && s.centerStitch >= 1 && s.centerStitch <= s.ofStitches)) {
      err('E_ASSEMBLY', `step ${s.order} names st ${s.centerStitch} of a ${s.ofStitches}-st round`, parent.id);
    }
    if (s.apart !== undefined && !(Number.isInteger(s.apart) && s.apart >= 1 && s.apart <= s.ofStitches)) {
      err('E_ASSEMBLY', `step ${s.order} names st ${s.apart} of a ${s.ofStitches}-st round`, parent.id);
    }
  }
  // E_OPEN_EDGE: open-edge steps reference open pieces only; each open piece exactly one; no closed piece sews an open edge
  for (const s of i.steps) {
    if (s.kind !== 'open-edge') continue;
    const child = pieceOf(s.child);
    if (child && child.finish.kind !== 'open') err('E_OPEN_EDGE', `step ${s.order} sews the open edge of the ${child.title}, but it is closed`, child.id);
  }
  for (const p of i.pieces) {
    if (p.id === i.rootId || p.finish.kind !== 'open') continue;
    const n = i.steps.filter((s) => s.kind === 'open-edge' && p.partIds.includes(s.child)).length;
    if (n !== 1) err('E_OPEN_EDGE', `the ${p.title} ends open and needs exactly one step that sews its open edge (it has ${n})`, p.id);
  }
  return out;
}
