# Step 0b — pattern-language kernels (`s0b/pattern`)

Branch `s0b/pattern`, made from the Step 0a commit `ca1a96f`. Scope: `src/core/pattern/{ops,encode,validateLine,compact}.ts`
and their tests (`DESIGN.md` §5.1, §6.2 item 5). Nothing else was touched: the T2 stubs in the same folder
(`render`, `text`, `skill`, `notes`, `terminology`, `doc`, `wordchart`), the frozen types and every config file are
as Step 0a left them.

Commits: `47ca4e0` (the four kernels and their tests), `5d3e6d9` (fixes from an independent review),
`d623ace` (two more exports for T2, a text read-back test, test timeouts), `3fd00d8` (`isOp` speed), and the
commit that adds this file.

## What was delivered

| File | What it is |
|---|---|
| `ops.ts` | The stitch vocabulary: `CONS` / `PROD`, `isOp`, counts of ops and of lines (C2C rows count ch-3 spaces), the E_CONSUME exemptions, which kind of line each start stands on, what a first-line start offers (`startCapacity`), the ops as printed (`displayOps`), the compact stitch names, and `expand`. |
| `encode.ts` | `encodeOps` (§2.6.1): the shortest encoding with one bracket level, exact up to 120 tokens, the linear run/period fallback above, per-op and per-run token modes, segments, an LRU memo of 4 096 entries keyed by `fnv1a64(token ints ‖ mode)`. |
| `validateLine.ts` | `validateLine`: the rules of §2.13 that one line decides, alone or against the line before it (`E_SANITY`, `E_CONSUME`, `E_START` and `E_FOUNDATION` for the first line of a piece, `E_PRODUCE`, `E_INC_INFEASIBLE`, `E_DEC_INFEASIBLE`, `E_COLOR`, `E_ROUNDTRIP`); `validateLines`: a whole piece, plus its shape (`E_START`). Never throws. |
| `compact.ts` | The Compact dialect (§2.7.2, §2.7.3, §2.7.5, §2.7.6, §2.10.6, §2.10.11, §2.11.3): amigurumi rounds, flat rows, tapestry rounds, C2C rows, chain ovals, chain rings, joined rounds, border rounds (generic); `lineItems`, the encoded form every renderer prints. |
| `__tests__/` | `ops.test.ts` (32 tests), `encode.test.ts` (57), `encode.perf.test.ts` (3), `validateLine.test.ts` (80), `validateLine.roundtrip.test.ts` (9), `compact.test.ts` (58), and `helpers.ts` (not a test: a parser for the compact notation, the §2.10.8 placement rule, a literal transcription of the encoder's definition, a brute-force search, random line generators). |

Dependencies between the four: `ops` ← `encode` ← `compact` ← `validateLine` (no cycle). `encode.ts` also uses
`core/kernel/hash.ts`; nothing else is imported. No `Math.random()`, no `Date`, no DOM (§5.8).

## How a `Line` is read (what later tracks code against)

- **Only ops are stitches.** Turning chains, the ch 1 and sl st of a joined round, the foundation chain and the
  magic ring's ch 1 are a `LineStart` or `Line.join` and count for nothing (§2.11.3). Σ produced(ops) is the stated
  count on every line, with no special case.
- **Which start stands on which line** (`START_LINE_KINDS`; anything else is `E_SANITY`): `mr`, `chainOval`,
  `chainRing` begin rounds; `foundation` begins rows; `turn` on rows and on turned rounds (§2.7.5); `join` on rounds
  and on border Rnds 2–n; `edge` on border Rnd 1 only; `c2c` on C2C rows only, and every C2C row has one, with
  `first` at both ends on Row 1 and nowhere else.
- **Magic ring:** `start: { k: 'mr', n }` and the n stitches as ops: `Rnd 1: 6 sc in MR (6)` is six `sc` ops. The
  text and the count come from the ops; `start.n` must equal their number and only `st` ops may be worked into a
  ring (`E_START`).
- **Chain oval, Rnd 1:** ops `(S + 1) sc, inc3, S sc, inc` with `S = chains − 3`. They consume `2N − 3` chain
  loops (`E_START` otherwise) and make `2N` stitches (research 07 §6.9, vector 13), and they print as the sentence
  of §2.10.6. Any other ops on a `chainOval` line print as a plain list.
- **Chain ring, Rnd 1:** worked into each of its N chains (consumed = N, `E_START` otherwise); `sc in each ch
  around` (a torus may also increase in Rnd 1).
- **Foundation, Row 1:** worked from chain `firstInto` to the last: consumed = `chains − firstInto + 1`
  (`E_FOUNDATION` otherwise); sc graph `ch W + 1` from the 2nd ch, hdc `ch W + 2` from the 3rd.
- **Joined rounds (§2.11.3):** `join` on a line adds `; join with sl st in first sc[, changing to B].`;
  `start: { k: 'join' }` begins the round with `Ch 1 (does not count), sc in same st as join, …` (3D) or `Ch 1, …`
  (2D, §2.7.5). A 3D line with `start: { k: 'join' }` and no `join` ends `; do not join — continue in a spiral.`
- **`prevCount`** is `null` only on a line that starts a piece (magic ring, foundation, chain oval, chain ring,
  border `edge`, first C2C tile). Every other line must carry it; a missing one is `E_CONSUME`.
- **A piece** (`validateLines`): its first line starts from one of those starts, and no later line does, except a
  border's `edge` round after the panel's rows (`E_START`). To check part of a piece, chain `validateLine` with
  `prev`.
- **C2C rows:** ops are `tile`s; `prevCount` and `stated` are tile counts. The row consumes
  `tiles − [inc beg] + [dec end]` ch-3 spaces, which is the previous row's tile count on every valid row (research
  07 §4.3; checked for 4×4, 5×3, 3×5, 10×7, 7×10, 1×5, 5×1, 100×60).
