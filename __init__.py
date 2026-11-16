"""
ComfyUI-TexturePainterAI
3D AI texture painter: paint a mask on a UV-unwrapped model, generate with any image-edit workflow
(FLUX.2 Klein 9B, ...) and bake the result back into the UV texture.

Copy this whole folder into  ComfyUI/custom_nodes/  and restart ComfyUI. Everything else is automatic.
"""
import traceback

from .tp_install import ensure_requirements

_DEPS_OK = ensure_requirements()

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = "./web"

try:
    from .tp_nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS  # noqa: E402,F811
    from . import tp_server  # noqa: F401,E402  (registers the /texpaint/* routes)
    from . import tp_bridge  # noqa: F401,E402  (the standalone <-> node bridge: /texpaint/bridge/{sid})
    print(f"[TexturePainterAI] v{tp_server.VERSION} loaded - nodes: {', '.join(NODE_CLASS_MAPPINGS)}", flush=True)
except Exception:
    print("[TexturePainterAI] FAILED to load:\n" + traceback.format_exc(), flush=True)

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
