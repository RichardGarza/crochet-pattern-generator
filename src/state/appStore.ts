// The app's own state (DESIGN.md §5.3, §5.7): the route, preferences, capabilities, the library's project
// summaries and toasts. Step 0 owned.
//
// Nothing here touches `window`, `location` or `navigator` at module load, so the module imports cleanly in the
// vitest node environment. The route functions are pure (`parseHash`, `formatHash`); the shell's router
// (app/router.ts) is what listens to `hashchange` and calls `setRoute(parseHash(location.hash))`, and what
// writes `location.hash = formatHash(route)`. `probeCapabilities` reads the browser only when it is called.
// Preferences are persisted by T8 (the `settings` store of §5.5.1): it calls `hydratePrefs(stored)` at start
// and saves `prefs` when they change after that (`prefsHydrated`).
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { ProjectSummary } from '../types/project';
import type { Hand, Terms, UnitPref } from '../types/units';

// ---- routes

/**
 * The ids of the workspace tabs, as they appear in the hash (§5.3): 2D = source · chart · pattern · materials ·
 * export; 3D = photos · import · shape · pattern · materials · export. The tab registry (app/tabs.ts) uses
 * these ids.
 */
export const TAB_IDS = ['source', 'chart', 'photos', 'import', 'shape', 'pattern', 'materials', 'export'] as const;
export type TabId = (typeof TAB_IDS)[number];

/** The Q&A wizard is a project route, `#/p/<id>/qa`, not a tab (§5.3). */
export const QA_ROUTE = 'qa';
/** The last segment of a project route: a tab, or the wizard. */
export type RouteTab = TabId | typeof QA_ROUTE;

export interface StartRoute {
  screen: 'start';
  projectId?: undefined;
  tab?: undefined;
}
export interface ProjectRoute {
  screen: 'project';
  projectId: string;
  /** Absent: the project's default tab (the shell picks it by the project's mode and rewrites the hash). */
  tab?: RouteTab;
}
/** `{ screen: 'start' | 'project', projectId?, tab? }` (§5.3). */
export type Route = StartRoute | ProjectRoute;

export const START_ROUTE: StartRoute = { screen: 'start' };

export function isRouteTab(value: unknown): value is RouteTab {
  return value === QA_ROUTE || (TAB_IDS as readonly unknown[]).includes(value);
}

/**
 * A usable project id: a non-empty string of at most 200 characters without `/` (the id is the first half of
 * every asset key, `<projectId>/<sha256>`), without whitespace or control characters, and well-formed UTF-16
 * (no lone surrogate, which `encodeURIComponent` cannot encode). `projectStore.open` and the routes accept
 * exactly these, and every one of them round-trips through `formatHash` / `parseHash`.
 */
export function isProjectId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 200 &&
    // eslint-disable-next-line no-control-regex
    !/[/\s\u0000-\u001f\u007f]/.test(id) &&
    // A lone surrogate: a high one not followed by a low one, or a low one not preceded by a high one.
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(id)
  );
}

/**
 * The hash of a route: `#/` (start), `#/p/<id>` (a project at its default tab), `#/p/<id>/<tab>` and the
 * wizard `#/p/<id>/qa`. The id is percent-encoded.
 */
export function formatHash(route: Route): string {
  if (route.screen !== 'project') return '#/';
  const base = `#/p/${encodeURIComponent(route.projectId)}`;
  return route.tab ? `${base}/${route.tab}` : base;
}

/**
 * The route of a hash (`location.hash`, with or without the leading `#`). Total: a hash that is not one of
 * the forms of `formatHash` gives the start screen — except that an unknown LAST segment of a well-formed
 * project hash gives that project without a tab, so an old link still opens its project.
 */
