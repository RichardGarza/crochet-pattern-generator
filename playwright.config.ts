import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { e2ePort } from './scripts/ports.ts';

// Step 0 config (docs/DESIGN.md §5.5.4, §6.1 rule 6, §6.2 item 2). Frozen after Step 0.
//
// e2e always starts its own dev server: on its own port (5181 in the main checkout, 5290 + N in a track
// worktree, 5300–5379 by name in any other worktree, or CPG_E2E_PORT), on a fresh temp projects folder, with
// CPG_TEST=1. It never reuses a running server, never uses port 5180 and never touches the user's projects folder.

const root = fileURLToPath(new URL('.', import.meta.url));
const port = e2ePort(process.env, root);
const baseURL = `http://localhost:${port}`;

// The config is evaluated once in the runner and again in every worker process. The runner makes the fresh
// folder and hands it to its workers through the environment, so specs can inspect the same folder
// (process.env.CPG_E2E_PROJECTS_DIR). A value inherited from anywhere else is ignored.
const inWorker = process.env.TEST_WORKER_INDEX !== undefined;
const inherited = inWorker ? process.env.CPG_E2E_PROJECTS_DIR : undefined;
const projectsDir = inherited ?? fs.mkdtempSync(path.join(os.tmpdir(), 'cpg-e2e-'));
process.env.CPG_E2E_PROJECTS_DIR = projectsDir;

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  forbidOnly: !!process.env.CI,
  // Other agents may load the machine (load 25–40 on 12 cores seen; §6.1 rule 5): a test gets 90 s and a web-first
  // assertion 15 s by default. Passing assertions return at once, so only failures wait longer.
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // One worker: every spec shares the one dev server and the one projects folder, so specs run one at a time.
  workers: 1,
  fullyParallel: false,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  use: {
    baseURL,
    screenshot: 'on',
    trace: 'retain-on-failure',
  },
  // Chromium only (the installed build 1243, pinned by @playwright/test 1.63.0), at the smallest window the
  // app is designed for (§5.7: desktop first, >= 1280 × 800). Headless Chromium renders WebGL 2 through
  // SwiftShader with its default launch options.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: 'npm run dev',
    url: baseURL,
    env: { CPG_PORT: String(port), CPG_PROJECTS_DIR: projectsDir, CPG_TEST: '1' },
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
