// Drop-down in the 3D view: the six standard views, your own saved views (save / rename / delete, optionally linked to a reference image)
// and the saved angles of the reference images. Choosing a view moves the camera and - for a linked view or a reference angle - also makes that
// reference image the active one, so changing the side and changing the reference is one click.
import * as THREE from 'three';
import { h } from './ui.js';

const STD = [['front', 'Front', [0, 0, 1]], ['back', 'Back', [0, 0, -1]], ['left', 'Left', [-1, 0, 0]], ['right', 'Right', [1, 0, 0]], ['top', 'Top', [0, 1, 0]], ['bottom', 'Bottom', [0, -1, 0]]];

export function installViewMenu(ed) {
  const st = ed.state, p3 = ed.ui.pane3d;
  const bar = h('div', 'tp-vmbar');
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'dblclick', 'wheel', 'contextmenu', 'click', 'keydown']) bar.addEventListener(ev, (e) => e.stopPropagation());
  const sel = h('select'); sel.title = 'Go to a standard view, one of your saved views, or the saved angle of a reference image';
  const bAdd = h('button', 'tp-btn', '＋'); bAdd.title = 'Save the current camera as a new view';
  const bRen = h('button', 'tp-btn', '✎'); bRen.title = 'Rename the selected saved view';
  const bDel = h('button', 'tp-btn', '✕'); bDel.title = 'Delete the selected saved view (click twice)';
  const link = h('select'); link.title = 'Reference image that becomes active when this saved view is chosen';
  const nameIn = h('input'); nameIn.type = 'text'; nameIn.maxLength = 40; nameIn.style.display = 'none'; nameIn.style.width = '120px';
  nameIn.addEventListener('keydown', (e) => e.stopPropagation());
  bar.append(sel, bAdd, bRen, bDel, nameIn, link); p3.append(bar);
  const css = document.createElement('style');
  css.textContent = '.tp-vmbar{position:absolute;left:134px;top:4px;z-index:4;display:flex;gap:3px;align-items:center;background:rgba(10,12,16,.6);border-radius:4px;padding:2px 5px;font-size:11px}.tp-vmbar select,.tp-vmbar input{font-size:11px;max-width:150px}.tp-vmbar .tp-btn{padding:0 6px;min-width:20px}';
  ed.root.append(css);
  for (const [v, t] of [['', 'No reference'], ['2', 'Image 2'], ['3', 'Image 3'], ['4', 'Image 4'], ['5', 'Image 5'], ['6', 'Image 6']]) { const o = h('option', null, t); o.value = v; link.append(o); }

  let cur = '', armDel = null;
  const bm = () => st.bookmarks;
  const build = () => {
    sel.innerHTML = '';
    const add = (grp, items) => { const g = document.createElement('optgroup'); g.label = grp; for (const [v, t] of items) { const o = h('option', null, t); o.value = v; g.append(o); } sel.append(g); };
    const ph = h('option', null, 'View ...'); ph.value = ''; sel.append(ph);
    add('Standard views', STD.map(([k, t]) => ['std:' + k, t]));
    if (bm().length) add('My views', bm().map((b, i) => ['bm:' + i, b.name + (b.ref ? ` (image ${b.ref})` : '')]));
    const refs = st.refx.map((r, i) => [i + 3, r]).filter(([, r]) => r.cam); if (st.ref2.cam) refs.unshift([2, st.ref2]);
    if (refs.length) add('Reference image angles', refs.map(([n, r]) => ['ref:' + n, `Image ${n}${r.angle ? ' - ' + r.angle : ''}`]));
    sel.value = [...sel.options].some((o) => o.value === cur) ? cur : '';
    const isBm = cur.startsWith('bm:') && bm()[+cur.slice(3)];
    bRen.disabled = bDel.disabled = !isBm; link.style.display = isBm ? '' : 'none';
    if (isBm) link.value = String(bm()[+cur.slice(3)].ref || '');
    bDel.textContent = '✕'; armDel = null;
  };
  const go = (v) => {
    cur = v;
    if (v.startsWith('std:')) { const s = STD.find(([k]) => k === v.slice(4)); if (s) ed.viewFrom(new THREE.Vector3(...s[2])); }
    else if (v.startsWith('bm:')) { const b = bm()[+v.slice(3)]; if (b) { ed.gotoBookmark(+v.slice(3)); if (b.ref && ed.setRefActive) ed.setRefActive(b.ref); } }
    else if (v.startsWith('ref:')) { const n = +v.slice(4); if (ed.refGotoAngle(n) && ed.setRefActive) ed.setRefActive(n); }
    build();
  };
  sel.onchange = () => go(sel.value);
  bAdd.onclick = () => { if (!ed.saveBookmark()) return; cur = 'bm:' + (bm().length - 1); build(); startRename(); };
  const startRename = () => { const b = bm()[+cur.slice(3)]; if (!b) return; nameIn.value = b.name; nameIn.style.display = ''; sel.style.display = 'none'; nameIn.focus(); nameIn.select(); };
  const endRename = (ok) => { const b = bm()[+cur.slice(3)]; if (ok && b && nameIn.value.trim()) { b.name = nameIn.value.trim().slice(0, 40); ed._dirty('settings'); } nameIn.style.display = 'none'; sel.style.display = ''; build(); if (ed._refreshBookmarks) ed._refreshBookmarks(); };
  nameIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') endRename(true); else if (e.key === 'Escape') endRename(false); });
  nameIn.addEventListener('blur', () => { if (nameIn.style.display !== 'none') endRename(true); });
  bRen.onclick = startRename;
  bDel.onclick = () => { if (!cur.startsWith('bm:')) return; if (armDel !== cur) { armDel = cur; bDel.textContent = 'Sure?'; return; } const i = +cur.slice(3); cur = ''; ed.deleteBookmark(i); };
  link.onchange = () => { const b = bm()[+cur.slice(3)]; if (!b) return; b.ref = link.value ? +link.value : 0; ed._dirty('settings'); build(); };

  const prevRB = ed._refreshBookmarks; ed._refreshBookmarks = () => { if (prevRB) prevRB(); build(); };
  const prevAp = ed._applyStateToUI; ed._applyStateToUI = () => { if (prevAp) prevAp(); build(); };
  ed.viewMenuGo = go; ed.viewMenuRefresh = build;
  build();
}
