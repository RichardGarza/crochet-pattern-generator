// Track T7.4 — what the import screens say (DESIGN.md F4 steps 4–6, §3.7.7): the importer's carrier, dialect,
// confidence, repairs, units decision, versions and diff, worded for crocheters instead of engineers. Pure (no
// React, no DOM), so it is unit-tested in node.
import { FIXUP_ADVICE } from '../../core/importer/html';
import type { ModelDiff } from '../../core/importer/diff';
import type { ImportResult, LengthUnit, Repair, SpecCandidate, UnitsDecision } from '../../types/importer';
import type { Issue } from '../../types/issues';
import type { CrochetModelV1 } from '../../types/model';
import type { UnitPref } from '../../types/units';
import { formatNumber, toDisplayLength } from '../common/units';

// ---- names

const SIDE: Readonly<Record<string, string>> = { l: 'left', left: 'left', r: 'right', right: 'right', fl: 'front left', fr: 'front right', bl: 'back left', br: 'back right' };

/** "ear_l_inner" → "Left ear inner", "foot_pad_r" → "Right foot pad", "part_3" → "Part 3". */
export function humanizeId(id: string): string {
  const tokens = id.split(/[_\s-]+/).filter(Boolean);
  if (tokens.length === 0) return id;
  const sides = tokens.filter((t) => Object.hasOwn(SIDE, t.toLowerCase()));
  const rest = tokens.filter((t) => !Object.hasOwn(SIDE, t.toLowerCase()));
  // a lone "l" / "r" is a side only next to a word ("l" alone stays as it is)
  if (rest.length === 0) return capitalize(tokens.join(' '));
  const words = [...sides.map((t) => SIDE[t.toLowerCase()]), ...rest.map((t) => t.toLowerCase())];
  return capitalize(words.join(' '));
}

export function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/** A part's name as the import screens show it: its label, else its id made readable. */
export function partDisplayName(id: string, model?: Pick<CrochetModelV1, 'parts'>): string {
  const label = model?.parts.find((p) => p.id === id)?.label?.trim();
  return label || humanizeId(id);
}

