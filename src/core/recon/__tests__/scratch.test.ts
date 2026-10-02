import { it } from 'vitest';
import { buildContext, reconVolume } from '../build';
import { decompose, dissolveFillets, splitMergedPairs, interfaces } from '../parts';
import { findNeck, splitAtNeck } from '../neck';
import { renderModelView, requestFromRenders, TEDDY_MODEL } from './helpers/render';
import { request } from './helpers/requests';
import { TEDDY, centered } from './helpers/views';

async function run(name: string, req: ReturnType<typeof request>, extra: { minLimbFraction?: number; minDepth?: number } = {}) {
  const v = await reconVolume(req, buildContext(req, {}));
  const N = req.settings.N;
  const t0 = performance.now();
  let d = decompose(v.field, [N, N, N], { openingFrac: req.settings.openingFrac, ...extra });
  const t1 = performance.now();
  const neck = findNeck(d, 0);
  if (neck) d = splitAtNeck(d, 0, neck);
  const sh = interfaces(d.label, d.dims, d.parts.length); console.log('iface', d.parts.map((_, k) => Array.from(sh.subarray(k * d.parts.length, (k + 1) * d.parts.length)).join(' ')).join(' | '));
  d = dissolveFillets(d);
  { let cx = 0, n = 0; for (let i = 0; i < d.label.length; i++) if (d.label[i] === 1) { cx += i % N; n++; } d = splitMergedPairs(d, cx / n); }
  console.log(name, 'r', d.radius.toFixed(1), 'inside', d.inside, 'ms', (t1 - t0).toFixed(0), 'neck', neck ? `${neck.ring} ${neck.ratio.toFixed(2)} ${neck.sides.map((x) => x.toFixed(2))}` : null);
  const c = d.parts.map(() => [0, 0, 0, 0]);
  for (let i = 0; i < d.label.length; i++) { const k = d.label[i]; if (!k) continue; const x = i % N, y = Math.floor(i / N) % N, z = Math.floor(i / N / N); c[k - 1][0] += x; c[k - 1][1] += y; c[k - 1][2] += z; c[k - 1][3]++; }
  d.parts.forEach((p, k) => console.log('  ', p.kind, p.voxels, (p.voxels / d.inside * 100).toFixed(2) + '%', 'parent', p.parent, 'depth', p.depth.toFixed(1), 'c', c[k].slice(0, 3).map((v) => (v / c[k][3]).toFixed(0)).join(',')));
}
it('s', { timeout: 120000 }, async () => {
  await run('TEDDY 4 views', request(centered(TEDDY), ['front', 'left', 'top', 'back']));
  const views = ['front', 'left', 'top', 'back'].map((l) => renderModelView(TEDDY_MODEL, l as never));
  await run('canon 4 views', requestFromRenders(views));
  await run('canon left only', requestFromRenders([renderModelView(TEDDY_MODEL, 'left')], { photoView: 'left' }));
  await run('canon front only', requestFromRenders([renderModelView(TEDDY_MODEL, 'front')], { photoView: 'front' }));
});
