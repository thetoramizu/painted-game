import {
  AfterViewInit,
  Component,
  DestroyRef,
  ElementRef,
  OnDestroy,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import Phaser from 'phaser';
import { GAME_SCENE_KEY, GameScene, PLAYER_COLORS, type TrackRacer } from './phaser-game';
import { RaceService } from '../services/race.service';
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
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly elementRef = inject(ElementRef);

  protected readonly roomCode = signal('');
  protected readonly rolling = signal(false);
  protected readonly lastRoll = signal<{ roll: number; useJog: boolean } | null>(null);

  private game?: Phaser.Game;
  private scene?: GameScene;

  ngAfterViewInit(): void {
    const code = this.route.snapshot.paramMap.get('code') ?? '';
    this.roomCode.set(code);

    // Si on arrive directement sur /jouer sans passer par le lobby,
    // recharger les joueurs depuis le cache de la salle.
    if (!this.raceService.setup()) {
      const players = this.readCachedPlayers(code);
      if (players.length >= 2) {
        this.raceService.startSetup(code, players);
      }
    }

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

    const stop = this.raceService.race.subscribe(() => this.syncBoard());
    this.destroyRef.onDestroy(stop);
  }

  ngOnDestroy(): void {
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
      setTimeout(() => {
        const result = this.raceService.playMyTurn(useJog);
        if (result) this.lastRoll.set(result);
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

  private readCachedPlayers(code: string): { seat: number; pseudo: string }[] {
    try {
      const raw = localStorage.getItem(`athletes-room-snapshot:${code}`);
      if (!raw) return [];
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { players?: unknown }).players)) {
        const players = (parsed as { players: { seat: number; pseudo: string }[] }).players;
        return players.filter((player) => Number.isInteger(player.seat) && typeof player.pseudo === 'string');
      }
      return [];
    } catch {
      return [];
    }
  }
}
