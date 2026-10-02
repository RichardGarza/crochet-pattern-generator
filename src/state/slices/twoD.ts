// Track T2.3 — the 2D workspace's slice (DESIGN.md §1.3 F1 steps 1–5, §5.3, §5.4, §5.5.5).
//
// Authored data changes only through `projectStore.update` (one undo step per action, drags coalesced): the source
// picture, crop, background and brush, the chart settings (with the gauge rules of §2.2.5), and the hand edits
// the chart tools make. The chart itself is derived: `runChartJob` sends the document's inputs to the chart2d
// worker (latest-wins, §5.4) and keeps the result in `derivedStore.chart`, keyed by an input hash.
//
// A settings change that would move the chart to another size while hand edits exist asks first (§5.5.5: "N hand
// edits will move to the new size: Keep / Discard / Cancel"): `changeSettings` leaves the change pending in
// `twoDUi.pendingSize` and the dialog resolves it; Keep remaps the edits by relative position (T1's `remapEdits`).
// The old edits stay in the history (one undo brings them back).
//
// `twoDUi` holds the editor's view state (tool, color, zoom, panes, brush): not saved, reset with the project.
import { produce, type Draft } from 'immer';
import { createStore } from 'zustand/vanilla';
import { useStore } from 'zustand';
import { canonicalJson, CODE_VERSION, fnv1a64Hex } from '../../core/kernel/hash';
import { remapEdits } from '../../core/quantize/colorize';
import { isNotImplementedError } from '../../core/stub';
import type { AssetRef, ChartEdits, ChartRequest, ChartSettings, ColorRef, CropRect, Cyc, ProjectDoc, SourceImage, Technique2D } from '../../types';
import { decodeBrush, encodeBrush, type BrushMask } from '../../ui/twoD/brush';
import { emptyEdits, hasEdits, editCount } from '../../ui/twoD/chartTools';
import { chartGaugeSpec, croppedSize, defaultChartSettings, defaultCornerFor, gaugeWithTechnique, gaugeWithWeight, planChart } from '../../ui/twoD/settingsModel';
import { isSuperseded, workers } from '../../workers/client';
import { derivedStore } from '../derivedStore';
import { projectStore, type ProjectStore } from '../projectStore';
import { resolveGauge } from '../../core/gauge';

type TwoD = NonNullable<ProjectDoc['twoD']>;

// ---- view state

export type ChartToolId = 'paint' | 'fill' | 'replace' | 'eyedropper' | 'lock' | 'erase';
export type BrushMode = 'background' | 'subject' | 'erase';

export interface PendingSizeChange {
  label: string;
  recipe: (d: Draft<ProjectDoc>) => void;
  /** Hand-edited cells that would move. */
  count: number;
  from: { cols: number; rows: number };
  to: { cols: number; rows: number };
}

export interface TwoDUiState {
  /** Whether the chart worker can compute charts in this build (a Step 0 stub answers NotImplementedError). */
  engine: 'unknown' | 'ready' | 'unavailable';
  tool: ChartToolId;
  /** The paint color (null = the first palette color). */
  color: ColorRef | null;
  /** Chart zoom: 'fit' or pixels per stitch width. */
  zoom: 'fit' | number;
  showPhoto: boolean;
  gridLines: boolean;
  /** Keyboard cursor on the chart (a cell index), or null. */
  cursor: number | null;
  brushMode: BrushMode;
  /** Brush radius in shown picture pixels / 100 of the picture's long side. */
  brushSize: number;
  /** Source tab: crop aspect lock. */
  cropLock: 'free' | 'finished' | 'square';
  pendingSize: PendingSizeChange | null;
}

const INITIAL_UI: Omit<TwoDUiState, never> = {
  engine: 'unknown',
  tool: 'paint',
  color: null,
  zoom: 'fit',
  showPhoto: true,
  gridLines: true,
  cursor: null,
  brushMode: 'background',
  brushSize: 3,
  cropLock: 'free',
  pendingSize: null,
};

export const twoDUi = createStore<TwoDUiState>()(() => ({ ...INITIAL_UI }));

export function useTwoDUi<T>(selector: (s: TwoDUiState) => T): T {
  return useStore(twoDUi, selector);
}

/** Back to the defaults (a project was opened or closed). The engine state is kept: it is a fact of the build. */
export function resetTwoDUi(): void {
  twoDUi.setState({ ...INITIAL_UI, engine: twoDUi.getState().engine });
}

let lastSession = projectStore.getState().session;
projectStore.subscribe((s) => {
  if (s.session !== lastSession) {
    lastSession = s.session;
    resetTwoDUi();
  }
});

// ---- reading the document

export function twoDOf(doc: ProjectDoc | null | undefined): TwoD | undefined {
  return doc?.mode === '2d' ? doc.twoD : undefined;
}

export function sourceOf(doc: ProjectDoc | null | undefined): SourceImage | undefined {
  const t = twoDOf(doc);
  return t ? doc!.sources.find((s) => s.id === t.sourceId) : undefined;
}

// ---- actions (projectStore.update)

