import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { CrochetModelV1, Part } from '../../../types/model';
import { encodeUv64 } from '../builder';
import {
  canonicalizeModel,
  crochetModelCoreSchema,
  crochetModelSchema,
  featureSchema,
  isExtensionKey,
  MODEL_LIMITS,
  ModelValidationError,
  paletteColorSchema,
  parseModel,
  partCoreSchema,
  partSchema,
  regionSchema,
  stringifyModel,
  validateModel,
  withExtensions,
} from '../schema';
import { readEveryType } from './helpers/everyType';
import { modelOf, part, readSpecExample } from './helpers/geometry';
import { CANONICAL_TEDDY_URL } from './helpers/teddy';

const clone = <T>(x: T): T => structuredClone(x);
const example = readSpecExample();
const teddy = JSON.parse(readFileSync(CANONICAL_TEDDY_URL, 'utf8')) as CrochetModelV1;
const everyType = readEveryType();

/** The issues of an invalid model as "path: message" lines. */
function problems(input: unknown): string[] {
  const result = validateModel(input);
  return result.ok ? [] : result.issues.map((i) => `${i.path}: ${i.message}`);
}

/** The example with one change applied. */
function changed(edit: (m: CrochetModelV1) => void): CrochetModelV1 {
  const m = clone(example);
  edit(m);
  return m;
}

describe('crochetModelSchema: parse(x) deep-equals x (§3.5.1, nothing stripped)', () => {
  it.each([
    ['the complete example of §3.6', example],
    ['fixtures/models/teddy.canonical.json', teddy],
    ['fixtures/models/every-type.json', everyType],
  ])('%s', (_name, model) => {
    const input = clone(model);
    const parsed = crochetModelSchema.parse(input);
    expect(parsed).toEqual(model);
    expect(input).toEqual(model); // the input is not modified
    expect(validateModel(input)).toEqual({ ok: true, model });
    expect(parseModel(input)).toEqual(model);
    // and a second pass changes nothing
    expect(crochetModelSchema.parse(parsed)).toEqual(model);
  });

  it('the §3.6 example is the one the spec prints: 9 parts, 3 features, revision 3', () => {
    expect(example.name).toBe('Clover the bunny');
    expect(example.revision).toBe(3);
    expect(example.parts.map((p) => p.id)).toEqual(['body', 'head', 'ear_l', 'ear_r', 'arm_l', 'arm_r', 'foot_l', 'foot_r', 'tail']);
    expect(example.features).toHaveLength(3);
  });

  it('keeps every field of every part type — the union does not fall back to a smaller branch', () => {
    // A plain union of stripping objects returns capsule {r, length} as {r}, cone {r, h} as {r}, torus {R, r,
    // arcDeg} as {r} (§3.5.1).
    const parts: Part[] = [
      part('capsule', { r: 0.3, length: 1.4 }, { id: 'a' }),
      part('cone', { r: 0.3, h: 1 }, { id: 'b' }),
      part('torus', { R: 1, r: 0.2, arcDeg: 180 }, { id: 'c' }),
      part('cylinder', { rTop: 0.2, rBottom: 0.3, h: 1, open: 'both' }, { id: 'd' }),
      part('sphere', { r: 0.3 }, { id: 'e' }),
    ];
    const model = modelOf(parts);
    expect(crochetModelSchema.parse(model).parts.map((p) => p.dims)).toEqual(parts.map((p) => p.dims));
    for (const p of parts) expect(partSchema.parse(p)).toEqual(p);
  });
});

