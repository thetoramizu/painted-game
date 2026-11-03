import { Component, DestroyRef, inject, input, output, viewChild, signal } from '@angular/core';
import { Point, Stroke } from '../core/models';
import { paintStroke } from '../core/strokes-render';

let strokeSeq = 0;

/**
 * Toile de peinture collaborative.
 * - Coordonnées normalisées [0,1] : le même trait s'affiche identiquement sur tous les écrans.
 * - Le trait en cours est rendu localement (feedback immédiat) ; à la fin du geste,
 *   on émet `strokeDone` qui sera relayé aux autres joueurs par le serveur.
 */
@Component({
  selector: 'app-paint-canvas',
  template: `
    <div class="wrap">
      <canvas
        #canvas
        width="1200"
        height="800"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp()"
        (pointercancel)="onUp()"
      ></canvas>
      <canvas #overlay class="overlay" width="1200" height="800" [hidden]="!showOverlay()"></canvas>
    </div>
  `,
  styles: `
    .wrap { position: relative; width: 100%; aspect-ratio: 3 / 2; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 24px rgba(0,0,0,.15); }
    canvas { position: absolute; inset: 0; width: 100%; height: 100%; touch-action: none; cursor: crosshair; }
    .overlay { pointer-events: none; opacity: 0.25; }
  `,
})
export class PaintCanvas {
  readonly color = input.required<string>();
  readonly size = input(0.012);
  readonly strokes = input.required<Stroke[]>();
  readonly myId = input('');
  /** modèle à afficher en filigrane (optionnel) */
  readonly showOverlay = input(false);
  /** canvas source du modèle (rendu hors-écran par le parent) */
  readonly modelSource = input<HTMLCanvasElement | null>(null);

  readonly strokeDone = output<Stroke>();
  readonly undoRequest = output<string>();

  private canvasEl = viewChild.required<HTMLCanvasElement>('canvas');
  private overlayEl = viewChild.required<HTMLCanvasElement>('overlay');
  private drawing = signal<Point[] | null>(null);
  private destroyRef = inject(DestroyRef);

  constructor() {
    // re-render quand la liste des traits change (traits distants, undo, nouvelle manche)
    let prevLen = -1;
    let prevSrc = null as HTMLCanvasElement | null;
    const check = () => {
      const arr = this.strokes();
      const src = this.modelSource();
      if (arr.length !== prevLen || src !== prevSrc) {
        prevLen = arr.length;
        prevSrc = src;
        this.redraw();
      }
      rafId = requestAnimationFrame(check);
    };
    const rafId = requestAnimationFrame(check);
    this.destroyRef.onDestroy(() => cancelAnimationFrame(rafId));
  }

  private toNorm(ev: PointerEvent): Point {
    const rect = this.canvasEl()!.getBoundingClientRect();
    return [
      Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)),
      Math.min(1, Math.max(0, (ev.clientY - rect.top) / rect.height)),
    ];
  }

  protected onDown(ev: PointerEvent) {
    (ev.target as HTMLElement).setPointerCapture(ev.pointerId);
    this.drawing.set([this.toNorm(ev)]);
    this.redraw();
  }

  protected onMove(ev: PointerEvent) {
    const pts = this.drawing();
    if (!pts) return;
    const p = this.toNorm(ev);
    const last = pts[pts.length - 1];
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.002) return; // décimation
    pts.push(p);
    const canvas = this.canvasEl();
    const ctx = canvas.getContext('2d');
    if (canvas && ctx) {
      // segment incrémental : seulement les 2 derniers points
      paintStroke(ctx, { id: 'live', playerId: this.myId(), color: this.color(), size: this.size(), points: pts.slice(-2) }, canvas.width, canvas.height);
    }
  }

  protected onUp() {
    const pts = this.drawing();
    this.drawing.set(null);
    if (!pts || pts.length === 0) return;
    this.strokeDone.emit({
      id: `s${Date.now().toString(36)}-${strokeSeq++}`,
      playerId: this.myId(),
      color: this.color(),
      size: this.size(),
      points: pts,
    });
  }

  /** Annule mon dernier trait */
  protected undoLast() {
    const mine = this.strokes().filter((s) => s.playerId === this.myId());
    if (mine.length) this.undoRequest.emit(mine[mine.length - 1].id);
  }

  private redraw() {
    const canvas = this.canvasEl();
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const s of this.strokes()) paintStroke(ctx, s, canvas.width, canvas.height);
    const live = this.drawing();
    if (live && live.length > 1) {
      paintStroke(ctx, { id: 'live', playerId: '', color: this.color(), size: this.size(), points: live }, canvas.width, canvas.height);
    }
    const ov = this.overlayEl();
    if (ov) {
      const octx = ov.getContext('2d')!;
      octx.clearRect(0, 0, ov.width, ov.height);
      const src = this.modelSource();
      if (this.showOverlay() && src) octx.drawImage(src, 0, 0, ov.width, ov.height);
    }
  }
}
