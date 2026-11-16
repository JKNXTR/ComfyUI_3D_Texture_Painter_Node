# Texture Painter AI for ComfyUI

Paint a mask on a 3D model (or on its UV map), let **Flux.2 Klein 9B** repaint what is under the mask,
and bake the result back into the model's UV texture - only inside the masked area.

## Install
1. Copy the whole folder `ComfyUI-TexturePainterAI` into `ComfyUI/custom_nodes/`.
2. Start ComfyUI. Missing Python packages (numpy, Pillow, scipy) are installed automatically on start-up
   (`__init__.py` -> `tp_install.py`). Nothing else is needed: the 3D editor is pre-bundled (no npm, no CDN).
3. Hard-refresh the browser (Ctrl+F5). Add nodes via *Add Node -> TexturePainterAI*.

ComfyUI-Manager also picks up `install.py` / `requirements.txt`.

## Wire it up (Klein workflow)
Two ready-made workflows are in `workflows/` (drag the JSON into ComfyUI):
- `texture_painter_klein9b_distilled.json` - painter -> Klein 9B distilled edit -> Bake.
- `texture_painter_klein9b_with_reference.json` - same, plus the painter's `reference_image` as the second Klein image.

They are built (`workflows/build_workflows.py`) from ComfyUI's official *"Flux.2 [Klein] 9B: Image Edit"* template and pass a structural check
(links, slot types, subgraph definitions), but **have not been opened in a real ComfyUI** - if one fails to load, use the manual wiring below and report the error.

Manual wiring (starting from the official template):
- replace *Load Image* with the painter's `edit_image` output (painter `prompt` -> the template's prompt input),
- painter `seed` -> the template's `noise_seed` (needed for the variations strip; set the painter's seed control to **fixed**),
- replace *Save Image* with **Texture Painter AI - Bake**: `bake_data` <- painter, `generated_image` <- the decoded image.

Optionally connect `width`/`height` to the latent size. Press **Queue**: the view is captured automatically,
Klein edits it, Bake projects it into UV space, and the result appears in the editor.
Review it (compare toggle in the banner), then **Apply** or **Discard**. Apply adds the result as a **new layer** (`AI: <prompt>`) and the 3D view and UV map update live. Ctrl+Z undoes it.

### Reference image 2 (optional)
In the *Reference image 2* panel load a picture, tick **Use image 2 as a reference** and set the weight (0-1).
The picture is placed over the masked area (modes: cover mask / frame / tile, with scale and rotation) and blended into `edit_image`
by `mask x weight`; the prompt also gets a matching "use image 2 as a subtle / clear / strong reference" phrase.
Klein has no native per-reference weight, so this is how the weight is emulated. For a true second reference, also wire the painter's
`reference_image` -> *VAE Encode* -> the template's *ReferenceLatent* node. `reference_weight` (FLOAT) is available for your own math nodes.

## Coverage, views and variations (v5)
Open the **Coverage, views & variations** panel.
- **Coverage heatmap** (3D + UV): shows which texels are already covered by visible AI layers (alpha x opacity x layer mask). *Covered above* sets the threshold; the panel shows the covered share of the UV surface.
- **Suggest next view** flies the camera to the direction that sees the most uncovered surface (approximation: it ignores occlusion). **Mask uncovered** selects every texel not covered yet.
- **Auto-paint views**: repeats suggest view -> mask uncovered -> queue your workflow -> apply as a layer, until *Stop at coverage* or *Max views*. **Stop** also interrupts the running generation. Needs the painter/Bake wiring above.
- **Seam-aware blending** (on by default): when a new view overlaps texels that are already painted, the new pixels are blended in proportionally to their confidence instead of overwriting, so overlaps are feathered.
- **Generate variations**: runs the workflow N times with consecutive seeds, shows a candidate strip; click one to preview it, then Apply. The seed output must be wired to the sampler (see above); if all candidates come out identical the editor warns you.
- **Crop to mask** (capture panel): the capture zooms onto the painted area (with a margin), so Klein gets more pixels there; the HUD shows `crop xN` and the framed region. The bake uses the exact cropped camera (checked with a capture -> bake round trip).
- **Generation presets**: model preset (distilled 4 steps / base 20 steps), steps, cfg, resolution. They are sent as the painter's `steps` / `cfg` outputs. The official Klein subgraph does **not** expose steps/cfg, so these outputs only matter if you use your own sampler; the resolution preset does change the capture size.
- **Live progress + preview**: a progress bar and, if ComfyUI's preview method is enabled (Settings -> Preview method), the intermediate image inside the node.
- **Style lock**: Reference panel -> *Use active layer* / *Use whole texture* turns an existing layer (cropped to its content) into reference image 2. *Use prompt of active layer* copies that layer's prompt.
- **Place on model** (Reference panel, needs image 2 + a painted mask): a temporary mode that shows image 2 planar over the 3D model in the exact capture frame, visible only inside the painted mask. Drag = move, mouse wheel = size, round handle above the image (or Alt + drag, the Rotate slider, or the ↺90° / 90°↻ / 0° buttons) = rotate, Shift = 15° steps, Enter / Esc = done; right / middle mouse still orbit and pan so you can pick the view first. The placement (offset, size, rotation, optional repeat) is saved and sent to Python, which reproduces it pixel-for-pixel on the captured view (also with crop-to-mask). The image outside its borders is not used unless *Repeat* is on.
- **Fit image 2 to** (check boxes in the Reference panel, because a reference rarely has the proportions of the viewport): *Fit inside the frame* (whole image), *Fill the frame* (crops the overflow), *Stretch to the frame* (distorts), *Fill the painted area*, *Fit inside the painted area*. Ticking applies it once (rotation resets to 0); tick again after you change the view or the mask. Moving or resizing the image unticks the box.
- **Send the ORIGINAL image 2 as reference_image**: placement then only decides where the image is blended into the masked area of the view; the `reference_image` output gives Klein the picture itself (own size and proportions, never cropped or stretched) as its reference for the final result.
- **Image 2 as viewport background** (Reference panel): shows image 2 behind the model inside the dashed capture frame, with an opacity slider, so you can orbit / zoom the model until it sits where you want it relative to the reference. It uses the manual placement (Place on model / Fit boxes) and is never part of the captured view. Switching it on from a non-manual mode only fits the image into the frame; the bake placement mode stays as it was.
- **Importance in the final texture** (Reference panel): three weights - *Generated result*, *Original viewport (current texture)* and *Reference image 2 (placed)*. The Bake node mixes them per pixel (weight-normalised) before projecting into UV space, so the new texture can keep part of the original look and/or take a literal share of image 2 (only where image 2 covers the view). Defaults 100 / 0 / 0 = unchanged behaviour. Presets: *Generated only*, *Reference guides only* (Klein receives the untouched image 2 via `reference_image`, nothing of it is pasted into the view or the result), *Keep original look* (65 / 35), *Literal reference* (50 / 50). Image 1 = the view Klein edits, image 2 = your reference.
- Reference weight stays inside the painter (blend of image 2 into the masked area + prompt wording); the Klein subgraph has no per-reference strength input.

