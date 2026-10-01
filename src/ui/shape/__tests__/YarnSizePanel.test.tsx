// @vitest-environment happy-dom
// Track T6.2 — the Yarn & size panel (DESIGN.md §4.5, §6.3 T6 acceptance): it writes `gauge` and `threeD.ami`
// through `projectStore.update`, pre-fills from `model.yarn` (CYC 0 → 1 with a note), works in its four contexts
// (pre-model, post-import, shape, pattern), clears the hook and the measurements when the weight changes, takes the
// test ball, the 10-stitch yarn calibration and the spiral lean from the test tube, shows the size band, and scales
// the model to a height as one step and a new revision.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { isImplemented } from '../../../core/stub';
import { modelHeight } from '../../../core/model/transforms';
import { teddy, teddyProject } from '../../../state/slices/__tests__/teddyProject';
import { projectStore } from '../../../state/projectStore';
import type { ProjectDoc } from '../../../types/project';
import type { ReconSettings } from '../../../types/geometry';
import { PatternTab } from '../../pattern/PatternTab';
import { YarnSizePanel } from '../YarnSizePanel';
import { scaleBlockedReason } from '../yarnSizeModel';
import {
  amigurumiGauge,
  hookChoices,
  isPristineGauge,
  LACE_NOTE,
  leanFromTube,
  sizeEstimate,
  usesModelYarn,
  withHook,
  withTestBall,
  withWeight,
  withYarnPerStitch,
  yarnFromModel,
} from '../yarnSize';

const doc = () => projectStore.getState().doc!;
const history = () => projectStore.getState().history.past.map((e) => e.label);

function open(d: ProjectDoc = teddyProject()): void {
  projectStore.getState().open(d, { discardUnsaved: true });
}

function commit(el: HTMLElement, value: string): void {
  fireEvent.change(el, { target: { value } });
  fireEvent.keyDown(el, { key: 'Enter' });
}

afterEach(() => {
  projectStore.getState().close({ discardUnsaved: true });
});

