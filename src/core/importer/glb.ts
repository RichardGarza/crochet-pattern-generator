// Track T7 — glTF / GLB (DESIGN.md §3.7.5). The 12-byte header and the chunks are read directly (no loader), and the
// ladder runs on the JSON, first match wins:
//   1. `nodes[].extras.crochetModel` → that spec (high; inches by definition). An archive's GLB is a spec candidate
//      only through this rung (§3.7.2).
//   2. nodes with `extras.crochet` (builder rule 4: each part's own JSON, absolute inches) → the parts as they are;
//      palette from the solid materials (name = color id, baseColorFactor linear → sRGB), ids used only on painted
//      parts from their COLOR_0 vertex colors, else gray; node matrices only checked (high, "spec rebuilt").
//   3. nodes with `extras.{type, dimensions}` (the observed dialect) → node name = part id, world matrices
//      composed down the hierarchy, colors linear → sRGB, scene units measured exactly as POSITION extent ÷ the
//      extent `extras.dimensions` implies (medium).
//   4. the triangles of every mesh node → the geometry-only path with the units rule (low).
import type { ImportContext, UnitsDecision } from '../../types/importer';
import type { Issue } from '../../types/issues';
import type { Part, Vec3 } from '../../types/model';
import { linearRgbToHex } from '../kernel/color';
import { partGeometry, vertexColorIds } from '../model/builder';
import {
  decomposeMat4,
  decomposeRigid,
  invertRigid,
  localBounds,
  modelHeight,
  multiplyMat4,
  multiplyRigid,
  rigidFromMat4,
  roundCoord,
  type Mat4,
} from '../model/transforms';
import { IMPORT_CODES, isPlainObject, issue, lookup, RepairLog } from './common';
import { normalizeSpec, type Normalized } from './dialect';
import { normalizeGeometry, type GeoColor, type GeoObject } from './geometry';
import { vertexColorPalette } from './plyStl';
import { materialColorName } from './obj';
import type { RepairOptions } from './repair';
import { isSpecLike, parseJsonSafe } from './text';
import { decideUnits, INCHES_PER_UNIT } from './units';

const GLB_MAGIC = 0x46546c67; // "glTF"
const CHUNK_JSON = 0x4e4f534a; // "JSON"
const CHUNK_BIN = 0x004e4942; // "BIN\0"

export type GlbJson = { ok: true; json: Record<string, unknown>; bin?: Uint8Array } | { ok: false; error: string; forbidden?: string };

/** The glTF JSON (and the BIN chunk) of a binary glTF 2.0 file. */
export function readGlbJson(bytes: Uint8Array): GlbJson {
  if (bytes.length < 20) return { ok: false, error: 'the GLB file is too short' };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return { ok: false, error: 'not a GLB file' };
  const version = view.getUint32(4, true);
  if (version !== 2) return { ok: false, error: `GLB version ${version} (this app reads version 2)` };
  const length = view.getUint32(12, true);
  if (view.getUint32(16, true) !== CHUNK_JSON || 20 + length > bytes.length) return { ok: false, error: 'the GLB has no readable JSON chunk' };
  const text = new TextDecoder().decode(bytes.subarray(20, 20 + length));
  const parsed = parseJsonSafe(text);
  if (!parsed.ok) return { ok: false, error: parsed.error, forbidden: parsed.forbidden };
  if (!isPlainObject(parsed.value)) return { ok: false, error: 'the GLB JSON is not an object' };
  // the BIN chunk follows the JSON chunk (4-byte aligned)
  let at = 20 + length;
  at += (4 - (at % 4)) % 4;
  let bin: Uint8Array | undefined;
  if (at + 8 <= bytes.length) {
    const binLength = view.getUint32(at, true);
    if (view.getUint32(at + 4, true) === CHUNK_BIN && at + 8 + binLength <= bytes.length) bin = bytes.subarray(at + 8, at + 8 + binLength);
  }
  return { ok: true, json: parsed.value, ...(bin ? { bin } : {}) };
}

