import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfigFromFile, resolveConfig } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';
import { AGENT_PORT, devPort, E2E_PORT, e2ePort, guardPort, isGuarded, isWorktreeRoot, portGuard, trackNumber, USER_PORT } from '../ports.ts';

const MAIN = '/Users/someone/projects/crochet-pattern-generator/';
const worktree = (name: string): string => `/Users/someone/projects/crochet-pattern-generator/.claude/worktrees/${name}/`;

describe('trackNumber and isWorktreeRoot', () => {
  it('reads N from .claude/worktrees/t<N>-…', () => {
    expect(trackNumber(worktree('t1-image2d'))).toBe(1);
    expect(trackNumber(worktree('t8-persist'))).toBe(8);
    expect(trackNumber(worktree('t3-photos').replace(/\/$/, ''))).toBe(3);
    expect(trackNumber(`${worktree('t5-mesh')}src/core`)).toBe(5);
    expect(trackNumber(worktree('t7'))).toBe(7);
    expect(trackNumber(String.raw`C:\repo\.claude\worktrees\t4-ami`)).toBe(4);
    // The disk ignores case, so a differently spelled path is the same worktree.
    expect(trackNumber('/Users/someone/projects/cpg/.Claude/Worktrees/T6-editor/')).toBe(6);
  });

  it('gives undefined outside a track worktree', () => {
    expect(trackNumber(MAIN)).toBeUndefined();
    expect(trackNumber(worktree('s0b-shell'))).toBeUndefined();
    expect(trackNumber(worktree('tmp'))).toBeUndefined();
    expect(trackNumber(worktree('track3'))).toBeUndefined();
    expect(trackNumber('/Users/someone/projects/t3-photos/')).toBeUndefined();
  });

  it('recognizes any worktree root', () => {
    expect(isWorktreeRoot(MAIN)).toBe(false);
    expect(isWorktreeRoot(worktree('t2-pattern'))).toBe(true);
    expect(isWorktreeRoot(worktree('throw-away'))).toBe(true);
    expect(isWorktreeRoot('/Users/someone/projects/crochet-pattern-generator/.claude/')).toBe(false);
    expect(isWorktreeRoot('/Users/someone/projects/cpg/.CLAUDE/WORKTREES/x/')).toBe(true);
  });
});

describe('devPort (npm run dev / preview)', () => {
  it('is 5180 for the user in the main checkout', () => {
    expect(USER_PORT).toBe(5180);
    expect(devPort({}, MAIN)).toBe(5180);
    expect(devPort({ CLAUDECODE: '1' }, MAIN)).toBe(5180); // the user's own interactive session sets only this
    expect(devPort({ CPG_PORT: '' }, MAIN)).toBe(5180);
  });

  it('honors CPG_PORT', () => {
    expect(devPort({ CPG_PORT: '6001' }, MAIN)).toBe(6001);
    expect(devPort({ CPG_PORT: '5181', CPG_TEST: '1' }, MAIN)).toBe(5181);
    expect(devPort({ CPG_PORT: '5199' }, worktree('t3-photos'))).toBe(5199);
  });

  it('is 5190 + N in a track worktree', () => {
    for (let n = 1; n <= 8; n++) {
      expect(devPort({}, worktree(`t${n}-x`))).toBe(5190 + n);
      expect(devPort({ CPG_TEST: '1', CLAUDE_CODE_CHILD_SESSION: '1' }, worktree(`t${n}-x`))).toBe(5190 + n);
    }
  });

  it('is 5199 in any other worktree', () => {
    expect(devPort({}, worktree('throw-away'))).toBe(AGENT_PORT);
    expect(devPort({}, worktree('s0b-shell'))).toBe(5199);
  });

  it('never returns 5180 under CLAUDE_CODE_CHILD_SESSION — 5199 instead, even if CPG_PORT=5180 is passed', () => {
    expect(devPort({ CLAUDE_CODE_CHILD_SESSION: '1' }, MAIN)).toBe(5199);
    expect(devPort({ CLAUDE_CODE_CHILD_SESSION: '1', CPG_PORT: '5180' }, MAIN)).toBe(5199);
    expect(devPort({ CLAUDE_CODE_CHILD_SESSION: 'true', CLAUDECODE: '1' }, MAIN)).toBe(5199);
    expect(devPort({ CLAUDE_CODE_CHILD_SESSION: '0' }, MAIN)).toBe(5199); // set at all = an agent shell
    expect(devPort({ CLAUDE_CODE_CHILD_SESSION: '' }, MAIN)).toBe(5199); // even when set to nothing
  });

  it('never returns 5180 under CPG_TEST', () => {
    expect(devPort({ CPG_TEST: '1' }, MAIN)).toBe(5199);
    expect(devPort({ CPG_TEST: '1', CPG_PORT: '5180' }, MAIN)).toBe(5199);
    expect(devPort({ CPG_TEST: '' }, MAIN)).toBe(5199); // `CPG_TEST= npm run dev` still counts as set
    expect(devPort({ CPG_TEST: '0', CPG_PORT: ' 5180 ' }, MAIN)).toBe(5199);
  });

  it('never returns 5180 in a worktree, whatever is passed', () => {
    expect(devPort({ CPG_PORT: '5180' }, worktree('t2-pattern'))).toBe(5199);
    expect(devPort({ CPG_PORT: '5180' }, worktree('throw-away'))).toBe(5199);
  });

  it('never returns 5180 for any guarded combination', () => {
    const roots = [MAIN, worktree('t1-a'), worktree('t8-b'), worktree('other')];
    const ports = [undefined, '', '5180', '5181', '5199', '5193', '8080'];
    const flags = [undefined, '', '1'];
    for (const root of roots) {
      for (const CPG_PORT of ports) {
        for (const CPG_TEST of flags) {
          for (const CLAUDE_CODE_CHILD_SESSION of flags) {
            const env = { CPG_PORT, CPG_TEST, CLAUDE_CODE_CHILD_SESSION };
            const guarded = CPG_TEST !== undefined || CLAUDE_CODE_CHILD_SESSION !== undefined || root !== MAIN;
            expect(isGuarded(env, root)).toBe(guarded);
            const port = devPort(env, root);
            if (guarded) expect(port).not.toBe(5180);
            else if (CPG_PORT === '5180' || !CPG_PORT) expect(port).toBe(5180);
            expect(guardPort(5180, env, root)).toBe(guarded ? 5199 : 5180);
            expect(guardPort(6001, env, root)).toBe(6001);
            expect(Number.isInteger(port) && port > 0 && port < 65536).toBe(true);
          }
        }
      }
    }
  });

  it('rejects a CPG_PORT that is not a port', () => {
    for (const bad of ['abc', '0', '-1', '70000', '51.5', '5180x']) {
      expect(() => devPort({ CPG_PORT: bad }, MAIN)).toThrow(/CPG_PORT/);
    }
  });
});

