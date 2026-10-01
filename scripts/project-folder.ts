// Track T8 (DESIGN.md §5.5.4): the Vite plugin that mirrors projects into a folder (`/__projects`), keeps
// change-only backups on a shared, content-addressed asset store, and converts HEIC photos (`POST /__convert`)
// on the dev and preview servers.
//
// Isolation (§5.5.4, §6.1 rule 6): the user's real folder (`~/Documents/Crochet Pattern Generator/projects/`,
// which iCloud Drive syncs) is refused — the mirror stays off and nothing under it is read, written or created —
// whenever PLAYWRIGHT, VITEST, CI or CPG_TEST is set, CLAUDE_CODE_CHILD_SESSION is set (every agent shell), the
// server root lies under /.claude/worktrees/, or the checkout is not on branch master. Tests, agents and
// worktree servers pass their own folder (`CPG_PROJECTS_DIR=$(mktemp -d)`), where the mirror runs normally.
//
// Layout: `<projects>/<id>/project.json` + `<projects>/<id>/assets/<sha256>` (write-once). Backups go next to
// the projects folder (`<parent>/Backups/` when the folder is named `projects`, else `<folder>/_backups/`, so a
// temp folder keeps everything inside itself). Every write goes to a temp file in the same directory and is
// renamed into place, so a crash never leaves a truncated file. The protocol is in
// src/core/persist/folderProtocol.ts; the backup policy (names, change hash, retention, free-space levels) in
// src/core/persist/backups.ts.
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Connect, Plugin } from 'vite';
import {
  backupCapBytes,
  changeHashText,
  deletedFolderName,
  freeSpaceLevel,
  freeSpaceMessage,
  isBackupFolderName,
  compareBackupNames,
  nextBackupFolderName,
  parseBackupFolderName,
  planRetention,
  unreferencedAssets,
  FREE_STOP_BYTES,
  type BackupInfo,
} from '../src/core/persist/backups.ts';
import {
  BACKUPS_ROUTE,
  BASE_SHA_HEADER,
  CONVERT_HEADER,
  CONVERT_ROUTE,
  MAX_ASSET_BYTES,
  MAX_DOC_BYTES,
  MIRROR_HEADER,
  NO_BASE,
  PROJECTS_ROUTE,
  SHA_HEADER,
  isFolderProjectId,
  isSha256,
  type BackupListing,
  type BackupManifest,
  type BackupProjectSummary,
  type BackupRunResult,
  type DeleteResult,
  type FolderListing,
  type FolderProjectEntry,
  type FolderStatus,
  type PutAssetResult,
  type PutDocResult,
} from '../src/core/persist/folderProtocol.ts';
import { isWorktreeRoot, type PortEnv } from './ports.ts';

export { CONVERT_HEADER, MIRROR_HEADER };

// ---- isolation

/** Any of these set (even to an empty string) means a test run. */
export const TEST_VARIABLES = ['PLAYWRIGHT', 'VITEST', 'CI', 'CPG_TEST'] as const;
/** Set in every Claude Code workflow and sub-agent shell (not in the user's own interactive session). */
export const AGENT_VARIABLE = 'CLAUDE_CODE_CHILD_SESSION';

const APP_FOLDER = 'Crochet Pattern Generator';

/** The user's projects folder: `~/Documents/Crochet Pattern Generator/projects`. */
export function defaultProjectsDir(home: string): string {
  return path.join(home, 'Documents', APP_FOLDER, 'projects');
}

/**
 * The folders that hold the user's real data: the app folder in `~/Documents` and the same folder by its iCloud
 * Drive path (`~/Documents` is synced into `~/Library/Mobile Documents/com~apple~CloudDocs/Documents`).
 */
