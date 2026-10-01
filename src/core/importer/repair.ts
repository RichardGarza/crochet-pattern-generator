// Track T7 — the repairs of DESIGN.md §3.7.6, run for every carrier after dialect normalization, in this order:
// security and limits → ids → unknown keys → units → radians → ground and axes → colors → dims and attach validity
// → rounding → inferAttach → (nameParts for the generic ids of geometry-only carriers, §3.7.5) → inferMirrorPairs →
// strict schema validation. Each repair is logged as one "auto-corrected" chip; findings that are not corrections
// are `Issue` warnings.
import type { ColoredMesh } from '../../types/geometry';
import type { Repair } from '../../types/importer';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1, Feature, PaletteColor, Part, Region } from '../../types/model';
import { deltaE00Hex } from '../kernel/color';
import { GAP_WARN_IN, inferAttach, inferMirrorPairs } from '../model/attach';
import { COLOR_ID_PATTERN, PART_ID_PATTERN, validateModel } from '../model/schema';
import { MODEL_LIMITS } from '../model/limits';
import { nameParts } from '../model/naming';
import { scaleModel } from '../model/scale';
import { surfaceGap } from '../model/sdf';
import { boundsSize, groundModel, localBounds, modelBounds, modelHeight, roundCoord, roundModel } from '../model/transforms';
import { depthOf, IMPORT_CODES, isPlainObject, issue, lookup, type RepairLog } from './common';
import { colorSlug, colorValueToHex, dedupeId, normalizeHex, num, type Normalized } from './dialect';

export interface Repaired {
  ok: boolean;
  /** The validated model (only when `ok`). */
  model?: CrochetModelV1;
  /** The buffers of mesh parts by `meshRef` (geometry carriers), scaled with the model when it was. */
  meshes?: Record<string, ColoredMesh>;
  repairs: Repair[];
  warnings: Issue[];
}

/** What a geometry-only carrier (§3.7.5) changes in the repairs. */
export interface GeometryRepairOptions {
  /**
   * Run `nameParts` between `inferAttach` and `inferMirrorPairs` (the ids are generic: `part_1`, `Mesh_0`, …).
   * Ids in `keepIds` keep their names.
   */
  name: boolean;
  keepIds?: ReadonlySet<string>;
  /** `inferMirrorPairs` tolerance: fitted or measured twins are never exact (§2.9.7 step 5 uses 10%). */
  mirrorTolerance?: number;
}

export interface RepairOptions {
  /**
   * A geometry-only carrier: its units were decided before fitting (§3.7.5, with their own `units` chip), so the
   * units step only records the measured height.
   */
  geometry?: GeometryRepairOptions;
  /** The units were decided by the carrier with their own chip (GLB ladder step 3): only record the height. */
  unitsDecided?: boolean;
  /** Mesh parts' buffers by `meshRef` (scaled together with the model by the height limit). */
  meshes?: Record<string, ColoredMesh>;
}

const L = MODEL_LIMITS;
/** Default stitches per inch for `MIN_FEATURE_IN` when the spec names no yarn (worsted, §3.4). */
const DEFAULT_STS_PER_IN = 5.1;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };
type DraftPart = Mutable<Part> & Record<string, unknown>;
type Draft = Omit<Mutable<CrochetModelV1>, 'parts'> & { parts: DraftPart[] } & Record<string, unknown>;

// ---- 1. limits

/** Every `n`-th point so at most `max` remain, the first and last kept. */
function decimate<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const out: T[] = [];
  for (let k = 0; k < max; k++) out.push(points[Math.round((k * (points.length - 1)) / (max - 1))]);
  return out;
}

function clipText(value: unknown): unknown {
  return typeof value === 'string' && value.length > L.maxTextChars ? value.slice(0, L.maxTextChars) : value;
}

function applyLimits(m: Draft, log: RepairLog): void {
  const limit = (message: string, part?: string, data?: Record<string, unknown>): void =>
    log.add('limits', { code: 'limits', message, ...(part ? { part } : {}), ...(data ? { data } : {}) });
  if (m.parts.length > L.maxParts) {
    limit(`${m.parts.length} parts: only the first ${L.maxParts} were kept`, undefined, { dropped: m.parts.slice(L.maxParts).map((p) => p.id) });
    m.parts = m.parts.slice(0, L.maxParts);
  }
  if (Array.isArray(m.features) && m.features.length > L.maxFeatures) {
    limit(`${m.features.length} features: only the first ${L.maxFeatures} were kept`);
    m.features = m.features.slice(0, L.maxFeatures);
  }
  for (const p of m.parts) {
    if (Array.isArray(p.regions) && p.regions.length > L.maxRegionsPerPart) {
      limit(`${p.id}: ${p.regions.length} color regions, only the first ${L.maxRegionsPerPart} were kept`, p.id);
      p.regions = p.regions.slice(0, L.maxRegionsPerPart);
    }
    const dims = p.dims as Record<string, unknown>;
    if (p.type === 'lathe' && Array.isArray(dims.profile) && dims.profile.length > L.maxProfilePoints) {
      limit(`${p.id}: its profile had ${dims.profile.length} points, thinned to ${L.maxProfilePoints}`, p.id);
      dims.profile = decimate(dims.profile, L.maxProfilePoints);
      delete dims.sharp;
    }
    if (p.type === 'flat' && Array.isArray(dims.points) && dims.points.length > L.maxPolygonPoints) {
      limit(`${p.id}: its outline had ${dims.points.length} points, thinned to ${L.maxPolygonPoints}`, p.id);
      dims.points = decimate(dims.points, L.maxPolygonPoints);
    }
    for (const k of ['label', 'notes'] as const) {
      const v = p[k];
      if (typeof v === 'string' && v.length > L.maxTextChars) {
        limit(`${p.id}: its ${k} was cut to ${L.maxTextChars} characters`, p.id);
        p[k] = clipText(v) as string;
      }
    }
  }
  for (const k of ['name', 'description'] as const) {
    const v = m[k];
    if (typeof v === 'string' && v.length > L.maxTextChars) {
      limit(`the model's ${k} was cut to ${L.maxTextChars} characters`);
      m[k] = clipText(v) as string;
    }
  }
  if (Array.isArray(m.assumptions) && m.assumptions.some((a) => a.length > L.maxTextChars)) {
    limit(`long notes were cut to ${L.maxTextChars} characters`);
    m.assumptions = m.assumptions.map((a) => clipText(a) as string);
  }
  for (const c of m.palette) if (typeof c.name === 'string' && c.name.length > L.maxTextChars) c.name = clipText(c.name) as string;
  // extension values that are too deep or too large to keep (the document limits of §3.5.2)
  const dropExtension = (owner: Record<string, unknown>, key: string, why: string, part?: string): void => {
    delete owner[key];
    limit(`extension "${key}"${part ? ` of ${part}` : ''} removed: ${why}`, part);
  };
  const extensionOwners: [Record<string, unknown>, number, string | undefined][] = [[m, 1, undefined], ...m.parts.map((p): [Record<string, unknown>, number, string] => [p, 3, p.id])];
  for (const [owner, depth, part] of extensionOwners) {
    for (const key of Object.keys(owner)) {
      if (key.startsWith('x-') && depth + depthOf(owner[key]) > L.maxDepth) dropExtension(owner, key, `nested deeper than ${L.maxDepth} levels`, part);
    }
  }
  const size = (): number => new TextEncoder().encode(JSON.stringify(m)).length;
  if (size() > L.maxBytes) {
    const extensions = extensionOwners
      .flatMap(([owner, , part]) => Object.keys(owner).filter((k) => k.startsWith('x-')).map((k) => ({ owner, k, part, bytes: JSON.stringify(owner[k])?.length ?? 0 })))
      .sort((a, b) => b.bytes - a.bytes);
    for (const e of extensions) {
      if (size() <= L.maxBytes) break;
      dropExtension(e.owner, e.k, `the model would be larger than ${L.maxBytes / 2 ** 20} MB`, e.part);
    }
  }
}

