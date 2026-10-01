// Dev, preview and e2e ports (DESIGN.md §5.5.4, §6.1 rule 6, §6.2 items 1–2). Step 0 owned.
//
// IndexedDB is per origin, so the user's dev and preview servers always run on one fixed port (5180): a new
// port would look like data loss. For the same reason nothing an agent, a test or a track worktree starts may
// ever answer on that origin — an open tab of the user's would load in-development code against the user's
// IndexedDB. vite.config.ts and playwright.config.ts both take their port from here, and `portGuard` applies
// the same rule to the final Vite configuration, so a command-line `--port 5180` cannot get around it.
import type { Plugin } from 'vite';

/** The user's origin: dev and preview servers of the main checkout. */
export const USER_PORT = 5180;
/** Agents, tests and the integration agent. */
export const AGENT_PORT = 5199;
/** `.claude/worktrees/t<N>-…` serves on TRACK_PORT_BASE + N. */
export const TRACK_PORT_BASE = 5190;
/** Playwright's dev server in the main checkout. */
export const E2E_PORT = 5181;
/** Playwright's dev server in `.claude/worktrees/t<N>-…` is E2E_TRACK_PORT_BASE + N. */
export const E2E_TRACK_PORT_BASE = 5290;

export type PortEnv = Readonly<Record<string, string | undefined>>;

const posix = (p: string): string => p.replaceAll('\\', '/');

/** True when `root` lies under a `.claude/worktrees/` folder (any name; the file system here ignores case). */
export function isWorktreeRoot(root: string): boolean {
  return /\/\.claude\/worktrees\/[^/]+/i.test(posix(root));
}

/** N for a track worktree named `.claude/worktrees/t<N>-…` (or `t<N>`), else undefined. */
export function trackNumber(root: string): number | undefined {
  const m = /\/\.claude\/worktrees\/t(\d+)(?:-[^/]*)?(?:\/|$)/i.exec(posix(root));
  return m ? Number(m[1]) : undefined;
}

function parsePort(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === '') return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}=${JSON.stringify(value)} is not a port number (1–65535)`);
  }
  return port;
}

/**
 * True when port 5180 must not be used: `CLAUDE_CODE_CHILD_SESSION` or `CPG_TEST` is set — to anything, even
 * to an empty string (every agent shell has the former) — or the root is a worktree.
 */
export function isGuarded(env: PortEnv, root: string): boolean {
  return env.CLAUDE_CODE_CHILD_SESSION !== undefined || env.CPG_TEST !== undefined || isWorktreeRoot(root);
}

/** `port` under the rule: 5180 becomes 5199 when guarded; every other port is kept. */
export function guardPort(port: number, env: PortEnv, root: string): number {
  return isGuarded(env, root) && port === USER_PORT ? AGENT_PORT : port;
}

/**
 * Port of `npm run dev` and `npm run preview` (both `strictPort`).
 *
 * `CPG_PORT` if given; else 5180 in the main checkout, 5190 + N in `.claude/worktrees/t<N>-…` and 5199 in any
 * other worktree. When guarded (see isGuarded) 5180 is never returned — 5199 is used instead, even if
 * `CPG_PORT=5180` was passed.
 */
export function devPort(env: PortEnv, root: string): number {
  const n = trackNumber(root);
  const fallback = n !== undefined ? TRACK_PORT_BASE + n : isWorktreeRoot(root) ? AGENT_PORT : USER_PORT;
  return guardPort(parsePort(env.CPG_PORT, 'CPG_PORT') ?? fallback, env, root);
}

/**
 * Port Playwright starts its own dev server on: `CPG_E2E_PORT` if given, else 5290 + N in a track worktree,
 * else 5181. Derived from the directory name because an exported variable does not survive between agent
 * shell calls. Never 5180: e2e must not reuse, or even probe, the user's server.
 */
export function e2ePort(env: PortEnv, root: string): number {
  const n = trackNumber(root);
  const port = parsePort(env.CPG_E2E_PORT, 'CPG_E2E_PORT') ?? (n !== undefined ? E2E_TRACK_PORT_BASE + n : E2E_PORT);
  if (port === USER_PORT) {
    throw new Error(`CPG_E2E_PORT=${USER_PORT} is the user's own origin; e2e runs must use another port`);
  }
  return port;
}

/**
 * Vite plugin: applies the port rule to the final configuration. Options given on the command line
 * (`vite --port 5180`, `--strictPort false`) override vite.config.ts, so the rule is enforced here, after they
 * have been merged: the dev and preview ports go through guardPort and `strictPort` is always on (without it
 * Vite would move on to the next free port, and from 5179 that is 5180). A configuration that would still serve
 * on 5180 while guarded is refused.
 */
export function portGuard(env: PortEnv, root: string): Plugin {
  return {
    name: 'cpg:port-guard',
    config(config) {
      const fallback = devPort(env, root);
      return {
        server: { port: guardPort(config.server?.port ?? fallback, env, root), strictPort: true },
        preview: { port: guardPort(config.preview?.port ?? fallback, env, root), strictPort: true },
      };
    },
    configResolved(config) {
      for (const [name, options] of [
        ['server', config.server],
        ['preview', config.preview],
      ] as const) {
        if (!options.strictPort) throw new Error(`${name}.strictPort must stay on (DESIGN.md §5.5.4)`);
        if (isGuarded(env, root) && options.port === USER_PORT) {
          throw new Error(`${name}.port ${USER_PORT} is the user's own origin; agents, tests and worktrees must not serve on it`);
        }
      }
    },
  };
}
