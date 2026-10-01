import { describe, expect, expectTypeOf, it } from 'vitest';
import type { CarryOverFn } from '../../../types/entryPoints';
import type { CrochetModelV1, Feature, PaletteColor, Part } from '../../../types/model';
import { deltaE00Hex } from '../../kernel/color';
import { mulberry32, randomInt } from '../../kernel/prng';
import { carryOver, carryOverWith, emptyCarryReport, MAX_FEATURES, MAX_PALETTE, sameShapeWithin } from '../revisions';

// ---- builders

const PALETTE: PaletteColor[] = [
  { id: 'c1', hex: '#C8A27A', name: 'tan', role: 'main' },
  { id: 'c2', hex: '#F4EBDD', name: 'cream', role: 'accent' },
  { id: 'c3', hex: '#F2A7B5', name: 'pink', role: 'accent' },
  { id: 'c4', hex: '#222222', name: 'black', role: 'detail' },
];

function model(parts: Part[], o: Partial<CrochetModelV1> = {}): CrochetModelV1 {
  return {
    schema: 'crochet-model',
    version: '1.0',
    revision: 0,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: 'test toy',
    finishedSize: { height: 8 },
    palette: PALETTE,
    parts,
    ...o,
  };
}

const base = { position: [0, 0, 0] as [number, number, number], color: 'c1' };
const sphere = (id: string, r = 1, more: Partial<Part> = {}): Part => ({ ...base, id, type: 'sphere', dims: { r }, ...more }) as Part;
const ellipsoid = (id: string, rx: number, ry: number, rz: number, more: Partial<Part> = {}): Part =>
  ({ ...base, id, type: 'ellipsoid', dims: { rx, ry, rz }, ...more }) as Part;
const lathe = (id: string, profile: [number, number][], more: Partial<Part> = {}): Part => ({ ...base, id, type: 'lathe', dims: { profile }, ...more }) as Part;

/** A 64 × 64 paint field whose cell (u, v) holds `fn(u, v)`. */
function paint(fn: (u: number, v: number) => number): NonNullable<Part['paint']> {
  const cells = new Uint8Array(64 * 64);
  for (let v = 0; v < 64; v++) for (let u = 0; u < 64; u++) cells[v * 64 + u] = fn(u, v);
  return { kind: 'uv64', data: Buffer.from(cells).toString('base64') };
}

const cellsOf = (p: Part['paint']): Uint8Array => new Uint8Array(Buffer.from(p?.data ?? '', 'base64'));

/** Stripes of palette indices 0 and 2, with an unpainted column. */
const STRIPES = paint((u, v) => (u === 0 ? 255 : v % 2 === 0 ? 0 : 2));

function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

const part = (m: CrochetModelV1, id: string): Part => {
  const found = m.parts.find((p) => p.id === id);
  if (!found) throw new Error(`no part ${id}`);
  return found;
};

// ---- tests

describe('carryOver: no previous model', () => {
  it('has the frozen signature of §5.2.1', () => {
    expectTypeOf(carryOver).toEqualTypeOf<CarryOverFn>();
  });

  it('returns the new model itself and an empty report', () => {
    const next = model([sphere('body', 1, { crochet: { make: 'piece' }, paint: STRIPES })]);
    const { model: out, report } = carryOver(undefined, next);
    expect(out).toBe(next);
    expect(report).toEqual({ crochet: [], paint: [], paintDropped: [], features: [] });
    expect(report).toEqual(emptyCarryReport());
  });
});

