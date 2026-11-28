import { Injectable, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SupabaseService } from '../../athletes/core/supabase-client';
import type { RoomSnapshot } from '../../athletes/services/room.service';

export type PaintPhase = 'observation' | 'painting' | 'results';
export type PaintStrokeType = 'start' | 'move' | 'end';

export const OBSERVATION_DURATION_SECONDS = 20;
export const PAINTING_DURATION_SECONDS = 45;

export interface PaintPoint {
  x: number;
  y: number;
  radius?: number;
}

export interface PaintStroke {
  id: string;
  seat: number;
  color: string;
  points: PaintPoint[];
}

export interface PaintStrokeEvent {
  strokeId: string;
  seat: number;
  color: string;
  type: PaintStrokeType;
  points?: PaintPoint[];
}

export interface PaintGameSession {
  strokes: PaintStroke[];
  state: PaintGameState | null;
}

export interface PaintPlayer {
  seat: number;
  pseudo: string;
  color: string;
}

export interface PaintSessionInfo {
  roomCode: string;
  mySeat: number;
  players: PaintPlayer[];
}

export type PaintModelMark =
  | {
      id: string;
      kind: 'oval';
      color: string;
      points: PaintPoint[];
      opacity: number;
    }
  | {
      id: string;
      kind: 'sweep';
      color: string;
      points: PaintPoint[];
      width: number;
      opacity: number;
    };

export interface PaintModel {
  seed: number;
  marks: PaintModelMark[];
  generatedAt: number;
}

export interface PaintGameState {
  phase: PaintPhase;
  model: PaintModel;
  playerColors: string[];
  observationSeconds: number;
  paintingSeconds: number;
  score: number | null;
  revision: number;
  revealUsedSeats: number[];
  revealUntilBySeat: Record<string, number>;
}

export type PaintGameEvent = { type: 'state-changed' };

export const PAINT_PALETTE = ['#4f8cff', '#ff6b6b', '#2fbf71', '#f5a623'] as const;

const INITIAL_PAINT_TIMEOUT_MS = 10_000;
const MAX_STROKE_POINTS = 10_000;
const PAINT_COLOR_SETS = [
  ['#2f6bff', '#d81b60', '#16a05d', '#f0a000'],
  ['#6d35d4', '#0097b2', '#dc2626', '#7a9c00'],
  ['#304ffe', '#d81b60', '#2e7d32', '#d49a00'],
  ['#7b2cbf', '#0077b6', '#d62828', '#558b2f'],
] as const;
const COMPOSITION_LAYOUTS = [
  [{ x: 0.22, y: 0.3 }, { x: 0.72, y: 0.35 }, { x: 0.38, y: 0.74 }, { x: 0.78, y: 0.76 }],
  [{ x: 0.2, y: 0.56 }, { x: 0.47, y: 0.24 }, { x: 0.77, y: 0.5 }, { x: 0.53, y: 0.78 }],
  [{ x: 0.22, y: 0.24 }, { x: 0.62, y: 0.49 }, { x: 0.24, y: 0.77 }, { x: 0.78, y: 0.72 }],
  [{ x: 0.22, y: 0.68 }, { x: 0.39, y: 0.31 }, { x: 0.72, y: 0.26 }, { x: 0.77, y: 0.7 }],
] as const;

interface BlobPlacement {
  x: number;
  y: number;
}

@Injectable({ providedIn: 'root' })
export class PaintService {
  private readonly supabase = inject(SupabaseService).client;
  private readonly sessionInfoSignal = signal<PaintSessionInfo | null>(null);
  readonly sessionInfo = this.sessionInfoSignal.asReadonly();
  private channelRef: RealtimeChannel | null = null;
  private sendQueue: Promise<void> = Promise.resolve();
  private playerColorsAreSynchronized = false;

  setSessionInfo(snapshot: RoomSnapshot): void {
    this.playerColorsAreSynchronized = false;
    this.sessionInfoSignal.set({
      roomCode: snapshot.code,
      mySeat: snapshot.mySeat,
      players: [...snapshot.players]
        .sort((a, b) => a.seat - b.seat)
        .map((player) => ({
          seat: player.seat,
          pseudo: player.pseudo,
          color: PAINT_PALETTE[player.seat] ?? PAINT_PALETTE[0],
        })),
    });
  }

