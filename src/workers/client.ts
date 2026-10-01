// Worker client (DESIGN.md §5.4, D22): the main-thread half of the worker RPC. Step 0 owned.
//
// `workers` holds one typed proxy per worker. Everything is lazy: importing this module, and creating a client,
// constructs no Worker; a worker is spawned by the first call that needs it. So the module loads in the vitest
// node environment, and tests inject fake workers (`createWorkerClient({ spawn })`, `setWorkerSpawner`,
// `createFakeWorker` in src/test/fakes.ts).
//
// What a call goes through:
//   - the five job methods (`chart2d.run`, `geom.build`, `geom.projectColors`, `mesh.pathB`, `ami.generate`)
//     are latest-wins (§5.4 item 1): the caller passes the request WITHOUT `jobId`; a request that a newer one
//     replaced rejects with `Superseded`, which callers ignore (`isSuperseded`);
//   - every other method is called directly;
//   - callbacks go through `Comlink.proxy` (`ml.depth`'s `onProgress`);
//   - buffers are structured-cloned unless the caller marks the argument with `transfer(arg, [buffers])`:
//     transfer request-owned buffers (a decoded image, a mask read for this request), never one a store or the
//     viewport still holds — a transferred buffer is detached on this side;
//   - a call in flight when its worker is terminated, or crashes, rejects with `WorkerTerminated`; the next call
//     spawns a fresh worker. `ml.cancel()` is that terminate (§5.4: "terminate + respawn on cancel").
import { proxy, releaseProxy, wrap, type Endpoint, type Remote } from 'comlink';
import type { AmiRequest, AmiResult } from '../types/ami';
import type { ChartRequest, ChartResult } from '../types/chart';
import type { ReconRequest, ReconResult } from '../types/geometry';
import type { AmiApi, Chart2dApi, GeomApi, ImportApi, MeshApi, MlApi } from '../types/workers';
import { createLatestWinsGroup } from './rpc';

export { collectTransferables, isSuperseded, Superseded, transfer, transferAll } from './rpc';

/** The six workers, named after their files (`src/workers/<name>.worker.ts`). */
export type WorkerName = 'chart2d' | 'geom' | 'ml' | 'ami' | 'mesh' | 'import';

export const WORKER_NAMES: readonly WorkerName[] = ['chart2d', 'geom', 'ml', 'ami', 'mesh', 'import'];

/** What the client needs from a worker: a comlink endpoint that can be terminated. A `Worker` is one. */
export interface WorkerLike extends Endpoint {
  terminate(): void;
}

export type SpawnWorker = (name: WorkerName) => WorkerLike;

/**
 * Rejection of the calls that were in flight when their worker was terminated (`workers.terminate`,
 * `ml.cancel`) or crashed (an uncaught error in the worker, or a worker script that failed to load).
 */
export class WorkerTerminated extends Error {
  readonly worker: WorkerName;
  /** True when the worker stopped by itself (an `error` event), false for a deliberate terminate. */
  readonly crashed: boolean;

  constructor(worker: WorkerName, crashed: boolean, detail?: string) {
    super(crashed ? `the ${worker} worker crashed${detail ? `: ${detail}` : ''}` : `the ${worker} worker was terminated`);
    this.name = 'WorkerTerminated';
    this.worker = worker;
    this.crashed = crashed;
  }
}

export function isWorkerTerminated(error: unknown): error is WorkerTerminated {
  return error instanceof WorkerTerminated;
}

/**
 * The client's view of a worker API: no `supersede` (the latest-wins channels send it), and a job method
 * takes its request without `jobId` (the channel assigns it).
 */
export type ClientOf<Api> = { [K in Exclude<keyof Api, 'supersede'>]: ClientMethod<Api[K]> };

/** A method whose only parameter is a request with a `jobId` is a job method; every other method is unchanged. */
type ClientMethod<F> = F extends (...args: infer A) => infer P
  ? A extends [infer Q extends { jobId: number }]
    ? (r: Omit<Q, 'jobId'>) => P
    : F
  : F;

export type Chart2dClient = ClientOf<Chart2dApi>;
export type GeomClient = ClientOf<GeomApi>;
export type MeshClient = ClientOf<MeshApi>;
export type AmiClient = ClientOf<AmiApi>;
export type ImportClient = ClientOf<ImportApi>;
export type MlClient = ClientOf<MlApi> & {
  /**
   * Stops whatever the ml worker is doing by terminating it (an ONNX inference cannot yield); calls in
   * flight reject with `WorkerTerminated` and the next call spawns a fresh worker (§5.4).
   */
  cancel(): void;
};

