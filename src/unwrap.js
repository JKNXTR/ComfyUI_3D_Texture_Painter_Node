// "Unwrap & Atlas" tab: re-unwraps the objects of the model (xatlas, on the ComfyUI machine), packs them into ONE atlas with equal texel
// density and transfers the baked / painted texture of every object into it. The result is previewed and can be imported as the new model.
import { h, makeButton, makeCheck } from './ui.js';
import { buildMerged } from './meshio.js';
import { makeZip, modelStem } from './export.js';

const COLORS = ['#ff6b6b', '#4dd0e1', '#ffd166', '#06d6a0', '#c792ea', '#ff9f68', '#7aa2ff', '#e6e66a'];
const safe = (n) => String(n || 'object').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'object';

/** reply of /texpaint/unwrap -> { stats, objects:[{name, positions, uvs, indices}], png: Blob } */
export function parseUnwrapReply(buf) {
  const dv = new DataView(buf), hl = dv.getUint32(0, true);
  const head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hl)));
  let off = 4 + hl; const objects = [];
  for (const o of head.objects) {
    const positions = new Float32Array(buf.slice(off, off + o.v * 12)); off += o.v * 12;
    const uvs = new Float32Array(buf.slice(off, off + o.v * 8)); off += o.v * 8;
    const indices = new Uint32Array(buf.slice(off, off + o.t * 12)); off += o.t * 12;
    objects.push({ name: o.name, positions, uvs, indices });
  }
  return { stats: head.stats, objects, png: new Blob([buf.slice(off, off + head.png)], { type: 'image/png' }) };
}

/** OBJ text: one 'o' group per object, shared atlas UVs (v up, like the editor) */
export function atlasToOBJ(objects, mtl) {
  const L = [mtl ? `mtllib ${mtl}` : '# Texture Painter AI atlas'];
  let vb = 0;
  for (const o of objects) {
    L.push('o ' + safe(o.name)); if (mtl) L.push('usemtl atlas');
    for (let i = 0; i < o.positions.length; i += 3) L.push(`v ${o.positions[i].toFixed(6)} ${o.positions[i + 1].toFixed(6)} ${o.positions[i + 2].toFixed(6)}`);
    for (let i = 0; i < o.uvs.length; i += 2) L.push(`vt ${o.uvs[i].toFixed(6)} ${o.uvs[i + 1].toFixed(6)}`);
    for (let i = 0; i < o.indices.length; i += 3) { const a = o.indices[i] + 1 + vb, b = o.indices[i + 1] + 1 + vb, c = o.indices[i + 2] + 1 + vb; L.push(`f ${a}/${a} ${b}/${b} ${c}/${c}`); }
    vb += o.positions.length / 3;
  }
  return L.join('\n') + '\n';
}

