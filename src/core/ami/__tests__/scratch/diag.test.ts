import { it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { CrochetModelV1 } from '../../../../types/model';
import type { AmiSettings } from '../../../../types/ami';
import { generateAmigurumi } from '../../generate';
import { resolveGauge } from '../../../gauge';
import { pieceText } from '../../text3d';
const teddy = JSON.parse(readFileSync(new URL('../../../../../fixtures/models/teddy.canonical.json', import.meta.url), 'utf8')) as CrochetModelV1;
const S: AmiSettings = { style: 'classic', spiral: true, crispStripes: false, decMethod: 'invdec', dialect: 'compact', terms: 'us', hand: 'right', eyes: 'auto', defaultStuffing: 'firm', leanStPerRnd: 0.25 };
it('diag', async () => {
  const g = resolveGauge({ cyc: 4, technique: 'amigurumi_sc' });
  const t0 = performance.now();
  const r = await generateAmigurumi({ jobId: 1, model: teddy, meshes: {}, gauge: g, settings: S }, {});
  console.log('ms', performance.now() - t0);
  const t1 = performance.now();
  await generateAmigurumi({ jobId: 1, model: teddy, meshes: {}, gauge: g, settings: S }, {});
  console.log('ms2', performance.now() - t1);
  console.log(JSON.stringify(r.plan));
  for (const p of r.pattern.pieces) {
    console.log(`\n== ${p.title} (make ${p.makeCount}) stuffing ${p.stuffing}`); console.log(p.intro.join(' '));
    console.log(pieceText(p.lines, { dialect: 'compact', terms: 'us', hand: 'right' }).join('\n'));
    console.log(p.finish.text);
  }
  console.log('\n== Assembly'); for (const a of r.pattern.assembly) console.log(a.order, a.kind, a.text);
  console.log('\n== Finishing', r.pattern.finishing); console.log(r.pattern.notions, r.pattern.materials.map((m) => `${m.code} ${m.name} ${m.yards} (${m.yardsLow}-${m.yardsHigh}) ${m.yarn?.name}`));
  console.log(r.pattern.gaugeText, r.pattern.skill, r.pattern.finishedSize);
  console.log('issues', r.issues.map((i) => `${i.code}@${i.where?.piece}:${i.where?.line} ${i.message}`));
});
