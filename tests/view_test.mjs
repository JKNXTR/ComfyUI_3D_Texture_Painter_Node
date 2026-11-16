// View cube, perspective/ortho switch, bookmarks, turntable, checker.
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
    const R = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = new window.TP.TexturePaintEditor();
    document.getElementById('host').append(ed.root);
    await sleep(300);
    let obj = '';
    for (let j = 0; j <= 12; j++) for (let i = 0; i <= 24; i++) { const u = i / 24, v = j / 12, th = u * 6.2832, ph = v * 3.14159; const x = Math.cos(th) * Math.sin(ph), y = Math.cos(ph), z = Math.sin(th) * Math.sin(ph); obj += `v ${x} ${y} ${z}\nvt ${u} ${1 - v}\nvn ${x} ${y} ${z}\n`; }
    const id = (i, j) => j * 25 + i + 1;
    for (let j = 0; j < 12; j++) for (let i = 0; i < 24; i++) { const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1); obj += `f ${a}/${a}/${a} ${c}/${c}/${c} ${b}/${b}/${b}\nf ${a}/${a}/${a} ${d}/${d}/${d} ${c}/${c}/${c}\n`; }
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'sphere.obj');
    ed.frameModel(); await sleep(300);
    const dir = () => { const d = ed._camDir(); return [d.x, d.y, d.z].map((v) => +v.toFixed(2)); };
    const cube = ed.ui.pane3d.querySelector('.tp-vc-cube');
    R.faces = ed.ui.pane3d.querySelectorAll('.tp-vc-f').length;
    R.cubeTransform = (cube.style.transform || '').startsWith('matrix3d');
    // face buttons -> exact views
    const faceEl = (name) => [...ed.ui.pane3d.querySelectorAll('.tp-vc-f')].find((e) => e.textContent === name);
    R.views = {};
    for (const [name, want] of [['FRONT', [0, 0, 1]], ['RIGHT', [1, 0, 0]], ['BACK', [0, 0, -1]], ['LEFT', [-1, 0, 0]], ['TOP', [0, 1, 0]], ['BOTTOM', [0, -1, 0]]]) {
      // click the centre of the face element (local coordinates 50%/50% -> pure face view)
      const el = faceEl(name);
      el.dispatchEvent(Object.defineProperty(Object.defineProperty(new MouseEvent('click', { bubbles: true }), 'offsetX', { value: el.offsetWidth / 2 }), 'offsetY', { value: el.offsetHeight / 2 }));
      await sleep(450);
      const d = dir();
      R.views[name] = d.every((v, i) => Math.abs(v - want[i]) < 0.03);
    }
    // corner click: top-left corner of FRONT = (-X, +Y, +Z)
    { const el = faceEl('FRONT'); el.dispatchEvent(Object.defineProperty(Object.defineProperty(new MouseEvent('click', { bubbles: true }), 'offsetX', { value: 2 }), 'offsetY', { value: 2 }));
      await sleep(450); const d = ed._camDir(); R.corner = d.x < -0.4 && d.y > 0.4 && d.z > 0.4; }
    // cube follows the camera
    ed.viewFrom(new window.TP.THREE.Vector3(0, 0, 1)); await sleep(450); const t1 = cube.style.transform;
    ed.viewFrom(new window.TP.THREE.Vector3(1, 0, 0)); await sleep(450); R.cubeFollows = cube.style.transform !== t1;
    // perspective <-> ortho keeps the framing
    ed.viewFrom(new window.TP.THREE.Vector3(0.3, 0.2, 1)); await sleep(450);
    const d0 = ed.camera.position.distanceTo(ed.controls.target);
    ed.setOrtho(true); await sleep(100);
    R.isOrtho = ed.camera.isOrthographicCamera && ed.ui.pane3d.querySelector('.tp-vc-bar button').textContent === 'Ortho';
    const half = ed.orthoHalf;
    R.orthoHalfOK = Math.abs(half - d0 * Math.tan(20 * Math.PI / 180)) < 0.01;
    ed.setOrtho(false); await sleep(100);
    R.backToPersp = !ed.camera.isOrthographicCamera && Math.abs(ed.camera.position.distanceTo(ed.controls.target) - d0) / d0 < 0.02;
    // paint in ortho: mask appears, capture meta says ortho
    ed.setOrtho(true); ed.frameModel(); await sleep(200);
    const p3 = ed.ui.pane3d; ed.state.brush.size = 120;
    ed.beginStroke(false); for (let i = 0; i < 10; i++) ed.strokeMove(p3.offsetWidth * 0.4 + i * 10, p3.offsetHeight * 0.5, 0); ed.endStroke(); await sleep(200);
    R.orthoPaint = !ed.maskIsEmpty();
    const cap = await ed.capture({ includeMesh: false, includeTexture: false });
    R.captureOrtho = !!cap.meta.camera.ortho && Math.abs(cap.meta.camera.proj[15] - 1) < 1e-6;
    // state round trip + bookmarks
    const st = ed.getState(); R.stateOrtho = st.camera.ortho === true;
    ed.saveBookmark('A'); ed.setOrtho(false); ed.viewFrom(new window.TP.THREE.Vector3(0, 1, 0)); await sleep(400);
    ed.gotoBookmark(0); await sleep(100);
    R.bookmarkRestoresOrtho = ed.isOrtho && ed.state.bookmarks.length === 1;
    ed.applyState(JSON.parse(JSON.stringify(st)));
    R.applyStateOK = ed.isOrtho;
    // turntable
    const c0 = ed.camera.position.clone(); ed.setTurntable(true); await sleep(500); ed.setTurntable(false);
    R.turntable = ed.camera.position.distanceTo(c0) > 0.001 && !ed.turntable;
    ed.state.display.checker3d = true; ed.invalidate(); await sleep(200); R.checkerOn = ed.meshMat.uniforms.uChecker.value === 1;
    // rectangle / lasso selection through real pointer events
    ed.setOrtho(false); ed.frameModel(); await sleep(200);
    ed.maskClear(); await sleep(100);
    const ptr = (type, x, y, extra = {}) => { const r = p3.getBoundingClientRect(); p3.dispatchEvent(new PointerEvent(type, { bubbles: true, clientX: r.left + x, clientY: r.top + y, pointerId: 7, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...extra })); };
    const W3 = p3.offsetWidth, H3 = p3.offsetHeight;
    ed.setTool('rect');
    ptr('pointerdown', W3 * 0.35, H3 * 0.35); ptr('pointermove', W3 * 0.5, H3 * 0.5); ptr('pointermove', W3 * 0.65, H3 * 0.65); ptr('pointerup', W3 * 0.65, H3 * 0.65);
    await sleep(200);
    const cnt = () => { const b = ed._readMaskPixels(); let n = 0; for (let i = 0; i < b.length; i += 4) if (b[i] > 127) n++; return n; };
    R.rectCount = cnt();
    ed.setTool('lasso');
    ptr('pointerdown', W3 * 0.1, H3 * 0.1); for (const [a, b] of [[0.3, 0.1], [0.3, 0.25], [0.1, 0.25]]) ptr('pointermove', W3 * a, H3 * b); ptr('pointerup', W3 * 0.1, H3 * 0.25);
    await sleep(200);
    R.afterLasso = cnt();
    ed.setTool('rect');   // Alt = remove: erase everything with a big rectangle
    ptr('pointerdown', 0, 0, { altKey: true }); ptr('pointermove', W3, H3, { altKey: true }); ptr('pointerup', W3, H3, { altKey: true });
    await sleep(200);
    R.afterAltRect = cnt();
    ed.setTool('brush');
    // prompt helper
    let pv = 'weathered brick';
    ed.hooks.getPrompt = () => pv; ed.hooks.setPrompt = (t) => { pv = t; };
    const chip = [...ed.root.querySelectorAll('.tp-btn')].find((b) => b.textContent === 'mossy');
    chip.click(); chip.click();
    R.chipPrompt = pv;
    try { localStorage.removeItem('texpaint_prompts'); } catch (_) { /* ignore */ }
    ed.rememberPrompt('first prompt'); ed.rememberPrompt('second prompt'); ed.rememberPrompt('first prompt');
    const rows = () => [...ed.ui.sec.prompt.body.querySelectorAll('.tp-layer span')].map((e) => e.textContent).filter((t) => /prompt/.test(t));
    R.histOrder = rows().join('|');
    ed.ui.sec.prompt.body.querySelectorAll('.tp-layer')[1].click(); R.reused = pv;
    [...ed.ui.sec.prompt.body.querySelectorAll('.tp-layer')][1].querySelector('button').click();   // star the second row
    R.favFirst = rows()[0];
    // project backup round trip (save -> new editor -> open)
    await ed.restoreLayers(ed.layers.serialize(), async () => null).catch(() => {});
    ed.layers.addFill && ed.layers.addFill('#ff0000', 'Red test');
    ed.layers.setProp && ed.layers.setProp(ed.layers.active, { opacity: 0.5 });
    const names0 = ed.layers.layers.map((l) => l.name).join('|');
    const proj = await window.TP.saveProject(ed);
    R.projName = proj.name; R.projSize = proj.blob.size;
    const ed2 = new window.TP.TexturePaintEditor(); document.getElementById('host').append(ed2.root); await sleep(300);
    await window.TP.loadProject(ed2, new File([proj.blob], proj.name));
    await sleep(300);
    R.projLayers = ed2.layers.layers.map((l) => l.name).join('|') === names0;
    R.projModel = !!ed2.hasModel && ed2.info.triangles === ed.info.triangles;
    R.projOpacity = Math.abs(ed2.layers.layers[ed2.layers.layers.length - 1].opacity - 0.5) < 0.01;
    R.projMask = ed2.maskIsEmpty() === ed.maskIsEmpty();
    // diagnostics + save indicator
    R.diag = ed.diagnostics().includes('Texture Painter AI diagnostics') && /layers: \d+/.test(ed.diagnostics());
    ed.setSaveState('saved'); R.saveLabel = /saved/.test(ed.ui.saveState.textContent);
    // UV health: tiled + mirrored + overlapping UVs must be reported, a clean sphere must not
    R.healthClean = window.TP.uvHealth(ed.geometry).length;
    const g2 = ed.geometry.clone(); const uv = g2.attributes.uv.array;
    for (let i = 0; i < uv.length; i += 2) { uv[i] = uv[i] * 2.5; uv[i + 1] = uv[i + 1] * 0.2; }
    R.healthBad = window.TP.uvHealth(g2);
    const g3 = ed.geometry.clone(); const uv3 = g3.attributes.uv.array; const ix3 = g3.index.array;
    for (let t = 0; t < ix3.length / 3; t += 2) for (let k = 0; k < 3; k++) { const v = ix3[t * 3 + k]; uv3[v * 2] = uv3[v * 2] * 0.5; }   // half of the triangles squeezed on top of the others
    R.healthOverlap = window.TP.uvHealth(g3);
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'view cube: 6 faces + css matrix': R.faces === 6 && R.cubeTransform,
    'face clicks give exact front/right/back/left/top/bottom views': Object.values(R.views).every(Boolean),
    'corner click gives a diagonal view': R.corner,
    'cube follows the camera': R.cubeFollows,
    'perspective -> orthographic keeps the framing': R.isOrtho && R.orthoHalfOK,
    'ortho -> perspective restores distance': R.backToPersp,
    'brush works in orthographic view': R.orthoPaint,
    'capture meta reports an orthographic projection': R.captureOrtho,
    'ortho state saved / bookmarks restore it': R.stateOrtho && R.bookmarkRestoresOrtho && R.applyStateOK,
    'turntable rotates and stops': R.turntable,
    'UV checker toggle reaches the shader': R.checkerOn,
    'project save -> open restores model, layers, opacity, mask': R.projLayers && R.projModel && R.projOpacity && R.projMask,
    'diagnostics text + autosave indicator': R.diag && R.saveLabel,
    'prompt helper: chips (no duplicates), history order, reuse, favourites': R.chipPrompt === 'weathered brick, mossy' && R.histOrder === 'first prompt|second prompt' && R.reused === 'second prompt' && R.favFirst === 'second prompt',
    'rectangle / lasso add to the mask, Alt removes': R.rectCount > 1500 && R.afterLasso > R.rectCount && R.afterAltRect < R.rectCount * 0.1,
    'UV health: clean sphere silent, tiled UVs reported': R.healthClean === 0 && R.healthBad.some((m) => /outside 0-1/.test(m)) && R.healthOverlap.some((m) => /overlapping/.test(m)),
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
