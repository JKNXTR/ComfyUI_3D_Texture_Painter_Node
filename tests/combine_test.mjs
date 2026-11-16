// Unit tests of the layer-combine maths (pure typed arrays, no browser).
import { combineLayers } from '../src/combine.js';
let failed = false;
const ok = (name, cond, extra = '') => { console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)); if (!cond) failed = true; };
const W = 96, H = 64, N = W * H;
const mk = (id, col, x0, x1, alphaFn = () => 255, name = id) => {
  const rgba = new Uint8ClampedArray(N * 4);
  for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) { const p = y * W + x; rgba[p * 4] = col[0]; rgba[p * 4 + 1] = col[1]; rgba[p * 4 + 2] = col[2]; rgba[p * 4 + 3] = alphaFn(x, y); }
  return { id, name, rgba, mask: null, opacity: 1, imp: 1 };
};
const px = (r, x, y) => Array.from(r.rgba.slice((y * W + x) * 4, (y * W + x) * 4 + 4));
const near = (a, b, t = 3) => a.every((v, i) => Math.abs(v - b[i]) <= t);

// A covers x 0..59 (red), B covers x 36..95 (blue); overlap 36..59
const A = mk('A', [220, 40, 40], 0, 60), B = mk('B', [40, 40, 220], 36, 96);
let r = combineLayers({ w: W, h: H, layers: [A, B], opts: { mode: 'weighted', detail: 'plain' } });
ok('weighted/plain: pure colours outside the overlap', near(px(r, 10, 10), [220, 40, 40, 255]) && near(px(r, 90, 10), [40, 40, 220, 255]));
ok('weighted/plain: equal weights average in the overlap', near(px(r, 48, 10), [130, 40, 130, 255]), JSON.stringify(px(r, 48, 10)));

const A2 = { ...A, imp: 1 }, B2 = { ...B, imp: 0.25 };
r = combineLayers({ w: W, h: H, layers: [A2, B2], opts: { mode: 'weighted', detail: 'plain' } });
ok('importance weights the average (1 : 0.25)', near(px(r, 48, 10), [(220 * 1 + 40 * 0.25) / 1.25, 40, (40 * 1 + 220 * 0.25) / 1.25, 255], 3), JSON.stringify(px(r, 48, 10)));

// confidence: A is weak (alpha 60) in the overlap, B strong
const Aw = mk('A', [220, 40, 40], 0, 60, (x) => (x >= 36 ? 60 : 255)), Bs = mk('B', [40, 40, 220], 36, 96, () => 255);
r = combineLayers({ w: W, h: H, layers: [Aw, Bs], opts: { mode: 'best', detail: 'plain' } });
const q = px(r, 48, 10);
ok('best view: the well-seen layer wins (confidence^4)', q[2] > 200 && q[0] < 60, JSON.stringify(q));
r = combineLayers({ w: W, h: H, layers: [Aw, Bs], opts: { mode: 'weighted', detail: 'plain', sharp: 1 } });
const q2 = px(r, 48, 10);
ok('weighted k=1 leans to the confident layer but still mixes', q2[2] > q2[0] && q2[0] > 40 + 10, JSON.stringify(q2));

// priority: the more important layer is on top even when the other is later in the stack
r = combineLayers({ w: W, h: H, layers: [{ ...A, imp: 1 }, { ...B, imp: 0.2 }], opts: { mode: 'priority' } });
ok('priority: most important layer wins the overlap', near(px(r, 48, 10), [220, 40, 40, 255]));
r = combineLayers({ w: W, h: H, layers: [{ ...A, imp: 0.2 }, { ...B, imp: 1 }], opts: { mode: 'priority' } });
ok('priority: swapping importance swaps the winner', near(px(r, 48, 10), [40, 40, 220, 255]));

// masks / opacity: a hidden (masked) layer does not contribute
const Am = { ...A, mask: new Uint8Array(N) };
r = combineLayers({ w: W, h: H, layers: [Am, B], opts: { mode: 'weighted', detail: 'plain' } });
ok('layer mask removes a layer from the mix', near(px(r, 48, 10), [40, 40, 220, 255]) && px(r, 10, 10)[3] === 0);

