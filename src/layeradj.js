// Per-layer colour adjustment (non-destructive): brightness, contrast, saturation, hue and levels (black / white point, gamma).
// Applied while the layer stack is composited, so the viewport, the AI capture, the bake, exports and "Combine layers" all see the same colours.
import { h, makeButton, makeSlider } from './ui.js';
import { adjDefaults, adjActive } from './layers.js';

export function installLayerAdj(ed) {
  const L = () => ed.layers, body = ed.ui.sec.layers.body;
  const box = h('div'); box.style.cssText = 'border-top:1px solid #2c3039;margin-top:6px;padding-top:4px';
  const title = h('div', 'tp-lbl', 'Colour adjustment of the active layer'); title.style.fontWeight = '600';
  const S = {};
  const set = (key, v) => { const l = L().activeLayer; if (!l) return; L().setProp(L().active, { adj: { ...adjDefaults(), ...(l.adj || {}), [key]: v } }); };
  const sl = (key, label, min, max, step, scale, fmt) => { S[key] = { w: makeSlider(label, { min, max, step, value: 0, fmt }, (v) => set(key, v / scale)), scale, def: adjDefaults()[key] }; box.append(S[key].w.el); };
  sl('bri', 'Brightness', -100, 100, 1, 100, (v) => (v > 0 ? '+' : '') + v);
  sl('con', 'Contrast', -100, 100, 1, 100, (v) => (v > 0 ? '+' : '') + v);
  sl('sat', 'Saturation', -100, 100, 1, 100, (v) => (v > 0 ? '+' : '') + v);
  sl('hue', 'Hue', -180, 180, 1, 1, (v) => (v > 0 ? '+' : '') + v + '°');
  sl('lb', 'Levels: black', 0, 90, 1, 100, (v) => v + '%');
  sl('lw', 'Levels: white', 10, 100, 1, 100, (v) => v + '%');
  sl('gam', 'Levels: gamma', 20, 300, 1, 100, (v) => (v / 100).toFixed(2));
  const bReset = makeButton('Reset adjustment', 'Back to the layer\'s own colours');
  const bAll = makeButton('Copy to all layers', 'Give every layer the same adjustment as the active one');
  bReset.onclick = () => { const l = L().activeLayer; if (l && l.adj) L().setProp(L().active, { adj: null }); };
  bAll.onclick = () => { const a = L().activeLayer; if (!a) return; ed._pushLayerUndo(); for (const l of L().layers) l.adj = a.adj ? { ...a.adj } : null; ed._layersChanged(); };
  const r = h('div', 'tp-row2'); r.append(bReset, bAll); box.prepend(title); box.append(r);
  box.append(h('div', 'tp-note', 'Non-destructive (the layer\'s pixels are not changed). Order: levels, brightness, contrast, saturation, hue. Use it to bring an AI result back to the colours of the original texture - e.g. give the AI layer a little saturation / contrast, or pull its levels. It is applied everywhere the layers are used: viewport, AI capture, bake, export and Combine layers.'));
  body.append(box);
  const refresh = () => {
    const a = L().activeLayer, adj = (a && a.adj) || adjDefaults();
    for (const [k, o] of Object.entries(S)) o.w.set(Math.round((adj[k] === undefined ? o.def : adj[k]) * o.scale));
    bReset.disabled = !(a && adjActive(a.adj)); title.textContent = 'Colour adjustment of the active layer' + (a && adjActive(a.adj) ? ' (active)' : '');
  };
  const prev = ed._renderLayers; ed._renderLayers = () => { if (prev) prev(); refresh(); };
  refresh();
}
