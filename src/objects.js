// Object hierarchy of a loaded model. Any node of the tree can be the WORKING OBJECT: it becomes the model (own UV map, own
// texture layers, own mask, own capture/bake mesh). The other objects stay visible as grey context and can be hidden.
import * as THREE from 'three';
import { buildMerged, uvHealth } from './meshio.js';
import { h, makeButton, makeCheck } from './ui.js';

export function buildObjectTree(root) {
  const byId = new Map(), meshId = new Map(), rows = [];
  let n = 0;
  const walk = (o, id, depth) => {
    const kids = [];
    o.children.forEach((c, i) => { const k = walk(c, id === '' ? String(i) : id + '.' + i, depth + 1); if (k) kids.push(k); });
    const own = !!(o.isMesh && o.geometry && o.geometry.attributes.position);
    if (!own && !kids.length) return null;
    const meshes = (own ? [o] : []).concat(...kids.map((k) => k.meshes));
    const leafIds = (own ? [id] : []).concat(...kids.map((k) => k.leafIds));
    let tris = 0;
    if (own) { const g = o.geometry; tris = (g.index ? g.index.count : g.attributes.position.count) / 3; }
    tris += kids.reduce((a, k) => a + k.tris, 0);
    const name = id === '' ? 'Entire model (all objects merged)' : (o.name || (own ? 'Mesh ' + (++n) : 'Group'));
    const node = { id, name, depth, own, meshes, meshSet: new Set(meshes), leafIds, tris, kids };
    if (own) meshId.set(o, id);
    byId.set(id, node);
    rows.push(node);
    return node;
  };
  const rootNode = walk(root, '', 0);
  if (!rootNode) throw new Error('The file contains no mesh geometry.');
  const ordered = [];
  const pre = (nd) => { ordered.push(nd); nd.kids.forEach(pre); };
  pre(rootNode);
  const allLeaves = [...byId.values()].filter((x) => x.own);
  return { root: rootNode, byId, meshId, rows: ordered, leafCount: allLeaves.length };
}

