import { buildBrush, CUSTOM_BASE, TIP_SIZE, type Brush } from '../engine/brushes';

const KEY = 'watercolor.customBrushes';

interface Stored { id: string; name: string; png: string }

/** Read an image file into tip data: luminance (inverted on a light background) times alpha. */
export async function tipFromImage(file: Blob): Promise<Uint8Array> {
  const bmp = await createImageBitmap(file);
  const n = TIP_SIZE;
  const c = document.createElement('canvas');
  c.width = n; c.height = n;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const s = Math.min(n / bmp.width, n / bmp.height) * 0.96;
  const w = bmp.width * s, h = bmp.height * s;
  ctx.drawImage(bmp, (n - w) / 2, (n - h) / 2, w, h);
  bmp.close?.();
  const d = ctx.getImageData(0, 0, n, n).data;
  // Is the background light? Sample the border of the drawn image.
  let border = 0, count = 0, opaque = 0;
  const x0 = Math.floor((n - w) / 2), y0 = Math.floor((n - h) / 2), x1 = Math.ceil((n + w) / 2) - 1, y1 = Math.ceil((n + h) / 2) - 1;
  const lum = (i: number) => (0.2126 * d[i * 4] + 0.7152 * d[i * 4 + 1] + 0.0722 * d[i * 4 + 2]) / 255;
  for (let x = x0; x <= x1; x++) for (const y of [y0, y1]) { const i = y * n + x; if (d[i * 4 + 3] > 200) { border += lum(i); opaque++; } count++; }
  for (let y = y0; y <= y1; y++) for (const x of [x0, x1]) { const i = y * n + x; if (d[i * 4 + 3] > 200) { border += lum(i); opaque++; } count++; }
  const invert = opaque > count * 0.5 && border / opaque > 0.5;
  const out = new Uint8Array(n * n);
  let max = 0;
  const vals = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    const a = d[i * 4 + 3] / 255;
    const v = a * (invert ? 1 - lum(i) : lum(i));
    vals[i] = v; if (v > max) max = v;
  }
  if (max <= 0) throw new Error('That image is empty.');
  for (let i = 0; i < n * n; i++) out[i] = Math.round((vals[i] / max) * 255);
  return out;
}

export function makeCustomBrush(id: string, name: string, tip: Uint8Array): Brush {
  return buildBrush({ ...CUSTOM_BASE, id, name, hint: 'Imported texture', tip, custom: true });
}

function tipToPng(tip: Uint8Array): string {
  const n = Math.round(Math.sqrt(tip.length));
  const c = document.createElement('canvas');
  c.width = n; c.height = n;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  for (let i = 0; i < n * n; i++) { img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = tip[i]; img.data[i * 4 + 3] = 255; }
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/png');
}

function readStored(): Stored[] {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') as Stored[]; } catch { return []; }
}

/** Persist the set of custom brushes. Fails quietly when storage is full or blocked. */
export function saveCustomBrushes(brushes: Brush[]) {
  try {
    const items: Stored[] = brushes.map(b => ({ id: b.id, name: b.name, png: tipToPng(b.tipData) }));
    localStorage.setItem(KEY, JSON.stringify(items));
    return true;
  } catch { return false; }
}

export async function loadCustomBrushes(): Promise<Brush[]> {
  const out: Brush[] = [];
  for (const s of readStored()) {
    try {
      const blob = await (await fetch(s.png)).blob();
      const bmp = await createImageBitmap(blob);
      const c = document.createElement('canvas');
      c.width = bmp.width; c.height = bmp.height;
      const ctx = c.getContext('2d')!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const tip = new Uint8Array(bmp.width * bmp.height);
      for (let i = 0; i < tip.length; i++) tip[i] = d[i * 4];
      out.push(makeCustomBrush(s.id, s.name, tip));
    } catch { /* skip a corrupt entry */ }
  }
  return out;
}
