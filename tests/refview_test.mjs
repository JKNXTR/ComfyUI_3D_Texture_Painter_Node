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
    const mu = ed.meshMat.uniforms;
    const k = document.createElement('canvas'); k.width = k.height = 32; const g = k.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 32, 32);
    await ed.setRef2Image(new File([await new Promise((r) => k.toBlob(r))], 'ref.png', { type: 'image/png' }));
    const r = ed.refState(); r.mode = 'manual'; r.enabled = true;
    const call = () => ed._refUniforms(ed.ui.pane3d, 400, 400, 400);
    ed.setPlaceMode(true); call(); R.placing = mu.uRefOn.value === 1;
    ed.setPlaceMode(false); call(); R.afterDone = mu.uRefOn.value === 1;
    R.defA = Math.abs(mu.uRefA.value - 0.95) < 1e-6;
    const root = ed.root;
    const labels = [...root.querySelectorAll('label,span,div')];
    const findIn = (txt) => labels.find((e) => e.children.length < 3 && e.textContent.trim().startsWith(txt));
    const vis = [...root.querySelectorAll('input[type=checkbox]')].find((c) => /Show the placed image/.test(c.parentElement.textContent));
    const sl = [...root.querySelectorAll('input[type=range]')].find((c) => /Image opacity in the 3D view/.test(c.parentElement.textContent));
    R.ui = !!vis && !!sl;
    sl.value = 40; sl.dispatchEvent(new Event('input', { bubbles: true })); call();
    R.op = Math.abs(mu.uRefA.value - 0.4) < 0.01 && Math.abs(r.viewOpacity - 0.4) < 0.01;
    vis.checked = false; vis.dispatchEvent(new Event('change', { bubbles: true })); call();
    R.off = mu.uRefOn.value === 0 && r.view === false;
    vis.checked = true; vis.dispatchEvent(new Event('change', { bubbles: true })); call(); R.on = mu.uRefOn.value === 1;
    const all = [...root.querySelectorAll('input[type=checkbox]')].find((c) => /Show the whole image/.test(c.parentElement.textContent));
    all.checked = true; all.dispatchEvent(new Event('change', { bubbles: true })); call(); R.all = mu.uRefAll.value === 1;
    // wireframe chip next to Grid
    const bar = ed.ui.pane3d.querySelector('.tp-vbar');
    const wc = [...bar.querySelectorAll('input[type=checkbox]')];
    R.chips = wc.length === 2 && /Grid/.test(wc[0].parentElement.textContent) && /Wireframe/.test(wc[1].parentElement.textContent);
    const w0 = ed.wireMesh.visible; wc[1].checked = true; wc[1].dispatchEvent(new Event('change', { bubbles: true }));
    R.wireOn = !w0 && ed.wireMesh.visible === true && ed.state.display.wire3d === true;
    const dp = [...root.querySelectorAll('input[type=checkbox]')].find((c) => /3D wireframe overlay/.test(c.parentElement.textContent));
    R.synced = dp && dp.checked === true;
    wc[1].checked = false; wc[1].dispatchEvent(new Event('change', { bubbles: true }));
    R.wireOff = ed.wireMesh.visible === false && dp.checked === false;
    // ---- full screen / resize: the placement must stay glued to the model (scales with the pane HEIGHT)
    ed.state.capture.aspect = '1:1'; r.ox = 0.2; r.oy = -0.1; r.size = 0.5; ed.state.display.refK = 0; ed._refK = 0;
    const pane = ed.ui.pane3d;
    ed._refUniforms(pane, 700, 500, 800);                       // windowed: frame 500 wide (height-limited)
    const pxA = { x: r.ox * ed.frameRect(700, 500).w / 500, s: r.size * ed.frameRect(700, 500).w / 500 };
    ed._refUniforms(pane, 700, 900, 1000);                      // tall pane: frame is width-limited (700)
    const pxB = { x: r.ox * ed.frameRect(700, 900).w / 900, s: r.size * ed.frameRect(700, 900).w / 900 };
    ed._refUniforms(pane, 1800, 1000, 1000);                    // 'full screen'
    const pxC = { x: r.ox * ed.frameRect(1800, 1000).w / 1000, s: r.size * ed.frameRect(1800, 1000).w / 1000 };
    ed._refUniforms(pane, 700, 500, 800);                       // back
    R.fsKeep = [pxB, pxC].every((q) => Math.abs(q.x - pxA.x) < 1e-6 && Math.abs(q.s - pxA.s) < 1e-6);
    R.fsBack = Math.abs(r.ox - 0.2) < 1e-6 && Math.abs(r.size - 0.5) < 1e-6 && Math.abs(r.oy + 0.1) < 1e-6;
    R.fsAll = ed.state.refx.every((x) => x.size > 0);
    // ---- UV texture output toggle (on the UV map pane): goes into the capture meta and the prompt preview
    const uvCb = [...ed.ui.paneUV.querySelectorAll('input[type=checkbox]')].find((c) => /UV texture output/.test(c.parentElement.textContent));
    R.uvUi = !!uvCb && uvCb.checked === false;
    uvCb.checked = true; uvCb.dispatchEvent(new Event('change', { bubbles: true }));
    R.uvOn = ed.state.capture.uvMode === true;
    const out = await ed.capture({ includeMesh: false, includeTexture: true });
    R.uvMeta = !!(out && out.meta && out.meta.uv_mode);
    const { composePrompt } = window.TP;
    R.uvPrompt = !!composePrompt && composePrompt({ prompt: 'brick', style_hint: '', compose_prompt: true, mask_hint: 'tint_color', hint_color: '#ff00ff' }, ed.state, false, [false, false, false, false]).includes('flat UV texture map');
    uvCb.checked = false; uvCb.dispatchEvent(new Event('change', { bubbles: true })); R.uvOff = ed.state.capture.uvMode === false;
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'placing shows the image': R.placing, 'stays visible after Done placing': R.afterDone, 'default opacity 95%': R.defA,
    'panel has visibility + opacity controls': R.ui, 'opacity slider drives the shader': R.op,
    'visibility off hides it, on shows it': R.off && R.on, 'show whole image': R.all,
    'Wireframe chip sits beside Grid': R.chips, 'wireframe chip toggles edges': R.wireOn,
    'placement stays glued to the model when the view size/shape changes': R.fsKeep, 'and returns to the same numbers': R.fsBack && R.fsAll, 'UV texture output toggle on the UV map': R.uvUi && R.uvOn && R.uvOff, 'toggle is sent in the capture meta': R.uvMeta, 'prompt mentions the UV map': R.uvPrompt, 'chip syncs with Display panel': R.synced, 'wireframe off': R.wireOff,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) { failed = true; console.log('TEST FAILURE:', e.stack || e); }
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
