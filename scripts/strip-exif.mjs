#!/usr/bin/env node
// Re-encodes photos without metadata (DESIGN.md §6.1 rule 9). Step 0 owned.
//
// This repository is public, and phone photos normally carry GPS position, device and time. A photo may be
// committed only with the user's explicit OK, and only as a copy made by this script: the image is decoded by
// headless Chromium with its EXIF orientation applied, drawn on a canvas and encoded again, so the copy holds
// pixels and nothing else. HEIC / HEIF (iPhone originals) is converted with `sips` first (macOS only).
//
// An original is never changed, replaced or deleted — also not with --force, and also not when the output
// name differs from it only in upper and lower case (this disk treats those as one file). Each copy is checked
// with scripts/image-metadata.mjs before it is written; src/test/__tests__/fixturePrivacy.test.ts then checks
// every image that git tracks.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findMetadata, sniffImage } from './image-metadata.mjs';

const USAGE = `Usage: node scripts/strip-exif.mjs [options] <photo> [<photo> ...]

Writes a copy of each photo with the EXIF orientation applied and no metadata
(no Exif, XMP, GPS position, device or time). The originals are never changed.

  JPEG, WebP          -> <out>/<name>.jpg
  PNG                 -> <out>/<name>.png
  HEIC, HEIF (macOS)  -> converted with sips, then <out>/<name>.jpg

Options:
  --out <dir>       output folder (default: a "stripped" folder next to each photo)
  --format <f>      jpeg | png | keep   (default keep: PNG stays PNG, everything else becomes JPEG)
  --quality <q>     JPEG quality, 0..1 (default 0.92)
  --max <px>        scale the long side down to at most <px> pixels (default: keep the size)
  --force           overwrite output files that already exist
  -h, --help        show this text

Example (a real photo set, docs/CAPTURE.md):
  node scripts/strip-exif.mjs fixtures/images/3d/real/plush/*.jpg
  # copies land in fixtures/images/3d/real/plush/stripped/, which stays gitignored;
  # commit them only with the owner's OK (git add -f).`;

class UsageError extends Error {}

function parseArgs(argv) {
  const options = { out: undefined, format: 'keep', quality: 0.92, max: undefined, force: false, help: false, inputs: [] };
  const value = (i, flag) => {
    if (i + 1 >= argv.length) throw new UsageError(`${flag} needs a value`);
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') options.help = true;
    else if (arg === '--force') options.force = true;
    else if (arg === '--out') options.out = value(i++, arg);
    else if (arg === '--format') {
      options.format = value(i++, arg);
      if (!['jpeg', 'png', 'keep'].includes(options.format)) throw new UsageError('--format must be jpeg, png or keep');
    } else if (arg === '--quality') {
      options.quality = Number(value(i++, arg));
      if (!(options.quality > 0 && options.quality <= 1)) throw new UsageError('--quality must be a number in (0, 1]');
    } else if (arg === '--max') {
      options.max = Number(value(i++, arg));
      if (!Number.isInteger(options.max) || options.max < 1) throw new UsageError('--max must be a whole number of pixels');
    } else if (arg.startsWith('-') && arg !== '-') throw new UsageError(`unknown option ${arg}`);
    else options.inputs.push(arg);
  }
  return options;
}