/** Ladder step 1: the first node whose `extras.crochetModel` is a spec. */
export function specFromGltfJson(json: Record<string, unknown>): Record<string, unknown> | null {
  const nodes = Array.isArray(json.nodes) ? json.nodes : [];
  for (const node of nodes) {
    if (!isPlainObject(node) || !isPlainObject(node.extras)) continue;
    const spec = node.extras.crochetModel;
    if (isSpecLike(spec)) return spec as Record<string, unknown>;
  }
  const scenes = Array.isArray(json.scenes) ? json.scenes : [];
  for (const scene of scenes) if (isPlainObject(scene) && isPlainObject(scene.extras) && isSpecLike(scene.extras.crochetModel)) return scene.extras.crochetModel as Record<string, unknown>;
  return null;
}

// ---- the document: buffers, accessors, nodes

/** A glTF document with its binary buffers (GLB BIN chunk, `data:` URIs, or sibling files of the same drop). */
export class GltfDoc {
  readonly json: Record<string, unknown>;
  private readonly bin?: Uint8Array;
  private readonly sibling?: (uri: string) => Uint8Array | undefined;
  private readonly buffers = new Map<number, Uint8Array | null>();

  constructor(json: Record<string, unknown>, o: { bin?: Uint8Array; sibling?: (uri: string) => Uint8Array | undefined } = {}) {
    this.json = json;
    this.bin = o.bin;
    this.sibling = o.sibling;
  }

  list(key: string): unknown[] {
    const v = this.json[key];
    return Array.isArray(v) ? v : [];
  }

