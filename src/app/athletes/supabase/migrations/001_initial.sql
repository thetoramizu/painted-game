-- ============================================
-- Athlètes de compète — Schéma Supabase
-- ============================================

-- Table des salles de jeu
CREATE TABLE IF NOT EXISTS rooms (
  code          TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby', 'playing', 'finished')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Table des joueurs inscrits dans une salle
CREATE TABLE IF NOT EXISTS room_players (
  id         BIGSERIAL PRIMARY KEY,
  room_code  TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  pseudo     TEXT NOT NULL,
  seat       INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_code, seat)
);

CREATE INDEX IF NOT EXISTS idx_room_players_room ON room_players(room_code);

-- ===========================
-- Fonction : créer une salle
-- Arguments : p_pseudo (pseudo du créateur)
-- Retour : { code, token }
-- ===========================
CREATE OR REPLACE FUNCTION create_room(p_pseudo TEXT)
RETURNS TABLE (code  TEXT, token TEXT, pseudo TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_code   TEXT := upper(substring(md5(random()::text || clock_timestamp()::text) FROM 1 FOR 6));
  v_token  TEXT := encode(gen_random_bytes(32), 'hex');
BEGIN
  INSERT INTO rooms (code, status) VALUES (v_code, 'lobby');

  INSERT INTO room_players (room_code, pseudo, seat)
  VALUES (v_code, p_pseudo, 0);

  RETURN QUERY SELECT v_code, v_token, p_pseudo;
END;
$$;

-- ===========================
-- Fonction : rejoindre une salle
-- Arguments : p_code (code de la salle), p_pseudo (pseudo du joueur)
-- Retour : { code, token }
-- ===========================
CREATE OR REPLACE FUNCTION join_room(p_code TEXT, p_pseudo TEXT)
RETURNS TABLE (code  TEXT, token TEXT, pseudo TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_seat INTEGER;
  v_token TEXT := encode(gen_random_bytes(32), 'hex');
BEGIN
  SELECT COALESCE(MAX(seat), -1) + 1 INTO v_seat
  FROM room_players
  WHERE room_code = p_code;

  IF v_seat >= 4 THEN
    RAISE EXCEPTION 'La salle est complète';
  END IF;

  INSERT INTO room_players (room_code, pseudo, seat)
  VALUES (p_code, p_pseudo, v_seat);

  RETURN QUERY SELECT p_code, v_token, p_pseudo;
END;
$$;

-- ===========================
-- Fonction : récupérer l'état d'une salle
-- Arguments : p_code, p_pseudo
-- Retour : { code, status, mySeat, players }
-- ===========================
CREATE OR REPLACE FUNCTION get_room(p_code TEXT, p_pseudo TEXT)
RETURNS TABLE (
  code    TEXT,
  status  TEXT,
  "mySeat" INTEGER,
  players JSONB
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    r.code,
    r.status,
    MAX(CASE WHEN rp.pseudo = p_pseudo THEN rp.seat END) AS "mySeat",
    COALESCE(jsonb_agg(jsonb_build_object('pseudo', rp.pseudo, 'seat', rp.seat) ORDER BY rp.seat), '[]'::jsonb) AS players
  FROM rooms r
  LEFT JOIN room_players rp ON rp.room_code = r.code
  WHERE r.code = p_code
  GROUP BY r.code, r.status;
END;
$$;

-- ===========================
-- Fonction : commencer une partie
-- Arguments : p_code (code de la salle), p_pseudo (pseudo du joueur)
-- Retour : { success, message }
-- ===========================
CREATE OR REPLACE FUNCTION start_room(p_code TEXT, p_pseudo TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
BEGIN
  -- Vérifier que le joueur est bien inscrit dans la salle
  IF NOT EXISTS (
    SELECT 1 FROM room_players rp
    WHERE rp.room_code = p_code AND rp.pseudo = p_pseudo
  ) THEN
    RETURN QUERY SELECT FALSE, 'Vous n''êtes pas inscrit dans cette salle' AS message;
    RETURN;
  END IF;

  -- Vérifier qu'il y a au moins 2 joueurs
  IF (SELECT COUNT(*) FROM room_players WHERE room_code = p_code) < 2 THEN
    RETURN QUERY SELECT FALSE, 'Il faut au moins 2 joueurs pour commencer la course' AS message;
    RETURN;
  END IF;

  -- Vérifier que la salle est bien dans l'état lobby
  IF (SELECT status FROM rooms WHERE code = p_code) != 'lobby' THEN
    RETURN QUERY SELECT FALSE, 'Cette salle n''est pas dans son état initial' AS message;
    RETURN;
  END IF;

  UPDATE rooms SET status = 'playing' WHERE code = p_code;

  RETURN QUERY SELECT TRUE, 'La course a commencé' AS message;
END;
$$;