export function protectedFolders(home: string): string[] {
  return [path.join(home, 'Documents', APP_FOLDER), path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Documents', APP_FOLDER)];
}

// APFS ignores case and Unicode normalization, so compare folded paths.
const fold = (p: string): string => path.resolve(p).normalize('NFC').toLowerCase().replace(/[\\/]+$/, '');
const sameOrInside = (p: string, root: string): boolean => p === root || p.startsWith(root + path.sep);

/**
 * True when `dir` is a protected folder, lies inside one, or contains one (`~/Documents`, the home folder):
 * every such folder holds or would expose the user's real projects. Pure string check — no file system access.
 */
export function isProtectedFolder(dir: string, home: string): boolean {
  const d = fold(dir);
  return protectedFolders(home).some((r) => {
    const root = fold(r);
    return sameOrInside(d, root) || sameOrInside(root, d);
  });
}

/** The real path of the home folder (`/var/…` is `/private/var/…` on macOS); the path itself on failure. */
function realHome(home: string): string {
  try {
    return fs.realpathSync.native(home);
  } catch {
    return home;
  }
}

/** The real path of `dir` (symlinks resolved) through its nearest existing ancestor; `dir` itself on failure. */
export function nearestRealpath(dir: string): string {
  let probe = path.resolve(dir);
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(probe), ...rest);
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return path.resolve(dir);
      rest.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/** The branch checked out at `root` (or an ancestor holding `.git`), or null: detached HEAD, no checkout, unreadable. */
export function gitBranch(root: string): string | null {
  let dir = path.resolve(root);
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(dotGit);
    } catch {
      stat = undefined;
    }
    if (stat) {
      try {
        let headFile: string;
        if (stat.isDirectory()) {
          headFile = path.join(dotGit, 'HEAD');
        } else {
          // A worktree: `.git` is a file "gitdir: <path to .git/worktrees/<name>>".
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (!m) return null;
          headFile = path.join(path.resolve(dir, m[1].trim()), 'HEAD');
        }
        const head = fs.readFileSync(headFile, 'utf8').trim();
        return /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1] ?? null;
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** Why the protected folder must not be used here, or null when it may (the user's own server on master). */
export function isolationReason(env: PortEnv, root: string, readBranch: (root: string) => string | null = gitBranch): string | null {
  for (const v of TEST_VARIABLES) if (env[v] !== undefined) return `${v} is set (a test run)`;
  if (env[AGENT_VARIABLE] !== undefined) return `${AGENT_VARIABLE} is set (an agent or workflow shell)`;
  if (isWorktreeRoot(root)) return `the server root ${root} lies under /.claude/worktrees/`;
  const branch = readBranch(root);
  if (branch !== 'master') return branch === null ? 'the checkout is not on branch master (detached HEAD or no git checkout)' : `the checkout is on branch ${branch}, not master`;
  return null;
}

/** Where the backups of a projects folder go (see the header). */
export function backupsDirFor(projectsDir: string): string {
  return path.basename(projectsDir).toLowerCase() === 'projects' ? path.join(path.dirname(projectsDir), 'Backups') : path.join(projectsDir, '_backups');
}

export type MirrorDecision =
  | { on: true; projectsDir: string; backupsDir: string; isDefault: boolean }
  | { on: false; reason: string; hint: string };

const expandHome = (p: string, home: string): string => (p === '~' ? home : p.startsWith('~/') ? path.join(home, p.slice(2)) : p);

/**
 * Whether the mirror runs, and on which folder: `CPG_PROJECTS_DIR` or the default folder. A protected folder
 * (by its path, or by where its symlinks lead) is refused while any isolation rule holds. The protected check
 * runs on the path string first, so a refused folder is never touched.
 */
export function decideMirror(o: { env: PortEnv; root: string; home: string; readBranch?: (root: string) => string | null; realpath?: (dir: string) => string }): MirrorDecision {
  const configured = o.env.CPG_PROJECTS_DIR?.trim();
  const projectsDir = configured ? path.resolve(expandHome(configured, o.home)) : defaultProjectsDir(o.home);
  // The string check first: a refused folder is never touched. Then where symlinks lead, against the home
  // folder by its own path and by its real path.
  const guarded =
    isProtectedFolder(projectsDir, o.home) ||
    (() => {
      const real = (o.realpath ?? nearestRealpath)(projectsDir);
      return isProtectedFolder(real, o.home) || isProtectedFolder(real, realHome(o.home));
    })();
  if (guarded) {
    const reason = isolationReason(o.env, o.root, o.readBranch);
    if (reason !== null) {
      return {
        on: false,
        reason: `refusing ${configured ? 'the folder' : 'the default folder'} ${projectsDir} because ${reason}`,
        hint: 'Set CPG_PROJECTS_DIR to a folder of your own (for tests and agents: CPG_PROJECTS_DIR=$(mktemp -d)).',
      };
    }
  }
  return { on: true, projectsDir, backupsDir: backupsDirFor(projectsDir), isDefault: !configured };
}

// ---- file helpers

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const tempName = (base: string): string => `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
const isTempName = (name: string): boolean => name.startsWith('.') && name.endsWith('.tmp');

const exists = async (p: string): Promise<boolean> => {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
};

/** What the store writes with; tests replace `writeTemp` to simulate a write killed half way. */
export interface WriteIo {
  writeTemp(handle: fsp.FileHandle, data: Buffer): Promise<void>;
}

const defaultIo: WriteIo = {
  async writeTemp(handle, data) {
    await handle.writeFile(data);
    await handle.sync();
  },
};

/** Writes `data` to a temp file next to `file`, then renames it into place (atomic on one file system). */
export async function writeAtomic(file: string, data: Buffer | string, io: WriteIo = defaultIo): Promise<void> {
  const tmp = path.join(path.dirname(file), tempName(path.basename(file)));
  const handle = await fsp.open(tmp, 'wx');
  try {
    await io.writeTemp(handle, typeof data === 'string' ? Buffer.from(data) : data);
  } catch (error) {
    await handle.close().catch(() => {});
    await fsp.rm(tmp, { force: true });
    throw error;
  }
  await handle.close();
  await fsp.rename(tmp, file);
}

/** Free bytes on the disk holding `dir` (or its nearest existing ancestor). */
async function statfsFree(dir: string): Promise<number> {
  let probe = path.resolve(dir);
  for (;;) {
    try {
      const s = await fsp.statfs(probe);
      return Number(s.bavail) * Number(s.bsize);
    } catch (error) {
      const parent = path.dirname(probe);
      if (parent === probe) throw error;
      probe = parent;
    }
  }
}

/** One lock per key: runs `fn` after every earlier call with the same key settled. */
function keyedMutex() {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    const before = tails.get(key) ?? Promise.resolve();
    const run = before.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    tails.set(key, tail);
    try {
      return await run;
    } finally {
      if (tails.get(key) === tail) tails.delete(key);
    }
  };
}

export class FolderRequestError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'FolderRequestError';
    this.status = status;
  }
}

interface ParsedDoc {
  id: string;
  rev: number;
  updatedAt: string;
  name: string;
  mode: '2d' | '3d';
}

/** The fields the folder needs from a project.json, or null when it is not a project document. */
function readDocFields(bytes: Buffer): ParsedDoc | null {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const d = raw as Record<string, unknown>;
  if (d.schema !== 'crochet-project' || typeof d.id !== 'string' || typeof d.rev !== 'number' || !Number.isFinite(d.rev)) return null;
  return {
    id: d.id,
    rev: d.rev,
    updatedAt: typeof d.updatedAt === 'string' ? d.updatedAt : '',
    name: typeof d.name === 'string' ? d.name : '',
    mode: d.mode === '3d' ? '3d' : '2d',
  };
}

// ---- the folder store

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

const consoleLogger: Logger = {
  info: (m) => console.info(m),
  warn: (m) => console.warn(m),
  error: (m) => console.error(m),
};

export interface FolderStoreOptions {
  projectsDir: string;
  backupsDir: string;
  now?: () => Date;
  /** Free bytes on the disk of a folder (tests stub it). */
  statfs?: (dir: string) => Promise<number>;
  /** Logical size cap of Backups/ (default from `CPG_BACKUP_CAP_GB`, 2 GB). */
  capBytes?: number;
  log?: Logger;
  io?: WriteIo;
}

export interface FolderStore {
  readonly projectsDir: string;
  readonly backupsDir: string;
  /** Creates the folder, removes leftovers of interrupted writes, checks free space, backs up, prunes. */
  start(): Promise<BackupRunResult>;
  list(): Promise<FolderListing>;
  status(): Promise<FolderStatus>;
  readDoc(id: string): Promise<Buffer | null>;
  /** `base`: undefined = unconditional; null = the folder must not have it; else the sha it must have. */
  writeDoc(id: string, body: Buffer, base: string | null | undefined): Promise<PutDocResult>;
  listAssets(id: string): Promise<string[]>;
  assetPath(id: string, sha: string): string;
  writeAsset(id: string, sha: string, body: AsyncIterable<Buffer | Uint8Array | string>): Promise<PutAssetResult>;
  remove(id: string): Promise<DeleteResult>;
  backup(): Promise<BackupRunResult>;
  prune(): Promise<string[]>;
  listBackups(): Promise<BackupListing>;
  readBackupDoc(backup: string, id: string): Promise<Buffer | null>;
  backupAssetPath(sha: string): string;
}

const DOC_FILE = 'project.json';
const MANIFEST_FILE = 'manifest.json';
const STALE_TEMP_MS = 60 * 60 * 1000;

export function createFolderStore(o: FolderStoreOptions): FolderStore {
  const projectsDir = path.resolve(o.projectsDir);
  const backupsDir = path.resolve(o.backupsDir);
  const now = o.now ?? (() => new Date());
  const statfs = o.statfs ?? statfsFree;
  const capBytes = o.capBytes ?? backupCapBytes(process.env.CPG_BACKUP_CAP_GB);
  const log = o.log ?? consoleLogger;
  const io = o.io ?? defaultIo;
  const mutex = keyedMutex();
  let lastBackup: BackupRunResult | null = null;

  const projectDir = (id: string): string => {
    if (!isFolderProjectId(id)) throw new FolderRequestError(400, `Not a project id the folder accepts: ${JSON.stringify(id)}`);
    return path.join(projectsDir, id);
  };
  const docFile = (id: string): string => path.join(projectDir(id), DOC_FILE);
  const assetsDir = (id: string): string => path.join(projectDir(id), 'assets');
  const sharedAssets = path.join(backupsDir, 'assets');

  const readIfExists = async (file: string): Promise<Buffer | null> => {
    try {
      return await fsp.readFile(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  };

  const shaFiles = async (dir: string): Promise<string[]> => {
    try {
      return (await fsp.readdir(dir)).filter(isSha256).sort();
    } catch {
      return [];
    }
  };

  const projectIds = async (): Promise<string[]> => {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory() && isFolderProjectId(e.name)).map((e) => e.name).sort();
  };

  /** Deletes temp files of writes that never finished (a crash or a kill), older than an hour. */
  const cleanTemp = async (): Promise<void> => {
    const sweep = async (dir: string): Promise<void> => {
      let names: string[];
      try {
        names = await fsp.readdir(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (!isTempName(name) && !name.includes('.partial-')) continue;
        const p = path.join(dir, name);
        try {
          const st = await fsp.stat(p);
          if (now().getTime() - st.mtimeMs > STALE_TEMP_MS) await fsp.rm(p, { recursive: true, force: true });
        } catch {
          // gone already
        }
      }
    };
    for (const id of await projectIds()) {
      await sweep(projectDir(id));
      await sweep(assetsDir(id));
    }
    await sweep(backupsDir);
    await sweep(sharedAssets);
  };

  const status = async (): Promise<FolderStatus> => {
    let freeBytes: number | null = null;
    try {
      freeBytes = await statfs(projectsDir);
    } catch {
      freeBytes = null;
    }
    return {
      folder: projectsDir,
      backupsFolder: backupsDir,
      freeBytes,
      level: freeBytes === null ? null : freeSpaceLevel(freeBytes),
      message: freeBytes === null ? null : freeSpaceMessage(freeBytes),
      lastBackup,
    };
  };

  interface ScannedProject extends BackupProjectSummary {
    doc: Buffer;
  }

  const scan = async (): Promise<ScannedProject[]> => {
    const out: ScannedProject[] = [];
    for (const id of await projectIds()) {
      const doc = await readIfExists(docFile(id));
      if (!doc) continue;
      const fields = readDocFields(doc);
      out.push({
        id,
        name: fields?.name ?? id,
        mode: fields?.mode ?? '2d',
        updatedAt: fields?.updatedAt ?? '',
        rev: fields?.rev ?? 0,
        docSha256: sha256(doc),
        assets: await shaFiles(assetsDir(id)),
        doc,
      });
    }
    return out;
  };

  interface StoredBackup extends BackupInfo {
    manifest: BackupManifest;
  }

  /** Every backup with a readable manifest, oldest first; `unreadable` counts folders that look like backups but are not. */
  const readBackups = async (): Promise<{ backups: StoredBackup[]; unreadable: number }> => {
    let names: string[];
    try {
      names = (await fsp.readdir(backupsDir)).filter(isBackupFolderName);
    } catch {
      return { backups: [], unreadable: 0 };
    }
    const backups: StoredBackup[] = [];
    let unreadable = 0;
    for (const name of names.sort(compareBackupNames)) {
      const dir = path.join(backupsDir, name);
      try {
        const manifestBytes = await fsp.readFile(path.join(dir, MANIFEST_FILE));
        const manifest = JSON.parse(manifestBytes.toString('utf8')) as BackupManifest;
        if (manifest.format !== 'cpg-backup' || !Array.isArray(manifest.projects) || typeof manifest.hash !== 'string') throw new Error('not a manifest');
        let ownBytes = manifestBytes.length;
        const assets = new Set<string>();
        for (const p of manifest.projects) {
          for (const a of p.assets ?? []) if (isSha256(a)) assets.add(a);
          try {
            ownBytes += (await fsp.stat(path.join(dir, 'projects', p.id, DOC_FILE))).size;
          } catch {
            // a missing doc counts nothing
          }
        }
        backups.push({ name, at: parseBackupFolderName(name) ?? new Date(0), ownBytes, assets: [...assets], manifest });
      } catch {
        unreadable++;
      }
    }
    return { backups, unreadable };
  };

  const store: FolderStore = {
    projectsDir,
    backupsDir,

    async start() {
      await fsp.mkdir(projectsDir, { recursive: true });
      await cleanTemp();
      const s = await status();
      if (s.message) (s.level === 'critical' ? log.error : log.warn)(`[cpg folder] ${s.message}`);
      return store.backup();
    },

    async list() {
      const projects: FolderProjectEntry[] = [];
      const damaged: string[] = [];
      for (const id of await projectIds()) {
        const doc = await readIfExists(docFile(id)).catch(() => null);
        if (!doc) {
          // A folder without a doc: an interrupted first push (assets only) — not a project yet.
          if (!(await exists(docFile(id)))) continue;
          damaged.push(id);
          continue;
        }
        const fields = readDocFields(doc);
        if (!fields || fields.id !== id) {
          damaged.push(id);
          continue;
        }
        projects.push({ id, rev: fields.rev, docSha256: sha256(doc), updatedAt: fields.updatedAt, name: fields.name, mode: fields.mode, bytes: doc.length });
      }
      return { projects, damaged, status: await status() };
    },

    status,

    async readDoc(id) {
      return readIfExists(docFile(id));
    },

    async writeDoc(id, body, base) {
      const fields = readDocFields(body);
      if (!fields) throw new FolderRequestError(400, 'The body is not a crochet-project document.');
      if (fields.id !== id) throw new FolderRequestError(400, `The document's id ${JSON.stringify(fields.id)} is not ${JSON.stringify(id)}.`);
      return mutex(id, async () => {
        const file = docFile(id);
        const current = await readIfExists(file);
        const currentSha = current ? sha256(current) : null;
        const nextSha = sha256(body);
        if (currentSha === nextSha) return { ok: true, sha256: nextSha, written: false };
        if (current) {
          const other = readDocFields(current);
          if (other && other.id !== id) throw new FolderRequestError(409, `The folder ${id} holds the project ${JSON.stringify(other.id)}.`);
        }
        // Compare-and-swap on the folder: only the doc the client last synced may be replaced. A folder that
        // lost the project (moved away by hand) gets it back.
        if (base !== undefined && currentSha !== null && currentSha !== base) return { ok: false, reason: 'conflict', sha256: currentSha };
        await fsp.mkdir(assetsDir(id), { recursive: true });
        await writeAtomic(file, body, io);
        return { ok: true, sha256: nextSha, written: true };
      });
    },

    async listAssets(id) {
      return shaFiles(assetsDir(id));
    },

    assetPath(id, sha) {
      if (!isSha256(sha)) throw new FolderRequestError(400, `Not a sha256: ${JSON.stringify(sha)}`);
      return path.join(assetsDir(id), sha);
    },

    async writeAsset(id, sha, body) {
      const final = store.assetPath(id, sha);
      const drain = async (): Promise<void> => {
        for await (const chunk of body) void chunk;
      };
      if (await exists(final)) {
        await drain();
        return { ok: true, existed: true };
      }
      await fsp.mkdir(path.dirname(final), { recursive: true });
      const tmp = path.join(path.dirname(final), tempName(sha));
      const handle = await fsp.open(tmp, 'wx');
      const hash = createHash('sha256');
      let size = 0;
      try {
        for await (const chunk of body) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
          size += buf.length;
          if (size > MAX_ASSET_BYTES) throw new FolderRequestError(413, `An asset may hold at most ${MAX_ASSET_BYTES} bytes.`);
          hash.update(buf);
          await handle.write(buf);
        }
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => {});
        await fsp.rm(tmp, { force: true });
        if (error instanceof FolderRequestError) await drain().catch(() => {});
        throw error;
      }
      await handle.close();
      const got = hash.digest('hex');
      if (got !== sha) {
        await fsp.rm(tmp, { force: true });
        throw new FolderRequestError(422, `The bytes hash to ${got}, not ${sha}.`);
      }
      // link() never replaces an existing file: two uploads of the same asset cannot rewrite it.
      let existed = false;
      try {
        await fsp.link(tmp, final);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          await fsp.rm(tmp, { force: true });
          throw error;
        }
        existed = true;
      }
      await fsp.rm(tmp, { force: true });
      return { ok: true, existed };
    },

    async remove(id) {
      const dir = projectDir(id);
      return mutex(id, async () => {
        if (!(await exists(dir))) return { ok: true, movedTo: null };
        const deletedDir = path.join(backupsDir, 'deleted');
        await fsp.mkdir(deletedDir, { recursive: true });
        const base = deletedFolderName(id, now());
        let target = path.join(deletedDir, base);
        for (let n = 2; await exists(target); n++) target = path.join(deletedDir, `${base}-${n}`);
        await fsp.rename(dir, target);
        return { ok: true, movedTo: target };
      });
    },

    async backup() {
      const at = now();
      const finish = (r: BackupRunResult): BackupRunResult => {
        lastBackup = r;
        return r;
      };
      try {
        const projects = await scan();
        if (projects.length === 0) return finish({ status: 'empty', at: at.toISOString() });
        const hash = sha256(changeHashText(projects));
        const { backups } = await readBackups();
        const newest = backups.at(-1);
        if (newest && newest.manifest.hash === hash) {
          log.info(`[cpg folder] Backup skipped: nothing changed since ${newest.name}.`);
          await store.prune();
          return finish({ status: 'unchanged', at: at.toISOString(), newest: newest.name });
        }
        const freeBytes = await statfs(backupsDir).catch(() => null);
        if (freeBytes !== null && freeBytes < FREE_STOP_BYTES) {
          log.error(`[cpg folder] Backup skipped: ${freeSpaceMessage(freeBytes) ?? ''}`);
          return finish({ status: 'skipped-low-space', at: at.toISOString(), freeBytes });
        }
        await fsp.mkdir(sharedAssets, { recursive: true });
        const existingNames = (await fsp.readdir(backupsDir)).filter(isBackupFolderName);
        const name = nextBackupFolderName(at, existingNames);
        const partial = path.join(backupsDir, `.${name}.partial-${randomBytes(4).toString('hex')}`);
        let newAssets = 0;
        let newBytes = 0;
        try {
          for (const p of projects) {
            const dir = path.join(partial, 'projects', p.id);
            await fsp.mkdir(dir, { recursive: true });
            await fsp.writeFile(path.join(dir, DOC_FILE), p.doc);
            newBytes += p.doc.length;
            for (const sha of p.assets) {
              const dst = path.join(sharedAssets, sha);
              if (await exists(dst)) continue;
              const tmp = path.join(sharedAssets, tempName(sha));
              // An APFS clone: no extra space while the original exists; a plain copy elsewhere.
              await fsp.copyFile(path.join(assetsDir(p.id), sha), tmp, fs.constants.COPYFILE_FICLONE);
              try {
                await fsp.link(tmp, dst);
                newAssets++;
                newBytes += (await fsp.stat(dst)).size;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
              } finally {
                await fsp.rm(tmp, { force: true });
              }
            }
          }
          const manifest: BackupManifest = {
            format: 'cpg-backup',
            version: 1,
            hash,
            at: at.toISOString(),
            projects: projects.map(({ doc: _doc, ...summary }) => summary),
          };
          const manifestText = JSON.stringify(manifest, null, 1);
          await fsp.writeFile(path.join(partial, MANIFEST_FILE), manifestText);
          newBytes += Buffer.byteLength(manifestText);
          // The backup appears complete or not at all.
          await fsp.rename(partial, path.join(backupsDir, name));
        } catch (error) {
          await fsp.rm(partial, { recursive: true, force: true });
          throw error;
        }
        const pruned = await store.prune();
        log.info(`[cpg folder] Backup ${name}: ${projects.length} project${projects.length === 1 ? '' : 's'}, ${newAssets} new file${newAssets === 1 ? '' : 's'}.`);
        return finish({ status: 'created', name, at: at.toISOString(), projects: projects.length, newAssets, newBytes, pruned });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error(`[cpg folder] Backup failed: ${message}`);
        return finish({ status: 'failed', at: at.toISOString(), message });
      }
    },

    async prune() {
      const { backups, unreadable } = await readBackups();
      if (backups.length === 0) return [];
      const assetBytes = new Map<string, number>();
      const stored = await shaFiles(sharedAssets);
      for (const sha of stored) {
        try {
          assetBytes.set(sha, (await fsp.stat(path.join(sharedAssets, sha))).size);
        } catch {
          // gone
        }
      }
      const plan = planRetention(backups, { now: now(), capBytes, assetBytes });
      if (plan.overCap) log.warn(`[cpg folder] Backups use more than the cap of ${capBytes} bytes; the newest and those younger than 24 h are kept anyway.`);
      for (const name of plan.drop) await fsp.rm(path.join(backupsDir, name), { recursive: true, force: true });
      // Shared assets no kept backup names. Skipped while a folder that looks like a backup has no readable
      // manifest: its assets are unknown, and deleting them could break it.
      if (unreadable === 0) {
        const kept = backups.filter((b) => plan.keep.includes(b.name));
        for (const sha of unreferencedAssets(stored, kept)) await fsp.rm(path.join(sharedAssets, sha), { force: true });
      }
      return plan.drop;
    },

    async listBackups() {
      const { backups } = await readBackups();
      return {
        backups: backups
          .map((b) => ({ name: b.name, at: b.manifest.at ?? b.at.toISOString(), projects: b.manifest.projects }))
          .reverse(),
      };
    },

    async readBackupDoc(backup, id) {
      if (!isBackupFolderName(backup)) throw new FolderRequestError(400, `Not a backup: ${JSON.stringify(backup)}`);
      if (!isFolderProjectId(id)) throw new FolderRequestError(400, `Not a project id: ${JSON.stringify(id)}`);
      return readIfExists(path.join(backupsDir, backup, 'projects', id, DOC_FILE));
    },

    backupAssetPath(sha) {
      if (!isSha256(sha)) throw new FolderRequestError(400, `Not a sha256: ${JSON.stringify(sha)}`);
      return path.join(sharedAssets, sha);
    },
  };
  return store;
}

