import { displayBasisGLSL } from './spectral';

// Texture layout
//   velocity  RG16F  (sim grid)       water flow, in sim texels / second
//   wet       R16F   (document grid)  standing water on the paper
//   ink       2 × RGBA16F (document)   mobile pigment: A = absorbance coeffs 0..3,
//                                      B.rgb = coeffs 4..6, B.a = white gouache
//   fixed     2 × RGBA16F (document)   pigment settled into the paper (no white)
//   paper     RGBA8  (document)        r = lit relief, g = height, b = fibre

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

// Cold-press paper, generated once per document.
export const paperFS = `${HEADER}
out vec4 o;
uniform vec2 uRes;
uniform float uSeed;
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21) + uSeed); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
// texel-scale features; scaled so the grain looks the same at any document size
float height(vec2 px){
  float s = 1100.0 / uRes.y;
  return fbm(px * 0.11 * s) * 0.7 + vnoise(px * 0.45 * s) * 0.3;
}
void main(){
  vec2 px = vUv * uRes;
  float h = height(px);
  float hx = height(px + vec2(1.0, 0.0)), hy = height(px + vec2(0.0, 1.0));
  vec3 n = normalize(vec3((h - hx) * 2.2, (h - hy) * 2.2, 1.0));
  float lit = clamp(0.88 + 0.5 * dot(n, normalize(vec3(-0.5, 0.6, 0.62))) - 0.38, 0.0, 1.0);
  float fibre = fbm(px * 0.012 * 1100.0 / uRes.y + 5.3);
  o = vec4(lit, h, fibre, 1.0);
}`;

/** Final composite: spectral reconstruction of pigment on paper. */
export const displayFS = `${HEADER}
out vec4 o;
uniform sampler2D uInkA, uInkB, uFixedA, uFixedB, uWet, uPaper;
uniform vec4 uView;       // canvas px -> document uv: uv = (fragCoord - xy) / zw
uniform vec2 uTexel;      // document texel size
uniform float uGranulation, uEdgeDarken;
uniform vec3 uDesk;

vec3 toSRGB(vec3 c){
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float density(vec2 uv){ return texture(uInkA, uv).x + texture(uFixedA, uv).x; }

void main(){
  vec2 uv = (gl_FragCoord.xy - uView.xy) / uView.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0){ o = vec4(uDesk, 1.0); return; }

  vec4 paper = texture(uPaper, uv);
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
  float k = gran * (1.0 + uEdgeDarken * edge);
  a *= k; b *= k;

  vec3 rgb = vec3(0.0);
  float tr;
${displayBasisGLSL()}

  // Paper: warm white, lit relief, faint fibre mottling (linear light).
  vec3 paperCol = vec3(0.925, 0.905, 0.855) * (0.93 + 0.1 * paper.r) * (0.985 + 0.03 * paper.b);
  vec3 col = rgb * paperCol;

  // White gouache sits on top as an opaque layer, a little patchy on the tooth.
  float cov = 1.0 - exp(-2.2 * iB.a);
  cov = clamp(cov * (1.0 + (paper.g - 0.5) * 0.5), 0.0, 1.0);
  col = mix(col, vec3(0.96, 0.955, 0.94) * (0.96 + 0.05 * paper.r), cov);

  // Wet paper reads darker and slightly cool.
  float ws = smoothstep(0.02, 0.7, texture(uWet, uv).x);
  col *= vec3(1.0) - ws * vec3(0.12, 0.11, 0.08);

  o = vec4(toSRGB(col), 1.0);
}`;
