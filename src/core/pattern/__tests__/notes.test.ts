import { describe, expect, it } from 'vitest';
import { isImplemented } from '../../stub';
import { C2C_ARROWS, notesFor, notesWith } from '../notes';
import { computeSkill } from '../skill';
import { renderWordChartLine, wordChartRuns } from '../wordchart';
import { inc, parseBody, rnd, row, sc, tile, times } from './helpers';

const rh = { terms: 'us', hand: 'right' } as const;

describe('notesFor (DESIGN §2.7.9, §2.10.11)', () => {
  it('replaces the Step 0 stubs', () => {
    expect(isImplemented(notesFor)).toBe(true);
    expect(isImplemented(computeSkill)).toBe(true);
  });

  it('flat graph: the §2.7.9 sentences, in order, plus the row-boundary rule of §2.7.2 and the cue legend', () => {
    const notes = notesFor('flat-graph', rh);
    expect(notes.join(' ')).toContain(
      'Each square = 1 sc. Odd rows are RS and are read right to left; even rows are WS and are read left to right (left-handed: reverse). Ch 1 at the beginning of a row does not count as a stitch. Change color on the last yarn over of the stitch before the new color.',
    );
    expect(notes).toContain('Work over the color(s) not in use (tapestry), or use a separate bobbin for each area marked in the chart (intarsia).');
    expect(notes[notes.length - 1]).toBe('Drop the inactive yarn to the WS.');
    expect(notes.some((n) => n.startsWith('When the next row starts in another color, change to it on the last yarn over of the row before'))).toBe(true);
    expect(notes.some((n) => n.includes('“join B (bobbin 2)”'))).toBe(true);
  });

  it('flat graph, left-handed and UK', () => {
    expect(notesFor('flat-graph', { terms: 'us', hand: 'left' })[1]).toBe(
      'Odd rows are RS and are read left to right; even rows are WS and are read right to left (right-handed: reverse).',
    );
    const uk = notesFor('flat-graph', { terms: 'uk', hand: 'right' });
    expect(uk[0]).toBe('Each square = 1 dc.');
    expect(uk[3]).toBe('Change color on the last yarn over hook of the stitch before the new color.');
    expect(notesWith('flat-graph', { ...rh, stitch: 'hdc' }).slice(0, 3)).toEqual([
      'Each square = 1 hdc.',
      'Odd rows are RS and are read right to left; even rows are WS and are read left to right (left-handed: reverse).',
      'Ch 2 at the beginning of a row does not count as a stitch.',
    ]);
  });

  it('flat tapestry (§2.7.4) adds the carry rules and the tension note', () => {
    const notes = notesFor('tapestry', rh);
    expect(notes).toContain('Carried yarn stays hidden only with firm tension; check the RS.');
    expect(notes.some((n) => n.includes('separate bobbin'))).toBe(false);
    expect(notes).not.toContain('Drop the inactive yarn to the WS.');
    expect(notesWith('flat-graph', { ...rh, strandCues: false }).some((n) => n.includes('“join B'))).toBe(false);
  });

  it('tapestry in the round (§2.7.5): the lean note with its number, pre-skew, turned rounds', () => {
    const note = notesWith('tapestry-round', { ...rh, roundLean: { mode: 'note', stPerRnd: 0.5 }, rounds: 60 });
    expect(note).toContain(
      "Stitches worked in rounds lean: expect the design to shift about 30 sts to the right between Rnd 1 and Rnd 60. Choose 'Pre-skew the chart' or 'Turn every round' in the settings to avoid it.",
    );
    expect(notesWith('tapestry-round', { terms: 'us', hand: 'left', roundLean: { mode: 'note', stPerRnd: 0.5 }, rounds: 60 }).join(' ')).toContain('30 sts to the left');
    expect(notesFor('tapestry-round', { ...rh, roundLean: { mode: 'note', stPerRnd: 0.5 } }).join(' ')).toContain('about 0.5 st per round to the right');
    expect(notesFor('tapestry-round', rh).join(' ')).toContain('0.5 st per round');
    expect(notesFor('tapestry-round', { ...rh, roundLean: { mode: 'note', stPerRnd: 0 } }).join(' ')).not.toContain('lean');
    expect(notesFor('tapestry-round', { ...rh, roundLean: { mode: 'preskew', stPerRnd: 0.5 } }).join(' ')).toContain('pre-skewed');
    const turn = notesFor('tapestry-round', { ...rh, roundLean: { mode: 'turn', stPerRnd: 0.5 } });
    expect(turn[1]).toBe(
      'The rounds are joined and turned. Odd rounds are RS and are read right to left; even rounds are WS and are read left to right (left-handed: reverse). Turning every round keeps the stitches from leaning.',
    );
  });

  it('C2C (§2.7.9): the corner and arrows come from the actual start corner and hand', () => {
    const br = notesFor('c2c', rh);
    expect(br.slice(0, 3)).toEqual([
      'Each square = 1 tile (ch 3 + 3 dc).',
      'Start at the bottom-right corner.',
      'Odd rows (RS) run ↙, even rows (WS) run ↗; turn at the end of every row.',
    ]);
    expect(notesFor('c2c', { ...rh, corner: 'BL' }).slice(1, 3)).toEqual(['Start at the bottom-left corner.', 'Odd rows (RS) run ↖, even rows (WS) run ↘; turn at the end of every row.']);
    // LH bottom-left is the mirror image of RH bottom-right (row 2 ↖).
    expect(notesFor('c2c', { terms: 'us', hand: 'left' }).slice(1, 3)).toEqual([
      'Start at the bottom-left corner.',
      'Odd rows (RS) run ↘, even rows (WS) run ↖; turn at the end of every row.',
    ]);
    expect(notesFor('c2c', { ...rh, corner: 'top-left', arrows: ['↗', '↙'] })[2]).toBe('Odd rows (RS) run ↗, even rows (WS) run ↙; turn at the end of every row.');
    expect(notesFor('c2c', { terms: 'uk', hand: 'right' })[0]).toBe('Each square = 1 tile (ch 3 + 3 tr).');
    // Every arrow pair is a pair of opposite diagonals, and all four diagonals occur for each hand.
    for (const hand of ['right', 'left'] as const) {
      const odd = new Set(Object.values(C2C_ARROWS[hand]).map((pair) => pair[0]));
      expect(odd).toEqual(new Set(['↙', '↖', '↗', '↘']));
    }
  });

  it('mosaic and border', () => {
    expect(notesFor('mosaic', rh)[0]).toBe('Every row is worked with the RS facing, from right to left (left-handed: left to right); do not turn.');
    expect(notesFor('border', rh)).toEqual([
      'The border is worked in joined rounds of sc with the RS facing.',
      'Work 3 sc in each corner stitch; along the row ends (and C2C tile edges) space the stated number of sc evenly so the edge lies flat.',
    ]);
    expect(notesFor('border', { terms: 'uk', hand: 'right' })[0]).toBe('The border is worked in joined rounds of dc with the RS facing.');
  });

  it('amigurumi (§2.10.11): joined rounds and the lean sentence only when they apply', () => {
    const plain = notesFor('amigurumi', rh);
    expect(plain[0]).toBe('Work in continuous rounds (spiral); do not join or turn.');
    expect(plain.join(' ')).not.toContain('lean');
    expect(plain[plain.length - 1]).toBe('Safety eyes are not suitable for children under 3; embroider eyes instead.');
    const full = notesFor('amigurumi', { ...rh, joinedRounds: true, leanStPerRnd: 0.25 });
    expect(full[0]).toBe('Work in continuous rounds (spiral); do not join or turn, except where a piece says it is worked in joined rounds.');
    expect(full).toContain(
      'Spiral rounds lean a little each round; the stitch numbers already allow for about 0.25 st per round, and every placement also names a landmark, so pin pieces and check the landmarks before sewing.',
    );
    expect(notesFor('amigurumi', { ...rh, leanStPerRnd: -0.25 }).join(' ')).toContain('about 0.25 st per round');
    const uk = notesFor('amigurumi', { terms: 'uk', hand: 'right' });
    expect(uk[3]).toContain('“N dc” = dc in each of the next N sts');
    expect(uk[3]).toContain('dec = dc2tog through the stated loops only');
  });

  it('never throws; an unknown kind gives no notes', () => {
    expect(notesFor('nope' as 'border', rh)).toEqual([]);
    expect(notesWith('flat-graph', null as unknown as typeof rh).length).toBeGreaterThan(0);
  });
});

