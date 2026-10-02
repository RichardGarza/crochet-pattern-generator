// Track T8 — what the pattern PDF says, section by section (DESIGN.md §1.3 F8, §2.8; integration-s2 task T8-3).
// Pure: strings and spans from a `PatternDoc`; pdf.ts lays them out.
//
// Section order (F8): the cover (chart preview, finished size, skill level), materials and yardage, gauge, notes,
// abbreviations (and special stitches), the chart (page map, then the tiled pages), the written instructions with
// a checkbox per row and the border rounds.
//
// The instructions are T2's text: `renderPatternText(doc, { format: 'md', terms, hand, dialect })` (frozen,
// §5.2.1), read by `markdown.ts`. Its front matter (materials, gauge, notes, abbreviations…), which the PDF prints
// from the doc on the cover pages, is left out so nothing appears twice. Until T2.3 implements it (a stub until
// the Sprint 3 merge) — or should it ever throw — the instructions come from T2's frozen line renderers
// (`renderFoundation`, `renderLine`, `renderLineExtras`) instead: the same lines, without the border's spacing
// hints that only `renderPatternText` adds (§2.7.10). T8 formats no pattern text of its own.
import type { MaterialsLine, PatternDoc, Technique2D, Terms } from '../../types';
import { roundHalfUp } from '../gauge/round';
import { renderFoundation, renderLine, renderLineExtras } from '../pattern/render';
import { renderPatternText } from '../pattern/text';
import { isImplemented } from '../stub';
import { type MdBlock, parseMarkdown } from './markdown';
import { type Span, plainText } from './text';

/** The sections in print order, with their bookmark titles. */
export const SECTION_ORDER = ['cover', 'materials', 'gauge', 'notes', 'abbreviations', 'chart', 'instructions'] as const;
export type SectionId = (typeof SECTION_ORDER)[number];

export const SECTION_TITLES: Readonly<Record<SectionId, string>> = {
  cover: 'Cover',
  materials: 'Materials and yardage',
  gauge: 'Gauge',
  notes: 'Notes',
  abbreviations: 'Abbreviations',
  chart: 'Chart',
  instructions: 'Instructions',
};

/** The technique as a reader names it, in the pattern's terms (UK sc = dc, hdc = htr). */
export function techniqueLabel(t: Technique2D, terms: Terms): string {
  const uk = terms === 'uk';
  switch (t) {
    case 'sc_graphgan':
      return uk ? 'Double crochet graphgan' : 'Single crochet graphgan';
    case 'hdc_graphgan':
      return uk ? 'Half treble crochet graphgan' : 'Half double crochet graphgan';
    case 'sc_tapestry':
      return 'Tapestry crochet';
    case 'sc_tapestry_round':
      return 'Tapestry crochet in the round';
    case 'c2c':
      return 'Corner to corner (C2C)';
    case 'mosaic_overlay':
      return 'Overlay mosaic crochet';
  }
}

/** Inches to the nearest ¼, with the fraction character: `9¾"`. */
export function formatInches(inches: number): string {
  const q = roundHalfUp(Math.max(0, inches) * 4) / 4;
  const whole = Math.floor(q);
  const frac = ['', '¼', '½', '¾'][Math.round((q - whole) * 4)] ?? '';
  return `${whole === 0 && frac ? '' : whole}${frac}"`;
}

/** Centimeters to the nearest 0.5: `25 cm`, `24.5 cm`. */
export function formatCm(inches: number): string {
  const v = roundHalfUp(Math.max(0, inches) * 2.54 * 2) / 2;
  return `${Number.isInteger(v) ? v : v.toFixed(1)} cm`;
}

/** §2.8: `Approx 10" (25 cm) wide × 7" (18 cm) tall` (and deep for 3D). */
export function finishedSizeText(f: PatternDoc['finishedSize']): string {
  const part = (x: number, word: string): string => `${formatInches(x)} (${formatCm(x)}) ${word}`;
  const parts = [part(f.wIn, 'wide'), part(f.hIn, 'tall')];
  if (f.dIn !== undefined && f.dIn > 0) parts.push(part(f.dIn, 'deep'));
  return `Approx ${parts.join(' × ')}`;
}

/** "±12%" of the finished size, or null when the doc gives none. */
export function toleranceText(f: PatternDoc['finishedSize']): string | null {
  return Number.isFinite(f.tolPct) && f.tolPct > 0 ? `±${roundHalfUp(f.tolPct)}%` : null;
}