describe('extension keys (x-*)', () => {
  it('are kept on the model and on parts, whatever they hold', () => {
    const m = changed((x) => {
      x['x-cpg'] = { project: 'p1', seedRev: 4 };
      x['x-list'] = [1, 'two', { three: [3] }, null];
      x.parts[0]['x-note'] = 'kept';
      x.parts[3]['x-n'] = 0;
    });
    const parsed = crochetModelSchema.parse(m);
    expect(parsed).toEqual(m);
    expect(parsed['x-cpg']).toEqual({ project: 'p1', seedRev: 4 });
    expect(parsed.parts[0]['x-note']).toBe('kept');
    expect(parsed.parts[3]['x-n']).toBe(0);
  });

  it('any other unknown key is an error, at every level', () => {
    expect(problems({ ...example, notes: 'x' })).toEqual([': Unrecognized key: "notes"']);
    expect(problems(changed((m) => Object.assign(m.parts[1], { parent: 'body' })))).toEqual(['parts[1] (head): Unrecognized key: "parent"']);
    expect(problems(changed((m) => Object.assign(m.parts[1].dims, { radius: 1 })))).toEqual(['parts[1] (head).dims: Unrecognized key: "radius"']);
    expect(problems(changed((m) => Object.assign(m.axes, { right: '-X' })))).toEqual(['axes: Unrecognized key: "right"']);
    expect(problems(changed((m) => Object.assign(m.palette[0], { yarn: 'x' })))).toEqual(['palette[0] (c1): Unrecognized key: "yarn"']);
    expect(problems(changed((m) => Object.assign((m.features ?? [])[0], { size: 1 })))).toEqual(['features[0] (eye_l): Unrecognized key: "size"']);
    expect(problems(changed((m) => Object.assign(m.parts[0].regions?.[0] ?? {}, { colour: 'c1' })))).toEqual([
      'parts[0] (body).regions[0]: Unrecognized key: "colour"',
    ]);
    // x- keys are extensions only on the model and on parts
    expect(problems(changed((m) => Object.assign(m.parts[1].dims, { 'x-a': 1 })))).toEqual(['parts[1] (head).dims: Unrecognized key: "x-a"']);
    expect(problems(changed((m) => Object.assign(m.finishedSize, { 'x-a': 1 })))).toEqual(['finishedSize: Unrecognized key: "x-a"']);
  });

  it('withExtensions lifts x-* keys around any strict object schema', () => {
    const schema = withExtensions(z.strictObject({ a: z.number() }));
    expect(schema.parse({ a: 1, 'x-b': [2] })).toEqual({ a: 1, 'x-b': [2] });
    expect(schema.safeParse({ a: 1, b: 2 }).success).toBe(false);
    expect(schema.safeParse({ a: 'no', 'x-b': 2 }).success).toBe(false);
    expect(schema.safeParse(null).success).toBe(false);
    expect(schema.safeParse([1]).success).toBe(false);
    expect(isExtensionKey('x-cpg')).toBe(true);
    expect(isExtensionKey('xcpg')).toBe(false);
    expect(isExtensionKey('X-cpg')).toBe(false);
  });

  it('the core schemas (no extensions) are strict and JSON-Schema-representable (§3.5.2)', () => {
    expect(crochetModelCoreSchema.safeParse(example).success).toBe(true);
    expect(crochetModelCoreSchema.safeParse({ ...example, 'x-cpg': {} }).success).toBe(false);
    expect(partCoreSchema.safeParse({ ...example.parts[0], 'x-a': 1 }).success).toBe(false);
    const json = z.toJSONSchema(crochetModelCoreSchema) as unknown as {
      additionalProperties?: unknown;
      properties: { parts: { items: { oneOf: { properties: { type: { const: string } }; additionalProperties?: unknown }[] } } };
    };
    expect(json.additionalProperties).toBe(false);
    const branches = json.properties.parts.items.oneOf;
    expect(branches.map((b) => b.properties.type.const)).toEqual([
      'sphere',
      'ellipsoid',
      'capsule',
      'cylinder',
      'cone',
      'torus',
      'lathe',
      'flat',
      'box',
      'mesh',
    ]);
    for (const b of branches) expect(b.additionalProperties).toBe(false);
  });
});

