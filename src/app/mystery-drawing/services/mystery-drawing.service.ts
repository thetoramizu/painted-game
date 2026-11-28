import { inject, Injectable, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SupabaseService } from '../../athletes/core/supabase-client';
import type { DrawingOperation, MysteryEvent, MysteryState } from '../models/mystery-drawing';

const STATE_REFRESH_MS = 15_000;

interface PendingDrawAction {
  connectionId: number;
  roomCode: string;
  token: string;
  kind: DrawingOperation;
  payload: Record<string, unknown>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

@Injectable({ providedIn: 'root' })
export class MysteryDrawingService {
  private readonly supabase = inject(SupabaseService).client;
  private readonly stateSignal = signal<MysteryState | null>(null);
  readonly state = this.stateSignal.asReadonly();
  private readonly connectionErrorSignal = signal<string | null>(null);
  readonly connectionError = this.connectionErrorSignal.asReadonly();

  private channel: RealtimeChannel | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private roomCode = '';
  private token = '';
  private pendingRefresh: Promise<void> | null = null;
  private readonly drawQueue: PendingDrawAction[] = [];
  private processingDrawQueue = false;
  private connectionId = 0;

  async connect(roomCode: string, token: string): Promise<void> {
    this.disconnect();
    const connectionId = ++this.connectionId;
    this.roomCode = roomCode;
    this.token = token;
    this.connectionErrorSignal.set(null);

    const channel = this.supabase.channel(`mystery-events-${roomCode}`);
    this.channel = channel;
    channel.on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'mystery_events', filter: `room_code=eq.${roomCode}` },
      (change) => {
        if (connectionId === this.connectionId) this.receiveEvent(change.new);
      },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Le canal de la partie ne répond pas.')), 10_000);
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timeout);
            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timeout);
            reject(new Error('Connexion au jeu impossible.'));
          }
        });
      });

      await this.readState(connectionId);
      this.heartbeatTimer = setInterval(() => void this.heartbeat(), STATE_REFRESH_MS);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect(): void {
    this.connectionId += 1;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    if (this.channel) void this.supabase.removeChannel(this.channel);
    this.channel = null;
    this.stateSignal.set(null);
    this.connectionErrorSignal.set(null);
    this.roomCode = '';
    this.token = '';
    this.pendingRefresh = null;
    for (const action of this.drawQueue.splice(0)) {
      action.reject(new Error('La connexion au jeu a changé.'));
    }
  }

  async refresh(): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh;
    const connectionId = this.connectionId;
    this.pendingRefresh = this.readState(connectionId);
    try {
      await this.pendingRefresh;
    } finally {
      this.pendingRefresh = null;
    }
  }

  async chooseWord(word: string): Promise<void> {
    const result = await this.callRpc('choose_mystery_word', {
      p_code: this.roomCode,
      p_token: this.token,
      p_word: word,
    });
    this.assertSuccess(result);
    await this.refresh();
  }

  async draw(kind: DrawingOperation, payload: Record<string, unknown>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.drawQueue.push({
        connectionId: this.connectionId,
        roomCode: this.roomCode,
        token: this.token,
        kind,
        payload,
        resolve,
        reject,
      });
      this.processDrawQueue();
    });
  }

  async guess(text: string): Promise<void> {
    const result = await this.callRpc('submit_mystery_guess', {
      p_code: this.roomCode,
      p_token: this.token,
      p_guess: text,
    });
    this.assertSuccess(result);
    await this.refresh();
  }

  async returnToLobby(): Promise<void> {
    const result = await this.callRpc('return_mystery_to_lobby', {
      p_code: this.roomCode,
      p_token: this.token,
    });
    this.assertSuccess(result);
  }

  async restartGame(): Promise<void> {
    const result = await this.callRpc('restart_mystery_game', {
      p_code: this.roomCode,
      p_token: this.token,
    });
    if (!isRecord(result) || result['success'] !== true) {
      throw new Error(isRecord(result) && typeof result['message'] === 'string'
        ? result['message']
        : 'Impossible de relancer le jeu.');
    }
    await this.refresh();
  }

  private async heartbeat(): Promise<void> {
    if (!this.roomCode || !this.token) return;
    const connectionId = this.connectionId;
    const roomCode = this.roomCode;
    const token = this.token;
    try {
      const { error } = await this.supabase.rpc('mystery_heartbeat', { p_code: roomCode, p_token: token });
      if (connectionId !== this.connectionId) return;
      if (error) {
        this.connectionErrorSignal.set(error.message || 'La synchronisation a été interrompue.');
        return;
      }
      this.connectionErrorSignal.set(null);
      await this.refresh();
    } catch (error) {
      if (connectionId !== this.connectionId) return;
      this.connectionErrorSignal.set(
        error instanceof Error ? error.message : 'Impossible de rafraîchir la partie.',
      );
    }
  }

  private async readState(connectionId: number): Promise<void> {
    if (!this.roomCode || !this.token) throw new Error('Session Dessin Mystère invalide.');
    const { data, error } = await this.supabase.rpc('get_mystery_state', {
      p_code: this.roomCode,
      p_token: this.token,
    });
    if (error) throw new Error(error.message || 'Impossible de charger la partie.');
    if (connectionId !== this.connectionId) return;
    const state = parseMysteryState(data);
    if (!state) throw new Error('Le serveur a retourné un état de partie invalide.');
    const latest = this.stateSignal();
    if (latest?.roomCode === state.roomCode) {
      const eventMap = new Map<number, MysteryEvent>();
      for (const event of [...state.events, ...latest.events]) eventMap.set(event.id, event);
      const events = [...eventMap.values()].sort((a, b) => a.id - b.id);
      this.stateSignal.set(latest.revision > state.revision ? { ...latest, events } : { ...state, events });
    } else {
      this.stateSignal.set(state);
    }
  }

  private receiveEvent(value: unknown): void {
    const event = parseMysteryEvent(value);
    const current = this.stateSignal();
    if (!event || !current || current.events.some((existing) => existing.id === event.id)) return;
    this.stateSignal.set({ ...current, events: [...current.events, event].sort((a, b) => a.id - b.id) });
    if (event.kind === 'system' || event.kind === 'summary' || event.kind === 'found') {
      void this.refresh().catch((error: unknown) => {
        this.connectionErrorSignal.set(
          error instanceof Error ? error.message : 'Impossible de rafraîchir la partie.',
        );
      });
    }
  }

  private processDrawQueue(): void {
    if (this.processingDrawQueue) return;
    this.processingDrawQueue = true;
    void this.drainDrawQueue();
  }

  private async drainDrawQueue(): Promise<void> {
    try {
      while (this.drawQueue.length) {
        const first = this.drawQueue.shift();
        if (!first) continue;
        const batch = [first];
        let payload = first.payload;
        const points = Array.isArray(payload['points']) ? [...payload['points']] : null;
        const clientEventIds = typeof payload['clientEventId'] === 'string'
          ? [payload['clientEventId']]
          : [];

        if (first.kind === 'points' && points) {
          while (this.drawQueue.length) {
            const next = this.drawQueue[0];
            const nextPoints = next.kind === 'points' && Array.isArray(next.payload['points'])
              ? next.payload['points']
              : null;
            if (
              !nextPoints ||
              next.connectionId !== first.connectionId ||
              points.length + nextPoints.length > 64
            ) break;
            this.drawQueue.shift();
            batch.push(next);
            points.push(...nextPoints);
            if (typeof next.payload['clientEventId'] === 'string') {
              clientEventIds.push(next.payload['clientEventId']);
            }
          }
          if (batch.length > 1) {
            payload = { ...payload, points, clientEventIds };
            delete payload['clientEventId'];
          }
        }

        try {
          if (first.connectionId !== this.connectionId) {
            throw new Error('La connexion au jeu a changé.');
          }
          const result = await this.callRpc('add_mystery_drawing_event', {
            p_code: first.roomCode,
            p_token: first.token,
            p_kind: first.kind,
            p_payload: payload,
          });
          this.assertSuccess(result);
          for (const action of batch) action.resolve();
        } catch (error) {
          for (const action of batch) action.reject(error);
        }
      }
    } finally {
      this.processingDrawQueue = false;
      if (this.drawQueue.length) this.processDrawQueue();
    }
  }

  private async callRpc(name: string, args: Record<string, string | number | Record<string, unknown>>): Promise<unknown> {
    const { data, error } = await this.supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'La requête a échoué.');
    return data;
  }

  private assertSuccess(value: unknown): void {
    const result = Array.isArray(value) ? value[0] : value;
    if (!isRecord(result) || result['success'] !== true) {
      const message = isRecord(result) && typeof result['message'] === 'string'
        ? result['message']
        : 'Le serveur a refusé cette action.';
      throw new Error(message);
    }
  }
}

