// Track T6.2 — the Yarn & size panel's logic (DESIGN.md §4.5, §2.2, §2.8, §2.11.2): pure helpers over the project's
// `GaugeSpec` and `AmiSettings`, the size estimate with its uncertainty band, and the store actions that write
// them through `projectStore.update` (one history step per committed value).
//
// Rules from the spec kept here: the 3D gauge is always `amigurumi_sc`; CYC 0 is never offered (a model asking for
// it is offered as CYC 1 with a visible note); changing the weight clears the hook and every measurement (each
// weight scales from its own reference hook, §2.2.5); the test ball is stored as `testBall` and read by
// `resolveGauge`; "unravel 10 sc" sets `lscCalibratedIn` = length / 10; the spiral lean from the test tube is
// count / 12, signed.
import {
  AMI_CYCS,
  amiHookMm,
  CALIBRATION_STITCHES,
  checkGauge,
  hookSizeRange,
  hookUsLabel,
  HOOK_SIZES_MM,
  lscFromUnravel,
  resolveGaugeChecked,
  yardageBandFor,
  type AmiCyc,
  type GaugeIssue,
} from '../../core/gauge';
import { MODEL_LIMITS } from '../../core/model/limits';
import { projectStore, type ProjectStore } from '../../state/projectStore';
import type { AmiSettings } from '../../types/ami';
import type { GaugeSpec, ResolvedGauge } from '../../types/gauge';
import type { CrochetModelV1 } from '../../types/model';
import type { ProjectDoc } from '../../types/project';
import type { Cyc } from '../../types/units';

// ---- words

/** The CYC weights in crocheters' words (§2.2.1; the names on the yarn label and what people call them). */
export const YARN_WEIGHTS: Readonly<Record<AmiCyc, { name: string; examples: string }>> = {
  1: { name: 'Super fine', examples: 'sock, fingering' },
  2: { name: 'Fine', examples: 'sport, baby' },
  3: { name: 'Light', examples: 'DK, light worsted' },
  4: { name: 'Medium', examples: 'worsted, aran' },
  5: { name: 'Bulky', examples: 'chunky, craft' },
  6: { name: 'Super bulky', examples: 'roving, velvet' },
  7: { name: 'Jumbo', examples: 'arm-knitting yarn' },
};

/** "4 · Medium (worsted, aran)". */
export function weightLabel(cyc: AmiCyc): string {
  const w = YARN_WEIGHTS[cyc];
  return `${cyc} · ${w.name} (${w.examples})`;
}

/** "3.5 mm (E-4)", or "2.5 mm" for a size without a US letter. */
export function hookLabel(mm: number): string {
  const us = hookUsLabel(mm);
  const text = `${Number(mm.toFixed(2))} mm`;
  return us ? `${text} (${us})` : text;
}

/** The note shown when a model asks for lace weight (§4.5, integration task T6.5). */
export const LACE_NOTE = 'Lace weight is sized as CYC 1 for toys; the toy may come out larger than the label suggests.';

// ---- the 3D gauge

/** A CYC weight amigurumi accepts: 1–7 (CYC 0 → 1, anything else → 4). */
export function amiCyc(cyc: unknown): AmiCyc {
  if (cyc === 0) return 1;
  return (AMI_CYCS as readonly unknown[]).includes(cyc) ? (cyc as AmiCyc) : 4;
}

/**
 * The project's gauge as the 3D panel uses it: technique `amigurumi_sc`, a weight of 1–7, and only the fields
 * amigurumi reads (hook, yarn under, test ball, yarn per stitch). The same object when it already is one.
 */
export function amigurumiGauge(g: GaugeSpec | undefined): GaugeSpec {
  const src: Partial<GaugeSpec> = g ?? {};
  const out: GaugeSpec = { cyc: amiCyc(src.cyc), technique: 'amigurumi_sc' };
  if (src.hookMm !== undefined) out.hookMm = src.hookMm;
  if (src.yarnUnder !== undefined) out.yarnUnder = src.yarnUnder;
  if (src.testBall !== undefined) out.testBall = src.testBall;
  if (src.lscCalibratedIn !== undefined) out.lscCalibratedIn = src.lscCalibratedIn;
  return g && JSON.stringify(out) === JSON.stringify(g) ? g : out;
}