describe('e2ePort (Playwright)', () => {
  it('is 5181 in the main checkout and 5290 + N in a track worktree', () => {
    expect(E2E_PORT).toBe(5181);
    expect(e2ePort({}, MAIN)).toBe(5181);
    expect(e2ePort({}, worktree('t3-photos'))).toBe(5293);
    expect(e2ePort({}, worktree('t7-claude-design'))).toBe(5297);
    expect(e2ePort({}, worktree('throw-away'))).toBe(5181);
  });

  it('honors CPG_E2E_PORT', () => {
    expect(e2ePort({ CPG_E2E_PORT: '5300' }, MAIN)).toBe(5300);
    expect(e2ePort({ CPG_E2E_PORT: '5300' }, worktree('t3-photos'))).toBe(5300);
  });

  it('refuses the user origin and garbage', () => {
    expect(() => e2ePort({ CPG_E2E_PORT: '5180' }, MAIN)).toThrow(/5180/);
    expect(() => e2ePort({ CPG_E2E_PORT: 'x' }, MAIN)).toThrow(/CPG_E2E_PORT/);
  });
});

describe('vite.config.ts', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const configFile = path.join(root, 'vite.config.ts');
  const KEYS = ['CLAUDE_CODE_CHILD_SESSION', 'CPG_TEST', 'CPG_PORT'] as const;
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  type Env = Partial<Record<(typeof KEYS)[number], string>>;
  function setEnv(env: Env): void {
    for (const key of KEYS) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
  }

  /** The config file as written (no plugins run). */
  async function load(env: Env) {
    setEnv(env);
    const loaded = await loadConfigFromFile({ command: 'serve', mode: 'development' }, configFile, root, 'silent');
    if (!loaded) throw new Error('vite.config.ts did not load');
    return loaded.config;
  }

  /** The final config, as `vite [--port N] [--strictPort false]` would resolve it. Nothing is served. */
  async function resolve(env: Env, cli: { port?: number; strictPort?: boolean }, preview = false) {
    setEnv(env);
    const inline = preview ? { preview: cli } : { server: cli };
    return resolveConfig({ root, configFile, logLevel: 'silent', ...inline }, 'serve', 'development', 'development', preview);
  }

  // This test also runs inside track worktrees, where the default port is 5190 + N: every expectation is
  // computed for this checkout's own root.
  const GUARDED: Env[] = [
    { CLAUDE_CODE_CHILD_SESSION: '1' },
    { CLAUDE_CODE_CHILD_SESSION: '1', CPG_PORT: '5180' },
    { CPG_TEST: '1', CPG_PORT: '5180' },
    { CPG_TEST: '' },
  ];

  it('never configures 5180 when CLAUDE_CODE_CHILD_SESSION or CPG_TEST is set (dev and preview, strictPort)', async () => {
    for (const env of GUARDED) {
      const expected = devPort(env, root);
      expect(expected).not.toBe(5180);
      const config = await load(env);
      expect(config.server?.port).toBe(expected);
      expect(config.server?.strictPort).toBe(true);
      expect(config.preview?.port).toBe(expected);
      expect(config.preview?.strictPort).toBe(true);
    }
    // In the main checkout the guarded port is 5199 (in a worktree it is that worktree's own port).
    if (!isWorktreeRoot(root)) expect(devPort({ CLAUDE_CODE_CHILD_SESSION: '1' }, root)).toBe(5199);
  });

  it('command-line options cannot get around the rule: --port 5180 becomes 5199, strictPort stays on', async () => {
    for (const env of GUARDED) {
      const dev = await resolve(env, { port: 5180, strictPort: false });
      expect(dev.server.port).toBe(5199);
      expect(dev.server.strictPort).toBe(true);
      const preview = await resolve(env, { port: 5180, strictPort: false }, true);
      expect(preview.preview.port).toBe(5199);
      expect(preview.preview.strictPort).toBe(true);
    }
    // Other ports asked for on the command line are honored, with strictPort forced on.
    const other = await resolve({ CPG_TEST: '1' }, { port: 5179, strictPort: false });
    expect(other.server.port).toBe(5179);
    expect(other.server.strictPort).toBe(true);
  });

  it('portGuard refuses a configuration that would still serve on 5180 while guarded', () => {
    const plugin = portGuard({ CPG_TEST: '1' }, root);
    const check = plugin.configResolved as (config: unknown) => void;
    const ok = { server: { port: 5199, strictPort: true }, preview: { port: 5199, strictPort: true } };
    expect(() => check(ok)).not.toThrow();
    expect(() => check({ ...ok, server: { port: 5180, strictPort: true } })).toThrow(/user's own origin/);
    expect(() => check({ ...ok, preview: { port: 5180, strictPort: true } })).toThrow(/user's own origin/);
    expect(() => check({ ...ok, server: { port: 5199, strictPort: false } })).toThrow(/strictPort/);
    // Unguarded (the user's own shell in the main checkout), 5180 is the right port.
    const mainRoot = '/Users/someone/projects/crochet-pattern-generator/';
    const userCheck = portGuard({}, mainRoot).configResolved as (config: unknown) => void;
    expect(() => userCheck({ server: { port: 5180, strictPort: true }, preview: { port: 5180, strictPort: true } })).not.toThrow();
  });

  it('carries the Step 0 settings of §6.2 item 2', async () => {
    const config = await load({ CPG_TEST: '1' });
    expect(config.worker?.format).toBe('es');
    expect(config.assetsInclude).toEqual(['**/*.wasm']);
    expect(config.optimizeDeps?.entries).toEqual(['index.html', 'src/workers/*.worker.ts']);
    expect(config.optimizeDeps?.exclude).toEqual(['manifold-3d']);
    const names = (config.plugins ?? []).flat().map((p) => (p && typeof p === 'object' && 'name' in p ? p.name : ''));
    expect(names).toContain('cpg:project-folder');
    expect(names).toContain('cpg:port-guard');

    // The watcher ignores are anchored to this project root: paths under <root>/.claude, fixtures and
    // test-results are ignored, the project's own sources are not — also when the root itself is a worktree.
    const ignored = config.server?.watch?.ignored as (p: string) => boolean;
    expect(typeof ignored).toBe('function');
    expect(ignored(path.join(root, '.claude', 'worktrees', 't1-x', 'src', 'main.tsx'))).toBe(true);
    expect(ignored(path.join(root, 'fixtures', 'claude-design', 'teddy-bear', 'x.html'))).toBe(true);
    expect(ignored(path.join(root, 'test-results', 'a.png'))).toBe(true);
    expect(ignored(path.join(root, 'src', 'main.tsx'))).toBe(false);
    expect(ignored(path.join(root, 'index.html'))).toBe(false);

    const test = (config as { test?: { environment?: string; exclude?: string[]; setupFiles?: string[] } }).test;
    expect(test?.environment).toBe('node');
    expect(test?.exclude).toEqual(expect.arrayContaining(['.claude/**', 'e2e/**', '**/node_modules/**']));
    expect(test?.setupFiles).toEqual(['./src/test/setup.ts']);
  });
});
