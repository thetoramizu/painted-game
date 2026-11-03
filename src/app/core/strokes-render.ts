import { Injectable } from '@angular/core';
import { Point, Stroke, GeneratedModel } from './models';
import { drawModel } from './model-generator';

/** Rendu d'un trait (lignes épaisses à bouts ronds) — partagé canvas live & offscreen */
export function paintStroke(ctx: CanvasRenderingContext2D, stroke: Stroke, w: number, h: number, fromIndex = 0): void {
  const pts = stroke.points;
  if (pts.length === 0) return;
  ctx.strokeStyle = stroke.color;
  ctx.fillStyle = stroke.color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const px = Math.max(2, stroke.size * Math.hypot(w, h));
  ctx.lineWidth = px;

  const start = Math.max(0, fromIndex - 1);
  if (pts.length === 1 || fromIndex >= pts.length - 1 && start === pts.length - 1) {
    // point unique : pastille
    const [x, y] = toPx(pts[pts.length - 1], w, h);
    ctx.beginPath();
    ctx.arc(x, y, px / 2, 0, Math.PI * 2);
    ctx.fill();
    return;
  }
  ctx.beginPath();
  const [sx, sy] = toPx(pts[start], w, h);
  ctx.moveTo(sx, sy);
  for (let i = start + 1; i < pts.length; i++) {
    const [x, y] = toPx(pts[i], w, h);
    ctx.lineTo(x, y);
  }
  ctx.stroke();
}

export function drawStrokesOffscreen(ctx: CanvasRenderingContext2D, strokes: Stroke[], w: number, h: number): void {
  for (const s of strokes) paintStroke(ctx, s, w, h);
}

export function renderModelToCanvas(model: GeneratedModel, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  drawModel(ctx, model, w, h);
  return canvas;
}

export function toPx(p: Point, w: number, h: number): [number, number] {
  return [p[0] * w, p[1] * h];
}

/** Score de similarité entre la toile et le modèle (grille 64×64, teinte + couverture) */
const GRID = 64;

@Injectable({ providedIn: 'root' })
export class ScoreService {
  /** callback targetDraw dessine le modèle sur le contexte fourni */
  score(strokes: Stroke[], targetDraw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): number {
    const painted = this.rasterize((ctx, w, h) => drawStrokesOffscreen(ctx, strokes, w, h));
    const target = this.rasterize(targetDraw);
    return this.compare(painted, target);
  }

  private rasterize(draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): Float32Array {
    const size = GRID * 4;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    draw(ctx, size, size);

    const img = ctx.getImageData(0, 0, size, size).data;
    // par cellule : [teinte(hue 0..360 ou -1), saturation 0..1, couverture 0..1]
    const grid = new Float32Array(GRID * GRID * 3);
    const cell = size / GRID;

    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        let ink = 0, n = 0, rSum = 0, gSum = 0, bSum = 0;
        const x0 = Math.floor(gx * cell), x1 = Math.max(x0 + 1, Math.floor((gx + 1) * cell));
        const y0 = Math.floor(gy * cell), y1 = Math.max(y0 + 1, Math.floor((gy + 1) * cell));
        for (let y = y0; y < y1; y += 2) {
          for (let x = x0; x < x1; x += 2) {
            const i = (y * size + x) * 4;
            const r = img[i], g = img[i + 1], b = img[i + 2];
            n++;
            if (r < 245 || g < 245 || b < 245) {
              ink++;
              rSum += r; gSum += g; bSum += b;
            }
          }
        }
        const idx = (gy * GRID + gx) * 3;
        if (ink > 0) {
          const [h, s] = rgbToHsv(rSum / ink, gSum / ink, bSum / ink);
          grid[idx] = h * 360;
          grid[idx + 1] = s;
          grid[idx + 2] = ink / n;
        } else {
          grid[idx] = -1;
        }
      }
    }
    return grid;
  }

  private compare(a: Float32Array, b: Float32Array): number {
    let match = 0;
    let relevant = 0;
    for (let i = 0; i < GRID * GRID; i++) {
      const o = i * 3;
      const aInk = a[o] >= 0;
      const bInk = b[o] >= 0;
      if (!aInk && !bInk) continue;
      relevant++;
      if (aInk !== bInk) continue; // l'un peint, l'autre vide → 0
      const dh = hueDistance(a[o], b[o]); // 0..180
      const ds = Math.abs(a[o + 1] - b[o + 1]);
      const colorSim = Math.max(0, 1 - (dh / 90) * 0.75 - ds * 0.25);
      // pondère par la densité d'encre commune
      const cov = Math.min(a[o + 2], b[o + 2]) / Math.max(a[o + 2], b[o + 2], 0.001);
      match += colorSim * (0.6 + 0.4 * cov);
    }
    if (relevant === 0) return 0;
    return Math.round((match / relevant) * 100);
  }
}

function hueDistance(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2);
  return Math.min(d, 360 - d);
}

function rgbToHsv(r: number, g: number, b: number): [number, number] {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h = (h * 60 + 360) % 360;
  }
  return [h / 360, max === 0 ? 0 : d / max];
}
