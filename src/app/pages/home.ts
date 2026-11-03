import { Component, computed, effect, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { GameService } from '../core/game.service';
import { MAX_PLAYERS } from '../core/models';

/** Page d'accueil : choisir un pseudo puis créer ou rejoindre une room. */
@Component({
  selector: 'app-home',
  imports: [FormsModule],
  template: `
    <div class="home">
      <h1>🎨 Paint Together</h1>
      <p class="sub">Jusqu'à {{ max }} joueurs recopient ensemble un modèle généré aléatoirement.</p>

      @if (!connected()) {
        <label class="field">
          <span>Serveur</span>
          <input [(ngModel)]="serverUrl" placeholder="http://localhost:3000" />
        </label>
      }

      <label class="field">
        <span>Pseudo</span>
        <input [(ngModel)]="name" maxlength="20" placeholder="Ton prénom" />
      </label>

      <button class="primary" [disabled]="busy()" (click)="create()">✨ Créer une partie</button>

      <div class="divider">ou rejoindre avec un code</div>

      <div class="row">
        <input class="code" [(ngModel)]="code" maxlength="4" placeholder="ABCD" (ngModelChange)="code = code.toUpperCase()" />
        <button [disabled]="busy() || code.length !== 4" (click)="join()">Rejoindre</button>
      </div>

      @if (game.error(); as err) { <p class="error">{{ err }}</p> }
      @if (!game.connected();) { <p class="hint">💡 Le serveur de jeu doit tourner : <code>npm run server</code></p> }
    </div>
  `,
  styles: `
    .home { max-width: 420px; margin: 8vh auto; padding: 32px; background: #fff; border-radius: 16px; box-shadow: 0 8px 40px rgba(0,0,0,.1); text-align: center; }
    h1 { margin: 0 0 4px; }
    .sub { color: #667; margin-top: 0; }
    .field { display: block; text-align: left; margin: 14px 0; }
    .field span { font-size: 13px; color: #556; display: block; margin-bottom: 4px; }
    input { width: 100%; padding: 12px; border: 2px solid #dde; border-radius: 10px; font-size: 16px; box-sizing: border-box; }
    input:focus { outline: none; border-color: #99b; }
    button { width: 100%; padding: 14px; margin-top: 10px; border: none; border-radius: 10px; background: #eef; font-size: 16px; cursor: pointer; }
    button.primary { background: #457b9d; color: #fff; font-weight: 600; }
    button:disabled { opacity: .5; cursor: not-allowed; }
    .divider { margin: 18px 0 8px; color: #889; font-size: 13px; }
    .row { display: flex; gap: 8px; }
    .row input.code { text-transform: uppercase; letter-spacing: 6px; text-align: center; }
    .row button { width: auto; padding: 12px 20px; margin-top: 10px; }
    .error { color: #c0392b; }
    .hint { color: #889; font-size: 13px; }
  `,
})
export class Home {
  private game = inject(GameService);
  private router = inject(Router);

  readonly max = MAX_PLAYERS;
  name = '';
  code = '';
  serverUrl = localStorage.getItem('serverUrl') ?? 'http://localhost:3000';
  busy = signal(false);
  connected = this.game.connected;

  constructor() {
    // dès qu'on a un état de room valide → on navigue vers le salon
    effect(() => {
      if (this.game.roomCode() && this.game.phase()) {
        this.router.navigate(['/room', this.game.roomCode()]);
      }
    });
  }

  private prep(): string | null {
    localStorage.setItem('serverUrl', this.serverUrl);
    if (!this.name.trim()) {
      this.game.error.set('Donne-toi un pseudo 🙂');
      return 'no-name';
    }
    return null;
  }

  create(): void {
    if (this.prep()) return;
    this.busy.set(true);
    this.game.error.set(null);
    this.game.createRoom(this.name.trim(), this.serverUrl);
    setTimeout(() => this.busy.set(false), 2000);
  }

  join(): void {
    if (this.prep() || this.code.length !== 4) return;
    this.busy.set(true);
    this.game.error.set(null);
    this.game.joinRoom(this.code, this.name.trim(), this.serverUrl);
    setTimeout(() => this.busy.set(false), 2000);
  }
}
