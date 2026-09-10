-- Mystery Rush - D1 schema.
--
-- Division of labour: the Durable Object owns *live* game state (it is the
-- authority during a round, and its storage is durable). D1 is the durable
-- record that outlives the room: the event registry that maps a code to a
-- room, plus an archive of players, rounds and answers for post-event
-- reporting. Gameplay never blocks on a D1 write.

CREATE TABLE IF NOT EXISTS events (
  event_code      TEXT PRIMARY KEY,
  event_name      TEXT NOT NULL,
  host_token_hash TEXT NOT NULL,
  phase           TEXT NOT NULL DEFAULT 'lobby',
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_created_at ON events (created_at DESC);

CREATE TABLE IF NOT EXISTS players (
  id               TEXT PRIMARY KEY,
  event_code       TEXT NOT NULL,
  nickname         TEXT NOT NULL,
  score            INTEGER NOT NULL DEFAULT 0,
  correct_answers  INTEGER NOT NULL DEFAULT 0,
  mysteries_played INTEGER NOT NULL DEFAULT 0,
  joined_at        INTEGER NOT NULL,
  FOREIGN KEY (event_code) REFERENCES events (event_code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_players_event ON players (event_code, score DESC);

CREATE TABLE IF NOT EXISTS rounds (
  id          TEXT PRIMARY KEY,
  event_code  TEXT NOT NULL,
  mystery_id  TEXT NOT NULL,
  round_index INTEGER NOT NULL,
  status      TEXT NOT NULL,
  started_at  INTEGER NOT NULL,
  ended_at    INTEGER,
  FOREIGN KEY (event_code) REFERENCES events (event_code) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_rounds_event ON rounds (event_code, round_index);

CREATE TABLE IF NOT EXISTS answers (
  round_id        TEXT NOT NULL,
  player_id       TEXT NOT NULL,
  event_code      TEXT NOT NULL,
  selected_option TEXT NOT NULL,
  submitted_at    INTEGER NOT NULL,
  clue_number     INTEGER NOT NULL,
  is_correct      INTEGER NOT NULL,
  points_awarded  INTEGER NOT NULL,
  PRIMARY KEY (round_id, player_id)
);

CREATE INDEX IF NOT EXISTS idx_answers_event ON answers (event_code);
