import { describe, expect, it } from 'vitest';
import { encodePng } from '../../src/core/kernel/png.ts';
import { solid } from '../../src/test/rgba.ts';
import { findMetadata, sniffImage } from '../image-metadata.mjs';

const text = (s: string): number[] => Array.from(new TextEncoder().encode(s));

/** A structurally valid JPEG: SOI, JFIF, the given segments, a scan header, entropy-coded data, EOI. */
function jpeg(segments: { marker: number; payload: number[] | Uint8Array }[] = [], trailer: number[] = []): Uint8Array {
  const parts: number[] = [0xff, 0xd8];
  const jfif = [...text('JFIF\0'), 1, 1, 0, 0, 1, 0, 1, 0, 0];
  parts.push(0xff, 0xe0, 0, jfif.length + 2, ...jfif);
  for (const s of segments) {
    const payload = Array.from(s.payload);
    parts.push(0xff, s.marker, ((payload.length + 2) >> 8) & 255, (payload.length + 2) & 255, ...payload);
  }
  // scan header, then data with a stuffed 0xFF and a restart marker, as real scans have
  parts.push(0xff, 0xda, 0, 2, 0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9, ...trailer);
  return new Uint8Array(parts);
}

function pngChunk(type: string, body: number[]): number[] {
  // The scanner does not verify CRCs, so test chunks carry a zero CRC.
  return [(body.length >>> 24) & 255, (body.length >>> 16) & 255, (body.length >>> 8) & 255, body.length & 255, ...text(type), ...body, 0, 0, 0, 0];
}

/** A PNG from our own encoder with extra chunks inserted right after IHDR. */
function png(chunks: number[][] = [], trailer: number[] = []): Uint8Array {
  const base = encodePng(solid(2, 2, '#c8a27a'));
  const head = 8 + 25;
  return new Uint8Array([...base.subarray(0, head), ...chunks.flat(), ...base.subarray(head), ...trailer]);
}

function webp(chunks: [type: string, body: number[]][], trailer: number[] = []): Uint8Array {
  const body: number[] = [];
  for (const [type, data] of chunks) body.push(...text(type), data.length & 255, (data.length >> 8) & 255, 0, 0, ...data, ...(data.length & 1 ? [0] : []));
  const size = 4 + body.length;
  return new Uint8Array([...text('RIFF'), size & 255, (size >> 8) & 255, 0, 0, ...text('WEBP'), ...body, ...trailer]);
}

describe('sniffImage', () => {
  it('goes by the magic bytes', () => {
    expect(sniffImage(jpeg())).toBe('jpeg');
    expect(sniffImage(png())).toBe('png');
    expect(sniffImage(webp([['VP8L', [1, 2]]]))).toBe('webp');
    expect(sniffImage(new Uint8Array(text('GIF89a\x01\x00')))).toBe('gif');
    expect(sniffImage(new Uint8Array([0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0]))).toBe('heif');
    expect(sniffImage(new Uint8Array([0, 0, 0, 28, ...text('ftypavif'), 0, 0, 0, 0]))).toBe('heif');
    expect(sniffImage(new Uint8Array([0, 0, 0, 20, ...text('ftypqt  '), 0, 0, 0, 0]))).toBe('video');
    expect(sniffImage(new Uint8Array([0, 0, 0, 20, ...text('ftypisom'), 0, 0, 0, 0]))).toBe('video');
    expect(sniffImage(new Uint8Array([...text('II*'), 0, 8, 0, 0, 0]))).toBe('tiff');
    expect(sniffImage(new Uint8Array([...text('MM'), 0, 42, 0, 0, 0, 8]))).toBe('tiff');
    expect(sniffImage(new Uint8Array(text('<!doctype html>')))).toBeUndefined();
    expect(sniffImage(new Uint8Array(text('{"schema":"crochet-model"}')))).toBeUndefined();
    expect(sniffImage(new Uint8Array(0))).toBeUndefined();
  });
});

