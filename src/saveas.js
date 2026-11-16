// "Save project as..." window: choose WHERE the whole project goes (a folder on the ComfyUI machine, a folder of this browser, or a plain download)
// and WHAT is written next to the ZIP (loose files: model, every layer PNG, masks, settings, flattened texture).
import { h, makeButton, makeCheck } from './ui.js';
import { saveProject, readStoredZip } from './project.js';
import { bakeUVMap } from './export.js';

const LS = 'texpaint.saveas.v1';
const lsGet = () => { try { return JSON.parse(localStorage.getItem(LS) || '{}') || {}; } catch (_) { return {}; } };
const lsSet = (o) => { try { localStorage.setItem(LS, JSON.stringify(o)); } catch (_) { /* optional */ } };
const safeName = (n) => String(n || '').replace(/[^\w .\-()+]/g, '_').replace(/^[^\w]+/, '').slice(0, 80);

function downloadBlob(blob, name) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** writes every entry of a stored zip below a directory handle (browser folder) */
async function writeLoose(dirHandle, entries) {
  let n = 0;
  for (const [path, data] of entries) {
    const parts = path.split('/').filter(Boolean);
    if (!parts.length || parts.some((p) => p === '..' || p === '.')) continue;
    let d = dirHandle;
    for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create: true });
    const fh = await d.getFileHandle(parts[parts.length - 1], { create: true });
    const w = await fh.createWritable(); await w.write(data); await w.close(); n++;
  }
  return n;
}

