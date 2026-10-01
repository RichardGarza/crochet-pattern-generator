// Vitest setup, run before every test file (vite.config.ts → test.setupFiles). Step 0 owned.
//
// The default environment is `node` (src/core runs in workers and never sees a DOM). UI tests opt in per file
// with `// @vitest-environment happy-dom`; only then does this file do anything:
//   - React's act() environment flag is set, so state updates outside act() warn instead of passing silently;
//   - @testing-library/react is cleaned up after each test. Its automatic cleanup needs a global `afterEach`,
//     and this project does not enable Vitest globals (tests import describe/it/expect from 'vitest').
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  });
}