/** "Left arm, Right arm and Tail"; long lists end "and 4 more". */
export function nameList(names: readonly string[], max = 5): string {
  if (names.length === 0) return '';
  const shown = names.length > max ? [...names.slice(0, max - 1), `${names.length - (max - 1)} more`] : [...names];
  return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

// ---- what was read

const CARRIER_TEXT: Readonly<Record<ImportResult['carrier'], string>> = {
  text: 'Pasted text',
  json: 'Model file (.json)',
  html: 'Claude Design page (.html)',
  'standalone-html': 'Claude Design standalone page (.html)',
  zip: 'Claude Design project archive (.zip)',
  tar: 'Claude Design handoff bundle (.tar.gz)',
  glb: '3D model (.glb)',
  gltf: '3D model (.gltf)',
  obj: '3D model (.obj)',
  ply: '3D model (.ply)',
  stl: '3D model (.stl)',
  image: 'Picture',
};

/** What the input was, in a few words. */
export function carrierText(carrier: ImportResult['carrier']): string {
  return Object.hasOwn(CARRIER_TEXT, carrier) ? CARRIER_TEXT[carrier] : carrier;
}

const DIALECT_TEXT: Readonly<Record<ImportResult['dialect'], string>> = {
  'canonical-1': 'Our own model format',
  'cd-observed-2026-09': 'Claude Design’s own way of writing models',
  'geometry-only': 'Shapes only (no part names or joins in the file)',
  none: 'Nothing we could read',
};

/** How the model was written ("dialect"). */
export function dialectText(dialect: ImportResult['dialect']): string {
  return Object.hasOwn(DIALECT_TEXT, dialect) ? DIALECT_TEXT[dialect] : dialect;
}

export interface ConfidenceCopy {
  label: string;
  tone: 'success' | 'info' | 'warn';
  explain: string;
}

/** How sure we are that this is the model Claude made. */
export function confidenceCopy(result: Pick<ImportResult, 'confidence' | 'dialect'>): ConfidenceCopy {
  if (result.confidence === 'high') return { label: 'Sure', tone: 'success', explain: 'We found the model’s own data, so every part comes through exactly as Claude made it.' };
  if (result.confidence === 'medium')
    return {
      label: 'Fairly sure',
      tone: 'info',
      explain:
        result.dialect === 'geometry-only'
          ? 'We rebuilt the parts from the shapes in the file. Check the parts before you go on.'
          : 'We rebuilt the model from the parts the file describes. Check the parts before you go on.',
    };
  return { label: 'Best guess', tone: 'warn', explain: 'The file only holds shapes, so we worked out the parts, their names and how they join. Check them before you go on.' };
}

// ---- fixes (repair chips)

export type FixGroup = 'versions' | 'size' | 'joins' | 'pairs' | 'shapes' | 'colors' | 'names' | 'tidy';

export interface FixChip {
  /** Stable React key. */
  key: string;
  group: FixGroup;
  code: Repair['code'];
  /** The chip's text ("Left arm → Body"). */
  text: string;
  /** A longer sentence for the tooltip / details. */
  detail: string;
  /** The part this fix is about (final id, after any renaming). */
  part?: string;
  /** `attach-inferred`: the parent part (final id). */
  to?: string;
  /** This chip opens the Attach tool for `part`. */
  attach: boolean;
}

export interface FixSection {
  group: FixGroup;
  title: string;
  chips: FixChip[];
}

const GROUP_TITLE: Readonly<Record<FixGroup, (n: number) => string>> = {
  versions: () => 'Which version',
  size: () => 'Size',
  joins: (n) => (n === 1 ? 'Joined 1 part to its neighbor' : `Joined ${n} parts to their neighbors`),
  pairs: (n) => (n === 1 ? 'Matched 1 left/right pair' : `Matched ${n} left/right pairs`),
  shapes: () => 'Shapes',
  colors: () => 'Colors',
  names: () => 'Names',
  tidy: () => 'Tidied up',
};

const GROUP_ORDER: readonly FixGroup[] = ['versions', 'size', 'joins', 'pairs', 'shapes', 'colors', 'names', 'tidy'];

const GROUP_OF: Readonly<Record<Repair['code'], FixGroup>> = {
  versions: 'versions',
  units: 'size',
  limits: 'size',
  'dims-clamped': 'shapes',
  'type-aliased': 'shapes',
  'attach-inferred': 'joins',
  'mirror-inferred': 'pairs',
  'mirror-removed': 'pairs',
  'part-added': 'pairs',
  color: 'colors',
  id: 'names',
  ground: 'tidy',
  axes: 'tidy',
  radians: 'tidy',
  'unknown-key': 'tidy',
  'feature-dropped': 'tidy',
  'spec-rebuilt': 'tidy',
};

const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);
const str = (x: unknown): string | undefined => (typeof x === 'string' ? x : undefined);

/** A length in the user's units: "0.25 in", "9.9 in", "25 cm". */
export function lengthText(inches: number, units: UnitPref = 'in'): string {
  const v = toDisplayLength(inches, units);
  const precision = Math.abs(v) < 1 ? 2 : Math.abs(v) < 100 ? 1 : 0;
  return `${formatNumber(v, precision)} ${units}`;
}

const UNIT_WORD: Readonly<Record<LengthUnit, string>> = { in: 'inches', cm: 'centimeters', m: 'meters', mm: 'millimeters' };

/** The renames of an `id` repair (geometry files: part_3 → leg_l), so earlier chips name the final parts. */
function renamesOf(repairs: readonly Repair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of repairs) {
    const map = r.code === 'id' && r.data && typeof r.data.renames === 'object' && r.data.renames !== null ? (r.data.renames as Record<string, unknown>) : null;
    if (!map) continue;
    for (const [from, to] of Object.entries(map)) if (typeof to === 'string') out[from] = to;
  }
  return out;
}