  setPlayerColors(colors: string[]): void {
    const session = this.sessionInfoSignal();
    if (!session) return;
    this.playerColorsAreSynchronized = true;
    if (session.players.every((player) => colors[player.seat] === player.color)) return;
    this.sessionInfoSignal.set({
      ...session,
      players: session.players.map((player) => ({
        ...player,
        color: colors[player.seat] ?? player.color,
      })),
    });
  }

  getSeatColor(seat: number): string {
    return this.sessionInfoSignal()?.players.find((player) => player.seat === seat)?.color
      ?? PAINT_PALETTE[seat]
      ?? PAINT_PALETTE[0];
  }

  generatePlayerColors(playerCount: number, seed = createRandomSeed()): string[] {
    const count = Number.isFinite(playerCount)
      ? Math.min(PAINT_PALETTE.length, Math.max(2, Math.floor(playerCount)))
      : 2;
    const random = createSeededRandom(seed >>> 0);
    const colorSet = PAINT_COLOR_SETS[Math.floor(random() * PAINT_COLOR_SETS.length)] ?? PAINT_COLOR_SETS[0];
    return shuffle([...colorSet], random).slice(0, count);
  }

  generateModel(
    playerCount: number,
    availableColors: string[],
    seed = createRandomSeed(),
  ): PaintModel {
    const colors = [...new Set(availableColors.map((color) => color.toLowerCase()))]
      .filter(isPaintColor)
      .slice(0, PAINT_PALETTE.length);
    if (colors.length < 2) throw new Error('Il faut au moins deux couleurs pour générer le modèle.');

    const modelSeed = seed >>> 0;
    const random = createSeededRandom(modelSeed);
    const normalizedPlayerCount = Number.isFinite(playerCount)
      ? Math.min(PAINT_PALETTE.length, Math.max(2, Math.floor(playerCount)))
      : 2;
    const palette = shuffle(colors.slice(0, normalizedPlayerCount), random);
    const markKinds: PaintModelMark['kind'][] = shuffle(
      Array.from({ length: palette.length }, (_, index): PaintModelMark['kind'] =>
        index % 2 === 0 ? 'oval' : 'sweep',
      ),
      random,
    );
    const layout = COMPOSITION_LAYOUTS[Math.floor(random() * COMPOSITION_LAYOUTS.length)] ?? COMPOSITION_LAYOUTS[0];
    const anchors = shuffle([...layout], random);
    const marks: PaintModelMark[] = [];
    for (let index = 0; index < palette.length; index += 1) {
      const anchor = anchors[index] ?? layout[index] ?? layout[0];
      const color = palette[index];
      const kind = markKinds[index];
      if (!color || !kind) continue;

      const center = {
        x: clamp(anchor.x + randomBetween(random, -0.055, 0.055), 0.12, 0.88),
        y: clamp(anchor.y + randomBetween(random, -0.055, 0.055), 0.14, 0.86),
      };
      const mainMark = kind === 'oval'
        ? createOvalMark(`mark-${index}`, color, center, random)
        : createSweepMark(`mark-${index}`, color, center, random);
      marks.push(mainMark);
      marks.push(createSweepMark(
        `mark-${index}-sweep`,
        color,
        {
          x: clamp(center.x + randomBetween(random, -0.1, 0.1), 0.12, 0.88),
          y: clamp(center.y + randomBetween(random, -0.1, 0.1), 0.14, 0.86),
        },
        random,
        true,
      ));
    }

    return {
      seed: modelSeed,
      marks,
      generatedAt: Date.now(),
    };
  }

  calculateSimilarity(reference: ImageData, reproduction: ImageData): number {
    if (
      reference.width !== reproduction.width ||
      reference.height !== reproduction.height ||
      reference.width === 0 ||
      reference.height === 0
    ) {
      throw new Error('Les deux toiles doivent avoir les mêmes dimensions.');
    }

    const columns = 40;
    const rows = 24;
    let targetCells = 0;
    let paintedCells = 0;
    let matchingCells = 0;

    for (let row = 0; row < rows; row += 1) {
      for (let column = 0; column < columns; column += 1) {
        const target = readCellColor(reference, column, row, columns, rows, 0.02);
        const painted = readCellColor(reproduction, column, row, columns, rows, 0.005);
        if (target) targetCells += 1;
        if (painted) paintedCells += 1;
        if (target && painted) matchingCells += colorSimilarity(target, painted);
      }
    }

    const denominator = targetCells + paintedCells;
    return denominator === 0 ? 0 : Math.round((2 * matchingCells / denominator) * 100);
  }