export function parseHash(hash: string): Route {
  let path = hash.startsWith('#') ? hash.slice(1) : hash;
  const query = path.indexOf('?');
  if (query >= 0) path = path.slice(0, query);
  if (!path.startsWith('/')) return START_ROUTE;
  const segments = path.slice(1).split('/');
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop(); // one trailing slash
  if (segments[0] !== 'p' || segments.length < 2 || segments.length > 3) return START_ROUTE;
  let projectId: string;
  try {
    projectId = decodeURIComponent(segments[1]);
  } catch {
    return START_ROUTE;
  }
  if (!isProjectId(projectId)) return START_ROUTE;
  const tab = segments[2];
  return isRouteTab(tab) ? { screen: 'project', projectId, tab } : { screen: 'project', projectId };
}

export function sameRoute(a: Route, b: Route): boolean {
  return a.screen === b.screen && a.projectId === b.projectId && a.tab === b.tab;
}

// ---- preferences

/** App-level feature flags: preferences, not project data (§2.7.8, §8 v1.3). */
export interface FeatureFlags {
  /** Overlay mosaic, the P1 technique of §2.7.8. */
  mosaic: boolean;
}

/** The color theme: follow the system (`prefers-color-scheme`), or the one the user picked (Step 0c shell). */
export type ThemePref = 'system' | 'light' | 'dark';

export interface Prefs {
  units: UnitPref;
  terms: Terms;
  hand: Hand;
  dialect: 'compact' | 'verbose';
  theme: ThemePref;
  features: FeatureFlags;
}

export const DEFAULT_PREFS: Prefs = { units: 'in', terms: 'us', hand: 'right', dialect: 'compact', theme: 'system', features: { mosaic: false } };

export type PrefsPatch = Partial<Omit<Prefs, 'features'>> & { features?: Partial<FeatureFlags> };

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

/**
 * Preferences from whatever was stored: every field that is missing or not one of its allowed values falls
 * back to `base` (the defaults), and unknown fields are dropped. Never throws.
 */
export function sanitizePrefs(stored: unknown, base: Prefs = DEFAULT_PREFS): Prefs {
  const raw = typeof stored === 'object' && stored !== null ? (stored as Record<string, unknown>) : {};
  const features = typeof raw.features === 'object' && raw.features !== null ? (raw.features as Record<string, unknown>) : {};
  return {
    units: oneOf<UnitPref>(raw.units, ['in', 'cm'], base.units),
    terms: oneOf<Terms>(raw.terms, ['us', 'uk'], base.terms),
    hand: oneOf<Hand>(raw.hand, ['right', 'left'], base.hand),
    dialect: oneOf<Prefs['dialect']>(raw.dialect, ['compact', 'verbose'], base.dialect),
    theme: oneOf<ThemePref>(raw.theme, ['system', 'light', 'dark'], base.theme),
    features: { mosaic: typeof features.mosaic === 'boolean' ? features.mosaic : base.features.mosaic },
  };
}

// ---- capabilities

/** What this browser and server can do; null = not probed yet. */
export interface Capabilities {
  /** WebGPU has an adapter (depth runs on it, §2.9.4). */
  webgpu: boolean | null;
  /** `navigator.storage.persisted()`: the browser will not evict IndexedDB (§5.5.2). */
  storagePersisted: boolean | null;
  /** The dev/preview server mirrors projects into a folder (§5.5.4). */
  folderMirror: boolean | null;
}

export const UNKNOWN_CAPABILITIES: Capabilities = { webgpu: null, storagePersisted: null, folderMirror: null };

/** The mirror probe of §5.5.4: `HEAD /__projects` answers the header `x-cpg-mirror: on` when the mirror is active. */
export const MIRROR_PROBE_URL = '/__projects';
export const MIRROR_HEADER = 'x-cpg-mirror';

/** The browser APIs `probeCapabilities` reads; tests pass their own. */
export interface CapabilityEnv {
  gpu?: { requestAdapter(): Promise<unknown> };
  storage?: { persisted?(): Promise<boolean> };
  fetch?: (url: string, init: { method: 'HEAD'; cache: 'no-store' }) => Promise<{ headers: { get(name: string): string | null } }>;
}

