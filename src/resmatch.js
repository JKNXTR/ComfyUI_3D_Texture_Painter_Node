// "Resolution match": how many pixels of the AI render land on one texel of the UV texture?
// The bake pulls every texel's colour out of the generated image, so the texture can never be sharper than the render (a 1024 px view stretched
// over a 4096 texture is just a blurry 1024 image). This panel measures it for the current camera / mask and sets capture size, crop and texture size to match.
import * as THREE from 'three';
import { h, makeButton, makeCheck, makeSlider } from './ui.js';

const snap = (v, k = 64) => Math.max(k, Math.round(v / k) * k);

export function installResMatch(ed) {
  const st = ed.state, body = ed.ui.sec.resm.body;

  /** view pixels per UV texel (linear) over the painted, well-facing triangles; null when nothing is measurable */
  ed.estimateDensity = () => {
    if (!ed.hasModel || !ed.info || !ed.info.hasUV || ed.maskIsEmpty()) return null;
    const [W, H] = ed.captureSize(), cam = ed._captureCamera(W, H);
    const Tw = ed.layers.w, Th = ed.layers.h, S = ed.maskSize, px = ed._readMaskPixels();
    const pos = ed.geometry.attributes.position.array, uv = ed.geometry.attributes.uv.array, idx = ed.geometry.index.array;
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    const ortho = !!cam.isOrthographicCamera, cp = cam.position, fwd = cam.getWorldDirection(new THREE.Vector3());
    const sat = new Uint32Array((S + 1) * (S + 1));
    for (let y = 0; y < S; y++) { let run = 0; for (let x = 0; x < S; x++) { if (px[(y * S + x) * 4] >= 40) run++; sat[(y + 1) * (S + 1) + x + 1] = sat[y * (S + 1) + x + 1] + run; } }
    const items = []; let tris = 0, seen = 0;
    const P = (k, o) => { const X = pos[k * 3], Y = pos[k * 3 + 1], Z = pos[k * 3 + 2]; const w = m[3] * X + m[7] * Y + m[11] * Z + m[15]; o.w = w; o.x = ((m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w * 0.5 + 0.5) * W; o.y = (1 - ((m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w * 0.5 + 0.5)) * H; o.X = X; o.Y = Y; o.Z = Z; };
    const a = {}, b = {}, c = {};
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const i0 = idx[t], i1 = idx[t + 1], i2 = idx[t + 2];
      const u0 = uv[i0 * 2], v0 = uv[i0 * 2 + 1], u1 = uv[i1 * 2], v1 = uv[i1 * 2 + 1], u2 = uv[i2 * 2], v2 = uv[i2 * 2 + 1];
      // painted when any masked texel lies inside the triangle's UV box (summed-area table; large low-poly triangles are often only partly painted)
      const bx0 = Math.max(0, Math.floor(Math.min(u0, u1, u2) * S)), bx1 = Math.min(S - 1, Math.floor(Math.max(u0, u1, u2) * S));
      const by0 = Math.max(0, Math.floor(Math.min(v0, v1, v2) * S)), by1 = Math.min(S - 1, Math.floor(Math.max(v0, v1, v2) * S));
      if (bx1 < bx0 || by1 < by0 || sat[(by1 + 1) * (S + 1) + bx1 + 1] - sat[by0 * (S + 1) + bx1 + 1] - sat[(by1 + 1) * (S + 1) + bx0] + sat[by0 * (S + 1) + bx0] <= 0) continue;
      seen++;
      P(i0, a); P(i1, b); P(i2, c);
      if (a.w <= 1e-6 || b.w <= 1e-6 || c.w <= 1e-6) continue;
      const cx = (a.x + b.x + c.x) / 3, cy = (a.y + b.y + c.y) / 3;
      if (cx < 0 || cy < 0 || cx > W || cy > H) continue;
      const apx = Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
      const auv = Math.abs((u1 - u0) * (v2 - v0) - (u2 - u0) * (v1 - v0)) / 2 * Tw * Th;   // triangle area in texels
      if (auv < 1e-6 || apx < 1e-9) continue;
      const e1x = b.X - a.X, e1y = b.Y - a.Y, e1z = b.Z - a.Z, e2x = c.X - a.X, e2y = c.Y - a.Y, e2z = c.Z - a.Z;
      let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1; nx /= nl; ny /= nl; nz /= nl;
      let vx, vy, vz;
      if (ortho) { vx = -fwd.x; vy = -fwd.y; vz = -fwd.z; }
      else { vx = cp.x - (a.X + b.X + c.X) / 3; vy = cp.y - (a.Y + b.Y + c.Y) / 3; vz = cp.z - (a.Z + b.Z + c.Z) / 3; const vl = Math.hypot(vx, vy, vz) || 1; vx /= vl; vy /= vl; vz /= vl; }
      const f = Math.abs(nx * vx + ny * vy + nz * vz);
      if (f < 0.35) continue;                                      // grazing triangles are not baked anyway
      items.push([Math.sqrt(apx / f / auv), auv * f]); tris++;     // foreshortening-corrected pixels per texel, weight = texels it covers
    }
    if (!items.length) return { none: true, seen };
    items.sort((p, q) => p[0] - q[0]);
    const tot = items.reduce((s, x) => s + x[1], 0);
    const at = (q) => { let acc = 0; for (const it of items) { acc += it[1]; if (acc >= tot * q) return it[0]; } return items[items.length - 1][0]; };
    const [cw, ch] = [W, H];
    return { p: at(0.5), worst: at(0.2), best: at(0.8), tris, cw, ch, tw: Tw, th: Th, long: st.capture.long, crop: !!(st.capture.crop && st.capture.crop.enabled) };
  };

  // ---- recommendations from one measurement
  const plan = (d, maxLong) => {
    const needLong = snap(st.capture.long / d.p), ovC = +ovCap.value, longSet = ovC || Math.min(maxLong, Math.max(256, needLong));
    const pAfter = d.p * longSet / st.capture.long;              // density grows linearly with the capture size
    const texMatch = Math.max(256, Math.min(4096, Math.round(Math.max(d.tw, d.th) * Math.min(1, pAfter))));
    return { needLong, longSet, pAfter, texMatch };
  };

  const info = h('div', 'tp-note'); info.style.whiteSpace = 'pre-line';
  const maxSel = h('select'); for (const v of [1024, 1536, 2048, 3072, 4096]) { const o = h('option', null, String(v)); o.value = String(v); maxSel.append(o); } maxSel.value = '2048';
  const maxRow = h('div', 'tp-row'); maxRow.append(h('span', 'tp-lbl', 'Max AI render side'), maxSel, h('span'));
  const ovSel = (opts) => { const e = h('select'); for (const [v, t] of opts) { const o = h('option', null, t); o.value = String(v); e.append(o); } return e; };
  const ovCap = ovSel([[0, 'Auto (measured)'], [512, '512'], [768, '768'], [1024, '1024'], [1536, '1536'], [2048, '2048'], [3072, '3072'], [4096, '4096']]);
  const ovTex = ovSel([[0, 'Auto (measured)'], [512, '512'], [1024, '1024'], [2048, '2048'], [3072, '3072'], [4096, '4096']]);
  const ovRow = (label, sel) => { const r = h('div', 'tp-row'); r.append(h('span', 'tp-lbl', label), sel, h('span')); return r; };
  const bOv = makeButton('Apply overrides now', 'Set the capture size / texture size chosen above (anything left on Auto stays as it is)');
  const bAn = makeButton('Analyse current view', 'Measure how many pixels of the AI render land on one texel of the UV texture (needs a painted mask)');
  const bAuto = makeButton('Auto match', 'Raise the capture size (up to the maximum above) so the render has about 1 pixel per texel; if that is not enough, shrink the texture to what the render can really fill');
  const bCap = makeButton('Capture size = needed', 'Set the capture long side so the render has about 1 pixel per texel (limited by the maximum above, or the override)');
  const bTex = makeButton('Texture size = render', 'Resize the texture (all layers, one undo step) to what the AI render can fill - no more blurry upscaled detail');
  const bCrop = makeButton('Crop view to painted area', 'Zoom the captured view onto the mask: the same render size puts many more pixels on the painted texels');
  let last = null;
  const show = () => {
    const d = last;
    if (!d) { info.textContent = 'Paint a mask on the part you want to texture, set the camera, then press "Analyse current view".'; return; }
    if (d.none) { info.textContent = 'The painted area is not visible (or only at a grazing angle) from this camera - nothing to measure.'; return; }
    const pl = plan(d, +maxSel.value), T = Math.max(d.tw, d.th);
    const verdict = d.p >= 0.95 ? 'GOOD - the render has at least one pixel per texel.' : d.p >= 0.5 ? 'SOFT - detail is stretched up to ' + (1 / d.p).toFixed(1) + 'x.' : 'BLURRY - the texture is ' + (1 / d.p).toFixed(1) + 'x finer than the render can fill; the bake only enlarges the AI image.';
    info.textContent = `Pixels of the AI render per UV texel: ${d.p.toFixed(2)} (weakest fifth ${d.worst.toFixed(2)}, best fifth ${d.best.toFixed(2)})\n` +
      `AI render ${d.cw}x${d.ch}${d.crop ? ' (cropped to the mask)' : ''}, texture ${d.tw}x${d.th}.  ${verdict}\n` +
      (d.p < 0.95 ? `Needed for 1 px per texel: capture long side ${pl.needLong}${pl.needLong > +maxSel.value ? ' (above your maximum ' + maxSel.value + ' - then the texture size ' + pl.texMatch + ' is what the render can fill)' : ''}; or texture ${pl.texMatch}. ` : '') +
      (d.crop ? '' : 'Crop to the painted area multiplies the pixels on the mask.');
  };
  const analyse = () => { try { last = ed.estimateDensity(); } catch (e) { last = null; ed.log('error', 'Resolution analysis failed', e); } if (!last && ed.hasModel && ed.maskIsEmpty()) ed.setStatus('Paint a mask first - the analysis measures the painted area.', 'warn'); show(); return last; };
  ed.analyseResolution = analyse;
  const setLong = (v) => { st.capture.long = v; if (ed._updateCapLabel) ed._updateCapLabel(); ed.invalidate(); ed._dirty('capture'); ed._applyStateToUI(); };
  bAn.onclick = analyse;
  bCap.onclick = () => { const d = analyse(); if (!d || d.none) return; const pl = plan(d, +maxSel.value); setLong(pl.longSet); analyse(); ed.setStatus(`Capture long side ${pl.longSet}.`, 'ok'); };
  const setTexLong = (nl) => {
    const T = Math.max(ed.layers.w, ed.layers.h), k = nl / T;
    if (ed.layers.resizeTo(Math.round(ed.layers.w * k), Math.round(ed.layers.h * k))) ed.log('ok', `Texture resized to ${ed.layers.w}x${ed.layers.h} (Undo restores it).`);
  };
  bOv.onclick = () => {
    const c = +ovCap.value, t = +ovTex.value;
    if (!c && !t) { ed.setStatus('Both overrides are on Auto - pick a size first.', 'warn'); return; }
    if (c) setLong(c);
    if (t) setTexLong(t);
    analyse(); ed.setStatus(`Override: capture ${st.capture.long}, texture ${ed.layers.w}x${ed.layers.h}.`, 'ok');
  };
  bTex.onclick = () => {
    const d = analyse(); if (!d || d.none) return; const T = Math.max(d.tw, d.th), f = Math.min(1, d.p) * T / T;
    const nl = +ovTex.value || Math.max(256, Math.min(4096, Math.round(T * f / 64) * 64)), k = nl / T;
    if (ed.layers.resizeTo(Math.round(d.tw * k), Math.round(d.th * k))) ed.log('ok', `Texture resized to ${ed.layers.w}x${ed.layers.h} to match the AI render (Undo restores it).`);
    analyse();
  };
  bCrop.onclick = () => { st.capture.crop.enabled = true; ed.hudDirty = true; ed.invalidate(); ed._dirty('capture'); ed._applyStateToUI(); analyse(); };
  bAuto.onclick = () => {
    let d = analyse(); if (!d || d.none) return;
    const pl = plan(d, +maxSel.value); if (pl.longSet !== st.capture.long) setLong(pl.longSet);
    d = analyse(); if (!d || d.none) return;
    if (+ovTex.value || d.p < 0.95) bTex.onclick();
    ed.setStatus(`Matched: capture ${st.capture.long}, texture ${ed.layers.w}x${ed.layers.h}.`, 'ok');
  };
  const row = (...b) => { const r = h('div', 'tp-row2'); r.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:2px 0'; r.append(...b); return r; };
  body.append(bAn, info, maxRow, ovRow('Override: AI render side', ovCap), ovRow('Override: texture size', ovTex), bOv, row(bAuto, bCap), row(bTex, bCrop),
    h('div', 'tp-note', 'Why textures look low-resolution: every texel is read from the AI render, so the texture is only as sharp as that render (default capture 1024 px). Wire the painter\'s width / height outputs into the Klein latent size so the generated image really has the capture size (Klein otherwise renders its own size and the bake stretches it). In the Bake node keep output_resolution on "match texture" unless you want a larger master. More detail on the same texel = larger capture, crop to the painted area, or paint smaller regions per view.'));
  show();
}
