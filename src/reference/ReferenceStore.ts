import { effect, signal } from '@preact/signals';
import type { DocState, RefRect, WatercolorEngine } from '../engine/Engine';
import { persisted } from '../app/persisted';
import { showToast } from '../app/toast';
import { decodeImage } from './decode';

// A photo or sketch shown under the paint to work from. It lives only on screen: the
// engine never draws it into an export. While adjusting, a frame over it moves (drag),
// scales (corners, wheel, pinch) and painting is paused.

const KEY = 'watercolor.reference';

interface Stored { opacity: number; visible: boolean }

export class ReferenceStore {
  readonly stored = persisted<Stored>(KEY, { opacity: 0.5, visible: true });
  readonly has = signal(false);
  /** Is the move / scale frame up? */
  readonly adjusting = signal(false);
  /** Mirror of the engine's placement (document uv), so the frame can follow it. */
  readonly rect = signal<RefRect>({ x: 0, y: 0, w: 1, h: 1 });
  /** Does the Fill tool trace this image (find its areas on it) instead of on the paint? */
  readonly forFill = signal(false);
  /** Just imported: ask whether fills should trace it. */
  readonly askFill = signal(false);
  /** Document state when the current move / scale / opacity gesture began. */
  private before: DocState | null = null;

  constructor(readonly engine: WatercolorEngine) {
    effect(() => {
      const { opacity, visible } = this.stored.value;
      engine.referenceOpacity = opacity;
      engine.referenceVisible = visible;
    });
    effect(() => { engine.referenceRect = this.rect.value; });
    effect(() => { engine.referenceForFill = this.has.value && this.forFill.value; });
  }

  get visible() { return this.stored.value.visible; }
  get opacity() { return this.stored.value.opacity; }

  /** Opacity slider: `input` while dragging, `commit` when let go (one undo step per drag). */
  setOpacity(v: number, phase: 'input' | 'commit' = 'input') {
    this.beginGesture();
    this.stored.value = { opacity: v, visible: true };
    if (phase === 'commit') this.endGesture('Reference opacity');
  }

  setVisible(v: boolean) {
    if (v === this.visible) return;
    const before = this.engine.documentState;
    this.stored.value = { ...this.stored.value, visible: v };
    if (!v) this.setAdjust(false);
    if (this.has.peek()) this.engine.recordChange('reference', v ? 'Reference shown' : 'Reference hidden', before);
  }

  /** A move / scale / opacity gesture starts: remember where to come back to. */
  beginGesture() { this.before ??= this.engine.documentState; }

  /** The gesture ended: one undo step, if anything changed. */
  endGesture(label: string) {
    const b = this.before;
    this.before = null;
    if (!b || !this.has.peek()) return;
    const now = this.engine.documentState;
    const r0 = b.reference, r1 = now.reference;
    const same = r0.opacity === r1.opacity && r0.visible === r1.visible &&
      r0.rect.x === r1.rect.x && r0.rect.y === r1.rect.y && r0.rect.w === r1.rect.w && r0.rect.h === r1.rect.h;
    if (!same) this.engine.recordChange('reference', label, b);
  }

  /** Follow the engine after an undo, redo or project open. */
  syncFrom(r: DocState['reference']) {
    this.before = null;
    const has = r.image !== null;
    if (has !== this.has.peek()) { this.has.value = has; if (!has) { this.forFill.value = false; this.askFill.value = false; this.setAdjust(false); } }
    const c = this.rect.peek();
    if (c.x !== r.rect.x || c.y !== r.rect.y || c.w !== r.rect.w || c.h !== r.rect.h) this.rect.value = { ...r.rect };
    const s = this.stored.peek();
    if (s.opacity !== r.opacity || s.visible !== r.visible) this.stored.value = { opacity: r.opacity, visible: r.visible };
  }

  setAdjust(on: boolean) {
    on &&= this.has.peek();
    if (on === this.adjusting.peek()) return;
    if (on && !this.visible) this.setVisible(true);
    this.adjusting.value = on;
  }

  /** Leave move / scale mode; true if it was on. */
  stopAdjust(): boolean { const was = this.adjusting.peek(); this.setAdjust(false); return was; }

  toggleVisible() {
    if (!this.has.peek()) return;
    this.setVisible(!this.visible);
    showToast(this.visible ? 'Reference shown' : 'Reference hidden');
  }

  fit() {
    if (!this.has.peek()) return;
    const before = this.engine.documentState;
    this.engine.fitReference();
    this.syncRect();
    this.engine.recordChange('reference', 'Reference fitted', before);
  }

  remove() {
    if (!this.has.peek()) return;
    this.setAdjust(false);
    this.engine.setReference(null);   // records the step; syncFrom clears the rest
    this.has.value = false; this.forFill.value = false; this.askFill.value = false;
  }

  /** Answer the after-import question (or change it later). */
  useForFill(on: boolean) {
    this.askFill.value = false;
    this.forFill.value = on && this.has.peek();
  }

  /** Pull the placement back from the engine (after it fitted or re-created the document). */
  syncRect() { this.rect.value = this.engine.referenceRect; }

  async load(file: File): Promise<boolean> {
    try {
      const bmp = await decodeImage(file);
      this.engine.setReference(bmp);
      bmp.close();
      this.has.value = true;
      this.syncRect();
      if (!this.visible) this.setVisible(true);
      // each new image starts as a plain reference; the user says whether fills should trace it
      this.forFill.value = false;
      this.askFill.value = true;
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not read that image');
      return false;
    }
  }
}
