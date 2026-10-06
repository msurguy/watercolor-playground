import type { Format, GL, Rect, Target } from './gl';

const TILE = 128;

/** A set of layers snapshotted together, with its own atlas and slot pool. */
class Pool {
  readonly atlas: Target[];
  /** One tile per layer, so undo can swap a tile's content without allocating a slot. */
  readonly scratch: Target[];
  readonly cols: number;
  readonly free: number[] = [];

  constructor(g: GL, tiles: number, formats: Format[]) {
    const maxTex = g.gl.getParameter(g.gl.MAX_TEXTURE_SIZE) as number;
    this.cols = Math.min(tiles, Math.floor(maxTex / TILE));
    const rows = Math.ceil(tiles / this.cols);
    // one single-attachment atlas per layer, so blits stay 1:1
    this.atlas = formats.map(f => g.target(this.cols * TILE, rows * TILE, [f], g.gl.NEAREST));
    this.scratch = formats.map(f => g.target(TILE, TILE, [f], g.gl.NEAREST));
    for (let i = tiles - 1; i >= 0; i--) this.free.push(i);
  }

  dispose(g: GL) { [...this.atlas, ...this.scratch].forEach(t => g.disposeTarget(t)); }
}

export type StepKind = 'stroke' | 'fill' | 'script' | 'dry' | 'clear' | 'resize' | 'paper' | 'reference';

/** What a step was, for the history list. */
export interface StepInfo { kind: StepKind; label: string }

interface Step extends StepInfo {
  /** per pool: tile index -> atlas slot holding that tile's content from before the step */
  tiles: Map<number, number>[];
  /** opaque engine state captured when the step began (wetness clock etc.) */
  meta: unknown;
  /** The sheet changed size at this step: its meta carries the whole old document, not tiles. */
  boundary?: boolean;
}

interface Group { formats: Format[]; documents: number }

/**
 * Undo via copy-on-write tiles. Everything outside the simulation's active rect is
 * static, so before any texel is modified the engine calls `protect(...)`, which
 * copies tiles not yet saved for the current step into an atlas; undo blits them
 * back. Layers are grouped into pools (e.g. the fixed layer only changes when the
 * painting is fixed, so it has its own pool and is only saved then). Each pool's
 * memory is bounded; the oldest steps are dropped to make room.
 *
 * Tiles only make sense for one sheet size, so a resize is a *boundary* step: it keeps
 * the whole old document in its meta instead, and crossing it (in either direction)
 * forgets the steps on the far side of the stack it lands on.
 */
export class History {
  private pools!: Pool[];
  private tilesX!: number;
  private tilesY!: number;
  private steps: Step[] = [];
  private redoSteps: Step[] = [];
  private maxSteps = 50;
  /** False after undo / redo until the next step begins: the sim settling then is saved only while slots are free. */
  private recording = false;
  /** Bumped whenever a step is dropped to make room, so the engine can tell the UI. */
  evictions = 0;

  /** `groups[i]` lists a pool's layer formats and its capacity in documents' worth of tiles. */
  constructor(private g: GL, private w: number, private h: number, private groups: Group[]) {
    this.allocate();
  }

  private allocate() {
    this.tilesX = Math.ceil(this.w / TILE);
    this.tilesY = Math.ceil(this.h / TILE);
    const tiles = this.tilesX * this.tilesY;
    this.pools = this.groups.map(gr => new Pool(this.g, Math.ceil(tiles * gr.documents), gr.formats));
  }

  get canUndo() { return this.steps.length > 0; }
  get canRedo() { return this.redoSteps.length > 0; }

  /** Every step, oldest first (applied ones, then undone ones), and how many are applied. */
  entries(): { list: StepInfo[]; index: number } {
    const info = (s: Step): StepInfo => ({ kind: s.kind, label: s.label });
    return { list: [...this.steps.map(info), ...[...this.redoSteps].reverse().map(info)], index: this.steps.length };
  }

