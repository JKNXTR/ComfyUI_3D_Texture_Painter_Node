// DOM construction + CSS for the Texture Painter widget. No logic here - the editor wires events.

const CSS = /* css */ `
.tp-root{--bg:#17191e;--panel:#1e2128;--panel2:#252932;--line:#333845;--txt:#d9dde6;--dim:#8d94a5;--acc:#e24dd0;--acc2:#4da3ff;--ok:#4cc38a;--warn:#f0a23a;--err:#ef5b5b;
  position:relative;display:flex;flex-direction:column;width:100%;height:100%;min-height:360px;box-sizing:border-box;background:var(--bg);color:var(--txt);
  font:12px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;border:1px solid var(--line);border-radius:6px;overflow:hidden;outline:none;user-select:none;-webkit-user-select:none}
.tp-root *{box-sizing:border-box}
.tp-root.tp-embed{position:absolute;inset:0;width:auto;height:auto;min-height:0}
.tp-root.tp-full{position:fixed;inset:0;z-index:99999;border-radius:0;border:none}
.tp-top{display:flex;gap:6px;align-items:center;padding:5px 8px;background:var(--panel);border-bottom:1px solid var(--line);flex-wrap:wrap}
.tp-top .tp-sp{flex:1}
.tp-btn{background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:4px;padding:3px 9px;cursor:pointer;font:inherit;white-space:nowrap}
.tp-btn:hover{border-color:#5a6275;background:#2c313c}
.tp-btn:active{background:#343a47}
.tp-btn.tp-on{border-color:var(--acc);box-shadow:0 0 0 1px var(--acc) inset;color:#fff}
.tp-btn.tp-pri{background:#7a2a72;border-color:#a8399d}
.tp-btn.tp-pri:hover{background:#933489}
.tp-btn[disabled]{opacity:.45;cursor:default}
.tp-sel,.tp-root select{background:var(--panel2);color:var(--txt);border:1px solid var(--line);border-radius:4px;padding:2px 4px;font:inherit}
.tp-main{display:flex;flex:1;min-height:0}
.tp-tools{display:flex;flex-direction:column;gap:4px;padding:6px 4px;background:var(--panel);border-right:1px solid var(--line);width:52px;flex:none;align-items:stretch}
.tp-tools .tp-btn{padding:5px 0;text-align:center;font-size:11px;line-height:1.2}
.tp-tools .tp-ico{display:block;font-size:17px}
.tp-tools hr{border:none;border-top:1px solid var(--line);margin:3px 0;width:100%}
.tp-stage{position:relative;flex:1;min-width:0;background:#101216}
.tp-gl,.tp-hud{position:absolute;inset:0;width:100%;height:100%;display:block}
.tp-hud{pointer-events:none}
.tp-panes{position:absolute;inset:0;display:flex;gap:2px}
.tp-pane{position:relative;flex:1;min-width:0;min-height:0;touch-action:none}
.tp-pane.tp-hidden{display:none}
.tp-tag{position:absolute;left:8px;top:6px;font-size:10px;letter-spacing:.08em;color:#aab1c2;background:rgba(10,12,16,.55);padding:1px 6px;border-radius:3px;pointer-events:none}
.tp-side{width:clamp(240px,26%,320px);flex:none;overflow-y:auto;background:var(--panel);border-left:1px solid var(--line);padding:4px 0}
.tp-side details{border-bottom:1px solid var(--line)}
.tp-side summary{cursor:pointer;padding:6px 10px;font-weight:600;color:#c9cfdd;list-style:none}
.tp-side summary::before{content:"\\25B8";display:inline-block;width:12px;color:var(--dim)}
.tp-side details[open] summary::before{content:"\\25BE"}
.tp-sec{padding:2px 10px 8px}
.tp-row{display:grid;grid-template-columns:78px 1fr 52px;gap:6px;align-items:center;margin:3px 0}
.tp-row .tp-lbl{color:var(--dim)}
.tp-row .tp-val{width:100%;box-sizing:border-box;text-align:right;color:var(--txt);font:inherit;font-variant-numeric:tabular-nums;background:transparent;border:1px solid transparent;border-radius:3px;padding:1px 3px;cursor:text}
.tp-row .tp-val:hover{border-color:#4a5163}
.tp-row .tp-val:focus{border-color:var(--acc);background:#14161b;outline:none}
.tp-row input[type=range]{width:100%;margin:0;accent-color:var(--acc)}
.tp-row2{display:flex;gap:5px;flex-wrap:wrap;margin:4px 0;align-items:center}
.tp-row2 .tp-btn{flex:1 1 auto;padding:3px 6px}
.tp-chk{display:flex;gap:6px;align-items:center;margin:3px 0;color:var(--txt)}
.tp-note{color:var(--dim);font-size:11px;margin:3px 0}
.tp-banner{margin:6px 10px;padding:7px 8px;border:1px solid var(--acc);border-radius:5px;background:rgba(226,77,208,.09)}
.tp-banner.tp-hidden{display:none}
.tp-modal{position:absolute;inset:0;z-index:60;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:12px;box-sizing:border-box}
.tp-dlg{width:min(560px,100%);max-height:100%;overflow:auto;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px;box-shadow:0 10px 40px rgba(0,0,0,.5);box-sizing:border-box}
.tp-dlg h3{margin:0 0 8px;font-size:14px}
.tp-dlg input[type=text]{width:100%;box-sizing:border-box}
.tp-dirs{max-height:150px;overflow:auto;border:1px solid var(--line);border-radius:4px;background:var(--bg);margin:4px 0}
.tp-dirs div{padding:3px 8px;cursor:pointer;font-size:12px}
.tp-dirs div:hover{background:var(--panel2)}
.tp-dlg .tp-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:10px}
.tp-bottom{display:flex;gap:10px;align-items:center;padding:3px 8px;background:var(--panel);border-top:1px solid var(--line);color:var(--dim);font-size:11px;min-height:22px}
.tp-bottom .tp-msg{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-bottom .tp-msg.tp-err{color:var(--err)}
.tp-bottom .tp-msg.tp-warn{color:var(--warn)}
.tp-bottom .tp-msg.tp-ok{color:var(--ok)}
.tp-log{height:110px;overflow:auto;background:#0f1115;border:1px solid var(--line);border-radius:4px;padding:4px 6px;font:11px/1.35 ui-monospace,Consolas,monospace;white-space:pre-wrap;user-select:text;-webkit-user-select:text;color:#b8bfcc}
.tp-log .e{color:var(--err)}.tp-log .w{color:var(--warn)}.tp-log .o{color:var(--ok)}
/* layers */
.tp-layers{display:flex;flex-direction:column;gap:2px;max-height:230px;overflow:auto;margin:4px 0;border:1px solid var(--line);border-radius:5px;background:#12141a;padding:2px}
.tp-layer{display:flex;gap:6px;align-items:center;padding:2px 4px;border-radius:4px;border:1px solid transparent;cursor:pointer;user-select:none}
.tp-layer:hover{background:#1c2029}
.tp-layer.tp-sel{background:#2a1f2c;border-color:var(--acc)}
.tp-layer.tp-over{border-top:2px solid var(--acc2)}
.tp-layer canvas{width:30px;height:30px;border-radius:3px;border:1px solid #333845;flex:none}
.tp-layer .tp-nm{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tp-layer .tp-nm input{width:100%;box-sizing:border-box;background:#0f1115;color:var(--txt);border:1px solid var(--acc);border-radius:3px;font:inherit;padding:1px 3px}
.tp-layer .tp-sm{color:var(--dim);font-size:10px}
.tp-eye{width:18px;text-align:center;cursor:pointer;color:#aab1c2;flex:none}
.tp-eye.tp-off{opacity:.3}
.tp-radio{display:flex;gap:4px;margin:4px 0}
.tp-radio .tp-btn{flex:1;padding:3px 4px;font-size:11px}
.tp-thumb2{max-width:100%;max-height:96px;border:1px solid #333845;border-radius:4px;display:block;margin:4px 0}
.tp-drop{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(77,163,255,.15);border:2px dashed var(--acc2);color:#fff;font-size:16px;pointer-events:none;z-index:5}
.tp-drop.tp-show{display:flex}
.tp-empty{position:absolute;inset:0;display:flex;flex-direction:column;gap:8px;align-items:center;justify-content:center;color:var(--dim);pointer-events:none;text-align:center;padding:20px}
.tp-empty b{color:#c9cfdd;font-size:14px}
.tp-prog{width:120px;height:6px;border-radius:3px;background:#262a33;overflow:hidden;flex:none}
.tp-prog i{display:block;height:100%;width:0;background:var(--acc2,#4da3ff);transition:width .15s}
.tp-live{position:absolute;left:8px;bottom:8px;width:132px;border:1px solid #4da3ff;border-radius:4px;z-index:3;pointer-events:none;background:#000}
.tp-cands{display:flex;gap:6px;flex-wrap:wrap;margin:4px 0}
.tp-cand{width:64px;height:64px;border:2px solid var(--line);border-radius:5px;cursor:pointer;background:#12141a}
.tp-cand.tp-on{border-color:#ff4fd8}
.tp-help{position:absolute;right:10px;top:10px;z-index:6;max-width:330px;background:rgba(18,20,26,.96);border:1px solid var(--line);border-radius:6px;padding:8px 12px;display:none}
.tp-help.tp-show{display:block}
.tp-help kbd{background:#2c313c;border:1px solid #444b5b;border-radius:3px;padding:0 4px;font:11px ui-monospace,Consolas,monospace}
`;

