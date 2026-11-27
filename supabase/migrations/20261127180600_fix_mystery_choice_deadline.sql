CREATE OR REPLACE FUNCTION mystery_add_options(p_code TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_options TEXT[];
  v_choice_seconds INTEGER;
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

  SELECT word_choice_seconds INTO v_choice_seconds
  FROM mystery_settings
  WHERE singleton;

  UPDATE mystery_games
  SET word_options = v_options,
      offered_words = offered_words || v_options,
      deadline = now() + make_interval(secs => v_choice_seconds),
      revision = revision + 1
  WHERE room_code = p_code;
END;
$$;

NOTIFY pgrst, 'reload schema';
