import { useApp } from '../app/context';
import { Icon } from '../ui/Icon';
import { Panel } from '../ui/Panel';

/** Zoom out / in, the current zoom (click for 100%) and zoom to fit, in the bottom-right corner. */
export function ZoomControl() {
  const app = useApp();
  const pct = Math.round(app.zoom.value * 100);
  return (
    <Panel class="zoom" role="toolbar" label="Zoom">
      <button title="Zoom out (⌘−)" aria-label="Zoom out" onClick={() => app.zoomOut()}><Icon name="minus" size={16} /></button>
      <button class="pct" title="Zoom to 100% (⇧0)" onClick={() => app.zoomTo(1)}>{pct}%</button>
      <button title="Zoom in (⌘+)" aria-label="Zoom in" onClick={() => app.zoomIn()}><Icon name="plus" size={16} /></button>
      <button title={'Zoom to fit (⇧1)\nScroll to pan, pinch or ⌘-scroll to zoom,\nhold Space or the middle button and drag to pan'}
        aria-label="Zoom to fit" onClick={() => app.zoomToFit()}><Icon name="fit" size={16} /></button>
    </Panel>
  );
}
