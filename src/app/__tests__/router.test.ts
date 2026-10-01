// @vitest-environment happy-dom
// The hash router: startRouter follows location.hash; navigate pushes or replaces.
import { afterEach, describe, expect, it } from 'vitest';
import { appStore } from '../../state/appStore';
import { hrefFor, navigate, startRouter } from '../router';

describe('router', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    window.history.replaceState(null, '', '#/');
    appStore.getState().setRoute({ screen: 'start' });
  });

  it('reads the hash at start and on every hashchange', async () => {
    window.history.replaceState(null, '', '#/p/abc/chart');
    stop = startRouter();
    expect(appStore.getState().route).toEqual({ screen: 'project', projectId: 'abc', tab: 'chart' });
    window.location.hash = '#/';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    expect(appStore.getState().route).toEqual({ screen: 'start' });
  });

  it('navigate with replace rewrites the hash and updates the store at once', () => {
    stop = startRouter();
    const before = window.history.length;
    navigate({ screen: 'project', projectId: 'p1', tab: 'export' }, { replace: true });
    expect(window.location.hash).toBe('#/p/p1/export');
    expect(appStore.getState().route).toEqual({ screen: 'project', projectId: 'p1', tab: 'export' });
    expect(window.history.length).toBe(before);
  });

  it('navigate writes the hash; hrefFor gives the same string', () => {
    stop = startRouter();
    navigate({ screen: 'project', projectId: 'p 2', tab: 'qa' });
    expect(window.location.hash).toBe(hrefFor({ screen: 'project', projectId: 'p 2', tab: 'qa' }));
    expect(window.location.hash).toBe('#/p/p%202/qa');
  });
});
