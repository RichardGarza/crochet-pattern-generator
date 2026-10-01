// Test helper: the inputs of the T4.1 goldens (DESIGN.md §2.10.5, §2.10.6, §2.13 G5, G6, G7, G19, G20) and the
// golden file the implementation generates from them. `goldens.test.ts` compares the file with the committed one
// (rewrite with UPDATE_GOLDEN=1) and every list in it with the spec text (helpers/spec.ts).
import { resolveGauge, stuffedCell } from '../../../gauge';
import type { Part } from '../../../../types/model';
import { pieceFinish } from '../../poles';
import { roundsForPart, type PieceCounts, type RoundsForPartOptions } from '../../rounds';

/** Spec goldens use w = h = 0.2 in and s = 1 unless they say otherwise. */
export const UNIT = { wS: 0.2, hS: 0.2 } as const;

/** Worsted amigurumi defaults (Table E, CYC 4): the gauge kernel's own numbers. */
export function worsted(stuffing: 'firm' | 'light'): { wS: number; hS: number } {
  return stuffedCell(resolveGauge({ cyc: 4, technique: 'amigurumi_sc' }), stuffing);
}

const BASE = { id: 'p', position: [0, 0, 0] as [number, number, number], color: 'c1' };

export function part<T extends Part['type']>(type: T, dims: Extract<Part, { type: T }>['dims']): Part {
  return { ...BASE, type, dims } as Part;
}

/** A 64-point lathe semicircle (the largest profile §3.5.2 allows), bottom pole to top pole. */
export function latheSemicircle(r: number, points = 64): Part {
  const profile: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const t = (Math.PI * i) / (points - 1);
    profile.push([i === 0 || i === points - 1 ? 0 : r * Math.sin(t), -r * Math.cos(t)]);
  }
  return part('lathe', { profile });
}

/** The textbook sphere with k = 6 exactly: r = 6k·wS / 2π. */
export const textbookSphere = (wS: number) => part('sphere', { r: (36 * wS) / (2 * Math.PI) });

export interface GoldenCase {
  id: string;
  /** What the case is, in the spec's words. */
  what: string;
  part: Part;
  opts: RoundsForPartOptions;
}

