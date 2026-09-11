-- 0001: response-time tiebreak + archiving best streak.
--
-- schema.sql is CREATE TABLE IF NOT EXISTS, so it cannot add columns to a
-- database that already exists. Run this once against any database created
-- before the tiebreak landed:
--
--   npx wrangler d1 execute mystery-rush-db --remote --file=./migrations/0001_response_time_tiebreak.sql
--
-- Safe to skip on a fresh database - schema.sql already includes these
-- columns. Re-running it will error on the duplicate column, which is the
-- intended signal that it has already been applied.

ALTER TABLE players ADD COLUMN best_streak       INTEGER NOT NULL DEFAULT 0;
ALTER TABLE players ADD COLUMN total_response_ms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE answers ADD COLUMN response_ms       INTEGER NOT NULL DEFAULT 0;
