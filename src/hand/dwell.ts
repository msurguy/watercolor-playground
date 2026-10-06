import type { HandRect } from './types';

/** Controls the hand can rest on. Hidden panels are not hit, and disabled buttons are skipped. */
const TARGETS = '.panel button:not(:disabled), .panel label.slider';

export interface DwellFire { kind: 'button' | 'slider'; el: HTMLElement }
export interface DwellResult { progress: number; rect: HandRect | null; fired: DwellFire | null }

export const toRect = (r: DOMRect): HandRect => ({ left: r.left, top: r.top, width: r.width, height: r.height });

/** The range input of a slider row, if it can be adjusted. */
export const sliderInput = (row: HTMLElement): HTMLInputElement | null => {
  const input = row.querySelector<HTMLInputElement>('input[type=range]');
  return input && !input.disabled ? input : null;
};

/**
 * Hover-to-activate: resting the cursor on a control for `ms` fires it once. Moving to another
 * control restarts the timer; staying on the same one after it fired does nothing more, so a
 * long rest on Undo undoes once.
 */
export class Dwell {
  private current: HTMLElement | null = null;
  private since = 0;
  private fired = false;

  constructor(private ms: number) {}

  reset() { this.current = null; this.fired = false; }

  /** `t` in ms. */
  update(x: number, y: number, t: number): DwellResult {
    let el = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest<HTMLElement>(TARGETS) ?? null;
    const slider = !!el && el.matches('label.slider');
    if (slider && !sliderInput(el!)) el = null;
    if (el !== this.current) { this.current = el; this.since = t; this.fired = false; }
    if (!el) return { progress: 0, rect: null, fired: null };
    const progress = Math.min(1, (t - this.since) / this.ms);
    const rect = toRect(el.getBoundingClientRect());
    if (progress >= 1 && !this.fired) {
      this.fired = true;
      return { progress, rect, fired: { kind: slider ? 'slider' : 'button', el } };
    }
    return { progress, rect, fired: null };
  }
}
