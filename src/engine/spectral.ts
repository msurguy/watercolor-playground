import { BASIS, DISPLAY_BANDS, DISPLAY_RGB_WEIGHTS, PRIMARIES, SPECTRAL_EPSILON } from './spectralData';

/** Number of absorbance coefficients stored per texel. */
export const COEFFS = 7;

/**
 * A pigment: 7 absorbance coefficients for its masstone at concentration 1,
 * plus white-gouache coverage (opaque, sits on top rather than absorbing).
 */
export interface Pigment {
  coeffs: Float32Array;
  white: number;
}

const uncompand = (x: number) => (x < 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
const compand = (x: number) => (x < 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

export function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex([r, g, b]: readonly number[]): string {
  const to = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0');
  return `#${to(r)}${to(g)}${to(b)}`;
}

/** spectral.js upsampling: sRGB -> 38-band reflectance curve. */
function reflectance(srgb: readonly number[]): number[] {
  let [r, g, b] = srgb.map(uncompand);
  const w = Math.min(r, g, b);
  r -= w; g -= w; b -= w;
  const c = Math.min(g, b), m = Math.min(r, b), y = Math.min(r, g);
  const rr = Math.min(Math.max(0, r - b), Math.max(0, r - g));
  const gg = Math.min(Math.max(0, g - b), Math.max(0, g - r));
  const bb = Math.min(Math.max(0, b - g), Math.max(0, b - r));
  return PRIMARIES.map(k =>
    Math.max(SPECTRAL_EPSILON, w + c * k[0] + m * k[1] + y * k[2] + rr * k[3] + gg * k[4] + bb * k[5]));
}

/** A transparent pigment whose masstone (concentration 1 on white paper) is `hex`. */
export function pigmentFromHex(hex: string): Pigment {
  const absorbance = reflectance(hexToRgb(hex)).map(v => -Math.log(v));
  const coeffs = new Float32Array(COEFFS);
  for (let k = 0; k < COEFFS; k++) {
    let s = 0;
    for (let i = 0; i < absorbance.length; i++) s += BASIS[k][i] * absorbance[i];
    coeffs[k] = s;
  }
  return { coeffs, white: 0 };
}

export const WHITE_GOUACHE: Pigment = { coeffs: new Float32Array(COEFFS), white: 1 };

/**
 * CPU mirror of the display shader's colour reconstruction (without paper texture):
 * linear sRGB of a layer holding `coeffs` absorbance over white paper.
 */
export function coeffsToLinear(coeffs: ArrayLike<number>): [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  DISPLAY_BANDS.forEach((band, i) => {
    let a = 0;
    for (let k = 0; k < COEFFS; k++) a += coeffs[k] * BASIS[k][band];
    const t = Math.exp(-Math.max(a, 0));
    for (let j = 0; j < 3; j++) out[j] += t * DISPLAY_RGB_WEIGHTS[i][j];
  });
  return out;
}

export function coeffsToHex(coeffs: ArrayLike<number>): string {
  return rgbToHex(coeffsToLinear(coeffs).map(v => compand(clamp01(v))));
}

/** Pigments mixed (or glazed) at the given concentrations, as a CSS colour. */
export function mixToHex(parts: { pigment: Pigment; amount: number }[]): string {
  const sum = new Float32Array(COEFFS);
  for (const { pigment, amount } of parts)
    for (let k = 0; k < COEFFS; k++) sum[k] += pigment.coeffs[k] * amount;
  return coeffsToHex(sum);
}

/** Basis value at the display bands, laid out for the shader: vec4 + vec3 per band. */
export function displayBasisGLSL(): string {
  const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : v.toPrecision(7));
  const lines: string[] = [];
  DISPLAY_BANDS.forEach((band, i) => {
    const b = BASIS.map(v => v[band]);
    const w = DISPLAY_RGB_WEIGHTS[i];
    lines.push(
      `  tr = exp(-max(dot(a, vec4(${b.slice(0, 4).map(f).join(',')})) + dot(b, vec3(${b.slice(4, 7).map(f).join(',')})), 0.0));\n` +
      `  rgb += tr * vec3(${w.map(f).join(',')});`);
  });
  return lines.join('\n');
}
