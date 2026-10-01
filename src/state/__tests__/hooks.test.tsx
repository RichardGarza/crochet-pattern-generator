// @vitest-environment happy-dom
// The React hooks of the three stores, and the worker-side yield, in the UI test environment (happy-dom).
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { ChartResult } from '../../types/chart';
import type { ProjectDoc } from '../../types/project';
import { createJobGate, yieldMacrotask } from '../../workers/rpc';
import { appStore, useAppStore } from '../appStore';
import { derivedStore, jobOf, useDerivedStore } from '../derivedStore';
import { projectStore, selectCanUndo, selectUndoLabel, useProjectStore } from '../projectStore';

const doc: ProjectDoc = {
  schema: 'crochet-project',
  version: 1,
  id: 'hooks',
  name: 'Bunny',
  createdAt: '2026-10-01T10:00:00.000Z',
  updatedAt: '2026-10-01T10:00:00.000Z',
  rev: 1,
  mode: '2d',
  units: 'in',
  terms: 'us',
  hand: 'right',
  gauge: { cyc: 4, technique: 'sc_graphgan' },
  sources: [],
  imports: [],
};

let renders = 0;

function Workspace() {
  renders++;
  const name = useProjectStore((s) => s.doc?.name ?? '(no project)');
  const canUndo = useProjectStore(selectCanUndo);
  const undoLabel = useProjectStore(selectUndoLabel);
  const status = useProjectStore((s) => s.saveStatus);
  const tab = useAppStore((s) => s.route.tab ?? '(default tab)');
  const units = useAppStore((s) => s.prefs.units);
  const toasts = useAppStore((s) => s.toasts);
  const chartJob = useDerivedStore((s) => jobOf(s, 'chart').status);
  const chartHash = useDerivedStore((s) => s.chart?.inputHash ?? '(no chart)');
  return (
    <ul>
      <li data-testid="name">{name}</li>
      <li data-testid="undo">{canUndo ? `Undo ${undoLabel}` : 'nothing to undo'}</li>
      <li data-testid="status">{status}</li>
      <li data-testid="tab">{tab}</li>
      <li data-testid="units">{units}</li>
      <li data-testid="toasts">{toasts.map((t) => t.message).join(' | ')}</li>
      <li data-testid="chart">{`${chartJob} ${chartHash}`}</li>
    </ul>
  );
}

const text = (id: string): string => screen.getByTestId(id).textContent ?? '';

describe('store hooks', () => {
  it('render the stores and follow their changes', async () => {
    render(<Workspace />);
    expect(text('name')).toBe('(no project)');
    expect(text('chart')).toBe('idle (no chart)');

    act(() => projectStore.getState().open(doc, { discardUnsaved: true }));
    expect(text('name')).toBe('Bunny');
    expect(text('undo')).toBe('nothing to undo');
    expect(text('status')).toBe('saved');

    act(() => {
      projectStore.getState().update('Rename project', (d) => (d.name = 'Teddy'));
    });
    expect(text('name')).toBe('Teddy');
    expect(text('undo')).toBe('Undo Rename project');
    expect(text('status')).toBe('unsaved');

    act(() => {
      projectStore.getState().undo();
    });
    expect(text('name')).toBe('Bunny');
    expect(text('undo')).toBe('nothing to undo');

    act(() => {
      appStore.getState().setRoute({ screen: 'project', projectId: 'hooks', tab: 'chart' });
      appStore.getState().setPrefs({ units: 'cm' });
      appStore.getState().toast({ message: 'Saved a copy' });
    });
    expect(text('tab')).toBe('chart');
    expect(text('units')).toBe('cm');
    expect(text('toasts')).toBe('Saved a copy');

    let resolve!: (value: ChartResult) => void;
    let run!: Promise<unknown>;
    act(() => {
      run = derivedStore.getState().run('chart', 'hash-1', () => new Promise<ChartResult>((r) => (resolve = r)));
    });
    expect(text('chart')).toBe('running (no chart)');
    await act(async () => {
      resolve({ hash: 'x' } as unknown as ChartResult);
      await run;
    });
    expect(text('chart')).toBe('done hash-1');

    // a change the component does not select does not re-render it
    const before = renders;
    act(() => {
      projectStore.getState().cacheAsset('hooks/abc', new Blob(['x']));
      appStore.getState().setCapabilities({ webgpu: false });
    });
    expect(renders).toBe(before);

    act(() => {
      appStore.getState().clearToasts();
      appStore.getState().setRoute({ screen: 'start' });
      appStore.getState().setPrefs({ units: 'in' });
      projectStore.getState().close({ discardUnsaved: true });
    });
    expect(text('name')).toBe('(no project)');
    expect(text('chart')).toBe('idle (no chart)'); // closing the project emptied the derived store
  });
});

describe('the worker yield in happy-dom', () => {
  it('still yields a macrotask and lets a queued message run', async () => {
    await yieldMacrotask();
    const channel = new MessageChannel();
    let delivered = false;
    channel.port1.onmessage = () => {
      delivered = true;
    };
    channel.port2.postMessage('queued');
    await createJobGate().check(1);
    expect(delivered).toBe(true);
    channel.port1.close();
    channel.port2.close();
  });
});
