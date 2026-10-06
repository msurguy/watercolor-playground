import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import { Dwell, sliderInput, toRect } from './dwell';
import { Ema, Hysteresis, OneEuro } from './filter';
import { HandTracker, type Frame } from './tracker';
import { HAND_IDLE, type HandHost, type HandRect } from './types';

/** Rest on a control this long to press it. */
const DWELL_MS = 1500;
/** Pressure of every hand stroke (there is no stylus to read it from). */
const PRESSURE = 0.6;
/** The part of the camera frame that maps to the whole screen, so the corners need no reaching. */
const BOX_LO = 0.15, BOX_HI = 0.85;
/** How long the cursor stays where it was once the hand is lost. */
const LOST_MS = 150;
/** Pinch thresholds on thumb-tip to index-tip distance over palm size (wrist to middle knuckle). */
const PINCH_ENTER = 0.35, PINCH_EXIT = 0.5;
/** How far up or down the hand may wander while sliding before the slider is let go, in row heights. */
const GRAB_LEEWAY = 2.5;

const THUMB_TIP = 4, INDEX_TIP = 8, WRIST = 0, MIDDLE_MCP = 9;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

interface Grab { input: HTMLInputElement; track: HandRect; row: HandRect; last: number }

/**
 * Paints and operates the UI from camera hand landmarks: the midpoint of thumb and index
 * tip is the cursor, a pinch is the brush on the paper, resting on a control presses it,
 * and resting on a slider grabs it so sideways motion sets its value.
 */
export class HandMode {
  private readonly tracker: HandTracker;
  private readonly fx = new OneEuro();
  private readonly fy = new OneEuro();
  private readonly pinchRatio = new Ema(0.5);
  private readonly pinch = new Hysteresis(PINCH_ENTER, PINCH_EXIT);
  private readonly dwell = new Dwell(DWELL_MS);
  private mode: 'idle' | 'paint' | 'grab' = 'idle';
  private grab: Grab | null = null;
  private wasPinching = false;
  private seenAt = -Infinity;
  private stopped = false;

  constructor(private host: HandHost) {
    this.tracker = new HandTracker(f => this.onFrame(f), s => host.setStream(s));
  }

  async start(): Promise<void> {
    document.addEventListener('visibilitychange', this.onVisibility);
    try {
      await this.tracker.start();
    } catch (e) {
      this.stop();
      throw e;
    }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.endStroke();
    this.tracker.stop();
    this.host.setStream(null);
    this.host.setCursor(HAND_IDLE);
  }

  /** Feed a frame by hand (tests, no camera): 21 landmarks in camera space, or null for "no hand". */
  inject(landmarks: NormalizedLandmark[] | null, t = performance.now(), aspect = 4 / 3) {
    this.onFrame({ landmarks, t, aspect });
  }

  private onVisibility = () => {
    if (document.visibilityState !== 'hidden') return;
    this.rest();
    this.fx.reset(); this.fy.reset(); this.pinchRatio.reset(); this.pinch.reset();
    this.seenAt = -Infinity;
    this.host.setCursor(HAND_IDLE);
  };

  /** Let go of everything: the stroke, the slider, the dwell. */
  private rest() {
    this.endStroke();
    this.releaseGrab();
    this.dwell.reset();
    this.mode = 'idle';
    this.wasPinching = false;
  }

  private endStroke() {
    if (this.host.engine.scripting) this.host.engine.scriptEnd();
    if (this.mode === 'paint') this.mode = 'idle';
  }

  private releaseGrab() {
    const g = this.grab;
    if (!g) return;
    this.grab = null;
    // sliders that record an undo step per adjustment listen for `change`
    g.input.dispatchEvent(new Event('change', { bubbles: true }));
    if (this.mode === 'grab') this.mode = 'idle';
  }

