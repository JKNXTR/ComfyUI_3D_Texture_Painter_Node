"""Exercises the real HTTP routes (aiohttp test client) and both nodes with stubbed ComfyUI modules."""
import asyncio, importlib.util, json, os, sys, tempfile
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
PKG = os.path.dirname(HERE)
OUT = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tp_out"
os.environ["TEXPAINT_TEST_INPUT"] = tempfile.mkdtemp(prefix="tp_input_")
sys.path.insert(0, os.path.join(HERE, "stubs"))

spec = importlib.util.spec_from_file_location("tpkg", os.path.join(PKG, "__init__.py"), submodule_search_locations=[PKG])
tpkg = importlib.util.module_from_spec(spec)
sys.modules["tpkg"] = tpkg
spec.loader.exec_module(tpkg)
from tpkg import tp_nodes, tp_server, tp_common as C  # noqa: E402
from server import PromptServer  # noqa: E402  (stub)
from aiohttp import web, FormData  # noqa: E402
from aiohttp.test_utils import TestClient, TestServer  # noqa: E402

assert set(tpkg.NODE_CLASS_MAPPINGS) == {"TexturePainterAI", "TexturePainterAIBake"}, tpkg.NODE_CLASS_MAPPINGS
assert tpkg.WEB_DIRECTORY == "./web"

SID = "tp_test_session_01"


def commit_form(commit_id, with_mesh=True):
    fd = FormData()
    for k, f in [("view", "view.png"), ("viewmask", "viewmask.png"), ("depth", "depth.png"), ("normal", "normal.png"),
                 ("uvmask", "uvmask.png"), ("texture", "texture.png")]:
        fd.add_field(k, open(f"{OUT}/{f}", "rb").read(), filename=f, content_type="image/png")
    if with_mesh:
        fd.add_field("mesh", open(f"{OUT}/mesh.bin", "rb").read(), filename="mesh.bin", content_type="application/octet-stream")
    fd.add_field("meta", open(f"{OUT}/meta.json").read())
    fd.add_field("commit_id", commit_id)
    return fd


