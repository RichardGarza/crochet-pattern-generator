// Track T2 — the whole pattern as plain text or Markdown (DESIGN.md §5.2.1, §1.3 F1 step 8, F8). T8's export
// dialog and PDF call this; T8 never formats pattern text itself.
//
// Sections in the order of a printed pattern (F8): title and facts (skill, finished size, gauge, hook, chart,
// who it is written for), materials, notions, notes, abbreviations, special stitches, each piece (its intro,
// lines, finish), assembly, finishing.
//
// Lines are printed as written for `doc.hand` (§2.7.2: the writer decides the hand; showing the other hand rebuilds
// the pattern), so `o.hand` does not change them; the header names the hand the pattern was written for. Lines come
// from the model and print in `o.terms` and `o.dialect` through `renderLineWith`; a border prints through
// `renderBorderLines` (the §2.7.10 sentences with the spacing hints and the fold of Rnds 2–n). The free text a
// `PatternDoc` already holds (notes, gauge text, finish, assembly) is in `doc.terms`: it is converted to UK terms
// with `toTerms` when `o.terms` is 'uk' and the doc is US; a UK doc's free text cannot be turned back into US
// terms and prints as it is (deviation, see docs/tracks/t2.md). Abbreviations and special stitches are listed
// again from the lines when the terms differ from the doc's.
import type { RenderPatternTextFn } from '../../types/entryPoints';
import type { Hand, Line, MaterialsLine, PatternDoc, Piece, Terms } from '../../types';
import { renderBorderLines } from '../techniques/border';
import { type DecMethod, renderFoundation, renderLineExtras, renderLineWith } from './render';
import { abbreviationsFor, specialStitchesFor, toTerms } from './terminology';

export type PatternTextOptions = Parameters<RenderPatternTextFn>[1];

const TECHNIQUE_NAMES: Record<string, string> = {
  sc_graphgan: 'single crochet graphgan',
  sc_tapestry: 'single crochet tapestry',
  sc_tapestry_round: 'single crochet tapestry in the round',
  c2c: 'corner to corner (C2C)',
  hdc_graphgan: 'half double crochet graphgan',
  mosaic_overlay: 'overlay mosaic',
};

