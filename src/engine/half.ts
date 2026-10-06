// IEEE 754 binary16 <-> binary32, for moving half-float textures through the CPU.

const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);

/** One float -> half, round to nearest even; overflow -> Inf, NaN kept. */
export function toHalf(v: number): number {
  f32[0] = v;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let exp = (x >>> 23) & 0xff;
  let mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);   // Inf / NaN
  const e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;                             // overflow
  if (e <= 0) {
    if (e < -10) return sign;                                      // underflow to zero
    mant |= 0x800000;                                              // subnormal half
    const shift = 14 - e;
    let h = mant >>> shift;
    const rem = mant & ((1 << shift) - 1), half = 1 << (shift - 1);
    if (rem > half || (rem === half && (h & 1))) h++;
    return sign | h;
  }
  let h = (e << 10) | (mant >>> 13);
  const rem = mant & 0x1fff;
  if (rem > 0x1000 || (rem === 0x1000 && (h & 1))) h++;            // may carry into the exponent: that is correct rounding
  return sign | h;
}

/** One half -> float. */
export function fromHalf(h: number): number {
  const sign = (h & 0x8000) ? -1 : 1;
  const exp = (h >>> 10) & 0x1f, mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 0x1f) return mant ? NaN : sign * Infinity;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

export function f32ToF16(src: Float32Array, dst: Uint16Array, n = src.length): void {
  for (let i = 0; i < n; i++) dst[i] = toHalf(src[i]);
}

export function f16ToF32(src: Uint16Array, dst: Float32Array, n = src.length): void {
  for (let i = 0; i < n; i++) dst[i] = fromHalf(src[i]);
}
