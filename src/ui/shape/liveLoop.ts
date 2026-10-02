// Track T6.3 — the live pattern loop (DESIGN.md §4.3): every committed edit of the model, the gauge or the
// amigurumi settings sends the model to `ami.worker` (`AmiApi.generate`, T4) through the latest-wins channel of §5.4
// (the client's `workers.ami.generate`: one job in flight, one pending, a superseded job stops at its next stage),
// and the result lands in `derivedStore.ami`, keyed by the hash of its inputs. While edits keep coming (a drag, a
// slider) at most one request goes out every 300 ms, and the last state always goes out (leading + trailing).
//
// Results are cached by hash(part JSON, parent JSON, gauge, settings): the request names the parts whose hash
// changed since the last result (`dirtyParts`), so the worker regenerates only those; assembly regenerates when
// transforms change (every request carries the whole model).
//
// The loop never writes authored data: paint, regions and features stay exactly as the user made them however
// often the pattern regenerates.
//
// T4 implements `generateAmigurumi` in parallel (Sprint 3). Until the worker answers, `generate` rejects with a
// NotImplementedError: the loop then stops asking for the session and the UI says the pattern engine is not ready
// (`isImplemented` cannot see across the worker boundary, `core/stub.ts`).
import { resolveGaugeChecked } from '../../core/gauge/resolve';
import { canonicalJson, CODE_VERSION, fnv1a64Hex } from '../../core/kernel/hash';
import { isNotImplementedError } from '../../core/stub';
import { derivedStore as defaultDerived, jobOf, type DerivedStore, type DerivedState } from '../../state/derivedStore';
import { projectStore as defaultProject, type ProjectStore } from '../../state/projectStore';
import type { AmiRequest, AmiResult } from '../../types/ami';
import type { ColoredMesh } from '../../types/geometry';
import type { ProjectDoc } from '../../types/project';
import { workers } from '../../workers/client';
import { loadModelMeshes } from './meshAssets';
import { amigurumiGauge } from './yarnSize';

/** §4.3: during drags at most one request every 300 ms. */
export const LIVE_THROTTLE_MS = 300;

export interface AmiInputs {
  request: Omit<AmiRequest, 'jobId' | 'meshes'>;
  /** Hash of everything the result depends on (the derived store's key). */
  hash: string;
  /** Per part: hash(part, parent, its mesh asset, gauge, settings). */
  partHashes: Record<string, string>;
  /** Mesh parts' asset keys, by meshRef (the buffers are loaded when the request goes out). */
  meshKeys: Record<string, string>;
}

/** The inputs of `AmiApi.generate` for a document, or null (no model, or a gauge that cannot be resolved). */
export function amiInputs(doc: ProjectDoc | null | undefined): AmiInputs | null {
  const threeD = doc?.threeD;
  const model = threeD?.model;
  if (!doc || !threeD || !model) return null;
  const { gauge } = resolveGaugeChecked(amigurumiGauge(doc.gauge));
  if (!gauge) return null;
  const settings = threeD.ami;
  const meshKeys: Record<string, string> = {};
  for (const p of model.parts) {
    if (p.type !== 'mesh') continue;
    const ref = Object.hasOwn(threeD.meshAssets, p.dims.meshRef) ? threeD.meshAssets[p.dims.meshRef] : undefined;
    if (ref) meshKeys[p.dims.meshRef] = ref.key;
  }
  const shared = canonicalJson([gauge, settings]);
  const byId = new Map(model.parts.map((p) => [p.id, p]));
  const partHashes: Record<string, string> = {};
  for (const p of model.parts) {
    const parent = p.attach?.to ? (byId.get(p.attach.to) ?? null) : null;
    const mesh = p.type === 'mesh' ? (meshKeys[p.dims.meshRef] ?? null) : null;
    partHashes[p.id] = fnv1a64Hex(canonicalJson([p, parent, mesh]) + shared);
  }
  const hash = fnv1a64Hex(canonicalJson([CODE_VERSION, 'ami', model, meshKeys]) + shared);
  return { request: { model, gauge, settings }, hash, partHashes, meshKeys };
}

/** The parts to regenerate: those whose hash differs from the last result's (undefined = every part). */
export function dirtyParts(previous: Readonly<Record<string, string>> | null, next: Readonly<Record<string, string>>): string[] | undefined {
  if (!previous) return undefined;
  return Object.keys(next).filter((id) => previous[id] !== next[id]);
}