describe('computeSkill (DESIGN §2.8 skill points)', () => {
  it('the point table and the level bands', () => {
    expect(computeSkill({ colors: 1, meanChangesPerLine: 0, technique: 'sc_graphgan' })).toEqual({
      level: 1,
      name: 'Basic',
      reasons: ['basic stitches, at most two colors and few color changes'],
    });
    // 2 colors, ≤ 2 changes, intarsia bobbins: 0 + 0 + 2 = 2 → Easy.
    const g9 = computeSkill({ colors: 2, meanChangesPerLine: 1.7, technique: 'sc_graphgan' });
    expect(g9.level).toBe(2);
    expect(g9.name).toBe('Easy');
    expect(g9.reasons).toEqual(['intarsia: a separate bobbin for each color area (+2)']);
    // 5 colors (2) + 4.2 changes (1) + tapestry (1) = 4 → Intermediate.
    expect(computeSkill({ colors: 5, meanChangesPerLine: 4.2, technique: 'sc_tapestry' })).toMatchObject({ level: 3, name: 'Intermediate' });
    // 8 colors (2) + 9 changes (2) + bobbins (2) = 6 → Complex.
    const big = computeSkill({ colors: 8, meanChangesPerLine: 9, technique: 'sc_graphgan' });
    expect(big).toMatchObject({ level: 4, name: 'Complex' });
    expect(big.reasons).toEqual(['8 colors (+2)', 'about 9 color changes per row (+2)', 'intarsia: a separate bobbin for each color area (+2)']);
    expect(computeSkill({ colors: 3, meanChangesPerLine: 0, technique: 'c2c' })).toMatchObject({ level: 2 });
    expect(computeSkill({ colors: 2, meanChangesPerLine: 0, technique: 'mosaic_overlay' })).toMatchObject({ level: 2 });
  });

  it('band edges: ≤ 2 / 3–6 / > 6 changes, 2 / 3–4 / ≥ 5 colors', () => {
    const at = (colors: number, changes: number): number => {
      const s = computeSkill({ colors, meanChangesPerLine: changes, technique: 'amigurumi_sc' });
      return s.reasons.reduce((sum, r) => sum + Number(/\(\+(\d)\)$/.exec(r)?.[1] ?? 0), 0);
    };
    expect([at(2, 2), at(2, 2.01), at(2, 6), at(2, 6.01)]).toEqual([0, 1, 1, 2]);
    expect([at(2, 0), at(3, 0), at(4, 0), at(5, 0)]).toEqual([0, 1, 1, 2]);
  });

  it('amigurumi: pieces, irregular shaping and BLO/FLO (T4 calls it)', () => {
    const s = computeSkill({ colors: 3, meanChangesPerLine: 0.5, technique: 'amigurumi_sc', pieces: 8, irregularShaping: true, bloFlo: true });
    expect(s.reasons).toEqual(['3 colors (+1)', '8 pieces to make and assemble (+2)', 'irregular shaping (ovals, uneven increases) (+1)', 'back- or front-loop-only details (+1)']);
    expect(s).toMatchObject({ level: 3, name: 'Intermediate' });
    expect(computeSkill({ colors: 1, meanChangesPerLine: 0, technique: 'amigurumi_sc', pieces: 1 }).level).toBe(1);
    expect(computeSkill({ colors: 1, meanChangesPerLine: 0, technique: 'amigurumi_sc', pieces: 3 }).reasons).toEqual(['3 pieces to make and assemble (+1)']);
  });

  it('a chart without color changes in its lines is stripes (0 technique points)', () => {
    expect(computeSkill({ colors: 2, meanChangesPerLine: 0, technique: 'sc_graphgan' }).level).toBe(1);
    expect(computeSkill({ colors: 2, meanChangesPerLine: 0, technique: 'sc_tapestry_round' }).level).toBe(1);
  });

  it('reasons never read as the band edge; no technique, no technique points', () => {
    expect(computeSkill({ colors: 2, meanChangesPerLine: 2.0001, technique: 'amigurumi_sc' }).reasons).toEqual(['about 2.1 color changes per round (+1)']);
    expect(computeSkill({ colors: 2, meanChangesPerLine: 3, technique: 'amigurumi_sc' }).reasons).toEqual(['about 3 color changes per round (+1)']);
    expect(computeSkill({ colors: 2, meanChangesPerLine: 1 } as Parameters<typeof computeSkill>[0]).level).toBe(1);
  });

  it('never throws on nonsense', () => {
    expect(computeSkill({ colors: Number.NaN, meanChangesPerLine: -3, technique: 'sc_graphgan' }).level).toBe(1);
    expect(computeSkill(null as unknown as Parameters<typeof computeSkill>[0]).level).toBeGreaterThanOrEqual(1);
  });
});

