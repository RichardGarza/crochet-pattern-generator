// Track T7 — archives (DESIGN.md §3.7.2, limits of §3.7.6): a small ZIP central-directory reader with the
// security limits, entry extraction with fflate (each entry inflated into a buffer of its declared size, as fflate's
// own `unzipSync` does, so a lying header cannot grow memory), path hygiene, and the choice among spec candidates
// with the "versions" chip.
import { inflateSync } from 'fflate';
import type { CrochetModelV1 } from '../../types/model';
import type { Repair, SpecCandidate } from '../../types/importer';
import { IMPORT_CODES, IMPORT_LIMITS, ImportFailure, issue } from './common';

export interface ZipEntry {
  /** As stored (UTF-8 when flagged, else CP437 read as Latin-1, like fflate). */
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  /** ms since 1970: the UT extra field when present, else the DOS date and time read as UTC (no time zone). */
  time: number;
  localOffset: number;
  isDirectory: boolean;
}

const u16 = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8);
const u32 = (b: Uint8Array, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, i: number): number => u32(b, i) + u32(b, i + 4) * 2 ** 32;

function dosTime(date: number, time: number): number {
  const year = 1980 + (date >> 9);
  const month = Math.max(1, (date >> 5) & 15);
  const day = Math.max(1, date & 31);
  return Date.UTC(year, month - 1, day, time >> 11, (time >> 5) & 63, (time & 31) * 2);
}

