// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
import type { AmiSettings } from './ami';
import type { ChartEdits, ChartSettings, CropRect } from './chart';
import type { GaugeSpec } from './gauge';
import type { PhotoView, ReconSettings } from './geometry';
import type { Repair } from './importer';
import type { CrochetModelV1 } from './model';
import type { QaState } from './qa';
import type { Hand, Terms, UnitPref } from './units';

/** A content-addressed asset: `key` = `<projectId>/<sha256>` (§5.3, §5.5.1). */
export interface AssetRef {
  key: string;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface SourceImage {
  id: string;
  asset: AssetRef;
  name: string;
  w: number;
  h: number;
  addedAt: string;
}

export interface ModelRevision {
  rev: number;
  at: string;
  source: 'seed' | 'recon' | 'import' | 'edit';
  label: string;
  asset: AssetRef;
}

export interface ImportRecord {
  id: string;
  at: string;
  fileName: string;
  carrier: string;
  dialect: string;
  confidence: string;
  /** Repair: §3.7.1. */
  repairs: Repair[];
  original: AssetRef;
  revision: number;
}

export interface ProjectDoc {
  schema: 'crochet-project';
  version: 1;
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rev: number;
  mode: '2d' | '3d';
  units: UnitPref;
  terms: Terms;
  hand: Hand;
  gauge: GaugeSpec;
  sources: SourceImage[];
  twoD?: { sourceId: string; crop?: CropRect; settings: ChartSettings; edits: ChartEdits };
  threeD?: {
    origin: 'multiview' | 'single' | 'claude-design' | 'describe';
    /**
     * Absent until the first build or import succeeds: a 3D project holds its photo views, its recon and yarn
     * settings (F2/F3 steps 1–5), or its Q&A state ("Describe a toy"), before any model exists, and a failed
     * build leaves none. Replace it only through `commitModelRevision` (§5.2.1).
     *
     * DESIGN.md §5.2 writes `model: CrochetModelV1` (required), which cannot represent those states; this is the
     * one place where src/types differs from the spec's text (docs/tracks/s0.md; scripts/check-spec-types.mjs
     * lists it as a pending spec amendment).
     */
    model?: CrochetModelV1;
    meshAssets: Record<string, AssetRef>;
    revisions: ModelRevision[];
    views: PhotoView[];
    /** The photos' joint palette (§2.9.6). */
    photoPalette?: { hex: string; name?: string }[];
    recon?: ReconSettings;
    ami: AmiSettings;
  };
  qa?: QaState;
  imports: ImportRecord[];
  thumbnail?: AssetRef;
}

export interface ProjectSummary {
  id: string;
  name: string;
  mode: '2d' | '3d';
  updatedAt: string;
  thumbnail?: AssetRef;
}