  item(key: string, index: unknown): Record<string, unknown> | undefined {
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) return undefined;
    const v = this.list(key)[index];
    return isPlainObject(v) ? v : undefined;
  }

  buffer(index: number): Uint8Array | undefined {
    if (this.buffers.has(index)) return this.buffers.get(index) ?? undefined;
    const b = this.item('buffers', index);
    let out: Uint8Array | undefined;
    if (b) {
      const uri = typeof b.uri === 'string' ? b.uri : undefined;
      if (uri === undefined) out = index === 0 ? this.bin : undefined;
      else if (uri.startsWith('data:')) out = decodeDataUri(uri);
      else {
        let name = uri;
        try {
          name = decodeURIComponent(uri);
        } catch {
          // a malformed %-escape: look the file up as written
        }
        out = this.sibling?.(name);
      }
      const declared = typeof b.byteLength === 'number' ? b.byteLength : undefined;
      if (out && declared !== undefined && out.length < declared) out = undefined;
    }
    this.buffers.set(index, out ?? null);
    return out;
  }

  /** An accessor's values as floats (normalized integers scaled to 0–1 / −1–1), or null when unreadable. */
  accessor(index: unknown): { data: Float64Array; count: number; size: number } | null {
    const a = this.item('accessors', index);
    if (!a || a.sparse !== undefined) return null;
    const size = lookup(TYPE_SIZE, String(a.type));
    const ct = lookup(COMPONENT, String(a.componentType));
    const count = a.count;
    if (size === undefined || ct === undefined || typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > 50_000_000) return null;
    const view = this.item('bufferViews', a.bufferView);
    if (!view || typeof view.buffer !== 'number') return null;
    const buf = this.buffer(view.buffer);
    if (!buf) return null;
    const viewOffset = (typeof view.byteOffset === 'number' ? view.byteOffset : 0) + (typeof a.byteOffset === 'number' ? a.byteOffset : 0);
    const elementBytes = size * ct.bytes;
    const stride = typeof view.byteStride === 'number' && view.byteStride >= elementBytes ? view.byteStride : elementBytes;
    const viewLength = typeof view.byteLength === 'number' ? view.byteLength : 0;
    const viewStart = typeof view.byteOffset === 'number' ? view.byteOffset : 0;
    const ok = (x: number): boolean => Number.isInteger(x) && x >= 0;
    if (!ok(viewOffset) || !ok(viewStart) || !ok(viewLength) || !ok(stride)) return null;
    if (count > 0 && (viewOffset + stride * (count - 1) + elementBytes > viewStart + viewLength || viewStart + viewLength > buf.length)) return null;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const data = new Float64Array(count * size);
    const normalized = a.normalized === true;
    for (let i = 0; i < count; i++) {
      const base = viewOffset + i * stride;
      for (let k = 0; k < size; k++) {
        let v = ct.read(dv, base + k * ct.bytes);
        if (normalized && ct.max > 0) v = Math.max(v / ct.max, -1);
        data[i * size + k] = v;
      }
    }
    return { data, count, size };
  }

  /** The local matrix of a node (column-major): `matrix`, else T·R·S. */
  localMatrix(node: Record<string, unknown>): Mat4 {
    const m = node.matrix;
    if (Array.isArray(m) && m.length === 16 && m.every((x) => typeof x === 'number' && Number.isFinite(x))) return m as number[];
    const t = vec(node.translation, 3) ?? [0, 0, 0];
    const q = vec(node.rotation, 4) ?? [0, 0, 0, 1];
    const s = vec(node.scale, 3) ?? [1, 1, 1];
    return trs(t, q, s);
  }

  /** Every node reachable from the scene (or every root), with its world matrix and its parent node index. */
  walk(): { index: number; node: Record<string, unknown>; world: Mat4; parent: number | null }[] {
    const nodes = this.list('nodes');
    const children = new Set<number>();
    for (const n of nodes) if (isPlainObject(n) && Array.isArray(n.children)) for (const c of n.children) if (typeof c === 'number') children.add(c);
    const scene = this.item('scenes', typeof this.json.scene === 'number' ? this.json.scene : 0);
    const roots = scene && Array.isArray(scene.nodes) ? scene.nodes.filter((x): x is number => typeof x === 'number') : nodes.map((_, i) => i).filter((i) => !children.has(i));
    const out: { index: number; node: Record<string, unknown>; world: Mat4; parent: number | null }[] = [];
    const seen = new Set<number>();
    const stack: { index: number; parentWorld: Mat4; parent: number | null; depth: number }[] = roots
      .slice()
      .reverse()
      .map((index) => ({ index, parentWorld: IDENTITY, parent: null, depth: 0 }));
    while (stack.length > 0) {
      const { index, parentWorld, parent, depth } = stack.pop() as (typeof stack)[number];
      const node = this.item('nodes', index);
      if (!node || seen.has(index) || depth > 64) continue;
      seen.add(index);
      const world = multiplyMat4(parentWorld, this.localMatrix(node));
      out.push({ index, node, world, parent });
      const kids = Array.isArray(node.children) ? node.children.filter((c): c is number => typeof c === 'number') : [];
      for (let k = kids.length - 1; k >= 0; k--) stack.push({ index: kids[k], parentWorld: world, parent: index, depth: depth + 1 });
    }
    return out;
  }

  /** The material of a node's first primitive. */
  material(node: Record<string, unknown>): { name: string; hex?: string; vertexColors: boolean; primitive?: Record<string, unknown> } | undefined {
    const mesh = this.item('meshes', node.mesh);
    const prim = mesh && Array.isArray(mesh.primitives) ? mesh.primitives.find(isPlainObject) : undefined;
    if (!prim) return undefined;
    const vertexColors = isPlainObject(prim.attributes) && prim.attributes.COLOR_0 !== undefined;
    const mat = this.item('materials', prim.material);
    const name = mat && typeof mat.name === 'string' ? mat.name : '';
    const pbr = mat && isPlainObject(mat.pbrMetallicRoughness) ? mat.pbrMetallicRoughness : undefined;
    const f = pbr ? vec(pbr.baseColorFactor, 4) ?? vec(pbr.baseColorFactor, 3) : undefined;
    // glTF's default base color is white; a material without a factor is reported without a color
    const hex = f ? linearRgbToHex(f[0], f[1], f[2]).toUpperCase() : undefined;
    return { name, ...(hex ? { hex } : {}), vertexColors, primitive: prim };
  }
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const TYPE_SIZE: Readonly<Record<string, number>> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
interface Component {
  bytes: number;
  max: number;
  read: (dv: DataView, at: number) => number;
}
const COMPONENT: Readonly<Record<string, Component>> = {
  '5120': { bytes: 1, max: 127, read: (dv, at) => dv.getInt8(at) },
  '5121': { bytes: 1, max: 255, read: (dv, at) => dv.getUint8(at) },
  '5122': { bytes: 2, max: 32767, read: (dv, at) => dv.getInt16(at, true) },
  '5123': { bytes: 2, max: 65535, read: (dv, at) => dv.getUint16(at, true) },
  '5125': { bytes: 4, max: 0, read: (dv, at) => dv.getUint32(at, true) },
  '5126': { bytes: 4, max: 0, read: (dv, at) => dv.getFloat32(at, true) },
};

function vec(value: unknown, n: number): number[] | undefined {
  return Array.isArray(value) && value.length === n && value.every((x) => typeof x === 'number' && Number.isFinite(x)) ? (value as number[]) : undefined;
}

