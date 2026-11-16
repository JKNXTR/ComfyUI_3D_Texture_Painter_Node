# Texture Painter AI - step-by-step tutorial: every output, wired to FLUX.2 Klein 9B

> The two ready-made workflows in `workflows/` follow exactly this wiring. They were built from ComfyUI's official
> **"Flux.2 [Klein] 9B: Image Edit"** template and pass a structural check, but they have **not been opened in a real ComfyUI**.
> If one fails to load, build it by hand with Part 2 and tell me the error.

## Part 0 - Before you start
1. Update ComfyUI to a version that has the **Flux.2 [Klein] 9B: Image Edit** template (Workflow -> Browse Templates -> Image Edit).
2. Download the models that template lists (it has a *Model Links* note): `flux-2-klein-9b-fp8.safetensors` (diffusion_models), `qwen_3_8b_fp8mixed.safetensors` (text_encoders), `full_encoder_small_decoder.safetensors` (vae).
3. Copy the `ComfyUI-TexturePainterAI` folder into `ComfyUI/custom_nodes/`, restart ComfyUI, hard-refresh the browser (Ctrl+F5).
4. Add the nodes: double-click the canvas and search **Texture Painter AI (3D)** and **Texture Painter AI - Bake**.

## Part 1 - What each output is
### Node 1: *Texture Painter AI (3D)*
| # | Output | Type | What it is | Connect it to |
|---|--------|------|-----------|---------------|
| 1 | `edit_image` | IMAGE | The camera view the way Klein should see it: the painted area is tinted (`hint_color`) or grey, optionally with reference image 2 blended in | Klein subgraph **image** (the picture to edit) |
| 2 | `view_image` | IMAGE | The plain camera view, no marker | Preview Image, or a second Klein input if you want to give the model the clean view |
| 3 | `view_mask` | MASK | The painted mask as seen from the camera (grown/feathered by `mask_grow`/`mask_feather`) | Preview, or an inpaint/composite node of your own |
| 4 | `depth` | IMAGE | Depth of the visible surface from this camera | Optional: depth-based ControlNet in a non-Klein workflow, or an extra reference image |
| 5 | `normal` | IMAGE | Surface normals from this camera | Same as depth |
| 6 | `uv_texture` | IMAGE | The current composited UV texture (all visible layers) | Preview / Save Image; or any node that wants the whole texture |
| 7 | `uv_mask` | MASK | The painted mask in UV space | Preview; checking coverage |
| 8 | `prompt` | STRING | Your prompt wrapped in an instruction that refers to the marked area, plus the style hint and the image-2 sentence | Klein subgraph **text** |
| 9 | `width` | INT | Width of the captured view | Optional: latent / scheduler width |
| 10 | `height` | INT | Height of the captured view | Optional: latent / scheduler height |
| 11 | `bake_data` | TEXPAINT_BAKE | A private package (session, camera, importance weights, ...) | **Only** the Bake node's `bake_data` |
| 12 | `reference_image` | IMAGE | Image 2 placed over the view (or the original image 2 when "Send ORIGINAL image 2" is on). With image 2 off it is a harmless copy of the view | Klein subgraph **image_1** (second reference) |
| 13 | `reference_weight` | FLOAT | The image-2 weight (0-1) | Optional math/switch nodes |
| 14 | `seed` | INT | The painter's seed widget (set its control to **fixed**) | Klein **noise_seed** |
| 15 | `steps` | INT | Steps from the editor's Generation panel | Optional: scheduler steps (see 4.2) |
| 16 | `cfg` | FLOAT | CFG from the editor's Generation panel | Optional: CFG guider (see 4.2) |

