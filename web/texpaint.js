// ComfyUI extension glue for "Texture Painter AI (3D)".
// The editor itself lives in texpaint_editor.bundle.js (Three.js, bundled - no CDN needed).
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";
import { TexturePaintEditor, layoutEmbedHost, realignWidgetValues, adoptStart, successBelongsTo, createHostSession, installBridge } from "./texpaint_editor.bundle.js";
let startSeen = false;   // the frontend delivers execution_start events (used to tell which run a "finished" event belongs to)

// message for a failed ComfyUI route call. 404 / 405 on a Texture Painter route means the running ComfyUI does not have the Python routes of this version
// (it was not restarted after an update, or an older copy of the node is loaded): say what to do instead of a bare status code.
const SERVER_API = 8;

const NODE_PAINTER = "TexturePainterAI";
const MIN_WIDGET_H = 640;
const LAST_KEY = "texpaint_last_session";
const records = new Map(); // node.id -> record
const bySession = new Map(); // session id -> record

const tlog = (...a) => console.log("[TexturePainterAI]", ...a);
const terr = (...a) => console.error("[TexturePainterAI]", ...a);

// server IO of the session + the server-backed editor hooks: shared with the standalone editor (src/hostsession.js)
const H = createHostSession({
  fetchApi: (p, o) => api.fetchApi(p, o), serverApi: SERVER_API,
  getUI: (rec) => rec.node.properties && rec.node.properties.texpaint_ui,
  setUI: (rec, ui) => { rec.node.properties = rec.node.properties || {}; rec.node.properties.texpaint_ui = ui; },
  afterCommit: (rec) => writeStateWidget(rec),
  keepSessions: () => [...bySession.keys()],
});
const { routeErr, postJSON, checkServer, fnv, apiJSON, uploadModel, layersPayload, autosave, scheduleAutosave, commitOne, restore } = H;
const bridgeEvt = (rec, name, data) => { try { rec.bridge && rec.bridge.state.connected && rec.bridge.bc.send({ t: "evt", name, data }); } catch (_) { /* ignore */ } };

// ------------------------------------------------------------------------------------------
// helpers
// ------------------------------------------------------------------------------------------
function newSessionId() {
  const r = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()) + String(Date.now())).replace(/[^A-Za-z0-9]/g, "");
  return "tp_" + r.slice(0, 20);
}



function hideWidget(w) {
  if (!w) return;
  w.hidden = true;
  w.computeSize = () => [0, -4];
  if (w.element && w.element.style) w.element.style.display = "none";
  if (w.options) w.options.hidden = true;
}

function writeStateWidget(rec) {
  rec.stateW.value = JSON.stringify({ session: rec.sid });
}