export function installUnwrap(ed) {
  const ui = ed.ui, side = ui.side;
  const S = { size: 2048, mode: 'unwrap', quality: 'balanced', padding: 8, source: 'own', sel: new Set(), res: null, busy: false, armed: false };

  // ---- tab strip + panel
  const tabs = h('div', 'tp-tabs'), tPaint = h('button', 'tp-tab tp-on', 'Paint'), tUw = h('button', 'tp-tab', 'Unwrap & Atlas');
  tabs.append(tPaint, tUw);
  const panel = h('div', 'tp-uwpanel');
  side.insertBefore(tabs, side.firstChild); side.append(panel);
  ed.setTab = (name) => {
    const uw = name === 'unwrap';
    side.classList.toggle('tp-tab-unwrap', uw); tPaint.classList.toggle('tp-on', !uw); tUw.classList.toggle('tp-on', uw);
    if (uw) refresh();
  };
  tPaint.onclick = () => ed.setTab('paint'); tUw.onclick = () => ed.setTab('unwrap');
  const st = document.createElement('style');
  st.textContent = `.tp-tabs{display:flex;position:sticky;top:0;z-index:5;background:var(--panel);border-bottom:1px solid var(--line)}
.tp-tab{flex:1;padding:7px 4px;background:none;border:0;border-bottom:2px solid transparent;color:#aab2c5;font-weight:600;cursor:pointer}
.tp-tab.tp-on{color:#fff;border-bottom-color:#4da3ff}
.tp-uwpanel{display:none;padding:6px 10px}.tp-side.tp-tab-unwrap>*:not(.tp-tabs):not(.tp-uwpanel){display:none!important}.tp-side.tp-tab-unwrap>.tp-uwpanel{display:block}
.tp-uwobj{display:flex;gap:6px;align-items:center;font-size:11px;padding:1px 0}.tp-uwobj span.tp-n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tp-uwprev{width:100%;aspect-ratio:1;background:#111;border:1px solid var(--line);cursor:zoom-in;display:block;margin:6px 0}
.tp-uwpanel select{width:100%}`;
  ed.root.append(st);

  // ---- content
  const info = h('div', 'tp-note');
  const list = h('div'), bAll = makeButton('All'), bNone = makeButton('None');
  const lr = h('div', 'tp-row2'); lr.style.cssText = 'display:flex;gap:6px;margin:4px 0'; lr.append(bAll, bNone);
  const sel = (opts, key, conv = (v) => v) => { const s = h('select'); for (const [v, t] of opts) { const o = h('option', null, t); o.value = String(v); s.append(o); } s.value = String(S[key]); s.onchange = () => { S[key] = conv(s.value); }; return s; };
  const row = (label, el) => { const r = h('div'); r.style.margin = '4px 0'; r.append(h('div', 'tp-lbl', label), el); return r; };
  const sizeSel = sel([[1024, '1024'], [2048, '2048'], [4096, '4096'], [8192, '8192']], 'size', Number);
  const modeSel = sel([['unwrap', 'New unwrap (xatlas charts, best packing)'], ['pack', 'Keep my UV islands, only pack them together']], 'mode');
  const qualSel = sel([['fast', 'Fast'], ['balanced', 'Balanced'], ['best', 'Best (slow, tighter packing)']], 'quality');
  const srcSel = sel([['own', 'Each object\'s own texture (per-object painting)'], ['whole', '"Entire model" texture (one shared atlas)']], 'source');
  const padSel = sel([[2, '2 px'], [4, '4 px'], [8, '8 px'], [16, '16 px'], [32, '32 px']], 'padding', Number);
  const bRun = makeButton('Unwrap & build atlas', 'Unwrap the ticked objects, pack them into one atlas and transfer their textures');
  const prog = h('div', 'tp-note');
  const prev = h('canvas', 'tp-uwprev'); prev.width = prev.height = 360; prev.style.display = 'none';
  const showUV = makeCheck('Show UV islands', true, () => draw());
  const stats = h('div', 'tp-note'); stats.style.whiteSpace = 'pre-line';
  const bImp = makeButton('Import as the model (replaces the current one)'), bZip = makeButton('Download OBJ + atlas (zip)'), bDis = makeButton('Discard');
  const ar = h('div', 'tp-row2'); ar.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin:4px 0'; ar.append(bImp, bZip, bDis);
  panel.append(h('div', 'tp-lbl', 'Objects to unwrap'), list, lr, info,
    row('Method', modeSel), row('Atlas size', sizeSel), row('Packing quality', qualSel), row('Padding between islands', padSel), row('Texture source', srcSel), bRun, prog,
    prev, showUV.el, stats, ar,
    h('div', 'tp-note', 'All ticked objects share one square atlas with the same texel density per world unit. The textures you painted / baked on every object are re-projected into the new layout (the triangles stay the same, only their UV position changes). The result is only a preview until you import it; "Download" keeps a copy. Unwrapping runs on the ComfyUI machine (python package xatlas; it is installed automatically, otherwise run  python -m pip install xatlas ). Skinning / animation is not kept.'));
  bAll.onclick = () => { for (const l of leaves()) S.sel.add(l.id); renderList(); }; bNone.onclick = () => { S.sel.clear(); renderList(); };

  const leaves = () => (ed.objTree ? ed.objTree.rows.filter((n) => n.own) : []);
  function renderList() {
    list.innerHTML = '';
    const L = leaves();
    if (!L.length) { list.append(h('div', 'tp-note', 'Load a model first.')); bRun.disabled = true; return; }
    for (const nd of L) {
      const c = makeCheck((nd.name || 'Mesh') + '  (' + (nd.tris >= 1000 ? Math.round(nd.tris / 100) / 10 + 'k' : nd.tris) + ' tris)', S.sel.has(nd.id), (v) => { if (v) S.sel.add(nd.id); else S.sel.delete(nd.id); upd(); });
      list.append(c.el);
    }
    upd();
  }
  function upd() { bRun.disabled = S.busy || !S.sel.size; info.textContent = S.sel.size ? `${S.sel.size} object${S.sel.size === 1 ? '' : 's'} selected.` : 'Tick at least one object.'; }
  function refresh() {
    const L = leaves(); const known = new Set(L.map((x) => x.id));
    for (const id of [...S.sel]) if (!known.has(id)) S.sel.delete(id);
    if (!S.sel.size) for (const l of L) S.sel.add(l.id);
    S.source = (L.length < 2 || (ed.state.model && ed.state.model.object === '')) ? 'whole' : 'own'; srcSel.value = S.source;
    renderList(); showResult();
  }
  const prevObjs = ed._objectsChanged; ed._objectsChanged = () => { if (prevObjs) prevObjs(); S.sel.clear(); if (side.classList.contains('tp-tab-unwrap')) refresh(); };

  // ---- gather the input of the selected objects
  async function gather() {
    const t = ed.objTree, cur = (ed.state.model && ed.state.model.object) || '';
    const meshOf = (id) => [...t.meshId].find(([, i]) => i === id)[0];
    const ids = leaves().filter((n) => S.sel.has(n.id)).map((n) => n.id);
    const objects = [], texBlobs = [], warn = [];
    const whole = S.source === 'whole' || leaves().length < 2;
    let wholeIdx = -1;
    try {
      if (whole) { if (cur !== '') await ed.selectObject(''); texBlobs.push(await ed.exportTextureBlob(0)); wholeIdx = 0; }
      for (const id of ids) {
        const nd = t.byId.get(id), r = buildMerged(ed._root, ed._kind, (o) => o === meshOf(id));
        const n = r.info.norm || { center: [0, 0, 0], scale: 1 }, g = r.geometry, pa = g.attributes.position.array, V = pa.length / 3;
        const pos = new Float32Array(V * 3), k = n.scale ? 1 / n.scale : 1;
        for (let i = 0; i < V; i++) { pos[i * 3] = pa[i * 3] * k + n.center[0]; pos[i * 3 + 1] = pa[i * 3 + 1] * k + n.center[1]; pos[i * 3 + 2] = pa[i * 3 + 2] * k + n.center[2]; }
        const hasUV = !!r.info.hasUV;
        let tex = -1;
        if (hasUV) {
          if (whole) tex = wholeIdx;
          else { await ed.selectObject(id); texBlobs.push(await ed.exportTextureBlob(0)); tex = texBlobs.length - 1; }
        } else warn.push(`"${nd.name}" has no UV coordinates - it gets the fill colour.`);
        objects.push({ name: nd.name || 'Mesh', pos, idx: new Uint32Array(g.index.array), uv: hasUV ? new Float32Array(g.attributes.uv.array) : null, tex });
      }
    } finally { if (((ed.state.model && ed.state.model.object) || '') !== cur) await ed.selectObject(cur); }
    return { objects, texBlobs, warn };
  }

  async function run() {
    if (S.busy || !S.sel.size) return;
    if (!ed.hooks.unwrapApi) { ed.setStatus('Unwrapping needs the ComfyUI server part (not available here).', 'warn'); return; }
    S.busy = true; S.armed = false; upd(); prog.textContent = 'Collecting objects and textures...';
    try {
      const g = await gather();
      const fd = new FormData();
      fd.append('meta', JSON.stringify({ objects: g.objects.map((o) => ({ name: o.name, tex: o.tex })), options: { size: S.size, mode: S.mode, quality: S.quality, padding: S.padding } }));
      g.objects.forEach((o, i) => { fd.append('pos' + i, new Blob([o.pos]), 'p.bin'); fd.append('idx' + i, new Blob([o.idx]), 'i.bin'); if (o.uv) fd.append('uv' + i, new Blob([o.uv]), 'u.bin'); });
      g.texBlobs.forEach((b, i) => fd.append('tex' + i, b, 't.png'));
      prog.textContent = `Unwrapping ${g.objects.length} object${g.objects.length === 1 ? '' : 's'} (${g.objects.reduce((a, o) => a + o.idx.length / 3, 0).toLocaleString()} triangles) - this can take a while for large models...`;
      const buf = await ed.hooks.unwrapApi(fd);
      S.res = parseUnwrapReply(buf); S.res.bitmap = await createImageBitmap(S.res.png); S.res.warn = g.warn;
      prog.textContent = ''; showResult(); ed.log('ok', `Atlas ${S.res.stats.size}x${S.res.stats.size}: ${S.res.stats.charts} charts, ${(S.res.stats.covered * 100).toFixed(0)}% of the atlas used.`);
    } catch (e) { prog.textContent = ''; ed.log('error', 'Unwrap failed', e); ed.setStatus('Unwrap failed: ' + e.message, 'err'); info.textContent = 'Unwrap failed: ' + e.message; }
    finally { S.busy = false; upd(); }
  }
  bRun.onclick = run;

  // ---- result preview
  function paint(cv, size) {
    const R = S.res; cv.width = cv.height = size; const g = cv.getContext('2d');
    g.drawImage(R.bitmap, 0, 0, size, size);
    if (!showUV.get || showUV.get()) {
      let tris = 0; for (const o of R.objects) tris += o.indices.length / 3;
      if (tris <= 250000) R.objects.forEach((o, k) => {
        g.strokeStyle = COLORS[k % COLORS.length]; g.globalAlpha = 0.8; g.lineWidth = 1; g.beginPath();
        for (let i = 0; i < o.indices.length; i += 3) for (let e = 0; e < 3; e++) { const a = o.indices[i + e], b = o.indices[i + (e + 1) % 3]; g.moveTo(o.uvs[a * 2] * size, (1 - o.uvs[a * 2 + 1]) * size); g.lineTo(o.uvs[b * 2] * size, (1 - o.uvs[b * 2 + 1]) * size); }
        g.stroke();
      });
      g.globalAlpha = 1;
    }
  }
  const draw = () => { if (S.res) paint(prev, 360); };
  prev.onclick = () => {
    if (!S.res || ed.root.querySelector('.tp-modal')) return;
    const m = h('div', 'tp-modal'), d = h('div', 'tp-dlg'), cv = h('canvas'); const sz = Math.min(900, Math.floor(Math.min(innerWidth, innerHeight) * 0.85));
    d.style.maxWidth = 'none'; d.append(cv, makeButton('Close')); d.lastChild.onclick = () => m.remove(); m.append(d); m.onclick = (e) => { if (e.target === m) m.remove(); }; ed.root.append(m); paint(cv, sz);
  };
  function showResult() {
    const R = S.res; const on = !!R;
    prev.style.display = on ? 'block' : 'none'; showUV.el.style.display = on ? '' : 'none'; ar.style.display = on ? 'flex' : 'none'; stats.style.display = on ? '' : 'none';
    bImp.textContent = 'Import as the model (replaces the current one)';
    if (!on) return;
    const s = R.stats, d = s.density.filter((x) => x > 0), ratio = d.length ? Math.min(...d) / Math.max(...d) : 1;
    stats.textContent = `Atlas ${s.size}x${s.size}: ${s.charts} charts, ${(s.covered * 100).toFixed(0)}% of the area used, ${s.triangles.toLocaleString()} triangles.\n` +
      `Texel density ${d.length ? Math.round(Math.min(...d)) + ' - ' + Math.round(Math.max(...d)) : '-'} texels per unit (equal = ${(ratio * 100).toFixed(0)}%).` +
      (s.overlap > 0.001 ? `\nWarning: ${(s.overlap * 100).toFixed(1)}% of the texels are covered by overlapping islands.` : '') + (R.warn && R.warn.length ? '\n' + R.warn.join('\n') : '');
    draw();
  }

  // ---- result actions
  ed.importUnwrapResult = async () => {
    const R = S.res; if (!R) return false;
    const stem = safe(modelStem(ed)) + '_atlas';
    await ed.loadModelBuffer(new TextEncoder().encode(atlasToOBJ(R.objects)).buffer, stem + '.obj');
    ed.setTextureFromImage(R.bitmap, { label: 'atlas', keepHistory: false });
    ed.log('ok', `Imported "${stem}.obj" with the ${R.stats.size}x${R.stats.size} atlas texture.`); ed.setTab('paint');
    return true;
  };
  bImp.onclick = async () => {
    if (!S.armed) { S.armed = true; bImp.textContent = 'Click again: replace the current model'; setTimeout(() => { if (S.armed) { S.armed = false; bImp.textContent = 'Import as the model (replaces the current one)'; } }, 5000); return; }
    S.armed = false; try { await ed.importUnwrapResult(); } catch (e) { ed.log('error', 'Import failed', e); ed.setStatus('Import failed: ' + e.message, 'err'); }
  };
  ed.unwrapZip = async () => {
    const R = S.res; if (!R) return null; const stem = safe(modelStem(ed)) + '_atlas', enc = new TextEncoder();
    return makeZip([{ name: stem + '.obj', data: enc.encode(atlasToOBJ(R.objects, stem + '.mtl')) },
      { name: stem + '.mtl', data: enc.encode(`newmtl atlas\nKd 1 1 1\nmap_Kd ${stem}.png\n`) }, { name: stem + '.png', data: new Uint8Array(await R.png.arrayBuffer()) }]);
  };
  bZip.onclick = async () => { const z = await ed.unwrapZip(); if (!z) return; const a = document.createElement('a'); a.href = URL.createObjectURL(z); a.download = safe(modelStem(ed)) + '_atlas.zip'; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); };
  bDis.onclick = () => { S.res = null; showResult(); };
  ed._unwrapState = S;
  showResult(); renderList();
}
