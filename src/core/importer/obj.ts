// Track T7 — OBJ (+ MTL) reader (DESIGN.md §3.7.5). The captured teddy OBJ is 9.5 MB of text (38 165 vertices,
// 71 520 faces), so this is a single pass over the characters with no per-line arrays: `v` lines go into one
// growing Float64Array, `f` lines are fan-triangulated straight into the current object's index list (negative
// indices, `v/vt/vn` forms), `o` (or, in a file without any `o`, `g`) starts an object, `usemtl` counts faces per
// material. Each object then gets its own compact vertex list (world space, as three's OBJExporter writes it).
//
// Colors: `usemtl` names map to MTL materials; their color id is the material name without the stage's `_n`
// duplicate suffix and builder-v1's `_painted` (§3.7.5). An MTL whose first line is `# Exported by three-d-stage`
// writes LINEAR `Kd` values (converted to sRGB here); the header decides colors, never units.
import { linearRgbToHex, toHex } from '../kernel/color';
import type { GeoColor, GeoObject, GeometrySource } from './geometry';
import { IMPORT_CODES, issue } from './common';
import type { Issue } from '../../types/issues';

export const STAGE_MTL_HEADER = '# Exported by three-d-stage';

export interface MtlMaterial {
  name: string;
  /** `Kd` as written (0–1). */
  kd?: [number, number, number];
}

export interface Mtl {
  materials: MtlMaterial[];
  /** The first line is `# Exported by three-d-stage`: `Kd` is linear (§3.7.5). */
  stageHeader: boolean;
}

/** Reads `newmtl` / `Kd` of an MTL file. */
export function parseMtl(text: string): Mtl {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  const stageHeader = (lines.find((l) => l.trim() !== '') ?? '').trim().startsWith(STAGE_MTL_HEADER);
  const materials: MtlMaterial[] = [];
  let current: MtlMaterial | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('newmtl')) {
      current = { name: line.slice(6).trim() };
      materials.push(current);
    } else if (current && /^Kd\s/.test(line)) {
      const v = line.slice(2).trim().split(/\s+/).map(Number);
      if (v.length >= 3 && v.slice(0, 3).every((x) => Number.isFinite(x))) current.kd = [v[0], v[1], v[2]];
    }
    if (materials.length > 4096) break;
  }
  return { materials, stageHeader };
}

/** The palette color id a material name stands for: `caramel_painted_3` → `caramel` (§3.7.5). */
export function materialColorName(name: string, known: ReadonlySet<string>): string {
  let n = name;
  // the stage makes duplicate names unique by appending `_<n>`: strip it when the shorter name exists or is painted
  for (let guard = 0; guard < 4; guard++) {
    const m = /^(.*)_\d+$/.exec(n);
    if (!m || m[1] === '') break;
    if (known.has(m[1]) || /_painted$/.test(m[1])) n = m[1];
    else break;
  }
  return n.replace(/_painted$/, '') || name;
}

export interface ObjParse {
  /** `mtllib` file names, in order. */
  mtllibs: string[];
  objects: { name: string; positions: Float64Array; indices: Uint32Array; materials: Map<string, number> }[];
  vertexCount: number;
  faceCount: number;
  /** Faces that named a vertex that does not exist (skipped). */
  badFaces: number;
}

const CH_CR = 13;
const CH_SPACE = 32;
const CH_TAB = 9;

