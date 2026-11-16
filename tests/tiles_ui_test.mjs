// Object hierarchy: tree, working-object switch (own UVs / layers / mask), context meshes, hide buttons, persistence meta.
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
  const R = await page.evaluate(async () => {
    const R = {}; const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const calls = [];
    const ed = new window.TP.TexturePaintEditor({ hooks: { generate: async () => {
      const out = await ed.capture({ includeMesh: false, includeTexture: true });
      calls.push({ tile: out.meta.tile, uv: out.meta.uv_mode, long: out.meta.tile_long });
      const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.fillStyle = '#0f0'; g.fillRect(0, 0, 64, 64);
      return { bmp: await createImageBitmap(c), rem: null, stats: { prompt: 'tile' } };
    } } });
    document.getElementById('host').append(ed.root); await sleep(300);
    const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
    const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
    let s = 'o Cube\n'; for (const p of P) s += `v ${p[0]} ${p[1]} ${p[2]}\n`;
    s += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
    for (const f of F) s += `f ${f[0]+1}/1 ${f[1]+1}/2 ${f[2]+1}/3\nf ${f[0]+1}/1 ${f[2]+1}/3 ${f[3]+1}/4\n`;
    await ed.loadModelBuffer(new TextEncoder().encode(s).buffer, 'cube.obj'); await sleep(300);
    const box = ed.ui.paneUV.querySelector('.tp-tilebox');
    R.hiddenFirst = box.style.display === 'none';
    const uvCb = [...ed.ui.paneUV.querySelectorAll('input[type=checkbox]')].find((c) => /UV texture output/.test(c.parentElement.textContent));
    uvCb.checked = true; uvCb.dispatchEvent(new Event('change', { bubbles: true })); await sleep(50);
    R.shown = box.style.display !== 'none';
    const on = [...box.querySelectorAll('input[type=checkbox]')][0]; on.checked = true; on.dispatchEvent(new Event('change', { bubbles: true })); await sleep(50);
    const rs = [...box.querySelectorAll('input[type=range]')];
    const setR = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
    setR(rs[0], 2); setR(rs[1], 2); setR(rs[2], 12);
    R.empty = /^0 of 4 tiles/.test(box.querySelector('.tp-note').textContent);
    ed.maskFill(); await sleep(100);
    ed._tileSync(); R.full = /^4 of 4 tiles/.test(box.querySelector('.tp-note').textContent);
    const plan = ed.tilePlan(); R.plan = plan.list.join(',') === '0,1,2,3' && plan.tiles.length === 4;
    // sequential run: one generate per tile, each capture carries index + the tiles done so far
    const before = ed.layers.layers.length;
    const res = await ed.runTiles();
    R.seqDone = res.done === 4 && calls.length === 4;
    R.seqMeta = calls.every((c, i) => c.uv === true && c.tile && c.tile.on && c.tile.index === i && c.tile.done.join(',') === [0, 1, 2, 3].slice(0, i).join(',') && c.tile.mode === 'seq' && c.long === 1024);
    R.layersAdded = ed.layers.layers.length === before + 4;
    R.runCleared = ed._tileRun === null && ed._runBusy === false;
    // batch: ONE generate, index -1
    calls.length = 0; const sel = box.querySelector('select'); sel.value = 'batch'; sel.dispatchEvent(new Event('change', { bubbles: true }));
    ed.maskFill(); await sleep(50);
    const rb = await ed.runTiles(); R.batch = rb.done === 4 && calls.length === 1 && calls[0].tile.index === -1 && calls[0].tile.mode === 'batch';
    // stop: cancel flag honoured between tiles
    sel.value = 'seq'; sel.dispatchEvent(new Event('change', { bubbles: true })); ed.maskFill(); calls.length = 0;
    const origGen = ed.hooks.generate; let n = 0; ed.hooks.generate = async () => { n++; if (n === 2) ed.stopRuns(); return origGen(); };
    const rs2 = await ed.runTiles(); R.stopped = rs2.reason === 'stopped' && rs2.done === 1;
    // ---- reference images by angle: option, status list, camera passes, prompt text
    uvCb.checked = true; uvCb.dispatchEvent(new Event('change', { bubbles: true })); await sleep(30);
    const refCb = [...box.querySelectorAll('input[type=checkbox]')].find((c) => /Use reference images/.test(c.parentElement.textContent));
    R.refUi = !!refCb && refCb.checked === false;
    const k = document.createElement('canvas'); k.width = k.height = 64; const kg = k.getContext('2d'); kg.fillStyle = '#d22'; kg.fillRect(0, 0, 64, 64);
    await ed.setRef2Image(new File([await new Promise((r) => k.toBlob(r))], 'ref.png', { type: 'image/png' }));
    ed.state.ref2.enabled = true; ed.state.ref2.angle = 'front';
    refCb.checked = true; refCb.dispatchEvent(new Event('change', { bubbles: true })); await sleep(30);
    R.refOn = ed.state.capture.uvref.on === true;
    R.refStatus = /Image 2: front .*angle label/.test(box.textContent);
    const pose0 = JSON.stringify(ed.cameraPose().pos.map((v) => Math.round(v * 1e4)));
    const cap = await ed.capture({ includeMesh: false, includeTexture: false });
    R.refPasses = cap.refdepth.length === 1 && cap.refdepth[0].n === 2 && cap.meta.ref_cams.length === 1 && cap.meta.ref_cams[0].source === 'angle label' && cap.meta.ref_cams[0].camera.width === cap.meta.view_size[0] && !!cap.meta.uvref;
    R.camRestored = JSON.stringify(ed.cameraPose().pos.map((v) => Math.round(v * 1e4))) === pose0;
    // front = camera on +Z looking at the model
    R.frontDir = (() => { const v = cap.meta.ref_cams[0].camera.position; return v[2] > 0 && Math.abs(v[0]) < 1e-3; })();
    // saved angle beats the label, the placed view beats both
    ed.state.ref2.cam = { name: 'x', pos: [3, 0.5, 3], target: [0, 0, 0], ortho: false };
    R.srcSaved = ed.refPose(2).source === 'saved angle';
    ed.state.ref2.mode = 'manual'; ed.state.ref2.pcam = { name: 'placed', pos: [0, 0, 4], target: [0, 0, 0], ortho: false };
    R.srcPlaced = ed.refPose(2).source === 'placed view';
    // placing records the camera
    ed.state.ref2.pcam = null; ed.setPlaceMode(true); R.pcamOnPlace = !!ed.state.ref2.pcam && ed.state.ref2.pcam.pos.length === 3; ed.setPlaceMode(false);
    // prompt text mirrors the node
    const pr = window.TP.composePrompt({ prompt: 'skin', style_hint: '', compose_prompt: true, mask_hint: 'tint_color', hint_color: '#ff00ff' }, ed.state, true, [false, false, false, false], [{ n: 2, angle: 'front' }, { n: 3, angle: '' }]);
    R.refPrompt = pr.includes('Use image 2 as a clearly reference for the material and pattern in the marked area: it shows the same area of the texture painted from the reference photos (front, image 3).') && !pr.includes('Image 2 shows');
    // without a label / camera nothing is sent
    ed.state.ref2.cam = null; ed.state.ref2.pcam = null; ed.state.ref2.mode = 'mask'; ed.state.ref2.angle = '';
    const cap2 = await ed.capture({ includeMesh: false, includeTexture: false }); R.refNone = cap2.refdepth.length === 0 && cap2.meta.ref_cams.length === 0;
    refCb.checked = false; refCb.dispatchEvent(new Event('change', { bubbles: true }));
    const cap3 = await ed.capture({ includeMesh: false, includeTexture: false }); R.refOff = cap3.meta.uvref === null;
    // UV output off: run refuses, no meta tile
    uvCb.checked = false; uvCb.dispatchEvent(new Event('change', { bubbles: true })); await sleep(30);
    R.hiddenAgain = box.style.display === 'none';
    const out2 = await ed.capture({ includeMesh: false, includeTexture: true }); R.noMeta = out2.meta.tile === null;
    return R;
  });
  console.log(JSON.stringify(R));
  const must = { 'panel hidden until UV output is on': R.hiddenFirst, 'panel shown with UV output': R.shown, 'empty mask: 0 of 4 tiles': R.empty,
    'full mask: 4 of 4 tiles': R.full, 'tile plan lists the 4 tiles': R.plan, 'sequential: one generate per tile': R.seqDone,
    'each capture carries tile index, done list, mode, long side': R.seqMeta, 'every tile result became a layer': R.layersAdded, 'run state cleaned up': R.runCleared,
    'batch: one generate, index -1': R.batch, 'stop is honoured between tiles': R.stopped, 'panel hides with UV output off': R.hiddenAgain, 'no tile meta without UV output': R.noMeta,
    'reference option present': R.refUi, 'option stored': R.refOn, 'status list shows the angle source': R.refStatus,
    'depth pass + camera per reference': R.refPasses, 'camera restored after the passes': R.camRestored, 'front = camera on +Z': R.frontDir,
    'saved angle beats the label': R.srcSaved, 'placed view beats everything': R.srcPlaced, 'placing records its camera': R.pcamOnPlace,
    'prompt text mirrors the node': R.refPrompt, 'no camera = nothing sent': R.refNone, 'option off = no meta': R.refOff };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) { failed = true; console.log('TEST FAILURE:', e.stack || e); }
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
