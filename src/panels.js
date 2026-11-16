// Panels, HUD drawing and all DOM event wiring for the editor. Installed onto an editor instance.
import * as THREE from 'three';
import { makeSlider, makeCheck, makeButton, h } from './ui.js';
import { extOf, SUPPORTED_EXT } from './meshio.js';
import { BLEND_MODES } from './layers.js';
import { exportModel, bakeUVMap } from './export.js';
import { installViewCube } from './viewcube.js';
import { saveProject, loadProject } from './project.js';
import { installPlanner } from './planner.js';
import { installRefPlace } from './refplace.js';
import { installObjects } from './objects.js';
import { installObjTex } from './objtex.js';
import { installResMatch } from './resmatch.js';
import { installTiles } from './tiles.js';
import { installPick } from './pick.js';
import { installHeal } from './heal.js';
import { installUnwrap } from './unwrap.js';
import { installPbr } from './pbr.js';
import { installViews } from './views.js';
import { installLayerAdj } from './layeradj.js';
import { installViewMenu } from './viewmenu.js';
import { installPromptPreview } from './promptprev.js';
import { installQuick } from './quick.js';
import { installPresets } from './presets.js';
import { installCombine } from './combinepanel.js';
import { installSaveAs } from './saveas.js';
import { installPromptPanels } from './promptpanel.js';

const IMG_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'tga'];

function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

