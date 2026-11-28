import { inject, Injectable, signal } from '@angular/core';
import { SupabaseService } from '../core/supabase-client';

export type RoomStatus = 'lobby' | 'playing' | 'finished';
export type GameType = 'athletes' | 'paint' | 'portrait' | 'mystery';

export interface RoomPlayer {
  pseudo: string;
  seat: number;
  athleteId: string | null;
}

export interface RoomSnapshot {
  code: string;
  status: RoomStatus;
  gameType: GameType;
  mySeat: number;
  players: RoomPlayer[];
}

const SNAPSHOT_KEY_PREFIX = 'athletes-room-snapshot:';

export interface RoomSession {
  code: string;
  token: string;
  pseudo: string;
}

const TOKEN_KEY_PREFIX = 'athletes-room-token:';
const UNKNOWN_ERROR = 'Une erreur est survenue. Réessayez.';

@Injectable({ providedIn: 'root' })
export class RoomService {
  private readonly supabase = inject(SupabaseService).client;
  
    private readonly snapshotSignal = signal<RoomSnapshot | null>(null);
  readonly snapshot = this.snapshotSignal.asReadonly();

  /** Met à jour localement le snapshot avec les données reçues en temps réel */
  private updateLocalPlayer(seat: number, pseudo: string | null, athleteId: string | null): void {
    const current = this.snapshotSignal();
    if (!current) return;

    const playerExists = current.players.some((p) => p.seat === seat);
    let updatedPlayers: RoomPlayer[];

    if (playerExists) {
      updatedPlayers = current.players.map((p) =>
        p.seat === seat
          ? { 
              ...p, 
              pseudo: pseudo ?? p.pseudo, 
              athleteId: athleteId !== null ? athleteId : p.athleteId 
            }
          : p
      );
    } else {
      updatedPlayers = [
        ...current.players, 
        { seat, pseudo: pseudo ?? '', athleteId: athleteId ?? null }
      ];
    }

    this.snapshotSignal.set({
      ...current,
      players: updatedPlayers.sort((a, b) => a.seat - b.seat),
    });
  }

  createRoom(pseudo: string): Promise<RoomSession> {

    return this.rpc<RoomSession>('create_room', { p_pseudo: pseudo }, isRoomSession);
  }

  joinRoom(code: string, pseudo: string): Promise<RoomSession> {
    return this.rpc<RoomSession>('join_room', { p_code: code, p_pseudo: pseudo }, isRoomSession);
  }

  async getRoom(code: string, token: string): Promise<RoomSnapshot> {
    const snapshot = await this.rpc<RoomSnapshot>('get_room', { p_code: code, p_token: token }, isRoomSnapshot);
    this.snapshotSignal.set(snapshot);
    try {
      localStorage.setItem(SNAPSHOT_KEY_PREFIX + code, JSON.stringify(snapshot));
    } catch {
      // stockage non disponible : tant pis, le cache est un confort
    }
    return snapshot;
  }

  /** Récupérer les choix d'athlètes enregistrés pour une salle (par siège). */
  getPicks(code: string): Promise<{ seat: number; athlete_id: string | null }[]> {
    return this.rpc(
      'get_picks',
      { p_code: code },
      (data): data is { seat: number; athlete_id: string | null }[] =>
        Array.isArray(data) &&
        data.every((row) =>
          isRecord(row) &&
          typeof row['seat'] === 'number' &&
          (typeof row['athlete_id'] === 'string' || row['athlete_id'] === null),
        ),
      true,
    );
  }

  /** Enregistrer le choix d'un athlète pour un joueur (synchrone, via RPC). */
  async updatePick(code: string, token: string, seat: number, athleteId: string): Promise<void> {
    const result = await this.rpc<{ success: boolean; message: string }>(
      'set_pick',
      { p_code: code, p_token: token, p_seat: seat, p_athlete_id: athleteId },
      isStartRoom,
    );
    if (!result.success) throw new Error(result.message);
  }

  async updateGameType(code: string, token: string, gameType: GameType): Promise<void> {
    const result = await this.rpc<{ success: boolean; message: string }>(
      'set_room_game',
      { p_code: code, p_token: token, p_game_type: gameType },
      isStartRoom
    );
    if (!result.success) throw new Error(result.message);

    const current = this.snapshotSignal();
    if (current?.code === code) {
      this.snapshotSignal.set({ ...current, gameType });
    }
  }

