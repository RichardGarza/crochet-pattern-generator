// Track T7 — the worker-safe HTML tokenizer and the extraction ladder E1–E4 (DESIGN.md §3.7.4). `DOMParser`
// exists only on Window (not in dedicated workers, not in the vitest node environment), so HTML is read here as
// plain strings: imported markup never reaches a DOM.
import type { Issue } from '../../types/issues';
import { IMPORT_CODES, issue } from './common';
import { braceMatch, braceScan, isSpecLike, parseJsonSafe, scanBudget } from './text';
import { decodeBundlerAssets, unbundleTemplate, type BundlerAsset } from './unbundle';

export interface HtmlScript {
  /** Attribute names lower-cased, values entity-decoded; the first of a repeated attribute wins (as in HTML). */
  attrs: Record<string, string>;
  /** The raw text up to the next `</script` (never entity-decoded, as in HTML). */
  body: string;
}

export interface HtmlTokens {
  scripts: HtmlScript[];
  /** Every `data-crochet-model` attribute value, decoded, in document order. */
  dataCrochetModel: string[];
  /** Lower-cased names of every start tag. */
  tagNames: Set<string>;
  /** Names of every attribute seen. */
  attrNames: Set<string>;
  /** Text outside tags, decoded, and the decoded bodies of `<textarea>` / `<title>` (comments excluded). */
  texts: string[];
  /** Unknown named entities (`&foo;`), kept verbatim. */
  unknownEntities: string[];
}