function store(s?: ProjectStore): ProjectStore {
  return s ?? projectStore;
}

/**
 * Adds the picture as the project's source and starts the chart (first picture: the default settings of a new
 * chart; a replacement: same settings, crop, brush and hand edits cleared — one undo step brings them back).
 */
export async function addSourcePicture(file: Blob, o: { name: string; w: number; h: number; now?: Date }, s?: ProjectStore): Promise<SourceImage | null> {
  const st = store(s);
  const ref: AssetRef = await st.getState().putAsset(file, file.type || 'image/jpeg');
  const id = `src-${ref.sha256.slice(0, 16)}`;
  let added: SourceImage | null = null;
  const ok = st.getState().update(st.getState().doc?.twoD ? 'Replace picture' : 'Add picture', (d) => {
    let src = d.sources.find((x) => x.asset.sha256 === ref.sha256);
    if (!src) {
      src = { id, asset: ref, name: o.name || 'Picture', w: o.w, h: o.h, addedAt: (o.now ?? new Date()).toISOString() };
      d.sources.push(src);
    }
    added = { ...src } as SourceImage;
    if (!d.twoD) {
      const settings = defaultChartSettings(d);
      d.twoD = { sourceId: src.id, settings, edits: emptyEdits(0, 0) };
      d.gauge = gaugeWithTechnique(d.gauge, settings.technique);
    } else {
      d.twoD.sourceId = src.id;
      delete d.twoD.crop;
      delete d.twoD.backgroundEdits;
      d.twoD.edits = emptyEdits(0, 0);
    }
  });
  return ok ? added : null;
}

/** One settings change (the gauge rules of §2.2.5 included), as one undo step. */
export function settingsRecipe(edit: (s: Draft<ChartSettings>, d: Draft<ProjectDoc>) => void): (d: Draft<ProjectDoc>) => void {
  return (d) => {
    if (!d.twoD) throw new Error('this project has no chart yet');
    edit(d.twoD.settings, d);
  };
}

export function techniqueRecipe(technique: Technique2D): (d: Draft<ProjectDoc>) => void {
  return settingsRecipe((s, d) => {
    s.technique = technique;
    d.gauge = gaugeWithTechnique(d.gauge as ProjectDoc['gauge'], technique);
  });
}

export function weightRecipe(cyc: Cyc): (d: Draft<ProjectDoc>) => void {
  return (d) => {
    d.gauge = gaugeWithWeight(d.gauge as ProjectDoc['gauge'], cyc);
  };
}

export function hookRecipe(hookMm: number | undefined): (d: Draft<ProjectDoc>) => void {
  return (d) => {
    if (hookMm === undefined) delete d.gauge.hookMm;
    else d.gauge.hookMm = hookMm;
  };
}

/** The hand of the chart (and of the project): a C2C corner left at the old hand's default follows the new hand. */
export function handRecipe(hand: 'right' | 'left'): (d: Draft<ProjectDoc>) => void {
  return settingsRecipe((s, d) => {
    if (s.startCorner === defaultCornerFor(s.hand)) s.startCorner = defaultCornerFor(hand);
    s.hand = hand;
    d.hand = hand;
  });
}

/** The chart size these settings give (null for pixel art, a gauge error or no picture). */
export function plannedSize(doc: ProjectDoc): { cols: number; rows: number } | null {
  const t = twoDOf(doc);
  const src = sourceOf(doc);
  if (!t || !src) return null;
  if (t.settings.imageKind === 'pixel') return null;
  const p = planChart(doc, t.settings, croppedSize(src, t.crop));
  return 'plan' in p ? { cols: p.plan.size.cols, rows: p.plan.size.rows } : null;
}

/**
 * Applies a settings change, or — when hand edits exist and the chart would change size — leaves it pending for
 * the "Keep / Discard / Cancel" dialog (§5.5.5). Returns true when applied now.
 */
export function changeSettings(label: string, recipe: (d: Draft<ProjectDoc>) => void, o: { coalesceKey?: string } = {}, s?: ProjectStore): boolean {
  const st = store(s);
  const doc = st.getState().doc;
  if (!doc) return false;
  const edits = doc.twoD?.edits;
  if (hasEdits(edits) && edits!.baseCols > 0 && edits!.baseRows > 0) {
    let next: ProjectDoc;
    try {
      next = produce(doc, recipe);
    } catch {
      next = doc;
    }
    const to = plannedSize(next);
    if (to && (to.cols !== edits!.baseCols || to.rows !== edits!.baseRows)) {
      twoDUi.setState({ pendingSize: { label, recipe, count: editCount(edits), from: { cols: edits!.baseCols, rows: edits!.baseRows }, to } });
      return false;
    }
  }
  return st.getState().update(label, recipe, o);
}

