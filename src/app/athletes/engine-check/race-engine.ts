import type { AthleteId } from './athletes.ts';

export const TRACK_LENGTH = 30;
export const FINISH_POSITION = TRACK_LENGTH;
const MAIN_MOVE_JOG = 5;
const TREMPLIN_BOOST = 2;
const RANK_POINTS: Record<number, number> = { 1: 5, 2: 3 };

export interface Racer {
  seat: number;
  pseudo: string;
  athlete: AthleteId;
  position: number;
  finishRank: number | null;
  bronze: number;
}

export interface RaceState {
  phase: 'playing' | 'finished';
  turnSeat: number;
  racers: Racer[];
  events: string[];
}

export interface TurnInput {
  seat: number;
  roll: number;
  useJog: boolean;
}

export function createRace(players: { seat: number; pseudo: string; athlete: AthleteId }[]): RaceState {
  const racers = [...players]
    .sort((a, b) => a.seat - b.seat)
    .map((player) => ({ ...player, position: 0, finishRank: null, bronze: 0 }));
  return {
    phase: 'playing',
    turnSeat: racers[0].seat,
    racers,
    events: ['La course commence !'],
  };
}

export function playTurn(state: RaceState, input: TurnInput): RaceState {
  if (state.phase !== 'playing') {
    throw new Error('La course est terminée.');
  }
  if (input.seat !== state.turnSeat) {
    throw new Error("Ce n'est pas votre tour.");
  }
  if (!Number.isInteger(input.roll) || input.roll < 1 || input.roll > 6) {
    throw new Error('Résultat de dé invalide.');
  }

  const racers = state.racers.map((racer) => ({ ...racer }));
  const events: string[] = [];
  const mover = racers.find((racer) => racer.seat === input.seat);
  if (!mover) {
    throw new Error('Athlète introuvable.');
  }
  if (input.useJog && mover.athlete !== 'genie') {
    throw new Error("Seul le Génie peut avancer sans lancer le dé.");
  }

  if (mover.athlete === 'docteur-fusee' && isAloneInLastPlace(racers, mover)) {
    mover.bronze += 1;
    events.push(`${mover.pseudo} gagne un jeton Bronze « 1 point ».`);
  }

  const base = input.useJog ? MAIN_MOVE_JOG : input.roll;
  const sharesWithRoue = racers.some(
    (racer) => racer.athlete === 'cinquieme-roue' && isActive(racer) && racer.position === mover.position,
  );
  const slimeOnTrack = racers.some((racer) => racer.athlete === 'slime' && isActive(racer));
  const bonus = sharesWithRoue ? 1 : 0;
  const malus = mover.athlete !== 'slime' && slimeOnTrack ? 1 : 0;
  const distance = Math.max(0, base + bonus - malus);

  events.push(
    input.useJog
      ? `${mover.pseudo} utilise son pouvoir et avance de ${distance} case${distance > 1 ? 's' : ''}.`
      : `${mover.pseudo} lance un ${input.roll} et avance de ${distance} case${distance > 1 ? 's' : ''}.`,
  );

  moveRacer(racers, mover, distance, events);

  if (mover.finishRank === null && mover.position < FINISH_POSITION) {
    applyStopPowers(racers, mover, events);
  }

  return { ...withRaceEnd(racers, input.seat), events };
}

function moveRacer(racers: Racer[], racer: Racer, distance: number, events: string[]): void {
  racer.position = Math.min(racer.position + distance, FINISH_POSITION);
  if (racer.position === FINISH_POSITION && racer.finishRank === null) {
    racer.finishRank = racers.filter((other) => other.finishRank !== null).length + 1;
    events.push(`${racer.pseudo} franchit la ligne d'arrivée (${racer.finishRank}e).`);
  }
}

function applyStopPowers(racers: Racer[], mover: Racer, events: string[]): void {
  const occupants = racers.filter((racer) => isActive(racer) && racer.position === mover.position);
  if (occupants.length !== 2) return;

  for (const racer of racers) {
    if (racer.athlete === 'tremplin-devin' && isActive(racer)) {
      events.push(`${racer.pseudo} rebondit sur son tremplin et avance de ${TREMPLIN_BOOST} cases.`);
      moveRacer(racers, racer, TREMPLIN_BOOST, events);
    }
  }
}

function withRaceEnd(racers: Racer[], currentSeat: number): Omit<RaceState, 'events'> {
  const finishedCount = racers.filter((racer) => racer.finishRank !== null).length;
  const activeCount = racers.filter(isActive).length;

  if (finishedCount >= 2 || activeCount === 0) {
    return { phase: 'finished', turnSeat: currentSeat, racers };
  }

  return { phase: 'playing', turnSeat: nextActiveSeat(racers, currentSeat), racers };
}

function nextActiveSeat(racers: Racer[], currentSeat: number): number {
  const seats = racers.filter(isActive).map((racer) => racer.seat).sort((a, b) => a - b);
  return seats.find((seat) => seat > currentSeat) ?? seats[0];
}

function isActive(racer: Racer): boolean {
  return racer.finishRank === null;
}

function isAloneInLastPlace(racers: Racer[], racer: Racer): boolean {
  const others = racers.filter((other) => other !== racer && isActive(other));
  return isActive(racer) && others.every((other) => other.position > racer.position);
}

export function racerPoints(racer: Racer): number {
  const rankPoints = racer.finishRank === null ? 0 : (RANK_POINTS[racer.finishRank] ?? 0);
  return rankPoints + racer.bronze;
}
