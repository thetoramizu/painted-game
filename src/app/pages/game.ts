import { Component, DestroyRef, computed, effect, inject, input, signal } from '@angular/core';
import { Router } from '@angular/router';
import { GameService } from '../core/game.service';
import { ScoreService, renderModelToCanvas } from '../core/strokes-render';
import { drawModel } from '../core/model-generator';
import { PaintCanvas } from './paint-canvas';
import { Stroke } from '../core/models';

/**
 * Page de jeu : lobby → manche chronométrée → résultats.
 * Toutes les infos viennent du serveur via GameService (source de vérité).
 */
@Component({
  selector: 'app-game',
  imports: [PaintCanvas],
  template: `
    <div class="layout">
      <header>
        <div class="brand">🎨 Paint Together</div>
        <div class="code" *ngIf="false"></div>
        @if (game.roomCode(); as rc) {
          <span class="roomcode" (click)="copy()" title="Copier le code">{{ rc }} 📋</span>
        }
        <span class="spacer"></span>
        @if (phase() === 'playing') {
          <span class="timer" [class.danger]="remaining() <= 10">⏱ {{ fmt(remaining()) }}</span>
        }
        <button class="leave" (click)="leave()">Quitter</button>
      </header>

      <!-- LOBBY -->
      @if (phase() === 'lobby') {
        <div class="center panel">
          <h2>Salon d'attente</h2>
          <p>Partage ce code avec tes amis (max 4) :</p>
          <div class="big-code">{{ game.roomCode() }}</div>
          <ul class="players">
            @for (p of game.players(); track p.id) {
              <li [style.color]="p.color">● {{ p.name }}{{ p.id === game.myId ? ' (toi)' : '' }}@if (!p.connected) { — hors ligne }</li>
            }
          </ul>
          @if (game.isHost()) {
            <button class="primary" (click)="game.start()">🚀 Lancer la manche ({{ game.players().length }} joueur{{ game.players().length > 1 ? 's' : '' }})</button>
          } @else {
            <p class="hint">En attente de l'hôte…</p>
          }
        </div>
      }

      <!-- JEU -->
      @if (phase() === 'playing') {
        <main class="game">
          <aside class="side">
            <h3>Modèle à recopier</h3>
            <canvas #ref width="260" height="173" class="ref"></canvas>
            <label class="toggle"><input type="checkbox" [(ngModel)]="overlayOn" /> Filigrane sur la toile</label>
            <div class="brushes">
              <h4>Ton pinceau</h4>
              <div class="sizes">
                @for (s of sizes; track s) {
                  <button class="size" [class.active]="size() === s" (click)="size.set(s)" [style.font-size.px]="10 + s * 900">●</button>
                }
              </div>
            </div>
            <div class="legend">
              @for (p of game.players(); track p.id) {
                <div><span [style.color]="p.color">●</span> {{ p.name }}</div>
              }
            </div>
          </aside>

          <section class="canvas-area">
            <app-paint-canvas
              [color]="myColor()"
              [size]="size()"
              [strokes]="game.strokes()"
              [myId]="game.myId ?? ''"
              [showOverlay]="overlayOn"
              [modelSource]="modelCanvas()"
              (strokeDone)="onStroke($event)"
              (undoRequest)="onUndo($event)"
            />
            <div class="toolbar">
              <span class="dot" [style.background]="myColor()"></span>
              <button (click)="undoMyLast()">↩️ Annuler mon dernier trait</button>
            </div>
          </section>
        </main>
      }

      <!-- RÉSULTATS -->
      @if (phase() === 'results') {
        <div class="center panel">
          <h2>Résultats de la manche</h2>
          <div class="compare">
            <img [src]="snapshot()" alt="votre œuvre" />
            <img *ngIf="false" />
          </div>
          <div class="score-big">{{ teamScore() }}%</div>
          <p class="verdict">{{ verdict() }}</p>
          <ul class="scores">
            @for (p of game.players(); track p.id) {
              <li><span [style.color]="p.color">●</span> {{ p.name }} : {{ game.scores()[p.id] ?? '—' }}%</li>
            }
          </ul>
          @if (game.isHost()) {
            <button class="primary" (click)="game.start()">🔁 Nouvelle manche</button>
          } @else {
            <p class="hint">L'hôte peut lancer une nouvelle manche…</p>
          }
        </div>
      }

      @if (!phase()) {
        <div class="center panel">
          <p>Connection au salon en cours…</p>
          <button (click)="leave()">Retour à l'accueil</button>
        </div>
      }
    </div>
  `,
  styles: `
    header { display: flex; align-items: center; gap: 14px; padding: 10px 18px; background: #fff; box-shadow: 0 2px 10px rgba(0,0,0,.08); }
    .brand { font-weight: 700; }
    .roomcode { background: #eef; border-radius: 8px; padding: 4px 10px; cursor: pointer; letter-spacing: 3px; font-weight: 600; }
    .spacer { flex: 1; }
    .timer { font-size: 22px; font-weight: 700; color: #457b9d; }
    .timer.danger { color: #e63946; animation: blink 1s infinite; }
    @keyframes blink { 50% { opacity: .4; } }
    .leave { padding: 6px 14px; border: none; border-radius: 8px; background: #fde; cursor: pointer; }
    .center { display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .panel { background: #fff; margin: 6vh auto; padding: 32px 48px; border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,.1); text-align: center; max-width: 560px; }
    .big-code { font-size: 48px; letter-spacing: 12px; font-weight: 800; color: #457b9d; }
    .players { list-style: none; padding: 0; font-size: 17px; }
    .players li { margin: 6px 0; }
    button.primary { background: #457b9d; color: #fff; font-weight: 600; padding: 14px 28px; border: none; border-radius: 10px; font-size: 16px; cursor: pointer; }
    .hint { color: #889; }
    .game { display: grid; grid-template-columns: 300px 1fr; gap: 20px; padding: 20px; max-width: 1400px; margin: 0 auto; }
    .side { background: #fff; border-radius: 12px; padding: 16px; box-shadow: 0 4px 24px rgba(0,0,0,.08); }
    .ref { width: 100%; border: 2px solid #dde; border-radius: 8px; background: #fff; }
    .toggle { display: flex; gap: 6px; align-items: center; font-size: 14px; margin-top: 8px; }
    .sizes { display: flex; gap: 8px; }
    .size { width: 44px; height: 44px; border-radius: 50%; border: 2px solid #dde; background: #fff; cursor: pointer; }
    .size.active { border-color: #457b9d; background: #eef4f8; }
    .legend { margin-top: 14px; font-size: 14px; }
    .toolbar { display: flex; align-items: center; gap: 12px; margin-top: 12px; }
    .dot { width: 22px; height: 22px; border-radius: 50%; display: inline-block; }
    .toolbar button { padding: 8px 16px; border: none; border-radius: 8px; background: #eef; cursor: pointer; }
    .score-big { font-size: 64px; font-weight: 800; color: #2a9d8f; }
    .scores { list-style: none; padding: 0; }
    img { max-width: 260px; border-radius: 8px; border: 2px solid #dde; }
    @media (max-width: 900px) { .game { grid-template-columns: 1fr; } }
  `,
})
export class Game {
  protected game = inject(GameService);
  private router = inject(Router);
  private scoreSvc = inject(ScoreService);
  private destroyRef = inject(DestroyRef);