/** True when both paths exist and are the same file on disk (same device and inode). */
function sameFile(a, b) {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/** HEIC / HEIF → JPEG bytes through sips (macOS). sips keeps the Exif block, so the orientation survives. */
function heifToJpeg(file) {
  if (process.platform !== 'darwin') {
    throw new Error('HEIC / HEIF can only be converted on macOS (sips). Export the photo as JPEG and run this script on that.');
  }
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cpg-strip-'));
  try {
    const out = path.join(dir, 'converted.jpg');
    execFileSync('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '92', file, '--out', out], {
      timeout: 20000,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return new Uint8Array(readFileSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs in the page: decode with the orientation applied, draw, encode. Returns base64 and the pixel size. */
async function reencodeInPage({ base64, mime, outMime, quality, max }) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }), { imageOrientation: 'from-image' });
  const scale = max ? Math.min(1, max / Math.max(bitmap.width, bitmap.height)) : 1;
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  const blob = await canvas.convertToBlob({ type: outMime, quality });
  const out = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < out.length; i += 0x8000) binary += String.fromCharCode(...out.subarray(i, i + 0x8000));
  return { base64: btoa(binary), width, height };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return 0;
  }
  if (options.inputs.length === 0) throw new UsageError('no photos given');

  // Plan every output before touching anything, so one bad argument stops the whole run.
  const jobs = options.inputs.map((input) => {
    const file = path.resolve(input);
    if (!existsSync(file)) throw new Error(`${input}: no such file`);
    const original = new Uint8Array(readFileSync(file));
    const kind = sniffImage(original);
    if (kind !== 'jpeg' && kind !== 'png' && kind !== 'webp' && kind !== 'heif') {
      throw new Error(`${input}: not a JPEG, PNG, WebP or HEIC/HEIF image`);
    }
    const outKind = options.format === 'keep' ? (kind === 'png' ? 'png' : 'jpeg') : options.format;
    const outDir = options.out ? path.resolve(options.out) : path.join(path.dirname(file), 'stripped');
    const outFile = path.join(outDir, `${path.parse(file).name}.${outKind === 'png' ? 'png' : 'jpg'}`);
    return { input, file, original, kind, outKind, outDir, outFile };
  });
  const display = (file) => path.relative(process.cwd(), file) || file;
  const seen = new Set();
  for (const job of jobs) {
    // An output that IS one of the originals is refused whatever the flags say. The comparison is by file
    // identity, not by name: on a case-insensitive disk IMG_0001.jpg and IMG_0001.JPG are the same file.
    const original = jobs.find((other) => sameFile(job.outFile, other.file));
    if (original) {
      throw new Error(`${display(job.outFile)} is the original ${original.input} itself; choose another --out folder (originals are never overwritten)`);
    }
    if (existsSync(job.outFile) && !options.force) {
      throw new Error(`${display(job.outFile)} already exists (use --force to overwrite it)`);
    }
    const key = job.outFile.toLowerCase();
    if (seen.has(key)) throw new Error(`two photos would be written to ${display(job.outFile)}; run them separately or rename one`);
    seen.add(key);
  }

  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch();
  let failed = 0;
  try {
    const page = await browser.newPage();
    for (const job of jobs) {
      try {
        const removed = findMetadata(job.original, job.kind);
        const source = job.kind === 'heif' ? heifToJpeg(job.file) : job.original;
        const sourceKind = job.kind === 'heif' ? 'jpeg' : job.kind;
        const result = await page.evaluate(reencodeInPage, {
          base64: Buffer.from(source).toString('base64'),
          mime: `image/${sourceKind}`,
          outMime: `image/${job.outKind}`,
          quality: options.quality,
          max: options.max,
        });
        const out = new Uint8Array(Buffer.from(result.base64, 'base64'));
        const left = findMetadata(out);
        if (sniffImage(out) !== job.outKind || left.length > 0) {
          throw new Error(`the re-encoded copy is not clean (${left.join(', ') || 'unexpected format'}); nothing was written`);
        }
        mkdirSync(job.outDir, { recursive: true });
        writeFileSync(job.outFile, out);
        const kb = (out.length / 1024).toFixed(0);
        console.log(
          `${job.input} -> ${display(job.outFile)}  ${result.width} x ${result.height}, ${kb} kB` +
            (removed.length > 0 ? `  (removed: ${removed.join(', ')})` : '  (no metadata found in the original)'),
        );
      } catch (error) {
        failed++;
        console.error(`${job.input}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } finally {
    await browser.close();
  }
  return failed > 0 ? 1 : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof UsageError) {
      console.error(`strip-exif: ${error.message}\n\n${USAGE}`);
      process.exitCode = 2;
    } else {
      console.error(`strip-exif: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  },
);
