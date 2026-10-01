// Derived results (DESIGN.md §5.3, §5.5.5): the latest ChartResult, the 2D PatternDoc, the ReconResult preview
// and the AmiResult, each with the hash of the input that produced it, plus the state of the jobs that compute
// them. Step 0 owned.
//
// Everything here can be recomputed from the project, so it is NEVER persisted and never authored: the slices
// (state/slices/*.ts) run workers and write the results here; `projectStore` holds what the user made.
//
// "Keyed by input hash": a result is stored together with the hash of its inputs (the caller computes it,
// e.g. `fnv1a64Hex(canonicalJson(inputs) + CODE_VERSION)`, core/kernel/hash.ts). A view compares
// `entry.inputHash` with the hash of the current inputs to know whether what it shows is fresh, and `run`
// skips the work when the latest result already belongs to the same inputs. Only the result of the job that
// was started LAST for a kind is accepted: a slower, older job cannot overwrite a newer result.
//
// The app's `derivedStore` empties itself whenever `projectStore` opens or closes a project.
import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import type { AmiResult } from '../types/ami';
import type { ChartResult } from '../types/chart';
import type { ReconResult } from '../types/geometry';
import type { PatternDoc } from '../types/pattern';
import { isSuperseded } from '../workers/rpc';
import { projectStore } from './projectStore';

/** The four derived results (§5.3). */
export interface DerivedValues {
  /** The latest chart of the 2D pipeline (`Chart2dApi.run`). */
  chart: ChartResult;
  /** The 2D pattern (`Chart2dApi.buildPattern`). */
  pattern2d: PatternDoc;
  /** The preview of a reconstruction before it is committed as a model revision (`GeomApi.build`). */
  recon: ReconResult;
  /** The amigurumi engine's result, with the 3D pattern in it (`AmiApi.generate`). */
  ami: AmiResult;
}
export type DerivedKind = keyof DerivedValues;
export const DERIVED_KINDS: readonly DerivedKind[] = ['chart', 'pattern2d', 'recon', 'ami'];

export interface DerivedEntry<T> {
  /** Hash of the inputs this value was computed from. */
  inputHash: string;
  value: T;
}

export interface JobState {
  status: 'idle' | 'running' | 'done' | 'error';
  /** The inputs of the job that was started last; null while idle. */
  inputHash: string | null;
  /** 0..1 while running, when the job reports progress; else null. */
  progress: number | null;
  /** Set when `status` is 'error': the error's message and name (e.g. 'NotImplementedError'). */
  error: { name: string; message: string } | null;
}

/** A job of one of the derived kinds, or any other job a track wants to show ('depth', 'import', 'mask', …). */
export type JobName = DerivedKind | (string & {});

export const IDLE_JOB: JobState = { status: 'idle', inputHash: null, progress: null, error: null };

export interface DerivedState {
  chart: DerivedEntry<ChartResult> | null;
  pattern2d: DerivedEntry<PatternDoc> | null;
  recon: DerivedEntry<ReconResult> | null;
  ami: DerivedEntry<AmiResult> | null;
  /** Job states by name; a job that never ran has no entry (`jobOf` returns `IDLE_JOB`). */
  jobs: Record<string, JobState>;

  /** A job started for these inputs. It becomes the only job of its name whose outcome counts. */
  beginJob(name: JobName, inputHash: string): void;
  /** Progress 0..1 of the running job; ignored when `inputHash` is not the job that was started last. */
  setJobProgress(name: JobName, inputHash: string, progress: number): void;
  /** The job finished without a result to store here. False (and no change) for a job that is no longer the latest. */
  finishJob(name: JobName, inputHash: string): boolean;
  /**
   * The job failed. `Superseded` is not a failure (a newer request is on its way): it is ignored, like the
   * failure of a job that is no longer the latest. Returns whether the error was recorded.
   */
  failJob(name: JobName, inputHash: string, error: unknown): boolean;
  /** Stores a result and finishes its job. False (and no change) when a newer job was started meanwhile. */
  setResult<K extends DerivedKind>(kind: K, inputHash: string, value: DerivedValues[K]): boolean;
  /**
   * The usual shape of a slice's action: returns the stored value when it already belongs to `inputHash`
   * (a job still running for other inputs is then stale); joins the running job for the same inputs;
   * otherwise begins a job, awaits `compute`, and stores the result. Resolves with the value, or with
   * undefined when the job was superseded, failed (the error is in `jobs[kind]`), or was overtaken by a
   * newer `run`. Never rejects.
   */
  run<K extends DerivedKind>(kind: K, inputHash: string, compute: () => Promise<DerivedValues[K]>): Promise<DerivedValues[K] | undefined>;
  /** Forgets one result and its job state. */
  clear(name: JobName): void;
  /** Forgets everything (a project was opened or closed). */
  reset(): void;
}

export type DerivedStore = StoreApi<DerivedState>;

const isKind = (name: string): name is DerivedKind => (DERIVED_KINDS as readonly string[]).includes(name);

function describeError(error: unknown): { name: string; message: string } {
  if (typeof error === 'object' && error !== null) {
    const e = error as { name?: unknown; message?: unknown };
    return { name: typeof e.name === 'string' ? e.name : 'Error', message: typeof e.message === 'string' ? e.message : String(error) };
  }
  return { name: 'Error', message: String(error) };
}