// multiband: a texture detail (checker) survives, the colour step between layers is blended smoothly
const detail = (x, y) => ((x + y) % 2 ? 255 : 225);
const mkd = (id, base, x0, x1) => { const l = mk(id, base, x0, x1); for (let p = 0; p < N; p++) if (l.rgba[p * 4 + 3]) { const x = p % W, y = (p / W) | 0, d = ((x >> 1) + (y >> 1)) % 2 ? 18 : -18; for (let k = 0; k < 3; k++) l.rgba[p * 4 + k] = Math.max(0, Math.min(255, base[k] + d)); } return l; };
const D1 = mkd('D1', [120, 120, 120], 0, 60), D2 = mkd('D2', [170, 170, 170], 36, 96);
r = combineLayers({ w: W, h: H, layers: [D1, D2], opts: { mode: 'weighted', detail: 'multiband', width: 16 } });
const row = (y) => Array.from({ length: W }, (_, x) => px(r, x, y)[0]);
const rr = row(20);
const stepAt = (arr, x) => Math.abs(arr[x + 1] - arr[x]);
// away from the overlap the output equals the input (detail kept)
ok('multiband: regions with a single layer are unchanged', Math.abs(rr[5] - D1.rgba[(20 * W + 5) * 4]) <= 2 && Math.abs(rr[90] - D2.rgba[(20 * W + 90) * 4]) <= 2, `${rr[5]} ${rr[90]}`);
// local mean across the overlap ramps from ~120 to ~170 without a jump
const mean = (x0) => { let s = 0; for (let i = 0; i < 4; i++) s += rr[x0 + i]; return s / 4; };
const m0 = mean(34), m1 = mean(42), m2 = mean(50), m3 = mean(58);
ok('multiband: colour changes smoothly across the overlap', m0 < m1 + 1 && m1 < m2 + 1 && m2 < m3 + 1 && (m3 - m0) > 10, `${m0} ${m1} ${m2} ${m3}`);
let maxJump = 0; for (let x = 36; x < 58; x += 4) maxJump = Math.max(maxJump, Math.abs(mean(x + 4) - mean(x)));
ok('multiband: no hard seam (local mean steps stay small)', maxJump < 30, String(maxJump));
let amp = 0; for (let x = 44; x < 52; x++) amp = Math.max(amp, Math.abs(rr[x] - rr[x + 2]));
ok('multiband: fine detail is kept inside the overlap', amp > 15, String(amp));

// normalize: layer B is much brighter; matching to anchor A pulls the overlap together, layer outside overlap is shifted by the same transform
const Aa = mkd('A', [110, 110, 110], 0, 60), Bb = mkd('B', [190, 190, 190], 36, 96);
const diff = (res) => Math.abs(px(res, 40, 20)[0] - px(res, 56, 20)[0]);
const noN = combineLayers({ w: W, h: H, layers: [Aa, Bb], opts: { mode: 'priority', normalize: 'off' } });
const withN = combineLayers({ w: W, h: H, layers: [Aa, Bb], opts: { mode: 'priority', normalize: 'anchor', normStrength: 1, anchorIndex: 0 } });
ok('normalize: B is matched toward the anchor in the overlap', Math.abs(px(withN, 90, 20)[0] - px(Aa, 40, 20)[0]) < Math.abs(px(noN, 90, 20)[0] - px(Aa, 40, 20)[0]) - 30, `${px(withN, 90, 20)[0]} vs ${px(noN, 90, 20)[0]}`);
ok('normalize: report lists the matched layer', withN.stats.normalized.length === 1 && withN.stats.normalized[0].overlap > 200, JSON.stringify(withN.stats.normalized));
// layers without overlap are NOT normalised (different content stays different)
const L1 = mk('L1', [200, 60, 60], 0, 30), L2 = mk('L2', [60, 60, 200], 60, 90);
const nn = combineLayers({ w: W, h: H, layers: [L1, L2], opts: { mode: 'weighted', detail: 'plain', normalize: 'anchor', normStrength: 1, anchorIndex: 0 } });
ok('normalize: no overlap -> left alone and reported as skipped', near(px(nn, 75, 10), [60, 60, 200, 255]) && nn.stats.normalized[0].skipped === true);
// strength 0 = no change
const s0 = combineLayers({ w: W, h: H, layers: [Aa, Bb], opts: { mode: 'priority', normalize: 'anchor', normStrength: 0, anchorIndex: 0 } });
ok('normalize strength 0 is identity', near(px(s0, 90, 20), px(noN, 90, 20), 2));

