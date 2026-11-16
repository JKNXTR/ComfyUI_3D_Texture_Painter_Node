// Headless-Chrome integration test of the real editor bundle (SwiftShader WebGL2).
// Usage: node tests/browser_test.mjs <outDir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'tests', 'out'));
fs.mkdirSync(out, { recursive: true });

const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(root, decodeURIComponent(req.url.split('?')[0]));
  if (!p.startsWith(root) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end('nf'); return; }
  res.writeHead(200, { 'content-type': mime[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
}).listen(0);
const port = server.address().port;

const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--window-size=1300,820'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1300, height: 820 });
const logs = [];
page.on('console', (m) => { logs.push(`[${m.type()}] ${m.text()}`); });
page.on('pageerror', (e) => { logs.push(`[pageerror] ${e.stack || e.message}`); });

let failed = false;
try {
  if (process.env.ORTHO) await page.evaluateOnNewDocument(() => { window.__ORTHO = true; });
  if (process.env.CROP) await page.evaluateOnNewDocument(() => { window.__CROP = true; });
  await page.goto(`http://127.0.0.1:${port}/tests/harness.html`);
  await page.waitForFunction('window.ready === true', { timeout: 20000 });

  const result = await page.evaluate(async () => {
    const R = {};
    const { TexturePaintEditor } = window.TP;
    const ed = new TexturePaintEditor({});
    window.ed = ed;
    if (ed.failed) return { error: 'editor failed to init: ' + ed.ui.msg.textContent };
    document.getElementById('host').appendChild(ed.root);
    await new Promise((r) => setTimeout(r, 300));

    // ---- cube with a 3x2 UV atlas
    const faces = [
      { name: '+Z', n: [0, 0, 1], v: [[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]] },
      { name: '-Z', n: [0, 0, -1], v: [[1, -1, -1], [-1, -1, -1], [-1, 1, -1], [1, 1, -1]] },
      { name: '+X', n: [1, 0, 0], v: [[1, -1, 1], [1, -1, -1], [1, 1, -1], [1, 1, 1]] },
      { name: '-X', n: [-1, 0, 0], v: [[-1, -1, -1], [-1, -1, 1], [-1, 1, 1], [-1, 1, -1]] },
      { name: '+Y', n: [0, 1, 0], v: [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]] },
      { name: '-Y', n: [0, -1, 0], v: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
    ];
    let obj = '', vi = 1;
    const cells = [];
    faces.forEach((f, i) => {
      const col = i % 3, row = Math.floor(i / 3), m = 0.01;
      const u0 = col / 3 + m, u1 = (col + 1) / 3 - m, v0 = row / 2 + m, v1 = (row + 1) / 2 - m;
      cells.push({ name: f.name, col, row });
      const uvs = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
      for (let k = 0; k < 4; k++) obj += `v ${f.v[k].join(' ')}\nvt ${uvs[k].join(' ')}\nvn ${f.n.join(' ')}\n`;
      const a = vi, b = vi + 1, c = vi + 2, d = vi + 3;
      obj += `f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}\nf ${a}/${a}/${a} ${c}/${c}/${c} ${d}/${d}/${d}\n`;
      vi += 4;
    });
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'cube.obj');
    R.info = { tris: ed.info.triangles, verts: ed.info.vertices, hasUV: ed.info.hasUV, warnings: ed.info.warnings };

    // ---- coloured test texture (orientation check)
    const W = 1024, H = 1024;
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#303030'; g.fillRect(0, 0, W, H);
    const colors = ['#e03030', '#30c8c8', '#30c040', '#c030c0', '#3050e0', '#e0d030'];
    cells.forEach((cell, i) => {
      const x = cell.col * W / 3, y = H * (1 - (cell.row + 1) / 2), w = W / 3, h = H / 2;
      g.fillStyle = colors[i]; g.fillRect(x, y, w, h);
      g.fillStyle = '#000'; g.font = 'bold 90px sans-serif'; g.fillText(cell.name, x + 30, y + 110);
      g.fillRect(x + 20, y + h - 60, 120, 24); // marker near the cell's bottom-left (v low)
    });
    ed.setTextureFromImage(c, { label: 'test', keepHistory: false });
    ed.state.capture.facing = 0.25;
    ed.applyState({ display: { layout: 'split' } });
    ed.frameModel();
    if (window.__ORTHO) { ed.setOrtho(true); ed.frameModel(); }
    if (window.__CROP) { ed.camera.position.multiplyScalar(2.2); ed.controls.update(); ed.state.capture.crop.enabled = true; ed.state.brush.size = 120; }
    ed.invalidate();
    await new Promise((r) => setTimeout(r, 400));

    // ---- paint a stroke through the centre of the 3D pane
    const p3 = ed.ui.pane3d;
    ed.state.brush.size = 260; ed.state.brush.hardness = 0.6;
    const ok = ed.beginStroke(false);
    R.beginStroke = ok;
    const cx = p3.offsetWidth / 2, cy = p3.offsetHeight / 2;
    ed.strokeMove(cx, cy, 0);
    ed.strokeMove(cx + 60, cy + 20, 0);
    ed.endStroke();
    R.maskEmptyAfterPaint = ed.maskIsEmpty();
    R.undoLen = ed.undoStack.length;

    // erase a small part, then undo it
    ed.beginStroke(true); ed.strokeMove(cx, cy, 0); ed.endStroke();
    const afterErase = (() => { const b = ed._readMaskPixels(); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return s; })();
    ed.undo();
    const afterUndo = (() => { const b = ed._readMaskPixels(); let s = 0; for (let i = 0; i < b.length; i += 4) s += b[i]; return s; })();
    R.eraseReduced = afterErase < afterUndo;

    // mask ops sanity
    ed.maskMorph(0, 4); ed.maskMorph(1, 4); ed.maskMorph(2, 3);
    R.maskEmptyAfterOps = ed.maskIsEmpty();

    ed.invalidate();
    await new Promise((r) => setTimeout(r, 400));

    // ---- capture
    const cap = await ed.capture({ includeMesh: true, includeTexture: true });
    const toB64 = (blob) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result.split(',')[1]); fr.readAsDataURL(blob); });
    R.files = {};
    for (const k of ['view', 'viewmask', 'depth', 'normal', 'uvmask', 'texture', 'mesh']) R.files[k] = await toB64(cap[k]);
    R.meta = cap.meta;
    R.cells = cells;
    R.stateJSONLen = JSON.stringify(ed.getState()).length;
    R.logs = ed.logLines.slice(-12);
    return R;
  });

  if (result.error) throw new Error(result.error);
  for (const [k, b64] of Object.entries(result.files)) fs.writeFileSync(path.join(out, k === 'mesh' ? 'mesh.bin' : k + '.png'), Buffer.from(b64, 'base64'));
  fs.writeFileSync(path.join(out, 'meta.json'), JSON.stringify(result.meta, null, 1));
  fs.writeFileSync(path.join(out, 'cells.json'), JSON.stringify(result.cells));
  await page.screenshot({ path: path.join(out, 'screenshot.png') });
  const { files, meta, cells, logs: edLogs, ...summary } = result;
  console.log('RESULT', JSON.stringify(summary, null, 1));
  console.log('EDITOR LOG', edLogs.join('\n'));
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
  try { await page.screenshot({ path: path.join(out, 'failure.png') }); } catch (_) { /* ignore */ }
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
