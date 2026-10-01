// Finds metadata carriers in encoded images (DESIGN.md §6.1 rule 9). Step 0 owned.
//
// Shared by scripts/strip-exif.mjs (which proves its own output clean) and by
// src/test/__tests__/fixturePrivacy.test.ts (which scans every image git tracks). Types: image-metadata.d.mts.
//
// The scanner fails closed. An image whose structure cannot be walked to its end, or that carries a segment
// or chunk this file does not know to be harmless, is reported — a wrong report costs a re-encode, a missed
// one can publish where a photo was taken. What counts as clean is, in short, what a canvas re-encode
// produces: pixels, color information and nothing else.

const latin1 = new TextDecoder('latin1');

/** @param {Uint8Array} bytes @param {number} start @param {number} length */
const ascii = (bytes, start, length) => latin1.decode(bytes.subarray(start, Math.min(bytes.length, start + length)));

const u32be = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b, at) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

/** ISO-BMFF brands of still images in the HEIF family (HEIC from phones, AVIF). */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'avif', 'avis']);

/**
 * The container format, from the magic bytes (never from the file name), or undefined when the bytes are not
 * an image or video this scanner knows.
 * @param {Uint8Array} bytes
 * @returns {'jpeg' | 'png' | 'webp' | 'gif' | 'heif' | 'tiff' | 'video' | undefined}
 */
export function sniffImage(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 7) === 'PNG\r\n\x1a\n') return 'png';
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return 'webp';
  if (bytes.length >= 6 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) return 'gif';
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp') return HEIF_BRANDS.has(ascii(bytes, 8, 4)) ? 'heif' : 'video';
  if (bytes.length >= 4 && (ascii(bytes, 0, 4) === 'II*\0' || ascii(bytes, 0, 4) === 'MM\0*')) return 'tiff';
  return undefined;
}

/** Assertion labels that put Exif, IPTC or author data into a C2PA (content credentials) manifest. */
const PERSONAL_C2PA = ['stds.exif', 'stds.iptc', 'stds.schema-org', 'exif:', 'GPSLatitude'];

/** @param {Uint8Array} bytes @param {number} start @param {number} end */
function c2paFindings(bytes, start, end, where) {
  const text = latin1.decode(bytes.subarray(start, end));
  return PERSONAL_C2PA.some((label) => text.includes(label)) ? [`${where} C2PA manifest with Exif, IPTC or author assertions`] : [];
}

/** @param {Uint8Array} bytes @returns {string[]} */
function scanJpeg(bytes) {
  const found = [];
  const n = bytes.length;
  let at = 2;
  for (;;) {
    if (at + 2 > n) return [...found, 'malformed JPEG: no end-of-image marker'];
    if (bytes[at] !== 0xff) return [...found, `malformed JPEG: unexpected byte at offset ${at}`];
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at += 1; // fill byte
      continue;
    }
    at += 2;
    if (marker === 0xd9) break; // end of image
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue; // markers without a length
    if (marker === 0x00 || at + 2 > n) return [...found, `malformed JPEG: bad marker at offset ${at - 2}`];
    const length = (bytes[at] << 8) | bytes[at + 1];
    if (length < 2 || at + length > n) return [...found, `malformed JPEG: segment at offset ${at - 2} runs past the end`];
    const id = ascii(bytes, at + 2, Math.min(length - 2, 40));

    if (marker === 0xe1) {
      if (id.startsWith('Exif\0')) found.push('APP1 Exif');
      else if (id.startsWith('http://ns.adobe.com/xap/1.0/')) found.push('APP1 XMP');
      else if (id.startsWith('http://ns.adobe.com/xmp/extension/')) found.push('APP1 extended XMP');
      else found.push('APP1 (unrecognized metadata)');
    } else if (marker === 0xe2) {
      if (id.startsWith('MPF\0')) found.push('APP2 MPF (more images are appended)');
      else if (!id.startsWith('ICC_PROFILE\0')) found.push('APP2 (unrecognized metadata)');
    } else if (marker === 0xed) {
      found.push('APP13 IPTC / Photoshop');
    } else if (marker === 0xee) {
      if (!id.startsWith('Adobe')) found.push('APP14 (unrecognized metadata)');
    } else if (marker >= 0xe3 && marker <= 0xef) {
      found.push(`APP${marker - 0xe0} (unrecognized metadata)`);
    } else if (marker === 0xe0) {
      if (!id.startsWith('JFIF\0') && !id.startsWith('JFXX\0')) found.push('APP0 (unrecognized metadata)');
    } else if (marker === 0xfe) {
      found.push('COM comment');
    }
    at += length;

    if (marker === 0xda) {
      // Entropy-coded data follows the scan header: skip to the next real marker. Inside it 0xFF is always
      // followed by 0x00 (a stuffed byte) or a restart marker.
      while (at < n) {
        if (bytes[at] !== 0xff) {
          at += 1;
          continue;
        }
        const next = bytes[at + 1];
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7)) at += 2;
        else if (next === 0xff) at += 1;
        else break;
      }
    }
  }
  if (at < n) found.push(`${n - at} bytes after the end of the image`);
  return found;
}

