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
  protected readonly launching = signal(false);
  protected readonly restarting = signal(false);
  protected readonly returning = signal(false);
  protected readonly actionError = signal<string | null>(null);
  protected readonly lastRoll = signal<{ roll: number; useJog: boolean } | null>(null);

  private game?: Phaser.Game;
  private scene?: GameScene;
  private syncBoardEffect?: EffectRef;
  private destroyed = false;
  private turnAnimationTimeout: ReturnType<typeof setTimeout> | null = null;

  ngAfterViewInit(): void {
    const code = this.route.snapshot.paramMap.get('code') ?? '';
    this.roomCode.set(code);
    void this.initializeRace(code);

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
      this.syncBoardEffect?.destroy();
      this.cleanupPhaser();
    });
  }

  ngOnDestroy(): void {
    this.destroyed = true;
    if (this.turnAnimationTimeout) clearTimeout(this.turnAnimationTimeout);
    this.turnAnimationTimeout = null;
    this.raceService.unsubscribeFromRoomPicks();
    this.raceService.unsubscribeFromRace();
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

  protected async pick(id: AthleteId): Promise<void> {
    this.actionError.set(null);
    try {
      await this.raceService.selectAthlete(id);
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Impossible d’enregistrer ce choix.');
    }
  }

  protected async launch(): Promise<void> {
    if (this.launching()) return;
    this.launching.set(true);
    this.actionError.set(null);
    try {
      await this.raceService.launchRace();
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Impossible de lancer la course.');
    } finally {
      this.launching.set(false);
    }
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

  private async takeTurn(useJog: boolean): Promise<void> {
    if (this.rolling()) return;
    this.rolling.set(true);
    this.actionError.set(null);
    this.scene?.animateRoll(1);
    try {
      await new Promise<void>((resolve) => {
        this.turnAnimationTimeout = setTimeout(() => {
          this.turnAnimationTimeout = null;
          resolve();
        }, 500);
      });
      if (this.destroyed) return;
      const result = await this.raceService.playMyTurn(useJog);
      this.lastRoll.set(result);
      this.scene?.setDieFace(result.roll);
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Impossible de jouer ce tour.');
    } finally {
      this.rolling.set(false);
    }
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

  protected async restartRace(): Promise<void> {
    if (this.restarting()) return;
    this.restarting.set(true);
    this.actionError.set(null);
    try {
      await this.raceService.restartRace();
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Impossible de relancer la course.');
    } finally {
      this.restarting.set(false);
    }
  }

  protected async returnToLobby(): Promise<void> {
    if (this.returning()) return;
    const code = this.roomCode();
    const token = this.roomService.readToken(code);
    if (!code || !token) return;
    this.returning.set(true);
    this.actionError.set(null);
    try {
      await this.roomService.finishRoomGame(code, token);
      await this.router.navigate(['/salon', code]);
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Impossible de retourner au salon.');
    } finally {
      this.returning.set(false);
    }
  }

  protected async returnToLobbyAsPlayer(): Promise<void> {
    const code = this.roomCode();
    if (code) await this.router.navigate(['/salon', code]);
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

  private async initializeRace(code: string): Promise<void> {
    const token = this.roomService.readToken(code);
    if (!code || !token) {
      this.actionError.set('Votre session de salle est introuvable.');
      return;
    }
    try {
      const snapshot = await this.roomService.getRoom(code, token);
      if (snapshot.gameType !== 'athletes' || snapshot.status !== 'playing') {
        await this.router.navigate(['/salon', code]);
        return;
      }
      await this.raceService.startSetup(
        code,
        snapshot.players.map((player) => ({ seat: player.seat, pseudo: player.pseudo })),
        snapshot.mySeat,
      );
      this.raceService.subscribeToRoomPicks(code);
      await this.raceService.subscribeToRace(code);
      await this.raceService.loadRace(code, token);
    } catch (error) {
      this.actionError.set(error instanceof Error ? error.message : 'Impossible de charger la course.');
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
      this.scene?.shutdown();
      this.game.destroy(true);
      this.game = undefined;
      this.scene = undefined;
    }
  }
}
