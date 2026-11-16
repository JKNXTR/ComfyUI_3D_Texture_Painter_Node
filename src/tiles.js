// UV tiles: cut the UV texture into a grid of equally sized, overlapping tiles and generate them one after another (or as one batch).
// The formulas mirror tp_tiles.py (tests/tiles_test.mjs and tests/test_tiles.py check both against the same table).
// Pixel rows run top -> bottom like the PNG files; tile index = row * cols + col.
import { h, makeButton, makeCheck, makeSlider } from './ui.js';

export function tileGrid(W, H, cols, rows, overlap) {
  cols = Math.max(1, cols | 0); rows = Math.max(1, rows | 0);
  const ov = Math.min(Math.max(+overlap || 0, 0), 0.5);
  const rnd = (v) => { const f = Math.floor(v); const d = v - f; return d > 0.5 ? f + 1 : d < 0.5 ? f : (f % 2 === 0 ? f : f + 1); };   // banker's rounding, same as Python round()
  const bx = [], by = [];
  for (let c = 0; c <= cols; c++) bx.push(rnd(c * W / cols));
  for (let r = 0; r <= rows; r++) by.push(rnd(r * H / rows));
  const ovx = rnd(ov * W / cols), ovy = rnd(ov * H / rows);
  const tw = Math.min(W, Math.ceil(W / cols) + 2 * ovx), th = Math.min(H, Math.ceil(H / rows) + 2 * ovy);
  const out = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = Math.min(Math.max(bx[c] - ovx, 0), W - tw), y0 = Math.min(Math.max(by[r] - ovy, 0), H - th);
    out.push({ i: r * cols + c, c, r, x0, y0, x1: x0 + tw, y1: y0 + th, cx0: bx[c], cx1: bx[c + 1], cy0: by[r], cy1: by[r + 1], ovx, ovy, cols, rows });
  }
  return out;
}

/** indices of tiles whose own cell contains painted mask. buf = bottom-up RGBA mask pixels of size S x S (editor._readMaskPixels). */
export function tilesWithMask(tiles, W, H, buf, S, thr = 5) {
  const res = [];
  for (const t of tiles) {
    const xa = Math.floor(t.cx0 / W * S), xb = Math.max(xa + 1, Math.ceil(t.cx1 / W * S));
    const ya = Math.floor((1 - t.cy1 / H) * S), yb = Math.max(ya + 1, Math.ceil((1 - t.cy0 / H) * S));
    let hit = false;
    for (let y = Math.max(0, ya); y < Math.min(S, yb) && !hit; y++) for (let x = Math.max(0, xa); x < Math.min(S, xb); x++) if (buf[(y * S + x) * 4] > thr) { hit = true; break; }
    if (hit) res.push(t.i);
  }
  return res;
}

