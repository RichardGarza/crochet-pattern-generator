// Custom CSV palettes (DESIGN.md §2.4.4): lines `#hex,name[,brand,code,yds_per_skein]`. Track T1, sprint T1.2.
//
// Lenient on input, strict on output: a UTF-8 BOM, CRLF, blank lines, `//` comment lines, a header row, quoted
// fields ("Red, dark"), a hex without '#', upper case and the short form `#f00` are accepted; every yarn comes
// out with a lowercase `#rrggbb`. Rows that cannot be read are skipped and reported in one `W_CSV_ROW` warning;
// a repeated row (same color and name) is kept once. Ids are `custom:<rrggbb>:<name-slug>`, stable under
// reordering, so hand edits keep their yarn when the CSV is edited (§5.5.5).
import type { Issue } from '../../types/issues';
import type { Yarn } from '../../types/yarn';

export const CUSTOM_LINE_ID = 'custom';
/** More rows than this are ignored (a palette, not a database). */
export const CSV_MAX_ROWS = 1000;

/** Splits one CSV line into fields (RFC 4180 quotes; "" inside quotes is a quote). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else q = false;
      } else cur += ch;
    } else if (ch === '"' && cur.trim() === '') {
      q = true;
      cur = '';
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((f) => f.trim());
}

/** `#RGB`, `#RRGGBB`, `RRGGBB` … → lowercase `#rrggbb`, or undefined. */
export function normalizeHex(s: string): string | undefined {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s.trim());
  if (m === null) return undefined;
  let h = m[1].toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return `#${h}`;
}

const slug = (s: string): string =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

/** Parses a custom CSV palette into yarns (see the file header). */
export function parseYarnCsv(text: string): { yarns: Yarn[]; issues: Issue[] } {
  const yarns: Yarn[] = [];
  const bad: number[] = [];
  const ids = new Set<string>();
  let dropped = 0;
  const lines = String(text ?? '')
    .replace(/^﻿/, '')
    .split(/\r\n|\r|\n/);
  let first = true;
  lines.forEach((raw, n) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('//')) return;
    const f = splitCsvLine(line);
    const hex = normalizeHex(f[0] ?? '');
    if (hex === undefined) {
      // A header row ("hex,name,…") is skipped silently; anything else is reported.
      if (!(first && /^(#|hex|colou?r)/i.test(f[0] ?? '') && normalizeHex(f[0]) === undefined && /name/i.test(f[1] ?? ''))) bad.push(n + 1);
      first = false;
      return;
    }
    first = false;
    if (yarns.length >= CSV_MAX_ROWS) {
      dropped++;
      return;
    }
    const name = (f[1] ?? '').trim() || hex;
    const id = `${CUSTOM_LINE_ID}:${hex.slice(1)}:${slug(name) || 'color'}`;
    if (ids.has(id)) return;
    ids.add(id);
    const y: Yarn = { id, lineId: CUSTOM_LINE_ID, brand: (f[2] ?? '').trim() || 'Custom', line: 'Custom palette', name, hex };
    const code = (f[3] ?? '').trim();
    if (code !== '') y.number = code;
    const yds = Number((f[4] ?? '').trim());
    if ((f[4] ?? '').trim() !== '' && Number.isFinite(yds) && yds > 0) y.skeinYards = yds;
    else if ((f[4] ?? '').trim() !== '') bad.push(n + 1);
    if (/\b(heather|marl|fleck|tweed)\b/i.test(name)) y.textured = true;
    yarns.push(y);
  });
  const issues: Issue[] = [];
  if (bad.length > 0 || dropped > 0) {
    const where = bad.length > 0 ? `line${bad.length > 1 ? 's' : ''} ${bad.slice(0, 8).join(', ')}${bad.length > 8 ? ', …' : ''}` : '';
    issues.push({
      code: 'W_CSV_ROW',
      severity: 'warn',
      message: [
        bad.length > 0 ? `Some rows of the custom palette could not be read (${where}); each row is #hex,name[,brand,code,yards per skein].` : '',
        dropped > 0 ? `Only the first ${CSV_MAX_ROWS} colors are used (${dropped} more ignored).` : '',
      ]
        .filter(Boolean)
        .join(' '),
    });
  }
  return { yarns, issues };
}
