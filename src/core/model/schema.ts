// The zod mirror of the `crochet-model` schema, version 1.x (DESIGN.md §3.5.1, §3.5.2). Step 0 kernel.
//
// `Part` is a discriminated union on `type`, and every object is a strict object: a plain union of stripping
// objects returns the first branch that passes and silently drops fields (capsule `{r, length}` → `{r}`).
// `x-*` extension keys are allowed on the model and on each part: `withExtensions` lifts them out before the
// strict parse and re-attaches them afterwards, so `crochetModelSchema.parse(x)` deep-equals `x` for a valid
// model (nothing stripped) and any other unknown key is a validation error. The importer strips and logs
// unknown keys during normalization (§3.7.6), before it validates.
//
// The types of src/types/model.ts are authoritative; the compile-time guard at the end of this file fails
// `npm run typecheck` when the two drift apart.
import { z } from 'zod';
import type { CrochetModelV1, Feature, PaletteColor, Part, Region } from '../../types/model';
import { MODEL_LIMITS } from './limits';

export { MODEL_LIMITS };

const L = MODEL_LIMITS;

/** Keys that never appear in a model, at any depth (§3.7.6 security). */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

export const PART_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
export const COLOR_ID_PATTERN = /^[a-z0-9_]{1,16}$/;
export const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;
export const VERSION_PATTERN = /^1\.\d+$/;

/** True for an extension key (`x-…`): kept on the model and on parts, never rejected. */
export function isExtensionKey(key: string): key is `x-${string}` {
  return key.startsWith('x-');
}

type Extensions = { [k: `x-${string}`]: unknown };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Re-raises the issues of a nested parse at the current location. The issues are already final (they carry
 * their message and a path relative to the nested value), which is exactly what zod keeps when it prefixes the
 * outer path.
 */
function forwardIssues(ctx: { issues: z.core.$ZodRawIssue[] }, error: z.ZodError): void {
  for (const issue of error.issues) ctx.issues.push(issue as unknown as z.core.$ZodRawIssue);
}

/**
 * Wraps a strict object schema so that `x-*` keys are accepted and preserved: they are lifted out of the input,
 * the rest is parsed by `schema` (where any other unknown key is an error), and they are put back on the
 * result.
 */
export function withExtensions<S extends z.ZodType>(schema: S) {
  return z.unknown().transform((input, ctx): z.output<S> & Extensions => {
    let core: unknown = input;
    let extensions: [string, unknown][] = [];
    if (isPlainObject(input)) {
      const entries = Object.entries(input);
      extensions = entries.filter(([k]) => isExtensionKey(k));
      // Object.fromEntries defines own properties, so a hostile "__proto__" key cannot set a prototype.
      if (extensions.length > 0) core = Object.fromEntries(entries.filter(([k]) => !isExtensionKey(k)));
    }
    const result = schema.safeParse(core);
    if (!result.success) {
      forwardIssues(ctx, result.error);
      return z.NEVER;
    }
    if (extensions.length === 0) return result.data as z.output<S> & Extensions;
    // Object spread defines own properties too.
    return { ...(result.data as object), ...Object.fromEntries(extensions) } as z.output<S> & Extensions;
  });
}

// ---- leaves

const text = z.string().max(L.maxTextChars, `text fields hold at most ${L.maxTextChars} characters`);
const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const hex = z.string().regex(HEX_PATTERN, 'a color must be sRGB hex "#rrggbb"');
const partId = z.string().regex(PART_ID_PATTERN, 'an id must match /^[a-z][a-z0-9_]{0,31}$/ (lower case, starts with a letter, at most 32 characters)');
const colorId = z.string().regex(COLOR_ID_PATTERN, 'a palette id must match /^[a-z0-9_]{1,16}$/');
/** One linear dimension of a part, inches. */
const dim = z
  .number()
  .min(L.minDimIn, `dims must be at least ${L.minDimIn} in`)
  .max(L.maxDimIn, `dims must be at most ${L.maxDimIn} in`);
const fraction = z.number().min(0).max(1);
const azimuthDeg = z.number().min(-360).max(360);
const elevationDeg = z.number().min(-90).max(90);
const positive = z.number().gt(0);