describe('carryOver: crochet hints', () => {
  it('carries hints by part id, whatever happened to the shape', () => {
    const prev = deepFreeze(
      model([
        sphere('body', 2, { crochet: { make: 'piece', start: 'top', seamAzimuthDeg: 90 } }),
        sphere('head', 1.5, { crochet: { style: 'exact', seed: [0.1, 0.2, 0.3] } }),
        sphere('tail', 0.4, { crochet: { make: 'skip' } }),
        sphere('ear_l', 0.3),
      ]),
    );
    const next = deepFreeze(
      model([
        lathe('body', [
          [0, 0],
          [2, 1],
          [0, 4],
        ]), // another type: hints are carried anyway
        ellipsoid('head', 3, 3, 3), // twice the size
        sphere('ear_l', 0.3),
        sphere('nose', 0.2), // new part
      ]),
    );
    const { model: out, report } = carryOver(prev, next);
    expect(report).toEqual({ crochet: ['body', 'head'], paint: [], paintDropped: [], features: [] });
    expect(part(out, 'body').crochet).toEqual({ make: 'piece', start: 'top', seamAzimuthDeg: 90 });
    expect(part(out, 'head').crochet).toEqual({ style: 'exact', seed: [0.1, 0.2, 0.3] });
    expect(part(out, 'body').type).toBe('lathe');
    expect(part(out, 'ear_l')).toBe(part(next, 'ear_l')); // untouched parts are shared, not copied
    expect(part(out, 'nose')).toBe(part(next, 'nose'));
    expect(out.parts.map((p) => p.id)).toEqual(['body', 'head', 'ear_l', 'nose']); // the removed tail stays removed
    expect(out.palette).toBe(next.palette);
    expect(part(next, 'body').crochet).toBeUndefined(); // the input was not changed (it is frozen)
  });

  it('lets the user’s previous hint win over a hint the new model brings, key by key', () => {
    const prev = model([sphere('body', 1, { crochet: { make: 'applique', axis: 'x' } })]);
    const next = model([sphere('body', 1, { crochet: { make: 'piece', start: 'bottom' } })]);
    const { model: out, report } = carryOver(prev, next);
    expect(part(out, 'body').crochet).toEqual({ make: 'applique', axis: 'x', start: 'bottom' });
    expect(report.crochet).toEqual(['body']);
  });

  it('reports nothing when there is nothing to carry or nothing would change', () => {
    const hints = { make: 'piece', seed: [1, 2, 3] } as const;
    const prev = model([
      sphere('a', 1, { crochet: { ...hints, seed: [1, 2, 3] } }),
      sphere('b', 1, { crochet: {} }),
      sphere('c', 1),
      sphere('d', 1, { crochet: { start: undefined } }),
    ]);
    const next = model([sphere('a', 1, { crochet: { ...hints, seed: [1, 2, 3], style: 'classic' } }), sphere('b', 1), sphere('c', 1), sphere('d', 1)]);
    const { model: out, report } = carryOver(prev, next);
    expect(report).toEqual(emptyCarryReport());
    expect(out).toBe(next);
  });
});

