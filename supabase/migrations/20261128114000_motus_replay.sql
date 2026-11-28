CREATE OR REPLACE FUNCTION restart_motus_game(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_phase TEXT;
  v_player_count INTEGER;
  v_words TEXT[];
  v_started_at TIMESTAMPTZ;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Seul le chef de salle peut relancer MOTUS');
  END IF;

  SELECT phase INTO v_phase
  FROM motus_games
  WHERE room_code = upper(p_code)
  FOR UPDATE;
  IF v_phase IS DISTINCT FROM 'finished' THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La partie MOTUS n’est pas terminée');
  END IF;

  SELECT count(*)::INTEGER INTO v_player_count
  FROM room_players
  WHERE room_code = upper(p_code);
  IF v_player_count NOT BETWEEN 2 AND 4 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'MOTUS nécessite de 2 à 4 joueurs');
  END IF;

  v_words := motus_generate_words();
  v_started_at := clock_timestamp();

  DELETE FROM motus_player_states WHERE room_code = upper(p_code);
  DELETE FROM motus_public_scores WHERE room_code = upper(p_code);

  UPDATE motus_games
  SET words = v_words,
      phase = 'playing',
      started_at = v_started_at,
      deadline = v_started_at + INTERVAL '120 seconds',
      finished_at = NULL
  WHERE room_code = upper(p_code);

  INSERT INTO motus_player_states (room_code, seat)
  SELECT upper(p_code), seat
  FROM room_players
  WHERE room_code = upper(p_code);

  INSERT INTO motus_public_scores (room_code, seat, pseudo, words_found)
  SELECT upper(p_code), seat, pseudo, 0
  FROM room_players
  WHERE room_code = upper(p_code);

  UPDATE rooms
  SET status = 'playing'
  WHERE code = upper(p_code) AND game_type = 'motus' AND status = 'finished';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La salle MOTUS n’est pas terminée';
  END IF;

  RETURN jsonb_build_object('success', TRUE, 'message', 'Nouvelle partie MOTUS lancée');
END;
$$;

REVOKE EXECUTE ON FUNCTION restart_motus_game(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restart_motus_game(TEXT, TEXT) TO anon, authenticated;
