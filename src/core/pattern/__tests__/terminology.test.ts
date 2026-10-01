import { describe, expect, it } from 'vitest';
import type { Line } from '../../../types';
import { US_COMPACT_NAMES } from '../ops';
import { UK_COMPACT_NAMES, abbreviationsFor, compactNames, specialStitchesFor, toTerms } from '../terminology';
import { dec, dec3, inc, inLoop, parseBody, rnd, row, sc, tile, times } from './helpers';

describe('the terminology table (DESIGN §2.7.2, research 07 §1.3)', () => {
  it('UK compact names: sc → dc, hdc → htr, dc → tr, sl st → ss, sc2tog → dc2tog (vector 22: never tr2tog)', () => {
    expect(UK_COMPACT_NAMES).toEqual({ sc: 'dc', hdc: 'htr', dc: 'tr', slst: 'ss', inc: 'inc', inc3: 'inc3', dec: 'dec', dec3: 'dec3', sc2tog: 'dc2tog', sc3tog: 'dc3tog' });
    expect(compactNames('uk')).toBe(UK_COMPACT_NAMES);
    expect(compactNames('us')).toBe(US_COMPACT_NAMES);
    expect(Object.isFrozen(UK_COMPACT_NAMES)).toBe(true);
  });

  it('toTerms converts each US term once, longest match first, keeping the first capital', () => {
    const cases: [string, string][] = [
      ['sc2tog', 'dc2tog'],
      ['dc2tog', 'tr2tog'],
      ['hdc2tog', 'htr2tog'],
      ['sc3tog', 'dc3tog'],
      ['Sc in each st around', 'Dc in each st around'],
      ['2sc in next st', '2dc in next st'],
      ['dc in next st, then tr', 'tr in next st, then dtr'],
      ['single crochet, half double crochet, double crochet, treble', 'double crochet, half treble, treble, double treble'],
      ['Gauge: 16 sc = 4"', 'Tension: 16 dc = 4"'],
      ['change on the last yo', 'change on the last yoh'],
      ['Change color on the last yarn over', 'Change color on the last yarn over hook'],
      ['sl st in first sc; 3 sl sts', 'ss in first dc; 3 ss'],
      ['FPdc around the post', 'FPtr around the post'],
      ['join B (bobbin 2) · carry A, C', 'join B (bobbin 2) · carry A, C'],
      ['scissors, discard, dcx, yolk, Mosaic', 'scissors, discard, dcx, yolk, Mosaic'],
      ['BLO sc2tog', 'BLO dc2tog'],
      ['triple treble', 'quadruple treble'],
      ['SC and DC, GAUGE', 'DC and TR, TENSION'],
      ['sl  st in next st', 'ss in next st'],
    ];
    for (const [usText, ukText] of cases) {
      expect(toTerms(usText, 'uk')).toBe(ukText);
      expect(toTerms(usText, 'us')).toBe(usText);
    }
  });

  it('a naive two-step replace would double-convert; the one pass does not (research 07 §1.3)', () => {
    const text = 'sc in next st, dc in next st';
    const naive = text.replace(/\bsc\b/g, 'dc').replace(/\bdc\b/g, 'tr');
    expect(naive).toBe('tr in next st, tr in next st');
    expect(toTerms(text, 'uk')).toBe('dc in next st, tr in next st');
  });
});

