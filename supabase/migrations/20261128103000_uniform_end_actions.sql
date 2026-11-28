CREATE OR REPLACE FUNCTION finish_room_game(p_code TEXT, p_token TEXT)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut terminer la partie'::TEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND status = 'playing'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Aucune partie n’est en cours'::TEXT;
    RETURN;
  END IF;

  DELETE FROM paint_strokes WHERE room_code = upper(p_code);
  DELETE FROM paint_game_states WHERE room_code = upper(p_code);
  DELETE FROM portrait_game_states WHERE room_code = upper(p_code);
  DELETE FROM athlete_races WHERE room_code = upper(p_code);
  DELETE FROM mystery_events WHERE room_code = upper(p_code);
  DELETE FROM mystery_games WHERE room_code = upper(p_code);

  UPDATE rooms SET status = 'lobby' WHERE code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'Retour au lobby effectué'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION restart_portrait_game(p_code TEXT, p_token TEXT)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut relancer le portrait'::TEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'portrait' AND status = 'playing';
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'La partie de portrait n’est pas en cours'::TEXT;
    RETURN;
  END IF;

  DELETE FROM portrait_game_states WHERE room_code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'Le portrait peut recommencer'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION restart_paint_game(p_code TEXT, p_token TEXT)
RETURNS TABLE(success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut relancer la partie'::TEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'paint' AND status = 'playing';
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'La partie de peinture n’est pas en cours'::TEXT;
    RETURN;
  END IF;

  DELETE FROM paint_strokes WHERE room_code = upper(p_code);
  DELETE FROM paint_game_states WHERE room_code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'La partie de peinture peut recommencer'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION restart_athlete_race(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_players JSONB;
  v_player_count INTEGER;
  v_state JSONB;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Seul le chef de salle peut relancer la course');
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'athletes' AND status = 'playing';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La course n’est pas en cours');
  END IF;

  SELECT
    jsonb_agg(
      jsonb_build_object(
        'seat', seat,
        'pseudo', pseudo,
        'athlete', athlete_id,
        'position', 0,
        'finishRank', NULL,
        'bronze', 0
      ) ORDER BY seat
    ),
    count(*)::INTEGER
  INTO v_players, v_player_count
  FROM room_players
  WHERE room_code = upper(p_code);

  IF v_player_count NOT BETWEEN 2 AND 4 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La course nécessite de 2 à 4 joueurs');
  END IF;

  IF EXISTS (
    SELECT 1
    FROM room_players
    WHERE room_code = upper(p_code)
      AND athlete_id NOT IN ('genie', 'cinquieme-roue', 'slime', 'docteur-fusee', 'tremplin-devin')
  ) OR EXISTS (
    SELECT 1
    FROM room_players
    WHERE room_code = upper(p_code) AND athlete_id IS NULL
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Chaque joueur doit avoir choisi un athlète');
  END IF;

  v_state := jsonb_build_object(
    'phase', 'playing',
    'turnSeat', (v_players->0->>'seat')::INTEGER,
    'racers', v_players,
    'events', jsonb_build_array('La nouvelle course commence !'),
    'revision', 1
  );

  INSERT INTO athlete_races(room_code, state)
  VALUES (upper(p_code), v_state)
  ON CONFLICT (room_code)
  DO UPDATE SET state = EXCLUDED.state, updated_at = now();

  RETURN jsonb_build_object('success', TRUE, 'message', 'Nouvelle course prête', 'state', v_state);
END;
$$;

CREATE OR REPLACE FUNCTION restart_mystery_game(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_success BOOLEAN;
  v_message TEXT;
BEGIN
  v_seat := mystery_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Seul le chef de salle peut relancer le jeu');
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND game_type = 'mystery' AND status = 'playing';
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La partie n’est pas en cours');
  END IF;

  DELETE FROM mystery_events WHERE room_code = upper(p_code);
  DELETE FROM mystery_games WHERE room_code = upper(p_code);
  UPDATE rooms SET status = 'lobby' WHERE code = upper(p_code);

  SELECT result.success, result.message
  INTO v_success, v_message
  FROM start_mystery_game(p_code, p_token) AS result(success, message);

  IF v_success IS DISTINCT FROM TRUE THEN
    RETURN jsonb_build_object('success', FALSE, 'message', COALESCE(v_message, 'Impossible de relancer Dessin Mystère'));
  END IF;

  RETURN jsonb_build_object('success', TRUE, 'message', 'Nouvelle partie prête');
END;
$$;
