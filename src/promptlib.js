// Prompt libraries: (1) prompts for the BLUE TRANSITION MASK (repaint only the seam / join areas), (2) final-harmonize prompts for a whole-surface pass.
// Pure data + small helpers (no DOM) so they can be unit-tested.
export const TR_CATEGORIES = [
  ['character', 'Character'], ['face', 'Face'], ['body', 'Body'], ['skin', 'Skin'], ['transitions', 'Transitions'],
  ['details', 'Details'], ['lighting', 'Lighting'], ['contrast', 'Contrast'], ['cover', 'Cover / fill'],
];

// each prompt is written for the "Repaint only the marked area: ..." wrapper of the painter node (the marked area = the blue transition mask)
export const TRANSITION_PROMPTS = [
  { id: 'char-unify', cat: 'character', title: 'Unify the character across views', text: 'blend the seam between two painted views of the same character so colours, brightness and surface detail continue smoothly across the marked area' },
  { id: 'char-cloth', cat: 'character', title: 'Continue clothing fabric', text: 'continue the clothing fabric weave, stitching and colour seamlessly through the marked area, no visible border' },
  { id: 'char-hair', cat: 'character', title: 'Continue hair', text: 'continue the hair strands, direction and hair colour naturally through the marked area, same thickness and shine-free albedo' },
  { id: 'face-skin', cat: 'face', title: 'Blend face skin', text: 'blend the skin tone across the marked area on the face so there is no visible line, keep pores and fine detail consistent on both sides' },
  { id: 'face-keep', cat: 'face', title: 'Face: smooth colour only', text: 'keep eyes, lips and eyebrows exactly as they are and only smooth the colour transition inside the marked area' },
  { id: 'face-step', cat: 'face', title: 'Remove colour step on the face', text: 'remove the colour step on the face in the marked area, keep natural subtle skin variation and redness' },
  { id: 'body-cont', cat: 'body', title: 'Continue body skin', text: 'continue the body skin texture through the marked area seamlessly, same tone and same fine detail on both sides' },
  { id: 'body-joint', cat: 'body', title: 'Smooth a joint', text: 'smooth the join around the joint (elbow, knee, shoulder) so skin colour and detail match on both sides of the marked area' },
  { id: 'body-limb', cat: 'body', title: 'Limb to torso', text: 'blend the limb texture into the torso texture in the marked area with matching skin tone and no visible border' },
  { id: 'skin-pores', cat: 'skin', title: 'Match pores and wrinkles', text: 'match skin pores, tiny wrinkles and freckles on both sides of the marked area, no repeated pattern and no smooth patch' },
  { id: 'skin-tone', cat: 'skin', title: 'Unify skin tone', text: 'unify the skin tone, redness and saturation across the marked area' },
  { id: 'skin-detail', cat: 'skin', title: 'Keep natural blemishes', text: 'keep natural skin blemishes and fine variation, only remove the visible difference between the two sides of the marked area' },
  { id: 'tr-soft', cat: 'transitions', title: 'Soft gradual transition', text: 'create a soft, gradual transition between the two different colours in the marked area, no hard edge' },
  { id: 'tr-material', cat: 'transitions', title: 'Material to material', text: 'blend from one material into the neighbouring material in the marked area with a natural, believable boundary' },
  { id: 'tr-seam', cat: 'transitions', title: 'Remove a seam line', text: 'remove the visible seam line in the marked area and keep everything else unchanged' },
  { id: 'det-cont', cat: 'details', title: 'Continue fine detail', text: 'continue the fine surface detail (grain, scratches, stitching) across the marked area at the same scale' },
  { id: 'det-scale', cat: 'details', title: 'Match detail scale', text: 'match the detail scale and sharpness on both sides of the marked area, no blurry patch' },
  { id: 'det-noise', cat: 'details', title: 'Add micro variation', text: 'add subtle natural micro variation inside the marked area so the blended result is not smoother than its surroundings' },
  { id: 'light-delight', cat: 'lighting', title: 'Remove baked shadows', text: 'remove baked lighting differences and shadows in the marked area, even flat albedo lighting' },
  { id: 'light-match', cat: 'lighting', title: 'Match brightness', text: 'match the overall brightness on both sides of the marked area, flat albedo, no shadows and no highlights' },
  { id: 'light-spec', cat: 'lighting', title: 'Remove highlights', text: 'remove specular highlights and reflections inside the marked area' },
  { id: 'con-match', cat: 'contrast', title: 'Match contrast', text: 'match the contrast and saturation on both sides of the marked area' },
  { id: 'con-levels', cat: 'contrast', title: 'Unify black and white level', text: 'unify the black level and white level across the marked area, no washed-out or crushed patch' },
  { id: 'con-cast', cat: 'contrast', title: 'Remove colour cast', text: 'remove the colour cast difference between the two views in the marked area' },
  { id: 'cover-fill', cat: 'cover', title: 'Fill an unpainted gap', text: 'fill the unpainted gap in the marked area with texture that matches the surrounding surface' },
  { id: 'cover-stretch', cat: 'cover', title: 'Replace stretched texels', text: 'replace the stretched or smeared texels in the marked area with natural detail matching the neighbouring surface' },
  { id: 'cover-edge', cat: 'cover', title: 'Extend past island borders', text: 'extend the texture slightly beyond the island border in the marked area so no empty or grey texels remain' },
];

