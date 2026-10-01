// Fixture privacy (DESIGN.md §6.1 rule 9). Step 0 owned.
//
// github.com/RichardGarza/crochet-pattern-generator is public, and phone photos normally carry GPS position,
// device and time. This test fails when an image that git tracks, or would add, still carries metadata.
//
//   - Every candidate file is identified by its magic bytes, not by its name, and scanned with
//     scripts/image-metadata.mjs (JPEG, PNG, WebP, GIF; HEIC, TIFF/raw and video containers are always refused).
//   - Images inside containers are scanned too: zip entries, gzip and tar.gz members, and `data:image/…;base64`
//     URIs in text files. Not opened: images inside a GLB, and assets packed into a standalone HTML bundle.
//
// The user's real photo sets under fixtures/images/3d/real/** are gitignored; they are committed only with the
// user's OK, after scripts/strip-exif.mjs has re-encoded them.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { findMetadata, sniffImage } from '../../../scripts/image-metadata.mjs';
import { encodePng } from '../../core/kernel/png';
import { solid } from '../rgba';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
/** Larger files are not read (GitHub refuses files over 100 MB anyway). */
const MAX_BYTES = 100 * 1024 * 1024;

const latin1 = new TextDecoder('latin1');
const startsWith = (bytes: Uint8Array, magic: number[]): boolean => magic.every((v, i) => bytes[i] === v);
const isZip = (bytes: Uint8Array): boolean => startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
const isGzip = (bytes: Uint8Array): boolean => startsWith(bytes, [0x1f, 0x8b]);
const isTar = (bytes: Uint8Array): boolean => bytes.length >= 512 && latin1.decode(bytes.subarray(257, 262)) === 'ustar';

/** The members of a tar archive (regular files only). */
function tarEntries(bytes: Uint8Array): { name: string; data: Uint8Array }[] {
  const entries: { name: string; data: Uint8Array }[] = [];
  let at = 0;
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const name = latin1.decode(header.subarray(0, 100)).split('\0')[0];
    const size = Number.parseInt(latin1.decode(header.subarray(124, 136)).replace(/[\0 ]/g, '') || '0', 8);
    const type = header[156];
    if (type === 0 || type === 0x30) entries.push({ name, data: bytes.subarray(at + 512, at + 512 + size) });
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return entries;
}

/**
 * Everything wrong with one file: its own metadata when it is an image, and the metadata of every image found
 * inside it when it is a container. `depth` stops archives nested in archives.
 */
function findings(name: string, bytes: Uint8Array, depth = 0): string[] {
  const kind = sniffImage(bytes);
  if (kind) return findMetadata(bytes, kind).map((f) => `${name}: ${f}`);
  if (depth > 2) return [];
  try {
    if (isZip(bytes)) {
      return Object.entries(unzipSync(bytes)).flatMap(([entry, data]) => findings(`${name}!/${entry}`, data, depth + 1));
    }
    if (isGzip(bytes)) return findings(`${name}!gunzip`, gunzipSync(bytes), depth + 1);
    if (isTar(bytes)) return tarEntries(bytes).flatMap((e) => findings(`${name}!/${e.name}`, e.data, depth + 1));
  } catch (error) {
    return [`${name}: this archive could not be opened to look for photos (${error instanceof Error ? error.message : String(error)})`];
  }
  // Text (or anything else): images embedded as base64 data URIs. JSON-escaped HTML writes "data:image\/png".
  const out: string[] = [];
  const text = latin1.decode(bytes);
  let n = 0;
  for (const m of text.matchAll(/data:image\\?\/[\w.+-]+;base64,((?:[A-Za-z0-9+=]|\\?\/)+)/g)) {
    n++;
    const embedded = new Uint8Array(Buffer.from(m[1].replaceAll('\\', ''), 'base64'));
    out.push(...findings(`${name}!data-uri-${n}`, embedded, depth + 1));
  }
  return out;
}

/** Every file git tracks or would add (untracked but not ignored), relative to the repository root. */
function candidateFiles(): string[] {
  try {
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    return out.split('\0').filter((f) => f.length > 0);
  } catch {
    // Not a git checkout (a source archive): walk the tree, skipping what .gitignore would skip.
    const skip = new Set(['.git', 'node_modules', 'dist', '.claude', '.cache', 'test-results', 'playwright-report', 'coverage']);
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, entry.name);
        if (skip.has(entry.name) || rel === 'public/ort' || rel === 'fixtures/images/3d/real') continue;
        if (entry.isDirectory()) walk(rel);
        else files.push(rel);
      }
    };
    walk('');
    return files;
  }
}