function persistUI(rec, state) {
  rec.node.properties = rec.node.properties || {};
  rec.node.properties.texpaint_ui = state;
  rec.pendingState = JSON.stringify(state);
  if (rec.ed && rec.ed.hasModel && !rec.restoring) scheduleAutosave(rec);
  try { app.graph && app.graph.setDirtyCanvas && app.graph.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
}


/** The `layers` field of an autosave: the working object's stack plus the stacks of the other objects. */




/** Captures the current view and stores it on the server. Skips the work when nothing changed. */

/** Queues the workflow once and resolves with the baked result {bmp, rem, stats} (used by auto runs and variations). */
function generateOnce(rec) {
  const ed = rec.ed;
  return new Promise((resolve, reject) => {
    if (rec.waiter) { reject(new Error("A generation is already running for this node.")); return; }
    const end = (fn, v) => {
      const w = rec.waiter; if (!w) return;
      clearTimeout(w.timeout); clearTimeout(w.idle); rec.waiter = null; rec.running = false;
      ed.setProgress(null); ed.setLivePreview(null);
      fn(v);
    };
    rec.waiter = { resolve: (v) => end(resolve, v), reject: (e) => end(reject, e), timeout: setTimeout(() => end(reject, new Error("Timed out waiting for the workflow (10 minutes).")), 600000) };
    rec.running = true;
    ed.setProgress(0, "queued");
    (async () => {
      await commitOne(rec, true);
      await app.queuePrompt(0, 1);
    })().catch((e) => end(reject, e));
  });
}

/** Flushes every Texture Painter node of the open workflow to the server, marks the workflow changed and optionally saves it. */
async function saveAllNow(alsoWorkflow) {
  const res = { nodes: 0, failed: 0, workflow: null };
  for (const r of records.values()) {
    try {
      if (!r.ed || r.restoring) continue;
      clearTimeout(r.saveTimer);
      const st = r.ed.getState();
      r.node.properties = r.node.properties || {};
      r.node.properties.texpaint_ui = st;
      r.pendingState = JSON.stringify(st);
      writeStateWidget(r);
      await autosave(r);
      res.nodes++;
    } catch (e) { res.failed++; terr("save state", e); }
  }
  try { app.graph && app.graph.setDirtyCanvas(true, true); } catch (_) { /* ignore */ }
  try { const wf = app.extensionManager && app.extensionManager.workflow && app.extensionManager.workflow.activeWorkflow; if (wf && wf.changeTracker && wf.changeTracker.checkState) wf.changeTracker.checkState(); } catch (_) { /* ignore */ }
  if (alsoWorkflow) {
    try { await app.extensionManager.command.execute("Comfy.SaveWorkflow"); res.workflow = true; } catch (e) { res.workflow = false; tlog("workflow save command unavailable:", e && e.message); }
  }
  return res;
}

function workflowFinished(failed, msg, promptId) {
  for (const rec of records.values()) {
    const w = rec.waiter;
    if (!failed && w && !successBelongsTo(w, startSeen, promptId)) continue;   // end of an EARLIER run (e.g. the previous tile): not ours
    if (failed) { if (w) w.reject(new Error(msg || "The workflow failed - see the ComfyUI console.")); rec.running = false; rec.ed.setProgress(null); continue; }
    if (w) {  // finished without a baked event: the run was cached or the Bake node is not connected
      clearTimeout(w.idle);
      w.idle = setTimeout(() => { if (rec.waiter === w) w.reject(new Error("The workflow finished but produced no new result. Check that the Bake node is connected, and - for variations - that the painter's seed output is wired to the sampler's noise_seed (otherwise ComfyUI reuses the cached result).")); }, 4000);
    } else { rec.running = false; rec.ed.setProgress(null); rec.ed.setLivePreview(null); }
  }
}

async function commitAll(force = false) {
  for (const rec of records.values()) {
    const n = rec.node;
    if (n.mode !== undefined && n.mode !== 0) continue; // muted / bypassed
    await commitOne(rec, force);
  }
}


// ------------------------------------------------------------------------------------------
// node wiring
// ------------------------------------------------------------------------------------------
function setupPainterNode(node) {
  node.properties = node.properties || {};
  const stateW = (node.widgets || []).find((w) => w.name === "state_json");
  hideWidget(stateW);

  const rec = { node, stateW, sid: newSessionId(), lastKey: null, sentMesh: null, sentTex: null, sentRef2: null, savedMaskVersion: null, savedRef2: null, savedLayersKey: null, savedFiles: new Set(), restoring: null };
  records.set(node.id, rec);
  bySession.set(rec.sid, rec);

  const host = document.createElement("div");
  host.style.cssText = "width:100%;height:100%;position:relative;overflow:hidden;pointer-events:auto";
  const ed = new TexturePaintEditor({
    hooks: {
      ...H.serverHooks(rec),
      onState: (s) => persistUI(rec, s),
      onDirty: (kind) => { if (kind === "texture" || kind === "mask" || kind === "model" || kind === "ref2" || kind === "refx") scheduleAutosave(rec); },
      getPrompt: () => { const w = (node.widgets || []).find((x) => x.name === "prompt"); return w ? String(w.value || "") : ""; },
      setPrompt: (t) => { const w = (node.widgets || []).find((x) => x.name === "prompt"); if (w) { w.value = t; if (w.callback) try { w.callback(t); } catch (_) { /* ignore */ } if (w.inputEl) w.inputEl.value = t; app.graph && app.graph.setDirtyCanvas(true, true); } },
      generate: () => generateOnce(rec),
      getWidgets: () => { const o = {}; for (const w of node.widgets || []) if (["prompt", "style_hint", "compose_prompt", "mask_hint", "hint_color"].includes(w.name)) o[w.name] = w.value; return o; },
      getSeed: () => { const w = (node.widgets || []).find((x) => x.name === "seed"); return w ? Number(w.value) || 0 : Math.floor(Math.random() * 1e9); },
      setSeed: (v) => { const w = (node.widgets || []).find((x) => x.name === "seed"); if (w) { w.value = v; if (w.callback) try { w.callback(v); } catch (_) { /* ignore */ } app.graph && app.graph.setDirtyCanvas(true, true); } },
      cancelGeneration: () => { try { api.interrupt && api.interrupt(); } catch (_) { /* ignore */ } },
      setWidget: (name, value) => { const w = (node.widgets || []).find((x) => x.name === name); if (!w) return false; w.value = value; if (w.callback) try { w.callback(value); } catch (_) { /* ignore */ } app.graph && app.graph.setDirtyCanvas(true, true); return true; },
      setBakeWidget: (name, value) => {
        let n = 0;
        for (const b of (app.graph && app.graph._nodes) || []) {
          if (b.type !== "TexturePainterAIBake") continue;
          const w = (b.widgets || []).find((x) => x.name === name); if (!w) continue;
          w.value = value; if (w.callback) try { w.callback(value); } catch (_) { /* ignore */ } n++;
        }
        app.graph && app.graph.setDirtyCanvas(true, true); return n;
      },
      getWiring: () => {
        const outLinked = (n) => { const o = (node.outputs || []).find((x) => x.name === n); return !!(o && o.links && o.links.length); };
        const bake = (app.graph && app.graph._nodes || []).filter((n) => n.type === "TexturePainterAIBake");
        const inLinked = (n, name) => { const i = (n.inputs || []).find((x) => x.name === name); return !!(i && i.link != null); };
        return [
          { label: "edit_image -> Klein edit input", ok: outLinked("edit_image"), hint: "connect edit_image to the template's image input (replaces Load Image)" },
          { label: "prompt -> text encode", ok: outLinked("prompt"), hint: "connect prompt to the CLIP Text Encode text input" },
          { label: "bake_data -> Bake node", ok: outLinked("bake_data"), hint: "connect bake_data to Texture Painter AI - Bake" },
          { label: "Bake node present", ok: bake.length > 0, hint: "add Texture Painter AI - Bake (replaces Save Image)" },
          { label: "seed -> sampler noise_seed (only needed for variations)", ok: outLinked("seed"), hint: "connect seed to the sampler's noise_seed (supplied workflows do this)" },
          { label: "Bake: generated_image connected", ok: bake.some((n) => inLinked(n, "generated_image")), hint: "connect the sampler / VAE Decode IMAGE output to generated_image" },
        ];
      },
      saveNow: saveAllNow,
    },
  });
  rec.ed = ed;
  checkServer().then((msg) => { if (msg) { ed.log('warn', msg); ed.setStatus(msg, 'warn'); } });
  host.appendChild(ed.root);
  ed.root.classList.add("tp-embed");   // fills the host (absolute) instead of relying on percentage heights
  writeStateWidget(rec);

  const w = node.addDOMWidget("texpaint_view", "texpaint_view", host, {
    serialize: false,
    hideOnZoom: false,
    getMinHeight: () => MIN_WIDGET_H,
  });
  w.computeSize = (width) => [width || 760, MIN_WIDGET_H];
  // viewport first, prompt widgets below it
  const i = node.widgets.indexOf(w);
  if (i > 0) { node.widgets.splice(i, 1); node.widgets.unshift(w); }
  const sz = node.size || [0, 0];
  layoutEmbedHost(host, Math.max(sz[0], 980));
  node.setSize([Math.max(sz[0], 980), Math.max(sz[1], MIN_WIDGET_H + 330)]);

  // keep the editor as wide as the node when the node is resized (or a workflow sets its size)
  const origResize = node.onResize;
  node.onResize = function (size) {
    try { layoutEmbedHost(host, (size && size[0]) || (node.size && node.size[0])); } catch (e) { terr("layout", e); }
    return origResize ? origResize.apply(this, arguments) : undefined;
  };
  rec.layout = () => layoutEmbedHost(host, node.size && node.size[0]);
  const nodeW = (n) => (node.widgets || []).find((x) => x.name === n);
  rec.startBridge = () => {   // (re)start once the session id is final (a loaded workflow can replace it)
    if (rec.bridge && rec.bridge.sid === rec.sid) return;
    if (rec.bridge) { try { rec.bridge.dispose(); } catch (_) { /* ignore */ } rec.bridge = null; rec.mirror = false; }
    const h = ed.hooks;
    rec.bridge = installBridge(ed, rec, {
      role: "node", host: { autosave, pull: H.pull }, openUrl: () => `${location.origin}/texpaint/standalone?sid=${encodeURIComponent(rec.sid)}`,
      snapshot: () => { const w = h.getWidgets(); const s = nodeW("seed"); if (s) w.seed = Number(s.value) || 0; return { widgets: w, wiring: h.getWiring() }; },
      handlers: {
        commit: async (a) => { await commitOne(rec, !!a.force); return true; },
        generate: async (a) => { rec.skipRemoteCommit = !!(a && a.skipCommit); try { return (await generateOnce(rec)).d || {}; } finally { rec.skipRemoteCommit = false; } },
        widgetSet: async (a) => { if (!h.setWidget(a.name, a.value)) throw new Error(`The node has no widget "${a.name}".`); return true; },
        bakeSet: async (a) => h.setBakeWidget(a.name, a.value),
        cancel: async () => { h.cancelGeneration(); return true; },
      },
    });
  };

  const origRemoved = node.onRemoved;
  node.onRemoved = function () {
    try { clearTimeout(rec.saveTimer); if (rec.bridge) rec.bridge.dispose(); ed.dispose(); } catch (e) { terr("dispose failed", e); }
    if (records.get(node.id) === rec) records.delete(node.id);
    if (bySession.get(rec.sid) === rec) bySession.delete(rec.sid);
    return origRemoved && origRemoved.apply(this, arguments);
  };
  return rec;
}

async function cloneSession(src, dst) {
  try { await apiJSON("/texpaint/clone", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ src, dst }) }); } catch (e) { tlog("clone session skipped:", e.message); }
}

