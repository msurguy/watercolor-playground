import { effect, signal } from '@preact/signals';
import type { RefRect, WatercolorEngine } from '../engine/Engine';
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

  constructor(readonly engine: WatercolorEngine) {
    effect(() => {
      const { opacity, visible } = this.stored.value;
      engine.referenceOpacity = opacity;
      engine.referenceVisible = visible;
    });
    effect(() => { engine.referenceRect = this.rect.value; });
  }

  get visible() { return this.stored.value.visible; }
  get opacity() { return this.stored.value.opacity; }

  setOpacity(v: number) { this.stored.value = { opacity: v, visible: true }; }
  setVisible(v: boolean) {
    this.stored.value = { ...this.stored.value, visible: v };
    if (!v) this.setAdjust(false);
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

  fit() { this.engine.fitReference(); this.syncRect(); }

  remove() { this.setAdjust(false); this.engine.setReference(null); this.has.value = false; }

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
      showToast('Reference added');
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not read that image');
      return false;
    }
  }
}
