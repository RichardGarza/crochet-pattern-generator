// Test helper: the goldens of DESIGN.md §2.10.5, §2.10.6 and §2.10.8, read from the spec text itself so that no
// expected list is ever typed by hand (§2.10.5: "T4 generates its golden files from its own implementation and
// compares them with these lists"). Each reader fails loudly if the spec text it anchors on moves.
import { readFileSync } from 'node:fs';

const DESIGN = readFileSync(new URL('../../../../../docs/DESIGN.md', import.meta.url), 'utf8');
const RESEARCH_03 = readFileSync(new URL('../../../../../docs/research/03-3d-amigurumi-generation.md', import.meta.url), 'utf8');

/** The text of a `####` section, from its heading to the next heading of any level. */
function section(doc: string, heading: string): string {
  const at = doc.indexOf(heading);
  if (at < 0) throw new Error(`spec helper: heading not found: ${heading}`);
  const rest = doc.slice(at + heading.length);
  const end = rest.search(/\n#{2,4} /);
  return end < 0 ? rest : rest.slice(0, end);
}

/** Whitespace (line breaks and indentation) collapsed, so a sentence can be matched across lines. */
const flat = (s: string) => s.replace(/\s+/g, ' ');

function match(text: string, re: RegExp, what: string): RegExpMatchArray {
  const m = text.match(re);
  if (!m) throw new Error(`spec helper: ${what} not found by ${re}`);
  return m;
}

/**
 * A count list as the spec prints it: `6 12 18`, `12×6` / `24 ×10` (a value repeated), `|` separators,
 * `…` (rejected: a list with an ellipsis is a prefix, read it with `prefixList`).
 */
export function parseList(s: string): number[] {
  const out: number[] = [];
  const tokens = s.replace(/\|/g, ' ').replace(/\s*×\s*/g, '×').trim().split(/\s+/);
  for (const t of tokens) {
    const rep = t.match(/^(\d+)×(\d+)$/);
    if (rep) out.push(...Array<number>(Number(rep[2])).fill(Number(rep[1])));
    else if (/^\d+$/.test(t)) out.push(Number(t));
    else throw new Error(`spec helper: unexpected token "${t}" in "${s}"`);
  }
  return out;
}

/** Numbers of a list that ends or starts with `…`, without it. */
export function prefixList(s: string): number[] {
  return s
    .replace(/…/g, ' ')
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((t) => {
      if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`spec helper: unexpected token "${t}" in "${s}"`);
      return Number(t);
    });
}

const S2105 = flat(section(DESIGN, '#### 2.10.5 Path A: counts from a profile (normative)'));
const S2106 = flat(section(DESIGN, '#### 2.10.6 Starts and finishes'));
const S2108 = section(DESIGN, '#### 2.10.8 Placing increases and decreases (both paths, normative)');

