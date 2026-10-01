// Regressions for the independent review of T7.1 (docs/tracks/t7.md "Independent review"): hostile values, deep
// nesting, super-linear scans, palette floods, limits and units corner cases, archive details.
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ImportResult } from '../../../types/importer';
import type { CrochetModelV1, Part } from '../../../types/model';
import { readZipDirectory } from '../archive';
import { importInputs } from '../index';
import { rightTwinId } from '../repair';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { CANONICAL_TEDDY, fileInput, OBSERVED_JSON } from './helpers/fixtures';

const run = (spec: unknown): Promise<ImportResult> => importInputs([{ kind: 'text', text: typeof spec === 'string' ? spec : JSON.stringify(spec) }]);
const byId = (m: CrochetModelV1 | undefined): Record<string, Part> => Object.fromEntries((m?.parts ?? []).map((p) => [p.id, p]));
const ball = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: 'crochet-model',
  version: '1.0',
  palette: [{ id: 'c1', hex: '#ff0000' }],
  finishedSize: { height: 2 },
  parts: [{ id: 'ball', type: 'sphere', dims: { r: 1 }, position: [0, 1, 0], color: 'c1' }],
  ...extra,
});
const timed = async (f: () => Promise<ImportResult>): Promise<{ r: ImportResult; ms: number }> => {
  const t0 = performance.now();
  const r = await f();
  return { r, ms: performance.now() - t0 };
};

describe('prototype-named values never reach Object.prototype (review C1, M7)', HEAVY, () => {
  it.each(['constructor', '__proto__', 'toString', 'hasOwnProperty', 'ConstructorGeometry', 'valueOf'])('type / region kind / color / units / feature kind / shape = %s', async (word) => {
    const spec = {
      ...ball({ units: word }),
      parts: [
        { id: 'ball', type: 'sphere', dims: { r: 1 }, position: [0, 1, 0], color: 'c1', regions: [{ kind: word, color: 'c1' }, { kind: 'band', from: 0, to: 0.5, color: word }] },
        { id: 'odd', type: word, dims: { r: 0.3, shape: word }, position: [0, 2, 0], color: `dark ${word}` },
        { id: 'leaf', type: 'flat', dims: { shape: word, w: 1, h: 1, thickness: 0.2 }, position: [0, 1, 1], color: word },
      ],
      features: [{ id: 'f', kind: word, on: 'ball', azimuthDeg: 0, elevationDeg: 0, color: word }],
    };
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(byId(r.model).odd.type).toBe('ellipsoid');
    expect(r.model?.features).toBeUndefined();
    expect(Object.getOwnPropertyNames(Object.prototype).sort()).toEqual(Object.getOwnPropertyNames(Object.getPrototypeOf({})).sort());
  });
});

describe('malformed values (review C2, C3)', HEAVY, () => {
  it('feature paths keep only number pairs', async () => {
    for (const path of [[1, 2], [null], 'x', [[0, 0], [10, 'a'], [5, 5]], { a: 1 }]) {
      const r = await run(ball({ features: [{ id: 'mouth', kind: 'mouth', on: 'ball', azimuthDeg: 0, elevationDeg: 0, path }] }));
      expect(r.ok).toBe(true);
      const kept = r.model?.features?.[0].path;
      expect(kept === undefined || kept.every((pt) => pt.length === 2 && pt.every(Number.isFinite))).toBe(true);
    }
  });

  it.each([2500, 3000, 6000])('an x-* value %i levels deep is dropped, the spec imported', async (depth) => {
    const text = OBSERVED_JSON.replace('"schema"', `"x-deep": ${'['.repeat(depth)}${']'.repeat(depth)}, "schema"`);
    const r = await run(text);
    if (r.ok) {
      expect(r.repairs.some((x) => x.code === 'limits' && /x-deep/.test(x.message))).toBe(true);
      expect((r.model as unknown as Record<string, unknown>)['x-deep']).toBeUndefined();
    } else expect(r.warnings[0].code).toBe('E_IMPORT_PARSE'); // beyond what JSON.parse with a reviver can nest
  });

  it('deep regions and part extensions are dropped too', async () => {
    const deep = JSON.parse(`${'['.repeat(2000)}${']'.repeat(2000)}`) as unknown;
    const spec = ball();
    (spec.parts as Record<string, unknown>[])[0].regions = [{ kind: 'band', from: 0, to: 1, color: 'c1', x: deep }];
    (spec.parts as Record<string, unknown>[])[0]['x-deep'] = deep;
    const r = await run(spec);
    expect(r.ok).toBe(true);
    expect(byId(r.model).ball.regions).toBeUndefined();
  });
});

