// appStore in the node environment: there is no window here, so merely importing the module proves that it
// touches none at load.
import { describe, expect, it } from 'vitest';
import { mulberry32, randomInt } from '../../core/kernel/prng';
import type { ProjectSummary } from '../../types/project';
import {
  appStore,
  createAppStore,
  DEFAULT_PREFS,
  formatHash,
  isProjectId,
  isRouteTab,
  MAX_TOASTS,
  MIRROR_HEADER,
  MIRROR_PROBE_URL,
  parseHash,
  probeCapabilities,
  QA_ROUTE,
  sameRoute,
  sanitizePrefs,
  START_ROUTE,
  TAB_IDS,
  TOAST_TIMEOUT_MS,
  UNKNOWN_CAPABILITIES,
  type Route,
  type RouteTab,
} from '../appStore';

describe('the module', () => {
  it('loads without a window and starts on the start screen with defaults', () => {
    expect(typeof window).toBe('undefined');
    const s = appStore.getState();
    expect(s.route).toEqual({ screen: 'start' });
    expect(s.prefs).toEqual({ units: 'in', terms: 'us', hand: 'right', dialect: 'compact', theme: 'system', features: { mosaic: false } });
    expect(s.prefsHydrated).toBe(false);
    expect(s.capabilities).toEqual({ webgpu: null, storagePersisted: null, folderMirror: null });
    expect(s.library).toBeNull();
    expect(s.toasts).toEqual([]);
  });
});