  private onFrame(f: Frame) {
    if (this.stopped) return;
    const lm = f.landmarks;
    if (!lm) {
      if (f.t - this.seenAt > LOST_MS) {
        this.rest();
        this.host.setCursor(HAND_IDLE);
      }
      return;
    }
    this.seenAt = f.t;

    // the cursor: between thumb and index tip, mirrored, the middle of the frame spread over the screen
    const px = (lm[THUMB_TIP].x + lm[INDEX_TIP].x) / 2, py = (lm[THUMB_TIP].y + lm[INDEX_TIP].y) / 2;
    const u = this.fx.filter(1 - px, f.t), v = this.fy.filter(py, f.t);
    const x = clamp((u - BOX_LO) / (BOX_HI - BOX_LO), 0, 1) * window.innerWidth;
    const y = clamp((v - BOX_LO) / (BOX_HI - BOX_LO), 0, 1) * window.innerHeight;

    // the pinch: tip distance relative to the palm, so it works at any distance from the camera
    const d = (i: number, j: number) => Math.hypot((lm[i].x - lm[j].x) * f.aspect, lm[i].y - lm[j].y);
    const ratio = this.pinchRatio.update(d(THUMB_TIP, INDEX_TIP) / Math.max(d(WRIST, MIDDLE_MCP), 1e-3));
    const pinching = this.pinch.update(ratio);
    const rose = pinching && !this.wasPinching, fell = !pinching && this.wasPinching;
    this.wasPinching = pinching;

    let dwell = 0, target: HandRect | null = null;
    const engine = this.host.engine;

    if (this.mode === 'paint') {
      if (fell) {
        engine.scriptEnd();
        this.mode = 'idle';
      } else if (pinching) {
        const [dx, dy] = engine.clientToDoc(x, y);
        if (!engine.scriptMove(dx, dy, PRESSURE, f.t)) this.mode = 'idle';   // undone or cleared under us
      } else {
        this.mode = 'idle';
      }
    } else if (this.mode === 'grab') {
      const g = this.grab!;
      const rowMid = g.row.top + g.row.height / 2;
      if (pinching || Math.abs(y - rowMid) > GRAB_LEEWAY * g.row.height) {
        this.releaseGrab();
        this.dwell.reset();
      } else {
        this.slide(g, x);
        target = g.row;
      }
    }

    if (this.mode === 'idle') {
      if (pinching) {
        // a pinch over the paper starts a stroke; over a panel it is ignored (dwell is the way to press things)
        const tool = this.host.paintTool();
        const overUi = !!document.elementFromPoint(x, y)?.closest('.panel');
        if (tool && !overUi && (rose || this.wasPinching)) {
          const [dx, dy] = engine.clientToDoc(x, y);
          if (engine.scriptBegin(tool, dx, dy, PRESSURE, 'Hand stroke')) this.mode = 'paint';
          // else a pointer stroke is still on the paper: try again next frame
        }
        this.dwell.reset();
      } else {
        const r = this.dwell.update(x, y, f.t);
        dwell = r.progress; target = r.rect;
        if (r.fired?.kind === 'button') {
          r.fired.el.click();
          if (this.stopped) return;             // the hand pressed "Off"
        } else if (r.fired?.kind === 'slider') {
          const input = sliderInput(r.fired.el);
          if (input) {
            this.grab = { input, track: toRect(input.getBoundingClientRect()), row: r.rect!, last: Number(input.value) };
            this.mode = 'grab';
            this.slide(this.grab, x);
          }
        }
      }
    }

    this.host.setCursor({
      visible: true, x, y, pinching, painting: this.mode === 'paint', dwell, target,
      grab: this.mode === 'grab' ? this.grab!.row : null,
    });
  }

  /** Set a grabbed slider from the cursor's position along its track. */
  private slide(g: Grab, x: number) {
    const input = g.input;
    const min = Number(input.min) || 0, max = input.max === '' ? 1 : Number(input.max), step = Number(input.step) || 0.01;
    const f = clamp((x - g.track.left) / Math.max(g.track.width, 1), 0, 1);
    const v = clamp(min + Math.round((f * (max - min)) / step) * step, min, max);
    if (Math.abs(v - g.last) < step / 2) return;
    g.last = v;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
}
