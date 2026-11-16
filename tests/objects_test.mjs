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
  const R = await page.evaluate(async (colors) => {
    const R = {};
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const ed = new window.TP.TexturePaintEditor();
    document.getElementById('host').append(ed.root);
    await sleep(300);
    const L = ed.layers;
    const THREE = window.TP.THREE;
    // three unit cubes side by side, each with a FULL 0-1 UV layout (UVs overlap between objects, like separate textures)
    const cubeObj = (name, cx, vi0) => {
      const P = [[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1]];
      const F = [[0,1,2,3],[5,4,7,6],[1,5,6,2],[4,0,3,7],[3,2,6,7],[4,5,1,0]];
      let s = 'o ' + name + '\n';
      for (const p of P) s += `v ${p[0] + cx} ${p[1]} ${p[2]}\n`;
      s += 'vt 0.02 0.02\nvt 0.98 0.02\nvt 0.98 0.98\nvt 0.02 0.98\n';
      for (const f of F) s += `f ${f[0] + vi0}/1 ${f[1] + vi0}/2 ${f[2] + vi0}/3\nf ${f[0] + vi0}/1 ${f[2] + vi0}/3 ${f[3] + vi0}/4\n`;
      return s;
    };
    const obj = cubeObj('Alpha', -3, 1) + cubeObj('Beta', 0, 9) + cubeObj('Gamma', 3, 17);
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'multi.obj');
    await sleep(300);
    const T = ed.objTree, ids = {};
    for (const nd of T.rows) ids[nd.name] = nd.id;
    R.tree = { leaves: T.leafCount, rows: T.rows.map((n) => n.name), secShown: ed.ui.sec.obj.el.style.display !== 'none', rowsInDom: ed.ui.sec.obj.body.querySelectorAll('.tp-trow').length };
    R.whole = { tris: ed.info.triangles, obj: ed.state.model.object, ctx: 0 };
    const aiLayer = (name) => { const c = document.createElement('canvas'); c.width = c.height = 1024; const g = c.getContext('2d'); g.fillStyle = '#20e060'; g.fillRect(100, 100, 400, 400); return ed.layers.addLayer(ed.layers.fromImage(c), name, { prompt: name, ai: true }); };
    // ---- 1) switch to Beta
    const okB = await ed.selectObject(ids.Beta);
    R.beta = { ok: okB, tris: ed.info.triangles, obj: ed.state.model.object, ctxKids: ed.scene.children.filter((c) => c.isGroup && c.children.length).map((c) => c.children.length)[0] };
    // context cube Alpha in Beta's frame: centre x = -3 / sqrt(3)
    const grp = ed.scene.children.find((c) => c.isGroup && c.children.length);
    const bbOf = (m) => { const b = new THREE.Box3(); const a = m.geometry.attributes.position, v = new THREE.Vector3(); for (let i = 0; i < a.count; i++) b.expandByPoint(v.fromBufferAttribute(a, i).applyMatrix4(m.matrix)); return b.getCenter(new THREE.Vector3()); };
    const cs = grp.children.map((m) => +bbOf(m).x.toFixed(3)).sort((a, b) => a - b);
    R.ctxCentres = cs; R.ctxExpected = [-1.732, 1.732];
    // ---- 2) paint in Beta
    ed.state.brush.size = 120; ed.frameModel(); await sleep(150);
    ed.beginStroke(false); for (let i = 0; i < 6; i++) ed.strokeMove(ed.ui.pane3d.offsetWidth * 0.5 + i * 5, ed.ui.pane3d.offsetHeight * 0.5, 0); ed.endStroke(); await sleep(100);
    aiLayer('AI: beta'); const betaLayers = ed.layers.layers.length, betaMaskEmpty = ed.maskIsEmpty();
    const hashBeta = ed.meshHash, texBeta = ed.textureVersion;
    // ---- 3) switch to Alpha: fresh stack + empty mask, different mesh hash
    await ed.selectObject(ids.Alpha);
    R.alpha = { tris: ed.info.triangles, layers: ed.layers.layers.length, maskEmpty: ed.maskIsEmpty(), texChanged: ed.textureVersion !== texBeta, undo: ed.undoStack.length };
    // ---- 4) back to Beta: layers + mask restored
    await ed.selectObject(ids.Beta);
    R.betaBack = { layers: ed.layers.layers.length === betaLayers, ai: ed.layers.layers.some((l) => l.ai), maskKept: !ed.maskIsEmpty() && !betaMaskEmpty, sameHash: ed.meshHash === hashBeta };
    // ---- 5) hide buttons
    const ctxVis = () => grp ? ed.scene.children.find((c) => c.isGroup && c.children.length).children.map((m) => m.visible) : [];
    ed.objHideAll(); R.hideAll = { mesh: ed.mesh.visible, ctx: ctxVis().join() };
    ed.objUnhideAll(); R.unhide = { mesh: ed.mesh.visible, ctx: ctxVis().join() };
    ed.objHideExceptSelected(); R.hideExc = { mesh: ed.mesh.visible, ctx: ctxVis().join() };
    ed.objUnhideAll(); ed.objHideSelected(); R.hideSel = { mesh: ed.mesh.visible, ctx: ctxVis().join(), hiddenIds: ed.state.objHidden.join() };
    ed.objUnhideAll();
    // eye toggle on a row
    const rows = ed.ui.sec.obj.body.querySelectorAll('.tp-trow'); rows[1].querySelector('.tp-eye').click(); R.eye = ed.state.objHidden.length === 1;
    rows[0]; ed.objUnhideAll();
    // ---- 6) persistence meta + lazy restore through a fake server
    await ed.selectObject(ids.Gamma);                         // stash Beta (with its AI layer) as non-current
    const meta = JSON.parse(JSON.stringify(ed.objectStates())), files = ed.objectFiles();
    R.persist = { objects: Object.keys(meta).sort().join(), names: files.every((f) => /^[LM]_[a-f0-9]{8,16}\.png$/.test(f.name)), blobs: files.every((f) => f.blob instanceof Blob), betaStack: meta[ids.Beta].stack.stack.length };
    const server = new Map(files.map((f) => [f.name, f.blob]));
    ed.hooks.fetchSessionFile = async (n) => server.get(n) || null;
    ed.seedObjectStates(meta);                                // as after a page reload: metadata only, files fetched lazily
    await ed.selectObject(ids.Beta);
    R.lazy = { ai: ed.layers.layers.some((l) => l.ai), layers: ed.layers.layers.length === betaLayers, mask: !ed.maskIsEmpty() };
    // ---- 7) restore of the same selection through loadModelBuffer (page reload path)
    const st0 = ed.getState();
    R.stateHasObj = st0.model.object === ids.Beta && !!st0.objStates;
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'multi.obj', { keepTexture: true });
    R.reload = { obj: ed.state.model.object === ids.Beta, tris: ed.info.triangles };
    // ---- 8) capture works for the working object only
    const cap = await ed.capture({ includeMesh: true, includeTexture: false });
    R.capture = { meshHashOk: cap.meta.mesh_hash === ed.meshHash, tris12: ed.info.triangles === 12 };
    // ---- 9) group nodes: whole model merged again
    await ed.selectObject('');
    R.backToWhole = ed.info.triangles === 36 && ed.state.model.object === '';
    // ---- 10) multi-select: Ctrl-click adds, set works as one object, survives switching and reload, Shift range, Ctrl removes
    await ed.objClick(ids.Alpha, {});
    await ed.objClick(ids.Gamma, { ctrlKey: true });
    const hl = () => ed.ui.sec.obj.body.querySelectorAll('.tp-trow.tp-cur').length;
    const grp2 = () => ed.scene.children.find((c) => c.isGroup && c.children.length);
    R.multi = { id: ed.state.model.object === ids.Alpha + '|' + ids.Gamma, tris: ed.info.triangles, ctx: grp2() ? grp2().children.length : 0, hl: hl() };
    ed.layers.addLayer(ed.layers.fromImage((() => { const c = document.createElement('canvas'); c.width = c.height = 64; return c; })()), 'set layer');
    const nLay = ed.layers.layers.length, setHash = ed.meshHash;
    await ed.objClick(ids.Beta, {});
    R.multi.single = ed.info.triangles === 12 && ed.state.model.object === ids.Beta;
    await ed.objClick(ids.Alpha + '|' + ids.Gamma, {}); // (resolves the stored set again)
    R.multi.back = ed.state.model.object === ids.Alpha + '|' + ids.Gamma && ed.layers.layers.length === nLay && ed.meshHash === setHash;
    const st1 = ed.getState();
    await ed.loadModelBuffer(new TextEncoder().encode(obj).buffer, 'multi.obj', { keepTexture: true });
    R.multi.reload = ed.state.model.object === ids.Alpha + '|' + ids.Gamma && ed.info.triangles === 24 && !!st1.objStates;
    await ed.objClick(ids.Gamma, { ctrlKey: true });
    R.multi.remove = ed.state.model.object === ids.Alpha && ed.info.triangles === 12;
    await ed.objClick(ids.Alpha, {}); await ed.objClick(ids.Gamma, { shiftKey: true });
    R.multi.range = ed.state.model.object.split('|').length === 3 && ed.info.triangles === 36;
    await ed.selectObject('');
    return R;
  }, colors);
  console.log(JSON.stringify(R));
  const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 0.02);
  const must = {
    'tree: 3 objects + root row, panel visible with rows': R.tree.leaves === 3 && R.tree.rows.length === 4 && R.tree.secShown && R.tree.rowsInDom === 4,
    'whole model merged by default (36 tris, object "")': R.whole.tris === 36 && R.whole.obj === '',
    'select Beta: 12 tris, 2 grey context objects': R.beta.ok && R.beta.tris === 12 && R.beta.obj !== '' && R.beta.ctxKids === 2,
    'context objects placed correctly in the working frame': near(R.ctxCentres, R.ctxExpected),
    'other object starts with a fresh stack and empty mask, bumped texture version': R.alpha.tris === 12 && R.alpha.layers === 1 && R.alpha.maskEmpty && R.alpha.texChanged,
    'undo history cleared on switch': R.alpha.undo === 0,
    'switching back restores layers + mask': R.betaBack.layers && R.betaBack.ai && R.betaBack.maskKept && R.betaBack.sameHash,
    'Hide all / Unhide all': R.hideAll.mesh === false && R.hideAll.ctx === 'false,false' && R.unhide.mesh === true && R.unhide.ctx === 'true,true',
    'Hide all except selected': R.hideExc.mesh === true && R.hideExc.ctx === 'false,false',
    'Hide selected': R.hideSel.mesh === false && R.hideSel.ctx === 'true,true',
    'eye toggle hides one object': R.eye,
    'persistence: stashed objects (entire model, Alpha, Beta) serialised with valid file names and blobs': R.persist.objects === ',0,1' && R.persist.names && R.persist.blobs && R.persist.betaStack === 2,
    'lazy restore from the server files': R.lazy.ai && R.lazy.layers && R.lazy.mask,
    'state carries the working object + others; reload re-selects it': R.stateHasObj && R.reload.obj && R.reload.tris === 12,
    'capture uses the working object only': R.capture.meshHashOk && R.capture.tris12,
    'select root again merges all objects': R.backToWhole,
    'Ctrl-click: two objects form one working set (24 tris, 1 context object, 2 rows highlighted)': R.multi.id && R.multi.tris === 24 && R.multi.ctx === 1 && R.multi.hl === 2,
    'set keeps its own layers when switching away and back': R.multi.single && R.multi.back,
    'set survives a reload': R.multi.reload,
    'Ctrl-click removes, Shift-click selects a range': R.multi.remove && R.multi.range,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
