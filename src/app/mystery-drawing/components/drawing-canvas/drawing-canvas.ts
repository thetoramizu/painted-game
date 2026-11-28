import {
  AfterViewInit,
  Component,
  ElementRef,
  EventEmitter,
  Input,
  OnChanges,
  Output,
  SimpleChanges,
  ViewChild,
} from '@angular/core';
import type {
  DrawingOperation,
  DrawingPoint,
  DrawingTool,
  MysteryEvent,
  ToolbarAction,
} from '../../models/mystery-drawing';

const CANVAS_WIDTH = 1000;
const CANVAS_HEIGHT = 600;
const MAX_FILL_PIXELS = CANVAS_WIDTH * CANVAS_HEIGHT;

interface StrokeAction {
  kind: 'stroke';
  color: string;
  size: number;
  tool: 'brush' | 'eraser';
  points: DrawingPoint[];
}

interface FillAction {
  kind: 'fill';
  x: number;
  y: number;
  color: string;
}

interface ClearAction {
  kind: 'clear';
}

type CanvasAction = StrokeAction | FillAction | ClearAction;

@Component({
  selector: 'app-drawing-canvas',
  standalone: true,
  templateUrl: './drawing-canvas.html',
  styleUrl: './drawing-canvas.css',
})
export class DrawingCanvas implements AfterViewInit, OnChanges {
  @ViewChild('canvas', { static: true }) private readonly canvasRef!: ElementRef<HTMLCanvasElement>;

  @Input() events: MysteryEvent[] = [];
  @Input() roundIndex = 0;
  @Input() mySeat = -1;
  @Input() canDraw = false;
  @Input() tool: DrawingTool = 'brush';
  @Input() color = '#171717';
  @Input() size = 8;
  @Input() toolbarAction: ToolbarAction | null = null;
  @Input() resetVersion = 0;
  @Output() readonly drawingAction = new EventEmitter<ToolbarAction>();

  private context: CanvasRenderingContext2D | null = null;
  private lastEventId = 0;
  private readonly appliedEventIds = new Set<number>();
  private readonly localPendingEventIds = new Set<string>();
  private renderedRound = -1;
  private history: CanvasAction[] = [];
  private redoHistory: CanvasAction[] = [];
  private activeStroke: StrokeAction | null = null;
  private activePointer: number | null = null;
  private pendingPoints: DrawingPoint[] = [];
  private lastFlushAt = 0;

