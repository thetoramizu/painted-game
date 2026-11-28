import { inject, Injectable, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { SupabaseService } from '../../athletes/core/supabase-client';
import { parseMotusState, type MotusLetterStatus, type MotusState } from '../models/motus';

const STATE_REFRESH_MS = 15_000;

@Injectable({ providedIn: 'root' })
export class MotusService {
  private readonly supabase = inject(SupabaseService).client;
  private readonly stateSignal = signal<MotusState | null>(null);
  readonly state = this.stateSignal.asReadonly();
  private readonly connectionErrorSignal = signal<string | null>(null);
  readonly connectionError = this.connectionErrorSignal.asReadonly();

  private channel: RealtimeChannel | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private roomCode = '';
  private token = '';
  private connectionId = 0;
  private pendingRefresh: Promise<void> | null = null;

  async connect(roomCode: string, token: string): Promise<void> {
    this.disconnect();
    const connectionId = ++this.connectionId;
    this.roomCode = roomCode;
    this.token = token;
    this.connectionErrorSignal.set(null);

    const channel = this.supabase.channel(`motus-scores-${roomCode}`);
    this.channel = channel;
    channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'motus_public_scores',
        filter: `room_code=eq.${roomCode}`,
      },
      () => {
        if (connectionId === this.connectionId) {
          void this.refresh().catch((error: unknown) => this.setConnectionError(error));
        }
      },
    );

    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Le canal MOTUS ne répond pas.')), 10_000);
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            clearTimeout(timeout);
            resolve();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            clearTimeout(timeout);
            reject(new Error('Connexion à MOTUS impossible.'));
          }
        });
      });

      await this.readState(connectionId);
      this.refreshTimer = setInterval(() => {
        void this.refresh().catch((error: unknown) => this.setConnectionError(error));
      }, STATE_REFRESH_MS);
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect(): void {
    this.connectionId += 1;
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (this.channel) void this.supabase.removeChannel(this.channel);
    this.channel = null;
    this.stateSignal.set(null);
    this.connectionErrorSignal.set(null);
    this.roomCode = '';
    this.token = '';
    this.pendingRefresh = null;
  }

  async refresh(): Promise<void> {
    if (this.pendingRefresh) return this.pendingRefresh;
    const connectionId = this.connectionId;
    const pending = this.readState(connectionId);
    this.pendingRefresh = pending;
    try {
      await pending;
    } finally {
      if (this.pendingRefresh === pending) this.pendingRefresh = null;
    }
  }

  async submitGuess(guess: string): Promise<{ found: boolean; feedback: MotusLetterStatus[] }> {
    const result = await this.callRpc('submit_motus_guess', {
      p_code: this.roomCode,
      p_token: this.token,
      p_guess: guess,
    });
    if (!isRecord(result) || result['success'] !== true) {
      throw new Error(
        isRecord(result) && typeof result['message'] === 'string'
          ? result['message']
          : 'La proposition a été refusée.',
      );
    }

    const feedback = result['feedback'];
    if (
      typeof result['found'] !== 'boolean' ||
      !Array.isArray(feedback) ||
      feedback.some((status) => status !== 'correct' && status !== 'present' && status !== 'absent')
    ) {
      throw new Error('Le serveur a retourné un résultat MOTUS invalide.');
    }

    await this.refresh();
    return { found: result['found'], feedback: feedback as MotusLetterStatus[] };
  }

  async skipWord(): Promise<void> {
    const result = await this.callRpc('skip_motus_word', {
      p_code: this.roomCode,
      p_token: this.token,
    });
    if (!isRecord(result) || result['success'] !== true) {
      throw new Error(
        isRecord(result) && typeof result['message'] === 'string'
          ? result['message']
          : 'Impossible de passer ce mot.',
      );
    }

    await this.refresh();
  }

  async returnToLobby(): Promise<void> {
    const result = await this.callRpc('return_motus_to_lobby', {
      p_code: this.roomCode,
      p_token: this.token,
    });
    if (!isRecord(result) || result['success'] !== true) {
      throw new Error(
        isRecord(result) && typeof result['message'] === 'string'
          ? result['message']
          : 'Impossible de retourner au salon.',
      );
    }
  }

  async restartGame(): Promise<void> {
    const result = await this.callRpc('restart_motus_game', {
      p_code: this.roomCode,
      p_token: this.token,
    });
    if (!isRecord(result) || result['success'] !== true) {
      throw new Error(
        isRecord(result) && typeof result['message'] === 'string'
          ? result['message']
          : 'Impossible de relancer la partie.',
      );
    }

    await this.refresh();
  }

  private async readState(connectionId: number): Promise<void> {
    if (!this.roomCode || !this.token) throw new Error('Session MOTUS invalide.');
    const { data, error } = await this.supabase.rpc('get_motus_state', {
      p_code: this.roomCode,
      p_token: this.token,
    });
    if (error) throw new Error(error.message || 'Impossible de charger la partie MOTUS.');
    if (connectionId !== this.connectionId) return;

    const state = parseMotusState(data);
    if (!state) throw new Error('Le serveur a retourné un état MOTUS invalide.');
    this.stateSignal.set(state);
    this.connectionErrorSignal.set(null);
  }

  private async callRpc(
    name: string,
    args: Record<string, string>,
  ): Promise<unknown> {
    const { data, error } = await this.supabase.rpc(name, args);
    if (error) throw new Error(error.message || 'La requête MOTUS a échoué.');
    return Array.isArray(data) ? data[0] : data;
  }

  private setConnectionError(error: unknown): void {
    this.connectionErrorSignal.set(
      error instanceof Error ? error.message : 'La synchronisation MOTUS a été interrompue.',
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
