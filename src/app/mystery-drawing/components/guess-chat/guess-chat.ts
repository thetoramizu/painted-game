import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { MysteryEvent, MysteryPlayer } from '../../models/mystery-drawing';

interface ChatLine {
  id: number;
  system: boolean;
  text: string;
  pseudo: string;
}

@Component({
  selector: 'app-guess-chat',
  standalone: true,
  templateUrl: './guess-chat.html',
  styleUrl: './guess-chat.css',
})
export class GuessChat {
  @Input() events: MysteryEvent[] = [];
  @Input() players: MysteryPlayer[] = [];
  @Input() currentRound = 1;
  @Input() disabled = true;
  @Input() found = false;
  @Input() drawer = false;
  @Output() readonly guess = new EventEmitter<string>();

  protected answer = '';

  protected get lines(): ChatLine[] {
    return this.events
      .filter((event) => event.roundIndex === this.currentRound)
      .flatMap((event) => this.toChatLine(event) ?? []);
  }

  protected submit(): void {
    const answer = this.answer.trim();
    if (!answer || this.disabled || this.found || this.drawer) return;
    this.guess.emit(answer);
    this.answer = '';
  }

  private toChatLine(event: MysteryEvent): ChatLine | null {
    const payload = event.payload;
    if (event.kind === 'chat' && typeof payload['text'] === 'string') {
      return {
        id: event.id,
        system: false,
        pseudo: typeof payload['pseudo'] === 'string' ? payload['pseudo'] : 'Joueur',
        text: payload['text'],
      };
    }
    if (event.kind === 'found') {
      return {
        id: event.id,
        system: true,
        pseudo: '',
        text: `${typeof payload['pseudo'] === 'string' ? payload['pseudo'] : 'Un joueur'} a trouvé le mot !`,
      };
    }
    if (event.kind === 'system') {
      const type = payload['type'];
      const drawerName = this.players.find((player) => player.seat === payload['drawerSeat'])?.pseudo;
      if (type === 'drawing_started') return { id: event.id, system: true, pseudo: '', text: 'Le dessin commence !' };
      if (type === 'round_started') return { id: event.id, system: true, pseudo: '', text: `${drawerName ?? 'Le joueur suivant'} dessine maintenant.` };
      if (type === 'game_finished') return { id: event.id, system: true, pseudo: '', text: 'La partie est terminée.' };
    }
    if (event.kind === 'summary') return { id: event.id, system: true, pseudo: '', text: 'La manche est terminée.' };
    return null;
  }
}
