// Right-click texture menu of the object hierarchy + saved texture library.
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
    const png = async (col) => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); g.fillStyle = col; g.fillRect(0, 0, 64, 64); return new Promise((r) => c.toBlob(r, 'image/png')); };
    const rows = () => [...ed.ui.sec.obj.body.querySelectorAll('.tp-trow')];
    const betaRow = rows().find((r) => r.textContent.includes('Beta'));
    betaRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 }));
    await sleep(200);
    const m = ed.root.querySelector('.tp-ctxmenu');
    R.menu = { open: !!m, items: m ? m.querySelectorAll('.tp-ctxitem').length : 0, empty: m ? !!m.querySelector('.tp-ctxempty') : false, head: m ? m.querySelector('.tp-ctxhead').textContent : '' };
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); await sleep(50);
    R.closed = !ed.root.querySelector('.tp-ctxmenu');
    const red = await png('#ff0000'); red.name = 'red.png';
    const ok = await ed.objApplyTexture(ids.Beta, new File([red], 'red.png', { type: 'image/png' }), 'replace');
    const px = (nm) => { const c = ed.layers.bakeCanvas(0); const d = c.getContext('2d').getImageData(c.width >> 1, c.height >> 1, 1, 1).data; return [d[0], d[1], d[2]]; };
    R.applied = { ok, obj: ed.state.model.object === ids.Beta, px: px(), layers: ed.layers.layers.length };
    await ed.selectObject(ids.Alpha); const alphaPx = px();
    await ed.selectObject(ids.Beta); R.back = { px: px(), alphaPx };
    const blue = await png('#0000ff');
    await ed.objApplyTexture(ids.Alpha, new File([blue], 'blue.png', { type: 'image/png' }), 'layer');
    R.layer = { n: ed.layers.layers.length, obj: ed.state.model.object === ids.Alpha };
    const libNames = (await ed.objTexLib.all()).map((x) => x.name).sort();
    R.lib = libNames;
    await ed.objApplyTexture(ids.Alpha, new File([red], 'red.png', { type: 'image/png' }), 'replace');
    R.libDedupe = (await ed.objTexLib.all()).length;
    betaRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); await sleep(300);
    const texRows = [...ed.root.querySelectorAll('.tp-ctxtex')];
    R.menuLib = texRows.length;
    const blueRow = texRows.find((r) => r.textContent.includes('blue.png'));
    blueRow.click(); await sleep(1200);
    R.fromLib = { obj: ed.state.model.object === ids.Beta, px: px(), layers: ed.layers.layers.length };
    betaRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 60, clientY: 60 })); await sleep(300);
    [...ed.root.querySelectorAll('.tp-ctxtex .tp-ctxdel')].find((x) => x.parentNode.textContent.includes('blue.png')).click(); await sleep(200);
    R.afterDel = (await ed.objTexLib.all()).map((x) => x.name).sort();
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await ed.objResetTexture(ids.Beta); R.reset = px();
    return R;
  }, colors);
  console.log(JSON.stringify(R));
  const isRed = (p) => p[0] > 240 && p[1] < 15 && p[2] < 15, isBlue = (p) => p[2] > 240 && p[0] < 15 && p[1] < 15;
  const must = {
    'right-click opens the menu with 3 actions + empty library note': R.menu.open && R.menu.items === 3 && R.menu.empty && R.menu.head === 'Beta',
    'click elsewhere closes the menu': R.closed,
    'texture applied to the right-clicked object as base texture': R.applied.ok && R.applied.obj && isRed(R.applied.px) && R.applied.layers === 1,
    'other object keeps its own texture; first object keeps the new one': !isRed(R.back.alphaPx) && isRed(R.back.px),
    'load as new layer adds a layer': R.layer.n === 2 && R.layer.obj,
    'every loaded file is saved in the library once': R.lib.join() === 'blue.png,red.png' && R.libDedupe === 2,
    'saved textures listed in the menu': R.menuLib === 2,
    'clicking a saved texture replaces the object texture (even with layers)': R.fromLib.obj && isBlue(R.fromLib.px) && R.fromLib.layers === 1,
    'x removes a saved texture': R.afterDel.join() === 'red.png',
    'back to model texture (no embedded -> grey)': !isRed(R.reset) && !isBlue(R.reset),
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