/** §2.8 hook line: "5 mm (US H-8), or the size needed to obtain gauge". */
export function hookText(hook: PatternDoc['hook']): string {
  const mm = Number.isFinite(hook.mm) ? `${Number(hook.mm.toFixed(2))} mm` : 'Hook';
  return `${mm}${hook.us ? ` (US ${hook.us})` : ''}, or the size needed to obtain gauge`;
}

const whole = (x: number): number => Math.max(0, roundHalfUp(x));

/** One printed row of the materials table. */
export interface MaterialRow {
  code: string;
  hex: string;
  /** Yarn: brand and line on the first line, color name and number on the second. */
  yarn: string;
  yarnDetail: string | null;
  /** "ΔE 1.8" — how close the yarn is to the chart color (CIEDE2000), when matched to a yarn. */
  match: string | null;
  stitches: string;
  share: string;
  strands: string;
  yards: string;
  yardRange: string;
  meters: string;
  skeins: string;
  grams: string;
}

/** "29–49" (whole yards, at least 1), or "" when both ends are the same. */
function yardRange(low: number, high: number): string {
  const a = Math.max(1, Math.floor(low));
  const b = Math.max(1, Math.ceil(high));
  return a === b ? '' : `${a}–${b}`;
}

/** Whole yards, at least 1 (a tiny amount still needs a length of yarn). */
function yd(x: number): number {
  return Math.max(1, whole(x));
}

export function materialRows(doc: Pick<PatternDoc, 'materials'>): MaterialRow[] {
  const total = doc.materials.reduce((s, m) => s + Math.max(0, m.stitches), 0);
  return doc.materials.map((m: MaterialsLine) => {
    const y = m.yarn;
    const yarnName = y ? [y.brand, y.line].filter(Boolean).join(' ') : m.name;
    const detail = y ? [y.name, y.number ? `(${y.number})` : ''].filter(Boolean).join(' ') : null;
    const gramsHigh = m.grams !== undefined && m.yards > 0 ? (m.grams * m.yardsHigh) / m.yards : undefined;
    return {
      code: m.code,
      hex: m.hex,
      yarn: yarnName || m.code,
      yarnDetail: detail && detail !== yarnName ? detail : null,
      match: m.deltaE00 !== undefined && Number.isFinite(m.deltaE00) ? `ΔE ${m.deltaE00.toFixed(1)}` : null,
      stitches: whole(m.stitches).toLocaleString('en-US'),
      share: total > 0 ? (m.stitches > 0 && (100 * m.stitches) / total < 0.5 ? '<1%' : `${whole((100 * m.stitches) / total)}%`) : '',
      strands: m.strands > 0 ? String(whole(m.strands)) : '—',
      yards: `${yd(m.yards)} yd`,
      yardRange: yardRange(m.yardsLow, m.yardsHigh),
      meters: `${Math.max(1, whole(m.meters))} m`,
      skeins: m.skeins !== undefined && m.skeins > 0 ? String(m.skeins) : '—',
      grams: m.grams !== undefined && m.grams > 0 ? `${Math.max(1, whole(m.grams))} g${gramsHigh !== undefined ? ` (to ${Math.max(1, Math.ceil(gramsHigh))})` : ''}` : '—',
    };
  });
}

/** Totals of the materials table. */
export function materialTotals(doc: Pick<PatternDoc, 'materials'>): { stitches: string; yards: string; yardRange: string; meters: string } {
  const sum = (f: (m: MaterialsLine) => number): number => doc.materials.reduce((s, m) => s + (Number.isFinite(f(m)) ? f(m) : 0), 0);
  return {
    stitches: whole(sum((m) => m.stitches)).toLocaleString('en-US'),
    yards: `${yd(sum((m) => m.yards))} yd`,
    yardRange: yardRange(sum((m) => m.yardsLow), sum((m) => m.yardsHigh)),
    meters: `${Math.max(1, whole(sum((m) => m.meters)))} m`,
  };
}

/** The strands column's heading: bobbins for bobbin techniques, strands for tapestry. */
export function strandsHeading(t: Technique2D | undefined): string {
  return t === 'sc_tapestry' || t === 'sc_tapestry_round' || t === 'mosaic_overlay' ? 'Strands' : 'Bobbins';
}

// ---- the written instructions