### Node 2: *Texture Painter AI - Bake*
Inputs: `bake_data` (from the painter), `generated_image` (Klein's decoded result), `facing_override`, `depth_bias`, `strength`, `padding`, and the optional **`output_resolution`** (master resolution, Part 5) and **`align_to_reference`** (Part 7).

| # | Output | Type | What it is |
|---|--------|------|-----------|
| 1 | `texture` | IMAGE | The new UV texture after baking |
| 2 | `bake_confidence` | MASK | How well each texel could be baked (1 = seen straight on, 0 = not seen) |
| 3 | `remaining_mask` | MASK | The masked texels that are still not painted - rotate the camera and run again |
| 4 | `report` | STRING | Human-readable result and warnings |

The Bake node also sends the result to the painter's 3D view: review it with the *compare* toggle, then **Apply** or **Discard**.

## Part 2 - Build the basic workflow (painter -> Klein 9B -> Bake)
1. **Open the template.** Browse Templates -> *Flux.2 [Klein] 9B: Image Edit*. You get *Load Image*, one subgraph node *Image Edit (FLUX.2 Klein 9B Distilled)* and *Save Image*.
2. **Delete *Load Image*** and add **Texture Painter AI (3D)**.
3. **Load a model in the painter** (Load model, .obj/.glb/.gltf/.fbx). Fix the orientation with *Model transform* if needed. Orbit with the middle mouse, paint the area you want to change with the brush (B). Type the prompt in the node's **prompt** box ("weathered red brick", ...).
4. **Wire the picture:** painter `edit_image` -> subgraph **image**.
5. **Wire the prompt:** painter `prompt` -> subgraph **text**. (The subgraph's own prompt box becomes an input link; this is intended.)
6. **Wire the seed:** painter `seed` -> subgraph **noise_seed**, and set the painter's seed *control after generate* to **fixed**. (Required for the variations strip; with "randomize" every queue gives a new image.)
7. **Delete *Save Image*** (or keep it to also save Klein's raw output) and add **Texture Painter AI - Bake**.
8. **Wire the Bake node:** painter `bake_data` -> Bake `bake_data`; subgraph output **IMAGE** -> Bake `generated_image`.
9. **Queue.** The view is captured automatically, Klein edits it, Bake projects the result into UV space and it appears in the editor. Review -> **Apply** (it becomes a layer named `AI: <prompt>`; Ctrl+Z undoes it).
10. **Next view.** Orbit to another side, paint the rest, Queue again. The *Coverage* panel suggests the next view and can batch several views automatically.

Checklist: the editor's **Help (?)** shows a live wiring checklist of these connections.

## Part 3 - Using reference image 2 (second picture for Klein)
1. In the editor open *Reference image 2*, load a picture, tick **Use image 2 as a reference**, set the weight.
2. Use the workflow `texture_painter_klein9b_with_reference.json`, or in the template use the two-image subgraph variant (inputs **image** and **image_1**).
3. Wire painter `edit_image` -> **image**, painter `reference_image` -> **image_1**, `prompt` -> **text**, `seed` -> **noise_seed**.
4. Choose how image 2 is placed (*cover mask / frame / tile / manual*, scale, rotation, **Place on model** mode) and the fit options. Tick **Send ORIGINAL image 2** if Klein should get the picture unchanged instead of the placed composite.
5. Importance weights (generated / original viewport / reference 2) decide what the final texture is made of; they are applied inside the Bake node. Defaults (1 / 0 / 0) = pure generated result.
Klein has no per-reference weight; the weight blends image 2 into `edit_image` and adds a "subtle / clear / strong reference" phrase to the prompt.

## Part 3b - Several reference images (images 3, 4, 5)
Open the Reference panel and pick **Image 3** (up to 6) in the *Reference image* list. Load it, give it an angle ("back", "left side" ...) and, if useful, a role ("leather material"); *Save current view as its angle* remembers the camera so you can come back with *Go to its angle*. Then use it like image 2: *Place on model*, the fit options and the Weight slider (0 = Klein gets the picture untouched, above 0 it is also blended into the masked area). Angle and role are added to the prompt ("Image 3 shows the subject from the back."). On the painter node connect `reference_image_3` ... `_6` to the next reference inputs of your Klein workflow (image 2 = `reference_image`). Unused slots output a copy of the view - do not connect them. Tip: set the painter `seed` control to **fixed** to compare variations with identical noise.

## Part 3e - Switching views: using the matching reference image for each side
Every reference image (3-6; image 2 works the same) can remember **its own camera angle** and its **own region** on the model:
1. Load the reference of that side (e.g. a photo of the back) into image N and give it an *angle label* ("back") and a *role* ("brick wall, weathered"). Both go into the prompt automatically (see the *Prompt preview* under the UV view).
2. Orbit to the matching view (view drop-down: *Back*, or your own) and press **Save angle** in that image's panel. From now on the drop-down lists it under *Reference image angles* - choosing it jumps the camera there **and makes image N the active reference**. (A normal saved view can be linked to an image with the second drop-down.)
3. Put the image on the model: **Place** (drag = move, wheel = size, Alt+drag = rotate, Scale X / Y) and set its **weight** (how strongly it shows in the masked area). Use *Original* to hand Klein the image itself.
4. Paint in the **view region** colour of that image (panel *View regions*, or right-click in the 3D view and pick the view number) the part of the model this side is responsible for, then **= AI mask**. Only this image acts inside its region.
5. Queue. Switch to the next side (drop-down), repeat 3-4 with the next image / region, queue again. Every bake is merged into the same texture (seam-aware); *Combine layers* + transition prompts smooth the joints. Images that are not meant for this side: untick *use* (or set weight 0) so they do not influence the prompt.
If the result looks different from the original texture, give the AI layer a **colour adjustment** (Layers panel: saturation, contrast, levels) - non-destructive.

## Part 3c - Saving everything (Save project as...)
*Export -> Save project as...* (or *Presets & state -> Save project as...*): type a name, choose **where** (ComfyUI computer folder / this computer's folder / download), tick whether to also write the loose files and the flattened texture, press **Save**. The window shows the final path. Re-open later with *Open project...*. Presets store only settings; this stores the whole job (model, layers, generated images, masks, references).

## Part 3d - Repainting only the seams (transition prompts) and the final harmonize pass
**Seams.** 1) Brush -> *Brush paints on* -> *Transition (blue)*, paint over the seam / join areas. 2) Open *Transition prompts*, pick a category and a prompt (e.g. Skin -> "Match pores and wrinkles"), press *Use as prompt*: the AI now uses the blue mask, the prompt is set and the mask edges are softened. 3) Queue the workflow (the usual painter -> Klein -> Bake chain) and apply the result. Switch the checkbox off to go back to the normal AI selection.
**Final harmonize.** 1) *Final harmonize -> Step 1* merges your layers without AI. 2) Pick a normalization prompt, press *Step 2*, queue; rotate to the next view, repeat (4-8 views; the Coverage panel suggests cameras). Lower the Bake strength if details get repainted. After the pass press *Clear the AI selection again* to paint normally.

