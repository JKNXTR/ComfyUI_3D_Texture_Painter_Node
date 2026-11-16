// Editable slider values (type / wheel / arrows), presets (save as / load / overwrite / rename / delete / defaults), save-state hook, fit buttons.
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
    const store = {}; const calls = [];
    const hooks = {
      presets: {
        list: async () => Object.keys(store).sort().map((name) => ({ name })),
        get: async (n) => { if (!store[n]) throw new Error('missing'); return JSON.parse(JSON.stringify(store[n])); },
        put: async (n, d, ow) => { if (store[n] && !ow) return { exists: true }; store[n] = JSON.parse(JSON.stringify(d)); return { ok: true }; },
        del: async (n) => { delete store[n]; },
        rename: async (a, b) => { if (store[b]) return { exists: true }; store[b] = store[a]; delete store[a]; return { ok: true }; },
      },
      saveNow: async (wf) => { calls.push(wf); return { nodes: 2, failed: 0, workflow: wf ? true : null }; },
    };
    const ed = new window.TP.TexturePaintEditor({ hooks });
    document.getElementById('host').append(ed.root);
    await sleep(400);
    const THREE = window.TP.THREE;
    const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
    const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
    const cube = (name, cx, vi0) => {
      let s = 'o ' + name + '\n';
      for (const p of P) s += `v ${p[0] + cx} ${p[1]} ${p[2]}\n`;
      s += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
      for (const f of F) s += `f ${f[0] + vi0}/1 ${f[1] + vi0}/2 ${f[2] + vi0}/3\nf ${f[0] + vi0}/1 ${f[2] + vi0}/3 ${f[3] + vi0}/4\n`;
      return s;
    };
    await ed.loadModelBuffer(new TextEncoder().encode(cube('A', -3, 1) + cube('B', 3, 9)).buffer, 'two.obj');
    await sleep(300);

    // ---- sliders: find the first slider with a numeric range
    const row = [...ed.root.querySelectorAll('.tp-val')].find((i) => i.parentElement && !i.closest('.tp-tilebox') && i.parentElement.querySelector('input[type=range]'));
    const rng = row.parentElement.querySelector('input[type=range]');
    R.sliderFound = !!row && !!rng;
    const min = +rng.min, max = +rng.max, step = +rng.step;
    const key = (k, o = {}) => row.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...o }));
    const wheel = (dy, o = {}) => row.dispatchEvent(new WheelEvent('wheel', { deltaY: dy, bubbles: true, cancelable: true, ...o }));
    const type = (t, k = 'Enter') => { row.focus(); row.value = t; key(k); };
    const num = () => +rng.value;
    R.range = { min, max, step };
    const target = min + (max - min) * 0.5;
    type(String(target)); R.typed = Math.abs(num() - target) <= step + 1e-9;
    type(String(max * 10)); R.clampHi = num() === max;
    type(String(min - 100)); R.clampLo = num() === min;
    const before = num(); row.focus(); row.value = 'garbage'; key('Escape'); R.escKeeps = num() === before && row.value !== 'garbage';
    type(String(target)); const t0 = num();
    key('ArrowUp'); const up = num(); key('ArrowDown'); R.arrows = up > t0 && Math.abs(num() - t0) < 1e-6;
    row.focus(); wheel(-100); const w1 = num(); wheel(100); R.wheelFocused = w1 > t0 && Math.abs(num() - t0) < 1e-6;
    row.focus(); wheel(-100); const a = num() - t0; type(String(target)); row.focus(); wheel(-100, { shiftKey: true }); const b = num() - t0; R.shiftBigger = Math.abs(b) > Math.abs(a) * 1.5;
    row.blur(); type(String(target)); const t1 = num(); row.blur(); const ev = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }); row.dispatchEvent(ev); R.wheelUnfocusedIgnored = num() === t1;

    // ---- presets
    const q = (t) => [...ed.ui.sec.pre.body.querySelectorAll('button')].find((b) => b.textContent.startsWith(t));
    const sel = ed.ui.sec.pre.body.querySelector('select'), nameIn = ed.ui.sec.pre.body.querySelector('input[type=text]');
    const info = () => ed.ui.sec.pre.body.querySelector('.tp-note').textContent;
    const tick = () => sleep(60);
    ed.state.brush.size = 77; ed.state.gen.steps = 9;
    nameIn.value = 'Alpha'; q('Save as').click(); await tick();
    R.saved = !!store.Alpha && store.Alpha.settings.brush.size === 77 && store.Alpha.settings.gen.steps === 9;
    R.noModelInPreset = !store.Alpha.settings.model && !store.Alpha.settings.layerStack && !store.Alpha.settings.objStates && !store.Alpha.camera;
    R.listed = [...sel.options].some((o) => o.value === 'Alpha') && sel.value === 'Alpha';
    ed.state.brush.size = 11;
    q('Save as').click(); await tick(); R.dupWarn = /already exists/.test(info()) && store.Alpha.settings.brush.size === 77;
    q('Overwrite').click(); await tick(); R.overArmed = store.Alpha.settings.brush.size === 77 && /again/i.test(q('Click again').textContent);
    q('Click again').click(); await tick(); R.overwritten = store.Alpha.settings.brush.size === 11;
    ed.state.brush.size = 55;
    nameIn.value = 'Beta'; q('Save as').click(); await tick();
    sel.value = 'Alpha'; sel.dispatchEvent(new Event('change')); q('Load').click(); await tick();
    R.loaded = ed.state.brush.size === 11 && ed.getState().brush.size === 11;
    nameIn.value = 'Gamma'; sel.value = 'Beta'; q('Rename').click(); await tick();
    R.renamed = !store.Beta && !!store.Gamma && sel.value === 'Gamma';
    nameIn.value = 'Alpha'; sel.value = 'Gamma'; q('Rename').click(); await tick(); R.renameConflict = !!store.Gamma && /exists/.test(info());
    sel.value = 'Gamma'; q('Delete').click(); await tick(); R.delArmed = !!store.Gamma;
    q('Click again').click(); await tick(); R.deleted = !store.Gamma;
    q('Load').click(); await tick(); R.loadNone = /Choose/.test(info());
    // scope boxes
    const boxes = [...ed.ui.sec.pre.body.querySelectorAll('input[type=checkbox]')];
    R.boxes = boxes.length;
    boxes[0].click(); boxes[1].click(); boxes[2].click();
    ed.state.ref2.ox = 0.3; ed.state.ref2.rot = 33; ed.state.ref2.weight = 0.4;
    nameIn.value = 'Scoped'; q('Save as').click(); await tick();
    const sc = store.Scoped;
    R.scopeData = !!sc.camera && !!sc.xform && sc.ref2.ox === 0.3 && sc.ref2.rot === 33 && sc.ref2.weight === 0.4;
    ed.state.ref2.ox = 0; ed.state.ref2.rot = 0; ed.state.ref2.weight = 1;
    sel.value = 'Scoped'; q('Load').click(); await tick();
    R.scopeLoad = ed.state.ref2.ox === 0.3 && ed.state.ref2.rot === 33 && ed.state.ref2.weight === 0.4;
    // a preset must not touch the model
    const tris = ed.info.triangles; R.modelKept = tris === 24 && ed.hasModel;
    ed.state.brush.size = 99; q('Defaults').click(); await tick(); q('Click again').click(); await tick();
    R.defaults = ed.state.brush.size !== 99 && ed.hasModel;
    // local fallback
    R.presetsHookUsed = Object.keys(store).length >= 2;

    // ---- save state
    q('Save state now').click(); await tick(); await tick();
    q('Save state + workflow').click(); await tick(); await tick();
    R.saveCalls = JSON.stringify(calls) === '[false,true]';
    R.saveText = /2 Texture Painter nodes/.test(ed.ui.sec.pre.body.textContent) && /workflow file saved/.test(ed.ui.sec.pre.body.textContent);

    // ---- fit
    const corners = (box) => { const o = []; for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) o.push(new THREE.Vector3(x, y, z)); return o; };
    const fitOf = (box) => {
      ed.camera.updateMatrixWorld(); ed.camera.updateProjectionMatrix();
      let mx = 0; for (const c of corners(box)) { const p = c.clone().project(ed.camera); mx = Math.max(mx, Math.abs(p.x), Math.abs(p.y)); }
      return mx;
    };
    const meshBox = (m) => new THREE.Box3().setFromObject(m);
    const mesh = ed.mesh || ed.modelMesh || ed.model;
    R.hasMesh = !!mesh;
    ed.camera.position.set(9, 4, 12); ed.controls.update();
    ed.fitWhole(); await sleep(50);
    const bx = meshBox(mesh);
    const f1 = fitOf(bx); R.fitModel = f1 <= 1.001 && f1 > 0.45;
    ed.camera.position.multiplyScalar(5); ed.controls.update();
    ed.frameAll(); await sleep(50);
    const f2 = fitOf(bx); R.fitAll = f2 <= 1.001 && f2 > 0.45;
    R.hasButtons = !!ed.root.querySelector('button[title^="Fit the selected"]') && !!ed.root.querySelector('button[title^="Fit the whole"]');
    R.objButtons = [...ed.root.querySelectorAll('button')].some((b) => /Fit selected object/.test(b.textContent)) && [...ed.root.querySelectorAll('button')].some((b) => /Fit all objects/.test(b.textContent));
    // ortho
    if (ed.setProjection) { ed.setProjection('ortho'); await sleep(50); ed.camera.position.multiplyScalar(4); ed.controls.update(); ed.fitWhole(); await sleep(50); const f3 = fitOf(bx); R.fitOrtho = f3 <= 1.001 && f3 > 0.4; }
    else R.fitOrtho = true;
    // masked region
    R.frameMask = typeof ed.frameMask === 'function';
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'slider and value field found': R.sliderFound,
    'typed value applies': R.typed, 'typed value clamps high': R.clampHi, 'typed value clamps low': R.clampLo,
    'Esc cancels': R.escKeeps, 'arrow keys nudge': R.arrows, 'wheel edits when focused': R.wheelFocused,
    'Shift = bigger wheel step': R.shiftBigger, 'wheel ignored when not focused': R.wheelUnfocusedIgnored,
    'save as stores settings only': R.saved && R.noModelInPreset, 'list shows new preset': R.listed,
    'save as refuses to overwrite silently': R.dupWarn, 'overwrite needs second click': R.overArmed, 'overwrite replaces': R.overwritten,
    'load applies settings': R.loaded, 'rename': R.renamed, 'rename conflict refused': R.renameConflict,
    'delete needs second click': R.delArmed, 'delete': R.deleted, 'load without selection warns': R.loadNone,
    'scope boxes store camera/xform/placement': R.boxes === 3 && R.scopeData, 'scoped load applies placement': R.scopeLoad,
    'preset load keeps the model': R.modelKept, 'defaults reset settings': R.defaults,
    'save state now / + workflow call the hook': R.saveCalls, 'save state result text': R.saveText,
    'fit buttons exist': R.hasButtons && R.objButtons, 'fit model keeps whole box in view': R.hasMesh && R.fitModel,
    'fit all keeps box in view': R.fitAll, 'fit in ortho': R.fitOrtho,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
