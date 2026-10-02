// Track T5 — the Path B driver (DESIGN.md §2.10.7): a general mesh part → rounds.
//
//   1–3  re-mesh, seed, heat-method φ, row isolines, seam             rows.ts (`geodesicRowsSteps`)
//   4    counts: round(isoline length / wS), hysteresis 0.75, pole rule, fan clamp, slope warnings    counts.ts
//   5    stitch samples uniform by arc length from the seam, moved by the spiral lean (§2.11.2)
//   6    couple consecutive rounds by constrained DTW (fan 2, retry 3 with `W_FAN3`, else a half row), check R6
//        (`E_CORNER`) on the alignment, then the transducer reads the ops                      dtw.ts, transduce.ts
//   7    readability: radial residual < 10% about the axis of the round centers ⇒ §2.10.8 placement     regularize.ts
//
// plus the per-stitch labels (majority of 7 samples, §2.11.2) and the live-preview rings (§2.10.10). The result is a
// `RoundsResult` (path 'B') with extra fields — the ops of every round, the issues and diagnostics — that the frozen
// type has no place for yet (docs/tracks/t5.md, requests). `pathBSteps` is resumable (steps.ts); the worker drives it
// with its job gate, `pathB` drains it synchronously.
import { stuffedCell } from '../gauge/resolve';
import type { Stuffing } from '../gauge/tables';
import type { ColoredMesh, Vec3 } from '../../types/geometry';
import type { Issue } from '../../types/issues';
import type { Line, Op } from '../../types/pattern';
import type { RingGeom, RoundsResult } from '../../types/ami';
import type { MeshApi } from '../../types/workers';
import { pathBCounts, poleRuleIssues, slopeIssues, slopeLimit } from './counts';
import { cornerIssues, coupleRows, DTW_MAX_FAN, DTW_RETRY_FAN, type Alignment } from './dtw';
import { sampleLoop, type IsolineLoop } from './isolines';
import { NearestVertexIndex } from './remesh';
import { placeRound, radialFit, REGULARIZE_RESIDUAL } from './regularize';
import { geodesicRowsSteps, loopAreaVector, pathBTargetEdge, type GeodesicRowsResult } from './rows';
import { drain, drainAsync, type Steps } from './steps';
import { transduce } from './transduce';

export type PathBRequest = Parameters<MeshApi['pathB']>[0];

/** Most half rows inserted between two rounds before giving up (§2.10.7 step 6). */
export const MAX_HALF_ROWS = 3;
/** Offsets of the 6 extra color samples around a stitch center, in stitch widths (§2.11.2). */
export const LABEL_SAMPLE_OFFSET = 0.35;

export interface PathBResult extends RoundsResult {
  path: 'B';
  /** Ops of every round in working order; round 1 is n₁ sc into the magic ring. */
  ops: Op[][];
  /** `W_MESH_PIECES`, `W_MESH_OPEN`, `W_RUFFLE`, `W_FAN3` (and `E_*` self-checks, never expected). */
  issues: Issue[];
  /** Isoline length / wS of each worked round (NaN for rounds `closeTail` appended). */
  ideal: number[];
  /** Step 7 replaced the DTW positions by the §2.10.8 placement. */
  regularized: boolean;
  /** Pooled radial residual about the axis of the round centers (step 7). */
  radialResidual: number;
  /** 1-based reference round: the longest isoline; the seam is at center back there and the lean is 0 (§2.11.2). */
  refRound: number;
  /** Fraction of a round each round's start is moved along its isoline by the spiral lean (working direction). */
  leanOffsets: number[];
  seed: { vertex: number; rule: 'seed' | 'farthest-from-attach' | 'lowest'; point: Vec3 };
  /** Rounds the closed-end rule dropped / `closeTail` appended; rounds inserted as half rows (1-based). */
  dropped: boolean;
  appended: number;
  halfRows: number[];
  remesh?: { vertices: number; meanEdge: number; targetEdge: number; coarsened: boolean; components: number; oddColumns: number };
}

export type PathBOutcome = PathBResult | { needsSplit: { level: number; loops: number[] } };

// ---------------------------------------------------------------------------------------------------------------
// Small geometry helpers

