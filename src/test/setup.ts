// Vitest setup, run before every test file (vite.config.ts → test.setupFiles). Step 0 owned.
//
// The default environment is `node` (src/core runs in workers and never sees a DOM). UI tests opt in per file
// with `// @vitest-environment happy-dom`; only then does this file do anything:
//   - React's act() environment flag is set, so state updates outside act() warn instead of passing silently;
//   - @testing-library/react is cleaned up after each test. Its automatic cleanup needs a global `afterEach`,
//     and this project does not enable Vitest globals (tests import describe/it/expect from 'vitest');
//   - Testing Library's `waitFor` / `findBy*` wait up to 10 s instead of 1 s: under machine load (other agents'
//     suites) a render or an IndexedDB round trip can take longer than a second (§6.1 rule 5). A condition
//     that holds returns at once, so only a failing test waits longer.
import { afterEach } from 'vitest';

if (typeof document !== 'undefined') {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const { configure } = await import('@testing-library/dom');
  configure({ asyncUtilTimeout: 10_000 });
  afterEach(async () => {
    const { cleanup } = await import('@testing-library/react');
    cleanup();
  });
}