export const paletteColorSchema = z.strictObject({
  id: colorId,
  hex,
  name: text.optional(),
  role: z.enum(['main', 'accent', 'detail']).optional(),
});

// ---- regions

const fromTo = (ctx: z.core.ParsePayload<{ from?: number; to?: number }>): void => {
  const { from, to } = ctx.value;
  if (from !== undefined && to !== undefined && from > to) {
    ctx.issues.push({ code: 'custom', message: `"from" (${from}) must not be above "to" (${to})`, input: ctx.value, path: ['from'] });
  }
};

export const regionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('band'), from: fraction, to: fraction, color: colorId }).check(fromTo),
  z
    .strictObject({
      kind: z.literal('stripes'),
      from: fraction.optional(),
      to: fraction.optional(),
      colors: z.array(colorId).min(1),
      widthIn: positive.max(L.maxDimIn),
    })
    .check(fromTo),
  z
    .strictObject({
      kind: z.literal('patch'),
      azimuthDeg,
      spanDeg: positive.max(360),
      from: fraction,
      to: fraction,
      color: colorId,
    })
    .check(fromTo),
  z.strictObject({ kind: z.literal('spot'), azimuthDeg, elevationDeg, radiusIn: positive.max(L.maxDimIn), color: colorId }),
  z
    .strictObject({
      kind: z.literal('pattern'),
      pattern: z.enum(['spots', 'leopard', 'checker', 'speckle', 'gradient', 'vertical-stripes']),
      colors: z.array(colorId).min(1),
      scaleIn: positive.max(L.maxDimIn).optional(),
      coverage: fraction.optional(),
      from: fraction.optional(),
      to: fraction.optional(),
    })
    .check(fromTo),
]);

// ---- features

export const featureSchema = z.strictObject({
  id: partId,
  kind: z.enum(['safety_eye', 'embroidered_eye', 'felt', 'nose', 'mouth', 'cheek', 'brow', 'whiskers', 'line', 'applique']),
  on: partId,
  azimuthDeg,
  elevationDeg,
  sizeMm: positive.optional(),
  sizeIn: positive.max(L.maxDimIn).optional(),
  color: colorId.optional(),
  path: z.array(z.tuple([azimuthDeg, elevationDeg])).optional(),
  mirror: z.boolean().optional(),
});

// ---- parts

const crochetHintsSchema = z.strictObject({
  make: z.enum(['auto', 'piece', 'applique', 'embroidery', 'safety_eye', 'region', 'skip']).optional(),
  start: z.enum(['auto', 'bottom', 'top']).optional(),
  axis: z.enum(['auto', 'x', 'y', 'z']).optional(),
  seed: vec3.optional(),
  style: z.enum(['classic', 'exact']).optional(),
  seamAzimuthDeg: z.number().min(-360).max(360).optional(),
});

/** base64 of exactly 64 × 64 bytes (5464 characters with its padding). */
const UV64_BASE64 = /^[A-Za-z0-9+/]{5461}[AQgw]==$/;

const paintSchema = z.strictObject({
  kind: z.literal('uv64'),
  data: z.string().regex(UV64_BASE64, 'paint.data must be base64 of exactly 64 × 64 bytes'),
});

const partCommon = {
  id: partId,
  label: text.optional(),
  position: vec3,
  rotationDeg: vec3.optional(),
  color: colorId,
  regions: z.array(regionSchema).max(L.maxRegionsPerPart, `a part holds at most ${L.maxRegionsPerPart} regions`).optional(),
  attach: z
    .strictObject({
      to: partId,
      method: z.enum(['sewn', 'crochet-in-place', 'worked-from', 'glued', 'none']).optional(),
      openEnd: z.enum(['top', 'bottom', 'none']).optional(),
    })
    .optional(),
  mirrorOf: partId.optional(),
  stuffing: z.enum(['firm', 'medium', 'light', 'none']).optional(),
  flatten: fraction.optional(),
  notes: text.optional(),
  crochet: crochetHintsSchema.optional(),
  paint: paintSchema.optional(),
};

