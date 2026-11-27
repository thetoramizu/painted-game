import { Component, Input } from '@angular/core';
import type { MysteryEvent, MysteryPlayer } from '../../models/mystery-drawing';

@Component({
  selector: 'app-round-summary',
  standalone: true,
  templateUrl: './round-summary.html',
  styleUrl: './round-summary.css',
})
export class RoundSummary {
  @Input() events: MysteryEvent[] = [];
  @Input() players: MysteryPlayer[] = [];
  @Input() round = 1;
  @Input() totalRounds = 1;
  @Input() finished = false;

  protected get summary(): Record<string, unknown> | null {
    return this.events.find((event) => event.kind === 'summary' && event.roundIndex === this.round)?.payload ?? null;
  }

  protected getNames(key: 'foundSeats' | 'missedSeats'): string[] {
    const seats = this.summary?.[key];
    if (!Array.isArray(seats)) return [];
    return seats.flatMap((seat) => {
      const player = this.players.find((candidate) => candidate.seat === seat);
      return player ? [player.pseudo] : [];
    });
  }

  protected getFoundCount(seat: number): number {
    return this.events.reduce((count, event) => {
      if (event.kind !== 'summary' || !Array.isArray(event.payload['foundSeats'])) return count;
      return count + (event.payload['foundSeats'].includes(seat) ? 1 : 0);
    }, 0);
  }
}