describe('abbreviationsFor (only those used, sorted)', () => {
  const graph: Line[] = [
    row(1, parseBody('2 sc A, sc B, 2 sc A'), null, { side: 'RS', arrow: '←', start: { k: 'foundation', chains: 6, firstInto: 2 } }),
    row(2, parseBody('sc A, 3 sc B, sc A'), 5, { side: 'WS', arrow: '→', start: { k: 'turn', chains: 1 }, cues: [{ kind: 'color', text: 'carry A' }] }),
  ];

  it('a flat graph: ch, RS, sc, st(s), WS', () => {
    expect(abbreviationsFor(graph, 'us')).toEqual([
      { abbr: 'ch', meaning: 'chain' },
      { abbr: 'RS', meaning: 'right side' },
      { abbr: 'sc', meaning: 'single crochet' },
      { abbr: 'st(s)', meaning: 'stitch(es)' },
      { abbr: 'WS', meaning: 'wrong side' },
    ]);
    expect(abbreviationsFor(graph, 'uk')).toEqual([
      { abbr: 'ch', meaning: 'chain' },
      { abbr: 'dc', meaning: 'double crochet' },
      { abbr: 'RS', meaning: 'right side' },
      { abbr: 'st(s)', meaning: 'stitch(es)' },
      { abbr: 'WS', meaning: 'wrong side' },
    ]);
  });

  it('amigurumi rounds: MR, inc, dec / invdec, BLO and sc2tog, sl st from a join, rnd(s)', () => {
    const lines: Line[] = [
      rnd(1, times(6, sc), 6, { start: { k: 'mr', n: 6 }, prevCount: null }),
      rnd(2, times(6, inc), 12, { prevCount: 6 }),
      rnd(3, times(6, sc, dec), 6, { prevCount: 18 }),
      rnd(4, inLoop(times(3, dec), 'BLO'), 3, { prevCount: 6, start: { k: 'join' }, join: {} }),
    ];
    const abbrs = abbreviationsFor(lines, 'us').map((a) => a.abbr);
    expect(abbrs).toEqual(['BLO', 'ch', 'dec', 'FLO', 'inc', 'invdec', 'MR', 'rnd(s)', 'sc', 'sc2tog', 'sl st', 'st(s)']);
    expect(abbreviationsFor(lines, 'uk').map((a) => a.abbr)).toEqual(['BLO', 'ch', 'dc', 'dc2tog', 'dec', 'FLO', 'inc', 'invdec', 'MR', 'rnd(s)', 'ss', 'st(s)']);
    // A 3D round always brings what the amigurumi Notes block defines.
    expect(abbreviationsFor([rnd(1, times(6, sc), 6, { start: { k: 'mr', n: 6 }, prevCount: null })], 'us').map((a) => a.abbr)).toEqual(['BLO', 'ch', 'dec', 'FLO', 'inc', 'invdec', 'MR', 'rnd(s)', 'sc', 'sc2tog', 'st(s)']);
    expect(abbreviationsFor(lines, 'uk').find((a) => a.abbr === 'inc')?.meaning).toBe('increase: 2 dc in the same stitch');
  });

  it('C2C rows: what the tags and the C2C Notes block print (beg, inc, dec, ch-sp, dc, sl st, yo)', () => {
    const lines: Line[] = [
      { kind: 'c2c', n: 1, side: 'RS', arrow: '↙', start: { k: 'c2c', start: 'first', end: 'first' }, ops: [tile('A')], prevCount: null, stated: 1 },
      { kind: 'c2c', n: 2, side: 'WS', arrow: '↗', start: { k: 'c2c', start: 'dec', end: 'dec' }, ops: [tile('A')], prevCount: 1, stated: 1, notes: ['change on the last yo'] },
    ];
    expect(abbreviationsFor(lines, 'us').map((a) => a.abbr)).toEqual(['beg', 'ch', 'ch-sp', 'dc', 'dec', 'inc', 'RS', 'sl st', 'WS', 'yo']);
    expect(abbreviationsFor(lines, 'uk').map((a) => a.abbr)).toEqual(['beg', 'ch', 'ch-sp', 'dec', 'inc', 'RS', 'ss', 'tr', 'WS', 'yoh']);
    expect(abbreviationsFor(lines, 'us').find((a) => a.abbr === 'inc')?.meaning).toBe('increase: a row that gains a tile at that end (see Notes)');
  });

  it('never throws on malformed input', () => {
    expect(abbreviationsFor(null as unknown as Line[], 'us')).toEqual([]);
    expect(abbreviationsFor([null, 3, { kind: 'row', ops: 'x' }] as unknown as Line[], 'us')).toEqual([{ abbr: 'st(s)', meaning: 'stitch(es)' }]);
    expect(specialStitchesFor([null, { ops: [null] }] as unknown as Line[], 'uk')).toEqual([]);
  });
});

