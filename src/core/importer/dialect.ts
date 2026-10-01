// Track T7 — dialect normalization (DESIGN.md §3.7.3, §3.5.2 versioning): turns a parsed spec — our canonical
// 1.x or the dialect Claude Design improvised [08] — into the canonical shape: `dims` with canonical keys, total
// capsule lengths, a palette array, `label`, absolute positions and rotations, `attach` from `parent`, eyes marked,
// type aliases mapped, unknown keys stripped (logged; `x-*` kept). Nothing is rounded, grounded, re-colored or
// inferred here: that is repair.ts. Values that cannot be read become warnings, never exceptions, except a
// spec of another major version.
import type { Issue } from '../../types/issues';
import type { LengthUnit } from '../../types/importer';
import type { CrochetModelV1, Part, Vec3 } from '../../types/model';
import { hexToOklab } from '../kernel/color';
import { composeRigid, decomposeRigid, multiplyRigid, positionForCenter, type Rigid } from '../model/transforms';
import { MODEL_LIMITS } from '../model/limits';
import { depthOf, IMPORT_CODES, ImportFailure, isPlainObject, issue, lookup, RepairLog } from './common';

/** `ImportResult.dialect` of a model that was read (failures report `'none'`). */
export type Dialect = 'canonical-1' | 'cd-observed-2026-09' | 'geometry-only';

/** The name a model gets when its source has none (the canonical teddy fixture uses it). */
export const DEFAULT_MODEL_NAME = 'Imported model';

export interface Normalized {
  /**
   * The canonical shape. Ids, palette ids and colors are not yet checked (part `color` may still be a hex or a
   * name), lengths may still be in `declaredUnit`.
   */
  model: CrochetModelV1;
  dialect: Dialect;
  /** The unit the spec said it used, when it was not inches (repair.ts converts). */
  declaredUnit?: Exclude<LengthUnit, 'in'>;
  /** The spec stated no `finishedSize.height`. */
  noStatedHeight: boolean;
  repairs: RepairLog;
  warnings: Issue[];
}

/** §3.7.3: parts use `dimensions` (not `dims`), `palette` is an object, or any part has `parent`. */
export function isObservedDialect(raw: Record<string, unknown>): boolean {
  if (isPlainObject(raw.palette)) return true;
  const parts = Array.isArray(raw.parts) ? raw.parts : [];
  return parts.some((p) => isPlainObject(p) && (('dimensions' in p && !('dims' in p)) || 'parent' in p));
}

// ---- small readers

/** A finite number, also from a numeric string ("2.5", "2.5in"). */
export function num(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const m = /^\s*(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/i.exec(value);
    if (m) {
      const n = Number(m[1]);
      return Number.isFinite(n) ? n : undefined;
    }
  }
  return undefined;
}

/** `[x, y, z]` from an array or from `{ x, y, z }`. */
export function vec3(value: unknown): Vec3 | undefined {
  if (Array.isArray(value) && value.length === 3) {
    const v = value.map(num);
    return v.every((x) => x !== undefined) ? (v as Vec3) : undefined;
  }
  if (isPlainObject(value)) {
    const v = [num(value.x), num(value.y), num(value.z)];
    return v.every((x) => x !== undefined) ? (v as Vec3) : undefined;
  }
  return undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  return allowed.find((a) => a.toLowerCase() === v);
}

/** `#rgb` / `#rrggbb` / `rrggbb` → `#rrggbb` as written (case kept); anything else → undefined. */
export function normalizeHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v;
  if (/^[0-9a-fA-F]{6}$/.test(v)) return `#${v}`;
  const m = /^#?([0-9a-fA-F])([0-9a-fA-F])([0-9a-fA-F])$/.exec(v);
  return m ? `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : undefined;
}

/** A color value as a hex: hex strings, `0xRRGGBB` numbers, `[r, g, b]` in 0–1 or 0–255. */
export function colorValueToHex(value: unknown): string | undefined {
  const hex = normalizeHex(value);
  if (hex) return hex;
  if (typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 0xffffff) {
    return `#${value.toString(16).padStart(6, '0')}`;
  }
  if (Array.isArray(value) && value.length >= 3) {
    const v = value.slice(0, 3).map(num);
    if (v.every((x) => x !== undefined && x >= 0)) {
      const c = v as number[];
      const scale = c.every((x) => x <= 1) ? 255 : 1;
      if (c.every((x) => x * scale <= 255)) return `#${c.map((x) => Math.round(x * scale).toString(16).padStart(2, '0')).join('')}`;
    }
  }
  return undefined;
}

/** The palette slug of §3.7.3: lower case, runs of other characters → `_`, trimmed, ≤ 16 characters. */
export function colorSlug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 16) || 'color'
  );
}

/** `base`, else `base_2`, `base_3`, … cut so the whole id stays within `max` characters. */
export function dedupeId(base: string, taken: ReadonlySet<string>, max: number): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `_${n}`;
    const id = `${base.slice(0, max - suffix.length)}${suffix}`;
    if (!taken.has(id)) return id;
  }
}

