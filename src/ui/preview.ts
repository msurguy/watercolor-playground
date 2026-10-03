import { DEGREES, type Brush } from '../engine/brushes';
import { hexToRgb } from '../engine/spectral';

const tipCache = new Map<string, HTMLCanvasElement>();

/** The tip as a tinted RGBA image (alpha = tip value). */
export function tipImage(b: Brush, hex: string): HTMLCanvasElement {
  const key = `${b.id}|${hex}`;
  let c = tipCache.get(key);
  if (c) return c;
  const n = b.tipSize;
  c = document.createElement('canvas');
  c.width = n; c.height = n;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(n, n);
  const [r, g, bl] = hexToRgb(hex).map(v => Math.round(v * 255));
  for (let i = 0; i < n * n; i++) {
    img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = bl;
    img.data[i * 4 + 3] = b.tipData[i];
  }
  ctx.putImageData(img, 0, 0);
  tipCache.set(key, c);
  return c;
}

export function forgetTipImages(id: string) {
  for (const k of [...tipCache.keys()]) if (k.startsWith(`${id}|`)) tipCache.delete(k);
}

function prepare(canvas: HTMLCanvasElement) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  // logical size: the CSS box when laid out, else the markup's size (hidden panels have no layout)
  if (!canvas.dataset.w) { canvas.dataset.w = String(canvas.clientWidth || canvas.width); canvas.dataset.h = String(canvas.clientHeight || canvas.height); }
  const w = Number(canvas.dataset.w), h = Number(canvas.dataset.h);
  canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

/** A single dab, showing the tip's shape at its resting angle. */
export function drawThumb(canvas: HTMLCanvasElement, b: Brush, hex: string) {
  const { ctx, w, h } = prepare(canvas);
  const img = tipImage(b, hex);
  const R = Math.min(w, h) * 0.46;
  const angle = b.rotation === 'random' ? 0.5 : b.rotation === 'follow' ? b.angle * DEGREES : b.angle * DEGREES;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-angle);
  ctx.globalAlpha = 0.9;
  if (b.dabs > 1) {
    for (let i = 0; i < b.dabs; i++) {
      const a = (i / b.dabs) * Math.PI * 2 + 0.7, m = R * (0.2 + 0.7 * ((i * 7919) % 13) / 13), s = R * 0.22 * (0.4 + ((i * 104729) % 7) / 7);
      ctx.drawImage(img, Math.cos(a) * m - s, Math.sin(a) * m - s, s * 2, s * 2);
    }
  } else {
    ctx.drawImage(img, -R, -R * b.aspect, R * 2, R * 2 * b.aspect);
  }
  ctx.restore();
}

/** A short pressure-shaped stroke painted with the brush's dab rules. */
export function drawStroke(canvas: HTMLCanvasElement, b: Brush, hex: string) {
  const { ctx, w, h } = prepare(canvas);
  const img = tipImage(b, hex);
  // scale so the biggest brushes fit and the smallest stay visible
  const R = Math.min(h * 0.42, Math.max(3.5, 15 * Math.sqrt(b.size[1] / 0.05)));
  const norm = Math.min(Math.max(Math.sqrt(0.5 / b.tipMean), 0.7), 2.2);
  const alpha = Math.min(0.85, Math.max(0.05, 0.42 * Math.min(b.spacing, 1) * Math.sqrt(b.aspect) * norm * b.load));
  const x0 = 10, x1 = w - 10, ym = h / 2;
  const point = (t: number) => ({ x: x0 + (x1 - x0) * t, y: ym + Math.sin(t * Math.PI * 2) * h * 0.14 });
  let seed = 17;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const spacing = Math.max(1, R * b.spacing * Math.sqrt(b.aspect));
  const length = (x1 - x0) * 1.08;
  let fixedAngle = b.angle * DEGREES;
  ctx.globalAlpha = alpha;
  for (let d = 0; d <= length; d += spacing) {
    const t = d / length;
    const p = point(t), q = point(Math.min(1, t + 0.01));
    const pr = Math.min(1, Math.max(0.2, Math.sin(t * Math.PI) * 1.15));
    const r = R * (0.25 + 0.75 * Math.pow(pr, b.pressureSize));
    const dir = Math.atan2(-(q.y - p.y), q.x - p.x);
    for (let i = 0; i < b.dabs; i++) {
      let angle = b.rotation === 'random' ? rnd() * Math.PI * 2 : b.rotation === 'follow' ? dir + b.angle * DEGREES : fixedAngle;
      angle += (rnd() - 0.5) * 2 * b.angleJitter * DEGREES;
      let x = p.x, y = p.y, rr = r;
      if (b.scatter) { const a = rnd() * Math.PI * 2, m = Math.sqrt(rnd()) * b.scatter * r; x += Math.cos(a) * m; y += Math.sin(a) * m; }
      if (b.sizeJitter) rr *= Math.max(0.15, 1 + (rnd() * 2 - 1) * b.sizeJitter);
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-angle);
      ctx.drawImage(img, -rr, -rr * b.aspect, rr * 2, rr * 2 * b.aspect);
      ctx.restore();
    }
  }
  ctx.globalAlpha = 1;
}