function browserCapabilityEnv(): CapabilityEnv {
  const nav = typeof navigator === 'undefined' ? undefined : (navigator as unknown as { gpu?: CapabilityEnv['gpu']; storage?: CapabilityEnv['storage'] });
  return {
    gpu: nav?.gpu,
    storage: nav?.storage,
    fetch: typeof fetch === 'function' ? (url, init) => fetch(url, init) : undefined,
  };
}

/**
 * Probes the three capabilities. Never rejects: whatever is missing or fails is `false`. Any answer to the
 * mirror probe other than the header `x-cpg-mirror: on` — a static host's included — means off (§5.5.4).
 */
export async function probeCapabilities(env: CapabilityEnv = browserCapabilityEnv()): Promise<{ webgpu: boolean; storagePersisted: boolean; folderMirror: boolean }> {
  const [webgpu, startup] = await Promise.all([probeWebGpu(env), probeStartupCapabilities(env)]);
  return { webgpu, ...startup };
}

const attempt = async (probe: () => Promise<boolean>): Promise<boolean> => {
  try {
    return await probe();
  } catch {
    return false;
  }
};

/**
 * What the app probes when it starts: persistent storage and the folder mirror — not WebGPU. Chromium logs the
 * console warning "No available adapters." whenever `requestAdapter()` finds none (every headless run, every
 * machine without a GPU), so WebGPU is probed on demand by the feature that needs it (`ensureWebGpuProbed`).
 */
export async function probeStartupCapabilities(env: CapabilityEnv = browserCapabilityEnv()): Promise<{ storagePersisted: boolean; folderMirror: boolean }> {
  const [storagePersisted, folderMirror] = await Promise.all([
    attempt(async () => (env.storage?.persisted ? (await env.storage.persisted()) === true : false)),
    attempt(async () => {
      if (!env.fetch) return false;
      const response = await env.fetch(MIRROR_PROBE_URL, { method: 'HEAD', cache: 'no-store' });
      return response.headers.get(MIRROR_HEADER) === 'on';
    }),
  ]);
  return { storagePersisted, folderMirror };
}

/** True when WebGPU has an adapter. Never rejects. */
export function probeWebGpu(env: CapabilityEnv = browserCapabilityEnv()): Promise<boolean> {
  return attempt(async () => (env.gpu ? (await env.gpu.requestAdapter()) != null : false));
}

let webGpuProbe: Promise<boolean> | null = null;

/**
 * Probes WebGPU once per page and stores the answer in `capabilities.webgpu` (null until then). Call it where
 * the answer is needed (the Photos tab's depth option, §2.9.4), not at start-up.
 */
export function ensureWebGpuProbed(env?: CapabilityEnv, store: { getState(): Pick<AppState, 'setCapabilities'> } = appStore): Promise<boolean> {
  webGpuProbe ??= probeWebGpu(env).then((webgpu) => {
    store.getState().setCapabilities({ webgpu });
    return webgpu;
  });
  return webGpuProbe;
}

/** Tests: forget the page's WebGPU answer. */
export function resetWebGpuProbe(): void {
  webGpuProbe = null;
}

// ---- toasts

export type ToastKind = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  /** A toast with the key of one that is showing replaces it (no pile of identical messages). */
  key?: string;
  action?: { label: string; run(): void };
  /** How long the shell shows it; 0 = until dismissed. The shell's toast view runs the timer. */
  timeoutMs: number;
}

export interface ToastInput {
  message: string;
  kind?: ToastKind;
  key?: string;
  action?: { label: string; run(): void };
  timeoutMs?: number;
}

/** Errors stay until dismissed. */
export const TOAST_TIMEOUT_MS: Record<ToastKind, number> = { info: 4000, success: 4000, warn: 8000, error: 0 };
/** The oldest toast goes when more than this many are showing. */
export const MAX_TOASTS = 5;

// ---- the store

