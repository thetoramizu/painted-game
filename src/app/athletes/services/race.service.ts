import { computed, inject, Injectable, signal } from '@angular/core';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { ATHLETES, type Athlete, type AthleteId } from '../models/athletes';
import { racerPoints, TRACK_LENGTH, type RaceState } from '../models/race-engine';
import { SupabaseService } from '../core/supabase-client';
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
 * Orchestration de la course : les choix et les tours sont validés par Supabase.
 */
@Injectable({ providedIn: 'root' })
export class RaceService {
  readonly athletes: readonly Athlete[] = ATHLETES;
  private readonly supabase = inject(SupabaseService).client;

  private readonly setupSignal = signal<RaceSetupState | null>(null);
  private readonly raceSignal = signal<RaceState | null>(null);

  readonly setup = this.setupSignal.asReadonly();
  readonly race = this.raceSignal.asReadonly();

  private readonly currentSeat = signal<number>(0);

  /** Le siège du joueur local (le créateur ou l'utilisateur connecté). */
  readonly mySeat = computed(() => this.currentSeat());

  readonly myTurn = computed(() => {
    const race = this.raceSignal();
    return race?.phase === 'playing' && race.turnSeat === this.mySeat();
  });

  constructor(private readonly roomService: RoomService) {}

  /** Démarre la préparation de course depuis le lobby. */
  async startSetup(code: string, players: RacePlayer[], currentSeat: number = 0): Promise<void> {
    const sorted = [...players].sort((a, b) => a.seat - b.seat);
    const picks = await this.fetchPicks(code);
    this.setupSignal.set({ code, players: sorted, picks, phase: 'setup' });
    this.raceSignal.set(null);
    this.currentSeat.set(currentSeat);
  }