function sizeChipText(r: Repair, model: CrochetModelV1 | undefined, units: UnitPref): { text: string; detail: string } {
  const d = r.data ?? {};
  const chosen = str(d.chosen);
  const reason = str(d.reason);
  const raw = num(d.rawHeight);
  const height = model?.finishedSize.height;
  if (chosen && raw !== undefined && height !== undefined) {
    const unit = chosen === 'normalized' ? null : (chosen as LengthUnit);
    const how =
      reason === 'user'
        ? `in ${unit ? UNIT_WORD[unit] : 'the size you chose'}, as you chose`
        : reason === 'gltf-extras-ratio'
          ? 'measured from the parts’ own sizes'
          : reason === 'expected-height'
            ? unit
              ? `in ${UNIT_WORD[unit]}, the reading closest to this project’s size`
              : 'scaled to this project’s size'
            : reason === 'stage-header' || reason === 'small-bbox'
              ? `in ${UNIT_WORD[unit ?? 'm']}: as inches it would be a tiny ${lengthText(raw, units)}`
              : unit && unit !== 'in'
                ? `in ${UNIT_WORD[unit]}: as inches it would be far too big`
                : 'in inches';
    return { text: `${lengthText(height, units)} tall`, detail: `The file doesn’t say which unit it uses. We read it ${how}: ${lengthText(height, units)} tall.` };
  }
  const stated = num(d.statedHeightIn);
  const measured = num(d.measuredHeightIn);
  if (measured !== undefined) {
    return {
      text: `${lengthText(measured, units)} tall`,
      detail: stated !== undefined && Math.abs(stated - measured) > 1e-3 ? `Claude said ${lengthText(stated, units)}; the parts measure ${lengthText(measured, units)} tall, so we kept that.` : `The parts measure ${lengthText(measured, units)} tall.`,
    };
  }
  return { text: height !== undefined ? `${lengthText(height, units)} tall` : 'Size checked', detail: capitalize(r.message) };
}

function chipFor(r: Repair, i: number, model: CrochetModelV1 | undefined, renames: Record<string, string>, units: UnitPref): FixChip {
  const group = Object.hasOwn(GROUP_OF, r.code) ? GROUP_OF[r.code] : 'tidy';
  const final = (id: string | undefined): string | undefined => (id === undefined ? undefined : Object.hasOwn(renames, id) ? renames[id] : id);
  const part = final(r.part);
  const name = (id: string | undefined): string => (id === undefined ? '' : partDisplayName(id, model));
  const base = { key: `${i}:${r.code}:${r.part ?? ''}`, group, code: r.code, attach: false, ...(part ? { part } : {}) };
  const d = r.data ?? {};
  switch (r.code) {
    case 'attach-inferred': {
      const to = final(str(d.to));
      const gap = num(d.gapIn);
      if (!to || !part) return { ...base, text: d.root ? `${name(part)} is the base part` : name(part) || 'Joins checked', detail: capitalize(r.message), attach: !!part };
      const detail =
        gap !== undefined && gap > 0.1
          ? `${name(part)} doesn’t quite touch ${name(to)} (a ${lengthText(gap, units)} gap), so we joined it to the nearest part. Check where it’s sewn on.`
          : `The file didn’t say what ${name(part)} is sewn to; it overlaps ${name(to)}, so we joined it there.`;
      return { ...base, to, text: `${name(part)} → ${name(to)}`, detail, attach: true };
    }
    case 'mirror-inferred': {
      const of = final(str(d.mirrorOf));
      return { ...base, text: of ? `${name(part)} mirrors ${name(of)}` : `${name(part)} is a mirror image`, detail: of ? `${name(part)} is the mirror image of ${name(of)}: the pattern makes them as a pair.` : capitalize(r.message) };
    }
    case 'mirror-removed':
      return { ...base, text: `${name(part)}: not a mirror`, detail: `${name(part)} was marked as a mirror image, but its twin doesn’t match, so it’s made on its own.` };
    case 'part-added': {
      const of = final(str(d.mirrorOf));
      return { ...base, text: `Added ${name(part)}`, detail: of ? `Claude described ${name(of)} as one of a pair, so we added ${name(part)} on the other side.` : capitalize(r.message) };
    }
    case 'units': {
      const t = sizeChipText(r, model, units);
      return { ...base, text: t.text, detail: t.detail };
    }
    case 'limits':
      return { ...base, text: 'Kept within limits', detail: capitalize(r.message) };
    case 'ground':
      return { ...base, text: 'Set on the table', detail: 'We moved the model so its lowest point sits on the table.' };
    case 'axes':
      return { ...base, text: d.offer ? 'Turn upright?' : 'Turned upright', detail: d.offer ? 'This model may be lying on its back. You can turn it upright in the Shape tab.' : 'The file stood the model on its side; we turned it upright.' };
    case 'radians':
      return { ...base, text: 'Angles converted', detail: 'The file gave its angles in radians; we converted them to degrees.' };
    case 'color':
      return { ...base, text: 'Colors fixed', detail: capitalize(r.message) };
    case 'dims-clamped':
      return { ...base, text: part ? `${name(part)}: size adjusted` : 'Sizes adjusted', detail: capitalize(r.message) };
    case 'type-aliased':
      return { ...base, text: part ? `${name(part)}: shape simplified` : 'Shape simplified', detail: `${part ? name(part) : 'A part'} used a shape we don’t know, so it’s made as a rounded piece of the same size.` };
    case 'id':
      return { ...base, text: d.renames ? 'Parts named' : 'Names tidied', detail: d.renames ? 'The file had no part names, so we named the parts by their shape and place (head, body, legs…).' : capitalize(r.message) };
    case 'unknown-key':
      return { ...base, text: str(d.key) === 'notes' ? 'Claude’s notes kept' : 'Extra details skipped', detail: str(d.key) === 'notes' ? 'Claude’s notes are kept with the model.' : capitalize(r.message) };
    case 'feature-dropped':
      return { ...base, text: 'Face detail skipped', detail: capitalize(r.message) };
    case 'spec-rebuilt':
      return { ...base, text: 'Rebuilt from parts', detail: 'The file had each part’s details but not the whole model; we put the model back together from them.' };
    case 'versions':
      return { ...base, text: versionsChipText(d), detail: capitalize(r.message) };
    default:
      return { ...base, text: capitalize(r.message), detail: capitalize(r.message) };
  }
}

