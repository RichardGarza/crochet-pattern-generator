// Track T7 — shared pieces of the importer (DESIGN.md §3.7): issue codes, limits, the spec candidates every carrier
// reports, and the error classes that stop a carrier. No DOM anywhere in core/importer.
import type { Issue } from '../../types/issues';
import type { Repair, SpecCandidate } from '../../types/importer';

/** Input and archive limits of §3.7.6. */
export const IMPORT_LIMITS = {
  /** One input file, or every input together. */
  maxInputBytes: 100 * 1024 * 1024,
  maxArchiveEntries: 2000,
  /** Sum of the uncompressed sizes of an archive (also caps the decoded assets of a standalone page). */
  maxUncompressedBytes: 300 * 1024 * 1024,
  /** Uncompressed : compressed, per archive entry. */
  maxEntryRatio: 100,
  /** Folders + file name. */
  maxPathDepth: 12,
} as const;

/**
 * Issue codes the importer raises (`ImportResult.warnings`). `E_*` = nothing usable was imported from that input;
 * `W_*` = imported, but look at this. `W_GAP` is the shared rule of §2.13.
 */
export const IMPORT_CODES = {
  /** No crochet-model spec anywhere in the input (§3.7.4 E8): offer the fix-up message. */
  noModel: 'E_IMPORT_NO_MODEL',
  /** A spec was found but its JSON could not be read. */
  parse: 'E_IMPORT_PARSE',
  /** The spec was read but is not a valid model even after the repairs. */
  invalid: 'E_IMPORT_INVALID',
  /** A forbidden key (`__proto__`, `constructor`, `prototype`) or an unsafe archive path. */
  unsafe: 'E_IMPORT_UNSAFE',
  /** Over a size, entry-count or ratio limit. */
  tooLarge: 'E_IMPORT_TOO_LARGE',
  /** A broken archive. */
  archive: 'E_IMPORT_ARCHIVE',
  /** A format this build does not read (yet). */
  unsupported: 'E_IMPORT_UNSUPPORTED',
  /** A whole-project `.crochet.json` (§5.5.3): imported through the library, not here. */
  projectFile: 'E_IMPORT_PROJECT_FILE',
  /** A part's gap to its parent is above 0.1 in (§2.13). */
  gap: 'W_GAP',
  /** A part thinner than MIN_FEATURE_IN across (§3.7.6). */
  minFeature: 'W_MIN_FEATURE',
  /** A part type we do not know, replaced by its bounding ellipsoid (§3.5.2). */
  unknownType: 'W_IMPORT_TYPE',
  /** An HTML page without any fingerprint we know (§3.7.4 "format drift"). */
  formatDrift: 'W_FORMAT_DRIFT',
  /** An unknown named HTML entity, kept verbatim (§3.7.4). */
  entity: 'W_HTML_ENTITY',
  /** An archive entry that was skipped (unsafe path, too deep, ratio). */
  entrySkipped: 'W_ARCHIVE_ENTRY',
  /** A spec candidate of an archive that could not be used (the others were). */
  candidate: 'W_IMPORT_CANDIDATE',
  /** A value the importer had to make up (missing position, dims). */
  defaulted: 'W_IMPORT_DEFAULTED',
} as const;

export function issue(code: string, severity: Issue['severity'], message: string, where?: Issue['where']): Issue {
  return where ? { code, severity, message, where } : { code, severity, message };
}

/** A spec one carrier found, before normalization (§3.7.2). */
export interface FoundSpec {
  /** The parsed JSON value (passed the forbidden-key reviver). */
  raw: unknown;
  source: SpecCandidate['source'];
  /** Archive entry path or file name; `'(pasted text)'` for text. */
  path: string;
  /** Which rung found it, for diagnostics: `E1/E2 #crochet-model`, `fence`, `E4 brace scan`, … */
  how: string;
  confidence: 'high' | 'medium' | 'low';
  /** Archive entry time (ms since 1970, UTC), for the tie-break of §3.7.2. */
  time?: number;
}

/** Thrown inside a carrier to stop it with one issue (caught by `importInputs`). */
export class ImportFailure extends Error {
  readonly issue: Issue;
  constructor(issue: Issue) {
    super(issue.message);
    this.name = 'ImportFailure';
    this.issue = issue;
  }
}

/** The JSON reviver found a forbidden key (§3.7.6 security). */
export class ForbiddenKeyError extends Error {
  readonly key: string;
  constructor(key: string) {
    super(`the key "${key}" is never allowed in an import (it could change how the app's objects behave)`);
    this.name = 'ForbiddenKeyError';
    this.key = key;
  }
}

/**
 * `table[key]` only for the table's own keys: imported strings such as `"constructor"` or `"__proto__"` must never
 * reach `Object.prototype` through a lookup table.
 */
export function lookup<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/**
 * How deep a value nests (a scalar 0, `[]` 1, `[[1]]` 2), iteratively (no stack overflow on hostile input);
 * stops counting once `cap` is passed.
 */
export function depthOf(value: unknown, cap = Infinity): number {
  if (typeof value !== 'object' || value === null) return 0;
  let max = 1;
  const stack: [unknown, number][] = [[value, 1]];
  let seen = 0;
  while (stack.length > 0 && seen++ < 1_000_000) {
    const [v, d] = stack.pop() as [unknown, number];
    if (typeof v !== 'object' || v === null) continue;
    max = Math.max(max, d);
    if (max > cap) return max;
    for (const child of Array.isArray(v) ? v : Object.values(v)) stack.push([child, d + 1]);
  }
  return max;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lower-cased extension without the dot (`'html'`, `'json'`, …); `''` when there is none. */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * The repair steps of §3.7.6, in their order. Chips are listed in this order whatever step found them (the
 * dialect normalization finds unknown keys and radians before the repairs run).
 */
export const REPAIR_STAGES = ['versions', 'limits', 'id', 'unknown-key', 'units', 'radians', 'ground', 'axes', 'color', 'dims', 'attach', 'mirror'] as const;
export type RepairStage = (typeof REPAIR_STAGES)[number];

/** Chips of one code in one stage before the rest are summed up. */
export const MAX_CHIPS_PER_CODE = 20;

/** Repairs collected per stage; `all()` lists them in the order of §3.7.6. */
export class RepairLog {
  private readonly stages = new Map<RepairStage, Repair[]>();
  add(stage: RepairStage, repair: Repair): void {
    const list = this.stages.get(stage);
    if (list) list.push(repair);
    else this.stages.set(stage, [repair]);
  }
  addAll(stage: RepairStage, repairs: readonly Repair[]): void {
    for (const r of repairs) this.add(stage, r);
  }
  /** The chips in stage order; more than 20 of one code in a stage are summed up in one more chip. */
  all(): Repair[] {
    return REPAIR_STAGES.flatMap((s) => {
      const list = this.stages.get(s) ?? [];
      const out: Repair[] = [];
      const counts = new Map<string, number>();
      for (const r of list) {
        const n = (counts.get(r.code) ?? 0) + 1;
        counts.set(r.code, n);
        if (n <= MAX_CHIPS_PER_CODE) out.push(r);
      }
      for (const [code, n] of counts) {
        if (n > MAX_CHIPS_PER_CODE) {
          out.push({ code: code as Repair['code'], message: `… and ${n - MAX_CHIPS_PER_CODE} more like these`, data: { more: n - MAX_CHIPS_PER_CODE } });
        }
      }
      return out;
    });
  }
}
