// PBR material maps for the working object: normal, height, roughness, metallic, ambient occlusion, specular.
// The maps are plain images (canvases) in UV space. They can be loaded, derived from the colour texture (an approximation, not a
// real material scan), filled with a value inside the painted mask, adjusted, exported - and rendered lit in the 3D view (PBR preview).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { h, makeButton, makeCheck, makeSlider } from './ui.js';

export const PBR_MAPS = [
  { k: 'normal', label: 'Normal map', grey: false, def: 0.5 },
  { k: 'height', label: 'Height map', grey: true, def: 0.5 },
  { k: 'rough', label: 'Roughness map', grey: true, def: 0.6 },
  { k: 'metal', label: 'Metallic map', grey: true, def: 0.0 },
  { k: 'ao', label: 'Ambient occlusion map', grey: true, def: 1.0 },
  { k: 'spec', label: 'Specular map', grey: true, def: 0.5 },
];
export const pbrDefaults = () => ({ on: false, env: 1, exposure: 1, light: 1.5, lightAz: 35, lightEl: 50, normal: 1, flipY: false, bump: 1, aoInt: 1, rough: 1, metal: 1, spec: 1, size: 2048, detail: 24, strength: 2 });
export const pbrMapIds = () => ({ normal: '', height: '', rough: '', metal: '', ao: '', spec: '' });

const hex12 = () => { const b = new Uint8Array(6); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };
const mkCanvas = (w, hh) => { const c = document.createElement('canvas'); c.width = w; c.height = hh; return c; };
const toBlob = (c) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---- image math (typed arrays) -----------------------------------------------------------------
/** separable box blur, 3 passes (~gaussian), edge clamped. a: Float32Array(w*hh) */
export function blur(a, w, hh, r) {
  r = Math.max(0, Math.round(r)); if (!r) return a.slice();
  let src = a.slice(), tmp = new Float32Array(a.length);
  const pass = (s, d, len, stride, count, step) => {
    for (let l = 0; l < count; l++) {
      const base = l * step; let acc = 0;
      for (let i = -r; i <= r; i++) acc += s[base + Math.min(len - 1, Math.max(0, i)) * stride];
      for (let i = 0; i < len; i++) {
        d[base + i * stride] = acc / (2 * r + 1);
        acc += s[base + Math.min(len - 1, i + r + 1) * stride] - s[base + Math.max(0, i - r) * stride];
      }
    }
  };
  for (let k = 0; k < 3; k++) { pass(src, tmp, w, 1, hh, w); pass(tmp, src, hh, w, w, 1); }
  return src;
}
const greyCanvas = (a, w, hh) => { const c = mkCanvas(w, hh), g = c.getContext('2d'), im = g.createImageData(w, hh); for (let i = 0; i < a.length; i++) { const v = Math.round(clamp01(a[i]) * 255); im.data[i * 4] = im.data[i * 4 + 1] = im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255; } g.putImageData(im, 0, 0); return c; };
const lumOf = (c) => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, a = new Float32Array(c.width * c.height); for (let i = 0; i < a.length; i++) a[i] = (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255; return a; };
const greyOf = (c) => lumOf(c);
const scaled = (c, w, hh) => { if (c.width === w && c.height === hh) return c; const o = mkCanvas(w, hh), g = o.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, w, hh); return o; };

