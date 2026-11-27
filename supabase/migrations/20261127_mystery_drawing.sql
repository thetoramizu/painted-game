CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

ALTER TABLE rooms
  DROP CONSTRAINT IF EXISTS rooms_game_type_check;

ALTER TABLE rooms
  ADD CONSTRAINT rooms_game_type_check
  CHECK (game_type IN ('athletes', 'paint', 'portrait', 'mystery'));

CREATE OR REPLACE FUNCTION set_room_game(
  p_code TEXT,
  p_pseudo TEXT,
  p_game_type TEXT
)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_game_type IS NULL OR p_game_type NOT IN ('athletes', 'paint', 'portrait', 'mystery') THEN
    RETURN QUERY SELECT FALSE, 'Ce jeu n’existe pas'::TEXT;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM room_players
    WHERE room_code = p_code AND pseudo = p_pseudo AND seat = 0
  ) THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut choisir le jeu'::TEXT;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM rooms WHERE code = p_code AND status = 'lobby') THEN
    RETURN QUERY SELECT FALSE, 'Le jeu ne peut plus être modifié'::TEXT;
    RETURN;
  END IF;

  UPDATE rooms SET game_type = p_game_type WHERE code = p_code;
  RETURN QUERY SELECT TRUE, 'Jeu choisi'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION start_room(p_code TEXT, p_pseudo TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM rooms WHERE code = p_code AND game_type = 'mystery') THEN
    RETURN QUERY SELECT FALSE, 'Démarrage Dessin Mystère refusé : utilisez le démarrage sécurisé du lobby'::TEXT;
    RETURN;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM room_players
    WHERE room_code = p_code AND pseudo = p_pseudo
  ) THEN
    RETURN QUERY SELECT FALSE, 'Vous n''êtes pas inscrit dans cette salle'::TEXT;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM room_players WHERE room_code = p_code) < 2 THEN
    RETURN QUERY SELECT FALSE, 'Il faut au moins 2 joueurs pour commencer la course'::TEXT;
    RETURN;
  END IF;
  IF (SELECT status FROM rooms WHERE code = p_code) <> 'lobby' THEN
    RETURN QUERY SELECT FALSE, 'Cette salle n''est pas dans son état initial'::TEXT;
    RETURN;
  END IF;

  UPDATE rooms SET status = 'playing' WHERE code = p_code;
  RETURN QUERY SELECT TRUE, 'La course a commencé'::TEXT;
END;
$$;

ALTER TABLE room_players
  ADD COLUMN IF NOT EXISTS token_hash TEXT;