export type ClearedField = 'hook' | 'testBall' | 'yarnPerStitch';

/**
 * A new yarn weight (§4.5): the hook and every measurement go — each weight scales from its own reference hook,
 * so a kept hook could make a finer yarn wider (§2.2.5) and a test ball of the old yarn says nothing about the new
 * one. Yarn over / under stays. `cleared` names what was dropped (for the note the panel shows).
 */
export function withWeight(g: GaugeSpec, cyc: AmiCyc): { gauge: GaugeSpec; cleared: ClearedField[] } {
  const cur = amigurumiGauge(g);
  if (cur.cyc === cyc) return { gauge: cur, cleared: [] };
  const cleared: ClearedField[] = [];
  if (cur.hookMm !== undefined) cleared.push('hook');
  if (cur.testBall !== undefined) cleared.push('testBall');
  if (cur.lscCalibratedIn !== undefined) cleared.push('yarnPerStitch');
  const gauge: GaugeSpec = { cyc, technique: 'amigurumi_sc' };
  if (cur.yarnUnder !== undefined) gauge.yarnUnder = cur.yarnUnder;
  return { gauge, cleared };
}

/** The hook (mm); `undefined` = the recommended Table E hook of the weight. */
export function withHook(g: GaugeSpec, hookMm: number | undefined): GaugeSpec {
  const out = { ...amigurumiGauge(g) };
  if (hookMm === undefined || !Number.isFinite(hookMm) || hookMm < 0.1 || hookMm > 100 || Math.abs(hookMm - amiHookMm(out.cyc)) < 1e-9) delete out.hookMm;
  else out.hookMm = hookMm;
  return out;
}

export function withYarnUnder(g: GaugeSpec, yarnUnder: boolean): GaugeSpec {
  const out = { ...amigurumiGauge(g) };
  if (yarnUnder) out.yarnUnder = true;
  else delete out.yarnUnder;
  return out;
}

/** The test ball (widest round: stitches and circumference, §2.2.5); `undefined` removes it. */
export function withTestBall(g: GaugeSpec, ball: { maxSts: number; circumferenceIn: number } | undefined): GaugeSpec {
  const out = { ...amigurumiGauge(g) };
  if (ball && ball.maxSts > 0 && ball.circumferenceIn > 0 && Number.isFinite(ball.maxSts) && Number.isFinite(ball.circumferenceIn)) {
    out.testBall = { maxSts: ball.maxSts, circumferenceIn: ball.circumferenceIn };
  } else delete out.testBall;
  return out;
}

/** "Unravel 10 sc of your test ball and measure the yarn": `lscCalibratedIn` = length / 10 (§4.5); `undefined` removes it. */
export function withYarnPerStitch(g: GaugeSpec, lengthOf10In: number | undefined): GaugeSpec {
  const out = { ...amigurumiGauge(g) };
  if (lengthOf10In !== undefined && lengthOf10In > 0 && Number.isFinite(lengthOf10In)) out.lscCalibratedIn = lscFromUnravel(lengthOf10In, CALIBRATION_STITCHES, 'sc');
  else delete out.lscCalibratedIn;
  return out;
}

/** The hook sizes the hook menu offers: from half the recommended hook to twice it, plus the current one. */
export function hookChoices(cyc: AmiCyc, current?: number): number[] {
  const ref = amiHookMm(cyc);
  const list = HOOK_SIZES_MM.filter((mm) => mm >= ref * 0.5 - 1e-9 && mm <= ref * 2 + 1e-9);
  if (current !== undefined && !list.some((mm) => Math.abs(mm - current) < 1e-9)) list.push(current);
  return list.sort((a, b) => a - b);
}

