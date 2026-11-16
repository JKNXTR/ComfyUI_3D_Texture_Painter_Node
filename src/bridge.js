// Bridge between the Texture Painter inside ComfyUI (role "node") and the standalone editor (role "standalone").
// One of them is the MASTER of the session (it owns the editing, saves, and captures the view for the AI); the other one is a live MIRROR that
// reloads what the master saved. The hub (tp_bridge.py) only says WHEN something changed - the pixels travel through the session folder.
import { h } from './ui.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** WebSocket client: reconnects with back-off, heartbeat, request / answer for commands. */
export class BridgeClient {
  constructor({ sid, role, id, wsBase = null }) {
    this.sid = sid; this.role = role; this.id = id || (role[0] + Math.random().toString(36).slice(2, 10));
    this.wsBase = wsBase; this.ws = null; this.connected = false; this.closed = false; this.fails = 0;
    this.h = {}; this.pending = new Map(); this.rid = 0; this.lastPong = 0;
  }
  on(t, fn) { (this.h[t] = this.h[t] || []).push(fn); return this; }
  emit(t, m) { for (const fn of this.h[t] || []) { try { fn(m); } catch (e) { console.error('[TexturePainterAI] bridge handler', t, e); } } }
  url() {
    const base = this.wsBase || ((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
    return `${base}/texpaint/bridge/${encodeURIComponent(this.sid)}?role=${this.role}&id=${encodeURIComponent(this.id)}`;
  }
  start() {
    this.closed = false; this._open();
    clearInterval(this._hb);
    this._hb = setInterval(() => {
      if (!this.connected) return;
      if (this.lastPong && Date.now() - this.lastPong > 40000) { try { this.ws.close(); } catch (_) { /* ignore */ } return; }   // silent connection: reconnect
      this.send({ t: 'ping' });
    }, 15000);
    return this;
  }
  stop() { this.closed = true; clearInterval(this._hb); try { this.ws && this.ws.close(); } catch (_) { /* ignore */ } this._setConnected(false); }
  _setConnected(v) { if (this.connected !== v) { this.connected = v; this.emit('connection', { connected: v }); } }
  _open() {
    if (this.closed) return;
    let ws;
    try { ws = new WebSocket(this.url()); } catch (e) { this._retry(); return; }
    this.ws = ws;
    ws.onopen = () => { this.fails = 0; this.lastPong = Date.now(); this._setConnected(true); };
    ws.onmessage = (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'pong') { this.lastPong = Date.now(); return; }
      if (m.t === 'res') { const p = this.pending.get(m.rid); if (p) { this.pending.delete(m.rid); clearTimeout(p.timer); m.ok ? p.resolve(m.data) : p.reject(new Error(m.error || 'command failed')); } return; }
      this.emit(m.t, m);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.ws = null;
      this._setConnected(false);
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('The bridge connection was lost.')); }
      this.pending.clear();
      this._retry();
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  _retry() {
    if (this.closed) return;
    this.fails++;
    setTimeout(() => this._open(), Math.min(10000, 400 * Math.pow(1.6, this.fails)));
  }
  send(m) { if (this.connected && this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(m)); return true; } return false; }
  /** run a command in the other editor (role `to`); resolves with its answer */
  cmd(to, name, args = {}, timeout = 120000) {
    return new Promise((resolve, reject) => {
      const rid = this.id + ':' + (++this.rid);
      const timer = setTimeout(() => { this.pending.delete(rid); reject(new Error(`The ${to} did not answer "${name}" in time.`)); }, timeout);
      this.pending.set(rid, { resolve, reject, timer });
      if (!this.send({ t: 'cmd', to, name, args, rid })) { this.pending.delete(rid); clearTimeout(timer); reject(new Error('Not connected to the bridge.')); }
    });
  }
}

/**
 * Glue between one editor and the bridge.
 *   opts.role      'node' | 'standalone'
 *   opts.host      { autosave(rec), pull(rec) }   (session IO of the host layer)
 *   opts.handlers  commands this side can run for the other one: { generate, commit, widgetsGet, widgetsSet, bakeWidgetSet, cancel }
 *   opts.snapshot  () => object   (node only) values of the ComfyUI widgets / wiring; sent to the standalone whenever they change
 * Returns a controller { bc, state, claim(), cmd(), widgets, dispose() }.
 */
