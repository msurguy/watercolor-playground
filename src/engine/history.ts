import type { Format, GL, Rect, Target } from './gl';

const TILE = 128;

/** A set of layers snapshotted together, with its own atlas and slot pool. */
class Pool {
  readonly atlas: Target[];
  readonly cols: number;
  readonly free: number[] = [];

  constructor(g: GL, tiles: number, formats: Format[]) {
    const maxTex = g.gl.getParameter(g.gl.MAX_TEXTURE_SIZE) as number;
    this.cols = Math.min(tiles, Math.floor(maxTex / TILE));
    const rows = Math.ceil(tiles / this.cols);
    // one single-attachment atlas per layer, so blits stay 1:1
    this.atlas = formats.map(f => g.target(this.cols * TILE, rows * TILE, [f], g.gl.NEAREST));
    for (let i = tiles - 1; i >= 0; i--) this.free.push(i);
  }
}

interface Step {
  /** per pool: tile index -> atlas slot holding that tile's content from before the step */
  tiles: Map<number, number>[];
  /** opaque engine state captured when the step began (wetness clock etc.) */
  meta: unknown;
}

/**
 * Undo via copy-on-write tiles. Everything outside the simulation's active rect is
 * static, so before any texel is modified the engine calls `protect(...)`, which
 * copies tiles not yet saved for the current step into an atlas; undo blits them
 * back. Layers are grouped into pools (e.g. the fixed layer only changes when the
 * painting is fixed, so it has its own pool and is only saved then). Each pool's
 * memory is bounded; the oldest steps are dropped to make room.
 */
export class History {
  private pools: Pool[];
  private tilesX: number;
  private tilesY: number;
  private steps: Step[] = [];
  private maxSteps = 50;

  /** `groups[i]` lists a pool's layer formats and its capacity in documents' worth of tiles. */
  constructor(private g: GL, private w: number, private h: number, groups: { formats: Format[]; documents: number }[]) {
    this.tilesX = Math.ceil(w / TILE);
    this.tilesY = Math.ceil(h / TILE);
    const tiles = this.tilesX * this.tilesY;
    this.pools = groups.map(gr => new Pool(g, Math.ceil(tiles * gr.documents), gr.formats));
  }

  get canUndo() { return this.steps.length > 0; }

  begin(meta: unknown) {
    this.steps.push({ tiles: this.pools.map(() => new Map()), meta });
    while (this.steps.length > this.maxSteps) this.dropOldest();
  }

  /** Save not-yet-saved tiles of `rect` (document texels) of pool `p` before they change. */
  protect(p: number, rect: Rect, layers: WebGLFramebuffer[]) {
    const step = this.steps[this.steps.length - 1];
    if (!step) return;
    const pool = this.pools[p], saved = step.tiles[p];
    const tx0 = Math.max(0, Math.floor(rect.x0 / TILE)), tx1 = Math.min(this.tilesX - 1, Math.floor((rect.x1 - 1) / TILE));
    const ty0 = Math.max(0, Math.floor(rect.y0 / TILE)), ty1 = Math.min(this.tilesY - 1, Math.floor((rect.y1 - 1) / TILE));
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const id = ty * this.tilesX + tx;
        if (saved.has(id)) continue;
        while (!pool.free.length && this.steps.length > 1) this.dropOldest();
        const slot = pool.free.pop();
        if (slot === undefined) return; // a pool holds at least one whole document
        saved.set(id, slot);
        this.copyTile(pool, id, slot, layers, true);
      }
    }
  }

  /**
   * Restore the last step. `layers[p][i]` lists every framebuffer that should receive
   * layer i of pool p (both halves of a ping-pong pair). Returns the step's meta.
   */
  undo(layers: WebGLFramebuffer[][][]): { meta: unknown; rect: Rect | null } | null {
    const step = this.steps.pop();
    if (!step) return null;
    let rect: Rect | null = null;
    step.tiles.forEach((saved, p) => {
      const pool = this.pools[p];
      for (const [id, slot] of saved) {
        const copies = Math.max(...layers[p].map(l => l.length));
        for (let c = 0; c < copies; c++)
          this.copyTile(pool, id, slot, layers[p].map(l => l[Math.min(c, l.length - 1)]), false);
        const tx = id % this.tilesX, ty = Math.floor(id / this.tilesX);
        const r = { x0: tx * TILE, y0: ty * TILE, x1: Math.min(this.w, (tx + 1) * TILE), y1: Math.min(this.h, (ty + 1) * TILE) };
        rect = rect ? { x0: Math.min(rect.x0, r.x0), y0: Math.min(rect.y0, r.y0), x1: Math.max(rect.x1, r.x1), y1: Math.max(rect.y1, r.y1) } : r;
        pool.free.push(slot);
      }
    });
    return { meta: step.meta, rect };
  }

  private dropOldest() {
    const s = this.steps.shift();
    if (s) s.tiles.forEach((saved, p) => { for (const slot of saved.values()) this.pools[p].free.push(slot); });
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
