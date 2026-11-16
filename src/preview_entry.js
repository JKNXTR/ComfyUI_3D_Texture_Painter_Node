// Standalone UI preview: the REAL editor inside a mock ComfyUI graph. Generation is SIMULATED
// (no Flux/Klein, no Python): the "result" is a procedural pattern painted into the masked texels.
import { TexturePaintEditor } from './editor.js';

const css = `
html,body{margin:0;height:100%;background:#16181d;color:#d6d9e0;font:13px/1.4 system-ui,Segoe UI,Roboto,sans-serif}
#banner{position:fixed;top:0;left:0;right:0;z-index:50;background:#3a2a10;color:#ffd48a;padding:6px 14px;font-size:12px;border-bottom:1px solid #6b4c16;text-align:center}
#graph{position:relative;min-width:1900px;min-height:1060px;margin-top:30px;
 background-color:#1b1d23;background-image:radial-gradient(#2a2d36 1px,transparent 1px);background-size:22px 22px}
.node{position:absolute;background:#2b2e36;border:1px solid #444a58;border-radius:8px;box-shadow:0 6px 18px #0008;font-size:12px}
.node>.t{padding:5px 10px;border-radius:7px 7px 0 0;font-weight:600;background:#363a46;color:#e6e8ee}
.node.pt>.t{background:#5a2b55}.node.bk>.t{background:#2f5a43}
.node .w{display:flex;justify-content:space-between;gap:8px;margin:5px 8px;padding:4px 8px;background:#1d2027;border-radius:5px;color:#aab}
.node .w b{color:#e6e8ee;font-weight:500;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.node .o{display:flex;justify-content:flex-end;margin:3px 10px;color:#9fb}
.node .o i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-left:6px;background:#6c9;align-self:center}
.node .in{display:flex;margin:3px 10px;color:#9fb}.node .in i{width:9px;height:9px;border-radius:50%;margin-right:6px;background:#6c9;align-self:center}
#painter{left:20px;top:20px;width:1140px}
#phost{height:700px;margin:6px}
#pbar{display:flex;gap:8px;align-items:center;padding:6px 10px 10px}
#prompt{flex:1;background:#1d2027;color:#e6e8ee;border:1px solid #444a58;border-radius:5px;padding:6px 8px;font:inherit}
#gen{background:#b3359f;color:#fff;border:0;border-radius:6px;padding:8px 16px;font-weight:600;cursor:pointer}
#gen:disabled{opacity:.55;cursor:wait}
#wires{position:absolute;inset:0;pointer-events:none}
.prog{height:6px;background:#1d2027;margin:6px 8px;border-radius:3px;overflow:hidden}.prog>div{height:100%;width:0;background:#6c9}
`;
const st = document.createElement('style'); st.textContent = css; document.head.append(st);

document.body.innerHTML = `
<div id="banner">UI PREVIEW &mdash; the editor below is the real one. The generation step is <b>simulated</b> (a procedural pattern is painted into your mask); inside ComfyUI, Flux.2 Klein 9B does that step.</div>
<div id="graph">
  <svg id="wires"></svg>
  <div class="node" id="loader" style="left:1190px;top:30px;width:300px"><div class="t">Load Diffusion Model</div>
    <div class="w">unet_name <b>flux-2-klein-9b.safetensors</b></div><div class="o">MODEL<i></i></div></div>
  <div class="node" id="enc" style="left:1190px;top:170px;width:300px"><div class="t">CLIP Text Encode (Prompt)</div>
    <div class="in"><i></i>clip</div><div class="in"><i></i>text ← Painter.prompt</div><div class="o">CONDITIONING<i></i></div></div>
  <div class="node" id="smp" style="left:1190px;top:330px;width:300px"><div class="t">Klein edit sampler (from template)</div>
    <div class="in"><i></i>reference ← Painter.edit_image</div><div class="in"><i></i>ReferenceLatent ← Painter.reference_image (opt.)</div><div class="w">steps <b>4</b></div><div class="w">cfg <b>1.0</b></div><div class="prog"><div id="pg"></div></div><div class="o">IMAGE<i></i></div></div>
  <div class="node bk" id="bake" style="left:1190px;top:540px;width:300px"><div class="t">Texture Painter AI &mdash; Bake</div>
    <div class="in"><i></i>bake_data</div><div class="in"><i></i>generated_image</div>
    <div class="w">depth_bias <b>0.003</b></div><div class="w">strength <b>1.00</b></div><div class="w">padding <b>8</b></div>
    <div class="o">texture<i></i></div><div class="o">remaining_mask<i></i></div><div class="o">report<i></i></div></div>
  <div class="node pt" id="painter"><div class="t">Texture Painter AI</div>
    <div id="phost"></div>
    <div id="pbar"><input id="prompt" value="mossy cobblestones, damp, photoreal"><button id="gen">▶ Queue prompt (simulated)</button></div></div>
</div>`;

const ed = new TexturePaintEditor({ hooks: { onSyncRequest() { ed.markSynced(); } } });
document.getElementById('phost').append(ed.root);
ed.root.style.height = '100%';
window.preview = { ed };