describe('carryOver: paint, only when the type is unchanged and every dim is within 10%', () => {
  const carried = (prevPart: Part, nextPart: Part): 'paint' | 'paintDropped' | 'neither' => {
    const { report, model: out } = carryOver(model([prevPart]), model([nextPart]));
    if (report.paint.includes(nextPart.id)) {
      expect(part(out, nextPart.id).paint).toEqual(prevPart.paint);
      expect(report.paintDropped).toEqual([]);
      return 'paint';
    }
    if (report.paintDropped.includes(nextPart.id)) {
      expect(part(out, nextPart.id).paint).toEqual(nextPart.paint);
      return 'paintDropped';
    }
    return 'neither';
  };

  it('carries at exactly 10% and drops just beyond, in both directions', () => {
    const painted = sphere('body', 2, { paint: STRIPES });
    expect(carried(painted, sphere('body', 2))).toBe('paint');
    expect(carried(painted, sphere('body', 2.2))).toBe('paint'); // +10%
    expect(carried(painted, sphere('body', 1.8))).toBe('paint'); // −10%
    expect(carried(painted, sphere('body', 2.21))).toBe('paintDropped');
    expect(carried(painted, sphere('body', 1.79))).toBe('paintDropped');
    expect(carried(painted, sphere('body', 4))).toBe('paintDropped');
  });

  it('checks every dim, not their average', () => {
    const painted = ellipsoid('head', 1, 2, 3, { paint: STRIPES });
    expect(carried(painted, ellipsoid('head', 1.05, 2.1, 2.8))).toBe('paint');
    expect(carried(painted, ellipsoid('head', 1, 2, 3.4))).toBe('paintDropped');
    expect(carried(painted, ellipsoid('head', 1.2, 2, 3))).toBe('paintDropped');
  });

  it('drops when the type changed, even with the "same" size', () => {
    expect(carried(sphere('head', 1, { paint: STRIPES }), ellipsoid('head', 1, 1, 1))).toBe('paintDropped');
  });

  it('ignores position, rotation and color: paint lives in the part’s own frame', () => {
    const moved = sphere('body', 2, { position: [5, 5, 5], rotationDeg: [0, 90, 0], color: 'c3' });
    expect(carried(sphere('body', 2, { paint: STRIPES }), moved)).toBe('paint');
  });

  it('lists a part in neither list when it had no paint, or when the new model already has the same paint', () => {
    expect(carried(sphere('body', 2), sphere('body', 2))).toBe('neither');
    expect(carried(sphere('body', 2, { paint: STRIPES }), sphere('body', 9, { paint: { ...STRIPES } }))).toBe('neither');
  });

  it('replaces paint the new model brought with the user’s previous paint when the shape matches', () => {
    const other = paint(() => 1);
    const { model: out, report } = carryOver(model([sphere('body', 2, { paint: STRIPES })]), model([sphere('body', 2.1, { paint: other })]));
    expect(report.paint).toEqual(['body']);
    expect(part(out, 'body').paint).toEqual(STRIPES);
    // and keeps the new model's paint when the shape does not match
    const dropped = carryOver(model([sphere('body', 2, { paint: STRIPES })]), model([sphere('body', 3, { paint: other })]));
    expect(dropped.report.paintDropped).toEqual(['body']);
    expect(part(dropped.model, 'body').paint).toEqual(other);
  });

  it('does not list parts that no longer exist', () => {
    const { report } = carryOver(model([sphere('body', 2, { paint: STRIPES }), sphere('tail', 1, { paint: STRIPES })]), model([sphere('body', 2)]));
    expect(report).toEqual({ crochet: [], paint: ['body'], paintDropped: [], features: [] });
  });

  it('honors carryPaintAnyway, and only for parts whose paint was dropped', () => {
    const prev = model([sphere('body', 2, { paint: STRIPES }), sphere('head', 1, { paint: STRIPES }), sphere('tail', 1, { paint: STRIPES })]);
    const next = model([sphere('body', 3), ellipsoid('head', 1, 1, 1), sphere('tail', 1)]);
    expect(carryOver(prev, next).report).toMatchObject({ paint: ['tail'], paintDropped: ['body', 'head'] });

    const forced = carryOverWith(prev, next, { carryPaintAnyway: ['head', 'tail', 'no_such_part'] });
    expect(forced.report).toEqual({ crochet: [], paint: ['head', 'tail'], paintDropped: ['body'], features: [] });
    expect(part(forced.model, 'head').paint).toEqual(STRIPES);
    expect(part(forced.model, 'head').type).toBe('ellipsoid');
    expect(part(forced.model, 'body').paint).toBeUndefined();

    const all = carryOverWith(prev, next, { carryPaintAnyway: ['body', 'head'] });
    expect(all.report.paintDropped).toEqual([]);
    expect(all.report.paint).toEqual(['body', 'head', 'tail']);
  });

  it('carryOver is carryOverWith without options', () => {
    const prev = model([sphere('body', 2, { paint: STRIPES, crochet: { make: 'piece' } })]);
    const next = model([sphere('body', 2.5)]);
    expect(carryOver(prev, next)).toEqual(carryOverWith(prev, next));
    expect(carryOver(prev, next)).toEqual(carryOverWith(prev, next, {}));
  });
});