export function installTiles(ed) {
  const st = ed.state, pane = ed.ui.paneUV;
  const DEF = { on: false, cols: 2, rows: 2, overlap: 0.12, mode: 'seq' };
  st.capture.tile = { ...DEF, ...(st.capture.tile || {}) };
  st.capture.uvref = { on: false, fill: 0.6, facing: 65, ...(st.capture.uvref || {}) };
  const U = () => st.capture.uvref;
  const T = () => st.capture.tile;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  ed.tilePlan = () => {
    const W = ed.layers.w, H = ed.layers.h;
    const tiles = tileGrid(W, H, T().cols, T().rows, T().overlap);
    let list = [];
    if (ed.hasModel) { try { list = tilesWithMask(tiles, W, H, ed._readMaskPixels(), ed.maskSize); } catch (_) { list = []; } }
    return { tiles, list, W, H };
  };

  // ---- panel (UV map, under the "UV texture output" switch)
  const box = h('div', 'tp-tilebox');
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'dblclick', 'wheel', 'contextmenu', 'click', 'keydown']) box.addEventListener(ev, (e) => e.stopPropagation());
  const title = h('div', 'tp-lbl', 'UV tiles'); title.style.fontWeight = '600';
  const cbOn = makeCheck('Compute in tiles', T().on, (v) => { T().on = v; sync(); ed._dirty('settings'); ed.invalidate(); });
  cbOn.el.title = 'Cut the UV map into a grid. Every tile goes to the AI at full resolution; the results are put back together. Only used with "UV texture output".';
  const sCols = makeSlider('Columns', { min: 1, max: 8, step: 1, value: 2, fmt: (v) => String(v) }, (v) => { T().cols = v; sync(); ed._dirty('settings'); ed.invalidate(); });
  const sRows = makeSlider('Rows', { min: 1, max: 8, step: 1, value: 2, fmt: (v) => String(v) }, (v) => { T().rows = v; sync(); ed._dirty('settings'); ed.invalidate(); });
  const sOv = makeSlider('Overlap', { min: 0, max: 30, step: 1, value: 12, fmt: (v) => v + '%' }, (v) => { T().overlap = v / 100; sync(); ed._dirty('settings'); ed.invalidate(); });
  const mode = h('select'); for (const [v, t] of [['seq', 'One by one (recommended)'], ['batch', 'All in one queue (batch)']]) { const o = h('option', null, t); o.value = v; mode.append(o); }
  mode.onchange = () => { T().mode = mode.value; sync(); ed._dirty('settings'); };
  mode.title = 'One by one: the painter queues your workflow once per tile, each tile sees the already painted neighbours (best consistency).\nBatch: all tiles leave the node as one image batch and are blended back with soft overlaps (your workflow must edit an image batch).';
  const info = h('div', 'tp-note'); info.style.margin = '2px 0';
  const bRun = makeButton('Run tiles', 'Generate every tile that contains painted mask, one after another, and apply the results');
  const bStop = makeButton('Stop', 'Stop after the current tile'); bStop.disabled = true;
  const prog = h('div', 'tp-note');
  const row = h('div'); row.style.cssText = 'display:flex;gap:6px;margin-top:3px'; row.append(bRun, bStop);
  const inner = h('div'); inner.append(sCols.el, sRows.el, sOv.el, mode, info, row, prog);
  // ---- reference images projected onto the UV map by their angle
  const sep = h('div'); sep.style.cssText = 'border-top:1px solid #3a4150;margin:5px 0 3px';
  const cbRef = makeCheck('Use reference images (by angle)', U().on, (v) => { U().on = v; sync(); ed._dirty('settings'); ed.invalidate(); });
  cbRef.el.title = 'Every reference image (2-6) that has a camera is projected onto the UV map - only where it really sees the surface from a good angle - and sent to the AI as image 2 (and pre-fills the marked area).';
  const sFill = makeSlider('Reference fill', { min: 0, max: 100, step: 5, value: 60, fmt: (v) => v + '%' }, (v) => { U().fill = v / 100; ed._dirty('settings'); ed.invalidate(); if (ed.promptPreviewUpdate) ed.promptPreviewUpdate(); });
  sFill.el.title = 'How strongly the projected photos pre-fill the marked area. 0 = the AI only gets them as image 2, 100 = the AI refines the photo colours.';
  const sFace = makeSlider('Min. facing angle', { min: 30, max: 85, step: 1, value: 65, fmt: (v) => v + '\u00b0' }, (v) => { U().facing = v; ed._dirty('settings'); });
  sFace.el.title = 'A photo is only used where the surface turns less than this many degrees away from it. Lower = only well-seen areas, higher = more coverage but more stretching.';
  const refList = h('div', 'tp-note'); refList.style.cssText = 'white-space:pre-line;margin:2px 0';
  const bPrev = makeButton('Preview on UV map', 'Project the references now and show where they land (transparent = no reference sees that area)');
  const bHide = makeButton('Hide', 'Hide the projected reference'); bHide.disabled = true;
  const prow = h('div'); prow.style.cssText = 'display:flex;gap:6px;margin-top:3px'; prow.append(bPrev, bHide);
  const refNote = h('div', 'tp-note');
  const refInner = h('div'); refInner.append(sFill.el, sFace.el, refList, prow, refNote);
  box.append(title, cbOn.el, inner, sep, cbRef.el, refInner);
  pane.append(box);
  const css = document.createElement('style');
  css.textContent = '.tp-tilebox{position:absolute;right:6px;top:30px;z-index:4;width:210px;max-height:calc(100% - 150px);overflow:auto;background:rgba(10,12,16,.82);border:1px solid #3a4150;border-radius:4px;padding:4px 8px;font-size:11px;color:#dfe5f3}.tp-tilebox select{width:100%;margin:3px 0}.tp-tilebox .tp-btn{padding:1px 8px}';
  ed.root.append(css);

  const sync = () => {
    const uv = !!st.capture.uvMode;
    box.style.display = uv ? '' : 'none';
    inner.style.display = T().on ? '' : 'none';
    refInner.style.display = U().on ? '' : 'none';
    cbOn.set(T().on); sCols.set(T().cols); sRows.set(T().rows); sOv.set(Math.round(T().overlap * 100)); mode.value = T().mode;
    cbRef.set(U().on); sFill.set(Math.round(U().fill * 100)); sFace.set(U().facing);
    if (uv && U().on) {
      const lines = [];
      for (let n = 2; n <= 6; n++) { const r = ed.refState(n); if (!r || !r.has) continue; const p = r.enabled === false ? null : ed.refPose(n);
        lines.push(`Image ${n}: ` + (r.enabled === false ? 'switched off' : p ? `${r.angle || 'no label'} \u2713 (${p.source})` : 'no camera - place it or give it an angle')); }
      refList.textContent = lines.length ? lines.join('\n') : 'Load reference images, give them an angle and/or place them on the model.';
    }
    if (!uv || !T().on) { info.textContent = ''; return; }
    const p = ed.tilePlan();
    info.textContent = `${p.list.length} of ${p.tiles.length} tiles will be generated (tile ${p.tiles[0].x1 - p.tiles[0].x0} x ${p.tiles[0].y1 - p.tiles[0].y0} px of ${p.W} x ${p.H}).`;
  };
  ed._tileSync = sync;
  // projected-reference preview (UV space), drawn over the UV map by the HUD
  ed._uvrefBmp = null;
  bPrev.onclick = async () => {
    if (!ed.hooks.previewUVRef) { ed.setStatus('The preview needs ComfyUI (the projection runs in the node).', 'warn'); return; }
    bPrev.disabled = true; refNote.textContent = 'Projecting ...';
    try {
      const r = await ed.hooks.previewUVRef();
      ed._uvrefBmp = r.bmp; bHide.disabled = false; refNote.textContent = (r.notes || []).join('\n') || 'Done.';
      ed.hudDirty = true; ed.invalidate();
    } catch (e) { refNote.textContent = 'Preview failed: ' + e.message; ed.log('error', 'UV reference preview failed', e); }
    finally { bPrev.disabled = false; }
  };
  bHide.onclick = () => { ed._uvrefBmp = null; bHide.disabled = true; ed.hudDirty = true; ed.invalidate(); };
  const pa = ed._applyStateToUI; ed._applyStateToUI = () => { if (pa) pa(); sync(); };
  ed.onMaskChanged && ed.onMaskChanged(() => sync());
  setInterval(() => { if (box.style.display !== 'none' && T().on && !ed._runBusy) sync(); }, 1500);
  sync();

  // ---- run
  ed.runTiles = async () => {
    if (ed._runBusy) return { done: 0 };
    if (!ed.hooks.generate) { ed.setStatus('Tiles need ComfyUI (they queue the workflow for you).', 'warn'); return { done: 0 }; }
    if (!st.capture.uvMode || !T().on) { ed.setStatus('Switch on "UV texture output" and "Compute in tiles" first.', 'warn'); return { done: 0 }; }
    const plan = ed.tilePlan();
    if (!plan.list.length) { ed.setStatus('Nothing to generate: paint a mask on the model or UV map first.', 'warn'); return { done: 0 }; }
    ed._runBusy = true; ed._runCancel = false; bRun.disabled = true; bStop.disabled = false;
    let done = 0, reason = '';
    const finished = [];
    const clearOpt = st.options.clearMask; let lastRem = null;
    try {
      if (T().mode === 'batch') {
        ed._tileRun = { index: -1, done: [] };
        prog.textContent = `Generating ${plan.list.length} tiles in one queue ...`; ed.setStatus(prog.textContent);
        const res = await ed.hooks.generate();
        ed.showResult(res.bmp, res.rem, res.stats); if (ed.pending) ed.applyResult();
        done = plan.list.length;
      } else {
        st.options.clearMask = false;   // the mask must stay until the last tile is done (the baker reports 'nothing remaining' for a single tile)
        for (let k = 0; k < plan.list.length; k++) {
          if (ed._runCancel) { reason = 'stopped'; break; }
          const idx = plan.list[k];
          ed._tileRun = { index: idx, done: finished.slice() };
          prog.textContent = `Tile ${k + 1} / ${plan.list.length} (grid tile ${idx}) ...`; ed.setStatus(prog.textContent);
          ed.invalidate();
          const res = await ed.hooks.generate();
          if (ed._runCancel) { reason = 'stopped'; break; }
          lastRem = res.rem;
          ed.showResult(res.bmp, res.rem, res.stats); if (ed.pending) ed.applyResult();
          finished.push(idx); done++;
          await sleep(50);
        }
      }
    } catch (e) {
      reason = 'error'; ed.log('error', 'Tile run failed', e); ed.setStatus('Tile run failed: ' + e.message, 'err');
    } finally {
      st.options.clearMask = clearOpt;
      if (!reason && T().mode === 'seq' && clearOpt && lastRem) { try { ed.importMaskBitmap(lastRem); } catch (_) { /* ignore */ } }
      ed._tileRun = null; ed._runBusy = false; bRun.disabled = false; bStop.disabled = true; ed.setProgress(null); ed.invalidate();
    }
    prog.textContent = `Finished (${reason || 'all tiles done'}): ${done} / ${plan.list.length} tiles.`;
    if (reason !== 'error') ed.setStatus(prog.textContent, reason === 'stopped' ? 'warn' : 'ok');
    return { done, total: plan.list.length, reason };
  };
  bRun.onclick = () => { ed.runTiles(); };
  bStop.onclick = () => { if (ed.stopRuns) ed.stopRuns(); };

  // ---- grid drawn over the UV map (called from the UV HUD)
  ed._tileHud = (ctx, ox, oy, w, hh, d) => {
    if (!st.capture.uvMode || !ed.hasModel) return;
    const W = ed.layers.w, H = ed.layers.h;
    const X = (px) => ox + (((px / W) - ed.uvView.cx) / d.halfW * 0.5 + 0.5) * w;
    const Y = (py) => oy + (1 - (((1 - py / H) - ed.uvView.cy) / d.halfH * 0.5 + 0.5)) * hh;
    if (ed._uvrefBmp && U().on) { ctx.save(); ctx.globalAlpha = 0.8; ctx.drawImage(ed._uvrefBmp, X(0), Y(0), X(W) - X(0), Y(H) - Y(0)); ctx.restore(); }
    if (!T().on) return;
    const p = ed.tilePlan(), set = new Set(p.list);
    ctx.save(); ctx.lineWidth = 1; ctx.font = '12px system-ui, sans-serif'; ctx.textAlign = 'center';
    for (const t of p.tiles) {
      const run = ed._tileRun && ed._tileRun.index === t.i, dn = ed._tileRun && ed._tileRun.done.includes(t.i);
      const x0 = X(t.cx0), x1 = X(t.cx1), y0 = Y(t.cy0), y1 = Y(t.cy1);
      ctx.fillStyle = run ? 'rgba(255,200,60,.22)' : dn ? 'rgba(80,220,120,.16)' : 'rgba(0,0,0,0)';
      ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([6, 4]); ctx.strokeStyle = set.has(t.i) ? 'rgba(255,200,60,.9)' : 'rgba(180,180,180,.45)'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      if (T().overlap > 0) { ctx.setLineDash([2, 3]); ctx.strokeStyle = 'rgba(120,200,255,.55)'; ctx.strokeRect(X(t.x0), Y(t.y0), X(t.x1) - X(t.x0), Y(t.y1) - Y(t.y0)); }
      ctx.setLineDash([]); ctx.fillStyle = set.has(t.i) ? 'rgba(255,230,140,.95)' : 'rgba(200,200,200,.5)';
      ctx.fillText(String(t.i + 1), (x0 + x1) / 2, (y0 + y1) / 2 + 4);
    }
    ctx.restore();
  };
}
