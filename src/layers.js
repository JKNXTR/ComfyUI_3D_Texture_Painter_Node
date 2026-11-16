// Layer stack: GPU compositing with blend modes, opacity and per-layer masks.
//
// Storage rules (they make undo cheap and safe):
//  - a layer's pixel render target is IMMUTABLE once created (pixel-changing operations such as merge,
//    flatten or "replace active" always create a NEW target),
//  - a layer mask is copy-on-write: before a brush stroke the active layer gets its own fresh copy,
//  - undo states are lists of layer descriptors that only reference those targets; a target is disposed
//    by gc() when neither the current stack nor any undo / redo state references it any more.
import * as THREE from 'three';
import * as SH from './shaders.js';

export const BLEND_MODES = [
  ['normal', 'Normal'], ['multiply', 'Multiply'], ['screen', 'Screen'], ['overlay', 'Overlay'],
  ['softlight', 'Soft Light'], ['hardlight', 'Hard Light'], ['darken', 'Darken'], ['lighten', 'Lighten'],
  ['dodge', 'Color Dodge'], ['burn', 'Color Burn'], ['add', 'Add'], ['difference', 'Difference'],
  ['hue', 'Hue'], ['color', 'Color'], ['luminosity', 'Luminosity'],
];
const modeIndex = (id) => Math.max(0, BLEND_MODES.findIndex((m) => m[0] === id));

