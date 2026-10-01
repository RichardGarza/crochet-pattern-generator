// §3.7.6 repairs (units, radians, colors, cycles, unknown keys, ids, dims, features, mirrors, limits), the §3.5.2
// alias table and the canonical-1 path. Inputs are made from the canonical teddy so every result can be compared
// with it.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ImportResult } from '../../../types/importer';
import type { CrochetModelV1, Part } from '../../../types/model';
import { deltaE00Hex } from '../../kernel/color';
import { attachRoot, isOneTree } from '../../model/attach';
import { stringifyModel } from '../../model/schema';
import { modelHeight } from '../../model/transforms';
import { importInputs } from '../index';
import { normalizeSpec, rotationsLookLikeRadians } from '../dialect';
import { partSlug, rightTwinId } from '../repair';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { CANONICAL_TEDDY, fileInput } from './helpers/fixtures';

type Spec = Record<string, unknown> & { parts: Record<string, unknown>[]; palette: Record<string, unknown>[] };
const teddy = (): Spec => JSON.parse(CANONICAL_TEDDY) as Spec;
const run = (spec: unknown): Promise<ImportResult> => importInputs([{ kind: 'text', text: JSON.stringify(spec) }]);
const byId = (m: CrochetModelV1 | undefined): Record<string, Part> => Object.fromEntries((m?.parts ?? []).map((p) => [p.id, p]));
const codes = (r: ImportResult): string[] => r.repairs.map((x) => x.code);

/** Every length of a canonical spec (positions, dims, finishedSize) times k. */
function scaled(spec: Spec, k: number, withHeight = false): Spec {
  const out = structuredClone(spec);
  for (const p of out.parts) {
    p.position = (p.position as number[]).map((v) => v * k);
    const dims = p.dims as Record<string, number>;
    for (const key of Object.keys(dims)) dims[key] *= k;
  }
  if (withHeight) (out.finishedSize as Record<string, number>).height *= k;
  return out;
}

/** Same numbers as the canonical teddy within `tol` (positions, rotations, dims), same ids, colors and tree. */
function expectTeddy(r: ImportResult, tol: number): void {
  expect(r.ok).toBe(true);
  const want = byId(JSON.parse(CANONICAL_TEDDY) as CrochetModelV1);
  const got = byId(r.model);
  expect(Object.keys(got)).toEqual(Object.keys(want));
  for (const [id, w] of Object.entries(want)) {
    const g = got[id];
    expect(g.type).toBe(w.type);
    expect(g.color).toBe(w.color);
    expect(g.attach?.to).toBe(w.attach?.to);
    expect(g.mirrorOf).toBe(w.mirrorOf);
    g.position.forEach((v, i) => expect(Math.abs(v - w.position[i]), `${id}.position[${i}]`).toBeLessThanOrEqual(tol));
    (g.rotationDeg ?? [0, 0, 0]).forEach((v, i) => expect(Math.abs(v - (w.rotationDeg ?? [0, 0, 0])[i]), `${id}.rotationDeg[${i}]`).toBeLessThanOrEqual(tol));
    for (const [k, v] of Object.entries(w.dims)) expect(Math.abs((g.dims as Record<string, number>)[k] - (v as number)), `${id}.dims.${k}`).toBeLessThanOrEqual(tol);
  }
}