/** height (0..1) from colour: local contrast (detail) + a little of the brightness itself */
export function heightFromLum(lum, w, hh, { detail = 24, strength = 2 } = {}) {
  const macro = blur(lum, w, hh, detail), out = new Float32Array(lum.length);
  for (let i = 0; i < out.length; i++) out[i] = clamp01(0.5 + (lum[i] - macro[i]) * strength + (lum[i] - 0.5) * 0.15);
  return out;
}
/** tangent-space normal map (OpenGL / +Y up) from a height field; strength is relative to a 1024 px map */
export function normalFromHeight(ht, w, hh, strength = 2) {
  const c = mkCanvas(w, hh), g = c.getContext('2d'), im = g.createImageData(w, hh), k = strength * (w / 1024) * 4;
  const at = (x, y) => ht[Math.min(hh - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];
  for (let y = 0; y < hh; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * 0.5 * k, dy = (at(x, y + 1) - at(x, y - 1)) * 0.5 * k;   // image y points down
    let nx = -dx, ny = dy, nz = 1; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const o = (y * w + x) * 4; im.data[o] = Math.round((nx * 0.5 + 0.5) * 255); im.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255); im.data[o + 2] = Math.round((nz * 0.5 + 0.5) * 255); im.data[o + 3] = 255;
  }
  g.putImageData(im, 0, 0); return c;
}
export function roughFromLum(lum, ht, base = 0.6) { const o = new Float32Array(lum.length); for (let i = 0; i < o.length; i++) o[i] = clamp01(base + (0.5 - lum[i]) * 0.6 + (0.5 - ht[i]) * 0.25); return o; }
export function aoFromLum(lum, w, hh, radius = 24, gain = 2.5) { const m = blur(lum, w, hh, radius), o = new Float32Array(lum.length); for (let i = 0; i < o.length; i++) o[i] = clamp01(1 - Math.max(0, m[i] - lum[i]) * gain); return o; }

