import { describe, expect, it } from 'vitest';
import { validateLines } from '../../pattern/validateLine';
import { consumed, produced } from '../../pattern/ops';
import type { ResolvedGauge } from '../../../types/gauge';
import type { AmiSettings } from '../../../types/ami';
import type { ColoredMesh, Vec3 } from '../../../types/geometry';
import type { IndexedMesh } from '../../kernel/geom/marchingCubes';
import { poleRuleIssues } from '../counts';
import { pathB, pathBAsync, pathBLines, polylineFrom, reverseLoop, type PathBOutcome, type PathBRequest, type PathBResult } from '../pathB';
import { pathBTargetEdge } from '../rows';
import { capsuleF, colored, HEAVY, meshOf, pathAExact, sphereF, sphereIdeals, uvSphere, yShapeF, type Implicit } from './helpers';

// §2.10.7 Path B end to end (T5.3 acceptance): R1, R2 (pole rule on a pointed mesh tip), R6; Path B on a sphere mesh
// matches Path A exact counts ±1; needsSplit; W_MESH_PIECES / W_MESH_OPEN; labels, rings, lean, hand, trimming.

/** Worsted defaults (Table E): w 0.195, h = w/1.05, firm stretch 1.05. */
const WORSTED: ResolvedGauge = { cell: { w: 0.195, h: 0.195 / 1.05 }, wSc: 0.195, hSc: 0.19, lscIn: 1, hookMm: 3.5, stretch: 1.05, tol: 0.1, source: 'default' };
/** The §2.10.5 golden gauge: w = h = 0.2, s = 1 (light stuffing). */
const GOLDEN: ResolvedGauge = { ...WORSTED, cell: { w: 0.2, h: 0.2 }, stretch: 1 };
const SETTINGS: AmiSettings = {
  style: 'exact',
  spiral: true,
  crispStripes: false,
  decMethod: 'invdec',
  dialect: 'compact',
  terms: 'us',
  hand: 'right',
  eyes: 'auto',
  defaultStuffing: 'firm',
  leanStPerRnd: 0.25,
};

function req(mesh: IndexedMesh | ColoredMesh, o: Partial<PathBRequest> = {}): PathBRequest {
  const m = 'labels' in mesh ? mesh : colored(mesh);
  return { jobId: 1, mesh: m, partId: 'p', frame: {}, gauge: WORSTED, settings: SETTINGS, ...o };
}

function rounds(o: PathBOutcome): PathBResult {
  if ('needsSplit' in o) throw new Error(`unexpected needsSplit at level ${o.needsSplit.level}`);
  return o;
}

/** Every structural rule a Path B result must satisfy (R1 via the Step 0 line validator, R2/R9, R6, shapes). */
function expectValid(r: PathBResult): void {
  const lines = pathBLines(r);
  expect(validateLines(lines, { piece: r.partId })).toEqual([]);
  r.ops.forEach((ops, k) => {
    expect(produced(ops)).toBe(r.counts[k]);
    if (k > 0) expect(consumed(ops)).toBe(r.counts[k - 1]);
  });
  expect(r.issues.filter((i) => i.severity === 'error')).toEqual([]);
  expect(poleRuleIssues(r.counts, r.ideal.map((x) => (Number.isFinite(x) ? x : 0)), { closed: r.closedEnd })).toEqual([]);
  expect(r.rings.length).toBe(r.counts.length);
  expect(r.stitchLabels.map((l) => l.length)).toEqual(r.counts);
  expect(r.loops.every((l) => l === 'both')).toBe(true);
  expect(r.start).toEqual({ k: 'mr', n: r.counts[0] });
  for (const ring of r.rings) {
    expect([...ring.center, ...ring.normal, ring.radius].every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...ring.normal)).toBeCloseTo(1, 9);
    expect(ring.polyline && ring.polyline.length % 3 === 0 && ring.polyline.every(Number.isFinite)).toBe(true);
  }
}

const coneF =
  (r: number, h: number, y0: number): Implicit =>
  (x, y, z) => {
    const yy = y - y0;
    return Math.min(yy, h - yy, ((r * (1 - yy / h) - Math.hypot(x, z)) * h) / Math.hypot(r, h));
  };

