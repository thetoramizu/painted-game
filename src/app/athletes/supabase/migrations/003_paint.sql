-- ============================================
-- Phase peinture collaborative — Athlètes de compète
-- ============================================

-- 1. Ajout du type de jeu sur la table rooms
-- Permet de distinguer "course" (athletes) vs "peinture" (paint)
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS game_type TEXT DEFAULT 'athletes';

-- 2. Table des traits de peinture (optionnelle mais recommandée)
-- Stocke les traits pendant la session en cours.
-- Un nouveau joueur qui rejoint verra l'état actuel de la toile.
-- La table est vidée automatiquement quand la salle repasse en état 'lobby'.
CREATE TABLE IF NOT EXISTS paint_strokes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_code TEXT NOT NULL REFERENCES rooms(code) ON DELETE CASCADE,
  player_seat INTEGER NOT NULL CHECK (player_seat >= 0 AND player_seat < 4),
  player_color TEXT NOT NULL, -- couleur hex sans #, ex: "4f8cff"
  points JSONB NOT NULL, -- tableau de {x, y} coordinates
  created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()),
  CONSTRAINT uq_paint_strokes_room_seat UNIQUE (room_code, player_seat)
);

-- Index pour les requêtes de récupération d'état de toile
CREATE INDEX IF NOT EXISTS idx_paint_strokes_room ON paint_strokes(room_code);
CREATE INDEX IF NOT EXISTS idx_paint_strokes_created ON paint_strokes(created_at);

-- 3. Policy RLS : tout le monde peut lire (nécessaire pour le rendu temps réel)
CREATE POLICY "paint_strokes_select_public" ON paint_strokes FOR SELECT TO public USING (true);

-- Policy : insertion uniquement via service_role (via RPC ou function)
CREATE POLICY "paint_strokes_insert_service" ON paint_strokes FOR INSERT TO public WITH CHECK (auth.role() = 'service_role');

-- 4. Fonction RPC : ajouter un trait de peinture
-- Cet appel sera fait depuis le service PaintService (supabase.rpc)
CREATE OR REPLACE FUNCTION add_paint_stroke(
  p_room_code TEXT,
  p_seat INTEGER,
  p_color TEXT,
  p_points JSONB
)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO paint_strokes (room_code, player_seat, player_color, points)
  VALUES (p_room_code, p_seat, p_color, p_points);

  RETURN QUERY SELECT TRUE, 'Trait ajouté avec succès' AS message;
EXCEPTION
  WHEN OTHERS THEN
    RETURN QUERY SELECT FALSE, SQLERROR.message AS message;
END;
$$;

-- 5. Fonction RPC : récupérer l'état actuel de la toile
CREATE OR REPLACE FUNCTION get_paint_strokes(p_room_code TEXT)
RETURNS TABLE (
  seat INTEGER,
  color TEXT,
  points JSONB,
  created_at TIMESTAMP WITH TIME ZONE
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    player_seat,
    player_color,
    points,
    created_at
  FROM paint_strokes
  WHERE room_code = p_room_code
  ORDER BY created_at;
END;
$$;

-- 6. Fonction RPC : vider la toile (lorsque la session se termine / revient en lobby)
CREATE OR REPLACE FUNCTION clear_paint_strokes(p_room_code TEXT)
RETURNS TABLE (success BOOLEAN, message TEXT)
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM paint_strokes WHERE room_code = p_room_code;
  RETURN QUERY SELECT TRUE, 'Toile nettoyée' AS message;
END;
$$;