/** T·R·S, column-major (the quaternion is x, y, z, w as glTF writes it). */
function trs(t: number[], q: number[], s: number[]): Mat4 {
  const [x, y, z, w] = q;
  const n = Math.hypot(x, y, z, w) || 1;
  const [qx, qy, qz, qw] = [x / n, y / n, z / n, w / n];
  const r = [
    1 - 2 * (qy * qy + qz * qz), 2 * (qx * qy + qz * qw), 2 * (qx * qz - qy * qw),
    2 * (qx * qy - qz * qw), 1 - 2 * (qx * qx + qz * qz), 2 * (qy * qz + qx * qw),
    2 * (qx * qz + qy * qw), 2 * (qy * qz - qx * qw), 1 - 2 * (qx * qx + qy * qy),
  ];
  return [r[0] * s[0], r[1] * s[0], r[2] * s[0], 0, r[3] * s[1], r[4] * s[1], r[5] * s[1], 0, r[6] * s[2], r[7] * s[2], r[8] * s[2], 0, t[0], t[1], t[2], 1];
}

function decodeDataUri(uri: string): Uint8Array | undefined {
  const comma = uri.indexOf(',');
  if (comma < 0 || !/;base64$/i.test(uri.slice(0, comma))) return undefined;
  try {
    const bin = atob(uri.slice(comma + 1));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

function transformPoint(m: Mat4, x: number, y: number, z: number): Vec3 {
  return [m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]];
}

// ---- scene units: accessor extents ÷ the extents the part's own dims imply

/**
 * Scene units per spec unit (§3.7.5 step 3): for every part node, the extent of its mesh's POSITION accessor
 * (accessor `min`/`max`, else the data) times the node's world scale, over the extent the canonical part implies
 * (`localBounds`), per axis; the median of all of them. Undefined when no part has a readable extent.
 */
function measureSceneUnits(doc: GltfDoc, pairs: readonly { node: Record<string, unknown>; world: Mat4; part: Part }[]): { k: number; spread: number } | undefined {
  const ratios: number[] = [];
  for (const { node, world, part } of pairs) {
    const mesh = doc.item('meshes', node.mesh);
    const prim = mesh && Array.isArray(mesh.primitives) ? mesh.primitives.find(isPlainObject) : undefined;
    if (!prim || !isPlainObject(prim.attributes)) continue;
    const acc = doc.item('accessors', prim.attributes.POSITION);
    let min = acc ? vec(acc.min, 3) : undefined;
    let max = acc ? vec(acc.max, 3) : undefined;
    if (!min || !max) {
      const data = doc.accessor(prim.attributes.POSITION);
      if (!data || data.size !== 3 || data.count === 0) continue;
      min = [Infinity, Infinity, Infinity];
      max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.count; i++) for (let a = 0; a < 3; a++) {
        min[a] = Math.min(min[a], data.data[3 * i + a]);
        max[a] = Math.max(max[a], data.data[3 * i + a]);
      }
    }
    const scale = decomposeMat4(world).scale.map(Math.abs);
    let b;
    try {
      b = localBounds(part);
    } catch {
      continue;
    }
    for (let a = 0; a < 3; a++) {
      const implied = b.max[a] - b.min[a];
      const measured = (max[a] - min[a]) * scale[a];
      if (implied > 1e-6 && measured > 0 && Number.isFinite(measured)) ratios.push(measured / implied);
    }
  }
  if (ratios.length === 0) return undefined;
  ratios.sort((x, y) => x - y);
  const k = ratios[Math.floor(ratios.length / 2)];
  const spread = Math.max(...ratios.map((r) => Math.abs(Math.log(r / k))));
  return { k, spread };
}

/** The result of the GLB ladder steps 2–4. */
export type GltfGeometry =
  | { ok: true; n: Normalized; options: RepairOptions; units?: UnitsDecision; confidence: 'high' | 'medium' | 'low'; how: string; warnings: Issue[] }
  | { ok: false; failure: Issue };