describe('Path B driver (§2.10.7)', HEAVY, () => {
  it('sphere meshes match Path A exact counts ±1 (worsted, R = 1, 1.25, 2 in)', () => {
    const wS = 0.195 * 1.05;
    const hS = (0.195 / 1.05) * 1.05;
    for (const R of [1, 1.25, 2]) {
      const a = pathAExact(sphereIdeals(R, wS, hS), { closed: true, symmetric: true });
      const b = rounds(pathB(req(uvSphere(R, 96, 48))));
      expectValid(b);
      expect(b.counts.length).toBe(a.length);
      const diff = b.counts.map((n, k) => Math.abs(n - a[k]));
      expect(Math.max(...diff), `R = ${R}: A ${a.join(' ')} / B ${b.counts.join(' ')}`).toBeLessThanOrEqual(1);
      expect(b.regularized).toBe(true);
    }
  });

  it('the golden sphere r = 1.5 at w = h = 0.2: one round fewer (geodesic 1.3% short of πr puts N at 23, not 24), widest ±1', () => {
    const a = pathAExact(sphereIdeals(1.5, 0.2, 0.2), { closed: true, symmetric: true });
    const b = rounds(pathB(req(uvSphere(1.5, 96, 48), { gauge: GOLDEN, settings: { ...SETTINGS, defaultStuffing: 'light' } })));
    expectValid(b);
    expect(Math.abs(b.counts.length - a.length)).toBeLessThanOrEqual(1);
    expect(Math.abs(Math.max(...b.counts) - Math.max(...a))).toBeLessThanOrEqual(1);
    expect(b.counts[0]).toBe(a[0] + 1); // ideal₁ 6.80 here (rows hEff 0.21) vs 6.15 in Path A (hEff 0.196)
  });

  it('R2 on a pointed mesh tip: seeded at the tip the ring is 5 and never decreases while the shape widens', () => {
    const cone = meshOf(coneF(1, 3, -1.5), 80, 2, 3);
    const r = rounds(pathB(req(cone, { seed: [0, 1.5, 0] })));
    expectValid(r);
    expect(r.seed.rule).toBe('seed');
    expect(r.ideal[0]).toBeLessThan(5);
    expect(r.counts[0]).toBe(5);
    for (let k = 1; k < r.counts.length && r.ideal[k] < r.counts[0]; k++) expect(r.counts[k]).toBeGreaterThanOrEqual(r.counts[k - 1]);
  });

  it('R2 / R9 at a pointed far end: the closing rounds are ≥ 5 and the raised duplicate is dropped', () => {
    const cone = meshOf(coneF(1, 3, -1.5), 80, 2, 3);
    const r = rounds(pathB(req(cone)));
    expectValid(r);
    expect(r.seed.rule).toBe('lowest');
    // the flat base: its center is the seed (the lowest patch's centroid)
    expect(Math.hypot(r.seed.point[0], r.seed.point[2])).toBeLessThan(0.1);
    const last = r.counts[r.counts.length - 1];
    expect(last).toBeGreaterThanOrEqual(5);
    expect(last).toBeLessThanOrEqual(8);
    expect(r.closedEnd).toBe(true);
    expect(r.finish).toBe('gather');
  });

  it('R1 and R6 on a non-round part (DTW positions, not the placement): a tilted peanut', () => {
    const pea = meshOf((x, y, z) => Math.max(sphereF(0.8, [0, -0.6, 0])(x, y, z), sphereF(0.6, [0.5, 0.6, 0.2])(x, y, z)), 70, 1.7, 3);
    const r = rounds(pathB(req(pea)));
    expect(r.regularized).toBe(false);
    expect(r.radialResidual).toBeGreaterThan(0.1);
    expectValid(r);
    expect(r.issues.some((i) => i.code === 'E_CORNER')).toBe(false);
  });

  it('a Y-shaped mesh returns needsSplit with the level and the loop lengths', () => {
    const o = pathB(req(meshOf(yShapeF(), 70, 2.3, 3)));
    expect('needsSplit' in o).toBe(true);
    if (!('needsSplit' in o)) return;
    expect(Object.keys(o)).toEqual(['needsSplit']);
    expect(o.needsSplit.loops.length).toBe(2);
    expect(o.needsSplit.level).toBeGreaterThan(1);
  });

  it('W_MESH_PIECES: two separate shells — the pattern follows the larger', () => {
    const a = uvSphere(1, 48, 24);
    const b = uvSphere(0.4, 24, 12, [3, 0, 0]);
    const two: IndexedMesh = {
      positions: Float32Array.from([...a.positions, ...b.positions]),
      indices: Uint32Array.from([...a.indices, ...[...b.indices].map((i) => i + a.positions.length / 3)]),
    };
    const r = rounds(pathB(req(two)));
    expect(r.issues.map((i) => i.code)).toContain('W_MESH_PIECES');
    expect(r.remesh?.components).toBe(2);
    expect(Math.max(...r.counts)).toBeGreaterThan(28); // 2π·1/0.205 ≈ 30.7
    expectValid(r);
  });

  it('W_MESH_OPEN: an open mesh (a sphere with a hole on its side) is closed by the parity rule and flagged', () => {
    const s = uvSphere(1, 48, 24);
    const u = [1 / Math.hypot(1, 0.3), 0, 0.3 / Math.hypot(1, 0.3)];
    const keep: number[] = [];
    for (let t = 0; t < s.indices.length; t += 3) {
      const d = [0, 1, 2].map((k) => u[0] * s.positions[3 * s.indices[t + k]] + u[2] * s.positions[3 * s.indices[t + k] + 2]);
      if (Math.max(...d) < 0.8) keep.push(s.indices[t], s.indices[t + 1], s.indices[t + 2]);
    }
    const r = rounds(pathB(req({ positions: s.positions, indices: Uint32Array.from(keep) })));
    expect(r.remesh?.oddColumns).toBeGreaterThan(0);
    expect(r.issues.map((i) => i.code)).toContain('W_MESH_OPEN');
    expectValid(r);
  });

  it('seed rules: crochet.seed wins; else the tip farthest from attach; frame axis / start pole for the root', () => {
    const cap = meshOf(capsuleF(0.5, [0, -1.5, 0], [0, 1.5, 0]), 60, 2.2, 3);
    const root = rounds(pathB(req(cap)));
    expect(root.seed.rule).toBe('lowest');
    expect(root.seed.point[1]).toBeLessThan(-1.9);
    const att = rounds(pathB(req(cap, { attach: [[0, -2, 0], [0.2, -1.9, 0]] })));
    expect(att.seed.rule).toBe('farthest-from-attach');
    expect(att.seed.point[1]).toBeGreaterThan(1.9);
    const seeded = rounds(pathB(req(cap, { seed: [0, -2, 0], attach: [[0, -2, 0]] })));
    expect(seeded.seed.rule).toBe('seed');
    expect(seeded.seed.point[1]).toBeLessThan(-1.9);
    const top = rounds(pathB(req(cap, { frame: { axis: [0, 1, 0], startPole: 'top' } })));
    expect(top.seed.point[1]).toBeGreaterThan(1.9);
    for (const r of [root, att, seeded, top]) {
      expectValid(r);
      // a cylinder of r 0.5: 2π·0.5 / wS ≈ 15.3 sts
      expect(Math.max(...r.counts)).toBe(15);
    }
  });

  it('a trimmed part (frame.trimmedAt) ends open on the cut with N = round(trimAt / hS) rounds', () => {
    const r = rounds(pathB(req(uvSphere(1.25, 64, 32), { frame: { trimmedAt: 2.5 } })));
    expectValid(r);
    expect(r.closedEnd).toBe(false);
    expect(r.finish).toBe('open');
    expect(r.counts.length).toBe(Math.round(2.5 / 0.195));
    expect(r.hEff * r.counts.length).toBeCloseTo(2.5, 9);
  });

  it('hands: a left-hander works the same rounds in the mirror direction', () => {
    const m = uvSphere(1.25, 64, 32);
    const rh = rounds(pathB(req(m)));
    const lh = rounds(pathB(req(m, { settings: { ...SETTINGS, hand: 'left' } })));
    expect(lh.counts).toEqual(rh.counts);
    // same start point, opposite direction about the round's normal (rows grow along the normal)
    const k = rh.refRound - 1;
    const dir = (r: PathBResult): number => {
      const p = r.rings[k].polyline as Float32Array;
      const c = r.rings[k].center;
      const a: Vec3 = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      const b: Vec3 = [p[3] - c[0], p[4] - c[1], p[5] - c[2]];
      const cr: Vec3 = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      return Math.sign(cr[0] * r.rings[k].normal[0] + cr[1] * r.rings[k].normal[1] + cr[2] * r.rings[k].normal[2]);
    };
    expect(dir(rh)).toBe(-dir(lh));
    // RH: rows advance along +normal (bottom-up here), and the work turns clockwise about it (azimuth decreasing
    // seen from above, §2.11.2), i.e. counterclockwise seen from the start pole.
    expect(rh.rings[k].normal[1]).toBeGreaterThan(0.99);
    expect(dir(rh)).toBe(-1);
  });

  it('seam: with frame.seamDir the reference round starts at center back; the lean moves the others against the work', () => {
    const m = uvSphere(1.25, 64, 32);
    const r = rounds(pathB(req(m, { frame: { seamDir: [0, 0, -1] } })));
    const k = r.refRound - 1;
    expect(r.leanOffsets[k]).toBe(0);
    const p = r.rings[k].polyline as Float32Array;
    const c = r.rings[k].center;
    const ang = Math.atan2(p[0] - c[0], -(p[2] - c[2])); // 0 = center back (−Z)
    expect(Math.abs(ang)).toBeLessThan(0.1);
    // offsets: negative after the reference round (against the working direction), positive before it
    expect(r.leanOffsets[k + 1]).toBeCloseTo(-0.25 / r.counts[k + 1], 12);
    expect(r.leanOffsets[k - 1]).toBeCloseTo(0.25 / r.counts[k], 12);
    const flat = rounds(pathB(req(m, { frame: { seamDir: [0, 0, -1] }, settings: { ...SETTINGS, leanStPerRnd: 0 } })));
    expect(flat.leanOffsets.every((x) => x === 0)).toBe(true);
  });

  it('stitch labels: a two-colored sphere (cream above y = 0, caramel below) colors its rounds by height', () => {
    const s = uvSphere(1.25, 64, 32);
    const mesh = colored(s);
    for (let v = 0; v < mesh.labels.length; v++) mesh.labels[v] = s.positions[3 * v + 1] > 0 ? 1 : 0;
    const r = rounds(pathB(req(mesh)));
    r.stitchLabels.forEach((labels, k) => {
      const y = r.rings[k].center[1];
      if (y < -0.15) expect([...labels].every((l) => l === 0)).toBe(true);
      if (y > 0.15) expect([...labels].every((l) => l === 1)).toBe(true);
    });
    // an unpainted mesh gives 255 everywhere
    expect(rounds(pathB(req(colored(s, 255)))).stitchLabels.every((l) => l.every((x) => x === 255))).toBe(true);
  });

  it('rings: one per round, radius = isoline length / 2π, polylines start at the round start', () => {
    const r = rounds(pathB(req(uvSphere(1.25, 64, 32))));
    const k = r.refRound - 1;
    expect(r.rings[k].radius).toBeGreaterThan(1.2);
    expect(r.rings[k].radius).toBeLessThan(1.26);
    expect(r.counts[k]).toBe(Math.max(...r.counts));
  });

  it('deterministic and synchronous / async agree (no gate)', async () => {
    const m = meshOf(capsuleF(0.4, [0, -0.6, 0], [0.3, 0.6, 0.1]), 50, 1.3, 3);
    const a = rounds(pathB(req(m)));
    const b = rounds(pathB(req(m)));
    const c = rounds(await pathBAsync(req(m), async () => {}));
    for (const x of [b, c]) {
      expect(x.counts).toEqual(a.counts);
      expect(x.ops).toEqual(a.ops);
      expect(x.rings.map((g) => [...(g.polyline as Float32Array)])).toEqual(a.rings.map((g) => [...(g.polyline as Float32Array)]));
      expect(x.stitchLabels).toEqual(a.stitchLabels);
    }
  });

  it('cancellation: a rejecting check stops the computation', async () => {
    let n = 0;
    const err = new Error('stop');
    await expect(
      pathBAsync(req(uvSphere(1, 48, 24)), async () => {
        if (++n === 3) throw err;
      }, { sliceMs: 0 }),
    ).rejects.toBe(err);
    expect(n).toBe(3);
  });

  it('input checks', () => {
    expect(() => pathB({ ...req(uvSphere(1, 16, 8)), mesh: { positions: new Float32Array(9), indices: new Uint32Array(3), labels: new Uint8Array(1) } })).toThrow(RangeError);
    expect(() => pathB({ ...req(uvSphere(1, 16, 8)), gauge: { ...WORSTED, cell: { w: 0, h: 0.2 } } })).toThrow(RangeError);
    expect(pathBTargetEdge(0.195, 0.195 / 1.05)).toBeCloseTo(0.0619, 4);
  });
});

describe('loop helpers', () => {
  const sq = { points: Float64Array.from([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]), edges: Int32Array.from([0, 1, 2, 3]), closed: true, length: 4 };
  it('reverseLoop keeps the first point first', () => {
    expect([...reverseLoop(sq).points]).toEqual([0, 0, 0, 0, 1, 0, 1, 1, 0, 1, 0, 0]);
    expect([...reverseLoop(sq).edges]).toEqual([0, 3, 2, 1]);
  });
  it('polylineFrom starts at an arc fraction (wrapping, signed)', () => {
    expect([...polylineFrom(sq, 0)]).toEqual([...sq.points]);
    expect([...polylineFrom(sq, 0.125)]).toEqual([0.5, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0]);
    expect([...polylineFrom(sq, -0.25)]).toEqual([0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 1, 0]);
    expect([...polylineFrom(sq, 1.25)]).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 0]);
  });
});
