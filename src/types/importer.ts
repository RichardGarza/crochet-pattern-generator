// DESIGN.md §3.7.1 — the importer contract. Frozen at Step 0; change only through the S0 amendment lane
// (§6.1 rule 7). The importer runs in import.worker; there is no DOM anywhere in core/importer.
import type { ColoredMesh } from './geometry';
import type { Issue } from './issues';
import type { CrochetModelV1 } from './model';

export type ImportInput = { kind: 'file'; name: string; bytes: ArrayBuffer } | { kind: 'text'; text: string };

export type LengthUnit = 'in' | 'cm' | 'm' | 'mm';

export interface ImportContext {
  /** The target project's seed finishedSize.height, else its Yarn & size height (§3.7.5). */
  expectedHeightIn?: number;
  /** SpecCandidate.id chosen in the "versions" picker (§3.7.2). */
  pickCandidate?: string;
  /** The user's answer to the units confirm of a geometry-only carrier (§3.7.5). */
  units?: LengthUnit;
}

/** One spec found in an archive (§3.7.2). */
export interface SpecCandidate {
  id: string;
  /** Archive entry. */
  path: string;
  source: 'html' | 'glb' | 'chat' | 'json';
  revision: number;
  parts: number;
  chosen: boolean;
}

export interface UnitsDecision {
  rawHeight: number;
  readings: { unit: LengthUnit; heightIn: number }[];
  chosen: LengthUnit | 'normalized';
  reason: 'spec' | 'gltf-extras-ratio' | 'expected-height' | 'stage-header' | 'small-bbox' | 'user';
  /** Ask the user, showing both readings. */
  confirm: boolean;
}

/** One "auto-corrected" chip each (§3.7.6). */
export interface Repair {
  code:
    | 'attach-inferred'
    | 'mirror-inferred'
    | 'units'
    | 'ground'
    | 'axes'
    | 'radians'
    | 'color'
    | 'dims-clamped'
    | 'id'
    | 'unknown-key'
    | 'feature-dropped'
    | 'limits'
    | 'versions'
    | 'spec-rebuilt';
  message: string;
  part?: string;
  data?: Record<string, unknown>;
}

export interface ImportResult {
  ok: boolean;
  model?: CrochetModelV1;
  /** Mesh parts, keyed by meshRef. */
  meshes?: Record<string, ColoredMesh>;
  carrier: 'text' | 'json' | 'html' | 'standalone-html' | 'zip' | 'tar' | 'glb' | 'gltf' | 'obj' | 'ply' | 'stl' | 'image';
  dialect: 'canonical-1' | 'cd-observed-2026-09' | 'geometry-only';
  confidence: 'high' | 'medium' | 'low';
  repairs: Repair[];
  warnings: Issue[];
  fingerprint: string[];
  /** Every spec found in an archive (§3.7.2). */
  candidates?: SpecCandidate[];
  /** Geometry carriers (§3.7.5). */
  units?: UnitsDecision;
  /** The model's "x-cpg", for the return path (§3.7.7). */
  cpgTag?: { project: string; seedRev: number };
  /** When only pictures were found (offer F3). */
  images?: ArrayBuffer[];
}