describe('findMetadata — JPEG', () => {
  it('passes what a canvas re-encode produces, with or without an ICC profile or the Adobe marker', () => {
    expect(findMetadata(jpeg())).toEqual([]);
    expect(findMetadata(jpeg([{ marker: 0xe2, payload: text('ICC_PROFILE\0\x01\x01profile bytes') }]))).toEqual([]);
    expect(findMetadata(jpeg([{ marker: 0xee, payload: text('Adobe\0d\0\0\0\0\0') }]))).toEqual([]);
    expect(findMetadata(jpeg([{ marker: 0xdb, payload: new Uint8Array(65) }]))).toEqual([]);
  });

  it('flags Exif and XMP in APP1', () => {
    expect(findMetadata(jpeg([{ marker: 0xe1, payload: [...text('Exif\0\0'), 0x4d, 0x4d, 0, 42, 0, 0, 0, 8] }]))).toEqual(['APP1 Exif']);
    expect(findMetadata(jpeg([{ marker: 0xe1, payload: text('http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>') }]))).toEqual(['APP1 XMP']);
    expect(findMetadata(jpeg([{ marker: 0xe1, payload: text('http://ns.adobe.com/xmp/extension/\0abc') }]))).toEqual(['APP1 extended XMP']);
    expect(findMetadata(jpeg([{ marker: 0xe1, payload: text('SomethingElse') }]))).toEqual(['APP1 (unrecognized metadata)']);
  });

  it('flags IPTC, MPF, comments and unknown application segments', () => {
    expect(findMetadata(jpeg([{ marker: 0xed, payload: text('Photoshop 3.0\x008BIM\x04\x04byline') }]))).toEqual(['APP13 IPTC / Photoshop']);
    expect(findMetadata(jpeg([{ marker: 0xe2, payload: text('MPF\0MM\0*') }]))).toEqual(['APP2 MPF (more images are appended)']);
    expect(findMetadata(jpeg([{ marker: 0xe2, payload: text('FPXR\0') }]))).toEqual(['APP2 (unrecognized metadata)']);
    expect(findMetadata(jpeg([{ marker: 0xeb, payload: text('JP\0\0jumb c2pa') }]))).toEqual(['APP11 (unrecognized metadata)']);
    expect(findMetadata(jpeg([{ marker: 0xec, payload: text('Ducky') }]))).toEqual(['APP12 (unrecognized metadata)']);
    expect(findMetadata(jpeg([{ marker: 0xfe, payload: text('shot at home') }]))).toEqual(['COM comment']);
  });

  it('finds a segment behind a long one, and several at once', () => {
    const big = new Uint8Array(60000).fill(7);
    expect(findMetadata(jpeg([{ marker: 0xe2, payload: [...text('ICC_PROFILE\0'), ...big] }, { marker: 0xe1, payload: text('Exif\0\0GPS') }]))).toEqual(['APP1 Exif']);
    expect(
      findMetadata(
        jpeg([
          { marker: 0xe1, payload: text('Exif\0\0') },
          { marker: 0xe1, payload: text('http://ns.adobe.com/xap/1.0/\0') },
          { marker: 0xed, payload: text('Photoshop 3.0\0') },
        ]),
      ),
    ).toEqual(['APP1 Exif', 'APP1 XMP', 'APP13 IPTC / Photoshop']);
  });

  it('reports data after the end of the image (a second picture appended by a phone, for example)', () => {
    const second = Array.from(jpeg([{ marker: 0xe1, payload: text('Exif\0\0GPS') }]));
    expect(findMetadata(jpeg([], second))).toEqual([`${second.length} bytes after the end of the image`]);
    expect(findMetadata(jpeg([], [0]))).toEqual(['1 bytes after the end of the image']);
  });

  it('fails closed on a header it cannot walk', () => {
    // one junk byte before an Exif segment must not make the file look clean
    const good = jpeg([{ marker: 0xe1, payload: text('Exif\0\0') }]);
    const junk = new Uint8Array([...good.subarray(0, 20), 0x00, ...good.subarray(20)]);
    expect(findMetadata(junk).some((f) => f.startsWith('malformed JPEG'))).toBe(true);
    // truncated files: no end-of-image marker, or a segment that runs past the end
    expect(findMetadata(good.subarray(0, good.length - 2))).toContain('malformed JPEG: no end-of-image marker');
    expect(findMetadata(good.subarray(0, 24)).some((f) => f.startsWith('malformed JPEG'))).toBe(true);
    expect(findMetadata(new Uint8Array([0xff, 0xd8, 0xff]))).toEqual(['malformed JPEG: no end-of-image marker']);
    // every cut of a clean file is reported as something, never as clean
    const clean = jpeg();
    for (let cut = 3; cut < clean.length; cut++) expect(findMetadata(clean.subarray(0, cut)).length).toBeGreaterThan(0);
  });
});

