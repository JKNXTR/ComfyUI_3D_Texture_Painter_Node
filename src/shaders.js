// GLSL snippets used by the Texture Painter editor.
// Colour handling: every texture is treated as RAW bytes (NoColorSpace) and shaders never convert,
// so texels in the PNGs that are exported / baked are exactly what is displayed.

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

export const COPY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(tSrc, vUv); }`;

// Copies the red channel into an RGBA target as grey (used to read the R8 mask back).
export const COPY_GREY_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { float r = texture2D(tSrc, vUv).r; gl_FragColor = vec4(r, r, r, 1.0); }`;

export const INVERT_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
varying vec2 vUv;
void main() { float r = 1.0 - texture2D(tSrc, vUv).r; gl_FragColor = vec4(r, r, r, 1.0); }`;

export const FILL_FRAG = /* glsl */ `
precision highp float;
void main() { gl_FragColor = vec4(1.0); }`;

// Separable max / min / box-blur. uMode: 0 = dilate (max), 1 = erode (min), 2 = box blur
export const MORPH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uStep;
uniform float uR;
uniform float uMode;
varying vec2 vUv;
void main() {
  float acc = uMode < 0.5 ? 0.0 : (uMode < 1.5 ? 1.0 : 0.0);
  float cnt = 0.0;
  for (int i = -64; i <= 64; i++) {
    float fi = float(i);
    if (abs(fi) > uR) continue;
    float v = texture2D(tSrc, vUv + uStep * fi).r;
    if (uMode < 0.5) acc = max(acc, v);
    else if (uMode < 1.5) acc = min(acc, v);
    else { acc += v; cnt += 1.0; }
  }
  if (uMode > 1.5) acc /= max(cnt, 1.0);
  gl_FragColor = vec4(acc, acc, acc, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Display material for the 3D view
// ---------------------------------------------------------------------------------------------
export const MESH_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vUv = uv;
  vN = normal;
  vW = position;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

export const MESH_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tMask;
uniform vec3 uMaskColor;
uniform float uMaskOpacity;
uniform float uShowMask;
uniform sampler2D tRefRgn; uniform float uRefRegion;
uniform sampler2D tTrans;
uniform sampler2D tHeal;
uniform sampler2D tV0, tV1, tV2, tV3; uniform vec3 uVC0, uVC1, uVC2, uVC3; uniform float uShowViews;
uniform float uShowTrans;
uniform float uShade;
uniform float uFacingThr;
uniform float uChecker;
uniform sampler2D tCover;
uniform float uShowCover;
uniform float uOrtho;
uniform vec3 uCamDir;
uniform sampler2D tRef;
uniform float uRefOn;
uniform float uRefA;
uniform float uRefAll;
uniform vec4 uFrame;   // capture frame on screen: left, bottom, width, height (css px, bottom-up)
uniform float uDpr;
uniform vec4 uRefP;    // offset x, offset y (frame widths, y down), size (frame widths), rotation (rad)
uniform vec2 uRefQ;    // image aspect h/w, wrap
varying vec2 vUv;
varying vec3 vN;
varying vec3 vW;
void main() {
  vec3 n = normalize(vN);
  vec3 v = uOrtho > 0.5 ? uCamDir : normalize(cameraPosition - vW);
  float f = abs(dot(n, v));
  vec3 col = texture2D(tColor, vUv).rgb;
  { vec4 cv = texture2D(tCover, vUv); col = mix(col, cv.rgb, cv.a * uShowCover); }
  if (uChecker > 0.5) { vec2 g = floor(vUv * 16.0); float c = mod(g.x + g.y, 2.0); col = mix(col, mix(vec3(0.15), vec3(0.85), c), 0.85); }
  col *= mix(1.0, 0.30 + 0.70 * f, uShade);
  float m = texture2D(tMask, vUv).r * uShowMask;
  // orange = masked but seen at a grazing angle -> will bake poorly from this camera
  vec3 mc = mix(vec3(1.0, 0.55, 0.10), uMaskColor, smoothstep(uFacingThr, uFacingThr + 0.25, f));
  col = mix(col, mc, m * uMaskOpacity);
  col = mix(col, vec3(0.15, 0.5, 1.0), texture2D(tTrans, vUv).r * uShowTrans * 0.7);
  col = mix(col, vec3(0.04, 0.36, 0.1), texture2D(tHeal, vUv).r * 0.8);
  col = mix(col, uVC0, texture2D(tV0, vUv).r * uShowViews * 0.6); col = mix(col, uVC1, texture2D(tV1, vUv).r * uShowViews * 0.6);
  col = mix(col, uVC2, texture2D(tV2, vUv).r * uShowViews * 0.6); col = mix(col, uVC3, texture2D(tV3, vUv).r * uShowViews * 0.6);
  if (uRefOn > 0.5) {
    // planar reference placement preview: image 2 in capture-frame space, visible only inside the painted mask
    vec2 f = (gl_FragCoord.xy / uDpr - uFrame.xy) / uFrame.zw;
    float mk = uRefAll > 0.5 ? 1.0 : (uRefRegion > 0.5 ? texture2D(tRefRgn, vUv).r : texture2D(tMask, vUv).r);
    if (f.x >= 0.0 && f.x <= 1.0 && f.y >= 0.0 && f.y <= 1.0 && mk > 0.02) {
      vec2 d = vec2(f.x - 0.5 - uRefP.x, (0.5 - f.y) * uFrame.w / uFrame.z - uRefP.y);
      float ca = cos(uRefP.w), sa = sin(uRefP.w);
      vec2 q = vec2(ca * d.x + sa * d.y, -sa * d.x + ca * d.y) / uRefP.z;
      vec2 uv = vec2(q.x + 0.5, q.y / uRefQ.x + 0.5);
      float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
      if (uRefQ.y > 0.5) { uv = fract(uv); inside = 1.0; }
      col = mix(col, texture2D(tRef, vec2(uv.x, 1.0 - uv.y)).rgb, inside * clamp(mk * 1.5, 0.0, 1.0) * uRefA);
    }
  }
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Display material for the UV view (a quad covering [0,1]^2)
// ---------------------------------------------------------------------------------------------
export const UVQUAD_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0);
}`;

