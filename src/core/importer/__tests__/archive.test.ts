// §3.7.2 archives and spec candidates, §3.7.6 archive security and limits.
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { CrochetModelV1 } from '../../../types/model';
import { stringifyModel } from '../../model/schema';
import { checkEntryPath, chooseCandidate, readZipDirectory, zipEntryBytes, type Candidate } from '../archive';
import { importInputs } from '../index';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { ARCHIVE_PAGE, archivePageWith, CANONICAL_TEDDY, chatReply, fileInput, makeZip, OBSERVED_JSON, readFixture } from './helpers/fixtures';

const SPEC = JSON.parse(OBSERVED_JSON) as Record<string, unknown> & { parts: Record<string, unknown>[] };
const withRevision = (rev: number, earScale = 1): Record<string, unknown> => ({
  ...SPEC,
  revision: rev,
  parts: SPEC.parts.map((p) => {
    if (p.id !== 'ear_l' && p.id !== 'ear_r') return p;
    const d = p.dimensions as Record<string, number>;
    return { ...p, dimensions: { rx: d.rx * earScale, ry: d.ry * earScale, rz: d.rz * earScale } };
  }),
});
const earRx = (m: CrochetModelV1 | undefined): number => {
  const ear = m?.parts.find((p) => p.id === 'ear_l');
  return ear?.type === 'ellipsoid' ? ear.dims.rx : NaN;
};

