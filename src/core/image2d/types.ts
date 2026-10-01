// Types of the 2D ingest and sampling stages (DESIGN.md §2.3). Track T1, sprint T1.1.
//
// These are working types inside `core/image2d` and the later T1 stages (quantize, cleanup, capture); the
// frozen cross-track types are in `src/types` (`RgbaImage`, `ChartResult`, …).
import type { ImageKind } from '../../types/chart';
import type { Issue } from '../../types/issues';
import type { GridSize } from '../gauge/grid';

/**
 * An image in linear light with premultiplied alpha, 4 floats per pixel: (r·a, g·a, b·a, a), each 0..1,
 * row-major from the top-left. Every average in §2.3 is taken in this space: averaging premultiplied values
 * gives transparent pixels no weight in the color (§2.3.2, [06 §5]) and linear light keeps edges from going
 * muddy [06 §1.1].
 */
export interface LinearImage {
  w: number;
  h: number;
  data: Float32Array<ArrayBuffer>;
}

/**
 * The source interval of every cell along one axis, in pixels: cell k covers `[start[k], end[k])`. Fractional
 * bounds are exact fractional coverage (§2.3.4). Uniform spans tile the axis; a pixel-art lattice leaves a
 * small margin between neighbors (only the block interiors are sampled).
 */
export interface Spans {
  start: Float64Array<ArrayBuffer>;
  end: Float64Array<ArrayBuffer>;
}

/** The native pixel grid of pixel art (§2.3.4): a lattice of blocks `s` pixels wide starting at `phase`. */
export interface PixelLattice {
  /** Block size in pixels along x and y (may be fractional when the art was scaled by a non-integer factor). */
  sx: number;
  sy: number;
  /** Position of one block boundary, 0 ≤ phase < s. */
  phaseX: number;
  phaseY: number;
  /** Native pixels across and down (blocks; a partial block at an edge counts when it is at least half a block). */
  cols: number;
  rows: number;
  /** Block boundaries in pixels: block k spans `[xEdges[k], xEdges[k + 1])`; length cols + 1 (rows + 1). */
  xEdges: Int32Array<ArrayBuffer>;
  yEdges: Int32Array<ArrayBuffer>;
  /** Share of the edge evidence that lies on the lattice lines, per axis (0..1). */
  coverageX: number;
  coverageY: number;
  /** Share of the raw edge counts at the lattice lines, per axis (0..1). */
  rawShareX: number;
  rawShareY: number;
  /** Share of the lattice lines (between the first and last with an edge) that carry an edge, per axis. */
  occupancyX: number;
  occupancyY: number;
  /** Share of blocks whose interior has ΔEOKr2 standard deviation < 0.03 (accepted at ≥ 0.9). */
  uniformShare: number;
  /** True when the §2.3.4 test accepts the lattice; a rejected lattice is kept for a user override. */
  accepted: boolean;
}

/** What the image-kind detector measured on the (un-scaled) crop (§2.3.4). */
export interface ImageStats {
  w: number;
  h: number;
  /** Distinct colors, counted exactly up to 256; 257 means "more than 256". Transparent pixels count as one color. */
  uniqueColors: number;
  /** Share of pixels covered by the 16 most frequent colors (0 when there are more than 256 colors). */
  top16Share: number;
  /** Share of pixels whose 4-neighbors are all within ΔEOKr2 0.01. */
  flatness: number;
  /** Share of pixels with alpha < 255. */
  translucentShare: number;
  /** `imageFingerprint` of the analyzed crop: cached stats are checked against it. */
  fingerprint: string;
  /** The best pixel lattice found, accepted or not; undefined when the edges show no lattice at all. */
  lattice?: PixelLattice;
  /** The kind the rules of §2.3.4 pick. */
  kind: ImageKind;
}

/** How the background of a sampled image was decided (§2.3.2). */
export interface BackgroundInfo {
  /** 'alpha' = the image has transparency; 'plain' = "remove plain background" found one; 'none' = no background. */
  source: 'alpha' | 'plain' | 'none';
  /** Color the background stitches are worked in, and that translucent edges were composited over. */
  hex: string;
  /**
   * Where `hex` came from: the setting, the border color of a plain background, the mean of the brushed
   * background pixels (brush without a plain background), or white for transparency.
   */
  hexFrom: 'setting' | 'border' | 'brush' | 'white';
  /** Share of the working image that is subject (alpha ≥ 0.5 after removal), 0..1. */
  subjectShare: number;
  /** Plain-background removal: the mask at the working resolution, 1 = background (for the UI to show). */
  mask?: Uint8Array<ArrayBuffer>;
  maskW?: number;
  maskH?: number;
  /** Plain-background removal: what the border ring measured (share of the ring in one cluster, its ΔEOKr2 std). */
  ring?: { share: number; std: number; hex: string };
}

/** Cell colors in the spaces later stages need. */
export interface CellColors {
  /** Linear RGB per cell (3 floats), composited over the background color; background cells hold that color. */
  lin: Float32Array<ArrayBuffer>;
  /** Cluster features (toe(L), 2a, 2b) per cell (3 floats), from `lin` (§2.4.1). */
  feat: Float32Array<ArrayBuffer>;
}

/** The output of the T1.1 stages: everything the quantizer (T1.2) and cleanup (T1.3) need. */
export interface SampledImage {
  /** The kind used, and the kind auto-detection picked (they differ after a user override). */
  kind: ImageKind;
  autoKind: ImageKind;
  stats: ImageStats;
  /** Size of the crop, pixels (= `ChartResult.source`). */
  source: { w: number; h: number };
  /** `ChartResult.size`. */
  size: GridSize;
  cols: number;
  rows: number;
  /**
   * The image the cells were sampled from: the crop in linear premultiplied light, scaled to ≤ 2048 px on the
   * long side (pixel art: never scaled), with removed background pixels made fully transparent.
   */
  work: LinearImage;
  /** Source intervals of the columns and rows in `work`. */
  xs: Spans;
  ys: Spans;
  /** Box averages per cell, linear premultiplied (cols × rows image). */
  cells: LinearImage;
  /** 1 = background cell (coverage α < 0.5), a label outside the K budget (§2.3.2). */
  background: Uint8Array<ArrayBuffer>;
  /** Cell colors composited over `bg.hex`. */
  colors: CellColors;
  bg: BackgroundInfo;
  /** Pixel art: the lattice the cells follow (one cell = one native pixel). */
  lattice?: PixelLattice;
  /** Pixel art: whole-number scale applied to the native grid (each native pixel → m × m cells). */
  pixelScale?: number;
  issues: Issue[];
}