let counter = 0;
const newUid = () => {
  const b = new Uint8Array(5);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < 5; i++) b[i] = Math.floor(Math.random() * 256);
  counter++;
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
const hexRaw = (hex) => {
  const c = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = c ? parseInt(c[1], 16) : 0x808080;
  return new THREE.Vector3(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

export const adjDefaults = () => ({ bri: 0, con: 0, sat: 0, hue: 0, lb: 0, lw: 1, gam: 1 });
export const adjActive = (a) => !!a && (Math.abs(a.bri || 0) > 1e-4 || Math.abs(a.con || 0) > 1e-4 || Math.abs(a.sat || 0) > 1e-4 || Math.abs(a.hue || 0) > 1e-3 || Math.abs(a.lb || 0) > 1e-4 || Math.abs((a.lw === undefined ? 1 : a.lw) - 1) > 1e-4 || Math.abs((a.gam === undefined ? 1 : a.gam) - 1) > 1e-4);
export class LayerStack {
  constructor(ed) {
    this.ed = ed;
    this.layers = []; // bottom -> top
    this.active = -1;
    this.w = 0;
    this.h = 0;
    this.registry = new Set(); // every pixel / mask render target owned by layers
    this.thumbs = new Map(); // key -> canvas
    this.maxLayers = 24;
    const r = ed.renderer;
    this.hdr = r.extensions.has('EXT_color_buffer_float') || r.extensions.has('EXT_color_buffer_half_float');
    const pass = (frag, uniforms) => new THREE.ShaderMaterial({
      vertexShader: SH.FULLSCREEN_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, blending: THREE.NoBlending, uniforms,
    });
    this.blendMat = pass(SH.BLEND_FRAG, {
      tDst: { value: null }, tSrc: { value: null }, tMask: { value: null }, uHasMask: { value: 0 }, uOpacity: { value: 1 }, uMode: { value: 0 },
      uAdjOn: { value: 0 }, uAdj: { value: new THREE.Vector4() }, uLev: { value: new THREE.Vector3(0, 1, 1) },
    });
    this.flatMat = pass(SH.FLATTEN_FRAG, { tSrc: { value: null }, uBg: { value: new THREE.Vector3(0.5, 0.5, 0.5) } });
    this.prepMat = pass(SH.PREP_FRAG, { tSrc: { value: null }, tCov: { value: null } });
    this.dilateMat = pass(SH.DILATE_FRAG, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.coverMat = new THREE.ShaderMaterial({ vertexShader: SH.COVER_VERT, fragmentShader: SH.COVER_FRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false });
    this.A = this.B = this.comp = this.cap = null;
  }

  // ---------------------------------------------------------------------------------------
  // render targets
  // ---------------------------------------------------------------------------------------
  _rt(w, h, kind, { nearest = false, mips = false } = {}) {
    const o = {
      depthBuffer: false, stencilBuffer: false, generateMipmaps: mips,
      minFilter: nearest ? THREE.NearestFilter : (mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter),
      magFilter: nearest ? THREE.NearestFilter : THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    };
    if (kind === 'r8') { o.format = THREE.RedFormat; o.type = THREE.UnsignedByteType; }
    else if (kind === 'half') { o.format = THREE.RGBAFormat; o.type = this.hdr ? THREE.HalfFloatType : THREE.UnsignedByteType; }
    else { o.format = THREE.RGBAFormat; o.type = THREE.UnsignedByteType; }
    const rt = new THREE.WebGLRenderTarget(w, h, o);
    rt.texture.colorSpace = THREE.NoColorSpace;
    if (mips) rt.texture.anisotropy = this.ed.maxAniso || 1;
    return rt;
  }

  /** the layer's pixels with its colour adjustment applied: a temporary target (call .dispose()), or null when the layer has no adjustment */
  adjustedRT(l) {
    if (!(l && l.adj && adjActive(l.adj))) return null;
    const out = this._rt(this.w, this.h, 'rgba8'); this.ed._clearRTA(out, 0, 0);
    this._run([{ pix: l.pix, mask: null, opacity: 1, blend: 'normal', adj: l.adj }], out, null);
    return out;
  }

  newPix() {
    const rt = this._rt(this.w, this.h, 'rgba8');
    rt.uid = newUid();
    this.registry.add(rt);
    this.ed._clearRTA(rt, 0, 0);
    return rt;
  }

  newMask() {
    const S = this.ed.maskSize;
    const rt = this._rt(S, S, 'r8');
    rt.uid = newUid();
    this.registry.add(rt);
    return rt;
  }

  _ensure() {
    const need = !this.A || this.A.width !== this.w || this.A.height !== this.h;
    if (!need) return false;
    for (const k of ['A', 'B', 'comp', 'cap']) if (this[k]) this[k].dispose();
    this.A = this._rt(this.w, this.h, 'half');
    this.B = this._rt(this.w, this.h, 'half');
    this.comp = this._rt(this.w, this.h, 'half', { mips: true });
    this.cap = this._rt(this.w, this.h, 'half', { mips: true });
    return true;
  }

  // ---------------------------------------------------------------------------------------
  // snapshots / garbage collection
  // ---------------------------------------------------------------------------------------
  snap() {
    return { w: this.w, h: this.h, active: this.active, layers: this.layers.map((l) => ({ ...l })) };
  }

  restore(s) {
    this.w = s.w; this.h = s.h;
    this.layers = s.layers.map((l) => ({ ...l }));
    this.active = Math.min(Math.max(s.active, this.layers.length ? 0 : -1), this.layers.length - 1);
  }

  gc() {
    const keep = new Set();
    const add = (sn) => sn.layers.forEach((l) => { keep.add(l.pix); if (l.origPix) keep.add(l.origPix); if (l.mask) keep.add(l.mask); });
    add({ layers: this.layers });
    for (const e of this.ed.undoStack.concat(this.ed.redoStack)) if (e.k === 'lay') add(e.snap);
    if (this.ed.pending && this.ed.pending.pix) keep.add(this.ed.pending.pix);
    for (const rt of Array.from(this.registry)) {
      if (!keep.has(rt)) { rt.dispose(); this.registry.delete(rt); }
    }
    const live = new Set(Array.from(keep, (r) => r.uid));
    for (const k of Array.from(this.thumbs.keys())) if (!live.has(k.split(':')[0])) this.thumbs.delete(k);
  }

  get activeLayer() { return this.layers[this.active] || null; }

  /** true while the stack is still the untouched blank base texture (a loaded texture then replaces it). */
  isPristine() { return this.layers.length === 1 && !!this.layers[0].blank && !this.layers[0].mask; }

  // ---------------------------------------------------------------------------------------
  // image <-> render target
  // ---------------------------------------------------------------------------------------
  _drawInto(img, rt, mat) {
    const tex = img.isTexture ? img : new THREE.CanvasTexture(img);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    mat.uniforms.tSrc.value = tex;
    this.ed._pass(mat, rt);
    if (!img.isTexture) tex.dispose();
  }

  /** Any canvas / bitmap -> new RGBA layer target (stretched to the stack size). */
  fromImage(img) {
    let src = img;
    if (!(img instanceof HTMLCanvasElement)) {
      src = document.createElement('canvas');
      src.width = img.width || img.naturalWidth; src.height = img.height || img.naturalHeight;
      src.getContext('2d').drawImage(img, 0, 0);
    }
    const rt = this.newPix();
    this._drawInto(src, rt, this.ed.copyMat);
    return rt;
  }

  maskFromImage(img) {
    let src = img;
    if (!(img instanceof HTMLCanvasElement)) {
      src = document.createElement('canvas');
      src.width = img.width; src.height = img.height;
      src.getContext('2d').drawImage(img, 0, 0);
    }
    const rt = this.newMask();
    this._drawInto(src, rt, this.ed.copyMat);
    return rt;
  }

  /** RGBA8 / half / r8 target -> canvas (top row first). */
  toCanvas(rt, grey = false) {
    const ed = this.ed;
    const tmp = this._rt(rt.width, rt.height, 'rgba8', { nearest: true });
    const m = grey ? ed.copyGreyMat : ed.copyMat;
    m.uniforms.tSrc.value = rt.texture;
    ed._pass(m, tmp);
    const buf = new Uint8Array(rt.width * rt.height * 4);
    ed.renderer.readRenderTargetPixels(tmp, 0, 0, rt.width, rt.height, buf);
    tmp.dispose();
    return ed._pixelsToCanvas(buf, rt.width, rt.height);
  }

  toBlob(rt, grey = false) { return this.ed._canvasToBlob(this.toCanvas(rt, grey)); }

  // ---------------------------------------------------------------------------------------
  // compositing
  // ---------------------------------------------------------------------------------------
  _run(list, out, bg) {
    const ed = this.ed, r = ed.renderer;
    this._ensure();
    let cur = this.A, nxt = this.B;
    ed._clearRTA(cur, 0, 0);
    const u = this.blendMat.uniforms;
    for (const L of list) {
      u.tDst.value = cur.texture;
      u.tSrc.value = L.pix.texture;
      u.uHasMask.value = L.mask ? 1 : 0;
      u.tMask.value = L.mask ? L.mask.texture : L.pix.texture;
      u.uOpacity.value = L.opacity === undefined ? 1 : L.opacity;
      u.uMode.value = modeIndex(L.blend || 'normal');
      const A = L.adj && adjActive(L.adj) ? L.adj : null;
      u.uAdjOn.value = A ? 1 : 0;
      if (A) { u.uAdj.value.set(A.bri || 0, A.con || 0, A.sat || 0, ((A.hue || 0) * Math.PI) / 180); u.uLev.value.set(A.lb || 0, A.lw === undefined ? 1 : A.lw, A.gam === undefined ? 1 : A.gam); }
      ed._pass(this.blendMat, nxt);
      const t = cur; cur = nxt; nxt = t;
    }
    if (bg) {
      this.flatMat.uniforms.tSrc.value = cur.texture;
      this.flatMat.uniforms.uBg.value.copy(hexRaw(bg));
      ed._pass(this.flatMat, out);
    } else {
      ed.copyMat.uniforms.tSrc.value = cur.texture;
      ed._pass(ed.copyMat, out);
    }
    void r;
  }

  _visible() { return this.layers.filter((l) => l.visible); }

  /** What the 3D / UV views show. `preview` = pending AI result inserted above the active layer. */
  composeDisplay(preview) {
    if (!this.layers.length && !preview) return;
    const realloc = this._ensure();
    let list = this._visible();
    if (preview) {
      const act = this.activeLayer;
      const at = act && act.visible ? list.indexOf(act) + 1 : list.length;
      list = list.slice(0, at).concat([{ pix: preview.pix, mask: null, opacity: 1, blend: 'normal' }], list.slice(at));
    }
    this._run(list, this.comp, this.ed.state.layers.bg);
    if (realloc) this.ed._bindTexture();
  }

  /** What is captured / sent to the generator: 'composite' | 'below' | 'active'. */
  composeCapture(mode) {
    const realloc = this._ensure();
    let list;
    if (mode === 'active') list = this.activeLayer ? [{ ...this.activeLayer, visible: true }] : [];
    else if (mode === 'below') list = this.layers.filter((l, i) => l.visible && i < this.active);
    else list = this._visible();
    this._run(list, this.cap, this.ed.state.layers.bg);
    if (realloc) this.ed._bindTexture();
  }

  /** Final texture as a canvas, composited over the background colour, with optional seam padding. */
  bakeCanvas(padding = 0, mode = 'composite') {
    const ed = this.ed;
    this._ensure();
    const w = this.w, h = this.h;
    let list;
    if (mode === 'active') list = this.activeLayer ? [{ ...this.activeLayer, visible: true }] : [];
    else list = this._visible();
    let colorRT = this._rt(w, h, 'rgba8', { nearest: true });
    this._run(list, colorRT, ed.state.layers.bg);
    let result = colorRT;
    const temps = [colorRT];
    if (padding > 0 && ed.coverScene && ed.hasModel) {
      const cov = this._rt(w, h, 'rgba8', { nearest: true });
      temps.push(cov);
      const r = ed.renderer;
      const prevT = r.getRenderTarget(), prevS = r.getScissorTest();
      r.setRenderTarget(cov); r.setScissorTest(false);
      r.setClearColor(0x000000, 0); r.clear(true, false, false);
      r.render(ed.coverScene, ed.quadCam);
      r.setRenderTarget(prevT); r.setScissorTest(prevS);
      let a = this._rt(w, h, 'rgba8', { nearest: true }), b = this._rt(w, h, 'rgba8', { nearest: true });
      temps.push(a, b);
      this.prepMat.uniforms.tSrc.value = colorRT.texture;
      this.prepMat.uniforms.tCov.value = cov.texture;
      ed._pass(this.prepMat, a);
      this.dilateMat.uniforms.uTexel.value.set(1 / w, 1 / h);
      for (let i = 0; i < Math.min(64, padding); i++) {
        this.dilateMat.uniforms.tSrc.value = a.texture;
        ed._pass(this.dilateMat, b);
        const t = a; a = b; b = t;
      }
      const fin = this._rt(w, h, 'rgba8', { nearest: true });
      temps.push(fin);
      this.flatMat.uniforms.tSrc.value = a.texture;
      this.flatMat.uniforms.uBg.value.copy(hexRaw(ed.state.layers.bg));
      ed._pass(this.flatMat, fin);
      result = fin;
    }
    const canvas = this.toCanvas(result);
    temps.forEach((t) => t.dispose());
    return canvas;
  }

  /** What the stack shows right now (visible layers, straight alpha, no background colour) as a canvas. */
  compositeCanvas() {
    this._ensure();
    const rt = this._rt(this.w, this.h, 'rgba8', { nearest: true });
    this._run(this._visible(), rt, null);
    const c = this.toCanvas(rt);
    rt.dispose();
    return c;
  }

  /** Layer mask as w*h bytes (0..255) at the STACK size (masks keep their own size, so this resamples), or null when the layer has none. */
  maskBytes(l) {
    if (!l || !l.mask) return null;
    const src = this.toCanvas(l.mask, true);
    let c = src;
    if (src.width !== this.w || src.height !== this.h) {
      c = document.createElement('canvas'); c.width = this.w; c.height = this.h;
      const g = c.getContext('2d'); g.imageSmoothingEnabled = true; g.drawImage(src, 0, 0, this.w, this.h);
    }
    const d = c.getContext('2d').getImageData(0, 0, this.w, this.h).data, out = new Uint8Array(this.w * this.h);
    for (let i = 0; i < out.length; i++) out[i] = d[i * 4];
    return out;
  }

  captureCanvas(mode) {
    this.composeCapture(mode);
    return this.toCanvas(this.cap);
  }

  // ---------------------------------------------------------------------------------------
  // structure operations (all undoable unless noted)
  // ---------------------------------------------------------------------------------------
  _uniqueName(base) {
    const names = new Set(this.layers.map((l) => l.name));
    if (!names.has(base)) return base;
    let i = 2;
    while (names.has(`${base} ${i}`)) i++;
    return `${base} ${i}`;
  }

  _mk(name, pix, extra = {}) {
    return { id: 'l' + newUid(), name, visible: true, opacity: 1, blend: 'normal', locked: false, adj: null, pix, origPix: pix, mask: null, prompt: '', ai: false, ...extra };
  }

  _changed() { this.layers.forEach((l) => { l.blank = false; }); this.gc(); this.ed._layersChanged(); }

  /** Not undoable: replaces everything with a single base layer (new model / new texture / restore). */
  reset({ canvas = null, size = 2048, color = '#c8c8c8', name = 'Base texture', blank = false, w = 0, h = 0 } = {}) {
    if (canvas) { this.w = canvas.width; this.h = canvas.height; }
    else { this.w = w || size; this.h = h || size; }
    let pix;
    if (canvas) pix = this.fromImage(canvas);
    else {
      const c = document.createElement('canvas'); c.width = this.w; c.height = this.h;
      const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
      pix = this.fromImage(c);
    }
    this.layers = [this._mk(name, pix, { blank })];
    this.active = 0;
  }

  addLayer(pix, name, { prompt = '', above = true, ai = false } = {}) {
    if (this.layers.length >= this.maxLayers) { this.registry.delete(pix); pix.dispose(); throw new Error(`Layer limit reached (${this.maxLayers}).`); }
    this.ed._pushLayerUndo();
    const at = above ? this.active + 1 : this.layers.length;
    this.layers.splice(at, 0, this._mk(this._uniqueName(name), pix, { prompt, ai }));
    this.active = at;
    this._changed();
    return this.layers[at];
  }

  addEmpty(name = 'Layer') { return this.addLayer(this.newPix(), name); }

  addFill(color, name = 'Fill') {
    const c = document.createElement('canvas'); c.width = this.w; c.height = this.h;
    const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, c.width, c.height);
    return this.addLayer(this.fromImage(c), name);
  }

  addImage(img, name) { return this.addLayer(this.fromImage(img), name || 'Image'); }

  remove(i) {
    if (i < 0 || i >= this.layers.length) return;
    if (this.layers.length === 1) { this.ed.setStatus('The last layer cannot be removed (use "New texture" to start over).', 'warn'); return; }
    this.ed._pushLayerUndo();
    this.layers.splice(i, 1);
    this.active = Math.max(0, i - 1);
    this._changed();
  }

  duplicate(i) {
    const L = this.layers[i];
    if (!L) return;
    if (this.layers.length >= this.maxLayers) { this.ed.setStatus(`Layer limit reached (${this.maxLayers}).`, 'warn'); return; }
    this.ed._pushLayerUndo();
    // render targets are immutable / copy-on-write, so the copy can share them
    this.layers.splice(i + 1, 0, { ...L, id: 'l' + newUid(), name: this._uniqueName(L.name + ' copy') });
    this.active = i + 1;
    this._changed();
  }

  rename(i, name) {
    const L = this.layers[i];
    name = String(name || '').trim().slice(0, 60);
    if (!L || !name || name === L.name) return;
    this.ed._pushLayerUndo();
    L.name = name;
    this._changed();
  }

  /** opacity 0..1, visible, blend, locked. Slider drags are coalesced into one undo step. */
  setProp(i, patch) {
    const L = this.layers[i];
    if (!L) return;
    const now = performance.now();
    const last = this._lastProp;
    if (!(last && last.id === L.id && now - last.t < 900 && Object.keys(patch).every((k) => last.keys.has(k)))) {
      this.ed._pushLayerUndo();
      this._lastProp = { id: L.id, t: now, keys: new Set(Object.keys(patch)) };
    } else last.t = now;
    Object.assign(L, patch);
    L.blank = false;
    this.ed._layersChanged();
  }

  move(from, to) {
    if (from === to || from < 0 || to < 0 || from >= this.layers.length || to >= this.layers.length) return;
    this.ed._pushLayerUndo();
    const [L] = this.layers.splice(from, 1);
    this.layers.splice(to, 0, L);
    this.active = to;
    this._changed();
  }

  select(i) {
    if (i < 0 || i >= this.layers.length || i === this.active) return;
    this.active = i;
    this.ed._renderLayers();
    this.ed.hudDirty = true;
  }

  /** The lower layer's opacity / mask are baked in; the merged layer keeps its blend mode. */
  mergeDown(i) {
    if (i < 1 || i >= this.layers.length) return;
    const lo = this.layers[i - 1], hi = this.layers[i];
    this.ed._pushLayerUndo();
    const out = this.newPix();
    this._run([{ pix: lo.pix, mask: lo.mask, opacity: lo.opacity, blend: 'normal', adj: lo.adj }, hi], out, null);
    const m = this._mk(lo.name, out, { blend: lo.blend, visible: true });
    this.layers.splice(i - 1, 2, m);
    this.active = i - 1;
    this._changed();
  }

  mergeVisible() {
    const vis = this._visible();
    if (vis.length < 2) { this.ed.setStatus('Fewer than two visible layers - nothing to merge.', 'warn'); return; }
    this.ed._pushLayerUndo();
    const out = this.newPix();
    this._run(vis, out, null);
    const first = this.layers.indexOf(vis[0]);
    const m = this._mk(this._uniqueName('Merged'), out);
    this.layers = this.layers.filter((l) => !l.visible);
    this.layers.splice(Math.min(first, this.layers.length), 0, m);
    this.active = this.layers.indexOf(m);
    this._changed();
  }

  /** Collapse EVERYTHING visible into one opaque layer (hidden layers are dropped). */
  flattenAll() {
    if (!this.layers.length) return;
    this.ed._pushLayerUndo();
    const out = this.newPix();
    this._run(this._visible(), out, this.ed.state.layers.bg);
    this.layers = [this._mk('Flattened', out)];
    this.active = 0;
    this._changed();
  }

  /** "Replace active layer" for AI results: the result is baked into the active layer's pixels. */
  bakeIntoActive(pix) {
    const L = this.activeLayer;
    if (!L) return null;
    this.ed._pushLayerUndo();
    const out = this.newPix();
    this._run([{ pix: L.pix, mask: L.mask, opacity: 1, blend: 'normal' }, { pix, mask: null, opacity: 1, blend: 'normal' }], out, null);
    L.pix = out; L.mask = null;
    this._changed();
    return L;
  }

  /** true when the layer differs from the state it was created in (pixels replaced or a mask painted). */
  canRevert(i) { const L = this.layers[i]; return !!L && (!!L.mask || (L.origPix && L.origPix !== L.pix)); }

  /** Back to the layer's original pixels, without any mask. Undoable. */
  revert(i) {
    const L = this.layers[i];
    if (!L || !this.canRevert(i)) return false;
    this.ed._pushLayerUndo();
    if (L.origPix) L.pix = L.origPix;
    L.mask = null;
    this._changed();
    return true;
  }

  /** Master resolution: re-renders every layer at a new size (one undo step). Masks keep their own size. */
  resizeTo(w, h) {
    w = Math.round(w); h = Math.round(h);
    if (w === this.w && h === this.h) return false;
    this.ed._pushLayerUndo();
    const map = new Map();
    const conv = (rt) => {
      if (!rt) return rt;
      if (!map.has(rt)) {
        const n = this.newPix();   // newPix uses this.w/h, set below
        this._drawInto(rt.texture, n, this.ed.copyMat);
        map.set(rt, n);
      }
      return map.get(rt);
    };
    this.w = w; this.h = h;
    this.layers = this.layers.map((l) => ({ ...l, pix: conv(l.pix), origPix: conv(l.origPix) }));
    this._ensure();
    this._changed();
    return true;
  }

  // ---- layer masks ------------------------------------------------------------------------
  /** Copy-on-write: gives the layer its own mask target (white = fully visible) and returns it. */
  cowMask(L) {
    const n = this.newMask();
    if (L.mask) this.ed._copyRT(L.mask, n);
    else this.ed._pass(this.ed.fillMat, n);
    L.mask = n;
    L.blank = false;
    return n;
  }

  setMask(i, mode) { // 'reveal' (drop the mask) | 'hide' (everything hidden)
    const L = this.layers[i];
    if (!L) return;
    this.ed._pushLayerUndo();
    if (mode === 'reveal') L.mask = null;
    else { const n = this.newMask(); this.ed._clearRT(n, 0); L.mask = n; }
    this._changed();
  }

  // ---------------------------------------------------------------------------------------
  // thumbnails
  // ---------------------------------------------------------------------------------------
  thumb(L) {
    const key = L.pix.uid + ':' + (L.mask ? L.mask.uid : '');
    let c = this.thumbs.get(key);
    if (c) return c;
    const S = 40, ed = this.ed;
    const tmp = this._rt(S, S, 'rgba8', { nearest: true });
    ed.copyMat.uniforms.tSrc.value = L.pix.texture;
    ed._pass(ed.copyMat, tmp);
    const buf = new Uint8Array(S * S * 4);
    ed.renderer.readRenderTargetPixels(tmp, 0, 0, S, S, buf);
    tmp.dispose();
    const layerCanvas = ed._pixelsToCanvas(buf, S, S);
    c = document.createElement('canvas'); c.width = c.height = S;
    const g = c.getContext('2d');
    for (let y = 0; y < S; y += 8) for (let x = 0; x < S; x += 8) { g.fillStyle = ((x + y) / 8) % 2 ? '#555' : '#777'; g.fillRect(x, y, 8, 8); }
    g.drawImage(layerCanvas, 0, 0);
    this.thumbs.set(key, c);
    return c;
  }

  // ---------------------------------------------------------------------------------------
  // persistence
  // ---------------------------------------------------------------------------------------
  serialize() {
    return {
      w: this.w, h: this.h, active: this.active,
      stack: this.layers.map((l) => ({
        id: l.id, name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend, locked: l.locked, adj: l.adj && adjActive(l.adj) ? { ...l.adj } : null,
        pix: l.pix.uid, orig: l.origPix ? l.origPix.uid : l.pix.uid, mask: l.mask ? l.mask.uid : null, prompt: l.prompt || '', ai: !!l.ai,
      })),
    };
  }

  /** rt + file name for every pixel / mask target of the current stack. */
  files() {
    const out = [];
    for (const l of this.layers) {
      out.push({ name: `L_${l.pix.uid}.png`, rt: l.pix, grey: false });
      if (l.origPix && l.origPix !== l.pix) out.push({ name: `L_${l.origPix.uid}.png`, rt: l.origPix, grey: false });
      if (l.mask) out.push({ name: `M_${l.mask.uid}.png`, rt: l.mask, grey: true });
    }
    return out;
  }

  /** data = serialize() output; getImage(fileName) -> Promise<ImageBitmap|canvas|null>. Not undoable. */
  async loadStack(data, getImage) {
    this.w = data.w; this.h = data.h;
    const layers = [];
    for (const m of data.stack || []) {
      const pimg = await getImage(`L_${m.pix}.png`);
      if (!pimg) continue;
      const pix = this.fromImage(pimg); pix.uid = m.pix;
      let origPix = pix;
      if (m.orig && m.orig !== m.pix) { const oi = await getImage(`L_${m.orig}.png`); if (oi) { origPix = this.fromImage(oi); origPix.uid = m.orig; } }
      let mask = null;
      if (m.mask) {
        const mimg = await getImage(`M_${m.mask}.png`);
        if (mimg) { mask = this.maskFromImage(mimg); mask.uid = m.mask; }
      }
      layers.push({ id: m.id || ('l' + newUid()), name: m.name || 'Layer', visible: m.visible !== false, opacity: m.opacity === undefined ? 1 : m.opacity, blend: m.blend || 'normal', locked: !!m.locked, adj: m.adj && typeof m.adj === 'object' ? { ...m.adj } : null, pix, origPix, mask, prompt: m.prompt || '', ai: !!m.ai });
    }
    if (!layers.length) return false;
    this.layers = layers;
    this.active = Math.min(Math.max(0, data.active | 0), layers.length - 1);
    return true;
  }
}
