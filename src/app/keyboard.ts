import { useEffect } from 'preact/hooks';
import { PALETTE } from '../palette';
import { ENGINE_TOOLS, PANEL_TOOLS } from './registry';
import type { AppStore } from './store';

/** Global shortcuts. Text fields keep their keys; range sliders do not. */
export function useKeyboard(app: AppStore) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); if (e.shiftKey) app.redo(); else app.undo(); return; }
      if ((e.metaKey || e.ctrlKey) && k === 'y') { e.preventDefault(); app.redo(); return; }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k === 's') { e.preventDefault(); void app.project.save(); return; }
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && k === 'o') { e.preventDefault(); app.project.requestOpen(); return; }
      // zoom keys replace the browser's page zoom
      const zoomIn = k === '=' || k === '+', zoomOut = k === '-' || k === '_';
      if ((e.metaKey || e.ctrlKey) && !e.altKey && (zoomIn || zoomOut || e.code === 'Digit0')) {
        e.preventDefault();
        if (zoomIn) app.zoomIn(); else if (zoomOut) app.zoomOut(); else app.zoomTo(1);
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (k === 'escape') { app.escape(); return; }
      if (e.shiftKey && e.code === 'Digit1') { app.zoomToFit(); return; }
      if (e.shiftKey && e.code === 'Digit0') { app.zoomTo(1); return; }
      if (zoomIn) { app.zoomIn(); return; }
      if (zoomOut) { app.zoomOut(); return; }
      const tool = [...ENGINE_TOOLS, ...PANEL_TOOLS].find(t => t.key.toLowerCase() === k);
      if (tool) app.setTool(tool.id);
      else if (k === '[' || k === ']') app.setParams({ size: Math.min(1, Math.max(0, app.params.peek().size + (k === ']' ? 0.05 : -0.05))) });
      else if (k === ',' || k === '<') app.cycleBrush(-1);
      else if (k === '.' || k === '>') app.cycleBrush(1);
      else if (k === 'd') app.dry();
      else if (k === 's') void app.exporter.save();
      else if (k === 'r') app.reference.toggleVisible();
      else if (k === 'f') {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.();
      } else if (/^[1-9]$/.test(k)) app.choose(PALETTE[Number(k) - 1]);
      else if (k === '0') app.choose(PALETTE[PALETTE.length - 1]);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [app]);
}