/** Reverses a closed loop's direction, keeping its first point first (the left-hand working direction). */
export function reverseLoop(loop: IsolineLoop): IsolineLoop {
  const n = loop.edges.length;
  const points = new Float64Array(3 * n);
  const edges = new Int32Array(n);
  for (let k = 0; k < n; k++) {
    const j = (n - k) % n;
    edges[k] = loop.edges[j];
    points[3 * k] = loop.points[3 * j];
    points[3 * k + 1] = loop.points[3 * j + 1];
    points[3 * k + 2] = loop.points[3 * j + 2];
  }
  return { points, edges, closed: loop.closed, length: loop.length };
}

/** The closed polyline of a loop starting at arc fraction `offset` (signed, wraps), as [x, y, z, …]. */
export function polylineFrom(loop: IsolineLoop, offset: number): Float64Array {
  const P = loop.points;
  const m = P.length / 3;
  if (m < 2 || !(loop.length > 0)) return Float64Array.from(P);
  let s = (offset % 1) * loop.length;
  if (s < 0) s += loop.length;
  let acc = 0;
  for (let i = 0; i < m; i++) {
    const k = (i + 1) % m;
    const len = Math.hypot(P[3 * k] - P[3 * i], P[3 * k + 1] - P[3 * i + 1], P[3 * k + 2] - P[3 * i + 2]);
    if (acc + len > s || i === m - 1) {
      const u = len > 0 ? Math.min(1, Math.max(0, (s - acc) / len)) : 0;
      const out: number[] = [P[3 * i] + u * (P[3 * k] - P[3 * i]), P[3 * i + 1] + u * (P[3 * k + 1] - P[3 * i + 1]), P[3 * i + 2] + u * (P[3 * k + 2] - P[3 * i + 2])];
      for (let q = 1; q <= m; q++) {
        const j = (i + q) % m;
        if (q === m && u === 0) break; // the start point itself
        out.push(P[3 * j], P[3 * j + 1], P[3 * j + 2]);
      }
      // drop a duplicate of the start when u = 1
      if (u === 1) out.splice(3, 3);
      return Float64Array.from(out);
    }
    acc += len;
  }
  return Float64Array.from(P);
}

/** Length-weighted centroid of a closed polyline. */
function polylineCenter(p: ArrayLike<number>): Vec3 {
  const n = p.length / 3;
  const c: Vec3 = [0, 0, 0];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const len = Math.hypot(p[3 * j] - p[3 * i], p[3 * j + 1] - p[3 * i + 1], p[3 * j + 2] - p[3 * i + 2]);
    for (let a = 0; a < 3; a++) c[a] += (len * (p[3 * i + a] + p[3 * j + a])) / 2;
    total += len;
  }
  if (!(total > 0)) {
    for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) c[a] += p[3 * i + a] / n;
    return n > 0 ? c : [0, 0, 0];
  }
  return [c[0] / total, c[1] / total, c[2] / total];
}

const unit = (v: Vec3): Vec3 => {
  const n = Math.hypot(v[0], v[1], v[2]);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
};

/** Scales points toward a center (for rounds `closeTail` appends past the last isoline). */
function shrink(p: Float64Array, c: Vec3, f: number): Float64Array {
  const out = new Float64Array(p.length);
  for (let i = 0; i < p.length; i += 3) for (let a = 0; a < 3; a++) out[i + a] = c[a] + f * (p[i + a] - c[a]);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Coupling with the retry ladder

export interface CoupledRounds {
  /** The rounds' samples after any half rows were inserted. */
  samples: Float64Array[];
  /** Indices (0-based, into `samples`) of inserted half rows. */
  inserted: number[];
  /** Ops per round (round 0: n₀ sc, the magic ring). */
  ops: Op[][];
  /** The fan each coupling needed (0 for round 0). */
  fans: number[];
  issues: Issue[];
}

/** A closed polygon of points as a loop (for resampling). */
function polygonLoop(p: Float64Array): IsolineLoop {
  const n = p.length / 3;
  let length = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    length += Math.hypot(p[3 * j] - p[3 * i], p[3 * j + 1] - p[3 * i + 1], p[3 * j + 2] - p[3 * i + 2]);
  }
  return { points: p, edges: new Int32Array(n), closed: true, length };
}

