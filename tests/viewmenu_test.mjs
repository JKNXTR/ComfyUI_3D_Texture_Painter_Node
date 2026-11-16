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
    const ed = new window.TP.TexturePaintEditor(); document.getElementById('host').append(ed.root); await sleep(300);
    const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
    const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
    let s = 'o Cube\n'; for (const p of P) s += `v ${p[0]} ${p[1]} ${p[2]}\n`;
    s += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
    for (const f of F) s += `f ${f[0]+1}/1 ${f[1]+1}/2 ${f[2]+1}/3\nf ${f[0]+1}/1 ${f[2]+1}/3 ${f[3]+1}/4\n`;
    await ed.loadModelBuffer(new TextEncoder().encode(s).buffer, 'cube.obj'); await sleep(300);
    const p3 = ed.ui.pane3d, bar = p3.querySelector('.tp-vmbar');
    const sel = bar.querySelector('select'), [bAdd, bRen, bDel] = bar.querySelectorAll('button'), link = bar.querySelectorAll('select')[1], nameIn = bar.querySelector('input');
    const dir = () => ed._camDir().toArray().map((v) => Math.round(v * 100) / 100);
    const pick = async (v) => { sel.value = v; sel.dispatchEvent(new Event('change')); await sleep(500); };
    R.opts = { std: [...sel.options].filter((o) => o.value.startsWith('std:')).length };
    await pick('std:top'); R.top = dir();
    await pick('std:left'); R.left = dir();
    await pick('std:back'); R.back = dir();
    // ---- save / rename / link / go / delete
    await pick('std:right'); bAdd.click();
    R.added = { n: ed.state.bookmarks.length, renaming: nameIn.style.display !== 'none' };
    nameIn.value = 'Hero side'; nameIn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    R.renamed = ed.state.bookmarks[0].name === 'Hero side' && [...sel.options].some((o) => o.textContent.startsWith('Hero side'));
    await pick('std:top'); await pick('bm:0'); R.goBm = dir();
    // linked view activates its reference image
    ed.state.refx[1].has = true; ed.state.refx[1].cam = { name: 'x', pos: [3, 0.5, 3], target: [0, 0, 0], ortho: false };
    ed.viewMenuRefresh(); link.value = '4'; link.dispatchEvent(new Event('change'));
    R.linked = ed.state.bookmarks[0].ref === 4;
    ed.setRefActive(3); await pick('std:front'); await pick('bm:0'); R.linkSwitch = ed.refActive === 4;
    // reference angle entry
    ed.setRefActive(2); await pick('ref:4'); R.refAngle = ed.refActive === 4 && Math.abs(ed.camera.position.x - 3) < 0.01;
    // delete needs two clicks
    await pick('bm:0'); bDel.click(); R.delArm = ed.state.bookmarks.length === 1; bDel.click(); R.deleted = ed.state.bookmarks.length === 0;
    // ---- layer adjustment
    const solid = (c) => { const k = document.createElement('canvas'); k.width = k.height = 64; const g = k.getContext('2d'); g.fillStyle = c; g.fillRect(0, 0, 64, 64); return k; };
    const L = ed.layers; L.addLayer(L.fromImage(solid('#806040')), 'adj test');
    const px = () => { const c = L.bakeCanvas(0); return Array.from(c.getContext('2d').getImageData(c.width / 2, c.height / 2, 1, 1).data.slice(0, 3)); };
    const base = px();
    const labels = [...ed.ui.sec.layers.body.querySelectorAll('.tp-lbl')].map((e) => e.textContent);
    R.adjUi = labels.includes('Brightness') && labels.includes('Hue') && labels.some((t) => t.startsWith('Levels: gamma'));
    L.setProp(L.active, { adj: { bri: 0.2 } }); const bright = px();
    L.setProp(L.active, { adj: { sat: -1 } }); const grey = px();
    L.setProp(L.active, { adj: { hue: 180 } }); const hue = px();
    L.setProp(L.active, { adj: { lb: 0.5 } }); const lev = px();
    R.adj = { base, bright, grey, hue, lev };
    L.setProp(L.active, { adj: { con: 0.6 } }); R.contrast = px();
    const ser = JSON.parse(JSON.stringify(L.serialize())); R.serialised = !!ser.stack[ser.stack.length - 1].adj && ser.stack[0].adj === null;
    L.setProp(L.active, { adj: null }); R.reset = px().join() === base.join();
    ed.undo(); R.undoAdj = px().join() === R.contrast.join();
    L.setProp(L.active, { adj: { bri: 0.2 } });
    const rt = L.adjustedRT(L.activeLayer); R.adjRT = !!rt; if (rt) rt.dispose();
    L.setProp(L.active, { adj: null }); R.noAdjRT = L.adjustedRT(L.activeLayer) === null;
    // ---- prompt preview
    const txt = () => ed.ui.paneUV.querySelector('.tp-ppt').textContent;
    const wd = { prompt: 'brick', style_hint: 'flat', compose_prompt: true, mask_hint: 'tint_color', hint_color: '#ff00ff' };
    ed.hooks.getWidgets = () => wd;
    ed.state.ref2.enabled = false; ed.state.refx[1].has = false;
    ed.state.refx[3] = { ...ed.state.refx[3], has: true, enabled: true, weight: 1.0, angle: 'back', role: 'red paint' };
    ed.refxBlobs[3] = new Blob(['x']);
    ed.promptPreviewUpdate();
    R.prompt = txt();
    R.promptExpect = 'Repaint only the magenta marked area: brick. Image 6 shows the subject from the back. Image 6: red paint. Use image 6 as a strongly reference for the material and pattern in the marked area. flat. Keep everything outside the marked area exactly unchanged.';
    wd.mask_hint = 'none'; ed.promptPreviewUpdate(); R.promptNone = txt();
    wd.compose_prompt = false; ed.promptPreviewUpdate(); R.promptRaw = txt();
    wd.compose_prompt = true; wd.mask_hint = 'gray_fill'; ed.state.refx[3].weight = 0; ed.promptPreviewUpdate(); R.promptGray = txt();
    ed.ui.paneUV.querySelector('.tp-pph button:last-child').click(); R.collapsed = ed.ui.paneUV.querySelector('.tp-ppt').style.display === 'none';
    ed.ui.paneUV.querySelector('.tp-pph button:last-child').click();
    return R;
  });
  console.log(JSON.stringify(R));
  const near = (v, e) => v.every((x, i) => Math.abs(x - e[i]) < 0.12);
  const must = {
    'dropdown lists the six standard views': R.opts.std === 6,
    'standard views move the camera (top / left / back)': R.top[1] > 0.95 && R.left[0] < -0.95 && R.back[2] < -0.95,
    'save a view, rename it inline, it appears in the list': R.added.n === 1 && R.added.renaming && R.renamed,
    'going to a saved view restores the camera': near(R.goBm, [1, 0, 0]),
    'a view linked to a reference image activates that image': R.linked && R.linkSwitch,
    'reference-angle entry goes to the saved angle and activates the slot': R.refAngle,
    'delete needs a second click': R.delArm && R.deleted,
    'layer adjustment sliders exist': R.adjUi,
    'brightness / saturation / hue / levels change the composite': R.adj.bright[0] > R.adj.base[0] + 20 && Math.max(...R.adj.grey) - Math.min(...R.adj.grey) < 6 && R.adj.hue[2] > R.adj.hue[0] && R.adj.lev[0] < R.adj.base[0] - 20,
    'contrast changes it, reset restores it, undo works': R.contrast.join() !== R.adj.base.join() && R.reset && R.undoAdj,
    'adjustment is saved with the layer stack': R.serialised,
    'adjustedRT only for adjusted layers (used by Combine layers)': R.adjRT && R.noAdjRT,
    'prompt preview equals the text the Python node builds': R.prompt === R.promptExpect,
    'prompt preview: no-mask / raw / gray variants': R.promptNone.startsWith('brick. flat.') && R.promptRaw === 'brick' && R.promptGray.startsWith('Repaint only the gray marked area: brick. Image 6 shows') && !R.promptGray.includes('strongly'),
    'prompt panel collapses': R.collapsed,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) { failed = true; console.log('TEST FAILURE:', e.stack || e); }
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
