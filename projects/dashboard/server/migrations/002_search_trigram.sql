-- 002_search_trigram.sql — Trigram index for fuzzy search (issue #009)
--
-- The PRD-001 schema reserves `bookmark_trgm` as a virtual table for
-- trigram-based fuzzy search. SQLite's trigram module is a loadable
-- extension that better-sqlite3 doesn't bundle, so we use a regular
-- table (bookmark_trigrams) precomputed by the application layer.
--
-- Populated by `recomputeTrigramsForBookmark(db, id)` in search.ts at
-- bookmark write time AND at tag link write time (attach / detach /
-- replace). ON DELETE CASCADE on the FK cleans up rows when a bookmark
-- is deleted.
--
-- Why a regular table instead of a virtual table:
--   * SQLite ships no built-in trigram virtual table — only the trigram
--     loadable extension, which we don't have a binary for.
--   * The application layer can compute trigrams in JS (which knows
--     how to lowercase + normalize Unicode) more cleanly than SQL
--     string functions.
--   * One row per (bookmark_id, trigram) gives us O(log N) lookup via
--     the index, which is what fuzzy match needs.

CREATE TABLE bookmark_trigrams (
  bookmark_id  TEXT NOT NULL REFERENCES bookmarks(id) ON DELETE CASCADE,
  trigram      TEXT NOT NULL,
  PRIMARY KEY (bookmark_id, trigram)
);

-- The PK alone gives us leftmost-prefix lookup on bookmark_id
-- (`WHERE bookmark_id = ?` uses the PK index). The trigram index
-- is needed for the fuzzy search pre-filter:
--   `SELECT DISTINCT bookmark_id FROM bookmark_trigrams WHERE trigram IN (...)`.
CREATE INDEX idx_bookmark_trigrams_trigram ON bookmark_trigrams(trigram);