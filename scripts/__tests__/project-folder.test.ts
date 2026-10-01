// The folder-mirror plugin of DESIGN.md §5.5.4 (T8.2): isolation rules, the /__projects protocol, write-once
// assets with a hash check, atomic writes, DELETE → Backups/deleted/, and POST /__convert. Backups, retention and
// free space: project-folder-backups.test.ts. The two-sided edit (client + server): folder-sync.test.ts.
//
// Every test works in its own temp folder and passes a fake home folder; nothing here reads or writes the
// user's ~/Documents. The decisions made with the REAL home folder are pure string checks (no file access).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodePng, encodePng } from '../../src/core/kernel/png.ts';
import { fromFn, solid } from '../../src/test/rgba.ts';
import { MAX_CONVERT_BYTES as CLIENT_MAX_CONVERT_BYTES, sniffHeifBrand } from '../../src/workers/decode.ts';
import {
  AGENT_VARIABLE,
  TEST_VARIABLES,
  backupsDirFor,
  createFolderStore,
  decideMirror,
  defaultProjectsDir,
  folderRoutes,
  gitBranch,
  isHeif,
  isProtectedFolder,
  isolationReason,
  projectFolder,
  MAX_CONVERT_BYTES,
  writeAtomic,
  type FolderStore,
  type RoutesOptions,
} from '../project-folder.ts';

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const temps: string[] = [];
const tempDir = (prefix = 'cpg-folder-test-'): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temps.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake home folder; tests assert that its Documents folder is never created. */
const fakeHome = (): string => tempDir('cpg-home-');
const documentsTouched = (home: string): boolean => fs.existsSync(path.join(home, 'Documents')) || fs.existsSync(path.join(home, 'Library'));

/** A checkout root with `.git/HEAD` naming `branch` (null: detached). */
function checkout(branch: string | null): string {
  const root = tempDir('cpg-checkout-');
  fs.mkdirSync(path.join(root, '.git'));
  fs.writeFileSync(path.join(root, '.git', 'HEAD'), branch === null ? '3f1c2a9e0b7d4c5a6e8f9a0b1c2d3e4f5a6b7c8d\n' : `ref: refs/heads/${branch}\n`);
  return root;
}

const silent = { info() {}, warn() {}, error() {} };

function docJson(id: string, rev: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ schema: 'crochet-project', version: 1, id, rev, name: `Project ${id}`, mode: '2d', createdAt: '2026-10-01T10:00:00.000Z', updatedAt: `2026-10-01T10:00:0${rev % 10}.000Z`, ...extra });
}

interface Served {
  url: string;
  store: FolderStore | null;
  close(): Promise<void>;
}

