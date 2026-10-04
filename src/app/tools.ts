import type { ReadonlySignal } from '@preact/signals';
import type { JSX } from 'preact';
import type { WatercolorEngine } from '../engine/Engine';

// Panel tools (text, shape, fill, ...) have their own panel and drive the engine
// themselves while active. Each is a store class implementing PanelTool, plus a
// panel component; `app/registry.ts` lists them. Adding a tool is one folder and
// one registry entry.

/** Pointer events on the paper, forwarded to the active panel tool by <Paper/>. `uv` is document space. */
export interface PaperGesture {
  down?(e: PointerEvent, uv: [number, number]): void;
  move?(e: PointerEvent, uv: [number, number]): void;
  up?(e: PointerEvent, uv: [number, number]): void;
  cancel?(e: PointerEvent): void;
  /** The pointer left the paper (moved onto a panel or off the window). */
  leave?(): void;
}

export interface PanelTool {
  readonly id: string;
  readonly active: ReadonlySignal<boolean>;
  /** Drawing / filling in progress. */
  readonly busy: ReadonlySignal<boolean>;
  activate(): void;
  deactivate(): void;
  /** Stop whatever is in progress. Returns whether anything was stopped. */
  stop(): boolean;
  readonly gesture?: PaperGesture;
}

export interface ToolContext {
  engine: WatercolorEngine;
}

export interface PanelToolDef<T extends PanelTool = PanelTool> {
  id: string;
  label: string;
  /** Keyboard shortcut (single letter). */
  key: string;
  hint: string;
  /** Icon name (see ui/Icon.tsx). */
  icon: string;
  create(ctx: ToolContext): T;
  Panel: (props: { tool: T }) => JSX.Element;
}

/** Erases the store type so differently typed tools fit one registry array. */
export const defineTool = <T extends PanelTool>(d: PanelToolDef<T>) => d as unknown as PanelToolDef;
