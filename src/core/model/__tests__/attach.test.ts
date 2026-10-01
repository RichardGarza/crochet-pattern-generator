import { describe, expect, it } from 'vitest';
import { budget, PERF } from '../../../test/timing';
import type { Repair } from '../../../types/importer';
import type { CrochetModelV1, Part, Vec3 } from '../../../types/model';
import { mulberry32, randomInt, randomRange } from '../../kernel/prng';
import { attachGraph, attachRoot, childrenOf, chooseRoot, inferAttach, inferMirrorPairs, isOneTree, leftTwinId, subtreeIds } from '../attach';
import { validateModel } from '../schema';
import { readEveryType } from './helpers/everyType';
import { modelOf, part, readSpecExample } from './helpers/geometry';
import { HEAVY } from './helpers/options';
import { buildCanonicalTeddy, normalizeObservedDialect, readObservedTeddy } from './helpers/teddy';

const REPAIR_CODES = new Set<Repair['code']>([
  'attach-inferred',
  'mirror-inferred',
  'units',
  'ground',
  'axes',
  'radians',
  'color',
  'dims-clamped',
  'id',
  'unknown-key',
  'feature-dropped',
  'limits',
  'versions',
  'spec-rebuilt',
]);

const parentsOf = (m: Pick<CrochetModelV1, 'parts'>): Record<string, string | null> => Object.fromEntries(m.parts.map((p) => [p.id, p.attach?.to ?? null]));

const withoutAttach = (m: CrochetModelV1): CrochetModelV1 => ({
  ...m,
  parts: m.parts.map((p) => {
    const copy = { ...p };
    delete copy.attach;
    return copy;
  }),
});

/** The canonical teddy tree of §3.7.3. */
const TEDDY_TREE: Record<string, string | null> = {
  body: null,
  head: 'body',
  muzzle: 'head',
  nose: 'muzzle',
  eye_l: 'head',
  eye_r: 'head',
  ear_l: 'head',
  ear_l_inner: 'ear_l',
  ear_r: 'head',
  ear_r_inner: 'ear_r',
  arm_l: 'body',
  arm_r: 'body',
  leg_l: 'body',
  foot_pad_l: 'leg_l',
  leg_r: 'body',
  foot_pad_r: 'leg_r',
  tail: 'body',
};

/** The teddy after dialect normalization: 10 links from `parent`, 7 parts without one. */
const dialectTeddy = normalizeObservedDialect(readObservedTeddy());
const canonicalTeddy = buildCanonicalTeddy().model;

function expectOneTree(m: Pick<CrochetModelV1, 'parts'>): void {
  const g = attachGraph(m.parts);
  expect(g.roots).toHaveLength(1);
  expect(g.isTree).toBe(true);
  // no cycles: every part reaches the root in fewer steps than there are parts
  m.parts.forEach((_, i) => {
    let at: number | null = i;
    let steps = 0;
    while (at !== null && g.parent[at] !== null) {
      at = g.parent[at];
      expect(++steps).toBeLessThan(m.parts.length);
    }
    expect(at).toBe(g.roots[0]);
  });
}

