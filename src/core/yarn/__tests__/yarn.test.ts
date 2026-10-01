import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { isImplemented } from '../../stub';
import { deltaE00Hex } from '../../kernel/color';
import { CSV_MAX_ROWS, normalizeHex, parseYarnCsv, splitCsvLine } from '../csv';
import { DEFAULT_REFERENCE_LINE_ID, SHIPPED_LINES, findLine, getShippedLine, lineFileProblems, type YarnLineFile } from '../lines';
import { APPROXIMATE_DE00, nearestYarn, nearestYarnIn } from '../match';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DATA = path.join(ROOT, 'src/data/yarns');
const SCRIPT = path.join(ROOT, 'scripts/import-yarns.mjs');

describe('shipped yarn data (§5.6 licence gate)', () => {
  it('ACCEPTANCE: every shipped line file is valid — hex, unique ids, attribution, provenance record', () => {
    const files = readdirSync(DATA).filter((f) => f.endsWith('.json') && f !== 'sources.json');
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const line = JSON.parse(readFileSync(path.join(DATA, f), 'utf8')) as YarnLineFile;
      expect(lineFileProblems(line), f).toEqual([]);
      expect(f).toBe(`${line.id}.json`);
    }
    // Every file on disk is shipped through the registry, and nothing else is.
    expect(SHIPPED_LINES.map((l) => `${l.id}.json`).sort()).toEqual(files.sort());
  });

  it('the gate: only makebead/craft-color-codes Red Heart Super Saver (44 shades, CC BY 4.0) ships', () => {
    expect(SHIPPED_LINES.map((l) => l.id)).toEqual(['red-heart-super-saver']);
    const l = getShippedLine('red-heart-super-saver')!;
    expect(l.yarns.length).toBe(44);
    expect(l.license).toBe('CC-BY-4.0');
    expect(l.source).toMatch(/^https:\/\/github\.com\/makebead\/craft-color-codes\/blob\/[0-9a-f]{40}\//);
    expect(l.provenance.licenseEvidence).toMatch(/LICENSE-DATA\.md$/);
    expect(l.attribution).toContain('MakeBead');
    expect(l.attribution).toContain('CC BY 4.0');
    expect(l.cyc).toBe(4);
    expect(DEFAULT_REFERENCE_LINE_ID).toBe('red-heart-super-saver');
    // ATTRIBUTION.md credits the line.
    const attribution = readFileSync(path.join(DATA, 'ATTRIBUTION.md'), 'utf8');
    expect(attribution).toContain('craft-color-codes by [MakeBead](https://makebead.com/)');
    expect(attribution).toContain(l.provenance.commit!);
  });

  it('the upstream snapshot is the pinned file, and the shipped JSON is exactly what the importer makes of it', () => {
    const l = getShippedLine('red-heart-super-saver')!;
    const snap = readFileSync(path.join(DATA, l.provenance.input!.file));
    expect(createHash('sha256').update(snap).digest('hex')).toBe(l.provenance.input!.sha256);
    const r = spawnSync(process.execPath, [SCRIPT, '--check'], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    // Names, numbers and colors are the upstream's, unchanged (hex lowercased).
    const up = JSON.parse(snap.toString('utf8')) as { colors: { code: string; name: string; hex: string }[] };
    expect(l.yarns.map((y) => [y.number, y.name, y.hex])).toEqual(up.colors.map((c) => [c.code, c.name, c.hex.toLowerCase()]));
  });

  it('heathers are flagged textured and get the heather skein size; solids 364 yd / 198 g', () => {
    const l = getShippedLine('red-heart-super-saver')!;
    const heather = l.yarns.find((y) => y.name === 'Gray Heather')!;
    expect(heather.textured).toBe(true);
    expect([heather.skeinYards, heather.skeinGrams]).toEqual([236, 141]);
    const white = l.yarns.find((y) => y.number === '0311')!;
    expect(white.textured).toBeUndefined();
    expect([white.skeinYards, white.skeinGrams, white.ydPer100g]).toEqual([364, 198, 183.8]);
    expect(l.yarns.filter((y) => y.textured).map((y) => y.name)).toEqual(['Gray Heather']);
  });

  it('findLine prefers the request\'s copy of a line, then the shipped one', () => {
    const mine = { id: 'red-heart-super-saver', brand: 'X', line: 'Y', cyc: 4 as const, source: 's', license: 'l', yarns: [] };
    expect(findLine('red-heart-super-saver', [mine])).toBe(mine);
    expect(findLine('red-heart-super-saver')?.yarns.length).toBe(44);
    expect(findLine('nope')).toBeUndefined();
  });
});

describe('scripts/import-yarns.mjs refuses lines without provenance (§5.6)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'cpg-yarns-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const upstream = readFileSync(path.join(DATA, 'upstream/makebead-red-heart-super-saver.json'));
  writeFileSync(path.join(dir, 'in.json'), upstream);
  const sha = createHash('sha256').update(upstream).digest('hex');
  const good = {
    id: 'test-line',
    brand: 'Test',
    line: 'Line',
    cyc: 4,
    input: { path: 'in.json', format: 'makebead', sha256: sha },
    provenance: {
      source: 'https://example.org/data.json',
      license: 'CC-BY-4.0',
      licenseEvidence: 'https://example.org/LICENSE',
      retrieved: '2026-10-01',
      attribution: 'Test data, CC BY 4.0',
      changes: 'converted',
    },
  };
  const run = (lines: unknown[], name: string): { status: number | null; out: string; written: boolean } => {
    const manifest = path.join(dir, `${name}.json`);
    const out = path.join(dir, `out-${name}`);
    writeFileSync(manifest, JSON.stringify({ lines }));
    const r = spawnSync(process.execPath, [SCRIPT, '--manifest', manifest, '--out', out], { encoding: 'utf8' });
    return { status: r.status, out: r.stdout + r.stderr, written: existsSync(path.join(out, 'test-line.json')) };
  };

  it('writes a line with a complete provenance record', () => {
    const r = run([good], 'good');
    expect(r.status, r.out).toBe(0);
    expect(r.written).toBe(true);
    const line = JSON.parse(readFileSync(path.join(dir, 'out-good/test-line.json'), 'utf8')) as YarnLineFile;
    expect(lineFileProblems(line)).toEqual([]);
    expect(line.yarns[0].id).toBe('test-line:0311');
  });

  it('ACCEPTANCE: refuses a line without provenance, or with any field of it missing', () => {
    const { provenance: _drop, ...noProvenance } = good;
    void _drop;
    let r = run([noProvenance], 'none');
    expect(r.status).toBe(1);
    expect(r.written).toBe(false);
    expect(r.out).toMatch(/REFUSED test-line: no provenance record/);
    for (const k of ['source', 'license', 'licenseEvidence', 'retrieved', 'attribution', 'changes']) {
      r = run([{ ...good, provenance: { ...good.provenance, [k]: '' } }], `missing-${k}`);
      expect(r.status, k).toBe(1);
      expect(r.written, k).toBe(false);
      expect(r.out).toContain(`provenance.${k} is missing`);
    }
  });

  it('refuses a licence outside the allowlist (e.g. GPL-3.0), a changed input, bad hex and duplicate ids', () => {
    let r = run([{ ...good, provenance: { ...good.provenance, license: 'GPL-3.0' } }], 'gpl');
    expect(r.status).toBe(1);
    expect(r.written).toBe(false);
    expect(r.out).toMatch(/not allowed/);
    r = run([{ ...good, input: { ...good.input, sha256: '0'.repeat(64) } }], 'sha');
    expect(r.status).toBe(1);
    expect(r.written).toBe(false);
    writeFileSync(path.join(dir, 'bad-input.json'), JSON.stringify({ yarns: [{ name: 'A', hex: '#12345' }] }));
    const badSha = createHash('sha256').update(readFileSync(path.join(dir, 'bad-input.json'))).digest('hex');
    r = run([{ ...good, input: { path: 'bad-input.json', format: 'yarnline', sha256: badSha } }], 'hex');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not #rrggbb/);
    writeFileSync(path.join(dir, 'dup-input.json'), JSON.stringify({ yarns: [{ name: 'A', hex: '#123456', number: '1' }, { name: 'B', hex: '#654321', number: '1' }] }));
    const dupSha = createHash('sha256').update(readFileSync(path.join(dir, 'dup-input.json'))).digest('hex');
    r = run([{ ...good, input: { path: 'dup-input.json', format: 'yarnline', sha256: dupSha } }], 'dup');
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/not unique/);
  });

  it('a refused line does not stop a good one; bad usage exits 2', () => {
    const r = run([{ ...good, id: 'other', provenance: undefined }, good], 'mixed');
    expect(r.status).toBe(1);
    expect(r.written).toBe(true);
    const u = spawnSync(process.execPath, [SCRIPT, '--nope'], { encoding: 'utf8' });
    expect(u.status).toBe(2);
    expect(execFileSync(process.execPath, [SCRIPT, '--help'], { encoding: 'utf8' })).toMatch(/usage/);
  });
});