  readonly code = input<string>(); // depuis la route /room/:code

  phase = this.game.phase;
  sizes = [0.006, 0.012, 0.022];
  size = signal(0.012);
  overlayOn = false;

  myColor = computed(() => this.game.players().find((p) => p.id === this.game.myId)?.color ?? '#888');

  /** canvas hors-écran du modèle courant (pour filigrane + score) */
  modelCanvas = signal<HTMLCanvasElement | null>(null);

  remaining = signal(120);
  snapshotUrl = signal('');

  teamScore = computed(() => {
    const scores = Object.values(this.game.scores());
    if (!scores.length) return this.localScore();
    return Math.round(scores.reduce((a, b) => a + b, 0) / scores.length);
  });

  snapshot = this.snapshotUrl;

  localScore = signal(0);

  constructor() {
    // chrono basé sur endsAt (horloge serveur) — robuste aux décalages
    effect(() => {
      const endsAt = this.game.endsAt();
      if (!endsAt) return;
      const tick = () => this.remaining.set(Math.max(0, Math.ceil((endsAt - Date.now()) / 1000)));
      tick();
      const id = setInterval(tick, 500);
      this.destroyRef.onDestroy(() => clearInterval(id));
    });

    // (re)génération du canvas modèle quand un nouveau modèle arrive
    effect(() => {
      const model = this.game.model();
      if (!model) { this.modelCanvas.set(null); return; }
      const c = document.createElement('canvas');
      c.width = 600; c.height = 400;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 600, 400);
      drawModel(ctx, model, 600, 400);
      this.modelCanvas.set(c);
      queueMicrotask(() => this.paintReference(c));
    });

    // à la fin de la manche : calcul du score + envoi au serveur
    effect(() => {
      if (this.game.phase() === 'results') {
        const strokes = this.game.strokes();
        const src = this.modelCanvas();
        if (src && this.game.myId) {
          const value = this.scoreSvc.score(strokes, (ctx, w, h) => ctx.drawImage(src, 0, 0, w, h));
          this.localScore.set(value);
          (this.game as any).socket?.emit?.('score', { value });
        }
      }
    });
  }

  private paintReference(modelCanvas: HTMLCanvasElement): void {
    // canvas de référence dans la sidebar (query direct, simple et suffisant ici)
    setTimeout(() => {
      const ref = document.querySelector<HTMLCanvasElement>('canvas.ref');
      if (!ref) return;
      const ctx = ref.getContext('2d')!;
      ctx.clearRect(0, 0, ref.width, ref.height);
      ctx.drawImage(modelCanvas, 0, 0, ref.width, ref.height);
    });
  }

  onStroke(stroke: Stroke): void {
    this.game.sendStroke(stroke);
  }

  onUndo(strokeId: string): void {
    this.game.undo(strokeId);
  }

  undoMyLast(): void {
    const mine = this.game.strokes().filter((s) => s.playerId === this.game.myId);
    if (mine.length) this.game.undo(mine[mine.length - 1].id);
  }

  fmt(sec: number): string {
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  copy(): void {
    navigator.clipboard?.writeText(this.game.roomCode() ?? '');
  }

  verdict(): string {
    const s = this.teamScore();
    if (s >= 80) return '🏆 Parfait ! On dirait le original !';
    if (s >= 60) return '👏 Très beau travail d’équipe !';
    if (s >= 40) return '🙂 Pas mal, retentez une manche !';
    return '🤔 Difficile… mais on ne se décourage pas !';
  }

  leave(): void {
    this.game.leave();
    this.router.navigate(['/']);
  }
}
