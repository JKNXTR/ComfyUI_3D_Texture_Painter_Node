// Master resolution: a larger bake result resizes the layer stack (one undo step).
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
    const L = ed.layers;
    const col = (c, n) => { const k = document.createElement('canvas'); k.width = k.height = n; const g = k.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, n, n); return k; };
    const w0 = L.w;
    L.addLayer(L.fromImage(col('#20e060', 64)), 'AI test', { ai: true });
    const n0 = ed.undoStack.length;
    const big = await createImageBitmap(col('#3050e0', 4096 > w0 * 2 ? w0 * 2 : 4096));
    ed.showResult(big, null, { prompt: 'x' });
    R.resized = L.w === big.width && L.h === big.height && L.w !== w0;
    R.pixSize = L.layers.every((l) => l.pix.width === L.w && l.origPix.width === L.w);
    R.pending = !!ed.pending && ed.pending.pix.width === L.w;
    R.oneUndo = ed.undoStack.length === n0 + 1;
    ed.applyResult(); await sleep(50);
    R.applied = L.layers.length === 3 && L.activeLayer.pix.width === L.w;
    const px = Array.from(L.toCanvas(L.activeLayer.pix).getContext('2d').getImageData(10, 10, 1, 1).data);
    R.content = px[2] > 180 && px[0] < 100;
    const px0 = Array.from(L.toCanvas(L.layers[1].pix).getContext('2d').getImageData(10, 10, 1, 1).data);
    R.oldKept = px0[1] > 180;
    ed.undo(); await sleep(30); ed.undo(); await sleep(30);
    R.undoSize = L.w === w0 && L.layers.length === 2;
    // too large / same size: no resize
    const huge = await createImageBitmap(col('#fff', 64)); Object.defineProperty(huge, 'width', { value: 8192 }); Object.defineProperty(huge, 'height', { value: 8192 });
    ed.showResult(huge, null, {}); R.hugeKept = L.w === w0;
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'bigger result resizes the layer stack': R.resized, 'every layer (and original) resized': R.pixSize, 'pending result at the new size': R.pending,
    'resize is one undo step': R.oneUndo, 'apply keeps content, old layers resampled': R.applied && R.content && R.oldKept,
    'undo restores the previous size': R.undoSize, 'above 4096 the stack keeps its size': R.hugeKept,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
