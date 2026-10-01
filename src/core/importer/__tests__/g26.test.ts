// G12 on the geometry carriers and G26 (DESIGN.md §2.13, §3.7.5, §3.7.7, §6.3 T7): the captured teddy GLB (node
// names + extras + decomposed matrices + linear → sRGB colors) gives teddy.canonical.json; the derived fixtures of
// scripts/make-cd-fixtures.mjs — the stale side file, builder-v1 GLB with root extras, GLB with per-node extras
// only, OBJ + MTL in meters — give the same 17 parts with a bbox within 2%; the observed teddy OBJ stays inches and
// imports in under 3 s; STL in millimeters, PLY in meters and the handoff bundles round it off.
import { gunzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { budget, PERF } from '../../../test/timing';
import type { ImportContext, ImportInput, ImportResult } from '../../../types/importer';
import type { CrochetModelV1, Part } from '../../../types/model';
import { parseHex } from '../../kernel/color';
import { attachRoot, isOneTree } from '../../model/attach';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { modelBounds } from '../../model/transforms';
import { fitPart } from '../../recon/fit';
import { isImplemented } from '../../stub';
import { importInputs, importInputsSync } from '../index';
import { CANONICAL_TEDDY, derivedInput, fileInput, fixtureInput, readDerived, readFixture } from './helpers/fixtures';

const CANON = JSON.parse(CANONICAL_TEDDY) as CrochetModelV1;
const IDS = CANON.parts.map((p) => p.id);
const byId = (m: CrochetModelV1): Record<string, Part> => Object.fromEntries(m.parts.map((p) => [p.id, p]));
const hexOf = (m: CrochetModelV1, id: string): string => m.palette.find((c) => c.id === id)?.hex ?? '?';
const gunzipInput = (name: string, bytes: Uint8Array): ImportInput => fileInput(name, gunzipSync(bytes));

/** §3.7.7: ids, types, dims ±1e-6, absolute transforms ±1e-4, colors ±1/255, attach tree and mirror pairs. */
function expectCanonicalParts(m: CrochetModelV1): void {
  expect(m.parts.map((p) => p.id).sort()).toEqual([...IDS].sort());
  const got = byId(m);
  for (const want of CANON.parts) {
    const p = got[want.id];
    expect(p.type, want.id).toBe(want.type);
    for (const [k, v] of Object.entries(want.dims)) expect((p.dims as Record<string, number>)[k], `${want.id}.dims.${k}`).toBeCloseTo(v as number, 6);
    for (let i = 0; i < 3; i++) {
      expect(Math.abs(p.position[i] - want.position[i]), `${want.id}.position[${i}]`).toBeLessThanOrEqual(1e-4);
      expect(Math.abs((p.rotationDeg ?? [0, 0, 0])[i] - (want.rotationDeg ?? [0, 0, 0])[i]), `${want.id}.rotationDeg[${i}]`).toBeLessThanOrEqual(1e-4);
    }
    const a = parseHex(hexOf(m, p.color));
    const b = parseHex(hexOf(CANON, want.color));
    for (let i = 0; i < 3; i++) expect(Math.abs(a[i] - b[i]), `${want.id} color`).toBeLessThanOrEqual(1);
    expect(p.attach?.to, `${want.id}.attach`).toBe(want.attach?.to);
    expect(p.mirrorOf, `${want.id}.mirrorOf`).toBe(want.mirrorOf);
  }
  expect(isOneTree(m)).toBe(true);
  expect(attachRoot(m)?.id).toBe('body');
}

/** "bbox within 2%" per axis, against the canonical teddy. */
function expectBboxWithin2(m: CrochetModelV1): void {
  const a = modelBounds(m);
  const b = modelBounds(CANON);
  for (let k = 0; k < 3; k++) {
    const want = b.max[k] - b.min[k];
    expect(Math.abs(a.max[k] - a.min[k] - want) / want, `axis ${k}`).toBeLessThanOrEqual(0.02);
  }
}

/** The canonical tree by part id (the attach tree inferred by proximity must match it). */
function expectCanonicalTree(m: CrochetModelV1): void {
  const got = byId(m);
  for (const want of CANON.parts) expect(got[want.id]?.attach?.to, want.id).toBe(want.attach?.to);
  for (const want of CANON.parts) expect(got[want.id]?.mirrorOf, want.id).toBe(want.mirrorOf);
}

async function run(inputs: ImportInput[], ctx?: ImportContext): Promise<ImportResult> {
  const r = await importInputs(inputs, ctx);
  expect(r.warnings.filter((w) => w.severity === 'error')).toEqual([]);
  expect(r.ok).toBe(true);
  return r;
}

describe('G12: the captured teddy GLB (ladder step 3)', HEAVY, () => {
  it('node names + extras + decomposed matrices + linear → sRGB colors give the canonical teddy', async () => {
    const r = await run([fixtureInput('amigurumi-teddy-bear.glb')]);
    expect(r).toMatchObject({ carrier: 'glb', dialect: 'cd-observed-2026-09', confidence: 'medium' });
    const m = r.model as CrochetModelV1;
    expectCanonicalParts(m);
    // the palette as the chat printed it: same ids, same hex (exactly: the float colors round-trip)
    expect(m.palette).toEqual(CANON.palette);
    expect(m.finishedSize.height).toBeCloseTo(CANON.finishedSize.height, 6);
    expect(byId(m).eye_l.crochet).toEqual({ make: 'safety_eye' });
    // scene units measured exactly: 1 scene unit per inch
    expect(r.units).toMatchObject({ chosen: 'in', reason: 'gltf-extras-ratio', confirm: false });
    expect(r.units?.rawHeight).toBeCloseTo(9.8789, 3);
    expect(r.repairs.filter((x) => x.code === 'units')).toHaveLength(1);
    expect(r.repairs.filter((x) => x.code === 'attach-inferred')).toHaveLength(6);
    expect(r.repairs.filter((x) => x.code === 'mirror-inferred')).toHaveLength(6);
  });
});

describe('G26: the stale side file (§3.7.2)', HEAVY, () => {
  it('imports revision 1 (ears unchanged) with the versions chip; both entries are candidates', async () => {
    const r = await run([derivedInput('teddy-stale-side-file.zip')]);
    const m = r.model as CrochetModelV1;
    expect(m.revision).toBe(1);
    expect(byId(m).ear_l.dims).toEqual(byId(CANON).ear_l.dims);
    expect(r.repairs[0]).toMatchObject({ code: 'versions', message: '2 versions found: file rev 0, page rev 1 — using rev 1' });
    expect(r.candidates?.map((c) => [c.path, c.revision, c.chosen])).toEqual([
      ['Amigurumi Teddy Bear.html', 1, true],
      ['crochet-model.json', 0, false],
    ]);
  });

  it('picking the file returns revision 0 with ears 20% smaller', async () => {
    const r = await run([derivedInput('teddy-stale-side-file.zip')], { pickCandidate: 'crochet-model.json' });
    const m = r.model as CrochetModelV1;
    expect(m.revision).toBe(0);
    const ear = byId(m).ear_l.dims as { rx: number };
    expect(ear.rx).toBeCloseTo(0.8 * (byId(CANON).ear_l.dims as { rx: number }).rx, 6);
    expect(r.repairs[0].message).toBe('2 versions found: file rev 0, page rev 1 — using file rev 0');
  });
});

describe('G26: builder-v1 exports in meters', HEAVY, () => {
  it('GLB with root extras.crochetModel: ladder step 1, the canonical teddy', async () => {
    const r = await run([derivedInput('teddy-builder-v1.glb')]);
    expect(r).toMatchObject({ carrier: 'glb', dialect: 'canonical-1', confidence: 'high' });
    expectCanonicalParts(r.model as CrochetModelV1);
    expectBboxWithin2(r.model as CrochetModelV1);
  });

  it('GLB with per-node extras only: ladder step 2, spec rebuilt', async () => {
    const r = await run([derivedInput('teddy-builder-v1.noroot.glb')]);
    expect(r).toMatchObject({ carrier: 'glb', dialect: 'canonical-1', confidence: 'high' });
    const m = r.model as CrochetModelV1;
    expectCanonicalParts(m);
    expectBboxWithin2(m);
    expect(m.palette).toEqual(CANON.palette);
    expect(r.repairs.find((x) => x.code === 'spec-rebuilt')?.data).toEqual({ parts: 17, sceneUnitsPerInch: 0.0254 });
    expect(m.revision).toBe(0);
    // no warning that the node matrices disagree with the parts
    expect(r.warnings.filter((w) => w.severity === 'warn')).toEqual([]);
  });

  it('GLB step 2 reads a color used only on a painted part back from COLOR_0', async () => {
    const r = await run([derivedInput('teddy-builder-v1.painted.noroot.glb')]);
    const m = r.model as CrochetModelV1;
    expect(m.palette.find((c) => c.id === 'blush_pink')?.hex).toBe('#E8A0A8');
    expect(byId(m).body.regions).toEqual([{ kind: 'band', from: 0.55, to: 0.75, color: 'blush_pink' }]);
    expect(r.repairs.some((x) => x.code === 'color')).toBe(false);
  });

  const objInputs = (): ImportInput[] => [gunzipInput('teddy-builder-v1.obj', readDerived('teddy-builder-v1.obj.gz')), derivedInput('teddy-builder-v1.mtl')];

  it('OBJ + MTL with no context: the stage header and h ≈ 0.25 ⇒ meters, confirm pre-set to meters', async () => {
    const r = await run(objInputs());
    expect(r).toMatchObject({ carrier: 'obj', dialect: 'geometry-only', confidence: 'low' });
    expect(r.units).toMatchObject({ chosen: 'm', reason: 'stage-header', confirm: true });
    expect(r.units?.rawHeight).toBeCloseTo(0.2509, 3);
    const m = r.model as CrochetModelV1;
    expect(m.parts.map((p) => p.id).sort()).toEqual([...IDS].sort());
    expect(m.palette.map((c) => [c.id, c.hex])).toEqual(CANON.palette.map((c) => [c.id, c.hex]));
    for (const p of CANON.parts) expect(hexOf(m, byId(m)[p.id].color), p.id).toBe(hexOf(CANON, p.color));
    expectBboxWithin2(m);
    expect(r.repairs.find((x) => x.code === 'units')?.message).toBe('read as meters (the three-d-stage export works in meters): 0.251 → 9.88 in tall');
  });

  it('OBJ + MTL with expectedHeightIn = 10: meters, automatic', async () => {
    const r = await run(objInputs(), { expectedHeightIn: 10 });
    expect(r.units).toMatchObject({ chosen: 'm', reason: 'expected-height', confirm: false });
    expectBboxWithin2(r.model as CrochetModelV1);
  });

  it('the attach tree of the builder OBJ, inferred by proximity, is the canonical one', async () => {
    const r = await run(objInputs());
    expectCanonicalTree(r.model as CrochetModelV1);
  });

  it.runIf(isImplemented(fitPart))('with fitPart: the OBJ parts are fitted primitives of the canonical types', async () => {
    const r = await run(objInputs());
    const m = r.model as CrochetModelV1;
    for (const p of CANON.parts) expect(byId(m)[p.id].type, p.id).toBe(p.type);
    expect(r.meshes ?? {}).toEqual({});
  });

  it('without fitPart the OBJ parts are mesh parts whose buffers come with the result', async () => {
    if (isImplemented(fitPart)) return;
    const r = await run(objInputs());
    const m = r.model as CrochetModelV1;
    expect(m.parts.every((p) => p.type === 'mesh')).toBe(true);
    const refs = m.parts.map((p) => (p.type === 'mesh' ? p.dims.meshRef : ''));
    expect(Object.keys(r.meshes ?? {}).sort()).toEqual([...refs].sort());
    // vertex labels point at the part's own color in the final palette
    for (const p of m.parts) {
      if (p.type !== 'mesh') continue;
      const mesh = (r.meshes ?? {})[p.dims.meshRef];
      const want = m.palette.findIndex((c) => c.id === p.color);
      expect(new Set(mesh.labels), p.id).toEqual(new Set([want]));
      expect(mesh.positions.length / 3).toBe(mesh.labels.length);
    }
  });
});

describe('G26: the observed teddy OBJ stays inches', HEAVY, () => {
  const observed = (): ImportInput[] => [gunzipInput('amigurumi-teddy-bear.obj', readFixture('amigurumi-teddy-bear.obj.gz')), fixtureInput('amigurumi-teddy-bear.mtl')];

  it('stage header present, h = 9.88: inches, no confirm; 17 parts with the ids, colors and tree of the teddy', async () => {
    const r = await run(observed());
    expect(r.units).toMatchObject({ chosen: 'in', reason: 'spec', confirm: false });
    expect(r.units?.rawHeight).toBeCloseTo(9.878, 2);
    const m = r.model as CrochetModelV1;
    expect(m.parts.map((p) => p.id).sort()).toEqual([...IDS].sort());
    for (const p of CANON.parts) expect(hexOf(m, byId(m)[p.id].color), p.id).toBe(hexOf(CANON, p.color));
    expectBboxWithin2(m);
    expectCanonicalTree(m);
    expect(m.source).toEqual({ tool: 'claude-design', stage: 'refined' });
  });

  it('with expectedHeightIn = 10 it still reads inches', async () => {
    const r = await run(observed(), { expectedHeightIn: 10 });
    expect(r.units).toMatchObject({ chosen: 'in', reason: 'expected-height', confirm: false });
  });

  it('the 9.5 MB OBJ imports in under 3 s (retried; the machine is shared)', { ...PERF, retry: 2, timeout: 60_000 }, () => {
    const inputs = observed();
    const t = performance.now();
    const r = importInputsSync(inputs);
    const ms = performance.now() - t;
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(budget(3000));
  });

  it('an OBJ dropped without its MTL: gray parts, and a warning naming the missing file', async () => {
    const r = await run([observed()[0]]);
    expect(r.warnings.some((w) => w.code === 'W_IMPORT_PARSE' && /amigurumi-teddy-bear\.mtl/.test(w.message))).toBe(true);
    expect((r.model as CrochetModelV1).palette.map((c) => c.hex)).toEqual(['#9E9E9E']);
  });

  it('a zip holding the OBJ and MTL (no spec) falls back to them', async () => {
    const { makeZip } = await import('./helpers/fixtures');
    const zip = makeZip({ 'export/amigurumi-teddy-bear.obj': gunzipSync(readFixture('amigurumi-teddy-bear.obj.gz')), 'export/amigurumi-teddy-bear.mtl': readFixture('amigurumi-teddy-bear.mtl') });
    const r = await run([fileInput('export.zip', zip)]);
    expect(r).toMatchObject({ carrier: 'zip', dialect: 'geometry-only' });
    expect((r.model as CrochetModelV1).parts).toHaveLength(17);
  });
});

describe('STL and PLY (§3.7.5)', HEAVY, () => {
  const stl = (): ImportInput[] => [derivedInput('teddy-builder-v1.mm.stl.gz')];
  it('binary STL in millimeters with expectedHeightIn = 10: 17 parts, read as mm', async () => {
    const r = await run(stl(), { expectedHeightIn: 10 });
    expect(r).toMatchObject({ carrier: 'stl', dialect: 'geometry-only', confidence: 'low' });
    expect(r.units).toMatchObject({ chosen: 'mm', reason: 'expected-height', confirm: false });
    const m = r.model as CrochetModelV1;
    expect(m.parts).toHaveLength(17);
    expectBboxWithin2(m);
    // no names in an STL: the shapes are named (§2.9.7 step 6), then paired
    expect(m.parts.map((p) => p.id)).toEqual(expect.arrayContaining(['body', 'head', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'ear_l', 'ear_r', 'muzzle', 'tail']));
    expect(attachRoot(m)?.id).toBe('body');
    expect(m.palette).toHaveLength(1);
  });

  it('binary STL with no context: 251 as inches is beyond the limit, so millimeters, confirmed', async () => {
    const r = await run(stl());
    expect(r.units).toMatchObject({ chosen: 'mm', reason: 'spec', confirm: true });
    expectBboxWithin2(r.model as CrochetModelV1);
  });

  it('the user answers the units question: ctx.units wins', async () => {
    const r = await run(stl(), { units: 'mm', expectedHeightIn: 40 });
    expect(r.units).toMatchObject({ chosen: 'mm', reason: 'user', confirm: false });
  });

  it('binary PLY in meters with vertex colors: small bbox ⇒ meters; the four colors come back', async () => {
    const r = await run([derivedInput('teddy-builder-v1.ply.gz')]);
    expect(r).toMatchObject({ carrier: 'ply', dialect: 'geometry-only' });
    expect(r.units).toMatchObject({ chosen: 'm', reason: 'small-bbox', confirm: true });
    const m = r.model as CrochetModelV1;
    expect(m.parts).toHaveLength(17);
    expectBboxWithin2(m);
    expect(m.palette.map((c) => c.hex).sort()).toEqual(CANON.palette.map((c) => c.hex).sort());
    expect(hexOf(m, byId(m).body.color)).toBe('#B07A4A');
  });
});

describe('tar.gz handoff bundles (§3.7.2)', HEAVY, () => {
  it('README + chats + project/: the page and the chat fence are one spec (merged), the canonical teddy', async () => {
    const r = await run([derivedInput('teddy-handoff.tar.gz')]);
    expect(r.carrier).toBe('tar');
    expect(r.repairs.some((x) => x.code === 'versions')).toBe(false);
    expect(r.candidates).toHaveLength(1);
    expectCanonicalParts(r.model as CrochetModelV1);
  });

  it('no project/ folder: "Claude was still waiting for your answer"', async () => {
    const r = await importInputs([derivedInput('teddy-handoff-waiting.tar.gz')]);
    expect(r).toMatchObject({ ok: false, carrier: 'tar', dialect: 'none' });
    expect(r.warnings[0]).toMatchObject({ code: 'E_IMPORT_NO_MODEL', message: 'Claude was still waiting for your answer — reply in Claude Design and re-export' });
  });
});
