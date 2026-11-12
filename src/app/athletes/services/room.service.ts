import { Injectable, signal } from '@angular/core';
import { supabase } from '../core/supabase-client';

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface RoomPlayer {
  pseudo: string;
  seat: number;
}

export interface RoomSnapshot {
  code: string;
  status: RoomStatus;
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
  private readonly snapshotSignal = signal<RoomSnapshot | null>(null);
  readonly snapshot = this.snapshotSignal.asReadonly();

  createRoom(pseudo: string): Promise<RoomSession> {
    return this.rpc<RoomSession>('create_room', { p_pseudo: pseudo }, isRoomSession);
  }

  joinRoom(code: string, pseudo: string): Promise<RoomSession> {
    return this.rpc<RoomSession>('join_room', { p_code: code, p_pseudo: pseudo }, isRoomSession);
  }

  async getRoom(code: string, pseudo: string): Promise<RoomSnapshot> {
    const snapshot = await this.rpc<RoomSnapshot>('get_room', { p_code: code, p_pseudo: pseudo }, isRoomSnapshot);
    this.snapshotSignal.set(snapshot);
    try {
      localStorage.setItem(SNAPSHOT_KEY_PREFIX + code, JSON.stringify(snapshot));
    } catch {
      // stockage non disponible : tant pis, le cache est un confort
    }
    return snapshot;
  }

  startRoom(code: string, pseudo: string): Promise<{ success: boolean; message: string }> {
    return this.rpc<{ success: boolean; message: string }>('start_room', { p_code: code, p_pseudo: pseudo }, isStartRoom);
  }

  saveToken(code: string, token: string): void {
    localStorage.setItem(TOKEN_KEY_PREFIX + code, token);
  }

  readToken(code: string): string | null {
    return localStorage.getItem(TOKEN_KEY_PREFIX + code);
  }

  private async rpc<T>(
    fn: string,
    args: Record<string, string>,
    isExpected: (data: unknown) => data is T,
  ): Promise<T> {
    const { data, error } = await supabase.rpc(fn, args);
    if (error) {
      throw new Error(error.message || UNKNOWN_ERROR);
    }
    if (!isExpected(data)) {
      throw new Error(UNKNOWN_ERROR);
    }
    // Supabase retourne un tableau pour les fonctions RETURNS TABLE
    return Array.isArray(data) ? (data[0] as T) : (data as T);
  }

  savePseudo(code: string, pseudo: string): void {
    localStorage.setItem(TOKEN_KEY_PREFIX + code + ':pseudo', pseudo);
  }

  readPseudo(code: string): string | null {
    return localStorage.getItem(TOKEN_KEY_PREFIX + code + ':pseudo');
  }
}

function isRoomSession(data: unknown): data is RoomSession {
  const value = Array.isArray(data) ? data[0] : data;
  return typeof value?.code === 'string' && typeof value?.token === 'string';
}

function isRoomSnapshot(data: unknown): data is RoomSnapshot {
  const value = Array.isArray(data) ? data[0] : data;
  return (
    typeof value?.code === 'string' &&
    typeof value?.status === 'string' &&
    typeof value?.mySeat === 'number' &&
    Array.isArray(value?.players)
  );
}

function isStartRoom(data: unknown): data is { success: boolean; message: string } {
  const value = Array.isArray(data) ? data[0] : data;
  return typeof value?.success === 'boolean' && typeof value?.message === 'string';
}