async function serve(store: FolderStore | null, o: RoutesOptions = {}): Promise<Served> {
  const routes = folderRoutes(store, { log: silent, ...o });
  const server = http.createServer((req, res) =>
    routes(req, res, () => {
      res.statusCode = 299; // "passed on" marker
      res.end('next');
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function folderStore(o: { now?: () => Date; free?: number } = {}) {
  const root = tempDir();
  const projectsDir = path.join(root, 'projects');
  const store = createFolderStore({ projectsDir, backupsDir: backupsDirFor(projectsDir), now: o.now, statfs: async () => o.free ?? 100e9, log: silent });
  return { root, projectsDir, backupsDir: backupsDirFor(projectsDir), store };
}

// ---- isolation

describe('isolation (§5.5.4): the default folder is refused for tests, agents, worktrees and other branches', () => {
  const master = () => 'master';

  it.each(TEST_VARIABLES.flatMap((v) => [[v, '1'] as const, [v, ''] as const]))('refuses the default folder when %s=%j', (variable, value) => {
    const home = fakeHome();
    const d = decideMirror({ env: { [variable]: value }, root: checkout('master'), home });
    expect(d.on).toBe(false);
    if (!d.on) {
      expect(d.reason).toContain(variable);
      expect(d.hint).toContain('CPG_PROJECTS_DIR');
    }
    expect(documentsTouched(home)).toBe(false);
  });

  it('refuses the default folder under CLAUDE_CODE_CHILD_SESSION (every agent shell), but not for CLAUDECODE alone', () => {
    const home = fakeHome();
    const root = checkout('master');
    const agent = decideMirror({ env: { [AGENT_VARIABLE]: '1', CLAUDECODE: '1' }, root, home });
    expect(agent.on).toBe(false);
    if (!agent.on) expect(agent.reason).toContain(AGENT_VARIABLE);
    const user = decideMirror({ env: { CLAUDECODE: '1' }, root, home });
    expect(user).toEqual({ on: true, projectsDir: defaultProjectsDir(home), backupsDir: path.join(home, 'Documents', 'Crochet Pattern Generator', 'Backups'), isDefault: true });
    expect(documentsTouched(home)).toBe(false); // deciding never creates the folder
  });

  it('refuses the default folder for a server root under /.claude/worktrees/', () => {
    const home = fakeHome();
    for (const root of ['/Users/x/repo/.claude/worktrees/t8-persist', '/Users/x/repo/.claude/worktrees/anything/sub', '/Users/x/repo/.Claude/Worktrees/T1-x']) {
      const d = decideMirror({ env: {}, root, home, readBranch: master });
      expect(d.on).toBe(false);
      if (!d.on) expect(d.reason).toContain('/.claude/worktrees/');
    }
    expect(documentsTouched(home)).toBe(false);
  });

  it('refuses the default folder on a branch other than master, on a detached HEAD and without a checkout', () => {
    const home = fakeHome();
    for (const [root, needle] of [
      [checkout('track/t8-persist'), 'track/t8-persist'],
      [checkout('main'), 'branch main'],
      [checkout(null), 'detached'],
      [tempDir('cpg-no-git-'), 'detached'],
    ] as const) {
      const d = decideMirror({ env: {}, root, home });
      expect(d.on, root).toBe(false);
      if (!d.on) expect(d.reason).toContain(needle);
    }
    expect(decideMirror({ env: {}, root: checkout('master'), home }).on).toBe(true);
    expect(documentsTouched(home)).toBe(false);
  });

  it('reads the branch of a worktree through its .git file (and of this checkout)', () => {
    const main = checkout('master');
    const wt = tempDir('cpg-wt-');
    fs.mkdirSync(path.join(main, '.git', 'worktrees', 'w1'), { recursive: true });
    fs.writeFileSync(path.join(main, '.git', 'worktrees', 'w1', 'HEAD'), 'ref: refs/heads/track/t9-x\n');
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'w1')}\n`);
    expect(gitBranch(wt)).toBe('track/t9-x');
    expect(gitBranch(path.join(main, 'nested', 'dir'))).toBe('master'); // walks up to the checkout
    // In a track worktree the branch is never master; in the main checkout it is, and VITEST still refuses.
    if (process.cwd().includes(`${path.sep}.claude${path.sep}worktrees${path.sep}`)) {
      expect(gitBranch(process.cwd())).not.toBe('master');
      expect(isolationReason({}, process.cwd())).not.toBeNull();
    }
    expect(isolationReason(process.env, process.cwd())).not.toBeNull();
  });

  it('refuses the REAL default folder in this very process (VITEST is set) without touching it', () => {
    // Hermetic: whatever CPG_PROJECTS_DIR the shell exported, this asks about the default folder.
    const env = { ...process.env, CPG_PROJECTS_DIR: undefined };
    const realpath = vi.fn((dir: string) => dir);
    const d = decideMirror({ env, root: process.cwd(), home: os.homedir(), realpath });
    expect(d.on).toBe(false);
    if (!d.on) expect(d.reason).toMatch(/VITEST|CPG_TEST|CLAUDE_CODE_CHILD_SESSION|PLAYWRIGHT|CI/);
    // The string check refused it: no realpath (no file access) was needed.
    expect(realpath).not.toHaveBeenCalled();
  });

  it('refuses the firmlink spelling (/System/Volumes/Data/…) and the account’s own home when $HOME points elsewhere', () => {
    const home = fakeHome();
    const real = defaultProjectsDir(home);
    const firmlink = `/System/Volumes/Data${real}`;
    expect(decideMirror({ env: { CPG_TEST: '1', CPG_PROJECTS_DIR: firmlink }, root: checkout('master'), home }).on).toBe(false);
    expect(isProtectedFolder('/System/Volumes/Data', home)).toBe(true); // an ancestor of every home
    // $HOME moved away: the account's home is still protected.
    const other = fakeHome();
    expect(decideMirror({ env: { CPG_TEST: '1', CPG_PROJECTS_DIR: real }, root: checkout('master'), home: other, otherHomes: [home] }).on).toBe(false);
    expect(decideMirror({ env: { CPG_TEST: '1', CPG_PROJECTS_DIR: real }, root: checkout('master'), home: other }).on).toBe(true);
    expect(documentsTouched(home)).toBe(false);
  });

  it('refuses CPG_PROJECTS_DIR pointing at the protected folder by any spelling, ancestor, iCloud path or symlink', () => {
    const home = fakeHome();
    const real = defaultProjectsDir(home);
    const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents', 'Crochet Pattern Generator', 'projects');
    for (const dir of [
      real,
      `${real}/`,
      real.toUpperCase().replace(home.toUpperCase(), home),
      '~/Documents/Crochet Pattern Generator/projects',
      path.join(home, 'Documents', 'Crochet Pattern Generator'),
      path.join(home, 'Documents', 'Crochet Pattern Generator', 'projects', 'sub'),
      path.join(home, 'Documents'),
      home,
      icloud,
      path.join(real, '..', 'projects'),
    ]) {
      const d = decideMirror({ env: { CPG_TEST: '1', CPG_PROJECTS_DIR: dir }, root: checkout('master'), home });
      expect(d.on, dir).toBe(false);
    }
    expect(documentsTouched(home)).toBe(false);
    // A symlink that leads into the protected folder (made here, inside the fake home).
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(tempDir(), 'innocent');
    fs.symlinkSync(real, link);
    expect(decideMirror({ env: { CPG_TEST: '1', CPG_PROJECTS_DIR: link }, root: checkout('master'), home }).on).toBe(false);
    expect(isProtectedFolder('/tmp/somewhere', home)).toBe(false);
  });

  it('runs the mirror on a folder of its own under every isolation rule', () => {
    const home = fakeHome();
    const dir = tempDir();
    for (const env of [{ CPG_TEST: '1' }, { VITEST: 'true' }, { [AGENT_VARIABLE]: '1' }, { PLAYWRIGHT: '1', CI: '1' }]) {
      const d = decideMirror({ env: { ...env, CPG_PROJECTS_DIR: dir }, root: '/r/.claude/worktrees/t8-x', home });
      expect(d).toEqual({ on: true, projectsDir: dir, backupsDir: path.join(dir, '_backups'), isDefault: false });
    }
    expect(backupsDirFor('/a/b/projects')).toBe('/a/b/Backups');
    expect(documentsTouched(home)).toBe(false);
  });

  it('the plugin, refused, answers the probe 204 + x-cpg-mirror: off and names the variable on the console', async () => {
    const home = fakeHome();
    const warnings: string[] = [];
    const plugin = projectFolder({ env: { CPG_TEST: '1' }, home });
    let middleware: ((req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) | undefined;
    const fakeServer = {
      config: { root: checkout('master'), logger: { info() {}, warn: (m: string) => warnings.push(m), error() {} } },
      middlewares: { use: (fn: typeof middleware) => (middleware = fn) },
    };
    (plugin.configureServer as (s: unknown) => void)(fakeServer);
    expect(warnings.join('\n')).toMatch(/Folder mirror off: .*CPG_TEST is set.*CPG_PROJECTS_DIR/);
    const server = http.createServer((req, res) => middleware?.(req, res, () => res.end('next')));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const head = await fetch(`${url}/__projects`, { method: 'HEAD' });
      expect(head.status).toBe(204);
      expect(head.headers.get('x-cpg-mirror')).toBe('off');
      expect((await fetch(`${url}/__projects`)).status).toBe(503);
      expect((await fetch(`${url}/__projects/p1/doc`, { method: 'PUT', body: docJson('p1', 1) })).status).toBe(503);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    expect(documentsTouched(home)).toBe(false);
  });
});

// ---- protocol

describe('/__projects protocol', () => {
  let served: Served | null = null;
  afterEach(async () => {
    await served?.close();
    served = null;
  });

  it('HEAD answers 200 + x-cpg-mirror: on; PUT, GET and list round-trip a doc', async () => {
    const f = folderStore();
    served = await serve(f.store);
    const head = await fetch(`${served.url}/__projects`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('x-cpg-mirror')).toBe('on');

    const empty = await (await fetch(`${served.url}/__projects`)).json();
    expect(empty.projects).toEqual([]);
    expect(empty.status.folder).toBe(f.projectsDir);
    expect(empty.status.backupsFolder).toBe(f.backupsDir);

    const body = docJson('p-1', 7, { name: 'Heart blanket' });
    const put = await (await fetch(`${served.url}/__projects/p-1/doc`, { method: 'PUT', body, headers: { 'x-cpg-base-sha256': 'none' } })).json();
    expect(put).toEqual({ ok: true, sha256: sha(body), written: true });
    expect(fs.readFileSync(path.join(f.projectsDir, 'p-1', 'project.json'), 'utf8')).toBe(body);

    const get = await fetch(`${served.url}/__projects/p-1/doc`);
    expect(get.status).toBe(200);
    expect(get.headers.get('x-cpg-sha256')).toBe(sha(body));
    expect(await get.text()).toBe(body);

    const list = await (await fetch(`${served.url}/__projects`)).json();
    expect(list.projects).toEqual([{ id: 'p-1', rev: 7, docSha256: sha(body), updatedAt: '2026-10-01T10:00:07.000Z', name: 'Heart blanket', mode: '2d', bytes: Buffer.byteLength(body) }]);
    expect(list.damaged).toEqual([]);
  });

  it('PUT doc is a compare-and-swap on the folder: only the doc last synced is replaced', async () => {
    const f = folderStore();
    served = await serve(f.store);
    const put = async (body: string, base?: string) =>
      (await fetch(`${served!.url}/__projects/p1/doc`, { method: 'PUT', body, headers: base === undefined ? {} : { 'x-cpg-base-sha256': base } })).json();
    const v1 = docJson('p1', 1);
    const v2 = docJson('p1', 2);
    const v3 = docJson('p1', 3);
    expect(await put(v1, 'none')).toMatchObject({ ok: true, written: true });
    // The client thinks the folder has no copy, but it has one: a conflict, nothing written.
    expect(await put(v2, 'none')).toEqual({ ok: false, reason: 'conflict', sha256: sha(v1) });
    // A wrong base: a conflict naming the folder's sha.
    expect(await put(v2, sha('something else'))).toEqual({ ok: false, reason: 'conflict', sha256: sha(v1) });
    expect(fs.readFileSync(path.join(f.projectsDir, 'p1', 'project.json'), 'utf8')).toBe(v1);
    // The right base: written.
    expect(await put(v2, sha(v1))).toEqual({ ok: true, sha256: sha(v2), written: true });
    // The same content again: ok without writing, whatever the base.
    expect(await put(v2, sha(v1))).toEqual({ ok: true, sha256: sha(v2), written: false });
    // No header: unconditional.
    expect(await put(v3)).toMatchObject({ ok: true, written: true });
    // The folder lost the project (moved away by hand): a push with a base puts it back.
    fs.rmSync(path.join(f.projectsDir, 'p1'), { recursive: true });
    expect(await put(v3, sha(v2))).toMatchObject({ ok: true, written: true });
  });

  it('refuses malformed requests and ids that could leave the folder', async () => {
    const f = folderStore();
    served = await serve(f.store);
    const u = served.url;
    expect((await fetch(`${u}/__projects/p1/doc`, { method: 'PUT', body: '{not json' })).status).toBe(400);
    expect((await fetch(`${u}/__projects/p1/doc`, { method: 'PUT', body: JSON.stringify({ schema: 'other', id: 'p1', rev: 1 }) })).status).toBe(400);
    expect((await fetch(`${u}/__projects/p1/doc`, { method: 'PUT', body: docJson('p2', 1) })).status).toBe(400);
    expect((await fetch(`${u}/__projects/p1/doc`, { method: 'PUT', body: docJson('p1', 1), headers: { 'x-cpg-base-sha256': 'abc' } })).status).toBe(400);
    for (const id of ['.hidden', '_backups', 'a%2Fb', 'a%5Cb', '%00', 'x'.repeat(201)]) {
      const r = await fetch(`${u}/__projects/${id}/doc`, { method: 'PUT', body: docJson(decodeURIComponent(id), 1) });
      expect(r.status, id).toBe(404);
    }
    // Dot segments are resolved by the URL parser before the route sees them: `/__projects/../doc` is `/doc`.
    for (const id of ['..', '%2e%2e']) {
      expect((await fetch(`${u}/__projects/${id}/doc`, { method: 'PUT', body: docJson('x', 1) })).status, id).toBe(299);
    }
    // The store refuses them anyway.
    for (const id of ['..', '.', '../x', 'a/b']) {
      await expect(f.store.writeDoc(id, Buffer.from(docJson(id, 1)), undefined)).rejects.toMatchObject({ status: 400 });
      expect(() => f.store.assetPath(id, sha('x'))).toThrow();
      await expect(f.store.remove(id)).rejects.toMatchObject({ status: 400 });
    }
    expect((await fetch(`${u}/__projects/%E0%A4%A/doc`)).status).toBe(400);
    expect((await fetch(`${u}/__projects/p1/assets/not-a-sha`, { method: 'PUT', body: 'x' })).status).toBe(404);
    expect((await fetch(`${u}/__projects/p1/doc`)).status).toBe(404);
    expect((await fetch(`${u}/__projects`, { method: 'POST' })).status).toBe(405);
    expect((await fetch(`${u}/__projects/p1`, { method: 'GET' })).status).toBe(405);
    expect(fs.readdirSync(f.root)).toEqual([]); // nothing was created
    // Other paths pass on.
    for (const p of ['/', '/index.html', '/__projectsX', '/__convert/extra', '/src/main.tsx']) expect((await fetch(`${u}${p}`)).status, p).toBe(299);
  });

  it('assets are write-once, hash-checked and listed; HEAD and GET read them', async () => {
    const f = folderStore();
    served = await serve(f.store);
    const u = served.url;
    const bytes = Buffer.from('pretend this is a PNG');
    const h = sha(bytes);
    expect((await fetch(`${u}/__projects/p1/assets/${h}`, { method: 'HEAD' })).status).toBe(404);
    expect(await (await fetch(`${u}/__projects/p1/assets`)).json()).toEqual({ assets: [] });
    expect(await (await fetch(`${u}/__projects/p1/assets/${h}`, { method: 'PUT', body: bytes })).json()).toEqual({ ok: true, existed: false });
    const file = path.join(f.projectsDir, 'p1', 'assets', h);
    const before = fs.statSync(file);
    // Again: the existing file is not rewritten (same inode, same mtime).
    expect(await (await fetch(`${u}/__projects/p1/assets/${h}`, { method: 'PUT', body: bytes })).json()).toEqual({ ok: true, existed: true });
    const after = fs.statSync(file);
    expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
    // Bytes that do not match the name: refused, nothing stored.
    const wrong = sha('other');
    const bad = await fetch(`${u}/__projects/p1/assets/${wrong}`, { method: 'PUT', body: bytes });
    expect(bad.status).toBe(422);
    expect(fs.existsSync(path.join(f.projectsDir, 'p1', 'assets', wrong))).toBe(false);
    expect(fs.readdirSync(path.join(f.projectsDir, 'p1', 'assets'))).toEqual([h]); // no temp files left
    // Read back.
    const head = await fetch(`${u}/__projects/p1/assets/${h}`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(bytes.length));
    expect(Buffer.from(await (await fetch(`${u}/__projects/p1/assets/${h}`)).arrayBuffer())).toEqual(bytes);
    expect(await (await fetch(`${u}/__projects/p1/assets`)).json()).toEqual({ assets: [h] });
    // An asset folder without a doc is not a project in the list (an interrupted first push).
    expect((await (await fetch(`${u}/__projects`)).json()).projects).toEqual([]);
  });

  it('a big asset streams through (4 MB) with its hash checked', async () => {
    const f = folderStore();
    served = await serve(f.store);
    const big = Buffer.alloc(4 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 2654435761) >>> 24;
    const h = sha(big);
    expect(await (await fetch(`${served.url}/__projects/p1/assets/${h}`, { method: 'PUT', body: big })).json()).toEqual({ ok: true, existed: false });
    expect(sha(fs.readFileSync(path.join(f.projectsDir, 'p1', 'assets', h)))).toBe(h);
  });

  it('atomic writes: a write killed half way leaves the previous doc, and its temp file is swept later', async () => {
    const root = tempDir();
    const projectsDir = path.join(root, 'projects');
    let kill = false;
    const clock = { now: new Date('2026-10-01T12:00:00') };
    const store = createFolderStore({
      projectsDir,
      backupsDir: backupsDirFor(projectsDir),
      statfs: async () => 100e9,
      now: () => new Date(clock.now),
      log: silent,
      io: {
        async writeTemp(handle, data) {
          if (!kill) {
            await handle.writeFile(data);
            return;
          }
          await handle.write(data.subarray(0, data.length >> 1)); // half the bytes reach the disk…
          throw new Error('killed'); // …then the process dies
        },
      },
    });
    const v1 = docJson('p1', 1, { notes: 'x'.repeat(5000) });
    await store.writeDoc('p1', Buffer.from(v1), null);
    kill = true;
    await expect(store.writeDoc('p1', Buffer.from(docJson('p1', 2, { notes: 'y'.repeat(5000) })), sha(v1))).rejects.toThrow('killed');
    expect(fs.readFileSync(path.join(projectsDir, 'p1', 'project.json'), 'utf8')).toBe(v1);
    expect(fs.readdirSync(path.join(projectsDir, 'p1')).sort()).toEqual(['assets', 'project.json']);

    // A real kill leaves the temp file behind: the list ignores it, and the start-up sweep removes it once stale.
    const leftover = path.join(projectsDir, 'p1', '.project.json.999.abcdef.tmp');
    fs.writeFileSync(leftover, '{"half":');
    expect((await store.list()).projects.map((p) => p.id)).toEqual(['p1']);
    await store.start();
    expect(fs.existsSync(leftover)).toBe(true); // fresh: maybe a write in flight
    clock.now = new Date('2026-10-01T14:00:00');
    fs.utimesSync(leftover, new Date('2026-10-01T12:00:00'), new Date('2026-10-01T12:00:00'));
    await store.start();
    expect(fs.existsSync(leftover)).toBe(false);
    expect(fs.readFileSync(path.join(projectsDir, 'p1', 'project.json'), 'utf8')).toBe(v1);
  });

  it('writeAtomic renames a complete temp file from the same folder into place', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'a.json');
    fs.writeFileSync(file, 'old');
    const renames: [string, string][] = [];
    const real = fs.promises.rename;
    const spy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      renames.push([String(from), String(to)]);
      expect(fs.readFileSync(String(from), 'utf8')).toBe('new content'); // complete before the rename
      expect(fs.readFileSync(file, 'utf8')).toBe('old'); // the target is untouched until then
      return real(from, to);
    });
    try {
      await writeAtomic(file, 'new content');
    } finally {
      spy.mockRestore();
    }
    expect(renames).toHaveLength(1);
    expect(path.dirname(renames[0][0])).toBe(dir);
    expect(renames[0][1]).toBe(file);
    expect(fs.readdirSync(dir)).toEqual(['a.json']);
  });

  it('DELETE moves the project folder to Backups/deleted/<id>-<YYYYMMDD-HHMMSS>/', async () => {
    const f = folderStore({ now: () => new Date('2026-10-01T14:05:09') });
    served = await serve(f.store);
    const u = served.url;
    const body = docJson('p1', 3);
    await fetch(`${u}/__projects/p1/doc`, { method: 'PUT', body });
    const asset = Buffer.from('asset');
    await fetch(`${u}/__projects/p1/assets/${sha(asset)}`, { method: 'PUT', body: asset });
    const del = await (await fetch(`${u}/__projects/p1`, { method: 'DELETE' })).json();
    const target = path.join(f.backupsDir, 'deleted', 'p1-20261001-140509');
    expect(del).toEqual({ ok: true, movedTo: target });
    expect(fs.readFileSync(path.join(target, 'project.json'), 'utf8')).toBe(body);
    expect(fs.existsSync(path.join(target, 'assets', sha(asset)))).toBe(true);
    expect(fs.existsSync(path.join(f.projectsDir, 'p1'))).toBe(false);
    expect((await (await fetch(`${u}/__projects`)).json()).projects).toEqual([]);
    // Deleting it again: nothing there.
    expect(await (await fetch(`${u}/__projects/p1`, { method: 'DELETE' })).json()).toEqual({ ok: true, movedTo: null });
    // The same id deleted twice in one second keeps both.
    await fetch(`${u}/__projects/p1/doc`, { method: 'PUT', body: docJson('p1', 4) });
    expect((await (await fetch(`${u}/__projects/p1`, { method: 'DELETE' })).json()).movedTo).toBe(`${target}-2`);
  });

  it('lists a damaged project.json as damaged and never deletes it', async () => {
    const f = folderStore();
    fs.mkdirSync(path.join(f.projectsDir, 'p1'), { recursive: true });
    fs.writeFileSync(path.join(f.projectsDir, 'p1', 'project.json'), '{"schema":"crochet-proj');
    fs.mkdirSync(path.join(f.projectsDir, 'p2'), { recursive: true });
    fs.writeFileSync(path.join(f.projectsDir, 'p2', 'project.json'), docJson('other-id', 1));
    const list = await f.store.list();
    expect(list.projects).toEqual([]);
    expect(list.damaged).toEqual(['p1', 'p2']);
    expect(fs.existsSync(path.join(f.projectsDir, 'p1', 'project.json'))).toBe(true);
  });
});

// ---- HEIC conversion

const sipsAvailable = process.platform === 'darwin' && fs.existsSync('/usr/bin/sips');

describe('POST /__convert', () => {
  let served: Served | null = null;
  afterEach(async () => {
    await served?.close();
    served = null;
  });

  it('sniffs HEIF exactly like the client (decode.ts) and has the same size limit', () => {
    const box = (major: string, compatible: string[], size?: number): Uint8Array => {
      const b = Buffer.alloc(16 + compatible.length * 4);
      b.writeUInt32BE(size ?? b.length, 0);
      b.write('ftyp', 4, 'latin1');
      b.write(major, 8, 'latin1');
      compatible.forEach((c, i) => b.write(c, 16 + i * 4, 'latin1'));
      return new Uint8Array(b);
    };
    const samples = [
      box('heic', ['mif1', 'heic']),
      box('mif1', ['heic']),
      box('msf1', []),
      box('avif', ['mif1']),
      box('mif1', ['avif']),
      box('isom', ['mp41']),
      box('isom', ['heix']),
      box('heic', [], 0),
      box('heic', ['avis'], 12),
      new Uint8Array(8),
      new Uint8Array([0, 0, 0, 24, 102, 116, 121, 113, 104, 101, 105, 99]),
    ];
    for (const s of samples) expect(isHeif(s)).toBe(sniffHeifBrand(s) !== null);
    expect(MAX_CONVERT_BYTES).toBe(CLIENT_MAX_CONVERT_BYTES);
  });

  it('off macOS answers 200 + x-cpg-convert: off with JSON "no-converter"; other methods 405', async () => {
    served = await serve(null, { platform: 'linux' });
    const r = await fetch(`${served.url}/__convert`, { method: 'POST', body: Buffer.from('ftypheic') });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-cpg-convert')).toBe('off');
    expect(await r.json()).toEqual({ converted: false, reason: 'no-converter' });
    expect((await fetch(`${served.url}/__convert`)).status).toBe(405);
  });

  it('on macOS refuses what is not HEIF (415) and what is too large (413)', async () => {
    served = await serve(null, { platform: 'darwin', maxBytes: 1000 });
    const png = Buffer.from(encodePng(solid(4, 4, [200, 10, 10])));
    expect((await fetch(`${served.url}/__convert`, { method: 'POST', body: png })).status).toBe(415);
    const avif = Buffer.alloc(32);
    avif.writeUInt32BE(24, 0);
    avif.write('ftypavif', 4, 'latin1');
    avif.write('mif1avif', 16, 'latin1');
    expect((await fetch(`${served.url}/__convert`, { method: 'POST', body: avif })).status).toBe(415);
    expect((await fetch(`${served.url}/__convert`, { method: 'POST', body: Buffer.alloc(2000) })).status).toBe(413);
  });

  it.runIf(sipsAvailable)(
    'on macOS turns a HEIC made at test time with `sips -s format heic` into a decodable JPEG',
    async () => {
      const dir = tempDir('cpg-heic-');
      // A 48 × 32 image: left half red, right half blue.
      const w = 48;
      const h = 32;
      const img = fromFn(w, h, (x) => (x < w / 2 ? [220, 30, 30] : [30, 40, 220]));
      fs.writeFileSync(path.join(dir, 'in.png'), encodePng(img));
      execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', path.join(dir, 'in.png'), '--out', path.join(dir, 'in.heic')], { stdio: 'ignore' });
      const heic = fs.readFileSync(path.join(dir, 'in.heic'));
      expect(heic.subarray(4, 8).toString('latin1')).toBe('ftyp');

      served = await serve(null, { platform: 'darwin' });
      const r = await fetch(`${served.url}/__convert`, { method: 'POST', body: heic });
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toBe('image/jpeg');
      const jpeg = Buffer.from(await r.arrayBuffer());
      expect([...jpeg.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
      // Decodable: sips reads it back as a PNG of the same size whose halves keep their colors.
      fs.writeFileSync(path.join(dir, 'out.jpg'), jpeg);
      execFileSync('/usr/bin/sips', ['-s', 'format', 'png', path.join(dir, 'out.jpg'), '--out', path.join(dir, 'out.png')], { stdio: 'ignore' });
      const back = decodePng(fs.readFileSync(path.join(dir, 'out.png')));
      expect([back.w, back.h]).toEqual([w, h]);
      const px = (x: number, y: number) => [...back.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 3)];
      const [lr, , lb] = px(8, 16);
      const [rr, , rb] = px(40, 16);
      expect(lr).toBeGreaterThan(150);
      expect(lb).toBeLessThan(100);
      expect(rb).toBeGreaterThan(150);
      expect(rr).toBeLessThan(100);
      // The temp folder of the conversion is gone.
      expect(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('cpg-convert-')).every((n) => !fs.existsSync(path.join(os.tmpdir(), n, 'input.heic')))).toBe(true);
    },
    60_000,
  );
});
