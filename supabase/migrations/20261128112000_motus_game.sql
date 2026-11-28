CREATE OR REPLACE FUNCTION motus_normalize_word(p_word TEXT)
RETURNS TEXT
LANGUAGE SQL
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT translate(
    lower(regexp_replace(COALESCE(p_word, ''), U&'[\0300-\036f]', '', 'g')),
    'àáâäãåèéêëìíîïòóôöõùúûüýÿçñ',
    'aaaaaaeeeeiiiiooooouuuuyycn'
  );
$$;

CREATE OR REPLACE FUNCTION motus_word_feedback(p_target TEXT, p_guess TEXT)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_target TEXT := motus_normalize_word(p_target);
  v_guess TEXT := motus_normalize_word(p_guess);
  v_letters TEXT[];
  v_remaining TEXT[];
  v_feedback TEXT[];
  v_length INTEGER;
  v_index INTEGER;
  v_match_index INTEGER;
BEGIN
  v_length := char_length(v_target);
  IF v_length = 0 OR char_length(v_guess) <> v_length THEN
    RAISE EXCEPTION 'Les mots doivent avoir la même longueur';
  END IF;

  v_letters := string_to_array(v_guess, NULL);
  v_remaining := string_to_array(v_target, NULL);
  v_feedback := array_fill('absent'::TEXT, ARRAY[v_length]);

  FOR v_index IN 1..v_length LOOP
    IF v_letters[v_index] = v_remaining[v_index] THEN
      v_feedback[v_index] := 'correct';
      v_remaining[v_index] := NULL;
    END IF;
  END LOOP;

  FOR v_index IN 1..v_length LOOP
    IF v_feedback[v_index] <> 'correct' THEN
      v_match_index := array_position(v_remaining, v_letters[v_index]);
      IF v_match_index IS NOT NULL THEN
        v_feedback[v_index] := 'present';
        v_remaining[v_match_index] := NULL;
      END IF;
    END IF;
  END LOOP;

  RETURN v_feedback;
END;
$$;

CREATE OR REPLACE FUNCTION motus_generate_words()
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_words TEXT[];
BEGIN
  SELECT array_agg(selected.word ORDER BY selected.rng)
  INTO v_words
  FROM (
    SELECT word, random() AS rng
    FROM motus_word_bank
    ORDER BY rng
    LIMIT 15
  ) AS selected;

  IF COALESCE(cardinality(v_words), 0) <> 15 THEN
    RAISE EXCEPTION 'Le dictionnaire MOTUS ne contient pas assez de mots';
  END IF;
  RETURN v_words;
END;
$$;

CREATE TABLE motus_games (
  room_code TEXT PRIMARY KEY REFERENCES rooms(code) ON DELETE CASCADE,
  words TEXT[] NOT NULL CHECK (cardinality(words) = 15),
  phase TEXT NOT NULL DEFAULT 'playing' CHECK (phase IN ('playing', 'finished')),
  started_at TIMESTAMPTZ NOT NULL,
  deadline TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ
);

CREATE TABLE motus_player_states (
  room_code TEXT NOT NULL REFERENCES motus_games(room_code) ON DELETE CASCADE,
  seat INTEGER NOT NULL,
  word_index INTEGER NOT NULL DEFAULT 1 CHECK (word_index BETWEEN 1 AND 16),
  words_found INTEGER NOT NULL DEFAULT 0 CHECK (words_found BETWEEN 0 AND 15),
  attempts JSONB NOT NULL DEFAULT '[]'::JSONB CHECK (jsonb_typeof(attempts) = 'array'),
  PRIMARY KEY (room_code, seat)
);

CREATE TABLE motus_public_scores (
  room_code TEXT NOT NULL REFERENCES motus_games(room_code) ON DELETE CASCADE,
  seat INTEGER NOT NULL,
  pseudo TEXT NOT NULL,
  words_found INTEGER NOT NULL DEFAULT 0 CHECK (words_found BETWEEN 0 AND 15),
  PRIMARY KEY (room_code, seat)
);

ALTER TABLE motus_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE motus_player_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE motus_public_scores ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON motus_games, motus_player_states, motus_public_scores FROM PUBLIC, anon, authenticated;
GRANT SELECT ON motus_public_scores TO anon, authenticated;

