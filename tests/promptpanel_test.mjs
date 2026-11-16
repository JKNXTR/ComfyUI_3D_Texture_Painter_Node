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
    const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
    const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
    let obj = 'o A\n'; for (const p of P) obj += `v ${p[0]} ${p[1]} ${p[2]}\n`;
    obj += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
    for (const f of F) obj += `f ${f[0] + 1}/1 ${f[1] + 1}/2 ${f[2] + 1}/3\nf ${f[0] + 1}/1 ${f[2] + 1}/3 ${f[3] + 1}/4\n`;
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'c.obj'); await sleep(300);
    const st = ed.state, L = ed.layers, N = L.w;
    // fake workflow hooks
    const calls = { prompt: null, widgets: {}, bake: {} }; let promptNow = 'old prompt';
    Object.assign(ed.hooks, { getPrompt: () => promptNow, setPrompt: (t) => { promptNow = t; calls.prompt = t; }, setWidget: (n, v) => { calls.widgets[n] = v; return true; }, setBakeWidget: (n, v) => { calls.bake[n] = v; return 1; } });
    const sec = ed.ui.sec;
    R.sections = !!sec.trp && !!sec.har && /Transition prompts/.test(sec.trp.el.textContent) && /Final harmonize/.test(sec.har.el.textContent);
    const btn = (root, t) => [...root.querySelectorAll('button')].find((b) => b.textContent.startsWith(t));
    const catSel = sec.trp.body.querySelector('select');
    const rows = () => [...sec.trp.body.querySelectorAll('.tp-dirs div')];
    R.all = rows().length >= 27;
    catSel.value = 'face'; catSel.dispatchEvent(new Event('change')); R.face = rows().length === 3;
    rows()[0].click(); const ta = sec.trp.body.querySelector('textarea'); R.preview = /face/.test(ta.value) && ta.value.length > 30;
    R.defaultSource = st.gen.maskSource === 'selection';
    btn(sec.trp.body, 'Use as prompt').click(); await sleep(60);
    R.used = calls.prompt === ta.value && st.gen.maskSource === 'transition' && calls.widgets.mask_grow === 12 && calls.widgets.mask_feather === 10 && calls.bake.strength === 0.85;
    R.warnEmpty = /EMPTY/.test(sec.trp.body.textContent);
    btn(sec.trp.body, 'Add to prompt').click(); await sleep(30);
    R.appended = calls.prompt.startsWith('old prompt') === false && calls.prompt.includes(ta.value) && calls.prompt.split(ta.value).length === 3;
    // my prompts
    ta.value = 'my special blend text for the marked area'; const nameIn = sec.trp.body.querySelector('input[placeholder^="Name for"]'); nameIn.value = 'My blend';
    btn(sec.trp.body, 'Save as my prompt').click();
    R.custom = st.tprompts.length === 1 && st.tprompts[0].title === 'My blend' && catSel.value === 'custom' && rows().length === 1;
    btn(sec.trp.body, 'Delete').click(); R.deleted = st.tprompts.length === 0;
    // capture plumbing: paint ONLY the transition mask, then capture with both sources
    st.brushTarget = 'transition'; ed._applyStateToUI();
    const pane = ed._paneSize(ed.ui.pane3d), cv = document.createElement('canvas'); cv.width = pane.w; cv.height = pane.h;
    const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, pane.w, pane.h); ed.fillShape(cv, false); await sleep(100);
    const white = async (blob) => { const b = await createImageBitmap(blob); const c = document.createElement('canvas'); c.width = b.width; c.height = b.height; const x = c.getContext('2d'); x.drawImage(b, 0, 0); const d = x.getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i] > 128) n++; return n; };
    st.gen.maskSource = 'selection'; const o1 = await ed.capture({ includeMesh: false, includeTexture: false });
    st.gen.maskSource = 'transition'; const o2 = await ed.capture({ includeMesh: false, includeTexture: false });
    R.sel = (await white(o1.viewmask)) === 0 && !o1.bakemask && o1.meta.mask_source === 'selection';
    R.tr = (await white(o2.viewmask)) > 1000 && !!o2.bakemask && o2.meta.mask_source === 'transition';
    R.uvmaskStays = (await white(o2.uvmask)) === 0;   // the AI selection file is untouched (autosave keeps using it)
    R.rebound = ed.passMat.uniforms.tMask.value === ed.maskRT.texture;
    // presets never carry the mask source
    R.presetClean = ed.buildPreset().settings.gen.maskSource === undefined;
    // harmonize
    const hs = sec.har.body, hsel = hs.querySelector('select'); R.hList = hsel.options.length >= 6;
    hsel.value = 'har-seams'; hsel.dispatchEvent(new Event('change')); R.hText = /seam/.test(hs.querySelector('textarea').value) && st.har.preset === 'har-seams';
    ed.maskClear(); R.cleared = ed.maskIsEmpty();
    btn(hs, 'Step 2').click(); await sleep(150);
    R.prep = !ed.maskIsEmpty() && st.gen.maskSource === 'selection' && calls.widgets.mask_hint === 'none' && calls.widgets.hint_strength === 0 && calls.widgets.mask_grow === 0 && calls.bake.strength === 0.5 && /seam/.test(calls.prompt);
    ed.undo(); await sleep(30); R.undoPrep = ed.maskIsEmpty();
    // step 1: flatten with AI layers present
    const mk = (col, x0, x1, name) => { const c = document.createElement('canvas'); c.width = c.height = N; const x = c.getContext('2d'); x.fillStyle = col; x.fillRect(x0 * N, 0, (x1 - x0) * N, N); return L.addLayer(L.fromImage(c), name, { ai: true, prompt: name }); };
    mk('#dc2828', 0.05, 0.6, 'AI red'); mk('#2828dc', 0.4, 0.95, 'AI blue'); await sleep(100);
    const n0 = L.layers.length; btn(hs, 'Step 1').click();
    for (let i = 0; i < 100 && L.layers.length === n0; i++) await sleep(100);
    R.flat = L.layers.length === n0 + 1 && L.activeLayer.name.startsWith('Combined') && st.combine.normalize === 'anchor' && st.combine.detail === 'multiband';
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'both panels exist': R.sections, 'library lists 27+ prompts': R.all, 'category filter (face = 3)': R.face, 'preview text': R.preview, 'default mask source is the AI selection': R.defaultSource,
    'Use as prompt: prompt, transition source, soft edges, bake strength': R.used, 'warns when the blue mask is empty': R.warnEmpty, 'Add to prompt appends': R.appended,
    'my prompts: save + delete': R.custom && R.deleted, 'capture with selection source: view mask empty, no bakemask': R.sel, 'capture with transition source: view mask + bakemask + meta': R.tr,
    'AI selection file stays untouched': R.uvmaskStays, 'pass material rebound afterwards': R.rebound, 'presets do not carry the mask source': R.presetClean,
    'harmonize list + text': R.hList && R.hText, 'Step 2 prepares the whole-surface pass': R.prep, 'Step 2 is undoable': R.undoPrep, 'Step 1 flattens into a Combined layer': R.flat,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
