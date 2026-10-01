// TEST ONLY (e2e/smoke.spec.ts, DESIGN.md §5.4 item 4 and its tests) — never imported by the app.
// Spawns the app's real mesh.worker from inside a worker, exactly as ami.worker will for Path B, and asks it
// something, so the smoke test can check that a nested module worker starts and answers under Vite.
// The page talks to this worker with plain postMessage (any message = "ask"); it answers with the result.
import { wrap } from 'comlink';
import type { MeshApi } from '../../src/types/workers';

/** Spawns mesh.worker, calls `supersede(1)` and `fit` on it, and reports what came back. */
async function ask(): Promise<{ superseded: true; fit: string }> {
  const worker = new Worker(new URL('../../src/workers/mesh.worker.ts', import.meta.url), { type: 'module' });
  const mesh = wrap<MeshApi>(worker);
  try {
    await mesh.supersede(1);
    let fit = 'resolved';
    try {
      await mesh.fit({ positions: new Float32Array(0), indices: new Uint32Array(0) } as never);
    } catch (error) {
      // The Step 0 stub rejects with NotImplementedError; T5's real fit may reject on an empty mesh.
      fit = `${(error as Error).name}: ${(error as Error).message}`;
    }
    return { superseded: true, fit };
  } finally {
    worker.terminate();
  }
}

self.onmessage = () => {
  void ask().then(
    (result) => self.postMessage(result),
    (error: unknown) => self.postMessage({ superseded: false, fit: `failed: ${String(error)}` }),
  );
};
