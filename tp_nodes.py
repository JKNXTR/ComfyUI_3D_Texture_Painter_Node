"""ComfyUI nodes: Texture Painter AI (3D UI + render passes) and Texture Painter AI - Bake."""
import json
import os
import re
import time
import uuid

import numpy as np
from PIL import Image, ImageFilter

from . import tp_common as C
from . import tp_core as core
from . import tp_reference as ref2lib
from . import tp_tiles as TL
from . import tp_uvref as UR

CATEGORY = "TexturePainterAI"
BAKE_TYPE = "TEXPAINT_BAKE"


# -------------------------------------------------------------------------------------------
# small helpers
# -------------------------------------------------------------------------------------------
def _to_tensor(arr):
    import torch
    return torch.from_numpy(np.ascontiguousarray(arr))


def _to_numpy(t):
    if hasattr(t, "detach"):
        t = t.detach().cpu().numpy()
    return np.asarray(t)


def _load_png(path, mode="RGB"):
    with Image.open(path) as im:
        return np.array(im.convert(mode))


def _parse_state(state_json):
    try:
        s = json.loads(state_json or "{}")
        return s if isinstance(s, dict) else {}
    except Exception:
        return {}


def _read_commit(sdir):
    return C.read_json(os.path.join(sdir, "commit.json"))


def _hex_rgb(h, default=(255, 0, 255)):
    m = re.match(r"^#?([0-9a-fA-F]{6})$", (h or "").strip())
    if not m:
        return default
    n = int(m.group(1), 16)
    return ((n >> 16) & 255, (n >> 8) & 255, n & 255)


_COLOR_NAMES = {(255, 0, 255): "magenta", (255, 0, 0): "red", (0, 255, 0): "green", (0, 0, 255): "blue",
                (255, 255, 0): "yellow", (0, 255, 255): "cyan", (255, 128, 0): "orange", (255, 255, 255): "white"}


def _grow_feather(m, grow, feather):
    """m float32 (H,W) 0..1 -> grown + feathered mask."""
    if grow > 0:
        if core._ndi is not None:
            m = core._ndi.maximum_filter(m, size=2 * int(grow) + 1)
        else:
            im = Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8))
            for _ in range(int(grow)):
                im = im.filter(ImageFilter.MaxFilter(3))
            m = np.asarray(im).astype(np.float32) / 255.0
    if feather > 0:
        im = Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(float(feather)))
        m = np.asarray(im).astype(np.float32) / 255.0
    return np.clip(m, 0, 1).astype(np.float32)


def _umask_path(sdir, meta):
    """UV mask used for the bake: the blue transition mask when the capture was made with it, else the AI selection mask."""
    if (meta or {}).get("mask_source") == "transition":
        p = os.path.join(sdir, "bakemask.png")
        if os.path.isfile(p):
            return p
    return os.path.join(sdir, "mask.png")