const capsuleDims = z.strictObject({ r: dim, length: dim }).check((ctx) => {
  const { r, length } = ctx.value;
  if (length < 2 * r - 1e-9) {
    ctx.issues.push({
      code: 'custom',
      message: `capsule length is the TOTAL length including both caps: ${length} is less than 2·r = ${2 * r}`,
      input: ctx.value,
      path: ['length'],
    });
  }
});

const profilePoint = z.tuple([
  z.number().min(0, 'a profile radius must not be negative').max(L.maxDimIn),
  z.number().min(-L.maxDimIn).max(L.maxDimIn),
]);

const latheDims = z
  .strictObject({
    profile: z
      .array(profilePoint)
      .min(L.minProfilePoints, `a lathe profile needs at least ${L.minProfilePoints} points`)
      .max(L.maxProfilePoints, `a lathe profile holds at most ${L.maxProfilePoints} points`),
    sharp: z.array(z.number().int().min(0)).max(L.maxProfilePoints).optional(),
  })
  .check((ctx) => {
    const { profile, sharp } = ctx.value;
    let maxR = 0;
    for (let i = 0; i < profile.length; i++) {
      maxR = Math.max(maxR, profile[i][0]);
      if (i > 0 && profile[i][1] < profile[i - 1][1]) {
        ctx.issues.push({
          code: 'custom',
          message: `profile y must not decrease (bottom → top): point ${i} has y = ${profile[i][1]} after y = ${profile[i - 1][1]}`,
          input: ctx.value,
          path: ['profile', i, 1],
        });
      }
    }
    const height = profile.length > 0 ? profile[profile.length - 1][1] - profile[0][1] : 0;
    if (maxR < L.minDimIn) {
      ctx.issues.push({ code: 'custom', message: `the profile's largest radius must be at least ${L.minDimIn} in`, input: ctx.value, path: ['profile'] });
    }
    if (height < L.minDimIn || height > L.maxDimIn) {
      ctx.issues.push({
        code: 'custom',
        message: `the profile's height (last y − first y) must be between ${L.minDimIn} and ${L.maxDimIn} in`,
        input: ctx.value,
        path: ['profile'],
      });
    }
    sharp?.forEach((index, i) => {
      if (index >= profile.length) {
        ctx.issues.push({ code: 'custom', message: `sharp index ${index} is not a profile point`, input: ctx.value, path: ['sharp', i] });
      }
    });
  });

const flatDims = z
  .strictObject({
    shape: z.enum(['circle', 'oval', 'teardrop', 'triangle', 'rect', 'polygon']),
    w: dim,
    h: dim,
    thickness: dim,
    points: z
      .array(z.tuple([z.number().min(-L.maxDimIn).max(L.maxDimIn), z.number().min(-L.maxDimIn).max(L.maxDimIn)]))
      .min(L.minPolygonPoints, `a polygon needs at least ${L.minPolygonPoints} points`)
      .max(L.maxPolygonPoints, `a polygon holds at most ${L.maxPolygonPoints} points`)
      .optional(),
  })
  .check((ctx) => {
    if (ctx.value.shape === 'polygon' && !ctx.value.points) {
      ctx.issues.push({ code: 'custom', message: 'a flat part with shape "polygon" needs "points"', input: ctx.value, path: ['points'] });
    }
  });

/** One part without extension keys: every member is a strict object (JSON-Schema-representable). */
export const partCoreSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...partCommon, type: z.literal('sphere'), dims: z.strictObject({ r: dim }) }),
  z.strictObject({ ...partCommon, type: z.literal('ellipsoid'), dims: z.strictObject({ rx: dim, ry: dim, rz: dim }) }),
  z.strictObject({ ...partCommon, type: z.literal('capsule'), dims: capsuleDims }),
  z.strictObject({
    ...partCommon,
    type: z.literal('cylinder'),
    dims: z.strictObject({ rTop: dim, rBottom: dim, h: dim, open: z.enum(['none', 'top', 'bottom', 'both']).optional() }),
  }),
  z.strictObject({ ...partCommon, type: z.literal('cone'), dims: z.strictObject({ r: dim, h: dim }) }),
  z.strictObject({
    ...partCommon,
    type: z.literal('torus'),
    dims: z.strictObject({ R: dim, r: dim, arcDeg: z.number().gt(0).max(360).optional() }),
  }),
  z.strictObject({ ...partCommon, type: z.literal('lathe'), dims: latheDims }),
  z.strictObject({ ...partCommon, type: z.literal('flat'), dims: flatDims }),
  z.strictObject({ ...partCommon, type: z.literal('box'), dims: z.strictObject({ w: dim, h: dim, d: dim }) }),
  z.strictObject({
    ...partCommon,
    type: z.literal('mesh'),
    dims: z.strictObject({
      meshRef: z.string().min(1).max(L.maxTextChars),
      bboxIn: z.tuple([positive.max(L.maxDimIn), positive.max(L.maxDimIn), positive.max(L.maxDimIn)]),
    }),
  }),
]);