  /** The step undo would take back, if any. */
  peekUndo(): (StepInfo & { boundary: boolean }) | null { return this.peek(this.steps); }
  /** The step redo would re-apply, if any. */
  peekRedo(): (StepInfo & { boundary: boolean }) | null { return this.peek(this.redoSteps); }

  private peek(stack: Step[]) {
    const s = stack[stack.length - 1];
    return s ? { kind: s.kind, label: s.label, boundary: !!s.boundary } : null;
  }

  begin(info: StepInfo, meta: unknown) {
    this.clearRedo();   // a new action forks history
    this.steps.push({ ...info, tiles: this.pools.map(() => new Map()), meta });
    this.recording = true;
    while (this.steps.length > this.maxSteps) this.dropOldest();
  }

  /**
   * Record a change of sheet size to `w`×`h`. Earlier steps hold tiles of the old sheet,
   * so they are forgotten; the step itself keeps the old document in `meta`.
   */
  beginBoundary(info: StepInfo, meta: unknown, w: number, h: number) {
    this.clearRedo();
    for (const s of this.steps) this.release(s);
    this.steps = [{ ...info, tiles: [], meta, boundary: true }];
    this.recording = true;
    this.resize(w, h);
  }

  /** Re-create the tile pools for a `w`×`h` sheet (after a boundary step was crossed). */
  resize(w: number, h: number) {
    for (const s of this.steps) { this.release(s); s.tiles = []; }
    for (const s of this.redoSteps) { this.release(s); s.tiles = []; }
    this.dispose();
    this.w = w; this.h = h;
    this.allocate();
    for (const s of [...this.steps, ...this.redoSteps]) if (!s.boundary) s.tiles = this.pools.map(() => new Map());
  }

  /** Save not-yet-saved tiles of `rect` (document texels) of pool `p` before they change. */
  protect(p: number, rect: Rect, layers: WebGLFramebuffer[]) {
    const step = this.steps[this.steps.length - 1];
    if (!step) return;
    if (step.boundary) return;   // the sim settling after a resize is restored wholesale with the old sheet
    const pool = this.pools[p], saved = step.tiles[p];
    const tx0 = Math.max(0, Math.floor(rect.x0 / TILE)), tx1 = Math.min(this.tilesX - 1, Math.floor((rect.x1 - 1) / TILE));
    const ty0 = Math.max(0, Math.floor(rect.y0 / TILE)), ty1 = Math.min(this.tilesY - 1, Math.floor((rect.y1 - 1) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const id = ty * this.tilesX + tx;
        if (saved.has(id)) continue;
        // after an undo the paint keeps drying into the previous step; that is not worth losing a step for
        const slot = this.recording ? this.allocSlot(pool) : pool.free.pop();
        if (slot === undefined) return; // a pool holds at least one whole document
        saved.set(id, slot);
        this.copyTile(pool, id, slot, layers, true);
      }
    }
  }

  /**
   * Restore the last step. `layers[p][i]` lists every framebuffer that should receive
   * layer i of pool p (both halves of a ping-pong pair; the first is read from when the
   * current content is saved for redo). `metaNow` is the engine state to come back to
   * on redo. Returns the step's meta and the document rect that changed.
   */
  undo(layers: WebGLFramebuffer[][][], metaNow: unknown) {
    return this.swap(this.steps, this.redoSteps, layers, metaNow);
  }

  /** Re-apply the last undone step. */
  redo(layers: WebGLFramebuffer[][][], metaNow: unknown) {
    return this.swap(this.redoSteps, this.steps, layers, metaNow);
  }

