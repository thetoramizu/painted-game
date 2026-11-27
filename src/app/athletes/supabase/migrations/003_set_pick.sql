-- ===========================
-- Fonction : définir le choix d'un athlète
-- Arguments : p_code, p_seat, p_athlete_id
-- Note : on utilise le siège au lieu du pseudo pour éviter les ambiguïtés
-- si deux joueurs avaient le même pseudo (ce qui est autorisé par l'app).
-- ===========================

CREATE OR REPLACE FUNCTION set_pick(
  p_code TEXT,
  p_seat INTEGER,
  p_athlete_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE room_players
  SET athlete_id = p_athlete_id
  WHERE room_code = p_code
    AND seat = p_seat;
END
$$;