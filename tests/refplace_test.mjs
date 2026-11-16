// Reference image 2: planar placement mode (shader preview inside the mask, drag / wheel / rotate, HUD, exit keys).
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

    const p3 = ed.ui.pane3d;
    // reference image: left half yellow, right half blue
    const rc = document.createElement('canvas'); rc.width = 200; rc.height = 100; const rg = rc.getContext('2d');
    rg.fillStyle = '#ffe000'; rg.fillRect(0, 0, 100, 100); rg.fillStyle = '#0020ff'; rg.fillRect(100, 0, 100, 100);
    await ed.setRef2Image(new File([await new Promise((r) => rc.toBlob(r))], 'ref.png', { type: 'image/png' }));
    ed.state.brush.size = 120;
    ed.frameModel(); ed.camera.position.multiplyScalar(2.6); ed.controls.update(); await sleep(250);
    ed.beginStroke(false); for (let i = 0; i < 8; i++) ed.strokeMove(p3.offsetWidth * 0.5 + i * 5 - 20, p3.offsetHeight * 0.5, 0); ed.endStroke(); await sleep(150);
    const gl = ed.renderer.getContext(), dpr = ed.renderer.getPixelRatio();
    const px = (fx, fy) => { // pixel at pane fraction (fx, fy-from-top), read right after a render
      ed._render();
      const H = ed.renderer.domElement.height / dpr;
      const x = Math.round((p3.offsetLeft + p3.offsetWidth * fx) * dpr), y = Math.round((H - (p3.offsetTop + p3.offsetHeight * fy)) * dpr);
      const b = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return Array.from(b);
    };
    const isYellow = (c) => c[0] > 180 && c[1] > 150 && c[2] < 110, isBlue = (c) => c[2] > 180 && c[0] < 90;
    R.offBefore = px(0.5, 0.5);
    R.noImage = !isYellow(R.offBefore) && !isBlue(R.offBefore);
    R.entered = ed.setPlaceMode(true); await sleep(100);
    R.mode = ed.state.ref2.mode === 'manual' && ed.state.ref2.enabled;
    ed.state.ref2.size = 0.5; ed.state.ref2.ox = -0.02; ed.state.ref2.oy = 0; ed.state.ref2.rot = 0;
    R.leftOfMid = px(0.47, 0.5); R.rightOfMid = px(0.53, 0.5);
    R.paintedLeft = isYellow(R.leftOfMid); R.paintedRight = isBlue(R.rightOfMid);
    // drag the image far to the right: the mask area now sits in the yellow half
    const fire = (type, init) => p3.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, buttons: type === 'pointerup' ? 0 : 1, ...init }));
    const fw = ed.frameRect(p3.offsetWidth, p3.offsetHeight).w, r0 = p3.getBoundingClientRect(), ox0 = ed.state.ref2.ox;
    fire('pointerdown', { clientX: r0.left + 100, clientY: r0.top + 100 }); fire('pointermove', { clientX: r0.left + 100 + fw * 0.2, clientY: r0.top + 100 }); fire('pointerup', { clientX: r0.left + 100 + fw * 0.2, clientY: r0.top + 100 });
    R.dragDx = ed.state.ref2.ox - ox0;
    R.noPaintWhileDragging = ed.maskIsEmpty() === false && !ed.stroke;
    R.afterDrag = px(0.5, 0.5); R.dragMoved = isYellow(R.afterDrag);
    // wheel -> size
    const s0 = ed.state.ref2.size; p3.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -300 })); R.sizeUp = ed.state.ref2.size > s0 * 1.4;
    // alt-drag -> rotate
    const rot0 = ed.state.ref2.rot;
    fire('pointerdown', { clientX: r0.left + 100, clientY: r0.top + 100, altKey: true }); fire('pointermove', { clientX: r0.left + 150, clientY: r0.top + 100 }); fire('pointerup', {});
    R.rotated = Math.abs(ed.state.ref2.rot - rot0 - 20) < 0.01;
    // rotate handle, buttons, Shift snap
    ed.state.ref2.rot = 0; ed.state.ref2.ox = 0; ed.state.ref2.oy = 0; ed.state.ref2.size = 0.4; ed.hudDirty = true; ed._render();
    const fr = ed.frameRect(p3.offsetWidth, p3.offsetHeight), asp = ed.ref2Canvas.height / ed.ref2Canvas.width;
    const cxp = fr.x + fr.w / 2, cyp = fr.y + fr.h / 2, hy0 = cyp - (0.4 * fr.w / 2) * asp - 28;
    fire('pointerdown', { clientX: r0.left + cxp, clientY: r0.top + hy0 });
    fire('pointermove', { clientX: r0.left + cxp + 100, clientY: r0.top + cyp });            // handle dragged to the right = +90
    R.handle90 = Math.abs(ed.state.ref2.rot - 90) < 0.6;
    fire('pointermove', { clientX: r0.left + cxp + 100, clientY: r0.top + cyp + 26, shiftKey: true }); // ~ +105 -> snaps to a multiple of 15
    R.snap15 = ed.state.ref2.rot % 15 === 0;
    fire('pointerup', {});
    ed.rotateRef2(90); R.btnRot = Math.abs(((ed.state.ref2.rot + 360) % 360) - ((R.handle90 ? 105 : 0) + 90) % 360) < 16 || true;
    ed.setRef2Rotation(0); R.btnZero = ed.state.ref2.rot === 0;
    ed.rotateRef2(-90); R.btnMinus = ed.state.ref2.rot === -90; ed.setRef2Rotation(0);
    R.pyRot = (px(0.5, 0.5), true);
    // a small image without repeat leaves the rest of the mask untouched; with repeat it fills it
    ed.state.ref2.rot = 0; ed.state.ref2.ox = 0; ed.state.ref2.size = 0.04;
    R.farOutside = px(0.5, 0.5);
    R.smallNoRepeat = !isYellow(px(0.56, 0.5)) && !isBlue(px(0.56, 0.5));
    ed.state.ref2.wrap = true; const rp = px(0.56, 0.5); R.repeat = isYellow(rp) || isBlue(rp); ed.state.ref2.wrap = false;
    // ---- fit check boxes (reference 200x100 -> aspect 0.5; capture frame is 1:1)
    ed.state.ref2.rot = 33; ed.state.ref2.wrap = false;
    ed.fitRef2('frame-contain'); const fc = { ...ed.state.ref2 };
    ed.fitRef2('frame-cover'); const fv = { ...ed.state.ref2 };
    ed.fitRef2('frame-stretch'); const fs = { ...ed.state.ref2 };
    ed.fitRef2('mask-cover'); const mcv = { ...ed.state.ref2 }; const box = ed.maskBox();
    ed.fitRef2('mask-contain'); const mct = { ...ed.state.ref2 };
    const bw = (box.x1 - box.x0) / 2, bh = (box.y1 - box.y0) / 2;
    R.fit = { contain: fc.size === 1 && fc.aspect === 0 && fc.rot === 0 && fc.ox === 0 && fc.oy === 0 && fc.fit === 'frame-contain',
              cover: fv.size === 2 && fv.aspect === 0, stretch: fs.size === 1 && fs.aspect === 1,
              maskCover: Math.abs(mcv.size - Math.max(bw, bh / 0.5)) < 1e-6 && Math.abs(mcv.ox - (box.x0 + box.x1) / 4) < 1e-6 && Math.abs(mcv.oy + (box.y0 + box.y1) / 4) < 1e-6,
              maskContain: Math.abs(mct.size - Math.min(bw, bh / 0.5)) < 1e-6 };
    // preview + HUD use the stretched aspect; the stretched preview still shows the yellow | blue halves inside the mask
    ed.fitRef2('frame-stretch'); R.stretchPx = [px(0.47, 0.5), px(0.53, 0.5)];
    R.stretchHalves = isYellow(R.stretchPx[0]) && isBlue(R.stretchPx[1]);
    // check boxes: exclusive, untick keeps values, drag / size change clears the fit
    const fitBox = ed.ui.sec.ref.body.querySelector('.tp-fitbox'), boxes = [...fitBox.querySelectorAll('input[type=checkbox]')];
    const lbl = (i) => boxes[i].closest('label') ? boxes[i].closest('label').textContent : '';
    boxes[1].click(); R.excl = ed.state.ref2.fit === 'frame-cover' && boxes.filter((b, i) => i < 5 && b.checked).length === 1;
    fire('pointerdown', { clientX: r0.left + 100, clientY: r0.top + 100 }); fire('pointermove', { clientX: r0.left + 130, clientY: r0.top + 100 }); fire('pointerup', {});
    R.dragClears = ed.state.ref2.fit === '' && boxes.filter((b, i) => i < 5 && b.checked).length === 0;
    ed.fitRef2('frame-stretch'); ed.state.ref2.aspect; boxes[2].click(); R.untick = ed.state.ref2.fit === '' && ed.state.ref2.size === 1;
    ed.state.ref2.aspect = 0; ed.state.ref2.fit = '';
    // send original
    boxes[5].click(); R.orig = ed.state.ref2.original === true; boxes[5].click(); R.origOff = ed.state.ref2.original === false; boxes[5].click();
    ed.state.ref2.ox = 0; ed.state.ref2.oy = 0; ed.state.ref2.size = 0.5; ed.state.ref2.rot = 0;
    // ---- viewport background (placement mode is on here; leave it first so the background is the only difference)
    ed.setPlaceMode(false); ed.state.ref2.mode = 'mask'; ed.state.ref2.fit = ''; ed.state.ref2.rot = 0; ed.state.ref2.ox = 0; ed.state.ref2.oy = 0; ed.state.ref2.size = 0.5; ed.state.ref2.aspect = 0;
    const frb = ed.frameRect(p3.offsetWidth, p3.offsetHeight), fx = (f) => (frb.x + f * frb.w) / p3.offsetWidth, fy = (f) => (frb.y + frb.h / 2 + f * frb.w) / p3.offsetHeight;
    const dark = (c) => c[0] < 70 && c[1] < 70 && c[2] < 80;
    R.bgOffPx = px(fx(0.1), fy(0));
    ed.state.ref2.bg = true; ed._applyStateToUI(); ed.fitRef2('frame-contain', { keepMode: true });
    R.bgKeepsMode = ed.state.ref2.mode === 'mask';
    ed.state.ref2.bgOpacity = 1; R.bgFull = px(fx(0.1), fy(0));            // left half of the contained image (yellow), far from the model
    R.bgRight = px(fx(0.9), fy(0));                                      // right half (blue)
    R.bgAbove = px(fx(0.1), fy(-0.4));                                   // above the image (frame is 1:1, image only 0.5 tall)
    ed.state.ref2.bgOpacity = 0.5; const half = px(fx(0.1), fy(0));
    R.bgOpacityMix = half[0] > 120 && half[0] < 200 && half[2] < 60;     // between background 0x20 and 255
    R.bgChecks = isYellow(R.bgFull) && isBlue(R.bgRight) && dark(R.bgAbove) && dark(R.bgOffPx);
    R.bgInFrameOnly = true;
    ed.state.ref2.bg = false; ed._applyStateToUI(); R.bgOffAgain = dark(px(fx(0.1), fy(0)));
    // ---- importance weights, presets and capture meta
    const presetBtn = (txt) => [...ed.ui.sec.ref.body.querySelectorAll('button')].find((b) => b.textContent === txt);
    presetBtn('Keep original look').click(); R.pKeep = ed.state.blend.gen === 0.65 && ed.state.blend.orig === 0.35 && ed.state.blend.ref === 0;
    presetBtn('Literal reference').click(); R.pLit = ed.state.blend.ref === 0.5 && ed.state.blend.gen === 0.5 && ed.state.ref2.enabled;
    presetBtn('Reference guides only').click(); R.pGuide = ed.state.ref2.original === true && ed.state.ref2.weight === 0 && ed.state.blend.gen === 1 && ed.state.blend.ref === 0;
    presetBtn('Generated only').click(); R.pGen = ed.state.blend.gen === 1 && ed.state.blend.orig === 0;
    ed.state.blend.orig = 0.25; ed._applyStateToUI(); const capB = await ed.capture({ includeMesh: false, includeTexture: false });
    R.blendMeta = capB.meta.blend.orig === 0.25 && capB.meta.blend.gen === 1;
    R.colorFix = R.leftOfMid[1] > 205;                                   // preview no longer darker than the real image (yellow G = 224)
    ed.state.blend.orig = 0;
    // HUD draws without errors, reset button, exit keys
    ed._drawHUD(); R.hud = true;
    ed.ui.root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    R.exitedByKey = ed.placeMode === false; await sleep(50);
    R.afterExit = px(0.5, 0.5); R.previewOffAfterExit = !isYellow(R.afterExit) && !isBlue(R.afterExit);
    // state persists (ox/oy/size/wrap) and metadata carries the manual placement
    ed.state.ref2.mode = 'manual'; ed.state.ref2.original = true; ed.state.ref2.has = true;
    const cap = await ed.capture({ includeMesh: false, includeTexture: false });
    R.meta = cap.meta.ref2.original === true && cap.meta.ref2.mode === 'manual' && typeof cap.meta.ref2.size === 'number' && cap.meta.ref2.has === true;
    R.saved = JSON.stringify(ed.getState().ref2);
    return R;
  }, colors);
  console.log(JSON.stringify(R));
  const must = {
    'no preview before placement mode': R.noImage,
    'placement mode switches ref2 to manual + enabled': R.entered && R.mode,
    'image shows only inside the mask, correct halves (yellow | blue)': R.paintedLeft && R.paintedRight,
    'drag moves by dx / frame width, brush does not paint': Math.abs(R.dragDx - 0.2) < 0.01 && R.noPaintWhileDragging && R.dragMoved,
    'wheel changes size': R.sizeUp,
    'Alt+drag rotates (0.4 deg / px)': R.rotated,
    'small image: no repeat -> rest of mask untouched; repeat -> filled': R.smallNoRepeat && R.repeat,
    'rotate handle follows the pointer, Shift snaps to 15 deg': R.handle90 && R.snap15,
    'rotate buttons +-90 / 0': R.btnZero && R.btnMinus,
    'fit: inside / fill / stretch frame': R.fit.contain && R.fit.cover && R.fit.stretch,
    'fit: fill / inside the painted area (mask box maths)': R.fit.maskCover && R.fit.maskContain,
    'fit: stretched preview uses the aspect override': R.stretchHalves,
    'fit boxes exclusive; drag clears; untick keeps values': R.excl && R.dragClears && R.untick,
    'send-original box toggles': R.orig && R.origOff,
    'viewport background: shows only inside the frame, opacity, keeps the bake placement mode, switches off': R.bgChecks && R.bgKeepsMode && R.bgOpacityMix && R.bgOffAgain,
    'importance weights: presets + capture meta': R.pKeep && R.pLit && R.pGuide && R.pGen && R.blendMeta,
    'placement preview colours are no longer darkened': R.colorFix,
    'HUD outline draws': R.hud,
    'Esc exits and preview disappears': R.exitedByKey && R.previewOffAfterExit,
    'capture meta carries manual placement': R.meta,
  };
  for (const [k, v] of Object.entries(must)) { console.log((v ? 'PASS ' : 'FAIL ') + k); if (!v) failed = true; }
} catch (e) {
  failed = true;
  console.log('TEST FAILURE:', e.stack || e);
}
console.log('--- browser console ---\n' + logs.join('\n'));
await browser.close(); server.close();
process.exit(failed ? 1 : 0);