- **Folded lines:** one `Line` with `nEnd > n`. The kernel prints it (`Rnds 7–12 (6 rnds)`) and checks that it
  leaves the count unchanged; `nEnd = n` is a plain line; the first line of a piece cannot be folded. Deciding what
  may be folded (`E_FOLD`) belongs to whoever folds (T2, T4); the label prints `side` and `arrow` as given, so a
  fold of turned rows, which covers both sides, should leave them out (§2.6.2).
- **Colors:** `colorHeader` prints in the label (`Rnd 9 (B)`); ops in that color print without a tag, exactly like
  untagged ops, so the two form one run; any other color prints its tag (`Rnd 9 (B): 30 sc, 6 sc A (36)`). Without
  a header every colored op prints its tag (`4 sc A`), and a tagged line never becomes `sc in each st around`.
- **Loops:** `loop: 'both'` prints as no loop and never splits a run. When every op of a line carries the same
  `BLO`/`FLO`, the line prints it once as a prefix and its decreases as `sc2tog` (§2.10.5). Otherwise each run
  carries its tag (`3 sc BLO, 2 sc`).
- **Segments** (`Line.segments`, oval rounds): encoded separately and joined, so neither a repeat nor a run crosses
  a boundary (`7 sc, sc, (2 sc, inc) x 2`, not `8 sc, …`); a line of one op is still one run, so a plain oval round
  prints `sc in each st around`. An empty segment (two equal `at`, or `at` = the number of ops) is allowed.
- **2D or 3D style** is not in the `Line`: `kind: 'rnd'` is both an amigurumi round and a tapestry round. The
  renderer and the validator take `docKind: '2d' | '3d'`; the default is `'3d'` for rounds and `'2d'` for rows, C2C
  rows and borders. T2 passes `docKind: '2d'` for tapestry rounds; T4 passes `docKind: '3d'` for flat pieces (see
  request 2). The token mode follows it: one token per run in '2d', per op in '3d'.
- **Ops outside the frozen type** (an unknown field, a value out of range) are `E_SANITY`: the renderer could not
  print them. `encodeOps` still carries such ops through `expand` unchanged when their data is plain JSON, and
  throws a `TypeError` otherwise.

## Public API

Signatures are exactly as in the source. Results of `encodeOps` and `lineItems` are frozen and may be shared:
read them, never change them. Nothing here is a §5.2.1 entry point, so no `…Fn` type applies.

### `src/core/pattern/ops.ts`

