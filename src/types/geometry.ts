// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
import type { ResolvedGauge } from './gauge';
import type { Issue } from './issues';
import type { CrochetModelV1, Vec3 } from './model';
import type { Inches } from './units';

// §3.5.1 and §5.2 both declare `Vec3 = [number, number, number]`; it is one type, declared in ./model.
export type { Vec3 };

/** RGBA8, orientation applied (§2.3.1). `data.length === w * h * 4`, row-major from the top-left. */
export interface RgbaImage {
  w: number;
  h: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

export interface ColoredMesh {
  positions: Float32Array<ArrayBuffer>;
  indices: Uint32Array<ArrayBuffer>;
  /** Per vertex; 255 = unknown. */
  labels: Uint8Array<ArrayBuffer>;
  partId?: Uint8Array<ArrayBuffer>;
}

/** Stored per recon mesh part as asset `sdf:<meshRef>` (§2.9.7). */
export interface SdfVolume {
  /**
   * voxel/256 units, positive inside, saturating at ±127.996 voxels. Sample (x, y, z) is the point
   * `origin + voxel·(x, y, z)`, x fastest.
   */
  data: Int16Array<ArrayBuffer>;
  dims: [number, number, number];
  origin: Vec3;
  voxel: Inches;
}

export type ViewLabel = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom';

export interface PhotoView {
  id: string;
  imageKey: string;
  label: ViewLabel;
  maskKey?: string;
  /** Asset: CPGL header + Int8 labels into photoPalette (§2.9.6). */
  labelsKey?: string;
  /**
   * `dx`, `dy` in world units (object heights) along the view's image right and up; `scale` > 1 enlarges the
   * outline in the world; `rot90` quarter turns clockwise; `mirror` flips left ↔ right after the turn (§2.9.2).
   */
  align: { scale: number; dx: number; dy: number; rot90: 0 | 1 | 2 | 3; mirror: boolean };
}

export interface ReconSettings {
  N: 64 | 128 | 192;
  kappa: number;
  /** Single image: what the photo shows (F3 step 1, §2.9.3). */
  photoView: 'front' | 'left' | 'right' | 'top';
  /** Single image: back depth (§2.9.4). */
  backShape: 'mirror' | 'inflate';
  /** Single image: back labels (§2.9.6); default 'part' (front/top), 'mirror' (left/right). */
  backColors: 'part' | 'mirror' | 'solid' | 'photo';
  solidColor?: string;
  /** Default true (front/top), false (left/right). */
  oneSidedDetail: boolean;
  useDepth: boolean;
  keepHoles: boolean;
  mergeTouching: boolean;
  splitNeck: boolean;
  openingFrac: number;
  fitTolerance: number;
  /** photoView 'top': the longest extent in the photo plane. */
  targetHeightIn: Inches;
}

export interface ReconRequest {
  jobId: number;
  views: { view: PhotoView; image: Blob | RgbaImage; mask: Uint8Array<ArrayBuffer>; maskW: number; maskH: number }[];
  settings: ReconSettings;
  gauge: ResolvedGauge;
  depth?: { data: Float32Array<ArrayBuffer>; w: number; h: number };
}

export interface ReconResult {
  jobId: number;
  model: CrochetModelV1;
  meshes: Record<string, ColoredMesh>;
  /** Per mesh part, stored as assets (§2.9.7 step 3). */
  sdfs: Record<string, SdfVolume>;
  /** Per view id → PhotoView.labelsKey. */
  labelImages: Record<string, { labels: Int8Array<ArrayBuffer>; w: number; h: number }>;
  /** Label index → color → ProjectDoc.threeD.photoPalette. */
  photoPalette: { hex: string; name?: string }[];
  report: { iouPerView: Record<string, number>; parts: number; genus: number };
  issues: Issue[];
}
