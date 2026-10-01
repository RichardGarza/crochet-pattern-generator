// Track T7 — the importer: files or pasted text → a normalized, repaired, validated crochet-model
// (DESIGN.md §3.7.1). It runs in import.worker and in the vitest node environment, so there is no DOM anywhere
// in core/importer (HTML goes through the tokenizer of §3.7.4).
//
// A single file stops at its first valid spec; an archive (zip) or several inputs collect every spec candidate
// and choose by revision (§3.7.2). Every spec then goes through the dialect normalization (§3.7.3) and the repairs
// with strict validation (§3.7.6).
import type { ImportInputsFn } from '../../types/entryPoints';
import type { ImportContext, ImportInput, ImportResult, Repair } from '../../types/importer';
import type { Issue } from '../../types/issues';
import { fnv1a64Hex } from '../kernel/hash';
import { stringifyModel } from '../model/schema';
import { checkEntryPath, chooseCandidate, ratioTooHigh, readZipDirectory, zipEntryBytes, type Candidate } from './archive';
import { baseName, extensionOf, IMPORT_CODES, IMPORT_LIMITS, ImportFailure, isPlainObject, issue, type FoundSpec } from './common';
import { detectFile, detectText, looksLikeHtml } from './detect';
import { normalizeSpec, type Dialect } from './dialect';
import { readGlbJson, specFromGltfJson } from './glb';
import { FIXUP_ADVICE, specFromHtml } from './html';
import { repairModel } from './repair';
import { decodeText, parseJsonSafe, specFromText } from './text';

type Carrier = ImportResult['carrier'];

/** What one input yielded before normalization. */
interface Scan {
  carrier: Carrier;
  found: FoundSpec[];
  /** A zip: every spec is a candidate (§3.7.2). */
  archive: boolean;
  images: ArrayBuffer[];
  fingerprint: string[];
  warnings: Issue[];
  /** Why this input gave no spec. */
  failure?: Issue;
}

const PASTED = '(pasted text)';

function unsafe(message: string): Issue {
  return issue(IMPORT_CODES.unsafe, 'error', message);
}

function forbiddenIssue(key: string, where: string): Issue {
  return unsafe(`${where} holds the key "${key}", which is never allowed (it could be an attack): nothing was read from it`);
}

