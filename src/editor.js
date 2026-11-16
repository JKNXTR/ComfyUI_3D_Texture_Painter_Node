// Texture Painter editor core: GL setup, scenes, projective mask painting, texture handling, capture.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildObjectTree } from './objects.js';
import { pbrDefaults, pbrMapIds } from './pbr.js';
import { VIEW_COLORS } from './views.js';
import { parseModel, buildMerged, hashGeometry, serializeMesh, buildUVLines, extOf, SUPPORTED_EXT, uvHealth } from './meshio.js';
import * as SH from './shaders.js';
import { LayerStack } from './layers.js';
import { buildUI } from './ui.js';
import { installPanels } from './panels.js';
import { HEAL_PROMPT } from './promptlib.js';

export const DEFAULT_STATE = () => ({
  v: 1,
  model: null,
  brushTarget: 'selection', // 'selection' (AI mask) | 'layer' (hide / reveal on the active layer) | 'transition' (blue transition mask for Combine) | 'heal' (dark-green heal area)
  layers: { captureSource: 'composite', bg: '#808080', padding: 8, replaceActive: false },
  objHidden: [],
  blend: { gen: 1, orig: 0, ref: 0 },
  combine: { mode: 'weighted', sharp: 1, detail: 'multiband', width: 32, normalize: 'off', normStrength: 0.8, anchor: '', fill: 8, viewImp: 0, useTrans: true, tw: 48, transOnly: false, showTrans: true, w: {} },
  ref2: { enabled: false, weight: 0.7, mode: 'mask', scale: 1, rot: 0, has: false, name: '', ox: 0, oy: 0, size: 0.5, sx: 1, sy: 1, wrap: false, aspect: 0, fit: '', original: false, bg: false, bgOpacity: 0.6, view: true, viewOpacity: 0.95, viewAll: false },
  objTex: { show: false, ref: false },                 // other objects: show their textures / use them as AI reference
  pbr: pbrDefaults(),                                  // PBR preview settings (global)
  pbrMaps: pbrMapIds(),                                // ids of the PBR map files of the WORKING object (swapped with it)
  refx: [0, 1, 2, 3].map(() => REFX_SLOT()),   // reference images 3..6: same placement / weight / mode as image 2, plus a role text, an angle label and a saved camera angle
  export: { format: 'glb', space: 'original', saveServer: false },
  xform: { rx: 0, ry: 0, rz: 0, s: 1, fx: false, fy: false, fz: false, ox: 0, oy: 0, oz: 0 },
  tool: 'brush',
  brush: { size: 70, hardness: 0.7, softness: 0.5, opacity: 1, spacing: 0.12, stab: 0.2 },
  erase: { size: 70, hardness: 0.7, softness: 0.5, opacity: 1, spacing: 0.12, stab: 0.2 },
  pen: true,
  mask: { show: true, opacity: 0.6, amount: 8 },
  capture: { uvMode: false, uvref: { on: false, fill: 0.6, facing: 65 }, tile: { on: false, cols: 2, rows: 2, overlap: 0.12, mode: 'seq' }, aspect: '1:1', long: 1024, shading: 'unlit', bg: '#808080', facing: 0.25, frame: true, crop: { enabled: false, margin: 0.12 } },
  display: { layout: 'split', refK: 0, grid: true, wire3d: false, shade3d: 0, uvWire: 0.35, checker3d: false },
  plan: { showCover: false, thr: 0.6, seam: true, batchN: 4, target: 0.95, varN: 4 },
  heal: { on: false, prompt: HEAL_PROMPT, soft: true },   // Heal brush (J): on = the AI repaints only the dark-green heal area, with this prompt only
  gen: { preset: 'distilled', steps: 4, cfg: 1.0, quality: 1024, maskSource: 'selection' },   // maskSource: which mask the AI repaints: 'selection' | 'transition' (blue)
  tprompts: [],   // my own transition prompts [{id, title, text}]
  har: { preset: 'har-photo', strength: 0.6 },
  bookmarks: [],
  options: { clearMask: true, autoApply: false },
  camera: null,
});

// one of the reference images 3..6. Defaults = old pass-through behaviour (weight 0, original image sent, no blending into the view).
const viewUniforms = () => ({ tV0: { value: null }, tV1: { value: null }, tV2: { value: null }, tV3: { value: null }, uVC0: { value: new THREE.Vector3() }, uVC1: { value: new THREE.Vector3() }, uVC2: { value: new THREE.Vector3() }, uVC3: { value: new THREE.Vector3() }, uShowViews: { value: 1 } });
export const REFX_SLOT = () => ({ has: false, enabled: true, name: '', role: '', angle: '', cam: null, weight: 0, mode: 'mask', scale: 1, rot: 0, ox: 0, oy: 0, size: 0.5, sx: 1, sy: 1, wrap: false, aspect: 0, fit: '', original: true, bg: false, bgOpacity: 0.6, view: true, viewOpacity: 0.95, viewAll: false, color: '' });
function deepMerge(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const k of Object.keys(over)) {
    if (base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]) && over[k] && typeof over[k] === 'object') deepMerge(base[k], over[k]);
    else if (over[k] !== undefined) base[k] = over[k];
  }
  return base;
}

