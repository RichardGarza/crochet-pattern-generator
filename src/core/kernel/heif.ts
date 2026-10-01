// HEIC/HEIF detection from a file's first bytes (DESIGN.md §2.3.1, §5.5.4). Step 0 kernel: pure, and on purpose
// without imports, so both the decode worker (workers/decode.ts re-exports it) and the folder plugin
// (scripts/project-folder.ts, loaded by Vite's config loader) use the same rule (design v1.5, T8 request 16).

/** The ISO-BMFF brands that mean HEIC/HEIF (§2.3.1). */
export const HEIF_BRANDS = ['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'] as const;
export type HeifBrand = (typeof HEIF_BRANDS)[number];

/** AVIF shares the `mif1` structural brand with HEIF, but Chrome decodes it and `sips` is not its converter. */
const AVIF_BRANDS: readonly string[] = ['avif', 'avis'];

const ascii = (bytes: Uint8Array, at: number): string => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

const isHeifBrand = (brand: string): brand is HeifBrand => (HEIF_BRANDS as readonly string[]).includes(brand);

/**
 * The HEIF brand of a file, from its first bytes (`SNIFF_BYTES` are plenty), or null when it is not HEIC/HEIF.
 *
 * ISO-BMFF starts with a `ftyp` box: size (4 bytes, big-endian), the type `ftyp` at offset 4, the major brand
 * at 8, a minor version at 12 and compatible brands from 16 to the end of the box. The major brand decides;
 * when it is not a HEIF brand the compatible brands are searched. A file that names an AVIF brand anywhere is
 * not HEIC (AVIF files list `mif1` too).
 */
export function sniffHeifBrand(bytes: Uint8Array): HeifBrand | null {
  if (bytes.length < 12) return null;
  if (ascii(bytes, 4) !== 'ftyp') return null;
  const size = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0;
  // size 1 means a 64-bit size follows and 0 means "to the end of the file": neither occurs for a real ftyp
  // box; read what is there.
  const end = size >= 16 ? Math.min(size, bytes.length) : bytes.length;
  const major = ascii(bytes, 8);
  const compatible: string[] = [];
  for (let at = 16; at + 4 <= end; at += 4) compatible.push(ascii(bytes, at));
  if (AVIF_BRANDS.includes(major) || compatible.some((brand) => AVIF_BRANDS.includes(brand))) return null;
  if (isHeifBrand(major)) return major;
  return compatible.find(isHeifBrand) ?? null;
}

