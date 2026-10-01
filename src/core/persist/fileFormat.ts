// Track T8 — the `.crochet.json` project file (DESIGN.md §5.5.3): one JSON file with the project, its assets
// (base64, each with its sha256) and its snapshots.
//
//   { "format": "crochet-project-file", "version": 1, "exportedAt": "…",
//     "app": { "name": "crochet-pattern-generator", "version": "0.1.0" },
//     "project": ProjectDoc, "assets": { "<key>": { "mime", "sha256", "base64" } },
//     "revisions": [ { "rev", "at", "label", "doc": ProjectDoc } ] }
//
// Reading validates the envelope with zod, checks every asset's hash against its bytes and its key, and runs
// the document migrations. It never writes anything: import policy (never overwrite) is the repository's.
import { z } from 'zod';
import { CODE_VERSION } from '../kernel/hash';
import type { ProjectDoc } from '../../types/project';
import { ASSET_KEY, SHA256_HEX, base64ToBytes, bytesToBase64, sha256Hex, shaOfKey } from './assets';
import { MigrationError, migrateDoc } from './migrations';

export const FILE_FORMAT = 'crochet-project-file';
export const FILE_VERSION = 1;
export const FILE_EXTENSION = '.crochet.json';
export const FILE_MIME = 'application/json';
export const APP_NAME = 'crochet-pattern-generator';

export interface ProjectFileAsset {
  mime: string;
  sha256: string;
  base64: string;
}

export interface ProjectFileRevision {
  rev: number;
  at: string;
  label: string;
  doc: ProjectDoc;
}

export interface ProjectFile {
  format: typeof FILE_FORMAT;
  version: typeof FILE_VERSION;
  exportedAt: string;
  app: { name: string; version: string };
  project: ProjectDoc;
  assets: Record<string, ProjectFileAsset>;
  revisions: ProjectFileRevision[];
}

export type ProjectFileErrorCode = 'not-json' | 'not-a-project-file' | 'newer-version' | 'invalid' | 'hash-mismatch';

export class ProjectFileError extends Error {
  readonly code: ProjectFileErrorCode;
  constructor(code: ProjectFileErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProjectFileError';
    this.code = code;
  }
}

/** What `isProjectId` (state/appStore) accepts: non-empty, ≤ 200 chars, no `/`, whitespace or control chars, no lone surrogate. */
export function isValidProjectId(id: unknown): id is string {
  return (
    typeof id === 'string' &&
    id.length > 0 &&
    id.length <= 200 &&
    // eslint-disable-next-line no-control-regex
    !/[/\s\u0000-\u001f\u007f]/.test(id) &&
    !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(id)
  );
}

/** Revs stay far below 2^53, so `rev + 1` is always exact (a crafted file cannot break compare-and-swap). */
export const MAX_REV = 2 ** 40;

const isoTime = z.string().refine((s) => Number.isFinite(Date.parse(s)), 'not a time');

/** The fields every document needs before it can be stored or listed; the rest is kept as it is. */
const docSchema = z.looseObject({
  schema: z.literal('crochet-project'),
  version: z.number().int().min(1),
  id: z.string().refine(isValidProjectId, 'not a valid project id'),
  name: z.string(),
  createdAt: isoTime,
  updatedAt: isoTime,
  rev: z.number().int().min(0).max(MAX_REV),
  mode: z.enum(['2d', '3d']),
  sources: z.array(z.unknown()),
  imports: z.array(z.unknown()),
});

const revisionSchema = z.object({ rev: z.number().int().min(0).max(MAX_REV), at: isoTime, label: z.string(), doc: z.unknown() });

const fileSchema = z.object({
  format: z.literal(FILE_FORMAT),
  version: z.number().int().min(1),
  exportedAt: z.string(),
  app: z.looseObject({ name: z.string(), version: z.string() }).optional(),
  project: z.unknown(),
  assets: z.record(
    z.string().regex(ASSET_KEY, 'not an asset key'),
    z.object({ mime: z.string(), sha256: z.string().regex(SHA256_HEX, 'not a sha256'), base64: z.string() }),
  ),
  // Checked one by one below: a damaged snapshot is left out, not a reason to refuse the backup.
  revisions: z.array(z.unknown()).default([]),
});

/** Checks the document fields the repository relies on; throws `ProjectFileError('invalid')`. */
export function checkDoc(doc: unknown, where = 'project'): ProjectDoc {
  const r = docSchema.safeParse(doc);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new ProjectFileError('invalid', `The ${where} is damaged: ${issue ? `${issue.path.join('.') || 'document'}: ${issue.message}` : 'invalid'}.`);
  }
  return doc as ProjectDoc;
}

