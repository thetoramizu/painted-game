import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { Router, RouterLink, ActivatedRoute } from '@angular/router';
import { RoomService, RoomSnapshot } from '../services/room.service';
import { RaceService } from '../services/race.service';

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

  private roomPickSubscription: (() => void) | null = null;

  private readonly roomPickCallback: (seat: number, pseudo: string | null, athleteId: string | null) => void = (
    seat: number,
    pseudo: string | null,
    athleteId: string | null
  ) => {
    this.updateSeatAthlete(seat, pseudo, athleteId);
    this.updateRoomPlayers(seat, pseudo, athleteId);
  };

  protected readonly room = signal<RoomSnapshot | null>(null);
  protected readonly accessError = signal<string | null>(null);
  protected readonly refreshError = signal<string | null>(null);
  protected readonly copied = signal(false);

  private readonly code = signal<string | null>(null);

  protected readonly slots = signal<{
    seat: number;
    pseudo: string | null;
    athleteId: string | null;
    isMe: boolean;
  }[]>([]);

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
    // D'abord s'abonner aux changements en temps réel, THEN rafraîchir
    // pour s'assurer de ne manquer aucun joueur qui aurait rejoint entre les deux opérations.
    this.roomPickSubscription = this.roomService.subscribeToRoomPicks(
      code,
      this.roomPickCallback
    );

    // Maintenant rafraîchir le snapshot ; l'événement INSERT pour le créateur lui-même
    // aura déjà été reçu via le channel, et refresh() chargera l'état actuel complet.
    this.refresh(code, pseudo)
      .then(() => {
        const snapshot = this.room();
        if (snapshot && snapshot.players) {
          this.slots.set(SEATS.map((seat) => ({
            seat,
            pseudo: snapshot.players.find((player) => player.seat === seat)?.pseudo ?? null,
            athleteId: snapshot.players.find((player) => player.seat === seat)?.athleteId ?? null,
            isMe: snapshot.mySeat === seat,
          })));
        }
      });

    this.destroyRef.onDestroy(() => {
      if (this.roomPickSubscription) {
        this.roomPickSubscription();
      }
      this.roomPickSubscription = null;
    });
  }

  protected async copyCode(): Promise<void> {
    const code = this.code();
    if (code) {
      await navigator.clipboard.writeText(code);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 2000);
    }
  }

  private updateSeatAthlete(seat: number, pseudo: string | null, athleteId: string | null): void {
    console.log(`[lobby] updateSeatAthlete called: seat=${seat}, pseudo=${pseudo}, athleteId=${athleteId}, slotsBefore=${JSON.stringify(this.slots())}`);
    this.slots.update(current => {
      const index = current.findIndex(s => s.seat === seat);
      console.log(`[lobby] slots findIndex result: ${index}, current before: ${JSON.stringify(current)}`);
      if (index >= 0) {
        // Retourne un nouveau tableau avec un nouvel objet à l'index : cela force la notification du signal
        return [
          ...current.slice(0, index),
          { ...current[index], pseudo, athleteId },
          ...current.slice(index + 1),
        ];
      } else {
        // Nouvel ajout : création d'un nouveau tableau avec le nouvel objet
        return [...current, { seat, pseudo, athleteId, isMe: false }];
      }
    });
    console.log(`[lobby] slotsAfter=${JSON.stringify(this.slots())}`);
  }

  /**
   * Met à jour le signal room avec le nouveau joueur ou le choix modifié.
   * Assure que le bouton "Commencer" et le texte de statut se rafraîchissent.
   */
  private updateRoomPlayers(seat: number, pseudo: string | null, athleteId: string | null): void {
    this.room.update(current => {
      if (!current) return current;

      const playerIndex = current.players.findIndex(p => p.seat === seat);
      if (playerIndex >= 0) {
        // Mise à jour d'un joueur existant à ce siège
        return {
          ...current,
          players: [
            ...current.players.slice(0, playerIndex),
            {
              ...current.players[playerIndex],
              pseudo: pseudo ?? current.players[playerIndex].pseudo,
              athleteId: athleteId ?? current.players[playerIndex].athleteId,
            },
            ...current.players.slice(playerIndex + 1),
          ],
        };
      } else {
        // Ajout d'un nouveau joueur
        return {
          ...current,
          players: [
            ...current.players,
            { pseudo: pseudo ?? '', seat, athleteId: athleteId ?? null },
          ],
        };
      }
    });
  }

  private async refresh(code: string, pseudo: string): Promise<void> {
    try {
      const snapshot = await this.roomService.getRoom(code, pseudo);
      this.room.set(snapshot);
      this.accessError.set(null);
      this.refreshError.set(null);
      if (snapshot.status === 'playing') {
        // La course a commencé, le Realtime gère les mises à jour
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
        const players = [...snapshot.players]
          .sort((a, b) => (a.seat === snapshot.mySeat ? -1 : b.seat === snapshot.mySeat ? 1 : a.seat - b.seat));
        await this.raceService.startSetup(code, players.map((player) => ({ seat: player.seat, pseudo: player.pseudo })), snapshot.mySeat);
        await this.router.navigate(['/salon', code, 'jouer']);
      } else {
        window.alert(result.message || 'Impossible de commencer la course.');
      }
    } catch {
      window.alert('Une erreur est survenue. Réessayez.');
    }
  }

  protected async goHome(): Promise<void> {
  await this.router.navigate(['/']);
}

}