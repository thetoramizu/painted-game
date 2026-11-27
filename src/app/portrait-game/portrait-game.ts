import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  ViewChild,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SupabaseService } from '../athletes/core/supabase-client';
import { RoomService } from '../athletes/services/room.service';
import type { NormalizedPosition, PortraitElement, PortraitModel, PortraitPhase, PortraitTurn } from './models/portrait';
import { PortraitService } from './services/portrait.service';

interface PortraitGameState {
  phase: PortraitPhase;
  model: PortraitModel | null;
  turns: PortraitTurn[];
  turnIndex: number;
  placements: Record<string, NormalizedPosition>;
  observationSeconds: number;
  score: number;
  revision: number;
  movementStartedAt: number;
  pendingX: number | null;
  movingX: number;
  movingY: number;
}

interface PortraitBroadcast {
  type: 'state' | 'request-state';
  seat?: number;
  state?: PortraitGameState;
}

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 700;
const OBSERVATION_SECONDS = 30;

@Component({
  selector: 'app-portrait-game',
  templateUrl: './portrait-game.html',
  styleUrl: './portrait-game.css',
})
export class PortraitGame implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roomService = inject(RoomService);
  private readonly portraitService = inject(PortraitService);
  private readonly supabase = inject(SupabaseService).client;

  @ViewChild('portraitCanvas')
  private canvasRef?: ElementRef<HTMLCanvasElement>;

  @ViewChild('modelCanvas')
  private readonly modelCanvasRef?: ElementRef<HTMLCanvasElement>;

  @ViewChild('reconstructedCanvas')
  private readonly reconstructedCanvasRef?: ElementRef<HTMLCanvasElement>;

  protected readonly roomCode = signal('');
  protected readonly phase = signal<PortraitPhase>('preparation');
  protected readonly observationSeconds = signal(OBSERVATION_SECONDS);
  protected readonly score = signal(0);
  protected readonly activePlayer = signal('Préparation…');
  protected readonly activeStep = signal<'x' | 'y'>('x');
  protected readonly error = signal<string | null>(null);
  protected readonly players = signal<{ seat: number; pseudo: string }[]>([]);
  protected readonly isHost = signal(false);
  protected readonly isLoading = signal(true);

  private channel: RealtimeChannel | null = null;
  private unsubscribeRoom?: () => void;
  protected mySeat = 0;
  protected turns: PortraitTurn[] = [];
  protected turnIndex = 0;
  private model: PortraitModel | null = null;
  private placements: Record<string, NormalizedPosition> = {};
  private pendingX: number | null = null;
  private observationTimer: ReturnType<typeof setInterval> | null = null;
  private animationFrame = 0;
  private movingX = 0.5;
  private movingY = 0.5;
  private movingDirection = 1;
  private lastFrameTime = 0;
  private revision = 0;
  private movementStartedAt = 0;
  private readonly imageCache = new Map<string, HTMLImageElement>();

  ngAfterViewInit(): void {
    void this.initialize();
  }

  ngOnDestroy(): void {
    this.stopTimers();
    this.unsubscribeRoom?.();
    if (this.channel) void this.supabase.removeChannel(this.channel);
  }

  protected validatePosition(): void {
    if (this.phase() !== 'reproduction') return;
    const turn = this.turns[this.turnIndex];
    if (!turn || turn.seat !== this.mySeat) return;
    const elementId = turn.elementId;
    const current = this.placements[elementId] ?? { x: 0.5, y: 0.5 };

    if (turn.step === 'x') {
      this.pendingX = this.movingX;
      this.movingY = 0.5;
      this.movingDirection = 1;
      this.movementStartedAt = Date.now();
      this.turnIndex += 1;
      this.lastFrameTime = 0;
    } else {
      this.placements[elementId] = { x: this.pendingX ?? current.x, y: this.movingY };
      const validatedY = this.movingY;
      this.pendingX = null;
      this.turnIndex += 1;
      this.movementStartedAt = Date.now();
      this.movingY = validatedY;
      if (this.turnIndex >= this.turns.length) this.finishGame();
    }
    this.updateInterface();
    this.broadcastState();
  }

  protected startNewGame(): void {
    if (!this.isHost()) return;
    this.beginNewGame();
  }

  protected leaveGame(): void {
    void this.router.navigate(['/']);
  }

  private async initialize(): Promise<void> {
    const code = this.route.snapshot.paramMap.get('code') ?? '';
    const pseudo = this.roomService.readPseudo(code);
    if (!code || !pseudo) {
      this.error.set('Vous n’avez pas accès à cette salle.');
      this.isLoading.set(false);
      return;
    }
    this.roomCode.set(code);

    try {
      const snapshot = await this.roomService.getRoom(code, pseudo);
      if (snapshot.gameType !== 'portrait' || snapshot.status !== 'playing') {
        await this.router.navigate(['/salon', code]);
        return;
      }
      this.mySeat = snapshot.mySeat;
      this.isHost.set(snapshot.mySeat === 0);
      this.players.set([...snapshot.players].sort((a, b) => a.seat - b.seat).map((p) => ({ seat: p.seat, pseudo: p.pseudo })));
      this.unsubscribeRoom = this.roomService.subscribeToRoomPicks(
        code,
        undefined,
        (status, gameType) => {
          if (status === 'lobby') void this.router.navigate(['/salon', code]);
          else if (status === 'playing' && gameType === 'athletes') {
            void this.router.navigate(['/salon', code, 'jouer']);
          } else if (status === 'playing' && gameType === 'paint') {
            void this.router.navigate(['/salon', code, 'peindre']);
          }
        },
      );

      this.channel = this.supabase.channel(`portrait-${code}`);
      this.channel.on('broadcast', { event: 'portrait' }, (message: { payload: unknown }) => {
        this.handleBroadcast(message.payload);
      });
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Le canal du portrait ne répond pas.')), 10_000);
        this.channel?.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timeout);
            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timeout);
            reject(new Error('Connexion au jeu impossible.'));
          }
        });
      });
      this.animationFrame = requestAnimationFrame((time) => this.drawFrame(time));
      this.isLoading.set(false);

      if (this.isHost()) this.beginNewGame();
      else await this.channel.send({ type: 'broadcast', event: 'portrait', payload: { type: 'request-state', seat: this.mySeat } });
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Impossible de rejoindre le jeu.');
      this.isLoading.set(false);
    }
  }

  private beginNewGame(): void {
    this.stopObservationTimer();
    this.model = this.portraitService.generateModel();
    const seats = this.players().map((player) => player.seat);
    this.turns = this.portraitService.createTurnSequence(this.model, seats);
    this.turnIndex = 0;
    this.placements = {};
    this.pendingX = null;
    this.movementStartedAt = Date.now();
    this.revision += 1;
    this.phase.set('observation');
    this.observationSeconds.set(OBSERVATION_SECONDS);
    this.score.set(0);
    this.updateInterface();
    this.broadcastState();

    this.observationTimer = setInterval(() => {
      const remaining = this.observationSeconds() - 1;
      this.observationSeconds.set(remaining);
      this.broadcastState();
      if (remaining <= 0) {
        if (this.observationTimer) clearInterval(this.observationTimer);
        this.observationTimer = null;
        this.phase.set('reproduction');
        this.turnIndex = 0;
        this.pendingX = null;
        this.movementStartedAt = Date.now();
        this.updateInterface();
        this.broadcastState();
      }
    }, 1000);
  }

  private finishGame(): void {
    if (!this.model) return;
    this.stopObservationTimer();
    this.phase.set('results');
    const finalScore = this.portraitService.calculateScore(this.model, this.placements);
    this.score.set(finalScore);
    this.updateInterface();
    this.broadcastState();
  }

  private updateInterface(): void {
    const turn = this.turns[this.turnIndex];
    if (turn) {
      const player = this.players().find((candidate) => candidate.seat === turn.seat);
      this.activePlayer.set(player?.pseudo ?? `Joueur ${turn.seat + 1}`);
      this.activeStep.set(turn.step);
    } else if (this.phase() === 'results') {
      this.activePlayer.set('Portrait terminé');
    }
  }

  private handleBroadcast(payload: unknown): void {
    if (!payload || typeof payload !== 'object') return;
    const broadcast = payload as PortraitBroadcast;
    if (broadcast.type === 'request-state') {
      if (this.isHost() && this.model) this.broadcastState();
      return;
    }
    if (broadcast.type !== 'state' || !broadcast.state) return;
    const state = broadcast.state;
    if (state.revision < this.revision) return;

    this.revision = state.revision;
    this.phase.set(state.phase);
    this.model = state.model;
    this.turns = state.turns;
    this.turnIndex = state.turnIndex;
    this.placements = state.placements;
    this.observationSeconds.set(state.observationSeconds);
    this.score.set(state.score);
    this.movementStartedAt = state.movementStartedAt;
    this.pendingX = state.pendingX;
    this.movingX = state.movingX;
    this.movingY = state.movingY;
    this.updateInterface();

    if (!this.isHost() && state.phase === 'observation') this.stopObservationTimer();
  }

  private broadcastState(): void {
    if (!this.channel) return;
    const state: PortraitGameState = {
      phase: this.phase(),
      model: this.model,
      turns: this.turns,
      turnIndex: this.turnIndex,
      placements: this.placements,
      observationSeconds: this.observationSeconds(),
      score: this.score(),
      revision: this.revision,
      movementStartedAt: this.movementStartedAt,
      pendingX: this.pendingX,
      movingX: this.movingX,
      movingY: this.movingY,
    };
    void this.channel.send({ type: 'broadcast', event: 'portrait', payload: { type: 'state', seat: this.mySeat, state } });
  }

  private stopTimers(): void {
    this.stopObservationTimer();
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  private stopObservationTimer(): void {
    if (this.observationTimer) clearInterval(this.observationTimer);
    this.observationTimer = null;
  }

  private drawFrame(time: number): void {
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      const delta = this.lastFrameTime ? Math.min(32, time - this.lastFrameTime) : 16;
      this.lastFrameTime = time;
      this.updateMovingPosition(delta);
      this.drawCanvas(canvas);
    }
    if (this.phase() === 'results') {
      if (this.modelCanvasRef?.nativeElement) this.drawCanvas(this.modelCanvasRef.nativeElement, true);
      if (this.reconstructedCanvasRef?.nativeElement) this.drawCanvas(this.reconstructedCanvasRef.nativeElement, false);
    }
    this.animationFrame = requestAnimationFrame((nextTime) => this.drawFrame(nextTime));
  }

  private updateMovingPosition(delta: number): void {
    if (this.phase() !== 'reproduction') return;
    const turn = this.turns[this.turnIndex];
    if (!turn) return;
    const elapsed = Math.max(0, Date.now() - this.movementStartedAt);
    const angle = elapsed * 0.0022;
    if (turn.step === 'x') {
      this.movingX = 0.50 + Math.sin(angle) * 0.42;
    } else {
      this.movingY = 0.50 + Math.sin(angle) * 0.38;
    }
  }

  private drawCanvas(canvas: HTMLCanvasElement, modelOnly = false): void {
    const context = canvas.getContext('2d');
    if (!context) return;
    context.clearRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.fillStyle = '#fffaf3';
    context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    context.fillStyle = '#f2c6a0';
    context.strokeStyle = '#5d3a2a';
    context.lineWidth = 10;
    context.beginPath();
    context.ellipse(CANVAS_WIDTH / 2, 390, 260, 300, 0, 0, Math.PI * 2);
    context.fill();
    context.stroke();

    if (!this.model) return;
    if (this.phase() === 'observation') {
      for (const element of this.model.elements) this.drawElement(context, element, element.target);
    } else if (this.phase() === 'reproduction') {
      const currentTurn = this.turns[this.turnIndex];
      for (const element of this.model.elements) {
        if (element.id === currentTurn?.elementId) continue;
        const position = this.placements[element.id];
        if (position) this.drawElement(context, element, position);
      }
      const turn = this.turns[this.turnIndex];
      if (turn) {
        const element = this.model.elements.find((candidate) => candidate.id === turn.elementId);
        if (element) {
          const position = turn.step === 'x'
            ? { x: this.movingX, y: 0.50 }
            : { x: this.pendingX ?? 0.50, y: this.movingY };
          this.drawElement(context, element, position);
        }
      }
    } else if (this.phase() === 'results') {
      if (modelOnly) {
        for (const element of this.model.elements) this.drawElement(context, element, element.target);
      } else {
        for (const element of this.model.elements) {
          const position = this.placements[element.id] ?? { x: 0.5, y: 0.5 };
          this.drawElement(context, element, position);
        }
      }
    }
  }

  private drawElement(context: CanvasRenderingContext2D, element: PortraitElement, position: NormalizedPosition): void {
    const width = element.width * CANVAS_WIDTH;
    const height = element.height * CANVAS_HEIGHT;
    const image = this.getImage(element.svg);
    if (image.complete) {
      context.drawImage(image, position.x * CANVAS_WIDTH - width / 2, position.y * CANVAS_HEIGHT - height / 2, width, height);
    }
  }

  private getImage(svg: string): HTMLImageElement {
    const cached = this.imageCache.get(svg);
    if (cached) return cached;
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    this.imageCache.set(svg, image);
    return image;
  }
}
