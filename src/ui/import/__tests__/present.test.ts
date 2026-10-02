// Track T7.4a — the words of the import screens (present.ts), on the real teddy imports: carriers, dialects,
// confidence, one chip per repair with the joins named "Head → Body" (renamed geometry parts by their final names),
// the units question "0.25 in tall, or 9.9 in tall?", the versions picker, failures, notes and the diff.
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { diffModels } from '../../../core/importer/diff';
import { importInputsSync } from '../../../core/importer';
import { FIXUP_ADVICE } from '../../../core/importer/html';
import type { ImportInput, ImportResult, UnitsDecision } from '../../../types/importer';
import type { CrochetModelV1 } from '../../../types/model';
import { teddy } from '../../../state/slices/__tests__/teddyProject';
import {
  capitalize,
  carrierText,
  colorName,
  confidenceCopy,
  describeDiff,
  describeFailure,
  describeFixes,
  describeNotes,
  dialectText,
  humanizeId,
  lengthText,
  nameList,
  partDisplayName,
  summarizeModel,
  unitsOptions,
  unitsQuestion,
  versionOptions,
  withPartNames,
} from '../present';

const FIX = new URL('../../../../fixtures/claude-design/', import.meta.url);
const file = (rel: string): ImportInput => {
  const b = fs.readFileSync(new URL(rel, FIX));
  return { kind: 'file', name: rel.split('/').pop() ?? rel, bytes: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer };
};

