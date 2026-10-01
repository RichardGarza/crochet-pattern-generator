// The retry of getManifold when the failure happens inside setup() (manifoldRetry.test.ts covers a module that
// does not load). manifold-3d is replaced by a fake whose first module throws in setup(). From the independent
// review of Step 0b, which found this failure cached forever.
import { expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ modules: 0, setups: 0 }));

vi.mock('manifold-3d', () => ({
  default: () => {
    const attempt = ++calls.modules;
    return Promise.resolve({
      attempt,
      setup: () => {
        calls.setups++;
        if (attempt === 1) throw new Error('setup failed');
      },
    });
  },
}));

it('getManifold retries after a failure inside setup(), then caches the module', async () => {
  const { getManifold } = await import('../manifold');
  await expect(getManifold()).rejects.toThrow('setup failed');
  // (With `.then(onFulfilled, onRejected)` the reset never saw what onFulfilled threw.)
  const second = getManifold();
  await expect(second).resolves.toMatchObject({ attempt: 2 });
  expect(getManifold()).toBe(second);
  expect(calls.modules).toBe(2);
  expect(calls.setups).toBe(2);
});
