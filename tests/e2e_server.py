"""Full-stack test server: real routes + real nodes + static files, ComfyUI modules stubbed."""
import importlib.util, json, os, sys, tempfile, traceback
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
os.environ["TEXPAINT_TEST_INPUT"] = tempfile.mkdtemp(prefix="tp_e2e_")
sys.path.insert(0, os.path.join(HERE, "stubs"))
spec = importlib.util.spec_from_file_location("tpkg", os.path.join(PKG, "__init__.py"), submodule_search_locations=[PKG])
tpkg = importlib.util.module_from_spec(spec); sys.modules["tpkg"] = tpkg; spec.loader.exec_module(tpkg)
from tpkg import tp_nodes  # noqa
from server import PromptServer  # noqa
from aiohttp import web  # noqa

routes = PromptServer.instance.routes


@routes.get("/__events")
async def events(request):
    evs = [{"event": e, "data": d} for e, d in PromptServer.instance.events]
    PromptServer.instance.events.clear()
    return web.json_response(evs)


@routes.post("/__run")
async def run(request):
    try:
        body = await request.json()
        state = json.dumps({"session": body["session"]})
        outs = tp_nodes.TexturePainterAI().run(state, "mossy cobblestones", "flat albedo", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        edit, view, vm = outs[0], outs[1], outs[2]
        bake, refimg, refw, ptext = outs[10], outs[11], outs[12], outs[7]
        m = np.array(vm)[0] > 0.9
        edit_np = np.array(edit)[0]
        ref_info = {"weight": float(refw), "prompt": ptext,
                    "edit_in_mask": [float(x) for x in edit_np[m].mean(0)] if m.any() else None,
                    "reference_shape": list(np.array(refimg).shape)}
        gen = np.array(view, copy=True)
        H, W = gen.shape[1:3]
        yy, xx = np.mgrid[0:H, 0:W]
        stripes = (((xx // 24) + (yy // 24)) % 2).astype(np.float32)
        green = np.stack([0.15 + 0.1 * stripes, 0.75 - 0.35 * stripes, 0.2 + 0.0 * stripes], -1)
        m = (vm[0] > 0.5)[..., None]
        gen[0] = np.where(m, green, gen[0])  # the "generator" repaints the marked area
        res = tp_nodes.TexturePainterAIBake().run(bake, gen, -1.0, 0.003, 1.0, 8)
        return web.json_response({"ok": True, "report": res[3], "ref": ref_info})
    except Exception:
        return web.json_response({"ok": False, "error": traceback.format_exc()}, status=500)


def static(prefix, root):
    async def h(request):
        p = os.path.normpath(os.path.join(root, request.match_info["p"]))
        if not p.startswith(root) or not os.path.isfile(p):
            return web.Response(status=404)
        ct = {".js": "text/javascript", ".html": "text/html"}.get(os.path.splitext(p)[1], "application/octet-stream")
        return web.Response(body=open(p, "rb").read(), content_type=ct)
    routes.get(prefix + "{p:.*}")(h)


static("/web/", os.path.join(PKG, "web"))
static("/scripts/", os.path.join(HERE, "stubs_js"))
static("/tests/", HERE)

app = web.Application(client_max_size=300 * 1024 * 1024)
app.add_routes(routes)


async def start():
    runner = web.AppRunner(app); await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0); await site.start()
    port = site._server.sockets[0].getsockname()[1]
    print(f"PORT {port}", flush=True)
    import asyncio
    PromptServer.instance.loop = asyncio.get_running_loop()   # the bridge's notify() from the baker thread needs the loop
    while True:
        await asyncio.sleep(3600)

import asyncio
asyncio.run(start())