/** Resolves the pending size change: keep (remap) the edits, discard them, or cancel the change. */
export function resolvePendingSize(choice: 'keep' | 'discard' | 'cancel', s?: ProjectStore): boolean {
  const pending = twoDUi.getState().pendingSize;
  twoDUi.setState({ pendingSize: null });
  if (!pending || choice === 'cancel') return false;
  const { to } = pending;
  return store(s)
    .getState()
    .update(pending.label, (d) => {
      pending.recipe(d);
      if (!d.twoD) return;
      const cur = d.twoD.edits as ChartEdits;
      d.twoD.edits = choice === 'keep' ? remapEdits(cur, to.cols, to.rows) : emptyEdits(to.cols, to.rows);
    });
}

export function setCrop(crop: CropRect | undefined, o: { coalesceKey?: string; label?: string } = {}, s?: ProjectStore): boolean {
  return changeSettings(
    o.label ?? 'Crop',
    (d) => {
      if (!d.twoD) return;
      if (crop) d.twoD.crop = { x: crop.x, y: crop.y, w: crop.w, h: crop.h, rotate: crop.rotate, flipX: crop.flipX };
      else delete d.twoD.crop;
    },
    { coalesceKey: o.coalesceKey },
    s,
  );
}

/** Stores the background brush as a PNG asset (null removes it). One undo step per stroke. */
export async function setBackgroundBrush(mask: BrushMask | null, s?: ProjectStore): Promise<boolean> {
  const st = store(s);
  if (mask === null) {
    return st.getState().update('Clear background brush', (d) => {
      if (d.twoD) delete d.twoD.backgroundEdits;
    });
  }
  const ref = await st.getState().putAsset(encodeBrush(mask), 'image/png');
  return st.getState().update('Brush background', (d) => {
    if (d.twoD) d.twoD.backgroundEdits = ref;
  });
}

/** The stored brush, decoded (null when there is none or it cannot be read). */
export async function loadBackgroundBrush(doc: ProjectDoc, s?: ProjectStore): Promise<BrushMask | null> {
  const ref = twoDOf(doc)?.backgroundEdits;
  if (!ref) return null;
  try {
    const blob = await store(s).getState().getAsset(ref);
    return decodeBrush(new Uint8Array(await blob.arrayBuffer()));
  } catch {
    return null;
  }
}

// ---- the chart job (derivedStore.chart, chart2d worker)

/** The input hash of the chart a document asks for (settings, crop, gauge, edits, source, brush; §5.8). */
export function chartInputHash(doc: ProjectDoc): string | null {
  const t = twoDOf(doc);
  const src = sourceOf(doc);
  if (!t || !src) return null;
  const spec = chartGaugeSpec(doc, t.settings.technique);
  const edits = hasEdits(t.edits) ? t.edits : null;
  return fnv1a64Hex(
    canonicalJson({ settings: t.settings, crop: t.crop ?? null, gauge: spec, edits, source: src.asset.sha256, brush: t.backgroundEdits?.sha256 ?? null }) + CODE_VERSION,
  );
}

/** The worker request of a document (reads the picture and the brush from the asset store). */
export async function buildChartRequest(doc: ProjectDoc, s?: ProjectStore): Promise<Omit<ChartRequest, 'jobId'>> {
  const t = twoDOf(doc);
  const src = sourceOf(doc);
  if (!t || !src) throw new Error('No picture yet');
  const st = store(s);
  const image = await st.getState().getAsset(src.asset);
  const gauge = resolveGauge(chartGaugeSpec(doc, t.settings.technique));
  const req: Omit<ChartRequest, 'jobId'> = {
    image,
    settings: t.settings,
    gauge,
    lines: [],
    stash: [],
    sourceId: src.asset.sha256,
    ...(t.crop ? { crop: t.crop } : {}),
    ...(hasEdits(t.edits) ? { edits: t.edits } : {}),
  };
  if (t.backgroundEdits && t.settings.background === 'remove') {
    const mask = await loadBackgroundBrush(doc, st);
    if (mask) req.backgroundEdits = { w: mask.w, h: mask.h, data: mask.data, key: t.backgroundEdits.sha256 };
  }
  return req;
}

/**
 * Computes the document's chart in the chart2d worker unless the stored result already belongs to these inputs or
 * a job for them is running. A Step 0 stub worker (NotImplementedError) sets `twoDUi.engine = 'unavailable'` and
 * is not reported as a failure; a superseded job is ignored (a newer one is on its way).
 */
export async function runChartJob(doc: ProjectDoc, s?: ProjectStore): Promise<void> {
  const hash = chartInputHash(doc);
  if (!hash) return;
  const ds = derivedStore.getState();
  if (ds.chart?.inputHash === hash) return;
  const job = ds.jobs.chart;
  if (job?.status === 'running' && job.inputHash === hash) return;
  ds.beginJob('chart', hash);
  try {
    const req = await buildChartRequest(doc, s);
    const result = await workers.chart2d.run(req);
    if (derivedStore.getState().setResult('chart', hash, result)) twoDUi.setState({ engine: 'ready' });
  } catch (e) {
    if (isSuperseded(e)) return;
    if (isNotImplementedError(e)) {
      twoDUi.setState({ engine: 'unavailable' });
      derivedStore.getState().finishJob('chart', hash);
      return;
    }
    derivedStore.getState().failJob('chart', hash, e);
  }
}
