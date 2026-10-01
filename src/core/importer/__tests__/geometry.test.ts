// T7.2 unit tests (DESIGN.md §3.7.2, §3.7.5, §3.7.6): the units rule, the OBJ/MTL reader, PLY/STL components,
// the tar and gzip readers with their limits, and the GLB ladder on small synthetic scenes — plus hostile inputs.
import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { budget, PERF } from '../../../test/timing';
import type { ImportInput } from '../../../types/importer';
import type { CrochetModelV1 } from '../../../types/model';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { stringifyModel } from '../../model/schema';
import { gunzipLimited, isTar, readTarEntries } from '../archive';
import { ImportFailure } from '../common';
import { isGenericId } from '../geometry';
import { GltfDoc, gltfGeometry } from '../glb';
import { importInputs } from '../index';
import { materialColorName, parseMtl, parseObj } from '../obj';
import { splitComponents, vertexColorPalette } from '../plyStl';
import { decideUnits, unitReadings } from '../units';
import { CANONICAL_TEDDY, fileInput, makeZip, OBSERVED_JSON } from './helpers/fixtures';

// ---- small builders

function tar(files: [string, string | Uint8Array, string?][], o: { badChecksum?: boolean } = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, content, type = '0'] of files) {
    const data = typeof content === 'string' ? enc.encode(content) : content;
    const h = new Uint8Array(512);
    const put = (t: string, at: number): void => h.set(enc.encode(t), at);
    h.set(enc.encode(name).subarray(0, 100), 0);
    put('0000644\0', 100);
    put(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    put(`${(1_790_000_000).toString(8).padStart(11, '0')}\0`, 136);
    put('        ', 148);
    put(type, 156);
    put('ustar\0', 257);
    put('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${(o.badChecksum ? sum + 1 : sum).toString(8).padStart(6, '0')}\0 `, 148);
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** A GLB (JSON chunk + optional BIN chunk). */
function glb(json: unknown, bin?: Uint8Array): Uint8Array {
  let text = JSON.stringify(json);
  while (text.length % 4 !== 0) text += ' ';
  const body = strToU8(text);
  const binLength = bin ? bin.length + ((4 - (bin.length % 4)) % 4) : 0;
  const out = new Uint8Array(20 + body.length + (bin ? 8 + binLength : 0));
  const v = new DataView(out.buffer);
  v.setUint32(0, 0x46546c67, true);
  v.setUint32(4, 2, true);
  v.setUint32(8, out.length, true);
  v.setUint32(12, body.length, true);
  v.setUint32(16, 0x4e4f534a, true);
  out.set(body, 20);
  if (bin) {
    v.setUint32(20 + body.length, binLength, true);
    v.setUint32(24 + body.length, 0x004e4942, true);
    out.set(bin, 28 + body.length);
  }
  return out;
}

/** An axis-aligned box as 8 vertices and 12 triangles. */
function box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): { pos: number[]; idx: number[] } {
  const pos: number[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) pos.push(cx + (x * sx) / 2, cy + (y * sy) / 2, cz + (z * sz) / 2);
  const idx = [0, 1, 3, 0, 3, 2, 4, 6, 7, 4, 7, 5, 0, 4, 5, 0, 5, 1, 2, 3, 7, 2, 7, 6, 0, 2, 6, 0, 6, 4, 1, 5, 7, 1, 7, 3];
  return { pos, idx };
}

const run = (inputs: ImportInput[], ctx = {}) => importInputs(inputs, ctx);

// ---- units

describe('the units rule of geometry carriers (§3.7.5)', () => {
  it('readings: in, cm, m, mm', () => {
    expect(unitReadings(0.25).map((r) => [r.unit, +r.heightIn.toFixed(4)])).toEqual([
      ['in', 0.25],
      ['cm', 0.0984],
      ['m', 9.8425],
      ['mm', 0.0098],
    ]);
  });

  it.each([
    // [h, ctx, hints, chosen, reason, confirm]
    [0.2509, { expectedHeightIn: 10 }, {}, 'm', 'expected-height', false],
    [25.09, { expectedHeightIn: 10 }, {}, 'cm', 'expected-height', false],
    [9.88, { expectedHeightIn: 10 }, {}, 'in', 'expected-height', false],
    [250.9, { expectedHeightIn: 10 }, {}, 'mm', 'expected-height', false],
    [9.88, { expectedHeightIn: 6.6 }, {}, 'in', 'expected-height', false], // ×1.497: still within ×/÷ 1.5
    [3, { expectedHeightIn: 10 }, {}, 'normalized', 'expected-height', true], // nothing within ×/÷ 1.5
    [0.2509, {}, { stageHeader: true }, 'm', 'stage-header', true],
    [1.524, {}, { stageHeader: true }, 'm', 'stage-header', true],
    [1.53, {}, { stageHeader: true }, 'in', 'spec', false],
    [9.88, {}, { stageHeader: true }, 'in', 'spec', false], // the observed teddy OBJ
    [1.4, {}, {}, 'm', 'small-bbox', true],
    [1.5, {}, {}, 'in', 'spec', false],
    [250.9, {}, {}, 'mm', 'spec', true], // beyond 60 in as inches
    [800, {}, {}, 'cm', 'spec', true], // 31.5 in as millimeters is fine… no: 800 mm = 31.5 in
    [5000, {}, {}, 'in', 'spec', true],
    [0.25, { units: 'in' }, { stageHeader: true }, 'in', 'user', false],
    [0.2509, {}, { sceneUnitsPerInch: 0.0254 }, 'm', 'gltf-extras-ratio', false],
    [9.88, {}, { sceneUnitsPerInch: 1 }, 'in', 'gltf-extras-ratio', false],
    [4.94, {}, { sceneUnitsPerInch: 0.5 }, 'normalized', 'gltf-extras-ratio', false],
  ] as const)('h = %s, ctx %o, hints %o → %s (%s), confirm %s', (h, ctx, hints, chosen, reason, confirm) => {
    const u = decideUnits(h, ctx, hints);
    // 800 mm = 31.5 in: millimeters are tried first
    const want = h === 800 ? 'mm' : chosen;
    expect(u.decision).toMatchObject({ rawHeight: h, chosen: want, reason, confirm });
    expect(u.factor).toBeGreaterThan(0);
  });

  it('normalize to the target: the factor makes the model exactly E tall', () => {
    const u = decideUnits(3, { expectedHeightIn: 10 });
    expect(u.factor * 3).toBeCloseTo(10, 12);
    expect(u.message).toMatch(/scaled to 10 in/);
  });

  it('the exact glTF ratio is applied as measured, whatever unit it is closest to', () => {
    expect(decideUnits(4.94, {}, { sceneUnitsPerInch: 0.5 }).factor).toBe(2);
    expect(decideUnits(0.2509, {}, { sceneUnitsPerInch: 0.0254 }).factor).toBeCloseTo(39.37, 2);
  });
});

// ---- OBJ / MTL

describe('OBJ and MTL readers', () => {
  it('quads and n-gons are fanned; negative and v/vt/vn indices; CRLF; objects compact their vertices', () => {
    const text = [
      'mtllib a.mtl',
      'v 0 0 0',
      'v 1 0 0',
      'v 1 1 0',
      'v 0 1 0',
      'vt 0 0',
      'vn 0 0 1',
      'o first',
      'usemtl red',
      'f 1/1/1 2/1/1 3/1/1 4/1/1',
      'o second',
      'usemtl blue',
      'v 0 0 1',
      'f -1 -2 -3',
      'f 2//1 3//1 5//1',
      'f 9 1 2',
      'o empty',
    ].join('\r\n');
    const p = parseObj(text);
    expect(p.mtllibs).toEqual(['a.mtl']);
    expect(p.vertexCount).toBe(5);
    expect(p.faceCount).toBe(4);
    expect(p.badFaces).toBe(1);
    expect(p.objects.map((o) => o.name)).toEqual(['first', 'second']);
    expect([...p.objects[0].indices]).toEqual([0, 1, 2, 0, 2, 3]);
    // second: vertices 5, 4, 3 then 2, 3, 5 → compacted to 0.. in order of first use
    expect([...p.objects[1].indices]).toEqual([0, 1, 2, 3, 2, 0]);
    expect([...p.objects[1].positions.slice(0, 3)]).toEqual([0, 0, 1]);
    expect(p.objects[1].materials.get('blue')).toBe(2);
  });

  it('a file without `o` lines splits on `g`; with `o` lines, `g` is ignored', () => {
    expect(parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\ng a\nf 1 2 3\ng b\nf 3 2 1\n').objects.map((o) => o.name)).toEqual(['a', 'b']);
    expect(parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\no a\ng x\nf 1 2 3\ng y\nf 3 2 1\n').objects.map((o) => o.name)).toEqual(['a']);
  });

  it('never throws on garbage', () => {
    for (const t of ['', 'f', 'v', 'v a b c\nf 1 2 3', 'f -0 0 0', `o ${'x'.repeat(10000)}`, 'v 1e400 -1e400 nan\nv 0 0 0\nv 0 1 0\nf 1 2 3']) {
      expect(() => parseObj(t)).not.toThrow();
    }
  });

  it('material names → palette color ids: the stage `_n` suffix and builder-v1 `_painted`', () => {
    const known = new Set(['caramel', 'cream', 'caramel_painted', 'yarn_2']);
    expect(materialColorName('caramel', known)).toBe('caramel');
    expect(materialColorName('caramel_painted', known)).toBe('caramel');
    expect(materialColorName('caramel_painted_3', known)).toBe('caramel');
    expect(materialColorName('cream_4', known)).toBe('cream');
    expect(materialColorName('yarn_2', known)).toBe('yarn_2');
    expect(materialColorName('pink_7', known)).toBe('pink_7');
  });

  it('MTL: the three-d-stage header means linear Kd; without it Kd is sRGB', async () => {
    const obj = 'mtllib t.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\no tri\nusemtl c\nf 1 2 3\nf 1 2 4\nf 1 3 4\nf 2 3 4\n';
    const linear = '# Exported by three-d-stage\nnewmtl c\nKd 0.4342 0.1946 0.0685\n';
    const plain = 'newmtl c\nKd 0.4342 0.1946 0.0685\n';
    expect(parseMtl(linear).stageHeader).toBe(true);
    const a = await run([fileInput('t.obj', obj), fileInput('t.mtl', linear)]);
    const b = await run([fileInput('t.obj', obj), fileInput('t.mtl', plain)]);
    expect(a.model?.palette[0].hex).toBe('#B07A4A');
    expect(b.model?.palette[0].hex).toBe('#6F3211');
    // the header decides colors, never units: 1 unit tall, no context → small bbox → meters (asked)
    expect(a.units).toMatchObject({ chosen: 'm', reason: 'stage-header', confirm: true });
  });

  it('an object takes the material most of its faces use', async () => {
    const obj = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\no blob\nusemtl a\nf 1 2 3\nusemtl b\nf 1 2 4\nf 1 3 4\nf 2 3 4\n';
    const r = await run([fileInput('t.obj', obj), fileInput('x.mtl', 'newmtl a\nKd 1 0 0\nnewmtl b\nKd 0 0 1\n')]);
    expect(r.model?.palette.find((c) => c.id === r.model?.parts[0].color)?.hex).toBe('#0000FF');
  });

  it('generic ids are named; real names are kept', () => {
    for (const id of ['', 'part_1', 'mesh_0', 'object', 'sphere_001', 'p_3', '12', 'group_2', 'cube']) expect(isGenericId(id), id).toBe(true);
    for (const id of ['body', 'head', 'ear_l', 'leg', 'tail_tip', 'part_body']) expect(isGenericId(id), id).toBe(false);
  });
});

// ---- PLY / STL

describe('PLY and STL (§3.7.5)', HEAVY, () => {
  it('splitComponents welds duplicated vertices and keeps separate pieces apart, largest first', () => {
    const a = box(0, 0, 0, 1, 1, 1);
    const b = box(3, 0, 0, 1, 2, 1);
    // non-indexed: every triangle has its own three vertices (as STL stores them)
    const pos: number[] = [];
    for (const { pos: p, idx } of [a, b]) for (const i of idx) pos.push(p[3 * i], p[3 * i + 1], p[3 * i + 2]);
    const comps = splitComponents(pos, null);
    expect(comps).toHaveLength(2);
    expect(comps.map((c) => c.positions.length / 3)).toEqual([8, 8]);
    expect(comps.map((c) => c.indices.length / 3)).toEqual([12, 12]);
  });

  it('vertex colors: at most 16, the most used kept, near shades merged', () => {
    const rgb: number[] = [];
    for (let k = 0; k < 40; k++) for (let n = 0; n < 40 - k; n++) rgb.push((k * 6) % 256, (k * 37) % 256, (k * 91) % 256);
    // and a near-duplicate of the first color
    rgb.push(1, 0, 0);
    const { colors: pal, labels } = vertexColorPalette(rgb);
    expect(pal.length).toBeLessThanOrEqual(16);
    expect(labels.every((l) => l < pal.length)).toBe(true);
    expect(pal[0].hex).toBe('#000000');
    expect(labels[labels.length - 1]).toBe(0);
  });

  it('an ascii PLY with vertex colors: two pieces, two colors', async () => {
    const a = box(0, 0.5, 0, 1, 1, 1);
    const b = box(0, 1.5, 0, 0.6, 1, 0.6);
    const lines = ['ply', 'format ascii 1.0', 'element vertex 16', 'property float x', 'property float y', 'property float z', 'property uchar red', 'property uchar green', 'property uchar blue', 'element face 24', 'property list uchar int vertex_indices', 'end_header'];
    for (let i = 0; i < 8; i++) lines.push(`${a.pos[3 * i]} ${a.pos[3 * i + 1]} ${a.pos[3 * i + 2]} 200 30 40`);
    for (let i = 0; i < 8; i++) lines.push(`${b.pos[3 * i]} ${b.pos[3 * i + 1] + 0.01} ${b.pos[3 * i + 2]} 20 40 200`);
    for (let t = 0; t < 12; t++) lines.push(`3 ${a.idx[3 * t]} ${a.idx[3 * t + 1]} ${a.idx[3 * t + 2]}`);
    for (let t = 0; t < 12; t++) lines.push(`3 ${b.idx[3 * t] + 8} ${b.idx[3 * t + 1] + 8} ${b.idx[3 * t + 2] + 8}`);
    const r = await run([fileInput('toy.ply', `${lines.join('\n')}\n`)], { units: 'in' });
    expect(r.ok).toBe(true);
    const m = r.model as CrochetModelV1;
    expect(m.parts).toHaveLength(2);
    expect(m.palette.map((c) => c.hex).sort()).toEqual(['#1428C8', '#C81E28']);
    expect(r.units).toMatchObject({ chosen: 'in', reason: 'user' });
    expect(Object.keys(r.meshes ?? {})).toHaveLength(2);
  });

  it('a binary STL: no names, no colors, gray parts', async () => {
    const shapes = [box(0, 0.5, 0, 1, 1, 1), box(0, 1.5, 0, 0.5, 1, 0.5)];
    const tris = shapes.flatMap(({ pos, idx }) => Array.from({ length: idx.length / 3 }, (_, t) => [0, 1, 2].map((j) => pos.slice(3 * idx[3 * t + j], 3 * idx[3 * t + j] + 3))));
    const bytes = new Uint8Array(84 + 50 * tris.length);
    const v = new DataView(bytes.buffer);
    bytes.set(strToU8('solid binary header'), 0);
    v.setUint32(80, tris.length, true);
    tris.forEach((tri, t) => {
      tri.forEach((p, j) => p.forEach((x, k) => v.setFloat32(84 + 50 * t + 12 + 12 * j + 4 * k, x, true)));
    });
    const r = await run([fileInput('toy.stl', bytes)], { expectedHeightIn: 2 });
    expect(r).toMatchObject({ ok: true, carrier: 'stl', dialect: 'geometry-only' });
    expect(r.model?.parts).toHaveLength(2);
    expect(r.model?.palette).toEqual([{ id: 'gray', hex: '#9E9E9E', name: 'gray' }]);
    expect(r.repairs.some((x) => x.code === 'color')).toBe(true);
  });

  it('a broken PLY or STL never throws', async () => {
    for (const [name, text] of [
      ['a.ply', 'ply\nformat binary_little_endian 1.0\nelement vertex 99999999\nproperty float x\nend_header\n'],
      ['b.ply', 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nend_header\n1\n'],
      ['c.stl', 'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nendloop\nendfacet\nendsolid'],
    ] as const) {
      const r = await run([fileInput(name, text)]);
      expect(r.ok, name).toBe(false);
      expect(r.dialect).toBe('none');
    }
  });
});

// ---- tar and gzip

describe('tar.gz and gzip (§3.7.2, §3.7.6)', HEAVY, () => {
  it('ustar entries with prefix-less names, GNU long names and pax paths', () => {
    const long = `deep/${'x'.repeat(120)}.json`;
    const t = tar([
      ['a/README.md', '# hi'],
      ['././@LongLink', `${long}\0`, 'L'],
      ['short-placeholder', '{}'],
      ['PaxHeader', `${(' path=pax/name.html\n'.length + 3).toString()} path=pax/name.html\n`, 'x'],
      ['ignored-by-pax', '<html></html>'],
      ['a/dir/', '', '5'],
    ]);
    expect(isTar(t)).toBe(true);
    const e = readTarEntries(t);
    expect(e.map((x) => [x.name, x.size, x.isDirectory])).toEqual([
      ['a/README.md', 4, false],
      [long, 2, false],
      ['pax/name.html', 13, false],
      ['a/dir/', 0, true],
    ]);
    expect(e[0].time).toBe(1_790_000_000_000);
  });

  it('a damaged header checksum: E_IMPORT_ARCHIVE', async () => {
    const r = await run([fileInput('h.tar.gz', gzipSync(tar([['p/project/a.html', 'x']], { badChecksum: true })))]);
    expect(r).toMatchObject({ ok: false, carrier: 'tar', dialect: 'none' });
    expect(r.warnings[0].code).toBe('E_IMPORT_ARCHIVE');
  });

  it('unsafe paths are skipped with a warning; the spec next to them is used', async () => {
    const r = await run([fileInput('h.tgz', gzipSync(tar([['../evil.json', OBSERVED_JSON], ['/abs.json', OBSERVED_JSON], ['b/project/crochet-model.json', OBSERVED_JSON]])))]);
    expect(r.ok).toBe(true);
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
    expect(r.warnings.filter((w) => w.code === 'W_ARCHIVE_ENTRY')).toHaveLength(2);
  });

  it('more than 2000 entries: E_IMPORT_TOO_LARGE', () => {
    const files = Array.from({ length: 2001 }, (_, i): [string, string] => [`f${i}.txt`, '']);
    expect(() => readTarEntries(tar(files))).toThrow(ImportFailure);
  });

  it('a gzip whose trailer claims more than 300 MB, or more than 100× (past 16 MB), is not inflated', () => {
    const z = gzipSync(new Uint8Array(1000));
    const lie = (n: number): Uint8Array => {
      const b = z.slice();
      new DataView(b.buffer).setUint32(b.length - 4, n, true);
      return b;
    };
    expect(() => gunzipLimited(lie(301 * 2 ** 20))).toThrow(/more than 300 MB/);
    expect(() => gunzipLimited(lie(17 * 2 ** 20))).toThrow(/100×/);
    // a lying small trailer: refused as soon as the stream passes it
    expect(() => gunzipLimited(lie(10))).toThrow(/more than its trailer says/);
    expect(gunzipLimited(z)).toHaveLength(1000);
  });

  it('a single gzipped file (not a tar) is read as the file inside', async () => {
    const r = await run([fileInput('teddy.json.gz', gzipSync(strToU8(OBSERVED_JSON)))]);
    expect(r.ok).toBe(true);
    expect(r.carrier).toBe('json');
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
  });

  it('an unpacked .tar (ustar at 257) is read like the .tar.gz', async () => {
    const r = await run([fileInput('h.tar', tar([['b/project/crochet-model.json', OBSERVED_JSON]]))]);
    expect(r).toMatchObject({ ok: true, carrier: 'tar' });
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
  });

  it('a gzip inside a gzip is refused', async () => {
    const r = await run([fileInput('x.gz', gzipSync(gzipSync(strToU8(OBSERVED_JSON))))]);
    expect(r.warnings[0].code).toBe('E_IMPORT_UNSUPPORTED');
  });
});

// ---- the GLB ladder on small scenes

/** A sphere of radius `r` (scene units) as accessor min/max only, for steps 2–3 (no BIN needed). */
function sphereMesh(json: { accessors: unknown[]; meshes: unknown[]; materials: unknown[] }, r: number, material: number): number {
  json.accessors.push({ componentType: 5126, count: 3, type: 'VEC3', min: [-r, -r, -r], max: [r, r, r], bufferView: 0 });
  json.meshes.push({ primitives: [{ attributes: { POSITION: json.accessors.length - 1 }, material }] });
  return json.meshes.length - 1;
}

describe('GLB ladder on synthetic scenes (§3.7.5)', HEAVY, () => {
  it('step 3: TRS nodes under a scaled-free group, meters measured from the accessors, colors linear → sRGB', async () => {
    const json = {
      asset: { version: '2.0' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [
        { name: 'toy', children: [1] },
        { name: 'body', translation: [0, 0.0254 * 2, 0], extras: { type: 'sphere', dimensions: { r: 2 } }, mesh: 0, children: [2] },
        { name: 'head', translation: [0, 0.0254 * 3, 0], rotation: [0, 0, Math.sin(Math.PI / 12), Math.cos(Math.PI / 12)], extras: { name: 'Head', type: 'sphere', dimensions: { r: 1.5 } }, mesh: 1 },
      ],
      accessors: [] as unknown[],
      bufferViews: [{ buffer: 0, byteLength: 36 }],
      buffers: [{ byteLength: 36 }],
      meshes: [] as unknown[],
      materials: [
        { name: 'tan_yarn', pbrMetallicRoughness: { baseColorFactor: [0.4342, 0.1946, 0.0685, 1] } },
        { name: 'cream_yarn', pbrMetallicRoughness: { baseColorFactor: [0.8879, 0.7682, 0.5647, 1] } },
      ],
    };
    sphereMesh(json, 0.0254 * 2, 0);
    sphereMesh(json, 0.0254 * 1.5, 1);
    const r = await run([fileInput('toy.glb', glb(json))]);
    expect(r).toMatchObject({ ok: true, dialect: 'cd-observed-2026-09', confidence: 'medium' });
    expect(r.units).toMatchObject({ chosen: 'm', reason: 'gltf-extras-ratio', confirm: false });
    const m = r.model as CrochetModelV1;
    const head = m.parts.find((p) => p.id === 'head');
    expect(head?.label).toBe('Head');
    expect(head?.attach?.to).toBe('body');
    expect(head?.rotationDeg?.[2]).toBeCloseTo(30, 6);
    expect(head?.position[1]).toBeCloseTo(5 + 0, 6); // 2 + 3, grounded: body bottom at y = 0 → +0 (2 − 2)
    expect(m.palette.map((c) => [c.id, c.hex])).toEqual([
      ['tan_yarn', '#B07A4A'],
      ['cream_yarn', '#F2E3C6'],
    ]);
  });

  it('step 4: triangles only (data: URI buffer); a .gltf with its .bin as a sibling file', async () => {
    const a = box(0, 0.5, 0, 1, 1, 1);
    const b = box(0, 1.6, 0, 0.8, 0.8, 0.8);
    const verts = new Float32Array([...a.pos, ...b.pos]);
    const ind = new Uint16Array([...a.idx, ...b.idx]);
    const bin = new Uint8Array(verts.byteLength + ind.byteLength);
    bin.set(new Uint8Array(verts.buffer), 0);
    bin.set(new Uint8Array(ind.buffer), verts.byteLength);
    const json = (uri?: string) => ({
      asset: { version: '2.0' },
      nodes: [
        { name: 'Mesh_0', mesh: 0 },
        { name: 'Mesh_1', mesh: 1, translation: [0, 0, 0] },
      ],
      buffers: [{ byteLength: bin.length, ...(uri ? { uri } : {}) }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: verts.byteLength },
        { buffer: 0, byteOffset: verts.byteLength, byteLength: ind.byteLength },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' },
        { bufferView: 0, byteOffset: 96, componentType: 5126, count: 8, type: 'VEC3' },
        { bufferView: 1, componentType: 5123, count: 36, type: 'SCALAR' },
        { bufferView: 1, byteOffset: 72, componentType: 5123, count: 36, type: 'SCALAR' },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 2, material: 0 }] }, { primitives: [{ attributes: { POSITION: 1 }, indices: 3, material: 0 }] }],
      materials: [{ name: 'red', pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } }],
    });
    let s = '';
    for (const x of bin) s += String.fromCharCode(x);
    const dataUri = `data:application/octet-stream;base64,${btoa(s)}`;
    const one = await run([fileInput('toy.gltf', JSON.stringify(json(dataUri)))], { units: 'in' });
    expect(one).toMatchObject({ ok: true, carrier: 'gltf', dialect: 'geometry-only', confidence: 'low' });
    expect(one.model?.parts.map((p) => p.id).sort()).toEqual(['body', 'head']);
    expect(one.model?.palette).toEqual([{ id: 'red', hex: '#FF0000', name: 'red' }]);
    const two = await run([fileInput('toy.gltf', JSON.stringify(json('toy.bin'))), fileInput('toy.bin', bin)], { units: 'in' });
    expect(two.ok).toBe(true);
    expect(stringifyModel(two.model as CrochetModelV1)).toBe(stringifyModel(one.model as CrochetModelV1));
    // without the .bin: a clear message
    const none = await run([fileInput('toy.gltf', JSON.stringify(json('toy.bin')))]);
    expect(none).toMatchObject({ ok: false, dialect: 'none' });
    expect(none.warnings[0].message).toMatch(/drop its \.bin file/);
    // a zip holding both
    const zipped = await run([fileInput('toy.zip', makeZip({ 'toy/toy.gltf': JSON.stringify(json('toy.bin')), 'toy/toy.bin': bin }))], { units: 'in' });
    expect(zipped).toMatchObject({ ok: true, carrier: 'zip' });
  });

  it('hostile GLB data never throws: accessors out of range, cycles, sparse, compression, huge counts', () => {
    const base = { asset: { version: '2.0' }, buffers: [{ byteLength: 12 }], bufferViews: [{ buffer: 0, byteLength: 12 }] };
    const docs = [
      { ...base, nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 1000, type: 'VEC3' }] },
      { ...base, nodes: [{ mesh: 0, children: [1] }, { children: [0] }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3' }] },
      { ...base, nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3', sparse: { count: 1 } }] },
      { ...base, nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 }, extensions: { KHR_draco_mesh_compression: {} } }] }], accessors: [] },
      { ...base, nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 1e12, type: 'VEC3' }] },
      { ...base, nodes: [{ name: 'p', extras: { type: 'sphere', dimensions: { r: 'x' } }, matrix: [1, 2, 3] }] },
      { ...base, nodes: [{ name: 'p', extras: { crochet: { id: 'p', type: 'nope', dims: {} } } }] },
      { asset: { version: '2.0' }, nodes: 'nope', scenes: [{ nodes: [99, -1, 'a'] }] },
    ];
    for (const json of docs) {
      expect(() => gltfGeometry(new GltfDoc(json as Record<string, unknown>, { bin: new Uint8Array(12) }))).not.toThrow();
    }
    const compressed = gltfGeometry(new GltfDoc(docs[3] as Record<string, unknown>));
    expect(compressed.ok === false && compressed.failure.message).toMatch(/compressed/);
  });

  it('a GLB with a forbidden key is refused as unsafe', async () => {
    const r = await run([fileInput('x.glb', glb(JSON.parse('{"asset":{"version":"2.0"},"nodes":[{"extras":{"__proto__":{"polluted":1}}}]}')))]);
    expect(r).toMatchObject({ ok: false, dialect: 'none' });
    expect(r.warnings[0].code).toBe('E_IMPORT_UNSAFE');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ---- regressions of the independent review (T7.2)

/** A GLB holding the given boxes as triangle meshes (one node each), with one material per box. */
function boxesGlb(boxes: { name: string; b: ReturnType<typeof box>; color?: [number, number, number] }[], o: { extraIndex?: number; badOffset?: boolean; twoPrims?: boolean } = {}): Uint8Array {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  const json = { asset: { version: '2.0' }, nodes: [] as unknown[], meshes: [] as unknown[], accessors: [] as unknown[], bufferViews: [] as unknown[], materials: [] as unknown[], buffers: [] as unknown[] };
  const view = (bytes: Uint8Array): number => {
    chunks.push(bytes);
    json.bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: bytes.length });
    offset += bytes.length;
    return json.bufferViews.length - 1;
  };
  boxes.forEach(({ name, b, color }, i) => {
    const pos = view(new Uint8Array(new Float32Array(b.pos).buffer));
    const idx = b.idx.slice();
    if (o.extraIndex !== undefined) idx.push(o.extraIndex, 0, 1);
    const ind = view(new Uint8Array(new Uint32Array(idx).buffer));
    json.accessors.push({ bufferView: pos, componentType: 5126, count: 8, type: 'VEC3', ...(o.badOffset ? { byteOffset: -12 } : {}) });
    const position = json.accessors.length - 1;
    json.materials.push({ name: `m${i}`, pbrMetallicRoughness: { baseColorFactor: [...(color ?? [0.5, 0.5, 0.5]), 1] } });
    const material = json.materials.length - 1;
    if (o.twoPrims) {
      // half the triangles in this box's color, half in white
      json.materials.push({ name: `n${i}`, pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1] } });
      json.accessors.push({ bufferView: ind, componentType: 5125, count: 18, type: 'SCALAR' });
      json.accessors.push({ bufferView: ind, byteOffset: 72, componentType: 5125, count: 18, type: 'SCALAR' });
      const n = json.accessors.length;
      json.meshes.push({ primitives: [{ attributes: { POSITION: position }, indices: n - 2, material }, { attributes: { POSITION: position }, indices: n - 1, material: material + 1 }] });
    } else {
      json.accessors.push({ bufferView: ind, componentType: 5125, count: idx.length, type: 'SCALAR' });
      json.meshes.push({ primitives: [{ attributes: { POSITION: position }, indices: json.accessors.length - 1, material }] });
    }
    json.nodes.push({ name, mesh: json.meshes.length - 1 });
  });
  const bin = new Uint8Array(offset);
  let at = 0;
  for (const c of chunks) {
    bin.set(c, at);
    at += c.length;
  }
  json.buffers.push({ byteLength: bin.length });
  return glb(json, bin);
}

