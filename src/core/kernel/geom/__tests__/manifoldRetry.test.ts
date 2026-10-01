import { expect, it, vi } from 'vitest';

// The loader caches its promise. This file replaces manifold-3d with a module whose first initialization
// fails, to check that a failure is not cached forever.
const calls = vi.hoisted(() => ({ count: 0, configs: [] as unknown[] }));

vi.mock('manifold-3d', () => ({
  default: (config?: unknown) => {
    calls.count++;
    calls.configs.push(config);
    if (calls.count === 1) return Promise.reject(new Error('wasm did not load'));
    return Promise.resolve({ setup: () => calls.configs.push('setup') });
  },
}));

it('getManifold retries after a failed initialization, then caches the module', async () => {
  const { getManifold } = await import('../manifold');
  await expect(getManifold()).rejects.toThrow('wasm did not load');
  const second = getManifold();
  const third = getManifold();
  expect(third).toBe(second);
  const module = await second;
  expect(await third).toBe(module);
  expect(calls.count).toBe(2);
  // In node the module is initialized without `locateFile` (Emscripten finds the wasm next to its module),
  // and setup() runs exactly once per successful initialization.
  expect(calls.configs).toEqual([undefined, undefined, 'setup']);
});
