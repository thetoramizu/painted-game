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
  VALUES (
    upper(p_code), btrim(p_pseudo), v_seat,
    encode(digest(v_token, 'sha256'), 'hex')
  );

  RETURN QUERY SELECT upper(p_code), v_token, btrim(p_pseudo);
END;
$$;
