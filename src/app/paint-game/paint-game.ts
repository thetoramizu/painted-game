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
const SPRAY_SPACING = 18;
const SPRAY_DROPLETS = 34;
const MAX_STROKE_POINTS = 9_000;
const PAINT_CANVAS_WIDTH = 1200;
const PAINT_CANVAS_HEIGHT = 720;

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
  protected readonly isRestarting = signal(false);
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
  private readonly seenStrokeIds = new Set<string>();
  private gameState: PaintGameState | null = null;
  private strokeRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private gameStateRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  private drawnModelGeneratedAt: number | null = null;
  private gameClockTimer: ReturnType<typeof setInterval> | null = null;
  private revealRefreshTimer: ReturnType<typeof setInterval> | null = null;
  private revealRequestTimeout: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeRoom?: () => void;

  ngAfterViewInit(): void {
    const canvas = this.canvasElement.nativeElement;
    this.context = this.configureCanvas(canvas);
    this.modelContext = this.configureCanvas(this.modelCanvasElement.nativeElement);
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
    if (this.strokeRefreshTimer) clearTimeout(this.strokeRefreshTimer);
    if (this.gameStateRefreshTimer) clearTimeout(this.gameStateRefreshTimer);
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
    this.seenStrokeIds.add(stroke.id);
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
    const distance = Math.hypot(
      (point.x - stroke.lastNozzle.x) * PAINT_CANVAS_WIDTH,
      (point.y - stroke.lastNozzle.y) * PAINT_CANVAS_HEIGHT,
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
    void this.finishActiveStroke().catch((error: unknown) => {
      this.showError(error, 'Impossible d’enregistrer cette pulvérisation.');
    });
  }

  private finishActiveStroke(): Promise<void> {
    const stroke = this.activeLocalStroke;
    if (!stroke) return Promise.resolve();

    this.flushPendingPoints(stroke);
    this.activeLocalStroke = null;
    this.activePointerId = null;
    this.sendEvent({
      strokeId: stroke.id,
      seat: stroke.seat,
      color: stroke.color,
      type: 'end',
    });
    const roomCode = this.roomCode();
    const token = this.roomService.readToken(roomCode);
    if (!token) {
      this.showError(new Error('Votre session de salle est introuvable.'), 'Impossible d’enregistrer cette pulvérisation.');
      return Promise.reject(new Error('Votre session de salle est introuvable.'));
    }
    return this.paintService.saveStroke(stroke, roomCode, token)
      .then(() => this.paintService.notifyStrokeSaved().catch((error: unknown) => {
        this.showError(error, 'La synchronisation des traits enregistrés a échoué.');
      }));
  }

  protected requestModel(): void {
    const seat = this.sessionInfo()?.mySeat;
    if (seat === undefined || !this.canRequestModel()) return;

    this.modelRevealPending.set(true);
    const token = this.roomService.readToken(this.roomCode());
    if (!token) {
      this.modelRevealPending.set(false);
      this.showError(new Error('Votre session de salle est introuvable.'), 'Impossible de demander à revoir le modèle.');
      return;
    }
    void this.finishActiveStroke()
      .then(() => this.paintService.requestModelReveal(this.roomCode(), token))
      .then(async (state) => {
        this.updateGameState(state);
        await this.paintService.notifyGameStateChanged();
      })
      .catch((error: unknown) => {
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
    if (!modelContext || !this.context) {
      this.connectionError.set('Impossible de calculer le score de la toile.');
      return;
    }

    const roomCode = this.roomCode();
    const token = this.roomService.readToken(roomCode);
    if (!token) {
      this.connectionError.set('Votre session de salle est introuvable.');
      return;
    }

    this.isEnding.set(true);
    this.connectionError.set(null);
    try {
      await this.finishActiveStroke();
      const savedStrokes = await this.paintService.getStrokes(roomCode, token);
      const scoringCanvas = document.createElement('canvas');
      scoringCanvas.width = paintCanvas.width;
      scoringCanvas.height = paintCanvas.height;
      const scoringContext = scoringCanvas.getContext('2d');
      if (!scoringContext) throw new Error('Impossible de préparer le calcul du score.');
      const scoringScale = scoringCanvas.width / PAINT_CANVAS_WIDTH;
      scoringContext.setTransform(scoringScale, 0, 0, scoringScale, 0, 0);
      this.clearCanvas(scoringCanvas, scoringContext);
      for (const stroke of savedStrokes) {
        this.drawSpray(stroke.points, stroke.color, 1, scoringContext);
      }

      const score = this.paintService.calculateSimilarity(
        modelContext.getImageData(0, 0, modelCanvas.width, modelCanvas.height),
        scoringContext.getImageData(0, 0, scoringCanvas.width, scoringCanvas.height),
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
    const token = this.roomService.readToken(code);
    if (!this.isHost() || !code || !token || this.isReturning()) return;

    this.isReturning.set(true);
    this.connectionError.set(null);
    try {
      await this.roomService.finishPaintGame(code, token);
      await this.router.navigate(['/salon', code]);
    } catch (error) {
      this.showError(error, 'Impossible de retourner au salon.');
    } finally {
      this.isReturning.set(false);
    }
  }

  protected async returnToLobbyAsPlayer(): Promise<void> {
    const code = this.roomCode();
    if (!code) return;
    await this.router.navigate(['/salon', code]);
  }

  protected async restartGame(): Promise<void> {
    if (!this.isHost() || this.phase() !== 'results' || this.isRestarting()) return;
    const code = this.roomCode();
    const token = this.roomService.readToken(code);
    if (!token) {
      this.connectionError.set('Votre session de salle est introuvable.');
      return;
    }
    this.isRestarting.set(true);
    this.connectionError.set(null);
    try {
      const { data, error } = await this.paintService.restartGame(code, token);
      if (error) throw new Error(error.message || 'Impossible de relancer la toile.');
      const result = Array.isArray(data) ? data[0] : data;
      if (!result || typeof result !== 'object' || !('success' in result) || result.success !== true) {
        throw new Error(
          result && typeof result === 'object' && 'message' in result && typeof result.message === 'string'
            ? result.message
            : 'Impossible de relancer la toile.'
        );
      }
      this.resetLocalPaintSurface();
      this.beginGame();
    } catch (error) {
      this.showError(error, 'Impossible de relancer la toile.');
    } finally {
      this.isRestarting.set(false);
    }
  }

  protected leaveRoom(): void {
    if (!window.confirm('Quitter la partie ? Votre progression restera enregistrée dans cette salle.')) return;
    void this.router.navigate(['/salon', this.roomCode()], { queryParams: { stay: '1' } });
  }

  private async initializeGame(): Promise<void> {
    const code = this.route.snapshot.paramMap.get('code') ?? '';
    const token = this.roomService.readToken(code);
    if (!code || !token) {
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
      const snapshot = await this.roomService.getRoom(code, token);
      if (snapshot.gameType !== 'paint' || snapshot.status !== 'playing') {
        await this.router.navigate(['/salon', code]);
        return;
      }

      this.paintService.setSessionInfo(snapshot);
      const strokes = await this.paintService.joinPaintChannel(
        code,
        snapshot.mySeat,
        token,
        (event) => this.handleRemoteStroke(event),
        () => this.scheduleStrokeRefresh(),
        (event) => this.handleGameEvent(event),
      );
      for (const stroke of strokes.strokes) {
        this.savedStrokeIds.add(stroke.id);
        this.seenStrokeIds.add(stroke.id);
        this.drawSavedStroke(stroke);
      }
      if (strokes.state) this.updateGameState(strokes.state);
      this.canvasReady = true;

      for (const event of this.pendingRemoteEvents.splice(0)) {
        if (!this.savedStrokeIds.has(event.strokeId)) this.applyRemoteStroke(event);
      }

      if (snapshot.mySeat === 0 && !strokes.state) this.beginGame();
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
    void this.broadcastGameState();
  }

  private advanceGameClock(): void {
    if (!this.gameState) {
      this.stopGameClock();
      return;
    }
    const roomCode = this.roomCode();
    const token = this.roomService.readToken(roomCode);
    if (!token) return;

    void this.paintService.tickGameState(roomCode, token)
      .then(async (state) => {
        if (!state) return;
        if (state.revision > (this.gameState?.revision ?? -1)) {
          this.updateGameState(state);
          await this.paintService.notifyGameStateChanged();
        }
        if (this.isHost() && state.phase === 'painting' && state.paintingSeconds === 0) {
          this.stopGameClock();
          await this.completeReproduction();
        }
      })
      .catch((error: unknown) => {
        this.showError(error, 'Impossible de mettre à jour le minuteur de la partie.');
      });
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
    this.seenStrokeIds.add(event.strokeId);
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
    if (event.type === 'state-changed') this.scheduleGameStateRefresh();
  }

  private updateGameState(state: PaintGameState): void {
    const previousPhase = this.phase();
    this.gameState = state;
    if (previousPhase === 'results' && state.phase === 'observation') {
      this.resetLocalPaintSurface();
    }
    if (state.phase === 'results') {
      this.stopGameClock();
    } else if (!this.gameClockTimer) {
      this.gameClockTimer = setInterval(() => this.advanceGameClock(), 1_000);
    }
    this.hasGameState.set(true);
    this.paintService.setPlayerColors(state.playerColors);
    this.phase.set(state.phase);
    this.observationSeconds.set(state.observationSeconds);
    this.paintingSeconds.set(state.paintingSeconds);
    this.score.set(state.score);
    const seat = this.sessionInfo()?.mySeat;
    const revealUntil = seat === undefined ? 0 : (state.revealUntilBySeat[String(seat)] ?? 0);
    this.modelRevealSeconds.set(Math.max(0, Math.ceil((revealUntil - Date.now()) / 1_000)));
    if (state.phase === 'painting' && this.modelRevealSeconds() > 0) {
      void this.finishActiveStroke().catch((error: unknown) => {
        this.showError(error, 'Impossible d’enregistrer cette pulvérisation.');
      });
    }
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
    const roomCode = this.roomCode();
    const token = this.roomService.readToken(roomCode);
    if (!token) {
      this.showError(new Error('Votre session de salle est introuvable.'), 'La synchronisation de la partie a échoué.');
      return;
    }
    try {
      const saved = await this.paintService.saveGameState(this.gameState, roomCode, token);
      if (!saved) {
        const latestState = await this.paintService.getPaintGameState(roomCode, token);
        if (latestState && latestState.revision >= (this.gameState?.revision ?? -1)) {
          this.updateGameState(latestState);
        }
        return;
      }
      await this.paintService.notifyGameStateChanged();
    } catch (error) {
      this.showError(error, 'La synchronisation de la partie a échoué.');
    }
  }

  private scheduleStrokeRefresh(): void {
    if (this.strokeRefreshTimer) return;
    this.strokeRefreshTimer = setTimeout(() => {
      this.strokeRefreshTimer = null;
      void this.refreshSavedStrokes();
    }, 250);
  }

  private async refreshSavedStrokes(): Promise<void> {
    const roomCode = this.roomCode();
    const token = this.roomService.readToken(roomCode);
    if (!token) return;
    try {
      const strokes = await this.paintService.getStrokes(roomCode, token);
      for (const stroke of strokes) {
        if (this.savedStrokeIds.has(stroke.id)) continue;
        this.savedStrokeIds.add(stroke.id);
        if (this.seenStrokeIds.has(stroke.id)) continue;
        this.seenStrokeIds.add(stroke.id);
        this.drawSavedStroke(stroke);
      }
    } catch (error) {
      this.showError(error, 'Impossible de synchroniser les traits enregistrés.');
    }
  }

  private scheduleGameStateRefresh(): void {
    if (this.gameStateRefreshTimer) return;
    this.gameStateRefreshTimer = setTimeout(() => {
      this.gameStateRefreshTimer = null;
      void this.refreshGameState();
    }, 250);
  }

  private async refreshGameState(): Promise<void> {
    const roomCode = this.roomCode();
    const token = this.roomService.readToken(roomCode);
    if (!token) return;
    try {
      const state = await this.paintService.getPaintGameState(roomCode, token);
      if (state && state.revision > (this.gameState?.revision ?? -1)) this.updateGameState(state);
    } catch (error) {
      this.showError(error, 'Impossible de synchroniser l’état de la partie.');
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
  ): void {
    if (!context) return;
    context.fillStyle = color;
    for (const point of points) {
      context.globalAlpha = (0.28 + Math.min(point.radius ?? 2.5, 5) * 0.07) * opacity;
      context.beginPath();
      context.arc(
        point.x * PAINT_CANVAS_WIDTH,
        point.y * PAINT_CANVAS_HEIGHT,
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
    this.clearCanvas(this.modelCanvasElement.nativeElement, context);

    for (const mark of model.marks) {
      context.save();
      context.beginPath();
      context.strokeStyle = mark.color;
      context.fillStyle = mark.color;
      context.shadowColor = mark.color;
      context.globalAlpha = mark.opacity;
      if (mark.kind === 'oval') {
        traceOrganicBlob(context, mark.points, PAINT_CANVAS_WIDTH, PAINT_CANVAS_HEIGHT);
        context.shadowBlur = 18;
        context.fill();
      } else {
        traceSmoothPath(context, mark.points, PAINT_CANVAS_WIDTH, PAINT_CANVAS_HEIGHT);
        context.lineCap = 'round';
        context.lineJoin = 'round';
        context.lineWidth = mark.width * PAINT_CANVAS_WIDTH;
        context.shadowBlur = Math.max(14, mark.width * PAINT_CANVAS_WIDTH * 0.16);
        context.stroke();
      }
      context.restore();
    }
  }

  private clearCanvas(canvas: HTMLCanvasElement, context: CanvasRenderingContext2D): void {
    context.clearRect(0, 0, PAINT_CANVAS_WIDTH, PAINT_CANVAS_HEIGHT);
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, PAINT_CANVAS_WIDTH, PAINT_CANVAS_HEIGHT);
  }

  private resetLocalPaintSurface(): void {
    this.activeLocalStroke = null;
    this.activePointerId = null;
    this.pendingLocalPoints.length = 0;
    this.pendingRemoteEvents.length = 0;
    this.savedStrokeIds.clear();
    this.seenStrokeIds.clear();
    this.drawnModelGeneratedAt = null;
    if (this.context) this.clearCanvas(this.canvasElement.nativeElement, this.context);
    if (this.modelContext) this.clearCanvas(this.modelCanvasElement.nativeElement, this.modelContext);
  }

  private configureCanvas(canvas: HTMLCanvasElement): CanvasRenderingContext2D | null {
    const devicePixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(PAINT_CANVAS_WIDTH * devicePixelRatio);
    canvas.height = Math.round(PAINT_CANVAS_HEIGHT * devicePixelRatio);
    const context = canvas.getContext('2d');
    context?.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    return context;
  }

  private createSprayBurst(center: PaintPoint): PaintPoint[] {
    return Array.from({ length: SPRAY_DROPLETS }, () => {
      const angle = Math.random() * Math.PI * 2;
      const distance = Math.sqrt(Math.random()) * 20;
      return {
        x: Math.max(0, Math.min(1, center.x + Math.cos(angle) * distance / PAINT_CANVAS_WIDTH)),
        y: Math.max(0, Math.min(1, center.y + Math.sin(angle) * distance / PAINT_CANVAS_HEIGHT)),
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
