// Test helper: turns the observed Claude Design teddy (fixtures/claude-design/teddy-bear) into the canonical
// model with the Step 0 kernels. This is the generator of `fixtures/models/teddy.canonical.json`
// (fixtures.test.ts regenerates the file and compares it byte for byte); track T7's importer must reproduce the
// same file (golden G12). The recipe is written out in docs/tracks/s0b-model.md.
//
// It implements only what the teddy needs of DESIGN.md §3.7.3 (dialect normalization) and §3.7.6 (repairs); the
// real, general normalizer is T7's `core/importer/dialect.ts` + `repair.ts`.
import { readFileSync } from 'node:fs';
import type { Repair } from '../../../../types/importer';
import type { CrochetModelV1, Part, Vec3 } from '../../../../types/model';
import { inferAttach, inferMirrorPairs } from '../../attach';
import { composeRigid, decomposeRigid, groundModel, modelBounds, multiplyRigid, type Rigid, roundCoord, roundModel } from '../../transforms';

export const FIXTURES_DIR = new URL('../../../../../fixtures/', import.meta.url);
export const OBSERVED_TEDDY_URL = new URL('claude-design/teddy-bear/teddy-bear.crochet-model.json', FIXTURES_DIR);
export const CANONICAL_TEDDY_URL = new URL('models/teddy.canonical.json', FIXTURES_DIR);
export const EVERY_TYPE_URL = new URL('models/every-type.json', FIXTURES_DIR);
export const EVERY_TYPE_MESH_URL = new URL('models/every-type.mesh.json', FIXTURES_DIR);

/** A part as Claude Design wrote it (research 08). */
export interface ObservedPart {
  id: string;
  name?: string;
  type: string;
  dimensions: Record<string, number>;
  position: Vec3;
  rotationDeg?: Vec3;
  color: string;
  parent: string | null;
}

export interface ObservedSpec {
  schema: 'crochet-model';
  version: string;
  units: 'in';
  axes: { up: '+Y'; front: '+Z' };
  finishedSize: { height: number };
  palette: Record<string, string>;
  notes?: string;
  name?: string;
  parts: ObservedPart[];
}

export function readObservedTeddy(): ObservedSpec {
  return JSON.parse(readFileSync(OBSERVED_TEDDY_URL, 'utf8')) as ObservedSpec;
}

/** The name a normalized model gets when its source has none. */
export const DEFAULT_MODEL_NAME = 'Imported model';

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/** §2.10.1 rule 1, by name: the dialect keeps eyes as parts and marks them as safety eyes. */
const isEyeLike = (p: ObservedPart): boolean => /eye/i.test(p.id) || /eye/i.test(p.name ?? '');

/** Dims in canonical keys; a capsule's length becomes the TOTAL length (straight section + 2·radius). */
function canonicalDims(p: ObservedPart): Record<string, number> {
  const rename: Record<string, string> = { radius: 'r', radiusTop: 'rTop', radiusBottom: 'rBottom', height: 'h' };
  const dims: Record<string, number> = {};
  for (const [key, value] of Object.entries(p.dimensions)) dims[rename[key] ?? key] = value;
  if (p.type === 'capsule') dims.length = dims.length + 2 * dims.r;
  return dims;
}

/**
 * §3.7.3 for the observed dialect: canonical keys, total capsule lengths, a palette array, palette ids for
 * colors, `label`, absolute positions and rotations (`World = World(parent) · T(position) · R_XYZ(rotationDeg)`),
 * `attach` from `parent`, eyes marked, the missing header fields filled in, `notes` kept in `assumptions`.
 * Nothing is rounded, grounded or inferred here.
 */
