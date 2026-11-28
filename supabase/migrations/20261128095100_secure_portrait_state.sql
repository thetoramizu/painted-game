CREATE TABLE IF NOT EXISTS portrait_game_states (
  room_code TEXT PRIMARY KEY REFERENCES rooms(code) ON DELETE CASCADE,
  game_state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE portrait_game_states ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portrait_game_states FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION clear_portrait_game_state_on_lobby()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'lobby' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM portrait_game_states WHERE room_code = NEW.code;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clear_portrait_game_state_on_lobby ON rooms;
CREATE TRIGGER clear_portrait_game_state_on_lobby
AFTER UPDATE OF status ON rooms
FOR EACH ROW
EXECUTE FUNCTION clear_portrait_game_state_on_lobby();

CREATE OR REPLACE FUNCTION save_portrait_game_state(p_code TEXT, p_token TEXT, p_state JSONB)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_existing JSONB;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut modifier l’état du portrait'::TEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'portrait' AND status = 'playing';
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Aucune partie de portrait n’est en cours'::TEXT;
    RETURN;
  END IF;

  IF jsonb_typeof(p_state) IS DISTINCT FROM 'object'
    OR octet_length(p_state::TEXT) > 65536
    OR p_state->>'phase' NOT IN ('preparation', 'observation', 'reproduction', 'results')
    OR jsonb_typeof(p_state->'revision') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_state->'model') NOT IN ('object', 'null')
    OR jsonb_typeof(p_state->'turns') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_state->'placements') IS DISTINCT FROM 'object'
    OR jsonb_typeof(p_state->'observationSeconds') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_state->'score') IS DISTINCT FROM 'number'
    OR jsonb_typeof(p_state->'movementStartedAt') IS DISTINCT FROM 'number'
  THEN
    RETURN QUERY SELECT FALSE, 'L’état du portrait est invalide'::TEXT;
    RETURN;
  END IF;

  SELECT game_state INTO v_existing
  FROM portrait_game_states
  WHERE room_code = upper(p_code);

  IF v_existing IS NOT NULL
    AND (v_existing->>'revision')::NUMERIC >= (p_state->>'revision')::NUMERIC
  THEN
    RETURN QUERY SELECT FALSE, 'Une version plus récente du portrait existe déjà'::TEXT;
    RETURN;
  END IF;

  INSERT INTO portrait_game_states(room_code, game_state, updated_at)
  VALUES (upper(p_code), p_state, clock_timestamp())
  ON CONFLICT (room_code)
  DO UPDATE SET game_state = EXCLUDED.game_state, updated_at = EXCLUDED.updated_at;

  RETURN QUERY SELECT TRUE, 'État du portrait enregistré'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION get_portrait_game_state(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT p.game_state
  FROM portrait_game_states p
  JOIN rooms r ON r.code = p.room_code
  WHERE p.room_code = upper(p_code)
    AND r.game_type = 'portrait'
    AND r.status = 'playing'
    AND room_player_seat(p_code, p_token) IS NOT NULL;
$$;

CREATE OR REPLACE FUNCTION tick_portrait_game_state(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_state JSONB;
  v_updated_at TIMESTAMPTZ;
  v_elapsed INTEGER;
  v_remaining INTEGER;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN
    RAISE EXCEPTION 'Accès refusé à cette salle';
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'portrait' AND status = 'playing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aucune partie de portrait n’est en cours';
  END IF;

  SELECT game_state, updated_at
  INTO v_state, v_updated_at
  FROM portrait_game_states
  WHERE room_code = upper(p_code)
  FOR UPDATE;

  IF v_state IS NULL OR v_state->>'phase' IS DISTINCT FROM 'observation' THEN
    RETURN v_state;
  END IF;

  v_elapsed := GREATEST(
    0,
    EXTRACT(EPOCH FROM (clock_timestamp() - v_updated_at))::INTEGER
  );
  IF v_elapsed < 1 THEN
    RETURN v_state;
  END IF;

  v_remaining := GREATEST(
    0,
    (v_state->>'observationSeconds')::INTEGER - v_elapsed
  );
  v_state := jsonb_set(v_state, '{observationSeconds}', to_jsonb(v_remaining), TRUE);
  IF v_remaining = 0 THEN
    v_state := jsonb_set(v_state, '{phase}', '"reproduction"'::JSONB, TRUE);
    v_state := jsonb_set(v_state, '{movementStartedAt}', to_jsonb(EXTRACT(EPOCH FROM clock_timestamp()) * 1000), TRUE);
  END IF;
  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb((v_state->>'revision')::NUMERIC + 1),
    TRUE
  );

  UPDATE portrait_game_states
  SET game_state = v_state, updated_at = clock_timestamp()
  WHERE room_code = upper(p_code);

  RETURN v_state;
END;
$$;