let cssInjected = false;
export function injectCSS() {
  if (cssInjected || typeof document === 'undefined') return;
  const s = document.createElement('style');
  s.setAttribute('data-texpaint', '1');
  s.textContent = CSS;
  document.head.appendChild(s);
  cssInjected = true;
}

export function h(tag, cls, text, attrs) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
}

export function makeSlider(label, { min, max, step = 1, value, fmt }, onInput) {
  const row = h('div', 'tp-row');
  const lab = h('span', 'tp-lbl', label);
  const inp = h('input');
  inp.type = 'range';
  inp.min = min; inp.max = max; inp.step = step; inp.value = value;
  const val = h('input', 'tp-val');
  val.type = 'text'; val.spellcheck = false; val.autocomplete = 'off';
  val.title = 'Click to type an exact value (Enter = apply, Esc = cancel). While the field or the slider is focused: mouse wheel = one step, Shift = 10 steps, Ctrl = fine.';
  const f = fmt || ((v) => String(v));
  const lo = Number(min), hi = Number(max), st = Number(step) || 1;
  const isInt = Number.isInteger(st) && st >= 1;
  let cur = Number(value);
  // typed text -> raw slider value: fmt() is linear for percent / x100 / degree labels, so it is inverted from its two end points
  const num = (t) => { const m = String(t).replace(',', '.').match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/i); return m ? parseFloat(m[0]) : NaN; };
  const d0 = num(f(lo)), d1 = num(f(hi));
  const linear = Number.isFinite(d0) && Number.isFinite(d1) && d1 !== d0;
  const toRaw = (x) => (linear ? lo + ((x - d0) * (hi - lo)) / (d1 - d0) : x);
  const clamp = (v) => Math.min(hi, Math.max(lo, v));
  const show = () => { if (document.activeElement !== val) val.value = f(cur); };
  const apply = (raw) => {
    raw = clamp(raw);
    cur = isInt ? Math.round(raw) : Math.round(raw * 1e4) / 1e4;
    inp.value = cur; val.value = f(cur);
    onInput && onInput(cur);
  };
  inp.addEventListener('input', () => { cur = Number(inp.value); show(); onInput && onInput(cur); });
  const commit = () => { const x = num(val.value); if (Number.isFinite(x)) apply(toRaw(x)); else val.value = f(cur); };
  val.addEventListener('focus', () => val.select());
  val.addEventListener('blur', () => { if (val.dataset.edited) { delete val.dataset.edited; commit(); } else val.value = f(cur); });
  val.addEventListener('input', () => { val.dataset.edited = '1'; });
  const nudge = (dir, e) => {
    const k = e.shiftKey ? 10 : 1, fine = e.ctrlKey || e.altKey;
    const d = st * (fine && !isInt ? 0.1 : 1) * k * dir;
    delete val.dataset.edited; apply(cur + d);
    if (document.activeElement === val) val.select();
  };
  val.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { delete val.dataset.edited; commit(); val.blur(); }
    else if (e.key === 'Escape') { delete val.dataset.edited; val.value = f(cur); val.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') { e.preventDefault(); nudge(e.key === 'ArrowUp' ? 1 : -1, e); }
  });
  // wheel edits only after a click (focus) so scrolling the side panel is never hijacked
  const wheel = (e) => {
    if (document.activeElement !== val && document.activeElement !== inp) return;
    e.preventDefault(); e.stopPropagation();
    nudge(e.deltaY < 0 ? 1 : -1, e);
  };
  val.addEventListener('wheel', wheel, { passive: false });
  inp.addEventListener('wheel', wheel, { passive: false });
  val.value = f(cur);
  row.append(lab, inp, val);
  return {
    el: row,
    get: () => cur,
    set: (v) => { cur = Number(v); inp.value = v; show(); },
    input: val, range: inp,
  };
}