describe('invalid models fail with useful messages', () => {
  it('reports the path, the part it concerns and what is wrong', () => {
    expect(problems(changed((m) => (m.parts[4].dims = { r: 0.32, length: 0.5 } as never)))).toEqual([
      'parts[4] (arm_l).dims.length: capsule length is the TOTAL length including both caps: 0.5 is less than 2·r = 0.64',
    ]);
    expect(problems(changed((m) => (m.parts[1].dims = { rx: 1, ry: 0.01, rz: 1 } as never)))).toEqual([
      'parts[1] (head).dims.ry: dims must be at least 0.05 in',
    ]);
    expect(problems(changed((m) => (m.parts[8].dims = { r: 60 } as never)))).toEqual(['parts[8] (tail).dims.r: dims must be at most 48 in']);
    expect(problems(changed((m) => (m.parts[1].color = 'c9')))).toEqual(['parts[1] (head).color: color "c9" is not in the palette']);
    expect(problems(changed((m) => (m.parts[1].attach = { to: 'torso' })))).toEqual([
      'parts[1] (head).attach.to: part "head" is attached to "torso", which does not exist',
    ]);
    expect(problems(changed((m) => (m.parts[3].mirrorOf = 'ear_x')))).toEqual(['parts[3] (ear_r).mirrorOf: part "ear_r" mirrors "ear_x", which does not exist']);
    expect(problems(changed((m) => ((m.features ?? [])[1].on = 'face')))).toEqual(['features[1] (nose).on: feature "nose" sits on "face", which does not exist']);
    expect(problems(changed((m) => (m.parts[2].id = 'head')))).toContain('parts[2] (head).id: duplicate part id "head"');
    expect(problems(changed((m) => (m.palette[1].id = 'c1')))).toContain('palette[1] (c1).id: duplicate palette id "c1"');
    expect(problems(changed((m) => (m.palette[0].hex = 'tan')))).toEqual(['palette[0] (c1).hex: a color must be sRGB hex "#rrggbb"']);
    expect(problems(changed((m) => (m.parts[0].id = 'Body')))[0]).toMatch(/^parts\[0\] \(Body\)\.id: an id must match/);
    expect(problems(changed((m) => ((m as { units: string }).units = 'cm')))).toEqual(['units: Invalid input: expected "in"']);
    expect(problems(changed((m) => (m.version = '2.0')))).toEqual(['version: version must be "1.x" (this app reads crochet-model 1.0 and its minor revisions)']);
    expect(problems(changed((m) => (m.parts[0].position = [0, Number.NaN, 0])))[0]).toMatch(/^parts\[0\] \(body\)\.position\[1\]: Invalid input: expected number/);
  });

  it('rejects an unknown part type, region kind or feature kind by its discriminator', () => {
    expect(problems(changed((m) => ((m.parts[8] as { type: string }).type = 'egg')))[0]).toMatch(/^parts\[8\] \(tail\)\.type: Invalid/);
    expect(problems(changed((m) => ((m.parts[0].regions as { kind: string }[])[0].kind = 'dots')))[0]).toMatch(
      /^parts\[0\] \(body\)\.regions\[0\]\.kind: Invalid/,
    );
    expect(problems(changed((m) => (((m.features ?? [])[0] as { kind: string }).kind = 'button')))[0]).toMatch(/^features\[0\] \(eye_l\)\.kind: Invalid option/);
  });

  it('reports missing required fields and wrong shapes', () => {
    const missing = clone(example) as Partial<CrochetModelV1>;
    delete missing.palette;
    expect(problems(missing)).toEqual(['palette: Invalid input: expected array, received undefined']);
    expect(problems(changed((m) => ((m.parts[1] as { position: number[] }).position = [0, 1])))[0]).toMatch(/^parts\[1\] \(head\)\.position: /);
    expect(problems(null)[0]).toMatch(/expected object/);
    expect(problems('{}')[0]).toMatch(/expected object/);
    expect(problems([])[0]).toMatch(/expected object/);
    expect(problems(changed((m) => (m.parts = [])))).toEqual(['parts: a model needs at least one part']);
    expect(problems(changed((m) => (m.palette = [])))[0]).toBe('palette: the palette needs at least one color');
  });

  it('finds attach links to itself and attach cycles', () => {
    expect(problems(changed((m) => (m.parts[1].attach = { to: 'head' })))).toEqual(['parts[1] (head).attach.to: part "head" is attached to itself']);
    const cyclic = problems(
      changed((m) => {
        m.parts[0].attach = { to: 'ear_l' }; // body → ear_l → head → body
      }),
    );
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0]).toMatch(/^parts\[0\] \(body\)\.attach\.to: the attach links form a cycle through "body"/);
    // several roots are allowed here: the attach tree is completed by inferAttach, not by the schema
    expect(problems(changed((m) => delete m.parts[8].attach))).toEqual([]);
  });

  it('mirrorOf names a source part of the same type: no mirror loops or chains (not in §3.5.1; see the track notes)', () => {
    const at = (m: CrochetModelV1, id: string): Part => m.parts.find((p) => p.id === id) as Part;
    // ear_r mirrors ear_l (§3.6); ear_l mirroring ear_r back is a loop
    const loop = problems(changed((m) => (at(m, 'ear_l').mirrorOf = 'ear_r')));
    expect(loop).toHaveLength(2);
    expect(loop.join('\n')).toMatch(/mirrors "ear_r", which itself mirrors "ear_l": mirrorOf must name a part without mirrorOf/);
    // a chain: foot_r → foot_l → head (both ellipsoids): foot_r is the one at fault
    const chain = problems(changed((m) => (at(m, 'foot_l').mirrorOf = 'head')));
    expect(chain).toHaveLength(1);
    expect(chain[0]).toMatch(/\(foot_r\)\.mirrorOf: part "foot_r" mirrors "foot_l", which itself mirrors "head"/);
    // a different type: a mirror image has its source's type
    const typed = problems(changed((m) => (at(m, 'head').mirrorOf = 'body')));
    expect(typed).toHaveLength(1);
    expect(typed[0]).toMatch(/mirrors "body", a lathe/);
    // the fixtures' pairs are fine
    expect(validateModel(teddy).ok).toBe(true);
    expect(validateModel(everyType).ok).toBe(true);
  });

  it('parseModel throws one readable error listing every problem', () => {
    const bad = changed((m) => {
      m.parts[1].color = 'c9';
      m.parts[8].dims = { r: 0.01 } as never;
    });
    expect(() => parseModel(bad)).toThrow(ModelValidationError);
    try {
      parseModel(bad);
      expect.unreachable();
    } catch (e) {
      const error = e as ModelValidationError;
      expect(error.name).toBe('ModelValidationError');
      expect(error.issues).toHaveLength(1); // the reference checks run once the shapes are valid
      expect(error.message).toBe('invalid crochet-model:\n- parts[8] (tail).dims.r: dims must be at least 0.05 in');
    }
    expect(() => parseModel(changed((m) => (m.parts[1].color = 'c9')))).toThrow('- parts[1] (head).color: color "c9" is not in the palette');
  });
});

