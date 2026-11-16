// Combine layers: merges several (AI) layers into one coherent UV texture. Pure typed-array maths (no GPU / DOM), so it is unit-testable.
//
//  weights   per texel and layer:  imp x alpha^k   (alpha = bake confidence x layer mask x layer opacity)
//  modes     priority  : stacked over-composite, the most important layer on top
//            weighted  : weighted average (confidence sharpness k, default 1)
//            best      : weighted average with k = 4, i.e. the best-seen layer wins
//  detail    plain     : weighted average at full resolution
//            multiband : colours blend softly (low band, width = blend width), fine detail comes from the dominant layer only (no ghosting)
//  normalize match each layer to an anchor layer only inside the areas where they overlap (Lab mean / spread, strength 0..1)
//  fill      grow painted texels into gaps (px)
const A_MIN = 0.02;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---- colour (sRGB <-> Lab) -------------------------------------------------------------------------
const LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
function rgbToLab(r, g, b, out) {
  const R = LIN[r], G = LIN[g], B = LIN[b];
  const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047, Y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B, Z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  out[0] = 116 * fy - 16; out[1] = 500 * (fx - fy); out[2] = 200 * (fy - fz);
}
function labToRgb(L, a, b, out) {
  const fy = (L + 16) / 116, fx = fy + a / 500, fz = fy - b / 200;
  const inv = (t) => { const t3 = t * t * t; return t3 > 0.008856 ? t3 : (t - 16 / 116) / 7.787; };
  const X = inv(fx) * 0.95047, Y = inv(fy), Z = inv(fz) * 1.08883;
  const R = 3.2404542 * X - 1.5371385 * Y - 0.4985314 * Z, G = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z, B = 0.0556434 * X - 0.2040259 * Y + 1.0572252 * Z;
  const e = (c) => { c = clamp(c, 0, 1); return Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055)); };
  out[0] = e(R); out[1] = e(G); out[2] = e(B);
}

// ---- helpers ---------------------------------------------------------------------------------------
/** effective alpha of layer l at texel p (0..1): bake confidence x mask x opacity */
function effA(l, p) {
  let a = l.rgba[p * 4 + 3] / 255;
  if (a < A_MIN) return 0;
  if (l.mask) a *= l.mask[p] / 255;
  return a * (l.opacity === undefined ? 1 : l.opacity);
}

/** separable box blur (3 passes ~ gaussian) in place on one Float32 plane, edge-clamped */
function blurPlane(a, w, h, r) {
  r = Math.max(0, Math.round(r));
  if (r < 1) return;
  const tmp = new Float32Array(Math.max(w, h));
  const run = (get, set, n) => {
    const win = 2 * r + 1;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += get(clamp(i, 0, n - 1));
    for (let i = 0; i < n; i++) {
      tmp[i] = sum / win;
      sum += get(clamp(i + r + 1, 0, n - 1)) - get(clamp(i - r, 0, n - 1));
    }
    for (let i = 0; i < n; i++) set(i, tmp[i]);
  };
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) run((i) => a[y * w + i], (i, v) => { a[y * w + i] = v; }, w);
    for (let x = 0; x < w; x++) run((i) => a[i * w + x], (i, v) => { a[i * w + x] = v; }, h);
  }
}