/** One pass over an OBJ text. Never throws; malformed lines are skipped. */
export function parseObj(source: string): ObjParse {
  // classic Mac line ends (CR only) read as lines too
  const text = source.includes('\n') || !source.includes('\r') ? source : source.replace(/\r/g, '\n');
  const len = text.length;
  let verts = new Float64Array(3 * 4096);
  let nv = 0;
  const useG = !/^o[ \t]/m.test(text);
  interface Building {
    name: string;
    tris: number[];
    materials: Map<string, number>;
  }
  const objects: Building[] = [];
  let current: Building | null = null;
  let material = '';
  const mtllibs: string[] = [];
  let faceCount = 0;
  let badFaces = 0;
  const start = (name: string): void => {
    current = { name, tris: [], materials: new Map() };
    objects.push(current);
  };
  const face: number[] = [];

  let i = 0;
  while (i < len) {
    // line [i, end)
    let end = text.indexOf('\n', i);
    if (end < 0) end = len;
    let lineEnd = end;
    if (lineEnd > i && text.charCodeAt(lineEnd - 1) === CH_CR) lineEnd--;
    // skip leading blanks
    let p = i;
    i = end + 1;
    while (p < lineEnd && (text.charCodeAt(p) === CH_SPACE || text.charCodeAt(p) === CH_TAB)) p++;
    const c0 = text.charCodeAt(p);
    const c1 = text.charCodeAt(p + 1);
    const sep = c1 === CH_SPACE || c1 === CH_TAB;
    if (c0 === 118 /* v */ && sep) {
      // v x y z [r g b]
      let q = p + 2;
      for (let k = 0; k < 3; k++) {
        while (q < lineEnd && (text.charCodeAt(q) === CH_SPACE || text.charCodeAt(q) === CH_TAB)) q++;
        let e = q;
        while (e < lineEnd && text.charCodeAt(e) !== CH_SPACE && text.charCodeAt(e) !== CH_TAB) e++;
        if (nv + 3 > verts.length) {
          const grown = new Float64Array(verts.length * 2);
          grown.set(verts);
          verts = grown;
        }
        const x = e > q ? Number(text.slice(q, e)) : NaN;
        verts[nv + k] = Number.isFinite(x) ? x : 0;
        q = e;
      }
      nv += 3;
    } else if (c0 === 102 /* f */ && sep) {
      if (!current) start('');
      face.length = 0;
      let q = p + 2;
      const count = nv / 3;
      let bad = false;
      while (q < lineEnd) {
        while (q < lineEnd && (text.charCodeAt(q) === CH_SPACE || text.charCodeAt(q) === CH_TAB)) q++;
        if (q >= lineEnd) break;
        // the vertex index is the text up to the first '/'
        let e = q;
        let neg = false;
        if (text.charCodeAt(e) === 45 /* - */) {
          neg = true;
          e++;
        }
        let n = 0;
        let digits = 0;
        while (e < lineEnd) {
          const c = text.charCodeAt(e);
          if (c < 48 || c > 57) break;
          n = n * 10 + (c - 48);
          digits++;
          e++;
        }
        while (e < lineEnd && text.charCodeAt(e) !== CH_SPACE && text.charCodeAt(e) !== CH_TAB) e++;
        q = e;
        if (digits === 0) {
          bad = true;
          continue;
        }
        const idx = neg ? count - n : n - 1;
        if (idx < 0 || idx >= count) bad = true;
        else face.push(idx);
      }
      faceCount++;
      if (bad || face.length < 3) {
        badFaces++;
        continue;
      }
      const tris = (current as unknown as Building).tris;
      for (let k = 1; k + 1 < face.length; k++) tris.push(face[0], face[k], face[k + 1]);
      const mats = (current as unknown as Building).materials;
      mats.set(material, (mats.get(material) ?? 0) + 1);
    } else if ((c0 === 111 /* o */ || (useG && c0 === 103) /* g */) && (sep || p + 1 >= lineEnd)) {
      start(text.slice(p + 2, lineEnd).trim());
    } else if (c0 === 117 /* u */ && text.startsWith('usemtl', p)) {
      material = text.slice(p + 6, lineEnd).trim();
    } else if (c0 === 109 /* m */ && text.startsWith('mtllib', p)) {
      const name = text.slice(p + 6, lineEnd).trim();
      if (name) mtllibs.push(name);
    }
  }

  // compact each object's vertices (world space)
  const map = new Int32Array(nv / 3).fill(-1);
  const stamp = new Int32Array(nv / 3).fill(-1);
  const out: ObjParse['objects'] = [];
  objects.forEach((o, oi) => {
    if (o.tris.length === 0) return;
    const indices = new Uint32Array(o.tris.length);
    const used: number[] = [];
    for (let k = 0; k < o.tris.length; k++) {
      const g = o.tris[k];
      if (stamp[g] !== oi) {
        stamp[g] = oi;
        map[g] = used.length;
        used.push(g);
      }
      indices[k] = map[g];
    }
    const positions = new Float64Array(used.length * 3);
    used.forEach((g, j) => {
      positions[3 * j] = verts[3 * g];
      positions[3 * j + 1] = verts[3 * g + 1];
      positions[3 * j + 2] = verts[3 * g + 2];
    });
    out.push({ name: o.name, positions, indices, materials: o.materials });
  });
  return { mtllibs, objects: out, vertexCount: nv / 3, faceCount, badFaces };
}

/** OBJ (+ MTL) → the geometry path's source: one object per `o`, its color from the material most of its faces use. */
export function objSource(objText: string, mtl?: Mtl, o: { mtlMissing?: string } = {}): GeometrySource {
  const parsed = parseObj(objText);
  const warnings: Issue[] = [];
  if (parsed.badFaces > 0) warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `${parsed.badFaces} faces named vertices that do not exist: skipped`));
  if (o.mtlMissing) warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', o.mtlMissing));
  const materials = new Map<string, MtlMaterial>();
  for (const m of mtl?.materials ?? []) if (!materials.has(m.name)) materials.set(m.name, m);
  const names = new Set(materials.keys());
  const colors: GeoColor[] = [];
  const colorIndex = new Map<string, number>();
  const toHexOf = (kd: [number, number, number]): string =>
    (mtl?.stageHeader ? linearRgbToHex(kd[0], kd[1], kd[2]) : toHex(kd[0] * 255, kd[1] * 255, kd[2] * 255)).toUpperCase();
  const colorFor = (materialName: string): number | undefined => {
    if (!materialName) return undefined;
    const colorName = materialColorName(materialName, names);
    const key = colorName;
    const known = colorIndex.get(key);
    if (known !== undefined) return known;
    // the color: the base material's Kd (a painted material's own Kd is the white of a vertex-color material)
    const base = materials.get(colorName);
    const own = materials.get(materialName);
    const kd = base?.kd ?? (/_painted(_\d+)?$/.test(materialName) ? undefined : own?.kd);
    if (!kd) return undefined;
    colors.push({ hex: toHexOf(kd), name: colorName });
    colorIndex.set(key, colors.length - 1);
    return colors.length - 1;
  };
  const objects: GeoObject[] = parsed.objects.map((ob) => {
    let best = '';
    let bestCount = -1;
    for (const [name, count] of ob.materials) {
      if (count > bestCount) {
        best = name;
        bestCount = count;
      }
    }
    const color = colorFor(best);
    if (best && color === undefined && mtl) warnings.push(issue(IMPORT_CODES.parseWarn, 'warn', `"${ob.name}": its material "${best}" has no color in the MTL`));
    return { name: ob.name, positions: ob.positions, indices: ob.indices, ...(color !== undefined ? { color } : {}) };
  });
  return {
    objects,
    colors,
    hints: { stageHeader: mtl?.stageHeader === true },
    ...(mtl?.stageHeader ? { source: { tool: 'claude-design', stage: 'refined' } as const } : {}),
    warnings,
  };
}