describe('word chart (§2.7.2)', () => {
  it('11 ← | 4A 3B 33A | 40', () => {
    const line = row(11, parseBody('4 sc A, 3 sc B, 33 sc A'), 40, { side: 'RS', arrow: '←', start: { k: 'turn', chains: 1 } });
    expect(renderWordChartLine(line)).toBe('11 ← | 4A 3B 33A | 40');
  });
  it('C2C rows put their arrow first; header colors fill untagged stitches; shaped ops print their compact text', () => {
    const c2c = { kind: 'c2c', n: 4, arrow: '↗', start: { k: 'c2c', start: 'inc', end: 'dec' }, ops: [tile('A'), tile('B'), tile('A')], prevCount: 3, stated: 3 } as const;
    expect(renderWordChartLine({ ...c2c, ops: [...c2c.ops] })).toBe('↗ 4 | 1A 1B 1A | 3');
    expect(wordChartRuns(rnd(9, times(6, sc), 6, { colorHeader: 'B' }))).toBe('6B');
    expect(wordChartRuns(rnd(2, times(6, inc), 12))).toBe('6 inc');
    expect(wordChartRuns(rnd(2, times(6, inc), 12), { terms: 'uk' })).toBe('6 inc');
    expect(wordChartRuns(rnd(2, times(3, sc, { k: 'st', st: 'slst' }), 6), { terms: 'uk' })).toBe('dc ss dc ss dc ss');
    expect(wordChartRuns(rnd(2, times(6, sc), 6))).toBe('6 sc');
  });
});

