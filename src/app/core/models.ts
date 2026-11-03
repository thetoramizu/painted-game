/** Coordonnées normalisées de la toile : x,y ∈ [0,1] (indépendant de la taille d'écran) */

export type Point = [number, number];

export interface Stroke {
  id: string;
  playerId: string;
  color: string;
  /** épaisseur relative à la diagonale de la toile (0..1) */
  size: number;
  points: Point[];
}

export interface PlayerInfo {
  id: string;
  name: string;
  color: string;
  connected: boolean;
}

export type GamePhase = 'lobby' | 'playing' | 'results';

/** Modèle généré aléatoirement : primitives vectorielles rendues sur un canvas MODEL_SIZE×MODEL_SIZE */
export interface ModelShape {
  kind: 'circle' | 'rect' | 'triangle' | 'line';
  color: string;
  fill: boolean;
  /** tous en coordonnées [0,1] du modèle */
  a: Point;
  b?: Point; // rect/line : second point (coin opposé / extrémité)
  radius?: number; // circle
  lineWidth?: number; // line
}

export interface GeneratedModel {
  seed: number;
  shapes: ModelShape[];
}

/** État complet d'une partie, calculé par le serveur et diffusé aux clients */
export interface RoomState {
  code: string;
  phase: GamePhase;
  players: PlayerInfo[];
  strokes: Stroke[];
  model: GeneratedModel | null;
  roundDuration: number; // secondes
  endsAt: number | null; // epoch ms (horloge serveur)
  scores: Record<string, number>; // playerId -> % de similarité (0..100)
  hostId: string;
}

export const MODEL_COLORS = [
  '#e63946',
  '#f4a261',
  '#2a9d8f',
  '#457b9d',
  '#9b5de5',
  '#f15bb5',
  '#00bbf9',
  '#ff7b00',
];

export const PLAYER_COLORS = ['#e63946', '#457b9d', '#2a9d8f', '#9b5de5'];

export const MAX_PLAYERS = 4;