import io as _io2_
async def main():
    app = web.Application(client_max_size=200 * 1024 * 1024)
    app.add_routes(PromptServer.instance.routes)
    async with TestClient(TestServer(app)) as cl:
        r = await cl.get("/texpaint/ping"); assert r.status == 200, await r.text()

        # --- model upload / download
        fd = FormData(); fd.add_field("file", b"v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n", filename="../../evil name.obj")
        r = await cl.post("/texpaint/upload_model", data=fd); j = await r.json(); assert r.status == 200, j
        name = j["name"]; assert "/" not in name and name.endswith(".obj"), name
        r = await cl.get(f"/texpaint/model/{name}"); assert r.status == 200 and (await r.read()).startswith(b"v 0")
        fd = FormData(); fd.add_field("file", b"x", filename="payload.exe")
        r = await cl.post("/texpaint/upload_model", data=fd); assert r.status == 400
        r = await cl.get("/texpaint/model/..%2Fsecret.obj"); assert r.status in (400, 404)
        r = await cl.get("/texpaint/models"); assert name in (await r.json())["models"]

        # --- commit
        r = await cl.post(f"/texpaint/commit/{SID}", data=commit_form("commitaaaa111")); j = await r.json()
        assert r.status == 200 and j["commit_id"] == "commitaaaa111", j
        fd = FormData(); fd.add_field("view", b"not a png", filename="view.png"); fd.add_field("meta", "{}")
        r = await cl.post(f"/texpaint/commit/{SID}", data=fd); assert r.status == 400
        fd = FormData(); fd.add_field("mesh", b"garbage-garbage", filename="mesh.bin")
        r = await cl.post(f"/texpaint/put/{SID}", data=fd); assert r.status == 400
        r = await cl.post("/texpaint/commit/..%2F..%2Fx", data=commit_form("c1")); assert r.status in (400, 404)

        # --- session file access rules
        r = await cl.get(f"/texpaint/session/{SID}/view.png"); assert r.status == 200
        r = await cl.get(f"/texpaint/session/{SID}/passwd"); assert r.status == 400
        r = await cl.get(f"/texpaint/session/bad/view.png"); assert r.status == 400
        r = await cl.get(f"/texpaint/session/{SID}/..%2F..%2Fview.png"); assert r.status in (400, 404)

        # --- painter node
        state = json.dumps({"session": SID})
        node = tp_nodes.TexturePainterAI()
        assert tp_nodes.TexturePainterAI.IS_CHANGED(state, mask_grow=6, mask_feather=4).startswith("commitaaaa111")
        outs = node.run(state, "weathered red brick wall", "flat albedo", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        edit, view, vm, depth, normal, tex, umask, prompt, w, h, bake, refimg, refw, seed_o, steps_o, cfg_o, rx3, rx4, rx5, rx6, tcount_o, tindex_o, ttotal_o = outs
        assert (tcount_o, tindex_o, ttotal_o) == (1, -1, 1), (tcount_o, tindex_o, ttotal_o)
        assert (seed_o, steps_o, cfg_o) == (0, 4, 1.0), (seed_o, steps_o, cfg_o)
        print("painter outputs:", [getattr(o, "shape", o) for o in outs[:10]])
        assert edit.shape == (1, 1024, 1024, 3) and vm.shape == (1, 1024, 1024) and (w, h) == (1024, 1024)
        assert prompt.startswith("Repaint only the magenta marked area: weathered red brick wall.")
        assert edit[0][vm[0] > 0.9].mean(axis=0)[0] > 0.8, "tint not applied in masked area"
        assert np.allclose(edit[0][vm[0] < 0.001], view[0][vm[0] < 0.001]), "tint leaked outside mask"
        Image.fromarray((edit[0] * 255).astype(np.uint8)).save(f"{OUT}/node_edit_image.png")

        # --- bake node
        bn = tp_nodes.TexturePainterAIBake()
        gen = (1.0 - view)  # pretend the generator inverted the colours
        texture, conf, remaining, report = bn.run(bake, gen, -1.0, 0.003, 1.0, 8)
        print("bake report:", report.replace("\n", " | "))
        assert texture.shape == (1, 1024, 1024, 3) and conf.shape == (1, 1024, 1024)
        ev = [e for e in PromptServer.instance.events if e[0] == "texpaint.baked"]
        assert ev and ev[-1][1]["session"] == SID and ev[-1][1]["result"].startswith("result_")
        r = await cl.get(f"/texpaint/session/{SID}/{ev[-1][1]['result']}"); assert r.status == 200
        im = Image.open(__import__("io").BytesIO(await r.read())); assert im.size == (1024, 1024)
        r = await cl.get(f"/texpaint/session/{SID}/{ev[-1][1]['remaining']}"); assert r.status == 200
        Image.open(__import__("io").BytesIO(await r.read())).save(f"{OUT}/node_remaining.png")
        im.save(f"{OUT}/node_result.png")
        assert (conf > 0.5).sum() > 5000

        # --- final-texture importance weights (generated / original viewport / reference 2)
        sel = conf[0].numpy() if hasattr(conf, "numpy") else np.asarray(conf[0])
        sel = sel > 0.5
        texo = np.asarray(tex[0].cpu() if hasattr(tex, "cpu") else tex[0])
        b_orig = dict(bake); b_orig["blend"] = {"gen": 0.0, "orig": 1.0, "ref": 0.0}
        t_o, *_r = bn.run(b_orig, gen, -1.0, 0.003, 1.0, 8)
        t_o = np.asarray(t_o[0].cpu() if hasattr(t_o, "cpu") else t_o[0])
        t_g = np.asarray(texture[0].cpu() if hasattr(texture, "cpu") else texture[0])
        d_o = np.abs(t_o[sel] - texo[sel]).mean(); d_g = np.abs(t_g[sel] - texo[sel]).mean()
        assert d_o < 0.05 and d_g > 0.2, f"orig-only weight must reproduce the original look (diff {d_o:.3f}) unlike gen-only ({d_g:.3f})"
        b_half = dict(bake); b_half["blend"] = {"gen": 1.0, "orig": 1.0, "ref": 0.0}
        t_h, _c, _rm, rep_h = bn.run(b_half, gen, -1.0, 0.003, 1.0, 8)
        t_h = np.asarray(t_h[0].cpu() if hasattr(t_h, "cpu") else t_h[0])
        sel95 = np.asarray(conf[0].cpu() if hasattr(conf, "cpu") else conf[0]) > 0.95
        print("mid-gray error on fully confident texels:", float(np.abs(t_h[sel95] - 0.5).mean()))
        assert sel95.sum() > 3000 and np.abs(t_h[sel95] - 0.5).mean() < 0.02 and "Final mix: generated 1.00 / original viewport 1.00" in rep_h, "50/50 of inverted + original must be mid gray"
        print("final-texture weights OK")

        # --- master output resolution
        t512, c512, r512, rep512 = bn.run(bake, gen, -1.0, 0.003, 1.0, 8, "512")
        assert t512.shape == (1, 512, 512, 3) and c512.shape == (1, 512, 512) and r512.shape == (1, 512, 512), (t512.shape, c512.shape)
        assert "512x512" in rep512, rep512
        ev2 = [e for e in PromptServer.instance.events if e[0] == "texpaint.baked"][-1][1]
        assert ev2["size"] == [512, 512], ev2
        r = await cl.get(f"/texpaint/session/{SID}/{ev2['layer']}"); assert r.status == 200
        assert Image.open(__import__("io").BytesIO(await r.read())).size == (512, 512)
        assert (c512 > 0.5).sum() > 5000 / 4 * 0.6
        t2k, _, _, rep2k = bn.run(bake, gen, -1.0, 0.003, 1.0, 8, "2048")
        assert t2k.shape == (1, 2048, 2048, 3), t2k.shape
        tm, _, _, repm = bn.run(bake, gen, -1.0, 0.003, 1.0, 8, "match texture")
        assert tm.shape == (1, 1024, 1024, 3) and "Output resolution" not in repm
        assert tp_nodes._parse_resolution("match texture") == 0 and tp_nodes._parse_resolution("4096") == 4096 and tp_nodes._parse_resolution(None) == 0
        print("master resolution OK")

        # --- align generated image to the placed reference
        vnp = np.asarray(bake["view_np"], np.float32)
        yy, xx = np.mgrid[0:vnp.shape[0], 0:vnp.shape[1]]
        pattern = np.stack([0.5 + 0.5 * np.sin(xx / 9.0 + yy / 23.0), 0.5 + 0.5 * np.cos(yy / 11.0 - xx / 31.0), 0.5 + 0.5 * np.sin((xx + yy) / 17.0)], -1).astype(np.float32)
        bal = dict(bake); bal["ref_np"] = pattern; bal["ref_alpha_np"] = np.ones(pattern.shape[:2], np.float32); bal["mask_np"] = np.ones(pattern.shape[:2], np.float32)
        shifted = np.roll(pattern, (6, -9), axis=(0, 1))[None]       # Klein moved the picture 9 px left, 6 px down
        _, _, _, rep_off = bn.run(bal, shifted, -1.0, 0.003, 1.0, 8, "match texture", False)
        _, _, _, rep_on = bn.run(bal, shifted, -1.0, 0.003, 1.0, 8, "match texture", True)
        assert "Align" not in rep_off and "Align: moved the generated image by" in rep_on, (rep_off, rep_on)
        import re as _re
        mv = _re.search(r"by ([+-][\d.]+), ([+-][\d.]+) px", rep_on); assert mv and abs(float(mv.group(1)) - 9) < 0.5 and abs(float(mv.group(2)) + 6) < 0.5, rep_on
        _, _, _, rep_none = bn.run(bake, gen, -1.0, 0.003, 1.0, 8, "match texture", True)
        assert "Align: skipped" in rep_none, rep_none
        print("align node OK:", rep_on.split("Align:")[1].split("(raster")[0].strip())

        # aspect mismatch warns but works; wrong size generated image should still not crash
        gen2 = np.ascontiguousarray(gen[:, :, :512, :])
        _, _, _, rep2 = bn.run(bake, gen2, 0.3, 0.003, 1.0, 0)
        assert "aspect ratio" in rep2, rep2

        # --- stale commit protection
        r = await cl.post(f"/texpaint/commit/{SID}", data=commit_form("commitbbbb222", with_mesh=False)); assert r.status == 200
        try:
            bn.run(bake, gen, -1.0, 0.003, 1.0, 8)
            raise SystemExit("stale bake_data was accepted!")
        except RuntimeError as e:
            assert "changed after" in str(e), e
        # --- painter without capture
        try:
            node.run(json.dumps({"session": "tp_nothing_here"}), "x", "", True, "none", "#fff", 1, 0, 0)
            raise SystemExit("missing capture accepted")
        except RuntimeError as e:
            assert "No captured view" in str(e), e
        # --- reference_image output: placed composite vs the ORIGINAL (non-square) image 2
        import io
        from PIL import Image as _Im
        buf = io.BytesIO(); _Im.new("RGB", (80, 40), (200, 30, 30)).save(buf, "PNG")
        for orig in (False, True):
            meta = json.load(open(f"{OUT}/meta.json"))
            meta["ref2"] = {"enabled": True, "has": True, "weight": 0.7, "mode": "manual", "ox": 0, "oy": 0, "size": 0.5, "rot": 0,
                            "wrap": False, "aspect": 0, "original": orig}
            fd = commit_form("commitref" + str(int(orig)), with_mesh=False)
            fd._fields = [f for f in fd._fields if f[0].get("name") != "meta"]
            fd.add_field("meta", json.dumps(meta)); fd.add_field("ref2", buf.getvalue(), filename="ref2.png", content_type="image/png")
            r = await cl.post(f"/texpaint/commit/{SID}", data=fd); assert r.status == 200, await r.text()
            o = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
            shp = tuple(o[11].shape)
            if orig:
                assert shp == (1, 40, 80, 3), f"original image 2 must keep its own size/proportions, got {shp}"
                assert abs(float(o[11][0, 20, 40, 0]) - 200 / 255) < 0.01
            else:
                assert shp[1:3] == (o[0].shape[1], o[0].shape[2]), f"placed composite must match the view, got {shp}"
        print("reference_image: placed vs original OK")

        # --- extra reference images 3..5: pass-through at their own size, role text in the prompt, unused slots = copy of the view
        buf3 = io.BytesIO(); _Im.new("RGB", (48, 24), (10, 200, 10)).save(buf3, "PNG")
        buf5 = io.BytesIO(); _Im.new("RGB", (16, 16), (10, 10, 220)).save(buf5, "PNG")
        meta = json.load(open(f"{OUT}/meta.json")); meta["ref2"] = {"enabled": False}
        meta["refx"] = [{"has": True, "enabled": True, "role": "leather material."}, {"has": False, "enabled": True, "role": ""},
                        {"has": True, "enabled": False, "role": "off"}]
        fd = commit_form("commitrefx1", with_mesh=False)
        fd._fields = [f for f in fd._fields if f[0].get("name") != "meta"]
        fd.add_field("meta", json.dumps(meta)); fd.add_field("ref3", buf3.getvalue(), filename="ref3.png", content_type="image/png")
        fd.add_field("ref5", buf5.getvalue(), filename="ref5.png", content_type="image/png")
        r = await cl.post(f"/texpaint/commit/{SID}", data=fd); assert r.status == 200, await r.text()
        o = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert len(o) == 23 and tuple(o[16].shape) == (1, 24, 48, 3) and abs(float(o[16][0, 10, 20, 1]) - 200 / 255) < 0.01, "image 3 must pass through unchanged"
        assert tuple(o[17].shape) == tuple(o[0].shape) and tuple(o[18].shape) == tuple(o[0].shape), "unused / disabled slots output a copy of the view"
        assert "Image 3: leather material." in o[7] and "Image 5" not in o[7] and "Image 4" not in o[7], o[7]
        print("extra reference images 3-5 OK")

        # --- reference image 6 behaves like image 2: placed (mode frame), blended into edit_image by its weight, angle text, placed output
        buf6 = io.BytesIO(); _Im.new("RGB", (32, 32), (250, 10, 10)).save(buf6, "PNG")
        meta = json.load(open(f"{OUT}/meta.json")); meta["ref2"] = {"enabled": False}
        meta["refx"] = [{"has": False}, {"has": False}, {"has": False},
                        {"has": True, "enabled": True, "weight": 1.0, "mode": "frame", "original": False, "angle": "back", "role": "red paint"}]
        fd = commit_form("commitref6", with_mesh=False)
        fd._fields = [f for f in fd._fields if f[0].get("name") != "meta"]
        fd.add_field("meta", json.dumps(meta)); fd.add_field("ref6", buf6.getvalue(), filename="ref6.png", content_type="image/png")
        r = await cl.post(f"/texpaint/commit/{SID}", data=fd); assert r.status == 200, await r.text()
        o = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert "Image 6 shows the subject from the back." in o[7] and "Image 6: red paint." in o[7], o[7]
        assert tuple(o[19].shape) == tuple(o[0].shape), "placed image 6 matches the view"
        m_ = np.asarray(o[2][0]) > 0.5
        assert m_.any() and float(np.asarray(o[0][0])[..., 0][m_].mean()) > 0.9 and float(np.asarray(o[0][0])[..., 1][m_].mean()) < 0.2, "weight 1 blends image 6 into the masked area of edit_image"
        print("reference image 6 (placed, weight, angle) OK")

        # --- view regions: a reference only acts inside its own region (viewrgnN pass); region files are stored by the autosave and served back
        def _commit_ref6_region(cid, region_val):
            meta = json.load(open(f"{OUT}/meta.json")); meta["ref2"] = {"enabled": False}
            meta["refx"] = [{"has": False}, {"has": False}, {"has": False},
                            {"has": True, "enabled": True, "weight": 1.0, "mode": "frame", "original": False}]
            meta["view_regions"] = [False, False, False, True]
            rg = io.BytesIO(); _Im.new("L", (o[0].shape[2], o[0].shape[1]), region_val).save(rg, "PNG")
            fd = commit_form(cid, with_mesh=False)
            fd._fields = [f for f in fd._fields if f[0].get("name") != "meta"]
            fd.add_field("meta", json.dumps(meta)); fd.add_field("ref6", buf6.getvalue(), filename="ref6.png", content_type="image/png")
            fd.add_field("viewrgn4", rg.getvalue(), filename="viewrgn4.png", content_type="image/png")
            return fd
        for val, red in ((0, False), (255, True)):
            r = await cl.post(f"/texpaint/commit/{SID}", data=_commit_ref6_region("commitreg%d" % val, val)); assert r.status == 200, await r.text()
            o = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
            m_ = np.asarray(o[2][0]) > 0.5
            redness = float(np.asarray(o[0][0])[..., 0][m_].mean()) - float(np.asarray(o[0][0])[..., 2][m_].mean())   # red image vs magenta tint
            assert (redness > 0.7) == red, (val, redness)
        fd = FormData(); rgp = io.BytesIO(); _Im.new("L", (64, 64), 255).save(rgp, "PNG")
        fd.add_field("uvregion2", rgp.getvalue(), filename="region2.png", content_type="image/png")
        r = await cl.post(f"/texpaint/put/{SID}", data=fd); assert r.status == 200 and "region2.png" in (await r.json())["written"]
        r = await cl.get(f"/texpaint/session/{SID}/region2.png"); assert r.status == 200 and (await r.read())[:4] == b"\x89PNG"
        print("view regions (clip reference, autosave, serve) OK")

        # --- UV mode: edit_image is the flat UV texture + mask, the generated image is blended straight back through the mask (no projection)
        meta = json.load(open(f"{OUT}/meta.json")); meta["ref2"] = {"enabled": False}; meta["uv_mode"] = True
        fd = commit_form("commituvmode", with_mesh=False)
        fd._fields = [f for f in fd._fields if f[0].get("name") not in ("meta", "uvmask")]
        uvm_png = _io2_.BytesIO(); _um = _Im.new("L", (1024, 1024), 0); _um.paste(255, (256, 256, 768, 768)); _um.save(uvm_png, "PNG")
        fd.add_field("meta", json.dumps(meta)); fd.add_field("uvmask", uvm_png.getvalue(), filename="mask.png", content_type="image/png")
        r = await cl.post(f"/texpaint/commit/{SID}", data=fd); assert r.status == 200, await r.text()
        o = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert np.allclose(o[1][0], o[5][0]), "UV mode: view_image must be the UV texture"
        assert "flat UV texture map" in o[7], o[7]
        mm = o[2][0] > 0.9; assert mm[512, 512] and not mm[10, 10]
        assert o[0][0][512, 512, 0] > 0.8 and np.allclose(o[0][0][10, 10], o[5][0][10, 10]), "UV mode: edit_image tints the mask area only"
        gen_uv = np.zeros((1, 1024, 1024, 3), np.float32); gen_uv[..., 1] = 1.0   # pretend the generator painted pure green
        t_uv, c_uv, rem_uv, rep_uv = bn.run(o[10], gen_uv, -1.0, 0.003, 1.0, 8)
        assert "UV mode" in rep_uv and t_uv.shape == (1, 1024, 1024, 3), rep_uv
        assert t_uv[0][512, 512, 1] > 0.95 and t_uv[0][512, 512, 0] < 0.05, "UV mode: generated pixels land in the masked area"
        assert np.allclose(t_uv[0][10, 10], o[5][0][10, 10], atol=0.01), "UV mode: texture outside the mask is unchanged"
        print("UV mode (UV texture as AI image, direct bake) OK")

        # --- Heal run (Heal brush J): the heal area is the AI mask, the heal prompt replaces the normal prompt / style / references
        meta = json.load(open(f"{OUT}/meta.json")); meta["ref2"] = {"enabled": False}; meta["uv_mode"] = True
        meta["mask_source"] = "transition"; meta["heal"] = {"on": True, "prompt": "fix the stretched seam"}
        hm_png = _io2_.BytesIO(); _hm = _Im.new("L", (1024, 1024), 0); _hm.paste(255, (100, 100, 300, 300)); _hm.save(hm_png, "PNG")
        fd = commit_form("commitheal", with_mesh=False)
        fd._fields = [f for f in fd._fields if f[0].get("name") not in ("meta", "uvmask", "bakemask")]
        fd.add_field("meta", json.dumps(meta)); fd.add_field("uvmask", uvm_png.getvalue(), filename="mask.png", content_type="image/png")
        fd.add_field("bakemask", hm_png.getvalue(), filename="bakemask.png", content_type="image/png")
        r = await cl.post(f"/texpaint/commit/{SID}", data=fd); assert r.status == 200, await r.text()
        o = node.run(state, "brick", "flat style", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert "fix the stretched seam" in o[7] and "brick" not in o[7] and "flat style" not in o[7], o[7]
        t_h, c_h, rem_h, rep_h = bn.run(o[10], gen_uv, -1.0, 0.003, 1.0, 8)
        assert t_h[0][200, 200, 1] > 0.95, "heal run: generated pixels land in the heal area"
        assert np.allclose(t_h[0][512, 512], o[5][0][512, 512], atol=0.01), "heal run: the normal AI selection is left alone"
        print("Heal run (heal mask + heal prompt only) OK")

        # --- UV tiles (UV mode + grid): sequential (one tile per run, earlier tiles stay) and batch (all tiles, soft overlaps)
        def _tile_commit(cid, tile):
            m_ = json.load(open(f"{OUT}/meta.json")); m_["ref2"] = {"enabled": False}; m_["uv_mode"] = True; m_["tile_long"] = 512; m_["tile"] = tile
            f_ = commit_form(cid, with_mesh=False)
            f_._fields = [f for f in f_._fields if f[0].get("name") not in ("meta", "uvmask")]
            f_.add_field("meta", json.dumps(m_)); f_.add_field("uvmask", uvm_png.getvalue(), filename="mask.png", content_type="image/png")
            return f_
        base_tile = {"on": True, "cols": 2, "rows": 2, "overlap": 0.12}
        r = await cl.post(f"/texpaint/commit/{SID}", data=_tile_commit("committile0", {**base_tile, "mode": "seq", "index": 0, "done": []})); assert r.status == 200, await r.text()
        o = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert o[0].shape[0] == 1 and o[0].shape[1] == o[0].shape[2] == 512 and (o[8], o[9]) == (512, 512), (o[0].shape, o[8], o[9])
        assert tuple(o[-3:]) == (4, 0, 4), o[-3:]        # tile_count, tile_index, tile_total
        assert o[5][0].shape == (1024, 1024, 3), "uv_texture stays the full texture"
        gtile = np.zeros((1, 512, 512, 3), np.float32); gtile[..., 1] = 1.0
        t0, _c, _r, rep0 = bn.run(o[10], gtile, -1.0, 0.003, 1.0, 8)
        assert "Tiles: 1 tile(s) [0]" in rep0, rep0
        assert t0[0][300, 300, 1] > 0.95 and t0[0][300, 300, 0] < 0.05, "seq: tile 0 area painted"
        assert np.allclose(t0[0][700, 700], o[5][0][700, 700], atol=0.01), "seq: other tiles stay untouched"
        r = await cl.post(f"/texpaint/commit/{SID}", data=_tile_commit("committile3", {**base_tile, "mode": "seq", "index": 3, "done": [0, 1, 2]})); assert r.status == 200
        o3 = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert tuple(o3[-3:]) == (4, 3, 4)
        assert float(o3[2][0][16, 16]) < 0.05 and float(o3[2][0][250, 250]) > 0.9, "seq: the part painted by earlier tiles is not marked again"
        assert "continues" not in o3[7] and "flat UV texture map" in o3[7]
        r = await cl.post(f"/texpaint/commit/{SID}", data=_tile_commit("committileb", {**base_tile, "mode": "batch", "index": -1, "done": []})); assert r.status == 200
        ob = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert ob[0].shape == (4, 512, 512, 3) and ob[2].shape == (4, 512, 512) and tuple(ob[-3:]) == (4, -1, 4), (ob[0].shape, ob[-3:])
        gb = np.zeros((4, 512, 512, 3), np.float32); gb[..., 1] = 1.0
        tb_, cb_, rb_, repb = bn.run(ob[10], gb, -1.0, 0.003, 1.0, 8)
        for yy, xx in ((300, 300), (700, 700), (300, 700), (512, 512), (450, 600)):
            assert tb_[0][yy, xx, 1] > 0.95 and tb_[0][yy, xx, 0] < 0.05, ("batch: masked area fully painted, also across the tile overlaps", yy, xx, tb_[0][yy, xx])
        assert np.allclose(tb_[0][50, 50], ob[5][0][50, 50], atol=0.01), "batch: outside the mask unchanged"
        try:
            bn.run(ob[10], gb[:1], -1.0, 0.003, 1.0, 8); raise SystemExit("a short batch must be refused")
        except RuntimeError as e:
            assert "only 1 came back" in str(e), e
        print("UV tiles (grid, sequential, batch, outputs) OK")

        # --- UV mode + reference images projected onto the UV map ("Use reference images (by angle)")
        red = _io2_.BytesIO(); Image.new("RGB", (256, 256), (230, 20, 20)).save(red, "PNG")
        full = _io2_.BytesIO(); Image.new("L", (1024, 1024), 255).save(full, "PNG")
        def _uvref_commit(cid, uvref, ref_cams, tile=None):
            m_ = json.load(open(f"{OUT}/meta.json")); m_["uv_mode"] = True; m_["tile_long"] = 512
            m_["ref2"] = {"has": True, "enabled": True, "mode": "frame", "weight": 0, "angle": "front"}
            m_["refx"] = [{"has": False}] * 4; m_["uvref"] = uvref; m_["ref_cams"] = ref_cams; m_["tile"] = tile
            f_ = commit_form(cid, with_mesh=False)
            f_._fields = [f for f in f_._fields if f[0].get("name") not in ("meta", "uvmask")]
            f_.add_field("meta", json.dumps(m_)); f_.add_field("uvmask", full.getvalue(), filename="mask.png", content_type="image/png")
            f_.add_field("ref2", red.getvalue(), filename="ref2.png", content_type="image/png")
            f_.add_field("refdepth2", open(f"{OUT}/depth.png", "rb").read(), filename="refdepth2.png", content_type="image/png")
            return f_
        cam0 = json.load(open(f"{OUT}/meta.json"))["camera"]
        r = await cl.post(f"/texpaint/commit/{SID}", data=_uvref_commit("commituvr1", {"on": True, "fill": 0.6, "facing": 65}, [{"n": 2, "source": "placed view", "camera": cam0}])); assert r.status == 200, await r.text()
        o = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        redness = lambda a: (a[..., 0] - 0.5 * (a[..., 1] + a[..., 2]))
        ref_out = o[11][0]
        seen = redness(ref_out) > 0.5
        assert seen.mean() > 0.03, ("the projected reference must cover the part of the UV map the camera sees", float(seen.mean()))
        assert seen.mean() < 0.999, "areas no camera sees must stay uncovered (texture shows through)"
        assert redness(o[0][0])[seen].mean() > 0.15, "edit_image is pre-filled with the projected photo inside the marked area"
        assert "reference photos (front)" in o[7] and "Use image 2 as a" in o[7], o[7]
        assert np.allclose(o[1][0], o[5][0]), "UV mode: view_image still the UV texture"
        r = await cl.get(f"/texpaint/uvref/{SID}"); assert r.status == 200, await r.text()
        png = np.asarray(Image.open(_io2_.BytesIO(await r.read())).convert("RGBA")); assert png[..., 3].max() > 0
        assert "image 2" in r.headers.get("X-UVRef-Notes", ""), r.headers.get("X-UVRef-Notes")
        # references without a camera are skipped with a note, and nothing breaks
        r = await cl.post(f"/texpaint/commit/{SID}", data=_uvref_commit("commituvr2", {"on": True, "fill": 0.6, "facing": 65}, [])); assert r.status == 200
        o2 = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert "reference photos" not in o2[7] and np.allclose(o2[0][0], o[0][0]) is False
        # with tiles: one reference tile per tile image
        r = await cl.post(f"/texpaint/commit/{SID}", data=_uvref_commit("commituvr3", {"on": True, "fill": 0.6, "facing": 65}, [{"n": 2, "source": "placed view", "camera": cam0}],
                                                                       {"on": True, "cols": 2, "rows": 2, "overlap": 0.12, "mode": "batch", "index": -1, "done": []})); assert r.status == 200
        o3 = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
        assert o3[0].shape == o3[11].shape and o3[0].shape[0] >= 1, (o3[0].shape, o3[11].shape)
        print("UV references (projection by camera, pre-fill, tiles, preview route) OK")

        # --- mask source: the blue transition mask (bakemask.png) is used for uv_mask / the bake only when the capture says so
        import io as _io2
        sel_png = _io2.BytesIO(); _Im.new("L", (1024, 1024), 255).save(sel_png, "PNG")       # AI selection: everything
        tr_png = _io2.BytesIO(); _Im.new("L", (1024, 1024), 0).save(tr_png, "PNG")           # transition: nothing
        for src, expect in (("transition", 0.0), ("selection", 1.0)):
            meta = json.load(open(f"{OUT}/meta.json")); meta["ref2"] = {"enabled": False}; meta["mask_source"] = src
            fd = commit_form("commitmask" + src, with_mesh=False)
            fd._fields = [f for f in fd._fields if f[0].get("name") not in ("meta", "uvmask")]
            fd.add_field("meta", json.dumps(meta)); fd.add_field("uvmask", sel_png.getvalue(), filename="mask.png", content_type="image/png")
            fd.add_field("bakemask", tr_png.getvalue(), filename="bakemask.png", content_type="image/png")
            r = await cl.post(f"/texpaint/commit/{SID}", data=fd); assert r.status == 200, await r.text()
            o = node.run(state, "brick", "flat", True, "tint_color", "#ff00ff", 1.0, 6, 4)
            assert abs(float(o[6].mean()) - expect) < 0.01, (src, float(o[6].mean()))
        print("mask source (selection vs transition) OK")

        # --- presets: save as / conflict / overwrite / list / load / rename / delete / invalid names
        j = lambda d: {"Content-Type": "application/json"}
        r = await cl.post("/texpaint/preset/My Look (1)", data=json.dumps({"data": {"brush": {"size": 33}}}), headers=j(0)); assert r.status == 200, await r.text()
        r = await cl.post("/texpaint/preset/My Look (1)", data=json.dumps({"data": {"brush": {"size": 44}}}), headers=j(0)); assert r.status == 409, "existing preset must not be overwritten silently"
        r = await cl.post("/texpaint/preset/My Look (1)", data=json.dumps({"data": {"brush": {"size": 44}}, "overwrite": True}), headers=j(0)); assert r.status == 200
        r = await cl.get("/texpaint/presets"); lst = (await r.json())["presets"]; assert [x["name"] for x in lst] == ["My Look (1)"], lst
        r = await cl.get("/texpaint/preset/My Look (1)"); assert (await r.json())["data"]["brush"]["size"] == 44
        r = await cl.post("/texpaint/preset_rename", data=json.dumps({"from": "My Look (1)", "to": "Renamed"}), headers=j(0)); assert r.status == 200
        r = await cl.post("/texpaint/preset/Other", data=json.dumps({"data": {}}), headers=j(0)); assert r.status == 200
        r = await cl.post("/texpaint/preset_rename", data=json.dumps({"from": "Other", "to": "Renamed"}), headers=j(0)); assert r.status == 409
        for bad in ("..", ".hidden", "a%2Fb", "x" * 80):
            r = await cl.post("/texpaint/preset/" + bad, data=json.dumps({"data": {}}), headers=j(0)); assert r.status in (400, 404), (bad, r.status)
        r = await cl.post("/texpaint/preset/Big", data=json.dumps({"data": {"x": "y" * 600000}}), headers=j(0)); assert r.status == 413
        r = await cl.get("/texpaint/preset/Missing"); assert r.status == 404
        r = await cl.delete("/texpaint/preset/Renamed"); assert r.status == 200
        r = await cl.delete("/texpaint/preset/Other"); assert r.status == 200
        r = await cl.get("/texpaint/presets"); assert (await r.json())["presets"] == []
        print("preset routes OK")

        # --- v6.2.1: static-path preset endpoints (name in the JSON body) + api level
        r = await cl.get("/texpaint/ping"); assert (await r.json()).get("api", 0) >= 3
        r = await cl.post("/texpaint/preset_save", data=json.dumps({"name": "Static One", "data": {"brush": {"size": 12}}}), headers=j(0)); assert r.status == 200, await r.text()
        r = await cl.post("/texpaint/preset_save", data=json.dumps({"name": "Static One", "data": {"brush": {"size": 13}}}), headers=j(0)); assert r.status == 409
        r = await cl.post("/texpaint/preset_save", data=json.dumps({"name": "Static One", "data": {"brush": {"size": 14}}, "overwrite": True}), headers=j(0)); assert r.status == 200
        r = await cl.post("/texpaint/preset_load", data=json.dumps({"name": "Static One"}), headers=j(0)); assert (await r.json())["data"]["brush"]["size"] == 14
        r = await cl.post("/texpaint/preset_save", data=json.dumps({"name": "../x", "data": {}}), headers=j(0)); assert r.status == 400
        r = await cl.post("/texpaint/preset_save", data=json.dumps({"name": "", "data": {}}), headers=j(0)); assert r.status == 400
        r = await cl.post("/texpaint/preset_delete", data=json.dumps({"name": "Static One"}), headers=j(0)); assert r.status == 200
        r = await cl.post("/texpaint/preset_load", data=json.dumps({"name": "Static One"}), headers=j(0)); assert r.status == 404
        print("static preset routes OK")

        # --- project folders: browse / mkdir / save (zip + loose files), traversal and bad input
        import io as _io, zipfile as _zf
        proj_root = tempfile.mkdtemp(prefix="tp_proj_")
        r = await cl.get("/texpaint/project_dirs?path=" + proj_root); jj = await r.json(); assert r.status == 200 and jj["path"] == proj_root and jj["dirs"] == [] and jj["unrestricted"], jj
        r = await cl.post("/texpaint/project_mkdir", data=json.dumps({"path": proj_root, "name": "my saves"}), headers=j(0)); assert r.status == 200 and os.path.isdir(os.path.join(proj_root, "my saves"))
        r = await cl.post("/texpaint/project_mkdir", data=json.dumps({"path": proj_root, "name": "../evil"}), headers=j(0)); assert r.status == 400
        zb = _io.BytesIO()
        with _zf.ZipFile(zb, "w", _zf.ZIP_STORED) as z:
            z.writestr("project.json", "{}"); z.writestr("layers/L_abc.png", b"\x89PNG fake"); z.writestr("model/ship.obj", "v 0 0 0")
            z.writestr("../escape.png", b"x"); z.writestr("/abs.png", b"x"); z.writestr("run.exe", b"x"); z.writestr("a/../../up.png", b"x")
        def pf(name, dirp, extract, data=None):
            fd = FormData(); fd.add_field("file", data if data is not None else zb.getvalue(), filename="p.zip", content_type="application/zip")
            fd.add_field("name", name); fd.add_field("dir", dirp); fd.add_field("extract", "1" if extract else "0"); return fd
        target = os.path.join(proj_root, "my saves")
        r = await cl.post("/texpaint/project_save", data=pf("Ship v1", target, True)); jj = await r.json(); assert r.status == 200, jj
        assert os.path.isfile(os.path.join(target, "Ship v1.zip")) and os.path.isfile(os.path.join(target, "Ship v1", "layers", "L_abc.png")) and os.path.isfile(os.path.join(target, "Ship v1", "model", "ship.obj"))
        assert not os.path.exists(os.path.join(target, "escape.png")) and not os.path.exists(os.path.join(proj_root, "escape.png")) and not os.path.exists(os.path.join(target, "Ship v1", "run.exe")), "unsafe zip entries must be skipped"
        assert not os.path.exists(os.path.join(target, "up.png")) and not os.path.exists(os.path.join(proj_root, "up.png")) and not os.path.exists("/abs.png")
        r = await cl.post("/texpaint/project_save", data=pf("Ship v1", target, False)); jj = await r.json(); assert r.status == 200 and jj["path"].endswith("Ship v1_2.zip"), jj   # never overwrites
        r = await cl.post("/texpaint/project_save", data=pf("bad/name", target, False)); assert r.status == 400
        r = await cl.post("/texpaint/project_save", data=pf("Notzip", target, False, data=b"hello")); assert r.status == 400
        fresh = os.path.join(proj_root, "new", "deep")
        r = await cl.post("/texpaint/project_save", data=pf("Deep", fresh, False)); assert r.status == 200 and os.path.isfile(os.path.join(fresh, "Deep.zip"))
        r = await cl.get("/texpaint/project_dirs?path=" + os.path.join(proj_root, "not", "there")); jj = await r.json(); assert r.status == 200 and jj["path"] == proj_root, jj
        # remote clients (not loopback) may only use folders inside ComfyUI's output folder
        class _Rq:  # minimal stand-in for aiohttp's request
            def __init__(self, remote): self.remote = remote
        os.environ.pop("TEXPAINT_ALLOW_ANY_DIR", None)
        try:
            tp_server._resolve_dir(_Rq("10.1.2.3"), "/etc", create=False); raise SystemExit("remote access to /etc accepted")
        except PermissionError:
            pass
        ok_dir = tp_server._resolve_dir(_Rq("10.1.2.3"), os.path.join(C.output_root(), "texpaint_projects", "x"), create=False)
        assert ok_dir.startswith(os.path.abspath(C.output_root()))
        try:
            tp_server._resolve_dir(_Rq("10.1.2.3"), os.path.join(C.output_root(), "..", "outside"), create=False); raise SystemExit("remote traversal accepted")
        except PermissionError:
            pass
        assert tp_server._resolve_dir(_Rq("127.0.0.1"), "/tmp", create=False) == "/tmp"
        print("project folder routes OK")

        # --- layers / reference image 2 / clone / save_output
        os.environ["TEXPAINT_OUT"] = tempfile.mkdtemp(prefix="tp_out_")
        png = open(f"{OUT}/view.png", "rb").read()
        fd = FormData()
        fd.add_field("ref2", png, filename="ref2.png", content_type="image/png")
        fd.add_field("L_0123456789ab.png", png, filename="L_0123456789ab.png", content_type="image/png")
        fd.add_field("M_0123456789ab.png", png, filename="M_0123456789ab.png", content_type="image/png")
        fd.add_field("layers", json.dumps({"stack": [{"id": 1, "pix": "0123456789ab", "mask": "0123456789ab"}]}))
        r = await cl.post(f"/texpaint/put/{SID}", data=fd); assert r.status == 200, await r.text()
        sd = C.session_dir(SID)
        for f in ("ref2.png", "L_0123456789ab.png", "M_0123456789ab.png", "layers.json"):
            assert os.path.isfile(os.path.join(sd, f)), f
        r = await cl.get(f"/texpaint/session/{SID}/L_0123456789ab.png"); assert r.status == 200
        # layer files / AI mask of OTHER objects (multi-object model) stay referenced through "others"
        fd = FormData()
        for nm in ("L_aaaaaaaaaaaa.png", "L_bbbbbbbbbbbb.png", "M_cccccccccccc.png", "M_dddddddddddd.png"):
            fd.add_field(nm, png, filename=nm, content_type="image/png")
        fd.add_field("layers", json.dumps({"stack": [{"pix": "aaaaaaaaaaaa"}],
                                           "others": {"1": {"stack": {"stack": [{"pix": "bbbbbbbbbbbb", "mask": "cccccccccccc"}]}, "maskUid": "dddddddddddd"}}}))
        r = await cl.post(f"/texpaint/put/{SID}", data=fd); assert r.status == 200, await r.text()
        for f in ("L_aaaaaaaaaaaa.png", "L_bbbbbbbbbbbb.png", "M_cccccccccccc.png", "M_dddddddddddd.png"):
            assert os.path.isfile(os.path.join(sd, f)), f"other-object file {f} was removed"
        assert not os.path.isfile(os.path.join(sd, "L_0123456789ab.png")), "unreferenced file kept"
        # unreferenced layer files are removed once a new layers list arrives
        fd = FormData(); fd.add_field("layers", json.dumps({"stack": []}))
        r = await cl.post(f"/texpaint/put/{SID}", data=fd); assert r.status == 200
        assert not os.path.isfile(os.path.join(sd, "L_0123456789ab.png"))
        r = await cl.post("/texpaint/clone", json={"src": SID, "dst": "tp_clone_session_1"}); j = await r.json()
        assert r.status == 200 and "ref2.png" in j["copied"], j
        for name, ok in [("tex.png", True), ("m.glb", True), ("../x.png", False), ("bad.exe", False), ("a b.zip", True)]:
            fd = FormData(); fd.add_field("file", b"data123", filename=name, content_type="application/octet-stream"); fd.add_field("name", name)
            r = await cl.post("/texpaint/save_output", data=fd)
            assert (r.status == 200) == ok or name == "../x.png", (name, r.status)
        fd = FormData(); fd.add_field("file", b"data123", filename="tex.png", content_type="image/png")
        r = await cl.post("/texpaint/save_output", data=fd); j = await r.json()
        assert r.status == 200 and j["name"] == "tex_2.png", j   # de-duplicated
        # --- storage info + cleanup
        r = await cl.get("/texpaint/storage"); j = await r.json()
        assert r.status == 200 and j["sessions"] >= 2 and j["session_bytes"] > 0, j
        r = await cl.post("/texpaint/cleanup", json={"days": -1}); assert r.status == 400
        r = await cl.post("/texpaint/cleanup", json={"days": 7}); j = await r.json()
        assert r.status == 200 and j["removed"] == 0, j        # nothing is 7 days old
        sdir_clone = C.session_dir("tp_clone_session_1")
        r = await cl.post("/texpaint/cleanup", json={"days": 0, "keep": [SID]}); j = await r.json()
        assert r.status == 200 and j["removed"] >= 1 and not os.path.isdir(sdir_clone) and os.path.isdir(C.session_dir(SID)), j
    print("ALL NODE / ROUTE CHECKS PASSED")


asyncio.run(main())
