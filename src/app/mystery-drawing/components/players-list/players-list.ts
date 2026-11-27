import { Component, Input } from '@angular/core';
import type { MysteryPlayer } from '../../models/mystery-drawing';

@Component({
  selector: 'app-players-list',
  standalone: true,
  templateUrl: './players-list.html',
  styleUrl: './players-list.css',
})
export class PlayersList {
  @Input() players: MysteryPlayer[] = [];
  @Input() drawerSeat = -1;
  @Input() guessedSeats: number[] = [];
  @Input() drawnSeats: number[] = [];
  @Input() mySeat = -1;
  @Input() phase = '';
}
