// @vitest-environment happy-dom
// ui/library/useAutosave — the frozen hook (§5.2.1 UseAutosaveFn) and the browser start-up of persistence.
// fake-indexeddb is installed as the page's IndexedDB BEFORE the hook module loads, so importing the hook
// starts persistence exactly as in a browser (happy-dom has no navigator.locks: the in-tab lock fallback).
import 'fake-indexeddb/auto';
import { act, renderHook } from '@testing-library/react';
import { afterAll, describe, expect, expectTypeOf, it } from 'vitest';
import { isImplemented } from '../../../core/stub';
import { projectStore } from '../../../state/projectStore';
import type { UseAutosaveFn } from '../../../types/entryPoints';
import { makeDoc } from '../../../core/persist/__tests__/helpers';
import { projectBackend } from '../../shell/projectSession';
import { getPersistence } from '../persistence';
import { flushAutosave, useAutosave } from '../useAutosave';

afterAll(() => {
  if (projectStore.getState().doc) projectStore.getState().close({ discardUnsaved: true });
  getPersistence()?.stop();
});

describe('useAutosave', () => {
  it('is implemented with the frozen signature', () => {
    expect(isImplemented(useAutosave)).toBe(true);
    expectTypeOf(useAutosave).toEqualTypeOf<UseAutosaveFn>();
  });

  it('importing it in a browser starts persistence behind the shell’s backend seam', () => {
    expect(getPersistence()).not.toBeNull();
    expect(projectBackend().kind).toBe('repository');
  });

  it('reports saved → saving → saved, flushes on demand and on tab hide, and read-only', async () => {
    const backend = projectBackend();
    const doc = await backend.create(makeDoc('hook-1'));
    const opened = await backend.open('hook-1');
    act(() => projectStore.getState().open(opened!.doc, { readOnly: opened!.readOnly }));
    const { result } = renderHook(() => useAutosave());
    expect(result.current.status).toBe('saved');
    const flush = result.current.flush;

    act(() => void projectStore.getState().update('Rename project', (d) => void (d.name = 'From the hook')));
    expect(result.current.status).toBe('saving'); // waiting for the 800 ms debounce
    expect(result.current.flush).toBe(flush);
    await act(() => result.current.flush());
    expect(result.current.status).toBe('saved');
    expect((await getPersistence()!.repo.open('hook-1', 'read')).doc).toMatchObject({ name: 'From the hook', rev: doc.rev + 1 });

    act(() => void projectStore.getState().update('Rename project', (d) => void (d.name = 'Hidden')));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await flushAutosave();
    });
    expect(result.current.status).toBe('saved');
    expect((await getPersistence()!.repo.open('hook-1', 'read')).doc.name).toBe('Hidden');

    act(() => projectStore.getState().setReadOnly(true));
    expect(result.current.status).toBe('read-only');
  });
});