function versionsChipText(d: Record<string, unknown>): string {
  const n = Array.isArray(d.candidates) ? d.candidates.length : 0;
  return n > 1 ? `${n} versions found` : 'Versions';
}

export interface FixesCopy {
  /** "We made 15 small fixes automatically", or null when there were none. */
  headline: string | null;
  /** One line under it: "6 joins · 6 left/right pairs · size · tidied up". */
  summary: string;
  sections: FixSection[];
  /** Every chip, in the order shown. */
  chips: FixChip[];
}

/** Every repair as a chip, grouped for the "We fixed N things" details. */
export function describeFixes(result: Pick<ImportResult, 'repairs' | 'model'>, units: UnitPref = 'in'): FixesCopy {
  const renames = renamesOf(result.repairs);
  const chips = result.repairs.map((r, i) => chipFor(r, i, result.model, renames, units));
  const sections: FixSection[] = [];
  for (const group of GROUP_ORDER) {
    const list = chips.filter((c) => c.group === group);
    if (list.length > 0) sections.push({ group, title: GROUP_TITLE[group](list.length), chips: list });
  }
  const n = chips.filter((c) => c.code !== 'versions').length;
  const headline = n === 0 ? null : n === 1 ? 'We made 1 small fix automatically' : `We made ${n} small fixes automatically`;
  const summary = sections
    .map((s) => {
      const k = s.chips.length;
      switch (s.group) {
        case 'joins':
          return k === 1 ? '1 join' : `${k} joins`;
        case 'pairs':
          return k === 1 ? '1 left/right pair' : `${k} left/right pairs`;
        default:
          return s.title.toLowerCase();
      }
    })
    .join(' · ');
  return { headline, summary: capitalize(summary), sections, chips };
}

// ---- notes (warnings)

/** The importer writes part ids into its messages; the screens show part names. Whole-word ids only. */
export function withPartNames(message: string, model: Pick<CrochetModelV1, 'parts'> | undefined): string {
  if (!model || model.parts.length === 0) return message;
  const ids = new Set(model.parts.map((p) => p.id));
  return message.replace(/\b[a-z][a-z0-9_]*\b/g, (word) => (ids.has(word) ? partDisplayName(word, model) : word));
}

export interface NoteCopy {
  tone: 'info' | 'warn' | 'danger';
  text: string;
}