/** Reads numeric keys and remembers which keys were used, so the rest can be reported as unknown. */
class DimsReader {
  readonly used = new Set<string>();
  readonly raw: Record<string, unknown>;
  constructor(raw: Record<string, unknown>) {
    this.raw = raw;
  }
  get(...keys: string[]): number | undefined {
    for (const k of keys) {
      if (!(k in this.raw)) continue;
      const v = num(this.raw[k]);
      this.used.add(k);
      if (v !== undefined) return v;
    }
    return undefined;
  }
  take(key: string): unknown {
    if (!(key in this.raw)) return undefined;
    this.used.add(key);
    return this.raw[key];
  }
  half(...keys: string[]): number | undefined {
    const v = this.get(...keys);
    return v === undefined ? undefined : v / 2;
  }
  unused(): string[] {
    return Object.keys(this.raw).filter((k) => !this.used.has(k));
  }
}

const CANONICAL_TYPES = ['sphere', 'ellipsoid', 'capsule', 'cylinder', 'cone', 'torus', 'lathe', 'flat', 'box', 'mesh'] as const;
type CanonicalType = (typeof CANONICAL_TYPES)[number];

/** §3.5.2 alias table (plus three.js geometry names). */
const TYPE_ALIASES: Readonly<Record<string, CanonicalType>> = {
  egg: 'ellipsoid', oval: 'ellipsoid', ovoid: 'ellipsoid', ellipse: 'ellipsoid', spheroid: 'ellipsoid',
  ball: 'sphere',
  bean: 'capsule', pill: 'capsule',
  tube: 'cylinder', disc: 'cylinder', disk: 'cylinder',
  ring: 'torus', donut: 'torus', doughnut: 'torus',
  dome: 'lathe', hemisphere: 'lathe', pear: 'lathe',
  plate: 'flat', leaf: 'flat', wing: 'flat',
  cube: 'box', cuboid: 'box',
};

function canonicalType(raw: string): { type: CanonicalType; alias?: string } | undefined {
  const t = raw.trim().toLowerCase().replace(/(buffer)?geometry$/, '');
  if ((CANONICAL_TYPES as readonly string[]).includes(t)) return { type: t as CanonicalType };
  const a = lookup(TYPE_ALIASES, t);
  return a ? { type: a, alias: t } : undefined;
}

/** A lathe profile `[radius, y][]` from pairs or `{ r|x|radius, y }` objects; undefined when unreadable. */
function readProfile(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: [number, number][] = [];
  for (const p of value) {
    const pair = Array.isArray(p) ? [num(p[0]), num(p[1])] : isPlainObject(p) ? [num(p.r ?? p.radius ?? p.x), num(p.y)] : [];
    // an unreadable point is skipped (the repair step replaces a profile left with fewer than 3 points)
    if (pair[0] !== undefined && pair[1] !== undefined) out.push([pair[0], pair[1]]);
  }
  return out;
}

function readPoints(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: [number, number][] = [];
  for (const p of value) {
    const pair = Array.isArray(p) ? [num(p[0]), num(p[1])] : isPlainObject(p) ? [num(p.x), num(p.y)] : [];
    if (pair[0] === undefined || pair[1] === undefined) return undefined;
    out.push([pair[0], pair[1]]);
  }
  return out;
}

/** A dome of radius r and height h, base at y = 0 (9 points, closed at the base center). */
function domeProfile(r: number, h: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  for (let k = 0; k <= 8; k++) {
    const a = (k / 8) * (Math.PI / 2);
    out.push([k === 8 ? 0 : r * Math.cos(a), h * Math.sin(a)]);
  }
  return out;
}

/** A pear of largest radius r and height h, base at y = 0. */
function pearProfile(r: number, h: number): [number, number][] {
  return [[0, 0], [0.7 * r, 0.04 * h], [r, 0.28 * h], [0.85 * r, 0.55 * h], [0.55 * r, 0.75 * h], [0.4 * r, 0.9 * h], [0, h]];
}

interface DimsResult {
  type: CanonicalType;
  dims: Record<string, unknown>;
  /** The source gave the center of a part whose canonical origin is elsewhere (an aliased lathe). */
  centered?: boolean;
  /** Messages for repairs (`dims-clamped`) and warnings. */
  notes: { kind: 'repair' | 'warn' | 'type'; message: string }[];
  unused: string[];
}

/**
 * Dims in canonical keys for a (possibly aliased or unknown) type. `observed` = the part wrote the dialect's
 * `dimensions`, whose capsule `length` is the straight section only.
 */