/** One part; `x-*` keys are kept. */
export const partSchema = withExtensions(partCoreSchema);

// ---- model

function modelObject<P extends z.ZodType>(part: P) {
  return z.strictObject({
    schema: z.literal('crochet-model'),
    version: z.string().regex(VERSION_PATTERN, 'version must be "1.x" (this app reads crochet-model 1.0 and its minor revisions)'),
    revision: z.number().int().min(0),
    units: z.literal('in'),
    axes: z.strictObject({ up: z.literal('+Y'), front: z.literal('+Z'), left: z.literal('+X') }),
    name: text,
    description: text.optional(),
    category: z.enum(['quadruped', 'biped', 'bird', 'sea', 'insect', 'person', 'creature', 'food', 'plant', 'object', 'other']).optional(),
    style: z.enum(['chibi', 'realistic', 'minimal']).optional(),
    audience: z.enum(['adult', 'child', 'under3']).optional(),
    finishedSize: z.strictObject({
      height: positive.max(L.maxHeightIn, `finishedSize.height must be at most ${L.maxHeightIn} in`),
      width: positive.optional(),
      depth: positive.optional(),
    }),
    pose: z.enum(['standing', 'sitting', 'lying', 'hanging', 'free']).optional(),
    flatBase: z.boolean().optional(),
    yarn: z
      .strictObject({
        weightCYC: z.literal([0, 1, 2, 3, 4, 5, 6, 7]).optional(),
        hookMm: positive.optional(),
        stsPerIn: positive.optional(),
        fiber: text.optional(),
      })
      .optional(),
    palette: z
      .array(paletteColorSchema)
      .min(1, 'the palette needs at least one color')
      .max(L.maxPalette, `the palette holds at most ${L.maxPalette} colors`),
    parts: z.array(part).min(1, 'a model needs at least one part').max(L.maxParts, `a model holds at most ${L.maxParts} parts`),
    features: z.array(featureSchema).max(L.maxFeatures, `a model holds at most ${L.maxFeatures} features`).optional(),
    assembly: z.array(z.strictObject({ order: z.number(), part: text, to: text.optional(), text })).optional(),
    assumptions: z.array(text).optional(),
    source: z
      .strictObject({
        tool: text.optional(),
        stage: z.enum(['seed', 'refined', 'edited', 'recon', 'refined-from-mesh']).optional(),
        views: z.array(text).optional(),
        createdAt: text.optional(),
        promptVersion: text.optional(),
        builderVersion: text.optional(),
      })
      .optional(),
  });
}

/**
 * The model without extension keys anywhere — strict objects only, so `z.toJSONSchema` can represent it
 * (`npm run schema`, §3.5.2, adds `patternProperties: {"^x-": {}}` to the model and part objects). It does not
 * run the document checks of `crochetModelSchema` (references, uniqueness, document limits).
 */
export const crochetModelCoreSchema = modelObject(partCoreSchema);

const modelWithExtensions = withExtensions(modelObject(partSchema));

type ParsedModel = z.output<typeof modelWithExtensions>;

