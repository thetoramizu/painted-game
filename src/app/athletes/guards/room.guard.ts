import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { RoomService } from '../services/room.service';

export const roomGuard: CanActivateFn = async (route) => {
  const router = inject(Router);
  const roomService = inject(RoomService);

  // Récupérer le code depuis les paramètres de route via route.paramMap
  // (et non state.paramMap qui n'existe pas sur RouterStateSnapshot)
  const code = route.paramMap.get('code');

  if (!code) {
    router.navigate(['/']);
    return false;
  }

  // Vérifier que l'utilisateur a un token valide pour cette salle
  const token = roomService.readToken(code);

  if (!token) {
    void router.navigate(['/']);
    return false;
  }

  try {
    await roomService.getRoom(code, token);
    return true;
  } catch {
    void router.navigate(['/']);
    return false;
  }
};