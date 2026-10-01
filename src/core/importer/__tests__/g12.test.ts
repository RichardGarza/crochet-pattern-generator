// G12 (DESIGN.md §2.13, §3.7.3, §3.7.7) on the T7.1 carriers: the pasted chat JSON (with prose, with smart
// quotes), the `.json` file, the project-archive page, the standalone `__bundler` page and the project-archive zip
// each yield exactly fixtures/models/teddy.canonical.json — the same 17 parts, attach tree and mirror pairs.
import { describe, expect, it } from 'vitest';
import type { ImportInput, ImportResult } from '../../../types/importer';
import type { CrochetModelV1, Part } from '../../../types/model';
import { generateAmigurumi } from '../../ami/generate';
import { resolveGauge } from '../../gauge';
import { attachRoot, isOneTree } from '../../model/attach';
import { isImplemented } from '../../stub';
import { stringifyModel } from '../../model/schema';
import { importInputs } from '../index';
import { normalizeSpec } from '../dialect';
import { HEAVY } from '../../model/__tests__/helpers/options';
import { CANONICAL_TEDDY, chatReply, curlyQuotes, fixtureInput, OBSERVED_JSON } from './helpers/fixtures';

const byId = (m: CrochetModelV1): Record<string, Part> => Object.fromEntries(m.parts.map((p) => [p.id, p]));

const CARRIERS: [string, () => ImportInput, ImportResult['carrier']][] = [
  ['pasted chat reply (prose around a json fence)', () => ({ kind: 'text', text: chatReply(OBSERVED_JSON) }), 'text'],
  ['pasted chat reply with smart quotes', () => ({ kind: 'text', text: curlyQuotes(chatReply(OBSERVED_JSON)) }), 'text'],
  ['pasted bare JSON', () => ({ kind: 'text', text: OBSERVED_JSON }), 'text'],
  ['teddy-bear.crochet-model.json', () => fixtureInput('teddy-bear.crochet-model.json'), 'json'],
  ['project-archive/Amigurumi Teddy Bear.html', () => fixtureInput('project-archive/Amigurumi Teddy Bear.html'), 'html'],
  ['teddy-bear.standalone.html', () => fixtureInput('teddy-bear.standalone.html'), 'standalone-html'],
  ['teddy-bear.project-archive.zip', () => fixtureInput('teddy-bear.project-archive.zip'), 'zip'],
];