describe('review regressions (T7.2)', HEAVY, () => {
  it('a mesh part never has more vertices than its bboxIn says; 48 in per part and 60 in tall hold on the real vertices', async () => {
    for (const [ctx, size] of [[{}, 55], [{ units: 'm' }, 8]] as const) {
      const r = await run([fileInput('big.glb', boxesGlb([{ name: 'block', b: box(0, size / 2, 0, size, size, size) }]))], ctx);
      expect(r.ok).toBe(true);
      const m = r.model as CrochetModelV1;
      const p = m.parts[0];
      expect(p.type).toBe('mesh');
      if (p.type !== 'mesh') continue;
      const mesh = (r.meshes ?? {})[p.dims.meshRef];
      const ext = [0, 1, 2].map((k) => {
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = k; i < mesh.positions.length; i += 3) {
          lo = Math.min(lo, mesh.positions[i]);
          hi = Math.max(hi, mesh.positions[i]);
        }
        return hi - lo;
      });
      ext.forEach((e, k) => expect(Math.abs(e - p.dims.bboxIn[k])).toBeLessThan(1e-3));
      expect(Math.max(...ext)).toBeLessThanOrEqual(48 + 1e-6);
      expect(r.repairs.some((x) => x.code === 'limits')).toBe(true);
    }
  });

  it('an absurd expectedHeightIn is ignored; no non-finite coordinate reaches a mesh', async () => {
    const r = await run([fileInput('b.glb', boxesGlb([{ name: 'block', b: box(0, 1, 0, 2, 2, 2) }]))], { expectedHeightIn: 1e200 });
    expect(r.units?.reason).not.toBe('expected-height');
    for (const mesh of Object.values(r.meshes ?? {})) expect(mesh.positions.every(Number.isFinite)).toBe(true);
  });

  it('indices past the vertex list are dropped; a negative accessor offset fails with a plain message', async () => {
    const r = await run([fileInput('b.glb', boxesGlb([{ name: 'block', b: box(0, 1, 0, 2, 2, 2) }], { extraIndex: 99 }))], { units: 'in' });
    expect(r.ok).toBe(true);
    for (const mesh of Object.values(r.meshes ?? {})) expect(Math.max(...mesh.indices)).toBeLessThan(mesh.positions.length / 3);
    const bad = await run([fileInput('b.glb', boxesGlb([{ name: 'block', b: box(0, 1, 0, 2, 2, 2) }], { badOffset: true }))]);
    expect(bad.ok).toBe(false);
    expect(bad.warnings[0].message).not.toMatch(/DataView|Offset/);
  });

  it('a mesh with two materials keeps both as vertex labels', async () => {
    const r = await run([fileInput('b.glb', boxesGlb([{ name: 'block', b: box(0, 1, 0, 2, 2, 2), color: [1, 0, 0] }], { twoPrims: true }))], { units: 'in' });
    expect(r.ok).toBe(true);
    expect(r.model?.palette.map((c) => c.hex).sort()).toEqual(['#FF0000', '#FFFFFF']);
    const mesh = Object.values(r.meshes ?? {})[0];
    expect(new Set(mesh.labels).size).toBe(2);
  });

  it('20 colors in an OBJ: merged to 16, every vertex label still points at a color', async () => {
    const lines: string[] = [];
    const mtl: string[] = [];
    for (let i = 0; i < 20; i++) {
      const b = box(i * 1.5, 1, 0, 1, 2, 1);
      for (let v = 0; v < 8; v++) lines.push(`v ${b.pos[3 * v]} ${b.pos[3 * v + 1]} ${b.pos[3 * v + 2]}`);
      lines.push(`o p${i}`, `usemtl m${i}`);
      for (let t = 0; t < 12; t++) lines.push(`f ${b.idx[3 * t] + 1 + 8 * i} ${b.idx[3 * t + 1] + 1 + 8 * i} ${b.idx[3 * t + 2] + 1 + 8 * i}`);
      mtl.push(`newmtl m${i}`, `Kd ${(i % 5) / 4} ${Math.floor(i / 5) / 4} ${(i * 7) % 3 / 2}`);
    }
    const r = await run([fileInput('c.obj', lines.join('\n')), fileInput('c.mtl', mtl.join('\n'))], { units: 'in' });
    expect(r.ok).toBe(true);
    const m = r.model as CrochetModelV1;
    expect(m.palette.length).toBeLessThanOrEqual(16);
    for (const p of m.parts) {
      if (p.type !== 'mesh') continue;
      const labels = (r.meshes ?? {})[p.dims.meshRef].labels;
      expect(labels.every((l) => l !== 255 && l < m.palette.length)).toBe(true);
      expect(m.palette[labels[0]].id).toBe(p.color);
    }
  });

  it('more than 60 objects: the largest are kept (the body is never dropped for beads)', async () => {
    const lines: string[] = [];
    let n = 0;
    const add = (name: string, b: ReturnType<typeof box>): void => {
      for (let v = 0; v < 8; v++) lines.push(`v ${b.pos[3 * v]} ${b.pos[3 * v + 1]} ${b.pos[3 * v + 2]}`);
      lines.push(`o ${name}`);
      for (let t = 0; t < 12; t++) lines.push(`f ${b.idx[3 * t] + 1 + n} ${b.idx[3 * t + 1] + 1 + n} ${b.idx[3 * t + 2] + 1 + n}`);
      n += 8;
    };
    for (let i = 0; i < 70; i++) add(`bead_${i}`, box((i % 10) * 0.3, 9 + Math.floor(i / 10) * 0.1, 0, 0.1, 0.1, 0.1));
    add('body', box(0, 5, 0, 4, 10, 4));
    const r = await run([fileInput('beads.obj', lines.join('\n'))], { units: 'in' });
    expect(r.ok).toBe(true);
    expect(r.model?.parts).toHaveLength(60);
    expect(r.model?.parts.some((p) => p.id === 'body')).toBe(true);
    expect(r.model?.finishedSize.height).toBeCloseTo(10, 3);
  });

  it('PLY: an element without properties cannot be "read" millions of times; NaN and a far unused vertex are harmless', { ...PERF }, async () => {
    const t = performance.now();
    const junk = await run([fileInput('j.ply', 'ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement junk 30000000\nend_header\n0 0 0\n1 0 0\n0 1 0\n')]);
    expect(junk.ok).toBe(false);
    expect(performance.now() - t).toBeLessThan(budget(1000));
    const b = box(0, 1, 0, 2, 2, 2);
    const head = (n: number) => ['ply', 'format ascii 1.0', `element vertex ${n}`, 'property float x', 'property float y', 'property float z', 'element face 12', 'property list uchar int vertex_indices', 'end_header'];
    const verts = Array.from({ length: 8 }, (_, v) => `${b.pos[3 * v]} ${b.pos[3 * v + 1]} ${b.pos[3 * v + 2]}`);
    const faces = Array.from({ length: 12 }, (_, f) => `3 ${b.idx[3 * f]} ${b.idx[3 * f + 1]} ${b.idx[3 * f + 2]}`);
    const far = await run([fileInput('f.ply', [...head(9), ...verts, '1e7 0 0', ...faces].join('\n'))], { units: 'in' });
    expect(far.ok).toBe(true);
    expect(far.model?.finishedSize.height).toBeCloseTo(2, 3);
    const nan = await run([fileInput('n.ply', [...head(8), ...verts.slice(0, 7), 'nan 2 1', ...faces].join('\n'))], { units: 'in' });
    expect(nan.ok).toBe(true);
    for (const mesh of Object.values(nan.meshes ?? {})) expect(mesh.positions.every(Number.isFinite)).toBe(true);
  });

  it('a gzip or zip entry that lies about its size small is refused without inflating it all', { ...PERF }, async () => {
    const bomb = gzipSync(new Uint8Array(64 * 2 ** 20));
    new DataView(bomb.buffer).setUint32(bomb.length - 4, 1000, true);
    let t = performance.now();
    const r = await run([fileInput('x.tar.gz', bomb)]);
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('E_IMPORT_TOO_LARGE');
    expect(performance.now() - t).toBeLessThan(budget(1000));
    // a zip entry whose declared size is small: the 100:1 rule sees only that, the capped inflate stops at it
    const zip = makeZip({ 'big.json': new Uint8Array(32 * 2 ** 20) });
    const view = new DataView(zip.buffer);
    for (let o = 0; o + 46 < zip.length; o++) {
      if (view.getUint32(o, true) === 0x02014b50) view.setUint32(o + 24, 1000, true);
    }
    t = performance.now();
    const z = await run([fileInput('x.zip', zip)]);
    expect(z.ok).toBe(false);
    expect(performance.now() - t).toBeLessThan(budget(1000));
  });

  it('GLB step 3 with thousands of materials stays linear', { ...PERF }, async () => {
    const n = 3000;
    const json = { asset: { version: '2.0' }, nodes: [] as unknown[], materials: [] as unknown[], accessors: [] as unknown[], meshes: [] as unknown[], bufferViews: [{ buffer: 0, byteLength: 12 }], buffers: [{ byteLength: 12 }] };
    for (let i = 0; i < n; i++) {
      json.materials.push({ name: `c${i}`, pbrMetallicRoughness: { baseColorFactor: [(i % 97) / 96, (i % 89) / 88, (i % 83) / 82, 1] } });
      json.accessors.push({ bufferView: 0, componentType: 5126, count: 1, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] });
      json.meshes.push({ primitives: [{ attributes: { POSITION: i }, material: i }] });
      json.nodes.push({ name: `p${i}`, mesh: i, translation: [i % 50, 1, Math.floor(i / 50)], extras: { type: 'sphere', dimensions: { r: 1 } } });
    }
    const t = performance.now();
    const r = await run([fileInput('many.glb', glb(json))]);
    expect(performance.now() - t).toBeLessThan(budget(5000));
    expect(r.ok).toBe(true);
    expect(r.model?.parts.length).toBe(60);
  });

  it('GLB step 3: sizes that disagree with their meshes ask about the units; ctx.units answers', async () => {
    const json = {
      asset: { version: '2.0' },
      nodes: [
        { name: 'a', mesh: 0, translation: [0, 1, 0], extras: { type: 'sphere', dimensions: { r: 1 } } },
        { name: 'b', mesh: 1, translation: [0, 2.5, 0], extras: { type: 'sphere', dimensions: { r: 1 } } },
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3', min: [-1, -1, -1], max: [1, 1, 1] },
        { bufferView: 0, componentType: 5126, count: 1, type: 'VEC3', min: [-1.5, -1.5, -1.5], max: [1.5, 1.5, 1.5] },
      ],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }, { primitives: [{ attributes: { POSITION: 1 } }] }],
      bufferViews: [{ buffer: 0, byteLength: 12 }],
      buffers: [{ byteLength: 12 }],
    };
    const r = await run([fileInput('d.glb', glb(json))]);
    expect(r.units?.confirm).toBe(true);
    const answered = await run([fileInput('d.glb', glb(json))], { units: 'in' });
    expect(answered.units).toMatchObject({ chosen: 'in', reason: 'user', confirm: false });
  });
});
