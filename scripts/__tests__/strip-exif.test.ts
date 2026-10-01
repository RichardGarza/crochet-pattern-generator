import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decodePng, encodePng } from '../../src/core/kernel/png.ts';
import { fromFn } from '../../src/test/rgba.ts';

const SCRIPT = fileURLToPath(new URL('../strip-exif.mjs', import.meta.url));
const tmp = mkdtempSync(path.join(os.tmpdir(), 'cpg-strip-test-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function run(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: tmp });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** Width and height from a JPEG's start-of-frame segment. */
function jpegSize(bytes: Uint8Array): { w: number; h: number } {
  let at = 2;
  while (at + 9 < bytes.length && bytes[at] === 0xff) {
    const marker = bytes[at + 1];
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: (bytes[at + 5] << 8) | bytes[at + 6], w: (bytes[at + 7] << 8) | bytes[at + 8] };
    }
    at += 2 + length;
  }
  throw new Error('no SOF segment');
}

/** The APP1 segments of a JPEG header, by their identifier. */
function app1Ids(bytes: Uint8Array): string[] {
  const ids: string[] = [];
  let at = 2;
  while (at + 4 <= bytes.length && bytes[at] === 0xff && bytes[at + 1] !== 0xda) {
    const length = (bytes[at + 2] << 8) | bytes[at + 3];
    if (bytes[at + 1] === 0xe1) ids.push(String.fromCharCode(...bytes.subarray(at + 4, at + 10)));
    at += 2 + length;
  }
  return ids;
}

/** An Exif APP1 segment: Orientation = `orientation`, plus a GPS IFD with a latitude (what a phone writes). */
function exifSegment(orientation: number): Uint8Array {
  const tiff: number[] = [];
  const u16 = (v: number) => tiff.push((v >> 8) & 255, v & 255);
  const u32 = (v: number) => tiff.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
  tiff.push(0x4d, 0x4d); // big-endian
  u16(42);
  u32(8); // IFD0 at offset 8
  u16(2); // two entries
  u16(0x0112); // Orientation, SHORT × 1
  u16(3);
  u32(1);
  u16(orientation);
  u16(0);
  u16(0x8825); // GPS IFD pointer, LONG × 1
  u16(4);
  u32(1);
  u32(8 + 2 + 2 * 12 + 4); // right after IFD0
  u32(0); // no next IFD
  u16(2); // GPS IFD: two entries
  u16(0x0001); // GPSLatitudeRef, ASCII × 2: "N\0"
  u16(2);
  u32(2);
  tiff.push(0x4e, 0, 0, 0);
  u16(0x0002); // GPSLatitude, RATIONAL × 3
  u16(5);
  u32(3);
  u32(tiff.length + 4 + 4); // the three rationals follow the IFD
  u32(0);
  for (const [num, den] of [
    [37, 1],
    [46, 1],
    [2994, 100],
  ]) {
    u32(num);
    u32(den);
  }
  const payload = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff]; // "Exif\0\0"
  return new Uint8Array([0xff, 0xe1, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload]);
}

function insertAfterSoi(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  return new Uint8Array([...jpeg.subarray(0, 2), ...segment, ...jpeg.subarray(2)]);
}

describe('scripts/strip-exif.mjs — arguments', () => {
  it('prints its usage with --help', () => {
    const r = run(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Usage: node scripts/strip-exif.mjs');
    expect(r.stdout).toContain('The originals are never changed');
  });

  it('exits 2 on bad arguments', () => {
    for (const args of [[], ['--quality', '7', 'a.jpg'], ['--format', 'gif', 'a.jpg'], ['--nope', 'a.jpg'], ['--max'], ['--max', '0', 'a.jpg']]) {
      const r = run(args);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('strip-exif:');
      expect(r.stderr).toContain('Usage:');
    }
  });

  it('exits 1 on a missing file and on a file that is not an image, before starting a browser', () => {
    const missing = run(['nowhere.jpg']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('nowhere.jpg: no such file');
    writeFileSync(path.join(tmp, 'notes.jpg'), 'this is not a picture');
    const text = run(['notes.jpg']);
    expect(text.status).toBe(1);
    expect(text.stderr).toContain('not a JPEG, PNG, WebP or HEIC/HEIF image');
    expect(existsSync(path.join(tmp, 'stripped'))).toBe(false);
  });
});

describe('scripts/strip-exif.mjs — the originals are never overwritten', () => {
  // Enough of a JPEG to be recognized; these runs stop before any browser starts.
  const fakeJpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xd9]);
  const dir = path.join(tmp, 'originals');

  it('refuses an output that is the original itself, with or without --force', () => {
    mkdirSync(dir, { recursive: true });
    const original = path.join(dir, 'photo.jpg');
    writeFileSync(original, fakeJpeg);
    for (const args of [['--out', '.', 'photo.jpg'], ['--force', '--out', '.', 'photo.jpg']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: dir });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('is the original photo.jpg itself');
      expect(new Uint8Array(readFileSync(original))).toEqual(fakeJpeg);
    }
  });

  it('refuses it also when only the letter case of the name differs (one file on a case-insensitive disk)', () => {
    mkdirSync(dir, { recursive: true });
    const original = path.join(dir, 'IMG_0007.JPG');
    writeFileSync(original, fakeJpeg);
    const sameFileOnThisDisk = existsSync(path.join(dir, 'IMG_0007.jpg'));
    for (const args of [['--out', '.', 'IMG_0007.JPG'], ['--force', '--out', '.', 'IMG_0007.JPG']]) {
      const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', cwd: dir });
      if (sameFileOnThisDisk) {
        expect(r.status).toBe(1);
        expect(r.stderr).toContain('is the original IMG_0007.JPG itself');
      }
      // Whatever the disk does with letter case, the original keeps its bytes.
      expect(new Uint8Array(readFileSync(original))).toEqual(fakeJpeg);
    }
  });

  it('refuses two photos that would land in one output file', () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'a.jpeg'), fakeJpeg);
    writeFileSync(path.join(dir, 'a.webp'), new Uint8Array([...Buffer.from('RIFF'), 4, 0, 0, 0, ...Buffer.from('WEBP')]));
    const r = spawnSync(process.execPath, [SCRIPT, '--out', 'out', 'a.jpeg', 'a.webp'], { encoding: 'utf8', cwd: dir });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('two photos would be written');
    expect(existsSync(path.join(dir, 'out'))).toBe(false);
  });
});

