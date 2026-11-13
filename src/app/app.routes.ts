import { Routes } from '@angular/router';
import { Home } from './athletes/home/home';
import { Lobby } from './athletes/lobby/lobby';
import { Game } from './athletes/game/game';
import { roomGuard } from './athletes/guards/room.guard';

export const routes: Routes = [
  { path: '', component: Home, title: 'Athlètes de compète' },
  { path: 'salon/:code', component: Lobby, title: 'Salle d\'attente', canActivate: [roomGuard] },
  { path: 'salon/:code/jouer', component: Game, title: 'Course', canActivate: [roomGuard] },
  { path: '**', redirectTo: '' },
];
