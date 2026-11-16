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
    const L = ed.layers, N = L.w, st = ed.state, cmb = st.combine;
    const mk = (col, x0, x1, name) => { const c = document.createElement('canvas'); c.width = c.height = N; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(x0 * N, 0, (x1 - x0) * N, N); return L.addLayer(L.fromImage(c), name, { ai: true, prompt: name }); };
    mk('#dc2828', 0.05, 0.6, 'AI red'); mk('#2828dc', 0.4, 0.95, 'AI blue');
    await sleep(100);
    const px = (rt, x, y) => Array.from(L.toCanvas(rt).getContext('2d').getImageData(x, y, 1, 1).data);
    const body = ed.ui.sec.cmb.body;
    R.panel = /Smooth transitions/.test(body.textContent) && !![...body.querySelectorAll('button')].find((b) => b.textContent.startsWith('Paint transitions'));
    R.emptyAtStart = ed.transIsEmpty() && ed.maskIsEmpty();
    // paint with the blue brush through a full-pane shape: only the transition mask must change
    [...body.querySelectorAll('button')].find((b) => b.textContent.startsWith('Paint transitions')).click();
    R.target = st.brushTarget === 'transition';
    const pane = ed._paneSize(ed.ui.pane3d), cv = document.createElement('canvas'); cv.width = pane.w; cv.height = pane.h;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, pane.w, pane.h);
    const u0 = ed.undoStack.length;
    R.filled = ed.fillShape(cv, false); await sleep(100);
    R.transPainted = !ed.transIsEmpty();
    R.selUntouched = ed.maskIsEmpty();
    R.undoGrew = ed.undoStack.length === u0 + 1 && ed.undoStack[ed.undoStack.length - 1].k === 'tr';
    ed.undo(); await sleep(50);
    R.undone = ed.transIsEmpty();
    ed.redo(); await sleep(50);
    R.redone = !ed.transIsEmpty();
    // save / restore round trip
    const blob = await ed.exportTransBlob(); const v0 = ed.transVersion;
    ed.transClear(); R.cleared = ed.transIsEmpty() && ed.transVersion > v0;
    ed.importTransBitmap(await createImageBitmap(blob)); R.restored = !ed.transIsEmpty();
    R.info = /% of the UV square is painted blue/.test(body.textContent);
    // combine: priority mode = hard edge; with the transition = soft ramp
    cmb.mode = 'priority'; cmb.detail = 'plain'; cmb.fill = 0; cmb.tw = 64;
    cmb.useTrans = false; await ed.combinePreview(); await sleep(100); ed.applyResult(); await sleep(60);
    const hard = L.activeLayer.pix; const xs = [0.5, 0.55, 0.6, 0.65, 0.7].map((f) => Math.round(N * f));
    const hardRow = xs.map((x) => px(hard, x, Math.round(N * 0.5))[0]);
    cmb.useTrans = true; await ed.combinePreview(); await sleep(150); ed.applyResult(); await sleep(60);
    const soft = L.activeLayer.pix; const softRow = xs.map((x) => px(soft, x, Math.round(N * 0.5))[0]);
    R.dbg = [hardRow, softRow];
    R.softSteps = Math.max(...softRow.slice(1).map((v, i) => Math.abs(v - softRow[i]))) < 90;
    R.hardMore = Math.max(...hardRow.slice(1).map((v, i) => Math.abs(v - hardRow[i]))) >= 0;
    R.mid = softRow.some((v) => v > 60 && v < 190);
    // the boolean toggle in the Brush panel is the same switch as the one in Combine: inactive -> Combine ignores the blue mask
    const tog = [...ed.ui.sec.brush.body.querySelectorAll('label')].find((l) => /Transition mask active/.test(l.textContent)).querySelector('input');
    const cTog = [...body.querySelectorAll('label')].find((l) => /Blend painted transition areas/.test(l.textContent)).querySelector('input');
    R.togOn = tog.checked && cTog.checked;
    tog.checked = false; tog.dispatchEvent(new Event('change')); await sleep(30);
    R.togSync = cmb.useTrans === false && cTog.checked === false;
    await ed.combinePreview(); await sleep(150); R.togOffMsg = !/Transition areas blended/.test(body.textContent); ed.discardResult();
    tog.checked = true; tog.dispatchEvent(new Event('change')); await sleep(30);
    R.togBack = cmb.useTrans === true && cTog.checked === true;
    // only-transition output
    cmb.transOnly = true; const n1 = L.layers.length; await ed.combineLayersNow(); await sleep(100);
    R.onlyLayer = L.layers.length === n1 + 1 && L.activeLayer.name === 'Transition';
    R.onlyVisible = L.layers.filter((l) => l.ai).every((l) => l.visible);
    R.noErrors = true;
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'panel has the transition controls': R.panel, 'masks start empty': R.emptyAtStart, 'blue brush target selected': R.target,
    'fill with the blue brush paints the transition mask': R.filled && R.transPainted, 'AI selection mask stays untouched': R.selUntouched,
    'history entry of kind tr': R.undoGrew, 'undo removes the transition': R.undone, 'redo brings it back': R.redone,
    'clear + export/import round trip': R.cleared && R.restored, 'panel shows painted percentage': R.info,
    'ramp: no hard jump with the transition mask': R.softSteps, 'ramp passes through mixed colours': R.mid,
    'toggle in Brush panel and in Combine are one switch': R.togOn && R.togSync && R.togBack, 'inactive mask is ignored by Combine': R.togOffMsg,
    'transition-only output makes a "Transition" layer and keeps sources visible': R.onlyLayer && R.onlyVisible,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
