// Model loading, merging and (de)serialisation helpers.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';

export const SUPPORTED_EXT = ['glb', 'gltf', 'obj', 'fbx'];

export function extOf(name) {
  const m = /\.([A-Za-z0-9]+)$/.exec(name || '');
  return m ? m[1].toLowerCase() : '';
}

/** Parse raw file content. `data` is an ArrayBuffer (glb, fbx, obj accepted too). */
export async function parseModel(data, ext) {
  ext = (ext || '').toLowerCase().replace('.', '');
  if (ext === 'glb' || ext === 'gltf') {
    const loader = new GLTFLoader();
    const payload = ext === 'gltf' ? new TextDecoder().decode(data) : data;
    const gltf = await loader.parseAsync(payload, '');
    return { root: gltf.scene, kind: 'gltf' };
  }
  if (ext === 'obj') {
    const root = new OBJLoader().parse(new TextDecoder().decode(data));
    return { root, kind: 'obj' };
  }
  if (ext === 'fbx') {
    const root = new FBXLoader().parse(data, '');
    return { root, kind: 'fbx' };
  }
  throw new Error(`Unsupported model format ".${ext}". Supported: ${SUPPORTED_EXT.join(', ')}`);
}

function copyAttr(src, itemSize, count, fn) {
  const out = new Float32Array(count * itemSize);
  for (let i = 0; i < count; i++) fn(out, i);
  return out;
}

/**
 * Flatten every mesh of the loaded scene into ONE indexed geometry (position / normal / uv)
 * in a normalised space (bounding sphere radius 1, centred at the origin).
 * UVs are converted to the "v up" convention used everywhere in this tool
 * (glTF stores v top-down, so v is flipped for glTF).
 */
