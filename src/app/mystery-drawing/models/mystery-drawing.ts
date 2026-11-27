export type MysteryPhase = 'choosing' | 'drawing' | 'summary' | 'finished';
export type DrawingOperation = 'begin' | 'points' | 'end' | 'fill' | 'undo' | 'redo' | 'clear';
export type DrawingTool = 'brush' | 'eraser' | 'fill';

export interface MysteryPlayer {
  seat: number;
  pseudo: string;
}

export interface MysteryEvent {
  id: number;
  roundIndex: number;
  kind: 'drawing' | 'chat' | 'found' | 'system' | 'summary';
  actorSeat: number | null;
  payload: Record<string, unknown>;
}

export interface MysteryState {
  roomCode: string;
  mySeat: number;
  players: MysteryPlayer[];
  round: number;
  totalRounds: number;
  phase: MysteryPhase;
  drawerSeat: number;
  deadline: string;
  revision: number;
  guessedSeats: number[];
  drawnSeats: number[];
  wordLength: number | null;
  secretWord: string | null;
  wordOptions: string[];
  events: MysteryEvent[];
}

export interface DrawingPoint {
  x: number;
  y: number;
}

export interface ToolbarAction {
  kind: DrawingOperation;
  payload: Record<string, unknown>;
}
