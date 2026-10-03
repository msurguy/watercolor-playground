import { pigmentFromHex, WHITE_GOUACHE, type Pigment } from './engine/spectral';

export interface PaletteEntry {
  name: string;
  /** Masstone: the colour at full strength on white paper. */
  hex: string;
  pigment: Pigment;
}

const entry = (name: string, hex: string): PaletteEntry => ({ name, hex, pigment: pigmentFromHex(hex) });

/** A small split-primary watercolour palette plus earths, neutrals and white gouache. */
export const PALETTE: PaletteEntry[] = [
  entry('Hansa Yellow', '#f6d409'),
  entry('New Gamboge', '#f0a202'),
  entry('Pyrrol Scarlet', '#e0301e'),
  entry('Quinacridone Rose', '#d0306a'),
  entry('Dioxazine Violet', '#4b2c7a'),
  entry('French Ultramarine', '#2338a8'),
  entry('Phthalo Blue', '#0e5a9c'),
  entry('Phthalo Green', '#0b6e5a'),
  entry('Sap Green', '#4f7d2a'),
  entry('Yellow Ochre', '#c8902e'),
  entry('Burnt Sienna', '#a0522d'),
  entry('Burnt Umber', '#5c3a21'),
  entry("Payne's Grey", '#3b4552'),
  entry('Lamp Black', '#1b1b1f'),
  { name: 'White Gouache', hex: '#f7f5ef', pigment: WHITE_GOUACHE },
];

export const customEntry = (hex: string): PaletteEntry => entry('Custom', hex);
