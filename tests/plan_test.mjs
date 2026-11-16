// Coverage heatmap, next view, mask-uncovered, crop, style lock, progress, variations and auto multi-view (fake generator).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.resolve(process.argv[2] || '/tmp/tp_layers');
fs.mkdirSync(out, { recursive: true });
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
const colors = ['#e03030', '#30c8c8', '#30c040', '#c030c0', '#3050e0', '#e0d030'];
let failed = false;
try {
  await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
  await page.waitForFunction('window.ready === true', { timeout: 20000 });
  const R = await page.evaluate(async (colors) => {
    const R = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = new window.TP.TexturePaintEditor();
    document.getElementById('host').append(ed.root);
    await sleep(300);
    const L = ed.layers;
    // ---- cube with a 3x2 atlas (each face an island inset by 1%)
    const faces = [
      { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] }, { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
      { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] }, { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
      { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] }, { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    ];
    let obj = '', vi = 1;
    const rects = [];
    faces.forEach((f, i) => {
      const col = i % 3, row = Math.floor(i / 3), m = 0.01;
      const u0 = col / 3 + m, u1 = (col + 1) / 3 - m, v0 = row / 2 + m, v1 = (row + 1) / 2 - m;
      rects.push({ x: Math.round(u0 * 1024), y: Math.round((1 - v1) * 1024), w: Math.round((u1 - u0) * 1024), h: Math.round((v1 - v0) * 1024) });
      const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      for (let k = 0; k < 4; k++) obj += `v ${f.v[k].join(' ')}\nvt ${uvs[k].join(' ')}\nvn ${f.n.join(' ')}\n`;
      const a = vi, b = vi + 1, c = vi + 2, d = vi + 3;
      obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\nf ${a}/${a}/${a} ${c}/${c}/${c} ${d}/${d}/${d}\n`;
      vi += 4;
    });
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'cube.obj');
    const tex = document.createElement('canvas'); tex.width = tex.height = 1024;
    const g = tex.getContext('2d'); g.fillStyle = '#101010'; g.fillRect(0, 0, 1024, 1024);
    rects.forEach((r, i) => { g.fillStyle = colors[i]; g.fillRect(r.x, r.y, r.w, r.h); });
    ed.setTextureFromImage(tex, { label: 'atlas', keepHistory: false });
    ed.frameModel();
    await sleep(300);

    const THREE = window.TP.THREE;
    const p3 = ed.ui.pane3d;
    const aiLayer = (rect, name) => {
      const c = document.createElement('canvas'); c.width = c.height = 1024; const g = c.getContext('2d'); g.fillStyle = '#20e060'; g.fillRect(rect.x, rect.y, rect.w, rect.h);
      return L.addLayer(L.fromImage(c), name, { prompt: name, ai: true });
    };
    // ---- 1) coverage with no AI layer
    let cv = ed.getCoverage();
    R.cov0 = { max: cv.max, frac: ed.coverageFraction(), islands: cv.islandTexels };
    // ---- 2) one AI layer on the +Z face (island 0)
    aiLayer(rects[0], 'AI: front');
    ed.flushCompose();
    cv = ed.getCoverage();
    R.cov1 = ed.coverageFraction();
    R.covMax = cv.max;
    // ---- 3) next view must look at uncovered faces (not +Z)
    const s = ed.suggestNextView();
    R.sug = { dir: s.dir.toArray().map((v) => +v.toFixed(2)), uncovered: +s.uncovered.toFixed(3) };
    // ---- 4) mask uncovered
    ed.maskClear();
    await ed.maskUncovered();
    await sleep(100);
    const mp = ed._readMaskPixels(), S = ed.maskSize;
    const cnt = (r) => { let n = 0; const x0 = Math.floor(r.x * S / 1024), x1 = Math.floor((r.x + r.w) * S / 1024), y0 = Math.floor((1024 - r.y - r.h) * S / 1024), y1 = Math.floor((1024 - r.y) * S / 1024); for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (mp[(y * S + x) * 4] > 127) n++; return [n, (x1 - x0) * (y1 - y0)]; };
    const front = cnt(rects[0]), back = cnt(rects[1]);
    R.maskFront = front[0] / front[1]; R.maskBack = back[0] / back[1];
    // ---- 5) heat map switches on and reaches both materials
    ed.state.plan.showCover = true; ed._applyStateToUI(); await sleep(400);
    R.heat = ed.meshMat.uniforms.uShowCover.value === 1 && !!ed.meshMat.uniforms.tCover.value && ed.uvMat.uniforms.uShowCover.value === 1;
    ed.state.plan.showCover = false; ed._applyStateToUI();
    // ---- 6) crop to mask: zoomed projection, same output size
    ed.maskClear(); ed.state.brush.size = 90;
    ed.frameModel(); ed.camera.position.multiplyScalar(2.6); ed.controls.update(); await sleep(250);
    ed.beginStroke(false); for (let i = 0; i < 6; i++) ed.strokeMove(p3.offsetWidth * 0.5 + i * 6, p3.offsetHeight * 0.5, 0); ed.endStroke(); await sleep(150);
    R.dbg = { empty: ed.maskIsEmpty(), ok: ed.state.capture.crop.enabled };
    const capA = await ed.capture({ includeMesh: false, includeTexture: false });
    ed.state.capture.crop.enabled = true;
    const capB = await ed.capture({ includeMesh: false, includeTexture: false });
    R.cropZoom = capB.meta.camera.proj[0] / capA.meta.camera.proj[0];
    R.cropSize = JSON.stringify(capA.meta.view_size) === JSON.stringify(capB.meta.view_size);
    R.cropMeta = capB.meta.crop.enabled === true;
    const cr = ed.cropRect(p3.offsetWidth, p3.offsetHeight); R.dbg.cr = cr; R.dbg.pa = capA.meta.camera.proj.slice(0,6); R.dbg.pb = capB.meta.camera.proj.slice(0,6);
    R.cropRect = !!cr && cr.zoom > 1.5 && cr.w > 4;
    ed.state.capture.crop.enabled = false;
    // ---- 7) style lock: active layer -> image 2 (cropped to the layer content)
    L.select(L.layers.length - 1);
    await ed.setRef2FromLayer('layer');
    R.styleLock = !!ed.state.ref2.has && Math.abs(ed.ref2Canvas.width - rects[0].w) < 6 && Math.abs(ed.ref2Canvas.height - rects[0].h) < 6;
    await ed.setRef2FromLayer('texture'); R.styleLockTex = ed.ref2Canvas.width === 1024;
    // ---- 8) progress + live preview
    ed.setProgress(0.5); R.prog = ed.ui.prog.style.display !== 'none' && ed.ui.progBar.style.width === '50%';
    ed.setProgress(null); R.progOff = ed.ui.prog.style.display === 'none';
    const pb = await new Promise((r) => rects && document.createElement('canvas').toBlob(r));
    const pc = document.createElement('canvas'); pc.width = pc.height = 8; ed.setLivePreview(await new Promise((r) => pc.toBlob(r))); R.live = ed.ui.live.style.display !== 'none';
    ed.setLivePreview(null); R.liveOff = ed.ui.live.style.display === 'none';
    // ---- 9) variations with a fake generator (different colours)
    const layerBmp = async (col) => { const c = document.createElement('canvas'); c.width = c.height = 1024; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(100, 100, 300, 300); return createImageBitmap(c); };
    let seed = 1000; const seeds = [];
    ed.hooks.getSeed = () => seed; ed.hooks.setSeed = (v) => { seed = v; seeds.push(v); };
    const cols = ['#ff0000', '#00ff00', '#0000ff', '#ffff00']; let gi = 0;
    ed.hooks.generate = async () => ({ bmp: await layerBmp(cols[gi++ % 4]), rem: null, stats: { prompt: 'var test' } });
    const cands = await ed.runVariations(4);
    R.varCount = cands.length; R.varSeeds = seeds.slice(0, 4).join(','); R.varSeedRestored = seed === 1000;
    R.varStrip = ed.ui.sec.plan.body.querySelectorAll('.tp-cand').length;
    ed.ui.sec.plan.body.querySelectorAll('.tp-cand')[2].click();
    R.varPick = !!ed.pending && ed.candidates[2].sel === true;
    ed.discardResult();
    // identical results -> warning
    ed.hooks.generate = async () => ({ bmp: await layerBmp('#ff00ff'), rem: null, stats: { prompt: 'same' } });
    await ed.runVariations(3);
    R.varIdentical = /identical/.test(ed.ui.msg.textContent);
    // ---- 10) auto multi-view with a fake generator that paints exactly the masked area
    ed.discardResult();
    while (L.layers.some((l) => l.ai)) { const i = L.layers.findIndex((l) => l.ai); L.remove(i); }
    ed.state.plan.target = 0.95; ed.state.plan.batchN = 6;
    let calls = 0;
    ed.hooks.generate = async () => {
      calls++;
      const mpx = ed._readMaskPixels(), S2 = ed.maskSize, c = document.createElement('canvas'); c.width = c.height = S2;
      const g = c.getContext('2d'), id = g.createImageData(S2, S2);
      for (let y = 0; y < S2; y++) for (let x = 0; x < S2; x++) { const src = ((S2 - 1 - y) * S2 + x) * 4, o = (y * S2 + x) * 4; id.data[o] = 40; id.data[o + 1] = 160; id.data[o + 2] = 220; id.data[o + 3] = mpx[src]; }
      g.putImageData(id, 0, 0);
      return { bmp: await createImageBitmap(c), rem: null, stats: { prompt: 'auto ' + calls } };
    };
    const before = L.layers.length;
    const res = await ed.runBatch({ views: 6, target: 0.95 });
    R.batch = { steps: res.steps, coverage: +res.coverage.toFixed(3), reason: res.reason, layersAdded: L.layers.length - before, ai: L.layers.filter((l) => l.ai).length, calls };
    R.busyReleased = ed._runBusy === false;
    // cancel works before the first step
    ed.hooks.generate = async () => { ed._runCancel = true; return { bmp: await layerBmp('#fff'), rem: null, stats: {} }; };
    const baseLayers = L.layers.length;
    while (L.layers.some((l) => l.ai)) { const i = L.layers.findIndex((l) => l.ai); L.remove(i); }
    const rc = await ed.runBatch({ views: 3, target: 0.99 });
    R.cancelled = rc.reason === 'stopped' && rc.steps === 0;
    return R;
  }, colors);
  console.log(JSON.stringify(R));
  const must = {
    'coverage: empty without AI layers': R.cov0.max === 0 && R.cov0.frac === 0 && R.cov0.islands > 100000,
    'coverage: one AI face = about 1/6 of the surface': R.covMax > 250 && Math.abs(R.cov1 - 1 / 6) < 0.02,
    'next view looks at uncovered faces (not +Z)': R.sug.dir[2] < 0 && R.sug.uncovered > 0.4,
    'mask uncovered: front untouched, other faces selected': R.maskFront < 0.02 && R.maskBack > 0.95,
    'heatmap uniforms active': R.heat,
    'crop to mask: zoomed projection, same output size, HUD rect': R.cropZoom > 1.5 && R.cropSize && R.cropMeta && R.cropRect,
    'style lock: active layer / texture become image 2': R.styleLock && R.styleLockTex,
    'progress bar + live preview': R.prog && R.progOff && R.live && R.liveOff,
    'variations: 4 candidates, consecutive seeds, seed restored, strip, pick previews': R.varCount === 4 && R.varSeeds === '1000,1001,1002,1003' && R.varSeedRestored && R.varStrip === 4 && R.varPick,
    'variations: identical results trigger the seed-wiring warning': R.varIdentical,
    'auto multi-view reaches the coverage target': R.batch.steps >= 1 && R.batch.coverage >= 0.95 && R.batch.ai === R.batch.steps && R.batch.layersAdded === R.batch.steps && R.batch.calls === R.batch.steps,
    'auto run releases the busy flag; stop works': R.busyReleased && R.cancelled,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