describe('sameShapeWithin: every part type', () => {
  const p = (type: Part['type'], dims: object): Part => ({ ...base, id: 'x', type, dims }) as Part;
  const cases: [string, Part, Part, boolean][] = [
    ['capsule within', p('capsule', { r: 0.5, length: 2 }), p('capsule', { r: 0.54, length: 1.85 }), true],
    ['capsule length off', p('capsule', { r: 0.5, length: 2 }), p('capsule', { r: 0.5, length: 2.3 }), false],
    ['cylinder within, open ignored', p('cylinder', { rTop: 1, rBottom: 1, h: 2, open: 'none' }), p('cylinder', { rTop: 1.05, rBottom: 0.95, h: 2.1, open: 'top' }), true],
    ['cylinder h off', p('cylinder', { rTop: 1, rBottom: 1, h: 2 }), p('cylinder', { rTop: 1, rBottom: 1, h: 2.5 }), false],
    ['cylinder with a closed top stays closed', p('cylinder', { rTop: 0, rBottom: 1, h: 2 }), p('cylinder', { rTop: 0, rBottom: 1, h: 2 }), true],
    ['cylinder whose closed top opened', p('cylinder', { rTop: 0, rBottom: 1, h: 2 }), p('cylinder', { rTop: 0.05, rBottom: 1, h: 2 }), false],
    ['cone within', p('cone', { r: 1, h: 2 }), p('cone', { r: 0.91, h: 2.19 }), true],
    ['cone r off', p('cone', { r: 1, h: 2 }), p('cone', { r: 0.8, h: 2 }), false],
    ['torus within, full ring by default', p('torus', { R: 2, r: 0.5 }), p('torus', { R: 2.1, r: 0.5, arcDeg: 360 }), true],
    ['torus arc off', p('torus', { R: 2, r: 0.5 }), p('torus', { R: 2, r: 0.5, arcDeg: 180 }), false],
    ['flat within', p('flat', { shape: 'oval', w: 1, h: 2, thickness: 0.2 }), p('flat', { shape: 'oval', w: 1.1, h: 1.9, thickness: 0.21 }), true],
    ['flat other shape', p('flat', { shape: 'oval', w: 1, h: 2, thickness: 0.2 }), p('flat', { shape: 'rect', w: 1, h: 2, thickness: 0.2 }), false],
    ['flat w off', p('flat', { shape: 'oval', w: 1, h: 2, thickness: 0.2 }), p('flat', { shape: 'oval', w: 1.5, h: 2, thickness: 0.2 }), false],
    [
      'polygon within',
      p('flat', { shape: 'polygon', w: 2, h: 2, thickness: 0.1, points: [[0, 0], [2, 0], [1, 2]] }),
      p('flat', { shape: 'polygon', w: 2, h: 2, thickness: 0.1, points: [[0.1, 0], [2, 0.1], [1, 1.9]] }),
      true,
    ],
    [
      'polygon with another point count',
      p('flat', { shape: 'polygon', w: 2, h: 2, thickness: 0.1, points: [[0, 0], [2, 0], [1, 2]] }),
      p('flat', { shape: 'polygon', w: 2, h: 2, thickness: 0.1, points: [[0, 0], [2, 0], [2, 2], [0, 2]] }),
      false,
    ],
    [
      'polygon with a moved point',
      p('flat', { shape: 'polygon', w: 2, h: 2, thickness: 0.1, points: [[0, 0], [2, 0], [1, 2]] }),
      p('flat', { shape: 'polygon', w: 2, h: 2, thickness: 0.1, points: [[0, 0], [2, 0], [0, 2]] }),
      false,
    ],
    ['box within', p('box', { w: 1, h: 2, d: 3 }), p('box', { w: 1.1, h: 1.8, d: 3.3 }), true],
    ['box d off', p('box', { w: 1, h: 2, d: 3 }), p('box', { w: 1, h: 2, d: 3.31 }), false],
    ['mesh within (bbox), another meshRef', p('mesh', { meshRef: 'a', bboxIn: [1, 2, 3] }), p('mesh', { meshRef: 'b', bboxIn: [1.05, 2.1, 2.9] }), true],
    ['mesh bbox off', p('mesh', { meshRef: 'a', bboxIn: [1, 2, 3] }), p('mesh', { meshRef: 'a', bboxIn: [1, 2, 4] }), false],
    // another type never matches, also when it happens to have dims of the same names and values
    ['sphere vs capsule', p('sphere', { r: 1 }), p('capsule', { r: 1, length: 2 }), false],
    ['sphere vs cone', p('sphere', { r: 1 }), p('cone', { r: 1, h: 2 }), false],
    ['sphere vs torus', p('sphere', { r: 1 }), p('torus', { R: 3, r: 1 }), false],
    ['cone vs cylinder', p('cone', { r: 1, h: 2 }), p('cylinder', { rTop: 1, rBottom: 1, h: 2 }), false],
    ['box vs flat', p('box', { w: 1, h: 2, d: 3 }), p('flat', { shape: 'rect', w: 1, h: 2, thickness: 3 }), false],
  ];
  for (const [label, prev, next, expected] of cases) {
    it(label, () => {
      expect(sameShapeWithin(prev, next)).toBe(expected);
    });
  }

  it('compares lathes as curves, so a body that came back with other points still matches', () => {
    const pear: [number, number][] = [
      [0, 0],
      [0.7, 0.03],
      [0.97, 0.22],
      [1, 0.42],
      [0.82, 0.7],
      [0.55, 0.92],
      [0, 1],
    ];
    const scaled = (k: number, ky = k): [number, number][] => pear.map(([r, y]) => [r * k, y * ky]);
    // the same curve with a point inserted in the middle of every segment
    const dense: [number, number][] = [];
    for (let i = 0; i < pear.length - 1; i++) {
      dense.push(pear[i], [(pear[i][0] + pear[i + 1][0]) / 2, (pear[i][1] + pear[i + 1][1]) / 2]);
    }
    dense.push(pear[pear.length - 1]);
    expect(dense.length).toBe(13);
    expect(sameShapeWithin(lathe('body', pear), lathe('body', dense))).toBe(true);
    expect(sameShapeWithin(lathe('body', pear), lathe('body', scaled(1.08)))).toBe(true);
    expect(sameShapeWithin(lathe('body', pear), lathe('body', scaled(1.2)))).toBe(false); // 20% larger
    expect(sameShapeWithin(lathe('body', pear), lathe('body', scaled(1, 1.15)))).toBe(false); // 15% taller
    expect(sameShapeWithin(lathe('body', pear), lathe('body', scaled(1.15, 1)))).toBe(false); // 15% wider
    // a base moved up does not matter (position is not a dim), a different silhouette does
    expect(sameShapeWithin(lathe('body', pear), lathe('body', pear.map(([r, y]) => [r, y + 3])))).toBe(true);
    const cylinder: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(sameShapeWithin(lathe('body', pear), lathe('body', cylinder))).toBe(false);
    expect(sameShapeWithin(lathe('body', cylinder), lathe('body', cylinder))).toBe(true);
    expect(sameShapeWithin(lathe('body', cylinder, { paint: STRIPES }), lathe('body', cylinder.map(([r, y]) => [r * 1.05, y])))).toBe(true);
  });
});

