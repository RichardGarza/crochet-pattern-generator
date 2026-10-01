// §3.7.2 text carrier and the JSON reading every carrier shares: fences, brace scan, JSON5, smart quotes, BOM and
// zero-width characters, the forbidden-key reviver; and §3.7.2 detection by magic bytes then extension.
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { CrochetModelV1 } from '../../../types/model';
import { stringifyModel } from '../../model/schema';
import { detectFile, looksLikeHtml } from '../detect';
import { importInputs } from '../index';
import { braceMatch, braceScan, cleanText, codeFences, decodeText, parseJsonSafe, specFromText, straightenQuotes } from '../text';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { CANONICAL_TEDDY, chatReply, OBSERVED_JSON } from './helpers/fixtures';

const MINI = { schema: 'crochet-model', version: '1.0', parts: [{ id: 'ball', type: 'sphere', dims: { r: 1 }, position: [0, 1, 0], color: 'c1' }], palette: [{ id: 'c1', hex: '#ff0000' }], finishedSize: { height: 2 } };
const ZWSP = String.fromCharCode(0x200b);
const BOM = String.fromCharCode(0xfeff);
const NBSP = String.fromCharCode(0xa0);

describe('reading JSON safely', () => {
  it('JSON first, then JSON5 (comments, trailing commas, single quotes, unquoted keys)', () => {
    expect(parseJsonSafe('{"a": 1}')).toEqual({ ok: true, value: { a: 1 }, parser: 'json' });
    expect(parseJsonSafe("{ // note\n a: 'x', b: [1, 2,], }")).toEqual({ ok: true, value: { a: 'x', b: [1, 2] }, parser: 'json5' });
    const bad = parseJsonSafe('{ a: ');
    expect(bad.ok).toBe(false);
  });

  it.each(['__proto__', 'constructor', 'prototype'])('rejects the key %s at any depth, in JSON and in JSON5, without polluting', (key) => {
    for (const text of [`{"a": {"b": [{"${key}": {"polluted": true}}]}}`, `{a: {b: [{${key === '__proto__' ? '"__proto__"' : key}: {polluted: true}}]}, }`]) {
      const r = parseJsonSafe(text);
      expect(r.ok).toBe(false);
      expect(r.ok ? undefined : r.forbidden).toBe(key);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(false);
  });

  it('the values "__proto__" and "constructor" are fine', () => {
    expect(parseJsonSafe('{"name": "__proto__", "notes": "constructor"}').ok).toBe(true);
  });
});

describe('text clean-up', () => {
  it('removes BOM, zero-width characters; odd spaces become spaces; CRLF becomes LF', () => {
    expect(cleanText(`${BOM}{"a":${ZWSP}1,${NBSP}"b":2}\r\n`)).toBe('{"a":1, "b":2}\n');
  });

  it('straightens typographic quotes', () => {
    expect(straightenQuotes('“a” ‘b’ „c“ «d»')).toBe(`"a" 'b' "c" "d"`);
  });

  it('decodes UTF-8 with or without BOM and UTF-16 with BOM', () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toBe('{}');
    expect(decodeText(new Uint8Array([0xff, 0xfe, 0x7b, 0, 0x7d, 0]))).toBe('{}');
    expect(decodeText(new Uint8Array([0xfe, 0xff, 0, 0x7b, 0, 0x7d]))).toBe('{}');
  });
});

describe('fences and the brace scan', () => {
  it('finds fences of ``` and ~~~, with a language, and an unclosed one at the end', () => {
    const f = codeFences('a\n```json\n{"x":1}\n```\nb\n~~~~\n``` not closing\n~~~~\n```js\nlast');
    expect(f).toEqual([
      { lang: 'json', body: '{"x":1}' },
      { lang: '', body: '``` not closing' },
      { lang: 'js', body: 'last' },
    ]);
  });

  it('braceMatch skips braces in strings, escaped quotes and comments', () => {
    const t = `{"a": "}{\\"}", 'b': '}', c: \`}\`, // }\n /* } */ d: [1, {e: 2}]} tail`;
    expect(braceMatch(t, 0)).toBe(t.indexOf(' tail') - 1);
    expect(braceMatch('{ [ }', 0)).toBe(-1);
    expect(braceMatch('{ never closed', 0)).toBe(-1);
  });

  it('the scan is whitespace-tolerant and takes the innermost object that owns "schema"', () => {
    const inner = JSON.stringify(MINI).replace('"schema":"crochet-model"', '"schema" :\n  "crochet-model"');
    const hit = braceScan(`prose { not json } and {"wrapper": ${inner}} more`, 'first');
    expect(hit && 'hit' in hit ? hit.hit.value : null).toEqual(MINI);
  });

  it('the scan picks the first or the last spec', () => {
    const a = JSON.stringify({ ...MINI, revision: 1 });
    const b = JSON.stringify({ ...MINI, revision: 2 });
    const first = braceScan(`${a} then ${b}`, 'first');
    const last = braceScan(`${a} then ${b}`, 'last');
    expect(first && 'hit' in first ? first.hit.value.revision : 0).toBe(1);
    expect(last && 'hit' in last ? last.hit.value.revision : 0).toBe(2);
  });
});

