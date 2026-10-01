// Track T8 — the `/__projects` protocol of the folder mirror (DESIGN.md §5.5.4), shared by the Vite plugin
// (`scripts/project-folder.ts`, the server) and the app's client (`folderClient.ts`). Types, routes, headers
// and the folder-safe project id rule; no Node or DOM API.
//
//   HEAD   /__projects                         200 + x-cpg-mirror: on  ·  204 + x-cpg-mirror: off (refused / no folder)
//   GET    /__projects                         FolderListing (id, rev, doc sha256, updatedAt, name, mode; folder status)
//   GET    /__projects/<id>/doc                the project.json bytes (+ x-cpg-sha256)
//   PUT    /__projects/<id>/doc                PutDocResult; header x-cpg-base-sha256 = the sha the client last
//                                              synced, or `none` ("the folder must not have it"); without the
//                                              header the write is unconditional
//   GET    /__projects/<id>/assets             { assets: sha256[] }   (the client uploads only what is missing)
//   HEAD   /__projects/<id>/assets/<sha256>    200 / 404
//   GET    /__projects/<id>/assets/<sha256>    the bytes
//   PUT    /__projects/<id>/assets/<sha256>    PutAssetResult (hash checked; an existing asset is never rewritten)
//   DELETE /__projects/<id>                    DeleteResult (the folder moves to Backups/deleted/<id>-<stamp>/)
//   GET    /__backups                          BackupListing
//   GET    /__backups/<backup>/<id>/doc        a backed-up project.json
//   GET    /__backups/assets/<sha256>          a backed-up asset
//
// Expected outcomes (a conflict, an asset that exists) answer 200 with `ok` in the body: Chromium logs every
// answer ≥ 400 as a console error, and the e2e suite fails on console errors. 4xx/5xx mean a broken request
// or a server fault.
import type { FreeSpaceLevel } from './backups.ts';

export const PROJECTS_ROUTE = '/__projects';
export const BACKUPS_ROUTE = '/__backups';
export const CONVERT_ROUTE = '/__convert';

/** The mirror probe's answer header: `on` or `off`. */
export const MIRROR_HEADER = 'x-cpg-mirror';
/** `POST /__convert` answers `off` (JSON) when there is no converter here. */
export const CONVERT_HEADER = 'x-cpg-convert';
/** The doc sha256 the client last synced (`none`: the folder must not have the project). */
export const BASE_SHA_HEADER = 'x-cpg-base-sha256';
export const NO_BASE = 'none';
/** sha256 of a served project.json. */
export const SHA_HEADER = 'x-cpg-sha256';

/** Largest project.json the server accepts. */
export const MAX_DOC_BYTES = 64 * 1024 * 1024;
/** Largest single asset the server accepts. */
export const MAX_ASSET_BYTES = 512 * 1024 * 1024;

/**
 * Project ids the folder accepts as folder names: a letter or digit, then letters, digits, `.`, `_`, `-`
 * (≤ 200). App ids are `crypto.randomUUID()`; anything else (an imported file's odd id) is not mirrored.
 * Rules out `..`, hidden names, separators and names the reserved folders could clash with.
 */
export function isFolderProjectId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id);
}

export const isSha256 = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

/** One project in the folder (the list of §5.5.4 plus what the restore list shows). */
export interface FolderProjectEntry {
  id: string;
  rev: number;
  docSha256: string;
  updatedAt: string;
  name: string;
  mode: '2d' | '3d';
  /** Bytes of project.json. */
  bytes: number;
}

/** What a backup run did (the newest one is shown in the restore dialog). */
export type BackupRunResult =
  | { status: 'created'; name: string; at: string; projects: number; newAssets: number; newBytes: number; pruned: string[] }
  | { status: 'unchanged'; at: string; newest: string }
  | { status: 'empty'; at: string }
  | { status: 'skipped-low-space'; at: string; freeBytes: number }
  | { status: 'failed'; at: string; message: string };

export interface FolderStatus {
  /** Absolute path of the projects folder (Settings shows it). */
  folder: string;
  backupsFolder: string;
  /** Free bytes on the folder's disk (null: unknown). */
  freeBytes: number | null;
  level: FreeSpaceLevel | null;
  /** The free-space warning, or null. */
  message: string | null;
  lastBackup: BackupRunResult | null;
}

export interface FolderListing {
  projects: FolderProjectEntry[];
  /** Folders whose project.json could not be read (kept, never deleted). */
  damaged: string[];
  status: FolderStatus;
}

export type PutDocResult =
  | { ok: true; sha256: string; written: boolean }
  /** The folder's doc is not the one the client last synced (`sha256` null: the folder has none). */
  | { ok: false; reason: 'conflict'; sha256: string | null };

export interface PutAssetResult {
  ok: true;
  /** The folder had it already (it was not rewritten). */
  existed: boolean;
}

export interface DeleteResult {
  ok: true;
  /** Where the folder went (`Backups/deleted/<id>-<stamp>`), or null when there was none. */
  movedTo: string | null;
}

export interface BackupProjectSummary {
  id: string;
  name: string;
  mode: '2d' | '3d';
  updatedAt: string;
  rev: number;
  docSha256: string;
  assets: string[];
}

export interface BackupSummary {
  /** The folder name `YYYY-MM-DD-HHMM[-N]`. */
  name: string;
  at: string;
  projects: BackupProjectSummary[];
}

export interface BackupListing {
  backups: BackupSummary[];
}

/** manifest.json of one backup. */
export interface BackupManifest {
  format: 'cpg-backup';
  version: 1;
  hash: string;
  at: string;
  projects: BackupProjectSummary[];
}

export const projectUrl = (id: string): string => `${PROJECTS_ROUTE}/${encodeURIComponent(id)}`;
export const docUrl = (id: string): string => `${projectUrl(id)}/doc`;
export const assetsUrl = (id: string): string => `${projectUrl(id)}/assets`;
export const assetUrl = (id: string, sha: string): string => `${assetsUrl(id)}/${sha}`;
export const backupDocUrl = (backup: string, id: string): string => `${BACKUPS_ROUTE}/${encodeURIComponent(backup)}/${encodeURIComponent(id)}/doc`;
export const backupAssetUrl = (sha: string): string => `${BACKUPS_ROUTE}/assets/${sha}`;