describe('inferAttach on the teddy (§3.7.3 golden, §3.7.6, D21)', HEAVY, () => {
  it('the dialect leaves 7 of 17 parts without a parent (research 08)', () => {
    expect(dialectTeddy.parts.filter((p) => !p.attach).map((p) => p.id)).toEqual(['body', 'head', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'tail']);
    expect(isOneTree(dialectTeddy)).toBe(false);
    expect(attachRoot(dialectTeddy)).toBeUndefined();
  });

  it('gives ONE tree rooted at body: head, arms, legs and tail attached to body by inference; the head keeps its children', () => {
    const { model, repairs } = inferAttach(dialectTeddy);
    expectOneTree(model);
    expect(attachRoot(model)?.id).toBe('body');
    expect(parentsOf(model)).toEqual(TEDDY_TREE);
    // 6 attach-inferred chips, largest overlap first (Prim's rule); twins tie → by id
    expect(repairs.map((r) => r.part)).toEqual(['leg_l', 'leg_r', 'arm_l', 'arm_r', 'tail', 'head']);
    for (const r of repairs) {
      expect(r.code).toBe('attach-inferred');
      expect(r.data?.to).toBe('body');
      expect(r.message).toMatch(new RegExp(`^${r.part} attached to body: they overlap by [0-9.]+ in³$`));
    }
    // overlap volumes ≈ head 0.07, legs 1.34, arms 0.64, tail 0.11 in³, ±15%
    const overlap = Object.fromEntries(repairs.map((r) => [r.part, r.data?.overlapIn3 as number]));
    for (const [id, expected] of [['head', 0.07], ['leg_l', 1.34], ['leg_r', 1.34], ['arm_l', 0.64], ['arm_r', 0.64], ['tail', 0.11]] as const) {
      expect(Math.abs(overlap[id] / expected - 1), id).toBeLessThan(0.15);
    }
    // new links: sewn, no openEnd (trimming decides); links from `parent` are untouched
    for (const id of ['head', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'tail']) expect(model.parts.find((p) => p.id === id)?.attach).toEqual({ to: 'body', method: 'sewn' });
    for (const p of dialectTeddy.parts.filter((x) => x.attach)) expect(model.parts.find((x) => x.id === p.id)).toBe(p);
    expect(model.parts.find((p) => p.id === 'body')).toBe(dialectTeddy.parts[0]);
  });

  it('the same canonical tree from the parentless teddy: 16 inferred links (the OBJ carrier, §3.7.6)', () => {
    const bare = withoutAttach(canonicalTeddy);
    expect(attachGraph(bare.parts).roots).toHaveLength(17);
    const { model, repairs } = inferAttach(bare);
    expectOneTree(model);
    expect(parentsOf(model)).toEqual(TEDDY_TREE);
    expect(repairs).toHaveLength(16);
    expect(repairs.every((r) => r.code === 'attach-inferred')).toBe(true);
    // growing outward from the root: the head hangs from the body (0.07 in³) although it overlaps its muzzle by
    // 1.43 in³ — and the muzzle then hangs from the head, never the other way round
    const order = repairs.map((r) => r.part);
    expect(order.indexOf('head')).toBeLessThan(order.indexOf('muzzle'));
    expect(order.indexOf('muzzle')).toBeLessThan(order.indexOf('nose'));
    expect(order.indexOf('ear_l')).toBeLessThan(order.indexOf('ear_l_inner'));
    expect(order.indexOf('leg_l')).toBeLessThan(order.indexOf('foot_pad_l'));
  });

  it('root: body (43.5 in³) — the larger head (47.6 in³) does not reach the lowest 10% of the height', () => {
    expect(dialectTeddy.parts[chooseRoot(dialectTeddy.parts)].id).toBe('body');
    // without the name, the root is still the largest part that reaches the bottom
    const renamed = { ...dialectTeddy, parts: dialectTeddy.parts.map((p) => (p.id === 'body' ? { ...p, id: 'torso', label: 'Torso' } : p)) };
    expect(renamed.parts[chooseRoot(renamed.parts)].id).toBe('torso');
    const { model } = inferAttach(renamed);
    expect(attachRoot(model)?.id).toBe('torso');
  });

  it('is idempotent: a second pass changes nothing and logs nothing', () => {
    const once = inferAttach(dialectTeddy);
    const twice = inferAttach(once.model);
    expect(twice.model).toBe(once.model);
    expect(twice.repairs).toEqual([]);
    expect(inferAttach(canonicalTeddy).model).toBe(canonicalTeddy);
    const bare = inferAttach(withoutAttach(canonicalTeddy));
    expect(inferAttach(bare.model).repairs).toEqual([]);
  });

  it('does not modify its input, and the result still validates', () => {
    const before = JSON.stringify(dialectTeddy);
    const { model } = inferAttach(dialectTeddy);
    expect(JSON.stringify(dialectTeddy)).toBe(before);
    expect(validateModel(buildCanonicalTeddy().model).ok).toBe(true);
    expect(model.name).toBe(dialectTeddy.name);
    expect(model.palette).toBe(dialectTeddy.palette);
  });

  it('runs within the §5.8 budget: ≤ 500 ms on the teddy (17 parts, grid overlaps)', { ...PERF, retry: 2 }, () => {
    inferAttach(dialectTeddy); // warm up
    const t0 = performance.now();
    inferAttach(dialectTeddy);
    const fromDialect = performance.now() - t0;
    const bare = withoutAttach(canonicalTeddy);
    const t1 = performance.now();
    inferAttach(bare);
    const fromNothing = performance.now() - t1;
    expect(fromDialect).toBeLessThan(budget(500));
    expect(fromNothing).toBeLessThan(budget(500));
  });
});

describe('inferAttach: the root rule (§3.7.6)', HEAVY, () => {
  const ball = (id: string, r: number, position: Vec3, rest: Partial<Part> = {}): Part => part('sphere', { r }, { id, position, ...rest });

  it('exactly one part without attach: it is the root, whatever its size or height', () => {
    const m = modelOf([
      ball('big', 3, [0, 3, 0], { attach: { to: 'tiny' } }),
      ball('tiny', 0.2, [0, 9, 0]),
      ball('mid', 1, [0, 6.5, 0], { attach: { to: 'big' } }),
    ]);
    const { model, repairs } = inferAttach(m);
    expect(model).toBe(m);
    expect(repairs).toEqual([]);
    expect(attachRoot(model)?.id).toBe('tiny');
  });

  it('several: among those reaching the lowest 10% of the height, the one with id or label "body"', () => {
    const parts = [ball('foot', 2, [0, 2, 0]), ball('trunk', 1, [3, 1, 0], { label: 'Body' }), ball('top', 3, [0, 6.5, 0])];
    expect(attachRoot(inferAttach(modelOf(parts)).model)?.id).toBe('trunk');
    const byId = [ball('foot', 2, [0, 2, 0]), ball('body', 1, [3, 1, 0]), ball('top', 3, [0, 6.5, 0])];
    expect(attachRoot(inferAttach(modelOf(byId)).model)?.id).toBe('body');
    // a "body" that does not reach the bottom is not preferred
    const high = [ball('foot', 2, [0, 2, 0]), ball('body', 1, [0, 8, 0]), ball('top', 3, [0, 6.5, 0])];
    expect(attachRoot(inferAttach(modelOf(high)).model)?.id).toBe('foot');
  });

  it('else the largest by volume among those that reach the bottom; if none does, the largest unattached part', () => {
    const parts = [ball('a', 1, [0, 1, 0]), ball('b', 1.5, [2, 1.5, 0]), ball('huge', 4, [0, 7, 0])];
    expect(attachRoot(inferAttach(modelOf(parts)).model)?.id).toBe('b');
    // attached parts are not candidates, even when they are the largest and the lowest
    const attached = [
      ball('base', 3, [0, 3, 0], { attach: { to: 'a' } }),
      ball('a', 1, [0, 6.5, 0]),
      ball('b', 1.2, [0, 8.5, 0]),
    ];
    const result = inferAttach(modelOf(attached)).model;
    expect(attachRoot(result)?.id).toBe('b'); // neither reaches the bottom: the larger of the two unattached parts
    expect(parentsOf(result)).toEqual({ base: 'a', a: 'b', b: null });
  });

  it('a single part is its own tree', () => {
    const m = modelOf([ball('only', 1, [0, 1, 0])]);
    expect(inferAttach(m)).toEqual({ model: m, repairs: [] });
    expect(inferAttach({ ...m, parts: [] }).repairs).toEqual([]);
  });
});

