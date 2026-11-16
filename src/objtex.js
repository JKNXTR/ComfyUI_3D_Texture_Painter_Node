// Per-object textures from the hierarchy: right-click an object -> load an image as that object's texture (or as a new layer),
// pick one of the SAVED textures (a library kept in this browser, every loaded file is added once), or go back to the model's own texture.
// The texture lands in the object's own layer stack, so it is saved with the project like any other layer.
import { h } from './ui.js';

const DB = 'texpaint-textures', STORE = 'tex', MAX = 60;
let memLib = null; // fallback when IndexedDB is not available (private window etc.)

function openDB() {
  return new Promise((res, rej) => {
    try {
      const q = indexedDB.open(DB, 1);
      q.onupgradeneeded = () => q.result.createObjectStore(STORE, { keyPath: 'id' });
      q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error);
    } catch (e) { rej(e); }
  });
}
const tx = (db, mode, fn) => new Promise((res, rej) => { const t = db.transaction(STORE, mode); const r = fn(t.objectStore(STORE)); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); });

async function hashOf(blob) {
  try { const d = await crypto.subtle.digest('SHA-1', await blob.arrayBuffer()); return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, '0')).join(''); }
  catch (_) { return blob.size + '_' + (blob.name || ''); }
}

export function installObjTex(ed) {
  const lib = {
    async all() {
      try { const db = await openDB(); const a = await tx(db, 'readonly', (s) => s.getAll()); db.close(); return (a || []).sort((x, y) => y.ts - x.ts); }
      catch (_) { return (memLib || []).slice().sort((x, y) => y.ts - x.ts); }
    },
    async add(file) {
      const id = await hashOf(file), rec = { id, name: file.name || 'texture', blob: file, ts: Date.now(), size: file.size };
      try {
        const db = await openDB();
        await tx(db, 'readwrite', (s) => s.put(rec));
        const a = await tx(db, 'readonly', (s) => s.getAll());
        const old = (a || []).sort((x, y) => y.ts - x.ts).slice(MAX);
        for (const o of old) await tx(db, 'readwrite', (s) => s.delete(o.id));
        db.close();
      } catch (_) { memLib = (memLib || []).filter((x) => x.id !== id); memLib.push(rec); memLib = memLib.slice(-MAX); }
      return id;
    },
    async remove(id) {
      try { const db = await openDB(); await tx(db, 'readwrite', (s) => s.delete(id)); db.close(); }
      catch (_) { memLib = (memLib || []).filter((x) => x.id !== id); }
    },
    async get(id) { return (await lib.all()).find((x) => x.id === id) || null; },
  };
  ed.objTexLib = lib;

  /** make `nodeId` the working object, then apply a texture file to it. mode: 'replace' (base texture) | 'layer' */
  ed.objApplyTexture = async (nodeId, file, mode = 'replace') => {
    if (!ed.objTree || !ed.objTree.byId.has(nodeId)) return false;
    if (!(await ed.selectObject(nodeId))) return false;
    const f = file instanceof File ? file : new File([file], file.name || 'texture.png', { type: file.type });
    if (mode === 'layer') await ed.addImageLayerFile(f);
    else { // replaces the object's whole stack (undoable), also when it already has painted layers
      const bmp = await createImageBitmap(f); ed._pushLayerUndo();
      ed.setTextureFromImage(bmp, { label: f.name, keepHistory: false }); bmp.close && bmp.close();
    }
    await lib.add(f);
    ed.log('ok', `Texture "${f.name}" applied to "${ed.objTree.byId.get(nodeId).name}" (${mode === 'layer' ? 'new layer' : 'base texture'}); kept in the saved textures.`);
    return true;
  };
  ed.objResetTexture = async (nodeId) => {
    if (!(await ed.selectObject(nodeId))) return false;
    ed._pushLayerUndo();
    if (ed.info && ed.info.embedded) ed.setTextureFromImage(ed.info.embedded, { label: 'model texture', keepHistory: false });
    else ed._resetStack({ size: ed.layers.w || 2048, color: '#c8c8c8', blank: true });
    return true;
  };

  let menu = null;
  const closeMenu = () => { if (menu) { menu.remove(); menu = null; } document.removeEventListener('mousedown', outside, true); document.removeEventListener('keydown', onKey, true); };
  const outside = (e) => { if (menu && !menu.contains(e.target)) closeMenu(); };
  const onKey = (e) => { if (e.key === 'Escape') closeMenu(); };
  const pick = (cb) => {
    const i = document.createElement('input'); i.type = 'file'; i.accept = 'image/*'; i.style.display = 'none';
    i.onchange = () => { const f = i.files && i.files[0]; i.remove(); if (f) cb(f); };
    ed.root.append(i); i.click();
  };

  ed.objContextMenu = async (nd, ev) => {
    ev.preventDefault(); ev.stopPropagation();
    closeMenu();
    menu = h('div', 'tp-ctxmenu');
    const bounds = ed.root.getBoundingClientRect();
    menu.style.left = Math.max(0, ev.clientX - bounds.left) + 'px'; menu.style.top = Math.max(0, ev.clientY - bounds.top) + 'px';
    const item = (txt, fn, cls) => { const d = h('div', 'tp-ctxitem' + (cls ? ' ' + cls : ''), txt); d.onclick = () => { closeMenu(); fn(); }; menu.append(d); return d; };
    menu.append(h('div', 'tp-ctxhead', nd.name));
    item('Load texture for this object...', () => pick((f) => ed.objApplyTexture(nd.id, f, 'replace')));
    item('Load image as new layer...', () => pick((f) => ed.objApplyTexture(nd.id, f, 'layer')));
    item('Back to the model\'s own texture', () => ed.objResetTexture(nd.id));
    menu.append(h('div', 'tp-ctxhead', 'Saved textures (click = use as texture)'));
    const box = h('div', 'tp-ctxlist'); menu.append(box);
    ed.root.append(menu);
    document.addEventListener('mousedown', outside, true); document.addEventListener('keydown', onKey, true);
    const all = await lib.all();
    if (!menu) return;
    if (!all.length) box.append(h('div', 'tp-ctxempty', 'None yet - every texture you load is kept here.'));
    for (const rec of all) {
      const row = h('div', 'tp-ctxitem tp-ctxtex');
      const im = document.createElement('img'); const url = URL.createObjectURL(rec.blob); im.src = url; im.onload = () => URL.revokeObjectURL(url);
      const nm = h('span', 'tp-ctxname', rec.name); nm.title = rec.name;
      const x = h('span', 'tp-ctxdel', '×'); x.title = 'Remove from the saved textures';
      x.onclick = async (e) => { e.stopPropagation(); await lib.remove(rec.id); row.remove(); };
      row.onclick = () => { closeMenu(); ed.objApplyTexture(nd.id, new File([rec.blob], rec.name, { type: rec.blob.type }), 'replace'); };
      row.append(im, nm, x); box.append(row);
    }
    const r = menu.getBoundingClientRect(); // keep inside the editor
    if (r.right > bounds.right) menu.style.left = Math.max(0, bounds.width - r.width - 4) + 'px';
    if (r.bottom > bounds.bottom) menu.style.top = Math.max(0, bounds.height - r.height - 4) + 'px';
  };

  const st = document.createElement('style');
  st.textContent = `.tp-ctxmenu{position:absolute;z-index:60;min-width:230px;max-width:300px;background:#1b1e26;border:1px solid #3a4150;border-radius:5px;box-shadow:0 6px 22px #000a;padding:3px 0;font-size:11px;color:#dfe5f3}
.tp-ctxhead{padding:3px 8px;opacity:.6;font-size:10px;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-ctxitem{padding:4px 10px;cursor:pointer;display:flex;align-items:center;gap:6px}.tp-ctxitem:hover{background:#25507f}
.tp-ctxlist{max-height:220px;overflow:auto}.tp-ctxempty{padding:4px 10px;opacity:.55}
.tp-ctxtex img{width:28px;height:28px;object-fit:cover;border-radius:3px;background:#000}.tp-ctxname{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-ctxdel{opacity:.5;padding:0 4px}.tp-ctxdel:hover{opacity:1;color:#ff8080}`;
  ed.root.append(st);
}
