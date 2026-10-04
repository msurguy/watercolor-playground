import type { ExportBackground, ExportFormat, WatercolorEngine } from '../engine/Engine';
import { persisted } from '../app/persisted';
import { showToast } from '../app/toast';

const KEY = 'watercolor.export';

export interface ExportSettings { format: ExportFormat; background: ExportBackground; quality: number }

const DEFAULTS: ExportSettings = { format: 'png', background: 'transparent', quality: 0.92 };
export const FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'png', label: 'PNG', ext: 'png' },
  { id: 'jpeg', label: 'JPEG', ext: 'jpg' },
  { id: 'webp', label: 'WebP', ext: 'webp' },
];
export const BACKGROUNDS: { id: ExportBackground; label: string; title: string }[] = [
  { id: 'transparent', label: 'Transparent', title: 'Transparent: only the paint, no paper' },
  { id: 'paper', label: 'Paper', title: 'On the textured watercolour paper' },
  { id: 'white', label: 'White', title: 'On plain white' },
];

/** Save options (format, background, quality), remembered between visits. */
export class ExportStore {
  readonly settings = persisted<ExportSettings>(KEY, DEFAULTS);

  constructor(private engine: WatercolorEngine) {}

  set(p: Partial<ExportSettings>) {
    const s = { ...this.settings.value, ...p };
    // JPEG has no alpha channel
    if (s.format === 'jpeg' && s.background === 'transparent') s.background = 'paper';
    this.settings.value = s;
  }

  /** Save straight away with the current settings. */
  async save() {
    const { format, background, quality } = this.settings.peek();
    try {
      const blob = await this.engine.exportImage({ format, background, quality: format === 'png' ? undefined : quality });
      const ext = FORMATS.find(f => f.id === format)!.ext;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `watercolor-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.${ext}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      const bg = background === 'transparent' ? 'transparent' : `on ${background}`;
      showToast(`Saved ${FORMATS.find(f => f.id === format)!.label} · ${bg}`);
    } catch (e) {
      showToast(e instanceof Error ? e.message : 'Could not save the image');
    }
  }
}
