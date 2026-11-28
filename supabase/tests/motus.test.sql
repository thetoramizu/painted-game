CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
SET search_path TO public, extensions;

BEGIN;
SELECT plan(38);

SELECT ok(
  (SELECT count(*) >= 15 FROM motus_word_bank),
  'the local French word bank can fill a sequence'
);

SELECT ok(
  (SELECT bool_and(char_length(normalized) BETWEEN 5 AND 7) FROM motus_word_bank),
  'every normalized dictionary entry is 5 to 7 letters'
);

SELECT ok(
  (SELECT bool_and(normalized = motus_normalize_word(word)) FROM motus_word_bank),
  'dictionary entries use the server normalization'
);

SELECT is(
  cardinality(motus_generate_words()),
  15,
  'a generated sequence contains exactly 15 words'
);

WITH sequence AS (
  SELECT motus_generate_words() AS words
)
SELECT is(
  (SELECT count(DISTINCT motus_normalize_word(word)) FROM sequence, unnest(sequence.words) AS word),
  15::BIGINT,
  'generated words are distinct after accent normalization'
);

WITH sequence AS (
  SELECT motus_generate_words() AS words
)
SELECT ok(
  (SELECT bool_and(char_length(word) BETWEEN 5 AND 7) FROM sequence, unnest(sequence.words) AS word),
  'generated words respect the allowed lengths'
);

SELECT is(
  motus_normalize_word('ÉCOLE'),
  'ecole',
  'normalization ignores French accents and case'
);

SELECT is(
  motus_word_feedback('ABBEY', 'ABBBB'),
  ARRAY['correct', 'correct', 'correct', 'absent', 'absent'],
  'duplicate guesses do not consume a target letter more than once'
);

SELECT is(
  motus_word_feedback('CABBA', 'AAAAA'),
  ARRAY['absent', 'correct', 'absent', 'absent', 'correct'],
  'repeated target letters only mark available copies'
);

SELECT ok(
  (SELECT count(*) = count(DISTINCT normalized) FROM motus_word_bank),
  'the dictionary has one entry for each accent-normalized word'
);

INSERT INTO rooms (code, status, game_type)
VALUES ('MOTUST', 'lobby', 'motus');

INSERT INTO room_players (room_code, pseudo, seat, token_hash)
VALUES
  ('MOTUST', 'Hôte', 0, encode(digest('host-token', 'sha256'), 'hex')),
  ('MOTUST', 'Invité', 1, encode(digest('guest-token', 'sha256'), 'hex'));

SELECT is(
  (SELECT success FROM start_room('MOTUST', 'host-token')),
  FALSE,
  'the generic room start cannot bypass MOTUS initialization'
);

SELECT is(
  (SELECT success FROM start_motus_game('MOTUST', 'host-token')),
  TRUE,
  'only the room host starts a game with its shared sequence'
);

SELECT ok(
  NOT (get_motus_state('MOTUST', 'host-token') ? 'words')
    AND get_motus_state('MOTUST', 'host-token')->'recapWords' = '[]'::JSONB,
  'playing state never exposes unrevealed words'
);

SELECT is(
  get_motus_state('MOTUST', 'host-token')->>'firstLetter',
  (SELECT left(words[1], 1) FROM motus_games WHERE room_code = 'MOTUST'),
  'the player receives only the current word first letter'
);

SELECT is(
  (SELECT (submit_motus_guess(
    'MOTUST',
    'host-token',
    (CASE WHEN left(words[1], 1) = 'z' THEN 'a' ELSE 'z' END) || substring(words[1] FROM 2)
  )->>'success')::BOOLEAN FROM motus_games WHERE room_code = 'MOTUST'),
  FALSE,
  'the server rejects a proposal that changes the imposed first letter'
);

SELECT is(
  (SELECT (submit_motus_guess('MOTUST', 'host-token', words[1])->>'found')::BOOLEAN
   FROM motus_games WHERE room_code = 'MOTUST'),
  TRUE,
  'a valid target guess advances the player'
);

SELECT is(
  (submit_motus_guess('MOTUST', 'host-token', 'bad')->>'success')::BOOLEAN,
  FALSE,
  'the server rejects proposals with the wrong number of letters'
);

SELECT ok(
  get_motus_state('MOTUST', 'host-token')->>'wordIndex' = '2'
    AND get_motus_state('MOTUST', 'host-token')->>'wordsFound' = '1',
  'the server increments only the successful player progress'
);

SELECT is(
  jsonb_array_length(get_motus_state('MOTUST', 'host-token')->'attempts'),
  0,
  'attempts reset after a player advances to the next word'
);

SELECT ok(
  get_motus_state('MOTUST', 'guest-token')->>'wordIndex' = '1'
    AND get_motus_state('MOTUST', 'guest-token')->>'wordsFound' = '0',
  'each player has independent progression'
);