// ---- 2. ids

/** A part or feature id: lower case, `[a-z0-9_]`, starting with a letter, ≤ 32 characters. */
export function partSlug(text: string): string {
  let s = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (s !== '' && !/^[a-z]/.test(s)) s = `p_${s}`;
  return s.slice(0, 32).replace(/_+$/, '');
}

/** `X_l` → `X_r`, `X_left` → `X_right`, `X_l_inner` → `X_r_inner` (the last side token); null without one. */
/** Left side tokens and their right twins (`leftTwinId` of attach.ts reads them the other way). */
const RIGHT_OF: Readonly<Record<string, string>> = { l: 'r', left: 'right', fl: 'fr', bl: 'br' };

export function rightTwinId(id: string): string | null {
  const tokens = id.split('_');
  for (let i = tokens.length - 1; i >= 1; i--) {
    const twin = lookup(RIGHT_OF, tokens[i]);
    if (twin) {
      tokens[i] = twin;
      return tokens.join('_');
    }
  }
  return null;
}

const MIRROR_NOTE = /\b(mirror(ed)?|pair(ed)?|both sides|each side|two of (these|them))\b/i;

function fixIds(m: Draft, log: RepairLog): void {
  // palette ids
  const colorRename = new Map<string, string>();
  const takenColors = new Set<string>();
  for (const c of m.palette) {
    const old = String(c.id ?? '');
    let id = COLOR_ID_PATTERN.test(old) && !takenColors.has(old) ? old : '';
    if (!id) {
      id = dedupeId(COLOR_ID_PATTERN.test(old) ? old : colorSlug(old || c.name || 'color'), takenColors, 16);
      log.add('id', { code: 'id', message: `palette color "${old}" renamed "${id}"`, data: { from: old, to: id } });
    }
    if (!colorRename.has(old)) colorRename.set(old, id);
    takenColors.add(id);
    c.id = id;
  }
  const recolor = (v: unknown): unknown => (typeof v === 'string' && colorRename.has(v) ? colorRename.get(v) : v);
  for (const p of m.parts) {
    p.color = recolor(p.color) as string;
    if (Array.isArray(p.regions)) {
      for (const r of p.regions as unknown[]) {
        if (!isPlainObject(r)) continue;
        if ('color' in r) r.color = recolor(r.color);
        if (Array.isArray(r.colors)) r.colors = r.colors.map(recolor);
      }
    }
  }
  if (Array.isArray(m.features)) for (const f of m.features as unknown[]) if (isPlainObject(f) && 'color' in f) f.color = recolor(f.color);

  // part ids
  const rename = new Map<string, string>();
  const taken = new Set<string>();
  m.parts.forEach((p, i) => {
    const old = p.id;
    let id = PART_ID_PATTERN.test(old) && !taken.has(old) ? old : '';
    if (!id) {
      const base = (PART_ID_PATTERN.test(old) ? old : partSlug(old)) || partSlug(typeof p.label === 'string' ? p.label : '') || `part_${i + 1}`;
      id = dedupeId(base, taken, 32);
      log.add('id', {
        code: 'id',
        message: old ? `part id "${old}" ${taken.has(old) ? 'is used twice' : 'is not a valid id'}: renamed "${id}"` : `a part without an id is now "${id}"`,
        part: id,
        data: { from: old, to: id },
      });
    }
    if (old && !rename.has(old)) rename.set(old, id);
    taken.add(id);
    p.id = id;
  });
  const ref = (v: unknown): unknown => (typeof v === 'string' && rename.has(v) ? rename.get(v) : v);
  for (const p of m.parts) {
    if (p.attach) p.attach = { ...p.attach, to: ref(p.attach.to) as string };
    if (p.mirrorOf !== undefined) p.mirrorOf = ref(p.mirrorOf) as string;
  }
  if (Array.isArray(m.assembly)) for (const a of m.assembly) Object.assign(a, { part: ref(a.part), ...(a.to !== undefined ? { to: ref(a.to) } : {}) });

  // feature ids
  if (Array.isArray(m.features)) {
    const takenF = new Set<string>();
    (m.features as unknown[]).forEach((f, i) => {
      if (!isPlainObject(f)) return;
      f.on = ref(f.on);
      const old = typeof f.id === 'string' ? f.id : '';
      let id = PART_ID_PATTERN.test(old) && !takenF.has(old) ? old : '';
      if (!id) {
        id = dedupeId(partSlug(old) || partSlug(String(f.kind ?? '')) || `feature_${i + 1}`, takenF, 32);
        log.add('id', { code: 'id', message: old ? `feature id "${old}" renamed "${id}"` : `a feature without an id is now "${id}"`, data: { from: old, to: id } });
      }
      takenF.add(id);
      f.id = id;
    });
  }

  // `*_l` that says it is one of a pair, with no `*_r`: synthesize the mirror (§3.7.6, a `part-added` chip)
  for (const p of [...m.parts]) {
    const twin = rightTwinId(p.id);
    if (!twin || taken.has(twin)) continue;
    const saysPair = (p.mirrorOf !== undefined && (p.mirrorOf === twin || p.mirrorOf === p.id)) || (typeof p.notes === 'string' && MIRROR_NOTE.test(p.notes));
    if (!saysPair) continue;
    if (m.parts.length >= L.maxParts) {
      log.add('limits', { code: 'limits', message: `${twin} was not added as the mirror of ${p.id}: the model already has ${L.maxParts} parts`, part: p.id });
      continue;
    }
    if (p.mirrorOf === twin || p.mirrorOf === p.id) delete p.mirrorOf;
    const [x, y, z] = p.position;
    const copy: DraftPart = { ...structuredClone(p), id: twin, position: [-x, y, z], mirrorOf: p.id };
    if (p.rotationDeg) copy.rotationDeg = [p.rotationDeg[0], -p.rotationDeg[1], -p.rotationDeg[2]];
    if (typeof p.label === 'string') copy.label = p.label.replace(/\bleft\b/i, (w) => (w[0] === 'L' ? 'Right' : 'right'));
    if (p.attach) {
      const to = rightTwinId(p.attach.to);
      copy.attach = { ...p.attach, to: to && taken.has(to) ? to : p.attach.to };
    }
    delete copy.paint;
    m.parts.splice(m.parts.indexOf(p) + 1, 0, copy);
    taken.add(twin);
    log.add('id', { code: 'part-added', message: `${twin} added as the mirror image of ${p.id}`, part: twin, data: { mirrorOf: p.id } });
  }
}

