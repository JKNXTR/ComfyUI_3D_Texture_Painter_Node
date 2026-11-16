// Project backup: one ZIP holding the model, every layer (+ layer masks), the AI mask, reference image 2 and all settings.
import { makeZip } from './export.js';

const u8 = async (blob) => new Uint8Array(await blob.arrayBuffer());

export async function saveProject(ed, opts = {}) {
  if (!ed.hasModel || !ed._modelBytes) throw new Error('Load a model first.');
  const files = [];
  const state = ed.getState();
  files.push({ name: 'project.json', data: new TextEncoder().encode(JSON.stringify({ format: 'texpaint-project', version: 1, model: ed._modelBytes.name, state }, null, 1)) });
  files.push({ name: 'model/' + ed._modelBytes.name, data: new Uint8Array(ed._modelBytes.buffer) });
  for (const f of ed.layers.files()) files.push({ name: 'layers/' + f.name, data: await u8(await ed.layers.toBlob(f.rt, f.grey)) });
  if (ed.pbrReady) { await ed.pbrReady(); for (const f of ed.pbrFiles()) files.push({ name: 'pbr/' + f.name, data: await u8(f.blob) }); }
  files.push({ name: 'mask.png', data: await u8(await ed.exportMaskBlob()) });
  files.push({ name: 'transition.png', data: await u8(await ed.exportTransBlob()) });
  files.push({ name: 'heal.png', data: await u8(await ed.exportHealBlob()) });
  if (ed.exportViewBlob) for (let i = 0; i < 4; i++) if (ed.viewHas[i]) files.push({ name: `region${i + 1}.png`, data: await u8(await ed.exportViewBlob(i)) });
  for (let i = 0; i < 4; i++) if (ed.refxBlobs[i]) files.push({ name: `ref${i + 3}.png`, data: await u8(ed.refxBlobs[i]) });
  if (ed.ref2Blob) files.push({ name: 'ref2.png', data: await u8(ed.ref2Blob) });
  for (const f of opts.extra || []) files.push(f);
  const stem = (ed._modelBytes.name || 'model').replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 50);
  return { blob: makeZip(files), name: `${stem}_project.zip` };
}

/** Reads a ZIP written by makeZip (stored entries only). */
export function readStoredZip(buf) {
  const dv = new DataView(buf), out = new Map(), dec = new TextDecoder();
  let p = 0;
  while (p + 30 <= buf.byteLength && dv.getUint32(p, true) === 0x04034b50) {
    const method = dv.getUint16(p + 8, true), size = dv.getUint32(p + 22, true), nl = dv.getUint16(p + 26, true), xl = dv.getUint16(p + 28, true);
    if (method !== 0) throw new Error('This ZIP is compressed. Only project files saved by Texture Painter AI can be opened.');
    const name = dec.decode(new Uint8Array(buf, p + 30, nl));
    out.set(name, new Uint8Array(buf, p + 30 + nl + xl, size));
    p += 30 + nl + xl + size;
  }
  if (!out.size) throw new Error('Not a Texture Painter project (no entries found).');
  return out;
}

export async function loadProject(ed, file) {
  const entries = readStoredZip(await file.arrayBuffer());
  const pj = entries.get('project.json');
  if (!pj) throw new Error('project.json is missing - this is not a Texture Painter project.');
  const proj = JSON.parse(new TextDecoder().decode(pj));
  if (proj.format !== 'texpaint-project') throw new Error('Unknown project format.');
  const mname = proj.model, mdata = entries.get('model/' + mname);
  if (!mdata) throw new Error('The model file is missing inside the project.');
  const img = async (n) => { const d = entries.get(n); return d ? createImageBitmap(new Blob([d], { type: 'image/png' })) : null; };
  const buf = mdata.slice().buffer;
  let name = mname;
  if (ed.hooks.onModelPicked) name = (await ed.hooks.onModelPicked(new File([buf], mname))) || mname; // stores it on the server so autosave/restore work
  const st = proj.state || {};
  ed.applyState({ ...st, camera: null, layerStack: undefined });
  await ed.loadModelBuffer(buf, name, { keepTexture: true });
  Object.assign(ed.state.model, { name, ext: mname.split('.').pop().toLowerCase() });
  if (st.layerStack) await ed.restoreLayers(st.layerStack, (fn) => img('layers/' + fn));
  if (ed.pbrLoadFrom) await ed.pbrLoadFrom(st.pbrMaps, (fn) => img('pbr/' + fn));
  const rb = entries.get('ref2.png');
  if (rb) await ed.loadRef2Blob(new Blob([rb], { type: 'image/png' }));
  for (let i = 0; i < 4; i++) { const rx = entries.get(`ref${i + 3}.png`); if (rx) await ed.loadRefxBlob(i, new Blob([rx], { type: 'image/png' })); }
  const mk = await img('mask.png');
  if (mk) ed.importMaskBitmap(mk, { undo: false });
  if (ed.importViewBitmap) for (let i = 0; i < 4; i++) { const vb = await img(`region${i + 1}.png`); if (vb) ed.importViewBitmap(i, vb, { undo: false }); }
  const tk = await img('transition.png');
  if (tk) ed.importTransBitmap(tk, { undo: false });
  const hk = await img('heal.png');
  if (hk) ed.importHealBitmap(hk, { undo: false });
  ed.applyState({ ...st, layerStack: undefined });
  ed._applyStateToUI();
  ed._dirty('model'); ed._dirty('texture'); ed._dirty('mask');
  return proj;
}
