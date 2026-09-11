-- 0002: streak bonuses and double-points rounds.
--
-- Without these, answers.points_awarded holds only the clue value while
-- players.score includes bonuses and multipliers, so the two no longer
-- reconcile and the archive quietly lies about how a score was reached.
--
--   npx wrangler d1 execute mystery-rush-db --remote --file=./migrations/0002_streak_and_double.sql
--
-- Fresh databases get these from schema.sql already.

ALTER TABLE answers ADD COLUMN bonus_points      INTEGER NOT NULL DEFAULT 0;
ALTER TABLE answers ADD COLUMN multiplier        INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rounds  ADD COLUMN points_multiplier INTEGER NOT NULL DEFAULT 1;
