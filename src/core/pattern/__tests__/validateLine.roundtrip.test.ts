// E_ROUNDTRIP guards the encoder and the renderer, so it can only be seen firing when one of them is broken.
// This file breaks them on purpose (module mocks); validateLine.test.ts shows that the real ones never trip it.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Line } from '../../../types';
import * as compact from '../compact';
import * as encode from '../encode';
import type { Item } from '../ops';
import { validateLine } from '../validateLine';
import { colored, inc, parseBody, rnd, sc, times } from './helpers';

vi.mock('../encode', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../encode')>();
  return { ...actual, encodeOps: vi.fn(actual.encodeOps) };
});
vi.mock('../compact', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../compact')>();
  return { ...actual, compactCount: vi.fn(actual.compactCount) };
});

const encodeOps = vi.mocked(encode.encodeOps);
const compactCount = vi.mocked(compact.compactCount);
const line: Line = rnd(3, parseBody('(sc, inc) x 6'), 12);

beforeEach(async () => {
  const realEncode = await vi.importActual<typeof import('../encode')>('../encode');
  const realCompact = await vi.importActual<typeof import('../compact')>('../compact');
  encodeOps.mockReset().mockImplementation(realEncode.encodeOps);
  compactCount.mockReset().mockImplementation(realCompact.compactCount);
});

describe('E_ROUNDTRIP (§2.13 R10)', () => {
  it('is silent with the real encoder and renderer', () => {
    expect(validateLine(line)).toEqual([]);
    expect(encodeOps).toHaveBeenCalledTimes(1);
  });

  it('fires when the encoded form loses a stitch', () => {
    const lossy: Item[] = [{ kind: 'rep', times: 5, inner: [{ kind: 'run', op: sc, n: 1 }, { kind: 'run', op: inc, n: 1 }] }];
    encodeOps.mockReturnValue(lossy);
    const issues = validateLine(line);
    expect(issues.map((issue) => issue.code)).toEqual(['E_ROUNDTRIP']);
    expect(issues[0]).toMatchObject({ severity: 'error', message: 'Rnd 3: its encoded form does not expand back to its ops', where: { line: 3 } });
    expect(Object.isFrozen(issues[0])).toBe(true);
  });

  it('fires when the encoded form puts the ops in another order, with the same counts', () => {
    encodeOps.mockReturnValue([{ kind: 'rep', times: 6, inner: [{ kind: 'run', op: inc, n: 1 }, { kind: 'run', op: sc, n: 1 }] }]);
    expect(validateLine(line).map((issue) => issue.code)).toEqual(['E_ROUNDTRIP']);
  });

  it('fires when the encoded form merges two colors into one run', () => {
    const striped = rnd(5, [...times(3, colored(sc, 'A')), ...times(3, colored(sc, 'B'))], 6);
    expect(validateLine(striped)).toEqual([]);
    encodeOps.mockReturnValue([{ kind: 'run', op: colored(sc, 'A'), n: 6 }]);
    expect(validateLine(striped).map((issue) => issue.code)).toEqual(['E_ROUNDTRIP']);
  });

  it('fires when a loop is lost', () => {
    const blo = rnd(5, times(6, { k: 'st', st: 'sc', loop: 'BLO' }), 6);
    encodeOps.mockReturnValue([{ kind: 'run', op: sc, n: 6 }]);
    expect(validateLine(blo).map((issue) => issue.code)).toEqual(['E_ROUNDTRIP']);
  });

  it('checks the ops as printed: loop "both" and the header color print as nothing, so they are not lost', () => {
    encodeOps.mockReturnValue([{ kind: 'run', op: sc, n: 6 }]);
    expect(validateLine(rnd(5, times(6, { k: 'st', st: 'sc', loop: 'both' }), 6))).toEqual([]);
    expect(validateLine(rnd(5, times(6, colored(sc, 'B')), 6, { colorHeader: 'B' }))).toEqual([]);
    // Without the header the color must be printed, so dropping it is a loss.
    expect(validateLine(rnd(5, times(6, colored(sc, 'B')), 6)).map((issue) => issue.code)).toEqual(['E_ROUNDTRIP']);
    expect(encodeOps).toHaveBeenLastCalledWith(times(6, colored(sc, 'B')), { mode: 'ops', segments: undefined });
  });

  it('fires, and does not throw, when the encoder throws', () => {
    encodeOps.mockImplementation(() => {
      throw new TypeError('broken encoder');
    });
    const issues = validateLine(line);
    expect(issues.map((issue) => issue.code)).toEqual(['E_ROUNDTRIP']);
    expect(issues[0].message).toBe('Rnd 3: its ops could not be encoded: broken encoder');
  });

  it('fires when the printed count is not what the ops make', () => {
    compactCount.mockReturnValue('(17)');
    const issues = validateLine(line);
    expect(issues.map((issue) => issue.code)).toEqual(['E_ROUNDTRIP']);
    expect(issues[0].message).toBe('Rnd 3: the printed count (17) is not the 18 its ops make');
    compactCount.mockReturnValue('(many)');
    expect(validateLine(line).map((issue) => issue.code)).toEqual(['E_ROUNDTRIP']);
  });

  it('leaves a wrong stated count to E_PRODUCE alone', () => {
    expect(validateLine({ ...line, stated: 20 }).map((issue) => issue.code)).toEqual(['E_PRODUCE']);
  });
});
