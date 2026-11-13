-- ===========================
-- Synchronisation des choix d'athlètes (multijoueur)
-- ===========================

-- Colonne : athlète choisi par le joueur (nullable = pas encore choisi)
ALTER TABLE room_players
  ADD COLUMN IF NOT EXISTS athlete_id TEXT;

-- Fonction : récupérer les choix d'athlètes d'une salle
-- Arguments : p_code
-- Retour : { seat, athlete_id }
CREATE OR REPLACE FUNCTION get_picks(p_code TEXT)
RETURNS TABLE (seat INTEGER, athlete_id TEXT)
LANGUAGE sql
AS $$
  SELECT rp.seat, rp.athlete_id FROM room_players rp WHERE rp.room_code = p_code;
$$;