// recommended painter / bake settings for a transition repaint: soft mask edges so the AI result fades into its surroundings
export const HEAL_PROMPT = 'Heal the marked area: remove stretched, smeared or distorted texture, seam lines, texture artifacts and any odd-looking details caused by the 3D geometry. Fill it with clean, natural texture that continues the surrounding material seamlessly, with the same colour, material, lighting and level of detail.';
export const HEAL_SETTINGS = { mask_grow: 6, mask_feather: 10 };
export const TRANSITION_SETTINGS = { mask_grow: 12, mask_feather: 10, bakeStrength: 0.85 };

// final normalization: one pass over the whole visible surface (repeat from several cameras)
export const HARMONIZE_PROMPTS = [
  { id: 'har-photo', title: 'Photorealistic, no borders', strength: 0.6, text: 'make the whole surface look like one photorealistic material: unify colour, brightness and fine detail so there are no visible seams, borders or patches, keep the design, shapes and pattern unchanged' },
  { id: 'har-seams', title: 'Remove all seams only', strength: 0.5, text: 'remove every visible seam and hard border between differently painted areas, keep everything else exactly unchanged' },
  { id: 'har-skin', title: 'Photoreal skin', strength: 0.55, text: 'photorealistic skin: unify the skin tone, pores and fine detail across the whole surface, no patches, no visible borders, keep facial features unchanged' },
  { id: 'har-cloth', title: 'Photoreal fabric', strength: 0.55, text: 'photorealistic fabric: continue the same weave and stitching everywhere, unify colour and brightness, no visible borders between areas' },
  { id: 'har-flat', title: 'Flat albedo (de-light)', strength: 0.6, text: 'flat albedo texture: remove all baked lighting, shadows and highlights, even neutral lighting everywhere, keep colours and details' },
  { id: 'har-detail', title: 'Fix colour only', strength: 0.4, text: 'keep every fine detail exactly and only fix colour and brightness differences between neighbouring areas' },
  { id: 'har-strong', title: 'Strong unify (risky)', strength: 0.8, text: 'strongly unify the whole surface into one consistent photorealistic texture, remove all differences between areas while preserving the overall design' },
];
export const HARMONIZE_STYLE = 'photorealistic, natural detail, no lighting, no shadows, no reflections';

export const promptsByCategory = (cat) => (cat && cat !== 'all' ? TRANSITION_PROMPTS.filter((p) => p.cat === cat) : TRANSITION_PROMPTS.slice());
