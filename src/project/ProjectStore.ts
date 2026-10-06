import { signal } from '@preact/signals';
import type { AppStore } from '../app/store';
import { showToast } from '../app/toast';
import { downloadBlob, formatBytes, stampedName } from '../export/download';
import { storedTip } from '../ui/customBrushes';
import { FORMAT_VERSION, PROJECT_EXT, readProject, writeProject, type ProjectData } from './format';

const THUMB = 320;

const toBlob = (c: HTMLCanvasElement, type = 'image/png') =>
  new Promise<Blob>((resolve, reject) => c.toBlob(b => (b ? resolve(b) : reject(new Error('could not encode image'))), type));

/** Saving and opening whole paintings (.wcp files): paint, paper, reference and tool state. */
export class ProjectStore {
  readonly busy = signal<'saving' | 'opening' | null>(null);
  /** Bumped when a shortcut asks for the file picker (the panel owns the input). */
  readonly openRequest = signal(0);
  /** What the first row of the history list is called. */
  readonly baseline = signal<'Blank sheet' | 'Opened project'>('Blank sheet');

  constructor(private app: AppStore) {}

  requestOpen() { this.openRequest.value++; }

  async save() {
    if (this.busy.peek()) return;
    this.busy.value = 'saving';
    try {
      const { app } = this, { engine } = app;
      const s = engine.snapshot();
      const brush = app.brush.peek();
      const thumbnail = await this.thumbnail().catch(() => null);
      const data: ProjectData = {
        header: {
          app: 'watercolor', version: FORMAT_VERSION, created: new Date().toISOString(),
          doc: { w: s.whole.w, h: s.whole.h, sizePreset: app.paperSize.peek().preset },
          paper: s.paper,
          paint: { rect: s.whole.rect, ...s.wet },
          reference: s.reference.image
            ? { rect: s.reference.rect, opacity: s.reference.opacity, visible: s.reference.visible, forFill: app.reference.forFill.peek() }
            : null,
          tool: { params: app.params.peek(), hex: app.current.peek().hex, brushId: brush.id },
          brushes: brush.custom ? [storedTip(brush)] : [],
          view: s.view,
          blobs: [],
        },
        layers: s.whole.layers,
        reference: s.reference.image ? await toBlob(s.reference.image) : null,
        thumbnail,
      };
      const blob = await writeProject(data);
      downloadBlob(blob, stampedName(PROJECT_EXT));
      showToast(`Saved project · ${formatBytes(blob.size)}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save the project');
    } finally {
      this.busy.value = null;
    }
  }

  async open(file: File): Promise<boolean> {
    if (this.busy.peek()) return false;
    this.busy.value = 'opening';
    try {
      const data = await readProject(file);
      await this.app.openProject(data);
      this.baseline.value = 'Opened project';
      showToast(`Opened ${file.name}`);
      return true;
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not open that project');
      return false;
    } finally {
      this.busy.value = null;
    }
  }

  private async thumbnail(): Promise<Blob> {
    const full = await this.app.engine.exportImage({ format: 'png', background: 'paper', texture: true });
    const bmp = await createImageBitmap(full);
    const s = Math.min(1, THUMB / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    return toBlob(c);
  }
}