export function installSaveAs(ed) {
  const api = () => ed.hooks.projectApi;
  const hasPicker = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';

  ed.openSaveAs = () => {
    if (!ed.hasModel) { ed.setStatus('Load a model first.', 'warn'); return null; }
    if (ed.root.querySelector('.tp-modal')) return null;
    const pref = lsGet();
    const stem = safeName((ed._modelBytes && ed._modelBytes.name || 'model').replace(/\.[^.]+$/, '')) || 'model';
    const S = { dest: pref.dest || (api() ? 'server' : hasPicker ? 'folder' : 'download'), dir: pref.dir || '', dirHandle: null, busy: false };
    if (S.dest === 'server' && !api()) S.dest = hasPicker ? 'folder' : 'download';
    if (S.dest === 'folder' && !hasPicker) S.dest = 'download';

    const modal = h('div', 'tp-modal'), dlg = h('div', 'tp-dlg'); modal.append(dlg);
    modal.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    modal.tabIndex = -1;
    dlg.addEventListener('pointerdown', (e) => e.stopPropagation());
    modal.addEventListener('pointerdown', (e) => { if (e.target === modal) close(); });
    const close = () => { if (!S.busy) modal.remove(); };

    const nameIn = h('input'); nameIn.type = 'text'; nameIn.maxLength = 80; nameIn.value = pref.name ? safeName(pref.name) : `${stem}_project`;
    const mkRadio = (val, label, on) => {
      const l = h('label', 'tp-chk'), r = h('input'); r.type = 'radio'; r.name = 'tp-dest'; r.checked = S.dest === val; r.disabled = !on;
      r.onchange = () => { S.dest = val; paint(); }; l.append(r, h('span', null, label)); return l;
    };
    const destRow = h('div'); destRow.append(
      mkRadio('server', 'Folder on the ComfyUI computer', !!api()),
      mkRadio('folder', hasPicker ? 'Folder on this computer (browser asks for access)' : 'Folder on this computer (not supported by this browser / needs https or localhost)', hasPicker),
      mkRadio('download', 'Download the ZIP (browser downloads folder)', true));

    // --- server folder browser
    const serverBox = h('div');
    const pathIn = h('input'); pathIn.type = 'text'; pathIn.placeholder = 'Folder path on the ComfyUI computer'; pathIn.value = S.dir;
    const list = h('div', 'tp-dirs'), note = h('div', 'tp-note', '');
    const bGo = makeButton('Go'), bUp = makeButton('Up'), bDef = makeButton('Default'), bNew = makeButton('New folder…');
    const newIn = h('input'); newIn.type = 'text'; newIn.placeholder = 'New folder name, then press Enter'; newIn.style.display = 'none';
    const browse = async (path) => {
      try {
        const r = await api().dirs(path); S.dir = r.path; pathIn.value = r.path; S.parent = r.parent; S.def = r.default;
        list.innerHTML = '';
        if (!r.dirs.length) list.append(h('div', null, '(no sub folders)'));
        for (const d of r.dirs) { const row = h('div', null, '📁 ' + d); row.onclick = () => browse(r.path.replace(/[\\/]+$/, '') + (r.path.includes('\\') ? '\\' : '/') + d); list.append(row); }
        note.textContent = r.unrestricted ? 'Any folder on the ComfyUI computer can be used.' : 'Remote access: only folders inside ComfyUI\'s output folder are allowed.'; note.style.color = '';
      } catch (e) { note.textContent = e.message; note.style.color = '#ff8a80'; }
    };
    bGo.onclick = () => browse(pathIn.value); bUp.onclick = () => browse(S.parent || pathIn.value); bDef.onclick = () => browse('');
    pathIn.onkeydown = (e) => { if (e.key === 'Enter') browse(pathIn.value); };
    bNew.onclick = () => { newIn.style.display = ''; newIn.focus(); };
    newIn.onkeydown = async (e) => {
      if (e.key !== 'Enter') return;
      try { const r = await api().mkdir(pathIn.value || S.dir, newIn.value.trim()); newIn.value = ''; newIn.style.display = 'none'; await browse(r.path); } catch (er) { note.textContent = er.message; note.style.color = '#ff8a80'; }
    };
    const br = h('div'); br.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:4px 0'; br.append(bGo, bUp, bDef, bNew);
    serverBox.append(h('div', 'tp-lbl', 'Save into this folder'), pathIn, br, newIn, list, note);

    // --- browser folder
    const folderBox = h('div'), folderInfo = h('div', 'tp-note', 'No folder chosen yet.');
    const bPick = makeButton('Choose folder…', 'Opens the browser\'s folder picker');
    bPick.onclick = async () => {
      try { S.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' }); folderInfo.textContent = 'Folder: ' + S.dirHandle.name; folderInfo.style.color = '#7bd88f'; }
      catch (e) { if (e.name !== 'AbortError') { folderInfo.textContent = e.message; folderInfo.style.color = '#ff8a80'; } }
    };
    folderBox.append(bPick, folderInfo);

    const cLoose = makeCheck('Also write loose files in a sub folder (model, every layer PNG, masks, reference images, project.json)', pref.loose !== false, () => {});
    const cFlat = makeCheck('Include the flattened UV texture (texture_flattened.png)', pref.flat !== false, () => {});
    const status = h('div', 'tp-note', '');
    const bSave = makeButton('Save', 'Write the project', 'tp-pri'), bCancel = makeButton('Cancel');
    bCancel.onclick = close;
    const acts = h('div', 'tp-actions'); acts.append(bCancel, bSave);
    const paint = () => { serverBox.style.display = S.dest === 'server' ? '' : 'none'; folderBox.style.display = S.dest === 'folder' ? '' : 'none'; cLoose.el.style.display = S.dest === 'download' ? 'none' : ''; };

    const setStatus = (t, kind) => { status.textContent = t; status.style.color = kind === 'err' ? '#ff8a80' : kind === 'ok' ? '#7bd88f' : ''; };
    bSave.onclick = async () => {
      if (S.busy) return;
      const name = safeName(nameIn.value);
      if (!name) return setStatus('Type a project name.', 'err');
      if (S.dest === 'folder' && !S.dirHandle) return setStatus('Choose a folder first.', 'err');
      S.busy = true; bSave.disabled = bCancel.disabled = true;
      try {
        setStatus('Collecting model, layers, masks and settings …');
        const extra = [];
        if (cFlat.get()) {
          const t = await bakeUVMap(ed, ed.state.layers.padding);
          extra.push({ name: 'texture_flattened.png', data: new Uint8Array(await t.blob.arrayBuffer()) });
        }
        const pj = await saveProject(ed, { extra });
        const mb = (pj.blob.size / 1048576).toFixed(1);
        let where = '';
        if (S.dest === 'server') {
          setStatus(`Uploading ${mb} MB to the ComfyUI computer …`);
          const r = await api().save(pj.blob, name, pathIn.value.trim() || S.dir, cLoose.get());
          where = r.path + (r.loose_dir ? ` (+ loose files in ${r.loose_dir})` : '');
        } else if (S.dest === 'folder') {
          setStatus(`Writing ${mb} MB …`);
          const fh = await S.dirHandle.getFileHandle(name + '.zip', { create: true });
          const w = await fh.createWritable(); await w.write(pj.blob); await w.close();
          let n = 0;
          if (cLoose.get()) n = await writeLoose(await S.dirHandle.getDirectoryHandle(name, { create: true }), readStoredZip(await pj.blob.arrayBuffer()));
          where = `${S.dirHandle.name}/${name}.zip` + (n ? ` (+ ${n} loose files in ${name}/)` : '');
        } else {
          downloadBlob(pj.blob, name + '.zip'); where = `${name}.zip (browser download)`;
        }
        lsSet({ dest: S.dest, dir: S.dest === 'server' ? (pathIn.value.trim() || S.dir) : pref.dir, name, loose: cLoose.get(), flat: cFlat.get() });
        ed.log('ok', `Project saved: ${where} - ${mb} MB.`); ed.setStatus('Project saved: ' + where, 'ok');
        setStatus('Saved: ' + where, 'ok');
        S.busy = false; bSave.disabled = bCancel.disabled = false; bCancel.textContent = 'Close';
        S.done = true;
      } catch (e) {
        S.busy = false; bSave.disabled = bCancel.disabled = false;
        setStatus('Save failed: ' + e.message, 'err'); ed.log('error', 'Save project as failed', e);
      }
    };

    dlg.append(h('h3', null, 'Save project as'),
      h('div', 'tp-lbl', 'Project name'), nameIn,
      h('div', 'tp-lbl', 'Where'), destRow, serverBox, folderBox,
      h('div', 'tp-lbl', 'What'), cLoose.el, cFlat.el,
      h('div', 'tp-note', 'The project ZIP always contains everything: the 3D model, all layers (including generated AI images) with their masks, the AI selection and transition masks, reference images 2-5 and all settings. Re-open it with "Open project…".'),
      status, acts);
    paint();
    ed.root.append(modal);
    if (S.dest === 'server' && api()) browse(S.dir);
    nameIn.focus(); nameIn.select();
    return { close, state: S, modal, browse };
  };
}