export function makeCheck(label, value, onChange) {
  const l = h('label', 'tp-chk');
  const c = h('input');
  c.type = 'checkbox'; c.checked = !!value;
  c.addEventListener('change', () => onChange && onChange(c.checked));
  l.append(c, h('span', null, label));
  return { el: l, get: () => c.checked, set: (v) => { c.checked = !!v; } };
}

export function makeSection(title, open = true) {
  const d = h('details');
  if (open) d.open = true;
  d.append(h('summary', null, title));
  const body = h('div', 'tp-sec');
  d.append(body);
  return { el: d, body };
}

export function makeButton(text, title, cls) {
  const b = h('button', 'tp-btn' + (cls ? ' ' + cls : ''), text);
  b.type = 'button';
  if (title) b.title = title;
  return b;
}

/** Builds the full widget DOM. Returns references; wiring is done by the editor. */
export function buildUI() {
  injectCSS();
  const root = h('div', 'tp-root', null, { tabindex: '0' });

  // ---- top bar
  const top = h('div', 'tp-top');
  const bLoadModel = makeButton('Load model', 'Load a UV-unwrapped .glb / .gltf / .obj / .fbx (or drop a file on the viewport)');
  const bLoadTex = makeButton('Load texture', 'Load a PNG/JPG texture (UV map image)');
  const bNewTex = makeButton('New texture', 'Create a blank texture');
  const bSaveTex = makeButton('Save texture', 'Download the current texture as PNG');
  const layout = h('select', 'tp-sel', null, { title: 'Layout (keys 1 / 2 / 3)' });
  for (const [v, t] of [['split', 'Split 3D | UV'], ['3d', '3D only'], ['uv', 'UV only']]) { const o = h('option', null, t); o.value = v; layout.append(o); }
  const bSync = makeButton('Sync', 'Capture the current view now and store it for the workflow (also happens automatically on Queue)');
  const bFull = makeButton('Fullscreen', 'Toggle fullscreen (Esc to leave)');
  const bHelp = makeButton('?', 'Shortcuts');
  const spacer = h('span', 'tp-sp');
  top.append(bLoadModel, bLoadTex, bNewTex, bSaveTex, layout, spacer, bSync, bFull, bHelp);

  // ---- tool column
  const tools = h('div', 'tp-tools');
  const mkTool = (ico, txt, title) => { const b = makeButton('', title); b.innerHTML = `<span class="tp-ico">${ico}</span>${txt}`; return b; };
  const tBrush = mkTool('\u{1F58C}', 'Brush', 'Paint mask (B)');
  const tErase = mkTool('\u{1F9FD}', 'Erase', 'Erase mask (E)');
  const tRect = mkTool('\u25AD', 'Rect', 'Rectangle selection (R) - drag; hold Alt to remove');
  const tLasso = mkTool('\u27B0', 'Lasso', 'Freehand lasso selection (L) - drag; hold Alt to remove');
  const tSelect = mkTool('\u2196', 'Select', 'Select tool (V) - click an object to make it the working object in the hierarchy (Ctrl / Shift-click adds, Alt-click = its parent group)');
  const tHeal = mkTool('\u271A', 'Heal', 'Heal brush (J) - paint the dark-green area the AI should heal; E erases; J again = normal brush');
  const tNav = mkTool('\u{1F9ED}', 'Orbit', 'Navigate only (N) - hold Space for temporary orbit');
  const tUndo = mkTool('↩', 'Undo', 'Undo (Ctrl+Z)');
  const tRedo = mkTool('↪', 'Redo', 'Redo (Ctrl+Y)');
  const tFrameMask = mkTool('◎', 'Mask', 'Frame the painted mask (F)');
  const tFrameModel = mkTool('⌂', 'Model', 'Frame the whole model (Home)');
  const tClearMask = mkTool('\u{1F5D1}', 'Clear', 'Remove ALL painted mask (AI selection). Undo brings it back.');
  tools.append(tBrush, tErase, tHeal, tRect, tLasso, tSelect, tNav, h('hr'), tUndo, tRedo, h('hr'), tFrameMask, tFrameModel, h('hr'), tClearMask);

  // ---- stage
  const stage = h('div', 'tp-stage');
  const glCanvas = h('canvas', 'tp-gl');
  const panes = h('div', 'tp-panes');
  const pane3d = h('div', 'tp-pane');
  const paneUV = h('div', 'tp-pane');
  pane3d.append(h('span', 'tp-tag', '3D VIEW'));
  paneUV.append(h('span', 'tp-tag', 'UV MAP'));
  panes.append(pane3d, paneUV);
  const hudCanvas = h('canvas', 'tp-hud');
  const drop = h('div', 'tp-drop', 'Drop a .glb / .gltf / .obj / .fbx model or a texture image here');
  const empty = h('div', 'tp-empty');
  empty.innerHTML = '<b>No model loaded</b><span>Click <i>Load model</i> or drop a UV-unwrapped<br>.glb / .gltf / .obj / .fbx file on this area.</span>';
  const help = h('div', 'tp-help');
  help.innerHTML = '<b>Shortcuts</b><br><kbd>B</kbd> brush &nbsp;<kbd>E</kbd> eraser &nbsp;<kbd>N</kbd> orbit &nbsp;<kbd>V</kbd> select object &nbsp;<kbd>J</kbd> heal brush<br>' +
    '<kbd>X</kbd> swap brush/eraser &nbsp;<kbd>[</kbd> <kbd>]</kbd> size<br>' +
    '<kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd> undo / redo<br>' +
    '<kbd>F</kbd> frame mask &nbsp;<kbd>Home</kbd> frame model<br>' +
    '<kbd>M</kbd> show/hide mask &nbsp;<kbd>1</kbd><kbd>2</kbd><kbd>3</kbd> layouts<br>' +
    '<kbd>Space</kbd> hold = orbit with left mouse<br>' +
    'Middle mouse = orbit, right mouse = pan, wheel = zoom.<br>' +
    'UV map: wheel = zoom, middle/right/Space-drag = pan, <kbd>Home</kbd> = fit.<br>' +
    '<span style="color:#f0a23a">Orange</span> mask = seen at a grazing angle, will bake poorly from this camera.';
  stage.append(glCanvas, panes, hudCanvas, empty, drop, help);

  // ---- side panel
  const side = h('div', 'tp-side');

  const secPre = makeSection('Presets & state');
  const secCmb = makeSection('Combine layers');
  const secTrP = makeSection('Transition prompts', false);
  const secHar = makeSection('Final harmonize', false);
  const secHeal = makeSection('Heal brush (J)', false);
  const secObj = makeSection('Objects (hierarchy)');
  secObj.el.style.display = 'none';
  const secBrush = makeSection('Brush');
  const secMask = makeSection('Mask');
  const secLayers = makeSection('Layers');
  const secPlan = makeSection('Coverage, views & variations', false);
  const secPrompt = makeSection('Prompt helper', false);
  const secRef = makeSection('Reference image 2', false);
  const secXf = makeSection('Model transform');
  const secCap = makeSection('Capture / generation view');
  const secViews = makeSection('View regions (reference views 3-6)', false);
  const secResM = makeSection('Resolution match (AI render vs texture)', false);
  const secPbr = makeSection('PBR material (maps & preview)', false);
  const secDisp = makeSection('Display', false);
  const secRes = makeSection('Result');
  const secExp = makeSection('Export / bake', false);
  const secLog = makeSection('Log', false);
  side.append(secPre.el, secObj.el, secBrush.el, secMask.el, secLayers.el, secCmb.el, secTrP.el, secHar.el, secHeal.el, secPlan.el, secPrompt.el, secRef.el, secViews.el, secXf.el, secCap.el, secResM.el, secPbr.el, secDisp.el, secRes.el, secExp.el, secLog.el);

  const banner = h('div', 'tp-banner tp-hidden');
  side.insertBefore(banner, secBrush.el);

  const logEl = h('div', 'tp-log');
  const bCopyLog = makeButton('Copy log');
  const bClearLog = makeButton('Clear');
  const logRow = h('div', 'tp-row2');
  logRow.append(bCopyLog, bClearLog);
  secLog.body.append(logEl, logRow);

  // ---- bottom
  const bottom = h('div', 'tp-bottom');
  const msg = h('span', 'tp-msg', 'Ready.');
  const stats = h('span', 'tp-stats', '');
  const syncState = h('span', 'tp-sync', '');
  const saveState = h('span', 'tp-sync', '');
  saveState.title = 'The model, layers, mask and settings are saved automatically';
  const prog = h('span', 'tp-prog'); const progBar = h('i'); prog.append(progBar); prog.style.display = 'none';
  bottom.append(msg, prog, saveState, syncState, stats);
  const live = h('img', 'tp-live'); live.style.display = 'none'; live.alt = 'live sampler preview';
  pane3d.append(live);

  const main = h('div', 'tp-main');
  main.append(tools, stage, side);
  root.append(top, main, bottom);

  return {
    root, top, main, stage, glCanvas, hudCanvas, pane3d, paneUV, side, panes, empty, drop, help, banner,
    msg, stats, syncState, saveState, logEl, prog, progBar, live,
    btn: { bLoadModel, bLoadTex, bNewTex, bSaveTex, bSync, bFull, bHelp, tBrush, tErase, tRect, tLasso, tSelect, tHeal, tNav, tUndo, tRedo, tFrameMask, tFrameModel, tClearMask, bCopyLog, bClearLog },
    layout,
    sec: { pre: secPre, obj: secObj, brush: secBrush, mask: secMask, layers: secLayers, cmb: secCmb, trp: secTrP, har: secHar, heal: secHeal, plan: secPlan, prompt: secPrompt, ref: secRef, views: secViews, exp: secExp, xf: secXf, cap: secCap, resm: secResM, pbr: secPbr, disp: secDisp, res: secRes, },
  };
}
