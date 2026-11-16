"""Self-installer. Runs automatically every time ComfyUI imports the package (see __init__.py)
and can also be run by ComfyUI-Manager (install.py)."""
import importlib
import os
import subprocess
import sys
import traceback

HERE = os.path.dirname(os.path.abspath(__file__))
PREFIX = "[TexturePainterAI]"

# (import name, pip name, required?)
DEPENDENCIES = [
    ("numpy", "numpy", True),
    ("PIL", "Pillow", True),
    ("scipy", "scipy", False),  # faster UV padding; a numpy fallback exists
    ("xatlas", "xatlas", False),  # UV unwrap + atlas packing (Unwrap & Atlas tab)
]


def _can_import(mod):
    try:
        importlib.import_module(mod)
        return True
    except Exception:
        return False


def _pip_install(pkg):
    cmd = [sys.executable, "-m", "pip", "install", "--disable-pip-version-check", pkg]
    print(f"{PREFIX} installing missing dependency: {' '.join(cmd)}", flush=True)
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"{PREFIX} pip failed (exit code {r.returncode}) for '{pkg}':\n{r.stdout}\n{r.stderr}", flush=True)
        return False
    importlib.invalidate_caches()
    return True


def ensure_requirements():
    """Install whatever is missing. Never raises - problems are printed with full tracebacks."""
    ok = True
    try:
        for mod, pkg, required in DEPENDENCIES:
            if _can_import(mod):
                continue
            if not _pip_install(pkg) or not _can_import(mod):
                if required:
                    ok = False
                    print(f"{PREFIX} ERROR: required package '{pkg}' is missing and could not be installed. "
                          f"Run:  \"{sys.executable}\" -m pip install {pkg}", flush=True)
                else:
                    print(f"{PREFIX} optional package '{pkg}' not available - using the slower fallback.", flush=True)
        if not _can_import("torch"):
            print(f"{PREFIX} WARNING: torch could not be imported (it normally ships with ComfyUI).", flush=True)
        bundle = os.path.join(HERE, "web", "texpaint_editor.bundle.js")
        glue = os.path.join(HERE, "web", "texpaint.js")
        if not (os.path.isfile(bundle) and os.path.isfile(glue)):
            ok = False
            print(f"{PREFIX} ERROR: web files are missing ({bundle}). Re-copy the complete folder.", flush=True)
    except Exception:
        ok = False
        print(f"{PREFIX} unexpected error during dependency check:\n{traceback.format_exc()}", flush=True)
    return ok


if __name__ == "__main__":
    sys.exit(0 if ensure_requirements() else 1)
