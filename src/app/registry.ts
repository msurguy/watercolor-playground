import type { Tool } from '../engine/Engine';
import { FillPanel } from '../fill/FillPanel';
import { FillStore } from '../fill/FillStore';
import { ShapePanel } from '../shapes/ShapePanel';
import { ShapeStore } from '../shapes/ShapeStore';
import { TextPanel } from '../text/TextPanel';
import { TextStore } from '../text/TextStore';
import { defineTool, type PanelToolDef } from './tools';

/** The engine's own tools, in toolbar order. */
export const ENGINE_TOOLS: { id: Tool; label: string; key: string; hint: string }[] = [
  { id: 'brush', label: 'Brush', key: 'B', hint: 'Wet paint: pigment and water' },
  { id: 'water', label: 'Water', key: 'W', hint: 'Clear water: wets paper, moves paint' },
  { id: 'pen', label: 'Pen', key: 'P', hint: 'Ink line in the current colour' },
  { id: 'lift', label: 'Lift', key: 'L', hint: 'Blot with a tissue: lifts wet paint' },
];

/** Tools with their own panel that drive the engine themselves. To add one, append it here. */
export const PANEL_TOOLS: PanelToolDef[] = [
  defineTool<TextStore>({
    id: 'text', label: 'Text', key: 'T', icon: 'text',
    hint: 'Write a line of text, drawn slowly with the current brush',
    create: ({ engine }) => new TextStore(engine), Panel: TextPanel,
  }),
  defineTool<ShapeStore>({
    id: 'shape', label: 'Shape', key: 'G', icon: 'shape',
    hint: 'Drag a line, arrow, rectangle, ellipse, polygon or star, drawn slowly with the current brush',
    create: ({ engine }) => new ShapeStore(engine), Panel: ShapePanel,
  }),
  defineTool<FillStore>({
    id: 'fill', label: 'Fill', key: 'K', icon: 'fill',
    hint: 'Tap an area to flood it with a wash of the current pigment',
    create: ({ engine }) => new FillStore(engine), Panel: FillPanel,
  }),
];
