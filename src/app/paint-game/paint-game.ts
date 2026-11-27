import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { RoomService, type GameType, type RoomStatus } from '../athletes/services/room.service';
import {
  OBSERVATION_DURATION_SECONDS,
  PAINTING_DURATION_SECONDS,
  PaintService,
  type PaintGameEvent,
  type PaintGameState,
  type PaintModel,
  type PaintModelMark,
  type PaintPhase,
  type PaintPoint,
  type PaintStroke,
  type PaintStrokeEvent,
} from './services/paint.service';

interface ActiveStroke extends PaintStroke {
  lastNozzle: PaintPoint;
}

const MODEL_REVEAL_MS = 5_000;
const SPRAY_SPACING = 14;
const SPRAY_DROPLETS = 26;
const MAX_STROKE_POINTS = 9_000;

@Component({
  selector: 'app-paint-game',
  templateUrl: './paint-game.html',
  styleUrl: './paint-game.css',
})
export class PaintGame implements AfterViewInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roomService = inject(RoomService);
  private readonly paintService = inject(PaintService);

  @ViewChild('paintCanvas', { static: true })
  private readonly canvasElement!: ElementRef<HTMLCanvasElement>;

  @ViewChild('modelCanvas', { static: true })
  private readonly modelCanvasElement!: ElementRef<HTMLCanvasElement>;

  protected readonly roomCode = signal('');
  protected readonly isLoading = signal(true);
  protected readonly isEnding = signal(false);
  protected readonly isReturning = signal(false);
  protected readonly connectionError = signal<string | null>(null);
  protected readonly sessionInfo = this.paintService.sessionInfo;
  protected readonly phase = signal<PaintPhase>('observation');
  protected readonly observationSeconds = signal(OBSERVATION_DURATION_SECONDS);
  protected readonly paintingSeconds = signal(PAINTING_DURATION_SECONDS);
  protected readonly score = signal<number | null>(null);
  protected readonly modelRevealSeconds = signal(0);
  protected readonly modelRevealPending = signal(false);
  protected readonly hasGameState = signal(false);

  private context: CanvasRenderingContext2D | null = null;
  private modelContext: CanvasRenderingContext2D | null = null;
  private canvasReady = false;
  private activeLocalStroke: ActiveStroke | null = null;
  private activePointerId: number | null = null;
  private readonly pendingLocalPoints: PaintPoint[] = [];
  private lastMoveBroadcastAt = 0;
  private readonly pendingRemoteEvents: PaintStrokeEvent[] = [];
  private readonly savedStrokeIds = new Set<string>();
  private gameState: PaintGameState | null = null;
  private drawnModelGeneratedAt: number | null = null;
  private gameClockTimer: ReturnType<typeof setInterval> | null = null;
  private revealRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private revealRequestTimeout: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeRoom?: () => void;

  ngAfterViewInit(): void {
    const canvas = this.canvasElement.nativeElement;
    this.context = canvas.getContext('2d');
    this.modelContext = this.modelCanvasElement.nativeElement.getContext('2d');
    if (!this.context || !this.modelContext) {
      this.connectionError.set('Le navigateur ne permet pas de dessiner sur cette toile.');
      this.isLoading.set(false);
      return;
    }

    this.clearCanvas(canvas, this.context);
    this.clearCanvas(this.modelCanvasElement.nativeElement, this.modelContext);
    void this.initializeGame();
  }

  ngOnDestroy(): void {
    this.stopGameClock();
    this.stopRevealRefreshTimer();
    if (this.revealRequestTimeout) clearTimeout(this.revealRequestTimeout);
    this.unsubscribeRoom?.();
    this.paintService.leavePaintChannel();
  }

  protected isHost(): boolean {
    return this.sessionInfo()?.mySeat === 0;
  }

  protected isModelVisible(): boolean {
    if (this.phase() === 'observation' || this.phase() === 'results') return true;
    return this.modelRevealSeconds() > 0;
  }

  protected canRequestModel(): boolean {
    const seat = this.sessionInfo()?.mySeat;
    return Boolean(
      seat !== undefined &&
      this.phase() === 'painting' &&
      !this.gameState?.revealUsedSeats.includes(seat) &&
      !this.modelRevealPending()
    );
  }

  protected startDrawing(event: PointerEvent): void {
    const session = this.sessionInfo();
    if (
      !this.canvasReady ||
      this.phase() !== 'painting' ||
      this.modelRevealSeconds() > 0 ||
      !session ||
      this.activeLocalStroke ||
      event.button !== 0
    ) {
      return;
    }

    event.preventDefault();
    const point = this.getPoint(event);
    const droplets = this.createSprayBurst(point);
    const stroke: ActiveStroke = {
      id: crypto.randomUUID(),
      seat: session.mySeat,
      color: this.paintService.getSeatColor(session.mySeat),
      points: droplets,
      lastNozzle: point,
    };
    this.activeLocalStroke = stroke;
    this.activePointerId = event.pointerId;
    this.pendingLocalPoints.length = 0;
    this.lastMoveBroadcastAt = 0;
    this.canvasElement.nativeElement.setPointerCapture(event.pointerId);
    this.drawSpray(droplets, stroke.color);
    this.sendEvent({
      strokeId: stroke.id,
      seat: stroke.seat,
      color: stroke.color,
      type: 'start',
      points: droplets,
    });
  }

  protected continueDrawing(event: PointerEvent): void {
    const stroke = this.activeLocalStroke;
    if (
      !stroke ||
      event.pointerId !== this.activePointerId ||
      this.phase() !== 'painting' ||
      this.modelRevealSeconds() > 0
    ) {
      return;
    }

    event.preventDefault();
    const point = this.getPoint(event);
    const canvas = this.canvasElement.nativeElement;
    const distance = Math.hypot(
      (point.x - stroke.lastNozzle.x) * canvas.width,
      (point.y - stroke.lastNozzle.y) * canvas.height,
    );
    if (distance < SPRAY_SPACING * 0.6) return;

    const steps = Math.max(1, Math.ceil(distance / SPRAY_SPACING));
    for (let step = 1; step <= steps; step += 1) {
      if (stroke.points.length >= MAX_STROKE_POINTS) break;
      const progress = step / steps;
      const nozzle = {
        x: stroke.lastNozzle.x + (point.x - stroke.lastNozzle.x) * progress,
        y: stroke.lastNozzle.y + (point.y - stroke.lastNozzle.y) * progress,
      };
      const droplets = this.createSprayBurst(nozzle).slice(0, MAX_STROKE_POINTS - stroke.points.length);
      stroke.points.push(...droplets);
      this.pendingLocalPoints.push(...droplets);
      this.drawSpray(droplets, stroke.color);
    }
    stroke.lastNozzle = point;

    if (Date.now() - this.lastMoveBroadcastAt >= 50) this.flushPendingPoints(stroke);
  }

  protected finishDrawing(event: PointerEvent): void {
    const stroke = this.activeLocalStroke;
    if (!stroke || event.pointerId !== this.activePointerId) return;

    event.preventDefault();
    this.finishActiveStroke();
  }

  private finishActiveStroke(): void {
    const stroke = this.activeLocalStroke;
    if (!stroke) return;

    this.flushPendingPoints(stroke);
    this.activeLocalStroke = null;
    this.activePointerId = null;
    this.sendEvent({
      strokeId: stroke.id,
      seat: stroke.seat,
      color: stroke.color,
      type: 'end',
    });
    void this.paintService.saveStroke(stroke, this.roomCode()).catch((error: unknown) => {
      this.showError(error, 'Impossible d’enregistrer cette pulvérisation.');
    });
  }

  protected requestModel(): void {
    const seat = this.sessionInfo()?.mySeat;
    if (seat === undefined || !this.canRequestModel()) return;

    this.finishActiveStroke();
    this.modelRevealPending.set(true);
    if (this.isHost()) {
      this.grantModelReveal(seat);
      return;
    }
    void this.paintService.sendGameEvent({ type: 'request-model', seat }).catch((error: unknown) => {
      this.modelRevealPending.set(false);
      this.showError(error, 'Impossible de demander à revoir le modèle.');
    });
    this.revealRequestTimeout = setTimeout(() => this.modelRevealPending.set(false), 3_000);
  }

  protected async finishReproduction(): Promise<void> {
    if (!this.isHost() || this.phase() !== 'painting' || this.isEnding() || !this.gameState) return;
    if (!window.confirm('Terminer la reproduction et afficher le score collectif ?')) return;

    await this.completeReproduction();
  }

  private async completeReproduction(): Promise<void> {
    if (!this.isHost() || this.phase() !== 'painting' || this.isEnding() || !this.gameState) return;

    const modelCanvas = this.modelCanvasElement.nativeElement;
    const paintCanvas = this.canvasElement.nativeElement;
    const modelContext = this.modelContext;
    const paintContext = this.context;
    if (!modelContext || !paintContext) {
      this.connectionError.set('Impossible de calculer le score de la toile.');
      return;
    }

    this.isEnding.set(true);
    this.connectionError.set(null);
    try {
      const score = this.paintService.calculateSimilarity(
        modelContext.getImageData(0, 0, modelCanvas.width, modelCanvas.height),
        paintContext.getImageData(0, 0, paintCanvas.width, paintCanvas.height),
      );
      this.updateGameState({
        ...this.gameState,
        phase: 'results',
        score,
        revision: this.gameState.revision + 1,
      });
      await this.broadcastGameState();
    } catch (error) {
      this.showError(error, 'Impossible de calculer ou partager le score collectif.');
    } finally {
      this.isEnding.set(false);
    }
  }

  protected async returnToLobby(): Promise<void> {
    const code = this.roomCode();
    const pseudo = this.roomService.readPseudo(code);
    if (!this.isHost() || !code || !pseudo || this.isReturning()) return;

    this.isReturning.set(true);
    this.connectionError.set(null);
    try {
      await this.roomService.finishPaintGame(code, pseudo);
      await this.router.navigate(['/salon', code]);
    } catch (error) {
      this.showError(error, 'Impossible de retourner au salon.');
    } finally {
      this.isReturning.set(false);
    }
  }

  protected leaveRoom(): void {
    void this.router.navigate(['/']);
  }

  private async initializeGame(): Promise<void> {
    const code = this.route.snapshot.paramMap.get('code') ?? '';
    const pseudo = this.roomService.readPseudo(code);
    if (!code || !pseudo || !this.roomService.readToken(code)) {
      this.connectionError.set('Vous n’avez pas accès à cette salle.');
      this.isLoading.set(false);
      void this.router.navigate(['/']);
      return;
    }
    this.roomCode.set(code);

    this.unsubscribeRoom = this.roomService.subscribeToRoomPicks(
      code,
      undefined,
      (status, gameType) => this.handleRoomStatus(code, status, gameType),
    );

    try {
      const snapshot = await this.roomService.getRoom(code, pseudo);
      if (snapshot.gameType !== 'paint' || snapshot.status !== 'playing') {
        await this.router.navigate(['/salon', code]);
        return;
      }

      this.paintService.setSessionInfo(snapshot);
      const strokes = await this.paintService.joinPaintChannel(
        code,
        snapshot.mySeat,
        (event) => this.handleRemoteStroke(event),
        (event) => this.handleGameEvent(event),
      );
      for (const stroke of strokes) {
        this.savedStrokeIds.add(stroke.id);
        this.drawSavedStroke(stroke);
      }
      this.canvasReady = true;

      for (const event of this.pendingRemoteEvents.splice(0)) {
        if (!this.savedStrokeIds.has(event.strokeId)) this.applyRemoteStroke(event);
      }

      if (snapshot.mySeat === 0) this.beginGame();
      else {
        await this.paintService.sendGameEvent({ type: 'request-state', seat: snapshot.mySeat });
      }
    } catch (error) {
      this.showError(error, 'Impossible de rejoindre la toile.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private beginGame(): void {
    const players = this.sessionInfo()?.players ?? [];
    const playerColors = this.paintService.generatePlayerColors(players.length);
    this.paintService.setPlayerColors(playerColors);
    const model = this.paintService.generateModel(
      players.length,
      playerColors,
    );
    this.stopGameClock();
    this.updateGameState({
      phase: 'observation',
      model,
      playerColors,
      observationSeconds: OBSERVATION_DURATION_SECONDS,
      paintingSeconds: PAINTING_DURATION_SECONDS,
      score: null,
      revision: (this.gameState?.revision ?? 0) + 1,
      revealUsedSeats: [],
      revealUntilBySeat: {},
    });
    this.gameClockTimer = setInterval(() => this.advanceGameClock(), 1_000);
    void this.broadcastGameState();
  }

  private advanceGameClock(): void {
    const state = this.gameState;
    if (!state) {
      this.stopGameClock();
      return;
    }

    if (state.phase === 'observation') {
      const observationSeconds = Math.max(0, state.observationSeconds - 1);
      this.updateGameState({
        ...state,
        phase: observationSeconds === 0 ? 'painting' : 'observation',
        observationSeconds,
        paintingSeconds: PAINTING_DURATION_SECONDS,
        revision: state.revision + 1,
      });
      void this.broadcastGameState();
      return;
    }

    if (state.phase === 'painting') {
      const paintingSeconds = Math.max(0, state.paintingSeconds - 1);
      this.updateGameState({
        ...state,
        paintingSeconds,
        revision: state.revision + 1,
      });
      void this.broadcastGameState();
      if (paintingSeconds === 0) {
        this.stopGameClock();
        void this.completeReproduction();
      }
      return;
    }

    this.stopGameClock();
  }

  private handleRoomStatus(code: string, status: RoomStatus, gameType: GameType | null): void {
    if (status === 'lobby') void this.router.navigate(['/salon', code]);
    else if (status === 'finished') void this.router.navigate(['/']);
    else if (status === 'playing' && gameType === 'athletes') {
      void this.router.navigate(['/salon', code, 'jouer']);
    } else if (status === 'playing' && gameType === 'portrait') {
      void this.router.navigate(['/salon', code, 'portrait']);
    }
  }

  private handleRemoteStroke(event: PaintStrokeEvent): void {
    if (!this.canvasReady) {
      this.pendingRemoteEvents.push(event);
      return;
    }
    this.applyRemoteStroke(event);
  }

  private applyRemoteStroke(event: PaintStrokeEvent): void {
    if (event.points) this.drawSpray(event.points, event.color);
  }

  private handleGameEvent(event: PaintGameEvent): void {
    if (event.type === 'state') {
      if (this.gameState && event.state.revision <= this.gameState.revision) return;
      this.updateGameState(event.state);
      return;
    }
    if (!this.isHost()) return;
    if (event.type === 'request-state') {
      if (this.gameState) void this.broadcastGameState();
    } else {
      this.grantModelReveal(event.seat);
    }
  }

  private grantModelReveal(seat: number): void {
    const state = this.gameState;
    const players = this.sessionInfo()?.players ?? [];
    if (
      !state ||
      state.phase !== 'painting' ||
      !players.some((player) => player.seat === seat) ||
      state.revealUsedSeats.includes(seat)
    ) {
      this.modelRevealPending.set(false);
      return;
    }

    this.updateGameState({
      ...state,
      revision: state.revision + 1,
      revealUsedSeats: [...state.revealUsedSeats, seat],
      revealUntilBySeat: { ...state.revealUntilBySeat, [seat]: Date.now() + MODEL_REVEAL_MS },
    });
    void this.broadcastGameState();
  }

  private updateGameState(state: PaintGameState): void {
    this.gameState = state;
    this.hasGameState.set(true);
    this.paintService.setPlayerColors(state.playerColors);
    this.phase.set(state.phase);
    this.observationSeconds.set(state.observationSeconds);
    this.paintingSeconds.set(state.paintingSeconds);
    this.score.set(state.score);
    const seat = this.sessionInfo()?.mySeat;
    const revealUntil = seat === undefined ? 0 : (state.revealUntilBySeat[String(seat)] ?? 0);
    this.modelRevealSeconds.set(Math.max(0, Math.ceil((revealUntil - Date.now()) / 1_000)));
    if (state.phase === 'painting' && this.modelRevealSeconds() > 0) this.finishActiveStroke();
    if (seat !== undefined && state.revealUsedSeats.includes(seat)) {
      this.modelRevealPending.set(false);
      if (this.revealRequestTimeout) clearTimeout(this.revealRequestTimeout);
      this.revealRequestTimeout = null;
    }
    this.refreshRevealTimer();
    if (this.drawnModelGeneratedAt !== state.model.generatedAt) {
      this.drawnModelGeneratedAt = state.model.generatedAt;
      this.drawModel(state.model);
    }
  }

  private refreshRevealTimer(): void {
    if (!this.modelRevealSeconds()) {
      this.stopRevealRefreshTimer();
      return;
    }
    if (this.revealRefreshTimer) return;
    this.revealRefreshTimer = setInterval(() => {
      const seat = this.sessionInfo()?.mySeat;
      const until = seat === undefined ? 0 : (this.gameState?.revealUntilBySeat[String(seat)] ?? 0);
      this.modelRevealSeconds.set(Math.max(0, Math.ceil((until - Date.now()) / 1_000)));
      if (!this.modelRevealSeconds()) this.stopRevealRefreshTimer();
    }, 250);
  }

  private stopGameClock(): void {
    if (this.gameClockTimer) clearInterval(this.gameClockTimer);
    this.gameClockTimer = null;
  }

  private stopRevealRefreshTimer(): void {
    if (this.revealRefreshTimer) clearInterval(this.revealRefreshTimer);
    this.revealRefreshTimer = null;
  }

  private async broadcastGameState(): Promise<void> {
    if (!this.gameState) return;
    try {
      await this.paintService.sendGameEvent({ type: 'state', state: this.gameState });
    } catch (error) {
      this.showError(error, 'La synchronisation de la partie a échoué.');
    }
  }

  private drawSavedStroke(stroke: PaintStroke): void {
    this.drawSpray(stroke.points, stroke.color);
  }

  private drawSpray(
    points: PaintPoint[],
    color: string,
    opacity = 1,
    context = this.context,
    canvas = this.canvasElement.nativeElement,
  ): void {
    if (!context) return;
    context.fillStyle = color;
    for (const point of points) {
      context.globalAlpha = (0.28 + Math.min(point.radius ?? 2.5, 5) * 0.07) * opacity;
      context.beginPath();
      context.arc(
        point.x * canvas.width,
        point.y * canvas.height,
        point.radius ?? 2.5,
        0,
        Math.PI * 2,
      );
      context.fill();
    }
    context.globalAlpha = 1;
  }

  private drawModel(model: PaintModel): void {
    const context = this.modelContext;
    if (!context) return;
    const canvas = this.modelCanvasElement.nativeElement;
    this.clearCanvas(canvas, context);

    for (const mark of model.marks) {
      context.save();
      context.beginPath();
      context.strokeStyle = mark.color;
      context.fillStyle = mark.color;
      context.shadowColor = mark.color;
      context.globalAlpha = mark.opacity;
      if (mark.kind === 'oval') {
        traceOrganicBlob(context, mark.points, canvas.width, canvas.height);
        context.shadowBlur = 18;
        context.fill();
      } else {
        traceSmoothPath(context, mark.points, canvas.width, canvas.height);
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.lineWidth = mark.width * canvas.width;
        context.shadowBlur = Math.max(14, mark.width * canvas.width * 0.16);
        context.stroke();
      }
      context.restore();
    }
  }

  private clearCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
  }

  private createSprayBurst(center: PaintPoint): PaintPoint[] {
    const canvas = this.canvasElement.nativeElement;
    return Array.from({ length: SPRAY_DROPLETS }, () => {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * 20;
      return {
        x: Math.max(0, Math.min(1, center.x + Math.cos(angle) * distance / canvas.width)),
        y: Math.max(0, Math.min(1, center.y + Math.sin(angle) * distance / canvas.height)),
        radius: 1.2 + Math.random() * 3.2,
      };
    });
  }

  private getPoint(event: PointerEvent): PaintPoint {
    const rect = this.canvasElement.nativeElement.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / Math.max(1, rect.width))),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / Math.max(1, rect.height))),
    };
  }

  private sendEvent(event: PaintStrokeEvent): void {
    void this.paintService.sendStrokeEvent(event).catch((error: unknown) => {
      this.showError(error, 'La synchronisation de la toile a échoué.');
    });
  }

  private flushPendingPoints(stroke: ActiveStroke): void {
    if (!this.pendingLocalPoints.length) return;
    while (this.pendingLocalPoints.length) {
      const points = this.pendingLocalPoints.splice(0, 256);
      this.sendEvent({
        strokeId: stroke.id,
        seat: stroke.seat,
        color: stroke.color,
        type: 'move',
        points,
      });
    }
    this.lastMoveBroadcastAt = Date.now();
  }

  private showError(error: unknown, fallback: string): void {
    this.connectionError.set(error instanceof Error ? error.message : fallback);
  }
}