/** Ladder steps 2–4 (step 1 is `specFromGltfJson`, a spec candidate). */
export function gltfGeometry(doc: GltfDoc, ctx: ImportContext = {}, what = 'this GLB'): GltfGeometry {
  const walked = doc.walk();
  const step2 = walked.filter((w) => isPlainObject(w.node.extras) && isPlainObject(w.node.extras.crochet) && isPlainObject((w.node.extras.crochet as Record<string, unknown>).dims));
  if (step2.length > 0) return fromPartExtras(doc, walked, step2);
  const step3 = walked.filter((w) => isPlainObject(w.node.extras) && typeof w.node.extras.type === 'string' && isPlainObject(w.node.extras.dimensions));
  if (step3.length > 0) return fromObservedExtras(doc, walked, step3, ctx);
  return fromTriangles(doc, walked, ctx, what);
}

type Walked = ReturnType<GltfDoc['walk']>[number];

// ---- step 2: per-node `extras.crochet`

function fromPartExtras(doc: GltfDoc, walked: Walked[], nodes: Walked[]): GltfGeometry {
  const warnings: Issue[] = [];
  const parts = nodes.map((w) => {
    const p = { ...(w.node.extras as { crochet: Record<string, unknown> }).crochet };
    if (typeof p.id !== 'string' && typeof w.node.name === 'string') p.id = w.node.name;
    return p;
  });
  // the model group: the nearest common ancestor holds the spec's name (builder: group.name = spec.name)
  const byIndex = new Map(walked.map((w) => [w.index, w]));
  const parents = new Set(nodes.map((w) => w.parent));
  const group = parents.size === 1 && nodes[0].parent !== null ? byIndex.get(nodes[0].parent) : undefined;
  const groupName = group && typeof group.node.name === 'string' && !/^(model|scene|auxscene|root)$/i.test(group.node.name) ? group.node.name : undefined;

  // palette: the solid materials (name = color id); painted parts' materials are `<id>_painted`
  const solid = new Map<string, string>();
  const painted: { w: Walked; part: Record<string, unknown> }[] = [];
  nodes.forEach((w, i) => {
    const mat = doc.material(w.node);
    if (!mat) return;
    if (mat.vertexColors || /_painted(_\d+)?$/.test(mat.name)) painted.push({ w, part: parts[i] });
    else if (mat.name && mat.hex) {
      const id = materialColorName(mat.name, new Set(solid.keys()));
      if (!solid.has(id)) solid.set(id, mat.hex);
    }
  });
  const palette: Record<string, unknown>[] = [...solid].map(([id, hex]) => ({ id, hex, name: id }));
  const known = new Set(solid.keys());
  const needed = new Set<string>();
  const colorsOf = (p: Record<string, unknown>): string[] => {
    const out: string[] = [];
    if (typeof p.color === 'string') out.push(p.color);
    if (Array.isArray(p.regions)) {
      for (const r of p.regions) {
        if (!isPlainObject(r)) continue;
        if (typeof r.color === 'string') out.push(r.color);
        if (Array.isArray(r.colors)) for (const c of r.colors) if (typeof c === 'string') out.push(c);
      }
    }
    return out;
  };
  for (const p of parts) for (const c of colorsOf(p)) if (!known.has(c)) needed.add(c);

  // the scale the page built at (0.0254 for builder-v1 pages, 1 for the app): accessor extents ÷ the parts' dims
  const pairs = nodes.flatMap((w, i) => {
    const n = normalizeOnePart(parts[i]);
    return n ? [{ node: w.node, world: w.world, part: n }] : [];
  });
  const measured = measureSceneUnits(doc, pairs);
  const S = measured?.k ?? 1;

  // ids used only on painted parts: the average COLOR_0 of the vertices the builder painted with them
  const sums = new Map<string, [number, number, number, number]>();
  for (const { w, part } of painted) {
    const n = normalizeOnePart(part);
    const mat = doc.material(w.node);
    const prim = mat?.primitive;
    if (!n || !prim || !isPlainObject(prim.attributes)) continue;
    const col = doc.accessor(prim.attributes.COLOR_0);
    if (!col || (col.size !== 3 && col.size !== 4)) continue;
    let ids: string[] | null = null;
    try {
      const g = partGeometry(n, S);
      if (g.attributes.position.count === col.count) ids = vertexColorIds(g, n, S);
    } catch {
      ids = null;
    }
    if (!ids) continue;
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      if (!needed.has(id)) continue;
      const s = sums.get(id) ?? [0, 0, 0, 0];
      s[0] += col.data[i * col.size];
      s[1] += col.data[i * col.size + 1];
      s[2] += col.data[i * col.size + 2];
      s[3] += 1;
      sums.set(id, s);
    }
  }
  const log = new RepairLog();
  for (const id of needed) {
    const s = sums.get(id);
    if (s && s[3] > 0) palette.push({ id, hex: linearRgbToHex(s[0] / s[3], s[1] / s[3], s[2] / s[3]).toUpperCase(), name: id });
    else {
      palette.push({ id, hex: '#9E9E9E', name: id });
      log.add('color', { code: 'color', message: `color ${id} is not in the file (no material and no painted vertices): gray until you pick its yarn`, data: { id } });
    }
  }

  // the node matrices are only a check: the parts' own positions win
  if (measured) {
    const off = nodes.filter((w, i) => {
      const pos = vec(parts[i].position, 3);
      if (!pos) return false;
      const t = [w.world[12] / S, w.world[13] / S, w.world[14] / S];
      return Math.hypot(t[0] - pos[0], t[1] - pos[1], t[2] - pos[2]) > 0.01 + 1e-3 * Math.hypot(...pos);
    });
    if (off.length > 0) {
      warnings.push(
        issue(IMPORT_CODES.parseWarn, 'warn', `${off.length} part${off.length === 1 ? '' : 's'} sit elsewhere in the GLB than their own data says (${off.slice(0, 4).map((w) => String(w.node.name ?? '?')).join(', ')}): the parts' data was used`),
      );
    }
  }

  const raw: Record<string, unknown> = { schema: 'crochet-model', version: '1.0', revision: 0, ...(groupName ? { name: groupName } : {}), palette, parts };
  const n = normalizeSpec(raw);
  for (const r of log.all()) n.repairs.add('color', r);
  n.repairs.add('source', {
    code: 'spec-rebuilt',
    message: `spec rebuilt from the ${parts.length} parts' own data in the GLB (it had no whole spec)`,
    data: { parts: parts.length, ...(measured ? { sceneUnitsPerInch: roundCoord(S, 6) } : {}) },
  });
  // finishedSize = the builder's bounding box
  try {
    const h = modelHeight(n.model);
    if (h > 0 && Number.isFinite(h)) {
      n.model = { ...n.model, finishedSize: { height: roundCoord(h) } };
      n.noStatedHeight = false;
    }
  } catch {
    // the repairs measure it again
  }
  return { ok: true, n, options: {}, confidence: 'high', how: 'GLB extras.crochet (per part)', warnings };
}