describe('semantics of §3.5.2', () => {
  const lathe = (profile: [number, number][], sharp?: number[]): CrochetModelV1 =>
    modelOf([part('lathe', sharp ? { profile, sharp } : { profile }, { id: 'body' })]);

  it('lathe profile: r ≥ 0, y non-decreasing, 3..64 points, sharp indices inside the profile', () => {
    const ok: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
    ];
    expect(problems(lathe(ok, [1, 2]))).toEqual([]);
    expect(problems(lathe([[0, -1], [1, 0], [0, 2]]))).toEqual([]); // y may start below 0: the origin is the y = 0 point
    expect(problems(lathe([[0, 0], [1, 0.3], [-0.5, 0.5], [0, 1]]))).toEqual(['parts[0] (body).dims.profile[2][0]: a profile radius must not be negative']);
    expect(problems(lathe([[0, 0], [1, 0.8], [1, 0.5], [0, 1]]))).toEqual([
      'parts[0] (body).dims.profile[2][1]: profile y must not decrease (bottom → top): point 2 has y = 0.5 after y = 0.8',
    ]);
    expect(problems(lathe([[0, 0], [1, 1]]))).toEqual(['parts[0] (body).dims.profile: a lathe profile needs at least 3 points']);
    const long = Array.from({ length: 65 }, (_, i): [number, number] => [1, i / 64]);
    expect(problems(lathe(long))).toEqual(['parts[0] (body).dims.profile: a lathe profile holds at most 64 points']);
    expect(problems(lathe(long.slice(0, 64)))).toEqual([]);
    expect(problems(lathe(ok, [4]))).toEqual(['parts[0] (body).dims.sharp[0]: sharp index 4 is not a profile point']);
    expect(problems(lathe([[0, 0], [0.01, 0.5], [0, 1]]))).toEqual(["parts[0] (body).dims.profile: the profile's largest radius must be at least 0.05 in"]);
    expect(problems(lathe([[0, 0], [1, 0], [0, 0.01]]))).toEqual([
      "parts[0] (body).dims.profile: the profile's height (last y − first y) must be between 0.05 and 48 in",
    ]);
  });

  it('flat: a polygon needs 3..64 points; the other shapes do not', () => {
    const flat = (dims: Extract<Part, { type: 'flat' }>['dims']): CrochetModelV1 => modelOf([part('flat', dims, { id: 'ear' })]);
    expect(problems(flat({ shape: 'circle', w: 1, h: 1, thickness: 0.2 }))).toEqual([]);
    expect(problems(flat({ shape: 'polygon', w: 1, h: 1, thickness: 0.2 }))).toEqual(['parts[0] (ear).dims.points: a flat part with shape "polygon" needs "points"']);
    expect(problems(flat({ shape: 'polygon', w: 1, h: 1, thickness: 0.2, points: [[0, 0], [1, 0]] }))).toEqual([
      'parts[0] (ear).dims.points: a polygon needs at least 3 points',
    ]);
    expect(problems(flat({ shape: 'polygon', w: 1, h: 1, thickness: 0.2, points: [[0, 0], [1, 0], [0, 1]] }))).toEqual([]);
    const many = Array.from({ length: 65 }, (_, i): [number, number] => [Math.cos(i), Math.sin(i)]);
    expect(problems(flat({ shape: 'polygon', w: 1, h: 1, thickness: 0.2, points: many }))).toEqual(['parts[0] (ear).dims.points: a polygon holds at most 64 points']);
    expect(problems(flat({ shape: 'hexagon' as 'rect', w: 1, h: 1, thickness: 0.2 }))[0]).toMatch(/dims\.shape: Invalid option/);
  });

  it('capsule: length is the total length, at least 2·r', () => {
    expect(problems(modelOf([part('capsule', { r: 0.5, length: 1 })]))).toEqual([]);
    expect(problems(modelOf([part('capsule', { r: 0.5, length: 0.99 })]))).toHaveLength(1);
  });

  it('dims: every linear dimension is within 0.05–48 in', () => {
    const cases: Part[] = [
      part('sphere', { r: 0.04 }),
      part('ellipsoid', { rx: 1, ry: 1, rz: 49 }),
      part('cylinder', { rTop: 0, rBottom: 1, h: 1 }),
      part('cone', { r: 1, h: 0 }),
      part('torus', { R: 100, r: 0.2 }),
      part('box', { w: 1, h: 1, d: -1 }),
      part('flat', { shape: 'rect', w: 1, h: 1, thickness: 0.01 }),
      part('mesh', { meshRef: 'm', bboxIn: [1, 0, 1] }),
      part('mesh', { meshRef: '', bboxIn: [1, 1, 1] }),
    ];
    for (const p of cases) expect(problems(modelOf([p])), JSON.stringify(p.dims)).toHaveLength(1);
    const edge: Part[] = [part('sphere', { r: 0.05 }), part('sphere', { r: 48 }), part('torus', { R: 1, r: 0.2, arcDeg: 360 })];
    for (const p of edge) expect(problems(modelOf([p]))).toEqual([]);
    expect(problems(modelOf([part('torus', { R: 1, r: 0.2, arcDeg: 0 })]))).toHaveLength(1);
    expect(problems(modelOf([part('torus', { R: 1, r: 0.2, arcDeg: 361 })]))).toHaveLength(1);
  });

  it('regions and features: fractions, angles, sizes and color references', () => {
    const withRegion = (region: unknown): CrochetModelV1 => modelOf([part('sphere', { r: 1 }, { id: 'body', regions: [region as never] })]);
    expect(problems(withRegion({ kind: 'band', from: 0.2, to: 0.8, color: 'c2' }))).toEqual([]);
    expect(problems(withRegion({ kind: 'band', from: 0.8, to: 0.2, color: 'c2' }))).toEqual([
      'parts[0] (body).regions[0].from: "from" (0.8) must not be above "to" (0.2)',
    ]);
    expect(problems(withRegion({ kind: 'band', from: -0.1, to: 0.2, color: 'c2' }))).toHaveLength(1);
    expect(problems(withRegion({ kind: 'band', from: 0, to: 1, color: 'c7' }))).toEqual(['parts[0] (body).regions[0].color: color "c7" is not in the palette']);
    expect(problems(withRegion({ kind: 'stripes', colors: ['c1', 'c2'], widthIn: 0.5 }))).toEqual([]);
    expect(problems(withRegion({ kind: 'stripes', colors: [], widthIn: 0.5 }))).toHaveLength(1);
    expect(problems(withRegion({ kind: 'stripes', colors: ['c1', 'c8'], widthIn: 0.5 }))).toEqual([
      'parts[0] (body).regions[0].colors[1]: color "c8" is not in the palette',
    ]);
    expect(problems(withRegion({ kind: 'stripes', colors: ['c1'], widthIn: 0 }))).toHaveLength(1);
    expect(problems(withRegion({ kind: 'patch', azimuthDeg: 0, spanDeg: 0, from: 0, to: 1, color: 'c1' }))).toHaveLength(1);
    expect(problems(withRegion({ kind: 'spot', azimuthDeg: 0, elevationDeg: 95, radiusIn: 0.2, color: 'c1' }))).toHaveLength(1);
    expect(problems(withRegion({ kind: 'pattern', pattern: 'leopard', colors: ['c1', 'c2'], coverage: 1.5 }))).toHaveLength(1);
    expect(problems(withRegion({ kind: 'pattern', pattern: 'leopard', colors: ['c1', 'c2'], scaleIn: 0.4, coverage: 0.5, from: 0, to: 1 }))).toEqual([]);

    const withFeature = (feature: unknown): CrochetModelV1 => modelOf([part('sphere', { r: 1 }, { id: 'head' })], { features: [feature as never] });
    expect(problems(withFeature({ id: 'eye_l', kind: 'safety_eye', on: 'head', azimuthDeg: 30, elevationDeg: -10, sizeMm: 9, color: 'c1', mirror: true }))).toEqual([]);
    expect(problems(withFeature({ id: 'eye_l', kind: 'safety_eye', on: 'head', azimuthDeg: 30, elevationDeg: -10, sizeMm: 0 }))).toHaveLength(1);
    expect(problems(withFeature({ id: 'eye_l', kind: 'safety_eye', on: 'head', azimuthDeg: 30, elevationDeg: -10, color: 'zz' }))).toEqual([
      'features[0] (eye_l).color: color "zz" is not in the palette',
    ]);
    expect(problems(withFeature({ id: 'm', kind: 'mouth', on: 'head', azimuthDeg: 0, elevationDeg: 0, path: [[0, 0], [10, 100]] }))).toHaveLength(1);
  });

  it('paint is base64 of exactly 64 × 64 bytes', () => {
    const withPaint = (data: string): CrochetModelV1 => modelOf([part('sphere', { r: 1 }, { paint: { kind: 'uv64', data } })]);
    expect(problems(withPaint(encodeUv64(new Uint8Array(4096).fill(255))))).toEqual([]);
    expect(problems(withPaint(encodeUv64(new Uint8Array(4096))))).toEqual([]);
    expect(problems(withPaint('AAAA'))).toEqual(['parts[0] (sphere).paint.data: paint.data must be base64 of exactly 64 × 64 bytes']);
    expect(problems(withPaint(`${'A'.repeat(5463)}!`))).toHaveLength(1);
  });

  it('header: version 1.x, revision ≥ 0, finishedSize 0 < h ≤ 60, enums', () => {
    expect(problems(changed((m) => (m.version = '1.7')))).toEqual([]);
    expect(problems(changed((m) => (m.version = '1')))).toHaveLength(1);
    expect(problems(changed((m) => (m.revision = -1)))).toHaveLength(1);
    expect(problems(changed((m) => (m.revision = 1.5)))).toHaveLength(1);
    expect(problems(changed((m) => (m.finishedSize.height = 0)))).toHaveLength(1);
    expect(problems(changed((m) => (m.finishedSize.height = 60)))).toEqual([]);
    expect(problems(changed((m) => (m.finishedSize.height = 60.01)))).toEqual(['finishedSize.height: finishedSize.height must be at most 60 in']);
    expect(problems(changed((m) => ((m as { category: string }).category = 'robot')))).toHaveLength(1);
    expect(problems(changed((m) => ((m.yarn as { weightCYC: number }).weightCYC = 8)))).toHaveLength(1);
    expect(problems(changed((m) => ((m.yarn as { weightCYC: number }).weightCYC = 0)))).toEqual([]);
    expect(problems(changed((m) => ((m.axes as { up: string }).up = '+Z')))).toHaveLength(1);
    expect(problems(changed((m) => (m.parts[2].flatten = 1.2)))).toHaveLength(1);
  });
});