# -------------------------------------------------------------------------------------------
# Node 1: the painter
# -------------------------------------------------------------------------------------------
class TexturePainterAI:
    CATEGORY = CATEGORY
    FUNCTION = "run"
    RETURN_TYPES = ("IMAGE", "IMAGE", "MASK", "IMAGE", "IMAGE", "IMAGE", "MASK", "STRING", "INT", "INT", BAKE_TYPE,
                    "IMAGE", "FLOAT", "INT", "INT", "FLOAT", "IMAGE", "IMAGE", "IMAGE", "IMAGE", "INT", "INT", "INT")
    RETURN_NAMES = ("edit_image", "view_image", "view_mask", "depth", "normal", "uv_texture", "uv_mask",
                    "prompt", "width", "height", "bake_data", "reference_image", "reference_weight", "seed", "steps", "cfg",
                    "reference_image_3", "reference_image_4", "reference_image_5", "reference_image_6",
                    "tile_count", "tile_index", "tile_total")
    DESCRIPTION = ("3D texture painter: load a UV-unwrapped model, paint a mask on it, and send the camera view + mask "
                   "to any image-edit workflow (e.g. FLUX.2 Klein). Connect the result to 'Texture Painter AI - Bake'.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "state_json": ("STRING", {"default": "{}", "multiline": False}),
                "prompt": ("STRING", {"default": "", "multiline": True,
                                      "tooltip": "Short description of what should be painted in the masked area."}),
                "style_hint": ("STRING", {"default": "flat albedo texture, no lighting, no shadows, no reflections, natural detail",
                                          "multiline": True,
                                          "tooltip": "Appended to the prompt. Keeps lighting out of the texture."}),
                "compose_prompt": ("BOOLEAN", {"default": True,
                                               "tooltip": "Wrap the prompt in an instruction that refers to the marked area."}),
                "mask_hint": (["tint_color", "gray_fill", "none"], {"default": "tint_color",
                                                                    "tooltip": "How the masked area is marked in edit_image."}),
                "hint_color": ("STRING", {"default": "#ff00ff"}),
                "hint_strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.05}),
                "mask_grow": ("INT", {"default": 6, "min": 0, "max": 128, "tooltip": "Grow the view mask (pixels)."}),
                "mask_feather": ("INT", {"default": 4, "min": 0, "max": 64, "tooltip": "Blur the view mask edge (pixels)."}),
            },
            "optional": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "control_after_generate": True,
                                 "tooltip": "Connect to the sampler noise_seed. Used by the variations strip; set control to fixed to lock it."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, state_json="{}", **kwargs):
        try:
            sid = _parse_state(state_json).get("session")
            c = _read_commit(C.session_dir(sid))
            return (c or {}).get("commit_id", "no-commit") + f":{kwargs.get('mask_grow')}:{kwargs.get('mask_feather')}:{kwargs.get('seed')}"
        except Exception:
            return "invalid"

    def run(self, state_json, prompt, style_hint, compose_prompt, mask_hint, hint_color, hint_strength,
            mask_grow, mask_feather, seed=0):
        try:
            return self._run(state_json, prompt, style_hint, compose_prompt, mask_hint, hint_color, hint_strength,
                             mask_grow, mask_feather, seed)
        except Exception as e:
            C.log_exc("Texture Painter AI failed")
            raise RuntimeError(f"{C.PREFIX} {type(e).__name__}: {e}  (full traceback is in the ComfyUI console)") from e

    def _run(self, state_json, prompt, style_hint, compose_prompt, mask_hint, hint_color, hint_strength,
             mask_grow, mask_feather, seed=0):
        state = _parse_state(state_json)
        sid = state.get("session")
        if not sid:
            raise ValueError("The node has no session yet. Open the node, load a model and press 'Sync'.")
        sdir = C.session_dir(sid)
        commit = _read_commit(sdir)
        need = ["view.png", "viewmask.png", "depth.png", "normal.png", "mask.png", "texture.png", "mesh.bin", "camera.json"]
        missing = [f for f in need if not os.path.isfile(os.path.join(sdir, f))]
        if not commit or missing:
            raise FileNotFoundError(
                "No captured view found for this node (" + (", ".join(missing) if missing else "no commit") + "). "
                "Load a model in the Texture Painter node and press 'Sync' (or just Queue again - the view is captured automatically).")
        meta = C.read_json(os.path.join(sdir, "camera.json"), {})
        view = _load_png(os.path.join(sdir, "view.png")).astype(np.float32) / 255.0
        vmask = _load_png(os.path.join(sdir, "viewmask.png"), "L").astype(np.float32) / 255.0
        depth = _load_png(os.path.join(sdir, "depth.png")).astype(np.float32) / 255.0
        normal = _load_png(os.path.join(sdir, "normal.png")).astype(np.float32) / 255.0
        tex = _load_png(os.path.join(sdir, "texture.png")).astype(np.float32) / 255.0
        umask = _load_png(_umask_path(sdir, meta), "L").astype(np.float32) / 255.0
        if umask.shape != tex.shape[:2]:  # keep uv_mask and uv_texture the same size
            umask = np.asarray(Image.fromarray((umask * 255).astype(np.uint8)).resize((tex.shape[1], tex.shape[0]), Image.BILINEAR)).astype(np.float32) / 255.0
        # ---- UV mode (toggle on the UV map): the AI edits the flat UV texture itself instead of the 3D view
        uvm = bool(meta.get("uv_mode"))
        if uvm:
            view, vmask = tex.copy(), umask.copy()
            depth = np.zeros_like(tex)
            normal = np.zeros_like(tex)
        H, W = view.shape[:2]

        tex_full = tex
        # ---- reference images projected to UV space (UV mode option "Use reference images"): one UV-space reference + confidence
        rcfg = (meta.get("uvref") or {}) if uvm else {}
        uvref_on = bool(uvm and rcfg.get("on"))
        uvr, ref_fill = None, float(np.clip(float(rcfg.get("fill", 0.6) or 0.0), 0.0, 1.0))
        if uvref_on:
            with open(os.path.join(sdir, "mesh.bin"), "rb") as f_:
                mesh_ = core.read_mesh_bin(f_.read())
            uvr = UR.project(mesh_, sdir, meta, tex.shape[1], tex.shape[0], float(rcfg.get("facing", 65.0)), 0.004)
            for note in uvr["notes"]:
                C.LOG.info("%s UV references: %s", C.PREFIX, note)
            if not uvr["used"]:
                C.LOG.warning("%s UV references are on but no reference image has a camera - place an image on the model or give it an angle.", C.PREFIX)
        ref_stack = None
        # ---- UV tiles: the UV texture is cut into equally sized overlapping tiles; each one is sent to the AI at full size
        tl_cfg = (meta.get("tile") or {}) if uvm else {}
        tile_info = None   # set when tiles are active
        tile_stack = None
        n_tiles_total, tile_idx_out, tile_count = 1, -1, 1
        if uvm and tl_cfg.get("on"):
            tiles_all = TL.grid(W, H, tl_cfg.get("cols", 2), tl_cfg.get("rows", 2), float(tl_cfg.get("overlap", 0.12)))
            non_empty = TL.nonempty(umask, tiles_all)
            n_tiles_total, tile_count = len(tiles_all), len(non_empty)
            tmode = "seq" if str(tl_cfg.get("mode", "seq")) == "seq" else "batch"
            idx = int(tl_cfg.get("index", -1))
            if tmode == "seq":
                if idx < 0 or idx >= len(tiles_all):
                    idx = non_empty[0] if non_empty else 0
                    C.LOG.warning("%s Tiles (sequential): no tile index was given - using tile %d. Run the tiles from the painter (Run all tiles) or set the index.", C.PREFIX, idx)
                sel = [tiles_all[idx]]
                tile_idx_out = idx
            else:
                sel = [tiles_all[i] for i in non_empty] or [tiles_all[0]]
                tile_idx_out = -1
            if not non_empty:
                C.LOG.warning("%s Tiles: the UV mask is empty - nothing to generate.", C.PREFIX)
            long_side = int(meta.get("tile_long") or 1024)
            ow, oh = TL.out_size(sel[0]["x1"] - sel[0]["x0"], sel[0]["y1"] - sel[0]["y0"], long_side)
            done = TL.done_region(tiles_all, tl_cfg.get("done"), W, H) if tmode == "seq" else None
            def _rs(a, mode):
                im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)) if a.ndim == 3 else Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L")
                return np.asarray(im.resize((ow, oh), mode)).astype(np.float32) / 255.0
            v_l, m_l, e_l, r_l = [], [], [], []
            for t_ in sel:
                v_ = _rs(tex[t_["y0"]:t_["y1"], t_["x0"]:t_["x1"]], Image.LANCZOS)
                m0 = umask[t_["y0"]:t_["y1"], t_["x0"]:t_["x1"]].copy()
                if done is not None:   # already painted by earlier tiles: keep it (unmarked), the AI continues the pattern from it
                    m0 = m0 * (~done[t_["y0"]:t_["y1"], t_["x0"]:t_["x1"]]).astype(np.float32)
                m_ = _grow_feather(_rs(m0, Image.BILINEAR), int(mask_grow), int(mask_feather))
                e_ = v_.copy()
                if mask_hint != "none":
                    col_ = np.array(_hex_rgb(hint_color), np.float32) / 255.0 if mask_hint == "tint_color" else np.full(3, 0.5, np.float32)
                    a_ = (m_ * float(hint_strength))[..., None]
                    e_ = v_ * (1.0 - a_) + col_[None, None, :] * a_
                if uvr is not None:   # the projected reference photos: pre-fill the marked area and hand the tile's piece over as image 2
                    rc_ = _rs(uvr["color"][t_["y0"]:t_["y1"], t_["x0"]:t_["x1"]] / 255.0, Image.BILINEAR)
                    cf_ = _rs(uvr["conf"][t_["y0"]:t_["y1"], t_["x0"]:t_["x1"]], Image.BILINEAR)
                    f_a = (m_ * cf_ * ref_fill)[..., None]
                    e_ = e_ * (1.0 - f_a) + rc_ * f_a
                    r_l.append(v_ * (1.0 - cf_[..., None]) + rc_ * cf_[..., None])
                v_l.append(v_); m_l.append(m_); e_l.append(e_)
            tile_stack = {"view": np.stack(v_l), "mask": np.stack(m_l), "edit": np.stack(e_l)}
            if r_l:
                ref_stack = np.stack(r_l)
            tile_info = {"mode": tmode, "ids": [t_["i"] for t_ in sel], "base": [int(W), int(H)], "size": [int(ow), int(oh)],
                         "tiles": sel, "masks": tile_stack["mask"]}
            view, vmask = tile_stack["view"][0], tile_stack["mask"][0]
            H, W = oh, ow

        # ---- optional "use image 2 as a reference" (set in the editor: Reference image 2)
        r2 = meta.get("ref2") or {}
        r2_path = os.path.join(sdir, "ref2.png")
        use_ref = bool(r2.get("enabled")) and bool(r2.get("has")) and os.path.isfile(r2_path) and not uvm
        r2_weight = float(np.clip(float(r2.get("weight", 0.7)), 0.0, 1.0)) if use_ref else 0.0
        if r2.get("enabled") and not use_ref:
            C.LOG.warning("%s 'Use image 2 as a reference' is on but no reference image was stored - load one in the editor.", C.PREFIX)

        if float(vmask.max()) < 0.01:
            C.LOG.warning("%s The painted mask is not visible from the current camera - the edit will change nothing.", C.PREFIX)

        vm = _grow_feather(vmask, int(mask_grow), int(mask_feather)) if tile_info is None else vmask
        edit = view.copy()
        if tile_info is not None:
            edit = tile_stack["edit"][0]
        elif mask_hint != "none":
            col = np.array(_hex_rgb(hint_color), np.float32) / 255.0 if mask_hint == "tint_color" else np.full(3, 0.5, np.float32)
            a = (vm * float(hint_strength))[..., None]
            edit = view * (1.0 - a) + col[None, None, :] * a
        if uvr is not None and tile_info is None:
            cf_ = uvr["conf"]; rc_ = uvr["color"] / 255.0
            f_a = (vm * cf_ * ref_fill)[..., None]
            edit = edit * (1.0 - f_a) + rc_ * f_a
            ref_stack = (view * (1.0 - cf_[..., None]) + rc_ * cf_[..., None])[None]

        reference = view  # reference_image output when image 2 is off: harmless copy of the main view
        ref_placed, ref_alpha_full = None, None  # kept for the Bake node's final-texture weights
        if use_ref:
            ref = _load_png(r2_path).astype(np.float32) / 255.0
            placed, ref_alpha = ref2lib.place_reference(
                ref, vmask, W, H, r2.get("mode", "mask"), r2.get("scale", 1.0), r2.get("rot", 0.0),
                ox=r2.get("ox", 0.0), oy=r2.get("oy", 0.0), size=r2.get("size", 0.5), wrap=bool(r2.get("wrap", False)), aspect=(float(r2.get("aspect") or 0) or None), sx=float(r2.get("sx") or 1.0), sy=float(r2.get("sy") or 1.0),
                crop=(meta.get("crop") if (meta.get("crop") or {}).get("enabled") else None), return_alpha=True)
            # 'original': hand Klein image 2 itself (own size and proportions, never distorted or cropped by the placement);
            # the placed composite is still blended into edit_image by the weight
            reference = ref if r2.get("original") else placed
            ref_placed, ref_alpha_full = placed, ref_alpha
            if r2_weight > 0.0:  # weight 0..1 = how much of the masked area shows image 2 instead of the marker colour
                a = (vm * r2_weight * ref_alpha)[..., None]
                edit = edit * (1.0 - a) + placed * a

        # ---- extra reference images 3..6 (editor: Reference images -> image selector). Each one works like image 2: own placement, weight,
        # mode and angle. Defaults (weight 0, original on) keep the old pass-through behaviour for saved projects.
        def _angle_text(n, slot):
            ang = re.sub(r"\s+", " ", str(slot.get("angle") or "")).strip().strip(".")[:60]
            role = re.sub(r"\s+", " ", str(slot.get("role") or "")).strip().strip(".")[:200]
            t = ""
            if ang:
                t += f" Image {n} shows the subject from the {ang}."
            if role:
                t += f" Image {n}: {role}."
            return t

        extra_imgs, extra_text, extra_used = [], "", []
        rx = meta.get("refx") or []
        for i in range(4):
            n = i + 3
            slot = rx[i] if i < len(rx) and isinstance(rx[i], dict) else {}
            path = os.path.join(sdir, f"ref{n}.png")
            if uvref_on:
                extra_imgs.append(view)   # consumed by the UV projection
            elif uvm and slot.get("has") and slot.get("enabled", True) and os.path.isfile(path):
                extra_imgs.append(_load_png(path).astype(np.float32) / 255.0)  # UV mode: raw reference, no view placement
                extra_text += _angle_text(n, slot) or f" Also use image {n} as an additional reference."
            elif slot.get("has") and slot.get("enabled", True) and os.path.isfile(path):
                img = _load_png(path).astype(np.float32) / 255.0
                w_ = float(np.clip(float(slot.get("weight", 0.0) or 0.0), 0.0, 1.0))
                placed_x, alpha_x = ref2lib.place_reference(
                    img, vmask, W, H, slot.get("mode", "mask"), slot.get("scale", 1.0), slot.get("rot", 0.0),
                    ox=slot.get("ox", 0.0), oy=slot.get("oy", 0.0), size=slot.get("size", 0.5), wrap=bool(slot.get("wrap", False)),
                    aspect=(float(slot.get("aspect") or 0) or None), sx=float(slot.get("sx") or 1.0), sy=float(slot.get("sy") or 1.0),
                    crop=(meta.get("crop") if (meta.get("crop") or {}).get("enabled") else None), return_alpha=True)
                rg_path = os.path.join(sdir, f"viewrgn{i + 1}.png")
                vr_ = meta.get("view_regions") or []
                if i < len(vr_) and vr_[i] and os.path.isfile(rg_path):
                    # this reference only acts inside the area painted for it (its view region), seen from the capture camera
                    rg = _load_png(rg_path, "L")
                    if rg.shape != alpha_x.shape:
                        rg = np.array(Image.fromarray(rg).resize((alpha_x.shape[1], alpha_x.shape[0]), Image.BILINEAR))
                    alpha_x = alpha_x * (rg.astype(np.float32) / 255.0)
                if w_ > 0.0:
                    a_ = (vm * w_ * alpha_x)[..., None]
                    edit = edit * (1.0 - a_) + placed_x * a_
                extra_imgs.append(img if slot.get("original", True) else placed_x)
                extra_used.append((n, w_))
                extra_text += _angle_text(n, slot) or f" Also use image {n} as an additional reference."
                if w_ > 0.0:
                    extra_text += f" Use image {n} as a {ref2lib.strength_word(w_)} reference for the material and pattern in the marked area."
            else:
                extra_imgs.append(view)  # not used: harmless copy of the main view (same convention as reference_image)
        if use_ref:
            extra_text = _angle_text(2, r2) + extra_text
        p = (prompt or "").strip()
        style = (style_hint or "").strip().strip(".")
        ref_text = ""
        if use_ref and r2_weight > 0.0:
            ref_text = (f" Use image 2 as a {ref2lib.strength_word(r2_weight)} reference for the material and pattern in the marked area; "
                        "blend it naturally with the surface.")
        ref_text += extra_text
        if uvr is not None and uvr["used"]:
            angs = ", ".join((re.sub(r"\s+", " ", str((dict(UR.slots(meta))[n_]).get("angle") or "")).strip().strip(".")[:60] or f"image {n_}") for n_, _c in uvr["used"])
            ref_text += (f" Use image 2 as a {ref2lib.strength_word(ref_fill)} reference for the material and pattern in the marked area: "
                         f"it shows the same area of the texture painted from the reference photos ({angs}).")
        heal = meta.get("heal") or {}
        if heal.get("on") and str(heal.get("prompt") or "").strip():   # Heal run (Heal brush J): only the heal prompt, no reference / style text
            p = re.sub(r"\s+", " ", str(heal["prompt"])).strip()
            style = ""
            ref_text = ""
        if compose_prompt:
            if mask_hint == "none":
                text = f"{p}. {style}." if style else f"{p}."
                text += ref_text
            else:
                name = "gray" if mask_hint == "gray_fill" else _COLOR_NAMES.get(_hex_rgb(hint_color), "highlighted")
                if use_ref and r2_weight >= 0.67:
                    name = "highlighted"
                text = f"Repaint only the {name} marked area: {p}."
                text += ref_text
                if style:
                    text += f" {style}."
                text += " Keep everything outside the marked area exactly unchanged."
                if uvm:
                    text += " This image is a flat UV texture map of a 3D model; keep the shapes and borders of its islands unchanged."
        else:
            text = p

        bake_data = {
            "session": sid,
            "dir": sdir,
            "commit_id": commit["commit_id"],
            "view_size": [int(W), int(H)],
            "facing": float(meta.get("facing", 0.25)),
            "tex_size": [int(tex.shape[1]), int(tex.shape[0])],
            "prompt": p,
            "seed": int(seed),
            "uv_mode": bool(uvm),
            "tile": tile_info,
            # importance weights of the final texture (generated / original viewport / placed reference 2), see Bake node
            "blend": {k: float(np.clip(float((meta.get("blend") or {}).get(k, d)), 0.0, 1.0)) for k, d in (("gen", 1.0), ("orig", 0.0), ("ref", 0.0))},
            "view_np": view.astype(np.float32), "ref_np": ref_placed, "ref_alpha_np": ref_alpha_full, "mask_np": vm.astype(np.float32),
        }
        gen = meta.get("gen") or {}
        steps = int(np.clip(int(gen.get("steps", 4)), 1, 200))
        cfg = float(np.clip(float(gen.get("cfg", 1.0)), 0.0, 30.0))
        t = _to_tensor
        if tile_info is not None:   # batch of N tiles (N = 1 in sequential mode)
            n_ = len(tile_info["ids"])
            edit_o, view_o, vm_o = tile_stack["edit"], tile_stack["view"], tile_stack["mask"]
            depth_o = normal_o = np.zeros((n_, H, W, 3), np.float32)
        else:
            edit_o, view_o, vm_o, depth_o, normal_o = edit[None], view[None], vm[None], depth[None], normal[None]
        return (
            t(edit_o), t(view_o), t(vm_o), t(depth_o), t(normal_o),
            t(tex_full[None] if tile_info is not None else tex[None]), t(umask[None]), text, int(W), int(H), bake_data,
            t(np.ascontiguousarray((ref_stack if ref_stack is not None else reference[None]).astype(np.float32))), float(r2_weight),
            int(seed), steps, cfg,
            t(np.ascontiguousarray(extra_imgs[0][None].astype(np.float32))), t(np.ascontiguousarray(extra_imgs[1][None].astype(np.float32))),
            t(np.ascontiguousarray(extra_imgs[2][None].astype(np.float32))), t(np.ascontiguousarray(extra_imgs[3][None].astype(np.float32))),
            int(tile_count), int(tile_idx_out), int(n_tiles_total),
        )