// ---- 3. unknown keys inside regions and features (the model and parts were cleaned by the dialect step)

const REGION_KEYS: Record<Region['kind'], readonly string[]> = {
  band: ['kind', 'from', 'to', 'color'],
  stripes: ['kind', 'from', 'to', 'colors', 'widthIn'],
  patch: ['kind', 'azimuthDeg', 'spanDeg', 'from', 'to', 'color'],
  spot: ['kind', 'azimuthDeg', 'elevationDeg', 'radiusIn', 'color'],
  pattern: ['kind', 'pattern', 'colors', 'scaleIn', 'coverage', 'from', 'to'],
};
const FEATURE_KINDS: readonly Feature['kind'][] = ['safety_eye', 'embroidered_eye', 'felt', 'nose', 'mouth', 'cheek', 'brow', 'whiskers', 'line', 'applique'];
const FEATURE_ALIASES: Readonly<Record<string, Feature['kind']>> = { eye: 'safety_eye', eyes: 'safety_eye', eyebrow: 'brow', smile: 'mouth', blush: 'cheek', whisker: 'whiskers' };
const FEATURE_KEYS = ['id', 'kind', 'on', 'azimuthDeg', 'elevationDeg', 'sizeMm', 'sizeIn', 'color', 'path', 'mirror'];

function cleanRegionsAndFeatures(m: Draft, log: RepairLog): void {
  const unknown = (message: string, part?: string, key?: string): void =>
    log.add('unknown-key', { code: 'unknown-key', message, ...(part ? { part } : {}), ...(key ? { data: { key } } : {}) });
  for (const p of m.parts) {
    if (!Array.isArray(p.regions)) continue;
    const kept: Region[] = [];
    for (const r of p.regions as unknown[]) {
      if (!isPlainObject(r) || typeof r.kind !== 'string' || !Object.hasOwn(REGION_KEYS, r.kind)) {
        unknown(`${p.id}: a color region of unknown kind "${isPlainObject(r) ? String(r.kind) : typeof r}" removed`, p.id);
        continue;
      }
      const allowed = REGION_KEYS[r.kind as Region['kind']];
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(r)) {
        if (allowed.includes(k)) out[k] = typeof v === 'string' || Array.isArray(v) || k === 'kind' ? v : (num(v) ?? v);
        else unknown(`unknown key "${k}" in a ${r.kind} region of ${p.id} removed`, p.id, k);
      }
      kept.push(out as unknown as Region);
    }
    if (kept.length > 0) p.regions = kept;
    else delete p.regions;
  }
  if (!Array.isArray(m.features)) return;
  const kept: Feature[] = [];
  for (const f of m.features as unknown[]) {
    if (!isPlainObject(f)) continue;
    const rawKind = typeof f.kind === 'string' ? f.kind.trim().toLowerCase() : '';
    const kind = (FEATURE_KINDS as readonly string[]).includes(rawKind) ? (rawKind as Feature['kind']) : lookup(FEATURE_ALIASES, rawKind);
    if (!kind) {
      log.add('dims', { code: 'feature-dropped', message: `feature ${String(f.id)} of unknown kind "${rawKind}" removed`, data: { id: f.id, kind: rawKind } });
      continue;
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(f)) {
      if (FEATURE_KEYS.includes(k)) out[k] = typeof v === 'number' || typeof v !== 'string' || ['id', 'on', 'color', 'kind'].includes(k) ? v : (num(v) ?? v);
      else unknown(`unknown key "${k}" in feature ${String(f.id)} removed`, undefined, k);
    }
    out.kind = kind;
    kept.push(out as unknown as Feature);
  }
  m.features = kept;
  if (kept.length === 0) delete m.features;
}

