// Select tool (V): click an object in the 3D view to make it the working object of the hierarchy.
import * as THREE from 'three';

export function installPick(ed) {
  const st = ed.state;
  const parentOf = (id) => { const t = ed.objTree; if (!t) return null; for (const nd of t.rows) if (nd.kids.some((k) => k.id === id)) return nd; return null; };

  /** object under the cursor (pane pixels): { id, name, distance } of a leaf object, or null */
  ed.pickAt = (x, y, w, h) => {
    const t = ed.objTree;
    if (!ed.hasModel || !t || !ed.mesh) return null;
    ed._syncCamera();
    ed.raycaster.setFromCamera(new THREE.Vector2((x / w) * 2 - 1, -((y / h) * 2 - 1)), ed.camera);
    let best = null;
    const hit = ed.raycaster.intersectObject(ed.mesh, false)[0];
    if (hit && hit.faceIndex != null) {
      const part = ((ed.info && ed.info.parts) || []).find((p) => hit.faceIndex >= p.t0 && hit.faceIndex < p.t1);
      const id = part ? t.meshId.get(part.mesh) : null;
      if (id != null) best = { id, distance: hit.distance };
    }
    const g = ed._ctxGroup && ed._ctxGroup();
    if (g) {
      const hits = ed.raycaster.intersectObjects(g.children.filter((c) => c.visible), false);
      if (hits[0] && hits[0].object.userData.leaf != null && (!best || hits[0].distance < best.distance)) best = { id: hits[0].object.userData.leaf, distance: hits[0].distance };
    }
    if (!best) return null;
    const nd = t.byId.get(best.id);
    return { id: best.id, name: nd ? nd.name : String(best.id), distance: best.distance };
  };

  /** click with the select tool: Ctrl / Shift as in the hierarchy (add / range), Alt = the parent group of the object */
  ed.pickObject = async (x, y, w, h, e) => {
    const r = ed.pickAt(x, y, w, h);
    if (!r) { ed.setStatus('Select tool: no object under the cursor.', 'warn'); return false; }
    let id = r.id, name = r.name;
    if (e && e.altKey) { const p = parentOf(id); if (p) { id = p.id; name = p.name; } }
    const plain = !(e && (e.ctrlKey || e.metaKey || e.shiftKey));
    if (plain && id === (st.model.object || '')) { ed.setStatus(`"${name}" is already the working object.`, 'ok'); return true; }
    const ok = await ed.objClick(id, e);
    if (ok) ed.setStatus(`Working object: ${name}`, 'ok');
    return ok;
  };
}
