// Track T6 — the "made of yarn" look of the Shape tab's viewport: a matte, slightly fuzzy material (three.js
// sheen) with a procedural single-crochet normal map, tiled so one stitch is about one real stitch on the
// finished toy. Everything is generated in code: the app works offline and loads no textures.
import {
  BufferGeometry,
  Color,
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshPhysicalMaterial,
  NoColorSpace,
  RepeatWrapping,
  RGBAFormat,
  UnsignedByteType,
  Vector2,
} from 'three';
import type { Part } from '../../types/model';

/** Worsted amigurumi single crochet (Table E): about 0.23 in wide and 0.2 in tall. */
export const STITCH_W_IN = 0.23;
export const STITCH_H_IN = 0.2;

/** One texture tile holds 2 × 2 stitches. */
const TILE_STITCHES = 2;
const TILE_PX = 128;

/**
 * The height field of a tile of single crochet: each stitch is a "V" of two slanted loops; rows are offset by
 * half a stitch so the fabric reads as worked in rounds. Values in [0, 1].
 */
export function stitchHeight(u: number, v: number): number {
  // u, v in stitch units within the tile [0, 2) × [0, 2).
  const row = Math.floor(v);
  const uu = u + (row % 2 === 1 ? 0.5 : 0);
  const fu = ((uu % 1) + 1) % 1; // position inside the stitch, 0..1
  const fv = v - row;
  // Two loops, left leaning "\" and right leaning "/", meeting at the bottom of the stitch.
  const loop = (cx: number, slope: number): number => {
    const x = fu - cx - slope * (fv - 0.5);
    const y = fv - 0.5;
    const d = (x / 0.2) ** 2 + (y / 0.46) ** 2;
    return d < 1 ? Math.sqrt(1 - d) : 0;
  };
  const h = Math.max(loop(0.28, -0.32), loop(0.72, 0.32));
  // A little twist of the yarn plies across each loop.
  const ply = 0.08 * Math.sin((fu * 2 + fv * 3) * Math.PI * 4);
  return Math.max(0, Math.min(1, h * (0.92 + ply)));
}

let sharedNormalMap: DataTexture | null = null;

/** The tangent-space normal map of `stitchHeight` (shared; each material clones it to set its repeat). */
export function stitchNormalMap(): DataTexture {
  if (sharedNormalMap) return sharedNormalMap;
  const n = TILE_PX;
  const heights = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) heights[y * n + x] = stitchHeight((x / n) * TILE_STITCHES, (y / n) * TILE_STITCHES);
  }
  const data = new Uint8Array(n * n * 4);
  const at = (x: number, y: number) => heights[((y + n) % n) * n + ((x + n) % n)];
  const strength = 2.2;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const len = Math.hypot(dx, dy, 1);
      const i = (y * n + x) * 4;
      data[i] = Math.round(((-dx / len) * 0.5 + 0.5) * 255);
      data[i + 1] = Math.round(((-dy / len) * 0.5 + 0.5) * 255);
      data[i + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      data[i + 3] = 255;
    }
  }
  const t = new DataTexture(data, n, n, RGBAFormat, UnsignedByteType);
  t.wrapS = RepeatWrapping;
  t.wrapT = RepeatWrapping;
  t.magFilter = LinearFilter;
  t.minFilter = LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 4;
  t.colorSpace = NoColorSpace;
  t.needsUpdate = true;
  sharedNormalMap = t;
  return t;
}

const TAU = Math.PI * 2;

/** Approximate length of half an ellipse's meridian (pole to pole) with semi-axes a (around) and b (along). */
function halfMeridian(a: number, b: number): number {
  // Ramanujan's perimeter, halved.
  const h = ((a - b) / (a + b)) ** 2;
  return (Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))) / 2;
}

/**
 * How many stitches fit across the builder's UV layout of a part (u around, v along): the texture repeat that
 * makes one stitch about `STITCH_W_IN` × `STITCH_H_IN` on the toy. Null when the geometry has no useful UVs.
 */
