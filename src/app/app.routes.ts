import { Routes } from '@angular/router';
import { Home } from './athletes/home/home';
import { Lobby } from './athletes/lobby/lobby';
import { Game } from './athletes/game/game';
import { roomGuard } from './athletes/guards/room.guard';
import { PaintGame } from './paint-game/paint-game';
import { PortraitGame } from './portrait-game/portrait-game';
import { MysteryDrawing } from './mystery-drawing/mystery-drawing';

export const routes: Routes = [
  { path: '', component: Home, title: 'Salle de jeux' },
  { path: 'salon/:code', component: Lobby, title: 'Salle d\'attente', canActivate: [roomGuard] },
  { path: 'salon/:code/jouer', component: Game, title: 'Course', canActivate: [roomGuard] },
  { path: 'salon/:code/peindre', component: PaintGame, title: 'Toile collaborative', canActivate: [roomGuard] },
  { path: 'salon/:code/portrait', component: PortraitGame, title: 'Portrait décalé', canActivate: [roomGuard] },
  { path: 'salon/:code/dessin-mystere', component: MysteryDrawing, title: 'Dessin Mystère', canActivate: [roomGuard] },
  { path: '**', redirectTo: '' },
];
