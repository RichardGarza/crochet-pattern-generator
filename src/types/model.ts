// DESIGN.md §3.5.1 — the `crochet-model` schema, version 1.0. Frozen at Step 0; change only through the S0
// amendment lane (§6.1 rule 7). Mirrored by the zod schema in src/core/model/schema.ts, which must stay in step.
//
// Conventions (§0.1): inches; right-handed, +Y up, the object's front faces +Z and its own left is +X; the lowest
// point is at y = 0; colors are sRGB hex. Semantics and limits: §3.5.2.

/** sRGB color, `/^#[0-9a-fA-F]{6}$/`. */
export type Hex = string;
export type Vec3 = [number, number, number];
/** 'mesh' is app-internal and is never sent to Claude Design. */
export type PartType = Part['type'];

export interface CrochetModelV1 {
  schema: 'crochet-model';
  /** `/^1\.\d+$/` — the writer emits "1.0". */
  version: string;
  /** +1 on every edit; the importer prefers the highest. */
  revision: number;
  units: 'in';
  axes: { up: '+Y'; front: '+Z'; left: '+X' };
  name: string;
  description?: string;
  category?: 'quadruped' | 'biped' | 'bird' | 'sea' | 'insect' | 'person' | 'creature' | 'food' | 'plant' | 'object' | 'other';
  style?: 'chibi' | 'realistic' | 'minimal';
  /** under3 ⇒ embroidered features only. */
  audience?: 'adult' | 'child' | 'under3';
  /** Bounding box, inches, 0 < h ≤ 60. */
  finishedSize: { height: number; width?: number; depth?: number };
  pose?: 'standing' | 'sitting' | 'lying' | 'hanging' | 'free';
  flatBase?: boolean;
  yarn?: { weightCYC?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7; hookMm?: number; stsPerIn?: number; fiber?: string };
  /** 1..16 */
  palette: PaletteColor[];
  /** 1..60 */
  parts: Part[];
  /** 0..60 */
  features?: Feature[];
  assembly?: { order: number; part: string; to?: string; text: string }[];
  assumptions?: string[];
  source?: {
    tool?: string;
    stage?: 'seed' | 'refined' | 'edited' | 'recon' | 'refined-from-mesh';
    views?: string[];
    createdAt?: string;
    promptVersion?: string;
    builderVersion?: string;
  };
  /**
   * Extensions: kept, never rejected. Our seeds carry `"x-cpg": { project: string; seedRev: number }` (§3.3).
   */
  [k: `x-${string}`]: unknown;
}

export interface PaletteColor {
  /** `/^[a-z0-9_]{1,16}$/` */
  id: string;
  hex: Hex;
  name?: string;
  role?: 'main' | 'accent' | 'detail';
}

interface PartCommon {
  /** `/^[a-z][a-z0-9_]{0,31}$/`, unique; pairs end `_l` / `_r`. */
  id: string;
  label?: string;
  /**
   * ABSOLUTE model-space local origin, inches: the center for every type except lathe (the axis point at
   * profile y = 0).
   */
  position: Vec3;
  /** Euler XYZ, degrees. */
  rotationDeg?: Vec3;
  /** Palette id (base color). */
  color: string;
  /** ≤ 24 */
  regions?: Region[];
  attach?: { to: string; method?: 'sewn' | 'crochet-in-place' | 'worked-from' | 'glued' | 'none'; openEnd?: 'top' | 'bottom' | 'none' };
  mirrorOf?: string;
  stuffing?: 'firm' | 'medium' | 'light' | 'none';
  /** 0..1 */
  flatten?: number;
  notes?: string;
  /** App-owned (editor); stripped from prompts. */
  crochet?: PartCrochetHints;
  /** App-owned: base64 of 64×64 Uint8 palette indices, 255 = none. */
  paint?: { kind: 'uv64'; data: string };
  [k: `x-${string}`]: unknown;
}

/** A discriminated union on `type`. The builder (§3.4.1) is the reference for every dimension. */
export type Part = PartCommon &
  (
    | { type: 'sphere'; dims: { r: number } }
    /** Radii. */
    | { type: 'ellipsoid'; dims: { rx: number; ry: number; rz: number } }
    /** `length` = TOTAL length including the caps (≥ 2r). */
    | { type: 'capsule'; dims: { r: number; length: number } }
    | { type: 'cylinder'; dims: { rTop: number; rBottom: number; h: number; open?: 'none' | 'top' | 'bottom' | 'both' } }
    /** Apex +Y. */
    | { type: 'cone'; dims: { r: number; h: number } }
    /** Ring in local XY. */
    | { type: 'torus'; dims: { R: number; r: number; arcDeg?: number } }
    /** `profile` = [radius, y] bottom→top, r ≥ 0, y non-decreasing, 3..64 points. */
    | { type: 'lathe'; dims: { profile: [number, number][]; sharp?: number[] } }
    /** Local XY, faces +Z. */
    | {
        type: 'flat';
        dims: {
          shape: 'circle' | 'oval' | 'teardrop' | 'triangle' | 'rect' | 'polygon';
          w: number;
          h: number;
          thickness: number;
          points?: [number, number][];
        };
      }
    | { type: 'box'; dims: { w: number; h: number; d: number } }
    /** App-internal; vertices are part-local, origin = bbox center. */
    | { type: 'mesh'; dims: { meshRef: string; bboxIn: Vec3 } }
  );

export type Dims = Part['dims'];

export interface PartCrochetHints {
  make?: 'auto' | 'piece' | 'applique' | 'embroidery' | 'safety_eye' | 'region' | 'skip';
  start?: 'auto' | 'bottom' | 'top';
  axis?: 'auto' | 'x' | 'y' | 'z';
  /** Part-local; mesh parts. */
  seed?: Vec3;
  style?: 'classic' | 'exact';
  seamAzimuthDeg?: number;
}

/** `from` / `to` = height fraction along local Y (0 = bottom); azimuth 0° = +Z, +90° = +X; elevation +90° = +Y (§3.5.2). */
export type Region =
  | { kind: 'band'; from: number; to: number; color: string }
  | { kind: 'stripes'; from?: number; to?: number; colors: string[]; widthIn: number }
  | { kind: 'patch'; azimuthDeg: number; spanDeg: number; from: number; to: number; color: string }
  | { kind: 'spot'; azimuthDeg: number; elevationDeg: number; radiusIn: number; color: string }
  | {
      kind: 'pattern';
      pattern: 'spots' | 'leopard' | 'checker' | 'speckle' | 'gradient' | 'vertical-stripes';
      colors: string[];
      scaleIn?: number;
      coverage?: number;
      from?: number;
      to?: number;
    };

export interface Feature {
  id: string;
  kind: 'safety_eye' | 'embroidered_eye' | 'felt' | 'nose' | 'mouth' | 'cheek' | 'brow' | 'whiskers' | 'line' | 'applique';
  /** The part this feature sits on; azimuth and elevation are on that part's surface, in its local frame. */
  on: string;
  azimuthDeg: number;
  elevationDeg: number;
  sizeMm?: number;
  sizeIn?: number;
  color?: string;
  /** [az, el] polyline (embroidery). */
  path?: [number, number][];
  /** Also place at −azimuth. */
  mirror?: boolean;
}
