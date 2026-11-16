"""Builds the ready-made Texture Painter AI workflows from the official ComfyUI FLUX.2 Klein 9B image-edit template.
Run:  python build_workflows.py   (needs _klein_template.json next to it; writes two .json files here)
"""
import copy, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
tpl = json.load(open(os.path.join(HERE, "_klein_template.json"), encoding="utf-8"))

OUT = ["edit_image", "view_image", "view_mask", "depth", "normal", "uv_texture", "uv_mask", "prompt", "width", "height",
       "bake_data", "reference_image", "reference_weight", "seed", "steps", "cfg",
       "reference_image_3", "reference_image_4", "reference_image_5", "reference_image_6"]
OUT_T = ["IMAGE", "IMAGE", "MASK", "IMAGE", "IMAGE", "IMAGE", "MASK", "STRING", "INT", "INT", "TEXPAINT_BAKE",
         "IMAGE", "FLOAT", "INT", "INT", "FLOAT", "IMAGE", "IMAGE", "IMAGE", "IMAGE"]


def build(with_reference):
    d = copy.deepcopy(tpl)
    keep_prefix = "65c2" if with_reference else "7b34"
    sg_node_id = 92 if with_reference else 75
    sg = next(s for s in d["definitions"]["subgraphs"] if s["id"].startswith(keep_prefix))
    d["definitions"]["subgraphs"] = [sg]
    sgn = copy.deepcopy(next(n for n in d["nodes"] if n["id"] == sg_node_id))
    note = copy.deepcopy(next(n for n in d["nodes"] if n["type"] == "MarkdownNote"))
    sgn["mode"] = 0
    sgn["pos"] = [760, 140]
    sgn["order"] = 1
    for n in sgn["inputs"]:
        n["link"] = None
    for o in sgn["outputs"]:
        o["links"] = []

    PID, BID = 200, 201
    L = {"edit": 301, "ref": 302, "text": 303, "seed": 304, "bake": 305, "gen": 306}
    painter = {
        "id": PID, "type": "TexturePainterAI", "pos": [60, 140], "size": [560, 760], "flags": {}, "order": 0, "mode": 0,
        "inputs": [], "outputs": [], "properties": {"Node name for S&R": "TexturePainterAI"},
        "widgets_values": ["{}", "", "flat albedo texture, no lighting, no shadows, no reflections, natural detail",
                           True, "tint_color", "#ff00ff", 1.0, 6, 4, 0, "fixed"],
    }
    for i, (nm, tp) in enumerate(zip(OUT, OUT_T)):
        painter["outputs"].append({"name": nm, "type": tp, "links": []})
    links = []

    def link(lid, o_id, o_slot, t_id, t_slot, typ):
        links.append([lid, o_id, o_slot, t_id, t_slot, typ])
        node_by_id[o_id]["outputs"][o_slot]["links"].append(lid)
        node_by_id[t_id]["inputs"][t_slot]["link"] = lid

    bake = {
        "id": BID, "type": "TexturePainterAIBake", "pos": [1220, 140], "size": [360, 230], "flags": {}, "order": 2, "mode": 0,
        "inputs": [{"name": "bake_data", "type": "TEXPAINT_BAKE", "link": None},
                   {"name": "generated_image", "type": "IMAGE", "link": None}],
        "outputs": [{"name": n, "type": t, "links": []} for n, t in
                    [("texture", "IMAGE"), ("bake_confidence", "MASK"), ("remaining_mask", "MASK"), ("report", "STRING")]],
        "properties": {"Node name for S&R": "TexturePainterAIBake"},
        "widgets_values": [-1.0, 0.003, 1.0, 8, False, "match texture"],
    }
    node_by_id = {PID: painter, BID: bake, sg_node_id: sgn}

    # subgraph node inputs: keep template entries, add the seed input
    by_name = {i["name"]: i for i in sgn["inputs"]}
    if "noise_seed" not in by_name:
        sgn["inputs"].append({"name": "noise_seed", "type": "INT", "widget": {"name": "noise_seed"}, "link": None})
    names = [i["name"] for i in sgn["inputs"]]
    slot = {n: names.index(n) for n in names}

    link(L["edit"], PID, 0, sg_node_id, slot["image"], "IMAGE")
    if with_reference:
        link(L["ref"], PID, 11, sg_node_id, slot["image_1"], "IMAGE")
    link(L["text"], PID, 7, sg_node_id, slot["text"], "STRING")
    link(L["seed"], PID, 13, sg_node_id, slot["noise_seed"], "INT")
    link(L["bake"], PID, 10, BID, 0, "TEXPAINT_BAKE")
    link(L["gen"], sg_node_id, 0, BID, 1, "IMAGE")

    note["pos"] = [60, 940]
    note["order"] = 3
    title = "Texture Painter AI + FLUX.2 Klein 9B " + ("(with reference image 2)" if with_reference else "(single image)")
    howto = (f"## {title}\n\n1. Load a model in the Texture Painter node, paint a mask, write the prompt.\n"
             "2. Queue. The view + mask go through Klein, then **Texture Painter AI - Bake** projects the result onto the UV texture.\n"
             "3. `seed` of the painter drives the sampler seed (set its control to **fixed** for the variations strip).\n"
             + ("4. Enable *Reference image 2* in the painter's Reference panel to use it (output `reference_image`).\n" if with_reference else
                "4. Need a reference image? Use the *with_reference* workflow instead.\n")
             + "\n---\n\n")
    note["widgets_values"] = [howto + note["widgets_values"][0]]

    d["nodes"] = [painter, sgn, bake, note]
    d["links"] = links
    d["groups"] = []
    d["last_node_id"] = 201
    d["last_link_id"] = 306
    d["id"] = ("b1f0c9a4-7c1e-4f55-9b0e-" + ("2a" if with_reference else "1a") + "0000000000")[:36]
    d["extra"] = {k: v for k, v in d.get("extra", {}).items() if k in ("frontendVersion", "workflowRendererVersion")}
    d["extra"]["ds"] = {"scale": 0.8, "offset": [0, 0]}
    return d


