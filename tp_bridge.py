"""Bridge between the Texture Painter in ComfyUI (the node) and the standalone editor: one WebSocket hub per session.

Roles:  every client is a 'node' (the editor embedded in the ComfyUI page) or a 'standalone' (the separate editor window).
Exactly one client per session is the MASTER: it owns the editing; the others are live mirrors that reload what the master saved.
The pixels / state travel through the session folder (the editor autosave); this hub only says WHEN something changed and relays commands
(queue the workflow, set a widget, ...) to the clients that can do them - the workflow graph only exists inside the ComfyUI page.

Messages (JSON text), client -> hub:
  claim                          become master (the old master is asked to flush its autosave first: 'release' -> 'released')
  released                       answer to 'release'
  saved                          the master finished an autosave -> rev + 1, broadcast to the mirrors
  cmd {to, name, args, rid}      relay a command to the clients with role `to` ('node' | 'standalone'); the answer comes back as 'res'
  res {rid, ok, data, error}     answer to a command
  evt {name, data}               broadcast an event to all other clients
  ping                           -> pong
hub -> client:  welcome, clients, master, release, rev, cmd, res, evt, pong
"""
import asyncio
import json
import time
import uuid
from urllib.parse import urlparse

from aiohttp import WSMsgType, web
from server import PromptServer

from . import tp_common as C

routes = PromptServer.instance.routes
BRIDGE_API = 1
CLAIM_TIMEOUT = 3.0
HUBS = {}


class Client:
    def __init__(self, cid, role, ws):
        self.id, self.role, self.ws = cid, role, ws
        self.t0 = time.time()

    def info(self):
        return {"id": self.id, "role": self.role}


class Hub:
    def __init__(self, sid):
        self.sid = sid
        self.clients = {}
        self.master = None
        self.rev = 0
        self.pending = None     # (new master id, timer task)
        self.routes = {}        # rid -> requesting client id

    async def send(self, c, msg):
        try:
            await c.ws.send_str(json.dumps(msg))
            return True
        except Exception:
            return False

    async def broadcast(self, msg, skip=None, role=None):
        for c in list(self.clients.values()):
            if c.id == skip or (role and c.role != role):
                continue
            await self.send(c, msg)

    def state(self):
        return {"clients": [c.info() for c in self.clients.values()], "master": self.master, "rev": self.rev}

    async def announce(self):
        await self.broadcast({"t": "clients", **self.state()})

    async def join(self, c):
        self.clients[c.id] = c
        if self.master is None or self.master not in self.clients:
            self.master = c.id
        await self.send(c, {"t": "welcome", "id": c.id, "api": BRIDGE_API, **self.state()})
        await self.announce()

    async def leave(self, c):
        if self.clients.get(c.id) is c:
            del self.clients[c.id]
        for rid, cid in list(self.routes.items()):
            if cid == c.id:
                del self.routes[rid]
        if self.pending and self.pending[0] == c.id:
            self._cancel_pending()
        if self.master == c.id:
            # successor: a standalone first, otherwise any client that is still connected
            order = sorted(self.clients.values(), key=lambda x: (x.role != "standalone", x.t0))
            self.master = order[0].id if order else None
            if self.master:
                await self.broadcast({"t": "master", "id": self.master})
        await self.announce()

    def _cancel_pending(self):
        if self.pending:
            self.pending[1].cancel()
            self.pending = None

    async def claim(self, c):
        if self.master == c.id:
            await self.send(c, {"t": "master", "id": c.id})
            return
        old = self.clients.get(self.master) if self.master else None
        self._cancel_pending()
        if old is None:
            await self._grant(c.id)
            return
        task = asyncio.ensure_future(self._claim_timeout(c.id))
        self.pending = (c.id, task)
        await self.send(old, {"t": "release", "to": c.id})

    async def _claim_timeout(self, cid):
        try:
            await asyncio.sleep(CLAIM_TIMEOUT)
        except asyncio.CancelledError:
            return
        if self.pending and self.pending[0] == cid:
            self.pending = None
            await self._grant(cid)

    async def _grant(self, cid):
        if cid not in self.clients:
            return
        self.master = cid
        await self.broadcast({"t": "master", "id": cid})
        await self.announce()

    async def handle(self, c, m):
        t = m.get("t")
        if t == "ping":
            await self.send(c, {"t": "pong"})
        elif t == "claim":
            await self.claim(c)
        elif t == "released":
            if self.pending and c.id == self.master:
                cid = self.pending[0]
                self._cancel_pending()
                await self._grant(cid)
        elif t == "saved":
            if c.id == self.master:
                self.rev += 1
                await self.broadcast({"t": "rev", "rev": self.rev, "by": c.id}, skip=c.id)
        elif t == "cmd":
            rid = str(m.get("rid") or uuid.uuid4().hex[:8])
            targets = [x for x in self.clients.values() if x.id != c.id and x.role == m.get("to")]
            if not targets:
                await self.send(c, {"t": "res", "rid": rid, "ok": False, "error": f"no {m.get('to')} is connected to this session"})
                return
            self.routes[rid] = c.id
            await self.send(targets[0], {"t": "cmd", "name": m.get("name"), "args": m.get("args"), "rid": rid, "from": c.id})
        elif t == "res":
            rid = str(m.get("rid") or "")
            cid = self.routes.pop(rid, None)
            if cid and cid in self.clients:
                await self.send(self.clients[cid], {"t": "res", "rid": rid, "ok": bool(m.get("ok")), "data": m.get("data"), "error": m.get("error")})
        elif t == "evt":
            await self.broadcast({"t": "evt", "name": m.get("name"), "data": m.get("data"), "from": c.id}, skip=c.id)


