# Texture Painter AI - roadmap: combining layers into one complete texture

Status legend: **done** = in this version and covered by tests (browser / unit tests, not yet tried in a real ComfyUI), **next** = planned, **later** = idea, needs a decision.

## Phase 1 - weighted merge (done, v6.0)
Panel *Combine layers*: tick the layers to include, give each an **Importance**. Per texel weight = importance x bake confidence (AI layer alpha) x layer mask x layer opacity.
Modes: **Priority** (most important on top), **Weighted average** (confidence sharpness), **Best view** (confidence^4, the best-seen layer wins). Live **Preview** (Apply / Discard banner) or **Combine to new layer**; the result is a new layer "Combined", sources are kept (hidden on request), everything is undoable.
*Current view importance* adds what you see from the current camera as one more source, weighted by how directly each texel faces the camera.

## Phase 2 - overlap colour matching (done, v6.0)
*Normalize colours = match to anchor layer*: layers are matched to an anchor (Lab mean / spread, strength 0-100%) **only where they overlap**, in a chain starting at the anchor. Layers with no overlap are reported and left alone, so deliberately different areas stay different. The view source is never changed.

## Phase 3 - multiband blending (done, v6.0)
*Detail = multiband*: colours blend softly over the **Blend width**, fine detail comes only from the dominant layer, so overlaps do not ghost. *Plain average* is available for comparison.

## Phase 4 - gaps and coverage (done, v6.0)
*Fill gaps* grows painted texels by N px (within UV islands) and the result reports "% of the UV surface painted". Large unpainted areas still need new views: the Coverage panel suggests them and can auto-paint views.

## Phase 4b - blue transition brush (done, v6.1)
Separate UV mask painted with the brush (target *Transition (blue)*); inside it the included layers cross-fade over a chosen width (partition of unity from blurred importance x alpha), optional transition-only output layer.

## v6.2 review items that were not done (honest list)
Needs a real ComfyUI to verify: a smoke test against a pinned ComfyUI/frontend, panel tabs + first-run guide. Large: Web Worker for Combine (phase 7), de-lighting and hole inpainting (phase 8), batch multi-view auto-loop, PBR bake (roughness / normal / AO), per-object transition mask, transition width as a fraction of the texture, state versioning with migrations, compressed project ZIPs, session cleanup, event bus refactor of editor/panels, undo memory budget.

## Phase 5 - AI harmonize pass in view space (first version done, v6.3: panel + prompts + whole-surface preparation; still manual per view, no auto-loop / before-after toggle)
Run a **low-denoise** Klein pass on the combined result from several cameras (not on the flat UV atlas, which Klein cannot understand) and bake it back with the existing nodes. Needs: a "harmonize" preset (low denoise, "keep everything, fix lighting/colour consistency" prompt), a view picker reusing the Coverage suggestions, and a before/after toggle. Risk: Klein repaints detail; mitigated by the importance weights of the Bake node.

## Phase 6 - stored recipe and re-run (next)
Remember the recipe (sources, importances, options) with the "Combined" layer so changed weights can re-run without re-selecting; "Update combined layer" instead of adding another one.

## Phase 7 - speed (next)
Combine currently runs on the main thread: about 3 s at 2048 x 2048 (2 layers, multiband + matching), roughly 4x at 4096. Move it to a Web Worker with a progress bar and tile the large cases.

## Phase 8 - hole inpainting and de-lighting (later)
AI fill of large unpainted areas from neighbouring views; optional "remove baked-in shading" step before matching (AI layers sometimes carry lighting that colour matching cannot remove).

## Not planned
Running Klein directly on the flat UV atlas, and a generation-history timeline (not requested).
