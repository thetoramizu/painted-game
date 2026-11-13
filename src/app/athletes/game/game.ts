import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  EffectRef,
  Injector,
  OnDestroy,
  effect,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import Phaser from 'phaser';
import { GAME_SCENE_KEY, GameScene, PLAYER_COLORS, type TrackRacer } from './phaser-game';
import { RaceService } from '../services/race.service';
import { RoomService } from '../services/room.service';
import type { AthleteId } from '../models/athletes';
import type { Racer } from '../models/race-engine';

@Component({
  selector: 'app-game',
  templateUrl: './game.html',
  styleUrl: './game.css',
  imports: [RouterLink],
})
export class Game implements AfterViewInit, OnDestroy {
  protected readonly raceService = inject(RaceService);
  private readonly roomService = inject(RoomService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly elementRef = inject(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly roomCode = signal('');
  protected readonly rolling = signal(false);
  protected readonly lastRoll = signal<{ roll: number; useJog: boolean } | null>(null);

  private game?: Phaser.Game;
  private scene?: GameScene;
  private syncBoardEffect?: EffectRef;
  private raceEffect?: EffectRef;
  private roomPickSubscription?: (() => void)[];

  ngAfterViewInit(): void {
    const code = this.route.snapshot.paramMap.get('code') ?? '';
    this.roomCode.set(code);

    // Si on arrive directement sur /jouer sans passer par le lobby,
    // recharger les joueurs et le siège du joueur courant depuis la salle.
    if (!this.raceService.setup()) {
      const cached = this.readCachedSnapshot(code);
      if (cached && cached.players.length >= 2) {
        this.raceService.startSetup(code, cached.players, cached.mySeat);
      } else {
        // Cache invalide ou absent : recharger la salle depuis Supabase.
        const pseudo = this.roomService.readPseudo(code);
        if (!pseudo) return; // ou throw
        this.roomService.getRoom(code, pseudo).then((snapshot) => {
          if (snapshot.players.length >= 2) {
            this.raceService.startSetup(code, snapshot.players, snapshot.mySeat);
          }
        }).catch(() => {
          // Si la récupération échoue, l'utilisateur verra le message d'erreur.
        });
      }
    }

    // Écouter les choix des autres joueurs en temps réel
    this.raceService.subscribeToRoomPicks(code);

    // Surveiller l'apparition d'une course pour créer le canvas Phaser,
    // et le détruire si la course s'arrête.
    // Maintenant, on lance manuellement la vérification après que ngAfterViewInit soit complet
    effect(() => {
      // Attendre que setup() soit défini (c'est-à-dire que startSetup a fini)
      if (!this.raceService.setup()) {
        return; // Ne rien faire tant que la partie n'est pas en setup
      }
      const race = this.raceService.race();
      if (race && !this.game) {
        this.initPhaser();
      } else if (!race && this.game) {
        this.cleanupPhaser();
      }
    }, { injector: this.injector });

    // Vérifier si on doit être redirigé vers l'écran choix (quand l'hôte démarre la partie)
    // Cela aide les joueurs qui sont restés sur le lobby à être redirigés vers le jeu
    effect(() => {
      // Attendre que setup() soit défini
      console.log('[game] effect déclenché, setup défini ?', !!this.raceService.setup());
      if (!this.raceService.setup()) return;

      const setup = this.raceService.setup();
      console.log('[game] setup trouvé, players.length:', setup?.players?.length);
      if (!setup || setup.players.length < 2) return;

      // Si on est toujours sur une route sans '/jouer' et que la partie a commencé,
      // rediriger vers l'écran choix d'athlète
      // Cela concerne les joueurs sur /salon/:code (lobby) alors que l'hôte est sur /salon/:code/jouer
      const currentUrl = this.router.url;
      console.log(`[game] Vérification redirection - URL actuelle: "${currentUrl}"`);
      console.log('[game] currentUrl includes /jouer ?', currentUrl.includes('/jouer'));
      if (!currentUrl.includes('/jouer')) {
        console.log(`[game] Redirection vers jeu : ${setup.players.length} joueurs, siège: ${this.raceService.mySeat()}`);
        // Navigation versatile - essayer plusieurs patterns de route
        const code = this.route.snapshot.paramMap.get('code') ?? '';
        console.log('[game] code de salle:', code);
        this.router.navigate(['/salon', code, 'jouer']).then(() => {
          console.log('[game] Redirection réussie');
        }).catch((e) => {
          console.error('[game] Erreur redirection', e);
        });
      }
    }, { injector: this.injector });

    // Synchroniser le canvas dès que la course est en cours.
    this.syncBoardEffect = effect(
      () => {
        const race = this.raceService.race();
        if (race && this.scene) {
          this.syncBoard();
        }
      },
      { injector: this.injector }  // ⚠️ nécessaire car ngAfterViewInit n'est pas un contexte d'injection
    );

    this.destroyRef.onDestroy(() => {
      this.raceEffect?.destroy();
      this.syncBoardEffect?.destroy();
      this.roomPickSubscription?.forEach((unsub) => unsub());
      this.cleanupPhaser();
    });
  }

  ngOnDestroy(): void {
    this.raceService.unsubscribeFromRoomPicks();
    this.game?.destroy(true);
    this.game = undefined;
    this.scene = undefined;
  }

  protected mySeat(): number {
    return this.raceService.mySeat();
  }

  protected myAthleteId(): AthleteId | null {
    return this.raceService.pickFor(this.raceService.mySeat());
  }

  protected pick(id: AthleteId): void {
    this.raceService.selectAthlete(id);
  }

  protected launch(): void {
    this.raceService.launchRace();
  }

  protected isMyTurn(): boolean {
    return this.raceService.myTurn();
  }

  protected async rollDice(): Promise<void> {
    await this.takeTurn(false);
  }

  protected async useJog(): Promise<void> {
    await this.takeTurn(true);
  }

  private takeTurn(useJog: boolean): Promise<void> {
    if (this.rolling()) return Promise.resolve();
    return new Promise((resolve) => {
      this.rolling.set(true);

      // Démarrer l'animation du dé immédiatement (faces qui tournent)
      this.scene?.animateRoll(1);

      setTimeout(() => {
        const result = this.raceService.playMyTurn(useJog);
        if (result) {
          this.lastRoll.set(result);
          // Retomber sur le résultat du dé une fois le tirage effectué
          this.scene?.setDieFace(result.roll);
        }
        this.rolling.set(false);
        // Faire jouer automatiquement les tours des autres joueurs (P1 local).
        this.scheduleBotTurns();
        resolve();
      }, 500);
    });
  }

  private scheduleBotTurns(): void {
    const race = this.raceService.race();
    if (!race || race.phase !== 'playing') return;
    if (race.turnSeat === this.raceService.mySeat()) return;
    setTimeout(() => {
      let current = this.raceService.race();
      while (current && current.phase === 'playing' && current.turnSeat !== this.raceService.mySeat()) {
        const seat = current.turnSeat;
        const result = this.raceService.playTurnWithRoll(seat);
        if (!result) break;
        this.lastRoll.set({ ...result });
        current = this.raceService.race();
      }
    }, 900);
  }

  protected lastRollLabel(): string | null {
    const last = this.lastRoll();
    if (!last) return null;
    return last.useJog ? 'Pouvoir : +5 cases' : `Dé : ${last.roll}`;
  }

  protected statusMessage(): string {
    const race = this.raceService.race();
    if (!race) return 'Préparez-vous…';
    if (race.phase === 'finished') {
      const winner = race.racers.find((racer) => racer.finishRank === 1);
      return winner ? `${winner.pseudo} remporte la course !` : 'Course terminée.';
    }
    const current = race.racers.find((racer) => racer.seat === race.turnSeat);
    return current ? `Au tour de ${current.pseudo}.` : 'En attente du prochain joueur.';
  }

  protected rankedRacers(): Racer[] {
    const racers = this.raceService.race()?.racers ?? [];
    return [...racers].sort((a, b) => b.position - a.position || a.seat - b.seat);
  }

  protected raceEvents(): string[] {
    return this.raceService.race()?.events.slice(-8).reverse() ?? [];
  }

  protected colorHex(seat: number): string {
    const color = PLAYER_COLORS[seat % PLAYER_COLORS.length];
    return '#' + color.toString(16).padStart(6, '0');
  }

  protected ordinal(rank: number): string {
    return rank === 1 ? '1er' : `${rank}e`;
  }

  protected backHome(): void {
    this.raceService.clear();
  }

  private syncBoard(): void {
    const race = this.raceService.race();
    if (!race || !this.scene) return;
    const trackRacers: TrackRacer[] = race.racers.map((racer) => ({
      seat: racer.seat,
      pseudo: racer.pseudo,
      position: racer.position,
      finished: racer.finishRank !== null,
    }));
    const turnSeat = race.phase === 'playing' ? race.turnSeat : null;
    this.scene.syncRacers(trackRacers, turnSeat, this.statusMessage());
  }

  private readCachedSnapshot(code: string): { players: { seat: number; pseudo: string }[]; mySeat: number } | null {
    try {
      const raw = localStorage.getItem(`athletes-room-snapshot:${code}`);
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { players?: unknown }).players)) {
        const snapshot = parsed as { players: { seat: number; pseudo: string }[]; mySeat: number };
        return { players: snapshot.players, mySeat: snapshot.mySeat };
      }
      return null;
    } catch {
      return null;
    }
  }

  private initPhaser(): void {
    this.game = new Phaser.Game({
      type: Phaser.CANVAS,
      width: 800,
      height: 480,
      parent: this.elementRef.nativeElement.querySelector('.game-container') ?? this.elementRef.nativeElement,
      scene: [GameScene],
      backgroundColor: '#fff7e8',
      scale: { mode: Phaser.Scale.FIT, autoCenter: Phaser.Scale.CENTER_BOTH },
    });

    this.game.events.once('ready', () => {
      this.scene = this.game?.scene.getScene(GAME_SCENE_KEY) as GameScene | undefined;
      this.syncBoard();
    });
  }

  private cleanupPhaser(): void {
    if (this.game) {
      this.game.destroy(true);
      this.game = undefined;
      this.scene = undefined;
    }
  }
}