export interface WorkerClient {
  readonly chart2d: Chart2dClient;
  readonly geom: GeomClient;
  readonly ml: MlClient;
  /** The editor's mesh.worker (sculpt volumes live in it). ami.worker owns a second, private instance. */
  readonly mesh: MeshClient;
  readonly ami: AmiClient;
  /** import.worker (`WorkerName` 'import'). */
  readonly importer: ImportClient;
  /**
   * Terminates one worker, or all of them: calls in flight reject with `WorkerTerminated` (a latest-wins
   * request that a newer one replaced still rejects with `Superseded`, and the newer one runs on the fresh
   * worker). The next call spawns a new worker. A worker that was never used is not created.
   */
  terminate(name?: WorkerName): void;
  /** True while a worker instance exists: it was used and has not been terminated since. */
  isRunning(name: WorkerName): boolean;
}

function spawnWorker(name: WorkerName): WorkerLike {
  if (typeof Worker === 'undefined') {
    throw new Error(
      `workers/client: there is no Worker in this environment, so the ${name} worker cannot start. ` +
        'Tests inject fakes: createWorkerClient({ spawn }) or setWorkerSpawner(spawn), with createFakeWorker(api) from src/test/fakes.ts.',
    );
  }
  // Vite finds worker entries by this exact expression, so each one is written out (§5.4).
  switch (name) {
    case 'chart2d':
      return new Worker(new URL('./chart2d.worker.ts', import.meta.url), { type: 'module' });
    case 'geom':
      return new Worker(new URL('./geom.worker.ts', import.meta.url), { type: 'module' });
    case 'ml':
      return new Worker(new URL('./ml.worker.ts', import.meta.url), { type: 'module' });
    case 'ami':
      return new Worker(new URL('./ami.worker.ts', import.meta.url), { type: 'module' });
    case 'mesh':
      return new Worker(new URL('./mesh.worker.ts', import.meta.url), { type: 'module' });
    case 'import':
      return new Worker(new URL('./import.worker.ts', import.meta.url), { type: 'module' });
  }
}

interface Instance<Api> {
  worker: WorkerLike;
  remote: Remote<Api>;
  /** Rejecters of the calls in flight. */
  inFlight: Set<(error: Error) => void>;
  onError: (event: unknown) => void;
}

interface Handle<Api> {
  /** Calls into the worker, spawning it first if needed. */
  call<R>(invoke: (api: Api) => Promise<R>): Promise<R>;
  /** Sends `supersede` to the running instance; does nothing (and spawns nothing) when there is none. */
  supersede(jobId: number): Promise<void>;
  terminate(): void;
  isRunning(): boolean;
}

function createHandle<Api extends { supersede(jobId: number): Promise<void> }>(name: WorkerName, spawn: SpawnWorker): Handle<Api> {
  let instance: Instance<Api> | null = null;

  const stop = (error: WorkerTerminated): void => {
    const old = instance;
    if (!old) return;
    instance = null;
    old.worker.removeEventListener('error', old.onError as EventListener);
    old.worker.removeEventListener('messageerror', old.onError as EventListener);
    const rejecters = [...old.inFlight];
    old.inFlight.clear();
    for (const reject of rejecters) reject(error);
    try {
      old.remote[releaseProxy]();
    } catch {
      // the endpoint is going away anyway
    }
    try {
      old.worker.terminate();
    } catch {
      // already gone
    }
  };

  const ensure = (): Instance<Api> => {
    if (instance) return instance;
    const worker = spawn(name);
    const created: Instance<Api> = {
      worker,
      remote: wrap<Api>(worker),
      inFlight: new Set(),
      onError: (event) => {
        // Only the instance that is still current can crash the handle.
        if (instance !== created) return;
        const detail = typeof event === 'object' && event !== null ? (event as { message?: unknown }).message : undefined;
        stop(new WorkerTerminated(name, true, typeof detail === 'string' ? detail : undefined));
      },
    };
    worker.addEventListener('error', created.onError as EventListener);
    worker.addEventListener('messageerror', created.onError as EventListener);
    instance = created;
    return created;
  };

  return {
    call<R>(invoke: (api: Api) => Promise<R>): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        let current: Instance<Api>;
        try {
          current = ensure();
        } catch (error) {
          reject(error);
          return;
        }
        const abort = (error: Error): void => reject(error);
        current.inFlight.add(abort);
        let result: Promise<R>;
        try {
          // Every method of the worker APIs is async and takes cloneable arguments, so the comlink proxy has
          // the API's own shape.
          result = Promise.resolve(invoke(current.remote as unknown as Api));
        } catch (error) {
          result = Promise.reject(error);
        }
        result.then(
          (value) => {
            current.inFlight.delete(abort);
            resolve(value);
          },
          (error: unknown) => {
            current.inFlight.delete(abort);
            reject(error);
          },
        );
      });
    },
    supersede(jobId: number): Promise<void> {
      const current = instance;
      if (!current) return Promise.resolve();
      return (current.remote as unknown as Api).supersede(jobId);
    },
    terminate(): void {
      stop(new WorkerTerminated(name, false));
    },
    isRunning: () => instance !== null,
  };
}