export function installPbr(ed) {
  const st = ed.state, ui = ed.ui;
  ed.pbrCanvas = {}; ed._pbrBlob = {}; ed._pbrBlobP = {}; ed.pbrVersion = 0; ed._pbrUndo = [];

  const bump = () => { ed.pbrVersion++; ed._dirty('pbr'); ed.invalidate(); if (ed._renderPbr) ed._renderPbr(); };
  const setMapCanvas = (k, canvas, { undo = true } = {}) => {
    if (undo) { ed._pbrUndo.push({ k, canvas: ed.pbrCanvas[k] || null, id: st.pbrMaps[k] || '' }); if (ed._pbrUndo.length > 12) ed._pbrUndo.shift(); }
    ed.pbrCanvas[k] = canvas; st.pbrMaps[k] = hex12();
    ed._pbrBlobP[k] = toBlob(canvas).then((b) => { ed._pbrBlob[k] = b; return b; });
    bump();
  };
  ed.pbrSetMap = setMapCanvas;
  ed.pbrRemove = (k) => { if (!ed.pbrCanvas[k]) return; ed._pbrUndo.push({ k, canvas: ed.pbrCanvas[k], id: st.pbrMaps[k] }); delete ed.pbrCanvas[k]; delete ed._pbrBlob[k]; delete ed._pbrBlobP[k]; st.pbrMaps[k] = ''; bump(); };
  ed.pbrUndo = () => {
    const e = ed._pbrUndo.pop(); if (!e) { ed.setStatus('No map change to undo.', 'warn'); return false; }
    if (e.canvas) { ed.pbrCanvas[e.k] = e.canvas; st.pbrMaps[e.k] = hex12(); ed._pbrBlobP[e.k] = toBlob(e.canvas).then((b) => { ed._pbrBlob[e.k] = b; return b; }); }
    else { delete ed.pbrCanvas[e.k]; delete ed._pbrBlob[e.k]; delete ed._pbrBlobP[e.k]; st.pbrMaps[e.k] = ''; }
    bump(); return true;
  };
  ed.pbrReady = async () => { await Promise.all(Object.values(ed._pbrBlobP)); };
  ed.pbrReset = () => { ed.pbrCanvas = {}; ed._pbrBlob = {}; ed._pbrBlobP = {}; ed._pbrUndo = []; Object.assign(st.pbrMaps, pbrMapIds()); ed.pbrVersion++; if (ed._renderPbr) ed._renderPbr(); ed.invalidate(); };

  // ---- persistence helpers (current object: autosave / restore; other objects: stash / load) ------------
  const fname = (k, id) => `P_${id}_${k}.png`;
  ed.pbrFiles = () => PBR_MAPS.filter((m) => st.pbrMaps[m.k] && ed._pbrBlob[m.k]).map((m) => ({ name: fname(m.k, st.pbrMaps[m.k]), blob: ed._pbrBlob[m.k] }));
  ed.pbrStash = async () => { await ed.pbrReady(); const ids = { ...st.pbrMaps }, files = new Map(); for (const f of ed.pbrFiles()) files.set(f.name, f.blob); return { ids, files }; };
  ed.pbrLoadFrom = async (ids, get) => {
    ed.pbrReset(); if (!ids) return;
    for (const m of PBR_MAPS) {
      const id = ids[m.k]; if (!id) continue;
      const bmp = await get(fname(m.k, id)); if (!bmp) continue;
      const c = mkCanvas(bmp.width, bmp.height); c.getContext('2d').drawImage(bmp, 0, 0); bmp.close && bmp.close();
      ed.pbrCanvas[m.k] = c; st.pbrMaps[m.k] = id; ed._pbrBlobP[m.k] = toBlob(c).then((b) => { ed._pbrBlob[m.k] = b; return b; });
    }
    ed.pbrVersion++; if (ed._renderPbr) ed._renderPbr(); ed.invalidate();
  };

  // ---- creating maps ----------------------------------------------------------------------------------
  const mapDims = () => { const s = st.pbr.size, L = ed.layers, a = L.w / L.h; return a >= 1 ? [s, Math.max(16, Math.round(s / a))] : [Math.max(16, Math.round(s * a)), s]; };
  const albedo = (w, hh) => scaled(ed.layers.bakeCanvas(0), w, hh);
  const heightArr = (w, hh) => { if (ed.pbrCanvas.height) return greyOf(scaled(ed.pbrCanvas.height, w, hh)); return heightFromLum(lumOf(albedo(w, hh)), w, hh, st.pbr); };
  ed.pbrDerive = (k) => {
    if (!ed.hasModel) { ed.setStatus('Load a model first.', 'warn'); return false; }
    const [w, hh] = mapDims(), P = st.pbr, lum = lumOf(albedo(w, hh));
    let c;
    if (k === 'height') c = greyCanvas(heightFromLum(lum, w, hh, P), w, hh);
    else if (k === 'normal') c = normalFromHeight(heightArr(w, hh), w, hh, P.strength);
    else if (k === 'rough') c = greyCanvas(roughFromLum(lum, heightArr(w, hh)), w, hh);
    else if (k === 'ao') c = greyCanvas(aoFromLum(lum, w, hh, P.detail), w, hh);
    else if (k === 'metal') c = greyCanvas(new Float32Array(w * hh), w, hh);
    else c = greyCanvas(new Float32Array(w * hh).fill(0.5), w, hh);                         // specular: neutral
    setMapCanvas(k, c); ed.log('ok', `${PBR_MAPS.find((m) => m.k === k).label} derived from the colour texture (${w}x${hh}).`); return true;
  };
  const flatCanvas = (k, w, hh) => { const m = PBR_MAPS.find((x) => x.k === k), c = mkCanvas(w, hh), g = c.getContext('2d'); g.fillStyle = k === 'normal' ? 'rgb(128,128,255)' : `rgb(${Math.round(m.def * 255)},${Math.round(m.def * 255)},${Math.round(m.def * 255)})`; g.fillRect(0, 0, w, hh); return c; };
  ed.pbrFill = (k, value) => { const [w, hh] = mapDims(), c = mkCanvas(w, hh), g = c.getContext('2d'), v = Math.round(clamp01(value) * 255); g.fillStyle = `rgb(${v},${v},${v})`; g.fillRect(0, 0, w, hh); setMapCanvas(k, c); return true; };
  /** value (grey maps) or a flat normal inside the painted AI mask; the mask is soft, so the blend is soft */
  ed.pbrFillMasked = (k, value) => {
    if (ed.maskIsEmpty()) { ed.setStatus('Paint a mask first - the value is applied inside it.', 'warn'); return false; }
    const base = ed.pbrCanvas[k] || flatCanvas(k, ...mapDims()), w = base.width, hh = base.height;
    const out = mkCanvas(w, hh), g = out.getContext('2d'); g.drawImage(base, 0, 0);
    const S = ed.maskSize, mp = ed._readMaskPixels(), mc = mkCanvas(S, S), mim = mc.getContext('2d').createImageData(S, S);
    const v = Math.round(clamp01(value) * 255), tgt = k === 'normal' ? [128, 128, 255] : [v, v, v];
    for (let i = 0; i < S * S; i++) { mim.data[i * 4] = tgt[0]; mim.data[i * 4 + 1] = tgt[1]; mim.data[i * 4 + 2] = tgt[2]; mim.data[i * 4 + 3] = Math.min(255, mp[i * 4]); }
    mc.getContext('2d').putImageData(mim, 0, 0);
    // the mask is stored with v up, the canvases with y down: flip while drawing
    g.save(); g.translate(0, hh); g.scale(1, -1); g.imageSmoothingQuality = 'high'; g.drawImage(mc, 0, 0, w, hh); g.restore();
    setMapCanvas(k, out); return true;
  };
  ed.pbrAdjust = (k, { invert = false, brightness = 0, contrast = 1 } = {}) => {
    const src = ed.pbrCanvas[k]; if (!src) return false;
    const c = mkCanvas(src.width, src.height), g = c.getContext('2d'); g.drawImage(src, 0, 0);
    const im = g.getImageData(0, 0, c.width, c.height), d = im.data, ch = k === 'normal' ? [0, 1] : [0, 1, 2];
    for (let i = 0; i < d.length; i += 4) for (const j of ch) { let v = d[i + j] / 255; if (invert) v = 1 - v; v = (v - 0.5) * contrast + 0.5 + brightness; d[i + j] = Math.round(clamp01(v) * 255); }
    g.putImageData(im, 0, 0); setMapCanvas(k, c); return true;
  };
  ed.pbrFlipGreen = () => {
    const src = ed.pbrCanvas.normal; if (!src) return false;
    const c = mkCanvas(src.width, src.height), g = c.getContext('2d'); g.drawImage(src, 0, 0);
    const im = g.getImageData(0, 0, c.width, c.height); for (let i = 0; i < im.data.length; i += 4) im.data[i + 1] = 255 - im.data[i + 1];
    g.putImageData(im, 0, 0); setMapCanvas('normal', c); return true;
  };
  const bitmapCanvas = (bmp) => { const k = Math.min(1, 4096 / Math.max(bmp.width, bmp.height)), c = mkCanvas(Math.max(8, Math.round(bmp.width * k)), Math.max(8, Math.round(bmp.height * k))); c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height); return c; };
  ed.pbrLoadFile = async (k, file) => {
    const bmp = await createImageBitmap(file), c = bitmapCanvas(bmp); bmp.close && bmp.close();
    if (k === 'normal') setMapCanvas(k, c);
    else { const a = greyOf(c); setMapCanvas(k, greyCanvas(a, c.width, c.height)); }
    ed.log('ok', `${PBR_MAPS.find((m) => m.k === k).label} loaded (${c.width}x${c.height}).`);
  };
  /** one packed image: R = ambient occlusion, G = roughness, B = metallic (glTF / Unreal "ORM") */
  ed.pbrLoadPacked = async (file) => {
    const bmp = await createImageBitmap(file), c = bitmapCanvas(bmp); bmp.close && bmp.close();
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data, n = c.width * c.height, ao = new Float32Array(n), ro = new Float32Array(n), me = new Float32Array(n);
    for (let i = 0; i < n; i++) { ao[i] = d[i * 4] / 255; ro[i] = d[i * 4 + 1] / 255; me[i] = d[i * 4 + 2] / 255; }
    setMapCanvas('ao', greyCanvas(ao, c.width, c.height)); setMapCanvas('rough', greyCanvas(ro, c.width, c.height)); setMapCanvas('metal', greyCanvas(me, c.width, c.height));
    ed.log('ok', `Packed map split into occlusion / roughness / metallic (${c.width}x${c.height}).`);
  };
  ed.pbrExportFiles = async (stem) => {
    await ed.pbrReady(); const out = [];
    for (const m of PBR_MAPS) if (ed._pbrBlob[m.k]) out.push({ name: `${stem}_${m.k === 'rough' ? 'roughness' : m.k === 'metal' ? 'metallic' : m.k === 'spec' ? 'specular' : m.k}.png`, data: new Uint8Array(await ed._pbrBlob[m.k].arrayBuffer()) });
    return out;
  };

  // ---- textures / material for GLB export ------------------------------------------------------------
  const tex = (c, srgb = false) => { const t = new THREE.CanvasTexture(c); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4; t.needsUpdate = true; return t; };
  const specTex = (c) => { const g = c.getContext('2d').getImageData(0, 0, c.width, c.height), d = new Uint8Array(c.width * c.height * 4); for (let i = 0; i < c.width * c.height; i++) { d[i * 4] = d[i * 4 + 1] = d[i * 4 + 2] = 255; d[i * 4 + 3] = g.data[i * 4]; } const t = new THREE.DataTexture(d, c.width, c.height, THREE.RGBAFormat); t.flipY = true; t.needsUpdate = true; t.wrapS = t.wrapT = THREE.RepeatWrapping; return t; };
  /** puts the maps on a material; flip = false for glTF export (v down). Returns textures to dispose. */
  ed.pbrApplyToMaterial = (mat, { flipY = true, forExport = false } = {}) => {
    const made = [], P = st.pbr, C = ed.pbrCanvas;
    const put = (prop, c, f = tex) => { const t = f(c); t.flipY = flipY; mat[prop] = t; made.push(t); };
    if (C.normal) { put('normalMap', C.normal); mat.normalScale = forExport ? new THREE.Vector2(1, 1) : new THREE.Vector2(P.normal, (P.flipY ? -1 : 1) * P.normal); }
    if (C.rough) { put('roughnessMap', C.rough); mat.roughness = forExport ? 1 : P.rough; }
    if (C.metal) { put('metalnessMap', C.metal); mat.metalness = forExport ? 1 : P.metal; }
    if (C.ao) { put('aoMap', C.ao); mat.aoMapIntensity = P.aoInt; }
    if (C.height && !forExport) { put('bumpMap', C.height); mat.bumpScale = P.bump * 2; }
    if (C.spec && mat.isMeshPhysicalMaterial) { const t = specTex(C.spec); t.flipY = flipY; mat.specularIntensityMap = t; mat.specularIntensity = forExport ? 1 : P.spec; made.push(t); }
    mat.needsUpdate = true; return made;
  };
  ed.pbrHasAny = () => PBR_MAPS.some((m) => ed.pbrCanvas[m.k]);

  // ---- viewport -------------------------------------------------------------------------------------------
  let scene = null, mesh = null, mat = null, light = null, env = null, albedoTex = null, albedoV = -1, mapV = -1, madeTex = [], lastAlb = 0, pm = null;
  const ensure = () => {
    if (scene) return;
    scene = new THREE.Scene();
    pm = new THREE.PMREMGenerator(ed.renderer);
    env = pm.fromScene(new RoomEnvironment(), 0.04).texture; scene.environment = env;
    light = new THREE.DirectionalLight(0xffffff, 1.5); scene.add(light, light.target);
    mat = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.8, metalness: 0, side: THREE.DoubleSide });
    mesh = new THREE.Mesh(ed.geometry, mat); mesh.frustumCulled = false; scene.add(mesh);
  };
  const refreshMaps = () => {
    for (const t of madeTex) t.dispose(); madeTex = [];
    for (const p of ['normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'bumpMap', 'specularIntensityMap']) mat[p] = null;
    mat.roughness = 0.8; mat.metalness = 0; mat.specularIntensity = 1; mat.bumpScale = 0; mat.aoMapIntensity = 1; mat.normalScale.set(1, 1);
    madeTex = ed.pbrApplyToMaterial(mat, { flipY: true });
    mapV = ed.pbrVersion;
  };
  ed._pbrActive = () => !!(st.pbr.on && ed.hasModel && ed.geometry);
  ed._pbrRender = (camera) => {
    ensure();
    if (mesh.geometry !== ed.geometry) mesh.geometry = ed.geometry;
    const now = performance.now();
    if (albedoV !== ed.textureVersion && (now - lastAlb > 150 || !albedoTex)) {   // the colour texture changed: re-read the composite (throttled)
      const old = albedoTex; albedoTex = tex(ed.layers.bakeCanvas(0), true); mat.map = albedoTex; mat.needsUpdate = true; if (old) old.dispose();
      albedoV = ed.textureVersion; lastAlb = now;
    }
    if (mapV !== ed.pbrVersion) refreshMaps();
    const P = st.pbr, az = (P.lightAz * Math.PI) / 180, el = (P.lightEl * Math.PI) / 180;
    light.position.set(Math.sin(az) * Math.cos(el) * 5, Math.sin(el) * 5, Math.cos(az) * Math.cos(el) * 5); light.intensity = P.light;
    mat.envMapIntensity = P.env;
    if (ed.pbrCanvas.rough) mat.roughness = P.rough; if (ed.pbrCanvas.metal) mat.metalness = P.metal; if (ed.pbrCanvas.normal) { mat.normalScale.set(P.normal, (P.flipY ? -1 : 1) * P.normal); }
    if (ed.pbrCanvas.ao) mat.aoMapIntensity = P.aoInt; if (ed.pbrCanvas.height) mat.bumpScale = P.bump * 2; if (ed.pbrCanvas.spec) mat.specularIntensity = P.spec;
    const r = ed.renderer, tm = r.toneMapping, ex = r.toneMappingExposure;
    r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = P.exposure;
    r.render(scene, camera);
    r.toneMapping = tm; r.toneMappingExposure = ex;
  };

  installPbrPanel(ed);
}

import { makeZip, modelStem } from './export.js';

function installPbrPanel(ed) {
  const st = ed.state, body = ed.ui.sec.pbr.body;
  const set = (key) => (v) => { st.pbr[key] = v; ed.invalidate(); ed._dirty('settings'); };
  const sl = (label, key, min, max, step, scale = 1, fmt = (v) => v.toFixed(2)) => { const w = makeSlider(label, { min, max, step, value: st.pbr[key] * scale, fmt }, (v) => set(key)(v / scale)); w.key = key; w.scale = scale; return w; };
  const W = {};
  W.on = makeCheck('PBR preview in the 3D view (lit, all maps)', st.pbr.on, (v) => { st.pbr.on = v; ed.hudDirty = true; ed.invalidate(); ed._dirty('settings'); });
  const sizeSel = h('select'); for (const v of [512, 1024, 2048, 4096]) { const o = h('option', null, v + ' px'); o.value = v; sizeSel.append(o); }
  sizeSel.value = String(st.pbr.size); sizeSel.onchange = () => { st.pbr.size = +sizeSel.value; ed._dirty('settings'); };
  const sizeRow = h('div', 'tp-row'); sizeRow.append(h('span', 'tp-lbl', 'Size of new maps'), sizeSel, h('span'));
  W.detail = sl('Detail size (derive)', 'detail', 2, 96, 1, 1, (v) => v + ' px');
  W.strength = sl('Strength (derive)', 'strength', 2, 80, 1, 10, (v) => (v / 10).toFixed(1));
  body.append(W.on.el, sizeRow, W.detail.el, W.strength.el);

  const blocks = {};
  for (const m of PBR_MAPS) {
    const box = h('div'); box.style.cssText = 'border-top:1px solid #2c3039;padding:4px 0;margin-top:4px';
    const title = h('div', 'tp-lbl', m.label), status = h('span'); status.style.cssText = 'margin-left:8px;opacity:.7;font-weight:400'; title.append(status);
    const file = h('input'); file.type = 'file'; file.accept = 'image/*'; file.style.display = 'none';
    const bLoad = makeButton('Load...'), bDer = makeButton('From colour', 'Derive this map from the colour texture (an approximation, not a material scan)'), bRm = makeButton('Remove');
    bLoad.onclick = () => file.click(); file.onchange = async () => { const f = file.files[0]; file.value = ''; if (f) try { await ed.pbrLoadFile(m.k, f); } catch (e) { ed.log('error', 'Could not load the map', e); ed.setStatus(e.message, 'err'); } };
    bDer.onclick = () => ed.pbrDerive(m.k); bRm.onclick = () => ed.pbrRemove(m.k);
    const r1 = h('div', 'tp-row2'); r1.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin:2px 0'; r1.append(bLoad, bDer, bRm, file);
    box.append(title, r1);
    const b = { status, bRm };
    if (m.k === 'normal') {
      const bFlat = makeButton('Flatten painted area', 'Flat normals inside the painted AI mask'), bFlip = makeButton('Flip green (convert)', 'Convert between OpenGL (Y+) and DirectX (Y-) normal maps');
      bFlat.onclick = () => ed.pbrFillMasked('normal', 0); bFlip.onclick = () => { if (!ed.pbrFlipGreen()) ed.setStatus('No normal map.', 'warn'); };
      const r2 = h('div', 'tp-row2'); r2.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin:2px 0'; r2.append(bFlat, bFlip); box.append(r2);
    } else {
      const val = makeSlider('Value', { min: 0, max: 100, step: 1, value: Math.round(m.def * 100), fmt: (v) => (v / 100).toFixed(2) }, () => {});
      const bFill = makeButton('Fill all', 'Fill the whole map with the value'), bMask = makeButton('Fill painted area', 'Apply the value inside the painted AI mask (soft edge)'), bInv = makeButton('Invert');
      const v01 = () => { const t = val.el.querySelector('input.tp-val'); return Math.min(1, Math.max(0, (parseFloat(String(t.value).replace(',', '.')) || 0))); };
      bFill.onclick = () => ed.pbrFill(m.k, v01()); bMask.onclick = () => ed.pbrFillMasked(m.k, v01()); bInv.onclick = () => { if (!ed.pbrAdjust(m.k, { invert: true })) ed.setStatus('No map to invert.', 'warn'); };
      const r2 = h('div', 'tp-row2'); r2.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin:2px 0'; r2.append(bFill, bMask, bInv);
      box.append(val.el, r2);
    }
    body.append(box); blocks[m.k] = b;
  }
  const packFile = h('input'); packFile.type = 'file'; packFile.accept = 'image/*'; packFile.style.display = 'none';
  const bPack = makeButton('Load packed ORM...', 'One image with R = occlusion, G = roughness, B = metallic'), bAll = makeButton('Derive all missing'), bUndo = makeButton('Undo map change'), bZip = makeButton('Download maps (zip)');
  bPack.onclick = () => packFile.click(); packFile.onchange = async () => { const f = packFile.files[0]; packFile.value = ''; if (f) try { await ed.pbrLoadPacked(f); } catch (e) { ed.log('error', 'Could not load the packed map', e); } };
  bAll.onclick = () => { for (const m of PBR_MAPS) if (!ed.pbrCanvas[m.k]) ed.pbrDerive(m.k); };
  bUndo.onclick = () => ed.pbrUndo();
  bZip.onclick = async () => { const files = await ed.pbrExportFiles(modelStem(ed)); if (!files.length) { ed.setStatus('No maps to download yet.', 'warn'); return; } const a = document.createElement('a'); a.href = URL.createObjectURL(makeZip(files)); a.download = modelStem(ed) + '_pbr_maps.zip'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  const rb = h('div', 'tp-row2'); rb.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin:6px 0'; rb.append(bPack, bAll, bUndo, bZip, packFile); body.append(rb);

  const vb = h('div'); vb.style.cssText = 'border-top:1px solid #2c3039;padding-top:4px;margin-top:4px'; vb.append(h('div', 'tp-lbl', 'Preview lighting & strengths'));
  W.env = sl('Environment light', 'env', 0, 300, 5, 100, (v) => (v / 100).toFixed(2)); W.light = sl('Sun intensity', 'light', 0, 600, 10, 100, (v) => (v / 100).toFixed(1));
  W.az = sl('Sun direction', 'lightAz', -180, 180, 1, 1, (v) => v + '\u00B0'); W.el = sl('Sun height', 'lightEl', 0, 90, 1, 1, (v) => v + '\u00B0'); W.exp = sl('Exposure', 'exposure', 20, 300, 5, 100, (v) => (v / 100).toFixed(2));
  W.nrm = sl('Normal strength', 'normal', 0, 300, 5, 100, (v) => (v / 100).toFixed(2)); W.bump = sl('Height (bump) strength', 'bump', 0, 500, 5, 100, (v) => (v / 100).toFixed(2));
  W.ao = sl('Occlusion strength', 'aoInt', 0, 200, 5, 100, (v) => (v / 100).toFixed(2)); W.ro = sl('Roughness multiplier', 'rough', 0, 200, 5, 100, (v) => (v / 100).toFixed(2));
  W.me = sl('Metallic multiplier', 'metal', 0, 100, 5, 100, (v) => (v / 100).toFixed(2)); W.sp = sl('Specular multiplier', 'spec', 0, 200, 5, 100, (v) => (v / 100).toFixed(2));
  W.flip = makeCheck('Normal map is DirectX style (flip green) - preview only', st.pbr.flipY, (v) => { st.pbr.flipY = v; ed.invalidate(); ed._dirty('settings'); });
  vb.append(W.env.el, W.light.el, W.az.el, W.el.el, W.exp.el, W.nrm.el, W.bump.el, W.ao.el, W.ro.el, W.me.el, W.sp.el, W.flip.el);
  body.append(vb, h('div', 'tp-note', 'The maps belong to the working object (each object of a multi-object model has its own set) and are saved with the project and autosave. "From colour" derives an approximation from the colour texture (local contrast -> height, height -> normal, dark -> rough, cavities -> occlusion); for real material values load maps or paint a mask and use "Fill painted area" (e.g. metallic 1.0 on the metal parts). GLB export carries normal / roughness / metallic / occlusion (and specular); OBJ zip and the maps zip carry every map as PNG. The AI cannot generate these maps yet.'));

  const refresh = () => {
    for (const m of PBR_MAPS) { const c = ed.pbrCanvas[m.k], b = blocks[m.k]; b.status.textContent = c ? `\u2713 ${c.width}x${c.height}` : '- none'; b.bRm.disabled = !c; }
    W.on.set(st.pbr.on); W.flip.set(st.pbr.flipY); sizeSel.value = String(st.pbr.size);
    for (const w of [W.detail, W.strength, W.env, W.light, W.az, W.el, W.exp, W.nrm, W.bump, W.ao, W.ro, W.me, W.sp]) w.set(Math.round(st.pbr[w.key] * w.scale));
  };
  ed._renderPbr = refresh;
  const prev = ed._applyStateToUI; ed._applyStateToUI = () => { if (prev) prev(); refresh(); };
  refresh();
}