export function goldenCases(): GoldenCase[] {
  const firm = worsted('firm');
  const light = worsted('light');
  const cone = part('cone', { r: 1, h: 3 });
  const cyl = part('cylinder', { rTop: 0.75, rBottom: 0.75, h: 2 });
  const arm = part('capsule', { r: 0.32, length: 1.4 });
  return [
    { id: 'G5-textbook-sphere', what: 'textbook sphere k = 6, w/h = 1.0', part: textbookSphere(0.2), opts: { ...UNIT, style: 'classic' } },
    { id: 'G5-textbook-sphere-worsted', what: 'textbook sphere k = 6, worsted defaults (w/h = 1.05, firm)', part: textbookSphere(firm.wS), opts: { ...firm, style: 'classic' } },
    { id: 'G6-lathe-semicircle-exact', what: 'lathe semicircle r = 1.5, exact', part: latheSemicircle(1.5), opts: { ...UNIT, style: 'exact' } },
    { id: 'G6-lathe-semicircle-classic', what: 'lathe semicircle r = 1.5, classic', part: latheSemicircle(1.5), opts: { ...UNIT, style: 'classic' } },
    { id: 'G6-sphere-exact', what: 'sphere r = 1.5, exact (the analytic semicircle)', part: part('sphere', { r: 1.5 }), opts: { ...UNIT, style: 'exact' } },
    { id: 'G7-cone-classic', what: "cone r = 1, h = 3, openEnd 'bottom' (start at the apex), classic", part: cone, opts: { ...UNIT, style: 'classic', start: 'top', openFar: true } },
    { id: 'G7-cone-exact', what: "cone r = 1, h = 3, openEnd 'bottom' (start at the apex), exact", part: cone, opts: { ...UNIT, style: 'exact', start: 'top', openFar: true } },
    { id: 'G7-horn', what: "horn: cone r = 0.6, h = 1.8, crochet.start 'bottom', closed base disc, exact", part: part('cone', { r: 0.6, h: 1.8 }), opts: { ...UNIT, style: 'exact', start: 'bottom' } },
    { id: 'G7-cylinder-exact', what: 'closed cylinder ⌀1.5 × 2, exact', part: cyl, opts: { ...UNIT, style: 'exact' } },
    { id: 'G7-cylinder-classic', what: 'closed cylinder ⌀1.5 × 2, classic', part: cyl, opts: { ...UNIT, style: 'classic' } },
    { id: 'G19-box-closed-oval', what: 'box w 2, d 1, h 1.5, exact', part: part('box', { w: 2, h: 1.5, d: 1 }), opts: { ...UNIT, style: 'exact' } },
    { id: 'G19-oval-ellipsoid', what: 'ellipsoid rx 1.2, ry 0.6, rz 2.0, unattached, exact', part: part('ellipsoid', { rx: 1.2, ry: 0.6, rz: 2.0 }), opts: { ...UNIT, style: 'exact' } },
    { id: 'G20-open-capsule', what: "§3.6 arm_l: capsule r 0.32, length 1.4, openEnd 'top', light, worsted", part: arm, opts: { ...light, style: 'classic', openFar: true } },
    { id: 'G20-closed-capsule', what: '§3.6 arm_l closed (both ends), light, worsted', part: arm, opts: { ...light, style: 'classic' } },
  ];
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;
const r4 = (x: number) => Math.round(x * 1e4) / 1e4;

/** The golden record of one case: everything a later sprint or a reviewer needs to see. */
export function goldenRecord(c: GoldenCase, out: PieceCounts) {
  const blo = out.loops.flatMap((l, i) => (l === 'BLO' ? [i + 1] : []));
  const flo = out.loops.flatMap((l, i) => (l === 'FLO' ? [i + 1] : []));
  const last = out.counts.length - 1;
  const finish =
    out.finish === 'open'
      ? pieceFinish({ kind: 'open', openSts: out.counts[last], wS: c.opts.wS })
      : out.finish === 'flattenSc'
        ? pieceFinish({ kind: 'flattenSc', wS: c.opts.wS, S: (out.ovalS as number[])[last] })
        : out.finish === 'gather'
          ? pieceFinish({ kind: 'gather', wS: c.opts.wS })
          : undefined;
  return {
    what: c.what,
    gauge: { wS: r6(c.opts.wS), hS: r6(c.opts.hS) },
    generator: out.generator,
    rounds: out.counts.length,
    N: out.N,
    hEff: r6(out.hEff),
    L: r6(out.L),
    symmetric: out.symmetric,
    start: out.start,
    counts: out.counts,
    circ: out.circ,
    ...(out.ovalS ? { ovalS: out.ovalS } : {}),
    raw: out.raw,
    ideal: out.ideal.map(r4),
    blo,
    flo,
    closedEnd: out.closedEnd,
    dropped: out.dropped,
    appended: out.appended,
    finish: finish ? { kind: finish.kind, tailIn: finish.tailIn, text: finish.text } : out.finish,
  };
}

export type GoldenFile = Record<string, ReturnType<typeof goldenRecord>>;

export function generateGoldens(): GoldenFile {
  const file: GoldenFile = {};
  for (const c of goldenCases()) {
    const out = roundsForPart(c.part, c.opts);
    if (!out) throw new Error(`golden ${c.id}: no counts`);
    file[c.id] = goldenRecord(c, out);
  }
  return file;
}

/** JSON with every number array on one line (readable diffs). */
export function stringifyGoldens(file: GoldenFile): string {
  const text = JSON.stringify(file, null, 2);
  return text.replace(/\[\s*(-?[\d.e+-]+(?:,\s*-?[\d.e+-]+)*)\s*\]/g, (_, body: string) => `[${body.split(/,\s*/).join(', ')}]`) + '\n';
}