  clear(): void {
    this.unsubscribeFromRoomPicks();
    this.unsubscribeFromRace();
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
  async selectAthlete(athleteId: AthleteId): Promise<void> {
    const setup = this.setupSignal();
    if (!setup || setup.phase !== 'setup') return;
    if (!this.isKnownAthlete(athleteId)) return;
    const token = this.roomService.readToken(setup.code);
    if (!token) throw new Error('Votre session de salle est introuvable.');
    await this.roomService.updatePick(setup.code, token, this.currentSeat(), athleteId);
    const picks = { ...setup.picks, [this.currentSeat()]: athleteId };
    this.setupSignal.set({ ...setup, picks });
  }

  allPicked(): boolean {
    const setup = this.setupSignal();
    if (!setup) return false;
    return setup.players.every((player) => this.isKnownAthlete(setup.picks[player.seat]));
  }

  /** Lance la vraie course avec le moteur de règles. */
  async launchRace(): Promise<boolean> {
    const setup = this.setupSignal();
    if (
      !setup ||
      setup.phase !== 'setup' ||
      this.currentSeat() !== 0 ||
      !this.allPicked()
    ) return false;
    const token = this.roomService.readToken(setup.code);
    if (!token) throw new Error('Votre session de salle est introuvable.');
    const { data, error } = await this.supabase.rpc('start_athlete_race', {
      p_code: setup.code,
      p_token: token,
    });
    if (error) throw new Error(error.message || 'Impossible de lancer la course.');
    const race = parseRaceState(data);
    if (!race) throw new Error('Le serveur a retourné un état de course invalide.');
    this.setRaceState(race);
    return true;
  }

  async restartRace(): Promise<void> {
    const setup = this.setupSignal();
    if (!setup || this.currentSeat() !== 0) throw new Error('Seul le chef de salle peut relancer la course.');
    const token = this.roomService.readToken(setup.code);
    if (!token) throw new Error('Votre session de salle est introuvable.');
    const { data, error } = await this.supabase.rpc('restart_athlete_race', {
      p_code: setup.code,
      p_token: token,
    });
    if (error) throw new Error(error.message || 'Impossible de relancer la course.');
    if (!isRecord(data) || data['success'] !== true) {
      throw new Error(typeof data?.['message'] === 'string' ? data['message'] : 'Impossible de relancer la course.');
    }
    const race = parseRaceState(data['state']);
    if (!race) throw new Error('Le serveur a retourné un état de course invalide.');
    this.setRaceState(race);
  }

  /** Demande au serveur de valider et jouer le tour du siège courant. */
  async playMyTurn(useJog = false): Promise<DiceResult> {
    const setup = this.setupSignal();
    const race = this.raceSignal();
    if (!setup || !race || race.phase !== 'playing' || race.turnSeat !== this.currentSeat()) {
      throw new Error("Ce n'est pas votre tour.");
    }
    const token = this.roomService.readToken(setup.code);
    if (!token) throw new Error('Votre session de salle est introuvable.');
    const { data, error } = await this.supabase.rpc('play_athlete_turn', {
      p_code: setup.code,
      p_token: token,
      p_use_jog: useJog,
    });
    if (error) throw new Error(error.message || 'Impossible de jouer ce tour.');
    if (!isRecord(data) || typeof data['roll'] !== 'number' || typeof data['useJog'] !== 'boolean') {
      throw new Error('Le serveur a retourné un résultat de tour invalide.');
    }
    const nextRace = parseRaceState(data['state']);
    if (!nextRace) throw new Error('Le serveur a retourné un état de course invalide.');
    this.setRaceState(nextRace);
    return { roll: data['roll'], useJog: data['useJog'] };
  }

  pointsOf = racerPoints;
  readonly trackLength = TRACK_LENGTH;

  private roomPickSubscription?: () => void;
  private raceChannel?: RealtimeChannel;

  /**
   * Écouter les choix des autres joueurs en temps réel pour la salle.
   * Quand un autre joueur choisit son athlète, le state local se met à jour.
   */
  subscribeToRoomPicks(code: string): void {
    this.unsubscribeFromRoomPicks();

    this.roomPickSubscription = this.roomService.subscribeToRoomPicks(
      code,
      (seat, _pseudo, athleteId) => this.mergePickFromDb(seat, athleteId),
    );
  }

  public unsubscribeFromRoomPicks(): void {
    this.roomPickSubscription?.();
    this.roomPickSubscription = undefined;
  }

  async subscribeToRace(code: string): Promise<void> {
    this.unsubscribeFromRace();
    const channel = this.supabase
      .channel(`athlete-race-${code}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'athlete_races', filter: `room_code=eq.${code}` },
        (payload) => {
          const race = isRecord(payload.new) ? parseRaceState(payload.new['state']) : null;
          if (race && race.revision > (this.raceSignal()?.revision ?? 0)) this.setRaceState(race);
        },
      );
    this.raceChannel = channel;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error('Le canal de course ne répond pas.'));
      }, 10_000);

      channel.subscribe((status) => {
        if (settled) return;
        if (status === 'SUBSCRIBED') {
          settled = true;
          clearTimeout(timeout);
          resolve();
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          settled = true;
          clearTimeout(timeout);
          reject(new Error('Connexion à la course impossible.'));
        }
      });
    }).catch((error: unknown) => {
      this.unsubscribeFromRace();
      throw error;
    });
  }

  unsubscribeFromRace(): void {
    if (this.raceChannel) void this.supabase.removeChannel(this.raceChannel);
    this.raceChannel = undefined;
  }

  async loadRace(code: string, token: string): Promise<void> {
    const { data, error } = await this.supabase.rpc('get_athlete_race', {
      p_code: code,
      p_token: token,
    });
    if (error) throw new Error(error.message || 'Impossible de charger la course.');
    if (data === null) return;
    const race = parseRaceState(data);
    if (!race) throw new Error('Le serveur a retourné un état de course invalide.');
    if (race.revision > (this.raceSignal()?.revision ?? 0)) this.setRaceState(race);
  }

  private mergePickFromDb(seat: number, athleteId: string | null): void {
    const setup = this.setupSignal();
    if (!setup) return;

    const isKnown = this.isKnownAthlete(athleteId);
    const newPicks = { ...setup.picks, [seat]: isKnown ? athleteId : null };
    this.setupSignal.set({ ...setup, picks: newPicks });
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
      const picks: Record<number, AthleteId | null> = {};
      for (const row of rows) {
        if (!Number.isInteger(row.seat) || row.seat < 0 || row.seat > 3) continue;
        picks[row.seat] = this.isKnownAthlete(row.athlete_id) ? row.athlete_id : null;
      }
      return picks;
    });
  }

  private setRaceState(race: RaceState): void {
    this.raceSignal.set(race);
    const setup = this.setupSignal();
    if (setup) this.setupSignal.set({ ...setup, phase: 'race' });
  }
}

function parseRaceState(value: unknown): RaceState | null {
  if (!isRecord(value)) return null;
  const phase = value['phase'];
  const turnSeat = value['turnSeat'];
  const racers = value['racers'];
  const events = value['events'];
  const revision = value['revision'];
  if (
    (phase !== 'playing' && phase !== 'finished') ||
    !Number.isInteger(turnSeat) ||
    typeof turnSeat !== 'number' ||
    turnSeat < 0 ||
    turnSeat > 3 ||
    !Array.isArray(racers) ||
    racers.length < 2 ||
    racers.length > 4 ||
    !Array.isArray(events) ||
    !Number.isInteger(revision) ||
    typeof revision !== 'number' ||
    revision < 1
  ) return null;

  const parsedEvents = events.filter((event): event is string => typeof event === 'string');
  if (parsedEvents.length !== events.length) return null;
  const parsedRacers = racers.map(parseRacer);
  if (parsedRacers.some((racer) => racer === null)) return null;
  const validRacers = parsedRacers.filter((racer): racer is NonNullable<typeof racer> => racer !== null);
  if (new Set(validRacers.map((racer) => racer.seat)).size !== validRacers.length) return null;
  if (phase === 'playing' && !validRacers.some((racer) => racer.seat === turnSeat && racer.finishRank === null)) {
    return null;
  }
  return {
    phase,
    turnSeat,
    racers: validRacers,
    events: parsedEvents,
    revision,
  };
}

function parseRacer(value: unknown): RaceState['racers'][number] | null {
  if (!isRecord(value)) return null;
  const { seat, pseudo, athlete, position, finishRank, bronze } = value;
  const knownAthlete = ATHLETES.find((candidate) => candidate.id === athlete);
  if (
    !Number.isInteger(seat) ||
    typeof seat !== 'number' ||
    seat < 0 ||
    seat > 3 ||
    typeof pseudo !== 'string' ||
    !knownAthlete ||
    !Number.isInteger(position) ||
    typeof position !== 'number' ||
    position < 0 ||
    position > TRACK_LENGTH ||
    (finishRank !== null && (!Number.isInteger(finishRank) || typeof finishRank !== 'number' || finishRank < 1 || finishRank > 4)) ||
    !Number.isInteger(bronze) ||
    typeof bronze !== 'number' ||
    bronze < 0
  ) return null;
  return {
    seat,
    pseudo,
    athlete: knownAthlete.id,
    position,
    finishRank: finishRank === null ? null : finishRank,
    bronze,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
