"""Shared helpers: paths, session folders, small IO utilities. No ComfyUI-only imports at module level."""
import json
import logging
import os
import re
import tempfile
import traceback

LOG = logging.getLogger("TexturePainterAI")
PREFIX = "[TexturePainterAI]"

SID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
RESULT_RE = re.compile(r"^(result|remaining|layer)_[A-Za-z0-9_]{6,48}\.png$")
# layer pixels (L_) and layer masks (M_) written by the editor; names are content ids so files never change
LAYER_FILE_RE = re.compile(r"^[LMP]_[a-f0-9]{8,16}(?:_[a-z]{2,10})?\.png$")
SESSION_FILES = {
    "mesh.bin", "texture.png", "mask.png", "view.png", "viewmask.png", "depth.png", "normal.png",
    "camera.json", "commit.json", "state.json", "ref2.png", "layers.json", "prevconf.png", "trans.png", "heal.png", "ref3.png", "ref4.png", "ref5.png", "ref6.png", "bakemask.png",
    "viewrgn1.png", "viewrgn2.png", "viewrgn3.png", "viewrgn4.png", "refdepth2.png", "refdepth3.png", "refdepth4.png", "refdepth5.png", "refdepth6.png", "region1.png", "region2.png", "region3.png", "region4.png",
}
MODEL_EXT = (".glb", ".gltf", ".obj", ".fbx")


def log_exc(msg):
    """Log a message plus the full traceback of the exception being handled."""
    tb = traceback.format_exc()
    text = f"{PREFIX} {msg}\n{tb}"
    print(text, flush=True)
    LOG.error(text)
    return text


def output_root():
    try:
        import folder_paths  # provided by ComfyUI
        return folder_paths.get_output_directory()
    except Exception:
        return os.environ.get("TEXPAINT_OUT") or os.path.join(tempfile.gettempdir(), "texpaint_output")


def input_root():
    try:
        import folder_paths  # provided by ComfyUI
        return folder_paths.get_input_directory()
    except Exception:
        return os.environ.get("TEXPAINT_DIR") or os.path.join(tempfile.gettempdir(), "texpaint_input")


def base_dir():
    d = os.path.join(input_root(), "texpaint")
    os.makedirs(d, exist_ok=True)
    return d


def models_dir():
    d = os.path.join(base_dir(), "models")
    os.makedirs(d, exist_ok=True)
    return d


def session_dir(sid, create=False):
    if not isinstance(sid, str) or not SID_RE.match(sid):
        raise ValueError(f"Invalid texture-painter session id: {sid!r}")
    d = os.path.join(base_dir(), "sessions", sid)
    if create:
        os.makedirs(d, exist_ok=True)
    return d


def safe_model_name(name):
    name = os.path.basename(name or "").replace("\\", "_").replace("/", "_")
    stem, ext = os.path.splitext(name)
    ext = ext.lower()
    if ext not in MODEL_EXT:
        raise ValueError(f"Unsupported model type '{ext}'. Allowed: {', '.join(MODEL_EXT)}")
    stem = re.sub(r"[^A-Za-z0-9._ -]", "_", stem).strip(" .") or "model"
    return stem[:80], ext


def atomic_write(path, data: bytes):
    tmp = path + ".tmp"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def read_json(path, default=None):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return default
    except Exception:
        log_exc(f"Could not read {path}")
        return default
