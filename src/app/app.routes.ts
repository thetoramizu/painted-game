import { Routes } from '@angular/router';
import { Home } from './pages/home';
import { Game } from './pages/game';

export const routes: Routes = [
  { path: '', component: Home },
  { path: 'room/:code', component: Game },
  { path: '**', redirectTo: '' },
];
