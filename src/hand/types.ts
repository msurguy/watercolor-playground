import type { Tool, WatercolorEngine } from '../engine/Engine';

export type HandStatus = 'off' | 'loading' | 'on' | 'error';

/** A screen rectangle in client px (a plain object, so it can live in a signal). */
export interface HandRect { left: number; top: number; width: number; height: number }

/** Where the hand is and what it is doing, for the overlay. */
export interface HandCursor {
  visible: boolean;
  /** Client px. */
  x: number; y: number;
  pinching: boolean;
  /** A scripted stroke is open. */
  painting: boolean;
  /** 0..1 progress of the dwell on the hovered control. */
  dwell: number;
  /** The hovered control. */
  target: HandRect | null;
  /** The slider row being slid. */
  grab: HandRect | null;
}

export const HAND_IDLE: HandCursor = { visible: false, x: 0, y: 0, pinching: false, painting: false, dwell: 0, target: null, grab: null };

/** What the hand mode needs from the app. The store satisfies it, so the store keeps owning the engine. */
export interface HandHost {
  engine: WatercolorEngine;
  /** The engine tool to paint with, or null while painting is not allowed (panel tool active, reference being moved). */
  paintTool(): Tool | null;
  setCursor(c: HandCursor): void;
  setStream(s: MediaStream | null): void;
}
