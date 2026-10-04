import type { ExportBackground, ExportFormat, WatercolorEngine } from '../engine/Engine';

const KEY = 'watercolor.export';

interface Settings { format: ExportFormat; background: ExportBackground; quality: number }

const DEFAULTS: Settings = { format: 'png', background: 'transparent', quality: 0.92 };
const FORMATS: { id: ExportFormat; label: string; ext: string }[] = [
  { id: 'png', label: 'PNG', ext: 'png' },
  { id: 'jpeg', label: 'JPEG', ext: 'jpg' },
  { id: 'webp', label: 'WebP', ext: 'webp' },
];
const BACKGROUNDS: { id: ExportBackground; label: string; title: string }[] = [
  { id: 'transparent', label: 'Transparent', title: 'Transparent: only the paint, no paper' },
  { id: 'paper', label: 'Paper', title: 'On the textured watercolour paper' },
  { id: 'white', label: 'White', title: 'On plain white' },
];

export interface ExportPanel {
  panel: HTMLElement;
  /** Save straight away with the last used settings. */
  save(): Promise<void>;
}

/** Save dialog: format, background and quality, remembered between visits. */
export function createExportPanel(engine: WatercolorEngine, root: HTMLElement, showToast: (s: string) => void): ExportPanel {
  let settings: Settings = { ...DEFAULTS };
  try { settings = { ...settings, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }; } catch { /* storage blocked */ }

  const panel = document.createElement('div');
  panel.className = 'panel popover export';
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Save image');
  panel.innerHTML = `
    <div class="pop-head"><span>Save image</span><span class="sub">The reference image is never included.</span></div>
    <div class="field"><span>Background</span><div class="seg">${BACKGROUNDS.map(b => `<button data-bg="${b.id}" title="${b.title}">${b.label}</button>`).join('')}</div></div>
    <div class="field"><span>Format</span><div class="seg">${FORMATS.map(f => `<button data-format="${f.id}">${f.label}</button>`).join('')}</div></div>
    <label class="slider" data-quality><span>Quality</span><input type="range" min="0.5" max="1" step="0.01"></label>
    <button class="primary" data-export="download">Download</button>`;
  root.appendChild(panel);

  const quality = panel.querySelector<HTMLInputElement>('[data-quality] input')!;

  function render() {
    for (const b of panel.querySelectorAll<HTMLButtonElement>('[data-bg]')) {
      b.classList.toggle('on', b.dataset.bg === settings.background);
      // JPEG has no alpha channel
      b.disabled = b.dataset.bg === 'transparent' && settings.format === 'jpeg';
    }
    for (const b of panel.querySelectorAll<HTMLElement>('[data-format]')) b.classList.toggle('on', b.dataset.format === settings.format);
    panel.querySelector<HTMLElement>('[data-quality]')!.hidden = settings.format === 'png';
    quality.value = String(settings.quality);
  }

  function update(p: Partial<Settings>) {
    settings = { ...settings, ...p };
    if (settings.format === 'jpeg' && settings.background === 'transparent') settings.background = 'paper';
    try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
    render();
  }

  async function save() {
    const { format, background, quality: q } = settings;
    try {
      const blob = await engine.exportImage({ format, background, quality: format === 'png' ? undefined : q });
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

  panel.addEventListener('click', e => {
    const el = (e.target as Element).closest<HTMLElement>('[data-bg], [data-format], [data-export]');
    if (!el) return;
    if (el.dataset.bg) update({ background: el.dataset.bg as ExportBackground });
    else if (el.dataset.format) update({ format: el.dataset.format as ExportFormat });
    else void save();
  });
  quality.addEventListener('input', () => update({ quality: Number(quality.value) }));

  render();
  return { panel, save };
}
