// The .wcp project file: one binary with a JSON header and compressed layer blobs.
//
//   0    8   magic "WCPROJ\0\0"
//   8    4   u32 format version
//   12   4   u32 header length
//   16   n   header JSON (UTF-8)
//   then, per blob in header.blobs order: u32 stored length, u32 raw length, payload
//
// Everything little-endian. Layers are half floats (see Engine.WholeDoc), deflated with
// the browser's CompressionStream when it has one; images are PNG as they are.

import type { LayerId, Params, RefRect } from '../engine/Engine';
import type { Rect } from '../engine/gl';
import type { Stored } from '../ui/customBrushes';

export const PROJECT_EXT = 'wcp';
export const FORMAT_VERSION = 1;
const MAGIC = [0x57, 0x43, 0x50, 0x52, 0x4f, 0x4a, 0x00, 0x00];   // "WCPROJ\0\0"
const LAYERS: LayerId[] = ['inkA', 'inkB', 'fixedA', 'fixedB', 'wet'];
const CHANNELS: Record<LayerId, 1 | 4> = { inkA: 4, inkB: 4, fixedA: 4, fixedB: 4, wet: 1 };

export const isProjectFile = (f: File) => new RegExp(`\\.${PROJECT_EXT}$`, 'i').test(f.name);

type Codec = 'deflate-raw' | 'none';
export interface BlobEntry { id: LayerId | 'ref' | 'thumb'; codec: Codec; dtype: 'f16' | 'png'; channels?: 1 | 4; w?: number; h?: number }

export interface ProjectHeader {
  app: 'watercolor';
  version: number;
  created: string;
  doc: { w: number; h: number; sizePreset: string };
  paper: { id: string; seed: number; origin: [number, number]; scale: number; strength: number };
  paint: { rect: Rect | null; wetAgo: number; wetPeak: number; active: Rect | null; painted: Rect | null };
  reference: null | { rect: RefRect; opacity: number; visible: boolean; forFill: boolean };
  tool: { params: Params; hex: string; brushId: string };
  /** Custom brush tips the painting needs (the current one, if custom). */
  brushes: Stored[];
  view: { zoom: number; pan: [number, number]; fitted: boolean } | null;
  blobs: BlobEntry[];
}

export interface ProjectData {
  header: ProjectHeader;
  layers: Record<LayerId, Uint16Array>;
  reference: Blob | null;
  thumbnail: Blob | null;
}

const hasCompression = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';

const u32 = (n: number) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };

async function deflate(bytes: Uint8Array): Promise<Blob> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return new Response(stream).blob();
}

async function inflate(part: Blob, rawLen: number): Promise<Uint8Array> {
  const stream = part.stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (out.length !== rawLen) throw new Error('This project file is damaged.');
  return out;
}

/** Build the file. `header.blobs` is filled in here. */
export async function writeProject(p: ProjectData): Promise<Blob> {
  const blobs: BlobEntry[] = [];
  const parts: BlobPart[] = [];
  const add = async (entry: BlobEntry, raw: Uint8Array | Blob) => {
    const rawLen = raw instanceof Blob ? raw.size : raw.byteLength;
    let stored: Blob;
    if (entry.codec === 'deflate-raw' && hasCompression && raw instanceof Uint8Array) stored = await deflate(raw);
    else { entry.codec = 'none'; stored = raw instanceof Blob ? raw : new Blob([raw as BlobPart]); }
    blobs.push(entry);
    parts.push(u32(stored.size), u32(rawLen), stored);
  };
  const r = p.header.paint.rect;
  const cw = r ? r.x1 - r.x0 : 0, ch = r ? r.y1 - r.y0 : 0;
  for (const id of LAYERS) {
    const data = p.layers[id];
    if (data.length !== cw * ch * CHANNELS[id]) throw new Error(`layer ${id} does not match its rect`);
    await add({ id, codec: 'deflate-raw', dtype: 'f16', channels: CHANNELS[id], w: cw, h: ch },
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  }
  if (p.reference) await add({ id: 'ref', codec: 'none', dtype: 'png' }, p.reference);
  if (p.thumbnail) await add({ id: 'thumb', codec: 'none', dtype: 'png' }, p.thumbnail);
  const header = new TextEncoder().encode(JSON.stringify({ ...p.header, blobs }));
  return new Blob([new Uint8Array(MAGIC), u32(FORMAT_VERSION), u32(header.byteLength), header, ...parts], { type: 'application/octet-stream' });
}

/** Read a file written by `writeProject`. Throws an Error with a message fit for a toast. */
export async function readProject(file: Blob): Promise<ProjectData> {
  const bad = (why = 'This is not a watercolor project file.') => new Error(why);
  if (file.size < 16) throw bad();
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  if (MAGIC.some((b, i) => head[i] !== b)) throw bad();
  const dv = new DataView(head.buffer);
  const version = dv.getUint32(8, true), headerLen = dv.getUint32(12, true);
  if (version > FORMAT_VERSION) throw bad('This project was saved by a newer version of the app.');
  if (16 + headerLen > file.size) throw bad('This project file is damaged.');
  let header: ProjectHeader;
  try { header = JSON.parse(new TextDecoder().decode(await file.slice(16, 16 + headerLen).arrayBuffer())) as ProjectHeader; }
  catch { throw bad('This project file is damaged.'); }
  if (header.app !== 'watercolor' || !Array.isArray(header.blobs) || !header.doc || !header.paper || !header.paint) throw bad('This project file is damaged.');

  const layers = {} as Record<LayerId, Uint16Array>;
  let reference: Blob | null = null, thumbnail: Blob | null = null;
  let pos = 16 + headerLen;
  for (const entry of header.blobs) {
    if (pos + 8 > file.size) throw bad('This project file is damaged.');
    const lens = new DataView(await file.slice(pos, pos + 8).arrayBuffer());
    const storedLen = lens.getUint32(0, true), rawLen = lens.getUint32(4, true);
    pos += 8;
    if (pos + storedLen > file.size) throw bad('This project file is damaged.');
    const part = file.slice(pos, pos + storedLen);
    pos += storedLen;
    if (entry.dtype === 'png') {
      const blob = part.slice(0, part.size, 'image/png');
      if (entry.id === 'ref') reference = blob; else if (entry.id === 'thumb') thumbnail = blob;
      continue;
    }
    if (!LAYERS.includes(entry.id as LayerId)) continue;
    let bytes: Uint8Array;
    if (entry.codec === 'none') bytes = new Uint8Array(await part.arrayBuffer());
    else if (hasCompression) bytes = await inflate(part, rawLen);
    else throw bad('This browser cannot open compressed projects.');
    const id = entry.id as LayerId;
    const expect = (entry.w ?? 0) * (entry.h ?? 0) * CHANNELS[id] * 2;
    if (bytes.byteLength !== rawLen || rawLen !== expect) throw bad('This project file is damaged.');
    layers[id] = new Uint16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
  }
  const r = header.paint.rect;
  const cw = r ? r.x1 - r.x0 : 0, ch = r ? r.y1 - r.y0 : 0;
  for (const id of LAYERS) {
    layers[id] ??= new Uint16Array(0);
    if (layers[id].length !== cw * ch * CHANNELS[id]) throw bad('This project file is damaged.');
  }
  return { header, layers, reference, thumbnail };
}
