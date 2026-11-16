"""Pure numpy core of the Texture Painter: mesh container, UV rasteriser and the projection baker.

Conventions (must match the JavaScript editor):
  * UVs use "v up" (v = 0 at the bottom). Texel (x, y) of a texture image has its centre at
    u = (x + 0.5) / W, v = 1 - (y + 0.5) / H.
  * Camera matrices arrive as column-major 16-float arrays (three.js Matrix4.toArray()).
  * Depth is packed as 24 bit linear view depth in RGB:  t = (R*65536 + G*256 + B) / 16777215,
    z = near + t * (far - near)  (distance along the camera's -Z axis).
"""
import json
import struct
from collections import namedtuple

import numpy as np

try:  # optional, only used for fast padding
    from scipy import ndimage as _ndi
except Exception:  # pragma: no cover
    _ndi = None

Mesh = namedtuple("Mesh", "positions normals uvs indices hash")
Raster = namedtuple("Raster", "pos nrm cov overlap_ratio")


# -------------------------------------------------------------------------------------------
# mesh container
# -------------------------------------------------------------------------------------------
def read_mesh_bin(data: bytes) -> Mesh:
    if len(data) < 8:
        raise ValueError("mesh.bin is empty or truncated")
    (hl,) = struct.unpack_from("<I", data, 0)
    if 4 + hl > len(data):
        raise ValueError("mesh.bin header is corrupt")
    header = json.loads(data[4:4 + hl].decode("utf-8"))
    V, I = int(header["vertices"]), int(header["indices"])
    off = 4 + hl
    need = off + V * 12 + V * 12 + V * 8 + I * 4
    if len(data) != need:
        raise ValueError(f"mesh.bin size mismatch: expected {need} bytes, got {len(data)}")
    pos = np.frombuffer(data, "<f4", V * 3, off).reshape(V, 3); off += V * 12
    nor = np.frombuffer(data, "<f4", V * 3, off).reshape(V, 3); off += V * 12
    uvs = np.frombuffer(data, "<f4", V * 2, off).reshape(V, 2); off += V * 8
    idx = np.frombuffer(data, "<u4", I, off).reshape(-1, 3)
    if idx.size and int(idx.max()) >= V:
        raise ValueError("mesh.bin contains out-of-range indices")
    return Mesh(pos, nor, uvs, idx, str(header.get("hash", "")))


# -------------------------------------------------------------------------------------------
# UV rasteriser: for every texel inside a UV triangle store its 3D position and normal
# -------------------------------------------------------------------------------------------
def _raster_block(tri_idx, X, Y, P, N, ix0, iy0, gx_off, gy_off, W, H, pos_map, nrm_map, cov, strict, eps=1e-6):
    """Vectorised rasterisation of a batch of triangles over a (B, bh, bw) block of candidate texels."""
    B = len(tri_idx)
    bh, bw = len(gy_off), len(gx_off)
    gx = ix0[tri_idx][:, None, None] + gx_off[None, None, :]
    gy = iy0[tri_idx][:, None, None] + gy_off[None, :, None]
    cx = gx + 0.5
    cy = gy + 0.5
    x0, x1, x2 = (X[tri_idx, k][:, None, None] for k in range(3))
    y0, y1, y2 = (Y[tri_idx, k][:, None, None] for k in range(3))
    den = (y1 - y2) * (x0 - x2) + (x2 - x1) * (y0 - y2)
    good = np.abs(den) > 1e-12
    den = np.where(good, den, 1.0)
    l0 = ((y1 - y2) * (cx - x2) + (x2 - x1) * (cy - y2)) / den
    l1 = ((y2 - y0) * (cx - x2) + (x0 - x2) * (cy - y2)) / den
    l2 = 1.0 - l0 - l1
    inside = good & (l0 >= -eps) & (l1 >= -eps) & (l2 >= -eps) & (gx >= 0) & (gx < W) & (gy >= 0) & (gy < H)
    if not inside.any():
        return
    sel = np.nonzero(inside)
    tb = sel[0]
    GX = np.broadcast_to(gx, (B, bh, bw))[sel].astype(np.int64)
    GY = np.broadcast_to(gy, (B, bh, bw))[sel].astype(np.int64)
    a, b, c = l0[sel][:, None], l1[sel][:, None], l2[sel][:, None]
    p = a * P[tri_idx[tb], 0] + b * P[tri_idx[tb], 1] + c * P[tri_idx[tb], 2]
    n = a * N[tri_idx[tb], 0] + b * N[tri_idx[tb], 1] + c * N[tri_idx[tb], 2]
    pos_map[GY, GX] = p
    nrm_map[GY, GX] = n
    cov[GY, GX] = True
    st = (l0[sel] > 1e-3) & (l1[sel] > 1e-3) & (l2[sel] > 1e-3)
    if st.any():
        flat = GY[st] * W + GX[st]
        u, cnt = np.unique(flat, return_counts=True)
        strict[u] = np.minimum(strict[u].astype(np.int32) + cnt, 255).astype(np.uint8)


