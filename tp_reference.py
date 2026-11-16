"""'Use image 2 as a reference': places a second reference image over the masked area of the captured view."""
import numpy as np

try:
    from . import tp_core as core
except ImportError:  # imported stand-alone by the tests
    import tp_core as core

MODES = ("mask", "frame", "tile", "manual")


def place_reference(ref, vmask, W, H, mode="mask", scale=1.0, rot=0.0, ox=0.0, oy=0.0, size=0.5, wrap=False, crop=None,
                    return_alpha=False, aspect=None, sx=1.0, sy=1.0):
    """ref (rh,rw,3) float32 0..1, vmask (H,W) float32 0..1 -> (H,W,3) float32 0..1.

    mode 'mask'  : the image covers the bounding box of the masked area (centred, cover-fit)
         'frame' : the image covers the whole captured frame
         'tile'  : the image is repeated at a fixed pixel scale
         'manual': placed by hand in the editor (Place on model). ox/oy = image centre offset from the frame centre and
                   size = image width, all as fractions of the (uncropped) frame width; wrap repeats the image,
                   otherwise it is visible only once (alpha 0 outside). crop = {cx,cy,d} maps cropped captures back
                   onto the uncropped frame the editor showed.
    aspect (manual only) = displayed height / displayed width; None keeps the image proportions, other values stretch it.
    sx / sy (manual only) = extra scale of the displayed width / height (1 = none), applied on top of size and aspect.
    scale > 1 makes the image larger (zoom in), < 1 smaller (it then repeats). rot in degrees.
    """
    rh, rw = ref.shape[:2]
    scale = max(0.05, float(scale))
    if mode not in MODES:
        mode = "mask"
    if mode == "mask":
        ys, xs = np.nonzero(vmask > 0.05)
        if xs.size:
            x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
        else:
            x0, y0, x1, y1 = 0, 0, W, H
        bw, bh = max(1, x1 - x0), max(1, y1 - y0)
        cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        cs = max(bw / rw, bh / rh) * scale
    elif mode == "frame":
        cx, cy = W / 2.0, H / 2.0
        cs = max(W / rw, H / rh) * scale
    else:
        cx, cy = W / 2.0, H / 2.0
        cs = scale * (W / 1024.0)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    px, py = xx + 0.5, yy + 0.5
    if mode == "manual":
        if crop and float(crop.get("d", 2.0)) < 1.99:  # cropped capture -> position in the uncropped frame
            nx = float(crop["cx"]) + (px / W * 2.0 - 1.0) * float(crop["d"]) / 2.0
            ny = float(crop["cy"]) + (1.0 - py / H * 2.0) * float(crop["d"]) / 2.0
            px, py = (nx + 1.0) / 2.0 * W, (1.0 - ny) / 2.0 * H
        cx, cy = W / 2.0 + float(ox) * W, H / 2.0 + float(oy) * W
        cs = max(0.02, float(size)) * W / rw
    cs = max(cs, 1e-4)
    csy = cs * ((float(aspect) * rw / rh) if (mode == "manual" and aspect) else 1.0)
    if mode == "manual":
        cs, csy = cs * max(0.05, float(sx)), csy * max(0.05, float(sy))
    dx, dy = px - cx, py - cy
    a = np.deg2rad(float(rot))
    ca, sa = float(np.cos(a)), float(np.sin(a))
    u = (ca * dx + sa * dy) / cs + rw / 2.0
    v = (-sa * dx + ca * dy) / csy + rh / 2.0
    alpha = np.ones((H, W), np.float32)
    if mode == "manual" and not wrap:
        alpha = ((u >= 0) & (u < rw) & (v >= 0) & (v < rh)).astype(np.float32)
        u, v = np.clip(u, 0, rw - 1e-3), np.clip(v, 0, rh - 1e-3)
    else:
        u, v = np.mod(u, rw), np.mod(v, rh)
    col = core.bilinear(ref.astype(np.float32), (u - 0.5).ravel(), (v - 0.5).ravel())
    col = col.reshape(H, W, 3).astype(np.float32)
    return (col, alpha) if return_alpha else col


def strength_word(w):
    return "subtly" if w < 0.34 else ("clearly" if w < 0.67 else "strongly")