describe('specialStitchesFor', () => {
  it('lists only what is used: MR, invisible decrease, BLO sc2tog, dec3', () => {
    const lines: Line[] = [
      rnd(1, times(6, sc), 6, { start: { k: 'mr', n: 6 }, prevCount: null }),
      rnd(2, times(3, sc, dec), 6, { prevCount: 9 }),
      rnd(3, inLoop(times(3, dec), 'BLO'), 3, { prevCount: 6 }),
      rnd(4, [dec3], 1, { prevCount: 3 }),
    ];
    const names = specialStitchesFor(lines, 'us').map((s) => s.name);
    expect(names).toEqual(['Magic ring (MR)', 'Invisible decrease (dec, invdec)', 'Decrease over 3 stitches (dec3)', 'BLO sc2tog']);
    const blo = specialStitchesFor(lines, 'us').find((s) => s.name === 'BLO sc2tog');
    // §2.10.11 wording.
    expect(blo?.text).toBe('Insert the hook in the back loop only of each of the next 2 sts, yo and draw up a loop in each, yo and draw through all 3 loops.');
    const uk = specialStitchesFor(lines, 'uk');
    expect(uk.map((s) => s.name)).toContain('BLO dc2tog');
    expect(uk.find((s) => s.name === 'BLO dc2tog')?.text).toContain('yoh and draw up a loop in each');
    expect(JSON.stringify(uk)).not.toContain('tr2tog');
  });

  it('C2C tiles and mosaic long stitches', () => {
    const lines: Line[] = [
      { kind: 'c2c', n: 1, start: { k: 'c2c', start: 'first', end: 'first' }, ops: [tile('A')], prevCount: null, stated: 1 },
      row(2, [sc, { k: 'st', st: 'dc', into: 'flo2below' }, sc], 3, { start: { k: 'turn', chains: 1 } }),
    ];
    expect(specialStitchesFor(lines, 'us').map((s) => s.name)).toEqual(['C2C tile', 'Mosaic long stitch (dc FLO 2 rows below)']);
    expect(specialStitchesFor(lines, 'uk').map((s) => s.name)).toEqual(['C2C tile', 'Mosaic long stitch (tr FLO 2 rows below)']);
    expect(specialStitchesFor([], 'us')).toEqual([]);
  });
});

describe('decMethod (integration S1, T2 task 1): only the decrease the pattern uses', () => {
  const ami: Line[] = [rnd(1, times(6, sc), null, { start: { k: 'mr', n: 6 } }), rnd(2, [...times(4, sc), dec], 6)];
  const abbrs = (m?: 'invdec' | 'sc2tog'): string[] => abbreviationsFor(ami, 'us', m).map((a) => a.abbr);
  it('sc2tog: no invdec in the abbreviations or the special stitches', () => {
    expect(abbrs('sc2tog')).toContain('sc2tog');
    expect(abbrs('sc2tog')).not.toContain('invdec');
    const special = specialStitchesFor(ami, 'us', 'sc2tog');
    expect(special.map((s) => s.name)).toEqual(['Magic ring (MR)', 'Decrease (dec, sc2tog)']);
    expect(JSON.stringify(special)).not.toMatch(/invisible|invdec/i);
    expect(specialStitchesFor(ami, 'uk', 'sc2tog').map((s) => s.name)).toEqual(['Magic ring (MR)', 'Decrease (dec, dc2tog)']);
  });
  it('invdec: no sc2tog, and the invisible decrease without the sc2tog alternative', () => {
    expect(abbrs('invdec')).toContain('invdec');
    expect(abbrs('invdec')).not.toContain('sc2tog');
    const special = specialStitchesFor(ami, 'us', 'invdec');
    expect(special[1].name).toBe('Invisible decrease (dec, invdec)');
    expect(special[1].text).not.toMatch(/sc2tog/i);
  });
  it('absent: both, as before', () => {
    expect(abbrs()).toEqual(expect.arrayContaining(['invdec', 'sc2tog']));
    expect(specialStitchesFor(ami, 'us')[1].text).toMatch(/Sc2tog works too/);
  });
  it('dec3 with sc2tog lists sc3tog; BLO decreases are sc2tog through the loop whatever the method', () => {
    const lines: Line[] = [rnd(1, times(6, sc), null, { start: { k: 'mr', n: 6 } }), rnd(2, [sc, sc, sc, dec3], 6, { stated: 4 })];
    expect(abbreviationsFor(lines, 'us', 'sc2tog').map((a) => a.abbr)).toEqual(expect.arrayContaining(['dec3', 'sc3tog']));
    expect(specialStitchesFor(lines, 'us', 'sc2tog').map((s) => s.name)).toContain('Decrease over 3 stitches (dec3, sc3tog)');
    const blo: Line[] = [rnd(1, times(6, sc), null, { start: { k: 'mr', n: 6 } }), rnd(2, inLoop(times(3, dec), 'BLO'), 6, { stated: 3 })];
    expect(specialStitchesFor(blo, 'us', 'invdec').map((s) => s.name)).toEqual(['Magic ring (MR)', 'BLO sc2tog']);
  });
  it('an unknown method is read as absent; never throws', () => {
    expect(abbreviationsFor(ami, 'us', 'x' as never)).toEqual(abbreviationsFor(ami, 'us'));
    expect(() => specialStitchesFor(null as never, 'us', 'sc2tog')).not.toThrow();
  });
});
