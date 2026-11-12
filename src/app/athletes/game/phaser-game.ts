import { GameObjects, Scene } from 'phaser';

export const GAME_SCENE_KEY = 'GameScene';
export const PLAYER_COLORS = [0x4f8cff, 0xff6b6b, 0x2fbf71, 0xf5a623];

export interface TrackRacer {
  seat: number;
  pseudo: string;
  position: number;
  finished: boolean;
}

interface RacerToken {
  circle: GameObjects.Arc;
  name: GameObjects.Text;
}

const TRACK_WIDTH = 800;
const TRACK_HEIGHT = 480;
const MARGIN_X = 70;
const ROW_HEIGHT = 90;
const FIRST_ROW_Y = 110;
const TOKEN_RADIUS = 22;

/** Position (x, y) d'une case de la piste pour un coureur donné. */
export function trackPosition(seat: number, cell: number, trackLength: number): { x: number; y: number } {
  const usableWidth = TRACK_WIDTH - MARGIN_X * 2;
  const step = usableWidth / (trackLength - 1);
  return {
    x: MARGIN_X + cell * step,
    y: FIRST_ROW_Y + seat * ROW_HEIGHT,
  };
}

export class GameScene extends Scene {
  private tokens = new Map<number, RacerToken>();
  private cellsGroup?: GameObjects.Group;
  private statusText?: GameObjects.Text;
  private trackLength = 30;

  constructor() {
    super(GAME_SCENE_KEY);
  }

  create(): void {
    this.add.rectangle(TRACK_WIDTH / 2, TRACK_HEIGHT / 2, TRACK_WIDTH, TRACK_HEIGHT, 0xfff7e8);

    this.cellsGroup = this.add.group();
    this.drawTrackCells();

    this.add
      .text(MARGIN_X, 40, 'DÉPART', { fontFamily: 'Fredoka, system-ui, sans-serif', fontSize: 16, color: '#5b5870' })
      .setOrigin(0.5, 0.5);
    this.add
      .rectangle(TRACK_WIDTH - MARGIN_X, FIRST_ROW_Y + (3 * ROW_HEIGHT) / 2, 14, 3 * ROW_HEIGHT + 40, 0xffd23f, 0.6)
      .setStrokeStyle(2, 0xc99a00);
    this.add
      .text(TRACK_WIDTH - MARGIN_X, 40, 'ARRIVÉE', {
        fontFamily: 'Fredoka, system-ui, sans-serif',
        fontSize: 16,
        color: '#5b5870',
      })
      .setOrigin(0.5, 0.5);

    this.statusText = this.add
      .text(TRACK_WIDTH / 2, TRACK_HEIGHT - 36, 'Préparation de la course…', {
        fontFamily: 'Fredoka, system-ui, sans-serif',
        fontSize: 20,
        color: '#1f1d2b',
      })
      .setOrigin(0.5, 0.5);
  }

  syncRacers(racers: TrackRacer[], turnSeat: number | null, status: string): void {
    this.statusText?.setText(status);

    for (const racer of racers) {
      let token = this.tokens.get(racer.seat);
      if (!token) {
        token = this.createToken(racer);
        this.tokens.set(racer.seat, token);
      }
      this.animateToken(token, racer, turnSeat);
    }

    for (const [seat, token] of this.tokens) {
      if (!racers.some((racer) => racer.seat === seat)) {
        token.circle.destroy();
        token.name.destroy();
        this.tokens.delete(seat);
      }
    }
  }

  private drawTrackCells(): void {
    for (let seat = 0; seat < 4; seat += 1) {
      for (let cell = 0; cell < this.trackLength; cell += 1) {
        const { x, y } = trackPosition(seat, cell, this.trackLength);
        const isLast = cell === this.trackLength - 1;
        const rect = this.add
          .rectangle(x, y, 18, 18, isLast ? 0xffd23f : 0xffffff, isLast ? 0.9 : 0.35)
          .setStrokeStyle(1, 0xd8d3c2)
          .setDepth(-1);
        this.cellsGroup?.add(rect, true);
      }
    }
  }

  private createToken(racer: TrackRacer): RacerToken {
    const { x, y } = trackPosition(racer.seat, racer.position, this.trackLength);
    const circle = this.add
      .arc(x, y, TOKEN_RADIUS, 0, Math.PI * 2, PLAYER_COLORS[racer.seat % PLAYER_COLORS.length])
      .setStrokeStyle(3, 0x1f1d2b, 0.25)
      .setDepth(2);
    const name = this.add
      .text(x, y + TOKEN_RADIUS + 10, racer.pseudo, {
        fontFamily: 'Fredoka, system-ui, sans-serif',
        fontSize: 13,
        color: '#1f1d2b',
      })
      .setOrigin(0.5, 0)
      .setDepth(2);
    return { circle, name };
  }

  private animateToken(token: RacerToken, racer: TrackRacer, turnSeat: number | null): void {
    const { x, y } = trackPosition(racer.seat, racer.position, this.trackLength);
    this.tweens.add({ targets: token.circle, x, y, duration: 350, ease: 'Quad.Out' });
    this.tweens.add({ targets: token.name, x, y: y + TOKEN_RADIUS + 10, duration: 350, ease: 'Quad.Out' });

    const isTurn = turnSeat === racer.seat && !racer.finished;
    token.circle.setScale(isTurn ? 1.2 : 1).setAlpha(racer.finished ? 0.55 : 1);
  }
}
