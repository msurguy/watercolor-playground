/** Smoothing for noisy landmark streams. */

const alpha = (dt: number, cutoff: number) => {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

/**
 * One Euro filter (Casiez et al.): heavy smoothing while the value rests, light smoothing
 * while it moves fast, so a still hand does not jitter and a sweep does not lag.
 */
export class OneEuro {
  private x: number | null = null;
  private dx = 0;
  private t = 0;

  constructor(private minCutoff = 1.2, private beta = 0.02, private dCutoff = 1.0) {}

  reset() { this.x = null; this.dx = 0; }

  /** `t` in ms. */
  filter(v: number, t: number): number {
    if (this.x === null) { this.x = v; this.t = t; return v; }
    const dt = Math.max((t - this.t) / 1000, 1e-3);
    this.t = t;
    const rate = (v - this.x) / dt;
    this.dx += (rate - this.dx) * alpha(dt, this.dCutoff);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += (v - this.x) * alpha(dt, cutoff);
    return this.x;
  }
}

/** Exponential moving average. */
export class Ema {
  private v: number | null = null;
  constructor(private a: number) {}
  reset() { this.v = null; }
  update(x: number): number {
    this.v = this.v === null ? x : this.v + (x - this.v) * this.a;
    return this.v;
  }
}

/**
 * A boolean with two thresholds and a frame count: turns on once the value has been below
 * `enter` for `frames` frames, off once it has been above `exit` for as many. Between the
 * two it keeps its state.
 */
export class Hysteresis {
  private on = false;
  private run = 0;

  constructor(private enter: number, private exit: number, private frames = 2) {}

  reset() { this.on = false; this.run = 0; }

  update(v: number): boolean {
    const want = this.on ? !(v > this.exit) : v < this.enter;
    if (want !== this.on) {
      if (++this.run >= this.frames) { this.on = want; this.run = 0; }
    } else {
      this.run = 0;
    }
    return this.on;
  }
}