/** The checks that need the whole document: unique ids, references, the attach graph. */
function checkReferences(model: ParsedModel, issue: (message: string, path: PropertyKey[]) => void): void {
  const colors = new Set<string>();
  model.palette.forEach((c, i) => {
    if (colors.has(c.id)) issue(`duplicate palette id "${c.id}"`, ['palette', i, 'id']);
    colors.add(c.id);
  });
  const color = (id: string | undefined, path: PropertyKey[]): void => {
    if (id !== undefined && !colors.has(id)) issue(`color "${id}" is not in the palette`, path);
  };

  const index = new Map<string, number>();
  model.parts.forEach((p, i) => {
    if (index.has(p.id)) issue(`duplicate part id "${p.id}"`, ['parts', i, 'id']);
    else index.set(p.id, i);
  });

  model.parts.forEach((p, i) => {
    color(p.color, ['parts', i, 'color']);
    p.regions?.forEach((r, j) => {
      if (r.kind === 'stripes' || r.kind === 'pattern') r.colors.forEach((c, k) => color(c, ['parts', i, 'regions', j, 'colors', k]));
      else color(r.color, ['parts', i, 'regions', j, 'color']);
    });
    if (p.attach) {
      if (p.attach.to === p.id) issue(`part "${p.id}" is attached to itself`, ['parts', i, 'attach', 'to']);
      else if (!index.has(p.attach.to)) issue(`part "${p.id}" is attached to "${p.attach.to}", which does not exist`, ['parts', i, 'attach', 'to']);
    }
    if (p.mirrorOf !== undefined) {
      const twinAt = index.get(p.mirrorOf);
      const twin = twinAt === undefined ? undefined : model.parts[twinAt];
      if (p.mirrorOf === p.id) issue(`part "${p.id}" mirrors itself`, ['parts', i, 'mirrorOf']);
      else if (!twin) issue(`part "${p.id}" mirrors "${p.mirrorOf}", which does not exist`, ['parts', i, 'mirrorOf']);
      // mirrorOf names the source of a mirror pair: never a part that is itself a mirror (no chains, no loops) …
      else if (twin.mirrorOf !== undefined) {
        issue(`part "${p.id}" mirrors "${twin.id}", which itself mirrors "${twin.mirrorOf}": mirrorOf must name a part without mirrorOf`, ['parts', i, 'mirrorOf']);
      }
      // … and a mirror image has the type of its source.
      else if (twin.type !== p.type) issue(`part "${p.id}" (a ${p.type}) mirrors "${twin.id}", a ${twin.type}`, ['parts', i, 'mirrorOf']);
    }
  });

  // Attach cycles: follow each part toward its root; a walk longer than the part count has looped.
  const reported = new Set<number>();
  model.parts.forEach((p, i) => {
    let at = i;
    const seen = new Set<number>([i]);
    for (;;) {
      const to = model.parts[at].attach?.to;
      const next = to === undefined ? undefined : index.get(to);
      if (next === undefined || next === at) return;
      if (seen.has(next)) {
        if (next === i && !reported.has(i)) {
          for (const k of seen) reported.add(k);
          issue(`the attach links form a cycle through "${p.id}"`, ['parts', i, 'attach', 'to']);
        }
        return;
      }
      seen.add(next);
      at = next;
    }
  });

  const features = new Set<string>();
  model.features?.forEach((f, i) => {
    if (features.has(f.id)) issue(`duplicate feature id "${f.id}"`, ['features', i, 'id']);
    features.add(f.id);
    if (!index.has(f.on)) issue(`feature "${f.id}" sits on "${f.on}", which does not exist`, ['features', i, 'on']);
    color(f.color, ['features', i, 'color']);
  });
}

/** Depth, size and forbidden keys of the raw document (§3.5.2, §3.7.6): checked before anything is parsed. */
function documentLimitIssue(input: unknown): string | null {
  // Depth and forbidden keys, iteratively (a hostile document may be deep or cyclic).
  const stack: { value: unknown; depth: number }[] = [{ value: input, depth: 1 }];
  let visited = 0;
  while (stack.length > 0) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    if (typeof value !== 'object' || value === null) continue;
    if (depth > L.maxDepth) return `the document nests deeper than ${L.maxDepth} levels`;
    if (++visited > 2_000_000) return 'the document holds too many values';
    if (Array.isArray(value)) {
      for (const v of value) stack.push({ value: v, depth: depth + 1 });
    } else {
      for (const key of Object.keys(value)) {
        if (FORBIDDEN_KEYS.has(key)) return `the key "${key}" is not allowed in a model`;
        stack.push({ value: (value as Record<string, unknown>)[key], depth: depth + 1 });
      }
    }
  }
  let json: string | undefined;
  try {
    json = JSON.stringify(input);
  } catch {
    return 'the document is not plain JSON data';
  }
  if (json === undefined) return null; // not an object at all: the schema reports it
  if (json.length > L.maxBytes || new TextEncoder().encode(json).length > L.maxBytes) {
    return `the document is larger than ${L.maxBytes / (1024 * 1024)} MB`;
  }
  return null;
}

