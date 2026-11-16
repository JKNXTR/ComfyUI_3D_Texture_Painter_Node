"""HTTP routes used by the web extension (model upload, session storage). Registered on import."""
import hashlib
import io
import json
import os
import re
import shutil
import time
import uuid

from aiohttp import web
from server import PromptServer

from . import tp_common as C
from . import tp_core as core
from . import tp_uvref
from . import tp_unwrap

routes = PromptServer.instance.routes
VERSION = "1.0.0"
API_LEVEL = 8   # bumped when routes are added; the web part compares it to detect a ComfyUI that was not restarted after an update

PNG_MAGIC = b"\x89PNG\r\n\x1a\n"
# multipart field -> file inside the session folder
PASS_PARTS = {"view": "view.png", "viewmask": "viewmask.png", "depth": "depth.png", "normal": "normal.png", "bakemask": "bakemask.png",
              **{f"viewrgn{i}": f"viewrgn{i}.png" for i in range(1, 5)},
              **{f"refdepth{i}": f"refdepth{i}.png" for i in range(2, 7)}}   # refdepthN: depth of the model from the camera reference image N was placed from   # viewrgnN: view region of reference N+2 seen from the capture camera
STATE_PARTS = {"uvmask": "mask.png", "texture": "texture.png", "ref2": "ref2.png", "prevconf": "prevconf.png", "uvtrans": "trans.png", "uvheal": "heal.png", "ref3": "ref3.png", "ref4": "ref4.png", "ref5": "ref5.png", "ref6": "ref6.png",
               **{f"uvregion{i}": f"region{i}.png" for i in range(1, 5)}}   # painted view regions (UV space), autosave
MODEL_NAME_RE = re.compile(r"^[A-Za-z0-9._ -]{1,140}$")


def _json(data, status=200):
    return web.json_response(data, status=status, headers={"Cache-Control": "no-store"})


def _field_bytes(post, key):
    f = post.get(key)
    if f is None:
        return None
    if not hasattr(f, "file"):
        raise ValueError(f"Field '{key}' must be a file upload")
    return f.file.read()


def _store_parts(sdir, post, parts):
    written = []
    for key, fname in parts.items():
        data = _field_bytes(post, key)
        if data is None:
            continue
        if not data.startswith(PNG_MAGIC):
            raise ValueError(f"Field '{key}' is not a PNG image")
        C.atomic_write(os.path.join(sdir, fname), data)
        written.append(fname)
    return written


def _store_layers(sdir, post):
    """Layer pixel / mask PNGs (L_<id>.png, M_<id>.png) + the layer list. Unreferenced layer files are removed."""
    written = []
    for key in list(post.keys()):
        if not C.LAYER_FILE_RE.match(key):
            continue
        data = _field_bytes(post, key)
        if data is None:
            continue
        if not data.startswith(PNG_MAGIC):
            raise ValueError(f"Field '{key}' is not a PNG image")
        C.atomic_write(os.path.join(sdir, key), data)
        written.append(key)
    lj = post.get("layers")
    if isinstance(lj, str):
        obj = json.loads(lj)
        refs = set()
        def _collect(stack_obj):
            for L in (stack_obj or {}).get("stack", []):
                for k in ("pix", "mask"):
                    if L.get(k):
                        refs.add(("L_" if k == "pix" else "M_") + str(L[k]) + ".png")

        _collect(obj)

        def _pbr(ids):  # PBR map files P_<id>_<map>.png of one object
            for k, v in (ids or {}).items():
                if v and re.match(r"^[a-z]{2,10}$", str(k)) and re.match(r"^[a-f0-9]{8,16}$", str(v)):
                    refs.add(f"P_{v}_{k}.png")

        _pbr(obj.get("pbr"))
        # other objects of a multi-object model keep their own layer stacks and AI mask (M_<maskUid>.png)
        for other in (obj.get("others") or {}).values():
            _collect(other.get("stack"))
            _pbr(other.get("pbr"))
            if other.get("maskUid"):
                refs.add("M_" + str(other["maskUid"]) + ".png")
        # keep every file that a stored undo-able state might still need? No: the editor only references the current stack.
        for f in os.listdir(sdir):
            if C.LAYER_FILE_RE.match(f) and f not in refs:
                try:
                    os.remove(os.path.join(sdir, f))
                except OSError:
                    pass
        C.atomic_write(os.path.join(sdir, "layers.json"), lj.encode("utf-8"))
        written.append("layers.json")
    return written


