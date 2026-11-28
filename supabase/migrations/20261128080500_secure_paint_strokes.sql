DROP POLICY IF EXISTS paint_strokes_select_public ON paint_strokes;
DROP POLICY IF EXISTS paint_strokes_insert_service ON paint_strokes;
REVOKE ALL ON paint_strokes FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS add_paint_stroke(UUID, TEXT, INTEGER, TEXT, JSONB);

CREATE FUNCTION add_paint_stroke(
  p_stroke_id UUID,
  p_room_code TEXT,
  p_token TEXT,
  p_seat INTEGER,
  p_color TEXT,
  p_points JSONB
)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_color TEXT;
BEGIN
  v_seat := room_player_seat(p_room_code, p_token);
  IF v_seat IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Accès refusé à cette salle'::TEXT;
    RETURN;
  END IF;

  IF v_seat <> p_seat THEN
    RETURN QUERY SELECT FALSE, 'Vous ne pouvez enregistrer que vos propres traits'::TEXT;
    RETURN;
  END IF;

  IF p_seat IS NULL OR p_seat < 0 OR p_seat > 3 THEN
    RETURN QUERY SELECT FALSE, 'Siège de joueur invalide'::TEXT;
    RETURN;
  END IF;

  v_color := lower(p_color);
  IF v_color IS NULL OR v_color NOT IN (
    '#4f8cff', '#ff6b6b', '#2fbf71', '#f5a623',
    '#2f6bff', '#d81b60', '#16a05d', '#f0a000',
    '#6d35d4', '#0097b2', '#dc2626', '#7a9c00',
    '#304ffe', '#2e7d32', '#d49a00',
    '#7b2cbf', '#0077b6', '#d62828', '#558b2f'
  ) THEN
    RETURN QUERY SELECT FALSE, 'Couleur de joueur invalide'::TEXT;
    RETURN;
  END IF;

  IF jsonb_typeof(p_points) IS DISTINCT FROM 'array' THEN
    RETURN QUERY SELECT FALSE, 'Le trait doit contenir un tableau de points'::TEXT;
    RETURN;
  END IF;

  IF jsonb_array_length(p_points) NOT BETWEEN 1 AND 10000 THEN
    RETURN QUERY SELECT FALSE, 'Le trait doit contenir entre 1 et 10000 points'::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_points) AS point(value)
    WHERE jsonb_typeof(point.value) IS DISTINCT FROM 'object'
      OR jsonb_typeof(point.value->'x') IS DISTINCT FROM 'number'
      OR jsonb_typeof(point.value->'y') IS DISTINCT FROM 'number'
      OR CASE
        WHEN jsonb_typeof(point.value->'x') = 'number'
          THEN (point.value->>'x')::NUMERIC NOT BETWEEN 0 AND 1
        ELSE TRUE
      END
      OR CASE
        WHEN jsonb_typeof(point.value->'y') = 'number'
          THEN (point.value->>'y')::NUMERIC NOT BETWEEN 0 AND 1
        ELSE TRUE
      END
      OR (
        point.value ? 'radius'
        AND (
          jsonb_typeof(point.value->'radius') IS DISTINCT FROM 'number'
          OR CASE
            WHEN jsonb_typeof(point.value->'radius') = 'number'
              THEN (point.value->>'radius')::NUMERIC NOT BETWEEN 0.5 AND 8
            ELSE TRUE
          END
        )
      )
  ) THEN
    RETURN QUERY SELECT FALSE, 'Le trait contient des coordonnées invalides'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM rooms
    WHERE code = upper(p_room_code) AND game_type = 'paint' AND status = 'playing'
  ) THEN
    RETURN QUERY SELECT FALSE, 'La toile n''est pas en cours de jeu'::TEXT;
    RETURN;
  END IF;

  INSERT INTO paint_strokes (id, room_code, player_seat, player_color, points)
  VALUES (p_stroke_id, upper(p_room_code), v_seat, v_color, p_points)
  ON CONFLICT (id) DO NOTHING;

  RETURN QUERY SELECT TRUE, 'Trait enregistré'::TEXT;
END;
$$;

DROP FUNCTION IF EXISTS get_paint_strokes(TEXT);

CREATE FUNCTION get_paint_strokes(p_room_code TEXT, p_token TEXT)
RETURNS TABLE (
  id UUID,
  seat INTEGER,
  color TEXT,
  points JSONB,
  created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
BEGIN
  v_seat := room_player_seat(p_room_code, p_token);
  IF v_seat IS NULL THEN
    RAISE EXCEPTION 'Accès refusé à cette salle';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM rooms
    WHERE code = upper(p_room_code) AND game_type = 'paint' AND status = 'playing'
  ) THEN
    RAISE EXCEPTION 'La toile n''est pas en cours de jeu';
  END IF;

  RETURN QUERY
  SELECT
    ps.id,
    ps.player_seat,
    ps.player_color,
    ps.points,
    ps.created_at
  FROM paint_strokes AS ps
  WHERE ps.room_code = upper(p_room_code)
  ORDER BY ps.created_at, ps.id;
END;
$$;
