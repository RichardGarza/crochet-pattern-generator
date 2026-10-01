// The shipped yarn lines (DESIGN.md §2.4.4, §5.6 "Yarn data"). Track T1, sprint T1.2.
//
// Lines are generated into src/data/yarns/<id>.json by scripts/import-yarns.mjs, which refuses any line
// without a complete CC BY provenance record. Until another line has one, only Red Heart Super Saver
// (makebead/craft-color-codes, 44 shades, CC BY 4.0) ships; the user's stash and custom CSV palettes come with
// the request.
import type { Cyc } from '../../types/units';
import type { Yarn, YarnLine } from '../../types/yarn';
import rhss from '../../data/yarns/red-heart-super-saver.json';

/** The provenance record of a shipped line (the JSON's `provenance`; §5.6). */
export interface YarnProvenance {
  source: string;
  license: string;
  licenseEvidence: string;
  retrieved: string;
  attribution: string;
  changes: string;
  licenseUrl?: string;
  licenseStatement?: string;
  repository?: string;
  commit?: string;
  tag?: string;
  notes?: string;
  input?: { file: string; sha256: string; format: string };
  skeinSource?: string;
}

/** A shipped line file: a `YarnLine` plus its attribution line and provenance record. */
export interface YarnLineFile extends YarnLine {
  attribution: string;
  provenance: YarnProvenance;
}

/** The default reference line: names the colors of the "auto" palette (§2.4.4). */
export const DEFAULT_REFERENCE_LINE_ID = 'red-heart-super-saver';

const asLine = (json: unknown): YarnLineFile => {
  const l = json as YarnLineFile;
  return { ...l, cyc: l.cyc as Cyc, yarns: l.yarns.map((y) => ({ ...y, cyc: y.cyc as Cyc | undefined }) as Yarn) };
};

/** Every shipped line, in a fixed order. */
export const SHIPPED_LINES: readonly YarnLineFile[] = Object.freeze([asLine(rhss)]);

const byId = new Map(SHIPPED_LINES.map((l) => [l.id, l]));

/** A shipped line by id. */
export function getShippedLine(id: string): YarnLineFile | undefined {
  return byId.get(id);
}

/** Where to look a line id up: the request's lines first (they may hold a newer copy), then the shipped ones. */
export function findLine(id: string, lines: readonly YarnLine[] = []): YarnLine | undefined {
  return lines.find((l) => l.id === id) ?? byId.get(id);
}

const HEX = /^#[0-9a-f]{6}$/;
const ALLOWED_LICENSES = ['CC-BY-4.0', 'CC0-1.0'];

/**
 * Why a line file is not shippable (empty when it is): every yarn has a lowercase `#rrggbb` hex, a name, a
 * unique id that starts with the line id, and the line's brand; the line has an attribution and a complete
 * provenance record with an allowed licence (§5.6).
 */
export function lineFileProblems(l: YarnLineFile): string[] {
  const out: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]*$/.test(l.id ?? '')) out.push(`line id ${String(l.id)} is not lowercase letters, digits and dashes`);
  if (typeof l.attribution !== 'string' || l.attribution.trim() === '') out.push('no attribution line');
  if (typeof l.source !== 'string' || !/^https:\/\//.test(l.source)) out.push('source is not an https URL');
  if (!ALLOWED_LICENSES.includes(l.license)) out.push(`licence ${String(l.license)} is not allowed`);
  const p = l.provenance as Partial<YarnProvenance> | undefined;
  if (p === undefined) out.push('no provenance record');
  else {
    for (const k of ['source', 'license', 'licenseEvidence', 'retrieved', 'attribution', 'changes'] as const) {
      if (typeof p[k] !== 'string' || p[k].trim() === '') out.push(`provenance.${k} is missing`);
    }
    if (p.source !== l.source) out.push('provenance.source differs from source');
    if (p.license !== l.license) out.push('provenance.license differs from license');
    if (typeof p.retrieved === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(p.retrieved)) out.push('provenance.retrieved is not a date');
  }
  if (!Array.isArray(l.yarns) || l.yarns.length === 0) out.push('no yarns');
  const ids = new Set<string>();
  for (const y of l.yarns ?? []) {
    if (!HEX.test(y.hex)) out.push(`${y.id}: hex ${y.hex} is not lowercase #rrggbb`);
    if (typeof y.name !== 'string' || y.name.trim() === '') out.push(`${y.id}: no name`);
    if (ids.has(y.id)) out.push(`${y.id}: duplicate id`);
    ids.add(y.id);
    if (!y.id.startsWith(`${l.id}:`)) out.push(`${y.id}: id does not start with ${l.id}:`);
    if (y.lineId !== l.id) out.push(`${y.id}: lineId ${y.lineId}`);
    if (y.brand !== l.brand || y.line !== l.line) out.push(`${y.id}: brand/line differ from the line's`);
  }
  return out;
}
