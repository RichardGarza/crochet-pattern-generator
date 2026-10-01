import { describe, expect, it } from 'vitest';
import { isImplemented, isNotImplementedError, NotImplementedError, stub } from '../stub';

describe('stub', () => {
  it('throws NotImplementedError naming the entry point', () => {
    const f = stub<(a: number, b: string) => string>('core/x.doThing');
    expect(() => f(1, 'a')).toThrow(NotImplementedError);
    expect(() => f(1, 'a')).toThrow('core/x.doThing not implemented');
    try {
      f(1, 'a');
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as NotImplementedError).fn).toBe('core/x.doThing');
      expect((e as NotImplementedError).name).toBe('NotImplementedError');
    }
  });

  it('throws synchronously even when the real function is async', () => {
    const f = stub<(x: number) => Promise<number>>('asyncThing');
    expect(() => f(1)).toThrow(NotImplementedError);
  });

  it('carries __stub: true and the given name', () => {
    const f = stub<() => void>('named');
    expect(f.__stub).toBe(true);
    expect(f.name).toBe('named');
    expect(typeof f).toBe('function');
  });
});

describe('isImplemented', () => {
  it('is false for stubs and true for real functions', () => {
    expect(isImplemented(stub<() => void>('s'))).toBe(false);
    expect(isImplemented(() => 1)).toBe(true);
    expect(isImplemented(function named() {})).toBe(true);
  });

  it('handles components: a function marked __stub is a stub, an exotic component object is real', () => {
    const StubComponent = Object.assign(() => null, { __stub: true as const });
    expect(isImplemented(StubComponent)).toBe(false);
    expect(isImplemented({ $$typeof: Symbol.for('react.memo') })).toBe(true);
    expect(isImplemented({ $$typeof: Symbol.for('react.lazy'), __stub: true })).toBe(false);
  });

  it('is false for things that cannot be called at all', () => {
    expect(isImplemented(undefined)).toBe(false);
    expect(isImplemented(null)).toBe(false);
    expect(isImplemented(42)).toBe(false);
    expect(isImplemented('runChart')).toBe(false);
  });

  it('gates tests with it.runIf', () => {
    const gated = stub<() => number>('gated');
    let ran = false;
    if (isImplemented(gated)) ran = true;
    expect(ran).toBe(false);
  });
});

describe('isNotImplementedError', () => {
  it('recognizes the error by name, so it still works after comlink has rebuilt it', () => {
    const original = new NotImplementedError('Chart2dApi.run');
    expect(isNotImplementedError(original)).toBe(true);
    // what arrives on the main thread: Object.assign(new Error(message), { name, message, stack })
    const rebuilt = Object.assign(new Error(original.message), { name: original.name, message: original.message, stack: original.stack });
    expect(rebuilt).not.toBeInstanceOf(NotImplementedError);
    expect(isNotImplementedError(rebuilt)).toBe(true);
    expect(rebuilt.message).toBe('Chart2dApi.run not implemented');
  });

  it('is false for other errors and for values that are not errors', () => {
    expect(isNotImplementedError(new Error('boom'))).toBe(false);
    expect(isNotImplementedError(new TypeError('NotImplementedError'))).toBe(false);
    expect(isNotImplementedError('NotImplementedError')).toBe(false);
    expect(isNotImplementedError(undefined)).toBe(false);
    expect(isNotImplementedError(null)).toBe(false);
  });
});

describe('isImplemented on proxies', () => {
  it('treats only `__stub === true` as a stub, so a truthy-but-not-true value does not count', () => {
    expect(isImplemented(Object.assign(() => 1, { __stub: 'yes' }))).toBe(true);
    expect(isImplemented(Object.assign(() => 1, { __stub: true }))).toBe(false);
  });
});

describe('NotImplementedError', () => {
  it('is an Error with a stable message format', () => {
    const e = new NotImplementedError('runChart');
    expect(e).toBeInstanceOf(Error);
    expect(e.message).toBe('runChart not implemented');
    expect(e.fn).toBe('runChart');
  });
});