/** The importer's warnings and remarks, in plain words; thin parts are summed up in one note. */
export function describeNotes(result: Pick<ImportResult, 'warnings' | 'model'>, units: UnitPref = 'in'): NoteCopy[] {
  const out: NoteCopy[] = [];
  const thin: string[] = [];
  for (const w of result.warnings as Issue[]) {
    if (w.code === 'I_MIN_FEATURE') {
      const id = /^(\S+) is /.exec(w.message)?.[1];
      if (id) thin.push(partDisplayName(id, result.model));
      continue;
    }
    if (w.code === 'I_FORMAT_DRIFT' || w.code === 'I_HTML_ENTITY' || w.code === 'I_IMPORT_PARSE') continue; // technical remarks
    if (w.code === 'W_IMPORT_PARSE' && /shape fitting is not available/.test(w.message)) {
      out.push({ tone: 'info', text: 'The parts are kept as free-form shapes. You can sculpt them in the Shape tab, and the pattern works them as free-form pieces.' });
      continue;
    }
    if (w.code === 'W_GAP') {
      const m = /^(\S+) is ([\d.]+) in away from (\S+),/.exec(w.message);
      if (m) {
        out.push({ tone: 'warn', text: `${partDisplayName(m[1], result.model)} doesn’t touch ${partDisplayName(m[3], result.model)}, the part it’s sewn to (a ${lengthText(Number(m[2]), units)} gap). Move it closer in the Shape tab, or sew it on with a longer tail.` });
        continue;
      }
    }
    out.push({ tone: w.severity === 'error' ? 'danger' : w.severity === 'warn' ? 'warn' : 'info', text: capitalize(withPartNames(w.message.replace(FIXUP_ADVICE, '').trim(), result.model)) });
  }
  if (thin.length > 0) {
    out.unshift({
      tone: 'info',
      text: `${nameList(thin)} ${thin.length === 1 ? 'is' : 'are'} too thin to crochet as ${thin.length === 1 ? 'a piece' : 'pieces'}: the pattern makes ${thin.length === 1 ? 'it' : 'them'} flat, as a color patch or with embroidery.`,
    });
  }
  return out;
}

// ---- failures

export interface FailureCopy {
  title: string;
  body: string;
  /** What to try next. */
  tips: string[];
  /** The importer's own messages, for "Details". */
  details: string[];
  /** Only pictures were found: offer a photo project instead. */
  pictures: boolean;
}

const TIPS_CLAUDE = [
  'In Claude Design, ask Claude to “print the complete crochet-model JSON in one json code block”, then paste its whole reply here.',
  'Or export the project from Claude Design (Share → Export → Project HTML → Project archive) and drop the .zip here.',
  'Or drop a 3D export: a .glb file, or an .obj file together with its .mtl file.',
];

/** Why nothing could be imported, and what to try. */
export function describeFailure(result: Pick<ImportResult, 'warnings' | 'carrier' | 'images'>): FailureCopy {
  const errors = (result.warnings as Issue[]).filter((w) => w.severity === 'error');
  const first = errors[0];
  const details = errors.map((w) => capitalize(w.message.replace(FIXUP_ADVICE, '').trim()));
  const pictures = result.carrier === 'image' || (result.images?.length ?? 0) > 0;
  if (pictures) {
    return { title: 'This is a picture, not a 3D model', body: 'To turn a photo into a toy, start a new 3D toy from one photo (or from several photos).', tips: [], details, pictures: true };
  }
  switch (first?.code) {
    case 'E_IMPORT_NO_MODEL':
      if (/still waiting for your answer/i.test(first.message)) {
        return { title: 'Claude was still waiting for your answer', body: 'This bundle was exported before Claude finished. Reply to Claude in Claude Design, wait for the model, then export again.', tips: [], details, pictures: false };
      }
      return { title: result.carrier === 'text' ? 'We couldn’t find a toy model in this text' : 'We couldn’t find a toy model in this file', body: 'Claude Design results carry the model as a block of data. This one doesn’t have it.', tips: TIPS_CLAUDE, details, pictures: false };
    case 'E_IMPORT_PARSE':
      return { title: 'The model data is damaged', body: 'We found the model, but part of it is cut off or garbled — often from copying only part of Claude’s reply.', tips: TIPS_CLAUDE, details, pictures: false };
    case 'E_IMPORT_INVALID':
      return { title: 'This model has problems we can’t fix', body: 'We found the model and fixed what we could, but some of it still doesn’t make sense.', tips: TIPS_CLAUDE, details, pictures: false };
    case 'E_IMPORT_UNSAFE':
      return { title: 'We didn’t open this file', body: 'It contains something that could harm the app, so we left it alone.', tips: TIPS_CLAUDE, details, pictures: false };
    case 'E_IMPORT_TOO_LARGE':
      return { title: 'This file is too big', body: 'Files up to 100 MB (300 MB unpacked) can be imported.', tips: TIPS_CLAUDE.slice(1), details, pictures: false };
    case 'E_IMPORT_ARCHIVE':
      return { title: 'This archive is damaged', body: 'The .zip or .tar.gz file can’t be unpacked. Try exporting it again.', tips: TIPS_CLAUDE.slice(1), details, pictures: false };
    case 'E_IMPORT_UNSUPPORTED':
      return { title: 'We can’t read this kind of file yet', body: details[0] ?? 'Try another format.', tips: TIPS_CLAUDE.slice(1), details, pictures: false };
    case 'E_IMPORT_PROJECT_FILE':
      return { title: 'This is a whole project', body: 'Project files (.crochet.json) are opened from your projects on the start screen, not imported into this one.', tips: [], details, pictures: false };
    default:
      return { title: 'We couldn’t import this', body: details[0] ?? 'Try another file, or paste Claude’s reply.', tips: TIPS_CLAUDE, details, pictures: false };
  }
}