  async joinPaintChannel(
    roomCode: string,
    mySeat: number,
    token: string,
    onRemoteStroke: (event: PaintStrokeEvent) => void,
    onStrokeSaved: () => void,
    onGameEvent: (event: PaintGameEvent) => void
  ): Promise<PaintGameSession> {
    this.leavePaintChannel();

    const channel = this.supabase.channel(`paint-${roomCode}`);
    this.channelRef = channel;
    channel.on('broadcast', { event: 'stroke' }, (message: { payload: unknown }) => {
      const event = parsePaintStrokeEvent(message.payload, (seat, color) => this.isColorForSeat(seat, color));
      if (event && event.seat !== mySeat) onRemoteStroke(event);
    });
    channel.on('broadcast', { event: 'stroke-saved' }, () => onStrokeSaved());
    channel.on('broadcast', { event: 'game' }, (message: { payload: unknown }) => {
      const event = parsePaintGameEvent(message.payload);
      if (event) onGameEvent(event);
    });

    try {
      await this.waitForSubscription(channel);
      const [strokes, state] = await Promise.all([
        this.getInitialStrokes(roomCode, token),
        this.getPaintGameState(roomCode, token),
      ]);
      return { strokes, state };
    } catch (error) {
      this.leavePaintChannel();
      throw error;
    }
  }

  async sendStrokeEvent(event: PaintStrokeEvent): Promise<void> {
    if (!parsePaintStrokeEvent(event, (seat, color) => this.isColorForSeat(seat, color))) {
      throw new Error('Le trait envoyé est invalide.');
    }
    return this.sendBroadcast('stroke', event);
  }

  async notifyStrokeSaved(): Promise<void> {
    return this.sendBroadcast('stroke-saved', { type: 'saved' });
  }

  async saveGameState(state: PaintGameState, roomCode: string, token: string): Promise<boolean> {
    const { data, error } = await this.supabase.rpc('save_paint_game_state', {
      p_code: roomCode,
      p_token: token,
      p_state: state,
    });
    if (error) throw new Error(error.message || 'Impossible d’enregistrer l’état de la partie.');

    const result = Array.isArray(data) ? data[0] : data;
    if (!isRecord(result)) throw new Error('La réponse de sauvegarde de la partie est invalide.');
    if (result['success'] === true) return true;
    if (result['message'] === 'Une version plus récente de la partie existe déjà') return false;
    throw new Error(
      typeof result['message'] === 'string'
        ? result['message']
        : 'Impossible d’enregistrer l’état de la partie.',
    );
  }

  async requestModelReveal(roomCode: string, token: string): Promise<PaintGameState> {
    const { data, error } = await this.supabase.rpc('request_paint_model_reveal', {
      p_code: roomCode,
      p_token: token,
    });
    if (error) throw new Error(error.message || 'Impossible de demander à revoir le modèle.');

    const result = Array.isArray(data) ? data[0] : data;
    if (!isRecord(result) || result['success'] !== true) {
      throw new Error(
        isRecord(result) && typeof result['message'] === 'string'
          ? result['message']
          : 'La réponse de demande de modèle est invalide.',
      );
    }

    const state = parsePaintGameState(result['state']);
    if (!state) throw new Error('L’état reçu après la demande de modèle est invalide.');
    return state;
  }

  async notifyGameStateChanged(): Promise<void> {
    return this.sendBroadcast('game', { type: 'state-changed' });
  }

  async restartGame(roomCode: string, token: string) {
    return this.supabase.rpc('restart_paint_game', {
      p_code: roomCode,
      p_token: token,
    });
  }

  async tickGameState(roomCode: string, token: string): Promise<PaintGameState | null> {
    const { data, error } = await this.supabase.rpc('tick_paint_game_state', {
      p_code: roomCode,
      p_token: token,
    });
    if (error) throw new Error(error.message || 'Impossible de mettre à jour le minuteur de la partie.');
    if (data === null) return null;
    const state = parsePaintGameState(data);
    if (!state) throw new Error('L’état reçu après l’avancée du minuteur est invalide.');
    return state;
  }

