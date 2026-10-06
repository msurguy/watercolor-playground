// Paper presets. Each picks one of the procedural height fields in paperFieldFS (`kind`)
// and says how the sheet looks: its colour, inclusions, how strongly the relief is lit
// and how cloudy the fibre formation is. The height also decides where pigment
// granulates and what a dry brush skips, so a paper changes how paint behaves too.

export interface PaperPreset {
  id: string;
  name: string;
  hint: string;
  /** Which height field the paper shader builds (see paperFieldFS). */
  kind: number;
  /** Sheet colour (sRGB). */
  tint: string;
  /** Colour of dark specks and inclusions (sRGB). */
  fleck: string;
  /** How strongly the relief is lit. */
  bump: number;
  /** Cloudiness of the sheet: uneven fibre formation, felt marks. */
  mottle: number;
}

export const PAPERS: PaperPreset[] = [
  { id: 'cold', name: 'Cold Press', hint: 'Medium tooth, natural white: the all-round watercolour sheet', kind: 0, tint: '#f6f3ec', fleck: '#8a8070', bump: 1.0, mottle: 0.05 },
  { id: 'hot', name: 'Hot Press', hint: 'Pressed smooth and bright: crisp edges, little granulation', kind: 1, tint: '#f8f7f3', fleck: '#8a8478', bump: 0.6, mottle: 0.04 },
  { id: 'rough', name: 'Rough', hint: 'Deep, knobbly tooth: dry brush breaks up, pigment pools in the hollows', kind: 2, tint: '#f5f1e8', fleck: '#857a68', bump: 0.8, mottle: 0.06 },
  { id: 'khadi', name: 'Khadi', hint: 'Handmade cotton rag: lumpy, cream, with fibres and specks', kind: 3, tint: '#efe7d6', fleck: '#6d5f4a', bump: 1.0, mottle: 0.12 },
  { id: 'washi', name: 'Washi', hint: 'Japanese kozo: smooth, cloudy, with long silky fibres', kind: 4, tint: '#f1ece0', fleck: '#7a6a52', bump: 0.8, mottle: 0.14 },
  { id: 'laid', name: 'Laid', hint: 'Ingres-style laid lines with chain lines every inch', kind: 5, tint: '#f2ebdb', fleck: '#8a7c64', bump: 1.0, mottle: 0.05 },
  { id: 'canvas', name: 'Canvas', hint: 'Primed cotton canvas board: a fine plain weave', kind: 6, tint: '#f3efe6', fleck: '#8a8070', bump: 1.0, mottle: 0.04 },
  { id: 'toned', name: 'Toned Sand', hint: 'Mi-Teintes-style honeycomb tooth on a warm tan sheet', kind: 7, tint: '#d9c8a6', fleck: '#6e5f45', bump: 1.0, mottle: 0.06 },
  { id: 'kraft', name: 'Kraft', hint: 'Recycled brown kraft: smooth, streaky, flecked', kind: 8, tint: '#b99872', fleck: '#4e3b28', bump: 0.8, mottle: 0.12 },
  { id: 'cellulose', name: 'Student', hint: 'Wood-pulp student paper: a regular machine-pressed texture', kind: 9, tint: '#f7f7f4', fleck: '#8a8a84', bump: 1.0, mottle: 0.03 },
];

export const DEFAULT_PAPER = PAPERS[0];

/** sRGB hex -> linear RGB, as the display shader mixes in linear light. */
export function linearRGB(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return [f((n >> 16) & 255), f((n >> 8) & 255), f(n & 255)];
}

/** Sheet sizes in pixels (landscape; the orientation switch turns them). `screen` follows the window. */
export interface PaperSize { id: string; name: string; w: number; h: number; hint: string }

export const PAPER_SIZES: PaperSize[] = [
  { id: 'screen', name: 'Screen', w: 0, h: 0, hint: 'The shape of this window' },
  { id: 'square', name: 'Square', w: 1600, h: 1600, hint: '1:1' },
  { id: 'postcard', name: 'Postcard', w: 1800, h: 1200, hint: '6 × 4 in at 300 dpi' },
  { id: 'hd', name: 'HD', w: 1920, h: 1080, hint: '16:9 Full HD' },
  { id: 'a', name: 'A-series', w: 2000, h: 1414, hint: 'ISO A shape (√2), like A4' },
  { id: 'letter', name: 'Letter', w: 1980, h: 1530, hint: '11 × 8.5 in shape' },
  { id: 'large', name: 'Large', w: 2400, h: 1600, hint: '3:2, the largest preset' },
  { id: 'custom', name: 'Custom', w: 0, h: 0, hint: 'Any width and height' },
];