/**
 * The half row between two rounds (§2.10.7 step 6, at (k − ½)·hEff): both rounds resampled by arc length to m points
 * from their first stitch, averaged point by point; m = √(P·T) within the range both couplings reach with fan 3.
 */
export function halfRowBetween(prev: Float64Array, next: Float64Array): Float64Array {
  const P = prev.length / 3;
  const T = next.length / 3;
  const lo = Math.max(Math.ceil(P / 3), Math.ceil(T / 3));
  const hi = Math.min(3 * P, 3 * T);
  const m = Math.min(hi, Math.max(lo, Math.round(Math.sqrt(P * T))));
  const a = sampleLoop(polygonLoop(prev), m, { phase: 0 });
  const b = sampleLoop(polygonLoop(next), m, { phase: 0 });
  const out = new Float64Array(3 * m);
  for (let i = 0; i < out.length; i++) out[i] = (a[i] + b[i]) / 2;
  return out;
}

/**
 * Step 6 over a whole piece: DTW with fan 2; a round that needs more is retried with fan 3 (`W_FAN3`); if that fails
 * too, a half row (`halfRowBetween`) is inserted and coupled on both sides (at most MAX_HALF_ROWS per gap). R6 is
 * checked on every alignment before its ops are read. With fan-clamped counts (step 4) fan 2 always suffices.
 */
export function* coupleRoundsSteps(rounds: readonly Float64Array[], o: { w: number; part?: string }): Steps<CoupledRounds> {
  const samples = [...rounds];
  const inserted: number[] = [];
  const ops: Op[][] = [];
  const fans: number[] = [];
  const issues: Issue[] = [];
  if (samples.length === 0) return { samples, inserted, ops, fans, issues };
  ops.push(Array.from({ length: samples[0].length / 3 }, (): Op => ({ k: 'st', st: 'sc' })));
  fans.push(0);
  let halves = 0;
  for (let k = 1; k < samples.length; k++) {
    const where = { ...(o.part !== undefined ? { part: o.part } : {}), line: k + 1 };
    let al: Alignment | null = coupleRows(samples[k - 1], samples[k], { w: o.w, maxFan: DTW_MAX_FAN });
    if (!al) al = coupleRows(samples[k - 1], samples[k], { w: o.w, maxFan: DTW_RETRY_FAN });
    if (!al) {
      const half = halves < MAX_HALF_ROWS ? halfRowBetween(samples[k - 1], samples[k]) : null;
      if (!half) throw new RangeError(`Rnd ${k + 1}: ${samples[k - 1].length / 3} → ${samples[k].length / 3} sts cannot be coupled`);
      samples.splice(k, 0, half);
      for (let q = 0; q < inserted.length; q++) if (inserted[q] >= k) inserted[q]++;
      inserted.push(k);
      halves++;
      k--;
      continue;
    }
    halves = 0;
    if (al.maxFan > DTW_MAX_FAN) {
      issues.push({ code: 'W_FAN3', severity: 'warn', message: `Rnd ${k + 1}: ${al.P} → ${al.T} sts needs 3-stitch increases or decreases`, where });
    }
    const corner = cornerIssues(al, where);
    if (corner.length > 0) {
      issues.push(...corner);
      throw new RangeError(`Rnd ${k + 1}: ${corner[0].message}`);
    }
    ops.push(transduce(al));
    fans.push(al.maxFan);
    yield;
  }
  return { samples, inserted, ops, fans, issues };
}

// ---------------------------------------------------------------------------------------------------------------
// Stitch labels (§2.11.2: majority of 7 samples — the center and 6 at 0.35·wS)

