import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { projectFolder, stubRoutes } from '../project-folder.ts';

interface Answer {
  status: number;
  headers: Record<string, string>;
  body: string | undefined;
  passedOn: boolean;
}

/** Runs the middleware on a fake request and records what it did. */
function request(method: string, url: string): Answer {
  const answer: Answer = { status: 200, headers: {}, body: undefined, passedOn: false };
  const res = {
    set statusCode(code: number) {
      answer.status = code;
    },
    setHeader(name: string, value: string) {
      answer.headers[name.toLowerCase()] = value;
    },
    end(body?: string) {
      answer.body = body;
    },
  };
  stubRoutes({ method, url } as IncomingMessage, res as unknown as ServerResponse, () => {
    answer.passedOn = true;
  });
  return answer;
}

// These tests describe the Step 0 stub only. T8 owns scripts/project-folder.ts and replaces this file with the
// plugin tests of DESIGN.md §5.5.4.
describe('projectFolder (Step 0 stub of the T8 plugin)', () => {
  it('is a Vite plugin marked as a stub, with dev and preview hooks', () => {
    expect(projectFolder.__stub).toBe(true);
    const plugin = projectFolder();
    expect(plugin.name).toBe('cpg:project-folder');
    expect(typeof plugin.configureServer).toBe('function');
    expect(typeof plugin.configurePreviewServer).toBe('function');
  });

  it('answers 503 on /__projects so the app shows "Folder mirror off"', () => {
    for (const url of ['/__projects', '/__projects?x=1', '/__projects/abc/doc', '/__projects/abc/assets/0f']) {
      const head = request('HEAD', url);
      expect(head.status).toBe(503);
      expect(head.body).toBeUndefined();
      expect(head.passedOn).toBe(false);
      const put = request('PUT', url);
      expect(put.status).toBe(503);
      expect(JSON.parse(put.body ?? '')).toEqual({ error: 'folder mirror: not implemented yet (track T8)' });
      expect(put.headers['cache-control']).toBe('no-store');
    }
  });

  it('answers 501 on /__convert so HEIC photos keep the "export it as JPEG" message', () => {
    const post = request('POST', '/__convert');
    expect(post.status).toBe(501);
    expect(JSON.parse(post.body ?? '')).toEqual({ error: 'HEIC conversion: not implemented yet (track T8)' });
    expect(post.passedOn).toBe(false);
  });

  it('passes every other request on untouched', () => {
    for (const url of ['/', '/index.html', '/src/main.tsx', '/__projectsX', '/__convert/extra', '/ort/ort-wasm-simd-threaded.asyncify.wasm']) {
      const got = request('GET', url);
      expect(got.passedOn).toBe(true);
      expect(got.status).toBe(200);
      expect(got.body).toBeUndefined();
    }
  });
});