/**
 * The strict schema of a whole model (§3.5.1, limits and semantics of §3.5.2): `parse(x)` deep-equals `x` for a
 * valid model; `x-*` keys on the model and on parts are kept; any other unknown key, a broken reference
 * (palette id, `attach.to`, `mirrorOf`, `feature.on`), a duplicate id or an attach cycle is an error. `mirrorOf`
 * must name a part of the same type that has no `mirrorOf` itself (no mirror chains or loops; not in §3.5.1,
 * see docs/tracks/s0b-model.md).
 */
export const crochetModelSchema: z.ZodType<CrochetModelV1, unknown> = z.unknown().transform((input, ctx): CrochetModelV1 => {
  const limit = documentLimitIssue(input);
  if (limit !== null) {
    ctx.issues.push({ code: 'custom', message: limit, input });
    return z.NEVER;
  }
  const result = modelWithExtensions.safeParse(input);
  if (!result.success) {
    forwardIssues(ctx, result.error);
    return z.NEVER;
  }
  let failed = false;
  checkReferences(result.data, (message, path) => {
    failed = true;
    ctx.issues.push({ code: 'custom', message, input, path });
  });
  return failed ? z.NEVER : result.data;
});

// ---- validation with readable messages

export interface ModelIssue {
  /** Where: `parts[3].dims.r`; empty for the document itself. */
  path: string;
  message: string;
}

/** `parts[3] (arm_l).dims.length` — the path of an issue, with the part, feature or color it names. */
function describePath(path: readonly PropertyKey[], input: unknown): string {
  let out = '';
  let at: unknown = input;
  for (let i = 0; i < path.length; i++) {
    const key = path[i];
    if (typeof key === 'number') out += `[${key}]`;
    else out += out === '' ? String(key) : `.${String(key)}`;
    at = isPlainObject(at) || Array.isArray(at) ? (at as Record<PropertyKey, unknown>)[key] : undefined;
    const parent = path[i - 1];
    if (typeof key === 'number' && (parent === 'parts' || parent === 'features' || parent === 'palette') && isPlainObject(at)) {
      if (typeof at.id === 'string' && at.id.length <= 40) out += ` (${at.id})`;
    }
  }
  return out;
}

function toModelIssues(error: z.ZodError, input: unknown): ModelIssue[] {
  return error.issues.map((issue) => ({ path: describePath(issue.path, input), message: issue.message }));
}

/** The error `parseModel` throws: its message lists every problem with its path. */
export class ModelValidationError extends Error {
  readonly issues: ModelIssue[];

  constructor(issues: ModelIssue[]) {
    super(`invalid crochet-model:\n${issues.map((i) => `- ${i.path === '' ? '' : `${i.path}: `}${i.message}`).join('\n')}`);
    this.name = 'ModelValidationError';
    this.issues = issues;
  }
}

/** Validates a model; never throws. */
export function validateModel(input: unknown): { ok: true; model: CrochetModelV1 } | { ok: false; issues: ModelIssue[] } {
  const result = crochetModelSchema.safeParse(input);
  if (result.success) return { ok: true, model: result.data };
  return { ok: false, issues: toModelIssues(result.error, input) };
}

/** Validates a model and returns it; throws `ModelValidationError` with one line per problem. */
export function parseModel(input: unknown): CrochetModelV1 {
  const result = validateModel(input);
  if (!result.ok) throw new ModelValidationError(result.issues);
  return result.model;
}

// ---- canonical writing

