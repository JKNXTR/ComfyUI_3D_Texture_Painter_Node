// Unwrap & Atlas tab: real python route (xatlas) through a node bridge; textures of 3 objects end up in one atlas.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';

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
const srv = spawn('python3', [path.join(here, 'e2e_server.py')], { stdio: ['ignore', 'pipe', 'pipe'] });
let spy = ''; srv.stderr.on('data', (d) => { spy += d; });
const pyPort = await new Promise((res, rej) => { let b = ''; srv.stdout.on('data', (d) => { b += d; const m = /PORT (\d+)/.exec(b); if (m) res(+m[1]); }); setTimeout(() => rej(new Error('python server did not start: ' + spy)), 30000); });
const page = await browser.newPage();
await page.exposeFunction('hostUnwrap', async (entries) => {
  const fd = new FormData();
  for (const [k, v, isFile] of entries) { if (isFile) fd.append(k, new Blob([Buffer.from(v, 'base64')]), k + '.bin'); else fd.append(k, v); }
  const r = await fetch(`http://127.0.0.1:${pyPort}/texpaint/unwrap`, { method: 'POST', body: fd });
  const b = Buffer.from(await r.arrayBuffer());
  return { ok: r.ok, status: r.status, body: b.toString('base64') };
});
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
    // each object gets its own flat colour as texture
    const png = async (col) => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 64, 64); return new Promise((r) => c.toBlob(r, 'image/png')); };
    const cols = { Alpha: '#ff0000', Beta: '#00ff00', Gamma: '#0000ff' };
    for (const [n, c] of Object.entries(cols)) await ed.objApplyTexture(ids[n], new File([await png(c)], n + '.png', { type: 'image/png' }), 'replace');
    await ed.selectObject(ids.Alpha);
    ed.hooks.unwrapApi = async (fd) => {
      const entries = [];
      for (const [k, v] of fd.entries()) { if (typeof v === 'string') entries.push([k, v, false]); else { const u = new Uint8Array(await v.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); entries.push([k, btoa(s), true]); } }
      const r = await window.hostUnwrap(entries);
      const bin = atob(r.body), buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
      if (!r.ok) throw new Error(JSON.parse(new TextDecoder().decode(buf)).error);
      return buf.buffer;
    };
    // tab switch
    const tabs = ed.ui.side.querySelectorAll('.tp-tab'); tabs[1].click(); await sleep(100);
    R.tab = { cls: ed.ui.side.classList.contains('tp-tab-unwrap'), shown: getComputedStyle(ed.ui.side.querySelector('.tp-uwpanel')).display, paintHidden: getComputedStyle(ed.ui.sec.brush.el).display, boxes: ed.ui.side.querySelectorAll('.tp-uwpanel .tp-chk').length };
    const S = ed._unwrapState; R.source = S.source; R.selected = S.sel.size;
    ed.ui.side.querySelector('.tp-uwpanel select').value; // method select exists
    S.size = 1024; S.quality = 'fast';
    const run = [...ed.ui.side.querySelectorAll('.tp-uwpanel button')].find((b) => b.textContent === 'Unwrap & build atlas'); run.click();
    for (let i = 0; i < 200 && !S.res && !/failed/.test(ed.ui.side.querySelector('.tp-uwpanel').textContent); i++) await sleep(100);
    R.res = !!S.res; R.err = S.res ? '' : ed.ui.side.querySelector('.tp-uwpanel').textContent.slice(0, 300);
    if (S.res) {
      const st = S.res.stats; R.stats = { size: st.size, charts: st.charts, objs: st.objects.map((o) => o.name), dens: st.density, tris: st.triangles, overlap: st.overlap };
      const c = document.createElement('canvas'); c.width = c.height = S.res.bitmap.width; const g = c.getContext('2d'); g.drawImage(S.res.bitmap, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data, seen = { r: 0, g: 0, b: 0, grey: 0 };
      for (let i = 0; i < d.length; i += 4 * 17) { if (d[i] > 240 && d[i + 1] < 15) seen.r++; else if (d[i + 1] > 240 && d[i] < 15) seen.g++; else if (d[i + 2] > 240 && d[i] < 15) seen.b++; else if (d[i] === 200) seen.grey++; }
      R.seen = seen;
      R.zip = (await ed.unwrapZip()).size > 1000;
      R.previewShown = ed.ui.side.querySelector('.tp-uwprev').style.display;
      R.selBack = ed.state.model.object === ids.Alpha;
      // import as the new model: 3 objects remain, one shared atlas
      await ed.importUnwrapResult(); await sleep(300);
      R.imp = { rows: ed.objTree.leafCount, tris: ed.info.triangles, tex: ed.layers.w, tab: ed.ui.side.classList.contains('tp-tab-unwrap'), name: ed.state.model.name };
      const bc = ed.layers.bakeCanvas(0), gg = bc.getContext('2d').getImageData(0, 0, bc.width, bc.height).data; let nonGrey = 0; for (let i = 0; i < gg.length; i += 4 * 31) if (gg[i] !== 200) nonGrey++; R.impTex = nonGrey > 50;
    }
    return R;
  }, colors);
  console.log(JSON.stringify(R));
  const must = {
    'tab strip switches the side panel to the unwrap tab': R.tab.cls && R.tab.shown === 'block' && R.tab.paintHidden === 'none' && R.tab.boxes >= 4,
    'all objects pre-selected, source = each object\'s own texture': R.selected === 3 && R.source === 'own',
    'unwrap through the real python route': R.res,
    'one atlas with the 3 objects, 36 triangles, no overlaps': R.res && R.stats.size === 1024 && R.stats.objs.length === 3 && R.stats.tris === 36 && R.stats.overlap < 0.001,
    'equal texel density between objects': R.res && Math.max(...R.stats.dens) / Math.min(...R.stats.dens) < 1.05,
    'each object texture was transferred into the atlas': R.res && R.seen.r > 20 && R.seen.g > 20 && R.seen.b > 20,
    'preview + zip available, selection restored': R.res && R.previewShown === 'block' && R.zip && R.selBack,
    'import loads the atlas model: 3 objects, atlas texture, back to Paint tab': R.res && R.imp.rows === 3 && R.imp.tris === 36 && R.imp.tex === 1024 && !R.imp.tab && R.impTex,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close(); srv.kill();
process.exit(failed ? 1 : 0);
