// Export of the textured model (GLB, OBJ+MTL+PNG zip) and of the baked UV map.
// The editor stores the mesh normalised (unit sphere, centred) with a v-up UV convention; both are undone here.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** Minimal "stored" (no compression) ZIP writer. files: [{name, data: Uint8Array}] */
export function makeZip(files) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const dosTime = 0, dosDate = (46 << 9) | (1 << 5) | 1; // 2026-01-01 00:00
  for (const f of files) {
    const name = enc.encode(f.name);
    const crc = crc32(f.data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
    lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
    lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    chunks.push(new Uint8Array(lh.buffer), name, f.data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true); ch.setUint16(10, 0, true);
    ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
    ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + f.data.length;
  }
  const cSize = central.reduce((a, c) => a + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cSize, true); end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

export function modelStem(ed) {
  const n = (ed.state.model && ed.state.model.name) || 'model';
  return n.replace(/\.[^.]+$/, '').replace(/_[0-9a-f]{8}$/, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'model';
}

/** Vertex data in export coordinates. space 'original' = orientation / size of the loaded file,
 *  'shown' = as oriented in the editor (still scaled back to the original size, centred at the origin). */
export function exportGeometryData(ed, space) {
  if (!ed.hasModel || !ed.base) throw new Error('No model loaded.');
  const norm = (ed.info && ed.info.norm) || { center: [0, 0, 0], scale: 1 };
  const R = norm.scale ? 1 / norm.scale : 1; // the editor stores p' = (p - center) * scale
  const [cx, cy, cz] = norm.center;
  const orig = space !== 'shown';
  const srcP = orig ? ed.base.pos : ed.geometry.attributes.position.array;
  const srcN = orig ? ed.base.nrm : ed.geometry.attributes.normal.array;
  const idx = orig ? ed.base.idx : ed.geometry.index.array;
  const V = srcP.length / 3;
  const pos = new Float32Array(V * 3);
  for (let i = 0; i < V; i++) {
    pos[i * 3] = srcP[i * 3] * R + (orig ? cx : 0);
    pos[i * 3 + 1] = srcP[i * 3 + 1] * R + (orig ? cy : 0);
    pos[i * 3 + 2] = srcP[i * 3 + 2] * R + (orig ? cz : 0);
  }
  return { pos, nrm: new Float32Array(srcN), uv: new Float32Array(ed.geometry.attributes.uv.array), idx: new Uint32Array(idx), V };
}

async function canvasPNG(canvas) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('PNG encoding failed'))), 'image/png'));
}

async function exportGLB(ed, { space, padding }) {
  const d = exportGeometryData(ed, space);
  const uv = new Float32Array(d.uv.length);
  for (let i = 0; i < d.V; i++) { uv[i * 2] = d.uv[i * 2]; uv[i * 2 + 1] = 1 - d.uv[i * 2 + 1]; } // glTF: v down
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(d.nrm, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  g.setIndex(new THREE.BufferAttribute(d.idx, 1));
  const canvas = ed.layers.bakeCanvas(padding);
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  const hasPbr = ed.pbrHasAny && ed.pbrHasAny();
  const mat = (hasPbr && ed.pbrCanvas.spec ? new THREE.MeshPhysicalMaterial({ map: tex, roughness: 1, metalness: 0, name: 'TexturePainterMaterial' }) : new THREE.MeshStandardMaterial({ map: tex, roughness: 1, metalness: 0, name: 'TexturePainterMaterial' }));
  const pbrTex = hasPbr ? ed.pbrApplyToMaterial(mat, { flipY: false, forExport: true }) : [];   // maps: normal / roughness / metallic / occlusion / specular (glTF has no height map)
  const mesh = new THREE.Mesh(g, mat);
  mesh.name = modelStem(ed);
  const buf = await new Promise((res, rej) => new GLTFExporter().parse(mesh, res, rej, { binary: true, onlyVisible: false }));
  g.dispose(); mat.dispose(); tex.dispose(); for (const t of pbrTex) t.dispose();
  return new Blob([buf], { type: 'model/gltf-binary' });
}

async function exportOBJZip(ed, { space, padding }) {
  const d = exportGeometryData(ed, space);
  const stem = modelStem(ed);
  const lines = [`# exported by Texture Painter AI`, `mtllib ${stem}.mtl`, `o ${stem}`, 'usemtl TexturePainterMaterial'];
  const f3 = (n) => (Math.round(n * 1e6) / 1e6).toString();
  for (let i = 0; i < d.V; i++) lines.push(`v ${f3(d.pos[i * 3])} ${f3(d.pos[i * 3 + 1])} ${f3(d.pos[i * 3 + 2])}`);
  for (let i = 0; i < d.V; i++) lines.push(`vt ${f3(d.uv[i * 2])} ${f3(d.uv[i * 2 + 1])}`); // OBJ: v up, like the editor
  for (let i = 0; i < d.V; i++) lines.push(`vn ${f3(d.nrm[i * 3])} ${f3(d.nrm[i * 3 + 1])} ${f3(d.nrm[i * 3 + 2])}`);
  for (let t = 0; t + 2 < d.idx.length; t += 3) {
    const a = d.idx[t] + 1, b = d.idx[t + 1] + 1, c = d.idx[t + 2] + 1;
    lines.push(`f ${a}/${a}/${a} ${b}/${b}/${b} ${c}/${c}/${c}`);
  }
  const enc = new TextEncoder();
  const png = new Uint8Array(await (await canvasPNG(ed.layers.bakeCanvas(padding))).arrayBuffer());
  const pbrFiles = ed.pbrExportFiles ? await ed.pbrExportFiles(stem) : [];
  const mapLine = { normal: 'norm', height: 'bump', roughness: 'map_Pr', metallic: 'map_Pm', specular: 'map_Ks', ao: 'map_ao' };
  let mtl = `newmtl TexturePainterMaterial\nKa 1 1 1\nKd 1 1 1\nmap_Kd ${stem}.png\n`;
  for (const f of pbrFiles) { const k = f.name.slice(stem.length + 1).replace(/\.png$/, ''); if (mapLine[k]) mtl += `${mapLine[k]} ${f.name}\n`; }
  return makeZip([
    ...pbrFiles,
    { name: `${stem}.obj`, data: enc.encode(lines.join('\n') + '\n') },
    { name: `${stem}.mtl`, data: enc.encode(mtl) },
    { name: `${stem}.png`, data: png },
  ]);
}

/** Returns {blob, name}. format: 'glb' | 'obj' */
export async function exportModel(ed, { format = 'glb', space = 'original', padding = 8 } = {}) {
  const stem = modelStem(ed);
  if (format === 'obj') return { blob: await exportOBJZip(ed, { space, padding }), name: `${stem}_obj.zip` };
  return { blob: await exportGLB(ed, { space, padding }), name: `${stem}.glb` };
}

export async function bakeUVMap(ed, padding = 8) {
  return { blob: await canvasPNG(ed.layers.bakeCanvas(padding)), name: `${modelStem(ed)}_uv_texture.png` };
}
