// Test helper: the captured Claude Design teddy (fixtures/claude-design/teddy-bear, read-only) and small builders
// for synthetic inputs (zips, standalone pages, chat replies).
import { readFileSync } from 'node:fs';
import { strToU8, zipSync, type Zippable } from 'fflate';
import type { ImportInput } from '../../../../types/importer';

export const FIXTURES = new URL('../../../../../fixtures/', import.meta.url);
export const TEDDY_DIR = new URL('claude-design/teddy-bear/', FIXTURES);

export const readFixture = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(new URL(name, TEDDY_DIR)));
export const readFixtureText = (name: string): string => readFileSync(new URL(name, TEDDY_DIR), 'utf8');

/** The canonical teddy, byte for byte (G12 target). */
export const CANONICAL_TEDDY = readFileSync(new URL('models/teddy.canonical.json', FIXTURES), 'utf8');
/** The spec as Claude Design printed it in the chat. */
export const OBSERVED_JSON = readFixtureText('teddy-bear.crochet-model.json');
export const ARCHIVE_PAGE = readFixtureText('project-archive/Amigurumi Teddy Bear.html');

export function fileInput(name: string, bytes: Uint8Array | string): ImportInput {
  const u8 = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
  return { kind: 'file', name, bytes: u8.slice().buffer as ArrayBuffer };
}

export function fixtureInput(name: string): ImportInput {
  return fileInput(name.slice(name.lastIndexOf('/') + 1), readFixture(name));
}

/** A zip of the given entries (text or bytes), with a fixed entry time so the bytes are deterministic. */
export function makeZip(entries: Record<string, string | Uint8Array | [string | Uint8Array, Date]>): Uint8Array<ArrayBuffer> {
  const z: Zippable = {};
  for (const [name, value] of Object.entries(entries)) {
    const [data, mtime] = Array.isArray(value) ? value : [value, new Date(Date.UTC(2026, 8, 30, 12, 0, 0))];
    z[name] = [typeof data === 'string' ? strToU8(data) : data, { mtime }];
  }
  return new Uint8Array(zipSync(z));
}

/** A chat reply the way claude.ai shows it: prose, the fenced JSON, more prose. */
export function chatReply(json: string): string {
  return [
    'Here is the complete crochet-model spec for the bear, exactly as embedded in the page:',
    '',
    '```json',
    json.trim(),
    '```',
    '',
    'A few notes: the "parts" list keeps every id stable, so you can say { "make the ears bigger" } and I\'ll update it.',
  ].join('\n');
}

/** Straight double quotes → alternating curly quotes (what a word processor does to pasted JSON). */
export function curlyQuotes(text: string): string {
  let open = true;
  return text.replace(/"/g, () => {
    const q = open ? '“' : '”';
    open = !open;
    return q;
  });
}

/** The page of the project archive with its spec replaced (keeps everything else as Claude Design wrote it). */
export function archivePageWith(spec: unknown): string {
  const start = ARCHIVE_PAGE.indexOf('<script type="application/json" id="crochet-model">');
  const end = ARCHIVE_PAGE.indexOf('</script>', start);
  const open = '<script type="application/json" id="crochet-model">';
  return `${ARCHIVE_PAGE.slice(0, start)}${open}\n${JSON.stringify(spec, null, 2)}\n${ARCHIVE_PAGE.slice(end)}`;
}

/** A minimal `__bundler` standalone page around `pageHtml`, the way Claude Design writes one ([08]). */
export function standalonePage(pageHtml: string, manifest: Record<string, unknown> = {}): string {
  const template = JSON.stringify(pageHtml).replace(/<\//g, '<\\u002F');
  return [
    '<!DOCTYPE html><html><head><title>Bundled Page</title></head><body>',
    '<div id="__bundler_loading">Unpacking...</div>',
    '<script>document.querySelector(\'script[type="__bundler/template"]\');</script>',
    `<script type="__bundler/manifest">${JSON.stringify(manifest)}</script>`,
    '<script type="__bundler/ext_resources">[]</script>',
    `<script type="__bundler/template">${template}</script>`,
    '</body></html>',
  ].join('\n');
}

/** The derived fixtures written by scripts/make-cd-fixtures.mjs (fixtures/claude-design/teddy-derived/). */
export const DERIVED_DIR = new URL('claude-design/teddy-derived/', FIXTURES);
export const readDerived = (name: string): Uint8Array<ArrayBuffer> => new Uint8Array(readFileSync(new URL(name, DERIVED_DIR)));
export const derivedInput = (name: string): ImportInput => fileInput(name, readDerived(name));