// ---- 4. units

const UNIT_PER_INCH = { cm: 2.54, mm: 25.4, m: 0.0254 } as const;
const UNIT_TOLERANCE = 0.15;

/** `scaleModel` without touching `finishedSize.width/depth` or `sizeMm` (millimeters stay millimeters). */
function rescale(m: Draft, factor: number): Draft {
  const keep = m.finishedSize;
  const sizesMm = (m.features ?? []).map((f) => f.sizeMm);
  const scaled = scaleModel({ ...m, finishedSize: { ...keep, height: keep.height ?? 1 } } as CrochetModelV1, factor).model as unknown as Draft;
  scaled.finishedSize = keep;
  if (scaled.features) scaled.features = scaled.features.map((f, i) => ({ ...f, sizeMm: sizesMm[i] }));
  if (scaled.features) for (const f of scaled.features) if (f.sizeMm === undefined) delete f.sizeMm;
  return scaled;
}

function fixUnits(m0: Draft, n: Normalized, log: RepairLog, geometry: boolean): Draft {
  let m = m0;
  if (m.parts.length === 0) return m;
  if (geometry) {
    // §3.7.6: geometry carriers are already in inches (their units chip says how they were read)
    const h = modelHeight(m as unknown as CrochetModelV1);
    if (h > 0 && Number.isFinite(h)) m.finishedSize = { ...m.finishedSize, height: h };
    return m;
  }
  let stated = n.noStatedHeight ? undefined : m.finishedSize.height;
  const declared = n.declaredUnit;
  if (declared) {
    const k = UNIT_PER_INCH[declared];
    m = rescale(m, 1 / k);
    let message = `the spec says its lengths are in ${declared}: converted to inches`;
    if (stated !== undefined) {
      // a finished size already in inches next to geometry in `declared` is common: keep it when it fits
      const inInches = Math.abs(Math.log(modelHeight(m) / stated)) <= Math.log(1 + UNIT_TOLERANCE);
      if (inInches) message += ` (its finished height of ${stated} in already was in inches)`;
      else {
        stated /= k;
        if (m.finishedSize.width !== undefined) m.finishedSize.width /= k;
        if (m.finishedSize.depth !== undefined) m.finishedSize.depth /= k;
      }
    }
    log.add('units', { code: 'units', message, data: { unit: declared } });
  }
  if (stated !== undefined && !(stated > 0 && stated <= L.maxHeightIn)) {
    log.add('units', { code: 'units', message: `the stated finished height (${stated} in) is outside 0–${L.maxHeightIn} in: ignored`, data: { statedHeightIn: stated } });
    stated = undefined;
  }
  const measured = modelHeight(m);
  if (!(measured > 0) || !Number.isFinite(measured)) return m;
  if (stated === undefined) {
    m.finishedSize = { ...m.finishedSize, height: measured };
    log.add('units', {
      code: 'units',
      message: `no usable finished height was given: the model measures ${roundCoord(measured, 2)} in tall`,
      data: { measuredHeightIn: roundCoord(measured, 4) },
    });
    return m;
  }
  const ratio = measured / stated;
  // after a declared unit the geometry is in inches: only the plain rescale rule is left
  const unit = declared
    ? undefined
    : (Object.keys(UNIT_PER_INCH) as (keyof typeof UNIT_PER_INCH)[]).find((u) => Math.abs(Math.log(ratio / UNIT_PER_INCH[u])) <= Math.log(1 + UNIT_TOLERANCE));
  if (unit) {
    m = rescale(m, 1 / UNIT_PER_INCH[unit]);
    const after = modelHeight(m);
    log.add('units', {
      code: 'units',
      message: `read as ${unit === 'm' ? 'meters' : unit}: ${roundCoord(measured, 3)} → ${roundCoord(after, 2)} in tall (it says ${stated} in)`,
      data: { unit, rawHeight: roundCoord(measured, 4), heightIn: roundCoord(after, 4), statedHeightIn: stated },
    });
    m.finishedSize = { ...m.finishedSize, height: after };
  } else if (Math.abs(ratio - 1) > UNIT_TOLERANCE) {
    m = rescale(m, stated / measured);
    log.add('units', {
      code: 'units',
      message: `the model measured ${roundCoord(measured, 2)} in tall but says ${stated} in: scaled to ${stated} in`,
      data: { statedHeightIn: stated, measuredHeightIn: roundCoord(measured, 4), factor: roundCoord(stated / measured, 6) },
    });
    m.finishedSize = { ...m.finishedSize, height: modelHeight(m) };
  } else {
    m.finishedSize = { ...m.finishedSize, height: measured };
    log.add('units', {
      code: 'units',
      message: `the model measures ${roundCoord(measured, 2)} in tall (it says ${stated} in): kept as it is`,
      data: { statedHeightIn: stated, measuredHeightIn: roundCoord(measured, 4) },
    });
  }
  return m;
}

/** §3.5.2: a model taller than 60 in is scaled down to 60 in (after the units step, so never a unit mix-up). */
function capHeight(m0: Draft, log: RepairLog, meshes: { value?: Record<string, ColoredMesh> }): Draft {
  const h = modelHeight(m0 as unknown as CrochetModelV1);
  if (!(h > L.maxHeightIn)) return m0;
  const m = rescale(m0, L.maxHeightIn / h);
  if (meshes.value) meshes.value = scaleModel(m0 as unknown as CrochetModelV1, L.maxHeightIn / h, meshes.value).meshes;
  m.finishedSize = { ...m.finishedSize, height: modelHeight(m) };
  log.add('limits', { code: 'limits', message: `the model is ${roundCoord(h, 1)} in tall: scaled down to the ${L.maxHeightIn} in limit`, data: { heightIn: roundCoord(h, 4) } });
  return m;
}

// ---- 6. ground and axes

/** Below this a grounding shift is rounding noise (positions are rounded to 1e-6 in): nothing is moved. */
const GROUND_EPS = 1e-6;

