// Layer revert / erase / undo-redo buttons, original pixels persisted.
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
    const col = (c) => { const k = document.createElement('canvas'); k.width = k.height = 64; const g = k.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 64, 64); return k; };
    const px = (rt) => Array.from(L.toCanvas(rt).getContext('2d').getImageData(8, 8, 1, 1).data);
    const q = (t) => [...ed.ui.sec.layers.body.querySelectorAll('button')].find((b) => b.textContent.includes(t));
    R.hasButtons = !!q('Revert layer') && !!q('Erase with brush') && !!q('Undo') && !!q('Redo');
    const ai = L.addLayer(L.fromImage(col('#20e060')), 'AI test', { ai: true });
    await sleep(50);
    R.freshNoRevert = !L.canRevert(L.active) && q('Revert layer').disabled;
    // erase = layer mask hide
    L.setMask(L.active, 'hide'); await sleep(30);
    R.masked = !!L.activeLayer.mask && L.canRevert(L.active) && !q('Revert layer').disabled;
    // revert
    const n0 = ed.undoStack.length;
    R.reverted = L.revert(L.active) && !L.activeLayer.mask && ed.undoStack.length === n0 + 1;
    R.pixOrig = px(L.activeLayer.pix)[1] > 180;
    q('Undo').click(); await sleep(30); R.undoBack = !!L.activeLayer.mask;
    q('Redo').click(); await sleep(30); R.redoAgain = !L.activeLayer.mask;
    R.undoRedoEnabled = !q('Undo').disabled && q('Redo').disabled;
    // replace-active bake then revert returns the original pixels
    L.setProp(L.active, { visible: true });
    L.bakeIntoActive(L.fromImage(col('#e03030'))); await sleep(30);
    R.baked = px(L.activeLayer.pix)[0] > 180 && L.canRevert(L.active);
    L.revert(L.active); R.bakeReverted = px(L.activeLayer.pix)[1] > 180 && px(L.activeLayer.pix)[0] < 80;
    // survives serialisation
    L.bakeIntoActive(L.fromImage(col('#3050e0'))); L.setMask(L.active, 'hide');
    const data = JSON.parse(JSON.stringify(L.serialize()));
    const files = new Map(L.files().map((f) => [f.name, f.rt]));
    R.origSaved = data.stack[L.active].orig !== data.stack[L.active].pix && files.has(`L_${data.stack[L.active].orig}.png`);
    const imgs = new Map(); for (const [n, rt] of files) imgs.set(n, L.toCanvas(rt, n.startsWith('M_')));
    const ok = await L.loadStack(data, async (n) => imgs.get(n) || null);
    R.loaded = ok && L.canRevert(L.active) && L.revert(L.active) && px(L.activeLayer.pix)[1] > 180;
    // history depth
    R.depth = (() => { for (let i = 0; i < 70; i++) L.setMask(0, i % 2 ? 'reveal' : 'hide'); return ed.undoStack.length; })();
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'panel has Erase / Revert / Undo / Redo': R.hasButtons, 'fresh layer: nothing to revert': R.freshNoRevert,
    'mask makes the layer revertable': R.masked, 'revert removes mask (one undo step)': R.reverted && R.pixOrig,
    'undo brings the erase back': R.undoBack, 'redo re-applies the revert': R.redoAgain, 'undo/redo button state': R.undoRedoEnabled,
    'replace-active bake can be reverted': R.baked && R.bakeReverted,
    'original pixels are saved with the stack': R.origSaved, 'revert works after restore': R.loaded, 'history depth up to 60': R.depth >= 55 && R.depth <= 60,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
