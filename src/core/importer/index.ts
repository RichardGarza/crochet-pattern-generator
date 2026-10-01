// Track T7 — the importer: files or pasted text → a normalized, repaired, validated crochet-model
// (DESIGN.md §3.7.1). It runs in import.worker and in the vitest node environment, so there is no DOM anywhere
// in core/importer (HTML goes through the tokenizer of §3.7.4).
//
// A single file stops at its first valid spec; an archive (zip, tar.gz) or several inputs collect every spec
// candidate and choose by revision (§3.7.2). Every spec then goes through the dialect normalization (§3.7.3) and the
// repairs with strict validation (§3.7.6). Only when no input holds a spec does the geometry fallback run, in the
// order of §3.7.2: `.glb`/`.gltf` (ladder steps 2–4) › `.obj` + `.mtl` › `.ply`/`.stl` › images.
import type { ImportInputsFn } from '../../types/entryPoints';
import type { ImportContext, ImportInput, ImportResult, Repair, UnitsDecision } from '../../types/importer';
import type { Issue } from '../../types/issues';
import { fnv1a64Hex } from '../kernel/hash';
import { stringifyModel } from '../model/schema';
import {
  checkEntryPath,
  chooseCandidate,
  gunzipLimited,
  isTar,
  ratioTooHigh,
  readTarEntries,
  readZipDirectory,
  tarEntryBytes,
  zipEntryBytes,
  type Candidate,
} from './archive';
import { baseName, extensionOf, IMPORT_CODES, IMPORT_LIMITS, ImportFailure, isPlainObject, issue, type FoundSpec } from './common';
import { detectFile, detectText, looksLikeHtml } from './detect';
import { normalizeSpec, type Dialect, type Normalized } from './dialect';
import { finishMeshes, normalizeGeometry, type GeometrySource } from './geometry';
import { GltfDoc, gltfGeometry, readGlbJson, specFromGltfJson } from './glb';
import { FIXUP_ADVICE, specFromHtml } from './html';
import { objSource, parseMtl, type Mtl } from './obj';
import { plySource, stlSource } from './plyStl';
import { repairModel, type RepairOptions } from './repair';
import { decodeText, parseJsonSafe, specFromText } from './text';

type Carrier = ImportResult['carrier'];

/** A geometry file kept for the fallback (§3.7.2), read only when no input holds a spec. */
interface GeoFile {
  kind: 'glb' | 'gltf' | 'obj' | 'mtl' | 'ply' | 'stl' | 'bin';
  /** Path inside its archive, or the file name. */
  path: string;
  read: () => Uint8Array;
  /** The carrier of the input it came from (`zip`/`tar` for an archive entry). */
  carrier: Carrier;
  /** Index of the input it came from (siblings are looked up in the same input). */
  input: number;
}

/** What one input yielded before normalization. */
interface Scan {
  carrier: Carrier;
  found: FoundSpec[];
  /** A zip or tar: every spec is a candidate (§3.7.2). */
  archive: boolean;
  images: ArrayBuffer[];
  fingerprint: string[];
  warnings: Issue[];
  /** Why this input gave no spec. */
  failure?: Issue;
  geometry: GeoFile[];
}

const PASTED = '(pasted text)';

const scanOf = (carrier: Carrier, extra: Partial<Scan> = {}): Scan => ({ carrier, found: [], archive: false, images: [], fingerprint: [], warnings: [], geometry: [], ...extra });

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
  if (r.ok) return scanOf('text', { found: [{ raw: r.value, source: 'chat', path, how: r.how, confidence: r.confidence }] });
  const failure = r.forbidden
    ? forbiddenIssue(r.forbidden, 'the pasted spec')
    : r.error
      ? issue(IMPORT_CODES.parse, 'error', `found a crochet-model spec in the text but could not read it: ${r.error}`)
      : issue(IMPORT_CODES.noModel, 'error', `no crochet-model JSON in this text. Ask Claude to print the complete crochet-model JSON spec in one json code block and paste the whole reply. ${FIXUP_ADVICE}`);
  return scanOf('text', { failure });
}