export function buildMerged(root, kind, include = null) {
  root.updateMatrixWorld(true);
  const parts = [];
  const maps = new Set();
  const warnings = [];
  let missingUV = 0;
  let meshCount = 0;
  let materialCount = 0;

  root.traverse((o) => {
    if (!o.isMesh || !o.geometry || !o.geometry.attributes.position) return;
    if (include && !include(o)) return;
    meshCount++;
    const g0 = o.geometry;
    const pa = g0.attributes.position;
    const count = pa.count;
    const m = o.matrixWorld;
    const nm = new THREE.Matrix3().getNormalMatrix(m);
    const v = new THREE.Vector3();

    const pos = copyAttr(pa, 3, count, (out, i) => {
      v.set(pa.getX(i), pa.getY(i), pa.getZ(i)).applyMatrix4(m);
      out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
    });

    let nor;
    const na = g0.attributes.normal;
    if (na) {
      nor = copyAttr(na, 3, count, (out, i) => {
        v.set(na.getX(i), na.getY(i), na.getZ(i)).applyMatrix3(nm).normalize();
        out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
      });
    }

    let uv;
    const ua = g0.attributes.uv;
    if (ua) {
      const flip = kind === 'gltf';
      uv = copyAttr(ua, 2, count, (out, i) => {
        const u = ua.getX(i);
        const vv = ua.getY(i);
        out[i * 2] = u;
        out[i * 2 + 1] = flip ? 1 - vv : vv;
      });
    } else {
      uv = new Float32Array(count * 2);
      missingUV++;
    }

    let index;
    if (g0.index) {
      index = new Uint32Array(g0.index.count);
      for (let i = 0; i < index.length; i++) index[i] = g0.index.getX(i);
    } else {
      index = new Uint32Array(count);
      for (let i = 0; i < count; i++) index[i] = i;
    }

    if (!nor) {
      // flat fallback: accumulate face normals
      nor = new Float32Array(count * 3);
      const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
      const ab = new THREE.Vector3(), ac = new THREE.Vector3();
      for (let t = 0; t + 2 < index.length; t += 3) {
        const i0 = index[t], i1 = index[t + 1], i2 = index[t + 2];
        a.fromArray(pos, i0 * 3); b.fromArray(pos, i1 * 3); c.fromArray(pos, i2 * 3);
        ab.subVectors(b, a); ac.subVectors(c, a); ab.cross(ac);
        for (const i of [i0, i1, i2]) { nor[i * 3] += ab.x; nor[i * 3 + 1] += ab.y; nor[i * 3 + 2] += ab.z; }
      }
      for (let i = 0; i < count; i++) {
        v.fromArray(nor, i * 3).normalize();
        nor[i * 3] = v.x; nor[i * 3 + 1] = v.y; nor[i * 3 + 2] = v.z;
      }
    }

    const mats = Array.isArray(o.material) ? o.material : [o.material];
    materialCount += mats.length;
    for (const mt of mats) if (mt && mt.map) maps.add(mt.map);

    parts.push({ pos, nor, uv, index, mesh: o });
  });

  if (!parts.length) throw new Error('The file contains no mesh geometry.');

  let V = 0, I = 0;
  for (const p of parts) { V += p.pos.length / 3; I += p.index.length; }
  const position = new Float32Array(V * 3);
  const normal = new Float32Array(V * 3);
  const uvArr = new Float32Array(V * 2);
  const indices = new Uint32Array(I);
  let vo = 0, io = 0;
  for (const p of parts) {
    p.t0 = io / 3; p.t1 = (io + p.index.length) / 3;   // triangle range of this mesh in the merged geometry (object picking)
    const n = p.pos.length / 3;
    position.set(p.pos, vo * 3);
    normal.set(p.nor, vo * 3);
    uvArr.set(p.uv, vo * 2);
    for (let i = 0; i < p.index.length; i++) indices[io + i] = p.index[i] + vo;
    vo += n; io += p.index.length;
  }

  // normalise into a unit sphere around the origin
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (let i = 0; i < V; i++) box.expandByPoint(tmp.set(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]));
  const center = box.getCenter(new THREE.Vector3());
  let radius = 0;
  for (let i = 0; i < V; i++) {
    tmp.set(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]).sub(center);
    radius = Math.max(radius, tmp.length());
  }
  if (!(radius > 1e-9)) radius = 1;
  for (let i = 0; i < V; i++) {
    position[i * 3] = (position[i * 3] - center.x) / radius;
    position[i * 3 + 1] = (position[i * 3 + 1] - center.y) / radius;
    position[i * 3 + 2] = (position[i * 3 + 2] - center.z) / radius;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

  // ---- validation ------------------------------------------------------------------------
  const hasUV = missingUV === 0;
  if (!hasUV) warnings.push(missingUV === meshCount ? 'Model has NO UV coordinates - painting is disabled.' : `${missingUV} of ${meshCount} meshes have no UVs.`);
  let outside = 0;
  for (let i = 0; i < V; i++) {
    const u = uvArr[i * 2], w = uvArr[i * 2 + 1];
    if (u < -0.001 || u > 1.001 || w < -0.001 || w > 1.001) outside++;
  }
  if (hasUV && outside / V > 0.001) warnings.push(`UVs leave the 0-1 square (${(100 * outside / V).toFixed(1)}% of vertices). Tiled / UDIM layouts are not supported - repack the UVs into 0-1.`);
  if (maps.size > 1) warnings.push(`Model uses ${maps.size} different textures. All meshes are treated as ONE UV atlas; only the first texture is shown.`);

  let embedded = null;
  const first = maps.values().next().value;
  if (first) embedded = first.image || (first.source && first.source.data) || null;

  return {
    geometry,
    info: {
      triangles: I / 3,
      vertices: V,
      meshCount,
      materialCount,
      hasUV,
      warnings,
      norm: { center: center.toArray(), scale: 1 / radius },
      embedded,
      parts: parts.map((p) => ({ mesh: p.mesh, t0: p.t0, t1: p.t1 })),
    },
  };
}

/** Cheap content hash (FNV-1a over a sampled subset + counts). */
export function hashGeometry(g) {
  let h = 0x811c9dc5;
  const mix = (arr) => {
    const u = new Uint32Array(arr.buffer, arr.byteOffset, arr.length);
    const step = Math.max(1, Math.floor(u.length / 60000));
    for (let i = 0; i < u.length; i += step) { h ^= u[i]; h = Math.imul(h, 16777619) >>> 0; }
    h ^= u.length; h = Math.imul(h, 16777619) >>> 0;
  };
  mix(g.attributes.position.array);
  mix(g.attributes.uv.array);
  mix(g.index.array);
  return h.toString(16).padStart(8, '0');
}

/** Binary container read by tp_core.read_mesh_bin():
 *  [u32 headerLen][header JSON (padded to 4 bytes)][f32 pos][f32 normal][f32 uv][u32 index] */