def validate(d):
    ids = {n["id"] for n in d["nodes"]}
    assert len(ids) == len(d["nodes"])
    lk = {l[0]: l for l in d["links"]}
    assert len(lk) == len(d["links"])
    for lid, o, os_, t, ts, typ in d["links"]:
        assert o in ids and t in ids, lid
        on = next(n for n in d["nodes"] if n["id"] == o); tn = next(n for n in d["nodes"] if n["id"] == t)
        assert lid in on["outputs"][os_]["links"], f"output side of link {lid}"
        assert tn["inputs"][ts]["link"] == lid, f"input side of link {lid}"
        assert on["outputs"][os_]["type"] == typ and tn["inputs"][ts]["type"] == typ, f"type of link {lid}"
    for n in d["nodes"]:
        for i in n.get("inputs", []):
            if i.get("link") is not None:
                assert i["link"] in lk
        for o in n.get("outputs", []):
            for l in o.get("links") or []:
                assert l in lk
    assert d["last_link_id"] >= max(lk) and d["last_node_id"] >= max(ids)
    sg_ids = {s["id"] for s in d["definitions"]["subgraphs"]}
    for n in d["nodes"]:
        if len(n["type"]) == 36 and n["type"].count("-") == 4:
            assert n["type"] in sg_ids, "subgraph definition missing"
    return True


if __name__ == "__main__":
    for ref, name in [(False, "texture_painter_klein9b_distilled.json"), (True, "texture_painter_klein9b_with_reference.json")]:
        wf = build(ref)
        validate(wf)
        json.dump(wf, open(os.path.join(HERE, name), "w", encoding="utf-8"), indent=1, ensure_ascii=False)
        print("wrote", name, "nodes", len(wf["nodes"]), "links", len(wf["links"]))