/** Markdown: characters that would start emphasis, code, links or HTML are escaped (the text reads the same). */
export function mdEscape(text: string): string {
  return text.replace(/[\\`*_[\]<>]/g, (c) => `\\${c}`);
}

/** One decimal, no trailing ".0" padding beyond one place: 39.9, 52, 0.5. */
function num1(x: number): string {
  if (!Number.isFinite(x)) return '0';
  const r = Math.round(x * 10) / 10;
  return Number.isInteger(r) ? String(r) : r.toFixed(1);
}

function sizeText(doc: PatternDoc): string | null {
  const s = doc.finishedSize;
  if (!s || !(s.wIn > 0) || !(s.hIn > 0)) return null;
  const cm = (x: number) => num1(x * 2.54);
  const tol = s.tolPct > 0 ? `, ±${num1(s.tolPct)}%` : '';
  if (s.dIn !== undefined && s.dIn > 0 && doc.kind === '2d') {
    return `${num1(s.wIn)} in around × ${num1(s.hIn)} in tall (${cm(s.wIn)} × ${cm(s.hIn)} cm${tol})`;
  }
  if (s.dIn !== undefined && s.dIn > 0) {
    return `${num1(s.wIn)} × ${num1(s.hIn)} × ${num1(s.dIn)} in (${cm(s.wIn)} × ${cm(s.hIn)} × ${cm(s.dIn)} cm${tol})`;
  }
  return `${num1(s.wIn)} × ${num1(s.hIn)} in (${cm(s.wIn)} × ${cm(s.hIn)} cm${tol})`;
}

function hookText(doc: PatternDoc): string | null {
  if (!(doc.hook?.mm > 0)) return null;
  return doc.hook.us ? `${num1(doc.hook.mm)} mm (${doc.hook.us})` : `${num1(doc.hook.mm)} mm`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Whole yards, or one decimal below 10 (a 1.4 yd color is not "1 yd"). */
function yd(x: number): string {
  return x < 10 ? num1(x) : String(Math.round(x));
}

/** `A  Cherry Red (Red Heart Super Saver 319): 245 yd (196–294 yd), 224 m · 2 skeins · 135 g · 3 bobbins` */
export function materialsText(m: MaterialsLine): string {
  const yarn = m.yarn;
  const where = yarn ? [yarn.brand, yarn.line].filter((x) => x && !m.name.includes(x)).join(' ') : '';
  const number = yarn?.number && !m.name.includes(yarn.number) ? ` ${yarn.number}` : '';
  const source = where || number ? ` (${`${where}${number}`.trim()})` : '';
  const parts: string[] = [`${yd(m.yards)} yd (${yd(m.yardsLow)}–${yd(m.yardsHigh)} yd), ${yd(m.meters)} m`];
  if (m.skeins !== undefined && m.skeins > 0) parts.push(plural(m.skeins, 'skein'));
  if (m.grams !== undefined && m.grams > 0) parts.push(`${Math.round(m.grams)} g`);
  if (m.strands > 1) parts.push(plural(m.strands, 'bobbin'));
  return `${m.code}  ${m.name}${source}: ${parts.join(' · ')}`;
}

/** The decrease the verbose dialect names: a pattern that lists sc2tog and not invdec uses sc2tog. */
function decMethodOf(doc: PatternDoc): DecMethod | undefined {
  const abbrs = new Set(doc.abbreviations.map((a) => a.abbr.toLowerCase()));
  if (abbrs.has('invdec')) return 'invdec';
  if (abbrs.has('sc2tog') || abbrs.has('dc2tog')) return 'sc2tog';
  return undefined;
}

/** Free text of the doc in the wanted terms (only US → UK can be converted). */
function freeText(doc: PatternDoc, terms: Terms): (text: string) => string {
  if (doc.terms === 'us' && terms === 'uk') return (text) => toTerms(text, 'uk');
  return (text) => text;
}

interface PrintedLine {
  text: string;
  /** A blank line before it (the border block). */
  gap?: boolean;
  /** Sentences printed on their own lines after it. */
  extras: string[];
}

/** A piece's lines as printed: foundation sentences, lines, border blocks, extras. */
export function pieceLines(doc: PatternDoc, piece: Piece, o: { terms: Terms; dialect: 'compact' | 'verbose' }): PrintedLine[] {
  const out: PrintedLine[] = [];
  const hand: Hand = doc.hand === 'left' ? 'left' : 'right';
  const chart = doc.chart;
  const border = chart ? { technique: chart.technique, rows: chart.grid.rows, cols: chart.grid.cols } : undefined;
  const decMethod = decMethodOf(doc);
  const lines = piece.lines ?? [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind === 'border') {
      let j = i;
      while (j < lines.length && lines[j].kind === 'border') j++;
      const block: Line[] = lines.slice(i, j);
      const texts = renderBorderLines(block, { terms: o.terms, hand, ...border });
      texts.forEach((text, k) => out.push({ text, extras: [], gap: k === 0 && out.length > 0 }));
      // Notes of border rounds (none today) still print, after the block.
      const extras = block.flatMap((l) => renderLineExtras(l, { terms: o.terms }));
      if (extras.length > 0 && out.length > 0) out[out.length - 1].extras.push(...extras);
      i = j - 1;
      continue;
    }
    const before = renderFoundation(line, { terms: o.terms, docKind: doc.kind });
    if (before !== null) out.push({ text: before, extras: [] });
    out.push({
      text: renderLineWith(line, { dialect: o.dialect, terms: o.terms, hand, decMethod, docKind: doc.kind, border }),
      extras: renderLineExtras(line, { terms: o.terms }),
    });
  }
  return out;
}

interface Section {
  title: string;
  /** Paragraphs (plain lines). */
  paragraphs?: string[];
  /** List items, each with optional sub-items. */
  items?: { text: string; sub?: string[]; gap?: boolean }[];
  /** Plain text prints the items as bullets ("- ") instead of bare lines (notes, finishing). */
  bullets?: boolean;
  /** Numbered steps. */
  steps?: string[];
  /** Paragraphs printed after the list. */
  after?: string[];
}

function allLines(doc: PatternDoc): Line[] {
  return doc.pieces.flatMap((p) => p.lines ?? []);
}

function sections(doc: PatternDoc, o: PatternTextOptions): { facts: string[]; body: Section[] } {
  const terms: Terms = o.terms === 'uk' ? 'uk' : 'us';
  const dialect = o.dialect === 'verbose' ? 'verbose' : 'compact';
  const ft = freeText(doc, terms);
  const facts: string[] = [];
  if (doc.skill) facts.push(`Skill level: ${doc.skill.name} (${doc.skill.level} of 4)`);
  const size = sizeText(doc);
  if (size) facts.push(`Finished size: ${size}`);
  if (doc.gaugeText) facts.push(`${terms === 'uk' ? 'Tension' : 'Gauge'}: ${ft(doc.gaugeText)}`);
  const hook = hookText(doc);
  if (hook) facts.push(`Hook: ${hook}`);
  if (doc.chart) {
    const g = doc.chart.grid;
    const tech = TECHNIQUE_NAMES[doc.chart.technique] ?? doc.chart.technique;
    const unit = doc.chart.technique === 'c2c' ? `${g.cols} × ${g.rows} tiles` : `${plural(g.cols, 'st')} × ${plural(g.rows, doc.chart.technique === 'sc_tapestry_round' ? 'round' : 'row')}`;
    facts.push(`Chart: ${unit}, ${toTerms(tech, terms)}`);
  }
  facts.push(`Written for ${doc.hand === 'left' ? 'left' : 'right'}-handed crocheters, in ${terms === 'uk' ? 'UK' : 'US'} terms.`);

  const body: Section[] = [];
  if (doc.materials.length > 0 || doc.notions.length > 0) {
    body.push({
      title: 'Materials',
      items: doc.materials.map((m) => ({ text: materialsText(m) })),
      after: doc.notions.length > 0 ? [`Notions: ${doc.notions.map(ft).join('; ')}.`] : undefined,
    });
  }
  if (doc.notes.length > 0) body.push({ title: 'Notes', bullets: true, items: doc.notes.map((n) => ({ text: ft(n) })) });
  const lines = allLines(doc);
  const decMethod = decMethodOf(doc);
  const abbreviations = terms === doc.terms || lines.length === 0 ? doc.abbreviations : abbreviationsFor(lines, terms, decMethod);
  if (abbreviations.length > 0) body.push({ title: 'Abbreviations', items: abbreviations.map((a) => ({ text: `${a.abbr} = ${a.meaning}` })) });
  const special = terms === doc.terms || lines.length === 0 ? doc.specialStitches : specialStitchesFor(lines, terms, decMethod);
  if (special.length > 0) body.push({ title: 'Special stitches', items: special.map((s) => ({ text: `${s.name}: ${s.text}` })) });
  for (const piece of doc.pieces) {
    const printed = pieceLines(doc, piece, { terms, dialect });
    const title = piece.makeCount > 1 ? `${piece.title} (make ${piece.makeCount})` : piece.title;
    body.push({
      title,
      paragraphs: (piece.intro ?? []).map(ft),
      items: printed.map((p) => ({ text: p.text, sub: p.extras.length > 0 ? p.extras : undefined, gap: p.gap })),
      after: piece.finish?.text ? [ft(piece.finish.text)] : undefined,
    });
  }
  if (doc.assembly.length > 0) {
    const steps = [...doc.assembly].sort((a, b) => a.order - b.order).map((s) => ft(s.text));
    body.push({ title: 'Assembly', steps });
  }
  if (doc.finishing.length > 0) body.push({ title: 'Finishing', bullets: true, items: doc.finishing.map((f) => ({ text: ft(f) })) });
  return { facts, body };
}

function renderTxt(doc: PatternDoc, o: PatternTextOptions): string {
  const { facts, body } = sections(doc, o);
  const out: string[] = [doc.title, '='.repeat(Math.max(3, [...doc.title].length)), '', ...facts];
  for (const s of body) {
    out.push('', s.title.toUpperCase(), '');
    if (s.paragraphs && s.paragraphs.length > 0) out.push(...s.paragraphs, '');
    for (const item of s.items ?? []) {
      if (item.gap) out.push('');
      out.push(s.bullets ? `- ${item.text}` : item.text);
      for (const sub of item.sub ?? []) out.push(`    ${sub}`);
    }
    (s.steps ?? []).forEach((step, k) => out.push(`${k + 1}. ${step}`));
    if (s.after && s.after.length > 0) out.push('', ...s.after);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function renderMd(doc: PatternDoc, o: PatternTextOptions): string {
  const { facts, body } = sections(doc, o);
  const e = mdEscape;
  const out: string[] = [`# ${e(doc.title)}`, '', ...facts.map((f) => `- ${e(f)}`)];
  for (const s of body) {
    out.push('', `## ${e(s.title)}`, '');
    if (s.paragraphs && s.paragraphs.length > 0) {
      for (const p of s.paragraphs) out.push(e(p), '');
    }
    for (const item of s.items ?? []) {
      if (item.gap) out.push('');
      out.push(`- ${e(item.text)}`);
      for (const sub of item.sub ?? []) out.push(`  - ${e(sub)}`);
    }
    (s.steps ?? []).forEach((step, k) => out.push(`${k + 1}. ${e(step)}`));
    if (s.after && s.after.length > 0) {
      out.push('');
      for (const p of s.after) out.push(e(p));
    }
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

/**
 * §5.2.1: the whole pattern as plain text (`txt`) or Markdown (`md`), in the given terms and dialect, lines as
 * written for `doc.hand`. Never throws on a well-formed doc; a doc with no pieces prints its header and lists.
 */
export const renderPatternText: RenderPatternTextFn = (doc, o) => (o.format === 'md' ? renderMd(doc, o) : renderTxt(doc, o));