function sampleBilinear(arr, lw, lh, f, x, y, ch, k) {
  const fx = (x + 0.5) / f - 0.5, fy = (y + 0.5) / f - 0.5;
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const xa = clamp(x0, 0, lw - 1), xb = clamp(x0 + 1, 0, lw - 1), ya = clamp(y0, 0, lh - 1), yb = clamp(y0 + 1, 0, lh - 1);
  const v00 = arr[(ya * lw + xa) * ch + k], v10 = arr[(ya * lw + xb) * ch + k], v01 = arr[(yb * lw + xa) * ch + k], v11 = arr[(yb * lw + xb) * ch + k];
  return (v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty;
}

// ---- normalisation ---------------------------------------------------------------------------------
/** Lab statistics of one layer (low-res) inside the overlap with the reference. Returns a per-layer transform or null. */
function normalizeLayers(layers, w, h, opts, report) {
  const nf = Math.max(1, Math.floor(Math.max(w, h) / 384));
  const lw = Math.ceil(w / nf), lh = Math.ceil(h / nf), n = lw * lh;
  const lowOf = (l) => {   // alpha-weighted mean colour (Lab) + max alpha per low-res cell
    const lab = new Float32Array(n * 3), al = new Float32Array(n), acc = new Float32Array(n * 3), wsum = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, a = effA(l, p);
      if (a <= 0) continue;
      const c = (((y / nf) | 0) * lw + ((x / nf) | 0));
      acc[c * 3] += l.rgba[p * 4] * a; acc[c * 3 + 1] += l.rgba[p * 4 + 1] * a; acc[c * 3 + 2] += l.rgba[p * 4 + 2] * a; wsum[c] += a;
      if (a > al[c]) al[c] = a;
    }
    const t = [0, 0, 0];
    for (let c = 0; c < n; c++) if (wsum[c] > 0) { rgbToLab(Math.round(acc[c * 3] / wsum[c]), Math.round(acc[c * 3 + 1] / wsum[c]), Math.round(acc[c * 3 + 2] / wsum[c]), t); lab[c * 3] = t[0]; lab[c * 3 + 1] = t[1]; lab[c * 3 + 2] = t[2]; }
    return { lab, al };
  };
  const lows = layers.map(lowOf);
  const anchor = clamp(opts.anchorIndex | 0, 0, layers.length - 1);
  const done = layers.map((l) => !!l.fixed), T = new Array(layers.length).fill(null);   // fixed layers (current view) are never matched
  // running reference: colour (Lab) and alpha of everything already matched
  const refLab = new Float32Array(lows[anchor].lab), refA = new Float32Array(lows[anchor].al);
  done[anchor] = true;
  const MIN_OVERLAP = 30, strength = clamp(opts.normStrength === undefined ? 0.8 : opts.normStrength, 0, 1);
  for (;;) {
    let best = -1, bestN = MIN_OVERLAP - 1;
    for (let j = 0; j < layers.length; j++) {
      if (done[j]) continue;
      let cnt = 0; for (let c = 0; c < n; c++) if (lows[j].al[c] > 0.3 && refA[c] > 0.3) cnt++;
      if (cnt > bestN) { bestN = cnt; best = j; }
    }
    if (best < 0) break;
    const j = best, lj = lows[j];
    const mj = [0, 0, 0], mr = [0, 0, 0], vj = [0, 0, 0], vr = [0, 0, 0]; let cnt = 0;
    for (let c = 0; c < n; c++) if (lj.al[c] > 0.3 && refA[c] > 0.3) { cnt++; for (let k = 0; k < 3; k++) { mj[k] += lj.lab[c * 3 + k]; mr[k] += refLab[c * 3 + k]; } }
    for (let k = 0; k < 3; k++) { mj[k] /= cnt; mr[k] /= cnt; }
    for (let c = 0; c < n; c++) if (lj.al[c] > 0.3 && refA[c] > 0.3) for (let k = 0; k < 3; k++) { vj[k] += (lj.lab[c * 3 + k] - mj[k]) ** 2; vr[k] += (refLab[c * 3 + k] - mr[k]) ** 2; }
    const s = [0, 0, 0];
    for (let k = 0; k < 3; k++) { const sj = Math.sqrt(vj[k] / cnt), sr = Math.sqrt(vr[k] / cnt); s[k] = sj < 0.5 ? 1 : clamp(sr / sj, 0.6, 1.6); }
    T[j] = { mj, mr, s, t: strength };
    done[j] = true;
    report.push({ index: j, overlap: cnt * nf * nf, dL: mr[0] - mj[0], da: mr[1] - mj[1], db: mr[2] - mj[2] });
    // add the matched layer to the running reference
    for (let c = 0; c < n; c++) {
      if (lj.al[c] <= 0) continue;
      const adj = [0, 0, 0];
      for (let k = 0; k < 3; k++) { const x = lj.lab[c * 3 + k]; adj[k] = x + strength * ((x - mj[k]) * s[k] + mr[k] - x); }
      if (refA[c] > 0.3 && lj.al[c] > 0.3) for (let k = 0; k < 3; k++) refLab[c * 3 + k] = 0.5 * (refLab[c * 3 + k] + adj[k]);
      else if (lj.al[c] > refA[c]) for (let k = 0; k < 3; k++) refLab[c * 3 + k] = adj[k];
      if (lj.al[c] > refA[c]) refA[c] = lj.al[c];
    }
  }
  for (let j = 0; j < layers.length; j++) if (!done[j] && !layers[j].fixed) report.push({ index: j, overlap: 0, skipped: true });
  return T;
}