export function installPanels(ed) {
  const ui = ed.ui;
  const st = ed.state;
  const W = (ed._w = {});
  const curTool = () => (st.tool === 'erase' ? st.erase : st.brush);
  const settle = () => ed._dirty('settings');

  // =========================================================================================
  // panels
  // =========================================================================================
  const brushSummary = ui.sec.brush.el.querySelector('summary');
  const bs = ui.sec.brush.body;
  W.size = makeSlider('Size', { min: 2, max: 400, step: 1, value: 70, fmt: (v) => v + ' px' }, (v) => { curTool().size = v; ed.hudDirty = true; ed._dirty('brush'); });
  W.hard = makeSlider('Hardness', { min: 0, max: 100, step: 1, value: 70, fmt: (v) => v + '%' }, (v) => { curTool().hardness = v / 100; ed.hudDirty = true; ed._dirty('brush'); });
  W.soft = makeSlider('Softness', { min: 0, max: 100, step: 1, value: 50, fmt: (v) => v + '%' }, (v) => { curTool().softness = v / 100; ed._dirty('brush'); });
  W.opac = makeSlider('Opacity', { min: 1, max: 100, step: 1, value: 100, fmt: (v) => v + '%' }, (v) => { curTool().opacity = v / 100; ed._dirty('brush'); });
  W.space = makeSlider('Spacing', { min: 2, max: 100, step: 1, value: 12, fmt: (v) => v + '%' }, (v) => { curTool().spacing = v / 100; ed._dirty('brush'); });
  W.stab = makeSlider('Stabilizer', { min: 0, max: 100, step: 1, value: 20, fmt: (v) => v + '%' }, (v) => { curTool().stab = v / 100; ed._dirty('brush'); });
  W.pen = makeCheck('Pen pressure (tablet)', st.pen, (v) => { st.pen = v; ed._dirty('brush'); });
  bs.append(W.size.el, W.hard.el, W.soft.el, W.opac.el, W.space.el, W.stab.el, W.pen.el);
  const note = h('div', 'tp-note', 'Hardness = size of the fully opaque core. Softness = smoothness of the falloff. Brush and eraser keep separate settings.');
  bs.append(note);
  const tgtRow = h('div', 'tp-radio');
  const bTgtSel = makeButton('AI selection', 'The brush paints the mask that is sent to the AI');
  const bTgtLay = makeButton('Layer mask', 'The brush hides (eraser) or reveals (brush) parts of the ACTIVE LAYER');
  const bTgtTr = makeButton('Transition (blue)', 'The brush paints the blue TRANSITION mask: layers are blended smoothly inside it by "Combine layers"');
  const bTgtHeal = makeButton('Heal (green)', 'The brush paints the dark-green HEAL area (Heal brush, J)');
  tgtRow.append(bTgtSel, bTgtLay, bTgtTr, bTgtHeal);
  const tgtNote = h('div', 'tp-note');
  bTgtSel.onclick = () => { st.brushTarget = 'selection'; ed._applyStateToUI(); ed._dirty('settings'); };
  bTgtLay.onclick = () => { st.brushTarget = 'layer'; ed._applyStateToUI(); ed._dirty('settings'); };
  bTgtTr.onclick = () => { st.brushTarget = 'transition'; ed._applyStateToUI(); ed._dirty('settings'); };
  bTgtHeal.onclick = () => { st.brushTarget = 'heal'; ed._applyStateToUI(); ed._dirty('settings'); };
  W.trActive = makeCheck('Transition mask active (used by Combine)', st.combine.useTrans, (v) => { st.combine.useTrans = v; ed._applyStateToUI(); ed._dirty('settings'); ed.invalidate(); });
  bs.insertBefore(W.trActive.el, bs.firstChild);
  bs.insertBefore(tgtNote, bs.firstChild); bs.insertBefore(tgtRow, bs.firstChild);
  bs.insertBefore(h('div', 'tp-lbl', 'Brush paints on'), bs.firstChild);

  const ms = ui.sec.mask.body;
  W.showMask = makeCheck('Show mask (M)', st.mask.show, (v) => { st.mask.show = v; ed.invalidate(); ed._dirty('settings'); });
  W.maskOp = makeSlider('Overlay', { min: 5, max: 100, step: 1, value: 60, fmt: (v) => v + '%' }, (v) => { st.mask.opacity = v / 100; ed.invalidate(); });
  W.amount = makeSlider('Amount', { min: 1, max: 64, step: 1, value: 8, fmt: (v) => v + ' px' }, (v) => { st.mask.amount = v; });
  const mkRow = (...btns) => { const r = h('div', 'tp-row2'); r.append(...btns); return r; };
  const bClear = makeButton('Clear all', 'Remove ALL painted mask (Undo brings it back)'), bFill = makeButton('Fill all'), bInv = makeButton('Invert');
  const bGrow = makeButton('Grow'), bShrink = makeButton('Shrink'), bFeather = makeButton('Feather');
  const bImpMask = makeButton('Import PNG'), bExpMask = makeButton('Export PNG');
  bClear.onclick = () => ed.maskClear();
  bFill.onclick = () => ed.maskFill();
  bInv.onclick = () => ed.maskInvert();
  bGrow.onclick = () => ed.maskMorph(0, st.mask.amount);
  bShrink.onclick = () => ed.maskMorph(1, st.mask.amount);
  bFeather.onclick = () => ed.maskMorph(2, st.mask.amount);
  const maskFile = h('input'); maskFile.type = 'file'; maskFile.accept = 'image/*'; maskFile.style.display = 'none';
  maskFile.onchange = async () => {
    const f = maskFile.files[0]; maskFile.value = '';
    if (!f) return;
    try { const bmp = await createImageBitmap(f); ed.importMaskBitmap(bmp); ed.log('ok', 'Mask imported.'); } catch (e) { ed.log('error', 'Mask import failed', e); }
  };
  bImpMask.onclick = () => maskFile.click();
  bExpMask.onclick = async () => { try { download(await ed.exportMaskBlob(), 'uv_mask.png'); } catch (e) { ed.log('error', 'Mask export failed', e); } };
  ms.append(W.showMask.el, W.maskOp.el, mkRow(bClear, bFill, bInv), W.amount.el, mkRow(bGrow, bShrink, bFeather), mkRow(bImpMask, bExpMask), maskFile);
  ms.append(h('div', 'tp-note', 'The mask lives in UV space, so it is independent of the camera. Orange = masked area seen at a grazing angle (poor bake from this view).'));

  // ---- layers ---------------------------------------------------------------------------
  const ls = ui.sec.layers.body;
  const layerList = h('div', 'tp-layers');
  const bAdd = makeButton('+ Layer', 'Add an empty layer above the active one');
  const bAddImg = makeButton('+ Image...', 'Add an image file as a new layer');
  const bRename = makeButton('Rename', 'Rename the active layer (or double-click its name)');
  const bDup = makeButton('Duplicate'), bDel = makeButton('Delete');
  const bMerge = makeButton('Merge down', 'Merge the active layer into the one below');
  const bMergeVis = makeButton('Merge visible', 'Merge all visible layers into one layer (hidden layers stay)');
  const bFlat = makeButton('Flatten all', 'Collapse everything visible into ONE opaque layer (hidden layers are dropped)');
  const layerImgFile = h('input'); layerImgFile.type = 'file'; layerImgFile.accept = 'image/*'; layerImgFile.style.display = 'none';
  layerImgFile.onchange = async () => {
    const f = layerImgFile.files[0]; layerImgFile.value = '';
    if (!f) return;
    try { await ed.addImageLayerFile(f); } catch (e) { ed.log('error', 'Could not add the image as a layer', e); ed.setStatus(e.message, 'err'); }
  };
  W.lop = makeSlider('Opacity', { min: 0, max: 100, step: 1, value: 100, fmt: (v) => v + '%' }, (v) => ed.layers.setProp(ed.layers.active, { opacity: v / 100 }));
  const blendSel = h('select');
  for (const [id, label] of BLEND_MODES) { const o = h('option', null, label); o.value = id; blendSel.append(o); }
  blendSel.onchange = () => ed.layers.setProp(ed.layers.active, { blend: blendSel.value });
  const blendRow = h('div', 'tp-row'); blendRow.append(h('span', 'tp-lbl', 'Blend'), blendSel, h('span'));
  W.lock = makeCheck('Lock layer (no mask painting)', false, (v) => ed.layers.setProp(ed.layers.active, { locked: v }));
  const bReveal = makeButton('Reveal all', 'Remove the layer mask (everything of this layer visible again)');
  const bHideAll = makeButton('Hide all', 'Hide the whole layer behind a mask, then reveal parts with the brush');
  const bRevert = makeButton('Revert layer', 'Back to the original state of the active layer: original pixels, mask removed (undoable)');
  const bEraseAI = makeButton('Erase with brush', 'Switch to the eraser on the layer mask: paint to hide parts of the active layer (non-destructive, the Brush restores them)');
  const bLUndo = makeButton('\u21B6 Undo', 'Undo the last change (layers, masks, selection) - Ctrl+Z');
  const bLRedo = makeButton('\u21B7 Redo', 'Redo - Ctrl+Y / Ctrl+Shift+Z');
  bRevert.onclick = () => { if (ed.layers.revert(ed.layers.active)) ed.setStatus('Layer reverted to its original state (Undo brings the edits back).', 'ok'); else ed.setStatus('This layer is still in its original state.', 'info'); };
  bEraseAI.onclick = () => { st.brushTarget = 'layer'; ed.setTool('erase'); ed._applyStateToUI(); ed._dirty('settings'); ed.setStatus('Eraser on the layer mask: paint (or use Rect/Lasso) to hide parts of the active layer. Brush = restore, Revert layer = undo all erasing.', 'ok'); };
  bLUndo.onclick = () => ed.undo(); bLRedo.onclick = () => ed.redo();
  const layerInfo = h('div', 'tp-note');
  const mkRow2 = (...b) => { const r = h('div', 'tp-row2'); r.append(...b); return r; };
  bAdd.onclick = () => { try { ed.layers.addEmpty('Layer'); } catch (e) { ed.setStatus(e.message, 'warn'); } };
  bAddImg.onclick = () => layerImgFile.click();
  bDup.onclick = () => ed.layers.duplicate(ed.layers.active);
  bDel.onclick = () => ed.layers.remove(ed.layers.active);
  bMerge.onclick = () => ed.layers.mergeDown(ed.layers.active);
  bMergeVis.onclick = () => ed.layers.mergeVisible();
  bFlat.onclick = () => ed.layers.flattenAll();
  bReveal.onclick = () => ed.layers.setMask(ed.layers.active, 'reveal');
  bHideAll.onclick = () => ed.layers.setMask(ed.layers.active, 'hide');
  ls.append(mkRow2(bAdd, bAddImg, bRename), layerList, W.lop.el, blendRow, W.lock.el,
    mkRow2(bDup, bDel, bMerge), mkRow2(bMergeVis, bFlat), h('div', 'tp-lbl', 'Layer mask (hide / reveal with the brush):'), mkRow2(bReveal, bHideAll), h('div', 'tp-lbl', 'Erase / revert / history:'), mkRow2(bEraseAI, bRevert), mkRow2(bLUndo, bLRedo), layerInfo, layerImgFile);
  ls.append(h('div', 'tp-note', 'Set "Brush paints on" to "Layer mask": the Brush reveals, the Eraser hides parts of the active layer. This blends AI results into the layers below. AI results arrive as a new layer with soft edges.'));

  let renameIdx = -1;
  const startRename = (i) => { renameIdx = i; ed._renderLayers(); };
  bRename.onclick = () => startRename(ed.layers.active);
  let dragFrom = -1;
  ed._renderLayers = () => {
    const L = ed.layers;
    layerList.innerHTML = '';
    for (let i = L.layers.length - 1; i >= 0; i--) {
      const l = L.layers[i];
      const row = h('div', 'tp-layer' + (i === L.active ? ' tp-sel' : ''));
      row.draggable = true;
      const eye = h('span', 'tp-eye' + (l.visible ? '' : ' tp-off'), l.visible ? '\u{1F441}' : '\u25CC');
      eye.title = l.visible ? 'Hide layer' : 'Show layer';
      eye.onclick = (ev) => { ev.stopPropagation(); L.setProp(i, { visible: !l.visible }); };
      const cv = h('canvas'); cv.width = cv.height = 40;
      try { cv.getContext('2d').drawImage(L.thumb(l), 0, 0); } catch (_) { /* thumbnail is cosmetic */ }
      const nm = h('div', 'tp-nm');
      if (renameIdx === i) {
        const inp = h('input'); inp.value = l.name;
        const done = (ok) => { if (renameIdx !== i) return; renameIdx = -1; if (ok) L.rename(i, inp.value); else ed._renderLayers(); };
        inp.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); else if (ev.key === 'Escape') done(false); };
        inp.onblur = () => done(true);
        inp.onclick = (ev) => ev.stopPropagation();
        nm.append(inp);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
      } else {
        nm.append(h('div', null, l.name));
        nm.append(h('div', 'tp-sm', `${Math.round(l.opacity * 100)}% \u00B7 ${(BLEND_MODES.find((m) => m[0] === l.blend) || BLEND_MODES[0])[1]}${l.mask ? ' \u00B7 masked' : ''}${l.locked ? ' \u00B7 locked' : ''}`));
        nm.ondblclick = (ev) => { ev.stopPropagation(); startRename(i); };
      }
      row.append(eye, cv, nm);
      row.onclick = () => L.select(i);
      row.ondragstart = (ev) => { dragFrom = i; ev.dataTransfer.effectAllowed = 'move'; try { ev.dataTransfer.setData('text/plain', String(i)); } catch (_) { /* ignore */ } };
      row.ondragover = (ev) => { ev.preventDefault(); row.classList.add('tp-over'); };
      row.ondragleave = () => row.classList.remove('tp-over');
      row.ondrop = (ev) => { ev.preventDefault(); row.classList.remove('tp-over'); if (dragFrom >= 0) L.move(dragFrom, i); dragFrom = -1; };
      layerList.append(row);
    }
    const a = L.activeLayer;
    W.lop.set(a ? Math.round(a.opacity * 100) : 100);
    blendSel.value = a ? a.blend : 'normal';
    W.lock.set(a ? a.locked : false);
    const px = L.w * L.h;
    const mb = (L.registry.size ? Array.from(L.registry).reduce((n, rt) => n + (rt.width * rt.height * (rt.texture.format === THREE.RedFormat ? 1 : 4)), 0) : 0) / 1048576 + (px * 8 * 4) / 1048576;
    layerInfo.textContent = `${L.layers.length} layer${L.layers.length === 1 ? '' : 's'} \u00B7 ${L.w}x${L.h} \u00B7 about ${Math.round(mb)} MB GPU memory (max ${L.maxLayers} layers)`;
    bMerge.disabled = L.active < 1;
    bDel.disabled = L.layers.length < 2;
    bRevert.disabled = !L.canRevert(L.active);
    ui.btn.tUndo.disabled = !ed.undoStack.length;
    ui.btn.tRedo.disabled = !ed.redoStack.length;
    bLUndo.disabled = !ed.undoStack.length; bLRedo.disabled = !ed.redoStack.length;
    bLUndo.title = `Undo (${ed.undoStack.length} step${ed.undoStack.length === 1 ? '' : 's'} available) - Ctrl+Z`;
    bLRedo.title = `Redo (${ed.redoStack.length} step${ed.redoStack.length === 1 ? '' : 's'} available) - Ctrl+Y`;
  };

  // ---- reference image 2 ------------------------------------------------------------------
  const rf = ui.sec.ref.body;
  const R = () => ed.refState();
  // which reference image the controls below (and "Place on model") work on: image 2 or the extra images 3..6
  const refSel = h('select'); for (let n = 2; n <= 6; n++) { const o = h('option', null, 'Image ' + n); o.value = String(n); refSel.append(o); }
  refSel.onchange = () => ed.setRefActive(+refSel.value);
  const refSelRow = h('div', 'tp-row'); refSelRow.append(h('span', 'tp-lbl', 'Reference image'), refSel, h('span'));
  const refRole = h('input'); refRole.type = 'text'; refRole.style.cssText = 'width:100%;box-sizing:border-box';
  refRole.oninput = () => { R().role = refRole.value.slice(0, 200); ed._dirty(ed.refDirtyKind()); };
  const ANGLES = ['', 'front', 'back', 'left side', 'right side', 'top', 'bottom', 'front left three-quarter view', 'front right three-quarter view', 'back left three-quarter view', 'back right three-quarter view', 'close-up detail'];
  const refAng = h('select'); for (const a of ANGLES) { const o = h('option', null, a || '(no angle label)'); o.value = a; refAng.append(o); }
  refAng.onchange = () => { R().angle = refAng.value; ed._dirty(ed.refDirtyKind()); };
  const refAngRow = h('div', 'tp-row'); refAngRow.append(h('span', 'tp-lbl', 'Angle of this image'), refAng, h('span'));
  const bAngSave = makeButton('Save current view as its angle', 'Remember the camera of the 3D view for this reference image'), bAngGo = makeButton('Go to its angle', 'Move the camera to the saved angle of this reference image');
  bAngSave.onclick = () => { ed.refSaveAngle(); ed.setStatus('Camera saved for image ' + ed.refActive + '.', 'ok'); ed._renderRef2(); };
  bAngGo.onclick = () => { if (!ed.refGotoAngle()) ed.setStatus('No camera saved for image ' + ed.refActive + ' yet.', 'warn'); };
  const refFile = h('input'); refFile.type = 'file'; refFile.accept = 'image/*'; refFile.style.display = 'none';
  const bRefLoad = makeButton('Load image 2...'), bRefClear = makeButton('Remove');
  const refThumb = h('canvas', 'tp-thumb2'); refThumb.width = 96; refThumb.height = 96; refThumb.style.display = 'none';
  W.refUse = makeCheck('Use the selected image as a reference', R().enabled, (v) => {
    if (v && !R().has) { ed.setStatus('Load image ' + ed.refActive + ' first.', 'warn'); W.refUse.set(false); return; }
    R().enabled = v; ed._dirty(ed.refDirtyKind());
  });
  W.refW = makeSlider('Weight', { min: 0, max: 100, step: 1, value: 70, fmt: (v) => (v / 100).toFixed(2) }, (v) => { R().weight = v / 100; ed._dirty(ed.refDirtyKind()); });
  const refMode = h('select');
  for (const [v, t] of [['mask', 'Fit to masked area'], ['frame', 'Fill the frame'], ['tile', 'Tile'], ['manual', 'Manual (Place on model)']]) { const o = h('option', null, t); o.value = v; refMode.append(o); }
  refMode.onchange = () => { R().mode = refMode.value; ed._dirty(ed.refDirtyKind()); };
  ed._refModeSel = refMode;
  const refModeRow = h('div', 'tp-row'); refModeRow.append(h('span', 'tp-lbl', 'Placement'), refMode, h('span'));
  W.refScale = makeSlider('Scale', { min: 25, max: 400, step: 5, value: 100, fmt: (v) => v + '%' }, (v) => { R().scale = v / 100; ed._dirty(ed.refDirtyKind()); });
  W.refRot = makeSlider('Rotate', { min: -180, max: 180, step: 1, value: 0, fmt: (v) => v + '\u00B0' }, (v) => { R().rot = v; ed._dirty(ed.refDirtyKind()); });
  bRefLoad.onclick = () => refFile.click();
  refFile.onchange = async () => {
    const f = refFile.files[0]; refFile.value = '';
    if (!f) return;
    try { await ed.setRefImage(ed.refActive, f); } catch (e) { ed.log('error', 'Could not load image 2', e); ed.setStatus(e.message, 'err'); }
  };
  bRefClear.onclick = () => ed.clearRefImage(ed.refActive);
  const bRefLayer = makeButton('Use active layer', 'Style lock: use the active layer (cropped to its content) as image 2');
  const bRefTex = makeButton('Use whole texture', 'Style lock: use the current composite texture as image 2');
  bRefLayer.onclick = async () => { try { const n = await ed.setRef2FromLayer('layer', ed.refActive); ed.setStatus('Image ' + ed.refActive + ' = layer "' + n + '".', 'ok'); } catch (e) { ed.setStatus(e.message, 'warn'); } };
  bRefTex.onclick = async () => { try { await ed.setRef2FromLayer('texture', ed.refActive); ed.setStatus('Image ' + ed.refActive + ' = current texture.', 'ok'); } catch (e) { ed.setStatus(e.message, 'warn'); } };
  rf.append(refSelRow, mkRow2(bRefLoad, bRefClear), mkRow2(bRefLayer, bRefTex), refThumb, refAngRow, mkRow2(bAngSave, bAngGo), refRole, W.refUse.el, W.refW.el, refModeRow, W.refScale.el, W.refRot.el, refFile);
  rf.append(h('div', 'tp-note', 'Images 2-6 all work the same way: pick one in the list, load it, set its placement / weight, give it an angle label and a role text (both are added to the prompt, e.g. "Image 3 shows the subject from the back."). "Save current view as its angle" remembers the camera so you can return to the view this picture belongs to, then Place on model. Outputs: reference_image (2), reference_image_3 ... reference_image_6; connect them to the reference slots of your workflow. The image selected here is the one "Place on model" and the fit options act on. An image is placed over the masked area of the view that is sent to the generator. Weight = how much of the masked area shows image 2 instead of the marker colour (0 = ignored, 1 = fully). The node also outputs reference_image and reference_weight for a second reference input of the Klein workflow.'));
  ed._renderRef2 = () => {
    const n = ed.refActive, c = ed.refCanvas();
    refSel.value = String(n); bRefLoad.textContent = `Load image ${n}...`;
    refRole.placeholder = `What is image ${n}? (e.g. "leather material")`; refRole.value = R().role || ''; refAng.value = R().angle || '';
    bAngGo.disabled = !R().cam; bAngSave.textContent = R().cam ? 'Update saved angle (current view)' : 'Save current view as its angle';
    for (let k = 2; k <= 6; k++) { const has = ed.refState(k).has; refSel.options[k - 2].textContent = 'Image ' + k + (has ? ' \u2713' : '') + (ed.refState(k).cam ? ' \u25CE' : ''); }
    refThumb.style.display = c ? 'block' : 'none';
    if (c) {
      const g = refThumb.getContext('2d'); g.clearRect(0, 0, 96, 96);
      const k = Math.min(96 / c.width, 96 / c.height); refThumb.width = Math.round(c.width * k); refThumb.height = Math.round(c.height * k);
      refThumb.getContext('2d').drawImage(c, 0, 0, refThumb.width, refThumb.height);
    }
    W.refUse.set(R().enabled && R().has);
  };

  // ---- export / bake ------------------------------------------------------------------------
  const ex = ui.sec.exp.body;
  const fmtSel = h('select');
  for (const [v, t] of [['glb', 'GLB (texture embedded)'], ['obj', 'OBJ + MTL + PNG (zip)']]) { const o = h('option', null, t); o.value = v; fmtSel.append(o); }
  fmtSel.onchange = () => { st.export.format = fmtSel.value; ed._dirty('settings'); };
  const spaceSel = h('select');
  for (const [v, t] of [['original', 'Original file orientation & size'], ['shown', 'As oriented in the editor']]) { const o = h('option', null, t); o.value = v; spaceSel.append(o); }
  spaceSel.onchange = () => { st.export.space = spaceSel.value; ed._dirty('settings'); };
  const fmtRow = h('div', 'tp-row'); fmtRow.append(h('span', 'tp-lbl', 'Format'), fmtSel, h('span'));
  const spaceRow = h('div', 'tp-row'); spaceRow.append(h('span', 'tp-lbl', 'Model'), spaceSel, h('span'));
  W.pad = makeSlider('Seam padding', { min: 0, max: 32, step: 1, value: 8, fmt: (v) => v + ' px' }, (v) => { st.layers.padding = v; ed._dirty('settings'); });
  W.saveServer = makeCheck('Also save a copy in ComfyUI/output/texpaint', st.export.saveServer, (v) => { st.export.saveServer = v; ed._dirty('settings'); });
  const bExpModel = makeButton('Export textured model', 'Export the model with the baked texture', 'tp-pri');
  const bBake = makeButton('Bake UV map PNG', 'Composite all visible layers into the final UV texture (with seam padding)');
  ed._deliver = async (blob, name) => {
    download(blob, name);
    if (st.export.saveServer && ed.hooks.onExportFile) {
      try { const r = await ed.hooks.onExportFile(blob, name); ed.log('ok', `Saved a copy in the ComfyUI output folder: ${r.path}`); } catch (e) { ed.log('error', 'Could not save into the ComfyUI output folder', e); }
    }
  };
  const busy = async (btn, fn) => {
    btn.disabled = true;
    try { await fn(); } catch (e) { ed.log('error', 'Export failed', e); ed.setStatus('Export failed: ' + e.message, 'err'); }
    btn.disabled = false;
  };
  bExpModel.onclick = () => busy(bExpModel, async () => {
    if (!ed.hasModel) throw new Error('No model loaded.');
    ed.setStatus('Exporting ...');
    const t0 = performance.now();
    const r = await exportModel(ed, { format: st.export.format, space: st.export.space, padding: st.layers.padding });
    await ed._deliver(r.blob, r.name);
    ed.log('ok', `Exported ${r.name} (${(r.blob.size / 1048576).toFixed(1)} MB, ${Math.round(performance.now() - t0)} ms).`);
    ed.setStatus('Exported ' + r.name, 'ok');
  });
  bBake.onclick = () => busy(bBake, async () => {
    const r = await bakeUVMap(ed, st.layers.padding);
    await ed._deliver(r.blob, r.name);
    ed.log('ok', `Baked UV map ${r.name} (${ed.layers.w}x${ed.layers.h}).`);
    ed.setStatus('Baked ' + r.name, 'ok');
  });
  ex.append(fmtRow, spaceRow, W.pad.el, W.saveServer.el, mkRow2(bExpModel, bBake));
  // ---- project backup + storage
  const bSaveProj = makeButton('Save project (.zip)', 'Backup: model, all layers and masks, reference image and settings in one file');
  const bSaveAsProj = makeButton('Save project as\u2026', 'Choose the folder and what is written: whole project ZIP, loose files, flattened texture', 'tp-pri');
  bSaveAsProj.onclick = () => ed.openSaveAs();
  const bOpenProj = makeButton('Open project\u2026', 'Restore a project saved with "Save project"');
  const projInput = h('input'); projInput.type = 'file'; projInput.accept = '.zip'; projInput.style.display = 'none'; ui.root.append(projInput);
  bSaveProj.onclick = () => busy(bSaveProj, async () => {
    const r = await saveProject(ed); await ed._deliver(r.blob, r.name);
    ed.log('ok', `Project saved: ${r.name} (${(r.blob.size / 1048576).toFixed(1)} MB).`); ed.setStatus('Project saved: ' + r.name, 'ok');
  });
  bOpenProj.onclick = () => projInput.click();
  projInput.onchange = () => { const f = projInput.files[0]; projInput.value = ''; if (!f) return; busy(bOpenProj, async () => {
    ed.setStatus('Opening project ...'); await loadProject(ed, f); ed.log('ok', `Project opened: ${f.name}`); ed.setStatus('Project opened: ' + f.name, 'ok');
  }); };
  const storNote = h('div', 'tp-note', '');
  const bStor = makeButton('Storage info', 'How much disk the saved sessions use');
  const bClean = makeButton('Clean old sessions', 'Delete saved sessions that were not used for 7 days (open nodes are kept)');
  const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
  bStor.onclick = async () => {
    if (!ed.hooks.getStorage) { storNote.textContent = 'Storage info is available inside ComfyUI.'; return; }
    try { const s = await ed.hooks.getStorage(); storNote.textContent = `${s.sessions} saved sessions use ${mb(s.session_bytes)}; uploaded models ${mb(s.model_bytes)}; least recently used session: ${s.oldest_days} days ago.`; }
    catch (e) { storNote.textContent = 'Could not read storage info: ' + e.message; }
  };
  bClean.onclick = async () => {
    if (!ed.hooks.cleanup) { storNote.textContent = 'Cleaning is available inside ComfyUI.'; return; }
    try { const r = await ed.hooks.cleanup(7); storNote.textContent = `Removed ${r.removed} old sessions, freed ${mb(r.freed_bytes)}.`; ed.log('ok', storNote.textContent); }
    catch (e) { storNote.textContent = 'Cleanup failed: ' + e.message; }
  };
  ex.append(h('div', 'tp-lbl', 'Project backup'), mkRow2(bSaveAsProj, bSaveProj), mkRow2(bOpenProj), h('div', 'tp-lbl', 'Disk usage'), mkRow2(bStor, bClean), storNote);
  ex.append(h('div', 'tp-note', 'The model is exported as ONE merged mesh with one material (original hierarchy and names are not kept). "Original" restores the size and orientation of the loaded file; "As oriented" applies your Model transform. Seam padding spreads colours past the UV island borders.'));

  const cs = ui.sec.cap.body;
  const aspectSel = h('select');
  for (const a of ['1:1', '4:3', '3:4', '3:2', '2:3', '16:9', '9:16']) { const o = h('option', null, a); o.value = a; aspectSel.append(o); }
  aspectSel.onchange = () => { st.capture.aspect = aspectSel.value; updateCapLabel(); ed.invalidate(); ed._dirty('capture'); };
  const aspectRow = h('div', 'tp-row'); aspectRow.append(h('span', 'tp-lbl', 'Aspect'), aspectSel, h('span'));
  W.long = makeSlider('Long side', { min: 256, max: 4096, step: 64, value: 1024, fmt: (v) => v }, (v) => { st.capture.long = v; updateCapLabel(); ed.invalidate(); ed._dirty('capture'); });
  const shadeSel = h('select');
  for (const [v, t] of [['unlit', 'Unlit (albedo only)'], ['soft', 'Soft shading']]) { const o = h('option', null, t); o.value = v; shadeSel.append(o); }
  shadeSel.onchange = () => { st.capture.shading = shadeSel.value; ed._dirty('capture'); };
  const shadeRow = h('div', 'tp-row'); shadeRow.append(h('span', 'tp-lbl', 'Shading'), shadeSel, h('span'));
  const bgIn = h('input'); bgIn.type = 'color'; bgIn.value = '#808080';
  bgIn.oninput = () => { st.capture.bg = bgIn.value; ed._dirty('capture'); };
  const layBg = h('input'); layBg.type = 'color'; layBg.value = '#808080';
  layBg.oninput = () => { st.layers.bg = layBg.value; ed._layersChanged(); };
  const bgRow = h('div', 'tp-row'); bgRow.append(h('span', 'tp-lbl', 'Background'), bgIn, h('span'));
  W.facing = makeSlider('Min facing', { min: 0, max: 90, step: 1, value: 25, fmt: (v) => (v / 100).toFixed(2) }, (v) => { st.capture.facing = v / 100; ed.invalidate(); ed._dirty('capture'); });
  W.frame = makeCheck('Show capture frame', st.capture.frame, (v) => { st.capture.frame = v; ed.hudDirty = true; });
  const capLabel = h('div', 'tp-note');
  const updateCapLabel = () => { const [w, hh] = ed.captureSize(); capLabel.textContent = `Output size: ${w} x ${hh}. Everything inside the frame is sent to the generator.`; ed.hudDirty = true; };
  const srcSel = h('select');
  for (const [v, t] of [['composite', 'All visible layers'], ['below', 'Layers below the active one'], ['active', 'Active layer only']]) { const o = h('option', null, t); o.value = v; srcSel.append(o); }
  srcSel.onchange = () => { st.layers.captureSource = srcSel.value; ed._layersChanged(); };
  const srcRow = h('div', 'tp-row'); srcRow.append(h('span', 'tp-lbl', 'Texture seen'), srcSel, h('span'));
  cs.append(srcRow);
  cs.append(aspectRow, W.long.el, shadeRow, bgRow, W.facing.el, W.frame.el, capLabel);
  ed._updateCapLabel = updateCapLabel;

  // ---- model transform (fix a wrongly oriented / scaled model)
  const xs = ui.sec.xf.body, XF = {};
  const deg = (v) => v + '\u00B0';
  const xf = (k, v) => ed.setXform({ [k]: v });
  XF.rx = makeSlider('Rotate X', { min: -180, max: 180, step: 1, value: 0, fmt: deg }, (v) => xf('rx', v));
  XF.ry = makeSlider('Rotate Y', { min: -180, max: 180, step: 1, value: 0, fmt: deg }, (v) => xf('ry', v));
  XF.rz = makeSlider('Rotate Z', { min: -180, max: 180, step: 1, value: 0, fmt: deg }, (v) => xf('rz', v));
  XF.s = makeSlider('Scale', { min: 10, max: 300, step: 1, value: 100, fmt: (v) => v + '%' }, (v) => xf('s', v / 100));
  XF.ox = makeSlider('Move X', { min: -150, max: 150, step: 1, value: 0, fmt: (v) => (v / 100).toFixed(2) }, (v) => xf('ox', v / 100));
  XF.oy = makeSlider('Move Y', { min: -150, max: 150, step: 1, value: 0, fmt: (v) => (v / 100).toFixed(2) }, (v) => xf('oy', v / 100));
  XF.oz = makeSlider('Move Z', { min: -150, max: 150, step: 1, value: 0, fmt: (v) => (v / 100).toFixed(2) }, (v) => xf('oz', v / 100));
  const flipRow = h('div', 'tp-row2');
  XF.fx = makeCheck('Flip X', false, (v) => xf('fx', v));
  XF.fy = makeCheck('Flip Y', false, (v) => xf('fy', v));
  XF.fz = makeCheck('Flip Z', false, (v) => xf('fz', v));
  flipRow.append(XF.fx.el, XF.fy.el, XF.fz.el);
  const stepRow = h('div', 'tp-row2');
  for (const [k, t] of [['rx', 'X +90\u00B0'], ['ry', 'Y +90\u00B0'], ['rz', 'Z +90\u00B0']]) {
    const b = makeButton(t, 'Rotate the model by 90 degrees'); b.onclick = () => ed.hasModel && xf(k, ed.state.xform[k] + 90); stepRow.append(b);
  }
  const presetRow = h('div', 'tp-row2');
  const bZup = makeButton('Z-up \u2192 Y-up', 'Model lies on its back (Blender / CAD export): rotates X by -90\u00B0');
  bZup.onclick = () => ed.hasModel && ed.setXform({ rx: -90, ry: 0, rz: 0 });
  const bFit = makeButton('Fit', 'Scale so the farthest vertex touches the unit sphere');
  bFit.onclick = () => ed.hasModel && ed.setXform({}, { fit: true });
  const bXfReset = makeButton('Reset', 'Back to the orientation of the file');
  bXfReset.onclick = () => ed.hasModel && ed.resetXform();
  presetRow.append(bZup, bFit, bXfReset);
  xs.append(XF.rx.el, XF.ry.el, XF.rz.el, stepRow, XF.s.el, XF.ox.el, XF.oy.el, XF.oz.el, flipRow, presetRow,
    h('div', 'tp-note', 'Fixes the model orientation. The mask and texture stay in UV space, so painting is not affected; changes apply to everything captured afterwards.'));
  ed._syncXformUI = () => {
    const x = st.xform;
    XF.rx.set(x.rx); XF.ry.set(x.ry); XF.rz.set(x.rz); XF.s.set(Math.round(x.s * 100));
    XF.ox.set(Math.round(x.ox * 100)); XF.oy.set(Math.round(x.oy * 100)); XF.oz.set(Math.round(x.oz * 100));
    XF.fx.set(x.fx); XF.fy.set(x.fy); XF.fz.set(x.fz);
  };

  const ds = ui.sec.disp.body;
  W.wire = makeCheck("3D wireframe overlay", st.display.wire3d, (v) => { st.display.wire3d = v; if (ed.wireMesh) ed.wireMesh.visible = v && ed.mesh.visible; ed.invalidate(); ed._dirty("settings"); ed._applyStateToUI(); });
  W.shade = makeSlider('3D shading', { min: 0, max: 100, step: 1, value: 0, fmt: (v) => v + '%' }, (v) => { st.display.shade3d = v / 100; ed.invalidate(); });
  W.uvwire = makeSlider('UV lines', { min: 0, max: 100, step: 1, value: 35, fmt: (v) => v + '%' }, (v) => { st.display.uvWire = v / 100; ed.invalidate(); });
  W.checker = makeCheck('UV checker on the 3D model (check stretching)', st.display.checker3d, (v) => { st.display.checker3d = v; ed.invalidate(); ed._dirty('settings'); });
  const bmBox = h('div', 'tp-layers'); bmBox.style.maxHeight = '120px';
  ed._refreshBookmarks = () => {
    bmBox.innerHTML = '';
    if (!st.bookmarks.length) bmBox.append(h('div', 'tp-note', 'No bookmarks yet. Press the star under the view cube to save the current camera.'));
    st.bookmarks.forEach((b, i) => {
      const row = h('div', 'tp-layer');
      const go = h('span', '', `${i + 1}. ${b.name}${b.ortho ? ' (ortho)' : ''}`); go.style.flex = '1';
      const del = h('button', 'tp-btn', '\u2715'); del.title = 'Delete bookmark';
      row.onclick = () => ed.gotoBookmark(i);
      del.onclick = (e) => { e.stopPropagation(); ed.deleteBookmark(i); };
      row.append(go, del); bmBox.append(row);
    });
  };
  ds.append(W.wire.el, W.checker.el, W.shade.el, W.uvwire.el, h('div', 'tp-lbl', 'Camera bookmarks (click to go)'), bmBox);
  ed._refreshBookmarks();
  installViewCube(ed);

  // ---- prompt helper: style chips, history, favourites (they edit the node's prompt widget through hooks)
  {
    const ps = ui.sec.prompt.body;
    const KEY = 'texpaint_prompts';
    const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || { hist: [], fav: [] }; } catch (_) { return { hist: [], fav: [] }; } };
    const save = (d) => { try { localStorage.setItem(KEY, JSON.stringify(d)); } catch (_) { /* private mode */ } };
    const STYLES = ['photoreal', 'weathered stone', 'rusty metal', 'worn leather', 'mossy', 'wet / damp', 'painted wood', 'cracked paint', 'fabric weave', 'hand-painted stylized', 'dirt and grime', 'scratches and wear'];
    const getP = () => (ed.hooks.getPrompt ? ed.hooks.getPrompt() : ed._promptText || '');
    const setP = (t) => { if (ed.hooks.setPrompt) ed.hooks.setPrompt(t); else ed._promptText = t; };
    const chips = h('div', 'tp-row2');
    for (const t of STYLES) {
      const b = h('button', 'tp-btn', t); b.style.padding = '2px 7px'; b.style.fontSize = '11px';
      b.title = 'Add "' + t + '" to the prompt';
      b.onclick = () => { const p = getP().trim(); if (!new RegExp('(^|,\\s*)' + t.replace(/[/.*+?^${}()|[\]\\]/g, '\\$&') + '(,|$)', 'i').test(p)) setP(p ? p + ', ' + t : t); };
      chips.append(b);
    }
    const hist = h('div', 'tp-layers'); hist.style.maxHeight = '140px';
    const render = () => {
      const d = load(); hist.innerHTML = '';
      const rows = [...d.fav.map((t) => ({ t, f: true })), ...d.hist.filter((t) => !d.fav.includes(t)).map((t) => ({ t, f: false }))];
      if (!rows.length) hist.append(h('div', 'tp-note', 'Prompts you generate with appear here. Click one to reuse it, star to keep it.'));
      for (const r of rows) {
        const row = h('div', 'tp-layer'); const lab = h('span', '', r.t); lab.style.cssText = 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'; lab.title = r.t;
        const star = h('button', 'tp-btn', r.f ? '\u2605' : '\u2606'); star.title = r.f ? 'Remove from favourites' : 'Keep as favourite';
        star.onclick = (e) => { e.stopPropagation(); const dd = load(); dd.fav = r.f ? dd.fav.filter((x) => x !== r.t) : [r.t, ...dd.fav].slice(0, 30); save(dd); render(); };
        row.onclick = () => setP(r.t);
        row.append(lab, star); hist.append(row);
      }
    };
    ed.rememberPrompt = (t) => {
      t = (t || '').trim(); if (!t) return;
      const d = load(); d.hist = [t, ...d.hist.filter((x) => x !== t)].slice(0, 20); save(d); render();
    };
    const bLayerPrompt = makeButton('Use prompt of active layer', 'Copies the prompt stored in the active AI layer (or its name) into the prompt field');
    bLayerPrompt.onclick = () => {
      const l = ed.layers.activeLayer; if (!l) return;
      const t = (l.prompt || l.name.replace(/^AI:\s*/, '')).trim();
      if (!t) { ed.setStatus('The active layer has no prompt.', 'warn'); return; }
      setP(t); ed.setStatus('Prompt copied from layer "' + l.name + '".', 'ok');
    };
    ps.append(bLayerPrompt, h('div', 'tp-lbl', 'Style chips (add to the prompt)'), chips, h('div', 'tp-lbl', 'History / favourites'), hist);
    render();
  }

  const rs = ui.sec.res.body;
  W.clearMask = makeCheck('Remove baked area from mask after Apply', st.options.clearMask, (v) => { st.options.clearMask = v; ed._dirty('settings'); });
  W.autoApply = makeCheck('Apply results automatically', st.options.autoApply, (v) => { st.options.autoApply = v; ed._dirty('settings'); });
  W.replaceActive = makeCheck('Bake results into the active layer (instead of a new layer)', st.layers.replaceActive, (v) => { st.layers.replaceActive = v; ed._dirty('settings'); });
  const layBgRow = h('div', 'tp-row'); layBgRow.append(h('span', 'tp-lbl', 'Empty areas'), layBg, h('span'));
  rs.append(W.replaceActive.el, layBgRow, W.clearMask.el, W.autoApply.el, h('div', 'tp-note', 'When the Bake node finishes, the result is shown here as a preview layer. Apply it (new layer, undoable), compare it with the old look, or discard it. "Empty areas" is the colour shown where no layer has pixels.'));

  // ---- bottom clipboards / logs
  const bDiag = makeButton('Copy diagnostics', 'Copies versions, GPU info, model info and the last log lines - paste this when reporting a problem');
  ui.btn.bCopyLog.after(bDiag);
  bDiag.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(ed.diagnostics()).then(() => ed.setStatus('Diagnostics copied to clipboard.', 'ok')); };
  ui.btn.bCopyLog.onclick = () => { navigator.clipboard && navigator.clipboard.writeText(ed.logLines.join('\n')).then(() => ed.setStatus('Log copied to clipboard.', 'ok')); };
  ui.btn.bClearLog.onclick = () => { ed.logLines = []; ui.logEl.innerHTML = ''; };

  // =========================================================================================
  // methods used by the core
  // =========================================================================================
  ed._applyStateToUI = () => {
    const t = curTool();
    brushSummary.textContent = st.tool === 'erase' ? 'Eraser' : 'Brush';
    W.size.set(t.size); W.hard.set(Math.round(t.hardness * 100)); W.soft.set(Math.round(t.softness * 100));
    W.opac.set(Math.round(t.opacity * 100)); W.space.set(Math.round(t.spacing * 100)); W.stab.set(Math.round(t.stab * 100));
    W.pen.set(st.pen);
    W.showMask.set(st.mask.show); W.maskOp.set(Math.round(st.mask.opacity * 100)); W.amount.set(st.mask.amount);
    aspectSel.value = st.capture.aspect; W.long.set(st.capture.long); shadeSel.value = st.capture.shading; bgIn.value = st.capture.bg;
    W.facing.set(Math.round(st.capture.facing * 100)); W.frame.set(st.capture.frame);
    W.checker.set(st.display.checker3d); ed._refreshBookmarks(); if (ed.viewCubeSync) ed.viewCubeSync();
    W.wire.set(st.display.wire3d); W.shade.set(Math.round(st.display.shade3d * 100)); W.uvwire.set(Math.round(st.display.uvWire * 100));
    W.clearMask.set(st.options.clearMask); W.autoApply.set(st.options.autoApply);
    ed._syncXformUI();
    ui.layout.value = st.display.layout;
    ui.btn.tBrush.classList.toggle('tp-on', st.tool === 'brush');
    ui.btn.tErase.classList.toggle('tp-on', st.tool === 'erase');
    ui.btn.tRect.classList.toggle('tp-on', st.tool === 'rect');
    ui.btn.tLasso.classList.toggle('tp-on', st.tool === 'lasso');
    ui.btn.tNav.classList.toggle('tp-on', st.tool === 'nav');
    ed._applyMouseButtons();
    ed._layoutPanes();
    updateCapLabel();
    ed._updateUndoButtons();
    ed._renderBanner();
    bTgtSel.classList.toggle('tp-on', st.brushTarget !== 'layer' && st.brushTarget !== 'transition' && st.brushTarget !== 'view' && st.brushTarget !== 'heal');
    bTgtHeal.classList.toggle('tp-on', st.brushTarget === 'heal');
    ui.btn.tSelect.classList.toggle('tp-on', st.tool === 'select');
    ui.btn.tHeal.classList.toggle('tp-on', st.tool !== 'select' && st.brushTarget === 'heal' && st.tool !== 'nav');
    bTgtLay.classList.toggle('tp-on', st.brushTarget === 'layer');
    bTgtTr.classList.toggle('tp-on', st.brushTarget === 'transition');
    W.trActive.set(st.combine.useTrans);
    tgtNote.textContent = st.brushTarget === 'heal' ? 'Brush / Eraser paint the dark-green HEAL area (what the AI should heal). Tick "Heal run" in the Heal brush panel to repaint only this area with the heal prompt.' : st.brushTarget === 'view' ? `Brush / Eraser paint the VIEW REGION of reference image ${st.views.active + 3} (colour ${st.refx[st.views.active].color}). Pick another target to go back.` : st.brushTarget === 'layer' ? 'Brush = reveal, Eraser = hide parts of the ACTIVE layer.' : st.brushTarget === 'transition' ? 'Brush = paint blue transition areas (where layers should merge softly), Eraser = remove them. Use "Combine layers" to build the result.' : 'Brush = add to the AI selection, Eraser = remove from it.';
    srcSel.value = st.layers.captureSource; layBg.value = st.layers.bg; W.pad.set(st.layers.padding);
    W.replaceActive.set(st.layers.replaceActive); W.saveServer.set(st.export.saveServer);
    fmtSel.value = st.export.format; spaceSel.value = st.export.space;
    if (ed._renderRef2) ed._renderRef2(); W.refUse.set(R().enabled && R().has); W.refW.set(Math.round(R().weight * 100)); refMode.value = R().mode;
    W.refScale.set(Math.round(R().scale * 100)); W.refRot.set(R().rot);
    ed._renderLayers();
    ed._setSyncLabel(!!ed.synced);
  };

  ed.setTool = (name) => {
    st.tool = name;
    ed._applyStateToUI();
    ed.hudDirty = true;
    ed._dirty('brush');
  };

  ed._applyMouseButtons = () => {
    const nav = st.tool === 'nav' || ed.spaceDown;
    ed.controls.mouseButtons = nav
      ? { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN }
      : { LEFT: -1, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
  };

  ed._layoutPanes = () => {
    const l = st.display.layout;
    ui.pane3d.classList.toggle('tp-hidden', l === 'uv');
    ui.paneUV.classList.toggle('tp-hidden', l === '3d');
    ed.invalidate();
  };

  ed._updateUndoButtons = () => {
    ui.btn.tUndo.disabled = !ed.undoStack.length;
    ui.btn.tRedo.disabled = !ed.redoStack.length;
    if (typeof bLUndo !== 'undefined') {
      bLUndo.disabled = !ed.undoStack.length; bLRedo.disabled = !ed.redoStack.length;
      bLUndo.title = `Undo (${ed.undoStack.length} step${ed.undoStack.length === 1 ? '' : 's'} available) - Ctrl+Z`;
      bLRedo.title = `Redo (${ed.redoStack.length} step${ed.redoStack.length === 1 ? '' : 's'} available) - Ctrl+Y`;
      bRevert.disabled = !ed.layers.canRevert(ed.layers.active);
    }
  };

  ed._renderStats = () => {
    const i = ed.info;
    ui.stats.textContent = i ? `${i.triangles.toLocaleString()} tris  |  ${ed.layers ? ed.layers.w + 'x' + ed.layers.h : ''}` : '';
  };

  ed._renderBanner = () => {
    const b = ui.banner;
    if (!ed.pending) { b.classList.add('tp-hidden'); b.innerHTML = ''; return; }
    b.classList.remove('tp-hidden');
    b.innerHTML = '';
    const stats = ed.pending.stats || {};
    b.append(h('div', null, 'AI result ready' + (stats.summary ? ' - ' + stats.summary : '')));
    const apply = makeButton('Apply', st.layers.replaceActive ? 'Bake the result into the active layer' : 'Add the result as a new layer', 'tp-pri');
    const cmp = makeButton(ed.compare ? 'Showing: new' : 'Showing: old', 'Toggle between the texture without and with the result');
    const dis = makeButton('Discard');
    apply.onclick = () => ed.applyResult();
    cmp.onclick = () => ed.toggleCompare();
    dis.onclick = () => ed.discardResult();
    const row = h('div', 'tp-row2'); row.append(apply, cmp, dis);
    b.append(row);
    if (stats.warnings && stats.warnings.length) b.append(h('div', 'tp-note', stats.warnings.join(' ')));
  };

  // =========================================================================================
  // HUD (brush cursor, capture frame, UV cursor)
  // =========================================================================================
  const uvDims = (w, hh) => {
    const a = w / hh;
    const halfH = Math.max(0.56, 0.56 / a) / ed.uvView.zoom;
    return { halfW: halfH * a, halfH };
  };
  const paneToUV = (x, y, w, hh) => {
    const d = uvDims(w, hh);
    return { u: ed.uvView.cx + (2 * x / w - 1) * d.halfW, v: ed.uvView.cy - (2 * y / hh - 1) * d.halfH };
  };

  ed._drawHUD = () => {
    const hud = ui.hudCanvas;
    const ctx = hud.getContext('2d');
    const dpr = ed.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, hud.width / dpr, hud.height / dpr);
    const p3 = ui.pane3d, pu = ui.paneUV;
    if (!p3.classList.contains('tp-hidden') && p3.offsetWidth > 2) {
      const ox = p3.offsetLeft, oy = p3.offsetTop, w = p3.offsetWidth, hh = p3.offsetHeight;
      ctx.save();
      ctx.beginPath(); ctx.rect(ox, oy, w, hh); ctx.clip();
      if (ed.shape && ed.shape.pts.length) {
        const sh = ed.shape; ctx.save(); ctx.translate(ox, oy);
        ctx.strokeStyle = sh.erase ? '#ff9a3c' : '#ff4fd8'; ctx.fillStyle = sh.erase ? 'rgba(255,154,60,.18)' : 'rgba(255,79,216,.18)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
        ctx.beginPath();
        if (sh.kind === 'rect' && sh.pts[1]) { const [a, b] = sh.pts; ctx.rect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])); }
        else sh.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        if (sh.kind === 'lasso') ctx.closePath();
        ctx.fill(); ctx.stroke(); ctx.restore();
      }
      if (st.capture.frame && ed.hasModel) {
        const fr = ed.frameRect(w, hh);
        ctx.fillStyle = 'rgba(0,0,0,0.38)';
        ctx.beginPath();
        ctx.rect(ox, oy, w, hh);
        ctx.rect(ox + fr.x + fr.w, oy + fr.y, -fr.w, fr.h);
        ctx.fill('evenodd');
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1;
        ctx.strokeRect(ox + fr.x + 0.5, oy + fr.y + 0.5, fr.w - 1, fr.h - 1);
        ctx.setLineDash([]);
        const [cw, ch] = ed.captureSize();
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(`${cw} x ${ch}`, ox + fr.x + 6, oy + fr.y + fr.h - 6);
      }
      if (st.capture.crop.enabled && ed.hasModel) {
        const cr = ed.cropRect(w, hh);
        if (cr) {
          ctx.strokeStyle = 'rgba(255,79,216,0.95)'; ctx.lineWidth = 1.5; ctx.setLineDash([4, 3]);
          ctx.strokeRect(ox + cr.x + 0.5, oy + cr.y + 0.5, cr.w - 1, cr.h - 1); ctx.setLineDash([]);
          ctx.fillStyle = 'rgba(255,79,216,0.95)'; ctx.font = '10px system-ui, sans-serif';
          ctx.fillText(`crop \u00d7${cr.zoom.toFixed(1)}`, ox + cr.x + 4, oy + cr.y + 12);
        }
      }
      if (ed.hover && ed.hover.pane === '3d' && st.tool !== 'nav' && st.tool !== 'select' && st.tool !== 'rect' && st.tool !== 'lasso' && !ed.spaceDown && ed.hasModel) {
        const t = curTool();
        const r = Math.max(1, t.size * 0.5);
        const cx = ox + ed.hover.x, cy = oy + ed.hover.y;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = st.brushTarget === 'heal' ? (st.tool === 'erase' ? 'rgba(150,230,170,0.95)' : 'rgba(30,160,70,0.98)') : st.brushTarget === 'view' ? (st.refx[st.views.active].color || '#fff') : st.brushTarget === 'transition' ? (st.tool === 'erase' ? 'rgba(160,200,255,0.95)' : 'rgba(40,130,255,0.98)') : st.brushTarget === 'layer' ? (st.tool === 'erase' ? 'rgba(255,170,60,0.95)' : 'rgba(90,230,140,0.95)') : (st.tool === 'erase' ? 'rgba(90,200,255,0.95)' : 'rgba(255,90,220,0.95)');
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
        if (t.hardness > 0.02 && t.hardness < 0.98) {
          ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
          ctx.beginPath(); ctx.arc(cx, cy, r * t.hardness, 0, Math.PI * 2); ctx.stroke();
          ctx.setLineDash([]);
        }
      }
      if (ed.hover && ed.hover.pane === '3d' && st.tool === 'select' && ed.hoverPick) {   // select tool: name of the object under the cursor
        ctx.font = '11px system-ui, sans-serif';
        const nm = ed.hoverPick.name, nw = ctx.measureText(nm).width, bx = ox + ed.hover.x + 14, by = oy + ed.hover.y + 16;
        ctx.fillStyle = 'rgba(15,17,22,0.85)'; ctx.fillRect(bx - 4, by - 12, nw + 8, 18); ctx.fillStyle = '#fff'; ctx.fillText(nm, bx, by + 1);
      }
      if (ed.hasModel && st.tool !== 'nav' && st.tool !== 'select') {   // badge: which mask the brush paints on (it is easy to paint on the wrong one)
        const tgt = st.brushTarget === 'heal' ? ['Heal area (dark green)' + (st.heal.on ? ' - heal run ON' : ' - heal run off'), '#2f9e44'] : st.brushTarget === 'view' ? ['View region ' + (st.views.active + 3), st.refx[st.views.active].color || '#fff'] : st.brushTarget === 'transition' ? ['Transition (blue)' + (st.combine.useTrans ? '' : ' - inactive'), '#2a82ff'] : st.brushTarget === 'layer' ? ['Layer mask', '#5ae68c'] : ['AI selection', '#ff5ae0'];
        ctx.font = '11px system-ui, sans-serif';
        const txt = (st.tool === 'erase' ? 'Erasing: ' : 'Painting: ') + tgt[0] + (st.gen.maskSource === 'transition' ? '  |  AI uses the transition mask' : ''), tw = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(15,17,22,0.72)'; ctx.fillRect(ox + 8, oy + 8, tw + 22, 20);
        ctx.fillStyle = tgt[1]; ctx.fillRect(ox + 8, oy + 8, 4, 20);
        ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillText(txt, ox + 18, oy + 22);
      }
      ctx.restore();
    }
    if (!pu.classList.contains('tp-hidden') && pu.offsetWidth > 2) {
      const ox = pu.offsetLeft, oy = pu.offsetTop, w = pu.offsetWidth, hh = pu.offsetHeight;
      ctx.save();
      ctx.beginPath(); ctx.rect(ox, oy, w, hh); ctx.clip();
      let uvp = null;
      if (ed.hoverUV) uvp = ed.hoverUV;
      else if (ed.hover && ed.hover.pane === 'uv') uvp = paneToUV(ed.hover.x, ed.hover.y, w, hh);
      if (ed._tileHud) ed._tileHud(ctx, ox, oy, w, hh, uvDims(w, hh));
      if (uvp) {
        const d = uvDims(w, hh);
        const x = ox + ((uvp.u - ed.uvView.cx) / d.halfW * 0.5 + 0.5) * w;
        const y = oy + (1 - ((uvp.v - ed.uvView.cy) / d.halfH * 0.5 + 0.5)) * hh;
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x - 9, y); ctx.lineTo(x + 9, y); ctx.moveTo(x, y - 9); ctx.lineTo(x, y + 9); ctx.stroke();
        ctx.beginPath(); ctx.arc(x, y, 5, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = 'rgba(255,255,255,0.8)';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(`u ${uvp.u.toFixed(3)}  v ${uvp.v.toFixed(3)}`, ox + 8, oy + hh - 8);
      }
      ctx.restore();
    }
  };

  // =========================================================================================
  // buttons
  // =========================================================================================
  const B = ui.btn;
  const modelInput = h('input'); modelInput.type = 'file'; modelInput.accept = SUPPORTED_EXT.map((e) => '.' + e).join(','); modelInput.style.display = 'none';
  const texInput = h('input'); texInput.type = 'file'; texInput.accept = 'image/*'; texInput.style.display = 'none';
  ui.root.append(modelInput, texInput);

  ed.pickModelFile = async (file) => {
    const ext = extOf(file.name);
    if (!SUPPORTED_EXT.includes(ext)) { ed.log('error', `Unsupported model type ".${ext}". Use ${SUPPORTED_EXT.join(', ')}.`); ed.setStatus('Unsupported model type .' + ext, 'err'); return; }
    try {
      ed.setStatus('Reading ' + file.name + ' ...');
      const buf = await file.arrayBuffer();
      let name = file.name;
      if (ed.hooks.onModelPicked) name = (await ed.hooks.onModelPicked(file)) || name;
      await ed.loadModelBuffer(buf, name);
    } catch (e) { /* already logged */ }
  };

  B.bLoadModel.onclick = () => modelInput.click();
  modelInput.onchange = () => { const f = modelInput.files[0]; modelInput.value = ''; if (f) ed.pickModelFile(f); };
  B.bLoadTex.onclick = () => texInput.click();
  texInput.onchange = async () => {
    const f = texInput.files[0]; texInput.value = '';
    if (!f) return;
    try { await ed.loadTextureFile(f); } catch (e) { ed.log('error', 'Texture load failed', e); ed.setStatus('Texture load failed: ' + e.message, 'err'); }
  };
  B.bNewTex.onclick = () => {
    const ov = h('div');
    ov.style.cssText = 'position:absolute;inset:0;background:rgba(0,0,0,.55);z-index:20;display:flex;align-items:center;justify-content:center';
    const box = h('div');
    box.style.cssText = 'background:#1e2128;border:1px solid #333845;border-radius:8px;padding:14px 16px;min-width:250px';
    box.append(h('div', null, 'New blank texture'));
    box.firstChild.style.cssText = 'font-weight:600;margin-bottom:10px';
    const sel = h('select');
    for (const s of [1024, 2048, 4096]) { const o = h('option', null, `${s} x ${s}`); o.value = s; if (s === 2048) o.selected = true; sel.append(o); }
    const col = h('input'); col.type = 'color'; col.value = '#c8c8c8';
    const r1 = h('div', 'tp-row'); r1.append(h('span', 'tp-lbl', 'Size'), sel, h('span'));
    const r2 = h('div', 'tp-row'); r2.append(h('span', 'tp-lbl', 'Colour'), col, h('span'));
    const ok = makeButton('Create', null, 'tp-pri'), cancel = makeButton('Cancel');
    ok.onclick = () => { ed.newTexture(Number(sel.value), col.value); ov.remove(); };
    cancel.onclick = () => ov.remove();
    const row = h('div', 'tp-row2'); row.append(ok, cancel);
    box.append(r1, r2, row);
    ov.append(box);
    ui.root.append(ov);
  };
  B.bSaveTex.onclick = () => busy(B.bSaveTex, async () => { const r = await bakeUVMap(ed, st.layers.padding); await ed._deliver(r.blob, r.name); ed.log('ok', 'Baked UV map saved: ' + r.name); });
  ui.layout.onchange = () => { st.display.layout = ui.layout.value; ed._layoutPanes(); ed._dirty('settings'); };
  B.bSync.onclick = () => { if (ed.hooks.onSyncRequest) ed.hooks.onSyncRequest(); };
  const wiringBox = h('div', 'tp-wiring'); ui.help.append(wiringBox);
  const renderWiring = () => {
    wiringBox.innerHTML = '<hr style="border:0;border-top:1px solid #333845;margin:6px 0"><b>Wiring checklist</b>';
    const items = ed.hooks.getWiring ? ed.hooks.getWiring() : null;
    if (!items) { wiringBox.append(h('div', 'tp-note', 'Shown inside ComfyUI.')); return; }
    for (const it of items) { const r = h('div', '', (it.ok ? '\u2714 ' : '\u2716 ') + it.label + (it.ok ? '' : ' - ' + it.hint)); r.style.color = it.ok ? '#4cc38a' : '#f0a23a'; wiringBox.append(r); }
  };
  B.bHelp.onclick = () => { ui.help.classList.toggle('tp-show'); if (ui.help.classList.contains('tp-show')) renderWiring(); };
  B.tBrush.onclick = () => ed.setTool('brush');
  B.tErase.onclick = () => ed.setTool('erase');
  B.tRect.onclick = () => ed.setTool('rect');
  B.tLasso.onclick = () => ed.setTool('lasso');
  B.tNav.onclick = () => ed.setTool('nav');
  B.tUndo.onclick = () => ed.undo();
  B.tRedo.onclick = () => ed.redo();
  B.tFrameMask.onclick = () => ed.frameMask();
  B.tFrameModel.onclick = () => ed.fitWhole();
  B.tClearMask.onclick = () => ed.maskClear();

  // fullscreen
  let placeholder = null;
  ed.setFullscreen = (on) => {
    if (on === !!ed.full) return;
    ed.full = on;
    if (on) {
      placeholder = document.createComment('texpaint');
      if (ed.root.parentNode) ed.root.parentNode.insertBefore(placeholder, ed.root);
      document.body.appendChild(ed.root);
      ed.root.classList.add('tp-full');
      B.bFull.textContent = 'Exit fullscreen';
    } else {
      ed.root.classList.remove('tp-full');
      if (placeholder && placeholder.parentNode) { placeholder.parentNode.insertBefore(ed.root, placeholder); placeholder.remove(); }
      B.bFull.textContent = 'Fullscreen';
    }
    ed.invalidate();
    ed.root.focus({ preventScroll: true });
  };
  B.bFull.onclick = () => ed.setFullscreen(!ed.full);

  // =========================================================================================
  // pointer / wheel / keyboard
  // =========================================================================================
  const local = (e, el) => {
    const r = el.getBoundingClientRect();
    const sx = el.offsetWidth / Math.max(1, r.width), sy = el.offsetHeight / Math.max(1, r.height);
    return { x: (e.clientX - r.left) * sx, y: (e.clientY - r.top) * sy, w: el.offsetWidth, h: el.offsetHeight };
  };
  const paintActive = () => st.tool !== 'nav' && st.tool !== 'select' && !ed.spaceDown && ed.hasModel && ed.info && ed.info.hasUV;

  const p3 = ui.pane3d;
  p3.addEventListener('pointerdown', (e) => {
    ui.root.focus({ preventScroll: true });
    if (e.button === 0 && st.tool === 'select' && !ed.spaceDown && ed.hasModel) { const q = local(e, p3); ed.pickObject(q.x, q.y, q.w, q.h, e); e.preventDefault(); return; }
    if (e.button !== 0 || !paintActive()) return;
    if (st.tool === 'rect' || st.tool === 'lasso') {
      const p0 = local(e, p3);
      ed.shape = { kind: st.tool, pts: [[p0.x, p0.y]], erase: e.altKey, pid: e.pointerId };
      try { p3.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      ed.hudDirty = true; e.preventDefault();
      return;
    }
    if (!ed.beginStroke(st.tool === 'erase')) return;
    try { p3.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    const p = local(e, p3);
    ed.strokeMove(p.x, p.y, e.pointerType === 'pen' ? e.pressure : 0);
    e.preventDefault();
  });
  p3.addEventListener('pointermove', (e) => {
    const p = local(e, p3);
    ed.hover = { x: p.x, y: p.y, pane: '3d' };
    ed.hudDirty = true;
    if (ed.shape) {
      const sh = ed.shape;
      if (sh.kind === 'rect') sh.pts[1] = [p.x, p.y]; else { const l = sh.pts[sh.pts.length - 1]; if (Math.hypot(p.x - l[0], p.y - l[1]) > 2) sh.pts.push([p.x, p.y]); }
      return;
    }
    if (ed.stroke) {
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        const q = local(ev, p3);
        ed.strokeMove(q.x, q.y, ev.pointerType === 'pen' ? ev.pressure : 0);
      }
      return;
    }
    if (e.buttons === 0 && ed.hasModel && ed.info.triangles < 400000) {
      const now = performance.now();
      if (now - ed._lastRay > 70) {
        ed._lastRay = now;
        ed._syncCamera();
        ed.raycaster.setFromCamera(new THREE.Vector2((p.x / p.w) * 2 - 1, -((p.y / p.h) * 2 - 1)), ed.camera);
        const hit = ed.raycaster.intersectObject(ed.mesh, false)[0];
        ed.hoverUV = hit && hit.uv ? { u: hit.uv.x, v: hit.uv.y } : null;
        if (st.tool === 'select' && ed.pickAt) { const pk = ed.pickAt(p.x, p.y, p.w, p.h); ed.hoverPick = pk; }
      }
    }
  });
  const endShape = (e, cancel) => {
    const sh = ed.shape; ed.shape = null; ed.hudDirty = true;
    try { p3.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    if (!sh || cancel) return;
    const w = p3.offsetWidth, hh = p3.offsetHeight;
    const c = document.createElement('canvas'); c.width = w; c.height = hh;
    const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, w, hh); g.fillStyle = '#fff';
    if (sh.kind === 'rect') {
      if (sh.pts.length < 2) return;
      const [a, b] = sh.pts; g.fillRect(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]));
    } else {
      if (sh.pts.length < 3) return;
      g.beginPath(); sh.pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
    }
    ed.fillShape(c, sh.erase);
  };
  const endStroke = (e) => { if (ed.shape) { endShape(e, e.type === 'pointercancel'); return; } if (ed.stroke) { try { p3.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ } ed.endStroke(); } };
  p3.addEventListener('pointerup', endStroke);
  p3.addEventListener('pointercancel', endStroke);
  p3.addEventListener('pointerleave', () => { if (!ed.stroke) { ed.hover = null; ed.hoverUV = null; ed.hudDirty = true; } });
  p3.addEventListener('wheel', (e) => { e.stopPropagation(); }, { passive: true });
  p3.addEventListener('contextmenu', (e) => e.preventDefault());

  // ---- UV pane: pan / zoom
  const pu = ui.paneUV;
  let uvDrag = null;
  pu.addEventListener('pointerdown', (e) => {
    ui.root.focus({ preventScroll: true });
    const pan = e.button === 1 || e.button === 2 || (e.button === 0 && (st.tool === 'nav' || ed.spaceDown || true));
    if (!pan) return;
    const p = local(e, pu);
    uvDrag = { x: p.x, y: p.y, cx: ed.uvView.cx, cy: ed.uvView.cy };
    try { pu.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    e.preventDefault();
  });
  pu.addEventListener('pointermove', (e) => {
    const p = local(e, pu);
    ed.hover = { x: p.x, y: p.y, pane: 'uv' };
    ed.hoverUV = null;
    if (uvDrag) {
      const d = uvDims(p.w, p.h);
      ed.uvView.cx = uvDrag.cx - ((p.x - uvDrag.x) / p.w) * 2 * d.halfW;
      ed.uvView.cy = uvDrag.cy + ((p.y - uvDrag.y) / p.h) * 2 * d.halfH;
      ed.invalidate();
    }
    ed.hudDirty = true;
  });
  const uvEnd = (e) => { if (uvDrag) { uvDrag = null; try { pu.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ } } };
  pu.addEventListener('pointerup', uvEnd);
  pu.addEventListener('pointercancel', uvEnd);
  pu.addEventListener('pointerleave', () => { if (!uvDrag) { ed.hover = null; ed.hudDirty = true; } });
  pu.addEventListener('contextmenu', (e) => e.preventDefault());
  pu.addEventListener('wheel', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const p = local(e, pu);
    const before = paneToUV(p.x, p.y, p.w, p.h);
    ed.uvView.zoom = Math.min(64, Math.max(0.25, ed.uvView.zoom * Math.pow(1.0018, -e.deltaY)));
    const after = paneToUV(p.x, p.y, p.w, p.h);
    ed.uvView.cx += before.u - after.u;
    ed.uvView.cy += before.v - after.v;
    ed.invalidate();
  }, { passive: false });

  // ---- keyboard
  const onKey = (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || (tag === 'INPUT' && e.target.type !== 'range' && e.target.type !== 'checkbox') || tag === 'SELECT') return;
    const k = e.key;
    const ctrl = e.ctrlKey || e.metaKey;
    let handled = true;
    if (ctrl && (k === 'z' || k === 'Z')) { if (e.shiftKey) ed.redo(); else ed.undo(); }
    else if (ctrl && (k === 'y' || k === 'Y')) ed.redo();
    else if (ctrl) handled = false;
    else if (k === 'b' || k === 'B') ed.setTool('brush');
    else if (k === 'e' || k === 'E') ed.setTool('erase');
    else if (k === 'n' || k === 'N') ed.setTool('nav');
    else if (k === 'v' || k === 'V') ed.setTool('select');
    else if (k === 'j' || k === 'J') ed.healTool();
    else if (k === 'r' || k === 'R') ed.setTool('rect');
    else if (k === 'l' || k === 'L') ed.setTool('lasso');
    else if (k === 'x' || k === 'X') ed.setTool(st.tool === 'erase' ? 'brush' : 'erase');
    else if (k === '[') { const t = curTool(); t.size = Math.max(2, Math.round(t.size * 0.85)); ed._applyStateToUI(); ed.hudDirty = true; }
    else if (k === ']') { const t = curTool(); t.size = Math.min(400, Math.round(t.size / 0.85 + 1)); ed._applyStateToUI(); ed.hudDirty = true; }
    else if (k === 'f' || k === 'F') ed.frameMask();
    else if (k === 'Home') { if (e.shiftKey && ed.frameAll) ed.frameAll(); else ed.fitWhole(); }
    else if (k === 'm' || k === 'M') { st.mask.show = !st.mask.show; ed._applyStateToUI(); ed.invalidate(); }
    else if (k === '1') { st.display.layout = 'split'; ed._applyStateToUI(); }
    else if (k === '2') { st.display.layout = '3d'; ed._applyStateToUI(); }
    else if (k === '3') { st.display.layout = 'uv'; ed._applyStateToUI(); }
    else if (k === 'Escape') { if (ed.full) ed.setFullscreen(false); else if (ui.help.classList.contains('tp-show')) ui.help.classList.remove('tp-show'); else handled = false; }
    else if (k === ' ') { if (!ed.spaceDown) { ed.spaceDown = true; ed._applyMouseButtons(); ed.hudDirty = true; } }
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  };
  const onKeyUp = (e) => {
    if (e.key === ' ' && ed.spaceDown) { ed.spaceDown = false; ed._applyMouseButtons(); ed.hudDirty = true; e.stopPropagation(); }
  };
  ui.root.addEventListener('keydown', onKey);
  ui.root.addEventListener('keyup', onKeyUp);
  ui.root.addEventListener('blur', () => { if (ed.spaceDown) { ed.spaceDown = false; ed._applyMouseButtons(); } });

  // ---- drag and drop
  let dragDepth = 0;
  const stage = ui.stage;
  stage.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; ui.drop.classList.add('tp-show'); });
  stage.addEventListener('dragover', (e) => { e.preventDefault(); });
  stage.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) ui.drop.classList.remove('tp-show'); });
  stage.addEventListener('drop', async (e) => {
    e.preventDefault(); e.stopPropagation();
    dragDepth = 0; ui.drop.classList.remove('tp-show');
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (!f) return;
    const ext = extOf(f.name);
    if (SUPPORTED_EXT.includes(ext)) await ed.pickModelFile(f);
    else if (IMG_EXT.includes(ext) || (f.type || '').startsWith('image/')) {
      try { await ed.loadTextureFile(f); } catch (err) { ed.log('error', 'Texture load failed', err); }
    } else ed.log('warn', `Dropped file type ".${ext}" is not supported.`);
  });

  installPlanner(ed);
  installRefPlace(ed);
  installObjects(ed);
  installObjTex(ed);
  installPresets(ed);
  installCombine(ed);
  installSaveAs(ed);
  installResMatch(ed);
  installUnwrap(ed);
  installViews(ed);
  installLayerAdj(ed);
  installQuick(ed);
  installViewMenu(ed);
  installTiles(ed);
  installPick(ed);
  installHeal(ed);
  installPromptPreview(ed);
  installPbr(ed);
  installPromptPanels(ed);

  // ---- resize
  ed._ro = new ResizeObserver(() => ed.invalidate());
  ed._ro.observe(ui.stage);
  ed._unbind = () => { ui.root.removeEventListener('keydown', onKey); ui.root.removeEventListener('keyup', onKeyUp); };
}
