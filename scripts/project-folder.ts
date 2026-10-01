// Track T8 (DESIGN.md §5.5.4): the Vite plugin that mirrors projects into a folder (`/__projects`), keeps backups
// and converts HEIC photos (`POST /__convert`) on the dev and preview servers.
//
// Step 0 stub. It touches no folder at all: it only answers the two routes the app probes, so that the app sees
// "Folder mirror off" and "no HEIC conversion" instead of Vite's index.html fallback (which answers 200):
//   HEAD /__projects             → 204 + `x-cpg-mirror: off`   (the app's probe; the same answer the real plugin gives
//                                          when it refuses the default folder under the isolation rules of §5.5.4.
//                                          Not 503: Chromium logs a console error for every answer ≥ 400)
//   any other /__projects/**     → 503   (nothing should call these while the mirror is off)
//   /__convert                   → 501   (no converter; §2.3.1 keeps the "export it as JPEG" message)
//
// T8 replaces the body of this file. The ports are not T8's: they live in scripts/ports.ts (Step 0).

import type { Connect, Plugin } from 'vite';

const STUB_MESSAGE = 'not implemented yet (track T8)';

/** Response header of the mirror probe (`HEAD /__projects`): `on` or `off` (§5.5.4). */
export const MIRROR_HEADER = 'x-cpg-mirror';

function answer(res: Parameters<Connect.NextHandleFunction>[1], method: string | undefined, status: number, feature: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(method === 'HEAD' ? undefined : JSON.stringify({ error: `${feature}: ${STUB_MESSAGE}` }));
}

/** Exported for the Step 0 test; T8 owns the real routes. */
export const stubRoutes: Connect.NextHandleFunction = (req, res, next) => {
  const pathname = (req.url ?? '').split('?')[0];
  if (pathname === '/__projects' && req.method === 'HEAD') {
    res.statusCode = 204;
    res.setHeader(MIRROR_HEADER, 'off');
    res.setHeader('Cache-Control', 'no-store');
    res.end();
    return;
  }
  if (pathname === '/__projects' || pathname.startsWith('/__projects/')) {
    answer(res, req.method, 503, 'folder mirror');
    return;
  }
  if (pathname === '/__convert') {
    answer(res, req.method, 501, 'HEIC conversion');
    return;
  }
  next();
};

function projectFolderStub(): Plugin {
  return {
    name: 'cpg:project-folder',
    configureServer(server) {
      server.middlewares.use(stubRoutes);
    },
    configurePreviewServer(server) {
      server.middlewares.use(stubRoutes);
    },
  };
}

/** `isImplemented(projectFolder)` is false until T8 replaces the stub (src/core/stub.ts). */
export const projectFolder: (() => Plugin) & { __stub: true } = Object.assign(projectFolderStub, { __stub: true as const });
