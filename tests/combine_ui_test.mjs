// Combine layers panel end to end.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome', headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1300,820'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 820 });
const logs = [];
page.on('console', (m) => { if (!/GPU stall/.test(m.text())) logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.stack || e.message}`));
let failed = false;
try {
  await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
  await page.waitForFunction('window.ready === true', { timeout: 20000 });
  const R = await page.evaluate(async () => {
    const R = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = new window.TP.TexturePaintEditor();
    document.getElementById('host').append(ed.root);
    await sleep(400);
    const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
    const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
    let obj = 'o A\n'; for (const p of P) obj += `v ${p[0]} ${p[1]} ${p[2]}\n`;
    obj += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
    for (const f of F) obj += `f ${f[0] + 1}/1 ${f[1] + 1}/2 ${f[2] + 1}/3\nf ${f[0] + 1}/1 ${f[2] + 1}/3 ${f[3] + 1}/4\n`;
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'c.obj'); await sleep(300);
    const L = ed.layers, N = L.w;
    const mk = (col, x0, x1, name) => { const c = document.createElement('canvas'); c.width = c.height = N; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(x0 * N, 0, (x1 - x0) * N, N); return L.addLayer(L.fromImage(c), name, { ai: true, prompt: name }); };
    mk('#dc2828', 0.05, 0.6, 'AI red'); mk('#2828dc', 0.4, 0.95, 'AI blue');
    await sleep(100);
    const px = (rt, x, y) => Array.from(L.toCanvas(rt).getContext('2d').getImageData(x, y, 1, 1).data);
    const body = ed.ui.sec.cmb.body;
    const btn = (t) => [...body.querySelectorAll('button')].find((b) => b.textContent.startsWith(t));
    R.panel = !!btn('Preview') && !!btn('Combine to new layer');
    R.rows = body.querySelectorAll('input[type=checkbox]').length >= 3;
    const cmb = ed.state.combine;
    R.dbg1 = [JSON.stringify(cmb.w), L.layers.map((l) => l.id + ':' + l.name + ':' + l.ai).join('|')];
    R.defaults = [...body.querySelectorAll('input[type=checkbox]')].filter((c) => c.checked).length === 5;      // base layer excluded by default: 2 AI layers + hide-sources + 2 transition options (on by default)
    cmb.detail = 'plain'; cmb.mode = 'weighted'; cmb.fill = 0;
    const n0 = L.layers.length, u0 = ed.undoStack.length;
    await ed.combinePreview(); await sleep(100);
    R.pending = !!ed.pending && ed.pending.stats.kind === 'combine';
    R.previewNoLayer = L.layers.length === n0;
    ed.applyResult(); await sleep(100);
    R.applied = L.layers.length === n0 + 1 && L.activeLayer.name.startsWith('Combined') && !L.activeLayer.ai;
    const comb = L.activeLayer.pix; R.dbg2 = [L.activeLayer.name, px(comb, Math.round(N * 0.2), 10), px(comb, Math.round(N * 0.5), 10), px(comb, Math.round(N * 0.8), 10), N];
    R.outside = (() => { const a = px(comb, Math.round(N * 0.2), 10), b = px(comb, Math.round(N * 0.8), 10); return a[0] > 190 && a[2] < 60 && b[2] > 190 && b[0] < 60; })();
    R.overlap = (() => { const a = px(comb, Math.round(N * 0.5), 10); return Math.abs(a[0] - 130) < 12 && Math.abs(a[2] - 130) < 12 && a[3] > 250; })();
    // importance: red 100%, blue 25% -> overlap leans red
    const ids = L.layers.filter((l) => l.ai && l.name.startsWith('AI')).map((l) => l.id);
    const red = L.layers.find((l) => l.name === 'AI red'), blue = L.layers.find((l) => l.name === 'AI blue');
    cmb.w[red.id].imp = 1; cmb.w[blue.id].imp = 0.25;
    await ed.combineLayersNow(); await sleep(100);
    const a2 = px(L.activeLayer.pix, Math.round(N * 0.5), 10);
    R.importance = a2[0] > a2[2] + 60;
    R.hidden = !red.visible && !blue.visible && L.layers.length === n0 + 2;
    // undo steps: hide + apply
    ed.undo(); ed.undo(); await sleep(50);
    R.undo = L.layers.length === n0 + 1 && L.layers.find((l) => l.id === red.id).visible && L.layers.find((l) => l.id === blue.id).visible;
    // multiband + normalize + fill run without error and report
    cmb.detail = 'multiband'; cmb.normalize = 'anchor'; cmb.fill = 6; cmb.w[blue.id].imp = 1;
    await ed.combinePreview(); await sleep(150);
    R.mbText = ed.ui.sec.cmb.body.textContent.match(/Combined[^\n]*?ms\./g);
    R.mbOk = !!ed.pending && /painted/.test(ed.ui.sec.cmb.body.textContent) && /matched|no overlap/.test(ed.ui.sec.cmb.body.textContent);
    ed.discardResult();
    // current view source: facing map + result still valid
    const f = ed.viewFacingMap(); 
    let vis = 0, mx = 0; for (let i = 0; i < f.length; i++) { if (f[i] > 0) vis++; if (f[i] > mx) mx = f[i]; }
    R.mx = mx; R.vis = vis;
    R.facing = f.length === N * L.h && vis > 1000 && mx > 200;
    cmb.viewImp = 0.5; await ed.combinePreview(); await sleep(150);
    R.viewOk = !!ed.pending && /Combined 3 sources/.test(ed.ui.sec.cmb.body.textContent);
    ed.discardResult();
    // stack resized -> masks still handled (maskBytes resamples)
    const bi = () => L.layers.findIndex((l) => l.id === blue.id);
    L.setMask(bi(), 'hide');
    L.resizeTo(512, 512); await sleep(50);
    const mb = L.maskBytes(L.layers[bi()]); R.maskBytes = !!mb && mb.length === 512 * 512 && mb[1000] === 0;
    R.noErrors = true;
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'panel present with a row per layer': R.panel && R.rows, 'base layer is not included by default': R.defaults,
    'preview creates a pending result, no layer yet': R.pending && R.previewNoLayer, 'apply adds a non-AI "Combined" layer': R.applied,
    'single-layer areas keep their colour': R.outside, 'equal importance averages the overlap': R.overlap,
    'importance 100% vs 25% leans to the important layer': R.importance, 'sources hidden after applying': R.hidden, 'undo restores layers and visibility': R.undo,
    'multiband + normalize + fill run and report': R.mbOk, 'current-view facing map is sane': R.facing, 'current view as an extra source': R.viewOk,
    'layer masks are resampled when the stack was resized': R.maskBytes,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
