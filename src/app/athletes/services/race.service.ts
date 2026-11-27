import { computed, Injectable, signal } from '@angular/core';
import { ATHLETES, type Athlete, type AthleteId } from '../models/athletes';
import { createRace, playTurn, racerPoints, TRACK_LENGTH, type RaceState } from '../models/race-engine';
import { RoomService } from './room.service';

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

  private readonly currentSeat = signal<number>(0);

  /** Le siège du joueur local (le créateur ou l'utilisateur connecté). */
  readonly mySeat = computed(() => this.currentSeat());

  readonly myTurn = computed(() => {
    const race = this.raceSignal();
    if (!race || race.phase !== 'playing') return false;
    if (!this.isLocalHost()) return true; // en multijoueur réel, chacun joue son tour
    return race.turnSeat === this.mySeat();
  });

  constructor(private readonly roomService: RoomService) {}

  private isLocalHost(): boolean {
    const setup = this.setupSignal();
    if (!setup) return false;
    const storedPseudo = localStorage.getItem('athletes-room-token:' + setup.code + ':pseudo');
    return !storedPseudo || storedPseudo === setup.players[0].pseudo;
  }

  /** Démarre la préparation de course depuis le lobby. */
  async startSetup(code: string, players: RacePlayer[], currentSeat: number = 0): Promise<void> {
    const sorted = [...players].sort((a, b) => a.seat - b.seat);
    const picks = await this.fetchPicks(code);
    // Validation : picks doit contenir des entrées (même si object, pas tableau)
    // L'ancien check Array.isArray était incorrect pour un Record type
    if (Object.keys(picks).length === 0) {
      console.error('startSetup: fetchPicks n\'a retourné aucun pick', picks);
      // Initialiser avec des picks par défaut (personne choisi)
      this.setupSignal.set({ code, players: sorted, picks: {}, phase: 'setup' });
      this.currentSeat.set(currentSeat);
      return;
    }
    this.setupSignal.set({ code, players: sorted, picks, phase: 'setup' });
    this.currentSeat.set(currentSeat);
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

  /** Enregistrer le choix d'un athlète pour le joueur local et le diffuser à la salle. */
  selectAthlete(athleteId: AthleteId): void {
    const setup = this.setupSignal();
    if (!setup || setup.phase !== 'setup') return;
    if (!this.isKnownAthlete(athleteId)) return;
    const picks = { ...setup.picks, [this.currentSeat()]: athleteId };
    // Enregistrer dans la base Supabase (fiable aussi si on bascule sur un autre onglet)
    // On passe le siège au lieu du pseudo pour être robuste aux doublons de pseudo
    this.roomService.updatePick(setup.code, this.currentSeat(), athleteId).catch(() => {
      // En cas d'erreur, on continue avec le pick local
    });
    this.setupSignal.set({ ...setup, picks });
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

  private roomPickSubscription?: (() => void)[];

  /**
   * Écouter les choix des autres joueurs en temps réel pour la salle.
   * Quand un autre joueur choisit son athlète, le state local se met à jour.
   */
  subscribeToRoomPicks(code: string): void {
    this.unsubscribeFromRoomPicks();

    const callbacks = [
      (seat: number, athleteId: string | null) => this.mergePickFromDb(seat, athleteId),
    ];

    this.roomPickSubscription = callbacks.map((cb) => {
      return this.roomService.subscribeToRoomPicks(code, cb);
    });
  }

  public unsubscribeFromRoomPicks(): void {
    if (this.roomPickSubscription) {
      this.roomPickSubscription.forEach((unsub) => unsub());
      this.roomPickSubscription = undefined;
    }
  }

  private mergePickFromDb(seat: number, athleteId: string | null): void {
    const setup = this.setupSignal();
    if (!setup) return;

    const isKnown = this.isKnownAthlete(athleteId);
    const newPicks = { ...setup.picks, [seat]: isKnown ? athleteId : null };
    this.setupSignal.set({ ...setup, picks: newPicks });
  }

  private getMyPseudo(code: string, players: RacePlayer[]): string {
    const storedPseudo = localStorage.getItem('athletes-room-token:' + code + ':pseudo');
    if (storedPseudo) return storedPseudo;
    const me = players.find((player) => player.seat === this.currentSeat());
    return me?.pseudo ?? '';
  }

  private isKnownAthlete(value: unknown): value is AthleteId {
    return typeof value === 'string' && ATHLETES.some((athlete) => athlete.id === value);
  }

  /**
   * Récupérer les choix d'athlètes déjà enregistrés en base pour la salle.
   * Utilisé au chargement de la salle pour retrouver les choix des autres joueurs.
   */
  private fetchPicks(code: string): Promise<Record<number, AthleteId | null>> {
    return this.roomService.getPicks(code).then((rows) => {
      // Gérer le cas où rows est null, undefined ou un objet non-tableau
      let rowsArray: { seat: number; athlete_id: string }[] = [];
      if (Array.isArray(rows)) {
        rowsArray = rows;
      } else if (rows && typeof rows === 'object') {
        // Si c'est un objet comme {0: null, 1: null}, convertir les valeurs en tableau
        console.warn('fetchPicks: rows est un objet, conversion en tableau', rows);
        // Casters en any pour contourner le typage strict d'Object.values sur unknown
        rowsArray = Object.values(rows as any).filter((v: any) => v !== null && v !== undefined && typeof v === 'object') as { seat: number; athlete_id: string }[];
      }

      // Sécurité : rowsArray doit être un tableau valide
      if (!Array.isArray(rowsArray) || rowsArray.length === 0) {
        console.warn('fetchPicks: pas de données valides, retour de picks vides', rows);
        const picks: Record<number, AthleteId | null> = {};
        return picks;
      }

      const picks: Record<number, AthleteId | null> = {};
      for (const row of rowsArray) {
        const seat = row.seat;
        picks[seat] = this.isKnownAthlete(row.athlete_id) ? row.athlete_id : null;
      }
      return picks;
    });
  }
}