export function stitchRepeat(part: Part): [number, number] | null {
  const tiles = (len: number, stitch: number) => Math.max(1, Math.round(len / stitch / TILE_STITCHES));
  const d = part.dims as Record<string, unknown>;
  const num = (k: string) => (typeof d[k] === 'number' && Number.isFinite(d[k]) ? (d[k] as number) : 0);
  switch (part.type) {
    case 'sphere':
      return [tiles(TAU * num('r'), STITCH_W_IN), tiles(Math.PI * num('r'), STITCH_H_IN)];
    case 'ellipsoid': {
      const around = (num('rx') + num('rz')) / 2;
      return [tiles(TAU * around, STITCH_W_IN), tiles(halfMeridian(around, num('ry')), STITCH_H_IN)];
    }
    case 'capsule': {
      const r = num('r');
      return [tiles(TAU * r, STITCH_W_IN), tiles(Math.max(0, num('length') - 2 * r) + Math.PI * r, STITCH_H_IN)];
    }
    case 'cylinder':
      return [tiles(Math.PI * (num('rTop') + num('rBottom')), STITCH_W_IN), tiles(num('h'), STITCH_H_IN)];
    case 'cone':
      return [tiles(TAU * num('r'), STITCH_W_IN), tiles(Math.hypot(num('h'), num('r')), STITCH_H_IN)];
    case 'torus': {
      const arc = ((part.dims as { arcDeg?: number }).arcDeg ?? 360) / 360;
      return [tiles(TAU * num('R') * arc, STITCH_W_IN), tiles(TAU * num('r'), STITCH_H_IN)];
    }
    case 'lathe': {
      const profile = (part.dims as { profile: [number, number][] }).profile;
      let maxR = 0;
      let arc = 0;
      for (let i = 0; i < profile.length; i++) {
        maxR = Math.max(maxR, profile[i][0]);
        if (i > 0) arc += Math.hypot(profile[i][0] - profile[i - 1][0], profile[i][1] - profile[i - 1][1]);
      }
      return [tiles(TAU * maxR, STITCH_W_IN), tiles(arc, STITCH_H_IN)];
    }
    case 'box':
      return [tiles(Math.max(num('w'), num('d')), STITCH_W_IN), tiles(num('h'), STITCH_H_IN)];
    case 'flat':
      return null; // ExtrudeGeometry UVs are in model units: see `flatRepeat`
    case 'mesh':
      return null;
  }
}

export interface YarnMaterialOptions {
  /** sRGB hex of the base color; ignored with `vertexColors`. */
  hex: string;
  vertexColors?: boolean;
  repeat: [number, number] | null;
  geometry?: BufferGeometry;
  wireframe?: boolean;
}

/** A matte yarn material: high roughness, a soft sheen in a lighter tint of the color, the stitch normal map. */
export function yarnMaterial(o: YarnMaterialOptions): MeshPhysicalMaterial {
  const base = new Color(o.vertexColors ? '#ffffff' : o.hex);
  const sheen = base.clone().lerp(new Color('#ffffff'), 0.55);
  const m = new MeshPhysicalMaterial({
    color: base,
    vertexColors: !!o.vertexColors,
    roughness: 0.94,
    metalness: 0,
    sheen: 0.7,
    sheenRoughness: 0.55,
    sheenColor: o.vertexColors ? new Color('#d9d4cc') : sheen,
    wireframe: !!o.wireframe,
  });
  const hasUv = !o.geometry || !!o.geometry.getAttribute('uv');
  let repeat = o.repeat;
  if (!repeat && o.geometry?.getAttribute('uv') && o.geometry.boundingBox === null) o.geometry.computeBoundingBox();
  if (!repeat && hasUv && o.geometry?.boundingBox) {
    // Flat parts: ExtrudeGeometry's UVs are the shape's own coordinates (inches here).
    repeat = [1 / (STITCH_W_IN * TILE_STITCHES), 1 / (STITCH_H_IN * TILE_STITCHES)];
  }
  if (repeat && hasUv && !o.wireframe) {
    const map = stitchNormalMap().clone();
    map.repeat.set(repeat[0], repeat[1]);
    map.needsUpdate = true;
    m.normalMap = map;
    m.normalScale = new Vector2(0.55, 0.55);
  }
  return m;
}

/** Frees a yarn material and its texture clone (the shared image stays). */
export function disposeYarnMaterial(m: MeshPhysicalMaterial): void {
  m.normalMap?.dispose();
  m.dispose();
}
