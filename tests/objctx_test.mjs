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
    const cubeObj = (name, cx, vi0) => {
      const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
      const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
      let s = 'o ' + name + '\n'; for (const p of P) s += `v ${p[0] + cx} ${p[1]} ${p[2]}\n`;
      s += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
      for (const f of F) s += `f ${f[0] + vi0}/1 ${f[1] + vi0}/2 ${f[2] + vi0}/3\nf ${f[0] + vi0}/1 ${f[2] + vi0}/3 ${f[3] + vi0}/4\n`;
      return s;
    };
    await ed.loadModelBuffer(new TextEncoder().encode(cubeObj('Alpha', -3, 1) + cubeObj('Beta', 0, 9) + cubeObj('Gamma', 3, 17)).buffer, 'multi.obj'); await sleep(300);
    const ids = {}; for (const nd of ed.objTree.rows) ids[nd.name] = nd.id;
    const solid = async (color) => { const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 256, 256); return createImageBitmap(c); };
    R.bar = { shown: ed.ui.pane3d.querySelector('.tp-ctxbar').style.display === 'block', boxes: ed.ui.pane3d.querySelectorAll('.tp-ctxbar input').length, off: !ed.state.objTex.show && !ed.state.objTex.ref };
    await ed.selectObject(ids.Alpha); ed.setTextureFromImage(await solid('#ff0000'), { label: 'red', keepHistory: false });
    await ed.selectObject(ids.Gamma); ed.setTextureFromImage(await solid('#00ff00'), { label: 'green', keepHistory: false });
    await ed.selectObject(ids.Beta); ed.setTextureFromImage(await solid('#808080'), { label: 'grey', keepHistory: false });
    ed.frameAll(); await sleep(200);
    const grp = () => ed.scene.children.find((c) => c.isGroup && c.children.length);
    const mapped = () => grp().children.filter((m) => m.material.map).length;
    R.grey = mapped() === 0;
    const cap = async () => { const c = await ed.capture({ includeMesh: false, includeTexture: false }); const b = await createImageBitmap(c.view); const k = document.createElement('canvas'); k.width = b.width; k.height = b.height; const g = k.getContext('2d'); g.drawImage(b, 0, 0); const d = g.getImageData(0, 0, k.width, k.height).data; let red = 0, green = 0; for (let i = 0; i < d.length; i += 4) { if (d[i] > 150 && d[i + 1] < 90 && d[i + 2] < 90) red++; if (d[i + 1] > 150 && d[i] < 90 && d[i + 2] < 90) green++; } return { red, green, meta: c.meta.ctx_reference, sceneKids: ed.passScene.children.length }; };
    R.capOff = await cap();
    // viewport switch
    const boxes = ed.ui.pane3d.querySelectorAll('.tp-ctxbar input'); boxes[0].checked = true; boxes[0].dispatchEvent(new Event('change'));
    R.show = { state: ed.state.objTex.show, mapped: mapped(), capStillPlain: (await cap()).red === 0 };
    boxes[0].checked = false; boxes[0].dispatchEvent(new Event('change')); R.showOff = mapped() === 0;
    // reference switch
    boxes[1].checked = true; boxes[1].dispatchEvent(new Event('change'));
    R.capOn = await cap();
    // hidden objects are not part of the reference
    ed.state.objHidden = [ids.Alpha]; ed.objectsRefresh && ed.objectsRefresh(); ed._objectsChanged();
    R.capHidden = await cap();
    ed.state.objHidden = []; ed._objectsChanged();
    // persistence of the two flags
    const s1 = ed.getState(); R.state = s1.objTex.ref === true;
    ed.state.objTex.ref = false; ed.applyState(s1); R.applied = ed.state.objTex.ref === true && boxes[1].checked === true;
    // single-object model: bar hidden
    await ed.loadModelBuffer(new TextEncoder().encode(cubeObj('Solo', 0, 1)).buffer, 'solo.obj'); await sleep(200);
    R.soloHidden = ed.ui.pane3d.querySelector('.tp-ctxbar').style.display === 'none';
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'switches appear for multi-object models only, default off': R.bar.shown && R.bar.boxes === 2 && R.bar.off && R.soloHidden,
    'other objects grey by default': R.grey,
    '"Show textures": context objects get their own textures; the AI capture is unchanged': R.show.state && R.show.mapped === 2 && R.show.capStillPlain && R.showOff,
    'capture without reference has no neighbour colours, pass scene restored': R.capOff.red === 0 && R.capOff.green === 0 && R.capOff.sceneKids === 1,
    '"Use as reference": capture contains both neighbours in their colours': R.capOn.red > 50 && R.capOn.green > 50 && R.capOn.meta === true && R.capOn.sceneKids === 1,
    'hidden objects are left out of the reference': R.capHidden.red === 0 && R.capHidden.green > 50,
    'flags saved in the state and applied back': R.state && R.applied,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) { failed = true; console.log('TEST FAILURE:', e.stack || e); }
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