describe('canonical-1', HEAVY, () => {
  it('the canonical teddy imports as itself (idempotent): only the "kept as it is" units chip', async () => {
    const r = await importInputs([fileInput('teddy.canonical.json', CANONICAL_TEDDY)]);
    expect(r.ok).toBe(true);
    expect(r.dialect).toBe('canonical-1');
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
    expect(codes(r)).toEqual(['units']);
  });

  it('the §3.6 example of DESIGN.md imports with its ids, tree and colors', async () => {
    const design = readFileSync(new URL('../../../../docs/DESIGN.md', import.meta.url), 'utf8');
    const section = design.slice(design.indexOf('### 3.6 Complete example'));
    const json = section.slice(section.indexOf('```json') + 7, section.indexOf('```', section.indexOf('```json') + 7));
    const bunny = JSON.parse(json) as CrochetModelV1;
    const r = await run(bunny);
    expect(r.ok).toBe(true);
    expect(r.dialect).toBe('canonical-1');
    expect(r.model?.parts.map((p) => p.id)).toEqual(bunny.parts.map((p) => p.id));
    expect(r.model?.parts.map((p) => p.color)).toEqual(bunny.parts.map((p) => p.color));
    expect(r.model?.features).toEqual(bunny.features);
    expect(isOneTree(r.model as CrochetModelV1)).toBe(true);
    expect(r.model?.source).toEqual(bunny.source);
    expect(r.repairs.filter((x) => x.code !== 'units' && x.code !== 'ground' && x.code !== 'attach-inferred')).toEqual([]);
  });

  it('x-cpg is kept and returned as cpgTag; x-* keys on parts are kept', async () => {
    const spec = teddy();
    spec['x-cpg'] = { project: 'p-123', seedRev: 4 };
    spec.parts[0]['x-note'] = { any: ['thing'] };
    const r = await run(spec);
    expect(r.cpgTag).toEqual({ project: 'p-123', seedRev: 4 });
    expect((r.model as unknown as Record<string, unknown>)['x-cpg']).toEqual({ project: 'p-123', seedRev: 4 });
    expect(((r.model as CrochetModelV1).parts[0] as unknown as Record<string, unknown>)['x-note']).toEqual({ any: ['thing'] });
  });

  it('a spec of another major version is refused', async () => {
    const r = await run({ ...teddy(), version: '2.0' });
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('E_IMPORT_UNSUPPORTED');
  });
});

describe('units (§3.7.6)', HEAVY, () => {
  it.each<[string, number, string]>([
    ['cm', 2.54, 'read as cm'],
    ['m', 0.0254, 'read as meters'],
    ['mm', 25.4, 'read as mm'],
  ])('geometry in %s against a height in inches is rescaled', async (_unit, k, message) => {
    const r = await run(scaled(teddy(), k));
    expectTeddy(r, 2e-5);
    const units = r.repairs.find((x) => x.code === 'units');
    expect(units?.message).toContain(message);
    expect(r.model?.finishedSize.height).toBeCloseTo(9.878905, 4);
  });

  it('a height off by more than 15% (not a unit) is scaled to the stated height', async () => {
    const r = await run(scaled(teddy(), 1.6));
    expectTeddy(r, 2e-5);
    expect(r.repairs.find((x) => x.code === 'units')?.message).toContain('scaled to 9.878905 in');
  });

  it('within 15%: kept, and the measured height recorded', async () => {
    const r = await run({ ...teddy(), finishedSize: { height: 11 } });
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
    expect(r.repairs.find((x) => x.code === 'units')?.message).toBe('the model measures 9.88 in tall (it says 11 in): kept as it is');
  });

  it('a spec that says "units": "cm" is converted to inches', async () => {
    const spec = scaled(teddy(), 2.54, true);
    spec.units = 'cm';
    const r = await run(spec);
    expectTeddy(r, 2e-5);
    expect(r.repairs.find((x) => x.code === 'units')?.message).toBe('the spec says its lengths are in cm: converted to inches');
  });

  it('no stated height: the measured one is recorded', async () => {
    const spec = teddy();
    delete spec.finishedSize;
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(r.model?.finishedSize.height).toBe(9.878905);
    expect(r.repairs.find((x) => x.code === 'units')?.message).toMatch(/no usable finished height was given/);
  });
});