export function normalizeObservedDialect(raw: ObservedSpec): CrochetModelV1 {
  const palette: CrochetModelV1['palette'] = [];
  const idOfHex = new Map<string, string>();
  for (const [hex, name] of Object.entries(raw.palette)) {
    const base = slug(name).slice(0, 16) || 'color';
    let id = base;
    for (let n = 2; palette.some((c) => c.id === id); n++) id = `${base.slice(0, 16 - String(n).length - 1)}_${n}`;
    palette.push({ id, hex, name });
    idOfHex.set(hex.toLowerCase(), id);
  }

  const byId = new Map(raw.parts.map((p) => [p.id, p]));
  const worlds = new Map<string, Rigid>();
  const worldOf = (p: ObservedPart): Rigid => {
    let w = worlds.get(p.id);
    if (!w) {
      const local = composeRigid(p.position, p.rotationDeg);
      const parent = p.parent === null ? undefined : byId.get(p.parent);
      w = parent ? multiplyRigid(worldOf(parent), local) : local;
      worlds.set(p.id, w);
    }
    return w;
  };

  const parts = raw.parts.map((p): Part => {
    const { position, rotationDeg } = decomposeRigid(worldOf(p));
    const colorId = idOfHex.get(p.color.toLowerCase());
    if (colorId === undefined) throw new Error(`teddy helper: color ${p.color} of ${p.id} is not in the palette`);
    const part: Record<string, unknown> = { id: p.id };
    if (p.name !== undefined) part.label = p.name;
    part.type = p.type;
    part.dims = canonicalDims(p);
    part.position = position;
    if (p.rotationDeg !== undefined) part.rotationDeg = rotationDeg;
    part.color = colorId;
    if (p.parent !== null) part.attach = { to: p.parent, method: 'sewn' };
    if (isEyeLike(p)) part.crochet = { make: 'safety_eye' };
    return part as unknown as Part;
  });

  const model: CrochetModelV1 = {
    schema: 'crochet-model',
    version: raw.version,
    revision: 0,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: raw.name ?? DEFAULT_MODEL_NAME,
    finishedSize: { height: raw.finishedSize.height },
    palette,
    parts,
    source: { tool: 'claude-design', stage: 'refined' },
  };
  if (raw.notes !== undefined) model.assumptions = [raw.notes];
  return model;
}

export interface CanonicalTeddy {
  /** After dialect normalization only (§3.7.3 goldens are stated "before grounding"). */
  normalized: CrochetModelV1;
  /** The canonical model: units recorded, grounded, rounded, one attach tree, mirror pairs. */
  model: CrochetModelV1;
  /** The grounding shift that was added to every y. */
  groundDy: number;
  /** The measured bounding-box height (before rounding). */
  measuredHeight: number;
  repairs: Repair[];
}

/**
 * The canonical teddy, with the repairs of §3.7.6 in their order: units (the geometry is kept and the measured
 * height recorded in `finishedSize.height`), ground, rounding to 1e-6, `inferAttach`, `inferMirrorPairs`.
 */
export function buildCanonicalTeddy(raw: ObservedSpec = readObservedTeddy()): CanonicalTeddy {
  const normalized = normalizeObservedDialect(raw);
  const repairs: Repair[] = [];
  if (raw.notes !== undefined) {
    repairs.push({ code: 'unknown-key', message: 'unknown key "notes" removed (its text is kept in "assumptions")', data: { key: 'notes' } });
  }

  // units: |bbox height / finishedSize.height − 1| ≤ 0.15 → keep the geometry, record the measured height
  const b = modelBounds(normalized);
  const measuredHeight = b.max[1] - b.min[1];
  const stated = normalized.finishedSize.height;
  if (Math.abs(measuredHeight / stated - 1) > 0.15) throw new Error('teddy helper: the fixture is expected to need no rescale');
  let model: CrochetModelV1 = { ...normalized, finishedSize: { ...normalized.finishedSize, height: measuredHeight } };
  repairs.push({
    code: 'units',
    message: `the model measures ${roundCoord(measuredHeight, 2)} in tall (it says ${stated} in): kept as it is`,
    data: { statedHeightIn: stated, measuredHeightIn: roundCoord(measuredHeight, 4) },
  });

  // ground: lowest point at y = 0
  const grounded = groundModel(model);
  model = grounded.model;
  if (grounded.dy !== 0) {
    repairs.push({ code: 'ground', message: `moved up by ${roundCoord(grounded.dy, 4)} in so the lowest point is at y = 0`, data: { dy: roundCoord(grounded.dy, 4) } });
  }

  model = roundModel(model);

  const attached = inferAttach(model);
  const mirrored = inferMirrorPairs(attached.model);
  repairs.push(...attached.repairs, ...mirrored.repairs);
  return { normalized, model: mirrored.model, groundDy: grounded.dy, measuredHeight, repairs };
}