/** One raw canonical part through the dialect step (for its bounds and geometry), or null. */
function normalizeOnePart(raw: Record<string, unknown>): Part | null {
  try {
    const n = normalizeSpec({ schema: 'crochet-model', version: '1.0', palette: [], parts: [{ ...raw, color: '#000000', regions: raw.regions }] });
    const p = n.model.parts[0] as Part | undefined;
    return p ? { ...p, color: typeof raw.color === 'string' ? raw.color : p.color } : null;
  } catch {
    return null;
  }
}

// ---- step 3: observed `extras.{type, dimensions}`

function fromObservedExtras(doc: GltfDoc, walked: Walked[], nodes: Walked[], ctx: ImportContext): GltfGeometry {
  const warnings: Issue[] = [];
  const partNodes = new Set(nodes.map((w) => w.index));
  const byIndex = new Map(walked.map((w) => [w.index, w]));
  const nearestPart = (w: Walked): Walked | undefined => {
    let at = w.parent;
    while (at !== null) {
      if (partNodes.has(at)) return byIndex.get(at);
      at = byIndex.get(at)?.parent ?? null;
    }
    return undefined;
  };
  const rigid = (m: Mat4) => rigidFromMat4(m);
  const palette: Record<string, string> = {};
  const paletteNames = new Set<string>();
  const indexOf = new Map(nodes.map((w, i) => [w, i]));
  const parts = nodes.map((w, i) => {
    const extras = w.node.extras as Record<string, unknown>;
    const parent = nearestPart(w);
    const local = parent ? multiplyRigid(invertRigid(rigid(parent.world)), rigid(w.world)) : rigid(w.world);
    const { position, rotationDeg } = decomposeRigid(local);
    const mat = doc.material(w.node);
    if (mat?.hex && !Object.hasOwn(palette, mat.hex) && !paletteNames.has(mat.name)) {
      const name = mat.name || `color_${paletteNames.size + 1}`;
      palette[mat.hex] = name;
      paletteNames.add(name);
    }
    const part: Record<string, unknown> = {
      id: typeof w.node.name === 'string' && w.node.name !== '' ? w.node.name : `part_${i + 1}`,
      type: extras.type,
      dimensions: extras.dimensions,
      position,
      rotationDeg,
      parent: parent ? (typeof parent.node.name === 'string' && parent.node.name !== '' ? parent.node.name : `part_${(indexOf.get(parent) ?? 0) + 1}`) : null,
    };
    if (typeof extras.name === 'string') part.name = extras.name;
    if (mat?.hex) part.color = mat.hex;
    return part;
  });
  const raw = { schema: 'crochet-model', version: '1.0', palette, parts };
  const n = normalizeSpec(raw);
  // scene units, measured: positions so far are in scene units; dims are in spec units (inches)
  const pairs = nodes.flatMap((w, i) => {
    const part = n.model.parts[i] as Part | undefined;
    return part ? [{ node: w.node, world: w.world, part }] : [];
  });
  const measured = measureSceneUnits(doc, pairs);
  // the user's answer to the confirm wins over the measurement (scene units per inch = 1 / inches per unit)
  const user = ctx.units !== undefined && Object.hasOwn(INCHES_PER_UNIT, ctx.units) ? ctx.units : undefined;
  const k = user ? 1 / INCHES_PER_UNIT[user] : (measured?.k ?? 1);
  const disagree = measured !== undefined && measured.spread > Math.log(1.05);
  if (!measured) warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', 'the GLB holds no readable mesh sizes: its positions are read as inches'));
  else if (measured.spread > Math.log(1.05)) warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `the parts' sizes disagree with their meshes by up to ${Math.round((Math.exp(measured.spread) - 1) * 100)}%: check the result`));
  n.model = { ...n.model, parts: n.model.parts.map((p) => ({ ...p, position: p.position.map((v) => v / k) as Vec3 })) };
  let units: UnitsDecision | undefined;
  try {
    const h = modelHeight(n.model);
    if (h > 0 && Number.isFinite(h)) {
      const choice = user ? decideUnits(h * k, { units: user }) : decideUnits(h * k, {}, { sceneUnitsPerInch: k });
      // parts whose sizes disagree with their meshes: ask, even though a ratio was measured
      units = disagree && !user ? { ...choice.decision, confirm: true } : choice.decision;
      n.repairs.add('units', { code: 'units', message: choice.message, data: { ...choice.decision, factor: roundCoord(choice.factor, 9) } });
    }
  } catch {
    // the repairs report it
  }
  return { ok: true, n, options: units ? { unitsDecided: true } : {}, ...(units ? { units } : {}), confidence: 'medium', how: 'GLB node extras (type + dimensions)', warnings };
}

