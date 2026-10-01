#!/usr/bin/env node
// Track T7 (DESIGN.md §3.7.7 "Derived fixtures", §6.3 T7 G26): writes fixtures/claude-design/teddy-derived/ from the
// captured, read-only fixtures/claude-design/teddy-bear/ and the canonical teddy (fixtures/models/teddy.canonical.json).
// Run with `npm run cd-fixtures`. Every output is deterministic (fixed entry times, no gzip timestamps).
//
//   teddy-stale-side-file.zip          the project archive, its page's JSON at "revision": 1, plus a crochet-model.json
//                                      at revision 0 whose ears are 20% smaller (§3.7.2 versions chip)
//   teddy-builder-v1.glb               what the stage's own "Download GLB" button saves for a builder-v1 page
//                                      (unitScale 0.0254, meters; root extras.crochetModel)
//   teddy-builder-v1.noroot.glb        the same page with group.userData.crochetModel deleted (per-node extras only)
//   teddy-builder-v1.painted.noroot.glb  per-node extras only, with a band on the body in a color no solid part uses
//                                      (ladder step 2 must read it back from COLOR_0)
//   teddy-builder-v1.obj.gz + .mtl     "Download OBJ + MTL" of the same page (meters, three-d-stage MTL header; the OBJ
//                                      is gzipped like the captured one)
//   teddy-builder-v1.mm.stl.gz         binary STL of the builder at 25.4 units per inch (millimeters), gzipped
//   teddy-builder-v1.ply.gz            binary PLY with vertex colors in meters, gzipped
//   teddy-handoff.tar.gz               a Claude Code handoff bundle: README.md, chats/chat1.md (the spec in a fence),
//                                      project/ with the archive page and three-d-stage.js
//   teddy-handoff-waiting.tar.gz       a handoff bundle exported while Claude was still asking (no project/ folder)
//
// The builder-v1 exports come from the archive's real three-d-stage.js served locally in headless Chromium with the
// canonical teddy as the page's #crochet-model JSON and the §3.4.1 builder (extracted from docs/DESIGN.md), the
// import map pointed at the local node_modules/three: no network.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync, strToU8, unzipSync, zipSync } from 'fflate';
import { chromium } from '@playwright/test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'fixtures/claude-design/teddy-bear');
const OUT = path.join(ROOT, 'fixtures/claude-design/teddy-derived');
const THREE_DIR = path.join(ROOT, 'node_modules/three');
const MTIME = new Date(Date.UTC(2026, 9, 1, 12, 0, 0));

const read = (p) => fs.readFileSync(p);
const write = (name, bytes) => {
  fs.writeFileSync(path.join(OUT, name), bytes);
  console.log(`  ${name}  ${bytes.length.toLocaleString('en-US')} bytes`);
};
const gz = (bytes) => gzipSync(bytes, { level: 9, mtime: 0 });

if (!fs.existsSync(SRC)) throw new Error(`missing ${SRC}`);
fs.mkdirSync(OUT, { recursive: true });

const PAGE = read(path.join(SRC, 'project-archive/Amigurumi Teddy Bear.html')).toString('utf8');
const STAGE_JS = read(path.join(SRC, 'project-archive/three-d-stage.js')).toString('utf8');
const OBSERVED = read(path.join(SRC, 'teddy-bear.crochet-model.json')).toString('utf8');
const CANONICAL = JSON.parse(read(path.join(ROOT, 'fixtures/models/teddy.canonical.json')).toString('utf8'));

// ---- 1. the stale side file (§3.7.2)

function staleSideFile() {
  const zip = unzipSync(new Uint8Array(read(path.join(SRC, 'teddy-bear.project-archive.zip'))));
  const pageName = 'Amigurumi Teddy Bear.html';
  const page = new TextDecoder().decode(zip[pageName]);
  const marker = '"version": "1.0",';
  if (!page.includes(marker)) throw new Error('the archive page changed: no "version": "1.0", in its JSON');
  const newPage = page.replace(marker, `${marker}\n  "revision": 1,`);
  const old = JSON.parse(OBSERVED);
  old.revision = 0;
  for (const p of old.parts) {
    if (p.id !== 'ear_l' && p.id !== 'ear_r' && p.id !== 'ear_l_inner' && p.id !== 'ear_r_inner') continue;
    for (const k of Object.keys(p.dimensions)) p.dimensions[k] = Math.round(p.dimensions[k] * 0.8 * 1e6) / 1e6;
  }
  const entries = {};
  for (const [name, data] of Object.entries(zip)) entries[name] = [name === pageName ? strToU8(newPage) : data, { mtime: MTIME }];
  // the side file is older than the page (written before "make the ears bigger")
  entries['crochet-model.json'] = [strToU8(`${JSON.stringify(old, null, 2)}\n`), { mtime: new Date(MTIME.getTime() - 3600_000) }];
  write('teddy-stale-side-file.zip', zipSync(entries, { level: 9 }));
}