export const spec = {
  textbookSphere(): { counts: number[]; rounds: number; worstedPlain: number; worstedRounds: number } {
    const m = match(
      S2105,
      /Textbook sphere k = 6, w\/h = 1\.0 → `([^`]+)` \((\d+) rounds\); with worsted defaults \(w\/h = 1\.05\) the plain rounds become (\d+) \((\d+) rounds\)/,
      'textbook sphere',
    );
    return { counts: parseList(m[1]), rounds: Number(m[2]), worstedPlain: Number(m[3]), worstedRounds: Number(m[4]) };
  },

  latheSemicircle(): { N: number; rounds: number; exact: number[]; classic: number[] } {
    const m = match(S2105, /Lathe semicircle r = 1\.5 \(N = (\d+), (\d+) rounds\), exact → `([^`]+)`; classic → `([^`]+)`/, 'lathe semicircle');
    return { N: Number(m[1]), rounds: Number(m[2]), exact: parseList(m[3]), classic: parseList(m[4]) };
  },

  cone(): { idealsHead: number[]; idealLast: number; N: number; classic: number[]; exact: number[]; hysteresisHead: number[] } {
    const m = match(
      S2105,
      /Cone r = 1, h = 3, open base \(`openEnd: 'bottom'`; ideals `([^`]+)`, N = (\d+)\), classic → `([^`]+)`.*?\*\*exact\*\* → `([^`]+)` \(hysteresis gives `([^`]+)`/,
      'cone',
    );
    const ideals = prefixList(m[1]);
    return {
      idealsHead: ideals.slice(0, -1),
      idealLast: ideals[ideals.length - 1],
      N: Number(m[2]),
      classic: parseList(m[3]),
      exact: parseList(m[4]),
      hysteresisHead: prefixList(m[5]),
    };
  },

  horn(): { exact: number[]; rawTail: number[]; clampedTail: number[]; bloRound: number } {
    const m = match(
      S2105,
      /Horn: cone r = 0\.6, h = 1\.8 worked from the base \(`crochet\.start: 'bottom'`, closed base disc\), exact → `([^`]+)`, then close \(raw tail `([^`]+)` → `([^`]+)` → trailing duplicate dropped\); BLO on Rnd (\d+)/,
      'horn',
    );
    return { exact: parseList(m[1]), rawTail: prefixList(m[2]), clampedTail: prefixList(m[3]), bloRound: Number(m[4]) };
  },

  cylinder(): { counts: number[]; rounds: number; blo: number[] } {
    const m = match(S2105, /Closed cylinder ⌀1\.5 × 2 → `([^`]+)` \((\d+) rounds\), BLO on rounds (\d+) and (\d+)/, 'closed cylinder');
    return { counts: parseList(m[1]), rounds: Number(m[2]), blo: [Number(m[3]), Number(m[4])] };
  },

  openCapsule(): { wS: number; hS: number; k: number; sEnd: number; rEnd: number; counts: number[]; openSts: number; tailIn: number; tailCm: number; closed: number[] } {
    const m = match(
      S2105,
      /Open capsule — the §3\.6 `arm_l` \(r 0\.32, length 1\.4, `openEnd: 'top'`, light, worsted: wS ([\d.]+), hS ([\d.]+); untrimmed against the body\): k = (\d+), `s_end = [\d.]+ \+ [\d.]+ = ([\d.]+) in` ⇒ R_end = (\d+) ⇒ `([^`]+)` \(`[^`]+`\), open with (\d+) sts: "Fasten off, leaving a (\d+)" \((\d+) cm\) tail for sewing\." The closed textbook capsule would be `([^`]+)`/,
      'open capsule',
    );
    return {
      wS: Number(m[1]),
      hS: Number(m[2]),
      k: Number(m[3]),
      sEnd: Number(m[4]),
      rEnd: Number(m[5]),
      counts: parseList(m[6]),
      openSts: Number(m[7]),
      tailIn: Number(m[8]),
      tailCm: Number(m[9]),
      closed: parseList(m[10]),
    };
  },

  closedOvalBox(): { S: number; chains: number; counts: number[]; N: number; rounds: number; blo: number[]; finishSc: number } {
    const m = match(
      S2105,
      /Closed oval — `box` w 2, d 1, h 1\.5, exact: S = (\d+), ch (\d+); counts `([^`]+)` \(N = (\d+), (\d+) rounds\); BLO on Rnds (\d+) and (\d+) \([^)]*\); finish "Flatten … sc through both layers across \((\d+) sc\)"/,
      'closed oval box',
    );
    return {
      S: Number(m[1]),
      chains: Number(m[2]),
      counts: parseList(m[3]),
      N: Number(m[4]),
      rounds: Number(m[5]),
      blo: [Number(m[6]), Number(m[7])],
      finishSc: Number(m[8]),
    };
  },

  ovalEllipsoid(): { axis: string; a: number; b: number; N: number; rounds: number; S: number[]; sMax: number; idealsHead: number[]; chains: number; counts: number[]; circ: number[]; finishSts: number } {
    const m = match(
      S2105,
      /Oval ellipsoid rx 1\.2, ry 0\.6, rz 2\.0 \(unattached, exact\): â = ([XYZ]) \(longest\), cross-section a = ([\d.]+), b = ([\d.]+), N = (\d+) \((\d+) rounds\); `S_k = ([\d ]+)` \(never above `round\(2·0\.6\/wS\) = (\d+)`, \|ΔS\| ≤ 1\); the profile is symmetric \(circular ideals `([^`]+)` mirrored\), so `mirrorHalf` applies; ch (\d+) start; counts `([^`]+)` \(circular part `([^`]+)`\); closed-oval finish across (\d+) sts/,
      'oval ellipsoid',
    );
    return {
      axis: m[1].toLowerCase(),
      a: Number(m[2]),
      b: Number(m[3]),
      N: Number(m[4]),
      rounds: Number(m[5]),
      S: parseList(m[6]),
      sMax: Number(m[7]),
      idealsHead: prefixList(m[8]),
      chains: Number(m[9]),
      counts: parseList(m[10]),
      circ: parseList(m[11]),
      finishSts: Number(m[12]),
    };
  },

  /** §2.10.6 sewing-tail examples (worsted): 12-st arm opening and 36-st opening. */
  tailExamples(): { sts: number; in: number; cm: number }[] {
    const m = match(S2106, /Examples \(worsted\): (\d+)-st arm opening → (\d+)" \((\d+) cm\); (\d+)-st opening → (\d+)" \((\d+) cm\)/, 'tail examples');
    return [
      { sts: Number(m[1]), in: Number(m[2]), cm: Number(m[3]) },
      { sts: Number(m[4]), in: Number(m[5]), cm: Number(m[6]) },
    ];
  },

  /** §2.10.6 tail rule constants: `T = max(12 in, 3 × seam + 6 in)`. */
  tailRule(): { min: number; mult: number; plus: number; gather: number } {
    const m = match(S2106, /Sewing tail\*\* `T = max\((\d+) in, (\d+) × seam \+ (\d+) in\)`/, 'sewing tail rule');
    const g = match(S2106, /"Fasten off, leaving a (\d+)" \((\d+) cm\) tail; close with the Ultimate Finish/, 'gather tail');
    return { min: Number(m[1]), mult: Number(m[2]), plus: Number(m[3]), gather: Number(g[1]) };
  },

  /** §2.10.8 golden text (G5): the stated count of every round, `Rnds a–b` expanded. */
  textbookTextCounts(): number[] {
    const at = S2108.indexOf('Golden text (textbook sphere, k = 6');
    if (at < 0) throw new Error('spec helper: §2.10.8 golden text not found');
    const block = S2108.slice(at).split('```')[1];
    const out: number[] = [];
    for (const line of block.split('\n')) {
      const one = line.match(/^Rnd (\d+): .*\((\d+)\)$/);
      const many = line.match(/^Rnds (\d+)–(\d+) \((\d+) rnds\): .*\((\d+)\)$/);
      if (one) out.push(Number(one[2]));
      else if (many) out.push(...Array<number>(Number(many[2]) - Number(many[1]) + 1).fill(Number(many[4])));
    }
    return out;
  },
};

/** Research 03 §5's computed torus example (not a DESIGN golden; a cross-check of the §2.10.4 formula). */
export function researchTorus(): number[] {
  const m = match(flat(RESEARCH_03), /\*\*Torus, R = 1\.5 in, a = 0\.5 in:\*\* `([^`]+)`, then seam/, 'research torus');
  return parseList(m[1]);
}