// ---- what the gauge means for the toy

export interface SizeEstimate {
  /** The size the pattern aims for (the model's height, or the target before a model exists). */
  nominalIn: number;
  lowIn: number;
  highIn: number;
  /** The relative band, rounded to whole percent below and above. */
  minusPct: number;
  plusPct: number;
  /** True when a test ball measured the gauge (±4%). */
  measured: boolean;
  /** Stitches per inch of a firmly stuffed piece. */
  stitchesPerIn: number;
  /** The hook the pattern uses. */
  hookMm: number;
  /** The yardage band (§2.8): 0.20 default, 0.10 with a test ball, 0.05 calibrated. */
  yardageBand: number;
  gauge: ResolvedGauge;
}

/**
 * The finished size the gauge gives a toy designed `heightIn` tall, with its band (§2.2.5: `nominal × (1 ± tol)`;
 * with a hook other than the recommended one and no test ball, also the hook exponent's range 0.5 … 1.0, §2.2.2).
 * `null` when the gauge cannot be resolved.
 */
export function sizeEstimate(g: GaugeSpec, heightIn: number): SizeEstimate | null {
  const spec = amigurumiGauge(g);
  const { gauge } = resolveGaugeChecked(spec);
  if (!gauge || !(heightIn > 0) || !Number.isFinite(heightIn)) return null;
  const measured = gauge.source === 'swatch';
  let lo = 1 - gauge.tol;
  let hi = 1 + gauge.tol;
  if (!measured && spec.hookMm !== undefined) {
    const r = hookSizeRange(1, spec.hookMm, amiHookMm(spec.cyc));
    lo *= r.low;
    hi *= r.high;
  }
  return {
    nominalIn: heightIn,
    lowIn: heightIn * lo,
    highIn: heightIn * hi,
    minusPct: Math.round((1 - lo) * 100),
    plusPct: Math.round((hi - 1) * 100),
    measured,
    stitchesPerIn: 1 / (gauge.cell.w * gauge.stretch),
    hookMm: gauge.hookMm,
    yardageBand: yardageBandFor(spec),
    gauge,
  };
}

/** The sanity warnings on the measured gauge (§2.2.5: a count far from the weight, cm typed as inches, …). */
export function gaugeWarnings(g: GaugeSpec): GaugeIssue[] {
  try {
    return checkGauge(amigurumiGauge(g));
  } catch {
    return [];
  }
}

// ---- Claude Design's yarn (§3.7.7, §4.5)

export interface ModelYarn {
  cyc: AmiCyc;
  hookMm?: number;
  /** Shown with the suggestion: why the weight differs from what the model said (CYC 0 → 1). */
  note?: string;
}

/** The gauge a model's `yarn` asks for; `null` when it names no weight. CYC 0 is offered as CYC 1 with a note. */
export function yarnFromModel(yarn: CrochetModelV1['yarn']): ModelYarn | null {
  if (!yarn || yarn.weightCYC === undefined) return null;
  const out: ModelYarn = { cyc: amiCyc(yarn.weightCYC) };
  if (yarn.weightCYC === 0) out.note = LACE_NOTE;
  if (typeof yarn.hookMm === 'number' && yarn.hookMm >= 0.1 && yarn.hookMm <= 100) out.hookMm = yarn.hookMm;
  return out;
}

/** True when the gauge already uses the model's yarn (weight and hook). */
export function usesModelYarn(g: GaugeSpec, y: ModelYarn): boolean {
  const spec = amigurumiGauge(g);
  if (spec.cyc !== y.cyc) return false;
  const hook = spec.hookMm ?? amiHookMm(spec.cyc);
  return Math.abs(hook - (y.hookMm ?? amiHookMm(y.cyc))) < 1e-9;
}

