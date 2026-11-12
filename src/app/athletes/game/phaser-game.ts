import { Scene, GameObjects } from 'phaser';

export class GameScene extends Scene {
  private players: GameObjects.Image[] = [];
  private track?: GameObjects.Rectangle;
  private diceLabel?: GameObjects.Text;

  create(): void {
    this.add.image(400, 240, 'background').setOrigin(0.5, 0.5);

    this.track = this.add
      .rectangle(400, 240, 360, 300, 0xffffff, 0.25)
      .setStrokeStyle(2, 0xcccccc);
    this.track.setOrigin(0.5, 0.5);
    this.add.existing(this.track);

    const playerImages = [
      this.add.image(220, 300, 'player0').setOrigin(0.5, 0.5),
      this.add.image(300, 340, 'player1').setOrigin(0.5, 0.5),
      this.add.image(400, 300, 'player2').setOrigin(0.5, 0.5),
      this.add.image(500, 300, 'player3').setOrigin(0.5, 0.5),
    ];

    this.players = playerImages.map((p) => {
      p.setAlpha(0.85);
      return p;
    });

    this.diceLabel = this.add
      .text(400, 120, 'Salle de jeu — à définir', {
        fontFamily: 'Fredoka, system-ui, sans-serif',
        fontSize: 22,
        color: '#1f1d2b',
      })
      .setOrigin(0.5, 0.5);

    const labels = ['Joueur 1', 'Joueur 2', 'Joueur 3', 'Joueur 4'];
    labels.forEach((label, i) => {
      this.add
        .text([220, 300, 400, 500][i], 380, label, {
          fontSize: 14,
          color: '#5b5870',
        })
        .setOrigin(0.5, 0.5);
    });
  }
}
