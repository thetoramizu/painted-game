CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE OR REPLACE FUNCTION room_player_seat(p_code TEXT, p_token TEXT)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT seat
  FROM room_players
  WHERE room_code = upper(p_code)
    AND token_hash = encode(digest(p_token, 'sha256'), 'hex')
  LIMIT 1;
$$;

DROP FUNCTION IF EXISTS get_room(TEXT, TEXT);

CREATE OR REPLACE FUNCTION get_room(p_code TEXT, p_token TEXT)
RETURNS TABLE (
  code TEXT,
  status TEXT,
  "mySeat" INTEGER,
  "gameType" TEXT,
  players JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH participant AS (
    SELECT room_player_seat(p_code, p_token) AS seat
  )
  SELECT
    r.code,
    r.status,
    participant.seat,
    r.game_type,
    COALESCE(
      jsonb_agg(
        jsonb_build_object(
          'pseudo', rp.pseudo,
          'seat', rp.seat,
          'athleteId', rp.athlete_id
        ) ORDER BY rp.seat
      ) FILTER (WHERE rp.seat IS NOT NULL),
      '[]'::jsonb
    )
  FROM rooms r
  CROSS JOIN participant
  LEFT JOIN room_players rp ON rp.room_code = r.code
  WHERE r.code = upper(p_code)
    AND participant.seat IS NOT NULL
  GROUP BY r.code, r.status, r.game_type, participant.seat;
$$;

DROP FUNCTION IF EXISTS set_room_game(TEXT, TEXT, TEXT);

CREATE FUNCTION set_room_game(
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

  IF p_game_type IS NULL OR p_game_type NOT IN ('athletes', 'paint', 'portrait', 'mystery') THEN
    RETURN QUERY SELECT FALSE, 'Ce jeu n''existe pas'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rooms
    WHERE code = upper(p_code) AND status = 'lobby'
  ) THEN
    RETURN QUERY SELECT FALSE, 'Le jeu ne peut plus être modifié'::TEXT;
    RETURN;
  END IF;

  UPDATE rooms SET game_type = p_game_type WHERE code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'Jeu choisi'::TEXT;
END;
$$;

DROP FUNCTION IF EXISTS start_room(TEXT, TEXT);

CREATE FUNCTION start_room(p_code TEXT, p_token TEXT)
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
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut commencer la partie'::TEXT;
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM rooms
    WHERE code = upper(p_code) AND game_type = 'mystery'
  ) THEN
    RETURN QUERY SELECT FALSE, 'Démarrage Dessin Mystère refusé : utilisez le démarrage sécurisé du lobby'::TEXT;
    RETURN;
  END IF;

  IF (SELECT count(*) FROM room_players WHERE room_code = upper(p_code)) < 2 THEN
    RETURN QUERY SELECT FALSE, 'Il faut au moins 2 joueurs pour commencer la partie'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rooms
    WHERE code = upper(p_code) AND status = 'lobby'
  ) THEN
    RETURN QUERY SELECT FALSE, 'Cette salle n''est pas dans son état initial'::TEXT;
    RETURN;
  END IF;

  UPDATE rooms SET status = 'playing' WHERE code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'La partie a commencé'::TEXT;
END;
$$;

DROP FUNCTION IF EXISTS set_pick(TEXT, INTEGER, TEXT);

CREATE FUNCTION set_pick(
  p_code TEXT,
  p_token TEXT,
  p_seat INTEGER,
  p_athlete_id TEXT
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

  IF v_seat IS NULL THEN
    RETURN QUERY SELECT FALSE, 'Accès refusé à cette salle'::TEXT;
    RETURN;
  END IF;

  IF v_seat <> p_seat THEN
    RETURN QUERY SELECT FALSE, 'Vous ne pouvez modifier que votre propre choix'::TEXT;
    RETURN;
  END IF;

  UPDATE room_players
  SET athlete_id = p_athlete_id
  WHERE room_code = upper(p_code) AND seat = v_seat;

  RETURN QUERY SELECT TRUE, 'Choix enregistré'::TEXT;
END;
$$;

DROP FUNCTION IF EXISTS finish_paint_game(TEXT, TEXT);

CREATE FUNCTION finish_paint_game(p_code TEXT, p_token TEXT)
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
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut terminer la partie'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM rooms
    WHERE code = upper(p_code) AND game_type = 'paint' AND status = 'playing'
  ) THEN
    RETURN QUERY SELECT FALSE, 'Aucune partie de peinture n''est en cours'::TEXT;
    RETURN;
  END IF;

  DELETE FROM paint_strokes WHERE room_code = upper(p_code);
  UPDATE rooms SET status = 'lobby' WHERE code = upper(p_code);
  RETURN QUERY SELECT TRUE, 'Partie terminée et toile effacée'::TEXT;
END;
$$;
