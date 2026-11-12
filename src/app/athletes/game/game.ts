import { Component, ElementRef, inject, AfterViewInit, OnDestroy } from '@angular/core';
import Phaser from 'phaser';
import { GameScene } from './phaser-game';

@Component({
  selector: 'app-game',
  template: `<div #gameContainer class="game-container"></div>`,
  styleUrl: './game.css',
})
export class Game implements AfterViewInit, OnDestroy {
  private readonly elementRef = inject(ElementRef);
  private game?: Phaser.Game;

  ngAfterViewInit(): void {
    this.game = new Phaser.Game({
      type: Phaser.CANVAS,
      width: 800,
      height: 480,
      parent: this.elementRef.nativeElement,
      scene: [GameScene],
      backgroundColor: '#fff7e8',
      scale: {
        mode: Phaser.Scale.FIT,
        autoCenter: Phaser.Scale.CENTER_BOTH,
      },
    });
  }

  ngOnDestroy(): void {
    this.game?.destroy(true);
    this.game = undefined;
  }
}