function readDims(rawType: string, rawDims: Record<string, unknown>, observed: boolean): DimsResult {
  const d = new DimsReader(rawDims);
  const notes: DimsResult['notes'] = [];
  const mapped = canonicalType(rawType);
  const r = (): number | undefined => d.get('r', 'radius') ?? d.half('diameter', 'd');
  const defaulted = (what: string, value: number): number => {
    notes.push({ kind: 'warn', message: `${what} was missing: ${value} in assumed` });
    return value;
  };

  const ellipsoidFrom = (): Record<string, unknown> => {
    const radii = d.take('radii');
    const arr = vec3(radii) ?? vec3(d.take('scale'));
    const base = r();
    const rx = d.get('rx', 'radiusX', 'a') ?? arr?.[0] ?? d.half('w', 'width') ?? base;
    const ry = d.get('ry', 'radiusY', 'b') ?? arr?.[1] ?? d.half('h', 'height', 'length') ?? base;
    const rz = d.get('rz', 'radiusZ', 'c') ?? arr?.[2] ?? d.half('depth') ?? base;
    const known = [rx, ry, rz].filter((x): x is number => x !== undefined);
    const fill = known.length > 0 ? Math.max(...known) : defaulted('the size', 0.5);
    return { rx: rx ?? fill, ry: ry ?? fill, rz: rz ?? fill };
  };

  if (!mapped) {
    // §3.5.2: anything else → its bounding ellipsoid, with a warning
    const dims = ellipsoidFrom();
    for (const k of d.unused()) d.get(k);
    notes.push({ kind: 'type', message: `type "${rawType}" is not one this app knows: replaced by its bounding ellipsoid` });
    return { type: 'ellipsoid', dims, notes, unused: [] };
  }
  const { type, alias } = mapped;
  switch (type) {
    case 'sphere': {
      const rr = r() ?? d.get('rx', 'ry', 'rz');
      return { type, dims: { r: rr ?? defaulted('the radius', 0.5) }, notes, unused: d.unused() };
    }
    case 'ellipsoid': {
      if (alias === 'egg' && d.get('rx', 'ry', 'rz') === undefined) {
        const rr = r() ?? defaulted('the radius', 0.5);
        const h = d.get('h', 'height', 'length');
        return { type, dims: { rx: rr, ry: h !== undefined ? h / 2 : rr * 1.25, rz: rr }, notes, unused: d.unused() };
      }
      return { type, dims: ellipsoidFrom(), notes, unused: d.unused() };
    }
    case 'capsule': {
      const rr = r() ?? defaulted('the radius', 0.3);
      const straight = d.get('length', 'l');
      const total = d.get('h', 'height', 'totalLength');
      let length: number;
      if (straight !== undefined && observed) length = straight + 2 * rr;
      else if (straight !== undefined) {
        length = straight;
        if (length < 2 * rr) {
          length = straight + 2 * rr;
          notes.push({ kind: 'repair', message: `capsule length ${straight} is shorter than its two caps (2·r = ${2 * rr}): read as the straight section, total ${length}` });
        }
      } else length = total ?? defaulted('the length', 4 * rr);
      return { type, dims: { r: rr, length }, notes, unused: d.unused() };
    }
    case 'cylinder': {
      const both = r();
      const rTop = d.get('rTop', 'radiusTop', 'topRadius') ?? both;
      const rBottom = d.get('rBottom', 'radiusBottom', 'bottomRadius') ?? both;
      const h = d.get('h', 'height', 'thickness', 'length') ?? defaulted('the height', alias === 'disc' || alias === 'disk' ? 0.25 : 1);
      const rt = rTop ?? rBottom ?? defaulted('the radius', 0.5);
      const dims: Record<string, unknown> = { rTop: rt, rBottom: rBottom ?? rt, h };
      const open = d.take('open');
      const openEnded = d.take('openEnded');
      const o = oneOf(open, ['none', 'top', 'bottom', 'both'] as const);
      if (o) dims.open = o;
      else if (openEnded === true) dims.open = 'both';
      return { type, dims, notes, unused: d.unused() };
    }
    case 'cone': {
      const rr = r() ?? d.get('rBottom', 'radiusBottom') ?? defaulted('the radius', 0.5);
      const h = d.get('h', 'height', 'length') ?? defaulted('the height', 2 * rr);
      return { type, dims: { r: rr, h }, notes, unused: d.unused() };
    }
    case 'torus': {
      const R = d.get('R', 'majorRadius', 'radius') ?? defaulted('the ring radius', 1);
      const tube = d.get('tube', 'tubeRadius', 'minorRadius', 'r') ?? defaulted('the tube radius', 0.25 * R);
      const dims: Record<string, unknown> = { R, r: tube };
      const arcDeg = d.get('arcDeg');
      const arc = d.get('arc');
      if (arcDeg !== undefined) dims.arcDeg = arcDeg;
      else if (arc !== undefined) dims.arcDeg = arc <= 2 * Math.PI + 1e-6 ? (arc * 180) / Math.PI : arc;
      return { type, dims, notes, unused: d.unused() };
    }
    case 'lathe': {
      if (alias === 'dome' || alias === 'hemisphere' || alias === 'pear') {
        const rr = r() ?? d.half('w', 'width') ?? defaulted('the radius', 0.5);
        const h = d.get('h', 'height') ?? (alias === 'pear' ? 2.4 * rr : rr);
        const profile = alias === 'pear' ? pearProfile(rr, h) : domeProfile(rr, alias === 'hemisphere' ? rr : h);
        return { type, dims: { profile }, centered: true, notes, unused: d.unused() };
      }
      const profile = readProfile(d.take('profile') ?? d.take('points'));
      const dims: Record<string, unknown> = { profile: profile ?? [] };
      const sharp = d.take('sharp');
      if (Array.isArray(sharp)) dims.sharp = sharp.map(num).filter((x): x is number => x !== undefined && Number.isInteger(x) && x >= 0);
      if (!profile) notes.push({ kind: 'warn', message: 'the lathe profile could not be read' });
      return { type, dims, notes, unused: d.unused() };
    }
    case 'flat': {
      const shapeAliases: Record<string, string> = { ellipse: 'oval', square: 'rect', rectangle: 'rect', drop: 'teardrop', disc: 'circle', round: 'circle' };
      const rawShape = str(d.take('shape'))?.trim().toLowerCase();
      const defaultShape = alias === 'leaf' ? 'teardrop' : alias === 'wing' ? 'oval' : 'circle';
      const shape =
        oneOf(rawShape, ['circle', 'oval', 'teardrop', 'triangle', 'rect', 'polygon'] as const) ??
        oneOf(rawShape ? lookup(shapeAliases, rawShape) : undefined, ['circle', 'oval', 'teardrop', 'triangle', 'rect', 'polygon'] as const) ??
        defaultShape;
      const across = r();
      const w = d.get('w', 'width') ?? (across !== undefined ? 2 * across : undefined) ?? defaulted('the width', 1);
      const h = d.get('h', 'height', 'length') ?? (across !== undefined ? 2 * across : w);
      const thickness = d.get('thickness', 't', 'depth') ?? defaulted('the thickness', Math.max(0.05, Math.min(0.25, 0.15 * Math.min(w, h))));
      const dims: Record<string, unknown> = { shape, w, h, thickness };
      const points = readPoints(d.take('points'));
      if (points) dims.points = points;
      return { type, dims, notes, unused: d.unused() };
    }
    case 'box': {
      const w = d.get('w', 'width', 'x') ?? defaulted('the width', 1);
      const h = d.get('h', 'height', 'y') ?? defaulted('the height', 1);
      const dd = d.get('d', 'depth', 'z') ?? defaulted('the depth', 1);
      return { type, dims: { w, h, d: dd }, notes, unused: d.unused() };
    }
    case 'mesh': {
      const meshRef = str(d.take('meshRef')) ?? '';
      const bbox = vec3(d.take('bboxIn')) ?? [1, 1, 1];
      return { type, dims: { meshRef, bboxIn: bbox }, notes, unused: d.unused() };
    }
  }
}

