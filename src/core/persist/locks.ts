// Track T8 — one writer per project (DESIGN.md §5.5.2): holding a Web Lock for as long as a project is open,
// and noticing when it is stolen.
//
// `navigator.locks.request(name, options, callback)` holds the lock until the promise `callback` returns
// settles. `holdLock` turns that into a handle: `release()` lets go, and `lost` settles when the lock went away
// without a release — another tab's `{ steal: true }` makes the holder's request reject with an AbortError
// while its callback keeps running (the fakes in src/test/fakes.ts and Chromium agree on that order).
import type { LockManagerLike } from '../../types/entryPoints';

/** The lock name of a project (§5.5.2). */
export const lockName = (projectId: string): string => `project:${projectId}`;

export interface HeldLock {
  readonly name: string;
  /** Lets go of the lock (idempotent). */
  release(): void;
  /** Resolves with the reason once the lock is no longer held: released here, or stolen by another tab. */
  readonly ended: Promise<'released' | 'stolen' | 'failed'>;
  /** True until `ended` settles. */
  readonly held: () => boolean;
}

/**
 * Requests the lock and resolves with a handle once it is granted, or null when `ifAvailable` and it is
 * taken. With `steal`, the current holder loses it. Without either option it waits in the queue.
 */
export function holdLock(locks: LockManagerLike, name: string, o: { ifAvailable?: boolean; steal?: boolean } = {}): Promise<HeldLock | null> {
  return new Promise<HeldLock | null>((resolve, reject) => {
    let releaseFn: () => void = () => {};
    const releasedSignal = new Promise<void>((r) => (releaseFn = r));
    let endedResolve: (reason: 'released' | 'stolen' | 'failed') => void = () => {};
    const ended = new Promise<'released' | 'stolen' | 'failed'>((r) => (endedResolve = r));
    let isHeld = false;
    let granted = false;
    let released = false;

    const handle: HeldLock = {
      name,
      release() {
        released = true;
        releaseFn();
      },
      ended,
      held: () => isHeld,
    };

    const request = locks.request(name, o, async (lock) => {
      if (lock === null) {
        resolve(null);
        return;
      }
      granted = true;
      isHeld = true;
      resolve(handle);
      await releasedSignal;
    });
    request.then(
      () => {
        if (!granted) return;
        isHeld = false;
        endedResolve('released');
      },
      (error: unknown) => {
        if (!granted) {
          reject(error);
          return;
        }
        isHeld = false;
        // The callback is still waiting for a release that will never come: let it finish.
        releaseFn();
        const stolen = typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'AbortError';
        endedResolve(released ? 'released' : stolen ? 'stolen' : 'failed');
      },
    );
  });
}

/**
 * A lock manager for one tab, for browsers without `navigator.locks` (an insecure context, an old browser):
 * exclusive, FIFO, `ifAvailable` and `steal`, but nothing is shared with other tabs. Compare-and-swap saves
 * still keep two tabs from overwriting each other there; only the read-only mode is missing.
 */
export function createLocalLocks(): LockManagerLike {
  interface Entry {
    cb: (lock: unknown) => Promise<unknown>;
    resolve(v: unknown): void;
    reject(e: unknown): void;
  }
  const held = new Map<string, Entry>();
  const queues = new Map<string, Entry[]>();
  const abort = (): Error => {
    const e = new Error("Lock broken by another request with the 'steal' option.");
    e.name = 'AbortError';
    return e;
  };
  const grant = (name: string, entry: Entry): void => {
    held.set(name, entry);
    void Promise.resolve()
      .then(() => entry.cb({ name, mode: 'exclusive' }))
      .then(
        (v) => {
          if (held.get(name) === entry) next(name);
          entry.resolve(v);
        },
        (e: unknown) => {
          if (held.get(name) === entry) next(name);
          entry.reject(e);
        },
      );
  };
  const next = (name: string): void => {
    held.delete(name);
    const q = queues.get(name);
    const entry = q?.shift();
    if (entry) grant(name, entry);
  };
  return {
    request(name, o, cb) {
      return new Promise((resolve, reject) => {
        const entry: Entry = { cb, resolve, reject };
        queueMicrotask(() => {
          const q = queues.get(name) ?? [];
          queues.set(name, q);
          if (o.steal) {
            const victim = held.get(name);
            if (victim) {
              held.delete(name);
              victim.reject(abort());
            }
            grant(name, entry);
          } else if (held.has(name) || q.length > 0) {
            if (o.ifAvailable) Promise.resolve(cb(null)).then(resolve, reject);
            else q.push(entry);
          } else {
            grant(name, entry);
          }
        });
      });
    },
  };
}
