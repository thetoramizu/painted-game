CREATE TABLE IF NOT EXISTS paint_game_states (
  room_code TEXT PRIMARY KEY REFERENCES rooms(code) ON DELETE CASCADE,
  game_state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE paint_game_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON paint_game_states FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION validate_paint_stroke_color()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_expected_color TEXT;
BEGIN
  SELECT lower(game_state->'playerColors'->>NEW.player_seat)
  INTO v_expected_color
  FROM paint_game_states
  WHERE room_code = NEW.room_code;

  IF v_expected_color IS NULL OR lower(NEW.player_color) IS DISTINCT FROM v_expected_color THEN
    RAISE EXCEPTION 'Couleur non autorisée pour ce siège';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS validate_paint_stroke_color ON paint_strokes;
CREATE TRIGGER validate_paint_stroke_color
BEFORE INSERT OR UPDATE OF room_code, player_seat, player_color ON paint_strokes
FOR EACH ROW
EXECUTE FUNCTION validate_paint_stroke_color();

CREATE OR REPLACE FUNCTION clear_paint_game_state_on_lobby()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'lobby' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM paint_game_states WHERE room_code = NEW.code;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clear_paint_game_state_on_lobby ON rooms;
CREATE TRIGGER clear_paint_game_state_on_lobby
AFTER UPDATE OF status ON rooms
FOR EACH ROW
EXECUTE FUNCTION clear_paint_game_state_on_lobby();

CREATE OR REPLACE FUNCTION save_paint_game_state(p_code TEXT, p_token TEXT, p_state JSONB)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_revision NUMERIC;
  v_existing_state JSONB;
  v_state JSONB;
  v_player_count INTEGER;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut modifier l''état du jeu'::TEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'paint' AND status = 'playing'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Aucune partie de peinture n''est en cours'::TEXT;
    RETURN;
  END IF;

  IF jsonb_typeof(p_state) IS DISTINCT FROM 'object'
    OR octet_length(p_state::TEXT) > 65536
    OR p_state->>'phase' IS NULL
    OR p_state->>'phase' NOT IN ('observation', 'painting', 'results')
    OR jsonb_typeof(p_state->'revision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_state->'model') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_state->'model'->'marks') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_state->'playerColors') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_state->'revealUsedSeats') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_state->'revealUntilBySeat') IS DISTINCT FROM 'object'
  THEN
    RETURN QUERY SELECT FALSE, 'L''état de la partie est invalide'::TEXT;
    RETURN;
  END IF;

  v_revision := (p_state->>'revision')::NUMERIC;
  IF v_revision < 0 OR v_revision > 1000000000 OR v_revision <> trunc(v_revision) THEN
    RETURN QUERY SELECT FALSE, 'La révision de la partie est invalide'::TEXT;
    RETURN;
  END IF;

  IF jsonb_array_length(p_state->'playerColors') NOT BETWEEN 2 AND 4
    OR jsonb_array_length(p_state->'model'->'marks') NOT BETWEEN 4 AND 8
    OR jsonb_array_length(p_state->'revealUsedSeats') > 4
  THEN
    RETURN QUERY SELECT FALSE, 'L''état de la partie contient des données invalides'::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(p_state->'playerColors') AS color(value)
    WHERE jsonb_typeof(color.value) IS DISTINCT FROM 'string'
      OR lower(color.value #>> '{}') NOT IN (
        '#4f8cff', '#ff6b6b', '#2fbf71', '#f5a623',
        '#2f6bff', '#d81b60', '#16a05d', '#f0a000',
        '#6d35d4', '#0097b2', '#dc2626', '#7a9c00',
        '#304ffe', '#2e7d32', '#d49a00',
        '#7b2cbf', '#0077b6', '#d62828', '#558b2f'
      )
  ) THEN
    RETURN QUERY SELECT FALSE, 'La palette de couleurs est invalide'::TEXT;
    RETURN;
  END IF;

  SELECT count(*) INTO v_player_count
  FROM room_players
  WHERE room_code = upper(p_code);

  IF jsonb_array_length(p_state->'playerColors') <> v_player_count THEN
    RETURN QUERY SELECT FALSE, 'Le nombre de couleurs ne correspond pas aux joueurs'::TEXT;
    RETURN;
  END IF;

  SELECT game_state INTO v_existing_state
  FROM paint_game_states
  WHERE room_code = upper(p_code);

  IF v_existing_state IS NOT NULL
    AND (v_existing_state->>'revision')::NUMERIC >= v_revision
  THEN
    RETURN QUERY SELECT FALSE, 'Une version plus récente de la partie existe déjà'::TEXT;
    RETURN;
  END IF;

  v_state := p_state;
  IF v_existing_state IS NOT NULL THEN
    v_state := jsonb_set(
      v_state,
      '{revealUsedSeats}',
      COALESCE(v_existing_state->'revealUsedSeats', '[]'::JSONB)
        || COALESCE(v_state->'revealUsedSeats', '[]'::JSONB),
      TRUE
    );
    v_state := jsonb_set(
      v_state,
      '{revealUntilBySeat}',
      COALESCE(v_existing_state->'revealUntilBySeat', '{}'::JSONB)
        || COALESCE(v_state->'revealUntilBySeat', '{}'::JSONB),
      TRUE
    );
  END IF;

  INSERT INTO paint_game_states (room_code, game_state, updated_at)
  VALUES (upper(p_code), v_state, now())
  ON CONFLICT (room_code)
  DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = EXCLUDED.updated_at;

  RETURN QUERY SELECT TRUE, 'État de la partie enregistré'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION get_paint_game_state(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_state JSONB;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN
    RAISE EXCEPTION 'Accès refusé à cette salle';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rooms
    WHERE code = upper(p_code) AND game_type = 'paint' AND status = 'playing'
  ) THEN
    RAISE EXCEPTION 'Aucune partie de peinture n''est en cours';
  END IF;

  SELECT game_state INTO v_state
  FROM paint_game_states
  WHERE room_code = upper(p_code);
  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION request_paint_model_reveal(p_code TEXT, p_token TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT, state JSONB)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_state JSONB;
  v_until BIGINT;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Accès refusé à cette salle'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'paint' AND status = 'playing'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Aucune partie de peinture n''est en cours'::TEXT, NULL::JSONB;
    RETURN;
  END IF;

  SELECT game_state INTO v_state
  FROM paint_game_states
  WHERE room_code = upper(p_code);

  IF v_state IS NULL OR v_state->>'phase' <> 'painting' THEN
    RETURN QUERY SELECT FALSE, 'Le modèle ne peut pas être révélé maintenant'::TEXT, v_state;
    RETURN;
  END IF;

  IF v_state->'revealUsedSeats' @> jsonb_build_array(v_seat) THEN
    RETURN QUERY SELECT FALSE, 'Vous avez déjà utilisé cette aide'::TEXT, v_state;
    RETURN;
  END IF;

  v_until := floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT + 5000;
  v_state := jsonb_set(
    v_state,
    '{revealUsedSeats}',
    v_state->'revealUsedSeats' || jsonb_build_array(v_seat),
    TRUE
  );
  v_state := jsonb_set(
    v_state,
    ARRAY['revealUntilBySeat', v_seat::TEXT],
    to_jsonb(v_until),
    TRUE
  );
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb((v_state->>'revision')::NUMERIC + 1),
    TRUE
  );

  UPDATE paint_game_states
  SET game_state = v_state, updated_at = now()
  WHERE room_code = upper(p_code);

  RETURN QUERY SELECT TRUE, 'Modèle révélé'::TEXT, v_state;
END;
$$;