## Part 4 - The optional outputs
### 4.1 `width` / `height`
The template computes the latent size from the input image. If you prefer to control it, open the subgraph (icon at the node's top-right), and link `width`/`height` to **EmptyFlux2LatentImage** and **Flux2Scheduler** (their width/height widgets must first be converted to inputs: right-click the widget -> *Convert to input* / drag a link onto it).
Keep the aspect ratio equal to the captured view; the Bake node warns if it differs.

### 4.2 `steps` / `cfg`
These live inside the subgraph (**Flux2Scheduler** `steps`, **CFGGuider** `cfg`). Open the subgraph, expose the two widgets as inputs, add them as subgraph inputs and link painter `steps` / `cfg` to them. For the distilled Klein 9B keep cfg 1 and 4 steps; use more steps / higher cfg only with a non-distilled model.

### 4.3 `view_image`, `view_mask`, `depth`, `normal`, `uv_texture`, `uv_mask`
Drop **Preview Image** nodes on them (convert MASK with *Convert Mask to Image* if you want to see it as a picture). They are for inspection and for your own extensions - the basic workflow does not need them. `view_mask` + `view_image` are what you would feed an inpainting/compositing chain; `depth` and `normal` are what a depth/normal ControlNet would take in a model that has one.

### 4.4 `bake_confidence`, `remaining_mask`, `report`, `texture`
Add Preview Image / *Show Text* nodes. `remaining_mask` empty = everything painted. `report` explains zero results (empty mask, hidden area, aspect mismatch, stale view).

## Part 5 - Master output resolution (Bake node)
`output_resolution` (last widget of the Bake node): **match texture** (default) or 512 / 1024 / 2048 / 4096 / 8192 (longest side).
- The bake runs at that size, so `texture`, `bake_confidence` and `remaining_mask` are that size.
- When the result arrives the editor **resizes the whole layer stack** to it (one undo step; all layers are resampled; masks keep their own resolution). From then on "match texture" means the new size.
- The editor limit is 4096. At 8192 the outputs are 8192 but the editor keeps its size (a warning is shown).
- Painting detail is limited by the Klein image (about 1 megapixel), so a very high resolution mostly gives a smoother, denser texture rather than new detail; 2048-4096 is the usual sweet spot.

## Part 6b - Placing image 2 precisely (Scale X / Y)
In *Reference image 2 -> Place on model...*: **Size** scales the picture uniformly (mouse wheel too), **Scale X (width)** and **Scale Y (height)** stretch it on one axis only (100% = undistorted, *1:1 X/Y* resets). Click any number to type an exact value; with the field focused the mouse wheel fine-tunes it. The Python side uses the same maths as the preview, so what you see in the dashed frame is what is sent.

## Part 6c - Combining several generations into one texture
After painting from a few views (each Queue + Apply adds an AI layer with a confidence alpha):
1. Open **Combine layers**. Tick the layers to merge (AI layers are ticked by default; the base texture is not) and set **Importance** (100% = full say, 25% = weak).
2. Choose the **Mode**: *Weighted average* for an even mix, *Best view* when the best-seen layer should win, *Priority* when you simply want a stack order by importance.
3. Keep **Detail = Multiband** (soft colour transitions, crisp detail). Raise *Blend width* if you still see seams.
4. Turn **Normalize colours** on if the generations differ in brightness/tint; pick the anchor (the layer whose look you want to keep). Only overlapping areas are compared.
5. Optional: **Current view importance** keeps what the camera shows now; **Fill gaps** closes small holes.
6. **Preview**, then **Apply** (or use *Combine to new layer* directly). The sources stay (hidden), so you can change the weights and run again; Ctrl+Z undoes it.
7. Check the coverage line; paint missing views with the Coverage panel and combine again.

## Part 7 - Why the baked result can sit slightly off the placed reference, and what to do
**What is exact.** Placement -> `edit_image` -> projection onto the UV texture. If Klein returned `edit_image` untouched, the bake would reproduce your placement exactly (this is checked by the test-suite).
**Where the offset comes from.**
1. **Klein redraws, it does not copy.** The distilled 4-step model treats the placed picture as a hint, re-composes it and snaps it to its 16-pixel latent grid, so the picture can drift by a few pixels, grow, or shift toward the object's shading. This is by far the most common reason. It is largest when the reference is passed as a *separate* second image (`reference_image` -> **image_1**), or with **Send ORIGINAL image 2**, because then Klein decides where to put it.
2. **The camera moved.** Placement is anchored to the dashed capture frame (screen space), not to the model. If you orbit/zoom after placing, the picture stays on the screen and slides over the model. Always queue from exactly the view you placed in (save a camera bookmark with the star button).
3. **Different framing.** If the Klein output does not have the aspect of `edit_image` (the template scales to ~1 megapixel and rounds to 16), the Bake node stretches it back, which is a small shift that grows toward the edges. Use a capture size whose sides are multiples of 16 (1024 x 1024, 1024 x 768 ...).
**How to fix / use it better.**
- **Bake > `align_to_reference`: on.** The node compares the generated picture to the placed reference inside the painted area, measures the shift (sub-pixel) and moves the generated image back before baking. The report says what it did ("Align: moved the generated image by +8.9, -5.9 px ... match 0.99"). It corrects a global shift only, not growth or distortion; if there is no clear match it leaves the image alone.
- **Use the importance weights.** In *Reference image 2 -> Final texture mix* give the placed reference a weight (e.g. generated 1.0 / reference 0.4). The reference is mixed in at its exact position, so the texture cannot drift away from it; use 0 / 0 / 1 to bake the placement alone (a quick way to prove where the offset comes from: if this bake sits where you placed it, the shift came from Klein).
- **Keep Klein close to the placement:** reference weight near 1 in `edit_image`, **Send ORIGINAL image 2** off, and a prompt that says to keep the pattern where it is.
- **Fix by hand:** nudge the placement by the reported offset (or use Scale X / Y) and queue again.

## Part 6 - Troubleshooting
| Symptom | Fix |
|---------|-----|
| "No captured view found" | Load a model in the painter and press **Sync**, or Queue again |
| "The view ... changed after this generation was started" | You moved the camera/mask while Klein ran. Queue again |
| Result misaligned | Klein output must keep the aspect of `edit_image`; check the Bake `report` warning |
| Nothing changes | Mask not visible from the camera, or "baked 0%" in the report: rotate/zoom so the area faces the camera |
| Different result every queue | Painter seed control must be **fixed** and linked to **noise_seed** |
| Seams | Raise Bake `padding`, turn on seam-aware blending in the Coverage panel |
| Klein repaints the whole view | Keep `compose_prompt` on; lower `hint_strength` only if the tint colour leaks into the result |


## Part 3f - UV texture output, tiles and reference images (beginner version)

1. Paint your mask, then tick **UV texture output** (top right of the UV map). The AI now edits the flat UV map instead of the 3D view.
2. For big textures tick **Compute in tiles**: the UV map is cut into a grid and every tile goes to the AI at full size. Use **One by one** (each tile sees its painted neighbours - best match) and press **Run tiles**. **All in one queue** sends all tiles as a batch (your workflow must edit an image batch; connect `tile_count` to the latent batch size).
3. To make the AI follow your photos tick **Use reference images (by angle)**. Load a photo as image 2..6, then either give it an angle (front, left, ...) or place it on the model (*Place on model*, align it, *Done placing*). The panel shows that the image has a camera. Press **Preview on UV map** to see where the photos land.
4. Queue (or **Run tiles**). Each tile / the whole map gets its part of the photos as image 2 and as a pre-fill; the AI refines it.
