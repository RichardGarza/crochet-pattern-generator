// §3.7.4: the worker-safe tokenizer and the extraction ladder E1–E4 (E8 failure), in the node environment (no DOM).
import { gzipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { CrochetModelV1 } from '../../../types/model';
import { stringifyModel } from '../../model/schema';
import { decodeEntities, specFromHtml, tokenizeHtml } from '../html';
import { importInputs } from '../index';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { ARCHIVE_PAGE, CANONICAL_TEDDY, fileInput, OBSERVED_JSON, standalonePage } from './helpers/fixtures';

const SPEC = JSON.parse(OBSERVED_JSON) as Record<string, unknown>;
const MINI = { schema: 'crochet-model', version: '1.0', parts: [{ id: 'ball', type: 'sphere', dims: { r: 1 }, position: [0, 1, 0], color: 'c1' }], palette: [{ id: 'c1', hex: '#ff0000' }], finishedSize: { height: 2 } };
const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

describe('tokenizer', () => {
  it('reads scripts with raw bodies, attributes in every quoting style, lower-cased names, first duplicate wins', () => {
    const t = tokenizeHtml(`<SCRIPT TYPE='module' data-x=1 Defer id="a" id="b">if (a < b && c > d) x = "&amp;";</SCRIPT><p>hi</p>`);
    expect(t.scripts).toHaveLength(1);
    expect(t.scripts[0].attrs).toEqual({ type: 'module', 'data-x': '1', defer: '', id: 'a' });
    expect(t.scripts[0].body).toBe('if (a < b && c > d) x = "&amp;";');
    expect(Object.getPrototypeOf(t.scripts[0].attrs)).toBe(null);
    expect(t.texts).toEqual(['hi']);
  });

  it('decodes numeric and named entities in attributes and text; unknown names are kept and logged', () => {
    const unknown: string[] = [];
    expect(decodeEntities('&#65;&#x42;&#X43; &quot;&apos;&lt;&gt;&amp; &hellip;&nbsp;&foo; & &#0;', unknown)).toBe('ABC "\'<>& … &foo; & �');
    expect(unknown).toEqual(['&foo;']);
    const t = tokenizeHtml('<div title="a &bogus; b">x &zz; y</div>');
    expect(t.unknownEntities).toEqual(['&bogus;', '&zz;']);
  });

  it('a <script> inside a comment is not a script; an unterminated comment ends the document', () => {
    const t = tokenizeHtml('<!-- <script id="crochet-model">{}</script> --><script>real()</script><!-- open');
    expect(t.scripts.map((s) => s.body)).toEqual(['real()']);
  });

  it('style, textarea and title are raw text; <scripts> and </ are not tags', () => {
    const t = tokenizeHtml('<style>a{} <script>no()</script></style><title>T &amp; <b></title><textarea><script>no2()</script></textarea><scripts>x</scripts> 1 </ 2 <3');
    expect(t.scripts).toEqual([]);
    expect(t.texts).toContain('T & <b>');
    expect(t.texts).toContain('<script>no2()</script>');
    expect(t.tagNames.has('scripts')).toBe(true);
  });

  it('never hangs on broken markup', () => {
    for (const html of ['<', '<a', '<a b="', "<a b='", '<a b=', '<script>', '<script', '<!', '<!--', '<a/ / =x>', '<a ="x">', '<textarea>', '&#xFFFFFFF;']) {
      expect(() => tokenizeHtml(html)).not.toThrow();
    }
  });
});

describe('ladder', HEAVY, () => {
  it('E2: an entity-escaped data-crochet-model attribute', () => {
    const r = specFromHtml(`<!doctype html><body><div data-crochet-model="${escapeAttr(OBSERVED_JSON)}"></div></body>`);
    expect(r.how).toBe('E2 [data-crochet-model] attribute');
    expect(r.value).toEqual(SPEC);
  });

  it('E2: an upper-case </SCRIPT> closing tag', () => {
    const r = specFromHtml(`<html><script type="application/json" id="crochet-model">${OBSERVED_JSON}</SCRIPT ><p>after</p></html>`);
    expect(r.how).toBe('E2 #crochet-model');
    expect(r.value).toEqual(SPEC);
  });

  it('E2 order: #crochet-model, then script[data-crochet-model], then the vnd type, then any attribute', () => {
    const other = { ...MINI, revision: 7 };
    const vnd = `<script type="application/vnd.crochet-model+json">${JSON.stringify(other)}</script>`;
    const data = `<script data-crochet-model>${JSON.stringify(other)}</script>`;
    const id = `<script id="crochet-model" type="application/json">${JSON.stringify(MINI)}</script>`;
    expect(specFromHtml(`<html>${vnd}${data}${id}</html>`).value).toEqual(MINI);
    expect(specFromHtml(`<html>${vnd}${data}</html>`).how).toBe('E2 script[data-crochet-model]');
    expect(specFromHtml(`<html>${vnd}</html>`).how).toBe('E2 application/vnd.crochet-model+json');
  });

  it('E2: an HTML-escaped JSON block is decoded and retried', () => {
    const r = specFromHtml(`<html><script type="application/json" id="crochet-model">${escapeAttr(JSON.stringify(MINI))}</script></html>`);
    expect(r.value).toEqual(MINI);
  });

  it('a <script id="crochet-model"> inside a comment is ignored (also by E4)', () => {
    const commented = `<html><!-- <script type="application/json" id="crochet-model">${JSON.stringify(MINI)}</script> --><p>no model</p></html>`;
    const r = specFromHtml(commented);
    expect(r.value).toBeUndefined();
    expect(r.failure?.code).toBe('E_IMPORT_NO_MODEL');
    const both = commented.replace('<p>no model</p>', `<script id="crochet-model" type="application/json">${JSON.stringify({ ...MINI, revision: 3 })}</script>`);
    expect(specFromHtml(both).value).toEqual({ ...MINI, revision: 3 });
  });

  it('E4: JSON that appears only inside a <textarea> (raw and entity-escaped)', () => {
    const r = specFromHtml(`<html><body><textarea>${OBSERVED_JSON}</textarea></body></html>`);
    expect(r.how).toBe('E4 brace scan (json)');
    expect(r.confidence).toBe('medium');
    expect(r.value).toEqual(SPEC);
    expect(specFromHtml(`<html><textarea>${escapeAttr(OBSERVED_JSON)}</textarea></html>`).value).toEqual(SPEC);
  });

  it('E3: CROCHET-MODEL markers in a module script, around a JS object literal', () => {
    const js = `const spec = /*CROCHET-MODEL-BEGIN*/ { schema: 'crochet-model', version: '1.0', parts: [{ id: 'ball', type: 'sphere', dims: { r: 1 }, position: [0, 1, 0], color: 'c1', }], palette: [{ id: 'c1', hex: '#ff0000' }], finishedSize: { height: 2 } } /*CROCHET-MODEL-END*/;`;
    const r = specFromHtml(`<html><script type="module">${js}</script></html>`);
    expect(r.how).toBe('E3 markers');
    expect(r.value).toEqual(MINI);
  });

  it('E4: a JS object literal with unquoted keys (JSON5) in a module script', () => {
    const js = `const spec = { "schema": "crochet-model", version: "1.0", parts: [ { id: 'ball', type: 'sphere', dims: { r: 1 }, position: [0, 1, 0], color: 'c1' } ], palette: [{ id: 'c1', hex: '#ff0000' }], finishedSize: { height: 2 }, };\nbuild(spec);`;
    const r = specFromHtml(`<html><script type="module">${js}</script></html>`);
    expect(r.how).toBe('E4 brace scan (json5)');
    expect(r.value).toEqual(MINI);
  });

  it('E1: the standalone template is unpacked (</ escaped as <\\u002F) and its #crochet-model read', () => {
    const r = specFromHtml(standalonePage(ARCHIVE_PAGE));
    expect(r.standalone).toBe(true);
    expect(r.how).toBe('E1+E2 #crochet-model');
    expect(r.value).toEqual(SPEC);
    // the raw file never holds the block verbatim (the naive regex of [08] does not match)
    expect(standalonePage(ARCHIVE_PAGE).includes('<script type="application/json" id="crochet-model">')).toBe(false);
  });

  it('E1: the app module renamed <script type="text/x-app" id="app-src"> is searched (E3/E4)', () => {
    const page = `<html><body><three-d-stage></three-d-stage><script type="text/x-app" id="app-src">const spec = ${JSON.stringify(MINI)};</script></body></html>`;
    const r = specFromHtml(standalonePage(page));
    expect(r.how).toBe('E4 brace scan (json)');
    expect(r.value).toEqual(MINI);
  });

  it('E1: gzipped and plain manifest entries are decoded: a bundled JS file and a bundled page', () => {
    const b64 = (u8: Uint8Array): string => btoa(String.fromCharCode(...u8));
    const js = `export const SPEC = ${JSON.stringify(MINI)};`;
    const viaJs = specFromHtml(
      standalonePage('<html><body>no block here</body></html>', {
        'a1b2-font': { mime: 'font/woff2', compressed: false, data: 'AAAA' },
        'c3d4-js': { mime: 'application/javascript', compressed: true, data: b64(gzipSync(strToU8(js))) },
      }),
    );
    expect(viaJs.value).toEqual(MINI);
    const nested = `<html><script id="crochet-model" type="application/json">${JSON.stringify(MINI)}</script></html>`;
    const viaPage = specFromHtml(standalonePage('<html><iframe src="about:blank#e5f6"></iframe></html>', { e5f6: { mime: 'text/html', compressed: false, data: b64(strToU8(nested)) } }));
    expect(viaPage.how).toBe('E1+E2 #crochet-model (bundled page e5f6)');
    expect(viaPage.value).toEqual(MINI);
  });

  it('a manifest entry whose gzip trailer claims more than 64 MB is not inflated', () => {
    const gz = gzipSync(strToU8('x'));
    gz.set([0xff, 0xff, 0xff, 0x7f], gz.length - 4);
    const r = specFromHtml(standalonePage('<html></html>', { big: { mime: 'text/javascript', compressed: true, data: btoa(String.fromCharCode(...gz)) } }));
    expect(r.value).toBeUndefined();
    expect(r.warnings.some((w) => /too large/.test(w.message))).toBe(true);
  });

  it('E8: no spec → E_IMPORT_NO_MODEL with the fix-up advice; a broken #crochet-model → E_IMPORT_PARSE', () => {
    const none = specFromHtml('<!doctype html><html><three-d-stage></three-d-stage></html>');
    expect(none.failure?.code).toBe('E_IMPORT_NO_MODEL');
    expect(none.failure?.message).toMatch(/fix-up message/);
    const broken = specFromHtml('<html><script id="crochet-model" type="application/json">{"schema": "crochet-model", parts: [</script></html>');
    expect(broken.failure?.code).toBe('E_IMPORT_PARSE');
    expect(broken.failure?.message).toMatch(/#crochet-model/);
  });

  it('format drift: a page without any known fingerprint gets an info warning; the teddy page does not', () => {
    expect(specFromHtml(`<html><script id="crochet-model" type="application/json">${JSON.stringify(MINI)}</script></html>`).warnings.map((w) => w.code)).toEqual(['I_FORMAT_DRIFT']);
    expect(specFromHtml(ARCHIVE_PAGE).warnings).toEqual([]);
  });

  it('a page whose spec holds __proto__ is rejected as unsafe', () => {
    const hostile = `{"schema":"crochet-model","parts":[],"__proto__":{"polluted":true}}`;
    const r = specFromHtml(`<html><script id="crochet-model" type="application/json">${hostile}</script></html>`);
    expect(r.failure?.code).toBe('E_IMPORT_UNSAFE');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('the archive page with entity-escaped JSON in an attribute gives the same canonical teddy', async () => {
    const page = `<!doctype html><html><head><script type="importmap">{}</script></head><body><three-d-stage data-crochet-model="${escapeAttr(OBSERVED_JSON)}"></three-d-stage></body></html>`;
    const r = await importInputs([fileInput('teddy.html', page)]);
    expect(r.ok).toBe(true);
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
  });

  it('a pasted HTML page goes through the ladder (carrier html)', async () => {
    const r = await importInputs([{ kind: 'text', text: ARCHIVE_PAGE }]);
    expect(r.carrier).toBe('html');
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
  });
});