/**
 * A worker client. `spawn` creates the worker for a name on first use (default: the real module workers);
 * tests pass fakes.
 */
export function createWorkerClient(o: { spawn?: SpawnWorker } = {}): WorkerClient {
  const spawn = o.spawn ?? spawnWorker;
  const chart2d = createHandle<Chart2dApi>('chart2d', spawn);
  const geom = createHandle<GeomApi>('geom', spawn);
  const ml = createHandle<MlApi>('ml', spawn);
  const mesh = createHandle<MeshApi>('mesh', spawn);
  const ami = createHandle<AmiApi>('ami', spawn);
  const importer = createHandle<ImportApi>('import', spawn);
  const handles = { chart2d, geom, ml, mesh, ami, import: importer };

  // One latest-wins group per worker: its job methods share the worker's single gate (workers/rpc.ts).
  const chartJobs = createLatestWinsGroup((jobId) => chart2d.supersede(jobId));
  const geomJobs = createLatestWinsGroup((jobId) => geom.supersede(jobId));
  const meshJobs = createLatestWinsGroup((jobId) => mesh.supersede(jobId));
  const amiJobs = createLatestWinsGroup((jobId) => ami.supersede(jobId));

  type PathBRequest = Parameters<MeshApi['pathB']>[0];
  type PathBResult = Awaited<ReturnType<MeshApi['pathB']>>;
  type ProjectColorsRequest = Parameters<GeomApi['projectColors']>[0];
  type ProjectColorsResult = Awaited<ReturnType<GeomApi['projectColors']>>;

  return {
    chart2d: {
      run: chartJobs.channel<ChartRequest, ChartResult>((r) => chart2d.call((w) => w.run(r))),
      buildPattern: (r) => chart2d.call((w) => w.buildPattern(r)),
    },
    geom: {
      mask: (image, options) => geom.call((w) => w.mask(image, options)),
      build: geomJobs.channel<ReconRequest, ReconResult>((r) => geom.call((w) => w.build(r))),
      projectColors: geomJobs.channel<ProjectColorsRequest, ProjectColorsResult>((r) => geom.call((w) => w.projectColors(r))),
    },
    ml: {
      status: () => ml.call((w) => w.status()),
      // A plain function cannot be structured-cloned (DataCloneError): callbacks cross as comlink proxies.
      depth: (image, onProgress) => ml.call((w) => w.depth(image, onProgress ? proxy(onProgress) : undefined)),
      samEncode: (image) => ml.call((w) => w.samEncode(image)),
      samMask: (points) => ml.call((w) => w.samMask(points)),
      cancel: () => ml.terminate(),
    },
    mesh: {
      pathB: meshJobs.channel<PathBRequest, PathBResult>((r) => mesh.call((w) => w.pathB(r))),
      merge: (parts, options) => mesh.call((w) => w.merge(parts, options)),
      voxelize: (m, n, options) => mesh.call((w) => w.voxelize(m, n, options)),
      sculpt: (volumeId, stroke) => mesh.call((w) => w.sculpt(volumeId, stroke)),
      undoSculpt: (undoId) => mesh.call((w) => w.undoSculpt(undoId)),
      // Optional in MeshApi (design v1.4): a worker without it rejects the call like any unknown method.
      redoSculpt: (undoId) =>
        mesh.call((w) => w.redoSculpt?.(undoId) ?? Promise.reject(new Error('MeshApi.redoSculpt is not available in this worker'))),
      cut: (volumeId, plane) => mesh.call((w) => w.cut(volumeId, plane)),
      fit: (m) => mesh.call((w) => w.fit(m)),
      fromPart: (part, options) => mesh.call((w) => w.fromPart(part, options)),
    },
    ami: {
      generate: amiJobs.channel<AmiRequest, AmiResult>((r) => ami.call((w) => w.generate(r))),
    },
    importer: {
      importInputs: (inputs, ctx) => importer.call((w) => w.importInputs(inputs, ctx)),
    },
    terminate(name?: WorkerName): void {
      if (name) handles[name].terminate();
      else for (const key of WORKER_NAMES) handles[key].terminate();
    },
    isRunning: (name) => handles[name].isRunning(),
  };
}

let spawnOverride: SpawnWorker | null = null;

/**
 * The app's worker client. Creating it starts nothing; each worker starts with the first call that needs it.
 */
export const workers: WorkerClient = createWorkerClient({ spawn: (name) => (spawnOverride ?? spawnWorker)(name) });

/**
 * Replaces how `workers` spawns its workers (tests: `setWorkerSpawner((name) => createFakeWorker(fakes[name]))`),
 * or restores the real workers with `null`. Running workers are terminated, so the next call uses the new
 * spawner.
 */
export function setWorkerSpawner(spawn: SpawnWorker | null): void {
  workers.terminate();
  spawnOverride = spawn;
}