describe('names', () => {
  it('ids become words, sides first; labels win', () => {
    expect(humanizeId('ear_l_inner')).toBe('Left ear inner');
    expect(humanizeId('foot_pad_r')).toBe('Right foot pad');
    expect(humanizeId('part_3')).toBe('Part 3');
    expect(humanizeId('wing_left')).toBe('Left wing');
    expect(humanizeId('l')).toBe('L');
    expect(humanizeId('')).toBe('');
    const m = teddy();
    expect(partDisplayName('ear_l_inner', m)).toBe('Left Ear Inner');
    expect(partDisplayName('no_such_part', m)).toBe('No such part');
    expect(colorName({ id: 'c1', name: 'caramel_yarn' })).toBe('Caramel yarn');
    expect(colorName({ id: 'c1', name: 'Soft Cream' })).toBe('Soft Cream');
    expect(colorName({ id: 'dark_brown' })).toBe('Dark brown');
  });

  it('lists and lengths', () => {
    expect(nameList(['A'])).toBe('A');
    expect(nameList(['A', 'B', 'C'])).toBe('A, B and C');
    expect(nameList(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe('A, B, C, D and 3 more');
    expect(lengthText(0.2509)).toBe('0.25 in');
    expect(lengthText(9.8789)).toBe('9.9 in');
    expect(lengthText(10, 'cm')).toBe('25.4 cm');
    expect(lengthText(250)).toBe('250 in');
    expect(capitalize('a')).toBe('A');
  });
});

describe('the teddy project archive', () => {
  const r = importInputsSync([file('teddy-bear/teddy-bear.project-archive.zip')]);

  it('what was read, in plain words', () => {
    expect(carrierText(r.carrier)).toBe('Claude Design project archive (.zip)');
    expect(dialectText(r.dialect)).toBe('Claude Design’s own way of writing models');
    expect(confidenceCopy(r)).toMatchObject({ label: 'Sure', tone: 'success' });
    expect(summarizeModel(r.model as CrochetModelV1).line).toBe('17 parts · 9.9 in tall · 4 colors');
  });

  it('every repair is one chip; joins name both parts and open the Attach tool; nothing in engineer-speak', () => {
    const f = describeFixes(r);
    expect(f.chips).toHaveLength(r.repairs.length);
    expect(f.headline).toBe('We made 15 small fixes automatically');
    expect(f.summary).toBe('Size · 6 joins · 6 left/right pairs · tidied up');
    const joins = f.chips.filter((c) => c.attach);
    expect(joins.map((c) => c.text)).toEqual(['Left Leg → Body', 'Right Leg → Body', 'Left Arm → Body', 'Right Arm → Body', 'Tail → Body', 'Head → Body']);
    expect(joins.every((c) => c.part && c.to === 'body')).toBe(true);
    expect(f.sections.map((s) => s.title)).toEqual(['Size', 'Joined 6 parts to their neighbors', 'Matched 6 left/right pairs', 'Tidied up']);
    for (const c of f.chips) {
      expect(c.text).not.toMatch(/in³|overlap by|_|y = 0/);
      expect(c.detail).not.toMatch(/in³|_[lr]\b/);
    }
    expect(f.chips.find((c) => c.code === 'units')?.text).toBe('9.9 in tall');
  });

  it('thin parts are one note; technical remarks are left out', () => {
    const notes = describeNotes(r);
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe('Nose, Left Ear Inner, Right Ear Inner, Left Foot Pad and Right Foot Pad are too thin to crochet as pieces: the pattern makes them flat, as a color patch or with embroidery.');
  });
});

describe('geometry files', () => {
  it('builder-v1 OBJ + MTL in meters: "0.25 in tall, or 9.9 in tall?", meters is the guess', () => {
    const r = importInputsSync([file('teddy-derived/teddy-builder-v1.obj.gz'), file('teddy-derived/teddy-builder-v1.mtl')]);
    const units = r.units as UnitsDecision;
    expect(units.confirm).toBe(true);
    const options = unitsOptions(units, r.model?.finishedSize.height);
    expect(options.map((o) => [o.unit, o.label, o.current])).toEqual([
      ['in', '0.25 in tall', false],
      ['m', '9.9 in tall', true],
    ]);
    expect(unitsQuestion(options)).toBe('0.25 in tall, or 9.9 in tall?');
    expect(confidenceCopy(r).label).toBe('Best guess');
    expect(dialectText(r.dialect)).toBe('Shapes only (no part names or joins in the file)');
    const size = describeFixes(r).chips.find((c) => c.code === 'units');
    expect(size?.text).toBe('9.9 in tall');
    expect(size?.detail).toBe('The file doesn’t say which unit it uses. We read it in meters: as inches it would be a tiny 0.25 in: 9.9 in tall.');
    // shape fitting not available yet: one friendly note
    expect(describeNotes(r).map((n) => n.text)).toContain('The parts are kept as free-form shapes. You can sculpt them in the Shape tab, and the pattern works them as free-form pieces.');
  });

  it('an STL in mm: the joins name the parts by their final names (part_5 → arm_l)', () => {
    const r = importInputsSync([file('teddy-derived/teddy-builder-v1.mm.stl.gz')]);
    const f = describeFixes(r);
    const joins = f.chips.filter((c) => c.attach);
    expect(joins.length).toBeGreaterThan(0);
    const ids = new Set((r.model as CrochetModelV1).parts.map((p) => p.id));
    for (const j of joins) {
      expect(ids.has(j.part as string), j.text).toBe(true);
      expect(ids.has(j.to as string), j.text).toBe(true);
    }
    expect(joins.map((c) => c.text)).toContain('Left arm → Body');
    expect(f.chips.find((c) => c.code === 'id')?.text).toBe('Parts named');
    // the plausible readings (1–60 in) and the file's own numbers as inches; centimeters (98.8 in) is not offered
    const options = unitsOptions(r.units as UnitsDecision, r.model?.finishedSize.height);
    expect(options.map((o) => o.unit)).toEqual(['mm', 'in']);
    expect(options.find((o) => o.current)?.unit).toBe('mm');
    expect(options.find((o) => o.unit === 'cm')).toBeUndefined();
  });

  it('a normalized reading is offered as "scaled to this project’s size"', () => {
    const units: UnitsDecision = { rawHeight: 3, readings: [{ unit: 'in', heightIn: 3 }, { unit: 'cm', heightIn: 3 / 2.54 }, { unit: 'm', heightIn: 118 }, { unit: 'mm', heightIn: 0.118 }], chosen: 'normalized', reason: 'expected-height', confirm: true };
    const options = unitsOptions(units, 10);
    expect(options.map((o) => o.unit)).toEqual(['cm', 'in', 'normalized']);
    expect(options.find((o) => o.unit === 'normalized')).toMatchObject({ label: '10 in tall', current: true, hint: 'scaled to this project’s size' });
    expect(unitsQuestion([])).toBe('How tall is it?');
  });
});

describe('versions', () => {
  it('the stale side file: newest first, the page in use', () => {
    const r = importInputsSync([file('teddy-derived/teddy-stale-side-file.zip')]);
    expect(versionOptions(r.candidates ?? [])).toEqual([
      { id: 'Amigurumi Teddy Bear.html', title: 'The page you saw · revision 1', detail: 'Amigurumi Teddy Bear.html · 17 parts', chosen: true },
      { id: 'crochet-model.json', title: 'Side file · revision 0', detail: 'crochet-model.json · 17 parts', chosen: false },
    ]);
    const chip = describeFixes(r).chips.find((c) => c.code === 'versions');
    expect(chip?.text).toBe('2 versions found');
    expect(describeFixes(r).headline).toBe('We made 15 small fixes automatically'); // the versions chip is not a fix
  });
});

describe('failures', () => {
  it('no model in pasted text: plain title, tips, no mention of a fix-up button', () => {
    const r = importInputsSync([{ kind: 'text', text: 'Here you go!' }]);
    const f = describeFailure(r);
    expect(f.title).toBe('We couldn’t find a toy model in this text');
    expect(f.tips).toHaveLength(3);
    expect(f.details.join(' ')).not.toContain(FIXUP_ADVICE);
    expect(f.details.join(' ')).not.toMatch(/fix-up/i);
  });

  it('a handoff bundle exported too early; a picture; damaged JSON; a project file', () => {
    expect(describeFailure(importInputsSync([file('teddy-derived/teddy-handoff-waiting.tar.gz')])).title).toBe('Claude was still waiting for your answer');
    const png = describeFailure(importInputsSync([file('teddy-bear/teddy-bear.local-render.png')]));
    expect(png).toMatchObject({ title: 'This is a picture, not a 3D model', pictures: true });
    const broken = describeFailure(importInputsSync([{ kind: 'text', text: '```json\n{"schema": "crochet-model", "version": "1.0", "parts": [{"id": \n```' }]));
    expect(broken.title).toMatch(/damaged|couldn’t find/);
    const project = describeFailure({ carrier: 'json', warnings: [{ code: 'E_IMPORT_PROJECT_FILE', severity: 'error', message: 'x' }] });
    expect(project.title).toBe('This is a whole project');
    expect(describeFailure({ carrier: 'json', warnings: [] }).title).toBe('We couldn’t import this');
  });
});

describe('notes', () => {
  it('a gap warning names the parts and says what to do', () => {
    const m = teddy();
    const r: Pick<ImportResult, 'warnings' | 'model'> = { model: m, warnings: [{ code: 'W_GAP', severity: 'warn', message: 'ear_l is 0.35 in away from head, the part it is sewn to', where: { part: 'ear_l' } }] };
    expect(describeNotes(r)[0]).toEqual({ tone: 'warn', text: 'Left Ear doesn’t touch Head, the part it’s sewn to (a 0.35 in gap). Move it closer in the Shape tab, or sew it on with a longer tail.' });
    expect(withPartNames('body and arm_l and nobody', m)).toBe('Body and Left Arm and nobody');
  });
});

describe('the diff', () => {
  it('a bigger head and a new bow, in plain words', () => {
    const prev = teddy();
    const next = teddy();
    const head = next.parts.find((p) => p.id === 'head');
    if (head?.type !== 'ellipsoid') throw new Error('head');
    head.dims = { rx: head.dims.rx * 1.2, ry: head.dims.ry * 1.2, rz: head.dims.rz * 1.2 };
    next.parts.push({ id: 'bow', type: 'torus', dims: { R: 0.4, r: 0.12 }, position: [0, 6.2, 1.6], color: next.parts[0].color, attach: { to: 'body' } });
    const copy = describeDiff(diffModels(prev, next), prev, next);
    expect(copy.headline).toBe('1 new part · 1 changed · 16 the same');
    expect(copy.added).toEqual(['Bow']);
    expect(copy.changed).toEqual([{ part: 'head', name: 'Head', changes: ['Bigger'] }]);
    expect(describeDiff(diffModels(prev, prev), prev, prev).headline).toBe('Nothing changed: this is the same model');
  });

  it('moved, turned, recolored, smaller, removed, a new type', () => {
    const prev = teddy();
    const next = teddy();
    const tail = next.parts.find((p) => p.id === 'tail') as CrochetModelV1['parts'][number];
    tail.position = [tail.position[0], tail.position[1] + 0.5, tail.position[2]];
    tail.rotationDeg = [30, 0, 0];
    tail.color = next.palette[1].id;
    next.parts = next.parts.filter((p) => p.id !== 'nose');
    const body = next.parts.find((p) => p.id === 'body');
    if (body?.type !== 'ellipsoid') throw new Error('body');
    body.dims = { rx: body.dims.rx * 0.8, ry: body.dims.ry * 0.8, rz: body.dims.rz * 0.8 };
    const muzzleAt = next.parts.findIndex((p) => p.id === 'muzzle');
    const muzzle = next.parts[muzzleAt];
    next.parts[muzzleAt] = { id: muzzle.id, label: muzzle.label, position: muzzle.position, color: muzzle.color, attach: muzzle.attach, type: 'sphere', dims: { r: 0.8 } };
    const copy = describeDiff(diffModels(prev, next), prev, next);
    expect(copy.removed).toEqual(['Nose']);
    const row = (id: string) => copy.changed.find((c) => c.part === id);
    expect(row('tail')?.changes).toEqual(['Moved 0.5 in', 'Turned 30°', 'New color']);
    expect(row('tail')?.color).toBeDefined();
    expect(row('body')?.changes).toEqual(['Smaller']);
    expect(row('muzzle')?.changes[0]).toMatch(/^Now a ball \(was a /);
  });
});