// ---- units confirm (§3.7.5: "0.25 in tall, or 9.9 in tall?")

export interface UnitsOption {
  /** `normalized` = keep the scaled-to-the-project reading. */
  unit: LengthUnit | 'normalized';
  heightIn: number;
  /** "9.9 in tall". */
  label: string;
  /** "if the file is in meters". */
  hint: string;
  /** The reading the import uses now. */
  current: boolean;
}

/**
 * The readings the units confirm offers: the one in use, the plain-inches reading (the file's own numbers), and
 * every other reading that makes a toy 1–60 in tall; smallest first.
 */
export function unitsOptions(units: UnitsDecision, currentHeightIn: number | undefined, display: UnitPref = 'in'): UnitsOption[] {
  const out: UnitsOption[] = [];
  const add = (unit: UnitsOption['unit'], heightIn: number, hint: string) => {
    if (!Number.isFinite(heightIn) || heightIn <= 0) return;
    if (out.some((o) => o.unit === unit)) return;
    out.push({ unit, heightIn, label: `${lengthText(heightIn, display)} tall`, hint, current: unit === units.chosen });
  };
  if (units.chosen === 'normalized') add('normalized', currentHeightIn ?? units.rawHeight, 'scaled to this project’s size');
  for (const r of units.readings) {
    const plausible = r.heightIn >= 1 && r.heightIn <= 60;
    if (r.unit === units.chosen || r.unit === 'in' || plausible) add(r.unit, r.unit === units.chosen && currentHeightIn !== undefined ? currentHeightIn : r.heightIn, `if the file is in ${UNIT_WORD[r.unit]}`);
  }
  return out.sort((a, b) => a.heightIn - b.heightIn);
}

/** The question of the units confirm: "0.25 in tall, or 9.9 in tall?". */
export function unitsQuestion(options: readonly UnitsOption[]): string {
  const labels = options.map((o) => o.label);
  if (labels.length <= 1) return labels[0] ? `${labels[0]}?` : 'How tall is it?';
  return `${labels.slice(0, -1).join(', ')}, or ${labels[labels.length - 1]}?`;
}

// ---- versions picker

export interface VersionOption {
  id: string;
  /** "Page · revision 1". */
  title: string;
  /** "Amigurumi Teddy Bear.html · 17 parts". */
  detail: string;
  chosen: boolean;
}

const SOURCE_TEXT: Readonly<Record<SpecCandidate['source'], string>> = { html: 'The page you saw', glb: '3D export', chat: 'Chat reply', json: 'Side file' };

/** The versions an archive holds, newest revision first (the order of `candidates` otherwise). */
export function versionOptions(candidates: readonly SpecCandidate[]): VersionOption[] {
  return [...candidates]
    .map((c, i) => ({ c, i }))
    .sort((a, b) => b.c.revision - a.c.revision || a.i - b.i)
    .map(({ c }) => ({
      id: c.id,
      title: `${SOURCE_TEXT[c.source] ?? c.source} · revision ${c.revision}`,
      detail: `${c.path} · ${c.parts === 1 ? '1 part' : `${c.parts} parts`}`,
      chosen: c.chosen,
    }));
}

// ---- diff (§3.7.7)

export interface DiffRow {
  part: string;
  name: string;
  /** "Bigger", "Moved 0.3 in", "Now cone (was sphere)", "New color". */
  changes: string[];
  color?: { from: string; to: string };
}

export interface DiffCopy {
  /** Nothing changed at all. */
  same: boolean;
  /** "3 new parts · 1 removed · 4 changed". */
  headline: string;
  added: string[];
  removed: string[];
  changed: DiffRow[];
  /** Face details. */
  features: { removed: string[]; kept: string[]; added: string[] };
  /** Palette colors (hex). */
  palette: { added: string[]; removed: string[] };
  /** Parts whose photo colors stay behind unless "Carry anyway" (ids). */
  paintNotCarried: string[];
  /** Parts whose photo colors come along (ids). */
  paintCarried: string[];
}

