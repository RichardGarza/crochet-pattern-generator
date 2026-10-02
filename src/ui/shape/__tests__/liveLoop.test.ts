// Track T6.3 — the live pattern loop (DESIGN.md §4.3) and how the editor reads an AmiResult (§2.10.10): requests go
// through the latest-wins channel, at most one per 300 ms while edits keep coming and always the last state; only
// dirty parts regenerate; NotImplementedError (T4 not merged) stops the loop; authored paint survives every
// regeneration; rings, ghost, toy ghost size, badges and the ring ↔ line link from a fixture result.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NotImplementedError } from '../../../core/stub';
import { createDerivedStore, type DerivedStore } from '../../../state/derivedStore';
import { createProjectStore, type ProjectStore } from '../../../state/projectStore';
import { addRegion, editModel, movePart, NO_LABEL, setPartPaint } from '../../../state/slices/model3d';
import { byId, openTeddy, teddy } from '../../../state/slices/__tests__/teddyProject';
import type { AmiRequest, AmiResult } from '../../../types/ami';
import { createLatestWinsGroup, Superseded } from '../../../workers/rpc';
import {
  ghostRings,
  GHOST_STRIDE,
  lineRefForRing,
  partStatuses,
  ringColors,
  ringPoints,
  ringsBounds,
  ringsForLineRef,
  ringsOf,
  roundsOf,
  toyGhostBounds,
  toyGhostHeight,
} from '../amiView';
import { amiInputs, dirtyParts, loopStatus, startLiveLoop, type LiveLoop } from '../liveLoop';
import { amiFixture } from './amiFixture';
import { modelHeight } from '../../../core/model/transforms';

type Req = Omit<AmiRequest, 'jobId'>;

let project: ProjectStore;
let derived: DerivedStore;
let loop: LiveLoop | null = null;

beforeEach(() => {
  project = createProjectStore();
  derived = createDerivedStore();
  openTeddy(project);
});

afterEach(() => {
  loop?.stop();
  loop = null;
  vi.useRealTimers();
  project.getState().close({ discardUnsaved: true });
});

const model = () => project.getState().doc!.threeD!.model!;

/** A fake AmiApi behind a real latest-wins group (the client's channel): answers with the fixture. */
function fakeAmi(o: { delayMs?: number; fail?: Error } = {}) {
  const requests: Req[] = [];
  const superseded: number[] = [];
  const group = createLatestWinsGroup(async (jobId) => {
    superseded.push(jobId);
  });
  const generate = group.channel<AmiRequest, AmiResult>(async (r) => {
    requests.push(r);
    if (o.delayMs) await new Promise((res) => setTimeout(res, o.delayMs));
    if (o.fail) throw o.fail;
    return amiFixture(r.model, { jobId: r.jobId });
  });
  return { generate, requests, superseded };
}

describe('amiInputs / dirtyParts', () => {
  it('hashes the model, gauge and settings; a part hash covers the part and its parent', () => {
    const a = amiInputs(project.getState().doc)!;
    expect(a.request.model).toBe(model());
    expect(a.request.gauge.cell.w).toBeGreaterThan(0);
    expect(a.request.settings).toBe(project.getState().doc!.threeD!.ami);
    expect(Object.keys(a.partHashes)).toHaveLength(model().parts.length);
    // Moving the head alone changes the head and its children's hashes (their parent changed), nothing else.
    editModel('Move head', (m) => movePart(m, 'head', [0, 0.2, 0], 'alone'), { store: project, linked: false });
    const b = amiInputs(project.getState().doc)!;
    expect(b.hash).not.toBe(a.hash);
    const dirty = dirtyParts(a.partHashes, b.partHashes)!.sort();
    expect(dirty).toEqual(['ear_l', 'ear_r', 'eye_l', 'eye_r', 'head', 'muzzle'].sort());
    expect(dirtyParts(null, b.partHashes)).toBeUndefined();
    // The gauge changes every part.
    project.getState().update('CYC 3', (d) => {
      d.gauge.cyc = 3;
    });
    const c = amiInputs(project.getState().doc)!;
    expect(dirtyParts(b.partHashes, c.partHashes)).toHaveLength(model().parts.length);
  });

  it('null without a model', () => {
    openTeddy(project, { model: null });
    expect(amiInputs(project.getState().doc)).toBeNull();
  });
});