## Automatic save / restore
The model, texture layers, mask, reference image 2, camera and model transform are saved automatically (about 2.5 s after every change) in `ComfyUI/input/texpaint/`.
They come back when you switch workflow tabs, reload the page or restart ComfyUI. A **new** Texture Painter node reopens the last used model, layers and settings automatically.

## Multi-object models: hierarchy tree
When a file contains several objects the **Objects (hierarchy)** panel appears (top of the side panel).
- Click an object (or a group) to make it the **working model**: it gets its own UV map, its own texture layers (default 2048 px), its own mask, and it alone is captured, painted and baked - so it uses the whole texture resolution. *Entire model* (default) merges everything into one atlas, which is right when all parts share one UV atlas.
- Every object keeps its own layers and mask while you switch (also saved with the autosave and restored after a restart). Undo history is cleared on a switch.
- The other objects stay visible as grey context. Buttons: **Unhide all**, **Hide all**, **Hide all except selected**, **Hide selected**; the eye in each row hides one object / group (half-filled = some children hidden).
- Limits: context objects are only for orientation - they do not occlude the capture or the projective brush. Export (GLB / OBJ) and *Save project (.zip)* handle the working object only. Hiding part of the working object is not possible (it is one merged mesh). The model transform is shared by all objects.

## Presets, saving state, exact values, fit (v5.5)

**Presets & state** (side panel, top). A preset is a named snapshot of the *tool settings* (brush, capture, generation, blend weights, reference-2 weights/modes, display, planner ...). It never contains the model, mask or layers. Presets live in `input/texpaint/presets` and are shared by every workflow and node.
- *Save as...* (new name; refuses to replace an existing one), *Overwrite* and *Delete* (both need a second click within 3 s), *Rename*, *Load*, *Defaults* (reset settings).
- Optional boxes also store the camera view, the model transform and the reference-2 placement.
- *Save state now* writes this node's complete state (settings, model, mask, layers, camera) to the server immediately and marks the workflow as changed; *Save state + workflow* then triggers ComfyUI's workflow save (like Ctrl+S). All Texture Painter nodes of the open workflow are saved together.
- Normal operation is unchanged: state is autosaved a few seconds after every edit and restored on tab switch / restart. Settings also travel inside the workflow file. Model and masks live in `input/texpaint`; use *Save project (.zip)* to move a state to another machine.
- Limit: ComfyUI will not let one tab write into another open workflow tab. Other open workflows keep their own copy, saved by their own nodes while you work in them; use *Save state now* inside each if you want to force it.

**Exact values.** Every slider's number is an input: click it, type (percent sliders take the percent value), Enter applies, Esc cancels, Up/Down nudge. After a click the mouse wheel changes the value (Shift = 10 steps, Ctrl/Alt = fine). The wheel never changes values unless the field or slider is focused, so scrolling the panel is safe.