describe('radians (§3.7.6)', HEAVY, () => {
  it('detection: all within ±6.3 and a non-integer near k·π/12', () => {
    expect(rotationsLookLikeRadians([[0, 0, Math.PI / 6]])).toBe(true);
    expect(rotationsLookLikeRadians([[-Math.PI / 4, 0, 0.3]])).toBe(true);
    expect(rotationsLookLikeRadians([[0, 0, 5]])).toBe(false);
    expect(rotationsLookLikeRadians([[0, 0, 0.5]])).toBe(false);
    expect(rotationsLookLikeRadians([[0, 0, Math.PI / 6], [0, 0, 30]])).toBe(false);
    expect(rotationsLookLikeRadians([])).toBe(false);
  });

  it('rotations in radians are converted to degrees (with a warning chip)', async () => {
    const spec = teddy();
    for (const p of spec.parts) if (p.id === 'arm_l' || p.id === 'arm_r') p.rotationDeg = [0, 0, (p.id === 'arm_l' ? 1 : -1) * (Math.PI / 6)];
    for (const p of spec.parts) if (p.id === 'leg_l' || p.id === 'leg_r') p.rotationDeg = [Math.PI / 2, 0, 0];
    for (const p of spec.parts) if (String(p.id).startsWith('foot_pad')) p.rotationDeg = [Math.PI / 2, 0, 0];
    for (const p of spec.parts) if (String(p.id).startsWith('ear')) p.rotationDeg = [0, 0, 0];
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(byId(r.model).arm_l.rotationDeg).toEqual([0, 0, 30]);
    expect(byId(r.model).leg_r.rotationDeg).toEqual([90, 0, 0]);
    expect(codes(r)).toContain('radians');
  });

  it('the dialect converts before composing parent rotations', () => {
    const n = normalizeSpec({
      palette: { '#ff0000': 'red' },
      parts: [
        { id: 'a', type: 'sphere', dimensions: { r: 1 }, position: [0, 0, 0], rotationDeg: [0, 0, Math.PI / 2], color: '#ff0000', parent: null },
        { id: 'b', type: 'sphere', dimensions: { r: 0.5 }, position: [1, 0, 0], rotationDeg: [0, 0, 0], color: '#ff0000', parent: 'a' },
      ],
    });
    const b = n.model.parts[1];
    expect(b.position[0]).toBeCloseTo(0, 9);
    expect(b.position[1]).toBeCloseTo(1, 9);
    expect(b.rotationDeg?.[2]).toBeCloseTo(90, 9);
  });
});

describe('colors (§3.7.6)', HEAVY, () => {
  it('unknown palette id → the main color; a color name → the nearest palette color by ΔE00; a new hex → added; a palette name → its id', async () => {
    const spec = teddy();
    const set = (id: string, color: string): void => {
      const p = spec.parts.find((q) => q.id === id) as Record<string, unknown>;
      p.color = color;
    };
    set('tail', 'c9');
    set('muzzle', 'Cream Yarn');
    set('nose', 'brown');
    set('body', '#123456');
    const r = await run(spec);
    expect(r.ok).toBe(true);
    const p = byId(r.model);
    expect(p.tail.color).toBe('caramel_yarn');
    expect(p.muzzle.color).toBe('cream_yarn');
    const palette = (JSON.parse(CANONICAL_TEDDY) as CrochetModelV1).palette;
    const nearest = [...palette].sort((a, b) => deltaE00Hex('#8b4513', a.hex) - deltaE00Hex('#8b4513', b.hex))[0].id;
    expect(p.nose.color).toBe(nearest);
    expect(p.body.color).toBe('c_123456');
    expect(r.model?.palette.at(-1)).toEqual({ id: 'c_123456', hex: '#123456' });
    expect(r.repairs.filter((x) => x.code === 'color').map((x) => x.part).sort()).toEqual(['body', 'muzzle', 'nose', 'tail']);
  });

  it('region and feature colors are resolved the same way; palette ids are slugged', async () => {
    const spec = teddy();
    spec.palette[0].id = 'Caramel Yarn!';
    for (const p of spec.parts) if (p.color === 'caramel_yarn') p.color = 'Caramel Yarn!';
    spec.parts[0].regions = [{ kind: 'band', from: 0.2, to: 0.4, color: '#F2E3C6' }];
    spec.features = [{ id: 'mouth', kind: 'mouth', on: 'muzzle', azimuthDeg: 0, elevationDeg: -20, color: 'black' }];
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(r.model?.palette[0].id).toBe('caramel_yarn');
    expect(byId(r.model).body.color).toBe('caramel_yarn');
    expect(byId(r.model).body.regions).toEqual([{ kind: 'band', from: 0.2, to: 0.4, color: 'cream_yarn' }]);
    expect(r.model?.features?.[0].color).toBe('black_safety_eye');
  });

  it('more than 16 colors: unused ones dropped, then the least used merged into their nearest', async () => {
    const spec = teddy();
    for (let i = 0; i < 20; i++) spec.palette.push({ id: `extra${i}`, hex: `#${(0x102030 + i * 0x0a0a0a).toString(16)}` });
    spec.parts.forEach((p, i) => {
      if (i < 15) p.color = `extra${i}`;
    });
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(r.model?.palette.length).toBe(16);
    expect(codes(r).filter((c) => c === 'limits').length).toBeGreaterThan(0);
    const ids = new Set(r.model?.palette.map((c) => c.id));
    for (const p of r.model?.parts ?? []) expect(ids.has(p.color)).toBe(true);
  });
});

