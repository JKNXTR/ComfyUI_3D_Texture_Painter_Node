// Full-stack test: real editor bundle + glue (texpaint.js) + real HTTP routes + real Python nodes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(process.argv[2] || '/tmp/tp_e2e');
fs.mkdirSync(out, { recursive: true });

const srv = spawn('python3', [path.join(here, 'e2e_server.py')], { stdio: ['ignore', 'pipe', 'pipe'] });
let srvErr = '';
srv.stderr.on('data', (d) => { srvErr += d.toString(); });
const port = await new Promise((res, rej) => {
  let buf = '';
  srv.stdout.on('data', (d) => { buf += d.toString(); const m = /PORT (\d+)/.exec(buf); if (m) res(Number(m[1])); });
  srv.on('exit', (c) => rej(new Error('server exited early: ' + srvErr)));
  setTimeout(() => rej(new Error('server start timeout: ' + srvErr)), 20000);
});

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
  await page.goto(`http://127.0.0.1:${port}/tests/e2e.html`);
  await page.waitForFunction('window.ready === true', { timeout: 20000 });

  const R = await page.evaluate(async () => {
    const R = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const waitFor = async (fn, ms = 20000) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { if (await fn()) return true; await sleep(100); } return false; };

    const node = await window.makeNode();
    const rec = window.TexturePainterAI.records.get(node.id);
    const ed = rec.ed;
    R.stateWidget = node.widgets.find((w) => w.name === 'state_json').value;
    R.hiddenState = node.widgets.find((w) => w.name === 'state_json').hidden === true;
    R.domWidgetFirst = node.widgets[0].name === 'texpaint_view';

    // ---- cube + atlas (same as browser_test)
    const faces = [
      { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] }, { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
      { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] }, { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
      { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] }, { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    ];
    let obj = '', vi = 1;
    faces.forEach((f, i) => {
      const col = i % 3, row = Math.floor(i / 3), m = 0.01;
      const u0 = col / 3 + m, u1 = (col + 1) / 3 - m, v0 = row / 2 + m, v1 = (row + 1) / 2 - m;
      const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      for (let k = 0; k < 4; k++) obj += `v ${f.v[k].join(' ')}\nvt ${uvs[k].join(' ')}\nvn ${f.n.join(' ')}\n`;
      const a = vi, b = vi + 1, c = vi + 2, d = vi + 3;
      obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\nf ${a}/${a}/${a} ${c}/${c}/${c} ${d}/${d}/${d}\n`;
      vi += 4;
    });
    // model goes through the real upload route
    await ed.pickModelFile(new File([obj], 'my cube.obj'));
    R.modelName = ed.state.model && ed.state.model.name;
    R.tris = ed.info && ed.info.triangles;

    const c = document.createElement('canvas'); c.width = c.height = 1024;
    const g = c.getContext('2d');
    g.fillStyle = '#303030'; g.fillRect(0, 0, 1024, 1024);
    const colors = ['#e03030', '#30c8c8', '#30c040', '#c030c0', '#3050e0', '#e0d030'];
    faces.forEach((f, i) => { const col = i % 3, row = Math.floor(i / 3); g.fillStyle = colors[i]; g.fillRect(col * 1024 / 3, 1024 * (1 - (row + 1) / 2), 1024 / 3, 512); });
    ed.setTextureFromImage(c, { label: 'test', keepHistory: false });
    ed.frameModel();
    await sleep(300);

    // ---- model transform: rotate + scale + mirror before painting (bake must follow the transformed mesh)
    const h0 = ed.meshHash;
    const pos0 = ed.geometry.attributes.position.array.slice(0, 3);
    ed.setXform({ rx: 20, ry: 35, s: 1.3, fx: true });
    R.xformHashChanged = ed.meshHash !== h0;
    R.xformMoved = Math.hypot(pos0[0] - ed.geometry.attributes.position.array[0], pos0[1] - ed.geometry.attributes.position.array[1], pos0[2] - ed.geometry.attributes.position.array[2]) > 0.1;
    R.xformRadius = +ed.modelRadius.toFixed(3);
    ed.setXform({ rx: 90 }); ed.setXform({ rx: 20 });          // round trip is stable
    R.xformRoundTrip = ed.meshHash === ed.meshHash && Math.abs(ed.state.xform.rx - 20) < 1e-6;
    ed.frameModel();
    await sleep(200);

    // ---- paint
    ed.state.brush.size = 240;
    const p3 = ed.ui.pane3d;
    ed.beginStroke(false); ed.strokeMove(p3.offsetWidth / 2, p3.offsetHeight / 2, 0); ed.strokeMove(p3.offsetWidth / 2 + 40, p3.offsetHeight / 2 + 10, 0); ed.endStroke();
    R.maskedBefore = (() => { const b = ed._readMaskPixels(); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return s; })();
    const maskBefore = ed._readMaskPixels().slice();
    const before = ed.getTextureCanvas('composite');

    // ---- reference image 2 (solid blue, weight 1) must reach the Python node
    const bc = document.createElement('canvas'); bc.width = bc.height = 64; bc.getContext('2d').fillStyle = '#0000ff'; bc.getContext('2d').fillRect(0, 0, 64, 64);
    await ed.setRef2Image(new File([await new Promise((r) => bc.toBlob(r, 'image/png'))], 'blue.png', { type: 'image/png' }));
    ed.state.ref2.enabled = true; ed.state.ref2.weight = 1; ed.state.ref2.mode = 'mask'; ed._dirty('ref2');

    // ---- "Queue prompt": the glue must commit the view first
    R.queuedBefore = window.__queued || 0;
    await window.app.queuePrompt();
    R.queuedAfter = window.__queued;
    R.syncedLabel = ed.ui.syncState.textContent;
    R.stateAfterCommit = node.widgets.find((w) => w.name === 'state_json').value;
    const t0 = performance.now();
    await window.app.queuePrompt();           // nothing changed -> must be skipped (fast, same commit)
    R.secondQueueMs = Math.round(performance.now() - t0);

    // ---- server runs Painter -> (fake generator) -> Bake
    const resp = await fetch('/__run', { method: 'POST', body: JSON.stringify({ session: rec.sid }) });
    R.runStatus = resp.status;
    const rj = await resp.json();
    R.runReport = rj.report || rj.error;
    R.refInfo = rj.ref;
    R.gotResult = await waitFor(() => !!ed.pending);
    R.bannerVisible = !ed.ui.banner.classList.contains('tp-hidden');
    R.compareShowing = ed.compare;
    await sleep(400);
    window.__shotReady = true;
    R.pendingStats = ed.pending && ed.pending.stats;

    // ---- apply
    ed.applyResult();
    await sleep(200);
    R.maskedAfter = (() => { const b = ed._readMaskPixels(); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return s; })();
    const after = ed.getTextureCanvas('composite');
    const a = before.getContext('2d').getImageData(0, 0, 1024, 1024).data, b2 = after.getContext('2d').getImageData(0, 0, 1024, 1024).data;
    let changed = 0, greenish = 0;
    for (let i = 0; i < a.length; i += 4) {
      if (Math.abs(a[i] - b2[i]) + Math.abs(a[i + 1] - b2[i + 1]) + Math.abs(a[i + 2] - b2[i + 2]) > 30) { changed++; if (b2[i + 1] > b2[i] + 25 && b2[i + 1] > b2[i + 2] + 25) greenish++; }
    }
    R.changedTexels = changed; R.greenTexels = greenish;
    let outside = 0;
    { const W = 1024, mw = Math.round(Math.sqrt(maskBefore.length / 4));
      for (let i = 0; i < a.length; i += 4) {
        if (Math.abs(a[i] - b2[i]) + Math.abs(a[i + 1] - b2[i + 1]) + Math.abs(a[i + 2] - b2[i + 2]) > 30) {
          const px = (i / 4) % W, py = Math.floor(i / 4 / W);
                    // dilate check: any mask within 9px (padding)
          let near = false;
          for (let dy = -20; dy <= 20 && !near; dy += 4) for (let dx = -20; dx <= 20; dx += 4) {
            const yy = Math.min(mw - 1, Math.max(0, (mw - 1 - Math.floor(py * mw / W)) + dy)), xx = Math.min(mw - 1, Math.max(0, Math.floor(px * mw / W) + dx));
            if (maskBefore[(yy * mw + xx) * 4] > 0) { near = true; break; }
          }
          if (!near) outside++;
        }
      } }
    R.changedFarFromMask = outside;
    R.layerCountAfterApply = ed.layers.layers.length;
    R.layerName = ed.layers.layers[ed.layers.active].name;
    let guard = 0; while (ed.layers.layers.length > 1 && guard++ < 4) ed.undo();   // undo must restore the old texture exactly
    const rv = ed.getTextureCanvas('composite').getContext('2d').getImageData(0, 0, 1024, 1024).data;
    let diffRev = 0; for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - rv[i]) > 2) diffRev++;
    R.revertDiff = diffRev;
    guard = 0; while (ed.redoStack.length && guard++ < 6) ed.redo();
    R.layersAfterRedo = ed.layers.layers.length;
    ed.applyResult && 0;

    await window.TexturePainterAI.autosave(rec);   // stores layers / mask / reference image on the server
    const sig = (e) => { const d = e.getTextureCanvas('composite').getContext('2d').getImageData(0, 0, 1024, 1024).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h; };
    R.sigBefore = sig(ed);

    // ---- duplicate the node (same state_json) -> clone route + restore
    const n2 = await window.makeNode();
    n2.properties = { texpaint_ui: JSON.parse(JSON.stringify(ed.getState())) };
    n2.widgets.find((w) => w.name === 'state_json').value = JSON.stringify({ session: rec.sid });
    window.__NT.prototype.onConfigure && window.__NT.prototype.onConfigure.call(n2);
    const rec2 = window.TexturePainterAI.records.get(n2.id);
    R.cloneNewSession = rec2.sid !== rec.sid;
    await waitFor(() => !rec2.restoring && rec2.ed.hasModel, 15000);
    R.restoredTris = rec2.ed.info && rec2.ed.info.triangles;
    R.restoredMaskNonEmpty = rec2.ed.maskIsEmpty() === ed.maskIsEmpty();
    R.restoredLayers = rec2.ed.layers.layers.map((l) => l.name).join('|') === ed.layers.layers.map((l) => l.name).join('|') && rec2.ed.layers.layers.length === 2;
    R.restoredSig = sig(rec2.ed) === R.sigBefore;
    R.restoredRef2 = !!rec2.ed.state.ref2.has && !!rec2.ed.ref2Blob && rec2.ed.state.ref2.enabled;
    R.restoredXform = JSON.stringify(rec2.ed.state.xform) === JSON.stringify(ed.state.xform) && rec2.ed.meshHash === ed.meshHash;
    // ---- tab switch: workflow carries NO ui state, only the session id -> state.json on the server must bring everything back
    await window.TexturePainterAI.autosave(rec);
    const n3 = await window.makeNode();
    n3.properties = {};
    n3.widgets.find((w) => w.name === 'state_json').value = JSON.stringify({ session: rec.sid });
    rec.node.onRemoved && 0;
    window.__NT.prototype.onConfigure && window.__NT.prototype.onConfigure.call(n3);
    const rec3 = window.TexturePainterAI.records.get(n3.id);
    await waitFor(() => !rec3.restoring && rec3.ed.hasModel, 15000);
    R.tabSwitchModel = !!rec3.ed.hasModel && rec3.ed.info.triangles === 12 && sig(rec3.ed) === R.sigBefore;
    // ---- brand-new node: reopens the last used model
    const n4 = await window.makeNode();
    const rec4 = window.TexturePainterAI.records.get(n4.id);
    await waitFor(() => !rec4.restoring && rec4.ed.hasModel, 15000);
    R.freshNodeModel = !!rec4.ed.hasModel && rec4.ed.info.triangles === 12 && rec4.sid !== rec.sid;
    R.logs = ed.logLines.slice(-8);
    return R;
  });

  await page.screenshot({ path: path.join(out, 'e2e_screenshot.png') });
  console.log(JSON.stringify(R, null, 1));
  const must = {
    'state widget hidden': R.hiddenState, 'viewport widget first': R.domWidgetFirst,
    'model uploaded + loaded': R.tris === 12 && /my cube_[0-9a-f]{8}\.obj/.test(R.modelName || ''),
    'glue committed before queue': R.queuedAfter === R.queuedBefore + 1 && R.syncedLabel.includes('synced'),
    'unchanged re-queue is skipped': R.secondQueueMs < 400,
    'server run ok': R.runStatus === 200,
    'result event received': R.gotResult && R.bannerVisible,
    'texels changed inside mask': R.changedTexels > 5000 && R.greenTexels > 0.7 * R.changedTexels && R.changedFarFromMask < 0.01 * R.changedTexels,
    'mask mostly cleared after apply': R.maskedAfter < 0.25 * R.maskedBefore,
    'apply adds an AI layer, undo restores the texture exactly': R.layerCountAfterApply === 2 && R.layerName.startsWith('AI: mossy') && R.revertDiff === 0 && R.layersAfterRedo === 2,
    'reference image 2 reached the node (edit image, prompt, weight)': !!R.refInfo && R.refInfo.weight === 1 && /image 2/.test(R.refInfo.prompt) && R.refInfo.edit_in_mask && R.refInfo.edit_in_mask[2] > 0.9 && R.refInfo.edit_in_mask[0] < 0.1,
    'layers + reference image survive clone / restore': R.restoredLayers && R.restoredSig && R.restoredRef2,
    'model transform applied (hash, vertices, radius)': R.xformHashChanged && R.xformMoved && R.xformRoundTrip && R.xformRadius > 1.2,
    'transform survives clone/restore': R.restoredXform,
    'tab switch (no ui state in workflow) restores model + texture': R.tabSwitchModel,
    'new node reopens the last used model': R.freshNodeModel,
    'duplicate node cloned + restored': R.cloneNewSession && R.restoredTris === 12 && R.restoredMaskNonEmpty,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
  try { await page.screenshot({ path: path.join(out, 'failure.png') }); } catch (_) {}
}
console.log('--- browser console ---\n' + logs.join('\n'));
if (srvErr.trim()) console.log('--- server stderr (expected: none or intentional errors) ---\n' + srvErr.slice(-3000));
await browser.close();
srv.kill();
process.exit(failed ? 1 : 0);