describe('findMetadata — PNG', () => {
  it('passes our own encoder and harmless chunks', () => {
    expect(findMetadata(png())).toEqual([]);
    expect(findMetadata(png([pngChunk('gAMA', [0, 0, 0xb1, 0x8f]), pngChunk('sRGB', [0]), pngChunk('pHYs', [0, 0, 11, 19, 0, 0, 11, 19, 1])]))).toEqual([]);
    expect(findMetadata(png([pngChunk('tEXt', text('Software\0our encoder'))]))).toEqual([]);
  });

  it('flags eXIf, tIME, XMP, raw profiles and other text', () => {
    expect(findMetadata(png([pngChunk('eXIf', [0x4d, 0x4d, 0, 42, 0, 0, 0, 8])]))).toEqual(['eXIf chunk']);
    expect(findMetadata(png([pngChunk('tIME', [7, 234, 10, 1, 12, 0, 0])]))).toEqual(['tIME chunk (modification time)']);
    expect(findMetadata(png([pngChunk('iTXt', text('XML:com.adobe.xmp\0\0\0\0\0<x:xmpmeta/>'))]))).toEqual(['iTXt XMP']);
    expect(findMetadata(png([pngChunk('zTXt', text('Raw profile type exif\0\0abc'))]))).toEqual(['zTXt Raw profile type exif']);
    expect(findMetadata(png([pngChunk('tEXt', text('Raw profile type iptc\0abc'))]))).toEqual(['tEXt Raw profile type iptc']);
    expect(findMetadata(png([pngChunk('tEXt', text('Author\0Someone'))]))).toEqual(['tEXt text "Author"']);
    expect(findMetadata(png([pngChunk('tEXt', text('date:create\x002026-10-01'))]))).toEqual(['tEXt text "date:create"']);
  });

  it('reports bytes after IEND and fails closed on a broken chunk list', () => {
    expect(findMetadata(png([], [1, 2, 3]))).toEqual(['3 bytes after the end of the image']);
    const good = png();
    expect(findMetadata(good.subarray(0, good.length - 12))).toEqual(['malformed PNG: no IEND chunk']);
    expect(findMetadata(good.subarray(0, good.length - 1)).some((f) => f.startsWith('malformed PNG'))).toBe(true);
    for (let cut = 8; cut < good.length; cut++) expect(findMetadata(good.subarray(0, cut)).length).toBeGreaterThan(0);
  });
});

describe('findMetadata — WebP and the other containers', () => {
  it('passes pixel chunks and flags EXIF, XMP and unknown chunks', () => {
    expect(findMetadata(webp([['VP8L', [1, 2, 3]]]))).toEqual([]);
    expect(findMetadata(webp([['VP8X', [0, 0, 0]], ['ICCP', [1, 2]], ['VP8 ', [3]]]))).toEqual([]);
    expect(findMetadata(webp([['VP8X', [0, 0, 0]], ['EXIF', [1, 2]], ['XMP ', [3]]]))).toEqual(['EXIF chunk', 'XMP chunk']);
    expect(findMetadata(webp([['VP8L', [1]], ['ABCD', [1]]]))).toEqual(['unknown chunk "ABCD"']);
  });

  it('accepts a C2PA manifest unless it holds Exif, IPTC or author assertions', () => {
    // Claude Design signs its thumbnails with content credentials: provenance, no camera data.
    expect(findMetadata(webp([['VP8 ', [1]], ['C2PA', text('jumbc2pa c2pa.actions.v2 Anthropic c2pa.hash.data')]]))).toEqual([]);
    expect(findMetadata(webp([['VP8 ', [1]], ['C2PA', text('jumbc2pa stds.exif exif:GPSLatitude 37,46.5N')]]))).toEqual([
      'WebP C2PA manifest with Exif, IPTC or author assertions',
    ]);
    expect(findMetadata(png([pngChunk('caBX', text('jumbc2pa stds.schema-org.CreativeWork author'))]))).toEqual([
      'caBX C2PA manifest with Exif, IPTC or author assertions',
    ]);
    expect(findMetadata(png([pngChunk('caBX', text('jumbc2pa c2pa.actions'))]))).toEqual([]);
  });

  it('reports trailing bytes and a broken RIFF layout', () => {
    expect(findMetadata(webp([['VP8L', [1, 2]]], [9, 9, 9]))).toEqual(['3 bytes after the end of the image']);
    const good = webp([['VP8L', [1, 2, 3, 4]], ['EXIF', [1, 2]]]);
    expect(findMetadata(good.subarray(0, good.length - 3)).some((f) => f.startsWith('malformed WebP'))).toBe(true);
    const lying = new Uint8Array(good);
    lying[16] = 200; // the first chunk claims more bytes than the file has
    expect(findMetadata(lying).some((f) => f.startsWith('malformed WebP'))).toBe(true);
  });

  it('always reports HEIC, TIFF and video containers, and XMP in a GIF', () => {
    expect(findMetadata(new Uint8Array([0, 0, 0, 24, ...text('ftypheic'), 0, 0, 0, 0]))).toHaveLength(1);
    expect(findMetadata(new Uint8Array([...text('II*'), 0, 8, 0, 0, 0]))).toHaveLength(1);
    expect(findMetadata(new Uint8Array([0, 0, 0, 20, ...text('ftypqt  '), 0, 0, 0, 0]))).toHaveLength(1);
    expect(findMetadata(new Uint8Array(text('GIF89a\x01\x00\x01\x00\x00\x00\x00;')))).toEqual([]);
    expect(findMetadata(new Uint8Array(text('GIF89a....!\xff\x0bXMP DataXMP<x:xmpmeta/>')))).toEqual(['XMP application extension']);
  });

  it('returns nothing for bytes that are not an image', () => {
    expect(findMetadata(new Uint8Array(text('plain text')))).toEqual([]);
    expect(findMetadata(new Uint8Array(0))).toEqual([]);
  });
});