CREATE POLICY motus_public_scores_read
  ON motus_public_scores FOR SELECT TO anon, authenticated USING (TRUE);

ALTER TABLE motus_public_scores REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE motus_public_scores;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_game_type_check;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_game_type_check
  CHECK (game_type IN ('athletes', 'paint', 'portrait', 'mystery', 'motus'));

CREATE OR REPLACE FUNCTION set_room_game(
  p_code TEXT,
  p_token TEXT,
  p_game_type TEXT
)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
BEGIN
  v_seat := room_player_seat(p_code, p_token);

  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut choisir le jeu'::TEXT;
    RETURN;
  END IF;

  IF p_game_type IS NULL OR p_game_type NOT IN ('athletes', 'paint', 'portrait', 'mystery', 'motus') THEN
    RETURN QUERY SELECT FALSE, 'Ce jeu n''existe pas'::TEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND status = 'lobby'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Le jeu ne peut plus être modifié'::TEXT;
    RETURN;
  END IF;

  UPDATE rooms SET game_type = p_game_type WHERE code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'Jeu choisi'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION join_room(p_code TEXT, p_pseudo TEXT)
RETURNS TABLE (code TEXT, token TEXT, pseudo TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_token TEXT := encode(gen_random_bytes(32), 'hex');
BEGIN
  IF p_pseudo IS NULL OR length(btrim(p_pseudo)) NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'Le pseudo doit contenir entre 1 et 24 caractères';
  END IF;

  PERFORM 1
  FROM public.rooms AS room
  WHERE room.code = upper(p_code)
    AND (room.game_type <> 'mystery' OR room.status = 'lobby')
    AND (
      room.game_type <> 'motus'
      OR room.status = 'lobby'
      OR EXISTS (
        SELECT 1
        FROM motus_games AS game
        WHERE game.room_code = room.code
          AND game.phase = 'playing'
          AND game.deadline > clock_timestamp()
      )
    )
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Cette salle n’existe pas ou la partie a déjà commencé';
  END IF;

  SELECT COALESCE(MAX(player.seat), -1) + 1 INTO v_seat
  FROM public.room_players AS player
  WHERE player.room_code = upper(p_code);

  IF v_seat >= 4 THEN
    RAISE EXCEPTION 'La salle est complète';
  END IF;

  INSERT INTO public.room_players (room_code, pseudo, seat, token_hash)
  VALUES (upper(p_code), btrim(p_pseudo), v_seat, encode(digest(v_token, 'sha256'), 'hex'));

  RETURN QUERY SELECT upper(p_code), v_token, btrim(p_pseudo);
END;
$$;

CREATE OR REPLACE FUNCTION start_room(p_code TEXT, p_token TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_game_type TEXT;
BEGIN
  v_seat := room_player_seat(p_code, p_token);

  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut commencer la partie'::TEXT;
    RETURN;
  END IF;

  SELECT game_type INTO v_game_type
  FROM rooms
  WHERE code = upper(p_code) AND status = 'lobby'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Cette salle n''est pas dans son état initial'::TEXT;
    RETURN;
  END IF;

  IF v_game_type IN ('mystery', 'motus') THEN
    RETURN QUERY SELECT FALSE, 'Ce jeu doit être démarré via son RPC sécurisé'::TEXT;
    RETURN;
  END IF;

  IF (SELECT count(*) FROM room_players WHERE room_code = upper(p_code)) < 2 THEN
    RETURN QUERY SELECT FALSE, 'Il faut au moins 2 joueurs pour commencer la partie'::TEXT;
    RETURN;
  END IF;

  UPDATE rooms SET status = 'playing' WHERE code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'La partie a commencé'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION motus_finish_expired_game(p_code TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  UPDATE motus_games
  SET phase = 'finished', finished_at = clock_timestamp()
  WHERE room_code = upper(p_code)
    AND phase = 'playing'
    AND clock_timestamp() >= deadline;

  IF FOUND THEN
    UPDATE rooms
    SET status = 'finished'
    WHERE code = upper(p_code) AND game_type = 'motus' AND status = 'playing';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION start_motus_game(p_code TEXT, p_token TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_words TEXT[];
  v_player_count INTEGER;
  v_started_at TIMESTAMPTZ;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut commencer MOTUS'::TEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND status = 'lobby' AND game_type = 'motus'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Cette salle n''est pas prête pour MOTUS'::TEXT;
    RETURN;
  END IF;

  SELECT count(*)::INTEGER INTO v_player_count
  FROM room_players
  WHERE room_code = upper(p_code);
  IF v_player_count NOT BETWEEN 2 AND 4 THEN
    RETURN QUERY SELECT FALSE, 'MOTUS nécessite de 2 à 4 joueurs'::TEXT;
    RETURN;
  END IF;

  v_words := motus_generate_words();

  v_started_at := clock_timestamp();
  INSERT INTO motus_games (room_code, words, started_at, deadline)
  VALUES (upper(p_code), v_words, v_started_at, v_started_at + INTERVAL '120 seconds');

  INSERT INTO motus_player_states (room_code, seat)
  SELECT upper(p_code), seat
  FROM room_players
  WHERE room_code = upper(p_code);

  INSERT INTO motus_public_scores (room_code, seat, pseudo, words_found)
  SELECT upper(p_code), seat, pseudo, 0
  FROM room_players
  WHERE room_code = upper(p_code);

  UPDATE rooms SET status = 'playing' WHERE code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'La partie MOTUS a commencé'::TEXT;
EXCEPTION
  WHEN unique_violation THEN
    RETURN QUERY SELECT FALSE, 'Une partie MOTUS est déjà en cours dans cette salle'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION get_motus_state(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_game motus_games%ROWTYPE;
  v_player motus_player_states%ROWTYPE;
  v_state JSONB;
  v_scores JSONB;
  v_recap JSONB := '[]'::JSONB;
  v_last_reached INTEGER;
  v_target TEXT;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN
    RAISE EXCEPTION 'Accès refusé à cette salle';
  END IF;

  PERFORM motus_finish_expired_game(p_code);

  SELECT * INTO v_game
  FROM motus_games
  WHERE room_code = upper(p_code)
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'La partie MOTUS est introuvable';
  END IF;

  IF v_game.phase = 'playing' AND clock_timestamp() >= v_game.deadline THEN
    PERFORM motus_finish_expired_game(p_code);
    SELECT * INTO v_game
    FROM motus_games
    WHERE room_code = upper(p_code);
  END IF;

  INSERT INTO motus_player_states (room_code, seat)
  SELECT upper(p_code), v_seat
  WHERE NOT EXISTS (
    SELECT 1 FROM motus_player_states
    WHERE room_code = upper(p_code) AND seat = v_seat
  )
  ON CONFLICT (room_code, seat) DO NOTHING;

  INSERT INTO motus_public_scores (room_code, seat, pseudo, words_found)
  SELECT player.room_code, player.seat, player.pseudo, 0
  FROM room_players AS player
  WHERE player.room_code = upper(p_code) AND player.seat = v_seat
  ON CONFLICT (room_code, seat) DO NOTHING;

  SELECT * INTO v_player
  FROM motus_player_states
  WHERE room_code = upper(p_code) AND seat = v_seat;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Vous ne participez pas à cette partie';
  END IF;

  SELECT COALESCE(
    jsonb_agg(jsonb_build_object(
      'seat', seat,
      'pseudo', pseudo,
      'wordsFound', words_found
    ) ORDER BY seat),
    '[]'::JSONB
  )
  INTO v_scores
  FROM motus_public_scores
  WHERE room_code = upper(p_code);

  IF v_game.phase = 'finished' THEN
    SELECT LEAST(COALESCE(MAX(word_index), 1), 15)
    INTO v_last_reached
    FROM motus_player_states
    WHERE room_code = upper(p_code);

    SELECT COALESCE(jsonb_agg(v_game.words[series.index] ORDER BY series.index), '[]'::JSONB)
    INTO v_recap
    FROM generate_series(1, v_last_reached) AS series(index);
  ELSE
    v_target := v_game.words[v_player.word_index];
  END IF;

  SELECT jsonb_build_object(
    'roomCode', v_game.room_code,
    'mySeat', v_seat,
    'phase', v_game.phase,
    'startedAt', v_game.started_at,
    'deadline', v_game.deadline,
    'serverNow', clock_timestamp(),
    'wordIndex', v_player.word_index,
    'wordsFound', v_player.words_found,
    'wordLength', CASE WHEN v_game.phase = 'playing' THEN char_length(v_target) ELSE NULL END,
    'firstLetter', CASE WHEN v_game.phase = 'playing' THEN left(v_target, 1) ELSE NULL END,
    'attempts', v_player.attempts,
    'scores', v_scores,
    'recapWords', v_recap
  )
  INTO v_state;

  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION submit_motus_guess(p_code TEXT, p_token TEXT, p_guess TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_game motus_games%ROWTYPE;
  v_player motus_player_states%ROWTYPE;
  v_target TEXT;
  v_target_normalized TEXT;
  v_guess_normalized TEXT;
  v_feedback TEXT[];
  v_length INTEGER;
  v_found BOOLEAN;
  v_attempt JSONB;
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
    RETURN jsonb_build_object('success', FALSE, 'message', 'Le temps est écoulé');
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
    RETURN jsonb_build_object('success', FALSE, 'message', 'Vous avez déjà trouvé les 15 mots');
  END IF;

  v_target := v_game.words[v_player.word_index];
  v_target_normalized := motus_normalize_word(v_target);
  v_guess_normalized := motus_normalize_word(p_guess);
  v_length := char_length(v_target_normalized);

  IF p_guess IS NULL OR p_guess !~ '^[[:alpha:]]+$'
    OR char_length(v_guess_normalized) <> v_length THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La proposition doit contenir exactement le bon nombre de lettres');
  END IF;
  IF left(v_guess_normalized, 1) <> left(v_target_normalized, 1) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La première lettre est imposée');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM motus_word_bank
    WHERE normalized = v_guess_normalized
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Ce mot ne figure pas dans le dictionnaire français');
  END IF;

  v_feedback := motus_word_feedback(v_target_normalized, v_guess_normalized);

  v_found := v_guess_normalized = v_target_normalized;
  v_attempt := jsonb_build_object(
    'wordIndex', v_player.word_index,
    'guess', upper(btrim(p_guess)),
    'feedback', to_jsonb(v_feedback),
    'found', v_found,
    'submittedAt', clock_timestamp()
  );

  UPDATE motus_player_states
  SET word_index = word_index + CASE WHEN v_found THEN 1 ELSE 0 END,
      words_found = words_found + CASE WHEN v_found THEN 1 ELSE 0 END,
      attempts = attempts || jsonb_build_array(v_attempt)
  WHERE room_code = upper(p_code) AND seat = v_seat;

  IF v_found THEN
    UPDATE motus_public_scores
    SET words_found = words_found + 1
    WHERE room_code = upper(p_code) AND seat = v_seat;
  END IF;

  RETURN jsonb_build_object(
    'success', TRUE,
    'found', v_found,
    'wordIndex', v_player.word_index,
    'feedback', to_jsonb(v_feedback),
    'message', CASE WHEN v_found THEN 'Mot trouvé !' ELSE 'Proposition enregistrée' END
  );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Proposition invalide');
END;
$$;

CREATE OR REPLACE FUNCTION return_motus_to_lobby(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_phase TEXT;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Seul le chef de salle peut retourner au lobby');
  END IF;

  SELECT phase INTO v_phase
  FROM motus_games
  WHERE room_code = upper(p_code)
  FOR UPDATE;
  IF v_phase IS DISTINCT FROM 'finished' THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La partie MOTUS n’est pas terminée');
  END IF;

  DELETE FROM motus_games WHERE room_code = upper(p_code);
  UPDATE rooms SET status = 'lobby' WHERE code = upper(p_code) AND game_type = 'motus';
  RETURN jsonb_build_object('success', TRUE, 'message', 'Retour au lobby effectué');
END;
$$;

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
  DELETE FROM motus_games WHERE room_code = upper(p_code);

  UPDATE rooms SET status = 'lobby' WHERE code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'Retour au lobby effectué'::TEXT;
END;
$$;

REVOKE EXECUTE ON FUNCTION motus_normalize_word(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION motus_word_feedback(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION motus_generate_words() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION motus_finish_expired_game(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION start_motus_game(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION get_motus_state(TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION submit_motus_guess(TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION return_motus_to_lobby(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION start_motus_game(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION get_motus_state(TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION submit_motus_guess(TEXT, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION return_motus_to_lobby(TEXT, TEXT) TO anon, authenticated;
