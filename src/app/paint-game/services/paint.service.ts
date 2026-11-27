import { Injectable, inject, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SupabaseService } from '../../athletes/core/supabase-client';
import type { RoomSnapshot } from '../../athletes/services/room.service';

export type PaintStrokeType = 'start' | 'move' | 'end';

export interface PaintPoint {
  x: number;
  y: number;
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
  point?: PaintPoint;
  points?: PaintPoint[];
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

export const PAINT_PALETTE = ['#4f8cff', '#ff6b6b', '#2fbf71', '#f5a623'] as const;

const INITIAL_PAINT_TIMEOUT_MS = 10_000;

@Injectable({ providedIn: 'root' })
export class PaintService {
  private readonly supabase = inject(SupabaseService).client;
  private readonly sessionInfoSignal = signal<PaintSessionInfo | null>(null);
  readonly sessionInfo = this.sessionInfoSignal.asReadonly();
  private channelRef: RealtimeChannel | null = null;
  private sendQueue: Promise<void> = Promise.resolve();

  setSessionInfo(snapshot: RoomSnapshot): void {
    this.sessionInfoSignal.set({
      roomCode: snapshot.code,
      mySeat: snapshot.mySeat,
      players: [...snapshot.players]
        .sort((a, b) => a.seat - b.seat)
        .map((player) => ({
          seat: player.seat,
          pseudo: player.pseudo,
          color: this.getSeatColor(player.seat),
        })),
    });
  }

  getSeatColor(seat: number): string {
    return PAINT_PALETTE[seat] ?? PAINT_PALETTE[0];
  }

  async joinPaintChannel(
    roomCode: string,
    mySeat: number,
    onRemoteStroke: (event: PaintStrokeEvent) => void
  ): Promise<PaintStroke[]> {
    this.leavePaintChannel();

    const channel = this.supabase.channel(`paint-${roomCode}`);
    this.channelRef = channel;
    channel.on('broadcast', { event: 'stroke' }, (message: { payload: unknown }) => {
      const event = parsePaintStrokeEvent(message.payload);
      if (event && event.seat !== mySeat) onRemoteStroke(event);
    });

    try {
      await this.waitForSubscription(channel);
      return await this.getInitialStrokes(roomCode);
    } catch (error) {
      this.leavePaintChannel();
      throw error;
    }
  }

  async sendStrokeEvent(event: PaintStrokeEvent): Promise<void> {
    const channel = this.channelRef;
    if (!channel) {
      throw new Error('Le canal de peinture n’est pas connecté.');
    }
    if (!parsePaintStrokeEvent(event)) {
      throw new Error('Le trait envoyé est invalide.');
    }

    const send = this.sendQueue.then(async () => {
      const status = await channel.send({
        type: 'broadcast',
        event: 'stroke',
        payload: event,
      });
      if (status !== 'ok') {
        throw new Error('Impossible de synchroniser le trait avec les autres joueurs.');
      }
    });
    this.sendQueue = send.catch(() => undefined);
    return send;
  }

  async saveStroke(stroke: PaintStroke, roomCode: string): Promise<void> {
    const { data, error } = await this.supabase.rpc('add_paint_stroke', {
      p_stroke_id: stroke.id,
      p_room_code: roomCode,
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

  private async getInitialStrokes(roomCode: string): Promise<PaintStroke[]> {
    const { data, error } = await this.supabase.rpc('get_paint_strokes', {
      p_room_code: roomCode,
    });
    if (error) throw new Error(error.message || 'Impossible de charger la toile.');
    if (!Array.isArray(data)) throw new Error('La réponse contenant la toile est invalide.');

    return data.map((row: unknown) => parsePaintStroke(row));
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

function parsePaintStroke(value: unknown): PaintStroke {
  if (!isRecord(value)) throw new Error('Un trait enregistré est invalide.');

  const id = value['id'];
  const seat = value['seat'];
  const color = value['color'];
  const rawPoints = value['points'];
  if (
    typeof id !== 'string' ||
    typeof seat !== 'number' ||
    typeof color !== 'string' ||
    !Array.isArray(rawPoints)
  ) {
    throw new Error('Un trait enregistré est invalide.');
  }

  const points = rawPoints.map(parsePoint);
  if (!points.length || seat < 0 || seat >= PAINT_PALETTE.length || color.toLowerCase() !== PAINT_PALETTE[seat]) {
    throw new Error('Un trait enregistré est invalide.');
  }
  return { id, seat, color, points };
}

function parsePaintStrokeEvent(value: unknown): PaintStrokeEvent | null {
  if (!isRecord(value)) return null;

  const strokeId = value['strokeId'];
  const seat = value['seat'];
  const color = value['color'];
  const type = value['type'];
  if (
    typeof strokeId !== 'string' ||
    !strokeId ||
    typeof seat !== 'number' ||
    !Number.isInteger(seat) ||
    seat < 0 ||
    seat >= PAINT_PALETTE.length ||
    typeof color !== 'string' ||
    color.toLowerCase() !== PAINT_PALETTE[seat] ||
    (type !== 'start' && type !== 'move' && type !== 'end')
  ) {
    return null;
  }

  if (type === 'end') return { strokeId, seat, color, type };
  if (type === 'start') {
    try {
      return { strokeId, seat, color, type, point: parsePoint(value['point']) };
    } catch {
      return null;
    }
  }
  const rawPoints = value['points'];
  if (!Array.isArray(rawPoints) || rawPoints.length === 0 || rawPoints.length > 256) return null;
  try {
    return { strokeId, seat, color, type, points: rawPoints.map(parsePoint) };
  } catch {
    return null;
  }
}

function parsePoint(value: unknown): PaintPoint {
  if (!isRecord(value)) throw new Error('Coordonnée invalide.');
  const x = value['x'];
  const y = value['y'];
  if (
    typeof x !== 'number' ||
    typeof y !== 'number' ||
    !Number.isFinite(x) ||
    !Number.isFinite(y) ||
    x < 0 ||
    x > 1 ||
    y < 0 ||
    y > 1
  ) {
    throw new Error('Coordonnée invalide.');
  }
  return { x, y };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