describe('fixture privacy (§6.1 rule 9)', () => {
  it('no tracked or addable image, loose or inside an archive, carries Exif, XMP, GPS or other metadata', () => {
    const offenders: string[] = [];
    let images = 0;
    for (const file of candidateFiles()) {
      const abs = path.join(ROOT, file);
      let size: number;
      try {
        const stat = statSync(abs);
        if (!stat.isFile()) continue;
        size = stat.size;
      } catch {
        continue; // deleted in the working tree but still in the index
      }
      if (size === 0) continue;
      if (size > MAX_BYTES) {
        offenders.push(`${file}: too large to scan (${size} bytes)`);
        continue;
      }
      const bytes = new Uint8Array(readFileSync(abs));
      if (sniffImage(bytes)) images++;
      offenders.push(...findings(file, bytes));
    }
    expect(offenders, `images with metadata — re-encode them with scripts/strip-exif.mjs:\n${offenders.join('\n')}`).toEqual([]);
    // The committed Claude Design render is always there, so a scan that finds no image is itself a bug.
    expect(images).toBeGreaterThan(0);
  });
});

// ---- the container walk, on crafted bytes (the scanner itself: scripts/__tests__/image-metadata.test.ts) ----

const ascii = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** A PNG from our own encoder, with an eXIf chunk inserted after IHDR when `exif` is true. */
function png(exif: boolean): Uint8Array {
  const base = encodePng(solid(2, 2, '#c8a27a'));
  if (!exif) return base;
  const chunk = [0, 0, 0, 8, ...ascii('eXIf'), 0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 0, 0, 0];
  return new Uint8Array([...base.subarray(0, 33), ...chunk, ...base.subarray(33)]);
}

function tar(name: string, data: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  header.set(ascii(name), 0);
  header.set(ascii(data.length.toString(8).padStart(11, '0')), 124);
  header[156] = 0x30;
  header.set(ascii('ustar'), 257);
  const body = new Uint8Array(Math.ceil(data.length / 512) * 512);
  body.set(data);
  return new Uint8Array([...header, ...body, ...new Uint8Array(1024)]);
}

describe('fixture privacy — what the scan looks into', () => {
  it('identifies images by content, whatever the file is called', () => {
    expect(findings('photo.txt', png(true))).toEqual(['photo.txt: eXIf chunk']);
    expect(findings('IMG_0001.jfif', png(true))).toEqual(['IMG_0001.jfif: eXIf chunk']);
    expect(findings('chart.png', png(false))).toEqual([]);
    expect(findings('IMG_0001.HEIC', new Uint8Array([0, 0, 0, 24, ...ascii('ftypheic'), 0, 0, 0, 0]))).toHaveLength(1);
    expect(findings('notes.md', new Uint8Array(ascii('# just text')))).toEqual([]);
  });

  it('opens zip archives', () => {
    const archive = zipSync({ 'page.html': new Uint8Array(ascii('<html></html>')), 'uploads/1-front.png': png(true), 'ok.png': png(false) });
    expect(findings('export.zip', archive)).toEqual(['export.zip!/uploads/1-front.png: eXIf chunk']);
    expect(findings('clean.zip', zipSync({ 'ok.png': png(false) }))).toEqual([]);
  });

  it('opens gzip files and tar.gz bundles', () => {
    expect(findings('photo.png.gz', gzipSync(png(true)))).toEqual(['photo.png.gz!gunzip: eXIf chunk']);
    const bundle = gzipSync(tar('project/uploads/2-left.png', png(true)));
    expect(findings('handoff.tar.gz', bundle)).toEqual(['handoff.tar.gz!gunzip!/project/uploads/2-left.png: eXIf chunk']);
    expect(findings('model.obj.gz', gzipSync(new Uint8Array(ascii('o body\nv 0 0 0\n'))))).toEqual([]);
  });

  it('decodes base64 data URIs in text, also JSON-escaped ones', () => {
    const b64 = Buffer.from(png(true)).toString('base64');
    const clean = Buffer.from(png(false)).toString('base64');
    const html = `<img src="data:image/png;base64,${clean}"><img src="data:image/png;base64,${b64}">`;
    expect(findings('page.html', new Uint8Array(ascii(html)))).toEqual(['page.html!data-uri-2: eXIf chunk']);
    const escaped = JSON.stringify({ template: `<img src="data:image/png;base64,${b64}">` }).replaceAll('/', '\\/');
    expect(findings('bundle.html', new Uint8Array(ascii(escaped)))).toEqual(['bundle.html!data-uri-1: eXIf chunk']);
  });

  it('reports an archive it cannot open instead of passing it', () => {
    const broken = zipSync({ 'a.png': png(true) }).subarray(0, 40);
    const result = findings('broken.zip', broken);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain('could not be opened');
  });
});
