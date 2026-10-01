// Step 0 stubs (DESIGN.md §5.2.1, §6.1 rule 4).
//
// Every cross-track entry point starts life as a typed stub that carries `__stub: true` and throws
// NotImplementedError when called. A track replaces the stub with the real function (same signature, no
// `__stub`). Tests that need another track's implementation are gated with `it.runIf(isImplemented(fn))`;
// integration removes the gates.
//
// Across a worker boundary both halves of that contract change, because comlink proxies every property and
// rebuilds errors as plain `Error`s: use `isImplemented` only on functions imported in the same thread (never
// on a comlink proxy or its methods), and recognize a stub's rejection with `isNotImplementedError`.

export class NotImplementedError extends Error {
  /** Name of the entry point that was called. */
  readonly fn: string;

  constructor(fn: string) {
    super(`${fn} not implemented`);
    this.name = 'NotImplementedError';
    this.fn = fn;
  }
}

/**
 * A typed placeholder for `F`. Calling it throws NotImplementedError — synchronously, also when `F` returns a
 * promise.
 */
export function stub<F extends (...a: never[]) => unknown>(name: string): F & { __stub: true } {
  const fn = (): never => {
    throw new NotImplementedError(name);
  };
  Object.defineProperty(fn, 'name', { value: name });
  return Object.assign(fn, { __stub: true as const }) as unknown as F & { __stub: true };
}

/**
 * True for a real function (or component); false for a stub (`fn.__stub === true`) and for anything that is
 * not callable. Same thread only: a comlink proxy answers every property read with another proxy, so this
 * check says nothing about what runs inside a worker.
 */
export function isImplemented(fn: unknown): boolean {
  if (typeof fn !== 'function' && (typeof fn !== 'object' || fn === null)) return false;
  return (fn as { __stub?: unknown }).__stub !== true;
}

/**
 * True for a NotImplementedError, also after it has crossed a worker boundary: comlink rebuilds a thrown error
 * as a plain `Error` that keeps only `name`, `message` and `stack`, so `instanceof` fails there and `fn` is
 * gone.
 */
export function isNotImplementedError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'NotImplementedError';
}
