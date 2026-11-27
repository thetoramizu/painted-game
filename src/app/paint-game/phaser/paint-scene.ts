import { GameObjects, Scene } from 'phaser';

export type PaintStrokeType = 'start' | 'move' | 'end';

export interface PaintStroke {
  id: string;
  seat: number;
  color: string;
  points: { x: number; y: number }[];
  type: PaintStrokeType;
}

export interface PaintPlayerColor {
  seat: number;
  color: string;
}

/**
 * Scène Phaser pour le jeu de peinture collaborative.
 */
export class PaintScene extends Scene {
  canvasWidth = 0;
  canvasHeight = 0;

  constructor() {
    super('PaintScene');
  }

  initPaintScene(
    paintService: any,
    onRemoteStrokeCallback: (stroke: PaintStroke) => void,
    seat: number,
    color: string,
    canvasWidth: number,
    canvasHeight: number
  ): void {
    // Stockage des références pour utilisation dans create()
  }

  create(): void {
    // Fond blanc de la toile
    this.add.rectangle(
      this.canvasWidth / 2,
      this.canvasHeight / 2,
      this.canvasWidth,
      this.canvasHeight,
      0xffffff
    );

    // Zone de dessin : écoute des événements pointer
    this.setupDrawing();
  }

  /**
   * Configurer la zone de dessin avec les événements pointer.
   */
  private setupDrawing(): void {
    // Utiliser (graphics as any) pour contourner les erreurs de type Phaser
    const graphics = this.add.graphics() as any;

    // Début du dessin au pointer down
    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      this.isDrawing = true;
      // Début du tracé
      graphics.beginPath();
      const localPos = { x: pointer.x, y: pointer.y };
      graphics.moveTo(localPos.x, localPos.y);

      // Envoi du stroke 'start'
      this.sendLocalStroke('start', localPos.x, localPos.y);
    });

    // Mouvement pendant le dessin
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      if (!this.isDrawing) return;
      const localPos = { x: pointer.x, y: pointer.y };
      graphics.lineTo(localPos.x, localPos.y);
      graphics.strokeStyle = this.currentColor;
      graphics.lineWidth = 3;
      graphics.stroke();

      // Envoi du point 'move'
      this.sendLocalStroke('move', localPos.x, localPos.y);
    });

    // Fin du dessin au pointer up
    this.input.on('pointerup', () => {
      this.isDrawing = false;
      this.sendLocalStroke('end');
      setTimeout(() => {
        this.isDrawing = false;
      }, 100);
    });
  }

  private isDrawing = false;
  private currentColor: string = '';
  private currentSeat: number = 0;

  private sendLocalStroke(type: PaintStrokeType, x?: number, y?: number): void {
    // À implémenter dans le composant parent
    // this.paintService?.sendPaintStroke(type, x, y, this.currentColor, this.currentSeat);
  }

  receiveRemoteStroke(stroke: PaintStroke): void {
    // Utiliser cast any pour contourner les erreurs de type Graphics
    const graphics = this.children.list?.find(
      (c: any) => c.type === 'Graphics'
    ) as any;

    if (!graphics) return;

    graphics.strokeStyle = stroke.color;
    graphics.lineWidth = 3;

    if (stroke.type === 'start') {
      graphics.beginPath();
      const firstPoint = stroke.points[0];
      if (firstPoint) {
        graphics.moveTo(firstPoint.x, firstPoint.y);
        graphics.stroke();
      }
    } else if (stroke.type === 'move') {
      if (stroke.points.length > 0) {
        const lastPoint = stroke.points[stroke.points.length - 1];
        graphics.lineTo(lastPoint.x, lastPoint.y);
        graphics.stroke();
      }
    } else if (stroke.type === 'end') {
      graphics.stroke();
    }
  }
}