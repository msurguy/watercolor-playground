import { useEffect, useRef } from 'preact/hooks';
import { useApp } from '../app/context';
import type { HandRect } from '../hand/types';

const R = 14, SIZE = 40, C = 2 * Math.PI * R;
const rectStyle = (r: HandRect) => ({ left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });

/** Hand mode on screen: the hand cursor with its dwell ring, the control it rests on, and the camera picture. */
export function HandOverlay() {
  const app = useApp();
  const status = app.handStatus.value;
  const stream = app.handStream.value;
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (video.current) video.current.srcObject = stream; }, [stream, status]);
  if (status !== 'loading' && status !== 'on') return null;
  const c = app.hand.value;
  const box = c.grab ?? c.target;
  return <>
    <div class="hand-overlay">
      {box && <div class={`hand-target${c.grab ? ' grab' : ''}`} style={rectStyle(box)} />}
      {c.visible && (
        <svg class={`hand-cursor${c.pinching ? ' pinch' : ''}${c.painting ? ' paint' : ''}`} width={SIZE} height={SIZE}
          style={{ transform: `translate(${c.x - SIZE / 2}px, ${c.y - SIZE / 2}px)` }}>
          <circle class="base" cx={SIZE / 2} cy={SIZE / 2} r={R} />
          <circle class="dwell" cx={SIZE / 2} cy={SIZE / 2} r={R} stroke-dasharray={C} stroke-dashoffset={C * (1 - c.dwell)} />
          <circle class="dot" cx={SIZE / 2} cy={SIZE / 2} r={c.pinching ? 5 : 2.5} />
        </svg>
      )}
    </div>
    <div class="hand-pip" title="Your camera. Move inside the box; pinch to paint, rest on a button to press it.">
      <video ref={video} muted autoPlay playsInline />
      <div class="box" />
      {status === 'loading' && <span>{stream ? 'Loading the hand model…' : 'Starting camera…'}</span>}
    </div>
  </>;
}
