import {
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { RoomService } from '../athletes/services/room.service';
import { MotusService } from './services/motus.service';
import {
  deriveMotusKeyboardFeedback,
  formatMotusWordCount,
} from './models/motus';

@Component({
  selector: 'app-motus-game',
  standalone: true,
  templateUrl: './motus-game.html',
  styleUrl: './motus-game.css',
})
export class MotusGame implements OnInit, OnDestroy {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roomService = inject(RoomService);
  private readonly gameService = inject(MotusService);
  private readonly guessInput = viewChild<ElementRef<HTMLInputElement>>('guessInput');

  protected readonly state = this.gameService.state;
  protected readonly connectionError = this.gameService.connectionError;
  protected readonly loading = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly guessTail = signal('');
  protected readonly secondsRemaining = signal(0);
  protected readonly isHost = computed(() => this.state()?.mySeat === 0);
  protected readonly isFinished = computed(() => this.state()?.phase === 'finished');
  protected readonly hasFoundAll = computed(() => this.state()?.wordIndex === 16);
  protected readonly currentAttempts = computed(() => {
    const state = this.state();
    return state?.attempts.filter((attempt) => attempt.wordIndex === state.wordIndex) ?? [];
  });
  protected readonly guessCells = computed(() => {
    const state = this.state();
    if (!state?.wordLength) return [];
    const tail = Array.from(this.guessTail());
    return Array.from({ length: state.wordLength }, (_, index) =>
      index === 0 ? state.firstLetter?.toLocaleUpperCase('fr-FR') ?? '' : tail[index - 1] ?? '',
    );
  });
  protected readonly keyboardFeedback = computed(() =>
    deriveMotusKeyboardFeedback(this.currentAttempts()),
  );
  protected readonly rankedScores = computed(() => {
    const scores = [...(this.state()?.scores ?? [])].sort(
      (left, right) => right.wordsFound - left.wordsFound || left.seat - right.seat,
    );
    let rank = 0;
    let previousScore = -1;
    return scores.map((score, index) => {
      if (score.wordsFound !== previousScore) rank = index + 1;
      previousScore = score.wordsFound;
      return { ...score, rank };
    });
  });
  protected readonly keyboardRows = ['AZERTYUIOP', 'QSDFGHJKLM', 'WXCVBN'].map((row) =>
    Array.from(row),
  );

  private roomCode = '';
  private unsubscribeRoom?: () => void;
  private clock: ReturnType<typeof setInterval> | null = null;
  private expiryRefreshPending = false;
  private lastExpiryRefreshAt = 0;
  private serverClockOffset = 0;
  private lastServerNow = '';

  ngOnInit(): void {
    void this.initialize();
  }

  ngOnDestroy(): void {
    if (this.clock) clearInterval(this.clock);
    this.unsubscribeRoom?.();
    this.gameService.disconnect();
  }

  protected async submitGuess(): Promise<void> {
    const state = this.state();
    const guess = `${state?.firstLetter ?? ''}${this.guessTail()}`.trim();
    if (
      !state ||
      state.phase !== 'playing' ||
      state.wordIndex > 15 ||
      this.secondsRemaining() === 0 ||
      this.busy()
    ) return;
    if (Array.from(guess).length !== state.wordLength) {
      this.error.set('La proposition doit contenir le nombre de lettres affiché.');
      this.focusGuessInput();
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.gameService.submitGuess(guess);
      this.guessTail.set('');
      this.error.set(null);
    } catch (error) {
      this.showError(error, 'Impossible d’envoyer cette proposition.');
      try {
        await this.gameService.refresh();
      } catch (refreshError) {
        this.showError(refreshError, 'La partie n’a pas pu être resynchronisée.');
      }
    } finally {
      this.busy.set(false);
      this.focusGuessInput();
    }
  }

  protected async skipWord(): Promise<void> {
    const state = this.state();
    if (
      !state ||
      state.phase !== 'playing' ||
      state.wordIndex > 15 ||
      this.secondsRemaining() === 0 ||
      this.busy()
    ) return;
    if (!window.confirm('Passer ce mot ? Il ne comptera pas comme trouvé et vous ne pourrez plus y revenir.')) {
      this.focusGuessInput();
      return;
    }

    this.busy.set(true);
    this.error.set(null);
    try {
      await this.gameService.skipWord();
      this.guessTail.set('');
      this.error.set(null);
    } catch (error) {
      this.showError(error, 'Impossible de passer ce mot.');
      try {
        await this.gameService.refresh();
      } catch (refreshError) {
        this.showError(refreshError, 'La partie n’a pas pu être resynchronisée.');
      }
    } finally {
      this.busy.set(false);
      this.focusGuessInput();
    }
  }

  protected addLetter(letter: string): void {
    const state = this.state();
    if (!state || state.phase !== 'playing' || this.busy() || state.wordIndex > 15) return;
    const maxTailLength = (state.wordLength ?? 1) - 1;
    if (Array.from(this.guessTail()).length >= maxTailLength) {
      this.focusGuessInput();
      return;
    }
    this.guessTail.update((value) => value + letter);
    this.focusGuessInput();
  }

  protected removeLetter(): void {
    this.guessTail.update((value) => Array.from(value).slice(0, -1).join(''));
    this.focusGuessInput();
  }

  protected handleGuessInput(event: Event): void {
    const input = event.target;
    if (!(input instanceof HTMLInputElement)) return;
    const letters = Array.from(input.value.toLocaleUpperCase('fr-FR'))
      .filter((character) => /\p{L}/u.test(character))
      .slice(0, Math.max(0, (this.state()?.wordLength ?? 1) - 1));
    this.guessTail.set(letters.join(''));
    input.value = letters.join('');
  }

  protected handleGuessKeydown(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      event.preventDefault();
      void this.submitGuess();
    }
  }

  protected async leaveGame(): Promise<void> {
    if (!window.confirm('Quitter la partie ? Vous pourrez revenir tant qu’elle est en cours.')) return;
    await this.router.navigate(['/salon', this.roomCode], { queryParams: { stay: '1' } });
  }

  protected async returnToLobby(): Promise<void> {
    if (!this.isHost() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.gameService.returnToLobby();
      await this.router.navigate(['/salon', this.roomCode]);
    } catch (error) {
      this.showError(error, 'Impossible de retourner au salon.');
    } finally {
      this.busy.set(false);
    }
  }

  protected async restartGame(): Promise<void> {
    if (!this.isHost() || !this.isFinished() || this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.gameService.restartGame();
      this.guessTail.set('');
      this.lastServerNow = '';
      this.updateClock();
    } catch (error) {
      this.showError(error, 'Impossible de relancer la partie.');
    } finally {
      this.busy.set(false);
      this.focusGuessInput();
    }
  }

  protected formatTime(seconds: number): string {
    const minutes = Math.floor(seconds / 60);
    const remaining = seconds % 60;
    return `${minutes}:${remaining.toString().padStart(2, '0')}`;
  }

  protected getFeedbackLabel(status: string): string {
    if (status === 'correct') return 'Bonne position';
    if (status === 'present') return 'Présente ailleurs';
    return 'Absente';
  }

  protected getKeyboardLabel(letter: string): string {
    const status = this.keyboardFeedback().get(letter);
    return status ? `${letter} : ${this.getFeedbackLabel(status)}` : `${letter}, sans indication`;
  }

  protected formatWordCount(count: number): string {
    return formatMotusWordCount(count);
  }

  private focusGuessInput(): void {
    setTimeout(() => {
      const input = this.guessInput()?.nativeElement;
      if (input && !input.disabled) input.focus({ preventScroll: true });
    });
  }

  private async initialize(): Promise<void> {
    const code = this.route.snapshot.paramMap.get('code');
    const token = code ? this.roomService.readToken(code) : null;
    if (!code || !token) {
      this.error.set('Vous n’avez pas accès à cette salle.');
      this.loading.set(false);
      return;
    }
    this.roomCode = code;

    this.unsubscribeRoom = this.roomService.subscribeToRoomPicks(code, undefined, (status, gameType) => {
      if (status === 'lobby') void this.router.navigate(['/salon', code]);
      else if (status === 'playing' && gameType && gameType !== 'motus') {
        void this.router.navigate(['/salon', code]);
      }
    });

    try {
      await this.gameService.connect(code, token);
      const state = this.state();
      if (!state || state.roomCode !== code) throw new Error('La partie ne correspond pas à cette salle.');
      this.updateClock();
      this.startClock();
      this.loading.set(false);
      this.focusGuessInput();
    } catch (error) {
      this.showError(error, 'Impossible de rejoindre la partie.');
      this.loading.set(false);
    }
  }

  private startClock(): void {
    this.clock = setInterval(() => this.updateClock(), 1000);
  }

  private updateClock(): void {
    const state = this.state();
    if (!state) return;
    if (state.serverNow !== this.lastServerNow) {
      this.serverClockOffset = Date.parse(state.serverNow) - Date.now();
      this.lastServerNow = state.serverNow;
    }
    const remaining = Math.max(
      0,
      Math.ceil((Date.parse(state.deadline) - (Date.now() + this.serverClockOffset)) / 1000),
    );
    this.secondsRemaining.set(remaining);

    if (
      remaining === 0 &&
      state.phase !== 'finished' &&
      !this.expiryRefreshPending &&
      Date.now() - this.lastExpiryRefreshAt >= 3_000
    ) {
      this.expiryRefreshPending = true;
      this.lastExpiryRefreshAt = Date.now();
      void this.gameService.refresh()
        .catch((error: unknown) => this.showError(error, 'Impossible de charger les résultats.'))
        .finally(() => {
          this.expiryRefreshPending = false;
        });
    }
  }

  private showError(error: unknown, fallback: string): void {
    this.error.set(error instanceof Error ? error.message : fallback);
  }
}