function applyTransform(l, T, w, h) {
  const out = new Uint8ClampedArray(l.rgba);
  const lab = [0, 0, 0], rgb = [0, 0, 0];
  for (let p = 0; p < w * h; p++) {
    if (l.rgba[p * 4 + 3] < 5) continue;
    rgbToLab(l.rgba[p * 4], l.rgba[p * 4 + 1], l.rgba[p * 4 + 2], lab);
    for (let k = 0; k < 3; k++) { const x = lab[k]; lab[k] = x + T.t * ((x - T.mj[k]) * T.s[k] + T.mr[k] - x); }
    labToRgb(lab[0], lab[1], lab[2], rgb);
    out[p * 4] = rgb[0]; out[p * 4 + 1] = rgb[1]; out[p * 4 + 2] = rgb[2];
  }
  return { ...l, rgba: out };
}

// ---- fill ------------------------------------------------------------------------------------------
function fillGaps(rgb, alpha, w, h, radius, island) {
  const N = w * h, painted = new Uint8Array(N);
  for (let p = 0; p < N; p++) painted[p] = alpha[p] >= 0.05 ? 1 : 0;
  let frontier = [];
  const nb = [-1, 1, -w, w, -w - 1, -w + 1, w - 1, w + 1];
  const around = (p, fn) => {
    const x = p % w, y = (p / w) | 0;
    for (let k = 0; k < 8; k++) {
      const dx = k === 0 || k === 4 || k === 6 ? -1 : (k === 1 || k === 5 || k === 7 ? 1 : 0), dy = k === 2 || k === 4 || k === 5 ? -1 : (k === 3 || k === 6 || k === 7 ? 1 : 0);
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      fn(ny * w + nx);
    }
  };
  for (let p = 0; p < N; p++) if (painted[p]) { let edge = false; around(p, (q) => { if (!painted[q]) edge = true; }); if (edge) frontier.push(p); }
  const stamp = new Int32Array(N); let filled = 0;
  for (let it = 1; it <= radius && frontier.length; it++) {
    const cand = [];
    for (const p of frontier) around(p, (q) => { if (!painted[q] && stamp[q] !== it && (!island || island[q])) { stamp[q] = it; cand.push(q); } });
    const next = [];
    for (const q of cand) {
      let r = 0, g = 0, b = 0, c = 0;
      around(q, (m) => { if (painted[m]) { r += rgb[m * 3]; g += rgb[m * 3 + 1]; b += rgb[m * 3 + 2]; c++; } });
      if (c) { rgb[q * 3] = r / c; rgb[q * 3 + 1] = g / c; rgb[q * 3 + 2] = b / c; next.push(q); }
    }
    for (const q of next) { painted[q] = 1; alpha[q] = 1; filled++; }
    frontier = next;
  }
  return filled;
}


// ---- transition ramp -------------------------------------------------------------------------------
/**
 * Soft partition of unity between the layers: each layer's weight is its (importance x alpha) coverage blurred by `width` px, so going from the area
 * of layer A into the area of layer B the weights cross-fade smoothly. Where a layer has no pixels the colour is extrapolated (blurred colour / blurred alpha).
 * Returns { rgb: Float32 N*3, cov: Float32 N (0..1) }
 */
function rampBlend(L, w, h, width) {
  const N = w * h, sigma = Math.max(4, width), f = Math.max(1, Math.min(8, Math.floor(sigma / 6)));
  const lw = Math.ceil(w / f), lh = Math.ceil(h / f), n = lw * lh, rad = (sigma / f) / 1.7;
  const sets = L.map((l) => {
    const num = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], den = new Float32Array(n), cw = new Float32Array(n), ca = new Float32Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, a = effA(l, p); if (a <= 0) continue;
      const c = ((y / f) | 0) * lw + ((x / f) | 0);
      num[0][c] += a * l.rgba[p * 4]; num[1][c] += a * l.rgba[p * 4 + 1]; num[2][c] += a * l.rgba[p * 4 + 2]; den[c] += a; cw[c] += a * Math.max(0, l.imp); ca[c] += a;
    }
    for (const pl of num) blurPlane(pl, lw, lh, rad);
    for (const pl of [den, cw, ca]) blurPlane(pl, lw, lh, rad);
    const col = new Float32Array(n * 3);
    for (let c = 0; c < n; c++) if (den[c] > 1e-6) for (let k = 0; k < 3; k++) col[c * 3 + k] = num[k][c] / den[c];
    return { col, den, cw, ca };
  });
  const rgb = new Float32Array(N * 3), cov = new Float32Array(N), wsum = new Float32Array(N);
  const samp1 = (arr, x, y) => sampleBilinear(arr, lw, lh, f, x, y, 1, 0);
  for (let i = 0; i < L.length; i++) {
    const l = L[i], S = sets[i];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const p = y * w + x, wt = samp1(S.cw, x, y); if (wt <= 1e-6) continue;
      const a = effA(l, p);
      let r, g, b;
      if (a >= 0.5) { r = l.rgba[p * 4]; g = l.rgba[p * 4 + 1]; b = l.rgba[p * 4 + 2]; }
      else {
        if (samp1(S.den, x, y) <= 1e-6) continue;
        r = sampleBilinear(S.col, lw, lh, f, x, y, 3, 0); g = sampleBilinear(S.col, lw, lh, f, x, y, 3, 1); b = sampleBilinear(S.col, lw, lh, f, x, y, 3, 2);
      }
      rgb[p * 3] += wt * r; rgb[p * 3 + 1] += wt * g; rgb[p * 3 + 2] += wt * b; wsum[p] += wt;
      cov[p] += samp1(S.ca, x, y);
    }
  }
  for (let p = 0; p < N; p++) { if (wsum[p] > 0) { rgb[p * 3] /= wsum[p]; rgb[p * 3 + 1] /= wsum[p]; rgb[p * 3 + 2] /= wsum[p]; } cov[p] = clamp(cov[p], 0, 1); }
  return { rgb, cov };
}

