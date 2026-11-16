"""Auto-align of the generated image to the placed reference (the offset Klein introduces)."""
import os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import tp_reference as r2

rng = np.random.default_rng(3)
H = W = 256
def smooth(seed):
    r = np.random.default_rng(seed).random((H // 8 + 2, W // 8 + 2, 3)).astype(np.float32)
    big = np.kron(r, np.ones((8, 8, 1), np.float32))[:H, :W]
    k = np.ones(5, np.float32) / 5
    for ax in (0, 1):
        big = np.apply_along_axis(lambda m: np.convolve(m, k, mode="same"), ax, big)
    return big
ref = smooth(1)
w = np.zeros((H, W), np.float32); w[40:220, 50:210] = 1
for dx, dy in [(5, -3), (-7.5, 4.25), (0, 0), (12, 9)]:
    gen = r2.shift_image(ref, -dx, -dy)                      # content moved by (+dx, +dy): gen(x) = ref(x - d)
    gen = np.clip(gen + rng.normal(0, 0.02, gen.shape).astype(np.float32), 0, 1)
    est = r2.estimate_shift(gen, ref, w)
    assert est is not None, (dx, dy)
    ex, ey, sc = est
    assert abs(ex - dx) < 0.35 and abs(ey - dy) < 0.35 and sc > 0.5, ((dx, dy), est)
    fixed = r2.shift_image(gen, ex, ey)
    inner = (slice(60, 200), slice(70, 190))
    e0 = np.abs(gen[inner] - ref[inner]).mean(); e1 = np.abs(fixed[inner] - ref[inner]).mean()
    assert e1 < e0 * 0.5 + 0.02 or dx == dy == 0, (dx, dy, e0, e1)
# unrelated image: no shift is invented
assert r2.estimate_shift(smooth(7), ref, w) is None or r2.estimate_shift(smooth(7), ref, w)[2] < 0.35
# outside the search range: not found or low score, never a wild shift inside the window
gen = r2.shift_image(ref, -60, 0)
est = r2.estimate_shift(gen, ref, w, max_shift=20)
assert est is None or abs(est[0]) <= 20
# empty weight / flat image
assert r2.estimate_shift(ref, ref, np.zeros((H, W), np.float32)) is None
assert r2.estimate_shift(np.full((H, W, 3), .5, np.float32), ref, w) is None
print("align OK")
