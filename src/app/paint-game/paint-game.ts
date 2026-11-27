import { AfterViewInit, Component, ElementRef, OnDestroy, ViewChild, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { RoomService, type GameType, type RoomStatus } from '../athletes/services/room.service';
import {
  PaintService,
  type PaintPoint,
  type PaintStroke,
  type PaintStrokeEvent,
} from './services/paint.service';

interface ActiveStroke {
  id: string;
  seat: number;
  color: string;
  points: PaintPoint[];
}

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

  protected readonly roomCode = signal('');
  protected readonly isLoading = signal(true);
  protected readonly isEnding = signal(false);
  protected readonly connectionError = signal<string | null>(null);
  protected readonly sessionInfo = this.paintService.sessionInfo;

  private context: CanvasRenderingContext2D | null = null;
  private canvasReady = false;
  private activeLocalStroke: ActiveStroke | null = null;
  private activePointerId: number | null = null;
  private readonly pendingLocalPoints: PaintPoint[] = [];
  private lastMoveBroadcastAt = 0;
  private readonly activeRemotePoints = new Map<string, PaintPoint>();
  private readonly pendingRemoteEvents: PaintStrokeEvent[] = [];
  private readonly savedStrokeIds = new Set<string>();
  private unsubscribeRoom?: () => void;

  ngAfterViewInit(): void {
    const canvas = this.canvasElement.nativeElement;
    this.context = canvas.getContext('2d');
    if (!this.context) {
      this.connectionError.set('Le navigateur ne permet pas de dessiner sur cette toile.');
      this.isLoading.set(false);
      return;
    }

    void this.initializeGame();
  }

  ngOnDestroy(): void {
    this.unsubscribeRoom?.();
    this.paintService.leavePaintChannel();
  }

  protected startDrawing(event: PointerEvent): void {
    const session = this.sessionInfo();
    if (!this.canvasReady || !session || this.activeLocalStroke || event.button !== 0) return;

    event.preventDefault();
    const point = this.getPoint(event);
    const stroke: ActiveStroke = {
      id: crypto.randomUUID(),
      seat: session.mySeat,
      color: this.paintService.getSeatColor(session.mySeat),
      points: [point],
    };
    this.activeLocalStroke = stroke;
    this.activePointerId = event.pointerId;
    this.pendingLocalPoints.length = 0;
    this.lastMoveBroadcastAt = 0;
    this.canvasElement.nativeElement.setPointerCapture(event.pointerId);
    this.drawPoint(point, stroke.color);
    this.sendEvent({
      strokeId: stroke.id,
      seat: stroke.seat,
      color: stroke.color,
      type: 'start',
      point,
    });
  }

  protected continueDrawing(event: PointerEvent): void {
    const stroke = this.activeLocalStroke;
    if (!stroke || event.pointerId !== this.activePointerId) return;

    event.preventDefault();
    const point = this.getPoint(event);
    this.drawSegment(stroke.points[stroke.points.length - 1], point, stroke.color);
    stroke.points.push(point);
    this.pendingLocalPoints.push(point);
    if (Date.now() - this.lastMoveBroadcastAt >= 50) this.flushPendingPoints(stroke);
  }

  protected finishDrawing(event: PointerEvent): void {
    const stroke = this.activeLocalStroke;
    if (!stroke || event.pointerId !== this.activePointerId) return;

    event.preventDefault();
    const point = this.getPoint(event);
    const lastPoint = stroke.points[stroke.points.length - 1];
    if (point.x !== lastPoint.x || point.y !== lastPoint.y) {
      this.drawSegment(lastPoint, point, stroke.color);
      stroke.points.push(point);
      this.pendingLocalPoints.push(point);
    }

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
      this.showError(error, 'Impossible d’enregistrer ce trait.');
    });
  }

  protected async finishGame(): Promise<void> {
    const code = this.roomCode();
    const pseudo = this.roomService.readPseudo(code);
    if (!code || !pseudo || this.isEnding()) return;
    if (!window.confirm('Terminer la partie et effacer définitivement la toile ?')) return;

    this.isEnding.set(true);
    this.connectionError.set(null);
    try {
      await this.roomService.finishPaintGame(code, pseudo);
      await this.router.navigate(['/salon', code]);
    } catch (error) {
      this.showError(error, 'Impossible de terminer la partie.');
    } finally {
      this.isEnding.set(false);
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
      (status, gameType) => this.handleRoomStatus(code, status, gameType)
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
        (event) => this.handleRemoteEvent(event)
      );
      for (const stroke of strokes) {
        this.savedStrokeIds.add(stroke.id);
        this.drawSavedStroke(stroke);
      }
      this.canvasReady = true;

      for (const event of this.pendingRemoteEvents.splice(0)) {
        if (!this.savedStrokeIds.has(event.strokeId)) this.applyRemoteEvent(event);
      }
    } catch (error) {
      this.showError(error, 'Impossible de rejoindre la toile.');
    } finally {
      this.isLoading.set(false);
    }
  }

  private handleRoomStatus(code: string, status: RoomStatus, gameType: GameType | null): void {
    if (status === 'lobby') void this.router.navigate(['/salon', code]);
    else if (status === 'finished') void this.router.navigate(['/']);
    else if (status === 'playing' && gameType === 'athletes') {
      void this.router.navigate(['/salon', code, 'jouer']);
    }
  }

  private handleRemoteEvent(event: PaintStrokeEvent): void {
    if (!this.canvasReady) {
      this.pendingRemoteEvents.push(event);
      return;
    }
    this.applyRemoteEvent(event);
  }

  private applyRemoteEvent(event: PaintStrokeEvent): void {
    if (event.type === 'start' && event.point) {
      this.activeRemotePoints.set(event.strokeId, event.point);
      this.drawPoint(event.point, event.color);
    } else if (event.type === 'move' && event.points) {
      let previous = this.activeRemotePoints.get(event.strokeId);
      for (const point of event.points) {
        if (previous) this.drawSegment(previous, point, event.color);
        else this.drawPoint(point, event.color);
        previous = point;
      }
      if (previous) this.activeRemotePoints.set(event.strokeId, previous);
    } else if (event.type === 'end') {
      this.activeRemotePoints.delete(event.strokeId);
    }
  }

  private drawSavedStroke(stroke: PaintStroke): void {
    const first = stroke.points[0];
    if (!first) return;
    this.drawPoint(first, stroke.color);
    for (let index = 1; index < stroke.points.length; index += 1) {
      this.drawSegment(stroke.points[index - 1], stroke.points[index], stroke.color);
    }
  }

  private drawPoint(point: PaintPoint, color: string): void {
    const context = this.context;
    if (!context) return;
    const canvas = this.canvasElement.nativeElement;
    context.fillStyle = color;
    context.beginPath();
    context.arc(point.x * canvas.width, point.y * canvas.height, 3, 0, Math.PI * 2);
    context.fill();
  }

  private drawSegment(start: PaintPoint, end: PaintPoint, color: string): void {
    const context = this.context;
    if (!context) return;
    const canvas = this.canvasElement.nativeElement;
    context.strokeStyle = color;
    context.lineWidth = 6;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(start.x * canvas.width, start.y * canvas.height);
    context.lineTo(end.x * canvas.width, end.y * canvas.height);
    context.stroke();
  }

  private getPoint(event: PointerEvent): PaintPoint {
    const rect = this.canvasElement.nativeElement.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    };
  }

  private sendEvent(event: PaintStrokeEvent): void {
    void this.paintService.sendStrokeEvent(event).catch((error: unknown) => {
      this.showError(error, 'La synchronisation de la toile a échoué.');
    });
  }

  private flushPendingPoints(stroke: ActiveStroke): void {
    if (!this.pendingLocalPoints.length) return;
    const points = this.pendingLocalPoints.splice(0);
    this.lastMoveBroadcastAt = Date.now();
    this.sendEvent({
      strokeId: stroke.id,
      seat: stroke.seat,
      color: stroke.color,
      type: 'move',
      points,
    });
  }

  private showError(error: unknown, fallback: string): void {
    this.connectionError.set(error instanceof Error ? error.message : fallback);
  }
}
