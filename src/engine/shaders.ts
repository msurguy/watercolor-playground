import { displayBasisGLSL } from './spectral';

// Texture layout
//   velocity  RG16F  (sim grid)       water flow, in sim texels / second
//   wet       R16F   (document grid)  standing water on the paper
//   ink       2 × RGBA16F (document)   mobile pigment: A = absorbance coeffs 0..3,
//                                      B.rgb = coeffs 4..6, B.a = white gouache
//   fixed     2 × RGBA16F (document)   pigment settled into the paper (no white)
//   paper     RGBA8  (document)        r = lit relief, g = height, b = mottle, a = fleck

const HEADER = `#version 300 es
precision highp float;
in vec2 vUv;
`;

/** Circular stamp; MRT so one draw writes both pigment textures. */
export const splatFS = `${HEADER}
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
uniform float uAspect, uRadius, uHardness;
uniform vec2 uPoint;
uniform vec4 uColor0, uColor1;
void main(){
  vec2 p = vUv - uPoint; p.x *= uAspect;
  float d = dot(p, p) / (uRadius * uRadius);
  float f = exp(-pow(d, uHardness));
  o0 = uColor0 * f;
  o1 = uColor1 * f;
}`;

// Textured brush dab. The tip texture's square (-1..1) is mapped onto an ellipse of
// the brush's aspect, rotated by uAxis. uRound mixes toward a plain soft ellipse
// (used for the water footprint); uGrain gates the deposit by the paper's height so
// a dry brush only touches the peaks of the tooth.
export const stampFS = `${HEADER}
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
uniform sampler2D uTip, uPaper;
uniform float uAspect, uRadius, uTipAspect, uRound, uGrain, uGrainThr;
uniform vec2 uPoint, uAxis;
uniform vec4 uColor0, uColor1;
void main(){
  vec2 p = vUv - uPoint; p.x *= uAspect;
  vec2 q = vec2(dot(p, uAxis), dot(p, vec2(-uAxis.y, uAxis.x))) / uRadius;
  q.y /= uTipAspect;
  if (abs(q.x) > 1.0 || abs(q.y) > 1.0) discard;
  float t = texture(uTip, q * 0.5 + 0.5).r;
  float d = dot(q, q);
  float round = 1.0 - smoothstep(0.15, 1.0, d);
  float f = mix(t, round, uRound);
  float h = texture(uPaper, vUv).g;
  f *= mix(1.0, smoothstep(uGrainThr - 0.08, uGrainThr + 0.08, h), uGrain);
  o0 = uColor0 * f;
  o1 = uColor1 * f;
}`;

// Water flow: self-advect, damp, and confine to wet paper.
export const advectVelocityFS = `${HEADER}
out vec4 o;
uniform sampler2D uVelocity, uWet;
uniform vec2 uTexel;
uniform float uDt, uDissipation;
void main(){
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uTexel;
  vec2 vel = texture(uVelocity, coord).xy * uDissipation;
  float w = texture(uWet, vUv).x;
  o = vec4(vel * smoothstep(0.005, 0.2, w), 0.0, 1.0);
}`;