  ngAfterViewInit(): void {
    const canvas = this.canvasRef.nativeElement;
    const devicePixelRatio = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
    canvas.width = Math.round(CANVAS_WIDTH * devicePixelRatio);
    canvas.height = Math.round(CANVAS_HEIGHT * devicePixelRatio);
    this.context = canvas.getContext('2d');
    this.context?.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    if (!this.context) return;
    this.clearSurface();
    this.syncEvents(true);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['resetVersion'] && !changes['resetVersion'].firstChange) {
      this.resetFromEvents();
    } else if (changes['events'] || changes['roundIndex']) {
      this.syncEvents(false);
    }
    if (changes['toolbarAction'] && this.toolbarAction) {
      this.sendAction(this.toolbarAction.kind, this.toolbarAction.payload);
    }
  }

  protected pointerDown(event: PointerEvent): void {
    if (!this.canDraw || event.button !== 0 || !this.context || this.activePointer !== null) return;
    event.preventDefault();
    this.activePointer = event.pointerId;
    this.canvasRef.nativeElement.setPointerCapture(event.pointerId);
    const point = this.getPoint(event);

    if (this.tool === 'fill') {
      this.sendAction('fill', { x: point.x, y: point.y, color: this.color });
      this.activePointer = null;
      return;
    }

    const strokeTool = this.tool === 'eraser' ? 'eraser' : 'brush';
    const strokeColor = strokeTool === 'eraser' ? '#ffffff' : this.color;
    const payload = {
      x: point.x,
      y: point.y,
      color: strokeColor,
      size: this.size,
      tool: strokeTool,
    };
    this.sendAction('begin', payload);
    this.pendingPoints.length = 0;
    this.lastFlushAt = performance.now();
  }

  protected pointerMove(event: PointerEvent): void {
    if (!this.canDraw || event.pointerId !== this.activePointer || !this.activeStroke) return;
    event.preventDefault();
    const point = this.getPoint(event);
    const previous = this.activeStroke.points[this.activeStroke.points.length - 1];
    this.activeStroke.points.push(point);
    this.pendingPoints.push(point);
    this.drawLine(previous, point, this.activeStroke);
    if (this.pendingPoints.length >= 12 || performance.now() - this.lastFlushAt >= 100) this.flushPoints();
  }

  protected pointerUp(event: PointerEvent): void {
    if (event.pointerId !== this.activePointer) return;
    this.flushPoints();
    if (this.activeStroke) {
      this.sendAction('end', {});
    }
    this.activePointer = null;
  }

  private sendAction(kind: DrawingOperation, payload: Record<string, unknown>): void {
    const clientEventId = createClientEventId();
    const data = { ...payload, clientEventId };
    this.localPendingEventIds.add(clientEventId);
    this.applyOperation(kind, data);
    this.drawingAction.emit({ kind, payload: data });
  }

  private flushPoints(): void {
    if (!this.pendingPoints.length || !this.activeStroke) return;
    const points = this.pendingPoints.splice(0, this.pendingPoints.length);
    const clientEventId = createClientEventId();
    this.localPendingEventIds.add(clientEventId);
    this.drawingAction.emit({ kind: 'points', payload: { points, clientEventId } });
    this.lastFlushAt = performance.now();
  }

  private resetFromEvents(): void {
    this.lastEventId = 0;
    this.appliedEventIds.clear();
    this.localPendingEventIds.clear();
    this.history = [];
    this.redoHistory = [];
    this.activeStroke = null;
    this.pendingPoints = [];
    this.activePointer = null;
    this.clearSurface();
    this.syncEvents(true);
  }

  private syncEvents(initial: boolean): void {
    if (!this.context) return;
    if (this.renderedRound !== this.roundIndex) {
      this.renderedRound = this.roundIndex;
      this.lastEventId = 0;
      this.appliedEventIds.clear();
      this.localPendingEventIds.clear();
      this.history = [];
      this.redoHistory = [];
      this.activeStroke = null;
      this.clearSurface();
    } else if (initial && this.lastEventId === 0) {
      this.clearSurface();
    }

    const drawingEvents = this.events
      .filter((event) => event.kind === 'drawing' && event.roundIndex === this.roundIndex)
      .sort((a, b) => a.id - b.id);
    const missedEvent = drawingEvents.some((event) =>
      event.id < this.lastEventId && !this.appliedEventIds.has(event.id)
    );
    if (missedEvent) {
      this.lastEventId = 0;
      this.appliedEventIds.clear();
      this.localPendingEventIds.clear();
      this.history = [];
      this.redoHistory = [];
      this.activeStroke = null;
      this.clearSurface();
    }

    for (const event of drawingEvents) {
      if (this.appliedEventIds.has(event.id)) continue;
      this.lastEventId = event.id;
      this.appliedEventIds.add(event.id);
      const operation = event.payload['operation'];
      const data = event.payload['data'];
      const clientEventIds = isRecord(data) && Array.isArray(data['clientEventIds'])
        ? data['clientEventIds'].filter((id): id is string => typeof id === 'string')
        : isRecord(data) && typeof data['clientEventId'] === 'string'
          ? [data['clientEventId']]
          : [];
      const isLocalEcho = event.actorSeat === this.mySeat &&
        clientEventIds.length > 0 &&
        clientEventIds.every((id) => this.localPendingEventIds.has(id));
      if (event.actorSeat === this.mySeat) {
        for (const id of clientEventIds) this.localPendingEventIds.delete(id);
      }
      if (isLocalEcho) continue;
      if (isDrawingOperation(operation) && isRecord(data)) this.applyOperation(operation, data);
    }
  }

  private applyOperation(kind: DrawingOperation, payload: Record<string, unknown>): void {
    if (!this.context) return;
    if (kind === 'begin') {
      const tool = payload['tool'] === 'eraser' ? 'eraser' : 'brush';
      const point = readPoint(payload);
      if (!point) return;
      this.activeStroke = {
        kind: 'stroke',
        color: typeof payload['color'] === 'string' ? payload['color'] : '#171717',
        size: typeof payload['size'] === 'number' ? payload['size'] : 8,
        tool,
        points: [point],
      };
      this.history.push(this.activeStroke);
      this.redoHistory = [];
      this.drawStroke(this.activeStroke);
    } else if (kind === 'points' && this.activeStroke && Array.isArray(payload['points'])) {
      const points = payload['points'].flatMap((point) => {
        const parsed = readPoint(point);
        return parsed ? [parsed] : [];
      });
      if (!points.length) return;
      this.activeStroke.points.push(...points);
      let previous = this.activeStroke.points[this.activeStroke.points.length - points.length - 1];
      for (const point of points) {
        this.drawLine(previous, point, this.activeStroke);
        previous = point;
      }
    } else if (kind === 'end') {
      this.activeStroke = null;
    } else if (kind === 'fill') {
      const point = readPoint(payload);
      const color = payload['color'];
      if (!point || typeof color !== 'string') return;
      const fillAction: FillAction = { kind: 'fill', x: point.x, y: point.y, color };
      this.history.push(fillAction);
      this.redoHistory = [];
      this.floodFill(fillAction);
    } else if (kind === 'undo') {
      const action = this.history.pop();
      if (action) this.redoHistory.push(action);
      this.activeStroke = null;
      this.redrawHistory();
    } else if (kind === 'redo') {
      const action = this.redoHistory.pop();
      if (action) this.history.push(action);
      this.activeStroke = null;
      this.redrawHistory();
    } else if (kind === 'clear') {
      this.history.push({ kind: 'clear' });
      this.redoHistory = [];
      this.activeStroke = null;
      this.clearSurface();
    }
  }

  private drawStroke(stroke: StrokeAction): void {
    for (let index = 1; index < stroke.points.length; index += 1) {
      this.drawLine(stroke.points[index - 1], stroke.points[index], stroke);
    }
    if (stroke.points.length === 1) this.drawLine(stroke.points[0], stroke.points[0], stroke);
  }

  private drawLine(from: DrawingPoint, to: DrawingPoint, stroke: StrokeAction): void {
    if (!this.context) return;
    const context = this.context;
    context.save();
    context.globalCompositeOperation = 'source-over';
    context.strokeStyle = stroke.tool === 'eraser' ? '#ffffff' : stroke.color;
    context.lineWidth = stroke.size;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(from.x * CANVAS_WIDTH, from.y * CANVAS_HEIGHT);
    context.lineTo(to.x * CANVAS_WIDTH, to.y * CANVAS_HEIGHT);
    context.stroke();
    context.restore();
  }

  private floodFill(action: FillAction): void {
    if (!this.context) return;
    const context = this.context;
    const image = context.getImageData(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    const pixels = image.data;
    const startX = Math.min(CANVAS_WIDTH - 1, Math.floor(action.x * CANVAS_WIDTH));
    const startY = Math.min(CANVAS_HEIGHT - 1, Math.floor(action.y * CANVAS_HEIGHT));
    const start = (startY * CANVAS_WIDTH + startX) * 4;
    const target = [pixels[start], pixels[start + 1], pixels[start + 2], pixels[start + 3]];
    const replacement = hexToRgba(action.color);
    if (target.every((value, index) => value === replacement[index])) return;

    const visited = new Uint8Array(CANVAS_WIDTH * CANVAS_HEIGHT);
    const queue = new Uint32Array(MAX_FILL_PIXELS);
    let read = 0;
    let write = 1;
    queue[0] = startX + startY * CANVAS_WIDTH;
    visited[queue[0]] = 1;
    let processed = 0;
    const enqueue = (pixel: number): void => {
      if (pixel < 0 || visited[pixel] || write >= MAX_FILL_PIXELS) return;
      const offset = pixel * 4;
      if (!target.every((value, index) => pixels[offset + index] === value)) return;
      visited[pixel] = 1;
      queue[write++] = pixel;
    };

    while (read < write && processed < MAX_FILL_PIXELS) {
      const pixel = queue[read++];
      processed += 1;
      const offset = pixel * 4;
      if (!target.every((value, index) => pixels[offset + index] === value)) continue;
      pixels[offset] = replacement[0];
      pixels[offset + 1] = replacement[1];
      pixels[offset + 2] = replacement[2];
      pixels[offset + 3] = replacement[3];
      const x = pixel % CANVAS_WIDTH;
      const y = Math.floor(pixel / CANVAS_WIDTH);
      if (x > 0) enqueue(pixel - 1);
      if (x < CANVAS_WIDTH - 1) enqueue(pixel + 1);
      if (y > 0) enqueue(pixel - CANVAS_WIDTH);
      if (y < CANVAS_HEIGHT - 1) enqueue(pixel + CANVAS_WIDTH);
    }
    context.putImageData(image, 0, 0);
  }

  private redrawHistory(): void {
    this.clearSurface();
    for (const action of this.history) {
      if (action.kind === 'stroke') this.drawStroke(action);
      else if (action.kind === 'fill') this.floodFill(action);
      else this.clearSurface();
    }
  }

  private clearSurface(): void {
    if (!this.context) return;
    this.context.save();
    this.context.globalCompositeOperation = 'source-over';
    this.context.fillStyle = '#ffffff';
    this.context.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
    this.context.restore();
  }

  private getPoint(event: PointerEvent): DrawingPoint {
    const rect = this.canvasRef.nativeElement.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / rect.width),
      y: clamp((event.clientY - rect.top) / rect.height),
    };
  }
}

function isDrawingOperation(value: unknown): value is DrawingOperation {
  return value === 'begin' || value === 'points' || value === 'end' || value === 'fill' ||
    value === 'undo' || value === 'redo' || value === 'clear';
}

function readPoint(value: unknown): DrawingPoint | null {
  if (!isRecord(value) || typeof value['x'] !== 'number' || typeof value['y'] !== 'number') return null;
  if (!Number.isFinite(value['x']) || !Number.isFinite(value['y'])) return null;
  return { x: clamp(value['x']), y: clamp(value['y']) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function createClientEventId(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function hexToRgba(value: string): number[] {
  const hex = /^#[0-9A-Fa-f]{6}$/.test(value) ? value.slice(1) : '171717';
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
    255,
  ];
}
