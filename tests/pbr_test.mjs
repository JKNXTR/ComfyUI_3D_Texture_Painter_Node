// PBR maps: derive / fill / load / undo, lit viewport preview, per-object persistence, project round trip, GLB + OBJ export.
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
    const obj = cubeObj('A', -2, 1) + cubeObj('B', 2, 9);
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'two.obj'); await sleep(300);
    const ids = {}; for (const nd of ed.objTree.rows) ids[nd.name] = nd.id;
    // a noisy colour texture so derived maps have content
    const tc = document.createElement('canvas'); tc.width = tc.height = 256; const tg = tc.getContext('2d');
    for (let y = 0; y < 256; y += 16) for (let x = 0; x < 256; x += 16) { tg.fillStyle = `hsl(${(x * 3 + y) % 360},60%,${30 + ((x + y) / 16 % 2) * 40}%)`; tg.fillRect(x, y, 16, 16); }
    const bmp = await createImageBitmap(tc); ed.setTextureFromImage(bmp, { label: 'noise', keepHistory: false }); await sleep(100);
    const K = ['normal', 'height', 'rough', 'metal', 'ao', 'spec'];
    R.panel = { sec: !!ed.ui.sec.pbr, blocks: ed.ui.sec.pbr.body.children.length > 8 };
    // ---- derive all
    for (const k of K) ed.pbrDerive(k);
    R.derived = K.map((k) => !!ed.pbrCanvas[k]); R.size = ed.pbrCanvas.normal && [ed.pbrCanvas.normal.width, ed.pbrCanvas.normal.height];
    const px = (c, x, y) => Array.from(c.getContext('2d').getImageData(x, y, 1, 1).data);
    R.normalBlue = px(ed.pbrCanvas.normal, 100, 100)[2] > 100; R.hasStatus = ed.ui.sec.pbr.body.textContent.includes('2048x2048');
    // ---- fill / adjust / undo
    ed.pbrFill('rough', 0.2); const r0 = px(ed.pbrCanvas.rough, 50, 50)[0]; R.fill = Math.abs(r0 - 51) <= 1;
    ed.pbrAdjust('rough', { invert: true }); R.invert = Math.abs(px(ed.pbrCanvas.rough, 50, 50)[0] - 204) <= 1;
    ed.pbrUndo(); R.undo = Math.abs(px(ed.pbrCanvas.rough, 50, 50)[0] - 51) <= 1;
    ed.pbrRemove('spec'); R.removed = !ed.pbrCanvas.spec && !ed.state.pbrMaps.spec; ed.pbrUndo(); R.restored = !!ed.pbrCanvas.spec;
    const g0 = px(ed.pbrCanvas.normal, 100, 100)[1]; ed.pbrFlipGreen(); R.flip = Math.abs(px(ed.pbrCanvas.normal, 100, 100)[1] - (255 - g0)) <= 1; ed.pbrFlipGreen();
    // ---- packed ORM: R=ao G=rough B=metal
    const pc = document.createElement('canvas'); pc.width = pc.height = 64; const pg = pc.getContext('2d'); pg.fillStyle = 'rgb(255,128,0)'; pg.fillRect(0, 0, 64, 64);
    const pb = await new Promise((r) => pc.toBlob(r)); await ed.pbrLoadPacked(new File([pb], 'orm.png', { type: 'image/png' }));
    R.packed = Math.abs(px(ed.pbrCanvas.ao, 5, 5)[0] - 255) <= 1 && Math.abs(px(ed.pbrCanvas.rough, 5, 5)[0] - 128) <= 2 && px(ed.pbrCanvas.metal, 5, 5)[0] <= 1;
    // ---- viewport: lit preview differs from the plain view, and metallic changes it
    const shot = () => { const c = document.createElement('canvas'); const r = ed.renderer.domElement; c.width = r.width; c.height = r.height; c.getContext('2d').drawImage(r, 0, 0); return c.getContext('2d').getImageData(0, 0, c.width, c.height).data; };
    const sum = (d) => { let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s; };
    const render = (pbr) => { ed.state.pbr.on = pbr; ed.hudDirty = true; ed.invalidate(); if (pbr) ed._pbrRender(ed.camera); else ed.renderer.render(ed.scene, ed.camera); return shot(); };
    ed.frameModel(); await sleep(100);
    const plain = sum(render(false));
    ed.pbrFill('metal', 0); ed.state.pbr.metal = 1; const lit0 = sum(render(true));
    ed.pbrFill('metal', 1); const lit1 = sum(render(true));
    R.viewport = { plain, lit0, lit1, differs: Math.abs(plain - lit0) > 1000, metalChanges: Math.abs(lit0 - lit1) > 1000, active: ed._pbrActive() };
    ed.state.pbr.on = false;
    // ---- per-object persistence
    ed.pbrFill('metal', 0.5);
    const idsA = { ...ed.state.pbrMaps };
    await ed.selectObject(ids.A);
    R.fresh = Object.values(ed.state.pbrMaps).every((v) => !v) && !ed.pbrHasAny();            // other object starts without maps
    ed.pbrDerive('normal'); ed.pbrFill('rough', 0.9);
    await ed.selectObject(ids.B);
    R.stashed = !ed.pbrHasAny();
    const meta = JSON.parse(JSON.stringify(ed.objectStates())), files = ed.objectFiles();
    R.files = files.filter((f) => /^P_[a-f0-9]{12}_(normal|rough)\.png$/.test(f.name)).length;
    R.filesHaveBlobs = files.every((f) => f.blob instanceof Blob);
    R.meta = !!(meta[ids.A] && meta[ids.A].pbr && meta[ids.A].pbr.normal);
    const server = new Map(files.map((f) => [f.name, f.blob])); ed.hooks.fetchSessionFile = async (n) => server.get(n) || null;
    ed.seedObjectStates(meta); await ed.selectObject(ids.A);
    R.lazyBack = !!ed.pbrCanvas.normal && !!ed.pbrCanvas.rough && !ed.pbrCanvas.metal && Math.abs(px(ed.pbrCanvas.rough, 9, 9)[0] - 230) <= 2;
    await ed.selectObject('');   // entire model -> its own (empty) set
    R.entire = !!ed.pbrCanvas.normal && !!ed.pbrCanvas.spec && ed.state.pbrMaps.metal === idsA.metal;   // the entire-model set came back untouched
    await ed.selectObject(ids.B);
    R.bBack = !ed.pbrHasAny();
    for (const k of ['normal', 'ao', 'rough', 'spec']) ed.pbrDerive(k); ed.pbrFill('metal', 0.5); await ed.pbrReady();
    // ---- project round trip
    const proj = await window.TP.saveProject(ed);
    R.projFiles = proj.blob.size > 0;
    const ed2 = new window.TP.TexturePaintEditor(); document.getElementById('host').append(ed2.root); await sleep(300);
    ed2.hooks.onModelPicked = async (f) => f.name;
    await window.TP.loadProject(ed2, new File([proj.blob], 'p.zip'));
    R.projBack = !!ed2.pbrCanvas.metal && !!ed2.pbrCanvas.normal && ed2.state.pbrMaps.metal === ed.state.pbrMaps.metal;
    // ---- exports
    const glb = await window.TP.exportModel(ed, { format: 'glb' });
    const ab = await glb.blob.arrayBuffer(); const dv = new DataView(ab); const jl = dv.getUint32(12, true);
    const json = JSON.parse(new TextDecoder().decode(new Uint8Array(ab, 20, jl)));
    const m0 = json.materials[0]; R.glb = { normal: !!m0.normalTexture, occ: !!m0.occlusionTexture, mr: !!(m0.pbrMetallicRoughness && m0.pbrMetallicRoughness.metallicRoughnessTexture), spec: !!(m0.extensions && m0.extensions.KHR_materials_specular) };
    const oz = await window.TP.exportModel(ed, { format: 'obj' });
    const zb = new Uint8Array(await oz.blob.arrayBuffer()); const txt = new TextDecoder('latin1').decode(zb);
    R.obj = { normal: /_normal\.png/.test(txt), mtl: /norm .*_normal\.png/.test(txt) && /map_Pm /.test(txt) };
    // maps without any map -> plain material still works
    ed.state.pbr.on = false;
    return R;
  });
  console.log(JSON.stringify(R));
  const must = {
    'panel section built': R.panel.sec && R.panel.blocks,
    'all six maps derive': R.derived.every(Boolean) && R.size[0] === 2048 && R.normalBlue && R.hasStatus,
    'fill / invert / undo / remove / restore / flip green': R.fill && R.invert && R.undo && R.removed && R.restored && R.flip,
    'packed ORM splits into three maps': R.packed,
    'lit viewport renders and differs from the plain view': R.viewport.active && R.viewport.differs,
    'metallic map changes the lit result': R.viewport.metalChanges,
    'other object starts without maps; stash empties the working set': R.fresh && R.stashed,
    'object persistence: metadata + P_ files with blobs': R.files === 4 && R.filesHaveBlobs && R.meta,
    'lazy restore from the server files': R.lazyBack,
    'entire model keeps its own set; untouched object has none': R.entire && R.bBack,
    'project save / load round trip keeps maps': R.projFiles && R.projBack,
    'GLB carries normal / occlusion / metallic-roughness': R.glb.normal && R.glb.occ && R.glb.mr,
    'OBJ zip carries maps and mtl lines': R.obj.normal && R.obj.mtl,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) { failed = true; console.log('TEST FAILURE:', e.stack || e); }
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
