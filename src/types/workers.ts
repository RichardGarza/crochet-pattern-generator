// DESIGN.md §5.2 — frozen at Step 0. Change only through the S0 amendment lane (§6.1 rule 7).
//
// The comlink APIs of the six workers (§5.4): latest-wins channels and cooperative cancellation. Clients pass
// callbacks as `Comlink.proxy(fn)` and request-owned buffers with `Comlink.transfer`.
import type { AmiRequest, AmiResult, AmiSettings, PieceFrame, RoundsResult } from './ami';
import type { ChartGrid, ChartRequest, ChartResult, ChartSettings } from './chart';
import type { ResolvedGauge } from './gauge';
import type { ColoredMesh, PhotoView, ReconRequest, ReconResult, RgbaImage, SdfVolume } from './geometry';
import type { ImportContext, ImportInput, ImportResult } from './importer';
import type { Issue } from './issues';
import type { CrochetModelV1, Dims, PaletteColor, Part, PartType, Vec3 } from './model';
import type { PatternDoc } from './pattern';
import type { Terms } from './units';

/** Every worker API below extends it. */
export interface Cancellable {
  supersede(jobId: number): Promise<void>;
}

/** chart2d.worker (T1). */
export interface Chart2dApi extends Cancellable {
  run(r: ChartRequest): Promise<ChartResult>;
  buildPattern(r: {
    chart: ChartGrid;
    settings: ChartSettings;
    gauge: ResolvedGauge;
    terms: Terms;
    dialect: 'compact' | 'verbose';
    title: string;
  }): Promise<PatternDoc>;
}

/** geom.worker (T3). */
export interface GeomApi extends Cancellable {
  /** `raw` = the mask before `refineMask` (brush edits re-run it); `scale` = mask px per photo px; `issues` = §2.9.1 guards. */
  mask(
    image: Blob | RgbaImage,
    o?: { keepHoles?: boolean },
  ): Promise<{ mask: Uint8Array<ArrayBuffer>; w: number; h: number; raw?: Uint8Array<ArrayBuffer>; scale?: number; issues?: Issue[] }>;
  /**
   * A build that cannot make a model rejects with an Error named `ReconError` whose message starts with its issue code
   * (`"E_VIEWS: …"`; comlink keeps only name and message); malformed requests throw `RangeError` (§2.9.3, v1.5).
   */
  build(r: ReconRequest): Promise<ReconResult>;
  /** "Apply photo colors", §2.9.6. */
  projectColors(r: {
    jobId: number;
    model: CrochetModelV1;
    meshes: Record<string, ColoredMesh>;
    /** Read from labelsKey / maskKey. */
    views: { view: PhotoView; labels: Int8Array<ArrayBuffer>; mask: Uint8Array<ArrayBuffer>; w: number; h: number }[];
    photoPalette: { hex: string; name?: string }[];
    /** Labels → palette, ΔE00 < 5 merge. */
    palette: PaletteColor[];
  }): Promise<{
    /** Per part id: `paint` for a primitive, vertex labels (Uint8Array) for a mesh part. */
    paint: Record<string, Part['paint'] | Uint8Array<ArrayBuffer>>;
    palette: PaletteColor[];
    viewIoU: Record<string, number>;
    issues: Issue[];
  }>;
}

/** ml.worker (T3). */
export interface MlApi extends Cancellable {
  status(): Promise<{ webgpu: boolean; depthCached: boolean; samCached: boolean }>;
  /** The client passes `Comlink.proxy(onProgress)`. */
  depth(image: Blob | RgbaImage, onProgress?: (p: number) => void): Promise<{ data: Float32Array<ArrayBuffer>; w: number; h: number }>;
  samEncode(image: Blob | RgbaImage): Promise<void>;
  samMask(points: { x: number; y: number; positive: boolean }[]): Promise<{ mask: Uint8Array<ArrayBuffer>; w: number; h: number }>;
}

/** mesh.worker (T5); two instances: the editor's and ami.worker's private one (§5.4). */
export interface MeshApi extends Cancellable {
  pathB(r: {
    jobId: number;
    mesh: ColoredMesh;
    partId: string;
    frame: Partial<PieceFrame>;
    gauge: ResolvedGauge;
    settings: AmiSettings;
    /** Design v1.5 (§2.10.7 step 1), part-local inches: the part's `crochet.seed`. */
    seed?: Vec3;
    /**
     * Design v1.5, part-local inches: points of the attachment boundary (where the part meets its parent), from which
     * the default seed is the geodesically farthest tip. Absent for the root part (seed: the lowest patch).
     */
    attach?: Vec3[];
  }): Promise<RoundsResult | { needsSplit: { level: number; loops: number[] } }>;
  /**
   * §2.9.8, editor ⌘J; geometry + labels only — T6's recipe picks the kept id and attach. Mesh and sdf are in model
   * space for an unrotated part (T5's `recenterMesh` gives the bbox-centered form). `paletteIds` = the model palette's
   * ids, so primitives' colors become vertex labels.
   */
  merge(
    parts: { part: Part; mesh?: ColoredMesh; sdf?: SdfVolume }[],
    o?: { N?: number; paletteIds?: string[] },
  ): Promise<{ mesh: ColoredMesh; sdf: SdfVolume; volumeIn3: number; unionVolumeIn3: number; genus: number }>;
  /** Narrow band, §2.9.8. */
  voxelize(mesh: ColoredMesh, N: number, o?: { storedSdf?: SdfVolume }): Promise<{ volumeId: string }>;
  sculpt(
    volumeId: string,
    stroke: {
      tool: 'inflate' | 'deflate' | 'smooth' | 'flatten';
      points: Vec3[];
      radius: number;
      strength: number;
      mirrorX: boolean;
      /** The model's symmetry plane in the volume's frame; default x = 0 of that frame. */
      mirrorPlane?: { point: Vec3; normal: Vec3 };
    },
  ): Promise<{ mesh: ColoredMesh; undoId: string }>;
  undoSculpt(undoId: string): Promise<{ mesh: ColoredMesh }>;
  /** Re-applies the stroke `undoSculpt(undoId)` took back (⇧⌘Z). */
  redoSculpt?(undoId: string): Promise<{ mesh: ColoredMesh }>;
  cut(volumeId: string, plane: { point: Vec3; normal: Vec3 }): Promise<[ColoredMesh, ColoredMesh]>;
  fit(mesh: ColoredMesh): Promise<{ type: PartType; dims: Dims; position: Vec3; rotationDeg: Vec3; residual: number }>;
  fromPart(part: Part, o?: { paletteIds?: string[]; N?: number }): Promise<ColoredMesh>;
}

/** ami.worker (T4). */
export interface AmiApi extends Cancellable {
  generate(r: AmiRequest): Promise<AmiResult>;
}

/** import.worker (T7). */
export interface ImportApi extends Cancellable {
  importInputs(inputs: ImportInput[], ctx?: ImportContext): Promise<ImportResult>;
}