| Export | Signature | What it does |
|---|---|---|
| `OpName` | `type OpName = 'sc' \| 'hdc' \| 'dc' \| 'slst' \| 'inc' \| 'inc3' \| 'dec' \| 'dec3' \| 'tile'` | The key of `CONS` / `PROD`: one name per distinct operation. |
| `OP_NAMES` | `const OP_NAMES: readonly OpName[]` | All of them (frozen). |
| `CONS` | `const CONS: Readonly<Record<OpName, number>>` | Stitches (or ch-3 spaces) of the previous line one op is worked into: 1, except `dec` 2 and `dec3` 3. Frozen. |
| `PROD` | `const PROD: Readonly<Record<OpName, number>>` | Stitches one op makes: 1, except `inc` 2 and `inc3` 3. Frozen. |
| `isOp` | `function isOp(value: unknown): value is Op` | True for exactly an op of the frozen type: every field it needs, each in range, no other defined field. |
| `opName` | `function opName(op: Op): OpName` | The table key of an op (loops and colors never change it). Throws `TypeError` on a malformed op. |
| `consumed` | `function consumed(ops: readonly Op[]): number` | Σ CONS over a list of ops. |
| `produced` | `function produced(ops: readonly Op[]): number` | Σ PROD over a list of ops. |
| `Item` | `type Item = { readonly kind: 'run'; readonly op: Op; readonly n: number } \| { readonly kind: 'rep'; readonly inner: readonly Item[]; readonly times: number }` | One element of an encoded line (§2.6.1): `4 sc`, or `(sc, inc) x 6`. |
| `expand` | `function expand(items: readonly Item[]): Op[]` | The inverse of `encodeOps`: fresh, mutable ops (nested data of ops outside the frozen type is deep-copied). Throws `RangeError` on a count that is not a non-negative integer. |
| `itemsConsumed` | `function itemsConsumed(items: readonly Item[]): number` | Σ consumed of an encoded line, without expanding it. |
| `itemsProduced` | `function itemsProduced(items: readonly Item[]): number` | Σ produced of an encoded line: the count its text adds up to. |
| `itemsOpCount` | `function itemsOpCount(items: readonly Item[]): number` | The number of ops an encoded line expands to. |
| `StartKind` | `type StartKind = LineStart['k']` | |
| `START_EXEMPT` | `const START_EXEMPT: Readonly<Record<StartKind, boolean>>` | True for `mr`, `foundation`, `chainOval`, `chainRing`, `edge`; false for `turn`, `join`, `c2c`. Frozen. |
| `START_LINE_KINDS` | `const START_LINE_KINDS: Readonly<Record<StartKind, readonly Line['kind'][]>>` | The kinds of line each start can stand on (the list above). Frozen, arrays too. |
| `isConsumeExempt` | `function isConsumeExempt(line: Pick<Line, 'start'>): boolean` | `START_EXEMPT` of the start, plus a C2C start tagged `first`. Reads the start alone. |
| `startCapacity` | `function startCapacity(start: LineStart \| undefined): number \| null` | What a first line works into: `mr` n; `foundation` chains − firstInto + 1; `chainOval` 2·chains − 3; `chainRing` chains; else `null`. |
| `lineConsumed` | `function lineConsumed(line: Pick<Line, 'ops' \| 'start'>): number` | Σ consumed of a line, with the C2C rule above. |
| `lineProduced` | `function lineProduced(line: Pick<Line, 'ops'>): number` | Σ produced of a line: what `stated` must be. |
| `displayOps` | `function displayOps(line: Pick<Line, 'ops' \| 'colorHeader'>): readonly Op[]` | The ops as printed: `loop: 'both'` and the header's color left out (tiles untouched). Counts never change. Returns the line's own array when nothing had to go; never changes the line. |
| `CompactNames` | `interface CompactNames { sc; hdc; dc; slst; inc; inc3; dec; dec3; sc2tog; sc3tog: string }` | The words of the compact dialect (`sc2tog` / `sc3tog`: a decrease in a BLO/FLO round). |
| `US_COMPACT_NAMES` | `const US_COMPACT_NAMES: Readonly<CompactNames>` | `sc hdc dc "sl st" inc inc3 dec dec3 sc2tog sc3tog`. Frozen. |
| `TokenTextOptions` | `interface TokenTextOptions { names?: Readonly<CompactNames>; hideLoop?: boolean }` | `hideLoop`: leave out ` BLO` / ` FLO` (the line carries the loop as a prefix). |
| `tokenText` | `function tokenText(op: Op, o?: TokenTextOptions): string` | One op without a count: `sc`, `sl st`, `sc BLO`, `sc A`, `sc FLO B`, `sc2tog BLO`, `dc FLO 2 rows below`; a tile is its color (`A`). |
| `runText` | `function runText(op: Op, n: number, o?: TokenTextOptions): string` | `n` copies: `sc`, `4 sc`, `3 sc B`, `2 inc`; tiles always with a count (`1 A`). |

### `src/core/pattern/encode.ts`

| Export | Signature | What it does |
|---|---|---|
| `EncodeMode` | `type EncodeMode = 'ops' \| 'runs'` | One token per op (3D rounds) or per run of identical ops (2D rows). |
| `EXACT_MAX_TOKENS` | `const EXACT_MAX_TOKENS = 120` | Above it (per segment) the linear fallback is used. |
| `FALLBACK_MAX_PERIOD` | `const FALLBACK_MAX_PERIOD = 8` | Longest block, in runs, the fallback looks for. |
| `MEMO_CAPACITY` | `const MEMO_CAPACITY = 4096` | Entries in the LRU memo. |
| `MEMO_MAX_TOKENS` | `const MEMO_MAX_TOKENS = 1 << 20` | Token integers the memo holds in total; a longer line is not memoised. |
| `EncodeOptions` | `interface EncodeOptions { mode?: EncodeMode; segments?: readonly { readonly at: number }[]; exactMaxTokens?: number }` | `mode` defaults to `'ops'` (anything but `'runs'` is `'ops'`); `segments` is `Line.segments` (order does not matter; a repeated cut counts once; cuts at 0, at the end, outside the line, not whole, or malformed entries are ignored); `exactMaxTokens` overrides the 120 for tests and tuning. |
| `encodeOps` | `function encodeOps(ops: readonly Op[], o?: EncodeOptions): readonly Item[]` | The shortest encoding (§2.6.1). `expand(encodeOps(ops, o))` deep-equals `ops` for every `o`. Throws `TypeError` when an element is not an object, or holds data JSON cannot carry in a field outside the frozen type. |
| `expand`, `Item` | re-exported from `ops.ts` | |
| `encodeCost` | `function encodeCost(items: readonly Item[]): number` | The cost the encoder minimises: 1 per run, inner + 1 per repeat. |
| `canonicalCompact` | `function canonicalCompact(items: readonly Item[]): string` | The canonical compact text (`sc, (inc, 2 sc) x 5, inc, sl st`): US names, loop and color on every token. The text the encoder compares on ties. |
| `resetEncodeMemo` | `function resetEncodeMemo(): void` | Empties the memo and the token vocabulary (tests; it also happens by itself past 65 536 distinct ops). |
| `encodeMemoStats` | `function encodeMemoStats(): { size: number; tokens: number; hits: number; misses: number; vocabulary: number }` | Memo entries, token integers held, hits, misses, distinct ops seen. For tests and profiling. |

### `src/core/pattern/validateLine.ts`

