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
    const p3 = ed.ui.pane3d;
    // ---- grid switch
    const gridCb = p3.querySelector('.tp-vbar input');
    R.grid = { has: !!gridCb, on: ed.grid.visible };
    gridCb.checked = false; gridCb.dispatchEvent(new Event('change')); R.grid.off = ed.grid.visible === false && ed.state.display.grid === false;
    gridCb.checked = true; gridCb.dispatchEvent(new Event('change')); R.grid.back = ed.grid.visible === true;
    // ---- panel + colours
    const rows = ed.ui.sec.views.body.querySelectorAll('input[type=color]');
    R.panel = { rows: rows.length, colors: ed.state.refx.map((r) => r.color).join(',') };
    // ---- quick menu: right click (no drag) opens, controls drive the tool
    const ev = (type, o) => p3.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: 400, clientY: 300, pointerId: 1, ...o }));
    ev('pointerdown', { button: 2, buttons: 2 }); ev('pointerup', { button: 2, buttons: 0 });
    const menu = () => ed.root.querySelector('.tp-qmenu');
    R.menu = { open: !!menu(), sliders: menu() ? menu().querySelectorAll('input[type=range]').length : 0 };
    const rng = menu().querySelector('input[type=range]'); rng.value = 150; rng.dispatchEvent(new Event('input', { bubbles: true }));
    R.menu.size = ed.state.brush.size === 150;
    const btns = [...menu().querySelectorAll('button')]; btns.find((b) => b.textContent === 'Eraser').click();
    R.menu.erase = ed.state.tool === 'erase';
    const rng2 = menu().querySelector('input[type=range]'); rng2.value = 33; rng2.dispatchEvent(new Event('input', { bubbles: true }));
    R.menu.eraserOwn = ed.state.erase.size === 33 && ed.state.brush.size === 150;
    [...menu().querySelectorAll('button')].find((b) => b.textContent === 'Brush').click();
    [...menu().querySelectorAll('.tp-qrow')][1].querySelectorAll('button')[1].click();   // view region 4
    R.menu.view = ed.state.brushTarget === 'view' && ed.state.views.active === 1;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); R.menu.closed = !menu();
    // a drag with the right button must not open it
    ev('pointerdown', { button: 2, buttons: 2, clientX: 400 }); p3.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 2, clientX: 460, clientY: 300, pointerId: 1 }));
    R.menu.dragNoOpen = !menu();
    // ---- view region painting (slot index 1 = reference image 4)
    ed.state.brush.size = 120; ed.setTool('brush'); ed.state.brushTarget = 'view'; ed.state.views.active = 1;
    ed.frameModel(); await sleep(150);
    const W = p3.offsetWidth, H = p3.offsetHeight;
    const stroke = (erase) => { ed.beginStroke(erase); for (let i = 0; i < 8; i++) ed.strokeMove(W * 0.5 + i * 6, H * 0.5, 0); ed.endStroke(); };
    stroke(false);
    const sum = (i) => { const b = ed._readRT(ed.viewRT[i]); let t = 0; for (let k = 0; k < b.length; k += 4) t += b[k]; return t; };
    R.paint = { has: ed.viewHas.join(), own: sum(1) > 1000, others: sum(0) + sum(2) + sum(3), maskEmpty: ed.maskIsEmpty(), stateHas: ed.state.views.has.join() };
    const before = sum(1);
    ed.setTool('erase'); stroke(true); R.erased = sum(1) < before * 0.9;
    ed.undo(); R.undone = Math.abs(sum(1) - before) < before * 0.02;
    ed.redo(); R.redone = sum(1) < before * 0.9; ed.undo();
    // ---- region -> AI mask (replace / add)
    R.toMask = ed.viewToMask(1) && !ed.maskIsEmpty();
    ed.undo(); R.toMaskUndo = ed.maskIsEmpty();
    // ---- export / import round trip into another slot
    const blob = await ed.exportViewBlob(1); await ed.importViewBitmap(2, await createImageBitmap(blob), { undo: false });
    R.roundtrip = Math.abs(sum(2) - sum(1)) < sum(1) * 0.03 && ed.viewHas[2] === true;
    // ---- capture sends only regions of slots that have an image
    const c0 = await ed.capture({ includeMesh: false, includeTexture: false });
    R.capNone = c0.viewrgn.length === 0 && c0.meta.view_regions.join() === 'false,false,false,false';
    const img = document.createElement('canvas'); img.width = img.height = 64; const g = img.getContext('2d'); g.fillStyle = '#c33'; g.fillRect(0, 0, 64, 64);
    await ed.loadRefxBlob(1, await new Promise((r) => img.toBlob(r)));
    const c1 = await ed.capture({ includeMesh: false, includeTexture: false });
    const vb = await createImageBitmap(c1.viewrgn[0].blob); const k = document.createElement('canvas'); k.width = vb.width; k.height = vb.height; k.getContext('2d').drawImage(vb, 0, 0);
    const d = k.getContext('2d').getImageData(0, 0, k.width, k.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 100) lit++;
    R.capOne = { n: c1.viewrgn.length, slot: c1.viewrgn[0].i, flags: c1.meta.view_regions.join(), lit };
    // ---- placed-reference preview is clipped to the region of the active slot
    ed._viewClipUniforms(4); R.clip = ed.meshMat.uniforms.uRefRegion.value === 1; ed._viewClipUniforms(6); R.clipOff = ed.meshMat.uniforms.uRefRegion.value === 0;
    // ---- clear + state
    ed.viewClear(1); R.cleared = ed.viewHas[1] === false && sum(1) === 0;
    R.state = JSON.stringify(ed.getState().views.has);
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'grid switch hides / shows the grid': R.grid.has && R.grid.on && R.grid.off && R.grid.back,
    'views panel: 4 colour pickers with distinct default colours': R.panel.rows === 4 && new Set(R.panel.colors.split(',')).size === 4,
    'right click opens the quick menu with 6 sliders': R.menu.open && R.menu.sliders === 6,
    'menu sliders edit the tool in use; eraser keeps its own size': R.menu.size && R.menu.erase && R.menu.eraserOwn,
    'menu selects the view-region target; Escape closes; right-drag does not open': R.menu.view && R.menu.closed && R.menu.dragNoOpen,
    'painting a view region fills only that region, not the AI mask': R.paint.own && R.paint.others === 0 && R.paint.maskEmpty && R.paint.has === 'false,true,false,false',
    'erase removes part of the region; undo / redo work': R.erased && R.undone && R.redone,
    'region -> AI mask (undoable)': R.toMask && R.toMaskUndo,
    'region export / import round trip': R.roundtrip,
    'capture without reference images sends no regions': R.capNone,
    'capture sends the region of the slot that has an image, seen from the camera': R.capOne.n === 1 && R.capOne.slot === 1 && R.capOne.flags === 'false,true,false,false' && R.capOne.lit > 500,
    'placement preview clipped to the active slot region': R.clip && R.clipOff,
    'clear + state flags': R.cleared && R.state === '[false,false,true,false]',
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) { failed = true; console.log('TEST FAILURE:', e.stack || e); }
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