export function serializeMesh(g, hash) {
  const V = g.attributes.position.count;
  const I = g.index.count;
  const header = JSON.stringify({ format: 1, vertices: V, indices: I, hash });
  const hb = new TextEncoder().encode(header);
  const padded = Math.ceil(hb.length / 4) * 4;
  const total = 4 + padded + V * 12 + V * 12 + V * 8 + I * 4;
  const buf = new ArrayBuffer(total);
  const dv = new DataView(buf);
  dv.setUint32(0, padded, true);
  const u8 = new Uint8Array(buf);
  u8.set(hb, 4);
  for (let i = hb.length; i < padded; i++) u8[4 + i] = 0x20;
  let off = 4 + padded;
  new Float32Array(buf, off, V * 3).set(g.attributes.position.array); off += V * 12;
  new Float32Array(buf, off, V * 3).set(g.attributes.normal.array); off += V * 12;
  new Float32Array(buf, off, V * 2).set(g.attributes.uv.array); off += V * 8;
  new Uint32Array(buf, off, I).set(g.index.array);
  return buf;
}

/** Unique triangle edges drawn in UV space (island outlines + inner edges). */
export function buildUVLines(g) {
  const uv = g.attributes.uv.array;
  const idx = g.index.array;
  const V = g.attributes.uv.count;
  const seen = new Set();
  const out = [];
  const add = (a, b) => {
    const k = a < b ? a * V + b : b * V + a;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(uv[a * 2], uv[a * 2 + 1], 0.0005, uv[b * 2], uv[b * 2 + 1], 0.0005);
  };
  for (let t = 0; t + 2 < idx.length; t += 3) {
    add(idx[t], idx[t + 1]); add(idx[t + 1], idx[t + 2]); add(idx[t + 2], idx[t]);
  }
  return new Float32Array(out);
}

/** UV health check: returns a list of human readable warnings (empty = fine). */
export function uvHealth(geometry) {
  const out = [];
  const uvA = geometry.attributes.uv, idxA = geometry.index;
  if (!uvA || !idxA) return out;
  const uv = uvA.array, idx = idxA.array, T = Math.floor(idx.length / 3);
  if (!T) return out;
  let outRange = 0, degen = 0, pos = 0, neg = 0;
  for (let i = 0; i < uv.length; i += 2) if (uv[i] < -1e-4 || uv[i] > 1 + 1e-4 || uv[i + 1] < -1e-4 || uv[i + 1] > 1 + 1e-4) outRange++;
  const G = 128, grid = new Uint8Array(G * G);
  let overlap = 0, covered = 0;
  const sample = T > 400000 ? 0 : 1; // skip the overlap scan on huge meshes (it is only a hint)
  for (let t = 0; t < T; t++) {
    const a = idx[t * 3], b = idx[t * 3 + 1], c = idx[t * 3 + 2];
    const ax = uv[a * 2], ay = uv[a * 2 + 1], bx = uv[b * 2], by = uv[b * 2 + 1], cx = uv[c * 2], cy = uv[c * 2 + 1];
    const area = ((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
    if (Math.abs(area) < 1e-10) { degen++; continue; }
    if (area > 0) pos++; else neg++;
    if (!sample) continue;
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx, cx) * G)), x1 = Math.min(G - 1, Math.floor(Math.max(ax, bx, cx) * G));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by, cy) * G)), y1 = Math.min(G - 1, Math.floor(Math.max(ay, by, cy) * G));
    const inv = 1 / (2 * area);
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const px = (x + 0.5) / G, py = (y + 0.5) / G;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv, w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv, w2 = 1 - w0 - w1;
      if (w0 >= 0 && w1 >= 0 && w2 >= 0) { const k = y * G + x; if (grid[k] === 0) { grid[k] = 1; covered++; } else if (grid[k] === 1) { grid[k] = 2; overlap++; } }
    }
  }
  if (outRange / (uv.length / 2) > 0.001) out.push(`UV check: ${(100 * outRange / (uv.length / 2)).toFixed(1)}% of the UV points lie outside 0-1 (tiled / UDIM layout). Only the 0-1 tile is painted and baked.`);
  if (degen / T > 0.01) out.push(`UV check: ${(100 * degen / T).toFixed(1)}% of the triangles have a zero-area UV (collapsed UVs) - they cannot receive paint.`);
  if (Math.min(pos, neg) / Math.max(1, pos + neg) > 0.05) out.push(`UV check: ${(100 * Math.min(pos, neg) / (pos + neg)).toFixed(0)}% of the UV triangles are mirrored (flipped islands). Mirrored UVs paint correctly, but text and directional detail will read backwards there.`);
  if (sample && covered > 0 && overlap / covered > 0.02) out.push(`UV check: about ${(100 * overlap / covered).toFixed(0)}% of the UV space is used by overlapping islands - paint on one will also appear on the other.`);
  return out;
}