export function parseMysteryState(value: unknown): MysteryState | null {
  if (!isRecord(value)) return null;
  const phase = value['phase'];
  const players = value['players'];
  const events = value['events'];
  const wordOptions = value['wordOptions'];
  if (
    typeof value['roomCode'] !== 'string' ||
    typeof value['mySeat'] !== 'number' ||
    !Array.isArray(players) ||
    typeof value['round'] !== 'number' ||
    typeof value['totalRounds'] !== 'number' ||
    (phase !== 'choosing' && phase !== 'drawing' && phase !== 'summary' && phase !== 'finished') ||
    typeof value['drawerSeat'] !== 'number' ||
    typeof value['deadline'] !== 'string' ||
    typeof value['revision'] !== 'number' ||
    !Array.isArray(value['guessedSeats']) ||
    !Array.isArray(value['drawnSeats']) ||
    !Array.isArray(events) ||
    !Array.isArray(wordOptions)
  ) return null;

  const parsedPlayers = players.map(parsePlayer);
  const parsedEvents = events.map(parseMysteryEvent);
  if (parsedPlayers.some((player) => player === null) || parsedEvents.some((event) => event === null)) return null;

  return {
    roomCode: value['roomCode'],
    mySeat: value['mySeat'],
    players: parsedPlayers.filter((player): player is NonNullable<typeof player> => player !== null),
    round: value['round'],
    totalRounds: value['totalRounds'],
    phase,
    drawerSeat: value['drawerSeat'],
    deadline: value['deadline'],
    revision: value['revision'],
    guessedSeats: value['guessedSeats'].filter((seat): seat is number => typeof seat === 'number'),
    drawnSeats: value['drawnSeats'].filter((seat): seat is number => typeof seat === 'number'),
    wordLength: typeof value['wordLength'] === 'number' ? value['wordLength'] : null,
    secretWord: typeof value['secretWord'] === 'string' ? value['secretWord'] : null,
    wordOptions: wordOptions.filter((word): word is string => typeof word === 'string'),
    events: parsedEvents.filter((event): event is NonNullable<typeof event> => event !== null),
  };
}

function parsePlayer(value: unknown): { seat: number; pseudo: string } | null {
  if (!isRecord(value) || typeof value['seat'] !== 'number' || typeof value['pseudo'] !== 'string') return null;
  return { seat: value['seat'], pseudo: value['pseudo'] };
}

export function parseMysteryEvent(value: unknown): MysteryEvent | null {
  if (!isRecord(value) || !isRecord(value['payload'])) return null;
  const kind = value['kind'];
  const id = value['id'];
  const roundIndex = value['roundIndex'] ?? value['round_index'];
  const actorSeat = value['actorSeat'] ?? value['actor_seat'] ?? null;
  if (
    typeof id !== 'number' ||
    typeof roundIndex !== 'number' ||
    (kind !== 'drawing' && kind !== 'chat' && kind !== 'found' && kind !== 'system' && kind !== 'summary') ||
    (actorSeat !== null && typeof actorSeat !== 'number')
  ) return null;
  return {
    id,
    roundIndex,
    kind,
    actorSeat,
    payload: value['payload'],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
