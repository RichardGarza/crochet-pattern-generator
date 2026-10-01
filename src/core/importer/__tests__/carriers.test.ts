// importInputs on the other inputs of §3.7.2 (empty, project files, pictures, GLB with a spec, formats of later
// sprints), robustness on damaged and random input, and the time budget.
import { strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { ImportInput } from '../../../types/importer';
import type { CrochetModelV1 } from '../../../types/model';
import { mulberry32, randomInt } from '../../kernel/prng';
import { stringifyModel } from '../../model/schema';
import { importInputs } from '../index';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { ARCHIVE_PAGE, CANONICAL_TEDDY, fileInput, fixtureInput, OBSERVED_JSON, readFixture, readFixtureText } from './helpers/fixtures';

function glb(json: unknown): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += ' ';
  const body = strToU8(text);
  const out = new Uint8Array(20 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, body.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(body, 20);
  return out;
}

describe('other inputs', HEAVY, () => {
  it('nothing, or empty text: E_IMPORT_NO_MODEL', async () => {
    expect((await importInputs([])).warnings[0].code).toBe('E_IMPORT_NO_MODEL');
    expect((await importInputs([{ kind: 'text', text: '' }])).warnings[0].code).toBe('E_IMPORT_NO_MODEL');
  });

  it('a whole-project .crochet.json is sent to the library import', async () => {
    const r = await importInputs([fileInput('bear.crochet.json', JSON.stringify({ format: 'crochet-project-file', version: 1, project: {} }))]);
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('E_IMPORT_PROJECT_FILE');
  });

  it('a picture: no model, the picture is returned for F3', async () => {
    const png = readFixture('teddy-bear.local-render.png');
    const r = await importInputs([fileInput('render.png', png)]);
    expect(r).toMatchObject({ ok: false, carrier: 'image' });
    expect(r.images?.[0].byteLength).toBe(png.byteLength);
  });

  it('a GLB carrying extras.crochetModel (ladder step 1) is a spec carrier', async () => {
    const r = await importInputs([fileInput('teddy.glb', glb({ asset: { version: '2.0' }, nodes: [{ name: 'teddy', extras: { crochetModel: JSON.parse(OBSERVED_JSON) } }] }))]);
    expect(r).toMatchObject({ ok: true, carrier: 'glb', dialect: 'cd-observed-2026-09' });
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
  });

  it('geometry files without a spec go to the geometry path (T7.2); broken or lone ones say what to drop', async () => {
    const cases: [ImportInput, boolean, string][] = [
      [fixtureInput('amigurumi-teddy-bear.glb'), true, 'glb'],
      [fixtureInput('amigurumi-teddy-bear.obj.gz'), true, 'obj'],
      [fileInput('bear.obj', 'o head\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n'), true, 'obj'],
      [fixtureInput('amigurumi-teddy-bear.mtl'), false, 'E_IMPORT_NO_MODEL'],
      [fileInput('bear.stl', 'solid bear\nfacet normal 0 0 1\nendfacet\nendsolid'), false, 'E_IMPORT_PARSE'],
      [fileInput('bear.pdf', '%PDF-1.7\n'), false, 'E_IMPORT_UNSUPPORTED'],
    ];
    for (const [input, ok, what] of cases) {
      const name = input.kind === 'file' ? input.name : '';
      const r = await importInputs([input]);
      expect(r.ok, name).toBe(ok);
      if (ok) expect(r.carrier, name).toBe(what);
      else {
        expect(r.warnings[0].code, name).toBe(what);
        expect(r.dialect, name).toBe('none');
      }
    }
  }, 60_000);

  it('a .json that holds a chat reply, and a .md chat export, still work', async () => {
    const chat = `Here you go\n\n\`\`\`json\n${OBSERVED_JSON}\n\`\`\``;
    for (const name of ['reply.json', 'chat.md', 'reply.txt']) {
      const r = await importInputs([fileInput(name, chat)]);
      expect(r.ok, name).toBe(true);
      expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
    }
  });
});

describe('robustness', HEAVY, () => {
  it('random bytes and random text never throw', async () => {
    const rng = mulberry32(12);
    for (let k = 0; k < 60; k++) {
      const n = randomInt(rng, 4000);
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i++) bytes[i] = randomInt(rng, 256);
      if (k % 3 === 0) bytes.set([0x50, 0x4b, 0x03, 0x04].slice(0, n));
      const r = await importInputs([fileInput(`f${k}.bin`, bytes)]);
      expect(r.ok).toBe(false);
    }
  });

  it('every truncation of the carriers fails cleanly or still yields a valid model', async () => {
    const page = readFixtureText('teddy-bear.standalone.html');
    const zip = readFixture('teddy-bear.project-archive.zip');
    const rng = mulberry32(7);
    for (let k = 0; k < 25; k++) {
      for (const [name, data] of [
        ['page.html', ARCHIVE_PAGE],
        ['standalone.html', page],
        ['spec.json', OBSERVED_JSON],
      ] as const) {
        const cut = data.slice(0, randomInt(rng, data.length));
        const r = await importInputs([fileInput(name, cut)]);
        if (r.ok) expect(r.model?.parts.length).toBeGreaterThan(0);
        else expect(r.warnings.some((w) => w.severity === 'error')).toBe(true);
      }
      const r = await importInputs([fileInput('a.zip', zip.slice(0, randomInt(rng, zip.length)))]);
      expect(r.ok).toBe(false);
    }
  });

  it('flipped bytes inside the archive never throw', async () => {
    const zip = readFixture('teddy-bear.project-archive.zip');
    const rng = mulberry32(99);
    for (let k = 0; k < 40; k++) {
      const z = zip.slice();
      for (let j = 0; j < 4; j++) z[randomInt(rng, z.length)] ^= 1 << randomInt(rng, 8);
      const r = await importInputs([fileInput('a.zip', z)]);
      expect(typeof r.ok).toBe('boolean');
    }
  });

  it('deep nesting and huge numbers of keys are handled', async () => {
    const deep = `${'['.repeat(5000)}${']'.repeat(5000)}`;
    expect((await importInputs([{ kind: 'text', text: `{"schema": "crochet-model", "x": ${deep}}` }])).ok).toBe(false);
    const wide = { ...JSON.parse(OBSERVED_JSON), ...Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i])) };
    const r = await importInputs([{ kind: 'text', text: JSON.stringify(wide) }]);
    expect(r.ok).toBe(true);
    // 3001 unknown keys: 20 chips, then one that sums up the rest
    const keys = r.repairs.filter((x) => x.code === 'unknown-key');
    expect(keys.length).toBe(21);
    expect(keys[20]).toEqual({ code: 'unknown-key', message: '… and 2981 more like these', data: { more: 2981 } });
  });
});

describe('time budget', HEAVY, () => {
  it('the standalone page (625 KB) imports in well under 2 s', { retry: 2 }, async () => {
    const input = fixtureInput('teddy-bear.standalone.html');
    await importInputs([input]);
    const t0 = performance.now();
    const r = await importInputs([input]);
    const ms = performance.now() - t0;
    expect(r.ok).toBe(true);
    expect(ms).toBeLessThan(2000);
  });
});
