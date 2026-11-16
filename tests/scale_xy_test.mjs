// Reference placement Scale X / Y sliders.
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
    const ed = new window.TP.TexturePaintEditor();
    document.getElementById('host').append(ed.root);
    await sleep(400);
    const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
    const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
    let obj = 'o A\n'; for (const p of P) obj += `v ${p[0]} ${p[1]} ${p[2]}\n`;
    obj += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
    for (const f of F) obj += `f ${f[0] + 1}/1 ${f[1] + 1}/2 ${f[2] + 1}/3\nf ${f[0] + 1}/1 ${f[2] + 1}/3 ${f[3] + 1}/4\n`;
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'c.obj'); await sleep(300);
    const c = document.createElement('canvas'); c.width = 100; c.height = 50; c.getContext('2d').fillRect(0, 0, 100, 50);
    await ed.setRef2Image(new File([await new Promise((r) => c.toBlob(r))], 'r.png', { type: 'image/png' }));
    await sleep(100);
    const body = ed.ui.sec.ref.body;
    const sliders = [...body.querySelectorAll('.tp-row')].filter((r) => /Scale [XY]/.test(r.textContent));
    R.found = sliders.length === 2;
    const inp = (row) => row.querySelector('.tp-val');
    const set = (row, v) => { const i = inp(row); i.focus(); i.value = String(v); i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); };
    const u = ed.meshMat.uniforms;
    ed.state.ref2.size = 0.5; ed.state.ref2.mode = 'manual'; ed.state.ref2.sx = 1; ed.state.ref2.sy = 1; ed.state.ref2.aspect = 0;
    ed.setPlaceMode && ed.setPlaceMode(true); await sleep(100); ed.invalidate(); await sleep(150);
    R.base = [u.uRefP.value.z, u.uRefQ.value.x];
    set(sliders[0], 150); R.d0 = ed.state.ref2.sx; R.stillPlacing = ed.placeMode === true; await sleep(150); R.d1 = ed.state.ref2.sx; 
    R.sx = [u.uRefP.value.z, u.uRefQ.value.x, ed.state.ref2.sx, ed.state.ref2.mode];
    set(sliders[1], 200); await sleep(150);
    R.sy = [u.uRefP.value.z, u.uRefQ.value.x, ed.state.ref2.sy];
    // displayed width = size*sx ; displayed height = width * q  must equal size*sy*imageAspect
    R.h = u.uRefP.value.z * u.uRefQ.value.x;
    [...body.querySelectorAll('button')].find((b) => /1:1 X\/Y/.test(b.textContent)).click(); await sleep(100);
    R.reset = ed.state.ref2.sx === 1 && ed.state.ref2.sy === 1 && Math.abs(u.uRefP.value.z - 0.5) < 1e-6;
    ed.state.ref2.sx = 2; [...body.querySelectorAll('button')].find((b) => /Reset placement/.test(b.textContent)).click(); await sleep(60);
    R.resetAll = ed.state.ref2.sx === 1;
    R.saved = JSON.stringify(ed.getState().ref2).includes('"sx"');
    return R;
  });
  console.log(JSON.stringify(R));
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  const must = {
    'Scale X / Y sliders exist': R.found,
    'base: width 0.5, height ratio = image aspect': near(R.base[0], 0.5) && near(R.base[1], 0.5),
    'Scale X 150%: width x1.5, mode becomes manual': near(R.sx[0], 0.75) && R.sx[2] === 1.5 && R.sx[3] === 'manual',
    'Scale Y 200%: height = size * sy * aspect (0.5*2*0.5)': near(R.h, 0.5) && near(R.sy[2], 2),
    'typing a value + Enter in placement mode keeps placement mode': R.stillPlacing, '1:1 button resets X/Y': R.reset, 'Reset placement resets X/Y': R.resetAll, 'sx / sy are saved in the state': R.saved,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
