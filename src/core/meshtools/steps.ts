// Track T5 — resumable computations (DESIGN.md §5.4 item 2, §5.8 "largest synchronous stretch ≈ 50 ms").
//
// A long Path B computation is written once, as a generator that `yield`s at safe points (between stages, every few
// thousand triangles of the voxelizer, every few million flops of a Cholesky factorization). The synchronous API
// drains it (`drain`); the worker drives it with `drainAsync`, which awaits the job gate's `check` whenever a slice
// of `sliceMs` has passed since the last one, so a superseded job stops at its next check and queued messages run
// in between. Nothing here reads a clock unless a driver passes one (core code stays deterministic).

/** A computation that yields (nothing) at safe points and returns R. */
export type Steps<R> = Generator<void, R, void>;

/** Runs a resumable computation to the end, synchronously. */
export function drain<R>(g: Steps<R>): R {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

export interface DrainAsyncOptions {
  /** The gate check (`() => gate.check(jobId)`); awaited at the start, then once per slice at a yield point. */
  check: () => Promise<void>;
  /** Minimum time between two checks (ms, default 8): a check costs one macrotask hop. */
  sliceMs?: number;
  /** Clock (default `performance.now`). */
  now?: () => number;
  /** Called with the length of every synchronous stretch between two checks (diagnostics and the §5.8 perf test). */
  onStretch?: (ms: number) => void;
}

/** Default slice between two gate checks (ms). */
export const DEFAULT_SLICE_MS = 8;

/**
 * Runs a resumable computation, awaiting `check` at the start and then at the first yield point after each slice
 * (and once more before returning). A rejection of `check` (Superseded) stops the computation: the generator is
 * closed (its `finally` blocks run) and the rejection propagates.
 */
export async function drainAsync<R>(g: Steps<R>, o: DrainAsyncOptions): Promise<R> {
  const now = o.now ?? (() => performance.now());
  const slice = o.sliceMs ?? DEFAULT_SLICE_MS;
  const check = async (): Promise<void> => {
    try {
      await o.check();
    } catch (error) {
      g.return(undefined as never);
      throw error;
    }
  };
  await check();
  let last = now();
  for (;;) {
    const r = g.next();
    const t = now();
    if (r.done || t - last >= slice) {
      o.onStretch?.(t - last);
      await check();
      if (r.done) return r.value;
      last = now();
    }
  }
}
