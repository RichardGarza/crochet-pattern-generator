// DESIGN.md §5.2.1 — cross-track entry points. Frozen at Step 0; change only through the S0 amendment lane
// (§6.1 rule 7).
//
// Every function one track calls in another track's code is listed here: its interface types and its exact
// signature as a `…Fn` type. The function itself lives at the module path named above each group. Step 0 created
// each track-owned one as a typed stub (`stub<…Fn>(name)`, src/core/stub.ts); a track replaces the stub with a
// function of the same signature. src/types/__checks__/entryPoints.check.ts fails `npm run typecheck` when an
// implementation drifts from its frozen signature.
//
// Component props (PatternView, ShapeTab, …) are in ./ui.ts.
import type { ManifoldToplevel } from 'manifold-3d';
import type { AmiRequest, AmiResult } from './ami';
import type { ChartGrid, ChartRequest, ChartResult, ChartSettings } from './chart';
import type { ResolvedGauge, TechniqueId } from './gauge';
import type { ColoredMesh, RgbaImage, ViewLabel } from './geometry';
import type { ImportContext, ImportInput, ImportResult, Repair } from './importer';
import type { CrochetModelV1, Dims, Hex, Part, PartType, Vec3 } from './model';
import type { Line, PatternDoc } from './pattern';
import type { AssetRef, ModelRevision, ProjectDoc, ProjectSummary } from './project';
import type { Hand, Terms } from './units';
import type { MeshApi } from './workers';
import type { Yarn } from './yarn';

// ---- core/model/sdf.ts, attach.ts, revisions.ts (S0, implemented in Step 0)

/** Positive inside. */
export type PartSdfFn = (part: Part, mesh?: (p: Vec3) => number) => (pWorld: Vec3) => number;
export type OverlapVolumeFn = (a: Part, b: Part, o?: { meshSdf?: Record<string, (p: Vec3) => number> }) => number;
export type SurfaceGapFn = (child: Part, parent: Part) => number;
export type InferAttachFn = (
  m: CrochetModelV1,
  o?: { meshSdf?: Record<string, (p: Vec3) => number> },
) => { model: CrochetModelV1; repairs: Repair[] };
export type InferMirrorPairsFn = (m: CrochetModelV1, o?: { tolerance?: number }) => { model: CrochetModelV1; repairs: Repair[] };

/** Part ids (and feature ids) whose authored data was carried into a new revision, or dropped (§5.5.5, §3.7.7). */
export interface CarryReport {
  crochet: string[];
  paint: string[];
  paintDropped: string[];
  features: string[];
}
export type CarryOverFn = (prev: CrochetModelV1 | undefined, next: CrochetModelV1) => { model: CrochetModelV1; report: CarryReport };

// ---- state/projectStore.ts (S0): the ONE way to replace the 3D model
//      (T3 rebuild, T6 convert/cut/merge/scale, T7 import/apply colors)

export type CommitModelRevisionFn = (
  next: CrochetModelV1,
  o: { source: ModelRevision['source']; label: string; carry: 'by-id' | 'none'; carryPaintAnyway?: string[] },
) => Promise<CarryReport>;

// ---- core/model/naming.ts, place.ts, proportions.ts, scale.ts (S0, implemented in Step 0; used by T3, T6 and T7)

/** §2.9.7 step 6. */
export type NamePartsFn = (
  m: CrochetModelV1,
  o?: { keepIds?: ReadonlySet<string> },
) => { model: CrochetModelV1; renames: Record<string, string> };

/** §3.3 step 3, Add part. `overlapIn` defaults to 0.10. */
export type PlaceChildOnSurfaceFn = (
  parent: Part,
  child: Part,
  at: { dir: Vec3 } | { hit: Vec3; normal: Vec3 },
  overlapIn?: number,
  o?: { meshSdf?: (p: Vec3) => number },
) => Part;

