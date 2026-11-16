"""UV unwrap + atlas build (xatlas) with texture transfer.

Several objects are unwrapped / packed into ONE square atlas (equal texel density per world unit); the texture of every object (its own UV map) is
re-projected into the new atlas: the new triangles are the old triangles (same order), so every new texel knows its old UV and old object.
"""
import io
import struct
import json

import numpy as np
from PIL import Image

from . import tp_core as core

QUALITY = {"fast": dict(iters=1, brute=False), "balanced": dict(iters=2, brute=False), "best": dict(iters=4, brute=True)}


def xatlas_module():
    try:
        import xatlas
        return xatlas
    except Exception as e:  # pragma: no cover
        raise RuntimeError("The 'xatlas' Python package is not installed. Run:  python -m pip install xatlas  "
                           "(use the Python that runs ComfyUI), then restart ComfyUI.") from e


def unwrap_atlas(objs, size=2048, mode="unwrap", quality="balanced", padding=8, fill=(200, 200, 200)):
    """objs: list of dict(name, positions (n,3) f32, indices (m,3) u32, uvs (n,2) f32 | None, tex (h,w,3) u8 | None).
    Returns dict(objects=[dict(positions, uvs, indices, old_uvs)], atlas uint8 (size,size,3), stats)."""
    xa = xatlas_module()
    q = QUALITY.get(quality, QUALITY["balanced"])
    size = int(np.clip(size, 256, 8192)); padding = int(np.clip(padding, 0, 64))
    atlas = xa.Atlas()
    keep = mode == "pack"
    for o in objs:
        if keep and o.get("uvs") is not None:
            atlas.add_mesh(np.ascontiguousarray(o["positions"], np.float32), np.ascontiguousarray(o["indices"], np.uint32),
                           uvs=np.ascontiguousarray(o["uvs"], np.float32))
        else:
            atlas.add_mesh(np.ascontiguousarray(o["positions"], np.float32), np.ascontiguousarray(o["indices"], np.uint32))
    co = xa.ChartOptions(); co.max_iterations = q["iters"]
    if keep:
        co.use_input_mesh_uvs = True
    po = xa.PackOptions(); po.padding = max(1, padding // 2); po.bruteForce = q["brute"]; po.resolution = size
    atlas.generate(co, po)
    aw, ah = float(atlas.width), float(atlas.height)
    if aw <= 0 or ah <= 0:
        raise RuntimeError("xatlas produced an empty atlas (no usable triangles).")
    k = (size - 1.0) / max(aw, ah)           # uniform scale: square atlas, no anisotropic stretch
    out, total_tris = [], 0
    for i, o in enumerate(objs):
        vm, ix, uv = atlas.get_mesh(i)
        vm = np.asarray(vm, np.int64); ix = np.asarray(ix, np.uint32).reshape(-1, 3)
        uvp = np.asarray(uv, np.float64) * np.array([aw, ah]) * k / size          # -> 0..1 of the square atlas
        old = o.get("uvs")
        out.append(dict(name=o["name"], positions=np.asarray(o["positions"], np.float32)[vm], uvs=uvp.astype(np.float32), indices=ix,
                        old_uvs=(np.asarray(old, np.float32)[vm] if old is not None else np.zeros((len(vm), 2), np.float32))))
        total_tris += len(ix)
        if len(ix) != len(o["indices"]):
            raise RuntimeError(f"xatlas changed the triangle count of '{o['name']}' ({len(o['indices'])} -> {len(ix)}): degenerate triangles cannot be transferred.")

    # ---- texture transfer: rasterise the new layout; the "position" of a vertex is (old u, old v, object index)
    P, N, U, I, base = [], [], [], [], 0
    for i, m in enumerate(out):
        P.append(np.concatenate([m["old_uvs"], np.full((len(m["old_uvs"]), 1), i, np.float32)], 1)); N.append(np.zeros((len(m["old_uvs"]), 3), np.float32))
        U.append(m["uvs"]); I.append(m["indices"].astype(np.int64) + base); base += len(m["uvs"])
    mesh = core.Mesh(np.concatenate(P), np.concatenate(N), np.concatenate(U), np.concatenate(I).astype(np.uint32), "unwrap")
    r = core.rasterize_uv(mesh, size, size)
    img = np.empty((size, size, 3), np.float32); img[:] = np.array(fill, np.float32)
    obj_id = np.rint(r.pos[..., 2]).astype(np.int32)
    ys_all, xs_all = np.nonzero(r.cov)
    transferred = 0
    for i, o in enumerate(objs):
        tex = o.get("tex")
        if tex is None or o.get("uvs") is None:
            continue
        sel = r.cov & (obj_id == i)
        ys, xs = np.nonzero(sel)
        if not ys.size:
            continue
        th, tw = tex.shape[:2]
        u = np.mod(r.pos[ys, xs, 0].astype(np.float64), 1.0); v = np.mod(r.pos[ys, xs, 1].astype(np.float64), 1.0)
        img[ys, xs] = core.bilinear(tex.astype(np.float32), u * tw - 0.5, (1.0 - v) * th - 0.5)
        transferred += int(ys.size)
    core.pad_colors(img, r.cov, ~r.cov, padding)
    atlas_png = np.clip(np.rint(img), 0, 255).astype(np.uint8)

    # texel density (texels per world unit, linear) per object - should be about equal
    dens = []
    for m in out:
        p = m["positions"].astype(np.float64)[m["indices"]]; a3 = np.linalg.norm(np.cross(p[:, 1] - p[:, 0], p[:, 2] - p[:, 0]), axis=1) / 2
        t = m["uvs"].astype(np.float64)[m["indices"]] * size; a2 = np.abs((t[:, 1, 0] - t[:, 0, 0]) * (t[:, 2, 1] - t[:, 0, 1]) - (t[:, 2, 0] - t[:, 0, 0]) * (t[:, 1, 1] - t[:, 0, 1])) / 2
        ok = a3 > 1e-12
        dens.append(float(np.sqrt(np.median(a2[ok] / a3[ok]))) if ok.any() else 0.0)
    stats = dict(size=size, charts=int(atlas.chart_count), utilization=float(atlas.utilization), triangles=int(total_tris),
                 covered=float(r.cov.mean()), overlap=float(r.overlap_ratio), density=dens, transferred=transferred,
                 objects=[dict(name=m["name"], vertices=int(len(m["uvs"])), triangles=int(len(m["indices"]))) for m in out])
    return dict(objects=out, atlas=atlas_png, stats=stats)


def pack_result(res):
    """binary reply: [u32 header length][header json][per object: positions f32, uvs f32, indices u32][atlas PNG]"""
    buf = io.BytesIO(); Image.fromarray(res["atlas"]).save(buf, "PNG", compress_level=3)
    png = buf.getvalue()
    header = dict(stats=res["stats"], png=len(png), objects=[dict(name=m["name"], v=int(len(m["uvs"])), t=int(len(m["indices"]))) for m in res["objects"]])
    hb = json.dumps(header).encode("utf-8")
    parts = [struct.pack("<I", len(hb)), hb]
    for m in res["objects"]:
        parts += [m["positions"].astype("<f4").tobytes(), m["uvs"].astype("<f4").tobytes(), m["indices"].astype("<u4").tobytes()]
    parts.append(png)
    return b"".join(parts)
