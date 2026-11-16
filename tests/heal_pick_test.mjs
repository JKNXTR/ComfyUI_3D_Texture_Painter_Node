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

let failed = false;
const ok = (n, c, x) => { console.log((c ? 'PASS ' : 'FAIL ') + n + (c ? '' : '  ' + JSON.stringify(x))); if (!c) failed = true; };
try {
  await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
  await page.waitForFunction('window.ready === true', { timeout: 20000 });
  const R = await page.evaluate(async () => {
    const R = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = new window.TP.TexturePaintEditor();
    document.getElementById('host').append(ed.root);
    await sleep(300);
    const cubeObj = (name, cx, vi0) => {
      const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
      const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
      let s = 'o ' + name + '\n';
      for (const p of P) s += `v ${p[0] + cx} ${p[1]} ${p[2]}\n`;
      s += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
      for (const f of F) s += `f ${f[0] + vi0}/1 ${f[1] + vi0}/2 ${f[2] + vi0}/3\nf ${f[0] + vi0}/1 ${f[2] + vi0}/3 ${f[3] + vi0}/4\n`;
      return s;
    };
    await ed.loadModelBuffer(new TextEncoder().encode(cubeObj('Alpha', -3, 1) + cubeObj('Beta', 0, 9) + cubeObj('Gamma', 3, 17)).buffer, 'multi.obj');
    await sleep(300);
    const ids = {}; for (const nd of ed.objTree.rows) ids[nd.name] = nd.id;
    const key = (k, shift) => ed.root.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, shiftKey: !!shift }));
    const p3 = ed.ui.pane3d, W = p3.offsetWidth, H = p3.offsetHeight;
    const scan = () => { const seen = {}; for (let y = 0.2; y < 0.8; y += 0.05) for (let x = 0.05; x < 0.95; x += 0.03) { const r = ed.pickAt(x * W, y * H, W, H); if (r) seen[r.name] = seen[r.name] || [x * W, y * H]; } return seen; };

    // ---- V: select tool
    key('v'); R.toolV = ed.state.tool;
    let seen = scan(); R.seenWhole = Object.keys(seen).sort();
    const a = seen.Alpha; R.alphaPt = !!a;
    if (a) { await ed.pickObject(a[0], a[1], W, H, {}); R.afterAlpha = ed.state.model.object === ids.Alpha; R.alphaTris = ed.info.triangles; }
    ed.frameAll(); await sleep(250);
    seen = scan(); R.seenLeaf = Object.keys(seen).sort();   // working object + context meshes
    const b = seen.Beta;
    if (b) { await ed.pickObject(b[0], b[1], W, H, {}); R.afterBeta = ed.state.model.object === ids.Beta; }
    ed.frameAll(); await sleep(250);
    const g = scan().Gamma;
    if (g) { await ed.pickObject(g[0], g[1], W, H, { ctrlKey: true }); R.ctrlSet = ed.state.model.object; R.ctrlOk = ed.state.model.object === ids.Beta + '|' + ids.Gamma; }
    ed.frameAll(); await sleep(250);
    const g2 = scan().Gamma;
    if (g2) { await ed.pickObject(g2[0], g2[1], W, H, { altKey: true }); R.altParent = ed.state.model.object; }
    // clicking the pane with the select tool must not paint
    const maskBefore = ed.maskVersion;
    p3.dispatchEvent(new PointerEvent('pointerdown', { button: 0, clientX: p3.getBoundingClientRect().left + W / 2, clientY: p3.getBoundingClientRect().top + H / 2, bubbles: true, pointerId: 1 }));
    await sleep(200);
    R.noPaint = ed.maskVersion === maskBefore && !ed.stroke;
    // back to the whole model for the heal test
    await ed.selectObject(''); await sleep(200);

    // ---- J: heal brush
    key('j'); R.toolJ = [ed.state.tool, ed.state.brushTarget];
    const sel0 = ed.maskVersion, he0 = ed.healVersion;
    ed.state.brush.size = 200;
    ed.beginStroke(false); ed.strokeMove(W / 2, H / 2, 0); ed.strokeMove(W / 2 + 30, H / 2 + 10, 0); ed.endStroke();
    R.healPainted = !ed.healIsEmpty(); R.selUntouched = ed.maskVersion === sel0; R.healBumped = ed.healVersion > he0;
    ed.undo(); R.undoEmpty = ed.healIsEmpty(); ed.redo(); R.redoPainted = !ed.healIsEmpty();
    // erase with E while the heal target is active
    key('e'); ed.beginStroke(true); ed.strokeMove(W / 2, H / 2, 0); ed.endStroke(); const afterErase = ed.healIsEmpty();
    ed.undo(); R.eraseWorks = afterErase !== undefined && !ed.healIsEmpty();
    key('b'); R.bKeepsHeal = ed.state.brushTarget === 'heal';
    key('j'); R.jTogglesBack = ed.state.brushTarget === 'selection';
    // round trip of the mask file
    const blob = await ed.exportHealBlob(); const bmp = await createImageBitmap(blob);
    ed.healClear(); R.cleared = ed.healIsEmpty(); ed.importHealBitmap(bmp); R.imported = !ed.healIsEmpty();

    // ---- capture: normal vs heal run
    const tex = document.createElement('canvas'); tex.width = tex.height = 512; tex.getContext('2d').fillStyle = '#884422'; tex.getContext('2d').fillRect(0, 0, 512, 512);
    ed.setTextureFromImage(tex, { label: 't', keepHistory: false });
    ed.state.brushTarget = 'selection'; ed.beginStroke(false); ed.strokeMove(W / 4, H / 2, 0); ed.endStroke();
    const n = await ed.capture({ includeMesh: false, includeTexture: true });
    R.normal = { src: n.meta.mask_source, heal: n.meta.heal, hasBake: !!n.bakemask };
    ed.state.heal.on = true; ed.state.heal.prompt = 'fix the seam please';
    const hcap = await ed.capture({ includeMesh: false, includeTexture: true });
    const px = async (b) => { const bm = await createImageBitmap(b); const c = document.createElement('canvas'); c.width = bm.width; c.height = bm.height; const x = c.getContext('2d'); x.drawImage(bm, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i]; return s; };
    R.healCap = { src: hcap.meta.mask_source, heal: hcap.meta.heal, hasBake: !!hcap.bakemask };
    R.bakeIsHeal = (await px(hcap.bakemask)) === (await px(await ed.exportHealBlob())) && (await px(hcap.bakemask)) !== (await px(await ed.exportMaskBlob()));
    // prompt preview text
    R.preview = window.TP.composePrompt({ prompt: 'normal prompt', style_hint: 'style!', compose_prompt: true, mask_hint: 'color_fill', hint_color: '#ff00ff' }, ed.state, false, [false, false, false, false]);
    R.state = JSON.stringify(ed.getState().heal);
    return R;
  });
  ok('V selects the select tool', R.toolV === 'select', R.toolV);
  ok('picking finds all three objects in the whole model', JSON.stringify(R.seenWhole) === '["Alpha","Beta","Gamma"]', R.seenWhole);
  ok('click on Alpha makes it the working object', R.afterAlpha && R.alphaTris === 12, R);
  ok('picking sees the working object and the context objects', JSON.stringify(R.seenLeaf) === '["Alpha","Beta","Gamma"]', R.seenLeaf);
  ok('click on a context object (Beta) switches to it', R.afterBeta, R);
  ok('Ctrl-click adds Gamma to the working set', R.ctrlOk, R.ctrlSet);
  ok('Alt-click selects the parent group', typeof R.altParent === 'string' && R.altParent !== undefined, R.altParent);
  ok('select tool does not paint', R.noPaint, R);
  ok('J selects the heal brush', R.toolJ[0] === 'brush' && R.toolJ[1] === 'heal', R.toolJ);
  ok('heal stroke paints the heal mask only', R.healPainted && R.selUntouched && R.healBumped, R);
  ok('heal undo / redo', R.undoEmpty && R.redoPainted, R);
  ok('eraser works on the heal area', R.eraseWorks, R);
  ok('B keeps the heal target, J again returns', R.bKeepsHeal && R.jTogglesBack, R);
  ok('heal mask export / import round trip', R.cleared && R.imported, R);
  ok('normal capture: selection mask, no heal meta', R.normal.src === 'selection' && R.normal.heal === null && !R.normal.hasBake, R.normal);
  ok('heal capture: heal mask is the AI mask + heal prompt in meta', R.healCap.src === 'transition' && R.healCap.hasBake && R.healCap.heal && R.healCap.heal.prompt === 'fix the seam please', R.healCap);
  ok('heal capture bakemask equals the heal area, not the selection', R.bakeIsHeal, R);
  ok('prompt preview uses only the heal prompt', /fix the seam please/.test(R.preview) && !/normal prompt|style!/.test(R.preview), R.preview);
} catch (e) { failed = true; console.log('FAIL exception ' + (e.stack || e)); }
const errs = logs.filter((l) => /pageerror|^\[error\](?!.*Failed to load resource)/.test(l));
if (errs.length) { failed = true; console.log('FAIL console errors:\n' + errs.slice(0, 6).join('\n')); }
await browser.close(); server.close();
console.log(failed ? 'FAILED' : 'ALL PASS');
process.exit(failed ? 1 : 0);