const TYPE_WORD: Readonly<Record<string, string>> = { sphere: 'ball', ellipsoid: 'oval ball', capsule: 'capsule', cylinder: 'tube', cone: 'cone', torus: 'ring', lathe: 'shaped piece', flat: 'flat piece', box: 'box', mesh: 'free-form piece' };

const typeWord = (t: string): string => (Object.hasOwn(TYPE_WORD, t) ? TYPE_WORD[t] : t);

const featureName = (id: string): string => humanizeId(id);

/** §3.7.7's diff in plain words. `prev` names removed parts; `next` names the rest. */
export function describeDiff(diff: ModelDiff, prev: CrochetModelV1 | undefined, next: CrochetModelV1, units: UnitPref = 'in'): DiffCopy {
  const nameNext = (id: string) => partDisplayName(id, next);
  const changed: DiffRow[] = diff.changed.map((c) => {
    const changes: string[] = [];
    if (c.type) changes.push(`Now a ${typeWord(c.type.to)} (was a ${typeWord(c.type.from)})`);
    if (c.dims.length > 0) {
      const ratios = c.dims.filter((d) => Number.isFinite(d.from) && Number.isFinite(d.to) && d.from > 0).map((d) => d.to / d.from);
      const grows = ratios.filter((r) => r > 1).length;
      const shrinks = ratios.filter((r) => r < 1).length;
      changes.push(ratios.length === 0 ? 'New shape' : grows > 0 && shrinks === 0 ? 'Bigger' : shrinks > 0 && grows === 0 ? 'Smaller' : 'Reshaped');
    }
    if (c.movedIn !== undefined) changes.push(`Moved ${lengthText(c.movedIn, units)}`);
    if (c.turnedDeg !== undefined) changes.push(`Turned ${formatNumber(c.turnedDeg, 0)}°`);
    if (c.color) changes.push('New color');
    return { part: c.part, name: nameNext(c.part), changes, ...(c.color ? { color: c.color } : {}) };
  });
  const bits: string[] = [];
  if (diff.added.length > 0) bits.push(diff.added.length === 1 ? '1 new part' : `${diff.added.length} new parts`);
  if (diff.removed.length > 0) bits.push(`${diff.removed.length} removed`);
  if (changed.length > 0) bits.push(`${changed.length} changed`);
  const unchanged = next.parts.length - diff.added.length - changed.length;
  if (bits.length > 0 && unchanged > 0) bits.push(`${unchanged} the same`);
  return {
    same: diff.same,
    headline: diff.same ? 'Nothing changed: this is the same model' : bits.length > 0 ? bits.join(' · ') : 'Only small changes',
    added: diff.added.map(nameNext),
    removed: diff.removed.map((id) => partDisplayName(id, prev)),
    changed,
    features: { removed: diff.features.removed.map(featureName), kept: diff.features.kept.map(featureName), added: diff.features.added.map(featureName) },
    palette: diff.palette,
    paintNotCarried: diff.paintNotCarried,
    paintCarried: diff.paintCarried,
  };
}

// ---- the model at a glance

export interface ModelSummary {
  parts: number;
  /** "Teddy bear" or null for the importer's default name. */
  name: string | null;
  heightIn: number;
  colors: { hex: string; name: string }[];
  /** "17 parts · 9.9 in tall · 4 colors". */
  line: string;
}

/** A palette color's name: as written, or made readable when it is an id ("caramel_yarn" → "Caramel yarn"). */
export function colorName(c: { id: string; name?: string }): string {
  const raw = c.name?.trim();
  return raw && !/^[a-z0-9_]+$/.test(raw) ? raw : humanizeId(raw || c.id);
}

export function summarizeModel(model: CrochetModelV1, units: UnitPref = 'in'): ModelSummary {
  const name = model.name && model.name !== 'Imported model' ? model.name : null;
  const colors = model.palette.map((c) => ({ hex: c.hex, name: colorName(c) }));
  const parts = model.parts.length;
  const line = [`${parts} ${parts === 1 ? 'part' : 'parts'}`, `${lengthText(model.finishedSize.height, units)} tall`, `${colors.length} ${colors.length === 1 ? 'color' : 'colors'}`].join(' · ');
  return { parts, name, heightIn: model.finishedSize.height, colors, line };
}