describe('limits of §3.5.2', () => {
  const sphere = (id: string): Part => part('sphere', { r: 0.5 }, { id });

  it('parts ≤ 60, palette ≤ 16, regions per part ≤ 24, features ≤ 60', () => {
    const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `p${i}`);
    expect(problems(modelOf(ids(60).map(sphere)))).toEqual([]);
    expect(problems(modelOf(ids(61).map(sphere)))).toEqual(['parts: a model holds at most 60 parts']);

    const palette = (n: number): CrochetModelV1['palette'] => Array.from({ length: n }, (_, i) => ({ id: `k${i}`, hex: '#000000' }));
    expect(problems(modelOf([part('sphere', { r: 1 }, { color: 'k0' })], { palette: palette(16) }))).toEqual([]);
    expect(problems(modelOf([part('sphere', { r: 1 }, { color: 'k0' })], { palette: palette(17) }))).toEqual(['palette: the palette holds at most 16 colors']);

    const regions = (n: number): Part['regions'] => Array.from({ length: n }, () => ({ kind: 'band' as const, from: 0, to: 1, color: 'c1' }));
    expect(problems(modelOf([part('sphere', { r: 1 }, { regions: regions(24) })]))).toEqual([]);
    expect(problems(modelOf([part('sphere', { r: 1 }, { regions: regions(25) })]))).toEqual(['parts[0] (sphere).regions: a part holds at most 24 regions']);

    const features = (n: number): CrochetModelV1['features'] =>
      Array.from({ length: n }, (_, i) => ({ id: `f${i}`, kind: 'nose' as const, on: 'sphere', azimuthDeg: 0, elevationDeg: 0 }));
    expect(problems(modelOf([part('sphere', { r: 1 })], { features: features(60) }))).toEqual([]);
    expect(problems(modelOf([part('sphere', { r: 1 })], { features: features(61) }))).toEqual(['features: a model holds at most 60 features']);
    expect(MODEL_LIMITS).toMatchObject({ maxParts: 60, maxPalette: 16, maxRegionsPerPart: 24, maxFeatures: 60, minDimIn: 0.05, maxDimIn: 48 });
  });

  it('text fields ≤ 2 000 characters', () => {
    expect(problems(changed((m) => (m.description = 'a'.repeat(2000))))).toEqual([]);
    expect(problems(changed((m) => (m.description = 'a'.repeat(2001))))).toEqual(['description: text fields hold at most 2000 characters']);
    expect(problems(changed((m) => (m.parts[0].notes = 'a'.repeat(2001))))).toEqual(['parts[0] (body).notes: text fields hold at most 2000 characters']);
    expect(problems(changed((m) => (m.assumptions = ['a'.repeat(2001)])))).toEqual(['assumptions[0]: text fields hold at most 2000 characters']);
  });

  it('nesting depth ≤ 12, counted over the whole document including x-* values', () => {
    const nest = (levels: number): unknown => {
      let v: unknown = 1;
      for (let i = 0; i < levels; i++) v = [v];
      return v;
    };
    // model (1) → x-deep value: 11 more levels reach depth 12
    expect(problems({ ...example, 'x-deep': nest(11) })).toEqual([]);
    expect(problems({ ...example, 'x-deep': nest(12) })).toEqual([': the document nests deeper than 12 levels']);
    const cyclic: Record<string, unknown> = { ...example };
    cyclic['x-self'] = cyclic;
    expect(problems(cyclic)).toEqual([': the document nests deeper than 12 levels']);
  });

  it('whole document ≤ 2 MB', () => {
    const filler = Array.from({ length: 1100 }, () => 'a'.repeat(1900));
    expect(problems({ ...example, 'x-filler': filler })).toEqual([': the document is larger than 2 MB']);
    expect(problems({ ...example, 'x-filler': filler.slice(0, 1000) })).toEqual([]);
    // multi-byte text counts in bytes
    const wide = Array.from({ length: 400 }, () => '€'.repeat(1900));
    expect(problems({ ...example, 'x-filler': wide })).toEqual([': the document is larger than 2 MB']);
  });

  it('prototype keys are refused anywhere, and never reach an object prototype (§3.7.6 security)', () => {
    const hostile = JSON.parse(JSON.stringify(example).replace('"x-none":1', '')) as Record<string, unknown>;
    const withProto = JSON.parse(`${JSON.stringify(example).slice(0, -1)},"x-evil":{"__proto__":{"polluted":true}}}`) as unknown;
    expect(problems(withProto)).toEqual([': the key "__proto__" is not allowed in a model']);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
    Object.assign(hostile, { constructor: 1 });
    expect(problems(hostile)).toEqual([': the key "constructor" is not allowed in a model']);
    // a part object parsed on its own (no document pre-check) still cannot set a prototype
    const partWithProto = JSON.parse(`{"id":"a","type":"sphere","dims":{"r":1},"position":[0,0,0],"color":"c1","x-a":1,"__proto__":{"polluted":true}}`) as unknown;
    expect(partSchema.safeParse(partWithProto).success).toBe(false);
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
  });
});