describe('chat replies', HEAVY, () => {
  it('the last fence holding "crochet-model" wins (a later version of the spec in the same chat)', () => {
    const text = [chatReply(JSON.stringify({ ...MINI, revision: 1 })), 'Updated:', chatReply(JSON.stringify({ ...MINI, revision: 2 })), '```json\n{"unrelated": true}\n```'].join('\n\n');
    const r = specFromText(text);
    expect(r.ok && r.value.revision).toBe(2);
    expect(r.ok && r.how).toBe('code fence, json');
  });

  it('a broken last fence falls back to the previous one', () => {
    const text = [chatReply(JSON.stringify(MINI)), '```json\n{"schema": "crochet-model", "parts": [\n```'].join('\n');
    const r = specFromText(text);
    expect(r.ok && r.value).toEqual(MINI);
  });

  it('a spec in prose without a fence is found by the brace scan (medium confidence)', () => {
    const r = specFromText(`Sure! Here you go: ${JSON.stringify(MINI)} Let me know {if} you need more.`);
    expect(r.ok && r.confidence).toBe('medium');
    expect(r.ok && r.value).toEqual(MINI);
  });

  it('smart quotes everywhere, apostrophes inside values, zero-width characters and a BOM', async () => {
    const curly = OBSERVED_JSON.replace(/"([^"]*)"/g, '“$1”').replace('Child positions', 'Child’s positions');
    const r = await importInputs([{ kind: 'text', text: `${BOM}Here’s the “spec”:\n\`\`\`json\n${curly.replace(/,\n/g, `,${ZWSP}\n`)}\n\`\`\`\nThanks!` }]);
    expect(r.ok).toBe(true);
    expect(stringifyModel(r.model as CrochetModelV1).replace("Child's", 'Child')).toBe(CANONICAL_TEDDY);
  });

  it('JSON5 in a fence (comments, trailing commas)', () => {
    const r = specFromText("```json5\n{ // the bear\n schema: 'crochet-model', parts: [{id: 'ball', type: 'sphere', dims: {r: 1}, position: [0, 1, 0], color: 'c1',},], palette: [{id: 'c1', hex: '#ff0000'}], finishedSize: {height: 2}, version: '1.0' }\n```");
    expect(r.ok && r.value).toEqual(MINI);
  });

  it('no spec at all: E_IMPORT_NO_MODEL that tells the user what to ask for', async () => {
    const r = await importInputs([{ kind: 'text', text: 'I made the bear! Open the preview to see it.' }]);
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('E_IMPORT_NO_MODEL');
    expect(r.warnings[0].message).toMatch(/json code block/);
  });

  it('a spec holding __proto__ is rejected: E_IMPORT_UNSAFE', async () => {
    const r = await importInputs([{ kind: 'text', text: chatReply('{"schema": "crochet-model", "parts": [], "x": {"__proto__": {"polluted": 1}}}') }]);
    expect(r.ok).toBe(false);
    expect(r.warnings[0].code).toBe('E_IMPORT_UNSAFE');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe('detection (§3.7.2): magic bytes first, extension second', () => {
  const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
  it.each<[string, Uint8Array, string]>([
    ['a.bin', zipSync({ 'a.txt': strToU8('x') }), 'zip'],
    ['x.json', new Uint8Array([0x1f, 0x8b, 8, 0]), 'gzip'],
    ['x', new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]), 'glb'],
    ['x', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10]), 'image'],
    ['x', new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 'image'],
    ['x', enc('RIFF\0\0\0\0WEBPVP8 '), 'image'],
    ['x', enc('%PDF-1.7'), 'pdf'],
    ['x', enc('ply\nformat ascii 1.0'), 'ply'],
    ['x.txt', enc('  {"schema": "crochet-model"}'), 'json'],
    ['x.gltf', enc('{"asset": {"version": "2.0"}}'), 'gltf'],
    ['x.txt', enc('<!-- saved --><!DOCTYPE html><html>'), 'html'],
    ['x.dc.html', enc('<x-dc>hi</x-dc>'), 'html'],
    ['x', enc('<script type="module">1</script>'), 'html'],
    ['x', enc('solid bear\n facet normal 0 0 1\n'), 'stl'],
    ['x', enc('# Exported by three-d-stage\nnewmtl caramel_yarn\nKd 0.4 0.2 0.07\n'), 'mtl'],
    ['x', enc('mtllib a.mtl\no head\nv 1 2 3\nv 1 2 4\nf 1 2 3\n'), 'obj'],
    ['notes.md', enc('# Bear\nSome text'), 'text'],
    ['x', new Uint8Array([0, 1, 2, 3, 0, 9]), 'unknown'],
  ])('%s → %s', (name, bytes, kind) => {
    expect(detectFile(name, bytes)).toBe(kind);
  });

  it('binary STL by its size (84 + 50·n bytes)', () => {
    const stl = new Uint8Array(84 + 50 * 2);
    stl[80] = 2;
    expect(detectFile('x', stl)).toBe('stl');
  });

  it('looksLikeHtml', () => {
    expect(looksLikeHtml('\n  <!DOCTYPE html>')).toBe(true);
    expect(looksLikeHtml('Here is <html> in prose')).toBe(false);
  });
});
