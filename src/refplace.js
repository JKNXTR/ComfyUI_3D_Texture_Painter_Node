// Reference image 2: planar placement mode. While active, image 2 is drawn over the 3D model in capture-frame space
// (exactly what is sent to Klein), visible only inside the painted mask. Drag = move, wheel = size, Alt+drag = rotate.
import * as THREE from 'three';
import { h, makeButton, makeSlider, makeCheck } from './ui.js';

export function installRefPlace(ed) {
  const st = ed.state, ui = ed.ui, p3 = ui.pane3d;
  ed.placeMode = false;
  const T = () => ed.refState(), TC = () => ed.refCanvas(), TV = () => ed.refVersion() + ed.refActive * 1e6, DK = () => ed.refDirtyKind(), N = () => ed.refActive;
  let tex = null, texVer = -1;

  const mu = ed.meshMat.uniforms;
  const ensureTex = () => {
    if (texVer === TV() || !TC()) return;
    if (tex) tex.dispose();
    // raw values: the shaders write the colour untouched, so no sRGB decode (otherwise the preview is darker than the real image)
    tex = new THREE.CanvasTexture(TC()); tex.colorSpace = THREE.NoColorSpace; tex.minFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    texVer = TV(); mu.tRef.value = tex;
  };
  const sxOf = () => Math.max(0.05, T().sx || 1), syOf = () => Math.max(0.05, T().sy || 1);
  const sizeOf = () => Math.max(0.02, T().size) * sxOf();           // displayed width (frame widths) incl. Scale X
  const aspEff = () => aspOf() * syOf() / sxOf();                        // displayed height / width incl. Scale X / Y
  const aspOf = () => (T().aspect > 0 ? T().aspect : (TC() ? TC().height / TC().width : 1));
  // The model is drawn at a scale that follows the pane HEIGHT, while the stored placement (ox, oy, size) is in
  // frame widths (what the AI/Python side reads). When the pane or the capture aspect changes (full screen on/off,
  // window resize) the frame width / pane height ratio changes, so every placed reference is re-scaled by the old/new
  // ratio: it then stays glued to the model, and the stored numbers stay correct for the current frame.
  const syncFrameRatio = (w, hh) => {
    if (!(w > 20 && hh > 20)) return;
    const k = ed.frameRect(w, hh).w / hh, st = ed.state, prev = st.display.refK || ed._refK || k;
    ed._refK = k;
    if (Math.abs(prev - k) < 1e-6 * Math.max(1, k)) { if (st.display.refK !== k) st.display.refK = k; return; }
    const f = prev / k;
    for (const s of [st.ref2, ...(st.refx || [])]) { if (!s) continue; s.ox *= f; s.oy *= f; s.size = Math.max(0.02, s.size * f); }
    st.display.refK = k;
    ed._dirty('ref2'); ed._dirty('refx'); ed._dirty('settings');
    if (ed._applyStateToUI) ed._applyStateToUI();
  };
  ed._syncRefFrame = syncFrameRatio;
  ed._refUniforms = (pane, w, hh, H) => {
    syncFrameRatio(w, hh);
    const r0 = T();
    // while placing, and afterwards for a placed (manual) image that is in use and switched on in the panel
    const on = !!(TC() && r0.has && (ed.placeMode || (r0.view !== false && r0.mode === 'manual' && r0.enabled !== false)));
    mu.uRefOn.value = on ? 1 : 0;
    mu.uRefA.value = Math.min(1, Math.max(0, r0.viewOpacity === undefined ? 0.95 : r0.viewOpacity));
    mu.uRefAll.value = r0.viewAll ? 1 : 0;
    if (ed._viewClipUniforms) ed._viewClipUniforms(N());
    if (!on) return;
    ensureTex();
    const fr = ed.frameRect(w, hh), r2 = T();
    mu.uFrame.value.set(pane.offsetLeft + fr.x, (H - pane.offsetTop - hh) + (hh - fr.y - fr.h), fr.w, fr.h);
    mu.uDpr.value = ed.renderer.getPixelRatio();
    mu.uRefP.value.set(r2.ox, r2.oy, sizeOf(), (r2.rot * Math.PI) / 180);
    mu.uRefQ.value.set(aspEff(), r2.wrap ? 1 : 0);
  };

  // ---- viewport background: image 2 behind the model, inside the capture frame (same transform as the manual placement)
  const bgMat = new THREE.ShaderMaterial({
    uniforms: { tRef: { value: null }, uFrame: { value: new THREE.Vector4() }, uDpr: { value: 1 }, uRefP: { value: new THREE.Vector4() }, uRefQ: { value: new THREE.Vector2(1, 0) }, uOpacity: { value: 0.6 } },
    vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `uniform sampler2D tRef; uniform vec4 uFrame; uniform float uDpr; uniform vec4 uRefP; uniform vec2 uRefQ; uniform float uOpacity;
void main(){
  vec2 f = (gl_FragCoord.xy / uDpr - uFrame.xy) / uFrame.zw;
  if (f.x < 0.0 || f.x > 1.0 || f.y < 0.0 || f.y > 1.0) discard;
  vec2 d = vec2(f.x - 0.5 - uRefP.x, (0.5 - f.y) * uFrame.w / uFrame.z - uRefP.y);
  float ca = cos(uRefP.w), sa = sin(uRefP.w);
  vec2 q = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / uRefP.z;
  vec2 uv = vec2(q.x + 0.5, q.y / uRefQ.x + 0.5);
  float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
  if (uRefQ.y > 0.5) { uv = fract(uv); inside = 1.0; }
  if (inside < 0.5) discard;
  gl_FragColor = vec4(texture2D(tRef, vec2(uv.x, 1.0 - uv.y)).rgb, uOpacity);
}`,
    transparent: true, depthTest: false, depthWrite: false,
  });
  const bgScene = new THREE.Scene(), bgCam = new THREE.Camera();
  const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
  const bgMesh = new THREE.Mesh(tri, bgMat); bgMesh.frustumCulled = false; bgScene.add(bgMesh);
  ed._drawBg = (pane, w, hh, H) => {
    const r2 = T();
    if (!r2.bg || !r2.has || !TC()) return;
    ensureTex();
    const fr = ed.frameRect(w, hh), u = bgMat.uniforms;
    u.tRef.value = tex;
    u.uFrame.value.set(pane.offsetLeft + fr.x, (H - pane.offsetTop - hh) + (hh - fr.y - fr.h), fr.w, fr.h);
    u.uDpr.value = ed.renderer.getPixelRatio();
    u.uRefP.value.set(r2.ox, r2.oy, sizeOf(), (r2.rot * Math.PI) / 180);
    u.uRefQ.value.set(aspEff(), r2.wrap ? 1 : 0);
    u.uOpacity.value = Math.min(1, Math.max(0.05, r2.bgOpacity));
    ed.renderer.render(bgScene, bgCam);
  };

  // ---- UI
  const rf = ui.sec.ref.body;
  const W = {};
  const bPlace = makeButton('Place on model...', 'Temporary mode: move / size / rotate image 2 over the model; it is visible only inside the painted mask');
  const bReset = makeButton('Reset placement', 'Centre the image at half the frame width, no rotation');
  W.size = makeSlider('Size (frame width)', { min: 5, max: 400, step: 1, value: 50, fmt: (v) => v + '%' }, (v) => { T().size = v / 100; T().fit = ''; setManual(); });
  const setSc = (k, v) => { T()[k] = v / 100; T().fit = ''; setManual(); };
  W.sx = makeSlider('Scale X (width)', { min: 5, max: 400, step: 1, value: 100, fmt: (v) => v + '%' }, (v) => setSc('sx', v));
  W.sy = makeSlider('Scale Y (height)', { min: 5, max: 400, step: 1, value: 100, fmt: (v) => v + '%' }, (v) => setSc('sy', v));
  const bSc1 = makeButton('1:1 X/Y', 'Reset Scale X and Y to 100% (undistorted)');
  bSc1.onclick = () => { T().sx = 1; T().sy = 1; T().fit = ''; setManual(); ed._applyStateToUI(); };
  W.wrap = makeCheck('Repeat image outside its borders', !!T().wrap, (v) => { T().wrap = v; setManual(); });
  const bRm = makeButton('\u21BA 90\u00B0', 'Rotate 90 degrees counter-clockwise'), bRp = makeButton('90\u00B0 \u21BB', 'Rotate 90 degrees clockwise'), bR0 = makeButton('0\u00B0', 'No rotation');
  const rotRow = h('div', 'tp-row2'); rotRow.style.cssText = 'display:flex;gap:6px'; rotRow.append(bRm, bRp, bR0);
  bRm.onclick = () => ed.rotateRef2(-90); bRp.onclick = () => ed.rotateRef2(90); bR0.onclick = () => ed.setRef2Rotation(0);
  W.view = makeCheck('Show the placed image on the model', T().view !== false, (v) => { T().view = v; ed.invalidate(); ed._dirty(DK()); });
  W.vop = makeSlider('Image opacity in the 3D view', { min: 0, max: 100, step: 1, value: 95, fmt: (v) => v + '%' }, (v) => { T().viewOpacity = v / 100; ed.invalidate(); ed._dirty(DK()); });
  W.vall = makeCheck('Show the whole image (not only inside the painted area)', !!T().viewAll, (v) => { T().viewAll = v; ed.invalidate(); ed._dirty(DK()); });
  W.view.el.title = 'Keeps the placed image visible over the model after "Done placing" (viewport only - the AI capture is not changed). Shown for the active reference image, once it is placed.';
  const row = h('div', 'tp-row2'); row.style.cssText = 'display:flex;gap:6px'; row.append(bPlace, bReset);
  rf.insertBefore(row, rf.firstChild);
  { const vb = h('div'); vb.style.cssText = 'margin:4px 0'; vb.append(W.view.el, W.vop.el, W.vall.el); rf.insertBefore(vb, row.nextSibling); }
  rf.append(W.size.el, W.sx.el, W.sy.el, bSc1, rotRow, W.wrap.el, h('div', 'tp-note', 'Placement mode: drag = move, mouse wheel = size, drag the round handle above the image (or Alt + drag, or the Rotate slider / buttons) = rotate (Shift = 15\u00B0 steps), Enter / Esc = done. Right / middle mouse still orbit and pan, so you can choose the view first. Only the part inside the painted mask is used; the position is relative to the dashed capture frame, so the same view must be queued.'));

  const setManual = () => { T().mode = 'manual'; if (ed._refModeSel) ed._refModeSel.value = 'manual'; ed._dirty(DK()); ed.hudDirty = true; ed.invalidate(); };
  bReset.onclick = () => { Object.assign(T(), { ox: 0, oy: 0, size: 0.5, sx: 1, sy: 1, rot: 0, aspect: 0, fit: '' }); setManual(); ed._applyStateToUI(); };
  ed.setPlaceMode = (on) => {
    if (on) {
      if (!ed.hasModel) { ed.setStatus('Load a model first.', 'warn'); return false; }
      if (!T().has) { ed.setStatus('Load image ' + N() + ' first.', 'warn'); return false; }
      if (ed.maskIsEmpty()) ed.setStatus('Paint a mask first - image ' + N() + ' is only visible inside it.', 'warn');
      T().enabled = true; T().mode = 'manual';
    }
    if (T().mode === 'manual' && T().has) T().pcam = ed.cameraPose('placed');   // the camera the image is placed from (needed to project it onto the UV map)
    ed.placeMode = !!on;
    bPlace.textContent = on ? 'Done placing' : 'Place on model...';
    p3.style.cursor = on ? 'move' : '';
    ed._applyStateToUI(); ed._dirty(DK()); ed.hudDirty = true; ed.invalidate();
    if (on) ed.setStatus('Placing image ' + N() + ': drag to move, wheel to size, Alt+drag to rotate. Enter = done.', 'ok');
    return true;
  };
  bPlace.onclick = () => ed.setPlaceMode(!ed.placeMode);
  ed.setRefActive = (n) => {
    n = Math.max(2, Math.min(6, n | 0)); if (n === ed.refActive) return;
    if (ed.placeMode) ed.setPlaceMode(false);
    ed.refActive = n; texVer = -1;
    if (ed._renderRef2) ed._renderRef2();
    ed._applyStateToUI(); ed.hudDirty = true; ed.invalidate();
  };

  // ---- fit options (check boxes, mutually exclusive): the reference rarely has the proportions of the viewport frame
  const FITS = [
    ['frame-contain', 'Fit inside the frame (whole image, keeps proportions)'],
    ['frame-cover', 'Fill the frame (crops the overflow, keeps proportions)'],
    ['frame-stretch', 'Stretch to the frame (distorts the image)'],
    ['mask-cover', 'Fill the painted area (covers its box, keeps proportions)'],
    ['mask-contain', 'Fit inside the painted area (whole image, keeps proportions)'],
  ];
  const fitChecks = {};
  ed.fitRef2 = (kind, { keepMode = false } = {}) => {
    if (!T().has || !TC()) { ed.setStatus('Load image ' + N() + ' first.', 'warn'); return false; }
    const [W, H] = ed.captureSize(), A = W / H, asp0 = TC().height / TC().width;
    let box = { cx: 0, cy: 0, w: 1, h: 1 / A };                     // frame box, in frame widths (y down)
    if (kind.startsWith('mask')) {
      const b = ed.maskBox();
      if (!b) { ed.setStatus('Paint a mask first - nothing to fit to.', 'warn'); return false; }
      box = { cx: (b.x0 + b.x1) / 4, cy: -(b.y0 + b.y1) / (4 * A), w: (b.x1 - b.x0) / 2, h: (b.y1 - b.y0) / (2 * A) };
    }
    const r2 = T();
    if (!keepMode) { r2.mode = 'manual'; r2.enabled = true; }
    r2.rot = 0; r2.ox = box.cx; r2.oy = box.cy; r2.aspect = 0; r2.sx = 1; r2.sy = 1;
    if (kind.endsWith('stretch')) { r2.size = box.w; r2.aspect = box.h / box.w; }
    else if (kind.endsWith('contain')) r2.size = Math.min(box.w, box.h / asp0);
    else r2.size = Math.max(box.w, box.h / asp0);
    r2.fit = kind;
    ed.hudDirty = true; ed.invalidate(); ed._dirty(DK()); ed._applyStateToUI();
    return true;
  };
  const fitRow = h('div', 'tp-fitbox');
  const fitLbl = h('div', 'tp-lbl', 'Fit image 2 to'); fitRow.append(fitLbl);
  for (const [k, t] of FITS) {
    const c = makeCheck(t, T().fit === k, (v) => { if (v) ed.fitRef2(k); else { T().fit = ''; ed._dirty(DK()); ed._applyStateToUI(); } });
    fitChecks[k] = c; fitRow.append(c.el);
  }
  W.orig = makeCheck('Send the ORIGINAL image (undistorted) as its reference output', !!T().original, (v) => { T().original = v; ed._dirty(DK()); });
  fitRow.append(W.orig.el, h('div', 'tp-note', 'Placement only decides where image 2 is blended into the masked area of the view. With "Send the ORIGINAL image 2" the reference_image output gives Klein the picture itself (own proportions, nothing cropped or stretched) as its reference for the result. Ticking a fit box applies it once; tick it again after changing the view or the mask.'));
  rf.append(fitRow);

  // ---- viewport background
  const bgBox = h('div', 'tp-fitbox');
  W.bg = makeCheck('Show this image as viewport background (position the model against it)', !!T().bg, (v) => {
    T().bg = v;
    if (v && T().has && T().mode !== 'manual') ed.fitRef2('frame-contain', { keepMode: true });   // a sensible start; the bake placement mode is untouched
    ed.invalidate(); ed._dirty(DK()); ed._applyStateToUI();
  });
  W.bgOp = makeSlider('Background opacity', { min: 5, max: 100, step: 1, value: Math.round(T().bgOpacity * 100), fmt: (v) => v + '%' }, (v) => { T().bgOpacity = v / 100; ed.invalidate(); ed._dirty(DK()); });
  bgBox.append(W.bg.el, W.bgOp.el, h('div', 'tp-note', 'The background sits inside the dashed capture frame and uses the manual placement (Place on model / Fit boxes) - move, size and rotate it there. It is only a positioning aid: it is never part of the captured view.'));
  rf.append(bgBox);

  // ---- importance of the sources in the FINAL texture
  const mixBox = h('div', 'tp-fitbox');
  mixBox.append(h('div', 'tp-lbl', 'Importance in the final texture (applied when baking)'));
  const mixInfo = h('div', 'tp-note', '');
  const showMix = () => {
    const b = st.blend, sum = b.gen + b.orig + b.ref || 1;
    mixInfo.textContent = `Share: generated ${Math.round(100 * b.gen / sum)}% - original viewport ${Math.round(100 * b.orig / sum)}% - reference 2 ${Math.round(100 * b.ref / sum)}% (reference counts only where image 2 covers the view)`;
  };
  const mk = (key, label, tip) => { const sl = makeSlider(label, { min: 0, max: 100, step: 1, value: Math.round(st.blend[key] * 100), fmt: (v) => v + '%' }, (v) => { st.blend[key] = v / 100; showMix(); ed._dirty('settings'); }); sl.el.title = tip; mixBox.append(sl.el); return sl; };
  W.mixG = mk('gen', 'Generated result', 'The newly generated image from Klein');
  W.mixO = mk('orig', 'Original viewport (current texture)', 'The unmarked view of the model with its current texture = the original UV-mapped area');
  W.mixR = mk('ref', 'Reference image 2 (placed)', 'Image 2 as placed in the frame; use for a literal contribution');
  mixBox.append(mixInfo);
  const presets = h('div', 'tp-row2'); presets.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap';
  const preset = (label, tip, fn) => { const b = makeButton(label, tip); b.onclick = () => { fn(); ed._dirty(DK()); ed._dirty('settings'); ed._applyStateToUI(); }; presets.append(b); };
  preset('Generated only', 'Final texture = the generated image', () => Object.assign(st.blend, { gen: 1, orig: 0, ref: 0 }));
  preset('Reference guides only', 'Klein gets the untouched image 2 as a reference; nothing of it is pasted into the view or the result', () => { Object.assign(st.blend, { gen: 1, orig: 0, ref: 0 }); st.ref2.enabled = true; st.ref2.original = true; st.ref2.weight = 0; });
  preset('Keep original look', '65% generated + 35% of the original viewport', () => Object.assign(st.blend, { gen: 0.65, orig: 0.35, ref: 0 }));
  preset('Literal reference', '50% generated + 50% of image 2 where it covers the view', () => { Object.assign(st.blend, { gen: 0.5, orig: 0, ref: 0.5 }); st.ref2.enabled = true; });
  mixBox.append(presets, h('div', 'tp-note', 'Image 1 = the view Klein edits (original viewport), image 2 = your reference. "Reference guides only" sends the original image 2 to Klein as a pure reference (Send ORIGINAL on, no blending into the view) while the final texture is the generated result.'));
  rf.append(mixBox);
  const showMixSync = () => { W.mixG.set(Math.round(st.blend.gen * 100)); W.mixO.set(Math.round(st.blend.orig * 100)); W.mixR.set(Math.round(st.blend.ref * 100)); showMix(); };

  // placed image geometry in pane pixels (also used for the rotate handle)
  const geom = () => {
    const w = p3.offsetWidth, hh = p3.offsetHeight, fr = ed.frameRect(w, hh), r2 = T();
    const asp = aspEff(), a = (r2.rot * Math.PI) / 180;
    const cx = fr.x + (0.5 + r2.ox) * fr.w, cy = fr.y + fr.h / 2 + r2.oy * fr.w, hw = (sizeOf() * fr.w) / 2, hhh = hw * asp;
    const off = hhh + 28;   // rotate handle sits 28 px beyond the top edge
    return { cx, cy, hw, hhh, a, hx: cx + Math.sin(a) * off, hy: cy - Math.cos(a) * off, ex: cx + Math.sin(a) * hhh, ey: cy - Math.cos(a) * hhh };
  };
  const setRot = (deg, snap) => {
    let d = ((deg + 540) % 360) - 180;
    if (snap) d = Math.round(d / 15) * 15;
    T().rot = Math.round(d * 10) / 10; ed.hudDirty = true; ed.invalidate(); ed._dirty(DK()); ed._applyStateToUI();
  };
  ed.rotateRef2 = (deltaDeg) => setRot(T().rot + deltaDeg, false);
  ed.setRef2Rotation = (deg) => setRot(deg, false);

  // ---- pointer (capture phase so the brush never sees the events)
  let drag = null;
  const frameW = () => ed.frameRect(p3.offsetWidth, p3.offsetHeight).w;
  p3.addEventListener('pointerdown', (e) => {
    if (!ed.placeMode || e.button !== 0) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const r = p3.getBoundingClientRect(), g0 = geom(), px = e.clientX - r.left, py = e.clientY - r.top;
    drag = { x: e.clientX, y: e.clientY, rot: e.altKey, handle: Math.hypot(px - g0.hx, py - g0.hy) < 12 };
    try { p3.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
  }, true);
  p3.addEventListener('pointermove', (e) => {
    if (!ed.placeMode || !drag) return;
    e.stopImmediatePropagation();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.x = e.clientX; drag.y = e.clientY;
    if (drag.handle) {   // rotate handle: the handle follows the pointer around the image centre (Shift = 15 degree steps)
      const r = p3.getBoundingClientRect(), g0 = geom();
      setRot((Math.atan2(e.clientY - r.top - g0.cy, e.clientX - r.left - g0.cx) * 180) / Math.PI + 90, e.shiftKey);
      return;
    }
    if (drag.rot) T().rot = ((T().rot + dx * 0.4 + 540) % 360) - 180;
    else { const fw = frameW() || 1; T().ox += dx / fw; T().oy += dy / fw; if (T().fit) T().fit = ''; }
    ed.hudDirty = true; ed.invalidate(); ed._dirty(DK());
  }, true);
  const up = (e) => { if (drag) { drag = null; try { p3.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ } ed._applyStateToUI(); } };
  p3.addEventListener('pointerup', up, true);
  p3.addEventListener('pointercancel', up, true);
  p3.addEventListener('wheel', (e) => {
    if (!ed.placeMode) return;
    e.stopImmediatePropagation(); e.preventDefault();
    const k0 = Math.exp(-e.deltaY * 0.0015); T().size = Math.min(4, Math.max(0.05, T().size * k0)); T().fit = '';
    ed.hudDirty = true; ed.invalidate(); ed._dirty(DK()); W.size.set(Math.round(T().size * 100));
  }, { capture: true, passive: false });
  ui.root.addEventListener('keydown', (e) => {
    const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
    if (ed.placeMode && !typing && (e.key === 'Enter' || e.key === 'Escape')) { e.stopImmediatePropagation(); e.preventDefault(); ed.setPlaceMode(false); }
  }, true);

  // ---- HUD: outline of the placed image
  const prevHUD = ed._drawHUD;
  ed._drawHUD = () => {
    prevHUD();
    if (!ed.placeMode || !T().has || !TC()) return;
    const ctx = ui.hudCanvas.getContext('2d'), dpr = ed.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = p3.offsetWidth, hh = p3.offsetHeight, fr = ed.frameRect(w, hh), r2 = T();
    const asp = aspEff(), a = (r2.rot * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
    const cx = p3.offsetLeft + fr.x + (0.5 + r2.ox) * fr.w, cy = p3.offsetTop + fr.y + fr.h / 2 + r2.oy * fr.w;
    const hw = (sizeOf() * fr.w) / 2, hhh = hw * asp;
    const pt = (x, y) => [cx + ca * x - sa * y, cy + sa * x + ca * y];
    ctx.save(); ctx.beginPath(); ctx.rect(p3.offsetLeft, p3.offsetTop, w, hh); ctx.clip();
    ctx.strokeStyle = '#2fe0ff'; ctx.lineWidth = 1.5; ctx.setLineDash([6, 4]);
    ctx.beginPath(); [[-hw, -hhh], [hw, -hhh], [hw, hhh], [-hw, hhh]].forEach(([x, y], i) => { const [px, py] = pt(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.closePath(); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(cx - 8, cy); ctx.lineTo(cx + 8, cy); ctx.moveTo(cx, cy - 8); ctx.lineTo(cx, cy + 8); ctx.stroke();
    { const g = geom(), ox = p3.offsetLeft, oy = p3.offsetTop;
      ctx.beginPath(); ctx.moveTo(ox + g.ex, oy + g.ey); ctx.lineTo(ox + g.hx, oy + g.hy); ctx.stroke();
      ctx.fillStyle = '#101216'; ctx.beginPath(); ctx.arc(ox + g.hx, oy + g.hy, 7, 0, 7); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.arc(ox + g.hx, oy + g.hy, 3, 0, 7); ctx.fillStyle = '#2fe0ff'; ctx.fill();
      ctx.fillText(Math.round(r2.rot) + '\u00B0', ox + g.hx + 12, oy + g.hy + 4); }
    ctx.fillStyle = '#2fe0ff'; ctx.font = '11px system-ui,sans-serif';
    ctx.fillText('Placing image ' + N() + '  -  drag: move   wheel: size   round handle / Alt+drag: rotate   Enter: done', p3.offsetLeft + 10, p3.offsetTop + hh - 10);
    ctx.restore();
  };

  const prevApply = ed._applyStateToUI;
  ed._applyStateToUI = () => { prevApply(); W.view.set(T().view !== false); W.vop.set(Math.round((T().viewOpacity === undefined ? 0.95 : T().viewOpacity) * 100)); W.vall.set(!!T().viewAll); fitLbl.textContent = 'Fit image ' + N() + ' to'; W.size.set(Math.round(T().size * 100)); W.sx.set(Math.round((T().sx || 1) * 100)); W.sy.set(Math.round((T().sy || 1) * 100)); W.wrap.set(!!T().wrap); W.orig.set(!!T().original); W.bg.set(!!T().bg); W.bgOp.set(Math.round(T().bgOpacity * 100)); showMixSync(); ed.invalidate(); for (const [k, c] of Object.entries(fitChecks)) c.set(T().fit === k); bPlace.classList.toggle('tp-on', ed.placeMode); };
  ed._applyStateToUI();
}
