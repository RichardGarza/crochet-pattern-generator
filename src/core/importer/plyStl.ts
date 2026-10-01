// Track T7 — PLY and STL (DESIGN.md §3.7.5). STL goes through three's STLLoader. PLY is read here (ascii and binary,
// either byte order): three's PLYLoader converts 8-bit vertex colors to linear light and stores them back in 8 bits,
// which loses the yarn colors (#C81E28 comes back as #C81C28), so the vertices, their colors and the faces are read
// as written. The vertices are welded by position and split into connected components, one part each (largest
// first, at most 60). PLY vertex colors become color labels (8-bit sRGB, at most 16 colors: the most used ones, the
// rest merged into the nearest by ΔE00); STL has no colors and no names. Units, fitting, naming and the attach tree
// follow in the geometry path.
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import type { BufferGeometry } from 'three';
import type { Issue } from '../../types/issues';
import { deltaE00Hex, toHex } from '../kernel/color';
import { MODEL_LIMITS } from '../model/limits';
import { IMPORT_CODES, ImportFailure, issue } from './common';
import type { GeoColor, GeoObject, GeometrySource } from './geometry';

/** Components with fewer triangles than this are specks (stray faces), not parts. */
const MIN_COMPONENT_TRIANGLES = 4;
/** Palette limit of the model (§3.5.2). */
const MAX_COLORS = 16;
/** Two vertex colors this close (ΔE00) are one yarn. */
const SAME_YARN_DE = 8;

export interface Component {
  positions: Float32Array;
  indices: Uint32Array;
  /** Per vertex, an index of the caller's colors (255 = none). */
  labels?: Uint8Array;
}

/**
 * Welds vertices that share a position (within 1e-6 of the model's size) and splits the triangles into connected
 * components, largest (by triangle count) first.
 */
export function splitComponents(positions: ArrayLike<number>, indices: ArrayLike<number> | null, labels?: Uint8Array): Component[] {
  const nv = Math.floor(positions.length / 3);
  const tri = indices ?? Uint32Array.from({ length: nv - (nv % 3) }, (_, i) => i);
  const nt = Math.floor(tri.length / 3);
  if (nv === 0 || nt === 0) return [];
  // the weld tolerance comes from the vertices the triangles use (a stray unused vertex far away must not weld
  // the whole model into one point)
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let k = 0; k < nt * 3; k++) {
    const v = tri[k];
    if (!(Number.isInteger(v) && v >= 0 && v < nv)) continue;
    for (let a = 0; a < 3; a++) {
      const x = positions[3 * v + a];
      if (!Number.isFinite(x)) continue;
      if (x < lo[a]) lo[a] = x;
      if (x > hi[a]) hi[a] = x;
    }
  }
  const span = Math.max(0, ...[0, 1, 2].map((a) => (hi[a] >= lo[a] ? hi[a] - lo[a] : 0)));
  const q = span > 0 ? span * 1e-6 : 1e-9;
  // weld: one representative per quantized position
  const rep = new Int32Array(nv);
  const seen = new Map<string, number>();
  for (let i = 0; i < nv; i++) {
    const key = `${Math.round(positions[3 * i] / q)},${Math.round(positions[3 * i + 1] / q)},${Math.round(positions[3 * i + 2] / q)}`;
    const r = seen.get(key);
    if (r === undefined) {
      seen.set(key, i);
      rep[i] = i;
    } else rep[i] = r;
  }
  // union-find over the welded vertices of each triangle
  const parent = Int32Array.from({ length: nv }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) {
      const next = parent[x];
      parent[x] = r;
      x = next;
    }
    return r;
  };
  const valid = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < nv;
  for (let t = 0; t < nt; t++) {
    const a = tri[3 * t];
    const b = tri[3 * t + 1];
    const c = tri[3 * t + 2];
    if (!valid(a) || !valid(b) || !valid(c)) continue;
    const ra = find(rep[a]);
    const rb = find(rep[b]);
    const rc = find(rep[c]);
    if (ra !== rb) parent[rb] = ra;
    const r2 = find(ra);
    if (r2 !== rc) parent[rc] = r2;
  }
  // group triangles by component root; vertices by welded representative
  const groups = new Map<number, number[]>();
  for (let t = 0; t < nt; t++) {
    const a = tri[3 * t];
    if (!valid(a) || !valid(tri[3 * t + 1]) || !valid(tri[3 * t + 2])) continue;
    const root = find(rep[a]);
    const g = groups.get(root);
    if (g) g.push(t);
    else groups.set(root, [t]);
  }
  const out: Component[] = [];
  for (const tris of groups.values()) {
    const local = new Map<number, number>();
    const pos: number[] = [];
    const lab: number[] = [];
    const idx = new Uint32Array(tris.length * 3);
    tris.forEach((t, k) => {
      for (let j = 0; j < 3; j++) {
        const v = rep[tri[3 * t + j]];
        let li = local.get(v);
        if (li === undefined) {
          li = local.size;
          local.set(v, li);
          pos.push(positions[3 * v], positions[3 * v + 1], positions[3 * v + 2]);
          if (labels) lab.push(labels[tri[3 * t + j]] ?? 255);
        }
        idx[3 * k + j] = li;
      }
    });
    out.push({ positions: Float32Array.from(pos), indices: idx, ...(labels ? { labels: Uint8Array.from(lab) } : {}) });
  }
  // largest first by size (bounding-box diagonal), not by triangle count
  const diag = (c: Component): number => {
    const mn = [Infinity, Infinity, Infinity];
    const mx = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < c.positions.length; i++) {
      const a = i % 3;
      if (c.positions[i] < mn[a]) mn[a] = c.positions[i];
      if (c.positions[i] > mx[a]) mx[a] = c.positions[i];
    }
    return Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) || 0;
  };
  const sizes = new Map(out.map((c) => [c, diag(c)]));
  out.sort((a, b) => (sizes.get(b) as number) - (sizes.get(a) as number) || b.indices.length - a.indices.length);
  return out;
}

