// Resolution match panel: pixels of the AI render per UV texel, auto match, crop.
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
    await ed.selectObject(ids.Beta); ed.frameModel(); await sleep(150);
    R.empty = ed.estimateDensity();
    ed.state.brush.size = 300; ed.beginStroke(false); for (let i = 0; i < 12; i++) ed.strokeMove(ed.ui.pane3d.offsetWidth * 0.5 + i * 6, ed.ui.pane3d.offsetHeight * 0.5, 0); ed.endStroke(); await sleep(150);
    const sec = ed.ui.sec.resm.body;
    sec.querySelector('button').click(); await sleep(50);
    const d1 = ed.estimateDensity(); R.d1 = d1 && d1.p;
    R.infoText = sec.querySelector('.tp-note').textContent;
    ed.state.capture.long = 512; const d2 = ed.estimateDensity();
    R.ratio = d1.p / d2.p;                                   // doubling the capture side doubles pixels per texel
    ed.state.capture.long = 1024;
    const T0 = ed.layers.w; ed.layers.resizeTo(T0 * 2, T0 * 2); const d3 = ed.estimateDensity(); R.texRatio = d1.p / d3.p; ed.layers.resizeTo(T0, T0);
    // dense plane (a crop needs small triangles: the crop box is built from the painted triangles)
    { let o = 'o plane\n'; const N = 24; for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) o += `v ${i / N * 2 - 1} ${j / N * 2 - 1} 0\nvt ${0.02 + 0.96 * i / N} ${0.02 + 0.96 * j / N}\n`;
      const id = (i, j) => j * (N + 1) + i + 1; for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) o += `f ${id(i, j)}/${id(i, j)} ${id(i + 1, j)}/${id(i + 1, j)} ${id(i + 1, j + 1)}/${id(i + 1, j + 1)}\nf ${id(i, j)}/${id(i, j)} ${id(i + 1, j + 1)}/${id(i + 1, j + 1)} ${id(i, j + 1)}/${id(i, j + 1)}\n`;
      await ed.loadModelBuffer(new TextEncoder().encode(o).buffer, 'plane.obj'); await sleep(300); ed.frameModel(); await sleep(150); }
    ed.maskClear(); ed.state.brush.size = 40; ed.beginStroke(false); for (let i = 0; i < 4; i++) ed.strokeMove(ed.ui.pane3d.offsetWidth * 0.5 + i * 3, ed.ui.pane3d.offsetHeight * 0.5, 0); ed.endStroke(); await sleep(150);
    R.dbg = { empty: ed.maskIsEmpty(), est: ed.estimateDensity() }; const d1b = ed.estimateDensity(); ed.state.capture.crop.enabled = true; const d4 = ed.estimateDensity(); R.crop = d4.p / d1b.p; ed.state.capture.crop.enabled = false;
    // auto match: texture finer than the render -> raise the capture size / shrink the texture until >= ~1 px per texel
    ed.layers.resizeTo(4096, 4096); ed.state.capture.long = 512; ed._applyStateToUI();
    const before = ed.estimateDensity().p;
    [...sec.querySelectorAll('button')].find((b) => b.textContent === 'Auto match').click(); await sleep(400);
    const after = ed.estimateDensity();
    R.auto = { before, after: after.p, long: ed.state.capture.long, tex: ed.layers.w };
    
    // overrides: fixed capture side + texture size from the drop-downs
    const sels = [...sec.querySelectorAll('select')], ovC = sels.find((x) => x.options[0].textContent.startsWith('Auto') && x.options.length === 8), ovT = sels.find((x) => x.options[0].textContent.startsWith('Auto') && x.options.length === 6);
    R.ovSel = !!ovC && !!ovT;
    ovC.value = '1536'; ovT.value = '1024';
    [...sec.querySelectorAll('button')].find((b) => b.textContent === 'Apply overrides now').click(); await sleep(300);
    R.ov = { long: ed.state.capture.long, tex: ed.layers.w };
    ovC.value = '0'; ovT.value = '2048'; [...sec.querySelectorAll('button')].find((b) => b.textContent === 'Auto match').click(); await sleep(300);
    R.ovAuto = { tex: ed.layers.w };
    return R;
  }, colors);
  console.log(JSON.stringify(R));
  const must = {
    'no mask -> no measurement': R.empty === null,
    'density measured and described in the panel': R.d1 > 0 && /Pixels of the AI render per UV texel/.test(R.infoText),
    'capture size 2x -> 2x pixels per texel': Math.abs(R.ratio - 2) < 0.1,
    'texture 2x finer -> half the pixels per texel': Math.abs(R.texRatio - 2) < 0.1,
    'crop to mask raises the density': R.crop > 1.5,
    'auto match reaches ~1 px per texel (bigger capture and/or smaller texture)': R.auto.after >= 0.9 && R.auto.long > 512,
    'override drop-downs apply capture side and texture size': R.ovSel && R.ov.long === 1536 && R.ov.tex === 1024,
    'Auto match respects a texture override': R.ovAuto.tex === 2048,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