export interface LiveLoopOptions {
  project?: ProjectStore;
  derived?: DerivedStore;
  /** `AmiApi.generate` through the latest-wins channel (default: `workers.ami`). */
  ami?: { generate(r: Omit<AmiRequest, 'jobId'>): Promise<AmiResult> };
  /** The mesh parts' buffers (default: decoded from `threeD.meshAssets`). */
  meshes?: (store: ProjectStore) => Promise<Record<string, ColoredMesh>>;
  throttleMs?: number;
  /** Timers and clock (tests). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export interface LiveLoop {
  /** Stops listening and drops a pending request. */
  stop(): void;
  /** Sends the current state now if it was not sent yet (tests; also on unmount it is simply dropped). */
  flush(): void;
  /** How many requests went out. */
  readonly sent: number;
}

/** Starts the loop on the open project; the first request goes out at once. */
export function startLiveLoop(o: LiveLoopOptions = {}): LiveLoop {
  const project = o.project ?? defaultProject;
  const derived = o.derived ?? defaultDerived;
  const ami = o.ami ?? workers.ami;
  const meshes = o.meshes ?? ((store: ProjectStore) => loadModelMeshes(store));
  const throttle = o.throttleMs ?? LIVE_THROTTLE_MS;
  const setTimer = o.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = o.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const now = o.now ?? (() => performance.now());

  let lastSentAt = -Infinity;
  let lastHash: string | null = null;
  /** Part hashes of the last request that produced a result (what the worker's cache holds). */
  let resultHashes: Record<string, string> | null = null;
  let timer: unknown = null;
  let stopped = false;
  let sent = 0;
  let session = project.getState().session;

  const unavailable = (): boolean => {
    const job = jobOf(derived.getState(), 'ami');
    return job.status === 'error' && job.error?.name === 'NotImplementedError';
  };

  const send = (): void => {
    timer = null;
    if (stopped || unavailable()) return;
    const state = project.getState();
    if (state.session !== session) {
      session = state.session;
      resultHashes = null;
      lastHash = null;
    }
    const inputs = amiInputs(state.doc);
    if (!inputs || inputs.hash === lastHash) return;
    lastHash = inputs.hash;
    lastSentAt = now();
    sent++;
    const dirty = dirtyParts(resultHashes, inputs.partHashes);
    const forSession = session;
    void derived
      .getState()
      .run('ami', inputs.hash, async () => {
        const buffers = Object.keys(inputs.meshKeys).length > 0 ? await meshes(project) : {};
        const request: Omit<AmiRequest, 'jobId'> = { ...inputs.request, meshes: buffers };
        if (dirty) request.dirtyParts = dirty;
        return ami.generate(request);
      })
      .then((result) => {
        if (result && forSession === session) resultHashes = inputs.partHashes;
        const job = jobOf(derived.getState(), 'ami');
        // A failed request leaves the worker's cache unknown: the next one regenerates everything.
        if (!result && job.status === 'error' && job.inputHash === inputs.hash) {
          resultHashes = null;
          if (!isNotImplementedError(job.error)) lastHash = null;
        }
      });
  };

  const schedule = (): void => {
    if (stopped || timer !== null) return;
    const wait = Math.max(0, lastSentAt + throttle - now());
    timer = setTimer(send, wait);
  };

  const relevant = (d: ProjectDoc | null) => [d?.threeD?.model, d?.threeD?.meshAssets, d?.threeD?.ami, d?.gauge] as const;
  let seen = relevant(project.getState().doc);
  const unsubscribe = project.subscribe((state) => {
    const next = relevant(state.doc);
    if (next.every((v, i) => v === seen[i])) return;
    seen = next;
    schedule();
  });
  send();

  return {
    stop() {
      stopped = true;
      unsubscribe();
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
    flush() {
      if (timer !== null) clearTimer(timer);
      send();
    },
    get sent() {
      return sent;
    },
  };
}

// ---- what the UI shows about the loop

export type LoopStatus =
  | { kind: 'idle' }
  | { kind: 'running'; stale: boolean }
  | { kind: 'ready'; fresh: boolean }
  | { kind: 'unavailable' }
  | { kind: 'error'; message: string };

/** The loop's state for the status strip: the engine is not ready, working, up to date, or failed. */
export function loopStatus(state: DerivedState, currentHash: string | null): LoopStatus {
  const job = jobOf(state, 'ami');
  if (job.status === 'error') {
    if (job.error?.name === 'NotImplementedError') return { kind: 'unavailable' };
    return { kind: 'error', message: job.error?.message ?? 'The pattern could not be made' };
  }
  if (job.status === 'running') return { kind: 'running', stale: !!state.ami && state.ami.inputHash !== currentHash };
  if (state.ami) return { kind: 'ready', fresh: state.ami.inputHash === currentHash };
  return { kind: 'idle' };
}