export interface AppState {
  route: Route;
  prefs: Prefs;
  /** True once `hydratePrefs` ran: before that, `prefs` are the defaults and must not be saved over stored ones. */
  prefsHydrated: boolean;
  capabilities: Capabilities;
  /** The library's project summaries (the start screen's grid); null until T8's library slice loaded them. */
  library: ProjectSummary[] | null;
  toasts: Toast[];

  /** The router calls this with `parseHash(location.hash)`. An equal route changes nothing. */
  setRoute(route: Route): void;
  setPrefs(patch: PrefsPatch): void;
  /** Replaces the preferences with what was stored (sanitized over the defaults). */
  hydratePrefs(stored: unknown): void;
  setCapabilities(patch: Partial<Capabilities>): void;
  setLibrary(list: ProjectSummary[] | null): void;
  /** Adds a summary, or replaces the one with the same id, keeping its place. */
  upsertSummary(summary: ProjectSummary): void;
  removeSummary(projectId: string): void;
  /** Shows a toast and returns its id. */
  toast(input: ToastInput): number;
  dismissToast(id: number): void;
  clearToasts(): void;
}

export type AppStore = StoreApi<AppState>;

/** An app store of its own (tests). */
export function createAppStore(): AppStore {
  let nextToastId = 1;
  return createStore<AppState>()((set, get) => ({
    route: START_ROUTE,
    prefs: DEFAULT_PREFS,
    prefsHydrated: false,
    capabilities: UNKNOWN_CAPABILITIES,
    library: null,
    toasts: [],

    setRoute(route) {
      if (sameRoute(get().route, route)) return;
      set({ route: route.screen === 'project' ? { screen: 'project', projectId: route.projectId, ...(route.tab ? { tab: route.tab } : {}) } : START_ROUTE });
    },

    setPrefs(patch) {
      const { prefs } = get();
      const next = sanitizePrefs({ ...prefs, ...patch, features: { ...prefs.features, ...patch.features } }, prefs);
      if (JSON.stringify(next) !== JSON.stringify(prefs)) set({ prefs: next });
    },

    hydratePrefs(stored) {
      set({ prefs: sanitizePrefs(stored), prefsHydrated: true });
    },

    setCapabilities(patch) {
      set({ capabilities: { ...get().capabilities, ...patch } });
    },

    setLibrary(list) {
      set({ library: list === null ? null : [...list] });
    },

    upsertSummary(summary) {
      const library = get().library ?? [];
      const at = library.findIndex((p) => p.id === summary.id);
      set({ library: at >= 0 ? library.map((p, i) => (i === at ? summary : p)) : [...library, summary] });
    },

    removeSummary(projectId) {
      const { library } = get();
      if (library?.some((p) => p.id === projectId)) set({ library: library.filter((p) => p.id !== projectId) });
    },

    toast(input) {
      const kind = input.kind ?? 'info';
      const toast: Toast = {
        id: nextToastId++,
        kind,
        message: input.message,
        ...(input.key === undefined ? {} : { key: input.key }),
        ...(input.action === undefined ? {} : { action: input.action }),
        timeoutMs: input.timeoutMs ?? TOAST_TIMEOUT_MS[kind],
      };
      const others = get().toasts.filter((t) => toast.key === undefined || t.key !== toast.key);
      set({ toasts: [...others, toast].slice(-MAX_TOASTS) });
      return toast.id;
    },

    dismissToast(id) {
      const { toasts } = get();
      if (toasts.some((t) => t.id === id)) set({ toasts: toasts.filter((t) => t.id !== id) });
    },

    clearToasts() {
      if (get().toasts.length > 0) set({ toasts: [] });
    },
  }));
}

/** The app's store. */
export const appStore: AppStore = createAppStore();

/** React hook on the app's store. The selector must return a stable value (zustand 5). */
export function useAppStore<T>(selector: (state: AppState) => T): T {
  return useStore(appStore, selector);
}