/** A minimal binary glTF whose root node carries `extras.crochetModel`. */
function glbWithSpec(spec: unknown): Uint8Array {
  let json = JSON.stringify({ asset: { version: '2.0' }, nodes: [{ name: 'root', extras: { crochetModel: spec } }] });
  while (json.length % 4 !== 0) json += ' ';
  const body = strToU8(json);
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

describe('zip reading', () => {
  it('reads the captured project archive: names, sizes, times; .thumbnail is a dotfile', () => {
    const bytes = readFixture('teddy-bear.project-archive.zip');
    const entries = readZipDirectory(bytes);
    expect(entries.map((e) => e.name)).toEqual(['.thumbnail', 'Amigurumi Teddy Bear.html', 'three-d-stage.js']);
    expect(entries[1].size).toBe(8041);
    expect(new Date(entries[1].time).toISOString()).toBe('2026-10-01T06:36:21.000Z');
    expect(new TextDecoder().decode(zipEntryBytes(bytes, entries[1]))).toBe(ARCHIVE_PAGE);
    expect(checkEntryPath('.thumbnail')).toEqual({ ok: false, skip: 'quiet', reason: 'system file' });
  });

  it('stored (uncompressed) entries read too', () => {
    const z = zipSync({ 'a.html': [strToU8(ARCHIVE_PAGE), { level: 0 }] });
    const e = readZipDirectory(z);
    expect(e[0].method).toBe(0);
    expect(new TextDecoder().decode(zipEntryBytes(z, e[0]))).toBe(ARCHIVE_PAGE);
  });

  it.each<[string, string]>([
    ['../evil.html', 'a path that climbs out of the archive ("..")'],
    ['a/../../evil.json', 'a path that climbs out of the archive ("..")'],
    ['/etc/passwd', 'an absolute path'],
    ['C:\\Windows\\x.html', 'an absolute path'],
    [`${'d/'.repeat(12)}x.html`, 'a path deeper than 12 levels'],
  ])('rejects %s with a warning', (name, reason) => {
    expect(checkEntryPath(name)).toEqual({ ok: false, skip: 'warn', reason });
  });

  it('skips __MACOSX/, dotfiles and folders quietly; accepts ordinary paths', () => {
    expect(checkEntryPath('__MACOSX/._a.html')).toMatchObject({ ok: false, skip: 'quiet' });
    expect(checkEntryPath('project/.git/config')).toMatchObject({ ok: false, skip: 'quiet' });
    expect(checkEntryPath('folder/')).toMatchObject({ ok: false, skip: 'quiet' });
    expect(checkEntryPath('project\\./page.html')).toEqual({ ok: true, path: 'project/page.html' });
  });
});

describe('archive security and limits (§3.7.6)', HEAVY, () => {
  it('a ".." entry is skipped with a warning and the rest of the archive is read', async () => {
    const z = makeZip({ '../escape.json': JSON.stringify(withRevision(9)), 'page.html': ARCHIVE_PAGE });
    const r = await importInputs([fileInput('a.zip', z)]);
    expect(r.ok).toBe(true);
    expect(r.model?.revision).toBe(0);
    expect(r.warnings.some((w) => w.code === 'W_ARCHIVE_ENTRY' && /\.\./.test(w.message))).toBe(true);
    expect(r.candidates?.map((c) => c.path)).toEqual(['page.html']);
  });

  it('more than 2000 entries: refused before anything is unpacked', async () => {
    const z = makeZip({ 'a.html': ARCHIVE_PAGE });
    const eocd = z.length - 22;
    new DataView(z.buffer).setUint16(eocd + 10, 2001, true);
    const r = await importInputs([fileInput('many.zip', z)]);
    expect(r.ok).toBe(false);
    expect(r.carrier).toBe('zip');
    expect(r.warnings[0].code).toBe('E_IMPORT_TOO_LARGE');
  });

  it('more than 300 MB declared in all: refused', async () => {
    const z = makeZip({ 'a.html': ARCHIVE_PAGE, 'b.html': ARCHIVE_PAGE });
    const dv = new DataView(z.buffer);
    const cd = dv.getUint32(z.length - 22 + 16, true);
    dv.setUint32(cd + 24, 200 * 2 ** 20, true);
    const second = cd + 46 + dv.getUint16(cd + 28, true) + dv.getUint16(cd + 30, true) + dv.getUint16(cd + 32, true);
    dv.setUint32(second + 24, 200 * 2 ** 20, true);
    const r = await importInputs([fileInput('bomb.zip', z)]);
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('E_IMPORT_TOO_LARGE');
  });

  it('an entry packed more than 100:1 is not unpacked', async () => {
    const padded = ARCHIVE_PAGE.replace('<body>', `<body>${' '.repeat(3_000_000)}`);
    const r = await importInputs([fileInput('ratio.zip', makeZip({ 'a.html': padded }))]);
    expect(r.ok).toBe(false);
    expect(r.warnings.some((w) => w.code === 'W_ARCHIVE_ENTRY' && /100×/.test(w.message))).toBe(true);
  });

  it('an entry that lies about its size is refused once it passes the declared size (never inflated further)', () => {
    const z = makeZip({ 'a.html': ARCHIVE_PAGE });
    const dv = new DataView(z.buffer);
    const cd = dv.getUint32(z.length - 22 + 16, true);
    dv.setUint32(cd + 24, 100, true);
    const [e] = readZipDirectory(z);
    expect(() => zipEntryBytes(z, e)).toThrow(/more than its declared size/);
  });

  it('input over 100 MB: refused', async () => {
    const r = await importInputs([{ kind: 'file', name: 'huge.zip', bytes: new ArrayBuffer(100 * 2 ** 20 + 1) }]);
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('E_IMPORT_TOO_LARGE');
  });

  it('a damaged archive: E_IMPORT_ARCHIVE', async () => {
    const r = await importInputs([fileInput('bad.zip', new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))]);
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('E_IMPORT_ARCHIVE');
  });

  it('a JSON side file with a forbidden key is dropped; the page is used', async () => {
    const hostile = '{"schema": "crochet-model", "revision": 5, "parts": [], "constructor": {"prototype": {"polluted": 1}}}';
    const r = await importInputs([fileInput('a.zip', makeZip({ 'crochet-model.json': hostile, 'page.html': ARCHIVE_PAGE }))]);
    expect(r.ok).toBe(true);
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
    // the import succeeded, so the dropped side file is a warning (one code, one severity: §2.13)
    expect(r.warnings.find((w) => w.code === 'W_IMPORT_CANDIDATE')?.message).toMatch(/crochet-model.json holds the key/);
    expect(r.warnings.some((w) => w.severity === 'error')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('an archive of pictures only: no model, the pictures are returned (offer F3)', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 1, 2, 3]);
    const r = await importInputs([fileInput('pics.zip', makeZip({ 'front.png': png, 'side.png': png }))]);
    expect(r.ok).toBe(false);
    expect(r.images?.length).toBe(2);
    expect(new Uint8Array(r.images?.[0] as ArrayBuffer)).toEqual(png);
  });
});

