-- Optional presentation metadata supplied by RSS/Atom publishers.
-- Existing articles remain valid and text-only; subsequent feed polls
-- backfill image_url when a publisher advertises one.

ALTER TABLE news_articles ADD COLUMN image_url TEXT;