CREATE OR REPLACE FUNCTION create_room(p_pseudo TEXT)
RETURNS TABLE (code TEXT, token TEXT, pseudo TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_code TEXT := upper(substring(md5(random()::text || clock_timestamp()::text) FROM 1 FOR 6));
  v_token TEXT := encode(gen_random_bytes(32), 'hex');
BEGIN
  IF p_pseudo IS NULL OR length(btrim(p_pseudo)) NOT BETWEEN 1 AND 24 THEN
    RAISE EXCEPTION 'Le pseudo doit contenir entre 1 et 24 caractères';
  END IF;

  INSERT INTO rooms (code, status) VALUES (v_code, 'lobby');
  INSERT INTO room_players (room_code, pseudo, seat, token_hash)
  VALUES (v_code, btrim(p_pseudo), 0, encode(digest(v_token, 'sha256'), 'hex'));

  RETURN QUERY SELECT v_code, v_token, btrim(p_pseudo);
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

CREATE TABLE mystery_word_bank (
  word TEXT PRIMARY KEY,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  CHECK (length(word) BETWEEN 2 AND 40),
  CHECK (word = lower(word))
);

INSERT INTO mystery_word_bank (word) VALUES
  ('abeille'), ('abricot'), ('accordéon'), ('aigle'), ('allumette'),
  ('ananas'), ('ancre'), ('ange'), ('araignée'), ('arc-en-ciel'),
  ('avion'), ('baleine'), ('ballon'), ('banane'), ('barque'),
  ('basilic'), ('bateau'), ('biberon'), ('bicyclette'), ('boussole'),
  ('bougie'), ('branche'), ('brocoli'), ('cabane'), ('cadeau'),
  ('cactus'), ('cahier'), ('camion'), ('canard'), ('carotte'),
  ('cascade'), ('cerise'), ('champignon'), ('chapeau'), ('chat'),
  ('chaussure'), ('cheval'), ('chocolat'), ('ciel'), ('citrouille'),
  ('clé'), ('cloche'), ('cochon'), ('coccinelle'), ('coeur'),
  ('coiffeur'), ('colibri'), ('couronne'), ('crayon'), ('crocodile'),
  ('cygne'), ('dauphin'), ('dé'), ('dent'), ('dinosaure'),
  ('drapeau'), ('écharpe'), ('échelle'), ('éléphant'), ('étoile'),
  ('fantôme'), ('fer à cheval'), ('fleur'), ('fourchette'), ('fromage'),
  ('girafe'), ('glace'), ('gâteau'), ('hibou'), ('hippopotame'),
  ('horloge'), ('igloo'), ('île'), ('jalousie'), ('jardin'),
  ('kangourou'), ('kiwi'), ('koala'), ('lampe'), ('lapin'),
  ('lave'), ('lézard'), ('libellule'), ('livre'), ('lune'),
  ('maison'), ('marteau'), ('méduse'), ('montagne'), ('moulin'),
  ('mouton'), ('musique'), ('navire'), ('nuage'), ('oiseau'),
  ('ordinateur'), ('ours'), ('papillon'), ('parapluie'), ('pastèque'),
  ('pelle'), ('piano'), ('pinceau'), ('pingouin'), ('pizza'),
  ('poisson'), ('pomme'), ('porte'), ('poussin'), ('princesse'),
  ('raquette'), ('renard'), ('requin'), ('robot'), ('rose'),
  ('sablier'), ('sandwich'), ('serpent'), ('soleil'), ('souris'),
  ('tasse'), ('téléphone'), ('tortue'), ('train'), ('trompette'),
  ('tulipe'), ('vache'), ('valise'), ('vélo'), ('violon'),
  ('volcan'), ('zèbre')
ON CONFLICT (word) DO NOTHING;

CREATE TABLE mystery_settings (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  word_choice_seconds INTEGER NOT NULL DEFAULT 15 CHECK (word_choice_seconds BETWEEN 5 AND 60),
  drawing_seconds INTEGER NOT NULL DEFAULT 60 CHECK (drawing_seconds BETWEEN 15 AND 180),
  summary_seconds INTEGER NOT NULL DEFAULT 5 CHECK (summary_seconds BETWEEN 2 AND 30),
  reconnect_grace_seconds INTEGER NOT NULL DEFAULT 60 CHECK (reconnect_grace_seconds BETWEEN 15 AND 300)
);

INSERT INTO mystery_settings (singleton) VALUES (TRUE)
ON CONFLICT (singleton) DO NOTHING;

REVOKE ALL ON mystery_word_bank, mystery_settings FROM PUBLIC, anon, authenticated;

CREATE TABLE mystery_games (
  room_code TEXT PRIMARY KEY REFERENCES rooms(code) ON DELETE CASCADE,
  players JSONB NOT NULL,
  total_rounds INTEGER NOT NULL CHECK (total_rounds BETWEEN 2 AND 4),
  round_index INTEGER NOT NULL DEFAULT 1,
  phase TEXT NOT NULL CHECK (phase IN ('choosing', 'drawing', 'summary', 'finished')),
  drawer_seat INTEGER NOT NULL,
  word_options TEXT[] NOT NULL DEFAULT '{}',
  secret_word TEXT,
  offered_words TEXT[] NOT NULL DEFAULT '{}',
  guessed_seats INTEGER[] NOT NULL DEFAULT '{}',
  drawn_seats INTEGER[] NOT NULL DEFAULT '{}',
  last_seen JSONB NOT NULL DEFAULT '{}',
  deadline TIMESTAMPTZ NOT NULL,
  revision BIGINT NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mystery_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  round_index INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('drawing', 'chat', 'found', 'system', 'summary')),
  actor_seat INTEGER,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX mystery_events_room_round_idx ON mystery_events (room_code, round_index, id);

ALTER TABLE mystery_games ENABLE ROW LEVEL SECURITY;
ALTER TABLE mystery_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON mystery_games FROM PUBLIC, anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON mystery_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON mystery_events TO anon, authenticated;

CREATE POLICY mystery_events_public_read
  ON mystery_events FOR SELECT TO anon, authenticated USING (TRUE);

ALTER TABLE mystery_events REPLICA IDENTITY FULL;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE mystery_events;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION mystery_player_seat(p_code TEXT, p_token TEXT)
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

CREATE OR REPLACE FUNCTION mystery_add_options(p_code TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_options TEXT[];
BEGIN
  SELECT array_agg(word) INTO v_options
  FROM (
    SELECT word
    FROM mystery_word_bank
    WHERE active AND NOT (word = ANY(COALESCE(
      (SELECT offered_words FROM mystery_games WHERE room_code = p_code), '{}'
    )))
    ORDER BY random()
    LIMIT 3
  ) selected_words;

  IF COALESCE(array_length(v_options, 1), 0) <> 3 THEN
    RAISE EXCEPTION 'La banque de mots ne contient pas assez de mots français inédits';
  END IF;

  UPDATE mystery_games
  SET word_options = v_options,
      offered_words = offered_words || v_options,
      deadline = now() + make_interval(secs => (
        SELECT word_choice_seconds FROM mystery_settings WHERE singleton
      )),
      revision = revision + 1
  WHERE room_code = p_code;
END;
$$;

CREATE OR REPLACE FUNCTION mystery_finish_round(p_code TEXT, p_abandoned BOOLEAN DEFAULT FALSE)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_game mystery_games%ROWTYPE;
  v_found INTEGER[];
  v_missed INTEGER[];
  v_drawn_seats INTEGER[];
  v_summary_seconds INTEGER;
BEGIN
  SELECT * INTO v_game FROM mystery_games WHERE room_code = p_code FOR UPDATE;
  IF NOT FOUND OR v_game.phase <> 'drawing' THEN RETURN; END IF;
  SELECT summary_seconds INTO v_summary_seconds FROM mystery_settings WHERE singleton;

  SELECT
    COALESCE(array_agg((player->>'seat')::INTEGER) FILTER (
      WHERE (player->>'seat')::INTEGER <> v_game.drawer_seat
        AND (player->>'seat')::INTEGER = ANY(v_game.guessed_seats)
    ), '{}'),
    COALESCE(array_agg((player->>'seat')::INTEGER) FILTER (
      WHERE (player->>'seat')::INTEGER <> v_game.drawer_seat
        AND NOT ((player->>'seat')::INTEGER = ANY(v_game.guessed_seats))
    ), '{}')
  INTO v_found, v_missed
  FROM jsonb_array_elements(v_game.players) AS players(player);

  SELECT array_agg(DISTINCT seat) INTO v_drawn_seats
  FROM unnest(v_game.drawn_seats || v_game.drawer_seat) seat;

  UPDATE mystery_games
  SET phase = 'summary',
      drawn_seats = v_drawn_seats,
      deadline = now() + make_interval(secs => v_summary_seconds),
      revision = revision + 1
  WHERE room_code = p_code;

  INSERT INTO mystery_events (room_code, round_index, kind, actor_seat, payload)
  VALUES (
    p_code, v_game.round_index, 'summary', NULL,
    jsonb_build_object(
      'word', v_game.secret_word,
      'drawerSeat', v_game.drawer_seat,
      'foundSeats', v_found,
      'missedSeats', v_missed,
      'abandoned', p_abandoned
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION mystery_advance(p_code TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_game mystery_games%ROWTYPE;
  v_next_seat INTEGER;
  v_drawing_seconds INTEGER;
  v_reconnect_grace_seconds INTEGER;
BEGIN
  SELECT * INTO v_game FROM mystery_games WHERE room_code = upper(p_code) FOR UPDATE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT drawing_seconds, reconnect_grace_seconds
  INTO v_drawing_seconds, v_reconnect_grace_seconds
  FROM mystery_settings WHERE singleton;

  IF v_game.phase = 'choosing' AND now() >= v_game.deadline THEN
    UPDATE mystery_games
    SET secret_word = word_options[1],
        phase = 'drawing',
        deadline = now() + make_interval(secs => v_drawing_seconds),
        revision = revision + 1
    WHERE room_code = p_code;
    INSERT INTO mystery_events (room_code, round_index, kind, payload)
    VALUES (p_code, v_game.round_index, 'system', jsonb_build_object('type', 'drawing_started'));
  ELSIF v_game.phase = 'drawing' THEN
    IF now() >= v_game.deadline THEN
      PERFORM mystery_finish_round(p_code, FALSE);
    ELSIF now() - COALESCE((v_game.last_seen->>v_game.drawer_seat::TEXT)::TIMESTAMPTZ, v_game.created_at)
      >= make_interval(secs => v_reconnect_grace_seconds) THEN
      PERFORM mystery_finish_round(p_code, TRUE);
    ELSIF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_game.players) AS players(player)
      WHERE (player->>'seat')::INTEGER <> v_game.drawer_seat
        AND NOT ((player->>'seat')::INTEGER = ANY(v_game.guessed_seats))
    ) THEN
      PERFORM mystery_finish_round(p_code, FALSE);
    END IF;
  ELSIF v_game.phase = 'summary' AND now() >= v_game.deadline THEN
    IF v_game.round_index >= v_game.total_rounds THEN
      UPDATE mystery_games
      SET phase = 'finished', deadline = now(), revision = revision + 1
      WHERE room_code = p_code;
      UPDATE rooms SET status = 'finished' WHERE code = p_code;
      INSERT INTO mystery_events (room_code, round_index, kind, payload)
      VALUES (p_code, v_game.round_index, 'system', jsonb_build_object('type', 'game_finished'));
    ELSE
      v_next_seat := (v_game.players->v_game.round_index->>'seat')::INTEGER;
      UPDATE mystery_games
      SET round_index = round_index + 1,
          drawer_seat = v_next_seat,
          phase = 'choosing',
          secret_word = NULL,
          guessed_seats = '{}',
          word_options = '{}',
          revision = revision + 1
      WHERE room_code = p_code;
      PERFORM mystery_add_options(p_code);
      INSERT INTO mystery_events (room_code, round_index, kind, payload)
      VALUES (
        p_code, v_game.round_index + 1, 'system',
        jsonb_build_object('type', 'round_started', 'drawerSeat', v_next_seat)
      );
    END IF;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION start_mystery_game(p_code TEXT, p_token TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_players JSONB;
  v_count INTEGER;
  v_seat INTEGER;
  v_presence JSONB := '{}';
  v_player JSONB;
  v_word_choice_seconds INTEGER;
BEGIN
  v_seat := mystery_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN QUERY SELECT FALSE, 'Seul le chef de salle peut commencer ce jeu'::TEXT;
    RETURN;
  END IF;

  PERFORM 1
  FROM rooms
  WHERE code = upper(p_code) AND status = 'lobby' AND game_type = 'mystery'
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'Cette salle n’est pas prête pour Dessin Mystère'::TEXT;
    RETURN;
  END IF;

  SELECT jsonb_agg(jsonb_build_object('seat', seat, 'pseudo', pseudo) ORDER BY seat), count(*)::INTEGER
  INTO v_players, v_count
  FROM room_players
  WHERE room_code = upper(p_code);

  IF v_count NOT BETWEEN 2 AND 4 THEN
    RETURN QUERY SELECT FALSE, 'Dessin Mystère nécessite de 2 à 4 joueurs'::TEXT;
    RETURN;
  END IF;
  IF (SELECT count(*) FROM mystery_word_bank WHERE active) < 3 * v_count THEN
    RETURN QUERY SELECT FALSE, 'La banque de mots est trop petite pour cette partie'::TEXT;
    RETURN;
  END IF;
  FOR v_player IN SELECT value FROM jsonb_array_elements(v_players)
  LOOP
    v_presence := v_presence || jsonb_build_object(v_player->>'seat', now());
  END LOOP;
  SELECT word_choice_seconds INTO v_word_choice_seconds FROM mystery_settings WHERE singleton;

  INSERT INTO mystery_games (
    room_code, players, total_rounds, phase, drawer_seat, last_seen, deadline
  ) VALUES (
    upper(p_code), v_players, v_count, 'choosing',
    (v_players->0->>'seat')::INTEGER, v_presence,
    now() + make_interval(secs => v_word_choice_seconds)
  );
  PERFORM mystery_add_options(upper(p_code));
  UPDATE rooms SET status = 'playing' WHERE code = upper(p_code);

  RETURN QUERY SELECT TRUE, 'La partie a commencé'::TEXT;
EXCEPTION WHEN unique_violation THEN
  RETURN QUERY SELECT FALSE, 'Une partie est déjà en cours dans cette salle'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION get_mystery_state(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_game mystery_games%ROWTYPE;
  v_state JSONB;
BEGIN
  v_seat := mystery_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN RAISE EXCEPTION 'Accès refusé à cette salle'; END IF;

  PERFORM mystery_advance(upper(p_code));
  UPDATE mystery_games
  SET last_seen = jsonb_set(last_seen, ARRAY[v_seat::TEXT], to_jsonb(now()), TRUE)
  WHERE room_code = upper(p_code);
  SELECT * INTO v_game FROM mystery_games WHERE room_code = upper(p_code);
  IF NOT FOUND THEN RAISE EXCEPTION 'La partie Dessin Mystère est introuvable'; END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_game.players) AS participants(player)
    WHERE (player->>'seat')::INTEGER = v_seat
  ) THEN
    RAISE EXCEPTION 'Vous ne faites pas partie de cette partie';
  END IF;

  SELECT jsonb_build_object(
    'roomCode', v_game.room_code,
    'mySeat', v_seat,
    'players', v_game.players,
    'round', v_game.round_index,
    'totalRounds', v_game.total_rounds,
    'phase', v_game.phase,
    'drawerSeat', v_game.drawer_seat,
    'deadline', v_game.deadline,
    'revision', v_game.revision,
    'guessedSeats', to_jsonb(v_game.guessed_seats),
    'drawnSeats', to_jsonb(v_game.drawn_seats),
    'wordLength', CASE
      WHEN v_game.secret_word IS NULL THEN NULL
      ELSE char_length(regexp_replace(v_game.secret_word, '[^[:alpha:]]', '', 'g'))
    END,
    'secretWord', CASE
      WHEN v_seat = v_game.drawer_seat AND v_game.phase = 'drawing' THEN v_game.secret_word
      WHEN v_game.phase IN ('summary', 'finished') THEN v_game.secret_word
      ELSE NULL
    END,
    'wordOptions', CASE
      WHEN v_seat = v_game.drawer_seat AND v_game.phase = 'choosing' THEN to_jsonb(v_game.word_options)
      ELSE '[]'::JSONB
    END,
    'events', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', id, 'roundIndex', round_index, 'kind', kind,
        'actorSeat', actor_seat, 'payload', payload
      ) ORDER BY id)
      FROM mystery_events
      WHERE room_code = v_game.room_code
        AND (kind <> 'drawing' OR round_index = v_game.round_index)
    ), '[]'::JSONB)
  ) INTO v_state;

  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION choose_mystery_word(p_code TEXT, p_token TEXT, p_word TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_game mystery_games%ROWTYPE;
  v_drawing_seconds INTEGER;
BEGIN
  v_seat := mystery_player_seat(p_code, p_token);
  PERFORM mystery_advance(upper(p_code));
  SELECT * INTO v_game FROM mystery_games WHERE room_code = upper(p_code) FOR UPDATE;
  IF v_seat IS DISTINCT FROM v_game.drawer_seat OR v_game.phase <> 'choosing' THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Vous ne pouvez pas choisir le mot de cette manche');
  END IF;
  IF now() >= v_game.deadline THEN
    PERFORM mystery_advance(upper(p_code));
    RETURN jsonb_build_object('success', TRUE, 'message', 'Le délai est écoulé; le mot a été choisi automatiquement');
  END IF;
  IF NOT (p_word = ANY(v_game.word_options)) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Ce mot ne fait pas partie des propositions');
  END IF;
  SELECT drawing_seconds INTO v_drawing_seconds FROM mystery_settings WHERE singleton;

  UPDATE mystery_games
  SET secret_word = p_word, phase = 'drawing',
      deadline = now() + make_interval(secs => v_drawing_seconds),
      last_seen = jsonb_set(last_seen, ARRAY[v_seat::TEXT], to_jsonb(now()), TRUE),
      revision = revision + 1
  WHERE room_code = upper(p_code);
  INSERT INTO mystery_events (room_code, round_index, kind, payload)
  VALUES (upper(p_code), v_game.round_index, 'system', jsonb_build_object('type', 'drawing_started'));
  RETURN jsonb_build_object('success', TRUE, 'message', 'Mot choisi');
END;
$$;

CREATE OR REPLACE FUNCTION add_mystery_drawing_event(
  p_code TEXT,
  p_token TEXT,
  p_kind TEXT,
  p_payload JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_game mystery_games%ROWTYPE;
  v_point JSONB;
BEGIN
  v_seat := mystery_player_seat(p_code, p_token);
  PERFORM mystery_advance(upper(p_code));
  SELECT * INTO v_game FROM mystery_games WHERE room_code = upper(p_code) FOR UPDATE;
  IF v_seat IS DISTINCT FROM v_game.drawer_seat OR v_game.phase <> 'drawing' OR now() >= v_game.deadline THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Seul le dessinateur actif peut dessiner');
  END IF;
  IF jsonb_typeof(p_payload) <> 'object' OR octet_length(p_payload::TEXT) > 32768 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Événement de dessin invalide');
  END IF;
  IF p_kind NOT IN ('begin', 'points', 'end', 'fill', 'undo', 'redo', 'clear') THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Outil de dessin invalide');
  END IF;
  IF p_kind IN ('begin', 'fill') AND COALESCE(p_payload->>'color', '') !~ '^#[0-9A-Fa-f]{6}$' THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Couleur invalide');
  END IF;
  IF p_kind = 'begin' AND (
    COALESCE(p_payload->>'tool', '') NOT IN ('brush', 'eraser')
    OR COALESCE((p_payload->>'size')::INTEGER, 0) NOT BETWEEN 1 AND 48
    OR COALESCE((p_payload->>'x')::NUMERIC, -1) NOT BETWEEN 0 AND 1
    OR COALESCE((p_payload->>'y')::NUMERIC, -1) NOT BETWEEN 0 AND 1
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Paramètres du trait invalides');
  END IF;
  IF p_kind = 'fill' AND (
    COALESCE((p_payload->>'x')::NUMERIC, -1) NOT BETWEEN 0 AND 1
    OR COALESCE((p_payload->>'y')::NUMERIC, -1) NOT BETWEEN 0 AND 1
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Coordonnées hors de la toile');
  END IF;
  IF p_kind = 'points' THEN
    IF jsonb_typeof(p_payload->'points') IS DISTINCT FROM 'array'
      OR jsonb_array_length(p_payload->'points') NOT BETWEEN 1 AND 64 THEN
      RETURN jsonb_build_object('success', FALSE, 'message', 'Coordonnées invalides');
    END IF;
    FOR v_point IN SELECT value FROM jsonb_array_elements(p_payload->'points')
    LOOP
      IF COALESCE((v_point->>'x')::NUMERIC, -1) NOT BETWEEN 0 AND 1
        OR COALESCE((v_point->>'y')::NUMERIC, -1) NOT BETWEEN 0 AND 1 THEN
        RETURN jsonb_build_object('success', FALSE, 'message', 'Coordonnées hors de la toile');
      END IF;
    END LOOP;
  END IF;

  UPDATE mystery_games
  SET last_seen = jsonb_set(last_seen, ARRAY[v_seat::TEXT], to_jsonb(now()), TRUE)
  WHERE room_code = upper(p_code);
  INSERT INTO mystery_events (room_code, round_index, kind, actor_seat, payload)
  VALUES (upper(p_code), v_game.round_index, 'drawing', v_seat,
          jsonb_build_object('operation', p_kind, 'data', p_payload));
  RETURN jsonb_build_object('success', TRUE);
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
  RETURN jsonb_build_object('success', FALSE, 'message', 'Paramètres de dessin invalides');
END;
$$;

REVOKE EXECUTE ON FUNCTION mystery_player_seat(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION mystery_add_options(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION mystery_finish_round(TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION mystery_advance(TEXT) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION submit_mystery_guess(p_code TEXT, p_token TEXT, p_guess TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_game mystery_games%ROWTYPE;
  v_pseudo TEXT;
  v_guess_normalized TEXT;
  v_word_normalized TEXT;
  v_found BOOLEAN;
BEGIN
  v_seat := mystery_player_seat(p_code, p_token);
  PERFORM mystery_advance(upper(p_code));
  SELECT * INTO v_game FROM mystery_games WHERE room_code = upper(p_code) FOR UPDATE;
  IF v_seat IS NULL OR v_game.phase <> 'drawing' OR v_seat = v_game.drawer_seat
    OR v_seat = ANY(v_game.guessed_seats) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Vous ne pouvez pas proposer de réponse pour cette manche');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_game.players) AS participants(player)
    WHERE (player->>'seat')::INTEGER = v_seat
  ) THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Vous ne participez pas à cette partie');
  END IF;
  IF p_guess IS NULL OR length(btrim(p_guess)) = 0 OR length(p_guess) > 80 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Saisissez une réponse courte');
  END IF;

  v_guess_normalized := translate(lower(btrim(p_guess)),
    'àáâäãåèéêëìíîïòóôöõùúûüýÿç',
    'aaaaaaeeeeiiiiooooouuuuyyc');
  v_guess_normalized := replace(replace(v_guess_normalized, 'œ', 'oe'), 'æ', 'ae');
  v_guess_normalized := regexp_replace(v_guess_normalized, '[^[:alnum:]]', '', 'g');
  v_word_normalized := translate(lower(btrim(v_game.secret_word)),
    'àáâäãåèéêëìíîïòóôöõùúûüýÿç',
    'aaaaaaeeeeiiiiooooouuuuyyc');
  v_word_normalized := replace(replace(v_word_normalized, 'œ', 'oe'), 'æ', 'ae');
  v_word_normalized := regexp_replace(v_word_normalized, '[^[:alnum:]]', '', 'g');
  v_found := v_guess_normalized = v_word_normalized;

  SELECT pseudo INTO v_pseudo FROM room_players WHERE room_code = upper(p_code) AND seat = v_seat;
  UPDATE mystery_games
  SET last_seen = jsonb_set(last_seen, ARRAY[v_seat::TEXT], to_jsonb(now()), TRUE),
      guessed_seats = CASE WHEN v_found THEN array_append(guessed_seats, v_seat) ELSE guessed_seats END,
      revision = revision + 1
  WHERE room_code = upper(p_code);

  IF v_found THEN
    INSERT INTO mystery_events (room_code, round_index, kind, actor_seat, payload)
    VALUES (upper(p_code), v_game.round_index, 'found', v_seat, jsonb_build_object('pseudo', v_pseudo));
    PERFORM mystery_advance(upper(p_code));
    RETURN jsonb_build_object('success', TRUE, 'found', TRUE, 'message', 'Vous avez trouvé le mot !');
  END IF;

  INSERT INTO mystery_events (room_code, round_index, kind, actor_seat, payload)
  VALUES (
    upper(p_code), v_game.round_index, 'chat', v_seat,
    jsonb_build_object('pseudo', v_pseudo, 'text', btrim(p_guess))
  );
  RETURN jsonb_build_object('success', TRUE, 'found', FALSE, 'message', 'Réponse envoyée');
END;
$$;

CREATE OR REPLACE FUNCTION mystery_heartbeat(p_code TEXT, p_token TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
BEGIN
  v_seat := mystery_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN RAISE EXCEPTION 'Accès refusé à cette salle'; END IF;
  UPDATE mystery_games
  SET last_seen = jsonb_set(last_seen, ARRAY[v_seat::TEXT], to_jsonb(now()), TRUE)
  WHERE room_code = upper(p_code);
  PERFORM mystery_advance(upper(p_code));
END;
$$;

CREATE OR REPLACE FUNCTION return_mystery_to_lobby(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_phase TEXT;
BEGIN
  v_seat := mystery_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'Seul le chef de salle peut retourner au lobby');
  END IF;
  SELECT phase INTO v_phase FROM mystery_games WHERE room_code = upper(p_code) FOR UPDATE;
  IF v_phase IS DISTINCT FROM 'finished' THEN
    RETURN jsonb_build_object('success', FALSE, 'message', 'La partie n’est pas encore terminée');
  END IF;

  DELETE FROM mystery_events WHERE room_code = upper(p_code);
  DELETE FROM mystery_games WHERE room_code = upper(p_code);
  UPDATE rooms SET status = 'lobby' WHERE code = upper(p_code);
  RETURN jsonb_build_object('success', TRUE, 'message', 'Retour au lobby');
END;
$$;