**Fit.** Viewport buttons: home = fit whole object (`Home`), target = fit the painted/masked area (`F`). `Shift+Home` and the Objects panel buttons fit all visible objects. Fit respects pane shape, perspective and orthographic.

**Erase, revert, undo (layers).** Layers panel, "Erase / revert / history":
- *Erase with brush* switches to the eraser on the active layer's mask (Rect/Lasso work too): it hides parts of an AI layer without destroying pixels; the Brush restores them.
- *Revert layer* returns the active layer to its original state (original pixels, mask removed), one undo step. For "Replace active layer" results this brings back the texture from before the AI paint. Original pixels are stored with the project (extra PNG per changed layer).
- *Undo / Redo* buttons show the step count; Ctrl+Z / Ctrl+Y as before. One shared history (layers, masks and the AI selection), now 60 steps.

**Master output resolution (Bake node).** New optional `output_resolution` (match texture / 512 ... 8192). The bake runs at that size; the editor resizes its layer stack to it (limit 4096, one undo step). Full step-by-step guide to every output and the Klein wiring: **TUTORIAL.md**.

**Reference placement: Scale X / Y** sliders (stretch the placed image on one axis, 1:1 button, type exact values). **Bake -> `align_to_reference`** measures how far Klein moved the picture from where it was placed and shifts the generated image back before baking (global shift only; skipped when there is no clear match). See TUTORIAL.md Part 7 for why the offset happens. Fix: typing a value + Enter in a field while in placement mode no longer leaves placement mode.

