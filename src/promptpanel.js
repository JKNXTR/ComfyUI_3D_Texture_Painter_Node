// Two panels: "Transition prompts" (prompt library for the blue transition mask) and "Final harmonize" (whole-surface normalisation pass).
import { h, makeButton, makeCheck, makeSlider } from './ui.js';
import { TR_CATEGORIES, TRANSITION_PROMPTS, TRANSITION_SETTINGS, HARMONIZE_PROMPTS, HARMONIZE_STYLE, promptsByCategory } from './promptlib.js';

export function installPromptPanels(ed) {
  const st = ed.state, hooks = () => ed.hooks || {};
  const dirty = () => ed._dirty('settings');
  const setPrompt = (t, append) => {
    const H = hooks(); if (!H.setPrompt) { ed._promptText = t; return false; }
    const cur = H.getPrompt ? String(H.getPrompt() || '').trim() : '';
    H.setPrompt(append && cur ? cur.replace(/[.\s]+$/, '') + '. ' + t : t); return true;
  };
  const setWidget = (n, v) => (hooks().setWidget ? hooks().setWidget(n, v) : false);
  const setBake = (n, v) => (hooks().setBakeWidget ? hooks().setBakeWidget(n, v) : 0);

  // ------------------------------------------------------------------ transition prompts
  const tb = ed.ui.sec.trp.body;
  const custom = () => st.tprompts;
  const all = () => [...TRANSITION_PROMPTS, ...custom().map((c) => ({ ...c, cat: c.cat || 'custom', custom: true }))];
  const catSel = h('select'); catSel.style.cssText = 'width:100%';
  for (const [v, t] of [['all', 'All categories'], ...TR_CATEGORIES, ['custom', 'My prompts']]) { const o = h('option', null, t); o.value = v; catSel.append(o); }
  const list = h('div', 'tp-dirs'); list.style.maxHeight = '170px';
  const area = h('textarea'); area.rows = 4; area.style.cssText = 'width:100%;box-sizing:border-box;resize:vertical'; area.addEventListener('keydown', (e) => e.stopPropagation());
  const nameIn = h('input'); nameIn.type = 'text'; nameIn.placeholder = 'Name for "Save as my prompt"'; nameIn.maxLength = 50; nameIn.style.cssText = 'width:100%;box-sizing:border-box'; nameIn.addEventListener('keydown', (e) => e.stopPropagation());
  const info = h('div', 'tp-note', '');
  let cur = null;
  const setInfo = (t, k) => { info.textContent = t; info.style.color = k === 'err' ? '#ff8a80' : k === 'ok' ? '#7bd88f' : ''; ed.setStatus(t, k || ''); };
  const items = () => (catSel.value === 'custom' ? all().filter((p) => p.custom) : catSel.value === 'all' ? all() : all().filter((p) => p.cat === catSel.value));
  const renderList = () => {
    list.innerHTML = '';
    const it = items();
    if (!it.length) list.append(h('div', null, '(nothing here yet)'));
    for (const p of it) {
      const row = h('div', null, (p.custom ? '★ ' : '') + p.title); row.title = p.text; if (cur && cur.id === p.id) row.style.background = 'var(--panel2)';
      row.onclick = () => { cur = p; area.value = p.text; nameIn.value = p.custom ? p.title : ''; bDel.disabled = !p.custom; renderList(); };
      list.append(row);
    }
  };
  catSel.onchange = renderList;
  const W = {};
  W.useMask = makeCheck('AI paints in the BLUE transition mask (instead of the AI selection)', st.gen.maskSource === 'transition', (v) => { st.gen.maskSource = v ? 'transition' : 'selection'; dirty(); ed.invalidate(); sync(); });
  W.soft = makeCheck(`Soft mask edges for blending (mask_grow ${TRANSITION_SETTINGS.mask_grow}, mask_feather ${TRANSITION_SETTINGS.mask_feather}, Bake strength ${TRANSITION_SETTINGS.bakeStrength})`, true, () => {});
  const bUse = makeButton('Use as prompt', 'Replace the painter prompt with this text and switch the AI to the transition mask', 'tp-pri');
  const bAdd = makeButton('Add to prompt', 'Append this text to the painter prompt');
  const bSave = makeButton('Save as my prompt', 'Store the text above under the name typed below');
  const bDel = makeButton('Delete', 'Delete the selected personal prompt'); bDel.disabled = true;
  const applyTransition = (append) => {
    const text = area.value.trim();
    if (!text) return setInfo('Choose or type a prompt first.', 'warn');
    st.gen.maskSource = 'transition'; dirty();
    setPrompt(text, append);
    let n = 0;
    if (W.soft.get()) { setWidget('mask_grow', TRANSITION_SETTINGS.mask_grow); setWidget('mask_feather', TRANSITION_SETTINGS.mask_feather); n = setBake('strength', TRANSITION_SETTINGS.bakeStrength); }
    sync(); ed.invalidate();
    const empty = ed.hasModel && ed.transIsEmpty();
    setInfo(empty ? 'Prompt set and the AI will use the transition mask - but the blue mask is EMPTY: paint it first (Brush -> Transition (blue)).' : 'Prompt set. The AI will repaint only the blue transition areas. Queue the workflow.' + (n ? ` Bake strength set on ${n} Bake node${n === 1 ? '' : 's'}.` : ''), empty ? 'warn' : 'ok');
  };
  bUse.onclick = () => applyTransition(false); bAdd.onclick = () => applyTransition(true);
  bSave.onclick = () => {
    const text = area.value.trim(), name = nameIn.value.trim();
    if (!text || !name) return setInfo('Type the prompt text and a name.', 'warn');
    const ex = custom().find((c) => c.title === name);
    if (ex) ex.text = text; else custom().push({ id: 'my-' + Date.now().toString(36), title: name, text, cat: 'custom' });
    if (custom().length > 60) custom().shift();
    dirty(); catSel.value = 'custom'; cur = all().find((c) => c.custom && c.title === name); bDel.disabled = false; renderList(); setInfo(`Saved "${name}" in My prompts.`, 'ok');
  };
  bDel.onclick = () => {
    if (!cur || !cur.custom) return;
    const i = custom().findIndex((c) => c.id === cur.id); if (i >= 0) custom().splice(i, 1);
    cur = null; area.value = ''; bDel.disabled = true; dirty(); renderList(); setInfo('Deleted.', 'ok');
  };
  const row = (...e) => { const r = h('div'); r.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:4px 0'; r.append(...e); return r; };
  tb.append(h('div', 'tp-lbl', 'Category'), catSel, list, h('div', 'tp-lbl', 'Prompt text (editable)'), area, row(bUse, bAdd), W.soft.el, W.useMask.el,
    h('div', 'tp-lbl', 'My prompts'), nameIn, row(bSave, bDel), info,
    h('div', 'tp-note', 'Workflow: paint the seam / join areas with the blue brush (Brush -> Transition (blue)), pick a prompt, press "Use as prompt", queue. The AI then repaints ONLY the blue areas and the Bake node projects the result back; soft edges make it fade into the surroundings. The transition mask is used for the AI only while the checkbox above is on - the Combine layers panel uses it independently. Coverage planning and Auto multi-view still work on the AI selection mask.'));

  // ------------------------------------------------------------------ final harmonize
  const hb = ed.ui.sec.har.body;
  const hSel = h('select'); hSel.style.cssText = 'width:100%';
  for (const p of HARMONIZE_PROMPTS) { const o = h('option', null, p.title); o.value = p.id; hSel.append(o); }
  const hArea = h('textarea'); hArea.rows = 4; hArea.style.cssText = 'width:100%;box-sizing:border-box;resize:vertical'; hArea.addEventListener('keydown', (e) => e.stopPropagation());
  const hInfo = h('div', 'tp-note', '');
  const hset = (t, k) => { hInfo.textContent = t; hInfo.style.color = k === 'err' ? '#ff8a80' : k === 'ok' ? '#7bd88f' : ''; ed.setStatus(t, k || ''); };
  const cur2 = () => HARMONIZE_PROMPTS.find((p) => p.id === hSel.value) || HARMONIZE_PROMPTS[0];
  let hStrength = null;
  const loadH = () => { const p = cur2(); hArea.value = p.text; st.har.strength = p.strength; if (hStrength) hStrength.set(Math.round(p.strength * 100)); st.har.preset = p.id; };
  hSel.onchange = () => { loadH(); dirty(); };
  hStrength = makeSlider('Bake strength for the pass', { min: 20, max: 100, step: 5, value: Math.round(cur2().strength * 100), fmt: (v) => (v / 100).toFixed(2) }, (v) => { st.har.strength = v / 100; dirty(); });
  const bFlat = makeButton('Step 1: Flatten & normalize (no AI)', 'Combine all AI layers into one new layer: weighted + multiband + colour matching + gap fill (uses the Combine layers panel, honours the blue transition mask)');
  const bPrep = makeButton('Step 2: Prepare AI harmonize pass', 'Select the whole surface, set the prompt and the soft / unmarked settings, then queue the workflow', 'tp-pri');
  const busy = (b, fn) => async () => { b.disabled = true; try { await fn(); } catch (e) { hset('Failed: ' + e.message, 'err'); ed.log('error', 'Harmonize step failed', e); } b.disabled = false; };
  bFlat.onclick = busy(bFlat, async () => {
    if (!ed.hasModel) throw new Error('Load a model first.');
    Object.assign(st.combine, { mode: 'weighted', detail: 'multiband', normalize: 'anchor', normStrength: 0.8, fill: 12 });
    ed._applyStateToUI(); dirty();
    await ed.combineLayersNow();
    hset('Flattened into one "Combined" layer (colour matched, multiband blended). Now run Step 2 from several cameras.', 'ok');
  });
  bPrep.onclick = busy(bPrep, async () => {
    if (!ed.hasModel) throw new Error('Load a model first.');
    const text = hArea.value.trim(); if (!text) throw new Error('The prompt is empty.');
    ed.maskFill();                       // whole surface = AI selection (undoable); only what the camera sees is sent
    st.gen.maskSource = 'selection'; dirty();
    setPrompt(text, false);
    setWidget('mask_hint', 'none'); setWidget('hint_strength', 0); setWidget('mask_grow', 0); setWidget('mask_feather', 8); setWidget('style_hint', HARMONIZE_STYLE);
    const n = setBake('strength', st.har.strength);
    ed._applyStateToUI(); ed.invalidate();
    hset(`Prepared: the whole visible surface is selected, prompt set, mask marker off, Bake strength ${st.har.strength.toFixed(2)}${n ? ` (set on ${n} Bake node${n === 1 ? '' : 's'})` : ' (set it on the Bake node yourself)'}. Queue, apply, rotate the camera to the next view and repeat (4-8 views).`, 'ok');
  });
  const bUndoSel = makeButton('Clear the AI selection again', 'Empty the AI selection mask (undoable)'); bUndoSel.onclick = () => { if (ed.hasModel) { ed.maskClear(); hset('AI selection cleared.', 'ok'); } };
  hb.append(h('div', 'tp-lbl', 'Normalization prompt'), hSel, hArea, hStrength.el, bFlat, bPrep, bUndoSel, hInfo,
    h('div', 'tp-note', 'How it works: Klein cannot read a flat UV atlas, so the harmonize pass is made in VIEW space: the whole visible surface is sent with an "unify, remove borders, photorealistic" prompt at a reduced Bake strength, and every pass fixes what that camera sees. Step 1 first merges your layers without AI so the AI only has small differences to fix. Repeat Step 2 from 4-8 cameras (the Coverage panel suggests them); seam-aware blending between passes is on by default. Lower Bake strength = safer, higher = stronger unification but more risk of repainted detail. Results are not guaranteed photorealistic - check each pass and use undo.'));
  const showH = () => {   // show the saved preset + strength (state restore); the text is always the preset's own text
    if (HARMONIZE_PROMPTS.some((p) => p.id === st.har.preset)) hSel.value = st.har.preset;
    hArea.value = cur2().text; hStrength.set(Math.round((st.har.strength || cur2().strength) * 100));
  };
  showH();

  const sync = () => { W.useMask.set(st.gen.maskSource === 'transition'); };
  const prev = ed._applyStateToUI; ed._applyStateToUI = () => { if (prev) prev(); sync(); renderList(); showH(); };
  renderList(); sync();
  ed.useTransitionPrompt = (id, append) => { const p = all().find((x) => x.id === id); if (!p) return false; cur = p; area.value = p.text; applyTransition(!!append); return true; };
}