/** × 0.6 / 1 / 1.5 / 2.2 */
export type LimbLength = 'nubs' | 'short' | 'medium' | 'long';
/** Type of the `LIMB_TEMPLATE` constant of core/model/proportions.ts. */
export type LimbTemplate = Record<'quadruped' | 'quadruped-standing' | 'biped' | 'creature', { arm: number; leg: number }>;
export interface ProportionsReading {
  headBody?: number;
  limbs?: LimbLength;
  disabled: { headBody?: string; limbs?: string };
}
export type ReadProportionsFn = (m: CrochetModelV1) => ProportionsReading;
/** §4.2 */
export type ApplyProportionsFn = (
  m: CrochetModelV1,
  o: { headBody?: number; limbs?: LimbLength },
  meshes?: Record<string, ColoredMesh>,
) => { model: CrochetModelV1; meshes?: Record<string, ColoredMesh> };
/** Scales about the ground center. */
export type ScaleModelFn = (
  m: CrochetModelV1,
  factor: number,
  meshes?: Record<string, ColoredMesh>,
) => { model: CrochetModelV1; meshes?: Record<string, ColoredMesh> };

// ---- core/kernel/png.ts, core/kernel/geom/manifold.ts (S0, implemented)

/** RGBA8, filter 0, fflate zlib (1-px export, tests). */
export type EncodePngFn = (img: RgbaImage) => Uint8Array<ArrayBuffer>;
/** 8-bit gray / RGB / palette / gray-alpha / RGBA, non-interlaced. */
export type DecodePngFn = (bytes: Uint8Array) => RgbaImage;
/** §5.4: one tested init for node tests and workers. */
export type GetManifoldFn = () => Promise<ManifoldToplevel>;

// ---- workers/decode.ts, rpc.ts, client.ts (S0, implemented; §2.3.1, §5.4)
//      rpc.ts also exports `class Superseded extends Error { readonly jobId: number }`.

/** Workers only; HEIC via /__convert. */
export type DecodeImageFn = (input: Blob | RgbaImage) => Promise<RgbaImage>;
/** A MessageChannel ping. */
export type YieldMacrotaskFn = () => Promise<void>;
export type CreateJobGateFn = () => { supersede(jobId: number): void; check(jobId: number): Promise<void> };
export type LatestWinsFn = <Q extends { jobId: number }, R>(
  send: (q: Q) => Promise<R>,
  supersede: (jobId: number) => Promise<void>,
) => (q: Omit<Q, 'jobId'>) => Promise<R>;

// ---- T1 — core/image2d/run.ts, core/yarn/match.ts

export type RunChartFn = (req: ChartRequest, gate?: { check(jobId: number): Promise<void> }) => Promise<ChartResult>;
/** T4 uses it for names, T6 for the palette. */
export type NearestYarnFn = (hex: Hex, lineIds: string[]) => { yarn: Yarn; deltaE00: number } | null;

// ---- T2 — core/techniques/index.ts, core/pattern/render.ts

/** Border rounds come from settings.border + gauge.hSc (§2.7.10). */
export type BuildPattern2DFn = (i: {
  chart: ChartGrid;
  settings: ChartSettings;
  gauge: ResolvedGauge;
  terms: Terms;
  dialect: 'compact' | 'verbose';
  title: string;
}) => PatternDoc;
export type RenderLineFn = (
  line: Line,
  o: { dialect: 'compact' | 'verbose'; terms: Terms; hand: Hand; decMethod?: 'invdec' | 'sc2tog' },
) => string;

// ---- T2 — core/techniques/export.ts, core/pattern/{text,skill,notes,terminology}.ts: T8's export dialog and
//      T4's 3D PatternDoc call these; T8 never formats pattern text or chart files itself

/** The png goes through core/kernel/png.ts. */
export type ExportChartFn = (grid: ChartGrid, kind: 'png1px' | 'csv' | 'json') => Blob;
export type RenderPatternTextFn = (
  doc: PatternDoc,
  o: { format: 'txt' | 'md'; terms: Terms; hand: Hand; dialect: 'compact' | 'verbose' },
) => string;
export interface SkillInput {
  colors: number;
  meanChangesPerLine: number;
  technique: TechniqueId;
  pieces?: number;
  irregularShaping?: boolean;
  bloFlo?: boolean;
}
/** §2.8 skill points. */
export type ComputeSkillFn = (i: SkillInput) => PatternDoc['skill'];
export type NotesForFn = (
  kind: 'flat-graph' | 'tapestry' | 'tapestry-round' | 'c2c' | 'mosaic' | 'border' | 'amigurumi',
  ctx: {
    terms: Terms;
    hand: Hand;
    corner?: string;
    arrows?: string[];
    joinedRounds?: boolean;
    leanStPerRnd?: number;
    roundLean?: ChartSettings['roundLean'];
  },
) => string[];
export type AbbreviationsForFn = (lines: Line[], terms: Terms) => PatternDoc['abbreviations'];
export type SpecialStitchesForFn = (lines: Line[], terms: Terms) => PatternDoc['specialStitches'];