describe('attach validity (§3.7.6)', HEAVY, () => {
  it('a cycle is removed and the parts re-linked into one tree', async () => {
    const spec = teddy();
    (spec.parts.find((p) => p.id === 'head') as Record<string, unknown>).attach = { to: 'nose', method: 'sewn' };
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(isOneTree(r.model as CrochetModelV1)).toBe(true);
    expect(attachRoot(r.model as CrochetModelV1)?.id).toBe('body');
    expect(byId(r.model).head.attach?.to).toBe('body');
    expect(r.repairs.find((x) => x.code === 'attach-inferred' && x.part === 'head')?.message).toMatch(/it was attached to "nose" in a cycle/);
  });

  it('a dangling or self link is removed and re-inferred', async () => {
    const spec = teddy();
    (spec.parts.find((p) => p.id === 'tail') as Record<string, unknown>).attach = { to: 'nobody' };
    (spec.parts.find((p) => p.id === 'ear_l') as Record<string, unknown>).attach = { to: 'ear_l' };
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(byId(r.model).tail.attach?.to).toBe('body');
    expect(byId(r.model).ear_l.attach?.to).toBe('head');
  });

  it('the dialect: a parent loop or a missing parent reads the position as absolute', () => {
    const n = normalizeSpec({
      palette: { '#ff0000': 'red' },
      parts: [
        { id: 'a', type: 'sphere', dimensions: { r: 1 }, position: [0, 1, 0], color: '#ff0000', parent: 'b' },
        { id: 'b', type: 'sphere', dimensions: { r: 1 }, position: [0, 1, 0], color: '#ff0000', parent: 'a' },
        { id: 'c', type: 'sphere', dimensions: { r: 1 }, position: [5, 1, 0], color: '#ff0000', parent: 'zzz' },
      ],
    });
    expect(n.model.parts.map((p) => p.position)).toEqual([[0, 2, 0], [0, 1, 0], [5, 1, 0]]);
    expect(n.model.parts.map((p) => p.attach?.to)).toEqual(['b', undefined, undefined]);
    expect(n.warnings.length).toBe(2);
  });

  it('a gap of more than 0.1 in to the parent raises W_GAP', async () => {
    const spec = teddy();
    const tail = spec.parts.find((p) => p.id === 'tail') as Record<string, unknown>;
    tail.position = [0, 1.4, -2.6];
    tail.attach = { to: 'body', method: 'sewn' };
    const r = await run(spec);
    expect(r.warnings.find((w) => w.code === 'W_GAP')?.where).toEqual({ part: 'tail' });
  });
});

