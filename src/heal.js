// Heal brush (J): paint a dark-green "heal" area; with "Heal run" ticked the AI repaints ONLY that area, with its own prompt.
import { h, makeButton, makeCheck } from './ui.js';
import { HEAL_PROMPT, HEAL_SETTINGS } from './promptlib.js';

export function installHeal(ed) {
  const st = ed.state, body = ed.ui.sec.heal.body, hooks = () => ed.hooks || {};
  const dirty = () => ed._dirty('settings');
  const info = h('div', 'tp-note', '');
  const setInfo = (t, k) => { info.textContent = t; info.style.color = k === 'err' ? '#ff8a80' : k === 'warn' ? '#f0a23a' : k === 'ok' ? '#7bd88f' : ''; if (t) ed.setStatus(t, k || ''); };
  const W = {};
  const area = h('textarea'); area.rows = 5; area.style.cssText = 'width:100%;box-sizing:border-box;resize:vertical'; area.addEventListener('keydown', (e) => e.stopPropagation());
  area.addEventListener('input', () => { st.heal.prompt = area.value; dirty(); });
  const soft = () => { if (!st.heal.soft || !hooks().setWidget) return; hooks().setWidget('mask_grow', HEAL_SETTINGS.mask_grow); hooks().setWidget('mask_feather', HEAL_SETTINGS.mask_feather); };
  W.on = makeCheck('Heal run: the AI repaints ONLY the dark-green heal area, using ONLY the heal prompt below', !!st.heal.on, (v) => {
    st.heal.on = v; if (v) soft(); dirty(); ed.invalidate(); ed._applyStateToUI();
    if (v) setInfo(ed.hasModel && ed.healIsEmpty() ? 'Heal run is ON, but the heal area is empty - paint it with the Heal brush (J).' : 'Heal run is ON: Queue repaints only the dark-green area with the heal prompt (your normal prompt, selection, tiles and UV references are ignored).', ed.hasModel && ed.healIsEmpty() ? 'warn' : 'ok');
    else setInfo('Heal run is off: Queue uses your normal prompt and AI selection again.', 'ok');
  });
  W.soft = makeCheck(`Soft edges when healing (mask_grow ${HEAL_SETTINGS.mask_grow}, mask_feather ${HEAL_SETTINGS.mask_feather}, set when Heal run is switched on)`, st.heal.soft !== false, (v) => { st.heal.soft = v; dirty(); });
  const bPaint = makeButton('Heal brush (J)', 'Paint the area to heal (dark green). E / the eraser removes it.', 'tp-pri');
  const bClear = makeButton('Clear heal area', 'Remove the whole dark-green heal area (undoable)');
  const bReset = makeButton('Reset prompt', 'Restore the built-in heal prompt');
  bPaint.onclick = () => ed.healTool();
  bClear.onclick = () => { if (ed.hasModel) { ed.healClear(); setInfo('Heal area cleared.', 'ok'); } };
  bReset.onclick = () => { st.heal.prompt = HEAL_PROMPT; area.value = HEAL_PROMPT; dirty(); };
  const row = (...e) => { const r = h('div'); r.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:4px 0'; r.append(...e); return r; };
  body.append(row(bPaint, bClear), W.on.el, h('div', 'tp-lbl', 'Heal prompt (used alone while Heal run is on)'), area, row(bReset), W.soft.el, info,
    h('div', 'tp-note', 'Workflow: press J, paint the dark-green area over artifacts, stretched or smeared texture, seams or odd details; tick Heal run; queue. The AI sees only that area and the heal prompt, and the result is baked back only there. Untick Heal run to continue with normal painting - the heal area stays. Brush = add, Eraser (E) = remove, Rect / Lasso work too. Edit the prompt for a specific problem (e.g. "remove the visible seam and continue the brick pattern").'));

  /** J: heal brush on, J again: back to the AI selection */
  ed.healTool = () => {
    if (st.brushTarget === 'heal' && st.tool === 'brush') { st.brushTarget = 'selection'; ed.setTool('brush'); setInfo('Brush paints the AI selection again.', 'ok'); }
    else { st.brushTarget = 'heal'; ed.setTool('brush'); setInfo('Heal brush: paint the area to heal (dark green). E erases, J goes back to the normal brush.', 'ok'); }
    dirty();
  };
  const sync = () => { W.on.set(!!st.heal.on); W.soft.set(st.heal.soft !== false); if (document.activeElement !== area) area.value = st.heal.prompt || HEAL_PROMPT; };
  const prev = ed._applyStateToUI; ed._applyStateToUI = () => { if (prev) prev(); sync(); };
  sync();
}
