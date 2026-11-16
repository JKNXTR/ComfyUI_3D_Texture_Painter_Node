// 3D view helpers: grid on / off switch (top of the view) and the right-click quick menu for the brush / eraser of the tool in use.
import { h, makeButton, makeCheck, makeSlider } from './ui.js';
import { VIEW_COLORS } from './views.js';

export function installQuick(ed) {
  const st = ed.state, ui = ed.ui, p3 = ui.pane3d;
  if (st.display.grid === undefined) st.display.grid = true;

  // ---- UV mode switch (on the UV map): the AI image (edit_image) is the flat UV texture, the result is blended straight back into it
  { const uvbar = h('div', 'tp-vbar'); uvbar.style.cssText = 'left:auto;right:6px;top:4px'; uvbar.style.display = 'flex';
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'dblclick', 'wheel', 'contextmenu', 'click']) uvbar.addEventListener(ev, (e) => e.stopPropagation());
    const uvCb = makeCheck('UV texture output', !!st.capture.uvMode, (v) => { st.capture.uvMode = v; ed._dirty('settings'); ed.invalidate(); if (ed._tileSync) ed._tileSync(); });
    uvCb.el.title = 'On: the node\'s edit_image output is the flat UV map of the current texture + mask (not the 3D view). The prompt generates a new texture for that UV map and Bake blends it straight back, without projection. Reference images are used through the tile panel (Use reference images).';
    uvbar.append(uvCb.el); ui.paneUV.append(uvbar);
    const pa = ed._applyStateToUI; ed._applyStateToUI = () => { if (pa) pa(); uvCb.set(!!st.capture.uvMode); }; }
  // ---- grid switch
  const vbar = h('div', 'tp-vbar');
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'dblclick', 'wheel', 'contextmenu', 'click']) vbar.addEventListener(ev, (e) => e.stopPropagation());
  const gridCb = makeCheck('Grid', st.display.grid, (v) => { st.display.grid = v; applyGrid(); ed._dirty('settings'); });
  gridCb.el.title = 'Show / hide the floor grid of the 3D view';
  const wireCb = makeCheck('Wireframe', st.display.wire3d, (v) => { st.display.wire3d = v; applyWire(); ed._dirty('settings'); if (ed._applyStateToUI) ed._applyStateToUI(); });
  wireCb.el.title = 'Show the polygon edges (wireframe) on the model';
  vbar.append(gridCb.el, wireCb.el); vbar.style.display = 'flex'; vbar.style.gap = '10px'; p3.append(vbar);
  const applyWire = () => { if (ed.wireMesh) ed.wireMesh.visible = !!st.display.wire3d && ed.mesh.visible; ed.invalidate(); wireCb.set(!!st.display.wire3d); };
  const applyGrid = () => { if (ed.grid) ed.grid.visible = !!st.display.grid; ed.invalidate(); gridCb.set(st.display.grid); };
  const prevApply = ed._applyStateToUI; ed._applyStateToUI = () => { if (prevApply) prevApply(); applyGrid(); wireCb.set(!!st.display.wire3d); };
  applyGrid(); wireCb.set(!!st.display.wire3d);

  // ---- right-click quick menu
  let menu = null, down = null, refresh = null;
  const close = () => { if (menu) { menu.remove(); menu = null; refresh = null; } document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', onKey, true); };
  const outside = (e) => { if (menu && !menu.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  const tool = () => (st.tool === 'erase' ? st.erase : st.brush);
  const touch = () => { ed.hudDirty = true; ed._dirty('brush'); ed._applyStateToUI(); };

  const open = (clientX, clientY) => {
    close();
    menu = h('div', 'tp-qmenu');
    for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'wheel', 'contextmenu', 'click', 'dblclick']) menu.addEventListener(ev, (e) => { e.stopPropagation(); if (ev === 'contextmenu') e.preventDefault(); });
    const head = h('div', 'tp-qhead');
    const bB = makeButton('Brush'), bE = makeButton('Eraser');
    bB.onclick = () => { ed.setTool('brush'); sync(); }; bE.onclick = () => { ed.setTool('erase'); sync(); };
    head.append(bB, bE); menu.append(head);

    const tg = h('div', 'tp-qrow'); tg.append(h('span', 'tp-qlbl', 'Paints on'));
    const targets = [['selection', 'AI selection'], ['layer', 'Layer mask'], ['transition', 'Transition']];
    const tbtn = {};
    for (const [k, label] of targets) { const b = makeButton(label); b.onclick = () => { st.brushTarget = k; ed._applyStateToUI(); ed._dirty('settings'); sync(); }; tbtn[k] = b; tg.append(b); }
    menu.append(tg);
    const vg = h('div', 'tp-qrow'); vg.append(h('span', 'tp-qlbl', 'View region'));
    const vbtn = [];
    for (let i = 0; i < 4; i++) {
      const b = makeButton(String(i + 3)); b.title = `Paint / erase the view region of reference image ${i + 3}`;
      b.onclick = () => { st.views.active = i; st.brushTarget = 'view'; ed._applyStateToUI(); ed._dirty('settings'); sync(); };
      vbtn.push(b); vg.append(b);
    }
    menu.append(vg);

    const S = {};
    const sl = (key, label, min, max, scale, fmt) => { const w = makeSlider(label, { min, max, step: 1, value: Math.round(tool()[key] * scale), fmt }, (v) => { tool()[key] = v / scale; touch(); }); S[key] = { w, scale }; menu.append(w.el); };
    sl('size', 'Size', 2, 400, 1, (v) => v + ' px'); sl('hardness', 'Hardness', 0, 100, 100, (v) => v + '%'); sl('softness', 'Softness', 0, 100, 100, (v) => v + '%');
    sl('opacity', 'Opacity', 1, 100, 100, (v) => v + '%'); sl('spacing', 'Spacing', 2, 100, 100, (v) => v + '%'); sl('stab', 'Stabilizer', 0, 100, 100, (v) => v + '%');
    const pen = makeCheck('Pen pressure', st.pen, (v) => { st.pen = v; touch(); });
    const grid = makeCheck('Grid', st.display.grid, (v) => { st.display.grid = v; applyGrid(); ed._dirty('settings'); });
    const wire = makeCheck('Wireframe', st.display.wire3d, (v) => { st.display.wire3d = v; applyWire(); ed._dirty('settings'); ed._applyStateToUI(); });
    menu.append(pen.el, grid.el, wire.el);

    const sync = () => {
      bB.classList.toggle('tp-on', st.tool !== 'erase'); bE.classList.toggle('tp-on', st.tool === 'erase');
      for (const [k] of targets) tbtn[k].classList.toggle('tp-on', st.brushTarget === k || (k === 'selection' && st.brushTarget !== 'layer' && st.brushTarget !== 'transition' && st.brushTarget !== 'view'));
      vbtn.forEach((b, i) => { const on = st.brushTarget === 'view' && st.views.active === i; b.classList.toggle('tp-on', on); b.style.borderColor = st.refx[i].color || VIEW_COLORS[i]; b.style.borderBottomWidth = '3px'; });
      for (const [k, o] of Object.entries(S)) o.w.set(Math.round(tool()[k] * o.scale));
      pen.set(st.pen); grid.set(st.display.grid); wire.set(!!st.display.wire3d);
    };
    refresh = sync; sync();
    const b = ed.root.getBoundingClientRect();
    ed.root.append(menu);
    menu.style.left = Math.max(0, clientX - b.left) + 'px'; menu.style.top = Math.max(0, clientY - b.top) + 'px';
    const r = menu.getBoundingClientRect();
    if (r.right > b.right) menu.style.left = Math.max(0, b.width - r.width - 4) + 'px';
    if (r.bottom > b.bottom) menu.style.top = Math.max(0, b.height - r.height - 4) + 'px';
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', onKey, true);
  };
  ed.quickMenuOpen = open; ed.quickMenuClose = close; ed.quickMenuRefresh = () => { if (refresh) refresh(); };

  // right button: a click without dragging (dragging pans the camera) opens the menu
  p3.addEventListener('pointerdown', (e) => { down = e.button === 2 ? { x: e.clientX, y: e.clientY, t: performance.now() } : null; }, true);
  p3.addEventListener('pointerup', (e) => {
    if (e.button !== 2 || !down) return;
    const d = Math.hypot(e.clientX - down.x, e.clientY - down.y), dt = performance.now() - down.t; down = null;
    if (d < 5 && dt < 600 && ed.hasModel) open(e.clientX, e.clientY);
  }, true);

  const css = document.createElement('style');
  css.textContent = `.tp-vbar{position:absolute;left:78px;top:4px;z-index:4;background:rgba(10,12,16,.6);border-radius:4px;padding:2px 7px;font-size:11px}.tp-vbar .tp-chk{display:flex;gap:5px;align-items:center;margin:0}
.tp-qmenu{position:absolute;z-index:70;width:250px;background:#1b1e26;border:1px solid #3a4150;border-radius:6px;box-shadow:0 8px 26px #000b;padding:6px 8px;font-size:11px;color:#dfe5f3}
.tp-qhead{display:flex;gap:6px;margin-bottom:4px}.tp-qhead button{flex:1}.tp-qrow{display:flex;gap:4px;align-items:center;flex-wrap:wrap;margin:3px 0}.tp-qlbl{width:68px;opacity:.7}
.tp-qrow button{padding:2px 6px}.tp-qmenu .tp-row{grid-template-columns:62px 1fr 52px}`;
  ed.root.append(css);
}
