"""Run by ComfyUI-Manager after installation (also safe to run by hand: python install.py)."""
import sys
from tp_install import ensure_requirements

sys.exit(0 if ensure_requirements() else 1)
