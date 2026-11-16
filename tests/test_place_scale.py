"""Scale X / Y of the manual reference placement (Python side must match the editor: width = size*sx, height = size*sy*image aspect)."""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tp_reference as r2

W = H = 400
ref = np.ones((50, 100, 3), np.float32) * 0.5   # 2:1 image
vm = np.ones((H, W), np.float32)

def extent(**kw):
    _, a = r2.place_reference(ref, vm, W, H, "manual", ox=0.0, oy=0.0, size=0.5, return_alpha=True, **kw)
    ys, xs = np.nonzero(a > 0.5)
    return xs.max() - xs.min() + 1, ys.max() - ys.min() + 1

w0, h0 = extent()
assert abs(w0 - 200) <= 2 and abs(h0 - 100) <= 2, (w0, h0)
w1, h1 = extent(sx=1.5)
assert abs(w1 - 300) <= 2 and abs(h1 - h0) <= 2, (w1, h1)
w2, h2 = extent(sy=2.0)
assert abs(w2 - w0) <= 2 and abs(h2 - 200) <= 2, (w2, h2)
w3, h3 = extent(sx=0.5, sy=0.5)
assert abs(w3 - 100) <= 2 and abs(h3 - 50) <= 2, (w3, h3)
# with an aspect override: height = size * aspect * sy
w4, h4 = extent(aspect=1.0, sy=0.5)
assert abs(w4 - 200) <= 2 and abs(h4 - 100) <= 2, (w4, h4)
# default arguments are the identity
a, _ = r2.place_reference(ref, vm, W, H, "manual", size=0.5, return_alpha=True)
b, _ = r2.place_reference(ref, vm, W, H, "manual", size=0.5, return_alpha=True, sx=1.0, sy=1.0)
assert np.array_equal(a, b)
# other modes ignore sx / sy
c = r2.place_reference(ref, vm, W, H, "frame", sx=3.0, sy=3.0)
d = r2.place_reference(ref, vm, W, H, "frame")
assert np.array_equal(c, d)
print("place scale X/Y OK")
