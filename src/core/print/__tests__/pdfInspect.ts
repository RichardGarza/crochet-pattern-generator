// Test helper (not a test file): reads what a jsPDF document holds — pages and their sizes, the text drawn on each
// page, bookmarks, links — without a PDF library. jsPDF writes plain objects, one content stream per page
// (FlateDecode when compressed), text as `(…) Tj` in WinAnsi.
import { unzlibSync } from 'fflate';

export interface PdfInfo {
  header: string;
  pages: { mediaBox: number[]; text: string[]; links: number }[];
  /** Top-level bookmark titles in document order. */
  outline: string[];
  /** Raw page count from the page tree (`/Count` of the root `/Pages`). */
  count: number;
}

function latin(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let s = '';
  for (let i = start; i < end; i += 8192) s += String.fromCharCode(...bytes.subarray(i, Math.min(end, i + 8192)));
  return s;
}

/** A PDF literal string's bytes (escapes resolved). */
function literalBytes(raw: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '\\') {
      out.push(raw.charCodeAt(i) & 0xff);
      continue;
    }
    const n = raw[++i];
    if (n === 'n') out.push(10);
    else if (n === 'r') out.push(13);
    else if (n === 't') out.push(9);
    else if (n === 'b') out.push(8);
    else if (n === 'f') out.push(12);
    else if (/[0-7]/.test(n)) {
      let oct = n;
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] ?? '')) oct += raw[++i];
      out.push(Number.parseInt(oct, 8) & 0xff);
    } else out.push(raw.charCodeAt(i) & 0xff);
  }
  return out;
}

/** Literal strings `( … )` in order, honoring escapes and nested parentheses. */
function literals(src: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] !== '(') continue;
    let depth = 1;
    let j = i + 1;
    let raw = '';
    for (; j < src.length && depth > 0; j++) {
      const c = src[j];
      if (c === '\\') {
        raw += c + src[j + 1];
        j++;
        continue;
      }
      if (c === '(') depth++;
      if (c === ')') depth--;
      if (depth > 0) raw += c;
    }
    out.push(raw);
    i = j - 1;
  }
  return out;
}

const cp1252 = new TextDecoder('windows-1252');

/** Text strings shown by Tj in a content stream. */
function shownText(content: string): string[] {
  const out: string[] = [];
  const re = /\((?:\\.|[^\\)])*\)\s*Tj/g;
  for (const m of content.matchAll(re)) {
    const raw = literals(m[0])[0] ?? '';
    out.push(cp1252.decode(new Uint8Array(literalBytes(raw))));
  }
  return out;
}

export function inspectPdf(bytes: Uint8Array): PdfInfo {
  const all = latin(bytes);
  const objects = new Map<number, { dict: string; stream?: Uint8Array }>();
  // Walk the objects in order; a stream's bytes are skipped by its /Length (they may contain anything).
  const head = /(\d+) 0 obj\s*/y;
  let at = 0;
  for (;;) {
    const next = all.slice(at).search(/\d+ 0 obj/);
    if (next < 0) break;
    head.lastIndex = at + next;
    const m = head.exec(all);
    if (!m) {
      at += next + 1;
      continue;
    }
    const id = Number(m[1]);
    const start = head.lastIndex;
    const si = all.indexOf('stream', start);
    const ei = all.indexOf('endobj', start);
    if (si >= 0 && si < ei && /^stream\r?\n/.test(all.slice(si, si + 8))) {
      const dict = all.slice(start, si);
      const length = Number(/\/Length (\d+)/.exec(dict)?.[1]);
      const dataStart = si + (all[si + 6] === '\r' ? 8 : 7);
      const data = bytes.subarray(dataStart, dataStart + length);
      objects.set(id, { dict, stream: /\/FlateDecode/.test(dict) ? unzlibSync(data) : data });
      at = all.indexOf('endobj', dataStart + length) + 6;
    } else {
      objects.set(id, { dict: all.slice(start, ei) });
      at = ei + 6;
    }
  }
  const pages: PdfInfo['pages'] = [];
  const pageIds = [...objects.entries()].filter(([, o]) => /\/Type \/Page[^s]/.test(o.dict)).map(([id]) => id);
  // Order pages by the page tree's /Kids.
  const tree = [...objects.values()].find((o) => /\/Type \/Pages/.test(o.dict));
  const kids = tree ? [...(/\/Kids \[([^\]]*)\]/.exec(tree.dict)?.[1] ?? '').matchAll(/(\d+) 0 R/g)].map((k) => Number(k[1])) : pageIds;
  for (const id of kids) {
    const o = objects.get(id);
    if (!o) continue;
    const mediaBox = (/\/MediaBox \[([^\]]*)\]/.exec(o.dict)?.[1] ?? '').trim().split(/\s+/).map(Number);
    const contentId = Number(/\/Contents (\d+) 0 R/.exec(o.dict)?.[1]);
    const content = objects.get(contentId)?.stream;
    pages.push({ mediaBox, text: content ? shownText(latin(content)) : [], links: [...o.dict.matchAll(/\/Subtype \/Link/g)].length });
  }
  const outline: string[] = [];
  const rootId = [...objects.entries()].find(([, o]) => /\/Type \/Outlines/.test(o.dict))?.[0];
  for (const o of objects.values()) {
    const t = /\/Title \(/.exec(o.dict);
    if (!t || new RegExp(`/Parent ${rootId} 0 R`).exec(o.dict) === null) continue;
    const raw = literals(o.dict.slice(t.index + 7))[0] ?? '';
    const b = literalBytes(raw);
    outline.push(b[0] === 0xfe && b[1] === 0xff ? new TextDecoder('utf-16be').decode(new Uint8Array(b.slice(2))) : cp1252.decode(new Uint8Array(b)));
  }
  const count = Number(/\/Count (\d+)/.exec(tree?.dict ?? '')?.[1] ?? NaN);
  return { header: all.slice(0, 8), pages, outline, count };
}

export async function inspectBlob(blob: Blob): Promise<PdfInfo> {
  return inspectPdf(new Uint8Array(await blob.arrayBuffer()));
}