/** Builds the file object from a document, its assets and its snapshots (nothing is read from storage here). */
export async function buildProjectFile(input: {
  doc: ProjectDoc;
  assets: ReadonlyMap<string, Blob>;
  revisions?: readonly ProjectFileRevision[];
  now?: Date;
}): Promise<ProjectFile> {
  const assets: Record<string, ProjectFileAsset> = {};
  for (const key of [...input.assets.keys()].sort()) {
    const blob = input.assets.get(key) as Blob;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    assets[key] = { mime: blob.type || 'application/octet-stream', sha256: await sha256Hex(bytes), base64: bytesToBase64(bytes) };
  }
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    exportedAt: (input.now ?? new Date()).toISOString(),
    app: { name: APP_NAME, version: CODE_VERSION },
    project: input.doc,
    assets,
    revisions: [...(input.revisions ?? [])].sort((a, b) => a.rev - b.rev),
  };
}

/** The file's text. */
export const serializeProjectFile = (file: ProjectFile): string => JSON.stringify(file);

/** The file as a downloadable Blob. */
export const projectFileBlob = (file: ProjectFile): Blob => new Blob([serializeProjectFile(file)], { type: FILE_MIME });

/** A file name for the project: its name made safe for file systems, plus `.crochet.json`. */
export function projectFileName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const safe = name.replace(/[\u0000-\u001f\u007f<>:"/\\|?*]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120).replace(/^\.+/, '');
  return `${safe || 'Crochet project'}${FILE_EXTENSION}`;
}

export interface ParsedProjectFile {
  /** The project, migrated to the current version. */
  doc: ProjectDoc;
  /** The project's version in the file (for "Before update" snapshots). */
  migratedFrom: number | null;
  /** The document as it was in the file. */
  original: ProjectDoc;
  assets: Map<string, Blob>;
  revisions: ProjectFileRevision[];
  /** Snapshots left out: damaged, of a newer version, or a second one with the same rev. */
  skippedRevisions: number;
}

/**
 * Reads a `.crochet.json` file. Throws `ProjectFileError`: not JSON, not a project file, a file or project
 * format newer than this app, a damaged envelope or document, an asset whose bytes do not match its hash or
 * whose key names another hash.
 */
export async function parseProjectFile(input: Blob | string): Promise<ParsedProjectFile> {
  const text = typeof input === 'string' ? input : await input.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    throw new ProjectFileError('not-json', 'This file is not a Crochet Pattern Generator project (it is not JSON).', { cause: error });
  }
  if (typeof json !== 'object' || json === null || (json as { format?: unknown }).format !== FILE_FORMAT) {
    throw new ProjectFileError('not-a-project-file', 'This file is not a Crochet Pattern Generator project file.');
  }
  const version = (json as { version?: unknown }).version;
  if (typeof version === 'number' && version > FILE_VERSION) {
    throw new ProjectFileError('newer-version', 'This project file was made by a newer version of the app; update the app to import it.');
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProjectFileError('invalid', `The project file is damaged: ${issue ? `${issue.path.join('.') || 'file'}: ${issue.message}` : 'invalid'}.`);
  }
  const file = parsed.data;

  const migrate = (raw: unknown, where: string): { doc: ProjectDoc; from: number; migrated: boolean } => {
    try {
      const r = migrateDoc(raw);
      checkDoc(r.doc, where);
      return r;
    } catch (error) {
      if (error instanceof MigrationError) {
        throw new ProjectFileError(error.code === 'newer-version' ? 'newer-version' : 'invalid', error.message, { cause: error });
      }
      throw error;
    }
  };

  const original = checkDoc(file.project);
  const project = migrate(file.project, 'project');
  // A damaged snapshot does not cost the user the whole backup: it is left out (and counted).
  const revisions: ProjectFileRevision[] = [];
  const seen = new Set<number>();
  let skippedRevisions = 0;
  for (const [i, raw] of file.revisions.entries()) {
    try {
      const r = revisionSchema.parse(raw);
      if (seen.has(r.rev)) throw new Error('a second snapshot with the same rev');
      revisions.push({ rev: r.rev, at: r.at, label: r.label, doc: migrate(r.doc, `snapshot ${i + 1}`).doc });
      seen.add(r.rev);
    } catch {
      skippedRevisions++;
    }
  }

  const assets = new Map<string, Blob>();
  for (const [key, a] of Object.entries(file.assets)) {
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      bytes = base64ToBytes(a.base64);
    } catch (error) {
      throw new ProjectFileError('invalid', `The asset ${key} is damaged (not base64).`, { cause: error });
    }
    const actual = await sha256Hex(bytes);
    if (actual !== a.sha256 || shaOfKey(key) !== a.sha256) {
      throw new ProjectFileError('hash-mismatch', `The asset ${key} is damaged: its contents do not match its hash.`);
    }
    assets.set(key, new Blob([bytes], { type: a.mime }));
  }
  return { doc: project.doc, migratedFrom: project.migrated ? project.from : null, original, assets, revisions, skippedRevisions };
}
