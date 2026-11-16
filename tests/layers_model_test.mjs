// Model-based layer tests: layer-mask brush, clear-mask button, seam padding, AI result as layer, GLB / OBJ export.
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
    // ---- cube with a 3x2 atlas (each face an island inset by 1%)
    const faces = [
      { n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] }, { n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
      { n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] }, { n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
      { n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] }, { n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    ];
    let obj = '', vi = 1;
    const rects = [];
    faces.forEach((f, i) => {
      const col = i % 3, row = Math.floor(i / 3), m = 0.01;
      const u0 = col / 3 + m, u1 = (col + 1) / 3 - m, v0 = row / 2 + m, v1 = (row + 1) / 2 - m;
      rects.push({ x: Math.round(u0 * 1024), y: Math.round((1 - v1) * 1024), w: Math.round((u1 - u0) * 1024), h: Math.round((v1 - v0) * 1024) });
      const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      for (let k = 0; k < 4; k++) obj += `v ${f.v[k].join(' ')}\nvt ${uvs[k].join(' ')}\nvn ${f.n.join(' ')}\n`;
      const a = vi, b = vi + 1, c = vi + 2, d = vi + 3;
      obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\nf ${a}/${a}/${a} ${c}/${c}/${c} ${d}/${d}/${d}\n`;
      vi += 4;
    });
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'cube.obj');
    const tex = document.createElement('canvas'); tex.width = tex.height = 1024;
    const g = tex.getContext('2d'); g.fillStyle = '#101010'; g.fillRect(0, 0, 1024, 1024);
    rects.forEach((r, i) => { g.fillStyle = colors[i]; g.fillRect(r.x, r.y, r.w, r.h); });
    ed.setTextureFromImage(tex, { label: 'atlas', keepHistory: false });
    ed.frameModel();
    await sleep(300);
    const baked = (pad = 0) => L.bakeCanvas(pad);
    const pxs = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
    const countGreen = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let n = 0; for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 200 && d[i] < 90 && d[i + 2] < 90) n++; return n; };

    // ---- 1) layer-mask brush: hide all, reveal with the brush, undo / redo, hide again with the eraser
    const p3 = ed.ui.pane3d;
    ed.state.brush.size = 260; ed.state.erase.size = 260;
    const green = document.createElement('canvas'); green.width = green.height = 256;
    green.getContext('2d').fillStyle = '#00ff00'; green.getContext('2d').fillRect(0, 0, 256, 256);
    L.addImage(green, 'green');
    L.setMask(L.active, 'hide');
    R.greenHidden = countGreen(baked());
    ed.state.brushTarget = 'layer';
    const cx = p3.offsetWidth / 2, cy = p3.offsetHeight / 2;
    R.begin = ed.beginStroke(false);
    ed.strokeMove(cx, cy, 0); ed.strokeMove(cx + 30, cy + 8, 0); ed.endStroke();
    R.greenRevealed = countGreen(baked());
    R.selectionUntouched = ed.maskIsEmpty();
    ed.undo(); R.greenAfterUndo = countGreen(baked());
    ed.redo(); R.greenAfterRedo = countGreen(baked());
    ed.beginStroke(true); ed.strokeMove(cx, cy, 0); ed.strokeMove(cx + 30, cy + 8, 0); ed.endStroke();
    R.greenAfterErase = countGreen(baked());
    L.active; L.layers[L.active].locked = true;
    R.lockedBlocks = ed.beginStroke(false) === false;
    L.layers[L.active].locked = false;
    // reveal-all drops the mask, so the whole layer shows
    L.setMask(L.active, 'reveal'); R.greenAll = countGreen(baked());

    // ---- 2) "clear all painted mask" button (+ undo)
    ed.state.brushTarget = 'selection';
    ed.beginStroke(false); ed.strokeMove(cx, cy, 0); ed.strokeMove(cx + 20, cy, 0); ed.endStroke();
    R.maskPainted = !ed.maskIsEmpty();
    ed.ui.btn.tClearMask.click();
    R.maskCleared = ed.maskIsEmpty();
    ed.undo(); R.maskRestored = !ed.maskIsEmpty();

    // ---- 3) seam padding
    ed._resetStack({ canvas: tex, name: 'atlas' });
    const p0 = baked(0), p8 = baked(8);
    R.gapNoPad = pxs(p0, 6, 770); R.gapPad = pxs(p8, 6, 770);
    R.farGapPad = pxs(p8, 336, 770);  // between two islands (inside the 20px gap): nearest island colour or the dark base

    // ---- 4) AI result = soft-alpha layer; preview vs capture; apply; undo; replace-active
    ed._clearHistory();
    const res = document.createElement('canvas'); res.width = res.height = 1024;
    const rg = res.getContext('2d'); const grad = rg.createRadialGradient(170, 770, 5, 170, 770, 200); grad.addColorStop(0, 'rgba(255,0,255,1)'); grad.addColorStop(1, 'rgba(255,0,255,0)');
    rg.fillStyle = grad; rg.fillRect(0, 0, 1024, 1024);
    const bmp = await createImageBitmap(res);
    ed.showResult(bmp, null, { summary: 'test', prompt: 'mossy stone wall test' });
    ed.flushCompose();
    const showNew = pxs(L.toCanvas(L.comp), 170, 1024 - 770 - 1 + 0);  // comp is v-up; toCanvas flips -> same orientation as canvas
    R.previewCentre = pxs(L.toCanvas(L.comp), 170, 770);
    R.captureCentre = pxs(L.captureCanvas('composite'), 170, 770);
    ed.toggleCompare(); ed.flushCompose(); R.previewOff = pxs(L.toCanvas(L.comp), 170, 770);
    ed.toggleCompare();
    const n0 = L.layers.length;
    ed.applyResult();
    R.applyLayers = [n0, L.layers.length]; R.applyName = L.layers[L.active].name; R.applyPrompt = L.layers[L.active].prompt;
    R.afterApply = pxs(baked(0), 170, 770);
    ed.undo(); R.afterUndo = L.layers.length;
    ed.state.layers.replaceActive = true;
    ed.showResult(bmp, null, { summary: 'test', prompt: 'replace' });
    const uidBefore = L.layers[L.active].pix.uid;
    ed.applyResult();
    R.replaceLayers = L.layers.length; R.replacedPix = L.layers[L.active].pix.uid !== uidBefore;
    R.replaceLook = pxs(baked(0), 170, 770);
    ed.state.layers.replaceActive = false;

    // ---- 5) export: GLB (parsed in the page) and OBJ zip (checked by Python)
    ed._resetStack({ canvas: tex, name: 'atlas' });
    const readGLB = async (blob) => {
      const buf = await blob.arrayBuffer(); const dv = new DataView(buf);
      const magic = dv.getUint32(0, true); const jl = dv.getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl)));
      const binStart = 20 + jl + 8;
      const acc = (i) => json.accessors[i];
      const view = (a) => json.bufferViews[a.bufferView];
      const f32 = (i, n) => { const a = acc(i), v = view(a); return new Float32Array(buf.slice(binStart + (v.byteOffset || 0) + (a.byteOffset || 0), binStart + (v.byteOffset || 0) + (a.byteOffset || 0) + a.count * n * 4)); };
      const prim = json.meshes[0].primitives[0];
      const pos = f32(prim.attributes.POSITION, 3), uv = f32(prim.attributes.TEXCOORD_0, 2);
      const imgView = json.bufferViews[json.images[0].bufferView];
      const png = new Blob([buf.slice(binStart + (imgView.byteOffset || 0), binStart + (imgView.byteOffset || 0) + imgView.byteLength)], { type: json.images[0].mimeType });
      const ib = await createImageBitmap(png);
      const c = document.createElement('canvas'); c.width = ib.width; c.height = ib.height; c.getContext('2d').drawImage(ib, 0, 0);
      const ext = Math.max(...Array.from(pos, Math.abs));
      const sampled = [];
      for (let f = 0; f < 6; f++) {
        let u = 0, v = 0; for (let k = 0; k < 6; k++) { u += uv[(f * 6 + k) * 2]; v += uv[(f * 6 + k) * 2 + 1]; } u /= 6; v /= 6;
        sampled.push(Array.from(c.getContext('2d').getImageData(Math.floor(u * c.width), Math.floor(v * c.height), 1, 1).data.slice(0, 3))); // glTF: v down
      }
      return { magic, verts: json.accessors[prim.attributes.POSITION].count, indices: json.accessors[prim.indices].count, ext, sampled, material: json.materials && json.materials.length };
    };
    const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
    const glb = await window.TP.exportModel(ed, { format: 'glb', space: 'original', padding: 8 });
    R.glbName = glb.name; R.glb = await readGLB(glb.blob);
    R.glbFaceColorsOK = R.glb.sampled.every((c, i) => c.every((v, k) => Math.abs(v - hexRgb(colors[i])[k]) <= 6));
    ed.setXform({ s: 1.3 });
    R.glbShown = (await readGLB((await window.TP.exportModel(ed, { format: 'glb', space: 'shown', padding: 0 })).blob)).ext;
    R.glbOriginalAfterXform = (await readGLB((await window.TP.exportModel(ed, { format: 'glb', space: 'original', padding: 0 })).blob)).ext;
    ed.resetXform();
    const objZip = await window.TP.exportModel(ed, { format: 'obj', space: 'original', padding: 8 });
    R.objName = objZip.name;
    const bytes = new Uint8Array(await objZip.blob.arrayBuffer());
    let bin = ''; for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    R.objZipB64 = btoa(bin);
    return R;
  }, colors);
  const zipPath = path.join(out, 'cube_obj.zip');
  fs.writeFileSync(zipPath, Buffer.from(R.objZipB64, 'base64')); delete R.objZipB64;
  console.log(JSON.stringify(R, null, 1));
  let objOK = true;
  try {
    const o = execFileSync('python3', [path.join(here, 'check_obj_zip.py'), zipPath, JSON.stringify({ colors: colors.map((h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]), extent: 1.0 })], { encoding: 'utf8' });
    console.log(o.trim());
  } catch (e) { objOK = false; console.log('OBJ ZIP CHECK FAILED:\n' + (e.stdout || '') + (e.stderr || '')); }
  const near = (a, b, t) => a.every((v, i) => Math.abs(v - b[i]) <= t);
  const must = {
    'layer mask hide-all hides the layer': R.greenHidden === 0,
    'brush (reveal) on the layer mask shows part of it': R.begin && R.greenRevealed > 2000 && R.greenRevealed < R.greenAll * 0.9,
    'layer-mask stroke leaves the AI selection untouched': R.selectionUntouched,
    'undo / redo of a layer-mask stroke': R.greenAfterUndo === 0 && R.greenAfterRedo === R.greenRevealed,
    'eraser hides the revealed part again': R.greenAfterErase < R.greenRevealed * 0.2,
    'locked layer blocks painting': R.lockedBlocks,
    'reveal all shows the whole layer': R.greenAll > R.greenRevealed,
    'clear-all-mask button + undo': R.maskPainted && R.maskCleared && R.maskRestored,
    'seam padding fills the gap next to an island': near(R.gapNoPad.slice(0, 3), [16, 16, 16], 2) && near(R.gapPad.slice(0, 3), [0xe0, 0x30, 0x30], 3),
    'AI result preview shows in the view but not in the capture': R.previewCentre[2] > 200 && R.previewCentre[1] < 60 && R.captureCentre[2] < 80 && near(R.previewOff.slice(0, 3), R.captureCentre.slice(0, 3), 2),
    'apply adds a named AI layer (undoable)': R.applyLayers[1] === R.applyLayers[0] + 1 && R.applyName.startsWith('AI: mossy') && R.applyPrompt === 'mossy stone wall test' && R.afterApply[0] > 200 && R.afterUndo === R.applyLayers[0],
    'replace-active bakes into the layer': R.replaceLayers === R.applyLayers[0] && R.replacedPix && R.replaceLook[0] > 200,
    'GLB: mesh, material and texture embedded': R.glb.magic === 0x46546c67 && R.glb.verts === 36 && R.glb.indices === 36 && R.glb.material === 1,
    'GLB: UV orientation correct for all 6 faces': R.glbFaceColorsOK,
    'GLB: original size restored, transformed export differs': Math.abs(R.glb.ext - 1) < 1e-3 && Math.abs(R.glbOriginalAfterXform - 1) < 1e-3 && Math.abs(R.glbShown - 1.3) < 0.01,
    'OBJ zip valid, UVs v-up, texture matches': objOK,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