# -------------------------------------------------------------------------------------------
# Node 2: the baker
# -------------------------------------------------------------------------------------------
RESOLUTIONS = ["match texture", "512", "1024", "2048", "4096", "8192"]


def _parse_resolution(v):
    """'match texture' / None -> 0 (keep), '2048' -> 2048 (longest side)."""
    try:
        n = int(str(v).strip())
    except (TypeError, ValueError):
        return 0
    return int(np.clip(n, 64, 16384)) if n > 0 else 0


class TexturePainterAIBake:
    CATEGORY = CATEGORY
    FUNCTION = "run"
    OUTPUT_NODE = True
    RETURN_TYPES = ("IMAGE", "MASK", "MASK", "STRING")
    RETURN_NAMES = ("texture", "bake_confidence", "remaining_mask", "report")
    DESCRIPTION = ("Projects the generated image back onto the UV texture (occlusion + angle aware) inside the painted mask "
                   "and sends the result to the Texture Painter viewport.")

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "bake_data": (BAKE_TYPE,),
                "generated_image": ("IMAGE", {"tooltip": "The edited view. Must have the same framing as edit_image."}),
                "facing_override": ("FLOAT", {"default": -1.0, "min": -1.0, "max": 0.95, "step": 0.01,
                                              "tooltip": "-1 = use the 'Min facing' value from the painter node."}),
                "depth_bias": ("FLOAT", {"default": 0.003, "min": 0.0, "max": 0.05, "step": 0.0005,
                                         "tooltip": "Raise when visible texels are wrongly treated as occluded."}),
                "strength": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.0, "step": 0.01}),
                "padding": ("INT", {"default": 8, "min": 0, "max": 64, "tooltip": "Texels spread over UV island borders to hide seams."}),
            },
            "optional": {
                "align_to_reference": ("BOOLEAN", {"default": False, "label_on": "align", "label_off": "off",
                                                   "tooltip": "Image 2 only: measure how far Klein moved the picture away from where you placed it (inside the painted area) "
                                                              "and shift the generated image back before baking. Skipped when no clear match is found."}),
                "output_resolution": (RESOLUTIONS, {"default": RESOLUTIONS[0],
                                                    "tooltip": "Master resolution of the final texture (longest side). 'match texture' keeps the painter's texture size. "
                                                               "Anything else bakes at that size: the texture / bake_confidence / remaining_mask outputs use it and the "
                                                               "painter's layer stack is resized to it when the result arrives (editor limit 4096)."}),
            },
        }

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")  # always re-bake when the graph is queued

    def run(self, bake_data, generated_image, facing_override, depth_bias, strength, padding, output_resolution=None, align_to_reference=False):
        try:
            return self._run(bake_data, generated_image, facing_override, depth_bias, strength, padding, output_resolution, align_to_reference)
        except Exception as e:
            C.log_exc("Texture Painter AI Bake failed")
            raise RuntimeError(f"{C.PREFIX} {type(e).__name__}: {e}  (full traceback is in the ComfyUI console)") from e

    def _run(self, bake_data, generated_image, facing_override, depth_bias, strength, padding, output_resolution=None, align_to_reference=False):
        t0 = time.time()
        sid = bake_data["session"]
        sdir = C.session_dir(sid)
        commit = _read_commit(sdir)
        if not commit or commit.get("commit_id") != bake_data["commit_id"]:
            raise RuntimeError("The view in the Texture Painter changed after this generation was started. "
                               "Queue the workflow again so the generated image matches the captured view.")
        meta = C.read_json(os.path.join(sdir, "camera.json"))
        with open(os.path.join(sdir, "mesh.bin"), "rb") as f:
            mesh = core.read_mesh_bin(f.read())
        if meta.get("mesh_hash") and mesh.hash and meta["mesh_hash"] != mesh.hash:
            raise RuntimeError("mesh.bin does not match the captured camera data (mesh hash mismatch). Press 'Sync' in the painter node.")
        tex = _load_png(os.path.join(sdir, "texture.png"))
        H, W = tex.shape[:2]
        umask = _load_png(_umask_path(sdir, meta), "L").astype(np.float32) / 255.0
        if umask.shape != (H, W):
            umask = np.asarray(Image.fromarray((umask * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)).astype(np.float32) / 255.0
        depth = _load_png(os.path.join(sdir, "depth.png"))

        # master output resolution: resample the texture-space inputs, then bake directly at the new size
        res_note = ""
        res_warn = []
        target = _parse_resolution(output_resolution)
        if target:
            sc = target / float(max(W, H))
            W2, H2 = max(1, int(round(W * sc))), max(1, int(round(H * sc)))
            if (W2, H2) != (W, H):
                tex = np.asarray(Image.fromarray(tex).resize((W2, H2), Image.LANCZOS))
                umask = np.asarray(Image.fromarray((umask * 255).astype(np.uint8)).resize((W2, H2), Image.BILINEAR)).astype(np.float32) / 255.0
                res_note = f" Output resolution {W2}x{H2} (texture was {W}x{H})."
                W, H = W2, H2
                if max(W, H) > 4096:
                    res_warn.append(f"{W}x{H} is above the editor limit (4096): the texture outputs use it, but the painter's layer stack keeps its size.")

        g = _to_numpy(generated_image)
        tile_bd = bake_data.get("tile") if bake_data.get("uv_mode") else None
        if tile_bd is not None:
            if g.ndim == 3:
                g = g[None]
            n_need = len(tile_bd["ids"])
            if g.shape[0] < n_need:
                raise RuntimeError(f"Tiles: {n_need} tile image(s) were sent to the generator but only {g.shape[0]} came back. "
                                   "Use the sequential tile mode (the painter runs one tile per Queue), or build the workflow so it edits an image batch.")
            g = np.clip(g[:n_need, ..., :3].astype(np.float32), 0.0, 1.0) * 255.0
        elif g.ndim == 4:
            if g.shape[0] > 1:
                C.LOG.warning("%s generated_image has %d images - only the first is used.", C.PREFIX, g.shape[0])
            g = g[0]
        if tile_bd is None:
            g = np.clip(g[..., :3].astype(np.float32), 0.0, 1.0) * 255.0
        gh, gw = (g.shape[1:3] if tile_bd is not None else g.shape[:2])
        align_note = ""
        if align_to_reference and tile_bd is None:
            if bake_data.get("ref_np") is None:
                align_note = " Align: skipped (image 2 is not enabled)."
            else:
                def _fit_a(a):
                    if a is None or (a.shape[0] == gh and a.shape[1] == gw):
                        return a
                    im = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)) if a.ndim == 3 else Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L")
                    return np.asarray(im.resize((gw, gh), Image.BILINEAR)).astype(np.float32) / 255.0
                ref_a, al_a, mk_a = _fit_a(bake_data["ref_np"]), _fit_a(bake_data.get("ref_alpha_np")), _fit_a(bake_data.get("mask_np"))
                wgt = (np.ones((gh, gw), np.float32) if mk_a is None else mk_a) * (1.0 if al_a is None else al_a)
                est = ref2lib.estimate_shift(g / 255.0, ref_a, wgt, max_shift=int(np.clip(0.06 * max(gh, gw), 16, 96)))
                if est is None:
                    align_note = " Align: no clear match with the placed reference - image left as is."
                else:
                    ex, ey, sc = est
                    if abs(ex) < 0.25 and abs(ey) < 0.25:
                        align_note = f" Align: already on the placed reference (offset {ex:+.1f}, {ey:+.1f} px)."
                    else:
                        g = np.clip(ref2lib.shift_image(g, ex, ey), 0.0, 255.0)
                        align_note = f" Align: moved the generated image by {-ex:+.1f}, {-ey:+.1f} px to sit on the placed reference (match {sc:.2f})."
        bl = bake_data.get("blend") or {}
        wg_, wo_, wr_ = bl.get("gen", 1.0), bl.get("orig", 0.0), bl.get("ref", 0.0)
        mix_note = ""
        uvm = bool(bake_data.get("uv_mode"))
        if uvm:
            wo_ = wr_ = 0.0
        if (wo_ > 0 or wr_ > 0) and (bake_data.get("view_np") is not None):
            def _fit(a, mode="RGB"):
                if a is None:
                    return None
                if a.shape[0] == gh and a.shape[1] == gw:
                    return a
                img = Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8)) if a.ndim == 3 else Image.fromarray((np.clip(a, 0, 1) * 255).astype(np.uint8), "L")
                return np.asarray(img.resize((gw, gh), Image.BILINEAR)).astype(np.float32) / 255.0
            orig_g = _fit(bake_data["view_np"])
            ref_g = _fit(bake_data.get("ref_np"))
            alpha_g = _fit(bake_data.get("ref_alpha_np"))
            if wr_ > 0 and ref_g is None:
                wr_ = 0.0
                mix_note = " (reference weight ignored: image 2 is not enabled)"
            g = ref2lib.mix_sources(g, orig_g * 255.0, None if ref_g is None else ref_g * 255.0, alpha_g, wg_, wo_, wr_)
            mix_note = f" Final mix: generated {wg_:.2f} / original viewport {wo_:.2f} / reference 2 {wr_:.2f}." + mix_note
        vw, vh = bake_data["view_size"]
        warnings = []
        if uvm:
            pass
        elif max(gh, gw) < 0.9 * max(vh, vw):
            warnings.append(f"The generated image ({gw}x{gh}) is smaller than the captured view ({vw}x{vh}): detail is lost and the texture looks blurry. "
                            "Connect the painter's width / height outputs to the latent size of the generator.")
        if not uvm and abs(gw / gh - vw / vh) > 0.02:
            warnings.append(f"Generated image is {gw}x{gh} but the captured view is {vw}x{vh} (different aspect ratio) - "
                            "the projection will be misaligned. Use the width/height outputs of the painter node for the latent size.")

        t1 = time.time()
        raster, t_raster = None, 0.0
        if uvm and tile_bd is not None:
            res = self._bake_tiles(g, tex, umask, tile_bd, float(strength))
            mix_note = f" Tiles: {len(tile_bd['ids'])} tile(s) [{', '.join(str(i) for i in tile_bd['ids'])}], {tile_bd['mode']} mode."
        elif uvm:
            res = self._bake_uv(g, tex, umask, bake_data, float(strength), (gw, gh))
            raster = None
            t_raster = 0.0
        else:
            raster = core.get_raster(mesh, W, H)
            t_raster = time.time() - t1
            if raster.overlap_ratio > 0.01:
                warnings.append(f"{raster.overlap_ratio * 100:.1f}% of the UV texels are covered by overlapping UV islands - "
                                "overlapping/mirrored UVs get painted on both sides.")
            facing = float(facing_override) if facing_override >= 0 else float(bake_data.get("facing", 0.25))
            prev = None
            pc_path = os.path.join(sdir, "prevconf.png")
            if (meta.get("seam") or {}).get("enabled") and os.path.isfile(pc_path):
                prev = _load_png(pc_path, "L").astype(np.float32) / 255.0
                if prev.shape != (H, W):
                    prev = np.asarray(Image.fromarray((prev * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)).astype(np.float32) / 255.0
            res = core.bake(mesh, raster, meta["camera"], depth, g, umask, tex, facing=facing,
                            depth_bias=float(depth_bias), strength=float(strength), padding=int(padding), prev_conf=prev)
        st = res["stats"]
        if st["masked"] == 0:
            warnings.append("The UV mask is empty - nothing was painted. Paint a mask in the Texture Painter first.")
        elif st["baked"] == 0:
            warnings.append("The masked area is not visible from the captured camera (hidden or at a grazing angle).")
        warnings.extend(res_warn)
        summary = (f"{'UV mode: ' if uvm else ''}AI image {gw}x{gh} -> texture {W}x{H}. Baked {st['coverage'] * 100:.0f}% of the masked texels ({st['baked']:,}/{st['masked']:,}); "
                   f"occluded {st['occluded']:,}, grazing {st['grazing']:,}, outside view {st['outside']:,}.{mix_note}{res_note}{align_note}")
        if 0 < st["coverage"] < 0.9:
            summary += " The rest stays masked - rotate the camera and run again."

        rid = uuid.uuid4().hex[:10]
        fname, rname, lname = f"result_{rid}.png", f"remaining_{rid}.png", f"layer_{rid}.png"
        Image.fromarray(res["texture"]).save(os.path.join(sdir, fname), compress_level=3)
        Image.fromarray(res["layer"], "RGBA").save(os.path.join(sdir, lname), compress_level=3)
        Image.fromarray((np.clip(res["remaining"], 0, 1) * 255).astype(np.uint8)).save(os.path.join(sdir, rname), compress_level=3)
        self._prune(sdir)

        report = f"{summary} (raster {t_raster:.1f}s, total {time.time() - t0:.1f}s)"
        for w in warnings:
            report += "\nWARNING: " + w
        print(f"{C.PREFIX} {report}", flush=True)
        payload = {"session": sid, "commit_id": bake_data["commit_id"], "result": fname, "remaining": rname, "layer": lname,
                   "size": [int(W), int(H)], "prompt": bake_data.get("prompt", ""), "seed": int(bake_data.get("seed", 0)), "summary": summary, "warnings": warnings, "stats": {k: (float(v) if isinstance(v, float) else int(v)) for k, v in st.items()}}
        try:
            from server import PromptServer
            PromptServer.instance.send_sync("texpaint.baked", payload)
            try:
                from . import tp_bridge
                tp_bridge.notify(sid, "baked", payload)   # the standalone editor is not a ComfyUI page: it hears about the result through the bridge
            except Exception:
                C.log_exc("bridge notify skipped")
        except Exception:
            C.log_exc("Could not notify the web UI (the result files were still written)")

        t = _to_tensor
        return (t(res["texture"].astype(np.float32)[None] / 255.0), t(np.clip(res["confidence"], 0, 1)[None]),
                t(res["remaining"][None]), report)

    @staticmethod
    def _bake_tiles(g, tex, umask, tb, strength):
        """UV tiles: put every generated tile back at its place. batch = weighted blend with complementary ramps in the overlaps,
        seq = the tile only generated the not-yet-painted area, so it is simply laid over the texture through its mask."""
        H, W = tex.shape[:2]
        Wb, Hb = tb["base"]
        sx, sy = W / float(Wb), H / float(Hb)
        strength = float(np.clip(strength, 0.0, 1.0))
        layer_rgb = np.zeros((H, W, 3), np.float32)
        out = tex[..., :3].astype(np.float32).copy()
        num = np.zeros((H, W, 3), np.float32)
        den = np.zeros((H, W), np.float32)
        cov = np.zeros((H, W), np.float32)
        for k, t_ in enumerate(tb["tiles"]):
            x0, x1 = int(round(t_["x0"] * sx)), int(round(t_["x1"] * sx))
            y0, y1 = int(round(t_["y0"] * sy)), int(round(t_["y1"] * sy))
            x1, y1 = min(W, max(x1, x0 + 1)), min(H, max(y1, y0 + 1))
            rw, rh = x1 - x0, y1 - y0
            gi = np.asarray(Image.fromarray(np.clip(g[k], 0, 255).astype(np.uint8)).resize((rw, rh), Image.LANCZOS)).astype(np.float32)
            mi = np.asarray(Image.fromarray((np.clip(tb["masks"][k], 0, 1) * 255).astype(np.uint8)).resize((rw, rh), Image.BILINEAR)).astype(np.float32) / 255.0
            if tb["mode"] == "batch":
                wi = np.asarray(Image.fromarray((TL.window(t_, "batch") * 255).astype(np.uint8)).resize((rw, rh), Image.BILINEAR)).astype(np.float32) / 255.0 * mi
                num[y0:y1, x0:x1] += gi * wi[..., None]
                den[y0:y1, x0:x1] += wi
            else:
                a = mi * strength
                out[y0:y1, x0:x1] = out[y0:y1, x0:x1] * (1.0 - a[..., None]) + gi * a[..., None]
                layer_rgb[y0:y1, x0:x1] = layer_rgb[y0:y1, x0:x1] * (1.0 - a[..., None]) + gi * a[..., None]
                cov[y0:y1, x0:x1] = np.maximum(cov[y0:y1, x0:x1], a)
        if tb["mode"] == "batch":
            col = num / np.maximum(den, 1e-6)[..., None]
            cov = np.clip(den, 0.0, 1.0) * strength
            out = out * (1.0 - cov[..., None]) + col * cov[..., None]
            layer_rgb = col
        masked = int((umask > 0.5).sum())
        return {"texture": np.clip(out, 0, 255).astype(np.uint8), "layer": np.dstack([np.clip(layer_rgb, 0, 255).astype(np.uint8), (cov * 255).astype(np.uint8)]),
                "confidence": cov, "remaining": np.zeros((H, W), np.float32),
                "stats": {"masked": masked, "baked": masked, "coverage": 1.0 if masked else 0.0, "occluded": 0, "grazing": 0, "outside": 0}}

    @staticmethod
    def _bake_uv(g, tex, umask, bake_data, strength, gsize):
        """UV mode: the generated image already IS the UV texture - blend it in through the UV mask, no projection."""
        H, W = tex.shape[:2]
        def _rs(a, mode):
            if a.shape[0] == H and a.shape[1] == W:
                return a
            return np.asarray(Image.fromarray(a, mode) if mode == "L" else Image.fromarray(a).resize((W, H), Image.LANCZOS))
        g8 = np.clip(g, 0, 255).astype(np.uint8)
        if g8.shape[0] != H or g8.shape[1] != W:
            g8 = np.asarray(Image.fromarray(g8).resize((W, H), Image.LANCZOS))
        m = bake_data.get("mask_np")
        if m is None:
            m = umask
        elif m.shape[0] != H or m.shape[1] != W:
            m = np.asarray(Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8)).resize((W, H), Image.BILINEAR)).astype(np.float32) / 255.0
        a = np.clip(m.astype(np.float32) * float(np.clip(strength, 0.0, 1.0)), 0.0, 1.0)
        out = np.clip(tex[..., :3].astype(np.float32) * (1.0 - a[..., None]) + g8.astype(np.float32) * a[..., None], 0, 255).astype(np.uint8)
        layer = np.dstack([g8, (a * 255).astype(np.uint8)])
        masked = int((umask > 0.5).sum())
        return {"texture": out, "layer": layer, "confidence": a, "remaining": np.zeros((H, W), np.float32),
                "stats": {"masked": masked, "baked": masked, "coverage": 1.0 if masked else 0.0, "occluded": 0, "grazing": 0, "outside": 0}}

    @staticmethod
    def _prune(sdir, keep=6):
        try:
            files = sorted((f for f in os.listdir(sdir) if C.RESULT_RE.match(f)), key=lambda f: os.path.getmtime(os.path.join(sdir, f)), reverse=True)
            for f in files[keep * 3:]:
                os.remove(os.path.join(sdir, f))
        except Exception:
            C.log_exc("Could not prune old results")


NODE_CLASS_MAPPINGS = {
    "TexturePainterAI": TexturePainterAI,
    "TexturePainterAIBake": TexturePainterAIBake,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "TexturePainterAI": "Texture Painter AI (3D)",
    "TexturePainterAIBake": "Texture Painter AI - Bake",
}