function traceOrganicBlob(
  context: CanvasRenderingContext2D,
  points: PaintPoint[],
  width: number,
  height: number,
): void {
  const firstPoint = points[0];
  if (!firstPoint || points.length < 3) return;
  context.moveTo(firstPoint.x * width, firstPoint.y * height);

  for (let index = 0; index < points.length; index += 1) {
    const previous = points[(index - 1 + points.length) % points.length];
    const current = points[index];
    const next = points[(index + 1) % points.length];
    const afterNext = points[(index + 2) % points.length];
    if (!previous || !current || !next || !afterNext) continue;

    context.bezierCurveTo(
      (current.x + (next.x - previous.x) / 6) * width,
      (current.y + (next.y - previous.y) / 6) * height,
      (next.x - (afterNext.x - current.x) / 6) * width,
      (next.y - (afterNext.y - current.y) / 6) * height,
      next.x * width,
      next.y * height,
    );
  }
  context.closePath();
}

function traceSmoothPath(
  context: CanvasRenderingContext2D,
  points: PaintModelMark['points'],
  width: number,
  height: number,
): void {
  const firstPoint = points[0];
  if (!firstPoint || points.length < 2) return;
  context.moveTo(firstPoint.x * width, firstPoint.y * height);

  for (let index = 0; index < points.length - 1; index += 1) {
    const previous = points[index - 1] ?? points[index];
    const current = points[index];
    const next = points[index + 1];
    const afterNext = points[index + 2] ?? next;
    if (!previous || !current || !next || !afterNext) continue;

    context.bezierCurveTo(
      (current.x + (next.x - previous.x) / 6) * width,
      (current.y + (next.y - previous.y) / 6) * height,
      (next.x - (afterNext.x - current.x) / 6) * width,
      (next.y - (afterNext.y - current.y) / 6) * height,
      next.x * width,
      next.y * height,
    );
  }
}