def mix_sources(gen, orig, ref, ref_alpha, wg=1.0, wo=0.0, wr=0.0):
    """Final-texture importance weights. All images float RGB (0..255 or 0..1, same scale), same H x W.
    result = (wg*gen + wo*orig + wr*alpha*ref) / (wg + wo + wr*alpha)  -- per pixel, so a reference that does not cover a pixel
    (alpha 0) simply drops out there. With wo = wr = 0 the generated image is returned unchanged."""
    wg, wo, wr = max(0.0, float(wg)), max(0.0, float(wo)), max(0.0, float(wr))
    if wo <= 0.0 and wr <= 0.0:
        return gen
    if wg + wo + wr <= 0.0:
        return gen
    a = np.ones(gen.shape[:2], np.float32) if ref_alpha is None else ref_alpha.astype(np.float32)
    num = wg * gen
    den = np.full(gen.shape[:2], wg, np.float32)
    if wo > 0.0 and orig is not None:
        num = num + wo * orig
        den = den + wo
    if wr > 0.0 and ref is not None:
        num = num + (wr * a)[..., None] * ref
        den = den + wr * a
    return (num / np.maximum(den, 1e-6)[..., None]).astype(np.float32)


def estimate_shift(gen, ref, weight, max_shift=48, min_score=0.2):
    """Where is the generated picture relative to the placed reference? (dx, dy, score) in pixels, or None.
    gen / ref (H,W,3) float, weight (H,W) 0..1 = the area that is compared (painted area x reference footprint).
    Normalised cross-correlation of the mean-removed grey images inside the weight, searched within +-max_shift px.
    gen(x + (dx, dy)) ~ ref(x): sampling gen at x + (dx, dy) lines it up with the reference."""
    H, W = ref.shape[:2]
    w = np.clip(weight.astype(np.float32), 0.0, 1.0)
    if float(w.sum()) < 64:
        return None
    lum = np.array([0.299, 0.587, 0.114], np.float32)
    a = (gen[..., :3].astype(np.float32) * lum).sum(-1)
    b = (ref[..., :3].astype(np.float32) * lum).sum(-1)
    ma = float((a * w).sum() / w.sum()); mb = float((b * w).sum() / w.sum())
    a = (a - ma) * w
    b = (b - mb) * w
    na, nb = float(np.sqrt((a * a).sum())), float(np.sqrt((b * b).sum()))
    if na < 1e-6 or nb < 1e-6:
        return None
    PH, PW = H + 2 * max_shift, W + 2 * max_shift   # zero padding -> linear (not circular) correlation
    fa = np.fft.rfft2(a, s=(PH, PW)); fb = np.fft.rfft2(b, s=(PH, PW))
    c = np.fft.irfft2(fa * np.conj(fb), s=(PH, PW)) / (na * nb)   # c[s] = sum_x a(x+s) b(x)
    ms = int(max_shift)
    dys = np.arange(-ms, ms + 1); dxs = np.arange(-ms, ms + 1)
    win = c[np.ix_(dys % PH, dxs % PW)]
    iy, ix = np.unravel_index(int(np.argmax(win)), win.shape)
    score = float(win[iy, ix])
    if score < min_score:
        return None

    def sub(m, i, j, vertical):   # parabolic sub-pixel refinement
        n = m.shape[0] if vertical else m.shape[1]
        if i <= 0 or i >= n - 1:
            return 0.0
        l, cc, r = (m[i - 1, j], m[i, j], m[i + 1, j]) if vertical else (m[j, i - 1], m[j, i], m[j, i + 1])
        d = l - 2 * cc + r
        return 0.0 if abs(d) < 1e-9 else float(np.clip(0.5 * (l - r) / d, -0.5, 0.5))
    dy = float(dys[iy]) + sub(win, iy, ix, True)
    dx = float(dxs[ix]) + sub(win, ix, iy, False)
    return dx, dy, score


def shift_image(img, dx, dy):
    """out(x) = img(x + (dx, dy)), bilinear, edge-clamped."""
    H, W = img.shape[:2]
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    ch = img.shape[2] if img.ndim == 3 else 1
    src = img.reshape(H, W, ch).astype(np.float32)
    out = core.bilinear(src, (xx + dx).ravel(), (yy + dy).ravel()).reshape(H, W, ch)
    return out if img.ndim == 3 else out[..., 0]
