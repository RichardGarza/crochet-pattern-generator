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

  it('answers the mirror probe with 204 and x-cpg-mirror: off, so the app shows "Folder mirror off" without a console error', () => {
    for (const url of ['/__projects', '/__projects?x=1']) {
      const head = request('HEAD', url);
      expect(head.status).toBe(204);
      expect(head.headers['x-cpg-mirror']).toBe('off');
      expect(head.headers['cache-control']).toBe('no-store');
      expect(head.body).toBeUndefined();
      expect(head.passedOn).toBe(false);
    }
  });

  it('answers 503 on every other /__projects request', () => {
    for (const [method, url] of [
      ['GET', '/__projects'],
      ['PUT', '/__projects/abc/doc'],
      ['HEAD', '/__projects/abc/assets/0f'],
      ['PUT', '/__projects/abc/assets/0f'],
      ['DELETE', '/__projects/abc'],
    ] as const) {
      const got = request(method, url);
      expect(got.status).toBe(503);
      expect(got.passedOn).toBe(false);
      expect(got.headers['cache-control']).toBe('no-store');
      if (method === 'HEAD') expect(got.body).toBeUndefined();
      else expect(JSON.parse(got.body ?? '')).toEqual({ error: 'folder mirror: not implemented yet (track T8)' });
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
