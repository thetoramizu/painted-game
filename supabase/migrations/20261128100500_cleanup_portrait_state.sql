CREATE OR REPLACE FUNCTION clear_portrait_game_state_on_lobby()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.status = 'lobby' AND OLD.status IS DISTINCT FROM NEW.status THEN
    DELETE FROM portrait_game_states WHERE room_code = NEW.code;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clear_portrait_game_state_on_lobby ON rooms;
CREATE TRIGGER clear_portrait_game_state_on_lobby
AFTER UPDATE OF status ON rooms
FOR EACH ROW
EXECUTE FUNCTION clear_portrait_game_state_on_lobby();
