// Reference images 2..6: one selector, each image has its own placement/weight/angle; image 2 stays untouched.
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
    const THREE = window.TP.THREE;
    // three unit cubes side by side, each with a FULL 0-1 UV layout (UVs overlap between objects, like separate textures)
    const cubeObj = (name, cx, vi0) => {
      const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
      const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
      let s = 'o ' + name + '\n';
      for (const p of P) s += `v ${p[0] + cx} ${p[1]} ${p[2]}\n`;
      s += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
      for (const f of F) s += `f ${f[0] + vi0}/1 ${f[1] + vi0}/2 ${f[2] + vi0}/3\nf ${f[0] + vi0}/1 ${f[2] + vi0}/3 ${f[3] + vi0}/4\n`;
      return s;
    };
    const obj = cubeObj('Alpha', -3, 1) + cubeObj('Beta', 0, 9) + cubeObj('Gamma', 3, 17);
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'multi.obj');
    await sleep(300);
    const T = ed.objTree, ids = {};
    for (const nd of T.rows) ids[nd.name] = nd.id;
    R.tree = { leaves: T.leafCount, rows: T.rows.map((n) => n.name), secShown: ed.ui.sec.obj.el.style.display !== 'none', rowsInDom: ed.ui.sec.obj.body.querySelectorAll('.tp-trow').length };
    R.whole = { tris: ed.info.triangles, obj: ed.state.model.object, ctx: 0 };
    const png = async (col) => { const c = document.createElement('canvas'); c.width = 64; c.height = 32; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 64, 32); return new Promise((r) => c.toBlob(r, 'image/png')); };
    R.slots = ed.state.refx.length; R.defaults = { w: ed.state.refx[3].weight, o: ed.state.refx[3].original };
    // old 3-slot state from a previous version is upgraded
    ed.applyState({ refx: [{ has: false, enabled: true, role: 'old' }, { has: false, enabled: true, role: '' }, { has: false, enabled: true, role: '' }] });
    R.upgrade = { n: ed.state.refx.length, role: ed.state.refx[0].role, hasFields: ed.state.refx[2].size === 0.5 && ed.state.refx[3].mode === 'mask' };
    const sel = [...ed.ui.sec.ref.body.querySelectorAll('select')].find((s) => s.options.length === 5 && /Image 2/.test(s.options[0].textContent));
    R.selector = !!sel;
    sel.value = '4'; sel.dispatchEvent(new Event('change')); await sleep(100);
    R.active = ed.refActive;
    await ed.setRefImage(4, new File([await png('#00ff00')], 'back.png', { type: 'image/png' })); await sleep(100);
    R.loaded = { x1: ed.state.refx[1].has, ref2: ed.state.ref2.has, canvas: !!ed.refxCanvas[1], opt: sel.options[2].textContent };
    ed.state.brush.size = 120; ed.frameModel(); await sleep(150);
    ed.beginStroke(false); for (let i = 0; i < 6; i++) ed.strokeMove(ed.ui.pane3d.offsetWidth * 0.5 + i * 5, ed.ui.pane3d.offsetHeight * 0.5, 0); ed.endStroke(); await sleep(100);
    const ok = ed.setPlaceMode(true);
    R.place = { ok, mode: ed.state.refx[1].mode, enabled: ed.state.refx[1].enabled, ref2Mode: ed.state.ref2.mode, ref2Enabled: ed.state.ref2.enabled };
    ed.setPlaceMode(false);
    ed.fitRef2('frame-cover'); R.fit = { x1: ed.state.refx[1].fit, size: ed.state.refx[1].size, ref2fit: ed.state.ref2.fit };
    // wheel in placement mode resizes the active slot only
    ed.state.refx[1].weight = 0.8; ed.state.refx[1].original = false; ed.state.refx[1].angle = 'back';
    // saved angle
    ed.camera.position.set(0, 0.5, -3.4); ed.controls.update(); ed.refSaveAngle(4);
    ed.camera.position.set(3, 1, 3); ed.controls.update();
    const went = ed.refGotoAngle(4); R.angle = { went, z: +ed.camera.position.z.toFixed(2), none: ed.refGotoAngle(5) };
    // slot 3 is separate
    ed.setRefActive(3); await ed.setRefImage(3, new File([await png('#0000ff')], 'left.png', { type: 'image/png' }));
    ed.setRefActive(2); R.back2 = { has: ed.state.ref2.has, role: ed.state.ref2.role };
    // capture carries image 3 and 4 with their settings
    const cap = await ed.capture({ includeMesh: false, includeTexture: false });
    R.cap = { ref3: cap.ref3 instanceof Blob, ref4: cap.ref4 instanceof Blob, ref5: !!cap.ref5, meta: cap.meta.refx.map((r) => [r.has, r.weight, r.angle, r.original]), n: cap.meta.refx.length };
    // thumbnail follows the selector
    ed.setRefActive(4); const th = ed.ui.sec.ref.body.querySelector('canvas.tp-thumb2'); R.thumb = th.style.display;
    ed.clearRefImage(4); R.cleared = { has: ed.state.refx[1].has, en: ed.state.refx[1].enabled };
    // state round trip
    const st = JSON.parse(JSON.stringify(ed.getState())); R.roundtrip = st.refx.length === 4 && st.refx[0].has;
    return R;
  }, colors);
  console.log(JSON.stringify(R));
  const must = {
    '4 extra slots with full placement fields, old behaviour defaults (weight 0, original on)': R.slots === 4 && R.defaults.w === 0 && R.defaults.o === true,
    'old 3-slot state upgraded to 4 full slots': R.upgrade.n === 4 && R.upgrade.role === 'old' && R.upgrade.hasFields,
    'selector lists images 2-6 and switches the active image': R.selector && R.active === 4,
    'loading goes to the selected slot only, selector shows a tick': R.loaded.x1 && !R.loaded.ref2 && R.loaded.canvas && /\u2713/.test(R.loaded.opt),
    'Place on model works on the selected image, image 2 untouched': R.place.ok && R.place.mode === 'manual' && R.place.enabled && R.place.ref2Mode !== 'manual' && !R.place.ref2Enabled,
    'fit options act on the selected image': R.fit.x1 === 'frame-cover' && R.fit.size > 0 && R.fit.ref2fit === '',
    'saved camera angle per image': R.angle.went && Math.abs(R.angle.z + 3.4) < 0.05 && R.angle.none === false,
    'image 2 independent of image 3': R.back2.has === false,
    'capture sends ref3/ref4 + settings of 4 slots': R.cap.ref3 && R.cap.ref4 && !R.cap.ref5 && R.cap.n === 4 && R.cap.meta[1][0] === true && R.cap.meta[1][1] === 0.8 && R.cap.meta[1][2] === 'back' && R.cap.meta[1][3] === false,
    'thumbnail shown for loaded slot; clearing disables it': R.thumb === 'block' && R.cleared.has === false && R.cleared.en === false,
    'state round trip keeps 4 slots': R.roundtrip,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