/** A derived store of its own (tests). It is not connected to any project store. */
export function createDerivedStore(): DerivedStore {
  /** The promises of the jobs `run` has in flight, so a second `run` for the same inputs joins the first. */
  const running = new Map<string, { inputHash: string; promise: Promise<unknown>; token: object }>();
  /** Bumped by `reset`: a job from before the reset must not store its result after it. */
  let generation = 0;

  return createStore<DerivedState>()((set, get) => {
    const isLatest = (name: string, inputHash: string): boolean => {
      const job = get().jobs[name];
      return job !== undefined && job.status === 'running' && job.inputHash === inputHash;
    };
    const setJob = (name: string, job: JobState): void => {
      set({ jobs: { ...get().jobs, [name]: job } });
    };

    return {
      chart: null,
      pattern2d: null,
      recon: null,
      ami: null,
      jobs: {},

      beginJob(name, inputHash) {
        setJob(name, { status: 'running', inputHash, progress: null, error: null });
      },

      setJobProgress(name, inputHash, progress) {
        if (!isLatest(name, inputHash)) return;
        const clamped = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
        setJob(name, { status: 'running', inputHash, progress: clamped, error: null });
      },

      finishJob(name, inputHash) {
        if (!isLatest(name, inputHash)) return false;
        setJob(name, { status: 'done', inputHash, progress: null, error: null });
        return true;
      },

      failJob(name, inputHash, error) {
        if (isSuperseded(error) || !isLatest(name, inputHash)) return false;
        setJob(name, { status: 'error', inputHash, progress: null, error: describeError(error) });
        return true;
      },

      setResult(kind, inputHash, value) {
        const job = get().jobs[kind];
        // A result may also arrive without a job (a slice that computes synchronously): then it simply is the latest.
        if (job && job.status === 'running' && job.inputHash !== inputHash) return false;
        set({
          [kind]: { inputHash, value },
          jobs: { ...get().jobs, [kind]: { status: 'done', inputHash, progress: null, error: null } },
        } as Partial<DerivedState>);
        return true;
      },

      run<K extends DerivedKind>(kind: K, inputHash: string, compute: () => Promise<DerivedValues[K]>): Promise<DerivedValues[K] | undefined> {
        const state = get();
        const entry = state[kind] as DerivedEntry<DerivedValues[K]> | null;
        const job = state.jobs[kind];
        const runningThese = job !== undefined && job.status === 'running' && job.inputHash === inputHash;
        if (entry && entry.inputHash === inputHash && !runningThese) {
          // The newest request is already answered. A job that is still running for other inputs is now stale.
          if (!job || job.status !== 'done' || job.inputHash !== inputHash) setJob(kind, { status: 'done', inputHash, progress: null, error: null });
          return Promise.resolve(entry.value);
        }
        const joined = running.get(kind);
        if (joined && joined.inputHash === inputHash && runningThese) return joined.promise as Promise<DerivedValues[K] | undefined>;

        get().beginJob(kind, inputHash);
        const startedIn = generation;
        const token = {};
        const promise = (async (): Promise<DerivedValues[K] | undefined> => {
          try {
            const value = await compute();
            // Only the job that was started last may store its result.
            if (generation !== startedIn || !isLatest(kind, inputHash)) return undefined;
            get().setResult(kind, inputHash, value);
            return value;
          } catch (error) {
            if (generation !== startedIn || !isLatest(kind, inputHash)) return undefined;
            // Superseded by a request that did not come through `run`: there is no result and no failure.
            if (isSuperseded(error)) setJob(kind, IDLE_JOB);
            else get().failJob(kind, inputHash, error);
            return undefined;
          } finally {
            if (running.get(kind)?.token === token) running.delete(kind);
          }
        })();
        running.set(kind, { inputHash, promise, token });
        return promise;
      },

      clear(name) {
        const jobs = { ...get().jobs };
        delete jobs[name];
        running.delete(name);
        set(isKind(name) ? ({ [name]: null, jobs } as Partial<DerivedState>) : { jobs });
      },

      reset() {
        generation++;
        running.clear();
        set({ chart: null, pattern2d: null, recon: null, ami: null, jobs: {} });
      },
    };
  });
}

/** The job state of `name`; `IDLE_JOB` when it never ran. */
export const jobOf = (state: DerivedState, name: JobName): JobState => state.jobs[name] ?? IDLE_JOB;

/** True when the stored result of `kind` was computed from exactly these inputs. */
export const isFresh = (state: DerivedState, kind: DerivedKind, inputHash: string): boolean => state[kind]?.inputHash === inputHash;

/** The app's derived store. */
export const derivedStore: DerivedStore = createDerivedStore();

// Derived data belongs to the open project: another project (or none) starts empty. `session` changes on every
// open and close; a conflict copy (`rebind`) keeps the session, and its derived data with it.
projectStore.subscribe((state, previous) => {
  if (state.session !== previous.session) derivedStore.getState().reset();
});

/** React hook on the app's derived store. The selector must return a stable value (zustand 5). */
export function useDerivedStore<T>(selector: (state: DerivedState) => T): T {
  return useStore(derivedStore, selector);
}
