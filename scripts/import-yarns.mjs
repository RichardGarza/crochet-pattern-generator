#!/usr/bin/env node
// Track T1 (DESIGN.md §5.1, §5.6 "Yarn data"): imports yarn lines into src/data/yarns/<id>.json.
//
//   node scripts/import-yarns.mjs [--manifest src/data/yarns/sources.json] [--out src/data/yarns] [--check]
//
// The manifest lists every line with its input file (pinned by sha256) and its provenance record. The licence
// gate: a line is written only when its provenance is complete — source, licence, licence evidence (where the
// licence is stated), retrieval date, attribution line and the changes made (CC BY requires saying so) — and its
// licence is on the allowlist. Anything else is refused with a message and the script exits 1; refused lines
// are never written (other lines still are). `--check` writes nothing and exits 1 when a shipped file differs
// from what the manifest would produce.
//
// Input formats:
//   makebead  — craft-color-codes palette JSON: { colors: [{ code, name, hex }] }
//   yarnline  — { yarns: [{ name, hex, number? }] }
// Exit codes: 0 done · 1 a line was refused or (with --check) differs · 2 bad usage.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Licences a shipped line may carry (§5.6: CC BY sources only; CC0 asks for less). */
export const ALLOWED_LICENSES = ['CC-BY-4.0', 'CC0-1.0'];
/** Provenance fields every line must record. */
export const REQUIRED_PROVENANCE = ['source', 'license', 'licenseEvidence', 'retrieved', 'attribution', 'changes'];
/** Shade names that read as textured yarn (§2.4.4). */
const TEXTURED = /\b(heather|marl|fleck|tweed|ombre|variegated|print|stripes?)\b/i;
const HEX = /^#[0-9a-f]{6}$/;

function parseArgs(argv) {
  const o = { manifest: path.join(ROOT, 'src/data/yarns/sources.json'), out: undefined, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--manifest') o.manifest = path.resolve(argv[++i] ?? '');
    else if (a === '--out') o.out = path.resolve(argv[++i] ?? '');
    else if (a === '--check') o.check = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new UsageError(`unknown argument ${a}`);
  }
  o.out ??= path.dirname(o.manifest);
  return o;
}

class UsageError extends Error {}