/** One block of the Instructions section. */
export type InstructionBlock =
  | { kind: 'heading'; level: 2 | 3; text: Span[] }
  /** A row, round or foundation: a checkbox, a bold label ("Row 1 (RS) ←:") and the rest. */
  | { kind: 'step'; label: Span[]; body: Span[] }
  | { kind: 'text'; spans: Span[]; bullet?: string; depth?: number }
  | { kind: 'table'; header: Span[][]; rows: Span[][][] };

export interface PatternText {
  md: string;
  /** Where the text came from: T2's `renderPatternText`, or the fallback over T2's line renderers. */
  source: 'renderPatternText' | 'line-renderers';
  /** Why the fallback was used. */
  reason?: string;
}

/** Markdown escaping for the fallback's lines (they come from T2's renderers as plain text). */
function mdEscape(s: string): string {
  return s.replace(/([\\`*_[\]#|])/g, '\\$1');
}

/**
 * The instructions as Markdown from T2's frozen line renderers: per piece its intro, foundation sentences, lines,
 * extras and finish; then the finishing steps. Used only while `renderPatternText` is not available.
 */
export function lineRendererMarkdown(doc: PatternDoc): string {
  const out: string[] = [];
  const many = doc.pieces.length > 1;
  for (const piece of doc.pieces) {
    if (many || (piece.title && doc.kind === '3d')) out.push(`## ${mdEscape(piece.title)}${piece.makeCount > 1 ? ` (make ${piece.makeCount})` : ''}`, '');
    for (const p of piece.intro) out.push(mdEscape(p), '');
    for (const line of piece.lines) {
      const foundation = renderFoundation(line, { terms: doc.terms, docKind: doc.kind });
      if (foundation) {
        const border = /^(.*\bborder\b[^:]*):\s*$/i.exec(foundation);
        out.push(border ? `### ${mdEscape(border[1])}` : mdEscape(foundation), '');
      }
      out.push(mdEscape(renderLine(line, { dialect: doc.dialect, terms: doc.terms, hand: doc.hand, docKind: doc.kind })), '');
      for (const extra of renderLineExtras(line, { terms: doc.terms })) out.push(mdEscape(extra), '');
    }
    if (piece.finish.text) out.push(mdEscape(piece.finish.text), '');
  }
  if (doc.finishing.length > 0) {
    out.push('## Finishing', '');
    for (const f of doc.finishing) out.push(`- ${mdEscape(f)}`);
    out.push('');
  }
  return out.join('\n');
}

/** The pattern text for the PDF: `renderPatternText` (md, the doc's terms, hand and dialect), else the fallback. */
export function patternText(doc: PatternDoc): PatternText {
  if (!isImplemented(renderPatternText)) return { md: lineRendererMarkdown(doc), source: 'line-renderers', reason: 'renderPatternText is not implemented yet' };
  try {
    const md = renderPatternText(doc, { format: 'md', terms: doc.terms, hand: doc.hand, dialect: doc.dialect });
    if (typeof md === 'string' && md.trim()) return { md, source: 'renderPatternText' };
    return { md: lineRendererMarkdown(doc), source: 'line-renderers', reason: 'renderPatternText returned no text' };
  } catch (e) {
    return { md: lineRendererMarkdown(doc), source: 'line-renderers', reason: `renderPatternText failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Headings of front matter the PDF prints from the doc itself (cover pages) — left out of the instructions. */
const FRONT_MATTER =
  /^(materials?( and yardage)?|yarns?|supplies|you will need|what you need|hooks?|notions|tools|gauge|tension|finished (size|measurements?)|sizes?|measurements?|skill( level)?|level|abbreviations?|special stitch(es)?|stitch(es)? used|stitch guide|notes?|pattern notes|terms|terminology|chart( key)?|colou?r key|key|word chart|written chart)\b/i;

/** A row, round or foundation line, by its first words. */
const STEP = /^(rows?|rnds?|rounds?)\s+\d|^foundation\b/i;

/** Splits a step's spans into its label (through the first ":" in the first 60 characters) and the rest. */
export function splitStep(spans: readonly Span[]): { label: Span[]; body: Span[] } {
  const text = plainText(spans);
  const colon = text.indexOf(':');
  const cut = colon >= 0 && colon < 60 ? colon + 1 : (/^\S+\s+\S+/.exec(text)?.[0].length ?? text.length);
  const label: Span[] = [];
  const body: Span[] = [];
  let at = 0;
  for (const s of spans) {
    const end = at + s.text.length;
    if (end <= cut) label.push({ ...s, style: { ...s.style, style: 'bold' } });
    else if (at >= cut) body.push(s);
    else {
      label.push({ text: s.text.slice(0, cut - at), style: { ...s.style, style: 'bold' } });
      body.push({ ...s, text: s.text.slice(cut - at) });
    }
    at = end;
  }
  if (body.length > 0) body[0] = { ...body[0], text: body[0].text.replace(/^\s+/, '') };
  return { label, body: body.filter((s) => s.text.length > 0) };
}

/** Muted color for the strand cues after " · " (`· join B (bobbin 1) · carry A`). */
export const CUE_COLOR: readonly [number, number, number] = [110, 103, 94];

/** The step's body with everything from the first " · " shown muted. */
export function muteCues(body: readonly Span[]): Span[] {
  const out: Span[] = [];
  let muted = false;
  for (const s of body) {
    if (muted) {
      out.push({ ...s, style: { ...s.style, color: CUE_COLOR } });
      continue;
    }
    const i = s.text.indexOf(' · ');
    if (i < 0) {
      out.push(s);
      continue;
    }
    if (i > 0) out.push({ ...s, text: s.text.slice(0, i) });
    out.push({ ...s, text: s.text.slice(i), style: { ...s.style, color: CUE_COLOR } });
    muted = true;
  }
  return out;
}

const norm = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * The Instructions section's blocks from the pattern Markdown: front-matter sections dropped (the cover pages
 * print them), the title heading dropped, rows / rounds / foundation lines as checkbox steps.
 */
export function instructionBlocks(md: string, title: string): InstructionBlock[] {
  const blocks = parseMarkdown(md);
  const out: InstructionBlock[] = [];
  let skipping = false;
  let skipLevel = 0;
  let inPreamble = true;
  const preamble: MdBlock[] = [];
  const headingLevels = blocks.filter((b): b is Extract<MdBlock, { kind: 'heading' }> => b.kind === 'heading' && norm(plainText(b.spans)) !== norm(title)).map((b) => b.level);
  const top = headingLevels.length > 0 ? Math.min(...headingLevels) : 2;

  const emit = (b: MdBlock): void => {
    if (b.kind === 'heading') {
      out.push({ kind: 'heading', level: b.level <= top ? 2 : 3, text: b.spans });
    } else if (b.kind === 'paragraph' || b.kind === 'item') {
      if (STEP.test(plainText(b.spans).trim())) {
        const { label, body } = splitStep(b.spans);
        out.push({ kind: 'step', label, body: muteCues(body) });
      } else if (b.kind === 'item') out.push({ kind: 'text', spans: b.spans, bullet: b.ordered ? b.marker : '•', depth: b.depth });
      else out.push({ kind: 'text', spans: b.spans });
    } else if (b.kind === 'table') out.push({ kind: 'table', header: b.header, rows: b.rows });
  };

  for (const b of blocks) {
    if (b.kind === 'heading') {
      const text = plainText(b.spans);
      if (norm(text) === norm(title) || (b.level === 1 && inPreamble && out.length === 0 && preamble.length === 0)) continue;
      if (inPreamble) {
        // What came before the first section heading is kept only when it holds rows (a pattern without headings).
        if (preamble.some((p) => (p.kind === 'paragraph' || p.kind === 'item') && STEP.test(plainText(p.spans).trim()))) preamble.forEach(emit);
        inPreamble = false;
      }
      if (skipping && b.level > skipLevel) continue;
      skipping = FRONT_MATTER.test(text.trim());
      skipLevel = b.level;
      if (!skipping) emit(b);
      continue;
    }
    if (inPreamble) {
      preamble.push(b);
      continue;
    }
    if (!skipping) emit(b);
  }
  if (inPreamble && preamble.some((p) => (p.kind === 'paragraph' || p.kind === 'item') && STEP.test(plainText(p.spans).trim()))) preamble.forEach(emit);
  return out;
}

/** Rounds of the border (the highest border line number), or 0. */
export function borderRounds(doc: Pick<PatternDoc, 'pieces'>): number {
  let n = 0;
  for (const piece of doc.pieces) for (const l of piece.lines) if (l.kind === 'border') n = Math.max(n, l.nEnd ?? l.n);
  return n;
}