// ---- known keys

const MODEL_KEYS = new Set([
  'schema', 'version', 'revision', 'units', 'axes', 'name', 'description', 'category', 'style', 'audience', 'finishedSize',
  'pose', 'flatBase', 'yarn', 'palette', 'parts', 'features', 'assembly', 'assumptions', 'source',
]);
/** Top-level keys whose text is kept in `assumptions` when stripped (§3.7.3). */
const NOTE_KEYS = new Set(['notes', 'note', 'comment', 'comments']);
const PART_KEYS = new Set(['id', 'label', 'type', 'dims', 'position', 'rotationDeg', 'color', 'regions', 'attach', 'mirrorOf', 'stuffing', 'flatten', 'notes', 'crochet', 'paint']);

const UNIT_NAMES: Readonly<Record<string, LengthUnit>> = {
  in: 'in', inch: 'in', inches: 'in', '"': 'in', 'in.': 'in',
  cm: 'cm', centimeter: 'cm', centimeters: 'cm', centimetre: 'cm', centimetres: 'cm',
  mm: 'mm', millimeter: 'mm', millimeters: 'mm', millimetre: 'mm', millimetres: 'mm',
  m: 'm', meter: 'm', meters: 'm', metre: 'm', metres: 'm',
};

/** Palette entries and parts read at all (the limits step later keeps 16 colors and 60 parts). */
const MAX_RAW_PALETTE = 256;
const MAX_RAW_PARTS = 1000;

/** Degrees per radian, for the radians repair. */
const DEG = 180 / Math.PI;

/**
 * §3.7.6 radians: every |rotation| ≤ 6.3 and some non-integer value within 0.01 of a non-zero k·π/12 ⇒ the
 * rotations are radians. Run on the rotations as written, before any parent composition.
 */
export function rotationsLookLikeRadians(rotations: readonly Vec3[]): boolean {
  const values = rotations.flat();
  if (values.length === 0 || values.some((v) => Math.abs(v) > 6.3)) return false;
  return values.some((v) => {
    if (Number.isInteger(v)) return false;
    const k = Math.round(v / (Math.PI / 12));
    return k !== 0 && Math.abs(v - (k * Math.PI) / 12) <= 0.01;
  });
}

/**
 * §2.10.1 rule 1 as the dialect applies it: the id or label contains "eye", or a sphere or ellipsoid at most
 * 0.6 in across with OKLab L < 0.25 that hangs from another part.
 */
function isEyeLike(id: string, label: string | undefined, type: string, dims: Record<string, unknown>, hex: string | undefined, hasParent: boolean): boolean {
  if (/eye/i.test(id) || /eye/i.test(label ?? '')) return true;
  if (!hasParent || (type !== 'sphere' && type !== 'ellipsoid') || !hex) return false;
  const radii = Object.values(dims).filter((v): v is number => typeof v === 'number');
  return radii.length > 0 && 2 * Math.max(...radii) <= 0.6 && hexToOklab(hex)[0] < 0.25;
}

interface RawPart {
  index: number;
  id: string;
  parent: string | null;
  position: Vec3;
  rotation?: Vec3;
  out: Record<string, unknown>;
  centered: boolean;
}

