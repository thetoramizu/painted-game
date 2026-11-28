CREATE OR REPLACE FUNCTION motus_reset_attempts_after_advance()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.word_index > OLD.word_index THEN
    NEW.attempts := '[]'::JSONB;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS motus_reset_attempts_after_advance ON motus_player_states;
CREATE TRIGGER motus_reset_attempts_after_advance
BEFORE UPDATE OF word_index ON motus_player_states
FOR EACH ROW
EXECUTE FUNCTION motus_reset_attempts_after_advance();

REVOKE EXECUTE ON FUNCTION motus_reset_attempts_after_advance() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION skip_motus_word(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_game motus_games%ROWTYPE;
  v_player motus_player_states%ROWTYPE;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Accès refusé à cette salle');
  END IF;

  PERFORM motus_finish_expired_game(p_code);

  SELECT * INTO v_game
  FROM motus_games
  WHERE room_code = upper(p_code)
  FOR UPDATE;
  IF NOT FOUND OR v_game.phase <> 'playing' THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La partie est terminée');
  END IF;
  IF clock_timestamp() >= v_game.deadline THEN
    PERFORM motus_finish_expired_game(p_code);
    RETURN jsonb_build_object('success', FALSE, 'message', 'Le temps est écoulé');
  END IF;

  SELECT * INTO v_player
  FROM motus_player_states
  WHERE room_code = upper(p_code) AND seat = v_seat
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Vous ne participez pas à cette partie');
  END IF;
  IF v_player.word_index > 15 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Vous avez terminé les 15 mots');
  END IF;

  UPDATE motus_player_states
  SET word_index = word_index + 1
  WHERE room_code = upper(p_code) AND seat = v_seat;

  RETURN jsonb_build_object(
    'success', TRUE,
    'wordIndex', v_player.word_index + 1,
    'message', 'Mot passé. Il ne comptera pas comme trouvé.'
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION skip_motus_word(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION skip_motus_word(TEXT, TEXT) TO anon, authenticated;
