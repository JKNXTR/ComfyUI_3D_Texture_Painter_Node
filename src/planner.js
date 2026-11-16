// Coverage heatmap, next-view suggestion, auto multi-view runs, variations, generation presets, crop-to-mask UI,
// live progress. Everything that talks to ComfyUI goes through ed.hooks (generate / getSeed / setSeed / cancel).
import * as THREE from 'three';
import { h, makeButton, makeSlider, makeCheck } from './ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function installPlanner(ed) {
  const st = ed.state, ui = ed.ui, L = ed.layers;

  // ------------------------------------------------------------------------------------------
  // coverage (max alpha of the visible AI layers x layer mask), cached by layer content
  // ------------------------------------------------------------------------------------------
  let islandCache = null;
  const islandPixels = () => {
    const w = L.w, hh = L.h, key = ed.meshHash + ':' + w + 'x' + hh;
    if (islandCache && islandCache.key === key) return islandCache.px;
    const rt = L._rt(w, hh, 'rgba8', { nearest: true });
    const r = ed.renderer, pT = r.getRenderTarget(), pS = r.getScissorTest();
    r.setRenderTarget(rt); r.setScissorTest(false); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    r.render(ed.coverScene, ed.quadCam);
    const buf = new Uint8Array(w * hh * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, hh, buf);
    r.setRenderTarget(pT); r.setScissorTest(pS); rt.dispose();
    const px = new Uint8Array(w * hh);               // top row first
    for (let y = 0; y < hh; y++) { const src = (hh - 1 - y) * w * 4; for (let x = 0; x < w; x++) px[y * w + x] = buf[src + x * 4 + 3] > 127 ? 255 : 0; }
    islandCache = { key, px };
    return px;
  };

  let covCache = null;
  ed.getCoverage = () => {
    if (!ed.hasModel) return null;
    const w = L.w, hh = L.h;
    const ai = L.layers.filter((l) => l.ai && l.visible);
    const key = ed.meshHash + ':' + w + 'x' + hh + ':' + ai.map((l) => `${l.pix.uid}/${l.mask ? l.mask.uid : 0}/${l.opacity}`).join(',');
    if (covCache && covCache.key === key) return covCache;
    const island = islandPixels();
    const cov = new Uint8Array(w * hh);
    for (const l of ai) {
      const a = L.toCanvas(l.pix).getContext('2d').getImageData(0, 0, w, hh).data;
      const m = L.maskBytes(l);
      for (let i = 0; i < cov.length; i++) {
        let v = a[i * 4 + 3] * l.opacity;
        if (m) v *= m[i] / 255;
        if (v > cov[i]) cov[i] = v;
      }
    }
    let isl = 0, good = 0, max = 0;
    const thr = st.plan.thr * 255;
    for (let i = 0; i < cov.length; i++) { if (cov[i] > max) max = cov[i]; if (island[i]) { isl++; if (cov[i] >= thr) good++; } }
    covCache = { key, cov, island, w, h: hh, max, islandTexels: isl, fraction: isl ? good / isl : 0 };
    return covCache;
  };

  ed.coverageFraction = () => { const c = ed.getCoverage(); if (!c) return 0; const thr = st.plan.thr * 255; let g = 0; for (let i = 0; i < c.cov.length; i++) if (c.island[i] && c.cov[i] >= thr) g++; return c.islandTexels ? g / c.islandTexels : 0; };

  // ---- heat texture on the 3D model and the UV map
  let heatTex = null;
  const updateHeat = () => {
    const on = !!st.plan.showCover && ed.hasModel;
    ed.meshMat.uniforms.uShowCover.value = on ? 1 : 0;
    ed.uvMat.uniforms.uShowCover.value = on ? 1 : 0;
    if (!on) { ed.invalidate(); return; }
    const c = ed.getCoverage(); if (!c) return;
    const { w, h: hh, cov, island } = c, thr = st.plan.thr * 255;
    const data = new Uint8Array(w * hh * 4);
    for (let y = 0; y < hh; y++) {
      const dst = (hh - 1 - y) * w * 4;   // texture rows are bottom-up
      for (let x = 0; x < w; x++) {
        const i = y * w + x, o = dst + x * 4;
        if (!island[i]) continue;
        const v = cov[i];
        let r, g, b;
        if (v < 8) { r = 235; g = 64; b = 64; }                       // not covered
        else if (v < thr) { const t = v / thr; r = 240; g = 90 + 130 * t; b = 50; }   // weak: orange -> yellow
        else { r = 60; g = 200; b = 110; }                              // covered
        data[o] = r; data[o + 1] = g; data[o + 2] = b; data[o + 3] = 150;
      }
    }
    if (heatTex) heatTex.dispose();
    heatTex = new THREE.DataTexture(data, w, hh, THREE.RGBAFormat);
    heatTex.minFilter = heatTex.magFilter = THREE.LinearFilter; heatTex.needsUpdate = true;
    ed.meshMat.uniforms.tCover.value = heatTex; ed.uvMat.uniforms.tCover.value = heatTex;
    ed.invalidate();
  };
  let heatTimer = 0;
  const heatSoon = () => { clearTimeout(heatTimer); heatTimer = setTimeout(() => { try { if (st.plan.showCover || ui.sec.plan.el.open) { updateHeat(); updateStats(); } } catch (e) { ed.log('warn', 'Coverage update failed', e); } }, 250); };
  const origLC = ed._layersChanged.bind(ed);
  ed._layersChanged = function () { origLC(); heatSoon(); };

  // ------------------------------------------------------------------------------------------
  // next view
  // ------------------------------------------------------------------------------------------
  const DIRS = (() => {
    const out = [];
    for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) for (let z = -1; z <= 1; z++) if (x || y || z) out.push(new THREE.Vector3(x, y, z).normalize());
    const N = 96, ga = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < N; i++) { const yy = 1 - (2 * i) / (N - 1), r = Math.sqrt(1 - yy * yy), th = ga * i; out.push(new THREE.Vector3(Math.cos(th) * r, yy, Math.sin(th) * r)); }
    return out;
  })();

  /** Direction (towards the camera) from which the most uncovered surface area faces the viewer. */
  ed.suggestNextView = () => {
    const c = ed.getCoverage();
    if (!c) return null;
    const pos = ed.geometry.attributes.position.array, uv = ed.geometry.attributes.uv.array, idx = ed.geometry.index.array;
    const T = Math.floor(idx.length / 3), thr = st.plan.thr;
    const wgt = new Float32Array(T), nx = new Float32Array(T), ny = new Float32Array(T), nz = new Float32Array(T), cen = new Float32Array(T * 3);
    let total = 0;
    for (let t = 0; t < T; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, d = idx[t * 3 + 2] * 3;
      const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      const vx = pos[d] - pos[a], vy = pos[d + 1] - pos[a + 1], vz = pos[d + 2] - pos[a + 2];
      const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
      const len = Math.hypot(cx, cy, cz);
      if (len < 1e-12) continue;
      const area = len / 2;
      const ia = idx[t * 3] * 2, ib = idx[t * 3 + 1] * 2, id = idx[t * 3 + 2] * 2;
      const u = (uv[ia] + uv[ib] + uv[id]) / 3, v = (uv[ia + 1] + uv[ib + 1] + uv[id + 1]) / 3;
      const X = Math.min(c.w - 1, Math.max(0, Math.floor(u * c.w))), Y = Math.min(c.h - 1, Math.max(0, Math.floor((1 - v) * c.h)));
      const cv = c.cov[Y * c.w + X] / 255;
      const un = cv >= thr ? 0 : 1 - cv / thr;                 // 1 = nothing there yet, 0 = already covered
      wgt[t] = area * un; total += area;
      nx[t] = cx / len; ny[t] = cy / len; nz[t] = cz / len;
      cen[t * 3] = (pos[a] + pos[b] + pos[d]) / 3; cen[t * 3 + 1] = (pos[a + 1] + pos[b + 1] + pos[d + 1]) / 3; cen[t * 3 + 2] = (pos[a + 2] + pos[b + 2] + pos[d + 2]) / 3;
    }
    const f0 = Math.max(0.05, st.capture.facing);
    let best = -1, bestScore = 0;
    const sm = (e0, e1, x) => { const k = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return k * k * (3 - 2 * k); };
    DIRS.forEach((dv, i) => {
      let s = 0;
      for (let t = 0; t < T; t++) { if (wgt[t] === 0) continue; const f = Math.abs(nx[t] * dv.x + ny[t] * dv.y + nz[t] * dv.z); s += wgt[t] * sm(f0, f0 + 0.25, f); }
      if (s > bestScore) { bestScore = s; best = i; }
    });
    if (best < 0 || bestScore < total * 0.002) return { done: true, uncovered: 0 };
    const dir = DIRS[best];
    // frame the uncovered triangles that face this direction
    const box = new THREE.Box3(); let n = 0;
    for (let t = 0; t < T; t++) {
      if (wgt[t] === 0) continue;
      if (Math.abs(nx[t] * dir.x + ny[t] * dir.y + nz[t] * dir.z) < 0.5) continue;
      box.expandByPoint(new THREE.Vector3(cen[t * 3], cen[t * 3 + 1], cen[t * 3 + 2])); n++;
    }
    const center = n ? box.getCenter(new THREE.Vector3()) : new THREE.Vector3();
    const radius = n ? Math.max(0.3, box.getSize(new THREE.Vector3()).length() / 2) : (ed.modelRadius || 1);
    return { dir: dir.clone(), center, radius, score: bestScore, uncovered: bestScore / Math.max(total, 1e-9) };
  };

  /** Smoothly moves the camera: new target + direction + distance. */
  ed.flyTo = (target, dir, dist, ms = 350) => {
    const t0 = ed.controls.target.clone(), p0 = ed.camera.position.clone();
    const d1 = dir.clone().normalize();
    if (Math.abs(d1.y) > 0.9999) { d1.x += 1e-4; d1.normalize(); }
    const p1 = target.clone().addScaledVector(d1, dist);
    const half0 = ed.orthoHalf / (ed.camera.zoom || 1), half1 = Math.max(0.05, dist * Math.tan(THREE.MathUtils.degToRad(ed.perspCam.fov) / 2));
    cancelAnimationFrame(ed._viewAnim);
    return new Promise((resolve) => {
      const start = performance.now();
      const step = (now) => {
        if (ed.disposed) return resolve();
        const k = Math.min(1, (now - start) / ms), e = k * k * (3 - 2 * k);
        ed.controls.target.lerpVectors(t0, target, e);
        ed.camera.position.lerpVectors(p0, p1, e);
        if (ed.isOrtho) { ed.orthoHalf = half0 + (half1 - half0) * e; ed.camera.zoom = 1; }
        ed.camera.lookAt(ed.controls.target); ed.camera.updateProjectionMatrix(); ed.controls.update(); ed.invalidate();
        if (k < 1) ed._viewAnim = requestAnimationFrame(step); else resolve();
      };
      ed._viewAnim = requestAnimationFrame(step);
    });
  };

  ed.goToNextView = async () => {
    const s = ed.suggestNextView();
    if (!s) return null;
    if (s.done) { ed.setStatus('Everything is covered - nothing left to suggest.', 'ok'); return s; }
    const dist = Math.max(0.6, s.radius / Math.sin(THREE.MathUtils.degToRad(ed.perspCam.fov) / 2) * 1.25);
    await ed.flyTo(s.center, s.dir, Math.min(dist, 6));
    ed.setStatus(`Suggested view: ${(s.uncovered * 100).toFixed(0)}% of the surface is still uncovered here.`, 'ok');
    return s;
  };

  /** Mask = every UV texel that is not yet covered (the bake only fills what this camera sees well; the rest stays masked). */
  ed.maskUncovered = async () => {
    const c = ed.getCoverage(); if (!c) return false;
    const S = ed.maskSize, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), id = g.createImageData(S, S), d = id.data, thr = st.plan.thr * 255;
    let any = false;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = Math.min(c.h - 1, Math.floor(y * c.h / S)) * c.w + Math.min(c.w - 1, Math.floor(x * c.w / S));
      const on = c.island[i] && c.cov[i] < thr;
      const o = (y * S + x) * 4; d[o] = d[o + 1] = d[o + 2] = on ? 255 : 0; d[o + 3] = 255; if (on) any = true;
    }
    g.putImageData(id, 0, 0);
    if (!any) { ed.setStatus('Nothing uncovered - the mask would be empty.', 'ok'); return false; }
    ed.importMaskBitmap(await createImageBitmap(cv));
    return true;
  };

  // ------------------------------------------------------------------------------------------
  // generation runs: auto multi-view batch + variations
  // ------------------------------------------------------------------------------------------
  const needHook = () => { if (!ed.hooks.generate) { ed.setStatus('Auto runs need ComfyUI (they queue the workflow for you).', 'warn'); return false; } return true; };
  const isBusy = () => ed._runBusy;
  const setBusy = (v) => { ed._runBusy = v; for (const b of [bBatch, bVar, bNext, bMaskUn]) b.disabled = v; bStop.disabled = !v; };

  ed.stopRuns = () => { ed._runCancel = true; try { if (ed.hooks.cancelGeneration) ed.hooks.cancelGeneration(); } catch (_) { /* ignore */ } ed.setStatus('Stopping ...', 'warn'); };

  ed.runBatch = async ({ views = st.plan.batchN, target = st.plan.target } = {}) => {
    if (isBusy() || !needHook() || !ed.hasModel) return { steps: 0 };
    setBusy(true); ed._runCancel = false;
    let done = 0, reason = '';
    try {
      for (let i = 0; i < views; i++) {
        if (ed._runCancel) { reason = 'stopped'; break; }
        const frac = ed.coverageFraction();
        if (frac >= target) { reason = 'target reached'; break; }
        ed.setStatus(`Auto view ${i + 1}/${views} - coverage ${(frac * 100).toFixed(0)}%: moving camera ...`);
        const s = await ed.goToNextView();
        if (!s || s.done) { reason = 'nothing left'; break; }
        if (!(await ed.maskUncovered())) { reason = 'nothing left'; break; }
        ed.setStatus(`Auto view ${i + 1}/${views}: generating ...`);
        const res = await ed.hooks.generate();
        if (ed._runCancel) { reason = 'stopped'; break; }
        ed.showResult(res.bmp, res.rem, res.stats);
        if (ed.pending) ed.applyResult();
        done++;
        await sleep(50);
      }
    } catch (e) {
      ed.log('error', 'Auto multi-view run failed', e); ed.setStatus('Auto run failed: ' + e.message, 'err'); reason = 'error';
    } finally { setBusy(false); ed.setProgress(null); }
    const frac = ed.coverageFraction();
    ed.setStatus(`Auto run finished (${reason || 'all views done'}): ${done} view(s) added, coverage ${(frac * 100).toFixed(0)}%.`, reason === 'error' ? 'err' : 'ok');
    heatSoon();
    return { steps: done, reason, coverage: frac };
  };

  ed.candidates = [];
  const candBox = h('div', 'tp-cands');
  const thumbHash = (bmp) => {
    const c = document.createElement('canvas'); c.width = c.height = 16; const g = c.getContext('2d'); g.drawImage(bmp, 0, 0, 16, 16);
    const d = g.getImageData(0, 0, 16, 16).data; let s = 0; for (let i = 0; i < d.length; i++) s = (s * 31 + d[i]) >>> 0; return s;
  };
  const renderCands = () => {
    candBox.innerHTML = '';
    ed.candidates.forEach((cd, i) => {
      const c = document.createElement('canvas'); c.width = c.height = 64; c.className = 'tp-cand' + (cd.sel ? ' tp-on' : '');
      c.title = `Variation ${i + 1} (seed ${cd.seed}) - click to preview in the 3D view`;
      const g = c.getContext('2d');
      const sm = document.createElement('canvas'); sm.width = sm.height = 96; const sg = sm.getContext('2d'); sg.drawImage(cd.bmp, 0, 0, 96, 96);
      const d = sg.getImageData(0, 0, 96, 96).data; let x0 = 96, x1 = 0, y0 = 96, y1 = 0;
      for (let y = 0; y < 96; y++) for (let x = 0; x < 96; x++) if (d[(y * 96 + x) * 4 + 3] > 24) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      g.fillStyle = '#2a2d36'; g.fillRect(0, 0, 64, 64);
      if (x1 > x0 && y1 > y0) { const k = (cd.bmp.width / 96); const sw = (x1 - x0 + 1) * k, sh = (y1 - y0 + 1) * k, sc = Math.min(60 / sw, 60 / sh); g.drawImage(cd.bmp, x0 * k, y0 * k, sw, sh, 32 - sw * sc / 2, 32 - sh * sc / 2, sw * sc, sh * sc); }
      c.onclick = () => { ed.candidates.forEach((o) => { o.sel = false; }); cd.sel = true; ed.showResult(cd.bmp, cd.rem, cd.stats); renderCands(); };
      candBox.append(c);
    });
  };
  ed.runVariations = async (n = st.plan.varN) => {
    if (isBusy() || !needHook() || !ed.hasModel) return [];
    if (ed.maskIsEmpty()) { ed.setStatus('Paint a mask first.', 'warn'); return []; }
    setBusy(true); ed._runCancel = false; ed.candidates = []; renderCands();
    const base = ed.hooks.getSeed ? ed.hooks.getSeed() : Math.floor(Math.random() * 1e9);
    try {
      for (let i = 0; i < n; i++) {
        if (ed._runCancel) break;
        if (ed.hooks.setSeed) ed.hooks.setSeed(base + i);
        ed.setStatus(`Variation ${i + 1}/${n} (seed ${base + i}) ...`);
        const res = await ed.hooks.generate();
        ed.candidates.push({ bmp: res.bmp, rem: res.rem, stats: res.stats, seed: base + i, sel: false });
        renderCands();
      }
    } catch (e) {
      ed.log('error', 'Variations failed', e); ed.setStatus('Variations failed: ' + e.message, 'err');
    } finally { setBusy(false); ed.setProgress(null); if (ed.hooks.setSeed) ed.hooks.setSeed(base); }
    if (ed.candidates.length > 1 && new Set(ed.candidates.map((c) => thumbHash(c.bmp))).size === 1) {
      ed.log('warn', 'All variations look identical - connect the painter node\'s "seed" output to the sampler\'s noise_seed so the seed can change.');
      ed.setStatus('All variations are identical - connect the "seed" output to the sampler noise_seed.', 'warn');
    } else if (ed.candidates.length) ed.setStatus(`${ed.candidates.length} variations ready - click one to preview, then Apply.`, 'ok');
    return ed.candidates;
  };

  // ------------------------------------------------------------------------------------------
  // live progress + sampler preview
  // ------------------------------------------------------------------------------------------
  ed.setProgress = (frac, label) => {
    const p = ui.prog;
    if (frac === null || frac === undefined) { p.style.display = 'none'; return; }
    p.style.display = ''; ui.progBar.style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    if (label) p.title = label;
  };
  let liveUrl = null;
  ed.setLivePreview = (blob) => {
    if (liveUrl) { URL.revokeObjectURL(liveUrl); liveUrl = null; }
    if (!blob) { ui.live.style.display = 'none'; return; }
    liveUrl = URL.createObjectURL(blob); ui.live.src = liveUrl; ui.live.style.display = '';
  };

  // ------------------------------------------------------------------------------------------
  // panel
  // ------------------------------------------------------------------------------------------
  const ps = ui.sec.plan.body;
  const mkRow = (...b) => { const r = h('div', 'tp-row2'); r.append(...b); return r; };
  const statsEl = h('div', 'tp-note', '');
  const W = {};
  W.show = makeCheck('Show coverage heatmap (green = covered by AI layers, red = not yet)', st.plan.showCover, (v) => { st.plan.showCover = v; ed._dirty('settings'); updateHeat(); updateStats(); });
  W.thr = makeSlider('Covered above', { min: 20, max: 95, step: 5, value: 60, fmt: (v) => v + '%' }, (v) => { st.plan.thr = v / 100; ed._dirty('settings'); heatSoon(); });
  W.seam = makeCheck('Seam-aware blending (cross-fade with what earlier views already painted)', st.plan.seam, (v) => { st.plan.seam = v; ed._dirty('capture'); });
  const bNext = makeButton('Suggest next view', 'Fly to the angle that sees the most still-uncovered surface');
  const bMaskUn = makeButton('Mask uncovered', 'Select every texel that is not covered yet');
  bNext.onclick = () => { ed.goToNextView(); };
  bMaskUn.onclick = () => { ed.maskUncovered().then((ok) => ok && ed.setStatus('Uncovered area selected.', 'ok')); };
  W.bn = makeSlider('Max views', { min: 1, max: 8, step: 1, value: 4, fmt: (v) => v }, (v) => { st.plan.batchN = v; ed._dirty('settings'); });
  W.tg = makeSlider('Stop at coverage', { min: 50, max: 100, step: 5, value: 95, fmt: (v) => v + '%' }, (v) => { st.plan.target = v / 100; ed._dirty('settings'); });
  const bBatch = makeButton('Auto-paint views', 'Repeats: suggest view -> mask uncovered -> generate -> apply, until the coverage target or the view limit');
  bBatch.onclick = () => ed.runBatch();
  const bStop = makeButton('Stop', 'Stop the auto run (also interrupts the running generation)'); bStop.disabled = true;
  bStop.onclick = () => ed.stopRuns();
  W.vn = makeSlider('Variations', { min: 2, max: 6, step: 1, value: 4, fmt: (v) => v }, (v) => { st.plan.varN = v; ed._dirty('settings'); });
  const bVar = makeButton('Generate variations', 'Runs the workflow N times with consecutive seeds and shows the candidates');
  bVar.onclick = () => ed.runVariations();
  const upNote = h('div', 'tp-note', 'Auto runs queue your workflow for you. For variations the painter\'s "seed" output must be wired to the sampler noise_seed (the supplied workflows do this).');
  ps.append(W.show.el, W.thr.el, statsEl, mkRow(bNext, bMaskUn), W.seam.el,
    h('div', 'tp-lbl', 'Auto multi-view'), W.bn.el, W.tg.el, mkRow(bBatch, bStop),
    h('div', 'tp-lbl', 'Variations'), W.vn.el, mkRow(bVar), candBox, upNote);

  function updateStats() {
    if (!ed.hasModel) { statsEl.textContent = ''; return; }
    const c = ed.getCoverage();
    statsEl.textContent = c ? `AI coverage: ${(ed.coverageFraction() * 100).toFixed(0)}% of the UV surface (from the visible AI layers; merged layers are not counted).` : '';
  }
  ed._updatePlanStats = updateStats;

  // ---- generation presets + crop (capture panel)
  const cs = ui.sec.cap.body;
  const G = {};
  const presetSel = h('select');
  for (const [v, t] of [['distilled', 'Klein 9B distilled (4 steps, cfg 1)'], ['base', 'Klein 9B base (20 steps, cfg 5)'], ['custom', 'Custom']]) { const o = h('option', null, t); o.value = v; presetSel.append(o); }
  presetSel.onchange = () => {
    st.gen.preset = presetSel.value;
    if (st.gen.preset === 'distilled') { st.gen.steps = 4; st.gen.cfg = 1.0; } else if (st.gen.preset === 'base') { st.gen.steps = 20; st.gen.cfg = 5.0; }
    syncGen(); ed._dirty('capture');
  };
  const presetRow = h('div', 'tp-row'); presetRow.append(h('span', 'tp-lbl', 'Model preset'), presetSel, h('span'));
  G.steps = makeSlider('Steps', { min: 1, max: 50, step: 1, value: 4, fmt: (v) => v }, (v) => { st.gen.steps = v; st.gen.preset = 'custom'; presetSel.value = 'custom'; ed._dirty('capture'); });
  G.cfg = makeSlider('CFG', { min: 0, max: 100, step: 5, value: 10, fmt: (v) => (v / 10).toFixed(1) }, (v) => { st.gen.cfg = v / 10; st.gen.preset = 'custom'; presetSel.value = 'custom'; ed._dirty('capture'); });
  const qualSel = h('select');
  for (const [v, t] of [[768, 'Draft (768 px)'], [1024, 'Standard (1024 px)'], [1536, 'High (1536 px)'], [2048, 'Max (2048 px)']]) { const o = h('option', null, t); o.value = v; qualSel.append(o); }
  qualSel.onchange = () => { st.capture.long = +qualSel.value; st.gen.quality = +qualSel.value; ed._applyStateToUI(); ed.invalidate(); ed._dirty('capture'); };
  const qualRow = h('div', 'tp-row'); qualRow.append(h('span', 'tp-lbl', 'Resolution'), qualSel, h('span'));
  G.crop = makeCheck('Crop to mask (more pixels on the selected area)', st.capture.crop.enabled, (v) => { st.capture.crop.enabled = v; ed.hudDirty = true; ed.invalidate(); ed._dirty('capture'); });
  G.margin = makeSlider('Crop margin', { min: 0, max: 40, step: 1, value: 12, fmt: (v) => v + '%' }, (v) => { st.capture.crop.margin = v / 100; ed.hudDirty = true; ed._dirty('capture'); });
  cs.append(h('div', 'tp-lbl', 'Generation presets'), presetRow, G.steps.el, G.cfg.el, qualRow, G.crop.el, G.margin.el,
    h('div', 'tp-note', 'Steps and CFG leave the painter as the "steps" and "cfg" outputs. The official Klein template hides them inside its sampler group, so they only matter for your own sampler setups. Crop zooms the generator view onto the mask; the bake maps it back exactly.'));

  function syncGen() {
    presetSel.value = st.gen.preset; G.steps.set(st.gen.steps); G.cfg.set(Math.round(st.gen.cfg * 10));
    qualSel.value = String([768, 1024, 1536, 2048].includes(st.capture.long) ? st.capture.long : 1024);
    G.crop.set(st.capture.crop.enabled); G.margin.set(Math.round(st.capture.crop.margin * 100));
  }
  ed._syncPlanUI = () => {
    syncGen();
    W.show.set(st.plan.showCover); W.thr.set(Math.round(st.plan.thr * 100)); W.seam.set(st.plan.seam);
    W.bn.set(st.plan.batchN); W.tg.set(Math.round(st.plan.target * 100)); W.vn.set(st.plan.varN);
    updateHeat(); updateStats();
  };
  const prevApply = ed._applyStateToUI;
  ed._applyStateToUI = () => { prevApply(); ed._syncPlanUI(); };
  ed._syncPlanUI();
}