describe('unknown keys and ids (§3.7.6)', HEAVY, () => {
  it('unknown keys are stripped with one chip each, at every level; x-* kept where the schema allows', async () => {
    const spec = teddy();
    spec.generator = 'Claude';
    spec.comment = 'made for Sam';
    spec.parts[0].material = 'yarn';
    (spec.parts[0].dims as Record<string, unknown>).segments = 64;
    (spec.parts[0].dims as Record<string, unknown>)['x-inner'] = 1;
    spec.parts[0].regions = [{ kind: 'band', from: 0, to: 0.5, color: 'cream_yarn', opacity: 1 }, { kind: 'glitter', color: 'cream_yarn' }];
    spec.features = [{ id: 'mouth', kind: 'mouth', on: 'muzzle', azimuthDeg: 0, elevationDeg: -20, thickness: 2 }];
    const r = await run(spec);
    expect(r.ok).toBe(true);
    const keys = r.repairs.filter((x) => x.code === 'unknown-key').map((x) => x.message);
    expect(keys).toEqual([
      'unknown key "segments" in the dims of body removed',
      'unknown key "x-inner" in the dims of body removed',
      'unknown key "material" of body removed',
      'unknown key "generator" removed',
      'unknown key "comment" removed (its text is kept in "assumptions")',
      'unknown key "opacity" in a band region of body removed',
      'body: a color region of unknown kind "glitter" removed',
      'unknown key "thickness" in feature mouth removed',
    ]);
    expect(r.model?.assumptions).toEqual([...(teddy().assumptions as string[]), 'made for Sam']);
  });

  it('ids: slugged, deduped, filled; references follow the rename', async () => {
    const spec = teddy();
    const head = spec.parts.find((p) => p.id === 'head') as Record<string, unknown>;
    head.id = 'Head Piece';
    for (const p of spec.parts) if ((p.attach as Record<string, unknown> | undefined)?.to === 'head') (p.attach as Record<string, unknown>).to = 'Head Piece';
    (spec.parts.find((p) => p.id === 'tail') as Record<string, unknown>).id = 'body';
    delete (spec.parts.find((p) => p.id === 'nose') as Record<string, unknown>).id;
    spec.features = [{ id: 'Eye-L', kind: 'safety_eye', on: 'Head Piece', azimuthDeg: 20, elevationDeg: 5 }];
    const r = await run(spec);
    expect(r.ok).toBe(true);
    const p = byId(r.model);
    expect(p.head_piece.attach?.to).toBe('body');
    expect(p.muzzle.attach?.to).toBe('head_piece');
    expect(p.body_2.label).toBe('Tail');
    expect(p.nose.label).toBe('Nose');
    expect(r.model?.features?.[0]).toMatchObject({ id: 'eye_l', on: 'head_piece' });
    expect(r.repairs.filter((x) => x.code === 'id').length).toBe(4);
  });

  it('partSlug and rightTwinId', () => {
    expect(partSlug('Left Ear (inner)')).toBe('left_ear_inner');
    expect(partSlug('3rd leg')).toBe('p_3rd_leg');
    expect(partSlug('x'.repeat(40))).toHaveLength(32);
    expect(rightTwinId('ear_l_inner')).toBe('ear_r_inner');
    expect(rightTwinId('wing_left')).toBe('wing_right');
    expect(rightTwinId('body')).toBeNull();
  });

  it('a *_l that says it is one of a pair gets its *_r', async () => {
    const spec = teddy();
    spec.parts = spec.parts.filter((p) => p.id !== 'arm_r');
    (spec.parts.find((p) => p.id === 'arm_l') as Record<string, unknown>).notes = 'make two (mirror for the other side)';
    const r = await run(spec);
    expect(r.ok).toBe(true);
    const armR = byId(r.model).arm_r;
    expect(armR).toMatchObject({ mirrorOf: 'arm_l', label: 'Right Arm', position: [-2, 3.578905, 0.55], rotationDeg: [-28, 0, -22] });
    expect(r.repairs.find((x) => x.part === 'arm_r' && x.code === 'part-added')?.data).toEqual({ mirrorOf: 'arm_l' });
  });
});

