// View cube (top-right of the 3D pane) + projection toggle, home, turntable and camera bookmarks.
// Pure DOM/CSS 3D: the cube is rotated with the camera's rotation, faces/edges/corners are clickable.
import * as THREE from 'three';
import { h } from './ui.js';

export const CUBE_CSS = `
.tp-vc{position:absolute;right:10px;top:8px;width:128px;z-index:4;user-select:none;display:flex;flex-direction:column;align-items:center;gap:4px}
.tp-vc-scene{width:128px;height:96px;perspective:380px;display:flex;align-items:center;justify-content:center}
.tp-vc-cube{position:relative;width:46px;height:46px;transform-style:preserve-3d}
.tp-vc-f{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font:600 8px system-ui,sans-serif;letter-spacing:.04em;color:#cfd6e6;
  background:rgba(40,46,60,.92);border:1px solid #6f7a94;box-sizing:border-box;cursor:pointer;backface-visibility:hidden}
.tp-vc-f:hover{background:rgba(77,163,255,.55);color:#fff}
.tp-vc-bar{display:flex;gap:3px;justify-content:center;flex-wrap:wrap}
.tp-vc-bar button{background:rgba(24,27,34,.9);color:#cfd6e6;border:1px solid #4a5163;border-radius:4px;font-size:10px;padding:2px 6px;cursor:pointer;line-height:1.2}
.tp-vc-bar button:hover{border-color:#4da3ff;color:#fff}
.tp-vc-bar button.tp-on{background:#2f6fb5;border-color:#4da3ff;color:#fff}
`;

// face: world normal, local u/v axes in world space (u = right, v = down on the face), css transform
const FACES = [
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, -1, 0], t: 'translateZ(23px)', label: 'FRONT' },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, -1, 0], t: 'rotateY(180deg) translateZ(23px)', label: 'BACK' },
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, -1, 0], t: 'rotateY(90deg) translateZ(23px)', label: 'RIGHT' },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, -1, 0], t: 'rotateY(-90deg) translateZ(23px)', label: 'LEFT' },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1], t: 'rotateX(90deg) translateZ(23px)', label: 'TOP' },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1], t: 'rotateX(-90deg) translateZ(23px)', label: 'BOTTOM' },
];

export function installViewCube(ed) {
  const pane = ed.ui.pane3d;
  const root = h('div', 'tp-vc');
  const scene = h('div', 'tp-vc-scene');
  const cube = h('div', 'tp-vc-cube');
  scene.append(cube);
  const bar = h('div', 'tp-vc-bar');
  const bProj = h('button', '', 'Persp'); bProj.title = 'Switch between perspective and orthographic view';
  const bHome = h('button', '', '⌂'); bHome.title = 'Fit the whole object to the viewport (Home)';
  const bTurn = h('button', '', '⟳'); bTurn.title = 'Turntable (auto-rotate)';
  const bSel = h('button', '', '◎'); bSel.title = 'Fit the selected (painted) area to the viewport (F)';
  const bMark = h('button', '', '☆'); bMark.title = 'Save the current camera as a bookmark';
  bar.append(bProj, bHome, bSel, bTurn, bMark);
  root.append(scene, bar);
  pane.append(root);
  const style = document.createElement('style'); style.textContent = CUBE_CSS; ed.root.append(style);

  for (const f of FACES) {
    const el = h('div', 'tp-vc-f', f.label);
    el.style.transform = f.t;
    el.addEventListener('click', (e) => {
      const r = el.getBoundingClientRect();
      // offsetX/Y are in the face's own (untransformed) coordinates
      const u = Math.min(1, Math.max(0, e.offsetX / el.offsetWidth)), v = Math.min(1, Math.max(0, e.offsetY / el.offsetHeight));
      void r;
      const d = new THREE.Vector3(...f.n);
      const T = 0.26;
      if (u < T) d.addScaledVector(new THREE.Vector3(...f.u), -1); else if (u > 1 - T) d.addScaledVector(new THREE.Vector3(...f.u), 1);
      if (v < T) d.addScaledVector(new THREE.Vector3(...f.v), -1); else if (v > 1 - T) d.addScaledVector(new THREE.Vector3(...f.v), 1);
      ed.viewFrom(d);
    });
    cube.append(el);
  }

  // keep pointer events away from the orbit controls / brush that live on the pane
  for (const ev of ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'dblclick', 'wheel', 'contextmenu']) {
    root.addEventListener(ev, (e) => { e.stopPropagation(); if (ev === 'contextmenu') e.preventDefault(); });
  }

  const sync = () => {
    const m = ed.camera.matrixWorldInverse.elements; // column-major, camera space: x right, y up, z towards viewer
    const R = (i, j) => m[j * 4 + i];
    // css space is y-down: M = F R F with F = diag(1,-1,1)
    const f = [1, -1, 1];
    const e = [];
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) e.push(c < 3 && r < 3 ? R(r, c) * f[r] * f[c] : (c === r ? 1 : 0));
    cube.style.transform = `matrix3d(${e.join(',')})`;
  };
  ed.viewCubeSync = () => {
    ed.camera.updateMatrixWorld(true);
    sync();
    bProj.textContent = ed.isOrtho ? 'Ortho' : 'Persp';
    bProj.classList.toggle('tp-on', ed.isOrtho);
    bTurn.classList.toggle('tp-on', ed.turntable);
  };
  ed.controls.addEventListener('change', ed.viewCubeSync);
  ed.hooks = ed.hooks || {};
  const prevHook = ed.hooks.onViewChanged;
  ed.hooks.onViewChanged = () => { ed.viewCubeSync(); if (ed._refreshBookmarks) ed._refreshBookmarks(); if (prevHook) prevHook(); };

  bProj.onclick = () => ed.setOrtho(!ed.isOrtho);
  bHome.onclick = () => ed.fitWhole();
  bSel.onclick = () => ed.frameMask();
  bTurn.onclick = () => { ed.setTurntable(!ed.turntable); ed.viewCubeSync(); };
  bMark.onclick = () => { if (ed.saveBookmark()) ed.setStatus('Camera bookmark saved (Display panel -> Camera bookmarks).', 'ok'); };
  ed.viewCubeSync();
  return root;
}
