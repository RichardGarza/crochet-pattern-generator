// @vitest-environment happy-dom
// The app shell end to end in happy-dom: start screen → new project → workspace tabs → library, banners,
// error boundary, toasts.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../App';
import { ErrorBoundary } from '../../../app/ErrorBoundary';
import { navigate, startRouter } from '../../../app/router';
import { notify } from '../../../app/toasts';
import { appStore } from '../../../state/appStore';
import { projectStore } from '../../../state/projectStore';
import { showProjectBanner } from '../banners';
import { createMemoryBackend, setProjectBackend } from '../projectSession';
import { ToastRegion } from '../ToastRegion';

let stop: () => void = () => {};

beforeEach(() => {
  // The capability probe's HEAD /__projects: answer as the dev server does with the mirror off (§5.5.4).
  vi.stubGlobal('fetch', async () => new Response(null, { status: 204, headers: { 'x-cpg-mirror': 'off' } }));
  setProjectBackend(createMemoryBackend());
  appStore.getState().setLibrary(null);
  window.history.replaceState(null, '', '#/');
  stop = startRouter();
});

afterEach(() => {
  vi.unstubAllGlobals();
  stop();
  projectStore.getState().close({ discardUnsaved: true });
  appStore.getState().clearToasts();
});

const tabs = () => screen.getAllByRole('tab').map((t) => t.textContent);

describe('app shell', () => {
  it('start screen → "New pattern from a picture" → the 2D workspace', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'New pattern from a picture' }));
    await screen.findByTestId('workspace');
    await waitFor(() => expect(tabs()).toEqual(['Source', 'Chart', 'Pattern', 'Materials', 'Export']));
    expect(window.location.hash).toMatch(/^#\/p\/[^/]+\/source$/);
    expect(await screen.findByText('Source picture')).toBeTruthy();
    fireEvent.click(screen.getByRole('tab', { name: 'Materials' }));
    expect(await screen.findByRole('heading', { name: 'Materials' })).toBeTruthy();
    // Back to the library: the project is listed and opens again.
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Untitled chart/ }));
    await screen.findByTestId('workspace');
  });

  it('"Describe a toy" opens the wizard route; the waiting banner offers Import and dismisses into one undo step', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Describe a toy for Claude Design' }));
    expect(await screen.findByText('Describe your toy', { selector: 'h2' })).toBeTruthy();
    expect(window.location.hash).toMatch(/\/qa$/);
    act(() => {
      projectStore.getState().update('Copy prompt', (d) => {
        d.qa = { answers: {}, decided: {}, seedSource: 'template', promptVersion: 'prompt-v1', builderVersion: 'builder-v1', step: 'import', awaiting: { since: new Date().toISOString(), seedRev: 0, via: 'copy' } };
      });
    });
    expect(await screen.findByText('Waiting for your Claude Design result')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Import Claude Design result' }));
    await waitFor(() => expect(window.location.hash).toMatch(/\/import$/));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss: stop waiting for Claude Design' }));
    await waitFor(() => expect(screen.queryByText('Waiting for your Claude Design result')).toBeNull());
    expect(projectStore.getState().history.past.at(-1)?.label).toBe('Stop waiting for Claude Design');
  });

  it('read-only: the shell shows its notice unless persistence posted its own banner', async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'New 3D toy from photos' }));
    await screen.findByTestId('workspace');
    act(() => projectStore.getState().setReadOnly(true));
    expect(await screen.findByText('Read-only', { selector: 'strong' })).toBeTruthy();
    const takeOver = vi.fn();
    act(() =>
      showProjectBanner({ id: 'ro', kind: 'read-only', tone: 'warn', title: 'Open in another tab', actions: [{ label: 'Take over', run: takeOver }] }),
    );
    expect(await screen.findByText('Open in another tab')).toBeTruthy();
    expect(screen.queryByText('Read-only', { selector: 'strong' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(takeOver).toHaveBeenCalled();
    expect(screen.getByTestId('save-chip').textContent).toContain('Read-only');
  });

  it('an unknown project shows a way back', async () => {
    render(<App />);
    act(() => navigate({ screen: 'project', projectId: 'missing', tab: 'shape' }));
    expect(await screen.findByRole('heading', { name: "This project isn't here" })).toBeTruthy();
  });
});

describe('ErrorBoundary', () => {
  it('shows the error where it happened; Try again re-mounts', () => {
    let broken = true;
    function Fragile() {
      if (broken) throw new Error('boom');
      return <p>fine</p>;
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary where="the Chart tab">
          <Fragile />
        </ErrorBoundary>,
      );
      expect(screen.getByRole('alert').textContent).toContain('Something went wrong in the Chart tab');
      expect(screen.getByText(/Error: boom/)).toBeTruthy();
      broken = false;
      fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
      expect(screen.getByText('fine')).toBeTruthy();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('toasts', () => {
  it('a toast shows, runs its action, and times out; errors stay', () => {
    vi.useFakeTimers();
    try {
      render(<ToastRegion />);
      const run = vi.fn();
      act(() => {
        notify.success('Copied', { action: { label: 'Undo', run } });
        notify.error('Could not read that file');
      });
      expect(screen.getAllByText('Copied').length).toBe(2); // the toast and its polite announcement
      expect(screen.getAllByText('Could not read that file').length).toBe(2); // the toast and its assertive announcement
      act(() => {
        vi.advanceTimersByTime(4100);
      });
      expect(screen.queryByText('Copied')).toBeNull();
      expect(screen.getAllByText('Could not read that file').length).toBe(2);
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
      expect(screen.queryByText('Could not read that file')).toBeNull();
      expect(run).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