describe('bounded work on hostile text (review C4, M1)', HEAVY, () => {
  it.each<[string, () => string]>([
    ['600 open braces, 10 matches, 1 MB of text', () => `${'{'.repeat(600)}${'"schema":"crochet-model",'.repeat(10)}${'a'.repeat(1e6)}`],
    ['64 open braces then 100k broken specs', () => `${'{'.repeat(64)}${'{"schema":"crochet-model","x":}'.repeat(100_000)}`],
  ])('pasted: %s', { retry: 2 }, async (_label, make) => {
    const text = make();
    const { r, ms } = await timed(() => run(text));
    expect(r.ok).toBe(false);
    expect(ms).toBeLessThan(5000);
  });

  it('an HTML script with 100k marker blocks', { retry: 2 }, async () => {
    const page = `<html><script>${'/*CROCHET-MODEL-BEGIN*/{"schema":"crochet-model",/*CROCHET-MODEL-END*/'.repeat(100_000)}</script></html>`;
    const { r, ms } = await timed(() => importInputs([fileInput('p.html', page)]));
    expect(r.ok).toBe(false);
    expect(ms).toBeLessThan(5000);
  });

  it('a palette of 20 000 colors with one name, and 5 000 used colors', { retry: 2 }, async () => {
    const hexes = Array.from({ length: 20_000 }, (_, i) => `#${(i * 811).toString(16).padStart(6, '0').slice(-6)}`);
    const sameName = { ...JSON.parse(OBSERVED_JSON), palette: Object.fromEntries(hexes.map((h) => [h, 'yarn'])) };
    const a = await timed(() => run(sameName));
    expect(a.ms).toBeLessThan(5000);
    expect(a.r.ok).toBe(true);
    const spec = ball({ palette: hexes.slice(0, 5000).map((hex, i) => ({ id: `c${i}`, hex })) });
    (spec.parts as Record<string, unknown>[])[0].regions = Array.from({ length: 24 }, (_, i) => ({ kind: 'band', from: i / 24, to: (i + 1) / 24, color: `c${i}` }));
    const b = await timed(() => run(spec));
    expect(b.ms).toBeLessThan(5000);
    expect(b.r.ok).toBe(true);
    expect(b.r.model?.palette.length).toBe(16);
    expect(b.r.repairs.filter((x) => x.code === 'limits').length).toBeLessThanOrEqual(4);
  });
});

describe('limits and units corner cases (review M2–M5)', HEAVY, () => {
  it('mirror synthesis stops at 60 parts instead of failing the import', async () => {
    const parts = Array.from({ length: 50 }, (_, i) => ({ id: `leg${i}_l`, type: 'sphere', dims: { r: 0.3 }, position: [1, 0.3 + i * 0.2, 0], color: 'c1', notes: 'one of a mirrored pair' }));
    const r = await run(ball({ parts: [{ id: 'body', type: 'sphere', dims: { r: 2 }, position: [0, 5, 0], color: 'c1' }, ...parts], finishedSize: { height: 12 } }));
    expect(r.ok).toBe(true);
    expect(r.model?.parts.length).toBe(60);
    expect(r.repairs.some((x) => x.code === 'limits' && /was not added/.test(x.message))).toBe(true);
  });

  it('a stray "parent": null does not change capsules written in canonical dims', async () => {
    const r = await run(ball({ parts: [{ id: 'arm', type: 'capsule', dims: { r: 0.3, length: 1.4 }, position: [0, 0.7, 0], color: 'c1', parent: null }], finishedSize: { height: 1.4 } }));
    expect(byId(r.model).arm.dims).toEqual({ r: 0.3, length: 1.4 });
  });

  it('declared mm with a finished height already in inches converts once', async () => {
    const r = await run(ball({ units: 'mm', parts: [{ id: 'ball', type: 'sphere', dims: { r: 25.4 }, position: [0, 25.4, 0], color: 'c1' }], finishedSize: { height: 2 } }));
    expect(r.ok).toBe(true);
    expect(byId(r.model).ball.dims).toEqual({ r: 1 });
    expect(r.model?.finishedSize.height).toBe(2);
  });

  it('a clamped part re-measures the height; a stated height above 60 in is ignored; a 70 in model is scaled to 60', async () => {
    const zero = await run(ball({ parts: [{ id: 'ball', type: 'sphere', dims: { r: 0 }, position: [0, 0, 0], color: 'c1' }], finishedSize: undefined }));
    expect(zero.ok).toBe(true);
    expect(zero.model?.finishedSize.height).toBe(0.1);
    const huge = await run(ball({ finishedSize: { height: 1000 } }));
    expect(huge.ok).toBe(true);
    expect(huge.model?.finishedSize.height).toBe(2);
    const tall = await run(ball({ parts: [{ id: 'ball', type: 'sphere', dims: { r: 35 }, position: [0, 35, 0], color: 'c1' }], finishedSize: { height: 70 } }));
    expect(tall.ok).toBe(true);
    expect(tall.model?.finishedSize.height).toBeCloseTo(60, 4);
  });
});

