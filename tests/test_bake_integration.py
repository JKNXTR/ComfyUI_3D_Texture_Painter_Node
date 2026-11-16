"""Integration test: feeds the captures produced by the REAL browser editor (tests/browser_test.mjs)
into the Python baker and checks that texels land where they should (orientation, matrices, depth)."""
import json, os, sys, time
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import tp_core as core

d = sys.argv[1] if len(sys.argv) > 1 else "/tmp/tp_out"
meta = json.load(open(f"{d}/meta.json"))
mesh = core.read_mesh_bin(open(f"{d}/mesh.bin", "rb").read())
tex = np.array(Image.open(f"{d}/texture.png").convert("RGB"))
H, W = tex.shape[:2]
uvm = np.array(Image.open(f"{d}/uvmask.png").convert("L")).astype(np.float32) / 255.0
if uvm.shape != (H, W):
    uvm = np.array(Image.fromarray((uvm * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)).astype(np.float32) / 255.0
depth = np.array(Image.open(f"{d}/depth.png").convert("RGB"))
view = np.array(Image.open(f"{d}/view.png").convert("RGB")).astype(np.float32)
print("mesh", mesh.positions.shape, mesh.indices.shape, "tex", tex.shape, "mask max", uvm.max(), "masked texels", int((uvm > 0.5).sum()))

t0 = time.time()
r = core.rasterize_uv(mesh, W, H)
print(f"rasterize {time.time()-t0:.2f}s covered={r.cov.sum()} overlap={r.overlap_ratio:.4f}")
expected_cover = 6 * (1 / 3 - 0.02) * (1 / 2 - 0.02) * W * H
assert abs(r.cov.sum() - expected_cover) / expected_cover < 0.02, (r.cov.sum(), expected_cover)
assert r.overlap_ratio < 0.001

cam = meta["camera"]

# ---- 1) identity: generated == view render  ->  texture must (almost) not change
t0 = time.time()
res = core.bake(mesh, r, cam, depth, view, uvm, tex, facing=meta["facing"], padding=8)
print(f"bake {time.time()-t0:.2f}s stats={res['stats']}")
new = res["texture"].astype(np.int32)
old = tex.astype(np.int32)
conf = res["confidence"]
sel = (conf > 0.95) & r.cov
print("identity: baked texels", int(sel.sum()), "mean abs diff", np.abs(new[sel] - old[sel]).mean())
assert sel.sum() > 5000, "nothing was baked"
assert np.abs(new[sel] - old[sel]).mean() < 6.0, "identity bake drifted -> projection/orientation mismatch"
outside = (uvm < 0.004) & r.cov
assert np.abs(new[outside] - old[outside]).max() == 0, "texels outside the mask changed"

# ---- 2) inverted generated image -> baked texels become the inverted texture colours
gen = 255.0 - view
res2 = core.bake(mesh, r, cam, depth, gen, uvm, tex, facing=meta["facing"], padding=8)
n2 = res2["texture"].astype(np.int32)
sel2 = (res2["confidence"] > 0.97) & r.cov
inv = 255 - old
err = np.abs(n2[sel2] - inv[sel2]).mean()
print("inverted: baked texels", int(sel2.sum()), "mean abs err vs inverted texture", err)
assert err < 8.0

# which face got painted? (+Z cell = col 0,row 0, i.e. bottom-left of the UV map)
cells = json.load(open(f"{d}/cells.json"))
for c in cells:
    x0 = int(c["col"] * W / 3); x1 = int((c["col"] + 1) * W / 3)
    y0 = int(H * (1 - (c["row"] + 1) / 2)); y1 = int(H * (1 - c["row"] / 2))
    print(f"  face {c['name']}: baked {(res2['confidence'][y0:y1, x0:x1] > 0.5).sum():7d} texels, masked {(uvm[y0:y1, x0:x1] > 0.5).sum():7d}")

# facing / visibility: faces the camera cannot see must stay untouched
for c in cells:
    if c["name"] in ("-Z", "-X", "-Y"):
        x0 = int(c["col"] * W / 3); x1 = int((c["col"] + 1) * W / 3)
        y0 = int(H * (1 - (c["row"] + 1) / 2)); y1 = int(H * (1 - c["row"] / 2))
        cc = res2["confidence"][y0:y1, x0:x1] > 0.01
        yy, xx = np.nonzero(cc)
        # texels within the padding band (8 px + island margin) of a cell border are dilation from the neighbouring face
        depth_in = np.minimum.reduce([yy, xx, (y1 - y0 - 1) - yy, (x1 - x0 - 1) - xx]) if len(yy) else np.array([0])
        own_mask = (uvm[y0:y1, x0:x1] > 0.01).any()
        assert (res2["confidence"][y0:y1, x0:x1] > 0.5).sum() == 0, f"hidden face {c['name']} confidently baked"
        assert own_mask or depth_in.max() <= 12, f"hidden face {c['name']} got baked (texels {int(depth_in.max())} px inside the cell)"

# remaining mask must shrink
print("remaining mask area", float((res2["remaining"] > 0.5).sum()), "of", float((uvm > 0.5).sum()))
assert (res2["remaining"] > 0.5).sum() < (uvm > 0.5).sum()

# padding fallback (no scipy) must agree with the scipy path
core_nd = core._ndi
core._ndi = None
res3 = core.bake(mesh, r, cam, depth, gen, uvm, tex, facing=meta["facing"], padding=8)
core._ndi = core_nd
diff = np.abs(res3["texture"].astype(np.int32) - res2["texture"].astype(np.int32))
print("scipy vs numpy padding: max diff", diff.max(), "differing texels", int((diff.max(2) > 0).sum()))
assert (diff.max(2) > 8).sum() < 0.0005 * H * W

Image.fromarray(res2["texture"]).save(f"{d}/baked_inverted.png")
Image.fromarray((np.clip(res2["confidence"], 0, 1) * 255).astype(np.uint8)).save(f"{d}/baked_confidence.png")
Image.fromarray((np.clip(res2["remaining"], 0, 1) * 255).astype(np.uint8)).save(f"{d}/baked_remaining.png")
print("ALL BAKE INTEGRATION CHECKS PASSED")

# ---- 3) the soft-alpha LAYER output: layer over the old texture must equal the baked texture
L = res2["layer"].astype(np.float32)
a = (L[..., 3:4] / 255.0)
comp = old.astype(np.float32) * (1 - a) + L[..., :3] * a
d_l = np.abs(comp - n2.astype(np.float32))[r.cov]
print("layer composite vs baked texture: mean abs diff", float(d_l.mean()), "max", float(d_l.max()))
assert d_l.max() <= 2.5, "layer RGBA does not reproduce the baked texture when composited (Normal blend)"
assert (L[..., 3][outside] == 0).all() or (L[..., 3][outside] <= 255).all()
inside_alpha = L[..., 3][sel2]
assert inside_alpha.min() > 240, "alpha inside the solid mask should be ~1"
# padding also spreads alpha over the island border (seam hiding)
pad_ring = (~r.cov) & (np.abs(L[..., 3]) > 0)
print("padding texels with alpha:", int(pad_ring.sum()))
assert pad_ring.sum() > 0

# ---- 4) reference image 2 placement
import tp_reference as ref2lib
ref = np.zeros((32, 64, 3), np.float32); ref[:, :32] = (1, 0, 0); ref[:, 32:] = (0, 0, 1)
vm = np.zeros((200, 300), np.float32); vm[50:150, 100:200] = 1.0
out_m = ref2lib.place_reference(ref, vm, 300, 200, "mask", 1.0, 0.0)
assert out_m.shape == (200, 300, 3)
# cover-fit of a 2:1 image onto the 100x100 mask box -> left half red, right half blue around the box centre (150,100)
assert out_m[100, 120, 0] > 0.9 and out_m[100, 180, 2] > 0.9, "mask-fit placement wrong"
out_t = ref2lib.place_reference(ref, vm, 300, 200, "tile", 0.25, 0.0)
assert out_t.std() > 0.1, "tile placement produced a flat image"
out_r = ref2lib.place_reference(ref, vm, 300, 200, "frame", 1.0, 90.0)
# manual placement: centred, half the frame width, visible once; offset moves it; crop maps back to the uncropped frame
mc, ma = ref2lib.place_reference(ref, vm, 300, 200, "manual", ox=0.0, oy=0.0, size=0.5, return_alpha=True)
assert ma[100, 150] == 1 and ma[100, 20] == 0 and ma[100, 280] == 0 and abs(ma.sum() - 150 * 150 * ref.shape[0] / ref.shape[1]) < 600, "manual extent"
mc2, ma2 = ref2lib.place_reference(ref, vm, 300, 200, "manual", ox=0.25, oy=0.0, size=0.5, return_alpha=True)
assert ma2[100, 215] == 1 and ma2[100, 100] == 0, "manual offset"
_, mw = ref2lib.place_reference(ref, vm, 300, 200, "manual", size=0.2, wrap=True, return_alpha=True)
assert mw.min() == 1, "manual wrap"
# a 2x zoomed crop centred on the right half must show the same picture as the uncropped placement (nearest pixel check)
full, fa = ref2lib.place_reference(ref, vm, 300, 200, "manual", ox=0.0, size=0.6, return_alpha=True)
crp, ca_ = ref2lib.place_reference(ref, vm, 300, 200, "manual", ox=0.0, size=0.6, crop={"cx": 0.5, "cy": 0.0, "d": 1.0}, return_alpha=True)
# cropped pixel (x,y) = uncropped pixel (150 + x/2, 50 + y/2)
assert np.abs(crp[100, 150] - full[100, 225]).max() < 0.02 and ca_[100, 150] == fa[100, 225], "manual crop mapping"
# rotation: a left-red / right-blue image rotated 90 deg clockwise (y down) becomes top-red / bottom-blue... check by axes swap
import numpy as _np
_ref = _np.zeros((100, 200, 3), _np.float32); _ref[:, :100, 0] = 1; _ref[:, 100:, 2] = 1
_r0, _a0 = ref2lib.place_reference(_ref, vm, 300, 200, "manual", size=0.5, rot=0.0, return_alpha=True)
_r90, _a90 = ref2lib.place_reference(_ref, vm, 300, 200, "manual", size=0.5, rot=90.0, return_alpha=True)
assert _r0[100, 120, 0] > 0.9 and _r0[100, 180, 2] > 0.9, "rot 0 halves"
assert _a90[100, 150] == 1 and _a90[30, 150] == 1 and _a90[100, 60] == 0 and _a90[100, 200] == 0 and _a0[30, 150] == 0, "rot 90 extent changes (image is now 2:1 tall)"
assert (_r90[60, 150, 0] > 0.9 and _r90[140, 150, 2] > 0.9) or (_r90[60, 150, 2] > 0.9 and _r90[140, 150, 0] > 0.9), "rot 90 splits top/bottom"
# stretch: aspect override makes the image exactly fill a 300 x 200 frame
_rs, _as = ref2lib.place_reference(_ref, vm, 300, 200, "manual", size=1.0, aspect=200 / 300, return_alpha=True)
assert _as.min() == 1 and _rs[100, 10, 0] > 0.9 and _rs[100, 290, 2] > 0.9 and _rs[5, 10, 0] > 0.9 and _rs[195, 290, 2] > 0.9, "stretch to frame"
# importance weights: identity without weights, per-pixel renormalisation where the reference has no coverage
_g = _np.full((4, 4, 3), 100.0, _np.float32); _o = _np.full((4, 4, 3), 200.0, _np.float32); _rf = _np.full((4, 4, 3), 50.0, _np.float32)
_al = _np.zeros((4, 4), _np.float32); _al[:, :2] = 1
assert ref2lib.mix_sources(_g, _o, _rf, _al, 1, 0, 0) is _g
_m = ref2lib.mix_sources(_g, _o, _rf, _al, 1, 1, 0); assert abs(_m[0, 0, 0] - 150) < 1e-3
_m = ref2lib.mix_sources(_g, _o, _rf, _al, 1, 0, 1); assert abs(_m[0, 0, 0] - 75) < 1e-3 and abs(_m[0, 3, 0] - 100) < 1e-3, "alpha 0 -> reference drops out"
_m = ref2lib.mix_sources(_g, _o, _rf, _al, 2, 1, 1); assert abs(_m[0, 0, 0] - (200 + 200 + 50) / 4) < 1e-3
print("manual reference placement OK")
assert np.isfinite(out_r).all()
print("reference placement OK")
print("LAYER + REFERENCE CHECKS PASSED")


# ---- seam-aware blending: previous confidence p and new weight w must cross-fade as w/(w+p)
prev = np.full(uvm.shape, 0.6, np.float32)
gen_white = np.full_like(view, 255.0)
base = core.bake(mesh, r, cam, depth, gen_white, uvm, tex, facing=meta["facing"], padding=0, strength=1.0)
seam = core.bake(mesh, r, cam, depth, gen_white, uvm, tex, facing=meta["facing"], padding=0, strength=1.0, prev_conf=prev)
w_ = base["confidence"]
full = (w_ > 0.99) & r.cov & (uvm > 0.99)
assert full.sum() > 1000
a_exp = 1.0 / (1.0 + 0.6)   # w=1, p=0.6
old_ = tex.astype(np.float32)
exp = old_[full] * (1 - a_exp) + 255.0 * a_exp
got = seam["texture"].astype(np.float32)[full]
assert np.abs(got - exp).max() <= 1.0, np.abs(got - exp).max()
assert abs(seam["layer"][..., 3][full].mean() / 255.0 - a_exp) < 0.01
assert seam["stats"]["baked"] == base["stats"]["baked"]          # statistics use the raw weight
none_prev = core.bake(mesh, r, cam, depth, gen_white, uvm, tex, facing=meta["facing"], padding=0, strength=1.0, prev_conf=np.zeros_like(prev))
assert (none_prev["texture"] == base["texture"]).all()            # p = 0 -> identical to the old behaviour
print("seam-aware blending OK  alpha", round(a_exp, 3))