// ---- HEIC conversion

/** The server refuses more than this (the client's `MAX_CONVERT_BYTES` in src/workers/decode.ts). */
export const MAX_CONVERT_BYTES = 50 * 1024 * 1024;
const HEIF_BRANDS: readonly string[] = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
const AVIF_BRANDS: readonly string[] = ['avif', 'avis'];

/**
 * True when the bytes start with an ISO-BMFF `ftyp` box naming a HEIF brand (and no AVIF brand) — the same rule
 * as `sniffHeifBrand` in src/workers/decode.ts (tested equal). Kept here so the Vite config does not load a
 * browser module.
 */
export function isHeif(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ascii = (at: number): string => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
  if (ascii(4) !== 'ftyp') return false;
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  const end = size >= 16 ? Math.min(size, bytes.length) : bytes.length;
  const major = ascii(8);
  const compatible: string[] = [];
  for (let at = 16; at + 4 <= end; at += 4) compatible.push(ascii(at));
  if (AVIF_BRANDS.includes(major) || compatible.some((b) => AVIF_BRANDS.includes(b))) return false;
  return HEIF_BRANDS.includes(major) || compatible.some((b) => HEIF_BRANDS.includes(b));
}

export interface ConvertOptions {
  platform?: NodeJS.Platform;
  /** The converter (default `/usr/bin/sips`). */
  sips?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/** Reads a request body up to `limit` bytes; beyond it the rest is read and dropped, and null returned. */
async function readBody(req: AsyncIterable<Buffer | string>, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
    size += buf.length;
    if (size > limit) over = true;
    if (!over) chunks.push(buf);
  }
  return over ? null : Buffer.concat(chunks);
}

