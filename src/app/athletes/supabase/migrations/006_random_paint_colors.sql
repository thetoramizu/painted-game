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

  IF p_color IS NULL OR lower(p_color) NOT IN (
    '#4f8cff', '#ff6b6b', '#2fbf71', '#f5a623',
    '#2f6bff', '#d81b60', '#16a05d', '#f0a000',
    '#6d35d4', '#0097b2', '#dc2626', '#7a9c00',
    '#304ffe', '#d81b60', '#2e7d32', '#d49a00',
    '#7b2cbf', '#0077b6', '#d62828', '#558b2f'
  ) THEN
    RETURN QUERY SELECT FALSE, 'Couleur de joueur invalide'::TEXT;
    RETURN;
  END IF;

  expected_color := lower(p_color);

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