// ---- main ------------------------------------------------------------------------------------------
/**
 * layers: [{ id, name, rgba (w*h*4 straight alpha, top row first), mask (w*h, 0..255) | null, opacity, imp }]  (only the layers to combine)
 * opts: { mode, sharp, detail, width, normalize ('off'|'anchor'), normStrength, anchorIndex, fill,
 *         trans (Uint8Array w*h 0..255 | null: transition mask), transWidth (px), transOnly (output only the transition areas) }
 * island: Uint8Array(w*h) 0/255 or null (statistics + restricts gap filling)
 */
export function combineLayers({ w, h, layers, opts = {}, island = null }) {
  if (!layers.length) throw new Error('No layers to combine.');
  const N = w * h, mode = opts.mode || 'weighted';
  const stats = { layers: layers.length, mode, normalized: [], filled: 0 };
  // 1) normalisation (optional) -------------------------------------------------------------------
  let L = layers.map((l) => ({ ...l }));
  if (opts.normalize === 'anchor' && L.length > 1) {
    const T = normalizeLayers(L, w, h, opts, stats.normalized);
    L = L.map((l, i) => (T[i] ? applyTransform(l, T[i], w, h) : l));
    for (const r of stats.normalized) r.name = layers[r.index].name;
  }
  const out = new Float32Array(N * 3), alpha = new Float32Array(N);
  for (const l of L) for (let p = 0; p < N; p++) { const a = effA(l, p); if (a > alpha[p]) alpha[p] = a; }

  if (mode === 'priority') {
    const order = L.map((l, i) => i).sort((a, b) => (L[a].imp - L[b].imp) || (a - b));   // lowest importance first, most important on top
    const ao = new Float32Array(N);
    for (const i of order) {
      const l = L[i];
      for (let p = 0; p < N; p++) {
        const a = effA(l, p); if (a <= 0) continue;
        const ab = ao[p], a2 = a + ab * (1 - a);
        for (let k = 0; k < 3; k++) out[p * 3 + k] = (l.rgba[p * 4 + k] * a + out[p * 3 + k] * ab * (1 - a)) / a2;
        ao[p] = a2;
      }
    }
    alpha.set(ao);
  } else {
    const sharp = mode === 'best' ? 4 : Math.max(0.25, opts.sharp || 1);
    const wOf = (l, p) => { const a = effA(l, p); return a > 0 ? Math.max(0, l.imp) * Math.pow(a, sharp) : 0; };
    if (opts.detail === 'multiband') {
      const bestW = new Float32Array(N), bestI = new Int16Array(N).fill(-1);
      for (let i = 0; i < L.length; i++) for (let p = 0; p < N; p++) { const wt = wOf(L[i], p); if (wt > bestW[p]) { bestW[p] = wt; bestI[p] = i; } }
      const sigma = Math.max(4, opts.width || 32), f = Math.max(1, Math.min(8, Math.floor(sigma / 4)));
      const lw = Math.ceil(w / f), lh = Math.ceil(h / f), n = lw * lh, rad = (sigma / f) / 1.7;
      const sumNum = new Float32Array(n * 3), sumDen = new Float32Array(n);
      for (let i = 0; i < L.length; i++) {
        const l = L[i], num = [new Float32Array(n), new Float32Array(n), new Float32Array(n)], den = new Float32Array(n);
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const p = y * w + x, wt = wOf(l, p); if (wt <= 0) continue;
          const c = ((y / f) | 0) * lw + ((x / f) | 0);
          num[0][c] += wt * l.rgba[p * 4]; num[1][c] += wt * l.rgba[p * 4 + 1]; num[2][c] += wt * l.rgba[p * 4 + 2]; den[c] += wt;
        }
        for (const pl of num) blurPlane(pl, lw, lh, rad);
        blurPlane(den, lw, lh, rad);
        const cb = new Float32Array(n * 3);
        for (let c = 0; c < n; c++) {
          for (let k = 0; k < 3; k++) { sumNum[c * 3 + k] += num[k][c]; cb[c * 3 + k] = den[c] > 1e-6 ? num[k][c] / den[c] : 0; }
          sumDen[c] += den[c];
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const p = y * w + x; if (bestI[p] !== i) continue;
          for (let k = 0; k < 3; k++) out[p * 3 + k] += l.rgba[p * 4 + k] - sampleBilinear(cb, lw, lh, f, x, y, 3, k);
        }
      }
      const lowC = new Float32Array(n * 3);
      for (let c = 0; c < n; c++) for (let k = 0; k < 3; k++) lowC[c * 3 + k] = sumDen[c] > 1e-6 ? sumNum[c * 3 + k] / sumDen[c] : 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const p = y * w + x; if (bestI[p] < 0) continue; for (let k = 0; k < 3; k++) out[p * 3 + k] += sampleBilinear(lowC, lw, lh, f, x, y, 3, k); }
    } else {
      const den = new Float32Array(N);
      for (const l of L) for (let p = 0; p < N; p++) { const wt = wOf(l, p); if (wt <= 0) continue; den[p] += wt; out[p * 3] += wt * l.rgba[p * 4]; out[p * 3 + 1] += wt * l.rgba[p * 4 + 1]; out[p * 3 + 2] += wt * l.rgba[p * 4 + 2]; }
      for (let p = 0; p < N; p++) if (den[p] > 0) { out[p * 3] /= den[p]; out[p * 3 + 1] /= den[p]; out[p * 3 + 2] /= den[p]; }
    }
  }
  // 1b) transition mask: inside the painted transition areas the layers cross-fade smoothly into each other ------------
  if (opts.trans && L.length > 1) {
    let any = false; for (let p = 0; p < N && !any; p++) if (opts.trans[p] > 4) any = true;
    if (any) {
      const R = rampBlend(L, w, h, opts.transWidth || 48);
      const T = opts.trans; let n = 0, only = !!opts.transOnly;
      if (only) { out.fill(0); }
      for (let p = 0; p < N; p++) {
        const t = T[p] / 255; if (t <= 0.004 || R.cov[p] < 0.02) { if (only) alpha[p] = 0; continue; }
        n++;
        const tt = only ? 1 : t;
        for (let k = 0; k < 3; k++) out[p * 3 + k] = out[p * 3 + k] * (1 - tt) + R.rgb[p * 3 + k] * tt;
        if (only) alpha[p] = t * R.cov[p]; else alpha[p] = Math.max(alpha[p], t * R.cov[p]);
      }
      if (only) for (let p = 0; p < N; p++) if (T[p] / 255 <= 0.004 || R.cov[p] < 0.02) alpha[p] = 0;
      stats.transition = n;
      stats.transOnly = only;
    }
  }
  // 2) statistics + gap fill --------------------------------------------------------------------
  const covOf = () => { let isl = 0, hit = 0; for (let p = 0; p < N; p++) { if (island ? island[p] : true) { isl++; if (alpha[p] >= 0.5) hit++; } } return isl ? hit / isl : 0; };
  stats.coverageBefore = covOf();
  if (opts.fill > 0 && !stats.transOnly) stats.filled = fillGaps(out, alpha, w, h, Math.round(opts.fill), island);
  stats.coverage = covOf();
  const rgba = new Uint8ClampedArray(N * 4);
  for (let p = 0; p < N; p++) { rgba[p * 4] = out[p * 3]; rgba[p * 4 + 1] = out[p * 3 + 1]; rgba[p * 4 + 2] = out[p * 3 + 2]; rgba[p * 4 + 3] = Math.round(clamp(alpha[p], 0, 1) * 255); }
  return { rgba, stats };
}
