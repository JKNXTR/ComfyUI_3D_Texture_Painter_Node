// Presets (named settings snapshots shared by every workflow) and the explicit "Save state now" action.
import { h, makeButton, makeCheck } from './ui.js';
import { DEFAULT_STATE } from './editor.js';

// what a preset stores: tool settings only - never the model, mask, layers or the reference image itself
const SETTINGS = ['brushTarget', 'layers', 'blend', 'export', 'tool', 'brush', 'erase', 'pen', 'mask', 'capture', 'display', 'plan', 'gen', 'options', 'combine'];
const REF_SETTINGS = ['weight', 'mode', 'scale', 'original', 'bg', 'bgOpacity'];
const REF_PLACEMENT = ['ox', 'oy', 'size', 'sx', 'sy', 'rot', 'aspect', 'fit', 'wrap'];

export function installPresets(ed) {
  const st = ed.state, sec = ed.ui.sec.pre, body = sec.body;
  const scope = { camera: false, xform: false, place: false };
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // ---- data
  ed.buildPreset = () => {
    const s = ed.getState(), data = { v: 1, settings: {}, ref2: {}, scope: { ...scope } };
    for (const k of SETTINGS) if (s[k] !== undefined) data.settings[k] = clone(s[k]);
    if (data.settings.gen) delete data.settings.gen.maskSource;   // which mask the AI uses is a per-job choice, never carried by a preset
    if (data.settings.combine) { delete data.settings.combine.w; delete data.settings.combine.anchor; }   // layer ids do not carry over between projects
    for (const k of REF_SETTINGS) data.ref2[k] = s.ref2[k];
    if (scope.place) for (const k of REF_PLACEMENT) data.ref2[k] = s.ref2[k];
    if (scope.camera && s.camera) data.camera = clone(s.camera);
    if (scope.xform) data.xform = clone(s.xform);
    return data;
  };
  ed.applyPreset = (data) => {
    if (!data || typeof data !== 'object') throw new Error('Not a preset.');
    const partial = { ...clone(data.settings || {}), ref2: clone(data.ref2 || {}) };
    if (data.camera) partial.camera = clone(data.camera);
    if (data.xform) partial.xform = clone(data.xform);
    ed.applyState(partial);
    if (data.xform && ed.hasModel) ed.applyTransform();
    ed._dirty('settings'); ed._dirty('ref2'); ed.hudDirty = true; ed.invalidate();
  };
  ed.resetSettings = () => {
    const d = DEFAULT_STATE(), p = { ref2: {} };
    for (const k of SETTINGS) p[k] = d[k];
    for (const k of [...REF_SETTINGS, ...REF_PLACEMENT]) p.ref2[k] = d.ref2[k];
    ed.applyState(p);
    ed._dirty('settings'); ed._dirty('ref2'); ed.hudDirty = true; ed.invalidate();
  };

  // ---- storage: the server (shared by all workflows) or, without a server (standalone preview), the browser
  const LS = 'tp_presets_v1';
  const lsRead = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}'); } catch (_) { return {}; } };
  const lsWrite = (o) => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (_) { /* private mode */ } };
  const local = {
    list: async () => Object.entries(lsRead()).map(([name, v]) => ({ name, modified: v.modified })).sort((a, b) => a.name.localeCompare(b.name)),
    get: async (n) => { const v = lsRead()[n]; if (!v) throw new Error('No such preset.'); return v.data; },
    put: async (n, data, overwrite) => { const o = lsRead(); if (o[n] && !overwrite) return { exists: true }; o[n] = { data, modified: Date.now() / 1000 }; lsWrite(o); return { ok: true }; },
    del: async (n) => { const o = lsRead(); delete o[n]; lsWrite(o); },
    rename: async (a, b) => { const o = lsRead(); if (!o[a]) throw new Error('No such preset.'); if (o[b] && a !== b) return { exists: true }; o[b] = o[a]; if (a !== b) delete o[a]; lsWrite(o); return { ok: true }; },
  };
  const store = () => ed.hooks.presets || local;

  // ---- UI
  const info = h('div', 'tp-note', '');
  const setInfo = (t, kind) => { info.textContent = t; info.style.color = kind === 'err' ? '#ff8a80' : kind === 'ok' ? '#7bd88f' : ''; ed.setStatus(t, kind || ''); };
  const sel = h('select'); sel.style.cssText = 'width:100%';
  const nameIn = h('input'); nameIn.type = 'text'; nameIn.placeholder = 'Preset name'; nameIn.maxLength = 60; nameIn.style.cssText = 'width:100%;box-sizing:border-box';
  nameIn.addEventListener('keydown', (e) => e.stopPropagation());
  const bLoad = makeButton('Load', 'Apply the selected preset'), bSaveAs = makeButton('Save as…', 'Store the current settings under the name typed above'),
    bOver = makeButton('Overwrite', 'Replace the selected preset with the current settings'), bRename = makeButton('Rename', 'Rename the selected preset to the name typed above'),
    bDel = makeButton('Delete', 'Delete the selected preset'), bDef = makeButton('Defaults', 'Reset all tool settings to their defaults');
  const row = (...els) => { const r = h('div', 'tp-row2'); r.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin:4px 0'; r.append(...els); return r; };

  // destructive buttons need a second click within 3 s
  const armed = (btn, text, fn) => {
    const orig = btn.textContent; let t = null;
    btn.onclick = async () => {
      if (t) { clearTimeout(t); t = null; btn.textContent = orig; btn.classList.remove('tp-on'); await fn(); return; }
      btn.textContent = text; btn.classList.add('tp-on');
      t = setTimeout(() => { t = null; btn.textContent = orig; btn.classList.remove('tp-on'); }, 3000);
    };
  };
  const guard = (fn) => async () => { try { await fn(); } catch (e) { setInfo('Preset error: ' + e.message, 'err'); ed.log('error', 'Preset operation failed', e); } };
  const chosen = () => sel.value;
  const refresh = async (select) => {
    let list = [];
    try { list = await store().list(); } catch (e) { setInfo('Could not read the preset list: ' + e.message, 'err'); }
    sel.innerHTML = '';
    const none = h('option', null, list.length ? '- choose a preset -' : '(no presets yet)'); none.value = ''; sel.append(none);
    for (const p of list) { const o = h('option', null, p.name); o.value = p.name; sel.append(o); }
    sel.value = select && list.some((p) => p.name === select) ? select : '';
    return list;
  };
  const cleanName = () => nameIn.value.trim();

  bLoad.onclick = guard(async () => {
    if (!chosen()) return setInfo('Choose a preset first.', 'warn');
    ed.applyPreset(await store().get(chosen()));
    setInfo(`Loaded preset "${chosen()}".`, 'ok');
  });
  bSaveAs.onclick = guard(async () => {
    const n = cleanName();
    if (!n) return setInfo('Type a name for the new preset.', 'warn');
    const r = await store().put(n, ed.buildPreset(), false);
    if (r.exists) return setInfo(`"${n}" already exists - select it and press Overwrite, or choose another name.`, 'warn');
    await refresh(n); setInfo(`Saved preset "${n}".`, 'ok');
  });
  armed(bOver, 'Click again to overwrite', guard(async () => {
    if (!chosen()) return setInfo('Select the preset to overwrite.', 'warn');
    await store().put(chosen(), ed.buildPreset(), true); const n = chosen(); await refresh(n); setInfo(`Overwrote preset "${n}".`, 'ok');
  }));
  bRename.onclick = guard(async () => {
    const n = cleanName();
    if (!chosen() || !n) return setInfo('Select a preset and type the new name.', 'warn');
    const r = await store().rename(chosen(), n);
    if (r.exists) return setInfo(`"${n}" already exists.`, 'warn');
    await refresh(n); setInfo(`Renamed to "${n}".`, 'ok');
  });
  armed(bDel, 'Click again to delete', guard(async () => {
    if (!chosen()) return setInfo('Select the preset to delete.', 'warn');
    const n = chosen(); await store().del(n); await refresh(); setInfo(`Deleted preset "${n}".`, 'ok');
  }));
  armed(bDef, 'Click again to reset', guard(async () => { ed.resetSettings(); setInfo('Settings reset to defaults.', 'ok'); }));
  sel.addEventListener('change', () => { if (sel.value) nameIn.value = sel.value; });

  const cb = (label, key) => makeCheck(label, scope[key], (v) => { scope[key] = v; }).el;
  const bSave = makeButton('Save state now', "Write this node's whole state (settings, model, mask, layers, camera) to the server immediately and mark the workflow as changed");
  const bSaveWf = makeButton('Save state + workflow', 'Same, then save the workflow file (like Ctrl+S)');
  const bProjAs = makeButton('Save project as…', 'Choose a folder and save the whole project (model, layers, generated images, textures, masks, settings)');
  bProjAs.onclick = () => ed.openSaveAs && ed.openSaveAs();
  const stateInfo = h('div', 'tp-note', '');
  const doSave = (alsoWf) => async () => {
    try {
      stateInfo.textContent = 'Saving…';
      const r = await ed.saveStateNow(alsoWf);
      stateInfo.textContent = r.text; stateInfo.style.color = r.ok ? '#7bd88f' : '#ff8a80';
    } catch (e) { stateInfo.textContent = 'Save failed: ' + e.message; stateInfo.style.color = '#ff8a80'; ed.log('error', 'Save state failed', e); }
  };
  bSave.onclick = doSave(false); bSaveWf.onclick = doSave(true);

  ed.saveStateNow = async (alsoWorkflow) => {
    if (!ed.hooks.saveNow) { ed.setSaveState && ed.setSaveState('saved'); return { ok: true, text: 'Stored in this browser session (no ComfyUI connection).' }; }
    ed.setSaveState && ed.setSaveState('saving');
    const r = await ed.hooks.saveNow(!!alsoWorkflow);
    ed.setSaveState && ed.setSaveState(r.failed ? 'unsaved' : 'saved');
    const parts = [`${r.nodes} Texture Painter node${r.nodes === 1 ? '' : 's'} in this workflow saved`];
    if (r.failed) parts.push(`${r.failed} failed`);
    if (alsoWorkflow) parts.push(r.workflow === true ? 'workflow file saved' : 'the workflow file could not be saved automatically - press Ctrl+S');
    return { ok: !r.failed && (!alsoWorkflow || r.workflow === true), text: parts.join(', ') + '.' };
  };

  body.append(
    h('div', 'tp-lbl', 'Presets (shared by all workflows)'), sel, nameIn,
    row(bLoad, bSaveAs, bOver), row(bRename, bDel, bDef),
    cb('Also store the camera view', 'camera'), cb('Also store the model transform', 'xform'), cb('Also store the reference placement', 'place'),
    info,
    h('div', 'tp-lbl', 'State of this workflow'), row(bSave, bSaveWf), row(bProjAs), stateInfo,
    h('div', 'tp-note', 'A preset holds tool settings only (brush, capture, generation, blend weights, display ...), never the model, mask or layers. State: everything - model, mask, layers and settings - is already autosaved per node and restored after a tab switch or restart; "Save state now" forces it immediately. The settings also travel inside the workflow file; the model and masks live in ComfyUI\'s input/texpaint folder, so use Save project (.zip) to move a state to another machine. Other open workflows keep their own copy and are saved as you work in them.'),
  );
  ed.refreshPresets = refresh;
  refresh();
}
