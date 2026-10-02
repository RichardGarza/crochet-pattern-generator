// Track T7 — return-path matching (DESIGN.md §3.7.7; §6.3 T7 acceptance "return-path matching (tag, ≥ 60% ids, 59%
// rejected, single waiting project offered unselected)").
import { describe, expect, it } from 'vitest';
import type { ImportResult } from '../../../types/importer';
import type { CrochetModelV1, Part } from '../../../types/model';
import { matchReturnProject, RETURN_SEED_SHARE, seedShare, type ReturnCandidate } from '../returnPath';

const NOW = new Date('2026-10-01T12:00:00Z');

function modelWith(ids: string[]): CrochetModelV1 {
  const parts = ids.map((id, i): Part => ({ id, type: 'sphere', dims: { r: 1 }, position: [0, 1 + i, 0], color: 'c1' }));
  return {
    schema: 'crochet-model',
    version: '1.0',
    revision: 1,
    units: 'in',
    axes: { up: '+Y', front: '+Z', left: '+X' },
    name: 'x',
    finishedSize: { height: 10 },
    palette: [{ id: 'c1', hex: '#aa8866' }],
    parts,
  };
}

const result = (ids: string[], tag?: ImportResult['cpgTag']): Pick<ImportResult, 'ok' | 'model' | 'cpgTag'> => ({ ok: true, model: modelWith(ids), ...(tag ? { cpgTag: tag } : {}) });

const ids = (n: number, prefix = 'p'): string[] => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

const cand = (id: string, more: Partial<ReturnCandidate> = {}): ReturnCandidate => ({ id, name: `Project ${id}`, updatedAt: '2026-09-30T00:00:00Z', awaiting: false, ...more });

describe('matchReturnProject (§3.7.7)', () => {
  it('1. x-cpg naming a project of the library ⇒ that project, pre-selected', () => {
    const offer = matchReturnProject(result(['body'], { project: 'b', seedRev: 3 }), [cand('a', { awaiting: true }), cand('b')], { now: NOW });
    expect(offer).toEqual({ id: 'b', name: 'Project b', reason: 'tag', preselected: true });
  });

  it('a tag naming no project of the library falls through to the other rules', () => {
    const offer = matchReturnProject(result(['body'], { project: 'gone', seedRev: 3 }), [cand('a', { awaiting: true })], { now: NOW });
    expect(offer).toEqual({ id: 'a', name: 'Project a', reason: 'only-waiting', preselected: false });
  });

  it('the tag wins over a seed match', () => {
    const seed = ids(10);
    const offer = matchReturnProject(result(seed, { project: 'b', seedRev: 0 }), [cand('a', { awaiting: true, seedPartIds: seed }), cand('b')], { now: NOW });
    expect(offer?.id).toBe('b');
  });

  it('2. ≥ 60% of a waiting project\'s seed ids ⇒ offered pre-selected; 60% exactly qualifies', () => {
    const seed = ids(10);
    const offer = matchReturnProject(result([...seed.slice(0, 6), 'extra_1', 'extra_2']), [cand('a', { awaiting: true, seedPartIds: seed })], { now: NOW });
    expect(offer).toEqual({ id: 'a', name: 'Project a', reason: 'seed-ids', preselected: true, share: 0.6 });
  });

  it('59% does not qualify (then the single waiting project is offered, unselected)', () => {
    const seed = ids(100);
    const offer = matchReturnProject(result(seed.slice(0, 59)), [cand('a', { awaiting: true, seedPartIds: seed })], { now: NOW });
    expect(offer).toEqual({ id: 'a', name: 'Project a', reason: 'only-waiting', preselected: false });
    expect(seedShare(seed, new Set(seed.slice(0, 59)))).toBeLessThan(RETURN_SEED_SHARE);
  });

  it('59% on a project that does not wait: nothing offered', () => {
    const seed = ids(100);
    expect(matchReturnProject(result(seed.slice(0, 59)), [cand('a', { generatedAt: '2026-09-29T00:00:00Z', seedPartIds: seed })], { now: NOW })).toBeNull();
  });

  it('a prompt produced in the last 30 days counts without waiting; an older one does not', () => {
    const seed = ids(5);
    expect(matchReturnProject(result(seed), [cand('a', { generatedAt: '2026-09-02T12:00:01Z', seedPartIds: seed })], { now: NOW })?.reason).toBe('seed-ids');
    expect(matchReturnProject(result(seed), [cand('a', { generatedAt: '2026-08-31T12:00:00Z', seedPartIds: seed })], { now: NOW })).toBeNull();
  });

  it('several seed matches: the highest share, then the most recent', () => {
    const seed = ids(10);
    const older = cand('old', { awaiting: true, generatedAt: '2026-09-20T00:00:00Z', seedPartIds: seed });
    const newer = cand('new', { awaiting: true, generatedAt: '2026-09-28T00:00:00Z', seedPartIds: seed });
    expect(matchReturnProject(result(seed), [older, newer], { now: NOW })?.id).toBe('new');
    const better = cand('best', { awaiting: true, generatedAt: '2026-09-01T00:00:00Z', seedPartIds: seed.slice(0, 7) });
    expect(matchReturnProject(result(seed.slice(0, 7)), [newer, better], { now: NOW })?.id).toBe('best');
  });

  it('3. exactly one waiting project ⇒ offered unselected; two waiting ⇒ none', () => {
    expect(matchReturnProject(result(['body']), [cand('a', { awaiting: true }), cand('b')], { now: NOW })).toEqual({ id: 'a', name: 'Project a', reason: 'only-waiting', preselected: false });
    expect(matchReturnProject(result(['body']), [cand('a', { awaiting: true }), cand('b', { awaiting: true })], { now: NOW })).toBeNull();
  });

  it('the project the import runs in is never offered', () => {
    expect(matchReturnProject(result(['body'], { project: 'here', seedRev: 0 }), [cand('here', { awaiting: true })], { now: NOW, exclude: 'here' })).toBeNull();
  });

  it('a failed result offers nothing; an empty seed never matches', () => {
    expect(matchReturnProject({ ok: false }, [cand('a', { awaiting: true })], { now: NOW })).toBeNull();
    expect(matchReturnProject(result(['body']), [cand('a', { awaiting: true, seedPartIds: [] }), cand('b', { awaiting: true })], { now: NOW })).toBeNull();
    expect(seedShare([], new Set(['a']))).toBe(0);
  });

  it('duplicate seed ids count once; bad dates never throw', () => {
    expect(seedShare(['a', 'a', 'b'], new Set(['a']))).toBe(0.5);
    expect(matchReturnProject(result(['a']), [cand('x', { awaiting: true, updatedAt: 'nope', generatedAt: 'nope', seedPartIds: ['a'] })], { now: NOW })?.reason).toBe('seed-ids');
  });
});
