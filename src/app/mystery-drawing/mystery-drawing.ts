import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { DrawingCanvas } from './components/drawing-canvas/drawing-canvas';
import { DrawingToolbar } from './components/drawing-toolbar/drawing-toolbar';
import { GuessChat } from './components/guess-chat/guess-chat';
import { PlayersList } from './components/players-list/players-list';
import { RoundSummary } from './components/round-summary/round-summary';
import { WordChoice } from './components/word-choice/word-choice';
import type { DrawingTool, ToolbarAction } from './models/mystery-drawing';
import { MysteryDrawingService } from './services/mystery-drawing.service';
import { RoomService } from '../athletes/services/room.service';

@Component({
  selector: 'app-mystery-drawing',
  standalone: true,
  imports: [DrawingCanvas, DrawingToolbar, GuessChat, PlayersList, RoundSummary, WordChoice],
  templateUrl: './mystery-drawing.html',
  styleUrl: './mystery-drawing.css',
})
export class MysteryDrawing implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roomService = inject(RoomService);
  private readonly gameService = inject(MysteryDrawingService);

  protected readonly state = this.gameService.state;
  protected readonly connectionError = this.gameService.connectionError;
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly secondsRemaining = signal(0);
  protected readonly color = signal('#171717');
  protected readonly brushSize = signal(8);
  protected readonly tool = signal<DrawingTool>('brush');
  protected readonly toolbarAction = signal<ToolbarAction | null>(null);
  protected readonly canvasResetVersion = signal(0);
  protected readonly isDrawer = computed(() => this.state()?.mySeat === this.state()?.drawerSeat);
  protected readonly drawerName = computed(() =>
    this.state()?.players.find((player) => player.seat === this.state()?.drawerSeat)?.pseudo ?? '…'
  );
  protected readonly visibleWord = computed(() => {
    const state = this.state();
    if (!state) return '…';
    if (state.secretWord) return state.secretWord;
    if (state.wordLength === null) return '…';
    return Array.from({ length: state.wordLength }, () => '_').join(' ');
  });
  protected readonly found = computed(() => this.state()?.guessedSeats.includes(this.state()?.mySeat ?? -1) ?? false);
  protected readonly isHost = computed(() => this.state()?.mySeat === 0);

  private unsubscribeRoom?: () => void;
  private clock: ReturnType<typeof setInterval> | null = null;
  private lastExpiryRefreshAt = 0;

  ngOnInit(): void {
    void this.initialize();
  }

  ngOnDestroy(): void {
    if (this.clock) clearInterval(this.clock);
    this.unsubscribeRoom?.();
    this.gameService.disconnect();
  }

  protected async chooseWord(word: string): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.gameService.chooseWord(word);
    } catch (error) {
      this.showError(error, 'Impossible de choisir ce mot.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async submitGuess(answer: string): Promise<void> {
    try {
      await this.gameService.guess(answer);
      this.error.set(null);
    } catch (error) {
      this.showError(error, 'Impossible d’envoyer cette réponse.');
    }
  }

  protected async drawAction(action: ToolbarAction): Promise<void> {
    try {
      await this.gameService.draw(action.kind, action.payload);
      this.error.set(null);
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Impossible de synchroniser le dessin.';
      try {
        await this.gameService.refresh();
      } catch (refreshError) {
        const detail = refreshError instanceof Error ? refreshError.message : 'actualisation impossible';
        message = `${message} (dessin non actualisé : ${detail})`;
      }
      this.canvasResetVersion.update((version) => version + 1);
      this.error.set(message);
    }
  }

  protected queueCanvasAction(action: ToolbarAction): void {
    this.toolbarAction.set(action);
  }

  protected async leaveGame(): Promise<void> {
    if (!window.confirm('Quitter la partie ? Vous pourrez revenir tant que la partie est en cours.')) return;
    await this.router.navigate(['/salon', this.state()?.roomCode ?? ''], { queryParams: { stay: '1' } });
  }

  protected async returnToLobby(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.gameService.returnToLobby();
      await this.router.navigate(['/salon', this.state()?.roomCode ?? '']);
    } catch (error) {
      this.showError(error, 'Impossible de retourner au salon.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async restartGame(): Promise<void> {
    if (!this.isHost() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.gameService.restartGame();
    } catch (error) {
      this.showError(error, 'Impossible de relancer la partie.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async returnToLobbyAsPlayer(): Promise<void> {
    const code = this.state()?.roomCode;
    if (code) await this.router.navigate(['/salon', code]);
  }

  private async initialize(): Promise<void> {
    const code = this.route.snapshot.paramMap.get('code');
    const token = code ? this.roomService.readToken(code) : null;
    if (!code || !token) {
      this.error.set('Vous n’avez pas accès à cette salle.');
      this.loading.set(false);
      return;
    }

    this.unsubscribeRoom = this.roomService.subscribeToRoomPicks(code, undefined, (status, gameType) => {
      if (status === 'lobby') void this.router.navigate(['/salon', code]);
      else if (status === 'playing' && gameType && gameType !== 'mystery') {
        void this.router.navigate(['/salon', code]);
      }
    });

    try {
      await this.gameService.connect(code, token);
      const state = this.state();
      if (!state || state.roomCode !== code) throw new Error('La partie ne correspond pas à cette salle.');
      this.loading.set(false);
      this.startClock();
    } catch (error) {
      this.showError(error, 'Impossible de rejoindre la partie.');
      this.loading.set(false);
    }
  }

  private startClock(): void {
    this.clock = setInterval(() => {
      const state = this.state();
      if (!state) return;
      const remaining = Math.max(0, Math.ceil((Date.parse(state.deadline) - Date.now()) / 1000));
      this.secondsRemaining.set(remaining);
      if (remaining === 0 && state.phase !== 'finished' && Date.now() - this.lastExpiryRefreshAt >= 3_000) {
        this.lastExpiryRefreshAt = Date.now();
        void this.gameService.refresh().catch((error: unknown) =>
          this.showError(error, 'Impossible de mettre à jour la manche.'),
        );
      }
    }, 1000);
  }

  private showError(error: unknown, fallback: string): void {
    this.error.set(error instanceof Error ? error.message : fallback);
  }
}
