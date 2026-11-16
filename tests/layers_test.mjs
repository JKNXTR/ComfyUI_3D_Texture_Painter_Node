// Headless-Chrome test of the layer system, blend modes, masks, undo, persistence, padding and model export.
// Usage: node tests/layers_test.mjs <outDir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
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
try {
  await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
  await page.waitForFunction('window.ready === true', { timeout: 20000 });
  const R = await page.evaluate(async () => {
    const R = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = new window.TP.TexturePaintEditor();
    document.getElementById('host').append(ed.root);
    await sleep(300);
    const L = ed.layers;
    const px = (c, x = 3, y = 3) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
    const solid = (hex, a = 1, w = 16, h = 16) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.globalAlpha = a; g.fillStyle = hex; g.fillRect(0, 0, w, h); return c; };
    const hex2 = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

    // ---------------- 1) blend modes vs reference formulas (W3C compositing spec)
    const lum = (c) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
    const clip = (c) => { const l = lum(c), n = Math.min(...c), x = Math.max(...c); let o = c.slice(); if (n < 0) o = o.map((v) => l + (v - l) * l / (l - n)); if (x > 1) o = o.map((v) => l + (v - l) * (1 - l) / (x - l)); return o; };
    const setLum = (c, l) => { const d = l - lum(c); return clip(c.map((v) => v + d)); };
    const sat = (c) => Math.max(...c) - Math.min(...c);
    const setSat = (c, s) => { const mn = Math.min(...c), mx = Math.max(...c); return mx > mn ? c.map((v) => (v - mn) * s / (mx - mn)) : [0, 0, 0]; };
    const hard = (b, s) => (s <= 0.5 ? b * 2 * s : b + (2 * s - 1) - b * (2 * s - 1));
    const soft = (b, s) => { if (s <= 0.5) return b - (1 - 2 * s) * b * (1 - b); const d = b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b); return b + (2 * s - 1) * (d - b); };
    const dodge = (b, s) => (b <= 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)));
    const burn = (b, s) => (b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s));
    const ch = (f) => (b, s) => b.map((v, i) => f(v, s[i]));
    const REF = {
      normal: (b, s) => s, multiply: ch((b, s) => b * s), screen: ch((b, s) => b + s - b * s), overlay: ch((b, s) => hard(s, b)),
      softlight: ch(soft), hardlight: ch(hard), darken: ch(Math.min), lighten: ch(Math.max), dodge: ch(dodge), burn: ch(burn),
      add: ch((b, s) => Math.min(1, b + s)), difference: ch((b, s) => Math.abs(b - s)),
      hue: (b, s) => setLum(setSat(s, sat(b)), lum(b)), color: (b, s) => setLum(s, lum(b)), luminosity: (b, s) => setLum(b, lum(s)),
    };
    const pairs = [['#cc8844', '#3377dd'], ['#202a40', '#e0d070'], ['#90a0b0', '#a05030'], ['#ff2200', '#0044ff']];
    let worst = 0, worstWhat = '';
    for (const [id] of window.TP.BLEND_MODES) {
      for (const [bh, sh] of pairs) {
        for (const op of [1, 0.6]) {
          ed._resetStack({ w: 16, h: 16, color: bh });
          L.addImage(solid(sh), 'top');
          L.setProp(1, { blend: id, opacity: op });
          const got = px(L.bakeCanvas(0));
          const cb = hex2(bh).map((v) => v / 255), cs = hex2(sh).map((v) => v / 255);
          const B = REF[id](cb, cs);
          const exp = cb.map((v, i) => (v * (1 - op) + B[i] * op) * 255);
          const err = Math.max(...exp.map((v, i) => Math.abs(v - got[i])));
          if (err > worst) { worst = err; worstWhat = `${id} ${bh}/${sh} op=${op} got=${got} exp=${exp.map(Math.round)}`; }
        }
      }
    }
    R.blendWorst = +worst.toFixed(2); R.blendWorstWhat = worstWhat;
    // alpha source (Normal): 50% red over blue
    ed._resetStack({ w: 16, h: 16, color: '#0000ff' });
    L.addImage(solid('#ff0000', 0.5), 'half');
    R.alphaMix = px(L.bakeCanvas(0));

    // ---------------- 2) structure ops + undo / redo / gc
    ed._resetStack({ w: 16, h: 16, color: '#336699' });
    ed._clearHistory();
    const snapshot = () => px(L.bakeCanvas(0)).join(',') + '|' + L.layers.map((l) => `${l.name}:${l.opacity}:${l.blend}:${l.visible}`).join(';');
    const s0 = snapshot();
    L.addImage(solid('#ff8800'), 'orange'); const s1 = snapshot();
    L.addImage(solid('#00ff88', 0.7), 'green'); const s2 = snapshot();
    L.setProp(2, { opacity: 0.4 }); const s3 = snapshot();
    L.rename(2, 'Moss'); const s4 = snapshot();
    L.move(2, 1); const s5 = snapshot();
    L.setProp(1, { visible: false }); const s6 = snapshot();
    const states = [s0, s1, s2, s3, s4, s5, s6];
    const back = [];
    for (let i = 0; i < 6; i++) { ed.undo(); back.push(snapshot()); }
    R.undoMatches = back.every((v, i) => v === states[5 - i]);
    const fwd = [];
    for (let i = 0; i < 6; i++) { ed.redo(); fwd.push(snapshot()); }
    R.redoMatches = fwd.every((v, i) => v === states[i + 1]);
    R.layerCountAfter = L.layers.length;
    // remove all extras, clear history, gc must free every unreferenced target
    L.remove(2); L.remove(1);
    ed._clearHistory();
    R.registryAfterGc = L.registry.size;
    R.layersAfterRemove = L.layers.length;
    // last layer cannot be removed
    L.remove(0); R.lastLayerKept = L.layers.length === 1;

    // ---------------- 3) merge / flatten keep the look
    ed._resetStack({ w: 16, h: 16, color: '#7090b0' });
    L.addImage(solid('#d04020'), 'a'); L.setProp(1, { blend: 'multiply', opacity: 0.8 });
    L.addImage(solid('#20c0a0', 0.8), 'b'); L.setProp(2, { blend: 'overlay', opacity: 0.7 });
    const look = px(L.bakeCanvas(0));
    L.mergeVisible(); const afterMerge = px(L.bakeCanvas(0));
    R.mergeVisibleLayers = L.layers.length;
    R.mergeDiff = Math.max(...look.map((v, i) => Math.abs(v - afterMerge[i])));
    ed._resetStack({ w: 16, h: 16, color: '#7090b0' });
    L.addImage(solid('#d04020'), 'a'); L.setProp(1, { blend: 'multiply', opacity: 0.8 });
    L.addImage(solid('#20c0a0', 0.8), 'b'); L.setProp(2, { blend: 'screen', opacity: 0.7, visible: false });
    const look2 = px(L.bakeCanvas(0));
    L.flattenAll(); const afterFlat = px(L.bakeCanvas(0));
    R.flattenLayers = L.layers.length; R.flattenName = L.layers[0].name;
    R.flattenDiff = Math.max(...look2.map((v, i) => Math.abs(v - afterFlat[i])));
    ed.undo(); R.flattenUndoLayers = L.layers.length;
    // merge down: normal lower layer
    ed._resetStack({ w: 16, h: 16, color: '#7090b0' });
    L.addImage(solid('#d04020'), 'a'); L.addImage(solid('#20c0a0', 0.8), 'b'); L.setProp(2, { blend: 'screen', opacity: 0.6 });
    const look3 = px(L.bakeCanvas(0));
    L.mergeDown(2); R.mergeDownLayers = L.layers.length;
    R.mergeDownDiff = Math.max(...look3.map((v, i) => Math.abs(v - px(L.bakeCanvas(0))[i])));

    // ---------------- 4) capture source modes
    ed._resetStack({ w: 16, h: 16, color: '#ff0000' });
    L.addImage(solid('#00ff00'), 'g'); L.addImage(solid('#0000ff'), 'b');
    L.select(1);
    const cap = {};
    for (const m of ['composite', 'below', 'active']) cap[m] = px(L.captureCanvas(m));
    R.captureModes = cap;

    // ---------------- 5) persistence round trip
    ed._resetStack({ w: 16, h: 16, color: '#336699' });
    L.addImage(solid('#ff8800', 0.8), 'orange'); L.setProp(1, { blend: 'softlight', opacity: 0.55 });
    L.setMask(1, 'hide');
    const before = snapshot() + '|' + L.serialize().stack.map((s) => s.pix + (s.mask || '')).join();
    const meta = L.serialize();
    const files = {};
    for (const f of L.files()) files[f.name] = await L.toBlob(f.rt, f.grey);
    ed._resetStack({ w: 16, h: 16, color: '#000000' });
    const ok = await ed.restoreLayers(meta, async (name) => (files[name] ? createImageBitmap(files[name]) : null));
    R.restoreOk = ok;
    R.restoreSame = snapshot() + '|' + L.serialize().stack.map((s) => s.pix + (s.mask || '')).join() === before;
    R.maskKept = !!L.layers[1].mask;

    return R;
  });
  console.log(JSON.stringify(R, null, 1));
  const near = (a, b, t) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  const must = {
    'blend modes match reference (max err <= 2.5/255)': R.blendWorst <= 2.5,
    'normal blend with 50% alpha source': near(R.alphaMix.slice(0, 3), [128, 0, 128], 2),
    'undo walks back through 6 structure/property edits': R.undoMatches,
    'redo walks forward again': R.redoMatches,
    'gc frees unreferenced targets (registry == 1 layer)': R.registryAfterGc === 1 && R.layersAfterRemove === 1,
    'last layer cannot be removed': R.lastLayerKept,
    'merge visible keeps the look': R.mergeVisibleLayers === 1 && R.mergeDiff <= 2,
    'flatten all keeps the look (hidden layer dropped)': R.flattenLayers === 1 && R.flattenName === 'Flattened' && R.flattenDiff <= 2,
    'flatten is undoable': R.flattenUndoLayers === 3,
    'merge down keeps the look': R.mergeDownLayers === 2 && R.mergeDownDiff <= 2,
    'capture source: composite / below / active': near(R.captureModes.composite.slice(0, 3), [0, 0, 255], 1) && near(R.captureModes.below.slice(0, 3), [255, 0, 0], 1) && near(R.captureModes.active.slice(0, 3), [0, 255, 0], 1),
    'layers + masks survive save/restore': R.restoreOk && R.restoreSame && R.maskKept,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