/** @param {Uint8Array} bytes @returns {string[]} */
function scanPng(bytes) {
  const found = [];
  const n = bytes.length;
  let at = 8;
  for (;;) {
    if (at + 12 > n) return [...found, 'malformed PNG: no IEND chunk'];
    const length = u32be(bytes, at);
    const type = ascii(bytes, at + 4, 4);
    const body = at + 8;
    if (body + length + 4 > n) return [...found, `malformed PNG: ${type} chunk runs past the end`];
    if (type === 'eXIf') found.push('eXIf chunk');
    else if (type === 'tIME') found.push('tIME chunk (modification time)');
    else if (type === 'caBX') found.push(...c2paFindings(bytes, body, body + length, 'caBX'));
    else if (type === 'iTXt' || type === 'tEXt' || type === 'zTXt') {
      const keyword = ascii(bytes, body, Math.min(length, 79)).split('\0')[0];
      if (keyword === 'XML:com.adobe.xmp') found.push(`${type} XMP`);
      else if (/^Raw profile type /i.test(keyword)) found.push(`${type} ${keyword}`);
      else if (keyword !== 'Software') found.push(`${type} text "${keyword}"`);
    }
    at = body + length + 4;
    if (type === 'IEND') break;
  }
  if (at < n) found.push(`${n - at} bytes after the end of the image`);
  return found;
}

const WEBP_PIXEL_CHUNKS = new Set(['VP8 ', 'VP8L', 'VP8X', 'ALPH', 'ANIM', 'ANMF', 'ICCP']);

/** @param {Uint8Array} bytes @returns {string[]} */
function scanWebp(bytes) {
  const found = [];
  const n = bytes.length;
  const end = 8 + u32le(bytes, 4);
  if (end > n) return ['malformed WebP: the RIFF size runs past the end'];
  let at = 12;
  while (at < end) {
    if (at + 8 > end) return [...found, 'malformed WebP: truncated chunk header'];
    const type = ascii(bytes, at, 4);
    const length = u32le(bytes, at + 4);
    const body = at + 8;
    if (body + length > end) return [...found, `malformed WebP: ${type} chunk runs past the end`];
    if (type === 'EXIF') found.push('EXIF chunk');
    else if (type === 'XMP ') found.push('XMP chunk');
    else if (type === 'C2PA') found.push(...c2paFindings(bytes, body, body + length, 'WebP'));
    else if (!WEBP_PIXEL_CHUNKS.has(type)) found.push(`unknown chunk "${type}"`);
    at = body + length + (length & 1);
  }
  if (end + (end & 1) < n) found.push(`${n - end} bytes after the end of the image`);
  return found;
}

/**
 * The metadata carriers found in an encoded image; an empty list means clean.
 *
 * - JPEG: every APPn segment except JFIF/JFXX (APP0), an ICC profile (APP2) and Adobe's color transform
 *   (APP14) — so Exif, XMP, IPTC, MPF and unknown blocks — comment segments, bytes after the end-of-image
 *   marker, and a header that cannot be walked.
 * - PNG: eXIf, tIME, every text chunk except "Software", a C2PA manifest with Exif/IPTC/author assertions,
 *   bytes after IEND, and a chunk list that cannot be walked.
 * - WebP: EXIF and XMP chunks, unknown chunks, a C2PA manifest as above, trailing bytes, a broken RIFF layout.
 * - GIF: an XMP application extension.
 * - HEIC/HEIF/AVIF, TIFF and camera raw, QuickTime/MP4: always reported; they carry metadata by design and
 *   must be converted first (scripts/strip-exif.mjs converts HEIC).
 *
 * @param {Uint8Array} bytes
 * @param {ReturnType<typeof sniffImage>} [kind] defaults to sniffImage(bytes)
 * @returns {string[]}
 */
export function findMetadata(bytes, kind = sniffImage(bytes)) {
  switch (kind) {
    case 'jpeg':
      return scanJpeg(bytes);
    case 'png':
      return scanPng(bytes);
    case 'webp':
      return scanWebp(bytes);
    case 'gif':
      return latin1.decode(bytes).includes('XMP DataXMP') ? ['XMP application extension'] : [];
    case 'heif':
      return ['HEIC / HEIF / AVIF container (carries Exif; convert it and strip it first)'];
    case 'tiff':
      return ['TIFF or camera raw container (carries Exif; convert it and strip it first)'];
    case 'video':
      return ['QuickTime / MP4 container (carries location and device metadata)'];
    default:
      return [];
  }
}
