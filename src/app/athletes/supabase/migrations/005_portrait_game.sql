ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_game_type_check;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_game_type_check
  CHECK (game_type IN ('athletes', 'paint', 'portrait'));

DROP FUNCTION IF EXISTS set_room_game(TEXT, TEXT, TEXT);

CREATE OR REPLACE FUNCTION set_room_game(
  p_code TEXT,
  p_pseudo TEXT,
  p_game_type TEXT
)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_game_type IS NULL OR p_game_type NOT IN ('athletes', 'paint', 'portrait') THEN
    RETURN QUERY SELECT FALSE, 'Ce jeu n''existe pas'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM room_players
    WHERE room_code = p_code AND pseudo = p_pseudo AND seat = 0
  ) THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut choisir le jeu'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rooms WHERE code = p_code AND status = 'lobby'
  ) THEN
    RETURN QUERY SELECT FALSE, 'Le jeu ne peut plus être modifié'::TEXT;
    RETURN;
  END IF;

  UPDATE rooms SET game_type = p_game_type WHERE code = p_code;
  RETURN QUERY SELECT TRUE, 'Jeu choisi'::TEXT;
END;
$$;