// gap fill + coverage stats
const island = new Uint8Array(N).fill(255);
const g1 = mk('G', [10, 200, 10], 0, 40);
r = combineLayers({ w: W, h: H, layers: [g1], opts: { mode: 'weighted', detail: 'plain', fill: 0 }, island });
const cov0 = r.stats.coverage;
r = combineLayers({ w: W, h: H, layers: [g1], opts: { mode: 'weighted', detail: 'plain', fill: 8 }, island });
ok('gap fill grows painted texels by the radius with the border colour', near(px(r, 45, 10), [10, 200, 10, 255]) && px(r, 52, 10)[3] === 0 && r.stats.filled > 0, JSON.stringify(px(r, 45, 10)));
ok('coverage statistics (before / after)', Math.abs(cov0 - 40 / 96) < 0.01 && r.stats.coverage > cov0 && Math.abs(r.stats.coverageBefore - cov0) < 1e-6, `${cov0} ${r.stats.coverage}`);
try { combineLayers({ w: W, h: H, layers: [], opts: {} }); ok('empty input throws', false); } catch (e) { ok('empty input throws a clear error', /No layers/.test(e.message)); }

// ---- transition mask: smooth ramp between two layers that disagree (v6.1) ----
{
  const Ar = mk('A', [220, 40, 40], 0, 60), Br = mk('B', [40, 40, 220], 36, 96);   // overlap 36..59, A=red, B=blue
  const T = new Uint8Array(N); for (let y = 0; y < H; y++) for (let x = 30; x < 66; x++) T[y * W + x] = 255;
  const base = combineLayers({ w: W, h: H, layers: [Ar, Br], opts: { mode: 'priority' } });
  const rr = combineLayers({ w: W, h: H, layers: [Ar, Br], opts: { mode: 'priority', trans: T, transWidth: 32 } });
  const red = (x) => rr.rgba[(10 * W + x) * 4], blu = (x) => rr.rgba[(10 * W + x) * 4 + 2];
  ok('transition: outside the painted band equals the plain result', near(px(rr, 10, 10), px(base, 10, 10)) && near(px(rr, 90, 10), px(base, 90, 10)));
  let mono = true, maxStep = 0; for (let x = 31; x < 65; x++) { if (red(x + 1) > red(x) + 2) mono = false; maxStep = Math.max(maxStep, Math.abs(red(x + 1) - red(x))); }
  ok('transition: red falls monotonically across the band', mono, 'steps ' + maxStep);
  ok('transition: no jump bigger than 25 per texel', maxStep < 25, 'max step ' + maxStep);
  ok('transition: both colours present mid-band', red(48) > 60 && blu(48) > 60, red(48) + '/' + blu(48));
  ok('transition: stats report painted texels', rr.stats.transition > 1000, JSON.stringify(rr.stats));
  const only = combineLayers({ w: W, h: H, layers: [Ar, Br], opts: { mode: 'priority', trans: T, transWidth: 32, transOnly: true } });
  ok('transition only: alpha 0 outside, >0 inside the band', only.rgba[(10 * W + 10) * 4 + 3] === 0 && only.rgba[(10 * W + 48) * 4 + 3] > 200);
  const none = combineLayers({ w: W, h: H, layers: [Ar, Br], opts: { mode: 'priority', trans: new Uint8Array(N), transWidth: 32 } });
  ok('empty transition mask changes nothing', near(px(none, 48, 10), px(base, 48, 10)) && none.stats.transition === undefined);
}
process.exit(failed ? 1 : 0);
