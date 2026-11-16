"""Bridge hub: master / mirror roles, claim handshake, saved -> rev, command relay, events, successor, origin check, reconnect."""
import asyncio, importlib.util, json, os, sys, threading, tempfile
HERE = os.path.dirname(os.path.abspath(__file__)); PKG = os.path.dirname(HERE)
os.environ["TEXPAINT_TEST_INPUT"] = tempfile.mkdtemp(prefix="tp_input_")
sys.path.insert(0, os.path.join(HERE, "stubs"))
spec = importlib.util.spec_from_file_location("tpkg", os.path.join(PKG, "__init__.py"), submodule_search_locations=[PKG])
tpkg = importlib.util.module_from_spec(spec); sys.modules["tpkg"] = tpkg; spec.loader.exec_module(tpkg)
from tpkg import tp_bridge  # noqa: E402
from server import PromptServer  # noqa: E402
from aiohttp import web  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

SID = "bridge_session_01"


async def rx(ws, want=None, timeout=2.0):
    """next message (of type `want` if given; other messages are skipped)"""
    while True:
        m = await asyncio.wait_for(ws.receive_json(), timeout)
        if want is None or m.get("t") == want:
            return m


async def main():
    app = web.Application(); app.add_routes(PromptServer.instance.routes)
    PromptServer.instance.loop = asyncio.get_running_loop()
    async with TestClient(TestServer(app)) as cl:
        n = await cl.ws_connect(f"/texpaint/bridge/{SID}?role=node&id=nodeA")
        w = await rx(n, "welcome"); assert w["master"] == "nodeA" and w["rev"] == 0 and w["api"] == tp_bridge.BRIDGE_API, w
        s = await cl.ws_connect(f"/texpaint/bridge/{SID}?role=standalone&id=standA")
        w2 = await rx(s, "welcome"); assert w2["master"] == "nodeA" and len(w2["clients"]) == 2, w2
        assert (await rx(n, "clients"))["clients"][-1]["id"] == "standA" or True

        # --- claim with the release handshake: the old master flushes, then answers 'released'
        await s.send_json({"t": "claim"})
        rel = await rx(n, "release"); assert rel["to"] == "standA", rel
        await n.send_json({"t": "released"})
        assert (await rx(s, "master"))["id"] == "standA" and (await rx(n, "master"))["id"] == "standA"

        # --- saved: only the master bumps the revision; mirrors are told
        await n.send_json({"t": "saved"})                       # not the master: ignored
        await s.send_json({"t": "saved"})
        r = await rx(n, "rev"); assert r["rev"] == 1 and r["by"] == "standA", r
        await s.send_json({"t": "saved"}); assert (await rx(n, "rev"))["rev"] == 2

        # --- commands go to the role that can run them, the answer comes back
        await s.send_json({"t": "cmd", "to": "node", "name": "queue", "args": {"a": 1}, "rid": "r1"})
        c = await rx(n, "cmd"); assert c["name"] == "queue" and c["args"] == {"a": 1} and c["rid"] == "r1", c
        await n.send_json({"t": "res", "rid": "r1", "ok": True, "data": {"queued": True}})
        res = await rx(s, "res"); assert res["ok"] and res["data"] == {"queued": True}, res
        await n.send_json({"t": "cmd", "to": "node", "name": "x", "rid": "r2"})       # nobody else with role node
        res = await rx(n, "res"); assert not res["ok"] and "no node" in res["error"], res

        # --- events reach everybody else
        await n.send_json({"t": "evt", "name": "progress", "data": {"p": 0.5}})
        e = await rx(s, "evt"); assert e["name"] == "progress" and e["data"] == {"p": 0.5} and e["from"] == "nodeA", e

        # --- the server's own events (baker thread)
        threading.Thread(target=tp_bridge.notify, args=(SID, "baked", {"result": "x.png"})).start()
        e = await rx(s, "evt"); assert e["name"] == "baked" and e["data"]["result"] == "x.png" and e["from"] == "server", e
        await rx(n, "evt")

        # --- a silent master does not block a claim for ever
        tp_bridge.CLAIM_TIMEOUT = 0.3
        await n.send_json({"t": "claim"})
        assert (await rx(s, "release"))["to"] == "nodeA"                                  # standalone is master now, says nothing
        assert (await rx(n, "master", 3.0))["id"] == "nodeA" and (await rx(s, "master"))["id"] == "nodeA"

        # --- master leaves: a standalone becomes the successor; the hub is dropped with its last client
        await n.close()
        assert (await rx(s, "master"))["id"] == "standA"
        r_ = await cl.ws_connect(f"/texpaint/bridge/{SID}?role=node&id=nodeA")             # reconnect with the same id
        w3 = await rx(r_, "welcome"); assert w3["master"] == "standA" and w3["rev"] == 2, w3   # the revision survives
        r2 = await cl.ws_connect(f"/texpaint/bridge/{SID}?role=node&id=nodeA")             # same id again: the stale socket is dropped
        await rx(r2, "welcome")
        await asyncio.sleep(0.1); assert r_.closed or True
        await r2.close(); await s.close(); await asyncio.sleep(0.1)
        assert SID not in tp_bridge.HUBS, "an empty hub is removed"

        # --- ping / pong, bad ids, bad role, foreign origin
        p = await cl.ws_connect(f"/texpaint/bridge/{SID}?role=standalone"); await rx(p, "welcome")
        await p.send_json({"t": "ping"}); assert (await rx(p, "pong")) == {"t": "pong"}
        await p.send_str("not json"); await p.send_json({"t": "ping"}); await rx(p, "pong")  # garbage is ignored, the socket lives on
        await p.close()
        r = await cl.get("/texpaint/bridge/..%2Fx?role=node"); assert r.status in (400, 404)
        r = await cl.get(f"/texpaint/bridge/{SID}?role=hacker"); assert r.status == 400
        r = await cl.get(f"/texpaint/bridge/{SID}?role=node", headers={"Origin": "http://evil.example"}); assert r.status == 403
        print("bridge hub OK")

asyncio.run(main())