  /**
   * Undo and redo are the same move in opposite directions: pop a step from `from`,
   * swap the content of each of its tiles with what is on the sheet now (through a
   * scratch tile, so nothing is allocated and no other step can be lost), and push
   * the step, now holding the way back, onto `to`.
   */
  private swap(from: Step[], to: Step[], layers: WebGLFramebuffer[][][], metaNow: unknown): { meta: unknown; rect: Rect | null; info: StepInfo } | null {
    const step = from.pop();
    if (!step) return null;
    this.recording = false;
    const info: StepInfo = { kind: step.kind, label: step.label };
    if (step.boundary) {
      // the far side of the other stack was made on a sheet of another size
      for (const s of to) this.release(s);
      to.length = 0;
      to.push({ ...info, tiles: [], meta: metaNow, boundary: true });
      return { meta: step.meta, rect: null, info };
    }
    const back: Step = { ...info, tiles: step.tiles, meta: metaNow };
    let rect: Rect | null = null;
    step.tiles.forEach((saved, p) => {
      const pool = this.pools[p];
      for (const [id, slot] of saved) {
        const tx = id % this.tilesX, ty = Math.floor(id / this.tilesX);
        const w = Math.min(TILE, this.w - tx * TILE), h = Math.min(TILE, this.h - ty * TILE);
        const sx = (slot % pool.cols) * TILE, sy = Math.floor(slot / pool.cols) * TILE;
        layers[p].forEach((fbs, i) => {
          const atlas = pool.atlas[i].views[0], scratch = pool.scratch[i].views[0];
          this.g.blit(fbs[0], tx * TILE, ty * TILE, scratch, 0, 0, w, h);          // now -> scratch
          for (const fb of fbs) this.g.blit(atlas, sx, sy, fb, tx * TILE, ty * TILE, w, h);   // saved -> sheet (both halves)
          this.g.blit(scratch, 0, 0, atlas, sx, sy, w, h);                        // scratch -> slot: the way back
        });
        const r = { x0: tx * TILE, y0: ty * TILE, x1: tx * TILE + w, y1: ty * TILE + h };
        rect = rect ? { x0: Math.min(rect.x0, r.x0), y0: Math.min(rect.y0, r.y0), x1: Math.max(rect.x1, r.x1), y1: Math.max(rect.y1, r.y1) } : r;
      }
    });
    to.push(back);
    return { meta: step.meta, rect, info };
  }

  /**
   * A free slot of `pool`, making room if needed: the oldest undo steps go first (the
   * step being recorded never does), then redo steps, newest first. Only recording
   * allocates; undo and redo swap tiles in place.
   */
  private allocSlot(pool: Pool): number | undefined {
    while (!pool.free.length) {
      if (this.steps.length > 1) this.release(this.steps.shift()!);
      else if (this.redoSteps.length) this.release(this.redoSteps.pop()!);
      else break;
      this.evictions++;
    }
    return pool.free.pop();
  }

  private dropOldest() {
    const s = this.steps.shift();
    if (s) this.release(s);
  }

  /** Forget the redo stack (after an undone step should not come back). */
  discardRedo() { this.clearRedo(); }

  /** Free the atlases (when the document is replaced without disposing every target). */
  dispose() { this.pools.forEach(p => p.dispose(this.g)); }

  /** Forget everything (the document was replaced). */
  reset() {
    for (const s of this.steps) this.release(s);
    this.steps = [];
    this.clearRedo();
  }

  private clearRedo() {
    for (const s of this.redoSteps) this.release(s);
    this.redoSteps = [];
  }

  private release(s: Step) {
    s.tiles.forEach((saved, p) => { for (const slot of saved.values()) this.pools[p].free.push(slot); });
  }

  private copyTile(pool: Pool, id: number, slot: number, layers: WebGLFramebuffer[], save: boolean) {
    const tx = (id % this.tilesX) * TILE, ty = Math.floor(id / this.tilesX) * TILE;
    const sx = (slot % pool.cols) * TILE, sy = Math.floor(slot / pool.cols) * TILE;
    const w = Math.min(TILE, this.w - tx), h = Math.min(TILE, this.h - ty);
    layers.forEach((fb, i) => {
      const atlas = pool.atlas[i].views[0];
      if (save) this.g.blit(fb, tx, ty, atlas, sx, sy, w, h);
      else this.g.blit(atlas, sx, sy, fb, tx, ty, w, h);
    });
  }
}