/** Why a line's provenance is not acceptable (empty when it is). */
export function provenanceProblems(entry) {
  const p = entry?.provenance;
  if (p === undefined || p === null || typeof p !== 'object') return ['no provenance record'];
  const out = [];
  for (const k of REQUIRED_PROVENANCE) {
    if (typeof p[k] !== 'string' || p[k].trim() === '') out.push(`provenance.${k} is missing`);
  }
  if (typeof p.license === 'string' && p.license.trim() !== '' && !ALLOWED_LICENSES.includes(p.license)) {
    out.push(`licence ${p.license} is not allowed (only ${ALLOWED_LICENSES.join(', ')}; see DESIGN.md §5.6)`);
  }
  for (const k of ['source', 'licenseEvidence']) {
    if (typeof p[k] === 'string' && p[k].trim() !== '' && !/^https:\/\//.test(p[k])) out.push(`provenance.${k} must be an https URL`);
  }
  if (typeof p.retrieved === 'string' && p.retrieved.trim() !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(p.retrieved)) {
    out.push('provenance.retrieved must be a date (YYYY-MM-DD)');
  }
  return out;
}

function readInput(entry, baseDir) {
  const inp = entry.input;
  if (!inp || typeof inp.path !== 'string') throw new Error('input.path is missing');
  const file = path.resolve(baseDir, inp.path);
  const bytes = readFileSync(file);
  if (typeof inp.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(inp.sha256)) throw new Error('input.sha256 is missing (inputs are pinned)');
  const sha = createHash('sha256').update(bytes).digest('hex');
  if (sha !== inp.sha256) throw new Error(`input ${inp.path} has sha256 ${sha}, the manifest pins ${inp.sha256}`);
  const json = JSON.parse(bytes.toString('utf8'));
  if (inp.format === 'makebead') {
    if (!Array.isArray(json.colors)) throw new Error('makebead input has no colors array');
    // The file states its own licence: it must be the one recorded.
    if (json.license !== entry.provenance.license) throw new Error(`the input says licence ${String(json.license)}, the provenance records ${entry.provenance.license}`);
    return json.colors.map((c) => ({ name: c.name, number: c.code, hex: c.hex }));
  }
  if (inp.format === 'yarnline') {
    if (!Array.isArray(json.yarns)) throw new Error('yarnline input has no yarns array');
    return json.yarns.map((c) => ({ name: c.name, number: c.number, hex: c.hex }));
  }
  throw new Error(`unknown input.format ${String(inp.format)}`);
}

const slug = (s) =>
  String(s)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** The YarnLine file for one manifest entry (throws with the reason when it cannot be built). */
export function buildLine(entry, baseDir) {
  if (typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(entry.id)) throw new Error(`id ${String(entry.id)} must be lowercase letters, digits and dashes`);
  for (const k of ['brand', 'line']) if (typeof entry[k] !== 'string' || entry[k].trim() === '') throw new Error(`${k} is missing`);
  if (!Number.isInteger(entry.cyc) || entry.cyc < 0 || entry.cyc > 7) throw new Error('cyc must be a CYC weight 0–7');
  const rows = readInput(entry, baseDir);
  if (rows.length === 0) throw new Error('the input has no shades');
  const ids = new Set();
  const yarns = rows.map((r, i) => {
    const hex = typeof r.hex === 'string' ? r.hex.trim().toLowerCase() : '';
    if (!HEX.test(hex)) throw new Error(`shade ${i + 1} (${String(r.name)}) has hex ${String(r.hex)}, not #rrggbb`);
    if (typeof r.name !== 'string' || r.name.trim() === '') throw new Error(`shade ${i + 1} has no name`);
    const key = r.number !== undefined && String(r.number).trim() !== '' ? String(r.number).trim() : slug(r.name);
    const id = `${entry.id}:${key}`;
    if (ids.has(id)) throw new Error(`shade id ${id} is not unique`);
    ids.add(id);
    const textured = TEXTURED.test(r.name);
    const skein = entry.skeins?.[textured ? 'textured' : 'solid'];
    const y = { id, lineId: entry.id, brand: entry.brand, line: entry.line, name: r.name.trim() };
    if (r.number !== undefined && String(r.number).trim() !== '') y.number = String(r.number).trim();
    y.hex = hex;
    y.cyc = entry.cyc;
    if (skein?.yards > 0) y.skeinYards = skein.yards;
    if (skein?.grams > 0) y.skeinGrams = skein.grams;
    if (skein?.yards > 0 && skein?.grams > 0) y.ydPer100g = Math.round((skein.yards / skein.grams) * 1000) / 10;
    if (textured) y.textured = true;
    return y;
  });
  const p = entry.provenance;
  const provenance = { ...p };
  provenance.input = { file: entry.input.path, sha256: entry.input.sha256, format: entry.input.format };
  if (entry.skeins?.source) provenance.skeinSource = entry.skeins.source;
  return {
    id: entry.id,
    brand: entry.brand,
    line: entry.line,
    cyc: entry.cyc,
    source: p.source,
    license: p.license,
    attribution: p.attribution,
    provenance,
    yarns,
  };
}

/** Runs the import; returns the exit code and the messages (the CLI prints them). */
export function run(argv) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    return { code: 2, messages: [`import-yarns: ${e.message}`] };
  }
  if (o.help) return { code: 0, messages: ['usage: node scripts/import-yarns.mjs [--manifest file] [--out dir] [--check]'] };
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(o.manifest, 'utf8'));
  } catch (e) {
    return { code: 2, messages: [`import-yarns: cannot read the manifest ${o.manifest}: ${e.message}`] };
  }
  if (!Array.isArray(manifest.lines)) return { code: 2, messages: ['import-yarns: the manifest has no "lines" array'] };
  const baseDir = path.dirname(o.manifest);
  const messages = [];
  let code = 0;
  const seen = new Set();
  for (const entry of manifest.lines) {
    const name = typeof entry?.id === 'string' ? entry.id : '(no id)';
    const problems = provenanceProblems(entry);
    if (seen.has(name)) problems.push('the id is listed twice');
    seen.add(name);
    if (problems.length > 0) {
      messages.push(`import-yarns: REFUSED ${name}: ${problems.join('; ')}`);
      code = 1;
      continue;
    }
    let line;
    try {
      line = buildLine(entry, baseDir);
    } catch (e) {
      messages.push(`import-yarns: REFUSED ${name}: ${e.message}`);
      code = 1;
      continue;
    }
    const file = path.join(o.out, `${line.id}.json`);
    const text = `${JSON.stringify(line, null, 2)}\n`;
    if (o.check) {
      const current = existsSync(file) ? readFileSync(file, 'utf8') : undefined;
      if (current !== text) {
        messages.push(`import-yarns: ${path.relative(ROOT, file)} differs from the manifest's output`);
        code = 1;
      } else messages.push(`import-yarns: ${line.id} up to date (${line.yarns.length} shades)`);
    } else {
      mkdirSync(o.out, { recursive: true });
      writeFileSync(file, text);
      messages.push(`import-yarns: wrote ${path.relative(ROOT, file) || file} (${line.yarns.length} shades, ${line.license})`);
    }
  }
  return { code, messages };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { code, messages } = run(process.argv.slice(2));
  for (const m of messages) (code === 0 ? console.log : console.error)(m);
  process.exit(code);
}