function ground(m: Draft, log: RepairLog): Draft {
  const g = groundModel(m as unknown as CrochetModelV1);
  if (!(Math.abs(g.dy) >= GROUND_EPS)) return m;
  log.add('ground', {
    code: 'ground',
    message: `moved ${g.dy > 0 ? 'up' : 'down'} by ${roundCoord(Math.abs(g.dy), 4)} in so the lowest point is at y = 0`,
    data: { dy: roundCoord(g.dy, 4) },
  });
  return g.model as unknown as Draft;
}

function offerAxes(m: Draft, log: RepairLog): void {
  if (m.flatBase !== true || m.parts.length === 0) return;
  const [sx, sy, sz] = boundsSize(modelBounds(m as unknown as CrochetModelV1));
  if (sz > sy && sz >= sx) {
    log.add('axes', {
      code: 'axes',
      message: 'this model is tallest along Z although it has a flat base: it may be lying on its back. Turn it −90° about X?',
      data: { offer: true, rotationDeg: [-90, 0, 0] },
    });
  }
}

// ---- 7. colors

/** A few color names Claude may write instead of a palette id, for the nearest-color repair. */
const NAMED_COLORS: Readonly<Record<string, string>> = {
  black: '#000000', white: '#ffffff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', red: '#ff0000',
  maroon: '#800000', orange: '#ffa500', yellow: '#ffff00', gold: '#ffd700', green: '#008000', lime: '#00ff00',
  olive: '#808000', teal: '#008080', cyan: '#00ffff', blue: '#0000ff', navy: '#000080', purple: '#800080',
  violet: '#ee82ee', lavender: '#e6e6fa', pink: '#ffc0cb', magenta: '#ff00ff', brown: '#8b4513', tan: '#d2b48c',
  beige: '#f5f5dc', cream: '#fffdd0', ivory: '#fffff0', caramel: '#af6f37', chocolate: '#d2691e', coral: '#ff7f50',
  peach: '#ffdab9', mint: '#98ff98', sky: '#87ceeb', charcoal: '#36454f', rose: '#ff007f',
};

function fixColors(m: Draft, dialect: Normalized['dialect'], log: RepairLog): void {
  const palette = m.palette as Mutable<PaletteColor>[];
  for (const c of palette) c.hex = normalizeHex(c.hex) ?? '#cccccc';
  const taken = new Set(palette.map((c) => c.id));
  const byHex = (hex: string): PaletteColor | undefined => palette.find((c) => c.hex.toLowerCase() === hex.toLowerCase());
  const add = (hex: string, name?: string): string => {
    const id = dedupeId(name ? colorSlug(name) : `c_${hex.slice(1).toLowerCase()}`, taken, 16);
    taken.add(id);
    palette.push(name ? { id, hex, name } : { id, hex });
    return id;
  };
  const nearest = (hex: string): { c: PaletteColor; de: number } | undefined => {
    let best: { c: PaletteColor; de: number } | undefined;
    for (const c of palette) {
      const de = deltaE00Hex(hex, c.hex);
      if (!best || de < best.de) best = { c, de };
    }
    return best;
  };
  const main = (): PaletteColor | undefined => palette.find((c) => c.role === 'main') ?? palette[0];
  const chip = (message: string, part?: string, data?: Record<string, unknown>): void =>
    log.add('color', { code: 'color', message, ...(part ? { part } : {}), ...(data ? { data } : {}) });

  const resolve = (value: unknown, where: string, part?: string): string => {
    const v = typeof value === 'string' ? value.trim() : '';
    if (v && taken.has(v)) return v;
    const hex = colorValueToHex(value);
    if (hex) {
      const hit = byHex(hex);
      if (hit) {
        if (dialect === 'canonical-1') chip(`${where}: color ${hex} is palette color ${hit.id}`, part, { from: hex, to: hit.id });
        return hit.id;
      }
      const id = add(hex);
      chip(`${where}: color ${hex} was not in the palette: added as ${id}`, part, { hex, to: id });
      return id;
    }
    if (v) {
      const lower = v.toLowerCase();
      const byName =
        palette.find((c) => c.id.toLowerCase() === lower) ??
        palette.find((c) => c.id === colorSlug(v)) ??
        palette.find((c) => (c.name ?? '').toLowerCase() === lower) ??
        palette.find((c) => colorSlug(c.name ?? '') === colorSlug(v));
      if (byName) {
        chip(`${where}: color "${v}" read as palette color ${byName.id}`, part, { from: v, to: byName.id });
        return byName.id;
      }
      const named = lookup(NAMED_COLORS, lower) ?? lookup(NAMED_COLORS, lower.split(/[\s_-]+/).find((w) => Object.hasOwn(NAMED_COLORS, w)) ?? '');
      if (named) {
        const near = nearest(named);
        if (near) {
          chip(`${where}: unknown color "${v}": using the nearest palette color, ${near.c.id} (ΔE ${roundCoord(near.de, 1)})`, part, { from: v, to: near.c.id });
          return near.c.id;
        }
        const id = add(named, v);
        chip(`${where}: color "${v}" added to the palette as ${id}`, part, { from: v, to: id });
        return id;
      }
    }
    const fallback = main();
    if (fallback) {
      chip(`${where}: unknown color ${v ? `"${v}"` : '(none)'}: using ${fallback.id}`, part, { from: v, to: fallback.id });
      return fallback.id;
    }
    const id = add('#9e9e9e', 'gray');
    chip(`${where}: no colors at all: added gray`, part, { from: v, to: id });
    return id;
  };

  for (const p of m.parts) {
    p.color = resolve(p.color, p.id, p.id);
    if (Array.isArray(p.regions)) {
      for (const r of p.regions as Mutable<Region>[]) {
        if (r.kind === 'stripes' || r.kind === 'pattern') r.colors = (Array.isArray(r.colors) ? r.colors : [r.colors]).map((c) => resolve(c, `${p.id} ${r.kind}`, p.id));
        else r.color = resolve(r.color, `${p.id} ${r.kind}`, p.id);
      }
    }
  }
  for (const f of (m.features ?? []) as Mutable<Feature>[]) if (f.color !== undefined) f.color = resolve(f.color, `feature ${f.id}`);

  // the palette limit: unused colors go first, then the least used merge into their nearest neighbor
  if (palette.length > L.maxPalette) {
    const uses = new Map<string, number>(palette.map((c) => [c.id, 0]));
    const count = (id: string | undefined): void => {
      if (id !== undefined) uses.set(id, (uses.get(id) ?? 0) + 1);
    };
    for (const p of m.parts) {
      count(p.color);
      for (const r of (p.regions ?? []) as Region[]) for (const c of r.kind === 'stripes' || r.kind === 'pattern' ? r.colors : [r.color]) count(c);
    }
    for (const f of m.features ?? []) count(f.color);
    // keep the most used colors (ties: earlier in the palette); unused ones go, the other extras merge into the
    // nearest kept color by ΔE00 — one chip for each kind, so a huge palette cannot flood the chips
    const order = palette.map((c, i) => ({ c, i, n: uses.get(c.id) ?? 0 })).sort((x, y) => y.n - x.n || x.i - y.i);
    const kept = order.slice(0, L.maxPalette).map((x) => x.c);
    const dropped = order.slice(L.maxPalette);
    const unused = dropped.filter((x) => x.n === 0).map((x) => x.c.id);
    const remap = new Map<string, string>();
    for (const { c, n } of dropped) {
      if (n === 0) continue;
      let best = kept[0];
      let de = Infinity;
      for (const k of kept) {
        const d = deltaE00Hex(c.hex, k.hex);
        if (d < de) [best, de] = [k, d];
      }
      remap.set(c.id, best.id);
    }
    palette.splice(0, palette.length, ...palette.filter((c) => kept.includes(c)));
    if (unused.length > 0) {
      log.add('limits', {
        code: 'limits',
        message: `${unused.length} unused palette color${unused.length === 1 ? '' : 's'} removed (at most ${L.maxPalette} colors): ${unused.slice(0, 8).join(', ')}${unused.length > 8 ? ', …' : ''}`,
        data: { removed: unused },
      });
    }
    if (remap.size > 0) {
      const pairs = [...remap].map(([from, to]) => `${from} → ${to}`);
      log.add('limits', {
        code: 'limits',
        message: `${remap.size} palette color${remap.size === 1 ? '' : 's'} merged into the nearest kept one (at most ${L.maxPalette} colors): ${pairs.slice(0, 6).join(', ')}${pairs.length > 6 ? ', …' : ''}`,
        data: { merged: Object.fromEntries(remap) },
      });
    }
    if (remap.size > 0) {
      const re = (id: string): string => remap.get(id) ?? id;
      for (const p of m.parts) {
        p.color = re(p.color);
        for (const r of (p.regions ?? []) as Mutable<Region>[]) {
          if (r.kind === 'stripes' || r.kind === 'pattern') r.colors = r.colors.map(re);
          else r.color = re(r.color);
        }
      }
      for (const f of (m.features ?? []) as Mutable<Feature>[]) if (f.color !== undefined) f.color = re(f.color);
    }
  }
}