/** 8-bit sRGB vertex colors (r, g, b per vertex) → at most 16 colors and a label per vertex. */
export function vertexColorPalette(rgb: ArrayLike<number>): { colors: GeoColor[]; labels: Uint8Array } {
  const n = Math.floor(rgb.length / 3);
  const keys = new Uint32Array(n);
  const counts = new Map<number, number>();
  const byte = (v: number): number => (v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v));
  for (let i = 0; i < n; i++) {
    const k = (byte(rgb[3 * i]) << 16) | (byte(rgb[3 * i + 1]) << 8) | byte(rgb[3 * i + 2]);
    keys[i] = k;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const hexOf = (k: number): string => toHex((k >> 16) & 255, (k >> 8) & 255, k & 255).toUpperCase();
  const byUse = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0]).map(([k]) => k);
  const kept: number[] = [];
  for (const k of byUse) {
    if (kept.length >= MAX_COLORS) break;
    if (kept.every((c) => deltaE00Hex(hexOf(c), hexOf(k)) >= SAME_YARN_DE)) kept.push(k);
  }
  const map = new Map<number, number>();
  for (const k of byUse) {
    let best = 0;
    let de = Infinity;
    kept.forEach((c, i) => {
      const d = c === k ? 0 : deltaE00Hex(hexOf(c), hexOf(k));
      if (d < de) [best, de] = [i, d];
    });
    map.set(k, best);
  }
  const labels = Uint8Array.from(keys, (k) => map.get(k) ?? 255);
  return { colors: kept.map((k) => ({ hex: hexOf(k) })), labels };
}

// ---- PLY

const PLY_TYPES: Readonly<Record<string, { bytes: number; get: (dv: DataView, at: number, le: boolean) => number }>> = {
  char: { bytes: 1, get: (dv, at) => dv.getInt8(at) },
  int8: { bytes: 1, get: (dv, at) => dv.getInt8(at) },
  uchar: { bytes: 1, get: (dv, at) => dv.getUint8(at) },
  uint8: { bytes: 1, get: (dv, at) => dv.getUint8(at) },
  short: { bytes: 2, get: (dv, at, le) => dv.getInt16(at, le) },
  int16: { bytes: 2, get: (dv, at, le) => dv.getInt16(at, le) },
  ushort: { bytes: 2, get: (dv, at, le) => dv.getUint16(at, le) },
  uint16: { bytes: 2, get: (dv, at, le) => dv.getUint16(at, le) },
  int: { bytes: 4, get: (dv, at, le) => dv.getInt32(at, le) },
  int32: { bytes: 4, get: (dv, at, le) => dv.getInt32(at, le) },
  uint: { bytes: 4, get: (dv, at, le) => dv.getUint32(at, le) },
  uint32: { bytes: 4, get: (dv, at, le) => dv.getUint32(at, le) },
  float: { bytes: 4, get: (dv, at, le) => dv.getFloat32(at, le) },
  float32: { bytes: 4, get: (dv, at, le) => dv.getFloat32(at, le) },
  double: { bytes: 8, get: (dv, at, le) => dv.getFloat64(at, le) },
  float64: { bytes: 8, get: (dv, at, le) => dv.getFloat64(at, le) },
};