describe('sameShapeWithin: dimensions that are missing or not numbers', () => {
  const p = (type: Part['type'], dims: unknown): Part => ({ ...base, id: 'x', type, dims }) as Part;
  const cases: [string, Part, Part][] = [
    ['no dims at all', p('sphere', {}), p('sphere', {})],
    ['NaN', p('sphere', { r: Number.NaN }), p('sphere', { r: Number.NaN })],
    ['a missing optional-looking dim', p('capsule', { r: 1 }), p('capsule', { r: 1, length: 2 })],
    ['a lathe without a profile', p('lathe', {}), p('lathe', { profile: [[0, 0], [1, 1]] })],
    ['a lathe whose profile is not a list of points', p('lathe', { profile: [1, 2, 3] }), p('lathe', { profile: [1, 2, 3] })],
    ['an empty profile', p('lathe', { profile: [] }), p('lathe', { profile: [] })],
    ['a profile with NaN', p('lathe', { profile: [[0, 0], [Number.NaN, 1]] }), p('lathe', { profile: [[0, 0], [Number.NaN, 1]] })],
    ['a polygon whose points are not points', p('flat', { shape: 'polygon', w: 1, h: 1, thickness: 0.1, points: [1, 2] }), p('flat', { shape: 'polygon', w: 1, h: 1, thickness: 0.1, points: [1, 2] })],
    ['a mesh without a bounding box', p('mesh', { meshRef: 'm' }), p('mesh', { meshRef: 'm' })],
  ];
  for (const [label, prev, next] of cases) {
    it(`${label}: no match, and no exception`, () => {
      expect(sameShapeWithin(prev, next)).toBe(false);
      expect(sameShapeWithin(next, prev)).toBe(false);
      // and carryOver keeps the paint in the previous revision instead of throwing
      const { report } = carryOver(model([{ ...prev, paint: STRIPES } as Part]), model([next]));
      expect(report.paintDropped).toEqual(['x']);
    });
  }

  it('compares degenerate but well-formed lathes without dividing by zero', () => {
    const disc: [number, number][] = [
      [0, 0],
      [1, 0],
      [0, 0],
    ]; // zero height
    expect(sameShapeWithin(lathe('a', disc), lathe('a', disc))).toBe(true);
    expect(sameShapeWithin(lathe('a', disc), lathe('a', [[0, 0], [1.5, 0], [0, 0]]))).toBe(false);
    expect(sameShapeWithin(lathe('a', [[1, 2]]), lathe('a', [[1, 2]]))).toBe(true); // a single point
    expect(sameShapeWithin(lathe('a', [[1, 2]]), lathe('a', [[2, 2]]))).toBe(false);
    const zigzag: [number, number][] = [
      [0, 0],
      [1, 1],
      [0.5, 0.5],
      [0, 2],
    ]; // y goes back: not a valid profile, but still comparable with itself
    expect(sameShapeWithin(lathe('a', zigzag), lathe('a', zigzag))).toBe(true);
  });
});

