// Standalone Texture Painter AI: the same editor as the ComfyUI node, in its own window, kept in sync through the bridge.
import { TexturePaintEditor, createHostSession, installBridge, layoutEmbedHost } from './bundle.js';

const SERVER_API = 8;
const q = new URLSearchParams(location.search);
const host = document.getElementById('host');
const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };
const newSid = () => 'tp_' + (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()) + Date.now()).replace(/[^A-Za-z0-9]/g, '').slice(0, 20);

async function picker() {
  const box = el('div'); box.id = 'pick';
  box.append(el('h2', null, 'Texture Painter AI - standalone'));
  const info = el('div', 'sub', 'Pick the session of a Texture Painter node (the ones with the node open are listed first), or start a new one.'); box.append(info);
  const list = el('div'); box.append(list);
  const go = (sid) => { try { localStorage.setItem('texpaint_standalone_sid', sid); } catch (_) { /* ignore */ } location.search = '?sid=' + encodeURIComponent(sid); };
  try {
    const r = await fetch('/texpaint/sessions'); if (!r.ok) throw new Error('HTTP ' + r.status + ' - restart ComfyUI so the new routes are loaded');
    for (const s of (await r.json()).sessions) {
      const row = el('div', 'row'); const t = el('div'); t.append(el('div', null, s.model || '(no model yet)'), el('div', 'sub', `${s.sid} - ${new Date(s.mtime * 1000).toLocaleString()}${s.node ? ' - node open in ComfyUI' : ''}${s.standalone ? ' - open in a standalone window' : ''}`));
      row.append(t); row.onclick = () => go(s.sid); list.append(row);
    }
    if (!list.childNodes.length) list.append(el('div', 'sub', 'No saved sessions yet.'));
  } catch (e) { list.append(el('div', 'sub', 'Could not list the sessions: ' + e.message)); }
  const nb = el('button', null, 'New empty session'); nb.onclick = () => go(newSid()); box.append(nb);
  host.append(box);
}

async function main() {
  let sid = q.get('sid');
  if (!sid) { try { const last = localStorage.getItem('texpaint_standalone_sid'); if (last && q.get('pick') == null) sid = last; } catch (_) { /* ignore */ } }
  if (!sid) { await picker(); return; }
  if (!q.get('sid')) history.replaceState(null, '', '?sid=' + encodeURIComponent(sid));

  const rec = { sid, ui: null, lastKey: null, sentMesh: null, sentTex: null, sentRef2: null, savedMaskVersion: null, savedRef2: null, savedLayersKey: null, savedFiles: new Set(), restoring: null };
  const H = createHostSession({
    fetchApi: (p, o) => fetch(p, o), serverApi: SERVER_API,
    getUI: (r) => r.ui, setUI: (r, ui) => { r.ui = ui; }, afterCommit: () => {}, keepSessions: () => [sid],
  });
  let ctl = null;
  const W = () => (ctl ? ctl.widgets : {});
  const nodeUp = () => !!(ctl && ctl.state.clients.some((c) => c.role === 'node'));
  const needNode = () => { if (!nodeUp()) throw new Error('The ComfyUI page with the Texture Painter node is not open - the AI workflow can only be queued from there.'); };
  const setW = (name, value) => { W()[name] = value; if (nodeUp()) ctl.cmd('node', 'widgetSet', { name, value }, 15000).catch((e) => ed.log('warn', 'Could not set the widget in ComfyUI', e)); };
  const fetchBmp = async (f) => { const r = await fetch(`/texpaint/session/${sid}/${f}`); if (!r.ok) throw new Error(`HTTP ${r.status} while fetching ${f}`); return createImageBitmap(await r.blob()); };
  const toResult = async (d) => ({ bmp: await fetchBmp(d.layer || d.result), rem: d.remaining ? await fetchBmp(d.remaining).catch(() => null) : null, stats: { summary: d.summary, warnings: d.warnings, prompt: d.prompt, seed: d.seed, ...(d.stats || {}) } });

  const ed = new TexturePaintEditor({
    hooks: {
      ...H.serverHooks(rec),
      onState: (s) => { rec.ui = s; rec.pendingState = JSON.stringify(s); if (ed.hasModel && !rec.restoring) H.scheduleAutosave(rec); },
      onDirty: (k) => { if (k === 'texture' || k === 'mask' || k === 'model' || k === 'ref2' || k === 'refx') H.scheduleAutosave(rec); },
      getPrompt: () => String(W().prompt || ''),
      setPrompt: (t) => setW('prompt', t),
      getWidgets: () => { const o = {}; for (const k of ['prompt', 'style_hint', 'compose_prompt', 'mask_hint', 'hint_color']) if (k in W()) o[k] = W()[k]; return o; },
      getSeed: () => Number(W().seed) || 0,
      setSeed: (v) => setW('seed', v),
      setWidget: (n, v) => { setW(n, v); return true; },
      setBakeWidget: (n, v) => { if (nodeUp()) ctl.cmd('node', 'bakeSet', { name: n, value: v }, 15000).catch(() => {}); return 1; },
      getWiring: () => (ctl && ctl.state.wiring) || [],
      cancelGeneration: () => { if (nodeUp()) ctl.cmd('node', 'cancel', {}, 15000).catch(() => {}); },
      saveNow: async () => { await H.autosave(rec); return { nodes: 1, failed: 0, workflow: null }; },
      generate: async () => {
        needNode();
        rec.genBusy = true; ed.setProgress(0, 'queued');
        try {
          if (!rec.mirror) await H.commitOne(rec, true);   // the master captures the view; the node then queues without capturing again
          return await toResult(await ctl.cmd('node', 'generate', { skipCommit: !rec.mirror }, 660000));
        } finally { rec.genBusy = false; ed.setProgress(null); ed.setLivePreview(null); }
      },
    },
  });
  rec.ed = ed;
  H.checkServer().then((m) => { if (m) { ed.log('warn', m); ed.setStatus(m, 'warn'); } });
  ed.root.classList.add('tp-embed'); host.append(ed.root);
  const lay = () => { try { layoutEmbedHost(host, host.clientWidth); } catch (_) { /* ignore */ } };
  lay(); addEventListener('resize', lay);

  ctl = installBridge(ed, rec, {
    role: 'standalone', autoClaim: true, host: { autosave: H.autosave, pull: H.pull },
    handlers: {
      commit: async (a) => { await H.commitOne(rec, !!a.force); return true; },
      status: async () => ({ model: ed.hasModel }),
    },
    onEvent: async (name, data) => {
      if (name === 'progress') { if (data && data.v != null) ed.setProgress(data.v, data.label || ''); else if (!rec.genBusy) { ed.setProgress(null); ed.setLivePreview(null); } }
      else if (name === 'baked' && data && data.session === sid && !rec.genBusy && !rec.mirror) {   // queued from the ComfyUI page while this editor is the master
        try { const r = await toResult(data); ed.showResult(r.bmp, r.rem, r.stats); } catch (e) { ed.log('error', 'Could not load the baked result', e); }
      }
    },
  });
  rec.restoring = H.restore(rec).finally(() => { rec.restoring = null; });
  window.TexturePainterStandalone = { rec, ed, ctl, H };
}
main().catch((e) => { document.body.append(el('pre', null, 'Standalone editor failed to start: ' + (e && e.stack || e))); console.error(e); });
