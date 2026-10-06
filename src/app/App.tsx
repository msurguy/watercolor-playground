import { useEffect, useState } from 'preact/hooks';
import { ActionBar } from '../components/ActionBar';
import { BrushLibrary } from '../components/BrushLibrary';
import { HistoryPanel } from '../components/HistoryPanel';
import { DropChoice, FillChoice, Ghost, Toast } from '../components/Overlays';
import { Palette } from '../components/Palette';
import { Paper } from '../components/Paper';
import { PaperPanel } from '../components/PaperPanel';
import { SettingsPanel } from '../components/SettingsPanel';
import { Toolbar } from '../components/Toolbar';
import { ZoomControl } from '../components/ZoomControl';
import { ExportPanel } from '../export/ExportPanel';
import { ReferencePanel } from '../reference/ReferencePanel';
import { RefFrame } from '../reference/RefFrame';
import { AppContext, useApp } from './context';
import { useKeyboard } from './keyboard';
import { bumpResize } from './resize';
import type { AppStore } from './store';

/** Everything but the paper: toolbars, panels and overlays. Rendered once the engine exists. */
function Chrome() {
  const app = useApp();
  useKeyboard(app);
  useEffect(() => {
    const onResize = () => { app.resize(); bumpResize(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [app]);
  return <>
    <Toolbar />
    <BrushLibrary />
    <ActionBar />
    <SettingsPanel />
    <ReferencePanel />
    <PaperPanel />
    <HistoryPanel />
    <ExportPanel />
    <Palette />
    <ZoomControl />
    {[...app.panelTools.values()].map(({ def, tool }) => <def.Panel key={def.id} tool={tool} />)}
    <RefFrame />
    <Ghost />
    <DropChoice />
    <FillChoice />
  </>;
}

export function App() {
  const [app, setApp] = useState<AppStore | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (app && import.meta.env.DEV) (window as unknown as { app: AppStore; engine: unknown }).app = app, (window as unknown as { engine: unknown }).engine = app.engine;
  }, [app]);

  if (error) return <div class="error"><p>{error}</p><p class="sub">A browser with WebGL2 is required.</p></div>;

  // drop an image anywhere to use it as the reference or make a brush from it
  const onDragOver = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
  const onDrop = (e: DragEvent) => {
    const f = e.dataTransfer?.files?.[0];
    if (f && app?.dropFile(f, e.clientX, e.clientY)) e.preventDefault();
  };

  return (
    <AppContext.Provider value={app}>
      <div class="app" onDragOver={onDragOver} onDrop={onDrop}>
        <Paper app={app} onReady={setApp} onError={e => setError(e instanceof Error ? e.message : String(e))} />
        {app && <Chrome />}
        <Toast />
      </div>
    </AppContext.Provider>
  );
}
