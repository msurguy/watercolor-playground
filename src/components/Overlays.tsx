import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import { toast } from '../app/toast';
import { ghostPath } from '../draw/ghost';
import { Icon } from '../ui/Icon';

export function Toast() {
  const text = toast.value;
  return <div class="toast" hidden={text === null}>{text}</div>;
}

/** Dashed outline of where a scripted drawing (text, shape) will land. */
export function Ghost() {
  const d = ghostPath.value;
  return <svg class="ghost" style={{ display: d === null ? 'none' : '' }}><path d={d ?? ''} /></svg>;
}

/** Asks what a dropped image is for, next to where it was dropped. */
export function DropChoice() {
  const app = useApp();
  const drop = app.dropped.value;
  const el = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const node = el.current;
    if (!drop || !node) return;
    const r = node.getBoundingClientRect();
    node.style.left = `${Math.max(8, Math.min(innerWidth - r.width - 8, drop.x - r.width / 2))}px`;
    node.style.top = `${Math.max(8, Math.min(innerHeight - r.height - 8, drop.y - r.height / 2))}px`;
  }, [drop]);
  useEffect(() => {
    if (!drop) return;
    const away = (e: PointerEvent) => { if (!el.current?.contains(e.target as Node)) app.closeDrop(); };
    window.addEventListener('pointerdown', away);
    return () => window.removeEventListener('pointerdown', away);
  }, [drop, app]);
  return (
    <div ref={el} class="panel drop-choice" hidden={!drop} role="dialog" aria-label="Use the dropped image">
      <button onClick={() => app.resolveDrop('reference')}><Icon name="image" size={16} /><span>Use as reference</span></button>
      <button onClick={() => app.resolveDrop('brush')}><Icon name="brush" size={16} /><span>Make a brush</span></button>
    </div>
  );
}