describe('spec candidates (§3.7.2)', HEAVY, () => {
  it('stale side file: the page (rev 1) wins over crochet-model.json (rev 0, smaller ears), with the versions chip', async () => {
    const z = makeZip({
      'Amigurumi Teddy Bear.html': archivePageWith(withRevision(1)),
      'crochet-model.json': JSON.stringify(withRevision(0, 0.8)),
      'three-d-stage.js': '// stage',
    });
    const r = await importInputs([fileInput('teddy-stale-side-file.zip', z)]);
    expect(r.ok).toBe(true);
    expect(r.model?.revision).toBe(1);
    expect(earRx(r.model)).toBe(0.85);
    expect(r.repairs[0]).toMatchObject({ code: 'versions', message: '2 versions found: file rev 0, page rev 1 — using rev 1' });
    expect(r.candidates).toEqual([
      { id: 'Amigurumi Teddy Bear.html', path: 'Amigurumi Teddy Bear.html', source: 'html', revision: 1, parts: 17, chosen: true },
      { id: 'crochet-model.json', path: 'crochet-model.json', source: 'json', revision: 0, parts: 17, chosen: false },
    ]);
    // picking the file in the versions picker re-runs the import with ctx.pickCandidate
    const picked = await importInputs([fileInput('teddy-stale-side-file.zip', z)], { pickCandidate: 'crochet-model.json' });
    expect(picked.model?.revision).toBe(0);
    expect(earRx(picked.model)).toBeCloseTo(0.68, 9);
    expect(picked.repairs[0].message).toBe('2 versions found: file rev 0, page rev 1 — using file rev 0');
    expect(picked.candidates?.find((c) => c.chosen)?.id).toBe('crochet-model.json');
  });

  it('a newer side file wins over an older page', async () => {
    const z = makeZip({ 'page.html': archivePageWith(withRevision(1)), 'data/crochet-model.json': JSON.stringify(withRevision(2, 1.2)) });
    const r = await importInputs([fileInput('a.zip', z)]);
    expect(r.model?.revision).toBe(2);
    expect(r.repairs[0].message).toBe('2 versions found: page rev 1, file rev 2 — using rev 2');
  });

  it('equal revisions: page › GLB › chat fence › JSON file, then the newest entry', async () => {
    const files = {
      'model.json': JSON.stringify(withRevision(3, 0.9)),
      'chats/chat1.md': chatReply(JSON.stringify(withRevision(3, 0.95))),
      'export.glb': glbWithSpec(withRevision(3, 1.05)),
      'page.html': archivePageWith(withRevision(3, 1.1)),
    };
    const all = await importInputs([fileInput('a.zip', makeZip(files))]);
    expect(all.candidates?.map((c) => c.source)).toEqual(['html', 'glb', 'chat', 'json']);
    expect(earRx(all.model)).toBeCloseTo(0.935, 9);
    const { 'page.html': _page, ...noPage } = files;
    expect(earRx((await importInputs([fileInput('a.zip', makeZip(noPage))])).model)).toBeCloseTo(0.8925, 9);
    const { 'export.glb': _glb, ...chatAndJson } = noPage;
    expect(earRx((await importInputs([fileInput('a.zip', makeZip(chatAndJson))])).model)).toBeCloseTo(0.8075, 9);
    const older = new Date(Date.UTC(2026, 8, 1));
    const newer = new Date(Date.UTC(2026, 9, 1));
    const byTime = makeZip({ 'a.html': [archivePageWith(withRevision(3, 0.9)), newer], 'b.html': [archivePageWith(withRevision(3, 1.1)), older] });
    expect(earRx((await importInputs([fileInput('a.zip', byTime)])).model)).toBeCloseTo(0.765, 9);
  });

  it('README.md fences are candidates; other markdown is not', async () => {
    const z = makeZip({ 'README.md': chatReply(JSON.stringify(withRevision(4))), 'notes.md': chatReply(JSON.stringify(withRevision(9))) });
    const r = await importInputs([fileInput('handoff.zip', z)]);
    expect(r.model?.revision).toBe(4);
    expect(r.candidates?.map((c) => [c.path, c.source])).toEqual([['README.md', 'chat']]);
  });

  it('an invalid candidate is reported and the valid one used', async () => {
    const z = makeZip({ 'future.json': JSON.stringify({ ...withRevision(7), version: '2.0' }), 'page.html': ARCHIVE_PAGE });
    const r = await importInputs([fileInput('a.zip', z)]);
    expect(r.ok).toBe(true);
    expect(r.model?.revision).toBe(0);
    expect(r.candidates?.map((c) => c.path)).toEqual(['page.html']);
    expect(r.warnings.find((w) => w.code === 'W_IMPORT_CANDIDATE')?.message).toMatch(/future\.json.*version 2\.0/);
  });

  it('an unknown pickCandidate is ignored with a warning', async () => {
    const r = await importInputs([fileInput('a.zip', readFixture('teddy-bear.project-archive.zip'))], { pickCandidate: 'nope.html' });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.code === 'W_IMPORT_CANDIDATE')).toBe(true);
  });

  it('several dropped files are candidates too', async () => {
    const r = await importInputs([fileInput('page.html', archivePageWith(withRevision(2))), fileInput('spec.json', JSON.stringify(withRevision(1, 0.5)))]);
    expect(r.carrier).toBe('html');
    expect(r.model?.revision).toBe(2);
    expect(r.candidates?.map((c) => c.id)).toEqual(['1:page.html', '2:spec.json']);
  });

  it('chooseCandidate merges identical specs and keeps the preferred copy', () => {
    const model = { revision: 0, parts: [] } as unknown as CrochetModelV1;
    const c = (id: string, source: Candidate['source'], hash: string, order: number): Candidate => ({ id, path: id, source, model, hash, order });
    const choice = chooseCandidate([c('a.json', 'json', 'h1', 0), c('b.html', 'html', 'h1', 1)]);
    expect(choice.list.map((x) => x.id)).toEqual(['b.html']);
    expect(choice.repair).toBeUndefined();
  });
});