function wires() {
  const svg = document.getElementById('wires');
  const P = document.getElementById('painter').getBoundingClientRect(), G = document.getElementById('graph').getBoundingClientRect();
  const pts = [[1160, 90, 1190, 245], [1160, 120, 1190, 380], [1340, 500, 1190, 590]];
  svg.innerHTML = pts.map(([x1, y1, x2, y2]) => `<path d="M${x1} ${y1} C${x1 + 60} ${y1},${x2 - 60} ${y2},${x2} ${y2}" stroke="#6c9" stroke-width="2" fill="none" opacity=".7"/>`).join('');
}
wires();

// ---- demo content: UV sphere + checker/gradient texture
function sphereOBJ(nu = 48, nv = 24) {
  let s = '';
  for (let j = 0; j <= nv; j++) for (let i = 0; i <= nu; i++) {
    const u = i / nu, v = j / nv, th = u * Math.PI * 2, ph = v * Math.PI;
    const x = Math.cos(th) * Math.sin(ph), y = Math.cos(ph), z = Math.sin(th) * Math.sin(ph);
    s += `v ${x} ${y} ${z}\nvt ${u} ${1 - v}\nvn ${x} ${y} ${z}\n`;
  }
  const id = (i, j) => j * (nu + 1) + i + 1;
  for (let j = 0; j < nv; j++) for (let i = 0; i < nu; i++) {
    const a = id(i, j), b = id(i + 1, j), c = id(i + 1, j + 1), d = id(i, j + 1);
    s += `f ${a}/${a}/${a} ${c}/${c}/${c} ${b}/${b}/${b}\nf ${a}/${a}/${a} ${d}/${d}/${d} ${c}/${c}/${c}\n`;
  }
  return s;
}
function demoTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 2048;
  const g = c.getContext('2d');
  const gr = g.createLinearGradient(0, 0, 0, 2048); gr.addColorStop(0, '#8d97a8'); gr.addColorStop(0.5, '#b9a58a'); gr.addColorStop(1, '#6f6a62');
  g.fillStyle = gr; g.fillRect(0, 0, 2048, 2048);
  g.strokeStyle = 'rgba(0,0,0,.28)'; g.lineWidth = 3;
  for (let y = 0; y < 2048; y += 128) { g.beginPath(); g.moveTo(0, y); g.lineTo(2048, y); g.stroke(); }
  for (let x = 0; x < 2048; x += 128) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 2048); g.stroke(); }
  return c;
}
(async () => {
  const enc = new TextEncoder().encode(sphereOBJ());
  await ed.loadModelBuffer(enc.buffer, 'demo_sphere.obj');
  ed.setTextureFromImage(demoTexture(), { label: 'demo texture', keepHistory: false });
  ed.frameModel();
  ed.log('ok', 'Demo sphere loaded. Paint on the 3D view (or UV map) with the brush, then press "Queue prompt (simulated)".');
})();

// ---- simulated generation
const gen = document.getElementById('gen'), pg = document.getElementById('pg');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
gen.onclick = async () => {
  if (ed.maskIsEmpty()) { ed.setStatus('Paint a mask first (B = brush).', 'warn'); return; }
  gen.disabled = true;
  try {
    ed.setStatus('Capturing view …');
    await ed.capture({ includeMesh: false, includeTexture: false });
    for (let i = 1; i <= 10; i++) { pg.style.width = i * 10 + '%'; ed.setStatus(`Simulated sampler … ${i * 10}%`); await sleep(110); }
    // fake "generated" texture: moss-like noise in masked texels, soft by mask value
    const S = ed.maskSize, mask = ed._readMaskPixels();
    const W = ed.layers.w, H = ed.layers.h;
    const out = new ImageData(W, H);   // RGBA layer: moss colour, alpha = mask (what the Bake node's layer_<id>.png carries)
    const hash = (x, y) => { const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return n - Math.floor(n); };
    const vn = (x, y) => { const xi = Math.floor(x), yi = Math.floor(y), fx = x - xi, fy = y - yi; const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1); const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy); return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v; };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const m = mask[((S - 1 - Math.floor(y * S / H)) * S + Math.floor(x * S / W)) * 4] / 255;
      if (m <= 0.01) continue;
      const n = 0.5 * vn(x / 9, y / 9) + 0.3 * vn(x / 3, y / 3) + 0.2 * vn(x / 40, y / 40);
      const i = (y * W + x) * 4, k = n * n * 1.3;
      out.data[i] = 40 + 70 * k; out.data[i + 1] = 78 + 120 * k; out.data[i + 2] = 28 + 40 * k; out.data[i + 3] = m * 255;
    }
    const rc = document.createElement('canvas'); rc.width = W; rc.height = H; rc.getContext('2d').putImageData(out, 0, 0);
    const rem = document.createElement('canvas'); rem.width = rem.height = 64; rem.getContext('2d').fillRect(0, 0, 64, 64);
    rem.getContext('2d').fillStyle = '#000'; rem.getContext('2d').fillRect(0, 0, 64, 64);
    await ed.showResult(await createImageBitmap(rc), await createImageBitmap(rem), { summary: 'SIMULATED result (preview only) - real baking runs in Python inside ComfyUI.', prompt: document.getElementById('prompt').value });
    ed.setStatus('Result ready - Apply or Discard (banner at the top of the viewport).', 'ok');
  } catch (e) { ed.log('error', 'Preview generation failed', e); ed.setStatus('Preview error: ' + e.message, 'err'); }
  pg.style.width = '0'; gen.disabled = false;
};