describe('the leaf schemas', () => {
  it('regionSchema, featureSchema and paletteColorSchema are strict', () => {
    expect(regionSchema.parse({ kind: 'band', from: 0, to: 1, color: 'c1' })).toEqual({ kind: 'band', from: 0, to: 1, color: 'c1' });
    expect(regionSchema.safeParse({ kind: 'band', from: 0, to: 1, color: 'c1', widthIn: 1 }).success).toBe(false);
    expect(featureSchema.safeParse({ id: 'a', kind: 'nose', on: 'head', azimuthDeg: 0, elevationDeg: 0, extra: 1 }).success).toBe(false);
    expect(paletteColorSchema.parse({ id: 'c1', hex: '#aBc123' })).toEqual({ id: 'c1', hex: '#aBc123' });
    expect(paletteColorSchema.safeParse({ id: 'C1', hex: '#aBc123' }).success).toBe(false);
    expect(paletteColorSchema.safeParse({ id: 'c1', hex: '#abc' }).success).toBe(false);
    expect(paletteColorSchema.safeParse({ id: 'a_palette_id_of_17', hex: '#000000' }).success).toBe(false);
  });
});

describe('canonical writing', () => {
  it('canonicalizeModel orders keys as §3.5.1 without changing values', () => {
    const shuffled = {
      parts: example.parts.map((p) => Object.fromEntries(Object.entries(p).reverse())),
      'x-b': 2,
      palette: example.palette.map((c) => Object.fromEntries(Object.entries(c).reverse())),
      name: example.name,
      ...Object.fromEntries(Object.entries(example).filter(([k]) => !['parts', 'palette', 'name'].includes(k)).reverse()),
      'x-a': 1,
    } as unknown as CrochetModelV1;
    const ordered = canonicalizeModel(shuffled);
    expect(ordered).toEqual(shuffled);
    expect(Object.keys(ordered).slice(0, 6)).toEqual(['schema', 'version', 'revision', 'units', 'axes', 'name']);
    expect(Object.keys(ordered).slice(-3)).toEqual(['source', 'x-a', 'x-b']);
    expect(Object.keys(ordered.parts[3])).toEqual(['id', 'label', 'type', 'dims', 'position', 'rotationDeg', 'color', 'regions', 'attach', 'mirrorOf', 'stuffing', 'flatten']);
    expect(Object.keys(ordered.palette[0])).toEqual(['id', 'hex', 'name', 'role']);
    expect(stringifyModel(shuffled)).toBe(stringifyModel({ ...example, 'x-a': 1, 'x-b': 2 }));
  });

  it('stringifyModel writes parseable JSON: 2-space indent, plain arrays on one line, final newline', () => {
    const text = stringifyModel(everyType);
    expect(JSON.parse(text)).toEqual(everyType);
    expect(text.endsWith('}\n')).toBe(true);
    expect(text).toMatch(/\n {6}"position": \[0, 1\.111352, 0\],\n/);
    expect(text).toContain('\n          [1.45, 0.66],\n');
    expect(text).toContain('"regions": [\n        {\n          "kind": "band",');
    expect(stringifyModel(JSON.parse(text) as CrochetModelV1)).toBe(text);
    expect(stringifyModel(modelOf([part('sphere', { r: 1 })], { assumptions: [], features: [] }))).toContain('"features": [],\n  "assumptions": []');
  });

  it('the fixture files are in canonical form', () => {
    expect(readFileSync(CANONICAL_TEDDY_URL, 'utf8')).toBe(stringifyModel(teddy));
  });
});
