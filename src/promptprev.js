// Small panel under the UV map: the prompt that goes to the model with the next Queue, built from the node's prompt / style / mask widgets and the
// reference images (same rules as the Python node: composed instruction + reference and angle sentences). Preview only - the node's
// "prompt" output is the final text.
import { h } from './ui.js';

const COLOR_NAMES = { 'ff00ff': 'magenta', 'ff0000': 'red', '00ff00': 'green', '0000ff': 'blue', 'ffff00': 'yellow', '00ffff': 'cyan', 'ff8000': 'orange', 'ffffff': 'white' };
const word = (w) => (w < 0.34 ? 'subtly' : w < 0.67 ? 'clearly' : 'strongly');
const clean = (s, n) => String(s || '').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').slice(0, n);
const clamp01 = (v) => Math.min(1, Math.max(0, Number(v) || 0));

/** w = { prompt, style_hint, compose_prompt, mask_hint, hint_color } (node widgets), state = editor state, has2 / hasX = image present */
export function composePrompt(w, state, has2 = true, hasX = [true, true, true, true], uvUsed = null) {
  const r2 = state.ref2 || {};
  const uvm = !!(state.capture && state.capture.uvMode), uvr = uvm && !!(state.capture.uvref && state.capture.uvref.on);   // UV mode: image 2 is not used as a photo; with UV references the photos are projected instead
  const angleText = (n, slot) => { const ang = clean(slot.angle, 60), role = clean(slot.role, 200); let t = ''; if (ang) t += ` Image ${n} shows the subject from the ${ang}.`; if (role) t += ` Image ${n}: ${role}.`; return t; };
  const useRef = !!(r2.enabled && r2.has && has2) && !uvm;
  const r2w = useRef ? clamp01(r2.weight === undefined ? 0.7 : r2.weight) : 0;
  let extra = '';
  (state.refx || []).slice(0, 4).forEach((slot, i) => {
    const n = i + 3;
    if (!uvr && slot && slot.has && slot.enabled !== false && hasX[i]) {
      const wt = clamp01(slot.weight);
      extra += angleText(n, slot) || ` Also use image ${n} as an additional reference.`;
      if (wt > 0) extra += ` Use image ${n} as a ${word(wt)} reference for the material and pattern in the marked area.`;
    }
  });
  if (useRef) extra = angleText(2, r2) + extra;
  const heal = !!(state.heal && state.heal.on && String(state.heal.prompt || '').trim());   // Heal run: only the heal prompt
  const p = heal ? String(state.heal.prompt).replace(/\s+/g, ' ').trim() : String(w.prompt || '').trim(), style = heal ? '' : String(w.style_hint || '').trim().replace(/^\.+|\.+$/g, '');
  let refText = '';
  if (useRef && r2w > 0) refText = ` Use image 2 as a ${word(r2w)} reference for the material and pattern in the marked area; blend it naturally with the surface.`;
  refText += extra;
  if (uvr && uvUsed && uvUsed.length) refText += ` Use image 2 as a ${word(clamp01(state.capture.uvref.fill))} reference for the material and pattern in the marked area: it shows the same area of the texture painted from the reference photos (${uvUsed.map((u) => clean(u.angle, 60) || 'image ' + u.n).join(', ')}).`;
  if (heal) refText = '';
  if (w.compose_prompt === false) return p;
  if (w.mask_hint === 'none') return (style ? `${p}. ${style}.` : `${p}.`) + refText;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(w.hint_color || '').trim());
  let name = w.mask_hint === 'gray_fill' ? 'gray' : (COLOR_NAMES[m ? m[1].toLowerCase() : 'ff00ff'] || 'highlighted');
  if (useRef && r2w >= 0.67) name = 'highlighted';
  return `Repaint only the ${name} marked area: ${p}.` + refText + (style ? ` ${style}.` : '') + ' Keep everything outside the marked area exactly unchanged.' + (state.capture && state.capture.uvMode ? ' This image is a flat UV texture map of a 3D model; keep the shapes and borders of its islands unchanged.' : '');
}

export function installPromptPreview(ed) {
  const pane = ed.ui.paneUV, st = ed.state;
  if (st.promptPrev === undefined) st.promptPrev = { open: true };
  const box = h('div', 'tp-pprev');
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'dblclick', 'wheel', 'contextmenu', 'click', 'keydown']) box.addEventListener(ev, (e) => e.stopPropagation());
  const head = h('div', 'tp-pph'); const title = h('span', null, 'Prompt preview'); const info = h('span', 'tp-ppi', '');
  const bCopy = h('button', 'tp-btn', 'Copy'), bTog = h('button', 'tp-btn', '▾');
  bCopy.title = 'Copy the previewed prompt'; bTog.title = 'Show / hide';
  head.append(title, info, bCopy, bTog);
  const txt = h('div', 'tp-ppt'); box.append(head, txt); pane.append(box);
  const css = document.createElement('style');
  css.textContent = '.tp-pprev{position:absolute;left:0;right:0;bottom:0;z-index:4;background:rgba(14,16,21,.88);border-top:1px solid #3a4150;font-size:11px;color:#dfe5f3}.tp-pph{display:flex;gap:6px;align-items:center;padding:2px 6px}.tp-pph span:first-child{font-weight:600}.tp-ppi{flex:1;opacity:.6;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.tp-pph .tp-btn{padding:0 6px}.tp-ppt{max-height:84px;overflow:auto;padding:2px 8px 6px;white-space:pre-wrap;line-height:1.35;user-select:text}';
  ed.root.append(css);
  let last = null;
  const widgets = () => (ed.hooks.getWidgets ? ed.hooks.getWidgets() : null);
  const update = () => {
    const open = st.promptPrev.open; txt.style.display = open ? '' : 'none'; bTog.textContent = open ? '▾' : '▴';
    const w = widgets();
    const key = JSON.stringify([w, st.ref2, st.refx, ed.ref2Blob ? 1 : 0, open, st.capture.uvMode, st.capture.uvref]);
    if (key === last) return; last = key;
    if (!w) { txt.textContent = 'The prompt is built in the ComfyUI node (not available outside ComfyUI).'; info.textContent = ''; return; }
    const uvUsed = (st.capture.uvMode && st.capture.uvref && st.capture.uvref.on) ? [2, 3, 4, 5, 6].filter((n) => { const r = ed.refState(n); return r && r.has && r.enabled !== false && ed.refPose(n); }).map((n) => ({ n, angle: ed.refState(n).angle })) : null;
    const t = composePrompt(w, st, !!ed.ref2Blob || !!st.ref2.has, st.refx.map((r, i) => !!(ed.refxBlobs[i] || r.has)), uvUsed);
    txt.textContent = t || '(empty - type a prompt in the node)'; info.textContent = `${t.length} characters · preview of the text sent with the next Queue`;
  };
  bTog.onclick = () => { st.promptPrev.open = !st.promptPrev.open; last = null; update(); ed._dirty('settings'); };
  bCopy.onclick = async () => { try { await navigator.clipboard.writeText(txt.textContent); ed.setStatus('Prompt copied.', 'ok'); } catch (_) { ed.setStatus('Copy is not allowed here - select the text and press Ctrl+C.', 'warn'); } };
  const timer = setInterval(() => { if (ed.disposed) clearInterval(timer); else update(); }, 400);
  ed.promptPreviewUpdate = () => { last = null; update(); };
  const prev = ed._applyStateToUI; ed._applyStateToUI = () => { if (prev) prev(); last = null; update(); };
  update();
}
