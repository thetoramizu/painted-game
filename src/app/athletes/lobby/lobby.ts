import { Component, DestroyRef, OnInit, computed, inject, signal } from '@angular/core';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { RoomService, RoomSnapshot } from '../services/room.service';
import { RaceService } from '../services/race.service';

const POLL_INTERVAL_MS = 2500;
const SEATS = [0, 1, 2, 3];

@Component({
  selector: 'app-lobby',
  imports: [RouterLink],
  templateUrl: './lobby.html',
  styleUrl: './lobby.css',
})
export class Lobby implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roomService = inject(RoomService);
  private readonly raceService = inject(RaceService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly room = signal<RoomSnapshot | null>(null);
  protected readonly accessError = signal<string | null>(null);
  protected readonly refreshError = signal<string | null>(null);
  protected readonly copied = signal(false);

  private readonly code = signal<string | null>(null);

  private timer?: number;

  protected readonly slots = computed(() => {
    const snapshot = this.room();
    const currentCode = this.code();
    return SEATS.map((seat) => ({
      seat,
      pseudo: snapshot?.players.find((player) => player.seat === seat)?.pseudo ?? null,
      isMe: snapshot?.mySeat === seat,
    }));
  });

  ngOnInit(): void {
    const code = this.route.snapshot.paramMap.get('code');
    if (!code) {
      this.accessError.set("Vous n'avez pas de place dans cette salle. Rejoignez-la depuis l'accueil.");
      return;
    }
    this.code.set(code);

    const pseudo = this.roomService.readPseudo(code);
    const token = this.roomService.readToken(code);
    if (!pseudo || !token) {
      this.accessError.set("Vous n'avez pas de place dans cette salle. Rejoignez-la depuis l'accueil.");
      return;
    }

    this.roomService.savePseudo(code, pseudo);
    this.refresh(code, pseudo);
    this.timer = setInterval(() => void this.refresh(code, pseudo), POLL_INTERVAL_MS);
    this.destroyRef.onDestroy(() => clearInterval(this.timer));
  }

  protected async copyCode(): Promise<void> {
    const code = this.code();
    if (code) {
      await navigator.clipboard.writeText(code);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    }
  }

  private async refresh(code: string, pseudo: string): Promise<void> {
    try {
      const snapshot = await this.roomService.getRoom(code, pseudo);
      this.room.set(snapshot); this.accessError.set(null); this.refreshError.set(null);
      if (snapshot.status === 'playing') {
        clearInterval(this.timer);
        void this.router.navigate(['/salon', code, 'jouer']);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Une erreur est survenue.';
      if (this.room()) {
        this.refreshError.set(message);
      } else {
        this.accessError.set(message);
      }
    }
  }

  protected async startGame(): Promise<void> {
    const code = this.code();
    const snapshot = this.room();
    const pseudo = this.roomService.readPseudo(code ?? '');
    if (!code || !pseudo || !snapshot) return;
    try {
      const result = await this.roomService.startRoom(code, pseudo);
      if (result.success) {
        // Préparer la course localement : joueurs triés, « nous » en premier.
        const players = [...snapshot.players]
          .sort((a, b) => (a.seat === snapshot.mySeat ? -1 : b.seat === snapshot.mySeat ? 1 : a.seat - b.seat));
        this.raceService.startSetup(code, players.map((player) => ({ seat: player.seat, pseudo: player.pseudo })), snapshot.mySeat);
        await this.router.navigate(['/salon', code, 'jouer']);
      } else {
        window.alert(result.message || 'Impossible de commencer la course.');
      }
    } catch {
      window.alert('Une erreur est survenue. Réessayez.');
    }
  }
}