// ---- T3 — core/recon/fit.ts

export interface FitResult {
  type: PartType;
  dims: Dims;
  position: Vec3;
  rotationDeg: Vec3;
  residual: number;
}
export type FitPartFn = (mesh: ColoredMesh, o?: { tolerance?: number }) => FitResult;

// ---- T4 — core/ami/generate.ts (deps.pathB = the private mesh.worker's pathB, §5.4)

export type GenerateAmigurumiFn = (
  req: AmiRequest,
  deps: { pathB?: MeshApi['pathB']; gate?: { check(jobId: number): Promise<void> } },
) => Promise<AmiResult>;

// ---- T6 — ui/shape/placement.ts

export interface PlacementHighlight {
  partId: string;
  rounds: [number, number];
  stitches: number[];
  color?: Hex;
  label?: string;
}
/** Returns a PNG; T8 falls back to text when it is not implemented. */
export type RenderPlacementImageFn = (
  model: CrochetModelV1,
  partId: string,
  highlights: PlacementHighlight[],
  o?: { widthPx?: number; view?: 'auto' | ViewLabel },
) => Promise<Blob>;

// ---- T7 — core/importer/index.ts (§3.7.1; runs in import.worker)

export type ImportInputsFn = (inputs: ImportInput[], ctx?: ImportContext) => Promise<ImportResult>;

// ---- T8 — core/persist/repo.ts, ui/library/useAutosave.ts, core/print/pdf.ts

export interface ProjectRepository {
  list(): Promise<ProjectSummary[]>;
  /** Single writer, §5.5.2. */
  open(id: string, mode: 'edit' | 'read'): Promise<{ doc: ProjectDoc; readOnly: boolean }>;
  /** locks.request(…, { steal: true }), §5.5.2. */
  takeOver(id: string): Promise<{ doc: ProjectDoc; readOnly: false }>;
  save(
    doc: ProjectDoc,
    newAssets: Map<string, Blob>,
    o: { baseRev: number },
  ): Promise<{ ok: true; rev: number } | { ok: false; conflict: { storedRev: number } }>;
  /** Takes the copy's lock. */
  saveAsCopy(doc: ProjectDoc, newAssets: Map<string, Blob>): Promise<{ id: string; rev: 1 }>;
  putAsset(projectId: string, bytes: Blob, mime: string): Promise<AssetRef>;
  getAsset(ref: AssetRef): Promise<Blob>;
  exportFile(id: string): Promise<Blob>;
  importFile(f: Blob): Promise<{ id: string; renamed: boolean }>;
  remove(id: string): Promise<void>;
}

/** `navigator.locks` in the app; an in-memory fake in unit tests (src/test/fakes.ts). */
export interface LockManagerLike {
  request(
    name: string,
    o: { ifAvailable?: boolean; steal?: boolean },
    cb: (lock: unknown | null) => Promise<unknown>,
  ): Promise<unknown>;
}

/** `BroadcastChannel` in the app; an in-memory fake in unit tests (src/test/fakes.ts). */
export interface ChannelLike {
  postMessage(m: unknown): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  close(): void;
}

/** Fakes are passed in unit tests (§6.3 T8). */
export type CreateProjectRepositoryFn = (o?: {
  idb?: IDBFactory;
  locks?: LockManagerLike;
  channel?: (name: string) => ChannelLike;
  now?: () => Date;
}) => ProjectRepository;
export type UseAutosaveFn = () => { status: 'saved' | 'saving' | 'error' | 'read-only'; flush(): Promise<void> };
export type BuildPdfFn = (doc: PatternDoc, o: { paper: 'letter' | 'a4'; placementImages?: Record<string, Blob> }) => Promise<Blob>;