// ---- 8. dims and attach validity

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Azimuth wrapped into (−180, 180]. */
const wrapAz = (a: number): number => {
  const w = ((((a + 180) % 360) + 360) % 360) - 180;
  return w === -180 ? 180 : w;
};

function fixDims(m: Draft, log: RepairLog, warnings: Issue[]): boolean {
  let changedGeometry = false;
  const chip = (p: DraftPart, message: string, data?: Record<string, unknown>): void =>
    log.add('dims', { code: 'dims-clamped', message: `${p.id}: ${message}`, part: p.id, ...(data ? { data } : {}) });
  const lo = L.minDimIn;
  const hi = L.maxDimIn;
  for (const p of m.parts) {
    const dims = p.dims as Record<string, unknown>;
    const clamped: string[] = [];
    const len = (key: string): void => {
      const v = num(dims[key]);
      if (v === undefined) return;
      const c = clamp(Math.abs(v), lo, hi);
      if (c !== v) clamped.push(`${key} ${v} → ${c}`);
      dims[key] = c;
    };
    switch (p.type) {
      case 'sphere':
        len('r');
        break;
      case 'ellipsoid':
        ['rx', 'ry', 'rz'].forEach(len);
        break;
      case 'capsule': {
        len('r');
        len('length');
        const r = dims.r as number;
        if ((dims.length as number) < 2 * r) {
          clamped.push(`length ${dims.length} → ${2 * r} (its two caps)`);
          dims.length = 2 * r;
        }
        break;
      }
      case 'cylinder':
        ['rTop', 'rBottom', 'h'].forEach(len);
        break;
      case 'cone':
        ['r', 'h'].forEach(len);
        break;
      case 'torus': {
        ['R', 'r'].forEach(len);
        const arc = num(dims.arcDeg);
        if (arc !== undefined && (arc <= 0 || arc > 360)) {
          clamped.push(`arcDeg ${arc} → 360`);
          dims.arcDeg = 360;
        }
        break;
      }
      case 'box':
        ['w', 'h', 'd'].forEach(len);
        break;
      case 'flat': {
        ['w', 'h', 'thickness'].forEach(len);
        if (dims.shape === 'polygon' && !Array.isArray(dims.points)) {
          clamped.push('a polygon without points → an oval');
          dims.shape = 'oval';
        }
        if (Array.isArray(dims.points)) {
          dims.points = (dims.points as [number, number][]).map(([x, y]) => [clamp(x, -hi, hi), clamp(y, -hi, hi)]);
          if ((dims.points as unknown[]).length < L.minPolygonPoints) {
            clamped.push('a polygon with fewer than 3 points → an oval');
            dims.shape = 'oval';
            delete dims.points;
          }
        }
        break;
      }
      case 'lathe': {
        let profile = Array.isArray(dims.profile) ? (dims.profile as [number, number][]) : [];
        const fixed = profile.map(([r, y]): [number, number] => [clamp(Math.abs(r), 0, hi), clamp(y, -hi, hi)]);
        // sorted by height (a stable sort keeps the written order of equal heights); `sharp` follows its points
        const order = fixed.map((_, i) => i);
        const ascending = fixed.every((pt, i) => i === 0 || pt[1] >= fixed[i - 1][1]);
        if (!ascending) order.sort((a, b) => fixed[a][1] - fixed[b][1]);
        const sorted = ascending ? fixed : order.map((i) => fixed[i]);
        if (!ascending) {
          clamped.push('profile points sorted bottom → top');
          if (Array.isArray(dims.sharp)) dims.sharp = (dims.sharp as number[]).map((s) => order.indexOf(s)).filter((i) => i >= 0);
        }
        if (JSON.stringify(fixed) !== JSON.stringify(profile)) clamped.push('profile clamped to 0–48 in');
        profile = sorted;
        if (profile.length < L.minProfilePoints) {
          // unreadable or too short: replaced by its bounding ellipsoid (or a small sphere)
          const rMax = Math.max(lo, ...profile.map((q) => q[0]));
          const ys = profile.map((q) => q[1]);
          const h = ys.length > 0 ? Math.max(...ys) - Math.min(...ys) : 0;
          const asEllipsoid = p as Record<string, unknown>;
          asEllipsoid.type = 'ellipsoid';
          asEllipsoid.dims = { rx: rMax, ry: Math.max(lo, h / 2, rMax), rz: rMax };
          warnings.push(issue(IMPORT_CODES.unknownType, 'warn', `${p.id}: its lathe profile has fewer than 3 points: replaced by an ellipsoid`, { part: p.id }));
          log.add('dims', { code: 'type-aliased', message: `${p.id}: its lathe profile has fewer than 3 points: replaced by its bounding ellipsoid`, part: p.id, data: { from: 'lathe', to: 'ellipsoid' } });
          changedGeometry = true;
          continue;
        }
        dims.profile = profile;
        if (Array.isArray(dims.sharp)) dims.sharp = (dims.sharp as number[]).filter((i) => i < profile.length);
        break;
      }
      default:
        break;
    }
    if (clamped.length > 0) {
      chip(p, clamped.join('; '), { clamped });
      changedGeometry = true;
    }
    if (typeof p.flatten === 'number' && (p.flatten < 0 || p.flatten > 1)) {
      chip(p, `flatten ${p.flatten} → ${clamp(p.flatten, 0, 1)}`);
      p.flatten = clamp(p.flatten, 0, 1);
    }
    if (p.rotationDeg && p.rotationDeg.some((v) => !Number.isFinite(v))) {
      chip(p, 'an unreadable rotation was reset to none');
      delete p.rotationDeg;
      changedGeometry = true;
    }
    if (Array.isArray(p.regions)) {
      for (const r of p.regions as Mutable<Region>[]) {
        const rr = r as Record<string, unknown>;
        let touched = false;
        for (const k of ['from', 'to', 'coverage'] as const) {
          const v = num(rr[k]);
          if (v === undefined) continue;
          if (v < 0 || v > 1) touched = true;
          rr[k] = clamp(v, 0, 1);
        }
        if (typeof rr.from === 'number' && typeof rr.to === 'number' && rr.from > rr.to) {
          [rr.from, rr.to] = [rr.to, rr.from];
          touched = true;
        }
        for (const k of ['widthIn', 'radiusIn', 'scaleIn'] as const) {
          const v = num(rr[k]);
          if (v === undefined) continue;
          const c = clamp(Math.abs(v), 0.01, hi);
          if (c !== v) touched = true;
          rr[k] = c;
        }
        if (typeof rr.azimuthDeg === 'number' && Math.abs(rr.azimuthDeg) > 360) {
          rr.azimuthDeg = wrapAz(rr.azimuthDeg);
          touched = true;
        }
        if (typeof rr.elevationDeg === 'number' && Math.abs(rr.elevationDeg) > 90) {
          rr.elevationDeg = clamp(rr.elevationDeg, -90, 90);
          touched = true;
        }
        if (typeof rr.spanDeg === 'number' && (rr.spanDeg <= 0 || rr.spanDeg > 360)) {
          rr.spanDeg = clamp(Math.abs(rr.spanDeg), 1, 360);
          touched = true;
        }
        if (touched) chip(p, `a ${r.kind} region was brought within its limits`);
      }
    }
  }

  // mirrorOf must name another part of the same type that is not itself a mirror (request 16 of s0b-model)
  const byId = new Map(m.parts.map((p) => [p.id, p]));
  for (const p of m.parts) {
    if (p.mirrorOf === undefined) continue;
    const twin = byId.get(p.mirrorOf);
    const why = !twin ? 'does not exist' : twin === p ? 'is itself' : twin.type !== p.type ? `is a ${twin.type}` : twin.mirrorOf !== undefined ? 'is itself a mirror' : '';
    if (why) {
      log.add('dims', { code: 'mirror-removed', message: `${p.id}: mirrorOf ${p.mirrorOf} removed (it ${why})`, part: p.id, data: { mirrorOf: p.mirrorOf } });
      delete p.mirrorOf;
    }
  }

  // features: a missing part is dropped; angles brought into range
  if (Array.isArray(m.features)) {
    m.features = (m.features as Mutable<Feature>[]).filter((f) => {
      if (typeof f.on === 'string' && byId.has(f.on)) return true;
      log.add('dims', { code: 'feature-dropped', message: `feature ${f.id} removed: it sits on "${String(f.on)}", which is not a part`, data: { id: f.id, on: f.on } });
      return false;
    });
    for (const f of m.features as Mutable<Feature>[]) {
      const az = num(f.azimuthDeg) ?? 0;
      const el = num(f.elevationDeg) ?? 0;
      const naz = wrapAz(az);
      const nel = clamp(el, -90, 90);
      if (naz !== az || nel !== el || f.azimuthDeg === undefined || f.elevationDeg === undefined) {
        log.add('dims', { code: 'dims-clamped', message: `feature ${f.id}: azimuth/elevation ${az}°/${el}° → ${naz}°/${nel}°`, data: { id: f.id } });
      }
      f.azimuthDeg = naz;
      f.elevationDeg = nel;
      if (f.path !== undefined) {
        // keep the points that are pairs of numbers; a polyline needs two
        const raw: unknown[] = Array.isArray(f.path) ? f.path : [];
        const pts = raw.flatMap((pt): [number, number][] => {
          if (!Array.isArray(pt) || pt.length < 2) return [];
          const a = num(pt[0]);
          const e = num(pt[1]);
          return a === undefined || e === undefined ? [] : [[wrapAz(a), clamp(e, -90, 90)]];
        });
        if (pts.length !== raw.length) log.add('dims', { code: 'dims-clamped', message: `feature ${f.id}: ${raw.length - pts.length} unreadable path points removed`, data: { id: f.id } });
        if (pts.length >= 2) f.path = pts;
        else delete f.path;
      }
      for (const k of ['sizeMm', 'sizeIn'] as const) {
        const v = num(f[k]);
        if (v === undefined || v <= 0) delete f[k];
        else f[k] = k === 'sizeIn' ? Math.min(v, hi) : v;
      }
    }
    if (m.features.length === 0) delete m.features;
  }

  // parts thinner than a stitch can make (MIN_FEATURE_IN = 6 / (π · stsPerIn)), safety eyes and embroidery aside
  const minFeature = 6 / (Math.PI * (m.yarn?.stsPerIn ?? DEFAULT_STS_PER_IN));
  for (const p of m.parts) {
    const make = p.crochet?.make;
    if (make === 'safety_eye' || make === 'embroidery' || make === 'skip' || p.type === 'flat' || p.type === 'mesh') continue;
    const b = localBounds(p as Part);
    const across = Math.min(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    if (across < minFeature) {
      warnings.push(
        issue(
          IMPORT_CODES.minFeature,
          'info',
          `${p.id} is ${roundCoord(across, 2)} in across, thinner than a crocheted piece can be at this gauge (${roundCoord(minFeature, 2)} in): the pattern will make it flat, as a color region or as embroidery`,
          { part: p.id },
        ),
      );
    }
  }
  return changedGeometry;
}

// ---- 10. gaps

function gapWarnings(m: CrochetModelV1, warnings: Issue[]): void {
  const byId = new Map(m.parts.map((p) => [p.id, p]));
  for (const p of m.parts) {
    const parent = p.attach ? byId.get(p.attach.to) : undefined;
    if (!parent || p.type === 'mesh' || parent.type === 'mesh') continue;
    const gap = surfaceGap(p, parent);
    if (gap > GAP_WARN_IN) {
      warnings.push(issue(IMPORT_CODES.gap, 'warn', `${p.id} is ${roundCoord(gap, 2)} in away from ${parent.id}, the part it is sewn to`, { part: p.id }));
    }
  }
}

/** §3.7.6 on a normalized spec: the repairs in their order, then strict validation. */
export function repairModel(n: Normalized, o: RepairOptions = {}): Repaired {
  const log = n.repairs;
  const meshes: { value?: Record<string, ColoredMesh> } = { value: o.meshes };
  const warnings = [...n.warnings];
  let m = structuredClone(n.model) as unknown as Draft;
  if (!Array.isArray(m.parts) || m.parts.length === 0) {
    warnings.push(issue(IMPORT_CODES.invalid, 'error', 'the spec has no parts'));
    return { ok: false, repairs: log.all(), warnings };
  }
  applyLimits(m, log);
  fixIds(m, log);
  cleanRegionsAndFeatures(m, log);
  m = fixUnits(m, n, log, o.geometry !== undefined || o.unitsDecided === true);
  // radians: decided by the dialect step on the rotations as written (before parents were composed)
  m = ground(m, log);
  offerAxes(m, log);
  fixColors(m, n.dialect, log);
  if (fixDims(m, log, warnings)) {
    // clamped dims change the extents: ground again and record the height the model now has
    m = ground(m, log);
    const h = modelHeight(m as unknown as CrochetModelV1);
    if (h > 0 && Number.isFinite(h)) m.finishedSize = { ...m.finishedSize, height: h };
  }
  m = capHeight(m, log, meshes);
  let model = roundModel(m as unknown as CrochetModelV1);
  const attached = inferAttach(model);
  log.addAll('attach', attached.repairs);
  model = attached.model;
  if (o.geometry?.name) {
    // §3.7.5: no names to go by — template ids by geometry (§2.9.7 step 6), before the pairs (they pair ids)
    const named = nameParts(model, o.geometry.keepIds ? { keepIds: o.geometry.keepIds } : undefined);
    const renames = Object.entries(named.renames);
    // the chip names what was recognized; renumbered `part_N` ids are in `data` only
    const shown = renames.filter(([, b]) => !/^part_\d+$/.test(b));
    if (renames.length > 0) {
      log.add('id', {
        code: 'id',
        message: shown.length > 0
          ? `parts named by their shape and place: ${shown.slice(0, 8).map(([a, b]) => `${a} → ${b}`).join(', ')}${shown.length > 8 ? ', …' : ''}`
          : 'parts numbered by size (no shape was recognized)',
        data: { renames: named.renames },
      });
    }
    model = named.model;
  }
  const mirrored = inferMirrorPairs(model, o.geometry?.mirrorTolerance !== undefined ? { tolerance: o.geometry.mirrorTolerance } : undefined);
  log.addAll('mirror', mirrored.repairs);
  model = mirrored.model;
  gapWarnings(model, warnings);

  const checked = validateModel(model);
  if (!checked.ok) {
    for (const i of checked.issues.slice(0, 20)) warnings.push(issue(IMPORT_CODES.invalid, 'error', i.path ? `${i.path}: ${i.message}` : i.message));
    if (checked.issues.length > 20) warnings.push(issue(IMPORT_CODES.invalid, 'error', `… and ${checked.issues.length - 20} more problems`));
    return { ok: false, repairs: log.all(), warnings };
  }
  return { ok: true, model: checked.model, ...(meshes.value ? { meshes: meshes.value } : {}), repairs: log.all(), warnings };
}