describe('inferAttach: links (Prim’s rule on overlap, then the smallest gap)', HEAVY, () => {
  const ball = (id: string, r: number, position: Vec3, rest: Partial<Part> = {}): Part => part('sphere', { r }, { id, position, ...rest });

  it('a part joins through the tree part it overlaps most, at the time it joins', () => {
    // root — a — b in a row; c overlaps b more than a, and b joins before c
    const m = modelOf([ball('body', 2, [0, 2, 0]), ball('a', 1, [2.5, 2, 0]), ball('b', 1, [4, 2, 0]), ball('c', 0.6, [4.6, 2.9, 0])]);
    const { model, repairs } = inferAttach(m);
    expect(parentsOf(model)).toEqual({ body: null, a: 'body', b: 'a', c: 'b' });
    expect(repairs.map((r) => [r.part, r.data?.to])).toEqual([
      ['a', 'body'],
      ['b', 'a'],
      ['c', 'b'],
    ]);
  });

  it('a part never hangs from its own child: an existing link is kept and its whole component joins together', () => {
    // "hat" already hangs from "head"; head overlaps the body, the hat does too (more) — the hat keeps its parent
    const m = modelOf([
      ball('body', 2, [0, 2, 0]),
      ball('head', 1, [0, 4.8, 0]),
      ball('hat', 1.5, [0, 4.4, 0.4], { attach: { to: 'head', method: 'glued', openEnd: 'bottom' } }),
    ]);
    const { model, repairs } = inferAttach(m);
    expect(parentsOf(model)).toEqual({ body: null, head: 'body', hat: 'head' });
    expect(model.parts[2]).toBe(m.parts[2]); // untouched, method and openEnd included
    expect(repairs).toHaveLength(1);
  });

  it('ties within 1% go to the larger part, then to the lower id', () => {
    // two equal spheres at mirrored places: equal overlaps → by id
    const twins = modelOf([ball('body', 2, [0, 2, 0]), ball('zed', 1, [2.5, 2, 0]), ball('abe', 1, [-2.5, 2, 0])]);
    expect(inferAttach(twins).repairs.map((r) => r.part)).toEqual(['abe', 'zed']);
    // Boxes overlap by exact slabs. The large box overlaps 0.5% less than the small one: a tie → the larger first.
    const box = (id: string, size: number, x: number): Part => part('box', { w: size, h: size, d: size }, { id, position: [x, 2, 0] });
    const body = part('box', { w: 4, h: 4, d: 4 }, { id: 'body', position: [0, 2, 0] });
    const tied = modelOf([body, box('small', 1, 2), box('zlarge', 2, -(3 - 0.124375))]);
    const repairs = inferAttach(tied).repairs;
    expect(repairs.map((r) => [r.part, r.data?.overlapIn3])).toEqual([
      ['zlarge', 0.4975],
      ['small', 0.5],
    ]);
    // 2% less is not a tie: the larger overlap goes first
    const apart = modelOf([body, box('small', 1, 2), box('zlarge', 2, -(3 - 0.1225))]);
    expect(inferAttach(apart).repairs.map((r) => [r.part, r.data?.overlapIn3])).toEqual([
      ['small', 0.5],
      ['zlarge', 0.49],
    ]);
  });

  it('parts that touch nothing attach to the nearest part; a gap > 0.1 in is reported, > 0.25 in "floats"', () => {
    const m = modelOf([
      ball('body', 1, [0, 1, 0]),
      ball('near', 0.5, [1.55, 1, 0]), // gap 0.05
      ball('gap', 0.5, [0, 1, 1.7]), // gap 0.2
      ball('far', 0.5, [0, 3.5, 0]), // gap 1.0
      ball('beyond', 0.25, [0, 4.6, 0]), // nearest is "far": gap 0.35
    ]);
    const { model, repairs } = inferAttach(m);
    expectOneTree(model);
    expect(parentsOf(model)).toEqual({ body: null, near: 'body', gap: 'body', far: 'body', beyond: 'far' });
    const byPart = Object.fromEntries(repairs.map((r) => [r.part, r]));
    expect(byPart.near.data).toEqual({ to: 'body', gapIn: 0.05 });
    expect(byPart.near.message).toBe('near attached to body, the nearest part (they touch)');
    expect(byPart.gap.data?.gapIn).toBeCloseTo(0.2, 3);
    expect(byPart.gap.message).toMatch(/^gap attached to body, the nearest part: gap 0\.2\d* in$/);
    expect(byPart.far.data?.gapIn).toBeCloseTo(1, 3);
    expect(byPart.far.message).toMatch(/^far attached to body: this part floats 1(\.0\d*)? in from body$/);
    expect(byPart.beyond.message).toMatch(/^beyond attached to far: this part floats 0\.35\d* in from far$/);
    // nearest first
    expect(repairs.map((r) => r.part)).toEqual(['near', 'gap', 'far', 'beyond']);
    expect(repairs.every((r) => r.code === 'attach-inferred')).toBe(true);
  });

  it('a link to a missing part or to itself is dropped and the part linked again', () => {
    const m = modelOf([
      ball('body', 2, [0, 2, 0]),
      ball('head', 1, [0, 4.8, 0], { attach: { to: 'torso', method: 'glued', openEnd: 'top' } }),
      ball('ear', 0.4, [0.8, 5.6, 0], { attach: { to: 'ear' } }),
    ]);
    const { model, repairs } = inferAttach(m);
    expectOneTree(model);
    expect(parentsOf(model)).toEqual({ body: null, head: 'body', ear: 'head' });
    expect(model.parts[1].attach).toEqual({ to: 'body', method: 'sewn' }); // a new link: no openEnd
    expect(repairs.map((r) => r.message)).toEqual([
      expect.stringMatching(/^head attached to body: they overlap by [0-9.]+ in³ \(it was attached to "torso", which does not exist\)$/),
      expect.stringMatching(/^ear attached to head: they overlap by [0-9.]+ in³ \(it was attached to itself\)$/),
    ]);
  });

  it('a root with a link that cannot stay loses it, with a repair', () => {
    const m = modelOf([ball('body', 2, [0, 2, 0], { attach: { to: 'ghost' } }), ball('head', 1, [0, 4.8, 0], { attach: { to: 'body' } })]);
    const { model, repairs } = inferAttach(m);
    expect(parentsOf(model)).toEqual({ body: null, head: 'body' });
    expect(model.parts[0].attach).toBeUndefined();
    expect('attach' in model.parts[0]).toBe(false);
    expect(repairs).toEqual([
      { code: 'attach-inferred', part: 'body', message: 'body was attached to "ghost", which does not exist; it is now the root', data: { root: true } },
    ]);
    expect(inferAttach(model).repairs).toEqual([]);
  });

  it('cycles are broken at the part the root rule would choose', () => {
    // body → head → hat → body, and a second cycle a ↔ b
    const m = modelOf([
      ball('body', 2, [0, 2, 0], { attach: { to: 'hat' } }),
      ball('head', 1, [0, 4.8, 0], { attach: { to: 'body' } }),
      ball('hat', 0.6, [0, 6.2, 0], { attach: { to: 'head' } }),
      ball('a', 0.5, [2.3, 2, 0], { attach: { to: 'b' } }),
      ball('b', 0.4, [3, 2, 0], { attach: { to: 'a' } }),
    ]);
    const { model, repairs } = inferAttach(m);
    expectOneTree(model);
    expect(parentsOf(model)).toEqual({ body: null, head: 'body', hat: 'head', a: 'body', b: 'a' });
    expect(repairs.map((r) => r.part)).toEqual(['a', 'body']);
    expect(repairs[0].message).toMatch(/\(it was attached to "b" in a cycle \(a → b\)\)$/);
    expect(repairs[1].message).toBe('body was attached to "hat" in a cycle (body → head → hat); it is now the root');
    expect(inferAttach(model).repairs).toEqual([]);
  });

  it('duplicate ids do not break it: links go to the first part with that id', () => {
    const m = modelOf([ball('body', 2, [0, 2, 0]), ball('x', 1, [0, 4.8, 0]), ball('x', 0.5, [2.3, 2, 0]), ball('y', 0.3, [2.9, 2, 0], { attach: { to: 'x' } })]);
    const { model } = inferAttach(m);
    const g = attachGraph(model.parts);
    expect(g.roots).toEqual([0]);
    expect(g.parent).toEqual([null, 0, 0, 1]);
  });

  it('duplicate ids: a later part with a repeated id is never a parent, nor the root — no self link, still one tree, idempotent', () => {
    // The larger, lower "a" (index 1) is what the root rule picks; but a link to "a" names index 0, so linking
    // index 0 to it would link index 0 to itself. Index 0 becomes the root and index 1 hangs from it.
    const m = modelOf([ball('a', 0.3, [0, 2, 0]), ball('a', 1, [0, 1, 0])]);
    const r = inferAttach(m);
    expect(r.model.parts[0].attach).toBeUndefined();
    expect(r.model.parts[1].attach).toEqual({ to: 'a', method: 'sewn' });
    expect(attachGraph(r.model.parts).parent).toEqual([null, 0]);
    expect(isOneTree(r.model)).toBe(true);
    expect(inferAttach(r.model).model).toBe(r.model);
    // a later duplicate in the tree is never chosen as a target, even when it overlaps most
    const three = modelOf([ball('body', 2, [0, 2, 0]), ball('x', 0.4, [0, 4.3, 0]), ball('x', 1, [0, 4.5, 0]), ball('y', 0.5, [0, 5.6, 0])]);
    const g = attachGraph(inferAttach(three).model.parts);
    expect(g.isTree).toBe(true);
    expect(g.parent[2]).not.toBe(2);
    expect(g.parent[3]).not.toBe(2);
  });

  it('mesh parts use the supplied SDFs, keyed by meshRef; without one, the ellipsoid inscribed in bboxIn', () => {
    const blob = part('mesh', { meshRef: 'blob-mesh', bboxIn: [1, 1, 1] }, { id: 'blob', position: [0, 4.3, 0] });
    // "top" sits just outside a corner of the blob's bounding box
    const m = modelOf([ball('body', 2, [0, 2, 0]), blob, ball('top', 0.3, [0.6, 4.9, 0.6])]);
    // as its inscribed ellipsoid (a sphere of radius 0.5) the blob stops short of "top"
    const plain = inferAttach(m);
    expect(parentsOf(plain.model)).toEqual({ body: null, blob: 'body', top: 'blob' });
    expect(plain.repairs[0].data?.overlapIn3).toBeGreaterThan(0);
    expect(plain.repairs[1].data?.gapIn).toBeCloseTo(Math.hypot(0.6, 0.6, 0.6) - 0.5 - 0.3, 2);
    // with its real SDF — the mesh fills its box — the corner reaches into "top"
    const cube = (q: Vec3): number => 0.5 - Math.max(Math.abs(q[0]), Math.abs(q[1]), Math.abs(q[2]));
    const withSdf = inferAttach(m, { meshSdf: { 'blob-mesh': cube } });
    expect(parentsOf(withSdf.model)).toEqual({ body: null, blob: 'body', top: 'blob' });
    expect(withSdf.repairs[1].data?.overlapIn3).toBeGreaterThan(0);
    expect(withSdf.repairs[0].data?.overlapIn3).toBeGreaterThan(plain.repairs[0].data?.overlapIn3 as number);
    // keyed by part id as a fallback
    expect(inferAttach(m, { meshSdf: { blob: cube } }).repairs).toEqual(withSdf.repairs);
  });

  it('stays fast when every part overlaps every other: the overlap grids share one work budget', { ...PERF, retry: 2, timeout: 120_000 }, () => {
    // 40 large parts in one small region: 780 overlapping pairs. Unbounded, the grids alone took over a minute.
    const rng = mulberry32(77);
    const parts: Part[] = [];
    for (let i = 0; i < 40; i++) {
      const at: Vec3 = [randomRange(rng, -2, 2), randomRange(rng, 0, 4), randomRange(rng, -2, 2)];
      const rot: Vec3 = [randomRange(rng, -90, 90), 0, randomRange(rng, -90, 90)];
      parts.push(i % 2 === 0 ? part('ellipsoid', { rx: 3, ry: 2.4, rz: 2.7 }, { id: `p${i}`, position: at, rotationDeg: rot }) : part('capsule', { r: 1.5, length: 7 }, { id: `p${i}`, position: at, rotationDeg: rot }));
    }
    const m = modelOf(parts);
    const t0 = performance.now();
    const { model, repairs } = inferAttach(m);
    expect(performance.now() - t0).toBeLessThan(budget(30_000)); // 1–2 s on an idle machine; the strict bound is already generous
    expectOneTree(model);
    expect(repairs).toHaveLength(39);
    expect(JSON.stringify(inferAttach(m).model)).toBe(JSON.stringify(model));
  });

  it('never throws and always ends with one tree, whatever the numbers', () => {
    const broken = modelOf([
      ball('body', 2, [0, 2, 0]),
      ball('nan', Number.NaN, [0, 4, 0]),
      ball('nowhere', 1, [Number.NaN, 0, 0]),
      ball('zero', 0, [0, 0, 0]),
      part('lathe', { profile: [] }, { id: 'empty', position: [1, 1, 1] }),
      part('capsule', { r: -1, length: -5 }, { id: 'negative', position: [0, 1, 0] }),
      ball('inf', Number.POSITIVE_INFINITY, [0, 0, 0]),
      part('lathe', { profile: [[1, 0]] }, { id: 'one_point', position: [5, 0, 0] }),
      { id: 'no_dims', type: 'cone', position: [0, 9, 0], color: 'c1' } as unknown as Part,
      { id: 'egg', type: 'egg', dims: { r: 1 }, position: [3, 3, 3], color: 'c1' } as unknown as Part,
      { ...ball('spin', 1, [2, 2, 0]), rotationDeg: [Number.NaN, 0, 0] },
      part('flat', { shape: 'polygon', w: 1, h: 1, thickness: 0.2, points: [[0, 0], [Number.NaN, 1], [1, 0]] }, { id: 'bad_polygon', position: [0, 2, 2] }),
    ]);
    const { model, repairs } = inferAttach(broken);
    expectOneTree(model);
    expect(repairs).toHaveLength(11);
    expect(inferAttach(model).repairs).toEqual([]);
  });
});

