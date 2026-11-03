import { Injectable, signal } from '@angular/core';
import { io, Socket } from 'socket.io-client';
import { GamePhase, PlayerInfo, RoomState, Stroke, GeneratedModel } from './models';

/**
 * Service de synchronisation temps réel. Le serveur est la source de vérité ;
 * les clients reçoivent l'état complet (RoomState) + les strokes en flux continu.
 */
@Injectable({ providedIn: 'root' })
export class GameService {
  readonly phase = signal<GamePhase | null>(null);
  readonly players = signal<PlayerInfo[]>([]);
  readonly strokes = signal<Stroke[]>([]);
  readonly model = signal<GeneratedModel | null>(null);
  readonly roomCode = signal<string | null>(null);
  readonly endsAt = signal<number | null>(null);
  readonly scores = signal<Record<string, number>>({});
  readonly isHost = signal(false);
  readonly error = signal<string | null>(null);
  readonly connected = signal(false);

  myId: string | null = null;
  private socket: Socket | null = null;

  connect(serverUrl: string): Socket {
    if (this.socket?.connected) return this.socket;
    this.socket = io(serverUrl, { transports: ['websocket', 'polling'] });
    this.socket.on('connect', () => this.connected.set(true));
    this.socket.on('disconnect', () => this.connected.set(false));
    this.socket.on('state', (s: RoomState) => this.applyState(s));
    this.socket.on('stroke', (st: Stroke) => {
      // stroke d'un autre joueur reçu en direct (optimiste local déjà rendu)
      if (!this.strokes().some((x) => x.id === st.id)) this.strokes.update((arr) => [...arr, st]);
    });
    this.socket.on('kicked', (reason: string) => this.error.set(reason));
    return this.socket;
  }

  private applyState(s: RoomState): void {
    this.roomCode.set(s.code);
    this.phase.set(s.phase);
    this.players.set(s.players);
    this.model.set(s.model);
    this.endsAt.set(s.endsAt);
    this.scores.set(s.scores);
    this.isHost.set(s.hostId === this.myId);
    // lors d'une nouvelle manche (phase playing avec strokes vidés) on resynchronise
    if (s.phase !== 'playing' || s.strokes.length !== this.strokes().length) {
      this.strokes.set(s.strokes);
    }
  }

  createRoom(name: string, serverUrl: string): void {
    const socket = this.connect(serverUrl);
    socket.emit('create-room', { name }, (res: { playerId: string }) => {
      this.myId = res.playerId;
    });
  }

  joinRoom(code: string, name: string, serverUrl: string): void {
    const socket = this.connect(serverUrl);
    socket.emit('join-room', { code: code.toUpperCase(), name }, (res: { playerId?: string; error?: string }) => {
      if (res.error) this.error.set(res.error);
      else this.myId = res.playerId!;
    });
  }

  start(): void {
    this.socket?.emit('start');
  }

  /** Envoie un trait fini au reste de la room */
  sendStroke(stroke: Stroke): void {
    this.strokes.update((arr) => [...arr, stroke]); // optimiste local
    this.socket?.emit('stroke', stroke);
  }

  undo(strokeId: string): void {
    this.strokes.update((arr) => arr.filter((s) => s.id !== strokeId));
    this.socket?.emit('undo', { strokeId });
  }

  /** Envoie le score de similarité calculé localement (fin de manche) */
  sendScore(value: number): void {
    this.socket?.emit('score', { value });
  }

  leave(): void {
    this.socket?.disconnect();
    this.socket = null;
    this.phase.set(null);
    this.roomCode.set(null);
    this.strokes.set([]);
    this.error.set(null);
  }
}
