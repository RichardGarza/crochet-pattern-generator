// Track T7 — what Accept commits (DESIGN.md §3.7.7, integration S1 task T7.5). `carryOver` would bring back every
// feature of the previous model whose id the new model lacks — including one Claude Design removed on purpose. So
// the import carries itself: `carryOverWith(prev, next)` (crochet hints always; paint by the 10% rule or "Carry
// anyway"; features the new model lacks), then drops the carried features whose ids were in the seed it sent
// (`qa.seed.features`: Claude Design saw them and removed them), and the caller commits with `carry: 'none'`.
// Mesh parts the project keeps (same `meshRef`) hold vertex labels into the PREVIOUS palette: `labelRemap` /
// `remapMeshLabels` re-point them at the new one by color identity.
import type { CarryReport } from '../../types/entryPoints';
import type { ColoredMesh } from '../../types/geometry';
import type { CrochetModelV1, PaletteColor } from '../../types/model';
import { deltaE00Hex } from '../kernel/color';
import { carryOverWith } from '../model/revisions';

export interface AcceptOptions {
  /** Feature ids of the seed sent to Claude Design (`qa.seed.features`); features it removed stay removed. */
  seedFeatureIds?: Iterable<string>;
  /** Part ids whose paint is carried although the shape changed ("Carry anyway"). */
  carryPaintAnyway?: readonly string[];
}

export interface AcceptPlan {
  /** Commit this with `commitModelRevision(model, { source: 'import', carry: 'none', … })`. */
  model: CrochetModelV1;
  /** What was carried (features dropped below are not listed). */
  report: CarryReport;
  /** Carried features left out because Claude Design saw them in the seed and removed them. */
  droppedFeatures: string[];
}

/** §3.7.7: the model an accepted import commits, with the app-owned settings of `prev` carried over. */
export function planImportAccept(prev: CrochetModelV1 | undefined, next: CrochetModelV1, o: AcceptOptions = {}): AcceptPlan {
  const seed = new Set(o.seedFeatureIds ?? []);
  const own = new Set((next.features ?? []).map((f) => f.id));
  // features Claude Design saw in the seed and left out are taken out of `prev` BEFORE carrying, so they neither
  // come back nor use up room under the 60-feature limit; a feature the new model has itself is Claude's and stays
  const drop = (prev?.features ?? []).filter((f) => seed.has(f.id) && !own.has(f.id)).map((f) => f.id);
  const dropSet = new Set(drop);
  const from = prev && drop.length > 0 ? { ...prev, features: (prev.features ?? []).filter((f) => !dropSet.has(f.id)) } : prev;
  const carried = carryOverWith(from, next, o.carryPaintAnyway ? { carryPaintAnyway: o.carryPaintAnyway } : {});
  return { ...carried, droppedFeatures: drop };
}

/**
 * Label `i` of the previous palette → its index in the next one, by color identity (the same id, else the same
 * hex, else the nearest by ΔE00); 255 stays 255. A table of 256 entries.
 */
export function labelRemap(prev: readonly PaletteColor[], next: readonly PaletteColor[]): Uint8Array {
  const table = new Uint8Array(256).fill(255);
  prev.forEach((c, i) => {
    if (i >= 255 || next.length === 0) return;
    let j = next.findIndex((d) => d.id === c.id);
    if (j < 0) j = next.findIndex((d) => d.hex.toLowerCase() === c.hex.toLowerCase());
    if (j < 0) {
      let best = Infinity;
      next.forEach((d, k) => {
        const de = deltaE00Hex(c.hex, d.hex);
        if (de < best) [best, j] = [de, k];
      });
    }
    table[i] = j >= 0 && j < 255 ? j : 255;
  });
  return table;
}

/** A copy of `mesh` whose vertex labels go through `table` (from `labelRemap`). */
export function remapMeshLabels(mesh: ColoredMesh, table: Uint8Array): ColoredMesh {
  const labels = new Uint8Array(mesh.labels.length);
  for (let i = 0; i < labels.length; i++) labels[i] = table[mesh.labels[i]];
  return { ...mesh, labels };
}

/**
 * The mesh parts of `next` that keep a mesh of `prev` (the same `meshRef`, not supplied by the import): their
 * labels must be re-pointed when the palette changed. Empty when the palettes index the same colors.
 */
export function keptMeshRefs(prev: CrochetModelV1 | undefined, next: CrochetModelV1, imported: Readonly<Record<string, ColoredMesh>> = {}): string[] {
  if (!prev) return [];
  const before = new Set(prev.parts.flatMap((p) => (p.type === 'mesh' ? [p.dims.meshRef] : [])));
  const samePalette = prev.palette.length === next.palette.length && prev.palette.every((c, i) => c.id === next.palette[i].id && c.hex.toLowerCase() === next.palette[i].hex.toLowerCase());
  if (samePalette) return [];
  return next.parts.flatMap((p) => (p.type === 'mesh' && before.has(p.dims.meshRef) && !Object.hasOwn(imported, p.dims.meshRef) ? [p.dims.meshRef] : []));
}

/** The note shown when a model's lace weight (CYC 0) is offered as CYC 1 (integration S1 tasks T6.5 / T7.6). */
export const LACE_AS_CYC1_NOTE = 'Lace weight is sized as CYC 1 for toys; the toy may come out larger than the label suggests';

export interface YarnPrefill {
  /** CYC 1–7 (a model's 0 is offered as 1). */
  weightCYC?: number;
  hookMm?: number;
  stsPerIn?: number;
  fiber?: string;
  /** Shown next to the pre-filled weight; never silent. */
  note?: string;
}

/**
 * What the Yarn & size step pre-fills from an imported `model.yarn` after Accept (§3.7.7): CYC 0 (lace) is offered
 * as CYC 1 with a visible note; nothing else is changed. Undefined when the model names no yarn.
 */
export function yarnPrefill(yarn: CrochetModelV1['yarn']): YarnPrefill | undefined {
  if (!yarn) return undefined;
  const out: YarnPrefill = {};
  if (yarn.weightCYC !== undefined) {
    out.weightCYC = yarn.weightCYC === 0 ? 1 : yarn.weightCYC;
    if (yarn.weightCYC === 0) out.note = LACE_AS_CYC1_NOTE;
  }
  if (yarn.hookMm !== undefined) out.hookMm = yarn.hookMm;
  if (yarn.stsPerIn !== undefined) out.stsPerIn = yarn.stsPerIn;
  if (yarn.fiber !== undefined) out.fiber = yarn.fiber;
  return Object.keys(out).length > 0 ? out : undefined;
}