// debug handle (browser console:  TexturePainterAI.records)
window.TexturePainterAI = { records, bySession, commitAll, autosave };

app.registerExtension({
  name: "TexturePainterAI.Editor",

  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE_PAINTER) return;

    const onCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onCreated ? onCreated.apply(this, arguments) : undefined;
      try {
        const rec = setupPainterNode(this);
        // a brand-new node (not loaded from a workflow): reopen the model / texture / layers used last time
        setTimeout(() => {
          if (rec.configured || rec.ed.disposed || rec.ed.hasModel || records.get(rec.node.id) !== rec) return;
          let last = null; try { last = localStorage.getItem(LAST_KEY); } catch (_) { /* ignore */ }
          if (!last || last === rec.sid) return;
          rec.restoring = (async () => { await cloneSession(last, rec.sid); await restore(rec); })().finally(() => { rec.restoring = null; });
        }, 600);
        setTimeout(() => { if (!rec.ed.disposed) rec.startBridge(); }, 1200);   // a loaded workflow calls onConfigure first, which starts it with the right session id
      } catch (e) { terr("Could not create the Texture Painter UI", e); }
      return r;
    };

    const onConf = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConf ? onConf.apply(this, arguments) : undefined;
      try { realignWidgetValues(this, arguments[0]); } catch (e) { terr("could not realign the saved widget values", e); }   // the viewport widget is not serialized: frontends differ in how they index widgets_values
      const rec = records.get(this.id);
      if (rec) {
        rec.configured = true;
        try { rec.layout && rec.layout(); } catch (_) { /* ignore */ }
        let cloneFrom = null;
        try {
          const saved = JSON.parse((rec.stateW && rec.stateW.value) || "{}");
          if (saved.session && saved.session !== rec.sid) {
            bySession.delete(rec.sid);
            const other = bySession.get(saved.session);
            if (other && other !== rec) { // a copy of another node: give it its own session, copy the files
              cloneFrom = saved.session;
            } else {
              rec.sid = saved.session;
            }
            bySession.set(rec.sid, rec);
            writeStateWidget(rec);
          }
        } catch (e) { terr("bad state_json", e); }
        rec.restoring = (async () => {
          if (cloneFrom) await cloneSession(cloneFrom, rec.sid);
          await restore(rec);
        })().finally(() => { rec.restoring = null; });
        rec.startBridge && rec.startBridge();
      }
      return r;
    };
  },

  async setup() {
    // 1) capture the view automatically right before a prompt is queued
    if (!app.__texpaintWrapped) {
      app.__texpaintWrapped = true;
      const origApp = app.queuePrompt;
      if (typeof origApp === "function") {
        app.queuePrompt = async function () { await commitAll(); for (const rec of records.values()) { rec.running = true; rec.ed.setProgress(0, "queued"); } return origApp.apply(this, arguments); };
      }
      const origApi = api.queuePrompt;
      if (typeof origApi === "function") {
        api.queuePrompt = async function () { await commitAll(); return origApi.apply(this, arguments); };
      }
    }
    // 1b) live progress / sampler preview / run end
    api.addEventListener("progress", (ev) => {
      const d = ev.detail || {};
      if (!d.max) return;
      for (const rec of records.values()) if (rec.running) { rec.ed.setProgress(d.value / d.max, `sampling ${d.value}/${d.max}`); bridgeEvt(rec, "progress", { v: d.value / d.max, label: `sampling ${d.value}/${d.max}` }); }
    });
    api.addEventListener("b_preview", (ev) => {
      for (const rec of records.values()) if (rec.running && ev.detail instanceof Blob) rec.ed.setLivePreview(ev.detail);
    });
    api.addEventListener("execution_start", (ev) => { startSeen = true; for (const rec of records.values()) adoptStart(rec.waiter, ev && ev.detail && ev.detail.prompt_id); });
    api.addEventListener("execution_success", (ev) => workflowFinished(false, undefined, ev && ev.detail && ev.detail.prompt_id));
    api.addEventListener("execution_error", (ev) => workflowFinished(true, ev && ev.detail && ev.detail.exception_message ? "Workflow error: " + ev.detail.exception_message : undefined));
    api.addEventListener("execution_interrupted", () => workflowFinished(true, "Interrupted."));
    // 2) the Bake node announces its result
    api.addEventListener("texpaint.baked", async (ev) => {
      const d = ev.detail || {};
      const rec = bySession.get(d.session);
      if (!rec) return;
      rec.running = false; rec.ed.setProgress(null); rec.ed.setLivePreview(null); bridgeEvt(rec, "progress", { v: null });
      try {
        const get = async (f) => {
          const r = await api.fetchApi(`/texpaint/session/${d.session}/${f}`);
          if (!r.ok) throw new Error(`HTTP ${r.status} while fetching ${f}`);
          return createImageBitmap(await r.blob());
        };
        const result = await get(d.layer || d.result);
        const remaining = d.remaining ? await get(d.remaining).catch(() => null) : null;
        const stats = { summary: d.summary, warnings: d.warnings, prompt: d.prompt, seed: d.seed, ...(d.stats || {}) };
        if (rec.waiter) { rec.waiter.resolve({ bmp: result, rem: remaining, stats, d }); return; }
        if (rec.mirror) return;   // the master (standalone editor) shows and accepts the result
        rec.ed.showResult(result, remaining, stats);
      } catch (e) {
        rec.ed.log("error", "Could not load the baked result", e);
        rec.ed.setStatus("Could not load the baked result: " + e.message, "err");
      }
    });
  },
});