function scanHtml(html: string, path: string, source: FoundSpec['source'] = 'html', time?: number): Scan {
  const r = specFromHtml(html);
  const carrier: Carrier = r.standalone ? 'standalone-html' : 'html';
  const found: FoundSpec[] = r.value ? [{ raw: r.value, source, path, how: r.how ?? 'html', confidence: r.confidence ?? 'medium', time }] : [];
  return scanOf(carrier, { found, fingerprint: r.fingerprint, warnings: r.warnings, failure: r.failure });
}

function scanJson(text: string, path: string, input: number, bytes: Uint8Array): Scan {
  const parsed = parseJsonSafe(text.replace(/^﻿/, ''));
  if (!parsed.ok && parsed.forbidden) return scanOf('json', { failure: forbiddenIssue(parsed.forbidden, path) });
  if (parsed.ok && isPlainObject(parsed.value)) {
    const v = parsed.value;
    // §3.7.2: a `.json` is a spec when its `schema` says so
    if (v.schema === 'crochet-model') return scanOf('json', { found: [{ raw: v, source: 'json', path, how: `JSON file (${parsed.parser})`, confidence: 'high' }] });
    if (v.format === 'crochet-project-file') {
      return scanOf('json', { failure: issue(IMPORT_CODES.projectFile, 'error', `${baseName(path)} is a whole project saved by this app: open it from Projects → Import project`) });
    }
    if (isPlainObject(v.asset) && v.asset.version !== undefined) {
      const spec = specFromGltfJson(v);
      if (spec) return scanOf('gltf', { found: [{ raw: spec, source: 'glb', path, how: 'glTF extras.crochetModel', confidence: 'high' }] });
      return scanOf('gltf', { geometry: [{ kind: 'gltf', path, read: () => bytes, carrier: 'gltf', input }] });
    }
  }
  // Not a plain spec: chat-like text saved as .json, smart quotes, prose around it…
  const t = scanText(text, path);
  return { ...t, carrier: 'json', found: t.found.map((f) => ({ ...f, source: 'json' })) };
}