describe('nearestYarn (§5.2.1)', () => {
  const rhss = getShippedLine('red-heart-super-saver')!.yarns;

  it('is implemented', () => {
    expect(isImplemented(nearestYarn)).toBe(true);
  });

  it('ACCEPTANCE: returns the ΔE00-closest shade of the given lines (brute force over 300 colors)', () => {
    let s = 12345;
    for (let t = 0; t < 300; t++) {
      s = (s * 1103515245 + 12345) >>> 0;
      const hex = `#${(s & 0xffffff).toString(16).padStart(6, '0')}`;
      const got = nearestYarn(hex, ['red-heart-super-saver'])!;
      let best = Infinity;
      for (const y of rhss) best = Math.min(best, deltaE00Hex(hex, y.hex));
      expect(got.deltaE00).toBeCloseTo(best, 9);
      expect(deltaE00Hex(hex, got.yarn.hex)).toBeCloseTo(best, 9);
    }
  });

  it('exact shades match themselves with ΔE00 0; upper-case hex works', () => {
    for (const y of rhss) {
      const m = nearestYarn(y.hex.toUpperCase(), ['red-heart-super-saver'])!;
      expect(m.deltaE00).toBe(0);
      // Ties with an identical earlier shade would keep the first; RHSS has none.
      expect(m.yarn.id).toBe(y.id);
    }
  });

  it('null for no known line, an empty list or an invalid hex; unknown ids are skipped', () => {
    expect(nearestYarn('#ff0000', [])).toBeNull();
    expect(nearestYarn('#ff0000', ['no-such-line'])).toBeNull();
    expect(nearestYarn('red', ['red-heart-super-saver'])).toBeNull();
    expect(nearestYarn('#ff0000', ['no-such-line', 'red-heart-super-saver'])?.yarn.lineId).toBe('red-heart-super-saver');
  });

  it('nearestYarnIn works over any list and can skip yarns (textured ones for protected colors)', () => {
    const grey = '#9e9e93';
    expect(nearestYarnIn(grey, rhss)!.yarn.name).toBe('Gray Heather');
    expect(nearestYarnIn(grey, rhss, (y) => y.textured === true)!.yarn.name).not.toBe('Gray Heather');
    expect(nearestYarnIn(grey, [])).toBeNull();
    expect(APPROXIMATE_DE00).toBe(10);
  });
});