const MODEL_KEYS = [
  'schema',
  'version',
  'revision',
  'units',
  'axes',
  'name',
  'description',
  'category',
  'style',
  'audience',
  'finishedSize',
  'pose',
  'flatBase',
  'yarn',
  'palette',
  'parts',
  'features',
  'assembly',
  'assumptions',
  'source',
];
const PART_KEYS = ['id', 'label', 'type', 'dims', 'position', 'rotationDeg', 'color', 'regions', 'attach', 'mirrorOf', 'stuffing', 'flatten', 'notes', 'crochet', 'paint'];
const DIMS_KEYS = ['shape', 'meshRef', 'bboxIn', 'R', 'r', 'rx', 'ry', 'rz', 'length', 'rTop', 'rBottom', 'w', 'h', 'd', 'thickness', 'open', 'arcDeg', 'profile', 'sharp', 'points'];
const REGION_KEYS = ['kind', 'pattern', 'azimuthDeg', 'elevationDeg', 'spanDeg', 'from', 'to', 'radiusIn', 'color', 'colors', 'widthIn', 'scaleIn', 'coverage'];
const FEATURE_KEYS = ['id', 'kind', 'on', 'azimuthDeg', 'elevationDeg', 'sizeMm', 'sizeIn', 'color', 'path', 'mirror'];

/** A copy with the listed keys first (in that order), then any other key, then the `x-*` keys, each group in code-unit order. */
function ordered(value: unknown, keys: readonly string[], nested: Record<string, (v: unknown) => unknown> = {}): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  const put = (key: string): void => {
    const v = value[key];
    if (v === undefined) return;
    const fn = Object.hasOwn(nested, key) ? nested[key] : undefined;
    Object.defineProperty(out, key, { value: fn ? fn(v) : v, enumerable: true, writable: true, configurable: true });
  };
  for (const key of keys) if (Object.hasOwn(value, key)) put(key);
  const rest = Object.keys(value)
    .filter((k) => !keys.includes(k))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const key of rest) if (!isExtensionKey(key)) put(key);
  for (const key of rest) if (isExtensionKey(key)) put(key);
  return out;
}

const each =
  (fn: (v: unknown) => unknown) =>
  (v: unknown): unknown =>
    Array.isArray(v) ? v.map(fn) : v;

/**
 * The model with its keys in the canonical order — the field order of §3.5.1 (`type` and `dims` right after
 * `label`), then the `x-*` keys. Values are not changed; `undefined` properties are dropped.
 */
export function canonicalizeModel(model: CrochetModelV1): CrochetModelV1 {
  const part = (p: unknown): unknown =>
    ordered(p, PART_KEYS, {
      dims: (d) => ordered(d, DIMS_KEYS),
      regions: each((r) => ordered(r, REGION_KEYS)),
      attach: (a) => ordered(a, ['to', 'method', 'openEnd']),
      crochet: (c) => ordered(c, ['make', 'start', 'axis', 'seed', 'style', 'seamAzimuthDeg']),
      paint: (c) => ordered(c, ['kind', 'data']),
    });
  return ordered(model, MODEL_KEYS, {
    axes: (a) => ordered(a, ['up', 'front', 'left']),
    finishedSize: (s) => ordered(s, ['height', 'width', 'depth']),
    yarn: (y) => ordered(y, ['weightCYC', 'hookMm', 'stsPerIn', 'fiber']),
    palette: each((c) => ordered(c, ['id', 'hex', 'name', 'role'])),
    parts: each(part),
    features: each((f) => ordered(f, FEATURE_KEYS)),
    assembly: each((s) => ordered(s, ['order', 'part', 'to', 'text'])),
    source: (s) => ordered(s, ['tool', 'stage', 'views', 'createdAt', 'promptVersion', 'builderVersion']),
  }) as CrochetModelV1;
}

const isPrimitive = (v: unknown): boolean => v === null || typeof v !== 'object';
const isPrimitiveArray = (v: unknown): boolean => Array.isArray(v) && v.every(isPrimitive);

/** JSON with two-space indentation, except that an array of plain values (a vector, a profile point) stays on one line. */
function writeJson(value: unknown, indent: string): string {
  if (isPrimitive(value)) return JSON.stringify(value) ?? 'null';
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (isPrimitiveArray(value)) return `[${value.map((v) => JSON.stringify(v) ?? 'null').join(', ')}]`;
    return `[\n${value.map((v) => inner + writeJson(v, inner)).join(',\n')}\n${indent}]`;
  }
  const fields = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined && typeof v !== 'function');
  if (fields.length === 0) return '{}';
  return `{\n${fields.map(([k, v]) => `${inner}${JSON.stringify(k)}: ${writeJson(v, inner)}`).join(',\n')}\n${indent}}`;
}