describe('inferAttach: property tests (seeded)', HEAVY, () => {
  it('one tree, no cycles, idempotent, valid repairs — on 60 random models with random links, cycles and dangling links', () => {
    const rng = mulberry32(2026);
    const types: ((id: string, at: Vec3, rot: Vec3) => Part)[] = [
      (id, position, rotationDeg) => part('sphere', { r: randomRange(rng, 0.2, 1.2) }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('ellipsoid', { rx: randomRange(rng, 0.2, 1.2), ry: randomRange(rng, 0.2, 1.2), rz: randomRange(rng, 0.2, 1.2) }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('capsule', { r: 0.3, length: randomRange(rng, 0.6, 2.5) }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('cylinder', { rTop: 0.3, rBottom: 0.5, h: randomRange(rng, 0.3, 2) }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('cone', { r: 0.5, h: randomRange(rng, 0.3, 2) }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('box', { w: randomRange(rng, 0.2, 2), h: randomRange(rng, 0.2, 2), d: randomRange(rng, 0.2, 2) }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('torus', { R: 0.8, r: 0.2, arcDeg: randomRange(rng, 30, 360) }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('lathe', { profile: [[0, 0], [randomRange(rng, 0.3, 1), 0.5], [0, randomRange(rng, 1, 2)]] }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('flat', { shape: 'oval', w: randomRange(rng, 0.4, 1.5), h: 1, thickness: 0.2 }, { id, position, rotationDeg }),
      (id, position, rotationDeg) => part('mesh', { meshRef: `m-${id}`, bboxIn: [1, 1.5, 0.8] }, { id, position, rotationDeg }),
    ];
    for (let trial = 0; trial < 60; trial++) {
      const n = 1 + randomInt(rng, 14);
      const spread = randomRange(rng, 0.5, 4);
      const parts: Part[] = [];
      for (let i = 0; i < n; i++) {
        const at: Vec3 = [randomRange(rng, -spread, spread), randomRange(rng, 0, 2 * spread), randomRange(rng, -spread, spread)];
        const rot: Vec3 = [randomRange(rng, -180, 180), randomRange(rng, -180, 180), randomRange(rng, -180, 180)];
        const p = types[randomInt(rng, types.length)](`p${i}`, at, rot);
        const roll = rng();
        if (roll < 0.35) p.attach = { to: `p${randomInt(rng, n)}` }; // may be itself, may close a cycle
        else if (roll < 0.42) p.attach = { to: 'missing' };
        parts.push(p);
      }
      const m = modelOf(parts);
      const snapshot = JSON.stringify(m);
      const { model, repairs } = inferAttach(m);
      expect(JSON.stringify(m)).toBe(snapshot);
      expectOneTree(model);
      expect(model.parts.map((p) => p.id)).toEqual(parts.map((p) => p.id));
      for (const r of repairs) {
        expect(REPAIR_CODES.has(r.code)).toBe(true);
        expect(r.code).toBe('attach-inferred');
        expect(typeof r.message).toBe('string');
        expect(parts.some((p) => p.id === r.part)).toBe(true);
      }
      // links that were valid and not on a cycle are kept as they were
      const before = attachGraph(parts);
      const after = attachGraph(model.parts);
      const changed = new Set(repairs.map((r) => r.part));
      parts.forEach((p, i) => {
        if (!changed.has(p.id)) expect(after.parent[i]).toBe(before.parent[i]);
      });
      const again = inferAttach(model);
      expect(again.model).toBe(model);
      expect(again.repairs).toEqual([]);
      // deterministic
      expect(JSON.stringify(inferAttach(m))).toBe(JSON.stringify({ model, repairs }));
    }
  });

  it('the other fixtures are already one tree', () => {
    for (const m of [readSpecExample(), readEveryType()]) {
      expect(isOneTree(m)).toBe(true);
      expect(inferAttach(m)).toEqual({ model: m, repairs: [] });
    }
  });
});

describe('attach graph helpers', HEAVY, () => {
  it('attachGraph, attachRoot, subtreeIds, childrenOf', () => {
    const g = attachGraph(canonicalTeddy.parts);
    expect(g.roots).toEqual([0]);
    expect(g.isTree).toBe(true);
    expect(g.children[0].map((i) => canonicalTeddy.parts[i].id)).toEqual(['head', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'tail']);
    expect(attachRoot(canonicalTeddy)?.id).toBe('body');
    expect(subtreeIds(canonicalTeddy, 'head')).toEqual(['head', 'muzzle', 'eye_l', 'eye_r', 'ear_l', 'ear_r', 'nose', 'ear_l_inner', 'ear_r_inner']);
    expect(subtreeIds(canonicalTeddy, 'leg_l')).toEqual(['leg_l', 'foot_pad_l']);
    expect(subtreeIds(canonicalTeddy, 'tail')).toEqual(['tail']);
    expect(subtreeIds(canonicalTeddy, 'nope')).toEqual([]);
    expect(subtreeIds(canonicalTeddy, 'body')).toHaveLength(17);
    expect(childrenOf(canonicalTeddy, 'head').map((p) => p.id)).toEqual(['muzzle', 'eye_l', 'eye_r', 'ear_l', 'ear_r']);
    expect(childrenOf(canonicalTeddy, 'nope')).toEqual([]);
  });

  it('a cycle is neither a tree nor an endless loop', () => {
    const cyclic = [part('sphere', { r: 1 }, { id: 'a', attach: { to: 'b' } }), part('sphere', { r: 1 }, { id: 'b', attach: { to: 'a' } }), part('sphere', { r: 1 }, { id: 'c' })];
    const g = attachGraph(cyclic);
    expect(g.roots).toEqual([2]);
    expect(g.isTree).toBe(false);
    expect(isOneTree({ parts: cyclic })).toBe(false);
    expect(subtreeIds({ parts: cyclic }, 'a')).toEqual(['a', 'b']);
    expect(chooseRoot(cyclic)).toBe(2);
    expect(chooseRoot([cyclic[0], cyclic[1]])).toBe(0);
    expect(chooseRoot([])).toBe(-1);
    expect(isOneTree({ parts: [] })).toBe(false);
  });
});

describe('inferMirrorPairs (§3.7.6)', HEAVY, () => {
  const stripMirrors = (m: CrochetModelV1): CrochetModelV1 => ({
    ...m,
    parts: m.parts.map((p) => {
      const copy = { ...p };
      delete copy.mirrorOf;
      return copy;
    }),
  });
  const bare = stripMirrors(canonicalTeddy);

  it('§3.7.3 golden: mirrorOf inferred for ear_r, ear_r_inner, eye_r, arm_r, leg_r, foot_pad_r → their _l twins (6 chips)', () => {
    const { model, repairs } = inferMirrorPairs(bare);
    expect(Object.fromEntries(model.parts.filter((p) => p.mirrorOf).map((p) => [p.id, p.mirrorOf]))).toEqual({
      eye_r: 'eye_l',
      ear_r: 'ear_l',
      ear_r_inner: 'ear_l_inner',
      arm_r: 'arm_l',
      leg_r: 'leg_l',
      foot_pad_r: 'foot_pad_l',
    });
    expect(repairs).toHaveLength(6);
    expect(repairs.map((r) => r.part)).toEqual(['eye_r', 'ear_r', 'ear_r_inner', 'arm_r', 'leg_r', 'foot_pad_r']);
    expect(repairs[0]).toEqual({ code: 'mirror-inferred', part: 'eye_r', message: 'eye_r is the mirror image of eye_l', data: { mirrorOf: 'eye_l' } });
    // only mirrorOf is added; the _l twins and every other part are the same objects
    model.parts.forEach((p, i) => {
      if (!p.mirrorOf) expect(p).toBe(bare.parts[i]);
      else expect({ ...p, mirrorOf: undefined }).toEqual({ ...bare.parts[i], mirrorOf: undefined });
    });
  });

  it('is idempotent and does not modify its input', () => {
    const snapshot = JSON.stringify(bare);
    const once = inferMirrorPairs(bare);
    expect(JSON.stringify(bare)).toBe(snapshot);
    const twice = inferMirrorPairs(once.model);
    expect(twice.model).toBe(once.model);
    expect(twice.repairs).toEqual([]);
    expect(inferMirrorPairs(canonicalTeddy)).toEqual({ model: canonicalTeddy, repairs: [] });
  });

  it('the §3.6 example already has its pairs; without them, three are inferred', () => {
    const example = readSpecExample();
    expect(inferMirrorPairs(example).repairs).toEqual([]);
    expect(inferMirrorPairs(stripMirrors(example)).repairs.map((r) => [r.part, r.data?.mirrorOf])).toEqual([
      ['ear_r', 'ear_l'],
      ['arm_r', 'arm_l'],
      ['foot_r', 'foot_l'],
    ]);
  });

  const left = part('capsule', { r: 0.3, length: 1.4 }, { id: 'arm_l', position: [1.3, 2.2, 0.75], rotationDeg: [-20, 15, 25] });
  const mirrored = (rest: Partial<Part> = {}, dims = { r: 0.3, length: 1.4 }): Part =>
    part('capsule', dims, { id: 'arm_r', position: [-1.3, 2.2, 0.75], rotationDeg: [-20, -15, -25], ...rest });
  const linked = (right: Part, o?: { tolerance?: number }): boolean => inferMirrorPairs(modelOf([left, right]), o).repairs.length === 1;

  it('needs equal type and dims (±1e-6 relative), positions mirrored across x = 0 (±0.001 in), rotations (a, −b, −c) (±0.5°)', () => {
    expect(linked(mirrored())).toBe(true);
    // dims
    expect(linked(mirrored({}, { r: 0.3, length: 1.4000001 }))).toBe(true);
    expect(linked(mirrored({}, { r: 0.3, length: 1.40001 }))).toBe(false);
    expect(linked({ ...part('cylinder', { rTop: 0.3, rBottom: 0.3, h: 1.4 }), id: 'arm_r', position: [-1.3, 2.2, 0.75], rotationDeg: [-20, -15, -25] })).toBe(false);
    // positions
    expect(linked(mirrored({ position: [-1.3009, 2.2, 0.75] }))).toBe(true);
    expect(linked(mirrored({ position: [-1.3011, 2.2, 0.75] }))).toBe(false);
    expect(linked(mirrored({ position: [-1.3, 2.2009, 0.7491] }))).toBe(true);
    expect(linked(mirrored({ position: [-1.3, 2.2, 0.7515] }))).toBe(false);
    expect(linked(mirrored({ position: [1.3, 2.2, 0.75] }))).toBe(false); // the same place, not mirrored
    // rotations
    expect(linked(mirrored({ rotationDeg: [-20.4, -15.4, -24.6] }))).toBe(true);
    expect(linked(mirrored({ rotationDeg: [-20, -15, -24.4] }))).toBe(false);
    expect(linked(mirrored({ rotationDeg: [-20, 15, 25] }))).toBe(false); // copied, not mirrored
    // the same rotation written with other angles
    expect(linked(mirrored({ rotationDeg: [340, -15, -385] }))).toBe(true);
    expect(linked(mirrored({ rotationDeg: [160, 195, 155] }))).toBe(true); // (a+180, 180−b, c+180) is the same rotation
  });

  it('no rotation on one side counts as [0, 0, 0]; defaults count as written', () => {
    const l = part('sphere', { r: 0.2 }, { id: 'eye_l', position: [0.78, 7.5, 2] });
    const r = part('sphere', { r: 0.2 }, { id: 'eye_r', position: [-0.78, 7.5, 2], rotationDeg: [0, 0, 0] });
    expect(inferMirrorPairs(modelOf([l, r])).repairs).toHaveLength(1);
    const tl = part('torus', { R: 1, r: 0.2 }, { id: 'ring_l', position: [2, 1, 0] });
    const tr = part('torus', { R: 1, r: 0.2, arcDeg: 360 }, { id: 'ring_r', position: [-2, 1, 0] });
    expect(inferMirrorPairs(modelOf([tl, tr])).repairs).toHaveLength(1);
    const cl = part('cylinder', { rTop: 1, rBottom: 1, h: 1 }, { id: 'leg_l', position: [2, 1, 0] });
    const cr = part('cylinder', { rTop: 1, rBottom: 1, h: 1, open: 'top' }, { id: 'leg_r', position: [-2, 1, 0] });
    expect(inferMirrorPairs(modelOf([cl, cr])).repairs).toHaveLength(0);
  });

  it('o.tolerance loosens all three for reconstructions (10%)', () => {
    const rough = mirrored({ position: [-1.25, 2.26, 0.7], rotationDeg: [-24, -11, -29] }, { r: 0.32, length: 1.5 });
    expect(linked(rough)).toBe(false);
    expect(linked(rough, { tolerance: 0.1 })).toBe(true);
    expect(linked(mirrored({}, { r: 0.36, length: 1.4 }), { tolerance: 0.1 })).toBe(false); // 20% off
    expect(linked(mirrored({ position: [-1.0, 2.2, 0.75] }), { tolerance: 0.1 })).toBe(false);
    expect(linked(mirrored({ rotationDeg: [-20, -15, -5] }), { tolerance: 0.1 })).toBe(false);
    expect(linked(mirrored(), { tolerance: Number.NaN })).toBe(true); // a bad tolerance falls back to the default
  });

  it('twin ids: _l/_r, left/right, fl/fr, bl/br, as any _-separated token', () => {
    expect(leftTwinId('ear_r')).toBe('ear_l');
    expect(leftTwinId('ear_r_inner')).toBe('ear_l_inner');
    expect(leftTwinId('foot_pad_r')).toBe('foot_pad_l');
    expect(leftTwinId('wing_right')).toBe('wing_left');
    expect(leftTwinId('right_wing')).toBe('left_wing');
    expect(leftTwinId('leg_fr')).toBe('leg_fl');
    expect(leftTwinId('leg_br')).toBe('leg_bl');
    expect(leftTwinId('r')).toBe('l');
    expect(leftTwinId('ear_l')).toBeNull();
    expect(leftTwinId('rear')).toBeNull();
    expect(leftTwinId('collar')).toBeNull();
    expect(leftTwinId('ear_r_r')).toBe('ear_r_l'); // the last token wins
    for (const [l, r] of [['wing_left', 'wing_right'], ['leg_fl', 'leg_fr'], ['leg_bl', 'leg_br'], ['left_hand', 'right_hand']]) {
      const a = part('sphere', { r: 0.4 }, { id: l, position: [1, 1, 0] });
      const b = part('sphere', { r: 0.4 }, { id: r, position: [-1, 1, 0] });
      expect(inferMirrorPairs(modelOf([b, a])).model.parts[0].mirrorOf).toBe(l);
    }
  });

  it('leaves existing links alone, in either direction, and ignores parts without a twin', () => {
    const l = part('sphere', { r: 0.4 }, { id: 'ear_l', position: [1, 1, 0] });
    const r = part('sphere', { r: 0.4 }, { id: 'ear_r', position: [-1, 1, 0] });
    expect(inferMirrorPairs(modelOf([{ ...l, mirrorOf: 'ear_r' }, r])).repairs).toEqual([]);
    expect(inferMirrorPairs(modelOf([l, { ...r, mirrorOf: 'ear_l' }])).repairs).toEqual([]);
    const other = part('sphere', { r: 0.4 }, { id: 'nose', position: [0, 1, 1] });
    expect(inferMirrorPairs(modelOf([l, { ...r, mirrorOf: 'nose' }, other])).repairs).toEqual([]);
    expect(inferMirrorPairs(modelOf([r, other])).repairs).toEqual([]);
    expect(inferMirrorPairs(modelOf([part('sphere', { r: 0.4 }, { id: 'r', position: [0, 1, 0] })])).repairs).toEqual([]);
  });

  it('never makes a mirror chain: a left twin that mirrors something, or a right twin that is a source, stays unlinked', () => {
    const l = part('sphere', { r: 0.4 }, { id: 'ear_l', position: [1, 1, 0] });
    const r = part('sphere', { r: 0.4 }, { id: 'ear_r', position: [-1, 1, 0] });
    const other = part('sphere', { r: 0.4 }, { id: 'bump', position: [1, 1, 0] });
    // ear_l mirrors bump: ear_r → ear_l would be a chain
    const leftMirrors = modelOf([{ ...l, mirrorOf: 'bump' }, r, other]);
    expect(inferMirrorPairs(leftMirrors).repairs).toEqual([]);
    // bump mirrors ear_r: ear_r → ear_l would make bump → ear_r → ear_l
    const rightIsSource = modelOf([l, r, { ...other, mirrorOf: 'ear_r' }]);
    expect(inferMirrorPairs(rightIsSource).repairs).toEqual([]);
    // within one pass: q_r_l_l is the right twin of q_l_l_l and the left twin of q_r_l_r — only one link is made
    const q = (id: string, x: number): Part => part('sphere', { r: 0.4 }, { id, position: [x, 1, 0] });
    const pass = inferMirrorPairs(modelOf([q('q_l_l_l', 1), q('q_r_l_l', -1), q('q_r_l_r', 1)]));
    expect(pass.repairs.map((x) => [x.part, x.data?.mirrorOf])).toEqual([['q_r_l_l', 'q_l_l_l']]);
    expect(validateModel(pass.model).ok).toBe(true);
    expect(inferMirrorPairs(pass.model).repairs).toEqual([]);
  });

  it('mesh twins are compared by their bounding boxes, not their buffers', () => {
    const l = part('mesh', { meshRef: 'mesh-a', bboxIn: [1, 2, 1] }, { id: 'arm_l', position: [1, 1, 0] });
    const r = part('mesh', { meshRef: 'mesh-b', bboxIn: [1.05, 1.9, 1] }, { id: 'arm_r', position: [-1.02, 1.05, 0] });
    expect(inferMirrorPairs(modelOf([l, r])).repairs).toHaveLength(0);
    expect(inferMirrorPairs(modelOf([l, r]), { tolerance: 0.1 }).repairs).toHaveLength(1);
  });

  it('every-type.json: its three pairs are already linked', () => {
    const m = readEveryType();
    expect(m.parts.filter((p) => p.mirrorOf).map((p) => p.id)).toEqual(['arm_r', 'leg_r', 'ear_r']);
    expect(inferMirrorPairs(m).repairs).toEqual([]);
    expect(inferMirrorPairs(stripMirrors(m)).repairs.map((r) => r.part)).toEqual(['arm_r', 'leg_r', 'ear_r']);
  });
});
