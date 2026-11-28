CREATE OR REPLACE FUNCTION tick_paint_game_state(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_state JSONB;
  v_updated_at TIMESTAMPTZ;
  v_elapsed INTEGER;
  v_observation INTEGER;
  v_painting INTEGER;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN
    RAISE EXCEPTION 'Accès refusé à cette salle';
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'paint' AND status = 'playing';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Aucune partie de peinture n''est en cours';
  END IF;

  SELECT game_state, updated_at
  INTO v_state, v_updated_at
  FROM paint_game_states
  WHERE room_code = upper(p_code)
  FOR UPDATE;

  IF v_state IS NULL OR v_state->>'phase' = 'results' THEN
    RETURN v_state;
  END IF;

  v_elapsed := GREATEST(
    0,
    EXTRACT(EPOCH FROM (clock_timestamp() - v_updated_at))::INTEGER
  );
  IF v_elapsed < 1 THEN
    RETURN v_state;
  END IF;

  IF v_state->>'phase' = 'observation' THEN
    v_observation := GREATEST(
      0,
      (v_state->>'observationSeconds')::INTEGER - v_elapsed
    );
    IF v_observation = 0 THEN
      v_state := jsonb_set(v_state, '{phase}', '"painting"'::JSONB, TRUE);
      v_state := jsonb_set(v_state, '{observationSeconds}', '0'::JSONB, TRUE);
      v_state := jsonb_set(v_state, '{paintingSeconds}', '45'::JSONB, TRUE);
    ELSE
      v_state := jsonb_set(
        v_state,
        '{observationSeconds}',
        to_jsonb(v_observation),
        TRUE
      );
    END IF;
  ELSE
    v_painting := GREATEST(
      0,
      (v_state->>'paintingSeconds')::INTEGER - v_elapsed
    );
    v_state := jsonb_set(v_state, '{paintingSeconds}', to_jsonb(v_painting), TRUE);
  END IF;

  v_state := jsonb_set(
    v_state,
    '{revision}',
    to_jsonb((v_state->>'revision')::NUMERIC + 1),
    TRUE
  );

  UPDATE paint_game_states
  SET game_state = v_state, updated_at = clock_timestamp()
  WHERE room_code = upper(p_code);

  RETURN v_state;
END;
$$;
