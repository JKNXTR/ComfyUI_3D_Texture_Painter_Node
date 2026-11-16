// View regions: each of the four extra reference images (3..6) has a brush colour. Painting in that colour marks the part of the model
// that this reference (= this camera angle) is responsible for; erasing removes parts of it again. The region is shown in 3D / UV in the
// slot colour, clips the placed-reference preview, is sent with the capture (seen from the capture camera) so the reference only acts inside
// its own region, and can be turned into the AI mask, so every side can be calculated on its own and the results merge in the texture.
import * as THREE from 'three';
import { h, makeButton, makeCheck } from './ui.js';

export const VIEW_COLORS = ['#ff8a00', '#ff2bd6', '#00d8ff', '#ffe600'];
const rgb = (hex) => { const c = new THREE.Color(hex); return [c.r, c.g, c.b]; };

export function installViews(ed) {
  const st = ed.state, ui = ed.ui;
  st.views = Object.assign({ show: true, active: 0, clip: true, has: [false, false, false, false] }, st.views || {});
  ed.viewRT = []; ed.viewVersion = 0; ed.viewHas = [false, false, false, false];
  const mk = () => ed._snapRT();
  const mu = ed.meshMat.uniforms, uu = ed.uvMat.uniforms;

  ed._initViews = () => {
    for (const rt of ed.viewRT) rt && rt.dispose();
    ed.viewRT = [0, 1, 2, 3].map(mk);
    for (const rt of ed.viewRT) ed._clearRT(rt, 0);
    ed.viewHas = [false, false, false, false]; st.views.has = [false, false, false, false];
    ed._bindViews();
  };
  ed._bindViews = () => {
    if (!ed.viewRT.length) return;
    for (let i = 0; i < 4; i++) {
      const col = rgb(st.refx[i].color || VIEW_COLORS[i]);
      for (const U of [mu, uu]) { U['tV' + i].value = ed.viewRT[i].texture; U['uVC' + i].value.set(col[0], col[1], col[2]); }
    }
    for (const U of [mu, uu]) U.uShowViews.value = st.views.show ? 1 : 0;
    mu.tRefRgn.value = ed.viewRT[0].texture;
  };
  const readPixels = (rt) => {
    ed.copyGreyMat.uniforms.tSrc.value = rt.texture;
    ed._pass(ed.copyGreyMat, ed.readRT);
    const S = ed.maskSize, buf = new Uint8Array(S * S * 4);
    ed.renderer.readRenderTargetPixels(ed.readRT, 0, 0, S, S, buf);
    return buf;
  };
  ed._readRT = readPixels;
  const nonEmpty = (i) => { const b = readPixels(ed.viewRT[i]); for (let k = 0; k < b.length; k += 4) if (b[k] > 4) return true; return false; };
  ed._viewsChanged = (i) => {
    ed.viewVersion++;
    for (const k of (i === undefined ? [0, 1, 2, 3] : [i])) { ed.viewHas[k] = nonEmpty(k); st.views.has[k] = ed.viewHas[k]; }
    ed._bindViews(); ed.invalidate(); ed._dirty('mask'); if (ed._renderViews) ed._renderViews();
  };
  ed._pushViewUndo = (i) => {
    const snap = ed._snapRT(); ed._copyRT(ed.viewRT[i], snap);
    ed.undoStack.push({ k: 'vw', i, rt: snap }); ed._clearRedo(); ed._trim(); ed._updateUndoButtons();
  };
  ed.viewClear = (i) => { ed._pushViewUndo(i); ed._clearRT(ed.viewRT[i], 0); ed._viewsChanged(i); };
  /** copy a region into the AI mask (replace, or add to it) */
  ed.viewToMask = (i, add = false) => {
    if (!ed.viewHas[i]) { ed.setStatus('View region ' + (i + 3) + ' is empty - paint it first.', 'warn'); return false; }
    ed._pushUndo();
    if (!add) ed._copyRT(ed.viewRT[i], ed.maskRT);
    else {
      const a = readPixels(ed.viewRT[i]), b = readPixels(ed.maskRT), S = ed.maskSize;
      for (let k = 0; k < a.length; k += 4) { const v = Math.max(a[k], b[k]); a[k] = a[k + 1] = a[k + 2] = v; a[k + 3] = 255; }
      const tex = new THREE.CanvasTexture(ed._pixelsToCanvas(a, S, S)); tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
      ed.copyMat.uniforms.tSrc.value = tex; ed._pass(ed.copyMat, ed.maskRT); tex.dispose();
    }
    ed._maskChanged(); return true;
  };
  ed.exportViewBlob = (i) => ed._canvasToBlob(ed._pixelsToCanvas(readPixels(ed.viewRT[i]), ed.maskSize, ed.maskSize));
  ed.importViewBitmap = (i, bmp, { undo = true } = {}) => {
    if (undo) ed._pushViewUndo(i);
    const c = document.createElement('canvas'); c.width = c.height = ed.maskSize;
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
    ed.copyMat.uniforms.tSrc.value = tex; ed._pass(ed.copyMat, ed.viewRT[i]); tex.dispose();
    ed._viewsChanged(i);
  };
  /** the regions that apply to this capture, seen from the capture camera: [{i, blob}] (only slots that have an image and a region) */
  ed.viewRegionPasses = async (rt, cam) => {
    const out = [];
    const prev = ed.passMat.uniforms.tMask.value;
    try {
      for (let i = 0; i < 4; i++) {
        const sl = st.refx[i];
        if (!(ed.viewHas[i] && sl.has && sl.enabled !== false)) continue;
        ed.passMat.uniforms.tMask.value = ed.viewRT[i].texture;
        out.push({ i, blob: await ed._renderPassToBlob(rt, cam, 3, [0, 0, 0], 0) });
      }
    } finally { ed.passMat.uniforms.tMask.value = prev; }
    return out;
  };
  /** region of the active reference slot clips the placement preview (called by the placement code) */
  ed._viewClipUniforms = (n) => {
    const i = n - 3, on = st.views.clip && i >= 0 && i < 4 && ed.viewHas[i];
    mu.uRefRegion.value = on ? 1 : 0;
    if (on) mu.tRefRgn.value = ed.viewRT[i].texture;
  };

  // ---------------------------------------------------------------- panel
  const sec = ui.sec.views, body = sec.body;
  const showCb = makeCheck('Show view regions (3D + UV)', st.views.show, (v) => { st.views.show = v; ed._bindViews(); ed.invalidate(); ed._dirty('settings'); });
  const clipCb = makeCheck('Clip the placed reference preview to its region', st.views.clip, (v) => { st.views.clip = v; ed.invalidate(); ed._dirty('settings'); });
  body.append(showCb.el, clipCb.el);
  const rows = [];
  const paintWith = (i, erase) => { st.views.active = i; st.brushTarget = 'view'; ed.setTool(erase ? 'erase' : 'brush'); ed._applyStateToUI(); ed._dirty('settings'); ed.setStatus(`${erase ? 'Erasing from' : 'Painting'} view region ${i + 3} (${st.refx[i].color || VIEW_COLORS[i]}).`); };
  for (let i = 0; i < 4; i++) {
    const row = h('div'); row.style.cssText = 'border-top:1px solid #2c3039;padding:4px 0;margin-top:3px';
    const col = h('input'); col.type = 'color'; col.style.cssText = 'width:26px;height:20px;padding:0;border:0;background:none;vertical-align:middle;cursor:pointer'; col.title = 'Brush colour of this view';
    col.value = st.refx[i].color || VIEW_COLORS[i];
    col.oninput = () => { st.refx[i].color = col.value; ed._bindViews(); ed.invalidate(); ed.hudDirty = true; ed._dirty('settings'); };
    const title = h('span', 'tp-lbl', ''); title.style.cssText = 'margin-left:6px;font-weight:600';
    const info = h('span'); info.style.cssText = 'margin-left:6px;opacity:.7';
    const b = h('div'); b.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-top:3px';
    const bP = makeButton('Paint', 'Paint this view region with the brush'), bE = makeButton('Erase', 'Erase parts of this view region'), bC = makeButton('Clear'),
      bM = makeButton('= AI mask', 'Use the region as the AI mask (replaces it) - then queue this side'), bA = makeButton('+ AI mask', 'Add the region to the AI mask'),
      bG = makeButton('Go to angle', 'Move the camera to the saved angle of this reference image'), bPl = makeButton('Place', 'Select this image and open its placement (position / rotate / scale X, Y)');
    bP.onclick = () => paintWith(i, false); bE.onclick = () => paintWith(i, true); bC.onclick = () => ed.viewClear(i);
    bM.onclick = () => ed.viewToMask(i, false); bA.onclick = () => ed.viewToMask(i, true);
    bG.onclick = () => { if (ed.refGotoAngle) ed.refGotoAngle(i + 3); };
    bPl.onclick = () => { if (ed.setRefActive) ed.setRefActive(i + 3); else ed.refActive = i + 3; if (ed.refPlaceOpen) ed.refPlaceOpen(); ed._applyStateToUI(); };
    row.append(col, title, info, b); b.append(bP, bE, bC, bM, bA, bG, bPl);
    body.append(row); rows.push({ col, title, info, bM, bA, bG, bPl });
  }
  body.append(h('div', 'tp-note', 'Each of the reference images 3-6 owns a colour. Paint a region in a colour (Paint / Erase here, or pick the colour in the right-click menu of the 3D view): that reference only acts inside its region, in the capture and in the placed preview. For a side-by-side workflow: go to the angle, "= AI mask", queue; repeat for the other sides - every bake merges into the same texture (seam-aware blending keeps the joints smooth). Positioning of each image (move / rotate / scale X and Y) is in its "Reference image" panel.'));
  const refresh = () => {
    showCb.set(st.views.show); clipCb.set(st.views.clip);
    rows.forEach((r, i) => {
      const sl = st.refx[i]; r.col.value = sl.color || VIEW_COLORS[i];
      r.title.textContent = `View ${i + 3}`; r.info.textContent = (sl.has ? (sl.angle || sl.name || 'image loaded') : 'no image') + ' · ' + (ed.viewHas[i] ? 'region painted' : 'region empty');
      r.bG.disabled = !sl.cam;
    });
  };
  ed._renderViews = refresh;
  const prev = ed._applyStateToUI; ed._applyStateToUI = () => { if (prev) prev(); ed._bindViews(); refresh(); };
  refresh();
  if (ed.maskRT) ed._initViews();
}
