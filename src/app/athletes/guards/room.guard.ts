import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { SupabaseService } from '../core/supabase-client';

export const roomGuard: CanActivateFn = (route, state) => {
  const router = inject(Router);
  const supabase = inject(SupabaseService).client;

  // Récupérer le code depuis les paramètres de route via route.paramMap
  // (et non state.paramMap qui n'existe pas sur RouterStateSnapshot)
  const code = route.paramMap.get('code');

  if (!code) {
    router.navigate(['/']);
    return false;
  }

  // Vérifier que l'utilisateur a un token valide pour cette salle
  const token = localStorage.getItem(`athletes-room-token:${code}`);

  if (!token) {
    router.navigate(['/']);
    return false;
  }

  return true;
};