const hexToRaw = (hex) => {
  const c = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = c ? parseInt(c[1], 16) : 0x808080;
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

export class TexturePaintEditor {
  constructor({ hooks = {}, state = null } = {}) {
    this.hooks = hooks;
    this.state = deepMerge(DEFAULT_STATE(), state || {});
    this._normRefx();
    this.ui = buildUI();
    this.root = this.ui.root;
    this.disposed = false;
    this.needsRender = true;
    this.hudDirty = true;
    this.logLines = [];
    this.undoStack = [];
    this.redoStack = [];
    this.ref2Blob = null;
    this.ref2Version = 0;
    this.refxBlobs = [null, null, null, null]; this.refxCanvas = [null, null, null, null]; this.refxVersion = 0; this.refActive = 2;
    this._composeDirty = true;
    this.geometry = null;
    this.info = null;
    this.meshHash = null;
    this.textureVersion = 0;
    this.maskVersion = 0;
    this.transVersion = 0;
    this.healVersion = 0;
    this.spaceDown = false;
    this.stroke = null;
    this.hover = null;
    this.hoverUV = null;
    this.pending = null; // pending generation result
    this.compare = false;
    this.uvView = { cx: 0.5, cy: 0.5, zoom: 1 };
    this._emitTimer = 0;
    this._lastRay = 0;

    try {
      this._initGL();
      this._initScenes();
      this._initMask(2048);
      this.layers = new LayerStack(this);
      this.layers.reset({ size: 2048, blank: true });
      this.layers.composeDisplay(null);
      this.layers.composeCapture('composite');
      this._bindTexture();
    } catch (e) {
      this.log('error', 'WebGL2 initialisation failed', e);
      this.setStatus('WebGL2 is required but could not be initialised: ' + (e && e.message), 'err');
      this.failed = true;
      return;
    }
    installPanels(this);
    this._applyStateToUI();
    this._startLoop();
  }

  // ----------------------------------------------------------------------------------------
  // logging / status
  // ----------------------------------------------------------------------------------------
  log(level, msg, err) {
    const t = new Date().toLocaleTimeString();
    let text = `[${t}] ${msg}`;
    if (err) text += '\n' + (err.stack || err.message || String(err));
    this.logLines.push(text);
    if (this.logLines.length > 300) this.logLines.shift();
    if (this.ui && this.ui.logEl) {
      const d = document.createElement('div');
      d.className = level === 'error' ? 'e' : level === 'warn' ? 'w' : level === 'ok' ? 'o' : '';
      d.textContent = text;
      this.ui.logEl.appendChild(d);
      while (this.ui.logEl.childNodes.length > 300) this.ui.logEl.removeChild(this.ui.logEl.firstChild);
      this.ui.logEl.scrollTop = this.ui.logEl.scrollHeight;
    }
    (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[TexturePainterAI]', msg, err || '');
  }

  setStatus(text, kind) {
    const m = this.ui.msg;
    m.textContent = text;
    m.className = 'tp-msg' + (kind ? ' tp-' + kind : '');
  }

  // ----------------------------------------------------------------------------------------
  // GL / scene setup
  // ----------------------------------------------------------------------------------------
  _initGL() {
    const canvas = this.ui.glCanvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    if (!this.renderer.capabilities.isWebGL2) throw new Error('WebGL2 not available');
    this.renderer.autoClear = false;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.renderer.setPixelRatio(this.dpr);
    this.maxAniso = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.log('warn', 'WebGL context lost - the mask may need to be reloaded from the session.'); });
    canvas.addEventListener('webglcontextrestored', () => { this.log('warn', 'WebGL context restored.'); this.invalidate(); });
  }

  _initScenes() {
    // ---- 3D view
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.02, 60);
    this.camera.position.set(0, 0.5, 3.4);
    this.perspCam = this.camera;
    this.orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.02, 60);
    this.orthoHalf = 1.2; // half height of the orthographic frustum at zoom 1
    this.controls = new OrbitControls(this.camera, this.ui.pane3d);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.zoomSpeed = 1.1;
    this.controls.addEventListener('change', () => { this.invalidate(); this._cameraTouched(); });
    this.grid = new THREE.GridHelper(4, 16, 0x3a3f4d, 0x262a33);
    this.grid.position.y = -1.02;
    this.scene.add(this.grid);

    this.meshMat = new THREE.ShaderMaterial({
      vertexShader: SH.MESH_VERT,
      fragmentShader: SH.MESH_FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        tColor: { value: null },
        tMask: { value: null },
        uMaskColor: { value: new THREE.Vector3(1.0, 0.2, 0.85) },
        uMaskOpacity: { value: 0.6 },
        uShowMask: { value: 1 },
        tTrans: { value: null }, tHeal: { value: null }, uShowTrans: { value: 1 }, ...viewUniforms(), tRefRgn: { value: null }, uRefRegion: { value: 0 },
        uShade: { value: 0 },
        uFacingThr: { value: 0.25 },
        uChecker: { value: 0 },
        tCover: { value: null },
        uShowCover: { value: 0 },
        tRef: { value: null }, uRefOn: { value: 0 }, uRefA: { value: 0.95 }, uRefAll: { value: 0 }, uFrame: { value: new THREE.Vector4(0, 0, 1, 1) }, uDpr: { value: 1 }, uRefP: { value: new THREE.Vector4() }, uRefQ: { value: new THREE.Vector2(1, 0) },
        uOrtho: { value: 0 },
        uCamDir: { value: new THREE.Vector3(0, 0, 1) },
      },
    });
    this.wireMat = new THREE.MeshBasicMaterial({ color: 0x8fd0ff, wireframe: true, transparent: true, opacity: 0.25, depthWrite: false });
    this.raycaster = new THREE.Raycaster();

    // ---- UV view
    this.uvScene = new THREE.Scene();
    this.uvCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -10, 10);
    this.uvCam.position.set(0.5, 0.5, 5);
    this.uvMat = new THREE.ShaderMaterial({
      vertexShader: SH.UVQUAD_VERT,
      fragmentShader: SH.UVQUAD_FRAG,
      side: THREE.DoubleSide,
      uniforms: {
        tColor: { value: null },
        tMask: { value: null },
        uMaskColor: { value: new THREE.Vector3(1.0, 0.2, 0.85) },
        uMaskOpacity: { value: 0.6 },
        uShowMask: { value: 1 },
        tTrans: { value: null }, tHeal: { value: null }, uShowTrans: { value: 1 }, ...viewUniforms(),
        uChecker: { value: 0 },
        tCover: { value: null },
        uShowCover: { value: 0 },
      },
    });
    const qg = new THREE.PlaneGeometry(1, 1);
    qg.translate(0.5, 0.5, 0);
    this.uvQuad = new THREE.Mesh(qg, this.uvMat);
    this.uvScene.add(this.uvQuad);
    this.uvLineMat = new THREE.LineBasicMaterial({ color: 0x74b0ff, transparent: true, opacity: 0.35, depthTest: false });
    // frame around the 0-1 square
    const frame = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0.001), new THREE.Vector3(1, 0, 0.001), new THREE.Vector3(1, 1, 0.001), new THREE.Vector3(0, 1, 0.001)]),
      new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false })
    );
    this.uvScene.add(frame);

    // ---- full-screen pass helpers
    this.quadScene = new THREE.Scene();
    this.quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial());
    this.quad.frustumCulled = false;
    this.quadScene.add(this.quad);
    const passMat = (frag, extra = {}) => new THREE.ShaderMaterial({
      vertexShader: SH.FULLSCREEN_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, blending: THREE.NoBlending,
      uniforms: { tSrc: { value: null }, ...extra },
    });
    this.copyMat = passMat(SH.COPY_FRAG);
    this.copyGreyMat = passMat(SH.COPY_GREY_FRAG);
    this.invertMat = passMat(SH.INVERT_FRAG);
    this.fillMat = passMat(SH.FILL_FRAG);
    this.morphMat = passMat(SH.MORPH_FRAG, { uStep: { value: new THREE.Vector2() }, uR: { value: 1 }, uMode: { value: 0 } });

    // ---- projective brush (draws the mesh into UV space)
    const paintUniforms = () => ({
      uVP: { value: new THREE.Matrix4() },
      uCam: { value: new THREE.Vector3() },
      uOrtho: { value: 0 },
      uCamDir: { value: new THREE.Vector3(0, 0, 1) },
      uCenter: { value: new THREE.Vector2() },
      uSize: { value: new THREE.Vector2(1, 1) },
      uRadius: { value: 20 },
      uHardness: { value: 0.7 },
      uSoft: { value: 0.5 },
      uShape: { value: null },
      uUseShape: { value: 0 },
      uOpacity: { value: 1 },
      uDepth: { value: null },
      uNear: { value: 0.02 },
      uFar: { value: 60 },
      uBias: { value: 0.006 },
      uFacingMin: { value: 0.03 },
      uOutFacing: { value: 0 },
    });
    this.paintMat = new THREE.ShaderMaterial({
      vertexShader: SH.PAINT_VERT, fragmentShader: SH.PAINT_FRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.MaxEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      blendEquationAlpha: THREE.MaxEquation, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
      uniforms: paintUniforms(),
    });
    this.eraseMat = new THREE.ShaderMaterial({
      vertexShader: SH.PAINT_VERT, fragmentShader: SH.PAINT_FRAG, side: THREE.DoubleSide, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
      uniforms: paintUniforms(),
    });
    this.paintScene = new THREE.Scene();
    this.depthMat = new THREE.ShaderMaterial({ vertexShader: SH.DEPTH_ONLY_VERT, fragmentShader: SH.DEPTH_ONLY_FRAG, side: THREE.DoubleSide });
    this.depthScene = new THREE.Scene();

    // ---- capture passes
    this.passMat = new THREE.ShaderMaterial({
      vertexShader: SH.PASS_VERT, fragmentShader: SH.PASS_FRAG, side: THREE.DoubleSide,
      uniforms: { tColor: { value: null }, tMask: { value: null }, uMode: { value: 0 }, uShade: { value: 0 }, uNear: { value: 0.1 }, uFar: { value: 10 } },
    });
    this.passScene = new THREE.Scene();
    this.coverScene = new THREE.Scene();
  }

  _initMask(size) {
    for (const k of ['maskRT', 'tmpRT', 'readRT', 'transRT', 'healRT']) if (this[k]) this[k].dispose();
    for (const e of this.undoStack.concat(this.redoStack)) this._dropEntry(e);
    this.undoStack = [];
    this.redoStack = [];
    this.maskSize = size;
    const mk = () => new THREE.WebGLRenderTarget(size, size, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
      depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
    });
    this.maskRT = mk();
    this.tmpRT = mk();
    this.readRT = new THREE.WebGLRenderTarget(size, size, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
    this.transRT = mk();
    this.healRT = mk();
    this._clearRT(this.maskRT, 0);
    this._clearRT(this.transRT, 0);
    this._clearRT(this.healRT, 0);
    if (this._initViews) this._initViews();
    this._bindMask();
  }

  _bindMask() {
    this.meshMat.uniforms.tMask.value = this.maskRT.texture;
    this.uvMat.uniforms.tMask.value = this.maskRT.texture;
    this.passMat.uniforms.tMask.value = this.maskRT.texture;
    if (this.transRT) { this.meshMat.uniforms.tTrans.value = this.transRT.texture; this.uvMat.uniforms.tTrans.value = this.transRT.texture; }
    if (this.healRT) { this.meshMat.uniforms.tHeal.value = this.healRT.texture; this.uvMat.uniforms.tHeal.value = this.healRT.texture; }
    this.invalidate();
  }

  // ----------------------------------------------------------------------------------------
  // render helpers
  // ----------------------------------------------------------------------------------------
  invalidate() { this.needsRender = true; this.hudDirty = true; }

  _clearRT(rt, v) {
    const r = this.renderer;
    const prevT = r.getRenderTarget();
    const prevC = new THREE.Color();
    r.getClearColor(prevC);
    const prevA = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(new THREE.Color().setRGB(v, v, v, THREE.LinearSRGBColorSpace), 1);
    r.clear(true, false, false);
    r.setClearColor(prevC, prevA);
    r.setRenderTarget(prevT);
  }

  _clearRTA(rt, v, a) {
    const r = this.renderer;
    const prevT = r.getRenderTarget();
    const prevC = new THREE.Color();
    r.getClearColor(prevC);
    const prevA = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setClearColor(new THREE.Color().setRGB(v, v, v, THREE.LinearSRGBColorSpace), a);
    r.clear(true, false, false);
    r.setClearColor(prevC, prevA);
    r.setRenderTarget(prevT);
  }

  _pass(material, target) {
    const r = this.renderer;
    this.quad.material = material;
    const prevT = r.getRenderTarget();
    const prevS = r.getScissorTest();
    r.setRenderTarget(target);
    r.setScissorTest(false);
    r.render(this.quadScene, this.quadCam);
    r.setRenderTarget(prevT);
    r.setScissorTest(prevS);
  }

  _copyRT(src, dst) {
    this.copyMat.uniforms.tSrc.value = src.texture;
    this._pass(this.copyMat, dst);
  }

  _swapMask() {
    const t = this.maskRT; this.maskRT = this.tmpRT; this.tmpRT = t;
    this._bindMask();
  }

  // ----------------------------------------------------------------------------------------
  // mask operations (all GPU side)
  // ----------------------------------------------------------------------------------------
  _snapRT() {
    return new THREE.WebGLRenderTarget(this.maskSize, this.maskSize, {
      format: THREE.RedFormat, type: THREE.UnsignedByteType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false,
    });
  }

  _dropEntry(e) { if (e && (e.k === 'sel' || e.k === 'tr' || e.k === 'vw')) e.rt.dispose(); }
  _clearRedo() { for (const e of this.redoStack) this._dropEntry(e); this.redoStack = []; }
  _trim() { while (this.undoStack.length > 60) this._dropEntry(this.undoStack.shift()); }
  _clearHistory() {
    for (const e of this.undoStack.concat(this.redoStack)) this._dropEntry(e);
    this.undoStack = []; this.redoStack = [];
    if (this.layers) this.layers.gc();
    if (this._updateUndoButtons) this._updateUndoButtons();
  }

  /** one history for everything: entries are {k:'sel', rt} (AI selection mask) or {k:'lay', snap} (layer stack) */
  _pushUndo() {
    const snap = this._snapRT();
    this._copyRT(this.maskRT, snap);
    this.undoStack.push({ k: 'sel', rt: snap });
    this._clearRedo();
    this._trim();
    this.layers.gc();
    this._updateUndoButtons();
  }

  _pushTransUndo() {
    const snap = this._snapRT();
    this._copyRT(this.transRT, snap);
    this.undoStack.push({ k: 'tr', rt: snap });
    this._clearRedo();
    this._trim();
    this._updateUndoButtons();
  }

  _pushHealUndo() {
    const snap = this._snapRT();
    this._copyRT(this.healRT, snap);
    this.undoStack.push({ k: 'he', rt: snap });
    this._clearRedo();
    this._trim();
    this._updateUndoButtons();
  }

  _pushLayerUndo() {
    this.undoStack.push({ k: 'lay', snap: this.layers.snap() });
    this._clearRedo();
    this._trim();
    this._updateUndoButtons();
  }

  _step(from, to) {
    const e = from.pop();
    if (!e) return;
    if (e.k === 'sel') {
      const cur = this._snapRT();
      this._copyRT(this.maskRT, cur);
      to.push({ k: 'sel', rt: cur });
      this._copyRT(e.rt, this.maskRT);
      e.rt.dispose();
      this._maskChanged();
    } else if (e.k === 'vw') {
      const cur = this._snapRT();
      this._copyRT(this.viewRT[e.i], cur);
      to.push({ k: 'vw', i: e.i, rt: cur });
      this._copyRT(e.rt, this.viewRT[e.i]);
      e.rt.dispose();
      this._viewsChanged(e.i);
    } else if (e.k === 'tr') {
      const cur = this._snapRT();
      this._copyRT(this.transRT, cur);
      to.push({ k: 'tr', rt: cur });
      this._copyRT(e.rt, this.transRT);
      e.rt.dispose();
      this._transChanged();
    } else if (e.k === 'he') {
      const cur = this._snapRT();
      this._copyRT(this.healRT, cur);
      to.push({ k: 'he', rt: cur });
      this._copyRT(e.rt, this.healRT);
      e.rt.dispose();
      this._healChanged();
    } else {
      to.push({ k: 'lay', snap: this.layers.snap() });
      this.layers.restore(e.snap);
      this.layers.gc();
      this._layersChanged();
    }
    this._updateUndoButtons();
  }

  undo() { this._step(this.undoStack, this.redoStack); }
  redo() { this._step(this.redoStack, this.undoStack); }

  _maskChanged() {
    this.maskVersion++;
    this.invalidate();
    this._updateUndoButtons();
    this._dirty('mask');
  }

  _transChanged() { this.transVersion++; this.invalidate(); this._updateUndoButtons(); this._dirty('mask'); if (this._onTransChanged) this._onTransChanged(); }
  transClear() { this._pushTransUndo(); this._clearRT(this.transRT, 0); this._transChanged(); }
  _readTransPixels() {
    this.copyGreyMat.uniforms.tSrc.value = this.transRT.texture;
    this._pass(this.copyGreyMat, this.readRT);
    const S = this.maskSize, buf = new Uint8Array(S * S * 4);
    this.renderer.readRenderTargetPixels(this.readRT, 0, 0, S, S, buf);
    return buf;
  }
  transIsEmpty() { const b = this._readTransPixels(); for (let i = 0; i < b.length; i += 4) if (b[i] > 4) return false; return true; }
  async exportTransBlob() { return this._canvasToBlob(this._pixelsToCanvas(this._readTransPixels(), this.maskSize, this.maskSize)); }
  importTransBitmap(bmp, { undo = true } = {}) {
    if (undo) this._pushTransUndo();
    const c = document.createElement('canvas'); c.width = c.height = this.maskSize;
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
    this.copyMat.uniforms.tSrc.value = tex; this._pass(this.copyMat, this.transRT); tex.dispose();
    this._transChanged();
  }
  // ---- heal area (dark green, Heal brush J): a second painted UV mask, same handling as the transition mask
  _healChanged() { this.healVersion++; this.invalidate(); this._updateUndoButtons(); this._dirty('mask'); if (this._onHealChanged) this._onHealChanged(); }
  healClear() { this._pushHealUndo(); this._clearRT(this.healRT, 0); this._healChanged(); }
  _readHealPixels() {
    this.copyGreyMat.uniforms.tSrc.value = this.healRT.texture;
    this._pass(this.copyGreyMat, this.readRT);
    const S = this.maskSize, buf = new Uint8Array(S * S * 4);
    this.renderer.readRenderTargetPixels(this.readRT, 0, 0, S, S, buf);
    return buf;
  }
  healIsEmpty() { const b = this._readHealPixels(); for (let i = 0; i < b.length; i += 4) if (b[i] > 4) return false; return true; }
  async exportHealBlob() { return this._canvasToBlob(this._pixelsToCanvas(this._readHealPixels(), this.maskSize, this.maskSize)); }
  importHealBitmap(bmp, { undo = true } = {}) {
    if (undo) this._pushHealUndo();
    const c = document.createElement('canvas'); c.width = c.height = this.maskSize;
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.NoColorSpace; tex.generateMipmaps = false; tex.minFilter = THREE.LinearFilter;
    this.copyMat.uniforms.tSrc.value = tex; this._pass(this.copyMat, this.healRT); tex.dispose();
    this._healChanged();
  }
  /** transition mask resampled to w x h (top row first, 0..255) for the combine maths */
  transBytes(w, h) {
    const S = this.maskSize, buf = this._readTransPixels(), cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g = cv.getContext('2d'), id = g.createImageData(S, S);
    for (let y = 0; y < S; y++) { const src = (S - 1 - y) * S * 4; for (let x = 0; x < S; x++) { const v = buf[src + x * 4], j = (y * S + x) * 4; id.data[j] = id.data[j + 1] = id.data[j + 2] = v; id.data[j + 3] = 255; } }
    g.putImageData(id, 0, 0);
    const c2 = document.createElement('canvas'); c2.width = w; c2.height = h; const g2 = c2.getContext('2d'); g2.imageSmoothingEnabled = true; g2.imageSmoothingQuality = 'high'; g2.drawImage(cv, 0, 0, w, h);
    const d = g2.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) out[i] = d[i * 4];
    return out;
  }

  maskClear() { this._pushUndo(); this._clearRT(this.maskRT, 0); this._maskChanged(); }
  maskFill() { this._pushUndo(); this._pass(this.fillMat, this.maskRT); this._maskChanged(); }
  maskInvert() {
    this._pushUndo();
    this.invertMat.uniforms.tSrc.value = this.maskRT.texture;
    this._pass(this.invertMat, this.tmpRT);
    this._swapMask();
    this._maskChanged();
  }

  /** mode: 0 grow (dilate), 1 shrink (erode), 2 feather (box blur). amount in mask texels. */
  maskMorph(mode, amount) {
    const R = Math.max(1, Math.min(64, Math.round(amount)));
    this._pushUndo();
    const u = this.morphMat.uniforms;
    u.uR.value = R;
    u.uMode.value = mode;
    u.uStep.value.set(1 / this.maskSize, 0);
    u.tSrc.value = this.maskRT.texture;
    this._pass(this.morphMat, this.tmpRT);
    u.uStep.value.set(0, 1 / this.maskSize);
    u.tSrc.value = this.tmpRT.texture;
    this._pass(this.morphMat, this.maskRT);
    this._maskChanged();
  }

  /** Replace the mask with an image (white = masked). */
  importMaskBitmap(bmp, { undo = true } = {}) {
    if (undo) this._pushUndo();
    const c = document.createElement('canvas');
    c.width = c.height = this.maskSize;
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, 0, 0, c.width, c.height);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.NoColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    this.copyMat.uniforms.tSrc.value = tex;
    this._pass(this.copyMat, this.maskRT);
    tex.dispose();
    this._maskChanged();
  }

  _readMaskPixels() {
    this.copyGreyMat.uniforms.tSrc.value = this.maskRT.texture;
    this._pass(this.copyGreyMat, this.readRT);
    const S = this.maskSize;
    const buf = new Uint8Array(S * S * 4);
    this.renderer.readRenderTargetPixels(this.readRT, 0, 0, S, S, buf);
    return buf; // bottom-up RGBA
  }

  /** top-first 8 bit grey array -> canvas */
  _grayCanvas(arr, w, h) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d'), id = g.createImageData(w, h), d = id.data;
    for (let i = 0, j = 0; i < arr.length; i++, j += 4) { d[j] = d[j + 1] = d[j + 2] = arr[i]; d[j + 3] = 255; }
    g.putImageData(id, 0, 0);
    return c;
  }

  _pixelsToCanvas(buf, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(w, h);
    const row = w * 4;
    for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * row, (h - y) * row), y * row); // flip vertically
    ctx.putImageData(img, 0, 0);
    return c;
  }

  _canvasToBlob(c, type = 'image/png') {
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('canvas.toBlob failed'))), type));
  }

  async exportMaskBlob() {
    const buf = this._readMaskPixels();
    return this._canvasToBlob(this._pixelsToCanvas(buf, this.maskSize, this.maskSize));
  }

  maskIsEmpty() {
    const buf = this._readMaskPixels();
    for (let i = 0; i < buf.length; i += 4) if (buf[i] > 2) return false;
    return true;
  }

  // ----------------------------------------------------------------------------------------
  // texture handling
  // ----------------------------------------------------------------------------------------
  _bindTexture() {
    const L = this.layers;
    if (!L || !L.comp) return;
    this.meshMat.uniforms.tColor.value = L.comp.texture;
    this.uvMat.uniforms.tColor.value = L.comp.texture;
    this.passMat.uniforms.tColor.value = L.cap.texture;
    this.invalidate();
  }

  /** Called after every change of the layer stack (structure, properties, pixels or masks). */
  _layersChanged() {
    this.textureVersion++;
    this._composeDirty = true;
    this.invalidate();
    if (this._renderLayers) this._renderLayers();
    if (this._renderStats) this._renderStats();
    if (this._updateUndoButtons) this._updateUndoButtons();
    this._dirty('texture');
  }

  /** Re-composites the display texture now (normally done once per frame when something changed). */
  flushCompose() {
    this._composeDirty = false;
    this.layers.composeDisplay(this.compare && this.pending ? this.pending : null);
    this._bindTexture();
  }

  /** Not undoable: new single base layer (new model, restore). */
  _resetStack(opts) {
    this.layers.reset(opts);
    this.layers.gc();
    this._layersChanged();
  }

  newTexture(size, color) {
    this._pushLayerUndo();
    this.layers.reset({ size, color, blank: true });
    this.layers.gc();
    this._layersChanged();
    this.log('ok', `New ${size}x${size} texture created (all layers replaced; Ctrl+Z restores them).`);
  }

  _imageToCanvas(img, { whiteBg = false } = {}) {
    const w0 = img.width || img.naturalWidth;
    const h0 = img.height || img.naturalHeight;
    if (!w0 || !h0) throw new Error('Image has no size.');
    const k = Math.min(1, 4096 / Math.max(w0, h0));
    const w = Math.max(16, Math.round(w0 * k)), h = Math.max(16, Math.round(h0 * k));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    if (whiteBg) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(img, 0, 0, w, h);
    return c;
  }

  /** Texture image -> the base layer while the stack is untouched (or keepHistory === false); otherwise a new layer. */
  setTextureFromImage(img, { label = 'texture loaded', keepHistory = true } = {}) {
    if (!keepHistory || this.layers.isPristine()) {
      const c = this._imageToCanvas(img, { whiteBg: true });
      if (keepHistory) this._pushLayerUndo();
      this.layers.reset({ canvas: c, name: 'Base texture' });
      this.layers.gc();
      this._layersChanged();
      this.log('ok', `Texture set (${c.width}x${c.height}).`);
    } else {
      const c = this._imageToCanvas(img);
      this.layers.addImage(c, String(label).replace(/\.[a-z0-9]+$/i, '').slice(0, 40) || 'Image');
      this.log('ok', `Image added as a new layer (${c.width}x${c.height}, stretched to ${this.layers.w}x${this.layers.h}).`);
    }
  }

  async loadTextureFile(file) {
    const bmp = await createImageBitmap(file);
    this.setTextureFromImage(bmp, { label: file.name || 'image' });
    bmp.close && bmp.close();
  }

  /** Always adds a new layer (the "Image..." button of the Layers panel). */
  async addImageLayerFile(file) {
    const bmp = await createImageBitmap(file);
    const c = this._imageToCanvas(bmp);
    bmp.close && bmp.close();
    this.layers.addImage(c, String(file.name || 'Image').replace(/\.[a-z0-9]+$/i, '').slice(0, 40));
    this.log('ok', `Layer added from ${file.name}.`);
  }

  /** The baked UV map: visible layers over the background colour, seams padded. PNG blob. */
  async exportTextureBlob(padding) {
    return this._canvasToBlob(this.layers.bakeCanvas(padding === undefined ? this.state.layers.padding : padding));
  }

  /** What the generator sees as texture (capture source setting), as a canvas. */
  getTextureCanvas(mode) { return this.layers.captureCanvas(mode || this.state.layers.captureSource); }

  /** Restores a saved stack (server files). Not undoable; clears the history. */
  async restoreLayers(data, getImage) {
    const ok = await this.layers.loadStack(data, getImage);
    if (ok) {
      this._clearHistory();
      this.layers.gc();
      this._layersChanged();
    }
    return ok;
  }

  // ---- reference image 2 -------------------------------------------------------------------
  async setRef2Image(file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(bmp.width * k)); c.height = Math.max(8, Math.round(bmp.height * k));
    const g = c.getContext('2d');
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    this.ref2Blob = await this._canvasToBlob(c);
    this.ref2Canvas = c;
    this.state.ref2.has = true; this.state.ref2.aspect = 0; this.state.ref2.fit = '';
    this.state.ref2.name = String(file.name || 'image 2').slice(0, 60);
    this.ref2Version++;
    if (this._renderRef2) this._renderRef2();
    this.log('ok', `Reference image 2 loaded (${c.width}x${c.height}).`);
    this._dirty('ref2');
  }

  /** Style lock: use the active layer (cropped to what it contains) or the whole texture as reference image 2. */
  async setRef2FromLayer(which = 'layer', n = 2) {
    let c, name;
    if (which === 'texture') { c = this.getTextureCanvas('composite'); name = 'texture'; }
    else {
      const L = this.layers.activeLayer;
      if (!L) throw new Error('No active layer.');
      const full = this.layers.toCanvas(L.pix), g = full.getContext('2d'), d = g.getImageData(0, 0, full.width, full.height).data;
      let x0 = full.width, x1 = -1, y0 = full.height, y1 = -1;
      for (let y = 0; y < full.height; y++) for (let x = 0; x < full.width; x++) if (d[(y * full.width + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
      if (x1 < x0) throw new Error('The active layer is empty.');
      c = document.createElement('canvas'); c.width = x1 - x0 + 1; c.height = y1 - y0 + 1;
      c.getContext('2d').drawImage(full, x0, y0, c.width, c.height, 0, 0, c.width, c.height);
      name = L.name;
    }
    const blob = await this._canvasToBlob(c);
    await this.setRefImage(n, new File([blob], 'layer: ' + name + '.png', { type: 'image/png' }));
    return name;
  }

  async loadRef2Blob(blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close && bmp.close();
    this.ref2Blob = blob;
    this.ref2Canvas = c;
    this.state.ref2.has = true; this.state.ref2.aspect = 0; this.state.ref2.fit = '';
    this.ref2Version++;
    if (this._renderRef2) this._renderRef2();
  }

  // ---- reference slots: image 2 is st.ref2 / ref2Canvas, images 3..6 are st.refx[0..3] / refxCanvas[0..3]
  _normRefx() { // saved states of older versions have 3 plain slots: fill in the new fields and the 4th slot
    const a = Array.isArray(this.state.refx) ? this.state.refx : [];
    while (a.length < 4) a.push(REFX_SLOT());
    this.state.refx = a.slice(0, 4).map((r, i) => { const s = { ...REFX_SLOT(), ...(r && typeof r === 'object' ? r : {}) }; if (!s.color) s.color = VIEW_COLORS[i]; return s; });
  }
  refState(n = this.refActive) { return n === 2 ? this.state.ref2 : this.state.refx[n - 3]; }
  refCanvas(n = this.refActive) { return n === 2 ? this.ref2Canvas : this.refxCanvas[n - 3]; }
  refVersion(n = this.refActive) { return n === 2 ? this.ref2Version : this.refxVersion; }
  refDirtyKind(n = this.refActive) { return n === 2 ? 'ref2' : 'refx'; }
  setRefImage(n, file) { return n === 2 ? this.setRef2Image(file) : this.setRefxImage(n - 3, file); }
  clearRefImage(n) { if (n === 2) this.clearRef2(); else this.clearRefx(n - 3); }
  /** remembers the current camera as the angle this reference image belongs to (and goes back to it later) */
  refSaveAngle(n = this.refActive) {
    const r = this.refState(n);
    r.cam = { name: 'Image ' + n, pos: this.camera.position.toArray(), target: this.controls.target.toArray(), ortho: this.isOrtho, half: this.orthoHalf, zoom: this.camera.zoom };
    this._dirty(this.refDirtyKind(n));
  }
  /** camera pose in the bookmark format (also used for the reference images' cameras) */
  cameraPose(name = '') { return { name, pos: this.camera.position.toArray(), target: this.controls.target.toArray(), ortho: this.isOrtho, half: this.orthoHalf, zoom: this.camera.zoom }; }
  /** puts the camera at a pose immediately (no animation) */
  applyPose(b) {
    this.setOrtho(!!b.ortho);
    if (b.ortho) { this.orthoHalf = b.half || this.orthoHalf; this.camera.zoom = b.zoom || 1; }
    this.controls.target.fromArray(b.target);
    this.camera.position.fromArray(b.pos);
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }
  /** The camera reference image n is seen from: the view it was placed from > its saved angle > a standard view named by its angle label. null = unknown. */
  refPose(n) {
    const r = this.refState(n); if (!r) return null;
    if (r.mode === 'manual' && r.pcam) return { pose: r.pcam, source: 'placed view' };
    if (r.cam) return { pose: r.cam, source: 'saved angle' };
    const lab = String(r.angle || '').toLowerCase();
    const D = { front: [0, 0, 1], back: [0, 0, -1], left: [-1, 0, 0], right: [1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0] };
    const v = new THREE.Vector3(); let hit = 0;
    for (const [k, d] of Object.entries(D)) if (new RegExp('\\b' + k + '\\b').test(lab)) { v.add(new THREE.Vector3(...d)); hit++; }
    if (!hit || v.lengthSq() < 1e-6) return null;
    v.normalize();
    const t = this.controls.target.clone(), dist = Math.max(0.05, this.camera.position.distanceTo(t));
    if (Math.abs(v.y) > 0.9999) { v.x += 1e-4; v.z += v.y > 0 ? 1e-4 : -1e-4; v.normalize(); }
    return { pose: { name: lab, pos: t.clone().addScaledVector(v, dist).toArray(), target: t.toArray(), ortho: this.isOrtho, half: this.orthoHalf, zoom: this.camera.zoom }, source: 'angle label' };
  }
  /** depth passes (+ camera data) of every reference image that has a camera, for the UV projection of "Use reference images" */
  async refProjPasses(rt, W, H) {
    const cap = this.state.capture, passes = [], cams = [];
    if (!(cap.uvMode && cap.uvref && cap.uvref.on)) return { passes, cams };
    const cur = this.cameraPose(), crop = cap.crop.enabled;
    try {
      cap.crop.enabled = false;
      for (let n = 2; n <= 6; n++) {
        const r = this.refState(n); if (!r || !r.has || r.enabled === false) continue;
        const rp = this.refPose(n); if (!rp) continue;
        this.applyPose(rp.pose);
        const cam = this._captureCamera(W, H);
        passes.push({ n, blob: await this._renderPassToBlob(rt, cam, 1, [1, 1, 1], 0) });
        cams.push({ n, source: rp.source, camera: { view: cam.matrixWorldInverse.toArray(), proj: cam.projectionMatrix.toArray(), near: cam.near, far: cam.far,
          fov: cam.isOrthographicCamera ? 0 : cam.fov, ortho: !!cam.isOrthographicCamera, aspect: W / H, width: W, height: H, position: cam.position.toArray() } });
      }
    } finally { cap.crop.enabled = crop; this.applyPose(cur); this.invalidate(); }
    return { passes, cams };
  }
  refGotoAngle(n = this.refActive) {
    const r = this.refState(n); if (!r.cam) return false;
    const keep = this.state.bookmarks; this.state.bookmarks = [r.cam];
    try { this.gotoBookmark(0); } finally { this.state.bookmarks = keep; }
    return true;
  }

  // ---- extra reference images 3..6 (resized to max 2048; resized to max 2048, never placed or distorted) -------------
  async setRefxImage(i, file) {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, 2048 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(8, Math.round(bmp.width * k)); c.height = Math.max(8, Math.round(bmp.height * k));
    const g = c.getContext('2d'); g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close && bmp.close();
    this.refxBlobs[i] = await this._canvasToBlob(c); this.refxCanvas[i] = c;
    Object.assign(this.state.refx[i], { has: true, enabled: true, aspect: 0, fit: '', name: String(file.name || 'image ' + (i + 3)).slice(0, 60) });
    this.refxVersion++;
    if (this._renderRef2) this._renderRef2();
    this.log('ok', `Reference image ${i + 3} loaded (${c.width}x${c.height}).`);
    this._dirty('refx');
  }

  async loadRefxBlob(i, blob) {
    const bmp = await createImageBitmap(blob);
    const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0); bmp.close && bmp.close();
    this.refxBlobs[i] = blob; this.refxCanvas[i] = c; this.state.refx[i].has = true;
    this.refxVersion++;
    if (this._renderRef2) this._renderRef2();
  }

  clearRefx(i) {
    this.refxBlobs[i] = null; this.refxCanvas[i] = null;
    Object.assign(this.state.refx[i], { has: false, name: '', enabled: false });
    this.refxVersion++;
    if (this._renderRef2) this._renderRef2();
    this._dirty('refx');
  }

  clearRef2() {
    this.ref2Blob = null; this.ref2Canvas = null;
    this.state.ref2.has = false; this.state.ref2.name = ''; this.state.ref2.enabled = false;
    this.ref2Version++;
    if (this._renderRef2) this._renderRef2();
    this._dirty('ref2');
  }

  // ----------------------------------------------------------------------------------------
  // generation result (comes back from the Bake node): an RGBA layer, alpha = how well each texel was baked
  // ----------------------------------------------------------------------------------------
  /** Master resolution: a result that is larger/smaller than the layer stack resizes the stack to it (limit 4096). */
  _adoptResultSize(bmp) {
    const L = this.layers, W = bmp.width, H = bmp.height;
    if (W === L.w && H === L.h) return;
    if (Math.max(W, H) > 4096 || Math.min(W, H) < 64) { this.log('warn', `Result is ${W}x${H}; the editor keeps ${L.w}x${L.h} (limit 4096) - the result is stretched to it.`); return; }
    try {
      const old = `${L.w}x${L.h}`;
      L.resizeTo(W, H);
      this.log('ok', `Master resolution: layer stack resized ${old} -> ${W}x${H} (Undo restores it).`);
    } catch (e) { this.log('error', 'Could not resize the layer stack to the result resolution', e); }
  }

  showResult(bmp, remainingBmp, stats) {
    this._adoptResultSize(bmp);
    const c = document.createElement('canvas');
    c.width = bmp.width; c.height = bmp.height;
    c.getContext('2d').drawImage(bmp, 0, 0);
    const old = this.pending;
    this.pending = null;
    const pix = this.layers.fromImage(c);
    const prompt = String((stats && stats.prompt) || '').trim();
    this.pending = { pix, remaining: remainingBmp || null, stats: stats || {}, prompt };
    if (old) this.layers.gc();
    this.compare = true; // show the new result immediately
    this._composeDirty = true;
    this._renderBanner();
    this.invalidate();
    this.log('ok', (stats && stats.kind === 'combine' ? 'Combined texture ready (Apply / Discard).' : 'Generation result received.') + (stats && stats.summary ? ' ' + stats.summary : ''));
    if (this.state.options.autoApply) this.applyResult();
  }

  toggleCompare() {
    if (!this.pending) return;
    this.compare = !this.compare;
    this._composeDirty = true;
    this._renderBanner();
    this.invalidate();
  }

  applyResult() {
    const p = this.pending;
    if (!p) return;
    const combine = p.stats && p.stats.kind === 'combine';
    const name = combine ? (p.stats.transOnly ? 'Transition' : 'Combined') : (p.prompt ? 'AI: ' + p.prompt.slice(0, 30) : 'AI result');
    this.pending = null;
    this.compare = false;
    try {
      if (!combine && this.state.layers.replaceActive && this.layers.activeLayer) this.layers.bakeIntoActive(p.pix);
      else this.layers.addLayer(p.pix, name, { prompt: combine ? '' : p.prompt, ai: !combine });
    } catch (e) {
      this.pending = p; this.compare = true; this._composeDirty = true;
      this.log('error', 'Could not apply the result', e);
      this.setStatus(e.message, 'err');
      return;
    }
    if (p.remaining && this.state.options.clearMask) this.importMaskBitmap(p.remaining);
    this.layers.gc();
    this._renderBanner();
    this.log('ok', !combine && this.state.layers.replaceActive ? 'Result baked into the active layer.' : `Result added as layer "${name}".`);
  }

  discardResult() {
    this.pending = null;
    this.compare = false;
    this._composeDirty = true;
    this.layers.gc();
    this._renderBanner();
    this.invalidate();
  }

  // ----------------------------------------------------------------------------------------
  // model loading
  // ----------------------------------------------------------------------------------------
  async loadModelBuffer(buffer, name, { keepTexture = false, object } = {}) {
    const ext = extOf(name);
    this.setStatus('Loading ' + name + ' ...');
    const t0 = performance.now();
    try {
      const { root, kind } = await parseModel(buffer, ext);
      this._root = root; this._kind = kind;
      this.objTree = buildObjectTree(root);
      const wanted = object !== undefined ? object : (keepTexture ? ((this.state.model && this.state.model.object) || '') : '');
      const node = (this.objResolve && this.objResolve(wanted || '')) || this.objTree.root;
      const include = node === this.objTree.root ? null : ((o) => node.meshSet.has(o));
      const { geometry, info } = buildMerged(root, kind, include);
      this._objStore = new Map();
      this._modelBytes = { name, buffer };
      if (!keepTexture) this.state.xform = DEFAULT_STATE().xform;
      this._setGeometry(geometry, info);
      if (this._syncXformUI) this._syncXformUI();
      this.state.model = { name, ext, object: node.id };
      if (!keepTexture) {
        this.pending = null; this.compare = false;
        if (info.embedded) {
          try { this.setTextureFromImage(info.embedded, { label: 'model texture', keepHistory: false }); this.log('ok', 'Using the texture embedded in the model.'); }
          catch (e) { this.log('warn', 'Embedded texture could not be used; blank texture created.', e); this._resetStack({ size: 2048, color: '#c8c8c8', blank: true }); }
        } else {
          this._resetStack({ size: 2048, color: '#c8c8c8', blank: true });
        }
        this._clearRT(this.maskRT, 0);
        this._clearHistory();
        this.maskVersion++;
        if (this.pbrReset) this.pbrReset();
        if (this._initViews) this._initViews();
      }
      this.frameModel();
      try { info.warnings.push(...uvHealth(geometry)); } catch (e) { this.log('warn', 'UV health check failed', e); }
      for (const w of info.warnings) this.log('warn', w);
      this.log('ok', `Loaded ${name}: ${info.triangles.toLocaleString()} triangles, ${info.vertices.toLocaleString()} vertices (${Math.round(performance.now() - t0)} ms).`);
      this.setStatus(info.warnings[0] || `Loaded ${name}`, info.warnings.length ? 'warn' : 'ok');
      this._dirty('model');
      this._renderStats();
      if (this._objectsChanged) this._objectsChanged();
    } catch (e) {
      this.log('error', `Could not load "${name}"`, e);
      this.setStatus(`Could not load "${name}": ${e.message}`, 'err');
      throw e;
    }
  }

  _setGeometry(geometry, info) {
    if (this.mesh) { this.scene.remove(this.mesh); this.scene.remove(this.wireMesh); this.geometry.dispose(); }
    if (this.depthMesh) this.depthScene.remove(this.depthMesh);
    if (this.paintMesh) this.paintScene.remove(this.paintMesh);
    if (this.passMesh) this.passScene.remove(this.passMesh);
    if (this.uvLines) { this.uvScene.remove(this.uvLines); this.uvLines.geometry.dispose(); }
    this.geometry = geometry;
    this.info = info;
    this.base = { pos: geometry.attributes.position.array.slice(), nrm: geometry.attributes.normal.array.slice(), idx: geometry.index.array.slice() };
    this.meshHash = hashGeometry(geometry);
    this.mesh = new THREE.Mesh(geometry, this.meshMat);
    this.mesh.frustumCulled = false;
    this.wireMesh = new THREE.Mesh(geometry, this.wireMat);
    this.wireMesh.frustumCulled = false;
    this.wireMesh.visible = !!this.state.display.wire3d;
    this.scene.add(this.mesh, this.wireMesh);
    this.depthMesh = new THREE.Mesh(geometry, this.depthMat); this.depthMesh.frustumCulled = false; this.depthScene.add(this.depthMesh);
    this.paintMesh = new THREE.Mesh(geometry, this.paintMat); this.paintMesh.frustumCulled = false; this.paintScene.add(this.paintMesh);
    this.passMesh = new THREE.Mesh(geometry, this.passMat); this.passMesh.frustumCulled = false; this.passScene.add(this.passMesh);
    if (this.coverMesh) this.coverScene.remove(this.coverMesh);
    this.coverMesh = new THREE.Mesh(geometry, this.layers.coverMat); this.coverMesh.frustumCulled = false; this.coverScene.add(this.coverMesh);
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(buildUVLines(geometry), 3));
    this.uvLines = new THREE.LineSegments(lg, this.uvLineMat);
    this.uvLines.frustumCulled = false;
    this.uvLines.renderOrder = 2;
    this.uvScene.add(this.uvLines);
    this.ui.empty.style.display = 'none';
    this.applyTransform();
    this.invalidate();
  }

  // ----------------------------------------------------------------------------------------
  // model transform (rotate / scale / flip / offset) - baked into the vertex data so painting,
  // capture and the Python bake all see exactly the same mesh. The mask lives in UV space and
  // is therefore not affected.
  // ----------------------------------------------------------------------------------------
  _xformMatrix() {
    const x = this.state.xform, d = Math.PI / 180;
    const sc = Math.max(0.01, Number(x.s) || 1);
    return new THREE.Matrix4().compose(
      new THREE.Vector3(x.ox, x.oy, x.oz),
      new THREE.Quaternion().setFromEuler(new THREE.Euler(x.rx * d, x.ry * d, x.rz * d, 'XYZ')),
      new THREE.Vector3(sc * (x.fx ? -1 : 1), sc * (x.fy ? -1 : 1), sc * (x.fz ? -1 : 1))
    );
  }

  applyTransform() {
    if (!this.geometry || !this.base) return;
    const m = this._xformMatrix(), e = m.elements;
    const ne = new THREE.Matrix3().getNormalMatrix(m).elements;
    const P = this.geometry.attributes.position, N = this.geometry.attributes.normal;
    const bp = this.base.pos, bn = this.base.nrm, p = P.array, n = N.array;
    let r2 = 0, raw2 = 0;
    for (let i = 0; i < bp.length; i += 3) {
      const x = bp[i], y = bp[i + 1], z = bp[i + 2];
      const tx = e[0] * x + e[4] * y + e[8] * z, ty = e[1] * x + e[5] * y + e[9] * z, tz = e[2] * x + e[6] * y + e[10] * z;
      const rr = tx * tx + ty * ty + tz * tz; if (rr > raw2) raw2 = rr;
      const px = tx + e[12], py = ty + e[13], pz = tz + e[14];
      p[i] = px; p[i + 1] = py; p[i + 2] = pz;
      const q = px * px + py * py + pz * pz; if (q > r2) r2 = q;
      const a = bn[i], b = bn[i + 1], c = bn[i + 2];
      let nx = ne[0] * a + ne[3] * b + ne[6] * c, ny = ne[1] * a + ne[4] * b + ne[7] * c, nz = ne[2] * a + ne[5] * b + ne[8] * c;
      const l = Math.hypot(nx, ny, nz) || 1;
      n[i] = nx / l; n[i + 1] = ny / l; n[i + 2] = nz / l;
    }
    // a mirror (negative determinant) flips the triangle winding: swap two indices per triangle
    const idx = this.geometry.index.array, bi = this.base.idx;
    idx.set(bi);
    if (m.determinant() < 0) for (let t = 0; t + 2 < idx.length; t += 3) { const k = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = k; }
    P.needsUpdate = true; N.needsUpdate = true; this.geometry.index.needsUpdate = true;
    this.geometry.computeBoundingSphere(); this.geometry.computeBoundingBox();
    this.modelRadius = Math.max(1, Math.sqrt(r2));
    this.rawRadius = Math.sqrt(raw2) || 1;
    this.meshHash = hashGeometry(this.geometry);
    if (this._updateCtx) this._updateCtx();
    this.invalidate();
  }

  setXform(patch, { fit = false } = {}) {
    Object.assign(this.state.xform, patch);
    const x = this.state.xform;
    if (fit) { this.applyTransform(); x.s = Math.min(3, Math.max(0.1, +(x.s / this.rawRadius).toFixed(3))); }
    for (const k of ['rx', 'ry', 'rz']) { let v = ((x[k] + 180) % 360 + 360) % 360 - 180; x[k] = Math.round(v * 10) / 10; }
    this.applyTransform();
    if (this._syncXformUI) this._syncXformUI();
    this._dirty('xform');
  }

  resetXform() { this.setXform(DEFAULT_STATE().xform); this.setStatus('Model transform reset.', 'ok'); }

  get hasModel() { return !!this.geometry; }

  /** Unit vector from the model towards the camera (used for facing tests in orthographic views). */
  _camDir() { return this.camera.position.clone().sub(this.controls.target).normalize(); }

  _setAspect(cam, w, h) {
    const a = w / h;
    if (cam.isOrthographicCamera) {
      const hh = this.orthoHalf;
      if (Math.abs(cam.right - hh * a) > 1e-6 || Math.abs(cam.top - hh) > 1e-6) {
        cam.left = -hh * a; cam.right = hh * a; cam.top = hh; cam.bottom = -hh;
        cam.updateProjectionMatrix();
      }
    } else if (Math.abs(cam.aspect - a) > 1e-6) { cam.aspect = a; cam.updateProjectionMatrix(); }
  }

  get isOrtho() { return !!this.camera.isOrthographicCamera; }

  /** Switch between perspective and orthographic, keeping the same framing (visible height at the target). */
  setOrtho(on) {
    on = !!on;
    if (on === this.isOrtho) return;
    const from = this.camera, to = on ? this.orthoCam : this.perspCam;
    const dist = Math.max(0.05, from.position.distanceTo(this.controls.target));
    const tanH = Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2);
    if (on) { this.orthoHalf = dist * tanH; to.zoom = 1; }
    const dist2 = on ? dist : (this.orthoHalf / (from.zoom || 1)) / tanH;
    to.position.copy(this.controls.target).addScaledVector(this._camDir(), dist2);
    to.up.copy(from.up);
    to.near = 0.02; to.far = 60;
    this.camera = to;
    this.controls.object = to;
    to.lookAt(this.controls.target);
    to.updateProjectionMatrix();
    this.controls.update();
    this._cameraTouched();
    if (this.hooks.onViewChanged) this.hooks.onViewChanged();
    this.invalidate();
  }

  /** Smoothly looks at the model from a direction (world vector pointing from the model to the camera). */
  viewFrom(dir, ms = 260) {
    const d1 = dir.clone().normalize();
    if (Math.abs(d1.y) > 0.9999) { d1.x += 1e-4; d1.z += d1.y > 0 ? 1e-4 : -1e-4; d1.normalize(); }
    const t = this.controls.target.clone();
    const dist = Math.max(0.05, this.camera.position.distanceTo(t));
    const d0 = this._camDir();
    const q = new THREE.Quaternion().setFromUnitVectors(d0, d1);
    const id = new THREE.Quaternion();
    const start = performance.now();
    cancelAnimationFrame(this._viewAnim);
    const step = (now) => {
      if (this.disposed) return;
      const k = Math.min(1, (now - start) / ms), e = k * k * (3 - 2 * k);
      const qq = id.clone().slerp(q, e);
      this.camera.position.copy(t).addScaledVector(d0.clone().applyQuaternion(qq), dist);
      this.camera.lookAt(t);
      this.controls.update();
      this.invalidate();
      if (k < 1) this._viewAnim = requestAnimationFrame(step);
    };
    this._viewAnim = requestAnimationFrame(step);
  }

  setTurntable(on, speed = 2) {
    this.controls.autoRotate = !!on;
    this.controls.autoRotateSpeed = speed;
    cancelAnimationFrame(this._turnAnim);
    if (on) {
      const loop = () => { if (this.disposed || !this.controls.autoRotate) return; this.controls.update(); this._turnAnim = requestAnimationFrame(loop); };
      this._turnAnim = requestAnimationFrame(loop);
    }
  }
  get turntable() { return !!this.controls.autoRotate; }

  saveBookmark(name) {
    const b = this.state.bookmarks;
    if (b.length >= 24) { this.setStatus('Max 24 saved views - delete one first.', 'warn'); return false; }
    b.push({ name: name || 'View ' + (b.length + 1), pos: this.camera.position.toArray(), target: this.controls.target.toArray(), ortho: this.isOrtho, half: this.orthoHalf, zoom: this.camera.zoom });
    this._dirty('settings');
    if (this.hooks.onViewChanged) this.hooks.onViewChanged();
    return true;
  }

  gotoBookmark(i) {
    const b = this.state.bookmarks[i];
    if (!b) return;
    this.setOrtho(!!b.ortho);
    if (b.ortho) { this.orthoHalf = b.half || this.orthoHalf; this.camera.zoom = b.zoom || 1; }
    this.controls.target.fromArray(b.target);
    this.camera.position.fromArray(b.pos);
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.invalidate();
  }

  deleteBookmark(i) { this.state.bookmarks.splice(i, 1); this._dirty('settings'); if (this.hooks.onViewChanged) this.hooks.onViewChanged(); }

  frameModel() {
    const dir = new THREE.Vector3(0.35, 0.3, 1).normalize();
    this.controls.target.set(0, 0, 0);
    this.camera.position.copy(dir.multiplyScalar(3.3));
    if (this.isOrtho) { this.orthoHalf = 3.3 * Math.tan(THREE.MathUtils.degToRad(this.perspCam.fov) / 2); this.camera.zoom = 1; }
    this.camera.near = 0.02;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.uvView = { cx: 0.5, cy: 0.5, zoom: 1 };
    this.invalidate();
  }

  /** Fit the whole working object to the 3D pane (button / Home); frameModel stays the default home view used on load. */
  fitWhole() {
    if (!this.hasModel || !this.mesh) return this.frameModel();
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.mesh);
    if (box.isEmpty()) return this.frameModel();
    this._fitBox(box, 0.2);
  }

  frameMask() {
    if (!this.hasModel) return;
    const S = this.maskSize;
    const px = this._readMaskPixels();
    const pos = this.geometry.attributes.position.array;
    const uv = this.geometry.attributes.uv.array;
    const idx = this.geometry.index.array;
    const box = new THREE.Box3();
    const p = new THREE.Vector3();
    let any = false;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      const u = (uv[a * 2] + uv[b * 2] + uv[c * 2]) / 3;
      const v = (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[c * 2 + 1]) / 3;
      const ix = Math.min(S - 1, Math.max(0, Math.floor(u * S)));
      const iy = Math.min(S - 1, Math.max(0, Math.floor(v * S)));
      if (px[(iy * S + ix) * 4] > 40) {
        p.set((pos[a * 3] + pos[b * 3] + pos[c * 3]) / 3, (pos[a * 3 + 1] + pos[b * 3 + 1] + pos[c * 3 + 1]) / 3, (pos[a * 3 + 2] + pos[b * 3 + 2] + pos[c * 3 + 2]) / 3);
        box.expandByPoint(p);
        any = true;
      }
    }
    if (!any) { this.setStatus('Mask is empty - nothing to frame.', 'warn'); return; }
    this._fitBox(box, 0.08);
  }

  /** Points the camera at a world-space box so it fills the 3D pane (honours the pane aspect, perspective and ortho). */
  _fitBox(box, minRadius = 0.08) {
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(minRadius, box.getSize(new THREE.Vector3()).length() / 2);
    const pane = this.ui.pane3d, aspect = Math.max(0.2, (pane.offsetWidth || 1) / (pane.offsetHeight || 1));
    const vh = THREE.MathUtils.degToRad(this.perspCam.fov) / 2, hh = Math.atan(Math.tan(vh) * aspect);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    const dist = Math.max(0.4, (radius / Math.sin(Math.min(vh, hh))) * 1.15);
    this.controls.target.copy(center);
    this.camera.position.copy(center).addScaledVector(dir, dist);
    if (this.isOrtho) { this.orthoHalf = (radius * 1.15) / Math.min(1, aspect); this.camera.zoom = 1; }
    this.camera.near = 0.02;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this._cameraTouched && this._cameraTouched();
    this.invalidate();
  }

  /** Fit the working object together with every visible context object (hierarchy panel). */
  frameAll() {
    if (!this.hasModel) return;
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(this.mesh);
    this.scene.traverse((o) => {
      if (o.isMesh && o !== this.mesh && o !== this.wireMesh && o.visible && o.userData && o.userData.leaf !== undefined) box.union(new THREE.Box3().setFromObject(o));
    });
    if (box.isEmpty()) return;
    this._fitBox(box, 0.2);
  }

  // ----------------------------------------------------------------------------------------
  // projective painting
  // ----------------------------------------------------------------------------------------
  _paneSize(el) { return { w: Math.max(1, el.offsetWidth), h: Math.max(1, el.offsetHeight) }; }

  _ensureDepthRT(w, h) {
    if (this.depthRT && this.depthRT.width === w && this.depthRT.height === h) return;
    if (this.depthRT) { this.depthRT.depthTexture.dispose(); this.depthRT.dispose(); }
    const dt = new THREE.DepthTexture(w, h);
    dt.type = THREE.UnsignedIntType;
    dt.minFilter = dt.magFilter = THREE.NearestFilter;
    this.depthRT = new THREE.WebGLRenderTarget(w, h, { depthBuffer: true, depthTexture: dt, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false });
  }

  _syncCamera() {
    const { w, h } = this._paneSize(this.ui.pane3d);
    this._setAspect(this.camera, w, h);
    this.camera.updateMatrixWorld(true);
  }

  /** Renders the model depth from the current camera into depthRT (used by the projective brush and the view map). */
  _depthPass(w, h) {
    this._syncCamera();
    this._ensureDepthRT(w, h);
    const r = this.renderer;
    const prevT = r.getRenderTarget(), prevS = r.getScissorTest();
    r.setRenderTarget(this.depthRT);
    r.setScissorTest(false);
    const prevC = new THREE.Color(); r.getClearColor(prevC); const prevA = r.getClearAlpha();
    r.setClearColor(0x000000, 1);
    r.clear(true, true, false);
    r.render(this.depthScene, this.camera);
    r.setClearColor(prevC, prevA);
    r.setRenderTarget(prevT);
    r.setScissorTest(prevS);
  }

  /** UV-space map of how directly the CURRENT camera sees each texel (0 = hidden / back-facing, 255 = head-on). Uint8Array, top row first. */
  viewFacingMap() {
    if (!this.hasModel || !this.info.hasUV) return null;
    const W = this.layers.w, H = this.layers.h, { w, h } = this._paneSize(this.ui.pane3d);
    this._depthPass(w, h);
    if (!this.facingMat) this.facingMat = this.paintMat.clone();   // same max-blending as the brush: overlapping UVs keep the best-facing value
    const u = this.facingMat.uniforms;
    u.uVP.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    u.uCam.value.copy(this.camera.position);
    u.uOrtho.value = this.camera.isOrthographicCamera ? 1 : 0;
    u.uCamDir.value.copy(this._camDir());
    u.uCenter.value.set(w / 2, h / 2); u.uSize.value.set(w, h); u.uRadius.value = 1e9; u.uUseShape.value = 0; u.uOpacity.value = 1;
    u.uDepth.value = this.depthRT.depthTexture; u.uNear.value = this.camera.near; u.uFar.value = this.camera.far; u.uBias.value = 0.006;
    u.uFacingMin.value = 0; u.uOutFacing.value = 1;
    const rt = this.layers._rt(W, H, 'rgba8', { nearest: true });
    const r = this.renderer, prevT = r.getRenderTarget(), prevS = r.getScissorTest(), prevM = this.paintMesh.material;
    const prevC = new THREE.Color(); r.getClearColor(prevC); const prevA = r.getClearAlpha();
    r.setRenderTarget(rt); r.setScissorTest(false); r.setClearColor(0x000000, 1); r.clear(true, false, false);
    this.paintMesh.material = this.facingMat;
    r.render(this.paintScene, this.quadCam);
    this.paintMesh.material = prevM;
    const buf = new Uint8Array(W * H * 4);
    r.readRenderTargetPixels(rt, 0, 0, W, H, buf);
    r.setRenderTarget(prevT); r.setScissorTest(prevS); r.setClearColor(prevC, prevA);
    rt.dispose();
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const src = (H - 1 - y) * W * 4; for (let x = 0; x < W; x++) out[y * W + x] = buf[src + x * 4]; }
    return out;
  }

  beginStroke(erase) {
    if (!this.hasModel || !this.info.hasUV) return false;
    const { w, h } = this._paneSize(this.ui.pane3d);
    this._depthPass(w, h);
    let target = this.maskRT;
    const layer = this.state.brushTarget === 'layer';
    const trans = this.state.brushTarget === 'transition';
    const heal = this.state.brushTarget === 'heal';
    const view = this.state.brushTarget === 'view' && this.viewRT.length > 0;
    if (view) {
      const vi = this.state.views.active; this._pushViewUndo(vi);
      target = this.viewRT[vi];
    } else if (heal) {
      this._pushHealUndo();
      target = this.healRT;
    } else if (trans) {
      this._pushTransUndo();
      target = this.transRT;
    } else if (layer) {
      const L = this.layers.activeLayer;
      if (!L) { this.setStatus('No active layer.', 'warn'); return false; }
      if (L.locked) { this.setStatus('The active layer is locked.', 'warn'); return false; }
      this._pushLayerUndo();
      target = this.layers.cowMask(L); // copy-on-write: older undo states keep the previous mask
    } else {
      this._pushUndo();
    }
    this.stroke = { erase, w, h, last: null, smooth: null, pending: false, target, layer, trans, heal, view, vi: view ? this.state.views.active : -1 };
    return true;
  }

  /** One dab. x,y in pane pixels (origin top-left). */
  _dab(x, y, pressure) {
    const s = this.stroke;
    const t = s.erase ? this.state.erase : this.state.brush;
    let rad = t.size * 0.5;
    let op = t.opacity;
    if (this.state.pen && pressure > 0 && pressure < 1) { rad *= 0.25 + 0.75 * pressure; op *= 0.3 + 0.7 * pressure; }
    const mat = s.erase ? this.eraseMat : this.paintMat;
    const u = mat.uniforms;
    u.uVP.value.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse);
    u.uCam.value.copy(this.camera.position);
    u.uOrtho.value = this.camera.isOrthographicCamera ? 1 : 0;
    u.uCamDir.value.copy(this._camDir());
    u.uCenter.value.set(x, s.h - y);
    u.uSize.value.set(s.w, s.h);
    u.uRadius.value = Math.max(0.5, rad);
    u.uHardness.value = t.hardness;
    u.uSoft.value = t.softness;
    u.uOpacity.value = op;
    u.uDepth.value = this.depthRT.depthTexture;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;
    u.uBias.value = 0.006;
    this.paintMesh.material = mat;
    const r = this.renderer;
    const prevT = r.getRenderTarget(), prevS = r.getScissorTest();
    r.setRenderTarget(s.target || this.maskRT);
    r.setScissorTest(false);
    r.render(this.paintScene, this.quadCam);
    r.setRenderTarget(prevT);
    r.setScissorTest(prevS);
    if (s.layer) this._composeDirty = true;
    this.invalidate();
  }

  /** Fills a screen-space shape (canvas the size of the 3D pane, white = inside) onto the visible surface. */
  fillShape(canvas, erase) {
    if (!this.beginStroke(erase)) return false;
    const tex = new THREE.CanvasTexture(canvas);
    tex.minFilter = tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
    const u = (erase ? this.eraseMat : this.paintMat).uniforms;
    u.uShape.value = tex; u.uUseShape.value = 1;
    const o = this.state.pen; this.state.pen = false;
    try { this._dab(this.stroke.w / 2, this.stroke.h / 2, 0); } finally { u.uUseShape.value = 0; u.uShape.value = null; tex.dispose(); this.state.pen = o; }
    this.endStroke();
    return true;
  }

  strokeMove(x, y, pressure) {
    const s = this.stroke;
    if (!s) return;
    const t = s.erase ? this.state.erase : this.state.brush;
    if (!s.smooth) { s.smooth = { x, y }; s.last = { x, y }; this._dab(x, y, pressure); return; }
    const k = 1 - Math.min(0.95, t.stab * 0.95);
    s.smooth.x += (x - s.smooth.x) * k;
    s.smooth.y += (y - s.smooth.y) * k;
    const step = Math.max(1, t.spacing * t.size);
    let dx = s.smooth.x - s.last.x, dy = s.smooth.y - s.last.y;
    let d = Math.hypot(dx, dy);
    let guard = 0;
    while (d >= step && guard++ < 400) {
      const f = step / d;
      s.last.x += dx * f; s.last.y += dy * f;
      this._dab(s.last.x, s.last.y, pressure);
      dx = s.smooth.x - s.last.x; dy = s.smooth.y - s.last.y; d = Math.hypot(dx, dy);
    }
  }

  endStroke() {
    if (!this.stroke) return;
    const layer = this.stroke.layer, trans = this.stroke.trans, heal = this.stroke.heal;
    const view = this.stroke.view, vi = this.stroke.vi;
    this.stroke = null;
    if (view) this._viewsChanged(vi); else if (heal) this._healChanged(); else if (trans) this._transChanged(); else if (layer) this._layersChanged(); else this._maskChanged();
  }

  // ----------------------------------------------------------------------------------------
  // capture (the passes consumed by the Python nodes)
  // ----------------------------------------------------------------------------------------
  captureSize() {
    const cap = this.state.capture;
    const [aw, ah] = cap.aspect.split(':').map(Number);
    let W, H;
    if (aw >= ah) { W = cap.long; H = cap.long * ah / aw; } else { H = cap.long; W = cap.long * aw / ah; }
    const snap = (v) => Math.max(64, Math.round(v / 16) * 16);
    return [snap(W), snap(H)];
  }

  /** Largest rectangle with the capture aspect that fits inside the 3D pane (pane pixels). */
  frameRect(w, h) {
    const [cw, ch] = this.captureSize();
    const A = cw / ch;
    let fw = Math.min(w, h * A);
    let fh = fw / A;
    return { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };
  }

  _captureCamera(W, H) {
    this._syncCamera();
    const { w, h } = this._paneSize(this.ui.pane3d);
    const fr = this.frameRect(w, h);
    const cam = this.camera.clone();
    if (cam.isOrthographicCamera) {
      const hh = (this.orthoHalf / (this.camera.zoom || 1)) * (fr.h / h);
      cam.zoom = 1; cam.top = hh; cam.bottom = -hh; cam.left = -hh * (W / H); cam.right = hh * (W / H);
    } else {
      cam.aspect = W / H;
      const tanHalf = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * (fr.h / h);
      cam.fov = THREE.MathUtils.radToDeg(2 * Math.atan(tanHalf));
    }
    const dist = cam.position.length();
    const reach = (this.modelRadius || 1) + 0.15;
    cam.near = Math.max(0.01, dist - reach);
    cam.far = dist + reach;
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    const crop = this.cropRegion(cam);
    if (crop) {
      // zoom the frustum onto the masked area: an affine map of NDC x/y keeps the pixel aspect and all depth values
      const s = 2 / crop.d;
      const M = new THREE.Matrix4().set(s, 0, 0, -crop.cx * s, 0, s, 0, -crop.cy * s, 0, 0, 1, 0, 0, 0, 0, 1);
      cam.projectionMatrix.premultiply(M);
      cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    }
    return cam;
  }

  /** NDC square (centre cx,cy, size d, in the un-cropped capture view) that contains the painted mask, or null. */
  cropRegion(cam) {
    const c = this.state.capture.crop;
    if (!c || !c.enabled || !this.hasModel) return null;
    const key = [this.maskVersion, this.meshHash, cam.projectionMatrix.elements.join(','), cam.matrixWorldInverse.elements.join(','), c.margin].join('|');
    if (this._cropKey === key) return this._cropVal;
    const S = this.maskSize, px = this._readMaskPixels();
    const pos = this.geometry.attributes.position.array, uv = this.geometry.attributes.uv.array, idx = this.geometry.index.array;
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, any = false;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], d = idx[t + 2];
      const u = (uv[a * 2] + uv[b * 2] + uv[d * 2]) / 3, v = (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[d * 2 + 1]) / 3;
      const ix = Math.min(S - 1, Math.max(0, Math.floor(u * S))), iy = Math.min(S - 1, Math.max(0, Math.floor(v * S)));
      if (px[(iy * S + ix) * 4] < 40) continue;
      for (const k of [a, b, d]) {   // all three corners, so the triangle is fully inside the crop
        const X = pos[k * 3], Y = pos[k * 3 + 1], Z = pos[k * 3 + 2];
        const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
        if (w <= 1e-6) continue;
        const nx = (m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w, ny = (m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w;
        if (nx < x0) x0 = nx; if (nx > x1) x1 = nx; if (ny < y0) y0 = ny; if (ny > y1) y1 = ny; any = true;
      }
    }
    let val = null;
    if (any) {
      x0 = Math.max(-1, x0); x1 = Math.min(1, x1); y0 = Math.max(-1, y0); y1 = Math.min(1, y1);
      if (x1 > x0 && y1 > y0) {
        let d = Math.max(x1 - x0, y1 - y0) * (1 + 2 * Math.max(0, Math.min(0.5, c.margin)));
        d = Math.max(0.18, d);
        if (d < 1.98) {
          let cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
          cx = Math.min(1 - d / 2, Math.max(-1 + d / 2, cx)); cy = Math.min(1 - d / 2, Math.max(-1 + d / 2, cy));
          val = { cx, cy, d, zoom: 2 / d };
        }
      }
    }
    this._cropKey = key; this._cropVal = val;
    return val;
  }

  /** NDC box (x0,x1,y0,y1 of the uncropped capture frame, -1..1) around everything that is painted, or null. */
  maskBox() {
    if (!this.hasModel || this.maskIsEmpty()) return null;
    const [W, H] = this.captureSize();
    const saved = this.state.capture.crop.enabled; this.state.capture.crop.enabled = false;
    let cam; try { cam = this._captureCamera(W, H); } finally { this.state.capture.crop.enabled = saved; }
    const S = this.maskSize, px = this._readMaskPixels();
    const pos = this.geometry.attributes.position.array, uv = this.geometry.attributes.uv.array, idx = this.geometry.index.array;
    const m = new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse).elements;
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], d = idx[t + 2];
      const u = (uv[a * 2] + uv[b * 2] + uv[d * 2]) / 3, v = (uv[a * 2 + 1] + uv[b * 2 + 1] + uv[d * 2 + 1]) / 3;
      if (px[(Math.min(S - 1, Math.max(0, Math.floor(v * S))) * S + Math.min(S - 1, Math.max(0, Math.floor(u * S)))) * 4] < 40) continue;
      for (const k of [a, b, d]) {
        const X = pos[k * 3], Y = pos[k * 3 + 1], Z = pos[k * 3 + 2];
        const w = m[3] * X + m[7] * Y + m[11] * Z + m[15];
        if (w <= 1e-6) continue;
        const nx = (m[0] * X + m[4] * Y + m[8] * Z + m[12]) / w, ny = (m[1] * X + m[5] * Y + m[9] * Z + m[13]) / w;
        if (nx < x0) x0 = nx; if (nx > x1) x1 = nx; if (ny < y0) y0 = ny; if (ny > y1) y1 = ny;
      }
    }
    if (!(x1 > x0 && y1 > y0)) return null;
    return { x0: Math.max(-1, x0), x1: Math.min(1, x1), y0: Math.max(-1, y0), y1: Math.min(1, y1), aspect: W / H };
  }

  /** The capture camera before cropping, for the HUD (same maths as _captureCamera without the crop). */
  cropRect(w, h) {
    if (!this.state.capture.crop.enabled || !this.hasModel) return null;
    const [W, H] = this.captureSize();
    const saved = this.state.capture.crop.enabled;
    this.state.capture.crop.enabled = false;
    let cam; try { cam = this._captureCamera(W, H); } finally { this.state.capture.crop.enabled = saved; }
    const cr = this.cropRegion(cam);
    if (!cr) return null;
    const fr = this.frameRect(w, h);
    return { x: fr.x + ((cr.cx - cr.d / 2 + 1) / 2) * fr.w, y: fr.y + ((1 - (cr.cy + cr.d / 2)) / 2) * fr.h, w: (cr.d / 2) * fr.w, h: (cr.d / 2) * fr.h, zoom: cr.zoom };
  }

  _renderPassToBlob(rt, cam, mode, clearRGB, shade) {
    const r = this.renderer;
    const u = this.passMat.uniforms;
    u.uMode.value = mode;
    u.uShade.value = shade;
    u.uNear.value = cam.near;
    u.uFar.value = cam.far;
    const prevT = r.getRenderTarget(), prevS = r.getScissorTest();
    const prevC = new THREE.Color(); r.getClearColor(prevC); const prevA = r.getClearAlpha();
    r.setRenderTarget(rt);
    r.setScissorTest(false);
    r.setClearColor(new THREE.Color().setRGB(clearRGB[0], clearRGB[1], clearRGB[2], THREE.LinearSRGBColorSpace), 1);
    r.clear(true, true, false);
    r.render(this.passScene, cam);
    const buf = new Uint8Array(rt.width * rt.height * 4);
    r.readRenderTargetPixels(rt, 0, 0, rt.width, rt.height, buf);
    r.setClearColor(prevC, prevA);
    r.setRenderTarget(prevT);
    r.setScissorTest(prevS);
    return this._canvasToBlob(this._pixelsToCanvas(buf, rt.width, rt.height));
  }

  /**
   * Renders view / mask / depth / normal for the current camera and returns everything the backend needs.
   * includeMesh / includeTexture can be false when the server already holds the latest copy.
   */
  async capture({ includeMesh = true, includeTexture = true } = {}) {
    if (!this.hasModel) throw new Error('No model loaded in the Texture Painter node.');
    if (!this.info.hasUV) throw new Error('The loaded model has no UV coordinates.');
    const cap = this.state.capture;
    const [W, H] = this.captureSize();
    const cam = this._captureCamera(W, H);
    this.layers.composeCapture(this.state.layers.captureSource);
    this._bindTexture();
    const bg = hexToRaw(cap.bg);
    const rtMS = new THREE.WebGLRenderTarget(W, H, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, samples: 4, generateMipmaps: false });
    const rt = new THREE.WebGLRenderTarget(W, H, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: true, generateMipmaps: false });
    const out = {};
    let refCams = [];
    const useHeal = !!(this.state.heal && this.state.heal.on);   // Heal run: the dark-green heal area is the AI mask, the heal prompt the only prompt
    const useTr = useHeal || this.state.gen.maskSource === 'transition';
    if (useTr) {
      this.passMat.uniforms.tMask.value = (useHeal ? this.healRT : this.transRT).texture;   // the view mask pass (and the bake mask) come from the heal / blue transition mask
      if (useHeal ? this.healIsEmpty() : this.transIsEmpty()) this.log('warn', useHeal ? 'Heal run is on, but the dark-green heal area is empty - paint it first (J).' : 'The AI is set to use the blue transition mask, but it is empty - paint it first.');
    }
    try {
      const shade = cap.shading === 'soft' ? 0.35 : 0;
      const refMeshes = this.objRefMeshes ? this.objRefMeshes() : null;
      if (refMeshes) for (const k of refMeshes) this.passScene.add(k);
      try { out.view = await this._renderPassToBlob(rtMS, cam, 0, bg, shade); }
      finally { if (refMeshes) { for (const k of refMeshes) this.passScene.remove(k); this.objRefDispose(refMeshes); } }
      out.viewmask = await this._renderPassToBlob(rt, cam, 3, [0, 0, 0], 0);
      out.depth = await this._renderPassToBlob(rt, cam, 1, [1, 1, 1], 0);
      out.normal = await this._renderPassToBlob(rt, cam, 2, [0.5, 0.5, 1], 0);
      out.viewrgn = this.viewRegionPasses ? await this.viewRegionPasses(rt, cam) : [];   // [{i, blob}]
      { const rp = await this.refProjPasses(rt, W, H); out.refdepth = rp.passes; refCams = rp.cams; }
    } finally {
      rtMS.dispose(); rt.dispose();
      this.passMat.uniforms.tMask.value = this.maskRT.texture;
    }
    out.uvmask = await this.exportMaskBlob();
    if (useTr) out.bakemask = useHeal ? await this.exportHealBlob() : await this.exportTransBlob();
    if (includeTexture) out.texture = await this._canvasToBlob(this.layers.toCanvas(this.layers.cap));
    if (this.ref2Blob) out.ref2 = this.ref2Blob;
    for (let i = 0; i < 4; i++) if (this.refxBlobs[i]) out['ref' + (i + 3)] = this.refxBlobs[i];
    if (this.state.plan.seam && this.getCoverage) {
      const cv = this.getCoverage();
      if (cv && cv.max > 0) out.prevconf = await this._canvasToBlob(this._grayCanvas(cv.cov, this.layers.w, this.layers.h));
    }
    if (includeMesh) out.mesh = new Blob([serializeMesh(this.geometry, this.meshHash)], { type: 'application/octet-stream' });
    out.meta = {
      version: 1,
      mesh_hash: this.meshHash,
      view_size: [W, H],
      tex_size: [this.layers.w, this.layers.h],
      capture_source: this.state.layers.captureSource,
      ref2: { ...this.state.ref2, has: !!this.ref2Blob },
      mask_source: useTr ? 'transition' : 'selection',
      heal: useHeal ? { on: true, prompt: String(this.state.heal.prompt || '') } : null,
      view_regions: [0, 1, 2, 3].map((i) => !!(out.viewrgn && out.viewrgn.some((r) => r.i === i))),
      refx: this.state.refx.map((r, i) => ({ ...r, has: !!this.refxBlobs[i] })),
      gen: { steps: this.state.gen.steps, cfg: this.state.gen.cfg },
      seam: { enabled: !!(this.state.plan.seam && out.prevconf) },
      blend: { ...this.state.blend },
      crop: (() => { const cr = this.state.capture.crop.enabled ? this._cropVal : null; return { enabled: !!this.state.capture.crop.enabled, cx: cr ? cr.cx : 0, cy: cr ? cr.cy : 0, d: cr ? cr.d : 2 }; })(),
      facing: cap.facing,
      uv_mode: !!cap.uvMode,
      tile: (cap.uvMode && cap.tile && cap.tile.on && !useHeal) ? { ...cap.tile, index: this._tileRun ? this._tileRun.index : -1, done: this._tileRun ? this._tileRun.done : [] } : null,
      tile_long: cap.long,
      uvref: (cap.uvMode && cap.uvref && cap.uvref.on && !useHeal) ? { ...cap.uvref } : null,
      ref_cams: refCams,
      ctx_reference: !!(this.state.objTex && this.state.objTex.ref),
      shading: cap.shading,
      bg: cap.bg,
      camera: {
        view: cam.matrixWorldInverse.toArray(),
        proj: cam.projectionMatrix.toArray(),
        near: cam.near,
        far: cam.far,
        fov: cam.isOrthographicCamera ? 0 : cam.fov,
        ortho: !!cam.isOrthographicCamera,
        aspect: W / H,
        width: W,
        height: H,
        position: cam.position.toArray(),
      },
      model: this.state.model,
      triangles: this.info.triangles,
      texture_version: this.textureVersion,
    };
    return out;
  }

  // ----------------------------------------------------------------------------------------
  // state
  // ----------------------------------------------------------------------------------------
  getState() {
    const s = JSON.parse(JSON.stringify(this.state));
    s.layerStack = this.layers.serialize();
    if (this.objectStates) s.objStates = this.objectStates();
    if (this.camera) {
      s.camera = { pos: this.camera.position.toArray().map((v) => +v.toFixed(5)), target: this.controls.target.toArray().map((v) => +v.toFixed(5)), fov: this.perspCam.fov, ortho: this.isOrtho, half: this.orthoHalf, zoom: this.camera.zoom };
    }
    return s;
  }

  applyState(s) {
    if (!s || typeof s !== 'object') return;
    const { layerStack, objStates, ...rest } = s; // the layer lists are restored separately (restoreLayers / seedObjectStates)
    void layerStack; void objStates;
    deepMerge(this.state, rest);
    this._normRefx();
    this._applyStateToUI();
    if (s.camera && s.camera.pos && s.camera.target) {
      if (!!s.camera.ortho !== this.isOrtho) this.setOrtho(!!s.camera.ortho);
      if (s.camera.half) this.orthoHalf = s.camera.half;
      if (s.camera.zoom && this.isOrtho) this.camera.zoom = s.camera.zoom;
      this.camera.position.fromArray(s.camera.pos);
      this.controls.target.fromArray(s.camera.target);
      if (s.camera.fov) this.perspCam.fov = s.camera.fov;
      this.camera.updateProjectionMatrix();
      this.controls.update();
    }
    this.invalidate();
  }

  _cameraTouched() { this._dirty('camera'); }

  _dirty(kind) {
    if (this.hooks.onDirty) this.hooks.onDirty(kind);
    clearTimeout(this._emitTimer);
    this._emitTimer = setTimeout(() => { if (this.hooks.onState && !this.disposed) this.hooks.onState(this.getState()); }, 300);
    if (kind !== 'brush' && kind !== 'settings') this._setSyncLabel(false);
  }

  /** Autosave indicator next to the sync label. kind: 'saving' | 'saved' | 'unsaved' | 'restored' */
  setSaveState(kind) {
    const el = this.ui.saveState; if (!el) return;
    const t = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.textContent = { saving: '\u21BB saving\u2026', saved: '\u2713 saved ' + t, unsaved: '\u25CB unsaved', restored: '\u2713 restored ' + t }[kind] || '';
    el.style.color = kind === 'unsaved' ? '#f0a23a' : kind === 'saving' ? '#9aa4b8' : '#4cc38a';
  }

  /** Plain-text report for bug reports: versions, GPU, limits, model, layers and the last log lines. */
  diagnostics() {
    const gl = this.renderer.getContext(), ext = gl.getExtension('WEBGL_debug_renderer_info');
    const lines = [
      'Texture Painter AI diagnostics',
      'time: ' + new Date().toISOString(),
      'browser: ' + navigator.userAgent,
      'gpu: ' + (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : 'unknown'),
      'webgl2: ' + this.renderer.capabilities.isWebGL2 + ', maxTexture: ' + gl.getParameter(gl.MAX_TEXTURE_SIZE) + ', halfFloatRT: ' + !!gl.getExtension('EXT_color_buffer_half_float') + ', floatRT: ' + !!gl.getExtension('EXT_color_buffer_float'),
      'model: ' + (this.state.model ? this.state.model.name : 'none') + (this.info ? `, ${this.info.triangles} tris, ${this.info.vertices} verts, uv=${this.info.hasUV}` : ''),
      'texture: ' + this.layers.w + 'x' + this.layers.h + ', layers: ' + this.layers.layers.length + ', view: ' + (this.isOrtho ? 'ortho' : 'perspective'),
      'capture: ' + JSON.stringify(this.state.capture) + ', ref2: ' + JSON.stringify(this.state.ref2),
      'extra refs: ' + JSON.stringify(this.state.refx) + ', heal mask: ' + (this.healRT && !this.healIsEmpty() ? 'painted' : 'empty') + (this.state.heal && this.state.heal.on ? ' (heal run ON)' : '') + ', transition mask: ' + (this.transRT && !this.transIsEmpty() ? 'painted' : 'empty') + ', brush target: ' + this.state.brushTarget,
      'combine: ' + JSON.stringify({ ...this.state.combine, w: undefined }) + ', undo/redo: ' + this.undoStack.length + '/' + this.redoStack.length,
      'node version: 6.17, mask source: ' + this.state.gen.maskSource + ', server api: ' + ((typeof window !== 'undefined' && window.TexturePainterAI && window.TexturePainterAI.serverApi) || 'unknown'),
      '--- last log lines ---', ...this.logLines.slice(-60),
    ];
    return lines.join('\n');
  }

  _setSyncLabel(synced) {
    this.synced = synced;
    const el = this.ui.syncState;
    el.textContent = synced ? '● synced' : '● changed';
    el.style.color = synced ? '#4cc38a' : '#f0a23a';
  }

  markSynced() { this._setSyncLabel(true); }

  // ----------------------------------------------------------------------------------------
  // render loop
  // ----------------------------------------------------------------------------------------
  _startLoop() {
    const loop = () => {
      if (this.disposed) return;
      if (this.needsRender) {
        this.needsRender = false;
        try { this._render(); } catch (e) { this.log('error', 'Render failed', e); }
      }
      if (this.hudDirty) {
        this.hudDirty = false;
        try { this._drawHUD(); } catch (e) { this.log('error', 'HUD failed', e); }
      }
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  _updateUVCam(w, h) {
    const a = w / h;
    const halfH = Math.max(0.56, 0.56 / a) / this.uvView.zoom;
    const halfW = halfH * a;
    const c = this.uvCam;
    c.left = -halfW; c.right = halfW; c.top = halfH; c.bottom = -halfH;
    c.position.set(this.uvView.cx, this.uvView.cy, 5);
    c.updateProjectionMatrix();
    return { halfW, halfH };
  }

  _render() {
    const r = this.renderer;
    const W = this.ui.stage.clientWidth, H = this.ui.stage.clientHeight;
    if (W < 2 || H < 2) return;
    if (this._sw !== W || this._sh !== H) {
      r.setSize(W, H, false);
      this._sw = W; this._sh = H;
      const hud = this.ui.hudCanvas;
      hud.width = Math.round(W * this.dpr); hud.height = Math.round(H * this.dpr);
      this.hudDirty = true;
    }
    if (this._composeDirty) this.flushCompose();
    // uniforms from state
    const st = this.state;
    const mu = this.meshMat.uniforms, uu = this.uvMat.uniforms;
    mu.uShowMask.value = uu.uShowMask.value = st.mask.show ? 1 : 0;
    mu.uShowTrans.value = uu.uShowTrans.value = st.combine.showTrans ? (st.combine.useTrans ? 1 : 0.3) : 0;   // dimmed while the transition mask is inactive
    mu.uMaskOpacity.value = uu.uMaskOpacity.value = st.mask.opacity;
    mu.uShade.value = st.display.shade3d;
    mu.uFacingThr.value = st.capture.facing;
    this.uvLineMat.opacity = st.display.uvWire;
    this.uvLines && (this.uvLines.visible = st.display.uvWire > 0.001);
    if (this.wireMesh) this.wireMesh.visible = !!st.display.wire3d;

    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    r.setClearColor(0x101216, 1);
    r.clear(true, true, true);

    const draw = (pane, fn) => {
      if (pane.classList.contains('tp-hidden')) return;
      const w = pane.offsetWidth, h = pane.offsetHeight;
      if (w < 2 || h < 2) return;
      const x = pane.offsetLeft, y = H - pane.offsetTop - h;
      r.setViewport(x, y, w, h);
      r.setScissor(x, y, w, h);
      r.setScissorTest(true);
      fn(w, h);
    };
    draw(this.ui.pane3d, (w, h) => {
      r.setClearColor(0x20232b, 1);
      r.clear(true, true, true);
      if (this._drawBg) this._drawBg(this.ui.pane3d, w, h, H);
      this._setAspect(this.camera, w, h);
      this.meshMat.uniforms.uOrtho.value = this.camera.isOrthographicCamera ? 1 : 0;
      this.meshMat.uniforms.uCamDir.value.copy(this._camDir());
      this.meshMat.uniforms.uChecker.value = this.state.display.checker3d ? 1 : 0;
      if (this._refUniforms) this._refUniforms(this.ui.pane3d, w, h, H);
      if (this._pbrActive && this._pbrActive()) this._pbrRender(this.camera); else r.render(this.scene, this.camera);
    });
    draw(this.ui.paneUV, (w, h) => {
      r.setClearColor(0x16181d, 1);
      r.clear(true, true, true);
      this._updateUVCam(w, h);
      r.render(this.uvScene, this.uvCam);
    });
    r.setScissorTest(false);
  }

  // ----------------------------------------------------------------------------------------
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this._raf);
    clearTimeout(this._emitTimer);
    if (this._ro) this._ro.disconnect();
    if (this._unbind) this._unbind();
    cancelAnimationFrame(this._viewAnim); cancelAnimationFrame(this._turnAnim);
    try { this.controls.dispose(); } catch (_) { /* ignore */ }
    try { this.renderer.dispose(); this.renderer.forceContextLoss(); } catch (_) { /* ignore */ }
    this.undoStack.forEach((e) => this._dropEntry(e));
    this.redoStack.forEach((e) => this._dropEntry(e));
    if (this.root.parentNode) this.root.parentNode.removeChild(this.root);
  }
}

export { SUPPORTED_EXT };