  async saveStroke(stroke: PaintStroke, roomCode: string, token: string): Promise<void> {
    const { data, error } = await this.supabase.rpc('add_paint_stroke', {
      p_stroke_id: stroke.id,
      p_room_code: roomCode,
      p_token: token,
      p_seat: stroke.seat,
      p_color: stroke.color,
      p_points: stroke.points,
    });
    if (error) throw new Error(error.message || 'Impossible d’enregistrer le trait.');

    const result = Array.isArray(data) ? data[0] : data;
    if (!isRecord(result) || result['success'] !== true) {
      const message = isRecord(result) && typeof result['message'] === 'string'
        ? result['message']
        : 'Impossible d’enregistrer le trait.';
      throw new Error(message);
    }
  }

  leavePaintChannel(): void {
    const channel = this.channelRef;
    this.channelRef = null;
    if (channel) void this.supabase.removeChannel(channel);
  }

  async getPaintGameState(roomCode: string, token: string): Promise<PaintGameState | null> {
    const { data, error } = await this.supabase.rpc('get_paint_game_state', {
      p_code: roomCode,
      p_token: token,
    });
    if (error) throw new Error(error.message || 'Impossible de charger l’état de la partie.');
    if (data === null) return null;

    const state = parsePaintGameState(data);
    if (!state) throw new Error('L’état enregistré de la partie est invalide.');
    return state;
  }

  async getStrokes(roomCode: string, token: string): Promise<PaintStroke[]> {
    return this.getInitialStrokes(roomCode, token);
  }

  private async sendBroadcast(
    eventName: 'stroke' | 'stroke-saved' | 'game',
    payload: unknown
  ): Promise<void> {
    const channel = this.channelRef;
    if (!channel) throw new Error('Le canal de peinture n’est pas connecté.');

    const send = this.sendQueue.then(async () => {
      const status = await channel.send({ type: 'broadcast', event: eventName, payload });
      if (status !== 'ok') throw new Error('Impossible de synchroniser la partie avec les autres joueurs.');
    });
    this.sendQueue = send.catch(() => undefined);
    return send;
  }

  private async getInitialStrokes(roomCode: string, token: string): Promise<PaintStroke[]> {
    const { data, error } = await this.supabase.rpc('get_paint_strokes', {
      p_room_code: roomCode,
      p_token: token,
    });
    if (error) throw new Error(error.message || 'Impossible de charger la toile.');
    if (!Array.isArray(data)) throw new Error('La réponse contenant la toile est invalide.');

    return data.map((row: unknown) => parsePaintStroke(row, (seat, color) => this.isColorForSeat(seat, color)));
  }

  private isColorForSeat(seat: number, color: string): boolean {
    if (this.playerColorsAreSynchronized) {
      return color.toLowerCase() === this.getSeatColor(seat);
    }
    return isAvailablePaintColor(color);
  }

  private waitForSubscription(channel: RealtimeChannel): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Le canal de peinture ne répond pas.'));
      }, INITIAL_PAINT_TIMEOUT_MS);

      channel.subscribe((status) => {
        if (settled) return;
        if (status === 'SUBSCRIBED') {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Connexion au canal de peinture impossible.'));
        }
      });
    });
  }
}

export function parsePaintGameEvent(value: unknown): PaintGameEvent | null {
  return isRecord(value) && value['type'] === 'state-changed'
    ? { type: 'state-changed' }
    : null;
}

