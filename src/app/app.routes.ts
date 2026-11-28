import { Routes } from '@angular/router';
import { Home } from './athletes/home/home';
import { roomGuard } from './athletes/guards/room.guard';

export const routes: Routes = [
  { path: '', component: Home, title: 'Salle de jeux' },
  {
    path: 'salon/:code',
    loadComponent: () => import('./athletes/lobby/lobby').then((module) => module.Lobby),
    title: 'Salle d\'attente',
    canActivate: [roomGuard],
  },
  {
    path: 'salon/:code/jouer',
    loadComponent: () => import('./athletes/game/game').then((module) => module.Game),
    title: 'Course',
    canActivate: [roomGuard],
  },
  {
    path: 'salon/:code/peindre',
    loadComponent: () => import('./paint-game/paint-game').then((module) => module.PaintGame),
    title: 'Toile collaborative',
    canActivate: [roomGuard],
  },
  {
    path: 'salon/:code/portrait',
    loadComponent: () => import('./portrait-game/portrait-game').then((module) => module.PortraitGame),
    title: 'Portrait décalé',
    canActivate: [roomGuard],
  },
  {
    path: 'salon/:code/dessin-mystere',
    loadComponent: () => import('./mystery-drawing/mystery-drawing').then((module) => module.MysteryDrawing),
    title: 'Dessin Mystère',
    canActivate: [roomGuard],
  },
  { path: '**', redirectTo: '' },
];