// The real thing needs Playwright's Chromium (installed on the development machine; skipped where it is not).
// The path is asked for in a child process: @playwright/test and Vitest cannot share one process (both install
// the global expect matchers).
function chromiumInstalled(): boolean {
  const ask = "import { chromium } from '@playwright/test'; process.stdout.write(chromium.executablePath());";
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', ask], { encoding: 'utf8', cwd: path.dirname(path.dirname(SCRIPT)) });
  return r.status === 0 && r.stdout.trim().length > 0 && existsSync(r.stdout.trim());
}
const hasChromium = chromiumInstalled();

describe('scripts/strip-exif.mjs — re-encoding through headless Chromium', () => {
  it.runIf(hasChromium)(
    'removes Exif and GPS, applies the orientation, and never touches the original',
    () => {
      // 40 × 20, left half red, right half blue.
      const png = encodePng(fromFn(40, 20, (x) => (x < 20 ? '#e00000' : '#0000e0')));
      writeFileSync(path.join(tmp, 'flag.png'), png);

      // 1. PNG → a clean JPEG (the only way to get JPEG bytes here without a JPEG encoder of our own).
      const first = run(['--format', 'jpeg', '--quality', '1', '--out', 'a', 'flag.png']);
      expect(first.stderr).toBe('');
      expect(first.status).toBe(0);
      const clean = new Uint8Array(readFileSync(path.join(tmp, 'a', 'flag.jpg')));
      expect(jpegSize(clean)).toEqual({ w: 40, h: 20 });
      expect(app1Ids(clean)).toEqual([]);

      // 2. Make it look like a phone photo: Exif with Orientation 6 (stored sideways) and a GPS latitude.
      const phone = insertAfterSoi(clean, exifSegment(6));
      const phonePath = path.join(tmp, 'IMG_0001.jpg');
      writeFileSync(phonePath, phone);
      expect(app1Ids(phone)).toEqual(['Exif\0\0']);

      // 3. Strip it.
      const second = run(['--quality', '1', 'IMG_0001.jpg']);
      expect(second.stderr).toBe('');
      expect(second.status).toBe(0);
      expect(second.stdout).toContain('removed: APP1 Exif');
      const stripped = new Uint8Array(readFileSync(path.join(tmp, 'stripped', 'IMG_0001.jpg')));
      expect(app1Ids(stripped)).toEqual([]);
      expect(Buffer.from(stripped).includes(Buffer.from('Exif'))).toBe(false);
      // Orientation 6 = "rotate 90° clockwise to display": 40 × 20 stored → 20 × 40 upright.
      expect(jpegSize(stripped)).toEqual({ w: 20, h: 40 });
      // The original is byte-for-byte what it was.
      expect(new Uint8Array(readFileSync(phonePath))).toEqual(phone);

      // 4. Upright means: the stored left column (red) is now the top, the stored right column (blue) the bottom.
      const third = run(['--format', 'png', '--out', 'b', path.join('stripped', 'IMG_0001.jpg')]);
      expect(third.status).toBe(0);
      const upright = decodePng(new Uint8Array(readFileSync(path.join(tmp, 'b', 'IMG_0001.png'))));
      expect([upright.w, upright.h]).toEqual([20, 40]);
      const at = (x: number, y: number) => Array.from(upright.data.subarray((y * 20 + x) * 4, (y * 20 + x) * 4 + 3));
      const [topR, , topB] = at(10, 5);
      const [bottomR, , bottomB] = at(10, 34);
      expect(topR).toBeGreaterThan(180);
      expect(topB).toBeLessThan(60);
      expect(bottomB).toBeGreaterThan(180);
      expect(bottomR).toBeLessThan(60);

      // 5. It refuses to overwrite an existing copy unless --force is given.
      const again = run(['IMG_0001.jpg']);
      expect(again.status).toBe(1);
      expect(again.stderr).toContain('already exists');
      expect(run(['--force', 'IMG_0001.jpg']).status).toBe(0);
    },
    90_000,
  );

  it.runIf(hasChromium && process.platform === 'darwin')(
    'converts a HEIC made with sips and strips it',
    () => {
      const png = encodePng(fromFn(32, 24, (x, y) => [x * 8, y * 10, 128]));
      writeFileSync(path.join(tmp, 'gradient.png'), png);
      execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', path.join(tmp, 'gradient.png'), '--out', path.join(tmp, 'IMG_0002.HEIC')], {
        stdio: 'ignore',
      });
      const r = run(['--out', 'heic-out', 'IMG_0002.HEIC']);
      expect(r.stderr).toBe('');
      expect(r.status).toBe(0);
      const out = new Uint8Array(readFileSync(path.join(tmp, 'heic-out', 'IMG_0002.jpg')));
      expect(jpegSize(out)).toEqual({ w: 32, h: 24 });
      expect(app1Ids(out)).toEqual([]);
    },
    90_000,
  );
});
