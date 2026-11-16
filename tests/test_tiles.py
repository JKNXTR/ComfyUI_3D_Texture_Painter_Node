# Python side of the tile grid + the node round trip. The JS side is checked by tests/tiles_test.mjs against the same table.
import json, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tp_tiles as T

CASES = [(4096, 2048, 3, 2, 0.12), (1024, 1024, 2, 2, 0.0), (1000, 777, 4, 3, 0.25), (512, 512, 1, 1, 0.12), (999, 1001, 5, 7, 0.3)]
table = [[[t[k] for k in ("x0", "y0", "x1", "y1", "cx0", "cx1", "cy0", "cy1")] for t in T.grid(*c)] for c in CASES]
if len(sys.argv) > 1 and sys.argv[1] == "dump":
    print(json.dumps(table)); sys.exit(0)

for c, tl in zip(CASES, table):
    W, H = c[0], c[1]
    sizes = {(r[2] - r[0], r[3] - r[1]) for r in tl}
    assert len(sizes) == 1, ("tiles must all have the same size", c, sizes)
    for r in tl:
        assert 0 <= r[0] and r[2] <= W and 0 <= r[1] and r[3] <= H, ("tile outside the texture", c, r)
    grid = T.grid(*c)
    cover = np.zeros((H, W), np.int32)
    for t in grid:
        cover[t["cy0"]:t["cy1"], t["cx0"]:t["cx1"]] += 1
        assert t["x0"] <= t["cx0"] and t["x1"] >= t["cx1"] and t["y0"] <= t["cy0"] and t["y1"] >= t["cy1"], "tile must contain its own cell"
    assert (cover == 1).all(), "cells must partition the texture"
    acc = np.zeros((H, W), np.float32)                      # batch windows are complementary: they sum to 1 everywhere
    for t in grid:
        acc[t["y0"]:t["y1"], t["x0"]:t["x1"]] += T.window(t, "batch")
    assert np.abs(acc - 1.0).max() < 1e-4, ("batch windows must sum to 1", c, float(acc.min()), float(acc.max()))
um = np.zeros((1024, 1024), np.float32); um[10:40, 600:700] = 1.0
g = T.grid(1024, 1024, 2, 2, 0.12)
assert T.nonempty(um, g) == [1], T.nonempty(um, g)
d = T.done_region(g, [1], 1024, 1024); assert d[20, 650] and not d[900, 100]
assert T.out_size(1694, 1270, 1024) == (1024, 768), T.out_size(1694, 1270, 1024)
print("tile grid (python) OK")
