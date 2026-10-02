import { it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { resolveGauge } from '../../gauge';
import { buildPattern2D } from '../../techniques/index';
import { mulberry32 } from '../../kernel/prng';
import { loadChartResult, randomChart, settingsOf } from '../../techniques/__tests__/fixtures';
import { buildPatternPdf } from '../pdf';
it('scratch', async () => {
  const cases = [
    ['g9', loadChartResult('g9').grid, 'sc_graphgan', 0],
    ['heart', loadChartResult('heart').grid, 'sc_graphgan', 0.5],
    ['heartc2c', loadChartResult('heart').grid, 'c2c', 0.5],
    ['big', randomChart(mulberry32(7), 120, 150, 6), 'sc_graphgan', 1],
  ] as const;
  for (const [name, chart, technique, border] of cases) {
    const gauge = resolveGauge({ cyc: 4, technique });
    const doc = buildPattern2D({ chart, settings: settingsOf({ technique, border: { widthIn: border } }), gauge, terms: 'us', dialect: 'compact', title: name === 'heart' ? 'Sweetheart Pillow' : 'Test ' + name });
    const t0 = performance.now();
    const r = await buildPatternPdf(doc, { paper: 'letter' });
    const ms = performance.now() - t0;
    writeFileSync('/private/tmp/claude-501/-Users-garzamacbookair/b4c6bc88-49ea-46c3-bc38-814bcd3190ae/scratchpad/t8/' + name + '.pdf', new Uint8Array(await r.blob.arrayBuffer()));
    writeFileSync('/private/tmp/claude-501/-Users-garzamacbookair/b4c6bc88-49ea-46c3-bc38-814bcd3190ae/scratchpad/t8/' + name + '.json', JSON.stringify({ ms, pages: r.pages, sections: r.sections, src: r.textSource, tiles: r.chart?.layout.tiles.length, orient: r.chart?.layout.orientation, per: r.chart?.layout.perPage, issues: doc.issues.length }, null, 1));
  }
}, 120000);