describe('archives and odd inputs (review M6, minors)', HEAVY, () => {
  it('a .gltf in a zip carrying extras.crochetModel is a candidate', async () => {
    const gltf = JSON.stringify({ asset: { version: '2.0' }, nodes: [{ extras: { crochetModel: JSON.parse(OBSERVED_JSON) } }] });
    const r = await importInputs([fileInput('a.zip', zipSync({ 'model.gltf': strToU8(gltf) }))]);
    expect(r.ok).toBe(true);
    expect(r.candidates?.[0]).toMatchObject({ path: 'model.gltf', source: 'glb' });
  });

  it('an archive comment holding the end-of-directory signature does not hide the archive', async () => {
    const z = zipSync({ 'page.json': strToU8(OBSERVED_JSON) }, { comment: 'PK\x05\x06 fake' } as never);
    const withComment = new Uint8Array(z.length);
    withComment.set(z);
    expect(readZipDirectory(withComment).map((e) => e.name)).toEqual(['page.json']);
    const r = await importInputs([fileInput('a.zip', withComment)]);
    expect(r.ok).toBe(true);
  });

  it('a GLB with a forbidden key inside a zip is reported', async () => {
    const json = '{"asset":{"version":"2.0"},"nodes":[{"extras":{"crochetModel":{"schema":"crochet-model","__proto__":{}}}}]}  ';
    const body = strToU8(json.padEnd(Math.ceil(json.length / 4) * 4, ' '));
    const glb = new Uint8Array(20 + body.length);
    const v = new DataView(glb.buffer);
    v.setUint32(0, 0x46546c67, true);
    v.setUint32(4, 2, true);
    v.setUint32(8, glb.length, true);
    v.setUint32(12, body.length, true);
    v.setUint32(16, 0x4e4f534a, true);
    glb.set(body, 20);
    const r = await importInputs([fileInput('a.zip', zipSync({ 'x.glb': glb }))]);
    expect(r.warnings.some((w) => w.code === 'E_IMPORT_UNSAFE')).toBe(true);
  });

  it('a pasted HTML fragment with an entity-escaped data-crochet-model attribute', async () => {
    const attr = OBSERVED_JSON.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const r = await run(`Here is the element: <three-d-stage data-crochet-model="${attr}"></three-d-stage>`);
    expect(r.ok).toBe(true);
    expect(r.carrier).toBe('html');
  });

  it('a .json without "schema" is not a spec', async () => {
    const r = await importInputs([fileInput('x.json', JSON.stringify({ parts: [{ id: 'a' }] }))]);
    expect(r.ok).toBe(false);
  });

  it('lathe points out of order are sorted and their sharp corners follow them', async () => {
    const r = await run(ball({ parts: [{ id: 'vase', type: 'lathe', dims: { profile: [[0, 0], [1, 2], [0.8, 1], [0, 3]], sharp: [1] }, position: [0, 0, 0], color: 'c1' }], finishedSize: { height: 3 } }));
    expect(byId(r.model).vase.dims).toEqual({ profile: [[0, 0], [0.8, 1], [1, 2], [0, 3]], sharp: [2] });
  });

  it('rightTwinId knows front/back legs', () => {
    expect(rightTwinId('leg_fl')).toBe('leg_fr');
    expect(rightTwinId('leg_bl_paw')).toBe('leg_br_paw');
  });

  it('pickCandidate on a single file warns', async () => {
    const r = await importInputs([fileInput('teddy.json', OBSERVED_JSON)], { pickCandidate: 'other.html' });
    expect(r.ok).toBe(true);
    expect(r.warnings[0].code).toBe('W_IMPORT_CANDIDATE');
  });

  it('the canonical teddy still imports as itself', async () => {
    const r = await run(CANONICAL_TEDDY);
    expect(r.ok).toBe(true);
  });
});