describe('the live loop', () => {
  it('sends at once, stores the result under its input hash, and asks only for dirty parts next time', async () => {
    const ami = fakeAmi();
    loop = startLiveLoop({ project, derived, ami });
    await vi.waitFor(() => expect(derived.getState().ami).not.toBeNull());
    expect(ami.requests).toHaveLength(1);
    expect(ami.requests[0].dirtyParts).toBeUndefined();
    const hash = amiInputs(project.getState().doc)!.hash;
    expect(derived.getState().ami!.inputHash).toBe(hash);
    expect(loopStatus(derived.getState(), hash)).toEqual({ kind: 'ready', fresh: true });

    editModel('Paint', (m) => setPartPaint(m, 'tail', new Uint8Array(4096).fill(1)), { store: project });
    loop.flush();
    await vi.waitFor(() => expect(ami.requests).toHaveLength(2));
    expect(ami.requests[1].dirtyParts).toEqual(['tail']);
  });

  it('throttles to one request per 300 ms during a drag and always sends the last state', async () => {
    vi.useFakeTimers();
    let t = 0;
    const ami = fakeAmi();
    loop = startLiveLoop({ project, derived, ami, now: () => t });
    expect(loop.sent).toBe(1);
    // 30 drag updates over 600 ms (every 20 ms).
    for (let i = 1; i <= 30; i++) {
      t = i * 20;
      editModel('Drag', (m) => movePart(m, 'tail', [0.01, 0, 0], 'alone'), { store: project, coalesceKey: 'drag' });
      await vi.advanceTimersByTimeAsync(20);
    }
    t = 2000;
    await vi.advanceTimersByTimeAsync(1000);
    // t = 0 (start), 300, 600 and the trailing one: never more than one per 300 ms.
    expect(loop.sent).toBeGreaterThanOrEqual(3);
    expect(loop.sent).toBeLessThanOrEqual(4);
    const last = ami.requests.at(-1)!;
    expect(byId(last.model).tail.position).toEqual(byId(model()).tail.position);
  });

  it('a slower, superseded request never overwrites the newer result (latest wins)', async () => {
    const ami = fakeAmi({ delayMs: 30 });
    loop = startLiveLoop({ project, derived, ami, throttleMs: 0 });
    editModel('Move', (m) => movePart(m, 'tail', [0.5, 0, 0], 'alone'), { store: project });
    loop.flush();
    const want = amiInputs(project.getState().doc)!.hash;
    await vi.waitFor(() => expect(derived.getState().ami?.inputHash).toBe(want), { timeout: 2000 });
    expect(ami.superseded.length).toBeGreaterThanOrEqual(1);
    await new Promise((r) => setTimeout(r, 80));
    expect(derived.getState().ami?.inputHash).toBe(want);
  });

  it('stops asking when the engine is not implemented yet (T4), and says so', async () => {
    const ami = fakeAmi({ fail: new NotImplementedError('generateAmigurumi') });
    loop = startLiveLoop({ project, derived, ami, throttleMs: 0 });
    await vi.waitFor(() => expect(loopStatus(derived.getState(), null)).toEqual({ kind: 'unavailable' }));
    editModel('Move', (m) => movePart(m, 'tail', [0.5, 0, 0], 'alone'), { store: project });
    loop.flush();
    await new Promise((r) => setTimeout(r, 20));
    expect(ami.requests).toHaveLength(1);
  });

  it('an engine error is shown and the next edit tries again with every part', async () => {
    let fail = true;
    const requests: Req[] = [];
    const ami = {
      generate: async (r: Req) => {
        requests.push(r);
        if (fail) throw new Error('W_RUFFLE everywhere');
        return amiFixture(r.model);
      },
    };
    loop = startLiveLoop({ project, derived, ami, throttleMs: 0 });
    await vi.waitFor(() => expect(loopStatus(derived.getState(), null)).toMatchObject({ kind: 'error', message: 'W_RUFFLE everywhere' }));
    fail = false;
    editModel('Move', (m) => movePart(m, 'tail', [0.5, 0, 0], 'alone'), { store: project });
    loop.flush();
    await vi.waitFor(() => expect(derived.getState().ami).not.toBeNull());
    expect(requests.at(-1)!.dirtyParts).toBeUndefined();
  });

  it('never writes authored data: paint, regions and features survive regenerations unchanged', async () => {
    const ami = fakeAmi();
    editModel('Paint', (m) => addRegion(setPartPaint(m, 'head', new Uint8Array(4096).fill(2)), 'body', { kind: 'band', from: 0.2, to: 0.4, color: 'cream_yarn' }).model, { store: project });
    const before = project.getState().doc!.threeD!.model!;
    const history = project.getState().history.past.length;
    loop = startLiveLoop({ project, derived, ami, throttleMs: 0 });
    for (let i = 0; i < 3; i++) {
      project.getState().update('Stuffing', (d) => {
        d.threeD!.ami.defaultStuffing = i % 2 === 0 ? 'light' : 'firm';
      });
      loop.flush();
      await vi.waitFor(() => expect(derived.getState().jobs.ami?.status).toBe('done'));
    }
    const after = project.getState().doc!.threeD!.model!;
    expect(after).toBe(before);
    expect(byId(after).head.paint).toEqual(byId(before).head.paint);
    expect(project.getState().history.past.length).toBe(history + 3);
  });

  it('a superseded request is not an error', async () => {
    const ami = { generate: async () => Promise.reject(new Superseded(1)) };
    loop = startLiveLoop({ project, derived, ami, throttleMs: 0 });
    await new Promise((r) => setTimeout(r, 10));
    expect(loopStatus(derived.getState(), null).kind).not.toBe('error');
  });
});