describe('yarnSize helpers', () => {
  it('a new weight clears the hook and every measurement, keeps yarn under', () => {
    const g = { cyc: 4 as const, technique: 'amigurumi_sc' as const, hookMm: 4, yarnUnder: true, testBall: { maxSts: 36, circumferenceIn: 7 }, lscCalibratedIn: 1.5 };
    expect(withWeight(g, 3)).toEqual({ gauge: { cyc: 3, technique: 'amigurumi_sc', yarnUnder: true }, cleared: ['hook', 'testBall', 'yarnPerStitch'] });
    expect(withWeight(g, 4).cleared).toEqual([]);
  });

  it('the 3D gauge is always amigurumi_sc, weight 1–7, only the fields amigurumi reads', () => {
    expect(amigurumiGauge({ cyc: 0, technique: 'sc_graphgan', swatch: { sts: 1, rows: 1, spanIn: 1 }, carried: 2 })).toEqual({ cyc: 1, technique: 'amigurumi_sc' });
    const g = { cyc: 4 as const, technique: 'amigurumi_sc' as const };
    expect(amigurumiGauge(g)).toBe(g);
  });

  it('the recommended hook is stored as no hook; yarn per stitch = length / 10; test ball needs both numbers', () => {
    const g = { cyc: 4 as const, technique: 'amigurumi_sc' as const };
    expect(withHook(g, 3.5)).toEqual(g);
    expect(withHook(g, 4).hookMm).toBe(4);
    expect(withYarnPerStitch(g, 15).lscCalibratedIn).toBeCloseTo(1.5, 12);
    expect(withYarnPerStitch({ ...g, lscCalibratedIn: 1 }, undefined).lscCalibratedIn).toBeUndefined();
    expect(withTestBall(g, { maxSts: 0, circumferenceIn: 7 }).testBall).toBeUndefined();
    expect(withTestBall(g, { maxSts: 36, circumferenceIn: 7.2 }).testBall).toEqual({ maxSts: 36, circumferenceIn: 7.2 });
    expect(hookChoices(4)).toContain(3.5);
    expect(hookChoices(4, 13)).toContain(13);
  });

  it('the size band: worsted ±10%, other weights ±20%, a test ball ±4%, an odd hook widens it', () => {
    const e4 = sizeEstimate({ cyc: 4, technique: 'amigurumi_sc' }, 10)!;
    expect([e4.lowIn, e4.highIn, e4.minusPct, e4.plusPct]).toEqual([9, 11, 10, 10]);
    expect(e4.stitchesPerIn).toBeCloseTo(1 / (0.195 * 1.05), 9);
    expect(e4.yardageBand).toBe(0.2);
    const e3 = sizeEstimate({ cyc: 3, technique: 'amigurumi_sc' }, 10)!;
    expect(e3.plusPct).toBe(20);
    const ball = sizeEstimate({ cyc: 4, technique: 'amigurumi_sc', testBall: { maxSts: 36, circumferenceIn: 7.2 } }, 10)!;
    expect(ball.measured).toBe(true);
    expect(ball.plusPct).toBe(4);
    expect(ball.yardageBand).toBe(0.1);
    const hook = sizeEstimate({ cyc: 4, technique: 'amigurumi_sc', hookMm: 5 }, 10)!;
    expect(hook.plusPct).toBeGreaterThan(10);
    expect(hook.lowIn).toBeLessThan(hook.nominalIn);
    expect(sizeEstimate({ cyc: 4, technique: 'amigurumi_sc' }, 0)).toBeNull();
  });

  it('model.yarn: CYC 0 is offered as CYC 1 with the note; an impossible hook is ignored', () => {
    expect(yarnFromModel({ weightCYC: 0, hookMm: 2 })).toEqual({ cyc: 1, hookMm: 2, note: LACE_NOTE });
    expect(yarnFromModel({ weightCYC: 4, hookMm: 500 })).toEqual({ cyc: 4 });
    expect(yarnFromModel({ hookMm: 3 })).toBeNull();
    expect(usesModelYarn({ cyc: 4, technique: 'amigurumi_sc' }, { cyc: 4, hookMm: 3.5 })).toBe(true);
    expect(isPristineGauge({ cyc: 4, technique: 'amigurumi_sc' })).toBe(true);
    expect(isPristineGauge({ cyc: 4, technique: 'amigurumi_sc', yarnUnder: false })).toBe(false);
  });

  it('the test tube: lean = count / 12, signed', () => {
    expect(leanFromTube(3, true)).toBe(0.25);
    expect(leanFromTube(3, false)).toBe(-0.25);
    expect(leanFromTube(0, false)).toBe(0);
    expect(leanFromTube(NaN, true)).toBe(0);
  });

  it('Scale to height refuses mesh parts and sizes past the schema', () => {
    const m = teddy();
    expect(scaleBlockedReason(m, 12)).toBeNull();
    expect(scaleBlockedReason(m, 0.1)).toMatch(/from 0.5 to 60/);
    expect(scaleBlockedReason(m, 59)).toBeNull();
    const big = { ...m, parts: [...m.parts, { id: 'big', type: 'box' as const, dims: { w: 20, h: 1, d: 1 }, position: [0, 0, 0] as [number, number, number], color: m.parts[0].color }] };
    expect(scaleBlockedReason(big, 59)).toMatch(/larger than 48/);
  });
});

