// Host layer shared by the ComfyUI node and the standalone editor: server IO of the session (upload, autosave, capture/commit, restore) and the
// server-backed editor hooks (presets, projects, unwrap, storage ...). Both hosts get EXACTLY the same behaviour from this one module.
// io = { fetchApi(path, opts), serverApi, getUI(rec), setUI(rec, ui), afterCommit(rec), keepSessions() -> [sid], log }
export function createHostSession(io) {
  const api = { fetchApi: (p, o) => io.fetchApi(p, o) };
  const SERVER_API = io.serverApi;
  const LAST_KEY = "texpaint_last_session";
  const tlog = (...a) => console.log("[TexturePainterAI]", ...a);
  const terr = (...a) => console.error("[TexturePainterAI]", ...a);

async function routeErr(r, what) {
  const j = await r.json().catch(() => ({}));
  if (r.status === 404 || r.status === 405) {
    let run = "";
    try { const pj = await (await api.fetchApi("/texpaint/ping")).json(); run = ` Running copy: API ${pj.api ?? "?"} (this page needs ${SERVER_API}), loaded from ${pj.code || "an older version that does not report its folder"}.`; } catch (_) { run = " The Texture Painter server part does not answer at all."; }
    return `HTTP ${r.status} ${what || r.url || ""}: this ComfyUI does not know the Texture Painter route of this version. Close ComfyUI completely, start it again, then reload the page (Ctrl+F5).${run} `
      + "If it persists, make sure only one copy of the node is in custom_nodes and press 'Copy diagnostics'.";
  }
  return j.error || "HTTP " + r.status;
}
async function postJSON(path, body) { return api.fetchApi(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
let serverCheckP = null;
function checkServer() {
  if (!serverCheckP) {
    serverCheckP = api.fetchApi("/texpaint/ping").then(async (r) => {
      if (!r.ok) return `The Texture Painter server routes are not loaded (HTTP ${r.status}). Restart ComfyUI.`;
      const j = await r.json().catch(() => ({}));
      window.TexturePainterAI && (window.TexturePainterAI.serverApi = j.api || 0);
      return (j.api || 0) < SERVER_API ? `ComfyUI is running an OLDER Python part of this node (server api ${j.api || "1"}, UI needs ${SERVER_API}). Close ComfyUI completely and start it again, then reload the page (Ctrl+F5).` : "";
    }).catch(() => "");
  }
  return serverCheckP;
}
function fnv(str, seed) {
  let h = seed >>> 0;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, "0");
}
async function apiJSON(path, opts) {
  const r = await api.fetchApi(path, opts);
  let j = null;
  try { j = await r.json(); } catch (_) { /* not json */ }
  if (!r.ok) throw new Error(`HTTP ${r.status} from ${path}: ${(j && j.error) || r.statusText}`);
  return j;
}
// ------------------------------------------------------------------------------------------
// server IO
// ------------------------------------------------------------------------------------------
async function uploadModel(rec, file) {
  const fd = new FormData();
  fd.append("file", file, file.name);
  rec.ed.setStatus(`Uploading ${file.name} (${(file.size / 1048576).toFixed(1)} MB) ...`);
  const j = await apiJSON("/texpaint/upload_model", { method: "POST", body: fd });
  rec.ed.log("ok", `Model stored on the server as ${j.name}`);
  return j.name;
}
function layersPayload(ed) {
  const o = ed.objectStates ? ed.objectStates() : {};
  const base = { ...ed.layers.serialize() }, pm = ed.state.pbrMaps;
  if (pm && Object.values(pm).some(Boolean)) base.pbr = { ...pm };
  return JSON.stringify(Object.keys(o).length ? { ...base, others: o } : base);
}
// autosaves run one after the other: two overlapping uploads could finish out of order and leave an OLDER mask / layers on the server
function autosave(rec) {
  rec.saveChain = (rec.saveChain || Promise.resolve()).catch(() => {}).then(() => autosaveNow(rec));
  return rec.saveChain;
}
async function autosaveNow(rec) {
  const ed = rec.ed;
  if (!ed.hasModel || rec.restoring || rec.mirror) return;   // a mirror never writes: the master owns the session
  const mv = ed.maskVersion, tv = ed.transVersion, hv = ed.healVersion, vv = ed.viewVersion;   // versions of what is exported below: a stroke during the awaits must stay 'unsaved'
  const fd = new FormData();
  let any = false;
  const sent = [];
  if (ed.pbrReady) await ed.pbrReady();
  const lkey = layersPayload(ed);
  const names = ed.layers.files();
  const others = [...(ed.objectFiles ? ed.objectFiles() : []), ...(ed.pbrFiles ? ed.pbrFiles() : [])]; // texture layers + masks of the other objects of a multi-object model
  if (rec.savedLayersKey !== lkey) {
    for (const f of names) {
      if (rec.savedFiles.has(f.name)) continue;
      fd.append(f.name, await ed.layers.toBlob(f.rt, f.grey), f.name);
      sent.push(f.name);
    }
    for (const f of others) {
      if (rec.savedFiles.has(f.name) || !f.blob) continue;
      fd.append(f.name, f.blob, f.name);
      sent.push(f.name);
    }
    fd.append("layers", lkey); // the server drops layer files that are no longer referenced
    any = true;
  }
  if (rec.savedMaskVersion !== mv) { fd.append("uvmask", await ed.exportMaskBlob(), "mask.png"); any = true; }
  if (rec.savedHealVersion !== hv && ed.exportHealBlob) { fd.append("uvheal", await ed.exportHealBlob(), "heal.png"); any = true; }
  if (rec.savedTransVersion !== tv) { fd.append("uvtrans", await ed.exportTransBlob(), "trans.png"); any = true; }
  if (ed.exportViewBlob && rec.savedViews !== vv) { for (let i = 0; i < 4; i++) fd.append("uvregion" + (i + 1), await ed.exportViewBlob(i), `region${i + 1}.png`); any = true; }
  const rv = ed.ref2Version, xv = ed.refxVersion;
  if (rec.savedRef2 !== rv && ed.ref2Blob) { fd.append("ref2", ed.ref2Blob, "ref2.png"); any = true; }
  if (rec.savedRefx !== xv) { ed.refxBlobs.forEach((b, i) => { if (b) fd.append("ref" + (i + 3), b, `ref${i + 3}.png`); }); any = true; }
  if (rec.pendingState && rec.pendingState !== rec.savedState) { fd.append("state", rec.pendingState); any = true; }
  if (!any) return;
  const stSent = rec.pendingState;
  ed.setSaveState && ed.setSaveState("saving");
  try {
    await apiJSON(`/texpaint/put/${rec.sid}`, { method: "POST", body: fd });
    rec.savedLayersKey = lkey;
    rec.savedFiles = new Set([...names, ...others].map((f) => f.name)); // exactly what the server now holds
    rec.savedMaskVersion = mv;
    rec.savedTransVersion = tv; rec.savedHealVersion = hv; rec.savedViews = vv;
    rec.savedRef2 = rv; rec.savedRefx = xv;
    if (stSent) rec.savedState = stSent;
    ed.setSaveState && ed.setSaveState("saved");
    try { localStorage.setItem(LAST_KEY, rec.sid); } catch (_) { /* private mode */ }
  } catch (e) {
    ed.setSaveState && ed.setSaveState("unsaved");
    ed.log("warn", "Autosave of the session failed (the workflow will still capture on Queue)", e);
  }
}
function scheduleAutosave(rec) {
  clearTimeout(rec.saveTimer);
  if (rec.mirror) return;
  if (rec.ed && rec.ed.setSaveState && !rec.restoring) rec.ed.setSaveState("unsaved");
  rec.saveTimer = setTimeout(() => autosave(rec).catch((e) => terr("autosave", e)), rec.saveDelay || 2500);
}
async function commitOne(rec, force = false) {
  const ed = rec.ed;
  if (ed.failed) throw new Error("Texture Painter: WebGL2 is not available in this browser.");
  if (rec.mirror) { if (rec.remoteCommit) await rec.remoteCommit(force); return true; }   // the master captures: a mirror's pane has a different shape, so its capture would frame the model differently
  if (!ed.hasModel) return false; // the Python node reports a clear error
  if (rec.restoring) await rec.restoring;
  if (rec.saveChain) await rec.saveChain.catch(() => {});   // never overlap an autosave upload
  const cam = [ed.camera.position.toArray(), ed.controls.target.toArray(), ed.camera.fov, ed.camera.zoom, ed.isOrtho, ed.orthoHalf, ed.ui.pane3d.offsetWidth, ed.ui.pane3d.offsetHeight];
  const key = JSON.stringify([ed.viewVersion, ed.meshHash, ed.textureVersion, ed.maskVersion, cam, ed.state.capture, ed._tileRun || 0, ed.state.layers, { ...ed.state.ref2, bg: 0, bgOpacity: 0 }, ed.ref2Version, ed.refxVersion, ed.state.refx, ed.state.plan.seam, ed.state.gen, ed.state.blend, ed.transVersion, ed.healVersion, ed.state.heal]);
  if (!force && rec.lastKey === key) return true;
  const t0 = performance.now();
  ed.setStatus("Capturing view ...");
  const includeMesh = force || rec.sentMesh !== ed.meshHash;
  const includeTexture = force || rec.sentTex !== ed.textureVersion;
  const out = await ed.capture({ includeMesh, includeTexture });
  const commitId = "c" + fnv(key, 0x811c9dc5) + fnv(key.split("").reverse().join(""), 0x1b873593);
  const fd = new FormData();
  fd.append("commit_id", commitId);
  fd.append("meta", JSON.stringify(out.meta));
  for (const k of ["view", "viewmask", "depth", "normal", "uvmask", "bakemask", "texture", "mesh", "prevconf"]) {
    if (out[k]) fd.append(k, out[k], k === "mesh" ? "mesh.bin" : k + ".png");
  }
  for (const r of out.viewrgn || []) fd.append("viewrgn" + (r.i + 1), r.blob, `viewrgn${r.i + 1}.png`);
  for (const r of out.refdepth || []) fd.append("refdepth" + r.n, r.blob, `refdepth${r.n}.png`);
  const sendRef2 = !!out.ref2 && (force || rec.sentRef2 !== ed.ref2Version);
  if (sendRef2) fd.append("ref2", out.ref2, "ref2.png");
  const sendRefx = force || rec.sentRefx !== ed.refxVersion;
  if (sendRefx) for (let i = 3; i <= 6; i++) if (out["ref" + i]) fd.append("ref" + i, out["ref" + i], `ref${i}.png`);
  try {
    await apiJSON(`/texpaint/commit/${rec.sid}`, { method: "POST", body: fd });
  } catch (e) {
    ed.log("error", "Could not store the captured view on the server", e);
    ed.setStatus("Capture failed: " + e.message, "err");
    throw e;
  }
  rec.lastKey = key;
  if (includeMesh) rec.sentMesh = ed.meshHash;
  if (includeTexture) rec.sentTex = ed.textureVersion;
  if (sendRef2) { rec.sentRef2 = ed.ref2Version; rec.savedRef2 = ed.ref2Version; }
  if (sendRefx) { rec.sentRefx = ed.refxVersion; rec.savedRefx = ed.refxVersion; }
  rec.savedMaskVersion = ed.maskVersion;
  ed.markSynced();
  try { if (ed.rememberPrompt && ed.hooks.getPrompt) ed.rememberPrompt(ed.hooks.getPrompt()); } catch (_) { /* history is optional */ }
  if (io.afterCommit) io.afterCommit(rec);
  const ms = Math.round(performance.now() - t0);
  ed.setStatus(`Captured ${out.meta.view_size[0]}x${out.meta.view_size[1]} view in ${ms} ms.`, "ok");
  ed.log("ok", `Captured view ${out.meta.view_size.join("x")} (commit ${commitId}, ${ms} ms).`);
  return true;
}
// ------------------------------------------------------------------------------------------
// restore after a workflow load / page refresh
// ------------------------------------------------------------------------------------------
async function restore(rec) {
  const ed = rec.ed;
  let ui = io.getUI(rec);
  if (!ui || !ui.model) { // workflow carries no state (tab switch, new workflow): use the copy stored on the server
    try {
      const sr = await api.fetchApi(`/texpaint/session/${rec.sid}/state.json`);
      if (sr.ok) { ui = await sr.json(); io.setUI(rec, ui); }
    } catch (_) { /* no stored state */ }
  }
  if (!ui) return;
  try {
    ed.applyState(ui);
    if (ui.model && ui.model.name) {
      ed.setStatus("Restoring " + ui.model.name + " ...");
      const r = await api.fetchApi(`/texpaint/model/${encodeURIComponent(ui.model.name)}`);
      if (!r.ok) throw new Error(`Model file "${ui.model.name}" is not on the server any more (HTTP ${r.status}). Load it again.`);
      await ed.loadModelBuffer(await r.arrayBuffer(), ui.model.name, { keepTexture: true });
      const getImage = async (name) => {
        const r = await api.fetchApi(`/texpaint/session/${rec.sid}/${name}`);
        return r.ok ? createImageBitmap(await r.blob()) : null;
      };
      if (ed.pbrLoadFrom) await ed.pbrLoadFrom(ui.pbrMaps, getImage);
      let restored = false;
      const stack = ui.layerStack;
      if (stack && stack.stack && stack.stack.length) {
        restored = await ed.restoreLayers(stack, getImage);
        if (restored) {
          if (ed.seedObjectStates) ed.seedObjectStates(ui.objStates); // other objects of a multi-object model (files are fetched when selected)
          rec.savedFiles = new Set([...ed.layers.files(), ...(ed.objectFiles ? ed.objectFiles() : []), ...(ed.pbrFiles ? ed.pbrFiles() : [])].map((f) => f.name));
          rec.savedLayersKey = layersPayload(ed);
        } else ed.log("warn", "The saved layers are not on the server any more - falling back to the last saved texture.");
      }
      if (!restored) { // sessions saved by version 1.0 (single texture) or lost layer files
        const tr = await api.fetchApi(`/texpaint/session/${rec.sid}/texture.png`);
        if (tr.ok) ed.setTextureFromImage(await createImageBitmap(await tr.blob()), { label: "restore", keepHistory: false });
        else if (ed.info && ed.info.embedded) ed.setTextureFromImage(ed.info.embedded, { label: "model texture", keepHistory: false });
      }
      if (ui.ref2 && ui.ref2.has) {
        const rr = await api.fetchApi(`/texpaint/session/${rec.sid}/ref2.png`);
        if (rr.ok) { await ed.loadRef2Blob(await rr.blob()); rec.savedRef2 = ed.ref2Version; rec.sentRef2 = ed.ref2Version; }
        else { ed.state.ref2.has = false; ed.state.ref2.enabled = false; ed.log("warn", "Reference image 2 is not on the server any more - load it again."); }
      }
      for (let i = 0; i < 4; i++) {
        if (!(ui.refx && ui.refx[i] && ui.refx[i].has)) continue;
        try { const rx = await api.fetchApi(`/texpaint/session/${rec.sid}/ref${i + 3}.png`); if (rx.ok) await ed.loadRefxBlob(i, await rx.blob()); else { ed.state.refx[i].has = false; } } catch (e) { ed.log("warn", `Reference image ${i + 3} could not be restored.`, e); }
      }
      rec.savedRefx = ed.refxVersion; rec.sentRefx = ed.refxVersion;
      const mr = await api.fetchApi(`/texpaint/session/${rec.sid}/mask.png`);
      if (mr.ok) ed.importMaskBitmap(await createImageBitmap(await mr.blob()), { undo: false });
      try { const tr2 = await api.fetchApi(`/texpaint/session/${rec.sid}/trans.png`); if (tr2.ok) ed.importTransBitmap(await createImageBitmap(await tr2.blob()), { undo: false }); } catch (e) { /* older session without a transition mask */ }
      try { const hr = await api.fetchApi(`/texpaint/session/${rec.sid}/heal.png`); if (hr.ok && ed.importHealBitmap) ed.importHealBitmap(await createImageBitmap(await hr.blob()), { undo: false }); } catch (e) { /* no heal area saved */ }
      if (ed.importViewBitmap && ui.views && Array.isArray(ui.views.has)) for (let i = 0; i < 4; i++) {
        if (!ui.views.has[i]) continue;
        try { const vr = await api.fetchApi(`/texpaint/session/${rec.sid}/region${i + 1}.png`); if (vr.ok) ed.importViewBitmap(i, await createImageBitmap(await vr.blob()), { undo: false }); } catch (e) { ed.log("warn", `View region ${i + 3} could not be restored`, e); }
      }
      rec.savedViews = ed.viewVersion;
      ed.applyState(ui); // camera again (loading the model re-frames it)
      rec.savedMaskVersion = ed.maskVersion; rec.savedTransVersion = ed.transVersion; rec.savedHealVersion = ed.healVersion;
      ed.setStatus("Restored " + ui.model.name, "ok");
      ed.setSaveState && ed.setSaveState("restored");
    }
  } catch (e) {
    ed.log("error", "Restoring the session failed", e);
    ed.setStatus("Restore failed: " + e.message, "err");
  }
}

  /** mirror: throw away the local copy of the state and load what the master saved */
  async function pull(rec) {
    io.setUI(rec, null);
    rec.restoring = restore(rec);
    try { await rec.restoring; } finally { rec.restoring = null; }
  }

  /** the editor hooks that only talk to the Texture Painter server (identical in the node and the standalone editor) */
  function serverHooks(rec) {
    return {
      onModelPicked: (file) => uploadModel(rec, file),
      onExportFile: async (blob, name) => {
        const fd = new FormData();
        fd.append("file", blob, name);
        fd.append("name", name);
        return apiJSON("/texpaint/save_output", { method: "POST", body: fd });
      },
      previewUVRef: async () => {
        await commitOne(rec, true);
        const r = await api.fetchApi(`/texpaint/uvref/${rec.sid}?t=${Date.now()}`);
        if (!r.ok) { let m = "HTTP " + r.status; try { m = (await r.json()).error || m; } catch (_) { /* ignore */ } throw new Error(m); }
        let notes = []; try { notes = JSON.parse(r.headers.get("X-UVRef-Notes") || "[]"); } catch (_) { /* ignore */ }
        return { bmp: await createImageBitmap(await r.blob()), notes };
      },
      getStorage: () => apiJSON("/texpaint/storage"),
      cleanup: (days) => apiJSON("/texpaint/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ days, keep: io.keepSessions() }) }),
      presets: {
        list: async () => { const r = await api.fetchApi("/texpaint/presets"); if (!r.ok) throw new Error(await routeErr(r, "GET /texpaint/presets")); return (await r.json()).presets; },
        get: async (n) => {
          let r = await postJSON("/texpaint/preset_load", { name: n });
          if (r.status === 404 || r.status === 405) { const r2 = await api.fetchApi("/texpaint/preset/" + encodeURIComponent(n)); if (r2.ok || r2.status !== 405) r = r2; }
          if (!r.ok) throw new Error(await routeErr(r, "POST /texpaint/preset_load"));
          return (await r.json()).data;
        },
        put: async (n, data, overwrite) => {
          let r = await postJSON("/texpaint/preset_save", { name: n, data, overwrite: !!overwrite });
          if (r.status === 405 || (r.status === 404 && !(await r.clone().json().catch(() => ({}))).error)) {   // old server part: try the older route once
            const r2 = await api.fetchApi("/texpaint/preset/" + encodeURIComponent(n), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ data, overwrite: !!overwrite }) });
            if (r2.status !== 405) r = r2;
          }
          if (r.status === 409) return { exists: true };
          if (!r.ok) throw new Error(await routeErr(r, "POST /texpaint/preset_save"));
          return { ok: true };
        },
        del: async (n) => {
          let r = await postJSON("/texpaint/preset_delete", { name: n });
          if (r.status === 405) { const r2 = await api.fetchApi("/texpaint/preset/" + encodeURIComponent(n), { method: "DELETE" }); if (r2.status !== 405) r = r2; }
          if (!r.ok) throw new Error(await routeErr(r, "POST /texpaint/preset_delete"));
        },
        rename: async (a, b) => {
          const r = await postJSON("/texpaint/preset_rename", { from: a, to: b });
          if (r.status === 409) return { exists: true };
          if (!r.ok) throw new Error(await routeErr(r, "POST /texpaint/preset_rename"));
          return { ok: true };
        },
      },
      projectApi: {
        dirs: (path) => apiJSON("/texpaint/project_dirs?path=" + encodeURIComponent(path || "")),
        mkdir: (path, name) => postJSON("/texpaint/project_mkdir", { path, name }).then(async (r) => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error(r.status === 404 || r.status === 405 ? await routeErr(r, "POST /texpaint/project_mkdir") : (j.error || "HTTP " + r.status)); return j; }),
        save: async (blob, name, dir, extract) => {
          const fd = new FormData(); fd.append("file", blob, name + ".zip"); fd.append("name", name); fd.append("dir", dir || ""); fd.append("extract", extract ? "1" : "0");
          const r = await api.fetchApi("/texpaint/project_save", { method: "POST", body: fd });
          const j = await r.json().catch(() => ({}));
          if (!r.ok) throw new Error(r.status === 413 && !j.error ? "ComfyUI refused the upload because it is too large - start ComfyUI with a bigger --max-upload-size (MB), or save to a browser folder instead." : (r.status === 404 || r.status === 405) ? await routeErr(r, "POST /texpaint/project_save") : (j.error || "HTTP " + r.status));
          return j;
        },
      },
      unwrapApi: async (fd) => {
        const r = await api.fetchApi("/texpaint/unwrap", { method: "POST", body: fd });
        if (!r.ok) {
          let m = ""; try { m = (await r.json()).error || ""; } catch (_) { /* not json */ }
          throw new Error(m || (await routeErr(r, "POST /texpaint/unwrap")));
        }
        return r.arrayBuffer();
      },
      fetchSessionFile: async (name) => { const r = await api.fetchApi(`/texpaint/session/${rec.sid}/${name}`); return r.ok ? r.blob() : null; },
      onSyncRequest: () => commitOne(rec, true).catch((e) => terr("Sync failed", e)),
    };
  }

  return { api, routeErr, postJSON, checkServer, fnv, apiJSON, uploadModel, layersPayload, autosave, autosaveNow, scheduleAutosave, commitOne, restore, pull, serverHooks, LAST_KEY };
}