describe('carryOver: paint follows its colors when the palette changed', () => {
  // prev uses palette index 0 (c1 tan) and 2 (c3 pink)
  const prev = model([sphere('body', 2, { paint: STRIPES })]);

  it('keeps the data as it is when the palette did not change', () => {
    const { model: out } = carryOver(prev, model([sphere('body', 2)]));
    expect(part(out, 'body').paint).toBe(part(prev, 'body').paint);
  });

  it('re-indexes by palette id when the new palette is in another order', () => {
    const reordered = [PALETTE[3], PALETTE[2], PALETTE[1], PALETTE[0]];
    const next = model([sphere('body', 2)], { palette: reordered });
    const { model: out, report } = carryOver(prev, next);
    expect(report.paint).toEqual(['body']);
    const before = cellsOf(STRIPES);
    const after = cellsOf(part(out, 'body').paint);
    expect(after.length).toBe(4096);
    for (let i = 0; i < 4096; i++) {
      if (before[i] === 255) expect(after[i]).toBe(255);
      else expect(out.palette[after[i]].id).toBe(PALETTE[before[i]].id);
    }
    expect(out.palette).toBe(next.palette); // nothing had to be added
  });

  it('follows a palette id whose color changed (a recolor), like the part base colors do', () => {
    const recolored = PALETTE.map((c) => (c.id === 'c3' ? { ...c, hex: '#0000ff' } : c));
    const { model: out } = carryOver(prev, model([sphere('body', 2)], { palette: recolored }));
    expect(part(out, 'body').paint).toEqual(STRIPES);
    expect(out.palette).toEqual(recolored);
  });

  it('maps to the same hex under another id, and adds a color the new palette lacks', () => {
    const next = model([sphere('body', 2, { color: 'brown' })], {
      palette: [
        { id: 'cream', hex: '#f4ebdd' },
        { id: 'brown', hex: '#c8a27a' }, // the tan of c1, renamed and lower-case
      ],
    });
    const { model: out } = carryOver(prev, deepFreeze(next));
    expect(out.palette).toEqual([{ id: 'cream', hex: '#f4ebdd' }, { id: 'brown', hex: '#c8a27a' }, PALETTE[2]]); // pink appended
    expect(next.palette).toHaveLength(2); // the input palette was not touched
    const before = cellsOf(STRIPES);
    const after = cellsOf(part(out, 'body').paint);
    for (let i = 0; i < 4096; i++) {
      if (before[i] === 255) expect(after[i]).toBe(255);
      else if (before[i] === 0) expect(after[i]).toBe(1);
      else expect(after[i]).toBe(2);
    }
  });

  it('uses the nearest color when the new palette is full', () => {
    const full: PaletteColor[] = Array.from({ length: MAX_PALETTE }, (_, i) => ({ id: `n${i}`, hex: `#${(i * 16).toString(16).padStart(2, '0')}0000` }));
    full[5] = { id: 'n5', hex: '#f0a8b8' }; // close to the pink of c3
    full[9] = { id: 'n9', hex: '#c9a077' }; // close to the tan of c1
    const { model: out } = carryOver(prev, model([sphere('body', 2, { color: 'n0' })], { palette: full }));
    expect(out.palette).toHaveLength(MAX_PALETTE);
    const after = new Set(cellsOf(part(out, 'body').paint));
    expect([...after].sort((a, b) => a - b)).toEqual([5, 9, 255]);
    expect(deltaE00Hex(PALETTE[2].hex, full[5].hex)).toBeLessThan(5);
  });

  it('turns an index that names no color into "not painted"', () => {
    const odd = sphere('body', 2, { paint: paint((u) => (u < 32 ? 9 : 1)) }); // 9 is beyond the 4-color palette
    const { model: out } = carryOver(model([odd]), model([sphere('body', 2)], { palette: [PALETTE[1]] }));
    const after = new Set(cellsOf(part(out, 'body').paint));
    expect([...after].sort((a, b) => a - b)).toEqual([0, 255]);
  });

  it('carries a field it cannot read only when the palette indices did not move', () => {
    const broken = sphere('body', 2, { paint: { kind: 'uv64', data: 'not a 64 × 64 field' } });
    const same = carryOver(model([broken]), model([sphere('body', 2)], { palette: [...PALETTE, { id: 'c5', hex: '#00ff00' }] }));
    expect(same.report.paint).toEqual(['body']);
    expect(part(same.model, 'body').paint).toEqual(broken.paint);
    const moved = carryOverWith(model([broken]), model([sphere('body', 2)], { palette: [PALETTE[1], PALETTE[0]] }), { carryPaintAnyway: ['body'] });
    expect(moved.report).toMatchObject({ paint: [], paintDropped: ['body'] });
    expect(part(moved.model, 'body').paint).toBeUndefined();
    // a short field is as unreadable as a malformed one
    const short = sphere('body', 2, { paint: { kind: 'uv64', data: Buffer.from(new Uint8Array(100)).toString('base64') } });
    expect(carryOver(model([short]), model([sphere('body', 2)], { palette: [PALETTE[1], PALETTE[0]] })).report.paintDropped).toEqual(['body']);
  });
});