export const UVQUAD_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tMask;
uniform vec3 uMaskColor;
uniform float uMaskOpacity;
uniform float uShowMask;
uniform sampler2D tTrans;
uniform sampler2D tHeal;
uniform sampler2D tV0, tV1, tV2, tV3; uniform vec3 uVC0, uVC1, uVC2, uVC3; uniform float uShowViews;
uniform float uShowTrans;
uniform float uChecker;
uniform sampler2D tCover;
uniform float uShowCover;
varying vec2 vUv;
void main() {
  vec3 col = texture2D(tColor, vUv).rgb;
  { vec4 cv = texture2D(tCover, vUv); col = mix(col, cv.rgb, cv.a * uShowCover); }
  float m = texture2D(tMask, vUv).r * uShowMask;
  col = mix(col, uMaskColor, m * uMaskOpacity);
  col = mix(col, vec3(0.15, 0.5, 1.0), texture2D(tTrans, vUv).r * uShowTrans * 0.7);
  col = mix(col, vec3(0.04, 0.36, 0.1), texture2D(tHeal, vUv).r * 0.8);
  col = mix(col, uVC0, texture2D(tV0, vUv).r * uShowViews * 0.6); col = mix(col, uVC1, texture2D(tV1, vUv).r * uShowViews * 0.6);
  col = mix(col, uVC2, texture2D(tV2, vUv).r * uShowViews * 0.6); col = mix(col, uVC3, texture2D(tV3, vUv).r * uShowViews * 0.6);
  gl_FragColor = vec4(col, 1.0);
}`;

// ---------------------------------------------------------------------------------------------
// Projective brush: stamps a screen-space brush into UV space.
// The mesh is drawn with gl_Position = uv, so every visible texel under the brush is written
// directly into the mask (view independent, seam safe, no readbacks).
// ---------------------------------------------------------------------------------------------
export const PAINT_VERT = /* glsl */ `
varying vec3 vW;
varying vec3 vN;
void main() {
  vW = position;
  vN = normal;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

export const PAINT_FRAG = /* glsl */ `
precision highp float;
uniform mat4 uVP;
uniform vec3 uCam;
uniform vec2 uCenter;     // brush centre in pixels, origin bottom-left
uniform vec2 uSize;       // viewport size in pixels
uniform float uRadius;    // brush radius in pixels
uniform float uHardness;  // 0..1  size of the fully opaque core
uniform float uSoft;      // 0..1  0 = linear ramp, 1 = smooth (ease) ramp
uniform float uOpacity;
uniform sampler2D uDepth;
uniform sampler2D uShape;
uniform float uUseShape;
uniform float uNear;
uniform float uFar;
uniform float uBias;
uniform float uFacingMin;
uniform float uOutFacing;   // 1 = write the facing of every visible texel instead of a brush dab (view-preference map)
varying vec3 vW;
varying vec3 vN;

uniform float uOrtho;
uniform vec3 uCamDir;

float linZ(float d) {
  if (uOrtho > 0.5) return uNear + d * (uFar - uNear);
  float z = d * 2.0 - 1.0;
  return 2.0 * uNear * uFar / (uFar + uNear - z * (uFar - uNear));
}

void main() {
  vec4 clip = uVP * vec4(vW, 1.0);
  if (clip.w <= 0.0) discard;
  vec3 ndc = clip.xyz / clip.w;
  if (abs(ndc.x) > 1.0 || abs(ndc.y) > 1.0 || abs(ndc.z) > 1.0) discard;
  vec2 px = (ndc.xy * 0.5 + 0.5) * uSize;
  float d = length(px - uCenter) / uRadius;
  float shp = 1.0;
  if (uUseShape > 0.5) { shp = texture2D(uShape, ndc.xy * 0.5 + 0.5).r; if (shp < 0.004) discard; }
  else if (d > 1.0) discard;
  float f = abs(dot(normalize(vN), uOrtho > 0.5 ? uCamDir : normalize(uCam - vW)));
  if (f < uFacingMin) discard;
  float sd = texture2D(uDepth, ndc.xy * 0.5 + 0.5).x;
  float fd = ndc.z * 0.5 + 0.5;
  if (linZ(fd) > linZ(sd) + uBias * (1.0 + 4.0 * (1.0 - f))) discard;
  if (uOutFacing > 0.5) { gl_FragColor = vec4(f, f, f, 1.0); return; }
  float t = clamp((d - uHardness) / max(1.0 - uHardness, 0.001), 0.0, 1.0);
  float e = 1.0 - t;
  float a = (uUseShape > 0.5 ? shp : mix(e, e * e * (3.0 - 2.0 * e), uSoft)) * uOpacity;
  gl_FragColor = vec4(a, a, a, a);
}`;

// ---------------------------------------------------------------------------------------------
// Render passes used for the capture (sent to the Python side).
// uMode: 0 colour, 1 packed linear depth, 2 view-space normal, 3 UV mask, 4 silhouette
// ---------------------------------------------------------------------------------------------
export const PASS_VERT = /* glsl */ `
varying vec2 vUv;
varying vec3 vN;
varying vec3 vVP;
void main() {
  vUv = uv;
  vN = normal;
  vec4 vp = viewMatrix * vec4(position, 1.0);
  vVP = vp.xyz;
  gl_Position = projectionMatrix * vp;
}`;

export const PASS_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tColor;
uniform sampler2D tMask;
uniform float uMode;
uniform float uShade;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
varying vec3 vN;
varying vec3 vVP;
void main() {
  vec3 n = normalize(vN);
  if (uMode < 0.5) {
    vec3 v = normalize(-vVP);
    vec3 nv = normalize((viewMatrix * vec4(n, 0.0)).xyz);
    float f = abs(dot(nv, v));
    vec3 col = texture2D(tColor, vUv).rgb;
    col *= mix(1.0, 0.30 + 0.70 * f, uShade);
    gl_FragColor = vec4(col, 1.0);
  } else if (uMode < 1.5) {
    float t = clamp((-vVP.z - uNear) / (uFar - uNear), 0.0, 1.0);
    float v = floor(t * 16777215.0 + 0.5);
    float r = floor(v / 65536.0);
    float g = floor((v - r * 65536.0) / 256.0);
    float b = v - r * 65536.0 - g * 256.0;
    gl_FragColor = vec4(r / 255.0, g / 255.0, b / 255.0, 1.0);
  } else if (uMode < 2.5) {
    vec3 nv = normalize((viewMatrix * vec4(n, 0.0)).xyz);
    if (nv.z < 0.0) nv = -nv;
    gl_FragColor = vec4(nv * 0.5 + 0.5, 1.0);
  } else if (uMode < 3.5) {
    float m = texture2D(tMask, vUv).r;
    gl_FragColor = vec4(m, m, m, 1.0);
  } else {
    gl_FragColor = vec4(1.0);
  }
}`;

export const DEPTH_ONLY_FRAG = /* glsl */ `
precision highp float;
void main() { gl_FragColor = vec4(1.0); }`;

export const DEPTH_ONLY_VERT = /* glsl */ `
void main() { gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`;

// ---------------------------------------------------------------------------------------------
// Layer compositor. Straight (un-premultiplied) alpha everywhere; W3C compositing formula with the
// separable / non-separable blend functions. uMode order must match BLEND_MODES in layers.js.
// ---------------------------------------------------------------------------------------------
export const BLEND_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tDst;
uniform sampler2D tSrc;
uniform sampler2D tMask;
uniform float uHasMask;
uniform float uOpacity;
uniform float uMode;
uniform float uAdjOn;
uniform vec4 uAdj;   // brightness, contrast, saturation, hue (radians)
uniform vec3 uLev;   // levels: black point, white point, gamma
varying vec2 vUv;

float lum(vec3 c) { return dot(c, vec3(0.3, 0.59, 0.11)); }
vec3 clipColor(vec3 c) {
  float l = lum(c);
  float n = min(min(c.r, c.g), c.b);
  float x = max(max(c.r, c.g), c.b);
  if (n < 0.0) c = l + (c - l) * l / (l - n);
  if (x > 1.0) c = l + (c - l) * (1.0 - l) / (x - l);
  return c;
}
vec3 setLum(vec3 c, float l) { return clipColor(c + (l - lum(c))); }
float sat(vec3 c) { return max(max(c.r, c.g), c.b) - min(min(c.r, c.g), c.b); }
vec3 setSat(vec3 c, float s) {
  float mn = min(min(c.r, c.g), c.b);
  float mx = max(max(c.r, c.g), c.b);
  if (mx > mn) return (c - mn) * s / (mx - mn);
  return vec3(0.0);
}
float hardCh(float cb, float cs) { return cs <= 0.5 ? cb * 2.0 * cs : cb + (2.0 * cs - 1.0) - cb * (2.0 * cs - 1.0); }
float softCh(float cb, float cs) {
  if (cs <= 0.5) return cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
  float d = cb <= 0.25 ? ((16.0 * cb - 12.0) * cb + 4.0) * cb : sqrt(cb);
  return cb + (2.0 * cs - 1.0) * (d - cb);
}
float dodgeCh(float cb, float cs) { return cb <= 0.0 ? 0.0 : (cs >= 1.0 ? 1.0 : min(1.0, cb / (1.0 - cs))); }
float burnCh(float cb, float cs) { return cb >= 1.0 ? 1.0 : (cs <= 0.0 ? 0.0 : 1.0 - min(1.0, (1.0 - cb) / cs)); }

vec3 blendFn(vec3 cb, vec3 cs, float m) {
  if (m < 0.5) return cs;                                                            // 0 normal
  if (m < 1.5) return cb * cs;                                                       // 1 multiply
  if (m < 2.5) return cb + cs - cb * cs;                                             // 2 screen
  if (m < 3.5) return vec3(hardCh(cs.r, cb.r), hardCh(cs.g, cb.g), hardCh(cs.b, cb.b)); // 3 overlay
  if (m < 4.5) return vec3(softCh(cb.r, cs.r), softCh(cb.g, cs.g), softCh(cb.b, cs.b)); // 4 soft light
  if (m < 5.5) return vec3(hardCh(cb.r, cs.r), hardCh(cb.g, cs.g), hardCh(cb.b, cs.b)); // 5 hard light
  if (m < 6.5) return min(cb, cs);                                                   // 6 darken
  if (m < 7.5) return max(cb, cs);                                                   // 7 lighten
  if (m < 8.5) return vec3(dodgeCh(cb.r, cs.r), dodgeCh(cb.g, cs.g), dodgeCh(cb.b, cs.b)); // 8 dodge
  if (m < 9.5) return vec3(burnCh(cb.r, cs.r), burnCh(cb.g, cs.g), burnCh(cb.b, cs.b));    // 9 burn
  if (m < 10.5) return min(vec3(1.0), cb + cs);                                      // 10 add
  if (m < 11.5) return abs(cb - cs);                                                 // 11 difference
  if (m < 12.5) return setLum(setSat(cs, sat(cb)), lum(cb));                         // 12 hue
  if (m < 13.5) return setLum(cs, lum(cb));                                          // 13 color
  return setLum(cb, lum(cs));                                                        // 14 luminosity
}

// per-layer colour adjustment (levels -> brightness -> contrast -> saturation -> hue)
vec3 adjustColor(vec3 c) {
  c = clamp((c - uLev.x) / max(uLev.y - uLev.x, 1e-4), 0.0, 1.0);
  c = pow(c, vec3(1.0 / max(uLev.z, 0.05)));
  c += uAdj.x;
  c = (c - 0.5) * exp2(uAdj.y * 1.5) + 0.5;
  float l = lum(c);
  c = mix(vec3(l), c, max(0.0, 1.0 + uAdj.z));
  float cs = cos(uAdj.w), sn = sin(uAdj.w);
  vec3 k = vec3(0.57735027);
  c = c * cs + cross(k, c) * sn + k * dot(k, c) * (1.0 - cs);
  return clamp(c, 0.0, 1.0);
}

void main() {
  vec4 b = texture2D(tDst, vUv);
  vec4 s = texture2D(tSrc, vUv);
  if (uAdjOn > 0.5) s.rgb = adjustColor(s.rgb);
  float k = uHasMask > 0.5 ? texture2D(tMask, vUv).r : 1.0;
  float as = s.a * k * uOpacity;
  float ab = b.a;
  vec3 B = blendFn(b.rgb, s.rgb, uMode);
  float ar = as + ab * (1.0 - as);
  vec3 cr = ar > 1e-6 ? ((1.0 - as) * ab * b.rgb + as * ((1.0 - ab) * s.rgb + ab * B)) / ar : vec3(0.0);
  gl_FragColor = vec4(cr, ar);
}`;

// composite over an opaque background colour
export const FLATTEN_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec3 uBg;
varying vec2 vUv;
void main() { vec4 c = texture2D(tSrc, vUv); gl_FragColor = vec4(mix(uBg, c.rgb, c.a), 1.0); }`;

// UV coverage: draws the mesh flat into UV space (value 1 where a triangle covers the texel)
export const COVER_VERT = /* glsl */ `
void main() { gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0); }`;
export const COVER_FRAG = /* glsl */ `
precision highp float;
void main() { gl_FragColor = vec4(1.0); }`;

// colour + coverage -> RGBA (alpha = coverage), input for the padding passes
export const PREP_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform sampler2D tCov;
varying vec2 vUv;
void main() { gl_FragColor = vec4(texture2D(tSrc, vUv).rgb, step(0.5, texture2D(tCov, vUv).r)); }`;

// one step of seam padding: uncovered texels next to covered ones take the average of those neighbours
export const DILATE_FRAG = /* glsl */ `
precision highp float;
uniform sampler2D tSrc;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(tSrc, vUv);
  if (c.a > 0.5) { gl_FragColor = c; return; }
  vec3 acc = vec3(0.0);
  float n = 0.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec4 t = texture2D(tSrc, vUv + vec2(float(i), float(j)) * uTexel);
      if (t.a > 0.5) { acc += t.rgb; n += 1.0; }
    }
  }
  gl_FragColor = n > 0.0 ? vec4(acc / n, 1.0) : c;
}`;
