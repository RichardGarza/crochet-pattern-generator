import { describe, expect, it } from 'vitest';
import type { Line } from '../../../types';
import { resolveGauge } from '../../gauge';
import { renderLine, renderLineExtras } from '../../pattern/render';
import { buildPattern2DWith } from '../index';
import { applyBlockRepeat, findBlockRepeat, parseRepeatNote, repeatNoteText } from '../repeats';
import { writeScTapestryRound } from '../scRound';
import { writeScGraphgan } from '../scFlat';
import { validate2D } from '../validate2d';
import { chartOf, settingsOf } from './fixtures';

/** Lines whose ops spell the given letters (one op each), numbered 1…, no sides. */
function synthetic(seq: string): Line[] {
  return [...seq].map((ch, i) => ({ kind: 'rnd', n: i + 1, ops: [{ k: 'st', st: 'sc', color: ch }], prevCount: i === 0 ? null : 1, stated: 1, ...(i === 0 ? { start: { k: 'chainRing', chains: 1 } } : { start: { k: 'join' } }) }) as Line);
}

describe('vertical block repeats (DESIGN §2.6.2)', () => {
  it('flat work repeats only blocks of an even length; rounds any length', () => {
    // Line 1, then XYZ four times: the best odd block is XYZ (L = 3); the best even one XYZXYZ (L = 6).
    const lines = synthetic('SXYZXYZXYZXYZ');
    expect(findBlockRepeat(lines, { even: false })).toEqual({ source: [2, 4], from: 5, to: 13, times: 3 });
    expect(findBlockRepeat(lines, { even: true })).toEqual({ source: [2, 7], from: 8, to: 13, times: 1 });
    // Constant blocks are left to folding; Line 1 never starts a block.
    expect(findBlockRepeat(synthetic('SXXXXXX'), { even: false })).toBeNull();
    expect(findBlockRepeat(synthetic('SXYXY'), { even: false })).toEqual({ source: [2, 3], from: 4, to: 5, times: 1 });
    expect(findBlockRepeat(synthetic('XYXY'), { even: false })).toBeNull();
  });

  it('note text, parse and apply', () => {
    const rep = { source: [2, 5] as [number, number], from: 6, to: 13, times: 2 };
    expect(repeatNoteText(rep, 'row')).toBe('Rows 6–13: rep Rows 2–5 2 times.');
    expect(repeatNoteText({ ...rep, to: 9, times: 1 }, 'rnd')).toBe('Rnds 6–9: rep Rnds 2–5.');
    expect(parseRepeatNote('Rows 6–13: rep Rows 2–5 2 times.')).toEqual(rep);
    expect(parseRepeatNote('Rows 6–13: rep Rnds 2–5.')).toBeNull();
    const applied = applyBlockRepeat(synthetic('SXYZXYZ'), { source: [2, 4], from: 5, to: 7, times: 1 });
    expect(applied.map((l) => l.n)).toEqual([1, 2, 3, 4]);
    expect(applied[3].notes).toEqual(['Rnds 5–7: rep Rnds 2–4.']);
  });

  it('a flat chart with a 2-row motif: Rows a–b rep, validated against the chart, printed after its block', () => {
    const rows = ['ABAB', 'BABA', 'ABAB', 'BABA', 'ABAB', 'BABA', 'ABAB', 'CCCC'];
    const grid = chartOf(rows);
    const gauge = resolveGauge({ cyc: 4, technique: 'sc_graphgan' });
    const { doc } = buildPattern2DWith({ chart: grid, settings: settingsOf(), gauge, terms: 'us', dialect: 'compact', title: 't' }, { cues: false });
    const lines = doc.pieces[0].lines;
    // Rows 2–3 come back as Rows 4–5 and 6–7; Row 8 is written (half a block is not repeated).
    expect(lines.map((l) => l.n)).toEqual([1, 2, 3, 8]);
    expect(renderLineExtras(lines[2], { terms: 'us' })).toEqual(['Rows 4–7: rep Rows 2–3 2 times.']);
    expect(doc.issues.filter((x) => x.severity === 'error')).toEqual([]);
    // With applyRepeats 'off' every row is written.
    const off = buildPattern2DWith({ chart: grid, settings: settingsOf({ applyRepeats: 'off' }), gauge, terms: 'us', dialect: 'compact', title: 't' }, { cues: false }).doc;
    expect(off.pieces[0].lines).toHaveLength(8);
    expect(renderLine(lines[2], { dialect: 'compact', terms: 'us', hand: 'right' })).toBe('Row 3 (RS) ←: Ch 1, turn. (sc A, sc B) x 2 (4 sts)');
  });

  it('E_FOLD on a crafted repeat: an odd block in flat work, a block that is not the chart, the wrong place', () => {
    const grid = chartOf(['ABAB', 'BABA', 'ABAB', 'BABA', 'ABAB', 'CCCC']);
    const rows = writeScGraphgan(grid, { hand: 'right', fold: false, cues: false }).rows;
    const odd: Line[] = [rows[0], rows[1], rows[2], { ...rows[3], notes: ['Rows 5–6: rep Rows 3–4.'] }];
    expect(validate2D({ chart: grid, technique: 'sc_graphgan', hand: 'right', lines: odd }).filter((x) => x.severity === 'error')).toEqual([]);
    const oddL: Line[] = [rows[0], rows[1], rows[2], { ...rows[3], notes: ['Rows 5–7: rep Rows 2–4.'] }];
    const msgs = validate2D({ chart: grid, technique: 'sc_graphgan', hand: 'right', lines: oddL }).map((x) => `${x.code} ${x.message}`);
    expect(msgs.some((m) => m.startsWith('E_FOLD Rows 5–7: a block of 3 rows would change sides'))).toBe(true);
    const wrong = chartOf(['ABAB', 'AAAA', 'ABAB', 'BABA', 'ABAB', 'CCCC']);
    const msgs2 = validate2D({ chart: wrong, technique: 'sc_graphgan', hand: 'right', lines: odd }).map((x) => x.message);
    expect(msgs2).toContain('Rows 5–6: Row 5 of the chart is not Row 3');
    const first: Line[] = [rows[0], { ...rows[1], notes: ['Rows 3–4: rep Rows 1–2.'] }, rows[4], rows[5]];
    expect(validate2D({ chart: grid, technique: 'sc_graphgan', hand: 'right', lines: first }).map((x) => x.code)).toContain('E_FOLD');
  });

  it('rounds repeat blocks of any length; turned rounds only even ones', () => {
    const grid = chartOf(['CDEF', 'ABAB', 'BBBB', 'AAAA', 'ABAB', 'BBBB', 'AAAA', 'ABAB', 'BBBB', 'AAAA']);
    const gauge = resolveGauge({ cyc: 4, technique: 'sc_tapestry_round' });
    const note = buildPattern2DWith({ chart: grid, settings: settingsOf({ technique: 'sc_tapestry_round' }), gauge, terms: 'us', dialect: 'compact', title: 't' }, { cues: false }).doc;
    const notes = note.pieces[0].lines.flatMap((l) => l.notes ?? []);
    // Rnds 2–4 (B, AB, A) come again as Rnds 5–7 (block of 3: rounds are all RS).
    expect(notes).toEqual(['Rnds 5–7: rep Rnds 2–4.']);
    expect(note.issues.filter((x) => x.severity === 'error')).toEqual([]);
    const turned = buildPattern2DWith(
      { chart: grid, settings: settingsOf({ technique: 'sc_tapestry_round', roundLean: { mode: 'turn', stPerRnd: 0.5 } }), gauge, terms: 'us', dialect: 'compact', title: 't' },
      { cues: false },
    ).doc;
    for (const l of turned.pieces[0].lines) for (const n of l.notes ?? []) expect(((parseRepeatNote(n)!.source[1] - parseRepeatNote(n)!.source[0] + 1) % 2)).toBe(0);
    expect(turned.issues.filter((x) => x.severity === 'error')).toEqual([]);
    const lines = writeScTapestryRound(grid, { hand: 'right', cues: false }).rounds;
    expect(findBlockRepeat(lines, { even: false })?.source).toEqual([2, 4]);
  });
});
