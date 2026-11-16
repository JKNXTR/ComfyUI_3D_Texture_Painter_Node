// "Combine layers" panel: weighted / normalised merge of several layers (and optionally the current view) into one new layer.
import { h, makeButton, makeCheck, makeSlider } from './ui.js';
import { combineLayers } from './combine.js';

export function installCombine(ed) {
  const st = ed.state, body = ed.ui.sec.cmb.body, L = ed.layers;
  const cs = () => st.combine;
  const dirty = () => ed._dirty('settings');

  const rowsEl = h('div'), info = h('div', 'tp-note', ''), stats = h('div', 'tp-note', '');
  const setInfo = (t, kind) => { info.textContent = t; info.style.color = kind === 'err' ? '#ff8a80' : kind === 'ok' ? '#7bd88f' : ''; };

  // ---- per-layer include + importance
  const defInc = (l) => l.visible && (l.ai || !L.layers.some((x) => x.ai));
  // only explicit choices are stored; untouched layers follow the default (AI layers, or everything when there are none)
  const entry = (l) => { const w = cs().w; if (!w[l.id]) w[l.id] = { imp: 1 }; return w[l.id]; };
  const isInc = (l) => { const e = entry(l); return e.inc === undefined ? defInc(l) : !!e.inc; };
  const included = () => L.layers.map((l, i) => ({ l, i, e: entry(l) })).filter((x) => isInc(x.l) && x.e.imp > 0);
  const anchorSel = h('select'); anchorSel.style.cssText = 'width:100%';
  const render = () => {
    rowsEl.innerHTML = '';
    for (let i = L.layers.length - 1; i >= 0; i--) {
      const l = L.layers[i], e = entry(l);
      const box = h('div'); box.style.cssText = 'border-bottom:1px solid #2c3039;padding:2px 0';
      const chk = makeCheck(`${l.name}${l.ai ? '  (AI)' : ''}${l.visible ? '' : '  (hidden)'}`, isInc(l), (v) => { e.inc = v; dirty(); fillAnchor(); });
      const sl = makeSlider('Importance', { min: 0, max: 100, step: 1, value: Math.round(e.imp * 100), fmt: (v) => v + '%' }, (v) => { e.imp = v / 100; dirty(); fillAnchor(); });
      box.append(chk.el, sl.el); rowsEl.append(box);
    }
    fillAnchor();
  };
  const fillAnchor = () => {
    const inc = included(); anchorSel.innerHTML = '';
    for (const x of inc) { const o = h('option', null, x.l.name); o.value = x.l.id; anchorSel.append(o); }
    let a = cs().anchor;
    if (!inc.some((x) => x.l.id === a)) { const top = inc.slice().sort((p, q) => q.e.imp - p.e.imp || q.i - p.i)[0]; a = top ? top.l.id : ''; cs().anchor = a; }
    anchorSel.value = a;
  };
  anchorSel.onchange = () => { cs().anchor = anchorSel.value; dirty(); };

  // ---- options
  const mkSel = (label, key, opts) => {
    const r = h('div', 'tp-row'), sel = h('select');
    for (const [v, t] of opts) { const o = h('option', null, t); o.value = v; sel.append(o); }
    sel.value = cs()[key]; sel.onchange = () => { cs()[key] = sel.value; dirty(); sync(); };
    r.append(h('span', 'tp-lbl', label), sel, h('span')); return { el: r, sel };
  };
  const W = {};
  W.mode = mkSel('Mode', 'mode', [['weighted', 'Weighted average'], ['best', 'Best view (confidence wins)'], ['priority', 'Priority (most important on top)']]);
  W.sharp = makeSlider('Confidence sharpness', { min: 25, max: 400, step: 5, value: Math.round(cs().sharp * 100), fmt: (v) => (v / 100).toFixed(2) }, (v) => { cs().sharp = v / 100; dirty(); });
  W.detail = mkSel('Detail', 'detail', [['multiband', 'Multiband (soft colour, sharp detail)'], ['plain', 'Plain average']]);
  W.width = makeSlider('Blend width', { min: 8, max: 128, step: 1, value: cs().width, fmt: (v) => v + ' px' }, (v) => { cs().width = v; dirty(); });
  W.norm = mkSel('Normalize colours', 'normalize', [['off', 'Off'], ['anchor', 'Match to anchor layer (overlaps only)']]);
  W.nstr = makeSlider('Normalize strength', { min: 0, max: 100, step: 1, value: Math.round(cs().normStrength * 100), fmt: (v) => v + '%' }, (v) => { cs().normStrength = v / 100; dirty(); });
  W.fill = makeSlider('Fill gaps', { min: 0, max: 48, step: 1, value: cs().fill, fmt: (v) => v + ' px' }, (v) => { cs().fill = v; dirty(); });
  W.view = makeSlider('Current view importance', { min: 0, max: 100, step: 1, value: Math.round(cs().viewImp * 100), fmt: (v) => v + '%' }, (v) => { cs().viewImp = v / 100; dirty(); });
  W.hide = makeCheck('Hide the source layers after applying', true, () => {});
  // ---- transition mask (blue brush)
  W.useTr = makeCheck('Blend painted transition areas (blue)', cs().useTrans, (v) => { cs().useTrans = v; dirty(); sync(); });
  W.tw = makeSlider('Transition width', { min: 8, max: 256, step: 1, value: cs().tw, fmt: (v) => v + ' px' }, (v) => { cs().tw = v; dirty(); });
  W.trOnly = makeCheck('Output only the transition areas (rest transparent)', cs().transOnly, (v) => { cs().transOnly = v; dirty(); });
  W.showTr = makeCheck('Show the blue transition mask', cs().showTrans, (v) => { cs().showTrans = v; ed.invalidate(); dirty(); });
  const trInfo = h('div', 'tp-note', '');
  const bPaintTr = makeButton('Paint transitions', 'Switch the brush to the blue transition mask (Brush = paint, Eraser = remove)');
  const bClearTr = makeButton('Clear transitions', 'Remove the whole transition mask (undoable)');
  bPaintTr.onclick = () => { st.brushTarget = 'transition'; if (st.tool !== 'brush' && st.tool !== 'erase') ed.setTool('brush'); ed._applyStateToUI(); ed._dirty('settings'); ed.setStatus('Blue transition brush: paint where two layers should merge softly. Eraser removes.', 'ok'); };
  bClearTr.onclick = () => { if (ed.hasModel) ed.transClear(); };
  const trRow = h('div'); trRow.style.cssText = 'display:flex;gap:6px;margin:4px 0'; trRow.append(bPaintTr, bClearTr);
  const updTr = () => {
    if (!ed.hasModel) { trInfo.textContent = 'Load a model, then paint blue transition areas with the brush.'; return; }
    let n = 0; const b = ed._readTransPixels(); for (let i = 0; i < b.length; i += 4) if (b[i] > 4) n++;
    const f = n / (ed.maskSize * ed.maskSize);
    trInfo.textContent = f > 0 ? `Transition mask: ${(f * 100).toFixed(1)}% of the UV square is painted blue.` : 'Transition mask is empty (nothing painted yet).';
  };
  ed._onTransChanged = updTr;
  const anchorRow = h('div', 'tp-row'); anchorRow.append(h('span', 'tp-lbl', 'Anchor layer'), anchorSel, h('span'));
  const sync = () => {
    const m = cs().mode;
    W.sharp.el.style.display = m === 'weighted' ? '' : 'none';
    W.detail.el.style.display = m === 'priority' ? 'none' : '';
    W.width.el.style.display = m !== 'priority' && cs().detail === 'multiband' ? '' : 'none';
    const on = cs().normalize === 'anchor';
    W.nstr.el.style.display = on ? '' : 'none'; anchorRow.style.display = on ? '' : 'none';
    W.tw.el.style.display = W.trOnly.el.style.display = cs().useTrans ? '' : 'none';
    updTr();
  };

  // ---- compute
  const nextFrame = () => new Promise((r) => setTimeout(r, 30));
  const bytes = (rt) => L.toCanvas(rt).getContext('2d').getImageData(0, 0, L.w, L.h).data;
  const build = async () => {
    if (!ed.hasModel) throw new Error('Load a model first.');
    const inc = included();
    if (!inc.length && !(cs().viewImp > 0)) throw new Error('Tick at least one layer (importance above 0).');
    const w = L.w, hh = L.h;
    setInfo(`Reading ${inc.length} layer${inc.length === 1 ? '' : 's'} at ${w}x${hh} ...`); await nextFrame();
    const layers = inc.map((x) => ({ id: x.l.id, name: x.l.name, rgba: (() => { const a = L.adjustedRT(x.l); try { return bytes(a || x.l.pix); } finally { if (a) a.dispose(); } })(), mask: L.maskBytes(x.l), opacity: x.l.opacity, imp: x.e.imp }));
    if (cs().viewImp > 0) {
      const f = ed.viewFacingMap(); if (!f) throw new Error('The current view could not be read.');
      const comp = L.compositeCanvas().getContext('2d').getImageData(0, 0, w, hh).data;
      const m = new Uint8Array(f.length);
      for (let i = 0; i < f.length; i++) m[i] = f[i] < 40 ? 0 : f[i];          // grazing / hidden texels do not count as "seen now"
      layers.push({ id: '__view', name: 'Current view', rgba: comp, mask: m, opacity: 1, imp: cs().viewImp, fixed: true });
    }
    let trans = null;
    if (cs().useTrans && layers.length > 1 && !ed.transIsEmpty()) trans = ed.transBytes(w, hh);
    const anchorIndex = Math.max(0, layers.findIndex((l) => l.id === cs().anchor));
    setInfo('Combining ...'); await nextFrame();
    const cov = ed.getCoverage ? ed.getCoverage() : null;
    const t0 = performance.now();
    const res = combineLayers({ w, h: hh, layers, island: cov ? cov.island : null, opts: { mode: cs().mode, sharp: cs().sharp, detail: cs().detail, width: cs().width, normalize: cs().normalize, normStrength: cs().normStrength, anchorIndex, fill: cs().fill, trans, transWidth: cs().tw, transOnly: cs().transOnly } });
    res.ms = performance.now() - t0; res.names = layers.map((l) => l.name); res.ids = inc.map((x) => x.l.id);
    return res;
  };
  const describe = (res) => {
    const s = res.stats, pc = (v) => Math.round(v * 100) + '%';
    let t = `Combined ${s.layers} source${s.layers === 1 ? '' : 's'} (${s.mode}${s.mode === 'priority' ? '' : ', ' + cs().detail}): ${pc(s.coverage)} of the UV surface painted`;
    if (s.filled) t += ` (${s.filled.toLocaleString()} texels filled)`;
    if (s.transition) t += ` Transition areas blended: ${s.transition.toLocaleString()} texels (${cs().tw}px ramps${s.transOnly ? ', output = transitions only' : ''}).`;
    t += ` - ${Math.round(res.ms)} ms.`;
    const lines = [];
    for (const n of s.normalized) lines.push(n.skipped ? `"${n.name}": no overlap with the anchor chain - not matched` : `"${n.name}": matched (L ${n.dL >= 0 ? '+' : ''}${n.dL.toFixed(1)}, a ${n.da >= 0 ? '+' : ''}${n.da.toFixed(1)}, b ${n.db >= 0 ? '+' : ''}${n.db.toFixed(1)} on ${n.overlap.toLocaleString()} overlapping texels)`);
    return t + (lines.length ? '\n' + lines.join('\n') : '');
  };
  const toCanvas = (res) => {
    const c = document.createElement('canvas'); c.width = L.w; c.height = L.h;
    c.getContext('2d').putImageData(new ImageData(res.rgba, L.w, L.h), 0, 0);
    return c;
  };
  let busy = false;
  const run = (apply) => async () => {
    if (busy) return; busy = true; bPrev.disabled = bNow.disabled = true;
    try {
      const res = await build();
      const msg = describe(res);
      const wasAuto = st.options.autoApply; st.options.autoApply = false;
      try { ed.showResult(toCanvas(res), null, { kind: 'combine', transOnly: !!res.stats.transOnly, summary: msg.split('\n')[0] }); } finally { st.options.autoApply = wasAuto; }
      if (apply) {
        ed.applyResult();
        if (W.hide.get() && !res.stats.transOnly) { ed._pushLayerUndo(); for (const l of L.layers) if (res.ids.includes(l.id)) l.visible = false; L._changed(); }
      }
      stats.textContent = msg; setInfo(apply ? `Added the layer "${res.stats.transOnly ? 'Transition' : 'Combined'}".` : 'Preview shown - use the banner (Apply / Discard) or "Combine to new layer".', 'ok');
    } catch (e) { setInfo('Combine failed: ' + e.message, 'err'); ed.log('error', 'Combine failed', e); }
    finally { busy = false; bPrev.disabled = bNow.disabled = false; }
  };
  const bPrev = makeButton('Preview', 'Compute and show the result over the model (Apply / Discard in the banner)');
  const bNow = makeButton('Combine to new layer', 'Compute and add the result as a new layer called "Combined" (undoable)');
  bPrev.onclick = run(false); bNow.onclick = run(true);
  const brow = h('div', 'tp-row2'); brow.style.cssText = 'display:flex;gap:6px;margin:6px 0'; brow.append(bPrev, bNow);

  body.append(
    h('div', 'tp-lbl', 'Layers to combine (tick = include)'), rowsEl,
    W.mode.el, W.sharp.el, W.detail.el, W.width.el, W.norm.el, anchorRow, W.nstr.el, W.view.el, W.fill.el, h('div', 'tp-lbl', 'Smooth transitions (blue brush)'), W.useTr.el, W.tw.el, W.trOnly.el, W.showTr.el, trRow, trInfo, W.hide.el, brow, info, stats,
    h('div', 'tp-note', 'Weights per texel = importance x how well the texel was baked (AI layer alpha) x layer mask. Normalizing only compares colours where layers OVERLAP, so deliberately different areas stay different. "Current view importance" keeps what you see from the current camera (texels facing it) and harmonizes the rest. The result is a NEW layer; the sources stay (hidden if ticked). BLUE TRANSITIONS: paint with the blue brush where two layers disagree - inside the blue areas the layers cross-fade over the chosen width instead of switching abruptly (this also works with Priority mode).'),
  );
  const prev = ed._renderLayers; ed._renderLayers = () => { if (prev) prev(); render(); };
  const prevApply = ed._applyStateToUI; ed._applyStateToUI = () => { if (prevApply) prevApply(); W.mode.sel.value = cs().mode; W.detail.sel.value = cs().detail; W.norm.sel.value = cs().normalize; W.sharp.set(Math.round(cs().sharp * 100)); W.width.set(cs().width); W.nstr.set(Math.round(cs().normStrength * 100)); W.fill.set(cs().fill); W.view.set(Math.round(cs().viewImp * 100)); W.useTr.set(cs().useTrans); W.tw.set(cs().tw); W.trOnly.set(cs().transOnly); W.showTr.set(cs().showTrans); sync(); render(); };
  sync(); render();
  ed.combineLayersNow = run(true); ed.combinePreview = run(false);
}
