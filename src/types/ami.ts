// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
import type { ResolvedGauge } from './gauge';
import type { ColoredMesh } from './geometry';
import type { Issue } from './issues';
import type { CrochetModelV1, Vec3 } from './model';
import type { LineStart, Loop, PatternDoc, PieceFinish } from './pattern';
import type { Hand, Inches, Terms } from './units';

/** How a part is made (§2.10.1). */
export type MakeAs = 'piece' | 'applique' | 'embroidery' | 'safety_eye' | 'region' | 'skip';

export interface AmiSettings {
  style: 'classic' | 'exact';
  spiral: boolean;
  crispStripes: boolean;
  decMethod: 'invdec' | 'sc2tog';
  dialect: 'compact' | 'verbose';
  terms: Terms;
  hand: Hand;
  eyes: 'auto' | 'safety' | 'embroidered';
  /** Size changes go through "Scale model to height" (§4.2). */
  defaultStuffing: 'firm' | 'medium' | 'light';
  /** Spiral lean, default 0.25, 0 = off (§2.11.2). */
  leanStPerRnd: number;
}

export interface PieceFrame {
  axis: Vec3;
  startPole: 'bottom' | 'top';
  seamDir: Vec3;
  oval?: { S1: number };
  trimmedAt?: number;
}

export interface RingGeom {
  center: Vec3;
  normal: Vec3;
  radius: number;
  polyline?: Float32Array;
}

export interface RoundsResult {
  partId: string;
  path: 'A' | 'B';
  counts: number[];
  loops: Loop[];
  hEff: Inches;
  closedEnd: boolean;
  start: LineStart;
  finish: PieceFinish['kind'];
  ovalS?: number[];
  rings: RingGeom[];
  stitchLabels: Uint8Array[];
}

export interface AmiRequest {
  jobId: number;
  model: CrochetModelV1;
  meshes: Record<string, ColoredMesh>;
  gauge: ResolvedGauge;
  settings: AmiSettings;
  dirtyParts?: string[];
}

export interface AmiResult {
  jobId: number;
  plan: Record<string, MakeAs>;
  frames: Record<string, PieceFrame>;
  rounds: Record<string, RoundsResult>;
  ghosts: Record<string, Float32Array>;
  pattern: PatternDoc;
  issues: Issue[];
  hash: string;
}