def _store_mesh(sdir, post):
    data = _field_bytes(post, "mesh")
    if data is None:
        return False
    core.read_mesh_bin(data)  # validates the container before it is stored
    C.atomic_write(os.path.join(sdir, "mesh.bin"), data)
    return True


@routes.get("/texpaint/ping")
async def ping(request):
    return _json({"ok": True, "version": VERSION, "api": API_LEVEL, "dir": C.base_dir(), "code": os.path.dirname(os.path.abspath(__file__))})


@routes.post("/texpaint/upload_model")
async def upload_model(request):
    try:
        post = await request.post()
        f = post.get("file")
        if f is None or not hasattr(f, "file"):
            return _json({"error": "No file in the request"}, 400)
        stem, ext = C.safe_model_name(getattr(f, "filename", "model"))
        data = f.file.read()
        if not data:
            return _json({"error": "The uploaded file is empty"}, 400)
        name = f"{stem}_{hashlib.sha1(data).hexdigest()[:8]}{ext}"
        path = os.path.join(C.models_dir(), name)
        if not os.path.exists(path):
            C.atomic_write(path, data)
        return _json({"name": name, "size": len(data)})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("upload_model failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.get("/texpaint/models")
async def list_models(request):
    try:
        d = C.models_dir()
        items = [(os.path.getmtime(os.path.join(d, n)), n) for n in os.listdir(d) if n.lower().endswith(C.MODEL_EXT)]
        items.sort(reverse=True)
        return _json({"models": [n for _, n in items[:60]]})
    except Exception as e:
        C.log_exc("list_models failed")
        return _json({"error": str(e)}, 500)


@routes.get("/texpaint/model/{name}")
async def get_model(request):
    name = request.match_info["name"]
    if not MODEL_NAME_RE.match(name) or not name.lower().endswith(C.MODEL_EXT):
        return _json({"error": "bad model name"}, 400)
    path = os.path.join(C.models_dir(), name)
    if not os.path.isfile(path):
        return _json({"error": "model not found"}, 404)
    return web.FileResponse(path, headers={"Cache-Control": "no-store"})


@routes.post("/texpaint/put/{sid}")
async def put_session(request):
    """Autosave: mask / texture / mesh / ui state. Never touches commit.json."""
    try:
        sdir = C.session_dir(request.match_info["sid"], create=True)
        post = await request.post()
        written = _store_parts(sdir, post, STATE_PARTS)
        written += _store_layers(sdir, post)
        if _store_mesh(sdir, post):
            written.append("mesh.bin")
        st = post.get("state")
        if isinstance(st, str):
            json.loads(st)
            C.atomic_write(os.path.join(sdir, "state.json"), st.encode("utf-8"))
            written.append("state.json")
        return _json({"ok": True, "written": written})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("put_session failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.post("/texpaint/commit/{sid}")
async def commit_session(request):
    """Stores the passes captured by the editor and stamps commit.json (written last)."""
    try:
        sid = request.match_info["sid"]
        sdir = C.session_dir(sid, create=True)
        post = await request.post()
        written = _store_parts(sdir, post, PASS_PARTS) + _store_parts(sdir, post, STATE_PARTS)
        written += _store_layers(sdir, post)
        if _store_mesh(sdir, post):
            written.append("mesh.bin")
        meta = post.get("meta")
        if not isinstance(meta, str):
            return _json({"error": "missing 'meta' field"}, 400)
        meta_obj = json.loads(meta)
        for k in ("camera", "view_size", "mesh_hash"):
            if k not in meta_obj:
                return _json({"error": f"meta is missing '{k}'"}, 400)
        C.atomic_write(os.path.join(sdir, "camera.json"), meta.encode("utf-8"))
        written.append("camera.json")
        cid = post.get("commit_id")
        cid = cid if isinstance(cid, str) and C.SID_RE.match(cid) else uuid.uuid4().hex[:16]
        C.atomic_write(os.path.join(sdir, "commit.json"), json.dumps({"commit_id": cid, "time": time.time()}).encode("utf-8"))
        return _json({"ok": True, "commit_id": cid, "written": written})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("commit_session failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.get("/texpaint/session/{sid}/{fname}")
async def get_session_file(request):
    try:
        sdir = C.session_dir(request.match_info["sid"])
    except ValueError:
        return _json({"error": "bad session id"}, 400)
    fname = request.match_info["fname"]
    if fname not in C.SESSION_FILES and not C.RESULT_RE.match(fname) and not C.LAYER_FILE_RE.match(fname):
        return _json({"error": "file not allowed"}, 400)
    path = os.path.join(sdir, fname)
    if not os.path.isfile(path):
        return _json({"error": "not found"}, 404)
    return web.FileResponse(path, headers={"Cache-Control": "no-store"})


@routes.get("/texpaint/uvref/{sid}")
async def uvref_preview(request):
    """Projects the reference images of the last capture onto the UV layout (preview of what 'Use reference images' sends). PNG RGBA: colour + confidence."""
    try:
        sdir = C.session_dir(request.match_info["sid"])
    except ValueError:
        return _json({"error": "bad session id"}, 400)
    try:
        import asyncio
        import numpy as np
        from PIL import Image
        meta = C.read_json(os.path.join(sdir, "camera.json"), None)
        if not meta or not os.path.isfile(os.path.join(sdir, "mesh.bin")):
            return _json({"error": "no capture yet - press Sync first"}, 404)
        tw, th = (meta.get("tex_size") or [1024, 1024])[:2]
        k = min(1.0, 1024.0 / max(tw, th))
        W, H = max(16, int(tw * k)), max(16, int(th * k))
        cfg = meta.get("uvref") or {}
        facing = float(request.query.get("facing", cfg.get("facing", 65.0)))
        with open(os.path.join(sdir, "mesh.bin"), "rb") as f:
            mesh = core.read_mesh_bin(f.read())
        res = await asyncio.to_thread(tp_uvref.project, mesh, sdir, meta, W, H, facing, 0.004)
        rgba = np.dstack([np.clip(res["color"], 0, 255).astype(np.uint8), (np.clip(res["conf"], 0, 1) * 255).astype(np.uint8)])
        buf = io.BytesIO()
        Image.fromarray(rgba, "RGBA").save(buf, "PNG")
        notes = json.dumps(res["notes"], ensure_ascii=True)
        return web.Response(body=buf.getvalue(), content_type="image/png", headers={"Cache-Control": "no-store", "X-UVRef-Notes": notes})
    except Exception as e:
        C.log_exc("uvref preview failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.post("/texpaint/clone")
async def clone_session(request):
    """Copies the stored files of one session into another (used when a node is duplicated)."""
    try:
        body = await request.json()
        src = C.session_dir(body.get("src"))
        dst = C.session_dir(body.get("dst"), create=True)
        copied = []
        names = ["mesh.bin", "texture.png", "mask.png", "trans.png", "heal.png", "ref2.png", "ref3.png", "ref4.png", "ref5.png", "ref6.png", "layers.json", "state.json"] + [f"region{i}.png" for i in range(1, 5)]
        names += [f for f in os.listdir(src) if C.LAYER_FILE_RE.match(f)] if os.path.isdir(src) else []
        for fname in names:
            sp = os.path.join(src, fname)
            if os.path.isfile(sp):
                with open(sp, "rb") as f:
                    C.atomic_write(os.path.join(dst, fname), f.read())
                copied.append(fname)
        return _json({"ok": True, "copied": copied})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("clone_session failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


def _dir_stats(path):
    size, newest = 0, 0.0
    for root, _d, files in os.walk(path):
        for f in files:
            try:
                st = os.stat(os.path.join(root, f))
                size += st.st_size
                newest = max(newest, st.st_mtime)
            except OSError:
                pass
    return size, newest


@routes.get("/texpaint/storage")
async def storage_info(request):
    """How much disk the sessions and uploaded models use (shown in the Export panel)."""
    try:
        sroot = os.path.join(C.base_dir(), "sessions")
        sessions, total, oldest = 0, 0, 0.0
        now = time.time()
        if os.path.isdir(sroot):
            for n in os.listdir(sroot):
                p = os.path.join(sroot, n)
                if os.path.isdir(p):
                    sz, newest = _dir_stats(p)
                    sessions += 1
                    total += sz
                    oldest = max(oldest, (now - newest) / 86400.0)
        msz, _ = _dir_stats(C.models_dir())
        return _json({"sessions": sessions, "session_bytes": total, "model_bytes": msz, "oldest_days": round(oldest, 1)})
    except Exception as e:
        C.log_exc("storage_info failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.post("/texpaint/cleanup")
async def cleanup_sessions(request):
    """Deletes sessions that were not touched for `days` days. Sessions listed in `keep` (open nodes) are never removed."""
    try:
        body = await request.json()
        days = float(body.get("days", 7))
        if not (0 <= days <= 3650):
            return _json({"error": "days must be between 0 and 3650"}, 400)
        keep = {k for k in (body.get("keep") or []) if isinstance(k, str)}
        sroot = os.path.join(C.base_dir(), "sessions")
        removed, freed = 0, 0
        now = time.time()
        if os.path.isdir(sroot):
            for n in os.listdir(sroot):
                p = os.path.join(sroot, n)
                if n in keep or not os.path.isdir(p) or not C.SID_RE.match(n):
                    continue
                sz, newest = _dir_stats(p)
                if (now - newest) / 86400.0 >= days:
                    shutil.rmtree(p, ignore_errors=True)
                    removed += 1
                    freed += sz
        return _json({"ok": True, "removed": removed, "freed_bytes": freed})
    except (TypeError, ValueError) as e:
        return _json({"error": f"bad request: {e}"}, 400)
    except Exception as e:
        C.log_exc("cleanup_sessions failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


EXPORT_NAME_RE = re.compile(r"^[A-Za-z0-9._ -]{1,120}$")
EXPORT_EXT = (".png", ".glb", ".zip", ".obj")


@routes.post("/texpaint/save_output")
async def save_output(request):
    """Stores an exported file (UV map PNG, GLB, OBJ zip) in ComfyUI/output/texpaint/."""
    try:
        post = await request.post()
        f = post.get("file")
        if f is None or not hasattr(f, "file"):
            return _json({"error": "No file in the request"}, 400)
        name = os.path.basename(str(post.get("name") or getattr(f, "filename", "export")))
        stem, ext = os.path.splitext(name)
        if ext.lower() not in EXPORT_EXT or not EXPORT_NAME_RE.match(name):
            return _json({"error": f"Bad export name or type: {name!r}"}, 400)
        data = f.file.read()
        if not data:
            return _json({"error": "The exported file is empty"}, 400)
        d = os.path.join(C.output_root(), "texpaint")
        os.makedirs(d, exist_ok=True)
        path = os.path.join(d, name)
        n = 1
        while os.path.exists(path):
            n += 1
            path = os.path.join(d, f"{stem}_{n}{ext.lower()}")
        C.atomic_write(path, data)
        return _json({"ok": True, "path": path, "name": os.path.basename(path), "size": len(data)})
    except Exception as e:
        C.log_exc("save_output failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


# -------------------------------------------------------------------------------------------
# Presets: named settings snapshots shared by every workflow / node (input/texpaint/presets/<name>.json)
# -------------------------------------------------------------------------------------------
PRESET_NAME_RE = re.compile(r"^[\w][\w .\-()+]{0,59}$", re.UNICODE)
PRESET_MAX_BYTES = 512 * 1024


def _presets_dir():
    d = os.path.join(C.base_dir(), "presets")
    os.makedirs(d, exist_ok=True)
    return d


def _preset_path(name):
    if not isinstance(name, str) or not PRESET_NAME_RE.match(name.strip()) or name.strip().strip(".") == "":
        raise ValueError("Preset names may contain letters, digits, spaces and . - _ ( ) + (1-60 characters).")
    return os.path.join(_presets_dir(), name.strip() + ".json")


@routes.get("/texpaint/presets")
async def presets_list(request):
    try:
        out = []
        for fn in sorted(os.listdir(_presets_dir()), key=str.lower):
            if fn.endswith(".json"):
                p = os.path.join(_presets_dir(), fn)
                out.append({"name": fn[:-5], "modified": os.path.getmtime(p), "bytes": os.path.getsize(p)})
        return _json({"presets": out})
    except Exception as e:
        C.log_exc("presets_list failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.get("/texpaint/preset/{name}")
async def preset_get(request):
    try:
        p = _preset_path(request.match_info["name"])
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    if not os.path.isfile(p):
        return _json({"error": "No such preset."}, 404)
    return _json(C.read_json(p, {}))


@routes.post("/texpaint/preset/{name}")
async def preset_put(request):
    """Body: {"data": {...settings...}, "overwrite": bool}. 409 when the preset exists and overwrite is not set."""
    try:
        p = _preset_path(request.match_info["name"])
        body = await request.json()
        data = body.get("data")
        if not isinstance(data, dict):
            return _json({"error": "data must be an object"}, 400)
        raw = json.dumps({"name": request.match_info["name"].strip(), "saved": time.time(), "data": data}).encode("utf-8")
        if len(raw) > PRESET_MAX_BYTES:
            return _json({"error": "Preset is too large."}, 413)
        if os.path.isfile(p) and not body.get("overwrite"):
            return _json({"error": "A preset with this name already exists.", "exists": True}, 409)
        C.atomic_write(p, raw)
        return _json({"ok": True})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("preset_put failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.delete("/texpaint/preset/{name}")
async def preset_delete(request):
    try:
        p = _preset_path(request.match_info["name"])
        if not os.path.isfile(p):
            return _json({"error": "No such preset."}, 404)
        os.remove(p)
        return _json({"ok": True})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("preset_delete failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.post("/texpaint/preset_save")
async def preset_save(request):
    """Same as POST /texpaint/preset/{name}, but with a fixed path (the name is in the JSON body)."""
    try:
        body = await request.json()
        p = _preset_path(body.get("name"))
        data = body.get("data")
        if not isinstance(data, dict):
            return _json({"error": "data must be an object"}, 400)
        raw = json.dumps({"name": body["name"].strip(), "saved": time.time(), "data": data}).encode("utf-8")
        if len(raw) > PRESET_MAX_BYTES:
            return _json({"error": "Preset is too large."}, 413)
        if os.path.isfile(p) and not body.get("overwrite"):
            return _json({"error": "A preset with this name already exists.", "exists": True}, 409)
        C.atomic_write(p, raw)
        return _json({"ok": True})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("preset_save failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.post("/texpaint/preset_load")
async def preset_load(request):
    try:
        body = await request.json()
        p = _preset_path(body.get("name"))
        if not os.path.isfile(p):
            return _json({"error": "No such preset."}, 404)
        return _json(C.read_json(p, {}))
    except ValueError as e:
        return _json({"error": str(e)}, 400)


@routes.post("/texpaint/preset_delete")
async def preset_delete_post(request):
    try:
        body = await request.json()
        p = _preset_path(body.get("name"))
        if not os.path.isfile(p):
            return _json({"error": "No such preset."}, 404)
        os.remove(p)
        return _json({"ok": True})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("preset_delete_post failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.post("/texpaint/preset_rename")
async def preset_rename(request):
    try:
        body = await request.json()
        src, dst = _preset_path(body.get("from")), _preset_path(body.get("to"))
        if not os.path.isfile(src):
            return _json({"error": "No such preset."}, 404)
        if os.path.isfile(dst) and os.path.normcase(src) != os.path.normcase(dst):
            return _json({"error": "A preset with the new name already exists.", "exists": True}, 409)
        d = C.read_json(src, {})
        d["name"] = body["to"].strip()
        C.atomic_write(dst, json.dumps(d).encode("utf-8"))
        if os.path.normcase(src) != os.path.normcase(dst):
            os.remove(src)
        return _json({"ok": True})
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("preset_rename failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


# -------------------------------------------------------------------------------------------
# Project folders: "Save project as..." writes the project ZIP (and optionally the loose files) into a folder on the ComfyUI machine.
# Anywhere on disk is allowed for requests from this computer (loopback) or when TEXPAINT_ALLOW_ANY_DIR=1 is set; remote clients are
# limited to folders inside ComfyUI's output directory.
# -------------------------------------------------------------------------------------------
import zipfile  # noqa: E402
import io  # noqa: E402

PROJ_NAME_RE = re.compile(r"^[\w][\w .\-()+]{0,79}$", re.UNICODE)
PROJ_LOOSE_EXT = (".png", ".json", ".obj", ".mtl", ".glb", ".gltf", ".fbx", ".bin", ".jpg", ".jpeg")
PROJ_LOOSE_MAX = 600 * 1024 * 1024


def _default_project_dir():
    return os.path.join(C.output_root(), "texpaint_projects")


def _is_local(request):
    return (request.remote or "") in ("127.0.0.1", "::1", "localhost") or os.environ.get("TEXPAINT_ALLOW_ANY_DIR") == "1"


def _resolve_dir(request, raw, create=False):
    raw = (raw or "").strip()
    if not raw:
        raw = _default_project_dir()
    if "\x00" in raw:
        raise ValueError("Bad folder path.")
    d = os.path.abspath(os.path.expanduser(raw))
    if not _is_local(request):
        root = os.path.abspath(C.output_root())
        if os.path.commonpath([root, d]) != root:
            raise PermissionError("Remote clients can only use folders inside ComfyUI's output folder (" + root + "). "
                                  "Set TEXPAINT_ALLOW_ANY_DIR=1 to allow other folders.")
    if os.path.exists(d) and not os.path.isdir(d):
        raise ValueError("That path is a file, not a folder.")
    if create:
        os.makedirs(d, exist_ok=True)
    return d


@routes.get("/texpaint/project_dirs")
async def project_dirs(request):
    """Lists the sub folders of a folder (for the folder browser). Query: path (empty = default project folder)."""
    try:
        d = _resolve_dir(request, request.query.get("path"))
        while d and not os.path.isdir(d):      # not created yet: show the nearest existing parent
            nd = os.path.dirname(d)
            if nd == d:
                break
            d = nd
        subs = []
        try:
            for e in sorted(os.listdir(d), key=str.lower):
                if not e.startswith(".") and os.path.isdir(os.path.join(d, e)):
                    subs.append(e)
        except PermissionError:
            pass
        parent = os.path.dirname(d)
        if not _is_local(request):
            root = os.path.abspath(C.output_root())
            if os.path.commonpath([root, parent]) != root:
                parent = ""
        return _json({"path": d, "parent": parent if parent != d else "", "dirs": subs[:500], "default": _default_project_dir(),
                      "unrestricted": _is_local(request)})
    except PermissionError as e:
        return _json({"error": str(e)}, 403)
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("project_dirs failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.post("/texpaint/project_mkdir")
async def project_mkdir(request):
    try:
        body = await request.json()
        parent = _resolve_dir(request, body.get("path"), create=True)
        name = str(body.get("name") or "").strip()
        if not PROJ_NAME_RE.match(name):
            return _json({"error": "Folder names may contain letters, digits, spaces and . - _ ( ) +"}, 400)
        d = _resolve_dir(request, os.path.join(parent, name), create=True)
        return _json({"ok": True, "path": d})
    except PermissionError as e:
        return _json({"error": str(e)}, 403)
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("project_mkdir failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


@routes.post("/texpaint/project_save")
async def project_save(request):
    """multipart: file (the project ZIP), name, dir (optional), extract ('1' = also write the loose files into <dir>/<name>/)."""
    try:
        post = await request.post()
        f = post.get("file")
        if f is None or not hasattr(f, "file"):
            return _json({"error": "No file in the request"}, 400)
        name = str(post.get("name") or "project").strip()
        name = re.sub(r"\.zip$", "", name, flags=re.I)
        if not PROJ_NAME_RE.match(name):
            return _json({"error": "Project names may contain letters, digits, spaces and . - _ ( ) + (1-80 characters)."}, 400)
        d = _resolve_dir(request, post.get("dir"), create=True)
        data = f.file.read()
        if not data.startswith(b"PK"):
            return _json({"error": "The file is not a ZIP."}, 400)
        path = os.path.join(d, name + ".zip")
        n = 1
        while os.path.exists(path):
            n += 1
            path = os.path.join(d, f"{name}_{n}.zip")
        C.atomic_write(path, data)
        written = [os.path.basename(path)]
        loose_dir = None
        if str(post.get("extract") or "") == "1":
            loose_dir = os.path.join(d, os.path.splitext(os.path.basename(path))[0])
            os.makedirs(loose_dir, exist_ok=True)
            total = 0
            with zipfile.ZipFile(io.BytesIO(data)) as zf:
                for info in zf.infolist():
                    rel = info.filename.replace("\\", "/")
                    parts = [x for x in rel.split("/") if x]
                    if info.is_dir() or not parts or any(x in (".", "..") for x in parts) or rel.startswith("/") or ":" in parts[0]:
                        continue
                    if not rel.lower().endswith(PROJ_LOOSE_EXT):
                        continue
                    total += info.file_size
                    if total > PROJ_LOOSE_MAX:
                        return _json({"error": "Loose files exceed the size limit; the ZIP itself was saved.", "path": path}, 413)
                    out = os.path.join(loose_dir, *parts)
                    os.makedirs(os.path.dirname(out), exist_ok=True)
                    C.atomic_write(out, zf.read(info))
                    written.append(os.path.relpath(out, d))
        return _json({"ok": True, "path": path, "dir": d, "loose_dir": loose_dir, "files": len(written), "size": len(data)})
    except PermissionError as e:
        return _json({"error": str(e)}, 403)
    except zipfile.BadZipFile:
        return _json({"error": "The ZIP is damaged."}, 400)
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("project_save failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)


# ---- unwrap + atlas: objects (positions / indices / uvs / texture each) -> one xatlas atlas with every texture transferred
@routes.post("/texpaint/unwrap")
async def unwrap_route(request):
    try:
        import asyncio
        import numpy as np
        from PIL import Image
        post = await request.post()
        meta = json.loads(post.get("meta") or "{}")
        objs, texcache = [], {}
        for i, o in enumerate(meta.get("objects") or []):
            pos = _field_bytes(post, f"pos{i}"); idx = _field_bytes(post, f"idx{i}")
            if pos is None or idx is None:
                raise ValueError(f"object {i}: missing geometry")
            pos = np.frombuffer(pos, "<f4").reshape(-1, 3).copy(); idx = np.frombuffer(idx, "<u4").reshape(-1, 3).copy()
            if idx.size == 0 or int(idx.max()) >= len(pos):
                raise ValueError(f"object {i} ({o.get('name')}): empty or invalid triangle list")
            uvb = _field_bytes(post, f"uv{i}"); uv = np.frombuffer(uvb, "<f4").reshape(-1, 2).copy() if uvb else None
            if uv is not None and len(uv) != len(pos):
                raise ValueError(f"object {i}: uv count does not match positions")
            ti = o.get("tex", -1)
            if isinstance(ti, int) and ti >= 0:
                if ti not in texcache:
                    tb = _field_bytes(post, f"tex{ti}")
                    texcache[ti] = np.asarray(Image.open(io.BytesIO(tb)).convert("RGB")) if tb else None
                tex = texcache[ti]
            else:
                tex = None
            objs.append(dict(name=str(o.get("name") or f"Object {i + 1}")[:80], positions=pos, indices=idx, uvs=uv, tex=tex))
        if not objs:
            raise ValueError("no objects were sent")
        op = meta.get("options") or {}
        fill = op.get("fill") or [200, 200, 200]
        loop = asyncio.get_running_loop()
        res = await loop.run_in_executor(None, lambda: tp_unwrap.unwrap_atlas(
            objs, size=op.get("size", 2048), mode=op.get("mode", "unwrap"), quality=op.get("quality", "balanced"),
            padding=op.get("padding", 8), fill=tuple(int(v) for v in fill[:3])))
        return web.Response(body=tp_unwrap.pack_result(res), content_type="application/octet-stream", headers={"Cache-Control": "no-store"})
    except RuntimeError as e:
        return _json({"error": str(e)}, 501 if "not installed" in str(e) else 500)
    except ValueError as e:
        return _json({"error": str(e)}, 400)
    except Exception as e:
        C.log_exc("unwrap failed")
        return _json({"error": f"{type(e).__name__}: {e}"}, 500)
