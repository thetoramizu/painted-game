import { Routes } from '@angular/router';
import { Home } from './athletes/home/home';
import { Lobby } from './athletes/lobby/lobby';
import { Game } from './athletes/game/game';

export const routes: Routes = [
  { path: '', component: Home, title: 'Athlètes de compète' },
  { path: 'salon/:code', component: Lobby, title: 'Salle d\'attente' },
  { path: 'salon/:code/jouer', component: Game, title: 'Course' },
  { path: '**', redirectTo: '' },
];