  /**
   * Écouter les changements de choix d'athlètes en temps réel pour une salle.
   * Quand un autre joueur choisit, la callback est appelée avec (siège, athlète).
   * Retourne une fonction pour stopper l'écoute.
   */
    subscribeToRoomPicks(
      code: string,
      callback?: (seat: number, pseudo: string | null, athleteId: string | null) => void,
      onStatusChange?: (status: RoomStatus, gameType: GameType | null) => void
    ): (() => void) {
      const channel = this.supabase.channel(`room-picks-${code}`);

      const handleUpdate = (seat: number, pseudo: string | null, athleteId: string | null) => {
        this.updateLocalPlayer(seat, pseudo, athleteId);
        if (callback) callback(seat, pseudo, athleteId);
      };

      // Écouter les INSERT (nouveaux joueurs qui rejoignent la salle)
      channel.on('postgres_changes', {
        event: 'INSERT',
        schema: 'public',
        table: 'room_players',
        filter: `room_code=eq.${code}`,
      }, (payload) => {
        const newSeat = payload.new?.['seat'];
        const newPseudo = payload.new?.['pseudo'];
        const newAthleteId = payload.new?.['athlete_id'];
      
        if (newSeat !== undefined && newPseudo !== undefined) {
          handleUpdate(newSeat, newPseudo as string | null, null);
        } else if (newSeat !== undefined && newAthleteId !== undefined) {
          handleUpdate(newSeat, null, newAthleteId as string | null);
        }
      });

      // Écouter les UPDATE (mise à jour du choix d'athlète)
      channel.on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'room_players',
        filter: `room_code=eq.${code}`,
      }, (payload) => {
        const newSeat = payload.new?.['seat'];
        const newAthleteId = payload.new?.['athlete_id'];
        if (newSeat !== undefined && newAthleteId !== undefined) {
          handleUpdate(newSeat, null, newAthleteId as string | null);
        }
      });

      // Écouter les UPDATE (changement de statut de la salle)
      channel.on('postgres_changes', {
        event: 'UPDATE',
        schema: 'public',
        table: 'rooms',
        filter: `code=eq.${code}`,
      }, (payload) => {
        const newStatus = payload.new?.['status'];
        const newGameType = payload.new?.['game_type'];
        if (isRoomStatus(newStatus)) {
          if (isGameType(newGameType)) this.updateLocalGameType(code, newGameType);
          onStatusChange?.(newStatus, isGameType(newGameType) ? newGameType : null);
        } else if (isGameType(newGameType)) {
          this.updateLocalGameType(code, newGameType);
        }
      });


      // ← AJOUT : Souscrire au channel pour activer les événements en temps réel
      channel.subscribe();
      return () => {
        void this.supabase.removeChannel(channel);
      };
    }

  startRoom(code: string, token: string): Promise<{ success: boolean; message: string }> {
    return this.rpc<{ success: boolean; message: string }>(
      'start_room',
      { p_code: code, p_token: token },
      isStartRoom,
    );
  }

  startMysteryGame(code: string, token: string): Promise<{ success: boolean; message: string }> {
    return this.rpc<{ success: boolean; message: string }>(
      'start_mystery_game',
      { p_code: code, p_token: token },
      isStartRoom
    );
  }

  async finishPaintGame(code: string, token: string): Promise<void> {
    const result = await this.rpc<{ success: boolean; message: string }>(
      'finish_paint_game',
      { p_code: code, p_token: token },
      isStartRoom
    );
    if (!result.success) throw new Error(result.message);
  }

  async finishRoomGame(code: string, token: string): Promise<void> {
    const result = await this.rpc<{ success: boolean; message: string }>(
      'finish_room_game',
      { p_code: code, p_token: token },
      isStartRoom
    );
    if (!result.success) throw new Error(result.message);
  }

  saveToken(code: string, token: string): void {
    localStorage.setItem(TOKEN_KEY_PREFIX + code, token);
  }

  readToken(code: string): string | null {
    return localStorage.getItem(TOKEN_KEY_PREFIX + code);
  }

  private async rpc<T>(
    fn: string,
    args: Record<string, string | number>,
    isExpected: (data: unknown) => boolean,
    expectArray = false
  ): Promise<T> {
    const { data, error } = await this.supabase.rpc(fn, args);
    if (error) {
      throw new Error(error.message || UNKNOWN_ERROR);
    }
    if (!isExpected(data)) {
      throw new Error(UNKNOWN_ERROR);
    }
    // Supabase retourne un tableau pour les fonctions RETURNS TABLE
    // Si expectArray=true, on retourne le tableau complet, sinon on prend data[0]
    return expectArray ? (data as unknown as T) : (Array.isArray(data) ? (data[0] as T) : (data as T));
  }

  private updateLocalGameType(code: string, gameType: GameType): void {
    const current = this.snapshotSignal();
    if (current?.code === code) this.snapshotSignal.set({ ...current, gameType });
  }

}

function isRoomSession(data: unknown): data is RoomSession {
  const value = Array.isArray(data) ? data[0] : data;
  return typeof value?.code === 'string' && typeof value?.token === 'string';
}

function isRoomSnapshot(data: unknown): data is RoomSnapshot {
  const value = Array.isArray(data) ? data[0] : data;
  return (
    isRecord(value) &&
    typeof value['code'] === 'string' &&
    isRoomStatus(value['status']) &&
    isGameType(value['gameType']) &&
    typeof value['mySeat'] === 'number' &&
    Array.isArray(value['players'])
  );
}

function isStartRoom(data: unknown): data is { success: boolean; message: string } {
  const value = Array.isArray(data) ? data[0] : data;
  return isRecord(value) && typeof value['success'] === 'boolean' && typeof value['message'] === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRoomStatus(value: unknown): value is RoomStatus {
  return value === 'lobby' || value === 'playing' || value === 'finished';
}

function isGameType(value: unknown): value is GameType {
  return value === 'athletes' || value === 'paint' || value === 'portrait' || value === 'mystery';
}
