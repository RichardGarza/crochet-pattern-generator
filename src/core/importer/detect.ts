// Track T7 — §3.7.2 detection: magic bytes first, extension second.
import { extensionOf } from './common';
import { decodeText } from './text';

export type DetectedKind =
  | 'zip'
  | 'gzip'
  | 'tar'
  | 'glb'
  | 'gltf'
  | 'json'
  | 'html'
  | 'text'
  | 'obj'
  | 'mtl'
  | 'ply'
  | 'stl'
  | 'image'
  | 'pdf'
  | 'unknown';

const startsWith = (b: Uint8Array, sig: readonly number[], at = 0): boolean => sig.every((v, i) => b[at + i] === v);

/** How many leading bytes are decoded to sniff a text format. */
const SNIFF_BYTES = 4096;

/** True when the bytes look like text (no NUL in the first 4 KB; a UTF-16 BOM counts as text). */
function looksTextual(b: Uint8Array): boolean {
  if (b.length >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return true;
  const n = Math.min(b.length, SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (b[i] === 0) return false;
  return true;
}

/** The start of a text, lower-cased, without BOM, leading whitespace and leading HTML comments. */
function head(text: string): string {
  let t = text.replace(/^\uFEFF/, '').trimStart();
  while (t.startsWith('<!--')) {
    const end = t.indexOf('-->');
    if (end < 0) break;
    t = t.slice(end + 3).trimStart();
  }
  return t.slice(0, 512).toLowerCase();
}

/** HTML by its first tag: `<!doctype`, `<html`, `<head`, `<body`, `<script`, `<meta`. */
export function looksLikeHtml(text: string): boolean {
  return /^<(!doctype\s+html|html[\s>]|head[\s>]|body[\s>]|script[\s>/]|meta[\s/>]|title[\s>])/.test(head(text));
}

/** Detects a text format from its first characters (after BOM, whitespace and comments). */
export function detectText(text: string, name = ''): DetectedKind {
  const h = head(text);
  const ext = extensionOf(name);
  if (h.startsWith('{') || h.startsWith('[')) return ext === 'gltf' ? 'gltf' : 'json';
  if (looksLikeHtml(text)) return 'html';
  if (/^ply\r?\n/.test(h)) return 'ply';
  if (/^solid[ \t]/.test(h) && /\bfacet\b/.test(text.slice(0, SNIFF_BYTES))) return 'stl';
  if (/^(#[^\n]*\n|\s)*newmtl\s/m.test(h)) return 'mtl';
  if (/^(mtllib|o|g|v|vn|vt|f|usemtl)\s/m.test(h) && /^v\s+-?[\d.]/m.test(text.slice(0, 64 * 1024))) return 'obj';
  switch (ext) {
    case 'html':
    case 'htm':
      return 'html';
    case 'json':
      return 'json';
    case 'gltf':
      return 'gltf';
    case 'obj':
      return 'obj';
    case 'mtl':
      return 'mtl';
    case 'stl':
      return 'stl';
    case 'ply':
      return 'ply';
    default:
      return 'text';
  }
}

/** §3.7.2: magic bytes first (zip, gzip, tar, glb, images, pdf, ply, binary stl), then the text sniff, then the extension. */
export function detectFile(name: string, bytes: Uint8Array): DetectedKind {
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06])) return 'zip';
  if (startsWith(bytes, [0x1f, 0x8b])) return 'gzip';
  if (startsWith(bytes, [0x75, 0x73, 0x74, 0x61, 0x72], 257)) return 'tar'; // "ustar" (an unpacked .tar.gz)
  if (startsWith(bytes, [0x67, 0x6c, 0x54, 0x46])) return 'glb'; // "glTF"
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return 'image';
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return 'image';
  if (startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) && startsWith(bytes, [0x57, 0x45, 0x42, 0x50], 8)) return 'image';
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return 'image';
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'pdf'; // "%PDF-"
  if (startsWith(bytes, [0x70, 0x6c, 0x79, 0x0a]) || startsWith(bytes, [0x70, 0x6c, 0x79, 0x0d])) return 'ply';
  if (!looksTextual(bytes)) {
    if (bytes.length >= 84) {
      const n = (bytes[80] | (bytes[81] << 8) | (bytes[82] << 16) | (bytes[83] << 24)) >>> 0;
      if (84 + 50 * n === bytes.length) return 'stl';
    }
    // binary files whose header is off (an STL with a trailing byte, a PLY saved with CRLF quirks): the extension
    const ext = extensionOf(name);
    if (ext === 'stl' || ext === 'ply') return ext;
    return 'unknown';
  }
  const sniff = decodeText(bytes.subarray(0, SNIFF_BYTES * 4));
  return detectText(sniff, name);
}