def rasterize_uv(mesh: Mesh, W: int, H: int, max_block=1_500_000) -> Raster:
    tri = mesh.indices.astype(np.int64)
    uv = mesh.uvs.astype(np.float64)
    px = uv[:, 0] * W
    py = (1.0 - uv[:, 1]) * H
    X, Y = px[tri], py[tri]
    P = mesh.positions.astype(np.float64)[tri]  # (T,3,3)
    N = mesh.normals.astype(np.float64)[tri]
    xmin, xmax = X.min(1), X.max(1)
    ymin, ymax = Y.min(1), Y.max(1)
    ix0 = np.clip(np.floor(xmin - 0.5).astype(np.int64), 0, W - 1)
    ix1 = np.clip(np.ceil(xmax - 0.5).astype(np.int64), 0, W - 1)
    iy0 = np.clip(np.floor(ymin - 0.5).astype(np.int64), 0, H - 1)
    iy1 = np.clip(np.ceil(ymax - 0.5).astype(np.int64), 0, H - 1)
    # drop triangles that are completely outside [0,1]^2
    visible = (xmax >= 0) & (xmin <= W) & (ymax >= 0) & (ymin <= H)
    size = np.maximum(ix1 - ix0, iy1 - iy0) + 1

    pos_map = np.zeros((H, W, 3), np.float32)
    nrm_map = np.zeros((H, W, 3), np.float32)
    cov = np.zeros((H, W), bool)
    strict = np.zeros(H * W, np.uint8)

    all_ids = np.nonzero(visible)[0]
    small_limit = 64
    for D in (4, 8, 16, 32, 64):
        lo = D // 2 if D > 4 else 0
        ids = all_ids[(size[all_ids] > lo) & (size[all_ids] <= D)]
        if not len(ids):
            continue
        step = max(1, max_block // (D * D))
        off = np.arange(D)
        for s in range(0, len(ids), step):
            _raster_block(ids[s:s + step], X, Y, P, N, ix0, iy0, off, off, W, H, pos_map, nrm_map, cov, strict)

    for t in all_ids[size[all_ids] > small_limit]:  # large triangles: band by band
        bw = int(ix1[t] - ix0[t] + 1)
        bh_all = int(iy1[t] - iy0[t] + 1)
        rows = max(1, max_block // bw)
        gx_off = np.arange(bw)
        ids = np.array([t])
        for r in range(0, bh_all, rows):
            gy_off = np.arange(r, min(bh_all, r + rows))
            _raster_block(ids, X, Y, P, N, ix0, iy0, gx_off, gy_off, W, H, pos_map, nrm_map, cov, strict)

    ln = np.linalg.norm(nrm_map, axis=2, keepdims=True)
    nrm_map = np.where(ln > 1e-12, nrm_map / np.maximum(ln, 1e-12), 0).astype(np.float32)
    covered = int((strict > 0).sum())
    overlap = float((strict > 1).sum()) / covered if covered else 0.0
    return Raster(pos_map, nrm_map, cov, overlap)


_RASTER_CACHE = {}


def get_raster(mesh: Mesh, W: int, H: int) -> Raster:
    key = (mesh.hash, W, H, len(mesh.indices))
    r = _RASTER_CACHE.get(key)
    if r is None:
        _RASTER_CACHE.clear()  # keep only one (memory)
        r = rasterize_uv(mesh, W, H)
        _RASTER_CACHE[key] = r
    return r


# -------------------------------------------------------------------------------------------
# helpers
# -------------------------------------------------------------------------------------------
def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / max(e1 - e0, 1e-9), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def bilinear(img, x, y):
    """img (h,w,C) float32, x/y pixel coordinates where integers are pixel centres. Returns (n,C)."""
    h, w = img.shape[:2]
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    fx = (x - x0)[:, None].astype(np.float32)
    fy = (y - y0)[:, None].astype(np.float32)
    x0c, x1c = np.clip(x0, 0, w - 1), np.clip(x0 + 1, 0, w - 1)
    y0c, y1c = np.clip(y0, 0, h - 1), np.clip(y0 + 1, 0, h - 1)
    return (img[y0c, x0c] * (1 - fx) * (1 - fy) + img[y0c, x1c] * fx * (1 - fy)
            + img[y1c, x0c] * (1 - fx) * fy + img[y1c, x1c] * fx * fy)


def decode_depth(rgb):
    d = (rgb[..., 0].astype(np.uint32) << 16) | (rgb[..., 1].astype(np.uint32) << 8) | rgb[..., 2].astype(np.uint32)
    return d.astype(np.float32) / 16777215.0


def _shift(a, dy, dx):
    """Shift array by (dy, dx) with zero fill (result[y, x] = a[y - dy, x - dx])."""
    out = np.zeros_like(a)
    H, W = a.shape[:2]
    ys, yd = (slice(0, H - dy), slice(dy, H)) if dy >= 0 else (slice(-dy, H), slice(0, H + dy))
    xs, xd = (slice(0, W - dx), slice(dx, W)) if dx >= 0 else (slice(-dx, W), slice(0, W + dx))
    out[yd, xd] = a[ys, xs]
    return out


def pad_colors(img, valid, allowed, iterations):
    """Spread colours of `valid` texels into neighbouring `allowed` texels (UV seam padding).
    img (H,W,3) float32 is modified in place. Returns the boolean mask of texels that were filled."""
    if iterations <= 0 or not valid.any():
        return np.zeros_like(valid)
    if _ndi is not None:
        dist, (iy, ix) = _ndi.distance_transform_edt(~valid, return_indices=True)
        fill = allowed & ~valid & (dist <= iterations)
        img[fill] = img[iy[fill], ix[fill]]
        return fill
    cur = valid.copy()
    filled = np.zeros_like(valid)
    offs = [(-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1)]
    for _ in range(int(iterations)):
        need = allowed & ~cur
        if not need.any():
            break
        got = np.zeros_like(cur)
        for dy, dx in offs:
            sv = _shift(cur, dy, dx)
            take = need & sv & ~got
            if take.any():
                img[take] = _shift(img, dy, dx)[take]
                got |= take
        if not got.any():
            break
        cur |= got
        filled |= got
    return filled


# -------------------------------------------------------------------------------------------
# the baker
# -------------------------------------------------------------------------------------------
def bake(mesh, raster, cam, depth_rgb, gen, uv_mask, texture, *, facing=0.25, depth_bias=0.003,
         strength=1.0, padding=8, chunk_rows=256, prev_conf=None):
    """Project the generated image back onto the texture.

    mesh/raster   : mesh container and its UV rasterisation for the texture size
    cam           : dict with view/proj (16 floats, column-major), near, far
    depth_rgb     : (dh, dw, 3) uint8 packed depth from the capture
    gen           : (gh, gw, 3) float32, 0..255 generated image (same framing as the capture)
    uv_mask       : (H, W) float32 0..1 mask in texture space
    texture       : (H, W, 3) uint8 current texture
    Returns dict(texture uint8, confidence float32, remaining float32, stats dict)
    """
    H, W = raster.cov.shape
    view = np.array(cam["view"], np.float64).reshape(4, 4).T
    proj = np.array(cam["proj"], np.float64).reshape(4, 4).T
    near, far = float(cam["near"]), float(cam["far"])
    dh, dw = depth_rgb.shape[:2]
    gh, gw = gen.shape[:2]
    zmap = near + decode_depth(depth_rgb) * (far - near)
    cam_pos = np.linalg.inv(view)[:3, 3]
    ortho = abs(proj[3, 3] - 1.0) < 1e-6 and abs(proj[3, 2]) < 1e-6   # orthographic capture: parallel view rays
    ortho_dir = view[2, :3] / max(np.linalg.norm(view[2, :3]), 1e-12)  # world direction pointing towards the camera

    out = texture.astype(np.float32).copy()
    conf = np.zeros((H, W), np.float32)
    layer = np.zeros((H, W, 4), np.float32)  # generated colour (0..255) + coverage alpha (0..255), straight alpha
    stats = dict(masked=0, baked=0, behind=0, grazing=0, occluded=0, outside=0)

    for r0 in range(0, H, chunk_rows):
        r1 = min(H, r0 + chunk_rows)
        m_chunk = uv_mask[r0:r1]
        sel = raster.cov[r0:r1] & (m_chunk > 0.004)
        ys, xs = np.nonzero(sel)
        if not ys.size:
            continue
        n = ys.size
        core_sel = m_chunk[ys, xs] > 0.5  # statistics only count the solid part of the mask, not its soft fringe
        stats["masked"] += int(core_sel.sum())
        P = raster.pos[r0:r1][ys, xs].astype(np.float64)
        Nn = raster.nrm[r0:r1][ys, xs].astype(np.float64)
        V = np.concatenate([P, np.ones((n, 1))], 1) @ view.T
        C = V @ proj.T
        w = C[:, 3]
        front = w > 1e-9
        ndc = C[:, :3] / np.where(front, w, 1.0)[:, None]
        zv = -V[:, 2]
        inframe = front & (np.abs(ndc[:, 0]) <= 1.0) & (np.abs(ndc[:, 1]) <= 1.0) & (zv > 0.0)
        fx = ndc[:, 0] * 0.5 + 0.5
        fy = 1.0 - (ndc[:, 1] * 0.5 + 0.5)
        ix = np.clip((fx * dw).astype(np.int64), 0, dw - 1)
        iy = np.clip((fy * dh).astype(np.int64), 0, dh - 1)
        zm = zmap[iy, ix]
        if ortho:
            Vd = np.broadcast_to(ortho_dir[None, :], P.shape)
        else:
            Vd = cam_pos[None, :] - P
            Vd = Vd / np.maximum(np.linalg.norm(Vd, axis=1, keepdims=True), 1e-12)
        c = np.abs((Nn * Vd).sum(1))
        tan = np.sqrt(np.clip(1.0 - c * c, 0.0, 1.0)) / np.maximum(c, 0.05)
        pix_world = (2.0 / (proj[1, 1] * dh)) if ortho else (2.0 * zv / (proj[1, 1] * dh))
        bias = depth_bias * (far - near) + 1.5 * pix_world * np.minimum(tan, 20.0)
        vis = zv <= zm + bias
        wf = smoothstep(facing, facing + 0.25, c)
        wgt = (m_chunk[ys, xs] * wf * (vis & inframe) * strength).astype(np.float32)
        # seam-aware blending: where an earlier view already covers the texel with confidence p, the optimal
        # cross-fade is  (p*old + w*new) / (p + w)  ==  normal blend with alpha  w / (w + p)
        if prev_conf is not None:
            pc = prev_conf[r0:r1][ys, xs].astype(np.float32)
            a_eff = np.where((pc > 1e-4) & (wgt > 0), wgt / np.maximum(wgt + pc, 1e-6), wgt).astype(np.float32)
        else:
            a_eff = wgt
        stats["outside"] += int((core_sel & ~inframe).sum())
        stats["occluded"] += int((core_sel & inframe & ~vis).sum())
        stats["grazing"] += int((core_sel & inframe & vis & (wf < 0.5)).sum())
        col = bilinear(gen, fx * gw - 0.5, fy * gh - 0.5)
        base = out[r0:r1][ys, xs]
        out[r0:r1][ys, xs] = base * (1.0 - a_eff[:, None]) + col * a_eff[:, None]
        conf[r0:r1][ys, xs] = wgt
        layer[r0:r1][ys, xs, :3] = col
        layer[r0:r1][ys, xs, 3] = a_eff * 255.0
        stats["baked"] += int((core_sel & (wgt >= 0.5 * m_chunk[ys, xs])).sum())

    pad_colors(layer, conf > 0.0, ~raster.cov, int(padding))  # colour AND alpha spread over island borders
    filled = pad_colors(out, conf > 0.0, ~raster.cov, int(padding))
    if filled.any():
        # propagate confidence to the padding only for display purposes
        conf_pad = conf.copy()
        if _ndi is not None:
            valid = conf > 0.0
            _, (iy2, ix2) = _ndi.distance_transform_edt(~valid, return_indices=True)
            conf_pad[filled] = conf[iy2[filled], ix2[filled]]
        conf = conf_pad

    frac = np.clip(conf / np.maximum(uv_mask, 1e-4), 0.0, 1.0)
    remaining = (uv_mask * (1.0 - frac)).astype(np.float32)
    remaining[frac > 0.97] = 0.0
    new_tex = np.clip(np.rint(out), 0, 255).astype(np.uint8)
    stats["coverage"] = (stats["baked"] / stats["masked"]) if stats["masked"] else 0.0
    layer_png = np.clip(np.rint(layer), 0, 255).astype(np.uint8)
    return dict(texture=new_tex, confidence=conf, remaining=remaining, stats=stats, layer=layer_png)