describe('carryOver: features added in the editor', () => {
  const eye = (id: string, on = 'head', more: Partial<Feature> = {}): Feature => ({ id, kind: 'safety_eye', on, azimuthDeg: 30, elevationDeg: -10, ...more });

  it('appends the previous features the new model lacks, when their part still exists', () => {
    const prev = model([sphere('head'), sphere('body'), sphere('tail')], {
      features: [eye('eye_l'), eye('nose', 'head', { kind: 'nose' }), eye('tail_tip', 'tail'), eye('cheek', 'head', { kind: 'cheek', color: 'c3' })],
    });
    const next = deepFreeze(model([sphere('head'), sphere('body')], { features: [eye('eye_l', 'head', { sizeMm: 12 })] }));
    const { model: out, report } = carryOver(deepFreeze(prev), next);
    expect(report.features).toEqual(['nose', 'cheek']); // eye_l exists in the new model; the tail is gone
    expect(out.features?.map((f) => f.id)).toEqual(['eye_l', 'nose', 'cheek']);
    expect(out.features?.[0]).toBe(next.features?.[0]); // the new model's own feature wins
    expect(out.features?.[0].sizeMm).toBe(12);
    expect(next.features).toHaveLength(1);
    expect(out.parts).toBe(next.parts);
  });

  it('works when either model has no features at all', () => {
    const withFeatures = model([sphere('head')], { features: [eye('eye_l')] });
    const without = model([sphere('head')]);
    expect(carryOver(withFeatures, without).model.features).toEqual([eye('eye_l')]);
    expect(carryOver(without, withFeatures).model).toBe(withFeatures);
    expect(carryOver(without, without).model.features).toBeUndefined();
  });

  it('keeps a carried feature’s color by identity', () => {
    const prev = model([sphere('head')], { features: [eye('cheek', 'head', { color: 'c3' }), eye('brow', 'head', { color: 'c4' }), eye('dot', 'head', { color: 'zz' })] });
    const next = model([sphere('head', 1, { color: 'ink' })], { palette: [{ id: 'ink', hex: '#222222' }] });
    const { model: out } = carryOver(prev, next);
    expect(out.palette).toEqual([{ id: 'ink', hex: '#222222' }, PALETTE[2]]); // pink was added, black was found by hex
    const byId = Object.fromEntries((out.features ?? []).map((f) => [f.id, f.color]));
    expect(byId).toEqual({ cheek: 'c3', brow: 'ink', dot: 'zz' }); // an id that named nothing is left alone
  });

  it('never exceeds the schema’s 60 features', () => {
    const many = (prefix: string, n: number): Feature[] => Array.from({ length: n }, (_, i) => eye(`${prefix}${i}`));
    const { model: out, report } = carryOver(model([sphere('head')], { features: many('old', 30) }), model([sphere('head')], { features: many('new', 55) }));
    expect(out.features).toHaveLength(MAX_FEATURES);
    expect(report.features).toEqual(['old0', 'old1', 'old2', 'old3', 'old4']);
  });
});