function parsePaintGameState(value: unknown): PaintGameState | null {
  if (!isRecord(value)) return null;
  const phase = value['phase'];
  const model = parsePaintModel(value['model']);
  const rawPlayerColors = value['playerColors'];
  const observationSeconds = value['observationSeconds'];
  const paintingSeconds = value['paintingSeconds'];
  const score = value['score'];
  const revision = value['revision'];
  const revealUsedSeats = value['revealUsedSeats'];
  const revealUntilBySeat = value['revealUntilBySeat'];
  if (
    (phase !== 'observation' && phase !== 'painting' && phase !== 'results') ||
    !model ||
    !Array.isArray(rawPlayerColors) ||
    rawPlayerColors.length < 2 ||
    rawPlayerColors.length > PAINT_PALETTE.length ||
    typeof observationSeconds !== 'number' ||
    !Number.isInteger(observationSeconds) ||
    observationSeconds < 0 ||
    observationSeconds > OBSERVATION_DURATION_SECONDS ||
    typeof paintingSeconds !== 'number' ||
    !Number.isInteger(paintingSeconds) ||
    paintingSeconds < 0 ||
    paintingSeconds > PAINTING_DURATION_SECONDS ||
    (score !== null && (typeof score !== 'number' || !Number.isInteger(score) || score < 0 || score > 100)) ||
    typeof revision !== 'number' ||
    !Number.isInteger(revision) ||
    revision < 0 ||
    !Array.isArray(revealUsedSeats) ||
    !revealUsedSeats.every(isSeat) ||
    !isRecord(revealUntilBySeat)
  ) {
    return null;
  }

  const playerColors: string[] = [];
  for (const color of rawPlayerColors) {
    if (typeof color !== 'string' || !isAvailablePaintColor(color)) return null;
    playerColors.push(color.toLowerCase());
  }
  if (new Set(playerColors).size !== playerColors.length) return null;
  const markColors = new Set(model.marks.map((mark) => mark.color));
  if (
    model.marks.length !== playerColors.length * 2 ||
    markColors.size !== playerColors.length ||
    playerColors.some((color) => !markColors.has(color))
  ) {
    return null;
  }

  const parsedRevealTimes: Record<string, number> = {};
  for (const [seat, until] of Object.entries(revealUntilBySeat)) {
    if (
      !/^[0-3]$/.test(seat) ||
      typeof until !== 'number' ||
      !Number.isFinite(until)
    ) {
      return null;
    }
    parsedRevealTimes[seat] = until;
  }
  return {
    phase,
    model,
    playerColors,
    observationSeconds,
    paintingSeconds,
    score,
    revision,
    revealUsedSeats: [...new Set(revealUsedSeats)],
    revealUntilBySeat: parsedRevealTimes,
  };
}

function parsePaintModel(value: unknown): PaintModel | null {
  if (
    !isRecord(value) ||
    !Number.isInteger(value['seed']) ||
    typeof value['seed'] !== 'number' ||
    value['seed'] < 0 ||
    value['seed'] > 0xffff_ffff ||
    !Array.isArray(value['marks']) ||
    value['marks'].length < 4 ||
    value['marks'].length > PAINT_PALETTE.length * 2
  ) {
    return null;
  }
  const generatedAt = value['generatedAt'];
  if (typeof generatedAt !== 'number' || !Number.isFinite(generatedAt)) return null;
  const marks: PaintModelMark[] = [];
  for (const mark of value['marks']) {
    if (
      !isRecord(mark) ||
      typeof mark['id'] !== 'string' ||
      (mark['kind'] !== 'oval' && mark['kind'] !== 'sweep') ||
      typeof mark['color'] !== 'string' ||
      !isAvailablePaintColor(mark['color']) ||
      !Array.isArray(mark['points']) ||
      mark['points'].length < (mark['kind'] === 'oval' ? 10 : 6) ||
      mark['points'].length > 12 ||
      typeof mark['opacity'] !== 'number' ||
      !Number.isFinite(mark['opacity']) ||
      mark['opacity'] < 0.4 ||
      mark['opacity'] > 0.8 ||
      (mark['kind'] === 'sweep' &&
        (typeof mark['width'] !== 'number' || !Number.isFinite(mark['width']) || mark['width'] < 0.10 || mark['width'] > 0.30))
    ) {
      return null;
    }
    try {
      const base = {
        id: mark['id'],
        color: mark['color'].toLowerCase(),
        points: mark['points'].map(parsePoint),
        opacity: mark['opacity'],
      };
      if (mark['kind'] === 'oval') {
        marks.push({ ...base, kind: 'oval' });
      } else {
        const width = mark['width'];
        if (typeof width !== 'number') return null;
        marks.push({ ...base, kind: 'sweep', width });
      }
    } catch {
      return null;
    }
  }

  if (new Set(marks.map((mark) => mark.id)).size !== marks.length) return null;
  return { seed: value['seed'], marks, generatedAt };
}

function parsePaintStroke(value: unknown, isColorForSeat: (seat: number, color: string) => boolean): PaintStroke {
  if (!isRecord(value)) throw new Error('Un trait enregistré est invalide.');

  const id = value['id'];
  const seat = value['seat'];
  const color = value['color'];
  const rawPoints = value['points'];
  if (
    typeof id !== 'string' ||
    !isSeat(seat) ||
    typeof color !== 'string' ||
    !isPaintColor(color) ||
    !Array.isArray(rawPoints) ||
    rawPoints.length === 0 ||
    rawPoints.length > MAX_STROKE_POINTS ||
    !isColorForSeat(seat, color)
  ) {
    throw new Error('Un trait enregistré est invalide.');
  }

  return { id, seat, color: color.toLowerCase(), points: rawPoints.map(parsePoint) };
}

