CREATE TABLE IF NOT EXISTS athlete_races (
  room_code TEXT PRIMARY KEY REFERENCES rooms(code) ON DELETE CASCADE,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE athlete_races ENABLE ROW LEVEL SECURITY;
ALTER TABLE athlete_races REPLICA IDENTITY FULL;

DROP POLICY IF EXISTS athlete_races_read ON athlete_races;
CREATE POLICY athlete_races_read
  ON athlete_races FOR SELECT TO anon, authenticated USING (TRUE);

GRANT SELECT ON athlete_races TO anon, authenticated;
REVOKE INSERT, UPDATE, DELETE ON athlete_races FROM anon, authenticated;

DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE athlete_races;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION get_athlete_race(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
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

  SELECT race.state INTO v_state
  FROM athlete_races AS race
  WHERE race.room_code = upper(p_code);

  IF v_state IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_state->'racers') AS racer(value)
    WHERE (racer.value->>'seat')::INTEGER = v_seat
  ) THEN
    RAISE EXCEPTION 'Vous ne participez pas à cette course';
  END IF;

  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION start_athlete_race(p_code TEXT, p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_room_game TEXT;
  v_room_status TEXT;
  v_players JSONB;
  v_player_count INTEGER;
  v_state JSONB;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS DISTINCT FROM 0 THEN
    RAISE EXCEPTION 'Seul le chef de salle peut lancer la course';
  END IF;

  SELECT game_type, status
  INTO v_room_game, v_room_status
  FROM rooms
  WHERE code = upper(p_code)
  FOR UPDATE;

  IF NOT FOUND OR v_room_game <> 'athletes' OR v_room_status <> 'playing' THEN
    RAISE EXCEPTION 'Cette salle ne peut pas lancer une course';
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
    RAISE EXCEPTION 'La course nécessite de 2 à 4 joueurs';
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
    RAISE EXCEPTION 'Chaque joueur doit choisir un athlète valide';
  END IF;

  SELECT state INTO v_state
  FROM athlete_races
  WHERE room_code = upper(p_code)
  FOR UPDATE;

  IF NOT FOUND THEN
    v_state := jsonb_build_object(
      'phase', 'playing',
      'turnSeat', (v_players->0->>'seat')::INTEGER,
      'racers', v_players,
      'events', jsonb_build_array('La course commence !'),
      'revision', 1
    );

    INSERT INTO athlete_races (room_code, state)
    VALUES (upper(p_code), v_state);
  END IF;

  RETURN v_state;
END;
$$;

CREATE OR REPLACE FUNCTION play_athlete_turn(
  p_code TEXT,
  p_token TEXT,
  p_use_jog BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  v_seat INTEGER;
  v_state JSONB;
  v_racers JSONB;
  v_events JSONB;
  v_racer JSONB;
  v_actor JSONB;
  v_index INTEGER;
  v_actor_index INTEGER;
  v_athlete TEXT;
  v_position INTEGER;
  v_bronze INTEGER;
  v_roll INTEGER;
  v_base INTEGER;
  v_bonus INTEGER := 0;
  v_malus INTEGER := 0;
  v_distance INTEGER;
  v_finish_rank INTEGER;
  v_occupants INTEGER;
  v_finished_count INTEGER;
  v_active_count INTEGER;
  v_next_seat INTEGER;
  v_phase TEXT;
BEGIN
  v_seat := room_player_seat(p_code, p_token);
  IF v_seat IS NULL THEN
    RAISE EXCEPTION 'Accès refusé à cette salle';
  END IF;

  SELECT race.state INTO v_state
  FROM athlete_races AS race
  WHERE race.room_code = upper(p_code)
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'La course n''a pas encore commencé';
  END IF;

  IF v_state->>'phase' <> 'playing' THEN
    RAISE EXCEPTION 'La course est terminée';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM rooms
    WHERE code = upper(p_code) AND game_type = 'athletes' AND status = 'playing'
  ) THEN
    RAISE EXCEPTION 'Cette course n''est plus active';
  END IF;
  IF (v_state->>'turnSeat')::INTEGER <> v_seat THEN
    RAISE EXCEPTION 'Ce n''est pas votre tour';
  END IF;

  v_racers := v_state->'racers';
  v_events := v_state->'events';
  v_roll := floor(random() * 6)::INTEGER + 1;
  v_base := CASE WHEN p_use_jog THEN 5 ELSE v_roll END;
  v_actor_index := NULL;

  FOR v_racer, v_index IN
    SELECT value, (ordinality - 1)::INTEGER
    FROM jsonb_array_elements(v_racers) WITH ORDINALITY
  LOOP
    IF (v_racer->>'seat')::INTEGER = v_seat THEN
      v_actor := v_racer;
      v_actor_index := v_index;
      EXIT;
    END IF;
  END LOOP;

  IF v_actor_index IS NULL THEN
    RAISE EXCEPTION 'Joueur introuvable dans cette course';
  END IF;

  v_athlete := v_actor->>'athlete';
  IF p_use_jog AND v_athlete <> 'genie' THEN
    RAISE EXCEPTION 'Seul le Génie peut avancer sans lancer le dé';
  END IF;
  v_position := (v_actor->>'position')::INTEGER;
  v_bronze := (v_actor->>'bronze')::INTEGER;

  IF v_athlete = 'docteur-fusee' AND NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_racers) AS other(value)
    WHERE (other.value->>'seat')::INTEGER <> v_seat
      AND other.value->>'finishRank' IS NULL
      AND (other.value->>'position')::INTEGER <= v_position
  ) THEN
    v_bronze := v_bronze + 1;
    v_events := v_events || jsonb_build_array(
      (v_actor->>'pseudo') || ' gagne un jeton Bronze « 1 point ».'
    );
    v_actor := jsonb_set(v_actor, '{bronze}', to_jsonb(v_bronze));
    v_racers := jsonb_set(v_racers, ARRAY[v_actor_index::TEXT], v_actor);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_racers) AS other(value)
    WHERE other.value->>'athlete' = 'cinquieme-roue'
      AND other.value->>'finishRank' IS NULL
      AND (other.value->>'position')::INTEGER = v_position
  ) THEN
    v_bonus := 1;
  END IF;

  IF v_athlete <> 'slime' AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_racers) AS other(value)
    WHERE other.value->>'athlete' = 'slime'
      AND other.value->>'finishRank' IS NULL
  ) THEN
    v_malus := 1;
  END IF;

  v_distance := GREATEST(0, v_base + v_bonus - v_malus);
  v_events := v_events || jsonb_build_array(
    CASE
      WHEN p_use_jog THEN (v_actor->>'pseudo') || ' utilise son pouvoir et avance de '
        || v_distance || ' case' || CASE WHEN v_distance = 1 THEN '' ELSE 's' END || '.'
      ELSE (v_actor->>'pseudo') || ' lance un ' || v_roll || ' et avance de '
        || v_distance || ' case' || CASE WHEN v_distance = 1 THEN '' ELSE 's' END || '.'
    END
  );

  v_position := LEAST(v_position + v_distance, 30);
  v_actor := jsonb_set(v_actor, '{position}', to_jsonb(v_position));
  IF v_position = 30 AND v_actor->>'finishRank' IS NULL THEN
    SELECT count(*)::INTEGER + 1 INTO v_finish_rank
    FROM jsonb_array_elements(v_racers) AS other(value)
    WHERE other.value->>'finishRank' IS NOT NULL;
    v_actor := jsonb_set(v_actor, '{finishRank}', to_jsonb(v_finish_rank));
    v_events := v_events || jsonb_build_array(
      (v_actor->>'pseudo') || ' franchit la ligne d''arrivée (' || v_finish_rank || 'e).'
    );
  END IF;
  v_racers := jsonb_set(v_racers, ARRAY[v_actor_index::TEXT], v_actor);

  IF v_actor->>'finishRank' IS NULL AND v_position < 30 AND v_athlete = 'tremplin-devin' THEN
    SELECT count(*)::INTEGER INTO v_occupants
    FROM jsonb_array_elements(v_racers) AS other(value)
    WHERE other.value->>'finishRank' IS NULL
      AND (other.value->>'position')::INTEGER = v_position;

    IF v_occupants = 2 THEN
      v_events := v_events || jsonb_build_array(
        (v_actor->>'pseudo') || ' rebondit sur son tremplin et avance de 2 cases.'
      );
      v_position := LEAST(v_position + 2, 30);
      v_actor := jsonb_set(v_actor, '{position}', to_jsonb(v_position));
      IF v_position = 30 AND v_actor->>'finishRank' IS NULL THEN
        SELECT count(*)::INTEGER + 1 INTO v_finish_rank
        FROM jsonb_array_elements(v_racers) AS other(value)
        WHERE other.value->>'finishRank' IS NOT NULL;
        v_actor := jsonb_set(v_actor, '{finishRank}', to_jsonb(v_finish_rank));
        v_events := v_events || jsonb_build_array(
          (v_actor->>'pseudo') || ' franchit la ligne d''arrivée (' || v_finish_rank || 'e).'
        );
      END IF;
      v_racers := jsonb_set(v_racers, ARRAY[v_actor_index::TEXT], v_actor);
    END IF;
  END IF;

  SELECT
    count(*) FILTER (WHERE racer.value->>'finishRank' IS NOT NULL)::INTEGER,
    count(*) FILTER (WHERE racer.value->>'finishRank' IS NULL)::INTEGER
  INTO v_finished_count, v_active_count
  FROM jsonb_array_elements(v_racers) AS racer(value);

  IF v_finished_count >= 2 OR v_active_count = 0 THEN
    v_phase := 'finished';
    v_next_seat := v_seat;
  ELSE
    v_phase := 'playing';
    SELECT seat INTO v_next_seat
    FROM (
      SELECT (racer.value->>'seat')::INTEGER AS seat
      FROM jsonb_array_elements(v_racers) AS racer(value)
      WHERE racer.value->>'finishRank' IS NULL
    ) AS active
    ORDER BY CASE WHEN seat > v_seat THEN 0 ELSE 1 END, seat
    LIMIT 1;
  END IF;

  v_state := jsonb_build_object(
    'phase', v_phase,
    'turnSeat', v_next_seat,
    'racers', v_racers,
    'events', v_events,
    'revision', (v_state->>'revision')::INTEGER + 1
  );

  UPDATE athlete_races
  SET state = v_state, updated_at = now()
  WHERE room_code = upper(p_code);

  RETURN jsonb_build_object('state', v_state, 'roll', v_roll, 'useJog', p_use_jog);
END;
$$;