interface PlyProperty {
  name: string;
  type: string;
  /** A list property: the type of its count. */
  countType?: string;
}
interface PlyElement {
  name: string;
  count: number;
  props: PlyProperty[];
}

const plyFail = (message: string): never => {
  throw new ImportFailure(issue(IMPORT_CODES.parse, 'error', `this PLY file could not be read: ${message}`));
};

/** Vertices (x, y, z), 8-bit colors when the file has them, and triangles (faces fanned) of a PLY file. */
export function readPly(bytes: Uint8Array): { positions: Float64Array; colors?: Uint8Array; indices: Uint32Array } {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const endMatch = /end_header\r?\n/.exec(head);
  if (!head.startsWith('ply') || !endMatch) plyFail('no header');
  const headerEnd = (endMatch as RegExpExecArray).index + (endMatch as RegExpExecArray)[0].length;
  let format = '';
  const elements: PlyElement[] = [];
  for (const line of head.slice(0, headerEnd).split(/\r?\n/)) {
    const w = line.trim().split(/\s+/);
    if (w[0] === 'format') format = w[1] ?? '';
    else if (w[0] === 'element') {
      const count = Number(w[2]);
      if (!Number.isInteger(count) || count < 0) plyFail(`element ${w[1]} has no count`);
      elements.push({ name: w[1] ?? '', count, props: [] });
    } else if (w[0] === 'property' && elements.length > 0) {
      const el = elements[elements.length - 1];
      if (w[1] === 'list') el.props.push({ name: w[4] ?? '', type: w[3] ?? '', countType: w[2] ?? '' });
      else el.props.push({ name: w[2] ?? '', type: w[1] ?? '' });
    }
  }
  for (const el of elements) for (const p of el.props) if (!Object.hasOwn(PLY_TYPES, p.type) || (p.countType !== undefined && !Object.hasOwn(PLY_TYPES, p.countType))) plyFail(`unknown type in ${el.name}.${p.name}`);
  const vertexEl = elements.find((e) => e.name === 'vertex');
  if (!vertexEl) plyFail('no vertex element');
  const ve = vertexEl as PlyElement;
  // every row takes at least one byte (binary) or one character (ascii): a count beyond that is a lie — and an
  // element without properties could otherwise be "read" a trillion times
  for (const el of elements) if (el.count * Math.max(1, el.props.length) > bytes.length - headerEnd) plyFail(`it claims more ${el.name} rows than it holds`);
  const col = (name: string): number => ve.props.findIndex((p) => p.name === name && p.countType === undefined);
  const ix = col('x');
  const iy = col('y');
  const iz = col('z');
  if (ix < 0 || iy < 0 || iz < 0) plyFail('the vertices have no x, y, z');
  const ir = col('red') >= 0 ? col('red') : col('r');
  const ig = col('green') >= 0 ? col('green') : col('g');
  const ib = col('blue') >= 0 ? col('blue') : col('b');
  const hasColor = ir >= 0 && ig >= 0 && ib >= 0;
  const colorScale = (i: number): number => {
    const t = ve.props[i].type;
    return t.startsWith('float') || t === 'double' ? 255 : t.includes('short') || t.includes('16') ? 255 / 65535 : 1;
  };
  const positions = new Float64Array(ve.count * 3);
  const colors = hasColor ? new Uint8Array(ve.count * 3) : undefined;
  const tris: number[] = [];

  const onVertex = (v: number, values: number[]): void => {
    positions[3 * v] = values[ix];
    positions[3 * v + 1] = values[iy];
    positions[3 * v + 2] = values[iz];
    if (colors) {
      colors[3 * v] = Math.max(0, Math.min(255, Math.round(values[ir] * colorScale(ir))));
      colors[3 * v + 1] = Math.max(0, Math.min(255, Math.round(values[ig] * colorScale(ig))));
      colors[3 * v + 2] = Math.max(0, Math.min(255, Math.round(values[ib] * colorScale(ib))));
    }
  };
  const onFace = (list: number[]): void => {
    for (let k = 1; k + 1 < list.length; k++) tris.push(list[0], list[k], list[k + 1]);
  };
  const faceList = (el: PlyElement): number => el.props.findIndex((p) => p.countType !== undefined && /^vertex_ind(ex|ices)$/.test(p.name));

  if (format === 'ascii') {
    const text = new TextDecoder().decode(bytes.subarray(headerEnd));
    const tokens = text.split(/\s+/).filter((t) => t !== '');
    let t = 0;
    const next = (): number => {
      if (t >= tokens.length) plyFail('it ends too early');
      return Number(tokens[t++]);
    };
    for (const el of elements) {
      const fl = faceList(el);
      for (let n = 0; n < el.count; n++) {
        const values: number[] = [];
        let list: number[] = [];
        el.props.forEach((p, i) => {
          if (p.countType !== undefined) {
            const c = next();
            if (!Number.isInteger(c) || c < 0 || c > 1024) plyFail('a list is too long');
            const items = Array.from({ length: c }, next);
            if (i === fl) list = items;
            values.push(NaN);
          } else values.push(next());
        });
        if (el === ve) onVertex(n, values);
        else if (fl >= 0) onFace(list);
      }
    }
  } else if (format === 'binary_little_endian' || format === 'binary_big_endian') {
    const le = format === 'binary_little_endian';
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = headerEnd;
    const read = (type: string): number => {
      const ty = PLY_TYPES[type];
      if (at + ty.bytes > bytes.length) plyFail('it ends too early');
      const v = ty.get(dv, at, le);
      at += ty.bytes;
      return v;
    };
    for (const el of elements) {
      const fl = faceList(el);
      for (let n = 0; n < el.count; n++) {
        const values: number[] = [];
        let list: number[] = [];
        el.props.forEach((p, i) => {
          if (p.countType !== undefined) {
            const c = read(p.countType);
            if (!Number.isInteger(c) || c < 0 || c > 1024) plyFail('a list is too long');
            const items: number[] = [];
            for (let k = 0; k < c; k++) items.push(read(p.type));
            if (i === fl) list = items;
            values.push(NaN);
          } else values.push(read(p.type));
        });
        if (el === ve) onVertex(n, values);
        else if (fl >= 0) onFace(list);
      }
    }
  } else plyFail(`format "${format}" is not ascii or binary`);
  const indices = Uint32Array.from(tris);
  for (const i of indices) if (i >= ve.count) plyFail('a face names a vertex that does not exist');
  return { positions, ...(colors ? { colors } : {}), indices };
}