describe('custom CSV palettes (§2.4.4)', () => {
  it('parses #hex,name[,brand,code,yds_per_skein] leniently into valid yarns', () => {
    const csv = '﻿hex,name,brand,code,yards\r\n#FF0000,Red,Acme,R1,200\n00ff00, "Green, bright" ,,,\n#00f,Blue\n\n// a comment\n#123456';
    const { yarns, issues } = parseYarnCsv(csv);
    expect(issues).toEqual([]);
    expect(yarns.map((y) => [y.hex, y.name, y.brand, y.number, y.skeinYards])).toEqual([
      ['#ff0000', 'Red', 'Acme', 'R1', 200],
      ['#00ff00', 'Green, bright', 'Custom', undefined, undefined],
      ['#0000ff', 'Blue', 'Custom', undefined, undefined],
      ['#123456', '#123456', 'Custom', undefined, undefined],
    ]);
    expect(yarns[0].id).toBe('custom:ff0000:red');
    expect(new Set(yarns.map((y) => y.id)).size).toBe(4);
    for (const y of yarns) expect(y.lineId).toBe('custom');
  });

  it('ids are stable under reordering; repeated rows are kept once', () => {
    const a = parseYarnCsv('#ff0000,Red\n#0000ff,Blue').yarns;
    const b = parseYarnCsv('#0000ff,Blue\n#ff0000,Red\n#ff0000,Red').yarns;
    expect(b.map((y) => y.id).sort()).toEqual(a.map((y) => y.id).sort());
    expect(b.length).toBe(2);
  });

  it('reports unreadable rows in one W_CSV_ROW warning and caps the palette size', () => {
    const r = parseYarnCsv('#ff0000,Red\nnot a color,X\n#zzzzzz,Bad\n#00ff00,Green,,,-5');
    expect(r.yarns.map((y) => y.name)).toEqual(['Red', 'Green']);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ code: 'W_CSV_ROW', severity: 'warn' });
    expect(r.issues[0].message).toContain('lines 2, 3, 4');
    const many = Array.from({ length: CSV_MAX_ROWS + 5 }, (_, i) => `#${i.toString(16).padStart(6, '0')},C${i}`).join('\n');
    const m = parseYarnCsv(many);
    expect(m.yarns.length).toBe(CSV_MAX_ROWS);
    expect(m.issues[0].message).toContain('5 more ignored');
    expect(parseYarnCsv('').yarns).toEqual([]);
  });

  it('helpers', () => {
    expect(splitCsvLine('a,"b,""c""",d')).toEqual(['a', 'b,"c"', 'd']);
    expect(normalizeHex('#ABC')).toBe('#aabbcc');
    expect(normalizeHex('12345')).toBeUndefined();
    expect(parseYarnCsv('#999999,Oat Heather').yarns[0].textured).toBe(true);
  });
});