/** The named entities decoded besides the numeric ones (§3.7.4: the required six plus a table of common ones). */
const NAMED_ENTITIES: Readonly<Record<string, string>> = Object.assign(Object.create(null) as Record<string, string>, {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', laquo: '«', raquo: '»', sbquo: '‚', bdquo: '„', middot: '·', bull: '•', times: '×', divide: '÷',
  deg: '°', plusmn: '±', micro: 'µ', para: '¶', sect: '§', cent: '¢', pound: '£', euro: '€', yen: '¥',
  frac12: '½', frac14: '¼', frac34: '¾', sup2: '²', sup3: '³', prime: '′', Prime: '″', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', star: '☆', check: '✓', shy: '\u00AD', zwj: '\u200D',
  zwnj: '\u200C', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', grave: '`', lbrace: '{', rbrace: '}',
  lcub: '{', rcub: '}', lsqb: '[', rsqb: ']', lpar: '(', rpar: ')', colon: ':', comma: ',', period: '.',
  semi: ';', excl: '!', quest: '?', num: '#', dollar: '$', percnt: '%', ast: '*', plus: '+', equals: '=',
  sol: '/', bsol: '\\', lowbar: '_', verbar: '|', vert: '|', tilde: '˜', circ: 'ˆ', Hat: '^', commat: '@',
  NewLine: '\n', Tab: '\t',
});

const ENTITY_RE = /&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{0,31});/g;

function codePointChar(n: number): string {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(n);
}

/** Numeric and named entities decoded; an unknown name is kept verbatim and pushed to `unknown`. */
export function decodeEntities(text: string, unknown?: string[]): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY_RE, (whole, name: string) => {
    if (name[0] === '#') return codePointChar(name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10));
    const value = NAMED_ENTITIES[name];
    if (value !== undefined) return value;
    unknown?.push(whole);
    return whole;
  });
}

const isWs = (c: string): boolean => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\f';
const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'));
/** Elements whose content is raw text up to their own end tag. */
const RAW_TEXT = new Set(['style', 'textarea', 'title', 'xmp']);

/** Index of the next case-insensitive `</name`, or the text length. */
function findEndTag(html: string, lower: string, name: string, from: number): number {
  const at = lower.indexOf(`</${name}`, from);
  return at < 0 ? html.length : at;
}

/** `[i]` is the `<` of a start tag: reads its name and attributes; returns the index after `>`. */
function readTag(html: string, i: number, onAttr: (name: string, value: string) => void): { name: string; end: number; selfClosing: boolean } {
  let j = i + 1;
  while (j < html.length && !isWs(html[j]) && html[j] !== '/' && html[j] !== '>') j++;
  const name = html.slice(i + 1, j).toLowerCase();
  let selfClosing = false;
  while (j < html.length) {
    const c = html[j];
    if (isWs(c)) {
      j++;
      continue;
    }
    if (c === '>') return { name, end: j + 1, selfClosing };
    if (c === '/') {
      selfClosing = html[j + 1] === '>';
      j++;
      continue;
    }
    // attribute name: [^\s"'>/=]+ (a stray `=` or quote is skipped so the scan always advances)
    const nameStart = j;
    while (j < html.length && !isWs(html[j]) && !'"\'>/='.includes(html[j])) j++;
    if (j === nameStart) {
      j++;
      continue;
    }
    const attr = html.slice(nameStart, j).toLowerCase();
    let k = j;
    while (k < html.length && isWs(html[k])) k++;
    if (html[k] !== '=') {
      onAttr(attr, '');
      continue;
    }
    k++;
    while (k < html.length && isWs(html[k])) k++;
    const q = html[k];
    if (q === '"' || q === "'") {
      const close = html.indexOf(q, k + 1);
      const end = close < 0 ? html.length : close;
      onAttr(attr, html.slice(k + 1, end));
      j = end + 1;
    } else {
      const start = k;
      while (k < html.length && !isWs(html[k]) && html[k] !== '>') k++;
      onAttr(attr, html.slice(start, k));
      j = k;
    }
  }
  return { name, end: html.length, selfClosing };
}

/**
 * §3.7.4 tokenizer, one left-to-right pass: `<!--` skips to `-->`; `<script` (followed by whitespace, `/` or `>`)
 * starts a script whose body is the raw text up to the next case-insensitive `</script`; `<style>`,
 * `<textarea>`, `<title>` are raw text up to their own end tags; any other `<` + letter is a tag whose
 * attributes are read; `</…>`, `<!…>` and `<?…>` are skipped; everything else is text.
 */
export function tokenizeHtml(html: string): HtmlTokens {
  const lower = html.toLowerCase();
  const out: HtmlTokens = { scripts: [], dataCrochetModel: [], tagNames: new Set(), attrNames: new Set(), texts: [], unknownEntities: [] };
  let text = '';
  const flushText = (): void => {
    if (text.trim() !== '') out.texts.push(decodeEntities(text, out.unknownEntities));
    text = '';
  };
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) {
      text += html.slice(i);
      break;
    }
    text += html.slice(i, lt);
    const next = html[lt + 1];
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    if (next === '!' || next === '?') {
      const end = html.indexOf('>', lt);
      i = end < 0 ? html.length : end + 1;
      continue;
    }
    if (next === '/') {
      if (isLetter(html[lt + 2])) {
        const end = html.indexOf('>', lt);
        i = end < 0 ? html.length : end + 1;
      } else {
        text += '</';
        i = lt + 2;
      }
      continue;
    }
    if (!isLetter(next)) {
      text += '<';
      i = lt + 1;
      continue;
    }
    flushText();
    const attrs = Object.create(null) as Record<string, string>;
    const tag = readTag(html, lt, (name, raw) => {
      out.attrNames.add(name);
      if (name in attrs) return;
      const value = decodeEntities(raw, out.unknownEntities);
      attrs[name] = value;
      if (name === 'data-crochet-model') out.dataCrochetModel.push(value);
    });
    out.tagNames.add(tag.name);
    i = tag.end;
    if (tag.name === 'script') {
      // the body of a self-closing <script/> still runs to </script> in HTML
      const end = findEndTag(html, lower, 'script', i);
      out.scripts.push({ attrs, body: html.slice(i, end) });
      const close = html.indexOf('>', end);
      i = close < 0 ? html.length : close + 1;
    } else if (RAW_TEXT.has(tag.name)) {
      const end = findEndTag(html, lower, tag.name, i);
      if (tag.name !== 'style') {
        const body = decodeEntities(html.slice(i, end), out.unknownEntities);
        if (body.trim() !== '') out.texts.push(body);
      }
      const close = html.indexOf('>', end);
      i = close < 0 ? html.length : close + 1;
    }
  }
  flushText();
  return out;
}

// ---- the ladder

export interface HtmlSpec {
  value?: Record<string, unknown>;
  /** The rung that found it: `E2 #crochet-model`, `E1+E2 #crochet-model`, `E3 markers`, `E4 brace scan`. */
  how?: string;
  confidence?: 'high' | 'medium';
  /** `__bundler/template` present (the standalone carrier). */
  standalone: boolean;
  fingerprint: string[];
  warnings: Issue[];
  /** Why nothing was found, when nothing was. */
  failure?: Issue;
}

/** Diagnostic fingerprints of §3.7.4, in this order. */
export const KNOWN_FINGERPRINTS = ['__bundler', '<x-dc>', 'three-d-stage', 'text/babel', 'importmap'] as const;

function fingerprintsOf(pages: HtmlTokens[], extraTexts: string[]): string[] {
  const has = new Set<string>();
  for (const t of pages) {
    for (const s of t.scripts) {
      const type = (s.attrs.type ?? '').toLowerCase().trim();
      if (type.startsWith('__bundler/')) has.add('__bundler');
      if (type === 'text/babel') has.add('text/babel');
      if (type === 'importmap') has.add('importmap');
      if ((s.attrs.src ?? '').includes('three-d-stage')) has.add('three-d-stage');
    }
    if (t.tagNames.has('x-dc') || t.attrNames.has('data-dc-script')) has.add('<x-dc>');
    if (t.tagNames.has('three-d-stage')) has.add('three-d-stage');
  }
  if (extraTexts.some((s) => s.includes('customElements.define(\'three-d-stage\'') || s.includes('customElements.define("three-d-stage"'))) has.add('three-d-stage');
  return KNOWN_FINGERPRINTS.filter((f) => has.has(f));
}

const MARKER_BEGIN = /\/\*\s*CROCHET-MODEL-BEGIN\s*\*\//g;
const MARKER_END = /\/\*\s*CROCHET-MODEL-END\s*\*\//g;

/** The texts between `/*CROCHET-MODEL-BEGIN*\/` and `/*CROCHET-MODEL-END*\/` (one linear pass). */
function markedTexts(text: string): string[] {
  const out: string[] = [];
  MARKER_BEGIN.lastIndex = 0;
  for (let m = MARKER_BEGIN.exec(text); m; m = MARKER_BEGIN.exec(text)) {
    MARKER_END.lastIndex = MARKER_BEGIN.lastIndex;
    const end = MARKER_END.exec(text);
    if (!end) break;
    out.push(text.slice(MARKER_BEGIN.lastIndex, end.index));
    MARKER_BEGIN.lastIndex = MARKER_END.lastIndex;
  }
  return out;
}

type Attempt = { value: Record<string, unknown> } | { forbidden: string; error: string } | { error: string } | null;

/** A JSON block's text: JSON, then JSON5, then (when it looks entity-escaped) the same after decoding entities. */
function parseBlock(body: string): Attempt {
  const trimmed = body.trim();
  if (trimmed === '') return null;
  const tries = [trimmed];
  if (/&(quot|#34|#x22|amp|lt|gt);/i.test(trimmed)) tries.push(decodeEntities(trimmed));
  let error: Attempt = null;
  for (const t of tries) {
    const r = parseJsonSafe(t);
    if (r.ok) {
      if (isSpecLike(r.value)) return { value: r.value as Record<string, unknown> };
      error ??= { error: 'the block is JSON but not a crochet-model spec' };
    } else if (r.forbidden) return { forbidden: r.forbidden, error: r.error };
    else error ??= { error: r.error };
  }
  return error;
}

/** E3 content: the marked text as JSON, else the first brace-matched object in it. */
function parseMarked(content: string): Attempt {
  const direct = parseBlock(content);
  if (direct && 'value' in direct) return direct;
  if (direct && 'forbidden' in direct) return direct;
  const open = content.indexOf('{');
  if (open < 0) return direct;
  const end = braceMatch(content, open);
  return end < 0 ? direct : parseBlock(content.slice(open, end + 1));
}

/** The texts E3/E4 search in a page: script bodies (not the bundler's own), then decoded text and raw-text bodies. */
function searchTexts(t: HtmlTokens): string[] {
  const out: string[] = [];
  for (const s of t.scripts) if (!(s.attrs.type ?? '').toLowerCase().startsWith('__bundler/')) out.push(s.body);
  out.push(...t.texts);
  return out;
}

/** E2 on one tokenized page: `#crochet-model`, `[data-crochet-model]` scripts, the vnd type, then attributes. */
function e2(t: HtmlTokens, note: (a: Attempt, what: string) => void): { value: Record<string, unknown>; how: string } | 'forbidden' | null {
  const rungs: [string, (s: HtmlScript) => boolean][] = [
    ['#crochet-model', (s) => s.attrs.id === 'crochet-model'],
    ['script[data-crochet-model]', (s) => 'data-crochet-model' in s.attrs],
    ['application/vnd.crochet-model+json', (s) => (s.attrs.type ?? '').toLowerCase().trim() === 'application/vnd.crochet-model+json'],
  ];
  for (const [what, match] of rungs) {
    for (const s of t.scripts) {
      if (!match(s)) continue;
      const a = parseBlock(s.body);
      note(a, what);
      if (a && 'value' in a) return { value: a.value, how: what };
      if (a && 'forbidden' in a) return 'forbidden';
    }
  }
  for (const v of t.dataCrochetModel) {
    const a = parseBlock(v);
    note(a, '[data-crochet-model] attribute');
    if (a && 'value' in a) return { value: a.value, how: '[data-crochet-model] attribute' };
    if (a && 'forbidden' in a) return 'forbidden';
  }
  return null;
}

/**
 * The extraction ladder of §3.7.4 on one HTML text: E1 unbundle (`__bundler/template` → the page, plus the decoded
 * text entries of the manifest), E2 tokenized scripts and attributes, E3 `CROCHET-MODEL` markers, E4 brace scan.
 * E5–E7 are v1.1; E8 is the failure with the fix-up advice.
 */
export function specFromHtml(html: string): HtmlSpec {
  const outer = tokenizeHtml(html);
  const warnings: Issue[] = [];
  const pages: HtmlTokens[] = [];
  let standalone = false;
  let assets: BundlerAsset[] | null = null;
  let firstProblem: { what: string; a: Exclude<Attempt, null> } | null = null;
  const note = (a: Attempt, what: string): void => {
    if (a && !('value' in a) && !firstProblem) firstProblem = { what, a };
  };

  const templateScript = outer.scripts.find((s) => (s.attrs.type ?? '').trim() === '__bundler/template');
  if (templateScript) {
    standalone = true;
    const t = unbundleTemplate(templateScript.body);
    if (t.ok) pages.push(tokenizeHtml(t.html));
    else warnings.push(issue(IMPORT_CODES.parse, 'warn', `the standalone page's template could not be unpacked: ${t.error}`));
  }
  pages.push(outer);

  const finish = (value: Record<string, unknown>, how: string, confidence: 'high' | 'medium', extra: string[] = []): HtmlSpec => {
    const fingerprint = fingerprintsOf(pages, extra);
    return { value, how, confidence, standalone, fingerprint, warnings: [...warnings, ...pageWarnings(pages, fingerprint)] };
  };
  const forbidden = (): HtmlSpec => {
    const fingerprint = fingerprintsOf(pages, []);
    const key = firstProblem && 'forbidden' in firstProblem.a ? firstProblem.a.forbidden : '__proto__';
    return {
      standalone,
      fingerprint,
      warnings: [...warnings, ...pageWarnings(pages, fingerprint)],
      failure: issue(IMPORT_CODES.unsafe, 'error', `the page's model holds the key "${key}", which is never allowed (it could be an attack): nothing was imported`),
    };
  };

  // E2 on the unpacked page first, then on the outer page.
  for (const [k, page] of pages.entries()) {
    const r = e2(page, note);
    if (r === 'forbidden') return forbidden();
    if (r) return finish(r.value, `${standalone && k === 0 ? 'E1+E2' : 'E2'} ${r.how}`, 'high');
  }
  // The manifest's text entries (nested pages, scripts, data) join the search from here on.
  if (templateScript) {
    const manifest = outer.scripts.find((s) => (s.attrs.type ?? '').trim() === '__bundler/manifest');
    if (manifest) {
      const decoded = decodeBundlerAssets(manifest.body);
      assets = decoded.assets;
      for (const e of decoded.errors) warnings.push(issue(IMPORT_CODES.parse, 'info', e));
      for (const a of assets) {
        if (!/html/i.test(a.mime)) continue;
        const nested = tokenizeHtml(a.text);
        pages.push(nested);
        const r = e2(nested, note);
        if (r === 'forbidden') return forbidden();
        if (r) return finish(r.value, `E1+E2 ${r.how} (bundled page ${a.uuid})`, 'high');
      }
    }
  }
  const texts = pages.flatMap(searchTexts);
  for (const a of assets ?? []) if (!/html/i.test(a.mime)) texts.push(a.text);
  const assetTexts = (assets ?? []).map((a) => a.text);

  // E3 markers (at most 64 marked blocks are read)
  for (const block of texts.flatMap(markedTexts).slice(0, 64)) {
    const a = parseMarked(block);
    note(a, 'CROCHET-MODEL markers');
    if (a && 'value' in a) return finish(a.value, 'E3 markers', 'high', assetTexts);
    if (a && 'forbidden' in a) return forbidden();
  }
  // E4 brace scan, with one work budget for the whole page
  const budget = scanBudget(texts.reduce((n, t) => n + t.length, 0));
  for (const t of texts) {
    const r = braceScan(t, 'first', budget);
    if (r && 'hit' in r) return finish(r.hit.value, `E4 brace scan (${r.hit.parser})`, 'medium', assetTexts);
    if (r && 'forbidden' in r) {
      firstProblem = { what: 'brace scan', a: r };
      return forbidden();
    }
    note(r, 'brace scan');
  }

  // E8
  const fingerprint = fingerprintsOf(pages, assetTexts);
  const problem = firstProblem as { what: string; a: Exclude<Attempt, null> } | null;
  const failure = problem
    ? issue(
        IMPORT_CODES.parse,
        'error',
        `found the crochet-model block (${problem.what}) but could not read it: ${'error' in problem.a ? problem.a.error : 'not a spec'}. ` + FIXUP_ADVICE,
      )
    : issue(IMPORT_CODES.noModel, 'error', `no crochet-model JSON in this page. ${FIXUP_ADVICE}`);
  return { standalone, fingerprint, warnings: [...warnings, ...pageWarnings(pages, fingerprint)], failure };
}

/** E8: what the user can do next (§3.7.4). */
export const FIXUP_ADVICE =
  'Copy the fix-up message, send it in the same Claude Design project and export again; or paste the JSON from the chat, drop a GLB or OBJ + MTL export, or use a screenshot.';

function pageWarnings(pages: HtmlTokens[], fingerprint: string[]): Issue[] {
  const out: Issue[] = [];
  const unknown = [...new Set(pages.flatMap((p) => p.unknownEntities))];
  if (unknown.length > 0) {
    out.push(issue(IMPORT_CODES.entity, 'info', `unknown HTML entities kept as written: ${unknown.slice(0, 8).join(' ')}${unknown.length > 8 ? ' …' : ''}`));
  }
  if (fingerprint.length === 0) {
    out.push(issue(IMPORT_CODES.formatDrift, 'info', 'this page has none of the marks of a Claude Design export we know (the format may have changed)'));
  }
  return out;
}