/** The gauge with the model's yarn: its weight (measurements cleared, `withWeight`) and hook. */
export function withModelYarn(g: GaugeSpec, y: ModelYarn): GaugeSpec {
  return withHook(withWeight(g, y.cyc).gauge, y.hookMm);
}

/** True for a gauge nobody has touched: the new 3D project's CYC 4 with nothing else (§4.5 "pre-filled … when the
 * project was created by the import"). */
export function isPristineGauge(g: GaugeSpec | undefined): boolean {
  return !!g && g.cyc === 4 && Object.keys(g).every((k) => k === 'cyc' || k === 'technique');
}

// ---- the spiral lean test tube (§4.5, §2.11.2)

/** Rounds of the test tube the count is taken over. */
export const LEAN_TUBE_ROUNDS = 12;

/**
 * The lean from the test tube: count / 12 st per round, positive when the marker moved against the working
 * direction (the usual case), negative with it (§4.5).
 */
export function leanFromTube(count: number, against: boolean): number {
  if (!Number.isFinite(count) || count < 0) return 0;
  return Math.round(((against ? 1 : -1) * count * 1000) / LEAN_TUBE_ROUNDS) / 1000 + 0;
}

/** The lean the field accepts: at most two stitches per round either way. */
export const LEAN_LIMIT = 2;

// ---- store actions

/**
 * One history step. The panel's fields commit a value once (Enter, leaving the field, a menu choice), so what was
 * typed is one step; nothing coalesces across two separate choices.
 */
function update(label: string, recipe: (doc: ProjectDoc) => void, o: { store?: ProjectStore } = {}): boolean {
  const store = o.store ?? projectStore;
  if (!store.getState().doc || store.getState().readOnly) return false;
  const before = store.getState().doc;
  const ok = store.getState().update(label, (draft) => recipe(draft as ProjectDoc));
  return ok && store.getState().doc !== before;
}

/** Writes the project's gauge (`ProjectDoc.gauge`) as one history step. */
export function setGauge(label: string, next: GaugeSpec, o: { store?: ProjectStore } = {}): boolean {
  return update(
    label,
    (draft) => {
      if (JSON.stringify(draft.gauge) !== JSON.stringify(next)) draft.gauge = structuredClone(next);
    },
    o,
  );
}

/** Writes amigurumi settings (`threeD.ami.*`) as one history step. */
export function setAmi(label: string, patch: Partial<AmiSettings>, o: { store?: ProjectStore } = {}): boolean {
  return update(
    label,
    (draft) => {
      const ami = draft.threeD?.ami;
      if (!ami) return;
      for (const [k, v] of Object.entries(patch) as [keyof AmiSettings, never][]) {
        if (v !== undefined && ami[k] !== v) ami[k] = v;
      }
    },
    o,
  );
}

/** Before a model exists (F2/F3 step 5): the target height of the build, `threeD.recon.targetHeightIn`. */
export function setTargetHeight(heightIn: number, o: { store?: ProjectStore } = {}): boolean {
  if (!(heightIn > 0) || heightIn > MODEL_LIMITS.maxHeightIn) return false;
  return update('Target height', (draft) => {
    const recon = draft.threeD?.recon;
    if (recon && recon.targetHeightIn !== heightIn) recon.targetHeightIn = heightIn;
  }, o);
}

/** The finished-height limits of Scale model to height (§3.5.2: 0 < h ≤ 60 in). */
export const HEIGHT_LIMITS_IN: readonly [number, number] = [0.5, MODEL_LIMITS.maxHeightIn];

/** Uses the model's yarn suggestion (weight and hook) as one history step. */
export function applyModelYarn(o: { store?: ProjectStore } = {}): boolean {
  const store = o.store ?? projectStore;
  const doc = store.getState().doc;
  const y = yarnFromModel(doc?.threeD?.model?.yarn);
  if (!doc || !y) return false;
  return setGauge(`Yarn from the model (CYC ${y.cyc})`, withModelYarn(doc.gauge, y), { store });
}

export type { AmiCyc, Cyc };
