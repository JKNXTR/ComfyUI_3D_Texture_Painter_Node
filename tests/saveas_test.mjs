// Combine layers panel end to end.
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
    R.noModel = ed.openSaveAs() === null;
    const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
    const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
    let obj = 'o A\n'; for (const p of P) obj += `v ${p[0]} ${p[1]} ${p[2]}\n`;
    obj += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
    for (const f of F) obj += `f ${f[0] + 1}/1 ${f[1] + 1}/2 ${f[2] + 1}/3\nf ${f[0] + 1}/1 ${f[2] + 1}/3 ${f[3] + 1}/4\n`;
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'c.obj'); await sleep(300);
    // something to find in the zip: an AI layer
    const L = ed.layers, N = L.w; const c = document.createElement('canvas'); c.width = c.height = N; c.getContext('2d').fillRect(0, 0, N / 2, N);
    L.addLayer(L.fromImage(c), 'AI test', { ai: true, prompt: 'x' }); await sleep(80);
    const calls = [], fail = { on: false };
    ed.hooks.projectApi = {
      dirs: async (p) => ({ path: p || '/srv/out', parent: '/srv', dirs: ['alpha', 'beta'], default: '/srv/out', unrestricted: true }),
      mkdir: async (p, n) => ({ ok: true, path: p + '/' + n }),
      save: async (blob, name, dir, extract) => { if (fail.on) throw new Error('boom 413'); calls.push({ size: blob.size, head: new Uint8Array(await blob.slice(0, 2).arrayBuffer()), name, dir, extract, blob }); return { path: dir + '/' + name + '.zip', loose_dir: extract ? dir + '/' + name : null }; },
    };
    const btn = (root, t) => [...root.querySelectorAll('button')].find((b) => b.textContent.startsWith(t));
    R.buttons = !!btn(ed.ui.sec.exp.body, 'Save project as') && !!btn(ed.ui.sec.pre.body, 'Save project as');
    const dlgs = ed.openSaveAs(); await sleep(150);
    const m = ed.root.querySelector('.tp-modal');
    R.opened = !!m && /Save project as/.test(m.textContent) && /alpha/.test(m.textContent) && /beta/.test(m.textContent);
    R.destServer = m.querySelector('input[type=radio]').checked;
    R.second = ed.openSaveAs() === null;            // only one window at a time
    const nameIn = m.querySelector('input[type=text]'); nameIn.value = 'my ship v2';
    [...m.querySelectorAll('.tp-dirs div')].find((d) => /alpha/.test(d.textContent)).click(); await sleep(100);
    const pathVal = [...m.querySelectorAll('input[type=text]')][1].value;
    btn(m, 'Save').click();
    for (let i = 0; i < 100 && !calls.length; i++) await sleep(100);
    await sleep(100);
    const call = calls[0];
    R.called = !!call && call.name === 'my ship v2' && call.extract === true && /alpha/.test(call.dir) && call.head[0] === 0x50 && call.head[1] === 0x4b;
    R.dbg = [pathVal, call && call.dir];
    const entries = window.TP.readStoredZip(await call.blob.arrayBuffer());
    R.zipHas = entries.has('project.json') && entries.has('texture_flattened.png') && [...entries.keys()].some((k) => k.startsWith('layers/')) && [...entries.keys()].some((k) => k.startsWith('model/'));
    R.saidSaved = /Saved: .*my ship v2\.zip/.test(m.textContent);
    btn(m, 'Close').click(); await sleep(50);
    R.closed = !ed.root.querySelector('.tp-modal');
    // preferences are remembered, an upload error is shown and the window stays open
    ed.openSaveAs(); await sleep(150);
    const m2 = ed.root.querySelector('.tp-modal');
    R.remembered = [...m2.querySelectorAll('input[type=text]')][0].value === 'my ship v2' && /alpha/.test([...m2.querySelectorAll('input[type=text]')][1].value);
    fail.on = true; btn(m2, 'Save').click(); await sleep(1500);
    R.errShown = /Save failed: boom 413/.test(m2.textContent) && !!ed.root.querySelector('.tp-modal');
    fail.on = false;
    // plain download
    let dl = null; const origClick = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { dl = this.download; };
    m2.querySelectorAll('input[type=radio]')[2].click(); await sleep(50);
    R.looseHidden = [...m2.querySelectorAll('label')].find((l) => /loose files/.test(l.textContent)).style.display === 'none';
    btn(m2, 'Save').click(); for (let i = 0; i < 100 && !dl; i++) await sleep(100);
    HTMLAnchorElement.prototype.click = origClick;
    R.download = dl === 'my ship v2.zip';
    // Escape closes
    m2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await sleep(50);
    R.esc = !ed.root.querySelector('.tp-modal');
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'needs a model': R.noModel, 'buttons in Export and Presets sections': R.buttons, 'window opens with the folder list': R.opened, 'server folder is the default': R.destServer,
    'only one window': R.second, 'save sends name / folder / loose flag / a zip': R.called, 'zip holds project, model, layers and flattened texture': R.zipHas,
    'result shown': R.saidSaved, 'close': R.closed, 'last choices remembered': R.remembered, 'errors stay visible': R.errShown,
    'download mode hides loose files and downloads the zip': R.looseHidden && R.download, 'Escape closes': R.esc,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