describe('dims, features and mirrors (§3.7.6)', HEAVY, () => {
  it('dims are clamped to 0.05–48 in; a capsule shorter than its caps is read as its straight section', async () => {
    const spec = teddy();
    (spec.parts.find((p) => p.id === 'eye_l') as Record<string, unknown>).dims = { r: 0.01 };
    (spec.parts.find((p) => p.id === 'arm_l') as Record<string, unknown>).dims = { r: 0.55, length: 0.8 };
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(byId(r.model).eye_l.dims).toEqual({ r: 0.05 });
    expect(byId(r.model).arm_l.dims).toEqual({ r: 0.55, length: 1.9 });
    expect(r.repairs.filter((x) => x.code === 'dims-clamped').map((x) => x.part).sort()).toEqual(['arm_l', 'eye_l']);
  });

  it('features on a missing part are dropped; angles brought into range', async () => {
    const spec = teddy();
    spec.features = [
      { id: 'mouth', kind: 'mouth', on: 'muzzle', azimuthDeg: 370, elevationDeg: -120 },
      { id: 'tag', kind: 'line', on: 'nowhere', azimuthDeg: 0, elevationDeg: 0 },
      { id: 'blush', kind: 'blush', on: 'head', azimuthDeg: 40, elevationDeg: -10 },
      { id: 'sparkle', kind: 'sparkle', on: 'head', azimuthDeg: 0, elevationDeg: 0 },
    ];
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(r.model?.features).toEqual([
      { id: 'mouth', kind: 'mouth', on: 'muzzle', azimuthDeg: 10, elevationDeg: -90 },
      { id: 'blush', kind: 'cheek', on: 'head', azimuthDeg: 40, elevationDeg: -10 },
    ]);
    expect(codes(r).filter((c) => c === 'feature-dropped').length).toBe(2);
  });

  it('a broken mirrorOf is removed (and re-inferred when the twins match)', async () => {
    const spec = teddy();
    (spec.parts.find((p) => p.id === 'eye_r') as Record<string, unknown>).mirrorOf = 'muzzle';
    (spec.parts.find((p) => p.id === 'tail') as Record<string, unknown>).mirrorOf = 'ghost';
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(byId(r.model).eye_r.mirrorOf).toBe('eye_l');
    expect(byId(r.model).tail.mirrorOf).toBeUndefined();
    // both broken links get a `mirror-removed` chip; eye_r's real twin is then found again (`mirror-inferred`)
    expect(r.repairs.filter((x) => x.code === 'mirror-removed').map((x) => [x.part, x.data])).toEqual([
      ['eye_r', { mirrorOf: 'muzzle' }],
      ['tail', { mirrorOf: 'ghost' }],
    ]);
    expect(r.repairs.some((x) => x.code === 'mirror-inferred' && x.part === 'eye_r')).toBe(true);
  });

  it('limits: more than 60 parts keeps 60; long text is cut', async () => {
    const spec = teddy();
    for (let i = 0; i < 50; i++) spec.parts.push({ id: `bead_${i}`, type: 'sphere', dims: { r: 0.2 }, position: [0, 2.6 + i * 0.01, 1.9], color: 'cream_yarn' });
    spec.description = 'x'.repeat(2500);
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(r.model?.parts.length).toBe(60);
    expect(r.model?.description?.length).toBe(2000);
    expect(r.repairs.filter((x) => x.code === 'limits').map((x) => x.message)).toEqual([
      '67 parts: only the first 60 were kept',
      "the model's description was cut to 2000 characters",
    ]);
  });
});

