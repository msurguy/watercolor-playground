import { useLayoutEffect, useRef } from 'preact/hooks';
import { AppStore } from '../app/store';

/**
 * The canvas the engine paints on, its hover cursor and the first-run hint. Creates the
 * engine (via the AppStore) once mounted, and forwards pointer events on the paper to
 * the active panel tool. The engine listens to the same canvas itself for hand strokes.
 */
export function Paper({ app, onReady, onError }: { app: AppStore | null; onReady(app: AppStore): void; onError(e: unknown): void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const cursor = useRef<HTMLDivElement>(null);
  const store = useRef<AppStore | null>(null);

  useLayoutEffect(() => {
    try {
      store.current = new AppStore(canvas.current!, cursor.current!);
      onReady(store.current);
    } catch (e) { onError(e); }
    return () => { store.current?.destroy(); store.current = null; };
  }, []);

  const gesture = () => store.current?.activePanelTool.peek()?.gesture;
  const uv = (e: PointerEvent) => store.current!.engine.clientToDoc(e.clientX, e.clientY);
  const placing = !!app?.activePanelTool.value;

  return <>
    <canvas ref={canvas} class={`paper${placing ? ' placing' : ''}`}
      onPointerDown={e => {
        const a = store.current;
        if (!a) return;
        a.hintGone.value = true;
        // painting dismisses the library so it never covers the work for long
        a.toggleLibrary(false);
        gesture()?.down?.(e, uv(e));
      }}
      onPointerMove={e => gesture()?.move?.(e, uv(e))}
      onPointerUp={e => gesture()?.up?.(e, uv(e))}
      onPointerCancel={e => gesture()?.cancel?.(e)}
      onPointerLeave={() => gesture()?.leave?.()} />
    <div ref={cursor} class="cursor" />
    <div class={`hint${app?.hintGone.value ? ' gone' : ''}`}>Pick a brush and a pigment, then paint.<br />Water moves paint only where the paper is wet.</div>
  </>;
}