function toObjects(positions: ArrayLike<number>, indices: ArrayLike<number> | null, palette: GeoColor[], labels: Uint8Array | undefined, what: string): GeometrySource {
  const warnings: Issue[] = [];
  const comps = splitComponents(positions, indices, labels);
  const real = comps.filter((c) => c.indices.length / 3 >= MIN_COMPONENT_TRIANGLES);
  if (real.length < comps.length) warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `${comps.length - real.length} specks of fewer than ${MIN_COMPONENT_TRIANGLES} triangles were left out`));
  const kept = real.slice(0, MODEL_LIMITS.maxParts);
  if (kept.length < real.length) warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `${what} has ${real.length} separate pieces: only the ${kept.length} largest were kept`));
  const objects: GeoObject[] = kept.map((c, i) => ({
    name: `part_${i + 1}`,
    positions: c.positions,
    indices: c.indices,
    ...(c.labels ? { vertexColors: c.labels } : {}),
  }));
  return { objects, colors: palette, warnings };
}

function fromGeometry(g: BufferGeometry, what: string): GeometrySource {
  const pos = g.getAttribute('position');
  if (!pos || pos.count === 0) return { objects: [], colors: [], warnings: [] };
  const index = g.getIndex();
  return toObjects(pos.array as ArrayLike<number>, index ? (index.array as ArrayLike<number>) : null, [], undefined, what);
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer ? bytes.buffer : (bytes.slice().buffer as ArrayBuffer);
}

/** A PLY file (ascii or binary) → one part per connected component, vertex colors → labels. Throws `ImportFailure`. */
export function plySource(bytes: Uint8Array, name = 'this PLY file'): GeometrySource {
  const ply = readPly(bytes);
  let palette: GeoColor[] = [];
  let labels: Uint8Array | undefined;
  if (ply.colors) {
    const p = vertexColorPalette(ply.colors);
    palette = p.colors;
    labels = p.labels;
  }
  return toObjects(ply.positions, ply.indices.length > 0 ? ply.indices : null, palette, labels, name);
}

/** An STL file (ascii or binary) → one part per connected component; no colors, no names. Throws `ImportFailure`. */
export function stlSource(bytes: Uint8Array, name = 'this STL file'): GeometrySource {
  let g: BufferGeometry;
  try {
    g = new STLLoader().parse(asArrayBuffer(bytes));
  } catch {
    throw new ImportFailure(issue(IMPORT_CODES.parse, 'error', `${name} could not be read: it is not a complete STL file`));
  }
  return fromGeometry(g, name);
}