**Layout in the node.** The editor now fills its node widget area (it no longer depends on the wrapper's percentage height, which collapsed it to a small box in the corner in some ComfyUI versions), keeps at least the node's width and 640 px height, and the side panel scales with the editor (240-320 px). Enter/exit fullscreen returns to the same size. If the presets list shows "HTTP 404", restart ComfyUI (the server routes are Python and are only loaded at start).

## v6.17 - Select tool (V) and Heal brush (J)
- **V - select tool:** click an object in the 3D view to make it the working object in the hierarchy (Ctrl / Shift-click adds, Alt-click picks its parent group). The object name shows next to the cursor.
- **J - heal brush:** paints a dark-green heal area (E erases; J again returns to the normal brush). In the **Heal brush** panel tick **Heal run**: the AI then repaints only that area, using only the heal prompt (editable, built-in default fixes artifacts, seams and stretched texture); your normal prompt, AI selection, tiles and UV references are ignored until you untick it. Works in the node and in the standalone editor.

## v6.16 - standalone editor + bridge
- Open `http://<your ComfyUI address>/texpaint/standalone` (or press **Open standalone** in the node's top bar) for the same editor in its own window, linked to the node by a live bridge. One editor is the **master** (you edit there, it captures the view for the AI), the other is a read-only **mirror** that follows every change; **Take over** swaps the roles. Prompt / seed / Bake widgets and Queue work from either side; the ComfyUI page with the node must stay open to queue.
- Includes the 6.15.1 tile-run fix. Restart ComfyUI after updating (server API level 8).

## v6.15 - reference images by angle (UV mode)

New in the UV panel (needs **UV texture output**; works with or without tiles): **Use reference images (by angle)**.

- Every reference image 2-6 that has a **camera** is projected onto the UV map with the baker's visibility / facing test: a texel takes colour from a photo only where that photo really sees the surface, from a good angle. Several photos are blended per texel by confidence.
- Where the camera comes from (best first): the view the image was **placed from** (recorded when you press *Place on model* / *Done placing*), its **saved angle**, or its **angle label** (front, back, left, right, top, bottom, also combinations such as "front left"). The panel lists each image and which source it uses; an image without any of them is skipped (with a note).
- The projected photos go to the AI as **image 2** (the `reference_image` output; one picture per tile in tile mode) and pre-fill the marked area by **Reference fill** (0 = only as reference, 100 = the AI refines the photo colours). Areas no photo sees stay as the current texture. **Min. facing angle** (default 65 deg) controls how steeply a surface may turn away from a photo.
- **Preview on UV map** projects the references and draws them over the UV map; transparent = no reference sees that area (add a photo from another angle there).
- In UV mode image 2 is no longer sent as a raw photo, and the prompt preview shows the real text. Images 3-6 are consumed by the projection while the option is on.
- API level 7 (the capture now carries a depth pass and camera per reference): restart ComfyUI after updating.
- **Fix (6.15.1):** "Run tiles" (and the auto multi-view / variation runs) could stop with *"The workflow finished but produced no new result"* after the first tile. The painter starts the next run before the previous run's "finished" signal from ComfyUI has arrived; that late signal was counted for the new run, and a few seconds later the new run was declared empty although it was still working. Finished signals are now matched to their own run, so tiles run through to the end.

## v6.14 - UV tiles

Works together with **UV texture output**. A big UV map squeezed into one 1024 image loses detail; with tiles every part of the UV map is sent to the AI at full size.

- **Compute in tiles** (UV map pane, under the UV texture output switch): *Columns*, *Rows* (1-8), *Overlap* (0-30 % of a tile) and the mode. The grid is drawn over the UV map (dashed yellow = tile has mask and will be generated, grey = empty and skipped, blue dotted = the tile including its overlap). The panel says how many tiles will be generated.
- **One by one (recommended):** *Run tiles* queues your workflow once per tile that contains mask. Every tile sees the already painted neighbours (they are not marked, so the AI continues the pattern), the result is applied as a layer, then the next tile follows. *Stop* ends it after the current tile. Tiles are row by row, top left first.
- **All in one queue (batch):** the node outputs all tiles as one image batch; your workflow must edit an image batch (the batch size of the latent has to match `tile_count`). The Bake node cuts it back and blends the overlaps with soft ramps. If the generator returns fewer images than tiles, Bake stops with a clear message.
- **New node outputs:** `tile_count` (tiles that will really be generated = tiles with mask), `tile_index` (current grid tile, -1 for batch), `tile_total` (columns x rows). `width` / `height` are the size of one tile image (long side = Capture long side).
- All tiles have the same size (edge tiles are shifted inwards instead of being cut), so a batch works.
- API level 6: restart ComfyUI after updating (the page warns if an old Python part is still running).

## v6.13 - UV texture output

- **UV texture output** checkbox on the UV map pane (top right). On: the node's `edit_image` output is the flat UV map - the current texture with the painted mask tinted - instead of the 3D view. `view_image` is the UV texture and `view_mask` the (grown / feathered) UV mask. Your prompt then generates a new texture for that UV map, and the Bake node blends the generated image straight back through the mask (strength applies, no projection, no camera needed).
- Reference placement (image 2) is not used in this mode; images 3-6 are passed through unplaced. The prompt gets one extra sentence asking to keep the island shapes unchanged (the prompt preview shows it).
- Keep the generated image the same size as `width` / `height`. Island borders can look slightly soft: raise `mask_grow` a little.

## v6.12 - placed reference image stays visible, wireframe toggle

- **Reference image panel:** after *Done placing*, the placed image stays on the model in the 3D view. New controls: *Show the placed image on the model* (on/off), *Image opacity in the 3D view* (0-100 %) and *Show the whole image* (not only inside the painted area). Viewport only - the AI capture is unchanged. Shown for the active reference image.
- **Wireframe checkbox** next to *Grid* in the 3D view (also in the right-click quick menu). Shows the polygon edges; stays in sync with the Display panel option.

- **Fix (6.12.1):** the placed reference no longer shifts or changes scale when you enter / leave full screen or resize the window. The model scales with the viewport height while the placement is stored relative to the capture frame; the stored values are now re-scaled automatically whenever the viewport shape changes, so the image stays glued to the model and the numbers sent to the AI node stay correct.
- **Resolution:** viewport size does not affect the output. The AI input is rendered at the *Capture* long side and aspect (rounded to 16 px); the viewport only decides what is inside the dashed frame. The result is baked into the texture at the *Master resolution* setting.

## v6.11 - view drop-down, layer colour adjustment, prompt preview
- **View drop-down** (top of the 3D view): the six standard views (Front, Back, Left, Right, Top, Bottom), **My views** and **Reference image angles**. **＋** saves the current camera (and lets you name it at once), **✎** renames, **✕** deletes (click twice). A saved view can be **linked to a reference image** (second drop-down): choosing the view then also makes that image the active reference. Choosing a reference-angle entry goes to the camera saved with that image (*Save angle* in its panel) and activates it. Up to 24 saved views (they are the old camera bookmarks).
- **Layer colour adjustment** (Layers panel, active layer): brightness, contrast, saturation, hue, levels (black / white point, gamma). Non-destructive, saved with the layer, undoable, and used everywhere layers are used: viewport, AI capture, bake, export, Combine layers. *Copy to all layers* gives every layer the same adjustment. Use it to bring an AI layer back to the colours of the original texture.
- **Prompt preview** (bottom of the UV view, collapsible, Copy button): the text that goes to the model with the next Queue - composed from the node's prompt / style / mask-colour widgets plus the reference sentences (angle, role, strength) with the same rules as the Python node. Preview only; the node's `prompt` output is the final text.

## v6.10 - view regions (colour per reference view), right-click brush menu, grid switch
- **Grid switch** at the top of the 3D view (and in the right-click menu): shows / hides the floor grid.
- **Right-click menu in the 3D view** (a click without dragging; dragging still pans): Brush / Eraser, what it paints on (AI selection, Layer mask, Transition, or one of the four view regions), size, hardness, softness, opacity, spacing, stabilizer, pen pressure. Brush and eraser keep separate values. Esc / click outside closes it.
- **View regions** (panel *View regions*, API level 5 - restart ComfyUI): each of the reference images 3-6 has a **brush colour** (editable). Paint a region in that colour on the model (Paint / Erase buttons, or pick the view in the right-click menu): it marks the part of the model that this reference / camera angle is responsible for. Regions show in 3D and UV in their colours, have their own undo, are saved (autosave, session restore, project ZIP) and are erasable and clearable.
  - the placed-image preview of a slot is clipped to its region (switchable);
  - the capture also sends each region as seen from the capture camera, and the reference then only influences the edit image inside its region (an image with an empty region keeps acting everywhere, as before);
  - **= AI mask / + AI mask** turns a region into the AI mask, **Go to angle** jumps to the saved camera of the reference. Calculating every side on its own: go to the angle, "= AI mask", queue; repeat - each bake merges into the same texture with the existing seam-aware blending. A one-button automatic loop over all sides is not part of this version.
  - position / rotate / scale X and Y of each image stays in its *Reference image* panel (Place).

## v6.9 - other objects' textures in the 3D view + as AI reference
Two switches appear at the top left of the 3D view for models with several objects (both off by default, saved with the state):
- **Show textures of all objects** - the other objects show their own texture instead of grey: the version from when you last worked on that object (or the shared *Entire model* texture), else the texture embedded in the model file. After a page reload an object shows its file texture until you select it once.
- **Use them as reference for smoother connections** - the AI capture image also contains the visible other objects, unlit and with those textures (hidden objects are left out), so Klein sees the neighbouring colours and details and continues them at the joints. Mask, depth and normal passes and the bake stay on the working object only - neighbours are never changed. The model may repaint the neighbours in its picture; only the working object's texels are baked.

## v6.8.1 - several objects as one working set; clearer unwrap-route error
**Hierarchy multi-select:** Ctrl/Cmd-click adds or removes objects, Shift-click selects a range (from the last click). The selected objects become ONE working set - one merged mesh, one texture stack, one mask, shared capture / paint / AI generate / bake - while the rest stay grey context. Each set keeps its own layers and PBR maps when you switch away, and is restored after a reload. Plain click = single object, click *Entire model* = everything.
**Unwrap "HTTP 405 /texpaint/unwrap":** the running ComfyUI is still the older Python (not fully restarted, or a second copy of the node is in custom_nodes). The message now also shows the API level and the folder of the copy that is actually loaded.

## v6.8 - PBR material maps + lit PBR preview
New panel **PBR material (maps & preview)** (side panel, Paint tab). Six maps per object - **normal, height, roughness, metallic, ambient occlusion, specular** - stored in the same UV space as the colour texture:
- **Load...** any image per map, **Load packed ORM** (R = occlusion, G = roughness, B = metallic) or **From colour**, which *derives* an approximation from the colour texture (local contrast -> height, height -> normal, dark -> rough, cavities -> occlusion; *Detail size* / *Strength* control it). It is not a material scan - for real values load maps, or paint an AI mask and use **Fill painted area** (e.g. metallic 1.0 on the metal parts only). Also Fill all, Invert, Flatten painted area (normal), Flip green (OpenGL <-> DirectX), Undo map change, Remove.
- **PBR preview in the 3D view**: lit physically based render (environment light + sun, ACES tone mapping) with every map applied; sliders for environment, sun intensity / direction / height, exposure and a strength per map. It renders the live colour texture, so painting still shows up. Preview only - the AI capture / bake are not affected.
- **Per object**: in a multi-object model each object keeps its own maps (switching the working object stashes them like layers). They are saved with autosave / session restore and the project ZIP.
- **Export**: GLB carries normal, roughness + metallic (merged), occlusion and specular (KHR_materials_specular); the height map is not part of glTF. OBJ zip carries every map as PNG and mtl lines (`norm`, `bump`, `map_Pr`, `map_Pm`, `map_Ks`, `map_ao`); *Download maps (zip)* gives all six.
- Limits: the AI does not generate these maps yet; maps are not re-projected when you Unwrap & Atlas (re-derive them on the atlas); the preview needs WebGL2 floating-point support (any current browser).

## v6.7.1 - overrides in Resolution match
Two drop-downs with common sizes: **Override: AI render side** (512-4096) and **Override: texture size** (512-4096). *Apply overrides now* sets them directly (Auto = leave as is); *Auto match* and the single-step buttons use an override instead of the measured value. The editor's layer stack is limited to 4096.

## v6.7 - Unwrap & Atlas tab
A second tab at the top of the side panel (**Paint | Unwrap & Atlas**) re-unwraps the model and merges all objects into ONE atlas:
1. Tick the objects (default: all). *Method*: **New unwrap** (xatlas cuts and unwraps every object) or **Keep my UV islands** (only packs the existing islands of all objects together without overlaps). *Atlas size* 1024-8192, *packing quality*, *padding*.
2. *Texture source*: **each object's own texture** (what you painted / baked per object in the Objects list) or the **Entire model** texture (a shared atlas). The default follows what you were painting on.
3. **Unwrap & build atlas** runs on the ComfyUI machine (python package `xatlas`, installed automatically at start; otherwise `python -m pip install xatlas`). All objects share one square atlas with the same texel density per world unit; the textures of every object are re-projected into it (the triangles stay the same, so every new texel knows exactly where it came from). Islands are padded so seams do not bleed.
4. The result is a preview (atlas + coloured UV islands, click it to enlarge, statistics: charts, area used, equal density, overlaps). **Import as the model** (press twice) loads it as the new model - the objects keep their names in the Objects list and share the atlas texture, ready for AI painting - or **Download OBJ + atlas (zip)**.
Also fixed in this version: autosaves could overlap and finish out of order, or mark a mask stroke that happened during the upload as saved - a duplicated / reopened node could then come back with an older mask. Autosaves now run one after the other and use the versions they actually exported.
Limits: skinning / animation is not kept; the atlas is square, so a very elongated layout wastes space; very dense models (several 100k triangles) take a while; the import replaces the loaded model (save the project first if you want to go back).

## v6.6 - Resolution match (why baked textures look low-resolution)
Every texel of the baked texture is read out of the AI render, so the texture can never be sharper than that render: the default capture is 1024 px, so on a 2048 texture only about 0.4 render pixels land on each texel (the bake just enlarges the picture). New panel **Resolution match** (below *Capture / generation view*):
- **Analyse current view** measures, for the painted and well-facing part of the model, how many render pixels fall on one texel ("1.00" = 1:1, below 0.5 = blurry), and says what is needed.
- **Auto match** raises the capture size up to *Max AI render side* (1024-4096) and, if that is still not enough, shrinks the texture (one undo step) to what the render can really fill. *Capture size = needed*, *Texture size = render* and *Crop view to painted area* do the single steps.
- The capture **Long side** slider now goes up to 4096 (large sizes are slower and need a Klein workflow that renders at the painter's width / height outputs).
- The Bake report now starts with "AI image WxH -> texture WxH" and warns when the generated image is smaller than the captured view (typical cause: the latent size is not connected to the painter's width / height).
The analysis is an estimate for the current camera; it ignores occlusion and only counts triangles facing the camera by more than ~0.35.

## v6.5 - reference images 3-6 work like image 2
The **Reference image** list at the top of the Reference panel picks the image the controls below act on: image 2 or the new images 3, 4, 5, 6. Every image has its own:
- placement (Fit to masked area / Fill the frame / Tile / Manual), *Place on model* (move / size / rotate), Scale X/Y, repeat, the fit options, viewport background and weight;
- **angle label** (front, back, left side, right side, top, bottom, four three-quarter views, close-up) and a **role text**; both go into the prompt, e.g. "Image 3 shows the subject from the back. Image 3: leather material.";
- **saved camera angle**: *Save current view as its angle* remembers the 3D camera, *Go to its angle* returns to it - go there, paint the mask, place the picture, queue. A marker next to the image name shows which images have an angle (circle) or a picture (tick).
Weight 0 (the default for images 3-6, same as the old pass-through) sends the image to Klein untouched; a weight above 0 blends the placed picture into the masked area of the view like image 2. "Send the ORIGINAL image" decides whether `reference_image_N` carries the picture itself or the placed composite. Old projects with 3 slots are upgraded automatically (the 4th slot is empty, behaviour unchanged). The *Importance in the final texture* sliders still refer to image 2 only. Re-import the workflow JSONs or add the `reference_image_6` link by hand; the new output is the last one of the painter node.

## v6.4 - textures per object (right-click in the hierarchy)
Right-click an object in the **Objects** list (multi-object models):
- **Load texture for this object...** makes it the working object and replaces its texture with your image (undoable, also when it already has painted layers).
- **Load image as new layer...** adds the image as a layer on top instead.
- **Back to the model's own texture** restores the embedded texture (or grey).
- **Saved textures**: every image you load this way is kept once in a library of this browser (IndexedDB, newest 60, no duplicates). Click one to use it for the clicked object, **x** removes it from the library.
The texture lives in the object's own layer stack, so it is saved and restored with the project like every other layer. The library itself is per browser, not part of a project file.

## v6.3 - transition prompts and final harmonize
- **Transition prompts** panel: a library of **27 prompts** in 9 categories (Character, Face, Body, Skin, Transitions, Details, Lighting, Contrast, Cover / fill) written for the BLUE transition mask ("... in the marked area"), plus **My prompts** (save / delete your own, stored with the project and workflow). *Use as prompt* / *Add to prompt* puts the text into the painter's prompt, switches the AI to the transition mask, and (optional) sets soft edges (mask_grow 12, mask_feather 10, Bake strength 0.85) on the painter / Bake nodes.
- **AI paints in the blue transition mask**: new switch (this panel) = which mask the AI repaints: the AI selection (default) or the blue transition mask. The mask is sent to the AI as the marked area and the Bake node projects the result with it (`bakemask.png`, only when the capture was made with it - the autosaved AI selection stays untouched; presets never carry this switch). Coverage planning / Auto multi-view still use the AI selection.
- **Final harmonize** panel: 7 normalization prompts ("photorealistic, no borders", "remove all seams only", photoreal skin / fabric, flat albedo, fix colour only, strong unify). *Step 1* flattens and colour-normalizes your layers without AI (weighted + multiband + Lab matching + gap fill). *Step 2* prepares an AI pass over the whole visible surface (selects everything, sets prompt, marker off, soft mask, Bake strength 0.4-0.8 per preset). Because Klein cannot read a flat UV atlas the pass runs in VIEW space: repeat it from 4-8 cameras. Not guaranteed photorealistic - check every pass, undo is available.

## v6.2.1 - preset HTTP 405 fix and "Save project as..."
- **Preset "HTTP 405":** that status means the running ComfyUI has no matching route (it still runs an older Python part - restart not complete, or a second old copy of the node in `custom_nodes`). Preset save/load/delete now use fixed-path endpoints (`/texpaint/preset_save`, `_load`, `_delete`) with an automatic fallback to the older ones, the node checks the server's API level at start and warns ("ComfyUI is running an OLDER Python part ... close it completely and start it again"), and every route error now says what to do instead of a bare status code. If it still happens after a full restart + Ctrl+F5, press *Copy diagnostics* (it prints the server API level).
- **Save project as...** (Export section and *Presets & state*): a window where you pick the destination and content. Destinations: a **folder on the ComfyUI computer** (folder browser with Up / Default / New folder; any folder when you use ComfyUI from the same computer, otherwise only folders inside ComfyUI's output folder - set `TEXPAINT_ALLOW_ANY_DIR=1` to allow others), a **folder on this computer** (browser folder picker, Chrome/Edge on https or localhost), or a plain download. The ZIP always holds the 3D model, all layers incl. generated AI images and their masks, AI selection + transition masks, reference images 2-5 and all settings; optionally also **loose files** in a sub folder (model, each layer PNG, masks, project.json) and the **flattened UV texture** (`texture_flattened.png`). Existing files are never overwritten (`name_2.zip`). Open the ZIP again with *Open project...*. Large projects: ComfyUI limits uploads to 100 MB by default (`--max-upload-size`); use the browser-folder option for bigger ones.

## v6.2 - stable release: multiple reference images and robustness
- **Reference images 3 - 6** (Reference panel, *Reference image* list): since v6.5 they work exactly like image 2 (see the v6.5 section). Outputs `reference_image_3` ... `reference_image_6` come at the END of the painter node's output list (existing links keep working). Images are stored with the session (autosave, restore, node copy) and in project ZIPs (`ref3.png` ... `ref6.png`), capped at 2048 px.
- **Saved widget values can no longer shift.** The viewport widget is not serialized, and ComfyUI frontends differ in how they index `widgets_values`, which shifted prompt/seed/colour values when a workflow was opened. The values are now re-applied to the right widgets after loading, whichever layout the file has (old workflows load too).
- **"HTTP 404" on presets / sessions now says what to do:** restart ComfyUI (the Python routes only load at start).
- **Brush target badge** in the 3D view ("Painting: Transition (blue)" / "AI selection" / "Layer mask") so you never paint on the wrong mask; diagnostics (Copy diagnostics) now include the extra references, transition mask, combine settings and undo depth.
- Workflows regenerated for the new outputs.
- **Transition mask active** checkbox (Brush panel, next to the *Transition (blue)* target; the same switch as *Blend painted transition areas* in Combine layers): off = Combine ignores the blue mask, the overlay is dimmed and the badge says "inactive". The painted mask is kept.
Deliberately NOT in this release (needs a real ComfyUI to verify or is too large to ship untested): Web Worker for Combine, de-lighting, hole inpainting, batch multi-view auto-loop, panel tabs / first-run guide. See ROADMAP.md.

## Blue transition brush (v6.1)
Where two layers disagree you can now tell Combine *where* to merge them softly. In **Brush -> Brush paints on** pick **Transition (blue)** (or press *Paint transitions* in *Combine layers*): the brush, eraser, rectangle and lasso then paint a separate **blue UV mask** (it never touches the AI selection mask or the layer masks). Inside the blue areas the ticked layers **cross-fade over the *Transition width*** (8-256 px) - each layer's weight is its coverage blurred by that width, so you glide from one layer into the next instead of switching at a hard edge; where a layer has no pixels its colour is extrapolated from the border. Outside the blue areas the normal Combine rules apply. *Output only the transition areas* writes a separate **"Transition"** layer (rest transparent) on top of the untouched sources, so you can keep your layers and add just the repaired seams. The blue mask has its own undo/redo, is autosaved and restored with the session, stored in project ZIPs (`transition.png`), and shown blue in 3D and UV (toggle *Show the blue transition mask*). Combined with *Normalize colours* the colours are matched first and then cross-faded.

## Combine layers (v6.0)
Several AI layers from different views often disagree (brightness, tint, seams). **Combine layers** (side panel, below *Layers*) merges them into one new layer - non-destructive, undoable, with a live preview:
- **Include + Importance** per layer; weights per texel = importance x bake confidence (AI layer alpha) x mask x opacity.
- **Mode**: Priority / Weighted average (confidence sharpness) / Best view.
- **Detail**: *Multiband* (soft colour transitions of the chosen width, fine detail from the dominant layer, no ghosting) or *Plain average*.
- **Normalize colours**: match layers to an anchor layer, only where they overlap (strength slider); layers without overlap are left alone.
- **Current view importance**: keep what you see from the current camera and harmonize the rest.
- **Fill gaps** (px) and a coverage report ("% of the UV surface painted").
Runs on the main thread: about 3 s at 2048, longer at 4096. Plan and later phases: **ROADMAP.md**. Fixed on the way: the Coverage panel read layer masks wrongly after the layer stack had been resized (master resolution); it now resamples them.

## Using the editor
- Load a model (obj / glb / gltf / fbx) or drag & drop it; load or create a texture (UV map must be unwrapped, 0-1).
- **Brush / Erase** (B / E): size, hardness, softness, opacity, spacing, stabiliser, pen pressure.
- **Clear all** (toolbar trash button or Mask panel) removes the whole painted mask; undoable.
- Mask tools: clear, fill, invert, grow, shrink, feather, import/export PNG. The mask lives in UV space, so it is mirrored in the UV pane.
- **Model transform** (right panel): fix a wrongly oriented model with Rotate X/Y/Z (or the +90 buttons), Scale, Move, Flip X/Y/Z, **Z-up -> Y-up** (models exported from Blender/CAD that lie on their back), **Fit** and **Reset**. Do this first; the mask and texture are UV-based, so painting is not affected, and everything captured afterwards (and the bake) uses the transformed model. The transform is saved with the workflow.
- **Layers**: add / rename / duplicate / delete / reorder (drag) / hide / lock, opacity, 15 blend modes (normal, multiply, screen, overlay, soft/hard light, darken, lighten, dodge, burn, add, difference, hue, color, luminosity). Compositing is half-float. Max 24 layers.
- **Brush target = Layer mask**: paint to *reveal*, erase to *hide* parts of the active layer for smooth blending (Reveal all / Hide all buttons). "Brush target = AI selection" paints the generation mask as before.
- **Collapse**: Merge down, Merge visible, Flatten all (all undoable). *Texture seen* (capture panel) chooses what Klein sees: full composite, only layers below the active one, or the active layer.
- **Export / bake**: *Bake UV map* saves the final texture as PNG with seam padding; *Export model* writes a textured **GLB** or **OBJ+MTL+PNG zip** (original or transformed orientation). Files go to `ComfyUI/output/texpaint/` and are offered as a download. One merged mesh / one material; no FBX export.
- **View cube** (top-right of the 3D view): click a face for Front / Back / Left / Right / Top / Bottom, an edge or corner for diagonal views (animated). Buttons under it: **Persp/Ortho** (orthographic is best for straight-on projection painting - the bake supports it), **home** (frame model), **turntable**, and **star** (save a camera bookmark; list in Display -> Camera bookmarks).
- **Rect (R) / Lasso (L)** selection tools fill the mask on all visible surface under the shape; hold **Alt** to remove instead.
- **Prompt helper** panel: style chips add words to the prompt, history of the last 20 prompts, star = favourite.
- **UV health check** runs on load and warns about tiled/UDIM UVs, collapsed or mirrored UVs and overlapping islands; **UV checker** (Display) shows stretching on the model.
- **Project backup**: *Save project (.zip)* stores the model, all layers/masks, reference image and settings; *Open project...* restores it. A small "saved / unsaved" indicator shows the autosave state. *Storage info / Clean old sessions* manage disk use. *Copy diagnostics* (Log) copies a report for bug reports.
- **Help (?)** now shows a live wiring checklist of the node connections.
- Dashed frame = exactly what is sent to the generator (aspect, size, shading, background, min facing).
- Orange overlay = masked area seen at a grazing angle (poor bake from this view; rotate and repeat).
- Shortcuts: B/E brush/erase, N orbit, X swap, [ ] size, Ctrl+Z / Ctrl+Y, F frame mask, Home frame model, M mask overlay, 1-3 layouts, Space = temporary orbit, Esc.

## Not included (roadmap)
Symmetry painting, **automatic captioning** of an image into a prompt (needs an external caption/VLM node; only "prompt of active layer" is built in), PBR channels (normal/roughness), UDIM, multi-material export, FBX export, layer groups/adjustment layers.
Coverage counts only visible AI layers and is lost when layers are merged/flattened into a non-AI layer.
Layer PNGs pass through canvas premultiplication (tiny loss at very low alpha). Bake quality depends on the view.

## Troubleshooting
- Errors appear in the node's **Log** panel and, with full tracebacks, in the ComfyUI console. Please copy those when reporting a problem.
- Do not edit the hidden `state_json` widget; it only holds the session id.
- Untested in a real ComfyUI install: the frontend glue (queueing, progress/preview events, auto runs, variations), the workflow JSONs and Klein output quality. Tests used stubs, a fake generator and the real Python bake.
- Uploads are limited to 100 MB. Files are stored in `ComfyUI/input/texpaint/`.
- WebGL2 is required (any current Chrome/Edge/Firefox).
- `preview.html` is a standalone UI demo (generation simulated); open it by double-click.
- Rebuild the frontend (optional): `npm i && npm run build` (sources in `src/`).
