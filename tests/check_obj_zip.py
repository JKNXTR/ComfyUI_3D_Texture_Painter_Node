"""Validates the OBJ+MTL+PNG zip written by the editor: zip integrity, OBJ counts, UV orientation (v up)."""
import json, sys, zipfile, io
from PIL import Image

path, expect = sys.argv[1], json.loads(sys.argv[2])  # expect: {"colors": [[r,g,b]*6], "extent": 1.0}
z = zipfile.ZipFile(path)
assert z.testzip() is None, "zip CRC error"
names = z.namelist()
obj = [n for n in names if n.endswith(".obj")][0]; mtl = [n for n in names if n.endswith(".mtl")][0]; png = [n for n in names if n.endswith(".png")][0]
txt = z.read(obj).decode()
v = [list(map(float, l.split()[1:4])) for l in txt.splitlines() if l.startswith("v ")]
vt = [list(map(float, l.split()[1:3])) for l in txt.splitlines() if l.startswith("vt ")]
f = [l.split()[1:] for l in txt.splitlines() if l.startswith("f ")]
assert len(v) == len(vt) == 36 and len(f) == 12, (len(v), len(vt), len(f))
assert f"mtllib {mtl}" in txt and "map_Kd " + png in z.read(mtl).decode()
ext = max(abs(c) for p in v for c in p)
assert abs(ext - expect["extent"]) < 1e-3, ext
im = Image.open(io.BytesIO(z.read(png))).convert("RGB")
W, H = im.size
bad = 0
for face in range(6):
    us = [vt[face * 6 + k] for k in range(6)]
    u = sum(a[0] for a in us) / 6; vv = sum(a[1] for a in us) / 6
    col = im.getpixel((int(u * W), int((1 - vv) * H)))  # OBJ: v up
    want = expect["colors"][face]
    ok = all(abs(col[i] - want[i]) <= 6 for i in range(3))
    print("face", face, "uv", round(u, 2), round(vv, 2), "sampled", col, "expected", want, "OK" if ok else "BAD")
    bad += not ok
assert bad == 0, "OBJ UV orientation / texture mismatch"
print("OBJ ZIP OK", names)