export function installBridge(ed, rec, opts) {
  const role = opts.role, bc = new BridgeClient({ sid: rec.sid, role, id: opts.id, wsBase: opts.wsBase });
  const S = { id: bc.id, master: null, clients: [], connected: false, rev: 0, applied: 0, mirror: false, widgets: {}, wiring: [] };
  const ctl = { bc, sid: rec.sid, state: S, widgets: S.widgets };

  // ---- chip in the top bar
  const chip = h('div', 'tp-bridge'); chip.style.cssText = 'margin-left:auto;display:flex;gap:6px;align-items:center;font-size:11px;color:#9aa4b8;padding:0 8px;white-space:nowrap';
  const dot = h('span', null, '●'), txt = h('span'), bTake = h('button', 'tp-btn', 'Take over');
  bTake.style.cssText = 'padding:0 8px;display:none'; bTake.title = 'Make this editor the master: it is the one you edit in, the other one becomes the live mirror';
  const bOpen = h('button', 'tp-btn', 'Open standalone');
  bOpen.style.cssText = 'padding:0 8px;display:none'; bOpen.title = 'Open the standalone editor in a new browser window, synchronised with this node';
  bOpen.onclick = () => window.open(opts.openUrl(), '_blank');
  chip.append(dot, txt, bTake, bOpen);
  (ed.ui.top || ed.root).append(chip);
  bTake.onclick = () => ctl.claim();

  // ---- read-only cover for the mirror
  const cover = h('div', 'tp-mirror');
  cover.style.cssText = 'position:absolute;left:0;right:0;top:34px;bottom:0;z-index:60;background:rgba(10,12,16,.04);display:none;cursor:not-allowed';
  const note = h('div'); note.style.cssText = 'position:absolute;left:50%;top:10px;transform:translateX(-50%);background:rgba(10,12,16,.9);border:1px solid #3a4150;border-radius:6px;padding:6px 12px;font-size:12px;color:#dfe5f3;pointer-events:none';
  cover.append(note); ed.root.append(cover);
  for (const ev of ['pointerdown', 'pointerup', 'pointermove', 'mousedown', 'wheel', 'contextmenu', 'dblclick', 'click']) cover.addEventListener(ev, (e) => { e.stopPropagation(); if (ev !== 'wheel') e.preventDefault(); });
  ed.root.addEventListener('keydown', (e) => { if (S.mirror && !e.target.closest('.tp-bridge')) { e.stopPropagation(); e.preventDefault(); } }, true);

  const label = () => {
    const other = S.clients.find((c) => c.id !== S.id);
    const otherName = other ? (other.role === 'node' ? 'ComfyUI node' : 'standalone editor') : null;
    let t, col;
    if (!S.connected) { t = 'bridge offline - retrying'; col = '#f0a23a'; }
    else if (!other) { t = 'bridge: ' + (role === 'node' ? 'standalone not open' : 'ComfyUI node not open'); col = '#9aa4b8'; }
    else if (S.mirror) { t = `mirror of the ${otherName}`; col = '#6aa8ff'; }
    else { t = `master - ${otherName} is the live mirror`; col = '#4cc38a'; }
    dot.style.color = col; txt.textContent = t;
    bTake.style.display = S.connected && S.mirror ? '' : 'none';
    bOpen.style.display = opts.openUrl && !other ? '' : 'none';
    note.textContent = `Mirror of the ${otherName || 'other editor'} - editing happens there. Press "Take over" in the top bar to edit here.`;
  };
  const setMirror = (v) => {
    if (S.mirror === v) { label(); return; }
    if (!v) clearTimeout(timer);
    S.mirror = v; rec.mirror = v; cover.style.display = v ? '' : 'none'; label();
    rec.saveDelay = (!v && S.clients.length > 1) ? 700 : 0;
    if (v) pullSoon();
  };
  const update = (m) => {
    if (m.clients) S.clients = m.clients;
    if (m.master !== undefined) S.master = m.master;
    if (m.rev !== undefined) S.rev = Math.max(S.rev, m.rev);
    setMirror(!!S.master && S.master !== S.id && S.connected);
    if (!S.mirror) rec.saveDelay = S.clients.length > 1 ? 700 : 0;
    label();
  };

  // ---- mirror: reload what the master saved, when the user is not in the middle of something
  let pulling = false, again = false, timer = null;
  const busy = () => ed._runBusy || rec.running || ed.pointerDown || (ed.hover && ed.hover.down);
  function pullSoon(ms = 150) { clearTimeout(timer); timer = setTimeout(pullNow, ms); }
  async function pullNow() {
    if (!S.mirror || !S.connected) return;
    if (pulling) { again = true; return; }
    if (busy()) { pullSoon(500); return; }
    pulling = true;
    try {
      const target = S.rev;
      await opts.host.pull(rec);
      S.applied = Math.max(S.applied, target);
    } catch (e) { ed.log('error', 'Could not load the master\'s changes', e); }
    finally { pulling = false; }
    if (again || S.applied < S.rev) { again = false; pullSoon(200); }
  }

  // ---- messages
  bc.on('connection', (m) => { S.connected = m.connected; if (!m.connected) { setMirror(false); S.master = null; } label(); });
  bc.on('welcome', async (m) => {
    S.id = m.id; S.applied = 0; update(m);
    if (opts.autoClaim && S.master !== S.id) {
      if (S.mirror) { clearTimeout(timer); await pullNow(); }   // load the current state first, THEN take over (a load that ends after the first edit would overwrite it)
      ctl.claim();
    } else if (S.mirror) pullSoon(0);
  });
  bc.on('clients', update);
  bc.on('master', (m) => { update({ master: m.id }); if (S.mirror) pullSoon(0); });
  bc.on('rev', (m) => { S.rev = Math.max(S.rev, m.rev); if (S.mirror) pullSoon(); });
  bc.on('release', async () => {                 // somebody wants to take over: flush everything first, then let go
    try { await opts.host.autosave(rec); } catch (e) { ed.log('warn', 'Flush before the hand-over failed', e); }
    bc.send({ t: 'released' });
  });
  bc.on('evt', (m) => { if (opts.onEvent) opts.onEvent(m.name, m.data, m); if (m.name === 'snapshot' && m.data) { Object.keys(S.widgets).forEach((k) => delete S.widgets[k]); Object.assign(S.widgets, m.data.widgets || {}); S.wiring = m.data.wiring || []; if (opts.onSnapshot) opts.onSnapshot(m.data); } });
  bc.on('cmd', async (m) => {
    const fn = (opts.handlers || {})[m.name];
    let out;
    try {
      if (!fn) throw new Error(`"${m.name}" is not supported by this editor.`);
      out = { ok: true, data: await fn(m.args || {}) };
    } catch (e) { out = { ok: false, error: e && e.message ? e.message : String(e) }; }
    bc.send({ t: 'res', rid: m.rid, ...out });
  });

  // the master tells the hub whenever an autosave reached the server
  const origSave = ed.setSaveState.bind(ed);
  ed.setSaveState = (k) => { origSave(k); if (k === 'saved' && !S.mirror && S.connected) bc.send({ t: 'saved' }); };

  // the node publishes its widget values / wiring so the standalone can show and edit them
  let lastSnap = '';
  if (opts.snapshot) {
    const push = () => { if (!S.connected || S.clients.length < 2) return; let s; try { s = opts.snapshot(); } catch (_) { return; } const j = JSON.stringify(s); if (j !== lastSnap) { lastSnap = j; bc.send({ t: 'evt', name: 'snapshot', data: s }); } };
    ctl._snapTimer = setInterval(push, 800);
    bc.on('clients', () => { lastSnap = ''; push(); });
  }

  ctl.claim = async () => { for (let i = 0; i < 100 && (pulling || rec.restoring); i++) await sleep(50); clearTimeout(timer); bc.send({ t: 'claim' }); };   // never take over in the middle of loading the master's state: the load would overwrite the first edits
  ctl.cmd = (to, name, args, timeout) => bc.cmd(to, name, args, timeout);
  ctl.isMirror = () => S.mirror;
  ctl.otherConnected = () => S.clients.some((c) => c.id !== S.id);
  ctl.masterRole = () => { const c = S.clients.find((x) => x.id === S.master); return c ? c.role : null; };
  ctl.dispose = () => { clearInterval(ctl._snapTimer); clearTimeout(timer); bc.stop(); chip.remove(); cover.remove(); };
  rec.remoteCommit = async (force) => {      // a Queue in this (mirror) page: the master captures the view first
    if (rec.skipRemoteCommit || !ctl.otherConnected()) return;
    const to = ctl.masterRole(); if (!to) return;
    await bc.cmd(to, 'commit', { force: !!force }, 60000);
  };
  bc.start(); label();
  return ctl;
}