describe('aliases and odd shapes (§3.5.2)', HEAVY, () => {
  const one = (part: Record<string, unknown>): Spec => ({
    schema: 'crochet-model',
    version: '1.0',
    palette: [{ id: 'c1', hex: '#ff0000' }],
    finishedSize: { height: 2 },
    parts: [{ id: 'base', type: 'sphere', dims: { r: 1 }, position: [0, 1, 0], color: 'c1' }, { id: 'thing', position: [0, 1.5, 0], color: 'c1', ...part }],
  });
  it.each<[string, Record<string, unknown>, string, Record<string, unknown>]>([
    ['egg', { type: 'egg', dims: { r: 0.5, h: 1.4 } }, 'ellipsoid', { rx: 0.5, ry: 0.7, rz: 0.5 }],
    ['ball', { type: 'Ball', dims: { radius: 0.4 } }, 'sphere', { r: 0.4 }],
    ['pill', { type: 'pill', dims: { radius: 0.2, height: 1 } }, 'capsule', { r: 0.2, length: 1 }],
    ['tube', { type: 'tube', dims: { radius: 0.3, height: 1 } }, 'cylinder', { rTop: 0.3, rBottom: 0.3, h: 1 }],
    ['disc', { type: 'disc', dims: { radius: 0.6, thickness: 0.2 } }, 'cylinder', { rTop: 0.6, rBottom: 0.6, h: 0.2 }],
    ['donut (three.js names)', { type: 'TorusGeometry', dims: { radius: 0.6, tube: 0.15, arc: Math.PI } }, 'torus', { R: 0.6, r: 0.15, arcDeg: 180 }],
    ['leaf', { type: 'leaf', dims: { width: 0.6, height: 1, thickness: 0.1 } }, 'flat', { shape: 'teardrop', w: 0.6, h: 1, thickness: 0.1 }],
    ['cube', { type: 'cube', dims: { width: 1, height: 0.5, depth: 0.4 } }, 'box', { w: 1, h: 0.5, d: 0.4 }],
    ['cylinder radius', { type: 'cylinder', dims: { radius: 0.3, height: 1, openEnded: true } }, 'cylinder', { rTop: 0.3, rBottom: 0.3, h: 1, open: 'both' }],
  ])('%s', async (_label, part, type, dims) => {
    const r = await run(one(part));
    expect(r.ok).toBe(true);
    expect(byId(r.model).thing).toMatchObject({ type, dims });
  });

  it('dome → a lathe whose base is below the given center', async () => {
    const r = await run(one({ type: 'dome', dims: { radius: 0.5, height: 0.6 }, position: [0, 2, 0] }));
    const t = byId(r.model).thing;
    expect(t.type).toBe('lathe');
    expect(t.type === 'lathe' && t.dims.profile.at(-1)).toEqual([0, 0.6]);
    expect(t.position[1]).toBeCloseTo(2 - 0.3 + (r.repairs.find((x) => x.code === 'ground')?.data?.dy as number | undefined ?? 0), 5);
  });

  it('an unknown type becomes its bounding ellipsoid with a warning', async () => {
    const r = await run(one({ type: 'blob', dims: { w: 1, h: 0.8, d: 0.6 } }));
    expect(byId(r.model).thing).toMatchObject({ type: 'ellipsoid', dims: { rx: 0.5, ry: 0.4, rz: 0.3 } });
    expect(r.warnings.find((w) => w.code === 'W_IMPORT_TYPE')?.message).toMatch(/blob/);
    expect(r.repairs.find((x) => x.code === 'type-aliased')).toMatchObject({ part: 'thing', data: { from: 'blob', to: 'ellipsoid' } });
  });

  it('a Z-up spec is turned upright; a flat-based model lying on its back is only offered the turn', async () => {
    const zUp: Spec = {
      ...one({ type: 'capsule', dims: { r: 0.3, length: 3 }, position: [0, 0, 2], rotationDeg: [90, 0, 0] }),
      axes: { up: '+Z', front: '-Y' },
    };
    delete zUp.finishedSize;
    const r = await run(zUp);
    expect(r.ok).toBe(true);
    expect(codes(r)).toContain('axes');
    // the capsule stood along +Z: now it stands along +Y, 1 in above the sphere's center as before
    const t = byId(r.model).thing;
    (t.rotationDeg ?? [0, 0, 0]).forEach((v) => expect(Math.abs(v)).toBeLessThan(1e-9));
    expect(t.position[1] - byId(r.model).base.position[1]).toBeCloseTo(2, 9);
    expect(modelHeight(r.model as CrochetModelV1)).toBeCloseTo(4.5, 5);
    const lying = one({ type: 'capsule', dims: { r: 0.3, length: 4 }, position: [0, 0.3, 0], rotationDeg: [90, 0, 0] });
    lying.flatBase = true;
    const offer = await run(lying);
    const axes = offer.repairs.find((x) => x.code === 'axes');
    expect(axes?.data).toEqual({ offer: true, rotationDeg: [-90, 0, 0] });
    expect(byId(offer.model).thing.rotationDeg).toEqual([90, 0, 0]);
  });
});
