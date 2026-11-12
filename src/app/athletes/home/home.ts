import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { RoomService, RoomSession } from '../services/room.service';

@Component({
  selector: 'app-home',
  imports: [FormsModule],
  templateUrl: './home.html',
  styleUrl: './home.css',
})
export class Home {
  private readonly roomService = inject(RoomService);
  private readonly router = inject(Router);

  protected readonly createPseudo = signal('');
  protected joinPseudo = '';
  protected readonly joinCode = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  protected create(): void {
    const pseudo = this.createPseudo().trim();
    if (!pseudo) {
      this.error.set('Veuillez entrer un pseudo.');
      return;
    }
    this.enter(() => this.roomService.createRoom(pseudo), pseudo);
  }

  protected join(): void {
    const pseudo = this.joinPseudo.trim();
    const code = this.joinCode().trim().toUpperCase();

    if (!pseudo) {
      this.error.set('Veuillez entrer un pseudo.');
      return;
    }
    if (code.length !== 6) {
      this.error.set('Le code de la salle doit faire 6 caractères.');
      return;
    }

    this.enter(() => this.roomService.joinRoom(code, pseudo), pseudo);
  }

  private async enter(action: () => Promise<RoomSession>, pseudo: string): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      const session = await action();
      this.roomService.savePseudo(session.code, pseudo);
      this.roomService.saveToken(session.code, session.token);
      await this.router.navigate(['/salon', session.code]);
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'Une erreur est survenue. Réessayez.');
    } finally {
      this.busy.set(false);
    }
  }
}
