import { describe, expect, it } from 'vitest';
import * as decode from '../../../workers/decode';
import { HEIF_BRANDS, sniffHeifBrand } from '../heif';

const ftyp = (major: string, compatible: string[] = []): Uint8Array => {
  const size = 16 + 4 * compatible.length;
  const out = new Uint8Array(size);
  new DataView(out.buffer).setUint32(0, size);
  const put = (s: string, at: number) => [...s].forEach((c, i) => (out[at + i] = c.charCodeAt(0)));
  put('ftyp', 4);
  put(major, 8);
  compatible.forEach((b, i) => put(b, 16 + 4 * i));
  return out;
};

describe('core/kernel/heif (shared by the decode worker and the folder plugin)', () => {
  it('is the very function workers/decode.ts exports', () => {
    expect(decode.sniffHeifBrand).toBe(sniffHeifBrand);
    expect(decode.HEIF_BRANDS).toBe(HEIF_BRANDS);
  });

  it('finds the brand by major, then compatible brands; AVIF anywhere is not HEIC', () => {
    expect(sniffHeifBrand(ftyp('heic', ['mif1', 'heic']))).toBe('heic');
    expect(sniffHeifBrand(ftyp('isom', ['mif1']))).toBe('mif1');
    expect(sniffHeifBrand(ftyp('avif', ['mif1']))).toBeNull();
    expect(sniffHeifBrand(ftyp('mif1', ['avif']))).toBeNull();
    expect(sniffHeifBrand(ftyp('isom', ['mp41']))).toBeNull();
    expect(sniffHeifBrand(new Uint8Array(8))).toBeNull();
  });

  it('has no imports (the Vite config loader runs it through the folder plugin)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../heif.ts', import.meta.url), 'utf8');
    expect(src).not.toMatch(/^\s*import\s/m);
  });
});