export function installObjects(ed) {
  const st = ed.state, ui = ed.ui;
  ed._objStore = new Map();
  let ctxGroup = null, ctxMats = null;
  const ctxCache = new Map(); // mesh -> { geom, norm }
  const hex12 = () => { const b = new Uint8Array(6); crypto.getRandomValues(b); return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); };
  const curId = () => (st.model && st.model.object) || '';
  const hidden = () => new Set(st.objHidden || []);
  const lightOnce = () => { if (!ed._objLight) { ed._objLight = new THREE.HemisphereLight(0xffffff, 0x4a4f5e, 1.6); ed.scene.add(ed._objLight); } };

  // ------------------------------------------------------------------------------------------
  // context meshes (every object that is not part of the working object), in the working object's normalised frame
  // ------------------------------------------------------------------------------------------
  const clearCtx = () => { if (ctxGroup) { ed.scene.remove(ctxGroup); ctxGroup = null; } };
  // texture of a context object: the preview kept when it was last the working object (own entry, else the shared "entire model" atlas),
  // else the texture embedded in the model file, else null (grey)
  const previewFor = (leafId) => { const e = ed._objStore.get(leafId) || ed._objStore.get(''); return e && e.preview ? e.preview : null; };
  const texMat = (src, srgbCanvas, basic) => {
    const t = new THREE.CanvasTexture(srgbCanvas); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.needsUpdate = true;
    const m = basic ? new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }) : new THREE.MeshLambertMaterial({ map: t, side: THREE.DoubleSide });
    m.userData.own = true; void src; return m;
  };
  const toCanvas = (img) => { if (img instanceof HTMLCanvasElement) return img; const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; c.getContext('2d').drawImage(img, 0, 0); return c; };
  /** material for one context mesh. basic = unlit (used for the AI capture so the colours arrive unchanged). Null source -> grey. */
  const ctxMaterial = (mesh, id, c, basic, wantTex) => {
    if (!wantTex) return ctxMats;
    const src = previewFor(id) || c.embedded;
    if (!src) return basic ? (greyBasic = greyBasic || new THREE.MeshBasicMaterial({ color: 0x8b93a8, side: THREE.DoubleSide })) : ctxMats;
    try { return texMat(src, toCanvas(src), basic); } catch (_) { return ctxMats; }
  };
  let greyBasic = null;
  const disposeMats = (g) => { if (g) g.traverse((m) => { if (m.material && m.material.userData && m.material.userData.own) { if (m.material.map) m.material.map.dispose(); m.material.dispose(); } }); };
  const buildCtx = () => {
    disposeMats(ctxGroup);
    clearCtx();
    const t = ed.objTree;
    if (!t || t.leafCount < 2 || !ed.info) return;
    const cur = t.byId.get(curId()) || t.root;
    lightOnce();
    ctxMats = ctxMats || new THREE.MeshLambertMaterial({ color: 0x8b93a8, side: THREE.DoubleSide });
    ctxGroup = new THREE.Group(); ctxGroup.matrixAutoUpdate = false;
    let tris = 0;
    for (const [mesh, id] of t.meshId) {
      if (cur.meshSet.has(mesh)) continue;
      let c = ctxCache.get(mesh);
      if (!c) {
        try { const r = buildMerged(ed._root, ed._kind, (o) => o === mesh); c = { geom: r.geometry, norm: r.info.norm, embedded: r.info.embedded }; } catch (_) { c = { geom: null }; }
        ctxCache.set(mesh, c);
      }
      if (!c.geom) continue;
      tris += c.geom.index.count / 3;
      const m = new THREE.Mesh(c.geom, ctxMaterial(mesh, id, c, false, !!(st.objTex && st.objTex.show))); m.frustumCulled = false; m.userData.src = c; m.matrixAutoUpdate = false; m.userData.leaf = id;
      // own normalised frame -> world -> working object's normalised frame
      const own = new THREE.Matrix4().makeScale(1 / c.norm.scale, 1 / c.norm.scale, 1 / c.norm.scale).premultiply(new THREE.Matrix4().makeTranslation(...c.norm.center));
      const cn = ed.info.norm, toCur = new THREE.Matrix4().makeTranslation(-cn.center[0], -cn.center[1], -cn.center[2]).premultiply(new THREE.Matrix4().makeScale(cn.scale, cn.scale, cn.scale));
      m.userData.base = toCur.multiply(own);
      ctxGroup.add(m);
    }
    ed.scene.add(ctxGroup);
    ed._updateCtx();
    ed._ctxTris = tris;
  };
  ed._updateCtx = () => {
    if (!ctxGroup) return;
    const xf = ed._xformMatrix(), hid = hidden();
    for (const m of ctxGroup.children) { m.matrix.multiplyMatrices(xf, m.userData.base); m.matrixWorldNeedsUpdate = true; m.visible = !hid.has(m.userData.leaf); }
    ctxGroup.updateMatrixWorld(true);
    ed.invalidate();
  };
  const applyVisibility = () => {
    const t = ed.objTree; if (!t || !ed.mesh) return;
    const cur = t.byId.get(curId()) || t.root, hid = hidden();
    const vis = cur.leafIds.some((l) => !hid.has(l));
    ed.mesh.visible = vis;
    ed.wireMesh.visible = vis && !!st.display.wire3d;
    ed._updateCtx();
  };

  // ------------------------------------------------------------------------------------------
  // hide / unhide
  // ------------------------------------------------------------------------------------------
  const setHidden = (ids) => { st.objHidden = [...new Set(ids)]; applyVisibility(); renderTree(); ed._dirty('settings'); };
  ed.objHideAll = () => setHidden(ed.objTree.root.leafIds);
  ed.objUnhideAll = () => setHidden([]);
  ed.objHideSelected = () => { const cur = ed.objTree.byId.get(curId()) || ed.objTree.root; setHidden([...hidden(), ...cur.leafIds]); };
  ed.objHideExceptSelected = () => { const cur = ed.objTree.byId.get(curId()) || ed.objTree.root, keep = new Set(cur.leafIds); setHidden(ed.objTree.root.leafIds.filter((l) => !keep.has(l))); };
  ed.objToggleNode = (id) => {
    const nd = ed.objTree.byId.get(id); if (!nd) return;
    const hid = hidden(), allHidden = nd.leafIds.every((l) => hid.has(l));
    if (allHidden) nd.leafIds.forEach((l) => hid.delete(l)); else nd.leafIds.forEach((l) => hid.add(l));
    setHidden([...hid]);
  };

  // A working set of several objects: its id is the node ids joined by '|' (in tree order). The node is built on demand
  // (also after a reload) with the union of the meshes, so everything that works for one object works for the set.
  const resolve = (id) => {
    const t = ed.objTree; if (!t) return null;
    id = id || '';
    const hit = t.byId.get(id); if (hit || !id.includes('|')) return hit || null;
    const parts = id.split('|').map((p) => t.byId.get(p));
    if (parts.some((p) => !p)) return null;
    const meshes = [...new Set(parts.flatMap((p) => p.meshes))], leafIds = [...new Set(parts.flatMap((p) => p.leafIds))];
    let tris = 0; for (const m of meshes) { const g = m.geometry; tris += (g.index ? g.index.count : g.attributes.position.count) / 3; }
    const nd = { id, name: parts.length + ' objects: ' + parts.map((p) => p.name).join(', '), depth: 0, own: false, meshes, meshSet: new Set(meshes), leafIds, tris, kids: [], composite: true };
    t.byId.set(id, nd); return nd;
  };
  ed.objResolve = resolve;
  ed._ctxGroup = () => ctxGroup;
  let lastClick = null;
  /** click in the hierarchy: plain = one working object; Ctrl/Cmd = add / remove; Shift = range from the last click */
  ed.objClick = (id, e) => {
    const t = ed.objTree; if (!t) return false;
    if (!e || !(e.ctrlKey || e.metaKey || e.shiftKey) || id === '') { lastClick = id; return ed.selectObject(id); }
    const order = t.rows.map((r) => r.id);
    let set = curId() === '' ? [] : curId().split('|');
    if (e.shiftKey && lastClick !== null && lastClick !== '' && order.includes(lastClick)) {
      const a = order.indexOf(lastClick), b = order.indexOf(id);
      set = order.slice(Math.min(a, b), Math.max(a, b) + 1).filter((x) => x !== '');
    } else set = set.includes(id) ? set.filter((x) => x !== id) : [...set, id];
    lastClick = id;
    set.sort((x, y) => order.indexOf(x) - order.indexOf(y));
    return ed.selectObject(set.join('|'));
  };

  // ------------------------------------------------------------------------------------------
  // switching the working object
  // ------------------------------------------------------------------------------------------
  const stash = async () => {
    const files = new Map();
    for (const f of ed.layers.files()) files.set(f.name, await ed.layers.toBlob(f.rt, f.grey));
    const maskUid = hex12();
    files.set(`M_${maskUid}.png`, await ed.exportMaskBlob());
    const pb = ed.pbrStash ? await ed.pbrStash() : { ids: null, files: new Map() };
    for (const [n, b] of pb.files) files.set(n, b);
    let preview = null; try { const b = ed.layers.bakeCanvas(0), k = Math.min(1, 1024 / Math.max(b.width, b.height)); preview = document.createElement('canvas'); preview.width = Math.max(1, Math.round(b.width * k)); preview.height = Math.max(1, Math.round(b.height * k)); preview.getContext('2d').drawImage(b, 0, 0, preview.width, preview.height); } catch (_) { preview = null; }
    return { stack: ed.layers.serialize(), files, maskUid, pbrIds: pb.ids, preview, lazy: false };
  };
  const loadFrom = async (entry) => {
    const get = async (name) => {
      let b = entry.files && entry.files.get(name);
      if (!b && entry.lazy && ed.hooks.fetchSessionFile) b = await ed.hooks.fetchSessionFile(name);
      return b ? createImageBitmap(b) : null;
    };
    const ok = await ed.restoreLayers(entry.stack, get);
    if (ed.pbrLoadFrom) await ed.pbrLoadFrom(entry.pbrIds, get);
    const mk = await get(`M_${entry.maskUid}.png`);
    return { ok, mask: mk };
  };
  ed.selectObject = async (id) => {
    const t = ed.objTree; if (!t || ed._objBusy) return false;
    id = id || '';
    if (id === curId()) return true;
    const node = resolve(id); if (!node) return false;
    ed._objBusy = true;
    try {
      ed.setStatus('Switching to "' + node.name + '" ...');
      const prev = curId();
      ed._objStore.set(prev, await stash());
      const include = node === t.root ? null : ((o) => node.meshSet.has(o));
      const { geometry, info } = buildMerged(ed._root, ed._kind, include);
      ed.pending = null; ed.compare = false;
      ed._setGeometry(geometry, info);
      st.model.object = id;
      const entry = ed._objStore.get(id);
      let restored = false, mask = null;
      if (entry) { const r = await loadFrom(entry); restored = r.ok; mask = r.mask; ed._objStore.delete(id); }
      else if (ed.pbrReset) ed.pbrReset();
      if (!restored) {
        if (info.embedded) { try { ed.setTextureFromImage(info.embedded, { label: 'model texture', keepHistory: false }); restored = true; } catch (_) { /* blank below */ } }
        if (!restored) ed._resetStack({ size: 2048, color: '#c8c8c8', blank: true });
      }
      ed._clearRT(ed.maskRT, 0);
      if (mask) ed.importMaskBitmap(mask, { undo: false });
      ed._clearHistory(); ed.maskVersion++;
      ed.frameModel();
      const warns = []; try { warns.push(...uvHealth(geometry)); } catch (_) { /* ignore */ }
      if (!info.hasUV) warns.unshift('This object has NO UV coordinates - painting is disabled.');
      for (const w of warns) ed.log('warn', w);
      ed.log('ok', `Working object: "${node.name}" - ${info.triangles.toLocaleString()} triangles, own UV map and texture.`);
      ed.setStatus(warns[0] || `Working on "${node.name}"`, warns.length ? 'warn' : 'ok');
      buildCtx(); applyVisibility(); renderTree();
      ed._dirty('model'); ed._dirty('texture'); ed._dirty('mask');
      ed._renderStats();
      return true;
    } catch (e) {
      ed.log('error', 'Could not switch object', e); ed.setStatus('Could not switch object: ' + e.message, 'err');
      return false;
    } finally { ed._objBusy = false; }
  };

  // ---- persistence (non-current objects). meta goes into the saved state, files into the session folder.
  ed.objectStates = () => {
    const o = {};
    for (const [id, e] of ed._objStore) o[id] = { stack: e.stack, maskUid: e.maskUid, ...(e.pbrIds && Object.values(e.pbrIds).some(Boolean) ? { pbr: e.pbrIds } : {}) };
    return o;
  };
  ed.objectFiles = () => {
    const out = [];
    for (const [, e] of ed._objStore) {
      for (const n of Object.keys(e.stack.stack.reduce((a, l) => { a['L_' + l.pix + '.png'] = 1; if (l.orig && l.orig !== l.pix) a['L_' + l.orig + '.png'] = 1; if (l.mask) a['M_' + l.mask + '.png'] = 1; return a; }, { ['M_' + e.maskUid + '.png']: 1 }))) out.push({ name: n, blob: e.files ? e.files.get(n) : null });
      for (const [k, pid] of Object.entries(e.pbrIds || {})) if (pid) { const n = `P_${pid}_${k}.png`; out.push({ name: n, blob: e.files ? e.files.get(n) : null }); }
    }
    return out;
  };
  ed.seedObjectStates = (meta) => {
    ed._objStore = new Map();
    for (const [id, m] of Object.entries(meta || {})) if (m && m.stack && id !== curId()) ed._objStore.set(id, { stack: m.stack, maskUid: m.maskUid, pbrIds: m.pbr || null, files: new Map(), lazy: true });
    renderTree();
  };

  // ------------------------------------------------------------------------------------------
  // panel
  // ------------------------------------------------------------------------------------------
  const sec = ui.sec.obj, body = sec.body;
  const tree = h('div', 'tp-tree');
  const bAll = makeButton('Unhide all'), bExc = makeButton('Hide all except selected'), bSel = makeButton('Hide selected'), bHideAll = makeButton('Hide all');
  bAll.onclick = () => ed.objUnhideAll(); bExc.onclick = () => ed.objHideExceptSelected(); bSel.onclick = () => ed.objHideSelected(); bHideAll.onclick = () => ed.objHideAll();
  const bFitSel = makeButton('Fit selected object', 'Fit the working object to the viewport'), bFitAll = makeButton('Fit all objects', 'Fit every visible object to the viewport (Shift+Home)');
  bFitSel.onclick = () => ed.fitWhole(); bFitAll.onclick = () => ed.frameAll();
  const r1 = h('div', 'tp-row2'), r2 = h('div', 'tp-row2'), r3 = h('div', 'tp-row2'); r1.append(bAll, bHideAll); r2.append(bExc, bSel); r3.append(bFitSel, bFitAll);
  body.append(tree, r1, r2, r3, h('div', 'tp-note', 'Click an object to make it the working model (Ctrl-click adds / removes objects, Shift-click selects a range - all selected objects then work together as ONE working set: shared capture, painting, generation and bake): it gets its own UV map, texture layers, mask and capture/bake mesh (more texture resolution for that object). "Entire model" merges everything into one UV atlas (needed when all parts share one atlas). Other objects stay visible as grey context; the eye hides them. Right-click an object to load a texture for it or pick one of the saved textures. Undo history is cleared when you switch. Export saves the working object only.'));
  const styleEl = document.createElement('style');
  styleEl.textContent = `.tp-tree{max-height:230px;overflow:auto;border:1px solid #333845;border-radius:4px;background:#14161b;margin-bottom:6px}
.tp-trow{display:flex;align-items:center;gap:4px;padding:2px 4px;font-size:11px;color:#cfd6e6;cursor:pointer;white-space:nowrap}
.tp-trow:hover{background:#1d2129}.tp-trow.tp-cur{background:#25507f;color:#fff}
.tp-trow .tp-eye{width:16px;text-align:center;cursor:pointer;opacity:.9}.tp-trow .tp-eye.tp-off{opacity:.35}
.tp-trow .tp-tn{overflow:hidden;text-overflow:ellipsis;flex:1}.tp-trow .tp-tt{opacity:.6;font-size:10px}`;
  ed.root.append(styleEl);
  function renderTree() {
    const t = ed.objTree;
    const show = !!t && t.leafCount >= 2;
    sec.el.style.display = show ? '' : 'none';
    if (typeof syncBar === 'function') syncBar();
    tree.innerHTML = '';
    if (!show) return;
    const hid = hidden(), cur = curId(), inSet = new Set(cur.split('|'));
    for (const nd of t.rows) {
      const row = h('div', 'tp-trow' + (inSet.has(nd.id) ? ' tp-cur' : ''));
      row.style.paddingLeft = 4 + nd.depth * 12 + 'px';
      const hiddenN = nd.leafIds.filter((l) => hid.has(l)).length;
      const eye = h('span', 'tp-eye' + (hiddenN === nd.leafIds.length ? ' tp-off' : ''), hiddenN === nd.leafIds.length ? '◌' : (hiddenN ? '◐' : '◉'));
      eye.title = 'Show / hide';
      eye.onclick = (e) => { e.stopPropagation(); ed.objToggleNode(nd.id); };
      const nm = h('span', 'tp-tn', (nd.own ? '■ ' : '▸ ') + nd.name); nm.title = nd.name;
      const tt = h('span', 'tp-tt', nd.tris >= 1000 ? Math.round(nd.tris / 100) / 10 + 'k' : String(nd.tris));
      row.append(eye, nm, tt);
      row.onclick = (e) => ed.objClick(nd.id, e);
      row.oncontextmenu = (e) => { if (ed.objContextMenu) ed.objContextMenu(nd, e); };
      tree.append(row);
    }
  }
  /** unlit textured copies of the visible context objects for the AI capture (null = reference option off or nothing to add) */
  ed.objRefMeshes = () => {
    if (!(st.objTex && st.objTex.ref) || !ctxGroup) return null;
    const out = [];
    for (const m of ctxGroup.children) {
      if (!m.visible) continue;
      const c = m.userData.src, id = m.userData.leaf;
      const k = new THREE.Mesh(m.geometry, ctxMaterial(null, id, c, true, true)); k.frustumCulled = false; k.matrixAutoUpdate = false; k.matrix.copy(m.matrix); k.matrixWorld.copy(m.matrix);
      out.push(k);
    }
    return out;
  };
  ed.objRefDispose = (list) => { for (const k of list || []) if (k.material && k.material.userData && k.material.userData.own) { if (k.material.map) k.material.map.dispose(); k.material.dispose(); } };

  // two switches in the 3D view (only for models with several objects)
  st.objTex = Object.assign({ show: false, ref: false }, st.objTex || {});
  const bar = h('div', 'tp-ctxbar'); for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'dblclick', 'wheel', 'contextmenu', 'click']) bar.addEventListener(ev, (e) => e.stopPropagation());
  const cbShow = makeCheck('Show textures of all objects', st.objTex.show, (v) => { st.objTex.show = v; buildCtx(); ed._dirty('settings'); });
  const cbRef = makeCheck('Use them as reference for smoother connections', st.objTex.ref, (v) => { st.objTex.ref = v; ed._dirty('settings'); });
  cbShow.el.title = 'The other objects show their own texture (the last painted / baked version, else the texture of the model file) instead of grey.';
  cbRef.el.title = 'The AI capture also contains the other objects with their textures, so the generated texture continues their colours and details at the joints. Only the working object is baked - the others are never changed.';
  bar.append(cbShow.el, cbRef.el); ui.pane3d.append(bar);
  const barCss = document.createElement('style');
  barCss.textContent = '.tp-ctxbar{position:absolute;left:8px;top:28px;z-index:4;background:rgba(10,12,16,.6);border-radius:4px;padding:3px 7px;font-size:11px;display:none}.tp-ctxbar .tp-chk{display:flex;gap:5px;align-items:center;margin:1px 0;white-space:nowrap}';
  ed.root.append(barCss);
  const syncBar = () => { const t = ed.objTree; bar.style.display = t && t.leafCount >= 2 ? 'block' : 'none'; cbShow.set(st.objTex.show); cbRef.set(st.objTex.ref); };
  const prevApply = ed._applyStateToUI; ed._applyStateToUI = () => { if (prevApply) prevApply(); syncBar(); if (ed.objTree) buildCtx(); };
  ed._objectsChanged = () => { ctxCache.clear(); buildCtx(); applyVisibility(); renderTree(); syncBar(); };
  renderTree();
}