describe('G12: every T7.1 teddy carrier yields teddy.canonical.json', HEAVY, () => {
  for (const [label, input, carrier] of CARRIERS) {
    describe(label, () => {
      let result: ImportResult;
      it('imports', async () => {
        result = await importInputs([input()]);
        expect(result.warnings.filter((w) => w.severity === 'error')).toEqual([]);
        expect(result.ok).toBe(true);
      });

      it('is byte for byte the canonical teddy', () => {
        expect(stringifyModel(result.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
      });

      it(`reports carrier "${carrier}", the observed dialect and high confidence`, () => {
        expect(result.carrier).toBe(carrier);
        expect(result.dialect).toBe('cd-observed-2026-09');
        expect(result.confidence).toBe('high');
      });

      it('logs the teddy repairs: notes, units kept, ground, 6 attach and 6 mirror chips', () => {
        const codes = result.repairs.map((r) => r.code);
        expect(codes).toEqual([
          'unknown-key',
          'units',
          'ground',
          ...Array<string>(6).fill('attach-inferred'),
          ...Array<string>(6).fill('mirror-inferred'),
        ]);
        expect(result.repairs[0].message).toBe('unknown key "notes" removed (its text is kept in "assumptions")');
        expect(result.repairs[1].message).toBe('the model measures 9.88 in tall (it says 10 in): kept as it is');
        expect(result.repairs[2].data).toEqual({ dy: 0.0789 });
      });

      it('one attach tree rooted at body, with the §3.7.3 links and mirror pairs', () => {
        const m = result.model as CrochetModelV1;
        expect(isOneTree(m)).toBe(true);
        expect(attachRoot(m)?.id).toBe('body');
        const to = Object.fromEntries(m.parts.map((p) => [p.id, p.attach?.to]));
        expect(to).toEqual({
          body: undefined,
          head: 'body',
          muzzle: 'head',
          nose: 'muzzle',
          eye_l: 'head',
          eye_r: 'head',
          ear_l: 'head',
          ear_l_inner: 'ear_l',
          ear_r: 'head',
          ear_r_inner: 'ear_r',
          arm_l: 'body',
          arm_r: 'body',
          leg_l: 'body',
          foot_pad_l: 'leg_l',
          leg_r: 'body',
          foot_pad_r: 'leg_r',
          tail: 'body',
        });
        const inferred = result.repairs.filter((r) => r.code === 'attach-inferred').map((r) => r.part);
        expect(inferred.sort()).toEqual(['arm_l', 'arm_r', 'head', 'leg_l', 'leg_r', 'tail']);
        const mirrors = Object.fromEntries(m.parts.filter((p) => p.mirrorOf).map((p) => [p.id, p.mirrorOf]));
        expect(mirrors).toEqual({ eye_r: 'eye_l', ear_r: 'ear_l', ear_r_inner: 'ear_l_inner', arm_r: 'arm_l', leg_r: 'leg_l', foot_pad_r: 'foot_pad_l' });
      });

      it('has no W_GAP and no cpg tag', () => {
        expect(result.warnings.filter((w) => w.code === 'W_GAP')).toEqual([]);
        expect(result.cpgTag).toBeUndefined();
      });
    });
  }

  it('records the HTML fingerprints (archive page: three-d-stage + importmap; standalone: __bundler + three-d-stage)', async () => {
    const page = await importInputs([fixtureInput('project-archive/Amigurumi Teddy Bear.html')]);
    expect(page.fingerprint).toEqual(['three-d-stage', 'importmap']);
    const standalone = await importInputs([fixtureInput('teddy-bear.standalone.html')]);
    expect(standalone.fingerprint).toEqual(['__bundler', 'three-d-stage']);
    const zip = await importInputs([fixtureInput('teddy-bear.project-archive.zip')]);
    expect(zip.fingerprint).toEqual(['three-d-stage', 'importmap']);
    expect(zip.candidates).toEqual([{ id: 'Amigurumi Teddy Bear.html', path: 'Amigurumi Teddy Bear.html', source: 'html', revision: 0, parts: 17, chosen: true }]);
    expect(zip.repairs.some((r) => r.code === 'versions')).toBe(false);
  });

  it('the dropped archive page, the chat JSON and the zip together are one version (identical candidates merge)', async () => {
    const r = await importInputs([
      fixtureInput('teddy-bear.project-archive.zip'),
      fixtureInput('teddy-bear.crochet-model.json'),
      { kind: 'text', text: chatReply(OBSERVED_JSON) },
    ]);
    expect(r.ok).toBe(true);
    expect(stringifyModel(r.model as CrochetModelV1)).toBe(CANONICAL_TEDDY);
    expect(r.candidates?.length).toBe(1);
    expect(r.candidates?.[0].source).toBe('html');
    expect(r.repairs.some((x) => x.code === 'versions')).toBe(false);
  });

  it('§3.7.3 goldens before grounding (±1e-3): world transforms, capsule length, safety eyes', () => {
    const n = normalizeSpec(JSON.parse(OBSERVED_JSON) as Record<string, unknown>);
    expect(n.dialect).toBe('cd-observed-2026-09');
    const p = byId(n.model);
    const close = (actual: readonly number[] | undefined, expected: number[]): void => {
      expect(actual).toBeDefined();
      (actual as number[]).forEach((v, i) => expect(Math.abs(v - expected[i])).toBeLessThanOrEqual(1e-3));
    };
    close(p.muzzle.position, [0, 6.6, 1.9]);
    close(p.nose.position, [0, 6.9, 2.42]);
    close(p.eye_l.position, [0.78, 7.45, 2.02]);
    close(p.ear_l.position, [1.6, 8.95, -0.1]);
    close(p.ear_l.rotationDeg, [0, 0, -28]);
    close(p.ear_l_inner.position, [1.5765, 8.9059, 0.16]);
    close(p.ear_l_inner.rotationDeg, [0, 0, -28]);
    close(p.foot_pad_l.position, [1.4411, 0.9706, 2.6061]);
    close(p.foot_pad_l.rotationDeg, [82, 0, -12]);
    expect(p.leg_l.type === 'capsule' && p.leg_l.dims.length).toBeCloseTo(3.1, 9);
    expect(p.eye_l.crochet).toEqual({ make: 'safety_eye' });
    expect(p.eye_r.crochet).toEqual({ make: 'safety_eye' });
    expect(p.nose.crochet).toBeUndefined();
    expect(n.model.palette.map((c) => c.id)).toEqual(['caramel_yarn', 'cream_yarn', 'dark_brown_yarn', 'black_safety_eye']);
    expect(n.model.assumptions).toEqual([JSON.parse(OBSERVED_JSON).notes]);
  });

  // G12's last clause needs T4's generator (a Step 0 stub until T4 lands; integration removes the gate).
  it.runIf(isImplemented(generateAmigurumi))('the imported teddy generates a pattern with zero E_* (T4)', async () => {
    const r = await importInputs([fixtureInput('teddy-bear.project-archive.zip')]);
    const out = await generateAmigurumi(
      {
        jobId: 1,
        model: r.model as CrochetModelV1,
        meshes: {},
        gauge: resolveGauge({ cyc: 4, technique: 'amigurumi_sc' }),
        settings: { style: 'classic', spiral: true, crispStripes: false, decMethod: 'invdec', dialect: 'compact', terms: 'us', hand: 'right', eyes: 'auto', defaultStuffing: 'firm', leanStPerRnd: 0.25 },
      },
      {},
    );
    expect(out.issues.filter((i) => i.code.startsWith('E_'))).toEqual([]);
  });
});