function scanGlb(bytes: Uint8Array, path: string, input: number, carrier: Carrier = 'glb', time?: number): Scan {
  const g = readGlbJson(bytes);
  if (!g.ok) return scanOf(carrier, { failure: g.forbidden ? forbiddenIssue(g.forbidden, path) : issue(IMPORT_CODES.parse, 'error', `${baseName(path)}: ${g.error}`) });
  const spec = specFromGltfJson(g.json);
  if (spec) return scanOf(carrier, { found: [{ raw: spec, source: 'glb', path, how: 'GLB extras.crochetModel', confidence: 'high', time }] });
  return scanOf(carrier, { geometry: [{ kind: 'glb', path, read: () => bytes, carrier, input }] });
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif']);
const GEOMETRY_EXT: ReadonlySet<string> = new Set(['obj', 'mtl', 'ply', 'stl', 'bin']);

/** One archive entry, however the archive stores it. */
interface Entry {
  name: string;
  time?: number;
  /** §3.7.6 100:1 rule (zip entries). */
  tooCompressed: boolean;
  read: () => Uint8Array;
}

/** Every entry of a zip or tar archive: spec candidates, geometry for the fallback, pictures. */
function scanEntries(entries: readonly Entry[], path: string, carrier: 'zip' | 'tar', input: number): Scan {
  const out = scanOf(carrier, { archive: true });
  const fingerprints = new Set<string>();
  const failures: Issue[] = [];
  let pptx = false;
  let projectFolder = false;
  for (const entry of entries) {
    const verdict = checkEntryPath(entry.name);
    if (!verdict.ok) {
      if (verdict.skip === 'warn') out.warnings.push(issue(IMPORT_CODES.entrySkipped, 'warn', `skipped "${entry.name}": ${verdict.reason}`));
      continue;
    }
    const name = verdict.path;
    if (name.startsWith('ppt/')) pptx = true;
    if (name.split('/').slice(0, -1).includes('project')) projectFolder = true;
    const ext = extensionOf(name);
    const lowerName = baseName(name).toLowerCase();
    const isChat = ext === 'md' && (lowerName === 'readme.md' || name.toLowerCase().split('/').includes('chats'));
    const wanted = ext === 'html' || ext === 'htm' || ext === 'json' || ext === 'gltf' || ext === 'glb' || isChat || IMAGE_EXT.has(ext);
    if (GEOMETRY_EXT.has(ext)) {
      if (entry.tooCompressed) {
        out.warnings.push(issue(IMPORT_CODES.entrySkipped, 'warn', `skipped "${name}": it would unpack to more than ${IMPORT_LIMITS.maxEntryRatio}× its packed size`));
        continue;
      }
      out.geometry.push({ kind: ext as GeoFile['kind'], path: name, read: entry.read, carrier, input });
      continue;
    }
    if (!wanted) continue;
    if (entry.tooCompressed) {
      out.warnings.push(issue(IMPORT_CODES.entrySkipped, 'warn', `skipped "${name}": it would unpack to more than ${IMPORT_LIMITS.maxEntryRatio}× its packed size`));
      continue;
    }
    let data: Uint8Array;
    try {
      data = entry.read();
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
      const parsed = parseJsonSafe(decodeText(data).replace(/^﻿/, ''));
      if (!parsed.ok && parsed.forbidden) failures.push(forbiddenIssue(parsed.forbidden, at));
      else if (parsed.ok && isPlainObject(parsed.value) && parsed.value.schema === 'crochet-model') {
        out.found.push({ raw: parsed.value, source: 'json', path: name, how: `JSON file (${parsed.parser})`, confidence: 'high', time: entry.time });
      } else if (parsed.ok && isPlainObject(parsed.value) && isPlainObject(parsed.value.asset)) {
        const spec = specFromGltfJson(parsed.value);
        if (spec) out.found.push({ raw: spec, source: 'glb', path: name, how: 'glTF extras.crochetModel', confidence: 'high', time: entry.time });
        else out.geometry.push({ kind: 'gltf', path: name, read: () => data, carrier, input });
      }
    } else if (ext === 'glb') {
      const s = scanGlb(data, name, input, carrier, entry.time);
      out.found.push(...s.found);
      out.geometry.push(...s.geometry);
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
    out.warnings.push(...failures.filter((f) => f.code !== IMPORT_CODES.noModel && f.code !== IMPORT_CODES.unsafe));
    const unsafeFailure = failures.find((f) => f.code === IMPORT_CODES.unsafe);
    if (pptx) out.failure = issue(IMPORT_CODES.unsupported, 'error', 'this is a PowerPoint file; reading models from slides is not available yet. Export Project HTML from Claude Design instead.');
    else if (unsafeFailure && out.geometry.length === 0) out.failure = unsafeFailure;
    else if (carrier === 'tar' && !projectFolder && out.geometry.length === 0) {
      // a handoff bundle exported before any design existed (05 §2.4)
      out.failure = issue(IMPORT_CODES.noModel, 'error', 'Claude was still waiting for your answer — reply in Claude Design and re-export');
    } else if (out.geometry.length === 0 && out.images.length > 0) {
      out.failure = issue(IMPORT_CODES.noModel, 'error', 'the archive holds only pictures: start a 3D project from a photo instead');
    } else out.failure = failures.find((f) => f.code !== IMPORT_CODES.noModel) ?? issue(IMPORT_CODES.noModel, 'error', `no crochet-model spec in this archive. ${FIXUP_ADVICE}`);
  } else {
    // other entries next to a spec: an unsafe one is worth a warning, a page without a spec only a remark
    for (const f of failures) {
      if (f.code === IMPORT_CODES.unsafe) out.warnings.push(issue(IMPORT_CODES.candidate, 'warn', `${f.message} (skipped)`));
      else out.warnings.push(issue(IMPORT_CODES.parseInfo, 'info', f.message));
    }
  }
  return out;
}

function scanZip(bytes: Uint8Array, path: string, input: number): Scan {
  const entries: Entry[] = readZipDirectory(bytes).map((e) => ({
    name: e.name,
    time: e.time,
    tooCompressed: ratioTooHigh(e),
    read: () => zipEntryBytes(bytes, e),
  }));
  return scanEntries(entries, path, 'zip', input);
}

function scanTar(bytes: Uint8Array, name: string, input: number): Scan {
  const entries: Entry[] = readTarEntries(bytes).map((e) => ({ name: e.name, time: e.time, tooCompressed: false, read: () => tarEntryBytes(bytes, e) }));
  return scanEntries(entries, name, 'tar', input);
}

function scanGzip(bytes: Uint8Array, name: string, input: number): Scan {
  const inner = gunzipLimited(bytes);
  if (isTar(inner)) return scanTar(inner, name, input);
  // a single gzipped file (`teddy.obj.gz`): read what is inside, once
  const innerName = name.replace(/\.(t?gz|gzip)$/i, (m) => (m.toLowerCase() === '.tgz' ? '.tar' : ''));
  if (detectFile(innerName, inner) === 'gzip') return scanOf('tar', { failure: issue(IMPORT_CODES.unsupported, 'error', `${name} is compressed twice: unpack it first`) });
  return scanFile(innerName, inner, input);
}

function scanFile(name: string, bytes: Uint8Array, input: number): Scan {
  const kind = detectFile(name, bytes);
  const none = (carrier: Carrier, failure: Issue, images: ArrayBuffer[] = []): Scan => scanOf(carrier, { images, failure });
  const geo = (k: GeoFile['kind'], carrier: Carrier): Scan => scanOf(carrier, { geometry: [{ kind: k, path: name, read: () => bytes, carrier, input }] });
  switch (kind) {
    case 'zip':
      return scanZip(bytes, name, input);
    case 'gzip':
      return scanGzip(bytes, name, input);
    case 'tar':
      if (bytes.length > IMPORT_LIMITS.maxUncompressedBytes) return none('tar', issue(IMPORT_CODES.tooLarge, 'error', `the archive is larger than ${IMPORT_LIMITS.maxUncompressedBytes / 2 ** 20} MB`));
      return scanTar(bytes, name, input);
    case 'glb':
      return scanGlb(bytes, name, input);
    case 'image':
      return none('image', issue(IMPORT_CODES.noModel, 'error', 'this is a picture, not a model: start a 3D project from a photo instead'), [toArrayBuffer(bytes)]);
    case 'pdf':
      return none('text', issue(IMPORT_CODES.unsupported, 'error', 'PDF exports are not read yet. Export Project HTML from Claude Design, or paste the chat JSON.'));
    case 'obj':
      return geo('obj', 'obj');
    case 'mtl':
      return geo('mtl', 'obj');
    case 'ply':
      return geo('ply', 'ply');
    case 'stl':
      return geo('stl', 'stl');
    case 'unknown':
      if (extensionOf(name) === 'bin') return geo('bin', 'gltf');
      return none('text', issue(IMPORT_CODES.unsupported, 'error', `${name || 'this file'} is not a format this app reads`));
    default: {
      const text = decodeText(bytes);
      const k = detectText(text, name);
      if (k === 'html') return scanHtml(text, name);
      if (k === 'json' || k === 'gltf') return scanJson(text, name, input, bytes);
      return scanText(text, name);
    }
  }
}

function scanInput(input: ImportInput, index: number): Scan {
  if (input.kind === 'text') return scanText(input.text, PASTED);
  return scanFile(input.name, new Uint8Array(input.bytes), index);
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

/** A failed import (§3.7.6: `dialect: 'none'`). */
function failed(carrier: Carrier, warnings: Issue[], extra: Partial<ImportResult> = {}): ImportResult {
  return { ok: false, carrier, dialect: 'none', confidence: 'low', repairs: [], warnings, fingerprint: [], ...extra };
}

// ---- the geometry fallback (§3.7.2: glb/gltf › obj + mtl › ply/stl)

interface GeometryRun {
  n: Normalized;
  options: RepairOptions;
  units?: UnitsDecision;
  confidence: ImportResult['confidence'];
  warnings: Issue[];
}

const GEO_ORDER: readonly GeoFile['kind'][] = ['glb', 'gltf', 'obj', 'ply', 'stl'];

function pickGeometry(files: readonly GeoFile[]): GeoFile | undefined {
  for (const kind of GEO_ORDER) {
    const f = files.find((g) => g.kind === kind);
    if (f) return f;
  }
  return undefined;
}

/** The MTL of an OBJ: the one its `mtllib` names (same input first), else the only MTL there is. */
function mtlFor(obj: GeoFile, objText: string, files: readonly GeoFile[]): { mtl?: Mtl; missing?: string } {
  const mtls = files.filter((f) => f.kind === 'mtl');
  const named = [...objText.matchAll(/^mtllib[ \t]+(.+?)\s*$/gm)].map((m) => baseName(m[1].replace(/\\/g, '/')).toLowerCase());
  const byName = (list: readonly GeoFile[]): GeoFile | undefined => list.find((f) => named.includes(baseName(f.path).toLowerCase()));
  const chosen = byName(mtls.filter((f) => f.input === obj.input)) ?? byName(mtls) ?? (mtls.length === 1 ? mtls[0] : undefined);
  if (!chosen) {
    return named.length > 0
      ? { missing: `${named[0]} (the OBJ's colors) was not dropped with it: parts are gray until you pick their yarn` }
      : {};
  }
  return { mtl: parseMtl(decodeText(chosen.read())) };
}

function runGeometry(file: GeoFile, files: readonly GeoFile[], ctx: ImportContext): GeometryRun | { failure: Issue } {
  const bytes = file.read();
  const fromSource = (src: GeometrySource, confidence: ImportResult['confidence']): GeometryRun | { failure: Issue } => {
    const g = normalizeGeometry(src, ctx);
    if ('failure' in g) return g;
    return { n: g.n, options: g.options, units: g.units, confidence, warnings: [] };
  };
  switch (file.kind) {
    case 'glb':
    case 'gltf': {
      let doc: GltfDoc;
      if (file.kind === 'glb') {
        const g = readGlbJson(bytes);
        if (!g.ok) return { failure: g.forbidden ? forbiddenIssue(g.forbidden, file.path) : issue(IMPORT_CODES.parse, 'error', `${baseName(file.path)}: ${g.error}`) };
        doc = new GltfDoc(g.json, { bin: g.bin });
      } else {
        const parsed = parseJsonSafe(decodeText(bytes).replace(/^﻿/, ''));
        if (!parsed.ok || !isPlainObject(parsed.value)) {
          return { failure: parsed.ok ? issue(IMPORT_CODES.parse, 'error', `${baseName(file.path)} is not a glTF object`) : parsed.forbidden ? forbiddenIssue(parsed.forbidden, file.path) : issue(IMPORT_CODES.parse, 'error', `${baseName(file.path)}: ${parsed.error}`) };
        }
        const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
        const sibling = (uri: string): Uint8Array | undefined => {
          const want = `${dir}${uri}`.replace(/\\/g, '/').toLowerCase();
          const hit =
            files.find((f) => f.input === file.input && f.path.toLowerCase() === want) ??
            files.find((f) => baseName(f.path).toLowerCase() === baseName(want));
          return hit?.read();
        };
        doc = new GltfDoc(parsed.value, { sibling });
      }
      const r = gltfGeometry(doc, ctx, baseName(file.path));
      if (!r.ok) return { failure: r.failure };
      return { n: r.n, options: r.options, ...(r.units ? { units: r.units } : {}), confidence: r.confidence, warnings: r.warnings };
    }
    case 'obj': {
      const text = decodeText(bytes);
      const { mtl, missing } = mtlFor(file, text, files);
      return fromSource(objSource(text, mtl, missing ? { mtlMissing: missing } : {}), 'low');
    }
    case 'ply':
      return fromSource(plySource(bytes, baseName(file.path)), 'low');
    case 'stl':
      return fromSource(stlSource(bytes, baseName(file.path)), 'low');
    default:
      return { failure: issue(IMPORT_CODES.noModel, 'error', 'nothing to read') };
  }
}

function geometryResult(file: GeoFile, files: readonly GeoFile[], ctx: ImportContext, base: { warnings: Issue[]; fingerprint: string[] }): ImportResult {
  let run: GeometryRun | { failure: Issue };
  try {
    run = runGeometry(file, files, ctx);
  } catch (error) {
    if (error instanceof ImportFailure) run = { failure: error.issue };
    else run = { failure: issue(IMPORT_CODES.parse, 'error', `${baseName(file.path)} could not be read (${error instanceof Error ? error.message : String(error)})`) };
  }
  if ('failure' in run) return failed(file.carrier, [run.failure, ...base.warnings], { fingerprint: base.fingerprint });
  const r = repairModel(run.n, run.options);
  const warnings = [...base.warnings, ...run.warnings, ...r.warnings];
  if (!r.ok || !r.model) return failed(file.carrier, warnings, { fingerprint: base.fingerprint, repairs: r.repairs, ...(run.units ? { units: run.units } : {}) });
  const meshes = finishMeshes(r.model, run.n.model.palette, r.meshes);
  const cpgTag = cpgTagOf(r.model as unknown as Record<string, unknown>);
  return {
    ok: true,
    model: r.model,
    ...(meshes ? { meshes } : {}),
    carrier: file.carrier,
    dialect: run.n.dialect,
    confidence: run.confidence,
    repairs: r.repairs,
    warnings,
    fingerprint: base.fingerprint,
    ...(run.units ? { units: run.units } : {}),
    ...(cpgTag ? { cpgTag } : {}),
  };
}

/** §3.7.1: imports pasted text or dropped files into one validated model (or explains why not). */
export function importInputsSync(inputs: readonly ImportInput[], ctx: ImportContext = {}): ImportResult {
  if (inputs.length === 0) return failed('text', [issue(IMPORT_CODES.noModel, 'error', 'nothing to import')]);
  const total = inputs.reduce((s, i) => s + inputBytes(i), 0);
  if (total > IMPORT_LIMITS.maxInputBytes) {
    return failed(inputs[0].kind === 'text' ? 'text' : 'zip', [issue(IMPORT_CODES.tooLarge, 'error', `the input is larger than ${IMPORT_LIMITS.maxInputBytes / 2 ** 20} MB`)]);
  }
  const scans: Scan[] = inputs.map((input, index) => {
    try {
      return scanInput(input, index);
    } catch (error) {
      if (error instanceof ImportFailure) {
        const kind = input.kind === 'file' ? detectFile(input.name, new Uint8Array(input.bytes)) : 'text';
        return scanOf(kind === 'zip' ? 'zip' : kind === 'gzip' || kind === 'tar' ? 'tar' : 'text', { failure: error.issue });
      }
      return scanOf('text', { failure: unexpected(error, input.kind === 'file' ? input.name : PASTED) });
    }
  });
  const fingerprint = [...new Set(scans.flatMap((s) => s.fingerprint))];
  const scanWarnings = scans.flatMap((s) => s.warnings);
  const found = scans.flatMap((s, k) => s.found.map((f) => ({ f, scan: s, k })));
  if (found.length === 0) {
    // no spec anywhere: the geometry fallback (§3.7.2), then pictures
    const geometry = scans.flatMap((s) => s.geometry);
    const file = pickGeometry(geometry);
    const failures = scans.map((s) => s.failure).filter((f): f is Issue => f !== undefined);
    if (file) return geometryResult(file, geometry, ctx, { warnings: [...failures.filter((f) => f.code === IMPORT_CODES.unsafe), ...scanWarnings], fingerprint });
    if (geometry.some((g) => g.kind === 'mtl')) failures.unshift(issue(IMPORT_CODES.noModel, 'error', 'an .mtl file only holds colors: drop it together with its .obj file'));
    else if (geometry.some((g) => g.kind === 'bin')) failures.unshift(issue(IMPORT_CODES.noModel, 'error', 'a .bin file only holds the data of a .gltf: drop it together with its .gltf file'));
    const images = scans.flatMap((s) => s.images);
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
    if (!p.ok || !p.candidate) return failed(scan.carrier, warnings, { fingerprint, repairs: p.repairs });
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
    return failed(first.scan.carrier, [...scanWarnings, ...first.p.warnings], { fingerprint, repairs: first.p.repairs });
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