/**
 * Normalizes a parsed spec (§3.7.3 for the observed dialect, §3.5.2 aliases for both). Throws `ImportFailure`
 * only for a spec of another major version.
 */
export function normalizeSpec(raw: Record<string, unknown>): Normalized {
  const repairs = new RepairLog();
  const warnings: Issue[] = [];
  const observed = isObservedDialect(raw);
  const dialect: Dialect = observed ? 'cd-observed-2026-09' : 'canonical-1';
  // an x-* value is kept unless it nests deeper than the document allows (dropped here, before anything copies it)
  const keepExtension = (owner: Record<string, unknown>, key: string, value: unknown, level: number, tag?: string, part?: string): void => {
    if (level + depthOf(value, MODEL_LIMITS.maxDepth) > MODEL_LIMITS.maxDepth) {
      repairs.add('limits', {
        code: 'limits',
        message: `extension "${key}"${tag ? ` of ${tag}` : ''} removed: nested deeper than ${MODEL_LIMITS.maxDepth} levels`,
        ...(part ? { part } : {}),
      });
    } else owner[key] = value;
  };
  // regions, paint and features are copied as written and checked later: anything nested too deeply goes now
  const keepNested = (owner: Record<string, unknown>, key: string, value: unknown, level: number, tag?: string, part?: string): void => {
    if (level + depthOf(value, MODEL_LIMITS.maxDepth) > MODEL_LIMITS.maxDepth) {
      repairs.add('limits', { code: 'limits', message: `"${key}"${tag ? ` of ${tag}` : ''} removed: nested deeper than ${MODEL_LIMITS.maxDepth} levels`, ...(part ? { part } : {}) });
    } else owner[key] = value;
  };
  const unknownKey = (key: string, where: string, part?: string, extra?: string): void => {
    repairs.add('unknown-key', {
      code: 'unknown-key',
      message: `unknown key "${key}"${where ? ` ${where}` : ''} removed${extra ?? ''}`,
      ...(part ? { part } : {}),
      data: { key, ...(where ? { where } : {}) },
    });
  };

  // ---- header
  let version = '1.0';
  if (raw.version !== undefined) {
    const v = typeof raw.version === 'number' ? String(raw.version) : str(raw.version) ?? '';
    const m = /^\s*v?(\d+)(?:\.(\d+))?/.exec(v);
    if (m && m[1] !== '1') {
      throw new ImportFailure(issue(IMPORT_CODES.unsupported, 'error', `this spec is crochet-model version ${v}; this app reads version 1.x`));
    }
    version = m ? `1.${m[2] ?? '0'}` : '1.0';
  }
  const revision = num(raw.revision);
  const model: Record<string, unknown> = {
    schema: 'crochet-model',
    version,
    revision: revision !== undefined && revision >= 0 ? Math.floor(revision) : 0,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: str(raw.name)?.trim() || str(raw.title)?.trim() || DEFAULT_MODEL_NAME,
  };
  let declaredUnit: Normalized['declaredUnit'];
  if (raw.units !== undefined) {
    const u = lookup(UNIT_NAMES, String(raw.units).trim().toLowerCase());
    if (u === undefined) warnings.push(issue(IMPORT_CODES.defaulted, 'warn', `units "${String(raw.units)}" are not ones this app knows: read as inches`));
    else if (u !== 'in') declaredUnit = u;
  }
  let rotateZUp = false;
  if (isPlainObject(raw.axes)) {
    const up = str(raw.axes.up)?.trim().toUpperCase();
    if (up === '+Z' || up === 'Z') rotateZUp = true;
    else if (up !== undefined && up !== '+Y' && up !== 'Y') warnings.push(issue(IMPORT_CODES.defaulted, 'warn', `axes.up "${up}" is not supported: read as +Y`));
  }
  if (str(raw.description)) model.description = raw.description;
  const enumField = <T extends string>(key: string, allowed: readonly T[]): void => {
    if (raw[key] === undefined) return;
    const v = oneOf(raw[key], allowed);
    if (v) model[key] = v;
    else unknownKey(key, `(value "${String(raw[key])}" is not one of ${allowed.join(', ')})`);
  };
  enumField('category', ['quadruped', 'biped', 'bird', 'sea', 'insect', 'person', 'creature', 'food', 'plant', 'object', 'other'] as const);
  enumField('style', ['chibi', 'realistic', 'minimal'] as const);
  enumField('audience', ['adult', 'child', 'under3'] as const);
  enumField('pose', ['standing', 'sitting', 'lying', 'hanging', 'free'] as const);

  // finishedSize
  let noStatedHeight = true;
  const fs = raw.finishedSize;
  const finishedSize: Record<string, number> = {};
  if (isPlainObject(fs) || typeof fs === 'number' || typeof fs === 'string') {
    const o: Record<string, unknown> = isPlainObject(fs) ? fs : { height: fs };
    const h = num(o.height ?? o.h);
    if (h !== undefined && h > 0) {
      finishedSize.height = h;
      noStatedHeight = false;
    }
    const w = num(o.width ?? o.w);
    const dp = num(o.depth ?? o.d);
    if (w !== undefined && w > 0) finishedSize.width = w;
    if (dp !== undefined && dp > 0) finishedSize.depth = dp;
    if (isPlainObject(fs)) for (const k of Object.keys(fs)) if (!['height', 'h', 'width', 'w', 'depth', 'd'].includes(k)) unknownKey(k, 'in finishedSize');
  }
  model.finishedSize = finishedSize;
  if (raw.flatBase !== undefined) {
    if (typeof raw.flatBase === 'boolean') model.flatBase = raw.flatBase;
    else unknownKey('flatBase', '(not true or false)');
  }
  if (isPlainObject(raw.yarn)) {
    const y: Record<string, unknown> = {};
    const cyc = num(raw.yarn.weightCYC);
    if (cyc !== undefined && Number.isInteger(cyc) && cyc >= 0 && cyc <= 7) y.weightCYC = cyc;
    const hook = num(raw.yarn.hookMm);
    if (hook !== undefined && hook > 0) y.hookMm = hook;
    const spi = num(raw.yarn.stsPerIn);
    if (spi !== undefined && spi > 0) y.stsPerIn = spi;
    if (str(raw.yarn.fiber)) y.fiber = raw.yarn.fiber;
    for (const k of Object.keys(raw.yarn)) if (!(k in y)) unknownKey(k, 'in yarn');
    model.yarn = y;
  } else if (raw.yarn !== undefined) unknownKey('yarn', '(not an object)');

  // ---- palette: canonical array, the dialect's { "#hex": "name" }, the reverse { id: "#hex" }, or ["#hex", …]
  const palette: Record<string, unknown>[] = [];
  const takenColorIds = new Set<string>();
  const addColor = (id: string, hex: string, name?: string, role?: unknown): void => {
    const entry: Record<string, unknown> = { id, hex };
    if (name !== undefined) entry.name = name;
    const r = oneOf(role, ['main', 'accent', 'detail'] as const);
    if (r) entry.role = r;
    palette.push(entry);
    takenColorIds.add(id);
  };
  // far beyond any real spec (16 colors, 60 parts): cut early so the later steps stay cheap
  const capped = <T>(list: T[], max: number, what: string): T[] => {
    if (list.length <= max) return list;
    repairs.add('limits', { code: 'limits', message: `${list.length} ${what}: only the first ${max} were read`, data: { count: list.length } });
    return list.slice(0, max);
  };
  if (Array.isArray(raw.palette)) {
    capped(raw.palette, MAX_RAW_PALETTE, 'palette entries').forEach((c, i) => {
      const hex = colorValueToHex(isPlainObject(c) ? (c.hex ?? c.color ?? c.value) : c);
      if (!hex) {
        warnings.push(issue(IMPORT_CODES.defaulted, 'warn', `palette entry ${i + 1} has no readable color: removed`));
        return;
      }
      const o = isPlainObject(c) ? c : {};
      const id = str(o.id) ?? `c${i + 1}`;
      addColor(id, hex, str(o.name), o.role);
      for (const k of Object.keys(o)) if (!['id', 'hex', 'name', 'role', 'color', 'value'].includes(k)) unknownKey(k, `in palette entry "${id}"`);
    });
  } else if (isPlainObject(raw.palette)) {
    for (const [key, value] of capped(Object.entries(raw.palette), MAX_RAW_PALETTE, 'palette entries')) {
      const keyHex = normalizeHex(key);
      if (keyHex !== undefined && typeof value === 'string') {
        // the observed dialect: { "#B07A4A": "caramel_yarn" } — hex as written, id = slug(name), deduped
        const base = colorSlug(value);
        addColor(dedupeId(base, takenColorIds, 16), keyHex, value);
      } else {
        const valueHex = colorValueToHex(isPlainObject(value) ? value.hex : value);
        if (valueHex) addColor(dedupeId(colorSlug(key), takenColorIds, 16), valueHex, isPlainObject(value) ? str(value.name) ?? key : key);
        else warnings.push(issue(IMPORT_CODES.defaulted, 'warn', `palette entry "${key}" has no readable color: removed`));
      }
    }
  } else if (raw.palette !== undefined) unknownKey('palette', '(not a list or an object)');
  model.palette = palette;

  // ---- parts
  const rawParts = Array.isArray(raw.parts) ? capped(raw.parts, MAX_RAW_PARTS, 'parts') : [];
  const parts: RawPart[] = [];
  rawParts.forEach((p, index) => {
    if (!isPlainObject(p)) {
      warnings.push(issue(IMPORT_CODES.defaulted, 'warn', `parts[${index}] is not an object: removed`));
      return;
    }
    const id = typeof p.id === 'string' ? p.id : typeof p.id === 'number' ? String(p.id) : '';
    const tag = id || `parts[${index}]`;
    const out: Record<string, unknown> = { id };
    const label = str(p.label) ?? str(p.name);
    if (label !== undefined) out.label = label;
    const typeText = str(p.type) ?? '';
    const rawDims = isPlainObject(p.dims) ? p.dims : isPlainObject(p.dimensions) ? p.dimensions : {};
    // the straight-section capsule length belongs to the observed `dimensions` object, not to the whole spec: one
    // stray `parent` key must not change the capsules written in canonical `dims`
    const dr = readDims(typeText || 'unknown', rawDims, !isPlainObject(p.dims) && isPlainObject(p.dimensions));
    out.type = dr.type;
    out.dims = dr.dims;
    for (const n of dr.notes) {
      if (n.kind === 'repair') repairs.add('dims', { code: 'dims-clamped', message: `${tag}: ${n.message}`, part: id || undefined });
      if (n.kind === 'type') repairs.add('dims', { code: 'type-aliased', message: `${tag}: ${n.message}`, ...(id ? { part: id } : {}), data: { from: typeText, to: dr.type } });
      if (n.kind !== 'repair') warnings.push(issue(n.kind === 'type' ? IMPORT_CODES.unknownType : IMPORT_CODES.defaulted, 'warn', `${tag}: ${n.message}`, id ? { part: id } : undefined));
    }
    for (const k of dr.unused) unknownKey(k, `in the dims of ${tag}`, id || undefined);

    let position = vec3(p.position);
    if (!position) {
      position = [0, 0, 0];
      warnings.push(issue(IMPORT_CODES.defaulted, 'warn', `${tag}: no readable position, placed at the origin`, id ? { part: id } : undefined));
    }
    const rotation = vec3(p.rotationDeg) ?? vec3(p.rotation);
    if (p.rotationDeg === undefined && p.rotation !== undefined && !rotation) unknownKey('rotation', `of ${tag} (not three numbers)`, id || undefined);

    const colorValue = p.color ?? p.colour;
    out.color = typeof colorValue === 'string' ? colorValue.trim() : (colorValueToHex(colorValue) ?? '');
    if (Array.isArray(p.regions)) keepNested(out, 'regions', p.regions, 3, tag, id || undefined);
    else if (p.regions !== undefined) unknownKey('regions', `of ${tag} (not a list)`, id || undefined);

    let parent: string | null = null;
    if (observed && (typeof p.parent === 'string' || typeof p.parent === 'number')) parent = String(p.parent);
    if (isPlainObject(p.attach) || typeof p.attach === 'string') {
      const a: Record<string, unknown> = isPlainObject(p.attach) ? p.attach : { to: p.attach };
      const attach: Record<string, unknown> = { to: typeof a.to === 'number' ? String(a.to) : str(a.to) ?? '' };
      const method = oneOf(a.method, ['sewn', 'crochet-in-place', 'worked-from', 'glued', 'none'] as const);
      if (method) attach.method = method;
      const openEnd = oneOf(a.openEnd, ['top', 'bottom', 'none'] as const);
      if (openEnd) attach.openEnd = openEnd;
      if (isPlainObject(p.attach)) for (const k of Object.keys(a)) if (!(k in attach)) unknownKey(k, `in the attach of ${tag}`, id || undefined);
      out.attach = attach;
    }
    if (typeof p.mirrorOf === 'string') out.mirrorOf = p.mirrorOf;
    const stuffing = oneOf(p.stuffing, ['firm', 'medium', 'light', 'none'] as const);
    if (stuffing) out.stuffing = stuffing;
    else if (p.stuffing !== undefined) unknownKey('stuffing', `of ${tag} (value "${String(p.stuffing)}")`, id || undefined);
    const flatten = num(p.flatten);
    if (flatten !== undefined) out.flatten = flatten;
    if (str(p.notes) !== undefined) out.notes = p.notes;
    if (isPlainObject(p.crochet)) out.crochet = readHints(p.crochet, tag, id, unknownKey);
    if (isPlainObject(p.paint)) keepNested(out, 'paint', p.paint, 3, tag, id || undefined);

    const consumed = new Set([...PART_KEYS, 'name', 'dimensions', 'rotation', 'colour', ...(observed ? ['parent'] : [])]);
    for (const k of Object.keys(p)) {
      if (k.startsWith('x-')) keepExtension(out, k, p[k], 3, tag, id || undefined);
      else if (!consumed.has(k)) unknownKey(k, `of ${tag}`, id || undefined);
      else if (k === 'name' && p.label !== undefined) unknownKey('name', `of ${tag} (it has a label)`, id || undefined);
    }
    if (!observed && 'parent' in p) unknownKey('parent', `of ${tag}`, id || undefined);
    parts.push({ index, id, parent, position, rotation, out, centered: dr.centered === true });
  });

  // radians (§3.7.6), decided on the rotations as written, before any composition
  const written = parts.map((p) => p.rotation).filter((r): r is Vec3 => r !== undefined);
  if (rotationsLookLikeRadians(written)) {
    for (const p of parts) if (p.rotation) p.rotation = p.rotation.map((v) => v * DEG) as Vec3;
    repairs.add('radians', {
      code: 'radians',
      message: 'the rotations look like radians (all within ±6.3, at multiples of π/12): converted to degrees',
      data: { parts: parts.filter((p) => p.rotation).length },
    });
  }

  // transforms: the dialect's positions and rotations are relative to the parent part
  const byId = new Map<string, RawPart>();
  for (const p of parts) if (p.id && !byId.has(p.id)) byId.set(p.id, p);
  const worlds = new Map<RawPart, Rigid>();
  const zUp: Rigid | null = rotateZUp ? composeRigid([0, 0, 0], [-90, 0, 0]) : null;
  const worldOf = (p: RawPart, path: Set<RawPart>): Rigid => {
    const known = worlds.get(p);
    if (known) return known;
    const local = composeRigid(p.position, p.rotation);
    let world = local;
    if (observed && p.parent !== null) {
      const parent = byId.get(p.parent);
      if (!parent || parent === p || path.has(parent)) {
        warnings.push(
          issue(
            IMPORT_CODES.defaulted,
            'warn',
            `${p.id || `parts[${p.index}]`}: its parent "${p.parent}" ${!parent ? 'does not exist' : 'closes a loop'}, so its position is read as absolute`,
            p.id ? { part: p.id } : undefined,
          ),
        );
        p.parent = null;
      } else {
        path.add(p);
        world = multiplyRigid(worldOf(parent, path), local);
        path.delete(p);
      }
    }
    worlds.set(p, world);
    return world;
  };
  const outParts: Part[] = parts.map((p) => {
    let world = worldOf(p, new Set());
    if (zUp) world = multiplyRigid(zUp, world);
    const { position, rotationDeg } = decomposeRigid(world);
    const out = p.out;
    const rotated = rotationDeg.some((v) => v !== 0);
    if (p.rotation !== undefined || rotated) out.rotationDeg = rotationDeg;
    out.position = position;
    if (p.centered) out.position = positionForCenter(out as unknown as Part, position);
    if (observed && p.parent !== null) out.attach = { to: p.parent, method: 'sewn' };
    if (observed) {
      const hex = normalizeHex(out.color);
      if (isEyeLike(p.id, str(out.label), String(out.type), out.dims as Record<string, unknown>, hex, p.parent !== null)) {
        out.crochet = { ...(isPlainObject(out.crochet) ? out.crochet : {}), make: 'safety_eye' };
      }
    }
    return out as unknown as Part;
  });
  if (rotateZUp) {
    repairs.add('axes', { code: 'axes', message: 'the spec is Z-up: turned −90° about X so +Y is up', data: { rotatedDeg: [-90, 0, 0] } });
  }
  model.parts = outParts;

  // ---- features, assembly, assumptions, source
  if (Array.isArray(raw.features)) keepNested(model, 'features', raw.features, 1);
  else if (raw.features !== undefined) unknownKey('features', '(not a list)');
  if (Array.isArray(raw.assembly)) {
    model.assembly = raw.assembly.filter(isPlainObject).map((a, i) => {
      const step: Record<string, unknown> = { order: num(a.order) ?? i + 1, part: str(a.part) ?? '', text: str(a.text) ?? '' };
      if (str(a.to) !== undefined) step.to = a.to;
      return step;
    });
  }
  const assumptions: string[] = Array.isArray(raw.assumptions) ? raw.assumptions.filter((a): a is string => typeof a === 'string') : [];
  for (const key of Object.keys(raw)) {
    if (MODEL_KEYS.has(key) || key.startsWith('x-') || key === 'title') continue;
    const value = raw[key];
    if (NOTE_KEYS.has(key) && typeof value === 'string' && value.trim() !== '') {
      assumptions.push(value);
      unknownKey(key, '', undefined, ' (its text is kept in "assumptions")');
    } else unknownKey(key, '');
  }
  if (raw.title !== undefined && str(raw.name)) unknownKey('title', '(the model has a name)');
  if (assumptions.length > 0) model.assumptions = assumptions;
  if (isPlainObject(raw.source)) {
    const src: Record<string, unknown> = {};
    for (const k of ['tool', 'createdAt', 'promptVersion', 'builderVersion'] as const) if (str(raw.source[k]) !== undefined) src[k] = raw.source[k];
    const stage = oneOf(raw.source.stage, ['seed', 'refined', 'edited', 'recon', 'refined-from-mesh'] as const);
    if (stage) src.stage = stage;
    if (Array.isArray(raw.source.views)) src.views = raw.source.views.filter((v): v is string => typeof v === 'string');
    for (const k of Object.keys(raw.source)) if (!(k in src)) unknownKey(k, 'in source');
    model.source = src;
  } else if (observed) model.source = { tool: 'claude-design', stage: 'refined' };
  for (const key of Object.keys(raw)) if (key.startsWith('x-')) keepExtension(model, key, raw[key], 1);

  return { model: model as unknown as CrochetModelV1, dialect, declaredUnit, noStatedHeight, repairs, warnings };
}

function readHints(raw: Record<string, unknown>, tag: string, id: string, unknownKey: (k: string, w: string, p?: string) => void): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const make = oneOf(raw.make, ['auto', 'piece', 'applique', 'embroidery', 'safety_eye', 'region', 'skip'] as const);
  if (make) out.make = make;
  const start = oneOf(raw.start, ['auto', 'bottom', 'top'] as const);
  if (start) out.start = start;
  const axis = oneOf(raw.axis, ['auto', 'x', 'y', 'z'] as const);
  if (axis) out.axis = axis;
  const seed = vec3(raw.seed);
  if (seed) out.seed = seed;
  const style = oneOf(raw.style, ['classic', 'exact'] as const);
  if (style) out.style = style;
  const seam = num(raw.seamAzimuthDeg);
  if (seam !== undefined) out.seamAzimuthDeg = seam;
  for (const k of Object.keys(raw)) if (!(k in out)) unknownKey(k, `in the crochet hints of ${tag}`, id || undefined);
  return out;
}