// ---- step 4: triangles

function fromTriangles(doc: GltfDoc, walked: Walked[], ctx: ImportContext, what: string): GltfGeometry {
  const objects: GeoObject[] = [];
  /** Per object, per vertex: 8-bit sRGB as r<<16|g<<8|b, or −1 (no color). */
  const vertexRgb: Int32Array[] = [];
  /** Material colors by hex → their names (palette names when a vertex color equals a material color). */
  const materialNames = new Map<string, string>();
  let unreadable = 0;
  let compressed = false;
  let skippedModes = 0;
  const rgbOf = (r: number, g: number, b: number): number => {
    const hex = linearRgbToHex(r, g, b);
    return Number.parseInt(hex.slice(1), 16);
  };
  for (const w of walked) {
    const mesh = doc.item('meshes', w.node.mesh);
    if (!mesh || !Array.isArray(mesh.primitives)) continue;
    const pos: number[] = [];
    const idx: number[] = [];
    const rgb: number[] = [];
    for (const prim of mesh.primitives) {
      if (!isPlainObject(prim) || !isPlainObject(prim.attributes)) continue;
      const mode = prim.mode === undefined ? 4 : prim.mode;
      if (mode !== 4 && mode !== 5 && mode !== 6) {
        skippedModes++;
        continue;
      }
      if (isPlainObject(prim.extensions)) compressed = true;
      const p = doc.accessor(prim.attributes.POSITION);
      if (!p || p.size !== 3) {
        unreadable++;
        continue;
      }
      const ind = prim.indices !== undefined ? doc.accessor(prim.indices) : null;
      if (prim.indices !== undefined && !ind) {
        unreadable++;
        continue;
      }
      const base = pos.length / 3;
      for (let i = 0; i < p.count; i++) pos.push(...transformPoint(w.world, p.data[3 * i], p.data[3 * i + 1], p.data[3 * i + 2]));
      // triangles, strips and fans → triangles; indices past the vertex list are dropped later
      const at = (i: number): number => (ind ? ind.data[i] : i);
      const count = ind ? ind.count : p.count;
      if (mode === 4) for (let i = 0; i + 2 < count; i += 3) idx.push(base + at(i), base + at(i + 1), base + at(i + 2));
      else if (mode === 5) for (let i = 0; i + 2 < count; i++) idx.push(base + at(i + (i % 2)), base + at(i + 1 - (i % 2)), base + at(i + 2));
      else for (let i = 1; i + 1 < count; i++) idx.push(base + at(0), base + at(i), base + at(i + 1));
      // colors: COLOR_0, else the primitive's material (several materials on one mesh become vertex labels)
      const mat = doc.item('materials', prim.material);
      const pbr = mat && isPlainObject(mat.pbrMetallicRoughness) ? mat.pbrMetallicRoughness : undefined;
      const f = pbr ? vec(pbr.baseColorFactor, 4) ?? vec(pbr.baseColorFactor, 3) : undefined;
      const matRgb = f ? rgbOf(f[0], f[1], f[2]) : -1;
      if (f && mat && typeof mat.name === 'string' && mat.name !== '') {
        const hex = linearRgbToHex(f[0], f[1], f[2]).toUpperCase();
        if (!materialNames.has(hex)) materialNames.set(hex, materialColorName(mat.name, new Set()));
      }
      const c = doc.accessor(prim.attributes.COLOR_0);
      if (c && (c.size === 3 || c.size === 4) && c.count === p.count) {
        for (let i = 0; i < c.count; i++) rgb.push(rgbOf(c.data[i * c.size], c.data[i * c.size + 1], c.data[i * c.size + 2]));
      } else for (let i = 0; i < p.count; i++) rgb.push(matRgb);
    }
    if (idx.length === 0) continue;
    const name = typeof w.node.name === 'string' && w.node.name !== '' ? w.node.name : typeof mesh.name === 'string' ? mesh.name : '';
    objects.push({ name, positions: Float64Array.from(pos), indices: Uint32Array.from(idx.map((v) => (Number.isInteger(v) && v >= 0 ? v : 0xffffffff))) });
    vertexRgb.push(Int32Array.from(rgb));
  }
  // one palette for the whole file (≤ 16 yarn colors), labels per vertex
  const colored: number[] = [];
  for (const rgb of vertexRgb) for (const v of rgb) if (v >= 0) colored.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
  let colors: GeoColor[] = [];
  if (colored.length > 0) {
    const pal = vertexColorPalette(colored);
    colors = pal.colors.map((c) => {
      const n = materialNames.get(c.hex);
      return n ? { hex: c.hex, name: n } : c;
    });
    let k = 0;
    objects.forEach((o, i) => {
      const rgb = vertexRgb[i];
      const labels = new Uint8Array(rgb.length).fill(255);
      for (let v = 0; v < rgb.length; v++) if (rgb[v] >= 0) labels[v] = pal.labels[k++];
      o.vertexColors = labels;
    });
  }
  if (skippedModes > 0 && objects.length === 0) unreadable += skippedModes;
  if (objects.length === 0) {
    const why = compressed
      ? 'its meshes are compressed (Draco or meshopt), which this app does not read'
      : unreadable > 0
        ? 'its mesh data could not be read (for a .gltf, drop its .bin file together with it)'
        : 'it holds no meshes';
    return { ok: false, failure: issue(IMPORT_CODES.noModel, 'error', `${what} carries no crochet-model spec and ${why}. Drop the project archive (.zip) or paste the chat JSON instead.`) };
  }
  const g = normalizeGeometry({ objects, colors, warnings: unreadable > 0 ? [issue(IMPORT_CODES.parseWarn, 'warn', `${unreadable} mesh parts of ${what} could not be read: skipped`)] : [] }, ctx);
  if ('failure' in g) return { ok: false, failure: g.failure };
  return { ok: true, n: g.n, options: g.options, units: g.units, confidence: 'low', how: 'GLB triangles (geometry fit)', warnings: [] };
}