/** Converts HEIC/HEIF bytes to JPEG with `sips` (macOS). Throws on failure. */
export async function convertHeicToJpeg(heic: Buffer, o: ConvertOptions = {}): Promise<Buffer> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cpg-convert-'));
  try {
    const input = path.join(dir, 'input.heic');
    const output = path.join(dir, 'output.jpg');
    await fsp.writeFile(input, heic);
    await new Promise<void>((resolve, reject) => {
      execFile(o.sips ?? '/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', input, '--out', output], { timeout: o.timeoutMs ?? 20_000 }, (error) =>
        error ? reject(error) : resolve(),
      );
    });
    return await fsp.readFile(output);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// ---- HTTP

type Res = ServerResponse;

function sendJson(res: Res, status: number, body: unknown, method?: string): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(method === 'HEAD' ? undefined : JSON.stringify(body));
}

function sendBytes(res: Res, bytes: Buffer, type: string, method: string | undefined, headers: Record<string, string> = {}): void {
  res.statusCode = 200;
  res.setHeader('Content-Type', type);
  res.setHeader('Content-Length', String(bytes.length));
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(method === 'HEAD' ? undefined : bytes);
}

async function sendFile(res: Res, file: string, method: string | undefined): Promise<void> {
  let st: fs.Stats;
  try {
    st = await fsp.stat(file);
  } catch {
    sendJson(res, 404, { error: 'not found' }, method);
    return;
  }
  res.statusCode = 200;
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Length', String(st.size));
  res.setHeader('Cache-Control', 'no-store');
  if (method === 'HEAD') {
    res.end();
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('end', resolve);
    stream.pipe(res);
  });
}