describe('hash routes', () => {
  const ALL_TABS: RouteTab[] = [...TAB_IDS, QA_ROUTE];

  it('formats every route form', () => {
    expect(formatHash({ screen: 'start' })).toBe('#/');
    expect(formatHash({ screen: 'project', projectId: 'abc123' })).toBe('#/p/abc123');
    expect(formatHash({ screen: 'project', projectId: 'abc123', tab: 'chart' })).toBe('#/p/abc123/chart');
    expect(formatHash({ screen: 'project', projectId: 'abc123', tab: 'qa' })).toBe('#/p/abc123/qa'); // the wizard route
    expect(formatHash({ screen: 'project', projectId: 'a b' })).toBe('#/p/a%20b');
  });

  it('parses every route form', () => {
    expect(parseHash('#/')).toEqual({ screen: 'start' });
    expect(parseHash('#/p/abc123')).toEqual({ screen: 'project', projectId: 'abc123' });
    expect(parseHash('#/p/abc123/chart')).toEqual({ screen: 'project', projectId: 'abc123', tab: 'chart' });
    expect(parseHash('#/p/abc123/qa')).toEqual({ screen: 'project', projectId: 'abc123', tab: 'qa' });
    for (const tab of ALL_TABS) expect(parseHash(`#/p/x/${tab}`)).toEqual({ screen: 'project', projectId: 'x', tab });
    expect(TAB_IDS).toEqual(['source', 'chart', 'photos', 'import', 'shape', 'pattern', 'materials', 'export']);
  });

  it('round-trips every route: parse(format(route)) is the route, for every tab and many ids (seeded)', () => {
    const rng = mulberry32(2026);
    const alphabet = 'abcXYZ019-_.~!*()%?#&=+:@é漢🧶';
    const chars = [...alphabet];
    const routes: Route[] = [{ screen: 'start' }];
    for (let n = 0; n < 300; n++) {
      let id = '';
      const length = 1 + randomInt(rng, 24);
      for (let i = 0; i < length; i++) id += chars[randomInt(rng, chars.length)];
      routes.push({ screen: 'project', projectId: id });
      routes.push({ screen: 'project', projectId: id, tab: ALL_TABS[randomInt(rng, ALL_TABS.length)] });
    }
    routes.push({ screen: 'project', projectId: crypto.randomUUID(), tab: 'shape' });
    for (const route of routes) {
      const hash = formatHash(route);
      expect(hash.startsWith('#/')).toBe(true);
      expect(parseHash(hash), hash).toEqual(route);
      expect(parseHash(hash.slice(1)), 'without the leading #').toEqual(route);
      expect(formatHash(parseHash(hash))).toBe(hash); // and the hash is canonical
    }
  });

  it('falls back to the start screen for every hash it does not know', () => {
    const unknown = [
      '',
      '#',
      '#/',
      '#//',
      '#/nonsense',
      '#/settings',
      '#/p',
      '#/p/',
      '#/P/abc', // case matters
      '#/x/abc/chart',
      '#p/abc', // no leading slash
      'p/abc',
      '#/p//chart', // an empty id
      '#/p/a%2Fb/chart', // an id with a slash in it
      '#/p/%E0%A4%A/chart', // malformed percent-encoding
      '#/p/%20/chart', // a blank id
      '#/p/abc/chart/extra',
      '#/p/abc/chart/extra/more',
      '#/projects/abc',
      '#!/p/abc',
      '##/p/abc',
      `#/p/${'x'.repeat(201)}`,
    ];
    for (const hash of unknown) expect(parseHash(hash), JSON.stringify(hash)).toEqual({ screen: 'start' });
    expect(parseHash('#/whatever')).toBe(START_ROUTE);
  });

  it('opens the project at its default tab when only the tab segment is unknown', () => {
    expect(parseHash('#/p/abc/settings')).toEqual({ screen: 'project', projectId: 'abc' });
    expect(parseHash('#/p/abc/Chart')).toEqual({ screen: 'project', projectId: 'abc' });
    expect(parseHash('#/p/abc/__proto__')).toEqual({ screen: 'project', projectId: 'abc' });
  });

  it('tolerates a trailing slash and ignores a query', () => {
    expect(parseHash('#/p/abc/')).toEqual({ screen: 'project', projectId: 'abc' });
    expect(parseHash('#/p/abc/chart/')).toEqual({ screen: 'project', projectId: 'abc', tab: 'chart' });
    expect(parseHash('#/p/abc/chart?cell=12')).toEqual({ screen: 'project', projectId: 'abc', tab: 'chart' });
    expect(parseHash('#/?x=1')).toEqual({ screen: 'start' });
  });

  it('knows a tab and a project id when it sees one', () => {
    expect(isRouteTab('qa')).toBe(true);
    expect(isRouteTab('shape')).toBe(true);
    expect(isRouteTab('toString')).toBe(false);
    expect(isRouteTab(undefined)).toBe(false);
    expect(isProjectId('7b0f4c1e-1c0a-4b46-9a53-1f0e8a2d9c11')).toBe(true);
    expect(isProjectId('V1StGXR8_Z5jdHi6B-myT')).toBe(true);
    for (const bad of ['', 'a/b', 'a b', 'tab\tbed', 'line\nbreak', 'nul\0', 'x'.repeat(201), 5, null, undefined]) {
      expect(isProjectId(bad), JSON.stringify(bad)).toBe(false);
    }
    expect(sameRoute({ screen: 'start' }, { screen: 'start' })).toBe(true);
    expect(sameRoute({ screen: 'project', projectId: 'a' }, { screen: 'project', projectId: 'a', tab: 'chart' })).toBe(false);
  });

  it('every id it accepts round-trips; a lone surrogate (which encodeURIComponent cannot encode) is not an id', () => {
    for (const bad of ['toy\uD800', '\uDC00toy', 'a\uDBFFb', '\uDFFF\uD800']) {
      expect(isProjectId(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const id of ['toy\uD83E\uDDF8', 'häkeln-🧶', 'Bunny_(copy)', 'a%2Fb', '?#', 'x'.repeat(200)]) {
      expect(isProjectId(id), id).toBe(true);
      const route: Route = { screen: 'project', projectId: id, tab: 'shape' };
      expect(parseHash(formatHash(route))).toEqual(route);
    }
  });

  it('setRoute stores the route and ignores one that is the same', () => {
    const store = createAppStore();
    let changes = 0;
    store.subscribe(() => changes++);
    store.getState().setRoute(parseHash('#/p/abc/chart'));
    expect(store.getState().route).toEqual({ screen: 'project', projectId: 'abc', tab: 'chart' });
    const first = store.getState().route;
    store.getState().setRoute({ screen: 'project', projectId: 'abc', tab: 'chart' });
    expect(store.getState().route).toBe(first);
    expect(changes).toBe(1);
    store.getState().setRoute({ screen: 'project', projectId: 'abc' });
    expect(store.getState().route).toEqual({ screen: 'project', projectId: 'abc' });
    expect('tab' in store.getState().route).toBe(false);
    store.getState().setRoute(parseHash('#/garbage'));
    expect(store.getState().route).toEqual({ screen: 'start' });
    expect(changes).toBe(3);
  });
});

describe('preferences', () => {
  it('merges a patch, feature flags included', () => {
    const store = createAppStore();
    store.getState().setPrefs({ units: 'cm', hand: 'left' });
    store.getState().setPrefs({ features: { mosaic: true } });
    expect(store.getState().prefs).toEqual({ units: 'cm', terms: 'us', hand: 'left', dialect: 'compact', theme: 'system', features: { mosaic: true } });
    expect(DEFAULT_PREFS.units).toBe('in'); // the defaults are not touched
    const before = store.getState().prefs;
    store.getState().setPrefs({ units: 'cm' }); // no change: no new object, nothing to save
    expect(store.getState().prefs).toBe(before);
  });

  it('ignores values that are not allowed', () => {
    const store = createAppStore();
    store.getState().setPrefs({ units: 'furlongs', terms: 42, dialect: null, features: { mosaic: 'yes' } } as never);
    expect(store.getState().prefs).toEqual(DEFAULT_PREFS);
  });

  it('keeps the theme choice (system, light, dark) and refuses anything else', () => {
    const store = createAppStore();
    store.getState().setPrefs({ theme: 'dark' });
    expect(store.getState().prefs.theme).toBe('dark');
    store.getState().setPrefs({ theme: 'sepia' } as never);
    expect(store.getState().prefs.theme).toBe('dark');
    expect(sanitizePrefs({ theme: 'light' }).theme).toBe('light');
    expect(sanitizePrefs({ theme: 3 }).theme).toBe('system');
  });

  it('hydrates from whatever was stored', () => {
    const store = createAppStore();
    store.getState().hydratePrefs({ units: 'cm', terms: 'uk', hand: 'sideways', extra: 1, features: { mosaic: true, warp: true } });
    expect(store.getState().prefs).toEqual({ units: 'cm', terms: 'uk', hand: 'right', dialect: 'compact', theme: 'system', features: { mosaic: true } });
    expect(store.getState().prefsHydrated).toBe(true);
    for (const garbage of [undefined, null, 'text', 7, [], { features: 'x' }]) {
      expect(sanitizePrefs(garbage)).toEqual(DEFAULT_PREFS);
    }
  });
});

describe('capabilities', () => {
  const headers = (value: string | null) => ({ headers: { get: (name: string) => (name === MIRROR_HEADER ? value : null) } });

  it('probes WebGPU, persistent storage and the folder mirror', async () => {
    const calls: unknown[] = [];
    const result = await probeCapabilities({
      gpu: { requestAdapter: async () => ({ name: 'adapter' }) },
      storage: { persisted: async () => true },
      fetch: async (url, init) => {
        calls.push([url, init]);
        return headers('on');
      },
    });
    expect(result).toEqual({ webgpu: true, storagePersisted: true, folderMirror: true });
    expect(calls).toEqual([[MIRROR_PROBE_URL, { method: 'HEAD', cache: 'no-store' }]]);
    expect([MIRROR_PROBE_URL, MIRROR_HEADER]).toEqual(['/__projects', 'x-cpg-mirror']);
  });

  it('reports false for everything that is missing, says no, or fails', async () => {
    expect(await probeCapabilities({})).toEqual({ webgpu: false, storagePersisted: false, folderMirror: false });
    expect(
      await probeCapabilities({
        gpu: { requestAdapter: async () => null }, // WebGPU without an adapter
        storage: { persisted: async () => false },
        fetch: async () => headers('off'), // the Step 0 stub, and the isolation rules of §5.5.4
      }),
    ).toEqual({ webgpu: false, storagePersisted: false, folderMirror: false });
    expect(
      await probeCapabilities({
        gpu: {
          requestAdapter: async () => {
            throw new Error('gpu lost');
          },
        },
        storage: {},
        fetch: async () => {
          throw new TypeError('Failed to fetch');
        },
      }),
    ).toEqual({ webgpu: false, storagePersisted: false, folderMirror: false });
    expect((await probeCapabilities({ fetch: async () => headers(null) })).folderMirror).toBe(false); // a static host
  });

  it('does not throw where there is no browser at all', async () => {
    expect(await probeCapabilities()).toEqual({ webgpu: false, storagePersisted: false, folderMirror: false });
  });

  it('are stored piece by piece', () => {
    const store = createAppStore();
    store.getState().setCapabilities({ webgpu: true });
    store.getState().setCapabilities({ folderMirror: false });
    expect(store.getState().capabilities).toEqual({ webgpu: true, storagePersisted: null, folderMirror: false });
    expect(UNKNOWN_CAPABILITIES.webgpu).toBeNull();
  });
});

describe('library summaries', () => {
  const summary = (id: string, name = id): ProjectSummary => ({ id, name, mode: '3d', updatedAt: '2026-10-01T10:00:00.000Z' });

  it('sets, updates and removes summaries', () => {
    const store = createAppStore();
    const list = [summary('a'), summary('b')];
    store.getState().setLibrary(list);
    list.push(summary('z')); // the caller's array is not the store's
    expect(store.getState().library?.map((p) => p.id)).toEqual(['a', 'b']);
    store.getState().upsertSummary({ ...summary('a', 'Renamed'), awaitingClaudeDesign: true });
    store.getState().upsertSummary(summary('c'));
    expect(store.getState().library).toEqual([{ ...summary('a', 'Renamed'), awaitingClaudeDesign: true }, summary('b'), summary('c')]);
    store.getState().removeSummary('b');
    store.getState().removeSummary('nope');
    expect(store.getState().library?.map((p) => p.id)).toEqual(['a', 'c']);
    store.getState().setLibrary(null);
    expect(store.getState().library).toBeNull();
    store.getState().upsertSummary(summary('first'));
    expect(store.getState().library).toEqual([summary('first')]);
  });
});

describe('toasts', () => {
  it('adds toasts with increasing ids and a timeout by kind', () => {
    const store = createAppStore();
    const a = store.getState().toast({ message: 'Saved a copy' });
    const b = store.getState().toast({ message: 'Not saved', kind: 'error' });
    const c = store.getState().toast({ message: 'Careful', kind: 'warn', timeoutMs: 1234 });
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);
    expect(store.getState().toasts).toEqual([
      { id: a, kind: 'info', message: 'Saved a copy', timeoutMs: TOAST_TIMEOUT_MS.info },
      { id: b, kind: 'error', message: 'Not saved', timeoutMs: 0 }, // errors stay
      { id: c, kind: 'warn', message: 'Careful', timeoutMs: 1234 },
    ]);
    store.getState().dismissToast(b);
    store.getState().dismissToast(999);
    expect(store.getState().toasts.map((t) => t.id)).toEqual([a, c]);
    store.getState().clearToasts();
    expect(store.getState().toasts).toEqual([]);
  });

  it('replaces a toast with the same key instead of piling up', () => {
    const store = createAppStore();
    store.getState().toast({ message: 'other' });
    store.getState().toast({ message: 'This project is read-only here', key: 'read-only', kind: 'warn' });
    const latest = store.getState().toast({ message: 'This project is read-only here', key: 'read-only', kind: 'warn' });
    expect(store.getState().toasts.map((t) => t.message)).toEqual(['other', 'This project is read-only here']);
    expect(store.getState().toasts[1].id).toBe(latest);
  });

  it('keeps at most five, dropping the oldest, and carries an action', () => {
    const store = createAppStore();
    let ran = 0;
    for (let i = 1; i <= 8; i++) store.getState().toast({ message: `toast ${i}`, action: { label: 'Undo', run: () => ran++ } });
    const { toasts } = store.getState();
    expect(toasts).toHaveLength(MAX_TOASTS);
    expect(toasts.map((t) => t.message)).toEqual(['toast 4', 'toast 5', 'toast 6', 'toast 7', 'toast 8']);
    toasts[0].action?.run();
    expect(ran).toBe(1);
  });
});
