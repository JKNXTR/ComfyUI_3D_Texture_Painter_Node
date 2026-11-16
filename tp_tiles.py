"""UV tiling: split the UV texture into a grid of equally sized, overlapping tiles (pure numpy, no ComfyUI imports).

The same formulas live in src/tiles.js (the editor needs them for the live "tiles to generate" count and the run loop);
tests/tiles_test.mjs + tests/test_tiles.py check both against the same table.

Pixel rows run top -> bottom like the PNG files (row 0 = v 1). Tile index = row * cols + col (row-major, top-left first).
"""
import math

import numpy as np


def grid(W, H, cols, rows, overlap):
    """-> list of tile dicts. All tiles have the SAME size (edge tiles are shifted inwards instead of being cut), so a batch is possible.
    overlap = fraction of one cell (0..0.5) added on every side. Cell = the tile's own area (cells partition the texture)."""
    cols, rows = max(1, int(cols)), max(1, int(rows))
    ov = float(min(max(overlap, 0.0), 0.5))
    bx = [int(round(c * W / cols)) for c in range(cols + 1)]
    by = [int(round(r * H / rows)) for r in range(rows + 1)]
    ovx, ovy = int(round(ov * W / cols)), int(round(ov * H / rows))
    tw = min(W, int(math.ceil(W / cols)) + 2 * ovx)
    th = min(H, int(math.ceil(H / rows)) + 2 * ovy)
    out = []
    for r in range(rows):
        for c in range(cols):
            x0 = min(max(bx[c] - ovx, 0), W - tw)
            y0 = min(max(by[r] - ovy, 0), H - th)
            out.append({"i": r * cols + c, "c": c, "r": r, "x0": x0, "y0": y0, "x1": x0 + tw, "y1": y0 + th,
                        "cx0": bx[c], "cx1": bx[c + 1], "cy0": by[r], "cy1": by[r + 1], "ovx": ovx, "ovy": ovy, "cols": cols, "rows": rows})
    return out


def nonempty(umask, tiles, thr=0.02):
    """indices of the tiles whose own cell contains painted mask."""
    return [t["i"] for t in tiles if float(np.max(umask[t["cy0"]:t["cy1"], t["cx0"]:t["cx1"]], initial=0.0)) > thr]


def out_size(tw, th, long_side):
    """AI image size of one tile: long side = capture long side, multiple of 16."""
    snap = lambda v: max(64, int(round(v / 16.0)) * 16)
    s = float(long_side) / float(max(tw, th))
    return snap(tw * s), snap(th * s)


def _ramp(n, start, end, up):
    """1-D weights for x in [0,n): 0->1 (or 1->0) linearly between start and end (pixel coords of the tile)."""
    x = np.arange(n, dtype=np.float32) + 0.5
    if end <= start:
        return (x >= start).astype(np.float32) if up else (x < start).astype(np.float32)
    w = np.clip((x - start) / float(end - start), 0.0, 1.0)
    return w if up else 1.0 - w


def window(t, mode="batch"):
    """2-D blend weights (th, tw) of a tile.
    batch: complementary ramps across the overlap band on every interior side (neighbouring tiles sum to 1).
    seq:   tiles are generated one after another and only the not-yet-painted part is generated, so no ramps (all ones)."""
    tw, th = t["x1"] - t["x0"], t["y1"] - t["y0"]
    if mode == "seq":
        return np.ones((th, tw), np.float32)
    wx, wy = np.ones(tw, np.float32), np.ones(th, np.float32)
    if t["c"] > 0:
        b = t["cx0"] - t["x0"]
        wx = wx * _ramp(tw, b - t["ovx"], b + t["ovx"], True)
    if t["c"] < t["cols"] - 1:
        b = t["cx1"] - t["x0"]
        wx = wx * _ramp(tw, b - t["ovx"], b + t["ovx"], False)
    if t["r"] > 0:
        b = t["cy0"] - t["y0"]
        wy = wy * _ramp(th, b - t["ovy"], b + t["ovy"], True)
    if t["r"] < t["rows"] - 1:
        b = t["cy1"] - t["y0"]
        wy = wy * _ramp(th, b - t["ovy"], b + t["ovy"], False)
    return wy[:, None] * wx[None, :]


def done_region(tiles, done, W, H):
    """bool (H, W): pixels already painted by the tiles in `done` (their whole rectangles)."""
    m = np.zeros((H, W), bool)
    by_i = {t["i"]: t for t in tiles}
    for i in done or []:
        t = by_i.get(int(i))
        if t:
            m[t["y0"]:t["y1"], t["x0"]:t["x1"]] = True
    return m