describe('notesFor ctx.rounds and ctx.stitch (integration S1, T2 task 3: now in the frozen ctx)', () => {
  it('rounds reach the §2.7.5 drift sentence; stitch reaches “1 hdc” and “Ch 2”', () => {
    const drift = notesFor('tapestry-round', { ...rh, roundLean: { mode: 'note', stPerRnd: 0.5 }, rounds: 60 }).join(' ');
    expect(drift).toContain('shift about 30 sts to the right between Rnd 1 and Rnd 60');
    const hdc = notesFor('flat-graph', { ...rh, stitch: 'hdc' });
    expect(hdc[0]).toBe('Each square = 1 hdc.');
    expect(hdc[2]).toBe('Ch 2 at the beginning of a row does not count as a stitch.');
  });
  it('the drift is rounded half up (§0.1 roundHalfUp): 0.5 st × 5 rounds = 2.5 → 3', () => {
    expect(notesFor('tapestry-round', { ...rh, roundLean: { mode: 'note', stPerRnd: 0.5 }, rounds: 6 }).join(' ')).toContain('about 3 sts');
    expect(notesFor('tapestry-round', { ...rh, roundLean: { mode: 'note', stPerRnd: 0.3 }, rounds: 6 }).join(' ')).toContain('about 2 sts');
  });
});