function parsePaintStrokeEvent(
  value: unknown,
  isColorForSeat: (seat: number, color: string) => boolean,
): PaintStrokeEvent | null {
  if (!isRecord(value)) return null;

  const strokeId = value['strokeId'];
  const seat = value['seat'];
  const color = value['color'];
  const type = value['type'];
  if (
    typeof strokeId !== 'string' ||
    !strokeId ||
    !isSeat(seat) ||
    typeof color !== 'string' ||
    !isPaintColor(color) ||
    !isColorForSeat(seat, color) ||
    (type !== 'start' && type !== 'move' && type !== 'end')
  ) {
    return null;
  }

  if (type === 'end') return { strokeId, seat, color: color.toLowerCase(), type };
  const rawPoints = value['points'];
  if (!Array.isArray(rawPoints) || rawPoints.length === 0 || rawPoints.length > 256) return null;
  try {
    return { strokeId, seat, color: color.toLowerCase(), type, points: rawPoints.map(parsePoint) };
  } catch {
    return null;
  }
}

function parsePoint(value: unknown): PaintPoint {
  if (!isRecord(value)) throw new Error('Coordonnée invalide.');
  const x = value['x'];
  const y = value['y'];
  const radius = value['radius'];
  if (
    !isNormalizedCoordinate(x) ||
    !isNormalizedCoordinate(y) ||
    (radius !== undefined && (typeof radius !== 'number' || !Number.isFinite(radius) || radius < 0.5 || radius > 8))
  ) {
    throw new Error('Coordonnée invalide.');
  }
  return {
    x,
    y,
    ...(typeof radius === 'number' ? { radius } : {}),
  };
}

function readCellColor(
  image: ImageData,
  column: number,
  row: number,
  columns: number,
  rows: number,
  minimumCoverage: number
): [number, number, number] | null {
  const xStart = Math.floor(column * image.width / columns);
  const xEnd = Math.floor((column + 1) * image.width / columns);
  const yStart = Math.floor(row * image.height / rows);
  const yEnd = Math.floor((row + 1) * image.height / rows);
  let red = 0;
  let green = 0;
  let blue = 0;
  let paintedPixels = 0;

  for (let y = yStart; y < yEnd; y += 1) {
    for (let x = xStart; x < xEnd; x += 1) {
      const offset = (y * image.width + x) * 4;
      const pixelRed = image.data[offset];
      const pixelGreen = image.data[offset + 1];
      const pixelBlue = image.data[offset + 2];
      if (pixelRed === undefined || pixelGreen === undefined || pixelBlue === undefined) continue;
      if (Math.hypot(255 - pixelRed, 255 - pixelGreen, 255 - pixelBlue) < 20) continue;
      red += pixelRed;
      green += pixelGreen;
      blue += pixelBlue;
      paintedPixels += 1;
    }
  }

  const totalPixels = (xEnd - xStart) * (yEnd - yStart);
  if (!totalPixels || paintedPixels / totalPixels < minimumCoverage) return null;
  return [
    red / paintedPixels,
    green / paintedPixels,
    blue / paintedPixels,
  ];
}

function colorSimilarity(first: [number, number, number], second: [number, number, number]): number {
  const firstVector = first.map((channel) => 255 - channel);
  const secondVector = second.map((channel) => 255 - channel);
  const firstMagnitude = Math.hypot(...firstVector);
  const secondMagnitude = Math.hypot(...secondVector);
  if (!firstMagnitude || !secondMagnitude) return 0;
  const cosine = firstVector.reduce((sum, channel, index) => {
    return sum + channel * (secondVector[index] ?? 0);
  }, 0) / (firstMagnitude * secondMagnitude);
  return Math.max(0, Math.min(1, cosine));
}

function isPaintColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function isAvailablePaintColor(value: string): boolean {
  const normalized = value.toLowerCase();
  return isPaintColor(value) && (
    PAINT_PALETTE.some((color) => color === normalized) ||
    PAINT_COLOR_SETS.some((colors) => colors.some((color) => color === normalized))
  );
}

function isSeat(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < PAINT_PALETTE.length;
}

function isNormalizedCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function createOvalMark(
  id: string,
  color: string,
  placement: BlobPlacement,
  random: () => number,
): PaintModelMark {
  const radiusX = randomBetween(random, 0.30, 0.42);
  const radiusY = randomBetween(random, 0.22, 0.32);
  const centerX = clamp(placement.x, radiusX * 1.25 + 0.02, 1 - radiusX * 1.25 - 0.02);
  const centerY = clamp(placement.y, radiusY * 1.25 + 0.02, 1 - radiusY * 1.25 - 0.02);
  const pointCount = 10 + Math.floor(random() * 3);
  const rotation = random() * Math.PI * 2;
  const phase = random() * Math.PI * 2;
  const points = Array.from({ length: pointCount }, (_, index): PaintPoint => {
    const angle = rotation + index / pointCount * Math.PI * 2;
    const irregularity = 0.88
      + random() * 0.18
      + Math.sin(angle * 2 + phase) * 0.08
      + Math.cos(angle * 3 - phase) * 0.04;
    return {
      x: clamp(centerX + Math.cos(angle) * radiusX * irregularity, 0, 1),
      y: clamp(centerY + Math.sin(angle) * radiusY * irregularity, 0, 1),
    };
  });
  return {
    id,
    kind: 'oval',
    color,
    points,
    opacity: randomBetween(random, 0.56, 0.74),
  };
}

function createSweepMark(
  id: string,
  color: string,
  placement: BlobPlacement,
  random: () => number,
  accent = false,
): PaintModelMark {
  const width = accent
    ? randomBetween(random, 0.16, 0.24)
    : randomBetween(random, 0.20, 0.30);
  const radiusX = accent
    ? randomBetween(random, 0.32, 0.44)
    : randomBetween(random, 0.36, 0.48);
  const radiusY = accent
    ? randomBetween(random, 0.075, 0.13)
    : randomBetween(random, 0.09, 0.16);
  const curveType = Math.floor(random() * 3);
  const direction = random() < 0.5 ? -1 : 1;
  const phase = random() * Math.PI * 2;
  const arcSpan = randomBetween(random, 2.7, 4.1);
  const points = Array.from({ length: 6 }, (_, index): [number, number] => {
    const progress = index / 5;
    const horizontal = (progress - 0.5) * 2 * radiusX;
    if (curveType === 0) {
      const vertical = direction * radiusY * (1 - (2 * progress - 1) ** 2);
      return [horizontal, vertical];
    }
    if (curveType === 1) {
      return [horizontal, radiusY * 0.72 * Math.sin(progress * Math.PI * 2 + phase)];
    }

    const angle = (progress - 0.5) * arcSpan;
    return [radiusX * Math.cos(angle), radiusY * Math.sin(angle)];
  });
  const pathCenterX = (Math.min(...points.map(([x]) => x)) + Math.max(...points.map(([x]) => x))) / 2;
  const pathCenterY = (Math.min(...points.map(([, y]) => y)) + Math.max(...points.map(([, y]) => y))) / 2;
  const rotation = randomBetween(random, -Math.PI / 4, Math.PI / 4);
  const cosine = Math.cos(rotation);
  const sine = Math.sin(rotation);
  const rotatedPoints = points.map(([x, y]) => [
    (x - pathCenterX) * cosine - (y - pathCenterY) * sine,
    (x - pathCenterX) * sine + (y - pathCenterY) * cosine,
  ] as const);
  const minX = Math.min(...rotatedPoints.map(([x]) => x));
  const maxX = Math.max(...rotatedPoints.map(([x]) => x));
  const minY = Math.min(...rotatedPoints.map(([, y]) => y));
  const maxY = Math.max(...rotatedPoints.map(([, y]) => y));
  const horizontalPadding = width * 0.65;
  const verticalPadding = horizontalPadding * 1200 / 720;
  const centerX = clamp(placement.x, horizontalPadding - minX, 1 - horizontalPadding - maxX);
  const centerY = clamp(placement.y, verticalPadding - minY, 1 - verticalPadding - maxY);

  return {
    id,
    kind: 'sweep',
    color,
    width,
    points: rotatedPoints.map(([x, y]) => ({ x: centerX + x, y: centerY + y })),
    opacity: accent
      ? randomBetween(random, 0.44, 0.62)
      : randomBetween(random, 0.52, 0.7),
  };
}

function shuffle<T>(values: readonly T[], random: () => number): T[] {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function createRandomSeed(): number {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] ?? 0;
  }
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  if (state === 0) state = 0x9e37_79b9;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function randomBetween(random: () => number, minimum: number, maximum: number): number {
  return minimum + random() * (maximum - minimum);
}
