import { Component, DestroyRef, OnInit, inject, signal, computed } from '@angular/core';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { RoomService } from '../services/room.service';
import { RaceService } from '../services/race.service';
import { AppBtn } from '../shared/components/btn.component';
import { AppAlert } from '../shared/components/alert.component';
import { AppMessageCard } from '../shared/components/message-card.component';

const SEATS = [0, 1, 2, 3];

@Component({
  selector: 'app-lobby',
  imports: [AppBtn, AppAlert, AppMessageCard],
  templateUrl: './lobby.html',
  styleUrl: './lobby.css',
})
export class Lobby implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly roomService = inject(RoomService);
  private readonly raceService = inject(RaceService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly room = this.roomService.snapshot;
  protected readonly accessError = signal<string | null>(null);
  protected readonly refreshError = signal<string | null>(null);
  protected readonly startError = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly isStarting = signal(false);

  protected readonly slots = computed(() => {
    const snapshot = this.room();

    return SEATS.map(seat => {
      const player = snapshot?.players.find((p) => p.seat === seat);

      return {
        seat,
        pseudo: player?.pseudo ?? null,
        athleteId: player?.athleteId ?? null,
        isMe: snapshot?.mySeat === seat,
      };
    });
  });

  private readonly code = signal<string | null>(null);

  ngOnInit(): void {
    this.initializeLobby();
  }

  private async initializeLobby(): Promise<void> {
    const code = this.route.snapshot.paramMap.get('code');
    if (!code) {
      this.accessError.set("Vous n'avez pas de place dans cette salle. Rejoignez-la depuis l'accueil.");
      return;
    }
    this.code.set(code);

    const pseudo = this.roomService.readPseudo(code);
    if (!pseudo) {
      this.accessError.set("Vous n'avez pas de place dans cette salle. Rejoignez-la depuis l'accueil.");
      return;
    }

        // On s'abonne aux changements (le service gère maintenant la mise à jour du signal interne)
    const unsubscribe = this.roomService.subscribeToRoomPicks(
      code,
      undefined,
      (status) => {
        if (status === 'playing') {
          this.router.navigate(['/salon', code, 'jouer']);
        }
      }
    );
    this.destroyRef.onDestroy(unsubscribe);

    try {
      await this.roomService.getRoom(code, pseudo);
    } catch (e) {
      this.accessError.set("Impossible de charger la salle.");
    }
  }

  protected async copyCode(): Promise<void> {
    const code = this.code();
    if (code) {
      try {
        await navigator.clipboard.writeText(code);
        this.copied.set(true);
        setTimeout(() => this.copied.set(false), 2000);
      } catch {
        this.refreshError.set('Impossible de copier le code.');
      }
    }
  }

  protected async startGame(): Promise<void> {
    const code = this.code();
    const snapshot = this.room();
    const pseudo = this.roomService.readPseudo(code ?? '');
    if (!code || !pseudo || !snapshot) return;
    if (this.isStarting()) return;

    this.isStarting.set(true);

    try {
      const result = await this.roomService.startRoom(code, pseudo);
      if (result.success) {
        const players = [...snapshot.players]
          .sort((a, b) => {
            if (a.seat === snapshot.mySeat) return -1;
            if (b.seat === snapshot.mySeat) return 1;

            return a.seat - b.seat;
          });
        await this.raceService.startSetup(code, players.map((player) => ({ seat: player.seat, pseudo: player.pseudo })), snapshot.mySeat);
        await this.router.navigate(['/salon', code, 'jouer']);
      } else {
        this.startError.set(result.message || 'Impossible de commencer la course.');
      }
    } catch (error) {
      console.error(error);
      this.startError.set('Une erreur est survenue.');
    } finally {
      this.isStarting.set(false);
    }
  }

  protected async goHome(): Promise<void> {
    await this.router.navigate(['/']);
  }
}