// ---- 2. handoff bundles (05 §2.4: README.md, chats/chat<N>.md, project/)

function tar(files) {
  const blocks = [];
  const enc = new TextEncoder();
  const octal = (n, width) => `${n.toString(8).padStart(width - 1, '0')}\0`;
  for (const [name, data] of files) {
    const h = new Uint8Array(512);
    const put = (text, at) => h.set(enc.encode(text), at);
    const nameBytes = enc.encode(name);
    if (nameBytes.length > 100) throw new Error(`tar name too long: ${name}`);
    h.set(nameBytes, 0);
    put(octal(0o644, 8), 100);
    put(octal(0, 8), 108);
    put(octal(0, 8), 116);
    put(octal(data.length, 12), 124);
    put(octal(Math.floor(MTIME.getTime() / 1000), 12), 136);
    put('        ', 148);
    put('0', 156);
    put('ustar\0', 257);
    put('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    put(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((s, b) => s + b.length, 0));
  let at = 0;
  for (const b of blocks) {
    out.set(b, at);
    at += b.length;
  }
  return out;
}

function handoffs() {
  const readme = [
    '# CODING AGENTS: READ THIS FIRST',
    '',
    'This is a handoff bundle from Claude Design. The design files are in `project/`; the conversation is in `chats/`.',
    '',
  ].join('\n');
  const fence = '```';
  const chat = `## User\n\nModel a 3D object: an amigurumi teddy bear.\n\n## Claude\n\nHere is the complete crochet-model spec:\n\n${fence}json\n${OBSERVED.trim()}\n${fence}\n`;
  write(
    'teddy-handoff.tar.gz',
    gz(
      tar([
        ['amigurumi-teddy-bear/README.md', strToU8(readme)],
        ['amigurumi-teddy-bear/chats/chat1.md', strToU8(chat)],
        ['amigurumi-teddy-bear/project/Amigurumi Teddy Bear.html', strToU8(PAGE)],
        ['amigurumi-teddy-bear/project/three-d-stage.js', strToU8(STAGE_JS)],
      ]),
    ),
  );
  const waiting = '## User\n\nModel a 3D object: an amigurumi teddy bear.\n\n## Claude\n\nBefore I start: should the bear sit or stand?\n';
  write(
    'teddy-handoff-waiting.tar.gz',
    gz(
      tar([
        ['amigurumi-teddy-bear/README.md', strToU8(readme)],
        ['amigurumi-teddy-bear/chats/chat1.md', strToU8(waiting)],
      ]),
    ),
  );
}

// ---- 3. builder-v1 exports through the real stage in headless Chromium

/** The §3.4.1 builder, exactly as DESIGN.md writes it (the first ```js block after the heading). */
function builderSource() {
  const design = read(path.join(ROOT, 'docs/DESIGN.md')).toString('utf8');
  const at = design.indexOf('#### 3.4.1');
  const start = design.indexOf('```js\n', at);
  const end = design.indexOf('\n```', start + 6);
  if (at < 0 || start < 0 || end < 0) throw new Error('docs/DESIGN.md: the §3.4.1 builder block was not found');
  return design.slice(start + 6, end);
}

const PAINTED = (() => {
  const spec = structuredClone(CANONICAL);
  spec.palette.push({ id: 'blush_pink', hex: '#E8A0A8', name: 'blush_pink' });
  const body = spec.parts.find((p) => p.id === 'body');
  body.regions = [{ kind: 'band', from: 0.55, to: 0.75, color: 'blush_pink' }];
  return spec;
})();

function pageFor(variant) {
  const spec = variant === 'painted' ? PAINTED : CANONICAL;
  const importMap = JSON.stringify({ imports: { three: '/three/build/three.module.js', 'three/addons/': '/three/examples/jsm/' } }, null, 2);
  const glue = `
import * as THREE from 'three';
import { buildModel } from '/builder.js';
const stage = document.querySelector('three-d-stage');
await stage.ready;
const spec = JSON.parse(document.getElementById('crochet-model').textContent);
const group = buildModel(spec);
${variant === 'root' ? '' : 'delete group.userData.crochetModel;'}
stage.setObject(group);
const b64 = (bytes) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
// STL (millimeters) and PLY (meters, vertex colors) of the same builder, for the PLY/STL carriers
window.cpgExport = async (kind) => {
  if (kind === 'stl') {
    const { STLExporter } = await import('three/addons/exporters/STLExporter.js');
    const g = buildModel(spec, 25.4); g.updateMatrixWorld(true);
    const out = new STLExporter().parse(g, { binary: true });
    return b64(new Uint8Array(out.buffer, out.byteOffset, out.byteLength));
  }
  const { PLYExporter } = await import('three/addons/exporters/PLYExporter.js');
  const g = buildModel(spec, 0.0254); g.updateMatrixWorld(true);
  g.traverse((o) => {
    if (!o.isMesh || o.geometry.getAttribute('color')) return;
    const n = o.geometry.getAttribute('position').count, c = o.material.color, col = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { col[3 * i] = c.r; col[3 * i + 1] = c.g; col[3 * i + 2] = c.b; }
    o.geometry.setAttribute('color', new THREE.BufferAttribute(col, 3));
  });
  const out = await new Promise((resolve) => new PLYExporter().parse(g, resolve, { binary: true, excludeAttributes: ['normal', 'uv'] }));
  return b64(new Uint8Array(out));
};
window.cpgReady = true;
`;
  let html = PAGE;
  html = html.replace(/<script type="importmap">[\s\S]*?<\/script>/, `<script type="importmap">\n${importMap}\n</script>`);
  html = html.replace(/(<script type="application\/json" id="crochet-model">)[\s\S]*?(<\/script>)/, `$1\n${JSON.stringify(spec, null, 2)}\n$2`);
  html = html.replace(/<script type="module">[\s\S]*?<\/script>/, `<script type="module">${glue}</script>`);
  return html;
}

function serve() {
  const builder = builderSource();
  const types = { '.js': 'text/javascript', '.html': 'text/html', '.json': 'application/json' };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (body, type) => {
      res.writeHead(200, { 'content-type': type });
      res.end(body);
    };
    if (url.pathname === '/' || url.pathname === '/index.html') return send(pageFor(url.searchParams.get('variant') ?? 'root'), types['.html']);
    if (url.pathname === '/three-d-stage.js') return send(STAGE_JS, types['.js']);
    if (url.pathname === '/builder.js') return send(builder, types['.js']);
    if (url.pathname.startsWith('/three/')) {
      const file = path.normalize(path.join(THREE_DIR, url.pathname.slice('/three/'.length)));
      if (file.startsWith(THREE_DIR + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) return send(read(file), types[path.extname(file)] ?? 'application/octet-stream');
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function builderExports() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1024, height: 768 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('requestfailed', (r) => errors.push(`request failed: ${r.url()}`));
    page.on('request', (r) => {
      if (!r.url().startsWith(base) && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) errors.push(`network: ${r.url()}`);
    });
    const open = async (variant) => {
      await page.goto(`${base}/?variant=${variant}`);
      await page.waitForFunction(() => window.cpgReady === true, null, { timeout: 60_000 });
      if (errors.length > 0) throw new Error(errors.join('\n'));
    };
    const download = async (button) => {
      const files = [];
      const want = button === 'Download OBJ + MTL' ? 2 : 1;
      const done = new Promise((resolve) => {
        page.on('download', async function onDownload(d) {
          const p = await d.path();
          files.push({ name: d.suggestedFilename(), bytes: read(p) });
          if (files.length === want) {
            page.off('download', onDownload);
            resolve();
          }
        });
      });
      await page.locator('three-d-stage').getByRole('button', { name: button }).click();
      await done;
      return files;
    };
    await open('root');
    const [glb] = await download('Download GLB');
    write('teddy-builder-v1.glb', glb.bytes);
    for (const f of await download('Download OBJ + MTL')) {
      if (f.name.endsWith('.obj')) write('teddy-builder-v1.obj.gz', gz(f.bytes));
      else write('teddy-builder-v1.mtl', f.bytes);
    }
    write('teddy-builder-v1.mm.stl.gz', gz(Buffer.from(await page.evaluate(() => window.cpgExport('stl')), 'base64')));
    write('teddy-builder-v1.ply.gz', gz(Buffer.from(await page.evaluate(() => window.cpgExport('ply')), 'base64')));
    await open('noroot');
    write('teddy-builder-v1.noroot.glb', (await download('Download GLB'))[0].bytes);
    await open('painted');
    write('teddy-builder-v1.painted.noroot.glb', (await download('Download GLB'))[0].bytes);
    if (errors.length > 0) throw new Error(errors.join('\n'));
  } finally {
    await browser.close();
    server.close();
  }
}

console.log(`make-cd-fixtures → ${path.relative(ROOT, OUT)}/`);
staleSideFile();
handoffs();
await builderExports();