describe('YarnSizePanel', () => {
  it('is implemented (no longer the Step 0 stub)', () => {
    expect(isImplemented(YarnSizePanel)).toBe(true);
  });

  it('writes the gauge: weight (clears hook and measurements, says so), hook, yarn under — one step each', () => {
    const d = teddyProject();
    d.gauge = { cyc: 4, technique: 'amigurumi_sc', hookMm: 4, testBall: { maxSts: 36, circumferenceIn: 7.2 } };
    open(d);
    render(<YarnSizePanel context="shape" />);
    fireEvent.change(screen.getByRole('combobox', { name: 'Yarn weight' }), { target: { value: '3' } });
    expect(doc().gauge).toEqual({ cyc: 3, technique: 'amigurumi_sc' });
    expect(screen.getByText(/New yarn: the hook size and the test ball were reset/)).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Hook' }), { target: { value: '3.25' } });
    expect(doc().gauge.hookMm).toBe(3.25);
    fireEvent.change(screen.getByRole('combobox', { name: 'Hook' }), { target: { value: 'auto' } });
    expect(doc().gauge.hookMm).toBeUndefined();
    fireEvent.click(screen.getByRole('radio', { name: 'Yarn under' }));
    expect(doc().gauge.yarnUnder).toBe(true);
    expect(history()).toEqual(['Yarn weight: Light', 'Hook 3.25 mm', 'Recommended hook', 'Yarn under']);
    // CYC 0 is not offered.
    const weights = Array.from((screen.getByRole('combobox', { name: 'Yarn weight' }) as HTMLSelectElement).options).map((o) => o.value);
    expect(weights).toEqual(['1', '2', '3', '4', '5', '6', '7']);
  });

  it('shows the finished size with its band, which a test ball narrows to ±4%', () => {
    open();
    render(<YarnSizePanel context="shape" />);
    const size = screen.getByRole('group', { name: 'Expected finished size' });
    expect(within(size).getByText('9.9 in')).toBeTruthy();
    expect(within(size).getByText('±10%')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Match your tension/ }));
    commit(screen.getByRole('spinbutton', { name: 'Stitches in the widest round' }), '36');
    expect(doc().gauge.testBall).toBeUndefined(); // one of two numbers
    commit(screen.getByRole('spinbutton', { name: /Around the widest round/ }), '7.2');
    expect(doc().gauge.testBall).toEqual({ maxSts: 36, circumferenceIn: 7.2 });
    expect(within(screen.getByRole('group', { name: 'Expected finished size' })).getByText('±4%')).toBeTruthy();
    commit(screen.getByRole('spinbutton', { name: /Yarn in 10 stitches/ }), '15');
    expect(doc().gauge.lscCalibratedIn).toBeCloseTo(1.5, 12);
    expect(screen.getByText(/yarn amounts are now within ±5%/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear the test ball' }));
    expect(doc().gauge.testBall).toBeUndefined();
  });

  it('the spiral lean: typed, or measured with the test tube (count / 12, signed by the side)', () => {
    open();
    render(<YarnSizePanel context="pattern" />);
    fireEvent.click(screen.getByRole('button', { name: /Match your tension/ }));
    commit(screen.getByRole('spinbutton', { name: 'Stitches per round' }), '0');
    expect(doc().threeD!.ami.leanStPerRnd).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: 'Measure it…' }));
    const dialog = screen.getByRole('dialog', { name: 'Measure your spiral lean' });
    commit(within(dialog).getByRole('spinbutton', { name: 'Stitches between the ruler and the marker' }), '3');
    expect(within(dialog).getByText(/Lean: 3 ÷ 12 = 0.25 stitch per round/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Use 0.25' }));
    expect(doc().threeD!.ami.leanStPerRnd).toBe(0.25);
    fireEvent.click(screen.getByRole('button', { name: 'Measure it…' }));
    const again = screen.getByRole('dialog', { name: 'Measure your spiral lean' });
    commit(within(again).getByRole('spinbutton', { name: 'Stitches between the ruler and the marker' }), '1.5');
    fireEvent.click(within(again).getByRole('radio', { name: 'Left of the ruler' }));
    fireEvent.click(within(again).getByRole('button', { name: 'Use -0.125' }));
    expect(doc().threeD!.ami.leanStPerRnd).toBe(-0.125);
  });

  it('writes threeD.ami: stuffing and the pattern style (open by default in the pattern context)', () => {
    open();
    render(<YarnSizePanel context="pattern" />);
    fireEvent.click(screen.getByRole('radio', { name: 'Light' }));
    expect(doc().threeD!.ami.defaultStuffing).toBe('light');
    fireEvent.click(screen.getByRole('radio', { name: 'Exact' }));
    fireEvent.click(screen.getByRole('radio', { name: 'sc2tog' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Embroidered' }));
    fireEvent.click(screen.getByRole('switch', { name: 'Crisp stripes' }));
    fireEvent.click(screen.getByRole('radio', { name: 'UK' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Left-handed' }));
    fireEvent.click(screen.getByRole('radio', { name: 'Written out' }));
    expect(doc().threeD!.ami).toMatchObject({ style: 'exact', decMethod: 'sc2tog', eyes: 'embroidered', crispStripes: true, terms: 'uk', hand: 'left', dialect: 'verbose' });
    expect(history()).toHaveLength(8);
  });

  it('scales the model to a height: one history step and a new model revision', async () => {
    open();
    render(<YarnSizePanel context="shape" />);
    const revisions = doc().threeD!.revisions.length;
    commit(screen.getByRole('spinbutton', { name: /Resize the whole toy to/ }), '12');
    // The measuring code loads on demand.
    await waitFor(() => expect(screen.getByRole('button', { name: 'Scale to 12 in' }).getAttribute('aria-disabled')).toBeNull());
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Scale to 12 in' }));
    });
    expect(modelHeight(doc().threeD!.model!)).toBeCloseTo(12, 4);
    expect(doc().threeD!.revisions.length).toBeGreaterThan(revisions);
    expect(history()).toEqual(['Scale to 12 in tall']);
  });

  it('post-import: a project the import created is pre-filled from model.yarn (CYC 0 → 1, with the note)', () => {
    const d = teddyProject();
    d.threeD!.origin = 'claude-design';
    d.threeD!.model!.yarn = { weightCYC: 0, hookMm: 2.5 };
    open(d);
    let done = 0;
    render(<YarnSizePanel context="post-import" onDone={() => done++} />);
    expect(doc().gauge).toEqual({ cyc: 1, technique: 'amigurumi_sc', hookMm: 2.5 });
    expect(screen.getByText(/Filled in from Claude Design/)).toBeTruthy();
    expect(screen.getByText(LACE_NOTE)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Yarn & size' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    expect(done).toBe(1);
  });

  it('post-import into a project with its own gauge: only offers the model’s yarn ("Use it")', () => {
    const d = teddyProject();
    d.gauge = { cyc: 5, technique: 'amigurumi_sc' };
    d.threeD!.model!.yarn = { weightCYC: 4, hookMm: 3.5 };
    open(d);
    render(<YarnSizePanel context="post-import" />);
    expect(doc().gauge.cyc).toBe(5);
    fireEvent.click(screen.getByRole('button', { name: 'Use it' }));
    expect(doc().gauge).toEqual({ cyc: 4, technique: 'amigurumi_sc' });
    expect(screen.queryByRole('button', { name: 'Use it' })).toBeNull();
  });

  it('pre-model: the finished height is the build target (threeD.recon.targetHeightIn)', () => {
    const d = teddyProject({ model: null });
    d.threeD!.recon = { targetHeightIn: 8 } as ReconSettings;
    open(d);
    render(<YarnSizePanel context="pre-model" onDone={() => undefined} />);
    expect(screen.getByRole('group', { name: 'Expected finished size' }).textContent).toContain('8 in');
    commit(screen.getByRole('spinbutton', { name: /Finished height/ }), '10');
    expect(doc().threeD!.recon!.targetHeightIn).toBe(10);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeTruthy();
  });

  it('pre-model without build settings: says where the height is set', () => {
    open(teddyProject({ model: null }));
    render(<YarnSizePanel context="pre-model" />);
    expect(screen.getByText(/height is set with the photos/)).toBeTruthy();
  });

  it('read-only: every control is disabled and nothing is written', () => {
    open();
    act(() => projectStore.getState().setReadOnly(true));
    render(<YarnSizePanel context="shape" />);
    expect((screen.getByRole('combobox', { name: 'Yarn weight' }) as HTMLSelectElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Yarn under' }));
    expect(history()).toEqual([]);
  });

  it('works as the 3D Pattern tab’s settings slot', () => {
    open();
    render(<PatternTab settingsSlot={<YarnSizePanel context="pattern" />} />);
    expect(document.querySelector('[data-context="pattern"]')).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Yarn weight' })).toBeTruthy();
  });
});