export const divergenceFS = `${HEADER}
out vec4 o;
uniform sampler2D uVelocity; uniform vec2 uTexel;
void main(){
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).y;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).y;
  o = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

export const pressureFS = `${HEADER}
out vec4 o;
uniform sampler2D uPressure, uDivergence; uniform vec2 uTexel;
void main(){
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  o = vec4((L + R + B + T - texture(uDivergence, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`;

export const gradientSubtractFS = `${HEADER}
out vec4 o;
uniform sampler2D uPressure, uVelocity; uniform vec2 uTexel;
void main(){
  float L = texture(uPressure, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uPressure, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uPressure, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uPressure, vUv + vec2(0.0, uTexel.y)).x;
  o = vec4(texture(uVelocity, vUv).xy - 0.5 * vec2(R - L, T - B), 0.0, 1.0);
}`;

export const curlFS = `${HEADER}
out vec4 o;
uniform sampler2D uVelocity; uniform vec2 uTexel;
void main(){
  float L = texture(uVelocity, vUv - vec2(uTexel.x, 0.0)).y;
  float R = texture(uVelocity, vUv + vec2(uTexel.x, 0.0)).y;
  float B = texture(uVelocity, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uVelocity, vUv + vec2(0.0, uTexel.y)).x;
  o = vec4(0.5 * ((R - L) - (T - B)), 0.0, 0.0, 1.0);
}`;

export const vorticityFS = `${HEADER}
out vec4 o;
uniform sampler2D uVelocity, uCurl;
uniform vec2 uTexel; uniform float uCurlAmount, uDt;
void main(){
  float L = texture(uCurl, vUv - vec2(uTexel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(uTexel.x, 0.0)).x;
  float B = texture(uCurl, vUv - vec2(0.0, uTexel.y)).x;
  float T = texture(uCurl, vUv + vec2(0.0, uTexel.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 1e-4;
  force *= uCurlAmount * C * vec2(1.0, -1.0);
  o = vec4(clamp(texture(uVelocity, vUv).xy + force * uDt, -1000.0, 1000.0), 0.0, 1.0);
}`;

export const scaleFS = `${HEADER}
out vec4 o;
uniform sampler2D uTex; uniform float uValue;
void main(){ o = texture(uTex, vUv) * uValue; }`;

// Where is there water at all? One output texel per block of the sheet: 1 where any of
// 8×8 taps across the block is wetter than uThreshold. Read back to bound the simulated region.
export const wetMaskFS = `${HEADER}
out vec4 o;
uniform sampler2D uWet;
uniform vec2 uBlock;        // one output texel, in wet-texture uv
uniform float uThreshold;
void main(){
  vec2 base = vUv - uBlock * 0.5;
  float m = 0.0;
  for (int y = 0; y < 8; y++) for (int x = 0; x < 8; x++) {
    vec2 p = base + uBlock * (vec2(float(x), float(y)) + 0.5) / 8.0;
    m = max(m, texture(uWet, p).r);
  }
  o = vec4(m > uThreshold ? 1.0 : 0.0, 0.0, 0.0, 1.0);
}`;

// Water: carried a little by the flow, creeps outward, evaporates.
export const advectWetFS = `${HEADER}
out vec4 o;
uniform sampler2D uVelocity, uWet;
uniform vec2 uSimTexel, uTexel;
uniform float uDt, uDecay, uSpread;
void main(){
  vec2 coord = vUv - uDt * texture(uVelocity, vUv).xy * uSimTexel * 0.6;
  float w = texture(uWet, coord).x;
  vec2 b = uTexel * 1.6;
  float n = (texture(uWet, coord + vec2(b.x, 0.0)).x + texture(uWet, coord - vec2(b.x, 0.0)).x
           + texture(uWet, coord + vec2(0.0, b.y)).x + texture(uWet, coord - vec2(0.0, b.y)).x) * 0.25;
  o = vec4(mix(w, n, uSpread) * uDecay, 0.0, 0.0, 1.0);
}`;

// Pigment transport. Three effects, all confined to wet paper:
//  1. advection by the water's flow (semi-Lagrangian),
//  2. diffusion between neighbouring wet texels (bleeding),
//  3. capillary flow down the wetness gradient toward the drying edge, where it is
//     stranded -> the dark "tide line" of a dried wash.
// 2 and 3 are written as fluxes across texel faces, gated by the mobility of both
// sides, so pigment is conserved and never seeps onto dry paper: wet-on-dry strokes
// keep hard edges, wet-in-wet strokes bloom as far as the water reaches.
export const advectInkFS = `${HEADER}
layout(location=0) out vec4 oA;
layout(location=1) out vec4 oB;
uniform sampler2D uVelocity, uInkA, uInkB, uWet;
uniform vec2 uSimTexel, uTexel;
uniform float uDt, uBleed, uEdge, uAspect, uKeep;
uniform vec3 uBrush;  // x, y, radius (radius <= 0: no brush down)

float mobility(float w){ return smoothstep(0.02, 0.45, w); }

void face(vec2 off, float w, float m, vec4 A, vec4 B, float diffusion, float edge,
          inout vec4 dA, inout vec4 dB){
  vec2 uv = vUv + off;
  float wn = texture(uWet, uv).x;
  float g = m * mobility(wn);
  if (g <= 0.0) return;
  vec4 An = texture(uInkA, uv), Bn = texture(uInkB, uv);
  float d = diffusion * g;
  // positive: water (and pigment) drifts from this texel toward the drier neighbour
  float e = clamp(edge * (w - wn), -0.08, 0.08) * g;
  dA += d * (An - A) - (e > 0.0 ? e * A : e * An);
  dB += d * (Bn - B) - (e > 0.0 ? e * B : e * Bn);
}

void main(){
  float w = texture(uWet, vUv).x;
  float m = mobility(w);
  vec4 A = texture(uInkA, vUv), B = texture(uInkB, vUv);
  if (m < 0.002){ oA = A * uKeep; oB = B * uKeep; return; }

  vec2 vel = texture(uVelocity, vUv).xy;
  vec2 coord = vUv - uDt * vel * uSimTexel * m;
  vec4 a = mix(A, texture(uInkA, coord), m);
  vec4 b = mix(B, texture(uInkB, coord), m);

  float brush = 0.0;
  if (uBrush.z > 0.0){
    vec2 d = vUv - uBrush.xy; d.x *= uAspect;
    brush = exp(-dot(d, d) / (uBrush.z * uBrush.z));
  }
  float diffusion = clamp(uBleed * (0.25 + 1.3 * brush) * 0.3, 0.0, 0.15);
  vec4 dA = vec4(0.0), dB = vec4(0.0);
  face(vec2( uTexel.x, 0.0), w, m, A, B, diffusion, uEdge, dA, dB);
  face(vec2(-uTexel.x, 0.0), w, m, A, B, diffusion, uEdge, dA, dB);
  face(vec2(0.0,  uTexel.y), w, m, A, B, diffusion, uEdge, dA, dB);
  face(vec2(0.0, -uTexel.y), w, m, A, B, diffusion, uEdge, dA, dB);

  // no clamping: basis coefficients are signed (only the spectrum they encode is positive)
  oA = (a + dA) * uKeep;
  oB = vec4((b + dB).rgb, max(b.a + dB.a, 0.0)) * uKeep;
}`;

// "Fix": mobile pigment settles into the paper. Drawn with additive blending into
// the fixed layer, after bleachFS has faded what lies under white gouache.
export const settleFS = `${HEADER}
layout(location=0) out vec4 oA;
layout(location=1) out vec4 oB;
uniform sampler2D uInkA, uInkB;
uniform float uSettle;
void main(){
  vec4 A = texture(uInkA, vUv), B = texture(uInkB, vUv);
  float keep = 1.0 - (1.0 - exp(-2.2 * B.a)) * uSettle;
  oA = A * uSettle * keep;
  oB = vec4(B.rgb * uSettle * keep, 0.0);
}`;

// Multiplicative pass (blend ZERO, SRC_COLOR): white gouache bleaches the fixed
// pigment beneath it, so after fixing it reads as paper and can be painted over.
export const bleachFS = `${HEADER}
layout(location=0) out vec4 oA;
layout(location=1) out vec4 oB;
uniform sampler2D uInkB;
uniform float uSettle;
void main(){
  float keep = 1.0 - (1.0 - exp(-2.2 * texture(uInkB, vUv).a)) * uSettle;
  oA = vec4(keep);
  oB = vec4(keep);
}`;

// Multiplicative stamp (blend ZERO, ONE_MINUS_SRC_COLOR): blotting with a tissue.
export const liftFS = `${HEADER}
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
uniform float uAspect, uRadius, uAmount;
uniform vec2 uPoint;
void main(){
  vec2 p = vUv - uPoint; p.x *= uAspect;
  float f = uAmount * exp(-pow(dot(p, p) / (uRadius * uRadius), 2.0));
  o0 = vec4(f);
  o1 = vec4(f);
}`;

// Paper, generated per document and whenever the paper is changed, in two passes.
// paperFieldFS builds the sheet's procedural field into a half-float target:
//   x = height 0..1 (mean ~0.5), y = mottle 0..1 (fibre clumping, 0.5 neutral),
//   z = fleck 0..1 (0.5 none, below: dark speck, above: light fibre).
// paperLightFS then lights the height from the upper left and packs the paper texture.
// Positions are in "units": a texel of a 1100-texel-tall sheet, about 0.18 mm, so the
// grain looks the same at any document size.
export const paperFieldFS = `${HEADER}
out vec4 o;
uniform vec2 uRes, uOffset;   // target size and where it sits on the sheet (texels)
uniform float uScale;         // units per texel
uniform float uSeed;
uniform int uKind;
const float PI = 3.14159265;

uint pcg(uint v){ uint s = v * 747796405u + 2891336453u; uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u; return (w >> 22u) ^ w; }
float hash(vec2 c, float salt){
  ivec2 i = ivec2(floor(c));
  return float(pcg(uint(i.x) + pcg(uint(i.y) + pcg(uint(salt) + uint(uSeed * 7919.0))))) * (1.0 / 4294967296.0);
}
vec2 hash2(vec2 c, float salt){ return vec2(hash(c, salt), hash(c, salt + 1.0)); }
float vnoise(vec2 p, float salt){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i, salt), hash(i + vec2(1.0, 0.0), salt), f.x),
             mix(hash(i + vec2(0.0, 1.0), salt), hash(i + vec2(1.0, 1.0), salt), f.x), f.y);
}
// normalised to 0..1; each octave rotated so the lattice never shows
float fbm(vec2 p, int oct, float salt){
  float v = 0.0, a = 0.5, n = 0.0;
  for (int i = 0; i < 6; i++){
    if (i >= oct) break;
    v += a * vnoise(p, salt + float(i) * 13.0); n += a;
    p = mat2(0.8, -0.6, 0.6, 0.8) * p * 2.03 + 17.1; a *= 0.5;
  }
  return v / n;
}
// distances to the nearest and second-nearest of a jittered lattice of points
vec2 cells(vec2 p, float jitter, float salt){
  vec2 i = floor(p), f = fract(p);
  float d1 = 9.0, d2 = 9.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 c = vec2(x, y);
    float d = length(c + 0.5 + (hash2(i + c, salt) - 0.5) * jitter - f);
    if (d < d1){ d2 = d1; d1 = d; } else if (d < d2) d2 = d;
  }
  return vec2(d1, d2);
}
// Rounded hills of random size and height scattered on a jittered grid; never polygonal
// like cells, because neighbouring hills simply add up. Roughly 0..1.
float blobs(vec2 p, float salt){
  vec2 i = floor(p), f = fract(p);
  float h = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 c = vec2(x, y);
    vec4 r = vec4(hash2(i + c, salt), hash2(i + c, salt + 2.0));
    vec2 d = c + r.xy - f;
    float rad = 0.35 + 0.4 * r.z;
    h += (0.5 + 0.5 * r.w) * exp(-dot(d, d) / (rad * rad));
  }
  return h * 0.75;
}
float segment(vec2 p, vec2 a, vec2 b){
  vec2 pa = p - a, ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}
// Thin strands scattered over a grid of 'cell' units, up to 'len' cells long and 'width'
// units wide; returns the coverage of the nearest. 'along' lines them up with x, the
// way a paper machine lays its fibres; 'density' is the share of grid slots that hold one.
float fibres(vec2 p, float cell, float len, float width, float density, float along, float salt){
  p /= cell;
  vec2 i = floor(p);
  float cov = 0.0;
  for (int y = -2; y <= 2; y++) for (int x = -2; x <= 2; x++){
    vec2 c = i + vec2(x, y);
    for (int k = 0; k < 2; k++){
      float s = salt + float(k) * 31.0;
      vec4 h = vec4(hash2(c, s), hash2(c, s + 2.0));
      if (h.w < density){
        float a = (h.z - 0.5) * PI * (1.0 - along);
        vec2 d = vec2(cos(a), sin(a)) * len * (0.35 + 0.65 * hash(c, s + 4.0)) * 0.5;
        float dist = segment(p, c + h.xy - d, c + h.xy + d) * cell;
        cov = max(cov, (1.0 - smoothstep(width * 0.5, width * 0.5 + 0.9, dist)) * (0.55 + 0.45 * hash(c, s + 5.0)));
      }
    }
  }
  return cov;
}
// small round specks: coverage of the nearest, 'density' of grid slots hold one
float specks(vec2 p, float cell, float radius, float density, float salt){
  vec2 i = floor(p / cell), f = p / cell - i;
  float cov = 0.0;
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 c = vec2(x, y);
    if (hash(i + c, salt + 2.0) < density){
      float r = radius * (0.4 + 0.6 * hash(i + c, salt + 3.0));
      float d = length(c + hash2(i + c, salt) - f) * cell;
      cov = max(cov, 1.0 - smoothstep(r * 0.6, r + 0.6, d));
    }
  }
  return cov;
}
// distance to the nearest centre of a hexagonal lattice with spacing 1
float hexDist(vec2 p){
  const vec2 s = vec2(1.0, 1.7320508);
  vec2 a = mod(p, s) - s * 0.5, b = mod(p - s * 0.5, s) - s * 0.5;
  return min(length(a), length(b));
}
vec2 warp(vec2 p, float freq, float amount, float salt){
  return p + (vec2(fbm(p * freq, 3, salt), fbm(p * freq, 3, salt + 50.0)) - 0.5) * amount;
}

// Cold press: rounded, irregular bumps of mixed size (~0.5-2 mm) over a fine felt.
vec3 coldPress(vec2 p){
  vec2 q = warp(p, 0.02, 10.0, 100.0);
  float hills = blobs(q / 11.0, 110.0) * 0.6 + blobs(q / 5.5, 115.0) * 0.4;
  float h = hills * 0.5 + fbm(q * 0.09, 5, 120.0) * 0.38 + vnoise(p * 0.5, 130.0) * 0.12;
  return vec3(0.5 + (h - 0.5) * 1.3, fbm(p * 0.012, 4, 140.0), 0.5);
}
// Hot press: pressed nearly flat; only a faint felt and the fibres show.
vec3 hotPress(vec2 p){
  float h = fbm(p * 0.06, 4, 200.0) * 0.6 + vnoise(p * 0.4, 210.0) * 0.25 + fibres(p, 16.0, 2.5, 0.8, 0.3, 0.0, 220.0) * 0.05;
  return vec3(0.5 + (h - 0.4) * 0.45, fbm(p * 0.01, 4, 230.0), 0.5);
}
// Rough: big knobbly hills (~2-4 mm) with deep valleys between them.
vec3 rough(vec2 p){
  vec2 q = warp(p, 0.01, 40.0, 300.0);
  // hill size varies across the sheet, as on a mould-made rough
  float big = smoothstep(0.3, 0.7, fbm(p * 0.006, 3, 305.0));
  float hills = blobs(q / 26.0, 310.0) * (0.35 + 0.4 * big) + blobs(q / 12.0, 315.0) * (0.45 - 0.25 * big);
  float h = hills * 0.65 + fbm(q * 0.06, 5, 320.0) * 0.25 + vnoise(p * 0.45, 325.0) * 0.1;
  return vec3(0.5 + (h - 0.52) * 1.5, fbm(p * 0.01, 4, 330.0), 0.5);
}
// Khadi: handmade, lumpy at every scale, with raised fibres and dark inclusions.
vec3 khadi(vec2 p){
  vec2 q = warp(p, 0.008, 60.0, 400.0);
  float lumps = fbm(q * 0.035, 5, 410.0);
  vec2 c = cells(q / 13.0, 1.0, 420.0);
  float knobs = 1.0 - smoothstep(0.0, 0.9, c.x);
  float fib = fibres(warp(p, 0.05, 8.0, 430.0), 9.0, 3.0, 1.1, 0.6, 0.0, 440.0);
  float h = lumps * 0.5 + knobs * 0.3 + fbm(p * 0.2, 3, 450.0) * 0.16 + fib * 0.03;
  float dark = max(specks(p, 60.0, 2.0, 0.3, 460.0), fibres(warp(p, 0.06, 10.0, 465.0), 110.0, 0.4, 0.9, 0.3, 0.0, 470.0) * 0.6);
  return vec3(0.5 + (h - 0.5) * 1.6, fbm(p * 0.006, 4, 480.0) * 0.7 + fib * 0.25, 0.5 - dark * 0.35 + fib * 0.06);
}
// Washi: smooth and cloudy, a web of long kozo fibres lying on top, the odd bark speck.
vec3 washi(vec2 p){
  vec2 q = warp(p, 0.025, 28.0, 500.0);
  float longF = fibres(q, 42.0, 3.4, 1.3, 0.4, 0.0, 510.0) * (0.6 + 0.4 * vnoise(p * 0.05, 512.0));
  float fineF = fibres(warp(p, 0.05, 10.0, 515.0), 14.0, 3.0, 0.6, 0.45, 0.0, 520.0);
  float h = fbm(p * 0.05, 4, 530.0) * 0.8 + longF * 0.08 + fineF * 0.03;
  float cloud = fbm(p * 0.005, 5, 540.0);
  float bark = specks(p, 70.0, 1.6, 0.18, 550.0);
  return vec3(0.5 + (h - 0.42) * 0.7, cloud * 0.85 + longF * 0.15, 0.5 + longF * 0.16 + fineF * 0.05 - bark * 0.4);
}
// Laid: close laid lines (~1 mm) crossed by chain lines (~25 mm), over a soft felt.
vec3 laid(vec2 p){
  float wob = (fbm(p * vec2(0.004, 0.02), 3, 600.0) - 0.5) * 6.0;
  float lines = pow(0.5 + 0.5 * cos(2.0 * PI * (p.y + wob) / 5.6), 2.0);
  float cx = p.x + (fbm(p * vec2(0.02, 0.004), 3, 610.0) - 0.5) * 8.0;
  float dc = abs(fract(cx / 140.0) - 0.5) * 140.0;   // distance to the nearest chain line
  float chain = 1.0 - smoothstep(1.0, 3.5, dc);
  float h = lines * 0.1 + chain * 0.05 + fbm(p * 0.08, 4, 620.0) * 0.6;
  // the sheet runs a touch thicker beside each chain line, and the laid lines read faintly in the tone
  float tone = 0.5 - 0.12 * exp(-dc / 12.0) - 0.06 * lines + (fbm(p * 0.01, 3, 630.0) - 0.5) * 0.6;
  return vec3(0.5 + (h - 0.36) * 1.1, tone, 0.5);
}
// Canvas: a plain weave of slightly uneven threads under a coat of gesso.
vec3 canvas(vec2 p){
  const float T = 8.0;
  p += (vec2(vnoise(p * 0.02, 700.0), vnoise(p * 0.02, 701.0)) - 0.5) * T * 1.2;
  vec2 c = p / T, i = floor(c), f = fract(c);
  float tx = 0.8 + 0.2 * hash(vec2(i.x, 0.0), 702.0) + 0.3 * (vnoise(vec2(i.x * 5.0, c.y * 0.35), 703.0) - 0.5);
  float ty = 0.8 + 0.2 * hash(vec2(0.0, i.y), 704.0) + 0.3 * (vnoise(vec2(c.x * 0.35, i.y * 5.0), 705.0) - 0.5);
  // where a thread crosses over, it shows as a rice-grain bump along its length;
  // over and under alternate, so the grains make a checkerboard
  vec2 d = f - 0.5;
  bool warpUp = mod(i.x + i.y, 2.0) > 0.5;
  d *= warpUp ? vec2(2.3, 1.15) : vec2(1.15, 2.3);
  float grain = max(0.0, 1.0 - dot(d, d)) * (warpUp ? tx : ty);
  float h = sqrt(grain) * 0.75 + fbm(p * 0.15, 3, 706.0) * 0.25;
  return vec3(0.5 + (h - 0.55) * 1.1, fbm(p * 0.01, 3, 707.0), 0.5);
}
// Toned (Mi-Teintes honeycomb): a regular mesh of shallow pits ~1.5 mm across.
vec3 toned(vec2 p){
  vec2 q = warp(p, 0.05, 7.0, 800.0) / 9.0;
  float d = hexDist(q) * (0.8 + 0.4 * vnoise(q * 2.0, 805.0));
  float rims = smoothstep(0.1, 0.55, d);
  float h = rims * 0.28 + fbm(p * 0.09, 4, 810.0) * 0.6 + fibres(p, 12.0, 2.0, 0.9, 0.35, 0.0, 820.0) * 0.04;
  return vec3(0.5 + (h - 0.42) * 1.2, fbm(p * 0.012, 4, 830.0), 0.5 - specks(p, 60.0, 1.2, 0.2, 840.0) * 0.3);
}
// Kraft: smooth, streaky along the machine direction, with dark bark and recycled flecks.
vec3 kraft(vec2 p){
  float h = fbm(p * 0.07, 4, 900.0) * 0.6 + vnoise(p * 0.35, 910.0) * 0.32 + fibres(p, 10.0, 2.5, 0.9, 0.6, 0.7, 920.0) * 0.04;
  float streak = fbm(p * vec2(0.004, 0.03), 5, 930.0);
  float dark = max(fibres(warp(p, 0.08, 10.0, 935.0), 60.0, 0.35, 0.7, 0.2, 0.6, 940.0) * 0.6, specks(p, 40.0, 1.3, 0.35, 950.0));
  float light = fibres(warp(p, 0.08, 10.0, 955.0), 70.0, 0.4, 1.0, 0.25, 0.5, 960.0);
  return vec3(0.5 + (h - 0.45) * 0.7, streak * 0.8 + fbm(p * 0.01, 3, 970.0) * 0.2, 0.5 - dark * 0.28 + light * 0.12);
}
// Student (cellulose): a felt-pressed texture of small bumps all of one size, evenly spread.
vec3 student(vec2 p){
  vec2 q = warp(p, 0.03, 3.0, 995.0);
  vec2 c = cells(q / 7.0, 0.7, 1000.0);
  float bumps = 1.0 - smoothstep(0.0, 0.7, c.x);
  float h = bumps * 0.6 + fbm(p * 0.12, 3, 1010.0) * 0.4;
  return vec3(0.5 + (h - 0.48) * 1.1, fbm(p * 0.015, 3, 1020.0), 0.5);
}

void main(){
  vec2 p = (vUv * uRes + uOffset) * uScale;
  vec3 f;
  switch (uKind){
    case 1: f = hotPress(p); break;
    case 2: f = rough(p); break;
    case 3: f = khadi(p); break;
    case 4: f = washi(p); break;
    case 5: f = laid(p); break;
    case 6: f = canvas(p); break;
    case 7: f = toned(p); break;
    case 8: f = kraft(p); break;
    case 9: f = student(p); break;
    default: f = coldPress(p);
  }
  o = vec4(clamp(f, 0.0, 1.0), 1.0);
}`;

// Light the field's height from the upper left. Packs the paper texture:
//   r = lit relief (0.5 flat), g = height, b = mottle, a = fleck.
export const paperLightFS = `${HEADER}
out vec4 o;
uniform sampler2D uField;
uniform vec2 uTexel;
uniform float uBump;          // relief strength, already divided by units per texel
void main(){
  vec4 f = texture(uField, vUv);
  float l = texture(uField, vUv - vec2(uTexel.x, 0.0)).x, r = texture(uField, vUv + vec2(uTexel.x, 0.0)).x;
  float b = texture(uField, vUv - vec2(0.0, uTexel.y)).x, t = texture(uField, vUv + vec2(0.0, uTexel.y)).x;
  vec3 n = normalize(vec3((l - r) * uBump, (b - t) * uBump, 1.0));
  vec3 L = normalize(vec3(-0.5, 0.6, 0.62));
  // a little ambient occlusion: valleys sit in shadow whichever way the light falls
  float lit = 0.5 + (dot(n, L) - L.z) * 1.3 + (f.x - 0.5) * 0.25;
  o = vec4(clamp(lit, 0.0, 1.0), f.x, f.y, f.z);
}`;

/** The sheet's colour (linear) from a paper texel; shared by the display and the swatches. */
const PAPER_COLOUR = `
uniform vec3 uPaperTint, uFleckTint;
uniform float uMottle;
uniform float uTexture;       // texture strength: 0 a flat sheet of the tint, 1 full relief
vec3 paperColour(vec4 paper, vec3 base){
  vec3 c = base * (1.0 + uTexture * ((paper.r - 0.5) * 0.32 + (paper.b - 0.5) * uMottle * 2.0));
  float fl = (paper.a - 0.5) * 2.0 * uTexture;
  return fl < 0.0 ? mix(c, uFleckTint, -fl) : mix(c, min(base * 1.1 + 0.02, vec3(1.0)), fl);
}`;

const TO_SRGB = `
vec3 toSRGB(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}`;

/** A paper preview: the sheet with a granulating ultramarine wash across one corner. */
export const paperSwatchFS = `${HEADER}
out vec4 o;
uniform sampler2D uPaper;
${PAPER_COLOUR}
${TO_SRGB}
void main(){
  vec4 paper = texture(uPaper, vUv);
  vec3 c = paperColour(paper, uPaperTint);
  float x = vUv.x * 0.62 + (1.0 - vUv.y) * 0.38 + (paper.g - 0.5) * 0.03;
  float wash = smoothstep(0.6, 0.605, x);
  float gran = 1.0 + (0.5 - paper.g) * 2.4;
  float tide = 1.0 + 0.5 * exp(-(x - 0.6) * 90.0) * wash;
  c *= mix(vec3(1.0), pow(vec3(0.3, 0.38, 0.72), vec3(gran * tide)), wash);
  o = vec4(toSRGB(c), 1.0);
}`;

// Paint-bucket wash. uField holds, per document texel, the distance travelled from the
// tap through the chosen area (r, px; -1 outside it) and the distance to the area's edge
// (g, px). The front is a ramp uWidth px wide: a texel at distance r has received the
// fraction ramp(t - r) of its deposit once the front has reached t, so the frame that
// moves the front from uFrom to uTo lays down the difference. Summed over all frames
// that is exactly one deposit per texel, with no frame boundary to leave a tide line.
// Water is drawn with MAX blending, so it gets the cumulative ramp instead. MRT like splatFS.
export const fillFS = `${HEADER}
layout(location=0) out vec4 o0;
layout(location=1) out vec4 o1;
uniform highp sampler2D uField;
uniform sampler2D uPaper;
uniform float uFrom, uTo, uWidth, uSoft, uGrain, uGrainThr, uJitter;
uniform int uCumulative;
uniform vec4 uColor0, uColor1;
float ramp(float x){ return smoothstep(0.0, 1.0, clamp(x / uWidth, 0.0, 1.0)); }
void main(){
  vec2 f = texture(uField, vUv).rg;
  if (f.r < 0.0) discard;
  float h = texture(uPaper, vUv).g;
  float r = max(0.0, f.r + (h - 0.5) * uJitter);
  float w = ramp(uTo - r) - (uCumulative == 1 ? 0.0 : ramp(uFrom - r));
  if (w <= 0.0) discard;
  float edge = uSoft > 0.0 ? smoothstep(0.0, uSoft, f.g + 0.5) : 1.0;
  w *= edge * mix(1.0, smoothstep(uGrainThr - 0.08, uGrainThr + 0.08, h), uGrain);
  o0 = uColor0 * w;
  o1 = uColor1 * w;
}`;

/** Final composite: spectral reconstruction of pigment on paper. */
export const displayFS = `${HEADER}
out vec4 o;
uniform sampler2D uInkA, uInkB, uFixedA, uFixedB, uWet, uPaper;
uniform vec4 uView;       // canvas px -> document uv: uv = (fragCoord - xy) / zw
uniform vec2 uTexel;      // document texel size
uniform float uGranulation, uEdgeDarken;
uniform float uFlat;      // 1: ignore the paper's relief, grain and wetness (for region picking)
uniform vec3 uDesk;
uniform int uMode;        // 0 screen, 1 export on paper, 2 export transparent, 3 export on white
uniform sampler2D uRef;   // reference image (screen only), sRGB, y up
uniform vec4 uRefRect;    // its placement in document uv: xy origin, zw size
uniform float uRefOpacity;
uniform float uShadow;    // screen only: size of the sheet's shadow on the desk (canvas px), 0 for exports
uniform float uDpr;
${PAPER_COLOUR}
${TO_SRGB}
float density(vec2 uv){ return texture(uInkA, uv).x + texture(uFixedA, uv).x; }

// Signed distance (canvas px) from p to the sheet, moved down by \`drop\`.
float sheetDist(vec2 p, float drop){
  vec2 q = abs(p - uView.xy - uView.zw * 0.5 + vec2(0.0, drop)) - uView.zw * 0.5;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
}

// The sheet lying on the desk: a tight contact shadow at its edge and a soft one
// cast a little downward, as from a light above and in front.
vec3 desk(vec2 p){
  float R = uShadow;
  float contact = 1.0 - smoothstep(0.0, 0.12 * R, sheetDist(p, 0.03 * R));
  float d = max(sheetDist(p, 0.3 * R), 0.0) / R;
  float ambient = exp(-3.0 * d * d) * 0.75 + exp(-0.9 * d) * 0.25;   // a soft core with a long, faint tail
  vec3 lin = pow(uDesk, vec3(2.2)) * (1.0 - 0.45 * contact) * (1.0 - 0.32 * ambient);
  return toSRGB(lin);
}

void main(){
  vec2 uv = (gl_FragCoord.xy - uView.xy) / uView.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0){
    o = vec4(uShadow > 0.0 ? desk(gl_FragCoord.xy) : uDesk, 1.0);
    return;
  }

  vec4 paper = mix(texture(uPaper, uv), vec4(0.5), uFlat);
  vec4 iB = texture(uInkB, uv);
  vec4 a = texture(uInkA, uv) + texture(uFixedA, uv);
  vec3 b = iB.rgb + texture(uFixedB, uv).rgb;

  // Granulation: pigment settles into the valleys of the paper.
  float d0 = a.x;
  float gran = 1.0 + uGranulation * (0.5 - paper.g) * 2.2;
  // Edge darkening from the density gradient keeps fine pen work crisp.
  float l = density(uv - vec2(uTexel.x, 0.0)), r = density(uv + vec2(uTexel.x, 0.0));
  float bt = density(uv - vec2(0.0, uTexel.y)), t = density(uv + vec2(0.0, uTexel.y));
  float edge = min(length(vec2(r - l, t - bt)) / (d0 + 1.0), 1.0);
  float k = mix(gran * (1.0 + uEdgeDarken * edge), 1.0, uFlat);
  a *= k; b *= k;

  vec3 rgb = vec3(0.0);
  float tr;
${displayBasisGLSL()}

  // White gouache sits on top as an opaque layer, a little patchy on the tooth.
  float cov = 1.0 - exp(-2.2 * iB.a);
  cov = clamp(cov * (1.0 + (paper.g - 0.5) * 0.5), 0.0, 1.0);
  vec3 gouache = vec3(0.96, 0.955, 0.94) * (1.0 + 0.1 * (paper.r - 0.5) * uTexture);

  if (uMode == 2){
    // Transparent: the pigment's transmittance over white, unmixed into colour + alpha
    // (exact when the image is laid back over white), then the gouache over that.
    vec3 t = toSRGB(rgb);
    float a1 = 1.0 - min(min(t.r, t.g), t.b);
    vec3 c1 = a1 > 1e-4 ? (t - (1.0 - a1)) / a1 : vec3(0.0);
    vec3 g = toSRGB(gouache);
    float al = cov + a1 * (1.0 - cov);
    vec3 c = al > 1e-4 ? (g * cov + c1 * a1 * (1.0 - cov)) / al : vec3(0.0);
    o = vec4(c, al);   // straight alpha, as ImageData wants it
    return;
  }

  // Paper: the sheet's tint, lit relief, fibre mottling and flecks (linear light).
  vec3 paperCol = paperColour(paper, uMode == 3 ? vec3(1.0) : uPaperTint);
  // On screen, a reference image shows through the paper, under the paint.
  if (uMode == 0 && uRefOpacity > 0.0){
    vec2 ruv = (uv - uRefRect.xy) / uRefRect.zw;
    if (ruv.x >= 0.0 && ruv.y >= 0.0 && ruv.x <= 1.0 && ruv.y <= 1.0){
      vec4 r = texture(uRef, ruv);
      vec3 lin = pow(r.rgb, vec3(2.2));
      paperCol = mix(paperCol, lin, r.a * uRefOpacity);
    }
  }
  vec3 col = rgb * paperCol;
  col = mix(col, uMode == 3 ? vec3(1.0) : gouache, cov);

  // Wet paper reads darker and slightly cool.
  float ws = uMode == 3 ? 0.0 : smoothstep(0.02, 0.7, texture(uWet, uv).x) * (1.0 - uFlat);
  col *= vec3(1.0) - ws * vec3(0.12, 0.11, 0.08);

  // On screen, the cut edge of the sheet catches a faint shade, so it reads as a thin card.
  if (uShadow > 0.0){
    float inside = -sheetDist(gl_FragCoord.xy, 0.0);
    col *= mix(0.9, 1.0, smoothstep(0.0, 1.5 * uDpr, inside));
  }

  o = vec4(toSRGB(col), 1.0);
}`;
