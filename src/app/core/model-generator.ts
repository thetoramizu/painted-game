import { GeneratedModel, ModelShape, MODEL_COLORS } from './models';

/** PRNG déterministe (mulberry32) — même graine ⇒ même modèle, côté serveur et client */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Génère un modèle abstrait dont la complexité est proportionnelle au nombre de joueurs.
 * ~4 formes pour 1 joueur, ~12 pour 4 joueurs.
 */
export function generateModel(seed: number, playerCount: number): GeneratedModel {
  const rnd = mulberry32(seed);
  const shapeCount = 3 + 2 * playerCount + Math.floor(rnd() * 3);
  const palette = shuffle(MODEL_COLORS.slice(), rnd).slice(0, Math.min(playerCount + 1, MODEL_COLORS.length));
  const shapes: ModelShape[] = [];

  for (let i = 0; i < shapeCount; i++) {
    const kinds: ModelShape['kind'][] = ['circle', 'rect', 'triangle', 'line'];
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const color = palette[Math.floor(rnd() * palette.length)];
    const fill = rnd() > 0.35;
    const ax = 0.08 + rnd() * 0.84;
    const ay = 0.08 + rnd() * 0.84;

    if (kind === 'circle') {
      shapes.push({ kind, color, fill, a: [ax, ay], radius: 0.05 + rnd() * 0.16 });
    } else if (kind === 'line') {
      shapes.push({
        kind,
        color,
        fill: false,
        a: [ax, ay],
        b: [clamp01(ax + (rnd() - 0.5) * 0.8), clamp01(ay + (rnd() - 0.5) * 0.8)],
        lineWidth: 0.004 + rnd() * 0.012,
      });
    } else {
      const bx = clamp01(ax + (rnd() - 0.5) * 0.7);
      const by = clamp01(ay + (rnd() - 0.5) * 0.7);
      shapes.push({ kind, color, fill, a: [ax, ay], b: [bx, by] });
    }
  }
  return { seed, shapes };
}

export function drawModel(ctx: CanvasRenderingContext2D, model: GeneratedModel, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const diag = Math.hypot(w, h);

  for (const s of model.shapes) {
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = Math.max(2, (s.lineWidth ?? 0.008) * diag);
    ctx.lineCap = 'round';

    const ax = s.a[0] * w;
    const ay = s.a[1] * h;
    ctx.beginPath();
    if (s.kind === 'circle') {
      ctx.arc(ax, ay, (s.radius ?? 0.1) * Math.min(w, h), 0, Math.PI * 2);
    } else if (s.kind === 'rect') {
      const bx = s.b![0] * w;
      const by = s.b![1] * h;
      ctx.rect(Math.min(ax, bx), Math.min(ay, by), Math.abs(bx - ax), Math.abs(by - ay));
    } else if (s.kind === 'triangle') {
      const bx = s.b![0] * w;
      const by = s.b![1] * h;
      const cx = (ax + bx) / 2 + (by - ay) * 0.35;
      const cy = (ay + by) / 2 - (bx - ax) * 0.35;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx, cy);
      ctx.closePath();
    } else {
      const bx = s.b![0] * w;
      const by = s.b![1] * h;
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
    }
    if (s.fill && s.kind !== 'line') ctx.fill();
    else ctx.stroke();
  }
}

function clamp01(v: number): number {
  return Math.min(0.96, Math.max(0.04, v));
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
