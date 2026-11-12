import { computed, Injectable, signal } from '@angular/core';
import { ATHLETES, type Athlete, type AthleteId } from '../models/athletes';
import { createRace, playTurn, racerPoints, TRACK_LENGTH, type RaceState } from '../models/race-engine';

export interface RacePlayer {
  seat: number;
  pseudo: string;
}

export interface DiceResult {
  roll: number;
  useJog: boolean;
}

export interface RaceSetupState {
  code: string;
  players: RacePlayer[];
  picks: Record<number, AthleteId | null>;
  phase: 'setup' | 'race';
}

const PICKS_KEY_PREFIX = 'athletes-race-picks:';

/**
 * Orchestration locale de la course : choix des athlètes puis déroulement
 * des tours via le moteur pur (models/race-engine). La synchronisation
 * multijoueur (Supabase) se branchera ici plus tard.
 */
@Injectable({ providedIn: 'root' })
export class RaceService {
  readonly athletes: readonly Athlete[] = ATHLETES;

  private readonly setupSignal = signal<RaceSetupState | null>(null);
  private readonly raceSignal = signal<RaceState | null>(null);

  readonly setup = this.setupSignal.asReadonly();
  readonly race = this.raceSignal.asReadonly();

  /** Le premier joueur de la liste est toujours « nous » (pseudo du lobby). */
  readonly mySeat = computed(() => this.setupSignal()?.players[0]?.seat ?? 0);

  readonly myTurn = computed(() => {
    const race = this.raceSignal();
    if (!race || race.phase !== 'playing') return false;
    if (!this.isLocalHost()) return true; // en multijoueur réel, chacun joue son tour
    return race.turnSeat === this.mySeat();
  });

  private isLocalHost(): boolean {
    const setup = this.setupSignal();
    if (!setup) return false;
    const storedPseudo = localStorage.getItem('athletes-room-token:' + setup.code + ':pseudo');
    return !storedPseudo || storedPseudo === setup.players[0].pseudo;
  }

  /** Démarre la préparation de course depuis le lobby (premier joueur = nous). */
  startSetup(code: string, players: RacePlayer[]): void {
    const sorted = [...players].sort((a, b) => a.seat - b.seat);
    const stored = this.readStoredPicks(code);
    const picks: Record<number, AthleteId | null> = {};
    for (const player of sorted) {
      const value = stored[String(player.seat)];
      picks[player.seat] = this.isKnownAthlete(value) ? value : null;
    }
    this.raceSignal.set(null);
    this.setupSignal.set({ code, players: sorted, picks, phase: 'setup' });
  }

  clear(): void {
    this.setupSignal.set(null);
    this.raceSignal.set(null);
  }

  pickFor(seat: number): AthleteId | null {
    return this.setupSignal()?.picks[seat] ?? null;
  }

  athleteOf(id: AthleteId | null | undefined): Athlete | undefined {
    return id ? this.athletes.find((athlete) => athlete.id === id) : undefined;
  }

  selectAthlete(athleteId: AthleteId): void {
    const setup = this.setupSignal();
    if (!setup || setup.phase !== 'setup') return;
    if (!this.isKnownAthlete(athleteId)) return;
    const picks = { ...setup.picks, [setup.players[0].seat]: athleteId };
    this.setupSignal.set({ ...setup, picks });
    localStorage.setItem(PICKS_KEY_PREFIX + setup.code, JSON.stringify(picks));
  }

  allPicked(): boolean {
    const setup = this.setupSignal();
    if (!setup) return false;
    return setup.players.every((player) => this.isKnownAthlete(setup.picks[player.seat]));
  }

  /** Lance la vraie course avec le moteur de règles. */
  launchRace(): boolean {
    const setup = this.setupSignal();
    if (!setup || setup.phase !== 'setup' || !this.allPicked()) return false;
    const racers = setup.players.map((player) => ({
      seat: player.seat,
      pseudo: player.pseudo,
      athlete: setup.picks[player.seat] as AthleteId,
    }));
    this.raceSignal.set(createRace(racers));
    this.setupSignal.set({ ...setup, phase: 'race' });
    return true;
  }

  /** Joue le tour du meneur (nous) : dé aléatoire ou pouvoir « Jog » du Génie. */
  playMyTurn(useJog = false): DiceResult | null {
    const race = this.raceSignal();
    if (!race || race.phase !== 'playing') return null;
    if (this.isLocalHost() && race.turnSeat !== this.mySeat()) return null;

    const mover = race.racers.find((racer) => racer.seat === race.turnSeat);
    if (!mover) return null;
    if (useJog && mover.athlete !== 'genie') return null;

    const roll = 1 + Math.floor(Math.random() * 6);
    try {
      this.raceSignal.set(playTurn(race, { seat: race.turnSeat, roll, useJog }));
    } catch {
      return null;
    }
    return { roll, useJog };
  }

  /** Joue un tour avec un dé aléatoire, quel que soit le joueur (bots locaux). */
  playTurnWithRoll(seat: number): DiceResult | null {
    const race = this.raceSignal();
    if (!race || race.phase !== 'playing' || race.turnSeat !== seat) return null;
    const roll = 1 + Math.floor(Math.random() * 6);
    try {
      this.raceSignal.set(playTurn(race, { seat, roll, useJog: false }));
    } catch {
      return null;
    }
    return { roll, useJog: false };
  }

  pointsOf = racerPoints;
  readonly trackLength = TRACK_LENGTH;

  private isKnownAthlete(value: unknown): value is AthleteId {
    return typeof value === 'string' && ATHLETES.some((athlete) => athlete.id === value);
  }

  private readStoredPicks(code: string): Record<string, unknown> {
    try {
      const raw = localStorage.getItem(PICKS_KEY_PREFIX + code);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
}