function stitchLabels(samples: Float64Array, normal: Vec3, index: NearestVertexIndex | null, labels: Uint8Array, wS: number): Uint8Array<ArrayBuffer> {
  const n = samples.length / 3;
  const out = new Uint8Array(n).fill(255);
  if (!index) return out;
  const r = LABEL_SAMPLE_OFFSET * wS;
  const votes = new Map<number, number>();
  for (let j = 0; j < n; j++) {
    const a = (j + n - 1) % n;
    const b = (j + 1) % n;
    let t = unit([samples[3 * b] - samples[3 * a], samples[3 * b + 1] - samples[3 * a + 1], samples[3 * b + 2] - samples[3 * a + 2]]);
    if (n < 3 || !(Math.hypot(t[0], t[1], t[2]) > 0)) t = [1, 0, 0];
    const d = normal[0] * t[0] + normal[1] * t[1] + normal[2] * t[2];
    let u = unit([normal[0] - d * t[0], normal[1] - d * t[1], normal[2] - d * t[2]]);
    if (!(Math.hypot(u[0], u[1], u[2]) > 0)) u = unit([-t[1], t[0], 0]);
    const p: Vec3 = [samples[3 * j], samples[3 * j + 1], samples[3 * j + 2]];
    const center = labels[index.nearest(p[0], p[1], p[2])] ?? 255;
    votes.clear();
    votes.set(center, 1);
    for (let q = 0; q < 6; q++) {
      const ang = (q * Math.PI) / 3;
      const c = Math.cos(ang) * r;
      const s = Math.sin(ang) * r;
      const v = index.nearest(p[0] + c * t[0] + s * u[0], p[1] + c * t[1] + s * u[1], p[2] + c * t[2] + s * u[2]);
      const l = v >= 0 ? labels[v] : 255;
      votes.set(l, (votes.get(l) ?? 0) + 1);
    }
    let best = center;
    let bc = votes.get(center) ?? 0;
    for (const [l, c] of [...votes.entries()].sort((x, y) => x[0] - y[0])) if (c > bc) {
      best = l;
      bc = c;
    }
    out[j] = best;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// The driver

function checkRequest(r: PathBRequest): void {
  if (typeof r !== 'object' || r === null) throw new RangeError('pathB: the request must be an object');
  const m = r.mesh;
  if (!m || !(m.positions instanceof Float32Array) || !(m.indices instanceof Uint32Array) || !(m.labels instanceof Uint8Array)) {
    throw new RangeError('pathB: the mesh must be a ColoredMesh (Float32Array positions, Uint32Array indices, Uint8Array labels)');
  }
  if (m.labels.length !== m.positions.length / 3) throw new RangeError('pathB: one label per vertex expected');
  if (!r.gauge || !r.gauge.cell || !(r.gauge.cell.w > 0) || !(r.gauge.cell.h > 0)) throw new RangeError('pathB: the gauge needs a cell');
  if (!r.settings) throw new RangeError('pathB: settings are required');
  const lean = r.settings.leanStPerRnd;
  if (lean !== undefined && !Number.isFinite(lean)) throw new RangeError('pathB: leanStPerRnd must be a finite number');
}

/** Path B as a resumable computation. */
export function* pathBSteps(r: PathBRequest): Steps<PathBOutcome> {
  checkRequest(r);
  const part = r.partId;
  const settings = r.settings;
  const stuffing: Stuffing = settings.defaultStuffing ?? 'firm';
  const { wS, hS } = stuffedCell(r.gauge, stuffing);
  const frame = r.frame ?? {};
  let up: Vec3 | undefined;
  if (frame.axis && frame.axis.every((c) => Number.isFinite(c)) && Math.hypot(...frame.axis) > 0) {
    up = frame.startPole === 'top' ? [-frame.axis[0], -frame.axis[1], -frame.axis[2]] : [frame.axis[0], frame.axis[1], frame.axis[2]];
  }
  const g: GeodesicRowsResult = yield* geodesicRowsSteps(r.mesh, {
    hS,
    targetEdge: pathBTargetEdge(r.gauge.cell.w, r.gauge.cell.h),
    ...(r.seed ? { seed: r.seed } : {}),
    ...(r.attach && r.attach.length > 0 ? { attach: r.attach } : {}),
    ...(up ? { up } : {}),
    ...(frame.trimmedAt !== undefined && frame.trimmedAt > 0 ? { trimAt: frame.trimmedAt } : {}),
    ...(frame.seamDir ? { seamDir: frame.seamDir } : {}),
  });
  if (g.needsSplit) return { needsSplit: { level: g.needsSplit.level, loops: g.needsSplit.loops } };

  const issues: Issue[] = [];
  const where = { part };
  if (g.remesh && g.remesh.components > 1) {
    issues.push({ code: 'W_MESH_PIECES', severity: 'warn', message: `The mesh of this part has ${g.remesh.components} separate pieces; the pattern follows the largest one. Merge or delete the others.`, where });
  }
  if (g.remesh && g.remesh.oddColumns > 0) {
    issues.push({ code: 'W_MESH_OPEN', severity: 'warn', message: 'The mesh of this part has holes or overlapping shells; it was closed for the pattern. Check its shape.', where });
  }

  // Step 4: counts.
  const closed = !g.open;
  const right = settings.hand !== 'left';
  const rhLoops = g.rows.map((row) => row.loop);
  const ideal = rhLoops.map((l) => l.length / wS);
  const c = pathBCounts(ideal, { closed });
  if (c.dropped) {
    rhLoops.pop();
    ideal.pop();
  }
  const counts = c.counts;
  const worked = rhLoops.length; // rounds with their own isoline
  const refIdx = Math.min(g.refRow, worked - 1);

  // Step 5: lean offsets (fraction of a round, in the working direction; 0 at the reference round).
  const lean = settings.leanStPerRnd ?? 0;
  const offsets = counts.map(() => 0);
  for (let k = refIdx + 1; k < counts.length; k++) offsets[k] = offsets[k - 1] - lean / counts[k];
  for (let k = refIdx - 1; k >= 0; k--) offsets[k] = offsets[k + 1] + lean / counts[k + 1];

  // Loops in the working direction, polylines from the (lean-moved) round start, stitch samples.
  const loops = rhLoops.map((l) => (right ? l : reverseLoop(l)));
  const apex: Vec3 = [g.sm.positions[3 * g.apex], g.sm.positions[3 * g.apex + 1], g.sm.positions[3 * g.apex + 2]];
  const polylines: Float64Array[] = [];
  const normals: Vec3[] = [];
  let samples: Float64Array[] = [];
  for (let k = 0; k < counts.length; k++) {
    if (k < worked) {
      polylines.push(polylineFrom(loops[k], offsets[k]));
      // RH loops run counterclockwise seen from the start side: the area vector points back toward the start.
      const a = loopAreaVector(rhLoops[k].points);
      normals.push(unit([-a[0], -a[1], -a[2]]));
      samples.push(sampleLoop(loops[k], counts[k], { offset: offsets[k] }));
    } else {
      // closeTail rounds: the last isoline contracted toward the apex, halving each time.
      const f = 0.5 ** (k - worked + 1);
      polylines.push(shrink(polylineFrom(loops[worked - 1], offsets[k]), apex, f));
      normals.push(normals[worked - 1]);
      samples.push(shrink(sampleLoop(loops[worked - 1], counts[k], { offset: offsets[k] }), apex, f));
    }
    yield;
  }
  while (ideal.length < counts.length) ideal.push(NaN);

  // Step 7 test: radial residual about the axis of the round centers.
  let centers = polylines.map((p) => polylineCenter(p));
  const fit = radialFit(samples.map((s, k) => ({ samples: s, center: centers[k], normal: normals[k] })));
  const regularized = counts.length >= 2 && fit.residual < REGULARIZE_RESIDUAL;

  // Step 6: ops.
  let ops: Op[][];
  const halfRows: number[] = [];
  if (regularized) {
    ops = [Array.from({ length: counts[0] }, (): Op => ({ k: 'st', st: 'sc' }))];
    let changeIdx = 0;
    for (let k = 1; k < counts.length; k++) {
      ops.push(placeRound(counts[k - 1], counts[k], changeIdx));
      if (counts[k] !== counts[k - 1]) changeIdx++;
    }
  } else {
    const coupled = yield* coupleRoundsSteps(samples, { w: wS, part });
    ops = coupled.ops;
    issues.push(...coupled.issues);
    if (coupled.inserted.length > 0) {
      // Rebuild the per-round arrays around the inserted half rows (never seen with fan-clamped counts).
      const all = coupled.samples;
      const isNew = new Set(coupled.inserted);
      const pick = <T>(src: T[], fill: (k: number) => T): T[] => {
        const out: T[] = [];
        let q = 0;
        for (let k = 0; k < all.length; k++) out.push(isNew.has(k) ? fill(k) : src[q++]);
        return out;
      };
      const oldCounts = counts.slice();
      const newCounts = all.map((s) => s.length / 3);
      counts.splice(0, counts.length, ...newCounts);
      // the old index of the round just before an inserted one
      const near = (k: number): number => Math.min(oldCounts.length - 1, Math.max(0, k - 1 - coupled.inserted.filter((x) => x < k).length));
      const polys = pick(polylines, (k) => all[k]);
      polylines.splice(0, polylines.length, ...polys);
      const ns = pick(normals, (k) => normals[near(k)]);
      normals.splice(0, normals.length, ...ns);
      const ids = pick(ideal, () => NaN);
      ideal.splice(0, ideal.length, ...ids);
      const offs = pick(offsets, (k) => offsets[near(k)]);
      offsets.splice(0, offsets.length, ...offs);
      samples = all;
      centers = polylines.map((p) => polylineCenter(p));
      halfRows.push(...coupled.inserted.map((k) => k + 1));
    }
  }

  // Validation (warnings and the self-checks of the pole rule).
  issues.push(...slopeIssues(counts, slopeLimit(r.gauge.cell.w, r.gauge.cell.h), part));
  issues.push(...poleRuleIssues(counts, ideal.map((x) => (Number.isFinite(x) ? x : 0)), { closed, part }));

  // Labels and rings.
  const input: ColoredMesh = r.mesh;
  let index: NearestVertexIndex | null = null;
  if (input.labels.some((l) => l !== 255)) {
    const used = new Uint8Array(input.positions.length / 3);
    for (const v of input.indices) used[v] = 1;
    index = new NearestVertexIndex(input.positions, (i) => used[i] === 1);
  }
  yield;
  const labels: Uint8Array<ArrayBuffer>[] = [];
  for (let k = 0; k < counts.length; k++) {
    labels.push(stitchLabels(samples[k], normals[k], index, input.labels, wS));
    if (k % 8 === 7) yield;
  }
  const rings: RingGeom[] = polylines.map((p, k) => {
    let len = 0;
    const n = p.length / 3;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      len += Math.hypot(p[3 * j] - p[3 * i], p[3 * j + 1] - p[3 * i + 1], p[3 * j + 2] - p[3 * i + 2]);
    }
    return { center: centers[k], normal: normals[k], radius: len / (2 * Math.PI), polyline: Float32Array.from(p) };
  });

  const seedP = g.sm.positions;
  const sv = g.seed.vertex;
  return {
    partId: part,
    path: 'B',
    counts,
    loops: counts.map(() => 'both' as const),
    hEff: g.hEff,
    closedEnd: closed,
    start: { k: 'mr', n: counts[0] },
    finish: closed ? 'gather' : 'open',
    rings,
    stitchLabels: labels,
    ops,
    issues,
    ideal,
    regularized,
    radialResidual: fit.residual,
    refRound: refIdx + 1,
    leanOffsets: offsets,
    seed: { vertex: sv, rule: g.seed.rule, point: [seedP[3 * sv], seedP[3 * sv + 1], seedP[3 * sv + 2]] },
    dropped: c.dropped,
    appended: c.appended,
    halfRows,
    ...(g.remesh
      ? {
          remesh: {
            vertices: g.remesh.mesh.positions.length / 3,
            meanEdge: g.remesh.meanEdge,
            targetEdge: g.remesh.targetEdge,
            coarsened: g.remesh.coarsened,
            components: g.remesh.components,
            oddColumns: g.remesh.oddColumns,
          },
        }
      : {}),
  };
}

/** Path B, synchronously (tests and tools). */
export function pathB(r: PathBRequest): PathBOutcome {
  return drain(pathBSteps(r));
}

/** Path B with cooperative cancellation: `check` (the job gate) is awaited every few ms (steps.ts). */
export function pathBAsync(r: PathBRequest, check: () => Promise<void>, o: { sliceMs?: number; onStretch?: (ms: number) => void } = {}): Promise<PathBOutcome> {
  return drainAsync(pathBSteps(r), { check, ...o });
}

/** The rounds of a Path B result as pattern lines (round 1 from the magic ring), e.g. for `validateLines`. */
export function pathBLines(res: Pick<PathBResult, 'counts' | 'ops'>): Line[] {
  return res.counts.map((n, k) => ({
    kind: 'rnd',
    n: k + 1,
    ...(k === 0 ? { start: { k: 'mr', n } } : {}),
    ops: res.ops[k],
    prevCount: k === 0 ? null : res.counts[k - 1],
    stated: n,
  }));
}