describe('reading an AmiResult', () => {
  const m = teddy();
  const r = amiFixture(m);

  it('rings: closed, finite, on the part, one color per point from the stitch labels', () => {
    const rings = ringsOf(r, m, 'body', 'right');
    expect(rings.length).toBe(r.rounds.body.rings.length);
    for (const ring of rings) {
      expect(ring.points[0]).toEqual(ring.points.at(-1));
      expect(ring.colors).toHaveLength(ring.points.length);
      for (const p of ring.points) expect(p.every(Number.isFinite)).toBe(true);
    }
    const mid = rings[Math.floor(rings.length / 2)];
    expect(new Set(mid.colors)).toEqual(new Set([m.palette[1].hex])); // the stripe round
    expect(new Set(rings[0].colors).size).toBe(2); // base + the seam stitch
    expect(ringsOf(r, m, 'eye_l', 'right')).toEqual([]);
  });

  it('a twin without rounds of its own shows its twin’s, mirrored across x = 0', () => {
    const rr = { ...r, rounds: { ...r.rounds } };
    delete rr.rounds.ear_r;
    const mm = { ...m, parts: m.parts.map((p) => (p.id === 'ear_r' ? { ...p, mirrorOf: 'ear_l' } : p)) };
    const got = roundsOf(rr, mm, 'ear_r')!;
    expect(got.mirrored).toBe(true);
    expect(got.rounds.rings[0].center[0]).toBeCloseTo(-r.rounds.ear_l.rings[0].center[0], 9);
  });

  it('ring colors run against the working direction for a right-hander and with it for a left-hander', () => {
    const labels = new Uint8Array([0, 1, 1, 1]);
    const pal = [{ hex: '#000000' }, { hex: '#ffffff' }];
    const rh = ringColors(labels, 8, pal, 'right', '#999999');
    const lh = ringColors(labels, 8, pal, 'left', '#999999');
    expect(rh[0]).toBe('#000000'); // stitch 0 starts at the seam
    expect(lh[0]).toBe('#000000');
    expect(rh[7]).toBe('#000000'); // just before the seam going counter-clockwise = stitch 0 for RH
    expect(lh[1]).toBe('#000000');
    expect(lh[7]).toBe('#ffffff');
  });

  it('malformed rings and ghosts are skipped, never NaN', () => {
    expect(ringPoints({ center: [NaN, 0, 0], normal: [0, 1, 0], radius: 1 }, 8)).toBeNull();
    expect(ringPoints({ center: [0, 0, 0], normal: [0, 0, 0], radius: 1 }, 8)).toBeNull();
    expect(ringPoints({ center: [0, 0, 0], normal: [0, 1, 0], radius: -1 }, 8)).toBeNull();
    expect(ringPoints({ center: [0, 0, 0], normal: [0, 1, 0], radius: 1, polyline: new Float32Array([0, 0, 1, 1, 0, 0, NaN, 0, 0]) }, 8)).toBeNull();
    expect(ghostRings(new Float32Array(GHOST_STRIDE + 1))).toEqual([]);
    expect(ghostRings(new Float32Array([0, 0, 0, 0, 1, 0, NaN]))).toEqual([]);
    expect(ghostRings(undefined)).toEqual([]);
  });

  it('the toy ghost box is every piece ghost plus the other parts’ geometry; a 3% smaller ghost is ~3% shorter', () => {
    const exact = toyGhostHeight(amiFixture(m, { ghostScale: 1 }), m)!;
    const small = toyGhostHeight(amiFixture(m, { ghostScale: 0.9 }), m)!;
    expect(exact).toBeGreaterThan(0);
    expect(small).toBeLessThanOrEqual(exact);
    expect(exact / modelHeight(m)).toBeGreaterThan(0.85);
    expect(exact / modelHeight(m)).toBeLessThanOrEqual(1.0001);
    const noGhost = { ...r, ghosts: {} };
    expect(toyGhostBounds(noGhost, m)).toBeNull();
    expect(ringsBounds([{ center: [0, 0, 0], normal: [0, 1, 0], radius: 2 }])).toEqual({ min: [-2, 0, -2], max: [2, 0, 2] });
  });

  it('badges per part: errors and warnings from issues naming the part or a piece made from it', () => {
    const s = partStatuses(r);
    expect(s.get('head')).toMatchObject({ errors: 0, warnings: 1 });
    expect(s.get('tail')).toMatchObject({ errors: 1, warnings: 0 });
    expect(s.get('body')).toBeUndefined();
  });

  it('ring ↔ line: ring k is the line of round k + 1; a line maps back to its parts and rounds', () => {
    const ref = lineRefForRing(r.pattern, 'body', 4)!;
    expect(ref).toEqual({ piece: 'piece_body', line: 4 });
    expect(ringsForLineRef(r.pattern, ref)).toEqual({ partIds: ['body'], from: 4, to: 4 });
    expect(lineRefForRing(r.pattern, 'eye_l', 0)).toBeNull();
    expect(ringsForLineRef(r.pattern, { piece: 'nope', line: 0 })).toBeNull();
    expect(ringsForLineRef(r.pattern, null)).toBeNull();
    // A line covering rounds 3–5 ("Rnds 3–5: sc around").
    const doc = structuredClone(r.pattern);
    doc.pieces[0].lines = [{ ...doc.pieces[0].lines[0], n: 3, nEnd: 5 }];
    expect(lineRefForRing(doc, doc.pieces[0].partIds[0], 3)).toEqual({ piece: doc.pieces[0].id, line: 0 });
    expect(ringsForLineRef(doc, { piece: doc.pieces[0].id, line: 0 })).toMatchObject({ from: 2, to: 4 });
    void NO_LABEL;
  });
});