| Export | Signature | What it does |
|---|---|---|
| `LineIssueCode` | `type LineIssueCode = 'E_SANITY' \| 'E_CONSUME' \| 'E_START' \| 'E_FOUNDATION' \| 'E_PRODUCE' \| 'E_INC_INFEASIBLE' \| 'E_DEC_INFEASIBLE' \| 'E_COLOR' \| 'E_ROUNDTRIP'` | The codes this module returns; all have severity `error`. |
| `ValidateLineOptions` | `interface ValidateLineOptions { prev?: Line \| null; palette?: Iterable<string>; piece?: string; docKind?: PatternDoc['kind'] }` | `prev` = the line worked just before (its `stated` must be this line's `prevCount`); `palette` turns `E_COLOR` on; `piece` goes into `where.piece`; `docKind` as in `compact.ts`. |
| `validateLine` | `function validateLine(line: Line, o?: ValidateLineOptions \| null): Issue[]` | The issues of one line, each frozen, `where.line` = the line's number `n`; `[]` = sound. When `E_SANITY` fires nothing else is checked. Never throws, whatever `line` is. |
| `validateLines` | `function validateLines(lines: readonly Line[], o?: Omit<ValidateLineOptions, 'prev'> \| null): Issue[]` | The lines of one whole piece in order, each against the one before, plus the shape of the piece (`E_START`). Issues in line order. |

### `src/core/pattern/compact.ts`

| Export | Signature | What it does |
|---|---|---|
| `CompactOptions` | `interface CompactOptions { docKind?: PatternDoc['kind']; names?: Partial<CompactNames> }` | See "2D or 3D style"; `names` is the hook for T2's UK table (a word left out, or not a string, stays US). |
| `renderCompactLine` | `function renderCompactLine(line: Line, o?: CompactOptions): string` | `label: body count`, then the line's `color` cues as ` · text`. |
| `compactLabel` | `function compactLabel(line: Line): string` | `Rnd 3`, `Rnd 9 (B)`, `Rnds 7–12 (6 rnds)`, `Row 11 (RS) ←`, `Row 5 (B, RS) ←`, `↗ Row 4 (WS) [inc beg · dec end]`, `↙ Row 1 (RS) [first tile]`. |
| `compactBody` | `function compactBody(line: Line, o?: CompactOptions): string` | How the line starts, its ops, how it ends (the table in the source). |
| `compactCount` | `function compactCount(line: Line, o?: CompactOptions): string` | `(18)` · `(40 sts)` · `(1 st)` · `(3 tiles)` · `(1 tile)`; prints `Line.stated`. |
| `compactFoundation` | `function compactFoundation(line: Line, o?: CompactOptions): string \| null` | The sentence before a line worked into chains: `Foundation: With A, ch 6.` · `Ch 10.` · `With C, ch 8.` · `…; join with sl st in first ch to form a ring (do not twist).`; `null` for other starts. |
| `compactItems` | `function compactItems(items: readonly Item[], o?: TokenTextOptions): string` | An encoded list as text, without the whole-line phrases. |
| `compactEncodeMode` | `function compactEncodeMode(line: Pick<Line, 'kind'>, o?: CompactOptions): EncodeMode` | `'runs'` in a '2d' pattern, `'ops'` in a '3d' one. |
| `lineItems` | `function lineItems(line: Pick<Line, 'kind' \| 'ops' \| 'segments' \| 'colorHeader'>, o?: CompactOptions): readonly Item[]` | The encoded form every renderer prints: `encodeOps(displayOps(line), { mode: compactEncodeMode(line, o), segments })`. T2's verbose renderers start from it, so every dialect shows the same repeats. |
| `sharedLoop` | `function sharedLoop(ops: readonly Op[]): 'BLO' \| 'FLO' \| undefined` | The loop every op shares (no mosaic long stitch among them), printed once as a prefix; `undefined` when mixed or empty. |
| `chainOvalSide` | `function chainOvalSide(shown: readonly Op[]): number \| null` | S of the canonical chain-oval Rnd 1 (`(S + 1) sc, inc3, S sc, inc`, both loops, no tag to print), or `null`. Pass `displayOps(line)`. |

Cues of kind `eyes`, `stuff`, `note` and `Line.notes` are whole sentences; the caller prints them on their own
lines after the line (§2.10.6). Border sentences (§2.7.10) and the mosaic row frame (§2.7.8) are T2's; the kernel
prints a border line as a plain list and gives T2 `compactItems` for the mosaic runs.

## Acceptance — what was tested and measured

`npm run typecheck` and `npm run lint` pass; `npm test` passes twice in a row (26 files, 529 tests, none skipped;
239 of them in `src/core/pattern`).

| Item | Result |
|---|---|
| **G4**: research 07 §7.6 vectors 1–12 and 15–18 | Pass, one test per vector (`validateLine.test.ts`); no vector was changed. 1, 2, 5, 11, 12 print as research 07 writes them (11 with `dec` for `invdec`); 3, 4, 9, 10 give the exact text the table states (`(sc, inc, sc) x 6`, `(sc, inc, 2 sc) x 3`, `(4 sc, dec) x 2, (3 sc, dec) x 5`, `sc, (sc, inc) x 7`); 16 gives `E_PRODUCE` (`18 ≠ 20`); 17 gives `E_CONSUME` (`12 ≠ 20`); 18 (10 → 25 with ten inc) gives `E_PRODUCE` and `E_INC_INFEASIBLE` (deviation 9). |
| `expand(encodeOps(ops))` deep-equals `ops` | Every vector in both token modes; 12 000 encodings of 6 000 seeded random and structured lines (lengths 0–499, both modes, a quarter with random segments, 600+ past the 120-token limit); 600 fallback-only encodings; 3 000 random lines through `validateLine` with no `E_ROUNDTRIP`; ops with unknown plain-JSON fields, nested data and `loop: 'both'`. |
| Optimal on small inputs | Equal cost to a brute-force search over every encoding for 2 500 lines of up to 12 tokens, in both modes; identical text and cost to a literal transcription of §2.6.1 for 4 000 lines of 1–14 tokens (op tokens) and 150 structured lines of 15–40 tokens (op and run tokens). |
| The standard sphere prints exactly | The 12 printed lines of §2.10.8 (17 rounds, `Rnds 7–12 (6 rnds)` folded) and the 13-round sphere of research 07 §6.6, generated from the counts with the placement rule of §2.10.8. The staggered `sc, inc, (2 sc, inc) x 5, sc` round-trips and prints `Rnd 4: (sc, inc, sc) x 6 (24)`. Also exact: the cylinder lines of §2.10.5, the G9 rows of §2.7.3 (RH and LH), both C2C goldens of §2.7.6, the tapestry-round templates of §2.7.5, the joined-round template of §2.11.3, the chain-oval sentence of §2.10.6. |
| The printed text is the line | 3 000 random rounds and rows (colors, header colors, loops, shared loops, segments, both pattern kinds) print a body that the tests' own parser reads back as exactly the ops as printed (20 000 in a one-off run: no difference). |
| `validateLine` fires / stays silent / honors exemptions | `E_CONSUME` and `E_PRODUCE` on crafted lines of every kind; silent on every golden line above, on the ch-10 oval (G8 lines), on C2C 100 × 60 (159 rows), on the G22 piece with its border rounds and on joined rounds inside a spiral piece; each of the six exemptions tested with and without a `prevCount`, and `E_PRODUCE` still applies to them. 200 000 random malformed lines in a one-off fuzz: nothing thrown, every issue frozen with severity `error`. |
| Encoder budgets (§5.8) | `encode.perf.test.ts` passes with the spec's bounds: ≤ 5 ms per line at 120 tokens (p90 and mean over 200 lines) and ≤ 2 s for 200 rows × 240 run tokens, plus a check that the search stays quadratic (1 000 tokens < 250 ms per line). Timing tests retry twice and have 60 s timeouts. Numbers below. |
| Determinism | The same lines give the same items and text in forward order, from the memo, in reverse order after a reset, and with a reset before every line (400 lines); the renderer likewise. |

Measured on this machine (Apple M-class, Node 22.23.3, `npx tsx` benches outside the test run, after warm-up; the
exact-search rows empty the memo before each line; load average 6–10 from other agents' test runs, so the maxima
are noisy):

| What | Budget | Measured |
|---|---|---|
| Exact search, 120 tokens, per line (9 shapes × 60 lines) | ≤ 5 ms | median 0.11 ms, p90 0.15–0.16 ms, max 0.33–0.41 ms (cold: max 1.3–1.5 ms) |
| 200 rows × 240 run tokens, fallback + memo (≈ 842 sts per row, every 4th row repeats an earlier one) | ≤ 2 s | 22–35 ms in total (the exact search on the same rows: 50 ms) |
| Exact search at 240 / 500 / 1 000 / 4 000 tokens (not required) | — | median 0.33 / 1.27 / 4.8 / 78 ms; p90 0.45 / 1.59 / 5.7 / 93–99 ms |
| `validateLine` + `renderCompactLine`, chart 200 × 200 | — | 17–27 ms + 6–8 ms |
| the same, chart 1 000 × 1 000 (1 M stitches, mean run 5 / 1.2) | — | 0.30–0.31 s + 0.11 s / 0.45–0.47 s + 0.25–0.27 s |

## Deviations from the spec, with reasons

1. **The exact search is a DP over suffixes, O(n²), not the interval DP of §2.6.1 (O(n³)–O(n⁴)).** The result is
   the one the definition gives; only the way to reach it differs. Why it is the same: an optimal encoding is a
   list of items, and each item is the best encoding of the tokens it covers (all four criteria of `better` add up
   over a list, and texts of equal length compare part by part); a single item is a run or a repeat, and of all
   periods that divide a length only the smallest can win (a longer period's inner part contains the shorter one
   at least twice, so it costs strictly more; by Fine–Wilf every period that divides the length is a multiple of
   the smallest one); inside a repeat nothing may be bracketed, so the best inner part is its run-length form.
   `encode.test.ts` checks it against a literal transcription of the spec's recursion (identical text) and
   against a brute-force search over every encoding (identical cost); numbers above. What §2.6.1 lists as
   normative for performance is kept: three `Int32Array` scores with back-pointers, one KMP failure function per
   start index, text compared only on a full tie, the two short-circuits.
2. **The 120-token limit is kept, although its reason is gone.** The exact search takes about 0.1 ms at 120 tokens
   and 1.3 ms at 500 (above). Above 120 tokens the fallback is used, as §2.6.1 says, and it can print a longer
   line than the exact search would (150 tokens of `(2 sc, inc, 2 sc) x 30` print as `2 sc, (inc, 4 sc) x 29,
   inc, 2 sc`). `EncodeOptions.exactMaxTokens` overrides it; request 1. With segments the limit applies per
   segment.
3. **`Item` has `readonly` fields and `encodeOps` returns `readonly Item[]`.** Results are frozen and shared
   through the memo; the spec's `Item` is written without `readonly`. `expand` returns fresh, mutable ops.
4. **Memo.** The key is `fnv1a64(token ints ‖ tag)`, where the tag holds the token mode and whether the exact
   search or the fallback ran (the same tokens give different results in each). An entry keeps its token array,
   and a hit is accepted only when the arrays are equal, so a hash collision costs a recomputation and can never
   return another line's encoding. Besides the 4 096 entries, the memo holds at most `MEMO_MAX_TOKENS` (1 048 576)
   token integers, so long lines cannot pin megabytes in a worker. A single-token or uniform line is answered
   before the memo.
5. **Runs of inc print as `N inc`, not `inc in next N sts`.** §2.10.11 defines `N op` for every op, and research
   07 §7.5 and vector 5 write `6 inc`; research 07 §6.9 spells the oval's Rnd 2 as `inc, 7 sc, inc in next 3 sts,
   7 sc, inc in next 2 sts`. The kernel prints `Rnd 2: inc, 7 sc, 3 inc, 7 sc, 2 inc (26)`. T4's G8 will see
   this (request 3).
6. **Vectors whose expectation is "ok" do not all print as their body.** The encoder prints the shortest form, as
   §2.10.5 says of the cylinder's Rnd 4. Vector 6 `sc, (inc, sc) x 2, (sc, inc) x 5` → `(sc, inc) x 2, sc, (sc,
   inc) x 5` (same cost 7; `(` sorts first). Vector 7 (cost 13 as written) → `(sc, inc, sc) x 2, inc, 3 sc, (inc,
   2 sc) x 3, sc, inc, sc` (cost 12). Vector 8 (cost 13) → `(2 sc, inc, 3 sc, inc, 3 sc, inc) x 2, (2 sc, inc) x
   2, sc` (cost 11). Vector 15 and the flat-bottom Rnd 6 of research 07 §6.8 (cost 8) → `2 sc, (inc, 4 sc) x 5,
   inc, sc, sl st` (cost 7). All of them validate and round-trip, which is what the vectors ask.
7. **A BLO round prints as `BLO sc in each st around`** (§2.10.5 golden), not `sc in BLO of each st around`
   (research 07 §6.8), and a run in a mixed line as `N sc BLO` (§2.7.8, research 07 §7.5).
8. **`validateLine` checks more than the brief's kernel rules, including the single-line parts of two rules §2.13
   gives T4 and T2.** A line that starts a piece is exempt from `E_CONSUME`, so without these checks its ops would
   never be compared with its start, and a mismatch prints wrong text (`Ch 10.` then `sc in next 6 ch`). So:
   `E_START` when a magic ring of n does not hold n stitches (or holds an inc/dec), when the ops on ch N of an oval
   do not use its 2N − 3 loops, or when a chain ring's round does not use its N chains; `E_FOUNDATION` when row 1
   does not use `chains − firstInto + 1` chains; and in `validateLines`, `E_START` for a piece that starts from
   nothing or starts again in the middle. The rest of those rules (the sizes 5–8 / 6 / 2S + 6, the joint, the pole
   rule; `W + h_tc − c` per technique) stays with T4 and T2; the same codes are used because §2.13 gives each rule
   exactly one. Also: `E_SANITY` for every malformed field of the frozen `Line` (so nothing throws and no rule
   computes on garbage), including a start on a kind of line it cannot stand on and a count of 20 000 or more
   (R15: < 20 000 sts per piece, so per line too); `E_COLOR` when a palette is passed; `E_INC_INFEASIBLE` /
   `E_DEC_INFEASIBLE` also when even `inc3` / `dec3` cannot reach the count (T > 3P, T < P/3); `E_CONSUME` for a
   line that needs a previous count and has none, for a `prevCount` that is not the stated count of the line before,
   and for a folded line that changes the count (research 07 §6.3). `W_FAN3` is left to T4: an `inc3` is normal in
   a border corner and in a chain oval's first round, so only the generator knows when it was forced. Request 5.
9. **Vector 18 reports `E_PRODUCE` with `E_INC_INFEASIBLE`.** The vector names only `E_INC_INFEASIBLE`, but it
   gives no ops: any line of inc(2) and sc that goes from 10 to a stated 25 either consumes ≠ 10 (`E_CONSUME`) or
   makes ≤ 20 ≠ 25 (`E_PRODUCE`), so the infeasibility never comes alone; it says why the count error cannot be
   repaired by moving increases. The test asserts exactly `['E_PRODUCE', 'E_INC_INFEASIBLE']`.
10. **`E_ROUNDTRIP` checks the ops as printed.** `expand(encodeOps(ops))` deep-equals `ops` for every input, as
    R10 says (tested on the encoder itself). The renderer encodes `displayOps(line)` — no `loop: 'both'`, no
    header color, both of which print as nothing — so that ops that print alike fold together; `E_ROUNDTRIP`
    therefore compares `expand(lineItems(line))` with `displayOps(line)`, plus the printed count.

## Ambiguities resolved

| Where | Reading |
|---|---|
| §2.6.1 "canonical compact string" | US names, the count rule of the Compact dialect, and the loop and the color on every token (`2 sc BLO A`) of the ops as encoded. The renderer encodes the ops as printed, so the header color and `loop: 'both'` never sway a tie; UK names and the loop prefix do not either. |
| §2.6.1 token keys "with loop and color in the key" | In `encodeOps`, two ops are the same token exactly when they are deep-equal (a field set to `undefined` counts as absent); `loop: 'both'` and no `loop` are different tokens, so `expand` returns every op as it was given. The renderer folds them through `displayOps`. |
| §2.6.1 segments, "encoded separately and joined" | Joined = concatenated: no repeat and no run crosses a boundary (`7 sc, sc, (2 sc, inc) x 2` keeps the 7-st side visible — G8's "segment-preserving text"). The one exception is the uniform-line short-circuit: a line of one op is one run whatever its segments, so the post-rule `sc in each st around` applies to plain oval rounds. Request 11. |
| §2.6.1 run tokens | In `'runs'` mode a repeat is made of whole runs: `sc A, 2 sc B, 2 sc A, 2 sc B, sc A` stays as it is, while `'ops'` mode gives `(sc A, 2 sc B, sc A) x 2`. |
| §2.6.1 fallback, "block of p ≤ 8 runs" | p from 2 to 8 (one run cannot repeat next to itself); covered length counted in runs. |
| §2.6.1 "nested groups" (brief) | One bracket level only (§2.6.1, research 07 §7.4 post-rule 4): runs inside a repeat, never a repeat inside a repeat. `expand` still accepts nested repeats. |
| §2.6.1 post-rules, whole-line phrases | Applied when the encoded line is one run of one op with no color tag to print: `sc / hdc / inc / inc3 / sl st in each st around`, `dec around`, `dec3 around`, `BLO sc2tog around`; `across` for rows; `in each ch` on a line worked into chains. A one-color row of a chart prints `40 sc A`. |
| §2.10.11 color header | One parenthesis, tags in the order color, side, fold size: `Rnds 10–12 (B, 3 rnds)`, `Row 5 (B, RS) ←` (§2.7.8). Ops in the header's color print untagged. |
| §2.10.11 "change to B on the last yo" | A `color` cue; it prints after the count like `· carry B` in §2.7.2: `Rnd 8: sc in each st around (36) · change to B on the last yo`. |
| §2.11.3 "sc in same st as join, {ops of the rest of the round}" | The first op is printed in that phrase and the rest is encoded on its own: `Ch 1 (does not count), sc in same st as join, 35 sc; join …`. A first op that is not a plain sc prints its name (`inc in same st as join`). |
| §2.7.3 / §2.7.7 turning chain | `Ch 1, turn.` for one chain; `Ch N (does not count as a st), turn.` for more. |
| §2.10.4 chain ring in a spiral piece (torus) | `Ch 24; join with sl st in first ch to form a ring (do not twist).` then `Rnd 1: sc in each ch around (24)`, with no ch 1 (spiral). Rnd 1 is worked into each chain. |
| §2.7.3 Foundation line | A separate string from `compactFoundation`, built from the first line of the piece: the caller prints it on its own line (2D) or in front of the round (`Ch 10. Rnd 1: …`, §2.10.6). |
| Counts | `(1 st)`, `(1 tile)` in the singular (§2.7.6 prints `(1 tile)`). |
| `Issue.where.line` | The line's number `n` (round or row number), not its index in `Piece.lines`. |
| `E_ROUNDTRIP` "printed count = Σ produced" | The printed count is `Line.stated`, so a wrong stated count is `E_PRODUCE` alone; `E_ROUNDTRIP` fires only when the encoded form does not expand back to the ops as printed, adds up to another count, the encoder throws, or the renderer prints another number than the ops make. |
| `E_SANITY` scope | Line level: the frozen `Line` shape (every field's type and range, ops of the frozen `Op` type, a start with possible numbers on a kind of line it can begin, C2C rows of tiles with their tag), whole numbers ≥ 1, counts < 20 000. The per-piece and per-chart limits (200 rounds, 20 000 sts per piece, 1 000 cells per side) need the piece or the chart (T2, T4). |
| `nEnd = n` | A plain line (`Rnd 3`), as the renderer prints it; `nEnd < n` is `E_SANITY`. |
| Empty oval segments | Allowed: two segments with the same `at`, or one at `ops.length`. A segment list out of order, outside the line, or with a kind other than `side` / `end` is `E_SANITY`. |
| C2C `first` | Row 1 is tagged `first` at both ends and no other row is; a mix (`first` at one end only) is `E_SANITY`. |
| What `validateLines` gets | One whole piece (`Piece.lines`). An excerpt is checked with `validateLine` and `prev`. |

## Handover note

`47ca4e0` was reviewed independently. By the previous agent's last report, the encoder held up against three
independent oracles (66 000+ lines, no mismatch) and the reviewer found problems in the renderer and the validator. The previous agent was interrupted
while fixing them and the reviewer's list was lost; the fixes in `5d3e6d9` were finished from its in-progress edits
and checked against the spec one by one. Kept as edited: everything in the commit message of `5d3e6d9`. Changed:
`isConsumeExempt` reads the start alone again (the kind check it had gained is `E_SANITY` now, through
`START_LINE_KINDS`). No `zz-review*` test files were left in the worktree. `47ca4e0` carries the trailer
`Co-Authored-By: Claude Fable 5.1` instead of the one `common.md` asks for; the history was not rewritten.

## Requests for integration

1. **§2.6.1, D8, §5.8 — raise the 120-token limit to 500.** It exists because the exact DP was O(n³)–O(n⁴) (1.15 s
   at 240 tokens). The search here is O(n²): median 0.11 ms at 120 tokens, 0.33 ms at 240, 1.3 ms at 500 (p90
   1.6 ms), 4.8 ms at 1 000 (p90 5.7 ms, over the 5 ms budget). With `EXACT_MAX_TOKENS = 500` every realistic round
   and most chart rows (in run tokens) get the exact result well inside the budget; the fallback remains for
   longer lines. A one-line change plus the tests that pin 120/121; lines of 121–500 tokens could then print
   shorter text (bump `CODE_VERSION`). Until the spec says so the kernel keeps 120.
2. **§5.2.1 `renderLine` cannot tell a 2D round from a 3D round.** `Line.kind: 'rnd'` is a tapestry round (§2.7.5:
   `({C} sts)`, `Ch 1, {runs}; join …`, run tokens) and an amigurumi round (§2.10.11: `(n)`, the template of
   §2.11.3, op tokens); a flat row inside an amigurumi pattern (§2.10.9) has the mirror problem. The kernel takes
   `docKind`. Either add `docKind?: '2d' | '3d'` to the options of `RenderLineFn` (additive; `PatternView` knows
   `doc.kind`), or give `Line` an optional field. Without it T2's `renderLine` has to guess from the ops.
3. **G8 text.** Research 07 §6.9 writes the oval's Rnd 2 as `inc, 7 sc, inc in next 3 sts, 7 sc, inc in next 2
   sts`; §2.10.11 (`N op`), research 07 §7.5 (`N inc`) and vector 5 (`6 inc`) give `inc, 7 sc, 3 inc, 7 sc, 2 inc`,
   which is what the kernel prints. Pick one. The long form would be a change in `runText` (ops.ts), and it also
   changes the text length the encoder compares on ties.
4. **§2.10.11 Notes block** defines only `N sc`. With `3 inc` and `2 dec` in the text it should define `N op` for
   every op, as research 07 §6.4 does ("`2 inc` means inc in each of the next 2 sts").
5. **§2.13 — say what the kernel checks.** (a) `E_CONSUME`: every line that does not start a piece carries
   `prevCount`; a C2C row consumes `tiles − [inc beg] + [dec end]` ch-3 spaces; a folded line must leave the
   count unchanged. (b) `E_START` / `E_FOUNDATION`: the kernel reports the single-line part (a first line that does
   not fit its start; a piece without a start or with a second one) and T4 / T2 add the rest; they should not
   report the same mismatch again. (c) `E_SANITY`: the line-level shape checks listed above.
6. **§2.13 `E_FOLD` has no owner.** The kernel prints a folded `Line` and checks only that it is count-neutral.
   Say that the track that folds checks `E_FOLD` on the lines it merges (T2: rows and tapestry rounds; T4:
   amigurumi rounds), and that a fold of turned rows (both sides) carries no `side` or `arrow` — or ask for a shared
   `foldLines` in the kernel.
7. **§2.6.1 `Item`:** write the type with `readonly` fields and say that encoder results are frozen and shared.
8. **§2.6.1 / research 07 §7.6:** say that vectors 5–8, 11 and 15 are validation vectors, not expected printouts
   (the encoder prints a shorter or tie-broken form for 6, 7, 8 and 15; deviation 6), so nobody "repairs" the
   encoder to print research 07 §6.8's flat-bottom Rnd 6; and that vector 18 comes with `E_PRODUCE` (deviation 9).
9. **`src/types/issues.ts`:** `Issue.code` is `string`. An exported union of the codes of §2.13 next to it
   (additive) would catch a mistyped code at compile time in every track; the kernel has its own
   `LineIssueCode` for now.
10. **0c:** if these signatures are to be frozen like §5.2.1's, add `encodeOps`, `expand`, `lineItems`,
    `validateLine`, `validateLines` and `renderCompactLine` to `src/types/__checks__/entryPoints.check.ts`.
    `CODE_VERSION` needs no bump for this branch (the modules are new); it does when requests 1 or 3 change what
    is printed.
11. **§2.6.1 segments — confirm "joined" means concatenated.** The kernel never merges runs across a segment
    boundary, so a side of 7 sc next to an end that starts with sc prints `7 sc, sc, (2 sc, inc) x 2`. If the spec
    prefers `8 sc, (2 sc, inc) x 2` (natural, but the side no longer reads 7), it is a few lines in `encodeOps`
    (the loop that joins the segments) plus its tests.
12. **§5.2 `Op.loop`:** say that `'both'` is the default and generators leave it out. The kernel prints the two
    alike, but `encodeOps` keeps them apart so that `expand` gives back exactly what it was given.
13. **Additive `Op` amendments (§6.1 rule 7):** `isOp` refuses a field the kernel does not know, so a new optional
    field on `Op` must come with the kernel change that prints it (or every line using it is `E_SANITY`, which
    blocks export).