const segmentsOf = (pathname: string, prefix: string): string[] | null => {
  if (pathname === prefix) return [];
  if (!pathname.startsWith(prefix + '/')) return null;
  return pathname
    .slice(prefix.length + 1)
    .split('/')
    .map((s) => decodeURIComponent(s));
};

export interface RoutesOptions extends ConvertOptions {
  log?: Logger;
}

/**
 * The middleware: `/__projects` and `/__backups` on `store` (null: the mirror is off — the probe answers 204 +
 * `x-cpg-mirror: off` and every other mirror route 503), and `POST /__convert`. Everything else passes on.
 */
export function folderRoutes(store: FolderStore | null, o: RoutesOptions = {}): Connect.NextHandleFunction {
  const platform = o.platform ?? process.platform;
  const log = o.log ?? consoleLogger;
  const handle = async (req: IncomingMessage, res: Res, next: (err?: unknown) => void): Promise<void> => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    } catch {
      next();
      return;
    }
    const method = req.method ?? 'GET';

    if (pathname === CONVERT_ROUTE) {
      if (method !== 'POST') {
        sendJson(res, 405, { error: 'Use POST.' }, method);
        return;
      }
      if (platform !== 'darwin') {
        await readBody(req, 0).catch(() => null);
        res.setHeader(CONVERT_HEADER, 'off');
        sendJson(res, 200, { converted: false, reason: 'no-converter' });
        return;
      }
      const maxBytes = o.maxBytes ?? MAX_CONVERT_BYTES;
      const body = await readBody(req, maxBytes);
      if (body === null) {
        sendJson(res, 413, { error: `At most ${maxBytes} bytes.` });
        return;
      }
      if (!isHeif(new Uint8Array(body.buffer, body.byteOffset, Math.min(body.length, 64)))) {
        sendJson(res, 415, { error: 'Not a HEIC/HEIF image.' });
        return;
      }
      try {
        sendBytes(res, await convertHeicToJpeg(body, o), 'image/jpeg', method);
      } catch (error) {
        log.warn(`[cpg convert] sips failed: ${error instanceof Error ? error.message : String(error)}`);
        sendJson(res, 500, { converted: false, reason: 'failed' });
      }
      return;
    }

    let seg = segmentsOf(pathname, PROJECTS_ROUTE);
    const backups = seg === null ? segmentsOf(pathname, BACKUPS_ROUTE) : null;
    if (seg === null && backups === null) {
      next();
      return;
    }
    if (!store) {
      if (seg !== null && seg.length === 0 && method === 'HEAD') {
        res.statusCode = 204;
        res.setHeader(MIRROR_HEADER, 'off');
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }
      res.setHeader(MIRROR_HEADER, 'off');
      sendJson(res, 503, { error: 'The folder mirror is off on this server.' }, method);
      return;
    }

    if (backups !== null) {
      if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'Backups are read-only here.' }, method);
      if (backups.length === 0) return sendJson(res, 200, await store.listBackups(), method);
      if (backups.length === 2 && backups[0] === 'assets') return sendFile(res, store.backupAssetPath(backups[1]), method);
      if (backups.length === 3 && backups[2] === 'doc') {
        const doc = await store.readBackupDoc(backups[0], backups[1]);
        if (!doc) return sendJson(res, 404, { error: 'not found' }, method);
        return sendBytes(res, doc, 'application/json; charset=utf-8', method, { [SHA_HEADER]: sha256(doc) });
      }
      return sendJson(res, 404, { error: 'not found' }, method);
    }

    seg = seg ?? [];
    if (seg.length === 0) {
      if (method === 'HEAD') {
        res.statusCode = 200;
        res.setHeader(MIRROR_HEADER, 'on');
        res.setHeader('Cache-Control', 'no-store');
        res.end();
        return;
      }
      if (method === 'GET') return sendJson(res, 200, await store.list());
      return sendJson(res, 405, { error: 'Use GET or HEAD.' }, method);
    }
    const [id, part, sha, ...rest] = seg;
    if (!isFolderProjectId(id) || rest.length > 0) return sendJson(res, 404, { error: 'not found' }, method);
    res.setHeader(MIRROR_HEADER, 'on');
    if (part === undefined) {
      if (method === 'DELETE') return sendJson(res, 200, await store.remove(id));
      return sendJson(res, 405, { error: 'Use DELETE.' }, method);
    }
    if (part === 'doc' && sha === undefined) {
      if (method === 'GET' || method === 'HEAD') {
        const doc = await store.readDoc(id);
        if (!doc) return sendJson(res, 404, { error: 'not found' }, method);
        return sendBytes(res, doc, 'application/json; charset=utf-8', method, { [SHA_HEADER]: sha256(doc) });
      }
      if (method === 'PUT') {
        const body = await readBody(req, MAX_DOC_BYTES);
        if (body === null) return sendJson(res, 413, { error: `A project.json may hold at most ${MAX_DOC_BYTES} bytes.` });
        const header = req.headers[BASE_SHA_HEADER];
        const raw = Array.isArray(header) ? header[0] : header;
        const base = raw === undefined ? undefined : raw === NO_BASE ? null : raw;
        if (base && !isSha256(base)) return sendJson(res, 400, { error: `${BASE_SHA_HEADER} must be a sha256 or ${NO_BASE}.` });
        return sendJson(res, 200, await store.writeDoc(id, body, base));
      }
      return sendJson(res, 405, { error: 'Use GET or PUT.' }, method);
    }
    if (part === 'assets') {
      if (sha === undefined) {
        if (method === 'GET') return sendJson(res, 200, { assets: await store.listAssets(id) });
        return sendJson(res, 405, { error: 'Use GET.' }, method);
      }
      if (!isSha256(sha)) return sendJson(res, 404, { error: 'not found' }, method);
      if (method === 'GET' || method === 'HEAD') return sendFile(res, store.assetPath(id, sha), method);
      if (method === 'PUT') return sendJson(res, 200, await store.writeAsset(id, sha, req));
      return sendJson(res, 405, { error: 'Use GET, HEAD or PUT.' }, method);
    }
    return sendJson(res, 404, { error: 'not found' }, method);
  };

  return (req, res, next) => {
    handle(req, res, next).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof FolderRequestError) {
        sendJson(res, error.status, { error: error.message }, req.method);
        return;
      }
      if (error instanceof URIError) {
        sendJson(res, 400, { error: 'Malformed path.' }, req.method);
        return;
      }
      log.error(`[cpg folder] ${req.method ?? ''} ${req.url ?? ''} failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      sendJson(res, 500, { error: error instanceof Error ? error.message : String(error) }, req.method);
    });
  };
}

// ---- the plugin

export interface ProjectFolderOptions {
  env?: PortEnv;
  home?: string;
  platform?: NodeJS.Platform;
  now?: () => Date;
  statfs?: (dir: string) => Promise<number>;
}

/** The Vite plugin (dev and preview servers). */
export function projectFolder(options: ProjectFolderOptions = {}): Plugin {
  let routes: Connect.NextHandleFunction | null = null;
  const setup = (root: string, logger: { info(m: string): void; warn(m: string): void; error(m: string): void }): Connect.NextHandleFunction => {
    if (routes) return routes;
    const log: Logger = { info: (m) => logger.info(m), warn: (m) => logger.warn(m), error: (m) => logger.error(m) };
    const decision = decideMirror({ env: options.env ?? process.env, root, home: options.home ?? os.homedir() });
    let store: FolderStore | null = null;
    if (decision.on) {
      store = createFolderStore({ projectsDir: decision.projectsDir, backupsDir: decision.backupsDir, now: options.now, statfs: options.statfs, log });
      log.info(`[cpg folder] Folder mirror on: ${decision.projectsDir} (backups in ${decision.backupsDir}).`);
      // Back up in the background: the server answers at once, and the first write creates the folder anyway.
      void store.start().catch((error: unknown) => log.error(`[cpg folder] Start-up failed: ${error instanceof Error ? error.message : String(error)}`));
    } else {
      log.warn(`[cpg folder] Folder mirror off: ${decision.reason}. ${decision.hint}`);
    }
    routes = folderRoutes(store, { platform: options.platform, log });
    return routes;
  };
  return {
    name: 'cpg:project-folder',
    configureServer(server) {
      server.middlewares.use(setup(server.config.root, server.config.logger));
    },
    configurePreviewServer(server) {
      server.middlewares.use(setup(server.config.root, server.config.logger));
    },
  };
}
