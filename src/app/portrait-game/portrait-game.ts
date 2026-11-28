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
  type: 'state' | 'request-state' | 'assets-ready';
  seat?: number;
  revision?: number;
  state?: PortraitGameState;
}

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 700;
const OBSERVATION_SECONDS = 20;

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
  protected readonly isReturning = signal(false);
  protected readonly isRestarting = signal(false);

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
  private assetsReadyRevision = -1;
  private loadedModelGeneratedAt: number | null = null;
  private loadingModelGeneratedAt: number | null = null;
  private readonly readySeats = new Set<number>();
  private movementStartedAt = 0;
  private readonly imageCache = new Map<string, HTMLImageElement>();

  ngAfterViewInit(): void {
    this.configureCanvas(this.canvasRef?.nativeElement);
    this.configureCanvas(this.modelCanvasRef?.nativeElement);
    this.configureCanvas(this.reconstructedCanvasRef?.nativeElement);
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
    this.revision += 1;
    this.updateInterface();
    this.broadcastState();
    this.drawCanvasNow();
  }

  protected async startNewGame(): Promise<void> {
    if (!this.isHost()) return;
    if (this.isRestarting()) return;
    this.isRestarting.set(true);
    const code = this.roomCode();
    const token = this.roomService.readToken(code);
    if (!token) {
      this.error.set('Votre session de salle est introuvable.');
      this.isRestarting.set(false);
      return;
    }
    try {
      const { data, error } = await this.supabase.rpc('restart_portrait_game', {
        p_code: code,
        p_token: token,
      });
      if (error) throw new Error(error.message || 'Impossible de relancer le portrait.');
      const result = Array.isArray(data) ? data[0] : data;
      if (!isRecord(result) || result['success'] !== true) {
        throw new Error(isRecord(result) && typeof result['message'] === 'string'
          ? result['message']
          : 'Impossible de relancer le portrait.');
      }
      this.beginNewGame();
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Impossible de relancer le portrait.');
    } finally {
      this.isRestarting.set(false);
    }
  }

  protected async returnToLobby(): Promise<void> {
    if (!this.isHost() || this.isReturning()) return;
    const code = this.roomCode();
    const token = this.roomService.readToken(code);
    if (!code || !token) return;
    this.isReturning.set(true);
    try {
      await this.roomService.finishRoomGame(code, token);
      await this.router.navigate(['/salon', code]);
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Impossible de retourner au salon.');
    } finally {
      this.isReturning.set(false);
    }
  }

  protected async returnToLobbyAsPlayer(): Promise<void> {
    const code = this.roomCode();
    if (code) await this.router.navigate(['/salon', code]);
  }

  protected leaveGame(): void {
    if (!window.confirm('Quitter le portrait décalé ? Votre progression restera enregistrée.')) return;
    void this.router.navigate(['/salon', this.roomCode()]);
  }

  private async initialize(): Promise<void> {
    const code = this.route.snapshot.paramMap.get('code') ?? '';
    const token = this.roomService.readToken(code);
    if (!code || !token) {
      this.error.set('Vous n’avez pas accès à cette salle.');
      this.isLoading.set(false);
      return;
    }
    this.roomCode.set(code);

    try {
      const snapshot = await this.roomService.getRoom(code, token);
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
      const stateResponse = await this.supabase.rpc('get_portrait_game_state', {
        p_code: code,
        p_token: token,
      });
      const storedState = stateResponse.error ? null : parsePortraitGameState(stateResponse.data);
      if (storedState) this.applyStoredState(storedState);
      this.drawCanvasNow();
      this.isLoading.set(false);

      if (storedState) {
        if (storedState.phase === 'preparation') {
          if (this.isHost()) this.broadcastState(false);
          void this.prepareModel(storedState.revision);
        } else if (storedState.phase === 'observation') {
          this.startServerClock();
        }
      } else if (this.isHost()) {
        this.beginNewGame();
      } else {
        await this.channel.send({ type: 'broadcast', event: 'portrait', payload: { type: 'request-state', seat: this.mySeat } });
      }
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : 'Impossible de rejoindre le jeu.');
      this.isLoading.set(false);
    }
  }

  private beginNewGame(): void {
    this.stopObservationTimer();
    this.stopRenderLoop();
    this.model = this.portraitService.generateModel();
    this.loadedModelGeneratedAt = null;
    const seats = this.players().map((player) => player.seat);
    this.turns = this.portraitService.createTurnSequence(this.model, seats);
    this.turnIndex = 0;
    this.placements = {};
    this.pendingX = null;
    this.movementStartedAt = Date.now();
    this.revision += 1;
    this.assetsReadyRevision = -1;
    this.readySeats.clear();
    this.phase.set('preparation');
    this.observationSeconds.set(OBSERVATION_SECONDS);
    this.score.set(0);
    this.updateInterface();
    this.broadcastState();
    this.drawCanvasNow();
    void this.prepareModel(this.revision);
  }

  private finishGame(): void {
    if (!this.model) return;
    this.stopObservationTimer();
    this.stopRenderLoop();
    this.phase.set('results');
    const finalScore = this.portraitService.calculateScore(this.model, this.placements);
    this.score.set(finalScore);
    this.revision += 1;
    this.updateInterface();
    this.broadcastState();
    this.drawCanvasNow();
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
      if (this.isHost() && this.model) this.broadcastState(false);
      return;
    }
    if (broadcast.type === 'assets-ready') {
      if (
        !this.isHost()
        || broadcast.revision !== this.revision
        || typeof broadcast.seat !== 'number'
        || !this.players().some((player) => player.seat === broadcast.seat)
      ) return;
      this.readySeats.add(broadcast.seat);
      this.startObservationWhenReady();
      return;
    }
    if (broadcast.type !== 'state' || !broadcast.state) return;
    const state = broadcast.state;
    if (state.revision < this.revision) return;
    const shouldPersist = this.isHost() && state.revision > this.revision;
    this.applyStoredState(state);
    if (shouldPersist) this.broadcastState();
    if (state.phase === 'preparation') void this.prepareModel(state.revision);
    else if (state.phase === 'observation') this.startServerClock();
    else this.stopObservationTimer();
  }

  private async prepareModel(revision: number): Promise<void> {
    const model = this.model;
    if (!model || revision !== this.revision) return;
    if (this.assetsReadyRevision === revision) {
      this.sendAssetsReady(revision);
      return;
    }

    if (this.loadedModelGeneratedAt === model.generatedAt) {
      this.assetsReadyRevision = revision;
      this.sendAssetsReady(revision);
      return;
    }
    if (this.loadingModelGeneratedAt === model.generatedAt) return;

    this.loadingModelGeneratedAt = model.generatedAt;
    try {
      await Promise.all(model.elements.map((element) => this.getImage(element.svg).decode()));
      if (revision !== this.revision || this.model?.generatedAt !== model.generatedAt) return;
      this.loadedModelGeneratedAt = model.generatedAt;
      this.assetsReadyRevision = revision;
      this.drawCanvasNow();
      this.sendAssetsReady(revision);
    } catch (error) {
      if (revision === this.revision) {
        this.error.set(error instanceof Error ? error.message : 'Impossible de charger le portrait.');
      }
    } finally {
      if (this.loadingModelGeneratedAt === model.generatedAt) this.loadingModelGeneratedAt = null;
    }
  }

  private async loadModelForRendering(revision: number): Promise<void> {
    const model = this.model;
    if (!model || this.loadedModelGeneratedAt === model.generatedAt || this.loadingModelGeneratedAt === model.generatedAt) return;
    this.loadingModelGeneratedAt = model.generatedAt;
    try {
      await Promise.all(model.elements.map((element) => this.getImage(element.svg).decode()));
      if (revision === this.revision && this.model?.generatedAt === model.generatedAt) {
        this.loadedModelGeneratedAt = model.generatedAt;
        this.drawCanvasNow();
      }
    } catch (error) {
      if (revision === this.revision) {
        this.error.set(error instanceof Error ? error.message : 'Impossible de charger le portrait.');
      }
    } finally {
      if (this.loadingModelGeneratedAt === model.generatedAt) this.loadingModelGeneratedAt = null;
    }
  }

  private sendAssetsReady(revision: number): void {
    if (this.isHost()) {
      this.readySeats.add(this.mySeat);
      this.startObservationWhenReady();
    } else {
      void this.channel?.send({
        type: 'broadcast',
        event: 'portrait',
        payload: { type: 'assets-ready', seat: this.mySeat, revision },
      });
    }
  }

  private startObservationWhenReady(): void {
    if (
      !this.isHost()
      || this.phase() !== 'preparation'
      || !this.players().every((player) => this.readySeats.has(player.seat))
    ) return;

    this.phase.set('observation');
    this.observationSeconds.set(OBSERVATION_SECONDS);
    this.movementStartedAt = Date.now();
    this.revision += 1;
    this.updateInterface();
    this.broadcastState();
    this.drawCanvasNow();
  }

  private broadcastState(persist = true): void {
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
    if (this.isHost() && persist) {
      const token = this.roomService.readToken(this.roomCode());
      if (!token) {
        this.error.set('Votre session de salle est introuvable.');
        return;
      }
      void (async () => {
        try {
          const { data, error } = await this.supabase.rpc('save_portrait_game_state', {
            p_code: this.roomCode(),
            p_token: token,
            p_state: state,
          });
          if (error) {
            this.error.set(error.message || 'Impossible d’enregistrer l’état du portrait.');
            return;
          }
          const result = Array.isArray(data) ? data[0] : data;
          if (!isRecord(result) || result['success'] !== true) {
            this.error.set(
              isRecord(result) && typeof result['message'] === 'string'
                ? result['message']
                : 'Impossible d’enregistrer l’état du portrait.',
            );
            return;
          }
          this.sendState(state);
          if (state.phase === 'observation' && this.revision === state.revision) {
            this.startServerClock();
          }
        } catch (error) {
          this.error.set(error instanceof Error ? error.message : 'Impossible d’enregistrer l’état du portrait.');
        }
      })();
      return;
    }
    this.sendState(state);
  }

  private sendState(state: PortraitGameState): void {
    void this.channel?.send({
      type: 'broadcast',
      event: 'portrait',
      payload: { type: 'state', seat: this.mySeat, state },
    });
  }

  private stopTimers(): void {
    this.stopObservationTimer();
    this.stopRenderLoop();
  }

  private stopObservationTimer(): void {
    if (this.observationTimer) clearInterval(this.observationTimer);
    this.observationTimer = null;
  }

  private startServerClock(): void {
    if (this.observationTimer) return;
    this.observationTimer = setInterval(() => void this.tickServerState(), 1_000);
  }

  private async tickServerState(): Promise<void> {
    const token = this.roomService.readToken(this.roomCode());
    if (!token) return;
    const { data, error } = await this.supabase.rpc('tick_portrait_game_state', {
      p_code: this.roomCode(),
      p_token: token,
    });
    if (error) {
      this.error.set(error.message || 'Impossible de mettre à jour le minuteur du portrait.');
      return;
    }
    const state = parsePortraitGameState(data);
    if (!state || state.revision <= this.revision) return;
    this.applyStoredState(state);
    if (state.phase === 'observation') this.startServerClock();
    else {
      this.stopObservationTimer();
      this.broadcastState(false);
    }
  }

  private applyStoredState(state: PortraitGameState): void {
    if (this.model?.generatedAt !== (state.model?.generatedAt ?? null)) {
      this.loadedModelGeneratedAt = null;
      this.loadingModelGeneratedAt = null;
      this.assetsReadyRevision = -1;
      this.readySeats.clear();
    }
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
    this.drawCanvasNow();
    if (state.phase !== 'preparation') void this.loadModelForRendering(state.revision);
    if (state.phase === 'reproduction') this.startRenderLoop();
    else this.stopRenderLoop();
  }

  private drawFrame(time: number): void {
    const canvas = this.canvasRef?.nativeElement;
    if (canvas) {
      const delta = this.lastFrameTime ? Math.min(32, time - this.lastFrameTime) : 16;
      this.lastFrameTime = time;
      this.updateMovingPosition(delta);
      this.drawCanvas(canvas);
    }
    if (this.phase() === 'reproduction') {
      this.animationFrame = requestAnimationFrame((nextTime) => this.drawFrame(nextTime));
    } else {
      this.animationFrame = 0;
    }
  }

  private startRenderLoop(): void {
    if (this.phase() !== 'reproduction' || this.animationFrame !== 0) return;
    this.lastFrameTime = 0;
    this.animationFrame = requestAnimationFrame((time) => this.drawFrame(time));
  }

  private stopRenderLoop(): void {
    if (this.animationFrame) cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
  }

  private drawCanvasNow(): void {
    if (this.canvasRef?.nativeElement) this.drawCanvas(this.canvasRef.nativeElement);
    if (this.phase() === 'results') {
      if (this.modelCanvasRef?.nativeElement) this.drawCanvas(this.modelCanvasRef.nativeElement, true);
      if (this.reconstructedCanvasRef?.nativeElement) this.drawCanvas(this.reconstructedCanvasRef.nativeElement, false);
    }
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
    if (image.complete && image.naturalWidth > 0) {
      context.drawImage(image, position.x * CANVAS_WIDTH - width / 2, position.y * CANVAS_HEIGHT - height / 2, width, height);
    }
  }

  private configureCanvas(canvas: HTMLCanvasElement | undefined): void {
    if (!canvas) return;
    const devicePixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(CANVAS_WIDTH * devicePixelRatio);
    canvas.height = Math.round(CANVAS_HEIGHT * devicePixelRatio);
    canvas.getContext('2d')?.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
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

function parsePortraitGameState(value: unknown): PortraitGameState | null {
  if (!isRecord(value)) return null;
  const phase = value['phase'];
  if (
    phase !== 'preparation'
    && phase !== 'observation'
    && phase !== 'reproduction'
    && phase !== 'results'
  ) return null;
  if (
    !Number.isInteger(value['revision'])
    || typeof value['observationSeconds'] !== 'number'
    || typeof value['score'] !== 'number'
    || typeof value['movementStartedAt'] !== 'number'
    || typeof value['movingX'] !== 'number'
    || typeof value['movingY'] !== 'number'
    || !isRecord(value['placements'])
    || !Array.isArray(value['turns'])
    || typeof value['turnIndex'] !== 'number'
  ) return null;
  if (
    value['pendingX'] !== null
    && typeof value['pendingX'] !== 'number'
  ) return null;

  const model = value['model'];
  if (model !== null && (!isRecord(model) || !Array.isArray(model['elements']))) return null;
  if (model !== null) {
    const elements = model['elements'];
    if (!Array.isArray(elements)) return null;
    const elementsValid = elements.every((element: unknown) => {
      if (!isRecord(element)) return false;
      return typeof element['id'] === 'string'
        && typeof element['svg'] === 'string'
        && typeof element['width'] === 'number'
        && typeof element['height'] === 'number'
        && isRecord(element['target'])
        && typeof element['target']['x'] === 'number'
        && typeof element['target']['y'] === 'number';
    });
    if (!elementsValid) return null;
  }
  const turnsValid = value['turns'].every((turn) => {
    if (!isRecord(turn)) return false;
    return typeof turn['seat'] === 'number'
      && typeof turn['elementId'] === 'string'
      && (turn['step'] === 'x' || turn['step'] === 'y');
  });
  if (!turnsValid) return null;
  const placementsValid = Object.values(value['placements']).every((placement) =>
    isRecord(placement)
    && typeof placement['x'] === 'number'
    && typeof placement['y'] === 'number'
  );
  if (!placementsValid) return null;

  return value as unknown as PortraitGameState;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
