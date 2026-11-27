-- Shared lobby game selection and collaborative paint lifecycle.

ALTER TABLE rooms
  ADD COLUMN IF NOT EXISTS game_type TEXT NOT NULL DEFAULT 'athletes';

UPDATE rooms SET game_type = 'athletes' WHERE game_type IS NULL;

ALTER TABLE rooms
  ALTER COLUMN game_type SET DEFAULT 'athletes',
  ALTER COLUMN game_type SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'rooms_game_type_check'
      AND conrelid = 'rooms'::regclass
  ) THEN
    ALTER TABLE rooms
      ADD CONSTRAINT rooms_game_type_check CHECK (game_type IN ('athletes', 'paint'));
  END IF;
END;
$$;

ALTER TABLE rooms REPLICA IDENTITY FULL;

CREATE TABLE IF NOT EXISTS paint_strokes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  player_seat INTEGER NOT NULL CHECK (player_seat >= 0 AND player_seat < 4),
  player_color TEXT NOT NULL,
  points JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_paint_strokes_room ON paint_strokes(room_code);
ALTER TABLE paint_strokes ENABLE ROW LEVEL SECURITY;

DROP FUNCTION IF EXISTS get_room(TEXT, TEXT);

CREATE FUNCTION get_room(p_code TEXT, p_pseudo TEXT)
RETURNS TABLE (
  code TEXT,
  status TEXT,
  "mySeat" INTEGER,
  "gameType" TEXT,
  players JSONB
)
LANGUAGE sql
AS $$
  SELECT
    r.code,
    r.status,
    MAX(CASE WHEN rp.pseudo = p_pseudo THEN rp.seat END) AS "mySeat",
    r.game_type AS "gameType",
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'pseudo', rp.pseudo,
          'seat', rp.seat,
          'athleteId', rp.athlete_id
        ) ORDER BY rp.seat
      ) FILTER (WHERE rp.seat IS NOT NULL),
      '[]'::jsonb
    ) AS players
  FROM rooms r
  LEFT JOIN room_players rp ON rp.room_code = r.code
  WHERE r.code = p_code
  GROUP BY r.code, r.status, r.game_type;
$$;

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
  IF p_game_type IS NULL OR p_game_type NOT IN ('athletes', 'paint') THEN
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

ALTER TABLE paint_strokes
  DROP CONSTRAINT IF EXISTS uq_paint_strokes_room_seat;

DROP FUNCTION IF EXISTS add_paint_stroke(TEXT, INTEGER, TEXT, JSONB);

CREATE OR REPLACE FUNCTION add_paint_stroke(
  p_stroke_id UUID,
  p_room_code TEXT,
  p_seat INTEGER,
  p_color TEXT,
  p_points JSONB
)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  expected_color TEXT;
BEGIN
  IF p_seat < 0 OR p_seat > 3 THEN
    RETURN QUERY SELECT FALSE, 'Siège de joueur invalide'::TEXT;
    RETURN;
  END IF;

  expected_color := CASE p_seat
    WHEN 0 THEN '#4f8cff'
    WHEN 1 THEN '#ff6b6b'
    WHEN 2 THEN '#2fbf71'
    ELSE '#f5a623'
  END;

  IF lower(p_color) <> expected_color THEN
    RETURN QUERY SELECT FALSE, 'Couleur de joueur invalide'::TEXT;
    RETURN;
  END IF;

  IF jsonb_typeof(p_points) IS DISTINCT FROM 'array' THEN
    RETURN QUERY SELECT FALSE, 'Le trait est invalide'::TEXT;
    RETURN;
  END IF;

  IF jsonb_array_length(p_points) = 0 OR jsonb_array_length(p_points) > 10000 THEN
    RETURN QUERY SELECT FALSE, 'Le trait doit contenir entre 1 et 10000 points'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM room_players
    WHERE room_code = p_room_code AND seat = p_seat
  ) THEN
    RETURN QUERY SELECT FALSE, 'Ce joueur ne fait pas partie de la salle'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM rooms
    WHERE code = p_room_code AND game_type = 'paint' AND status = 'playing'
  ) THEN
    RETURN QUERY SELECT FALSE, 'La toile n''est pas en cours de jeu'::TEXT;
    RETURN;
  END IF;

  INSERT INTO paint_strokes (id, room_code, player_seat, player_color, points)
  VALUES (p_stroke_id, p_room_code, p_seat, expected_color, p_points)
  ON CONFLICT (id) DO NOTHING;

  RETURN QUERY SELECT TRUE, 'Trait enregistré'::TEXT;
END;
$$;

DROP FUNCTION IF EXISTS get_paint_strokes(TEXT);

CREATE FUNCTION get_paint_strokes(p_room_code TEXT)
RETURNS TABLE (
  id UUID,
  seat INTEGER,
  color TEXT,
  points JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    ps.id,
    ps.player_seat,
    ps.player_color,
    ps.points,
    ps.created_at
  FROM paint_strokes ps
  WHERE ps.room_code = p_room_code
  ORDER BY ps.created_at, ps.id;
$$;

CREATE OR REPLACE FUNCTION finish_paint_game(p_code TEXT, p_pseudo TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM room_players
    WHERE room_code = p_code AND pseudo = p_pseudo AND seat = 0
  ) THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut terminer la partie'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rooms
    WHERE code = p_code AND game_type = 'paint' AND status = 'playing'
  ) THEN
    RETURN QUERY SELECT FALSE, 'Aucune partie de peinture n''est en cours'::TEXT;
    RETURN;
  END IF;

  DELETE FROM paint_strokes WHERE room_code = p_code;
  UPDATE rooms SET status = 'lobby' WHERE code = p_code;
  RETURN QUERY SELECT TRUE, 'Partie terminée et toile effacée'::TEXT;
END;
$$;