def _origin_ok(request):
    """Browsers always send Origin on a WebSocket: it must be the page's own host (blocks other websites from talking to the bridge)."""
    origin = request.headers.get("Origin")
    if not origin:
        return True   # not a browser (tests, tools)
    try:
        return urlparse(origin).netloc == request.host
    except Exception:
        return False


@routes.get("/texpaint/bridge/{sid}")
async def bridge_ws(request):
    try:
        sid = request.match_info["sid"]
        C.session_dir(sid)   # validates the id
    except ValueError:
        return web.json_response({"error": "bad session id"}, status=400)
    if not _origin_ok(request):
        return web.json_response({"error": "origin not allowed"}, status=403)
    role = request.query.get("role", "node")
    if role not in ("node", "standalone"):
        return web.json_response({"error": "bad role"}, status=400)
    cid = request.query.get("id") or uuid.uuid4().hex[:10]
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=4 * 1024 * 1024)
    await ws.prepare(request)
    hub = HUBS.setdefault(sid, Hub(sid))
    old = hub.clients.get(cid)
    if old is not None:      # the same client reconnecting: drop the stale socket
        try:
            await old.ws.close()
        except Exception:
            pass
        hub.clients.pop(cid, None)
    c = Client(cid, role, ws)
    await hub.join(c)
    try:
        async for msg in ws:
            if msg.type == WSMsgType.TEXT:
                try:
                    m = json.loads(msg.data)
                    if isinstance(m, dict):
                        await hub.handle(c, m)
                except Exception:
                    C.log_exc("bridge message failed")
            elif msg.type in (WSMsgType.ERROR, WSMsgType.CLOSE):
                break
    finally:
        await hub.leave(c)
        if not hub.clients:
            HUBS.pop(sid, None)
    return ws


def notify(sid, name, data):
    """Called from the node's worker thread (the baker): tell the clients of this session about an event."""
    hub = HUBS.get(sid)
    if not hub:
        return
    try:
        loop = getattr(PromptServer.instance, "loop", None)
        coro = hub.broadcast({"t": "evt", "name": name, "data": data, "from": "server"})
        if loop is not None and loop.is_running():
            asyncio.run_coroutine_threadsafe(coro, loop)
        else:
            coro.close()
    except Exception:
        C.log_exc("bridge notify failed")


# ------------------------------------------------------------------------------------------
# the standalone editor page (the editor bundle is served from the same file the ComfyUI page loads: nothing to keep in sync)
# ------------------------------------------------------------------------------------------
import os

_ROOT = os.path.dirname(os.path.abspath(__file__))
_NOCACHE = {"Cache-Control": "no-store"}
_PAGE = """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Texture Painter AI - standalone</title>
<style>html,body{margin:0;height:100%;background:#12141a;color:#dfe5f3;font:13px system-ui,sans-serif;overflow:hidden}#host{position:fixed;inset:0}
#pick{max-width:640px;margin:8vh auto;padding:0 16px}#pick h2{font-weight:600}#pick .row{display:flex;gap:10px;align-items:center;padding:8px 10px;border:1px solid #2a2f3b;border-radius:6px;margin:6px 0;cursor:pointer}
#pick .row:hover{background:#1b1f29}#pick .sub{color:#8d97ad;font-size:11px}#pick button{background:#2b6cff;color:#fff;border:0;border-radius:5px;padding:6px 12px;cursor:pointer}</style></head>
<body><div id="host"></div><script type="module" src="/texpaint/standalone/app.js"></script></body></html>"""


@routes.get("/texpaint/standalone")
async def standalone_page(request):
    return web.Response(text=_PAGE, content_type="text/html", headers=_NOCACHE)


@routes.get("/texpaint/standalone/app.js")
async def standalone_app(request):
    return web.FileResponse(os.path.join(_ROOT, "standalone", "app.js"), headers={**_NOCACHE, "Content-Type": "text/javascript"})


@routes.get("/texpaint/standalone/bundle.js")
async def standalone_bundle(request):
    return web.FileResponse(os.path.join(_ROOT, "web", "texpaint_editor.bundle.js"), headers={**_NOCACHE, "Content-Type": "text/javascript"})


@routes.get("/texpaint/sessions")
async def sessions_list(request):
    root = os.path.join(C.base_dir(), "sessions")
    out = []
    try:
        names = os.listdir(root)
    except OSError:
        names = []
    for sid in names:
        sp = os.path.join(root, sid, "state.json")
        if not C.SID_RE.match(sid) or not os.path.isfile(sp):
            continue
        st = C.read_json(sp, {}) or {}
        hub = HUBS.get(sid)
        out.append({"sid": sid, "model": ((st.get("model") or {}).get("name") if isinstance(st, dict) else None) or "", "mtime": os.path.getmtime(sp),
                    "node": bool(hub and any(c.role == "node" for c in hub.clients.values())),
                    "standalone": bool(hub and any(c.role == "standalone" for c in hub.clients.values()))})
    out.sort(key=lambda r: (not r["node"], -r["mtime"]))
    return web.json_response({"sessions": out[:60]}, headers=_NOCACHE)