/**
 * The canonical text of a model: keys in the order of `canonicalizeModel`, two-space indentation, arrays of
 * plain values on one line, a final newline. This is the byte format of `fixtures/models/*.json`; equal models
 * give equal text whatever order their keys were built in.
 */
export function stringifyModel(model: CrochetModelV1): string {
  return `${writeJson(canonicalizeModel(model), '')}\n`;
}

// ---- compile-time guard: the schema and the frozen types describe the same data
//
// Mutual assignability catches a changed type, a missing required field and a changed enum; it cannot see an
// OPTIONAL field that exists on one side only, so the key sets of every object are compared as well.

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** The keys of every member of a union. */
type Keys<T> = T extends unknown ? keyof T : never;
type SameKeys<A, B> = [Keys<A>] extends [Keys<B>] ? ([Keys<B>] extends [Keys<A>] ? true : false) : false;
/** For a union discriminated by `K`: the keys of `Field` agree for every value of the discriminant. */
type SameKeysPerMember<A, B, K extends string, Field extends string> = {
  [V in (A | B) extends Record<K, infer D> ? D & string : never]: SameKeys<
    NonNullable<Extract<A, Record<K, V>>[Field & keyof Extract<A, Record<K, V>>]>,
    NonNullable<Extract<B, Record<K, V>>[Field & keyof Extract<B, Record<K, V>>]>
  >;
}[(A | B) extends Record<K, infer D> ? D & string : never];
type Guard<T extends true> = T;

type ParsedPart = z.output<typeof partSchema>;
type ParsedRegion = z.output<typeof regionSchema>;
type Item<T> = T extends readonly (infer U)[] ? U : never;

export type SchemaMatchesTypes = [
  Guard<MutuallyAssignable<ParsedModel, CrochetModelV1>>,
  Guard<MutuallyAssignable<ParsedPart, Part>>,
  Guard<MutuallyAssignable<ParsedRegion, Region>>,
  Guard<MutuallyAssignable<z.output<typeof featureSchema>, Feature>>,
  Guard<MutuallyAssignable<z.output<typeof paletteColorSchema>, PaletteColor>>,
  // key sets
  Guard<SameKeys<ParsedModel, CrochetModelV1>>,
  Guard<SameKeys<ParsedModel['axes'], CrochetModelV1['axes']>>,
  Guard<SameKeys<ParsedModel['finishedSize'], CrochetModelV1['finishedSize']>>,
  Guard<SameKeys<NonNullable<ParsedModel['yarn']>, NonNullable<CrochetModelV1['yarn']>>>,
  Guard<SameKeys<NonNullable<ParsedModel['source']>, NonNullable<CrochetModelV1['source']>>>,
  Guard<SameKeys<Item<NonNullable<ParsedModel['assembly']>>, Item<NonNullable<CrochetModelV1['assembly']>>>>,
  Guard<SameKeys<z.output<typeof paletteColorSchema>, PaletteColor>>,
  Guard<SameKeys<z.output<typeof featureSchema>, Feature>>,
  Guard<SameKeys<ParsedPart, Part>>,
  Guard<SameKeys<NonNullable<ParsedPart['attach']>, NonNullable<Part['attach']>>>,
  Guard<SameKeys<NonNullable<ParsedPart['crochet']>, NonNullable<Part['crochet']>>>,
  Guard<SameKeys<NonNullable<ParsedPart['paint']>, NonNullable<Part['paint']>>>,
  Guard<SameKeysPerMember<ParsedPart, Part, 'type', 'dims'>>,
  Guard<SameKeys<ParsedRegion, Region>>,
  Guard<SameKeysPerRegion>,
];

/** Every region kind has the same keys on both sides. */
type SameKeysPerRegion = {
  [V in Region['kind']]: SameKeys<Extract<ParsedRegion, { kind: V }>, Extract<Region, { kind: V }>>;
}[Region['kind']];