function decodeName(bytes: Uint8Array, utf8: boolean): string {
  if (utf8) return new TextDecoder().decode(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

const fail = (message: string, code: string = IMPORT_CODES.archive): never => {
  throw new ImportFailure(issue(code, 'error', message));
};

/**
 * Reads the central directory: entry names, sizes, methods and times, with ZIP64 records. Throws an
 * `ImportFailure` for a broken archive or one over the entry-count or total-size limit (§3.7.6).
 */
export function readZipDirectory(bytes: Uint8Array): ZipEntry[] {
  let e = bytes.length - 22;
  const lowest = Math.max(0, bytes.length - 22 - 65535);
  // the real record ends the file exactly (its comment included): a signature inside a comment is not it
  while (e >= lowest && !(u32(bytes, e) === 0x06054b50 && e + 22 + u16(bytes, e + 20) === bytes.length)) e--;
  if (e < lowest) fail('this is not a readable ZIP archive (no end-of-directory record)');
  let count = u16(bytes, e + 10);
  let offset = u32(bytes, e + 16);
  // ZIP64 end-of-central-directory locator just before the record
  if (e >= 20 && u32(bytes, e - 20) === 0x07064b50) {
    const z = u64(bytes, e - 12);
    if (z + 56 <= bytes.length && u32(bytes, z) === 0x06064b50) {
      count = u64(bytes, z + 32);
      offset = u64(bytes, z + 48);
    }
  }
  if (count > IMPORT_LIMITS.maxArchiveEntries) {
    fail(`the archive holds ${count} entries; at most ${IMPORT_LIMITS.maxArchiveEntries} are read`, IMPORT_CODES.tooLarge);
  }
  const entries: ZipEntry[] = [];
  let total = 0;
  for (let i = 0, o = offset; i < count; i++) {
    if (o + 46 > bytes.length || u32(bytes, o) !== 0x02014b50) fail('the archive directory is damaged');
    const flags = u16(bytes, o + 8);
    const method = u16(bytes, o + 10);
    let compressedSize = u32(bytes, o + 20);
    let size = u32(bytes, o + 24);
    const nameLength = u16(bytes, o + 28);
    const extraLength = u16(bytes, o + 30);
    const commentLength = u16(bytes, o + 32);
    let localOffset = u32(bytes, o + 42);
    if (o + 46 + nameLength + extraLength > bytes.length) fail('the archive directory is damaged');
    const name = decodeName(bytes.subarray(o + 46, o + 46 + nameLength), (flags & 0x800) !== 0);
    let time = dosTime(u16(bytes, o + 14), u16(bytes, o + 12));
    // extra fields: ZIP64 sizes (the 0xFFFFFFFF fields follow in order) and the UT timestamp (true UTC seconds)
    for (let x = o + 46 + nameLength, end = x + extraLength; x + 4 <= end; ) {
      const id = u16(bytes, x);
      const len = u16(bytes, x + 2);
      if (id === 0x0001) {
        let p = x + 4;
        const end64 = x + 4 + len;
        if (size === 0xffffffff && p + 8 <= end64) {
          size = u64(bytes, p);
          p += 8;
        }
        if (compressedSize === 0xffffffff && p + 8 <= end64) {
          compressedSize = u64(bytes, p);
          p += 8;
        }
        if (localOffset === 0xffffffff && p + 8 <= end64) localOffset = u64(bytes, p);
      } else if (id === 0x5455 && len >= 5 && (bytes[x + 4] & 1) !== 0) {
        time = u32(bytes, x + 5) * 1000;
      }
      x += 4 + len;
    }
    const isDirectory = name.endsWith('/');
    entries.push({ name, method, compressedSize, size, time, localOffset, isDirectory });
    total += size;
    if (total > IMPORT_LIMITS.maxUncompressedBytes) {
      fail(`the archive unpacks to more than ${IMPORT_LIMITS.maxUncompressedBytes / 2 ** 20} MB`, IMPORT_CODES.tooLarge);
    }
    o += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/** One entry's bytes (stored or deflated), never larger than its declared size. Throws on a damaged entry. */
export function zipEntryBytes(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  const o = entry.localOffset;
  if (o + 30 > bytes.length || u32(bytes, o) !== 0x04034b50) fail(`the archive entry "${entry.name}" is damaged`);
  const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
  const data = bytes.subarray(start, Math.min(bytes.length, start + entry.compressedSize));
  // the ratio rule on the bytes really there, not on the size the header claims
  if (entry.method === 8 && entry.size > IMPORT_LIMITS.maxEntryRatio * Math.max(data.length, 1)) {
    fail(`the archive entry "${entry.name}" would unpack to more than ${IMPORT_LIMITS.maxEntryRatio}× its packed size`, IMPORT_CODES.tooLarge);
  }
  if (entry.method === 0) return data.slice(0, entry.size);
  if (entry.method === 8) return inflateSync(data, { out: new Uint8Array(entry.size) });
  return fail(`the archive entry "${entry.name}" uses a compression this app does not read (method ${entry.method})`, IMPORT_CODES.unsupported);
}

export type PathVerdict = { ok: true; path: string } | { ok: false; skip: 'quiet' | 'warn'; reason: string };

/**
 * §3.7.6 path hygiene: reject `..` and absolute paths (with a warning), skip `__MACOSX/`, dotfiles and folders
 * quietly, and paths deeper than 12 levels with a warning. Backslashes count as separators.
 */
export function checkEntryPath(name: string): PathVerdict {
  const path = name.replace(/\\/g, '/');
  if (path.endsWith('/')) return { ok: false, skip: 'quiet', reason: 'folder' };
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) return { ok: false, skip: 'warn', reason: 'an absolute path' };
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.includes('..')) return { ok: false, skip: 'warn', reason: 'a path that climbs out of the archive ("..")' };
  if (parts.length > IMPORT_LIMITS.maxPathDepth) return { ok: false, skip: 'warn', reason: `a path deeper than ${IMPORT_LIMITS.maxPathDepth} levels` };
  if (parts.some((p) => p === '__MACOSX' || p.startsWith('.'))) return { ok: false, skip: 'quiet', reason: 'system file' };
  if (parts.length === 0) return { ok: false, skip: 'quiet', reason: 'empty name' };
  return { ok: true, path: parts.join('/') };
}

/** §3.7.6: an entry whose declared size is more than 100 × its compressed size is not unpacked. */
export function ratioTooHigh(entry: ZipEntry): boolean {
  if (entry.size === 0) return false;
  return entry.size > IMPORT_LIMITS.maxEntryRatio * Math.max(entry.compressedSize, 1);
}

// ---- spec candidates (§3.7.2)

/** A normalized, repaired, validated spec from one archive entry or dropped file. */
export interface Candidate {
  id: string;
  path: string;
  source: SpecCandidate['source'];
  model: CrochetModelV1;
  /** Hash of the canonical text, to merge identical candidates. */
  hash: string;
  time?: number;
  /** Discovery order: the last tie-break. */
  order: number;
}

/** The tie-break between equal revisions: the page that was rendered › a GLB spec › a chat fence › a JSON file. */
const SOURCE_RANK: Record<SpecCandidate['source'], number> = { html: 0, glb: 1, chat: 2, json: 3 };
const SOURCE_LABEL: Record<SpecCandidate['source'], string> = { html: 'page', glb: 'GLB', chat: 'chat', json: 'file' };

/** Preference order: highest revision, then html › glb › chat › json, then the newest entry, then discovery order. */
export function compareCandidates(a: Candidate, b: Candidate): number {
  if (a.model.revision !== b.model.revision) return b.model.revision - a.model.revision;
  if (SOURCE_RANK[a.source] !== SOURCE_RANK[b.source]) return SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  const ta = a.time ?? -Infinity;
  const tb = b.time ?? -Infinity;
  if (ta !== tb) return tb - ta;
  return a.order - b.order;
}

export interface CandidateChoice {
  chosen: Candidate;
  /** One per distinct spec (identical ones merged into the preferred copy), in preference order. */
  list: SpecCandidate[];
  repair?: Repair;
  /** `ctx.pickCandidate` named no candidate. */
  unknownPick?: string;
}

/**
 * §3.7.2: identical candidates are merged silently; the chosen one is `pick` when it names a candidate, else the
 * preferred one; when distinct versions remain, one `versions` repair says which were found and which is used.
 */
export function chooseCandidate(all: readonly Candidate[], pick?: string): CandidateChoice {
  const sorted = [...all].sort(compareCandidates);
  const distinct: Candidate[] = [];
  for (const c of sorted) if (!distinct.some((d) => d.hash === c.hash)) distinct.push(c);
  let chosen = distinct[0];
  let unknownPick: string | undefined;
  if (pick !== undefined) {
    const picked = sorted.find((c) => c.id === pick);
    if (picked) chosen = distinct.find((d) => d.hash === picked.hash) ?? picked;
    else unknownPick = pick;
  }
  const list: SpecCandidate[] = distinct.map((c) => ({
    id: c.id,
    path: c.path,
    source: c.source,
    revision: c.model.revision,
    parts: c.model.parts.length,
    chosen: c === chosen,
  }));
  let repair: Repair | undefined;
  if (distinct.length > 1) {
    const names = distinct.map((c) => `${SOURCE_LABEL[c.source]} rev ${c.model.revision}`);
    // "2 versions found: file rev 0, page rev 1 — using rev 1": oldest first, as in §3.7.7
    const shown = [...distinct].reverse().map((c) => `${SOURCE_LABEL[c.source]} rev ${c.model.revision}`);
    repair = {
      code: 'versions',
      message: `${distinct.length} versions found: ${shown.join(', ')} — using ${pick !== undefined && !unknownPick ? `${SOURCE_LABEL[chosen.source]} ` : ''}rev ${chosen.model.revision}`,
      data: { candidates: distinct.map((c) => c.id), chosen: chosen.id, versions: names },
    };
  }
  return { chosen, list, repair, unknownPick };
}
