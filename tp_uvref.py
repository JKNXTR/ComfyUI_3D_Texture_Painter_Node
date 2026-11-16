"""Reference images -> UV space.

Every reference image (2..6) that has a camera (the view it was placed from, see the editor) is projected onto the model's UV layout
with the same visibility / facing test the baker uses (a texel only takes colour from a photo that really SEES it, from a good angle).
Several references are blended per texel by their confidence. Result: one UV-space reference picture + a confidence map.
"""
import math
import os

import numpy as np
from PIL import Image

from . import tp_core as core
from . import tp_reference as ref2lib


def _png(path, mode="RGB"):
    with Image.open(path) as im:
        return np.array(im.convert(mode))


def slots(meta):
    """[(n, slot_dict)] for images 2..6."""
    out = [(2, meta.get("ref2") or {})]
    rx = meta.get("refx") or []
    for i in range(4):
        out.append((i + 3, rx[i] if i < len(rx) and isinstance(rx[i], dict) else {}))
    return out


def project(mesh, sdir, meta, W, H, facing_deg=65.0, depth_bias=0.004):
    """-> dict(color float32 (H,W,3) 0..255, conf float32 (H,W) 0..1, used [(n, coverage)], notes [str])"""
    cams = {int(c["n"]): c for c in (meta.get("ref_cams") or [])}
    raster = core.get_raster(mesh, W, H)
    num = np.zeros((H, W, 3), np.float32)
    den = np.zeros((H, W), np.float32)
    miss = np.ones((H, W), np.float32)
    used, notes = [], []
    facing = float(math.cos(math.radians(min(max(float(facing_deg), 0.0), 88.0))))
    ones = np.ones((H, W), np.float32)
    zero_tex = np.zeros((H, W, 3), np.uint8)
    for n, slot in slots(meta):
        if not slot.get("has"):
            continue
        cam = cams.get(n)
        ip, dp = os.path.join(sdir, f"ref{n}.png"), os.path.join(sdir, f"refdepth{n}.png")
        if cam is None or not os.path.isfile(ip) or not os.path.isfile(dp):
            notes.append(f"image {n}: no camera / angle - not used (place it on the model, or give it an angle)")
            continue
        cc = cam["camera"]
        CW, CH = int(cc["width"]), int(cc["height"])
        img = _png(ip).astype(np.float32) / 255.0
        placed, alpha = ref2lib.place_reference(
            img, np.ones((CH, CW), np.float32), CW, CH, slot.get("mode", "mask"), slot.get("scale", 1.0), slot.get("rot", 0.0),
            ox=slot.get("ox", 0.0), oy=slot.get("oy", 0.0), size=slot.get("size", 0.5), wrap=bool(slot.get("wrap", False)),
            aspect=(float(slot.get("aspect") or 0) or None), sx=float(slot.get("sx") or 1.0), sy=float(slot.get("sy") or 1.0),
            crop=None, return_alpha=True)
        depth = _png(dp)
        r = core.bake(mesh, raster, cc, depth, np.clip(placed, 0, 1) * 255.0, ones, zero_tex, facing=facing, depth_bias=float(depth_bias),
                      strength=1.0, padding=0)
        col = r["layer"][..., :3].astype(np.float32)
        c = r["layer"][..., 3].astype(np.float32) / 255.0
        if alpha is not None and float(np.min(alpha)) < 0.999:   # the photo only covers part of the frame
            a3 = np.repeat((np.clip(alpha, 0, 1) * 255.0)[..., None], 3, 2).astype(np.float32)
            ra = core.bake(mesh, raster, cc, depth, a3, ones, zero_tex, facing=facing, depth_bias=float(depth_bias), strength=1.0, padding=0)
            c = c * (ra["layer"][..., 0].astype(np.float32) / 255.0)
        w = float(slot.get("weight") or 0.0)
        c = c * (w if w > 0.0 else 1.0)
        c = np.clip(c, 0.0, 1.0)
        num += col * c[..., None]
        den += c
        miss *= (1.0 - c)
        cov = float((c > 0.5).sum()) / max(1, int(raster.cov.sum()))
        used.append((n, cov))
        notes.append(f"image {n}: sees {cov * 100:.0f}% of the UV area (camera: {cam.get('source', 'saved')})")
    color = num / np.maximum(den, 1e-6)[..., None]
    conf = (1.0 - miss).astype(np.float32)
    return {"color": color.astype(np.float32), "conf": conf, "used": used, "notes": notes, "raster_cov": raster.cov}