SELECT is(
  (SELECT words_found FROM motus_public_scores WHERE room_code = 'MOTUST' AND seat = 0),
  1::INTEGER,
  'the public realtime score follows the server result'
);

SELECT ok(
  (SELECT abs(extract(epoch FROM deadline - started_at) - 120) < 0.001
   FROM motus_games WHERE room_code = 'MOTUST'),
  'the authoritative deadline is exactly 120 seconds after start'
);

INSERT INTO room_players (room_code, pseudo, seat, token_hash)
VALUES ('MOTUST', 'Tardif', 2, encode(digest('late-token', 'sha256'), 'hex'));

SELECT ok(
  get_motus_state('MOTUST', 'late-token')->>'wordIndex' = '1'
    AND get_motus_state('MOTUST', 'late-token')->>'wordsFound' = '0',
  'a late joiner gets a fresh individual progression'
);

SELECT is(
  (get_motus_state('MOTUST', 'late-token')->>'deadline')::TIMESTAMPTZ,
  (SELECT deadline FROM motus_games WHERE room_code = 'MOTUST'),
  'a late joiner receives the original server deadline'
);

SELECT is(
  (SELECT count(*) FROM motus_public_scores WHERE room_code = 'MOTUST'),
  3::BIGINT,
  'late joiners appear in the shared score cards'
);

SELECT is(
  (skip_motus_word('MOTUST', 'invalid-token')->>'success')::BOOLEAN,
  FALSE,
  'the server rejects a skip request without a valid player token'
);

SELECT is(
  (skip_motus_word('MOTUST', 'host-token')->>'success')::BOOLEAN,
  TRUE,
  'a player can skip their current word'
);

SELECT ok(
  get_motus_state('MOTUST', 'host-token')->>'wordIndex' = '3'
    AND get_motus_state('MOTUST', 'host-token')->>'wordsFound' = '1'
    AND jsonb_array_length(get_motus_state('MOTUST', 'host-token')->'attempts') = 0
    AND (SELECT words_found = 1 FROM motus_public_scores
         WHERE room_code = 'MOTUST' AND seat = 0),
  'skipping advances without adding a score and clears current attempts'
);

SELECT ok(
  (SELECT (submit_motus_guess('MOTUST', 'host-token', words[2])->>'found') IS DISTINCT FROM 'true'
   FROM motus_games WHERE room_code = 'MOTUST')
    AND get_motus_state('MOTUST', 'host-token')->>'wordIndex' = '3'
    AND get_motus_state('MOTUST', 'host-token')->>'wordsFound' = '1',
  'a skipped target cannot be found later'
);

UPDATE motus_games
SET deadline = clock_timestamp() - INTERVAL '1 second'
WHERE room_code = 'MOTUST';

SELECT is(
  get_motus_state('MOTUST', 'host-token')->>'phase',
  'finished',
  'the server ends the game when its deadline expires'
);

SELECT is(
  (SELECT status FROM rooms WHERE code = 'MOTUST'),
  'finished',
  'expiration updates the shared room status'
);

SELECT is(
  jsonb_array_length(get_motus_state('MOTUST', 'host-token')->'recapWords'),
  3,
  'the final recap stops at the last word reached by a player'
);

SELECT is(
  (submit_motus_guess('MOTUST', 'host-token', 'xxxxx')->>'success')::BOOLEAN,
  FALSE,
  'the server rejects attempts after the deadline'
);

SELECT is(
  (skip_motus_word('MOTUST', 'host-token')->>'success')::BOOLEAN,
  FALSE,
  'the server rejects skips after the deadline'
);

SELECT is(
  (restart_motus_game('MOTUST', 'guest-token')->>'success')::BOOLEAN,
  FALSE,
  'only the host can restart a finished game'
);

SELECT is(
  (restart_motus_game('MOTUST', 'host-token')->>'success')::BOOLEAN,
  TRUE,
  'the host can restart MOTUS after the game ends'
);

SELECT ok(
  (SELECT bool_and(word_index = 1 AND words_found = 0 AND attempts = '[]'::JSONB)
   FROM motus_player_states WHERE room_code = 'MOTUST')
    AND (SELECT bool_and(words_found = 0)
         FROM motus_public_scores WHERE room_code = 'MOTUST')
    AND get_motus_state('MOTUST', 'host-token')->>'wordIndex' = '1'
    AND get_motus_state('MOTUST', 'guest-token')->>'wordIndex' = '1',
  'restarting resets every player progress and shared score'
);

SELECT ok(
  (SELECT phase = 'playing'
      AND abs(extract(epoch FROM deadline - started_at) - 120) < 0.001
   FROM motus_games WHERE room_code = 'MOTUST'),
  'a restarted game receives a fresh authoritative 120-second deadline'
);

SELECT * FROM finish();
ROLLBACK;