/** An ArrayBuffer copy of a byte view (the frozen types are ArrayBuffer-backed, §0.1). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

// ---- carriers

function scanText(text: string, path: string): Scan {
  if (looksLikeHtml(text)) return scanHtml(text, path);
  const r = specFromText(text);
  // a pasted HTML fragment (`<three-d-stage data-crochet-model="…">`, a lone `<script>`): the tokenizer can read it
  if (!r.ok && !r.forbidden && /data-crochet-model\s*=|<script[\s>]/i.test(text)) {
    const h = scanHtml(text, path);
    if (h.found.length > 0 || h.failure?.code === IMPORT_CODES.unsafe) return h;
  }
  if (r.ok) return { carrier: 'text', found: [{ raw: r.value, source: 'chat', path, how: r.how, confidence: r.confidence }], archive: false, images: [], fingerprint: [], warnings: [] };
  const failure = r.forbidden
    ? forbiddenIssue(r.forbidden, 'the pasted spec')
    : r.error
      ? issue(IMPORT_CODES.parse, 'error', `found a crochet-model spec in the text but could not read it: ${r.error}`)
      : issue(IMPORT_CODES.noModel, 'error', `no crochet-model JSON in this text. Ask Claude to print the complete crochet-model JSON spec in one json code block and paste the whole reply. ${FIXUP_ADVICE}`);
  return { carrier: 'text', found: [], archive: false, images: [], fingerprint: [], warnings: [], failure };
}

function scanHtml(html: string, path: string, source: FoundSpec['source'] = 'html', time?: number): Scan {
  const r = specFromHtml(html);
  const carrier: Carrier = r.standalone ? 'standalone-html' : 'html';
  const found: FoundSpec[] = r.value ? [{ raw: r.value, source, path, how: r.how ?? 'html', confidence: r.confidence ?? 'medium', time }] : [];
  return { carrier, found, archive: false, images: [], fingerprint: r.fingerprint, warnings: r.warnings, failure: r.failure };
}

function scanJson(text: string, path: string): Scan {
  const base: Scan = { carrier: 'json', found: [], archive: false, images: [], fingerprint: [], warnings: [] };
  const parsed = parseJsonSafe(text.replace(/^\uFEFF/, ''));
  if (!parsed.ok && parsed.forbidden) return { ...base, failure: forbiddenIssue(parsed.forbidden, path) };
  if (parsed.ok && isPlainObject(parsed.value)) {
    const v = parsed.value;
    // §3.7.2: a `.json` is a spec when its `schema` says so
    if (v.schema === 'crochet-model') return { ...base, found: [{ raw: v, source: 'json', path, how: `JSON file (${parsed.parser})`, confidence: 'high' }] };
    if (v.format === 'crochet-project-file') {
      return { ...base, failure: issue(IMPORT_CODES.projectFile, 'error', `${baseName(path)} is a whole project saved by this app: open it from Projects → Import project`) };
    }
    if (isPlainObject(v.asset) && v.asset.version !== undefined) {
      const spec = specFromGltfJson(v);
      if (spec) return { ...base, carrier: 'gltf', found: [{ raw: spec, source: 'glb', path, how: 'glTF extras.crochetModel', confidence: 'high' }] };
      return { ...base, carrier: 'gltf', failure: issue(IMPORT_CODES.unsupported, 'error', 'this glTF file carries no crochet-model spec; reading its shapes is not available yet. Drop the project archive or paste the chat JSON instead.') };
    }
  }
  // Not a plain spec: chat-like text saved as .json, smart quotes, prose around it…
  const t = scanText(text, path);
  return { ...t, carrier: 'json', found: t.found.map((f) => ({ ...f, source: 'json' })) };
}

function scanGlb(bytes: Uint8Array, path: string, time?: number): Scan {
  const base: Scan = { carrier: 'glb', found: [], archive: false, images: [], fingerprint: [], warnings: [] };
  const g = readGlbJson(bytes);
  if (!g.ok) return { ...base, failure: g.forbidden ? forbiddenIssue(g.forbidden, path) : issue(IMPORT_CODES.parse, 'error', `${baseName(path)}: ${g.error}`) };
  const spec = specFromGltfJson(g.json);
  if (spec) return { ...base, found: [{ raw: spec, source: 'glb', path, how: 'GLB extras.crochetModel', confidence: 'high', time }] };
  return {
    ...base,
    failure: issue(IMPORT_CODES.unsupported, 'error', `${baseName(path)} carries no crochet-model spec, and reading shapes from a GLB is not available yet. Drop the project archive (.zip) or the standalone HTML, or paste the chat JSON.`),
  };
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const GEOMETRY_EXT = new Set(['obj', 'ply', 'stl', 'gltf', 'glb']);

function scanZip(bytes: Uint8Array, path: string): Scan {
  const out: Scan = { carrier: 'zip', found: [], archive: true, images: [], fingerprint: [], warnings: [] };
  const entries = readZipDirectory(bytes);
  const fingerprints = new Set<string>();
  const failures: Issue[] = [];
  const geometry: string[] = [];
  let pptx = false;
  for (const entry of entries) {
    const verdict = checkEntryPath(entry.name);
    if (!verdict.ok) {
      if (verdict.skip === 'warn') out.warnings.push(issue(IMPORT_CODES.entrySkipped, 'warn', `skipped "${entry.name}": ${verdict.reason}`));
      continue;
    }
    const name = verdict.path;
    if (name.startsWith('ppt/')) pptx = true;
    const ext = extensionOf(name);
    const lowerName = baseName(name).toLowerCase();
    const isChat = ext === 'md' && (lowerName === 'readme.md' || name.toLowerCase().split('/').includes('chats'));
    const wanted = ext === 'html' || ext === 'htm' || ext === 'json' || ext === 'gltf' || ext === 'glb' || isChat || IMAGE_EXT.has(ext);
    if (GEOMETRY_EXT.has(ext)) geometry.push(name);
    if (!wanted) continue;
    if (ratioTooHigh(entry)) {
      out.warnings.push(issue(IMPORT_CODES.entrySkipped, 'warn', `skipped "${name}": it would unpack to more than ${IMPORT_LIMITS.maxEntryRatio}× its packed size`));
      continue;
    }
    let data: Uint8Array;
    try {
      data = zipEntryBytes(bytes, entry);
    } catch (error) {
      out.warnings.push(issue(IMPORT_CODES.entrySkipped, 'warn', `skipped "${name}": ${(error as Error).message}`));
      continue;
    }
    const at = `${baseName(path)}/${name}`;
    if (ext === 'html' || ext === 'htm') {
      const s = scanHtml(decodeText(data), name, 'html', entry.time);
      s.fingerprint.forEach((f) => fingerprints.add(f));
      out.found.push(...s.found);
      out.warnings.push(...s.warnings.map((w) => ({ ...w, message: `${name}: ${w.message}` })));
      if (s.failure) failures.push({ ...s.failure, message: `${name}: ${s.failure.message}` });
    } else if (ext === 'json' || ext === 'gltf') {
      const parsed = parseJsonSafe(decodeText(data).replace(/^\uFEFF/, ''));
      if (!parsed.ok && parsed.forbidden) failures.push(forbiddenIssue(parsed.forbidden, at));
      else if (parsed.ok && isPlainObject(parsed.value) && parsed.value.schema === 'crochet-model') {
        out.found.push({ raw: parsed.value, source: 'json', path: name, how: `JSON file (${parsed.parser})`, confidence: 'high', time: entry.time });
      } else if (parsed.ok && isPlainObject(parsed.value) && isPlainObject(parsed.value.asset)) {
        const spec = specFromGltfJson(parsed.value);
        if (spec) out.found.push({ raw: spec, source: 'glb', path: name, how: 'glTF extras.crochetModel', confidence: 'high', time: entry.time });
      }
    } else if (ext === 'glb') {
      const s = scanGlb(data, name, entry.time);
      out.found.push(...s.found);
      if (s.failure?.code === IMPORT_CODES.unsafe) failures.push(s.failure);
    } else if (isChat) {
      const r = specFromText(decodeText(data));
      if (r.ok && r.how.startsWith('code fence')) out.found.push({ raw: r.value, source: 'chat', path: name, how: r.how, confidence: r.confidence, time: entry.time });
      else if (!r.ok && r.forbidden) failures.push(forbiddenIssue(r.forbidden, at));
    } else if (IMAGE_EXT.has(ext)) {
      out.images.push(toArrayBuffer(data));
    }
  }
  out.fingerprint = [...fingerprints];
  if (out.found.length === 0) {
    out.warnings.push(...failures.filter((f) => f.code !== IMPORT_CODES.noModel));
    if (pptx) out.failure = issue(IMPORT_CODES.unsupported, 'error', 'this is a PowerPoint file; reading models from slides is not available yet. Export Project HTML from Claude Design instead.');
    else if (geometry.length > 0) {
      out.failure = issue(IMPORT_CODES.unsupported, 'error', `the archive has no crochet-model spec, only shapes (${geometry.slice(0, 3).join(', ')}); reading shapes is not available yet. ${FIXUP_ADVICE}`);
    } else if (out.images.length > 0) {
      out.carrier = 'zip';
      out.failure = issue(IMPORT_CODES.noModel, 'error', 'the archive holds only pictures: start a 3D project from a photo instead');
    } else out.failure = failures.find((f) => f.code !== IMPORT_CODES.noModel) ?? issue(IMPORT_CODES.noModel, 'error', `no crochet-model spec in this archive. ${FIXUP_ADVICE}`);
  } else {
    // pages without a spec next to ones with it are worth a note, not an error
    out.warnings.push(...failures.map((f) => ({ ...f, severity: 'info' as const })));
  }
  return out;
}

function scanFile(name: string, bytes: Uint8Array): Scan {
  const kind = detectFile(name, bytes);
  const none = (carrier: Carrier, failure: Issue, images: ArrayBuffer[] = []): Scan => ({ carrier, found: [], archive: false, images, fingerprint: [], warnings: [], failure });
  switch (kind) {
    case 'zip':
      return scanZip(bytes, name);
    case 'glb':
      return scanGlb(bytes, name);
    case 'image':
      return none('image', issue(IMPORT_CODES.noModel, 'error', 'this is a picture, not a model: start a 3D project from a photo instead'), [toArrayBuffer(bytes)]);
    case 'gzip':
      return none('tar', issue(IMPORT_CODES.unsupported, 'error', 'compressed handoff bundles (.tar.gz) are not read yet: unpack it and drop the project folder’s HTML page, or export Project HTML from Claude Design'));
    case 'pdf':
      return none('text', issue(IMPORT_CODES.unsupported, 'error', 'PDF exports are not read yet. Export Project HTML from Claude Design, or paste the chat JSON.'));
    case 'obj':
    case 'mtl':
      return none('obj', issue(IMPORT_CODES.unsupported, 'error', 'reading shapes from OBJ files is not available yet. Drop the project archive (.zip) or paste the chat JSON.'));
    case 'ply':
      return none('ply', issue(IMPORT_CODES.unsupported, 'error', 'reading shapes from PLY files is not available yet.'));
    case 'stl':
      return none('stl', issue(IMPORT_CODES.unsupported, 'error', 'reading shapes from STL files is not available yet.'));
    case 'unknown':
      return none('text', issue(IMPORT_CODES.unsupported, 'error', `${name || 'this file'} is not a format this app reads`));
    default: {
      const text = decodeText(bytes);
      const k = detectText(text, name);
      if (k === 'html') return scanHtml(text, name);
      if (k === 'json' || k === 'gltf') return scanJson(text, name);
      return scanText(text, name);
    }
  }
}

function scanInput(input: ImportInput): Scan {
  if (input.kind === 'text') return scanText(input.text, PASTED);
  return scanFile(input.name, new Uint8Array(input.bytes));
}

function inputBytes(input: ImportInput): number {
  return input.kind === 'text' ? input.text.length : input.bytes.byteLength;
}

// ---- processing

interface Processed {
  ok: boolean;
  candidate?: Candidate;
  dialect: Dialect;
  repairs: Repair[];
  warnings: Issue[];
}

function processSpec(found: FoundSpec, id: string, order: number): Processed {
  try {
    const n = normalizeSpec(found.raw as Record<string, unknown>);
    const r = repairModel(n);
    if (!r.ok || !r.model) return { ok: false, dialect: n.dialect, repairs: r.repairs, warnings: r.warnings };
    const candidate: Candidate = { id, path: found.path, source: found.source, model: r.model, hash: fnv1a64Hex(stringifyModel(r.model)), time: found.time, order };
    return { ok: true, candidate, dialect: n.dialect, repairs: r.repairs, warnings: r.warnings };
  } catch (error) {
    if (error instanceof ImportFailure) return { ok: false, dialect: 'canonical-1', repairs: [], warnings: [error.issue] };
    // a bug or an input nobody foresaw: report it on this spec instead of failing the whole import
    return { ok: false, dialect: 'canonical-1', repairs: [], warnings: [unexpected(error, found.path)] };
  }
}

function unexpected(error: unknown, where: string): Issue {
  return issue(IMPORT_CODES.invalid, 'error', `${where}: this spec could not be read (${error instanceof Error ? error.message : String(error)})`);
}

function cpgTagOf(model: Record<string, unknown>): ImportResult['cpgTag'] {
  const tag = model['x-cpg'];
  if (!isPlainObject(tag) || typeof tag.project !== 'string' || typeof tag.seedRev !== 'number') return undefined;
  return { project: tag.project, seedRev: tag.seedRev };
}

function failed(carrier: Carrier, warnings: Issue[], extra: Partial<ImportResult> = {}): ImportResult {
  return { ok: false, carrier, dialect: 'canonical-1', confidence: 'low', repairs: [], warnings, fingerprint: [], ...extra };
}

/** §3.7.1: imports pasted text or dropped files into one validated model (or explains why not). */
export function importInputsSync(inputs: readonly ImportInput[], ctx: ImportContext = {}): ImportResult {
  if (inputs.length === 0) return failed('text', [issue(IMPORT_CODES.noModel, 'error', 'nothing to import')]);
  const total = inputs.reduce((s, i) => s + inputBytes(i), 0);
  if (total > IMPORT_LIMITS.maxInputBytes) {
    return failed(inputs[0].kind === 'text' ? 'text' : 'zip', [issue(IMPORT_CODES.tooLarge, 'error', `the input is larger than ${IMPORT_LIMITS.maxInputBytes / 2 ** 20} MB`)]);
  }
  const scans: Scan[] = inputs.map((input) => {
    try {
      return scanInput(input);
    } catch (error) {
      if (error instanceof ImportFailure) {
        const carrier: Carrier = input.kind === 'file' && detectFile(input.name, new Uint8Array(input.bytes)) === 'zip' ? 'zip' : 'text';
        return { carrier, found: [], archive: false, images: [], fingerprint: [], warnings: [], failure: error.issue };
      }
      return { carrier: 'text', found: [], archive: false, images: [], fingerprint: [], warnings: [], failure: unexpected(error, input.kind === 'file' ? input.name : PASTED) };
    }
  });
  const fingerprint = [...new Set(scans.flatMap((s) => s.fingerprint))];
  const scanWarnings = scans.flatMap((s) => s.warnings);
  const found = scans.flatMap((s, k) => s.found.map((f) => ({ f, scan: s, k })));
  if (found.length === 0) {
    const images = scans.flatMap((s) => s.images);
    const failures = scans.map((s) => s.failure).filter((f): f is Issue => f !== undefined);
    return failed(scans[0].carrier, [...failures, ...scanWarnings], { fingerprint, ...(images.length > 0 ? { images } : {}) });
  }

  const multi = inputs.length > 1 || scans.some((s) => s.archive);
  if (!multi) {
    const { f, scan } = found[0];
    const p = processSpec(f, f.path, 0);
    const warnings = [...scanWarnings, ...p.warnings];
    if (ctx.pickCandidate !== undefined && ctx.pickCandidate !== f.path) {
      warnings.unshift(issue(IMPORT_CODES.candidate, 'warn', `the chosen version "${ctx.pickCandidate}" is not in this import: it holds one spec`));
    }
    if (!p.ok || !p.candidate) return { ...failed(scan.carrier, warnings, { fingerprint }), dialect: p.dialect, repairs: p.repairs };
    return result(scan.carrier, p, f, warnings, fingerprint);
  }

  // an archive or several inputs: every spec is a candidate (§3.7.2)
  const usedIds = new Set<string>();
  const processed = found.map(({ f, scan, k }, order) => {
    let id = inputs.length > 1 && f.path !== PASTED ? `${k + 1}:${f.path}` : f.path;
    if (usedIds.has(id)) id = `${id}#${order + 1}`;
    usedIds.add(id);
    return { f, scan, p: processSpec(f, id, order) };
  });
  const good = processed.filter((x) => x.p.ok && x.p.candidate);
  if (good.length === 0) {
    const first = processed[0];
    return { ...failed(first.scan.carrier, [...scanWarnings, ...first.p.warnings], { fingerprint }), dialect: first.p.dialect, repairs: first.p.repairs };
  }
  const notes: Issue[] = processed
    .filter((x) => !x.p.ok)
    .map((x) => issue(IMPORT_CODES.candidate, 'warn', `${x.f.path}: its spec could not be used (${x.p.warnings.find((w) => w.severity === 'error')?.message ?? 'invalid'})`));
  const choice = chooseCandidate(
    good.map((x) => x.p.candidate as Candidate),
    ctx.pickCandidate,
  );
  if (choice.unknownPick !== undefined) notes.push(issue(IMPORT_CODES.candidate, 'warn', `the chosen version "${choice.unknownPick}" is not in this import: using rev ${choice.chosen.model.revision}`));
  const winner = good.find((x) => x.p.candidate?.id === choice.chosen.id) ?? good[0];
  const p = { ...winner.p, repairs: [...(choice.repair ? [choice.repair] : []), ...winner.p.repairs] };
  const res = result(winner.scan.carrier, p, winner.f, [...scanWarnings, ...notes, ...p.warnings], fingerprint);
  return { ...res, candidates: choice.list };
}

function result(carrier: Carrier, p: Processed, f: FoundSpec, warnings: Issue[], fingerprint: string[]): ImportResult {
  const model = (p.candidate as Candidate).model;
  const cpgTag = cpgTagOf(model as unknown as Record<string, unknown>);
  return {
    ok: true,
    model,
    carrier,
    dialect: p.dialect,
    confidence: f.confidence,
    repairs: p.repairs,
    warnings,
    fingerprint,
    ...(cpgTag ? { cpgTag } : {}),
  };
}

export const importInputs: ImportInputsFn = async (inputs, ctx) => importInputsSync(inputs, ctx);