describe('carryOver: invariants over random models (seeded)', () => {
  const TYPES = ['sphere', 'ellipsoid', 'capsule'] as const;
  const randomPart = (rng: () => number, id: string, paletteSize: number): Part => {
    const type = TYPES[randomInt(rng, TYPES.length)];
    const size = 0.5 + rng() * 2;
    const dims = type === 'sphere' ? { r: size } : type === 'ellipsoid' ? { rx: size, ry: size * 1.1, rz: size * 0.9 } : { r: size * 0.3, length: size * 2 };
    const more: Partial<Part> = {};
    if (rng() < 0.5) more.crochet = { make: rng() < 0.5 ? 'piece' : 'applique', seamAzimuthDeg: randomInt(rng, 360) };
    if (rng() < 0.6) {
      const a = randomInt(rng, paletteSize);
      const b = randomInt(rng, paletteSize);
      more.paint = paint((u, v) => ((u + v) % 7 === 0 ? 255 : u < 32 ? a : b));
    }
    return { ...base, id, type, dims, ...more } as Part;
  };
  const randomPalette = (rng: () => number, n: number, prefix: string): PaletteColor[] =>
    Array.from({ length: n }, (_, i) => ({
      id: rng() < 0.6 ? `c${i}` : `${prefix}${i}`,
      hex: `#${randomInt(rng, 0x1000000).toString(16).padStart(6, '0')}`,
    }));
  const randomModel = (rng: () => number, prefix: string): CrochetModelV1 => {
    const palette = randomPalette(rng, 1 + randomInt(rng, MAX_PALETTE), prefix);
    const ids = ['body', 'head', 'arm_l', 'arm_r', 'tail', 'ear_l'].filter(() => rng() < 0.75);
    if (ids.length === 0) ids.push('body');
    const features: Feature[] = ids
      .filter(() => rng() < 0.4)
      .map((on, i) => ({ id: rng() < 0.5 ? `f${i}` : `${prefix}f${i}`, kind: 'nose', on, azimuthDeg: 0, elevationDeg: 0, color: palette[randomInt(rng, palette.length)].id }));
    return model(
      ids.map((id) => randomPart(rng, id, palette.length)),
      { palette, features },
    );
  };

  it('never mutates its inputs, reports only what it did, and is idempotent', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const rng = mulberry32(seed);
      const prev = deepFreeze(randomModel(rng, 'p'));
      const next = deepFreeze(randomModel(rng, 'n'));
      const anyway = prev.parts.filter(() => rng() < 0.3).map((p) => p.id);
      const { model: out, report } = carryOverWith(prev, next, { carryPaintAnyway: anyway });

      const nextIds = next.parts.map((p) => p.id);
      expect(out.parts.map((p) => p.id), `seed ${seed}`).toEqual(nextIds);
      expect(out.palette.length).toBeLessThanOrEqual(MAX_PALETTE);
      expect(out.palette.slice(0, next.palette.length)).toEqual(next.palette); // existing indices never move
      for (const list of [report.crochet, report.paint, report.paintDropped]) {
        for (const id of list) expect(nextIds).toContain(id);
        expect(new Set(list).size).toBe(list.length);
      }
      expect(report.paint.filter((id) => report.paintDropped.includes(id))).toEqual([]);

      for (const p of out.parts) {
        const before = prev.parts.find((q) => q.id === p.id);
        const original = part(next, p.id);
        // geometry and the new model's own fields are never changed
        expect({ ...p, crochet: undefined, paint: undefined }).toEqual({ ...original, crochet: undefined, paint: undefined });
        if (report.crochet.includes(p.id)) expect(p.crochet).toMatchObject(before?.crochet ?? {});
        else expect(p.crochet).toEqual(original.crochet);
        if (report.paint.includes(p.id)) {
          expect(before?.paint).toBeDefined();
          expect(sameShapeWithin(before as Part, original) || anyway.includes(p.id)).toBe(true);
          // every painted cell keeps its color identity, or moved to a color of the new palette
          const from = cellsOf(before?.paint);
          const to = cellsOf(p.paint);
          for (let i = 0; i < 4096; i += 37) {
            if (from[i] === 255) expect(to[i]).toBe(255);
            else {
              expect(to[i]).toBeLessThan(out.palette.length);
              const src = prev.palette[from[i]];
              const dst = out.palette[to[i]];
              if (out.palette.some((c) => c.id === src.id)) expect(dst.id).toBe(src.id);
              else if (out.palette.length < MAX_PALETTE || out.palette.some((c) => c.hex.toLowerCase() === src.hex.toLowerCase())) expect(dst.hex.toLowerCase()).toBe(src.hex.toLowerCase());
            }
          }
        } else {
          expect(p.paint).toEqual(original.paint);
        }
        if (report.paintDropped.includes(p.id)) {
          expect(before?.paint).toBeDefined();
          expect(anyway.includes(p.id)).toBe(false);
        }
      }
      for (const id of report.features) {
        const f = out.features?.find((x) => x.id === id);
        expect(f).toBeDefined();
        expect(nextIds).toContain(f?.on);
        expect(next.features?.some((x) => x.id === id) ?? false).toBe(false);
      }
      expect((out.features ?? []).length).toBe((next.features ?? []).length + report.features.length);

      // a second pass has nothing left to carry
      const again = carryOverWith(prev, out, { carryPaintAnyway: anyway });
      expect(again.model, `seed ${seed}: idempotent`).toBe(out);
      expect(again.report).toEqual({ crochet: [], paint: [], paintDropped: report.paintDropped, features: [] });
    }
  });
});
